import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { ConfirmProvider } from "../src/components/confirm";
import { ToastProvider } from "../src/components/toast";
import { api } from "../src/lib/api";
import { LinkedInAutomationPage } from "../src/pages/LinkedInAutomation";
import { InstagramAutomationPage } from "../src/pages/InstagramAutomation";

// LinkedIn Automation / Instagram Automation pages (ENABLE_AUTOMATION). Flag off or another role → Dashboard.
// Connection states (not connected, token expired), campaigns with status / spend / results, Pause / Resume behind a
// confirm, Create campaign. DM: LinkedIn's button is disabled with the reason; Instagram's composer only lets people
// inside the 24-hour window be picked, and nothing is sent before the confirm step shows the recipient count.

const H = 3_600_000;
const iso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();
const inFuture = (ms: number) => new Date(Date.now() + ms).toISOString();

const s = vi.hoisted(() => ({
  flag: true,
  role: "ADMIN",
  liConfigured: true,
  liTokenExpired: false,
  campaignsError: null as null | { status: number; message: string },
}));

const CONFIG = () => ({
  enabled: true,
  linkedin: { adsConfigured: s.liConfigured, dmAvailable: false, dmReason: "LinkedIn has no public messaging API: only approved partners." },
  instagram: { adsConfigured: true, messagingConfigured: true, humanAgentEnabled: false },
});

vi.mock("../src/lib/auth", () => ({ useAuth: () => ({ user: { role: s.role, email: "a@example.com" }, loading: false, logout: () => undefined }) }));
vi.mock("../src/lib/api", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/lib/api")>();
  return {
    ...real,
    api: vi.fn(async (path: string, opts?: { method?: string; json?: any }) => {
      const method = opts?.method ?? "GET";
      if (path === "/api/automation/config") {
        if (!s.flag) throw new real.ApiError(404, "Automation not found");
        return CONFIG();
      }
      if (path === "/api/automation/linkedin/status") {
        const ads = !s.liConfigured
          ? { configured: false, connected: false, account: null, error: null }
          : s.liTokenExpired
            ? { configured: true, connected: false, account: null, error: { code: "token_invalid", message: "LinkedIn rejected the access token (expired or revoked)." } }
            : { configured: true, connected: true, account: { id: "111", name: "Kagzso LI", currency: "INR", status: "ACTIVE" }, error: null };
        return { platform: "linkedin", ads, dm: { available: false, reason: CONFIG().linkedin.dmReason } };
      }
      if (path === "/api/automation/instagram/status")
        return {
          platform: "instagram",
          ads: { configured: true, connected: true, account: { id: "act_222", name: "Kagzso Ads", currency: "USD", status: "ACTIVE" }, error: null },
          messaging: { configured: true, connected: true, account: { id: "444", username: "kagzso" }, error: null },
          dm: { available: true, reason: null, humanAgentEnabled: false },
        };
      if (path.endsWith("/campaigns") && method === "GET") {
        if (s.campaignsError) throw new real.ApiError(s.campaignsError.status, s.campaignsError.message);
        return path.includes("linkedin")
          ? {
              metricsError: null,
              currency: "INR",
              campaigns: [
                { id: "501", name: "LI Webinar", status: "ACTIVE", state: "active", objective: "WEBSITE_VISIT", dailyBudget: 50, currency: "INR", spend: 123.45, impressions: 1000, clicks: 40, conversions: 5, canPause: true, canResume: false },
              ],
            }
          : {
              metricsError: null,
              currency: "USD",
              campaigns: [
                { id: "601", name: "IG Reels", status: "PAUSED", state: "paused", objective: "OUTCOME_TRAFFIC", dailyBudget: 25, currency: "USD", spend: 12.5, impressions: 900, clicks: 30, conversions: 4, placement: "instagram", canPause: false, canResume: true },
                { id: "602", name: "FB only", status: "ACTIVE", state: "active", objective: "OUTCOME_LEADS", dailyBudget: 10, currency: "USD", spend: 1, impressions: 1, clicks: 1, conversions: 0, placement: "other", canPause: true, canResume: false },
              ],
            };
      }
      if (path === "/api/automation/linkedin/campaign-groups") return { groups: [{ id: "9", name: "Default group", status: "ACTIVE" }] };
      if (path.endsWith("/campaigns") && method === "POST") return { id: "777", status: "DRAFT" };
      if (/\/campaigns\/\d+\/(pause|resume)$/.test(path)) return { ok: true };
      if (path === "/api/automation/instagram/conversations")
        return {
          now: new Date().toISOString(),
          humanAgentEnabled: false,
          recipients: [
            { recipientId: "9001", username: "recent_fan", lastInboundAt: iso(1 * H), window: "open", windowEndsAt: inFuture(23.5 * H) },
            { recipientId: "9002", username: "two_days", lastInboundAt: iso(48 * H), window: "human_agent", windowEndsAt: inFuture(120 * H) },
            { recipientId: "9003", username: "ten_days", lastInboundAt: iso(240 * H), window: "closed", windowEndsAt: null },
          ],
        };
      if (path === "/api/automation/instagram/dm/preview")
        return {
          recipients: opts!.json.recipientIds.map((id: string) => ({ recipientId: id, username: id === "9001" ? "recent_fan" : id, allowed: id === "9001", tag: null, window: "open", reason: null, reasonText: null })),
          sendable: opts!.json.recipientIds.filter((id: string) => id === "9001").length,
          blocked: 0,
          confirmToken: "123.signed",
          expiresAt: inFuture(600_000),
        };
      if (path === "/api/automation/instagram/dm")
        return { batchId: "b1", sent: 1, failed: 0, blocked: 0, results: [{ recipientId: "9001", username: "recent_fan", status: "sent", error: null }] };
      if (path.startsWith("/api/automation/instagram/dm/history")) return { items: [], total: 0, page: 1, pageSize: 25 };
      throw new Error(`unexpected API call: ${method} ${path}`);
    }),
  };
});

