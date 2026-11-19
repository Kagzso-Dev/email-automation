import { useEffect, useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";
import { useImportFilterStepState } from "../lib/importFilter";
import { fullNumber } from "../lib/numberFormat";
import { formatDateTime } from "../lib/schedule";
import { channelLabel, describeFilters, downloadExcludedRows, type UploadHistoryItem, type UploadHistoryPage as Page } from "../lib/uploadHistory";
import { PageHeader } from "../components/Layout";
import { useToast } from "../components/toast";
import { EmptyState, ErrorNote, Modal, Spinner, Table } from "../components/ui";

// Upload History (ENABLE_IMPORT_FILTER_STEP): every confirmed import from the import filter step on WhatsApp
// Contacts and Voicecall Contact, newest first. Read-only. Admins and editors see every upload.

const PAGE_SIZE = 25;
const n = (v: number) => fullNumber.format(v);

function useDebounced<T>(value: T, ms: number): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const t = window.setTimeout(() => setSettled(value), ms);
    return () => window.clearTimeout(t);
  }, [value, ms]);
  return settled;
}

export function UploadHistoryPage() {
  const flag = useImportFilterStepState();
  if (flag.loading) return <Spinner />;
  if (!flag.enabled) {
    return (
      <div>
        <PageHeader title="Upload History" />
        <EmptyState icon="activity" title="Not available">
          Upload history is part of the import filter step, which is turned off (ENABLE_IMPORT_FILTER_STEP).
        </EmptyState>
      </div>
    );
  }
  return <HistoryList />;
}

function HistoryList() {
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [openId, setOpenId] = useState<string | null>(null);
  const settled = useDebounced(search.trim(), 300);
  useEffect(() => setPage(1), [settled]);

  const list = useQuery({
    queryKey: ["upload-history", settled, page],
    queryFn: () => {
      const p = new URLSearchParams({ page: String(page), pageSize: String(PAGE_SIZE) });
      if (settled) p.set("search", settled);
      return api<Page>(`/api/upload-history?${p}`);
    },
    placeholderData: keepPreviousData,
  });
  const pages = Math.max(1, Math.ceil((list.data?.total ?? 0) / PAGE_SIZE));

  return (
    <div>
      <PageHeader
        title="Upload History"
        subtitle="Every import confirmed in the import filter step (WhatsApp Contacts, Voicecall Contact), newest first. Each upload is kept for 30 days, then deleted."
      />
      <div className="mb-4">
        <input
          className="input sm:max-w-xs"
          placeholder="Search file name"
          aria-label="Search file name"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>
      {list.isLoading ? (
        <Spinner />
      ) : list.error ? (
        <ErrorNote error={list.error} />
      ) : !list.data?.items.length ? (
        <EmptyState icon="activity" title={settled ? "No uploads match" : "No uploads yet"}>
          {settled ? "Try another file name." : "Imports confirmed with “Import N selected” appear here."}
        </EmptyState>
      ) : (
        <>
          <Table
            head={[
              "File name",
              "Uploaded at",
              "Uploaded by",
              "Channel / page",
              "Total rows",
              "Imported",
              "Excluded (already used)",
              "Filtered out",
              "Duplicates",
              "Failed",
              "Filters used",
            ]}
          >
            {list.data.items.map((u) => {
              const lines = describeFilters(u.filters);
              return (
                <tr
                  key={u.id}
                  className="cursor-pointer border-b border-line-subtle align-top last:border-0 hover:bg-tint"
                  onClick={() => setOpenId(u.id)}
                >
                  <td className="px-4 py-3">
                    <button type="button" className="font-medium text-ink hover:underline" onClick={() => setOpenId(u.id)}>
                      {u.fileName}
                    </button>
                  </td>
                  <td className="whitespace-nowrap px-4 py-3 text-xs">{formatDateTime(u.createdAt)}</td>
                  <td className="px-4 py-3 text-xs">{u.uploadedByEmail}</td>
                  <td className="px-4 py-3 text-xs">{channelLabel(u.channel, u.language)}</td>
                  <td className="px-4 py-3 font-mono">{n(u.totalRows)}</td>
                  <td className="px-4 py-3 font-mono">{n(u.imported)}</td>
                  <td className="px-4 py-3 font-mono">{n(u.excludedUsed)}</td>
                  <td className="px-4 py-3 font-mono">{n(u.filteredOut)}</td>
                  <td className="px-4 py-3 font-mono">{n(u.duplicates)}</td>
                  <td className="px-4 py-3 font-mono">{n(u.failed)}</td>
                  <td className="max-w-xs px-4 py-3 text-xs" title={lines.join("\n")}>
                    {lines.slice(0, 2).join(" · ")}
                    {lines.length > 2 ? " …" : ""}
                  </td>
                </tr>
              );
            })}
          </Table>
          <div className="mt-3 flex items-center justify-between text-sm text-slate-550">
            <span>
              {n(list.data.total)} upload{list.data.total === 1 ? "" : "s"}
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
      )}
      <UploadDetail id={openId} onClose={() => setOpenId(null)} />
    </div>
  );
}

function Count({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex flex-col-reverse rounded-lg border border-line px-3 py-2">
      <dt className="text-xs text-slate-550">{label}</dt>
      <dd className="text-xl font-semibold text-ink">{n(value)}</dd>
    </div>
  );
}

function UploadDetail({ id, onClose }: { id: string | null; onClose: () => void }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const detail = useQuery({
    queryKey: ["upload-history", "detail", id],
    queryFn: () => api<UploadHistoryItem>(`/api/upload-history/${encodeURIComponent(id!)}`),
    enabled: !!id,
  });
  const u = detail.data;
  const download = async () => {
    if (!u) return;
    setBusy(true);
    try {
      await downloadExcludedRows(u.id);
    } catch (err) {
      toast.fromError(err, "Download failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open={!!id} onClose={onClose} title={u ? u.fileName : "Upload"} wide>
      {detail.isLoading ? (
        <Spinner />
      ) : detail.error ? (
        <ErrorNote error={detail.error} />
      ) : u ? (
        <div className="space-y-4 text-sm">
          <p className="text-slate-550">
            {channelLabel(u.channel, u.language)} · {formatDateTime(u.createdAt)} · {u.uploadedByEmail}
          </p>
          <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4" aria-label="Upload counts">
            <Count label="Total rows" value={u.totalRows} />
            <Count label="Imported" value={u.imported} />
            <Count label="Excluded (already used)" value={u.excludedUsed} />
            <Count label="Filtered out" value={u.filteredOut} />
            <Count label="Duplicates" value={u.duplicates} />
            <Count label="Failed" value={u.failed} />
            {u.skippedOverLimit > 0 && <Count label="Skipped due to limit" value={u.skippedOverLimit} />}
          </dl>
          <div>
            <h3 className="mb-1 text-xs font-medium text-slate-550">Filters and exclusion options used</h3>
            <ul className="list-disc space-y-0.5 pl-5">
              {describeFilters(u.filters).map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2 border-t border-line pt-3">
            <span className="text-xs text-slate-550">
              {u.excludedRows === 0
                ? "No rows were excluded as already used."
                : u.excludedAvailable
                  ? `${n(u.excludedRows)} excluded rows. This upload is deleted on ${formatDateTime(u.excludedExpiresAt)}.`
                  : `The ${n(u.excludedRows)} excluded rows were deleted after 30 days.`}
            </span>
            <button type="button" className="btn-primary" disabled={!u.excludedAvailable || busy} onClick={() => void download()}>
              {busy ? "Downloading…" : "Download excluded rows"}
            </button>
          </div>
        </div>
      ) : null}
    </Modal>
  );
}
