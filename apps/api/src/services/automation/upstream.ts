// One door for every request to LinkedIn and Meta (Automation, ENABLE_AUTOMATION).
//
//   - the token goes in the Authorization header only, never in a URL, so it can't leak through a logged URL
//   - every request has a timeout
//   - errors become AppErrors the web app can show: rate limits → 429 with a retry time; a rejected token or a
//     missing permission → 502 with what to fix (never 401: that would sign the user out of this app)
//   - any text that comes back from LinkedIn / Meta is scrubbed of every configured token before it is used
//   - logging: platform, HTTP status and the provider's error code only; never bodies, URLs or headers

import { automationSecrets } from "../../config/automation.js";
import { AppError } from "../../http/errors.js";
import { logger } from "../../logger.js";

export type UpstreamPlatform = "linkedin" | "meta";

const LABEL: Record<UpstreamPlatform, string> = { linkedin: "LinkedIn", meta: "Meta" };

export interface UpstreamRequest {
  platform: UpstreamPlatform;
  url: string;
  token: string;
  method?: "GET" | "POST" | "DELETE";
  headers?: Record<string, string>;
  json?: unknown;
  form?: Record<string, string>;
  timeoutMs?: number;
  /** Shown in "update <envVar> and restart the API" when the token is rejected. */
  tokenEnvVar: string;
}

export interface UpstreamResponse {
  status: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  body: any;
  headers: Headers;
}

/** Removes every configured token, and anything that looks like one, from `text`. */
export function redactSecrets(text: string): string {
  let out = text;
  for (const s of automationSecrets()) out = out.split(s).join("[redacted]");
  return out
    .replace(/(access_token=)[^&\s"']+/gi, "$1[redacted]")
    .replace(/(Bearer|OAuth)\s+[A-Za-z0-9._~+/=-]{6,}/g, "$1 [redacted]");
}

const clip = (s: string, n = 300) => (s.length > n ? `${s.slice(0, n)}…` : s);

// Meta throttling codes: app / account / user limits, plus business-use-case limits (80000–80099).
const META_RATE_CODES = new Set([4, 17, 32, 613]);
const META_TOKEN_CODES = new Set([190, 102]);
const isMetaPermissionCode = (c: number) => c === 3 || c === 10 || (c >= 200 && c <= 299);

function retryAfterSec(headers: Headers, fallback: number): number {
  const raw = headers.get("retry-after");
  const n = raw ? Number.parseInt(raw, 10) : NaN;
  return Number.isFinite(n) && n > 0 ? Math.min(n, 3600) : fallback;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function toUpstreamError(req: Pick<UpstreamRequest, "platform" | "tokenEnvVar">, status: number, body: any, headers: Headers): AppError {
  const label = LABEL[req.platform];
  const metaErr = req.platform === "meta" ? body?.error : undefined;
  const code = typeof metaErr?.code === "number" ? metaErr.code : undefined;
  const subcode = typeof metaErr?.error_subcode === "number" ? metaErr.error_subcode : undefined;
  const rawMessage = String(metaErr?.error_user_msg ?? metaErr?.message ?? body?.message ?? "").trim();
  const detail = rawMessage ? clip(redactSecrets(rawMessage)) : "";

  logger.warn({ platform: req.platform, status, providerCode: code ?? body?.serviceErrorCode, providerSubcode: subcode }, "automation upstream error");

  const rateLimited = status === 429 || (code !== undefined && (META_RATE_CODES.has(code) || (code >= 80000 && code <= 80099)));
  if (rateLimited) {
    const wait = retryAfterSec(headers, 60);
    return new AppError(429, `${label} rate limit reached — try again in ${wait} s.`, "rate_limited", { retryAfterSec: wait });
  }
  // Instagram: the customer's messaging window has closed (24 h, or 7 days for the HUMAN_AGENT tag).
  if (code === 10 && subcode === 2534022) {
    return new AppError(409, "Instagram refused: this message is outside the allowed reply window.", "outside_window");
  }
  if (status === 401 || (code !== undefined && META_TOKEN_CODES.has(code))) {
    return new AppError(
      502,
      `${label} rejected the access token (expired or revoked). Put a new token in ${req.tokenEnvVar} in .env and restart the API.`,
      "token_invalid",
    );
  }
  if (status === 403 || (code !== undefined && isMetaPermissionCode(code))) {
    return new AppError(
      502,
      `${label} refused: the token is missing a permission or the app isn't approved for this.${detail ? ` (${detail})` : ""}`,
      "permission_denied",
    );
  }
  if (status === 404) return new AppError(404, `${label}: not found.${detail ? ` (${detail})` : ""}`, "upstream_not_found");
  if (status >= 400 && status < 500) return new AppError(400, `${label} rejected the request${detail ? `: ${detail}` : "."}`, "upstream_rejected");
  return new AppError(502, `${label} had a problem (HTTP ${status}) — try again shortly.`, "upstream_error");
}

export async function upstream(req: UpstreamRequest): Promise<UpstreamResponse> {
  const headers = new Headers(req.headers);
  headers.set("Authorization", `Bearer ${req.token}`);
  let body: string | undefined;
  if (req.json !== undefined) {
    headers.set("Content-Type", "application/json");
    body = JSON.stringify(req.json);
  } else if (req.form) {
    headers.set("Content-Type", "application/x-www-form-urlencoded");
    body = new URLSearchParams(req.form).toString();
  }
  const label = LABEL[req.platform];
  let res: Response;
  try {
    res = await fetch(req.url, { method: req.method ?? "GET", headers, body, signal: AbortSignal.timeout(req.timeoutMs ?? 20_000) });
  } catch (err) {
    const name = (err as { name?: string } | null)?.name;
    const timedOut = name === "TimeoutError" || name === "AbortError";
    logger.warn({ platform: req.platform, timedOut }, "automation upstream unreachable");
    throw timedOut
      ? new AppError(504, `${label} didn't answer in time — try again.`, "upstream_timeout")
      : new AppError(502, `Couldn't reach ${label} — check the server's internet connection.`, "upstream_unreachable");
  }
  const text = await res.text().catch(() => "");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let parsed: any = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = null;
  }
  if (res.ok) return { status: res.status, body: parsed, headers: res.headers };
  throw toUpstreamError(req, res.status, parsed, res.headers);
}
