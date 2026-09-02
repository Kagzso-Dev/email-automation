import { Queue } from "bullmq";
import { createRedis } from "../redis.js";

export const connection = createRedis();

export const QUEUE = {
  campaignDispatch: "campaign-dispatch",
  sendEmail: "send-email",
  csvImport: "csv-import",
  sendEmailDlq: "send-email-dlq",
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

export interface DlqJob extends SendEmailJob {
  reason: string;
  failedAt: string;
}

const defaultJobOptions = {
  removeOnComplete: { count: 1000, age: 60 * 60 * 24 },
  removeOnFail: { count: 5000 },
};

export const campaignDispatchQueue = new Queue<CampaignDispatchJob>(QUEUE.campaignDispatch, {
  connection,
  defaultJobOptions,
});
export const sendEmailQueue = new Queue<SendEmailJob>(QUEUE.sendEmail, {
  connection,
  defaultJobOptions,
});
export const csvImportQueue = new Queue<CsvImportJob>(QUEUE.csvImport, {
  connection,
  defaultJobOptions,
});
export const dlqQueue = new Queue<DlqJob>(QUEUE.sendEmailDlq, {
  connection,
  defaultJobOptions: { removeOnComplete: false, removeOnFail: false },
});

export const allQueues = [campaignDispatchQueue, sendEmailQueue, csvImportQueue, dlqQueue];
