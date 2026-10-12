/**
 * The Dispatch logo (hexagon mark) — one place for every use: sidebar, mobile
 * top bar and login card. Files live in /public; the source picked is at least
 * 2× the shown size so it stays sharp on high-DPI screens.
 */
export function Logo({ size = 28, className = "" }: { size?: number; className?: string }) {
  // "?v=" busts browser caches when the logo files are replaced.
  const src = `${size <= 32 ? "/logo-64.png" : size <= 64 ? "/logo-128.png" : "/logo-512.png"}?v=2`;
  return (
    <img
      src={src}
      alt="Dispatch logo"
      width={size}
      height={size}
      className={`shrink-0 select-none object-contain ${className}`}
      draggable={false}
    />
  );
}
