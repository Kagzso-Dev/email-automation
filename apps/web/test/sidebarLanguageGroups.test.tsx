import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { CollapsibleNavGroup, Layout } from "../src/components/Layout";

// Sidebar: each AI call language section ("Calls · English", "Calls · Tamil") folds open/closed under its
// heading, on its own, remembered per browser; the page you're on is never folded away. Every other section
// keeps its plain heading. lib/api is mocked: nothing reaches the API.

vi.mock("../src/lib/auth", () => ({
  useAuth: () => ({ user: { role: "ADMIN", email: "a@example.com" }, loading: false, logout: () => undefined }),
}));
vi.mock("../src/lib/api", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/lib/api")>();
  return {
    ...real,
    api: vi.fn(async (path: string) => {
      if (path === "/api/settings/sidebar") return { hiddenItems: [] };
      if (path === "/api/branding") return { labels: { appName: "Kagzso" }, customized: [] };
      if (path === "/api/ai-calls/config")
        return {
          enabled: true,
          configured: true,
          canStart: true,
          flowEditor: true,
          languages: [
            { code: "en", name: "English", configured: true, enabled: true },
            { code: "ta", name: "Tamil", configured: true, enabled: true },
          ],
        };
      if (path === "/api/whatsapp/inbox/unread-count") return { messages: 0, conversations: 0 };
      if (path === "/api/import-filter/config") return { enabled: false };
      throw new Error(`unexpected API call: ${path}`);
    }),
  };
});

const KEY = "dispatch:sidebar-groups-open";

beforeEach(() => localStorage.clear());
afterEach(() => cleanup());

function renderAt(path: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[path]}>
        <Layout>
          <p>page</p>
        </Layout>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}
const menu = () => within(screen.getByRole("navigation", { name: "Main" }));
const toggle = (name: string) => menu().findByRole("button", { name });
const region = (button: HTMLElement) => document.getElementById(button.getAttribute("aria-controls")!)!;
const folded = (button: HTMLElement) =>
  button.getAttribute("aria-expanded") === "false" && region(button).className.split(" ").includes("invisible");

describe("sidebar: language sections fold", () => {
  it("both start open; only the two language headings are toggles", async () => {
    renderAt("/");
    const en = await toggle("Calls · English");
    const ta = await toggle("Calls · Tamil");
    expect(en.getAttribute("aria-expanded")).toBe("true");
    expect(ta.getAttribute("aria-expanded")).toBe("true");
    // Each section's three links sit in the region its toggle controls.
    expect(within(region(en)).getAllByRole("link").map((a) => a.getAttribute("href"))).toEqual([
      "/ai-call-customers",
      "/call-flows",
      "/ai-agents",
    ]);
    expect(within(region(ta)).getAllByRole("link").map((a) => a.getAttribute("href"))).toEqual([
      "/ta/ai-call-customers",
      "/ta/call-flows",
      "/ta/ai-agents",
    ]);
    // Main, Email, WhatsApp and System keep plain headings: no other button in the menu.
    expect(menu().getAllByRole("button")).toEqual([en, ta]);
    // The section is still named by its heading.
    expect(menu().getByRole("group", { name: "Calls · Tamil" })).toBeTruthy();
  });

  it("each opens and closes on its own, and the choice is remembered", async () => {
    renderAt("/");
    const en = await toggle("Calls · English");
    const ta = await toggle("Calls · Tamil");
    fireEvent.click(ta);
    expect(folded(ta)).toBe(true);
    expect(en.getAttribute("aria-expanded")).toBe("true");
    expect(JSON.parse(localStorage.getItem(KEY)!)).toEqual({ "Calls · Tamil": false });

    fireEvent.click(ta);
    expect(ta.getAttribute("aria-expanded")).toBe("true");
    expect(region(ta).className.split(" ")).not.toContain("invisible");
    expect(JSON.parse(localStorage.getItem(KEY)!)).toEqual({ "Calls · Tamil": true });
  });

  it("a section folded earlier stays folded after a reload", async () => {
    localStorage.setItem(KEY, JSON.stringify({ "Calls · English": false }));
    renderAt("/");
    expect(folded(await toggle("Calls · English"))).toBe(true);
    expect((await toggle("Calls · Tamil")).getAttribute("aria-expanded")).toBe("true");
  });

  it("the section holding the current page opens even if it was folded", async () => {
    localStorage.setItem(KEY, JSON.stringify({ "Calls · English": false, "Calls · Tamil": false }));
    renderAt("/ta/call-flows");
    expect((await toggle("Calls · Tamil")).getAttribute("aria-expanded")).toBe("true");
    expect(folded(await toggle("Calls · English"))).toBe(true); // "/call-flows" isn't "/ta/call-flows"
  });

  it("unreadable storage just means the defaults", async () => {
    localStorage.setItem(KEY, "not json");
    renderAt("/");
    expect((await toggle("Calls · English")).getAttribute("aria-expanded")).toBe("true");
  });
});

describe("CollapsibleNavGroup", () => {
  const group = (props: { defaultOpen?: boolean; active?: boolean }) =>
    render(
      <CollapsibleNavGroup labelId="g" label="Calls · Hindi" {...props}>
        <a href="/hi/call-flows">Voice Call Flows</a>
      </CollapsibleNavGroup>,
    );

  it("defaultOpen={false} starts folded", () => {
    group({ defaultOpen: false });
    expect(folded(screen.getByRole("button", { name: "Calls · Hindi" }))).toBe(true);
  });

  it("but not when the current page is inside it", () => {
    group({ defaultOpen: false, active: true });
    expect(screen.getByRole("button", { name: "Calls · Hindi" }).getAttribute("aria-expanded")).toBe("true");
  });
});
