import { Router } from "express";
import { createListInput, idParam, listMembersInput, updateListInput } from "@dispatch/shared";
import { prisma } from "../../prisma.js";
import { authRequired } from "../middleware/auth.js";
import { notFound, wrap } from "../errors.js";

export const listsRouter = Router();
listsRouter.use(authRequired);

listsRouter.get(
  "/",
  wrap(async (_req, res) => {
    const lists = await prisma.list.findMany({
      orderBy: { createdAt: "desc" },
      include: { _count: { select: { members: true, campaigns: true } } },
    });
    res.json({ items: lists });
  }),
);

listsRouter.post(
  "/",
  wrap(async (req, res) => {
    const body = createListInput.parse(req.body);
    const list = await prisma.list.create({ data: body });
    res.status(201).json(list);
  }),
);

listsRouter.get(
  "/:id",
  wrap(async (req, res) => {
    const { id } = idParam.parse(req.params);
    const list = await prisma.list.findUnique({
      where: { id },
      include: {
        members: { include: { contact: true }, orderBy: { addedAt: "desc" }, take: 500 },
        _count: { select: { members: true } },
      },
    });
    if (!list) throw notFound("List");
    res.json(list);
  }),
);

listsRouter.put(
  "/:id",
  wrap(async (req, res) => {
    const { id } = idParam.parse(req.params);
    const body = updateListInput.parse(req.body);
    res.json(await prisma.list.update({ where: { id }, data: body }));
  }),
);

listsRouter.delete(
  "/:id",
  wrap(async (req, res) => {
    const { id } = idParam.parse(req.params);
    await prisma.list.delete({ where: { id } });
    res.status(204).end();
  }),
);

listsRouter.post(
  "/:id/members",
  wrap(async (req, res) => {
    const { id: listId } = idParam.parse(req.params);
    const { add, remove } = listMembersInput.parse(req.body);
    await prisma.$transaction([
      ...add.map((contactId) =>
        prisma.listMembership.upsert({
          where: { listId_contactId: { listId, contactId } },
          create: { listId, contactId },
          update: {},
        }),
      ),
      ...(remove.length
        ? [prisma.listMembership.deleteMany({ where: { listId, contactId: { in: remove } } })]
        : []),
    ]);
    const count = await prisma.listMembership.count({ where: { listId } });
    res.json({ listId, memberCount: count });
  }),
);
