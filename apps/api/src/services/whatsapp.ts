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
    /** Meta error_subcode — often the precise reason (e.g. which permission/asset). */
    readonly subcode?: string,
    /** Meta fbtrace_id — quote this to Meta support to trace the failed request. */
    readonly fbtraceId?: string,
  ) {
    super(message);
    this.name = "WhatsAppSendError";
  }
}

// Graph / WhatsApp error codes Meta documents as temporary (rate limits,
// throttling, service unavailable) — worth retrying later.
const RETRYABLE_CODES = new Set([1, 2, 4, 17, 341, 80007, 130429, 131000, 131016, 131048, 131056, 133004]);

/** Remove the access token from any text before it is logged or stored. */
export function redactToken(text: string, token: string | undefined): string {
  return token && token.length >= 8 ? text.split(token).join("[redacted]") : text;
}

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
  if (!res.ok || json.error) throw graphError(res, json.error ?? {}, creds);
  return json;
}

/** Meta's error response → WhatsAppSendError (token redacted, retryable flag, code / subcode / fbtrace). */
function graphError(res: Response, e: GraphError, creds: WhatsAppCredentials): WhatsAppSendError {
  // Meta's text never contains our token, but redact defensively before it is stored.
  const detail = redactToken(
    [e.message ?? res.statusText, e.error_data?.details].filter(Boolean).join(" — "),
    creds.accessToken,
  );
  const retryable = res.status === 429 || res.status >= 500 || (e.code !== undefined && RETRYABLE_CODES.has(e.code));
  logger.warn(
    { status: res.status, code: e.code, subcode: e.error_subcode, fbtrace: e.fbtrace_id, detail },
    "whatsapp graph api request failed",
  );
  // Subcode + fbtrace_id go into the message, which the Send Queue stores and shows.
  const trace = [
    e.error_subcode !== undefined ? `subcode ${e.error_subcode}` : null,
    e.fbtrace_id ? `fbtrace_id ${e.fbtrace_id}` : null,
  ].filter(Boolean);
  return new WhatsAppSendError(
    `Meta ${res.status}${e.code !== undefined ? ` (#${e.code})` : ""}: ${detail}${trace.length ? ` [${trace.join(", ")}]` : ""}`,
    retryable,
    e.code !== undefined ? String(e.code) : undefined,
    e.error_subcode !== undefined ? String(e.error_subcode) : undefined,
    e.fbtrace_id,
  );
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
export async function sendMediaMessage(input: {
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

export interface MetaMessageTemplate {
  name: string;
  status: string;
  language: string;
  category?: string;
  id?: string;
  parameter_format?: string;
  /** HEADER (format / text) tells whether a send needs a header parameter; BODY / BUTTONS feed "Sync from Meta". */
  components?: { type: string; format?: string; text?: string; buttons?: { type: string; text?: string; url?: string }[] }[];
}

/**
 * Every message template in the WABA (GET /{waba-id}/message_templates), following
 * paging cursors. Read-only: used to verify registered templates, never to send.
 */
export async function listMessageTemplates(): Promise<MetaMessageTemplate[]> {
  const creds = await getWhatsAppCredentials();
  if (!creds.accessToken || !creds.wabaId) {
    throw new WhatsAppSendError("WhatsApp access token or WABA id is not set (META_WHATSAPP_ACCESS_TOKEN / META_WHATSAPP_WABA_ID)", false);
  }
  const out: MetaMessageTemplate[] = [];
  let after: string | undefined;
  for (let page = 0; page < 40; page++) {
    const query = new URLSearchParams({ fields: "id,name,status,language,category,parameter_format,components", limit: "250", ...(after ? { after } : {}) });
    const json = await graphRequest<{
      data?: MetaMessageTemplate[];
      paging?: { next?: string; cursors?: { after?: string } };
    }>(creds, "GET", `${creds.wabaId}/message_templates?${query}`);
    out.push(...(json.data ?? []));
    after = json.paging?.next ? json.paging.cursors?.after : undefined;
    if (!after) break;
  }
  return out;
}

/* ---------------------------------------------------------------- media (upload / download) */

/**
 * Upload a file to Meta (POST /{phone-number-id}/media, multipart) and return
 * its media id. Meta keeps uploaded media for 30 days.
 */
export async function uploadMedia(input: { data: Buffer; mimeType: string; filename: string }): Promise<{ id: string }> {
  const creds = await loadCredentials();
  const form = new FormData();
  form.append("messaging_product", "whatsapp");
  form.append("type", input.mimeType);
  form.append("file", new Blob([new Uint8Array(input.data)], { type: input.mimeType }), input.filename);
  let res: Response;
  try {
    res = await fetch(graphUrl(creds, `${creds.phoneNumberId}/media`), {
      method: "POST",
      headers: { Authorization: `Bearer ${creds.accessToken}` },
      body: form,
      signal: AbortSignal.timeout(120_000),
    });
  } catch (err) {
    throw new WhatsAppSendError(`network error: ${(err as Error).message}`, true);
  }
  const json = (await res.json().catch(() => ({}))) as { id?: string; error?: GraphError };
  if (!res.ok || json.error) throw graphError(res, json.error ?? {}, creds);
  if (!json.id) throw new WhatsAppSendError("Meta accepted the upload but returned no media id", false);
  logger.info({ mediaId: json.id, mimeType: input.mimeType, bytes: input.data.length }, "whatsapp media uploaded");
  return { id: json.id };
}

export interface MetaMediaInfo {
  id: string;
  /** Short-lived (about 5 minutes) download URL; needs the access token. */
  url: string;
  mime_type?: string;
  sha256?: string;
  file_size?: number | string;
}

/** GET /{media-id}: a fresh download URL plus Meta's mime type, sha256 and size. */
export async function getMediaInfo(mediaId: string): Promise<MetaMediaInfo> {
  const creds = await loadCredentials();
  const q = new URLSearchParams({ phone_number_id: creds.phoneNumberId });
  const info = await graphRequest<MetaMediaInfo>(creds, "GET", `${encodeURIComponent(mediaId)}?${q}`);
  if (!info.url) throw new WhatsAppSendError("Meta returned no download URL for this media", false);
  return info;
}

/**
 * Download a media URL from getMediaInfo (authenticated, server side only).
 * Stops reading — and fails — as soon as the body passes `maxBytes`.
 */
export async function downloadMedia(url: string, maxBytes: number): Promise<Buffer> {
  const creds = await loadCredentials();
  // Only Meta's own media hosts are fetched with our token (SSRF / token-leak guard).
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    throw new WhatsAppSendError("Meta returned an invalid media URL", false);
  }
  if (!/(^|\.)(fbsbx\.com|facebook\.com|fbcdn\.net|whatsapp\.net)$/i.test(host) || !url.startsWith("https://")) {
    throw new WhatsAppSendError(`refusing to download media from unexpected host ${host}`, false);
  }
  let res: Response;
  try {
    res = await fetch(url, { headers: { Authorization: `Bearer ${creds.accessToken}` }, signal: AbortSignal.timeout(120_000) });
  } catch (err) {
    throw new WhatsAppSendError(`network error: ${(err as Error).message}`, true);
  }
  if (!res.ok || !res.body) {
    // 404: the URL expired — the caller asks for a new one (retryable).
    throw new WhatsAppSendError(`media download failed: HTTP ${res.status}`, res.status === 404 || res.status >= 500, String(res.status));
  }
  const declared = Number(res.headers.get("content-length") ?? "0");
  if (declared > maxBytes) throw new WhatsAppSendError(`media is ${declared} bytes, over the ${maxBytes}-byte limit`, false, "too_large");
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = res.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new WhatsAppSendError(`media is over the ${maxBytes}-byte limit`, false, "too_large");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

export type TemplateHeaderMediaKind = "image" | "video" | "document";

/** The header component that fills a template's image / video / document header with an uploaded media id. */
export function headerMediaComponent(kind: TemplateHeaderMediaKind, mediaId: string, filename?: string | null): TemplateComponent {
  const media: Record<string, string> = { id: mediaId };
  if (kind === "document" && filename) media.filename = filename;
  return { type: "header", parameters: [{ type: kind, [kind]: media }] };
}

/* ---------------------------------------------------------------- template creation (Dispatch → Meta) */

/** Credentials plus the WABA id (template management works on the WhatsApp Business Account). */
async function loadWabaCredentials(): Promise<SendCredentials & { wabaId: string }> {
  const creds = await loadCredentials();
  if (!creds.wabaId) throw new WhatsAppSendError("META_WHATSAPP_WABA_ID is not set", false);
  return creds as SendCredentials & { wabaId: string };
}

let cachedAppId: { token: string; appId: string } | null = null;

/** The Meta app id the access token belongs to (GET /debug_token) — needed for the Resumable Upload API. */
export async function getAppId(): Promise<string> {
  const creds = await loadCredentials();
  if (cachedAppId?.token === creds.accessToken) return cachedAppId.appId;
  const q = new URLSearchParams({ input_token: creds.accessToken });
  const json = await graphRequest<{ data?: { app_id?: string } }>(creds, "GET", `debug_token?${q}`);
  const appId = json.data?.app_id;
  if (!appId) throw new WhatsAppSendError("Couldn't find the Meta app id for this access token", false);
  cachedAppId = { token: creds.accessToken, appId };
  return appId;
}

/**
 * Upload a header example (Resumable Upload API) and return the handle Meta
 * wants in example.header_handle. Accepted: JPEG / PNG / MP4 / PDF.
 */
export async function uploadTemplateExample(input: { data: Buffer; mimeType: string; filename: string }): Promise<string> {
  const creds = await loadCredentials();
  const appId = await getAppId();
  const start = new URLSearchParams({
    file_name: input.filename,
    file_length: String(input.data.length),
    file_type: input.mimeType,
  });
  const session = await graphRequest<{ id?: string }>(creds, "POST", `${appId}/uploads?${start}`);
  if (!session.id) throw new WhatsAppSendError("Meta didn't start an upload session", false);
  let res: Response;
  try {
    res = await fetch(graphUrl(creds, session.id), {
      method: "POST",
      headers: { Authorization: `OAuth ${creds.accessToken}`, file_offset: "0", "Content-Type": "application/octet-stream" },
      body: new Uint8Array(input.data),
      signal: AbortSignal.timeout(120_000),
    });
  } catch (err) {
    throw new WhatsAppSendError(`network error: ${(err as Error).message}`, true);
  }
  const json = (await res.json().catch(() => ({}))) as { h?: string; error?: GraphError };
  if (!res.ok || json.error) throw graphError(res, json.error ?? {}, creds);
  if (!json.h) throw new WhatsAppSendError("Meta accepted the upload but returned no file handle", false);
  return json.h;
}

/**
 * Submit a new message template for Meta's review (POST /{waba-id}/message_templates).
 * Returns Meta's id and initial status (usually PENDING; sometimes APPROVED at once).
 */
export async function createMessageTemplate(payload: Record<string, unknown>): Promise<{ id: string; status: string; category?: string }> {
  const creds = await loadWabaCredentials();
  const json = await graphRequest<{ id?: string; status?: string; category?: string }>(creds, "POST", `${creds.wabaId}/message_templates`, payload);
  if (!json.id) throw new WhatsAppSendError("Meta accepted the template but returned no id", false);
  logger.info({ templateId: json.id, name: payload.name, status: json.status }, "whatsapp template submitted to Meta");
  return { id: json.id, status: json.status ?? "PENDING", category: json.category };
}
