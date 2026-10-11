// Send Queue → "Download all history" (read-only).
//
//   GET /api/send-queue/history/:channel/count   → { rows }   (0 = nothing to export; disables the button)
//   GET /api/send-queue/history/:channel/export  → streamed CSV, send-history-{channel}-{YYYY-MM-DD}.csv
//
// :channel is email | whatsapp | ai-followups — one tab, one channel, never mixed.
// Always the full history: no status filter, no pagination. ai-followups is
// admin-only and 404s while ENABLE_AI_CALLS is off, like the follow-ups tab.

import { Router, type Request } from "express";
import { rateLimit } from "express-rate-limit";
import { z } from "zod";
import { authRequired } from "../middleware/auth.js";
import { AppError, forbidden, wrap } from "../errors.js";
import { aiCallsConfig } from "../../config/aiCalls.js";
import { logger } from "../../logger.js";
import { exportHistoryCsv, exportRowCount, type ExportChannel } from "../../domain/sendQueueExport.js";

export const sendQueueHistoryRouter = Router();
sendQueueHistoryRouter.use(authRequired);

const exportLimiter = rateLimit({
  windowMs: 60_000,
  limit: 10,
  standardHeaders: true,
  keyGenerator: (req) => req.user?.id ?? req.ip ?? "anon",
  message: { error: "Too many history downloads — wait a minute and try again.", code: "rate_limited" },
});

const channelParam = z.object({ channel: z.enum(["email", "whatsapp", "ai-followups"]) });

function gate(req: Request): ExportChannel {
  const parsed = channelParam.safeParse(req.params);
  if (!parsed.success) throw new AppError(404, "Unknown channel", "not_found");
  const channel = parsed.data.channel;
  if (channel === "ai-followups") {
    if (!aiCallsConfig.enabled) throw new AppError(404, "AI calls are disabled (set ENABLE_AI_CALLS=true)", "not_found");
    if (req.user?.role !== "ADMIN") throw forbidden("Requires role: ADMIN");
  }
  return channel;
}

sendQueueHistoryRouter.get(
  "/:channel/count",
  wrap(async (req, res) => {
    res.json({ rows: await exportRowCount(gate(req)) });
  }),
);

sendQueueHistoryRouter.get(
  "/:channel/export",
  exportLimiter,
  wrap(async (req, res) => {
    const channel = gate(req);
    const rows = exportHistoryCsv(channel);
    // Pull the header chunk before any response header goes out, so an early failure is a normal JSON error.
    const first = await rows.next();
    const day = new Date().toISOString().slice(0, 10);
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="send-history-${channel}-${day}.csv"`);
    res.setHeader("Cache-Control", "no-store");
    // BOM so Excel opens the file as UTF-8 (same as the per-batch download).
    res.write("﻿" + (first.done ? "" : first.value));
    try {
      for await (const chunk of rows) {
        if (res.destroyed) return; // client went away
        if (!res.write(chunk)) await new Promise((r) => res.once("drain", r));
      }
      res.end();
    } catch (err) {
      // Headers are already sent: abort the download so the browser reports a failure instead of a cut-off file.
      logger.error({ err, channel }, "send queue history export failed mid-stream");
      res.destroy(err as Error);
    }
  }),
);
