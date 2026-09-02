import { parse as parseCsv } from "csv-parse/sync";
import { env } from "../env.js";
import { logger } from "../logger.js";
import { prisma } from "../prisma.js";
import { deliverEmail } from "../domain/delivery.js";
import { PermanentSendError } from "../provider/index.js";
import { DeferJobError, PermanentJobError, QueueWorker } from "./engine.js";
import { QUEUE, type CampaignDispatchJob, type CsvImportJob, type SendEmailJob } from "./queues.js";
import { dailyCapReached, msUntilNextWindow } from "./dailyCap.js";
import { fanOutCampaign } from "./dispatch.js";

/* ----------------------------------------------------- send-email */

const sendEmailWorker = new QueueWorker({
  queue: QUEUE.sendEmail,
  batch: 25,
  // Rate limit: one send per (1000 / rate) ms. SES sandbox default is 1/sec.
  minIntervalMs: Math.ceil(1000 / Math.max(1, env.SEND_RATE_PER_SEC)),
  backoffMs: env.SEND_BACKOFF_MS,
  pollMs: 1000,
  processor: async (payload) => {
    if (await dailyCapReached()) {
      const runAt = new Date(Date.now() + msUntilNextWindow());
      logger.warn({ runAt }, "daily cap reached — deferring send to next window");
      throw new DeferJobError(runAt);
    }
    try {
      return await deliverEmail(payload as unknown as SendEmailJob);
    } catch (err) {
      if (err instanceof PermanentSendError) throw new PermanentJobError(err.message);
      throw err; // TransientSendError and anything else → normal retry
    }
  },
});

/* ----------------------------------------------------- campaign-dispatch */

const campaignDispatchWorker = new QueueWorker({
  queue: QUEUE.campaignDispatch,
  batch: 5,
  backoffMs: 30_000,
  pollMs: 3000,
  processor: async (payload) => {
    const job = payload as unknown as CampaignDispatchJob;
    const runDate = job.runDate || new Date().toISOString().slice(0, 10);
    const enqueued = await fanOutCampaign(job.campaignId, runDate);
    return { enqueued };
  },
});

/* ----------------------------------------------------- csv-import */

const csvImportWorker = new QueueWorker({
  queue: QUEUE.csvImport,
  batch: 1,
  pollMs: 2000,
  processor: async (payload) => {
    const job = payload as unknown as CsvImportJob;
    const rows = parseCsv(job.fileContent, {
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
      const { first_name, last_name, firstName, lastName, ...rest } = row;
      delete (rest as Record<string, string>).email;
      delete (rest as Record<string, string>).Email;
      const data = {
        firstName: firstName || first_name || undefined,
        lastName: lastName || last_name || undefined,
        customFields: rest as Record<string, string>,
      };
      const existing = await prisma.contact.findUnique({ where: { email } });
      const contact = await prisma.contact.upsert({
        where: { email },
        create: { email, ...data },
        update: data, // CSV import = upsert on email (design §13)
      });
      if (existing) updated++;
      else created++;
      if (job.listId) {
        await prisma.listMembership.upsert({
          where: { listId_contactId: { listId: job.listId, contactId: contact.id } },
          create: { listId: job.listId, contactId: contact.id },
          update: {},
        });
      }
    }
    logger.info({ created, updated, skipped }, "csv import complete");
    return { created, updated, skipped, total: rows.length };
  },
});

export function startAllWorkers(): QueueWorker[] {
  return [sendEmailWorker.start(), campaignDispatchWorker.start(), csvImportWorker.start()];
}
