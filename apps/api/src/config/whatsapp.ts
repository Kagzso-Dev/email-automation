// WhatsApp (Twilio) configuration — deliberately separate from src/env.ts.
//
// This module is fully isolated from the email environment loader: it reads its
// own WHATSAPP_* variables, never touches EMAIL_*/SMTP_*/SEND_* and, crucially,
// NEVER throws or calls process.exit. Missing or blank credentials simply yield
// `configured: false`, which disables the WhatsApp buttons — email sending and
// app startup are unaffected.

import { fileURLToPath } from "node:url";
import { config as loadEnv } from "dotenv";

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
