import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { ConfirmProvider } from "../src/components/confirm";
import { ToastProvider } from "../src/components/toast";
import { api, ApiError } from "../src/lib/api";
import { AiCallLanguageProvider } from "../src/lib/aiCallLanguage";
import type { DraftCheck, UsedInfo, UsedOption } from "../src/lib/importFilter";
import { WhatsAppContactsPage } from "../src/pages/WhatsAppContacts";
import { AiCallCustomersPanel } from "../src/components/AiCallCustomersPanel";
import type { AiCallsConfig } from "../src/lib/aiCalls";

// Import filter step → "Exclude already used data" (all three ticked by default) and Upload History.
// Ticked: matching rows are shown with the reason, can't be selected and never reach the importer.
// Unticked: they go to the importer like any other row. History is written only after the importer answered.
// lib/api is mocked and records every call.

const state = vi.hoisted(() => ({ importFails: false, historyFails: false }));

vi.mock("../src/lib/auth", () => ({
  useAuth: () => ({ user: { role: "EDITOR", email: "e@example.com" }, loading: false, logout: () => undefined }),
}));

const readFile = (f: Blob) =>
  new Promise<string>((resolve) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.readAsText(f);
  });

/* ------------------------------------------------------------------ fixtures: 5 rows, 4 of them already used */

const NONE: UsedInfo = { inContacts: null, sent: null, called: null };
const USED: UsedInfo[] = [
  NONE, // 0 fresh
  { ...NONE, inContacts: { at: "2026-10-03T09:00:00Z" } }, // 1 already in contacts
  { ...NONE, sent: { at: "2026-11-12T10:00:00Z", via: ["whatsapp"] } }, // 2 already sent
  { ...NONE, called: { at: "2026-11-10T10:00:00Z", reason: "called" } }, // 3 already called
  { ...NONE, called: { at: null, reason: "do_not_call" } }, // 4 do not call
];
const NAMES = ["Fresh", "Saved", "Sent", "Called", "Dnc"];
/** Which rows each option covers. */
const BY_OPTION: Record<UsedOption, number[]> = { contacts: [1], sent: [2], called: [3, 4] };
const REASONS = ["Already in WhatsApp Contacts (added 3 Oct 2026)", "Already sent 12 Nov 2026 (WhatsApp)", "Already called 10 Nov 2026", "Do not call"];

const check = (i: number): DraftCheck => ({
  rowIndex: i,
  name: NAMES[i]!,
  phoneRaw: `98765001${i}0`,
  phone: `+9198765001${i}0`,
  businessName: `${NAMES[i]} Stores`,
  email: null,
  status: i === 4 ? "EXCLUDED" : "VALID",
  excludedReason: i === 4 ? "do_not_call" : null,
  issues: [],
  flags: [],
  ruleScore: i === 4 ? null : 100,
  score: i === 4 ? null : 100,
  phoneType: "mobile",
  tier: i === 4 ? null : "HIGH_PRIORITY",
  used: USED[i]!,
});

const WA_HEADERS = ["phone", "first name"];
const WA_ROWS = NAMES.map((name, i) => ({ phone: `98765001${i}0`, "first name": name }));
const WA_PREVIEW = {
  filename: "contacts.xlsx",
  headers: WA_HEADERS,
  rows: WA_ROWS,
  totalRows: 5,
  maxRows: 1000,
  truncated: false,
  checks: NAMES.map((_, i) => ({ ...check(i), importable: true, importProblem: null, alreadySaved: i === 1 })),
};
const VC_SHEET = {
  headers: ["customer_name", "phone"],
  rows: NAMES.map((name, i) => ({ customer_name: name, phone: `98765001${i}0` })),
  truncated: false,
  totalRows: 5,
  maxRows: 1000,
  mapping: { customer_name: "customer_name", gender: null, phone: "phone", business_name: null, follow_up_detail: null, email: null, whatsapp_opt_in: null },
};

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
  languages: [{ code: "en", name: "English", configured: true, enabled: true }],
};

