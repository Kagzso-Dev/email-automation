import { env } from "../env.js";
import { sanitizeEmailHtml } from "./sanitize.js";
import { sign } from "./signing.js";

/** Permanent failure — a job that hits this must not be retried. */
export class RenderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RenderError";
  }
}

export type RenderVars = Record<string, string | number | boolean | null | undefined>;

const VAR_RE = /\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g;

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Logic-less {{variable}} substitution. No partials, no helpers, nothing
 * executable. `htmlContext` decides whether values are HTML-escaped.
 */
export function substitute(
  template: string,
  vars: RenderVars,
  opts: { htmlContext: boolean; declared: string[] },
): string {
  const declaredSet = new Set(opts.declared);
  return template.replace(VAR_RE, (_match, name: string) => {
    const has = Object.prototype.hasOwnProperty.call(vars, name);
    if (!has) {
      if (declaredSet.has(name)) {
        throw new RenderError(`Missing value for declared variable "${name}"`);
      }
      return "";
    }
    const raw = vars[name];
    const str = raw == null ? "" : String(raw);
    return opts.htmlContext ? escapeHtml(str) : str;
  });
}

export interface RenderInput {
  subject: string;
  htmlBody: string;
  textBody?: string | null;
  declaredVariables: string[];
  vars: RenderVars;
  /** Present for real sends; absent for previews. Enables link/open tracking. */
  emailLogId?: string;
  unsubscribeUrl?: string;
}

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

function rewriteLinks(html: string, emailLogId: string): string {
  return html.replace(/(<a\b[^>]*\bhref=")([^"]+)(")/gi, (full, pre: string, url: string, post) => {
    if (!/^https?:\/\//i.test(url)) return full; // leave mailto:, anchors, unsubscribe as-is
    const signed = sign(url);
    const tracked = `${env.PUBLIC_API_URL}/api/track/click/${emailLogId}?u=${encodeURIComponent(
      url,
    )}&s=${signed}`;
    return `${pre}${tracked}${post}`;
  });
}

function injectPixel(html: string, emailLogId: string): string {
  const pixel = `<img src="${env.PUBLIC_API_URL}/api/track/open/${emailLogId}.png" width="1" height="1" alt="" style="display:none" />`;
  return /<\/body>/i.test(html) ? html.replace(/<\/body>/i, `${pixel}</body>`) : html + pixel;
}

function footer(unsubscribeUrl?: string): string {
  const addr = escapeHtml(env.EMAIL_SENDER_ADDRESS);
  const unsub = unsubscribeUrl
    ? ` &middot; <a href="${unsubscribeUrl}">Unsubscribe</a>`
    : "";
  return `<div style="margin-top:32px;font-size:12px;color:#8a92a0">${addr}${unsub}</div>`;
}

export function render(input: RenderInput): RenderedEmail {
  const allVars: RenderVars = {
    ...input.vars,
    unsubscribe_url: input.unsubscribeUrl ?? input.vars.unsubscribe_url ?? "",
    sender_address: env.EMAIL_SENDER_ADDRESS,
  };
  const declared = input.declaredVariables;

  const subject = substitute(input.subject, allVars, { htmlContext: false, declared });

  let html = substitute(input.htmlBody, allVars, { htmlContext: true, declared });
  html = sanitizeEmailHtml(html);
  html += footer(input.unsubscribeUrl);

  if (input.emailLogId) {
    html = rewriteLinks(html, input.emailLogId);
    html = injectPixel(html, input.emailLogId);
  }

  const textSource =
    input.textBody && input.textBody.trim().length > 0
      ? substitute(input.textBody, allVars, { htmlContext: false, declared })
      : htmlToText(html);
  const text =
    textSource +
    (input.unsubscribeUrl ? `\n\n---\n${env.EMAIL_SENDER_ADDRESS}\nUnsubscribe: ${input.unsubscribeUrl}` : "");

  return { subject, html, text };
}

function htmlToText(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|h[1-6]|li|tr)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
