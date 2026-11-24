// Automation: LinkedIn Automation + Instagram Automation (ENABLE_AUTOMATION, migration 0041). ADMIN and EDITOR.
//
// Flag off: EVERY endpoint here answers 404 — the flag is checked before sign-in, so it is 404 for everyone.
// Official APIs only: LinkedIn Marketing API (ads), Meta Marketing API (Instagram ads), Instagram Messaging API (DMs).
// LinkedIn messages are never sent (no public API; the website is never automated). Tokens stay in .env: no
// endpoint returns one, and upstream error text is scrubbed of them (services/automation/upstream.ts).
//
//   GET  /api/automation/config                          { enabled, linkedin:{…}, instagram:{…} } (configured flags only)
//   GET  /api/automation/:platform/status                connection check against the platform (account name, currency)
//   GET  /api/automation/:platform/campaigns             campaigns with status, daily budget, last-30-day spend/results
//   GET  /api/automation/linkedin/campaign-groups        for "Create campaign" on LinkedIn
//   POST /api/automation/:platform/campaigns             create — PAUSED (Meta) / DRAFT (LinkedIn): nothing spends
//   POST /api/automation/:platform/campaigns/:id/pause   pause
//   POST /api/automation/:platform/campaigns/:id/resume  resume (can start spending — the web app confirms first)
//   GET  /api/automation/instagram/conversations         DM recipients with their 24-hour window state
//   POST /api/automation/:platform/dm/preview            the confirm step: who can be sent to, the count, a confirm token
//   POST /api/automation/:platform/dm                    send — needs the preview's token and count; re-checks the window
//   GET  /api/automation/:platform/dm/history            the send log, newest first
//
// LinkedIn /dm and /dm/preview: 409 dm_unavailable. Before migration 0041: anything that writes answers 503.

import { randomUUID } from "node:crypto";
import { Router, type Request, type RequestHandler } from "express";
import { rateLimit } from "express-rate-limit";
import { z } from "zod";
import {
  instagramMessagingSettings,
  isAutomationEnabled,
  LINKEDIN_DM_UNAVAILABLE_REASON,
  linkedinSettings,
  metaAdsSettings,
} from "../../config/automation.js";
import { BLOCK_REASON_TEXT, decideSend, windowState, type SendDecision } from "../../domain/automation/dmWindow.js";
import {
  dmHistory,
  ensureTables,
  isMissingTable,
  logCampaignAction,
  logDm,
  NEEDS_MIGRATION,
  signConfirm,
  verifyConfirm,
  CONFIRM_TTL_MS,
} from "../../domain/automation/sendLog.js";
import * as linkedin from "../../services/automation/linkedinAds.js";
import * as meta from "../../services/automation/metaAds.js";
import * as ig from "../../services/automation/instagramMessaging.js";
import type { AutomationPlatform, CreateCampaignInput } from "../../services/automation/types.js";
import { authRequired, requireRole } from "../middleware/auth.js";
import { AppError, notFound, wrap } from "../errors.js";

export const automationRouter = Router();

const flagOn: RequestHandler = (_req, _res, next) => next(isAutomationEnabled() ? undefined : notFound("Automation"));
automationRouter.use(flagOn, authRequired, requireRole("ADMIN", "EDITOR"));

const limiter = (limit: number) =>
  rateLimit({
    windowMs: 60_000,
    limit,
    standardHeaders: true,
    keyGenerator: (req) => req.user?.id ?? req.ip ?? "anon",
    message: { error: "Too many requests — wait a minute and try again.", code: "rate_limited" },
  });
const readLimiter = limiter(120);
const writeLimiter = limiter(30);
const dmLimiter = limiter(10);

/** wrap(), plus: a missing table → 503 saying what to run, never a bare 500. */
const handle = (fn: Parameters<typeof wrap>[0]) =>
  wrap(async (req, res, next) => {
    try {
      await fn(req, res, next);
    } catch (err) {
      throw isMissingTable(err) ? new AppError(503, NEEDS_MIGRATION, "needs_migration") : err;
    }
  });

const platformParam = z.object({ platform: z.enum(["linkedin", "instagram"]) });
const platformOf = (req: Request): AutomationPlatform => platformParam.parse(req.params).platform;
const actor = (req: Request) => ({ id: req.user!.id, email: req.user!.email });

