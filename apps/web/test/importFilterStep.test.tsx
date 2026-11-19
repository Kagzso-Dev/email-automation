import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import type { AiCallLanguage } from "@dispatch/shared";
import { ConfirmProvider } from "../src/components/confirm";
import { ToastProvider } from "../src/components/toast";
import { api } from "../src/lib/api";
import { AiCallLanguageProvider } from "../src/lib/aiCallLanguage";
import {
  ALL_LANGUAGES,
  detectLanguage,
  draftRowMatches,
  pageDefaults,
  rowsToCsv,
  selectedFileName,
  toDraftRows,
  type DraftCheck,
} from "../src/lib/importFilter";
import { WhatsAppContactsPage } from "../src/pages/WhatsAppContacts";
import { AiCallCustomersPanel } from "../src/components/AiCallCustomersPanel";
import type { AiCallsConfig } from "../src/lib/aiCalls";
import { describeFilters } from "../src/lib/uploadHistory";

// Import filter step (ENABLE_IMPORT_FILTER_STEP) on WhatsApp Contacts and Voicecall Contact (English, Tamil).
// Flag OFF: "Import file" works exactly as before. Flag ON: the rows open in the Data Quality filter view
// first, with each page's default filters; nothing is sent to an importer until "Import N selected".
// lib/api is mocked and records every call.

const state = vi.hoisted(() => ({
  flag: false,
  role: "EDITOR" as "EDITOR" | "ADMIN",
  vcNoPhone: false,
  extra: false,
  // The AI score (GET /api/import-filter/ai, POST /ai-score); null = the service is not set up.
  ai: null as null | { info: Record<string, unknown>; score?: (rows: { name: string | null; business: string | null; ruleScore: number | null }[]) => unknown },
}));

vi.mock("../src/lib/auth", () => ({
  useAuth: () => ({ user: { role: state.role, email: "e@example.com" }, loading: false, logout: () => undefined }),
}));

/* ------------------------------------------------------------------ fixtures */

const check = (rowIndex: number, over: Partial<DraftCheck>): DraftCheck => ({
  rowIndex,
  name: null,
  phoneRaw: null,
  phone: null,
  businessName: null,
  email: null,
  status: "VALID",
  excludedReason: null,
  issues: [],
  flags: [],
  ruleScore: 100,
  score: 100,
  phoneType: "mobile",
  tier: "HIGH_PRIORITY",
  ...over,
});

const WA_HEADERS = ["phone", "first name", "business name"];
const WA_ROWS = [
  { phone: "9876500101", "first name": "Ravi", "business name": "Ravi Traders" },
  { phone: "044 2345 6789", "first name": "Chennai", "business name": "Acme, Chennai" },
  { phone: "9876500104", "first name": "முருகன்", "business name": "முருகன் ஸ்டோர்ஸ்" },
  { phone: "98765 00101", "first name": "Ravi K", "business name": "Ravi Traders" },
];
const WA_PREVIEW = {
  filename: "contacts.xlsx",
  headers: WA_HEADERS,
  rows: WA_ROWS,
  totalRows: 4,
  maxRows: 1000,
  truncated: false,
  checks: [
    { ...check(0, { name: "Ravi", phone: "+919876500101", businessName: "Ravi Traders" }), importable: true, importProblem: null, alreadySaved: false },
    {
      ...check(1, { name: "Chennai", phone: "+914423456789", businessName: "Acme, Chennai", phoneType: "landline", ruleScore: 80, score: 80, tier: "GOOD", issues: ["not_mobile"] }),
      importable: false,
      importProblem: "No usable WhatsApp number: the importer skips this row",
      alreadySaved: false,
    },
    {
      ...check(2, { name: "முருகன்", phone: "+919876500104", businessName: "முருகன் ஸ்டோர்ஸ்", flags: ["in_whatsapp"] }),
      importable: true,
      importProblem: null,
      alreadySaved: true,
    },
    {
      ...check(3, { name: "Ravi K", phone: "+919876500101", businessName: "Ravi Traders", status: "DUPLICATE", ruleScore: null, score: null, tier: null, issues: ["duplicate_of_row_2"] }),
      importable: true,
      importProblem: null,
      alreadySaved: false,
    },
  ],
};

