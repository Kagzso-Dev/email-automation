// Hard stop (ENABLE_HARD_STOP): the "Hard stop" button, its status line ("Stopping... (N in progress)" → "Stopped"
// with the summary) and the cancelled-rows CSV downloads. Only rendered while the flag is on (useHardStopEnabled).
// Work already in progress (calls, messages, emails) always finishes: there is no hang-up or end-call option.

import { useState, type ReactNode } from "react";
import { useMutation, useQueryClient, type QueryKey } from "@tanstack/react-query";
import { OctagonX } from "lucide-react";
import {
  AI_CALL_LANGUAGE_NAMES,
  DEFAULT_AI_CALL_LANGUAGE,
  HARD_STOP_CONFIRM_TEXT,
  HARD_STOP_CSV_CHANNELS,
  hardStopStatusText,
  type AiCallLanguage,
  type HardStopCsvChannel,
  type HardStopResult,
  type HardStopScope,
  type HardStopSection,
  type HardStopView,
} from "@dispatch/shared";
import { api } from "../lib/api";
import {
  downloadCancelledCsv,
  hardStopPath,
  useHardStopEnabled,
  useLatestHardStop,
  useLatestSectionStop,
  useLatestStopAll,
  type HardStopTargetScope,
} from "../lib/hardStop";
import { formatDateTime } from "../lib/schedule";
import { useConfirm } from "./confirm";
import { HEADER_BUTTON_DANGER } from "./PageHeader";
import { ErrorNote } from "./ui";

const CSV_LABEL: Record<HardStopCsvChannel, string> = { email: "emails", whatsapp: "WhatsApp", calls: "calls" };

/**
 * Pressing a Hard stop: the confirmation (its body is HARD_STOP_CONFIRM_TEXT, word for word), then the POST and the
 * refreshes. Shared by <HardStopButton> and the Send Queue's "More" (danger zone) menu, so both behave the same.
 */
export function useHardStopAction({
  scope,
  targetId,
  label = "Hard stop",
  title,
  invalidate = [],
  onError,
}: {
  scope: HardStopScope;
  targetId: string | null;
  /** Also the confirm button's text. */
  label?: string;
  /** The confirmation's headline. */
  title?: string;
  /** Queries to refresh once the stop is applied (the list the button sits in). */
  invalidate?: QueryKey[];
  /** Callers without room for an inline error (a menu that closes) show it here, e.g. as a toast. */
  onError?: (err: Error) => void;
}) {
  const qc = useQueryClient();
  const confirm = useConfirm();
  const [stop, setStop] = useState<HardStopView | null>(null);
  const press = useMutation({
    mutationFn: () => api<HardStopResult>(hardStopPath(scope, targetId), { method: "POST", notify: "Hard stop applied" }),
    onSuccess: (r) => {
      setStop(r.stop);
      for (const key of invalidate) void qc.invalidateQueries({ queryKey: key });
      void qc.invalidateQueries({ queryKey: ["hard-stop-latest-all"] });
      void qc.invalidateQueries({ queryKey: ["hard-stop-latest-section"] });
      void qc.invalidateQueries({ queryKey: ["hard-stop-latest"] });
    },
    onError,
  });

  async function ask() {
    const ok = await confirm({
      title: title ?? (scope === "ALL" ? "Stop all running sends?" : "Hard stop this send?"),
      body: HARD_STOP_CONFIRM_TEXT,
      confirmText: label,
      tone: "danger",
    });
    if (ok) press.mutate();
  }

  return { ask, press, stop };
}

