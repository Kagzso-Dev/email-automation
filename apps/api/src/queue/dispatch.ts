import { logger } from "../logger.js";
import { prisma } from "../prisma.js";
import { campaignKey, queueJobId } from "../domain/idempotency.js";
import { isHardStopEnabled } from "../config/hardStop.js";
import { stopCoveringFanOut } from "../domain/hardStop.js";
import { enqueueSend, type SendEmailJob } from "./queues.js";

const BATCH = 500;

/**
 * Expand a campaign into one send-email job per list member. Batched so a huge
 * list doesn't build one giant unit of work, and each contact retries
 * independently. Idempotent per (campaign, contact, occurrence) via the job
 * dedupe key.
 */
export async function fanOutCampaign(campaignId: string, runDate: string): Promise<number> {
  const campaign = await prisma.campaign.findUnique({ where: { id: campaignId } });
  if (!campaign) {
    logger.warn({ campaignId }, "fan-out: campaign gone");
    return 0;
  }
  if (!["SCHEDULED", "SENDING"].includes(campaign.status)) {
    logger.info({ campaignId, status: campaign.status }, "fan-out: campaign not sendable, skipping");
    return 0;
  }

  // Hard stop (ENABLE_HARD_STOP): when this fan-out started, stamped on each email so a stop applied after it covers
  // every email of this fan-out, including a chunk enqueued while the stop was being pressed.
  const hardStop = isHardStopEnabled();
  const dispatchedAt = new Date();
  if (hardStop) {
    // Only while still scheduled / sending: a stop that paused it first wins.
    const { count } = await prisma.campaign.updateMany({
      where: { id: campaignId, status: { in: ["SCHEDULED", "SENDING"] } },
      data: { status: "SENDING", lastRunAt: dispatchedAt },
    });
    if (count === 0) return 0;
  } else {
    await prisma.campaign.update({
      where: { id: campaignId },
      data: { status: "SENDING", lastRunAt: new Date() },
    });
  }

  const runDay = new Date(runDate);
  let cursor: string | undefined;
  let total = 0;

  for (;;) {
    // Hard stop check point before each chunk: a stopped fan-out enqueues nothing more.
    if (hardStop && (await stopCoveringFanOut(campaignId, dispatchedAt))) {
      logger.info({ campaignId, enqueued: total }, "fan-out stopped by a hard stop");
      return total;
    }
    const members = await prisma.listMembership.findMany({
      where: { listId: campaign.listId },
      select: { contactId: true },
      orderBy: { contactId: "asc" },
      take: BATCH,
      ...(cursor
        ? { skip: 1, cursor: { listId_contactId: { listId: campaign.listId, contactId: cursor } } }
        : {}),
    });
    if (members.length === 0) break;

    for (const m of members) {
      const key = campaignKey(campaignId, m.contactId, runDay);
      const source: SendEmailJob["source"] = { type: "campaign", campaignId, runDate };
      await enqueueSend(
        { idempotencyKey: key, contactId: m.contactId, source, ...(hardStop ? { dispatchedAt: dispatchedAt.toISOString() } : {}) },
        { dedupeKey: queueJobId(key) },
      );
    }
    total += members.length;
    cursor = members[members.length - 1]!.contactId;
    if (members.length < BATCH) break;
  }

  if (hardStop) {
    // Only while still SENDING, so a fan-out never overwrites the PAUSED a hard stop set.
    await prisma.campaign.updateMany({
      where: { id: campaignId, status: "SENDING" },
      data: { status: campaign.scheduleType === "ONCE" ? "SENT" : "SCHEDULED" },
    });
  } else {
    await prisma.campaign.update({
      where: { id: campaignId },
      data: { status: campaign.scheduleType === "ONCE" ? "SENT" : "SCHEDULED" },
    });
  }

  logger.info({ campaignId, enqueued: total }, "campaign fanned out");
  return total;
}
