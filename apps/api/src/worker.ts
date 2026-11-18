import "./http/types.js";
import { logger } from "./logger.js";
import { prisma } from "./prisma.js";
import { startAllWorkers } from "./queue/workers.js";
import { startScheduler } from "./queue/scheduler.js";
import { startHardStopFinalizer } from "./queue/hardStopFinalizer.js";
import { isHardStopEnabled } from "./config/hardStop.js";
import { initSentry } from "./observability/sentry.js";
import { productionConfigWarnings } from "./config/productionChecks.js";

initSentry("worker");
for (const warning of productionConfigWarnings()) logger.warn({ check: "production-config" }, warning);

const workers = startAllWorkers();
const scheduler = startScheduler();
// Hard stop (ENABLE_HARD_STOP): only started with the flag on; with it off the worker runs exactly as before.
const hardStopFinalizer = isHardStopEnabled() ? startHardStopFinalizer() : null;
logger.info({ workers: workers.length }, "queue workers + scheduler started (MySQL-backed)");

async function shutdown(signal: string) {
  logger.info({ signal }, "shutting down workers");
  hardStopFinalizer?.stop();
  await scheduler.stop();
  await Promise.allSettled(workers.map((w) => w.stop()));
  await prisma.$disconnect();
  process.exit(0);
}
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
