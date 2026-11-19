import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import jwt from "jsonwebtoken";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// Settings → Email (SMTP): admin-only endpoints, the password write-only and encrypted at rest, every send using
// the saved values over .env, reset, the ENABLE_SMTP_SETTINGS kill switch and a changed encryption key. The
// Setting table is an in-memory fake; nodemailer and the mock provider are spies (nothing is sent or written).

const h = vi.hoisted(() => {
  // A clean .env baseline whatever this machine's .env says (dotenv never overrides keys already set).
  Object.assign(process.env, {
    EMAIL_PROVIDER: "mock",
    SMTP_HOST: "",
    SMTP_PORT: "587",
    SMTP_SECURE: "false",
    SMTP_USER: "",
    SMTP_PASS: "",
    ENABLE_SMTP_SETTINGS: "",
    SETTINGS_ENCRYPTION_KEY: "test-settings-key",
  });
  const sendMail = vi.fn(async (m: { to: string }) => ({
    messageId: "<m1@test>",
    response: "250 OK",
    accepted: [m.to],
    rejected: [],
  }));
  const createTransport = vi.fn((_opts: unknown) => ({ sendMail, close: vi.fn() }));
  const mockSend = vi.fn(async () => ({ providerMessageId: "mock-1" }));
  return { rows: new Map<string, unknown>(), sendMail, createTransport, mockSend };
});

vi.mock("nodemailer", () => ({ default: { createTransport: h.createTransport } }));
vi.mock("../src/provider/mock.js", () => ({
  MockProvider: class {
    readonly name = "mock";
    send = h.mockSend;
  },
}));
vi.mock("../src/prisma.js", () => ({
  prisma: {
    setting: {
      findUnique: async ({ where }: { where: { key: string } }) =>
        h.rows.has(where.key) ? { key: where.key, value: h.rows.get(where.key) } : null,
      upsert: async ({ where, create, update }: { where: { key: string }; create: { value: unknown }; update: { value: unknown } }) => {
        const value = h.rows.has(where.key) ? update.value : create.value;
        h.rows.set(where.key, JSON.parse(JSON.stringify(value))); // stored as JSON, like the real column
        return {};
      },
    },
  },
}));

const { forgetCachedSmtpSettings, SMTP_SETTINGS_KEY } = await import("../src/domain/smtpSettings.js");
const { getProvider } = await import("../src/provider/index.js");
const { sealSecret, openSecret } = await import("../src/domain/secretBox.js");

let server: Server;
let base = "";
const token = (role: "ADMIN" | "EDITOR") =>
  jwt.sign({ sub: `u-${role}`, email: `${role.toLowerCase()}@test`, role }, process.env.JWT_ACCESS_SECRET!);

beforeAll(async () => {
  const { createApp } = await import("../src/http/app.js");
  server = createApp().listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});
beforeEach(() => {
  h.rows.clear();
  forgetCachedSmtpSettings();
  vi.clearAllMocks();
  process.env.ENABLE_SMTP_SETTINGS = "";
  process.env.SETTINGS_ENCRYPTION_KEY = "test-settings-key";
});
afterEach(() => {
  process.env.ENABLE_SMTP_SETTINGS = "";
  process.env.SETTINGS_ENCRYPTION_KEY = "test-settings-key";
});

const call = (path: string, init: RequestInit & { role?: "ADMIN" | "EDITOR"; json?: unknown } = {}) =>
  fetch(base + path, {
    ...init,
    body: init.json === undefined ? undefined : JSON.stringify(init.json),
    headers: {
      "Content-Type": "application/json",
      ...(init.role ? { Authorization: `Bearer ${token(init.role)}` } : {}),
    },
  });
const json = async <T = Record<string, unknown>>(r: Response) => (await r.json()) as T;

const GMAIL = {
  host: "smtp.gmail.com",
  port: 465,
  secure: true,
  user: "sales@kagzso.test",
  password: "s3cret-app-pass",
  from: "Kagzso Sales <sales@kagzso.test>",
};
const saveGmail = () => call("/api/settings/smtp", { method: "PUT", role: "ADMIN", json: GMAIL });
const testSend = async (to = "me@kagzso.test") =>
  json(await call("/api/settings/smtp/test", { method: "POST", role: "ADMIN", json: { to } }));

