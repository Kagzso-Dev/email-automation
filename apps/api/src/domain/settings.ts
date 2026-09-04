import { Prisma } from "@prisma/client";
import { prisma } from "../prisma.js";
import { env } from "../env.js";

/**
 * Tiny key-value store for operator-tunable settings that would otherwise be
 * hardcoded or env-only. Values are JSON so one key can hold a small object.
 */
export async function getSetting<T>(key: string, fallback: T): Promise<T> {
  const row = await prisma.setting.findUnique({ where: { key } });
  return row ? (row.value as T) : fallback;
}

export async function setSetting(key: string, value: unknown): Promise<void> {
  const json = value as Prisma.InputJsonValue;
  await prisma.setting.upsert({
    where: { key },
    create: { key, value: json },
    update: { value: json },
  });
}

/* ------------------------------------------------------------- bulk send pacing */

export const BULK_SEND_KEY = "bulkSendJitter";

export interface BulkSendDelays {
  minDelaySec: number;
  maxDelaySec: number;
}

/** Force `1 <= min <= max <= 3600`. */
export function clampDelayRange(min: number, max: number): BulkSendDelays {
  const lo = Math.min(3600, Math.max(1, Math.round(min || 1)));
  const hi = Math.min(3600, Math.max(1, Math.round(max || 1)));
  return lo <= hi
    ? { minDelaySec: lo, maxDelaySec: hi }
    : { minDelaySec: hi, maxDelaySec: lo };
}

/** Stored delay range, or the env-seeded defaults when nothing is stored. */
export async function getBulkSendDelays(): Promise<BulkSendDelays> {
  const stored = await getSetting<Partial<BulkSendDelays> | null>(BULK_SEND_KEY, null);
  return clampDelayRange(
    stored?.minDelaySec ?? env.BULK_SEND_MIN_DELAY_SEC,
    stored?.maxDelaySec ?? env.BULK_SEND_MAX_DELAY_SEC,
  );
}

export async function setBulkSendDelays(range: BulkSendDelays): Promise<BulkSendDelays> {
  const clean = clampDelayRange(range.minDelaySec, range.maxDelaySec);
  await setSetting(BULK_SEND_KEY, clean);
  return clean;
}
