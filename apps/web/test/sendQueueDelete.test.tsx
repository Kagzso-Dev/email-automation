import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { SendQueuePage } from "../src/pages/SendQueue";
import { AiCallFollowupsQueue } from "../src/components/AiCallFollowupsQueue";
import { ConfirmProvider } from "../src/components/confirm";
import { ToastProvider } from "../src/components/toast";

// Send Queue: the Delete button on each row (Email, WhatsApp, AI Call follow-ups). Canned API, no network.

const calls: { path: string; method: string }[] = [];
const deleted = new Set<string>();

const batch = (id: string, status: string, total = 3) => ({
  id, templateName: "Welcome", total, status, sent: total, failed: 0, purgeAfter: false,
  startedAt: "2026-11-10T08:00:00Z", completedAt: status === "RUNNING" ? null : "2026-11-10T08:05:00Z",
});
const followup = (id: string, name: string, over: Record<string, unknown>) => ({
  id, customerId: `c_${id}`, channel: "WHATSAPP", status: "REJECTED", reason: "Interested", whatsappTemplateId: null,
  whatsappTemplateName: null, scheduledAt: null, attempt: 1, note: null, error: null, createdByEmail: null,
  decidedByEmail: null, decidedAt: null, createdAt: "2026-11-10T08:00:00Z", whatsappBatchId: null, aiCallRunId: null,
  delivery: null,
  customer: { id: `c_${id}`, customerName: name, phone: "919876543210", businessName: null, stage: "INTERESTED",
    whatsappOptIn: true, deletedAt: null, doNotCall: false, language: "en" },
  ...over,
});

vi.mock("../src/lib/branding", () => ({ useBranding: () => ({ appName: "Kagzso" }) }));
vi.mock("../src/lib/api", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/lib/api")>();
  return {
    ...real,
    api: vi.fn(async (path: string, init: { method?: string } = {}) => {
      const method = init.method ?? "GET";
      calls.push({ path, method });
      if (method === "DELETE") {
        deleted.add(path.split("/").pop()!);
        return undefined;
      }
      if (path === "/api/ai-calls/config") return { enabled: false };
      if (path.startsWith("/api/send-queue/history/")) return { rows: 4 };
      if (path === "/api/contacts/send/batches") {
        return { items: [batch("emaildone1", "DONE"), batch("emailrun01", "RUNNING")].filter((b) => !deleted.has(b.id)) };
      }
      if (path === "/api/whatsapp/send/batches") return { items: [] }; // the WhatsApp tab's count badge
      if (path === "/api/hard-stop/config") return { enabled: false };
      if (path.startsWith("/api/ai-call-followups?")) {
        const items = [
          followup("f_pending", "Ragul", { status: "PENDING_APPROVAL" }),
          followup("f_rejected", "Priya", {}),
          followup("f_scheduled", "Arun", { status: "APPROVED", channel: "CALL", reason: "No answer" }),
          followup("f_called", "Meena", { status: "APPROVED", channel: "CALL", reason: "No answer", aiCallRunId: "run1" }),
        ].filter((f) => !deleted.has(f.id));
        return { items, total: items.length, pending: 1, page: 1, pageSize: 10 };
      }
      throw new Error(`unexpected API call: ${method} ${path}`);
    }),
  };
});

afterEach(() => {
  cleanup();
  calls.length = 0;
  deleted.clear();
  try {
    localStorage.clear();
  } catch {
    /* no storage */
  }
});

function wrap(ui: ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <MemoryRouter>
      <QueryClientProvider client={qc}>
        <ToastProvider>
          <ConfirmProvider>{ui}</ConfirmProvider>
        </ToastProvider>
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

const deletes = () => calls.filter((c) => c.method === "DELETE").map((c) => c.path);

describe("Send Queue → Email: Delete on each batch row", () => {
  it("asks first, deletes only that batch, and the row goes away", async () => {
    wrap(<SendQueuePage />);
    fireEvent.click(await screen.findByRole("button", { name: "Delete email batch emaildon" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByText("Delete email batch emaildon?")).toBeTruthy();
    expect(within(dialog).getByText(/3 recipients from the Send Queue/)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Delete email batch emaildon" })).toBeNull());
    expect(deletes()).toEqual(["/api/contacts/send/batches/emaildone1"]);
  });

  it("is disabled while the batch is still sending", async () => {
    wrap(<SendQueuePage />);
    const btn = (await screen.findByRole("button", { name: "Delete email batch emailrun" })) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    expect(btn.title).toMatch(/Still sending/);
  });

  it("Cancel deletes nothing", async () => {
    wrap(<SendQueuePage />);
    fireEvent.click(await screen.findByRole("button", { name: "Delete email batch emaildon" }));
    fireEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(deletes()).toEqual([]);
  });
});

describe("Send Queue → AI Call follow-ups: Delete on each decided row", () => {
  const renderQueue = () => wrap(<AiCallFollowupsQueue view={{ page: 1, pageSize: 10, status: "" }} setView={() => {}} />);

  it("pending rows keep Approve / Reject and have no Delete; a scheduled call can't be deleted yet", async () => {
    renderQueue();
    expect(await screen.findByRole("button", { name: "Delete follow-up for Priya" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Delete follow-up for Ragul" })).toBeNull();
    const scheduled = screen.getByRole("button", { name: "Delete follow-up for Arun" }) as HTMLButtonElement;
    expect(scheduled.disabled).toBe(true);
    expect(scheduled.title).toMatch(/still scheduled/);
  });

  it("warns that deleting a No answer retry frees a retry, then deletes it", async () => {
    renderQueue();
    fireEvent.click(await screen.findByRole("button", { name: "Delete follow-up for Meena" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByText(/no longer counts toward the retry limit/)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Delete follow-up for Meena" })).toBeNull());
    expect(deletes()).toEqual(["/api/ai-call-followups/f_called"]);
  });
});
