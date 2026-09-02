import { Router } from "express";
import { createTriggerInput, idParam, updateTriggerInput } from "@dispatch/shared";
import { prisma } from "../../prisma.js";
import { env } from "../../env.js";
import { authRequired } from "../middleware/auth.js";
import { badRequest, notFound, wrap } from "../errors.js";

export const triggersRouter = Router();
triggersRouter.use(authRequired);

function withWebhook<T extends { eventKey: string }>(trigger: T) {
  return {
    ...trigger,
    webhookUrl: `${env.PUBLIC_API_URL}/api/webhooks/trigger/${trigger.eventKey}`,
    curlExample: [
      `curl -X POST ${env.PUBLIC_API_URL}/api/webhooks/trigger/${trigger.eventKey} \\`,
      `  -H 'Content-Type: application/json' \\`,
      `  -H 'X-Api-Key: sk_your_key_here' \\`,
      `  -d '{"contactEmail":"user@example.com","payload":{"orderId":"123"}}'`,
    ].join("\n"),
  };
}

triggersRouter.get(
  "/",
  wrap(async (_req, res) => {
    const items = await prisma.trigger.findMany({
      orderBy: { createdAt: "desc" },
      include: { template: { select: { name: true } } },
    });
    res.json({ items: items.map(withWebhook) });
  }),
);

triggersRouter.post(
  "/",
  wrap(async (req, res) => {
    const body = createTriggerInput.parse(req.body);
    const tpl = await prisma.template.findUnique({ where: { id: body.templateId } });
    if (!tpl) throw badRequest("templateId does not exist");
    const trigger = await prisma.trigger.create({ data: { ...body, conditions: body.conditions } });
    res.status(201).json(withWebhook(trigger));
  }),
);

triggersRouter.get(
  "/:id",
  wrap(async (req, res) => {
    const { id } = idParam.parse(req.params);
    const trigger = await prisma.trigger.findUnique({ where: { id }, include: { template: true } });
    if (!trigger) throw notFound("Trigger");
    res.json(withWebhook(trigger));
  }),
);

triggersRouter.put(
  "/:id",
  wrap(async (req, res) => {
    const { id } = idParam.parse(req.params);
    const body = updateTriggerInput.parse(req.body);
    const trigger = await prisma.trigger.update({ where: { id }, data: body });
    res.json(withWebhook(trigger));
  }),
);

triggersRouter.delete(
  "/:id",
  wrap(async (req, res) => {
    const { id } = idParam.parse(req.params);
    await prisma.emailLog.updateMany({ where: { triggerId: id }, data: { triggerId: null } });
    await prisma.trigger.delete({ where: { id } });
    res.status(204).end();
  }),
);
