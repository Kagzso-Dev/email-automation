// Settings → Email (SMTP): the SMTP account email is sent through, editable by admins in the UI.
//
// Saved in the generic Setting table under its own key as a per-field override on top of .env (SMTP_HOST,
// SMTP_PORT, SMTP_SECURE, SMTP_USER, SMTP_PASS, EMAIL_FROM): a saved field wins, a field never saved (or cleared)
// falls back to .env. The password is stored encrypted (domain/secretBox.ts) and is never returned to the
// browser. ENABLE_SMTP_SETTINGS=false (config/smtpSettings.ts) ignores everything saved here.
//
// Every email send reads the current values through getEmailTransport(), cached for a few seconds per process,
// so a change made in Settings reaches the API and the separate worker process without a restart.

import { env } from "../env.js";
import { logger } from "../logger.js";
import { isSmtpSettingsEnabled, settingsEncryptionSecret } from "../config/smtpSettings.js";
import { getSetting, setSetting } from "./settings.js";
import { openSecret, sealSecret } from "./secretBox.js";

export const SMTP_SETTINGS_KEY = "smtpCredentials";
const PASSWORD_PURPOSE = "smtp-password";
/** How long a process reuses what it last read. A save in this process clears it at once. */
export const SMTP_SETTINGS_CACHE_MS = 10_000;

interface StoredSmtpSettings {
  host?: string;
  port?: number;
  secure?: boolean;
  user?: string;
  /** sealSecret() output — never the plain password. */
  passwordSealed?: string;
  from?: string;
  updatedBy?: string;
  updatedAt?: string;
}

export type SmtpField = "host" | "port" | "secure" | "user" | "password" | "from";

/** What one send uses. */
export interface EmailTransport {
  provider: "smtp" | "mock";
  host?: string;
  port: number;
  secure: boolean;
  user?: string;
  pass?: string;
  /** Set only when a From address is saved in Settings: it replaces the From the caller passed (.env EMAIL_FROM). */
  fromOverride?: string;
}

/** Safe for the browser: no password, only whether one is set. */
export interface SmtpSettingsView {
  /** How email is sent right now. */
  provider: "smtp" | "mock";
  /** EMAIL_PROVIDER in .env. A host saved in Settings switches "mock" to SMTP sending. */
  envProvider: "smtp" | "mock";
  host: string | null;
  port: number;
  secure: boolean;
  user: string | null;
  from: string;
  hasPassword: boolean;
  passwordSource: "database" | "environment" | null;
  /** A password is saved but can't be decrypted (the encryption key changed) — sending uses .env SMTP_PASS. */
  passwordUnreadable: boolean;
  /** The fields saved in Settings; the rest come from .env. */
  saved: SmtpField[];
  source: "database" | "environment";
  updatedBy: string | null;
  updatedAt: string | null;
}

export interface SmtpSettingsInput {
  host?: string;
  port?: number | null;
  secure?: boolean | null;
  user?: string;
  password?: string;
  from?: string;
}

const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);

/** Whatever is in the row, reduced to well-typed fields (a hand-edited or odd row never breaks sending). */
function normalize(raw: unknown): StoredSmtpSettings {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const r = raw as Record<string, unknown>;
  const port = typeof r.port === "number" && Number.isInteger(r.port) && r.port >= 1 && r.port <= 65535 ? r.port : undefined;
  return {
    host: str(r.host),
    port,
    secure: typeof r.secure === "boolean" ? r.secure : undefined,
    user: str(r.user),
    passwordSealed: str(r.passwordSealed),
    from: str(r.from),
    updatedBy: str(r.updatedBy),
    updatedAt: str(r.updatedAt),
  };
}

function compact(s: StoredSmtpSettings): Record<string, string | number | boolean> {
  return Object.fromEntries(Object.entries(s).filter(([, v]) => v !== undefined)) as Record<string, string | number | boolean>;
}

let cache: { at: number; stored: StoredSmtpSettings } | null = null;

async function readStored(fresh = false): Promise<StoredSmtpSettings> {
  if (!fresh && cache && Date.now() - cache.at < SMTP_SETTINGS_CACHE_MS) return cache.stored;
  const stored = normalize(await getSetting<unknown>(SMTP_SETTINGS_KEY, null));
  cache = { at: Date.now(), stored };
  return stored;
}

