// Template drafts (ENABLE_TEMPLATE_DRAFTS, off by default): an unfinished "New template" form on Templates (email) or
// WhatsApp Templates → Create in Meta is saved as a draft, so it can be resumed from the page's Drafts tab.
//
// Read from GET /api/template-drafts/config: loading, an error, or an API without the endpoint all count as OFF, and
// then nothing here sends a request, so both pages work exactly as before.
//
// A draft is the form's own state, saved as it is (no template validation). It is saved 3 seconds after the last
// change, and when the form is left: another page, closing the editor or the dialog, a hidden tab, a refresh or a
// closed tab. A form still as "New template" opened it is never saved. Saving never shows a toast and never blocks
// Create / Submit: a failed save only shows "Draft not saved". Creating the real template deletes its draft.

import { useCallback, useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { api, getAccessToken } from "./api";

export type DraftChannel = "whatsapp" | "email";

export interface DraftSummary {
  id: string;
  channel: DraftChannel;
  name: string | null;
  ownerId: string;
  ownerEmail: string;
  lastEditedById: string;
  lastEditedByEmail: string;
  createdAt: string;
  updatedAt: string;
}
export interface Draft<S = Record<string, unknown>> extends DraftSummary {
  state: S;
}
export interface DraftList {
  items: DraftSummary[];
  retentionDays: number;
}

export const AUTOSAVE_DELAY_MS = 3000;
/** "Continue your draft?" offers your own draft on that page edited this recently. */
export const RECENT_DRAFT_DAYS = 7;
/** Resume warns when someone else edited the draft this recently. */
export const EDITING_NOW_MINUTES = 10;
export const DRAFT_RETENTION_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;
/** Browsers drop a keepalive request over 64 KB; a bigger one is sent as a plain request instead. */
const KEEPALIVE_MAX_BYTES = 60_000;

const CONFIG_KEY = ["template-drafts-config"] as const;
export const draftsKey = (channel: DraftChannel) => ["template-drafts", channel] as const;
const draftUrl = (id: string) => `/api/template-drafts/${encodeURIComponent(id)}`;

const loadConfig = () =>
  api<{ enabled?: boolean } | undefined>("/api/template-drafts/config").catch(() => ({ enabled: false }));

/** The flag for rendering (OFF until it is known). */
export function useTemplateDraftsEnabled(): boolean {
  const q = useQuery({ queryKey: CONFIG_KEY, queryFn: loadConfig, staleTime: 60_000, retry: false });
  return q.data?.enabled === true;
}

const fetchDrafts = (channel: DraftChannel) => api<DraftList>(`/api/template-drafts?channel=${channel}`);

/** The page's drafts, newest first (only fetched while `enabled`). */
export function useDraftList(channel: DraftChannel, enabled: boolean) {
  return useQuery({ queryKey: draftsKey(channel), queryFn: () => fetchDrafts(channel), enabled, retry: false });
}

export const getDraft = <S>(id: string) => api<Draft<S>>(draftUrl(id));
export const deleteDraft = (id: string) => api(draftUrl(id), { method: "DELETE", notify: "Draft deleted" });

/** Your newest draft on this page edited in the last 7 days, or null (also when the list can't be read). */
export async function findRecentOwnDraft(
  qc: QueryClient,
  channel: DraftChannel,
  userId: string | undefined,
  now = Date.now(),
): Promise<DraftSummary | null> {
  if (!userId) return null;
  try {
    const list = await qc.fetchQuery({ queryKey: draftsKey(channel), queryFn: () => fetchDrafts(channel), staleTime: 0 });
    return list.items.find((d) => d.ownerId === userId && now - Date.parse(d.updatedAt) <= RECENT_DRAFT_DAYS * DAY_MS) ?? null;
  } catch {
    return null;
  }
}

/** Minutes since someone else edited it, when that was in the last 10 minutes; otherwise null. */
export function editedByOtherRecently(d: DraftSummary, userId: string | undefined, now = Date.now()): number | null {
  if (d.lastEditedById === userId) return null;
  const ms = now - Date.parse(d.updatedAt);
  return ms < EDITING_NOW_MINUTES * 60_000 ? Math.max(0, Math.floor(ms / 60_000)) : null;
}

export const draftLabel = (name: string | null | undefined) => name?.trim() || "Untitled draft";

/** "10:42" (the viewer's own 12/24-hour style). */
export const formatClock = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

/** "Today 10:42", or "16 Nov 10:42". */
export function formatEdited(iso: string, now = new Date()): string {
  const d = new Date(iso);
  const day = d.toDateString() === now.toDateString() ? "Today" : d.toLocaleDateString([], { day: "numeric", month: "short" });
  return `${day} ${formatClock(iso)}`;
}

/** JSON with object keys sorted, so the same form compares equal however its objects were built. */
export function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, (v as Record<string, unknown>)[k]]))
      : v,
  );
}

function newDraftId(): string {
  const c = globalThis.crypto as Crypto | undefined;
  if (c?.randomUUID) return c.randomUUID();
  return `d${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`;
}

export interface DraftStatus {
  kind: "idle" | "saving" | "saved" | "failed";
  /** When the server last saved it (ISO). */
  savedAt: string | null;
}
export const IDLE_DRAFT_STATUS: DraftStatus = { kind: "idle", savedAt: null };

