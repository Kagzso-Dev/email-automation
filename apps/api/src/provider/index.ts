import { env } from "../env.js";
import { MockProvider } from "./mock.js";
import { SesProvider } from "./ses.js";
import { SmtpProvider } from "./smtp.js";
import type { EmailProvider } from "./types.js";

let instance: EmailProvider | undefined;

export function getProvider(): EmailProvider {
  if (!instance) {
    switch (env.EMAIL_PROVIDER) {
      case "ses":
        instance = new SesProvider();
        break;
      case "smtp":
        instance = new SmtpProvider();
        break;
      default:
        instance = new MockProvider();
    }
  }
  return instance;
}

export * from "./types.js";
