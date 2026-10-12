import { useCallback, useRef } from "react";

/**
 * Callback ref for a scroll box with a sticky table header: sets `data-scrolled`
 * on the box while its content is scrolled under the header, so `.scroll-shadow`
 * (index.css) can fade a soft shadow in. Passive listener, attribute only — no re-renders.
 */
export function useScrolledShadow<T extends HTMLElement>() {
  const detach = useRef<(() => void) | null>(null);
  return useCallback((el: T | null) => {
    detach.current?.();
    detach.current = null;
    if (!el) return;
    const update = () => el.toggleAttribute("data-scrolled", el.scrollTop > 0);
    update();
    el.addEventListener("scroll", update, { passive: true });
    detach.current = () => el.removeEventListener("scroll", update);
  }, []);
}
