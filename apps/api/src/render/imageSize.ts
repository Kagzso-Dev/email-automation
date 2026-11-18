import { imageAltText, imageBox, type TemplateImage } from "@dispatch/shared";
import { escapeHtml, renderImageHtml, safeImgSrc } from "./meeting.js";

/**
 * One template image with the image size controls on (ENABLE_IMAGE_SIZE_CONTROLS). `img.url` and
 * `img.alt` are already variable-substituted. Returns "" when the URL's scheme isn't allowed.
 *
 * - No size (every image saved before the feature): exactly the markup as before — only an alt text
 *   the user typed is filled in.
 * - Small / Best fit / Original size: the width attribute (Outlook on desktop ignores CSS max-width)
 *   plus inline CSS (display:block;border:0;height:auto; and max-width:100% for phones). Never wider
 *   than the image's own width — see imageBox in @dispatch/shared.
 */
export function renderSizedImageHtml(img: TemplateImage): string {
  if (!img.size) {
    const alt = img.alt?.trim();
    if (!alt) return renderImageHtml(img.url);
    const src = safeImgSrc(img.url);
    if (!src) return "";
    return `<div style="margin:16px 0"><img src="${src}" alt="${escapeHtml(alt)}" style="max-width:100%;height:auto;border:0;border-radius:8px" /></div>`;
  }
  const src = safeImgSrc(img.url);
  if (!src) return "";
  const box = imageBox(img.size, img.naturalWidth);
  const width = box.widthAttr ? ` width="${box.widthAttr}"` : "";
  return `<div style="margin:16px 0"><img src="${src}"${width} alt="${escapeHtml(
    imageAltText(img),
  )}" style="display:block;border:0;height:auto;${box.css}border-radius:8px" /></div>`;
}
