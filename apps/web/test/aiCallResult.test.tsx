import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { noResultText, RunStatus } from "../src/components/AiCallModal";
import { ConfirmProvider } from "../src/components/confirm";
import { ToastProvider } from "../src/components/toast";
import type { AiCallLog, AiCallRun } from "../src/lib/aiCalls";

// An editor: no recording lookups (admins only).
vi.mock("../src/lib/auth", () => ({ useAuth: () => ({ user: { role: "EDITOR", email: "e@example.com" }, loading: false, logout: () => undefined }) }));

// The Result column of an AI call run: a completed call never shows a bare "—". Its result is on its way for a minute
// after it ends (the run asks the voice backend for it), then the cell says none came back. fetch is stubbed.

const NOW = Date.parse("2026-11-19T09:16:00Z");
const log = (over: Partial<AiCallLog>): AiCallLog => ({
  id: "l1",
  position: 0,
  customerName: "Test customer",
  gender: "male",
  followUpDetail: null,
  phone: "+919800000000",
  status: "COMPLETED",
  outcome: null,
  error: null,
  summary: null,
  transcript: null,
  durationSec: 16,
  startedAt: "2026-11-19T09:14:00Z",
  endedAt: "2026-11-19T09:15:30Z",
  ...over,
});

describe("noResultText", () => {
  it("a completed call: waiting for its result for a minute after it ends, then 'no result came back'", () => {
    expect(noResultText(log({ endedAt: "2026-11-19T09:15:30Z" }), NOW)).toBe("Waiting for the call's result…"); // 30 s ago
    expect(noResultText(log({ endedAt: "2026-11-19T09:14:59Z" }), NOW)).toBe(
      "No result came back for this call: no outcome or transcript from the voice backend.",
    ); // 61 s ago: the 16 s call from 2026-11-19 showed "—" here
    expect(noResultText(log({ endedAt: null }), NOW)).toMatch(/^No result came back/);
  });

  it.each(["QUEUED", "DIALING", "RINGING", "IN_PROGRESS", "NO_ANSWER", "BUSY", "FAILED", "CANCELLED"] as const)(
    "%s keeps “—” (its status badge says it all)",
    (status) => expect(noResultText(log({ status }), NOW)).toBe("—"),
  );
});

describe("Result column", () => {
  let run: AiCallRun;
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        const body = url.startsWith("/api/ai-calls/runs/") ? run : {};
        return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
      }),
    );
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  const show = async (logs: AiCallLog[]) => {
    run = { id: "r1", mode: "SELECTED", status: "DONE", gapSeconds: 30, total: logs.length, nextCallAt: null, createdAt: "2026-11-19T09:14:00Z", logs } as AiCallRun;
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <ToastProvider>
          <ConfirmProvider>
            <RunStatus runId="r1" onNewRun={() => {}} onClose={() => {}} />
          </ConfirmProvider>
        </ToastProvider>
      </QueryClientProvider>,
    );
    return (await screen.findAllByRole("row")).slice(1); // without the header row
  };

  it("an old completed call with nothing says so; one with its result shows the outcome and summary", async () => {
    const rows = await show([
      log({ id: "a", endedAt: "2026-11-18T09:15:30Z" }),
      log({ id: "b", position: 1, outcome: "hung_up_early", summary: "The customer hung up before the AI spoke." }),
      log({ id: "c", position: 2, status: "NO_ANSWER", durationSec: null }),
    ]);
    const result = (row: HTMLElement) => within(row).getAllByRole("cell").at(-1)!.textContent;
    expect(result(rows[0]!)).toBe("No result came back for this call: no outcome or transcript from the voice backend.");
    expect(result(rows[1]!)).toBe("hung up earlyThe customer hung up before the AI spoke.");
    expect(result(rows[2]!)).toBe("—");
  });
});
