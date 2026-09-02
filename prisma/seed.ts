import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";
import { buildDatabaseUrl } from "../scripts/db-url.mjs";

const prisma = new PrismaClient({ datasourceUrl: buildDatabaseUrl() });

// bcrypt cost — matches hashPassword() in apps/api/src/domain/auth.service.ts.
const BCRYPT_COST = 12;

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

async function verifyConnection() {
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
  // Never logs DB_PASSWORD.
  console.log(`✓ MySQL connection successful — ${name} @ ${host}:${port}`);
}

async function main() {
  await verifyConnection();

  const email = requireEnv("SEED_ADMIN_EMAIL").toLowerCase();
  const password = requireEnv("SEED_ADMIN_PASSWORD");

  const admin = await prisma.user.upsert({
    where: { email },
    create: { email, passwordHash: await bcrypt.hash(password, BCRYPT_COST), role: "ADMIN" },
    update: {}, // idempotent — an existing admin's password is left untouched
  });
  console.log(`✓ admin user: ${admin.email} (${admin.role})`);

  const template = await prisma.template.upsert({
    where: { id: "seed-welcome" },
    create: {
      id: "seed-welcome",
      name: "Welcome email",
      subject: "Welcome, {{first_name}}",
      htmlBody:
        "<h1>Welcome, {{first_name}}!</h1><p>Thanks for joining. <a href=\"https://example.com/start\">Get started</a>.</p>",
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

  for (const [i, e] of ["ada@example.com", "grace@example.com", "linus@example.com"].entries()) {
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
