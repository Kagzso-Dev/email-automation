import { useMemo, useState } from "react";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../../lib/api";
import {
  ago,
  DM_MAX_BYTES,
  DM_MAX_RECIPIENTS,
  timeLeft,
  utf8Bytes,
  type Conversations,
  type DmHistoryPage,
  type DmPreview,
  type DmRecipient,
  type DmSendResult,
  type WindowState,
} from "../../lib/automation";
import { formatDateTime } from "../../lib/schedule";
import { useToast } from "../toast";
import { Badge, EmptyState, ErrorNote, Modal, Spinner, Table, Tabs, type BadgeTone } from "../ui";
import { BRAND_COLOR } from "./BrandIcons";

// Instagram DM composer (Automation, ENABLE_AUTOMATION). Recipients are the account's existing conversations
// (Instagram only allows messaging people who wrote first). Each shows its window: inside 24 h a message can be sent;
// 24 h – 7 days only as a one-to-one human-agent reply (when Meta approved it); after that, not at all. Nothing is
// sent until "Review" shows how many recipients will get it and "Send to N" is clicked. The API checks it all again.

const WINDOW_BADGE: Record<WindowState, { tone: BadgeTone; label: string }> = {
  open: { tone: "ok", label: "Within 24 h" },
  human_agent: { tone: "warn", label: "Human agent only" },
  closed: { tone: "crit", label: "Window closed" },
  no_inbound: { tone: "neutral", label: "Hasn't messaged you" },
};

const DM_STATUS_TONE: Record<string, BadgeTone> = { sent: "ok", failed: "crit", blocked: "warn" };

type Step = { kind: "compose" } | { kind: "confirm"; preview: DmPreview } | { kind: "done"; result: DmSendResult };

