import type { EmailStatus } from "@prisma/client";
import { prisma } from "../prisma.js";
import { logger } from "../logger.js";
import type { DeliveryEvent } from "../provider/index.js";
import { suppressForBounce, suppressForComplaint } from "./suppression.js";

// Rank so status only ever advances (opens can't overwrite a later bounce, etc.).
const RANK: Record<EmailStatus, number> = {
  QUEUED: 0,
  FAILED: 1,
  SENT: 2,
  DELIVERED: 3,
  OPENED: 4,
  CLICKED: 5,
  BOUNCED: 6,
  COMPLAINED: 7,
};

async function advance(logId: string, to: EmailStatus, extra: Record<string, unknown> = {}) {
  const log = await prisma.emailLog.findUnique({ where: { id: logId } });
  if (!log) return;
  if (RANK[to] <= RANK[log.status] && !(to === "OPENED" && log.status === "CLICKED")) {
    // idempotent: a repeat event is a no-op
    if (Object.keys(extra).length === 0) return;
  }
  const nextStatus = RANK[to] > RANK[log.status] ? to : log.status;
  await prisma.emailLog.update({ where: { id: logId }, data: { status: nextStatus, ...extra } });
}

export async function recordOpen(logId: string): Promise<void> {
  const log = await prisma.emailLog.findUnique({ where: { id: logId } });
  if (!log) return;
  await advance(logId, "OPENED", log.openedAt ? {} : { openedAt: new Date() });
}

export async function recordClick(logId: string): Promise<void> {
  const log = await prisma.emailLog.findUnique({ where: { id: logId } });
  if (!log) return;
  await advance(logId, "CLICKED", log.clickedAt ? {} : { clickedAt: new Date() });
}

export async function applyDeliveryEvent(ev: DeliveryEvent): Promise<void> {
  const log = await prisma.emailLog.findFirst({
    where: { providerMessageId: ev.providerMessageId },
    orderBy: { createdAt: "desc" },
  });
  if (!log) {
    logger.warn({ providerMessageId: ev.providerMessageId, type: ev.type }, "delivery event: no matching EmailLog");
    return;
  }
  switch (ev.type) {
    case "delivered":
      await advance(log.id, "DELIVERED");
      break;
    case "bounced":
      await advance(log.id, "BOUNCED", { errorMessage: ev.detail ?? "bounce" });
      await suppressForBounce(log.contactId, ev.hard);
      break;
    case "complained":
      await advance(log.id, "COMPLAINED", { errorMessage: ev.detail ?? "complaint" });
      await suppressForComplaint(log.contactId);
      break;
  }
  logger.info({ emailLogId: log.id, type: ev.type }, "delivery event applied");
}
