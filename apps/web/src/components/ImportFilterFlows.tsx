import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AI_CALL_LANGUAGE_NAMES, type AiCallLanguage } from "@dispatch/shared";
import { api } from "../lib/api";
import { withLanguage } from "../lib/aiCallLanguage";
import type { ImportSummary, LanguageImportSummary } from "../lib/aiCallCustomers";
import { rowsToCsv, selectedFileName, toDraftRows, type DraftCheck } from "../lib/importFilter";
import { fullNumber } from "../lib/numberFormat";
import { ImportCountsSummary } from "./ImportSummary";
import { ImportFilterStep } from "./ImportFilterStep";
import { ErrorNote, Modal, Spinner, Table } from "./ui";

// The import filter step on each page (ENABLE_IMPORT_FILTER_STEP). Rows are checked by read-only endpoints
// and held in this component's state; "Import N selected" sends only the chosen rows to the page's EXISTING
// importer, unchanged: WhatsApp → POST /api/whatsapp/contacts/import (the chosen rows as a CSV with the
// file's own columns), Voicecall → POST /api/ai-call-customers/import (or /import-to-languages), exactly the
// request the page makes today. Back or Close drops everything; nothing was saved.

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

/* ------------------------------------------------------------------ WhatsApp Contacts */

interface WhatsAppPreview {
  filename: string;
  headers: string[];
  rows: Record<string, string>[];
  totalRows: number;
  maxRows: number;
  truncated: boolean;
  checks: (DraftCheck & { importable: boolean; importProblem: string | null; alreadySaved: boolean })[];
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
    <Modal open={!!file} onClose={onClose} title="Import WhatsApp contacts" wide>
      {file ? <WhatsAppFlow file={file} onClose={onClose} onBack={onBack} /> : null}
    </Modal>
  );
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
  const rows = useMemo(() => (preview.data ? toDraftRows(preview.data.checks) : []), [preview.data]);
  const [done, setDone] = useState<{ result: WhatsAppImportResult; sent: number } | null>(null);
  const doImport = useMutation({
    mutationFn: async (rowIndexes: number[]) => {
      const p = preview.data!;
      const csv = rowsToCsv(p.headers, rowIndexes.map((i) => p.rows[i]!));
      const fd = new FormData();
      fd.append("file", new File([csv], selectedFileName(p.filename), { type: "text/csv" }));
      const result = await api<WhatsAppImportResult>("/api/whatsapp/contacts/import", { method: "POST", body: fd, notify: false });
      return { result, sent: rowIndexes.length };
    },
    onSuccess: (r) => {
      setDone(r);
      void qc.invalidateQueries({ queryKey: ["whatsapp-contacts"] });
    },
  });

  if (preview.isLoading) return <Checking what="Reading and checking the file…" />;
  if (preview.error || !preview.data) return <CheckFailed error={preview.error} onBack={onBack} />;
  const p = preview.data;

  if (done) {
    const { result: r, sent } = done;
    const noNumber = rows.filter((x) => !x.importable).length; // the importer reports these as failed
    const filteredOut = rows.length - noNumber - sent;
    return (
      <div>
        <ImportCountsSummary
          counts={{
            totalRows: p.totalRows,
            maxRows: p.maxRows,
            selectedRows: rows.length - filteredOut,
            imported: r.created + r.updated,
            failed: noNumber + r.failed,
            duplicates: r.duplicates,
            skippedOverLimit: Math.max(0, p.totalRows - p.rows.length),
          }}
          extra={[{ label: "Filtered out", value: filteredOut }]}
          details={[
            `Imported: ${n(r.created)} new, ${n(r.updated)} already saved (updated)`,
            noNumber + r.failed ? `${n(noNumber + r.failed)} without a usable phone number` : null,
            r.duplicates ? `${n(r.duplicates)} repeating a number from an earlier row (applied to that contact)` : null,
            filteredOut ? `${n(filteredOut)} left out by the filters` : null,
          ]
            .filter(Boolean)
            .join(" · ")}
        />
        <div className="mt-4 flex justify-end">
          <button type="button" className="btn-primary" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    );
  }

  return (
    <ImportFilterStep
      page="whatsapp"
      filename={p.filename}
      rows={rows}
      totalRows={p.totalRows}
      maxRows={p.maxRows}
      destination="WhatsApp Contacts"
      importing={doImport.isPending}
      error={doImport.error}
      onBack={onBack}
      onImport={(idx) => doImport.mutate(idx)}
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
  rows: VoicecallImportRow[];
  /** The page's own row check, per row (rows with errors or a repeated number are not sent today). */
  checks: { errors: string[]; duplicate: boolean }[];
  totalRows: number;
  maxRows: number;
  /** This page's list. */
  language: AiCallLanguage;
  /** Admins: other lists picked on the mapping screen ("Also import into other languages"). */
  also: AiCallLanguage[];
  onBack: () => void;
  onClose: () => void;
}

