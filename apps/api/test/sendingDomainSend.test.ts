import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { fake } from "./fakePrisma.js";

// Settings → Domain mode on the real email paths, end to end against an in-memory Prisma: one send
// (domain/delivery), manual send and the Send Queue batch eligibility (domain/manualSend), and Contacts →
// Import file (queue/contactImport). With the flag off they must behave exactly as before; in BLOCKLIST mode
// only blocked domains are skipped — and unsubscribed / bounced / complained contacts never get an email in
// either mode. Only the provider, image inlining and the queues are stubbed.

vi.mock("../src/prisma.js", async () => ({ prisma: (await import("./fakePrisma.js")).fake.db }));
const send = vi.hoisted(() => vi.fn());
vi.mock("../src/provider/index.js", async (orig) => ({
  ...(await orig<typeof import("../src/provider/index.js")>()),
  getProvider: () => ({ name: "test", send }),
}));
vi.mock("../src/render/inlineImages.js", () => ({
  inlineLocalImages: async (html: string, attachments: unknown) => ({ html, attachments }),
}));
const queues = vi.hoisted(() => ({ enqueueSend: vi.fn(), enqueueManualBulkSend: vi.fn() }));
vi.mock("../src/queue/queues.js", () => queues);

const { deliverEmail } = await import("../src/domain/delivery.js");
const { sendManualEmail, createManualSendBatch } = await import("../src/domain/manualSend.js");
const { processContactImport } = await import("../src/queue/contactImport.js");

const originalFlag = process.env.ENABLE_DOMAIN_BLOCKLIST;
const flag = (on: boolean) => {
  process.env.ENABLE_DOMAIN_BLOCKLIST = on ? "true" : "false";
};
const setMode = (mode: "ALLOWLIST" | "BLOCKLIST") => {
  const row = fake.T("setting").find((r) => r.key === "sendingDomainMode");
  if (row) row.value = mode;
  else fake.T("setting").push({ key: "sendingDomainMode", value: mode });
};

const template = {
  id: "t1",
  subject: "Hello {{first_name}}",
  htmlBody: "<p>Hi {{first_name}}</p>",
  textBody: null,
  variables: ["first_name"],
  kind: "STANDARD",
  links: null,
  meeting: null,
  imageUrl: null,
  videoUrl: null,
  images: null,
  videos: null,
};
const contact = (id: string, email: string, extra: Record<string, unknown> = {}) =>
  fake.T("contact").push({ id, email, firstName: "Ada", lastName: "L", status: "ACTIVE", customFields: {}, ...extra });

let keySeq = 0;
const deliver = (contactId: string) =>
  deliverEmail({ idempotencyKey: `k${++keySeq}`, contactId, source: { type: "manual", templateId: "t1" } });
const ledger = (emailLogId: string) => fake.T("emailLog").find((l) => l.id === emailLogId)!;

beforeEach(() => {
  fake.reset();
  vi.clearAllMocks();
  send.mockResolvedValue({ providerMessageId: "pm1" });
  flag(false);
  fake.T("template").push(template);
  fake.T("allowedDomain").push({ id: "a1", domain: "ok.com" });
  fake.T("blockedSendingDomain").push({ id: "b1", domain: "mailinator.com" }, { id: "b2", domain: "tempmail.com" });
  contact("c-ok", "ok@ok.com");
  contact("c-other", "ada@other.com");
  contact("c-blocked", "x@mailinator.com");
  contact("c-sub", "y@eu.mailinator.com");
});
afterAll(() => {
  if (originalFlag === undefined) delete process.env.ENABLE_DOMAIN_BLOCKLIST;
  else process.env.ENABLE_DOMAIN_BLOCKLIST = originalFlag;
});

