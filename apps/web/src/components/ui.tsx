import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Icon, type IconName } from "./icons";

export function Badge({ children, tone = "neutral" }: { children: ReactNode; tone?: BadgeTone }) {
  const tones: Record<BadgeTone, string> = {
    neutral: "bg-surface-muted text-slate-550",
    accent: "bg-accent-soft text-accent-ink",
    ok: "bg-ok-soft text-ok",
    warn: "bg-warn-soft text-warn",
    crit: "bg-crit-soft text-crit",
  };
  return (
    <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 font-mono text-xs font-medium ${tones[tone]}`}>
      {children}
    </span>
  );
}
export type BadgeTone = "neutral" | "accent" | "ok" | "warn" | "crit";

export const campaignTone: Record<string, BadgeTone> = {
  DRAFT: "neutral",
  SCHEDULED: "accent",
  SENDING: "warn",
  SENT: "ok",
  PAUSED: "warn",
  FAILED: "crit",
};

export const emailTone: Record<string, BadgeTone> = {
  QUEUED: "neutral",
  SENT: "accent",
  DELIVERED: "ok",
  OPENED: "ok",
  CLICKED: "ok",
  BOUNCED: "crit",
  COMPLAINED: "crit",
  FAILED: "crit",
};

export function EmptyState({
  children,
  icon,
  title,
}: {
  children: ReactNode;
  icon?: IconName;
  title?: string;
}) {
  return (
    <div className="rounded-xl border border-dashed border-line-strong bg-surface/80 p-10 text-center text-sm leading-[1.6] text-slate-550">
      {icon ? (
        <span className="icon-chip float-soft mx-auto mb-3 h-11 w-11">
          <Icon name={icon} size={20} />
        </span>
      ) : null}
      {title ? <div className="mb-1 font-semibold text-ink">{title}</div> : null}
      {children}
    </div>
  );
}

export function Spinner() {
  return <div className="p-8 text-sm text-slate-550">Loading…</div>;
}

/** Shimmer placeholder block. Width/height via className (e.g. "h-4 w-32"). */
export function Skeleton({ className = "" }: { className?: string }) {
  return <span className={`skeleton block ${className}`} aria-hidden="true" />;
}

/** Grid of card-shaped skeletons — matches the dashboard stat grid. */
export function SkeletonCards({ count = 4 }: { count?: number }) {
  return (
    <div
      className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4"
      role="status"
      aria-label="Loading"
    >
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} className="card">
          <Skeleton className="h-3 w-24" />
          <Skeleton className="mt-3 h-7 w-16" />
        </div>
      ))}
    </div>
  );
}

/** Table-shaped skeleton — a header bar plus `rows` lines. */
export function SkeletonTable({ rows = 6 }: { rows?: number }) {
  return (
    <div
      className="overflow-hidden rounded-xl border border-line bg-surface"
      role="status"
      aria-label="Loading"
    >
      <div className="border-b border-line px-4 py-3">
        <Skeleton className="h-3 w-32" />
      </div>
      <div className="divide-y divide-line-subtle">
        {Array.from({ length: rows }).map((_, i) => (
          <div key={i} className="px-4 py-3">
            <Skeleton className="h-4 w-full max-w-[28rem]" />
          </div>
        ))}
      </div>
    </div>
  );
}

export function ErrorNote({ error }: { error: unknown }) {
  const msg = error instanceof Error ? error.message : "Something went wrong";
  return <div className="rounded-lg border border-crit-line bg-crit-soft px-3 py-2 text-sm text-crit">{msg}</div>;
}

/** Matches the overlay-out / dialog-out duration (--motion-fast). */
const MODAL_CLOSE_MS = 150;

function prefersReducedMotion() {
  return typeof window !== "undefined" && !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
}

export function Modal({
  open,
  onClose,
  title,
  children,
  wide = false,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  /** Wider dialog for tables (default keeps the standard width). */
  wide?: boolean;
}) {
  // Closing animation: stay mounted ~150ms after `open` turns false, showing the last
  // open content (callers often clear the data the body reads). Reduced motion: close instantly.
  const [shown, setShown] = useState(open);
  if (open && !shown) setShown(true);
  const closing = shown && !open;
  if (closing && prefersReducedMotion()) setShown(false);
  const lastOpen = useRef({ title, children });
  if (open) lastOpen.current = { title, children };
  useEffect(() => {
    if (!closing) return;
    const t = window.setTimeout(() => setShown(false), MODAL_CLOSE_MS);
    return () => window.clearTimeout(t);
  }, [closing]);

  if (!open && !shown) return null;
  const view = open ? { title, children } : lastOpen.current;
  return (
    <div
      className={`fixed inset-0 z-50 grid place-items-center bg-ink/30 p-4 backdrop-blur-[6px] ${
        closing ? "pointer-events-none animate-overlay-out" : "animate-overlay-in"
      }`}
      onClick={onClose}
    >
      <div
        className={`scroll-thin max-h-[85vh] w-full ${wide ? "max-w-4xl" : "max-w-lg"} overflow-y-auto rounded-2xl border border-line/70 bg-surface p-6 shadow-pop ${
          closing ? "animate-dialog-out" : "animate-dialog-in"
        }`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-start justify-between gap-4">
          <h2 className="text-lg font-bold tracking-[-0.01em] text-ink">{view.title}</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="-m-1.5 grid h-8 w-8 place-items-center rounded-lg text-slate-400 transition-colors hover:bg-tint hover:text-ink"
          >
            <Icon name="close" size={18} />
          </button>
        </div>
        {view.children}
      </div>
    </div>
  );
}

/** Underline-style tab bar. Purely visual — the caller owns the active state. */
export function Tabs<T extends string>({
  tabs,
  value,
  onChange,
}: {
  tabs: { value: T; label: string }[];
  value: T;
  onChange: (v: T) => void;
}) {
  // Gradient indicator that slides under the active tab (measured, transform-only animation).
  const bar = useRef<HTMLDivElement>(null);
  const [indicator, setIndicator] = useState<{ x: number; w: number } | null>(null);
  useLayoutEffect(() => {
    const measure = () => {
      const el = bar.current?.querySelector<HTMLElement>('[aria-selected="true"]');
      setIndicator(el ? { x: el.offsetLeft, w: el.offsetWidth } : null);
    };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [value, tabs.length]);
  return (
    <div ref={bar} className="relative mb-5 flex gap-1 border-b border-line" role="tablist">
      {tabs.map((t) => {
        const active = t.value === value;
        return (
          <button
            key={t.value}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onChange(t.value)}
            className={`rounded-t-lg px-4 py-2.5 text-sm font-medium transition-colors duration-200 ${
              active ? "font-semibold text-ink" : "text-slate-550 hover:bg-tint hover:text-ink"
            }`}
          >
            {t.label}
          </button>
        );
      })}
      {indicator && (
        <span
          aria-hidden="true"
          className="pointer-events-none absolute -bottom-px left-0 h-[3px] w-px origin-left rounded-full bg-gradient-accent transition-transform duration-300 ease-in-out-soft motion-reduce:transition-none"
          style={{ transform: `translateX(${indicator.x}px) scaleX(${indicator.w})` }}
        />
      )}
    </div>
  );
}

export function Table({ head, children }: { head: ReactNode[]; children: ReactNode }) {
  return (
    <div className="-mx-4 overflow-x-auto rounded-xl border-y border-line/70 bg-surface shadow-card sm:mx-0 sm:rounded-xl sm:border-x">
      <table className="table-soft w-full min-w-[44rem] text-sm">
        <thead>
          <tr className="border-b border-line text-left">
            {head.map((h, i) => (
              <th key={i} className="px-4 py-3 text-xs font-semibold uppercase tracking-[0.06em] text-slate-550">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}
