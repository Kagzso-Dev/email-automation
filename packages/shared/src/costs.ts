import { z } from "zod";

/* ------------------------------------------------------------------ cost rate card + estimates */
// Dashboard cost cards. Nothing here is a provider invoice: Dispatch stores no
// prices, so every amount is an ESTIMATE = stored counts / minutes × the rates
// an admin enters in Settings → Cost rates. Missing rates give null (shown as
// "Set rates in Settings"), never a guessed number.

/** Setting-table key holding the rate card as JSON. */
export const COST_RATES_KEY = "cost_rates";

const rate = z.number().min(0).max(1_000_000).nullable().default(null);

export const WHATSAPP_COST_CATEGORIES = ["marketing", "utility", "authentication", "service"] as const;
export type WhatsAppCostCategory = (typeof WHATSAPP_COST_CATEGORIES)[number];

export const costRatesInput = z.object({
  currency: z.enum(["INR", "USD"]).default("INR"),
  /** Price per WhatsApp message by Meta category, in `currency`. Empty = not set. */
  whatsapp: z
    .object({ marketing: rate, utility: rate, authentication: rate, service: rate })
    .default({ marketing: null, utility: null, authentication: null, service: null }),
  /** Optional USD → INR rate, kept for provider prices reported in USD. */
  usdToInr: rate,
  /** Telephony price per minute (no provider prices are stored, so this is always used). */
  callTelephonyPerMin: rate,
  /** Optional AI voice / LLM cost per minute. */
  callAiPerMin: rate,
  callRounding: z.enum(["ceil_minute", "per_second"]).default("ceil_minute"),
});
export type CostRates = z.infer<typeof costRatesInput>;

export const DEFAULT_COST_RATES: CostRates = costRatesInput.parse({});

/** Whatever is stored (or nothing) → a valid rate card; unreadable means "no rates". */
export function normalizeCostRates(value: unknown): CostRates {
  const r = costRatesInput.safeParse(value ?? {});
  return r.success ? r.data : DEFAULT_COST_RATES;
}

/** Meta category text ("MARKETING", "marketing", …) → one of the four priced categories, else null. */
export function normalizeWhatsAppCategory(raw: string | null | undefined): WhatsAppCostCategory | null {
  const c = String(raw ?? "").trim().toLowerCase();
  return (WHATSAPP_COST_CATEGORIES as readonly string[]).includes(c) ? (c as WhatsAppCostCategory) : null;
}

const money = (n: number) => Math.round(n * 100) / 100;

/* ------------------------------------------------------------------ WhatsApp */

export interface CostMessage {
  provider: string; // "meta" | "twilio"
  status: string; // whatsapp_sends.status
  /** Meta's billable flag from the status webhook; null when not stored. */
  billable: boolean | null;
  /** Raw category text (Meta pricing, the template's category, or "service" for Inbox replies). */
  category: string | null;
  /** Where the category came from. */
  source: "meta" | "template" | "reply" | null;
  /** YYYY-MM-DD of the send, for the per-day series. */
  day?: string;
}

/** Statuses that mean Meta accepted the message. FAILED is never billed; QUEUED / SENDING / SKIPPED were never sent. */
const SENT_STATUSES = new Set(["SENT", "DELIVERED", "READ"]);

export interface WhatsAppCostEstimate {
  kind: "estimated";
  ratesSet: boolean;
  /** null when no rates are set or a category with messages has no rate (see missingRates). */
  total: number | null;
  missingRates: WhatsAppCostCategory[];
  billableCount: number;
  byCategory: { category: WhatsAppCostCategory; count: number; fromMeta: number; rate: number | null; amount: number | null }[];
  uncategorized: { count: number; labels: string[] };
  /** Meta marked these not billable (e.g. free service replies). */
  notBillable: number;
  failedExcluded: number;
  twilioCount: number;
  /** Messages whose category / billable flag came from Meta's own pricing data. */
  fromMetaData: number;
  byDay: { date: string; amount: number }[] | null;
}

