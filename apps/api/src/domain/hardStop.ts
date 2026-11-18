// Hard stop (ENABLE_HARD_STOP, off by default; config/hardStop.ts). "Hard stop" on one send, or "Stop all running
// sends" (admin).
//
// RULE: a hard stop halts everything except work already in progress.
//   Never stopped: an email being sent (handed to the provider), a WhatsApp message being sent (handed to Meta), an AI
//   call dialing / ringing / connected. They finish normally, and their results (send logs, delivery webhooks, call
//   log, outcome, stage, follow-up drafts) are recorded as always. Nothing here hangs up a call or asks a voice
//   backend to end one.
//   Stopped: every item not started yet: queued and paced items, campaign fan-out not dispatched, Send Queue drips,
//   email retries, approved call-again follow-ups waiting for their time, and the rest of a running contacts import.
//   They become CANCELLED with the stop's reason "Hard stop by <user> at <time>". Rows already sent or in progress
//   are never relabeled. Follow-up drafts waiting for approval are kept (nothing is sent without approval).
//
// WHY IT IS SAFE ACROSS WORKERS AND RESTARTS: both sides use "only if still queued" writes on the item's own row.
//   The stop flips each not-started item to CANCELLED with a conditional UPDATE, and a worker starts an item with a
//   conditional UPDATE from queued to sending (claim* below). The database lets one of the two win for each row, so
//   an item is either started before the stop (in progress: it finishes, the stop never touches it) or cancelled (it
//   never starts). Right before that claim the worker reads its job's status once (the check point); email sends,
//   retries, fan-out and imports read `hard_stops` (stopCovering*). Nothing depends on a worker's memory.
//
// A stop covers the work that existed when it was applied (hard_stops.appliedAt); anything started later is not
// touched. A second press while a stop is open returns the same stop and applies it again, which is idempotent:
// every write is conditional and every hard_stop_items row is unique per stop.

import { randomUUID } from "node:crypto";
import { Prisma, type HardStop, type HardStopScope } from "@prisma/client";
import type { HardStopCsvChannel, HardStopView } from "@dispatch/shared";
import { prisma } from "../prisma.js";
import { logger } from "../logger.js";
import { QUEUE } from "../queue/queues.js";
import { csvCell } from "./csv.js";
import { languageName, languageOfRun } from "./aiCallLanguages.js";
import { syncCustomerFromLog } from "./aiCallCustomerSync.js";
import { addCustomerEvent } from "./aiCallFollowups.js";

export class HardStopError extends Error {
  constructor(
    public readonly status: 404 | 409,
    message: string,
  ) {
    super(message);
    this.name = "HardStopError";
  }
}

export interface HardStopActor {
  id: string;
  email: string;
}

/** A call dialing, ringing or connected: in progress, it always runs to its natural end. */
const IN_FLIGHT_CALL = ["DIALING", "RINGING", "IN_PROGRESS"] as const;
/** An item interrupted by a worker crash is settled after this long, like the queue's own stuck-job recovery. */
export const HARD_STOP_STUCK_AFTER_MS = 5 * 60 * 1000;
/** A running contacts import checks the stop before each batch of this many rows. */
export const HARD_STOP_IMPORT_BATCH = 100;
const INTERRUPTED = "Interrupted while sending (worker restarted) — not retried automatically";

type Rec = Omit<Prisma.HardStopItemCreateManyInput, "stopId">;
const CANCELLED_KINDS = ["cancelled", "retry", "followup"];

const chunk = <T>(arr: T[], size: number): T[][] =>
  Array.from({ length: Math.ceil(arr.length / size) }, (_, i) => arr.slice(i * size, (i + 1) * size));

const fmtTime = (d: Date) => `${d.toISOString().slice(0, 16).replace("T", " ")} UTC`;

/** The reason written on every row a stop cancels. */
export const hardStopReason = (email: string, at: Date) => `Hard stop by ${email} at ${fmtTime(at)}`;

const activeKeyOf = (scope: HardStopScope, targetId: string | null) => `${scope}:${targetId ?? "all"}`;

function firstLast(name: string | null | undefined): { firstName: string | null; lastName: string | null } {
  const [first, ...rest] = (name ?? "").trim().split(/\s+/);
  return { firstName: first || null, lastName: rest.join(" ") || null };
}

async function record(stopId: string, rows: Rec[]): Promise<void> {
  for (const part of chunk(rows, 500)) {
    await prisma.hardStopItem.createMany({ data: part.map((r) => ({ ...r, stopId })), skipDuplicates: true });
  }
}

async function contactsById(ids: string[]) {
  const out = new Map<string, { email: string; firstName: string | null; lastName: string | null; phone: string | null; businessName: string | null }>();
  for (const part of chunk([...new Set(ids)], 1000)) {
    const rows = await prisma.contact.findMany({
      where: { id: { in: part } },
      select: { id: true, email: true, firstName: true, lastName: true, phone: true, businessName: true },
    });
    for (const r of rows) out.set(r.id, r);
  }
  return out;
}

/* ------------------------------------------------------------------ applying a stop, per kind of job */

