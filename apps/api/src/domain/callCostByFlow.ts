// "Cost by call flow" (Dashboard → AI Calls). New, read-only: groups the same
// calls "Call bills" counts (started in the range, duration > 0) by the flow
// pinned to their run (ai_call_run_flows; no pin = "Default agent"), and prices
// each group with the shared estimateCallCost and the saved cost_rates — no
// formula of its own. Group totals therefore add up to the "Call bills" card.

import { estimateCallCost, type CostRates } from "@dispatch/shared";
import { prisma } from "../prisma.js";
import { getCostRates } from "./dashboardCosts.js";
import { rangeFor, type DashboardSpan } from "./dashboardChannels.js";

export const DEFAULT_AGENT = "Default agent";

export interface FlowRef {
  id: string;
  name: string;
}

export interface FlowCostRow {
  flowId: string | null;
  name: string;
  calls: number;
  billedMinutes: number;
  /** null when the telephony rate isn't set. */
  cost: number | null;
  costPerCall: number | null;
  /** Telephony part of `cost` (null when the telephony rate isn't set). */
  telephonyCost: number | null;
  /** AI voice / LLM part of `cost` (null when the AI rate isn't set). */
  aiCost: number | null;
}

/**
 * Telephony and AI parts of a cost, each from the shared estimateCallCost run
 * with only that one rate — no formula here. With both rates set,
 * telephony + AI = the full estimate's total.
 */
export function costSplit(calls: { durationSec: number | null }[], rates: CostRates) {
  const telephonyOnly: CostRates = { ...rates, callAiPerMin: null };
  const aiOnly: CostRates = { ...rates, callTelephonyPerMin: rates.callAiPerMin, callAiPerMin: null };
  return {
    telephonyCost: estimateCallCost(calls, telephonyOnly).total,
    aiCost: rates.callAiPerMin === null ? null : estimateCallCost(calls, aiOnly).total,
  };
}

/**
 * Group billed calls by flow and price each group. Calls without a duration
 * are left out (as in "Call bills"); calls whose run has no pinned flow go to
 * "Default agent". Sorted by cost (or calls when there is no cost), highest first.
 */
export function costByFlow(
  calls: { runId: string; durationSec: number | null }[],
  flowOfRun: Map<string, FlowRef>,
  rates: CostRates,
) {
  const groups = new Map<string, { flowId: string | null; name: string; calls: { durationSec: number | null }[] }>();
  for (const c of calls) {
    if ((c.durationSec ?? 0) <= 0) continue;
    const f = flowOfRun.get(c.runId);
    const key = f?.id ?? "__default__";
    const g = groups.get(key) ?? { flowId: f?.id ?? null, name: f?.name ?? DEFAULT_AGENT, calls: [] };
    g.calls.push({ durationSec: c.durationSec });
    groups.set(key, g);
  }
  const items: FlowCostRow[] = [...groups.values()].map((g) => {
    const e = estimateCallCost(g.calls, rates);
    return {
      flowId: g.flowId,
      name: g.name,
      calls: e.billedCalls,
      billedMinutes: e.minutes,
      cost: e.total,
      costPerCall: e.avgPerCall,
      ...costSplit(g.calls, rates),
    };
  });
  items.sort((a, b) => (b.cost ?? 0) - (a.cost ?? 0) || b.calls - a.calls || a.name.localeCompare(b.name));
  const all = estimateCallCost(calls, rates);
  return {
    ratesSet: all.ratesSet,
    rounding: all.rounding,
    /** The saved per-minute rates used (for the "₹0.60/min telephony · ₹3.00/min AI" line). */
    rates: { telephonyPerMin: rates.callTelephonyPerMin, aiPerMin: rates.callAiPerMin },
    items,
    totals: {
      calls: all.billedCalls,
      billedMinutes: all.minutes,
      cost: all.total,
      costPerCall: all.avgPerCall,
      ...costSplit(calls, rates),
    },
  };
}

export async function callCostByFlow(span: DashboardSpan) {
  const r = rangeFor(span);
  const [rates, calls] = await Promise.all([
    getCostRates(),
    prisma.aiCallLog.findMany({
      where: { startedAt: { gte: r.start, lte: r.end }, durationSec: { gt: 0 } },
      select: { runId: true, durationSec: true },
    }),
  ]);
  const runIds = [...new Set(calls.map((c) => c.runId))];
  const pins = runIds.length
    ? await prisma.aiCallRunFlow.findMany({
        where: { runId: { in: runIds } },
        select: { runId: true, flowVersion: { select: { flow: { select: { id: true, name: true } } } } },
      })
    : [];
  const flowOfRun = new Map(pins.map((p) => [p.runId, p.flowVersion.flow]));
  return { span, currency: rates.currency, ...costByFlow(calls, flowOfRun, rates) };
}
