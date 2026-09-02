import type { Express } from "express";
import { createBullBoard } from "@bull-board/api";
import { BullMQAdapter } from "@bull-board/api/bullMQAdapter";
import { ExpressAdapter } from "@bull-board/express";
import { allQueues } from "../queue/queues.js";
import { authRequired, requireRole } from "./middleware/auth.js";

/** Queue dashboard for ops, behind JWT admin, at /admin/queues. */
export function mountBullBoard(app: Express) {
  const serverAdapter = new ExpressAdapter();
  serverAdapter.setBasePath("/admin/queues");
  createBullBoard({
    // Adapter/bullmq minor-version type drift on JobProgress; runtime is fine.
    queues: allQueues.map((q) => new BullMQAdapter(q)) as never,
    serverAdapter,
  });
  app.use("/admin/queues", authRequired, requireRole("ADMIN"), serverAdapter.getRouter());
}
