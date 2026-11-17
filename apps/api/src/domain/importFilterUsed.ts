// Import filter step: "Exclude already used data". For each row, whether its number / email is
//
//   contacts  already in this channel's contacts: WhatsApp Contacts, or THIS language's Voicecall list (the
//             importers' own "already saved" rule: activePhone + language)
//   sent      already sent to: WhatsApp sends, email logs, Send Queue email batches (loadHistory from
//             historyFilter.ts, the Send Queue "Filter new data" logic, called as is: sent / done / still
//             sending = used; a failed-only send is not, so it can be retried)
//   called    already called (call logs, same loadHistory) or on the do-not-call / not interested / wrong person
//             lists (the Data Quality lookups, already on the row as its excludedReason)
//
// The only new reads are the dates shown in the reason ("Already sent 12 Nov 2026"). Read-only.

import { AiCallStatus, EmailStatus, ManualBatchItemStatus, WhatsAppSendStatus } from "@prisma/client";
import { prisma } from "../prisma.js";
import { historyKey, historyResult, loadHistory, type HistorySource } from "./historyFilter.js";

export type UsedOption = "contacts" | "sent" | "called";
export const USED_OPTIONS: readonly UsedOption[] = ["contacts", "sent", "called"];

export type CalledReason = "called" | "do_not_call" | "not_interested" | "wrong_person";

export interface UsedInfo {
  /** Already in this channel's contacts: when it was added (null when unknown). */
  inContacts: { at: string | null } | null;
  /** Already sent to: the latest send (null when unknown) and how. */
  sent: { at: string | null; via: ("whatsapp" | "email")[] } | null;
  /** Already called, or on the do-not-call / not interested / wrong person lists. */
  called: { at: string | null; reason: CalledReason } | null;
}

export interface UsedRowInput {
  /** E.164, as Data Quality normalised it (null = no usable number). */
  phone: string | null;
  email: string | null;
  /** Data Quality's EXCLUDED reason for the row, if any. */
  excludedReason: "do_not_call" | "not_interested" | "wrong_person" | null;
}

export interface UsedOptions {
  /** voicecall: this page's list. */
  language?: string;
  whatsappCountryCode: string;
  callCountryCode: string;
}

/** The ledger statuses Send Queue counts as "already used" (sent / done / still sending), from its own table. */
const usedStatuses = <S extends string>(source: HistorySource, all: S[]): S[] =>
  all.filter((s) => {
    const r = historyResult(source, s);
    return r === "sent" || r === "done" || r === "still sending";
  });
const WA_USED = usedStatuses("whatsapp", Object.values(WhatsAppSendStatus));
const CALL_USED = usedStatuses("call", Object.values(AiCallStatus));
const EMAIL_LOG_USED = usedStatuses("email-log", Object.values(EmailStatus));
const BATCH_USED = usedStatuses("email-batch", Object.values(ManualBatchItemStatus));

const uniq = <T>(xs: (T | null | undefined)[]) => [...new Set(xs.filter((x): x is T => x != null))];
const latest = (a: Date | null | undefined, b: Date | null | undefined): Date | null => (!a ? (b ?? null) : !b ? a : a > b ? a : b);
function keepLatest(map: Map<string, Date>, key: string | null, at: Date | null | undefined) {
  if (!key || !at) return;
  const d = latest(map.get(key), at);
  if (d) map.set(key, d);
}

/* ------------------------------------------------------------------ dates for the reason (display only) */

async function lastWhatsAppSends(waKeys: string[], cc: string): Promise<Map<string, Date>> {
  const out = new Map<string, Date>();
  if (!waKeys.length) return out;
  // whatsapp_sends.phone is stored with or without '+': ask for both.
  const rows = await prisma.whatsAppSend.groupBy({
    by: ["phone", "status"],
    where: { phone: { in: [...waKeys, ...waKeys.map((k) => k.slice(1))] }, status: { in: WA_USED } },
    _max: { createdAt: true },
  });
  for (const r of rows) keepLatest(out, historyKey("whatsapp", `+${r.phone.replace(/^\+/, "")}`, cc), r._max.createdAt);
  return out;
}

async function lastCalls(phones: string[]): Promise<Map<string, Date>> {
  const out = new Map<string, Date>();
  if (!phones.length) return out;
  const rows = await prisma.aiCallLog.groupBy({
    by: ["phone", "status"],
    where: { phone: { in: phones }, status: { in: CALL_USED } },
    _max: { createdAt: true },
  });
  for (const r of rows) keepLatest(out, r.phone, r._max.createdAt);
  return out;
}

