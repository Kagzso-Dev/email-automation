import { useState } from "react";
import { downloadMediaFile, formatBytes, useMediaObjectUrl, type MediaView } from "../lib/whatsappMedia";
import { Icon } from "./icons";
import { Modal } from "./ui";

/**
 * One WhatsApp media item: image preview, video / audio player, or a document
 * card with Download. Pending downloads, failures and unknown types render as a
 * small note instead of breaking the surrounding layout.
 */
export function WhatsAppMedia({
  media,
  compact = false,
  zoomable = false,
}: {
  media: MediaView;
  compact?: boolean;
  /** Images open full size in a dialog when clicked. */
  zoomable?: boolean;
}) {
  const { url, error } = useMediaObjectUrl(media);
  const [dlError, setDlError] = useState<string | null>(null);
  const [zoomed, setZoomed] = useState(false);
  const label = media.filename ?? media.kind;

  if (media.status === "PENDING") return <Note>Downloading {media.kind}…</Note>;
  if (media.status === "EXPIRED") return <Note tone="warn">{cap(media.kind)} expired on WhatsApp's side — ask the customer to send it again.</Note>;
  if (media.status === "FAILED") return <Note tone="crit">{cap(media.kind)} couldn't be saved{media.error ? `: ${media.error}` : ""}</Note>;
  if (error) return <Note tone="crit">{error}</Note>;

  const download = (
    <button
      type="button"
      className="inline-flex items-center gap-1 text-xs text-accent-ink hover:underline"
      onClick={() => downloadMediaFile(media).catch((e: Error) => setDlError(e.message))}
    >
      <Icon name="download" size={12} />
      Download
    </button>
  );
  const mime = media.mimeType ?? "";
  const max = compact ? "max-h-40" : "max-h-72";

  let body;
  if ((media.kind === "image" || media.kind === "sticker") && /^image\/(jpeg|png|webp)$/.test(mime)) {
    body = url ? (
      zoomable && media.kind === "image" ? (
        <>
          <button type="button" className="block cursor-zoom-in" onClick={() => setZoomed(true)} aria-label={`Enlarge ${label}`}>
            <img src={url} alt={label} className={`${max} max-w-full rounded-lg object-contain`} />
          </button>
          <Modal open={zoomed} onClose={() => setZoomed(false)} title={label} wide>
            <img src={url} alt={label} className="mx-auto max-h-[70vh] max-w-full object-contain" />
          </Modal>
        </>
      ) : (
        <img src={url} alt={label} className={`${max} max-w-full rounded-lg object-contain`} />
      )
    ) : (
      <Note>Loading image…</Note>
    );
  } else if (media.kind === "video" && /^video\//.test(mime)) {
    body = url ? <video src={url} controls preload="metadata" className={`${max} max-w-full rounded-lg`} /> : <Note>Loading video…</Note>;
  } else if (media.kind === "audio" && /^audio\//.test(mime)) {
    body = url ? <audio src={url} controls preload="metadata" className="w-64 max-w-full" /> : <Note>Loading audio…</Note>;
  } else {
    body = (
      <div className="flex items-center gap-3 rounded-lg border border-line bg-white px-3 py-2">
        <Icon name="templates" size={18} className="shrink-0 text-slate-550" />
        <div className="min-w-0">
          <div className="truncate text-sm font-medium" title={label}>
            {label}
          </div>
          <div className="text-xs text-slate-550">
            {[mime ? mime.split("/").pop()?.toUpperCase() : null, formatBytes(media.sizeBytes)].filter(Boolean).join(" · ")}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-1">
      {body}
      <div className="flex items-center gap-2">
        {download}
        {dlError && <span className="text-xs text-crit">{dlError}</span>}
      </div>
    </div>
  );
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

function Note({ children, tone }: { children: React.ReactNode; tone?: "warn" | "crit" }) {
  return <div className={`text-xs ${tone === "crit" ? "text-crit" : tone === "warn" ? "text-warn" : "text-slate-550"}`}>{children}</div>;
}