/** Drop this process's cached copy (after a save, and in tests). */
export function forgetCachedSmtpSettings(): void {
  cache = null;
}

let warnedUnreadable: string | null = null;

function resolve(stored: StoredSmtpSettings) {
  let pass = env.SMTP_PASS || undefined;
  let passwordSource: SmtpSettingsView["passwordSource"] = pass ? "environment" : null;
  let passwordUnreadable = false;
  if (stored.passwordSealed) {
    const opened = openSecret(stored.passwordSealed, settingsEncryptionSecret(), PASSWORD_PURPOSE);
    if (opened === null) {
      passwordUnreadable = true;
      if (warnedUnreadable !== stored.passwordSealed) {
        warnedUnreadable = stored.passwordSealed;
        logger.warn("SMTP password saved in Settings can't be decrypted (encryption key changed?) — using SMTP_PASS from .env");
      }
    } else {
      pass = opened;
      passwordSource = "database";
    }
  }
  const host = stored.host ?? env.SMTP_HOST ?? undefined;
  const transport: EmailTransport = {
    provider: env.EMAIL_PROVIDER === "smtp" || stored.host ? "smtp" : "mock",
    host: host || undefined,
    port: stored.port ?? env.SMTP_PORT,
    secure: stored.secure ?? env.SMTP_SECURE,
    user: stored.user ?? (env.SMTP_USER || undefined),
    pass,
    fromOverride: stored.from,
  };
  return { transport, passwordSource, passwordUnreadable };
}

/** The settings the next email send uses: Settings first, .env for anything not saved there. */
export async function getEmailTransport(): Promise<EmailTransport> {
  return resolve(isSmtpSettingsEnabled() ? await readStored() : {}).transport;
}

export async function getSmtpSettingsView(): Promise<SmtpSettingsView> {
  const stored = await readStored(true);
  const { transport, passwordSource, passwordUnreadable } = resolve(stored);
  const saved: SmtpField[] = [];
  if (stored.host) saved.push("host");
  if (stored.port !== undefined) saved.push("port");
  if (stored.secure !== undefined) saved.push("secure");
  if (stored.user) saved.push("user");
  if (stored.passwordSealed) saved.push("password");
  if (stored.from) saved.push("from");
  return {
    provider: transport.provider,
    envProvider: env.EMAIL_PROVIDER,
    host: transport.host ?? null,
    port: transport.port,
    secure: transport.secure,
    user: transport.user ?? null,
    from: transport.fromOverride ?? env.EMAIL_FROM,
    hasPassword: Boolean(transport.pass),
    passwordSource,
    passwordUnreadable,
    saved,
    source: saved.length > 0 ? "database" : "environment",
    updatedBy: stored.updatedBy ?? null,
    updatedAt: stored.updatedAt ?? null,
  };
}

/**
 * Save what an admin entered. A field left out is untouched; "" (or null for port / encryption) clears that
 * field so it falls back to .env again. The password is encrypted before it is stored.
 */
export async function setSmtpSettings(input: SmtpSettingsInput, actorEmail: string): Promise<SmtpSettingsView> {
  const next: StoredSmtpSettings = { ...(await readStored(true)) };
  if (input.host !== undefined) next.host = str(input.host);
  if (input.port !== undefined) next.port = input.port ?? undefined;
  if (input.secure !== undefined) next.secure = input.secure ?? undefined;
  if (input.user !== undefined) next.user = str(input.user);
  if (input.from !== undefined) next.from = str(input.from);
  if (input.password !== undefined) {
    next.passwordSealed = input.password
      ? sealSecret(input.password, settingsEncryptionSecret(), PASSWORD_PURPOSE)
      : undefined;
  }
  next.updatedBy = actorEmail;
  next.updatedAt = new Date().toISOString();
  await setSetting(SMTP_SETTINGS_KEY, compact(next));
  forgetCachedSmtpSettings();
  return getSmtpSettingsView();
}

/** "Reset to .env values": removes every saved field (who reset it, and when, is kept). */
export async function clearSmtpSettings(actorEmail: string): Promise<SmtpSettingsView> {
  await setSetting(SMTP_SETTINGS_KEY, { updatedBy: actorEmail, updatedAt: new Date().toISOString() });
  forgetCachedSmtpSettings();
  return getSmtpSettingsView();
}
