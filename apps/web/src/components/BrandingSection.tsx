import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  BRANDING_APP_NAME_MAX,
  BRANDING_DEFAULTS,
  checkBrandingValue,
  sanitizeBrandingValue,
} from "@dispatch/shared";
import { api } from "../lib/api";
import { BRANDING_SETTINGS_KEY, rememberAppName, useBranding, type BrandingView } from "../lib/branding";
import { ErrorNote } from "./ui";
import { Logo } from "./Logo";
import { useConfirm } from "./confirm";
import { useToast } from "./toast";

const DEFAULT_NAME = BRANDING_DEFAULTS.appName;

/**
 * Settings → Branding (admins only). Renames the app in the sidebar header,
 * mobile top bar and browser tab — display text only; emails, WhatsApp, call
 * scripts, routes and permissions are untouched. Applied to everyone on Save.
 */
export function BrandingSection() {
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const navigate = useNavigate();
  const saved = useBranding().appName;
  const [draft, setDraft] = useState(saved);

  // Follow the server value (first load, or a save/reset).
  useEffect(() => setDraft(saved), [saved]);

  const check = checkBrandingValue("appName", draft);
  const dirty = draft.trim() !== saved;
  const isCustom = saved !== DEFAULT_NAME;

  const onServer = (v: BrandingView) => {
    qc.setQueryData(BRANDING_SETTINGS_KEY, v);
    rememberAppName(v.labels.appName);
    setDraft(v.labels.appName);
  };

  const save = useMutation({
    mutationFn: () =>
      api<BrandingView>("/api/settings/branding", {
        method: "PUT",
        json: { labels: { appName: draft.trim() } },
        notify: "App name saved",
      }),
    onSuccess: onServer,
    onError: (err) => toast.fromError(err, "Couldn't save the app name"),
  });

  const busy = save.isPending;

  // Unsaved-changes warning: on reload / closing the tab, and on in-app links.
  useEffect(() => {
    if (!dirty) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    const onClick = async (e: MouseEvent) => {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const a = (e.target as Element | null)?.closest?.("a[href]") as HTMLAnchorElement | null;
      if (!a || a.target === "_blank" || a.origin !== window.location.origin) return;
      if (a.pathname === window.location.pathname) return;
      e.preventDefault();
      e.stopPropagation();
      const leave = await confirm({
        title: "Leave without saving?",
        body: "Your new app name hasn't been saved.",
        confirmText: "Leave",
        cancelText: "Stay",
        tone: "danger",
      });
      if (leave) navigate(a.pathname + a.search + a.hash);
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    document.addEventListener("click", onClick, true);
    return () => {
      window.removeEventListener("beforeunload", onBeforeUnload);
      document.removeEventListener("click", onClick, true);
    };
  }, [dirty, confirm, navigate]);

  const preview = draft.trim() || DEFAULT_NAME;

  return (
    <section className="settings-section">
      <h2 className="settings-heading">Branding</h2>
      <div className="settings-card space-y-4">
        <p className="text-slate-550">
          The app name shown at the top of the sidebar and in the browser tab, for everyone in the
          workspace. Only the text on screen changes — emails, WhatsApp messages and call scripts stay
          the same.
        </p>

        <div>
          <label className="label" htmlFor="branding-appName">App name</label>
          <input
            id="branding-appName"
            className="input"
            value={draft}
            maxLength={BRANDING_APP_NAME_MAX}
            disabled={busy}
            aria-invalid={!check.ok}
            aria-describedby="branding-appName-help"
            onChange={(e) => setDraft(sanitizeBrandingValue(e.target.value).slice(0, BRANDING_APP_NAME_MAX))}
          />
          <p id="branding-appName-help" className="mt-1 text-xs text-slate-550">
            {!check.ok ? (
              <span className="text-crit">{check.error}</span>
            ) : (
              <>
                Default: <span className="font-medium text-ink">{DEFAULT_NAME}</span>
                {isCustom && <> · Saved: <span className="font-medium text-ink">{saved}</span></>}
              </>
            )}
            <span className="float-right tabular-nums">
              {draft.trim().length}/{BRANDING_APP_NAME_MAX}
            </span>
          </p>
        </div>

        {/* Live preview: sidebar header and browser tab */}
        <div aria-label="Preview" className="flex flex-wrap items-center gap-3">
          <div className="flex h-12 min-w-0 max-w-64 items-center gap-2 rounded-[12px] border border-line bg-surface px-3 font-mono text-sm font-bold tracking-tight text-ink">
            <Logo size={28} />
            <span className="truncate">{preview}</span>
          </div>
          <div className="flex h-8 min-w-0 max-w-56 items-center gap-1.5 rounded-t-lg border border-b-0 border-line bg-surface px-3 text-xs text-slate-550">
            <Logo size={14} />
            <span className="truncate">{preview}</span>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2.5 border-t border-line-subtle pt-4">
          <button
            type="button"
            className="btn-primary settings-btn"
            disabled={!dirty || !check.ok || busy}
            onClick={() => save.mutate()}
          >
            {save.isPending ? "Saving…" : "Save"}
          </button>
          {dirty && <span className="text-warn">Unsaved changes</span>}
        </div>

        {save.error && <ErrorNote error={save.error} />}
      </div>
    </section>
  );
}
