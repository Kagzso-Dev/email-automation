import { DownloadAllHistoryButton } from "./DownloadAllHistory";
import { FilterNewDataButton } from "./FilterNewData";
import type { HistoryChannel } from "../lib/historyFilter";
import type { HistoryExportChannel } from "../lib/sendQueueHistory";

/**
 * Send Queue toolbar actions, side by side at the right of the Status row:
 * [Upload new file] [Download all history]. Layout only — each button keeps its own behaviour.
 */
export function QueueActions({ upload, history }: { upload: HistoryChannel; history: HistoryExportChannel }) {
  return (
    <div className="queue-actions">
      <FilterNewDataButton channel={upload} />
      <DownloadAllHistoryButton channel={history} />
    </div>
  );
}
