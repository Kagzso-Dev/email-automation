import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { COUNTRIES, countryByIso, countryForDigits, NATIONAL_LENGTHS, type Country } from "../lib/countries";

/**
 * The one phone field used across the app: a searchable country-code picker
 * (India +91 by default) and a digits-only number box.
 *
 * - Emits E.164 ("+919876543210", "+971501234567"), or "" when empty — every
 *   API accepts that and stores the number in its own format (WhatsApp contacts
 *   as 919876543210, Indian email-contact numbers as 10 digits).
 * - Spaces, dashes and a leading 0 are dropped. Pasting a full number
 *   ("+971 50 123 4567", "00971…", or "919876543210" while India is selected)
 *   switches the country and splits the number.
 * - Editing: a stored value ("+9715…", "919876543210" or a 10-digit Indian
 *   number) pre-selects its country.
 */

export interface ParsedPhone {
  country: Country;
  national: string;
}

const MAX_TOTAL_DIGITS = 15;

/** Split any stored / pasted value into country + national digits. */
export function parsePhone(value: string | null | undefined, defaultIso = "IN"): ParsedPhone {
  const fallback = countryByIso(defaultIso);
  const raw = String(value ?? "").trim();
  if (!raw) return { country: fallback, national: "" };
  const intl = raw.startsWith("+") || raw.startsWith("00");
  let digits = raw.replace(/\D/g, "");
  if (raw.startsWith("00")) digits = digits.slice(2);
  // Without a "+": a 10-digit number is national (India by default); a longer one
  // is a stored international number such as 919876543210 (WhatsApp format).
  if (intl || digits.length > 10) {
    const c = countryForDigits(digits);
    if (c) return { country: c, national: digits.slice(c.dial.length).replace(/^0+/, "") };
  }
  return { country: fallback, national: digits.replace(/^0+/, "") };
}

export const toE164 = (country: Country, national: string) => (national ? `+${country.dial}${national}` : "");

/**
 * What the number box holds after the user types / pastes `raw` while `country`
 * is selected: a "+…" / "00…" number switches country; a leading 0 is dropped;
 * the selected country's code typed in front of a full number is removed.
 */
export function applyTyped(raw: string, country: Country): ParsedPhone {
  const t = raw.trim();
  let digits = t.replace(/\D/g, "");
  if (t.startsWith("+") || t.startsWith("00")) {
    if (t.startsWith("00")) digits = digits.slice(2);
    const c = countryForDigits(digits);
    if (c) return { country: c, national: digits.slice(c.dial.length).replace(/^0+/, "").slice(0, MAX_TOTAL_DIGITS - c.dial.length) };
  }
  digits = digits.replace(/^0+/, "");
  const max = Math.max(...(NATIONAL_LENGTHS[country.iso] ?? [MAX_TOTAL_DIGITS - country.dial.length]));
  if (digits.length > max && digits.startsWith(country.dial)) digits = digits.slice(country.dial.length);
  return { country, national: digits.slice(0, MAX_TOTAL_DIGITS - country.dial.length) };
}

/** Inline error for a value, or null when it's fine (empty is fine unless required). */
export function phoneError(value: string, required = false): string | null {
  if (!value.trim()) return required ? "Phone number is required" : null;
  const { country, national } = parsePhone(value);
  if (country.iso === "IN") {
    return /^[6-9]\d{9}$/.test(national) ? null : "Enter a 10-digit Indian mobile number starting with 6, 7, 8 or 9";
  }
  const lengths = NATIONAL_LENGTHS[country.iso];
  if (lengths && !lengths.includes(national.length)) {
    return `${country.name} numbers have ${lengths.join(" or ")} digits after +${country.dial}`;
  }
  if (national.length < 4 || country.dial.length + national.length > MAX_TOTAL_DIGITS) {
    return `Enter a valid ${country.name} number`;
  }
  return null;
}

/** True when the value is acceptable (empty only if not required). */
export function phoneInputOk(value: string, required = false): boolean {
  return phoneError(value, required) === null;
}

