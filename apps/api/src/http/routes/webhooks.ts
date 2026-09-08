import { Router } from "express";
import { rateLimit } from "express-rate-limit";
import { triggerWebhookInput } from "@dispatch/shared";
import { env } from "../../env.js";
import { logger } from "../../logger.js";
import { prisma } from "../../prisma.js";
import { fireTrigger } from "../../domain/triggerSend.js";
import { applyDeliveryEvent } from "../../domain/tracking.js";
import { applyWhatsAppStatusEvent, type WhatsAppStatusEvent } from "../../domain/whatsappTracking.js";
import { apiKeyRequired } from "../middleware/apiKey.js";
import { twilioSignatureRequired } from "../middleware/twilioSignature.js";
import { wrap } from "../errors.js";

export const webhooksRouter = Router();

const webhookLimiter = rateLimit({ windowMs: 60_000, limit: 120, standardHeaders: true });

/* ---------------------------------------------- external event trigger */

webhooksRouter.post(
  "/trigger/:eventKey",
  webhookLimiter,
  apiKeyRequired,
  wrap(async (req, res) => {
    const input = triggerWebhookInput.parse(req.body);
    const result = await fireTrigger(req.params.eventKey, input);
    // Always 202 — a no-op (suppressed / conditions) is a valid outcome, not an error.
    res.status(202).json(result);
  }),
);

/* ---------------------------------------------- WhatsApp (Twilio) status callback */

// Twilio POSTs here (application/x-www-form-urlencoded) as messages it sent
// progress through queued/sent/delivered/read/failed. Configured as the
// StatusCallback on every outgoing message in services/whatsapp.ts. Verified
// by X-Twilio-Signature instead of our own API key — Twilio can't send one.
webhooksRouter.post(
  "/whatsapp/status",
  webhookLimiter,
  twilioSignatureRequired,
  wrap(async (req, res) => {
    const body = req.body as Record<string, string>;
    const status = (body.MessageStatus ?? "").toLowerCase() as WhatsAppStatusEvent["status"];
    if (body.MessageSid && status) {
      await applyWhatsAppStatusEvent({
        providerMessageId: body.MessageSid,
        status,
        errorCode: body.ErrorCode || undefined,
        errorMessage: body.ErrorMessage || undefined,
      });
    }
    res.status(204).end(); // Twilio only checks for a 2xx
  }),
);

/* ---------------------------------------------- dev-only: simulate provider events */

if (env.NODE_ENV !== "production") {
  webhooksRouter.post(
    "/dev/simulate/:emailLogId/:event",
    wrap(async (req, res) => {
      const log = await prisma.emailLog.findUnique({ where: { id: req.params.emailLogId } });
      if (!log?.providerMessageId) return res.status(404).json({ error: "no such sent email" });
      const event = req.params.event as "delivered" | "bounced" | "complained";
      await applyDeliveryEvent(
        event === "bounced"
          ? { type: "bounced", providerMessageId: log.providerMessageId, hard: true }
          : event === "complained"
            ? { type: "complained", providerMessageId: log.providerMessageId }
            : { type: "delivered", providerMessageId: log.providerMessageId },
      );
      logger.info({ emailLogId: log.id, event }, "simulated delivery event");
      res.json({ ok: true });
    }),
  );

  webhooksRouter.post(
    "/dev/simulate-whatsapp/:whatsappSendId/:event",
    wrap(async (req, res) => {
      const send = await prisma.whatsAppSend.findUnique({ where: { id: req.params.whatsappSendId } });
      if (!send?.providerMessageId) return res.status(404).json({ error: "no such sent whatsapp message" });
      const event = req.params.event as WhatsAppStatusEvent["status"];
      await applyWhatsAppStatusEvent({
        providerMessageId: send.providerMessageId,
        status: event,
        errorMessage: event === "failed" || event === "undelivered" ? "simulated failure" : undefined,
      });
      logger.info({ whatsappSendId: send.id, event }, "simulated whatsapp status event");
      res.json({ ok: true });
    }),
  );
}
