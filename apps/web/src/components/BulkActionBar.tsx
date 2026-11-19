// Actions on the ticked rows of a contacts table ("3 selected · Clear  [Start voice call (3)] [Delete (3)]"), shown
// between the filters and the table only while rows are ticked. Page-wide actions stay in <PageHeader />.
//
// It opens and closes with a short height / opacity transition (no jump), stays in view while a long table scrolls
// (sticky, 12px from the top), and on phones (<640px) becomes a bar fixed to the bottom with icon-only buttons (their
// names as tooltips and aria-labels). Layout only: each action keeps its own handler, title and disabled state.

import { useEffect, useRef } from "react";
import { BAR_BUTTON, BAR_BUTTON_DANGER, type PageHeaderAction } from "./PageHeader";

export function BulkActionBar({
  count,
  onClear,
  actions,
}: {
  /** Rows ticked now; 0 hides the bar. */
  count: number;
  /** Untick every row. */
  onClear: () => void;
  /** Left out when false / null / undefined. Put the destructive one (Delete) last. */
  actions: (PageHeaderAction | false | null | undefined)[];
}) {
  const open = count > 0;
  const box = useRef<HTMLDivElement>(null);
  // While closing, keep showing the last count instead of "0 selected".
  const shown = useRef(count);
  if (count > 0) shown.current = count;
  // Hidden: nothing in it can be focused or clicked.
  useEffect(() => {
    if (box.current) box.current.inert = !open;
  }, [open]);
  const list = actions.filter((a): a is PageHeaderAction => !!a);

  return (
    <div
      ref={box}
      aria-hidden={!open}
      className={
        "grid transition-[grid-template-rows,opacity,margin] duration-200 ease-out motion-reduce:transition-none " +
        "sm:sticky sm:top-3 sm:z-10 max-sm:fixed max-sm:inset-x-3 max-sm:bottom-3 max-sm:z-30 " +
        (open ? "grid-rows-[1fr] opacity-100 sm:mb-3" : "pointer-events-none grid-rows-[0fr] opacity-0 sm:mb-0")
      }
    >
      <div className="min-h-0 overflow-hidden">
        <div
          role="toolbar"
          aria-label="Actions for the selected rows"
          // Too narrow for one line (tablets): the actions move together to a second line, right-aligned.
          className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 rounded-[12px] border border-accent/30 bg-accent-soft px-4 py-2.5 shadow-sm max-sm:flex-nowrap max-sm:shadow-pop"
        >
          <div className="flex min-w-0 items-center gap-3 text-sm">
            <span className="whitespace-nowrap font-medium text-ink" aria-live="polite">
              {shown.current} selected
            </span>
            <button
              type="button"
              className="rounded font-medium text-accent-ink hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
              onClick={onClear}
            >
              Clear
            </button>
          </div>
          <div className="ml-auto flex items-center justify-end gap-2 sm:gap-3">
            {list.map((a) => {
              const Icon = a.icon;
              return (
                <button
                  key={a.label}
                  type="button"
                  className={a.tone === "danger" ? BAR_BUTTON_DANGER : BAR_BUTTON}
                  aria-label={a.label}
                  // Phones show the icon only: the name is the tooltip.
                  title={a.title ?? a.label}
                  disabled={a.disabled}
                  onClick={a.onClick}
                >
                  {Icon && <Icon size={16} aria-hidden="true" className="shrink-0" />}
                  <span className="max-sm:sr-only">{a.label}</span>
                </button>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
