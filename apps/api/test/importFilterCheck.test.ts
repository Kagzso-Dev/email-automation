import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fake } from "./fakePrisma.js";
import {
  DQ_DO_NOT_CALL,
  DQ_EXPECTED,
  DQ_HEADERS,
  DQ_IN_VOICECALL,
  DQ_IN_WHATSAPP,
  DQ_NOT_INTERESTED,
  DQ_ROWS,
  DQ_WRONG_PERSON,
} from "./dataQualityFixture.js";

// Import filter step (ENABLE_IMPORT_FILTER_STEP): the Data Quality checks on rows that are NOT saved.
// Same results as the Data Quality page's own rules; existing tables are only read; nothing is written,
// queued or sent to an AI service.

vi.mock("../src/prisma.js", async () => ({ prisma: (await import("./fakePrismaPlus.js")).db }));
const enqueued = vi.hoisted(() => [] as unknown[]);
vi.mock("../src/queue/queues.js", async (orig) => ({
  ...(await orig<typeof import("../src/queue/queues.js")>()),
  enqueueDataQuality: async (job: unknown) => void enqueued.push(job),
}));

const { checkDraftRows, checkWhatsAppDraft, whatsappPhoneHeader, WHATSAPP_NO_NUMBER } = await import("../src/domain/importFilterCheck.js");
const { checkRows, loadLookups } = await import("../src/domain/dataQuality.js");

const MODELS = ["contact", "whatsAppContact", "aiCallLog", "aiCallCustomer", "dataQualityJob", "dataQualityRecord", "dataQualityExportLog"];
const WRITES = ["create", "upsert", "update", "delete", "deleteMany"] as const;
function expectNothingWritten() {
  for (const m of MODELS) for (const w of WRITES) expect(fake.model(m)[w], `${m}.${w}`).not.toHaveBeenCalled();
  expect(enqueued).toEqual([]);
}

