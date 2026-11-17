import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { ConfirmProvider } from "../src/components/confirm";
import { api } from "../src/lib/api";
import { SettingsPage } from "../src/pages/Settings";
import { ContactImportStatus } from "../src/pages/Contacts";

// Settings → Domain mode (ENABLE_DOMAIN_BLOCKLIST): one switch, "Email all domains except blocked ones".
// OFF = the Approved list is active and the Blocked list hidden; ON = the Blocked list is shown and the
// Approved list is greyed out as inactive. Flag off: Settings looks exactly as before. lib/api is mocked.

const SWITCH = "Email all domains except blocked ones";
const WARNING = "All domains will be emailed except blocked ones. This may affect deliverability.";

const state = vi.hoisted(() => ({
  role: "ADMIN" as "ADMIN" | "EDITOR",
  view: { enabled: false } as Record<string, unknown>,
  approved: [] as { id: string; domain: string; createdAt: string }[],
  importJob: null as unknown,
}));

vi.mock("../src/lib/auth", () => ({
  useAuth: () => ({ user: { role: state.role, email: "a@example.com" }, loading: false, logout: () => undefined }),
}));
vi.mock("../src/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/api")>()),
  api: vi.fn(async (path: string, opts: { method?: string } = {}) => {
    const method = opts.method ?? "GET";
    if (path === "/api/settings/sending-domains" && method === "GET") return state.view;
    if (path.startsWith("/api/settings/sending-domains")) return {};
    if (path === "/api/settings/allowed-domains") return { items: state.approved };
    if (path.startsWith("/api/contacts/import/")) return state.importJob;
    if (path === "/api/ai-calls/config") return { enabled: false, configured: false, canStart: false, flowEditor: false, languages: [] };
    return { items: [], hiddenItems: [], labels: {}, customized: [], bulkSend: { minDelaySec: 1, maxDelaySec: 2 } };
  }),
}));
// Sections with data of their own, unrelated to this.
vi.mock("../src/components/CostRatesSection", () => ({ CostRatesSection: () => null }));
vi.mock("../src/components/UserAdminSections", () => ({ ChangePasswordSection: () => null, UsersSection: () => null }));
vi.mock("../src/components/BrandingSection", () => ({ BrandingSection: () => null }));
vi.mock("../src/components/CallRecordingsSection", () => ({ CallRecordingsSection: () => null }));
vi.mock("../src/components/AiCallLanguagesSection", () => ({ AiCallLanguagesSection: () => null }));
vi.mock("../src/components/VoiceResponseTuningSection", () => ({ VoiceResponseTuningSection: () => null }));

const client = () => new QueryClient({ defaultOptions: { queries: { retry: false } } });
function renderSettings() {
  render(
    <QueryClientProvider client={client()}>
      <ConfirmProvider>
        <MemoryRouter>
          <SettingsPage />
        </MemoryRouter>
      </ConfirmProvider>
    </QueryClientProvider>,
  );
}
/** The Approved list section (its heading may carry the "Inactive" badge). */
const approvedSection = async () =>
  (await screen.findByRole("heading", { name: /Approved sending domains/ })).closest("section") as HTMLElement;
const settle = () => new Promise((r) => setTimeout(r, 30));
const writes = () =>
  vi
    .mocked(api)
    .mock.calls.filter(([, o]) => o && (o as { method?: string }).method && (o as { method?: string }).method !== "GET")
    .map(([path, o]) => [path, (o as { method: string }).method, (o as { json?: unknown }).json]);

beforeEach(() => {
  state.role = "ADMIN";
  state.view = { enabled: false };
  state.approved = [{ id: "a1", domain: "ok.com", createdAt: "2026-11-01T00:00:00Z" }];
  vi.mocked(api).mockClear();
});
afterEach(cleanup);

describe("kill switch (ENABLE_DOMAIN_BLOCKLIST=false)", () => {
  it("Settings is exactly as before: no switch, no Blocked list, the Approved list active", async () => {
    renderSettings();
    const approved = await approvedSection();
    await settle();
    expect(screen.queryByRole("switch", { name: SWITCH })).toBeNull();
    expect(screen.queryByRole("heading", { name: "Blocked domains" })).toBeNull();
    expect(screen.queryByText("Inactive")).toBeNull();
    expect(approved.className).not.toContain("opacity-60");
    expect(within(approved).getByText(/Contacts are only emailed when their address domain is on this list/)).toBeTruthy();
    expect(within(approved).getByText("@ok.com")).toBeTruthy();
  });
});

