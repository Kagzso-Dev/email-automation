// WhatsApp phone normalisation. Standalone — no import from domain/contactImport.

/**
 * India-only WhatsApp "to" (recipient) number: 91 followed by a 10-digit
 * mobile number starting with 6, 7, 8, or 9. Equivalent to /^\+91[6-9]\d{9}$/
 * once the leading '+' is stripped.
 */
export function phoneDigitsValid(digits: string): boolean {
  return /^91[6-9]\d{9}$/.test(digits);
}

/**
 * Normalise raw phone input to digits only (country code included, no '+').
 *
 * - "+91 98765 43210" → "919876543210"
 * - "9876543210"      → "9876543210" then, if `defaultCountryCode` is "91",
 *                        a 10-digit local gets it prepended → "919876543210"
 *
 * Returns null unless the result is a valid Indian WhatsApp number (see
 * `phoneDigitsValid`).
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
