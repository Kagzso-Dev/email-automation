// Email (SMTP) account in Settings — deliberately separate from src/env.ts.
//
// Admins can set the SMTP server, login, password and From address in Settings → Email (SMTP) instead of
// editing .env and restarting. What they save is a per-field override on top of SMTP_* / EMAIL_FROM in .env;
// nothing changes until an admin saves something.
//
// ENABLE_SMTP_SETTINGS is only a kill switch:
//
//   unset, empty or true         the Email (SMTP) card is in Settings for admins (default)
//   ENABLE_SMTP_SETTINGS=false   hide the card and send exactly as before, from .env only: saved values are never
//                                read, and every /api/settings/smtp endpoint answers 404. Restart the API and the
//                                worker to apply.
//
// The saved SMTP password is encrypted (AES-256-GCM) with SETTINGS_ENCRYPTION_KEY, or, when that is unset, a key
// derived from JWT_ACCESS_SECRET. Changing whichever one is in use makes the saved password unreadable: sending
// falls back to SMTP_PASS from .env and Settings asks for the password again.

import { fileURLToPath } from "node:url";
import { config as loadEnv } from "dotenv";

loadEnv();
// src/config/smtpSettings.ts → repo root is four levels up.
loadEnv({ path: fileURLToPath(new URL("../../../../.env", import.meta.url)) });

const KILL_VALUES = ["false", "0", "no", "off"];

/** False only when ENABLE_SMTP_SETTINGS says off. Read at call time, so tests see the current value. */
export function isSmtpSettingsEnabled(): boolean {
  return !KILL_VALUES.includes((process.env.ENABLE_SMTP_SETTINGS ?? "").trim().toLowerCase());
}

/** The secret the saved SMTP password is encrypted with. Read at call time. */
export function settingsEncryptionSecret(): string {
  const own = (process.env.SETTINGS_ENCRYPTION_KEY ?? "").trim();
  return own || (process.env.JWT_ACCESS_SECRET ?? "");
}
