import "./http/types.js";
import { env } from "./env.js";
import { logger } from "./logger.js";
import { prisma } from "./prisma.js";
import { redis } from "./redis.js";
import { createApp } from "./http/app.js";
import { initSentry } from "./observability/sentry.js";

initSentry("api");

const app = createApp();
const server = app.listen(env.API_PORT, () => {
  logger.info(
    { port: env.API_PORT, provider: env.EMAIL_PROVIDER, env: env.NODE_ENV },
    "API listening",
  );
});

async function shutdown(signal: string) {
  logger.info({ signal }, "shutting down API");
  server.close();
  await Promise.allSettled([prisma.$disconnect(), redis.quit()]);
  process.exit(0);
}
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
