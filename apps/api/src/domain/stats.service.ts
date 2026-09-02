import type { EmailStatus } from "@prisma/client";
import { prisma } from "../prisma.js";

const ZERO: Record<EmailStatus, number> = {
  QUEUED: 0,
  SENT: 0,
  DELIVERED: 0,
  OPENED: 0,
  CLICKED: 0,
  BOUNCED: 0,
  COMPLAINED: 0,
  FAILED: 0,
};

function rates(counts: Record<EmailStatus, number>) {
  // "Reached an inbox" = anything that got at least as far as SENT.
  const sent =
    counts.SENT + counts.DELIVERED + counts.OPENED + counts.CLICKED + counts.BOUNCED + counts.COMPLAINED;
  const delivered = counts.DELIVERED + counts.OPENED + counts.CLICKED;
  const opened = counts.OPENED + counts.CLICKED;
  const pct = (n: number, d: number) => (d === 0 ? 0 : Math.round((n / d) * 1000) / 10);
  return {
    total: sent + counts.QUEUED + counts.FAILED,
    sent,
    openRate: pct(opened, Math.max(delivered, sent)),
    clickRate: pct(counts.CLICKED, Math.max(delivered, sent)),
    bounceRate: pct(counts.BOUNCED, sent),
    complaintRate: pct(counts.COMPLAINED, sent),
  };
}

async function countsFor(where: { campaignId?: string; triggerId?: string }) {
  const grouped = await prisma.emailLog.groupBy({
    by: ["status"],
    where,
    _count: { _all: true },
  });
  const counts = { ...ZERO };
  for (const g of grouped) counts[g.status] = g._count._all;
  return counts;
}

export async function campaignStats(campaignId: string) {
  const counts = await countsFor({ campaignId });
  return { campaignId, counts, ...rates(counts) };
}

export async function triggerStats(triggerId: string) {
  const counts = await countsFor({ triggerId });
  return { triggerId, counts, ...rates(counts) };
}

export async function dashboardOverview() {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const [sentToday, grouped, contacts, activeCampaigns] = await Promise.all([
    prisma.emailLog.count({ where: { sentAt: { gte: since } } }),
    prisma.emailLog.groupBy({ by: ["status"], _count: { _all: true } }),
    prisma.contact.count({ where: { status: "ACTIVE" } }),
    prisma.campaign.count({ where: { status: { in: ["SCHEDULED", "SENDING"] } } }),
  ]);
  const counts = { ...ZERO };
  for (const g of grouped) counts[g.status] = g._count._all;
  return { sentToday, activeContacts: contacts, activeCampaigns, allTime: { counts, ...rates(counts) } };
}
