// Template drafts (ENABLE_TEMPLATE_DRAFTS, migration 0039): an unfinished "New template" form on Templates (email)
// or WhatsApp Templates → "Create in Meta", kept so it can be resumed. Reads and writes ONLY the template_drafts
// table. A draft is never a template: nothing here touches the Template / WhatsAppTemplate tables, Meta, or any
// send, and no other module reads this table (test/templateDraftsHttp.test.ts checks that).
//
// Drafts not edited for 30 days are deleted: on every list read and by an hourly sweep in the API process (flag on
// only).

import { Prisma } from "@prisma/client";
import { isTemplateDraftsEnabled } from "../config/templateDrafts.js";
import { logger } from "../logger.js";
import { prisma } from "../prisma.js";

export const DRAFT_RETENTION_DAYS = 30;
/** The form state is small (an email template's text and image URLs); this keeps a runaway client in check. */
export const DRAFT_STATE_MAX_BYTES = 256 * 1024;
const DAY_MS = 24 * 60 * 60 * 1000;

export const DRAFT_CHANNELS = ["whatsapp", "email"] as const;
export type DraftChannel = (typeof DRAFT_CHANNELS)[number];

/** Prisma's "table does not exist" (P2021) or MySQL's 1146: migration 0039 isn't applied yet. */
export const isMissingTable = (err: unknown) => {
  const raw = err as { code?: string; meta?: { code?: string } } | null;
  return raw?.code === "P2021" || raw?.meta?.code === "1146";
};

/** Every column except the form state (the list doesn't need it). */
const SUMMARY_SELECT = {
  id: true,
  channel: true,
  name: true,
  ownerId: true,
  ownerEmail: true,
  lastEditedById: true,
  lastEditedByEmail: true,
  createdAt: true,
  updatedAt: true,
} as const;

export interface DraftEditor {
  id: string;
  email: string;
}

export async function listDrafts(channel?: DraftChannel) {
  return prisma.templateDraft.findMany({
    where: channel ? { channel } : {},
    orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
    take: 500,
    select: SUMMARY_SELECT,
  });
}

export async function getDraft(id: string) {
  return prisma.templateDraft.findUnique({ where: { id }, select: { ...SUMMARY_SELECT, state: true } });
}

export type SaveDraftResult =
  | { status: "ok"; draft: Prisma.TemplateDraftGetPayload<{ select: typeof SUMMARY_SELECT }> }
  | { status: "channel_mismatch" };

/**
 * Create or update (last write wins). The owner is whoever created it and never changes; who edited it last and
 * when come from the session and the server clock.
 */
export async function saveDraft(
  input: { id: string; channel: DraftChannel; name: string | null; state: Record<string, unknown> },
  by: DraftEditor,
  now = new Date(),
): Promise<SaveDraftResult> {
  const existing = await prisma.templateDraft.findUnique({ where: { id: input.id }, select: { channel: true } });
  if (existing && existing.channel !== input.channel) return { status: "channel_mismatch" };
  const state = input.state as Prisma.InputJsonValue;
  const write = () =>
    prisma.templateDraft.upsert({
      where: { id: input.id },
      create: {
        id: input.id,
        channel: input.channel,
        name: input.name,
        state,
        ownerId: by.id,
        ownerEmail: by.email,
        lastEditedById: by.id,
        lastEditedByEmail: by.email,
        createdAt: now,
        updatedAt: now,
      },
      update: { name: input.name, state, lastEditedById: by.id, lastEditedByEmail: by.email, updatedAt: now },
      select: SUMMARY_SELECT,
    });
  try {
    return { status: "ok", draft: await write() };
  } catch (err) {
    // Two first saves of the same new draft at once (a debounced save and a leave-the-page save): the loser
    // retries, and lands as an update.
    if ((err as { code?: string }).code === "P2002") return { status: "ok", draft: await write() };
    throw err;
  }
}

/** True when it existed. */
export async function deleteDraft(id: string): Promise<boolean> {
  const { count } = await prisma.templateDraft.deleteMany({ where: { id } });
  return count > 0;
}

/** Delete drafts not edited for 30 days. Returns how many were deleted. */
export async function purgeOldDrafts(now = new Date()): Promise<number> {
  const { count } = await prisma.templateDraft.deleteMany({
    where: { updatedAt: { lt: new Date(now.getTime() - DRAFT_RETENTION_DAYS * DAY_MS) } },
  });
  if (count) logger.info({ count }, "template drafts: drafts not edited for 30 days deleted");
  return count;
}

/** The hourly sweep (API process). Flag off: does nothing. Never throws; a missing table is ignored. */
export function startTemplateDraftSweep(intervalMs = 60 * 60 * 1000): () => void {
  const run = () => {
    if (!isTemplateDraftsEnabled()) return;
    void purgeOldDrafts().catch((err) => {
      if (!isMissingTable(err)) logger.warn({ err }, "template drafts sweep failed");
    });
  };
  const timer = setInterval(run, intervalMs);
  timer.unref?.(); // never keeps the process alive
  return () => clearInterval(timer);
}
