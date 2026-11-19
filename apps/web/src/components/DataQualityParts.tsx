import { Fragment, type ReactNode } from "react";
import { EXCLUDED_LABELS, issueLabel, type DqRecord, type DqRecordStatus, type DqReview } from "../lib/dataQuality";
import { Badge, Table, type BadgeTone } from "./ui";

// The score bar and the row table of the Data Quality page, shared with the import filter step
// (components/ImportFilterStep.tsx). Moved here from pages/DataQuality.tsx without any change to what the Data
// Quality page renders (test/dataQualityPageSnapshot.test.tsx holds its exact HTML from before the move).
// Every option below defaults to the Data Quality page's own behaviour.

export const ROW_TONE: Record<DqRecordStatus, BadgeTone> = { VALID: "ok", INVALID: "crit", DUPLICATE: "warn", EXCLUDED: "neutral" };
export const REVIEW_TONE: Record<DqReview, BadgeTone> = { PENDING: "neutral", APPROVED: "ok", REJECTED: "crit" };

const clampScore = (v: string) => Math.min(100, Math.max(0, Math.round(Number(v) || 0)));

/* ------------------------------------------------------------------ score bar */

/** "Score ≥ [70]  Approve N  Reject N below  ☐ Only show rows scoring 70+". */
export function DqScoreBar({
  minScore,
  onMinScore,
  atOrAbove,
  below,
  busy,
  onApprove,
  onReject,
  aboveOnly,
  onAboveOnly,
  note,
  locked,
}: {
  minScore: number;
  onMinScore: (v: number) => void;
  /** Rows Approve / Reject would change. */
  atOrAbove: number;
  below: number;
  /** Approve / Reject disabled (e.g. AI scores still to come, or a review is being saved). */
  busy: boolean;
  onApprove: () => void;
  onReject: () => void;
  aboveOnly: boolean;
  onAboveOnly: (on: boolean) => void;
  /** Shown after the controls (why they are disabled). */
  note?: ReactNode;
  /** Import filter step only: the score box and "Only show" are disabled too (AI scoring still running). */
  locked?: boolean;
}) {
  return (
    <div className="mb-3 flex flex-wrap items-center gap-2 text-sm">
      <label className="flex items-center gap-2 text-slate-550">
        Score ≥
        <input
          type="number"
          className="input w-20"
          min={0}
          max={100}
          value={minScore}
          aria-label="Minimum score"
          disabled={locked}
          onChange={(e) => onMinScore(clampScore(e.target.value))}
        />
      </label>
      <button type="button" className="btn-ghost" disabled={busy || atOrAbove === 0} onClick={onApprove}>
        Approve {atOrAbove}
      </button>
      <button type="button" className="btn-ghost" disabled={busy || below === 0} onClick={onReject}>
        Reject {below} below
      </button>
      <label className="flex items-center gap-2 text-slate-550">
        <input type="checkbox" checked={aboveOnly} disabled={locked} onChange={(e) => onAboveOnly(e.target.checked)} />
        Only show rows scoring {minScore}+
      </label>
      {note ? <span className="text-xs text-slate-550">{note}</span> : null}
    </div>
  );
}

/* ------------------------------------------------------------------ row table */

/** What the table shows of a row (a Data Quality record, or a row of the import filter step). */
export type DqTableRow = Pick<
  DqRecord,
  | "rowIndex"
  | "name"
  | "phone"
  | "phoneRaw"
  | "businessName"
  | "email"
  | "status"
  | "excludedReason"
  | "issues"
  | "flags"
  | "score"
  | "ruleScore"
  | "aiScore"
  | "aiState"
  | "aiNotes"
  | "review"
>;

/** An extra column (import filter step): its header and its whole cell, placed after Business or after Score. */
export interface DqExtraColumn<R> {
  header: string;
  after: "business" | "score";
  cell: (r: R) => ReactNode;
}

const ROW_CLASS = "border-b border-line-subtle align-top last:border-0";

