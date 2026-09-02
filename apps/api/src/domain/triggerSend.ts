import type { TriggerWebhookInput } from "@dispatch/shared";
import { logger } from "../logger.js";
import { prisma } from "../prisma.js";
import { evaluateConditions } from "./conditions.js";
import { queueJobId, triggerKey } from "./idempotency.js";
import { isSuppressed } from "./suppression.js";
import { enqueueSend, type SendEmailJob } from "../queue/queues.js";
import type { TriggerCondition } from "@dispatch/shared";

export type TriggerResult =
  | { status: "queued"; emailLogId?: string; idempotencyKey: string }
  | { status: "skipped"; reason: string };

export async function fireTrigger(
  eventKey: string,
  input: TriggerWebhookInput,
): Promise<TriggerResult> {
  const trigger = await prisma.trigger.findUnique({ where: { eventKey } });
  if (!trigger || !trigger.active) return { status: "skipped", reason: "no active trigger" };

  const conditions = (
    Array.isArray(trigger.conditions) ? trigger.conditions : []
  ) as TriggerCondition[];
  if (!evaluateConditions(conditions, input.payload)) {
    return { status: "skipped", reason: "conditions not met" };
  }

  const email = input.contactEmail.toLowerCase();
  const contact = await prisma.contact.upsert({
    where: { email },
    create: {
      email,
      firstName: input.contact?.firstName,
      lastName: input.contact?.lastName,
      customFields: input.contact?.customFields ?? {},
    },
    update: input.contact
      ? {
          firstName: input.contact.firstName,
          lastName: input.contact.lastName,
          ...(input.contact.customFields ? { customFields: input.contact.customFields } : {}),
        }
      : {},
  });

  if (await isSuppressed(contact.id)) {
    logger.info({ eventKey, contactId: contact.id }, "trigger skipped: suppressed");
    return { status: "skipped", reason: "suppressed" };
  }

  const idempotencyKey = triggerKey(trigger.id, contact.id, {
    dedupeKey: input.dedupeKey,
    payload: input.payload,
  });

  const source: SendEmailJob["source"] = {
    type: "trigger",
    triggerId: trigger.id,
    payload: input.payload as Record<string, unknown>,
  };
  await enqueueSend(
    { idempotencyKey, contactId: contact.id, source },
    { dedupeKey: queueJobId(idempotencyKey) },
  );

  return { status: "queued", idempotencyKey };
}
