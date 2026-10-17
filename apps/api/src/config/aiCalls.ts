// AI voice-call configuration — deliberately separate from src/env.ts.
//
// Like config/whatsapp.ts this reads only its own variables and NEVER throws:
// a missing/blank value just disables AI calls (the Contacts page hides the
// button). Email, WhatsApp and app startup are unaffected.

import { fileURLToPath } from "node:url";
import { config as loadEnv } from "dotenv";

loadEnv();
// src/config/aiCalls.ts → repo root is four levels up.
loadEnv({ path: fileURLToPath(new URL("../../../../.env", import.meta.url)) });

function str(v: string | undefined): string | undefined {
  const t = (v ?? "").trim();
  return t.length > 0 ? t : undefined;
}

function intIn(v: string | undefined, fallback: number, min: number, max: number): number {
  const n = Number.parseInt((v ?? "").trim(), 10);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

/** Absolute ceiling on calls per run, whatever the env says. */
export const AI_CALLS_ABSOLUTE_MAX_PER_RUN = 100;

export const aiCallsConfig = {
  enabled: ["true", "1", "yes"].includes((process.env.ENABLE_AI_CALLS ?? "").trim().toLowerCase()),
  voiceBackendUrl: str(process.env.VOICE_BACKEND_URL)?.replace(/\/+$/, ""),
  voiceBackendApiKey: str(process.env.VOICE_BACKEND_API_KEY),
  /** Optional: a specific agent id in the voice backend. Blank = the agent named VOICE_AGENT_NAME (default Nila; the names Radhi and Kayal also still work). */
  voiceAgentId: intIn(process.env.VOICE_AGENT_ID, 0, 0, Number.MAX_SAFE_INTEGER) || undefined,
  voiceAgentName: str(process.env.VOICE_AGENT_NAME) ?? "Nila",
  /** Shared secret the voice backend signs status callbacks with (HMAC-SHA256). */
  webhookSecret: str(process.env.AI_CALL_WEBHOOK_SECRET),
  defaultCountryCode: (str(process.env.AI_CALLS_DEFAULT_COUNTRY_CODE) ?? "91").replace(/\D/g, "") || "91",
  /** Hard cap on calls in one run (the UI's "max calls" can only go lower). */
  maxPerRun: intIn(process.env.AI_CALLS_MAX_PER_RUN, 10, 1, AI_CALLS_ABSOLUTE_MAX_PER_RUN),
  /** Calls dialled per rolling 24h across all runs. */
  dailyCap: intIn(process.env.AI_CALLS_DAILY_CAP, 100, 1, 10_000),
  minGapSec: intIn(process.env.AI_CALLS_MIN_GAP_SEC, 10, 5, 3600),
  /** A call with no final status after this long is marked FAILED and the run moves on. */
  callTimeoutSec: intIn(process.env.AI_CALLS_CALL_TIMEOUT_SEC, 900, 120, 7200),
  /** "Call Flows" editor + flow picker in the AI Call modal. Off = every call uses the default agent. */
  flowEditorEnabled: ["true", "1", "yes"].includes((process.env.ENABLE_CALL_FLOW_EDITOR ?? "").trim().toLowerCase()),
  /** AI Call Customers: how many "call again" drafts a No answer may create per customer. */
  followupMaxRetries: intIn(process.env.AI_CALL_FOLLOWUP_MAX_RETRIES, 2, 0, 10),
  /** E.164 numbers the "Test call to my number" button may dial (comma-separated). Empty = test calls off. */
  flowTestNumbers: (process.env.AI_CALL_FLOW_TEST_NUMBERS ?? "")
    .split(",")
    .map((n) => n.trim())
    .filter((n) => /^\+[1-9]\d{7,14}$/.test(n)),
} as const;

/** Both flags: AI calls on and the Call Flows editor on. */
export function isCallFlowEditorEnabled(): boolean {
  return aiCallsConfig.enabled && aiCallsConfig.flowEditorEnabled;
}

/** True when calls can actually be placed (flag on + voice backend reachable config). */
export function isAiCallsConfigured(): boolean {
  return Boolean(aiCallsConfig.voiceBackendUrl && aiCallsConfig.voiceBackendApiKey);
}
