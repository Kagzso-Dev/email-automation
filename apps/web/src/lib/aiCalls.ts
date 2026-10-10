import { useQuery } from "@tanstack/react-query";
import type { AiCallColumnMapping } from "@dispatch/shared";
import { api } from "./api";

export interface AiCallsConfig {
  /** ENABLE_AI_CALLS on the API — the button is hidden when false. */
  enabled: boolean;
  /** Voice backend URL + key are set. */
  configured: boolean;
  /** Signed-in user is an ADMIN. */
  canStart: boolean;
  maxPerRun: number;
  minGapSec: number;
  defaultGapSec: number;
  defaultCountryCode: string;
}

/** Feature flag + limits — gates the "AI Call" button on the Contacts page. */
export function useAiCallsConfig() {
  return useQuery({
    queryKey: ["ai-calls-config"],
    queryFn: () => api<AiCallsConfig>("/api/ai-calls/config"),
    staleTime: 60_000,
  });
}

export interface AiCallSheet {
  headers: string[];
  rows: Record<string, string>[];
  mapping: AiCallColumnMapping;
  truncated: boolean;
}

export interface AiCallPlanSummary {
  toCall: number;
  skipped: { invalid: number; duplicates: number; doNotCall: number; capped: number };
  invalidRows: { rowIndex: number; errors: string[] }[];
  hardCap: number;
}

export type AiCallStatus =
  | "QUEUED"
  | "DIALING"
  | "RINGING"
  | "IN_PROGRESS"
  | "COMPLETED"
  | "NO_ANSWER"
  | "BUSY"
  | "FAILED"
  | "CANCELLED";

export interface AiCallLog {
  id: string;
  position: number;
  customerName: string | null;
  gender: string | null;
  followUpDetail: string | null;
  phone: string;
  status: AiCallStatus;
  outcome: string | null;
  error: string | null;
  summary: string | null;
  transcript: string | null;
  durationSec: number | null;
  startedAt: string | null;
  endedAt: string | null;
}

export interface AiCallRun {
  id: string;
  mode: "RANDOM" | "SELECTED" | "ALL";
  status: "RUNNING" | "DONE" | "CANCELLED";
  gapSeconds: number;
  total: number;
  nextCallAt: string | null;
  createdAt: string;
  logs: AiCallLog[];
}
