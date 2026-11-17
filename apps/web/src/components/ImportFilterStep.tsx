import { useMemo, useState } from "react";
import { CheckGroup, FilterPanel } from "../pages/DataQuality";
import { EXCLUDED_LABELS, issueLabel, type DqFilters, type DqRecordStatus, type DqReview } from "../lib/dataQuality";
import {
  ALL_LANGUAGES,
  draftRowMatches,
  isSelectable,
  LANGUAGE_LABELS,
  LANGUAGE_OPTIONS,
  pageDefaults,
  type DraftLanguage,
  type DraftRow,
  type ImportFilterPage,
} from "../lib/importFilter";
import { fullNumber } from "../lib/numberFormat";
import { useConfirm } from "./confirm";
import { OverLimitNote } from "./ImportSummary";
import { Badge, ErrorNote, Table, Tabs, type BadgeTone } from "./ui";

// The import filter step (ENABLE_IMPORT_FILTER_STEP): the Data Quality filter view on a file's rows BEFORE
// they are imported. Same filters, score controls and table as the Data Quality page. Everything here is in
// memory: nothing is saved until "Import N selected" hands the chosen rows to the page's own importer.

const ROW_TONE: Record<DqRecordStatus, BadgeTone> = { VALID: "ok", INVALID: "crit", DUPLICATE: "warn", EXCLUDED: "neutral" };
const REVIEW_TONE: Record<DqReview, BadgeTone> = { PENDING: "neutral", APPROVED: "ok", REJECTED: "crit" };
type Tab = "ALL" | DqRecordStatus;

const clampScore = (v: string) => Math.min(100, Math.max(0, Math.round(Number(v) || 0)));
const n = (v: number) => fullNumber.format(v);

export interface ImportFilterStepProps {
  page: ImportFilterPage;
  filename: string;
  /** The rows read (the first maxRows of the file), already checked. */
  rows: DraftRow[];
  /** Data rows in the file. */
  totalRows: number;
  /** The most rows one import takes. */
  maxRows: number;
  /** Where "Import" sends the rows, e.g. "WhatsApp Contacts". */
  destination: string;
  importing: boolean;
  error?: unknown;
  /** Back to choosing a file. Nothing is imported. */
  onBack: () => void;
  /** The chosen rows (their rowIndex), in file order. */
  onImport: (rowIndexes: number[]) => void;
}

