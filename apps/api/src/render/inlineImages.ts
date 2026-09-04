import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import { randomUUID } from "node:crypto";
import { localUploadPath } from "../domain/imageUpload.js";
import { logger } from "../logger.js";
import type { EmailAttachment } from "./render.js";

const CONTENT_TYPE: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".gif": "image/gif",
};

/**
 * Rewrite `<img>` tags that point at a locally-stored upload
 * (`${PUBLIC_API_URL}/uploads/...`) to inline `cid:` references, and return the
 * bytes as attachments so they ride along with the message.
 *
 * Without this, an uploaded image only loads if the API host is publicly
 * reachable over HTTPS — in dev (`PUBLIC_API_URL=http://localhost:4000`) every
 * external mail client shows a broken image. Externally-hosted image URLs are
 * left exactly as they are.
 */
export async function inlineLocalImages(
  html: string,
  attachments: EmailAttachment[] | undefined,
): Promise<{ html: string; attachments: EmailAttachment[] | undefined }> {
  const srcs = new Set<string>();
  for (const m of html.matchAll(/<img\b[^>]*?\bsrc="([^"]+)"/gi)) srcs.add(m[1]);

  const resolved = await Promise.all(
    [...srcs].map(async (src) => {
      const path = localUploadPath(src);
      if (!path) return null;
      try {
        const buf = await readFile(path);
        const ext = extname(path).toLowerCase();
        const cid = `img-${randomUUID()}@dispatch`;
        const attachment: EmailAttachment = {
          filename: `image${ext || ".img"}`,
          content: buf.toString("base64"),
          contentType: CONTENT_TYPE[ext] ?? "application/octet-stream",
          encoding: "base64",
          cid,
        };
        return { src, cid, attachment };
      } catch (err) {
        // File missing / unreadable — leave the original src untouched. The
        // email still sends; the image just won't render, same as before.
        logger.warn({ src, path, err: (err as Error).message }, "inline image: could not read upload");
        return null;
      }
    }),
  );

  const hits = resolved.filter((r): r is NonNullable<typeof r> => r !== null);
  if (hits.length === 0) return { html, attachments };

  let out = html;
  for (const { src, cid } of hits) out = out.split(`src="${src}"`).join(`src="cid:${cid}"`);

  return { html: out, attachments: [...(attachments ?? []), ...hits.map((h) => h.attachment)] };
}
