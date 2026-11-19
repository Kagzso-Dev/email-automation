// Import filter step (ENABLE_IMPORT_FILTER_STEP): the Data Quality checks on rows that are NOT saved.
//
// Reuses Data Quality's own rules (checkRows, phoneType, tierFor, overallScore) and its read-only
// lookups (do not call, not interested, wrong person, already saved). Writes nothing: no staging job,
// no queue. The AI score comes afterwards, a few rows at a time (domain/importFilterAi.ts), and is not saved.
// The rows stay in the browser until "Import N selected" sends them to the page's own importer.

import { normalizePhoneE164, sanitizeCountryCode } from "@dispatch/shared";
import {
  checkRows,
  detectDataQualityColumns,
  loadLookups,
  overallScore,
  type DqExcludedReason,
  type DqMapping,
  type DqStatus,
} from "./dataQuality.js";
import { phoneType, tierFor, type PhoneType, type Tier } from "./dataQualityExport.js";
import { findUsed, type UsedInfo } from "./importFilterUsed.js";
import { rowsToWhatsAppContacts } from "./whatsappImport.js";

/** One row as the page's importer reads it. */
export interface DraftRowInput {
  name?: string | null;
  phone?: string | null;
  business?: string | null;
  email?: string | null;
}

/** The Data Quality result for one draft row (same fields and meaning as on the Data Quality page). */
export interface DraftCheck {
  rowIndex: number;
  name: string | null;
  phoneRaw: string | null;
  phone: string | null;
  businessName: string | null;
  email: string | null;
  status: DqStatus;
  excludedReason: DqExcludedReason | null;
  issues: string[];
  flags: string[];
  ruleScore: number | null;
  /** The rules score (no AI score in this step). */
  score: number | null;
  phoneType: PhoneType;
  tier: Tier | null;
}

const MAPPING: DqMapping = { name: "name", phone: "phone", business: "business", email: "email" };

/** Data Quality's standard checks on rows held in memory. Reads existing tables only; writes nothing. */
export async function checkDraftRows(rows: DraftRowInput[], defaultCountryCode: string): Promise<DraftCheck[]> {
  const sheet = rows.map((r) => ({ name: r.name ?? "", phone: r.phone ?? "", business: r.business ?? "", email: r.email ?? "" }));
  const phones = [...new Set(sheet.map((r) => normalizePhoneE164(r.phone, defaultCountryCode)).filter((p): p is string => !!p))];
  const emails = [...new Set(sheet.map((r) => r.email.trim().toLowerCase()).filter((e) => e.includes("@")))];
  const lookups = await loadLookups(phones, emails, defaultCountryCode);
  const { records } = checkRows(sheet, MAPPING, lookups, defaultCountryCode);
  return records.map((r) => {
    const score = overallScore(r.ruleScore, null);
    return {
      rowIndex: r.rowIndex,
      name: r.name,
      phoneRaw: r.phoneRaw,
      phone: r.phone,
      businessName: r.businessName,
      email: r.email,
      status: r.status,
      excludedReason: r.excludedReason,
      issues: r.issues,
      flags: r.flags,
      ruleScore: r.ruleScore,
      score,
      phoneType: phoneType(r.phone, r.phoneRaw),
      tier: tierFor(score),
    };
  });
}

/* ------------------------------------------------------------------ WhatsApp Contacts */

/** A valid Indian mobile: only used to ask the WhatsApp importer which column it reads as the phone. */
const PROBE_PHONE = "+919876543210";

/** The header the WhatsApp importer reads as the phone number (null = none), found with the importer itself. */
export function whatsappPhoneHeader(headers: string[]): string | null {
  return headers.find((h) => rowsToWhatsAppContacts([{ [h]: PROBE_PHONE }]).length === 1) ?? null;
}