describe("/api/settings/smtp — admins only", () => {
  it("needs sign-in; editors get 403 on every endpoint and nothing is saved or sent", async () => {
    expect((await call("/api/settings/smtp")).status).toBe(401);
    expect((await call("/api/settings/smtp", { role: "EDITOR" })).status).toBe(403);
    expect((await call("/api/settings/smtp", { method: "PUT", role: "EDITOR", json: GMAIL })).status).toBe(403);
    expect((await call("/api/settings/smtp", { method: "DELETE", role: "EDITOR" })).status).toBe(403);
    expect(
      (await call("/api/settings/smtp/test", { method: "POST", role: "EDITOR", json: { to: "x@y.test" } })).status,
    ).toBe(403);
    expect(h.rows.size).toBe(0);
    expect(h.sendMail).not.toHaveBeenCalled();
    expect(h.mockSend).not.toHaveBeenCalled();
  });

  it("editors still learn the card exists (to show the admin-only note), from /config", async () => {
    const config = await json(await call("/api/settings/config", { role: "EDITOR" }));
    expect(config.smtpSettings).toBe(true);
  });
});

describe("saving and using the SMTP account", () => {
  it("nothing saved: shows the .env values (mock here), no password", async () => {
    const view = await json(await call("/api/settings/smtp", { role: "ADMIN" }));
    expect(view).toMatchObject({
      provider: "mock",
      envProvider: "mock",
      host: null,
      port: 587,
      secure: false,
      user: null,
      hasPassword: false,
      passwordSource: null,
      saved: [],
      source: "environment",
    });
  });

  it("the password is never returned and never stored in plain text", async () => {
    const res = await saveGmail();
    expect(res.status).toBe(200);
    const raw = await res.text();
    expect(raw).not.toContain(GMAIL.password);
    const view = JSON.parse(raw);
    expect(view).not.toHaveProperty("password");
    expect(view).not.toHaveProperty("passwordSealed");
    expect(view).toMatchObject({
      provider: "smtp", // a saved server turns on SMTP sending even with EMAIL_PROVIDER=mock
      host: "smtp.gmail.com",
      port: 465,
      secure: true,
      user: GMAIL.user,
      from: GMAIL.from,
      hasPassword: true,
      passwordSource: "database",
      source: "database",
      updatedBy: "admin@test",
    });
    expect(view.saved).toEqual(["host", "port", "secure", "user", "password", "from"]);

    const row = h.rows.get(SMTP_SETTINGS_KEY) as Record<string, unknown>;
    expect(JSON.stringify(row)).not.toContain(GMAIL.password);
    expect(String(row.passwordSealed)).toMatch(/^v1:/);

    const again = await call("/api/settings/smtp", { role: "ADMIN" });
    expect(await again.text()).not.toContain(GMAIL.password);
    expect(again.headers.get("cache-control")).toBe("no-store");
  });

  it("sends go through the saved server, login and From", async () => {
    await saveGmail();
    const result = await testSend();
    expect(result).toMatchObject({ ok: true, provider: "smtp", providerMessageId: "<m1@test>" });
    expect(h.createTransport).toHaveBeenCalledWith({
      host: "smtp.gmail.com",
      port: 465,
      secure: true,
      auth: { user: GMAIL.user, pass: GMAIL.password },
    });
    expect(h.sendMail).toHaveBeenCalledWith(expect.objectContaining({ to: "me@kagzso.test", from: GMAIL.from }));
    expect(h.mockSend).not.toHaveBeenCalled();
  });

  it("the campaign/manual send path (getProvider) uses them too, replacing the .env From", async () => {
    await saveGmail();
    const provider = getProvider();
    await provider.send({
      to: "ada@example.com",
      from: process.env.EMAIL_FROM!,
      subject: "Hi",
      html: "<p>Hi</p>",
      text: "Hi",
      headers: {},
      tags: { emailLogId: "log1" },
    });
    expect(provider.name).toBe("smtp");
    expect(h.sendMail).toHaveBeenCalledWith(expect.objectContaining({ to: "ada@example.com", from: GMAIL.from }));
  });

  it("saving without a password keeps the saved one; the connection is rebuilt only when something changed", async () => {
    // Its own login, so the connection the earlier tests built (and this process keeps) isn't reused.
    const own = { ...GMAIL, user: "rebuild@kagzso.test" };
    await call("/api/settings/smtp", { method: "PUT", role: "ADMIN", json: own });
    await testSend();
    await testSend();
    expect(h.createTransport).toHaveBeenCalledTimes(1);

    const { password: _pw, ...noPassword } = own;
    await call("/api/settings/smtp", { method: "PUT", role: "ADMIN", json: { ...noPassword, host: "smtp.office365.com", port: 587, secure: false } });
    await testSend();
    expect(h.createTransport).toHaveBeenCalledTimes(2);
    expect(h.createTransport).toHaveBeenLastCalledWith({
      host: "smtp.office365.com",
      port: 587,
      secure: false,
      auth: { user: own.user, pass: GMAIL.password },
    });
  });

  it("a failed send comes back as { ok: false, error } for the admin to read", async () => {
    await saveGmail();
    h.sendMail.mockRejectedValueOnce(Object.assign(new Error("Invalid login: 535 Username and Password not accepted"), { code: "EAUTH" }));
    const result = await testSend();
    expect(result.ok).toBe(false);
    expect(String(result.error)).toContain("Username and Password not accepted");
  });

  it("rejects bad input and saves nothing", async () => {
    const bad = [
      { port: 0 },
      { port: 70000 },
      { host: "smtp.gmail.com/evil" },
      { from: "not an address" },
      { from: "Name <broken>" },
    ];
    for (const body of bad) {
      expect((await call("/api/settings/smtp", { method: "PUT", role: "ADMIN", json: body })).status).toBe(400);
    }
    expect((await call("/api/settings/smtp/test", { method: "POST", role: "ADMIN", json: { to: "nope" } })).status).toBe(400);
    expect(h.rows.size).toBe(0);
  });

  it("“Reset to .env values” removes everything saved and sends go back to .env (mock here)", async () => {
    await saveGmail();
    const view = await json(await call("/api/settings/smtp", { method: "DELETE", role: "ADMIN" }));
    expect(view).toMatchObject({ provider: "mock", host: null, hasPassword: false, saved: [], source: "environment", updatedBy: "admin@test" });
    expect(JSON.stringify(h.rows.get(SMTP_SETTINGS_KEY))).not.toContain("passwordSealed");

    const result = await testSend();
    expect(result).toMatchObject({ ok: true, provider: "mock" });
    expect(h.mockSend).toHaveBeenCalledTimes(1);
    expect(h.sendMail).not.toHaveBeenCalled();
  });

  it("a changed encryption key: the saved password reads as unusable, not as an empty password", async () => {
    await saveGmail();
    process.env.SETTINGS_ENCRYPTION_KEY = "a-different-key";
    forgetCachedSmtpSettings();
    const view = await json(await call("/api/settings/smtp", { role: "ADMIN" }));
    expect(view).toMatchObject({ passwordUnreadable: true, hasPassword: false, passwordSource: null });

    await testSend();
    expect(h.createTransport).toHaveBeenLastCalledWith(
      expect.objectContaining({ auth: { user: GMAIL.user, pass: undefined } }), // .env SMTP_PASS (empty here)
    );
  });
});

