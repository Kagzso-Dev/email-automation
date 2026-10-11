import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { AnimatedNumber } from "../charts";
import { Icon, type IconName } from "../icons";
import { Skeleton } from "../ui";

/** Heading above each channel section on the Dashboard. */
export function SectionHeading({ icon, title, action }: { icon: IconName; title: string; action?: ReactNode }) {
  return (
    <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
      <h2 className="flex items-center gap-2.5 text-base font-bold tracking-[-0.01em] text-ink">
        <span className="icon-chip h-8 w-8" aria-hidden="true">
          <Icon name={icon} size={16} />
        </span>
        {title}
      </h2>
      {action}
    </div>
  );
}

/** One number card. `value` null renders "—" (e.g. no finished calls yet). */
export function StatTile({
  label,
  value,
  format = "int",
  display,
  sub,
  to,
}: {
  label: string;
  value: number;
  format?: "int" | "pct";
  /** Pre-formatted text instead of an animated number (durations). */
  display?: string;
  sub?: ReactNode;
  to?: string;
}) {
  const body = (
    <>
      <div className="label">{label}</div>
      <div className="metric-value mt-2">{display ?? <AnimatedNumber value={value} format={format} />}</div>
      {sub ? <div className="mt-1 text-xs leading-[1.5] text-slate-550">{sub}</div> : null}
    </>
  );
  return to ? (
    <Link to={to} className="card card-hover fade-rise block">
      {body}
    </Link>
  ) : (
    <div className="card fade-rise">{body}</div>
  );
}

/** Placeholder for a section's stat grid + chart while its first load is in flight. */
export function SectionSkeleton({ tiles = 4 }: { tiles?: number }) {
  return (
    <div role="status" aria-label="Loading" className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {Array.from({ length: tiles }).map((_, i) => (
          <div key={i} className="card">
            <Skeleton className="h-3 w-24" />
            <Skeleton className="mt-3 h-7 w-16" />
          </div>
        ))}
      </div>
      <div className="card">
        <Skeleton className="h-[200px] w-full rounded-lg" />
      </div>
    </div>
  );
}

/** Chart-area empty state ("No WhatsApp activity in this period"). */
export function ChartEmpty({ children }: { children: ReactNode }) {
  return <div className="grid h-[200px] place-items-center text-center text-sm text-slate-550">{children}</div>;
}
