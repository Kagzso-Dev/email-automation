import { keepPreviousData, useQuery } from "@tanstack/react-query";
import type { CallCostEstimate, CostRates, WhatsAppCostEstimate } from "@dispatch/shared";
import { api } from "./api";

/** GET /api/dashboard/costs — every amount is an estimate from the Settings rate card. */
export interface DashboardCosts {
  span: number;
  currency: CostRates["currency"];
  whatsapp: WhatsAppCostEstimate & { categoriesError: string | null };
  /** Null for people who can't see the Calls section. */
  calls: CallCostEstimate | null;
  /** Both channels' estimates added up; null unless both have a number. */
  total: number | null;
}

/** Same refresh cadence and no-flicker behaviour as the other Dashboard queries. */
export function useDashboardCosts(days: number, enabled: boolean) {
  return useQuery({
    queryKey: ["dashboard-costs", days],
    queryFn: () => api<DashboardCosts>(`/api/dashboard/costs?days=${days}`),
    enabled,
    refetchInterval: 45_000,
    refetchIntervalInBackground: false,
    placeholderData: keepPreviousData,
  });
}

export const COST_RATES_QUERY = ["cost-rates"] as const;

export function useCostRates(enabled: boolean) {
  return useQuery({
    queryKey: COST_RATES_QUERY,
    queryFn: () => api<CostRates>("/api/settings/cost-rates"),
    enabled,
  });
}

/** ₹ 12.40 / $ 0.15 — in the rate card's currency. */
export function formatMoney(n: number, currency: string): string {
  return new Intl.NumberFormat(currency === "INR" ? "en-IN" : "en-US", {
    style: "currency",
    currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(n);
}
