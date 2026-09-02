import cronParser from "cron-parser";
import { env } from "../env.js";
import { logger } from "../logger.js";
import { prisma } from "../prisma.js";
import { enqueueCampaignDispatch } from "./queues.js";
import { pruneJobs } from "./engine.js";

/**
 * Polls the campaigns table and enqueues a dispatch job whenever a campaign is
 * due. No repeatable-job machinery: a ONCE campaign is due when `sendAt` has
 * passed; a RECURRING one is due when its cron expression has an occurrence
 * between `lastRunAt` and now. Dispatch jobs carry a dedupe key so a double
 * tick never double-sends.
 *
 * Assumes a single scheduler instance (one worker process). Running two is
 * safe-ish thanks to the dedupe key, but not designed for.
 */

const TICK_MS = 15_000;

export async function scheduleCampaign(campaignId: string): Promise<void> {
  const campaign = await prisma.campaign.findUniqueOrThrow({ where: { id: campaignId } });
  if (campaign.scheduleType === "RECURRING") {
    if (!campaign.cronExpression) throw new Error("RECURRING campaign missing cronExpression");
    cronParser.parseExpression(campaign.cronExpression, { tz: env.SCHEDULER_TIMEZONE });
  } else if (!campaign.sendAt) {
    throw new Error("ONCE campaign missing sendAt");
  }
  await prisma.campaign.update({
    where: { id: campaignId },
    data: { status: "SCHEDULED", lastRunAt: null },
  });
  logger.info({ campaignId, type: campaign.scheduleType }, "campaign scheduled");
  // The next tick picks it up; also nudge immediately for near-term ONCE sends.
  await tick();
}

export async function unscheduleCampaign(campaignId: string): Promise<void> {
  // Nothing queued yet lives outside the Job table; pending dispatch jobs for a
  // paused campaign are cheap no-ops (fanOutCampaign checks status), but clear
  // them anyway to keep the table tidy.
  await prisma.job.deleteMany({
    where: { queue: "campaign-dispatch", status: "PENDING", dedupeKey: { startsWith: `disp:${campaignId}:` } },
  });
}

let running = false;

async function tick(): Promise<void> {
  if (running) return;
  running = true;
  try {
    const now = new Date();
    const scheduled = await prisma.campaign.findMany({ where: { status: "SCHEDULED" } });

    for (const c of scheduled) {
      if (c.scheduleType === "ONCE") {
        if (c.sendAt && c.sendAt <= now && !c.lastRunAt) {
          await enqueueCampaignDispatch(
            { campaignId: c.id, runDate: c.sendAt.toISOString().slice(0, 10) },
            { dedupeKey: `disp:${c.id}:once` },
          );
          await prisma.campaign.update({ where: { id: c.id }, data: { lastRunAt: now } });
          logger.info({ campaignId: c.id }, "one-time campaign due → dispatched");
        }
        continue;
      }

      // RECURRING: walk occurrences after the cursor up to now.
      if (!c.cronExpression) continue;
      let cursor = c.lastRunAt ?? c.createdAt;
      let fired = 0;
      for (;;) {
        let next: Date;
        try {
          next = cronParser
            .parseExpression(c.cronExpression, { currentDate: cursor, tz: env.SCHEDULER_TIMEZONE })
            .next()
            .toDate();
        } catch (err) {
          logger.error({ campaignId: c.id, err }, "bad cron expression");
          break;
        }
        if (next > now || fired >= 10) break;
        const occ = next.toISOString();
        await enqueueCampaignDispatch(
          { campaignId: c.id, runDate: occ.slice(0, 10) },
          { dedupeKey: `disp:${c.id}:${occ}` },
        );
        cursor = next;
        fired++;
      }
      if (fired > 0) {
        await prisma.campaign.update({ where: { id: c.id }, data: { lastRunAt: cursor } });
        logger.info({ campaignId: c.id, occurrences: fired }, "recurring campaign due → dispatched");
      }
    }
  } catch (err) {
    logger.error({ err }, "scheduler tick failed");
  } finally {
    running = false;
  }
}

export function startScheduler(): { stop: () => Promise<void> } {
  const interval = setInterval(() => void tick(), TICK_MS);
  const prune = setInterval(() => void pruneJobs().catch(() => undefined), 60 * 60 * 1000);
  void tick();
  return {
    stop: async () => {
      clearInterval(interval);
      clearInterval(prune);
    },
  };
}