const SAME_NUMBER = "Same number as an earlier row: skipped, as today";

/** Importable = exactly the rows the page sends today (no errors, not a repeated number); otherwise why not. */
const rowProblem = (c: { errors: string[]; duplicate: boolean } | undefined): string | null =>
  !c ? null : c.errors.length ? c.errors.join("; ") : c.duplicate ? SAME_NUMBER : null;

/** Voicecall Contact → Import file → after the column mapping: the filter step. */
export function VoicecallImportFilter({ filename, rows, checks, totalRows, maxRows, language, also, onBack, onClose }: VoicecallImportFilterProps) {
  const qc = useQueryClient();
  const [draftId] = useState(newDraftId);
  const check = useQuery({
    queryKey: ["import-filter", "voicecall", draftId],
    queryFn: () =>
      api<{ checks: DraftCheck[] }>("/api/import-filter/voicecall/check", {
        method: "POST",
        json: { rows: rows.map((r) => ({ name: r.customerName || null, phone: r.phone || null, business: r.businessName || null, email: r.email || null })) },
        notify: false,
      }),
    staleTime: Infinity,
    gcTime: 0,
    retry: false,
    refetchOnWindowFocus: false,
  });
  const draft = useMemo(() => (check.data ? toDraftRows(check.data.checks, (i) => rowProblem(checks[i])) : []), [check.data, checks]);
  const [done, setDone] = useState<{ one?: ImportSummary; many?: LanguageImportSummary[]; sent: number } | null>(null);
  const doImport = useMutation({
    mutationFn: async (rowIndexes: number[]) => {
      const chosen = rowIndexes.map((i) => rows[i]!);
      if (also.length === 0) {
        const one = await api<ImportSummary>(withLanguage("/api/ai-call-customers/import", language), { method: "POST", json: { rows: chosen }, notify: false });
        return { one, sent: chosen.length };
      }
      const r = await api<{ results: LanguageImportSummary[] }>("/api/ai-call-customers/import-to-languages", {
        method: "POST",
        json: { rows: chosen, languages: [language, ...also] },
        notify: false,
      });
      return { many: r.results, sent: chosen.length };
    },
    onSuccess: (r) => {
      setDone(r);
      void qc.invalidateQueries({ queryKey: ["ai-call-customers"] });
    },
  });

  if (check.isLoading) return <Checking what="Checking the rows…" />;
  if (check.error || !check.data) return <CheckFailed error={check.error} onBack={onBack} />;

  if (done) {
    const invalid = checks.filter((c) => c.errors.length > 0).length;
    const repeated = checks.filter((c) => c.errors.length === 0 && c.duplicate).length;
    const filteredOut = rows.length - invalid - repeated - done.sent;
    const skippedOverLimit = Math.max(0, totalRows - rows.length);
    const doneButton = (
      <div className="mt-4 flex justify-end">
        <button type="button" className="btn-primary" onClick={onClose}>
          Done
        </button>
      </div>
    );
    if (done.many) {
      return (
        <div>
          <p className="mb-2 text-sm text-slate-550">
            Each language list is imported on its own; a number already in a list is a duplicate there.
            {invalid > 0 || repeated > 0 ? ` ${n(invalid)} invalid and ${n(repeated)} repeated rows in the file were skipped for every list.` : ""}
            {filteredOut > 0 ? ` ${n(filteredOut)} rows were left out by the filters.` : ""}
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
          {doneButton}
        </div>
      );
    }
    const one = done.one!;
    return (
      <div>
        <ImportCountsSummary
          counts={{
            totalRows,
            maxRows,
            selectedRows: rows.length - filteredOut,
            imported: one.imported,
            failed: invalid + one.skipped,
            duplicates: repeated + one.duplicates,
            skippedOverLimit,
          }}
          extra={[
            { label: "Do not call", value: one.doNotCall, tone: one.doNotCall ? "warn" : "neutral" },
            { label: "Filtered out", value: filteredOut },
          ]}
        />
        {one.doNotCall > 0 && (
          <p className="mt-3 text-sm text-slate-550">Numbers already on the do-not-call list were saved as “Do not call” and will never be dialled.</p>
        )}
        {doneButton}
      </div>
    );
  }

  return (
    <ImportFilterStep
      page="voicecall"
      filename={filename}
      rows={draft}
      totalRows={totalRows}
      maxRows={maxRows}
      destination="Voicecall Contact"
      importing={doImport.isPending}
      error={doImport.error}
      onBack={onBack}
      onImport={(idx) => doImport.mutate(idx)}
    />
  );
}
