import { useEffect, useState } from "react";
import { getAccessToken } from "./api";

/** A stored WhatsApp media file as the API returns it (no paths, no provider ids). */
export interface MediaView {
  id: string;
  kind: "image" | "video" | "audio" | "document" | "sticker" | string;
  status: "PENDING" | "STORED" | "FAILED" | "EXPIRED";
  mimeType: string | null;
  filename: string | null;
  sizeBytes: number | null;
  error: string | null;
}

/** File-picker `accept` values per kind (Meta's supported types). */
export const ACCEPT = {
  image: ".jpg,.jpeg,.png,image/jpeg,image/png",
  video: ".mp4,.3gp,video/mp4,video/3gpp",
  audio: ".aac,.amr,.mp3,.m4a,.ogg,audio/aac,audio/amr,audio/mpeg,audio/mp4,audio/ogg",
  document: ".pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.txt",
  sticker: ".webp,image/webp",
} as const;
export const ACCEPT_ANY = Object.values(ACCEPT).join(",");

export function formatBytes(n: number | null | undefined): string {
  if (!n) return "";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

const fileUrl = (id: string, download = false) => `/api/whatsapp/media/${id}/file${download ? "?download=1" : ""}`;

async function fetchMedia(id: string, download = false): Promise<Blob> {
  const token = getAccessToken();
  const res = await fetch(fileUrl(id, download), {
    credentials: "include",
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  if (!res.ok) throw new Error(res.status === 403 ? "Only admins can open customer files" : `Couldn't load the file (${res.status})`);
  return res.blob();
}

/**
 * An object URL for a stored file (images / video / audio previews). The
 * endpoint needs the bearer token, so it can't be a plain <img src>.
 */
export function useMediaObjectUrl(media: MediaView | null | undefined) {
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const id = media?.status === "STORED" ? media.id : null;
  useEffect(() => {
    if (!id) return;
    let alive = true;
    let objectUrl: string | null = null;
    setError(null);
    fetchMedia(id)
      .then((blob) => {
        if (!alive) return;
        objectUrl = URL.createObjectURL(blob);
        setUrl(objectUrl);
      })
      .catch((e: Error) => alive && setError(e.message));
    return () => {
      alive = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      setUrl(null);
    };
  }, [id]);
  return { url, error };
}

/** Save a stored file to the user's machine. */
export async function downloadMediaFile(media: MediaView) {
  const blob = await fetchMedia(media.id, true);
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = media.filename ?? `${media.kind}`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/**
 * Multipart upload with progress (XMLHttpRequest — fetch has no upload
 * progress). Resolves with the JSON body; rejects with the API's error message.
 */
export function uploadWithProgress<T>(
  method: "POST" | "PUT",
  path: string,
  form: FormData,
  onProgress?: (pct: number) => void,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open(method, path);
    xhr.withCredentials = true;
    const token = getAccessToken();
    if (token) xhr.setRequestHeader("Authorization", `Bearer ${token}`);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && onProgress) onProgress(Math.round((e.loaded / e.total) * 100));
    };
    xhr.onload = () => {
      let body: unknown = null;
      try {
        body = xhr.responseText ? JSON.parse(xhr.responseText) : null;
      } catch {
        /* non-JSON */
      }
      if (xhr.status >= 200 && xhr.status < 300) resolve(body as T);
      else if (xhr.status === 502 && body) resolve(body as T); // reply recorded as FAILED — shown in the thread
      else reject(new Error((body as { error?: string } | null)?.error ?? `Upload failed (${xhr.status})`));
    };
    xhr.onerror = () => reject(new Error("Network error — the upload didn't reach the server"));
    xhr.send(form);
  });
}
