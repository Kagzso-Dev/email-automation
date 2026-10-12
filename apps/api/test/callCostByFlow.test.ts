import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import express from "express";
import jwt from "jsonwebtoken";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { costRatesInput, estimateCallCost, normalizeCostRates } from "@dispatch/shared";

// "Cost by call flow": grouping by the pinned flow (no pin = Default agent),
// pricing through the shared estimateCallCost, totals equal to "Call bills",
// plus the route guards (ADMIN only, 404 while ENABLE_AI_CALLS is off).

vi.mock("../src/prisma.js", () => ({ prisma: {} }));
const { costByFlow, costSplit, DEFAULT_AGENT } = await import("../src/domain/callCostByFlow.js");

const rates = (over: Record<string, unknown> = {}) => costRatesInput.parse({ callTelephonyPerMin: 1, ...over });
const flows = new Map([
  ["run-a", { id: "f1", name: "Nila screening" }],
  ["run-b", { id: "f2", name: "Customer follow-up" }],
]);

describe("costByFlow", () => {
  it("groups by flow with different durations; calls with no flow go to Default agent", () => {
    const calls = [
      { runId: "run-a", durationSec: 92 }, // 2 min (rounded up)
      { runId: "run-a", durationSec: 61 }, // 2 min
      { runId: "run-b", durationSec: 22 }, // 1 min
      { runId: "run-x", durationSec: 3 }, //  1 min, no pinned flow
      { runId: "run-x", durationSec: 1 }, //  1 min
    ];
    const r = costByFlow(calls, flows, rates());
    expect(r.items).toEqual([
      { flowId: "f1", name: "Nila screening", calls: 2, billedMinutes: 4, cost: 4, costPerCall: 2, telephonyCost: 4, aiCost: null },
      { flowId: null, name: DEFAULT_AGENT, calls: 2, billedMinutes: 2, cost: 2, costPerCall: 1, telephonyCost: 2, aiCost: null },
      { flowId: "f2", name: "Customer follow-up", calls: 1, billedMinutes: 1, cost: 1, costPerCall: 1, telephonyCost: 1, aiCost: null },
    ]);
    expect(r.totals).toEqual({ calls: 5, billedMinutes: 7, cost: 7, costPerCall: 1.4, telephonyCost: 7, aiCost: null });
  });

  it("totals match the Call bills estimate for the same calls (same formula, imported)", () => {
    const calls = [1, 1, null, 92, 22, 61, 3].map((durationSec, i) => ({ runId: i % 2 ? "run-a" : "run-z", durationSec }));
    for (const mode of ["ceil_minute", "per_second"] as const) {
      const r = rates({ callRounding: mode, callAiPerMin: 0.5 });
      const bills = estimateCallCost(calls, r);
      const byFlow = costByFlow(calls, flows, r);
      expect(byFlow.totals).toMatchObject({ calls: bills.billedCalls, billedMinutes: bills.minutes, cost: bills.total, costPerCall: bills.avgPerCall });
      const sum = byFlow.items.reduce((s, f) => s + (f.cost ?? 0), 0);
      expect(sum).toBeCloseTo(bills.total!, 1);
    }
  });

  it("calls with no duration are left out", () => {
    const r = costByFlow([{ runId: "run-a", durationSec: null }, { runId: "run-a", durationSec: 0 }, { runId: "run-b", durationSec: 30 }], flows, rates());
    expect(r.items.map((f) => [f.name, f.calls])).toEqual([["Customer follow-up", 1]]);
  });

  it("unset telephony rate: no costs, minutes still counted", () => {
    const r = costByFlow([{ runId: "run-a", durationSec: 90 }], flows, normalizeCostRates(null));
    expect(r.ratesSet).toBe(false);
    expect(r.items).toEqual([{ flowId: "f1", name: "Nila screening", calls: 1, billedMinutes: 2, cost: null, costPerCall: null, telephonyCost: null, aiCost: null }]);
    expect(r.totals.cost).toBeNull();
  });

  it("zero calls", () => {
    expect(costByFlow([], flows, rates())).toEqual({
      ratesSet: true,
      rounding: "ceil_minute",
      rates: { telephonyPerMin: 1, aiPerMin: null },
      items: [],
      totals: { calls: 0, billedMinutes: 0, cost: 0, costPerCall: null, telephonyCost: 0, aiCost: null },
    });
  });
});

