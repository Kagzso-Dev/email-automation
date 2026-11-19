import { DownloadAllHistoryButton } from "./DownloadAllHistory";
import { FilterNewDataButton } from "./FilterNewData";
import type { HistoryChannel } from "../lib/historyFilter";
import type { HistoryExportChannel } from "../lib/sendQueueHistory";

/**
 * Send Queue header actions for the open tab: [Upload new file] (primary) [Download all history] (secondary).
 * Rendered inside the header's flex row. On phones Upload takes its own full-width row and Download shares the
 * next row with the "More" menu. Layout only: each button keeps its own behaviour.
 */
export function QueueActions({ upload, history }: { upload: HistoryChannel; history: HistoryExportChannel }) {
  return (
    <>
      <FilterNewDataButton channel={upload} className="max-sm:basis-full" />
      <DownloadAllHistoryButton channel={history} className="max-sm:flex-1" />
    </>
  );
}
