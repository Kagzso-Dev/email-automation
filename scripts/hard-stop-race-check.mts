// Hard stop (ENABLE_HARD_STOP): two-worker race check on a THROWAWAY MySQL database, to run before a deploy.
//
//   1. Create an empty database whose name starts with hardstop_race_ and build the schema in it:
//        $env:DATABASE_URL = "mysql://root:<password>@127.0.0.1:3306/hardstop_race_1"
//        node scripts/prisma.mjs db push --skip-generate
//   2. npx tsx scripts/hard-stop-race-check.mts        (RACE_STOP_AFTER_MS=3000 presses earlier; default 6500)
//   3. Drop the database.
//
// It refuses any other database name. It seeds every kind of send (Send Queue email and WhatsApp drips, a sending
// campaign, a big campaign whose fan-out starts just before the stop, trigger emails, two AI call runs, approved
// call-again follow-ups), starts TWO real worker processes (scripts/hard-stop-race-worker.mts: email = mock provider
// with injected failures so retries happen, Meta and the voice backend stubbed), presses "Stop all running sends"
// from this process while they work, snapshots the database the moment the stop returns, waits until the stop is
// Stopped plus a quiet period, and checks:
//   - no item started after the stop was confirmed (WhatsApp, calls, Send Queue emails, campaign / trigger emails);
//   - every item in progress at the stop finished normally (never CANCELLED, never failed by the stop);
//   - every item not started is CANCELLED with "Hard stop by …"; nothing is sent twice; no retry fired after the stop;
//   - no approved follow-up turned into a call; no hang-up / end-call request; nothing reached the outside world.
// Exit code 0 = every check passed.

import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync, createWriteStream } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const dbUrl = process.env.DATABASE_URL ?? "";
const dbName = (() => {
  try {
    return new URL(dbUrl).pathname.slice(1);
  } catch {
    return "";
  }
})();
if (!/^hardstop_race_/.test(dbName)) {
  console.error(`Refusing: DATABASE_URL must point at a throwaway database named hardstop_race_* (got "${dbName || "none"}").`);
  process.exit(2);
}

const repo = fileURLToPath(new URL("..", import.meta.url));
const work = join(tmpdir(), `hardstop-race-${Date.now()}`);
mkdirSync(work, { recursive: true });
const RACE_LOG = join(work, "events.jsonl");
writeFileSync(RACE_LOG, "");

// Settings for this process and both workers. Set before any app module loads (they read env at import).
const ENV: Record<string, string> = {
  DATABASE_URL: dbUrl,
  ENABLE_HARD_STOP: "true",
  ENABLE_AI_CALLS: "true",
  VOICE_BACKEND_URL: "http://voice.race-stub.invalid",
  VOICE_BACKEND_API_KEY: "race-stub",
  WHATSAPP_PROVIDER: "meta",
  META_WHATSAPP_ACCESS_TOKEN: "race-stub",
  META_WHATSAPP_PHONE_NUMBER_ID: "100000000000000",
  EMAIL_PROVIDER: "mock",
  MOCK_FAIL_RATE: "0.25", // transient failures → retries are scheduled, some after the stop
  SEND_RATE_PER_SEC: "20",
  SEND_BACKOFF_MS: "1500",
  SEND_MAX_ATTEMPTS: "4",
  SEND_DAILY_CAP: "100000",
  LOG_LEVEL: "warn",
  SENTRY_DSN: "",
};
Object.assign(process.env, ENV);

const { prisma } = await import("../apps/api/src/prisma.js");
const { pressHardStop } = await import("../apps/api/src/domain/hardStop.js");
const { queueJobId } = await import("../apps/api/src/domain/idempotency.js");
const q = await import("../apps/api/src/queue/queues.js");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const now = () => Date.now();

/* ------------------------------------------------------------------ seed */

