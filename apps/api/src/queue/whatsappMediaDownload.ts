// Downloads one inbound WhatsApp media file (queued by the webhook, so Meta gets
// its 200 at once). Flow: GET /{media-id} for a fresh ~5-minute URL → download
// with the access token (size-capped) → check sha256 and the real content type
// → store privately under a random name. Permanent problems (expired id, too
// large, wrong content) mark the row FAILED / EXPIRED and stop; transient ones
// (network, 5xx, an expired URL) throw so the queue retries with backoff.

import { createHash } from "node:crypto";
import { prisma } from "../prisma.js";
import { logger } from "../logger.js";
import { downloadMedia, getMediaInfo, WhatsAppSendError } from "../services/whatsapp.js";
import { baseMime, kindForMime, MEDIA_RULES, sniffMime, storeMediaFile, type WhatsAppMediaKind } from "../domain/whatsappMedia.js";
import type { WhatsAppMediaDownloadJob } from "./queues.js";

/** Meta keeps media from webhooks for 7 days. */
const INBOUND_TTL_MS = 7 * 24 * 3600_000;
/** After this many tries the row is marked FAILED (matches the job's maxAttempts). */
const MAX_TRIES = 4;
/** Meta error codes meaning "this media id no longer exists / isn't accessible". */
const GONE_CODES = new Set(["100", "131052", "404"]);

/** Inbound files of a type we don't send (e.g. .zip) are still kept, as a download, up to this size. */
const OTHER_MAX_BYTES = 100 * 1024 * 1024;

function limitFor(kind: string): number {
  return (MEDIA_RULES as Record<string, { maxBytes: number }>)[kind]?.maxBytes ?? OTHER_MAX_BYTES;
}

/** Inbound media: does the content match what the message said it was? */
function contentMatches(kind: string, declared: string, sniffed: string | null): boolean {
  if (!sniffed) return kind === "document"; // unknown document formats are kept as downloads
  if (baseMime(declared) === sniffed) return true;
  const k = kindForMime(sniffed);
  if (k === kind) return true;
  // Stickers are WebP images; an "image" may legitimately arrive as webp; voice notes are ogg/opus.
  if (kind === "image" && sniffed === "image/webp") return true;
  if (kind === "document") return true; // a document can be any file; it is served as a download
  return false;
}

async function settle(id: string, status: "FAILED" | "EXPIRED", error: string) {
  await prisma.whatsAppMedia.update({ where: { id }, data: { status, error: error.slice(0, 1000) } });
  logger.warn({ mediaId: id, status, error }, "whatsapp inbound media not stored");
  return { [status.toLowerCase()]: error };
}

export async function processWhatsAppMediaDownload(payload: Record<string, unknown>): Promise<unknown> {
  const { mediaId } = payload as unknown as WhatsAppMediaDownloadJob;
  const media = await prisma.whatsAppMedia.findUnique({ where: { id: mediaId } });
  if (!media || media.purpose !== "INBOUND" || media.status !== "PENDING") return { skipped: true };
  if (!media.providerMediaId) return settle(media.id, "FAILED", "No Meta media id on the message");

  const tries = media.attempts + 1;
  await prisma.whatsAppMedia.update({ where: { id: media.id }, data: { attempts: tries } });
  if (media.providerMediaAt && Date.now() - media.providerMediaAt.getTime() > INBOUND_TTL_MS) {
    return settle(media.id, "EXPIRED", "Meta keeps received media for 7 days; this one is older");
  }

  try {
    const info = await getMediaInfo(media.providerMediaId);
    const limit = limitFor(media.kind);
    const size = Number(info.file_size ?? 0);
    if (size > limit) return settle(media.id, "FAILED", `File is ${size} bytes, over the ${limit}-byte limit`);

    const data = await downloadMedia(info.url, limit);
    const sha256 = createHash("sha256").update(data).digest("hex");
    const expected = (info.sha256 ?? media.sha256 ?? "").toLowerCase();
    if (expected && /^[0-9a-f]{64}$/.test(expected) && expected !== sha256) {
      return settle(media.id, "FAILED", "Downloaded file doesn't match Meta's sha256 checksum");
    }

    const declared = baseMime(info.mime_type ?? media.mimeType);
    const sniffed = sniffMime(data, declared || media.filename);
    if (!contentMatches(media.kind, declared, sniffed)) {
      return settle(media.id, "FAILED", `Content is ${sniffed ?? "unrecognised"}, not the ${declared || media.kind} the message declared`);
    }
    const mimeType = sniffed ?? (declared || "application/octet-stream");
    const kind = kindForMime(mimeType) as WhatsAppMediaKind | null;
    const ext = (kind && MEDIA_RULES[kind].types[mimeType]) || "bin";
    const storageKey = await storeMediaFile(data, ext);
    await prisma.whatsAppMedia.update({
      where: { id: media.id },
      data: { status: "STORED", storageKey, mimeType, sizeBytes: data.length, sha256, error: null },
    });
    logger.info({ mediaId: media.id, kind: media.kind, bytes: data.length }, "whatsapp inbound media stored");
    return { stored: data.length };
  } catch (err) {
    const e = err instanceof WhatsAppSendError ? err : null;
    const message = err instanceof Error ? err.message : String(err);
    if (e?.code === "too_large") return settle(media.id, "FAILED", message);
    if (e && !e.retryable && e.code && GONE_CODES.has(e.code)) return settle(media.id, "EXPIRED", message);
    if ((e && !e.retryable) || tries >= MAX_TRIES) return settle(media.id, "FAILED", message);
    throw err; // transient: the queue retries with backoff (a fresh URL is fetched each time)
  }
}
