// WhatsApp (Twilio) configuration — deliberately separate from src/env.ts.
//
// This module is fully isolated from the email environment loader: it reads its
// own WHATSAPP_* variables, never touches EMAIL_*/SMTP_*/SEND_* and, crucially,
// NEVER throws or calls process.exit. Missing or blank credentials simply yield
// `configured: false`, which disables the WhatsApp buttons — email sending and
// app startup are unaffected.

import { fileURLToPath } from "node:url";
import { config as loadEnv } from "dotenv";
import { logger } from "../logger.js";

// Same defensive load as src/env.ts. dotenv never overrides already-set vars,
// so calling this again is harmless.
loadEnv();
loadEnv({ path: fileURLToPath(new URL("../../../.env", import.meta.url)) });

function str(v: string | undefined): string | undefined {
  const t = (v ?? "").trim();
  return t.length > 0 ? t : undefined;
}

function intOr(v: string | undefined, fallback: number): number {
  const n = Number.parseInt((v ?? "").trim(), 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

const apiUrl = str(process.env.WHATSAPP_API_URL) ?? "https://api.twilio.com/2010-04-01";
const accountSid = str(process.env.WHATSAPP_ACCOUNT_SID);
const authToken = str(process.env.WHATSAPP_AUTH_TOKEN);
const from = str(process.env.WHATSAPP_FROM);
const defaultCountryCode = (str(process.env.WHATSAPP_DEFAULT_COUNTRY_CODE) ?? "").replace(/\D/g, "");

// Drip pacing between individual WhatsApp sends — its own knobs, independent of
// the email BULK_SEND_* settings.
const rawMin = intOr(process.env.WHATSAPP_MIN_DELAY_SEC, 8);
const rawMax = intOr(process.env.WHATSAPP_MAX_DELAY_SEC, 25);
const minDelaySec = Math.min(rawMin, rawMax);
const maxDelaySec = Math.max(rawMin, rawMax);

export const whatsappConfig = {
  apiUrl,
  accountSid,
  authToken,
  from,
  defaultCountryCode: defaultCountryCode || undefined,
  minDelaySec,
  maxDelaySec,
} as const;

/** True only when Twilio can actually be called. */
export function isWhatsAppConfigured(): boolean {
  return Boolean(whatsappConfig.accountSid && whatsappConfig.authToken && whatsappConfig.from);
}

function isLocalUrl(url: string | undefined): boolean {
  return !url || /localhost|127\.0\.0\.1/i.test(url);
}

// Public base URL Twilio can actually reach for delivery/read status
// callbacks. WHATSAPP_PUBLIC_BASE_URL wins; PUBLIC_API_URL (the email env's
// base URL) is only a fallback, kept for backward compatibility — it is read
// directly off process.env here rather than imported from src/env.ts, so this
// module stays fully independent of the email env loader per the header note
// above. Resolves to undefined when only a localhost value is available,
// since Twilio rejects a non-public StatusCallback outright (error 21609).
const rawPublicBaseUrl = str(process.env.WHATSAPP_PUBLIC_BASE_URL);
const rawFallbackBaseUrl = str(process.env.PUBLIC_API_URL);
const effectiveBaseUrl = rawPublicBaseUrl ?? rawFallbackBaseUrl;
const publicBaseUrl = isLocalUrl(effectiveBaseUrl) ? undefined : effectiveBaseUrl!.replace(/\/$/, "");

if (isLocalUrl(effectiveBaseUrl)) {
  logger.warn(
    `⚠️  WHATSAPP_PUBLIC_BASE_URL is not set to a public URL (currently: ${effectiveBaseUrl ?? "unset"}). ` +
      "Outbound WhatsApp sends will fail with Twilio error 21609 until this is fixed in .env.",
  );
}

/**
 * Full Twilio StatusCallback URL for outgoing WhatsApp messages, or
 * undefined when no public base URL is configured — callers should omit the
 * StatusCallback param entirely in that case rather than sending a localhost
 * URL Twilio will reject. Also used by the inbound webhook's signature check
 * so both sides hash the exact same URL.
 */
export function whatsappStatusCallbackUrl(): string | undefined {
  return publicBaseUrl ? `${publicBaseUrl}/api/webhooks/whatsapp/status` : undefined;
}
