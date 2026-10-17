// Settings → Branding: the display-only app name, stored in branding_settings.
//
// Only keys an admin changed have a row; a value equal to its default deletes the
// row, so an empty table always means today's text. Reading never fails: a
// missing table (migration 0024 not applied) or any DB error gives the defaults,
// so the sidebar can't break. Writes on a missing table are refused with a clear
// message instead of a 500.

import {
  BRANDING_DEFAULTS,
  BRANDING_KEYS,
  resolveBranding,
  type BrandingInput,
  type BrandingKey,
  type BrandingLabels,
} from "@dispatch/shared";
import { Prisma } from "@prisma/client";
import { prisma } from "../prisma.js";
import { logger } from "../logger.js";
import { AppError } from "../http/errors.js";

export interface BrandingView {
  labels: BrandingLabels;
  /** Keys whose saved value differs from the default. */
  customized: BrandingKey[];
}

const isMissingTable = (err: unknown) => {
  const raw = err as { code?: string; meta?: { code?: string } };
  return (
    (err instanceof Prisma.PrismaClientKnownRequestError && (err.code === "P2021" || err.code === "P2010")) ||
    raw?.code === "P2021" ||
    raw?.meta?.code === "1146"
  );
};

const TABLE_MISSING_MESSAGE = "Branding needs a database update — run `npm run prisma:deploy`. Default names are shown until then.";

let warnedMissing = false;
function warnMissingOnce() {
  if (warnedMissing) return;
  warnedMissing = true;
  logger.warn("branding_settings missing — run `npm run prisma:deploy` (0024_branding_settings); default names are shown");
}

function view(stored: Record<string, string>): BrandingView {
  const labels = resolveBranding(stored);
  return { labels, customized: BRANDING_KEYS.filter((k) => labels[k] !== BRANDING_DEFAULTS[k]) };
}

/** Saved names over the defaults. Never throws. */
export async function getBranding(): Promise<BrandingView> {
  try {
    const rows = await prisma.brandingSetting.findMany();
    return view(Object.fromEntries(rows.map((r) => [r.key, r.value])));
  } catch (err) {
    if (isMissingTable(err)) warnMissingOnce();
    else logger.warn({ err: err instanceof Error ? err.message : String(err) }, "branding unavailable — using default names");
    return view({});
  }
}

function rethrow(err: unknown): never {
  if (isMissingTable(err)) {
    warnMissingOnce();
    throw new AppError(503, TABLE_MISSING_MESSAGE, "branding_unavailable");
  }
  throw err;
}

/** Save the given keys (already validated). A value equal to its default removes the row. */
export async function setBranding(input: BrandingInput, userId: string): Promise<BrandingView> {
  const entries = BRANDING_KEYS.flatMap((k) => {
    const v = input.labels[k];
    return v === undefined ? [] : [[k, v] as const];
  });
  try {
    await prisma.$transaction(
      entries.map(([key, value]) =>
        value === BRANDING_DEFAULTS[key]
          ? prisma.brandingSetting.deleteMany({ where: { key } })
          : prisma.brandingSetting.upsert({
              where: { key },
              create: { key, value, updatedBy: userId },
              update: { value, updatedBy: userId },
            }),
      ),
    );
  } catch (err) {
    rethrow(err);
  }
  logger.info({ by: userId, keys: entries.map(([k]) => k) }, "branding saved");
  return getBranding();
}

/** Back to the default text: one key, or every key when none is given. */
export async function resetBranding(userId: string, key?: BrandingKey): Promise<BrandingView> {
  try {
    await prisma.brandingSetting.deleteMany({ where: key ? { key } : {} });
  } catch (err) {
    rethrow(err);
  }
  logger.info({ by: userId, keys: key ? [key] : "all" }, "branding reset");
  return getBranding();
}
