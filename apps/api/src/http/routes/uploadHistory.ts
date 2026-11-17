// Upload History (ENABLE_IMPORT_FILTER_STEP, migration 0037). Signed-in ADMIN and EDITOR (the importers' roles);
// everyone sees every upload (a team log). Only the upload_history table is read or written.
//
//   GET  /api/upload-history                  newest first, ?page=&pageSize=&search=<file name>
//   GET  /api/upload-history/:id              one upload: counts, filters, exclusion options
//   GET  /api/upload-history/:id/excluded     the excluded rows (CSV) for 30 days, then 410
//   POST /api/upload-history                  written by the import filter step right after the page's importer
//                                             answered "Import N selected" (multipart: summary JSON + excluded CSV)
//
// Flag off: every endpoint answers 404. Migration 0037 not applied: 503 saying what to run. Neither ever affects an
// import: the importers don't call these, and the step treats a failed history write as a warning only.

import { Router, type RequestHandler } from "express";
import multer from "multer";
import { rateLimit } from "express-rate-limit";
import { z } from "zod";
import { aiCallLanguage, idParam } from "@dispatch/shared";
import { isImportFilterStepEnabled } from "../../config/importFilterStep.js";
import {
  createUploadHistory,
  getExcludedCsv,
  getUploadHistory,
  isMissingTable,
  listUploadHistory,
  purgeExpiredExcluded,
  startUploadHistorySweep,
} from "../../domain/uploadHistory.js";
import { logger } from "../../logger.js";
import { authRequired, requireRole } from "../middleware/auth.js";
import { AppError, badRequest, notFound, wrap } from "../errors.js";

export const uploadHistoryRouter = Router();

// The hourly 30-day sweep runs in the API process (not in the worker's scheduler). Tests drive the purge themselves.
if (process.env.NODE_ENV !== "test") startUploadHistorySweep();

const flagOn: RequestHandler = (_req, _res, next) => next(isImportFilterStepEnabled() ? undefined : notFound("Upload history"));
uploadHistoryRouter.use(authRequired, flagOn, requireRole("ADMIN", "EDITOR"));

const limiter = (limit: number) =>
  rateLimit({
    windowMs: 60_000,
    limit,
    standardHeaders: true,
    keyGenerator: (req) => req.user?.id ?? req.ip ?? "anon",
    message: { error: "Too many requests — wait a minute and try again.", code: "rate_limited" },
  });
const readLimiter = limiter(240);
const writeLimiter = limiter(60);

const NEEDS_MIGRATION = "Upload history needs a database update — run `npm run prisma:deploy` (migration 0037), then reload.";

/** wrap(), plus: a missing table → 503 saying what to run, never a bare 500. */
const handle = (fn: Parameters<typeof wrap>[0]) =>
  wrap(async (req, res, next) => {
    try {
      await fn(req, res, next);
    } catch (err) {
      throw isMissingTable(err) ? new AppError(503, NEEDS_MIGRATION, "needs_migration") : err;
    }
  });

const listQuery = z.object({
  page: z.coerce.number().int().min(1).max(100_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
  search: z.string().trim().max(255).optional(),
});

uploadHistoryRouter.get(
  "/",
  readLimiter,
  handle(async (req, res) => {
    const q = listQuery.parse(req.query);
    await purgeExpiredExcluded();
    res.json(await listUploadHistory({ ...q, search: q.search || undefined }));
  }),
);

uploadHistoryRouter.get(
  "/:id",
  readLimiter,
  handle(async (req, res) => {
    const { id } = idParam.parse(req.params);
    await purgeExpiredExcluded();
    const row = await getUploadHistory(id);
    if (!row) throw notFound("Upload");
    res.json(row);
  }),
);

/** ASCII only for the download name ("contacts.xlsx" → "contacts-excluded.csv"). */
const downloadName = (fileName: string) => `${fileName.replace(/\.[^.]+$/, "").replace(/[^\w.\- ]+/g, "_") || "upload"}-excluded.csv`;

uploadHistoryRouter.get(
  "/:id/excluded",
  readLimiter,
  handle(async (req, res) => {
    const { id } = idParam.parse(req.params);
    await purgeExpiredExcluded();
    const r = await getExcludedCsv(id);
    if (r.status === "missing") throw notFound("Upload");
    if (r.status === "none") throw notFound("Excluded rows (none were excluded)");
    if (r.status === "gone") throw new AppError(410, "The excluded rows were deleted after 30 days.", "gone");
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${downloadName(r.fileName)}"`);
    res.setHeader("Cache-Control", "no-store");
    res.send(`﻿${r.csv}`); // BOM so Excel opens Tamil text as UTF-8
  }),
);

const MAX_CSV_BYTES = 5 * 1024 * 1024; // one import is at most 1,000 rows
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_CSV_BYTES, files: 1 } });
const excludedFile: RequestHandler = (req, res, next) =>
  upload.single("excluded")(req, res, (err: unknown) => {
    if (err instanceof multer.MulterError) return next(badRequest(err.code === "LIMIT_FILE_SIZE" ? "Excluded rows file is too large" : err.message));
    next(err as Error | undefined);
  });

const count = z.number().int().min(0).max(1_000_000);
const jsonUnder = (max: number) => (v: unknown) => JSON.stringify(v ?? null).length <= max;
const summaryInput = z
  .object({
    fileName: z.string().trim().min(1).max(255),
    channel: z.enum(["whatsapp", "voicecall"]),
    language: aiCallLanguage.nullable().default(null),
    totalRows: count,
    imported: count,
    excludedUsed: count,
    filteredOut: count,
    duplicates: count,
    failed: count,
    skippedOverLimit: count.default(0),
    excludedRows: count,
    filters: z.record(z.unknown()).refine(jsonUnder(20_000), "filters too large"),
    result: z.unknown().refine(jsonUnder(200_000), "result too large"),
  })
  .strict();

uploadHistoryRouter.post(
  "/",
  writeLimiter,
  excludedFile,
  handle(async (req, res) => {
    let raw: unknown;
    try {
      raw = JSON.parse(String(req.body?.summary ?? ""));
    } catch {
      throw badRequest("summary must be JSON");
    }
    const s = summaryInput.parse(raw);
    const csv = req.file ? req.file.buffer.toString("utf8").replace(/^﻿/, "") : null;
    await purgeExpiredExcluded();
    const row = await createUploadHistory({
      ...s,
      result: s.result ?? {},
      // Who and when come from the session and the server clock, never from the request.
      uploadedById: req.user!.id,
      uploadedByEmail: req.user!.email,
      excludedCsv: csv,
    });
    logger.info(
      { id: row.id, by: req.user!.email, channel: s.channel, total: s.totalRows, imported: s.imported, excluded: s.excludedUsed },
      "upload history written",
    );
    res.status(201).json(row);
  }),
);
