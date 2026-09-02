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

  EMAIL_PROVIDER: z.enum(["mock", "ses"]).default("mock"),
  EMAIL_FROM: z.string().default("Dispatch <no-reply@example.com>"),
  EMAIL_SENDER_ADDRESS: z.string().default("123 Example St, Example City, EX 00000"),
  SEND_RATE_PER_SEC: z.coerce.number().default(1),
  SEND_DAILY_CAP: z.coerce.number().default(200),
  SEND_MAX_ATTEMPTS: z.coerce.number().default(5),
  SEND_BACKOFF_MS: z.coerce.number().default(30_000),
  SCHEDULER_TIMEZONE: z.string().default("UTC"),
  MOCK_FAIL_RATE: z.coerce.number().min(0).max(1).default(0),

  AWS_REGION: z.string().default("us-east-1"),
  AWS_ACCESS_KEY_ID: z.string().optional(),
  AWS_SECRET_ACCESS_KEY: z.string().optional(),
  SES_CONFIGURATION_SET: z.string().optional(),

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
