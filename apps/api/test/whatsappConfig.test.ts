import { afterEach, describe, expect, it, vi } from "vitest";

// config/whatsapp.ts reads process.env at module load, so each case resets the
// module registry and re-imports with a fresh env.
afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

// Stub every credential empty so a real repo .env can't leak values into a
// case (dotenv never overrides an already-set var).
function clearMetaEnv() {
  for (const k of [
    "WHATSAPP_PROVIDER",
    "META_WHATSAPP_ACCESS_TOKEN",
    "META_WHATSAPP_PHONE_NUMBER_ID",
    "META_WHATSAPP_WABA_ID",
    "META_WHATSAPP_WEBHOOK_VERIFY_TOKEN",
    "META_WHATSAPP_APP_SECRET",
    "META_GRAPH_API_VERSION",
  ]) {
    vi.stubEnv(k, "");
  }
}

describe("config/whatsapp", () => {
  it("loads with no Meta vars set — configured:false, never throws", async () => {
    clearMetaEnv();
    const mod = await import("../src/config/whatsapp.js");
    expect(mod.isWhatsAppConfigured()).toBe(false);
    expect(mod.whatsappConfig.provider).toBe("meta");
    expect(mod.whatsappConfig.graphApiBaseUrl).toBe("https://graph.facebook.com");
    expect(mod.whatsappConfig.graphApiVersion).toMatch(/^v\d+\.\d+$/);
    // Defaults for pacing.
    expect(mod.whatsappConfig.minDelaySec).toBeGreaterThan(0);
    expect(mod.whatsappConfig.maxDelaySec).toBeGreaterThanOrEqual(mod.whatsappConfig.minDelaySec);
  });

  it("is configured once the access token and phone number id are present", async () => {
    clearMetaEnv();
    vi.stubEnv("META_WHATSAPP_ACCESS_TOKEN", "EAAtoken");
    vi.stubEnv("META_WHATSAPP_PHONE_NUMBER_ID", "1234567890");
    const mod = await import("../src/config/whatsapp.js");
    expect(mod.isWhatsAppConfigured()).toBe(true);
    expect(mod.whatsappConfig.phoneNumberId).toBe("1234567890");
  });

  it("stays unconfigured when only the access token is set", async () => {
    clearMetaEnv();
    vi.stubEnv("META_WHATSAPP_ACCESS_TOKEN", "EAAtoken");
    const mod = await import("../src/config/whatsapp.js");
    expect(mod.isWhatsAppConfigured()).toBe(false);
  });

  it("stays unconfigured for an unsupported WHATSAPP_PROVIDER", async () => {
    clearMetaEnv();
    vi.stubEnv("WHATSAPP_PROVIDER", "something-else");
    vi.stubEnv("META_WHATSAPP_ACCESS_TOKEN", "EAAtoken");
    vi.stubEnv("META_WHATSAPP_PHONE_NUMBER_ID", "1234567890");
    const mod = await import("../src/config/whatsapp.js");
    expect(mod.isWhatsAppConfigured()).toBe(false);
  });

  it("normalises META_GRAPH_API_VERSION to a v-prefixed value", async () => {
    clearMetaEnv();
    vi.stubEnv("META_GRAPH_API_VERSION", "23.0");
    const mod = await import("../src/config/whatsapp.js");
    expect(mod.whatsappConfig.graphApiVersion).toBe("v23.0");
  });
});
