import { Router } from "express";
import { allowedDomainInput, bulkSendSettingsInput, idParam } from "@dispatch/shared";
import { prisma } from "../../prisma.js";
import { env } from "../../env.js";
import { getBulkSendDelays, setBulkSendDelays } from "../../domain/settings.js";
import { authRequired, requireRole } from "../middleware/auth.js";
import { conflict, notFound, wrap } from "../errors.js";

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
