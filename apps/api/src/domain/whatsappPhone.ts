// WhatsApp phone normalisation. Standalone — no import from domain/contactImport.

/** 8–15 digits, per E.164. */
export function phoneDigitsValid(digits: string): boolean {
  return /^\d{8,15}$/.test(digits);
}

/**
 * Normalise raw phone input to digits only (country code included, no '+').
 *
 * - "+91 98765 43210" → "919876543210"
 * - "(415) 555-2671"  → "4155552671" then, if `defaultCountryCode` is "1",
 *                        a 10-digit local gets it prepended → "14155552671"
 *
 * Returns null when the result isn't a plausible E.164 number.
 */
export function normalizeWhatsAppPhone(
  raw: string,
  defaultCountryCode?: string,
): string | null {
  const hadPlus = raw.trim().startsWith("+");
  let digits = raw.replace(/[^\d]/g, "");
  if (!digits) return null;

  const cc = (defaultCountryCode ?? "").replace(/\D/g, "");
  // Only add a country code to a bare local number: no leading '+', exactly 10
  // digits, and not already starting with the country code.
  if (!hadPlus && cc && digits.length === 10) {
    digits = cc + digits;
  }

  return phoneDigitsValid(digits) ? digits : null;
}
