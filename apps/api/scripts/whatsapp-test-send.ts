// One-off manual smoke test for the WhatsApp (Twilio) pipeline.
//
// Exercises the real path: config/whatsapp.ts -> services/whatsapp.ts ->
// Twilio's Messages API. Nothing here touches email code or the DB — it does
// not go through the drip-batch queue (queue/whatsappBulkSend.ts), it just
// calls sendWhatsAppTemplate() directly so you can watch one message succeed
// or fail in isolation.
//
// Usage (from the repo root):
//   npx tsx apps/api/scripts/whatsapp-test-send.ts --to +19995551234 --contentSid HXxxxxxxxx
//   npx tsx apps/api/scripts/whatsapp-test-send.ts --to +19995551234 --contentSid HXxxxxxxxx --vars '{"1":"Ada"}'
//
// --to         required. Your own phone, E.164 (with country code). The
//              "whatsapp:" prefix is added for you if you omit it.
// --contentSid required. A Twilio Content Template SID (starts with "HX"),
//              created in Twilio Console > Messaging > Content Template
//              Builder. In the sandbox this can be a plain "Twilio Text"
//              template — no Meta approval needed for sandbox testing.
// --vars       optional. JSON object mapping the template's positional slots
//              ("1", "2", ...) to values. Defaults to {} (no placeholders).

import { isWhatsAppConfigured, whatsappConfig } from "../src/config/whatsapp.js";
import { sendWhatsAppTemplate, WhatsAppSendError } from "../src/services/whatsapp.js";

function arg(name: string): string | undefined {
  const flag = `--${name}`;
  const i = process.argv.indexOf(flag);
  if (i === -1) return undefined;
  return process.argv[i + 1];
}

function mask(v: string | undefined): string {
  if (!v) return "(empty)";
  if (v.length <= 4) return "*".repeat(v.length);
  return `${v.slice(0, 2)}${"*".repeat(v.length - 4)}${v.slice(-2)}`;
}

async function main() {
  const to = arg("to");
  const contentSid = arg("contentSid");
  const varsRaw = arg("vars");

  console.log("--- WhatsApp config check ---");
  console.log({
    apiUrl: whatsappConfig.apiUrl,
    accountSid: mask(whatsappConfig.accountSid),
    authToken: mask(whatsappConfig.authToken),
    from: whatsappConfig.from ?? "(empty)",
    defaultCountryCode: whatsappConfig.defaultCountryCode ?? "(none)",
    minDelaySec: whatsappConfig.minDelaySec,
    maxDelaySec: whatsappConfig.maxDelaySec,
    configured: isWhatsAppConfigured(),
  });

  if (!isWhatsAppConfigured()) {
    console.error(
      "\nNOT CONFIGURED: WHATSAPP_ACCOUNT_SID / WHATSAPP_AUTH_TOKEN / WHATSAPP_FROM " +
        "are missing from .env. Fill those in first — see .env.example.",
    );
    process.exit(1);
  }

  if (!to || !contentSid) {
    console.error(
      "\nUsage: npx tsx apps/api/scripts/whatsapp-test-send.ts --to +1XXXXXXXXXX --contentSid HXxxxx [--vars '{\"1\":\"Ada\"}']",
    );
    process.exit(1);
  }

  let contentVariables: Record<string, string> = {};
  if (varsRaw) {
    try {
      contentVariables = JSON.parse(varsRaw);
    } catch {
      console.error("--vars must be valid JSON, e.g. '{\"1\":\"Ada\"}'");
      process.exit(1);
    }
  }

  console.log("\n--- sending ---");
  console.log({ to, contentSid, contentVariables });

  try {
    const result = await sendWhatsAppTemplate({ to, contentSid, contentVariables });
    console.log("\nSUCCESS — Twilio accepted the message.");
    console.log({ providerMessageId: result.providerMessageId });
    console.log(
      "\nCheck your phone. If using the sandbox, delivery only works if this " +
        "number already joined it (see the join instructions).",
    );
  } catch (err) {
    console.error("\nFAILED —", err instanceof Error ? err.message : err);
    if (err instanceof WhatsAppSendError) {
      console.error("retryable:", err.retryable);
    }
    process.exit(1);
  }
}

main();
