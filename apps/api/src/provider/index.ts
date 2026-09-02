import { env } from "../env.js";
import { MockProvider } from "./mock.js";
import { SesProvider } from "./ses.js";
import type { EmailProvider } from "./types.js";

let instance: EmailProvider | undefined;

export function getProvider(): EmailProvider {
  if (!instance) {
    instance = env.EMAIL_PROVIDER === "ses" ? new SesProvider() : new MockProvider();
  }
  return instance;
}

export * from "./types.js";
