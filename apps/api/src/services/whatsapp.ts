// Meta WhatsApp Cloud API client — the only place that talks to the Graph API.
// Everything else (bulk-send worker, routes, scripts) calls these functions.
//
// Isolated from the email provider stack (provider/*, domain/delivery.ts). Uses
// the global fetch (Node 20+), so there is no SDK dependency.

import { logger } from "../logger.js";
import {
  getWhatsAppCredentials,
  isSendConfigured,
  type WhatsAppCredentials,
} from "../domain/whatsappCredentials.js";

export class WhatsAppNotConfiguredError extends Error {
  constructor() {
    super(
      "WhatsApp is not configured (set META_WHATSAPP_ACCESS_TOKEN and META_WHATSAPP_PHONE_NUMBER_ID, or fill them in under Settings)",
    );
    this.name = "WhatsAppNotConfiguredError";
  }
}

export class WhatsAppSendError extends Error {
  constructor(
    message: string,
    /** true → transient, safe to retry; false → permanent. */
    readonly retryable: boolean,
    /** Meta error code, when the Graph API returned one. */
    readonly code?: string,
  ) {
    super(message);
    this.name = "WhatsAppSendError";
  }
}

// Graph / WhatsApp error codes Meta documents as temporary (rate limits,
// throttling, service unavailable) — worth retrying later.
const RETRYABLE_CODES = new Set([1, 2, 4, 17, 341, 80007, 130429, 131000, 131016, 131048, 133004]);

/** Meta wants the recipient as digits with country code and no "+". */
export function toRecipient(value: string): string {
  return value.replace(/[^\d]/g, "");
}

export interface WhatsAppSendResult {
  providerMessageId: string;
}

interface GraphError {
  message?: string;
  type?: string;
  code?: number;
  error_subcode?: number;
  error_data?: { details?: string };
  fbtrace_id?: string;
}

type SendCredentials = WhatsAppCredentials & { accessToken: string; phoneNumberId: string };

async function loadCredentials(): Promise<SendCredentials> {
  const creds = await getWhatsAppCredentials();
  if (!isSendConfigured(creds)) throw new WhatsAppNotConfiguredError();
  return creds as SendCredentials;
}

function graphUrl(creds: WhatsAppCredentials, path: string): string {
  return `${creds.graphApiBaseUrl.replace(/\/$/, "")}/${creds.graphApiVersion}/${path}`;
}

