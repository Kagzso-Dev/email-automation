// Wrapper so the Prisma CLI (generate / migrate / studio) gets a DATABASE_URL
// composed from the discrete DB_* variables. Used by the `prisma:*` npm
// scripts — run those, not bare `npx prisma`.
//
// The Prisma schema still reads `env("DATABASE_URL")` because a datasource
// must; this is the one spot that provides it for CLI commands.

import { spawnSync } from "node:child_process";
import { config as loadEnv } from "dotenv";
import { buildDatabaseUrl } from "./db-url.mjs";

loadEnv(); // repo-root .env

process.env.DATABASE_URL = buildDatabaseUrl();

const args = process.argv.slice(2);
const result = spawnSync("prisma", args, {
  stdio: "inherit",
  shell: true,
  env: process.env,
});

process.exit(result.status ?? 1);
