import { Fragment, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient, type QueryKey, type UseQueryResult } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { ChevronRight, LoaderCircle, OctagonX, RotateCcw } from "lucide-react";
import { hardStopStatusText } from "@dispatch/shared";
import { api } from "../lib/api";
import { Badge, ErrorNote, Tabs, type BadgeTone } from "../components/ui";
import { pageOf, QUEUE_CARD, QueuePagination, ScrollTable, SkeletonRows } from "../components/QueueTable";
import { Icon } from "../components/icons";
import { useToast } from "../components/toast";
import { useConfirm } from "../components/confirm";
import { Tooltip } from "../components/Tooltip";
import { formatShortDateTime } from "../lib/schedule";
import { useAiCallsConfig } from "../lib/aiCalls";
import { AiCallFollowupsQueue } from "../components/AiCallFollowupsQueue";
import { QueueActions } from "../components/QueueActions";
import { DeleteHistoryButton } from "../components/DeleteHistoryButton";
import { useScrolledShadow } from "../lib/useScrolledShadow";
import { useHardStopEnabled, useLatestHardStop } from "../lib/hardStop";
import { HardStopButton, HardStopTargetStatus } from "../components/HardStopButton";
import {
  BatchIdButton,
  BatchStatusBadge,
  batchDisplayStatus,
  DeliveryProgress,
  ROW_ACCENT,
  TimeRange,
  type BatchStatus,
  type BatchSummary,
} from "../components/sendQueue/BatchCells";
import { QueueEmptyState, QueueFilterBar, TabLabel } from "../components/sendQueue/QueueChrome";
import { FailedRecipients } from "../components/sendQueue/FailedRecipients";
import { DangerZoneMenu, LastStopBanner } from "../components/sendQueue/DangerZone";

/**
 * Send Queue — batch history for the two send channels, each on its own tab.
 * The Email tab reads only /api/contacts/send/batches* (ManualSendBatch tables);
 * the WhatsApp tab reads only /api/whatsapp/send/batches* (whatsapp_send_batches /
 * whatsapp_sends). The two trees share no queries or data types — only the
 * visual shell (<BatchQueue>, the row cells in components/sendQueue).
 *
 * Layout: header (title, Upload / Download for the open tab, "More" danger menu) → the latest hard stop, if any →
 * tabs with counts → search + Status → the table card with its pagination footer.
 */

const STATUS_FILTERS: { value: "" | BatchStatus; label: string }[] = [
  { value: "", label: "All statuses" },
  { value: "RUNNING", label: "Sending" },
  { value: "DONE", label: "Finished" }, // done, partial and failed all finished
  { value: "CANCELLED", label: "Cancelled" },
];

const TAB_KEY = "dispatch:send-queue-tab";

type QueueTab = "email" | "whatsapp" | "ai-followups";

/** Page, page size, status filter and search — kept per tab while you switch between them. */
export interface QueueView {
  page: number;
  pageSize: number;
  status: string;
  /** Batch ID or template name (Email / WhatsApp tabs). */
  search?: string;
}
export interface QueueViewProps {
  view: QueueView;
  setView: (patch: Partial<QueueView>) => void;
}

const DEFAULT_VIEWS: Record<QueueTab, QueueView> = {
  email: { page: 1, pageSize: 10, status: "", search: "" },
  whatsapp: { page: 1, pageSize: 10, status: "", search: "" },
  "ai-followups": { page: 1, pageSize: 10, status: "PENDING_APPROVAL" },
};

