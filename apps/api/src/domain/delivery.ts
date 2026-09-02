import type { Template } from "@prisma/client";
import { env } from "../env.js";
import { prisma } from "../prisma.js";
import { logger } from "../logger.js";
import { getProvider, PermanentSendError } from "../provider/index.js";
import { render, RenderError } from "../render/render.js";
import { unsubscribeUrl } from "../render/unsubscribe.js";
import { isSuppressed } from "./suppression.js";
import { buildVars } from "./vars.js";
import type { SendEmailJob } from "../queue/queues.js";

export type DeliveryOutcome =
  | { result: "sent"; emailLogId: string; providerMessageId: string }
  | { result: "skipped"; emailLogId: string; reason: string }
  | { result: "duplicate"; emailLogId: string };

async function resolveTemplate(source: SendEmailJob["source"]): Promise<{
  template: Template;
  campaignId: string | null;
  triggerId: string | null;
  payload: Record<string, unknown>;
}> {
  if (source.type === "campaign") {
    const campaign = await prisma.campaign.findUnique({
      where: { id: source.campaignId },
      include: { template: true },
    });
    if (!campaign) throw new PermanentSendError(`Campaign ${source.campaignId} gone`);
    return { template: campaign.template, campaignId: campaign.id, triggerId: null, payload: {} };
  }
  const trigger = await prisma.trigger.findUnique({
    where: { id: source.triggerId },
    include: { template: true },
  });
  if (!trigger) throw new PermanentSendError(`Trigger ${source.triggerId} gone`);
  return { template: trigger.template, campaignId: null, triggerId: trigger.id, payload: source.payload };
}

/**
 * Deliver exactly one email. Idempotent on `idempotencyKey`. Callers (the
 * worker) own retry/backoff and the daily-cap gate; this function owns the
 * suppression check, the ledger row, rendering and the provider call.
 */
export async function deliverEmail(job: SendEmailJob): Promise<DeliveryOutcome> {
  const { idempotencyKey, contactId, source } = job;

  const existing = await prisma.emailLog.findUnique({ where: { idempotencyKey } });
  if (existing && existing.status !== "QUEUED" && existing.status !== "FAILED") {
    return { result: "duplicate", emailLogId: existing.id };
  }

  const contact = await prisma.contact.findUnique({ where: { id: contactId } });
  if (!contact) throw new PermanentSendError(`Contact ${contactId} gone`);

  const { template, campaignId, triggerId, payload } = await resolveTemplate(source);

  // Upsert the ledger row first so it exists even if the send throws.
  const log = await prisma.emailLog.upsert({
    where: { idempotencyKey },
    create: { idempotencyKey, contactId, campaignId, triggerId, status: "QUEUED", subject: template.subject },
    update: {},
  });

  // Suppression is re-checked here, never trusted from enqueue time.
  if (await isSuppressed(contactId)) {
    await prisma.emailLog.update({
      where: { id: log.id },
      data: { status: "FAILED", errorMessage: "suppressed" },
    });
    logger.info({ emailLogId: log.id, contactId }, "send skipped: suppressed");
    return { result: "skipped", emailLogId: log.id, reason: "suppressed" };
  }

  const declared = Array.isArray(template.variables) ? (template.variables as string[]) : [];
  let rendered;
  try {
    rendered = render({
      subject: template.subject,
      htmlBody: template.htmlBody,
      textBody: template.textBody,
      declaredVariables: declared,
      vars: buildVars(contact, payload),
      emailLogId: log.id,
      unsubscribeUrl: unsubscribeUrl(contactId),
    });
  } catch (err) {
    if (err instanceof RenderError) {
      await prisma.emailLog.update({
        where: { id: log.id },
        data: { status: "FAILED", errorMessage: err.message },
      });
      throw new PermanentSendError(`render: ${err.message}`);
    }
    throw err;
  }

  const provider = getProvider();
  const { providerMessageId } = await provider.send({
    to: contact.email,
    from: env.EMAIL_FROM,
    subject: rendered.subject,
    html: rendered.html,
    text: rendered.text,
    headers: {
      "List-Unsubscribe": `<${unsubscribeUrl(contactId)}>`,
      "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
    },
    tags: { emailLogId: log.id },
  });

  await prisma.emailLog.update({
    where: { id: log.id },
    data: { status: "SENT", providerMessageId, sentAt: new Date(), subject: rendered.subject, errorMessage: null },
  });
  logger.info({ emailLogId: log.id, providerMessageId, to: contact.email }, "email sent");
  return { result: "sent", emailLogId: log.id, providerMessageId };
}
