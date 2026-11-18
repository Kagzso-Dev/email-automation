// Hard stop (ENABLE_HARD_STOP, off by default; domain/hardStop.ts). Work already in progress (an email being sent, a
// WhatsApp message being sent, a call dialing / ringing / connected) always finishes; everything not started is
// cancelled. There is no hang-up and no end-call option here or anywhere.
//
//   GET  /api/hard-stop/config                      { enabled }: always answers (the web app's switch)
//   POST /api/hard-stop/email-batches/:id           ADMIN, EDITOR: one Send Queue email send
//   POST /api/hard-stop/whatsapp-batches/:id        ADMIN, EDITOR: one Send Queue WhatsApp send
//   POST /api/hard-stop/ai-call-runs/:id            ADMIN, EDITOR: one AI call run (any language)
//   POST /api/hard-stop/campaigns/:id               ADMIN (same as Pause)
//   POST /api/hard-stop/all                         ADMIN: "Stop all running sends"
//   GET  /api/hard-stop/campaigns/:id/stoppable     { stoppable }: anything running or scheduled for it
//   GET  /api/hard-stop/latest?scope=…&targetId=…   { stop }: the newest stop that covered that send (or null)
//   GET  /api/hard-stop/latest-all                  ADMIN: { stop }: the newest Stop all (or null)
//   GET  /api/hard-stop/:id                         the stop's status ("Stopping... (N in progress)" / "Stopped")
//   GET  /api/hard-stop/:id/cancelled.csv?channel=email|whatsapp|calls   the cancelled rows, for a later send
//
// POSTs are idempotent: while a stop for that send is open the same stop is returned ({ created: false }). A send
// that is not running any more: 409. Flag off: everything except GET /config answers 404.

import { Router, type RequestHandler } from "express";
import { rateLimit } from "express-rate-limit";
import { z } from "zod";
import { HARD_STOP_CSV_CHANNELS, idParam, type HardStopResult } from "@dispatch/shared";
import type { HardStopScope } from "@prisma/client";
import { isHardStopEnabled } from "../../config/hardStop.js";
import { logger } from "../../logger.js";
import { getHardStopView, HardStopError, hardStopCsv, isCampaignStoppable, latestStopAllId, latestStopIdFor, pressHardStop } from "../../domain/hardStop.js";
import { finalizeHardStop } from "../../queue/hardStopFinalizer.js";
import { authRequired, requireRole } from "../middleware/auth.js";
import { AppError, notFound, wrap } from "../errors.js";

export const hardStopRouter = Router();
hardStopRouter.use(authRequired);

const flagOn: RequestHandler = (_req, _res, next) => next(isHardStopEnabled() ? undefined : notFound("Hard stop"));

const pressLimiter = rateLimit({
  windowMs: 60_000,
  limit: 30,
  standardHeaders: true,
  keyGenerator: (req) => req.user?.id ?? req.ip ?? "anon",
  message: { error: "Too many requests — wait a minute and try again.", code: "rate_limited" },
});

hardStopRouter.get(
  "/config",
  wrap(async (_req, res) => {
    res.json({ enabled: isHardStopEnabled() });
  }),
);

hardStopRouter.use(flagOn);

/** The view, after finishing the stop if its last in-progress item has ended (the worker also does this every 15 s). */
async function viewOf(stopId: string) {
  try {
    await finalizeHardStop(stopId);
  } catch (err) {
    logger.warn({ err, stopId }, "hard stop finalize on read failed — the worker retries");
  }
  return getHardStopView(stopId);
}

function press(scope: HardStopScope, roles: ("ADMIN" | "EDITOR")[]) {
  return [
    requireRole(...roles),
    pressLimiter,
    wrap(async (req, res) => {
      const targetId = scope === "ALL" ? null : idParam.parse(req.params).id;
      try {
        const { stopId, created } = await pressHardStop(scope, targetId, { id: req.user!.id, email: req.user!.email });
        const stop = await viewOf(stopId);
        res.json({ stop, created } as HardStopResult);
      } catch (err) {
        if (err instanceof HardStopError) throw new AppError(err.status, err.message, err.status === 404 ? "not_found" : "conflict");
        throw err;
      }
    }),
  ];
}

hardStopRouter.post("/email-batches/:id", ...press("EMAIL_BATCH", ["ADMIN", "EDITOR"]));
hardStopRouter.post("/whatsapp-batches/:id", ...press("WHATSAPP_BATCH", ["ADMIN", "EDITOR"]));
hardStopRouter.post("/ai-call-runs/:id", ...press("AI_CALL_RUN", ["ADMIN", "EDITOR"]));
hardStopRouter.post("/campaigns/:id", ...press("CAMPAIGN", ["ADMIN"]));
hardStopRouter.post("/all", ...press("ALL", ["ADMIN"]));

hardStopRouter.get(
  "/campaigns/:id/stoppable",
  wrap(async (req, res) => {
    const { id } = idParam.parse(req.params);
    try {
      res.json({ stoppable: await isCampaignStoppable(id) });
    } catch (err) {
      if (err instanceof HardStopError) throw new AppError(err.status, err.message, "not_found");
      throw err;
    }
  }),
);

const latestQuery = z.object({
  scope: z.enum(["EMAIL_BATCH", "WHATSAPP_BATCH", "AI_CALL_RUN", "CAMPAIGN"]),
  targetId: z.string().min(1).max(191),
});

hardStopRouter.get(
  "/latest",
  wrap(async (req, res) => {
    const { scope, targetId } = latestQuery.parse(req.query);
    const id = await latestStopIdFor(scope, targetId);
    res.json({ stop: id ? await viewOf(id) : null });
  }),
);

hardStopRouter.get(
  "/latest-all",
  requireRole("ADMIN"),
  wrap(async (_req, res) => {
    const id = await latestStopAllId();
    res.json({ stop: id ? await viewOf(id) : null });
  }),
);

hardStopRouter.get(
  "/:id",
  wrap(async (req, res) => {
    const { id } = idParam.parse(req.params);
    const stop = await viewOf(id);
    if (!stop) throw notFound("Hard stop");
    res.json(stop);
  }),
);

const csvQuery = z.object({ channel: z.enum(HARD_STOP_CSV_CHANNELS) });

hardStopRouter.get(
  "/:id/cancelled.csv",
  wrap(async (req, res) => {
    const { id } = idParam.parse(req.params);
    const { channel } = csvQuery.parse(req.query);
    const file = await hardStopCsv(id, channel);
    if (!file) throw notFound("Hard stop");
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${file.filename}"`);
    res.setHeader("Cache-Control", "no-store");
    // BOM so Excel opens the file as UTF-8 (same as the Send Queue downloads).
    res.send("﻿" + file.body);
  }),
);
