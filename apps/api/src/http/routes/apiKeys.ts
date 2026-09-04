import { Router } from "express";
import { createApiKeyInput, idParam } from "@dispatch/shared";
import { prisma } from "../../prisma.js";
import { createApiKey } from "../../domain/apiKeys.service.js";
import { authRequired, requireRole } from "../middleware/auth.js";
import { notFound, wrap } from "../errors.js";

export const apiKeysRouter = Router();
apiKeysRouter.use(authRequired, requireRole("ADMIN"));

apiKeysRouter.get(
  "/",
  wrap(async (_req, res) => {
    res.json({
      items: await prisma.apiKey.findMany({
        orderBy: { createdAt: "desc" },
        select: { id: true, name: true, prefix: true, lastUsed: true, createdAt: true },
      }),
    });
  }),
);

apiKeysRouter.get(
  "/:id/reveal",
  wrap(async (req, res) => {
    const { id } = idParam.parse(req.params);
    const key = await prisma.apiKey.findUnique({ where: { id }, select: { rawKey: true } });
    if (!key) throw notFound("API key");
    if (!key.rawKey) throw notFound("Stored key value (created before key storage was enabled)");
    res.json({ key: key.rawKey });
  }),
);

apiKeysRouter.post(
  "/",
  wrap(async (req, res) => {
    const { name } = createApiKeyInput.parse(req.body);
    res.status(201).json(await createApiKey(name));
  }),
);

apiKeysRouter.delete(
  "/:id",
  wrap(async (req, res) => {
    const { id } = idParam.parse(req.params);
    await prisma.apiKey.delete({ where: { id } });
    res.status(204).end();
  }),
);
