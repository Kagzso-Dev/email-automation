import * as Sentry from "@sentry/node";
import { env } from "../env.js";
import { logger } from "../logger.js";

export function initSentry(context: "api" | "worker") {
  if (!env.SENTRY_DSN) return;
  Sentry.init({
    dsn: env.SENTRY_DSN,
    environment: env.NODE_ENV,
    tracesSampleRate: 0.1,
    initialScope: { tags: { process: context } },
  });
  logger.info({ context }, "Sentry initialised");
}

export { Sentry };
