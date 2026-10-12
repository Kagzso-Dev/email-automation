// Meta WhatsApp Cloud API webhook — verification handshake and event
// processing. The HTTP layer (http/routes/whatsappWebhook.ts) checks the
// X-Hub-Signature-256 header before anything here runs.
//
// One POST can carry several entries/changes; each "messages" change holds
// either `statuses` (delivery receipts for messages we sent) or `messages`
// (things a recipient sent us), sometimes both.

import crypto from "node:crypto";
import type { Prisma } from "@prisma/client";
import { prisma } from "../prisma.js";
import { logger } from "../logger.js";
import { applyWhatsAppStatusEvent } from "./whatsappTracking.js";
import { queueInboundMedia } from "./whatsappMedia.js";
import { recordStatusPricing, type MetaStatusPricing } from "./whatsappPricing.js";

/* ---------------------------------------------------------------- verification */

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/**
 * GET handshake Meta performs when the callback URL is saved: echo back
 * `hub.challenge` only if the mode is "subscribe" and the verify token matches.
 * Returns the challenge to send, or null to reject.
 */
export function verifyWebhookSubscription(
  query: Record<string, unknown>,
  expectedToken: string | undefined,
): string | null {
  const mode = query["hub.mode"];
  const token = query["hub.verify_token"];
  const challenge = query["hub.challenge"];
  if (!expectedToken) return null;
  if (mode !== "subscribe" || typeof token !== "string" || typeof challenge !== "string") return null;
  return safeEqual(token, expectedToken) ? challenge : null;
}

/** `X-Hub-Signature-256: sha256=<hex HMAC-SHA256 of the raw body, keyed by the app secret>`. */
export function isValidMetaSignature(rawBody: Buffer, header: string | undefined, appSecret: string): boolean {
  if (!header?.startsWith("sha256=")) return false;
  const expected = crypto.createHmac("sha256", appSecret).update(rawBody).digest("hex");
  return safeEqual(header.slice("sha256=".length), expected);
}

/* ---------------------------------------------------------------- payload types */

interface MetaStatus {
  id: string;
  status: string;
  timestamp?: string;
  recipient_id?: string;
  errors?: { code?: number; title?: string; message?: string; error_data?: { details?: string } }[];
  pricing?: MetaStatusPricing;
}

interface MetaMedia {
  id?: string;
  mime_type?: string;
  caption?: string;
  filename?: string;
  sha256?: string;
}

interface MetaInboundMessage {
  id: string;
  from: string;
  timestamp?: string;
  type: string;
  context?: { id?: string };
  text?: { body?: string };
  image?: MetaMedia;
  video?: MetaMedia;
  audio?: MetaMedia;
  document?: MetaMedia;
  sticker?: MetaMedia;
  button?: { text?: string; payload?: string };
  interactive?: {
    type?: string;
    button_reply?: { id?: string; title?: string };
    list_reply?: { id?: string; title?: string };
  };
  location?: { latitude?: number; longitude?: number; name?: string; address?: string };
  reaction?: { message_id?: string; emoji?: string };
}

interface MetaChangeValue {
  messaging_product?: string;
  metadata?: { display_phone_number?: string; phone_number_id?: string };
  contacts?: { wa_id?: string; profile?: { name?: string } }[];
  messages?: MetaInboundMessage[];
  statuses?: MetaStatus[];
}

export interface MetaWebhookPayload {
  object?: string;
  entry?: { id?: string; changes?: { field?: string; value?: MetaChangeValue }[] }[];
}

/* ---------------------------------------------------------------- parsing */

function fromUnix(ts: string | undefined): Date | undefined {
  const n = Number(ts);
  return Number.isFinite(n) && n > 0 ? new Date(n * 1000) : undefined;
}

const MEDIA_TYPES = ["image", "video", "audio", "document", "sticker"] as const;

export interface ParsedInboundMessage {
  providerMessageId: string;
  phone: string;
  profileName: string | null;
  messageType: string;
  body: string | null;
  mediaId: string | null;
  mediaMimeType: string | null;
  replyPayload: string | null;
  contextMessageId: string | null;
  sentAt: Date;
}

