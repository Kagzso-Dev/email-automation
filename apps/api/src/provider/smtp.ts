import nodemailer, { type Transporter } from "nodemailer";
import { logger } from "../logger.js";
import {
  type EmailProvider,
  type OutboundMessage,
  PermanentSendError,
  type SendResult,
  TransientSendError,
} from "./types.js";

// Nodemailer / SMTP error codes that are worth retrying vs. permanent.
const TRANSIENT_ERROR_CODES = new Set(["ETIMEDOUT", "ECONNECTION", "ESOCKET", "EDNS", "ECONNRESET"]);
const PERMANENT_ERROR_CODES = new Set(["EAUTH", "EENVELOPE", "EMESSAGE"]);

/** Where to connect — from Settings → Email (SMTP) or .env (see domain/smtpSettings.ts). */
export interface SmtpConnection {
  host?: string;
  port: number;
  secure: boolean;
  user?: string;
  pass?: string;
}

export class SmtpProvider implements EmailProvider {
  readonly name = "smtp";
  private transporter: Transporter;

  constructor(conn: SmtpConnection) {
    if (!conn.host) {
      throw new Error(
        "EMAIL_PROVIDER=smtp requires an SMTP host — set it in Settings → Email (SMTP) or SMTP_HOST in .env",
      );
    }
    this.transporter = nodemailer.createTransport({
      host: conn.host,
      port: conn.port,
      // true => implicit TLS (465); false => STARTTLS upgrade on 587/25
      secure: conn.secure,
      auth: conn.user ? { user: conn.user, pass: conn.pass } : undefined,
    });
    logger.info(
      { host: conn.host, port: conn.port, secure: conn.secure, auth: Boolean(conn.user) },
      "SMTP provider configured",
    );
  }

  /** Release the old connection when the settings change. */
  close(): void {
    this.transporter.close();
  }

  async send(msg: OutboundMessage): Promise<SendResult> {
    try {
      const info = await this.transporter.sendMail({
        from: msg.from,
        to: msg.to,
        subject: msg.subject,
        html: msg.html,
        text: msg.text,
        headers: msg.headers,
        attachments: msg.attachments?.map((a) => ({
          filename: a.filename,
          content: a.content,
          contentType: a.contentType,
          ...(a.encoding ? { encoding: a.encoding } : {}),
          ...(a.cid ? { cid: a.cid, contentDisposition: "inline" as const } : {}),
        })),
      });
      logger.info(
        {
          to: msg.to,
          subject: msg.subject,
          from: msg.from,
          providerMessageId: info.messageId ?? "",
          response: info.response,
          accepted: info.accepted,
          rejected: info.rejected,
        },
        "smtp email sent",
      );
      return { providerMessageId: info.messageId ?? "" };
    } catch (err) {
      const e = err as { code?: string; responseCode?: number; message?: string };
      const code = e.code ?? "";
      const smtpCode = e.responseCode ?? 0;
      logger.error(
        { to: msg.to, subject: msg.subject, code: code || undefined, responseCode: smtpCode || undefined, err: e.message },
        "smtp send failed",
      );

      if (PERMANENT_ERROR_CODES.has(code) || (smtpCode >= 500 && smtpCode < 600)) {
        throw new PermanentSendError(`SMTP rejected (${code || smtpCode}): ${e.message ?? "send failed"}`);
      }
      if (TRANSIENT_ERROR_CODES.has(code) || (smtpCode >= 400 && smtpCode < 500)) {
        throw new TransientSendError(`SMTP transient (${code || smtpCode}): ${e.message ?? "send failed"}`);
      }
      // Unknown — retry rather than lose the message.
      throw new TransientSendError(`SMTP error: ${e.message ?? String(err)}`);
    }
  }
}
