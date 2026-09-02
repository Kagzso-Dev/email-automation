import { QueueEvents } from "bullmq";
import { env } from "../env.js";
import { logger } from "../logger.js";
import { prisma } from "../prisma.js";
import { redis } from "../redis.js";
import { campaignDispatchQueue, connection } from "./queues.js";

const LOCK_KEY = "dispatch:scheduler:lock";
const LOCK_TTL = 30; // seconds

export function repeatKey(campaignId: string): string {
  return `campaign_${campaignId}`;
}

/** Register (or refresh) the BullMQ trigger for a scheduled campaign. */
export async function scheduleCampaign(campaignId: string): Promise<string> {
  const campaign = await prisma.campaign.findUniqueOrThrow({ where: { id: campaignId } });
  await unscheduleCampaign(campaignId);

  const jobName = repeatKey(campaignId);
  if (campaign.scheduleType === "ONCE") {
    if (!campaign.sendAt) throw new Error("ONCE campaign missing sendAt");
    const delay = Math.max(0, campaign.sendAt.getTime() - Date.now());
    await campaignDispatchQueue.add(
      jobName,
      { campaignId, runDate: campaign.sendAt.toISOString().slice(0, 10) },
      { delay, jobId: `once_${campaignId}` },
    );
  } else {
    if (!campaign.cronExpression) throw new Error("RECURRING campaign missing cronExpression");
    await campaignDispatchQueue.add(
      jobName,
      { campaignId, runDate: "" }, // runDate filled in at fire time below
      {
        repeat: { pattern: campaign.cronExpression, tz: env.SCHEDULER_TIMEZONE, key: jobName },
      },
    );
  }
  await prisma.campaign.update({
    where: { id: campaignId },
    data: { status: "SCHEDULED", repeatJobKey: jobName },
  });
  logger.info({ campaignId, type: campaign.scheduleType }, "campaign scheduled");
  return jobName;
}

export async function unscheduleCampaign(campaignId: string): Promise<void> {
  const jobName = repeatKey(campaignId);
  const repeatables = await campaignDispatchQueue.getRepeatableJobs();
  for (const r of repeatables) {
    if (r.name === jobName || r.key.includes(jobName)) {
      await campaignDispatchQueue.removeRepeatableByKey(r.key);
    }
  }
  await campaignDispatchQueue.remove(`once_${campaignId}`).catch(() => undefined);
}

/**
 * Singleton scheduler loop. Guarded by a Redis lock so multiple worker
 * replicas don't double-schedule. Also self-heals: re-registers repeatables
 * for any campaign that is SCHEDULED in the DB but missing from the queue.
 */
export function startScheduler(): { stop: () => Promise<void> } {
  let stopped = false;
  const events = new QueueEvents(campaignDispatchQueue.name, { connection });

  const tick = async () => {
    if (stopped) return;
    const gotLock = await redis.set(LOCK_KEY, process.pid.toString(), "EX", LOCK_TTL, "NX");
    if (!gotLock) return;
    try {
      await reconcile();
    } catch (err) {
      logger.error({ err }, "scheduler tick failed");
    } finally {
      await redis.del(LOCK_KEY);
    }
  };

  const interval = setInterval(tick, 15_000);
  void tick();

  return {
    stop: async () => {
      stopped = true;
      clearInterval(interval);
      await events.close();
    },
  };
}

async function reconcile(): Promise<void> {
  const scheduled = await prisma.campaign.findMany({ where: { status: "SCHEDULED" } });
  const repeatables = await campaignDispatchQueue.getRepeatableJobs();
  const delayed = await campaignDispatchQueue.getJobs(["delayed", "waiting"]);
  for (const c of scheduled) {
    const jobName = repeatKey(c.id);
    const hasRepeat = repeatables.some((r) => r.name === jobName);
    const hasOnce = delayed.some((j) => j.id === `once_${c.id}`);
    if (c.scheduleType === "RECURRING" && !hasRepeat) {
      logger.warn({ campaignId: c.id }, "scheduler: re-registering missing repeatable");
      await scheduleCampaign(c.id);
    }
    if (c.scheduleType === "ONCE" && !hasOnce && c.sendAt && c.sendAt.getTime() > Date.now()) {
      logger.warn({ campaignId: c.id }, "scheduler: re-registering missing one-time job");
      await scheduleCampaign(c.id);
    }
  }
}
