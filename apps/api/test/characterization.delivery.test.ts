import { beforeEach, describe, expect, it, vi } from "vitest";

// Characterization tests for deliverEmail (domain/delivery.ts): they pin down the
// CURRENT behaviour of one email send — ledger writes, skip reasons, headers,
// error handling — so refactors can prove nothing changed. Prisma, the provider,
// suppression and the domain allowlist are mocked; rendering is real.

const db = vi.hoisted(() => ({
  emailLog: { findUnique: vi.fn(), upsert: vi.fn(), update: vi.fn() },
  contact: { findUnique: vi.fn() },
  campaign: { findUnique: vi.fn() },
  template: { findUnique: vi.fn() },
  trigger: { findUnique: vi.fn() },
}));
const send = vi.hoisted(() => vi.fn());
const suppressed = vi.hoisted(() => vi.fn());
const domainAllowed = vi.hoisted(() => vi.fn());

vi.mock("../src/prisma.js", () => ({ prisma: db }));
vi.mock("../src/domain/suppression.js", () => ({ isSuppressed: suppressed }));
vi.mock("../src/domain/allowedDomains.js", () => ({ isEmailDomainAllowed: domainAllowed }));
vi.mock("../src/render/inlineImages.js", () => ({
  inlineLocalImages: async (html: string, attachments: unknown) => ({ html, attachments }),
}));
vi.mock("../src/provider/index.js", async (orig) => ({
  ...(await orig<typeof import("../src/provider/index.js")>()),
  getProvider: () => ({ name: "test", send }),
}));

const { deliverEmail } = await import("../src/domain/delivery.js");
const { PermanentSendError } = await import("../src/provider/index.js");

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
const contact = { id: "c1", email: "ada@example.com", firstName: "Ada", lastName: "L", status: "ACTIVE", customFields: {} };
const manualJob = { idempotencyKey: "k1", contactId: "c1", source: { type: "manual" as const, templateId: "t1" } };
const campaignJob = {
  idempotencyKey: "k2",
  contactId: "c1",
  source: { type: "campaign" as const, campaignId: "camp1", runDate: "2026-01-01" },
};

beforeEach(() => {
  vi.clearAllMocks();
  db.emailLog.findUnique.mockResolvedValue(null);
  db.emailLog.upsert.mockResolvedValue({ id: "log1" });
  db.emailLog.update.mockResolvedValue({});
  db.contact.findUnique.mockResolvedValue(contact);
  db.template.findUnique.mockResolvedValue(template);
  db.campaign.findUnique.mockResolvedValue({ id: "camp1", template });
  suppressed.mockResolvedValue(false);
  domainAllowed.mockResolvedValue(true);
  send.mockResolvedValue({ providerMessageId: "pm1" });
});

