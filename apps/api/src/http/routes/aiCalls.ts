// AI voice calls from the Contacts page. Everything except GET /config is
// ADMIN-only and returns 404 while ENABLE_AI_CALLS is off.
//
//   GET  /api/ai-calls/config           feature flag + limits (any signed-in user)
//   POST /api/ai-calls/parse            upload .xlsx/.csv → headers, rows, detected columns
//   POST /api/ai-calls/start            validate + plan (dryRun) or create a run
//   GET  /api/ai-calls/runs             recent runs
//   GET  /api/ai-calls/runs/:id         one run with per-call status (polled by the UI)
//   POST /api/ai-calls/runs/:id/cancel  stop dialling (an in-flight call finishes)

import { Router, type NextFunction, type Request, type Response } from "express";
import multer from "multer";
import { rateLimit } from "express-rate-limit";
import { idParam, maskPhone, startAiCallsInput } from "@dispatch/shared";
import { prisma } from "../../prisma.js";
import { logger } from "../../logger.js";
import { aiCallsConfig, isAiCallsConfigured } from "../../config/aiCalls.js";
import { aiCallFormatFromFilename, readAiCallSheet } from "../../domain/aiCallImport.js";
import { callsCountedTowardDailyCap, loadDoNotCallPhones, planAiCallRun } from "../../domain/aiCalls.js";
import { enqueueAiCallRun } from "../../queue/queues.js";
import { authRequired, requireRole } from "../middleware/auth.js";
import { AppError, badRequest, conflict, notFound, wrap } from "../errors.js";

export const aiCallsRouter = Router();
aiCallsRouter.use(authRequired);

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

const limiter = (limit: number, windowMs: number) =>
  rateLimit({
    windowMs,
    limit,
    standardHeaders: true,
    keyGenerator: (req) => req.user?.id ?? req.ip ?? "anon",
    message: { error: "Too many AI call requests — wait a minute and try again.", code: "rate_limited" },
  });
const startLimiter = limiter(10, 60_000);
const readLimiter = limiter(120, 60_000);

const DEFAULT_GAP_SEC = 30;

aiCallsRouter.get("/config", (req, res) => {
  res.json({
    enabled: aiCallsConfig.enabled,
    configured: aiCallsConfig.enabled && isAiCallsConfigured(),
    canStart: req.user?.role === "ADMIN",
    maxPerRun: aiCallsConfig.maxPerRun,
    minGapSec: aiCallsConfig.minGapSec,
    defaultGapSec: Math.max(DEFAULT_GAP_SEC, aiCallsConfig.minGapSec),
    defaultCountryCode: aiCallsConfig.defaultCountryCode,
  });
});

function featureGate(_req: Request, _res: Response, next: NextFunction) {
  if (!aiCallsConfig.enabled) return next(new AppError(404, "AI calls are disabled (set ENABLE_AI_CALLS=true)", "not_found"));
  next();
}
aiCallsRouter.use(featureGate, requireRole("ADMIN"));

