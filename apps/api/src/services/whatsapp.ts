// Twilio WhatsApp send service — the only place that talks to Twilio.
//
// Isolated from the email provider stack (provider/*, domain/delivery.ts). Uses
// the global fetch (Node 20+), so there is no new dependency.

import { logger } from "../logger.js";
import { isWhatsAppConfigured, whatsappConfig } from "../config/whatsapp.js";

export class WhatsAppNotConfiguredError extends Error {
  constructor() {
    super("WhatsApp is not configured (set WHATSAPP_ACCOUNT_SID, WHATSAPP_AUTH_TOKEN, WHATSAPP_FROM)");
    this.name = "WhatsAppNotConfiguredError";
  }
}

export class WhatsAppSendError extends Error {
  constructor(
    message: string,
    /** true → transient, safe to retry; false → permanent. */
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "WhatsAppSendError";
  }
}

/** "whatsapp:+<digits>" — accepts a bare digit string or an already-prefixed value. */
function waAddress(value: string): string {
  const trimmed = value.trim();
  if (trimmed.toLowerCase().startsWith("whatsapp:")) return trimmed;
  const digits = trimmed.replace(/[^\d]/g, "");
  return `whatsapp:+${digits}`;
}

export interface SendWhatsAppTemplateInput {
  /** Recipient phone — digits (country code included) or a whatsapp: address. */
  to: string;
  /** Twilio Content SID (HX…). */
  contentSid: string;
  /** Positional Twilio content variables, e.g. { "1": "Ada", "2": "Acme" }. */
  contentVariables: Record<string, string>;
}

export interface WhatsAppSendResult {
  providerMessageId: string;
}

export async function sendWhatsAppTemplate(
  input: SendWhatsAppTemplateInput,
): Promise<WhatsAppSendResult> {
  if (!isWhatsAppConfigured()) throw new WhatsAppNotConfiguredError();
  const { apiUrl, accountSid, authToken, from } = whatsappConfig;

  const url = `${apiUrl.replace(/\/$/, "")}/Accounts/${accountSid}/Messages.json`;
  const body = new URLSearchParams({
    From: waAddress(from!),
    To: waAddress(input.to),
    ContentSid: input.contentSid,
    ContentVariables: JSON.stringify(input.contentVariables ?? {}),
  });

  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString("base64")}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body,
    });
  } catch (err) {
    // Network / DNS / socket — always worth a retry.
    throw new WhatsAppSendError(`network error: ${(err as Error).message}`, true);
  }

  const json = (await res.json().catch(() => ({}))) as {
    sid?: string;
    status?: string;
    code?: number;
    message?: string;
    error_message?: string;
  };

  if (!res.ok) {
    const detail = json.message ?? json.error_message ?? res.statusText;
    const retryable = res.status === 429 || res.status >= 500;
    logger.warn(
      { status: res.status, code: json.code, detail, to: input.to },
      "whatsapp send failed",
    );
    throw new WhatsAppSendError(`Twilio ${res.status}: ${detail}`, retryable);
  }

  logger.info(
    { sid: json.sid, status: json.status, to: input.to, contentSid: input.contentSid },
    "whatsapp message sent",
  );
  return { providerMessageId: json.sid ?? "" };
}
