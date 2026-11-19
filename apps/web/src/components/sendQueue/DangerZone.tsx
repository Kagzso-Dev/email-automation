// Send Queue → Hard stop (ENABLE_HARD_STOP), only rendered while the flag is on:
//  - <DangerZoneMenu>: the header's "More" menu with "Stop all running sends" (admins) and the open tab's section
//    stop ("Hard stop all email" / "… WhatsApp"). Each item asks the same confirmation as before, word for word.
//  - <LastStopBanner>: the newest stop that concerns this tab, as a compact card with its counts and the
//    cancelled-rows downloads. Dismissible once finished; a newer stop shows again.

import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { Ellipsis, LoaderCircle, OctagonX, X } from "lucide-react";
import type { HardStopScope, HardStopView } from "@dispatch/shared";
import { useAuth } from "../../lib/auth";
import { formatDateTime } from "../../lib/schedule";
import { useLatestSectionStop, useLatestStopAll } from "../../lib/hardStop";
import { CancelledCsvLinks, sectionHardStopLabels, useHardStopAction } from "../HardStopButton";
import { useToast } from "../toast";
import { Tooltip } from "../Tooltip";

type QueueSection = "EMAIL" | "WHATSAPP";

const SECTION_HINT: Record<QueueSection, string> = {
  EMAIL: "Cancels every email that hasn't started. WhatsApp and calls keep going.",
  WHATSAPP: "Cancels every WhatsApp message that hasn't started. Email and calls keep going.",
};

/** Admins get "Stop all running sends" (and its latest stop), as before the redesign. */
function useIsAdmin(): boolean {
  return useAuth().user?.role === "ADMIN";
}

