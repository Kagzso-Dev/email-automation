// Header media for registered WhatsApp templates (Meta media header formats
// IMAGE / VIDEO / DOCUMENT). The file is stored privately once and uploaded to
// Meta on send (the media id is reused until it nears its 30-day expiry). A
// template without header media sends exactly as before (body parameters only).

import { Prisma, type WhatsAppMedia } from "@prisma/client";
import { prisma } from "../prisma.js";
import { logger } from "../logger.js";
import { headerMediaComponent, type TemplateComponent } from "../services/whatsapp.js";
import { ensureProviderMediaId, HEADER_KINDS, MediaError, saveOutgoingMedia, type HeaderKind } from "./whatsappMedia.js";

/**
 * Before migration 0020 is applied the header table doesn't exist. Treat that as
 * "no header media" so template listing and every send work exactly as before.
 */
function isMissingTable(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2021";
}
let warnedMissing = false;
function noHeaderTable(err: unknown): null {
  if (!isMissingTable(err)) throw err;
  if (!warnedMissing) {
    warnedMissing = true;
    logger.warn("whatsapp media tables missing — run `npm run prisma:deploy` (migration 0020_whatsapp_media); sending without header media");
  }
  return null;
}

/** Meta header format (from template verification) → the media kind it takes. */
export function headerKindForFormat(format: string | null | undefined): HeaderKind | null {
  switch ((format ?? "").toUpperCase()) {
    case "IMAGE":
      return "image";
    case "VIDEO":
      return "video";
    case "DOCUMENT":
      return "document";
    default:
      return null; // TEXT (header variable), LOCATION, GIF: not supported by Dispatch
  }
}

export async function getHeaderMediaMap(templateIds: string[]): Promise<Map<string, WhatsAppMedia>> {
  if (templateIds.length === 0) return new Map();
  const rows = await prisma.whatsAppTemplateHeaderMedia
    .findMany({ where: { templateId: { in: templateIds } }, include: { media: true } })
    .catch(noHeaderTable);
  return new Map((rows ?? []).map((r) => [r.templateId, r.media]));
}

/** Set (or replace) a template's header media. The previous file is kept for send history. */
export async function setTemplateHeaderMedia(
  templateId: string,
  file: { data: Buffer; declaredMime?: string | null; filename?: string | null },
  actorEmail: string | null,
): Promise<WhatsAppMedia> {
  const template = await prisma.whatsAppTemplate.findUnique({ where: { id: templateId }, select: { id: true } });
  if (!template) throw new MediaError("WhatsApp template not found", 404);
  const media = await saveOutgoingMedia(file.data, file, "TEMPLATE_HEADER", HEADER_KINDS, actorEmail);
  await prisma.whatsAppTemplateHeaderMedia.upsert({
    where: { templateId },
    create: { templateId, mediaId: media.id, updatedByEmail: actorEmail },
    update: { mediaId: media.id, updatedByEmail: actorEmail },
  });
  logger.info({ templateId, mediaId: media.id, kind: media.kind, bytes: media.sizeBytes, by: actorEmail }, "whatsapp template header media set");
  return media;
}

export async function removeTemplateHeaderMedia(templateId: string, actorEmail: string | null): Promise<boolean> {
  const { count } = await prisma.whatsAppTemplateHeaderMedia.deleteMany({ where: { templateId } });
  if (count) logger.info({ templateId, by: actorEmail }, "whatsapp template header media removed");
  return count > 0;
}

/**
 * The header component for a template send, or null when the template has no
 * header media. Uploads the file to Meta if needed.
 */
export async function headerComponentForTemplate(
  templateId: string,
): Promise<{ component: TemplateComponent; mediaId: string } | null> {
  const link = await prisma.whatsAppTemplateHeaderMedia
    .findUnique({ where: { templateId }, include: { media: true } })
    .catch(noHeaderTable);
  if (!link) return null;
  const kind = link.media.kind as HeaderKind;
  if (!(HEADER_KINDS as readonly string[]).includes(kind)) throw new MediaError(`Header media must be an image, video or document (got ${kind})`);
  const providerId = await ensureProviderMediaId(link.media);
  return { component: headerMediaComponent(kind, providerId, link.media.filename), mediaId: link.media.id };
}
