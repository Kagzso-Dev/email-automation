// Validates Twilio's X-Twilio-Signature header on inbound status-callback
// requests, per Twilio's request-validation algorithm (HMAC-SHA1 over the
// exact callback URL + sorted form params, base64-encoded). No `twilio` SDK
// dependency — services/whatsapp.ts already avoids one; this keeps that.

import crypto from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { env } from "../../env.js";
import { getWhatsAppCredentials } from "../../domain/whatsappCredentials.js";
import { unauthorized } from "../errors.js";

export async function twilioSignatureRequired(req: Request, _res: Response, next: NextFunction) {
  const { authToken } = await getWhatsAppCredentials();
  if (!authToken) return next(unauthorized("WhatsApp is not configured"));

  const signature = req.headers["x-twilio-signature"];
  if (typeof signature !== "string") return next(unauthorized("Missing Twilio signature"));

  // Twilio signs the exact URL it was told to call (the StatusCallback we set
  // in services/whatsapp.ts), not whatever a proxy in front of us rewrites
  // req.protocol/host to — reconstruct from PUBLIC_API_URL to match.
  const url = `${env.PUBLIC_API_URL}${req.originalUrl}`.replace(/\?.*$/, "");
  const body = (req.body ?? {}) as Record<string, string>;
  const data =
    url +
    Object.keys(body)
      .sort()
      .map((k) => `${k}${body[k]}`)
      .join("");
  const expected = crypto.createHmac("sha1", authToken).update(Buffer.from(data, "utf-8")).digest("base64");

  const provided = Buffer.from(signature);
  const wanted = Buffer.from(expected);
  if (provided.length !== wanted.length || !crypto.timingSafeEqual(provided, wanted)) {
    return next(unauthorized("Invalid Twilio signature"));
  }
  next();
}