const VC_SHEET = {
  headers: ["customer_name", "phone", "business_name"],
  rows: [
    { customer_name: "Ravi", phone: "9876500101", business_name: "Ravi Traders" }, // mobile
    { customer_name: "Chennai Office", phone: "04423456789", business_name: "Acme" }, // landline
    { customer_name: "Abroad", phone: "+971501234567", business_name: "Dubai Co" }, // other country
    { customer_name: "Ravi again", phone: "9876500101", business_name: "Ravi Traders" }, // repeated number: skipped, as today
  ],
  truncated: false,
  totalRows: 4,
  maxRows: 1000,
  mapping: { customer_name: "customer_name", gender: null, phone: "phone", business_name: "business_name", follow_up_detail: null, email: null, whatsapp_opt_in: null },
};
const VC_CHECKS = [
  check(0, { name: "Ravi", phone: "+919876500101", businessName: "Ravi Traders" }),
  check(1, { name: "Chennai Office", phone: "+914423456789", businessName: "Acme", phoneType: "landline", ruleScore: 80, score: 80, tier: "GOOD" }),
  check(2, { name: "Abroad", phone: "+971501234567", businessName: "Dubai Co", phoneType: "international" }),
  check(3, { name: "Ravi again", phone: "+919876500101", status: "DUPLICATE", ruleScore: null, score: null, tier: null }),
];

// The same files with a City and an Industry column (Data Quality's dropdowns).
const CITY = ["Chennai", "Chennai", "Madurai", "Chennai"];
const INDUSTRY = ["Retail", "IT", "Retail", "Retail"];
const NO_EXTRA = { city: null, state: null, district: null, pincode: null, category: null, source: null, dateAdded: null };
const WA_PREVIEW_EXTRA = {
  ...WA_PREVIEW,
  headers: [...WA_HEADERS, "City", "Industry"],
  rows: WA_ROWS.map((r, i) => ({ ...r, City: CITY[i]!, Industry: INDUSTRY[i]! })),
  extraColumns: { ...NO_EXTRA, city: "City", category: "Industry" },
};
const VC_SHEET_EXTRA = {
  ...VC_SHEET,
  headers: [...VC_SHEET.headers, "city"],
  rows: VC_SHEET.rows.map((r, i) => ({ ...r, city: CITY[i]! })),
};
const VC_EXTRA_COLUMNS = { ...NO_EXTRA, city: "city" };

vi.mock("../src/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/api")>()),
  api: vi.fn(async (path: string, opts: { method?: string } = {}) => {
    const method = opts.method ?? "GET";
    if (path === "/api/import-filter/config") return { enabled: state.flag, maxRows: 1000 };
    if (path === "/api/import-filter/ai")
      return state.ai?.info ?? { available: false, provider: "ollama", label: "Ollama", model: null, reason: "not set up", minGapMs: 0, maxFailures: 5, batchSize: 5, liveCalls: false };
    if (path === "/api/import-filter/ai-score") return state.ai!.score!((opts as { json: { rows: never[] } }).json.rows);
    if (path === "/api/import-filter/whatsapp/preview") return state.extra ? WA_PREVIEW_EXTRA : WA_PREVIEW;
    if (path === "/api/import-filter/voicecall/check") return state.extra ? { checks: VC_CHECKS, extraColumns: VC_EXTRA_COLUMNS } : { checks: VC_CHECKS };
    if (path === "/api/whatsapp/contacts/import") return { totalRows: 2, maxRows: 1000, selectedRows: 2, skippedOverLimit: 0, created: 1, updated: 1, duplicates: 0, failed: 0 };
    if (path.startsWith("/api/whatsapp/contacts")) return { items: [], total: 0, page: 1, pageSize: 25 };
    if (path === "/api/whatsapp/config") return { configured: false };
    if (path === "/api/ai-call-customers/parse")
      return state.extra ? VC_SHEET_EXTRA : state.vcNoPhone ? { ...VC_SHEET, mapping: { ...VC_SHEET.mapping, phone: null } } : VC_SHEET;
    if (path === "/api/ai-call-customers/import-to-languages")
      return { results: ["en", "ta"].map((language) => ({ language, imported: 2, duplicates: 0, doNotCall: 0, skipped: 0, failed: false })) };
    if (path.startsWith("/api/ai-call-customers/import")) return { imported: 2, skipped: 0, duplicates: 0, doNotCall: 0, problems: [] };
    if (path.startsWith("/api/ai-call-customers") && method === "GET") return { items: [], total: 0, page: 1, pageSize: 25 };
    if (path === "/api/ai-calls/config") return AI_CONFIG;
    return { items: [] };
  }),
}));

const AI_CONFIG: AiCallsConfig = {
  enabled: true,
  configured: true,
  canStart: true,
  maxPerRun: 10,
  minGapSec: 10,
  defaultGapSec: 30,
  defaultCountryCode: "91",
  flowEditor: false,
  testCallNumbers: [],
  languages: [
    { code: "en", name: "English", configured: true, enabled: true },
    { code: "ta", name: "Tamil", configured: true, enabled: true },
  ],
};

/* ------------------------------------------------------------------ helpers */