const realFetch = globalThis.fetch;
let outbound: string[] = [];
beforeEach(() => {
  fake.reset();
  enqueued.length = 0;
  outbound = [];
  globalThis.fetch = (async (url: string | URL | Request) => {
    outbound.push(String(url));
    throw new Error("no network in this test");
  }) as typeof fetch;
  // The same existing data the Data Quality tests use.
  fake.T("aiCallCustomer").push(
    { phone: DQ_DO_NOT_CALL, activePhone: null, doNotCall: true, stage: "NOT_CALLED" },
    { phone: DQ_IN_VOICECALL, activePhone: DQ_IN_VOICECALL, doNotCall: false, stage: "NOT_CALLED" },
  );
  fake.T("aiCallLog").push({ phone: DQ_NOT_INTERESTED, outcome: "not_interested" }, { phone: DQ_WRONG_PERSON, outcome: "wrong_person" });
  fake.T("whatsAppContact").push({ phone: DQ_IN_WHATSAPP.slice(1), status: "ACTIVE" });
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

const asInput = ([name, phone, business, email]: [string, string, string, string]) => ({ name, phone, business, email });

describe("checkDraftRows: Data Quality's rules on rows held in memory", () => {
  it("gives exactly the Data Quality page's results for its 20-row test file", async () => {
    const checks = await checkDraftRows(DQ_ROWS.map(asInput), "91");
    const counts = { total: checks.length, valid: 0, invalid: 0, duplicates: 0, excluded: 0 };
    for (const c of checks) {
      if (c.status === "VALID") counts.valid++;
      else if (c.status === "INVALID") counts.invalid++;
      else if (c.status === "DUPLICATE") counts.duplicates++;
      else counts.excluded++;
    }
    expect(counts).toEqual(DQ_EXPECTED);

    // Field for field what checkRows gives the Data Quality page for the same file.
    const sheet = DQ_ROWS.map((r) => Object.fromEntries(DQ_HEADERS.map((h, i) => [h, r[i]!])));
    const phones = checks.flatMap((c) => (c.phone ? [c.phone] : []));
    const lookups = await loadLookups(phones, ["ravi@ravitraders.in", "mohan@mohanpharmacy.in"], "91");
    const { records } = checkRows(sheet, { name: "Name", phone: "Phone", business: "Business Name", email: "Email" }, lookups, "91");
    for (const [i, r] of records.entries()) {
      expect(checks[i]).toMatchObject({
        rowIndex: r.rowIndex,
        status: r.status,
        excludedReason: r.excludedReason,
        issues: r.issues,
        flags: r.flags,
        ruleScore: r.ruleScore,
        score: r.ruleScore, // rules score only: no AI score in this step
      });
    }
    expect(checks[13]!.flags).toContain("in_whatsapp"); // row 15
    expect(checks[12]!.flags).toContain("in_voicecall"); // row 14
    expectNothingWritten();
    expect(outbound).toEqual([]);
  });

  it("phone type and tier come from the Data Quality helpers", async () => {
    const checks = await checkDraftRows(
      [
        { name: "Ravi Kumar", phone: "9876500101", business: "Ravi Traders" }, // mobile, 100
        { name: "Chennai Office", phone: "044 2345 6789", business: "Acme" }, // landline, 100 - 20
        { name: "Toll Free", phone: "18001234567", business: "Helpline" },
        { name: "Abroad", phone: "+971501234567", business: "Dubai Co" },
        { name: "No Phone", phone: "", business: "x" },
      ],
      "91",
    );
    expect(checks.map((c) => c.phoneType)).toEqual(["mobile", "landline", "tollfree", "international", "none"]);
    expect(checks[0]).toMatchObject({ status: "VALID", score: 100, tier: "HIGH_PRIORITY" });
    expect(checks[1]).toMatchObject({ status: "VALID", score: 80, tier: "GOOD", issues: ["not_mobile"] });
    expect(checks[4]).toMatchObject({ status: "INVALID", score: null, tier: null });
    expectNothingWritten();
  });
});

describe("checkWhatsAppDraft: rows as the WhatsApp importer reads them", () => {
  const headers = ["Phone", "First Name", "Last Name", "Company", "Email"];
  const row = (phone: string, first: string, last = "", company = "", email = "") => ({
    Phone: phone,
    "First Name": first,
    "Last Name": last,
    Company: company,
    Email: email,
  });

  it("finds the importer's own phone column", () => {
    expect(whatsappPhoneHeader(headers)).toBe("Phone");
    expect(whatsappPhoneHeader(["WhatsApp Number", "Name"])).toBe("WhatsApp Number");
    // Data Quality would read "Contact Number"; the WhatsApp importer doesn't.
    expect(whatsappPhoneHeader(["Contact Number", "Name"])).toBeNull();
  });

  it("marks what the importer would take, and numbers already saved", async () => {
    const checks = await checkWhatsAppDraft(
      headers,
      [
        row("9876500101", "Ravi", "Kumar", "Ravi Traders", "ravi@x.in"), // new mobile
        row(DQ_IN_WHATSAPP.slice(3), "Anitha", "", "Anitha Beauty Parlour"), // already saved → importer updates it
        row("044 2345 6789", "Chennai", "Office", "Acme"), // landline: WhatsApp can't use it
        row("", "No", "Phone", "x"),
      ],
      "91",
    );
    // The check reads the row as the Data Quality page does (its name column is "First Name"), so it matches that page.
    expect(checks[0]).toMatchObject({ name: "Ravi", businessName: "Ravi Traders", email: "ravi@x.in", phoneType: "mobile", importable: true, alreadySaved: false });
    expect(checks[1]).toMatchObject({ phone: DQ_IN_WHATSAPP, importable: true, alreadySaved: true });
    expect(checks[1]!.flags).toContain("in_whatsapp");
    expect(checks[2]).toMatchObject({ name: "Chennai", phoneType: "landline", importable: false, importProblem: WHATSAPP_NO_NUMBER, alreadySaved: false });
    expect(checks[3]).toMatchObject({ phoneType: "none", importable: false });
    expect(fake.T("whatsAppContact")).toHaveLength(1); // unchanged
    expectNothingWritten();
  });

  it("an unusable WHATSAPP_DEFAULT_COUNTRY_CODE (a full number) counts as 91, as in the importer", async () => {
    const checks = await checkWhatsAppDraft(headers, [row("9876500101", "Ravi"), row("044 2345 6789", "Chennai")], "919092490661");
    expect(checks.map((c) => [c.phone, c.phoneType, c.importable])).toEqual([
      ["+919876500101", "mobile", true],
      ["+914423456789", "landline", false],
    ]);
  });

  it("a file without a column the importer reads as the phone: nothing is importable (Data Quality still reads it)", async () => {
    const checks = await checkWhatsAppDraft(["Contact Number", "Name"], [{ "Contact Number": "9876500101", Name: "Ravi" }], "91");
    // Data Quality reads "Contact Number" (so the check matches that page); the WhatsApp importer does not.
    expect(checks[0]).toMatchObject({ importable: false, importProblem: WHATSAPP_NO_NUMBER, phoneType: "mobile", name: "Ravi" });
    expectNothingWritten();
  });
});
