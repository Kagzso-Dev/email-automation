#!/usr/bin/env node
/**
 * Temporary manual test for the Dispatch webhook trigger endpoint.
 *
 *   POST {BASE_URL}/api/webhooks/trigger/{EVENT_KEY}
 *
 * This is NOT wired into any real flow — run it by hand to confirm the endpoint
 * accepts your payload and queues a send. Delete this file once you've moved the
 * call into your real handler (see the notes printed at the end).
 *
 * Usage:
 *   node test-trigger.mjs
 *   BASE_URL=http://localhost:4000 EVENT_KEY=user.signup API_KEY=sk_xxx node test-trigger.mjs
 *   node test-trigger.mjs --email someone@example.com --first Jane --last Doe
 *
 * Requires Node 18+ (uses the built-in fetch).
 */

// ---- config (env vars override defaults; CLI flags override env vars) --------

const args = parseArgs(process.argv.slice(2));

const BASE_URL = args.base || process.env.BASE_URL || "http://localhost:4000";
const EVENT_KEY = args.event || process.env.EVENT_KEY || "user.signup"; // seeded trigger
const API_KEY = args.key || process.env.API_KEY || ""; // sk_... — REQUIRED by the endpoint

// The endpoint validates against `triggerWebhookInput` in packages/shared:
//   contactEmail  (required, must be a valid email)
//   contact       (optional: { firstName, lastName, customFields })
//   payload       (optional object — matched against the trigger's conditions)
//   dedupeKey     (optional — stops the same event sending twice)
const body = {
  contactEmail: args.email || "test@example.com",
  contact: {
    firstName: args.first || "Test",
    lastName: args.last || "User",
  },
  payload: { source: "test-trigger.mjs" },
  dedupeKey: `manual-test-${Date.now()}`,
};

const url = `${BASE_URL.replace(/\/$/, "")}/api/webhooks/trigger/${encodeURIComponent(EVENT_KEY)}`;

// ---- run --------------------------------------------------------------------

console.log("→ POST", url);
console.log("→ headers:", {
  "Content-Type": "application/json",
  Authorization: API_KEY ? `Bearer ${API_KEY.slice(0, 10)}…` : "(none — will 401)",
});
console.log("→ body:", JSON.stringify(body, null, 2));
console.log("");

if (!API_KEY) {
  console.warn(
    "⚠  No API_KEY set. This endpoint requires one and will respond 401 'Missing API key'.\n" +
      "   Create a key (ADMIN session): POST /api/api-keys  { \"name\": \"local test\" }\n" +
      "   then re-run:  API_KEY=sk_xxx node test-trigger.mjs\n",
  );
}

try {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(API_KEY ? { Authorization: `Bearer ${API_KEY}` } : {}),
    },
    body: JSON.stringify(body),
  });

  const text = await res.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = text;
  }

  console.log(`← status: ${res.status} ${res.statusText}`);
  console.log("← body:", typeof parsed === "string" ? parsed : JSON.stringify(parsed, null, 2));
  console.log("");

  if (res.status === 202) {
    // fireTrigger returns { status: "queued", idempotencyKey } or { status: "skipped", reason }
    if (parsed?.status === "queued") {
      console.log("✅ Accepted and queued. idempotencyKey:", parsed.idempotencyKey);
      console.log(
        "   The email is now a job — the worker must be running for it to send:\n" +
          "     npm --workspace @dispatch/api run dev:worker",
      );
    } else if (parsed?.status === "skipped") {
      console.log(`✅ Endpoint worked, but nothing was queued. reason: "${parsed.reason}"`);
      console.log(
        "   Common reasons: no active trigger for that eventKey, conditions not met,\n" +
          "   or the contact is suppressed (unsubscribed / bounced).",
      );
    } else {
      console.log("✅ 202 received. Unexpected body shape above — check fireTrigger().");
    }
    process.exit(0);
  }

  // Anything else is a failure — surface everything useful for debugging.
  console.error("❌ Request did not succeed.");
  if (res.status === 401) {
    console.error("   Auth problem. Set a valid API_KEY (sk_...). See the note above.");
  } else if (res.status === 400) {
    console.error(
      "   Payload rejected by validation. The body must match triggerWebhookInput:\n" +
        "   contactEmail (valid email), optional contact{firstName,lastName}, optional payload{}.\n" +
        "   Note: it is `contactEmail`, not `email`, and there is no top-level `name`.",
    );
  } else if (res.status === 429) {
    console.error("   Rate limited (120 req/min per IP on this route). Wait a minute.");
  } else if (res.status >= 500) {
    console.error("   Server error — check the API server logs for the stack trace.");
  }
  console.error("\n   Full response headers:");
  for (const [k, v] of res.headers) console.error(`     ${k}: ${v}`);
  process.exit(1);
} catch (err) {
  console.error("❌ Network / fetch error — the request never got a response.\n");
  console.error(err);
  console.error(
    "\n   Checks:\n" +
      `   - Is the API server up?  curl ${BASE_URL}/api/health\n` +
      "   - Is BASE_URL right? (dev default is http://localhost:4000)\n" +
      "   - Firewall / VPN / wrong port?",
  );
  process.exit(1);
}

// ---- helpers ---------------------------------------------------------------

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const val = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : "true";
      out[key] = val;
    }
  }
  return out;
}