describe("deliverEmail (characterization)", () => {
  it("returns duplicate without sending when the ledger row is already past QUEUED/FAILED", async () => {
    for (const status of ["SENT", "DELIVERED", "OPENED", "BOUNCED"]) {
      db.emailLog.findUnique.mockResolvedValueOnce({ id: "old", status });
      await expect(deliverEmail(manualJob)).resolves.toEqual({ result: "duplicate", emailLogId: "old" });
    }
    expect(send).not.toHaveBeenCalled();
  });

  it("re-sends when the existing ledger row is QUEUED or FAILED", async () => {
    for (const status of ["QUEUED", "FAILED"]) {
      db.emailLog.findUnique.mockResolvedValueOnce({ id: "log1", status });
      await expect(deliverEmail(manualJob)).resolves.toMatchObject({ result: "sent" });
    }
  });

  it("missing contact / template / campaign are permanent errors", async () => {
    db.contact.findUnique.mockResolvedValueOnce(null);
    await expect(deliverEmail(manualJob)).rejects.toThrow("Contact c1 gone");
    db.template.findUnique.mockResolvedValueOnce(null);
    await expect(deliverEmail(manualJob)).rejects.toBeInstanceOf(PermanentSendError);
    db.campaign.findUnique.mockResolvedValueOnce(null);
    await expect(deliverEmail(campaignJob)).rejects.toThrow("Campaign camp1 gone");
  });

  it("upserts the ledger row (QUEUED, template subject) before sending", async () => {
    await deliverEmail(manualJob);
    expect(db.emailLog.upsert).toHaveBeenCalledWith({
      where: { idempotencyKey: "k1" },
      create: { idempotencyKey: "k1", contactId: "c1", campaignId: null, triggerId: null, status: "QUEUED", subject: "Hello {{first_name}}" },
      update: {},
    });
  });

  it("suppressed contact: FAILED 'suppressed', skipped, no send", async () => {
    suppressed.mockResolvedValueOnce(true);
    await expect(deliverEmail(manualJob)).resolves.toEqual({ result: "skipped", emailLogId: "log1", reason: "suppressed" });
    expect(db.emailLog.update).toHaveBeenCalledWith({ where: { id: "log1" }, data: { status: "FAILED", errorMessage: "suppressed" } });
    expect(send).not.toHaveBeenCalled();
  });

  it("domain not approved: FAILED, skipped, no send", async () => {
    domainAllowed.mockResolvedValueOnce(false);
    await expect(deliverEmail(manualJob)).resolves.toEqual({ result: "skipped", emailLogId: "log1", reason: "domain not approved" });
    expect(db.emailLog.update).toHaveBeenCalledWith({ where: { id: "log1" }, data: { status: "FAILED", errorMessage: "domain not approved" } });
    expect(send).not.toHaveBeenCalled();
  });

  it("manual send: rendered subject, no unsubscribe headers, ledger marked SENT", async () => {
    await expect(deliverEmail(manualJob)).resolves.toEqual({ result: "sent", emailLogId: "log1", providerMessageId: "pm1" });
    const msg = send.mock.calls[0]![0];
    expect(msg).toMatchObject({ to: "ada@example.com", from: "Test <test@example.com>", subject: "Hello Ada", headers: {}, tags: { emailLogId: "log1" } });
    expect(msg.html).toContain("Hi Ada");
    expect(db.emailLog.update).toHaveBeenLastCalledWith({
      where: { id: "log1" },
      data: expect.objectContaining({ status: "SENT", providerMessageId: "pm1", subject: "Hello Ada", errorMessage: null, failedAt: null }),
    });
  });

  it("campaign send carries List-Unsubscribe headers", async () => {
    await deliverEmail(campaignJob);
    const headers = send.mock.calls[0]![0].headers;
    expect(Object.keys(headers)).toEqual(["List-Unsubscribe", "List-Unsubscribe-Post"]);
    expect(headers["List-Unsubscribe"]).toMatch(/^<http:\/\/localhost:4000\/.*>$/);
    expect(headers["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");
  });

  it("provider rejection: ledger FAILED with the message, error rethrown unchanged", async () => {
    const boom = new Error("smtp auth failed");
    send.mockRejectedValueOnce(boom);
    await expect(deliverEmail(manualJob)).rejects.toBe(boom);
    expect(db.emailLog.update).toHaveBeenLastCalledWith({
      where: { id: "log1" },
      data: { status: "FAILED", errorMessage: "smtp auth failed", failedAt: expect.any(Date) },
    });
  });

  it("missing first name does not fail the send (buildVars supplies a fallback)", async () => {
    db.contact.findUnique.mockResolvedValue({ ...contact, firstName: null });
    await expect(deliverEmail(manualJob)).resolves.toMatchObject({ result: "sent" });
  });

  it("missing declared variable: render error becomes a permanent error and FAILED ledger", async () => {
    db.template.findUnique.mockResolvedValue({ ...template, subject: "Plan {{plan_name}}", variables: ["plan_name"] });
    await expect(deliverEmail(manualJob)).rejects.toThrow(/^render: /);
    expect(db.emailLog.update).toHaveBeenLastCalledWith({
      where: { id: "log1" },
      data: expect.objectContaining({ status: "FAILED", failedAt: expect.any(Date) }),
    });
    expect(send).not.toHaveBeenCalled();
  });
});