export function ImportFilterStep({ page, filename, rows, totalRows, maxRows, destination, importing, error, onBack, onImport }: ImportFilterStepProps) {
  const confirm = useConfirm();
  const defaults = useMemo(() => pageDefaults(page), [page]);
  const [filters, setFilters] = useState<DqFilters>(defaults.filters);
  const [languages, setLanguages] = useState<DraftLanguage[]>(defaults.languages);
  const [tab, setTab] = useState<Tab>("ALL");
  const [minScore, setMinScore] = useState(70);
  const [aboveOnly, setAboveOnly] = useState(false);
  // In memory only: Approve / Reject here, and rows the user unticked.
  const [reviews, setReviews] = useState<ReadonlyMap<number, DqReview>>(new Map());
  const [unticked, setUnticked] = useState<ReadonlySet<number>>(new Set());

  const all = useMemo(() => rows.map((r) => ({ ...r, review: reviews.get(r.rowIndex) ?? r.review })), [rows, reviews]);
  const matching = all.filter((r) => draftRowMatches(r, filters, languages));
  const byTab = tab === "ALL" ? matching : matching.filter((r) => r.status === tab);
  const shown = aboveOnly ? byTab.filter((r) => r.score != null && r.score >= minScore) : byTab;
  const pickable = shown.filter(isSelectable);
  // Never more than one import takes (the rows read are already capped at maxRows).
  const selected = pickable.filter((r) => !unticked.has(r.rowIndex)).slice(0, maxRows);
  const count = (s: DqRecordStatus) => matching.filter((r) => r.status === s).length;
  const skippedOverLimit = Math.max(0, totalRows - rows.length);
  const alreadySaved = all.filter((r) => r.alreadySaved).length;

  // Review by score (Data Quality's rule): valid rows not reviewed yet.
  const unreviewed = all.filter((r) => r.status === "VALID" && r.review === "PENDING" && r.score != null);
  const atOrAbove = unreviewed.filter((r) => r.score! >= minScore);
  const below = unreviewed.filter((r) => r.score! < minScore);
  const byScore = async (value: "APPROVED" | "REJECTED") => {
    const list = value === "APPROVED" ? atOrAbove : below;
    const ok = await confirm({
      title: `${value === "APPROVED" ? "Approve" : "Reject"} ${list.length} row${list.length === 1 ? "" : "s"} scoring ${value === "APPROVED" ? `${minScore} or more` : `below ${minScore}`}?`,
      body: "Only valid rows not reviewed yet change. Nothing is saved: rejected rows are simply left out of this import.",
      confirmText: value === "APPROVED" ? "Approve" : "Reject",
      tone: value === "REJECTED" ? "danger" : "default",
    });
    if (!ok) return;
    setReviews((prev) => {
      const next = new Map(prev);
      for (const r of list) next.set(r.rowIndex, value);
      return next;
    });
  };

  const toggle = (rowIndex: number) =>
    setUnticked((prev) => {
      const next = new Set(prev);
      if (next.has(rowIndex)) next.delete(rowIndex);
      else next.add(rowIndex);
      return next;
    });
  const allTicked = pickable.length > 0 && pickable.every((r) => !unticked.has(r.rowIndex));
  const tickAll = (on: boolean) =>
    setUnticked((prev) => {
      const next = new Set(prev);
      for (const r of pickable) {
        if (on) next.delete(r.rowIndex);
        else next.add(r.rowIndex);
      }
      return next;
    });

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2 text-sm">
        <span>
          <b>{filename}</b> · {n(rows.length)} row{rows.length === 1 ? "" : "s"} read
        </span>
        <span className="text-xs text-slate-550">Nothing is saved until you click Import.</span>
      </div>
      {skippedOverLimit > 0 && (
        <div className="mb-3">
          <OverLimitNote totalRows={totalRows} maxRows={maxRows} skippedOverLimit={skippedOverLimit} />
        </div>
      )}
      <p className="mb-3 text-xs text-slate-550">
        Checked with the Data Quality rules (rules score only; the AI score needs a saved Data Quality check). Only the rows you keep go to
        the {destination} import, which then applies its own rules, duplicates included.
        {alreadySaved > 0 && ` ${n(alreadySaved)} number${alreadySaved === 1 ? " is" : "s are"} already saved: the import updates ${alreadySaved === 1 ? "it" : "them"}.`}
      </p>

      <div className="mb-3 flex flex-wrap items-center gap-2 text-sm">
        <label className="flex items-center gap-2 text-slate-550">
          Score ≥
          <input type="number" className="input w-20" min={0} max={100} value={minScore} aria-label="Minimum score" onChange={(e) => setMinScore(clampScore(e.target.value))} />
        </label>
        <button type="button" className="btn-ghost" disabled={atOrAbove.length === 0} onClick={() => void byScore("APPROVED")}>
          Approve {atOrAbove.length}
        </button>
        <button type="button" className="btn-ghost" disabled={below.length === 0} onClick={() => void byScore("REJECTED")}>
          Reject {below.length} below
        </button>
        <label className="flex items-center gap-2 text-slate-550">
          <input type="checkbox" checked={aboveOnly} onChange={(e) => setAboveOnly(e.target.checked)} />
          Only show rows scoring {minScore}+
        </label>
      </div>

      <div className="card mb-3 p-4">
        <CheckGroup label="Language (from the name and business)" options={LANGUAGE_OPTIONS} value={languages} onChange={setLanguages} />
      </div>
      <FilterPanel
        filters={filters}
        onChange={setFilters}
        facets={undefined}
        showing={`Showing ${n(shown.length)} of ${n(rows.length)}`}
        busy={false}
        onClear={() => {
          setFilters({});
          setLanguages([...ALL_LANGUAGES]);
          setTab("ALL");
          setAboveOnly(false);
          setUnticked(new Set());
        }}
      />
      <Tabs<Tab>
        tabs={[
          { value: "ALL", label: `All (${matching.length})` },
          { value: "VALID", label: `Valid (${count("VALID")})` },
          { value: "INVALID", label: `Invalid (${count("INVALID")})` },
          { value: "DUPLICATE", label: `Duplicate (${count("DUPLICATE")})` },
          { value: "EXCLUDED", label: `Excluded (${count("EXCLUDED")})` },
        ]}
        value={tab}
        onChange={setTab}
      />
      <div className="max-h-[28rem] overflow-y-auto">
        <Table
          head={[
            <input
              key="all"
              type="checkbox"
              aria-label="Select all rows shown"
              disabled={pickable.length === 0}
              checked={allTicked}
              onChange={(e) => tickAll(e.target.checked)}
            />,
            "Row",
            "Name",
            "Phone",
            "Business",
            "Language",
            "Check",
            "Score",
            "Notes",
            "Review",
          ]}
        >
          {shown.map((r) => (
            <tr key={r.rowIndex} className="border-b border-line-subtle align-top last:border-0">
              <td className="px-4 py-3">
                {isSelectable(r) && (
                  <input type="checkbox" aria-label={`Select row ${r.rowIndex + 2}`} checked={!unticked.has(r.rowIndex)} onChange={() => toggle(r.rowIndex)} />
                )}
              </td>
              <td className="px-4 py-3 font-mono text-xs">{r.rowIndex + 2}</td>
              <td className="px-4 py-3">{r.name ?? <span className="text-slate-550">—</span>}</td>
              <td className="px-4 py-3 font-mono text-xs">{r.phone ?? r.phoneRaw ?? "—"}</td>
              <td className="px-4 py-3">
                {r.businessName ?? <span className="text-slate-550">—</span>}
                {r.email && <div className="text-xs text-slate-550">{r.email}</div>}
              </td>
              <td className="px-4 py-3 text-xs">{LANGUAGE_LABELS[r.language]}</td>
              <td className="px-4 py-3">
                <Badge tone={ROW_TONE[r.status]}>{r.status === "EXCLUDED" && r.excludedReason ? EXCLUDED_LABELS[r.excludedReason] : r.status.toLowerCase()}</Badge>
              </td>
              <td className="px-4 py-3 font-mono text-xs">{r.score ?? "—"}</td>
              <td className="max-w-xs px-4 py-3 text-xs">
                {r.importProblem && <div className="text-crit">{r.importProblem}</div>}
                {r.alreadySaved && <div className="text-warn">Already saved: the import updates it</div>}
                {[...r.issues, ...r.flags]
                  .filter((c) => !(r.alreadySaved && c === "in_whatsapp"))
                  .map((c) => (
                    <div key={c}>{issueLabel(c)}</div>
                  ))}
              </td>
              <td className="px-4 py-3">{r.status === "VALID" ? <Badge tone={REVIEW_TONE[r.review]}>{r.review.toLowerCase()}</Badge> : null}</td>
            </tr>
          ))}
        </Table>
      </div>

      {error ? (
        <div className="mt-3">
          <ErrorNote error={error} />
        </div>
      ) : null}
      <div className="mt-4 flex flex-wrap items-center justify-between gap-2">
        <span className="text-xs text-slate-550">One import takes up to {n(maxRows)} rows.</span>
        <div className="flex gap-2">
          <button type="button" className="btn-ghost" disabled={importing} onClick={onBack}>
            Back
          </button>
          <button type="button" className="btn-primary" disabled={importing || selected.length === 0} onClick={() => onImport(selected.map((r) => r.rowIndex))}>
            {importing ? "Importing…" : `Import ${n(selected.length)} selected`}
          </button>
        </div>
      </div>
    </div>
  );
}