describe("send time (deliverEmail): the mode is read on every send", () => {
  it("flag off: today's rule — approved domains only, 'domain not approved'; a stored BLOCKLIST is ignored", async () => {
    setMode("BLOCKLIST");
    const skipped = await deliver("c-other");
    expect(skipped).toEqual({ result: "skipped", emailLogId: expect.any(String), reason: "domain not approved" });
    expect(ledger(skipped.emailLogId)).toMatchObject({ status: "FAILED", errorMessage: "domain not approved" });
    expect(send).not.toHaveBeenCalled();
    expect((await deliver("c-ok")).result).toBe("sent");
    expect(fake.model("blockedSendingDomain").findMany).not.toHaveBeenCalled();
  });

  it("flag on, ALLOWLIST (the default): the same as with the flag off", async () => {
    flag(true);
    expect(await deliver("c-other")).toMatchObject({ result: "skipped", reason: "domain not approved" });
    expect((await deliver("c-ok")).result).toBe("sent");
  });

  it("BLOCKLIST: saved contacts at any domain are emailed; blocked domains and their subdomains are not", async () => {
    flag(true);
    setMode("BLOCKLIST");
    expect((await deliver("c-other")).result).toBe("sent");
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ to: "ada@other.com" }));
    const blocked = await deliver("c-blocked");
    expect(blocked).toMatchObject({ result: "skipped", reason: "domain blocked" });
    expect(ledger(blocked.emailLogId)).toMatchObject({ status: "FAILED", errorMessage: "domain blocked" });
    expect(await deliver("c-sub")).toMatchObject({ result: "skipped", reason: "domain blocked" });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("switching back to ALLOWLIST applies to the same saved contact at once", async () => {
    flag(true);
    setMode("BLOCKLIST");
    expect((await deliver("c-other")).result).toBe("sent");
    setMode("ALLOWLIST");
    expect(await deliver("c-other")).toMatchObject({ result: "skipped", reason: "domain not approved" });
  });

  describe.each([
    ["flag off", false, "ALLOWLIST"],
    ["ALLOWLIST", true, "ALLOWLIST"],
    ["BLOCKLIST", true, "BLOCKLIST"],
  ] as const)("suppression always wins (%s)", (_label, on, mode) => {
    beforeEach(() => {
      flag(on);
      setMode(mode);
    });

    it.each(["UNSUBSCRIBED", "BOUNCED", "COMPLAINED"])("a %s contact is never emailed, even at an allowed domain", async (status) => {
      contact("c-sup", "ada@ok.com", { status }); // allowed in every mode
      expect(await deliver("c-sup")).toMatchObject({ result: "skipped", reason: "suppressed" });
      expect(send).not.toHaveBeenCalled();
    });

    it("an unsubscribe record suppresses an ACTIVE contact", async () => {
      contact("c-unsub", "bob@ok.com", { unsubscribe: { id: "u1" } });
      expect(await deliver("c-unsub")).toMatchObject({ result: "skipped", reason: "suppressed" });
      expect(send).not.toHaveBeenCalled();
    });
  });
});

