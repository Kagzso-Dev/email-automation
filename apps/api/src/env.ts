import { fileURLToPath } from "node:url";
import { config as loadEnv } from "dotenv";
import { z } from "zod";

// Load .env from the current working dir and from the repo root for local dev.
// In Docker / CI the values come straight from the environment and this is a no-op.
loadEnv();
loadEnv({ path: fileURLToPath(new URL("../../../.env", import.meta.url)) });

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  LOG_LEVEL: z.string().default("info"),

  API_PORT: z.coerce.number().default(4000),
  PUBLIC_API_URL: z.string().url().default("http://localhost:4000"),
  WEB_ORIGIN: z.string().default("http://localhost:5173"),

  // Where uploaded assets (template images) are written. Served read-only at
  // `${PUBLIC_API_URL}/uploads`. Relative paths resolve from the API's CWD.
  UPLOADS_DIR: z.string().default(".uploads"),

  JWT_ACCESS_SECRET: z.string().min(8),
  JWT_REFRESH_SECRET: z.string().min(8),
  JWT_ACCESS_TTL: z.coerce.number().default(900),
  JWT_REFRESH_TTL: z.coerce.number().default(60 * 60 * 24 * 14),
  LINK_SIGNING_SECRET: z.string().min(8),

  // MySQL connection is configured with discrete parts; scripts/db-url.mjs
  // assembles the URL Prisma needs. DATABASE_URL still works if set (it wins).
  DB_HOST: z.string().default("localhost"),
  DB_PORT: z.string().default("3306"),
  DB_NAME: z.string().default("dispatch"),
  DB_USER: z.string().default("root"),
  DB_PASSWORD: z.string().default(""),

  // mock = write each message to ./.mail-outbox; smtp = send via SMTP_* below.
  EMAIL_PROVIDER: z.enum(["mock", "smtp"]).default("mock"),
  EMAIL_FROM: z.string().default("Dispatch <no-reply@example.com>"),
  EMAIL_SENDER_ADDRESS: z.string().default("123 Example St, Example City, EX 00000"),
  // Open pixel + click-redirect rewriting on outbound mail. Set to false to send
  // clean, untracked mail: much better odds of landing in the primary inbox
  // (Gmail reads the pixel + redirect domain as bulk-marketing), at the cost of
  // all open/click stats. Applies to every send — campaigns, triggers, manual.
  EMAIL_TRACKING: z
    .string()
    .default("true")
    .transform((v) => v !== "false" && v !== "0"),
  // Throttle + safety cap on outbound sends — keep these under your SMTP
  // provider's own limits (e.g. Gmail ~500/day free, ~2000 for Workspace).
  SEND_RATE_PER_SEC: z.coerce.number().default(1),
  SEND_DAILY_CAP: z.coerce.number().default(200),
  SEND_MAX_ATTEMPTS: z.coerce.number().default(5),
  SEND_BACKOFF_MS: z.coerce.number().default(30_000),
  // Default gap between the individual sends of a manual bulk ("drip") send from
  // the Contacts page — a random value in [min, max] seconds is waited before
  // each contact so the batch doesn't look like a burst. Overridable per-deploy
  // in Settings (stored in the Setting table); these are just the seed values.
  BULK_SEND_MIN_DELAY_SEC: z.coerce.number().int().min(1).max(3600).default(8),
  BULK_SEND_MAX_DELAY_SEC: z.coerce.number().int().min(1).max(3600).default(25),
  SCHEDULER_TIMEZONE: z.string().default("UTC"),
  MOCK_FAIL_RATE: z.coerce.number().min(0).max(1).default(0),

  // Only needed when EMAIL_PROVIDER=smtp.
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().default(587),
  SMTP_SECURE: z
    .string()
    .default("false")
    .transform((v) => v === "true" || v === "1"),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),

  SENTRY_DSN: z.string().optional(),

  SEED_ADMIN_EMAIL: z.string().email().default("admin@example.com"),
  SEED_ADMIN_PASSWORD: z.string().min(8).default("changeme12345"),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  // eslint-disable-next-line no-console
  console.error("Invalid environment:\n", parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const env = parsed.data;
export const isProd = env.NODE_ENV === "production";
