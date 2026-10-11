import { AnimatedNumber, TrendPill } from "../charts";
import { Icon, type IconName } from "../icons";
import { Skeleton } from "../ui";

export interface ChannelSummaryItem {
  key: "email" | "whatsapp" | "calls";
  label: string;
  icon: IconName;
  /** Undefined while loading. */
  value: number | undefined;
  delta: number | null | undefined;
  failed: boolean;
}

/** "All" view: one card per channel — main number for the range and the change vs the previous period. */
export function ChannelSummary({
  items,
  span,
  onPick,
}: {
  items: ChannelSummaryItem[];
  span: number;
  onPick: (key: ChannelSummaryItem["key"]) => void;
}) {
  return (
    <div className={`grid gap-4 sm:grid-cols-2 ${items.length === 3 ? "lg:grid-cols-3" : ""}`}>
      {items.map((it) => (
        <button
          key={it.key}
          type="button"
          onClick={() => onPick(it.key)}
          className="card card-hover fade-rise text-left"
          aria-label={`Show ${it.label} details`}
        >
          <div className="flex items-start justify-between gap-3">
            <div className="label">{it.label}</div>
            <span className="icon-chip h-9 w-9 shrink-0" aria-hidden="true">
              <Icon name={it.icon} size={18} />
            </span>
          </div>
          {it.failed ? (
            <p className="mt-2 text-sm text-crit">Couldn't load this channel.</p>
          ) : it.value === undefined ? (
            <>
              <Skeleton className="mt-2 h-7 w-20" />
              <Skeleton className="mt-2 h-3 w-28" />
            </>
          ) : (
            <>
              <div className="metric-value mt-2">
                <AnimatedNumber value={it.value} />
              </div>
              <div className="mt-1 flex flex-wrap items-center gap-x-2 text-xs text-slate-550">
                <TrendPill delta={it.delta ?? null} />
                <span>vs previous {span} days</span>
              </div>
            </>
          )}
        </button>
      ))}
    </div>
  );
}
