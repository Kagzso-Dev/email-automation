import { env } from "../env.js";
import { MockProvider } from "./mock.js";
import { SmtpProvider } from "./smtp.js";
import type { EmailProvider } from "./types.js";

let instance: EmailProvider | undefined;

export function getProvider(): EmailProvider {
  if (!instance) {
    instance = env.EMAIL_PROVIDER === "smtp" ? new SmtpProvider() : new MockProvider();
  }
  return instance;
}

export * from "./types.js";