export function estimateWhatsAppCost(messages: CostMessage[], rates: CostRates): WhatsAppCostEstimate {
  const counts = new Map<WhatsAppCostCategory, { count: number; fromMeta: number }>();
  const dayCounts = new Map<string, Map<WhatsAppCostCategory, number>>();
  const uncategorizedLabels = new Set<string>();
  let uncategorized = 0;
  let notBillable = 0;
  let failedExcluded = 0;
  let twilioCount = 0;
  let fromMetaData = 0;

  for (const m of messages) {
    if (m.status === "FAILED") {
      if (m.provider === "meta") failedExcluded += 1;
      continue;
    }
    if (!SENT_STATUSES.has(m.status)) continue;
    if (m.provider !== "meta") {
      twilioCount += 1;
      continue;
    }
    if (m.source === "meta") fromMetaData += 1;
    if (m.billable === false) {
      notBillable += 1;
      continue;
    }
    const cat = normalizeWhatsAppCategory(m.category);
    if (!cat) {
      uncategorized += 1;
      uncategorizedLabels.add(m.category ? m.category.toLowerCase() : "unknown");
      continue;
    }
    const c = counts.get(cat) ?? { count: 0, fromMeta: 0 };
    c.count += 1;
    if (m.source === "meta") c.fromMeta += 1;
    counts.set(cat, c);
    if (m.day) {
      const d = dayCounts.get(m.day) ?? new Map<WhatsAppCostCategory, number>();
      d.set(cat, (d.get(cat) ?? 0) + 1);
      dayCounts.set(m.day, d);
    }
  }

  const r = rates.whatsapp;
  const ratesSet = WHATSAPP_COST_CATEGORIES.some((c) => r[c] !== null);
  const byCategory = WHATSAPP_COST_CATEGORIES.filter((c) => counts.has(c)).map((category) => {
    const { count, fromMeta } = counts.get(category)!;
    const rateFor = r[category];
    return { category, count, fromMeta, rate: rateFor, amount: rateFor === null ? null : money(count * rateFor) };
  });
  const missingRates = byCategory.filter((b) => b.rate === null).map((b) => b.category);
  const total = !ratesSet || missingRates.length ? null : money(byCategory.reduce((s, b) => s + (b.amount ?? 0), 0));
  const byDay =
    total === null
      ? null
      : [...dayCounts.entries()]
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([date, m]) => ({ date, amount: money([...m.entries()].reduce((s, [c, n]) => s + n * (r[c] ?? 0), 0)) }));

  return {
    kind: "estimated",
    ratesSet,
    total,
    missingRates,
    billableCount: byCategory.reduce((s, b) => s + b.count, 0),
    byCategory,
    uncategorized: { count: uncategorized, labels: [...uncategorizedLabels].sort() },
    notBillable,
    failedExcluded,
    twilioCount,
    fromMetaData,
    byDay,
  };
}

/* ------------------------------------------------------------------ calls */

export interface CallCostEstimate {
  kind: "estimated";
  ratesSet: boolean;
  /** Telephony (+ AI when its rate is set); null when the telephony rate isn't set. */
  total: number | null;
  telephony: number | null;
  ai: number | null;
  billedCalls: number;
  /** Billed minutes after rounding (whole minutes per call, or exact seconds / 60). */
  minutes: number;
  avgPerCall: number | null;
  rounding: CostRates["callRounding"];
}

/** Calls with a stored duration > 0 are billed; unanswered / failed calls (no duration) are not. */
export function estimateCallCost(calls: { durationSec: number | null }[], rates: CostRates): CallCostEstimate {
  const timed = calls.filter((c) => (c.durationSec ?? 0) > 0);
  const minutesRaw =
    rates.callRounding === "ceil_minute"
      ? timed.reduce((s, c) => s + Math.ceil(c.durationSec! / 60), 0)
      : timed.reduce((s, c) => s + c.durationSec!, 0) / 60;
  const minutes = Math.round(minutesRaw * 100) / 100;
  const telephony = rates.callTelephonyPerMin === null ? null : money(minutesRaw * rates.callTelephonyPerMin);
  const ai = rates.callAiPerMin === null ? null : money(minutesRaw * rates.callAiPerMin);
  const total = telephony === null ? null : money(telephony + (ai ?? 0));
  return {
    kind: "estimated",
    ratesSet: rates.callTelephonyPerMin !== null,
    total,
    telephony,
    ai,
    billedCalls: timed.length,
    minutes,
    avgPerCall: total === null || timed.length === 0 ? null : money(total / timed.length),
    rounding: rates.callRounding,
  };
}

/** "All" row: a total only when both channels have a number. Always an estimate. */
export function combinedCost(whatsapp: number | null | undefined, calls: number | null | undefined): number | null {
  return typeof whatsapp === "number" && typeof calls === "number" ? money(whatsapp + calls) : null;
}
