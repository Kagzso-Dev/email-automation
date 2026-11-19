import { useMemo, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AI_CALL_LANGUAGE_NAMES, type AiCallLanguage } from "@dispatch/shared";
import { api } from "../lib/api";
import { withLanguage } from "../lib/aiCallLanguage";
import type { ImportSummary, LanguageImportSummary } from "../lib/aiCallCustomers";
import {
  draftFacets,
  rowsToCsv,
  selectedFileName,
  toDraftRows,
  withExtraValues,
  type DraftCheck,
  type ExtraColumns,
  type ImportSelection,
} from "../lib/importFilter";
import { useDraftAiScoring } from "../lib/importFilterAi";
import { fullNumber } from "../lib/numberFormat";
import { saveUploadHistory } from "../lib/uploadHistory";
import { ImportCountsSummary } from "./ImportSummary";
import { ImportFilterStep } from "./ImportFilterStep";
import { ErrorNote, Modal, Spinner, Table } from "./ui";

// The import filter step on each page (ENABLE_IMPORT_FILTER_STEP). Rows are checked by read-only endpoints
// and held in this component's state; "Import N selected" sends only the chosen rows to the page's EXISTING
// importer, unchanged: WhatsApp → POST /api/whatsapp/contacts/import (the chosen rows as a CSV with the
// file's own columns), Voicecall → POST /api/ai-call-customers/import (or /import-to-languages), exactly the
// request the page makes today. Only after the importer answered is the upload written to Upload History
// (POST /api/upload-history); if that fails the import stands and a warning is shown. Back or Close drops
// everything; nothing was saved.

const n = (v: number) => fullNumber.format(v);
const newDraftId = () => `${Date.now()}-${Math.random().toString(36).slice(2)}`;

function Checking({ what }: { what: string }) {
  return (
    <div className="py-6 text-center text-sm text-slate-550">
      <Spinner />
      <p className="mt-2">{what}</p>
    </div>
  );
}

function CheckFailed({ error, onBack }: { error: unknown; onBack: () => void }) {
  return (
    <div>
      <ErrorNote error={error} />
      <div className="mt-4 flex justify-end">
        <button type="button" className="btn-ghost" onClick={onBack}>
          Back
        </button>
      </div>
    </div>
  );
}

function HistoryNote({ warning }: { warning: string | null }) {
  return warning ? (
    <p role="note" className="mt-3 rounded-lg border border-warn/40 bg-warn-soft px-3 py-2 text-sm text-warn">
      {warning}
    </p>
  ) : (
    <p className="mt-3 text-xs text-slate-550">Saved to Upload History.</p>
  );
}

function DoneButton({ onClose }: { onClose: () => void }) {
  return (
    <div className="mt-4 flex justify-end">
      <button type="button" className="btn-primary" onClick={onClose}>
        Done
      </button>
    </div>
  );
}

/* ------------------------------------------------------------------ WhatsApp Contacts */

interface WhatsAppPreview {
  filename: string;
  headers: string[];
  rows: Record<string, string>[];
  totalRows: number;
  maxRows: number;
  truncated: boolean;
  checks: (DraftCheck & { importable: boolean; importProblem: string | null; alreadySaved: boolean })[];
  /** The city / category / source / date columns (absent on an older API = no dropdowns). */
  extraColumns?: ExtraColumns;
}

/** The WhatsApp importer's answer (POST /api/whatsapp/contacts/import). */
interface WhatsAppImportResult {
  created: number;
  updated: number;
  duplicates: number;
  failed: number;
}

/** WhatsApp Contacts → Import file, with the filter step. `file` set = open. */
export function WhatsAppImportFilter({ file, onClose, onBack }: { file: File | null; onClose: () => void; onBack: () => void }) {
  return (
    <Modal open={!!file} onClose={onClose} title="Import WhatsApp contacts" wide extraWide>
      {file ? <WhatsAppFlow file={file} onClose={onClose} onBack={onBack} /> : null}
    </Modal>
  );
}

interface WhatsAppDone {
  result: WhatsAppImportResult;
  imported: number;
  failed: number;
  excluded: number;
  filteredOut: number;
  historyWarning: string | null;
}

