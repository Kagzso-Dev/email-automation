import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  BRANDING_DEFAULTS,
  BRANDING_KEYS,
  brandingMaxLength,
  checkBrandingValue,
  sanitizeBrandingValue,
  type BrandingKey,
  type BrandingLabels,
} from "@dispatch/shared";
import { api } from "../lib/api";
import { BRANDING_SETTINGS_KEY, useBranding, type BrandingView } from "../lib/branding";
import { brandNavGroups, NAV_GROUPS } from "../lib/nav";
import { ErrorNote } from "./ui";
import { Icon } from "./icons";
import { Logo } from "./Logo";
import { useConfirm } from "./confirm";
import { useToast } from "./toast";

const FIELD_GROUPS: { title: string; keys: BrandingKey[] }[] = [
  { title: "App name", keys: ["appName"] },
  { title: "Sidebar sections", keys: BRANDING_KEYS.filter((k) => k.startsWith("section.")) },
  { title: "Menu items", keys: BRANDING_KEYS.filter((k) => k.startsWith("nav.")) },
];

const FIELD_HINT: Partial<Record<BrandingKey, string>> = {
  appName: "Sidebar header and browser tab title",
};

/**
 * Settings → Branding & Labels (admins only). Renames the app name and the
 * sidebar section / menu labels — display text only; routes, permissions,
 * emails, WhatsApp and call scripts are untouched. Edits preview live and are
 * applied to everyone on Save.
 */
