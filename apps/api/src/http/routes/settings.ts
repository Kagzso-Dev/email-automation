import { Router } from "express";
import {
  allowedDomainInput,
  brandingInput,
  brandingResetQuery,
  bulkSendSettingsInput,
  costRatesInput,
  idParam,
  sidebarSettingsInput,
} from "@dispatch/shared";
import { prisma } from "../../prisma.js";
import { env } from "../../env.js";
import {
  getBulkSendDelays,
  getSidebarHiddenItems,
  setBulkSendDelays,
  setSidebarHiddenItems,
} from "../../domain/settings.js";
import { authRequired, requireRole } from "../middleware/auth.js";
import { conflict, notFound, wrap } from "../errors.js";
import { getCostRates, setCostRates } from "../../domain/dashboardCosts.js";
import { getBranding, resetBranding, setBranding } from "../../domain/branding.js";

export const settingsRouter = Router();
settingsRouter.use(authRequired);

/* ---------------------------------------------- sending / provider config */

// Read-only view of how this deployment sends mail — drives the Settings UI.
settingsRouter.get(
  "/config",
  wrap(async (_req, res) => {
    res.json({
      emailProvider: env.EMAIL_PROVIDER, // "mock" | "smtp"
      emailFrom: env.EMAIL_FROM,
      senderAddress: env.EMAIL_SENDER_ADDRESS,
      smtpHost: env.EMAIL_PROVIDER === "smtp" ? env.SMTP_HOST ?? null : null,
      dailyCap: env.SEND_DAILY_CAP,
      ratePerSec: env.SEND_RATE_PER_SEC,
      // SMTP has no async delivery callbacks — bounce/complaint stats stay at 0.
      deliveryFeedback: false,
      // Random gap between the individual sends of a bulk ("drip") send.
      bulkSend: await getBulkSendDelays(),
    });
  }),
);

// Min/max seconds waited between drip sends. Admin-only; stored in the Setting
// table so it can be changed without a redeploy.
settingsRouter.put(
  "/bulk-send",
  requireRole("ADMIN"),
  wrap(async (req, res) => {
    const range = bulkSendSettingsInput.parse(req.body);
    res.json(await setBulkSendDelays(range));
  }),
);

/* ---------------------------------------------- sidebar menu */

// Which optional menu items are hidden, for the whole workspace. Every signed-in
// user reads it (the sidebar needs it); only admins can change it.
settingsRouter.get(
  "/sidebar",
  wrap(async (_req, res) => {
    res.json({ hiddenItems: await getSidebarHiddenItems() });
  }),
);

settingsRouter.put(
  "/sidebar",
  requireRole("ADMIN"),
  wrap(async (req, res) => {
    const { hiddenItems } = sidebarSettingsInput.parse(req.body);
    res.json({ hiddenItems: await setSidebarHiddenItems(hiddenItems) });
  }),
);

/* ---------------------------------------------- branding & labels */

// Display names (app name, sidebar labels). Every signed-in user reads them (the
// sidebar needs them); only admins can change or reset them.
settingsRouter.get(
  "/branding",
  wrap(async (_req, res) => {
    res.json(await getBranding());
  }),
);

settingsRouter.put(
  "/branding",
  requireRole("ADMIN"),
  wrap(async (req, res) => {
    res.json(await setBranding(brandingInput.parse(req.body), req.user!.id));
  }),
);

settingsRouter.delete(
  "/branding",
  requireRole("ADMIN"),
  wrap(async (req, res) => {
    const { key } = brandingResetQuery.parse(req.query);
    res.json(await resetBranding(req.user!.id, key));
  }),
);

/* ---------------------------------------------- approved sending domains */

// Any signed-in user can see the list; only admins can change it.
settingsRouter.get(
  "/allowed-domains",
  wrap(async (_req, res) => {
    const items = await prisma.allowedDomain.findMany({ orderBy: { domain: "asc" } });
    res.json({ items });
  }),
);

settingsRouter.post(
  "/allowed-domains",
  requireRole("ADMIN"),
  wrap(async (req, res) => {
    const { domain } = allowedDomainInput.parse(req.body);
    const existing = await prisma.allowedDomain.findUnique({ where: { domain } });
    if (existing) throw conflict(`${domain} is already approved`);
    const item = await prisma.allowedDomain.create({ data: { domain } });
    res.status(201).json(item);
  }),
);

settingsRouter.delete(
  "/allowed-domains/:id",
  requireRole("ADMIN"),
  wrap(async (req, res) => {
    const { id } = idParam.parse(req.params);
    const existing = await prisma.allowedDomain.findUnique({ where: { id } });
    if (!existing) throw notFound("Approved domain");
    await prisma.allowedDomain.delete({ where: { id } });
    res.status(204).end();
  }),
);

/* ---------------------------------------------- cost rates (Dashboard estimates) */

// The rate card the Dashboard cost cards use. Admins only (read and write).
settingsRouter.get(
  "/cost-rates",
  requireRole("ADMIN"),
  wrap(async (_req, res) => {
    res.json(await getCostRates());
  }),
);

settingsRouter.put(
  "/cost-rates",
  requireRole("ADMIN"),
  wrap(async (req, res) => {
    res.json(await setCostRates(costRatesInput.parse(req.body)));
  }),
);
