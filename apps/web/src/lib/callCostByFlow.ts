import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { api } from "./api";

/** Telephony and AI parts of a cost (aiCost null when the AI rate isn't set). */
export interface CostSplit {
  telephonyCost: number | null;
  aiCost: number | null;
}

/** GET /api/dashboard/calls/cost-by-flow — estimates from the Settings rate card. */
export interface CallCostByFlow {
  span: number;
  currency: string;
  ratesSet: boolean;
  rounding: "ceil_minute" | "per_second";
  /** Saved per-minute rates used for the estimate (null = not set). */
  rates: { telephonyPerMin: number | null; aiPerMin: number | null };
  items: (CostSplit & { flowId: string | null; name: string; calls: number; billedMinutes: number; cost: number | null; costPerCall: number | null })[];
  totals: CostSplit & { calls: number; billedMinutes: number; cost: number | null; costPerCall: number | null };
}

/** Same refresh cadence and no-flicker behaviour as the other Dashboard queries. */
export function useCallCostByFlow(days: number) {
  return useQuery({
    queryKey: ["dashboard-call-cost-by-flow", days],
    queryFn: () => api<CallCostByFlow>(`/api/dashboard/calls/cost-by-flow?days=${days}`),
    refetchInterval: 45_000,
    refetchIntervalInBackground: false,
    placeholderData: keepPreviousData,
  });
}
