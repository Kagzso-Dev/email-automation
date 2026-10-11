// Keeps a saved AI Call Customer's stage in step with its calls. Called from the
// AI call run path (run start, dial, webhook / poll result, cancel). Every entry
// point is a no-op for calls that aren't linked to a saved customer (calls
// started from an uploaded file), and never throws: a problem here is logged
// and must not disturb the call run itself.

import type { AiCallCustomerStage } from "@prisma/client";
import { maskPhone, stageForCallResult } from "@dispatch/shared";
import { prisma } from "../prisma.js";
import { logger } from "../logger.js";
import { addCustomerEvent, cancelPendingFollowups, createFollowupDrafts } from "./aiCallFollowups.js";

const FINAL = ["COMPLETED", "NO_ANSWER", "BUSY", "FAILED", "CANCELLED"];
/** Stages that are a fact, not an AI suggestion — no review needed. */
const FACT_STAGES: AiCallCustomerStage[] = ["NO_ANSWER", "FAILED", "DO_NOT_CALL"];

async function safely(what: string, logId: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (err) {
    logger.warn({ logId, err: err instanceof Error ? err.message : String(err) }, `ai call customer sync failed (${what})`);
  }
}

/** After a run is created from saved customers: link each call log and mark the customer Queued. */
export async function linkCustomersToRun(
  runId: string,
  links: { logId: string; customerId: string }[],
  actorEmail: string | null,
): Promise<void> {
  if (links.length === 0) return;
  await prisma.aiCallCustomerCall.createMany({ data: links, skipDuplicates: true });
  for (const l of links) {
    const c = await prisma.aiCallCustomer.findUnique({ where: { id: l.customerId }, select: { stage: true, doNotCall: true } });
    if (!c || c.doNotCall) continue;
    await prisma.aiCallCustomer.update({ where: { id: l.customerId }, data: { stage: "QUEUED", lastCallLogId: l.logId } });
    // The previous stage is kept on the event so a cancelled run can put it back.
    await addCustomerEvent({ customerId: l.customerId, type: "call_queued", stage: c.stage, refId: l.logId, detail: `Run ${runId}`, actorEmail });
  }
}

/** The dialler just handed this call to the voice backend. */
export function markCustomerCalling(logId: string): Promise<void> {
  return safely("calling", logId, async () => {
    const link = await prisma.aiCallCustomerCall.findUnique({ where: { logId } });
    if (!link) return;
    const c = await prisma.aiCallCustomer.findUnique({ where: { id: link.customerId }, select: { doNotCall: true } });
    if (!c || c.doNotCall) return;
    await prisma.aiCallCustomer.update({
      where: { id: link.customerId },
      data: { stage: "CALLING", lastCallLogId: logId, lastCalledAt: new Date(), needsReview: false },
    });
    await addCustomerEvent({ customerId: link.customerId, type: "call_started", stage: "CALLING", refId: logId });
  });
}

/**
 * A linked call reached a final status (or its outcome / summary arrived later):
 * store the suggested stage, apply Do not call at once, and create follow-up
 * drafts. Idempotent per (call, stage): repeated callbacks change nothing.
 */
export function syncCustomerFromLog(logId: string): Promise<void> {
  return safely("result", logId, async () => {
    const link = await prisma.aiCallCustomerCall.findUnique({ where: { logId } });
    if (!link) return;
    const log = await prisma.aiCallLog.findUnique({
      where: { id: logId },
      select: { status: true, outcome: true, summary: true, error: true, durationSec: true, startedAt: true },
    });
    if (!log || !FINAL.includes(log.status)) return;
    const customer = await prisma.aiCallCustomer.findUnique({ where: { id: link.customerId } });
    if (!customer) return;

    // Cancelled before it was ever dialled: put the stage back to what it was.
    if (log.status === "CANCELLED" && !log.startedAt) {
      if (customer.stage === "QUEUED" && customer.lastCallLogId === logId) {
        const queued = await prisma.aiCallCustomerEvent.findFirst({
          where: { customerId: customer.id, type: "call_queued", refId: logId },
          orderBy: { createdAt: "desc" },
        });
        const back = queued?.stage ?? "NOT_CALLED";
        await prisma.aiCallCustomer.update({ where: { id: customer.id }, data: { stage: back } });
        await addCustomerEvent({ customerId: customer.id, type: "call_cancelled", stage: back, refId: logId });
      }
      return;
    }

    const stage = stageForCallResult(log.status, log.outcome);
    const prev = await prisma.aiCallCustomerEvent.findFirst({
      where: { customerId: customer.id, type: "call_result", refId: logId },
      orderBy: { createdAt: "desc" },
    });
    if (prev && prev.stage === stage) return; // already applied

    const detail = [
      `Call ${log.status.toLowerCase().replace(/_/g, " ")}`,
      log.outcome ? `outcome: ${log.outcome.replace(/_/g, " ")}` : null,
      log.durationSec != null ? `${log.durationSec}s` : null,
      log.summary ? `— ${log.summary}` : log.error ? `— ${log.error}` : null,
    ]
      .filter(Boolean)
      .join(", ");
    await addCustomerEvent({ customerId: customer.id, type: "call_result", stage, detail, refId: logId });

    if (stage === "DO_NOT_CALL") {
      // Applied immediately and permanently, whatever was reviewed before.
      await prisma.aiCallCustomer.update({
        where: { id: customer.id },
        data: { stage: "DO_NOT_CALL", doNotCall: true, needsReview: false },
      });
      await addCustomerEvent({ customerId: customer.id, type: "do_not_call", stage: "DO_NOT_CALL", detail: "Customer asked not to be called", refId: logId });
      await cancelPendingFollowups(customer.id, "customer asked not to be called");
      logger.info({ customerId: customer.id, logId, phone: maskPhone(customer.phone) }, "ai call customer marked do-not-call");
      return;
    }
    if (customer.doNotCall) return;
    // A newer call exists, or an admin already reviewed this one: keep their stage.
    if (customer.lastCallLogId && customer.lastCallLogId !== logId) return;
    if (prev && !customer.needsReview && customer.stage !== "CALLING") return;

    const updated = await prisma.aiCallCustomer.update({
      where: { id: customer.id },
      data: { stage, needsReview: !FACT_STAGES.includes(stage), lastCallLogId: logId },
    });
    // A refined result for the same call replaces the drafts the earlier one created.
    await prisma.aiCallFollowup.updateMany({
      where: { customerId: customer.id, status: "PENDING_APPROVAL", sourceCallLogId: logId },
      data: { status: "CANCELLED", error: "Replaced by a newer call result" },
    });
    await createFollowupDrafts(updated, stage, { sourceCallLogId: logId });
  });
}
