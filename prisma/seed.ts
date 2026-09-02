import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";

const prisma = new PrismaClient();

async function main() {
  const email = (process.env.SEED_ADMIN_EMAIL ?? "admin@example.com").toLowerCase();
  const password = process.env.SEED_ADMIN_PASSWORD ?? "changeme12345";

  const admin = await prisma.user.upsert({
    where: { email },
    create: { email, passwordHash: await bcrypt.hash(password, 12), role: "ADMIN" },
    update: {},
  });
  console.log(`admin user: ${admin.email} (${admin.role})`);

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

  console.log("seed complete");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
