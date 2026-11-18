// Image size controls (ENABLE_IMAGE_SIZE_CONTROLS, off by default): Small | Best fit | Original size and
// an alt text per template image. Read from GET /api/image-size-controls/config: loading, an error, or an
// API without the endpoint all count as OFF, so Templates → Images looks and saves exactly as before.
//
// Untouched images are saved as plain URL strings (as before); an image becomes { url, size, alt, … }
// only once someone picks a size or types an alt text. New images (flag on) start at Best fit.

import { useQuery } from "@tanstack/react-query";
import {
  IMAGE_ALT_MAX,
  IMAGE_COLUMN_PX,
  IMAGE_NATURAL_WIDTH_MAX,
  imageAltText,
  imageBox,
  toTemplateImage,
  type TemplateImage,
  type TemplateImageEntry,
} from "@dispatch/shared";
import { api } from "./api";

const CONFIG_KEY = ["image-size-controls-config"] as const;
const loadConfig = () =>
  api<{ enabled: boolean }>("/api/image-size-controls/config").catch(() => ({ enabled: false }));

/** The flag for rendering (OFF until it is known). */
export function useImageSizeControls(): boolean {
  const q = useQuery({ queryKey: CONFIG_KEY, queryFn: loadConfig, staleTime: 60_000, retry: false });
  return q.data?.enabled === true;
}

/** One image row in the editor. */
export type ImageEntry = TemplateImage;

/** Stored entries (plain URLs or objects) → editor rows. */
export function toImageEntries(stored: readonly unknown[]): ImageEntry[] {
  return stored.map(toTemplateImage).filter((img): img is ImageEntry => img !== null);
}

/** A new URL in a row: the old picture's width and file name no longer apply. Size and alt text stay. */
export function withUrl(img: ImageEntry, url: string): ImageEntry {
  if (img.url === url) return img;
  const { naturalWidth: _width, name: _name, ...rest } = img;
  return { ...rest, url };
}

/** Rows → what Save sends. Rows without a size or alt text stay plain URL strings, exactly as before. */
export function serializeImages(rows: readonly ImageEntry[]): TemplateImageEntry[] {
  return rows
    .map((r) => ({ ...r, url: r.url.trim() }))
    .filter((r) => r.url)
    .map((r) => {
      const alt = r.alt?.trim().slice(0, IMAGE_ALT_MAX);
      if (!r.size && !alt) return r.url;
      return {
        url: r.url,
        ...(r.size ? { size: r.size } : {}),
        ...(alt ? { alt } : {}),
        ...(r.naturalWidth ? { naturalWidth: r.naturalWidth } : {}),
        ...(r.name ? { name: r.name.slice(0, 255) } : {}),
      };
    });
}

/** A width worth storing (the API takes whole pixels up to 20,000), else undefined. */
export function usableWidth(w: unknown): number | undefined {
  return typeof w === "number" && Number.isInteger(w) && w >= 1 && w <= IMAGE_NATURAL_WIDTH_MAX ? w : undefined;
}

/**
 * The image's own width in px, read in the browser — from an uploaded File, or from a URL. Null when it
 * can't be read (broken link, a {{variable}} in the URL, not an image, or it takes too long); "Original
 * size" then falls back to Best fit.
 */
export function readNaturalWidth(src: string | Blob, timeoutMs = 8000): Promise<number | null> {
  return new Promise((resolve) => {
    if (typeof Image === "undefined") return resolve(null);
    let objectUrl: string | null = null;
    let url: string;
    if (typeof src === "string") {
      url = src.trim();
      if (!/^(https?:)?\/\//i.test(url) && !url.startsWith("/")) return resolve(null);
    } else {
      try {
        objectUrl = URL.createObjectURL(src);
      } catch {
        return resolve(null);
      }
      url = objectUrl;
    }
    const img = new Image();
    let done = false;
    const finish = (w: number | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      img.onload = null;
      img.onerror = null;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      resolve(w);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    img.onload = () => finish(usableWidth(img.naturalWidth) ?? null);
    img.onerror = () => finish(null);
    img.src = url;
  });
}

/** The live size shown in the toolbar — the same rules the email renderer uses. */
export function sizeLabel(img: ImageEntry): string {
  if (!img.size) return "Size: as before";
  const box = imageBox(img.size, img.naturalWidth);
  if (img.size === "small") return `Small · ${box.maxShown} px`;
  if (img.size === "original") {
    return box.fellBack ? "Original size · width unknown, sent as Best fit" : `Original size · ${box.maxShown} px`;
  }
  return box.maxShown ? `Best fit · ${box.maxShown} px` : "Best fit · width unknown";
}

/** A short note under the toolbar, or null. */
export function sizeHint(img: ImageEntry): string | null {
  if (img.size === "original" && img.naturalWidth && img.naturalWidth > IMAGE_COLUMN_PX) {
    return `Wider than most inboxes (${img.naturalWidth} px). Outlook on desktop shows it at full width — Best fit is safer.`;
  }
  return null;
}

/** What the email uses when the alt text box is left empty. */
export function altFallbackNote(img: ImageEntry): string {
  return img.size ? `Left empty: “${imageAltText({ ...img, alt: "" })}”` : "Left empty: no alt text, as before";
}