async function applyEmailBatch(stop: HardStop, batchId: string): Promise<void> {
  const batch = await prisma.manualSendBatch.findUnique({
    where: { id: batchId },
    select: { id: true, deletedTemplateName: true, template: { select: { name: true } } },
  });
  if (!batch) return;
  const from = `Email batch "${batch.template?.name ?? batch.deletedTemplateName ?? "deleted template"}"`;
  await prisma.manualSendBatch.updateMany({ where: { id: batchId, status: "RUNNING" }, data: { status: "CANCELLED", nextItemAt: null } });
  // Only items still PENDING: an item a worker already started is SENDING and is left to finish.
  await prisma.manualSendBatchItem.updateMany({ where: { batchId, status: "PENDING" }, data: { status: "CANCELLED", error: stop.reason } });
  const [cancelled, sending] = await Promise.all([
    // CANCELLED is written on these rows only by a hard stop.
    prisma.manualSendBatchItem.findMany({ where: { batchId, status: "CANCELLED" }, select: { id: true, contactId: true, email: true, name: true } }),
    prisma.manualSendBatchItem.findMany({ where: { batchId, status: "SENDING" }, select: { id: true } }),
  ]);
  const contacts = await contactsById(cancelled.map((i) => i.contactId));
  await record(stop.id, [
    { channel: "email", kind: "job", refTable: "ManualSendBatch", refId: batchId, name: from },
    ...cancelled.map((i): Rec => {
      const c = contacts.get(i.contactId);
      const split = c ? { firstName: c.firstName, lastName: c.lastName } : firstLast(i.name);
      return {
        channel: "email",
        kind: "cancelled",
        refTable: "ManualSendBatchItem",
        refId: i.id,
        name: i.name,
        email: i.email,
        phone: c?.phone ?? null,
        businessName: c?.businessName ?? null,
        extra: { ...split, from, batchId },
      };
    }),
    ...sending.map((i): Rec => ({ channel: "email", kind: "in_progress", refTable: "ManualSendBatchItem", refId: i.id })),
  ]);
}

async function applyWhatsAppBatch(stop: HardStop, batchId: string): Promise<void> {
  const batch = await prisma.whatsAppSendBatch.findUnique({ where: { id: batchId }, select: { id: true, template: { select: { name: true } } } });
  if (!batch) return;
  const from = `WhatsApp batch "${batch.template.name}"`;
  await prisma.whatsAppSendBatch.updateMany({ where: { id: batchId, status: "RUNNING" }, data: { status: "CANCELLED", nextItemAt: null } });
  // Only messages still QUEUED: one a worker already started is SENDING and is left to finish.
  await prisma.whatsAppSend.updateMany({ where: { batchId, status: "QUEUED" }, data: { status: "CANCELLED", error: stop.reason } });
  const [cancelled, sending] = await Promise.all([
    prisma.whatsAppSend.findMany({
      where: { batchId, status: "CANCELLED" },
      select: { id: true, phone: true, name: true, businessName: true, whatsappContactId: true },
    }),
    prisma.whatsAppSend.findMany({ where: { batchId, status: "SENDING" }, select: { id: true } }),
  ]);
  const waIds = [...new Set(cancelled.map((s) => s.whatsappContactId).filter((x): x is string => !!x))];
  const waContacts = new Map<string, { firstName: string | null; lastName: string | null }>();
  for (const part of chunk(waIds, 1000)) {
    for (const r of await prisma.whatsAppContact.findMany({ where: { id: { in: part } }, select: { id: true, firstName: true, lastName: true } })) {
      waContacts.set(r.id, r);
    }
  }
  await record(stop.id, [
    { channel: "whatsapp", kind: "job", refTable: "WhatsAppSendBatch", refId: batchId, name: from },
    ...cancelled.map((s): Rec => {
      const c = s.whatsappContactId ? waContacts.get(s.whatsappContactId) : undefined;
      return {
        channel: "whatsapp",
        kind: "cancelled",
        refTable: "whatsapp_sends",
        refId: s.id,
        name: s.name,
        phone: s.phone,
        businessName: s.businessName,
        extra: { ...(c ? { firstName: c.firstName, lastName: c.lastName } : firstLast(s.name)), from, batchId },
      };
    }),
    ...sending.map((s): Rec => ({ channel: "whatsapp", kind: "in_progress", refTable: "whatsapp_sends", refId: s.id })),
  ]);
}

/** Approved call-again follow-ups that have not turned into their call run yet (APPROVED, no run). */
async function cancelApprovedFollowups(stop: HardStop, where: Prisma.AiCallFollowupWhereInput): Promise<void> {
  const rows = await prisma.aiCallFollowup.findMany({
    where: { ...where, channel: "CALL", status: "APPROVED", aiCallRunId: null },
    select: {
      id: true,
      customerId: true,
      scheduledAt: true,
      customer: { select: { customerName: true, gender: true, phone: true, businessName: true, followUpDetail: true, language: true } },
    },
  });
  const recs: Rec[] = [];
  for (const f of rows) {
    // Conditional: a follow-up whose call run was created first is in progress and is left alone.
    const { count } = await prisma.aiCallFollowup.updateMany({
      where: { id: f.id, status: "APPROVED", aiCallRunId: null },
      data: { status: "CANCELLED", error: stop.reason },
    });
    if (count !== 1) continue;
    // Its delayed job (runAt = the scheduled time) is cleared too.
    await prisma.job.deleteMany({ where: { queue: QUEUE.aiCallFollowup, status: "PENDING", dedupeKey: `ai-call-followup:${f.id}` } });
    await addCustomerEvent({ customerId: f.customerId, type: "followup_cancelled", detail: `Call again cancelled — ${stop.reason}`, refId: f.id });
    recs.push({
      channel: "calls",
      kind: "followup",
      refTable: "ai_call_followups",
      refId: f.id,
      name: f.customer.customerName,
      phone: f.customer.phone,
      businessName: f.customer.businessName,
      extra: {
        gender: f.customer.gender,
        followUpDetail: f.customer.followUpDetail,
        language: f.customer.language,
        scheduledAt: f.scheduledAt?.toISOString() ?? null,
        from: "Call-again follow-up",
      },
    });
  }
  await record(stop.id, recs);
}

