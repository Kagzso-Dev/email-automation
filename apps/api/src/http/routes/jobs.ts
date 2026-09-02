import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../prisma.js";
import { authRequired, requireRole } from "../middleware/auth.js";
import { notFound, wrap } from "../errors.js";

/** Lightweight ops view of the MySQL-backed job queue (replaces Bull Board). */
export const jobsRouter = Router();
jobsRouter.use(authRequired, requireRole("ADMIN"));

const query = z.object({
  queue: z.string().optional(),
  status: z.enum(["PENDING", "ACTIVE", "COMPLETED", "FAILED", "DEAD"]).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

jobsRouter.get(
  "/",
  wrap(async (req, res) => {
    const q = query.parse(req.query);
    const where = {
      ...(q.queue ? { queue: q.queue } : {}),
      ...(q.status ? { status: q.status } : {}),
    };
    const [items, counts] = await Promise.all([
      prisma.job.findMany({ where, orderBy: { updatedAt: "desc" }, take: q.limit }),
      prisma.job.groupBy({ by: ["queue", "status"], _count: { _all: true } }),
    ]);
    res.json({ items, counts });
  }),
);

jobsRouter.post(
  "/:id/retry",
  wrap(async (req, res) => {
    const job = await prisma.job.findUnique({ where: { id: req.params.id } });
    if (!job) throw notFound("Job");
    res.json(
      await prisma.job.update({
        where: { id: job.id },
        data: { status: "PENDING", runAt: new Date(), attempts: 0, lastError: null, lockedAt: null },
      }),
    );
  }),
);
