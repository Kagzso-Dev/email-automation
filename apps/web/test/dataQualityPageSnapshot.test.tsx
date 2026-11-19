import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { ConfirmProvider } from "../src/components/confirm";
import { ToastProvider } from "../src/components/toast";
import { DataQualityPage } from "../src/pages/DataQuality";
import type { DqFacets, DqJob, DqRecord } from "../src/lib/dataQuality";

// The Data Quality page, exactly as it renders. Written BEFORE the score bar and the row table were moved
// into shared components (used by the import filter step too): the snapshots must stay identical, so the
// Data Quality page itself does not change. Never update these snapshots to make a refactor pass.

const job = (over: Partial<DqJob>): DqJob => ({
  id: "j1",
  filename: "clients.xlsx",
  status: "DONE",
  mapping: { name: "contact_name", phone: "phone", business: "business_name", email: "email" },
  total: 6,
  valid: 3,
  invalid: 1,
  duplicates: 1,
  excluded: 1,
  aiStatus: "done",
  aiModel: "qwen2.5:3b (Ollama)",
  aiDone: 3,
  aiFailures: 1,
  note: null,
  waitingReason: null,
  createdByEmail: "admin@example.com",
  createdAt: "2026-11-18T10:00:00.000Z",
  finishedAt: "2026-11-18T10:05:00.000Z",
  ...over,
});

const rec = (rowIndex: number, over: Partial<DqRecord>): DqRecord => ({
  id: `r${rowIndex}`,
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
  ruleScore: null,
  aiState: "NONE",
  aiScore: null,
  aiNotes: null,
  review: "PENDING",
  score: null,
  ...over,
});

const DONE_RECORDS: DqRecord[] = [
  rec(0, { name: "Ravi Kumar", phoneRaw: "9876500101", phone: "+919876500101", businessName: "Ravi Traders", email: "ravi@example.com", ruleScore: 85, aiState: "DONE", aiScore: 95, score: 90 }),
  rec(1, { name: "Priya", phoneRaw: "044 2345 6789", phone: "+914423456789", businessName: "Priya Boutique", issues: ["not_mobile"], ruleScore: 65, aiState: "DONE", aiScore: 70, score: 68, review: "APPROVED" }),
  rec(2, { name: "Test", phoneRaw: "9876500103", phone: "+919876500103", businessName: null, issues: ["missing_business", "suspicious_name"], flags: ["in_whatsapp"], ruleScore: 40, aiState: "ERROR", aiNotes: "timed out", score: 40, review: "REJECTED" }),
  rec(3, { name: "No Number", phoneRaw: "12", issues: ["bad_phone"], status: "INVALID" }),
  rec(4, { name: "Ravi K", phoneRaw: "98765 00101", phone: "+919876500101", businessName: "Ravi Traders", status: "DUPLICATE", issues: ["duplicate_of_row_2"] }),
  rec(5, { name: "Dinesh", phoneRaw: "9876500105", phone: "+919876500105", businessName: "Dinesh Hardware", status: "EXCLUDED", excludedReason: "do_not_call" }),
];
const RUNNING_RECORDS: DqRecord[] = [
  rec(0, { id: "q0", name: "Anitha", phoneRaw: "9876500201", phone: "+919876500201", businessName: "Anitha Beauty Parlour", ruleScore: 80, aiState: "DONE", aiScore: 60, score: 70 }),
  rec(1, { id: "q1", name: "Murugan", phoneRaw: "9876500202", phone: "+919876500202", businessName: "Murugan Stores", ruleScore: 90, aiState: "PENDING", score: 90 }),
];
const FACETS: DqFacets = {
  headers: ["contact_name", "phone", "business_name", "email", "city", "industry", "source", "first_seen"],
  columns: { city: "city", state: null, district: null, pincode: null, category: "industry", source: "source", dateAdded: "first_seen" },
  values: {
    city: [{ value: "Chennai", count: 4 }, { value: "Madurai", count: 2 }],
    category: [{ value: "Retail", count: 5 }, { value: "IT", count: 1 }],
    source: [{ value: "Maps", count: 6 }],
    dateAdded: [{ value: "2026-11-01", count: 6 }],
  },
};
const JOBS = [job({}), job({ id: "j2", filename: "running.csv", status: "RUNNING", total: 2, valid: 2, invalid: 0, duplicates: 0, excluded: 0, aiStatus: "pending", aiDone: 1, aiFailures: 0, waitingReason: "Waiting: Ollama rate limit, trying again shortly", finishedAt: null })];

vi.mock("../src/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/api")>()),
  api: vi.fn(async (path: string) => {
    if (path === "/api/data-quality/status") return { ai: { provider: "ollama", configured: true, available: true, model: "qwen2.5:3b", reason: null }, liveCalls: false };
    if (path === "/api/data-quality/jobs") return { items: JOBS };
    if (path.endsWith("/facets")) return FACETS;
    if (path.startsWith("/api/data-quality/jobs/j1")) return { job: JOBS[0], records: DONE_RECORDS };
    if (path.startsWith("/api/data-quality/jobs/j2")) return { job: JOBS[1], records: RUNNING_RECORDS };
    return {};
  }),
}));

function renderPage() {
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <ToastProvider>
        <ConfirmProvider>
          <MemoryRouter>
            <DataQualityPage />
          </MemoryRouter>
        </ConfirmProvider>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

afterEach(cleanup);

describe("Data Quality page: unchanged by the shared score bar and table", () => {
  it("a finished job: score bar, filter panel, tabs and table", async () => {
    const { container } = renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "clients.xlsx" }));
    await screen.findByRole("checkbox", { name: "Select row 2" });
    await screen.findByRole("combobox", { name: "City" });
    expect(container.innerHTML).toMatchSnapshot("done job");

    // Picking rows, "Only show rows scoring 70+", a tab: the same controls in another state.
    fireEvent.click(screen.getByRole("checkbox", { name: "Select row 2" }));
    expect(container.innerHTML).toMatchSnapshot("one row picked");
    fireEvent.click(screen.getByRole("checkbox", { name: "Select all valid rows shown" }));
    expect(container.innerHTML).toMatchSnapshot("all picked");
    fireEvent.click(screen.getByRole("checkbox", { name: /Only show rows scoring/ }));
    expect(container.innerHTML).toMatchSnapshot("above 70 only");
    fireEvent.click(screen.getByRole("tab", { name: /Valid \(/ }));
    expect(container.innerHTML).toMatchSnapshot("valid tab");
  });

  it("a job still waiting for AI scores: review by score is locked, the AI column shows …", async () => {
    const { container } = renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "running.csv" }));
    await screen.findByRole("checkbox", { name: "Select row 3" });
    expect(container.innerHTML).toMatchSnapshot("running job");
  });
});