async function graphRequest<T>(
  creds: WhatsAppCredentials,
  method: "GET" | "POST",
  path: string,
  payload?: unknown,
): Promise<T> {
  let res: Response;
  try {
    res = await fetch(graphUrl(creds, path), {
      method,
      headers: {
        Authorization: `Bearer ${creds.accessToken}`,
        ...(payload ? { "Content-Type": "application/json" } : {}),
      },
      ...(payload ? { body: JSON.stringify(payload) } : {}),
    });
  } catch (err) {
    // Network / DNS / socket — always worth a retry.
    throw new WhatsAppSendError(`network error: ${(err as Error).message}`, true);
  }

  const json = (await res.json().catch(() => ({}))) as T & { error?: GraphError };
  if (!res.ok || json.error) {
    const e = json.error ?? {};
    const detail = [e.message ?? res.statusText, e.error_data?.details].filter(Boolean).join(" — ");
    const retryable = res.status === 429 || res.status >= 500 || (e.code !== undefined && RETRYABLE_CODES.has(e.code));
    logger.warn(
      { status: res.status, code: e.code, subcode: e.error_subcode, fbtrace: e.fbtrace_id, detail },
      "whatsapp graph api request failed",
    );
    throw new WhatsAppSendError(
      `Meta ${res.status}${e.code !== undefined ? ` (#${e.code})` : ""}: ${detail}`,
      retryable,
      e.code !== undefined ? String(e.code) : undefined,
    );
  }
  return json;
}

/** POST a message object to /{phone-number-id}/messages and return Meta's message id. */
async function sendMessage(to: string, message: Record<string, unknown>): Promise<WhatsAppSendResult> {
  const creds = await loadCredentials();
  const recipient = toRecipient(to);
  const json = await graphRequest<{ messages?: { id?: string }[] }>(
    creds,
    "POST",
    `${creds.phoneNumberId}/messages`,
    { messaging_product: "whatsapp", recipient_type: "individual", to: recipient, ...message },
  );
  const id = json.messages?.[0]?.id;
  if (!id) throw new WhatsAppSendError("Meta accepted the request but returned no message id", false);
  logger.info({ wamid: id, to: recipient, type: message.type }, "whatsapp message sent");
  return { providerMessageId: id };
}

/**
 * Free-form text. Meta only delivers this inside the 24-hour customer-service
 * window (after the recipient last messaged us); outside it, use a template.
 */
export function sendTextMessage(input: { to: string; body: string; previewUrl?: boolean }) {
  return sendMessage(input.to, {
    type: "text",
    text: { body: input.body, preview_url: input.previewUrl ?? false },
  });
}

export interface TemplateComponent {
  type: "header" | "body" | "button";
  sub_type?: "quick_reply" | "url";
  index?: string;
  parameters: Record<string, unknown>[];
}

/**
 * Positional template params ({"1": "Ada", "2": "Acme"}) → a Meta "body"
 * component, ordered by position. Undefined when there are none.
 */
export function bodyComponentsFromVariables(
  vars: Record<string, string> | null | undefined,
): TemplateComponent[] | undefined {
  const keys = Object.keys(vars ?? {}).sort((a, b) => Number(a) - Number(b));
  if (keys.length === 0) return undefined;
  return [{ type: "body", parameters: keys.map((k) => ({ type: "text", text: vars![k] })) }];
}

/** A Meta-approved message template — the only way to open a conversation. */
export function sendTemplateMessage(input: {
  to: string;
  templateName: string;
  languageCode: string;
  components?: TemplateComponent[];
}) {
  return sendMessage(input.to, {
    type: "template",
    template: {
      name: input.templateName,
      language: { code: input.languageCode },
      ...(input.components?.length ? { components: input.components } : {}),
    },
  });
}

export type WhatsAppMediaType = "image" | "video" | "audio" | "document" | "sticker";

/**
 * Media by an uploaded Meta media id, or by a public HTTPS link. Captions are
 * supported for image/video/document only; filename for document only.
 */
export function sendMediaMessage(input: {
  to: string;
  mediaType: WhatsAppMediaType;
  mediaId?: string;
  link?: string;
  caption?: string;
  filename?: string;
}) {
  if (!input.mediaId === !input.link) {
    throw new WhatsAppSendError("sendMediaMessage needs exactly one of mediaId or link", false);
  }
  const media: Record<string, string> = input.mediaId ? { id: input.mediaId } : { link: input.link! };
  if (input.caption && ["image", "video", "document"].includes(input.mediaType)) media.caption = input.caption;
  if (input.filename && input.mediaType === "document") media.filename = input.filename;
  return sendMessage(input.to, { type: input.mediaType, [input.mediaType]: media });
}

export interface WhatsAppPhoneNumberInfo {
  id: string;
  displayPhoneNumber?: string;
  verifiedName?: string;
  qualityRating?: string;
}

/** Read the configured sender number — used by Settings to test the credentials. */
export async function getPhoneNumberInfo(): Promise<WhatsAppPhoneNumberInfo> {
  const creds = await loadCredentials();
  const json = await graphRequest<{
    id: string;
    display_phone_number?: string;
    verified_name?: string;
    quality_rating?: string;
  }>(creds, "GET", `${creds.phoneNumberId}?fields=display_phone_number,verified_name,quality_rating`);
  return {
    id: json.id,
    displayPhoneNumber: json.display_phone_number,
    verifiedName: json.verified_name,
    qualityRating: json.quality_rating,
  };
}
