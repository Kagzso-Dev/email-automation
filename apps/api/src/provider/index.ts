import { createHash } from "node:crypto";
import { env } from "../env.js";
import { getEmailTransport, type EmailTransport } from "../domain/smtpSettings.js";
import { MockProvider } from "./mock.js";
import { SmtpProvider } from "./smtp.js";
import { type EmailProvider, type OutboundMessage, type SendResult, TransientSendError } from "./types.js";

let mock: MockProvider | undefined;
let smtp: { key: string; provider: SmtpProvider } | undefined;
let lastName: string = env.EMAIL_PROVIDER;

/** Changes whenever anything the SMTP connection is built from changes (the password only as a hash). */
function connectionKey(t: EmailTransport): string {
  const pass = t.pass ? createHash("sha256").update(t.pass).digest("hex") : "";
  return JSON.stringify([t.host, t.port, t.secure, t.user, pass]);
}

function smtpFor(t: EmailTransport): SmtpProvider {
  const key = connectionKey(t);
  if (smtp?.key !== key) {
    const provider = new SmtpProvider(t); // throws when no host is set anywhere
    smtp?.provider.close();
    smtp = { key, provider };
  }
  return smtp.provider;
}

/**
 * The one email provider for this process. Each send uses the current settings — Settings → Email (SMTP) first,
 * .env for anything not saved there — so an admin's change reaches the API and the worker without a restart.
 * The SMTP connection is only rebuilt when those settings actually change.
 */
const configuredProvider: EmailProvider = {
  get name() {
    return lastName;
  },
  async send(msg: OutboundMessage): Promise<SendResult> {
    let t: EmailTransport;
    try {
      t = await getEmailTransport();
    } catch (err) {
      throw new TransientSendError(`Couldn't read the email settings: ${err instanceof Error ? err.message : String(err)}`);
    }
    lastName = t.provider;
    const out = t.fromOverride ? { ...msg, from: t.fromOverride } : msg;
    if (t.provider === "mock") return (mock ??= new MockProvider()).send(out);
    return smtpFor(t).send(out);
  },
};

export function getProvider(): EmailProvider {
  return configuredProvider;
}

export * from "./types.js";