async function lastEmails(emails: string[]): Promise<Map<string, Date>> {
  const out = new Map<string, Date>();
  if (!emails.length) return out;
  const [items, contacts] = await Promise.all([
    prisma.manualSendBatchItem.groupBy({
      by: ["email", "status"],
      where: { email: { in: emails }, status: { in: BATCH_USED } },
      _max: { createdAt: true },
    }),
    prisma.contact.findMany({
      where: { email: { in: emails } },
      select: {
        email: true,
        emailLogs: { where: { status: { in: EMAIL_LOG_USED } }, select: { createdAt: true }, orderBy: { createdAt: "desc" }, take: 1 },
      },
    }),
  ]);
  for (const i of items) keepLatest(out, historyKey("email", i.email), i._max.createdAt);
  for (const c of contacts) for (const l of c.emailLogs ?? []) keepLatest(out, historyKey("email", c.email), l.createdAt);
  return out;
}

/* ------------------------------------------------------------------ the three checks */

/** Per row (same order): which "already used" checks match. */
export async function findUsed(channel: "whatsapp" | "voicecall", rows: UsedRowInput[], opts: UsedOptions): Promise<UsedInfo[]> {
  const waCc = opts.whatsappCountryCode;
  const waKey = (p: string | null) => (p ? historyKey("whatsapp", p, waCc) : null); // "+digits"; null = WhatsApp can't use it
  const emailKey = (e: string | null) => (e ? historyKey("email", e) : null);
  const phones = uniq(rows.map((r) => r.phone));
  const waKeys = uniq(rows.map((r) => waKey(r.phone)));
  const emails = uniq(rows.map((r) => emailKey(r.email)));

  const [contacts, waHistory, emailHistory, callHistory, waDates, emailDates, callDates] = await Promise.all([
    channel === "whatsapp"
      ? waKeys.length
        ? prisma.whatsAppContact
            .findMany({ where: { phone: { in: waKeys.map((k) => k.slice(1)) } }, select: { phone: true, createdAt: true } })
            .then((r) => new Map(r.map((c) => [`+${c.phone}`, c.createdAt ?? null])))
        : Promise.resolve(new Map<string, Date | null>())
      : phones.length
        ? prisma.aiCallCustomer
            .findMany({ where: { activePhone: { in: phones }, language: opts.language ?? "en" }, select: { activePhone: true, createdAt: true } })
            .then((r) => new Map(r.flatMap((c) => (c.activePhone ? [[c.activePhone, c.createdAt ?? null] as const] : []))))
        : Promise.resolve(new Map<string, Date | null>()),
    loadHistory("whatsapp", waKeys, waCc),
    loadHistory("email", emails),
    loadHistory("ai-call", phones, opts.callCountryCode),
    lastWhatsAppSends(waKeys, waCc),
    lastEmails(emails),
    lastCalls(phones),
  ]);

  return rows.map((r) => {
    const wk = waKey(r.phone);
    const ek = emailKey(r.email);
    const contactKey = channel === "whatsapp" ? wk : r.phone;
    const inContacts = !!contactKey && contacts.has(contactKey);
    const contactAt = inContacts ? contacts.get(contactKey!) : null;

    const viaWhatsApp = !!wk && !!waHistory.get(wk)?.used;
    const viaEmail = !!ek && !!emailHistory.get(ek)?.used;
    const sentAt = latest(viaWhatsApp ? waDates.get(wk!) : null, viaEmail ? emailDates.get(ek!) : null);

    const callAt = r.phone ? (callDates.get(r.phone) ?? null) : null;
    const wasCalled = !!r.phone && !!callHistory.get(r.phone)?.used;
    const called: UsedInfo["called"] = r.excludedReason
      ? { at: callAt?.toISOString() ?? null, reason: r.excludedReason }
      : wasCalled
        ? { at: callAt?.toISOString() ?? null, reason: "called" }
        : null;

    return {
      inContacts: inContacts ? { at: contactAt?.toISOString() ?? null } : null,
      sent:
        viaWhatsApp || viaEmail
          ? { at: sentAt?.toISOString() ?? null, via: [...(viaWhatsApp ? (["whatsapp"] as const) : []), ...(viaEmail ? (["email"] as const) : [])] }
          : null,
      called,
    };
  });
}
