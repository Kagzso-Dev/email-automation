# Dispatch — Email Automation Platform

Single-organization platform for **scheduled campaigns** and **event-triggered transactional email**.
Queue-backed sending, template rendering with `{{variables}}`, delivery/open/click tracking, and
suppression enforcement. See [`docs/technical-design.html`](docs/technical-design.html) for the design.

**MySQL is the only infrastructure.** No Redis, no Docker — the job queue is a table.

## Stack

| Area | Choice |
| --- | --- |
| API | Node 20, TypeScript, Express, Prisma (MySQL 8) |
| Queue | MySQL-backed `Job` table + polling workers — scheduler, campaign fan-out, rate-limited send worker, dead-letter (`status = DEAD`) |
| Email | Provider interface — `mock` (writes to `.mail-outbox/`, default), `smtp` (nodemailer), `ses` (AWS); selected by `EMAIL_PROVIDER` |
| Web | React + Vite, React Query, Tailwind |
| Auth | JWT access token + httpOnly refresh cookie; `ADMIN` / `EDITOR` roles |

## Quick start

Prerequisites: **Node 20+** and a local **MySQL 8** server. That's it.

```bash
cp .env.example .env                 # set DB_HOST/PORT/NAME/USER/PASSWORD + SEED_ADMIN_*, edit secrets
npm install
mysql -u root -p -e "CREATE DATABASE IF NOT EXISTS dispatch CHARACTER SET utf8mb4;"
npm run prisma:deploy                # apply migrations
npm run seed                         # bootstrap admin + sample data (idempotent)
npm run dev                          # api :4000, worker, web :5173
```

Log in at http://localhost:5173 with `SEED_ADMIN_EMAIL` / `SEED_ADMIN_PASSWORD`.

### Processes

- `npm run dev:api` — REST API + webhook ingestion (`apps/api/src/index.ts`)
- `npm run dev:worker` — polling job workers + the scheduler (`apps/api/src/worker.ts`)
- `npm run dev:web` — dashboard

Run **one** worker process. The queue engine is safe under concurrent workers (jobs are
claimed with a conditional `UPDATE`), but the scheduler assumes a single instance.

`npm run dev` runs a preflight check (`scripts/predev.mjs`): if `:4000` or `:5173` is
already listening it stops with a message instead of half-starting a second stack (Vite
drifting to `:5174`, the API crashing with `EADDRINUSE`). Free the ports and retry:

```powershell
npm run dev:kill   # Windows: stops only this repo's dev processes + frees 4000/5173/5174
```

The API port (`4000`) and web port (`5173`, `strictPort`) are fixed on purpose — don't
change them to dodge a conflict; kill the stale process instead.

## Try the pipeline

**Scheduled campaign** — create a template + list in the UI, then a campaign with a send time a
minute out. Watch `.mail-outbox/` fill at the configured rate (1/sec in sandbox).

**Triggered email** — create an API key in Settings and a trigger, then:

```bash
curl -X POST http://localhost:4000/api/webhooks/trigger/user.signup \
  -H 'Content-Type: application/json' -H 'X-Api-Key: sk_...' \
  -d '{"contactEmail":"new@example.com","payload":{"plan":"pro"}}'
```

Calling it twice with the same body produces exactly one send (idempotency key).

**Simulate delivery events** (dev only, mock provider):

```bash
curl -X POST http://localhost:4000/api/webhooks/dev/simulate/<emailLogId>/delivered
curl -X POST http://localhost:4000/api/webhooks/dev/simulate/<emailLogId>/bounced   # auto-suppresses
```

## Tests

```bash
npm test        # unit: rendering, conditions, idempotency
```

Integration tests against a real MySQL are stubbed for milestone M9 (see design doc §11).

## Ops

- `GET /health` — MySQL reachability (200 / 503)
- `GET /api/jobs` — queue state (pending / active / dead counts + recent rows), requires an `ADMIN` JWT;
  `POST /api/jobs/:id/retry` requeues one
