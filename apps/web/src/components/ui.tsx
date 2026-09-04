import type { ReactNode } from "react";
import { Icon, type IconName } from "./icons";

export function Badge({ children, tone = "neutral" }: { children: ReactNode; tone?: BadgeTone }) {
  const tones: Record<BadgeTone, string> = {
    neutral: "bg-[#eef0f4] text-slate-550",
    accent: "bg-accent-soft text-accent-ink",
    ok: "bg-[#e7f1ec] text-ok",
    warn: "bg-[#f8f0e1] text-warn",
    crit: "bg-[#f9ebe9] text-crit",
  };
  return (
    <span className={`inline-flex rounded-full px-2 py-0.5 font-mono text-xs ${tones[tone]}`}>
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
    <div className="rounded-xl border border-dashed border-line-strong bg-surface p-10 text-center text-sm text-slate-550">
      {icon ? (
        <span className="mx-auto mb-3 grid h-10 w-10 place-items-center rounded-full bg-surface-muted text-slate-400">
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
  return <div className="rounded-lg bg-[#f9ebe9] px-3 py-2 text-sm text-crit">{msg}</div>;
}

export function Modal({
  open,
  onClose,
  title,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
}) {
  if (!open) return null;
  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-black/30 p-4 animate-overlay-in"
      onClick={onClose}
    >
      <div
        className="max-h-[85vh] w-full max-w-lg overflow-y-auto rounded-xl bg-white p-6 shadow-xl animate-dialog-in"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-start justify-between gap-4">
          <h2 className="text-lg font-semibold">{title}</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="-m-1.5 grid h-8 w-8 place-items-center rounded-lg text-slate-400 hover:bg-surface-muted hover:text-ink"
          >
            <Icon name="close" size={18} />
          </button>
        </div>
        {children}
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
  return (
    <div className="mb-5 flex gap-1 border-b border-[#e3e6ec]" role="tablist">
      {tabs.map((t) => {
        const active = t.value === value;
        return (
          <button
            key={t.value}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onChange(t.value)}
            className={`-mb-px border-b-2 px-4 py-2 text-sm font-medium transition-colors ${
              active
                ? "border-accent-ink text-accent-ink"
                : "border-transparent text-slate-550 hover:text-ink"
            }`}
          >
            {t.label}
          </button>
        );
      })}
    </div>
  );
}

export function Table({ head, children }: { head: ReactNode[]; children: ReactNode }) {
  return (
    <div className="-mx-4 overflow-x-auto rounded-xl border-y border-[#e3e6ec] bg-white sm:mx-0 sm:rounded-xl sm:border-x">
      <table className="w-full min-w-[44rem] text-sm">
        <thead>
          <tr className="border-b border-[#e3e6ec] text-left">
            {head.map((h, i) => (
              <th key={i} className="px-4 py-2.5 text-xs font-semibold uppercase tracking-wide text-slate-550">
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
