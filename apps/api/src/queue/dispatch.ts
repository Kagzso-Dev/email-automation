import { logger } from "../logger.js";
import { prisma } from "../prisma.js";
import { campaignKey, queueJobId } from "../domain/idempotency.js";
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

  await prisma.campaign.update({
    where: { id: campaignId },
    data: { status: "SENDING", lastRunAt: new Date() },
  });

  const runDay = new Date(runDate);
  let cursor: string | undefined;
  let total = 0;

  for (;;) {
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
        { idempotencyKey: key, contactId: m.contactId, source },
        { dedupeKey: queueJobId(key) },
      );
    }
    total += members.length;
    cursor = members[members.length - 1]!.contactId;
    if (members.length < BATCH) break;
  }

  await prisma.campaign.update({
    where: { id: campaignId },
    data: { status: campaign.scheduleType === "ONCE" ? "SENT" : "SCHEDULED" },
  });

  logger.info({ campaignId, enqueued: total }, "campaign fanned out");
  return total;
}
