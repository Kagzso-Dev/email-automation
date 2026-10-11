import { useState } from "react";
import { Icon } from "./icons";
import { useToast } from "./toast";
import { downloadHistoryExport, useHistoryExportCount, type HistoryExportChannel } from "../lib/sendQueueHistory";

/**
 * Send Queue status row → "Download all history": the complete history of this
 * tab's channel as one CSV, regardless of the Status filter, page or page size.
 */
export function DownloadAllHistoryButton({ channel }: { channel: HistoryExportChannel }) {
  const toast = useToast();
  const count = useHistoryExportCount(channel);
  const [busy, setBusy] = useState(false);
  const empty = count.data?.rows === 0;

  return (
    <button
      type="button"
      className="btn-ghost"
      disabled={busy || empty}
      aria-busy={busy}
      aria-label={busy ? "Preparing history download" : "Download all history"}
      title={empty ? "No history to download yet" : "Every batch on this tab as one CSV — ignores the Status filter and pages"}
      onClick={async () => {
        setBusy(true);
        try {
          await downloadHistoryExport(channel);
        } catch (err) {
          toast.error("Could not download the history", [err instanceof Error ? err.message : "Something went wrong — try again."]);
        } finally {
          setBusy(false);
        }
      }}
    >
      <Icon name="download" size={16} className={busy ? "animate-pulse" : undefined} />
      {/* Icon-only on phones so the Status row keeps its one-line layout. */}
      <span className="hidden sm:inline">{busy ? "Preparing…" : "Download all history"}</span>
    </button>
  );
}
