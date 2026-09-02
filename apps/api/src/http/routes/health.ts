import { Router } from "express";
import { prisma } from "../../prisma.js";
import { redis } from "../../redis.js";

export const healthRouter = Router();

healthRouter.get("/", async (_req, res) => {
  const checks: Record<string, "ok" | "fail"> = { db: "fail", redis: "fail" };
  try {
    await prisma.$queryRaw`SELECT 1`;
    checks.db = "ok";
  } catch {
    /* left as fail */
  }
  try {
    const pong = await redis.ping();
    if (pong === "PONG") checks.redis = "ok";
  } catch {
    /* left as fail */
  }
  const healthy = Object.values(checks).every((v) => v === "ok");
  res.status(healthy ? 200 : 503).json({ status: healthy ? "ok" : "degraded", checks });
});
