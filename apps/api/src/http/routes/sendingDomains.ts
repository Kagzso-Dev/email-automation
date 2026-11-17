// Settings → Domain mode (ENABLE_DOMAIN_BLOCKLIST): the "Email all domains except blocked ones" switch
// (ALLOWLIST ↔ BLOCKLIST), the Blocked list, and who changed them. The Approved list keeps its own
// endpoints in routes/settings.ts. Any signed-in user can read; only admins can change anything, and every
// change is written to sending_domain_audit in the same transaction.
//
// Available by default (the switch is toggled in the UI). Kill switch ENABLE_DOMAIN_BLOCKLIST=false: GET answers
// { enabled: false } and every other endpoint 404 — nothing new is read or written. Migration 0036 not applied
// yet: GET answers ready: false (the UI shows the switch disabled, with what to run) and changes answer 503.

import { Router, type RequestHandler } from "express";
import { blockedDomainInput, domainModeInput, idParam } from "@dispatch/shared";
import { isDomainBlocklistEnabled } from "../../config/domainBlocklist.js";
import { logger } from "../../logger.js";
import { prisma } from "../../prisma.js";
import { DOMAIN_MODE_KEY, getDomainMode } from "../../domain/sendingDomainPolicy.js";
import { domainAuditCreate, lastModeChange, listDomainAudit } from "../../domain/sendingDomainAudit.js";
import { authRequired, requireRole } from "../middleware/auth.js";
import { AppError, conflict, notFound, wrap } from "../errors.js";

export const sendingDomainsRouter = Router();
sendingDomainsRouter.use(authRequired);

const flagOn: RequestHandler = (_req, _res, next) =>
  next(isDomainBlocklistEnabled() ? undefined : notFound("Domain mode"));

/** How many changes an admin sees under "Recent changes". */
const HISTORY_SIZE = 20;

const NEEDS_MIGRATION =
  "Domain mode needs a database update — run `npm run prisma:deploy` (migration 0036), then reload.";

/** Prisma's "table does not exist" (P2021) or MySQL's 1146: migration 0036 isn't applied yet. */
const isMissingTable = (err: unknown) => {
  const raw = err as { code?: string; meta?: { code?: string } } | null;
  return raw?.code === "P2021" || raw?.meta?.code === "1146";
};

/** wrap(), plus: a missing table → 503 saying what to run, never a bare 500. */
const handle = (fn: Parameters<typeof wrap>[0]) =>
  wrap(async (req, res, next) => {
    try {
      await fn(req, res, next);
    } catch (err) {
      throw isMissingTable(err) ? new AppError(503, NEEDS_MIGRATION, "needs_migration") : err;
    }
  });

sendingDomainsRouter.get(
  "/",
  wrap(async (req, res) => {
    if (!isDomainBlocklistEnabled()) {
      res.json({ enabled: false });
      return;
    }
    const isAdmin = req.user!.role === "ADMIN";
    try {
      const [mode, blocked, modeChange, history] = await Promise.all([
        getDomainMode(),
        prisma.blockedSendingDomain.findMany({ orderBy: { domain: "asc" } }),
        lastModeChange(),
        isAdmin ? listDomainAudit(HISTORY_SIZE) : Promise.resolve(null),
      ]);
      res.json({
        enabled: true,
        ready: true,
        mode,
        blocked,
        lastModeChange: modeChange,
        ...(history ? { history } : {}), // admins only: the full log names who changed what
      });
    } catch (err) {
      if (!isMissingTable(err)) throw err;
      logger.warn("sending domain tables missing — run `npm run prisma:deploy` (0036_sending_domain_blocklist)");
      res.json({ enabled: true, ready: false, mode: "ALLOWLIST", blocked: [], lastModeChange: null });
    }
  }),
);

sendingDomainsRouter.put(
  "/mode",
  flagOn,
  requireRole("ADMIN"),
  handle(async (req, res) => {
    const { mode } = domainModeInput.parse(req.body);
    const current = await getDomainMode();
    if (mode !== current) {
      await prisma.$transaction([
        prisma.setting.upsert({
          where: { key: DOMAIN_MODE_KEY },
          create: { key: DOMAIN_MODE_KEY, value: mode },
          update: { value: mode },
        }),
        domainAuditCreate(req.user!, "MODE_CHANGED", mode),
      ]);
      logger.info({ by: req.user!.email, from: current, to: mode }, "sending domain mode changed");
    }
    res.json({ mode });
  }),
);

sendingDomainsRouter.post(
  "/blocked",
  flagOn,
  requireRole("ADMIN"),
  handle(async (req, res) => {
    const { domain } = blockedDomainInput.parse(req.body);
    const existing = await prisma.blockedSendingDomain.findUnique({ where: { domain } });
    if (existing) throw conflict(`${domain} is already blocked`);
    const [item] = await prisma.$transaction([
      prisma.blockedSendingDomain.create({ data: { domain, createdBy: req.user!.id } }),
      domainAuditCreate(req.user!, "BLOCKED_ADDED", domain),
    ]);
    logger.info({ by: req.user!.email, domain }, "sending domain blocked");
    res.status(201).json(item);
  }),
);

sendingDomainsRouter.delete(
  "/blocked/:id",
  flagOn,
  requireRole("ADMIN"),
  handle(async (req, res) => {
    const { id } = idParam.parse(req.params);
    const existing = await prisma.blockedSendingDomain.findUnique({ where: { id } });
    if (!existing) throw notFound("Blocked domain");
    await prisma.$transaction([
      prisma.blockedSendingDomain.delete({ where: { id } }),
      domainAuditCreate(req.user!, "BLOCKED_REMOVED", existing.domain),
    ]);
    logger.info({ by: req.user!.email, domain: existing.domain }, "sending domain unblocked");
    res.status(204).end();
  }),
);
