import type { AiCallStatus, WhatsAppSendStatus } from "@prisma/client";
import { prisma } from "../prisma.js";
import { listWhatsAppSendBatches } from "./whatsappSend.js";
import { unreadTotals } from "./whatsappInbox.js";

/*
 * Read-only per-channel numbers for the Dashboard (Email / WhatsApp / AI Calls).
 * Only reads (findMany / groupBy / count) — nothing here writes, and no existing
 * table, route or response is changed. Days are UTC buckets, like the email
 * engagement chart (stats.service.ts → eventSeries).
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/** The range toggle on the Dashboard (7d / 14d / 30d). */
export const DASHBOARD_SPANS = [7, 14, 30] as const;
export type DashboardSpan = (typeof DASHBOARD_SPANS)[number];

export function parseSpan(raw: unknown): DashboardSpan | null {
  const n = Number(raw ?? 14);
  return (DASHBOARD_SPANS as readonly number[]).includes(n) ? (n as DashboardSpan) : null;
}

export interface DashboardRange {
  span: number;
  /** Start of the first UTC day in the range (inclusive). */
  start: Date;
  /** Start of the previous period of the same length, for the trend (inclusive; ends at `start`). */
  prevStart: Date;
  end: Date;
}

/** Same window as the email chart: today plus the `span - 1` UTC days before it. */
export function rangeFor(span: number, now = new Date()): DashboardRange {
  const start = new Date(now.getTime() - (span - 1) * DAY_MS);
  start.setUTCHours(0, 0, 0, 0);
  return { span, start, prevStart: new Date(start.getTime() - span * DAY_MS), end: now };
}

export function dayKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Empty day buckets for the range, oldest first. */
function emptyDays<T extends Record<string, number>>(r: DashboardRange, zero: () => T) {
  const m = new Map<string, T>();
  for (let i = 0; i < r.span; i++) m.set(dayKey(new Date(r.start.getTime() + i * DAY_MS)), zero());
  return m;
}

/** Percent change vs the previous period; null when there was nothing before (no meaningful %). */
export function pctChange(now: number, prev: number): number | null {
  if (prev === 0) return now === 0 ? 0 : null;
  return Math.round(((now - prev) / prev) * 1000) / 10;
}

const pct = (n: number, d: number) => (d === 0 ? 0 : Math.round((n / d) * 1000) / 10);

const inRange = (d: Date | null | undefined, lo: Date, hi: Date): d is Date => !!d && d >= lo && d <= hi;

/* -------------------------------------------------------------------- WhatsApp */

export interface WhatsAppSendRow {
  status: WhatsAppSendStatus;
  batchId: string | null;
  templateId: string | null;
  sentAt: Date | null;
  deliveredAt: Date | null;
  readAt: Date | null;
  failedAt: Date | null;
}

const SENT_OK: WhatsAppSendStatus[] = ["SENT", "DELIVERED", "READ"];

/**
 * Event counts, each on the day it happened (like the email chart). "Sent" uses the
 * Send Queue rule — status SENT, DELIVERED or READ — so a message that was handed
 * to Meta and later failed counts as failed, not sent.
 */
export function summarizeWhatsAppSends(rows: WhatsAppSendRow[], r: DashboardRange) {
  const days = emptyDays(r, () => ({ sent: 0, delivered: 0, read: 0, failed: 0 }));
  const totals = { sent: 0, delivered: 0, read: 0, failed: 0, sentFromBatches: 0, failedFromBatches: 0 };
  let prevSent = 0;
  const byTemplate = new Map<string, number>();
  const bump = (d: Date, k: "sent" | "delivered" | "read" | "failed") => {
    const b = days.get(dayKey(d));
    if (b) b[k] += 1;
    totals[k] += 1;
  };
  for (const s of rows) {
    const ok = SENT_OK.includes(s.status);
    if (ok && inRange(s.sentAt, r.start, r.end)) {
      bump(s.sentAt, "sent");
      if (s.batchId) totals.sentFromBatches += 1;
      if (s.templateId) byTemplate.set(s.templateId, (byTemplate.get(s.templateId) ?? 0) + 1);
    } else if (ok && s.sentAt && s.sentAt >= r.prevStart && s.sentAt < r.start) {
      prevSent += 1;
    }
    if ((s.status === "DELIVERED" || s.status === "READ") && inRange(s.deliveredAt, r.start, r.end)) bump(s.deliveredAt, "delivered");
    if (s.status === "READ" && inRange(s.readAt, r.start, r.end)) bump(s.readAt, "read");
    if (s.status === "FAILED" && inRange(s.failedAt, r.start, r.end)) {
      bump(s.failedAt, "failed");
      if (s.batchId) totals.failedFromBatches += 1;
    }
  }
  return {
    totals: { ...totals, successRate: pct(totals.sent, totals.sent + totals.failed) },
    trend: { prevSent, delta: pctChange(totals.sent, prevSent) },
    series: [...days.entries()].map(([date, v]) => ({ date, ...v })),
    byTemplate,
  };
}