describe("flag on", () => {
  it("switch OFF: the Approved list is active and the Blocked list hidden", async () => {
    state.view = { enabled: true, mode: "ALLOWLIST", blocked: [], lastModeChange: null, history: [] };
    renderSettings();
    const sw = await screen.findByRole("switch", { name: SWITCH });
    expect(sw.getAttribute("aria-checked")).toBe("false");
    expect(screen.queryByRole("heading", { name: "Blocked domains" })).toBeNull();
    const approved = await approvedSection();
    expect(within(approved).queryByText("Inactive")).toBeNull();
    expect(approved.className).not.toContain("opacity-60");
  });

  it("before the database update (migration 0036): the switch shows, disabled, with what to run", async () => {
    state.view = { enabled: true, ready: false, mode: "ALLOWLIST", blocked: [], lastModeChange: null };
    renderSettings();
    const sw = await screen.findByRole("switch", { name: SWITCH });
    expect((sw as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByRole("alert").textContent).toContain("npm run prisma:deploy");
    fireEvent.click(sw);
    await settle();
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(writes()).toEqual([]);
  });

  it("turning it ON asks first with the deliverability warning; Cancel changes nothing", async () => {
    state.view = { enabled: true, mode: "ALLOWLIST", blocked: [], lastModeChange: null, history: [] };
    renderSettings();
    fireEvent.click(await screen.findByRole("switch", { name: SWITCH }));
    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByText(WARNING)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull()); // it answers after its exit animation
    expect(writes()).toEqual([]);
    expect(screen.getByRole("switch", { name: SWITCH }).getAttribute("aria-checked")).toBe("false");

    fireEvent.click(screen.getByRole("switch", { name: SWITCH }));
    fireEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Turn on" }));
    await waitFor(() =>
      expect(writes()).toEqual([["/api/settings/sending-domains/mode", "PUT", { mode: "BLOCKLIST" }]]),
    );
  });

  it("switch ON: the Blocked list is shown, the Approved list greyed out as inactive, and an empty list warns", async () => {
    state.view = {
      enabled: true,
      mode: "BLOCKLIST",
      blocked: [],
      lastModeChange: { id: "e1", action: "MODE_CHANGED", detail: "BLOCKLIST", userEmail: "boss@example.com", createdAt: "2026-11-17T09:00:00Z" },
      history: [],
    };
    renderSettings();
    const sw = await screen.findByRole("switch", { name: SWITCH });
    expect(sw.getAttribute("aria-checked")).toBe("true");
    expect(screen.getByText(/Last changed by boss@example.com/)).toBeTruthy();
    expect(await screen.findByRole("heading", { name: "Blocked domains" })).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toBe("The blocked list is empty, so every domain is emailed.");

    const approved = await approvedSection();
    expect(within(approved).getByText("Inactive")).toBeTruthy();
    expect(approved.className).toContain("opacity-60");
    expect(within(approved).getByText(/Not used while “Email all domains except blocked ones” is on/)).toBeTruthy();
  });

  it("throwaway suggestions fill the box but are never added on their own", async () => {
    state.view = { enabled: true, mode: "BLOCKLIST", blocked: [], lastModeChange: null, history: [] };
    renderSettings();
    const input = (await screen.findByLabelText("Domain to block")) as HTMLInputElement;
    expect(input.placeholder).toBe("mailinator.com");
    fireEvent.click(screen.getByRole("button", { name: "tempmail.com" }));
    expect(input.value).toBe("tempmail.com");
    await settle();
    expect(writes()).toEqual([]);

    fireEvent.click(screen.getByRole("button", { name: "Block domain" }));
    await waitFor(() =>
      expect(writes()).toEqual([["/api/settings/sending-domains/blocked", "POST", { domain: "tempmail.com" }]]),
    );
  });

  it("a filled Blocked list: no empty warning, listed domains are not suggested again", async () => {
    state.view = {
      enabled: true,
      mode: "BLOCKLIST",
      blocked: [{ id: "b1", domain: "mailinator.com", createdAt: "2026-11-17T09:00:00Z" }],
      lastModeChange: null,
      history: [],
    };
    renderSettings();
    expect(await screen.findByText("@mailinator.com")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByRole("button", { name: "mailinator.com" })).toBeNull();
    expect(screen.getByRole("button", { name: "tempmail.com" })).toBeTruthy();
  });

  it("turning it OFF goes straight back to the Approved list", async () => {
    state.view = { enabled: true, mode: "BLOCKLIST", blocked: [], lastModeChange: null, history: [] };
    renderSettings();
    fireEvent.click(await screen.findByRole("switch", { name: SWITCH }));
    await waitFor(() =>
      expect(writes()).toEqual([["/api/settings/sending-domains/mode", "PUT", { mode: "ALLOWLIST" }]]),
    );
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("non-admins see the mode but cannot change it", async () => {
    state.role = "EDITOR";
    state.view = { enabled: true, mode: "BLOCKLIST", blocked: [], lastModeChange: null };
    renderSettings();
    const sw = await screen.findByRole("switch", { name: SWITCH });
    expect((sw as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText("Only admins can change the domain mode.")).toBeTruthy();
    expect(screen.queryByLabelText("Domain to block")).toBeNull();
  });
});

describe("Contacts → Import file summary", () => {
  const renderImport = () =>
    render(
      <QueryClientProvider client={client()}>
        <ContactImportStatus jobId="job-1" filename="contacts.csv" onDismiss={() => {}} />
      </QueryClientProvider>,
    );
  const result = { totalRows: 10, maxRows: 1000, selectedRows: 10, skippedOverLimit: 0, created: 5, updated: 0, duplicates: 0, skipped: 2, rejectedDomain: 3, failed: 5 };

  it("BLOCKLIST mode says 'skipped: blocked domain'", async () => {
    state.importJob = { jobId: "job-1", state: "COMPLETED", failedReason: null, result: { ...result, domainMode: "BLOCKLIST" } };
    renderImport();
    const line = await screen.findByText(/5 new/);
    expect(line.textContent).toContain("3 skipped: blocked domain");
    expect(line.textContent).toContain("2 without a valid email address");
    expect(line.textContent).not.toContain("approved list");
  });

  it("otherwise the wording is as before", async () => {
    state.importJob = { jobId: "job-1", state: "COMPLETED", failedReason: null, result };
    renderImport();
    const line = await screen.findByText(/5 new/);
    expect(line.textContent).toContain("3 with an email domain not on the approved list (Settings)");
    expect(line.textContent).toContain("2 without an email address");
  });
});
