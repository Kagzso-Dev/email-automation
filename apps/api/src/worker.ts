import "./http/types.js";
import { logger } from "./logger.js";
import { prisma } from "./prisma.js";
import { startAllWorkers } from "./queue/workers.js";
import { startScheduler } from "./queue/scheduler.js";
import { initSentry } from "./observability/sentry.js";

initSentry("worker");

const workers = startAllWorkers();
const scheduler = startScheduler();
logger.info({ workers: workers.length }, "queue workers + scheduler started (MySQL-backed)");

async function shutdown(signal: string) {
  logger.info({ signal }, "shutting down workers");
  await scheduler.stop();
  await Promise.allSettled(workers.map((w) => w.stop()));
  await prisma.$disconnect();
  process.exit(0);
}
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
