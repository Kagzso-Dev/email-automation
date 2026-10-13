// Trial numbers for the Call Flows "Test call to my number" popup.
//
// Allowed numbers = saved rows in ai_call_test_numbers (not soft-deleted) PLUS
// AI_CALL_FLOW_TEST_NUMBERS, deduped. The popup only ever sends an id from this
// list; resolveTestNumber() turns it back into the E.164 number server-side.
// Until migration 0023 is applied the table is missing: listing falls back to
// the env numbers, adding/removing is refused with a clear message (never a 500).

import { createHash } from "node:crypto";
import { MAX_TEST_CALL_NUMBERS, maskTestCallNumber, normalizePhoneE164, type TestCallNumber } from "@dispatch/shared";
import { Prisma } from "@prisma/client";
import { prisma } from "../prisma.js";
import { logger } from "../logger.js";
import { aiCallsConfig } from "../config/aiCalls.js";

export class TestNumberError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export const TABLE_MISSING_MESSAGE =
  "Trial numbers need a database update — run `npm run prisma:deploy`. Numbers in AI_CALL_FLOW_TEST_NUMBERS still work.";

const isMissingTable = (err: unknown) => {
  const raw = err as { code?: string; meta?: { code?: string } };
  return (
    (err instanceof Prisma.PrismaClientKnownRequestError && (err.code === "P2021" || err.code === "P2010")) ||
    raw?.code === "P2021" ||
    raw?.meta?.code === "1146"
  );
};
let warnedMissing = false;
function missingTable(err: unknown): void {
  if (!isMissingTable(err)) throw err;
  if (!warnedMissing) {
    warnedMissing = true;
    logger.warn("ai_call_test_numbers missing — run `npm run prisma:deploy` (0023_ai_call_test_numbers); only AI_CALL_FLOW_TEST_NUMBERS can be test-called");
  }
}

const envId = (phone: string) => `env:${createHash("sha256").update(phone).digest("hex").slice(0, 12)}`;

interface Entry {
  id: string;
  phone: string;
  label: string | null;
  source: "saved" | "env";
}

async function allowedEntries(): Promise<{ entries: Entry[]; tableMissing: boolean }> {
  let tableMissing = false;
  const saved = await prisma.aiCallTestNumber
    .findMany({ where: { deletedAt: null }, orderBy: { createdAt: "asc" } })
    .catch((err: unknown) => {
      missingTable(err);
      tableMissing = true;
      return [];
    });
  const entries: Entry[] = saved.map((r) => ({ id: `db:${r.id}`, phone: r.phone, label: r.label, source: "saved" }));
  const seen = new Set(entries.map((e) => e.phone));
  for (const phone of aiCallsConfig.flowTestNumbers) {
    if (seen.has(phone)) continue;
    seen.add(phone);
    entries.push({ id: envId(phone), phone, label: null, source: "env" });
  }
  return { entries, tableMissing };
}

const toPublic = ({ id, phone, label, source }: Entry): TestCallNumber => ({ id, masked: maskTestCallNumber(phone), label, source });

export async function listTestNumbers(): Promise<{ items: TestCallNumber[]; max: number; tableMissing: boolean }> {
  const { entries, tableMissing } = await allowedEntries();
  return { items: entries.map(toPublic), max: MAX_TEST_CALL_NUMBERS, tableMissing };
}

/** The E.164 number behind an id from listTestNumbers(), or null if it isn't (or is no longer) allowed. */
export async function resolveTestNumber(numberId: string): Promise<string | null> {
  if (!numberId.startsWith("db:") && !numberId.startsWith("env:")) return null;
  const { entries } = await allowedEntries();
  return entries.find((e) => e.id === numberId)?.phone ?? null;
}

export async function addTestNumber(raw: string, label: string | null | undefined, by: string): Promise<{ item: TestCallNumber; phone: string }> {
  const phone = normalizePhoneE164(raw, aiCallsConfig.defaultCountryCode);
  if (!phone) throw new TestNumberError(400, "Enter a valid mobile number — 10 digits, e.g. 98765 43210 (+91 is added for you)");
  const cleanLabel = label?.trim() || null;
  try {
    const existing = await prisma.aiCallTestNumber.findUnique({ where: { phone } });
    if ((existing && !existing.deletedAt) || aiCallsConfig.flowTestNumbers.includes(phone)) {
      throw new TestNumberError(409, "That number is already a trial number");
    }
    const live = await prisma.aiCallTestNumber.count({ where: { deletedAt: null } });
    if (live >= MAX_TEST_CALL_NUMBERS) {
      throw new TestNumberError(400, `You can save up to ${MAX_TEST_CALL_NUMBERS} trial numbers — remove one first`);
    }
    // One row per number (phone is unique): a removed number is brought back rather than re-inserted.
    const row = existing
      ? await prisma.aiCallTestNumber.update({ where: { id: existing.id }, data: { deletedAt: null, label: cleanLabel, createdBy: by } })
      : await prisma.aiCallTestNumber.create({ data: { phone, label: cleanLabel, createdBy: by } });
    return { item: toPublic({ id: `db:${row.id}`, phone, label: row.label, source: "saved" }), phone };
  } catch (err) {
    if (err instanceof TestNumberError) throw err;
    if ((err as { code?: string })?.code === "P2002") throw new TestNumberError(409, "That number is already a trial number");
    if (isMissingTable(err)) {
      missingTable(err);
      throw new TestNumberError(503, TABLE_MISSING_MESSAGE);
    }
    throw err;
  }
}

export async function removeTestNumber(numberId: string): Promise<{ phone: string }> {
  if (numberId.startsWith("env:")) {
    throw new TestNumberError(400, "This number comes from AI_CALL_FLOW_TEST_NUMBERS in the API's .env — remove it there");
  }
  const id = numberId.startsWith("db:") ? numberId.slice(3) : "";
  if (!id) throw new TestNumberError(404, "Trial number not found");
  try {
    const row = await prisma.aiCallTestNumber.findUnique({ where: { id } });
    if (!row || row.deletedAt) throw new TestNumberError(404, "Trial number not found");
    await prisma.aiCallTestNumber.update({ where: { id }, data: { deletedAt: new Date() } });
    return { phone: row.phone };
  } catch (err) {
    if (err instanceof TestNumberError) throw err;
    if (isMissingTable(err)) {
      missingTable(err);
      throw new TestNumberError(503, TABLE_MISSING_MESSAGE);
    }
    throw err;
  }
}
