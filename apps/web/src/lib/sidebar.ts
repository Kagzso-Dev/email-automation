import { useQuery } from "@tanstack/react-query";
import { normalizeHiddenNavItems, type HideableNavItem } from "@dispatch/shared";
import { api } from "./api";

export const SIDEBAR_SETTINGS_KEY = ["sidebar-settings"] as const;

/**
 * Workspace-wide hidden menu items. Loaded once per session; saving on the
 * Settings page writes the new value into this cache so the sidebar updates
 * immediately. Any failure means "hide nothing" — the menu never loses items
 * because the setting couldn't be read.
 */
export function useSidebarHiddenItems(): HideableNavItem[] {
  const q = useQuery({
    queryKey: SIDEBAR_SETTINGS_KEY,
    queryFn: () => api<{ hiddenItems: unknown }>("/api/settings/sidebar"),
    staleTime: Infinity,
    retry: 1,
  });
  return q.isError ? [] : normalizeHiddenNavItems(q.data?.hiddenItems);
}