- Structured logs via pino; set `SENTRY_DSN` to enable error tracking

## Deployment

Plain Node processes plus a managed MySQL. Run `apps/api` twice (one `start:api`, one
`start:worker`), set `DB_HOST` / `DB_PORT` / `DB_NAME` / `DB_USER` / `DB_PASSWORD` for the
database, run `npm run prisma:deploy` on release. No broker to operate.

## Environment

See [`.env.example`](.env.example). The database is configured with discrete variables
(`DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`, `DB_PASSWORD`); [`scripts/db-url.mjs`](scripts/db-url.mjs)
assembles the connection string Prisma needs, and the `prisma:*` npm scripts pass it to the CLI —
run those rather than bare `npx prisma`. Setting `DATABASE_URL` directly still works and overrides
the parts. Other key knobs: `EMAIL_PROVIDER`, `SEND_RATE_PER_SEC`, `SEND_DAILY_CAP`,
`SEND_MAX_ATTEMPTS`, `SCHEDULER_TIMEZONE`.

## WhatsApp (Meta WhatsApp Cloud API)

WhatsApp is isolated from email — its own tables, config (`apps/api/src/config/whatsapp.ts`) and
`META_WHATSAPP_*` variables; leaving them blank only disables WhatsApp. To go live:

1. In Meta Business: a WhatsApp Business Account with a phone number registered on the Cloud API,
   and a system-user **permanent** access token with `whatsapp_business_messaging`.
2. Set `META_WHATSAPP_ACCESS_TOKEN`, `META_WHATSAPP_PHONE_NUMBER_ID`, `META_WHATSAPP_WABA_ID`,
   `META_WHATSAPP_APP_SECRET` and a random `META_WHATSAPP_WEBHOOK_VERIFY_TOKEN` (or enter them under
   Settings → WhatsApp and press **Test connection**).
3. In the Meta app → WhatsApp → Configuration, set the callback URL to
   `https://<public API host>/api/webhooks/whatsapp` with the same verify token, and subscribe to
   the `messages` field. The webhook rejects any request without a valid `X-Hub-Signature-256`.
4. Register each approved template on the WhatsApp Templates page by its exact Meta name and
   language. Template variables map to the positional body parameters `{{1}}`, `{{2}}`, ….

Smoke test from the repo root: `npx tsx apps/api/scripts/whatsapp-test-send.ts --check`, then
`--to 91XXXXXXXXXX --template <name> --lang <code>`. Delivery/read/failed statuses and replies arrive
on the webhook; replies are listed at `GET /api/whatsapp/inbound`.

## AI voice calls (kagzso-voice-backend)

The **AI Call** button on the Contacts page (next to *Send WhatsApp*) places outbound AI voice
calls through [`kagzso-voice-backend-english`](kagzso-voice-backend-english/README.md), with the
customers read from an Excel / CSV file. It is isolated like WhatsApp: its own tables
(`ai_call_runs`, `ai_call_logs`), config (`apps/api/src/config/aiCalls.ts`), routes
(`/api/ai-calls`), queue (`ai-call-run`) and env vars. With `ENABLE_AI_CALLS=false` (the default)
the button is hidden and the routes return 404.

**How it works.** Upload a sheet with `customer_name`, `gender`, `follow_up_detail`, `phone`
(variants such as *name / full name*, *sex*, *follow up / notes*, *mobile / phone number* are
auto-detected and can be remapped). The preview flags missing/invalid phones (red, not called),
unknown genders and duplicate numbers (amber). Pick **Random N**, **Selected rows** or **All rows**,
set the gap and max calls, confirm, and watch each call's status (queued → dialing → ringing → in
progress → completed / no answer / busy / failed), refreshed every 3 seconds.

