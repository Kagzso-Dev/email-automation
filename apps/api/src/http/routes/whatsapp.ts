import { Router } from "express";
import multer from "multer";
import {
  createWhatsAppContactInput,
  createWhatsAppTemplateInput,
  idParam,
  listWhatsAppContactsQuery,
  sendBatchHistoryQuery,
  sendWhatsAppBulkInput,
  updateWhatsAppContactInput,
  updateWhatsAppTemplateInput,
} from "@dispatch/shared";
import { prisma } from "../../prisma.js";
import { isWhatsAppConfigured, whatsappConfig } from "../../config/whatsapp.js";
import { formatFromFilename, parseWhatsAppContactFile } from "../../domain/whatsappImport.js";
import {
  createWhatsAppSendBatch,
  getWhatsAppBatchView,
  listWhatsAppSendBatches,
} from "../../domain/whatsappSend.js";
import { authRequired } from "../middleware/auth.js";
import { AppError, badRequest, conflict, notFound, wrap } from "../errors.js";

export const whatsappRouter = Router();
whatsappRouter.use(authRequired);

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

/* ---------------------------------------------------------------- config */

whatsappRouter.get(
  "/config",
  wrap(async (_req, res) => {
    res.json({ configured: isWhatsAppConfigured(), from: whatsappConfig.from ?? null });
  }),
);

/* ---------------------------------------------------------------- contacts */

whatsappRouter.get(
  "/contacts",
  wrap(async (req, res) => {
    const q = listWhatsAppContactsQuery.parse(req.query);
    const where = {
      ...(q.status ? { status: q.status } : {}),
      // MySQL _ci collation makes `contains` case-insensitive already.
      ...(q.search
        ? {
            OR: [
              { phone: { contains: q.search.replace(/[^\d]/g, "") || q.search } },
              { firstName: { contains: q.search } },
              { lastName: { contains: q.search } },
              { businessName: { contains: q.search } },
            ],
          }
        : {}),
    };
    const [items, total] = await Promise.all([
      prisma.whatsAppContact.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
      }),
      prisma.whatsAppContact.count({ where }),
    ]);
    res.json({ items, total, page: q.page, pageSize: q.pageSize });
  }),
);

whatsappRouter.post(
  "/contacts",
  wrap(async (req, res) => {
    const body = createWhatsAppContactInput.parse(req.body);
    const contact = await prisma.whatsAppContact.create({ data: body });
    res.status(201).json(contact);
  }),
);

whatsappRouter.put(
  "/contacts/:id",
  wrap(async (req, res) => {
    const { id } = idParam.parse(req.params);
    const body = updateWhatsAppContactInput.parse(req.body);
    const contact = await prisma.whatsAppContact.update({ where: { id }, data: body });
    res.json(contact);
  }),
);

whatsappRouter.delete(
  "/contacts/:id",
  wrap(async (req, res) => {
    const { id } = idParam.parse(req.params);
    const existing = await prisma.whatsAppContact.findUnique({ where: { id } });
    if (!existing) throw notFound("WhatsApp contact");
    await prisma.whatsAppContact.delete({ where: { id } });
    res.status(204).end();
  }),
);

whatsappRouter.post(
  "/contacts/import",
  upload.single("file"),
  wrap(async (req, res) => {
    if (!req.file) throw badRequest("File required (multipart field 'file')");
    const format = formatFromFilename(req.file.originalname);
    if (!format) throw badRequest("Unsupported file type — upload a .csv or .xlsx file");

    const parsed = await parseWhatsAppContactFile(
      req.file.buffer,
      format,
      whatsappConfig.defaultCountryCode,
    );

    let created = 0;
    let updated = 0;
    for (const row of parsed) {
      const data = {
        firstName: row.firstName || undefined,
        lastName: row.lastName || undefined,
        businessName: row.businessName || undefined,
      };
      const existing = await prisma.whatsAppContact.findUnique({ where: { phone: row.phone } });
      await prisma.whatsAppContact.upsert({
        where: { phone: row.phone },
        create: { phone: row.phone, ...data },
        update: data,
      });
      if (existing) updated++;
      else created++;
    }
    res.json({ created, updated, skipped: 0, total: parsed.length });
  }),
);

/* ---------------------------------------------------------------- templates */

