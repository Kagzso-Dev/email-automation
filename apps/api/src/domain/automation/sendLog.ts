// The Automation tables (migration 0041, ENABLE_AUTOMATION): every DM attempt (sent / failed / blocked) and every
// campaign create / pause / resume. Only automation_dm_sends and automation_campaign_actions are read or written.
// No foreign key: the user is kept as a snapshot (id + email), so deleting a user is unaffected.

import { createHmac, createHash, timingSafeEqual } from "node:crypto";
import { prisma } from "../../prisma.js";
import { AppError } from "../../http/errors.js";

export const NEEDS_MIGRATION =
  "Automation needs a database update — run `npm run prisma:deploy` (migration 0041_automation), then reload.";

export const isMissingTable = (err: unknown) => {
  const raw = err as { code?: string; meta?: { code?: string } } | null;
  return raw?.code === "P2021" || raw?.meta?.code === "1146";
};

/** Fails with 503 (what to run) before anything is sent, when migration 0041 isn't applied. */
export async function ensureTables(): Promise<void> {
  try {
    await prisma.automationDmSend.findFirst({ select: { id: true } });
    await prisma.automationCampaignAction.findFirst({ select: { id: true } });
  } catch (err) {
    if (isMissingTable(err)) throw new AppError(503, NEEDS_MIGRATION, "needs_migration");
    throw err;
  }
}

export interface Actor {
  id: string;
  email: string;
}

export interface DmLogRow {
  platform: "instagram" | "linkedin";
  batchId: string;
  recipientId: string;
  recipientName: string | null;
  message: string;
  messageTag: string | null;
  windowState: string;
  status: "sent" | "failed" | "blocked";
  providerMessageId?: string | null;
  errorCode?: string | null;
  errorMessage?: string | null;
}

const clip = (s: string | null | undefined, n: number) => (s ? (s.length > n ? s.slice(0, n) : s) : null);

export async function logDm(row: DmLogRow, actor: Actor): Promise<void> {
  await prisma.automationDmSend.create({
    data: {
      ...row,
      recipientName: clip(row.recipientName, 255),
      providerMessageId: clip(row.providerMessageId, 191),
      errorCode: clip(row.errorCode, 64),
      errorMessage: clip(row.errorMessage, 1000),
      sentById: actor.id,
      sentByEmail: actor.email,
    },
  });
}

export async function logCampaignAction(
  row: { platform: "instagram" | "linkedin"; campaignId: string | null; campaignName: string | null; action: "create" | "pause" | "resume"; status: "ok" | "failed"; errorCode?: string | null; errorMessage?: string | null },
  actor: Actor,
): Promise<void> {
  await prisma.automationCampaignAction.create({
    data: {
      ...row,
      campaignName: clip(row.campaignName, 255),
      errorCode: clip(row.errorCode, 64),
      errorMessage: clip(row.errorMessage, 1000),
      actorId: actor.id,
      actorEmail: actor.email,
    },
  });
}

export async function dmHistory(platform: "instagram" | "linkedin", page: number, pageSize: number) {
  const where = { platform };
  const [items, total] = await Promise.all([
    prisma.automationDmSend.findMany({ where, orderBy: { createdAt: "desc" }, skip: (page - 1) * pageSize, take: pageSize }),
    prisma.automationDmSend.count({ where }),
  ]);
  return { items, total, page, pageSize };
}

/* ------------------------------------------------------------- the confirm step */

// The preview answers with a short-lived signed token for exactly these recipients, this message, this tag choice and
// this sendable count. A send without a matching token (or with a different count) is refused, so nothing goes out
// without the confirm step having shown the recipient count.

export const CONFIRM_TTL_MS = 10 * 60_000;

function confirmKey(): Buffer {
  return createHash("sha256").update(`automation-dm-confirm:${process.env.JWT_ACCESS_SECRET ?? ""}`).digest();
}

interface ConfirmPayload {
  userId: string;
  recipientIds: string[];
  message: string;
  useHumanAgentTag: boolean;
  count: number;
}

function digest(p: ConfirmPayload, exp: number): string {
  const body = JSON.stringify([p.userId, [...p.recipientIds].sort(), createHash("sha256").update(p.message).digest("hex"), p.useHumanAgentTag, p.count, exp]);
  return createHmac("sha256", confirmKey()).update(body).digest("base64url");
}

export function signConfirm(p: ConfirmPayload, now = Date.now()): string {
  const exp = now + CONFIRM_TTL_MS;
  return `${exp}.${digest(p, exp)}`;
}

export function verifyConfirm(token: string, p: ConfirmPayload, now = Date.now()): boolean {
  const [expRaw, sig] = token.split(".");
  const exp = Number(expRaw);
  if (!Number.isFinite(exp) || !sig || exp < now) return false;
  const want = Buffer.from(digest(p, exp));
  const got = Buffer.from(sig);
  return want.length === got.length && timingSafeEqual(want, got);
}
