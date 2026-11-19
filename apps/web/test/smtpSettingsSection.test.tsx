import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ConfirmProvider } from "../src/components/confirm";
import { api } from "../src/lib/api";
import { SmtpSettingsSection, type SmtpSettingsView } from "../src/components/SmtpSettingsSection";

// Settings → Email (SMTP): admins edit the SMTP account; editors only see it's admin-only; ENABLE_SMTP_SETTINGS=false
// hides it. The password is write-only: never shown, only sent when typed. lib/api is mocked.

const state = vi.hoisted(() => ({
  role: "ADMIN" as "ADMIN" | "EDITOR",
  enabled: true,
  view: null as unknown,
  test: { ok: true, provider: "smtp", providerMessageId: "<m1>" } as unknown,
}));

vi.mock("../src/lib/auth", () => ({
  useAuth: () => ({ user: { role: state.role, email: "boss@kagzso.test" }, loading: false, logout: () => undefined }),
}));
vi.mock("../src/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/api")>()),
  api: vi.fn(async (path: string, opts: { method?: string; json?: Record<string, unknown> } = {}) => {
    const method = opts.method ?? "GET";
    if (path === "/api/settings/config") return { smtpSettings: state.enabled };
    if (path === "/api/settings/smtp" && method === "GET") return state.view;
    if (path === "/api/settings/smtp" && method === "PUT") {
      return { ...(state.view as object), ...opts.json, hasPassword: true, saved: ["host"], source: "database" };
    }
    if (path === "/api/settings/smtp/test") return state.test;
    return {};
  }),
}));

const VIEW: SmtpSettingsView = {
  provider: "smtp",
  envProvider: "smtp",
  host: "smtp.gmail.com",
  port: 587,
  secure: false,
  user: "sales@kagzso.test",
  from: "Kagzso <sales@kagzso.test>",
  hasPassword: true,
  passwordSource: "database",
  passwordUnreadable: false,
  saved: ["host", "port", "secure", "user", "password", "from"],
  source: "database",
  updatedBy: "boss@kagzso.test",
  updatedAt: "2026-11-19T08:00:00Z",
};

function renderSection(isAdmin = state.role === "ADMIN") {
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <ConfirmProvider>
        <SmtpSettingsSection isAdmin={isAdmin} />
      </ConfirmProvider>
    </QueryClientProvider>,
  );
}
const asked = () => vi.mocked(api).mock.calls.map(([path]) => path);
const writes = () =>
  vi
    .mocked(api)
    .mock.calls.filter(([, o]) => (o as { method?: string } | undefined)?.method === "PUT")
    .map(([, o]) => (o as { json: Record<string, unknown> }).json);
const settle = () => new Promise((r) => setTimeout(r, 30));

beforeEach(() => {
  state.role = "ADMIN";
  state.enabled = true;
  state.view = { ...VIEW };
  state.test = { ok: true, provider: "smtp", providerMessageId: "<m1>" };
  vi.mocked(api).mockClear();
});
afterEach(cleanup);

describe("Settings → Email (SMTP)", () => {
  it("kill switch off: renders nothing and never asks for the SMTP settings", async () => {
    state.enabled = false;
    renderSection();
    await settle();
    expect(screen.queryByRole("heading", { name: "Email (SMTP)" })).toBeNull();
    expect(asked()).not.toContain("/api/settings/smtp");
  });

  it("editors: only the admin-only note — no fields, and the settings are never fetched", async () => {
    state.role = "EDITOR";
    renderSection(false);
    expect(await screen.findByText(/Only admins can see and change the email \(SMTP\) account/)).toBeTruthy();
    expect(screen.queryByLabelText("SMTP server")).toBeNull();
    expect(asked()).not.toContain("/api/settings/smtp");
  });

  it("admins: fields filled from the server, the password field empty, Save off until something changes", async () => {
    renderSection();
    const host = (await screen.findByLabelText("SMTP server")) as HTMLInputElement;
    expect(host.value).toBe("smtp.gmail.com");
    expect((screen.getByLabelText("Username") as HTMLInputElement).value).toBe("sales@kagzso.test");
    expect((screen.getByLabelText("From address") as HTMLInputElement).value).toBe("Kagzso <sales@kagzso.test>");
    const password = screen.getByLabelText("Password") as HTMLInputElement;
    expect(password.value).toBe("");
    expect(password.placeholder).toBe("Saved — type to replace");
    expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/Sending through/)).toBeTruthy();
  });

  it("Save without typing a password doesn't send one (the saved password is kept)", async () => {
    renderSection();
    fireEvent.change(await screen.findByLabelText("SMTP server"), { target: { value: "smtp.office365.com" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0]).toEqual({
      host: "smtp.office365.com",
      port: 587,
      secure: false,
      user: "sales@kagzso.test",
      from: "Kagzso <sales@kagzso.test>",
    });
  });

  it("a typed password is sent; switching to SSL/TLS moves 587 to 465", async () => {
    renderSection();
    fireEvent.change(await screen.findByLabelText("Encryption"), { target: { value: "ssl" } });
    expect((screen.getByLabelText("Port") as HTMLInputElement).value).toBe("465");
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "new-app-pass" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0]).toMatchObject({ port: 465, secure: true, password: "new-app-pass" });
  });

  it("mock sending: says plainly that no real email goes out", async () => {
    state.view = { ...VIEW, provider: "mock", envProvider: "mock", host: null, saved: [], source: "environment" };
    renderSection();
    expect(await screen.findByText(/Emails are not being sent/)).toBeTruthy();
  });

  it("test email: goes to the admin by default and shows the server's error when it fails", async () => {
    state.test = { ok: false, provider: "smtp", error: "SMTP rejected (EAUTH): Invalid login" };
    renderSection();
    const to = (await screen.findByLabelText("Send a test email to")) as HTMLInputElement;
    expect(to.value).toBe("boss@kagzso.test");
    fireEvent.click(screen.getByRole("button", { name: "Send test email" }));
    expect(await screen.findByText(/Sending failed — SMTP rejected \(EAUTH\): Invalid login/)).toBeTruthy();
    const call = vi.mocked(api).mock.calls.find(([p]) => p === "/api/settings/smtp/test");
    expect((call?.[1] as { json: unknown }).json).toEqual({ to: "boss@kagzso.test" });
  });
});
