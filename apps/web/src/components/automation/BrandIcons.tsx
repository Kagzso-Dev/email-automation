import { useId } from "react";

// LinkedIn and Instagram marks for the Automation section (ENABLE_AUTOMATION): the sidebar items and the pages.
// Drawn here (not in components/icons.tsx) so the shared icon set is unchanged. Brand colours: LinkedIn blue
// #0A66C2; Instagram's gradient for the mark, and its red #E4405F for buttons.

export type Brand = "linkedin" | "instagram";

export const BRAND_COLOR: Record<Brand, string> = { linkedin: "#0A66C2", instagram: "#E4405F" };
export const BRAND_NAME: Record<Brand, string> = { linkedin: "LinkedIn", instagram: "Instagram" };

export function BrandIcon({ brand, size = 18, className }: { brand: Brand; size?: number; className?: string }) {
  const gradientId = `ig-${useId().replace(/:/g, "")}`;
  if (brand === "linkedin") {
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" className={className} focusable="false">
        <rect x="2" y="2" width="20" height="20" rx="3.5" fill={BRAND_COLOR.linkedin} />
        <circle cx="7.4" cy="7.3" r="1.55" fill="#fff" />
        <rect x="6" y="9.7" width="2.8" height="8.3" rx="0.3" fill="#fff" />
        <path d="M10.7 9.7h2.65v1.15c.42-.72 1.4-1.38 2.85-1.38 2.62 0 3.3 1.6 3.3 3.95V18h-2.8v-4.05c0-1-.2-1.95-1.45-1.95-1.27 0-1.75.93-1.75 1.98V18h-2.8z" fill="#fff" />
      </svg>
    );
  }
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" className={className} focusable="false" fill="none">
      <defs>
        <linearGradient id={gradientId} x1="3" y1="21" x2="21" y2="3" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#FEDA75" />
          <stop offset="0.3" stopColor="#FA7E1E" />
          <stop offset="0.55" stopColor="#D62976" />
          <stop offset="0.8" stopColor="#962FBF" />
          <stop offset="1" stopColor="#4F5BD5" />
        </linearGradient>
      </defs>
      <rect x="3" y="3" width="18" height="18" rx="5.2" stroke={`url(#${gradientId})`} strokeWidth="2.2" />
      <circle cx="12" cy="12" r="4.1" stroke={`url(#${gradientId})`} strokeWidth="2.2" />
      <circle cx="17.3" cy="6.7" r="1.25" fill={`url(#${gradientId})`} />
    </svg>
  );
}