/** The header's "⋯ More" menu. Renders nothing when this person has no item in it. */
export function DangerZoneMenu({ section }: { section: QueueSection | null }) {
  const isAdmin = useIsAdmin();
  const toast = useToast();
  const stopAll = useHardStopAction({
    scope: "ALL",
    targetId: null,
    label: "Stop all running sends",
    invalidate: [["email-batches"], ["whatsapp-batches"], ["ai-call-followups"]],
    onError: (err) => toast.fromError(err, "Could not stop the running sends"),
  });
  const labels = section ? sectionHardStopLabels(section) : null;
  const sectionStop = useHardStopAction({
    scope: section ?? "EMAIL",
    targetId: null,
    label: labels?.button,
    title: labels?.title,
    invalidate: [[section === "WHATSAPP" ? "whatsapp-batches" : "email-batches"]],
    onError: (err) => toast.fromError(err, "Could not apply the hard stop"),
  });

  // Same visibility as before the redesign: Stop all for admins, the section stop for everyone who sees the tab.
  const items: { key: string; label: string; hint: string; action: typeof stopAll }[] = [];
  if (isAdmin) {
    items.push({
      key: "all",
      label: "Stop all running sends",
      hint: "Email, WhatsApp and AI calls in every language. Work in progress finishes; the rest is cancelled.",
      action: stopAll,
    });
  }
  if (section && labels) {
    items.push({ key: "section", label: labels.button, hint: SECTION_HINT[section], action: sectionStop });
  }

  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const menuId = useId();

  useEffect(() => {
    if (!open) return;
    menu.current?.querySelector<HTMLElement>('[role="menuitem"]:not(:disabled)')?.focus();
    const onPointer = (e: PointerEvent) => {
      const t = e.target as Node;
      if (!menu.current?.contains(t) && !trigger.current?.contains(t)) setOpen(false);
    };
    document.addEventListener("pointerdown", onPointer);
    return () => document.removeEventListener("pointerdown", onPointer);
  }, [open]);

  if (items.length === 0) return null;

  function close(focusTrigger: boolean) {
    setOpen(false);
    if (focusTrigger) trigger.current?.focus();
  }

  function onMenuKey(e: KeyboardEvent<HTMLDivElement>) {
    const list = Array.from(menu.current?.querySelectorAll<HTMLElement>('[role="menuitem"]:not(:disabled)') ?? []);
    const i = list.indexOf(document.activeElement as HTMLElement);
    const go = (n: number) => {
      e.preventDefault();
      list[(n + list.length) % list.length]?.focus();
    };
    if (e.key === "ArrowDown") go(i + 1);
    else if (e.key === "ArrowUp") go(i - 1);
    else if (e.key === "Home") go(0);
    else if (e.key === "End") go(list.length - 1);
    else if (e.key === "Escape") {
      e.preventDefault();
      close(true);
    } else if (e.key === "Tab") close(false);
  }

  return (
    <div className="relative">
      <button
        ref={trigger}
        type="button"
        className="btn-ghost queue-action px-3"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-label="More actions"
        onClick={() => setOpen((o) => !o)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown" && !open) {
            e.preventDefault();
            setOpen(true);
          }
        }}
      >
        <Ellipsis size={18} aria-hidden="true" />
        More
      </button>
      {open && (
        <div
          ref={menu}
          id={menuId}
          role="menu"
          aria-label="Danger zone"
          onKeyDown={onMenuKey}
          className="absolute right-0 top-full z-40 mt-2 w-[22rem] max-w-[calc(100vw-2rem)] rounded-xl border border-line/70 bg-surface p-1.5 shadow-pop animate-dialog-in"
        >
          <div className="px-3 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-[0.08em] text-slate-550" aria-hidden="true">
            Danger zone
          </div>
          {items.map((it) => (
            <button
              key={it.key}
              type="button"
              role="menuitem"
              aria-labelledby={`${menuId}-${it.key}-label`}
              aria-describedby={`${menuId}-${it.key}-hint`}
              disabled={it.action.press.isPending}
              className="flex w-full items-start gap-3 rounded-lg px-3 py-2.5 text-left transition-colors hover:bg-crit-soft focus-visible:bg-crit-soft disabled:opacity-60"
              onClick={() => {
                close(true);
                void it.action.ask(); // the confirmation dialog, then the stop
              }}
            >
              <span className="mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-crit-soft text-crit">
                <OctagonX size={16} aria-hidden="true" />
              </span>
              <span className="min-w-0">
                <span id={`${menuId}-${it.key}-label`} className="block text-sm font-semibold text-crit">
                  {it.action.press.isPending ? "Stopping…" : it.label}
                </span>
                <span id={`${menuId}-${it.key}-hint`} className="mt-0.5 block text-xs leading-snug text-slate-550">
                  {it.hint}
                </span>
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

const SCOPE_LABEL: Partial<Record<HardStopScope, string>> = {
  ALL: "All sends",
  EMAIL: "Email",
  WHATSAPP: "WhatsApp",
};

const DISMISSED_KEY = "dispatch:send-queue-dismissed-stop";

function readDismissed(): string | null {
  try {
    return localStorage.getItem(DISMISSED_KEY);
  } catch {
    return null;
  }
}

/**
 * The newest stop for this tab: Stop all (admins) or the tab's own section stop. Nothing when there is none.
 * Amber while it is still stopping; neutral once finished.
 */
export function LastStopBanner({ section }: { section: QueueSection | null }) {
  const isAdmin = useIsAdmin();
  const all = useLatestStopAll(isAdmin);
  const own = useLatestSectionStop(section ?? "EMAIL", null, section !== null);
  const [dismissed, setDismissed] = useState(readDismissed);

  const stop = [isAdmin ? all.data?.stop : null, section ? own.data?.stop : null]
    .filter((s): s is HardStopView => !!s)
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))[0];
  if (!stop) return null;
  const stopping = stop.status === "STOPPING";
  if (!stopping && dismissed === stop.id) return null;

  const paused = [
    ...stop.paused.campaigns.map((c) => `campaign "${c.name}"`),
    ...stop.paused.triggers.map((t) => `trigger "${t.name}"`),
  ];
  const scope = SCOPE_LABEL[stop.scope];

  return (
    <section
      aria-label="Latest hard stop"
      className={`flex gap-3 rounded-xl border px-4 py-3 shadow-sm ${stopping ? "border-warn-bright/50 bg-warn-soft" : "border-line/70 bg-surface"}`}
    >
      <span className={`grid h-9 w-9 shrink-0 place-items-center rounded-lg ${stopping ? "bg-surface text-warn" : "bg-warn-soft text-warn"}`}>
        {stopping ? (
          <LoaderCircle size={18} aria-hidden="true" className="animate-spin motion-reduce:animate-none" />
        ) : (
          <OctagonX size={18} aria-hidden="true" />
        )}
      </span>
      <div className="min-w-0 flex-1">
        <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm" aria-live="polite">
          {stopping ? (
            <span className="font-semibold text-warn">Stopping… {stop.inProgress} still in progress</span>
          ) : (
            <span className="text-slate-600">
              <span className="font-semibold text-ink">Last stop:</span> {formatDateTime(stop.createdAt)} by{" "}
              <span className="break-all font-medium text-ink">{stop.byEmail}</span>
            </span>
          )}
          {scope ? (
            <span className="rounded-full bg-surface-muted px-2 py-px text-[11px] font-medium text-slate-600">{scope}</span>
          ) : null}
        </p>
        <ul className="mt-2 flex flex-wrap gap-1.5" aria-label="What the stop did">
          <StatChip value={stop.completed} label="completed" title="Includes the items that were already in progress and finished" />
          <StatChip value={stop.cancelled} label="cancelled" title="Not started, so cancelled" />
          <StatChip value={stop.followupsCancelled} label="follow-ups & retries cancelled" />
        </ul>
        {paused.length > 0 && (
          <p className="mt-2 text-xs text-slate-600">
            Paused so nothing new starts by itself: {paused.join(", ")}. Turn them back on with Schedule or the trigger switch.
          </p>
        )}
        <CancelledCsvLinks stop={stop} className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs font-medium" />
      </div>
      {!stopping && (
        <Tooltip label="Dismiss">
          <button
            type="button"
            className="btn-icon -mr-1 -mt-1"
            aria-label="Dismiss the last stop notice"
            onClick={() => {
              setDismissed(stop.id);
              try {
                localStorage.setItem(DISMISSED_KEY, stop.id);
              } catch {
                /* storage unavailable: hidden until the page reloads */
              }
            }}
          >
            <X size={16} aria-hidden="true" />
          </button>
        </Tooltip>
      )}
    </section>
  );
}

function StatChip({ value, label, title }: { value: number; label: string; title?: string }) {
  return (
    <li title={title} className="inline-flex items-center gap-1 rounded-full bg-surface-sunken px-2.5 py-0.5 text-xs text-slate-600 ring-1 ring-inset ring-line">
      <span className="font-semibold tabular-nums text-ink">{value}</span> {label}
    </li>
  );
}
