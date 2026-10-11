// WhatsApp media: validation, private storage, Meta upload reuse, and queueing
// inbound media for download. WhatsApp-only — nothing here touches email
// uploads (domain/imageUpload.ts serves public template images; these files
// are private and only leave through authenticated routes).
//
// Limits and types follow Meta's Cloud API media reference (supported media
// types): image JPEG/PNG 5 MB; video MP4/3GP 16 MB; audio AAC/AMR/MP3/M4A/OGG
// (Opus) 16 MB; documents TXT/PDF/DOC(X)/XLS(X)/PPT(X) 100 MB; stickers WebP
// (500 KB animated, 100 KB static). Uploaded media ids live 30 days; ids from
// webhooks 7 days.

import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import type { WhatsAppMedia, WhatsAppMediaPurpose } from "@prisma/client";
import { prisma } from "../prisma.js";
import { logger } from "../logger.js";
import { whatsappConfig } from "../config/whatsapp.js";
import { uploadMedia } from "../services/whatsapp.js";
import { enqueueWhatsAppMediaDownload } from "../queue/queues.js";

export type WhatsAppMediaKind = "image" | "video" | "audio" | "document" | "sticker";
export const MEDIA_KINDS: readonly WhatsAppMediaKind[] = ["image", "video", "audio", "document", "sticker"];

const MB = 1024 * 1024;

/** MIME type → extension, per kind. Only these are accepted for sending. */
export const MEDIA_RULES: Record<WhatsAppMediaKind, { maxBytes: number; types: Record<string, string> }> = {
  image: { maxBytes: 5 * MB, types: { "image/jpeg": "jpg", "image/png": "png" } },
  video: { maxBytes: 16 * MB, types: { "video/mp4": "mp4", "video/3gpp": "3gp" } },
  audio: {
    maxBytes: 16 * MB,
    types: { "audio/aac": "aac", "audio/amr": "amr", "audio/mpeg": "mp3", "audio/mp4": "m4a", "audio/ogg": "ogg" },
  },
  document: {
    maxBytes: 100 * MB,
    types: {
      "application/pdf": "pdf",
      "text/plain": "txt",
      "application/msword": "doc",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
      "application/vnd.ms-excel": "xls",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
      "application/vnd.ms-powerpoint": "ppt",
      "application/vnd.openxmlformats-officedocument.presentationml.presentation": "pptx",
    },
  },
  sticker: { maxBytes: 500 * 1024, types: { "image/webp": "webp" } },
};

/** Largest file any kind allows — the multer limit for media uploads. */
export const MEDIA_MAX_BYTES = Math.max(...Object.values(MEDIA_RULES).map((r) => r.maxBytes));

/** Header media a template can be sent with (Meta media header formats IMAGE / VIDEO / DOCUMENT). */
export const HEADER_KINDS = ["image", "video", "document"] as const;
export type HeaderKind = (typeof HEADER_KINDS)[number];

export class MediaError extends Error {
  constructor(
    message: string,
    public readonly status = 400,
  ) {
    super(message);
    this.name = "MediaError";
  }
}

/* ------------------------------------------------------------------ content sniffing */

const ascii = (b: Buffer, start: number, end: number) => b.subarray(start, end).toString("latin1");

/**
 * The MIME type the bytes actually are (magic numbers), or null if unknown.
 * Office Open XML files are told apart by their part names; legacy Office
 * (OLE) files use `hint` (declared type / extension) to pick doc / xls / ppt.
 */
export function sniffMime(buf: Buffer, hint: string | null = null): string | null {
  if (buf.length < 4) return buf.length > 0 && isPlainText(buf) ? "text/plain" : null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (ascii(buf, 0, 4) === "RIFF" && ascii(buf, 8, 12) === "WEBP") return "image/webp";
  if (ascii(buf, 0, 5) === "%PDF-") return "application/pdf";
  if (ascii(buf, 0, 5) === "#!AMR") return "audio/amr";
  if (ascii(buf, 0, 4) === "OggS") return "audio/ogg";
  if (ascii(buf, 4, 8) === "ftyp") {
    const brand = ascii(buf, 8, 12);
    if (brand.startsWith("3g")) return "video/3gpp";
    if (brand === "M4A " || brand === "M4B ") return "audio/mp4";
    return "video/mp4";
  }
  if (ascii(buf, 0, 3) === "ID3") return "audio/mpeg";
  if (buf[0] === 0xff && (buf[1]! & 0xe0) === 0xe0) {
    // MPEG audio frame sync. Layer bits 00 = ADTS (AAC); otherwise MP3.
    return (buf[1]! & 0x06) === 0 ? "audio/aac" : "audio/mpeg";
  }
  if (buf[0] === 0x50 && buf[1] === 0x4b && buf[2] === 0x03 && buf[3] === 0x04) {
    const names = buf.toString("latin1");
    if (names.includes("word/")) return MS.docx;
    if (names.includes("xl/")) return MS.xlsx;
    if (names.includes("ppt/")) return MS.pptx;
    return "application/zip";
  }
  if (buf.subarray(0, 8).equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]))) {
    const h = (hint ?? "").toLowerCase();
    if (h.includes("excel") || /\.xls$/.test(h)) return MS.xls;
    if (h.includes("powerpoint") || /\.ppt$/.test(h)) return MS.ppt;
    return MS.doc;
  }
  return isPlainText(buf) ? "text/plain" : null;
}

