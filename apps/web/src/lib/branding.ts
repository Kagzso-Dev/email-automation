import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { BRANDING_DEFAULTS, resolveBranding, type BrandingKey, type BrandingLabels } from "@dispatch/shared";
import { api } from "./api";

export const BRANDING_SETTINGS_KEY = ["branding-settings"] as const;

export interface BrandingView {
  labels: BrandingLabels;
  customized: BrandingKey[];
}

/**
 * Workspace display names (Settings → Branding & Labels). Loaded once per
 * session; saving writes the new value into this cache so the sidebar, tab
 * title and headings update immediately. While loading, or on any failure, the
 * built-in default text is used — the UI looks exactly as before.
 */
export function useBranding(): BrandingLabels {
  const q = useQuery({
    queryKey: BRANDING_SETTINGS_KEY,
    queryFn: () => api<BrandingView>("/api/settings/branding"),
    staleTime: Infinity,
    retry: 1,
  });
  return q.isError || !q.data ? { ...BRANDING_DEFAULTS } : resolveBranding(q.data.labels);
}

/** Browser tab title follows the app name (index.html keeps the default for first paint). */
export function useDocumentTitle(appName: string) {
  useEffect(() => {
    document.title = appName;
  }, [appName]);
}
