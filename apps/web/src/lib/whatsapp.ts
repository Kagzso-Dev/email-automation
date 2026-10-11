import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "./api";

export interface WhatsAppConfig {
  configured: boolean;
  provider: string;
  phoneNumberId: string | null;
}

/** Whether the Meta WhatsApp Cloud API credentials are set — gates the send buttons. */
export function useWhatsAppConfig() {
  return useQuery({
    queryKey: ["whatsapp-config"],
    queryFn: () => api<WhatsAppConfig>("/api/whatsapp/config"),
    staleTime: 60_000,
  });
}

export const WHATSAPP_NOT_CONFIGURED_HINT =
  "Set up WhatsApp API in Settings to enable this.";

export type TemplateVerifyStatus = "verified" | "pending" | "failed" | "not_found" | "unchecked";

export interface TemplateVerification {
  id: string;
  status: TemplateVerifyStatus;
  metaStatus: string | null;
  reason: string;
  /** Meta header that a send would have to fill in (e.g. "IMAGE"); null when none is needed. */
  headerNeedsParameter: string | null;
}

export interface TemplateVerificationResult {
  checkedAt: string;
  error: string | null;
  items: TemplateVerification[];
}

const VERIFY_KEY = ["whatsapp-template-verify"];

/**
 * Meta verification of the registered templates (display only — it never blocks a
 * send). Loads once per page visit; the API caches Meta's list for ~5 minutes.
 * `refresh()` forces a re-read from Meta ("Verify with Meta").
 */
export function useTemplateVerification() {
  const qc = useQueryClient();
  const query = useQuery({
    queryKey: VERIFY_KEY,
    queryFn: () => api<TemplateVerificationResult>("/api/whatsapp/templates/verify"),
    staleTime: 5 * 60_000,
  });
  const refresh = useMutation({
    mutationFn: () => api<TemplateVerificationResult>("/api/whatsapp/templates/verify?refresh=1"),
    onSuccess: (data) => qc.setQueryData(VERIFY_KEY, data),
  });
  const byId = new Map((query.data?.items ?? []).map((v) => [v.id, v]));
  return { query, refresh, byId };
}
