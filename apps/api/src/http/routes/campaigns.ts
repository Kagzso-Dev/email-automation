import { Router } from "express";
import cronParser from "cron-parser";
import { createCampaignInput, idParam, updateCampaignInput } from "@dispatch/shared";
import { prisma } from "../../prisma.js";
import { enqueueCampaignDispatch } from "../../queue/queues.js";
import { scheduleCampaign, unscheduleCampaign } from "../../queue/scheduler.js";
import { authRequired, requireRole } from "../middleware/auth.js";
import { badRequest, conflict, notFound, wrap } from "../errors.js";

export const campaignsRouter = Router();
campaignsRouter.use(authRequired);

campaignsRouter.get(
  "/",
  wrap(async (_req, res) => {
    res.json({
      items: await prisma.campaign.findMany({
        orderBy: { createdAt: "desc" },
        include: { template: { select: { name: true } }, list: { select: { name: true } } },
      }),
    });
  }),
);

campaignsRouter.post(
  "/",
  wrap(async (req, res) => {
    const body = createCampaignInput.parse(req.body);
    if (body.cronExpression) assertValidCron(body.cronExpression);
    await assertRefs(body.templateId, body.listId);
    const campaign = await prisma.campaign.create({
      data: {
        name: body.name,
        templateId: body.templateId,
        listId: body.listId,
        scheduleType: body.scheduleType,
        sendAt: body.sendAt ?? null,
        cronExpression: body.cronExpression ?? null,
        status: "DRAFT",
      },
    });
    res.status(201).json(campaign);
  }),
);

campaignsRouter.get(
  "/:id",
  wrap(async (req, res) => {
    const { id } = idParam.parse(req.params);
    const campaign = await prisma.campaign.findUnique({
      where: { id },
      include: { template: true, list: { include: { _count: { select: { members: true } } } } },
    });
    if (!campaign) throw notFound("Campaign");
    res.json(campaign);
  }),
);

campaignsRouter.put(
  "/:id",
  wrap(async (req, res) => {
    const { id } = idParam.parse(req.params);
    const body = updateCampaignInput.parse(req.body);
    const current = await prisma.campaign.findUnique({ where: { id } });
    if (!current) throw notFound("Campaign");
    if (current.status !== "DRAFT" && current.status !== "PAUSED") {
      throw conflict("Only DRAFT or PAUSED campaigns can be edited");
    }
    if (body.cronExpression) assertValidCron(body.cronExpression);
    res.json(await prisma.campaign.update({ where: { id }, data: body }));
  }),
);

campaignsRouter.post(
  "/:id/schedule",
  wrap(async (req, res) => {
    const { id } = idParam.parse(req.params);
    const c = await prisma.campaign.findUnique({ where: { id } });
    if (!c) throw notFound("Campaign");
    if (c.scheduleType === "ONCE" && (!c.sendAt || c.sendAt.getTime() <= Date.now())) {
      throw badRequest("sendAt must be in the future");
    }
    if (c.scheduleType === "RECURRING") assertValidCron(c.cronExpression ?? "");
    await assertRefs(c.templateId, c.listId);
    const members = await prisma.listMembership.count({ where: { listId: c.listId } });
    if (members === 0) throw badRequest("Target list has no members");
    await scheduleCampaign(id);
    res.json(await prisma.campaign.findUnique({ where: { id } }));
  }),
);

campaignsRouter.post(
  "/:id/pause",
  wrap(async (req, res) => {
    const { id } = idParam.parse(req.params);
    const c = await prisma.campaign.findUnique({ where: { id } });
    if (!c) throw notFound("Campaign");
    await unscheduleCampaign(id);
    res.json(await prisma.campaign.update({ where: { id }, data: { status: "PAUSED" } }));
  }),
);

campaignsRouter.post(
  "/:id/send-now",
  requireRole("ADMIN"),
  wrap(async (req, res) => {
    const { id } = idParam.parse(req.params);
    const c = await prisma.campaign.findUnique({ where: { id } });
    if (!c) throw notFound("Campaign");
    await assertRefs(c.templateId, c.listId);
    await prisma.campaign.update({ where: { id }, data: { status: "SCHEDULED", lastRunAt: null } });
    await enqueueCampaignDispatch(
      { campaignId: id, runDate: new Date().toISOString().slice(0, 10) },
      { dedupeKey: `disp:${id}:manual:${Date.now()}` },
    );
    res.status(202).json({ status: "dispatching" });
  }),
);

campaignsRouter.delete(
  "/:id",
  wrap(async (req, res) => {
    const { id } = idParam.parse(req.params);
    const c = await prisma.campaign.findUnique({ where: { id } });
    if (!c) throw notFound("Campaign");
    if (c.status === "SENDING") throw conflict("Cannot delete a campaign while it is sending");
    await unscheduleCampaign(id);
    await prisma.emailLog.updateMany({ where: { campaignId: id }, data: { campaignId: null } });
    await prisma.campaign.delete({ where: { id } });
    res.status(204).end();
  }),
);

function assertValidCron(expr: string) {
  try {
    cronParser.parseExpression(expr);
  } catch {
    throw badRequest(`Invalid cron expression: "${expr}"`);
  }
}

async function assertRefs(templateId: string, listId: string) {
  const [tpl, list] = await Promise.all([
    prisma.template.findUnique({ where: { id: templateId } }),
    prisma.list.findUnique({ where: { id: listId } }),
  ]);
  if (!tpl) throw badRequest("templateId does not exist");
  if (!list) throw badRequest("listId does not exist");
}
