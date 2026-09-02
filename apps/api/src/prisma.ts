import { PrismaClient } from "@prisma/client";
import { buildDatabaseUrl } from "../../../scripts/db-url.mjs";
import { env } from "./env.js";

export const prisma = new PrismaClient({
  // Connection URL is composed from the discrete DB_* env vars (see scripts/db-url.mjs).
  datasourceUrl: buildDatabaseUrl(),
  log: env.NODE_ENV === "development" ? ["warn", "error"] : ["error"],
});

export type { Prisma } from "@prisma/client";
