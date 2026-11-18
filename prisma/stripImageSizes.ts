// Only needed before REVERTING the image size controls code (ENABLE_IMAGE_SIZE_CONTROLS). Turning the flag
// off does NOT need this: stored sizes are then simply ignored.
//
// The feature stores an image as { url, size, alt, naturalWidth, name } inside templates.images. Code from
// before the feature only understands plain URL strings, so this turns every such object back into its
// URL. Read-only unless --apply.
//
//   npm run images:strip-sizes:plan                lists the templates that would change, writes nothing
//   npm run images:strip-sizes                     changes them; saves the old images JSON to restore-logs/
//   npm run images:strip-sizes -- --undo <file>    puts exactly that JSON back (skips templates edited since)
//
// Only templates.images changes. Plain URL strings, the image order, placeholders and every other
// column stay as they are; nothing is deleted. Running it again finds nothing (idempotent).

import "dotenv/config";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { Prisma, PrismaClient } from "@prisma/client";
import { buildDatabaseUrl } from "../scripts/db-url.mjs";

const prisma = new PrismaClient({ datasourceUrl: buildDatabaseUrl() });
const args = process.argv.slice(2);
const apply = args.includes("--apply");
const undoAt = args.indexOf("--undo");
const undoFile = undoAt >= 0 ? (args[undoAt + 1] ?? null) : null;

/** Plain URLs for every entry, or null when nothing would change. */
function stripped(images: unknown): string[] | null {
  if (!Array.isArray(images)) return null;
  if (!images.some((e) => e && typeof e === "object")) return null;
  return images.flatMap((e) =>
    typeof e === "string" ? [e] : e && typeof e === "object" && typeof (e as { url?: unknown }).url === "string" ? [(e as { url: string }).url] : [],
  );
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

async function main() {
  if (undoFile) {
    const log = JSON.parse(readFileSync(undoFile, "utf8")) as {
      templates: Array<{ id: string; before: unknown; after: string[] }>;
    };
    let restored = 0;
    for (const t of log.templates) {
      const now = await prisma.template.findUnique({ where: { id: t.id }, select: { images: true } });
      if (!now || !same(now.images, t.after)) {
        console.log(`  skipped ${t.id}: missing or edited since`);
        continue;
      }
      await prisma.template.update({ where: { id: t.id }, data: { images: t.before as Prisma.InputJsonValue } });
      restored++;
    }
    console.log(`Undo: ${restored} template(s) restored (from ${undoFile}).`);
    return;
  }

  const rows = await prisma.template.findMany({
    select: { id: true, name: true, images: true },
    orderBy: { name: "asc" },
  });
  const changes = rows.flatMap((r) => {
    const after = stripped(r.images);
    return after ? [{ id: r.id, name: r.name, before: r.images, after }] : [];
  });

  console.log(`\n${apply ? "STRIPPING IMAGE SIZES" : "DRY RUN — nothing is written"}`);
  console.log(`Templates with image sizes / alt texts: ${changes.length}`);
  for (const c of changes) console.log(`  - ${c.name} (${c.id}): ${c.after.length} image(s)`);
  if (!apply) {
    console.log(changes.length ? "\nTo strip them: npm run images:strip-sizes\n" : "\nNothing to do.\n");
    return;
  }
  if (!changes.length) return;

  for (const c of changes) {
    await prisma.template.update({ where: { id: c.id }, data: { images: c.after } });
  }
  mkdirSync("restore-logs", { recursive: true });
  const file = `restore-logs/image-sizes-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  writeFileSync(file, JSON.stringify({ at: new Date().toISOString(), templates: changes }, null, 2));
  console.log(`\nStripped ${changes.length} template(s). Undo with: npm run images:strip-sizes -- --undo ${file}\n`);
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
