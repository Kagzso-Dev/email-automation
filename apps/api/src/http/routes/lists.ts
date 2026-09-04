import { Router } from "express";
import { z } from "zod";
import { createListInput, idParam, listMembersInput, updateListInput } from "@dispatch/shared";
import { prisma } from "../../prisma.js";
import { authRequired } from "../middleware/auth.js";
import { badRequest, notFound, wrap } from "../errors.js";

const memberParam = z.object({ id: z.string().min(1), contactId: z.string().min(1) });

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

// All contacts belonging to one list, most-recently-added first. Each row is
// the contact plus the `addedAt` timestamp from the join table.
listsRouter.get(
  "/:id/members",
  wrap(async (req, res) => {
    const { id: listId } = idParam.parse(req.params);
    const list = await prisma.list.findUnique({ where: { id: listId } });
    if (!list) throw notFound("List");
    const members = await prisma.listMembership.findMany({
      where: { listId },
      include: { contact: true },
      orderBy: { addedAt: "desc" },
    });
    res.json({ items: members.map((m) => ({ ...m.contact, addedAt: m.addedAt })) });
  }),
);

listsRouter.post(
  "/:id/members",
  wrap(async (req, res) => {
    const { id: listId } = idParam.parse(req.params);
    const body = listMembersInput.parse(req.body);
    const add = body.contactId ? [...new Set([...body.add, body.contactId])] : body.add;
    const { remove } = body;

    const list = await prisma.list.findUnique({ where: { id: listId } });
    if (!list) throw notFound("List");
    if (add.length) {
      const found = await prisma.contact.count({ where: { id: { in: add } } });
      if (found !== new Set(add).size) throw badRequest("One or more contactId values do not exist");
    }

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

// Remove a single contact from a list. Idempotent — succeeds whether or not the
// membership existed. Returns the fresh member count for the caller's UI.
listsRouter.delete(
  "/:id/members/:contactId",
  wrap(async (req, res) => {
    const { id: listId, contactId } = memberParam.parse(req.params);
    await prisma.listMembership.deleteMany({ where: { listId, contactId } });
    const count = await prisma.listMembership.count({ where: { listId } });
    res.json({ listId, memberCount: count });
  }),
);
