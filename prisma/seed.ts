import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import { buildDatabaseUrl } from "../scripts/db-url.mjs";
import { ensureAdmin, planAdmin } from "./seedAdmin.js";
import { checkSeedGuard } from "./seedGuard.js";

const prisma = new PrismaClient({ datasourceUrl: buildDatabaseUrl() });

// --dry-run: connect, check the guard, print the plan, write nothing.
const dryRun = process.argv.includes("--dry-run");

const SAMPLE_CONTACT_EMAILS = ["ada@example.com", "grace@example.com", "linus@example.com"];

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value || !value.trim()) {
    console.error(
      `\n✗ Missing required environment variable: ${name}\n` +
        `  Set it in .env (see .env.example) before running the seed.\n`,
    );
    process.exit(1);
  }
  return value.trim();
}

/** Returns the database the connection actually landed on (SELECT DATABASE()). */
async function verifyConnection(): Promise<string | null> {
  const host = process.env.DB_HOST || "localhost";
  const port = process.env.DB_PORT || "3306";
  const name = process.env.DB_NAME || "dispatch";
  try {
    await prisma.$queryRaw`SELECT 1`;
  } catch (err) {
    console.error(
      `\n✗ Could not connect to MySQL at ${host}:${port}/${name}\n` +
        `  Check DB_HOST / DB_PORT / DB_NAME / DB_USER / DB_PASSWORD in .env,\n` +
        `  and that the database exists:\n` +
        `    mysql -u root -p -e "CREATE DATABASE IF NOT EXISTS ${name} CHARACTER SET utf8mb4;"\n`,
    );
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  }
  const [row] = await prisma.$queryRaw<{ db: string | null }[]>`SELECT DATABASE() AS db`;
  // Never logs DB_PASSWORD.
  console.log(`✓ MySQL connection successful — ${row?.db ?? "(no database)"} @ ${host}:${port}`);
  return row?.db ?? null;
}

/** Read-only: one line per sample record saying whether it would be created or skipped. */
async function planSampleData(): Promise<string[]> {
  const mark = (exists: unknown) => (exists ? "skip (exists)" : "create");
  const lines = [
    `template seed-welcome: ${mark(await prisma.template.findUnique({ where: { id: "seed-welcome" } }))}`,
    `list seed-list: ${mark(await prisma.list.findUnique({ where: { id: "seed-list" } }))}`,
  ];
  for (const e of SAMPLE_CONTACT_EMAILS) {
    lines.push(`contact ${e}: ${mark(await prisma.contact.findUnique({ where: { email: e } }))} (+ list membership if missing)`);
  }
  lines.push(`trigger user.signup: ${mark(await prisma.trigger.findUnique({ where: { eventKey: "user.signup" } }))}`);
  return lines;
}

async function main() {
  const connectedDatabase = await verifyConnection();

  const guard = checkSeedGuard({ env: process.env, connectedDatabase, dryRun });
  if (!guard.ok) {
    console.error(`\n✗ Seed refused: ${guard.reason}\n  Nothing was written.\n`);
    process.exit(1);
  }

  const email = requireEnv("SEED_ADMIN_EMAIL").toLowerCase();
  const reset = process.env.SEED_ADMIN_RESET === "true";
  const sampleData = process.env.SEED_SAMPLE_DATA === "true";

  // Print the plan before any write, in both modes.
  const adminPlan = await planAdmin(prisma, { email, reset });
  console.log(`\nSeed plan for database "${connectedDatabase}":`);
  console.log(
    `  admin user ${adminPlan.email}: ` +
      {
        create: "create (role ADMIN)",
        skip: `skip — already exists (${adminPlan.role}); password and role left unchanged`,
        reset: `RESET PASSWORD — already exists (${adminPlan.role}); role kept (SEED_ADMIN_RESET=true)`,
      }[adminPlan.action],
  );
  if (sampleData) {
    for (const line of await planSampleData()) console.log(`  sample ${line}`);
  } else {
    console.log("  sample data: none (SEED_SAMPLE_DATA is not true)");
  }

  if (dryRun) {
    console.log("\n✓ dry run — no changes written");
    return;
  }
  console.log("");

  const password = requireEnv("SEED_ADMIN_PASSWORD");

  // Never logs the password. An existing user's password is only replaced
  // when SEED_ADMIN_RESET=true is set explicitly.
  const admin = await ensureAdmin(prisma, {
    email,
    password,
    reset,
  });
  const note = {
    created: "created",
    unchanged: "already exists — password left unchanged (set SEED_ADMIN_RESET=true to reset it)",
    reset: "already exists — password reset from SEED_ADMIN_PASSWORD",
  }[admin.action];
  console.log(`✓ admin user: ${admin.email} (${admin.role}) ${note}`);

  // Sample content (demo list, template, contacts, trigger) is only inserted
  // when SEED_SAMPLE_DATA=true. Production instances seed the admin only.
  if (!sampleData) {
    console.log("✓ seed complete (admin only — set SEED_SAMPLE_DATA=true for demo content)");
    return;
  }

  const template = await prisma.template.upsert({
    where: { id: "seed-welcome" },
    create: {
      id: "seed-welcome",
      name: "Welcome email",
      subject: "Welcome, {{first_name}}",
      bodyText:
        "Hi {{first_name}},\n\nThanks for joining. Visit https://example.com/start to get started.",
      signature: "Best regards,\nThe Team",
      htmlBody:
        "<p>Hi {{first_name}},</p>\n<p>Thanks for joining. Visit https://example.com/start to get started.</p>\n<div style=\"margin-top:24px\"><p>Best regards,<br>\nThe Team</p></div>",
      textBody: "Welcome, {{first_name}}! Thanks for joining. https://example.com/start",
      variables: ["first_name"],
    },
    update: {},
  });

  const list = await prisma.list.upsert({
    where: { id: "seed-list" },
    create: { id: "seed-list", name: "Newsletter", description: "Seed list" },
    update: {},
  });

  for (const [i, e] of SAMPLE_CONTACT_EMAILS.entries()) {
    const c = await prisma.contact.upsert({
      where: { email: e },
      create: { email: e, firstName: e.split("@")[0], lastName: `Test${i}`, customFields: {} },
      update: {},
    });
    await prisma.listMembership.upsert({
      where: { listId_contactId: { listId: list.id, contactId: c.id } },
      create: { listId: list.id, contactId: c.id },
      update: {},
    });
  }

  await prisma.trigger.upsert({
    where: { eventKey: "user.signup" },
    create: {
      name: "On signup",
      eventKey: "user.signup",
      templateId: template.id,
      conditions: [],
      active: true,
    },
    update: {},
  });

  console.log("✓ seed complete (idempotent — safe to re-run)");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
