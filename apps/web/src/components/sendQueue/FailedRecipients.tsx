// Send Queue → an expanded batch with failures: who failed, grouped by the error reason, plus the batch's
// follow-up actions (Retry failed / Download failed), passed in by the tab that owns the data.

import { useId, type ReactNode } from "react";
import { TriangleAlert } from "lucide-react";

export interface FailedRecipient {
  id: string;
  /** Email address or phone number. */
  contact: string;
  error: string | null;
}

const NO_REASON = "No reason recorded";
/** Reasons shown before "… more reasons in the table below". */
const MAX_GROUPS = 4;
/** Recipients named per reason before "and N more". */
const MAX_NAMED = 3;

function groupByReason(items: FailedRecipient[]) {
  const groups = new Map<string, FailedRecipient[]>();
  for (const it of items) {
    const reason = it.error?.trim() || NO_REASON;
    groups.set(reason, [...(groups.get(reason) ?? []), it]);
  }
  return [...groups.entries()].map(([reason, list]) => ({ reason, list })).sort((a, b) => b.list.length - a.list.length);
}

export function FailedRecipients({
  items,
  total,
  actions,
  note,
}: {
  items: FailedRecipient[];
  /** The batch's recipient count ("24 of 25 recipients failed"). */
  total: number;
  actions?: ReactNode;
  /** A line under the reasons, e.g. how to send the failed ones again. */
  note?: ReactNode;
}) {
  const headingId = useId();
  const groups = groupByReason(items);
  const shown = groups.slice(0, MAX_GROUPS);
  const hidden = groups.length - shown.length;

  return (
    <section aria-labelledby={headingId} className="rounded-xl border border-crit-line bg-surface p-4 shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-3">
          <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-crit-soft text-crit">
            <TriangleAlert size={18} aria-hidden="true" />
          </span>
          <div className="min-w-0">
            <h3 id={headingId} className="text-sm font-semibold text-ink">
              {items.length} of {total} recipient{total === 1 ? "" : "s"} failed
            </h3>
            <p className="text-xs text-slate-550">
              {groups.length === 1 ? "All for the same reason." : `${groups.length} different reasons, most common first.`}
            </p>
          </div>
        </div>
        {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
      </div>

      <ul className="mt-3 space-y-2">
        {shown.map((g) => (
          <li key={g.reason} className="rounded-lg bg-crit-soft/60 px-3 py-2.5">
            <div className="flex items-start justify-between gap-3">
              <p className="line-clamp-2 break-words text-sm font-medium text-crit" title={g.reason}>
                {g.reason}
              </p>
              <span className="shrink-0 rounded-full bg-surface px-2 py-px text-xs font-semibold tabular-nums text-crit ring-1 ring-inset ring-crit-line">
                {g.list.length}
              </span>
            </div>
            <p className="mt-1 break-words text-xs text-slate-600">
              {g.list
                .slice(0, MAX_NAMED)
                .map((r) => r.contact)
                .join(", ")}
              {g.list.length > MAX_NAMED ? ` and ${g.list.length - MAX_NAMED} more` : ""}
            </p>
          </li>
        ))}
      </ul>
      {hidden > 0 && (
        <p className="mt-2 text-xs text-slate-550">
          {hidden} more reason{hidden === 1 ? "" : "s"}: see the Error column below.
        </p>
      )}
      {note ? <p className="mt-3 text-xs leading-relaxed text-slate-550">{note}</p> : null}
    </section>
  );
}