const MS = {
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ppt: "application/vnd.ms-powerpoint",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};

function isPlainText(buf: Buffer): boolean {
  const head = buf.subarray(0, 8192);
  if (head.includes(0)) return false;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(head.length === buf.length ? head : trimUtf8(head));
    return true;
  } catch {
    return false;
  }
}

/** Drop a multi-byte character cut in half at the end of a sample. */
function trimUtf8(b: Buffer): Buffer {
  let end = b.length;
  for (let i = 1; i <= 3 && end - i >= 0; i++) {
    const c = b[end - i]!;
    if ((c & 0xc0) === 0xc0) return b.subarray(0, end - i);
    if ((c & 0x80) === 0) break;
  }
  return b;
}

/** "audio/ogg; codecs=opus" → "audio/ogg". */
export function baseMime(mime: string | null | undefined): string {
  return String(mime ?? "").split(";")[0]!.trim().toLowerCase();
}

/** Which kind a MIME type belongs to (webp counts as sticker). */
export function kindForMime(mime: string): WhatsAppMediaKind | null {
  for (const k of MEDIA_KINDS) if (MEDIA_RULES[k].types[baseMime(mime)]) return k;
  return null;
}

/** A display filename: no path, no control characters, max 200 chars; keeps a usable extension. */
export function safeFilename(name: string | null | undefined, fallbackExt: string): string {
  const base = String(name ?? "").split(/[\\/]/).pop() ?? "";
  // eslint-disable-next-line no-control-regex
  const clean = base.replace(/[\u0000-\u001f\u007f"<>|:*?]/g, "").replace(/^\.+/, "").trim().slice(-200);
  return clean || `file.${fallbackExt}`;
}

export interface ValidatedMedia {
  kind: WhatsAppMediaKind;
  mimeType: string;
  ext: string;
  filename: string;
  sizeBytes: number;
  sha256: string;
}

/**
 * Check a file we are about to send: its real content type (from the bytes,
 * not the browser's claim) must be a type Meta supports for `allowedKinds`,
 * and it must fit that kind's size limit.
 */
export function validateOutgoingMedia(
  data: Buffer,
  input: { declaredMime?: string | null; filename?: string | null },
  allowedKinds: readonly WhatsAppMediaKind[] = MEDIA_KINDS,
): ValidatedMedia {
  if (data.length === 0) throw new MediaError("The file is empty");
  const sniffed = sniffMime(data, input.declaredMime || input.filename || null);
  if (!sniffed) throw new MediaError("Unsupported file type — the content isn't a format WhatsApp accepts");
  const kind = kindForMime(sniffed);
  if (!kind || !allowedKinds.includes(kind)) {
    throw new MediaError(
      `This file is ${sniffed}; allowed here: ${allowedKinds
        .flatMap((k) => Object.values(MEDIA_RULES[k].types).map((e) => e.toUpperCase()))
        .join(", ")}`,
    );
  }
  const declared = baseMime(input.declaredMime);
  if (declared && declared !== "application/octet-stream" && kindForMime(declared) && kindForMime(declared) !== kind) {
    throw new MediaError(`The file says it is ${declared} but its content is ${sniffed}`);
  }
  const rule = MEDIA_RULES[kind];
  if (data.length > rule.maxBytes) {
    throw new MediaError(`${kind} files can be at most ${Math.round(rule.maxBytes / 1024)} KB for WhatsApp (this one is ${Math.ceil(data.length / 1024)} KB)`);
  }
  const ext = rule.types[sniffed]!;
  return {
    kind,
    mimeType: sniffed,
    ext,
    filename: safeFilename(input.filename, ext),
    sizeBytes: data.length,
    sha256: createHash("sha256").update(data).digest("hex"),
  };
}

/* ------------------------------------------------------------------ private storage */

export function mediaRoot(): string {
  const dir = whatsappConfig.mediaDir;
  return isAbsolute(dir) ? dir : join(process.cwd(), dir);
}

const KEY_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.[a-z0-9]{1,5}$/;

/** Absolute path for a storage key; rejects anything that isn't one of our generated names. */
export function mediaPath(storageKey: string): string {
  if (!KEY_RE.test(storageKey)) throw new MediaError("Invalid media reference", 404);
  return join(mediaRoot(), storageKey);
}

/** Write bytes under a random name (atomic: temp file + rename). Returns the storage key. */
export async function storeMediaFile(data: Buffer, ext: string): Promise<string> {
  const safeExt = /^[a-z0-9]{1,5}$/.test(ext) ? ext : "bin";
  const key = `${randomUUID()}.${safeExt}`;
  await mkdir(mediaRoot(), { recursive: true });
  const final = mediaPath(key);
  const tmp = `${final}.part`;
  try {
    await writeFile(tmp, data, { flag: "wx" });
    await rename(tmp, final);
  } catch (err) {
    await unlink(tmp).catch(() => undefined);
    throw err;
  }
  return key;
}

export async function readMediaFile(storageKey: string): Promise<Buffer> {
  return readFile(mediaPath(storageKey));
}

export async function mediaFileExists(storageKey: string): Promise<boolean> {
  try {
    return (await stat(mediaPath(storageKey))).isFile();
  } catch {
    return false;
  }
}

/** Validate + store an outgoing file and record it. */
export async function saveOutgoingMedia(
  data: Buffer,
  input: { declaredMime?: string | null; filename?: string | null },
  purpose: Exclude<WhatsAppMediaPurpose, "INBOUND">,
  allowedKinds: readonly WhatsAppMediaKind[],
  actorEmail: string | null,
): Promise<WhatsAppMedia> {
  const v = validateOutgoingMedia(data, input, allowedKinds);
  const storageKey = await storeMediaFile(data, v.ext);
  return prisma.whatsAppMedia.create({
    data: {
      purpose,
      kind: v.kind,
      status: "STORED",
      mimeType: v.mimeType,
      filename: v.filename,
      sizeBytes: v.sizeBytes,
      sha256: v.sha256,
      storageKey,
      createdByEmail: actorEmail,
    },
  });
}

/** Meta keeps uploads 30 days; re-upload a little before that. */
const UPLOAD_REUSE_MS = 29 * 24 * 3600_000;

/**
 * A Meta media id for one of our stored files, uploading it when there is no
 * id yet or the last one is close to expiry. Concurrent sends at worst upload
 * twice; both ids are valid.
 */
export async function ensureProviderMediaId(media: WhatsAppMedia): Promise<string> {
  if (media.purpose === "INBOUND") throw new MediaError("Inbound media can't be re-sent", 409);
  if (media.providerMediaId && media.providerMediaAt && Date.now() - media.providerMediaAt.getTime() < UPLOAD_REUSE_MS) {
    return media.providerMediaId;
  }
  if (!media.storageKey || !media.mimeType) throw new MediaError("Media file is missing", 409);
  const data = await readMediaFile(media.storageKey).catch(() => {
    throw new MediaError("Media file is missing from storage — upload it again", 409);
  });
  const { id } = await uploadMedia({ data, mimeType: media.mimeType, filename: media.filename ?? `file.${media.storageKey.split(".").pop()}` });
  await prisma.whatsAppMedia.update({ where: { id: media.id }, data: { providerMediaId: id, providerMediaAt: new Date() } });
  return id;
}

/* ------------------------------------------------------------------ inbound */

/**
 * Record media from an inbound message and queue its download. Idempotent on
 * the inbound message (Meta redelivers webhooks): one media row, one job.
 */
export async function queueInboundMedia(input: {
  inboundMessageId: string;
  kind: string;
  providerMediaId: string;
  mimeType: string | null;
  filename: string | null;
  sha256: string | null;
}): Promise<WhatsAppMedia> {
  const existing = await prisma.whatsAppMedia.findUnique({ where: { inboundMessageId: input.inboundMessageId } });
  if (existing) return existing; // webhook redelivery: already recorded (and queued)
  const kind = (MEDIA_KINDS as readonly string[]).includes(input.kind) ? input.kind : "document";
  let media: WhatsAppMedia;
  try {
    media = await prisma.whatsAppMedia.create({
      data: {
        purpose: "INBOUND",
        kind,
        status: "PENDING",
        mimeType: input.mimeType ? baseMime(input.mimeType) : null,
        filename: input.filename ? safeFilename(input.filename, "bin") : null,
        sha256: input.sha256,
        providerMediaId: input.providerMediaId,
        providerMediaAt: new Date(),
        inboundMessageId: input.inboundMessageId,
      },
    });
  } catch (err) {
    // Two deliveries of the same webhook raced: the other one created it.
    const again = await prisma.whatsAppMedia.findUnique({ where: { inboundMessageId: input.inboundMessageId } });
    if (again) return again;
    throw err;
  }
  await enqueueWhatsAppMediaDownload({ mediaId: media.id });
  logger.info({ mediaId: media.id, kind, inboundMessageId: input.inboundMessageId }, "whatsapp inbound media queued");
  return media;
}

/** Public view of a media row — no storage path, no provider ids. */
export function mediaView(m: WhatsAppMedia) {
  return {
    id: m.id,
    kind: m.kind,
    status: m.status,
    mimeType: m.mimeType,
    filename: m.filename,
    sizeBytes: m.sizeBytes,
    error: m.status === "FAILED" || m.status === "EXPIRED" ? m.error : null,
  };
}
export type MediaView = ReturnType<typeof mediaView>;
