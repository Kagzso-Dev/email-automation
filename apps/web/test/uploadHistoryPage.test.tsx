import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { ToastProvider } from "../src/components/toast";
import { NAV_GROUPS, withUploadHistory } from "../src/components/Layout";
import { api, apiResponse } from "../src/lib/api";
import { navForRole } from "../src/lib/navAccess";
import { describeFilters, type UploadHistoryItem } from "../src/lib/uploadHistory";
import { UploadHistoryPage } from "../src/pages/UploadHistory";

// Upload History page (ENABLE_IMPORT_FILTER_STEP): read-only list, newest first, search, pages, detail with the
// counts, the filters and exclusion options, and the excluded rows download. Flag off: page and menu item hidden.

const state = vi.hoisted(() => ({ flag: true }));

const item = (over: Partial<UploadHistoryItem>): UploadHistoryItem => ({
  id: "uh-1",
  fileName: "Chennai Leads.xlsx",
  channel: "whatsapp",
  language: null,
  uploadedByEmail: "editor@kagzso.test",
  totalRows: 10,
  imported: 4,
  excludedUsed: 3,
  filteredOut: 1,
  duplicates: 1,
  failed: 1,
  skippedOverLimit: 0,
  filters: { filters: { phoneType: ["mobile"] }, languages: ["ta", "en", "indic", "unknown"], exclude: ["contacts", "sent", "called"], tab: "ALL", minScore: null, approved: 0, rejected: 0, unticked: 0 },
  result: {},
  excludedRows: 3,
  excludedExpiresAt: "2026-12-17T09:00:00Z",
  excludedPurgedAt: null,
  excludedAvailable: true,
  createdAt: "2026-11-17T09:00:00Z",
  ...over,
});
const ITEMS = [
  item({}),
  item({ id: "uh-2", fileName: "tamil-list.csv", channel: "voicecall", language: "ta", excludedAvailable: false, excludedPurgedAt: "2026-11-01T00:00:00Z", createdAt: "2026-10-01T09:00:00Z" }),
];

vi.mock("../src/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/api")>()),
  api: vi.fn(async (path: string) => {
    if (path === "/api/import-filter/config") return { enabled: state.flag, maxRows: 1000 };
    if (path.startsWith("/api/upload-history?")) {
      const q = new URLSearchParams(path.split("?")[1]);
      const hits = ITEMS.filter((i) => !q.get("search") || i.fileName.toLowerCase().includes(q.get("search")!.toLowerCase()));
      return { items: hits, total: q.get("search") ? hits.length : 60, page: Number(q.get("page")), pageSize: 25 };
    }
    const id = /^\/api\/upload-history\/([^/]+)$/.exec(path)?.[1];
    if (id) return ITEMS.find((i) => i.id === id);
    return {};
  }),
  apiResponse: vi.fn(async () => ({
    ok: true,
    blob: async () => new Blob(["phone\r\n"]),
    headers: { get: () => 'attachment; filename="Chennai Leads-excluded.csv"' },
  })),
}));

function renderPage() {
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <ToastProvider>
        <MemoryRouter>
          <UploadHistoryPage />
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}
const listCalls = () => vi.mocked(api).mock.calls.map(([p]) => p).filter((p) => p.startsWith("/api/upload-history?"));

beforeEach(() => {
  state.flag = true;
  vi.mocked(api).mockClear();
  vi.mocked(apiResponse).mockClear();
});
afterEach(cleanup);

describe("menu item", () => {
  it("flag off: the menu is exactly as before", () => {
    expect(withUploadHistory(NAV_GROUPS, false)).toBe(NAV_GROUPS);
  });
  it("flag on: right after Send Queue, for admins and editors", () => {
    for (const role of ["ADMIN", "EDITOR"]) {
      const system = navForRole(withUploadHistory(NAV_GROUPS, true), role).find((g) => g.label === "System")!;
      const paths = system.items.map((i) => i.to);
      expect(paths.slice(0, 2)).toEqual(["/send-queue", "/upload-history"]);
    }
  });
});