function WhatsAppFlow({ file, onClose, onBack }: { file: File; onClose: () => void; onBack: () => void }) {
  const qc = useQueryClient();
  const [draftId] = useState(newDraftId);
  const preview = useQuery({
    queryKey: ["import-filter", "whatsapp", draftId],
    queryFn: () => {
      const fd = new FormData();
      fd.append("file", file);
      return api<WhatsAppPreview>("/api/import-filter/whatsapp/preview", { method: "POST", body: fd, notify: false });
    },
    staleTime: Infinity,
    gcTime: 0,
    retry: false,
    refetchOnWindowFocus: false,
  });
  const rows = useMemo(
    () => (preview.data ? withExtraValues(toDraftRows(preview.data.checks), preview.data.rows, preview.data.extraColumns) : []),
    [preview.data],
  );
  const facets = useMemo(
    () => (preview.data?.extraColumns ? draftFacets(preview.data.headers, preview.data.rows, preview.data.extraColumns) : undefined),
    [preview.data],
  );
  const [done, setDone] = useState<WhatsAppDone | null>(null);
  const doImport = useMutation({
    mutationFn: async (sel: ImportSelection): Promise<WhatsAppDone> => {
      const p = preview.data!;
      const csv = rowsToCsv(p.headers, sel.rowIndexes.map((i) => p.rows[i]!));
      const fd = new FormData();
      fd.append("file", new File([csv], selectedFileName(p.filename), { type: "text/csv" }));
      const result = await api<WhatsAppImportResult>("/api/whatsapp/contacts/import", { method: "POST", body: fd, notify: false });

      // Every row read is counted once: excluded (already used) → no WhatsApp number → filtered out → sent.
      const excludedIdx = new Set(sel.excluded.map((r) => r.rowIndex));
      const noNumber = rows.filter((r) => !r.importable && !excludedIdx.has(r.rowIndex)).length;
      const filteredOut = rows.length - excludedIdx.size - noNumber - sel.rowIndexes.length;
      const counts = { imported: result.created + result.updated, failed: noNumber + result.failed, excluded: excludedIdx.size, filteredOut };
      const historyWarning = await saveUploadHistory(
        {
          fileName: p.filename,
          channel: "whatsapp",
          language: null,
          totalRows: p.totalRows,
          imported: counts.imported,
          excludedUsed: counts.excluded,
          filteredOut,
          duplicates: result.duplicates,
          failed: counts.failed,
          skippedOverLimit: Math.max(0, p.totalRows - p.rows.length),
          excludedRows: excludedIdx.size,
          filters: sel.settings,
          result,
        },
        sel.excludedCsv,
      );
      return { result, ...counts, historyWarning };
    },
    onSuccess: (r) => {
      setDone(r);
      void qc.invalidateQueries({ queryKey: ["whatsapp-contacts"] });
      void qc.invalidateQueries({ queryKey: ["upload-history"] });
    },
  });

  // Data Quality's AI score, a few rows at a time (nothing saved); paused while importing, over once imported.
  const ai = useDraftAiScoring(rows, !done && !doImport.isPending);

  if (preview.isLoading) return <Checking what="Reading and checking the file…" />;
  if (preview.error || !preview.data) return <CheckFailed error={preview.error} onBack={onBack} />;
  const p = preview.data;

  if (done) {
    const { result: r } = done;
    return (
      <div>
        <ImportCountsSummary
          counts={{
            totalRows: p.totalRows,
            maxRows: p.maxRows,
            selectedRows: rows.length - done.filteredOut - done.excluded,
            imported: done.imported,
            failed: done.failed,
            duplicates: r.duplicates,
            skippedOverLimit: Math.max(0, p.totalRows - p.rows.length),
          }}
          extra={[
            { label: "Excluded (already used)", value: done.excluded },
            { label: "Filtered out", value: done.filteredOut },
          ]}
          details={[
            `Imported: ${n(r.created)} new, ${n(r.updated)} already saved (updated)`,
            done.failed ? `${n(done.failed)} without a usable phone number` : null,
            r.duplicates ? `${n(r.duplicates)} repeating a number from an earlier row (applied to that contact)` : null,
            done.excluded ? `${n(done.excluded)} excluded as already used` : null,
            done.filteredOut ? `${n(done.filteredOut)} left out by the filters` : null,
          ]
            .filter(Boolean)
            .join(" · ")}
        />
        <HistoryNote warning={done.historyWarning} />
        <DoneButton onClose={onClose} />
      </div>
    );
  }

  return (
    <ImportFilterStep
      page="whatsapp"
      filename={p.filename}
      headers={p.headers}
      rawRows={p.rows}
      rows={ai.rows}
      ai={ai.progress}
      totalRows={p.totalRows}
      maxRows={p.maxRows}
      facets={facets}
      destination="WhatsApp Contacts"
      importing={doImport.isPending}
      error={doImport.error}
      onBack={onBack}
      onImport={(sel) => doImport.mutate(sel)}
    />
  );
}