describe("manual send and Send Queue eligibility (domain/manualSend)", () => {
  it("flag off: the old skip text", async () => {
    expect(await sendManualEmail("c-other", "t1")).toEqual({
      status: "skipped",
      reason: "email domain is not on the approved sending list",
    });
  });

  it("BLOCKLIST: blocked domains say so; other domains are queued", async () => {
    flag(true);
    setMode("BLOCKLIST");
    expect(await sendManualEmail("c-blocked", "t1")).toEqual({
      status: "skipped",
      reason: "email domain is on the blocked sending list",
    });
    expect((await sendManualEmail("c-other", "t1")).status).toBe("queued");
    expect(queues.enqueueSend).toHaveBeenCalledTimes(1);
  });

  it("BLOCKLIST: suppressed contacts are still skipped", async () => {
    flag(true);
    setMode("BLOCKLIST");
    contact("c-bounced", "zed@other.com", { status: "BOUNCED" });
    expect(await sendManualEmail("c-bounced", "t1")).toEqual({
      status: "skipped",
      reason: "contact is unsubscribed, bounced or complained",
    });
    expect(queues.enqueueSend).not.toHaveBeenCalled();
  });

  it("Send Queue batch: each item is PENDING or SKIPPED with the mode's reason", async () => {
    flag(true);
    setMode("BLOCKLIST");
    contact("c-complained", "cc@other.com", { status: "COMPLAINED" });
    await createManualSendBatch("t1", ["c-ok", "c-other", "c-blocked", "c-complained"]);
    const items = fake.T("manualSendBatch")[0]!.items.create as { contactId: string; status: string; error: string | null }[];
    expect(items.map((i) => [i.contactId, i.status, i.error])).toEqual([
      ["c-ok", "PENDING", null],
      ["c-other", "PENDING", null],
      ["c-blocked", "SKIPPED", "email domain is on the blocked sending list"],
      ["c-complained", "SKIPPED", "contact is unsubscribed, bounced or complained"],
    ]);
  });

  it("Send Queue batch, flag off: the old reason", async () => {
    await createManualSendBatch("t1", ["c-other"]);
    expect(fake.T("manualSendBatch")[0]!.items.create[0]).toMatchObject({
      status: "SKIPPED",
      error: "email domain is not on the approved sending list",
    });
  });
});

describe("Contacts → Import file (csv-import job)", () => {
  const csv = (lines: string[]) =>
    Buffer.from(["email,first name", ...lines].join("\n") + "\n").toString("base64");
  const job = (lines: string[]) => ({ fileBase64: csv(lines), filename: "contacts.csv", format: "csv" as const });
  const LINES = [
    "anyone@gmail.com,Any", //          BLOCKLIST: imported      ALLOWLIST: not approved
    "x@MAILINATOR.com,Blocked", //      blocked (uppercase)      not approved
    "y@eu.mailinator.com,Sub", //       blocked (subdomain)      not approved
    "z@notmailinator.com,LookAlike", // imported                 not approved
    "Up@TempMail.COM,Upper", //         blocked                  not approved
    "new@ok.com,Approved", //           imported                 imported
    ",NoEmail", //                      no email                 no email
  ];
  const saved = () => fake.T("contact").map((c) => c.email).filter((e) => !["ok@ok.com", "ada@other.com", "x@mailinator.com", "y@eu.mailinator.com"].includes(e));

  it("BLOCKLIST: only blocked domains (and subdomains) and unusable rows are skipped; the summary is marked blocklist", async () => {
    flag(true);
    setMode("BLOCKLIST");
    const res = await processContactImport(job([...LINES, "bad@nodot,Invalid"]));
    expect(res).toMatchObject({ created: 3, rejectedDomain: 3, domainMode: "BLOCKLIST" });
    expect(res.skipped).toBe(2); // the missing email and the unusable address
    expect(res.failed).toBe(5);
    expect(saved().sort()).toEqual(["anyone@gmail.com", "new@ok.com", "z@notmailinator.com"]);
  });

  it("flag on but ALLOWLIST: exactly the flag-off result (no domainMode)", async () => {
    const off = await processContactImport(job(LINES));
    expect(off).not.toHaveProperty("domainMode");
    expect(off).toMatchObject({ created: 1, rejectedDomain: 5, skipped: 1, failed: 6 });

    fake.reset();
    fake.T("allowedDomain").push({ id: "a1", domain: "ok.com" });
    flag(true);
    expect(await processContactImport(job(LINES))).toEqual(off);
  });

  it("an existing BOUNCED contact re-imported in BLOCKLIST mode stays BOUNCED and is never emailed", async () => {
    flag(true);
    setMode("BLOCKLIST");
    contact("c-b", "gone@other.com", { status: "BOUNCED" });
    await processContactImport(job(["gone@other.com,Gone"]));
    expect(fake.T("contact").find((c) => c.email === "gone@other.com")!.status).toBe("BOUNCED");
    expect(await deliver("c-b")).toMatchObject({ result: "skipped", reason: "suppressed" });
  });
});
