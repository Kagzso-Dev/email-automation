// Import filter step (ENABLE_IMPORT_FILTER_STEP): the Data Quality AI score on rows that are NOT saved.
//
// Exactly the Data Quality scoring (queue/dataQuality.ts), one batch of rows per request instead of one row per
// queue run: the same service and model (DATA_QUALITY_AI_PROVIDER), the same prompt (aiPrompt: only the name and
// the business name are sent, never the phone number or the email), the same answer parsing, the same overall score
// (rules + AI average) and tier, the same pause between rows, the same "wait while live AI calls run", "rate
// limited → try again later" and "key refused → stop" rules. Writes nothing to the database.
//
// Two differences, both for the HTTP request (behind nginx, which cuts a request after about 60 s): a batch stops
// starting new rows after BATCH_BUDGET_MS and hands the rest back to the browser, and one row waits at most
// ROW_TIMEOUT_MS (the worker waits DATA_QUALITY_AI_TIMEOUT_SEC, 60 s by default).

import { dataQualityConfig, PROVIDER_LABELS, type AiSettings } from "../config/dataQuality.js";
import { MAX_AI_FAILURES, WAITING_FOR_CALLS } from "../queue/dataQuality.js";
import { AiError, checkAi, generateJson } from "../services/dataQualityAi.js";
import { aiPrompt, liveCallsRunning, overallScore, parseAiAnswer } from "./dataQuality.js";
import { tierFor, type Tier } from "./dataQualityExport.js";

/** Rows per request at most (the browser sends the next batch when this one answered). */
export const AI_BATCH_SIZE = 5;
/** No new row is started after this long in one request; the rest is handed back. */
export const BATCH_BUDGET_MS = 15_000;
/** One row's longest wait for the AI service in this step. */
export const ROW_TIMEOUT_MS = 45_000;
/** "Live AI calls are running": ask again after this long (as the worker does). */
export const LIVE_CALLS_RECHECK_MS = 30_000;

export interface DraftAiInput {
  name: string | null;
  business: string | null;
  /** The row's rules score (from the check), for the overall score and tier. */
  ruleScore: number | null;
}

export interface DraftAiResult {
  aiState: "DONE" | "ERROR";
  aiScore: number | null;
  aiNotes: string | null;
  /** Overall score (rules + AI), as on the Data Quality page. */
  score: number | null;
  tier: Tier | null;
}

export interface DraftAiAnswer {
  /** One per row scored, in order. Fewer than sent = the rest was not tried (send it again). */
  results: DraftAiResult[];
  /** Try the rest again after ms (rate limited, or live AI calls running). */
  wait?: { ms: number; reason: string };
  /** AI scoring stops for this file (service down, key refused). */
  stop?: string;
}

export interface DraftAiInfo {
  available: boolean;
  provider: AiSettings["provider"];
  label: string;
  model: string | null;
  reason: string | null;
  minGapMs: number;
  maxFailures: number;
  batchSize: number;
  liveCalls: boolean;
}

const settings = (): AiSettings => {
  const s = dataQualityConfig.ai;
  return { ...s, timeoutMs: Math.min(s.timeoutMs, ROW_TIMEOUT_MS) };
};

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Is the Data Quality AI service usable now, and how the browser should pace its batches. Never throws. */
export async function draftAiInfo(): Promise<DraftAiInfo> {
  const s = settings();
  const [health, liveCalls] = await Promise.all([checkAi(s), liveCallsRunning()]);
  return {
    available: health.available,
    provider: s.provider,
    label: PROVIDER_LABELS[s.provider],
    model: health.model,
    reason: health.reason,
    minGapMs: s.minGapMs,
    maxFailures: MAX_AI_FAILURES,
    batchSize: AI_BATCH_SIZE,
    liveCalls,
  };
}

/** AI-score a few rows (the browser sends the valid rows, as Data Quality scores only valid rows). Saves nothing. */
export async function scoreDraftBatch(rows: DraftAiInput[], opts: { sleep?: (ms: number) => Promise<void>; now?: () => number } = {}): Promise<DraftAiAnswer> {
  const sleep = opts.sleep ?? defaultSleep;
  const now = opts.now ?? Date.now;
  const s = settings();
  const label = PROVIDER_LABELS[s.provider];
  if (await liveCallsRunning()) return { results: [], wait: { ms: LIVE_CALLS_RECHECK_MS, reason: WAITING_FOR_CALLS } };

  const started = now();
  const results: DraftAiResult[] = [];
  for (const [i, r] of rows.entries()) {
    if (i > 0) {
      if (now() - started >= BATCH_BUDGET_MS) break; // the browser sends the rest
      if (s.minGapMs) await sleep(s.minGapMs);
    }
    // A local server can stop at any time; a cloud service is checked by its errors (as the worker does).
    if (s.provider === "ollama" || s.problem) {
      const health = await checkAi(s);
      if (!health.available) return { results, stop: `${label} not available: ${health.reason ?? "unknown"}` };
    }
    try {
      const answer = parseAiAnswer(await generateJson(aiPrompt({ name: r.name, businessName: r.business }), s));
      const score = overallScore(r.ruleScore, answer.score);
      results.push({ aiState: "DONE", aiScore: answer.score, aiNotes: answer.notes, score, tier: tierFor(score) });
    } catch (err) {
      if (err instanceof AiError && err.retryAfterMs != null) {
        // Rate limited: this row is tried again later; not a failure.
        return { results, wait: { ms: err.retryAfterMs, reason: `Waiting: ${label} rate limit, trying again shortly` } };
      }
      const message = (err instanceof Error ? err.message : String(err)).slice(0, 500);
      if (err instanceof AiError && err.denied) return { results, stop: `${label} refused the key: ${message}` };
      const score = overallScore(r.ruleScore, null);
      results.push({ aiState: "ERROR", aiScore: null, aiNotes: message, score, tier: tierFor(score) });
    }
  }
  return { results };
}
