// HTTP client for kagzso-voice-backend (FastAPI). Raw fetch, no SDK.
//   POST /api/calls/outbound   place one call
//   GET  /api/calls/{id}       read its status / outcome / transcript
// Auth: X-API-Key = VOICE_BACKEND_API_KEY (the voice backend's ADMIN_API_KEY).

import { aiCallsConfig, isAiCallsConfigured } from "../config/aiCalls.js";

export class VoiceBackendError extends Error {
  constructor(
    message: string,
    public readonly status: number | null,
    /** True for network errors / 5xx / 429 — the call may succeed if retried later. */
    public readonly retryable: boolean,
  ) {
    super(message);
    this.name = "VoiceBackendError";
  }
}

export interface PlaceCallInput {
  customerName: string | null;
  gender: string | null;
  followUpDetail: string | null;
  phone: string; // E.164
  runId: string;
  logId: string;
}

export interface VoiceCallDetail {
  id: string;
  provider_call_id: string | null;
  status: string;
  outcome: string | null;
  summary: string | null;
  hangup_cause: string | null;
  duration_seconds: number | null;
  ended_at: string | null;
  transcripts?: { speaker: string; text: string }[];
}

/** FastAPI errors: {"detail": "msg"} or {"detail": [{"loc": [...], "msg": "..."}]}. */
function detailMessage(body: unknown, fallback: string): string {
  const detail = (body as { detail?: unknown } | null)?.detail;
  if (typeof detail === "string") return detail;
  if (Array.isArray(detail)) {
    return detail
      .map((d: { loc?: unknown[]; msg?: string }) => {
        const field = Array.isArray(d.loc) ? d.loc.filter((p) => p !== "body").join(".") : "";
        return field ? `${field}: ${d.msg}` : String(d.msg ?? "");
      })
      .join("; ");
  }
  return fallback;
}

async function request<T>(method: "GET" | "POST", path: string, json?: unknown): Promise<T> {
  if (!isAiCallsConfigured()) {
    throw new VoiceBackendError("Voice backend is not configured (VOICE_BACKEND_URL / VOICE_BACKEND_API_KEY)", null, false);
  }
  let res: Response;
  try {
    res = await fetch(`${aiCallsConfig.voiceBackendUrl}${path}`, {
      method,
      headers: {
        "X-API-Key": aiCallsConfig.voiceBackendApiKey!,
        ...(json !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: json !== undefined ? JSON.stringify(json) : undefined,
      signal: AbortSignal.timeout(30_000),
    });
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    throw new VoiceBackendError(`Voice backend unreachable: ${why}`, null, true);
  }
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    const msg = detailMessage(body, res.statusText);
    throw new VoiceBackendError(`Voice backend ${res.status}: ${msg}`, res.status, res.status >= 500 || res.status === 429);
  }
  return body as T;
}

export async function placeVoiceCall(input: PlaceCallInput): Promise<{ callId: string; providerCallId: string | null }> {
  const res = await request<{ success: boolean; call_id: string; provider_call_id: string | null }>(
    "POST",
    "/api/calls/outbound",
    {
      phone_number: input.phone,
      customer_name: input.customerName || undefined,
      gender: input.gender || undefined,
      follow_up_detail: input.followUpDetail || undefined,
      run_id: input.runId,
      log_id: input.logId,
      ...(aiCallsConfig.voiceAgentId
        ? { agent_id: aiCallsConfig.voiceAgentId }
        : { agent_name: aiCallsConfig.voiceAgentName }),
    },
  );
  return { callId: res.call_id, providerCallId: res.provider_call_id ?? null };
}

export function getVoiceCall(voiceCallId: string): Promise<VoiceCallDetail> {
  return request<VoiceCallDetail>("GET", `/api/calls/${encodeURIComponent(voiceCallId)}`);
}
