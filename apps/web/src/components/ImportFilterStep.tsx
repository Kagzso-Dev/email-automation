import { useEffect, useMemo, useState, type ReactNode } from "react";
import { CheckGroup, FilterPanel } from "../pages/DataQuality";
import { cleanFilters, type DqFacets, type DqFilters, type DqRecordStatus, type DqReview } from "../lib/dataQuality";
import {
  downloadText,
  draftRowMatches,
  excludedRowsCsv,
  isExcluded,
  isSelectable,
  LANGUAGE_LABELS,
  LANGUAGE_OPTIONS,
  pageDefaults,
  usedReasons,
  USED_OPTIONS,
  type DraftLanguage,
  type DraftRow,
  type ImportFilterPage,
  type ImportSelection,
  type UsedOption,
} from "../lib/importFilter";
import { aiBusy, aiProgressLine, type AiProgress } from "../lib/importFilterAi";
import { fullNumber } from "../lib/numberFormat";
import { useConfirm } from "./confirm";
import { DqRecordTable, DqScoreBar, type DqExtraColumn } from "./DataQualityParts";
import { OverLimitNote } from "./ImportSummary";
import { ErrorNote, Tabs } from "./ui";

// The import filter step (ENABLE_IMPORT_FILTER_STEP): the Data Quality filter view on a file's rows BEFORE they
// are imported. The Data Quality page's own filter panel, score bar and row table (shared components), its AI score
// (while it comes in, the score filters and review by score wait), plus "Exclude already used data" and Language.
// Everything here is in memory: nothing is saved until "Import N selected" hands the chosen rows to the page's
// own importer.

type Tab = "ALL" | DqRecordStatus;

const n = (v: number) => fullNumber.format(v);

export interface ImportFilterStepProps {
  page: ImportFilterPage;
  filename: string;
  /** The file's columns and rows as read (for "Download excluded rows"). */
  headers: string[];
  rawRows: Record<string, string>[];
  /** The rows read (the first maxRows of the file), already checked (and AI-scored as far as it got). */
  rows: DraftRow[];
  /** Data rows in the file. */
  totalRows: number;
  /** The most rows one import takes. */
  maxRows: number;
  /** The file's city, category, source, date… values (the Data Quality dropdowns). None = no dropdowns. */
  facets?: DqFacets;
  /** The AI score coming in (lib/importFilterAi.ts). None = rules score only. */
  ai?: AiProgress;
  /** Where "Import" sends the rows, e.g. "WhatsApp Contacts". */
  destination: string;
  importing: boolean;
  error?: unknown;
  /** Back to choosing a file. Nothing is imported. */
  onBack: () => void;
  /** The chosen rows and what was used to choose them. */
  onImport: (selection: ImportSelection) => void;
  /** Voicecall: back to the column matching (only when the user asks for it). */
  onChangeColumns?: () => void;
  /** Shown just above the Import button (Voicecall admins: "Also import into other languages"). */
  beforeImport?: ReactNode;
}

function AiLine({ ai }: { ai: AiProgress }) {
  if (ai.state === "starting") return <p className="mb-3 text-xs text-slate-550">AI score: checking the service…</p>;
  if (ai.state === "off") return <p className="mb-3 rounded-lg bg-warn-soft px-3 py-2 text-sm text-warn">{ai.note}</p>;
  const info = ai.info;
  return (
    <>
      <p className="mb-3 text-xs text-slate-550" aria-live="polite">
        AI score{info?.model ? `: ${info.model} ${info.provider === "ollama" ? "on this server's Ollama" : `via ${info.label}`}` : ""}.{" "}
        <b className="text-ink">{aiProgressLine(ai)}</b>. Only the name and business name are sent to it; phone numbers and emails are never sent, and
        nothing is saved.
        {ai.state === "waiting" && ai.note ? <span className="text-warn"> {ai.note}</span> : null}
      </p>
      {ai.state === "stopped" && ai.note && <p className="mb-3 rounded-lg bg-warn-soft px-3 py-2 text-sm text-warn">{ai.note}. Rows not scored keep the rules score.</p>}
    </>
  );
}