describe("telephony + AI split", () => {
  // Your real calls: 7 answered, 180 s, one with no duration; ₹0.60/min telephony + ₹3.00/min AI.
  const calls = [1, 1, null, 92, 22, 61, 3].map((durationSec, i) => ({ runId: i < 4 ? "run-a" : "run-z", durationSec }));
  for (const mode of ["ceil_minute", "per_second"] as const) {
    it(`${mode}: telephony + AI = total, per flow and overall, and the total = Call bills`, () => {
      const r = rates({ callTelephonyPerMin: 0.6, callAiPerMin: 3, callRounding: mode });
      const bills = estimateCallCost(calls, r);
      const byFlow = costByFlow(calls, flows, r);
      expect(byFlow.totals.cost).toBe(bills.total);
      expect(byFlow.totals.telephonyCost! + byFlow.totals.aiCost!).toBeCloseTo(byFlow.totals.cost!, 10);
      expect(byFlow.totals.telephonyCost).toBe(bills.telephony);
      expect(byFlow.totals.aiCost).toBe(bills.ai);
      for (const f of byFlow.items) expect(f.telephonyCost! + f.aiCost!).toBeCloseTo(f.cost!, 10);
      expect(byFlow.rates).toEqual({ telephonyPerMin: 0.6, aiPerMin: 3 });
    });
  }

  it("worked example (round up): 8 min × ₹0.60 = ₹4.80 + 8 min × ₹3.00 = ₹24.00 → ₹28.80", () => {
    const t = costByFlow(calls, flows, rates({ callTelephonyPerMin: 0.6, callAiPerMin: 3 })).totals;
    expect(t).toMatchObject({ billedMinutes: 8, telephonyCost: 4.8, aiCost: 24, cost: 28.8 });
  });

  it("per second: 3 min × ₹0.60 = ₹1.80 + 3 min × ₹3.00 = ₹9.00 → ₹10.80", () => {
    const t = costByFlow(calls, flows, rates({ callTelephonyPerMin: 0.6, callAiPerMin: 3, callRounding: "per_second" })).totals;
    expect(t).toMatchObject({ billedMinutes: 3, telephonyCost: 1.8, aiCost: 9, cost: 10.8 });
  });

  it("AI rate not set: aiCost is null (column hidden) and telephony = total", () => {
    const s = costSplit(calls, rates({ callTelephonyPerMin: 0.6 }));
    expect(s).toEqual({ telephonyCost: 4.8, aiCost: null });
    expect(costByFlow(calls, flows, rates({ callTelephonyPerMin: 0.6 })).totals.cost).toBe(4.8);
  });
});

describe("GET /dashboard/calls/cost-by-flow guards", () => {
  let server: Server;
  let base = "";
  const token = (role: "ADMIN" | "EDITOR") => jwt.sign({ sub: "u", email: "u@test", role }, process.env.JWT_ACCESS_SECRET!);
  beforeAll(async () => {
    process.env.ENABLE_AI_CALLS = "false";
    const { callCostByFlowRouter } = await import("../src/http/routes/callCostByFlow.js");
    const { errorHandler } = await import("../src/http/errors.js");
    const app = express();
    app.use("/api", callCostByFlowRouter);
    app.use(errorHandler);
    server = app.listen(0);
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/dashboard/calls/cost-by-flow?days=14`;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  it("requires sign-in", async () => {
    expect((await fetch(base)).status).toBe(401);
  });
  it("404 while ENABLE_AI_CALLS is off (like /api/dashboard/calls)", async () => {
    expect((await fetch(base, { headers: { Authorization: `Bearer ${token("ADMIN")}` } })).status).toBe(404);
  });
});