async function applyAiCallRun(stop: HardStop, runId: string, opts: { followups: boolean }): Promise<void> {
  const run = await prisma.aiCallRun.findUnique({ where: { id: runId }, select: { id: true } });
  if (!run) return;
  const from = `AI call run (${languageName(await languageOfRun(runId))})`;
  await prisma.aiCallRun.updateMany({ where: { id: runId, status: "RUNNING" }, data: { status: "CANCELLED", nextCallAt: null } });
  // Only calls still QUEUED. A call dialing, ringing or connected is never touched: the run's job keeps polling it
  // to its natural end, and the webhook keeps recording it, exactly as after Cancel run.
  const queued = await prisma.aiCallLog.findMany({ where: { runId, status: "QUEUED" }, select: { id: true } });
  for (const part of chunk(queued.map((l) => l.id), 500)) {
    await prisma.aiCallLog.updateMany({ where: { id: { in: part }, status: "QUEUED" }, data: { status: "CANCELLED", error: stop.reason } });
  }
  const [cancelled, live] = await Promise.all([
    prisma.aiCallLog.findMany({
      where: { runId, status: "CANCELLED", error: stop.reason },
      select: { id: true, customerName: true, gender: true, phone: true, followUpDetail: true },
    }),
    prisma.aiCallLog.findMany({ where: { runId, status: { in: [...IN_FLIGHT_CALL] } }, select: { id: true } }),
  ]);
  // Saved customers that were only queued go back to their earlier stage (as Cancel run does). Idempotent.
  for (const l of cancelled) await syncCustomerFromLog(l.id);
  const links = cancelled.length
    ? await prisma.aiCallCustomerCall.findMany({
        where: { logId: { in: cancelled.map((l) => l.id) } },
        select: { logId: true, customer: { select: { businessName: true } } },
      })
    : [];
  const business = new Map(links.map((l) => [l.logId, l.customer.businessName]));
  await record(stop.id, [
    { channel: "calls", kind: "job", refTable: "ai_call_runs", refId: runId, name: from },
    ...cancelled.map((l): Rec => ({
      channel: "calls",
      kind: "cancelled",
      refTable: "ai_call_logs",
      refId: l.id,
      name: l.customerName,
      phone: l.phone,
      businessName: business.get(l.id) ?? null,
      extra: { gender: l.gender, followUpDetail: l.followUpDetail, from, runId },
    })),
    ...live.map((l): Rec => ({ channel: "calls", kind: "in_progress", refTable: "ai_call_logs", refId: l.id })),
  ]);
  if (opts.followups) {
    const logIds = (await prisma.aiCallLog.findMany({ where: { runId }, select: { id: true } })).map((l) => l.id);
    if (logIds.length) await cancelApprovedFollowups(stop, { sourceCallLogId: { in: logIds } });
  }
}

interface EmailJobPayload {
  idempotencyKey?: string;
  contactId?: string;
  source?: { type?: string; campaignId?: string; triggerId?: string };
  /** Set by the campaign fan-out with the flag on: when that fan-out started. */
  dispatchedAt?: string;
}

const payloadOf = (p: unknown) => (p ?? {}) as EmailJobPayload;

/** When the email was dispatched: its fan-out's start, else when its job row was made. */
function dispatchedAtOf(job: { payload: unknown; createdAt: Date }): Date {
  const at = payloadOf(job.payload).dispatchedAt;
  const d = at ? new Date(at) : null;
  return d && !Number.isNaN(d.getTime()) ? d : job.createdAt;
}

async function emailJobRecords(
  jobs: { id: string; payload: unknown; attempts: number }[],
  isRetry: (j: { attempts: number }) => boolean,
): Promise<Rec[]> {
  const payloads = jobs.map((j) => ({ job: j, p: payloadOf(j.payload) }));
  const contacts = await contactsById(payloads.map((x) => x.p.contactId).filter((x): x is string => !!x));
  const campaignIds = [...new Set(payloads.map((x) => x.p.source?.campaignId).filter((x): x is string => !!x))];
  const triggerIds = [...new Set(payloads.map((x) => x.p.source?.triggerId).filter((x): x is string => !!x))];
  const [campaigns, triggers] = await Promise.all([
    campaignIds.length ? prisma.campaign.findMany({ where: { id: { in: campaignIds } }, select: { id: true, name: true } }) : [],
    triggerIds.length ? prisma.trigger.findMany({ where: { id: { in: triggerIds } }, select: { id: true, name: true } }) : [],
  ]);
  const cName = new Map(campaigns.map((c) => [c.id, c.name]));
  const tName = new Map(triggers.map((t) => [t.id, t.name]));
  return payloads.map(({ job, p }): Rec => {
    const c = p.contactId ? contacts.get(p.contactId) : undefined;
    const retry = isRetry(job);
    const what = p.source?.campaignId
      ? `Campaign "${cName.get(p.source.campaignId) ?? p.source.campaignId}"`
      : p.source?.triggerId
        ? `Trigger "${tName.get(p.source.triggerId) ?? p.source.triggerId}"`
        : "One-off email";
    return {
      channel: "email",
      kind: retry ? "retry" : "cancelled",
      refTable: "Job",
      refId: job.id,
      name: c ? [c.firstName, c.lastName].filter(Boolean).join(" ") || null : null,
      email: c?.email ?? null,
      phone: c?.phone ?? null,
      businessName: c?.businessName ?? null,
      extra: {
        firstName: c?.firstName ?? null,
        lastName: c?.lastName ?? null,
        from: retry ? `${what} (retry)` : what,
        attempts: job.attempts,
        idempotencyKey: p.idempotencyKey ?? null,
      },
    };
  });
}

/** An earlier attempt cut off mid-send left its EmailLog QUEUED: it is closed as failed when its retry is cancelled. */
async function closeInterruptedLedger(stop: HardStop, keys: string[]): Promise<void> {
  for (const part of chunk(keys, 500)) {
    await prisma.emailLog.updateMany({
      where: { idempotencyKey: { in: part }, status: "QUEUED" },
      data: { status: "FAILED", errorMessage: `Retry cancelled — ${stop.reason}`, failedAt: new Date() },
    });
  }
}

/**
 * Queued emails of the `send-email` queue (campaign, trigger and one-off sends) and their retries: their job rows are
 * removed with a conditional delete (only while still PENDING: a worker that claimed one first keeps it, in
 * progress) and recorded. `coveredOnly`: only those dispatched before the stop was applied.
 */
