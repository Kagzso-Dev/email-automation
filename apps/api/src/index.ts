import "./http/types.js";
import { env } from "./env.js";
import { logger } from "./logger.js";
import { prisma } from "./prisma.js";
import { createApp } from "./http/app.js";
import { initSentry } from "./observability/sentry.js";

initSentry("api");

const app = createApp();
const server = app.listen(env.API_PORT, () => {
  logger.info(
    { port: env.API_PORT, provider: env.EMAIL_PROVIDER, env: env.NODE_ENV },
    "API listening",
  );
});

server.on("error", (err: NodeJS.ErrnoException) => {
  if (err.code === "EADDRINUSE") {
    logger.error(
      { port: env.API_PORT },
      `Port ${env.API_PORT} is already in use — another API or dev instance is ` +
        "already running. Stop it (on Windows: `npm run dev:kill`) and retry. " +
        "The API port is fixed on purpose; do not change API_PORT to work around this.",
    );
    process.exit(1);
  }
  throw err;
});

async function shutdown(signal: string) {
  logger.info({ signal }, "shutting down API");
  server.close();
  await prisma.$disconnect();
  process.exit(0);
}
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
