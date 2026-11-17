import { beforeEach, describe, expect, it, vi } from "vitest";
import { fake, history } from "./fakePrismaPlus.js";

// Import filter step → "Exclude already used data": which rows match each of the three checks, per channel.
//   contacts  WhatsApp Contacts / THIS language's Voicecall list (the importers' own "already saved" rule)
//   sent      WhatsApp sends, email logs, Send Queue email batches (historyFilter.ts loadHistory, as is)
//   called    call logs (same loadHistory) or do-not-call / not interested / wrong person (Data Quality lookups)
// Read-only: nothing is written anywhere.

vi.mock("../src/prisma.js", async () => ({ prisma: (await import("./fakePrismaPlus.js")).db }));

const { checkWhatsAppDraft, checkVoicecallDraft } = await import("../src/domain/importFilterCheck.js");
const { findUsed } = await import("../src/domain/importFilterUsed.js");

const D = (iso: string) => new Date(iso);
const MODELS = ["contact", "whatsAppContact", "whatsAppSend", "manualSendBatchItem", "aiCallLog", "aiCallCustomer", "dataQualityJob", "dataQualityRecord"];
const WRITES = ["create", "upsert", "update", "delete", "deleteMany"] as const;
const expectNothingWritten = () => {
  for (const m of MODELS) for (const w of WRITES) expect(fake.model(m)[w], `${m}.${w}`).not.toHaveBeenCalled();
  expect(history.rows).toEqual([]);
};

beforeEach(() => {
  fake.reset();
  history.reset();
  fake.T("whatsAppContact").push({ id: "w1", phone: "919876500001", status: "ACTIVE", createdAt: D("2026-10-03T09:00:00Z") });
  fake.T("aiCallCustomer").push(
    { id: "c-en", phone: "+919876500002", activePhone: "+919876500002", language: "en", doNotCall: false, stage: "NOT_CALLED", createdAt: D("2026-10-05T09:00:00Z") },
    { id: "c-ta", phone: "+919876500003", activePhone: "+919876500003", language: "ta", doNotCall: false, stage: "NOT_CALLED", createdAt: D("2026-10-06T09:00:00Z") },
    { id: "c-dnc", phone: "+919876500008", activePhone: null, language: "en", doNotCall: true, stage: "DO_NOT_CALL", createdAt: D("2026-09-01T09:00:00Z") },
  );
  fake.T("whatsAppSend").push(
    { phone: "919876500004", status: "DELIVERED", createdAt: D("2026-11-12T10:00:00Z") },
    { phone: "919876500004", status: "READ", createdAt: D("2026-11-01T10:00:00Z") },
    { phone: "+919876500005", status: "FAILED", createdAt: D("2026-11-13T10:00:00Z") }, // failed only: not "used"
  );
  fake.T("manualSendBatchItem").push({ email: "batch@shop.in", status: "SENT", createdAt: D("2026-11-01T10:00:00Z") });
  fake.T("contact").push({ id: "e1", email: "logged@shop.in", emailLogs: [{ status: "OPENED", createdAt: D("2026-11-02T10:00:00Z") }] });
  fake.T("aiCallLog").push(
    { phone: "+919876500006", status: "COMPLETED", outcome: "interested", createdAt: D("2026-11-10T10:00:00Z") },
    { phone: "+919876500007", status: "FAILED", outcome: null, createdAt: D("2026-11-11T10:00:00Z") }, // failed call: not "used"
  );
});

const PHONES = {
  waContact: "9876500001",
  vcEnglish: "9876500002",
  vcTamil: "9876500003",
  waSent: "9876500004",
  waFailedOnly: "9876500005",
  called: "9876500006",
  callFailed: "9876500007",
  doNotCall: "9876500008",
  emailBatch: "9876500009",
  emailLog: "9876500010",
  fresh: "9876500011",
};
const EMAILS: Partial<Record<keyof typeof PHONES, string>> = { emailBatch: "batch@shop.in", emailLog: "Logged@Shop.in" };
const keys = Object.keys(PHONES) as (keyof typeof PHONES)[];