export function DmComposer({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [tab, setTab] = useState<"compose" | "history">("compose");
  return (
    <Modal open={open} onClose={onClose} title="Instagram direct message" wide>
      <Tabs
        idPrefix="ig-dm"
        ariaLabel="Direct message"
        tabs={[
          { value: "compose", label: "Compose" },
          { value: "history", label: "History" },
        ]}
        value={tab}
        onChange={setTab}
      />
      <div id="ig-dm-panel" role="tabpanel" aria-labelledby={`ig-dm-tab-${tab}`}>
        {open && (tab === "compose" ? <Compose onSent={() => undefined} /> : <History />)}
      </div>
    </Modal>
  );
}

function selectable(r: DmRecipient, humanAgentEnabled: boolean) {
  return r.window === "open" || (r.window === "human_agent" && humanAgentEnabled);
}

function Compose({ onSent }: { onSent: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [search, setSearch] = useState("");
  const [picked, setPicked] = useState<string[]>([]);
  const [message, setMessage] = useState("");
  const [humanAgent, setHumanAgent] = useState(false);
  const [step, setStep] = useState<Step>({ kind: "compose" });

  const convs = useQuery({
    queryKey: ["automation", "instagram", "conversations"],
    queryFn: () => api<Conversations>("/api/automation/instagram/conversations"),
    staleTime: 30_000,
  });
  const humanAgentEnabled = !!convs.data?.humanAgentEnabled;
  const recipients = convs.data?.recipients ?? [];
  const shown = useMemo(() => {
    const q = search.trim().toLowerCase().replace(/^@/, "");
    return q ? recipients.filter((r) => (r.username ?? r.recipientId).toLowerCase().includes(q)) : recipients;
  }, [recipients, search]);
  const pickedRows = recipients.filter((r) => picked.includes(r.recipientId));
  const onlyHumanAgent = pickedRows.length === 1 && pickedRows[0]!.window === "human_agent";
  const bytes = utf8Bytes(message.trim());
  const tooLong = bytes > DM_MAX_BYTES;

  const toggle = (id: string) =>
    setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : p.length >= DM_MAX_RECIPIENTS ? p : [...p, id]));

  const body = () => ({ recipientIds: picked, message: message.trim(), useHumanAgentTag: onlyHumanAgent && humanAgent });

  const preview = useMutation({
    mutationFn: () => api<DmPreview>("/api/automation/instagram/dm/preview", { method: "POST", json: body(), notify: false }),
    onSuccess: (p) => setStep({ kind: "confirm", preview: p }),
  });
  const send = useMutation({
    mutationFn: (p: DmPreview) =>
      api<DmSendResult>("/api/automation/instagram/dm", {
        method: "POST",
        json: { ...body(), confirmToken: p.confirmToken, confirmCount: p.sendable },
        notify: false,
      }),
    onSuccess: (r) => {
      setStep({ kind: "done", result: r });
      void qc.invalidateQueries({ queryKey: ["automation", "instagram", "dm-history"] });
      if (r.sent > 0) toast.success(`Sent to ${r.sent} recipient${r.sent === 1 ? "" : "s"}`, r.failed + r.blocked > 0 ? [`${r.failed} failed, ${r.blocked} blocked — see History.`] : undefined);
      else toast.error("Nothing was sent", ["See the list below and History."]);
      onSent();
    },
  });

  if (step.kind === "confirm") {
    const p = step.preview;
    const ok = p.recipients.filter((r) => r.allowed);
    const blocked = p.recipients.filter((r) => !r.allowed);
    return (
      <div className="space-y-4 text-sm">
        <div className="rounded-xl border border-line bg-surface-muted p-4">
          <div className="text-base font-semibold text-ink" role="status">
            {p.sendable > 0 ? `Send to ${p.sendable} recipient${p.sendable === 1 ? "" : "s"}?` : "No one can be sent this message"}
          </div>
          <p className="mt-1 text-slate-550">
            {p.sendable > 0
              ? "This sends now, from your Instagram account. It can't be undone."
              : "Every recipient is outside the window Instagram allows."}
            {blocked.length > 0 ? ` ${blocked.length} won't get it (below).` : ""}
          </p>
        </div>
        <blockquote className="whitespace-pre-wrap rounded-lg border-l-4 bg-surface px-3 py-2 text-ink" style={{ borderColor: BRAND_COLOR.instagram }}>
          {message.trim()}
        </blockquote>
        {ok.length > 0 && (
          <div>
            <div className="label">Will receive it ({ok.length})</div>
            <div className="flex flex-wrap gap-1.5">
              {ok.map((r) => (
                <Badge key={r.recipientId} tone="ok">
                  @{r.username ?? r.recipientId}
                  {r.tag ? " · human agent" : ""}
                </Badge>
              ))}
            </div>
          </div>
        )}
        {blocked.length > 0 && (
          <div>
            <div className="label">Blocked ({blocked.length})</div>
            <ul className="space-y-1">
              {blocked.map((r) => (
                <li key={r.recipientId} className="text-slate-550">
                  <span className="font-medium text-ink">@{r.username ?? r.recipientId}</span> — {r.reasonText}
                </li>
              ))}
            </ul>
          </div>
        )}
        {send.error ? <ErrorNote error={send.error} /> : null}
        <div className="flex justify-end gap-2">
          <button type="button" className="btn-ghost" onClick={() => setStep({ kind: "compose" })} disabled={send.isPending}>
            Back
          </button>
          <button
            type="button"
            className="btn text-white"
            style={{ backgroundColor: BRAND_COLOR.instagram }}
            disabled={p.sendable === 0 || !p.confirmToken || send.isPending}
            onClick={() => send.mutate(p)}
          >
            {send.isPending ? "Sending…" : `Send to ${p.sendable}`}
          </button>
        </div>
      </div>
    );
  }

  if (step.kind === "done") {
    const r = step.result;
    return (
      <div className="space-y-4 text-sm">
        <div className="grid grid-cols-3 gap-3" aria-label="Send result">
          {(["sent", "failed", "blocked"] as const).map((k) => (
            <div key={k} className="rounded-lg border border-line px-3 py-2">
              <div className="text-xs capitalize text-slate-550">{k}</div>
              <div className="text-xl font-semibold text-ink">{r[k]}</div>
            </div>
          ))}
        </div>
        <ul className="space-y-1">
          {r.results.map((x) => (
            <li key={x.recipientId} className="flex items-start gap-2">
              <Badge tone={DM_STATUS_TONE[x.status]}>{x.status}</Badge>
              <span className="font-medium text-ink">@{x.username ?? x.recipientId}</span>
              {x.error ? <span className="text-slate-550">— {x.error}</span> : null}
            </li>
          ))}
        </ul>
        <div className="flex justify-end">
          <button
            type="button"
            className="btn-ghost"
            onClick={() => {
              setPicked([]);
              setMessage("");
              setHumanAgent(false);
              preview.reset();
              send.reset();
              setStep({ kind: "compose" });
            }}
          >
            New message
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4 text-sm">
      <div className="rounded-lg border border-line bg-surface-muted px-3 py-2 text-[13px] leading-[1.5] text-slate-550">
        Instagram only allows messages to people who messaged your account, and only <b className="text-ink">within 24 hours</b> of their last
        message. After that, {humanAgentEnabled ? "a one-to-one human-agent reply is allowed for up to 7 days" : "nothing can be sent (human-agent replies aren't enabled)"}.
      </div>

      <div>
        <div className="mb-1.5 flex items-center justify-between">
          <span className="label mb-0">Recipients</span>
          <span className="text-xs text-slate-550">
            {picked.length} selected · up to {DM_MAX_RECIPIENTS}
          </span>
        </div>
        <input className="input mb-2" placeholder="Search @username" aria-label="Search recipients" value={search} onChange={(e) => setSearch(e.target.value)} />
        {convs.isLoading ? (
          <Spinner />
        ) : convs.error ? (
          <ErrorNote error={convs.error} />
        ) : recipients.length === 0 ? (
          <EmptyState icon="inbox" title="No conversations yet">
            When someone messages your Instagram account, they show up here.
          </EmptyState>
        ) : (
          <ul className="scroll-thin max-h-64 overflow-y-auto rounded-lg border border-line" aria-label="Recipients">
            {shown.map((r) => {
              const can = selectable(r, humanAgentEnabled);
              const badge = WINDOW_BADGE[r.window];
              const left = timeLeft(r.windowEndsAt);
              return (
                <li key={r.recipientId} className="border-b border-line-subtle last:border-0">
                  <label className={`flex items-center gap-3 px-3 py-2 ${can ? "cursor-pointer hover:bg-tint" : "cursor-not-allowed opacity-60"}`}>
                    <input
                      type="checkbox"
                      checked={picked.includes(r.recipientId)}
                      disabled={!can}
                      onChange={() => toggle(r.recipientId)}
                      aria-label={`@${r.username ?? r.recipientId}`}
                    />
                    <span className="min-w-0 flex-1 truncate font-medium text-ink">@{r.username ?? r.recipientId}</span>
                    <span className="hidden text-xs text-slate-550 sm:inline">last message {ago(r.lastInboundAt)}</span>
                    <Badge tone={badge.tone}>
                      {badge.label}
                      {left ? ` · ${left}` : ""}
                    </Badge>
                  </label>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {onlyHumanAgent && (
        <label className="flex items-start gap-2 rounded-lg border border-warn/40 bg-warn-soft px-3 py-2 text-[13px] text-ink">
          <input type="checkbox" className="mt-0.5" checked={humanAgent} onChange={(e) => setHumanAgent(e.target.checked)} />
          <span>
            Reply as a human agent (HUMAN_AGENT tag). Only for a person on your team answering this customer personally — not for promotions.
          </span>
        </label>
      )}

      <div>
        <label className="label" htmlFor="ig-dm-message">
          Message
        </label>
        <textarea id="ig-dm-message" className="input min-h-[110px]" value={message} onChange={(e) => setMessage(e.target.value)} />
        <div className={`mt-1 text-right text-xs ${tooLong ? "text-crit" : "text-slate-550"}`}>
          {bytes} / {DM_MAX_BYTES} bytes
        </div>
      </div>

      {preview.error ? <ErrorNote error={preview.error} /> : null}
      <div className="flex justify-end">
        <button
          type="button"
          className="btn text-white"
          style={{ backgroundColor: BRAND_COLOR.instagram }}
          disabled={picked.length === 0 || !message.trim() || tooLong || preview.isPending}
          onClick={() => preview.mutate()}
        >
          {preview.isPending ? "Checking…" : `Review (${picked.length})`}
        </button>
      </div>
    </div>
  );
}

function History() {
  const [page, setPage] = useState(1);
  const q = useQuery({
    queryKey: ["automation", "instagram", "dm-history", page],
    queryFn: () => api<DmHistoryPage>(`/api/automation/instagram/dm/history?page=${page}`),
    placeholderData: keepPreviousData,
  });
  if (q.isLoading) return <Spinner />;
  if (q.error) return <ErrorNote error={q.error} />;
  if (!q.data?.items.length) {
    return (
      <EmptyState icon="inbox" title="No messages sent yet">
        Every send is logged here — sent, failed and blocked.
      </EmptyState>
    );
  }
  const pages = Math.max(1, Math.ceil(q.data.total / q.data.pageSize));
  return (
    <>
      <Table head={["When", "Recipient", "Message", "Status", "By"]}>
        {q.data.items.map((r) => (
          <tr key={r.id} className="border-b border-line-subtle align-top last:border-0">
            <td className="whitespace-nowrap px-4 py-3 text-xs">{formatDateTime(r.createdAt)}</td>
            <td className="px-4 py-3 font-medium text-ink">@{r.recipientName ?? r.recipientId}</td>
            <td className="max-w-xs px-4 py-3 text-xs" title={r.message}>
              <span className="line-clamp-2">{r.message}</span>
              {r.messageTag ? <span className="mt-1 block text-slate-550">Tag: {r.messageTag}</span> : null}
            </td>
            <td className="px-4 py-3">
              <Badge tone={DM_STATUS_TONE[r.status] ?? "neutral"}>{r.status}</Badge>
              {r.errorMessage ? <div className="mt-1 max-w-[16rem] text-xs text-slate-550">{r.errorMessage}</div> : null}
            </td>
            <td className="px-4 py-3 text-xs">{r.sentByEmail}</td>
          </tr>
        ))}
      </Table>
      <div className="mt-3 flex items-center justify-between text-sm text-slate-550">
        <span>
          {q.data.total} recipient{q.data.total === 1 ? "" : "s"} logged
        </span>
        <div className="flex gap-2">
          <button className="btn-ghost" disabled={page <= 1} onClick={() => setPage(page - 1)}>
            Prev
          </button>
          <span className="px-2 py-2">
            {page} / {pages}
          </span>
          <button className="btn-ghost" disabled={page >= pages} onClick={() => setPage(page + 1)}>
            Next
          </button>
        </div>
      </div>
    </>
  );
}
