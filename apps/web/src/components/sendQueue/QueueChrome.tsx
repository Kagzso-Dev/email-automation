// Send Queue → the pieces around each tab's table: the filter row (search + Status), the empty / no-match states,
// and the tab labels with their counts. Layout only.

import { useId, type ReactNode } from "react";
import { Search, SearchX, X } from "lucide-react";
import { Icon, type IconName } from "../icons";

/** One row above the table card: search (grows) on the left, Status on the right; stacks on phones. */
export function QueueFilterBar({
  status,
  statusOptions,
  onStatus,
  search,
  onSearch,
  searchLabel = "Search",
  searchPlaceholder,
  children,
}: {
  status: string;
  statusOptions: { value: string; label: string }[];
  onStatus: (value: string) => void;
  /** Leave out (with onSearch) on tabs that can't search. */
  search?: string;
  onSearch?: (value: string) => void;
  searchLabel?: string;
  searchPlaceholder?: string;
  /** Extra notes after the filters (e.g. "3 waiting for approval"). */
  children?: ReactNode;
}) {
  const id = useId();
  return (
    <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center">
      {onSearch && (
        <div className="relative min-w-0 sm:min-w-[16rem] sm:flex-1">
          <Search size={16} aria-hidden="true" className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" />
          <input
            type="search"
            className="input h-10 rounded-[10px] py-0 pl-9 pr-9 [&::-webkit-search-cancel-button]:hidden"
            aria-label={searchLabel}
            placeholder={searchPlaceholder}
            value={search ?? ""}
            onChange={(e) => onSearch(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape" && search) {
                e.preventDefault();
                onSearch("");
              }
            }}
          />
          {search ? (
            <button
              type="button"
              aria-label="Clear search"
              className="absolute right-1.5 top-1/2 grid h-7 w-7 -translate-y-1/2 place-items-center rounded-md text-slate-500 hover:bg-surface-muted hover:text-ink"
              onClick={() => onSearch("")}
            >
              <X size={14} aria-hidden="true" />
            </button>
          ) : null}
        </div>
      )}
      <div className={`flex items-center gap-2 ${onSearch ? "sm:ml-auto" : ""}`}>
        <label htmlFor={`${id}-status`} className="shrink-0 text-xs font-medium uppercase tracking-[0.06em] text-slate-550">
          Status
        </label>
        <select
          id={`${id}-status`}
          className="input h-10 w-full rounded-[10px] py-0 sm:w-48"
          value={status}
          onChange={(e) => onStatus(e.target.value)}
        >
          {statusOptions.map((f) => (
            <option key={f.value} value={f.value}>
              {f.label}
            </option>
          ))}
        </select>
      </div>
      {children}
    </div>
  );
}

/** Empty state inside the table card: an illustration, a short line and one call to action. */
export function QueueEmptyState({
  title,
  children,
  action,
  variant = "empty",
}: {
  title: string;
  children: ReactNode;
  action?: ReactNode;
  /** "no-match": filters / search hid everything (a smaller search glyph instead of the illustration). */
  variant?: "empty" | "no-match";
}) {
  return (
    <div className="flex flex-col items-center px-6 py-12 text-center sm:py-16">
      {variant === "empty" ? (
        <QueueIllustration />
      ) : (
        <span className="icon-chip h-12 w-12">
          <SearchX size={22} aria-hidden="true" />
        </span>
      )}
      <h3 className="mt-5 text-base font-semibold text-ink">{title}</h3>
      <p className="mt-1.5 max-w-sm text-sm leading-relaxed text-slate-550">{children}</p>
      {action ? <div className="mt-5 flex flex-wrap justify-center gap-2">{action}</div> : null}
    </div>
  );
}

/** An empty tray with a paper plane on its way: drawn with the theme's line and accent colours. */
function QueueIllustration() {
  const id = useId();
  return (
    <svg viewBox="0 0 168 120" width={168} height={120} aria-hidden="true" focusable="false">
      <defs>
        <linearGradient id={`${id}-fill`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#00c2ff" stopOpacity="0.14" />
          <stop offset="1" stopColor="#00e0b8" stopOpacity="0.14" />
        </linearGradient>
      </defs>
      {/* Theme colours via style (CSS variables), not presentation attributes. */}
      <ellipse cx="84" cy="108" rx="58" ry="7" style={{ fill: "rgb(var(--c-surface-muted))" }} />
      <rect x="30" y="50" width="108" height="52" rx="14" fill={`url(#${id}-fill)`} strokeWidth="2" style={{ stroke: "rgb(var(--c-line-strong))" }} />
      <path d="M30 74h30l7 11h34l7-11h30" fill="none" strokeWidth="2" strokeLinejoin="round" style={{ stroke: "rgb(var(--c-line-strong))" }} />
      <path d="M44 58h20M44 64h12" strokeWidth="3" strokeLinecap="round" style={{ stroke: "rgb(var(--c-line))" }} />
      <path d="M36 36c14-14 34-18 52-12" fill="none" strokeWidth="2" strokeLinecap="round" strokeDasharray="2 6" style={{ stroke: "rgb(var(--c-accent))" }} />
      <path d="M92 14l40 14-17 6-5 16-6-12-12-6z" strokeWidth="2" strokeLinejoin="round" style={{ fill: "rgb(var(--c-surface))", stroke: "rgb(var(--c-accent-ink))" }} />
      <path d="M115 34l-11 4" strokeWidth="2" strokeLinecap="round" style={{ stroke: "rgb(var(--c-accent-ink))" }} />
    </svg>
  );
}

/** A tab's label: icon, name and a small count pill (warn tone for things waiting on someone). */
export function TabLabel({
  icon,
  text,
  count,
  countLabel,
  tone = "neutral",
  active,
}: {
  icon: IconName;
  text: string;
  /** Left out while unknown (loading, error), so the pill never flashes a wrong number. */
  count?: number;
  /** Read after the number by screen readers, e.g. "batches". */
  countLabel: string;
  tone?: "neutral" | "warn";
  active: boolean;
}) {
  const pill =
    tone === "warn"
      ? "bg-warn-soft text-warn"
      : active
        ? "bg-accent-soft text-accent-ink"
        : "bg-surface-muted text-slate-600";
  return (
    <span className="inline-flex items-center gap-2">
      <Icon name={icon} size={16} className={active ? "text-accent-ink" : "text-slate-500"} />
      {text}{" "}
      {count !== undefined && (tone !== "warn" || count > 0) ? (
        <span className={`min-w-[1.375rem] rounded-full px-1.5 py-px text-center text-[11px] font-semibold tabular-nums ${pill}`}>
          {count >= 100 ? "100+" : count}
          <span className="sr-only"> {countLabel}</span>
        </span>
      ) : null}
    </span>
  );
}