const errorInfo = (err: unknown) =>
  err instanceof AppError ? { code: err.code, message: err.message } : { code: "error", message: "Something went wrong." };

/* ------------------------------------------------------------------ config + status */

automationRouter.get(
  "/config",
  readLimiter,
  handle(async (_req, res) => {
    const ig = instagramMessagingSettings();
    res.json({
      enabled: true,
      linkedin: { adsConfigured: linkedinSettings().configured, dmAvailable: false, dmReason: LINKEDIN_DM_UNAVAILABLE_REASON },
      instagram: { adsConfigured: metaAdsSettings().configured, messagingConfigured: ig.configured, humanAgentEnabled: ig.humanAgentEnabled },
    });
  }),
);

async function check<T>(configured: boolean, fn: () => Promise<T>) {
  if (!configured) return { configured: false, connected: false, account: null, error: null };
  try {
    return { configured: true, connected: true, account: await fn(), error: null };
  } catch (err) {
    return { configured: true, connected: false, account: null, error: errorInfo(err) };
  }
}

automationRouter.get(
  "/:platform/status",
  readLimiter,
  handle(async (req, res) => {
    if (platformOf(req) === "linkedin") {
      const ads = await check(linkedinSettings().configured, linkedin.getAccount);
      return res.json({ platform: "linkedin", ads, dm: { available: false, reason: LINKEDIN_DM_UNAVAILABLE_REASON } });
    }
    const igs = instagramMessagingSettings();
    const [ads, messaging] = await Promise.all([check(metaAdsSettings().configured, meta.getAccount), check(igs.configured, ig.getMessagingAccount)]);
    res.json({
      platform: "instagram",
      ads,
      messaging,
      dm: {
        available: messaging.connected,
        reason: messaging.connected ? null : igs.configured ? "Instagram messaging couldn't be reached — see the connection card." : "Instagram messaging isn't connected (INSTAGRAM_* in .env).",
        humanAgentEnabled: igs.humanAgentEnabled,
      },
    });
  }),
);

/* ------------------------------------------------------------------ campaigns */

automationRouter.get(
  "/:platform/campaigns",
  readLimiter,
  handle(async (req, res) => {
    res.json(platformOf(req) === "linkedin" ? await linkedin.listCampaigns() : await meta.listCampaigns());
  }),
);

automationRouter.get(
  "/linkedin/campaign-groups",
  readLimiter,
  handle(async (_req, res) => {
    res.json({ groups: await linkedin.listCampaignGroups() });
  }),
);

const createInput = z.object({
  name: z.string().trim().min(1, "Name is required").max(200),
  objective: z.string(),
  dailyBudget: z.number().positive("Daily budget must be more than 0").max(1_000_000),
  campaignGroupId: z.string().regex(/^\d{1,30}$/).optional(),
});

automationRouter.post(
  "/:platform/campaigns",
  writeLimiter,
  handle(async (req, res) => {
    const platform = platformOf(req);
    const body = createInput.parse(req.body);
    const allowed: readonly string[] = platform === "linkedin" ? linkedin.LINKEDIN_OBJECTIVES : meta.META_OBJECTIVES;
    if (!allowed.includes(body.objective)) throw new AppError(400, `Unknown objective. Use one of: ${allowed.join(", ")}`, "bad_request");
    await ensureTables();
    const input: CreateCampaignInput = body;
    try {
      const out = platform === "linkedin" ? await linkedin.createCampaign(input) : await meta.createCampaign(input);
      await logCampaignAction({ platform, campaignId: out.id, campaignName: body.name, action: "create", status: "ok" }, actor(req));
      res.status(201).json({ id: out.id, status: platform === "linkedin" ? "DRAFT" : "PAUSED" });
    } catch (err) {
      const e = errorInfo(err);
      await logCampaignAction({ platform, campaignId: null, campaignName: body.name, action: "create", status: "failed", errorCode: e.code, errorMessage: e.message }, actor(req));
      throw err;
    }
  }),
);

const actionParams = z.object({ id: z.string().regex(/^\d{1,30}$/, "Invalid campaign id"), action: z.enum(["pause", "resume"]) });
const actionBody = z.object({ name: z.string().max(255).optional() }).passthrough();

