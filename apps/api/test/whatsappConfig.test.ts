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
    vi.resetModules();
    const mod = await import("../src/config/whatsapp.js");
    expect(mod.isWhatsAppConfigured()).toBe(false);
  });
});
