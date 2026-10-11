import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";

/**
 * Send Queue building blocks shared by the Email, WhatsApp and AI Call
 * follow-ups tabs: a table that scrolls inside its own box (sized to the space
 * left on screen, so the page itself doesn't scroll) with a sticky header row,
 * and a compact pagination bar in the style of the WhatsApp Contacts pager.
 */

/** Space kept below the table: the pagination bar plus the page's bottom padding. */
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
}: {
  head: ReactNode[];
  children: ReactNode;
  /** When this changes (page, page size, filter), the box scrolls back to the top. */
  scrollKey?: string;
  minWidth?: string;
}) {
  const box = useRef<HTMLDivElement>(null);
  const maxHeight = useFillHeight(box);
  useEffect(() => {
    if (box.current) box.current.scrollTop = 0;
  }, [scrollKey]);
  return (
    <div
      ref={box}
      className="scroll-thin -mx-4 overflow-auto overscroll-contain rounded-xl border-y border-line/70 bg-surface shadow-card sm:mx-0 sm:rounded-xl sm:border-x"
      style={{ maxHeight: maxHeight ?? undefined, scrollBehavior: "smooth" }}
    >
      <table className="table-soft w-full text-sm" style={{ minWidth }}>
        <thead>
          <tr className="text-left">
            {head.map((h, i) => (
              <th
                key={i}
                // Sticky header: own background + a drawn bottom rule (borders don't stick with the cell).
                className="sticky top-0 z-10 px-4 py-3 text-xs font-semibold uppercase tracking-[0.06em] text-slate-550 shadow-[inset_0_-1px_0_rgb(var(--c-line))]"
              >
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
    <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-sm text-slate-550">
      <span>
        Showing {from}–{to} of {total} {noun}
      </span>
      <div className="flex items-center gap-2">
        <label className="flex items-center gap-1.5 text-xs">
          <span className="hidden sm:inline">Per page</span>
          <select
            className="input w-auto py-1.5"
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
        <button className="btn-ghost" disabled={page <= 1} onClick={() => onPage(page - 1)}>
          Prev
        </button>
        <span className="px-2 py-2 font-mono text-xs tabular-nums text-ink">
          {page} / {pages}
        </span>
        <button className="btn-ghost" disabled={page >= pages} onClick={() => onPage(page + 1)}>
          Next
        </button>
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
