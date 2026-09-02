import { Router } from "express";
import { logger } from "../../logger.js";
import { recordClick, recordOpen } from "../../domain/tracking.js";
import { verify } from "../../render/signing.js";
import { wrap } from "../errors.js";

export const trackRouter = Router();

// 1×1 transparent GIF.
const PIXEL = Buffer.from(
  "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7",
  "base64",
);

trackRouter.get(
  "/open/:logId.png",
  wrap(async (req, res) => {
    const logId = req.params.logId.replace(/\.png$/, "");
    recordOpen(logId).catch((err) => logger.error({ err, logId }, "recordOpen failed"));
    res.setHeader("Content-Type", "image/gif");
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, private");
    res.setHeader("Pragma", "no-cache");
    res.end(PIXEL);
  }),
);

trackRouter.get(
  "/click/:logId",
  wrap(async (req, res) => {
    const { logId } = req.params;
    const url = typeof req.query.u === "string" ? req.query.u : "";
    const sig = typeof req.query.s === "string" ? req.query.s : "";
    if (!url || !sig || !verify(url, sig)) {
      return res.status(400).send("Invalid or unsigned tracking link");
    }
    if (!/^https?:\/\//i.test(url)) return res.status(400).send("Bad target");
    recordClick(logId).catch((err) => logger.error({ err, logId }, "recordClick failed"));
    res.redirect(302, url);
  }),
);