interface AutosaveOptions<S> {
  /** Flag on, and a form that may have a draft (a new template, by an admin). Off = this hook does nothing. */
  enabled: boolean;
  channel: DraftChannel;
  /** Set when the form was opened from a draft: saves update it. Unset: the first save creates one. */
  draftId?: string | null;
  /** The whole form, as the form holds it. */
  state: S;
  /** The form's name field (blank = "Untitled draft"). */
  name: string;
}

/**
 * Saves the form as a draft 3 seconds after the last change, and when the form is left. `finish()` is for after the
 * real template was created: it stops saving, waits for a save already on its way, and deletes the draft.
 */
export function useDraftAutosave<S>({ enabled, channel, draftId, state, name }: AutosaveOptions<S>) {
  const qc = useQueryClient();
  const json = stableJson(state);
  const [status, setStatus] = useState<DraftStatus>(IDLE_DRAFT_STATUS);
  const ref = useRef<{
    id: string | null;
    /** Opened from a draft: never "empty", and nothing to save until it changes. */
    resumed: boolean;
    /** The form as it opened: a new form still like this is empty and is not saved. */
    startJson: string;
    savedJson: string | null;
    sentOnUnload: string | null;
    chain: Promise<void>;
    stopped: boolean;
    enabled: boolean;
    latest: { json: string; state: S; name: string };
  }>();
  if (!ref.current) {
    ref.current = {
      id: draftId ?? null,
      resumed: !!draftId,
      startJson: json,
      savedJson: draftId ? json : null,
      sentOnUnload: null,
      chain: Promise.resolve(),
      stopped: false,
      enabled,
      latest: { json, state, name },
    };
  }
  const r = ref.current;
  r.latest = { json, state, name };
  r.enabled = enabled;

  const dirty = useCallback(
    () => r.enabled && !r.stopped && r.latest.json !== r.savedJson && (r.resumed || r.latest.json !== r.startJson),
    [r],
  );
  const body = useCallback(
    (snap: { state: S; name: string }) => ({ channel, name: snap.name.trim() || null, state: snap.state }),
    [channel],
  );

  const save = useCallback((): Promise<void> => {
    r.chain = r.chain.then(async () => {
      if (!dirty()) return;
      const snap = r.latest;
      const creating = r.savedJson === null && !r.resumed;
      r.id ??= newDraftId();
      setStatus((s) => ({ ...s, kind: "saving" }));
      try {
        const saved = await api<DraftSummary | undefined>(draftUrl(r.id), { method: "PUT", json: body(snap), notify: false });
        r.savedJson = snap.json;
        setStatus({ kind: "saved", savedAt: saved?.updatedAt ?? new Date().toISOString() });
        if (creating) void qc.invalidateQueries({ queryKey: draftsKey(channel) });
      } catch {
        setStatus((s) => ({ ...s, kind: "failed" }));
      }
    });
    return r.chain;
  }, [r, dirty, body, qc, channel]);

  // 3 seconds after the last change.
  useEffect(() => {
    if (!enabled || !dirty()) return;
    const t = window.setTimeout(() => void save(), AUTOSAVE_DELAY_MS);
    return () => window.clearTimeout(t);
  }, [enabled, json, dirty, save]);

  // Leaving: refresh / closed tab (a keepalive request that outlives the page), a hidden tab, and unmount.
  useEffect(() => {
    if (!enabled) return;
    const onUnload = () => {
      if (!dirty() || r.sentOnUnload === r.latest.json) return;
      r.sentOnUnload = r.latest.json;
      r.id ??= newDraftId();
      const payload = JSON.stringify(body(r.latest));
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      const token = getAccessToken();
      if (token) headers.Authorization = `Bearer ${token}`;
      try {
        const keepalive = new TextEncoder().encode(payload).length <= KEEPALIVE_MAX_BYTES;
        void fetch(draftUrl(r.id), { method: "PUT", headers, body: payload, credentials: "include", keepalive }).catch(() => undefined);
      } catch {
        // The page is going away; the last debounced save stands.
      }
    };
    const onHidden = () => {
      if (document.visibilityState === "hidden" && dirty()) void save();
    };
    window.addEventListener("pagehide", onUnload);
    window.addEventListener("beforeunload", onUnload);
    document.addEventListener("visibilitychange", onHidden);
    return () => {
      window.removeEventListener("pagehide", onUnload);
      window.removeEventListener("beforeunload", onUnload);
      document.removeEventListener("visibilitychange", onHidden);
      // Leaving the form (another page, closing the editor or the dialog): save what isn't saved yet.
      void (dirty() ? save() : Promise.resolve()).then(() => {
        if (r.id && !r.stopped) void qc.invalidateQueries({ queryKey: draftsKey(channel) });
      });
    };
  }, [enabled, r, dirty, body, save, qc, channel]);

  const finish = useCallback(async () => {
    r.stopped = true;
    await r.chain;
    if (!r.id) return;
    await api(draftUrl(r.id), { method: "DELETE", notify: false }).catch(() => undefined);
    void qc.invalidateQueries({ queryKey: draftsKey(channel) });
  }, [r, qc, channel]);

  return { status, finish };
}