async function seed() {
  if ((await prisma.job.count()) > 0 || (await prisma.contact.count()) > 0) throw new Error("The database is not empty: use a fresh one.");
  const tpl = await prisma.template.create({ data: { name: "Race check", subject: "Hello", htmlBody: "<p>Hello from the race check</p>", variables: [] } });
  const contacts = (prefix: string, n: number) =>
    Array.from({ length: n }, (_, i) => ({ id: `${prefix}${i}`, email: `${prefix}${i}@race.invalid`, firstName: `${prefix}${i}`, customFields: {} }));
  await prisma.contact.createMany({ data: [...contacts("m", 30), ...contacts("k", 400), ...contacts("g", 2000), ...contacts("t", 30)] });

  // Send Queue → Email: 3 drips of 10 (0-1 s gaps).
  for (let b = 0; b < 3; b++) {
    const batch = await prisma.manualSendBatch.create({
      data: {
        templateId: tpl.id,
        minDelaySec: 0,
        maxDelaySec: 1,
        total: 10,
        items: { create: Array.from({ length: 10 }, (_, i) => ({ contactId: `m${b * 10 + i}`, email: `m${b * 10 + i}@race.invalid`, name: `m${b * 10 + i}` })) },
      },
    });
    await q.enqueueManualBulkSend({ batchId: batch.id });
  }

  // Send Queue → WhatsApp: 3 drips of 10.
  const wt = await prisma.whatsAppTemplate.create({ data: { name: "Race check", providerTemplateName: "race_check", languageCode: "en", body: "Hi", variables: [], buttonLabels: [] } });
  for (let b = 0; b < 3; b++) {
    const batch = await prisma.whatsAppSendBatch.create({
      data: {
        templateId: wt.id,
        minDelaySec: 0,
        maxDelaySec: 1,
        total: 10,
        items: { create: Array.from({ length: 10 }, (_, i) => ({ phone: `9190000${b}${String(i).padStart(4, "0")}`, name: `wa ${b}-${i}`, body: "Hi", contentVariables: {} })) },
      },
    });
    await q.enqueueWhatsAppBulkSend({ batchId: batch.id });
  }

  // A campaign sending to 400, and a big one (2,000) whose fan-out starts ~1.5 s before the stop.
  const today = new Date().toISOString().slice(0, 10);
  for (const [id, prefix, n, delay] of [["campK", "k", 400, 0], ["campG", "g", 2000, 5000]] as const) {
    const list = await prisma.list.create({ data: { name: `Race ${id}` } });
    await prisma.listMembership.createMany({ data: Array.from({ length: n }, (_, i) => ({ listId: list.id, contactId: `${prefix}${i}` })) });
    await prisma.campaign.create({ data: { id, name: `Race ${id}`, templateId: tpl.id, listId: list.id, scheduleType: "ONCE", sendAt: new Date(), status: "SCHEDULED" } });
    await q.enqueueCampaignDispatch({ campaignId: id, runDate: today }, { dedupeKey: `disp:${id}:race`, runAt: new Date(now() + delay) });
  }

  // Trigger emails (already fired, queued).
  const trigger = await prisma.trigger.create({ data: { name: "Race trigger", eventKey: "race-check", templateId: tpl.id, conditions: [] } });
  for (let i = 0; i < 30; i++) {
    const key = `trigger:${trigger.id}:t${i}:race`;
    await q.enqueueSend({ idempotencyKey: key, contactId: `t${i}`, source: { type: "trigger", triggerId: trigger.id, payload: {} } }, { dedupeKey: queueJobId(key) });
  }

  // Two AI call runs of 6 calls (each call rings 2 s and is connected until 8 s).
  for (let r = 0; r < 2; r++) {
    const run = await prisma.aiCallRun.create({
      data: {
        mode: "SELECTED",
        gapSeconds: 0,
        maxCalls: 6,
        total: 6,
        logs: { create: Array.from({ length: 6 }, (_, i) => ({ position: i, customerName: `Caller ${r}-${i}`, gender: "male", phone: `+9197000${r}${String(i).padStart(4, "0")}` })) },
      },
    });
    await q.enqueueAiCallRun({ runId: run.id });
  }

  // Approved call-again follow-ups, due 1-20 s from now.
  for (const [i, inSec] of [1, 3, 5, 8, 12, 20].entries()) {
    const phone = `+9196000000${String(i).padStart(2, "0")}`;
    const c = await prisma.aiCallCustomer.create({ data: { customerName: `Follow ${i}`, gender: "male", phone, activePhone: phone, language: "en" } });
    const f = await prisma.aiCallFollowup.create({
      data: { customerId: c.id, channel: "CALL", status: "APPROVED", reason: "Callback requested", attempt: 1, decidedByEmail: "race-check@local", decidedAt: new Date() },
    });
    await q.enqueueAiCallFollowup({ followupId: f.id }, new Date(now() + inSec * 1000));
  }
}

