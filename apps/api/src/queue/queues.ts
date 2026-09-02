import { env } from "../env.js";
import { enqueue } from "./engine.js";

export const QUEUE = {
  campaignDispatch: "campaign-dispatch",
  sendEmail: "send-email",
  csvImport: "csv-import",
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
    | { type: "trigger"; triggerId: string; payload: Record<string, unknown> };
}

export interface CsvImportJob {
  fileContent: string;
  listId?: string;
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

export function enqueueCsvImport(job: CsvImportJob) {
  return enqueue(QUEUE.csvImport, job, { maxAttempts: 1 });
}
