// Import filter step (ENABLE_IMPORT_FILTER_STEP, off by default). Before "Import file" imports anything on
// WhatsApp Contacts or Voicecall Contact, the rows are checked with Data Quality's own rules and shown in
// its filter view. These endpoints only READ: no row is saved (no staging job, no contact, no queue job), nothing
// is called or sent. The AI score is Data Quality's own (only names and business names go to the AI service, in
// batches) and is not saved either. The chosen rows go to each page's existing importer afterwards
// (POST /api/whatsapp/contacts/import, POST /api/ai-call-customers/import…), unchanged.
//
//   GET  /api/import-filter/config               { enabled, maxRows }: always answers (the web app's switch)
//   POST /api/import-filter/whatsapp/preview     upload .csv/.xlsx → the rows + their checks (nothing saved)
//   POST /api/import-filter/voicecall/check      mapped rows (JSON) → their checks (nothing saved)
//   GET  /api/import-filter/ai                   is the Data Quality AI service usable; how to pace the batches
//   POST /api/import-filter/ai-score             { rows: [{ name, business, ruleScore }] } (≤ 5) → AI scores (nothing saved)
//
// Both checks also answer `extraColumns`: which of the file's columns hold the city, state, category, source,
// date… (Data Quality's own header detection), so the step can show the same dropdowns as the Data Quality page.
//
// Flag off: everything except GET /config answers 404. Signed-in ADMIN and EDITOR (both can import today).

import { Router, type RequestHandler } from "express";
import { rateLimit } from "express-rate-limit";
import { z } from "zod";
import { aiCallsConfig } from "../../config/aiCalls.js";
import { isImportFilterStepEnabled } from "../../config/importFilterStep.js";
import { whatsappConfig } from "../../config/whatsapp.js";
import { aiCallFormatFromFilename, readAiCallSheetUpload } from "../../domain/aiCallImport.js";
import { aiCallLanguage } from "@dispatch/shared";
import { detectExtraColumns } from "../../domain/dataQualityExport.js";
import { AI_BATCH_SIZE, draftAiInfo, scoreDraftBatch } from "../../domain/importFilterAi.js";
import { checkVoicecallDraft, checkWhatsAppDraft } from "../../domain/importFilterCheck.js";
import { IMPORT_MAX_ROWS } from "../../domain/importLimit.js";
import { importUpload, removeUpload, unreadableFile } from "../importUpload.js";
import { authRequired, requireRole } from "../middleware/auth.js";
import { AppError, badRequest, notFound, wrap } from "../errors.js";

export const importFilterRouter = Router();
importFilterRouter.use(authRequired);

const limiter = (limit: number) =>
  rateLimit({
    windowMs: 60_000,
    limit,
    standardHeaders: true,
    keyGenerator: (req) => req.user?.id ?? req.ip ?? "anon",
    message: { error: "Too many requests — wait a minute and try again.", code: "rate_limited" },
  });
const checkLimiter = limiter(60);

const flagOn: RequestHandler = (_req, _res, next) => next(isImportFilterStepEnabled() ? undefined : notFound("Import filter step"));
const aiCallsOn: RequestHandler = (_req, _res, next) =>
  next(aiCallsConfig.enabled ? undefined : new AppError(404, "AI calls are disabled (set ENABLE_AI_CALLS=true)", "not_found"));

importFilterRouter.get(
  "/config",
  wrap(async (_req, res) => {
    res.json({ enabled: isImportFilterStepEnabled(), maxRows: IMPORT_MAX_ROWS });
  }),
);

importFilterRouter.post(
  "/whatsapp/preview",
  flagOn,
  requireRole("ADMIN", "EDITOR"),
  checkLimiter,
  importUpload(),
  wrap(async (req, res) => {
    if (!req.file) throw badRequest("File required (multipart field 'file')");
    const file = req.file;
    let sheet;
    try {
      const format = aiCallFormatFromFilename(file.originalname);
      if (!format) throw badRequest("Unsupported file type — upload a .csv or .xlsx file");
      // The same first IMPORT_MAX_ROWS rows the WhatsApp importer takes; the rest are only counted.
      sheet = await readAiCallSheetUpload(file.path, file.size, format, IMPORT_MAX_ROWS).catch(unreadableFile);
    } finally {
      await removeUpload(file); // the temp file goes at once, as in the importers
    }
    if (sheet.headers.length === 0) throw badRequest("The file has no header row");
    if (sheet.rows.length === 0) throw badRequest("The file has no data rows");
    const checks = await checkWhatsAppDraft(sheet.headers, sheet.rows, whatsappConfig.defaultCountryCode, aiCallsConfig.defaultCountryCode);
    res.json({
      filename: file.originalname,
      headers: sheet.headers,
      rows: sheet.rows,
      totalRows: sheet.totalRows,
      maxRows: sheet.maxRows,
      truncated: sheet.truncated,
      checks,
      extraColumns: detectExtraColumns(sheet.headers),
    });
  }),
);

// Long cells are cut (the checks read at most 200 characters), never refused: one long business name must not
// stop the whole file from being checked.
const text = (max: number) =>
  z
    .string()
    .max(5000)
    .transform((v) => v.slice(0, max))
    .nullable()
    .optional();
const voicecallCheckInput = z
  .object({
    rows: z
      .array(z.object({ name: text(200), phone: text(60), business: text(300), email: text(300) }).strict())
      .min(1, "No rows to check")
      .max(IMPORT_MAX_ROWS),
    // This page's list: "already in contacts" means already in THIS list (the importer's own duplicate rule).
    language: aiCallLanguage.default("en"),
    // The file's column names: only to find the city / category / source / date columns (optional).
    headers: z.array(z.string().max(300)).max(500).optional(),
  })
  .strict();

importFilterRouter.post(
  "/voicecall/check",
  flagOn,
  aiCallsOn,
  requireRole("ADMIN", "EDITOR"),
  checkLimiter,
  wrap(async (req, res) => {
    const { rows, language, headers } = voicecallCheckInput.parse(req.body);
    res.json({
      checks: await checkVoicecallDraft(rows, language, aiCallsConfig.defaultCountryCode, whatsappConfig.defaultCountryCode),
      extraColumns: detectExtraColumns(headers ?? []),
    });
  }),
);

/* ------------------------------------------------------------------ AI score (Data Quality's, nothing saved) */

// One file is up to 1,000 rows sent a few at a time, one request after the other: a roomier limit than the checks.
const aiLimiter = limiter(300);

importFilterRouter.get(
  "/ai",
  flagOn,
  requireRole("ADMIN", "EDITOR"),
  wrap(async (_req, res) => {
    res.json(await draftAiInfo());
  }),
);

const aiScoreInput = z
  .object({
    rows: z
      .array(z.object({ name: text(200), business: text(300), ruleScore: z.number().int().min(0).max(100).nullable() }).strict())
      .min(1, "No rows to score")
      .max(AI_BATCH_SIZE),
  })
  .strict();

importFilterRouter.post(
  "/ai-score",
  flagOn,
  requireRole("ADMIN", "EDITOR"),
  aiLimiter,
  wrap(async (req, res) => {
    const { rows } = aiScoreInput.parse(req.body);
    res.json(await scoreDraftBatch(rows.map((r) => ({ name: r.name ?? null, business: r.business ?? null, ruleScore: r.ruleScore }))));
  }),
);
