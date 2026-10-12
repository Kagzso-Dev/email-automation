// Production config sanity checks — WARNINGS ONLY. Startup is never blocked and
// no value is changed; the API and worker just log what looks unsafe so a
// missing production setting is noticed. Secret values are never logged, only
// the variable names.

import { env } from "../env.js";

type CheckedEnv = Pick<
  typeof env,
  "NODE_ENV" | "PUBLIC_API_URL" | "WEB_ORIGIN" | "EMAIL_PROVIDER" | "JWT_ACCESS_SECRET" | "JWT_REFRESH_SECRET" | "LINK_SIGNING_SECRET"
>;

/** Shorter secrets are easier to brute-force; 32+ random characters is the usual floor. */
const MIN_SECRET_LENGTH = 32;
const isLocal = (url: string) => /\b(localhost|127\.0\.0\.1)\b/i.test(url);

export function productionConfigWarnings(e: CheckedEnv = env): string[] {
  if (e.NODE_ENV !== "production") return [];
  const warnings: string[] = [];

  if (isLocal(e.PUBLIC_API_URL)) {
    warnings.push("PUBLIC_API_URL points at localhost — tracking, unsubscribe and media links will not work for recipients");
  } else if (!e.PUBLIC_API_URL.startsWith("https://")) {
    warnings.push("PUBLIC_API_URL is not https");
  }
  if (e.WEB_ORIGIN.split(",").some(isLocal)) warnings.push("WEB_ORIGIN includes localhost");
  if (e.EMAIL_PROVIDER === "mock") warnings.push("EMAIL_PROVIDER is mock — emails are saved locally, not sent");

  const secrets = {
    JWT_ACCESS_SECRET: e.JWT_ACCESS_SECRET,
    JWT_REFRESH_SECRET: e.JWT_REFRESH_SECRET,
    LINK_SIGNING_SECRET: e.LINK_SIGNING_SECRET,
  };
  for (const [name, value] of Object.entries(secrets)) {
    if (value.length < MIN_SECRET_LENGTH) warnings.push(`${name} is shorter than ${MIN_SECRET_LENGTH} characters`);
  }
  if (e.JWT_ACCESS_SECRET === e.JWT_REFRESH_SECRET) warnings.push("JWT_ACCESS_SECRET and JWT_REFRESH_SECRET are the same");

  return warnings;
}