function renderAt(path: string) {
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <ToastProvider>
        <ConfirmProvider>
          <MemoryRouter initialEntries={[path]}>
            <Routes>
              <Route path="/" element={<p>dashboard</p>} />
              <Route path="/automation/linkedin" element={<LinkedInAutomationPage />} />
              <Route path="/automation/instagram" element={<InstagramAutomationPage />} />
            </Routes>
          </MemoryRouter>
        </ConfirmProvider>
      </ToastProvider>
    </QueryClientProvider>,
  );
}
const calls = () => vi.mocked(api).mock.calls.map(([p, o]) => `${(o as { method?: string } | undefined)?.method ?? "GET"} ${p}`);

beforeEach(() => {
  Object.assign(s, { flag: true, role: "ADMIN", liConfigured: true, liTokenExpired: false, campaignsError: null });
  vi.mocked(api).mockClear();
});
afterEach(cleanup);

describe("access", () => {
  it("flag off: both addresses go to the Dashboard, nothing else is asked for", async () => {
    s.flag = false;
    for (const path of ["/automation/linkedin", "/automation/instagram"]) {
      renderAt(path);
      expect(await screen.findByText("dashboard")).toBeTruthy();
      cleanup();
    }
    expect(calls().every((c) => c === "GET /api/automation/config")).toBe(true);
  });
  it("a role other than admin / editor: Dashboard", async () => {
    s.role = "VIEWER";
    renderAt("/automation/instagram");
    expect(await screen.findByText("dashboard")).toBeTruthy();
  });
  it("editor: the page", async () => {
    s.role = "EDITOR";
    renderAt("/automation/linkedin");
    expect(await screen.findByRole("heading", { name: "LinkedIn Automation" })).toBeTruthy();
  });
});

