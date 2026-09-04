/* Friendly recurring-schedule helpers.
 * The API stores a standard 5-field cron expression ("m h dom mon dow"); the UI
 * lets people pick Daily / Weekly / Monthly and a 12-hour time instead. */

export type Frequency = "DAILY" | "WEEKLY" | "MONTHLY";
export type Meridiem = "AM" | "PM";

export interface ScheduleForm {
  frequency: Frequency;
  hour12: number; // 1–12
  minute: number; // 0–59
  meridiem: Meridiem;
  weekday: number; // 0 (Sun) – 6 (Sat), used when frequency = WEEKLY
  monthday: number; // 1–28, used when frequency = MONTHLY
}

export const WEEKDAYS = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];

export function to24Hour(hour12: number, meridiem: Meridiem): number {
  const h = hour12 % 12;
  return meridiem === "PM" ? h + 12 : h;
}

export function from24Hour(hour24: number): { hour12: number; meridiem: Meridiem } {
  const meridiem: Meridiem = hour24 >= 12 ? "PM" : "AM";
  const hour12 = hour24 % 12 === 0 ? 12 : hour24 % 12;
  return { hour12, meridiem };
}

export function defaultScheduleForm(): ScheduleForm {
  return { frequency: "WEEKLY", hour12: 9, minute: 0, meridiem: "AM", weekday: 1, monthday: 1 };
}

export function buildCron(f: ScheduleForm): string {
  const h = to24Hour(f.hour12, f.meridiem);
  const m = f.minute;
  switch (f.frequency) {
    case "DAILY":
      return `${m} ${h} * * *`;
    case "WEEKLY":
      return `${m} ${h} * * ${f.weekday}`;
    case "MONTHLY":
      return `${m} ${h} ${f.monthday} * *`;
  }
}

/** Best-effort parse of a cron string back into the friendly form. */
export function parseCron(cron?: string | null): ScheduleForm | null {
  if (!cron) return null;
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const [m, h, dom, mon, dow] = parts as [string, string, string, string, string];
  const minute = Number(m);
  const hour24 = Number(h);
  if (!Number.isInteger(minute) || minute < 0 || minute > 59) return null;
  if (!Number.isInteger(hour24) || hour24 < 0 || hour24 > 23) return null;
  const { hour12, meridiem } = from24Hour(hour24);
  const base = { hour12, minute, meridiem, weekday: 1, monthday: 1 };
  if (dom === "*" && mon === "*" && dow === "*") {
    return { ...base, frequency: "DAILY" };
  }
  if (dom === "*" && mon === "*" && /^[0-6]$/.test(dow)) {
    return { ...base, frequency: "WEEKLY", weekday: Number(dow) };
  }
  if (/^\d{1,2}$/.test(dom) && mon === "*" && dow === "*") {
    return { ...base, frequency: "MONTHLY", monthday: Number(dom) };
  }
  return null;
}

export function formatTime(hour12: number, minute: number, meridiem: Meridiem): string {
  return `${hour12}:${String(minute).padStart(2, "0")} ${meridiem}`;
}

/* ---------------------------------------------------------------- one-time send */

export interface OnceForm {
  date: string; // yyyy-mm-dd (from <input type="date">)
  hour12: number; // 1–12
  minute: number; // 0–59
  meridiem: Meridiem;
}

export function defaultOnceForm(): OnceForm {
  return { date: "", hour12: 9, minute: 0, meridiem: "AM" };
}

/** Combine the one-time fields into an ISO timestamp in the browser's local zone. */
export function buildOnceISO(f: OnceForm): string {
  const [y, mo, d] = f.date.split("-").map(Number);
  const h = to24Hour(f.hour12, f.meridiem);
  return new Date(y ?? 0, (mo ?? 1) - 1, d ?? 1, h, f.minute, 0, 0).toISOString();
}

/** Today's date as yyyy-mm-dd in the browser's local zone — for a date picker's `min`. */
export function todayLocalISODate(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate(),
  ).padStart(2, "0")}`;
}

/** True when the one-time picker resolves to a moment that is still in the future. */
export function isOnceInFuture(f: OnceForm): boolean {
  if (!f.date) return false;
  const t = new Date(buildOnceISO(f)).getTime();
  return Number.isFinite(t) && t > Date.now();
}

/** Locale-formatted date with an unambiguous 12-hour time ("Sep 3, 2026, 1:05 PM"). */
export function formatDateTime(value?: string | Date | null): string {
  if (!value) return "";
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
}

/** Human-readable summary of a cron string ("Weekly on Monday at 9:00 AM"). */
export function describeCron(cron?: string | null): string {
  if (!cron) return "Recurring";
  const f = parseCron(cron);
  if (!f) return cron;
  const time = formatTime(f.hour12, f.minute, f.meridiem);
  switch (f.frequency) {
    case "DAILY":
      return `Daily at ${time}`;
    case "WEEKLY":
      return `Weekly on ${WEEKDAYS[f.weekday]} at ${time}`;
    case "MONTHLY":
      return `Monthly on day ${f.monthday} at ${time}`;
  }
}