/** "Hard stop" with the confirmation, word for word. Shows the stop's status once pressed. */
export function HardStopButton({
  scope,
  targetId,
  label = "Hard stop",
  title,
  invalidate = [],
  className = "btn-danger",
  icon,
  wrapperClassName = "inline-flex flex-col items-end gap-1",
}: {
  scope: HardStopScope;
  targetId: string | null;
  label?: string;
  /** The confirmation's headline (the body is always HARD_STOP_CONFIRM_TEXT, word for word). */
  title?: string;
  /** Queries to refresh once the stop is applied (the list the button sits in). */
  invalidate?: QueryKey[];
  className?: string;
  /** Shown before the label (page headers). */
  icon?: ReactNode;
  wrapperClassName?: string;
}) {
  const { ask, press, stop } = useHardStopAction({ scope, targetId, label, title, invalidate });
  const wide = scope === "ALL" || scope === "EMAIL" || scope === "WHATSAPP" || scope === "CALLS";

  return (
    <span className={wrapperClassName}>
      <button
        type="button"
        className={className}
        aria-label={label}
        disabled={press.isPending || (!!stop && !wide)}
        onClick={() => void ask()}
      >
        {icon}
        {press.isPending ? "Stopping…" : label}
      </button>
      {press.error && <ErrorNote error={press.error} />}
      {stop && !wide && targetId && <HardStopTargetStatus scope={scope as HardStopTargetScope} targetId={targetId} />}
    </span>
  );
}

/** The status of the newest stop that covered this send, if any (nothing at all when none). */
export function HardStopTargetStatus({ scope, targetId, compact = false }: { scope: HardStopTargetScope; targetId: string; compact?: boolean }) {
  const q = useLatestHardStop(scope, targetId, true);
  if (!q.data?.stop) return null;
  return <HardStopStatus stop={q.data.stop} compact={compact} />;
}

/** "Stopping... (N in progress)" until the last in-progress item ends, then "Stopped" with the summary. */
export function HardStopStatus({ stop, compact = false }: { stop: HardStopView; compact?: boolean }) {
  const paused = [
    ...stop.paused.campaigns.map((c) => `campaign "${c.name}"`),
    ...stop.paused.triggers.map((t) => `trigger "${t.name}"`),
  ];
  return (
    <div className={`text-xs ${compact ? "" : "rounded-lg border border-line bg-surface-sunken px-3 py-2"}`} role="status">
      <div className={stop.status === "STOPPING" ? "font-medium text-warn" : "font-medium text-ink"}>{hardStopStatusText(stop)}</div>
      {!compact && <div className="mt-0.5 text-slate-550">{stop.reason}</div>}
      {!compact && stop.finishedAt && <div className="text-slate-550">Finished {formatDateTime(stop.finishedAt)}</div>}
      {!compact && paused.length > 0 && (
        <div className="mt-1 text-slate-550">
          Paused so nothing new starts by itself (turn back on with Schedule / the trigger switch): {paused.join(", ")}
        </div>
      )}
      <CancelledCsvLinks stop={stop} />
    </div>
  );
}

/** One "Download cancelled … (CSV, N)" link per channel that has cancelled rows; nothing when there are none. */
export function CancelledCsvLinks({ stop, className = "mt-1 flex flex-wrap gap-x-3 gap-y-1" }: { stop: HardStopView; className?: string }) {
  const [error, setError] = useState<unknown>(null);
  const channels = HARD_STOP_CSV_CHANNELS.filter((c) => stop.csvRows[c] > 0);
  if (channels.length === 0) return null;
  return (
    <>
      <div className={className}>
        {channels.map((c) => (
          <button
            key={c}
            type="button"
            className="text-accent-ink hover:underline"
            onClick={() => {
              setError(null);
              downloadCancelledCsv(stop.id, c).catch(setError);
            }}
          >
            Download cancelled {CSV_LABEL[c]} (CSV, {stop.csvRows[c]})
          </button>
        ))}
      </div>
      {error ? <ErrorNote error={error} /> : null}
    </>
  );
}

