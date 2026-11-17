// Import filter step (ENABLE_IMPORT_FILTER_STEP): the Data Quality checks on rows that are NOT saved.
//
// Reuses Data Quality's own rules (checkRows, phoneType, tierFor, overallScore) and its read-only
// lookups (do not call, not interested, wrong person, already saved). Writes nothing: no staging job,
// no queue, no AI service call (the AI score needs a saved job, so only the rules score is used here).
// The rows stay in the browser until "Import N selected" sends them to the page's own importer.

import { normalizePhoneE164, sanitizeCountryCode } from "@dispatch/shared";
import { prisma } from "../prisma.js";
import { checkRows, loadLookups, overallScore, type DqExcludedReason, type DqMapping, type DqStatus } from "./dataQuality.js";
import { phoneType, tierFor, type PhoneType, type Tier } from "./dataQualityExport.js";
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
};

export const WHATSAPP_NO_NUMBER = "No usable WhatsApp number: the importer skips this row";

/**
 * Each row exactly as the WhatsApp importer reads it (its own column names and phone rule), then the
 * Data Quality checks. Email is left out: the WhatsApp importer does not save it. Read-only.
 */
export async function checkWhatsAppDraft(
  headers: string[],
  rows: Record<string, string>[],
  defaultCountryCode: string | undefined,
): Promise<WhatsAppDraftCheck[]> {
  const phoneHeader = whatsappPhoneHeader(headers);
  const inputs = rows.map((row) => {
    const [contact] = rowsToWhatsAppContacts([row], defaultCountryCode); // what would be imported
    // The names and business even when the number is unusable (the importer reads them the same way).
    const [fields] = rowsToWhatsAppContacts([{ ...row, [phoneHeader ?? "phone"]: PROBE_PHONE }]);
    const raw = phoneHeader ? (row[phoneHeader] ?? "").trim() : "";
    return {
      input: {
        name: [fields?.firstName, fields?.lastName].filter(Boolean).join(" ") || null,
        phone: contact ? `+${contact.phone}` : raw || null,
        business: fields?.businessName ?? null,
        email: null,
      },
      importable: !!contact,
      digits: contact?.phone ?? null, // stored form: digits with country code, no '+'
    };
  });
  const digits = [...new Set(inputs.flatMap((i) => (i.digits ? [i.digits] : [])))];
  const [checks, saved] = await Promise.all([
    // The WhatsApp importer's own rule for the country code (an unusable setting counts as 91).
    checkDraftRows(
      inputs.map((i) => i.input),
      sanitizeCountryCode(defaultCountryCode),
    ),
    digits.length
      ? prisma.whatsAppContact.findMany({ where: { phone: { in: digits } }, select: { phone: true } }).then((r) => new Set(r.map((c) => c.phone)))
      : Promise.resolve(new Set<string>()),
  ]);
  return checks.map((c, i) => ({
    ...c,
    importable: inputs[i]!.importable,
    importProblem: inputs[i]!.importable ? null : WHATSAPP_NO_NUMBER,
    alreadySaved: !!inputs[i]!.digits && saved.has(inputs[i]!.digits!),
  }));
}
