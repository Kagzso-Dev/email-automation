import { normalizePhoneE164 } from "./aiCalls.js";

/* ------------------------------------------------------------------ phone numbers (shared) */
// One set of phone rules for every channel. Input may be "+971 50 123 4567",
// "00971501234567", "098765 43210", "919876543210" or "9876543210"; numbers
// without an international prefix are taken as +91 (India) unless another
// default country code is given. Each channel then stores the number in the
// format it has always used, so existing rows stay valid:
//   - WhatsApp contacts / sends: digits with country code, no "+" (919876543210)
//   - email contacts: Indian numbers as the 10-digit national number (as
//     before); any other country as E.164 with "+" (+971501234567)
//   - AI call customers: E.164 (+919876543210)

/**
 * A usable default country calling code (1-3 digits), else "91". Guards against
 * a misconfigured setting such as a full phone number in the country-code slot.
 */
export function sanitizeCountryCode(cc: string | null | undefined): string {
  const d = String(cc ?? "").replace(/\D/g, "");
  return /^[1-9]\d{0,2}$/.test(d) ? d : "91";
}

/** Indian mobile numbers (the only Indian numbers on WhatsApp): 91 + 10 digits starting 6-9. */
const INDIA_MOBILE = /^91[6-9]\d{9}$/;

/**
 * WhatsApp "to" format: digits with country code, no "+". Indian numbers must
 * be mobiles (start 6-9); other countries need a plausible E.164 length.
 * Returns null when the number isn't usable.
 */
export function toWhatsAppDigits(raw: unknown, defaultCountryCode?: string | null): string | null {
  const e164 = normalizePhoneE164(raw, sanitizeCountryCode(defaultCountryCode));
  if (!e164) return null;
  const digits = e164.slice(1);
  if (digits.startsWith("91") && !INDIA_MOBILE.test(digits)) return null;
  return digits;
}

export type ContactPhoneResult = { ok: true; phone: string } | { ok: false };

/**
 * Email-contact storage format. Indian numbers keep the historical 10-digit
 * form; other countries are stored as E.164 ("+…"). Accepts the old inputs
 * unchanged (any 10 digits), plus 0XXXXXXXXXX / 91XXXXXXXXXX / +91… and any
 * "+<country>…" / "00<country>…" number.
 */
export function toContactPhone(raw: string): ContactPhoneResult {
  const s = String(raw ?? "").trim();
  if (!s) return { ok: false };
  const international = s.startsWith("+") || /^\s*00/.test(s);
  if (international) {
    const e164 = normalizePhoneE164(s, "91");
    if (!e164) return { ok: false };
    return { ok: true, phone: /^\+91\d{10}$/.test(e164) ? e164.slice(3) : e164 };
  }
  const digits = s.replace(/\D/g, "");
  if (digits.length === 10) return { ok: true, phone: digits };
  if (digits.length === 11 && digits.startsWith("0")) return { ok: true, phone: digits.slice(1) };
  if (digits.length === 12 && digits.startsWith("91")) return { ok: true, phone: digits.slice(2) };
  return { ok: false };
}