const SECTION_LABEL: Record<HardStopSection, (language: AiCallLanguage) => { button: string; title: string }> = {
  EMAIL: () => ({ button: "Hard stop all email", title: "Hard stop every running email send? (WhatsApp and calls continue)" }),
  WHATSAPP: () => ({ button: "Hard stop all WhatsApp", title: "Hard stop every running WhatsApp send? (Email and calls continue)" }),
  CALLS: (lang) => ({
    button: `Hard stop all ${AI_CALL_LANGUAGE_NAMES[lang]} calls`,
    title: `Hard stop every ${AI_CALL_LANGUAGE_NAMES[lang]} call run? (Other languages, email and WhatsApp continue)`,
  }),
};

/** A section's Hard stop wording: the button label and the confirmation's headline. */
export function sectionHardStopLabels(section: HardStopSection, language: AiCallLanguage = DEFAULT_AI_CALL_LANGUAGE) {
  return SECTION_LABEL[section](language);
}

/**
 * One section's Hard stop (Email, WhatsApp, or the calls of one language): the button and that section's latest stop.
 * Renders nothing while ENABLE_HARD_STOP is off, so every page looks exactly as before.
 */
export function SectionHardStopBar({ section, language = DEFAULT_AI_CALL_LANGUAGE }: { section: HardStopSection; language?: AiCallLanguage }) {
  const enabled = useHardStopEnabled();
  if (!enabled) return null;
  return <SectionHardStop section={section} language={language} />;
}

/**
 * A section's Hard stop as a page-header action (PageHeader dangerAction): the button only. Renders nothing while
 * ENABLE_HARD_STOP is off (PageHeader then hides the slot and its divider). Pair it with SectionHardStopStatus.
 */
export function SectionHardStopButton({ section, language = DEFAULT_AI_CALL_LANGUAGE }: { section: HardStopSection; language?: AiCallLanguage }) {
  const enabled = useHardStopEnabled();
  if (!enabled) return null;
  const { button, title } = SECTION_LABEL[section](language);
  return (
    <HardStopButton
      scope={section}
      targetId={section === "CALLS" ? language : null}
      label={button}
      title={title}
      className={HEADER_BUTTON_DANGER}
      wrapperClassName="flex flex-col gap-1 max-sm:w-full"
      icon={<OctagonX size={16} aria-hidden="true" className="shrink-0" />}
    />
  );
}

/** That section's latest stop ("Stopping... / Stopped" and the CSV downloads), as a full-width block under the header. */
export function SectionHardStopStatus({ section, language = DEFAULT_AI_CALL_LANGUAGE }: { section: HardStopSection; language?: AiCallLanguage }) {
  const enabled = useHardStopEnabled();
  if (!enabled) return null;
  return <SectionHardStopLatest section={section} language={language} />;
}

function SectionHardStopLatest({ section, language }: { section: HardStopSection; language: AiCallLanguage }) {
  const latest = useLatestSectionStop(section, section === "CALLS" ? language : null);
  const stop = latest.data?.stop;
  if (!stop) return null;
  return (
    <div className="mb-4">
      <HardStopStatus stop={stop} />
    </div>
  );
}

function SectionHardStop({ section, language }: { section: HardStopSection; language: AiCallLanguage }) {
  const latest = useLatestSectionStop(section, section === "CALLS" ? language : null);
  const stop = latest.data?.stop;
  const { button, title } = SECTION_LABEL[section](language);
  return (
    <div className="mb-4 flex flex-wrap items-start justify-end gap-3">
      {stop && <HardStopStatus stop={stop} />}
      <HardStopButton scope={section} targetId={section === "CALLS" ? language : null} label={button} title={title} />
    </div>
  );
}

/** Admins: "Stop all running sends" (Email, WhatsApp, Calls in every language, Send Queue) and its latest status. */
export function StopAllRunningSends() {
  const latest = useLatestStopAll(true);
  const stop = latest.data?.stop;
  return (
    <div className="mb-4 flex flex-wrap items-start justify-end gap-3">
      {stop && <HardStopStatus stop={stop} />}
      <HardStopButton scope="ALL" targetId={null} label="Stop all running sends" invalidate={[["email-batches"], ["whatsapp-batches"], ["ai-call-followups"]]} />
    </div>
  );
}