Server side, `POST /api/ai-calls/start` normalizes phones to E.164 (default +91), drops duplicates
and do-not-call numbers (unsubscribed / bounced / complained email contacts, unsubscribed / blocked
WhatsApp contacts, and anyone who said "don't call me" on an earlier AI call), picks random rows
with a crypto Fisher–Yates shuffle (never the same number twice), and enforces the per-run and
daily caps. The `ai-call-run` worker then calls **one customer at a time**: it dials, waits for that
call to end, waits the gap, and dials the next. Status arrives two ways: signed callbacks from
the voice backend (`POST /api/webhooks/ai-calls`) and a poll of the voice backend every 5 s while a
call is in flight, so a lost callback never stalls a run. Only `ADMIN` users can start calls; only
one run can be active at a time; phone numbers are masked in logs.

Calls run the voice backend's standard **Nila** flow (`VOICE_AGENT_NAME=Nila`, the default): *"Hi, is
this Raagul?"* → identity → *"Thank you sir. This is Nila from Kagzso AI and Automation… one minute?"* →
short intro → the repetitive-work question → *"useful for your business?"* → close (sir / madam
only from the given gender; do-not-call always wins). Nila needs a `customer_name` — rows without
one fail with a clear error. Set `VOICE_AGENT_NAME=Follow-up` instead to use the follow-up agent,
which greets *"Hello Mr. Ragul, this is Nila from Kagzso AI and Automation…"* and opens with
*"I'm calling regarding: <follow_up_detail>"*.

### Setup

1. Run the voice backend (see its README): fill in its `.env`, run `alembic upgrade head`, and start
   it on port 8002 with a public `PUBLIC_BASE_URL` (ngrok) so Plivo/Twilio can reach it. In its
   `.env` also set the callback target:

   ```env
   STATUS_CALLBACK_URL=http://localhost:4000/api/webhooks/ai-calls
   STATUS_CALLBACK_SECRET=<random string, 16+ chars>
   ```

2. In this repo's `.env`:

   ```env
   ENABLE_AI_CALLS=true
   VOICE_BACKEND_URL=http://localhost:8002
   VOICE_BACKEND_API_KEY=<the voice backend's ADMIN_API_KEY>
   AI_CALL_WEBHOOK_SECRET=<same value as STATUS_CALLBACK_SECRET>
   ```

   Optional: `VOICE_AGENT_ID` / `VOICE_AGENT_NAME` (default `Nila`),
   `AI_CALLS_DEFAULT_COUNTRY_CODE` (91), `AI_CALLS_MAX_PER_RUN` (10, max 100),
   `AI_CALLS_DAILY_CAP` (100 per 24 h), `AI_CALLS_MIN_GAP_SEC` (10), `AI_CALLS_CALL_TIMEOUT_SEC` (900).

3. Apply the migration (adds two new tables, changes no existing ones) and restart:

   ```bash
   npm run prisma:deploy     # applies prisma/migrations/0017_ai_calls
   npm run prisma:generate
   npm run dev
   ```

### Test with one random call

> The sample file's numbers (`+91 90000 0000x`) are placeholders and may belong to real people.
> Before testing, **replace every phone in the file with your own number** (on a trial
> Plivo/Twilio account it must be a verified number). Duplicates of your number are dialled once.

1. Open [`scripts/sample-ai-calls.xlsx`](scripts/sample-ai-calls.xlsx), put your own mobile number
   in the `phone` column, save.
2. Sign in as an admin → **Contacts** → **AI Call** → *Choose file*.
3. Leave **Random = 1**, gap 30 s, max 10 → **Review & start** → **Start 1 call**.
4. Answer your phone. The status table moves through dialing → ringing → in progress → completed,
   then shows the outcome, summary and transcript.

Unit tests: `npm test` (parsing, E.164, random selection, planning, signatures, route gates) and,
in the voice backend, `pytest` (Follow-up agent, prompt variables, endpoint, callbacks).
