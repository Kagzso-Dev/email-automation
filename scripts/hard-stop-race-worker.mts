// One queue worker process for scripts/hard-stop-race-check.mts (Hard stop, ENABLE_HARD_STOP). It runs the real
// workers (apps/api/src/queue/workers.ts) and the hard-stop finalizer against the throwaway database in
// DATABASE_URL. Nothing leaves this machine:
//   - email: the mock provider only (refuses to start otherwise), slowed to 600 ms per send so sends are in flight;
//   - Meta (graph.facebook.com) and the voice backend (VOICE_BACKEND_URL): answered by the stub below, which logs
//     every request; a call rings for 2 s, is connected until 8 s, then completes normally;
//   - any other request (including localhost) is blocked and logged.
// Every send that starts is appended to RACE_LOG as one JSON line. Not for production use.

import { appendFileSync } from "node:fs";

const RACE_LOG = process.env.RACE_LOG!;
const WORKER = process.env.RACE_WORKER ?? "?";
const VOICE = process.env.VOICE_BACKEND_URL!;
const log = (e: Record<string, unknown>) => appendFileSync(RACE_LOG, JSON.stringify({ w: WORKER, ...e }) + "\n");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

if (!/\/hardstop_race_[^/?]*$/.test(new URL(process.env.DATABASE_URL ?? "mysql://x/none").pathname)) {
  console.error("hard-stop-race-worker: DATABASE_URL must be a throwaway hardstop_race_* database");
  process.exit(2);
}

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const method = (init?.method ?? "GET").toUpperCase();
  if (url.startsWith("https://graph.facebook.com/")) {
    if (method === "POST" && /\/messages$/.test(url)) {
      const body = JSON.parse(String(init?.body ?? "{}")) as { to?: string };
      const t = Date.now();
      log({ ev: "wa:start", to: body.to, t });
      await sleep(400 + Math.random() * 600); // Meta has the message
      log({ ev: "wa:end", to: body.to, t: Date.now() });
      return Response.json({ messages: [{ id: `wamid.race.${body.to}.${t}` }] });
    }
    log({ ev: "graph:other", url, method, t: Date.now() });
    return Response.json({ data: [] });
  }
  if (url.startsWith(VOICE)) {
    const path = url.slice(VOICE.length);
    if (method === "POST" && path === "/api/calls/outbound") {
      const body = JSON.parse(String(init?.body ?? "{}")) as { log_id?: string };
      const t = Date.now();
      log({ ev: "call:place", logId: body.log_id, t });
      return Response.json({ success: true, call_id: `race_${body.log_id}_${t}`, provider_call_id: `p_${t}` });
    }
    const m = /^\/api\/calls\/(race_[^/?]+)$/.exec(path);
    if (method === "GET" && m) {
      const id = decodeURIComponent(m[1]!);
      const placedAt = Number(id.split("_").pop());
      const age = Date.now() - placedAt;
      const status = age < 2000 ? "ringing" : age < 8000 ? "in_progress" : "completed";
      const done = status === "completed";
      return Response.json({
        id,
        provider_call_id: null,
        status,
        outcome: done ? "interested" : null,
        summary: done ? "Race check: the call ended normally" : null,
        hangup_cause: null,
        duration_seconds: done ? 6 : null,
        ended_at: done ? new Date(placedAt + 8000).toISOString() : null,
        transcripts: [],
      });
    }
    // Never expected: there is no hang-up / end-call request anywhere.
    log({ ev: "voice:other", url, method, t: Date.now() });
    return Response.json({ detail: "not in the race stub" }, { status: 404 });
  }
  log({ ev: "blocked", url, method, t: Date.now() });
  throw new Error(`race check: outside request blocked: ${url}`);
}) as typeof fetch;

const { getProvider } = await import("../apps/api/src/provider/index.js");
const provider = getProvider();
if (provider.name !== "mock") {
  console.error("hard-stop-race-worker: EMAIL_PROVIDER must be mock");
  process.exit(3);
}
const send = provider.send.bind(provider);
provider.send = async (msg) => {
  const emailLogId = msg.tags.emailLogId;
  log({ ev: "email:start", emailLogId, t: Date.now() });
  await sleep(600); // the provider has the email
  try {
    const r = await send(msg);
    log({ ev: "email:end", emailLogId, ok: true, t: Date.now() });
    return r;
  } catch (err) {
    log({ ev: "email:end", emailLogId, ok: false, t: Date.now() });
    throw err;
  }
};

const { startAllWorkers } = await import("../apps/api/src/queue/workers.js");
const { startHardStopFinalizer } = await import("../apps/api/src/queue/hardStopFinalizer.js");
startAllWorkers();
startHardStopFinalizer();
log({ ev: "ready", t: Date.now() });
