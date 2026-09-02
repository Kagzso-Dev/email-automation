# Dispatch — Email Automation Platform

Single-organization platform for **scheduled campaigns** and **event-triggered transactional email**.
Queue-backed sending, template rendering with `{{variables}}`, delivery/open/click tracking, and
suppression enforcement. See [`docs/technical-design.html`](docs/technical-design.html) for the design.

## Stack

| Area | Choice |
| --- | --- |
| API | Node 20, TypeScript, Express, Prisma (PostgreSQL) |
| Queue | BullMQ on Redis — scheduler, fan-out, rate-limited send workers, DLQ |
| Email | Provider interface; `mock` adapter (writes to `.mail-outbox/`) by default, `ses` adapter built but off |
| Web | React + Vite, React Query, Tailwind |
| Auth | JWT access token + httpOnly refresh cookie; `ADMIN` / `EDITOR` roles |

## Quick start

```bash
cp .env.example .env                 # then edit secrets
npm install
docker compose up -d postgres redis  # just the datastores
npm run prisma:migrate               # create the schema
npm run db:seed                      # admin user + sample data
npm run dev                          # api :4000, worker, web :5173
```

Log in at http://localhost:5173 with `SEED_ADMIN_EMAIL` / `SEED_ADMIN_PASSWORD`.

### Processes

- `npm run dev:api` — REST API + webhook ingestion (`apps/api/src/index.ts`)
- `npm run dev:worker` — BullMQ workers + the singleton scheduler (`apps/api/src/worker.ts`)
- `npm run dev:web` — dashboard

### Everything in Docker

```bash
docker compose --profile app up --build   # postgres, redis, api, worker
```

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

Integration tests against real Postgres + Redis are stubbed for milestone M9 (see design doc §11).

## Ops

- `GET /health` — DB + Redis reachability (200 / 503)
- `/admin/queues` — Bull Board, requires an `ADMIN` JWT
- Structured logs via pino; set `SENTRY_DSN` to enable error tracking

## Environment

See [`.env.example`](.env.example). Key knobs: `EMAIL_PROVIDER`, `SEND_RATE_PER_SEC`,
`SEND_DAILY_CAP`, `SEND_MAX_ATTEMPTS`, `SCHEDULER_TIMEZONE`.