const client = () => new QueryClient({ defaultOptions: { queries: { retry: false } } });
function wrap(ui: React.ReactNode, language: AiCallLanguage = "en") {
  return render(
    <QueryClientProvider client={client()}>
      <ToastProvider>
        <ConfirmProvider>
          <MemoryRouter>
            <AiCallLanguageProvider language={language}>{ui}</AiCallLanguageProvider>
          </MemoryRouter>
        </ConfirmProvider>
      </ToastProvider>
    </QueryClientProvider>,
  );
}
const calls = () => vi.mocked(api).mock.calls.map(([path, o]) => [path, (o as { method?: string } | undefined)?.method ?? "GET"] as const);
const posted = (prefix: string) => calls().filter(([p, m]) => m === "POST" && p.startsWith(prefix));
const fileInput = (accept: string) => document.querySelector(`input[type="file"][accept="${accept}"]`) as HTMLInputElement;
const pick = (input: HTMLInputElement, file: File) => fireEvent.change(input, { target: { files: [file] } });
const checkbox = (name: string) => screen.getByRole("checkbox", { name }) as HTMLInputElement;
const settle = () => new Promise((r) => setTimeout(r, 30));
const readFile = (f: File) =>
  new Promise<string>((resolve) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.readAsText(f);
  });

beforeEach(() => {
  state.flag = false;
  state.role = "EDITOR";
  state.vcNoPhone = false;
  state.extra = false;
  state.ai = null;
  vi.mocked(api).mockClear();
});
afterEach(cleanup);

/* ------------------------------------------------------------------ lib */

describe("page defaults and filters", () => {
  it("WhatsApp: Phone type = Mobile only; Voicecall: Mobile + Landline; every language included; every 'already used' option ticked", () => {
    const exclude = ["contacts", "sent", "called"];
    expect(pageDefaults("whatsapp")).toEqual({ filters: { phoneType: ["mobile"] }, languages: ALL_LANGUAGES, exclude });
    expect(pageDefaults("voicecall")).toEqual({ filters: { phoneType: ["mobile", "landline"] }, languages: ALL_LANGUAGES, exclude });
    expect(ALL_LANGUAGES).toEqual(["ta", "en", "indic", "unknown"]);
  });

  it("language from the script of the name and business", () => {
    expect(detectLanguage("முருகன்", "Stores")).toBe("ta");
    expect(detectLanguage("राम", null)).toBe("indic");
    expect(detectLanguage("Ravi", "Ravi Traders")).toBe("en");
    expect(detectLanguage("", "12345")).toBe("unknown");
  });

  it("filters match like the Data Quality page (AND across groups, any within a group)", () => {
    const rows = toDraftRows(WA_PREVIEW.checks);
    const ids = (f: Parameters<typeof draftRowMatches>[1], langs = ALL_LANGUAGES) => rows.filter((r) => draftRowMatches(r, f, langs)).map((r) => r.rowIndex);
    expect(ids({ phoneType: ["mobile"] })).toEqual([0, 2, 3]);
    expect(ids({ phoneType: ["mobile", "landline"] })).toEqual([0, 1, 2, 3]);
    expect(ids({ status: ["LANDLINE"] })).toEqual([1]);
    expect(ids({ status: ["VALID"], tier: ["GOOD"] })).toEqual([1]);
    expect(ids({}, ["ta"])).toEqual([2]);
    expect(ids({}, [])).toEqual([0, 1, 2, 3]); // an empty group is no filter
  });

  it("the chosen rows as a CSV with the file's own columns (quoted where needed, no BOM)", () => {
    expect(rowsToCsv(WA_HEADERS, [WA_ROWS[1]!])).toBe('phone,first name,business name\r\n044 2345 6789,Chennai,"Acme, Chennai"\r\n');
    expect(selectedFileName("contacts.xlsx")).toBe("contacts-selected.csv");
  });
});

/* ------------------------------------------------------------------ WhatsApp Contacts */

