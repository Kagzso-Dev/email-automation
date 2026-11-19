// Page header with a consistent action bar (Email / WhatsApp / Voicecall Contacts, AI Agents).
//
//   [Title] (Tamil)                       [danger] │ [secondary] [primary]
//   description (full width, under the header; never under the buttons)
//
// Only page-wide actions belong here (Import file, Add contact). Actions on ticked rows go in <BulkActionBar />.
// Desktop (≥1024px): one row, never wraps; the title stays on one line; every button 40px high, 10px radius,
// 14px / 500. Below 1024px the header stacks (title, then the buttons, which wrap). Below 640px the title is 22px and
// the buttons are full width and stacked, primary first. The danger action (e.g. "Hard stop all Tamil calls") sits at
// the far left of the group behind a thin divider, so it isn't clicked by accident; when it renders nothing (flag
// off) the divider goes too. Layout only: the actions keep their own handlers, titles and disabled states.

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
  /** A destructive action (e.g. "Delete (3)"): the danger look. */
  tone?: "danger";
}

/** Every header / bar button: 10px radius, 14px / 500, icon 16px 8px from the label, visible keyboard focus. */
const BUTTON_CORE =
  "inline-flex shrink-0 items-center justify-center gap-2 whitespace-nowrap rounded-[10px] border text-sm font-medium " +
  "transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent " +
  "disabled:pointer-events-none disabled:opacity-50";
const BUTTON_BASE = `${BUTTON_CORE} h-10 px-4 max-sm:w-full`;

/** Cyan → teal (the project's darker accent gradient token, so the white text stays readable). */
const PRIMARY_LOOK = "border-transparent bg-[image:var(--gradient-accent-text)] text-white shadow-[0_2px_8px_rgba(0,137,194,0.25)] hover:brightness-110";
/** White, light border, subtle shadow; light gray on hover. */
const SECONDARY_LOOK = "border-line-strong bg-surface text-ink shadow-sm hover:bg-surface-muted";
/** Light red, red text, red-tinted border; a slightly darker tint on hover. */
const DANGER_LOOK = "border-crit-line bg-crit-soft text-crit hover:border-crit/40 hover:bg-crit-line/60";

export const HEADER_BUTTON_PRIMARY = `${BUTTON_BASE} ${PRIMARY_LOOK}`;
export const HEADER_BUTTON_SECONDARY = `${BUTTON_BASE} ${SECONDARY_LOOK}`;
export const HEADER_BUTTON_DANGER = `${BUTTON_BASE} ${DANGER_LOOK}`;
/** The bulk-action bar's buttons: the same looks, 36px high. */
export const BAR_BUTTON = `${BUTTON_CORE} h-9 px-3.5 ${SECONDARY_LOOK}`;
export const BAR_BUTTON_DANGER = `${BUTTON_CORE} h-9 px-3.5 ${DANGER_LOOK}`;

/** The search + filter row under the header: 12px apart, wraps on narrow screens. */
export const FILTER_ROW = "mb-4 flex flex-wrap items-center gap-3";
/** The search input: takes the free width, never narrower than 260px. 40px, the buttons' radius. */
export const SEARCH_INPUT = "input h-10 min-w-[260px] flex-1 rounded-[10px] py-0";
/** A filter dropdown: 40px, the buttons' radius; full width on phones. */
export const FILTER_SELECT = "input h-10 w-full rounded-[10px] py-0 sm:w-48";

/** A contacts-table row: 56px high, cells vertically centred. */
export const TABLE_ROW = "h-14 border-b border-line-subtle last:border-0 [&>td]:align-middle";
/** The row's Edit / Delete cell: far right, never wraps (the links inside sit 12px apart). */
export const ROW_ACTIONS_CELL = "whitespace-nowrap px-4 py-2.5 text-right";

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
  badge,
  subtitle,
  primaryAction,
  secondaryActions = [],
  dangerAction,
  helper,
}: {
  title: string;
  /** A small pill next to the title, e.g. the page's language ("Tamil"). */
  badge?: string;
  subtitle?: ReactNode;
  primaryAction?: PageHeaderAction;
  /** Page-wide actions only. Left out when false / null / undefined, so a page can write `cond && { … }`. */
  secondaryActions?: (PageHeaderAction | false | null | undefined)[];
  /** A self-contained control (e.g. a Hard stop button with its own confirmation); may render nothing. */
  dangerAction?: ReactNode;
  /** More help text (e.g. which file columns an import reads), shown with the description. */
  helper?: ReactNode;
}) {
  const secondary = secondaryActions.filter((a): a is PageHeaderAction => !!a);
  const hasActions = !!primaryAction || secondary.length > 0 || !!dangerAction;
  return (
    <div className="mb-4">
      <div className="flex flex-col items-start gap-4 lg:flex-row lg:flex-nowrap lg:items-center lg:justify-between">
        <div className="flex min-w-0 items-center gap-2.5">
          <h1 className="whitespace-nowrap text-[22px] font-bold leading-tight tracking-[-0.02em] text-ink sm:text-[28px]">
            <GradientLastWord text={title} />
          </h1>
          {badge ? (
            <span className="shrink-0 rounded-full bg-accent-soft px-2.5 py-0.5 text-[13px] font-medium text-accent-ink">{badge}</span>
          ) : null}
        </div>
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
      {/* The description: full width under the header, so it never sits under or beside the buttons. */}
      {subtitle ? <p className={DESCRIPTION}>{subtitle}</p> : null}
      {helper ? <p className={DESCRIPTION}>{helper}</p> : null}
    </div>
  );
}

const DESCRIPTION = "mt-2 max-w-[820px] text-[13px] leading-[1.5] text-slate-550";

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
