import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { HARD_STOP_CONFIRM_TEXT } from "@dispatch/shared";
import { SendQueuePage } from "../src/pages/SendQueue";
import { ConfirmProvider } from "../src/components/confirm";
import { ToastProvider } from "../src/components/toast";

// Send Queue redesign: status badges (Partial / Failed derived from the counts), search + no-match state, the
// failed-recipients panel with Retry failed, the empty state's call to action, and (Hard stop on) the "More" danger
// menu and the compact last-stop notice. Canned API, no network.

const state = vi.hoisted(() => ({ hardStop: false, role: "ADMIN", emptyEmail: false }));
const calls: { path: string; method: string }[] = [];

const batch = (id: string, templateName: string, total: number, sent: number, failed: number) => ({
  id, templateName, total, status: "DONE", sent, failed, purgeAfter: false,
  startedAt: "2026-11-18T10:02:00Z", completedAt: "2026-11-18T10:08:00Z",
});
const BATCHES = [
  batch("cmwlycug1234", "Diwali offer", 25, 1, 24), // PARTIAL
  batch("bounced00001", "Re-engage", 3, 0, 3), // FAILED
  batch("welcome00001", "Welcome", 4, 4, 0), // DONE
];
const item = (i: number, status: string, error: string | null) => ({
  id: `it${i}`, name: null, email: `person${i}@example.test`, status, error,
  sentAt: status === "SENT" ? "2026-11-18T10:03:00Z" : null, deliveredAt: null, openedAt: null,
  failedAt: status === "FAILED" ? "2026-11-18T10:04:00Z" : null,
});
const DETAIL = {
  id: "cmwlycug1234", status: "DONE", total: 25,
  counts: { PENDING: 0, SENDING: 0, SENT: 1, FAILED: 24, SKIPPED: 0 },
  items: [
    item(0, "SENT", null),
    ...Array.from({ length: 22 }, (_, i) => item(i + 1, "FAILED", "Daily sending limit exceeded")),
    item(23, "FAILED", "Mailbox unavailable"),
    item(24, "FAILED", "Mailbox unavailable"),
  ],
};
const STOP = {
  id: "stop1", scope: "EMAIL", targetId: null, status: "STOPPED", reason: "Hard stop by admin@kagzso.test",
  byEmail: "admin@kagzso.test", createdAt: "2026-11-18T10:10:00Z", finishedAt: "2026-11-18T10:11:00Z",
  inProgress: 0, inProgressAtStop: 0, completed: 2, cancelled: 5, followupsCancelled: 1,
  paused: { campaigns: [], triggers: [] }, csvRows: { email: 0, whatsapp: 0, calls: 0 },
};

vi.mock("../src/lib/branding", () => ({ useBranding: () => ({ appName: "Kagzso" }) }));
vi.mock("../src/lib/auth", () => ({ useAuth: () => ({ user: { role: state.role } }) }));
vi.mock("../src/lib/api", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/lib/api")>();
  return {
    ...real,
    api: vi.fn(async (path: string, init: { method?: string } = {}) => {
      const method = init.method ?? "GET";
      calls.push({ path, method });
      if (path === "/api/ai-calls/config") return { enabled: false };
      if (path === "/api/hard-stop/config") return { enabled: state.hardStop };
      if (path.startsWith("/api/send-queue/history/")) return { rows: 4 };
      if (path === "/api/contacts/send/batches") return { items: state.emptyEmail ? [] : BATCHES };
      if (path === "/api/contacts/send/batches/cmwlycug1234") return DETAIL;
      if (path === "/api/contacts/send/batches/cmwlycug1234/retry") return { batchId: "retry1" };
      if (path === "/api/whatsapp/send/batches") return { items: [] };
      if (path === "/api/hard-stop/latest-all") return { stop: null };
      if (path === "/api/hard-stop/latest-section?scope=EMAIL") return { stop: STOP };
      if (path === "/api/hard-stop/sections/email") return { stop: STOP, created: true };
      throw new Error(`unexpected API call: ${method} ${path}`);
    }),
  };
});

