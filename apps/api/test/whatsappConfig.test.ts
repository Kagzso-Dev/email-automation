import { afterEach, describe, expect, it, vi } from "vitest";

// config/whatsapp.ts reads process.env at module load, so each case resets the
// module registry and re-imports with a fresh env.
afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("config/whatsapp", () => {
  it("loads with no WHATSAPP_* vars set — configured:false, never throws", async () => {
    // Stub empty so a real repo .env can't leak credentials into this case
    // (dotenv never overrides an already-set var).
    vi.stubEnv("WHATSAPP_ACCOUNT_SID", "");
    vi.stubEnv("WHATSAPP_AUTH_TOKEN", "");
    vi.stubEnv("WHATSAPP_FROM", "");
    vi.resetModules();
    const mod = await import("../src/config/whatsapp.js");
    expect(mod.isWhatsAppConfigured()).toBe(false);
    expect(mod.whatsappConfig.apiUrl).toContain("twilio.com");
    // Defaults for pacing.
    expect(mod.whatsappConfig.minDelaySec).toBeGreaterThan(0);
    expect(mod.whatsappConfig.maxDelaySec).toBeGreaterThanOrEqual(mod.whatsappConfig.minDelaySec);
  });

  it("is configured once SID, token and from are all present", async () => {
    vi.stubEnv("WHATSAPP_ACCOUNT_SID", "AC123");
    vi.stubEnv("WHATSAPP_AUTH_TOKEN", "tok");
    vi.stubEnv("WHATSAPP_FROM", "whatsapp:+14155238886");
    vi.resetModules();
    const mod = await import("../src/config/whatsapp.js");
    expect(mod.isWhatsAppConfigured()).toBe(true);
    expect(mod.whatsappConfig.from).toBe("whatsapp:+14155238886");
  });

  it("stays unconfigured when only some vars are set", async () => {
    vi.stubEnv("WHATSAPP_ACCOUNT_SID", "AC123");
    // Clear the other two so a real repo .env can't leak them in and mask
    // the "partial config" case being tested.
    vi.stubEnv("WHATSAPP_AUTH_TOKEN", "");
    vi.stubEnv("WHATSAPP_FROM", "");
    vi.resetModules();
    const mod = await import("../src/config/whatsapp.js");
    expect(mod.isWhatsAppConfigured()).toBe(false);
  });
});

describe("whatsappStatusCallbackUrl", () => {
  it("resolves from WHATSAPP_PUBLIC_BASE_URL, trimming a trailing slash", async () => {
    vi.stubEnv("WHATSAPP_PUBLIC_BASE_URL", "https://example.ngrok-free.dev/");
    vi.resetModules();
    const mod = await import("../src/config/whatsapp.js");
    expect(mod.whatsappStatusCallbackUrl()).toBe(
      "https://example.ngrok-free.dev/api/webhooks/whatsapp/status",
    );
  });

  it("prefers WHATSAPP_PUBLIC_BASE_URL over PUBLIC_API_URL when both are public", async () => {
    vi.stubEnv("WHATSAPP_PUBLIC_BASE_URL", "https://whatsapp.example.com");
    vi.stubEnv("PUBLIC_API_URL", "https://email.example.com");
    vi.resetModules();
    const mod = await import("../src/config/whatsapp.js");
    expect(mod.whatsappStatusCallbackUrl()).toBe(
      "https://whatsapp.example.com/api/webhooks/whatsapp/status",
    );
  });

  it("falls back to PUBLIC_API_URL when WHATSAPP_PUBLIC_BASE_URL is unset", async () => {
    vi.stubEnv("WHATSAPP_PUBLIC_BASE_URL", "");
    vi.stubEnv("PUBLIC_API_URL", "https://fallback.example.com");
    vi.resetModules();
    const mod = await import("../src/config/whatsapp.js");
    expect(mod.whatsappStatusCallbackUrl()).toBe(
      "https://fallback.example.com/api/webhooks/whatsapp/status",
    );
  });

  it("returns undefined (never a localhost callback) when only PUBLIC_API_URL is localhost", async () => {
    vi.stubEnv("WHATSAPP_PUBLIC_BASE_URL", "");
    vi.stubEnv("PUBLIC_API_URL", "http://localhost:4000");
    vi.resetModules();
    const mod = await import("../src/config/whatsapp.js");
    expect(mod.whatsappStatusCallbackUrl()).toBeUndefined();
  });

  it("returns undefined when WHATSAPP_PUBLIC_BASE_URL is itself localhost, even if set", async () => {
    vi.stubEnv("WHATSAPP_PUBLIC_BASE_URL", "http://127.0.0.1:4000");
    vi.resetModules();
    const mod = await import("../src/config/whatsapp.js");
    expect(mod.whatsappStatusCallbackUrl()).toBeUndefined();
  });

  it("returns undefined when neither var is set", async () => {
    vi.stubEnv("WHATSAPP_PUBLIC_BASE_URL", "");
    // env.ts's schema requires PUBLIC_API_URL to be a *valid* URL when present
    // (its default only applies when the key is absent), so simulate "unset"
    // by deleting it rather than stubbing "" — dotenv then refills it from the
    // real .env's own localhost default, which is exactly the case under test.
    delete process.env.PUBLIC_API_URL;
    vi.resetModules();
    const mod = await import("../src/config/whatsapp.js");
    expect(mod.whatsappStatusCallbackUrl()).toBeUndefined();
  });
});
