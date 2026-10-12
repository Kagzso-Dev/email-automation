import crypto from "node:crypto";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  combinedCost,
  costRatesInput,
  estimateCallCost,
  estimateWhatsAppCost,
  normalizeCostRates,
  type CostMessage,
} from "@dispatch/shared";

// Dashboard cost estimates (rate card applied, failed / Twilio / not-billable
// excluded, missing data → no number) and the webhook pricing capture
// safeguards: (a) pricing is stored, (b) without pricing nothing changes,
// (c) an error in the new code can't affect the status update or the 200.

/* ------------------------------------------------------------------ pure estimates */

const rates = (over: Record<string, unknown> = {}) =>
  costRatesInput.parse({ whatsapp: { marketing: 0.8, utility: 0.12, authentication: 0.12, service: 0 }, callTelephonyPerMin: 1.5, ...over });
const msg = (over: Partial<CostMessage> = {}): CostMessage => ({
  provider: "meta",
  status: "DELIVERED",
  billable: null,
  category: "marketing",
  source: "template",
  ...over,
});

describe("WhatsApp estimate", () => {
  it("billable messages per category × the category rate", () => {
    const e = estimateWhatsAppCost(
      [msg(), msg({ status: "READ" }), msg({ status: "SENT" }), msg({ category: "utility" }), msg({ category: "service", source: "reply" })],
      rates(),
    );
    expect(e.byCategory).toEqual([
      { category: "marketing", count: 3, fromMeta: 0, rate: 0.8, amount: 2.4 },
      { category: "utility", count: 1, fromMeta: 0, rate: 0.12, amount: 0.12 },
      { category: "service", count: 1, fromMeta: 0, rate: 0, amount: 0 },
    ]);
    expect(e.total).toBe(2.52);
    expect(e.billableCount).toBe(5);
    expect(e.kind).toBe("estimated");
  });

  it("failed messages are never billed; queued / skipped weren't sent", () => {
    const e = estimateWhatsAppCost([msg(), msg({ status: "FAILED" }), msg({ status: "FAILED" }), msg({ status: "QUEUED" }), msg({ status: "SKIPPED" })], rates());
    expect(e).toMatchObject({ billableCount: 1, failedExcluded: 2, total: 0.8 });
  });

  it("Twilio-sent messages are excluded and counted separately", () => {
    const e = estimateWhatsAppCost([msg(), msg({ provider: "twilio" }), msg({ provider: "twilio", status: "READ" })], rates());
    expect(e).toMatchObject({ twilioCount: 2, billableCount: 1, total: 0.8 });
  });

  it("Meta's stored pricing decides category and billable; not-billable costs nothing", () => {
    const e = estimateWhatsAppCost(
      [msg({ source: "meta", category: "utility" }), msg({ source: "meta", billable: false, category: "service" })],
      rates(),
    );
    expect(e.byCategory).toEqual([{ category: "utility", count: 1, fromMeta: 1, rate: 0.12, amount: 0.12 }]);
    expect(e).toMatchObject({ notBillable: 1, fromMetaData: 2, total: 0.12 });
  });

  it("unknown categories go to Uncategorized with no price", () => {
    const e = estimateWhatsAppCost([msg(), msg({ category: null, source: null }), msg({ category: "marketing_lite", source: "meta" })], rates());
    expect(e.uncategorized).toEqual({ count: 2, labels: ["marketing_lite", "unknown"] });
    expect(e.total).toBe(0.8); // uncategorized are not priced
  });

  it("no rates → no number; a used category without a rate → no total (no partial sums)", () => {
    expect(estimateWhatsAppCost([msg()], normalizeCostRates(null))).toMatchObject({ ratesSet: false, total: null, byDay: null });
    const partial = estimateWhatsAppCost([msg(), msg({ category: "utility" })], rates({ whatsapp: { marketing: 0.8 } }));
    expect(partial).toMatchObject({ ratesSet: true, total: null, missingRates: ["utility"] });
    expect(partial.byCategory.find((b) => b.category === "utility")?.amount).toBeNull();
  });

  it("per-day amounts add up to the total", () => {
    const e = estimateWhatsAppCost([msg({ day: "2026-10-10" }), msg({ day: "2026-10-11" }), msg({ day: "2026-10-11", category: "utility" })], rates());
    expect(e.byDay).toEqual([
      { date: "2026-10-10", amount: 0.8 },
      { date: "2026-10-11", amount: 0.92 },
    ]);
    expect(e.byDay!.reduce((s, d) => s + d.amount, 0)).toBeCloseTo(e.total!);
  });
});