export function SendQueuePage() {
  // "AI Call follow-ups" (approval queue) — admins only, while ENABLE_AI_CALLS is on.
  const aiCalls = useAiCallsConfig();
  const showAi = !!aiCalls.data?.enabled && !!aiCalls.data.canStart;
  const hardStop = useHardStopEnabled(); // ENABLE_HARD_STOP: off = no "More" menu and no stop notice
  const [tab, setTab] = useState<QueueTab>(() => {
    try {
      const saved = localStorage.getItem(TAB_KEY);
      return saved === "whatsapp" || saved === "ai-followups" ? saved : "email";
    } catch {
      return "email";
    }
  });

  const [views, setViews] = useState(DEFAULT_VIEWS);
  const viewProps = (t: QueueTab): QueueViewProps => ({
    view: views[t],
    setView: (patch) => setViews((v) => ({ ...v, [t]: { ...v[t], ...patch } })),
  });

  function pick(next: QueueTab) {
    setTab(next);
    try {
      localStorage.setItem(TAB_KEY, next);
    } catch {
      /* storage unavailable — non-fatal */
    }
  }

  const active: QueueTab = tab === "ai-followups" && !showAi ? "email" : tab;
  const section = active === "email" ? "EMAIL" : active === "whatsapp" ? "WHATSAPP" : null;
  const counts = useTabCounts(showAi);

  return (
    <div className="space-y-6">
      <header className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
        <div className="min-w-0">
          <h1 className="page-title">
            Send <span className="text-gradient">Queue</span>
          </h1>
          <p className="page-subtitle">Every bulk send: what went out, what's still sending, and what failed.</p>
        </div>
        <div role="group" aria-label="Send Queue actions" className="flex flex-wrap items-center gap-2 lg:shrink-0 lg:justify-end">
          <QueueActions upload={active === "ai-followups" ? "ai-call" : active} history={active} />
          {hardStop && <DangerZoneMenu section={section} />}
        </div>
      </header>

      {hardStop && <LastStopBanner section={section} />}

      <div>
        <Tabs
          idPrefix="send-queue"
          ariaLabel="Channels"
          tabs={[
            {
              value: "email",
              label: <TabLabel icon="mail" text="Email" count={counts.email} countLabel="batches" active={active === "email"} />,
            },
            {
              value: "whatsapp",
              label: <TabLabel icon="whatsapp" text="WhatsApp" count={counts.whatsapp} countLabel="batches" active={active === "whatsapp"} />,
            },
            ...(showAi
              ? [
                  {
                    value: "ai-followups" as const,
                    label: (
                      <TabLabel
                        icon="phone"
                        text="AI Call follow-ups"
                        count={counts.aiPending}
                        countLabel="waiting for approval"
                        tone="warn"
                        active={active === "ai-followups"}
                      />
                    ),
                  },
                ]
              : []),
          ]}
          value={active}
          onChange={pick}
        />
        <div role="tabpanel" id="send-queue-panel" aria-labelledby={`send-queue-tab-${active}`}>
          {active === "ai-followups" ? (
            <AiCallFollowupsQueue {...viewProps("ai-followups")} />
          ) : active === "whatsapp" ? (
            <WhatsAppQueue {...viewProps("whatsapp")} />
          ) : (
            <EmailQueue {...viewProps("email")} />
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * The tab badges: every batch per channel (the unfiltered lists, the same queries the tabs use with no Status
 * filter, so nothing extra is fetched there) and the follow-ups waiting for approval.
 */
function useTabCounts(showAi: boolean) {
  const email = useQuery({ queryKey: ["email-batches", ""], queryFn: () => fetchEmailBatches("") });
  const whatsapp = useQuery({ queryKey: ["whatsapp-batches", ""], queryFn: () => fetchWaBatches("") });
  // Same key and request as the follow-ups tab's default view, so they share one cache entry.
  const ai = useQuery({
    queryKey: ["ai-call-followups", "PENDING_APPROVAL", 1, 10],
    queryFn: () => api<{ pending: number }>("/api/ai-call-followups?page=1&pageSize=10&status=PENDING_APPROVAL"),
    enabled: showAi,
  });
  return { email: email.data?.items.length, whatsapp: whatsapp.data?.items.length, aiPending: ai.data?.pending };
}

/** Hard stop (flag on): a stopped batch's status and cancelled-rows CSV, above its recipients. */
function HardStopDetailStatus({ scope, id }: { scope: "EMAIL_BATCH" | "WHATSAPP_BATCH"; id: string }) {
  const hardStop = useHardStopEnabled();
  if (!hardStop) return null;
  return <HardStopTargetStatus scope={scope} targetId={id} />;
}

/** Hard stop (flag on): one line under a cancelled row's badge; the full status is in its details. */
function StopNote({ scope, id }: { scope: "EMAIL_BATCH" | "WHATSAPP_BATCH"; id: string }) {
  const q = useLatestHardStop(scope, id, true);
  const stop = q.data?.stop;
  if (!stop) return null;
  return (
    <div className="mt-1 max-w-[11rem] truncate text-[11px] text-slate-550" title={hardStopStatusText(stop)}>
      {stop.status === "STOPPING" ? `Stopping… ${stop.inProgress} in progress` : `Hard stopped by ${stop.byEmail}`}
    </div>
  );
}

/* ------------------------------------------------------------------ shared shell bits */

const HEAD: ReactNode[] = [
  <span className="sr-only">Details</span>,
  "Batch",
  "Template",
  "Delivery",
  "Status",
  <>
    <span aria-hidden="true">Started → Completed</span>
    <span className="sr-only">Started and completed</span>
  </>,
  <span className="sr-only">Actions</span>,
];

const STILL_SENDING = "Still sending. It can be deleted once it has finished.";
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** Search by batch ID or template name, over the list already loaded (the API returns the newest 100). */
function searchBatches<T extends BatchSummary>(items: T[], search = ""): T[] {
  const s = search.trim().toLowerCase();
  if (!s) return items;
  return items.filter((b) => b.id.toLowerCase().includes(s) || b.templateName.toLowerCase().includes(s));
}

/** The rows on screen: search, then the page. */
function visiblePage<T extends BatchSummary>(items: T[], view: QueueView) {
  return pageOf(searchBatches(items, view.search), view.page, view.pageSize);
}

/**
 * One batch tab (Email or WhatsApp): filter row, then the table card (or an empty / no-match state). The tab owns
 * the query and hands in its row actions and the expanded detail.
 */
function BatchQueue<T extends BatchSummary>({
  view,
  setView,
  query: q,
  label,
  stopScope,
  empty,
  actions,
  detail,
}: QueueViewProps & {
  query: UseQueryResult<{ items: T[] }>;
  /** Table caption for screen readers. */
  label: string;
  stopScope: "EMAIL_BATCH" | "WHATSAPP_BATCH";
  empty: { title: string; body: ReactNode; cta: { to: string; label: string } };
  actions: (b: T) => ReactNode;
  detail: (b: T) => ReactNode;
}) {
  const status = view.status as "" | BatchStatus;
  const search = view.search ?? "";
  const [expanded, setExpanded] = useState<string | null>(null);
  const hardStop = useHardStopEnabled();

  const matches = searchBatches(q.data?.items ?? [], search);
  // Newest first (the API orders by start time, newest first).
  const current = pageOf(matches, view.page, view.pageSize);
  const filtered = status !== "" || search.trim() !== "";

  return (
    <div>
      <QueueFilterBar
        search={search}
        onSearch={(v) => setView({ search: v, page: 1 })}
        searchLabel="Search batches by ID or template"
        searchPlaceholder="Search batch ID or template"
        status={status}
        statusOptions={STATUS_FILTERS}
        onStatus={(v) => setView({ status: v, page: 1 })}
      />
      {q.isLoading ? (
        <ScrollTable head={HEAD} label={label}>
          <SkeletonRows cols={HEAD.length} />
        </ScrollTable>
      ) : q.error ? (
        <ErrorNote error={q.error} />
      ) : matches.length === 0 ? (
        <div className={QUEUE_CARD}>
          {filtered ? (
            <QueueEmptyState
              variant="no-match"
              title="No batches match"
              action={
                <button type="button" className="btn-ghost h-10" onClick={() => setView({ status: "", search: "", page: 1 })}>
                  Clear filters
                </button>
              }
            >
              {search.trim() ? `Nothing matches “${search.trim()}”${status ? " with this status" : ""}.` : "No batches have this status."} Try
              another search or status.
            </QueueEmptyState>
          ) : (
            <QueueEmptyState
              title={empty.title}
              action={
                <Link to={empty.cta.to} className="btn-primary h-10 px-4">
                  {empty.cta.label}
                </Link>
              }
            >
              {empty.body}
            </QueueEmptyState>
          )}
        </div>
      ) : (
        <ScrollTable
          head={HEAD}
          label={label}
          minWidth="56rem"
          scrollKey={`${status}:${search}:${current.page}:${view.pageSize}`}
          footer={
            <QueuePagination
              page={current.page}
              pageSize={view.pageSize}
              total={matches.length}
              onPage={(page) => setView({ page })}
              onPageSize={(pageSize) => setView({ pageSize, page: 1 })}
            />
          }
        >
          {current.rows.map((b) => {
            const open = expanded === b.id;
            const shown = batchDisplayStatus(b);
            const detailId = `batch-detail-${b.id}`;
            const toggle = () => setExpanded(open ? null : b.id);
            return (
              <Fragment key={b.id}>
                <tr
                  className={`cursor-pointer border-b border-line-subtle last:border-0 ${open ? "bg-surface-sunken" : ""}`}
                  onClick={toggle}
                >
                  <td className={`w-12 py-3.5 pl-3 pr-0 ${ROW_ACCENT[shown]}`}>
                    <button
                      type="button"
                      className="btn-icon"
                      aria-expanded={open}
                      aria-controls={open ? detailId : undefined}
                      aria-label={`${open ? "Hide" : "Show"} recipients of batch ${b.id.slice(0, 8)}`}
                      onClick={(e) => {
                        e.stopPropagation();
                        toggle();
                      }}
                    >
                      <ChevronRight
                        size={16}
                        aria-hidden="true"
                        className={`transition-transform duration-200 motion-reduce:transition-none ${open ? "rotate-90" : ""}`}
                      />
                    </button>
                  </td>
                  <td className="px-4 py-3.5">
                    <BatchIdButton id={b.id} />
                    {b.purgeAfter && (
                      <div className="mt-1 text-[11px] text-slate-550">
                        {b.status === "RUNNING" ? "Will remove reached contacts" : "Reached contacts removed"}
                      </div>
                    )}
                  </td>
                  <td className="px-4 py-3.5">
                    <span className="line-clamp-2 max-w-[16rem] break-words font-medium text-ink" title={b.templateName}>
                      {b.templateName}
                    </span>
                  </td>
                  <td className="px-4 py-3.5">
                    <DeliveryProgress total={b.total} sent={b.sent} failed={b.failed} />
                  </td>
                  <td className="px-4 py-3.5">
                    <BatchStatusBadge status={shown} />
                    {hardStop && b.status === "CANCELLED" && <StopNote scope={stopScope} id={b.id} />}
                  </td>
                  <td className="px-4 py-3.5">
                    <TimeRange startedAt={b.startedAt} completedAt={b.completedAt} />
                  </td>
                  <td className="px-3 py-3.5" onClick={(e) => e.stopPropagation()}>
                    <div className="flex items-center justify-end gap-1">{actions(b)}</div>
                  </td>
                </tr>
                {open && (
                  <tr id={detailId} className="border-b border-line-subtle last:border-0">
                    <td colSpan={HEAD.length} className="bg-surface-sunken px-4 py-5 sm:px-6">
                      {detail(b)}
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
        </ScrollTable>
      )}
    </div>
  );
}

/** Hard stop on a running row (flag on): the same button and confirmation as before, sized for the row. */
function RowHardStop({ scope, id, invalidate }: { scope: "EMAIL_BATCH" | "WHATSAPP_BATCH"; id: string; invalidate: QueryKey[] }) {
  return (
    <HardStopButton
      scope={scope}
      targetId={id}
      className="btn-danger h-8 gap-1.5 px-2.5 text-xs"
      icon={<OctagonX size={14} aria-hidden="true" />}
      invalidate={invalidate}
    />
  );
}

/** The expanded batch: a progress card (percentage, bar and counts). */
function DetailProgress({
  pct,
  barClass,
  stats,
}: {
  pct: number;
  barClass: string;
  stats: { label: string; value: number; tone: string }[];
}) {
  return (
    <div className="rounded-xl border border-line/70 bg-surface p-4 shadow-sm">
      <div className="flex items-center justify-between gap-3 text-xs">
        <span className="font-semibold uppercase tracking-[0.06em] text-slate-550">Progress</span>
        <span className="font-mono tabular-nums text-ink">{pct}%</span>
      </div>
      <div
        className="mt-2 h-2 w-full overflow-hidden rounded-full bg-surface-muted"
        role="progressbar"
        aria-label="Batch progress"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct}
      >
        <div className={`h-full rounded-full transition-[width] duration-500 motion-reduce:transition-none ${barClass}`} style={{ width: `${pct}%` }} />
      </div>
      <ul className="mt-3 flex flex-wrap gap-x-5 gap-y-1 text-xs text-slate-550">
        {stats.map((s) => (
          <li key={s.label}>
            <b className={`font-mono text-sm font-semibold tabular-nums ${s.tone}`}>{s.value}</b> {s.label}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** One recipient as the detail table shows it (both channels map their own items onto this). */
interface RecipientRow {
  id: string;
  name: string | null;
  contact: string;
  status: string;
  tone: BadgeTone;
  sentAt: string | null;
  deliveredAt: string | null;
  openedAt: string | null;
  error: string | null;
  failedAt: string | null;
}

function RecipientsTable({ contactLabel, rows }: { contactLabel: "Email" | "Phone"; rows: RecipientRow[] }) {
  const shadowRef = useScrolledShadow<HTMLDivElement>();
  const when = (v: string | null) => (v ? formatShortDateTime(v) : "—");
  return (
    <div className="overflow-hidden rounded-xl border border-line/70 bg-surface shadow-sm">
      <div className="flex items-center justify-between border-b border-line-subtle px-4 py-2.5">
        <h3 className="text-sm font-semibold text-ink">All recipients</h3>
        <span className="text-xs tabular-nums text-slate-550">{rows.length}</span>
      </div>
      <div ref={shadowRef} className="scroll-shadow scroll-thin max-h-80 overflow-auto">
        <table className="table-soft w-full min-w-[40rem] text-sm">
          <thead className="sticky top-0 z-10">
            <tr className="text-left text-xs uppercase tracking-[0.06em]">
              {["Name", contactLabel, "Status", "Sent", "Received", "Opened", "Error"].map((h) => (
                <th key={h} scope="col" className="px-3 py-2 font-semibold text-slate-550 shadow-[inset_0_-1px_0_rgb(var(--c-line))]">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((it) => (
              <tr key={it.id} className="border-b border-line-subtle last:border-0">
                <td className="px-3 py-2">{it.name || "—"}</td>
                <td className="px-3 py-2 font-mono text-xs">{it.contact || "—"}</td>
                <td className="px-3 py-2">
                  <Badge tone={it.tone}>{it.status}</Badge>
                </td>
                <td className="whitespace-nowrap px-3 py-2 text-xs text-slate-550">{when(it.sentAt)}</td>
                <td className="whitespace-nowrap px-3 py-2 text-xs text-slate-550">{when(it.deliveredAt)}</td>
                <td className="whitespace-nowrap px-3 py-2 text-xs text-slate-550">{when(it.openedAt)}</td>
                <td className="px-3 py-2 text-xs text-slate-550">
                  <span className={`block max-w-[20rem] truncate ${it.status === "FAILED" ? "text-crit" : ""}`} title={it.error ?? undefined}>
                    {it.error || "—"}
                  </span>
                  {it.failedAt && <span className="block text-[11px] text-slate-550">{formatShortDateTime(it.failedAt)}</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function DetailLoading() {
  return (
    <div className="flex items-center gap-2 text-sm text-slate-550" role="status">
      <LoaderCircle size={16} aria-hidden="true" className="animate-spin motion-reduce:animate-none" />
      Loading recipients…
    </div>
  );
}

/* ------------------------------------------------------------------ CSV download */

/** RFC-4180 quoting: wrap in quotes and double any embedded quote when needed. */
function csvCell(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

function toCsv(headers: string[], rows: string[][]): string {
  return [headers, ...rows].map((r) => r.map(csvCell).join(",")).join("\r\n");
}

/** Save a text blob to the user's machine — no server round-trip. */
function downloadTextFile(filename: string, text: string) {
  // Leading BOM so Excel opens the file as UTF-8.
  const blob = new Blob(["﻿", text], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/**
 * "Download as CSV": an icon button with a tooltip (row actions), or a text button when `text` is given (the
 * failed-recipients panel). `buildCsv` returns the file body; the click is stopped from bubbling so it doesn't
 * also toggle the row's expanded panel.
 */
function DownloadCsvButton({
  filename,
  buildCsv,
  text,
}: {
  filename: string;
  buildCsv: () => Promise<string>;
  text?: string;
}) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const button = (
    <button
      type="button"
      aria-label={text ? undefined : "Download recipients as CSV"}
      className={text ? "btn-ghost h-9" : "btn-icon"}
      disabled={busy}
      onClick={async (e) => {
        e.stopPropagation();
        setBusy(true);
        try {
          downloadTextFile(filename, await buildCsv());
        } catch (err) {
          toast.fromError(err, "Could not build the download");
        } finally {
          setBusy(false);
        }
      }}
    >
      <Icon name="download" size={16} className={busy ? "animate-pulse" : undefined} />
      {text}
    </button>
  );
  return text ? button : <Tooltip label="Download recipients (CSV)">{button}</Tooltip>;
}

/* ================================================================== EMAIL TAB */

type EmailItemStatus = "PENDING" | "SENDING" | "SENT" | "FAILED" | "SKIPPED" | "CANCELLED"; // CANCELLED: hard stop only

type EmailBatchRow = BatchSummary;

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
    deliveredAt: string | null;
    openedAt: string | null;
    failedAt: string | null;
  }[];
}

const emailItemTone: Record<EmailItemStatus, BadgeTone> = {
  PENDING: "neutral",
  SENDING: "accent",
  SENT: "ok",
  FAILED: "crit",
  SKIPPED: "warn",
  CANCELLED: "neutral",
};

function fetchEmailBatches(status: "" | BatchStatus) {
  return api<{ items: EmailBatchRow[] }>(`/api/contacts/send/batches${status ? `?status=${status}` : ""}`);
}

function emailCsv(items: EmailBatchDetailView["items"]): string {
  return toCsv(
    ["Name", "Email", "Status", "Sent at", "Received at", "Opened at", "Failed at", "Error"],
    items.map((it) => [
      it.name ?? "",
      it.email,
      it.status,
      it.sentAt ?? "",
      it.deliveredAt ?? "",
      it.openedAt ?? "",
      it.failedAt ?? "",
      it.error ?? "",
    ]),
  );
}

function EmailQueue({ view, setView }: QueueViewProps) {
  const status = view.status as "" | BatchStatus;
  const hardStop = useHardStopEnabled();

  const q = useQuery({
    queryKey: ["email-batches", status],
    queryFn: () => fetchEmailBatches(status),
    // Live status: re-poll only while a batch on the page being viewed is still sending.
    refetchInterval: (query) =>
      visiblePage(query.state.data?.items ?? [], view).rows.some((b) => b.status === "RUNNING") ? 4000 : false,
  });

  return (
    <BatchQueue
      view={view}
      setView={setView}
      query={q}
      label="Email batches"
      stopScope="EMAIL_BATCH"
      empty={{
        title: "No email batches yet",
        body: "Bulk emails you send from the Contacts page show up here, with live progress.",
        cta: { to: "/contacts", label: "Go to Contacts" },
      }}
      actions={(b) => (
        <>
          {hardStop && b.status === "RUNNING" && (
            <RowHardStop scope="EMAIL_BATCH" id={b.id} invalidate={[["email-batches"], ["email-batch", b.id]]} />
          )}
          <DownloadCsvButton
            filename={`email-batch-${b.id.slice(0, 8)}.csv`}
            buildCsv={async () => emailCsv((await api<EmailBatchDetailView>(`/api/contacts/send/batches/${b.id}`)).items)}
          />
          <DeleteHistoryButton
            path={`/api/contacts/send/batches/${b.id}`}
            what={`email batch ${b.id.slice(0, 8)}`}
            blockedReason={b.status === "RUNNING" ? STILL_SENDING : null}
            refresh={[["email-batches"], ["send-queue-history-count", "email"]]}
            body={`Removes this batch and its ${plural(b.total, "recipient")} from the Send Queue and from "Download all history". This can't be undone. Contacts and Email Logs stay as they are.`}
          />
        </>
      )}
      detail={(b) => <EmailBatchDetail id={b.id} />}
    />
  );
}

/** "Retry failed": starts a new batch with only this batch's failed contacts (POST …/retry), after a confirmation. */
function RetryFailedEmails({ batchId, failed, running }: { batchId: string; failed: number; running: boolean }) {
  const qc = useQueryClient();
  const confirm = useConfirm();
  const toast = useToast();
  const retry = useMutation({
    mutationFn: () =>
      api<{ batchId: string }>(`/api/contacts/send/batches/${batchId}/retry`, {
        method: "POST",
        notify: `Retry started for ${plural(failed, "recipient")}`,
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["email-batches"] });
      void qc.invalidateQueries({ queryKey: ["send-queue-history-count", "email"] });
    },
    onError: (err) => toast.fromError(err, "Could not retry"),
  });
  return (
    <button
      type="button"
      className="btn-primary h-9"
      // Once started it stays off, so a second click can't queue the same recipients twice.
      disabled={running || retry.isPending || retry.isSuccess}
      onClick={async () => {
        const ok = await confirm({
          title: `Retry ${plural(failed, "failed recipient")}?`,
          body: "A new batch starts with only the recipients that failed, using the same email template. This batch stays in the history as it is.",
          confirmText: "Retry failed",
        });
        if (ok) retry.mutate();
      }}
    >
      <RotateCcw size={14} aria-hidden="true" />
      {retry.isPending ? "Starting…" : retry.isSuccess ? "Retry started" : "Retry failed"}
    </button>
  );
}

function EmailBatchDetail({ id }: { id: string }) {
  const q = useQuery({
    queryKey: ["email-batch", id],
    queryFn: () => api<EmailBatchDetailView>(`/api/contacts/send/batches/${id}`),
    refetchInterval: (query) => (query.state.data?.status === "RUNNING" ? 2000 : false),
  });

  if (q.isLoading) return <DetailLoading />;
  if (q.error || !q.data) return <ErrorNote error={q.error ?? new Error("Batch not found.")} />;

  const v = q.data;
  const cancelled = v.counts.CANCELLED ?? 0; // only present after a hard stop
  const done = v.counts.SENT + v.counts.FAILED + v.counts.SKIPPED + cancelled;
  const pct = v.total ? Math.round((done / v.total) * 100) : 100;
  const toGo = v.counts.PENDING + v.counts.SENDING;
  const failed = v.items.filter((it) => it.status === "FAILED");
  const running = v.status === "RUNNING";

  return (
    <div className="space-y-4">
      {v.status === "CANCELLED" && <HardStopDetailStatus scope="EMAIL_BATCH" id={id} />}
      {failed.length > 0 && (
        <FailedRecipients
          total={v.total}
          items={failed.map((it) => ({ id: it.id, contact: it.email, error: it.error }))}
          actions={
            <>
              <DownloadCsvButton text="Download failed" filename={`email-batch-${id.slice(0, 8)}-failed.csv`} buildCsv={async () => emailCsv(failed)} />
              <RetryFailedEmails batchId={id} failed={failed.length} running={running} />
            </>
          }
          note={running ? "Retry becomes available once this batch has finished sending." : undefined}
        />
      )}
      <DetailProgress
        pct={pct}
        barClass="bg-gradient-accent"
        stats={[
          { label: "sent", value: v.counts.SENT, tone: "text-ok" },
          { label: "failed", value: v.counts.FAILED, tone: "text-crit" },
          { label: "skipped", value: v.counts.SKIPPED, tone: "text-warn" },
          ...(cancelled > 0 ? [{ label: "cancelled", value: cancelled, tone: "text-ink" }] : []),
          ...(toGo > 0 ? [{ label: "to go", value: toGo, tone: "text-ink" }] : []),
        ]}
      />
      <RecipientsTable
        contactLabel="Email"
        rows={v.items.map((it) => ({
          id: it.id,
          name: it.name,
          contact: it.email,
          status: it.status,
          tone: emailItemTone[it.status],
          sentAt: it.sentAt,
          deliveredAt: it.deliveredAt,
          openedAt: it.openedAt,
          error: it.error,
          failedAt: it.failedAt,
        }))}
      />
    </div>
  );
}

/* =============================================================== WHATSAPP TAB */

type WaItemStatus = "QUEUED" | "SENDING" | "SENT" | "DELIVERED" | "READ" | "FAILED" | "SKIPPED" | "CANCELLED"; // CANCELLED: hard stop only

type WaBatchRow = BatchSummary;

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
    readAt: string | null;
    failedAt: string | null;
  }[];
}

const waItemTone: Record<WaItemStatus, BadgeTone> = {
  QUEUED: "neutral",
  SENDING: "accent",
  SENT: "ok",
  DELIVERED: "ok",
  READ: "ok",
  FAILED: "crit",
  SKIPPED: "warn",
  CANCELLED: "neutral",
};

function fetchWaBatches(status: "" | BatchStatus) {
  return api<{ items: WaBatchRow[] }>(`/api/whatsapp/send/batches${status ? `?status=${status}` : ""}`);
}

function waCsv(items: WaBatchDetailView["items"]): string {
  return toCsv(
    ["Name", "Phone", "Status", "Sent at", "Delivered at", "Opened at", "Failed at", "Error"],
    items.map((it) => [
      it.name ?? "",
      it.phone ?? "",
      it.status,
      it.sentAt ?? "",
      it.deliveredAt ?? "",
      it.readAt ?? "",
      it.failedAt ?? "",
      it.error ?? "",
    ]),
  );
}

function WhatsAppQueue({ view, setView }: QueueViewProps) {
  const status = view.status as "" | BatchStatus;
  const hardStop = useHardStopEnabled();

  const q = useQuery({
    queryKey: ["whatsapp-batches", status],
    queryFn: () => fetchWaBatches(status),
    // Live status: re-poll only while a batch on the page being viewed is still sending.
    refetchInterval: (query) =>
      visiblePage(query.state.data?.items ?? [], view).rows.some((b) => b.status === "RUNNING") ? 4000 : false,
  });

  return (
    <BatchQueue
      view={view}
      setView={setView}
      query={q}
      label="WhatsApp batches"
      stopScope="WHATSAPP_BATCH"
      empty={{
        title: "No WhatsApp batches yet",
        body: "WhatsApp sends started from the Contacts or WhatsApp Contacts page show up here.",
        cta: { to: "/whatsapp-contacts", label: "Go to WhatsApp Contacts" },
      }}
      actions={(b) => (
        <>
          {hardStop && b.status === "RUNNING" && (
            <RowHardStop scope="WHATSAPP_BATCH" id={b.id} invalidate={[["whatsapp-batches"], ["whatsapp-batch", b.id]]} />
          )}
          <DownloadCsvButton
            filename={`whatsapp-batch-${b.id.slice(0, 8)}.csv`}
            buildCsv={async () => waCsv((await api<WaBatchDetailView>(`/api/whatsapp/send/batches/${b.id}`)).items)}
          />
          <DeleteHistoryButton
            path={`/api/whatsapp/send/batches/${b.id}`}
            what={`WhatsApp batch ${b.id.slice(0, 8)}`}
            blockedReason={b.status === "RUNNING" ? STILL_SENDING : null}
            refresh={[["whatsapp-batches"], ["send-queue-history-count", "whatsapp"]]}
            body={`Removes this batch and its ${plural(b.total, "message")} from the Send Queue, from "Download all history" and from the WhatsApp Inbox conversations. These numbers no longer count as already sent. This can't be undone. Contacts, templates and customer replies stay as they are.`}
          />
        </>
      )}
      detail={(b) => <WhatsAppBatchDetail id={b.id} />}
    />
  );
}

function WhatsAppBatchDetail({ id }: { id: string }) {
  const q = useQuery({
    queryKey: ["whatsapp-batch", id],
    queryFn: () => api<WaBatchDetailView>(`/api/whatsapp/send/batches/${id}`),
    refetchInterval: (query) => (query.state.data?.status === "RUNNING" ? 2000 : false),
  });

  if (q.isLoading) return <DetailLoading />;
  if (q.error || !q.data) return <ErrorNote error={q.error ?? new Error("Batch not found.")} />;

  const v = q.data;
  const cancelled = v.counts.CANCELLED ?? 0; // only present after a hard stop
  const done = v.counts.SENT + v.counts.DELIVERED + v.counts.READ + v.counts.FAILED + v.counts.SKIPPED + cancelled;
  const pct = v.total ? Math.round((done / v.total) * 100) : 100;
  const toGo = v.counts.QUEUED + v.counts.SENDING;
  const failed = v.items.filter((it) => it.status === "FAILED");

  return (
    <div className="space-y-4">
      {v.status === "CANCELLED" && <HardStopDetailStatus scope="WHATSAPP_BATCH" id={id} />}
      {failed.length > 0 && (
        <FailedRecipients
          total={v.total}
          items={failed.map((it) => ({ id: it.id, contact: it.phone || "—", error: it.error }))}
          actions={
            <DownloadCsvButton text="Download failed" filename={`whatsapp-batch-${id.slice(0, 8)}-failed.csv`} buildCsv={async () => waCsv(failed)} />
          }
          note={
            <>
              WhatsApp batches can't be retried from here. Download the failed numbers, fix them, and send again from{" "}
              <Link to="/whatsapp-contacts" className="font-medium text-accent-ink underline-offset-2 hover:underline">
                WhatsApp Contacts
              </Link>
              .
            </>
          }
        />
      )}
      <DetailProgress
        pct={pct}
        barClass="bg-wa"
        stats={[
          { label: "sent", value: v.counts.SENT + v.counts.DELIVERED + v.counts.READ, tone: "text-ok" },
          { label: "failed", value: v.counts.FAILED, tone: "text-crit" },
          { label: "skipped", value: v.counts.SKIPPED, tone: "text-warn" },
          ...(cancelled > 0 ? [{ label: "cancelled", value: cancelled, tone: "text-ink" }] : []),
          ...(toGo > 0 ? [{ label: "to go", value: toGo, tone: "text-ink" }] : []),
        ]}
      />
      <RecipientsTable
        contactLabel="Phone"
        rows={v.items.map((it) => ({
          id: it.id,
          name: it.name,
          contact: it.phone,
          status: it.status,
          tone: waItemTone[it.status],
          sentAt: it.sentAt,
          deliveredAt: it.deliveredAt,
          openedAt: it.readAt,
          error: it.error,
          failedAt: it.failedAt,
        }))}
      />
    </div>
  );
}
