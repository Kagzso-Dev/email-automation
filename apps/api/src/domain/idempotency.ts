import { createHash } from "node:crypto";

/**
 * Idempotency key format (see technical-design.html §4):
 *   {campaign|trigger}:{sourceId}:{contactId}:{occurrence}
 *
 * - Campaign occurrence is the scheduled run date (YYYY-MM-DD), so the same
 *   contact receives Monday's and Tuesday's digest but never two of Monday's.
 * - Trigger occurrence is a caller-supplied dedupeKey, or a hash of the
 *   payload, so an identical webhook call retried produces one send.
 */
export function campaignKey(campaignId: string, contactId: string, runDate: Date): string {
  const day = runDate.toISOString().slice(0, 10);
  return `campaign:${campaignId}:${contactId}:${day}`;
}

/**
 * BullMQ rejects custom job ids containing ":", so derive a queue-safe id from
 * the idempotency key. Still deterministic — repeat enqueues dedupe.
 */
export function queueJobId(idempotencyKey: string): string {
  return idempotencyKey.replace(/:/g, "_");
}

/**
 * Manual one-off send from the UI. The occurrence is a wall-clock stamp so each
 * click is its own send (an operator re-sending on purpose is expected), while a
 * double-submit within the same second still dedupes.
 */
export function manualKey(templateId: string, contactId: string): string {
  const stamp = new Date().toISOString().slice(0, 19).replace(/[^0-9]/g, "");
  return `manual:${templateId}:${contactId}:${stamp}`;
}

export function triggerKey(
  triggerId: string,
  contactId: string,
  opts: { dedupeKey?: string; payload: unknown },
): string {
  const occurrence =
    opts.dedupeKey ??
    createHash("sha256").update(JSON.stringify(opts.payload ?? {})).digest("hex").slice(0, 16);
  return `trigger:${triggerId}:${contactId}:${occurrence}`;
}