describe("WhatsApp Contacts", () => {
  it("each check, with the date for the reason", async () => {
    const checks = await checkWhatsAppDraft(
      ["Phone", "First Name", "Email"],
      keys.map((k) => ({ Phone: PHONES[k], "First Name": k, Email: EMAILS[k] ?? "" })),
      "91",
    );
    const used = Object.fromEntries(keys.map((k, i) => [k, checks[i]!.used]));

    // 1. Already in contacts (WhatsApp Contacts only: a Voicecall customer is not a WhatsApp contact).
    expect(used.waContact!.inContacts).toEqual({ at: "2026-10-03T09:00:00.000Z" });
    expect(checks[0]!.alreadySaved).toBe(true);
    expect(used.vcEnglish!.inContacts).toBeNull();

    // 2. Already sent: WhatsApp sends (latest), email logs and Send Queue email batches; a failed-only send is not.
    expect(used.waSent!.sent).toEqual({ at: "2026-11-12T10:00:00.000Z", via: ["whatsapp"] });
    expect(used.waFailedOnly!.sent).toBeNull();
    expect(used.emailBatch!.sent).toEqual({ at: "2026-11-01T10:00:00.000Z", via: ["email"] });
    expect(used.emailLog!.sent).toEqual({ at: "2026-11-02T10:00:00.000Z", via: ["email"] });

    // 3. Already called: call logs (a failed call is not), and do-not-call.
    expect(used.called!.called).toEqual({ at: "2026-11-10T10:00:00.000Z", reason: "called" });
    expect(used.callFailed!.called).toBeNull();
    expect(used.doNotCall!.called).toEqual({ at: null, reason: "do_not_call" });

    expect(used.fresh).toEqual({ inContacts: null, sent: null, called: null });
    expectNothingWritten();
  });
});

describe("Voicecall Contact", () => {
  const rows = keys.map((k) => ({ name: k, phone: PHONES[k], business: "Shop", email: EMAILS[k] ?? null }));

  it("English page: 'already in contacts' is the English list only", async () => {
    const checks = await checkVoicecallDraft(rows, "en", "91", "91");
    const used = Object.fromEntries(keys.map((k, i) => [k, checks[i]!.used]));
    expect(used.vcEnglish!.inContacts).toEqual({ at: "2026-10-05T09:00:00.000Z" });
    expect(used.vcTamil!.inContacts).toBeNull(); // in the Tamil list only
    expect(used.waContact!.inContacts).toBeNull(); // a WhatsApp contact is not in a Voicecall list
    // Sent / called are the same checks as on WhatsApp.
    expect(used.waSent!.sent).toEqual({ at: "2026-11-12T10:00:00.000Z", via: ["whatsapp"] });
    expect(used.emailLog!.sent?.via).toEqual(["email"]);
    expect(used.called!.called?.reason).toBe("called");
    expect(used.doNotCall!.called?.reason).toBe("do_not_call");
    expect(used.fresh).toEqual({ inContacts: null, sent: null, called: null });
    expectNothingWritten();
  });

  it("Tamil page: 'already in contacts' is the Tamil list only", async () => {
    const checks = await checkVoicecallDraft(rows, "ta", "91", "91");
    expect(checks[keys.indexOf("vcTamil")]!.used.inContacts).toEqual({ at: "2026-10-06T09:00:00.000Z" });
    expect(checks[keys.indexOf("vcEnglish")]!.used.inContacts).toBeNull();
  });

  it("not interested / wrong person call results count as already called", async () => {
    fake.T("aiCallLog").push(
      { phone: "+919876500012", status: "COMPLETED", outcome: "not_interested", createdAt: D("2026-11-09T10:00:00Z") },
      { phone: "+919876500013", status: "COMPLETED", outcome: "wrong_person", createdAt: D("2026-11-08T10:00:00Z") },
    );
    const checks = await checkVoicecallDraft(
      [
        { name: "A", phone: "9876500012", business: "x" },
        { name: "B", phone: "9876500013", business: "y" },
      ],
      "en",
      "91",
      "91",
    );
    expect(checks.map((c) => c.used.called)).toEqual([
      { at: "2026-11-09T10:00:00.000Z", reason: "not_interested" },
      { at: "2026-11-08T10:00:00.000Z", reason: "wrong_person" },
    ]);
  });

  it("no usable number and no email: nothing matches, nothing is looked up", async () => {
    expect(await findUsed("voicecall", [{ phone: null, email: null, excludedReason: null }], { whatsappCountryCode: "91", callCountryCode: "91" })).toEqual([
      { inContacts: null, sent: null, called: null },
    ]);
    expect(fake.model("aiCallCustomer").findMany).not.toHaveBeenCalled();
  });
});
