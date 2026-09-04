import { useQuery } from "@tanstack/react-query";
import { api } from "./api";

export interface WhatsAppConfig {
  configured: boolean;
  from: string | null;
}

/** Whether the Twilio WhatsApp credentials are set — gates the send buttons. */
export function useWhatsAppConfig() {
  return useQuery({
    queryKey: ["whatsapp-config"],
    queryFn: () => api<WhatsAppConfig>("/api/whatsapp/config"),
    staleTime: 60_000,
  });
}

export const WHATSAPP_NOT_CONFIGURED_HINT =
  "Set up WhatsApp API in Settings to enable this.";