export function PhoneInput({
  value,
  onChange,
  defaultCountry = "IN",
  required = false,
  placeholder,
  disabled = false,
  id,
  className = "",
}: {
  value: string;
  onChange: (value: string) => void;
  defaultCountry?: string;
  required?: boolean;
  placeholder?: string;
  disabled?: boolean;
  id?: string;
  className?: string;
}) {
  const [{ country, national }, setParts] = useState<ParsedPhone>(() => parsePhone(value, defaultCountry));
  const [touched, setTouched] = useState(false);
  const emitted = toE164(country, national);

  // Follow outside changes (form reset, a different record opened) without fighting typing.
  useEffect(() => {
    if ((value ?? "") !== emitted) setParts(parsePhone(value, defaultCountry));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  function update(next: ParsedPhone) {
    setParts(next);
    onChange(toE164(next.country, next.national));
  }

  const onNumber = (raw: string) => update(applyTyped(raw, country));

  const error = touched || national ? phoneError(emitted, required && touched) : null;
  const errorId = useId();

  return (
    <div className={className}>
      <div className="flex gap-2">
        <CountryPicker
          country={country}
          disabled={disabled}
          onPick={(c) => update({ country: c, national })}
        />
        <input
          id={id}
          className="input min-w-0 flex-1"
          type="tel"
          inputMode="tel"
          autoComplete="tel-national"
          placeholder={placeholder ?? (country.iso === "IN" ? "98765 43210" : "Phone number")}
          value={national}
          required={required}
          disabled={disabled}
          aria-invalid={!!error}
          aria-describedby={error ? errorId : undefined}
          onChange={(e) => onNumber(e.target.value)}
          onBlur={() => setTouched(true)}
        />
      </div>
      {error && (
        <p id={errorId} className="mt-1 text-xs text-crit">
          {error}
        </p>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ searchable country list */

function CountryPicker({ country, disabled, onPick }: { country: Country; disabled: boolean; onPick: (c: Country) => void }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [pos, setPos] = useState<{ top: number; left: number; width: number } | null>(null);
  const button = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const listId = useId();

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase().replace(/^\+/, "");
    if (!q) return COUNTRIES;
    return COUNTRIES.filter((c) => c.name.toLowerCase().includes(q) || c.iso.toLowerCase() === q || c.dial.startsWith(q));
  }, [query]);

  // The list floats above the page (portal), so a scrolling modal can't clip it.
  useLayoutEffect(() => {
    if (!open || !button.current) return;
    const r = button.current.getBoundingClientRect();
    const width = Math.min(288, window.innerWidth - 16);
    const left = Math.max(8, Math.min(r.left, window.innerWidth - width - 8));
    const below = window.innerHeight - r.bottom;
    setPos({ top: below > 300 ? r.bottom + 4 : Math.max(8, r.top - 304), left, width });
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const close = (e: Event) => {
      const t = e.target as Node;
      if (panel.current?.contains(t) || button.current?.contains(t)) return;
      setOpen(false);
    };
    const reposition = (e: Event) => {
      if (!panel.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    window.addEventListener("resize", reposition);
    window.addEventListener("scroll", reposition, true);
    return () => {
      document.removeEventListener("mousedown", close);
      window.removeEventListener("resize", reposition);
      window.removeEventListener("scroll", reposition, true);
    };
  }, [open]);

  function pick(c: Country) {
    onPick(c);
    setOpen(false);
    setQuery("");
    button.current?.focus();
  }

  return (
    <>
      <button
        ref={button}
        type="button"
        className="input flex w-auto shrink-0 items-center gap-1.5 whitespace-nowrap pr-2 disabled:opacity-60"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={`Country code: ${country.name} +${country.dial}`}
        disabled={disabled}
        onClick={() => {
          setActive(0);
          setOpen((o) => !o);
        }}
      >
        <span className="text-xs font-semibold text-slate-550">{country.iso}</span>
        <span className="font-mono">+{country.dial}</span>
        <svg viewBox="0 0 24 24" width={12} height={12} fill="none" stroke="currentColor" strokeWidth={2} aria-hidden="true">
          <path d="M6 9l6 6 6-6" />
        </svg>
      </button>
      {open &&
        pos &&
        createPortal(
          <div
            ref={panel}
            className="fixed z-[60] rounded-xl border border-line/70 bg-surface p-2 shadow-pop animate-dialog-in"
            style={{ top: pos.top, left: pos.left, width: pos.width }}
          >
            <input
              autoFocus
              className="input mb-2 py-1.5"
              placeholder="Search country or code"
              value={query}
              aria-controls={listId}
              onChange={(e) => {
                setQuery(e.target.value);
                setActive(0);
              }}
              onKeyDown={(e) => {
                if (e.key === "ArrowDown") {
                  e.preventDefault();
                  setActive((a) => Math.min(a + 1, matches.length - 1));
                } else if (e.key === "ArrowUp") {
                  e.preventDefault();
                  setActive((a) => Math.max(a - 1, 0));
                } else if (e.key === "Enter") {
                  e.preventDefault();
                  if (matches[active]) pick(matches[active]!);
                } else if (e.key === "Escape") {
                  setOpen(false);
                  button.current?.focus();
                }
              }}
            />
            <ul id={listId} role="listbox" className="max-h-60 overflow-y-auto text-sm">
              {matches.length === 0 && <li className="px-2 py-1.5 text-slate-550">No match</li>}
              {matches.map((c, i) => (
                <li
                  key={c.iso}
                  role="option"
                  aria-selected={c.iso === country.iso}
                  className={`flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 transition-colors duration-150 ${
                    i === active ? "bg-tint text-ink" : ""
                  } ${c.iso === country.iso ? "font-medium" : ""}`}
                  onMouseEnter={() => setActive(i)}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => pick(c)}
                >
                  <span className="w-6 text-xs font-semibold text-slate-550">{c.iso}</span>
                  <span className="min-w-0 flex-1 truncate">{c.name}</span>
                  <span className="font-mono text-xs text-slate-550">+{c.dial}</span>
                </li>
              ))}
            </ul>
          </div>,
          document.body,
        )}
    </>
  );
}