/** Flatten one Meta inbound message into the columns we store. */
export function parseInboundMessage(m: MetaInboundMessage, profileName: string | null): ParsedInboundMessage {
  let body: string | null = null;
  let mediaId: string | null = null;
  let mediaMimeType: string | null = null;
  let replyPayload: string | null = null;
  let contextMessageId = m.context?.id ?? null;

  if (m.type === "text") body = m.text?.body ?? null;
  else if ((MEDIA_TYPES as readonly string[]).includes(m.type)) {
    const media = m[m.type as (typeof MEDIA_TYPES)[number]];
    mediaId = media?.id ?? null;
    mediaMimeType = media?.mime_type ?? null;
    body = media?.caption ?? media?.filename ?? null;
  } else if (m.type === "button") {
    // Quick-reply button tapped on a template we sent.
    body = m.button?.text ?? null;
    replyPayload = m.button?.payload ?? null;
  } else if (m.type === "interactive") {
    const reply = m.interactive?.button_reply ?? m.interactive?.list_reply;
    body = reply?.title ?? null;
    replyPayload = reply?.id ?? null;
  } else if (m.type === "location" && m.location) {
    const { latitude, longitude, name, address } = m.location;
    body = [name, address, latitude !== undefined ? `${latitude},${longitude}` : null].filter(Boolean).join(" — ") || null;
  } else if (m.type === "reaction") {
    body = m.reaction?.emoji ?? null;
    contextMessageId = m.reaction?.message_id ?? contextMessageId;
  }

  return {
    providerMessageId: m.id,
    phone: m.from.replace(/[^\d]/g, ""),
    profileName,
    messageType: m.type,
    body,
    mediaId,
    mediaMimeType,
    replyPayload,
    contextMessageId,
    sentAt: fromUnix(m.timestamp) ?? new Date(),
  };
}

/* ---------------------------------------------------------------- processing */

async function recordInboundMessage(parsed: ParsedInboundMessage, raw: MetaInboundMessage): Promise<void> {
  const contact = await prisma.whatsAppContact.findUnique({
    where: { phone: parsed.phone },
    select: { id: true },
  });
  // Upsert on the message id: Meta redelivers events it didn't get a 200 for.
  const row = await prisma.whatsAppInboundMessage.upsert({
    where: { providerMessageId: parsed.providerMessageId },
    create: {
      ...parsed,
      whatsappContactId: contact?.id ?? null,
      raw: raw as unknown as Prisma.InputJsonValue,
    },
    update: {},
  });
  logger.info(
    { wamid: parsed.providerMessageId, from: parsed.phone, type: parsed.messageType },
    "whatsapp inbound message received",
  );

  // Media: record it and download in the background (the webhook still returns at
  // once). Idempotent on the message, so redeliveries don't download twice. A
  // failure here never fails the webhook — the message itself is already saved.
  if (parsed.mediaId && row?.id) {
    const media = (MEDIA_TYPES as readonly string[]).includes(raw.type) ? raw[raw.type as (typeof MEDIA_TYPES)[number]] : undefined;
    try {
      await queueInboundMedia({
        inboundMessageId: row.id,
        kind: parsed.messageType,
        providerMediaId: parsed.mediaId,
        mimeType: parsed.mediaMimeType,
        filename: media?.filename ?? null,
        sha256: media?.sha256 ?? null,
      });
    } catch (err) {
      logger.warn(
        { wamid: parsed.providerMessageId, err: err instanceof Error ? err.message : String(err) },
        "whatsapp inbound media could not be queued",
      );
    }
  }
}

export interface WebhookResult {
  statuses: number;
  messages: number;
  ignored: number;
}

/**
 * Apply every status and inbound message in a verified webhook payload.
 * Events addressed to a different phone number id than the configured one
 * (another number on the same WABA) are ignored.
 */
export async function processMetaWebhook(
  payload: MetaWebhookPayload,
  phoneNumberId: string | undefined,
): Promise<WebhookResult> {
  const result: WebhookResult = { statuses: 0, messages: 0, ignored: 0 };
  if (payload.object !== "whatsapp_business_account") {
    result.ignored++;
    return result;
  }

  for (const entry of payload.entry ?? []) {
    for (const change of entry.changes ?? []) {
      const value = change.value;
      if (change.field !== "messages" || !value) {
        result.ignored++;
        continue;
      }
      const target = value.metadata?.phone_number_id;
      if (phoneNumberId && target && target !== phoneNumberId) {
        logger.info({ target }, "whatsapp webhook for another phone number id — ignored");
        result.ignored++;
        continue;
      }

      for (const s of value.statuses ?? []) {
        const err = s.errors?.[0];
        await applyWhatsAppStatusEvent({
          providerMessageId: s.id,
          status: s.status,
          timestamp: fromUnix(s.timestamp),
          errorCode: err?.code !== undefined ? String(err.code) : undefined,
          errorMessage: err ? (err.error_data?.details ?? err.message ?? err.title) : undefined,
        });
        result.statuses++;
        // Added: Meta's pricing info for the cost estimate. Runs after the status update
        // above has finished and never throws (see domain/whatsappPricing.ts).
        await recordStatusPricing(s);
      }

      for (const m of value.messages ?? []) {
        const profile = value.contacts?.find((c) => c.wa_id === m.from)?.profile?.name ?? null;
        await recordInboundMessage(parseInboundMessage(m, profile), m);
        result.messages++;
      }
    }
  }
  return result;
}
