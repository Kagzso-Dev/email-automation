// One-off manual smoke test for the WhatsApp (Meta Cloud API) pipeline.
//
// Exercises the real path: config/whatsapp.ts -> services/whatsapp.ts -> the
// Graph API. Nothing here touches email code or writes to the DB (credentials
// saved from the Settings page are read, though) — it does not go through the
// drip-batch queue (queue/whatsappBulkSend.ts), it just calls the send service
// directly so you can watch one message succeed or fail in isolation.
//
// Usage (from the repo root):
//   npx tsx apps/api/scripts/whatsapp-test-send.ts --check
//   npx tsx apps/api/scripts/whatsapp-test-send.ts --to 919876543210 --template hello_world --lang en_US
//   npx tsx apps/api/scripts/whatsapp-test-send.ts --to 919876543210 --template kagzso_greeting --vars '{"1":"Ada"}'
//   npx tsx apps/api/scripts/whatsapp-test-send.ts --to 919876543210 --text "hi"
//
// --check     only call the Graph API to read the configured sender number.
// --to        recipient, digits with country code ("+" and spaces are stripped).
// --template  name of a Meta-approved template (WhatsApp Manager → Message
//             templates). "hello_world" (en_US) exists on every new WABA.
// --lang      template language code. Default: en.
// --vars      JSON of positional body params, e.g. '{"1":"Ada","2":"Acme"}'.
// --text      send free-form text instead — only delivered inside the 24h
//             window after the recipient last messaged your number.

import { whatsappConfig } from "../src/config/whatsapp.js";
import { getWhatsAppCredentials, isSendConfigured } from "../src/domain/whatsappCredentials.js";
import {
  bodyComponentsFromVariables,
  getPhoneNumberInfo,
  sendTemplateMessage,
  sendTextMessage,
  WhatsAppSendError,
} from "../src/services/whatsapp.js";
import { prisma } from "../src/prisma.js";

function arg(name: string): string | undefined {
  const flag = `--${name}`;
  const i = process.argv.indexOf(flag);
  if (i === -1) return undefined;
  return process.argv[i + 1];
}

function mask(v: string | undefined): string {
  if (!v) return "(empty)";
  if (v.length <= 8) return "*".repeat(v.length);
  return `${v.slice(0, 4)}…${v.slice(-4)} (${v.length} chars)`;
}

async function main() {
  const creds = await getWhatsAppCredentials();
  console.log("--- WhatsApp config check ---");
  console.log({
    provider: creds.provider,
    graphApiVersion: creds.graphApiVersion,
    phoneNumberId: creds.phoneNumberId ?? "(empty)",
    wabaId: creds.wabaId ?? "(empty)",
    accessToken: mask(creds.accessToken),
    appSecret: creds.appSecret ? "(set)" : "(empty)",
    webhookVerifyToken: creds.webhookVerifyToken ? "(set)" : "(empty)",
    credentialSource: creds.source,
    defaultCountryCode: whatsappConfig.defaultCountryCode ?? "(none)",
    configured: isSendConfigured(creds),
  });

  if (!isSendConfigured(creds)) {
    console.error(
      "\nNOT CONFIGURED: META_WHATSAPP_ACCESS_TOKEN / META_WHATSAPP_PHONE_NUMBER_ID are missing. " +
        "Fill them in .env (see .env.example) or under Settings → WhatsApp.",
    );
    process.exit(1);
  }

  console.log("\n--- sender number (Graph API) ---");
  console.log(await getPhoneNumberInfo());
  if (process.argv.includes("--check")) return;

  const to = arg("to");
  const template = arg("template");
  const text = arg("text");
  if (!to || (!template && !text)) {
    console.error(
      "\nUsage: npx tsx apps/api/scripts/whatsapp-test-send.ts --to 91XXXXXXXXXX (--template NAME [--lang en] [--vars '{\"1\":\"Ada\"}'] | --text \"hi\")",
    );
    process.exit(1);
  }

  let vars: Record<string, string> = {};
  const varsRaw = arg("vars");
  if (varsRaw) {
    try {
      vars = JSON.parse(varsRaw);
    } catch {
      console.error("--vars must be valid JSON, e.g. '{\"1\":\"Ada\"}'");
      process.exit(1);
    }
  }

  console.log("\n--- sending ---");
  const result = template
    ? await sendTemplateMessage({
        to,
        templateName: template,
        languageCode: arg("lang") ?? "en",
        components: bodyComponentsFromVariables(vars),
      })
    : await sendTextMessage({ to, body: text! });
  console.log("\nSUCCESS — Meta accepted the message.");
  console.log({ providerMessageId: result.providerMessageId });
  console.log("\nCheck the phone. Delivery/read receipts arrive on the webhook, not here.");
}

main()
  .catch((err) => {
    console.error("\nFAILED —", err instanceof Error ? err.message : err);
    if (err instanceof WhatsAppSendError) console.error("retryable:", err.retryable, "code:", err.code);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
