import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { Layout, NAV_GROUPS } from "../src/components/Layout";
import { ApiError } from "../src/lib/api";
import { navForRole } from "../src/lib/navAccess";
import { AUTOMATION_NAV_GROUP, withAutomationGroup } from "../src/lib/automation";

// Sidebar "Automation" section (ENABLE_AUTOMATION): LinkedIn Automation + Instagram Automation, foldable like
// "Calls · English", right after Main (Dashboard, Data Quality, …) and before Email. Flag off — GET
// /api/automation/config answers 404 — the menu is exactly as before. Admins and editors both get it.

const state = vi.hoisted(() => ({ automation: "off" as "off" | "on" | "error", role: "ADMIN" }));

vi.mock("../src/lib/auth", () => ({
  useAuth: () => ({ user: { role: state.role, email: "a@example.com" }, loading: false, logout: () => undefined }),
}));
vi.mock("../src/lib/api", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/lib/api")>();
  return {
    ...real,
    api: vi.fn(async (path: string) => {
      if (path === "/api/settings/sidebar") return { hiddenItems: [] };
      if (path === "/api/branding") return { labels: { appName: "Kagzso" }, customized: [] };
      if (path === "/api/ai-calls/config") return { enabled: false, configured: false, canStart: false, flowEditor: false, languages: [] };
      if (path === "/api/whatsapp/inbox/unread-count") return { messages: 0, conversations: 0 };
      if (path === "/api/import-filter/config") return { enabled: false };
      if (path === "/api/automation/config") {
        if (state.automation === "off") throw new real.ApiError(404, "Automation not found");
        if (state.automation === "error") throw new Error("network down");
        return { enabled: true, linkedin: { adsConfigured: true, dmAvailable: false, dmReason: "x" }, instagram: { adsConfigured: true, messagingConfigured: true, humanAgentEnabled: false } };
      }
      throw new Error(`unexpected API call: ${path}`);
    }),
  };
});

beforeEach(() => {
  localStorage.clear();
  state.automation = "off";
  state.role = "ADMIN";
});
afterEach(() => cleanup());

function renderAt(path: string) {
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter initialEntries={[path]}>
        <Layout>
          <p>page</p>
        </Layout>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}
const nav = () => screen.getByRole("navigation", { name: "Main" });
const headings = () => within(nav()).getAllByRole("group").map((g) => (g.getAttribute("aria-labelledby") ? document.getElementById(g.getAttribute("aria-labelledby")!)?.textContent : ""));
const links = () => within(nav()).getAllByRole("link").map((a) => a.getAttribute("href"));

describe("withAutomationGroup", () => {
  it("flag off: the very same menu object (nothing added, nothing moved)", () => {
    expect(withAutomationGroup(NAV_GROUPS, false, AUTOMATION_NAV_GROUP)).toBe(NAV_GROUPS);
  });
  it("flag on: one foldable 'Automation' section right after Main; every other section unchanged", () => {
    const on = withAutomationGroup(NAV_GROUPS, true, AUTOMATION_NAV_GROUP);
    expect(on.map((g) => g.label)).toEqual(["Main", "Automation", "Email", "WhatsApp", "Calls", "System"]);
    expect(on.filter((g) => g.label !== "Automation")).toEqual(NAV_GROUPS);
    expect(on[1]).toMatchObject({
      collapsible: true,
      items: [
        { to: "/automation/linkedin", label: "LinkedIn Automation", brand: "linkedin" },
        { to: "/automation/instagram", label: "Instagram Automation", brand: "instagram" },
      ],
    });
  });
  it("admins and editors both keep it", () => {
    for (const role of ["ADMIN", "EDITOR"]) {
      const g = navForRole(withAutomationGroup(NAV_GROUPS, true, AUTOMATION_NAV_GROUP), role).find((x) => x.label === "Automation");
      expect(g?.items.map((i) => i.to)).toEqual(["/automation/linkedin", "/automation/instagram"]);
    }
  });
});

describe("rendered sidebar", () => {
  for (const mode of ["off", "error"] as const) {
    it(`flag ${mode === "off" ? "off (404)" : "unreadable (error)"}: no Automation section, the sections and links as before`, async () => {
      state.automation = mode;
      renderAt("/");
      await screen.findByText("Data Quality");
      expect(screen.queryByText("Automation")).toBeNull();
      expect(screen.queryByText("LinkedIn Automation")).toBeNull();
      expect(headings()).toEqual(["Main", "Email", "WhatsApp", "System"]);
      expect(links().some((h) => h?.startsWith("/automation"))).toBe(false);
    });
  }

  it("flag on: 'Automation' between Main and Email, closed until clicked, with both brand items", async () => {
    state.automation = "on";
    renderAt("/");
    const toggle = await screen.findByRole("button", { name: "Automation" });
    expect(headings()).toEqual(["Main", "Automation", "Email", "WhatsApp", "System"]);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    const li = screen.getByRole("link", { name: "LinkedIn Automation" });
    const ig = screen.getByRole("link", { name: "Instagram Automation" });
    expect(li.getAttribute("href")).toBe("/automation/linkedin");
    expect(ig.getAttribute("href")).toBe("/automation/instagram");
    // Brand marks (LinkedIn blue square, Instagram gradient), not the shared icon set.
    expect(li.querySelector('rect[fill="#0A66C2"]')).not.toBeNull();
    expect(ig.querySelector("linearGradient")).not.toBeNull();
  });

  it("flag on, on one of its pages: the section opens by itself", async () => {
    state.automation = "on";
    renderAt("/automation/instagram");
    const toggle = await screen.findByRole("button", { name: "Automation" });
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
  });

  it("flag on, editor: the section is there too", async () => {
    state.automation = "on";
    state.role = "EDITOR";
    renderAt("/");
    expect(await screen.findByRole("button", { name: "Automation" })).toBeTruthy();
  });
});

// Keep the import used (ApiError is what the real API client throws for a 404).
void ApiError;
