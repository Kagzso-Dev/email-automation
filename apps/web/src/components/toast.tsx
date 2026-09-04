import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { ApiError, setMutationNotifier, type MutationNotice } from "../lib/api";
import { Icon, type IconName } from "./icons";

type ToastTone = "error" | "success" | "info";

export interface ToastInput {
  /** Headline for the toast. */
  title: string;
  /** Optional supporting lines — e.g. one per failing form field. */
  lines?: string[];
  tone?: ToastTone;
  /** Milliseconds on screen before it auto-dismisses. `0` keeps it until closed. */
  duration?: number;
}

interface Toast extends Required<Omit<ToastInput, "lines">> {
  id: number;
  lines: string[];
}

interface ToastApi {
  show: (t: ToastInput) => void;
  success: (title: string, lines?: string[]) => void;
  error: (title: string, lines?: string[]) => void;
  /** Turn an unknown thrown value (usually an `ApiError`) into a readable toast. */
  fromError: (err: unknown, fallbackTitle?: string) => void;
}

const ToastContext = createContext<ToastApi | null>(null);

let seq = 0;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const timers = useRef<Map<number, number>>(new Map());

  const dismiss = useCallback((id: number) => {
    setToasts((list) => list.filter((t) => t.id !== id));
    const handle = timers.current.get(id);
    if (handle) {
      window.clearTimeout(handle);
      timers.current.delete(id);
    }
  }, []);

  const show = useCallback(
    (input: ToastInput) => {
      const tone = input.tone ?? "info";
      const duration =
        input.duration ?? (tone === "error" ? 8000 : 4000);
      const toast: Toast = {
        id: ++seq,
        title: input.title,
        lines: input.lines ?? [],
        tone,
        duration,
      };
      setToasts((list) => [...list, toast]);
      if (duration > 0) {
        const handle = window.setTimeout(() => dismiss(toast.id), duration);
        timers.current.set(toast.id, handle);
      }
    },
    [dismiss],
  );

  const api: ToastApi = {
    show,
    success: (title, lines) => show({ title, lines, tone: "success" }),
    error: (title, lines) => show({ title, lines, tone: "error" }),
    fromError: (err, fallbackTitle = "Something went wrong") =>
      show({ ...describeError(err, fallbackTitle), tone: "error" }),
  };

  useEffect(() => {
    const map = timers.current;
    return () => {
      map.forEach((h) => window.clearTimeout(h));
      map.clear();
    };
  }, []);

  // Any successful save / create / delete / send from `api()` raises a toast,
  // so every "Save" and confirm-dialog action lands the same mail notification
  // without each page wiring it up.
  useEffect(() => {
    setMutationNotifier((n) => show({ title: noticeTitle(n), tone: "success" }));
    return () => setMutationNotifier(null);
  }, [show]);

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div className="pointer-events-none fixed inset-x-0 top-3 z-[70] flex flex-col items-center gap-2 px-3 sm:inset-x-auto sm:right-4 sm:items-end">
        {toasts.map((t) => (
          <ToastCard key={t.id} toast={t} onClose={() => dismiss(t.id)} />
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastApi {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast must be used within a <ToastProvider>");
  return ctx;
}

const toneStyles: Record<ToastTone, { wrap: string; badge: string; icon: IconName }> = {
  error: { wrap: "border-[#e6c3bf] bg-[#fdf3f2] text-crit", badge: "bg-[#f9e3e0] text-crit", icon: "info" },
  success: { wrap: "border-[#bfe0cf] bg-[#f1f8f4] text-ok", badge: "bg-[#dcefe4] text-ok", icon: "mail" },
  info: { wrap: "border-line-strong bg-surface text-ink", badge: "bg-surface-muted text-ink", icon: "info" },
};

function ToastCard({ toast, onClose }: { toast: Toast; onClose: () => void }) {
  const s = toneStyles[toast.tone];
  return (
    <div
      role="status"
      className={`animate-toast-in pointer-events-auto relative w-full max-w-sm overflow-hidden rounded-xl border px-4 py-3 shadow-pop ${s.wrap}`}
    >
      <div className="flex items-start gap-3">
        <span
          className={`mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-full ${s.badge} ${
            toast.tone === "success" ? "animate-mail-pop" : ""
          }`}
        >
          <Icon name={s.icon} size={16} />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold">{toast.title}</p>
          {toast.lines.length > 0 ? (
            <ul className="mt-1 space-y-0.5 text-xs text-ink/80">
              {toast.lines.map((line, i) => (
                <li key={i}>{line}</li>
              ))}
            </ul>
          ) : null}
        </div>
        <button
          type="button"
          aria-label="Dismiss"
          onClick={onClose}
          className="-m-1 shrink-0 rounded-md p-1 opacity-60 hover:bg-black/5 hover:opacity-100"
        >
          <Icon name="close" size={15} />
        </button>
      </div>
      {toast.duration > 0 && (
        <span
          aria-hidden
          className="absolute inset-x-0 bottom-0 h-0.5 origin-left bg-current opacity-30"
          style={{ animation: `toast-progress ${toast.duration}ms linear forwards` }}
        />
      )}
    </div>
  );
}

/** Route + method from a successful `api()` mutation → a human headline. */
const NOTICE_NOUNS: Array<[RegExp, string]> = [
  [/^\/api\/whatsapp\/templates/, "WhatsApp template"],
  [/^\/api\/whatsapp\/contacts/, "Contact"],
  [/^\/api\/whatsapp/, "WhatsApp"],
  [/^\/api\/campaigns/, "Campaign"],
  [/^\/api\/lists/, "List"],
  [/^\/api\/templates/, "Template"],
  [/^\/api\/contacts/, "Contact"],
  [/^\/api\/triggers/, "Trigger"],
  [/^\/api\/api-keys/, "API key"],
  [/^\/api\/settings\/allowed-domains/, "Domain"],
  [/^\/api\/settings/, "Settings"],
  [/^\/api\/jobs/, "Job"],
];

export function noticeTitle({ method, path, message }: MutationNotice): string {
  if (message) return message;
  const noun = NOTICE_NOUNS.find(([re]) => re.test(path))?.[1] ?? "Changes";
  const own = (verb: string) => (noun === "Changes" ? verb : `${noun} ${verb.toLowerCase()}`);

  if (/\/send-test(\/|$)/.test(path)) return "Test email sent";
  if (/\/campaigns\/[^/]+\/send-now(\/|$)/.test(path)) return "Campaign sent";
  if (/\/contacts\/send(\/|$)/.test(path)) return "Bulk send started";
  if (/\/send(\/|$)/.test(path)) return "Message sent";
  if (/\/import(\/|$)/.test(path)) return "Import started";
  if (/\/retry(\/|$)/.test(path)) return "Retry queued";
  if (/\/cancel(\/|$)/.test(path)) return "Send cancelled";
  if (/\/pause(\/|$)/.test(path)) return "Campaign paused";
  if (/\/schedule(\/|$)/.test(path)) return "Campaign scheduled";
  if (/\/members(\/|$)/.test(path)) return "List updated";

  if (method === "DELETE") return noun === "Changes" ? "Deleted" : own("deleted");
  if (method === "POST") return noun === "Changes" ? "Saved" : own("created");
  return noun === "Changes" ? "Saved" : own("saved");
}

/** Turn a field name from a Zod path ("sendAt") into a human label ("Send date"). */
const FIELD_LABELS: Record<string, string> = {
  name: "Name",
  templateId: "Template",
  listId: "List",
  scheduleType: "Schedule",
  sendAt: "Send date and time",
  cronExpression: "Repeat schedule",
  subject: "Subject",
  bodyText: "Message body",
  email: "Email",
  eventKey: "Event key",
  domain: "Domain",
};

function labelFor(field: string): string {
  return FIELD_LABELS[field] ?? field.replace(/([A-Z])/g, " $1").replace(/^./, (c) => c.toUpperCase());
}

/**
 * Pull a title + per-field lines out of whatever a failed `api()` call threw.
 * The API returns Zod failures as `{ error: "Validation failed", details: <flatten()> }`.
 */
export function describeError(
  err: unknown,
  fallbackTitle = "Something went wrong",
): { title: string; lines: string[] } {
  if (err instanceof ApiError) {
    const details = err.details as
      | { fieldErrors?: Record<string, string[]>; formErrors?: string[] }
      | undefined;
    const lines: string[] = [];
    if (details?.fieldErrors) {
      for (const [field, msgs] of Object.entries(details.fieldErrors)) {
        for (const m of msgs ?? []) lines.push(`${labelFor(field)}: ${m}`);
      }
    }
    if (details?.formErrors) lines.push(...details.formErrors);

    if (lines.length > 0) {
      return { title: "Please fix these fields", lines };
    }
    return { title: err.message || fallbackTitle, lines: [] };
  }
  if (err instanceof Error) return { title: err.message || fallbackTitle, lines: [] };
  return { title: fallbackTitle, lines: [] };
}
