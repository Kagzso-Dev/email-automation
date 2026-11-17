import type { ReactNode } from "react";
import { useMutation, useQueryClient, type QueryKey } from "@tanstack/react-query";
import { api } from "../lib/api";
import { useConfirm } from "./confirm";
import { Icon } from "./icons";
import { useToast } from "./toast";

/**
 * Send Queue → the Delete button on each row (Email batch, WhatsApp batch, AI Call follow-up).
 * Asks first, then DELETEs `path`; on success refreshes `refresh` (the tab's list and its
 * "Download all history" count). `blockedReason` disables it with that reason as the tooltip
 * (still sending, waiting for approval, …) — the API refuses those too.
 */
export function DeleteHistoryButton({
  path,
  what,
  body,
  blockedReason,
  refresh,
}: {
  path: string;
  /** Short name for the dialog and tooltip, e.g. `email batch 1a2b3c4d`. */
  what: string;
  body: ReactNode;
  blockedReason?: string | null;
  refresh: QueryKey[];
}) {
  const qc = useQueryClient();
  const confirm = useConfirm();
  const toast = useToast();
  const del = useMutation({
    mutationFn: () => api(path, { method: "DELETE", notify: "Deleted from send history" }),
    onError: (err) => toast.fromError(err, "Could not delete"),
    // Also after a refusal: the row may have changed (e.g. a send started or a follow-up was decided).
    onSettled: () => refresh.forEach((queryKey) => void qc.invalidateQueries({ queryKey })),
  });

  const label = `Delete ${what}`;
  return (
    <button
      type="button"
      aria-label={label}
      title={blockedReason ?? label}
      className="btn-ghost px-2 py-1.5 hover:text-crit"
      disabled={!!blockedReason || del.isPending}
      onClick={async (e) => {
        e.stopPropagation();
        const ok = await confirm({ title: `Delete ${what}?`, body, confirmText: "Delete", tone: "danger" });
        if (ok) del.mutate();
      }}
    >
      <Icon name="trash" size={14} className={del.isPending ? "animate-pulse" : undefined} />
    </button>
  );
}