export function DqRecordTable<R extends DqTableRow>({
  rows,
  rowKey,
  selectAllLabel,
  canPick,
  isPicked,
  onPick,
  anyPickable,
  allPicked,
  onPickAll,
  extraColumns = [],
  notesBefore,
  hideCode,
  rowClassName,
}: {
  rows: R[];
  rowKey: (r: R) => string | number;
  /** Data Quality: "Select all valid rows shown". */
  selectAllLabel: string;
  /** The row has a checkbox (Data Quality: valid rows). */
  canPick: (r: R) => boolean;
  isPicked: (r: R) => boolean;
  onPick: (r: R) => void;
  /** Some row shown has a checkbox (otherwise "select all" is disabled). */
  anyPickable: boolean;
  /** Every row shown that has a checkbox is ticked. */
  allPicked: boolean;
  onPickAll: (on: boolean) => void;
  extraColumns?: DqExtraColumn<R>[];
  /** Notes shown before the row's issues (import filter step: why the importer can't take it). */
  notesBefore?: (r: R) => ReactNode;
  /** An issue code not to list for this row. */
  hideCode?: (r: R, code: string) => boolean;
  /** Extra classes for the row. */
  rowClassName?: (r: R) => string | undefined;
}) {
  const afterBusiness = extraColumns.filter((c) => c.after === "business");
  const afterScore = extraColumns.filter((c) => c.after === "score");
  return (
    <Table
      head={[
        <input key="all" type="checkbox" aria-label={selectAllLabel} disabled={!anyPickable} checked={allPicked} onChange={(e) => onPickAll(e.target.checked)} />,
        "Row",
        "Name",
        "Phone",
        "Business",
        ...afterBusiness.map((c) => c.header),
        "Check",
        "Score",
        ...afterScore.map((c) => c.header),
        "Notes",
        "Review",
      ]}
    >
      {rows.map((r) => {
        const extra = rowClassName?.(r);
        return (
          <tr key={rowKey(r)} className={extra ? `${ROW_CLASS} ${extra}` : ROW_CLASS}>
            <td className="px-4 py-3">
              {canPick(r) && <input type="checkbox" aria-label={`Select row ${r.rowIndex + 2}`} checked={isPicked(r)} onChange={() => onPick(r)} />}
            </td>
            <td className="px-4 py-3 font-mono text-xs">{r.rowIndex + 2}</td>
            <td className="px-4 py-3">{r.name ?? <span className="text-slate-550">—</span>}</td>
            <td className="px-4 py-3 font-mono text-xs">{r.phone ?? r.phoneRaw ?? "—"}</td>
            <td className="px-4 py-3">
              {r.businessName ?? <span className="text-slate-550">—</span>}
              {r.email && <div className="text-xs text-slate-550">{r.email}</div>}
            </td>
            {afterBusiness.map((c) => (
              <Fragment key={c.header}>{c.cell(r)}</Fragment>
            ))}
            <td className="px-4 py-3">
              <Badge tone={ROW_TONE[r.status]}>{r.status === "EXCLUDED" && r.excludedReason ? EXCLUDED_LABELS[r.excludedReason] : r.status.toLowerCase()}</Badge>
            </td>
            <td className="px-4 py-3 font-mono text-xs">
              {r.score ?? "—"}
              {r.ruleScore != null && (
                <div className="text-slate-550">
                  rules {r.ruleScore}
                  {r.aiScore != null ? ` · AI ${r.aiScore}` : r.aiState === "PENDING" ? " · AI …" : ""}
                </div>
              )}
            </td>
            {afterScore.map((c) => (
              <Fragment key={c.header}>{c.cell(r)}</Fragment>
            ))}
            <td className="max-w-xs px-4 py-3 text-xs">
              {notesBefore?.(r)}
              {[...r.issues, ...r.flags]
                .filter((c) => !hideCode?.(r, c))
                .map((c) => (
                  <div key={c}>{issueLabel(c)}</div>
                ))}
              {r.aiNotes && <div className={r.aiState === "ERROR" ? "text-crit" : "text-slate-550"}>AI: {r.aiNotes}</div>}
            </td>
            <td className="px-4 py-3">{r.status === "VALID" ? <Badge tone={REVIEW_TONE[r.review]}>{r.review.toLowerCase()}</Badge> : null}</td>
          </tr>
        );
      })}
    </Table>
  );
}