vi.mock("../src/lib/api", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/lib/api")>();
  return {
    ...real,
    api: vi.fn(async (path: string, opts: { method?: string; body?: unknown; json?: { rows?: unknown[] } } = {}) => {
      const method = opts.method ?? "GET";
      if (path === "/api/import-filter/config") return { enabled: true, maxRows: 1000 };
      if (path === "/api/import-filter/whatsapp/preview") return WA_PREVIEW;
      if (path === "/api/import-filter/voicecall/check") return { checks: NAMES.map((_, i) => check(i)) };
      if (path === "/api/whatsapp/contacts/import") {
        if (state.importFails) throw new real.ApiError(500, "Import failed");
        const text = await readFile((opts.body as FormData).get("file") as File);
        const sent = text.trim().split(/\r\n/).length - 1;
        return { created: sent, updated: 0, duplicates: 0, failed: 0 };
      }
      if (path.startsWith("/api/whatsapp/contacts")) return { items: [], total: 0, page: 1, pageSize: 25 };
      if (path === "/api/whatsapp/config") return { configured: false };
      if (path === "/api/ai-call-customers/parse") return VC_SHEET;
      if (path.startsWith("/api/ai-call-customers/import")) {
        if (state.importFails) throw new real.ApiError(500, "Import failed");
        return { imported: opts.json!.rows!.length, skipped: 0, duplicates: 0, doNotCall: 0, problems: [] };
      }
      if (path.startsWith("/api/ai-call-customers") && method === "GET") return { items: [], total: 0, page: 1, pageSize: 25 };
      if (path === "/api/ai-calls/config") return AI_CONFIG;
      if (path === "/api/upload-history" && method === "POST") {
        if (state.historyFails) throw new real.ApiError(503, "needs migration");
        return { id: "uh-1" };
      }
      return { items: [] };
    }),
  };
});

/* ------------------------------------------------------------------ helpers */

function renderPage(channel: "whatsapp" | "voicecall") {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <ToastProvider>
        <ConfirmProvider>
          <MemoryRouter>
            <AiCallLanguageProvider language="en">{channel === "whatsapp" ? <WhatsAppContactsPage /> : <AiCallCustomersPanel config={AI_CONFIG} />}</AiCallLanguageProvider>
          </MemoryRouter>
        </ConfirmProvider>
      </ToastProvider>
    </QueryClientProvider>,
  );
}
const fileInput = (accept: string) => document.querySelector(`input[type="file"][accept="${accept}"]`) as HTMLInputElement;
const pick = (input: HTMLInputElement, file: File) => fireEvent.change(input, { target: { files: [file] } });
const checkbox = (name: string) => screen.getByRole("checkbox", { name }) as HTMLInputElement;
const LABEL: Record<UsedOption, string> = {
  contacts: "Already in contacts (this channel)",
  sent: "Already sent to (WhatsApp sends / email logs / Send Queue history)",
  called: "Already called (call logs, do-not-call)",
};
const posts = (path: string) => vi.mocked(api).mock.calls.filter(([p, o]) => p.startsWith(path) && (o as { method?: string } | undefined)?.method === "POST");
const settle = () => new Promise((r) => setTimeout(r, 30));

/** Open the filter step on a page; returns the "Import N selected" button. */
async function openStep(channel: "whatsapp" | "voicecall") {
  renderPage(channel);
  if (channel === "whatsapp") {
    await screen.findByText("Import file");
    pick(fileInput(".csv,.xlsx"), new File(["x"], "contacts.xlsx"));
  } else {
    fireEvent.click(await screen.findByRole("button", { name: "Import file" }));
    pick(fileInput(".xlsx,.csv"), new File(["x"], "customers.xlsx"));
    // Flag on: the columns are matched automatically and the filter step opens straight away.
  }
  return screen.findByRole("button", { name: /^Import \d+ selected$/ });
}

