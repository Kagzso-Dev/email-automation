import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { ConfirmProvider } from "../src/components/confirm";
import { ToastProvider } from "../src/components/toast";
import { api } from "../src/lib/api";
import { uploadWithProgress } from "../src/lib/whatsappMedia";
import { TemplatesPage } from "../src/pages/Templates";
import { WhatsAppTemplatesPage } from "../src/pages/WhatsAppTemplates";
import { anyDraftCall, makeDraft, store } from "./templateDraftsFakeApi";

// Template drafts OFF (ENABLE_TEMPLATE_DRAFTS unset / false, or an API without the feature): both templates pages
// behave exactly as before. No Drafts tab, no "Continue your draft?", no "Draft saved" note, and the only drafts
// request is GET /config: nothing is saved on a change, on closing the form, or on a refresh, and creating a template
// deletes nothing. Drafts already stored are not offered or touched.

vi.mock("../src/lib/auth", () => ({
  useAuth: () => ({ user: { id: "u-me", role: "ADMIN", email: "me@kagzso.test" }, loading: false, logout: () => undefined }),
}));
vi.mock("../src/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/api")>()),
  api: vi.fn(async (path: string, opts: { method?: string; json?: any } = {}) => {
    const fakeApi = await import("./templateDraftsFakeApi");
    const drafts = await fakeApi.draftApi(path, opts);
    if (drafts !== fakeApi.NOT_MINE) return drafts;
    const method = opts.method ?? "GET";
    if (path === "/api/image-size-controls/config") return { enabled: false };
    if (path === "/api/templates" && method === "GET") return { items: [] };
    if (path === "/api/templates" && method === "POST") return { id: "t-new", ...opts.json };
    if (path === "/api/branding") return { labels: { appName: "Kagzso" }, customized: [] };
    if (path === "/api/whatsapp/templates") return { items: [] };
    if (path.startsWith("/api/whatsapp/templates/verify")) return { checkedAt: new Date().toISOString(), error: null, items: [] };
    if (path.startsWith("/api/whatsapp/templates/meta-sync")) return { items: [] };
    return {};
  }),
}));
vi.mock("../src/lib/whatsappMedia", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/whatsappMedia")>()),
  uploadWithProgress: vi.fn(async () => ({ meta: { id: "meta-1", status: "PENDING" } })),
}));

const wrap = (page: JSX.Element) =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <ToastProvider>
        <ConfirmProvider>
          <MemoryRouter>{page}</MemoryRouter>
        </ConfirmProvider>
      </ToastProvider>
    </QueryClientProvider>,
  );
const calls = () => vi.mocked(api).mock.calls as unknown as unknown[][];
const configAsked = () => vi.mocked(api).mock.calls.some(([p]) => p === "/api/template-drafts/config");
const type = (el: Element, value: string) => fireEvent.change(el, { target: { value } });
function field(label: string): HTMLInputElement {
  let el = screen.getByText(label, { selector: "label" }).nextElementSibling;
  while (el && !/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)) el = el.nextElementSibling;
  return el as HTMLInputElement;
}
const wait = (ms: number) => act(async () => void (await vi.advanceTimersByTimeAsync(ms)));

beforeEach(() => {
  store.reset();
  // A recent draft of your own is stored on both pages: with the flag off it must never be offered or touched.
  store.drafts = [
    makeDraft({ id: "draft-email", channel: "email", name: "Stored email", editedMinutesAgo: 5 }),
    makeDraft({ id: "draft-wa", channel: "whatsapp", name: "Stored WA", editedMinutesAgo: 5 }),
  ];
  vi.mocked(api).mockClear();
  vi.mocked(uploadWithProgress).mockClear();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  cleanup();
});

describe.each([
  ["flag false", false],
  ["config endpoint fails (an API without the feature)", "error"],
] as const)("%s", (_label, flag) => {
  beforeEach(() => {
    store.flag = flag;
  });

  it("Templates (email): no tabs, New template opens at once, nothing saved, Create deletes nothing", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 200 }));
    const view = wrap(<TemplatesPage />);
    await screen.findByText("Select a template or create a new one.");
    await waitFor(() => expect(configAsked()).toBe(true));
    expect(screen.queryByRole("tablist")).toBeNull();
    expect(view.container.querySelector(".grid")!.className).toBe("grid gap-6 lg:grid-cols-[260px_1fr]");

    fireEvent.click(screen.getByRole("button", { name: "New template" }));
    await screen.findByText("Declared variables (optional)"); // no "Continue your draft?" first
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(field("Name").value).toBe("");

    vi.useFakeTimers();
    type(field("Name"), "Not a draft");
    type(field("Subject"), "Hello");
    await wait(10_000);
    fireEvent(window, new Event("pagehide"));
    fireEvent(window, new Event("beforeunload"));
    vi.useRealTimers();
    expect(screen.queryByText(/Draft saved|Draft not saved|Saving draft/)).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    await waitFor(() => expect(vi.mocked(api).mock.calls.some(([p, o]) => p === "/api/templates" && (o as { method?: string })?.method === "POST")).toBe(true));
    await new Promise((r) => setTimeout(r, 50));
    view.unmount();
    await new Promise((r) => setTimeout(r, 50));

    expect(anyDraftCall(calls())).toEqual([]);
    expect(fetchSpy.mock.calls.filter(([u]) => String(u).includes("template-drafts"))).toEqual([]);
    expect(store.drafts.map((d) => d.id)).toEqual(["draft-email", "draft-wa"]);
  });

  it("WhatsApp Templates: no tabs, Create in Meta opens at once, nothing saved, Submit to Meta as before", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 200 }));
    wrap(<WhatsAppTemplatesPage />);
    await screen.findByText("No WhatsApp templates yet");
    await waitFor(() => expect(configAsked()).toBe(true));
    expect(screen.queryByRole("tab", { name: /Drafts/ })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "New template" }));
    await screen.findByRole("button", { name: "Submit to Meta" });
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect((screen.getByPlaceholderText("Company Intro") as HTMLInputElement).value).toBe("");

    vi.useFakeTimers();
    type(screen.getByPlaceholderText("Company Intro"), "Company intro");
    const examples = screen.getAllByPlaceholderText("Example for Meta, e.g. Karthick");
    type(examples[0], "Karthick");
    await wait(10_000);
    fireEvent(window, new Event("pagehide"));
    vi.useRealTimers();
    expect(screen.getByRole("heading", { level: 2 }).textContent).toBe("New WhatsApp template");

    fireEvent.click(screen.getByRole("button", { name: "Submit to Meta" }));
    fireEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Submit to Meta" }));
    await waitFor(() => expect(vi.mocked(uploadWithProgress)).toHaveBeenCalledTimes(1));
    await new Promise((r) => setTimeout(r, 250)); // the dialog closes

    expect(anyDraftCall(calls())).toEqual([]);
    expect(fetchSpy.mock.calls.filter(([u]) => String(u).includes("template-drafts"))).toEqual([]);
    expect(store.drafts.map((d) => d.id)).toEqual(["draft-email", "draft-wa"]);
  });
});