automationRouter.post(
  "/:platform/campaigns/:id/:action",
  writeLimiter,
  handle(async (req, res) => {
    const platform = platformOf(req);
    const { id, action } = actionParams.parse(req.params);
    const name = actionBody.parse(req.body ?? {}).name ?? null;
    await ensureTables();
    const status = action === "pause" ? "PAUSED" : "ACTIVE";
    try {
      if (platform === "linkedin") await linkedin.setCampaignStatus(id, status);
      else await meta.setCampaignStatus(id, status);
      await logCampaignAction({ platform, campaignId: id, campaignName: name, action, status: "ok" }, actor(req));
      res.json({ id, status });
    } catch (err) {
      const e = errorInfo(err);
      await logCampaignAction({ platform, campaignId: id, campaignName: name, action, status: "failed", errorCode: e.code, errorMessage: e.message }, actor(req));
      throw err;
    }
  }),
);

/* ------------------------------------------------------------------ DMs */

const linkedinDmUnavailable = () => new AppError(409, LINKEDIN_DM_UNAVAILABLE_REASON, "dm_unavailable");

automationRouter.get(
  "/instagram/conversations",
  readLimiter,
  handle(async (_req, res) => {
    const now = new Date();
    const convs = await ig.listConversations();
    res.json({
      now: now.toISOString(),
      humanAgentEnabled: instagramMessagingSettings().humanAgentEnabled,
      recipients: convs.map((c) => {
        const w = windowState(c.lastInboundAt, now);
        return {
          recipientId: c.recipientId,
          username: c.username,
          lastInboundAt: c.lastInboundAt?.toISOString() ?? null,
          window: w.state,
          windowEndsAt: w.endsAt?.toISOString() ?? null,
        };
      }),
    });
  }),
);

const MAX_RECIPIENTS = 50;
const dmInput = z.object({
  recipientIds: z
    .array(z.string().regex(/^\d{1,40}$/, "Invalid recipient id"))
    .min(1, "Pick at least one recipient")
    .max(MAX_RECIPIENTS, `At most ${MAX_RECIPIENTS} recipients per send`)
    .refine((ids) => new Set(ids).size === ids.length, "A recipient is listed twice"),
  message: z
    .string()
    .trim()
    .min(1, "Write a message")
    .refine((m) => Buffer.byteLength(m, "utf8") <= 1000, "Instagram messages are at most 1000 bytes"),
  useHumanAgentTag: z.boolean().default(false),
});
const sendInput = dmInput.extend({ confirmToken: z.string().min(10).max(200), confirmCount: z.number().int().min(1).max(MAX_RECIPIENTS) });

interface Decided extends SendDecision {
  recipientId: string;
  username: string | null;
}

async function decideAll(recipientIds: string[], useHumanAgentTag: boolean): Promise<Decided[]> {
  const now = new Date();
  const byId = new Map((await ig.listConversations()).map((c) => [c.recipientId, c]));
  const humanAgentEnabled = instagramMessagingSettings().humanAgentEnabled;
  return recipientIds.map((id) => {
    const conv = byId.get(id);
    if (!conv) return { recipientId: id, username: null, allowed: false, tag: null, state: "no_inbound", reason: "no_conversation" };
    return {
      recipientId: id,
      username: conv.username,
      ...decideSend({ lastInboundAt: conv.lastInboundAt, now, humanAgentEnabled, useHumanAgentTag, recipientCount: recipientIds.length }),
    };
  });
}

const view = (d: Decided) => ({
  recipientId: d.recipientId,
  username: d.username,
  allowed: d.allowed,
  tag: d.tag,
  window: d.state,
  reason: d.reason,
  reasonText: d.reason ? BLOCK_REASON_TEXT[d.reason] : null,
});

automationRouter.post(
  "/:platform/dm/preview",
  dmLimiter,
  handle(async (req, res) => {
    if (platformOf(req) === "linkedin") throw linkedinDmUnavailable();
    const body = dmInput.parse(req.body);
    const decided = await decideAll(body.recipientIds, body.useHumanAgentTag);
    const sendable = decided.filter((d) => d.allowed).length;
    res.json({
      recipients: decided.map(view),
      sendable,
      blocked: decided.length - sendable,
      confirmToken: sendable > 0 ? signConfirm({ userId: req.user!.id, recipientIds: body.recipientIds, message: body.message, useHumanAgentTag: body.useHumanAgentTag, count: sendable }) : null,
      expiresAt: new Date(Date.now() + CONFIRM_TTL_MS).toISOString(),
    });
  }),
);