describe("call estimate", () => {
  const calls = [{ durationSec: 61 }, { durationSec: 30 }, { durationSec: 0 }, { durationSec: null }];
  it("rounded up to whole minutes per call (default): 61s → 2 min, 30s → 1 min", () => {
    expect(estimateCallCost(calls, rates())).toMatchObject({ minutes: 3, billedCalls: 2, telephony: 4.5, ai: null, total: 4.5, avgPerCall: 2.25 });
  });
  it("per second: 91s → 1.52 min", () => {
    expect(estimateCallCost(calls, rates({ callRounding: "per_second" }))).toMatchObject({ minutes: 1.52, total: 2.28 });
  });
  it("AI per-minute cost is added when set", () => {
    expect(estimateCallCost(calls, rates({ callAiPerMin: 2 }))).toMatchObject({ telephony: 4.5, ai: 6, total: 10.5 });
  });
  it("no telephony rate → no number; unanswered calls are not billed", () => {
    expect(estimateCallCost(calls, normalizeCostRates(null))).toMatchObject({ ratesSet: false, total: null, avgPerCall: null, minutes: 3 });
    expect(estimateCallCost([{ durationSec: 0 }], rates())).toMatchObject({ billedCalls: 0, total: 0, avgPerCall: null });
  });
});

describe("call estimate — real-data example (7 answered calls, 180 s, ₹1.00 / min)", () => {
  // Stored durations of the 7 answered calls; one has no duration and isn't billed.
  const answered = [1, 1, null, 92, 22, 61, 3].map((durationSec) => ({ durationSec }));
  it("round up per call: 1+1+2+1+2+1 = 8 min → ₹8.00 (avg ₹1.33 over 6 billed calls)", () => {
    expect(estimateCallCost(answered, rates({ callTelephonyPerMin: 1 }))).toMatchObject({ minutes: 8, billedCalls: 6, telephony: 8, total: 8, avgPerCall: 1.33 });
  });
  it("per second: 180 s / 60 = 3 min → ₹3.00", () => {
    expect(estimateCallCost(answered, rates({ callTelephonyPerMin: 1, callRounding: "per_second" }))).toMatchObject({ minutes: 3, total: 3, avgPerCall: 0.5 });
  });
  it("no telephony rate → no number (card shows Set rates in Settings)", () => {
    expect(estimateCallCost(answered, normalizeCostRates(null))).toMatchObject({ ratesSet: false, total: null });
  });
  it("no calls in range → ₹0.00 when a rate is set", () => {
    expect(estimateCallCost([], rates({ callTelephonyPerMin: 1 }))).toMatchObject({ total: 0, minutes: 0, billedCalls: 0, avgPerCall: null });
  });
});

describe("rate card", () => {
  it("defaults are empty (no hardcoded prices) and rounding defaults to whole minutes", () => {
    expect(normalizeCostRates(null)).toEqual({
      currency: "INR",
      whatsapp: { marketing: null, utility: null, authentication: null, service: null },
      usdToInr: null,
      callTelephonyPerMin: null,
      callAiPerMin: null,
      callRounding: "ceil_minute",
    });
    expect(normalizeCostRates({ whatsapp: { marketing: -1 } })).toEqual(normalizeCostRates(null)); // invalid → no rates
  });
  it("combined total only when both channels have a number", () => {
    expect(combinedCost(2.52, 4.5)).toBe(7.02);
    expect(combinedCost(null, 4.5)).toBeNull();
    expect(combinedCost(2.52, null)).toBeNull();
  });
});

