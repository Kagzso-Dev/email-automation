import { Router } from "express";
import { createApiKeyInput, idParam } from "@dispatch/shared";
import { prisma } from "../../prisma.js";
import { createApiKey } from "../../domain/apiKeys.service.js";
import { authRequired, requireRole } from "../middleware/auth.js";
import { wrap } from "../errors.js";

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

apiKeysRouter.post(
  "/",
  wrap(async (req, res) => {
    const { name } = createApiKeyInput.parse(req.body);
    // `key` (the raw value) is present in this response only, never again.
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