async function cancelEmailJobs(stop: HardStop, where: Prisma.JobWhereInput, opts: { coveredOnly?: boolean } = {}): Promise<void> {
  const jobs = await prisma.job.findMany({
    where: { ...where, queue: QUEUE.sendEmail, status: "PENDING" },
    select: { id: true, payload: true, attempts: true, createdAt: true },
  });
  const covered = opts.coveredOnly ? jobs.filter((j) => dispatchedAtOf(j) < stop.appliedAt) : jobs;
  for (const part of chunk(covered, 500)) {
    const ids = part.map((j) => j.id);
    await prisma.job.deleteMany({ where: { id: { in: ids }, status: "PENDING" } });
    const left = new Set((await prisma.job.findMany({ where: { id: { in: ids } }, select: { id: true } })).map((j) => j.id));
    const gone = part.filter((j) => !left.has(j.id));
    if (gone.length === 0) continue;
    await closeInterruptedLedger(
      stop,
      gone.filter((j) => j.attempts > 0).map((j) => payloadOf(j.payload).idempotencyKey).filter((k): k is string => !!k),
    );
    // A pending job that already ran once (and failed) is a retry; DeferJobError gives the attempt back.
    await record(stop.id, await emailJobRecords(gone, (j) => j.attempts > 0));
  }
}

async function applyCampaign(stop: HardStop, campaignId: string, opts: { recordPaused: boolean }): Promise<void> {
  const c = await prisma.campaign.findUnique({ where: { id: campaignId }, select: { id: true, name: true, lastRunAt: true } });
  if (!c) return;
  // Paused, the existing state its Schedule button resumes from. A campaign already SENT (its last emails still
  // queued) keeps SENT: it will not run again anyway.
  const paused = await prisma.campaign.updateMany({ where: { id: campaignId, status: { in: ["SCHEDULED", "SENDING"] } }, data: { status: "PAUSED" } });
  // Fan-out not dispatched yet (as Pause clears it).
  await prisma.job.deleteMany({ where: { queue: QUEUE.campaignDispatch, status: "PENDING", dedupeKey: { startsWith: `disp:${campaignId}:` } } });
  await cancelEmailJobs(stop, { dedupeKey: { startsWith: `campaign_${campaignId}_` } });
  // In progress: emails being sent now, and a fan-out part way (it stops at its next 500 contacts).
  const active = await prisma.job.findMany({
    where: {
      status: "ACTIVE",
      OR: [
        { queue: QUEUE.sendEmail, dedupeKey: { startsWith: `campaign_${campaignId}_` } },
        { queue: QUEUE.campaignDispatch, dedupeKey: { startsWith: `disp:${campaignId}:` } },
      ],
    },
    select: { id: true, queue: true, dedupeKey: true },
  });
  await record(stop.id, [
    { channel: "email", kind: "job", refTable: "Campaign", refId: campaignId, name: c.name, extra: { since: c.lastRunAt?.toISOString() ?? null } },
    ...(opts.recordPaused && paused.count === 1
      ? [{ channel: "email", kind: "paused_campaign", refTable: "Campaign", refId: campaignId, name: c.name } satisfies Rec]
      : []),
    ...active.map((j): Rec => ({ channel: "email", kind: "in_progress", refTable: "Job", refId: j.id, extra: { queue: j.queue, dedupeKey: j.dedupeKey } })),
  ]);
}

/** Campaign ids of queued or in-progress campaign emails (job dedupe key "campaign_<id>_<contact>_<day>"). */
async function campaignsWithQueuedEmails(): Promise<string[]> {
  const jobs = await prisma.job.findMany({
    where: { queue: QUEUE.sendEmail, status: { in: ["PENDING", "ACTIVE"] }, dedupeKey: { startsWith: "campaign_" } },
    select: { dedupeKey: true },
  });
  return [...new Set(jobs.map((j) => j.dedupeKey?.split("_")[1]).filter((x): x is string => !!x))];
}

async function applyAll(stop: HardStop): Promise<void> {
  // 1. Nothing new starts by itself: scheduled / sending campaigns are paused and active triggers switched off first
  //    (an admin turns them back on with the existing Schedule button and trigger switch). Stop all only.
  const campaigns = await prisma.campaign.findMany({ where: { status: { in: ["SCHEDULED", "SENDING"] } }, select: { id: true } });
  for (const id of new Set([...campaigns.map((c) => c.id), ...(await campaignsWithQueuedEmails())])) {
    await applyCampaign(stop, id, { recordPaused: true });
  }
  const triggers = await prisma.trigger.findMany({ where: { active: true }, select: { id: true, name: true } });
  const pausedTriggers: Rec[] = [];
  for (const t of triggers) {
    const { count } = await prisma.trigger.updateMany({ where: { id: t.id, active: true }, data: { active: false } });
    if (count === 1) pausedTriggers.push({ channel: "email", kind: "paused_trigger", refTable: "Trigger", refId: t.id, name: t.name });
  }
  await record(stop.id, pausedTriggers);

  // 2. Every running drip and call run, in every language.
  for (const b of await prisma.manualSendBatch.findMany({ where: { status: "RUNNING" }, select: { id: true } })) await applyEmailBatch(stop, b.id);
  for (const b of await prisma.whatsAppSendBatch.findMany({ where: { status: "RUNNING" }, select: { id: true } })) await applyWhatsAppBatch(stop, b.id);
  for (const r of await prisma.aiCallRun.findMany({ where: { status: "RUNNING" }, select: { id: true } })) {
    await applyAiCallRun(stop, r.id, { followups: false });
  }

  // 3. Every other queued email (trigger and one-off sends) and every queued retry.
  await cancelEmailJobs(stop, {});

  // 4. Approved call-again follow-ups waiting for their time (drafts waiting for approval are kept).
  await cancelApprovedFollowups(stop, {});

  // 5. In progress elsewhere: emails being sent, a follow-up turning into its call run, a contacts import.
  const active = await prisma.job.findMany({
    where: { status: "ACTIVE", queue: { in: [QUEUE.sendEmail, QUEUE.aiCallFollowup, QUEUE.csvImport, QUEUE.campaignDispatch] } },
    select: { id: true, queue: true, dedupeKey: true },
  });
  await record(
    stop.id,
    active.map((j): Rec => ({
      channel: j.queue === QUEUE.aiCallFollowup ? "calls" : "email",
      kind: "in_progress",
      refTable: "Job",
      refId: j.id,
      extra: { queue: j.queue, dedupeKey: j.dedupeKey },
    })),
  );
}

