import { DelayedError, Worker, UnrecoverableError } from "bullmq";
import { parse as parseCsv } from "csv-parse/sync";
import { env } from "../env.js";
import { logger } from "../logger.js";
import { prisma } from "../prisma.js";
import { deliverEmail } from "../domain/delivery.js";
import { PermanentSendError } from "../provider/index.js";
import {
  type CampaignDispatchJob,
  type CsvImportJob,
  connection,
  dlqQueue,
  QUEUE,
  type SendEmailJob,
} from "./queues.js";
import { dailyCapReached, incrementDailyCount, msUntilNextWindow } from "./dailyCap.js";
import { fanOutCampaign } from "./dispatch.js";

/* ----------------------------------------------------- send-email worker */

export function startSendEmailWorker(): Worker<SendEmailJob> {
  const worker = new Worker<SendEmailJob>(
    QUEUE.sendEmail,
    async (job, token) => {
      if (await dailyCapReached()) {
        const delay = msUntilNextWindow();
        logger.warn({ jobId: job.id, delay }, "daily cap reached — deferring send to next window");
        await job.moveToDelayed(Date.now() + delay, token);
        throw new DelayedError();
      }

      const outcome = await deliverEmail(job.data);
      if (outcome.result === "sent") await incrementDailyCount();
      return outcome;
    },
    {
      connection,
      concurrency: env.SEND_WORKER_CONCURRENCY,
      limiter: { max: env.SEND_RATE_PER_SEC, duration: 1000 },
    },
  );

  worker.on("failed", async (job, err) => {
    if (!job) return;
    if (err instanceof DelayedError) return;
    const permanent = err instanceof PermanentSendError || err instanceof UnrecoverableError;
    const exhausted = job.attemptsMade >= (job.opts.attempts ?? 1);
    if (permanent || exhausted) {
      logger.error({ jobId: job.id, err: err.message, permanent }, "send permanently failed → DLQ");
      await dlqQueue.add("dead", {
        ...job.data,
        reason: err.message,
        failedAt: new Date().toISOString(),
      });
      await prisma.emailLog
        .update({
          where: { idempotencyKey: job.data.idempotencyKey },
          data: { status: "FAILED", errorMessage: err.message },
        })
        .catch(() => undefined);
    } else {
      logger.warn({ jobId: job.id, attempt: job.attemptsMade, err: err.message }, "send failed — will retry");
    }
  });

  return worker;
}

/* ----------------------------------------------------- campaign-dispatch worker */

export function startCampaignDispatchWorker(): Worker<CampaignDispatchJob> {
  const worker = new Worker<CampaignDispatchJob>(
    QUEUE.campaignDispatch,
    async (job) => {
      // Recurring repeatables arrive with an empty runDate — stamp it at fire time.
      const runDate = job.data.runDate || new Date().toISOString().slice(0, 10);
      const enqueued = await fanOutCampaign(job.data.campaignId, runDate);
      return { enqueued };
    },
    { connection, concurrency: 1 },
  );
  worker.on("failed", (job, err) =>
    logger.error({ jobId: job?.id, err: err.message }, "campaign dispatch failed"),
  );
  return worker;
}

/* ----------------------------------------------------- csv-import worker */

export function startCsvImportWorker(): Worker<CsvImportJob> {
  const worker = new Worker<CsvImportJob>(
    QUEUE.csvImport,
    async (job) => {
      const rows = parseCsv(job.data.fileContent, {
        columns: true,
        skip_empty_lines: true,
        trim: true,
      }) as Record<string, string>[];

      let created = 0;
      let updated = 0;
      let skipped = 0;
      for (const row of rows) {
        const email = (row.email ?? row.Email ?? "").toLowerCase().trim();
        if (!email || !email.includes("@")) {
          skipped++;
          continue;
        }
        const { email: _e, Email: _E, first_name, last_name, firstName, lastName, ...rest } = row;
        const data = {
          firstName: firstName || first_name || undefined,
          lastName: lastName || last_name || undefined,
          customFields: rest,
        };
        const existing = await prisma.contact.findUnique({ where: { email } });
        const contact = await prisma.contact.upsert({
          where: { email },
          create: { email, ...data },
          update: data, // CSV import = upsert on email (see design §13)
        });
        existing ? updated++ : created++;
        if (job.data.listId) {
          await prisma.listMembership.upsert({
            where: { listId_contactId: { listId: job.data.listId, contactId: contact.id } },
            create: { listId: job.data.listId, contactId: contact.id },
            update: {},
          });
        }
      }
      logger.info({ jobId: job.id, created, updated, skipped }, "csv import complete");
      return { created, updated, skipped, total: rows.length };
    },
    { connection, concurrency: 1 },
  );
  worker.on("failed", (job, err) =>
    logger.error({ jobId: job?.id, err: err.message }, "csv import failed"),
  );
  return worker;
}

export function startAllWorkers() {
  return [startSendEmailWorker(), startCampaignDispatchWorker(), startCsvImportWorker()];
}