/** The names that reached the importer. */
async function importedNames(channel: "whatsapp" | "voicecall"): Promise<string[]> {
  if (channel === "whatsapp") {
    await waitFor(() => expect(posts("/api/whatsapp/contacts/import")).toHaveLength(1));
    const text = await readFile((posts("/api/whatsapp/contacts/import")[0]![1] as { body: FormData }).body.get("file") as File);
    return text.trim().split(/\r\n/).slice(1).map((l) => l.split(",")[1]!);
  }
  await waitFor(() => expect(posts("/api/ai-call-customers/import")).toHaveLength(1));
  return ((posts("/api/ai-call-customers/import")[0]![1] as { json: { rows: { customerName: string }[] } }).json.rows).map((r) => r.customerName);
}

async function historySent(): Promise<{ summary: Record<string, any>; csv: string | null }> {
  await waitFor(() => expect(posts("/api/upload-history")).toHaveLength(1));
  const fd = (posts("/api/upload-history")[0]![1] as { body: FormData }).body;
  const file = fd.get("excluded") as File | null;
  return { summary: JSON.parse(String(fd.get("summary"))), csv: file ? await readFile(file) : null };
}

beforeEach(() => {
  state.importFails = false;
  state.historyFails = false;
  vi.mocked(api).mockClear();
});
afterEach(cleanup);

/* ------------------------------------------------------------------ the three options, per channel */

for (const channel of ["whatsapp", "voicecall"] as const) {
  describe(`${channel}: Exclude already used data`, () => {
    it("all three are ticked by default; excluded rows stay visible with their reason, without a checkbox", async () => {
      const importBtn = await openStep(channel);
      for (const o of ["contacts", "sent", "called"] as const) expect(checkbox(LABEL[o]).checked).toBe(true);
      expect(importBtn.textContent).toBe("Import 1 selected");
      expect(screen.getByText("Showing 5 of 5, 4 excluded as already used")).toBeTruthy();
      const reasons = channel === "whatsapp" ? REASONS : [REASONS[0]!.replace("WhatsApp Contacts", "this Voicecall list"), ...REASONS.slice(1)];
      // In the "Already used" column ("Do not call" is also the row's Data Quality check badge).
      for (const r of reasons) expect(screen.getAllByText(r).some((el) => el.closest("td")?.className.includes("text-warn"))).toBe(true);
      for (const row of [3, 4, 5, 6]) expect(screen.queryByRole("checkbox", { name: `Select row ${row}` })).toBeNull(); // rows 1-4 (spreadsheet 3-6)
      expect(screen.getByRole("checkbox", { name: "Select row 2" })).toBeTruthy();
      expect(!!screen.queryByText(/numbers already saved in WhatsApp Contacts are excluded by default/)).toBe(channel === "whatsapp");
    });

    for (const option of ["contacts", "sent", "called"] as const) {
      const names = BY_OPTION[option].map((i) => NAMES[i]!);
      it(`"${option}" ticked: ${names.join(", ")} never reach the importer`, async () => {
        const btn = await openStep(channel);
        fireEvent.click(btn);
        expect(await importedNames(channel)).toEqual(["Fresh"]);
      });
      it(`"${option}" unticked: ${names.join(", ")} are imported`, async () => {
        await openStep(channel);
        fireEvent.click(checkbox(LABEL[option]));
        const btn = screen.getByRole("button", { name: `Import ${1 + names.length} selected` });
        fireEvent.click(btn);
        expect(await importedNames(channel)).toEqual(["Fresh", ...names]);
      });
    }

    it("history is written once, after the import, with the counts and the excluded rows", async () => {
      await openStep(channel);
      expect(posts("/api/upload-history")).toEqual([]); // nothing before the confirm
      fireEvent.click(screen.getByRole("button", { name: "Import 1 selected" }));
      const { summary, csv } = await historySent();
      expect(summary).toMatchObject({
        fileName: channel === "whatsapp" ? "contacts.xlsx" : "customers.xlsx",
        channel,
        language: channel === "whatsapp" ? null : "en",
        totalRows: 5,
        imported: 1,
        excludedUsed: 4,
        filteredOut: 0,
        duplicates: 0,
        failed: 0,
        excludedRows: 4,
        filters: { exclude: ["contacts", "sent", "called"], filters: { phoneType: channel === "whatsapp" ? ["mobile"] : ["mobile", "landline"] } },
      });
      expect(csv!.split("\r\n")[0]).toBe(channel === "whatsapp" ? "phone,first name,Excluded because" : "customer_name,phone,Excluded because");
      expect(csv!.trim().split("\r\n")).toHaveLength(5); // header + 4 excluded rows
      expect(await screen.findByText("Saved to Upload History.")).toBeTruthy();
      expect(within(await screen.findByLabelText("Import summary")).getByText("Excluded (already used)")).toBeTruthy();
    });
  });
}