async function apply(stop: HardStop): Promise<void> {
  switch (stop.scope) {
    case "EMAIL_BATCH":
      return applyEmailBatch(stop, stop.targetId!);
    case "WHATSAPP_BATCH":
      return applyWhatsAppBatch(stop, stop.targetId!);
    case "AI_CALL_RUN":
      return applyAiCallRun(stop, stop.targetId!, { followups: true });
    case "CAMPAIGN":
      // A single job's stop never touches other campaigns or any trigger.
      return applyCampaign(stop, stop.targetId!, { recordPaused: false });
    case "ALL":
      return applyAll(stop);
  }
}

/* ------------------------------------------------------------------ pressing Hard stop */

async function campaignRunning(id: string): Promise<boolean> {
  const c = await prisma.campaign.findUnique({ where: { id }, select: { status: true } });
  if (!c) throw new HardStopError(404, "Campaign not found");
  if (c.status === "SCHEDULED" || c.status === "SENDING") return true;
  const queued = await prisma.job.count({
    where: {
      status: { in: ["PENDING", "ACTIVE"] },
      OR: [
        { queue: QUEUE.sendEmail, dedupeKey: { startsWith: `campaign_${id}_` } },
        { queue: QUEUE.campaignDispatch, dedupeKey: { startsWith: `disp:${id}:` } },
      ],
    },
  });
  return queued > 0;
}

/** Whether a campaign has anything to stop (scheduled, sending, or emails still queued). */
export async function isCampaignStoppable(id: string): Promise<boolean> {
  return campaignRunning(id);
}

async function assertStoppable(scope: HardStopScope, targetId: string | null): Promise<void> {
  const notRunning = "This send is not running any more (it finished or was cancelled)";
  switch (scope) {
    case "EMAIL_BATCH": {
      const b = await prisma.manualSendBatch.findUnique({ where: { id: targetId! }, select: { status: true } });
      if (!b) throw new HardStopError(404, "Email send not found");
      if (b.status !== "RUNNING") throw new HardStopError(409, notRunning);
      return;
    }
    case "WHATSAPP_BATCH": {
      const b = await prisma.whatsAppSendBatch.findUnique({ where: { id: targetId! }, select: { status: true } });
      if (!b) throw new HardStopError(404, "WhatsApp send not found");
      if (b.status !== "RUNNING") throw new HardStopError(409, notRunning);
      return;
    }
    case "AI_CALL_RUN": {
      const r = await prisma.aiCallRun.findUnique({ where: { id: targetId! }, select: { status: true } });
      if (!r) throw new HardStopError(404, "AI call run not found");
      if (r.status !== "RUNNING") throw new HardStopError(409, "This call run is not running any more (it finished or was cancelled)");
      return;
    }
    case "CAMPAIGN":
      if (!(await campaignRunning(targetId!))) throw new HardStopError(409, "Nothing is running or scheduled for this campaign");
      return;
    case "ALL":
      return; // always allowed: it also pauses campaigns and switches triggers off
  }
}

async function refreshCounts(stopId: string) {
  const rows = await prisma.hardStopItem.groupBy({ by: ["kind"], where: { stopId }, _count: { _all: true } });
  const n = (kind: string) => rows.find((r) => r.kind === kind)?._count._all ?? 0;
  const counts = {
    inProgressAtStop: n("in_progress"),
    cancelledItems: n("cancelled"),
    cancelledFollowups: n("followup") + n("retry"),
  };
  const byChannel = await prisma.hardStopItem.groupBy({
    by: ["channel", "kind"],
    where: { stopId, kind: { in: [...CANCELLED_KINDS, "in_progress"] } },
    _count: { _all: true },
  });
  const detail: Record<string, Record<string, number>> = {};
  for (const r of byChannel) (detail[r.channel] ??= {})[r.kind] = r._count._all;
  await prisma.hardStop.update({ where: { id: stopId }, data: { ...counts, detail } });
  return counts;
}

/**
 * Press Hard stop. Idempotent: while a stop for this target is open it is returned (created: false) and applied
 * again. Throws HardStopError 404 (no such send) or 409 (not running any more).
 */
