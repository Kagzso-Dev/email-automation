import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { BRANDING_DEFAULTS, resolveBranding, type BrandingKey, type BrandingLabels } from "@dispatch/shared";
import { api } from "./api";

export const BRANDING_SETTINGS_KEY = ["branding-settings"] as const;

export interface BrandingView {
  labels: BrandingLabels;
  customized: BrandingKey[];
}

/** Last app name this browser saw, so a refresh shows it at once (no "Dispatch" flash). */
const APP_NAME_CACHE = "dispatch:app-name";

export function cachedAppName(): string {
  try {
    return resolveBranding({ appName: localStorage.getItem(APP_NAME_CACHE) }).appName;
  } catch {
    return BRANDING_DEFAULTS.appName;
  }
}

export function rememberAppName(appName: string) {
  try {
    if (appName === BRANDING_DEFAULTS.appName) localStorage.removeItem(APP_NAME_CACHE);
    else localStorage.setItem(APP_NAME_CACHE, appName);
  } catch {
    /* storage unavailable — non-fatal */
  }
}

/**
 * Workspace app name (Settings → Branding), from the public read-only
 * /api/branding so the login page shows it too. Until the server answers, the
 * name this browser last saw is used; with nothing remembered (or if the API
 * fails) it's the default "Dispatch". Saving in Settings writes this cache, so
 * every place updates immediately.
 */
export function useBranding(): BrandingLabels {
  const q = useQuery({
    queryKey: BRANDING_SETTINGS_KEY,
    queryFn: async () => {
      const v = await api<BrandingView>("/api/branding");
      rememberAppName(resolveBranding(v.labels).appName);
      return v;
    },
    staleTime: Infinity,
    retry: 1,
  });
  return q.data ? resolveBranding(q.data.labels) : { appName: cachedAppName() };
}

/** Browser tab title follows the app name (main.tsx sets it before first paint). */
export function useDocumentTitle(appName: string) {
  useEffect(() => {
    document.title = appName;
  }, [appName]);
}