export type WhatsAppDraftCheck = DraftCheck & {
  /** The WhatsApp importer would take this row (it has a number WhatsApp can use). */
  importable: boolean;
  importProblem: string | null;
  /** The number is already a WhatsApp contact: the importer updates that contact (its usual rule). */
  alreadySaved: boolean;
  /** "Exclude already used data": which checks match. */
  used: UsedInfo;
};

export const WHATSAPP_NO_NUMBER = "No usable WhatsApp number: the importer skips this row";

/**
 * Each row as the Data Quality page reads it (its own column names: name, phone, business, email), so the check,
 * the score, the tier and the AI score are the ones Data Quality shows for the same file; whether the row can be
 * imported comes from the WhatsApp importer itself (its own column names and phone rule). A column Data Quality
 * does not find falls back to the importer's reading. The email column is also used for "already sent" (email
 * logs, Send Queue). Read-only.
 */
export async function checkWhatsAppDraft(
  headers: string[],
  rows: Record<string, string>[],
  defaultCountryCode: string | undefined,
  callCountryCode = "91",
): Promise<WhatsAppDraftCheck[]> {
  // The WhatsApp importer's own rule for the country code (an unusable setting counts as 91).
  const cc = sanitizeCountryCode(defaultCountryCode);
  const phoneHeader = whatsappPhoneHeader(headers);
  const dq = detectDataQualityColumns(headers);
  const emailHeader = dq.email;
  const cell = (row: Record<string, string>, h: string) => (row[h] ?? "").trim() || null;
  const inputs = rows.map((row) => {
    const [contact] = rowsToWhatsAppContacts([row], defaultCountryCode); // what would be imported
    // The names and business even when the number is unusable (the importer reads them the same way).
    const [fields] = rowsToWhatsAppContacts([{ ...row, [phoneHeader ?? "phone"]: PROBE_PHONE }]);
    const raw = phoneHeader ? (row[phoneHeader] ?? "").trim() : "";
    return {
      input: {
        name: dq.name ? cell(row, dq.name) : [fields?.firstName, fields?.lastName].filter(Boolean).join(" ") || null,
        phone: dq.phone ? cell(row, dq.phone) : contact ? `+${contact.phone}` : raw || null,
        business: dq.business ? cell(row, dq.business) : (fields?.businessName ?? null),
        email: emailHeader ? cell(row, emailHeader) : null,
      },
      importable: !!contact,
    };
  });
  // The Data Quality page's country code for its checks (an unusable setting counts as 91).
  const checks = await checkDraftRows(
    inputs.map((i) => i.input),
    sanitizeCountryCode(callCountryCode),
  );
  const used = await findUsed(
    "whatsapp",
    checks.map((c, i) => ({ phone: c.phone, email: emailHeader ? (rows[i]![emailHeader] ?? null) : null, excludedReason: c.excludedReason })),
    { whatsappCountryCode: cc, callCountryCode },
  );
  return checks.map((c, i) => ({
    ...c,
    importable: inputs[i]!.importable,
    importProblem: inputs[i]!.importable ? null : WHATSAPP_NO_NUMBER,
    alreadySaved: inputs[i]!.importable && !!used[i]!.inContacts,
    used: used[i]!,
  }));
}

/* ------------------------------------------------------------------ Voicecall Contact */

export type VoicecallDraftCheck = DraftCheck & { used: UsedInfo };

/** The Data Quality checks and the "already used" checks; "already in contacts" = this language's list. Read-only. */
export async function checkVoicecallDraft(
  rows: DraftRowInput[],
  language: string,
  callCountryCode: string,
  whatsappCountryCode: string | undefined,
): Promise<VoicecallDraftCheck[]> {
  const checks = await checkDraftRows(rows, callCountryCode);
  const used = await findUsed(
    "voicecall",
    checks.map((c) => ({ phone: c.phone, email: c.email, excludedReason: c.excludedReason })),
    { language, whatsappCountryCode: sanitizeCountryCode(whatsappCountryCode), callCountryCode },
  );
  return checks.map((c, i) => ({ ...c, used: used[i]! }));
}
