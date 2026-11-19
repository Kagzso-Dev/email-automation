import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { useScrolledShadow } from "../lib/useScrolledShadow";

/**
 * Send Queue building blocks shared by the Email, WhatsApp and AI Call
 * follow-ups tabs: a card whose table scrolls inside its own box (sized to the
 * space left on screen, so the page itself doesn't scroll) with a sticky header
 * row, and the pagination bar as the card's footer.
 */

/** The table card: 16px radius, soft border and shadow. Also used for the empty / no-match states. */
export const QUEUE_CARD = "overflow-hidden rounded-xl border border-line/70 bg-surface shadow-card";

/** Space kept below the table: the card's pagination footer plus the page's bottom padding. */
const RESERVED_BELOW = 124;
const MIN_HEIGHT = 240;

/** Max height that makes `ref` end at the bottom of the viewport (recomputed on resize / layout changes). */
export function useFillHeight(ref: React.RefObject<HTMLElement>, reservedBelow = RESERVED_BELOW) {
  const [height, setHeight] = useState<number | null>(null);
  const measure = () => {
    const el = ref.current;
    if (!el) return;
    const top = el.getBoundingClientRect().top + window.scrollY;
    const next = Math.max(MIN_HEIGHT, Math.floor(window.innerHeight - top - reservedBelow));
    setHeight((h) => (h === next ? h : next));
  };
  useLayoutEffect(measure); // content above (tabs, filters, notes) can change height between renders
  useEffect(() => {
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return height;
}

export function ScrollTable({
  head,
  children,
  scrollKey,
  minWidth = "44rem",
  footer,
  label,
}: {
  head: ReactNode[];
  children: ReactNode;
  /** When this changes (page, page size, filter), the box scrolls back to the top. */
  scrollKey?: string;
  minWidth?: string;
  /** Under the table, inside the card (the pagination bar). */
  footer?: ReactNode;
  /** The table's caption for screen readers, e.g. "Email batches". */
  label?: string;
}) {
  const box = useRef<HTMLDivElement | null>(null);
  const maxHeight = useFillHeight(box);
  const shadowRef = useScrolledShadow<HTMLDivElement>();
  const setBox = useCallback(
    (el: HTMLDivElement | null) => {
      box.current = el;
      shadowRef(el);
    },
    [shadowRef],
  );
  useEffect(() => {
    if (box.current) box.current.scrollTop = 0;
  }, [scrollKey]);
  return (
    <div className={QUEUE_CARD}>
      <div
        ref={setBox}
        // Scrolls both ways: down inside the card, sideways on small screens (the page itself never scrolls sideways).
        className="scroll-shadow scroll-thin overflow-auto overscroll-contain"
        style={{ maxHeight: maxHeight ?? undefined, scrollBehavior: "smooth" }}
      >
        <table className="table-soft w-full text-sm" style={{ minWidth }}>
          {label ? <caption className="sr-only">{label}</caption> : null}
          <thead>
            <tr className="text-left">
              {head.map((h, i) => (
                <th
                  key={i}
                  scope="col"
                  // Sticky header: own background + a drawn bottom rule (borders don't stick with the cell).
                  // text-slate-550 (not the table's slate-500) keeps the labels above 4.5:1 on the header tint.
                  className="sticky top-0 z-10 whitespace-nowrap px-4 py-3 text-xs font-semibold uppercase tracking-[0.06em] text-slate-550 shadow-[inset_0_-1px_0_rgb(var(--c-line))]"
                >
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>{children}</tbody>
        </table>
      </div>
      {footer ? <div className="border-t border-line-subtle px-4 py-3">{footer}</div> : null}
    </div>
  );
}

/** Skeleton rows inside the scroll box while a page loads. */
export function SkeletonRows({ cols, rows = 6 }: { cols: number; rows?: number }) {
  return (
    <>
      {Array.from({ length: rows }).map((_, r) => (
        <tr key={r} className="border-b border-line-subtle last:border-0" aria-hidden="true">
          {Array.from({ length: cols }).map((__, c) => (
            <td key={c} className="px-4 py-3">
              <div className="h-3.5 animate-pulse rounded bg-surface-muted" style={{ width: c === 0 ? 14 : `${50 + ((r * 7 + c * 13) % 40)}%` }} />
            </td>
          ))}
        </tr>
      ))}
    </>
  );
}

export const PAGE_SIZES = [10, 25, 50] as const;

export function QueuePagination({
  page,
  pageSize,
  total,
  onPage,
  onPageSize,
  noun = "batches",
}: {
  page: number;
  pageSize: number;
  total: number;
  onPage: (p: number) => void;
  onPageSize: (n: number) => void;
  noun?: string;
}) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const from = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const to = Math.min(page * pageSize, total);
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 text-sm text-slate-550">
      <p aria-live="polite">
        Showing{" "}
        <span className="font-medium tabular-nums text-ink">
          {from}–{to}
        </span>{" "}
        of <span className="font-medium tabular-nums text-ink">{total}</span> {noun}
      </p>
      <div className="flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-2 text-xs">
          Per page
          <select
            className="input h-9 w-auto rounded-[10px] py-0"
            aria-label="Rows per page"
            value={pageSize}
            onChange={(e) => onPageSize(Number(e.target.value))}
          >
            {PAGE_SIZES.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </label>
        <nav aria-label="Pages" className="flex items-center gap-1.5">
          <button type="button" className="btn-ghost h-9 gap-1 px-2.5" disabled={page <= 1} onClick={() => onPage(page - 1)}>
            <ChevronLeft size={16} aria-hidden="true" />
            Prev
          </button>
          <span className="min-w-[3.25rem] text-center font-mono text-xs tabular-nums text-ink">
            {page} / {pages}
          </span>
          <button type="button" className="btn-ghost h-9 gap-1 px-2.5" disabled={page >= pages} onClick={() => onPage(page + 1)}>
            Next
            <ChevronRight size={16} aria-hidden="true" />
          </button>
        </nav>
      </div>
    </div>
  );
}

/** One page of an already-loaded, newest-first list. `page` is clamped to the last page. */
export function pageOf<T>(items: T[], page: number, pageSize: number) {
  const pages = Math.max(1, Math.ceil(items.length / pageSize));
  const current = Math.min(Math.max(1, page), pages);
  return { rows: items.slice((current - 1) * pageSize, current * pageSize), page: current, pages };
}
