import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { DomainMode } from "@dispatch/shared";
import { api } from "../lib/api";
import { formatDateTime } from "../lib/schedule";
import {
  BLOCKLIST_WARNING,
  SENDING_DOMAINS_QUERY,
  THROWAWAY_DOMAIN_SUGGESTIONS,
  describeDomainChange,
  useSendingDomains,
} from "../lib/sendingDomains";
import { useConfirm } from "./confirm";
import { Switch } from "./Switch";
import { ErrorNote, Spinner } from "./ui";

const SWITCH_LABEL = "Email all domains except blocked ones";

/**
 * Settings → Domain mode, the UI-level toggle (renders nothing only when ENABLE_DOMAIN_BLOCKLIST=false).
 * One switch: OFF = only Approved domains are emailed (as before); ON = every domain except the Blocked
 * list below. Turning it on asks first. Admins change it; everyone sees it. The Approved list section
 * (pages/Settings) greys itself out while this is on.
 */
export function SendingDomainModeSection({ isAdmin }: { isAdmin: boolean }) {
  const qc = useQueryClient();
  const confirm = useConfirm();
  const view = useSendingDomains();
  const refresh = () => qc.invalidateQueries({ queryKey: SENDING_DOMAINS_QUERY });

  const setMode = useMutation({
    mutationFn: (mode: DomainMode) =>
      api("/api/settings/sending-domains/mode", {
        method: "PUT",
        json: { mode },
        notify: mode === "BLOCKLIST" ? "Emailing all domains except blocked ones" : "Emailing approved domains only",
      }),
    onSuccess: refresh,
  });

  if (!view.enabled) return null;
  const on = view.blocklistOn;
  const ready = view.data?.ready !== false; // false = migration 0036 not applied yet
  const last = view.data?.lastModeChange ?? null;
  const history = view.data?.history ?? [];

  const toggle = async (next: boolean) => {
    if (next) {
      const ok = await confirm({
        title: `Turn on “${SWITCH_LABEL}”?`,
        body: BLOCKLIST_WARNING,
        confirmText: "Turn on",
      });
      if (!ok) return;
    }
    setMode.mutate(next ? "BLOCKLIST" : "ALLOWLIST");
  };

  return (
    <>
      <section className="settings-section">
        <h2 className="settings-heading">Domain mode</h2>
        <div className="settings-card space-y-4">
          <div className="flex items-start justify-between gap-4">
            <div className="space-y-1">
              <p className="font-medium text-ink">{SWITCH_LABEL}</p>
              <p className="text-sm text-slate-550">
                {on
                  ? "On: every domain is emailed except the blocked domains below. A blocked domain also covers its subdomains."
                  : "Off: only domains on the Approved list below are emailed."}
              </p>
            </div>
            <Switch on={on} label={SWITCH_LABEL} disabled={!isAdmin || !ready || setMode.isPending} onChange={toggle} />
          </div>
          {!ready ? (
            <p role="alert" className="rounded-lg border border-warn/40 bg-warn-soft px-4 py-3 text-sm text-warn">
              Needs a database update before it can be turned on: run <code>npm run prisma:deploy</code> (migration
              0036), then reload this page. Until then only the Approved list is used.
            </p>
          ) : null}
          <p className="text-xs text-slate-550">
            Unsubscribed, bounced and complained contacts are never emailed, whichever way this is set.
          </p>
          {last ? (
            <p className="text-xs text-slate-550">
              Last changed by {last.userEmail} on {formatDateTime(last.createdAt)}.
            </p>
          ) : null}
          {!isAdmin && <p className="text-xs text-slate-550">Only admins can change the domain mode.</p>}
          {setMode.error ? <ErrorNote error={setMode.error} /> : null}

          {isAdmin && history.length > 0 ? (
            <details className="text-sm">
              <summary className="cursor-pointer text-slate-550">Recent changes</summary>
              <ul className="mt-2 divide-y divide-line-subtle">
                {history.map((e) => (
                  <li key={e.id} className="py-1.5">
                    <span className="text-ink">{describeDomainChange(e)}</span>
                    <span className="text-slate-550">
                      {" "}
                      · {e.userEmail} · {formatDateTime(e.createdAt)}
                    </span>
                  </li>
                ))}
              </ul>
            </details>
          ) : null}
        </div>
      </section>

      {on && <BlockedDomainsSection isAdmin={isAdmin} />}
    </>
  );
}

