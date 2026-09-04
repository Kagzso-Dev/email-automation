import type { TemplateLink, TemplateMeeting } from "@dispatch/shared";
import { env } from "../env.js";

/* --------------------------------------------------------------- shared escaping */

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Vet a URL for use in an href and make it attribute-safe. Only http(s) and
 * mailto are allowed (these panels are appended after sanitizeEmailHtml runs, so
 * they get no other scheme filtering). `&` is left literal — the click-tracking
 * rewriter and mail clients both want it that way — and only the characters that
 * could break out of the attribute are percent-encoded. Returns null when the
 * scheme isn't allowed.
 */
function safeHref(url: string): string | null {
  if (!/^(https?:|mailto:)/i.test(url.trim())) return null;
  return url.trim().replace(/["'<>\s`]/g, encodeURIComponent);
}

/** Vet a URL for use in an <img src>. Only http(s) — no data:/cid: from user input. */
function safeImgSrc(url: string): string | null {
  if (!/^https?:\/\//i.test(url.trim())) return null;
  return url.trim().replace(/["'<>\s`]/g, encodeURIComponent);
}

/** iCalendar TEXT escaping (RFC 5545 §3.3.11). */
function escapeIcs(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
}

/* --------------------------------------------------------------- date handling */

interface Stamps {
  /** Value for a Google Calendar `dates=` range segment. */
  google: string;
  /** `DTSTART`/`DTEND` line (property name + params + value), no trailing CRLF. */
  icsStart: string;
  icsEnd: string;
  /** Present when the meeting time carries an explicit UTC offset. */
  utc: boolean;
}

const ZONED = /(?:[zZ]|[+-]\d{2}:?\d{2})$/;
const LOCAL = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?/;

function utcStamp(d: Date): string {
  return d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

function addHour(local: string): string {
  const m = local.match(LOCAL);
  if (!m) return local;
  const [, y, mo, da, h, mi, s] = m;
  const t = Date.UTC(+y, +mo - 1, +da, +h, +mi, s ? +s : 0) + 3_600_000;
  return utcStamp(new Date(t)).slice(0, 15); // YYYYMMDDTHHMMSS
}

function localStamp(value: string): string | null {
  const m = value.match(LOCAL);
  if (!m) return null;
  const [, y, mo, da, h, mi, s] = m;
  return `${y}${mo}${da}T${h}${mi}${s ?? "00"}`;
}

/**
 * Resolve the (already variable-substituted) start/end/timezone strings into the
 * stamps the calendar links need. Returns null when `startAt` can't be parsed —
 * the meeting card still renders, just without "add to calendar" actions.
 */
function toStamps(m: TemplateMeeting): Stamps | null {
  const start = m.startAt?.trim();
  if (!start) return null;
  const tz = m.timezone?.trim();

  if (ZONED.test(start)) {
    const sd = new Date(start);
    if (Number.isNaN(sd.getTime())) return null;
    const ed = m.endAt?.trim() && !Number.isNaN(new Date(m.endAt).getTime())
      ? new Date(m.endAt)
      : new Date(sd.getTime() + 3_600_000);
    const s = utcStamp(sd);
    const e = utcStamp(ed);
    return { google: `${s}/${e}`, icsStart: `DTSTART:${s}`, icsEnd: `DTEND:${e}`, utc: true };
  }

  const s = localStamp(start);
  if (!s) return null;
  const e = (m.endAt?.trim() && localStamp(m.endAt)) || addHour(start);
  const tzid = tz ? `;TZID=${tz}` : "";
  return {
    google: `${s}/${e}`,
    icsStart: `DTSTART${tzid}:${s}`,
    icsEnd: `DTEND${tzid}:${e}`,
    utc: false,
  };
}

/* --------------------------------------------------------------- calendar links */

export function googleCalendarUrl(m: TemplateMeeting, stamps: Stamps): string {
  const params = new URLSearchParams({
    action: "TEMPLATE",
    text: m.title || "Meeting",
    dates: stamps.google,
  });
  const details = [m.description, m.joinUrl && `Join: ${m.joinUrl}`].filter(Boolean).join("\n\n");
  if (details) params.set("details", details);
  if (m.location) params.set("location", m.location);
  if (!stamps.utc && m.timezone) params.set("ctz", m.timezone.trim());
  return `https://calendar.google.com/calendar/render?${params.toString()}`;
}

/** A self-contained VEVENT. `uid` keeps re-sends referring to the same event. */
export function buildIcs(m: TemplateMeeting, stamps: Stamps, uid: string): string {
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Dispatch//Email Automation//EN",
    "METHOD:PUBLISH",
    "BEGIN:VEVENT",
    `UID:${uid}`,
    `DTSTAMP:${utcStamp(new Date())}`,
    stamps.icsStart,
    stamps.icsEnd,
    `SUMMARY:${escapeIcs(m.title || "Meeting")}`,
  ];
  const desc = [m.description, m.joinUrl && `Join: ${m.joinUrl}`].filter(Boolean).join("\n\n");
  if (desc) lines.push(`DESCRIPTION:${escapeIcs(desc)}`);
  if (m.location) lines.push(`LOCATION:${escapeIcs(m.location)}`);
  if (m.joinUrl) lines.push(`URL:${escapeIcs(m.joinUrl)}`);
  lines.push("END:VEVENT", "END:VCALENDAR");
  // RFC 5545 wants CRLF line endings.
  return lines.join("\r\n") + "\r\n";
}

/* --------------------------------------------------------------- rendering */

/** A human label for the meeting time, shown in the card. */
function displayTime(m: TemplateMeeting): string {
  const start = m.startAt?.trim();
  if (!start) return "";
  let label = start;
  const d = new Date(start);
  if (!Number.isNaN(d.getTime()) && ZONED.test(start)) {
    try {
      label = d.toLocaleString("en-US", {
        dateStyle: "full",
        timeStyle: "short",
        timeZone: m.timezone?.trim() || "UTC",
      });
    } catch {
      // An unrecognised timezone string — fall back to UTC.
      label = d.toLocaleString("en-US", { dateStyle: "full", timeStyle: "short", timeZone: "UTC" });
    }
  } else {
    const lm = start.match(LOCAL);
    if (lm) label = `${lm[1]}-${lm[2]}-${lm[3]} ${lm[4]}:${lm[5]}`;
  }
  if (m.endAt?.trim()) {
    const em = m.endAt.match(LOCAL);
    label += em ? ` – ${em[4]}:${em[5]}` : ` – ${m.endAt.trim()}`;
  }
  if (m.timezone?.trim()) label += ` (${m.timezone.trim()})`;
  return label;
}

const CARD = "border:1px solid #e3e6ec;border-radius:8px;padding:16px;margin-top:24px";
const BTN =
  "display:inline-block;padding:8px 14px;border-radius:6px;text-decoration:none;font-size:14px";

/**
 * The meeting card HTML. Values passed in are already variable-substituted and
 * must be HTML-escaped here.
 */
export function renderMeetingHtml(m: TemplateMeeting): string {
  const stamps = toStamps(m);
  const rows: string[] = [];
  const when = displayTime(m);
  if (when) rows.push(`<tr><td style="padding:2px 0;color:#8a92a0">When</td><td style="padding:2px 0 2px 12px">${escapeHtml(when)}</td></tr>`);
  if (m.location)
    rows.push(`<tr><td style="padding:2px 0;color:#8a92a0">Where</td><td style="padding:2px 0 2px 12px">${escapeHtml(m.location)}</td></tr>`);

  const buttons: string[] = [];
  const joinHref = m.joinUrl ? safeHref(m.joinUrl) : null;
  if (joinHref)
    buttons.push(
      `<a href="${joinHref}" style="${BTN};background:#2563eb;color:#ffffff;margin-right:8px">Join the meeting</a>`,
    );
  if (stamps) {
    const gcal = safeHref(googleCalendarUrl(m, stamps));
    if (gcal)
      buttons.push(
        `<a href="${gcal}" style="${BTN};background:#f0f2f6;color:#1f2937">Add to Google Calendar</a>`,
      );
  }

  return [
    `<div style="${CARD}">`,
    m.title ? `<div style="font-weight:600;font-size:16px;margin-bottom:8px">${escapeHtml(m.title)}</div>` : "",
    rows.length ? `<table style="font-size:14px;border-collapse:collapse">${rows.join("")}</table>` : "",
    m.description ? `<p style="font-size:14px;margin:10px 0 0">${escapeHtml(m.description).replace(/\n/g, "<br>")}</p>` : "",
    buttons.length ? `<div style="margin-top:14px">${buttons.join("")}</div>` : "",
    stamps ? `<div style="font-size:12px;color:#8a92a0;margin-top:10px">A calendar invite (invite.ics) is attached.</div>` : "",
    `</div>`,
  ]
    .filter(Boolean)
    .join("\n");
}

export function renderMeetingText(m: TemplateMeeting): string {
  const stamps = toStamps(m);
  const parts = ["", "--- Meeting ---"];
  if (m.title) parts.push(m.title);
  const when = displayTime(m);
  if (when) parts.push(`When: ${when}`);
  if (m.location) parts.push(`Where: ${m.location}`);
  if (m.description) parts.push("", m.description);
  if (m.joinUrl) parts.push("", `Join: ${m.joinUrl}`);
  if (stamps) parts.push("", `Add to Google Calendar: ${googleCalendarUrl(m, stamps)}`);
  return parts.join("\n");
}

/* --------------------------------------------------------------- link panel */

export function renderLinkPanelHtml(links: TemplateLink[]): string {
  if (!links.length) return "";
  const items = links
    .map((l) => {
      const href = safeHref(l.url);
      if (!href) return "";
      return `<a href="${href}" style="${BTN};background:#f0f2f6;color:#1f2937;margin:0 8px 8px 0">${escapeHtml(
        l.label,
      )}</a>`;
    })
    .join("");
  if (!items) return "";
  return `<div style="margin-top:24px">${items}</div>`;
}

export function renderLinkPanelText(links: TemplateLink[]): string {
  if (!links.length) return "";
  return "\n" + links.map((l) => `${l.label}: ${l.url}`).join("\n");
}

/* --------------------------------------------------------------- image + video */

/**
 * A responsive <img> block for the optional template image. `url` is already
 * variable-substituted; returns "" when the scheme isn't allowed. Appended after
 * sanitizeEmailHtml runs, like the link/meeting panels.
 */
export function renderImageHtml(url: string): string {
  const src = safeImgSrc(url);
  if (!src) return "";
  return `<div style="margin:16px 0"><img src="${src}" alt="" style="max-width:100%;height:auto;border:0;border-radius:8px" /></div>`;
}

export function renderImageText(url: string): string {
  return safeImgSrc(url) ? `\nImage: ${url.trim()}` : "";
}

/**
 * A "▶ Watch video" button linking out to the video URL — email clients can't
 * embed a player, so the message just points at one.
 */
export function renderVideoButtonHtml(url: string): string {
  const href = safeHref(url);
  if (!href) return "";
  return `<div style="margin:20px 0"><a href="${href}" style="${BTN};background:#2563eb;color:#ffffff">&#9654; Watch video</a></div>`;
}

export function renderVideoText(url: string): string {
  return safeHref(url) ? `\nWatch video: ${url.trim()}` : "";
}

/** Stable-ish UID for the attached invite, namespaced to this deployment. */
export function meetingUid(seed: string): string {
  const host = env.PUBLIC_API_URL.replace(/^https?:\/\//, "").replace(/[^a-z0-9.]/gi, "") || "dispatch";
  return `${seed}@${host}`;
}

export { toStamps };
