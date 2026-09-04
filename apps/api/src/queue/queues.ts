import { env } from "../env.js";
import { enqueue } from "./engine.js";

export const QUEUE = {
  campaignDispatch: "campaign-dispatch",
  sendEmail: "send-email",
  csvImport: "csv-import",
  manualBulkSend: "manual-bulk-send",
  whatsappBulkSend: "whatsapp-bulk-send",
} as const;

export interface CampaignDispatchJob {
  campaignId: string;
  runDate: string; // ISO date (YYYY-MM-DD) of this occurrence
}

export interface SendEmailJob {
  idempotencyKey: string;
  contactId: string;
  source:
    | { type: "campaign"; campaignId: string; runDate: string }
    | { type: "trigger"; triggerId: string; payload: Record<string, unknown> }
    | { type: "manual"; templateId: string };
}

export interface ContactImportJob {
  /** base64 of the uploaded file (csv/xlsx/pdf) */
  fileBase64: string;
  filename: string;
  format: "csv" | "xlsx" | "pdf";
  listId?: string;
}

/** Orchestrates one drip batch — sends one contact per run, then re-schedules itself. */
export interface ManualBulkSendJob {
  batchId: string;
}

/** Orchestrates one WhatsApp drip batch — one message per run, then re-schedules itself. */
export interface WhatsAppBulkSendJob {
  batchId: string;
  /**
   * Lead-generation purge: once the batch finishes, delete these contacts. The
   * WhatsApp send path reads only snapshots (item.phone), so the ids are
   * resolved at batch creation and carried here (survives DeferJobError).
   */
  purge?: { table: "whatsapp" | "contact"; ids: string[] };
}

export function enqueueSend(job: SendEmailJob, opts: { dedupeKey: string }) {
  return enqueue(QUEUE.sendEmail, job, {
    dedupeKey: opts.dedupeKey,
    maxAttempts: env.SEND_MAX_ATTEMPTS,
  });
}

export function enqueueCampaignDispatch(
  job: CampaignDispatchJob,
  opts?: { dedupeKey?: string; runAt?: Date },
) {
  return enqueue(QUEUE.campaignDispatch, job, {
    dedupeKey: opts?.dedupeKey,
    runAt: opts?.runAt,
    maxAttempts: 3,
  });
}

export function enqueueContactImport(job: ContactImportJob) {
  return enqueue(QUEUE.csvImport, job, { maxAttempts: 1 });
}

export function enqueueWhatsAppBulkSend(job: WhatsAppBulkSendJob) {
  // One job row per batch; it defers itself between messages (DeferJobError), so
  // a single attempt spans the whole batch. maxAttempts > 1 lets a transient
  // orchestration error retry rather than kill the batch.
  return enqueue(QUEUE.whatsappBulkSend, job, {
    maxAttempts: 5,
    dedupeKey: `whatsapp-bulk-send:${job.batchId}`,
  });
}

export function enqueueManualBulkSend(job: ManualBulkSendJob) {
  // One job row per batch; it defers itself between contacts (see engine's
  // DeferJobError), so a single attempt spans the whole batch.
  // maxAttempts > 1 so a transient error mid-orchestration retries rather than
  // killing the batch. DeferJobError (the between-contacts wait) decrements the
  // counter, so only consecutive hard failures accumulate toward the limit.
  return enqueue(QUEUE.manualBulkSend, job, {
    maxAttempts: 5,
    dedupeKey: `manual-bulk-send:${job.batchId}`,
  });
}