/* ------------------------------------------------------------------ DB-backed parts (in-memory stand-in) */

process.env.META_WHATSAPP_APP_SECRET = "cost-test-secret-0123456789";
process.env.META_WHATSAPP_PHONE_NUMBER_ID = "P1";
process.env.META_WHATSAPP_ACCESS_TOKEN = "EAAtest";
process.env.META_WHATSAPP_WEBHOOK_VERIFY_TOKEN = "v";

type Row = Record<string, any>;
const db: Record<string, Row[]> = {};
const T = (n: string) => (db[n] ??= []);
const failPricing = { on: false };
const calls: string[] = [];
const prismaMock = new Proxy({} as Row, {
  get: (_t, n: string) => ({
    findUnique: async ({ where }: Row) => T(n).find((r) => Object.entries(where).every(([k, v]) => r[k] === v)) ?? null,
    findMany: async ({ where }: Row = {}) => {
      if (n === "whatsAppMessagePricing" && failPricing.on) throw new Error("table missing");
      if (n === "whatsAppMessagePricing") return T(n).filter((r) => where.providerMessageId.in.includes(r.providerMessageId));
      return T(n);
    },
    upsert: async ({ where, create, update }: Row) => {
      calls.push(`${n}.upsert`);
      if (n === "whatsAppMessagePricing" && failPricing.on) throw new Error("db down");
      const hit = T(n).find((r) => Object.entries(where).every(([k, v]) => r[k] === v));
      if (hit) return Object.assign(hit, update);
      T(n).push({ ...create });
      return create;
    },
  }),
});
vi.mock("../src/prisma.js", () => ({ prisma: prismaMock }));
const applyWhatsAppStatusEvent = vi.fn(async () => {
  calls.push("status.applied");
});
vi.mock("../src/domain/whatsappTracking.js", () => ({ applyWhatsAppStatusEvent: (...a: unknown[]) => applyWhatsAppStatusEvent(...(a as [])) }));
const listMessageTemplates = vi.fn(async (): Promise<any[]> => [{ name: "kagzso_company_intro", language: "en", category: "MARKETING" }]);
vi.mock("../src/services/whatsapp.js", async (orig) => ({ ...(await orig<object>()), listMessageTemplates }));

const { processMetaWebhook } = await import("../src/domain/whatsappWebhook.js");
const { whatsappCosts, resetCostCaches } = await import("../src/domain/dashboardCosts.js");

beforeEach(() => {
  for (const k of Object.keys(db)) delete db[k];
  calls.length = 0;
  failPricing.on = false;
  vi.clearAllMocks();
  resetCostCaches();
});

const statusPayload = (status: Row) => ({
  object: "whatsapp_business_account",
  entry: [{ changes: [{ field: "messages", value: { metadata: { phone_number_id: "P1" }, statuses: [status] } }] }],
});

