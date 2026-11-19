import { cloneElement, useEffect, useId, useLayoutEffect, useRef, useState, type ReactElement, type ReactNode } from "react";
import { createPortal } from "react-dom";

/**
 * A small styled tooltip for icon buttons and other compact controls. It shows on hover and on keyboard focus,
 * hides on leave / blur / Escape / scroll, and is drawn in a portal so a scrolling table never clips it.
 *
 * The control keeps its own aria-label. Pass `describe` when the tooltip says something the label doesn't (e.g.
 * why a button is disabled): the text is then also linked with aria-describedby, from an always-present copy.
 * It also shows over a disabled button: `.btn` / `.btn-icon` set pointer-events: none when disabled, so the
 * pointer lands on this wrapper.
 */
export function Tooltip({
  label,
  children,
  describe = false,
}: {
  label: ReactNode;
  children: ReactElement;
  describe?: boolean;
}) {
  const id = useId();
  const anchor = useRef<HTMLSpanElement>(null);
  const tip = useRef<HTMLSpanElement>(null);
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  // Measure once the (hidden) tooltip is in the DOM, then place it above the control (below when there's no room),
  // kept 8px inside the viewport.
  useLayoutEffect(() => {
    if (!open) {
      setPos(null);
      return;
    }
    const a = anchor.current?.getBoundingClientRect();
    const t = tip.current?.getBoundingClientRect();
    if (!a || !t) return;
    const gap = 6;
    const margin = 8;
    const above = a.top - t.height - gap;
    const top = above < margin ? a.bottom + gap : above;
    const left = Math.min(Math.max(a.left + a.width / 2 - t.width / 2, margin), window.innerWidth - t.width - margin);
    setPos({ left, top });
  }, [open, label]);

  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    document.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const descId = `${id}-desc`;
  const child = describe ? cloneElement(children, { "aria-describedby": descId }) : children;

  return (
    <span
      ref={anchor}
      className="inline-flex"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onFocus={() => setOpen(true)}
      onBlur={() => setOpen(false)}
    >
      {child}
      {describe && (
        <span id={descId} className="sr-only">
          {label}
        </span>
      )}
      {open &&
        createPortal(
          <span
            ref={tip}
            aria-hidden="true"
            className="pointer-events-none fixed z-[80] max-w-[16rem] rounded-md bg-ink px-2 py-1 text-xs font-medium leading-snug text-white shadow-pop"
            style={pos ? { left: pos.left, top: pos.top } : { left: 0, top: 0, visibility: "hidden" }}
          >
            {label}
          </span>,
          document.body,
        )}
    </span>
  );
}
