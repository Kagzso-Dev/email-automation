import type { EmailStatus, Prisma } from "@prisma/client";
import { prisma } from "../prisma.js";

const DAY_MS = 24 * 60 * 60 * 1000;

/** YYYY-MM-DD in UTC — the bucket key for day-grained series. */
function dayKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function startOfUtcDay(d: Date): Date {
  const c = new Date(d);
  c.setUTCHours(0, 0, 0, 0);
  return c;
}

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

/**
 * Day-grained counts of send / open / click events over the last `span` days,
 * optionally scoped to one campaign or trigger. Each event is bucketed by the
 * day its timestamp falls on, so a mail sent Monday and opened Wednesday adds to
 * `sent` on Monday and `opened` on Wednesday.
 */
async function eventSeries(where: Prisma.EmailLogWhereInput, span: number) {
  const start = startOfUtcDay(new Date(Date.now() - (span - 1) * DAY_MS));
  const logs = await prisma.emailLog.findMany({
    where: {
      ...where,
      OR: [
        { sentAt: { gte: start } },
        { openedAt: { gte: start } },
        { clickedAt: { gte: start } },
      ],
    },
    select: { sentAt: true, openedAt: true, clickedAt: true },
  });

  const buckets = new Map<string, { sent: number; opened: number; clicked: number }>();
  for (let i = 0; i < span; i++) {
    buckets.set(dayKey(new Date(start.getTime() + i * DAY_MS)), { sent: 0, opened: 0, clicked: 0 });
  }
  const bump = (d: Date | null, key: "sent" | "opened" | "clicked") => {
    if (!d) return;
    const b = buckets.get(dayKey(d));
    if (b) b[key] += 1;
  };
  for (const l of logs) {
    bump(l.sentAt, "sent");
    bump(l.openedAt, "opened");
    bump(l.clickedAt, "clicked");
  }
  return [...buckets.entries()].map(([date, v]) => ({ date, ...v }));
}

export async function dashboardTimeseries(days = 30) {
  const span = Math.min(Math.max(Math.round(days) || 30, 7), 90);
  return { span, points: await eventSeries({}, span) };
}

export async function campaignStats(campaignId: string) {
  const [counts, series] = await Promise.all([
    countsFor({ campaignId }),
    eventSeries({ campaignId }, 14),
  ]);
  return { campaignId, counts, series, ...rates(counts) };
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

function pctChange(now: number, prev: number): number | null {
  if (prev === 0) return now === 0 ? 0 : null;
  return Math.round(((now - prev) / prev) * 1000) / 10;
}

/**
 * Derived, narrative-oriented metrics for the Insights view: deliverability
 * health, week-over-week engagement and volume, audience growth and the
 * strongest campaign.
 */
export async function dashboardInsights() {
  const now = Date.now();
  const weekAgo = new Date(now - 7 * DAY_MS);
  const twoWeeksAgo = new Date(now - 14 * DAY_MS);

  const [lifetimeGrouped, recent, campaignGrouped, campaigns, addedNow, addedPrev] =
    await Promise.all([
      prisma.emailLog.groupBy({ by: ["status"], _count: { _all: true } }),
      prisma.emailLog.findMany({
        where: { OR: [{ sentAt: { gte: twoWeeksAgo } }, { openedAt: { gte: twoWeeksAgo } }] },
        select: { sentAt: true, openedAt: true },
      }),
      prisma.emailLog.groupBy({
        by: ["campaignId", "status"],
        where: { campaignId: { not: null } },
        _count: { _all: true },
      }),
      prisma.campaign.findMany({ select: { id: true, name: true } }),
      prisma.contact.count({ where: { createdAt: { gte: weekAgo } } }),
      prisma.contact.count({ where: { createdAt: { gte: twoWeeksAgo, lt: weekAgo } } }),
    ]);

  const lifetime = { ...ZERO };
  for (const g of lifetimeGrouped) lifetime[g.status] = g._count._all;
  const life = rates(lifetime);
  const deliverability = {
    bounceRate: life.bounceRate,
    complaintRate: life.complaintRate,
    // 100 minus a weighted penalty; complaints hurt ~5× as much as bounces.
    score: Math.max(0, Math.round(100 - life.bounceRate * 2 - life.complaintRate * 10)),
  };
  const verdict =
    deliverability.score >= 90 ? "healthy" : deliverability.score >= 75 ? "watch" : "at-risk";

  const inWindow = (d: Date | null, lo: Date, hi: Date) => !!d && d >= lo && d < hi;
  const nowHi = new Date(now);
  let sentNow = 0,
    sentPrev = 0,
    openNow = 0,
    openPrev = 0;
  for (const l of recent) {
    if (inWindow(l.sentAt, weekAgo, nowHi)) sentNow += 1;
    else if (inWindow(l.sentAt, twoWeeksAgo, weekAgo)) sentPrev += 1;
    if (l.openedAt) {
      if (inWindow(l.openedAt, weekAgo, nowHi)) openNow += 1;
      else if (inWindow(l.openedAt, twoWeeksAgo, weekAgo)) openPrev += 1;
    }
  }
  const rate = (n: number, d: number) => (d === 0 ? 0 : Math.round((n / d) * 1000) / 10);

  // Strongest campaign by open rate, among those with a meaningful sample.
  const byCampaign = new Map<string, Record<EmailStatus, number>>();
  for (const g of campaignGrouped) {
    const id = g.campaignId!;
    if (!byCampaign.has(id)) byCampaign.set(id, { ...ZERO });
    byCampaign.get(id)![g.status] = g._count._all;
  }
  const names = new Map(campaigns.map((c) => [c.id, c.name]));
  let topCampaign: { id: string; name: string; openRate: number; sent: number } | null = null;
  for (const [id, counts] of byCampaign) {
    const r = rates(counts);
    if (r.sent < 10) continue;
    if (!topCampaign || r.openRate > topCampaign.openRate) {
      topCampaign = { id, name: names.get(id) ?? "—", openRate: r.openRate, sent: r.sent };
    }
  }

  return {
    deliverability: { ...deliverability, verdict, deliveredRate: rate(life.sent - lifetime.BOUNCED, life.sent) },
    engagement: {
      openRateNow: rate(openNow, sentNow),
      openRatePrev: rate(openPrev, sentPrev),
      delta: pctChange(rate(openNow, sentNow), rate(openPrev, sentPrev)),
    },
    volume: { sentNow, sentPrev, delta: pctChange(sentNow, sentPrev) },
    audience: { addedNow, addedPrev, delta: pctChange(addedNow, addedPrev) },
    topCampaign,
  };
}
