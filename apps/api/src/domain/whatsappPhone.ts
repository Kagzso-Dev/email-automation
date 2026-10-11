// WhatsApp phone normalisation — a thin wrapper over the shared phone rules
// (packages/shared/src/phone.ts), so forms, imports and sends agree.

import { toWhatsAppDigits } from "@dispatch/shared";

/**
 * Stored WhatsApp numbers: digits with country code, no '+'. Indian numbers must
 * be mobiles (91 + 10 digits starting 6-9); other countries a valid E.164 length.
 */
export function phoneDigitsValid(digits: string): boolean {
  return /^\d+$/.test(digits) && toWhatsAppDigits(`+${digits}`) === digits;
}

/**
 * Normalise raw phone input to digits only (country code included, no '+').
 *
 * - "+91 98765 43210" → "919876543210"
 * - "+971 50 123 4567" → "971501234567"
 * - "9876543210" (no country code) → `defaultCountryCode` is added (91 when the
 *   setting is missing or not a real 1-3 digit code) → "919876543210"
 *
 * Returns null for numbers WhatsApp can't deliver to.
 */
export function normalizeWhatsAppPhone(raw: string, defaultCountryCode?: string): string | null {
  return toWhatsAppDigits(raw, defaultCountryCode);
}
