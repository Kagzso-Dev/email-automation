import type { Template } from "@prisma/client";
import { env } from "../env.js";
import { prisma } from "../prisma.js";
import { logger } from "../logger.js";
import { getProvider, PermanentSendError } from "../provider/index.js";
import { render, RenderError, type RenderInput } from "../render/render.js";
import { inlineLocalImages } from "../render/inlineImages.js";
import { unsubscribeUrl } from "../render/unsubscribe.js";
import { isSuppressed } from "./suppression.js";
import { isEmailDomainAllowed } from "./allowedDomains.js";
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
  if (source.type === "manual") {
    const template = await prisma.template.findUnique({ where: { id: source.templateId } });
    if (!template) throw new PermanentSendError(`Template ${source.templateId} gone`);
    return { template, campaignId: null, triggerId: null, payload: {} };
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

  // Approved-domain allowlist — a backstop to the import-time filter. When no
  // domains are configured this is a no-op (see domain/allowedDomains).
  if (!(await isEmailDomainAllowed(contact.email))) {
    await prisma.emailLog.update({
      where: { id: log.id },
      data: { status: "FAILED", errorMessage: "domain not approved" },
    });
    logger.info({ emailLogId: log.id, contactId, to: contact.email }, "send skipped: domain not approved");
    return { result: "skipped", emailLogId: log.id, reason: "domain not approved" };
  }

  // Only bulk marketing (campaigns) carries the CAN-SPAM footer + List-Unsubscribe
  // headers. Transactional/personal sends (trigger, manual) go out clean so Gmail
  // is less likely to file them under Promotions.
  const isBulkCampaign = source.type === "campaign";

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
      includeComplianceFooter: isBulkCampaign,
      kind: template.kind,
      links: template.links as RenderInput["links"],
      meeting: template.meeting as RenderInput["meeting"],
      imageUrl: template.imageUrl,
      videoUrl: template.videoUrl,
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

  // Uploaded images live under our /uploads path — inline them as cid: parts so
  // they render even when PUBLIC_API_URL isn't publicly reachable (e.g. dev).
  const { html: finalHtml, attachments: finalAttachments } = await inlineLocalImages(
    rendered.html,
    rendered.attachments,
  );

  logger.info(
    {
      emailLogId: log.id,
      to: contact.email,
      subject: rendered.subject,
      htmlBytes: finalHtml.length,
      imgSrcs: [...finalHtml.matchAll(/<img\b[^>]*\bsrc="([^"]+)"/gi)].map((m) => m[1]),
      attachments: finalAttachments?.map((a) => `${a.filename}${a.cid ? ` (cid:${a.cid})` : ""}`),
    },
    "outbound email payload (pre-send)",
  );
  logger.debug({ emailLogId: log.id, html: finalHtml }, "outbound email full html");

  const provider = getProvider();
  const { providerMessageId } = await provider.send({
    to: contact.email,
    from: env.EMAIL_FROM,
    subject: rendered.subject,
    html: finalHtml,
    text: rendered.text,
    attachments: finalAttachments,
    headers: isBulkCampaign
      ? {
          "List-Unsubscribe": `<${unsubscribeUrl(contactId)}>`,
          "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
        }
      : {},
    tags: { emailLogId: log.id },
  });

  await prisma.emailLog.update({
    where: { id: log.id },
    data: { status: "SENT", providerMessageId, sentAt: new Date(), subject: rendered.subject, errorMessage: null },
  });
  logger.info({ emailLogId: log.id, providerMessageId, to: contact.email }, "email sent");
  return { result: "sent", emailLogId: log.id, providerMessageId };
}
