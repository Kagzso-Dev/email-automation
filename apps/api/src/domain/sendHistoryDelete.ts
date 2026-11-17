// Send Queue → per-row Delete: remove one entry from a tab's send history.
//
//   email         one ManualSendBatch + its recipient rows (cascade). Email Logs, contacts and the
//                 template are not touched.
//   whatsapp      one WhatsAppSendBatch + its whatsapp_sends rows (cascade) + their whatsapp_send_media
//                 rows (no foreign key, so cleared here). Contacts and templates are not touched.
//   ai-followups  one AiCallFollowup row. The WhatsApp batch or AI call run it handed over to stays.
//
// Never while something is still in progress: a batch that is still sending, a follow-up still
// waiting for approval, or an approved call that has not been dialled yet (deleting it would
// silently cancel the call). Each delete re-checks that state in its WHERE, so a row that changed
// between the check and the delete is refused rather than removed.

import { prisma } from "../prisma.js";
import { logger } from "../logger.js";
import { addCustomerEvent } from "./aiCallFollowups.js";

export type DeleteHistoryResult = { ok: true } | { ok: false; status: 404 | 409; message: string };

const STILL_SENDING = "This send is still running. Wait for it to finish, then delete it.";
const CHANGED = "This entry just changed. Reload the page and try again.";

/** whatsapp_send_media rows deleted per statement (keeps the IN list small). */
const MEDIA_CHUNK = 500;

export async function deleteEmailBatch(id: string, actorEmail: string): Promise<DeleteHistoryResult> {
  const batch = await prisma.manualSendBatch.findUnique({ where: { id }, select: { status: true, total: true } });
  if (!batch) return { ok: false, status: 404, message: "Send batch not found" };
  if (batch.status === "RUNNING") return { ok: false, status: 409, message: STILL_SENDING };

  const { count } = await prisma.manualSendBatch.deleteMany({ where: { id, status: { not: "RUNNING" } } });
  if (count === 0) return { ok: false, status: 409, message: CHANGED };
  logger.info({ batchId: id, recipients: batch.total, by: actorEmail }, "send queue: email batch deleted");
  return { ok: true };
}

export async function deleteWhatsAppBatch(id: string, actorEmail: string): Promise<DeleteHistoryResult> {
  const batch = await prisma.whatsAppSendBatch.findUnique({ where: { id }, select: { status: true, total: true } });
  if (!batch) return { ok: false, status: 404, message: "WhatsApp send batch not found" };
  if (batch.status === "RUNNING") return { ok: false, status: 409, message: STILL_SENDING };

  const sendIds = (await prisma.whatsAppSend.findMany({ where: { batchId: id }, select: { id: true } })).map((s) => s.id);
  const mediaDeletes = [];
  for (let i = 0; i < sendIds.length; i += MEDIA_CHUNK) {
    mediaDeletes.push(prisma.whatsAppSendMedia.deleteMany({ where: { sendId: { in: sendIds.slice(i, i + MEDIA_CHUNK) } } }));
  }
  const results = await prisma.$transaction([
    ...mediaDeletes,
    prisma.whatsAppSendBatch.deleteMany({ where: { id, status: { not: "RUNNING" } } }),
  ]);
  // Media rows are only removed together with their batch: a refused batch delete rolls them back too.
  if (results[results.length - 1]!.count === 0) return { ok: false, status: 409, message: CHANGED };
  logger.info({ batchId: id, recipients: batch.total, by: actorEmail }, "send queue: whatsapp batch deleted");
  return { ok: true };
}

export async function deleteFollowup(id: string, actorEmail: string): Promise<DeleteHistoryResult> {
  const f = await prisma.aiCallFollowup.findUnique({
    where: { id },
    select: { status: true, channel: true, aiCallRunId: true, customerId: true },
  });
  if (!f) return { ok: false, status: 404, message: "Follow-up not found" };
  if (f.status === "PENDING_APPROVAL") {
    return { ok: false, status: 409, message: "This follow-up is still waiting for approval. Reject it first, then delete it." };
  }
  if (f.status === "APPROVED" && f.channel === "CALL" && !f.aiCallRunId) {
    return { ok: false, status: 409, message: "This call is still scheduled. It can be deleted once the call has been made." };
  }

  const { count } = await prisma.aiCallFollowup.deleteMany({ where: { id, status: f.status, aiCallRunId: f.aiCallRunId } });
  if (count === 0) return { ok: false, status: 409, message: CHANGED };
  // The customer's timeline keeps a note that it existed and who removed it. The delete has
  // already happened, so a failure here is logged, not reported as a failed delete.
  await addCustomerEvent({ customerId: f.customerId, type: "followup_deleted", refId: id, actorEmail }).catch((err: unknown) =>
    logger.warn({ followupId: id, err: err instanceof Error ? err.message : String(err) }, "follow-up deleted, timeline note failed"),
  );
  logger.info({ followupId: id, by: actorEmail }, "send queue: ai call follow-up deleted");
  return { ok: true };
}
