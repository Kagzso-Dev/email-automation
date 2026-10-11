import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import { useToast } from "./toast";
import { Badge, ErrorNote, Modal, Spinner, type BadgeTone } from "./ui";

/**
 * Meta → Dispatch: templates that exist in Meta (WhatsApp Manager) but aren't
 * registered here yet. Admins review and import them as new rows; existing
 * rows are never changed.
 */

export interface SyncCandidate {
  name: string;
  language: string;
  status: string | null;
  category: string | null;
  importable: boolean;
  reason: string | null;
  warnings: string[];
  displayName: string | null;
}

const STATUS_TONE: Record<string, BadgeTone> = { APPROVED: "ok", PENDING: "warn", IN_APPEAL: "warn", REJECTED: "crit", PAUSED: "crit", DISABLED: "crit" };
const k = (c: { name: string; language: string }) => `${c.name}|${c.language}`;

/** Checked automatically when an admin opens the templates page (Meta's list is read, nothing changes). */
export function useMetaSyncCandidates(enabled: boolean) {
  return useQuery({
    queryKey: ["whatsapp-meta-sync"],
    queryFn: () => api<{ items: SyncCandidate[] }>("/api/whatsapp/templates/meta-sync"),
    enabled,
    staleTime: 5 * 60_000,
    retry: false,
  });
}

export function MetaSyncModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <Modal open={open} onClose={onClose} title="Sync templates from Meta" wide>
      {open && <SyncBody onClose={onClose} />}
    </Modal>
  );
}

function SyncBody({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const list = useMetaSyncCandidates(true);
  const items = list.data?.items ?? [];
  const importable = items.filter((c) => c.importable);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  useEffect(() => setPicked(new Set(importable.map(k))), [list.data]); // eslint-disable-line react-hooks/exhaustive-deps

  const run = useMutation({
    mutationFn: () =>
      api<{ imported: { name: string }[]; skipped: { name: string; reason: string }[] }>("/api/whatsapp/templates/meta-sync", {
        method: "POST",
        json: { templates: items.filter((c) => picked.has(k(c))).map(({ name, language }) => ({ name, language })) },
        notify: false,
      }),
    onSuccess: (r) => {
      toast.success(`${r.imported.length} template${r.imported.length === 1 ? "" : "s"} imported from Meta`, r.skipped.map((s) => `${s.name}: ${s.reason}`));
      void qc.invalidateQueries({ queryKey: ["whatsapp-templates"] });
      void qc.invalidateQueries({ queryKey: ["whatsapp-template-verify"] });
      void qc.invalidateQueries({ queryKey: ["whatsapp-meta-sync"] });
      onClose();
    },
  });

  if (list.isLoading) return <Spinner />;
  if (list.error) return <ErrorNote error={list.error} />;
  if (items.length === 0) {
    return (
      <div>
        <p className="text-sm text-slate-550">Every template in your WhatsApp Business Account is already registered here.</p>
        <div className="mt-4 flex justify-end">
          <button className="btn-primary" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    );
  }

  return (
    <div>
      <p className="mb-3 text-sm text-slate-550">
        These templates exist in Meta but not in Dispatch. Importing adds them with the exact Meta name and language;{" "}
        <code>{"{{1}}"}</code> is filled with the contact's first name and <code>{"{{2}}"}</code> with the business name.
        Existing templates are not changed.
      </p>
      <div className="max-h-[50vh] overflow-y-auto rounded-lg border border-line">
        <table className="table-soft w-full min-w-[36rem] text-sm">
          <thead className="sticky top-0 z-10 bg-surface-sunken">
            <tr className="border-b border-line text-left text-xs uppercase tracking-[0.06em] text-slate-550">
              <th className="px-3 py-2" />
              <th className="px-3 py-2">Meta template</th>
              <th className="px-3 py-2">Language</th>
              <th className="px-3 py-2">Status</th>
              <th className="px-3 py-2">Notes</th>
            </tr>
          </thead>
          <tbody>
            {items.map((c) => (
              <tr key={k(c)} className={`border-b border-line-subtle last:border-0 ${c.importable ? "" : "opacity-60"}`}>
                <td className="px-3 py-2">
                  <input
                    type="checkbox"
                    aria-label={`Import ${c.name}`}
                    disabled={!c.importable}
                    checked={picked.has(k(c))}
                    onChange={(e) =>
                      setPicked((prev) => {
                        const next = new Set(prev);
                        if (e.target.checked) next.add(k(c));
                        else next.delete(k(c));
                        return next;
                      })
                    }
                  />
                </td>
                <td className="px-3 py-2">
                  <div className="font-mono text-xs">{c.name}</div>
                  {c.displayName && <div className="text-xs text-slate-550">as “{c.displayName}”</div>}
                </td>
                <td className="px-3 py-2 font-mono text-xs">{c.language}</td>
                <td className="px-3 py-2">
                  {c.status && <Badge tone={STATUS_TONE[c.status] ?? "neutral"}>{c.status.toLowerCase()}</Badge>}
                  {c.category && <div className="mt-0.5 text-[11px] text-slate-400">{c.category}</div>}
                </td>
                <td className="px-3 py-2 text-xs">
                  {c.reason && <div className="text-crit">{c.reason}</div>}
                  {c.warnings.map((w) => (
                    <div key={w} className="text-warn">
                      {w}
                    </div>
                  ))}
                  {!c.reason && c.warnings.length === 0 && <span className="text-slate-550">—</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {run.error && <ErrorNote error={run.error} />}
      <div className="mt-4 flex justify-end gap-2">
        <button type="button" className="btn-ghost" onClick={onClose}>
          Cancel
        </button>
        <button className="btn-primary" disabled={picked.size === 0 || run.isPending} onClick={() => run.mutate()}>
          {run.isPending ? "Importing…" : `Import ${picked.size} template${picked.size === 1 ? "" : "s"}`}
        </button>
      </div>
    </div>
  );
}
