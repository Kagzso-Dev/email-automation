import { Router } from "express";
import { idParam } from "@dispatch/shared";
import { authRequired, requireRole } from "../middleware/auth.js";
import {
  campaignStats,
  dashboardInsights,
  dashboardOverview,
  dashboardTimeseries,
  triggerStats,
} from "../../domain/stats.service.js";
import { callsDashboard, emailDashboard, parseSpan, whatsappDashboard } from "../../domain/dashboardChannels.js";
import { todaysCount } from "../../queue/dailyCap.js";
import { aiCallsConfig } from "../../config/aiCalls.js";
import { env } from "../../env.js";
import { AppError, badRequest, wrap } from "../errors.js";
import { dashboardCosts } from "../../domain/dashboardCosts.js";

export const statsRouter = Router();
statsRouter.use(authRequired);

statsRouter.get(
  "/campaigns/:id/stats",
  wrap(async (req, res) => {
    const { id } = idParam.parse(req.params);
    res.json(await campaignStats(id));
  }),
);

statsRouter.get(
  "/triggers/:id/stats",
  wrap(async (req, res) => {
    const { id } = idParam.parse(req.params);
    res.json(await triggerStats(id));
  }),
);

statsRouter.get(
  "/dashboard/overview",
  wrap(async (_req, res) => {
    const [overview, sentInWindow] = await Promise.all([dashboardOverview(), todaysCount()]);
    res.json({ ...overview, dailyCap: { used: sentInWindow, limit: env.SEND_DAILY_CAP } });
  }),
);

statsRouter.get(
  "/dashboard/timeseries",
  wrap(async (req, res) => {
    res.json(await dashboardTimeseries(Number(req.query.days)));
  }),
);

statsRouter.get(
  "/dashboard/insights",
  wrap(async (_req, res) => {
    res.json(await dashboardInsights());
  }),
);

/* ---- per-channel dashboard numbers (read-only; ?days=7|14|30, UTC days like the timeseries) ---- */

const spanOf = (raw: unknown) => {
  const span = parseSpan(raw);
  if (!span) throw badRequest("days must be 7, 14 or 30");
  return span;
};

statsRouter.get(
  "/dashboard/email",
  wrap(async (req, res) => {
    res.json(await emailDashboard(spanOf(req.query.days)));
  }),
);

// Unread Inbox counts are admin-only, like the Inbox itself; everything else matches Send Queue access.
statsRouter.get(
  "/dashboard/whatsapp",
  wrap(async (req, res) => {
    res.json(await whatsappDashboard(spanOf(req.query.days), { includeUnread: req.user?.role === "ADMIN" }));
  }),
);

// Same gates as /api/ai-calls: 404 while ENABLE_AI_CALLS is off, admins only.
statsRouter.get(
  "/dashboard/calls",
  (_req, _res, next) =>
    aiCallsConfig.enabled ? next() : next(new AppError(404, "AI calls are disabled (set ENABLE_AI_CALLS=true)", "not_found")),
  requireRole("ADMIN"),
  wrap(async (req, res) => {
    res.json(await callsDashboard(spanOf(req.query.days)));
  }),
);

// Cost cards (always estimates: stored counts / minutes × the rate card in Settings).
// Call costs are included only for those who can see the Calls section.
statsRouter.get(
  "/dashboard/costs",
  wrap(async (req, res) => {
    res.json(
      await dashboardCosts(spanOf(req.query.days), { includeCalls: aiCallsConfig.enabled && req.user?.role === "ADMIN" }),
    );
  }),
);