whatsappRouter.get(
  "/templates",
  wrap(async (_req, res) => {
    res.json({
      items: await prisma.whatsAppTemplate.findMany({
        orderBy: { updatedAt: "desc" },
        include: { _count: { select: { batches: true } } },
      }),
    });
  }),
);

whatsappRouter.post(
  "/templates",
  wrap(async (req, res) => {
    const body = createWhatsAppTemplateInput.parse(req.body);
    res.status(201).json(await prisma.whatsAppTemplate.create({ data: body }));
  }),
);

whatsappRouter.get(
  "/templates/:id",
  wrap(async (req, res) => {
    const { id } = idParam.parse(req.params);
    const tpl = await prisma.whatsAppTemplate.findUnique({ where: { id } });
    if (!tpl) throw notFound("WhatsApp template");
    res.json(tpl);
  }),
);

whatsappRouter.put(
  "/templates/:id",
  wrap(async (req, res) => {
    const { id } = idParam.parse(req.params);
    const body = updateWhatsAppTemplateInput.parse(req.body);
    res.json(await prisma.whatsAppTemplate.update({ where: { id }, data: body }));
  }),
);

whatsappRouter.delete(
  "/templates/:id",
  wrap(async (req, res) => {
    const { id } = idParam.parse(req.params);
    const inUse = await prisma.whatsAppTemplate.findUnique({
      where: { id },
      include: { _count: { select: { batches: true } } },
    });
    if (!inUse) throw notFound("WhatsApp template");
    if (inUse._count.batches > 0) throw conflict("Template has send history and can't be deleted");
    await prisma.whatsAppTemplate.delete({ where: { id } });
    res.status(204).end();
  }),
);

/* ---------------------------------------------------------------- bulk send */

whatsappRouter.post(
  "/send",
  wrap(async (req, res) => {
    const { templateId, contactIds, source, purgeAfter } = sendWhatsAppBulkInput.parse(req.body);
    if (!isWhatsAppConfigured()) {
      throw new AppError(503, "WhatsApp is not configured — set it up in Settings", "unavailable");
    }
    const template = await prisma.whatsAppTemplate.findUnique({ where: { id: templateId } });
    if (!template) throw badRequest("templateId does not exist");

    let recipients;
    if (source === "whatsapp") {
      const rows = await prisma.whatsAppContact.findMany({ where: { id: { in: contactIds } } });
      recipients = rows.map((r) => ({
        whatsappContactId: r.id,
        phone: r.phone,
        firstName: r.firstName,
        lastName: r.lastName,
        businessName: r.businessName,
        status: r.status,
      }));
    } else {
      // Read-only seed from the email contacts table. Phone/name are snapshotted
      // into whatsapp_sends by createWhatsAppSendBatch; nothing here writes to or
      // triggers email logic.
      const rows = await prisma.contact.findMany({
        where: { id: { in: contactIds } },
        select: { id: true, phone: true, firstName: true, lastName: true, businessName: true },
      });
      recipients = rows.map((r) => ({
        whatsappContactId: null,
        phone: r.phone,
        firstName: r.firstName,
        lastName: r.lastName,
        businessName: r.businessName,
      }));
    }

    if (recipients.length === 0) throw badRequest("No matching contacts");
    const batchId = await createWhatsAppSendBatch({
      templateId,
      recipients,
      // Lead-gen purge: the recipient ids came in as whatsapp_contacts ids or
      // email contacts ids depending on `source`; delete from the matching table
      // once the batch finishes.
      ...(purgeAfter
        ? { purge: { table: source === "whatsapp" ? ("whatsapp" as const) : ("contact" as const), ids: contactIds } }
        : {}),
    });
    res.status(202).json({ batchId });
  }),
);

// Batch history for the Send Queue page (WhatsApp tab). Registered before the
// ":id" route so "/send/batches" isn't captured as an id.
whatsappRouter.get(
  "/send/batches",
  wrap(async (req, res) => {
    const { status } = sendBatchHistoryQuery.parse(req.query);
    res.json({ items: await listWhatsAppSendBatches(status) });
  }),
);

whatsappRouter.get(
  "/send/batches/:id",
  wrap(async (req, res) => {
    const view = await getWhatsAppBatchView(req.params.id);
    if (!view) throw notFound("WhatsApp send batch");
    res.json(view);
  }),
);
