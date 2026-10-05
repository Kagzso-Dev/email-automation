// Meta WhatsApp Cloud API webhook: GET /api/webhooks/whatsapp for the
// subscription handshake, POST for message + delivery-status events.
//
// Mounted in http/app.ts BEFORE the global express.json() parser, because the
// X-Hub-Signature-256 HMAC is computed over the exact raw request bytes — the
// POST route reads the body with express.raw() and only parses JSON after the
// signature checks out. Requests without a valid signature are rejected; there
// is no bypass, including in development.

import express, { Router } from "express";
import { rateLimit } from "express-rate-limit";
import { getWhatsAppCredentials } from "../../domain/whatsappCredentials.js";
import {
  isValidMetaSignature,
  processMetaWebhook,
  verifyWebhookSubscription,
  type MetaWebhookPayload,
} from "../../domain/whatsappWebhook.js";
import { logger } from "../../logger.js";
import { badRequest, forbidden, unauthorized, wrap } from "../errors.js";

export const whatsappWebhookRouter = Router();

// Statuses arrive in bursts (sent → delivered → read per message), so this is
// more generous than the email trigger limiter.
const limiter = rateLimit({ windowMs: 60_000, limit: 600, standardHeaders: true });

whatsappWebhookRouter.get(
  "/",
  limiter,
  wrap(async (req, res) => {
    const { webhookVerifyToken } = await getWhatsAppCredentials();
    const challenge = verifyWebhookSubscription(req.query as Record<string, unknown>, webhookVerifyToken);
    if (challenge === null) {
      logger.warn({ mode: req.query["hub.mode"] }, "whatsapp webhook verification rejected");
      throw forbidden("Webhook verification failed");
    }
    res.status(200).type("text/plain").send(challenge);
  }),
);

whatsappWebhookRouter.post(
  "/",
  limiter,
  express.raw({ type: "*/*", limit: "2mb" }),
  wrap(async (req, res) => {
    const { appSecret, phoneNumberId } = await getWhatsAppCredentials();
    // Fail closed: without the app secret there's no way to tell Meta's
    // requests from anyone else's.
    if (!appSecret) throw unauthorized("WhatsApp webhook app secret is not configured");

    const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    const signature = req.headers["x-hub-signature-256"];
    if (!isValidMetaSignature(raw, typeof signature === "string" ? signature : undefined, appSecret)) {
      throw unauthorized("Invalid webhook signature");
    }

    let payload: MetaWebhookPayload;
    try {
      payload = JSON.parse(raw.toString("utf8")) as MetaWebhookPayload;
    } catch {
      throw badRequest("Webhook body is not valid JSON");
    }

    const result = await processMetaWebhook(payload, phoneNumberId);
    logger.debug(result, "whatsapp webhook processed");
    // Meta only checks for a 200; anything else makes it redeliver.
    res.sendStatus(200);
  }),
);
