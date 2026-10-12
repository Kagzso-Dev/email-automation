// GET /api/dashboard/calls/cost-by-flow?days=7|14|30 — new, read-only.
// Same guards as /api/dashboard/calls: 404 while ENABLE_AI_CALLS is off, ADMIN only.

import { Router } from "express";
import { aiCallsConfig } from "../../config/aiCalls.js";
import { parseSpan } from "../../domain/dashboardChannels.js";
import { callCostByFlow } from "../../domain/callCostByFlow.js";
import { authRequired, requireRole } from "../middleware/auth.js";
import { AppError, badRequest, wrap } from "../errors.js";

export const callCostByFlowRouter = Router();

callCostByFlowRouter.get(
  "/dashboard/calls/cost-by-flow",
  authRequired,
  (_req, _res, next) =>
    aiCallsConfig.enabled ? next() : next(new AppError(404, "AI calls are disabled (set ENABLE_AI_CALLS=true)", "not_found")),
  requireRole("ADMIN"),
  wrap(async (req, res) => {
    const span = parseSpan(req.query.days);
    if (!span) throw badRequest("days must be 7, 14 or 30");
    res.json(await callCostByFlow(span));
  }),
);
