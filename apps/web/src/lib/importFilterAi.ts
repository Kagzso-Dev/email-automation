// Import filter step: Data Quality's AI score on the rows of the file, while they are only in the browser.
// The valid rows (Data Quality scores only valid rows) go to POST /api/import-filter/ai-score a few at a time; only
// their name, business name and rules score are sent. Nothing is saved. The rules match the Data Quality worker
// (queue/dataQuality.ts): a pause between batches, wait when rate limited or while live AI calls run, stop when
// the service is down, the key is refused, or 5 rows failed. Rows not scored keep the rules score.

import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "./api";
import type { AiProvider, DqRecord, DqTier } from "./dataQuality";
import type { DraftRow } from "./importFilter";

/** GET /api/import-filter/ai */
export interface DraftAiInfo {
  available: boolean;
  provider: AiProvider;
  label: string;
  model: string | null;
  reason: string | null;
  minGapMs: number;
  maxFailures: number;
  batchSize: number;
  liveCalls: boolean;
}

interface AiResult {
  aiState: "DONE" | "ERROR";
  aiScore: number | null;
  aiNotes: string | null;
  score: number | null;
  tier: DqTier | null;
}
interface AiAnswer {
  results: AiResult[];
  wait?: { ms: number; reason: string };
  stop?: string;
}

/** starting = asking whether the service is up; off = not available (only the standard checks). */
export type AiRunState = "starting" | "running" | "waiting" | "done" | "stopped" | "off";

export interface AiProgress {
  state: AiRunState;
  /** Valid rows scored / failed / to score. */
  done: number;
  failed: number;
  total: number;
  /** Why it waits or stopped, or why it is off. */
  note: string | null;
  info: DraftAiInfo | null;
}

/** Score filters and review by score wait until the AI score is in (or will not come). */
export const aiBusy = (p: AiProgress | undefined) => !!p && (p.state === "starting" || p.state === "running" || p.state === "waiting");

/** The Data Quality page's own wording ("3 of 10 scored", "Scored 10 of 10"). */
export function aiProgressLine(p: AiProgress): string {
  if (p.state === "done") return p.total ? `Scored ${p.done} of ${p.total}` : "Nothing to score";
  return `${p.done} of ${p.total} scored${p.failed ? `, ${p.failed} failed` : ""}`;
}

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const errText = (err: unknown) => (err instanceof Error ? err.message : String(err));

/**
 * Score the valid rows while `active` (pauses while an import runs and stops for good once it is done; picks up
 * where it left off). Returns the rows with their AI score, overall score and tier filled in, and the progress.
 */
export function useDraftAiScoring(rows: DraftRow[], active: boolean): { rows: DraftRow[]; progress: AiProgress } {
  const valid = useMemo(() => rows.filter((r) => r.status === "VALID"), [rows]);
  const [results, setResults] = useState<ReadonlyMap<number, AiResult>>(new Map());
  const [progress, setProgress] = useState<AiProgress>({ state: "starting", done: 0, failed: 0, total: valid.length, note: null, info: null });
  const scored = useRef(new Map<number, AiResult>());
  const lastError = useRef<string | null>(null);
  const finished = useRef(false);

  useEffect(() => {
    // No rows yet = the file is still being read and checked (the hook runs before that answer is in).
    if (!active || finished.current || rows.length === 0) return;
    let alive = true;
    const counts = () => {
      let done = 0;
      let failed = 0;
      for (const r of scored.current.values()) {
        if (r.aiState === "DONE") done++;
        else failed++;
      }
      return { done, failed };
    };
    const update = (p: Partial<AiProgress>) => {
      if (alive) setProgress((prev) => ({ ...prev, ...p }));
    };
    const finish = (p: Partial<AiProgress>) => {
      if (!alive) return;
      finished.current = true;
      update({ ...counts(), ...p });
    };

    void (async () => {
      const total = valid.length;
      if (total === 0) return finish({ state: "done", total: 0 });
      let info: DraftAiInfo;
      try {
        info = await api<DraftAiInfo>("/api/import-filter/ai", { notify: false });
      } catch (err) {
        return finish({ state: "off", total, note: `AI score not available: ${errText(err)}. Only the standard checks run.` });
      }
      if (!alive) return;
      if (!info?.available) {
        return finish({
          state: "off",
          total,
          info: info ?? null,
          note: `${info?.label ?? "AI score"} not available${info?.reason ? `: ${info.reason}` : ""}. Only the standard checks run.`,
        });
      }
      update({ state: "running", total, info, note: null, ...counts() });

      let queue = valid.filter((r) => !scored.current.has(r.rowIndex));
      while (queue.length) {
        const batch = queue.slice(0, Math.max(1, info.batchSize));
        let answer: AiAnswer;
        try {
          answer = await api<AiAnswer>("/api/import-filter/ai-score", {
            method: "POST",
            json: { rows: batch.map((r) => ({ name: r.name, business: r.businessName, ruleScore: r.ruleScore })) },
            notify: false,
          });
        } catch (err) {
          return finish({ state: "stopped", note: `AI scoring stopped: ${errText(err)}` });
        }
        if (!alive) return;
        answer.results.forEach((res, i) => {
          scored.current.set(batch[i]!.rowIndex, res);
          if (res.aiState === "ERROR") lastError.current = res.aiNotes;
        });
        setResults(new Map(scored.current));
        queue = queue.slice(answer.results.length);
        const { failed } = counts();
        if (failed >= info.maxFailures) return finish({ state: "stopped", note: `AI scoring stopped after ${info.maxFailures} failed rows: ${lastError.current ?? ""}` });
        if (answer.stop) return finish({ state: "stopped", note: answer.stop });
        if (answer.wait) {
          update({ state: "waiting", note: answer.wait.reason, ...counts() });
          await wait(answer.wait.ms);
          if (!alive) return;
          update({ state: "running", note: null });
          continue;
        }
        update({ state: "running", note: null, ...counts() });
        if (queue.length && info.minGapMs) {
          await wait(info.minGapMs);
          if (!alive) return;
        }
      }
      finish({ state: "done", note: null });
    })();
    return () => {
      alive = false;
    };
  }, [active, valid, rows.length]);

  const notComing = progress.state === "stopped" || progress.state === "off";
  const merged = useMemo(
    () =>
      rows.map((r): DraftRow => {
        const res = results.get(r.rowIndex);
        if (res) return { ...r, aiState: res.aiState, aiScore: res.aiScore, aiNotes: res.aiNotes, score: res.score, tier: res.tier };
        // As on Data Quality: a valid row the AI will not score shows only the rules score.
        return r.status === "VALID" && notComing ? { ...r, aiState: "SKIPPED" as DqRecord["aiState"] } : r;
      }),
    [rows, results, notComing],
  );
  return { rows: merged, progress };
}