/* ------------------------------------------------------------------ history: only on confirm, never blocking */

describe("Upload History is written only on a successful confirm", () => {
  it("a row unticked by hand counts as filtered out", async () => {
    await openStep("whatsapp");
    fireEvent.click(checkbox(LABEL.contacts)); // Saved becomes importable
    fireEvent.click(checkbox("Select row 3")); // …and is unticked by hand
    fireEvent.click(screen.getByRole("button", { name: "Import 1 selected" }));
    const { summary } = await historySent();
    expect(summary).toMatchObject({ imported: 1, excludedUsed: 3, filteredOut: 1, excludedRows: 3, filters: { exclude: ["sent", "called"], unticked: 1 } });
  });

  it("Back writes nothing", async () => {
    await openStep("voicecall");
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    await screen.findByRole("button", { name: "Choose file" });
    await settle();
    expect(posts("/api/upload-history")).toEqual([]);
    expect(posts("/api/ai-call-customers/import")).toEqual([]);
  });

  it("a failed import writes nothing", async () => {
    state.importFails = true;
    await openStep("whatsapp");
    fireEvent.click(screen.getByRole("button", { name: "Import 1 selected" }));
    expect(await screen.findByText("Import failed")).toBeTruthy();
    await settle();
    expect(posts("/api/upload-history")).toEqual([]);
  });

  it("history unavailable (migration 0037 not applied): the import stands, with a warning", async () => {
    state.historyFails = true;
    await openStep("whatsapp");
    fireEvent.click(screen.getByRole("button", { name: "Import 1 selected" }));
    expect(await screen.findByText(/Imported, but this upload couldn't be added to Upload History: the database update \(migration 0037\) isn't applied yet/)).toBeTruthy();
    expect(await screen.findByLabelText("Import summary")).toBeTruthy();
    expect(posts("/api/whatsapp/contacts/import")).toHaveLength(1);
  });
});

describe("Download excluded rows", () => {
  it("saves the excluded rows with their reason (nothing is uploaded)", async () => {
    const blobs: Blob[] = [];
    const create = vi.fn((b: Blob) => (blobs.push(b), "blob:excluded"));
    Object.assign(URL, { createObjectURL: create, revokeObjectURL: vi.fn() });
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    await openStep("whatsapp");
    vi.mocked(api).mockClear();
    fireEvent.click(screen.getByRole("button", { name: "Download excluded rows (4)" }));
    expect(click).toHaveBeenCalledTimes(1);
    // A UTF-8 BOM first (Excel), then the CSV (the text reader drops the BOM).
    const bytes = await new Promise<Uint8Array>((resolve) => {
      const r = new FileReader();
      r.onload = () => resolve(new Uint8Array(r.result as ArrayBuffer));
      r.readAsArrayBuffer(blobs[0]!);
    });
    expect([...bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    const text = await readFile(blobs[0]!);
    expect(text.split("\r\n")).toEqual([
      "phone,first name,Excluded because",
      `9876500110,Saved,${REASONS[0]}`,
      `9876500120,Sent,${REASONS[1]}`,
      `9876500130,Called,${REASONS[2]}`,
      `9876500140,Dnc,${REASONS[3]}`,
      "",
    ]);
    expect(vi.mocked(api)).not.toHaveBeenCalled();
    click.mockRestore();
  });
});

void ApiError; // (imported for the mock's type)
