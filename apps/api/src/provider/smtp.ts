import nodemailer, { type Transporter } from "nodemailer";
import { env } from "../env.js";
import { logger } from "../logger.js";
import {
  type DeliveryEvent,
  type EmailProvider,
  type OutboundMessage,
  PermanentSendError,
  type SendResult,
  TransientSendError,
} from "./types.js";

// Nodemailer / SMTP error codes that are worth retrying vs. permanent.
const TRANSIENT_ERROR_CODES = new Set(["ETIMEDOUT", "ECONNECTION", "ESOCKET", "EDNS", "ECONNRESET"]);
const PERMANENT_ERROR_CODES = new Set(["EAUTH", "EENVELOPE", "EMESSAGE"]);

export class SmtpProvider implements EmailProvider {
  readonly name = "smtp";
  private transporter: Transporter;

  constructor() {
    if (!env.SMTP_HOST) {
      throw new Error("EMAIL_PROVIDER=smtp requires SMTP_HOST (and usually SMTP_USER/SMTP_PASS)");
    }
    this.transporter = nodemailer.createTransport({
      host: env.SMTP_HOST,
      port: env.SMTP_PORT,
      // true => implicit TLS (465); false => STARTTLS upgrade on 587/25
      secure: env.SMTP_SECURE,
      auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASS } : undefined,
    });
    logger.info(
      { host: env.SMTP_HOST, port: env.SMTP_PORT, secure: env.SMTP_SECURE, auth: Boolean(env.SMTP_USER) },
      "SMTP provider configured",
    );
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
      });
      return { providerMessageId: info.messageId ?? "" };
    } catch (err) {
      const e = err as { code?: string; responseCode?: number; message?: string };
      const code = e.code ?? "";
      const smtpCode = e.responseCode ?? 0;

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

  /** SMTP has no asynchronous delivery callbacks. */
  async parseWebhook(): Promise<DeliveryEvent[]> {
    return [];
  }
}