describe("ENABLE_SMTP_SETTINGS=false (kill switch)", () => {
  it("every endpoint answers 404 and sends ignore what was saved", async () => {
    await saveGmail();
    process.env.ENABLE_SMTP_SETTINGS = "false";

    expect((await call("/api/settings/smtp", { role: "ADMIN" })).status).toBe(404);
    expect((await call("/api/settings/smtp", { method: "PUT", role: "ADMIN", json: GMAIL })).status).toBe(404);
    expect((await call("/api/settings/smtp", { method: "DELETE", role: "ADMIN" })).status).toBe(404);
    expect((await call("/api/settings/smtp/test", { method: "POST", role: "ADMIN", json: { to: "a@b.test" } })).status).toBe(404);
    expect((await json(await call("/api/settings/config", { role: "ADMIN" }))).smtpSettings).toBe(false);

    await getProvider().send({
      to: "ada@example.com",
      from: process.env.EMAIL_FROM!,
      subject: "Hi",
      html: "<p>Hi</p>",
      text: "Hi",
      headers: {},
      tags: { emailLogId: "log1" },
    });
    expect(h.mockSend).toHaveBeenCalledWith(expect.objectContaining({ from: process.env.EMAIL_FROM }));
    expect(h.sendMail).not.toHaveBeenCalled();
  });
});

describe("secretBox", () => {
  it("round-trips; a wrong key, an edited value or junk give null", () => {
    const sealed = sealSecret("p@ss", "key-1", "smtp-password");
    expect(sealed).not.toContain("p@ss");
    expect(openSecret(sealed, "key-1", "smtp-password")).toBe("p@ss");
    expect(openSecret(sealed, "key-2", "smtp-password")).toBeNull();
    expect(openSecret(sealed, "key-1", "other-purpose")).toBeNull();
    const parts = sealed.split(":");
    parts[3] = Buffer.from("tampered").toString("base64");
    expect(openSecret(parts.join(":"), "key-1", "smtp-password")).toBeNull();
    expect(openSecret("junk", "key-1", "smtp-password")).toBeNull();
    // a fresh IV every time
    expect(sealSecret("p@ss", "key-1", "smtp-password")).not.toBe(sealed);
  });
});