const PAUSE_MS = process.env.NODE_ENV === "test" ? 0 : 300;
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

automationRouter.post(
  "/:platform/dm",
  dmLimiter,
  handle(async (req, res) => {
    if (platformOf(req) === "linkedin") throw linkedinDmUnavailable();
    const body = sendInput.parse(req.body);
    const signed = { userId: req.user!.id, recipientIds: body.recipientIds, message: body.message, useHumanAgentTag: body.useHumanAgentTag, count: body.confirmCount };
    if (!verifyConfirm(body.confirmToken, signed)) {
      throw new AppError(409, "This send wasn't confirmed (or the confirmation expired, or the message changed). Review and confirm again.", "confirm_required");
    }
    await ensureTables();
    // The window is decided again now: time has passed since the preview.
    const decided = await decideAll(body.recipientIds, body.useHumanAgentTag);
    if (decided.filter((d) => d.allowed).length > body.confirmCount) {
      throw new AppError(409, "More recipients can be sent to than you confirmed. Review and confirm again.", "confirm_required");
    }

    const batchId = randomUUID();
    const who = actor(req);
    const results: Array<{ recipientId: string; username: string | null; status: "sent" | "failed" | "blocked"; error: string | null }> = [];
    let stopped: { code: string; message: string } | null = null;
    let first = true;
    for (const d of decided) {
      const base = { platform: "instagram" as const, batchId, recipientId: d.recipientId, recipientName: d.username, message: body.message, messageTag: d.tag, windowState: d.state };
      if (!d.allowed) {
        const text = d.reason ? BLOCK_REASON_TEXT[d.reason] : "Not allowed";
        await logDm({ ...base, status: "blocked", errorCode: d.reason, errorMessage: text }, who);
        results.push({ recipientId: d.recipientId, username: d.username, status: "blocked", error: text });
        continue;
      }
      if (stopped) {
        await logDm({ ...base, status: "failed", errorCode: stopped.code, errorMessage: `Not sent: ${stopped.message}` }, who);
        results.push({ recipientId: d.recipientId, username: d.username, status: "failed", error: `Not sent: ${stopped.message}` });
        continue;
      }
      if (!first) await pause(PAUSE_MS);
      first = false;
      try {
        const out = await ig.sendMessage({ recipientId: d.recipientId, text: body.message, tag: d.tag });
        await logDm({ ...base, status: "sent", providerMessageId: out.messageId }, who);
        results.push({ recipientId: d.recipientId, username: d.username, status: "sent", error: null });
      } catch (err) {
        const e = errorInfo(err);
        await logDm({ ...base, status: "failed", errorCode: e.code, errorMessage: e.message }, who);
        results.push({ recipientId: d.recipientId, username: d.username, status: "failed", error: e.message });
        // A rejected token or a rate limit affects every remaining recipient: stop instead of hammering the API.
        if (e.code === "rate_limited" || e.code === "token_invalid" || e.code === "permission_denied") stopped = e;
      }
    }
    const count = (s: string) => results.filter((r) => r.status === s).length;
    res.json({ batchId, sent: count("sent"), failed: count("failed"), blocked: count("blocked"), results });
  }),
);

const historyQuery = z.object({ page: z.coerce.number().int().min(1).max(10_000).default(1) });

automationRouter.get(
  "/:platform/dm/history",
  readLimiter,
  handle(async (req, res) => {
    const platform = platformOf(req);
    const { page } = historyQuery.parse(req.query);
    const out = await dmHistory(platform, page, 25);
    res.json({
      ...out,
      items: out.items.map((r) => ({
        id: r.id,
        recipientId: r.recipientId,
        recipientName: r.recipientName,
        message: r.message,
        messageTag: r.messageTag,
        windowState: r.windowState,
        status: r.status,
        errorMessage: r.errorMessage,
        sentByEmail: r.sentByEmail,
        createdAt: r.createdAt,
      })),
    });
  }),
);