afterEach(() => {
  cleanup();
  calls.length = 0;
  Object.assign(state, { hardStop: false, role: "ADMIN", emptyEmail: false });
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

const rowOf = (text: string) => screen.getByText(text).closest("tr")!;

describe("Send Queue → batch rows", () => {
  it("derives Partial / Failed / Done from the counts and shows sent / failed over one bar", async () => {
    wrap(<SendQueuePage />);
    await screen.findByText("Diwali offer");
    expect(within(rowOf("Diwali offer")).getByText("Partial")).toBeTruthy();
    expect(rowOf("Diwali offer").textContent).toContain("1 / 25 sent");
    expect(within(rowOf("Diwali offer")).getByText("24 failed")).toBeTruthy();
    expect(within(rowOf("Re-engage")).getByText("Failed")).toBeTruthy();
    expect(within(rowOf("Welcome")).getByText("Done")).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Email 3 batches" })).toBeTruthy();
    // Hard stop off: no danger menu, no stop notice.
    expect(screen.queryByRole("button", { name: "More actions" })).toBeNull();
    expect(screen.queryByText(/Last stop:/)).toBeNull();
  });

  it("searches by template or batch ID; no match offers Clear filters", async () => {
    wrap(<SendQueuePage />);
    await screen.findByText("Diwali offer");
    const search = screen.getByLabelText("Search batches by ID or template");
    fireEvent.change(search, { target: { value: "welcome" } });
    expect(screen.queryByText("Diwali offer")).toBeNull();
    expect(screen.getByText("Welcome")).toBeTruthy();
    fireEvent.change(search, { target: { value: "cmwly" } });
    expect(screen.getByText("Diwali offer")).toBeTruthy();
    expect(screen.queryByText("Welcome")).toBeNull();
    fireEvent.change(search, { target: { value: "nothing-like-this" } });
    expect(screen.getByText("No batches match")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));
    expect(screen.getByText("Diwali offer")).toBeTruthy();
    expect(screen.getByText("Welcome")).toBeTruthy();
  });

  it("the chevron opens the failed recipients by reason; Retry failed asks, then starts the retry", async () => {
    wrap(<SendQueuePage />);
    const toggle = await screen.findByRole("button", { name: "Show recipients of batch cmwlycug" });
    fireEvent.click(toggle);
    expect(await screen.findByText("24 of 25 recipients failed")).toBeTruthy();
    const panel = screen.getByText("24 of 25 recipients failed").closest("section")!;
    expect(within(panel).getByText("Daily sending limit exceeded")).toBeTruthy();
    expect(within(panel).getByText("Mailbox unavailable")).toBeTruthy();
    expect(within(panel).getByText("22")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Hide recipients of batch cmwlycug" }).getAttribute("aria-expanded")).toBe("true");

    fireEvent.click(within(panel).getByRole("button", { name: /Retry failed/ }));
    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByText("Retry 24 failed recipients?")).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Retry failed" }));
    await waitFor(() =>
      expect(calls).toContainEqual({ path: "/api/contacts/send/batches/cmwlycug1234/retry", method: "POST" }),
    );
  });

  it("no batches yet: the empty state links to where sends start", async () => {
    state.emptyEmail = true;
    wrap(<SendQueuePage />);
    expect(await screen.findByText("No email batches yet")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Go to Contacts" }).getAttribute("href")).toBe("/contacts");
  });
});

describe("Send Queue → Hard stop on", () => {
  it("the More menu holds both stops; each asks the same confirmation, word for word", async () => {
    state.hardStop = true;
    wrap(<SendQueuePage />);
    fireEvent.click(await screen.findByRole("button", { name: "More actions" }));
    const menu = screen.getByRole("menu", { name: "Danger zone" });
    const items = within(menu).getAllByRole("menuitem");
    expect(items.map((i) => i.getAttribute("aria-labelledby") && document.getElementById(i.getAttribute("aria-labelledby")!)!.textContent)).toEqual([
      "Stop all running sends",
      "Hard stop all email",
    ]);
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Hard stop all email" }));
    expect(screen.queryByRole("menu")).toBeNull();
    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByText(HARD_STOP_CONFIRM_TEXT)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Hard stop all email" }));
    await waitFor(() => expect(calls).toContainEqual({ path: "/api/hard-stop/sections/email", method: "POST" }));
  });

  it("editors only get the section stop", async () => {
    state.hardStop = true;
    state.role = "EDITOR";
    wrap(<SendQueuePage />);
    fireEvent.click(await screen.findByRole("button", { name: "More actions" }));
    expect(within(screen.getByRole("menu")).getAllByRole("menuitem")).toHaveLength(1);
    expect(calls.some((c) => c.path === "/api/hard-stop/latest-all")).toBe(false);
  });

  it("the last stop is a compact notice with its counts, and can be dismissed", async () => {
    state.hardStop = true;
    wrap(<SendQueuePage />);
    const notice = await screen.findByRole("region", { name: "Latest hard stop" });
    expect(notice.textContent).toContain("admin@kagzso.test");
    expect(notice.textContent).toContain("2 completed");
    expect(notice.textContent).toContain("5 cancelled");
    expect(notice.textContent).toContain("1 follow-ups & retries cancelled");
    fireEvent.click(within(notice).getByRole("button", { name: "Dismiss the last stop notice" }));
    expect(screen.queryByRole("region", { name: "Latest hard stop" })).toBeNull();
  });
});
