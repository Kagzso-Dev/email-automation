import { Router } from "express";
import multer from "multer";
import {
  createContactInput,
  idParam,
  listContactsQuery,
  updateContactInput,
} from "@dispatch/shared";
import { prisma } from "../../prisma.js";
import { csvImportQueue } from "../../queue/queues.js";
import { authRequired } from "../middleware/auth.js";
import { badRequest, notFound, wrap } from "../errors.js";

export const contactsRouter = Router();
contactsRouter.use(authRequired);

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

contactsRouter.get(
  "/",
  wrap(async (req, res) => {
    const q = listContactsQuery.parse(req.query);
    const where = {
      ...(q.status ? { status: q.status } : {}),
      ...(q.listId ? { memberships: { some: { listId: q.listId } } } : {}),
      // MySQL columns use a _ci collation, so `contains` is already
      // case-insensitive; Prisma's `mode` option is Postgres-only.
      ...(q.search
        ? {
            OR: [
              { email: { contains: q.search } },
              { firstName: { contains: q.search } },
              { lastName: { contains: q.search } },
            ],
          }
        : {}),
    };
    const [items, total] = await Promise.all([
      prisma.contact.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
      }),
      prisma.contact.count({ where }),
    ]);
    res.json({ items, total, page: q.page, pageSize: q.pageSize });
  }),
);

contactsRouter.post(
  "/",
  wrap(async (req, res) => {
    const body = createContactInput.parse(req.body);
    const contact = await prisma.contact.create({
      data: { ...body, email: body.email.toLowerCase(), customFields: body.customFields ?? {} },
    });
    res.status(201).json(contact);
  }),
);

contactsRouter.get(
  "/:id",
  wrap(async (req, res) => {
    const { id } = idParam.parse(req.params);
    const contact = await prisma.contact.findUnique({
      where: { id },
      include: {
        memberships: { include: { list: true } },
        emailLogs: { orderBy: { createdAt: "desc" }, take: 20 },
        unsubscribe: true,
      },
    });
    if (!contact) throw notFound("Contact");
    res.json(contact);
  }),
);

contactsRouter.put(
  "/:id",
  wrap(async (req, res) => {
    const { id } = idParam.parse(req.params);
    const body = updateContactInput.parse(req.body);
    const contact = await prisma.contact.update({
      where: { id },
      data: { ...body, ...(body.email ? { email: body.email.toLowerCase() } : {}) },
    });
    res.json(contact);
  }),
);

contactsRouter.delete(
  "/:id",
  wrap(async (req, res) => {
    const { id } = idParam.parse(req.params);
    await prisma.contact.delete({ where: { id } });
    res.status(204).end();
  }),
);

contactsRouter.post(
  "/import",
  upload.single("file"),
  wrap(async (req, res) => {
    if (!req.file) throw badRequest("CSV file required (multipart field 'file')");
    const listId = typeof req.body.listId === "string" && req.body.listId ? req.body.listId : undefined;
    const job = await csvImportQueue.add("import", {
      fileContent: req.file.buffer.toString("utf8"),
      listId,
    });
    res.status(202).json({ jobId: job.id, status: "queued" });
  }),
);

contactsRouter.get(
  "/import/:jobId",
  wrap(async (req, res) => {
    const job = await csvImportQueue.getJob(req.params.jobId);
    if (!job) throw notFound("Import job");
    res.json({
      jobId: job.id,
      state: await job.getState(),
      progress: job.progress,
      result: job.returnvalue,
      failedReason: job.failedReason,
    });
  }),
);