describe("LinkedIn Automation", () => {
  it("connected: account, campaigns with status / spend / results", async () => {
    renderAt("/automation/linkedin");
    expect(await screen.findByText("Kagzso LI · INR · ACTIVE")).toBeTruthy();
    const row = (await screen.findByText("LI Webinar")).closest("tr")!;
    expect(within(row).getByText("ACTIVE")).toBeTruthy();
    expect(within(row).getByText(/123\.45/)).toBeTruthy();
    expect(within(row).getByText("5")).toBeTruthy();
    for (const h of ["Campaign", "Status", "Daily budget", "Spend", "Results"]) expect(screen.getByRole("columnheader", { name: h })).toBeTruthy();
  });

  it("DM button: disabled, with the reason as its tooltip; LinkedIn messaging is never called", async () => {
    renderAt("/automation/linkedin");
    const dm = await screen.findByRole("button", { name: "DM (LinkedIn message)" });
    expect((dm as HTMLButtonElement).disabled).toBe(true);
    const desc = document.getElementById(dm.getAttribute("aria-describedby")!);
    expect(desc?.textContent).toMatch(/no public messaging API/);
    expect(calls().some((c) => c.includes("/dm"))).toBe(false);
  });

  it("not connected: says what an admin sets, Create campaign is disabled, campaigns never asked for", async () => {
    s.liConfigured = false;
    renderAt("/automation/linkedin");
    expect(await screen.findByText("Not connected", { selector: "div" })).toBeTruthy();
    expect(screen.getByText(/LINKEDIN_ACCESS_TOKEN and LINKEDIN_AD_ACCOUNT_ID/)).toBeTruthy();
    expect((screen.getByRole("button", { name: "Create campaign" }) as HTMLButtonElement).disabled).toBe(true);
    expect(calls().some((c) => c.endsWith("/campaigns"))).toBe(false);
  });

  it("token expired: 'Token expired' with what to do", async () => {
    s.liTokenExpired = true;
    renderAt("/automation/linkedin");
    expect(await screen.findByText("Token expired")).toBeTruthy();
    expect(screen.getAllByText(/rejected the access token/).length).toBeGreaterThan(0);
  });

  it("a rate limit on the campaigns shows the error, not a blank page", async () => {
    s.campaignsError = { status: 429, message: "LinkedIn rate limit reached — try again in 42 s." };
    renderAt("/automation/linkedin");
    expect(await screen.findByText("LinkedIn rate limit reached — try again in 42 s.")).toBeTruthy();
  });

  it("Create campaign: picks a group, says it starts as a draft, posts the form", async () => {
    renderAt("/automation/linkedin");
    await screen.findByText("LI Webinar");
    fireEvent.click(screen.getByRole("button", { name: "Create campaign" }));
    expect(await screen.findByText(/created as a draft/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Spring" } });
    fireEvent.change(await screen.findByLabelText("Campaign group"), { target: { value: "9" } });
    fireEvent.change(screen.getByLabelText(/Daily budget/), { target: { value: "20" } });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    await waitFor(() => expect(calls()).toContain("POST /api/automation/linkedin/campaigns"));
    const [, opts] = vi.mocked(api).mock.calls.find(([p, o]) => p === "/api/automation/linkedin/campaigns" && (o as any)?.method === "POST")!;
    expect((opts as any).json).toEqual({ name: "Spring", objective: "BRAND_AWARENESS", dailyBudget: 20, campaignGroupId: "9" });
  });

  it("Pause asks first; cancelling sends nothing", async () => {
    renderAt("/automation/linkedin");
    fireEvent.click(await screen.findByRole("button", { name: "Pause" }));
    expect(await screen.findByText("Pause “LI Webinar”?")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByText("Pause “LI Webinar”?")).toBeNull());
    expect(calls().some((c) => c.includes("/pause"))).toBe(false);
  });
});

/** The DM button is re-created once the connection check says messaging is connected (it loses its tooltip). */
async function openDm() {
  const dmButton = () => screen.getByRole("button", { name: "DM (Instagram direct message)" }) as HTMLButtonElement;
  await waitFor(() => expect(dmButton().disabled).toBe(false));
  fireEvent.click(dmButton());
}

describe("Instagram Automation", () => {
  it("campaigns: Instagram-capable ones by default, the rest behind a checkbox; Resume warns about spending", async () => {
    renderAt("/automation/instagram");
    expect(await screen.findByText("IG Reels")).toBeTruthy();
    expect(screen.queryByText("FB only")).toBeNull();
    fireEvent.click(screen.getByLabelText(/Also show campaigns without Instagram placements/));
    expect(screen.getByText("FB only")).toBeTruthy();

    fireEvent.click(screen.getAllByRole("button", { name: "Resume" })[0]!);
    expect(await screen.findByText(/spending its budget/)).toBeTruthy();
    fireEvent.click(screen.getAllByRole("button", { name: "Resume" }).at(-1)!); // the confirm dialog's button
    await waitFor(() => expect(calls()).toContain("POST /api/automation/instagram/campaigns/601/resume"));
  });

  it("DM: only people inside the 24-hour window can be picked; nothing is sent before 'Send to N'", async () => {
    renderAt("/automation/instagram");
    await openDm();

    expect(await screen.findByText(/within 24 hours/)).toBeTruthy();
    const open = await screen.findByLabelText("@recent_fan");
    const humanAgent = screen.getByLabelText("@two_days");
    const closed = screen.getByLabelText("@ten_days");
    expect((open as HTMLInputElement).disabled).toBe(false);
    expect((humanAgent as HTMLInputElement).disabled).toBe(true); // human agent replies not enabled
    expect((closed as HTMLInputElement).disabled).toBe(true);
    expect(screen.getByText(/Within 24 h · 23 h left/)).toBeTruthy();
    expect(screen.getByText("Window closed")).toBeTruthy();

    fireEvent.click(open);
    fireEvent.change(screen.getByLabelText("Message"), { target: { value: "Thanks for writing!" } });
    fireEvent.click(screen.getByRole("button", { name: "Review (1)" }));

    expect(await screen.findByText("Send to 1 recipient?")).toBeTruthy();
    expect(calls()).toContain("POST /api/automation/instagram/dm/preview");
    expect(calls()).not.toContain("POST /api/automation/instagram/dm");

    fireEvent.click(screen.getByRole("button", { name: "Send to 1" }));
    await waitFor(() => expect(calls()).toContain("POST /api/automation/instagram/dm"));
    const [, opts] = vi.mocked(api).mock.calls.find(([p]) => p === "/api/automation/instagram/dm")!;
    expect((opts as any).json).toEqual({ recipientIds: ["9001"], message: "Thanks for writing!", useHumanAgentTag: false, confirmToken: "123.signed", confirmCount: 1 });
    expect(await screen.findByLabelText("Send result")).toBeTruthy();
  });

  it("DM: a message over 1000 bytes can't be reviewed", async () => {
    renderAt("/automation/instagram");
    await openDm();
    fireEvent.click(await screen.findByLabelText("@recent_fan"));
    fireEvent.change(screen.getByLabelText("Message"), { target: { value: "é".repeat(501) } });
    expect(screen.getByText("1002 / 1000 bytes")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Review (1)" }) as HTMLButtonElement).disabled).toBe(true);
  });
});