export async function whatsappDashboard(span: DashboardSpan, opts: { includeUnread: boolean }) {
  const r = rangeFor(span);
  const since = r.prevStart;
  const [rows, incoming, replies, activeContacts, batches, unread] = await Promise.all([
    prisma.whatsAppSend.findMany({
      where: {
        OR: [{ sentAt: { gte: since } }, { deliveredAt: { gte: r.start } }, { readAt: { gte: r.start } }, { failedAt: { gte: r.start } }],
      },
      select: { status: true, batchId: true, templateId: true, sentAt: true, deliveredAt: true, readAt: true, failedAt: true },
    }),
    prisma.whatsAppInboundMessage.count({ where: { sentAt: { gte: r.start, lte: r.end } } }),
    prisma.whatsAppInboundMessage.count({ where: { sentAt: { gte: r.start, lte: r.end }, contextMessageId: { not: null } } }),
    prisma.whatsAppContact.count({ where: { status: "ACTIVE" } }),
    listWhatsAppSendBatches(),
    opts.includeUnread ? unreadTotals() : Promise.resolve(null),
  ]);
  const s = summarizeWhatsAppSends(rows, r);

  const topIds = [...s.byTemplate.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
  const names = topIds.length
    ? new Map(
        (
          await prisma.whatsAppTemplate.findMany({
            where: { id: { in: topIds.map(([id]) => id) } },
            select: { id: true, name: true },
          })
        ).map((t) => [t.id, t.name]),
      )
    : new Map<string, string>();

  return {
    span,
    totals: { ...s.totals, incoming, replies, activeContacts },
    unread, // null for non-admins (the Inbox is admin-only)
    trend: s.trend,
    series: s.series,
    recentBatches: batches.slice(0, 5).map((b) => ({
      id: b.id,
      templateName: b.templateName,
      status: b.status,
      total: b.total,
      sent: b.sent,
      failed: b.failed,
      startedAt: b.startedAt,
    })),
    topTemplates: topIds.map(([id, sent]) => ({ id, name: names.get(id) ?? "Deleted template", sent })),
  };
}

/* -------------------------------------------------------------------- AI calls */

export interface CallRow {
  runId: string;
  status: AiCallStatus;
  outcome: string | null;
  durationSec: number | null;
  startedAt: Date | null;
  createdAt: Date;
}

/** Calls that were actually placed (QUEUED = never dialled, CANCELLED = run stopped first). */
export const PLACED_CALL_STATUSES: AiCallStatus[] = ["DIALING", "RINGING", "IN_PROGRESS", "COMPLETED", "NO_ANSWER", "BUSY", "FAILED"];

/** A call's day: when it started, or when it was created if it never started. */
const callAt = (c: CallRow) => c.startedAt ?? c.createdAt;

export function summarizeCalls(rows: CallRow[], r: DashboardRange) {
  const days = emptyDays(r, () => ({ total: 0, completed: 0, unanswered: 0 }));
  const t = { total: 0, completed: 0, noAnswer: 0, busy: 0, failed: 0, inProgress: 0, totalDurationSec: 0, timedCalls: 0 };
  let prevTotal = 0;
  const outcomes = new Map<string, number>();
  const callsByRun = new Map<string, number>();
  for (const c of rows) {
    if (!PLACED_CALL_STATUSES.includes(c.status)) continue;
    const at = callAt(c);
    if (at >= r.prevStart && at < r.start) {
      prevTotal += 1;
      continue;
    }
    if (!inRange(at, r.start, r.end)) continue;
    t.total += 1;
    const day = days.get(dayKey(at));
    if (day) day.total += 1;
    callsByRun.set(c.runId, (callsByRun.get(c.runId) ?? 0) + 1);
    if (c.status === "COMPLETED") {
      t.completed += 1;
      if (day) day.completed += 1;
      if (c.durationSec != null) {
        t.totalDurationSec += c.durationSec;
        t.timedCalls += 1;
      }
    } else if (c.status === "NO_ANSWER" || c.status === "BUSY" || c.status === "FAILED") {
      if (c.status === "NO_ANSWER") t.noAnswer += 1;
      else if (c.status === "BUSY") t.busy += 1;
      else t.failed += 1;
      if (day) day.unanswered += 1;
    } else {
      t.inProgress += 1;
    }
    if (c.outcome) outcomes.set(c.outcome, (outcomes.get(c.outcome) ?? 0) + 1);
  }
  const finished = t.completed + t.noAnswer + t.busy + t.failed;
  return {
    totals: {
      total: t.total,
      completed: t.completed,
      noAnswer: t.noAnswer,
      busy: t.busy,
      failed: t.failed,
      inProgress: t.inProgress,
      // Of calls that have finished (in-progress calls have no answer yet).
      answeredRate: pct(t.completed, finished),
      totalDurationSec: t.totalDurationSec,
      avgDurationSec: t.timedCalls === 0 ? 0 : Math.round(t.totalDurationSec / t.timedCalls),
    },
    trend: { prevTotal, delta: pctChange(t.total, prevTotal) },
    series: [...days.entries()].map(([date, v]) => ({ date, ...v })),
    outcomes: [...outcomes.entries()].sort((a, b) => b[1] - a[1]).map(([outcome, count]) => ({ outcome, count })),
    callsByRun,
  };
}

export async function callsDashboard(span: DashboardSpan) {
  const r = rangeFor(span);
  const [rows, pendingFollowups, activeCustomers] = await Promise.all([
    prisma.aiCallLog.findMany({
      where: {
        status: { in: PLACED_CALL_STATUSES },
        OR: [{ startedAt: { gte: r.prevStart } }, { startedAt: null, createdAt: { gte: r.prevStart } }],
      },
      select: { runId: true, status: true, outcome: true, durationSec: true, startedAt: true, createdAt: true },
    }),
    prisma.aiCallFollowup.count({ where: { status: "PENDING_APPROVAL" } }),
    prisma.aiCallCustomer.count({ where: { deletedAt: null } }),
  ]);
  const s = summarizeCalls(rows, r);

  // Calls by flow: run → pinned flow version → flow. Runs without a pin used the default agent.
  const runIds = [...s.callsByRun.keys()];
  const pins = runIds.length
    ? await prisma.aiCallRunFlow.findMany({
        where: { runId: { in: runIds } },
        select: { runId: true, flowVersion: { select: { flow: { select: { id: true, name: true } } } } },
      })
    : [];
  const flowOfRun = new Map(pins.map((p) => [p.runId, p.flowVersion.flow]));
  const byFlow = new Map<string, { id: string | null; name: string; calls: number }>();
  for (const [runId, calls] of s.callsByRun) {
    const f = flowOfRun.get(runId);
    const key = f?.id ?? "default";
    const cur = byFlow.get(key) ?? { id: f?.id ?? null, name: f?.name ?? "Default agent", calls: 0 };
    cur.calls += calls;
    byFlow.set(key, cur);
  }

  return {
    span,
    totals: { ...s.totals, pendingFollowups, activeCustomers },
    trend: s.trend,
    series: s.series,
    outcomes: s.outcomes,
    topFlows: [...byFlow.values()].sort((a, b) => b.calls - a.calls).slice(0, 5),
  };
}

/* ----------------------------------------------------------------------- Email */

export interface EmailRow {
  status: string;
  sentAt: Date | null;
  openedAt: Date | null;
  clickedAt: Date | null;
}

/** Range numbers for the summary row; the email cards and chart keep their own endpoints. */
export function summarizeEmail(rows: EmailRow[], r: DashboardRange) {
  let sent = 0,
    prevSent = 0,
    opened = 0,
    clicked = 0,
    bounced = 0;
  for (const l of rows) {
    if (!l.sentAt) continue;
    if (l.sentAt >= r.prevStart && l.sentAt < r.start) {
      prevSent += 1;
      continue;
    }
    if (!inRange(l.sentAt, r.start, r.end)) continue;
    sent += 1;
    if (l.openedAt || l.clickedAt) opened += 1;
    if (l.clickedAt) clicked += 1;
    if (l.status === "BOUNCED") bounced += 1;
  }
  return {
    totals: { sent, opened, clicked, bounced, openRate: pct(opened, sent), clickRate: pct(clicked, sent) },
    trend: { prevSent, delta: pctChange(sent, prevSent) },
  };
}

export async function emailDashboard(span: DashboardSpan) {
  const r = rangeFor(span);
  const [rows, failed] = await Promise.all([
    prisma.emailLog.findMany({
      where: { sentAt: { gte: r.prevStart } },
      select: { status: true, sentAt: true, openedAt: true, clickedAt: true },
    }),
    prisma.emailLog.count({ where: { status: "FAILED", failedAt: { gte: r.start, lte: r.end } } }),
  ]);
  const s = summarizeEmail(rows, r);
  return { span, totals: { ...s.totals, failed }, trend: s.trend };
}
