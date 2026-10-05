// DB-backed override for the Meta WhatsApp Cloud API credentials that
// config/whatsapp.ts seeds from the environment. Lets an admin set/change the
// access token, phone number id, WABA id, app secret and webhook verify token
// from the Settings page instead of editing .env and restarting the API.
//
// Isolated from email: this reuses the generic Setting key-value store
// (domain/settings.ts) under its own key, the same way bulk-send pacing does —
// nothing email-related reads or writes this key, and nothing here touches
// EMAIL_*/SMTP_* settings.

import { getSetting, setSetting } from "./settings.js";
import { whatsappConfig } from "../config/whatsapp.js";

const KEY = "whatsappMetaCredentials";

interface StoredWhatsAppCredentials {
  accessToken?: string;
  phoneNumberId?: string;
  wabaId?: string;
  appSecret?: string;
  webhookVerifyToken?: string;
}

const FIELDS = ["accessToken", "phoneNumberId", "wabaId", "appSecret", "webhookVerifyToken"] as const;

export interface WhatsAppCredentials extends StoredWhatsAppCredentials {
  provider: string;
  graphApiBaseUrl: string;
  graphApiVersion: string;
  /** Whether any field above came from the Settings-page override rather than .env. */
  source: "database" | "environment";
}

/** Safe-to-return view: never includes the access token, app secret or verify token. */
export interface WhatsAppCredentialsView {
  provider: string;
  graphApiVersion: string;
  phoneNumberId: string | null;
  wabaId: string | null;
  hasAccessToken: boolean;
  hasAppSecret: boolean;
  hasWebhookVerifyToken: boolean;
  /** Outbound sending works. */
  configured: boolean;
  /** Inbound webhook can be verified and its signatures checked. */
  webhookConfigured: boolean;
  source: "database" | "environment";
}

function clean(v: string | undefined | null): string | undefined {
  const t = (v ?? "").trim();
  return t.length > 0 ? t : undefined;
}

/** Current effective credentials: a saved override wins over .env, field by field. */
export async function getWhatsAppCredentials(): Promise<WhatsAppCredentials> {
  const stored = (await getSetting<StoredWhatsAppCredentials | null>(KEY, null)) ?? {};
  const out: WhatsAppCredentials = {
    provider: whatsappConfig.provider,
    graphApiBaseUrl: whatsappConfig.graphApiBaseUrl,
    graphApiVersion: whatsappConfig.graphApiVersion,
    source: "environment",
  };
  for (const f of FIELDS) {
    const override = clean(stored[f]);
    if (override) out.source = "database";
    out[f] = override ?? whatsappConfig[f];
  }
  return out;
}

export function isSendConfigured(c: WhatsAppCredentials): boolean {
  return Boolean(c.provider === "meta" && c.accessToken && c.phoneNumberId);
}

export async function getWhatsAppCredentialsView(): Promise<WhatsAppCredentialsView> {
  const creds = await getWhatsAppCredentials();
  return {
    provider: creds.provider,
    graphApiVersion: creds.graphApiVersion,
    phoneNumberId: creds.phoneNumberId ?? null,
    wabaId: creds.wabaId ?? null,
    hasAccessToken: Boolean(creds.accessToken),
    hasAppSecret: Boolean(creds.appSecret),
    hasWebhookVerifyToken: Boolean(creds.webhookVerifyToken),
    configured: isSendConfigured(creds),
    webhookConfigured: Boolean(creds.appSecret && creds.webhookVerifyToken),
    source: creds.source,
  };
}

export type WhatsAppCredentialsInput = StoredWhatsAppCredentials;

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
  for (const f of FIELDS) {
    if (input[f] !== undefined) next[f] = clean(input[f]);
  }
  await setSetting(KEY, next);
  return getWhatsAppCredentialsView();
}

/** "Reset to environment values" — removes every saved override. */
export async function clearWhatsAppCredentials(): Promise<WhatsAppCredentialsView> {
  await setSetting(KEY, {});
  return getWhatsAppCredentialsView();
}
