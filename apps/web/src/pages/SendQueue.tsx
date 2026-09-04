import { Fragment, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";
import { PageHeader } from "../components/Layout";
import { Badge, EmptyState, ErrorNote, SkeletonTable, Table, Tabs, type BadgeTone } from "../components/ui";
import { formatDateTime } from "../lib/schedule";

/**
 * Send Queue — batch history for the two send channels, each on its own tab.
 * The Email tab reads only /api/contacts/send/batches* (ManualSendBatch tables);
 * the WhatsApp tab reads only /api/whatsapp/send/batches* (whatsapp_send_batches /
 * whatsapp_sends). The two trees share no queries or data types — only the
 * <Tabs> / <Table> visual shell.
 */

type BatchStatus = "RUNNING" | "DONE" | "CANCELLED";

const STATUS_FILTERS: { value: "" | BatchStatus; label: string }[] = [
  { value: "", label: "All" },
  { value: "RUNNING", label: "Running" },
  { value: "DONE", label: "Done" },
  { value: "CANCELLED", label: "Cancelled / failed" },
];

const batchTone: Record<BatchStatus, BadgeTone> = {
  RUNNING: "accent",
  DONE: "ok",
  CANCELLED: "warn",
};

const TAB_KEY = "dispatch:send-queue-tab";

export function SendQueuePage() {
  const [tab, setTab] = useState<"email" | "whatsapp">(() => {
    try {
      return localStorage.getItem(TAB_KEY) === "whatsapp" ? "whatsapp" : "email";
    } catch {
      return "email";
    }
  });

  function pick(next: "email" | "whatsapp") {
    setTab(next);
    try {
      localStorage.setItem(TAB_KEY, next);
    } catch {
      /* storage unavailable — non-fatal */
    }
  }

  return (
    <div>
      <PageHeader
        title="Send Queue"
        subtitle="Track sent batches — which recipients are still sending, done, or failed. Email and WhatsApp are kept separate."
      />
      <Tabs
        tabs={[
          { value: "email", label: "Email" },
          { value: "whatsapp", label: "WhatsApp" },
        ]}
        value={tab}
        onChange={pick}
      />
      {tab === "email" ? <EmailQueue /> : <WhatsAppQueue />}
    </div>
  );
}

/* ------------------------------------------------------------------ shared shell bits */

function StatusFilter({
  value,
  onChange,
}: {
  value: "" | BatchStatus;
  onChange: (v: "" | BatchStatus) => void;
}) {
  return (
    <div className="mb-4 flex items-center gap-2">
      <label className="text-xs font-medium uppercase tracking-wide text-slate-550">Status</label>
      <select
        className="input sm:max-w-[14rem]"
        value={value}
        onChange={(e) => onChange(e.target.value as "" | BatchStatus)}
      >
        {STATUS_FILTERS.map((f) => (
          <option key={f.value} value={f.value}>
            {f.label}
          </option>
        ))}
      </select>
    </div>
  );
}

function ProgressBar({ pct, barClass }: { pct: number; barClass: string }) {
  return (
    <div className="h-2 w-full overflow-hidden rounded-full bg-[#eef0f4]">
      <div
        className={`h-full rounded-full transition-[width] duration-500 ${barClass}`}
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}

function Chevron({ open }: { open: boolean }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={14}
      height={14}
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={`shrink-0 text-slate-400 transition-transform ${open ? "rotate-90" : ""}`}
      aria-hidden="true"
    >
      <path d="M9 6l6 6-6 6" />
    </svg>
  );
}

const HEAD = ["", "Batch", "Template", "Recipients", "Status", "Sent", "Failed", "Started", "Completed"];

/* ================================================================== EMAIL TAB */

type EmailItemStatus = "PENDING" | "SENDING" | "SENT" | "FAILED" | "SKIPPED";

interface EmailBatchRow {
  id: string;
  templateName: string;
  total: number;
  status: BatchStatus;
  sent: number;
  failed: number;
  purgeAfter: boolean;
  startedAt: string;
  completedAt: string | null;
}

interface EmailBatchDetailView {
  id: string;
  status: BatchStatus;
  total: number;
  counts: Record<EmailItemStatus, number>;
  items: {
    id: string;
    name: string | null;
    email: string;
    status: EmailItemStatus;
    error: string | null;
    sentAt: string | null;
  }[];
}

const emailItemTone: Record<EmailItemStatus, BadgeTone> = {
  PENDING: "neutral",
  SENDING: "accent",
  SENT: "ok",
  FAILED: "crit",
  SKIPPED: "warn",
};

function EmailQueue() {
  const [status, setStatus] = useState<"" | BatchStatus>("");
  const [expanded, setExpanded] = useState<string | null>(null);

  const q = useQuery({
    queryKey: ["email-batches", status],
    queryFn: () =>
      api<{ items: EmailBatchRow[] }>(
        `/api/contacts/send/batches${status ? `?status=${status}` : ""}`,
      ),
    refetchInterval: (query) =>
      (query.state.data?.items ?? []).some((b) => b.status === "RUNNING") ? 4000 : false,
  });

  return (
    <div>
      <StatusFilter value={status} onChange={setStatus} />
      {q.isLoading ? (
        <SkeletonTable rows={5} />
      ) : q.error ? (
        <ErrorNote error={q.error} />
      ) : q.data!.items.length === 0 ? (
        <EmptyState icon="mail" title="No email batches yet">
          Bulk sends started from the Contacts page show up here.
        </EmptyState>
      ) : (
        <Table head={HEAD}>
          {q.data!.items.map((b) => {
            const open = expanded === b.id;
            return (
              <Fragment key={b.id}>
                <tr
                  className="cursor-pointer border-b border-[#f0f2f6] last:border-0 hover:bg-surface-muted"
                  onClick={() => setExpanded(open ? null : b.id)}
                >
                  <td className="px-4 py-2.5">
                    <Chevron open={open} />
                  </td>
                  <td className="px-4 py-2.5">
                    <div className="font-mono text-xs text-slate-550">{b.id.slice(0, 8)}</div>
                    {b.purgeAfter && (
                      <div className="mt-0.5 text-[11px] text-slate-400">
                        {b.status === "RUNNING" ? "will remove contacts" : "contacts removed"}
                      </div>
                    )}
                  </td>
                  <td className="px-4 py-2.5 text-slate-550">{b.templateName}</td>
                  <td className="px-4 py-2.5 text-slate-550">{b.total}</td>
                  <td className="px-4 py-2.5">
                    <Badge tone={batchTone[b.status]}>{b.status}</Badge>
                  </td>
                  <td className="px-4 py-2.5 font-mono text-ok">{b.sent}</td>
                  <td className="px-4 py-2.5 font-mono text-crit">{b.failed}</td>
                  <td className="px-4 py-2.5 text-xs text-slate-550">{formatDateTime(b.startedAt)}</td>
                  <td className="px-4 py-2.5 text-xs text-slate-550">
                    {b.completedAt ? formatDateTime(b.completedAt) : "—"}
                  </td>
                </tr>
                {open && (
                  <tr className="border-b border-[#f0f2f6]">
                    <td colSpan={HEAD.length} className="bg-[#fafbfc] px-4 py-4">
                      <EmailBatchDetail id={b.id} />
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
        </Table>
      )}
    </div>
  );
}

function EmailBatchDetail({ id }: { id: string }) {
  const q = useQuery({
    queryKey: ["email-batch", id],
    queryFn: () => api<EmailBatchDetailView>(`/api/contacts/send/batches/${id}`),
    refetchInterval: (query) => (query.state.data?.status === "RUNNING" ? 2000 : false),
  });

  if (q.isLoading) return <div className="text-sm text-slate-550">Loading recipients…</div>;
  if (q.error || !q.data) return <ErrorNote error={q.error ?? new Error("Batch not found.")} />;

  const v = q.data;
  const done = v.counts.SENT + v.counts.FAILED + v.counts.SKIPPED;
  const pct = v.total ? Math.round((done / v.total) * 100) : 100;

  return (
    <div>
      <ProgressBar pct={pct} barClass="bg-accent-ink" />
      <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 font-mono text-xs text-slate-550">
        <span>
          <b className="text-ok">{v.counts.SENT}</b> sent
        </span>
        <span>
          <b className="text-crit">{v.counts.FAILED}</b> failed
        </span>
        <span>
          <b className="text-warn">{v.counts.SKIPPED}</b> skipped
        </span>
        {v.counts.PENDING + v.counts.SENDING > 0 && (
          <span>
            <b className="text-ink">{v.counts.PENDING + v.counts.SENDING}</b> to go
          </span>
        )}
      </div>

      <div className="mt-3 overflow-x-auto rounded-lg border border-[#e3e6ec] bg-white">
        <table className="w-full min-w-[36rem] text-sm">
          <thead>
            <tr className="border-b border-[#e3e6ec] text-left text-xs uppercase tracking-wide text-slate-550">
              <th className="px-3 py-2">Name</th>
              <th className="px-3 py-2">Email</th>
              <th className="px-3 py-2">Status</th>
              <th className="px-3 py-2">Sent</th>
              <th className="px-3 py-2">Error</th>
            </tr>
          </thead>
          <tbody>
            {v.items.map((it) => (
              <tr key={it.id} className="border-b border-[#f0f2f6] last:border-0">
                <td className="px-3 py-1.5">{it.name || "—"}</td>
                <td className="px-3 py-1.5 font-mono text-xs">{it.email}</td>
                <td className="px-3 py-1.5">
                  <Badge tone={emailItemTone[it.status]}>{it.status}</Badge>
                </td>
                <td className="px-3 py-1.5 text-xs text-slate-550">
                  {it.sentAt ? formatDateTime(it.sentAt) : "—"}
                </td>
                <td className="px-3 py-1.5 text-xs text-slate-550">
                  <span className="block max-w-[20rem] truncate" title={it.error ?? undefined}>
                    {it.error || "—"}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/* =============================================================== WHATSAPP TAB */

type WaItemStatus = "QUEUED" | "SENDING" | "SENT" | "DELIVERED" | "FAILED" | "SKIPPED";

interface WaBatchRow {
  id: string;
  templateName: string;
  total: number;
  status: BatchStatus;
  sent: number;
  failed: number;
  purgeAfter: boolean;
  startedAt: string;
  completedAt: string | null;
}

interface WaBatchDetailView {
  id: string;
  status: BatchStatus;
  total: number;
  counts: Record<WaItemStatus, number>;
  items: {
    id: string;
    name: string | null;
    phone: string;
    status: WaItemStatus;
    error: string | null;
    sentAt: string | null;
    deliveredAt: string | null;
  }[];
}

const waItemTone: Record<WaItemStatus, BadgeTone> = {
  QUEUED: "neutral",
  SENDING: "accent",
  SENT: "ok",
  DELIVERED: "ok",
  FAILED: "crit",
  SKIPPED: "warn",
};

function WhatsAppQueue() {
  const [status, setStatus] = useState<"" | BatchStatus>("");
  const [expanded, setExpanded] = useState<string | null>(null);

  const q = useQuery({
    queryKey: ["whatsapp-batches", status],
    queryFn: () =>
      api<{ items: WaBatchRow[] }>(
        `/api/whatsapp/send/batches${status ? `?status=${status}` : ""}`,
      ),
    refetchInterval: (query) =>
      (query.state.data?.items ?? []).some((b) => b.status === "RUNNING") ? 4000 : false,
  });

  return (
    <div>
      <StatusFilter value={status} onChange={setStatus} />
      {q.isLoading ? (
        <SkeletonTable rows={5} />
      ) : q.error ? (
        <ErrorNote error={q.error} />
      ) : q.data!.items.length === 0 ? (
        <EmptyState icon="whatsapp" title="No WhatsApp batches yet">
          WhatsApp sends started from the Contacts or WhatsApp Contacts page show up here.
        </EmptyState>
      ) : (
        <Table head={HEAD}>
          {q.data!.items.map((b) => {
            const open = expanded === b.id;
            return (
              <Fragment key={b.id}>
                <tr
                  className="cursor-pointer border-b border-[#f0f2f6] last:border-0 hover:bg-surface-muted"
                  onClick={() => setExpanded(open ? null : b.id)}
                >
                  <td className="px-4 py-2.5">
                    <Chevron open={open} />
                  </td>
                  <td className="px-4 py-2.5">
                    <div className="font-mono text-xs text-slate-550">{b.id.slice(0, 8)}</div>
                    {b.purgeAfter && (
                      <div className="mt-0.5 text-[11px] text-slate-400">
                        {b.status === "RUNNING" ? "will remove contacts" : "contacts removed"}
                      </div>
                    )}
                  </td>
                  <td className="px-4 py-2.5 text-slate-550">{b.templateName}</td>
                  <td className="px-4 py-2.5 text-slate-550">{b.total}</td>
                  <td className="px-4 py-2.5">
                    <Badge tone={batchTone[b.status]}>{b.status}</Badge>
                  </td>
                  <td className="px-4 py-2.5 font-mono text-ok">{b.sent}</td>
                  <td className="px-4 py-2.5 font-mono text-crit">{b.failed}</td>
                  <td className="px-4 py-2.5 text-xs text-slate-550">{formatDateTime(b.startedAt)}</td>
                  <td className="px-4 py-2.5 text-xs text-slate-550">
                    {b.completedAt ? formatDateTime(b.completedAt) : "—"}
                  </td>
                </tr>
                {open && (
                  <tr className="border-b border-[#f0f2f6]">
                    <td colSpan={HEAD.length} className="bg-[#fafbfc] px-4 py-4">
                      <WhatsAppBatchDetail id={b.id} />
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
        </Table>
      )}
    </div>
  );
}

function WhatsAppBatchDetail({ id }: { id: string }) {
  const q = useQuery({
    queryKey: ["whatsapp-batch", id],
    queryFn: () => api<WaBatchDetailView>(`/api/whatsapp/send/batches/${id}`),
    refetchInterval: (query) => (query.state.data?.status === "RUNNING" ? 2000 : false),
  });

  if (q.isLoading) return <div className="text-sm text-slate-550">Loading recipients…</div>;
  if (q.error || !q.data) return <ErrorNote error={q.error ?? new Error("Batch not found.")} />;

  const v = q.data;
  const done = v.counts.SENT + v.counts.DELIVERED + v.counts.FAILED + v.counts.SKIPPED;
  const pct = v.total ? Math.round((done / v.total) * 100) : 100;

  return (
    <div>
      <ProgressBar pct={pct} barClass="bg-[#25d366]" />
      <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 font-mono text-xs text-slate-550">
        <span>
          <b className="text-ok">{v.counts.SENT + v.counts.DELIVERED}</b> sent
        </span>
        <span>
          <b className="text-crit">{v.counts.FAILED}</b> failed
        </span>
        <span>
          <b className="text-warn">{v.counts.SKIPPED}</b> skipped
        </span>
        {v.counts.QUEUED + v.counts.SENDING > 0 && (
          <span>
            <b className="text-ink">{v.counts.QUEUED + v.counts.SENDING}</b> to go
          </span>
        )}
      </div>

      <div className="mt-3 overflow-x-auto rounded-lg border border-[#e3e6ec] bg-white">
        <table className="w-full min-w-[36rem] text-sm">
          <thead>
            <tr className="border-b border-[#e3e6ec] text-left text-xs uppercase tracking-wide text-slate-550">
              <th className="px-3 py-2">Name</th>
              <th className="px-3 py-2">Phone</th>
              <th className="px-3 py-2">Status</th>
              <th className="px-3 py-2">Sent</th>
              <th className="px-3 py-2">Error</th>
            </tr>
          </thead>
          <tbody>
            {v.items.map((it) => (
              <tr key={it.id} className="border-b border-[#f0f2f6] last:border-0">
                <td className="px-3 py-1.5">{it.name || "—"}</td>
                <td className="px-3 py-1.5 font-mono text-xs">{it.phone || "—"}</td>
                <td className="px-3 py-1.5">
                  <Badge tone={waItemTone[it.status]}>{it.status}</Badge>
                </td>
                <td className="px-3 py-1.5 text-xs text-slate-550">
                  {it.sentAt ? formatDateTime(it.sentAt) : "—"}
                </td>
                <td className="px-3 py-1.5 text-xs text-slate-550">
                  <span className="block max-w-[20rem] truncate" title={it.error ?? undefined}>
                    {it.error || "—"}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
