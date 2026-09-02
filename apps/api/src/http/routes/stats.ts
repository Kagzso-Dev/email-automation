import { Router } from "express";
import { idParam } from "@dispatch/shared";
import { authRequired } from "../middleware/auth.js";
import { campaignStats, dashboardOverview, triggerStats } from "../../domain/stats.service.js";
import { todaysCount } from "../../queue/dailyCap.js";
import { env } from "../../env.js";
import { wrap } from "../errors.js";

export const statsRouter = Router();
statsRouter.use(authRequired);

statsRouter.get(
  "/campaigns/:id/stats",
  wrap(async (req, res) => {
    const { id } = idParam.parse(req.params);
    res.json(await campaignStats(id));
  }),
);

statsRouter.get(
  "/triggers/:id/stats",
  wrap(async (req, res) => {
    const { id } = idParam.parse(req.params);
    res.json(await triggerStats(id));
  }),
);

statsRouter.get(
  "/dashboard/overview",
  wrap(async (_req, res) => {
    const [overview, sentInWindow] = await Promise.all([dashboardOverview(), todaysCount()]);
    res.json({ ...overview, dailyCap: { used: sentInWindow, limit: env.SEND_DAILY_CAP } });
  }),
);
