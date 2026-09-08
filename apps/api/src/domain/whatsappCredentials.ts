// DB-backed override for the Twilio credentials that config/whatsapp.ts seeds
// from the environment. Lets an admin set/change WHATSAPP_ACCOUNT_SID,
// WHATSAPP_AUTH_TOKEN and WHATSAPP_FROM from the Settings page instead of
// editing .env and restarting the API.
//
// Isolated from email: this reuses the generic Setting key-value store
// (domain/settings.ts) under its own key, the same way bulk-send pacing does —
// nothing email-related reads or writes this key, and nothing here touches
// EMAIL_*/SMTP_* settings.

import { getSetting, setSetting } from "./settings.js";
import { whatsappConfig } from "../config/whatsapp.js";

const KEY = "whatsappCredentials";

interface StoredWhatsAppCredentials {
  accountSid?: string;
  authToken?: string;
  from?: string;
}

export interface WhatsAppCredentials {
  apiUrl: string;
  accountSid?: string;
  authToken?: string;
  from?: string;
  /** Whether any field above came from the Settings-page override rather than .env. */
  source: "database" | "environment";
}

/** Safe-to-return view: never includes the auth token itself. */
export interface WhatsAppCredentialsView {
  accountSid: string | null;
  from: string | null;
  hasAuthToken: boolean;
  configured: boolean;
  source: "database" | "environment";
}

function clean(v: string | undefined | null): string | undefined {
  const t = (v ?? "").trim();
  return t.length > 0 ? t : undefined;
}

/** Current effective credentials: a saved override wins over .env, field by field. */
export async function getWhatsAppCredentials(): Promise<WhatsAppCredentials> {
  const stored = await getSetting<StoredWhatsAppCredentials | null>(KEY, null);
  const overrideAccountSid = clean(stored?.accountSid);
  const overrideAuthToken = clean(stored?.authToken);
  const overrideFrom = clean(stored?.from);

  return {
    apiUrl: whatsappConfig.apiUrl,
    accountSid: overrideAccountSid ?? whatsappConfig.accountSid,
    authToken: overrideAuthToken ?? whatsappConfig.authToken,
    from: overrideFrom ?? whatsappConfig.from,
    source: overrideAccountSid || overrideAuthToken || overrideFrom ? "database" : "environment",
  };
}

export async function getWhatsAppCredentialsView(): Promise<WhatsAppCredentialsView> {
  const creds = await getWhatsAppCredentials();
  return {
    accountSid: creds.accountSid ?? null,
    from: creds.from ?? null,
    hasAuthToken: Boolean(creds.authToken),
    configured: Boolean(creds.accountSid && creds.authToken && creds.from),
    source: creds.source,
  };
}

export interface WhatsAppCredentialsInput {
  accountSid?: string;
  authToken?: string;
  from?: string;
}

/**
 * Save admin-entered credentials into the Setting table. A field sent as an
 * empty string clears that override so it falls back to .env again; a field
 * left out of the input entirely is left untouched.
 */
export async function setWhatsAppCredentials(
  input: WhatsAppCredentialsInput,
): Promise<WhatsAppCredentialsView> {
  const existing = (await getSetting<StoredWhatsAppCredentials | null>(KEY, null)) ?? {};
  const next: StoredWhatsAppCredentials = { ...existing };
  if (input.accountSid !== undefined) next.accountSid = clean(input.accountSid);
  if (input.authToken !== undefined) next.authToken = clean(input.authToken);
  if (input.from !== undefined) next.from = clean(input.from);
  await setSetting(KEY, next);
  return getWhatsAppCredentialsView();
}

/** "Reset to environment values" — removes every saved override. */
export async function clearWhatsAppCredentials(): Promise<WhatsAppCredentialsView> {
  await setSetting(KEY, {});
  return getWhatsAppCredentialsView();
}
