import { z } from "zod";

/* ------------------------------------------------------------------ branding */
// Display-only app name an admin can change in Settings → Branding: shown in the
// sidebar header, the mobile top bar and the browser tab title. Emails, WhatsApp,
// call scripts, routes and code never read it. Nothing saved (or the table
// missing) means exactly today's text.

export const BRANDING_DEFAULTS = {
  appName: "Dispatch",
} as const;

export type BrandingKey = keyof typeof BRANDING_DEFAULTS;
export type BrandingLabels = Record<BrandingKey, string>;
export const BRANDING_KEYS = Object.keys(BRANDING_DEFAULTS) as BrandingKey[];

export const BRANDING_APP_NAME_MAX = 24;
export const brandingMaxLength = (_key: BrandingKey) => BRANDING_APP_NAME_MAX;

/** Letters (any language), numbers, spaces and . , - _ & ' ( ) ! ? — nothing that can form HTML or script. */
const ALLOWED = /^[\p{L}\p{M}\p{N} .,\-_&'()!?]+$/u;
export const BRANDING_ALLOWED_HINT = "Letters, numbers, spaces and . , - _ & ' ( ) ! ? only";

/**
 * Clean what an admin typed: drop HTML tags and any character outside the
 * allowed set, collapse runs of spaces. The server still validates — this only
 * keeps the form from holding a value it would reject.
 */
export function sanitizeBrandingValue(raw: string): string {
  return raw
    .replace(/<[^>]*>?/g, "")
    .replace(/[^\p{L}\p{M}\p{N} .,\-_&'()!?]/gu, "")
    .replace(/\s+/g, " ");
}

const labelValue = (max: number) =>
  z
    .string()
    .trim()
    .min(1, "Required")
    .max(max, `At most ${max} characters`)
    .regex(ALLOWED, BRANDING_ALLOWED_HINT);

/** PUT body: the known keys only. Unknown keys are rejected. */
export const brandingInput = z.object({
  labels: z.object({ appName: labelValue(BRANDING_APP_NAME_MAX) }).strict(),
});
export type BrandingInput = z.infer<typeof brandingInput>;

/** DELETE query: one key, or none to reset everything. */
export const brandingResetQuery = z.object({ key: z.enum(BRANDING_KEYS as [BrandingKey, ...BrandingKey[]]).optional() }).strict();

/** Validate one value for a key; returns the trimmed value or an error message. */
export function checkBrandingValue(key: BrandingKey, value: string): { ok: true; value: string } | { ok: false; error: string } {
  const r = labelValue(brandingMaxLength(key)).safeParse(value);
  return r.success ? { ok: true, value: r.data } : { ok: false, error: r.error.issues[0]?.message ?? "Invalid" };
}

/**
 * Defaults overlaid with whatever stored values are valid. Anything missing,
 * unknown or malformed falls back to the default text — never throws.
 */
export function resolveBranding(stored: unknown): BrandingLabels {
  const out: BrandingLabels = { ...BRANDING_DEFAULTS };
  if (!stored || typeof stored !== "object" || Array.isArray(stored)) return out;
  for (const key of BRANDING_KEYS) {
    const v = (stored as Record<string, unknown>)[key];
    if (typeof v !== "string") continue;
    const r = checkBrandingValue(key, v);
    if (r.ok) out[key] = r.value;
  }
  return out;
}