describe("Upload History page", () => {
  it("flag off: not available, and the history is never asked for", async () => {
    state.flag = false;
    renderPage();
    expect(await screen.findByText("Not available")).toBeTruthy();
    expect(listCalls()).toEqual([]);
  });

  it("lists uploads newest first with every column; pages; searches by file name", async () => {
    renderPage();
    await screen.findByText("Chennai Leads.xlsx");
    for (const h of ["File name", "Uploaded at", "Uploaded by", "Channel / page", "Total rows", "Imported", "Excluded (already used)", "Filtered out", "Duplicates", "Failed", "Filters used"]) {
      expect(screen.getByRole("columnheader", { name: h })).toBeTruthy();
    }
    const first = screen.getByText("Chennai Leads.xlsx").closest("tr")!;
    expect(within(first).getByText("WhatsApp Contacts")).toBeTruthy();
    expect(within(first).getByText("editor@kagzso.test")).toBeTruthy();
    expect(within(first).getByText(/Exclude already used: all three · Phone type: Mobile/)).toBeTruthy();
    expect(within(screen.getByText("tamil-list.csv").closest("tr")!).getByText("Voicecall Contact · Tamil")).toBeTruthy();
    expect(listCalls()[0]).toBe("/api/upload-history?page=1&pageSize=25");

    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    await waitFor(() => expect(listCalls()).toContain("/api/upload-history?page=2&pageSize=25"));

    fireEvent.change(screen.getByLabelText("Search file name"), { target: { value: "tamil" } });
    await waitFor(() => expect(listCalls()).toContain("/api/upload-history?page=1&pageSize=25&search=tamil"));
    await waitFor(() => expect(screen.queryByText("Chennai Leads.xlsx")).toBeNull());
  });

  it("row click: counts, filters and exclusion options, and the excluded rows download", async () => {
    renderPage();
    fireEvent.click(await screen.findByText("Chennai Leads.xlsx"));
    const counts = await screen.findByLabelText("Upload counts");
    const value = (label: string) => within(counts).getByText(label).nextSibling?.textContent;
    expect([value("Total rows"), value("Imported"), value("Excluded (already used)"), value("Filtered out"), value("Duplicates"), value("Failed")]).toEqual([
      "10", "4", "3", "1", "1", "1",
    ]);
    expect(screen.getByText("Exclude already used: all three")).toBeTruthy();
    Object.assign(URL, { createObjectURL: vi.fn(() => "blob:x"), revokeObjectURL: vi.fn() });
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    fireEvent.click(screen.getByRole("button", { name: "Download excluded rows" }));
    await waitFor(() => expect(click).toHaveBeenCalledTimes(1));
    expect(vi.mocked(apiResponse)).toHaveBeenCalledWith("/api/upload-history/uh-1/excluded");
    click.mockRestore();
  });

  it("after 30 days: the download is off and says why; the counts stay", async () => {
    renderPage();
    fireEvent.click(await screen.findByText("tamil-list.csv"));
    expect(await screen.findByText("The 3 excluded rows were deleted after 30 days.")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Download excluded rows" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByLabelText("Upload counts")).toBeTruthy();
  });
});

describe("filters used, as text", () => {
  it("names each filter and option", () => {
    expect(
      describeFilters({
        filters: { phoneType: ["mobile", "landline"], status: ["VALID"], scoreMin: 50 },
        languages: ["ta"],
        exclude: ["sent"],
        tab: "VALID",
        minScore: 70,
        approved: 2,
        rejected: 1,
        unticked: 3,
      }),
    ).toEqual([
      "Exclude already used: Already sent to (WhatsApp sends / email logs / Send Queue history)",
      "Phone type: Mobile, Landline",
      "Language: Tamil",
      "Check status: Valid",
      "Score 50–100",
      "Only rows scoring 70+",
      "Tab: valid",
      "Approved 2, rejected 1",
      "3 rows unticked by hand",
    ]);
    expect(describeFilters({ exclude: [] })[0]).toBe("Exclude already used: none");
  });
});