/* ------------------------------------------------------------------ Voicecall Contact (every language) */

/** One mapped row, as the Voicecall import sends it today. */
export interface VoicecallImportRow {
  customerName: string;
  gender: string;
  phone: string;
  businessName: string;
  followUpDetail: string;
  email: string;
  whatsappOptIn: boolean;
}

export interface VoicecallImportFilterProps {
  filename: string;
  /** The file's columns and rows as read (for "Download excluded rows"). */
  headers: string[];
  rawRows: Record<string, string>[];
  rows: VoicecallImportRow[];
  /** The page's own row check, per row (rows with errors or a repeated number are not sent today). */
  checks: { errors: string[]; duplicate: boolean }[];
  totalRows: number;
  maxRows: number;
  /** This page's list. */
  language: AiCallLanguage;
  /** Admins: other lists picked under "Also import into other languages". */
  also: AiCallLanguage[];
  onBack: () => void;
  onClose: () => void;
  /** Back to the column matching (a link in the step's header). */
  onChangeColumns?: () => void;
  /** Shown just above the Import button (admins: "Also import into other languages"). */
  beforeImport?: ReactNode;
}

const SAME_NUMBER = "Same number as an earlier row: skipped, as today";

/** Importable = exactly the rows the page sends today (no errors, not a repeated number); otherwise why not. */
const rowProblem = (c: { errors: string[]; duplicate: boolean } | undefined): string | null =>
  !c ? null : c.errors.length ? c.errors.join("; ") : c.duplicate ? SAME_NUMBER : null;

interface VoicecallDone {
  one?: ImportSummary;
  many?: LanguageImportSummary[];
  imported: number;
  failed: number;
  duplicates: number;
  doNotCall: number;
  excluded: number;
  filteredOut: number;
  invalid: number;
  repeated: number;
  historyWarning: string | null;
}

