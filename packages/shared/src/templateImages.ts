import { z } from "zod";

// Per-image size and alt text for template images (ENABLE_IMAGE_SIZE_CONTROLS, off by default).
//
// A template's `images` JSON holds either plain URL strings (every image saved before this feature)
// or objects carrying the settings below. A string, or an object without `size`, renders exactly as
// before. The rules here are shared so the editor's live size label and the email renderer agree.

/** Small: a fixed 200px (never above the image's own width). */
export const IMAGE_SMALL_PX = 200;
/** Best fit fills a 600px email column (the usual email width), never above the image's own width. */
export const IMAGE_COLUMN_PX = 600;
export const IMAGE_ALT_MAX = 125;
export const IMAGE_NATURAL_WIDTH_MAX = 20_000;

export const templateImageSize = z.enum(["small", "fit", "original"]);
export type TemplateImageSize = z.infer<typeof templateImageSize>;

/** One image with its settings. `url` follows the same rules as a plain string entry. */
export const templateImage = z.object({
  url: z.string().max(2000),
  /** Missing = render exactly as before the size controls. */
  size: templateImageSize.optional(),
  /** The img alt. Empty: the file name, else "Image" (only for images with a size). */
  alt: z.string().max(IMAGE_ALT_MAX).optional(),
  /** The image's own width in px, read in the browser. Missing = unknown. */
  naturalWidth: z.number().int().min(1).max(IMAGE_NATURAL_WIDTH_MAX).optional(),
  /** The original file name of an upload (stored names are random). Used for the alt fallback. */
  name: z.string().max(255).optional(),
});
export type TemplateImage = z.infer<typeof templateImage>;

/** One stored image: a plain URL (as before) or a URL with its settings. */
export const templateImageEntry = z.union([z.string().max(2000), templateImage]);
export type TemplateImageEntry = z.infer<typeof templateImageEntry>;

/** A stored entry read defensively (it is JSON from the database). Null = not an image. */
export function toTemplateImage(entry: unknown): TemplateImage | null {
  if (typeof entry === "string") return { url: entry };
  if (!entry || typeof entry !== "object") return null;
  const e = entry as Record<string, unknown>;
  if (typeof e.url !== "string") return null;
  const out: TemplateImage = { url: e.url };
  if (templateImageSize.safeParse(e.size).success) out.size = e.size as TemplateImageSize;
  if (typeof e.alt === "string") out.alt = e.alt;
  const w = validWidth(e.naturalWidth);
  if (w) out.naturalWidth = w;
  if (typeof e.name === "string") out.name = e.name;
  return out;
}

function validWidth(w: unknown): number | undefined {
  return typeof w === "number" && Number.isInteger(w) && w >= 1 && w <= IMAGE_NATURAL_WIDTH_MAX ? w : undefined;
}

export interface ImageBox {
  /** The HTML width attribute (what Outlook on desktop uses). Missing = none. */
  widthAttr?: number;
  /** Inline sizing CSS, each rule ending in ";". */
  css: string;
  /** The widest it shows, in px. Missing = the image's own width (unknown). */
  maxShown?: number;
  /** "original" asked for but the width is unknown: rendered as Best fit. */
  fellBack?: true;
}

/**
 * Width attribute + inline CSS for a size. Nothing is ever shown wider than the image's own width
 * (a small QR code or logo must not blur), and `max-width:100%` scales it down on phones.
 */
export function imageBox(size: TemplateImageSize, naturalWidth?: number): ImageBox {
  const w = validWidth(naturalWidth);
  if (size === "small") {
    const px = w ? Math.min(IMAGE_SMALL_PX, w) : IMAGE_SMALL_PX;
    return { widthAttr: px, css: `width:${px}px;max-width:100%;`, maxShown: px };
  }
  if (size === "original" && w) {
    return { widthAttr: w, css: `width:${w}px;max-width:100%;`, maxShown: w };
  }
  // Best fit (and Original with an unknown width).
  const fellBack = size === "original" ? ({ fellBack: true } as const) : {};
  if (w) {
    const px = Math.min(w, IMAGE_COLUMN_PX);
    return { widthAttr: px, css: `width:100%;max-width:${px}px;`, maxShown: px, ...fellBack };
  }
  // Unknown width: no stretch, so it can never be enlarged; wide images still scale down.
  return { css: "max-width:100%;", ...fellBack };
}

/** Upload names are generated (`<base36 time>-<uuid>.<ext>`) and mean nothing to a reader. */
const GENERATED_UPLOAD_NAME = /^[a-z0-9]+-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.[a-z0-9]+$/i;

/** The file name at the end of an image URL ("photo.jpg"), or null when there is no real one. */
export function imageFileName(url: string): string | null {
  const path = url.trim().split(/[?#]/)[0] ?? "";
  let last = path.slice(path.lastIndexOf("/") + 1);
  try {
    last = decodeURIComponent(last);
  } catch {
    /* keep it encoded */
  }
  last = last.trim();
  if (!last || !/\.[a-z0-9]{2,5}$/i.test(last) || GENERATED_UPLOAD_NAME.test(last)) return null;
  return last;
}

/** The alt text a sized image gets: its alt, else its file name, else "Image". At most 125 characters. */
export function imageAltText(img: Pick<TemplateImage, "url" | "alt" | "name">): string {
  const text = img.alt?.trim() || img.name?.trim() || imageFileName(img.url) || "Image";
  return text.slice(0, IMAGE_ALT_MAX);
}
