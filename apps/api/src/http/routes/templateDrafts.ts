// Template drafts (ENABLE_TEMPLATE_DRAFTS, migration 0039). ADMIN only, the same as creating a template; every admin
// sees the team's drafts with who owns each. Only the template_drafts table is read or written.
//
//   GET    /api/template-drafts/config         { enabled }: always answers, for any signed-in user (the web app's switch)
//   GET    /api/template-drafts?channel=       newest first (whatsapp | email; both when omitted), without the form state
//   GET    /api/template-drafts/:id            one draft with its form state
//   PUT    /api/template-drafts/:id            create or update { channel, name, state } (last write wins)
//   DELETE /api/template-drafts/:id            delete it
//
// Flag off: every endpoint except /config answers 404. Migration 0039 not applied: 503 saying what to run. Neither
// ever affects creating a template: the template endpoints don't call these, and the web app treats a failed draft
// save as "Draft not saved" only.

import { Router, type RequestHandler } from "express";
import { rateLimit } from "express-rate-limit";
import { z } from "zod";
import { isTemplateDraftsEnabled } from "../../config/templateDrafts.js";
import {
  DRAFT_CHANNELS,
  DRAFT_RETENTION_DAYS,
  DRAFT_STATE_MAX_BYTES,
  deleteDraft,
  getDraft,
  isMissingTable,
  listDrafts,
  purgeOldDrafts,
  saveDraft,
  startTemplateDraftSweep,
} from "../../domain/templateDrafts.js";
import { authRequired, requireRole } from "../middleware/auth.js";
import { AppError, conflict, notFound, wrap } from "../errors.js";

export const templateDraftsRouter = Router();

// The hourly 30-day sweep runs in the API process (not in the worker's scheduler). Tests drive the purge themselves.
if (process.env.NODE_ENV !== "test") startTemplateDraftSweep();

templateDraftsRouter.use(authRequired);

templateDraftsRouter.get(
  "/config",
  wrap(async (_req, res) => {
    res.json({ enabled: isTemplateDraftsEnabled() });
  }),
);

const flagOn: RequestHandler = (_req, _res, next) => next(isTemplateDraftsEnabled() ? undefined : notFound("Template drafts"));
templateDraftsRouter.use(flagOn, requireRole("ADMIN")); // editors: no template creation, so no drafts

const limiter = (limit: number) =>
  rateLimit({
    windowMs: 60_000,
    limit,
    standardHeaders: true,
    keyGenerator: (req) => req.user?.id ?? req.ip ?? "anon",
    message: { error: "Too many requests — wait a minute and try again.", code: "rate_limited" },
  });
const readLimiter = limiter(240);
const writeLimiter = limiter(120); // autosave: at most one save per 3 seconds per open form

const NEEDS_MIGRATION = "Template drafts need a database update — run `npm run prisma:deploy` (migration 0039), then reload.";

/** wrap(), plus: a missing table → 503 saying what to run, never a bare 500. */
const handle = (fn: Parameters<typeof wrap>[0]) =>
  wrap(async (req, res, next) => {
    try {
      await fn(req, res, next);
    } catch (err) {
      throw isMissingTable(err) ? new AppError(503, NEEDS_MIGRATION, "needs_migration") : err;
    }
  });

const channel = z.enum(DRAFT_CHANNELS);
/** Made by the browser (a UUID), so a save can be retried, and a save when leaving the page needs no answer. */
const draftId = z.object({ id: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/, "Invalid draft id") });
const listQuery = z.object({ channel: channel.optional() });
const saveInput = z
  .object({
    channel,
    name: z
      .string()
      .max(255)
      .nullish()
      .transform((s) => s?.trim() || null),
    // The whole form as the form holds it. No template validation: an incomplete draft is fine.
    state: z
      .record(z.unknown())
      .refine((s) => Buffer.byteLength(JSON.stringify(s), "utf8") <= DRAFT_STATE_MAX_BYTES, "Draft is too large to save"),
  })
  .strict();

templateDraftsRouter.get(
  "/",
  readLimiter,
  handle(async (req, res) => {
    const q = listQuery.parse(req.query);
    await purgeOldDrafts();
    res.json({ items: await listDrafts(q.channel), retentionDays: DRAFT_RETENTION_DAYS });
  }),
);

templateDraftsRouter.get(
  "/:id",
  readLimiter,
  handle(async (req, res) => {
    const { id } = draftId.parse(req.params);
    const draft = await getDraft(id);
    if (!draft) throw notFound("Draft");
    res.json(draft);
  }),
);

templateDraftsRouter.put(
  "/:id",
  writeLimiter,
  handle(async (req, res) => {
    const { id } = draftId.parse(req.params);
    const body = saveInput.parse(req.body);
    const out = await saveDraft({ id, ...body }, { id: req.user!.id, email: req.user!.email });
    if (out.status === "channel_mismatch") throw conflict("This draft belongs to the other templates page");
    res.json(out.draft);
  }),
);

templateDraftsRouter.delete(
  "/:id",
  writeLimiter,
  handle(async (req, res) => {
    const { id } = draftId.parse(req.params);
    if (!(await deleteDraft(id))) throw notFound("Draft");
    res.status(204).end();
  }),
);
