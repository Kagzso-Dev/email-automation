// Send Queue → "AI Call follow-ups". ADMIN-only; 404 while ENABLE_AI_CALLS is off.
// Nothing is sent from here until an admin approves; approval hands the
// follow-up to the existing WhatsApp batch sender or AI call run.
//
//   GET   /api/ai-call-followups               list (status filter, page)
//   PATCH /api/ai-call-followups/:id           edit before send (template / time / note)
//   POST  /api/ai-call-followups/:id/approve   approve → queue with the existing sender
//   POST  /api/ai-call-followups/:id/reject    reject (nothing is sent)

import { Router, type NextFunction, type Request, type Response } from "express";
import { rateLimit } from "express-rate-limit";
import { editFollowupInput, idParam, listFollowupsQuery } from "@dispatch/shared";
import { aiCallsConfig } from "../../config/aiCalls.js";
import { approveFollowup, editFollowup, FollowupError, listFollowups, rejectFollowup } from "../../domain/aiCallFollowups.js";
import { authRequired, requireRole } from "../middleware/auth.js";
import { AppError, wrap } from "../errors.js";

export const aiCallFollowupsRouter = Router();

const limiter = rateLimit({
  windowMs: 60_000,
  limit: 120,
  standardHeaders: true,
  keyGenerator: (req) => req.user?.id ?? req.ip ?? "anon",
  message: { error: "Too many requests — wait a minute and try again.", code: "rate_limited" },
});

function featureGate(_req: Request, _res: Response, next: NextFunction) {
  if (!aiCallsConfig.enabled) return next(new AppError(404, "AI calls are disabled (set ENABLE_AI_CALLS=true)", "not_found"));
  next();
}
aiCallFollowupsRouter.use(authRequired, featureGate, requireRole("ADMIN"), limiter);

function toHttp(err: unknown): never {
  if (err instanceof FollowupError) {
    const code = err.status === 404 ? "not_found" : err.status === 409 ? "conflict" : err.status >= 500 ? "unavailable" : "bad_request";
    throw new AppError(err.status, err.message, code);
  }
  throw err;
}

aiCallFollowupsRouter.get(
  "/",
  wrap(async (req, res) => {
    res.json(await listFollowups(listFollowupsQuery.parse(req.query)));
  }),
);

aiCallFollowupsRouter.patch(
  "/:id",
  wrap(async (req, res) => {
    const { id } = idParam.parse(req.params);
    const input = editFollowupInput.parse(req.body);
    res.json(await editFollowup(id, input, req.user!.email).catch(toHttp));
  }),
);

aiCallFollowupsRouter.post(
  "/:id/approve",
  wrap(async (req, res) => {
    const { id } = idParam.parse(req.params);
    res.json(await approveFollowup(id, req.user!.email).catch(toHttp));
  }),
);

aiCallFollowupsRouter.post(
  "/:id/reject",
  wrap(async (req, res) => {
    const { id } = idParam.parse(req.params);
    await rejectFollowup(id, req.user!.email).catch(toHttp);
    res.json({ ok: true });
  }),
);