export async function pressHardStop(scope: HardStopScope, targetId: string | null, actor: HardStopActor): Promise<{ stopId: string; created: boolean }> {
  const activeKey = activeKeyOf(scope, targetId);
  let stop = await prisma.hardStop.findUnique({ where: { activeKey } });
  let created = false;
  if (stop) {
    stop = await prisma.hardStop.update({ where: { id: stop.id }, data: { appliedAt: new Date() } });
  } else {
    await assertStoppable(scope, targetId);
    const now = new Date();
    try {
      stop = await prisma.hardStop.create({
        data: { scope, targetId, activeKey, reason: hardStopReason(actor.email, now), byUserId: actor.id, byEmail: actor.email, createdAt: now, appliedAt: now },
      });
      created = true;
    } catch (err) {
      // Two presses at once: the other one created it.
      if (!(err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002")) throw err;
      stop = await prisma.hardStop.findUniqueOrThrow({ where: { activeKey } });
    }
  }
  await apply(stop);
  const counts = await refreshCounts(stop.id);
  logger.info(
    { stopId: stop.id, scope, targetId, by: actor.email, created, ...counts },
    `hard stop applied: ${counts.inProgressAtStop} in progress at the stop (they finish), ${counts.cancelledItems} cancelled, ${counts.cancelledFollowups} follow-ups/retries cancelled`,
  );
  return { stopId: stop.id, created };
}

/* ------------------------------------------------------------------ worker check points */

/**
 * Email drip (Send Queue → Email): the check point right before an item starts. One read of the batch status, then
 * start the item only if it is still PENDING. False = do not send it (the batch was stopped, or the stop or another
 * worker got to this item first).
 */
export async function claimEmailBatchItem(batchId: string, itemId: string): Promise<boolean> {
  const b = await prisma.manualSendBatch.findUnique({ where: { id: batchId }, select: { status: true } });
  if (b?.status !== "RUNNING") return false;
  const { count } = await prisma.manualSendBatchItem.updateMany({ where: { id: itemId, status: "PENDING" }, data: { status: "SENDING" } });
  return count === 1;
}

/** WhatsApp drip: same check point, QUEUED → SENDING only while still QUEUED. */
export async function claimWhatsAppItem(batchId: string, itemId: string): Promise<boolean> {
  const b = await prisma.whatsAppSendBatch.findUnique({ where: { id: batchId }, select: { status: true } });
  if (b?.status !== "RUNNING") return false;
  const { count } = await prisma.whatsAppSend.updateMany({ where: { id: itemId, status: "QUEUED" }, data: { status: "SENDING" } });
  return count === 1;
}

/** AI call run (every language): same check point, QUEUED → DIALING only while still QUEUED. */
export async function claimAiCallLog(runId: string, logId: string): Promise<boolean> {
  const r = await prisma.aiCallRun.findUnique({ where: { id: runId }, select: { status: true } });
  if (r?.status !== "RUNNING") return false;
  const { count } = await prisma.aiCallLog.updateMany({ where: { id: logId, status: "QUEUED" }, data: { status: "DIALING", startedAt: new Date() } });
  return count === 1;
}

/** The stop covering an email of the send-email queue (its campaign's, or Stop all), if one was applied after it was dispatched. */
export async function stopCoveringEmailJob(jobId: string, payload: Record<string, unknown>): Promise<HardStop | null> {
  const p = payloadOf(payload);
  let since: Date | null = p.dispatchedAt ? new Date(p.dispatchedAt) : null;
  if (!since || Number.isNaN(since.getTime())) {
    since = (await prisma.job.findUnique({ where: { id: jobId }, select: { createdAt: true } }))?.createdAt ?? new Date(0);
  }
  const campaignId = p.source?.type === "campaign" ? p.source.campaignId : undefined;
  return prisma.hardStop.findFirst({
    where: {
      appliedAt: { gt: since },
      OR: [{ scope: "ALL" }, ...(campaignId ? [{ scope: "CAMPAIGN" as const, targetId: campaignId }] : [])],
    },
    orderBy: { appliedAt: "desc" },
  });
}

/** The check point found a stop: the email is not sent; it is recorded as cancelled (a retry when it ran before). */
export async function cancelEmailJobAtCheckPoint(
  stop: HardStop,
  job: { id: string; attempts: number },
  payload: Record<string, unknown>,
): Promise<{ cancelled: string; stopId: string }> {
  // The claim counted this run as an attempt: attempts > 1 means an earlier attempt really ran.
  const retry = job.attempts > 1;
  const key = payloadOf(payload).idempotencyKey;
  if (retry && key) await closeInterruptedLedger(stop, [key]);
  await record(stop.id, await emailJobRecords([{ id: job.id, payload, attempts: job.attempts }], () => retry));
  await refreshCounts(stop.id);
  logger.info({ stopId: stop.id, jobId: job.id, retry }, "hard stop: queued email not sent");
  return { cancelled: stop.reason, stopId: stop.id };
}

/** Campaign fan-out: a stop for this campaign (or Stop all) applied after this fan-out started. */
export function stopCoveringFanOut(campaignId: string, dispatchedAt: Date): Promise<HardStop | null> {
  return prisma.hardStop.findFirst({
    where: { appliedAt: { gt: dispatchedAt }, OR: [{ scope: "ALL" }, { scope: "CAMPAIGN", targetId: campaignId }] },
    orderBy: { appliedAt: "desc" },
  });
}

/** Contacts import: a Stop all applied after the import started. */
export function stopAllSince(since: Date): Promise<HardStop | null> {
  return prisma.hardStop.findFirst({ where: { scope: "ALL", appliedAt: { gt: since } }, orderBy: { appliedAt: "desc" } });
}

/** The rows a stopped contacts import did not write: recorded for the email CSV (a later import). */
export async function recordImportRowsNotImported(
  stop: HardStop,
  filename: string,
  rows: { email: string; firstName?: string; lastName?: string; phone?: string; businessName?: string }[],
): Promise<void> {
  const key = randomUUID();
  const from = `Contacts import "${filename}"`;
  await record(
    stop.id,
    rows.map((r, i): Rec => ({
      channel: "email",
      kind: "cancelled",
      refTable: "contact_import",
      refId: `${key}:${i}`,
      name: [r.firstName, r.lastName].filter(Boolean).join(" ") || null,
      email: r.email || null,
      phone: r.phone ?? null,
      businessName: r.businessName ?? null,
      extra: { firstName: r.firstName ?? null, lastName: r.lastName ?? null, from },
    })),
  );
  await refreshCounts(stop.id);
}

/** Whether a hard stop covered this batch (a lead-gen purge still runs for recipients it confirmed it reached). */
export async function isHardStoppedBatch(refTable: "ManualSendBatch" | "WhatsAppSendBatch", batchId: string): Promise<boolean> {
  return (await prisma.hardStopItem.count({ where: { kind: "job", refTable, refId: batchId } })) > 0;
}

/* ------------------------------------------------------------------ status, finishing */

/** Items in progress at the stop that are still in progress now. */
export async function inProgressNow(stopId: string): Promise<number> {
  const refs = await prisma.hardStopItem.findMany({ where: { stopId, kind: "in_progress" }, select: { refTable: true, refId: true } });
  const ids = (t: string) => refs.filter((r) => r.refTable === t).map((r) => r.refId);
  let n = 0;
  for (const part of chunk(ids("ManualSendBatchItem"), 1000)) n += await prisma.manualSendBatchItem.count({ where: { id: { in: part }, status: "SENDING" } });
  for (const part of chunk(ids("whatsapp_sends"), 1000)) n += await prisma.whatsAppSend.count({ where: { id: { in: part }, status: "SENDING" } });
  for (const part of chunk(ids("ai_call_logs"), 1000)) n += await prisma.aiCallLog.count({ where: { id: { in: part }, status: { in: [...IN_FLIGHT_CALL] } } });
  for (const part of chunk(ids("Job"), 1000)) n += await prisma.job.count({ where: { id: { in: part }, status: "ACTIVE" } });
  return n;
}

/** Items that finished: in the stopped jobs, plus emails that were being sent at the stop. */
export async function completedNow(stopId: string): Promise<number> {
  const items = await prisma.hardStopItem.findMany({
    where: { stopId, kind: { in: ["job", "in_progress", ...CANCELLED_KINDS] } },
    select: { kind: true, refTable: true, refId: true, extra: true },
  });
  const jobs = (t: string) => items.filter((i) => i.kind === "job" && i.refTable === t);
  let n = 0;
  const emailBatches = jobs("ManualSendBatch").map((j) => j.refId);
  if (emailBatches.length) n += await prisma.manualSendBatchItem.count({ where: { batchId: { in: emailBatches }, status: { in: ["SENT", "FAILED", "SKIPPED"] } } });
  const waBatches = jobs("WhatsAppSendBatch").map((j) => j.refId);
  if (waBatches.length) {
    n += await prisma.whatsAppSend.count({ where: { batchId: { in: waBatches }, status: { in: ["SENT", "DELIVERED", "READ", "FAILED", "SKIPPED"] } } });
  }
  const runs = jobs("ai_call_runs").map((j) => j.refId);
  if (runs.length) n += await prisma.aiCallLog.count({ where: { runId: { in: runs }, status: { in: ["COMPLETED", "NO_ANSWER", "BUSY", "FAILED"] } } });
  const campaigns = jobs("Campaign");
  for (const c of campaigns) {
    const since = (c.extra as { since?: string | null } | null)?.since;
    n += await prisma.emailLog.count({ where: { campaignId: c.refId, status: { not: "QUEUED" }, ...(since ? { createdAt: { gte: new Date(since) } } : {}) } });
  }
  // Other emails (trigger, one-off) that were being sent at the stop and finished. A stopped campaign's emails are
  // already counted from its ledger above; a job the check point cancelled is counted as cancelled, not here.
  const campaignPrefixes = campaigns.map((c) => `campaign_${c.refId}_`);
  const cancelledJobs = new Set(items.filter((i) => CANCELLED_KINDS.includes(i.kind) && i.refTable === "Job").map((i) => i.refId));
  const otherEmails = items
    .filter((i) => i.kind === "in_progress" && i.refTable === "Job")
    .filter((i) => {
      const e = i.extra as { queue?: string; dedupeKey?: string | null } | null;
      return e?.queue === QUEUE.sendEmail && !campaignPrefixes.some((p) => e.dedupeKey?.startsWith(p)) && !cancelledJobs.has(i.refId);
    })
    .map((i) => i.refId);
  if (otherEmails.length) n += await prisma.job.count({ where: { id: { in: otherEmails }, status: "COMPLETED" } });
  return n;
}

/**
 * An item cut off by a worker crash (still SENDING 5 minutes on, its batch stopped) is not progressing: it is
 * settled as failed with the wording finished batches already use. A live send never takes that long.
 */
export async function settleStuckInProgress(stopId: string): Promise<number> {
  const refs = await prisma.hardStopItem.findMany({ where: { stopId, kind: "in_progress" }, select: { refTable: true, refId: true } });
  const before = new Date(Date.now() - HARD_STOP_STUCK_AFTER_MS);
  let n = 0;
  const email = refs.filter((r) => r.refTable === "ManualSendBatchItem").map((r) => r.refId);
  for (const part of chunk(email, 1000)) {
    n += (
      await prisma.manualSendBatchItem.updateMany({
        where: { id: { in: part }, status: "SENDING", updatedAt: { lt: before }, batch: { is: { status: "CANCELLED" } } },
        data: { status: "FAILED", error: INTERRUPTED },
      })
    ).count;
  }
  const wa = refs.filter((r) => r.refTable === "whatsapp_sends").map((r) => r.refId);
  for (const part of chunk(wa, 1000)) {
    n += (
      await prisma.whatsAppSend.updateMany({
        where: { id: { in: part }, status: "SENDING", updatedAt: { lt: before }, batch: { is: { status: "CANCELLED" } } },
        data: { status: "FAILED", failedAt: new Date(), error: INTERRUPTED },
      })
    ).count;
  }
  if (n) logger.warn({ stopId, settled: n }, "hard stop: items cut off by a worker restart marked failed");
  return n;
}

/**
 * Last sweep once nothing is in progress: a retry an in-progress email scheduled after the stop (or a late fan-out
 * chunk) is cancelled, so the summary is final. Nothing can create more after this: they only come from items that
 * were in progress.
 */
export async function sweepCoveredEmailJobs(stop: HardStop): Promise<void> {
  if (stop.scope === "ALL") return cancelEmailJobs(stop, {}, { coveredOnly: true });
  if (stop.scope === "CAMPAIGN") return cancelEmailJobs(stop, { dedupeKey: { startsWith: `campaign_${stop.targetId}_` } }, { coveredOnly: true });
}

/** The stopped batches a lead-gen purge may apply to. */
export async function stoppedBatches(stopId: string): Promise<{ email: string[]; whatsapp: string[] }> {
  const jobs = await prisma.hardStopItem.findMany({
    where: { stopId, kind: "job", refTable: { in: ["ManualSendBatch", "WhatsAppSendBatch"] } },
    select: { refTable: true, refId: true },
  });
  return {
    email: jobs.filter((j) => j.refTable === "ManualSendBatch").map((j) => j.refId),
    whatsapp: jobs.filter((j) => j.refTable === "WhatsAppSendBatch").map((j) => j.refId),
  };
}

/** STOPPING → STOPPED with the final counts. Conditional, so two finalizers can't both log it. */
export async function markStopped(stopId: string): Promise<boolean> {
  const counts = await refreshCounts(stopId);
  const completed = await completedNow(stopId);
  const { count } = await prisma.hardStop.updateMany({
    where: { id: stopId, status: "STOPPING" },
    data: { status: "STOPPED", activeKey: null, finishedAt: new Date(), completedItems: completed },
  });
  if (count === 1) {
    logger.info(
      { stopId, completed, ...counts },
      `hard stop finished: ${completed} completed (including those in progress), ${counts.cancelledItems} cancelled, ${counts.cancelledFollowups} follow-ups/retries cancelled`,
    );
  }
  return count === 1;
}

/* ------------------------------------------------------------------ views */

export async function getHardStopView(stopId: string): Promise<HardStopView | null> {
  const stop = await prisma.hardStop.findUnique({ where: { id: stopId } });
  if (!stop) return null;
  const [inProgress, completed, paused, csv] = await Promise.all([
    stop.status === "STOPPING" ? inProgressNow(stopId) : Promise.resolve(0),
    stop.status === "STOPPED" && stop.completedItems != null ? Promise.resolve(stop.completedItems) : completedNow(stopId),
    prisma.hardStopItem.findMany({
      where: { stopId, kind: { in: ["paused_campaign", "paused_trigger"] } },
      select: { kind: true, refId: true, name: true },
      orderBy: { createdAt: "asc" },
    }),
    prisma.hardStopItem.groupBy({ by: ["channel"], where: { stopId, kind: { in: CANCELLED_KINDS } }, _count: { _all: true } }),
  ]);
  const rows = (c: HardStopCsvChannel) => csv.find((r) => r.channel === c)?._count._all ?? 0;
  return {
    id: stop.id,
    scope: stop.scope,
    targetId: stop.targetId,
    status: stop.status,
    reason: stop.reason,
    byEmail: stop.byEmail,
    createdAt: stop.createdAt.toISOString(),
    finishedAt: stop.finishedAt?.toISOString() ?? null,
    inProgress,
    inProgressAtStop: stop.inProgressAtStop,
    completed,
    cancelled: stop.cancelledItems,
    followupsCancelled: stop.cancelledFollowups,
    paused: {
      campaigns: paused.filter((p) => p.kind === "paused_campaign").map((p) => ({ id: p.refId, name: p.name ?? p.refId })),
      triggers: paused.filter((p) => p.kind === "paused_trigger").map((p) => ({ id: p.refId, name: p.name ?? p.refId })),
    },
    csvRows: { email: rows("email"), whatsapp: rows("whatsapp"), calls: rows("calls") },
  };
}

const JOB_TABLE: Record<Exclude<HardStopScope, "ALL">, string> = {
  EMAIL_BATCH: "ManualSendBatch",
  WHATSAPP_BATCH: "WhatsAppSendBatch",
  AI_CALL_RUN: "ai_call_runs",
  CAMPAIGN: "Campaign",
};

/** The newest stop that covered this send: its own, or a Stop all that stopped it. */
export async function latestStopIdFor(scope: Exclude<HardStopScope, "ALL">, targetId: string): Promise<string | null> {
  const [own, viaAll] = await Promise.all([
    prisma.hardStop.findFirst({ where: { scope, targetId }, orderBy: { createdAt: "desc" }, select: { id: true, createdAt: true } }),
    prisma.hardStopItem.findFirst({
      where: { kind: "job", refTable: JOB_TABLE[scope], refId: targetId, stop: { scope: "ALL" } },
      orderBy: { createdAt: "desc" },
      select: { stopId: true, createdAt: true },
    }),
  ]);
  if (own && viaAll) return own.createdAt >= viaAll.createdAt ? own.id : viaAll.stopId;
  return own?.id ?? viaAll?.stopId ?? null;
}

/** The newest Stop all (for the Send Queue header), if any. */
export async function latestStopAllId(): Promise<string | null> {
  return (await prisma.hardStop.findFirst({ where: { scope: "ALL" }, orderBy: { createdAt: "desc" }, select: { id: true } }))?.id ?? null;
}

/* ------------------------------------------------------------------ cancelled rows CSV */

const CSV_HEADERS: Record<HardStopCsvChannel, string[]> = {
  // Column names each channel's own import reads (Contacts, WhatsApp Contacts, AI Call import), then where the row
  // was cancelled from and why.
  email: ["email", "first_name", "last_name", "phone", "business", "cancelled_from", "reason"],
  whatsapp: ["phone", "first_name", "last_name", "business_name", "cancelled_from", "reason"],
  calls: ["customer_name", "gender", "phone", "business_name", "follow_up_detail", "cancelled_from", "reason"],
};

export async function hardStopCsv(stopId: string, channel: HardStopCsvChannel): Promise<{ filename: string; body: string } | null> {
  const stop = await prisma.hardStop.findUnique({ where: { id: stopId }, select: { reason: true, createdAt: true } });
  if (!stop) return null;
  const rows = await prisma.hardStopItem.findMany({
    where: { stopId, channel, kind: { in: CANCELLED_KINDS } },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
  const line = (cells: (string | null | undefined)[]) => cells.map((c) => csvCell(c ?? "")).join(",");
  const out = [line(CSV_HEADERS[channel])];
  for (const r of rows) {
    const x = (r.extra ?? {}) as { firstName?: string | null; lastName?: string | null; gender?: string | null; followUpDetail?: string | null; from?: string };
    if (channel === "email") out.push(line([r.email, x.firstName, x.lastName, r.phone, r.businessName, x.from, stop.reason]));
    else if (channel === "whatsapp") out.push(line([r.phone, x.firstName, x.lastName, r.businessName, x.from, stop.reason]));
    else out.push(line([r.name, x.gender, r.phone, r.businessName, x.followUpDetail, x.from, stop.reason]));
  }
  const day = stop.createdAt.toISOString().slice(0, 10);
  return { filename: `hard-stop-cancelled-${channel}-${day}-${stopId}.csv`, body: out.join("\r\n") + "\r\n" };
}