/** The Blocked list — shown only while the switch is on. Same look as the Approved list. */
function BlockedDomainsSection({ isAdmin }: { isAdmin: boolean }) {
  const qc = useQueryClient();
  const confirm = useConfirm();
  const view = useSendingDomains();
  const [domain, setDomain] = useState("");
  const refresh = () => qc.invalidateQueries({ queryKey: SENDING_DOMAINS_QUERY });

  const add = useMutation({
    mutationFn: () =>
      api("/api/settings/sending-domains/blocked", { method: "POST", json: { domain }, notify: "Domain blocked" }),
    onSuccess: () => {
      setDomain("");
      refresh();
    },
  });
  const remove = useMutation({
    mutationFn: (id: string) =>
      api(`/api/settings/sending-domains/blocked/${id}`, { method: "DELETE", notify: "Domain unblocked" }),
    onSuccess: refresh,
  });

  const items = view.data?.blocked ?? [];
  const listed = new Set(items.map((d) => d.domain));
  const suggestions = THROWAWAY_DOMAIN_SUGGESTIONS.filter((s) => !listed.has(s));

  return (
    <section className="settings-section">
      <h2 className="settings-heading">Blocked domains</h2>
      <div className="settings-card space-y-4">
        <p className="text-slate-550">
          Contacts at these domains (and their subdomains) are skipped at import and never emailed.
        </p>

        {!view.isLoading && items.length === 0 ? (
          <p role="alert" className="rounded-lg border border-warn/40 bg-warn-soft px-4 py-3 text-sm text-warn">
            The blocked list is empty, so every domain is emailed.
          </p>
        ) : null}

        {isAdmin && (
          <form
            className="settings-row"
            onSubmit={(e) => {
              e.preventDefault();
              if (domain.trim()) add.mutate();
            }}
          >
            <input
              className="input"
              value={domain}
              onChange={(e) => setDomain(e.target.value)}
              placeholder="mailinator.com"
              aria-label="Domain to block"
            />
            <button className="btn-primary settings-btn" disabled={!domain.trim() || add.isPending}>
              Block domain
            </button>
          </form>
        )}
        {isAdmin && suggestions.length > 0 ? (
          <p className="text-xs text-slate-550">
            Common throwaway domains:{" "}
            {suggestions.map((s, i) => (
              <span key={s}>
                {i > 0 ? ", " : null}
                <button type="button" className="font-mono underline" onClick={() => setDomain(s)}>
                  {s}
                </button>
              </span>
            ))}
          </p>
        ) : null}
        {add.error ? <ErrorNote error={add.error} /> : null}

        {view.isLoading ? (
          <Spinner />
        ) : items.length > 0 ? (
          <ul className="divide-y divide-line-subtle">
            {items.map((d) => (
              <li key={d.id} className="flex items-center justify-between gap-3 py-2.5">
                <span className="domain-chip">@{d.domain}</span>
                {isAdmin && (
                  <button
                    className="text-action-danger"
                    onClick={async () => {
                      const ok = await confirm({
                        title: `Unblock @${d.domain}?`,
                        body: "Contacts at this domain will be imported and emailed again.",
                        confirmText: "Unblock",
                        tone: "danger",
                      });
                      if (ok) remove.mutate(d.id);
                    }}
                  >
                    Unblock
                  </button>
                )}
              </li>
            ))}
          </ul>
        ) : null}
        {remove.error ? <ErrorNote error={remove.error} /> : null}
      </div>
    </section>
  );
}
