import type { ReactNode } from "react";

export function Badge({ children, tone = "neutral" }: { children: ReactNode; tone?: BadgeTone }) {
  const tones: Record<BadgeTone, string> = {
    neutral: "bg-[#eef0f4] text-slate-550",
    accent: "bg-accent-soft text-accent-ink",
    ok: "bg-[#e7f1ec] text-ok",
    warn: "bg-[#f8f0e1] text-warn",
    crit: "bg-[#f9ebe9] text-crit",
  };
  return (
    <span className={`inline-flex rounded-full px-2 py-0.5 font-mono text-xs ${tones[tone]}`}>
      {children}
    </span>
  );
}
export type BadgeTone = "neutral" | "accent" | "ok" | "warn" | "crit";

export const campaignTone: Record<string, BadgeTone> = {
  DRAFT: "neutral",
  SCHEDULED: "accent",
  SENDING: "warn",
  SENT: "ok",
  PAUSED: "warn",
  FAILED: "crit",
};

export const emailTone: Record<string, BadgeTone> = {
  QUEUED: "neutral",
  SENT: "accent",
  DELIVERED: "ok",
  OPENED: "ok",
  CLICKED: "ok",
  BOUNCED: "crit",
  COMPLAINED: "crit",
  FAILED: "crit",
};

export function EmptyState({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-xl border border-dashed border-[#d5d9e2] bg-white p-10 text-center text-sm text-slate-550">
      {children}
    </div>
  );
}

export function Spinner() {
  return <div className="p-8 text-sm text-slate-550">Loading…</div>;
}

export function ErrorNote({ error }: { error: unknown }) {
  const msg = error instanceof Error ? error.message : "Something went wrong";
  return <div className="rounded-lg bg-[#f9ebe9] px-3 py-2 text-sm text-crit">{msg}</div>;
}

export function Modal({
  open,
  onClose,
  title,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
}) {
  if (!open) return null;
  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-black/30 p-4"
      onClick={onClose}
    >
      <div
        className="max-h-[85vh] w-full max-w-lg overflow-y-auto rounded-xl bg-white p-6 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="mb-4 text-lg font-semibold">{title}</h2>
        {children}
      </div>
    </div>
  );
}

export function Table({ head, children }: { head: string[]; children: ReactNode }) {
  return (
    <div className="overflow-x-auto rounded-xl border border-[#e3e6ec] bg-white">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-[#e3e6ec] text-left">
            {head.map((h) => (
              <th key={h} className="px-4 py-2.5 text-xs font-semibold uppercase tracking-wide text-slate-550">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}
