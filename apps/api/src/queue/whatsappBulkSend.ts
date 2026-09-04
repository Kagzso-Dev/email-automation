// Orchestrator for one WhatsApp drip batch. Mirrors queue/manualBulkSend.ts but
// calls services/whatsapp.ts — no email code, no daily-cap gate.

import { prisma } from "../prisma.js";
import { logger } from "../logger.js";
import { pickDelayMs } from "../domain/whatsappSend.js";
import { sendWhatsAppTemplate, WhatsAppSendError } from "../services/whatsapp.js";
import { DeferJobError } from "./engine.js";
import type { WhatsAppBulkSendJob } from "./queues.js";

/**
 * Lead-generation flow: delete every recipient this batch targeted. `purge.ids`
 * are whatsapp_contacts ids or email contacts ids depending on the send source
 * (resolved at batch creation). WhatsAppSend.whatsappContactId is onDelete:
 * SetNull, and EmailLog on a contact has no cascade so it's cleared first.
 */
async function purgeBatchContacts(purge: { table: "whatsapp" | "contact"; ids: string[] }): Promise<number> {
  const ids = [...new Set(purge.ids)];
  if (ids.length === 0) return 0;
  if (purge.table === "whatsapp") {
    const { count } = await prisma.whatsAppContact.deleteMany({ where: { id: { in: ids } } });
    return count;
  }
  await prisma.$transaction([
    prisma.emailLog.deleteMany({ where: { contactId: { in: ids } } }),
    prisma.contact.deleteMany({ where: { id: { in: ids } } }),
  ]);
  return ids.length;
}

async function finish(
  batchId: string,
  purge?: { table: "whatsapp" | "contact"; ids: string[] },
): Promise<Record<string, number>> {
  await prisma.whatsAppSendBatch.update({
    where: { id: batchId },
    data: { status: "DONE", nextItemAt: null },
  });
  const rows = await prisma.whatsAppSend.groupBy({
    by: ["status"],
    where: { batchId },
    _count: { _all: true },
  });
  const counts: Record<string, number> = {};
  for (const r of rows) counts[r.status] = r._count._all;
  logger.info({ batchId, ...counts }, "whatsapp drip batch complete");
  if (purge) {
    const removed = await purgeBatchContacts(purge);
    logger.info({ batchId, removed, table: purge.table }, "whatsapp drip batch purged its contacts");
  }
  return counts;
}

/**
 * One iteration: send the next QUEUED item, record the outcome, then re-schedule
 * this job `random(min,max)` seconds later via DeferJobError (which does not
 * consume a retry attempt). A per-message failure is caught and recorded — the
 * batch always moves on. Stops when no QUEUED items remain or the batch is no
 * longer RUNNING (cancelled).
 */
export async function processWhatsAppBulkSend(payload: Record<string, unknown>): Promise<unknown> {
  const { batchId, purge } = payload as unknown as WhatsAppBulkSendJob;

  const batch = await prisma.whatsAppSendBatch.findUnique({
    where: { id: batchId },
    include: { template: true },
  });
  if (!batch) return { skipped: "batch gone" };
  if (batch.status !== "RUNNING") return { skipped: `batch ${batch.status}` };

  const item = await prisma.whatsAppSend.findFirst({
    where: { batchId, status: "QUEUED" },
    orderBy: { createdAt: "asc" },
  });
  if (!item) return { done: true, ...(await finish(batchId, purge)) };

  await prisma.whatsAppSend.update({ where: { id: item.id }, data: { status: "SENDING" } });

  try {
    const contentVariables = (item.contentVariables ?? {}) as Record<string, string>;
    const { providerMessageId } = await sendWhatsAppTemplate({
      to: item.phone,
      contentSid: batch.template.contentSid,
      contentVariables,
    });
    await prisma.whatsAppSend.update({
      where: { id: item.id },
      data: { status: "SENT", providerMessageId, sentAt: new Date(), error: null },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await prisma.whatsAppSend.update({
      where: { id: item.id },
      data: { status: "FAILED", error: message.slice(0, 2000) },
    });
    const retryable = err instanceof WhatsAppSendError && err.retryable;
    logger.warn(
      { batchId, itemId: item.id, err: message, retryable },
      "whatsapp drip item failed — continuing batch",
    );
  }

  // Re-read status so a cancel that landed mid-send stops the loop here.
  const fresh = await prisma.whatsAppSendBatch.findUnique({
    where: { id: batchId },
    select: { status: true },
  });
  if (fresh?.status !== "RUNNING") {
    await prisma.whatsAppSendBatch.update({ where: { id: batchId }, data: { nextItemAt: null } });
    return { stopped: fresh?.status ?? "gone" };
  }

  const remaining = await prisma.whatsAppSend.count({ where: { batchId, status: "QUEUED" } });
  if (remaining === 0) return { done: true, ...(await finish(batchId, purge)) };

  const runAt = new Date(Date.now() + pickDelayMs(batch.minDelaySec, batch.maxDelaySec));
  await prisma.whatsAppSendBatch.update({ where: { id: batchId }, data: { nextItemAt: runAt } });
  throw new DeferJobError(runAt);
}
