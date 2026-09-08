// Applies Twilio status-callback events to the whatsapp_sends ledger. Mirrors
// domain/tracking.ts (email) in shape, but kept separate on purpose: WhatsApp
// send/tracking code never imports from the email tree.

import type { WhatsAppSendStatus } from "@prisma/client";
import { prisma } from "../prisma.js";
import { logger } from "../logger.js";

// Rank so status only ever advances. FAILED is highest — once Twilio reports a
// message failed/undelivered, a stray out-of-order "sent"/"delivered" retry of
// the same webhook can't downgrade it.
const RANK: Record<WhatsAppSendStatus, number> = {
  QUEUED: 0,
  SENDING: 1,
  SENT: 2,
  DELIVERED: 3,
  READ: 4,
  FAILED: 5,
  SKIPPED: 0,
};

export interface WhatsAppStatusEvent {
  providerMessageId: string;
  /** Twilio's MessageStatus value, lowercased. */
  status: "queued" | "sending" | "sent" | "delivered" | "read" | "failed" | "undelivered";
  errorCode?: string;
  errorMessage?: string;
}

const STATUS_MAP: Record<WhatsAppStatusEvent["status"], WhatsAppSendStatus | null> = {
  // Twilio also reports these two, but we already set them locally the moment
  // the send call returns / is attempted — nothing new to record.
  queued: null,
  sending: null,
  sent: "SENT",
  delivered: "DELIVERED",
  read: "READ",
  failed: "FAILED",
  undelivered: "FAILED",
};

export async function applyWhatsAppStatusEvent(ev: WhatsAppStatusEvent): Promise<void> {
  const mapped = STATUS_MAP[ev.status];
  if (!mapped) return;

  const send = await prisma.whatsAppSend.findFirst({
    where: { providerMessageId: ev.providerMessageId },
    orderBy: { createdAt: "desc" },
  });
  if (!send) {
    logger.warn(
      { providerMessageId: ev.providerMessageId, status: ev.status },
      "whatsapp status event: no matching send",
    );
    return;
  }
  if (RANK[mapped] <= RANK[send.status]) return; // idempotent / out-of-order no-op

  const data: Record<string, unknown> = { status: mapped };
  if (mapped === "DELIVERED" || mapped === "READ") {
    if (!send.deliveredAt) data.deliveredAt = new Date();
  }
  if (mapped === "READ") data.readAt = new Date();
  if (mapped === "FAILED") {
    data.failedAt = new Date();
    data.error = ev.errorMessage
      ? `Twilio ${ev.errorCode ?? ""}: ${ev.errorMessage}`.trim()
      : send.error;
  }

  await prisma.whatsAppSend.update({ where: { id: send.id }, data });
  logger.info({ whatsappSendId: send.id, status: mapped }, "whatsapp status event applied");
}
