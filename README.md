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