describe("webhook pricing capture safeguards", () => {
  it("(a) a status with pricing stores it — after the status update", async () => {
    const r = await processMetaWebhook(
      statusPayload({ id: "wamid.A", status: "delivered", timestamp: "1", pricing: { billable: true, category: "MARKETING", pricing_model: "PMP" } }) as never,
      "P1",
    );
    expect(r.statuses).toBe(1);
    expect(T("whatsAppMessagePricing")).toEqual([{ providerMessageId: "wamid.A", billable: true, category: "marketing", pricingModel: "PMP" }]);
    expect(calls).toEqual(["status.applied", "whatsAppMessagePricing.upsert"]);
  });

  it("(b) without pricing everything behaves as before (no pricing write)", async () => {
    const r = await processMetaWebhook(statusPayload({ id: "wamid.B", status: "read", timestamp: "1" }) as never, "P1");
    expect(r).toEqual({ statuses: 1, messages: 0, ignored: 0 });
    expect(applyWhatsAppStatusEvent).toHaveBeenCalledWith(expect.objectContaining({ providerMessageId: "wamid.B", status: "read" }));
    expect(calls).toEqual(["status.applied"]);
  });

  it("(c) an error in the pricing code doesn't affect the status update or the result", async () => {
    failPricing.on = true;
    const r = await processMetaWebhook(
      statusPayload({ id: "wamid.C", status: "delivered", timestamp: "1", pricing: { billable: true, category: "utility" } }) as never,
      "P1",
    );
    expect(r).toEqual({ statuses: 1, messages: 0, ignored: 0 });
    expect(applyWhatsAppStatusEvent).toHaveBeenCalledTimes(1);
    expect(calls).toEqual(["status.applied", "whatsAppMessagePricing.upsert"]);
  });

  it("(c) …and the webhook still answers 200 over HTTP", async () => {
    failPricing.on = true;
    const { createApp } = await import("../src/http/app.js");
    const server: Server = createApp().listen(0);
    try {
      const body = JSON.stringify(statusPayload({ id: "wamid.H", status: "sent", timestamp: "1", pricing: { billable: true, category: "marketing" } }));
      const sig = "sha256=" + crypto.createHmac("sha256", process.env.META_WHATSAPP_APP_SECRET!).update(body).digest("hex");
      const res = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/webhooks/whatsapp`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Hub-Signature-256": sig },
        body,
      });
      expect(res.status).toBe(200);
      expect(applyWhatsAppStatusEvent).toHaveBeenCalledWith(expect.objectContaining({ providerMessageId: "wamid.H" }));
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});

describe("whatsappCosts (categories: Meta pricing → Inbox reply → template)", () => {
  const send = (over: Row) => ({
    provider: "meta",
    status: "DELIVERED",
    providerMessageId: null,
    batchId: "b1",
    sentAt: new Date(),
    batch: { template: { providerTemplateName: "kagzso_company_intro", languageCode: "en" } },
    ...over,
  });

  it("uses stored Meta pricing first, then 'service' for Inbox replies, then the template's category", async () => {
    T("whatsAppSend").push(
      send({ providerMessageId: "wamid.1" }),
      send({ providerMessageId: "wamid.2", batchId: null, batch: null }),
      send({ providerMessageId: "wamid.3" }),
      send({ providerMessageId: "wamid.4", batch: { template: { providerTemplateName: "gone_template", languageCode: "en" } } }),
      send({ providerMessageId: "wamid.5", status: "FAILED" }),
      send({ providerMessageId: "wamid.6", provider: "twilio" }),
    );
    T("whatsAppMessagePricing").push({ providerMessageId: "wamid.1", billable: true, category: "utility" });
    const e = await whatsappCosts(14, rates());
    expect(e.byCategory).toEqual([
      { category: "marketing", count: 1, fromMeta: 0, rate: 0.8, amount: 0.8 },
      { category: "utility", count: 1, fromMeta: 1, rate: 0.12, amount: 0.12 },
      { category: "service", count: 1, fromMeta: 0, rate: 0, amount: 0 },
    ]);
    expect(e).toMatchObject({ total: 0.92, uncategorized: { count: 1 }, failedExcluded: 1, twilioCount: 1, fromMetaData: 1, categoriesError: null });
  });

  it("before migration 0022 (no pricing table) it falls back to template categories", async () => {
    failPricing.on = true;
    T("whatsAppSend").push(send({ providerMessageId: "wamid.1" }));
    const e = await whatsappCosts(7, rates());
    expect(e.byCategory).toEqual([{ category: "marketing", count: 1, fromMeta: 0, rate: 0.8, amount: 0.8 }]);
  });

  it("if Meta can't be reached, template messages are Uncategorized (no guessed price)", async () => {
    listMessageTemplates.mockRejectedValueOnce(new Error("Meta 500"));
    T("whatsAppSend").push(send({ providerMessageId: "wamid.1" }));
    const e = await whatsappCosts(7, rates());
    expect(e).toMatchObject({ billableCount: 0, uncategorized: { count: 1 }, categoriesError: "Meta 500", total: 0 });
  });
});
