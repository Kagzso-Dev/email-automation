import { useRef, useState } from "react";
import { ErrorNote, Modal } from "./ui";
import { Icon } from "./icons";
import { useToast } from "./toast";
import { analyzeAgainstHistory, downloadFiltered, type HistoryAnalysis, type HistoryChannel } from "../lib/historyFilter";
import { fullNumber as full } from "../lib/numberFormat";
import { useBranding } from "../lib/branding";

const CHANNEL_TEXT: Record<HistoryChannel, { label: string; field: string; history: string }> = {
  email: { label: "Email", field: "email", history: "email send history (Send Queue batches, campaigns and triggers)" },
  whatsapp: { label: "WhatsApp", field: "phone", history: "WhatsApp send history (bulk batches and Inbox replies)" },
  "ai-call": { label: "AI Call", field: "phone", history: "AI call history (every call placed)" },
};


/**
 * Send Queue → "Upload new file": upload a csv / xlsx, compare it with this
 * channel's history only, and download the never-used rows (plus a report of the
 * already-used ones). Read-only — nothing in the app changes.
 */
export function FilterNewDataButton({ channel }: { channel: HistoryChannel }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        className="btn-primary queue-action"
        title="Upload a file to filter out data that was already sent"
        onClick={() => setOpen(true)}
      >
        <Icon name="download" size={16} className="rotate-180" /> Upload new file
      </button>
      {open && <FilterNewDataDialog channel={channel} onClose={() => setOpen(false)} />}
    </>
  );
}

function FilterNewDataDialog({ channel, onClose }: { channel: HistoryChannel; onClose: () => void }) {
  const { appName } = useBranding();
  const t = CHANNEL_TEXT[channel];
  const toast = useToast();
  const input = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [result, setResult] = useState<HistoryAnalysis | null>(null);
  const [busy, setBusy] = useState<null | "analyze" | "new" | "used">(null);
  const [error, setError] = useState<unknown>(null);

  async function analyze(f: File, column?: number | null) {
    setBusy("analyze");
    setError(null);
    try {
      setResult(await analyzeAgainstHistory(channel, f, column));
    } catch (e) {
      setError(e);
      if (column === undefined) setResult(null);
    } finally {
      setBusy(null);
    }
  }

  async function download(part: "new" | "used") {
    if (!file || result?.column == null) return;
    setBusy(part);
    try {
      await downloadFiltered(channel, file, result.column, part);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Download failed");
    } finally {
      setBusy(null);
    }
  }

  const s = result?.summary ?? null;
  const columnLabel = (i: number) => result?.headers[i] || `Column ${i + 1}`;

  return (
    <Modal open onClose={onClose} title={`Filter new ${t.label} data`} wide>
      <div className="space-y-5 text-sm">
        <p className="leading-[1.6] text-slate-550">
          Upload a .csv or .xlsx file. It's compared only with the {t.history}. Sent, done and still-sending entries count as
          already used; failed ones stay in the new file so you can retry them. Nothing in {appName} is changed.
        </p>

        <div className="flex flex-wrap items-center gap-3">
          <input
            ref={input}
            type="file"
            accept=".csv,.xlsx"
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0] ?? null;
              e.target.value = "";
              if (!f) return;
              setFile(f);
              setResult(null);
              void analyze(f);
            }}
          />
          <button type="button" className="btn-primary" disabled={busy !== null} onClick={() => input.current?.click()}>
            {file ? "Choose another file" : "Choose file"}
          </button>
          {file && (
            <span className="min-w-0 truncate text-slate-550" title={file.name}>
              {file.name}
            </span>
          )}
          {busy === "analyze" && <span className="text-xs text-slate-400">Checking…</span>}
        </div>

        {error ? <ErrorNote error={error} /> : null}

        {result && (
          <div>
            <label className="label" htmlFor="history-filter-column">
              Column with the {t.field}
            </label>
            <select
              id="history-filter-column"
              className="input sm:max-w-sm"
              value={result.column ?? ""}
              disabled={busy !== null}
              onChange={(e) => file && e.target.value !== "" && void analyze(file, Number(e.target.value))}
            >
              {result.column === null && <option value="">Pick a column…</option>}
              {result.headers.map((_, i) => (
                <option key={i} value={i}>
                  {columnLabel(i)}
                  {i === result.detected ? " (detected)" : ""}
                </option>
              ))}
            </select>
            {result.column === null ? (
              <p className="mt-1.5 text-xs text-warn">No column looks like a {t.field} — pick the right one.</p>
            ) : result.ambiguous && result.column === result.detected ? (
              <p className="mt-1.5 text-xs text-warn">
                Not sure this is the right column{result.candidates.length > 1 ? ` — ${result.candidates.length} columns could match` : ""}.
                Please confirm or change it.
              </p>
            ) : null}
          </div>
        )}

        {s && (
          <>
            <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-6">
              <SummaryTile label="Total rows" value={s.total} />
              <SummaryTile label="Invalid" value={s.invalid} tone={s.invalid ? "warn" : undefined} />
              <SummaryTile label="Duplicates in file" value={s.duplicates} />
              <SummaryTile label="Already used" value={s.alreadyUsed} />
              <SummaryTile label="Failed before" value={s.failed} hint="kept in new" />
              <SummaryTile label="New" value={s.newCount} tone="ok" />
            </div>
            {s.truncated && (
              <p className="rounded-lg border border-warn-bright/30 bg-warn-soft px-3 py-2 text-xs text-warn">
                Only the first 100,000 rows were checked. Split the file to check the rest.
              </p>
            )}
            <div className="flex flex-wrap gap-2 border-t border-line-subtle pt-4">
              <button type="button" className="btn-primary" disabled={busy !== null || s.newCount === 0} onClick={() => void download("new")}>
                <Icon name="download" size={16} />
                {busy === "new" ? "Preparing…" : `Download new only (${full.format(s.newCount)})`}
              </button>
              <button type="button" className="btn-ghost" disabled={busy !== null || s.alreadyUsed === 0} onClick={() => void download("used")}>
                <Icon name="download" size={16} />
                {busy === "used" ? "Preparing…" : `Already-used report (${full.format(s.alreadyUsed)})`}
              </button>
            </div>
            <p className="text-xs leading-[1.6] text-slate-400">
              Downloads keep your original columns and file type ({result?.format}). Invalid and duplicate rows are left out of
              both; the report adds a “Previous status” column.
            </p>
          </>
        )}
      </div>
    </Modal>
  );
}

function SummaryTile({ label, value, tone, hint }: { label: string; value: number; tone?: "ok" | "warn"; hint?: string }) {
  const color = tone === "ok" ? "text-ok" : tone === "warn" ? "text-warn" : "text-ink";
  return (
    <div className="rounded-xl border border-line/70 bg-surface-sunken px-3 py-2.5">
      <div className="text-[11px] font-semibold uppercase tracking-[0.06em] text-slate-500">{label}</div>
      <div className={`mt-1 font-mono text-xl font-semibold tabular-nums ${color}`}>{full.format(value)}</div>
      {hint && <div className="text-[11px] text-slate-500">{hint}</div>}
    </div>
  );
}
