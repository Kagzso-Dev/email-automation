// WhatsApp media routes, mounted next to /api/whatsapp (all signed-in).
//
//   PUT    /api/whatsapp/templates/:id/header-media   set a template's header image / video / document (multipart "file")
//   DELETE /api/whatsapp/templates/:id/header-media   remove it (the template then sends without header media)
//   GET    /api/whatsapp/media/:id/file               download / preview a stored file
//                                                     (customer media + reply attachments: ADMIN only)
//   GET    /api/whatsapp/inbox                        conversations (?search, ?page, ?pageSize) with unread counts (ADMIN)
//   GET    /api/whatsapp/inbox/unread-count           unread customer messages, for the sidebar badge (ADMIN)
//   GET    /api/whatsapp/inbox/:phone                 one conversation with media (?before=ISO&limit= for older) (ADMIN)
//   POST   /api/whatsapp/inbox/:phone/read            mark the conversation read (ADMIN)
//   POST   /api/whatsapp/inbox/:phone/reply           free-form reply: text and/or one attachment (ADMIN)
//
// Files are private: never served statically, never with a filesystem path.

import { Router, type NextFunction, type Request, type Response } from "express";
import multer from "multer";
import { rateLimit } from "express-rate-limit";
import { idParam } from "@dispatch/shared";
import { prisma } from "../../prisma.js";
import { MEDIA_MAX_BYTES, MediaError, mediaPath, mediaView } from "../../domain/whatsappMedia.js";
import { removeTemplateHeaderMedia, setTemplateHeaderMedia } from "../../domain/whatsappTemplateHeader.js";
import {
  getConversation,
  listConversations,
  markConversationRead,
  ReplyError,
  sendReply,
  unreadTotals,
} from "../../domain/whatsappInbox.js";
import { z } from "zod";
import { authRequired, requireRole } from "../middleware/auth.js";
import { AppError, badRequest, forbidden, notFound, wrap } from "../errors.js";

export const whatsappMediaRouter = Router();
whatsappMediaRouter.use(authRequired);

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MEDIA_MAX_BYTES, files: 1, fields: 5 } });

/** One optional multipart "file"; a too-large / malformed upload is a 400, not a crash. */
const acceptFile = (req: Request, res: Response, next: NextFunction) =>
  upload.single("file")(req, res, (err: unknown) => {
    if (!err) return next();
    const code = (err as { code?: string }).code;
    next(
      badRequest(
        code === "LIMIT_FILE_SIZE"
          ? `File is too large — WhatsApp allows at most ${Math.round(MEDIA_MAX_BYTES / (1024 * 1024))} MB (documents), 16 MB (video / audio), 5 MB (images)`
          : "Could not read the uploaded file",
      ),
    );
  });

const limiter = rateLimit({
  windowMs: 60_000,
  limit: 60,
  standardHeaders: true,
  keyGenerator: (req) => req.user?.id ?? req.ip ?? "anon",
  message: { error: "Too many requests — wait a minute and try again.", code: "rate_limited" },
});

function toHttp(err: unknown): never {
  if (err instanceof MediaError || err instanceof ReplyError) {
    throw new AppError(err.status, err.message, err.status === 404 ? "not_found" : err.status === 409 ? "conflict" : "bad_request");
  }
  throw err;
}

const phoneParam = (raw: string) => {
  const phone = String(raw ?? "").replace(/[^\d]/g, "");
  if (phone.length < 8 || phone.length > 15) throw badRequest("Invalid phone number");
  return phone;
};

/* ---------------------------------------------------------------- template header media */

whatsappMediaRouter.put(
  "/templates/:id/header-media",
  requireRole("ADMIN"), // editors: view only
  limiter,
  acceptFile,
  wrap(async (req, res) => {
    const { id } = idParam.parse(req.params);
    if (!req.file) throw badRequest("File required (multipart field 'file')");
    const media = await setTemplateHeaderMedia(
      id,
      { data: req.file.buffer, declaredMime: req.file.mimetype, filename: req.file.originalname },
      req.user!.email,
    ).catch(toHttp);
    res.json({ headerMedia: mediaView(media) });
  }),
);

