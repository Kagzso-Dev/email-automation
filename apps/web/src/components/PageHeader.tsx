// Page header with a consistent action bar (Email / WhatsApp / Voicecall Contacts, AI Agents).
//
//   [Title]                               [danger] │ [secondary] [secondary] [primary]
//   subtitle (full width, under the title)
//   helper text (full width, below; never under the buttons)
//
// Desktop (≥1024px): one row, never wraps; every button 40px high, 10px radius, 14px / 500.
// Below 1024px the header stacks (title, then the buttons, which wrap). Below 640px the buttons are full width and
// stacked, primary first. The danger action (e.g. "Hard stop all email") sits at the far left of the group behind a
// thin divider, so it isn't clicked by accident; when it renders nothing (flag off) the divider goes too.
// Layout only: the actions keep their own handlers, titles and disabled states.

import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

export interface PageHeaderAction {
  /** Visible text (counts included, e.g. "Send email (3)"). Also the button's aria-label. */
  label: string;
  icon?: LucideIcon;
  onClick: () => void;
  disabled?: boolean;
  /** Tooltip: what it does, or why it is disabled. */
  title?: string;
  /** A destructive secondary action (e.g. "Delete (3)"): the danger look. */
  tone?: "danger";
}

/** Shared by every header button: 40px high, 10px radius, 14px / 500, visible keyboard focus. */
const BUTTON_BASE =
  "inline-flex h-10 shrink-0 items-center justify-center gap-2 whitespace-nowrap rounded-[10px] border px-4 text-sm font-medium " +
  "transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent " +
  "disabled:pointer-events-none disabled:opacity-50 max-sm:w-full";

/** Solid accent gradient (the project's own token; navy text keeps WCAG AA contrast on it). */
export const HEADER_BUTTON_PRIMARY = `${BUTTON_BASE} border-transparent bg-gradient-accent text-ink shadow-[0_2px_8px_rgba(0,194,255,0.18)] hover:shadow-[var(--shadow-glow)] hover:brightness-[1.03]`;
/** White, light border, subtle shadow; light gray on hover. */
export const HEADER_BUTTON_SECONDARY = `${BUTTON_BASE} border-line-strong bg-surface text-ink shadow-sm hover:bg-surface-muted`;
/** Light red, red text, red-tinted border; a slightly darker tint on hover. */
export const HEADER_BUTTON_DANGER = `${BUTTON_BASE} border-crit-line bg-crit-soft text-crit hover:border-crit/40 hover:bg-crit-line/60`;

/** Search inputs and filter dropdowns under a header: the same height and radius as the buttons. */
export const HEADER_CONTROL = "h-10 rounded-[10px] py-0";
/** The search + filter row: one row from 640px up, 12px apart. */
export const FILTER_ROW = "mb-4 flex flex-col gap-3 sm:flex-row sm:items-center";

export function HeaderButton({ action, primary = false }: { action: PageHeaderAction; primary?: boolean }) {
  const Icon = action.icon;
  const style = primary ? HEADER_BUTTON_PRIMARY : action.tone === "danger" ? HEADER_BUTTON_DANGER : HEADER_BUTTON_SECONDARY;
  return (
    <button
      type="button"
      // Mobile: the primary action comes first in the stack; from 640px up it is last (rightmost).
      className={`${style} ${primary ? "order-first sm:order-none" : ""}`}
      aria-label={action.label}
      title={action.title}
      disabled={action.disabled}
      onClick={action.onClick}
    >
      {Icon && <Icon size={16} aria-hidden="true" className="shrink-0" />}
      <span>{action.label}</span>
    </button>
  );
}

export function PageHeader({
  title,
  subtitle,
  primaryAction,
  secondaryActions = [],
  dangerAction,
  helper,
}: {
  title: string;
  subtitle?: ReactNode;
  primaryAction?: PageHeaderAction;
  /** Left out when false / null / undefined, so a page can write `cond && { … }`. */
  secondaryActions?: (PageHeaderAction | false | null | undefined)[];
  /** A self-contained control (e.g. a Hard stop button with its own confirmation); may render nothing. */
  dangerAction?: ReactNode;
  /** The page's help text: a full-width block below the header, never under the buttons. */
  helper?: ReactNode;
}) {
  const secondary = secondaryActions.filter((a): a is PageHeaderAction => !!a);
  const hasActions = !!primaryAction || secondary.length > 0 || !!dangerAction;
  return (
    <div className={helper ? "mb-4" : "mb-6"}>
      <div className="flex flex-col items-start gap-4 lg:flex-row lg:flex-nowrap lg:items-center lg:justify-between">
        <h1 className="min-w-0 text-[28px] font-bold leading-tight tracking-[-0.02em] text-ink">
          <GradientLastWord text={title} />
        </h1>
        {hasActions && (
          <div
            role="group"
            aria-label={`${title} actions`}
            className="flex w-full flex-col gap-3 sm:w-auto sm:flex-row sm:flex-wrap sm:items-center lg:shrink-0 lg:flex-nowrap"
          >
            {dangerAction ? (
              // The divider is this box's ::after; an empty box (the action rendered nothing) is hidden with it.
              <div className="relative flex empty:hidden max-sm:w-full sm:pr-3 sm:after:absolute sm:after:right-0 sm:after:top-1/2 sm:after:h-6 sm:after:w-px sm:after:-translate-y-1/2 sm:after:bg-line sm:after:content-['']">
                {dangerAction}
              </div>
            ) : null}
            {secondary.map((a) => (
              <HeaderButton key={a.label} action={a} />
            ))}
            {primaryAction ? <HeaderButton action={primaryAction} primary /> : null}
          </div>
        )}
      </div>
      {/* Under the title, full width: a long subtitle never squeezes into a column beside the buttons. */}
      {subtitle ? <p className="mt-2 max-w-[800px] text-sm leading-[1.6] text-slate-550">{subtitle}</p> : null}
      {helper ? <p className="mt-3 max-w-[800px] text-[13px] leading-relaxed text-slate-550">{helper}</p> : null}
    </div>
  );
}

/** The last word of a title in the accent gradient ("Voicecall <Contact>"), as on every other page. */
function GradientLastWord({ text }: { text: string }) {
  const cut = text.trimEnd().lastIndexOf(" ");
  if (cut <= 0) return <>{text}</>;
  return (
    <>
      {text.slice(0, cut + 1)}
      <span className="text-gradient">{text.slice(cut + 1)}</span>
    </>
  );
}
