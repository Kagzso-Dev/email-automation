import express from "express";
import cookieParser from "cookie-parser";
import cors from "cors";
import { pinoHttp } from "pino-http";
import { randomUUID } from "node:crypto";
import { env } from "../env.js";
import { logger } from "../logger.js";
import { errorHandler } from "./errors.js";
import { authRouter } from "./routes/auth.js";
import { contactsRouter } from "./routes/contacts.js";
import { listsRouter } from "./routes/lists.js";
import { templatesRouter } from "./routes/templates.js";
import { campaignsRouter } from "./routes/campaigns.js";
import { triggersRouter } from "./routes/triggers.js";
import { webhooksRouter } from "./routes/webhooks.js";
import { trackRouter } from "./routes/track.js";
import { unsubscribeRouter } from "./routes/unsubscribe.js";
import { apiKeysRouter } from "./routes/apiKeys.js";
import { healthRouter } from "./routes/health.js";
import { statsRouter } from "./routes/stats.js";
import { jobsRouter } from "./routes/jobs.js";

export function createApp() {
  const app = express();
  app.set("trust proxy", 1);

  app.use((req, _res, next) => {
    req.id = (req.headers["x-request-id"] as string) || randomUUID();
    next();
  });
  app.use(
    pinoHttp({
      logger,
      genReqId: (req) => (req as express.Request).id,
      autoLogging: { ignore: (req) => req.url === "/health" },
    }),
  );
  app.use(cors({ origin: env.WEB_ORIGIN.split(","), credentials: true }));
  app.use(cookieParser());
  // SES/SNS posts text/plain; capture the raw body for that route only.
  app.use("/api/webhooks/ses", express.text({ type: () => true, limit: "1mb" }));
  app.use(express.json({ limit: "2mb" }));
  app.use(express.urlencoded({ extended: false }));

  app.use("/health", healthRouter);
  app.use("/api/auth", authRouter);
  app.use("/api/contacts", contactsRouter);
  app.use("/api/lists", listsRouter);
  app.use("/api/templates", templatesRouter);
  app.use("/api/campaigns", campaignsRouter);
  app.use("/api/triggers", triggersRouter);
  app.use("/api/webhooks", webhooksRouter);
  app.use("/api/track", trackRouter);
  app.use("/api/unsubscribe", unsubscribeRouter);
  app.use("/api/api-keys", apiKeysRouter);
  app.use("/api/jobs", jobsRouter);
  app.use("/api", statsRouter);

  app.use(errorHandler);
  return app;
}
