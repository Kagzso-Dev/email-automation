// Hard stop (ENABLE_HARD_STOP): turns a stop from "Stopping... (N in progress)" into "Stopped" once the last item
// that was in progress at the stop has ended, so it finishes even when nobody is watching. Runs in the worker every
// 15 s (and the API calls finalizeHardStop when it reads a stop). Never touches anything in progress.

import { prisma } from "../prisma.js";
import { logger } from "../logger.js";
import { isHardStopEnabled } from "../config/hardStop.js";
import { inProgressNow, markStopped, settleStuckInProgress, stoppedBatches, sweepCoveredEmailJobs } from "../domain/hardStop.js";
import { purgeAfterHardStop as purgeEmailBatch } from "./manualBulkSend.js";
import { purgeAfterHardStop as purgeWhatsAppBatch } from "./whatsappBulkSend.js";

const TICK_MS = 15_000;

/** STOPPING → STOPPED when nothing it covered is in progress any more. Idempotent; true when this call finished it. */
export async function finalizeHardStop(stopId: string): Promise<boolean> {
  const stop = await prisma.hardStop.findUnique({ where: { id: stopId } });
  if (!stop || stop.status !== "STOPPING") return false;
  await settleStuckInProgress(stop.id);
  if ((await inProgressNow(stop.id)) > 0) return false;
  // Nothing is in progress, so nothing can schedule another retry: cancel any an in-progress email scheduled.
  await sweepCoveredEmailJobs(stop);
  // Lead-gen: delete only the contacts each stopped batch confirmed it reached (never cancelled or unsent ones).
  const { email, whatsapp } = await stoppedBatches(stop.id);
  for (const id of email) await purgeEmailBatch(id);
  for (const id of whatsapp) await purgeWhatsAppBatch(id);
  return markStopped(stop.id);
}

export async function finalizeOpenHardStops(): Promise<void> {
  const open = await prisma.hardStop.findMany({ where: { status: "STOPPING" }, select: { id: true } });
  for (const { id } of open) {
    try {
      await finalizeHardStop(id);
    } catch (err) {
      logger.error({ err, stopId: id }, "hard stop finalize failed — will retry");
    }
  }
}

/** Started by the worker. Each tick re-reads the flag, so it does nothing while ENABLE_HARD_STOP is off. */
export function startHardStopFinalizer(): { stop: () => void } {
  let running = false;
  const tick = async () => {
    if (running || !isHardStopEnabled()) return;
    running = true;
    try {
      await finalizeOpenHardStops();
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => void tick(), TICK_MS);
  void tick();
  return { stop: () => clearInterval(timer) };
}
