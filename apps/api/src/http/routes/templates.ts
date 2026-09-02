import { Router } from "express";
import { randomUUID } from "node:crypto";
import {
  createTemplateInput,
  idParam,
  previewTemplateInput,
  sendTestInput,
  updateTemplateInput,
} from "@dispatch/shared";
import { prisma } from "../../prisma.js";
import { render } from "../../render/render.js";
import { getProvider } from "../../provider/index.js";
import { env } from "../../env.js";
import { authRequired } from "../middleware/auth.js";
import { badRequest, conflict, notFound, wrap } from "../errors.js";

export const templatesRouter = Router();
templatesRouter.use(authRequired);

templatesRouter.get(
  "/",
  wrap(async (_req, res) => {
    res.json({
      items: await prisma.template.findMany({
        orderBy: { updatedAt: "desc" },
        include: { _count: { select: { campaigns: true, triggers: true } } },
      }),
    });
  }),
);

templatesRouter.post(
  "/",
  wrap(async (req, res) => {
    const body = createTemplateInput.parse(req.body);
    res.status(201).json(await prisma.template.create({ data: body }));
  }),
);

templatesRouter.get(
  "/:id",
  wrap(async (req, res) => {
    const { id } = idParam.parse(req.params);
    const tpl = await prisma.template.findUnique({ where: { id } });
    if (!tpl) throw notFound("Template");
    res.json(tpl);
  }),
);

templatesRouter.put(
  "/:id",
  wrap(async (req, res) => {
    const { id } = idParam.parse(req.params);
    const body = updateTemplateInput.parse(req.body);
    res.json(await prisma.template.update({ where: { id }, data: body }));
  }),
);

templatesRouter.delete(
  "/:id",
  wrap(async (req, res) => {
    const { id } = idParam.parse(req.params);
    const inUse = await prisma.template.findUnique({
      where: { id },
      include: { _count: { select: { campaigns: true, triggers: true } } },
    });
    if (!inUse) throw notFound("Template");
    if (inUse._count.campaigns > 0 || inUse._count.triggers > 0) {
      throw conflict("Template is referenced by a campaign or trigger");
    }
    await prisma.template.delete({ where: { id } });
    res.status(204).end();
  }),
);

templatesRouter.post(
  "/:id/preview",
  wrap(async (req, res) => {
    const { id } = idParam.parse(req.params);
    const { variables } = previewTemplateInput.parse(req.body);
    const tpl = await prisma.template.findUnique({ where: { id } });
    if (!tpl) throw notFound("Template");
    const declared = Array.isArray(tpl.variables) ? (tpl.variables as string[]) : [];
    try {
      const out = render({
        subject: tpl.subject,
        htmlBody: tpl.htmlBody,
        textBody: tpl.textBody,
        declaredVariables: declared,
        vars: variables,
        unsubscribeUrl: `${env.PUBLIC_API_URL}/api/unsubscribe/preview`,
      });
      res.json(out);
    } catch (err) {
      throw badRequest((err as Error).message);
    }
  }),
);

templatesRouter.post(
  "/:id/send-test",
  wrap(async (req, res) => {
    const { id } = idParam.parse(req.params);
    const { to, variables } = sendTestInput.parse(req.body);
    const tpl = await prisma.template.findUnique({ where: { id } });
    if (!tpl) throw notFound("Template");
    const declared = Array.isArray(tpl.variables) ? (tpl.variables as string[]) : [];
    const fakeLogId = `test-${randomUUID()}`;
    const out = render({
      subject: tpl.subject,
      htmlBody: tpl.htmlBody,
      textBody: tpl.textBody,
      declaredVariables: declared,
      vars: variables,
      emailLogId: fakeLogId,
      unsubscribeUrl: `${env.PUBLIC_API_URL}/api/unsubscribe/preview`,
    });
    const result = await getProvider().send({
      to,
      from: env.EMAIL_FROM,
      subject: `[TEST] ${out.subject}`,
      html: out.html,
      text: out.text,
      headers: {},
      tags: { emailLogId: fakeLogId },
    });
    res.json({ sent: true, provider: getProvider().name, ...result });
  }),
);