whatsappMediaRouter.delete(
  "/templates/:id/header-media",
  requireRole("ADMIN"), // editors: view only
  wrap(async (req, res) => {
    const { id } = idParam.parse(req.params);
    await removeTemplateHeaderMedia(id, req.user!.email);
    res.status(204).end();
  }),
);

/* ---------------------------------------------------------------- file download / preview */

const INLINE = /^(image\/(jpeg|png|webp)|video\/(mp4|3gpp)|audio\/(aac|amr|mpeg|mp4|ogg)|application\/pdf)$/;

whatsappMediaRouter.get(
  "/media/:id/file",
  wrap(async (req, res) => {
    const { id } = idParam.parse(req.params);
    const media = await prisma.whatsAppMedia.findUnique({ where: { id } });
    if (!media || media.status !== "STORED" || !media.storageKey) throw notFound("Media");
    // Customer files and reply attachments are private to admins; template headers are shared content.
    if (media.purpose !== "TEMPLATE_HEADER" && req.user?.role !== "ADMIN") throw forbidden("Requires role: ADMIN");

    const mime = media.mimeType ?? "application/octet-stream";
    const inline = INLINE.test(mime) && req.query.download !== "1";
    const name = (media.filename ?? `${media.kind}`).replace(/["\\\r\n]/g, "");
    res.setHeader("Content-Type", mime === "text/plain" ? "text/plain; charset=utf-8" : mime);
    res.setHeader("Content-Disposition", `${inline ? "inline" : "attachment"}; filename="${name.replace(/[^\x20-\x7e]/g, "_")}"; filename*=UTF-8''${encodeURIComponent(name)}`);
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Content-Security-Policy", "default-src 'none'; img-src 'self'; media-src 'self'; sandbox");
    res.setHeader("Cache-Control", "private, max-age=300");
    res.sendFile(mediaPath(media.storageKey), (err) => {
      if (err && !res.headersSent) res.status(404).json({ error: "Media file not found", code: "not_found" });
    });
  }),
);

/* ---------------------------------------------------------------- inbox (admins) */

const listQuery = z.object({
  search: z.string().trim().max(100).optional(),
  page: z.coerce.number().int().min(1).optional(),
  pageSize: z.coerce.number().int().min(1).max(200).optional(),
});
const threadQuery = z.object({
  before: z.coerce.date().optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

whatsappMediaRouter.get(
  "/inbox",
  requireRole("ADMIN"),
  wrap(async (req, res) => {
    res.json(await listConversations(listQuery.parse(req.query)));
  }),
);

// Registered before "/inbox/:phone" so "unread-count" isn't read as a phone number.
whatsappMediaRouter.get(
  "/inbox/unread-count",
  requireRole("ADMIN"),
  wrap(async (_req, res) => {
    res.json(await unreadTotals());
  }),
);

whatsappMediaRouter.get(
  "/inbox/:phone",
  requireRole("ADMIN"),
  wrap(async (req, res) => {
    const q = threadQuery.parse(req.query);
    res.json(await getConversation(phoneParam(req.params.phone!), { before: q.before ?? null, limit: q.limit }));
  }),
);

whatsappMediaRouter.post(
  "/inbox/:phone/read",
  requireRole("ADMIN"),
  wrap(async (req, res) => {
    await markConversationRead(phoneParam(req.params.phone!), req.user!.email);
    res.json({ ok: true });
  }),
);

whatsappMediaRouter.post(
  "/inbox/:phone/reply",
  requireRole("ADMIN"),
  limiter,
  acceptFile,
  wrap(async (req, res) => {
    const phone = phoneParam(req.params.phone!);
    const text = typeof req.body?.text === "string" ? req.body.text : "";
    const message = await sendReply(
      phone,
      {
        text,
        file: req.file ? { data: req.file.buffer, declaredMime: req.file.mimetype, filename: req.file.originalname } : null,
      },
      req.user!.email,
    ).catch(toHttp);
    res.status(message.status === "FAILED" ? 502 : 201).json(message);
  }),
);
