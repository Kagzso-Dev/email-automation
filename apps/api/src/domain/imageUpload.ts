import { mkdir, writeFile } from "node:fs/promises";
import { isAbsolute, join, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { env } from "../env.js";

/** Max accepted template-image upload. Kept in sync with the multer limit. */
export const IMAGE_UPLOAD_MAX_BYTES = 5 * 1024 * 1024;

/** Accepted image types → file extension used on disk. */
const EXT_BY_MIME: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
};

export const ACCEPTED_IMAGE_MIME = Object.keys(EXT_BY_MIME);

/** Permanent, user-facing upload failure — surfaced as a 400. */
export class ImageUploadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImageUploadError";
  }
}

/** Absolute path of the uploads root (env.UPLOADS_DIR, resolved from CWD). */
export function uploadsRoot(): string {
  return isAbsolute(env.UPLOADS_DIR) ? env.UPLOADS_DIR : join(process.cwd(), env.UPLOADS_DIR);
}

/**
 * If `url` points at a file this server stored under UPLOADS_DIR
 * (`${PUBLIC_API_URL}/uploads/...` or a bare `/uploads/...`), return its
 * absolute path on disk; otherwise null. External image URLs return null and
 * are left as-is. Rejects anything that would escape the uploads root.
 */
export function localUploadPath(url: string): string | null {
  if (typeof url !== "string") return null;
  const candidates = [`${env.PUBLIC_API_URL.replace(/\/$/, "")}/uploads/`, "/uploads/"];
  const prefix = candidates.find((p) => url.startsWith(p));
  if (!prefix) return null;

  let rel = url.slice(prefix.length).split(/[?#]/)[0];
  try {
    rel = decodeURIComponent(rel);
  } catch {
    return null;
  }
  if (!rel || rel.includes("\0") || rel.split(/[\\/]/).some((seg) => seg === "..")) return null;

  const root = uploadsRoot();
  const abs = join(root, rel);
  if (abs !== root && !abs.startsWith(root + sep)) return null;
  return abs;
}

/**
 * Confirm the bytes actually start with the magic number for the claimed type —
 * a cheap backstop against a renamed/incorrect Content-Type. Not a full decode.
 */
function magicMatches(buf: Buffer, mime: string): boolean {
  switch (mime) {
    case "image/jpeg":
      return buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
    case "image/png":
      return (
        buf.length > 8 &&
        buf[0] === 0x89 &&
        buf[1] === 0x50 &&
        buf[2] === 0x4e &&
        buf[3] === 0x47
      );
    case "image/gif":
      return buf.length > 6 && buf.toString("ascii", 0, 3) === "GIF";
    case "image/webp":
      return (
        buf.length > 12 &&
        buf.toString("ascii", 0, 4) === "RIFF" &&
        buf.toString("ascii", 8, 12) === "WEBP"
      );
    default:
      return false;
  }
}

export interface UploadedFile {
  buffer: Buffer;
  mimetype: string;
  size: number;
}

/**
 * Validate and persist one template image. Returns the public URL to store in
 * `Template.imageUrl` — the rest of the system treats it exactly like a pasted
 * URL. Throws `ImageUploadError` for anything the user can fix.
 */
export async function storeTemplateImage(
  file: UploadedFile,
  baseDir: string = uploadsRoot(),
): Promise<{ url: string; path: string; filename: string }> {
  const ext = EXT_BY_MIME[file.mimetype];
  if (!ext) {
    throw new ImageUploadError("Unsupported image type — use JPG, PNG, WebP or GIF");
  }
  if (file.size > IMAGE_UPLOAD_MAX_BYTES) {
    throw new ImageUploadError("Image is too large — maximum size is 5 MB");
  }
  if (!file.buffer?.length) {
    throw new ImageUploadError("The uploaded file is empty");
  }
  if (!magicMatches(file.buffer, file.mimetype)) {
    throw new ImageUploadError("That file doesn't look like a valid image");
  }

  const dir = join(baseDir, "template-images");
  await mkdir(dir, { recursive: true });
  const filename = `${Date.now().toString(36)}-${randomUUID()}.${ext}`;
  const path = join(dir, filename);
  await writeFile(path, file.buffer);

  return { url: `${env.PUBLIC_API_URL}/uploads/template-images/${filename}`, path, filename };
}
