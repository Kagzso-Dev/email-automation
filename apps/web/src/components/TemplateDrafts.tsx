import { useState, type ReactNode } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "../lib/auth";
import {
  deleteDraft,
  draftLabel,
  draftsKey,
  editedByOtherRecently,
  findRecentOwnDraft,
  formatClock,
  formatEdited,
  getDraft,
  useDraftList,
  DRAFT_RETENTION_DAYS,
  type Draft,
  type DraftChannel,
  type DraftStatus,
  type DraftSummary,
} from "../lib/templateDrafts";
import { useConfirm } from "./confirm";
import { Badge, EmptyState, ErrorNote, Spinner, Table } from "./ui";

// Template drafts UI (ENABLE_TEMPLATE_DRAFTS): the "Draft saved 10:42" note, the Drafts tab, and the prompts before
// opening a draft. Only rendered / called while the flag is on. Built from the existing UI kit only.

/** "Draft saved 10:42" in the form header; "Draft not saved" when a save failed. Nothing before the first save. */
export function DraftSavedNote({ status, className = "" }: { status: DraftStatus | null | undefined; className?: string }) {
  if (!status) return null;
  const text =
    status.kind === "failed"
      ? "Draft not saved"
      : status.savedAt
        ? `Draft saved ${formatClock(status.savedAt)}`
        : status.kind === "saving"
          ? "Saving draft…"
          : null;
  if (!text) return null;
  return (
    <span
      role="status"
      aria-live="polite"
      className={`text-xs font-normal ${status.kind === "failed" ? "text-crit" : "text-slate-550"} ${className}`}
      title={status.kind === "failed" ? "Your changes are still in the form. Saving is tried again on your next change." : undefined}
    >
      {text}
    </span>
  );
}

/** A dialog title with the note beside it; the plain title (unchanged) when there's nothing to show. */
export function withDraftNote(title: string, status: DraftStatus | null): ReactNode {
  if (!status || (status.kind !== "failed" && !status.savedAt && status.kind !== "saving")) return title;
  return (
    <span className="flex flex-wrap items-baseline gap-x-3">
      {title}
      <DraftSavedNote status={status} />
    </span>
  );
}

/** "Drafts" with its count badge (no badge at 0 or while loading). */
export function draftsTabLabel(count: number | undefined): ReactNode {
  return (
    <span className="inline-flex items-center gap-2">
      Drafts
      {count ? <Badge tone="accent">{count}</Badge> : null}
    </span>
  );
}

/**
 * Opening drafts: "Continue your draft?" on New template, and the warning when someone else edited the draft in the
 * last 10 minutes. A draft that can't be read never blocks starting a new template.
 */
export function useDraftOpener<S>(channel: DraftChannel) {
  const qc = useQueryClient();
  const confirm = useConfirm();
  const userId = useAuth().user?.id;

  /** The full draft, after the warning if someone else is editing it; null when they chose not to resume. */
  async function open(id: string): Promise<Draft<S> | null> {
    const draft = await getDraft<S>(id);
    const minutes = editedByOtherRecently(draft, userId);
    if (minutes !== null) {
      const ok = await confirm({
        title: "Someone else is editing this draft",
        body: `${draft.lastEditedByEmail} edited it ${minutes < 1 ? "less than a minute" : minutes === 1 ? "1 minute" : `${minutes} minutes`} ago. If you both keep editing, the last save wins.`,
        confirmText: "Resume anyway",
      });
      if (!ok) return null;
    }
    return draft;
  }

  /** New template: your recent draft if you choose "Continue draft", otherwise null (start a new one). */
  async function startNew(): Promise<Draft<S> | null> {
    const recent = await findRecentOwnDraft(qc, channel, userId);
    if (!recent) return null;
    const ok = await confirm({
      title: "Continue your draft?",
      body: `“${draftLabel(recent.name)}”, last edited ${formatEdited(recent.updatedAt)}. Start new keeps it in Drafts.`,
      confirmText: "Continue draft",
      cancelText: "Start new",
    });
    if (!ok) return null;
    try {
      return await open(recent.id);
    } catch {
      return null; // deleted meanwhile, or the API is down: start a new one
    }
  }

  return { open, startNew };
}

/** The Drafts tab: the team's drafts on this page, newest first. */
export function TemplateDraftsList<S>({ channel, onOpen }: { channel: DraftChannel; onOpen: (draft: Draft<S>) => void }) {
  const qc = useQueryClient();
  const confirm = useConfirm();
  const query = useDraftList(channel, true);
  const opener = useDraftOpener<S>(channel);
  const [openError, setOpenError] = useState<unknown>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: draftsKey(channel) });

  const resume = useMutation({
    mutationFn: (d: DraftSummary) => opener.open(d.id),
    onMutate: () => setOpenError(null),
    onSuccess: (draft) => {
      if (draft) onOpen(draft);
    },
    onError: (err) => {
      setOpenError(err);
      void refresh();
    },
  });
  const del = useMutation({ mutationFn: (id: string) => deleteDraft(id), onSettled: refresh });

  if (query.isLoading) return <Spinner />;
  if (query.error) return <ErrorNote error={query.error} />;
  const items = query.data?.items ?? [];
  const retentionDays = query.data?.retentionDays ?? DRAFT_RETENTION_DAYS;
  const now = new Date();

  return (
    <div>
      {(openError || del.error) && (
        <div className="mb-3">
          <ErrorNote error={openError ?? del.error} />
        </div>
      )}
      {items.length === 0 ? (
        <EmptyState icon="templates" title="No drafts">
          A new template you leave before creating it is saved here, so you can resume it later.
        </EmptyState>
      ) : (
        <Table head={["Name", "Owner", "Last edited", ""]}>
          {items.map((d) => (
            <tr key={d.id} className="border-b border-line-subtle last:border-0">
              <td className="px-4 py-2.5 font-medium">
                {d.name?.trim() ? d.name : <span className="font-normal text-slate-550">Untitled draft</span>}
              </td>
              <td className="px-4 py-2.5 text-slate-550">{d.ownerEmail}</td>
              <td className="px-4 py-2.5 text-slate-550">
                {formatEdited(d.updatedAt, now)}
                {d.lastEditedByEmail !== d.ownerEmail && <div className="text-xs">by {d.lastEditedByEmail}</div>}
              </td>
              <td className="px-4 py-2.5">
                <div className="flex items-center justify-end gap-3">
                  <button
                    className="text-xs text-accent-ink hover:underline disabled:opacity-50"
                    disabled={resume.isPending}
                    onClick={() => resume.mutate(d)}
                  >
                    Resume
                  </button>
                  <button
                    className="text-xs text-crit hover:underline disabled:opacity-50"
                    disabled={del.isPending}
                    onClick={async () => {
                      const ok = await confirm({
                        title: `Delete "${draftLabel(d.name)}"?`,
                        body: "The draft is deleted for everyone. This can't be undone.",
                        confirmText: "Delete",
                        tone: "danger",
                      });
                      if (ok) del.mutate(d.id);
                    }}
                  >
                    Delete
                  </button>
                </div>
              </td>
            </tr>
          ))}
        </Table>
      )}
      <p className="mt-3 text-xs text-slate-550">Drafts are deleted {retentionDays} days after they were last edited.</p>
    </div>
  );
}
