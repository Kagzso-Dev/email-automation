// Meta's pricing info for messages we sent, captured from status webhooks
// (statuses[].pricing: billable, category, pricing_model). Read only by the
// Dashboard cost estimate — the amount always comes from the rate card.
//
// Safety: recordStatusPricing() is called by the webhook AFTER the existing
// status update has finished, and it never throws — any problem (including the
// table not existing before migration 0022) is logged and ignored, so it can
// never change the status update, the Send Queue or the webhook's 200 response.

import { prisma } from "../prisma.js";
import { logger } from "../logger.js";

export interface MetaStatusPricing {
  billable?: boolean;
  category?: string;
  pricing_model?: string;
}

export async function recordStatusPricing(status: { id?: string; pricing?: MetaStatusPricing | null }): Promise<void> {
  try {
    const p = status.pricing;
    if (!status.id || !p || typeof p !== "object") return;
    const data = {
      billable: typeof p.billable === "boolean" ? p.billable : null,
      category: typeof p.category === "string" ? p.category.slice(0, 64).toLowerCase() : null,
      pricingModel: typeof p.pricing_model === "string" ? p.pricing_model.slice(0, 32) : null,
    };
    await prisma.whatsAppMessagePricing.upsert({
      where: { providerMessageId: status.id.slice(0, 191) },
      create: { providerMessageId: status.id.slice(0, 191), ...data },
      update: data,
    });
  } catch (err) {
    logger.warn(
      { wamid: status?.id, err: err instanceof Error ? err.message : String(err) },
      "whatsapp pricing info not saved (ignored — status handling is unaffected)",
    );
  }
}