export function BrandingSection() {
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const navigate = useNavigate();
  const saved = useBranding();
  const savedKey = BRANDING_KEYS.map((k) => saved[k]).join("\u0000");
  const [draft, setDraft] = useState<BrandingLabels>(saved);

  // Follow the server value (first load, or a save/reset).
  useEffect(() => {
    setDraft(saved);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [savedKey]);

  const checks = useMemo(
    () => Object.fromEntries(BRANDING_KEYS.map((k) => [k, checkBrandingValue(k, draft[k])])) as Record<BrandingKey, ReturnType<typeof checkBrandingValue>>,
    [draft],
  );
  const changed = BRANDING_KEYS.filter((k) => draft[k].trim() !== saved[k]);
  const dirty = changed.length > 0;
  const invalid = BRANDING_KEYS.some((k) => !checks[k].ok);
  const anyCustom = BRANDING_KEYS.some((k) => saved[k] !== BRANDING_DEFAULTS[k]);

  const onServer = (v: BrandingView) => qc.setQueryData(BRANDING_SETTINGS_KEY, v);

  const save = useMutation({
    mutationFn: () => {
      const labels = Object.fromEntries(changed.map((k) => [k, draft[k].trim()]));
      return api<BrandingView>("/api/settings/branding", { method: "PUT", json: { labels }, notify: "Branding saved" });
    },
    onSuccess: onServer,
    onError: (err) => toast.fromError(err, "Couldn't save branding"),
  });

  const resetAll = useMutation({
    mutationFn: () => api<BrandingView>("/api/settings/branding", { method: "DELETE", notify: "Default names restored" }),
    onSuccess: (v) => {
      onServer(v);
      setDraft(v.labels);
    },
    onError: (err) => toast.fromError(err, "Couldn't reset branding"),
  });

  const busy = save.isPending || resetAll.isPending;

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
        body: "Your changes to Branding & Labels haven't been saved.",
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

  // Preview: what's typed, or the default while a field is empty.
  const preview = Object.fromEntries(
    BRANDING_KEYS.map((k) => [k, draft[k].trim() || BRANDING_DEFAULTS[k]]),
  ) as BrandingLabels;

  return (
    <section className="settings-section">
      <h2 className="settings-heading">Branding &amp; Labels</h2>
      <div className="settings-card space-y-5">
        <p className="text-slate-550">
          Rename the app and the sidebar menu for everyone in the workspace. Only the text shown on screen
          changes — links, permissions, emails, WhatsApp messages and call scripts stay the same. Page
          headings follow the menu names.
        </p>

        <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_260px]">
          <div className="space-y-6">
            {FIELD_GROUPS.map((g) => (
              <fieldset key={g.title} className="space-y-3">
                <legend className="mb-2 font-semibold text-ink">{g.title}</legend>
                {g.keys.map((k) => {
                  const check = checks[k];
                  const max = brandingMaxLength(k);
                  const isDefault = draft[k].trim() === BRANDING_DEFAULTS[k];
                  const id = `branding-${k}`;
                  return (
                    <div key={k}>
                      <label className="label" htmlFor={id}>
                        {k === "appName" ? "App name" : BRANDING_DEFAULTS[k]}
                      </label>
                      <div className="flex items-center gap-2">
                        <input
                          id={id}
                          className="input"
                          value={draft[k]}
                          maxLength={max}
                          disabled={busy}
                          aria-invalid={!check.ok}
                          aria-describedby={`${id}-help`}
                          onChange={(e) => {
                            const v = sanitizeBrandingValue(e.target.value).slice(0, max);
                            setDraft((d) => ({ ...d, [k]: v }));
                          }}
                        />
                        <button
                          type="button"
                          className="btn-ghost settings-btn shrink-0"
                          disabled={busy || isDefault}
                          title={`Reset to “${BRANDING_DEFAULTS[k]}”`}
                          onClick={() => setDraft((d) => ({ ...d, [k]: BRANDING_DEFAULTS[k] }))}
                        >
                          Reset to default
                        </button>
                      </div>
                      <p id={`${id}-help`} className="mt-1 text-xs text-slate-550">
                        {!check.ok ? (
                          <span className="text-crit">{check.error}</span>
                        ) : (
                          <>
                            Default: <span className="font-medium text-ink">{BRANDING_DEFAULTS[k]}</span>
                            {saved[k] !== BRANDING_DEFAULTS[k] && <> · Saved: <span className="font-medium text-ink">{saved[k]}</span></>}
                            {FIELD_HINT[k] && <> · {FIELD_HINT[k]}</>}
                          </>
                        )}
                        <span className="float-right tabular-nums">
                          {draft[k].trim().length}/{max}
                        </span>
                      </p>
                    </div>
                  );
                })}
              </fieldset>
            ))}
          </div>

          <BrandingPreview labels={preview} />
        </div>

        <div className="flex flex-wrap items-center gap-2.5 border-t border-line-subtle pt-4">
          <button
            type="button"
            className="btn-primary settings-btn"
            disabled={!dirty || invalid || busy}
            onClick={() => save.mutate()}
          >
            {save.isPending ? "Saving…" : "Save"}
          </button>
          <button
            type="button"
            className="btn-ghost settings-btn"
            disabled={busy || (!anyCustom && !dirty)}
            onClick={async () => {
              const ok = await confirm({
                title: "Reset all names to default?",
                body: `The app name goes back to “${BRANDING_DEFAULTS.appName}” and every menu label to its original text, for everyone.`,
                confirmText: "Reset all",
                tone: "danger",
              });
              if (ok) resetAll.mutate();
            }}
          >
            {resetAll.isPending ? "Resetting…" : "Reset all"}
          </button>
          {dirty && (
            <span className="text-warn">
              Unsaved changes ({changed.length})
            </span>
          )}
        </div>

        {save.error && <ErrorNote error={save.error} />}
        {resetAll.error && <ErrorNote error={resetAll.error} />}
      </div>
    </section>
  );
}

/** Read-only copy of the sidebar header and menu, showing the names being typed. */
function BrandingPreview({ labels }: { labels: BrandingLabels }) {
  const groups = brandNavGroups(NAV_GROUPS, labels);
  return (
    <div aria-label="Sidebar preview" className="self-start rounded-[14px] border border-line bg-surface p-3">
      <div className="mb-2 text-[11px] font-semibold uppercase tracking-[0.08em] text-slate-500">Preview</div>
      <div className="flex h-10 items-center gap-2 px-1 font-mono text-sm font-bold tracking-tight text-ink">
        <Logo size={24} />
        <span className="truncate">{labels.appName}</span>
      </div>
      <div className="mt-1">
        {groups.map((g, gi) => (
          <div key={g.labelKey} className={gi > 0 ? "mt-3" : undefined}>
            <div className="mb-1 truncate px-3 text-[11px] font-semibold uppercase tracking-[0.08em] text-slate-500">
              {g.label}
            </div>
            <ul className="flex flex-col">
              {g.items.map((n) => (
                <li key={n.to} className="flex h-8 items-center gap-3 px-3 text-sm font-medium text-slate-550">
                  <Icon name={n.icon} size={16} className="shrink-0" />
                  <span className="truncate">{n.label}</span>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </div>
  );
}