aiCallsRouter.post(
  "/parse",
  readLimiter,
  upload.single("file"),
  wrap(async (req, res) => {
    if (!req.file) throw badRequest("File required (multipart field 'file')");
    const format = aiCallFormatFromFilename(req.file.originalname);
    if (!format) throw badRequest("Unsupported file type — upload a .xlsx or .csv file");
    let sheet;
    try {
      sheet = await readAiCallSheet(req.file.buffer, format);
    } catch (err) {
      throw badRequest(`Couldn't read the file: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (sheet.headers.length === 0) throw badRequest("The file has no header row");
    if (sheet.rows.length === 0) throw badRequest("The file has no data rows");
    res.json(sheet);
  }),
);

aiCallsRouter.post(
  "/start",
  startLimiter,
  wrap(async (req, res) => {
    const body = startAiCallsInput.parse(req.body);
    if (!isAiCallsConfigured()) {
      throw new AppError(503, "Voice backend is not configured — set VOICE_BACKEND_URL and VOICE_BACKEND_API_KEY", "unavailable");
    }
    if (body.gapSeconds < aiCallsConfig.minGapSec) {
      throw badRequest(`Gap between calls must be at least ${aiCallsConfig.minGapSec} seconds`);
    }

    const plan = planAiCallRun(body, {
      doNotCall: await loadDoNotCallPhones(aiCallsConfig.defaultCountryCode),
      hardCap: aiCallsConfig.maxPerRun,
      defaultCountryCode: aiCallsConfig.defaultCountryCode,
    });
    const summary = {
      toCall: plan.targets.length,
      skipped: plan.skipped,
      invalidRows: plan.invalidRows.slice(0, 200),
      hardCap: aiCallsConfig.maxPerRun,
    };
    if (plan.targets.length === 0) {
      throw badRequest("No callable customers — every row was invalid, a duplicate, or on the do-not-call list");
    }
    // Checked on the dry run too, so the confirm step never promises a run that can't start.
    const running = await prisma.aiCallRun.findFirst({ where: { status: "RUNNING" }, select: { id: true } });
    if (running) {
      throw conflict("Another AI call run is still in progress — wait for it to finish or cancel it first");
    }
    const used = await callsCountedTowardDailyCap();
    if (used + plan.targets.length > aiCallsConfig.dailyCap) {
      throw new AppError(
        429,
        `Daily AI call limit reached: ${used} of ${aiCallsConfig.dailyCap} used in the last 24 hours, ` +
          `this run needs ${plan.targets.length}`,
        "rate_limited",
      );
    }
    if (body.dryRun) return res.json({ dryRun: true, ...summary });

    const run = await prisma.aiCallRun.create({
      data: {
        mode: body.mode === "random" ? "RANDOM" : body.mode === "selected" ? "SELECTED" : "ALL",
        gapSeconds: body.gapSeconds,
        maxCalls: Math.min(body.maxCalls, aiCallsConfig.maxPerRun),
        total: plan.targets.length,
        createdById: req.user!.id,
        createdByEmail: req.user!.email,
        skipped: plan.skipped,
        logs: {
          create: plan.targets.map((t, i) => ({
            position: i,
            customerName: t.customerName,
            gender: t.gender,
            followUpDetail: t.followUpDetail,
            phone: t.phone,
          })),
        },
      },
    });
    await enqueueAiCallRun({ runId: run.id });
    logger.info(
      {
        runId: run.id,
        by: req.user!.email,
        mode: body.mode,
        calls: plan.targets.length,
        phones: plan.targets.map((t) => maskPhone(t.phone)),
        skipped: plan.skipped,
      },
      "ai call run started",
    );
    res.status(201).json({ runId: run.id, ...summary });
  }),
);

aiCallsRouter.get(
  "/runs",
  readLimiter,
  wrap(async (_req, res) => {
    const items = await prisma.aiCallRun.findMany({ orderBy: { createdAt: "desc" }, take: 10 });
    res.json({ items });
  }),
);

aiCallsRouter.get(
  "/runs/:id",
  readLimiter,
  wrap(async (req, res) => {
    const { id } = idParam.parse(req.params);
    const run = await prisma.aiCallRun.findUnique({
      where: { id },
      include: { logs: { orderBy: { position: "asc" } } },
    });
    if (!run) throw notFound("AI call run");
    res.json(run);
  }),
);

aiCallsRouter.post(
  "/runs/:id/cancel",
  wrap(async (req, res) => {
    const { id } = idParam.parse(req.params);
    const run = await prisma.aiCallRun.findUnique({ where: { id }, select: { status: true } });
    if (!run) throw notFound("AI call run");
    if (run.status !== "RUNNING") throw conflict(`Run is already ${run.status.toLowerCase()}`);
    await prisma.$transaction([
      prisma.aiCallRun.update({ where: { id }, data: { status: "CANCELLED", nextCallAt: null } }),
      prisma.aiCallLog.updateMany({ where: { runId: id, status: "QUEUED" }, data: { status: "CANCELLED" } }),
    ]);
    logger.info({ runId: id, by: req.user!.email }, "ai call run cancelled");
    res.json({ ok: true });
  }),
);