export function ImportFilterStep({
  page,
  filename,
  headers,
  rawRows,
  rows,
  totalRows,
  maxRows,
  facets,
  ai,
  destination,
  importing,
  error,
  onBack,
  onImport,
  onChangeColumns,
  beforeImport,
}: ImportFilterStepProps) {
  const confirm = useConfirm();
  const defaults = useMemo(() => pageDefaults(page), [page]);
  const [filters, setFilters] = useState<DqFilters>(defaults.filters);
  const [languages, setLanguages] = useState<DraftLanguage[]>(defaults.languages);
  const [exclude, setExclude] = useState<UsedOption[]>(defaults.exclude);
  const [tab, setTab] = useState<Tab>("ALL");
  const [minScore, setMinScore] = useState(70);
  const [aboveOnly, setAboveOnly] = useState(false);
  // In memory only: Approve / Reject here, and rows the user unticked.
  const [reviews, setReviews] = useState<ReadonlyMap<number, DqReview>>(new Map());
  const [unticked, setUnticked] = useState<ReadonlySet<number>>(new Set());
  // Score filters and review by score wait for the AI score (phone type, status, text… don't).
  const locked = aiBusy(ai);

  // As on Data Quality, changing what is shown (filters, tab, "Only show") resets the row checkboxes:
  // there every row is unpicked again, here every row is ticked again.
  const viewKey = JSON.stringify([cleanFilters(filters), languages, exclude, tab, aboveOnly]);
  useEffect(() => setUnticked(new Set()), [viewKey]);

  const all = useMemo(() => rows.map((r) => ({ ...r, review: reviews.get(r.rowIndex) ?? r.review })), [rows, reviews]);
  const matching = all.filter((r) => draftRowMatches(r, filters, languages));
  const byTab = tab === "ALL" ? matching : matching.filter((r) => r.status === tab);
  const shown = aboveOnly ? byTab.filter((r) => r.score != null && r.score >= minScore) : byTab;
  const pickable = shown.filter((r) => isSelectable(r, exclude));
  // Never more than one import takes (the rows read are already capped at maxRows).
  const selected = pickable.filter((r) => !unticked.has(r.rowIndex)).slice(0, maxRows);
  const count = (s: DqRecordStatus) => matching.filter((r) => r.status === s).length;
  const skippedOverLimit = Math.max(0, totalRows - rows.length);
  // Excluded as already used: in the whole file (download, history) and among the rows shown (the counter).
  const excludedAll = all.filter((r) => isExcluded(r, exclude));
  const excludedShown = shown.filter((r) => isExcluded(r, exclude)).length;
  const reasons = new Map(shown.map((r) => [r.rowIndex, usedReasons(r, exclude, page)]));

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
  const tickAll = (on: boolean) =>
    setUnticked((prev) => {
      const next = new Set(prev);
      for (const r of pickable) {
        if (on) next.delete(r.rowIndex);
        else next.add(r.rowIndex);
      }
      return next;
    });

  const extraColumns: DqExtraColumn<DraftRow>[] = [
    { header: "Language", after: "business", cell: (r) => <td className="px-4 py-3 text-xs">{LANGUAGE_LABELS[r.language]}</td> },
    {
      header: "Already used",
      after: "score",
      cell: (r) => (
        <td className="max-w-xs px-4 py-3 text-xs text-warn">
          {(reasons.get(r.rowIndex) ?? []).map((t) => (
            <div key={t}>{t}</div>
          ))}
        </td>
      ),
    },
  ];

  const csvOfExcluded = () => excludedRowsCsv(headers, rawRows, excludedAll, exclude, page);
  const base = filename.replace(/\.[^.]+$/, "") || "import";
  const confirmImport = () =>
    onImport({
      rowIndexes: selected.map((r) => r.rowIndex),
      excluded: excludedAll,
      excludedCsv: excludedAll.length ? csvOfExcluded() : "",
      settings: {
        filters: cleanFilters(filters),
        languages,
        exclude,
        tab,
        minScore: aboveOnly ? minScore : null,
        approved: all.filter((r) => r.review === "APPROVED").length,
        rejected: all.filter((r) => r.review === "REJECTED").length,
        unticked: unticked.size,
      },
    });

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2 text-sm">
        <span>
          <b>{filename}</b> · {n(rows.length)} row{rows.length === 1 ? "" : "s"} read
        </span>
        <span className="flex flex-wrap items-center gap-3">
          <span className="text-xs text-slate-550">Nothing is saved until you click Import.</span>
          {onChangeColumns && (
            <button type="button" className="text-xs text-accent-ink hover:underline" disabled={importing} onClick={onChangeColumns}>
              Change columns
            </button>
          )}
          <button type="button" className="btn-ghost" aria-label="Back to choosing a file" disabled={importing} onClick={onBack}>
            Back
          </button>
        </span>
      </div>
      {skippedOverLimit > 0 && (
        <div className="mb-3">
          <OverLimitNote totalRows={totalRows} maxRows={maxRows} skippedOverLimit={skippedOverLimit} />
        </div>
      )}
      <p className="mb-3 text-xs text-slate-550">
        Checked with the Data Quality rules and its AI score, as on the Data Quality page. Only the rows you keep go to the {destination}{" "}
        import, which then applies its own rules, duplicates included.
      </p>
      {ai && <AiLine ai={ai} />}

      <div className="card mb-3 space-y-2 p-4">
        <CheckGroup label="Exclude already used data" options={USED_OPTIONS} value={exclude} onChange={setExclude} />
        <p className="text-xs text-slate-550">Ticked: matching rows are left out and not imported. Unticked: they go to the import like any other row.</p>
        {page === "whatsapp" && (
          <p className="rounded-lg bg-surface-muted px-3 py-2 text-xs text-ink">
            WhatsApp numbers already saved in WhatsApp Contacts are excluded by default. Untick “Already in contacts” to import them: the
            import then updates those contacts.
          </p>
        )}
        <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
          <span className="text-slate-550">
            {n(excludedAll.length)} row{excludedAll.length === 1 ? "" : "s"} in this file {excludedAll.length === 1 ? "is" : "are"} excluded as already used.
          </span>
          <button type="button" className="btn-ghost" disabled={excludedAll.length === 0} onClick={() => downloadText(`${base}-excluded.csv`, csvOfExcluded())}>
            Download excluded rows ({n(excludedAll.length)})
          </button>
        </div>
      </div>

      <div className="card mb-3 p-4">
        <CheckGroup label="Language (from the name and business)" options={LANGUAGE_OPTIONS} value={languages} onChange={setLanguages} />
      </div>
      {/* From here down: the Data Quality page's own order (score bar, filter panel, tabs, table). */}
      <DqScoreBar
        minScore={minScore}
        onMinScore={setMinScore}
        atOrAbove={atOrAbove.length}
        below={below.length}
        busy={locked}
        onApprove={() => void byScore("APPROVED")}
        onReject={() => void byScore("REJECTED")}
        aboveOnly={aboveOnly}
        onAboveOnly={setAboveOnly}
        locked={locked}
        note={locked ? "Score filters and review by score open once AI scoring finishes." : null}
      />
      <FilterPanel
        filters={filters}
        onChange={setFilters}
        facets={facets}
        showing={`Showing ${n(shown.length)} of ${n(rows.length)}, ${n(excludedShown)} excluded as already used`}
        busy={false}
        scoreLocked={locked}
        onClear={() => {
          // Back to this page's defaults (WhatsApp: Mobile only; Voicecall: Mobile + Landline), not to blank.
          // "Exclude already used data" is not a filter: it stays as it is.
          setFilters(defaults.filters);
          setLanguages([...defaults.languages]);
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
        <DqRecordTable
          rows={shown}
          rowKey={(r) => r.rowIndex}
          selectAllLabel="Select all rows shown"
          canPick={(r) => isSelectable(r, exclude)}
          isPicked={(r) => !unticked.has(r.rowIndex)}
          onPick={(r) => toggle(r.rowIndex)}
          anyPickable={pickable.length > 0}
          allPicked={pickable.length > 0 && pickable.every((r) => !unticked.has(r.rowIndex))}
          onPickAll={tickAll}
          extraColumns={extraColumns}
          notesBefore={(r) => (
            <>
              {r.importProblem && <div className="text-crit">{r.importProblem}</div>}
              {r.alreadySaved && !reasons.get(r.rowIndex)?.length && <div className="text-warn">Already saved: the import updates it</div>}
            </>
          )}
          hideCode={(r, code) => r.alreadySaved && code === "in_whatsapp"}
          rowClassName={(r) => (reasons.get(r.rowIndex)?.length ? "bg-surface-muted" : undefined)}
        />
      </div>

      {beforeImport ? <div className="mt-3">{beforeImport}</div> : null}
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
          <button type="button" className="btn-primary" disabled={importing || selected.length === 0} onClick={confirmImport}>
            {importing ? "Importing…" : `Import ${n(selected.length)} selected`}
          </button>
        </div>
      </div>
    </div>
  );
}
