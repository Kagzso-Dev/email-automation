// Dashboard cost cards (GET /api/dashboard/costs). Read-only toward existing
// data: it counts WhatsApp sends and call minutes for the selected range and
// applies the rate card from Settings → Cost rates. Every amount is an
// ESTIMATE — no provider prices are stored. Meta's own pricing info
// (whatsapp_message_pricing, from status webhooks) only decides a message's
// category and billable flag; the amount still comes from the rate card.

import {
  combinedCost,
  COST_RATES_KEY,
  estimateCallCost,
  estimateWhatsAppCost,
  normalizeCostRates,
  type CostMessage,
  type CostRates,
} from "@dispatch/shared";
import { prisma } from "../prisma.js";
import { logger } from "../logger.js";
import { listMessageTemplates, type MetaMessageTemplate } from "../services/whatsapp.js";
import { getSetting, setSetting } from "./settings.js";
import { dayKey, rangeFor, type DashboardSpan } from "./dashboardChannels.js";

/* ------------------------------------------------------------------ rate card */

export async function getCostRates(): Promise<CostRates> {
  try {
    return normalizeCostRates(await getSetting<unknown>(COST_RATES_KEY, null));
  } catch {
    return normalizeCostRates(null);
  }
}

export async function setCostRates(rates: CostRates): Promise<CostRates> {
  const clean = normalizeCostRates(rates);
  await setSetting(COST_RATES_KEY, clean);
  return clean;
}

/* ------------------------------------------------------------------ template categories (Meta) */

const TEMPLATE_CACHE_MS = 5 * 60_000;
let templateCache: { at: number; list: MetaMessageTemplate[] | Error } | null = null;

/** Meta's current category per template (name + language), cached 5 minutes. */
async function templateCategories(): Promise<{ byKey: Map<string, string>; error: string | null }> {
  if (!templateCache || Date.now() - templateCache.at > TEMPLATE_CACHE_MS) {
    let list: MetaMessageTemplate[] | Error;
    try {
      list = await listMessageTemplates();
    } catch (err) {
      list = err instanceof Error ? err : new Error(String(err));
    }
    templateCache = { at: Date.now(), list };
  }
  const list = templateCache.list;
  if (list instanceof Error) return { byKey: new Map(), error: list.message };
  return { byKey: new Map(list.map((t) => [`${t.name}|${t.language}`, (t.category ?? "").toLowerCase()])), error: null };
}

/** Test hook. */
export function resetCostCaches() {
  templateCache = null;
}

/** Pricing rows for these message ids; missing table (before migration 0022) = none. */
async function storedPricing(ids: string[]) {
  if (ids.length === 0) return new Map<string, { billable: boolean | null; category: string | null }>();
  try {
    const rows = await prisma.whatsAppMessagePricing.findMany({
      where: { providerMessageId: { in: ids } },
      select: { providerMessageId: true, billable: true, category: true },
    });
    return new Map(rows.map((r) => [r.providerMessageId, { billable: r.billable, category: r.category }]));
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err) }, "whatsapp pricing info unavailable — using template categories");
    return new Map<string, { billable: boolean | null; category: string | null }>();
  }
}

/* ------------------------------------------------------------------ estimates */

export async function whatsappCosts(span: DashboardSpan, rates: CostRates) {
  const r = rangeFor(span);
  const rows = await prisma.whatsAppSend.findMany({
    where: {
      OR: [
        { sentAt: { gte: r.start, lte: r.end } },
        { status: "FAILED", sentAt: null, failedAt: { gte: r.start, lte: r.end } },
      ],
    },
    select: {
      provider: true,
      status: true,
      providerMessageId: true,
      batchId: true,
      sentAt: true,
      batch: { select: { template: { select: { providerTemplateName: true, languageCode: true } } } },
    },
  });
  const pricing = await storedPricing(rows.map((s) => s.providerMessageId).filter((x): x is string => !!x));
  const needsTemplates = rows.some((s) => s.batchId && !(s.providerMessageId && pricing.has(s.providerMessageId)));
  const cats = needsTemplates ? await templateCategories() : { byKey: new Map<string, string>(), error: null };

  const messages: CostMessage[] = rows.map((s) => {
    const p = s.providerMessageId ? pricing.get(s.providerMessageId) : undefined;
    const day = s.sentAt ? dayKey(s.sentAt) : undefined;
    if (p) return { provider: s.provider, status: s.status, billable: p.billable, category: p.category, source: "meta", day };
    if (!s.batchId) return { provider: s.provider, status: s.status, billable: null, category: "service", source: "reply", day };
    const t = s.batch?.template;
    const category = t?.providerTemplateName ? (cats.byKey.get(`${t.providerTemplateName}|${t.languageCode}`) ?? null) : null;
    return { provider: s.provider, status: s.status, billable: null, category, source: category ? "template" : null, day };
  });
  return { ...estimateWhatsAppCost(messages, rates), categoriesError: cats.error };
}

export async function callCosts(span: DashboardSpan, rates: CostRates) {
  const r = rangeFor(span);
  const calls = await prisma.aiCallLog.findMany({
    where: { startedAt: { gte: r.start, lte: r.end }, durationSec: { gt: 0 } },
    select: { durationSec: true },
  });
  return estimateCallCost(calls, rates);
}

export async function dashboardCosts(span: DashboardSpan, opts: { includeCalls: boolean }) {
  const rates = await getCostRates();
  const [whatsapp, calls] = await Promise.all([
    whatsappCosts(span, rates),
    opts.includeCalls ? callCosts(span, rates) : Promise.resolve(null),
  ]);
  return {
    span,
    currency: rates.currency,
    whatsapp,
    calls,
    total: calls ? combinedCost(whatsapp.total, calls.total) : null,
  };
}