/** Voicecall Contact → Import file → the filter step (columns matched automatically; "Change columns" to fix them). */
export function VoicecallImportFilter({
  filename,
  headers,
  rawRows,
  rows,
  checks,
  totalRows,
  maxRows,
  language,
  also,
  onBack,
  onClose,
  onChangeColumns,
  beforeImport,
}: VoicecallImportFilterProps) {
  const qc = useQueryClient();
  const [draftId] = useState(newDraftId);
  const check = useQuery({
    queryKey: ["import-filter", "voicecall", draftId],
    queryFn: () =>
      api<{ checks: DraftCheck[]; extraColumns?: ExtraColumns }>("/api/import-filter/voicecall/check", {
        method: "POST",
        json: {
          rows: rows.map((r) => ({ name: r.customerName || null, phone: r.phone || null, business: r.businessName || null, email: r.email || null })),
          language,
          headers, // only to find the city / category / source / date columns
        },
        notify: false,
      }),
    staleTime: Infinity,
    gcTime: 0,
    retry: false,
    refetchOnWindowFocus: false,
  });
  const draft = useMemo(
    () => (check.data ? withExtraValues(toDraftRows(check.data.checks, (i) => rowProblem(checks[i])), rawRows, check.data.extraColumns) : []),
    [check.data, checks, rawRows],
  );
  const facets = useMemo(
    () => (check.data?.extraColumns ? draftFacets(headers, rawRows, check.data.extraColumns) : undefined),
    [check.data, headers, rawRows],
  );
  const [done, setDone] = useState<VoicecallDone | null>(null);
  const doImport = useMutation({
    mutationFn: async (sel: ImportSelection): Promise<VoicecallDone> => {
      const chosen = sel.rowIndexes.map((i) => rows[i]!);
      let one: ImportSummary | undefined;
      let many: LanguageImportSummary[] | undefined;
      if (also.length === 0) {
        one = await api<ImportSummary>(withLanguage("/api/ai-call-customers/import", language), { method: "POST", json: { rows: chosen }, notify: false });
      } else {
        many = (
          await api<{ results: LanguageImportSummary[] }>("/api/ai-call-customers/import-to-languages", {
            method: "POST",
            json: { rows: chosen, languages: [language, ...also] },
            notify: false,
          })
        ).results;
      }

      // Every row read is counted once: excluded (already used) → invalid / repeated (skipped, as today) →
      // filtered out → sent (then the importer's own imported / skipped / duplicates).
      const excludedIdx = new Set(sel.excluded.map((r) => r.rowIndex));
      const kept = checks.filter((_, i) => !excludedIdx.has(i));
      const invalid = kept.filter((c) => c.errors.length > 0).length;
      const repeated = kept.filter((c) => c.errors.length === 0 && c.duplicate).length;
      const filteredOut = rows.length - excludedIdx.size - invalid - repeated - chosen.length;
      const sum = (k: "imported" | "skipped" | "duplicates" | "doNotCall") => (one ? one[k] : (many ?? []).reduce((s, r) => s + r[k], 0));
      const counts = {
        imported: sum("imported"),
        failed: invalid + sum("skipped"),
        duplicates: repeated + sum("duplicates"),
        doNotCall: sum("doNotCall"),
        excluded: excludedIdx.size,
        filteredOut,
        invalid,
        repeated,
      };
      const historyWarning = await saveUploadHistory(
        {
          fileName: filename,
          channel: "voicecall",
          language,
          totalRows,
          imported: counts.imported,
          excludedUsed: counts.excluded,
          filteredOut,
          duplicates: counts.duplicates,
          failed: counts.failed,
          skippedOverLimit: Math.max(0, totalRows - rows.length),
          excludedRows: excludedIdx.size,
          filters: sel.settings,
          result: one ?? { languages: many },
        },
        sel.excludedCsv,
      );
      return { one, many, ...counts, historyWarning };
    },
    onSuccess: (r) => {
      setDone(r);
      void qc.invalidateQueries({ queryKey: ["ai-call-customers"] });
      void qc.invalidateQueries({ queryKey: ["upload-history"] });
    },
  });

  // Data Quality's AI score, a few rows at a time (nothing saved); paused while importing, over once imported.
  const ai = useDraftAiScoring(draft, !done && !doImport.isPending);

  if (check.isLoading) return <Checking what="Checking the rows…" />;
  if (check.error || !check.data) return <CheckFailed error={check.error} onBack={onBack} />;

  if (done) {
    const skippedOverLimit = Math.max(0, totalRows - rows.length);
    if (done.many) {
      return (
        <div>
          <p className="mb-2 text-sm text-slate-550">
            Each language list is imported on its own; a number already in a list is a duplicate there.
            {done.invalid > 0 || done.repeated > 0 ? ` ${n(done.invalid)} invalid and ${n(done.repeated)} repeated rows in the file were skipped for every list.` : ""}
            {done.excluded > 0 ? ` ${n(done.excluded)} rows were excluded as already used.` : ""}
            {done.filteredOut > 0 ? ` ${n(done.filteredOut)} rows were left out by the filters.` : ""}
          </p>
          <Table head={["Language", "Imported", "Duplicates", "Do not call", "Problem"]}>
            {done.many.map((r) => (
              <tr key={r.language} className="border-b border-line-subtle last:border-0">
                <td className="px-4 py-2 font-medium">{AI_CALL_LANGUAGE_NAMES[r.language]}</td>
                <td className="px-4 py-2 font-mono">{r.imported}</td>
                <td className="px-4 py-2 font-mono">{r.duplicates}</td>
                <td className="px-4 py-2 font-mono">{r.doNotCall}</td>
                <td className="px-4 py-2 text-xs text-crit">{r.failed ? "Failed — nothing imported into this list; try again" : ""}</td>
              </tr>
            ))}
          </Table>
          <HistoryNote warning={done.historyWarning} />
          <DoneButton onClose={onClose} />
        </div>
      );
    }
    return (
      <div>
        <ImportCountsSummary
          counts={{
            totalRows,
            maxRows,
            selectedRows: rows.length - done.filteredOut - done.excluded,
            imported: done.imported,
            failed: done.failed,
            duplicates: done.duplicates,
            skippedOverLimit,
          }}
          extra={[
            { label: "Do not call", value: done.doNotCall, tone: done.doNotCall ? "warn" : "neutral" },
            { label: "Excluded (already used)", value: done.excluded },
            { label: "Filtered out", value: done.filteredOut },
          ]}
        />
        {done.doNotCall > 0 && (
          <p className="mt-3 text-sm text-slate-550">Numbers already on the do-not-call list were saved as “Do not call” and will never be dialled.</p>
        )}
        <HistoryNote warning={done.historyWarning} />
        <DoneButton onClose={onClose} />
      </div>
    );
  }

  return (
    <ImportFilterStep
      page="voicecall"
      filename={filename}
      headers={headers}
      rawRows={rawRows}
      rows={ai.rows}
      ai={ai.progress}
      totalRows={totalRows}
      maxRows={maxRows}
      facets={facets}
      destination="Voicecall Contact"
      importing={doImport.isPending}
      error={doImport.error}
      onBack={onBack}
      onImport={(sel) => doImport.mutate(sel)}
      onChangeColumns={onChangeColumns}
      beforeImport={beforeImport}
    />
  );
}