/* ------------------------------------------------------------------ run */

function startWorker(name: string): ChildProcess {
  const out = createWriteStream(join(work, `worker-${name}.log`));
  const child = spawn(process.execPath, [join(repo, "node_modules/tsx/dist/cli.mjs"), join(repo, "scripts/hard-stop-race-worker.mts")], {
    cwd: work, // the mock provider's .mail-outbox goes here, not into the repo
    env: { ...process.env, ...ENV, RACE_LOG, RACE_WORKER: name },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout!.pipe(out);
  child.stderr!.pipe(out);
  return child;
}

type Ev = { w: string; ev: string; t: number; to?: string; logId?: string; emailLogId?: string; ok?: boolean; url?: string };
const events = (): Ev[] =>
  readFileSync(RACE_LOG, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Ev);

console.log(`Throwaway database: ${dbName}\nWork folder: ${work}\n`);
await seed();
const workers = [startWorker("A"), startWorker("B")];
for (let i = 0; i < 120 && events().filter((e) => e.ev === "ready").length < 2; i++) await sleep(500);
if (events().filter((e) => e.ev === "ready").length < 2) throw new Error(`Workers did not start; see ${work}`);
const t0 = now();
const stopAfterMs = Number(process.env.RACE_STOP_AFTER_MS ?? 6500); // when to press, after both workers are up
console.log(`Two workers running. Pressing Stop all in ${stopAfterMs} ms…`);
await sleep(stopAfterMs);

const pressedAt = now();
const { stopId } = await pressHardStop("ALL", null, { id: "race-check", email: "race-check@local" });
const confirmedAt = now();
// What was in progress / not started at the moment the stop was confirmed.
const [snapManual, snapWa, snapLogs, snapJobs] = await Promise.all([
  prisma.manualSendBatchItem.findMany({ select: { id: true, status: true } }),
  prisma.whatsAppSend.findMany({ select: { id: true, status: true, phone: true } }),
  prisma.aiCallLog.findMany({ select: { id: true, status: true } }),
  prisma.job.findMany({ where: { queue: "send-email" }, select: { id: true, status: true, dedupeKey: true } }),
]);
console.log(`Stop all pressed at +${pressedAt - t0} ms, confirmed after ${confirmedAt - pressedAt} ms.`);

let stoppedAt = 0;
for (let i = 0; i < 240; i++) {
  const s = await prisma.hardStop.findUnique({ where: { id: stopId } });
  if (s?.status === "STOPPED") {
    stoppedAt = s.finishedAt!.getTime();
    break;
  }
  await sleep(1000);
}
console.log(stoppedAt ? `Stopped ${stoppedAt - confirmedAt} ms after the confirmation. Watching 25 s more…` : "NOT stopped within 4 minutes.");
await sleep(25_000);
for (const w of workers) w.kill();
await sleep(1000);

/* ------------------------------------------------------------------ checks */

const ev = events();
const stop = (await prisma.hardStop.findUnique({ where: { id: stopId } }))!;
const failures: string[] = [];
const check = (ok: boolean, what: string) => {
  if (!ok) failures.push(what);
  console.log(`${ok ? "PASS" : "FAIL"}  ${what}`);
};
const IN_FLIGHT = new Set(["DIALING", "RINGING", "IN_PROGRESS"]);
const isHardStopReason = (e: string | null) => !!e && e.startsWith("Hard stop by race-check@local at ");

// WhatsApp
const waFinal = await prisma.whatsAppSend.findMany({ select: { id: true, status: true, phone: true, error: true } });
const waSnap = new Map(snapWa.map((s) => [s.phone, s.status]));
const waStarts = ev.filter((e) => e.ev === "wa:start");
const waLate = waStarts.filter((e) => e.t > confirmedAt);
check(waLate.every((e) => waSnap.get(e.to!) === "SENDING"), `WhatsApp: ${waLate.length} message(s) handed to Meta after the confirmation, all already in progress at the stop`);
check(new Set(waStarts.map((e) => e.to)).size === waStarts.length, `WhatsApp: no message sent twice (${waStarts.length} sent)`);
const waCancelled = waFinal.filter((s) => s.status === "CANCELLED");
check(waCancelled.every((s) => !waStarts.some((e) => e.to === s.phone) && isHardStopReason(s.error)), `WhatsApp: ${waCancelled.length} cancelled with the reason, none of them sent`);
check(snapWa.every((s) => s.status !== "QUEUED"), "WhatsApp: nothing left queued at the confirmation");
const waInProgress = snapWa.filter((s) => s.status === "SENDING").map((s) => waFinal.find((f) => f.id === s.id)!);
check(waInProgress.every((s) => s.status === "SENT" && !isHardStopReason(s.error)), `WhatsApp: ${waInProgress.length} in progress at the stop → all SENT`);

// Calls
const logsFinal = await prisma.aiCallLog.findMany({ select: { id: true, status: true, outcome: true, error: true } });
const logSnap = new Map(snapLogs.map((l) => [l.id, l.status]));
const placed = ev.filter((e) => e.ev === "call:place");
const placedLate = placed.filter((e) => e.t > confirmedAt);
check(placedLate.every((e) => logSnap.get(e.logId!) === "DIALING"), `Calls: ${placedLate.length} call(s) placed after the confirmation, all already dialing at the stop`);
check(new Set(placed.map((e) => e.logId)).size === placed.length, `Calls: no call placed twice (${placed.length} placed)`);
const liveAtStop = snapLogs.filter((l) => IN_FLIGHT.has(l.status)).map((l) => logsFinal.find((f) => f.id === l.id)!);
check(liveAtStop.length > 0 && liveAtStop.every((l) => l.status === "COMPLETED" && l.outcome === "interested"), `Calls: ${liveAtStop.length} dialing / ringing / connected at the stop → all ran to their natural end (COMPLETED, outcome saved)`);
const logsCancelled = logsFinal.filter((l) => l.status === "CANCELLED");
check(logsCancelled.every((l) => !placed.some((p) => p.logId === l.id) && isHardStopReason(l.error)), `Calls: ${logsCancelled.length} queued call(s) cancelled with the reason, none dialled`);
check(ev.filter((e) => e.ev === "voice:other").length === 0, "Calls: no other request to the voice backend (no hang-up / end-call)");

// Send Queue email drips
const itemsFinal = await prisma.manualSendBatchItem.findMany({ select: { id: true, status: true, emailLogId: true, error: true } });
const itemByLog = new Map(itemsFinal.filter((i) => i.emailLogId).map((i) => [i.emailLogId!, i]));
const itemSnap = new Map(snapManual.map((i) => [i.id, i.status]));
const emailStarts = ev.filter((e) => e.ev === "email:start");
const dripLate = emailStarts.filter((e) => e.t > confirmedAt && itemByLog.has(e.emailLogId!));
check(dripLate.every((e) => itemSnap.get(itemByLog.get(e.emailLogId!)!.id) === "SENDING"), `Send Queue email: ${dripLate.length} email(s) handed to the provider after the confirmation, all already in progress`);
check(snapManual.every((i) => i.status !== "PENDING"), "Send Queue email: nothing left pending at the confirmation");
const dripCancelled = itemsFinal.filter((i) => i.status === "CANCELLED");
check(dripCancelled.every((i) => isHardStopReason(i.error) && !i.emailLogId), `Send Queue email: ${dripCancelled.length} cancelled with the reason, none sent`);
const dripInProgress = snapManual.filter((i) => i.status === "SENDING").map((i) => itemsFinal.find((f) => f.id === i.id)!);
check(dripInProgress.every((i) => (i.status === "SENT" || i.status === "FAILED") && !isHardStopReason(i.error)), `Send Queue email: ${dripInProgress.length} in progress at the stop → finished normally (${dripInProgress.map((i) => i.status).join(", ") || "none"})`);

// Campaign / trigger emails (send-email queue): after the confirmation only an attempt already running may reach the
// provider (its job ACTIVE at the stop, at most once, right away); no retry and no queued email.
const logs = await prisma.emailLog.findMany({ select: { id: true, idempotencyKey: true, campaignId: true, triggerId: true } });
const keyOf = new Map(logs.map((l) => [l.id, l.idempotencyKey]));
const jobSnap = new Map(snapJobs.map((j) => [j.dedupeKey, j.status]));
const queueLate = emailStarts.filter((e) => e.t > confirmedAt && !itemByLog.has(e.emailLogId!));
const lateByLog = new Map<string, number>();
for (const e of queueLate) lateByLog.set(e.emailLogId!, (lateByLog.get(e.emailLogId!) ?? 0) + 1);
const queueLateOk = queueLate.every((e) => jobSnap.get(queueJobId(keyOf.get(e.emailLogId!) ?? "")) === "ACTIVE" && lateByLog.get(e.emailLogId!) === 1 && e.t - confirmedAt < 3000);
check(queueLateOk, `Campaign / trigger email: ${queueLate.length} email(s) reached the provider after the confirmation, all attempts already running at the stop`);
const pendingLeft = await prisma.job.count({ where: { queue: "send-email", status: "PENDING" } });
check(pendingLeft === 0, `Campaign / trigger email: no queued email or retry left (${pendingLeft})`);
const campG = await prisma.emailLog.count({ where: { campaignId: "campG" } });
const gJobs = await prisma.hardStopItem.count({ where: { stopId, kind: { in: ["cancelled", "retry"] }, refTable: "Job", extra: { path: "$.from", string_contains: "campG" } } });
const gQueued = campG + gJobs;
console.log(
  `      big campaign (2,000 contacts): its fan-out had queued ${gQueued} at the stop ` +
    `(${gQueued === 0 ? "not started: its dispatch was cancelled" : gQueued < 2000 ? "stopped part way" : "finished"}); ${campG} started, ${gJobs} cancelled`,
);

// Follow-ups, campaigns, triggers
const runsAfter = await prisma.aiCallRun.count({ where: { createdAt: { gt: new Date(confirmedAt) } } });
const fus = await prisma.aiCallFollowup.findMany({ select: { status: true, error: true, aiCallRunId: true } });
check(runsAfter === 0 && fus.every((f) => f.status === "CANCELLED" && isHardStopReason(f.error) && !f.aiCallRunId), `Follow-ups: ${fus.length} approved, waiting → all CANCELLED, none turned into a call (runs created after the stop: ${runsAfter})`);
check((await prisma.job.count({ where: { queue: "ai-call-followup", status: "PENDING" } })) === 0, "Follow-ups: no delayed job left waiting");
// Every campaign the stop cancelled emails of is PAUSED (also one whose fan-out had finished); none is left
// scheduled or sending. Only a campaign with nothing left to cancel may stay SENT.
const camps = await prisma.campaign.findMany({ select: { id: true, name: true, status: true } });
const cancelledFrom = await prisma.hardStopItem.findMany({ where: { stopId, refTable: "Job", kind: { in: ["cancelled", "retry"] } }, select: { extra: true } });
const hadCancelled = (name: string) => cancelledFrom.some((i) => String((i.extra as { from?: string } | null)?.from ?? "").includes(`"${name}"`));
check(
  camps.every((c) => c.status === "PAUSED" || (c.status === "SENT" && !hadCancelled(c.name))),
  `Campaigns: ${camps.map((c) => `${c.id} ${c.status}${hadCancelled(c.name) ? " (emails cancelled)" : ""}`).join(", ")}`,
);
check((await prisma.trigger.count({ where: { active: true } })) === 0, "Triggers: switched off");

// The stop
check(!!stoppedAt, `Stop: Stopped (in progress at the stop: ${stop.inProgressAtStop}; completed ${stop.completedItems}; cancelled ${stop.cancelledItems}; follow-ups/retries cancelled ${stop.cancelledFollowups})`);
const quiet = ev.filter((e) => ["wa:start", "email:start", "call:place"].includes(e.ev) && stoppedAt && e.t > stoppedAt);
check(quiet.length === 0, `Nothing started after "Stopped" (watched 25 s more): ${quiet.length}`);
check(ev.filter((e) => e.ev === "blocked").length === 0, "Nothing tried to reach anything outside this machine");

console.log(
  `\nTotals: WhatsApp sent ${waStarts.length}; calls placed ${placed.length}; emails handed to the mock provider ${emailStarts.length} ` +
    `(incl. failed attempts); before the stop: ${ev.filter((e) => ["wa:start", "email:start", "call:place"].includes(e.ev) && e.t <= confirmedAt).length}.`,
);
console.log(failures.length ? `\n${failures.length} CHECK(S) FAILED. Logs: ${work}` : "\nALL CHECKS PASSED.");
await prisma.$disconnect();
if (!failures.length) rmSync(work, { recursive: true, force: true });
process.exit(failures.length ? 1 : 0);