describe("WhatsApp Contacts → Import file", () => {
  it("flag OFF: the file is imported at once, exactly as before (no filter step)", async () => {
    wrap(<WhatsAppContactsPage />);
    await screen.findByText("Import file");
    const file = new File(["phone\n9876500101\n"], "contacts.csv", { type: "text/csv" });
    pick(fileInput(".csv,.xlsx"), file);
    await waitFor(() => expect(posted("/api/whatsapp/contacts/import")).toHaveLength(1));
    const body = vi.mocked(api).mock.calls.find(([p]) => p === "/api/whatsapp/contacts/import")![1]!.body as FormData;
    expect(body.get("file")).toBe(file); // the original file, untouched
    expect(posted("/api/import-filter")).toEqual([]);
    expect(screen.queryByText(/Import \d+ selected/)).toBeNull();
  });

  it("flag ON: filter step with Mobile only ticked; nothing imported until Import N selected", async () => {
    state.flag = true;
    wrap(<WhatsAppContactsPage />);
    await screen.findByText("Import file");
    pick(fileInput(".csv,.xlsx"), new File(["x"], "contacts.xlsx"));

    const importBtn = await screen.findByRole("button", { name: "Import 3 selected" });
    expect(posted("/api/import-filter/whatsapp/preview")).toHaveLength(1);
    expect(posted("/api/whatsapp/contacts/import")).toEqual([]); // nothing saved yet

    // Defaults: Phone type = Mobile only; every language included.
    expect(checkbox("Mobile").checked).toBe(true);
    for (const other of ["Landline", "Toll-free", "Other country", "Unusable", "No phone"]) expect(checkbox(other).checked).toBe(false);
    for (const lang of ["Tamil", "English", "Other Indian", "Not detected"]) expect(checkbox(lang).checked).toBe(true);
    expect(screen.getByText(/Showing 3 of 4/)).toBeTruthy();
    expect(screen.getByText("Already saved: the import updates it")).toBeTruthy();
    expect(screen.getByText("One import takes up to 1,000 rows.")).toBeTruthy();

    // The user can change the defaults: a landline shows, but the WhatsApp importer can't take it.
    fireEvent.click(checkbox("Landline"));
    expect(screen.getByText(/Showing 4 of 4/)).toBeTruthy();
    expect(screen.getByText(/No usable WhatsApp number/)).toBeTruthy();
    expect(importBtn.textContent).toBe("Import 3 selected");

    // Live count; untick one row.
    fireEvent.click(checkbox("Select row 2"));
    expect(screen.getByRole("button", { name: "Import 2 selected" })).toBeTruthy();
    await settle();
    expect(posted("/api/whatsapp/contacts/import")).toEqual([]);

    fireEvent.click(screen.getByRole("button", { name: "Import 2 selected" }));
    await waitFor(() => expect(posted("/api/whatsapp/contacts/import")).toHaveLength(1));
    const sent = (vi.mocked(api).mock.calls.find(([p]) => p === "/api/whatsapp/contacts/import")![1]!.body as FormData).get("file") as File;
    expect(sent.name).toBe("contacts-selected.csv");
    expect(await readFile(sent)).toBe(rowsToCsv(WA_HEADERS, [WA_ROWS[2]!, WA_ROWS[3]!]));

    // Summary: added, duplicates, failed, filtered out.
    const summary = await screen.findByLabelText("Import summary");
    // 4 read: 2 sent (1 new + 1 updated), 1 landline WhatsApp can't use (failed), 1 unticked (filtered out).
    const count = (label: string) => within(summary).getByText(label).nextSibling?.textContent;
    expect([count("Successfully imported"), count("Failed"), count("Duplicates"), count("Filtered out")]).toEqual(["2", "1", "0", "1"]);
    expect(screen.getByText(/1 new, 1 already saved \(updated\)/)).toBeTruthy();
  });

  it("flag ON: Import is disabled with 0 selected, and Back imports nothing", async () => {
    state.flag = true;
    wrap(<WhatsAppContactsPage />);
    await screen.findByText("Import file");
    pick(fileInput(".csv,.xlsx"), new File(["x"], "contacts.xlsx"));
    await screen.findByRole("button", { name: "Import 3 selected" });

    fireEvent.click(checkbox("Select all rows shown"));
    expect((screen.getByRole("button", { name: "Import 0 selected" }) as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    // The dialog closes (after its ~150 ms closing animation); nothing was imported.
    await waitFor(() => expect(screen.queryByRole("button", { name: /Import \d+ selected/ })).toBeNull());
    expect(posted("/api/whatsapp/contacts/import")).toEqual([]);
  });
});

/* ------------------------------------------------------------------ Voicecall Contact */

async function openVoicecallMapping(language: AiCallLanguage = "en") {
  wrap(<AiCallCustomersPanel config={AI_CONFIG} />, language);
  fireEvent.click(await screen.findByRole("button", { name: "Import file" }));
  pick(fileInput(".xlsx,.csv"), new File(["x"], "customers.xlsx"));
  await screen.findByText(/rows? read/);
}

describe("Voicecall Contact → Import file", () => {
  it("flag OFF: the mapping screen imports every valid row, exactly as before", async () => {
    await openVoicecallMapping();
    const btn = await screen.findByRole("button", { name: "Import 3 valid rows" });
    fireEvent.click(btn);
    await waitFor(() => expect(posted("/api/ai-call-customers/import")).toHaveLength(1));
    const [path, opts] = vi.mocked(api).mock.calls.find(([p]) => p.startsWith("/api/ai-call-customers/import"))!;
    expect(path).toBe("/api/ai-call-customers/import");
    expect(((opts as { json: { rows: unknown[] } }).json.rows as { customerName: string }[]).map((r) => r.customerName)).toEqual(["Ravi", "Chennai Office", "Abroad"]);
    expect(posted("/api/import-filter")).toEqual([]);
  });

  for (const language of ["en", "ta"] as const) {
    it(`flag ON (${language}): Mobile + Landline and every language ticked; only the chosen rows are imported`, async () => {
      state.flag = true;
      await openVoicecallMapping(language);

      const importBtn = await screen.findByRole("button", { name: "Import 2 selected" });
      expect(checkbox("Mobile").checked).toBe(true);
      expect(checkbox("Landline").checked).toBe(true);
      for (const other of ["Toll-free", "Other country", "Unusable", "No phone"]) expect(checkbox(other).checked).toBe(false);
      for (const lang of ["Tamil", "English", "Other Indian", "Not detected"]) expect(checkbox(lang).checked).toBe(true);
      expect(screen.getByText(/Showing 3 of 4/)).toBeTruthy();
      expect(screen.getByText("Same number as an earlier row: skipped, as today")).toBeTruthy();
      expect(posted("/api/ai-call-customers/import")).toEqual([]); // nothing saved yet

      fireEvent.click(importBtn);
      await waitFor(() => expect(posted("/api/ai-call-customers/import")).toHaveLength(1));
      const [path, opts] = vi.mocked(api).mock.calls.find(([p]) => p.startsWith("/api/ai-call-customers/import"))!;
      expect(path).toBe(language === "en" ? "/api/ai-call-customers/import" : "/api/ai-call-customers/import?language=ta");
      expect(((opts as { json: { rows: { customerName: string }[] } }).json.rows).map((r) => r.customerName)).toEqual(["Ravi", "Chennai Office"]);

      const summary = await screen.findByLabelText("Import summary");
      expect(within(summary).getByText("Filtered out")).toBeTruthy();
    });
  }

  it("flag ON: Back returns to Choose file without importing", async () => {
    state.flag = true;
    await openVoicecallMapping();
    await screen.findByRole("button", { name: "Import 2 selected" });
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(await screen.findByRole("button", { name: "Choose file" })).toBeTruthy();
    expect(posted("/api/ai-call-customers/import")).toEqual([]);
  });
});

/* ------------------------------------------------------------------ Business name filter */

describe("Business name contains (in the filter step)", () => {
  it("WhatsApp: only rows whose business matches are shown and imported (any case, Tamil too)", async () => {
    state.flag = true;
    wrap(<WhatsAppContactsPage />);
    await screen.findByText("Import file");
    pick(fileInput(".csv,.xlsx"), new File(["x"], "contacts.xlsx"));
    await screen.findByRole("button", { name: "Import 3 selected" });

    const business = screen.getByRole("textbox", { name: "Business name contains" });
    fireEvent.change(business, { target: { value: "ஸ்டோர்ஸ்" } });
    expect(screen.getByText(/Showing 1 of 4/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Import 1 selected" })).toBeTruthy();

    fireEvent.change(business, { target: { value: "RAVI trad" } });
    expect(screen.getByText(/Showing 2 of 4/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Import 2 selected" }));
    await waitFor(() => expect(posted("/api/whatsapp/contacts/import")).toHaveLength(1));
    const sent = (vi.mocked(api).mock.calls.find(([p]) => p === "/api/whatsapp/contacts/import")![1]!.body as FormData).get("file") as File;
    expect(await readFile(sent)).toBe(rowsToCsv(WA_HEADERS, [WA_ROWS[0]!, WA_ROWS[3]!]));
  });

  it("Voicecall: only the matching business is imported; no match = Import 0, disabled", async () => {
    state.flag = true;
    await openVoicecallMapping();
    await screen.findByRole("button", { name: "Import 2 selected" });

    const business = screen.getByRole("textbox", { name: "Business name contains" });
    fireEvent.change(business, { target: { value: "no such shop" } });
    expect((screen.getByRole("button", { name: "Import 0 selected" }) as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(business, { target: { value: "acme" } });
    fireEvent.click(screen.getByRole("button", { name: "Import 1 selected" }));
    await waitFor(() => expect(posted("/api/ai-call-customers/import")).toHaveLength(1));
    const [, opts] = vi.mocked(api).mock.calls.find(([p]) => p.startsWith("/api/ai-call-customers/import"))!;
    expect(((opts as { json: { rows: { customerName: string }[] } }).json.rows).map((r) => r.customerName)).toEqual(["Chennai Office"]);
  });
});

/* ------------------------------------------------------------------ The flow: one filter view, Data Quality's panel */

const optionTexts = (name: string) => [...(screen.getByRole("combobox", { name }) as HTMLSelectElement).options].map((o) => o.textContent);
const pickOption = (name: string, value: string) => fireEvent.change(screen.getByRole("combobox", { name }), { target: { value } });
const checkBody = () =>
  (vi.mocked(api).mock.calls.find(([p]) => p === "/api/import-filter/voicecall/check")![1] as { json: { headers?: string[] } }).json;

describe("Voicecall, flag ON: columns matched automatically, straight to the filter view", () => {
  it("the old column screen doesn't show (no column dropdowns, no 300-row preview, no Next button)", async () => {
    state.flag = true;
    await openVoicecallMapping();
    await screen.findByRole("button", { name: "Import 2 selected" });
    expect(screen.queryAllByText("— not mapped —")).toEqual([]);
    expect(screen.queryByText(/Showing the first/)).toBeNull();
    expect(screen.queryByRole("button", { name: /Next: filter/ })).toBeNull();
    expect(checkBody().headers).toEqual(VC_SHEET.headers); // only to find city / category / source / date
  });

  it("no Phone column found: the column screen shows; Next opens the filter view", async () => {
    state.flag = true;
    state.vcNoPhone = true;
    await openVoicecallMapping();
    await screen.findByText("Map the Phone column to continue.");
    const phone = screen.getAllByRole("combobox").find((el) => el.parentElement?.textContent?.startsWith("Phone"))!;
    fireEvent.change(phone, { target: { value: "phone" } });
    fireEvent.click(screen.getByRole("button", { name: "Next: filter 3 valid rows" }));
    expect(await screen.findByRole("button", { name: "Import 2 selected" })).toBeTruthy();
  });

  it("Change columns opens the column screen; Next comes back; nothing is imported", async () => {
    state.flag = true;
    await openVoicecallMapping();
    await screen.findByRole("button", { name: "Import 2 selected" });
    fireEvent.click(screen.getByRole("button", { name: "Change columns" }));
    fireEvent.click(await screen.findByRole("button", { name: "Next: filter 3 valid rows" }));
    expect(await screen.findByRole("button", { name: "Import 2 selected" })).toBeTruthy();
    expect(posted("/api/ai-call-customers/import")).toEqual([]);
  });

  it("Back at the top discards the draft and returns to Choose file", async () => {
    state.flag = true;
    await openVoicecallMapping();
    await screen.findByRole("button", { name: "Import 2 selected" });
    fireEvent.click(screen.getByRole("button", { name: "Back to choosing a file" }));
    expect(await screen.findByRole("button", { name: "Choose file" })).toBeTruthy();
    expect(posted("/api/ai-call-customers/import")).toEqual([]);
  });

  it("admins: 'Also import into other languages' is in the filter view and goes with the import", async () => {
    state.flag = true;
    state.role = "ADMIN";
    await openVoicecallMapping();
    await screen.findByRole("button", { name: "Import 2 selected" });
    const also = screen.getByRole("group", { name: "Also import into other languages" });
    fireEvent.click(within(also).getByRole("checkbox", { name: /Tamil/ }));
    fireEvent.click(screen.getByRole("button", { name: "Import 2 selected" }));
    await waitFor(() => expect(posted("/api/ai-call-customers/import-to-languages")).toHaveLength(1));
    const [, opts] = vi.mocked(api).mock.calls.find(([p]) => p === "/api/ai-call-customers/import-to-languages")!;
    const json = (opts as { json: { rows: { customerName: string }[]; languages: string[] } }).json;
    expect(json.languages).toEqual(["en", "ta"]);
    expect(json.rows.map((r) => r.customerName)).toEqual(["Ravi", "Chennai Office"]);
  });
});

describe("Data Quality's dropdowns (city, category / industry, source, date added) in the filter view", () => {
  it("WhatsApp: the file's values with counts; picking one filters the rows and the import", async () => {
    state.flag = true;
    state.extra = true;
    wrap(<WhatsAppContactsPage />);
    await screen.findByText("Import file");
    pick(fileInput(".csv,.xlsx"), new File(["x"], "contacts.xlsx"));
    await screen.findByRole("button", { name: "Import 3 selected" });

    expect(optionTexts("City")).toEqual(["Any city", "Chennai (3)", "Madurai (1)"]);
    expect(optionTexts("Category / industry")).toEqual(["Any category / industry", "Retail (3)", "IT (1)"]);
    expect(screen.queryByRole("combobox", { name: "Source" })).toBeNull(); // not in this file, as on Data Quality

    pickOption("City", "Chennai");
    expect(screen.getByText(/Showing 2 of 4/)).toBeTruthy(); // the Chennai landline stays out (Mobile only)
    pickOption("City", "");
    pickOption("Category / industry", "Retail");
    expect(screen.getByText(/Showing 3 of 4/)).toBeTruthy();
    pickOption("City", "Madurai");
    expect(screen.getByText(/Showing 1 of 4/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Import 1 selected" }));
    await waitFor(() => expect(posted("/api/whatsapp/contacts/import")).toHaveLength(1));
    const sent = (vi.mocked(api).mock.calls.find(([p]) => p === "/api/whatsapp/contacts/import")![1]!.body as FormData).get("file") as File;
    expect(await readFile(sent)).toBe(rowsToCsv(WA_PREVIEW_EXTRA.headers, [WA_PREVIEW_EXTRA.rows[2]!]));
  });

  it("Voicecall: the file's headers go with the check; City filters like on Data Quality", async () => {
    state.flag = true;
    state.extra = true;
    await openVoicecallMapping();
    await screen.findByRole("button", { name: "Import 2 selected" });
    expect(checkBody().headers).toEqual(VC_SHEET_EXTRA.headers);
    expect(optionTexts("City")).toEqual(["Any city", "Chennai (3)", "Madurai (1)"]);
    pickOption("City", "Madurai"); // the only Madurai row is another country's number: not ticked by default
    expect((screen.getByRole("button", { name: "Import 0 selected" }) as HTMLButtonElement).disabled).toBe(true);
    pickOption("City", "Chennai");
    expect(screen.getByText(/Showing 3 of 4/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Import 2 selected" })).toBeTruthy();
  });

  it("Upload History lists the dropdown choices among the filters used", () => {
    expect(describeFilters({ filters: { city: "Chennai", category: "Retail" } })).toEqual(
      expect.arrayContaining(["City: Chennai", "Category / industry: Retail"]),
    );
  });
});

describe("Clear filters returns to the page's defaults, not to a blank panel", () => {
  it("WhatsApp: back to Mobile only", async () => {
    state.flag = true;
    wrap(<WhatsAppContactsPage />);
    await screen.findByText("Import file");
    pick(fileInput(".csv,.xlsx"), new File(["x"], "contacts.xlsx"));
    await screen.findByRole("button", { name: "Import 3 selected" });
    fireEvent.click(checkbox("Landline"));
    fireEvent.change(screen.getByRole("textbox", { name: "Business name contains" }), { target: { value: "ravi" } });
    fireEvent.click(checkbox("Tamil"));
    fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));
    expect(checkbox("Mobile").checked).toBe(true);
    expect(checkbox("Landline").checked).toBe(false);
    expect(checkbox("Tamil").checked).toBe(true);
    expect((screen.getByRole("textbox", { name: "Business name contains" }) as HTMLInputElement).value).toBe("");
    expect(screen.getByText(/Showing 3 of 4/)).toBeTruthy();
  });

  it("Voicecall: back to Mobile + Landline", async () => {
    state.flag = true;
    await openVoicecallMapping("ta");
    await screen.findByRole("button", { name: "Import 2 selected" });
    fireEvent.click(checkbox("Landline"));
    expect(screen.getByRole("button", { name: "Import 1 selected" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));
    expect(checkbox("Mobile").checked).toBe(true);
    expect(checkbox("Landline").checked).toBe(true);
    expect(screen.getByRole("button", { name: "Import 2 selected" })).toBeTruthy();
  });
});

/* ------------------------------------------------------------------ AI score (Data Quality's), nothing saved */

const AI_INFO = { available: true, provider: "groq", label: "Groq", model: "llama-3.1-8b-instant", reason: null, minGapMs: 0, maxFailures: 5, batchSize: 5, liveCalls: false };
const aiOk = (rows: { ruleScore: number | null }[]) => ({
  results: rows.map((r) => ({ aiState: "DONE", aiScore: 90, aiNotes: null, score: Math.round(((r.ruleScore ?? 0) + 90) / 2), tier: "HIGH_PRIORITY" })),
});
const aiCalls = () => vi.mocked(api).mock.calls.filter(([p]) => p === "/api/import-filter/ai-score").map(([, o]) => (o as { json: { rows: Record<string, unknown>[] } }).json.rows);
async function openWhatsAppStep() {
  wrap(<WhatsAppContactsPage />);
  await screen.findByText("Import file");
  pick(fileInput(".csv,.xlsx"), new File(["x"], "contacts.xlsx"));
  return screen.findByRole("button", { name: /^Import \d+ selected$/ });
}
const disabled = (el: HTMLElement) => (el as HTMLInputElement | HTMLButtonElement).disabled;

describe("AI score in the filter view (Data Quality's, nothing saved)", () => {
  it("while scoring: 'X of Y scored'; score filters and review by score wait; phone type and status don't", async () => {
    state.flag = true;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    state.ai = { info: AI_INFO, score: async (rows) => (await gate, aiOk(rows)) };
    await openWhatsAppStep();
    expect(await screen.findByText("0 of 3 scored")).toBeTruthy(); // the 3 valid rows, as on Data Quality

    expect(disabled(screen.getByRole("spinbutton", { name: "Minimum score" }))).toBe(true);
    expect(disabled(screen.getByRole("button", { name: /^Approve \d+$/ }))).toBe(true);
    expect(disabled(screen.getByRole("button", { name: /^Reject \d+ below$/ }))).toBe(true);
    expect(disabled(screen.getByRole("checkbox", { name: /Only show rows scoring/ }))).toBe(true);
    expect(disabled(screen.getByRole("spinbutton", { name: "Score from" }))).toBe(true);
    expect(disabled(screen.getByRole("spinbutton", { name: "Score to" }))).toBe(true);
    expect(disabled(checkbox("High priority (85+)"))).toBe(true);
    expect(screen.getByText("Score filters and review by score open once AI scoring finishes.")).toBeTruthy();
    // Still usable meanwhile.
    expect(disabled(checkbox("Landline"))).toBe(false);
    expect(disabled(checkbox("Valid"))).toBe(false);
    expect(disabled(screen.getByRole("textbox", { name: "Business name contains" }))).toBe(false);
    expect(screen.getAllByText(/rules 100 · AI …/).length).toBeGreaterThan(0);

    // Only the name, the business name and the rules score are sent; never the phone or the email.
    expect(Object.keys(aiCalls()[0]![0]!).sort()).toEqual(["business", "name", "ruleScore"]);
    expect(aiCalls()[0]!.map((r) => r.name)).toEqual(["Ravi", "Chennai", "முருகன்"]);

    release();
    expect(await screen.findByText("Scored 3 of 3")).toBeTruthy();
    expect(disabled(screen.getByRole("spinbutton", { name: "Minimum score" }))).toBe(false);
    expect(disabled(checkbox("High priority (85+)"))).toBe(false);
    expect(screen.getAllByText(/rules 100 · AI 90/).length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: "Approve 3" })).toBeTruthy(); // overall scores 95, 85, 95
    expect(posted("/api/whatsapp/contacts/import")).toEqual([]); // nothing saved by scoring
  });

  it("the service is not available: says so; only the standard checks; nothing is locked", async () => {
    state.flag = true;
    state.ai = { info: { ...AI_INFO, provider: "ollama", label: "Ollama", available: false, reason: 'model "qwen2.5:3b" is not pulled' } };
    await openWhatsAppStep();
    expect(await screen.findByText('Ollama not available: model "qwen2.5:3b" is not pulled. Only the standard checks run.')).toBeTruthy();
    expect(disabled(screen.getByRole("spinbutton", { name: "Minimum score" }))).toBe(false);
    expect(screen.queryAllByText(/AI …/)).toEqual([]);
    expect(aiCalls()).toEqual([]);
  });

  it("too many failed rows stop the scoring (the service's limit); those rows keep the rules score", async () => {
    state.flag = true;
    state.ai = { info: { ...AI_INFO, maxFailures: 2 }, score: (rows) => ({ results: rows.map(() => ({ aiState: "ERROR", aiScore: null, aiNotes: "Groq 500: upstream", score: 100, tier: "HIGH_PRIORITY" })) }) };
    await openWhatsAppStep();
    expect(await screen.findByText("AI scoring stopped after 2 failed rows: Groq 500: upstream. Rows not scored keep the rules score.")).toBeTruthy();
    expect(screen.getAllByText("AI: Groq 500: upstream").length).toBe(2); // the 2 valid mobiles shown (Mobile only)
    expect(disabled(screen.getByRole("spinbutton", { name: "Minimum score" }))).toBe(false);
  });

  it("rate limited: waits, then sends the rows not scored yet", async () => {
    state.flag = true;
    let call = 0;
    state.ai = {
      info: AI_INFO,
      score: (rows) =>
        ++call === 1 ? { results: aiOk(rows.slice(0, 1)).results, wait: { ms: 10, reason: "Waiting: Groq rate limit, trying again shortly" } } : aiOk(rows),
    };
    await openWhatsAppStep();
    expect(await screen.findByText("Scored 3 of 3")).toBeTruthy();
    expect(aiCalls().map((rows) => rows.length)).toEqual([3, 2]);
  });

  it("Voicecall: the same AI score, on the valid rows of this list", async () => {
    state.flag = true;
    state.ai = { info: AI_INFO, score: aiOk };
    await openVoicecallMapping("ta");
    expect(await screen.findByText("Scored 3 of 3")).toBeTruthy();
    expect(aiCalls()[0]!.map((r) => r.name)).toEqual(["Ravi", "Chennai Office", "Abroad"]);
  });
});

describe("Row checkboxes behave as on Data Quality", () => {
  it("changing what is shown resets them (Data Quality unpicks every row; here every row is ticked again)", async () => {
    state.flag = true;
    await openWhatsAppStep();
    fireEvent.click(checkbox("Select row 2"));
    expect(screen.getByRole("button", { name: "Import 2 selected" })).toBeTruthy();
    fireEvent.click(checkbox("Landline")); // a filter change
    expect(screen.getByRole("button", { name: "Import 3 selected" })).toBeTruthy();
    fireEvent.click(checkbox("Select all rows shown"));
    expect(screen.getByRole("button", { name: "Import 0 selected" })).toBeTruthy();
    fireEvent.click(screen.getByRole("tab", { name: /Valid \(/ })); // a tab change
    expect(screen.getByRole("button", { name: "Import 2 selected" })).toBeTruthy();
  });
});
