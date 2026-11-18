import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ConfirmProvider } from "../src/components/confirm";
import { ToastProvider } from "../src/components/toast";
import { api, setAccessToken } from "../src/lib/api";
import { uploadWithProgress } from "../src/lib/whatsappMedia";
import { WhatsAppTemplatesPage } from "../src/pages/WhatsAppTemplates";
import { anyDraftCall, draftCalls, makeDraft, store } from "./templateDraftsFakeApi";

// WhatsApp Templates → New template → Create in Meta with template drafts ON (ENABLE_TEMPLATE_DRAFTS): saved 3 seconds
// after the last change and when the dialog is left; an empty form never is; Resume restores every field; a
// successful Submit to Meta deletes the draft (a failed one keeps it); a media header file is asked for again;
// "Register existing" is unchanged (no drafts). Canned API: nothing reaches Meta.

const state = vi.hoisted(() => ({ role: "ADMIN" as "ADMIN" | "EDITOR", metaFails: false }));

vi.mock("../src/lib/auth", () => ({
  useAuth: () => ({ user: { id: "u-me", role: state.role, email: "me@kagzso.test" }, loading: false, logout: () => undefined }),
}));
vi.mock("../src/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/api")>()),
  api: vi.fn(async (path: string, opts: { method?: string; json?: any } = {}) => {
    const fakeApi = await import("./templateDraftsFakeApi");
    const drafts = await fakeApi.draftApi(path, opts);
    if (drafts !== fakeApi.NOT_MINE) return drafts;
    if (path === "/api/branding") return { labels: { appName: "Kagzso" }, customized: [] };
    if (path === "/api/whatsapp/templates") return { items: [] };
    if (path.startsWith("/api/whatsapp/templates/verify")) return { checkedAt: new Date().toISOString(), error: null, items: [] };
    if (path.startsWith("/api/whatsapp/templates/meta-sync")) return { items: [] };
    if (path === "/api/whatsapp/templates" && opts.method === "POST") return { id: "w-new" };
    return {};
  }),
}));
vi.mock("../src/lib/whatsappMedia", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/whatsappMedia")>()),
  uploadWithProgress: vi.fn(async () => {
    if (state.metaFails) throw new Error("Meta rejected the template");
    return { meta: { id: "meta-1", status: "PENDING" } };
  }),
}));

function renderPage() {
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <ToastProvider>
        <ConfirmProvider>
          <WhatsAppTemplatesPage />
        </ConfirmProvider>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

const calls = () => vi.mocked(api).mock.calls as unknown as unknown[][];
const puts = () => draftCalls(calls(), "PUT");
const deletes = () => draftCalls(calls(), "DELETE");
const metaSubmits = () => vi.mocked(uploadWithProgress).mock.calls;
const sentTemplate = () => JSON.parse(String((metaSubmits()[0][2] as FormData).get("template")));
const type = (el: Element, value: string) => fireEvent.change(el, { target: { value } });
const advance = (ms: number) => act(async () => void (await vi.advanceTimersByTimeAsync(ms)));
const displayName = () => screen.getByPlaceholderText("Company Intro") as HTMLInputElement;
const metaName = () => screen.getByPlaceholderText("company_intro") as HTMLInputElement;
/** The select / input after a form label (labels here aren't linked to their fields). */
function control(label: string): HTMLInputElement {
  let el = screen.getByText(label, { selector: "label" }).nextElementSibling;
  while (el) {
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)) return el as HTMLInputElement;
    const inner = el.querySelector("input, textarea, select");
    if (inner) return inner as HTMLInputElement;
    el = el.nextElementSibling;
  }
  throw new Error(`no field after ${label}`);
}
const dialogTitle = () => screen.getByRole("heading", { level: 2 });

async function openCreate() {
  const view = renderPage();
  await screen.findByRole("tab", { name: /Drafts/ });
  fireEvent.click(screen.getByRole("button", { name: "New template" }));
  await screen.findByRole("button", { name: "Submit to Meta" });
  return view;
}
async function submitToMeta() {
  fireEvent.click(screen.getByRole("button", { name: "Submit to Meta" }));
  fireEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Submit to Meta" }));
}

const FULL = {
  displayName: "Diwali offer",
  name: "diwali_offer_2026",
  nameTouched: true,
  language: "ta",
  category: "UTILITY",
  headerType: "TEXT",
  headerText: "Kagzso",
  headerFileName: null,
  body: "Hi {{1}}, {{2}} has a Diwali offer for you.",
  vars: [
    { field: "full_name", example: "Karthick R" },
    { field: "business_name", example: "Kagzso" },
  ],
  footer: "Reply STOP to opt out",
  buttons: [
    { type: "QUICK_REPLY", text: "Yes please", url: "", phone_number: "" },
    { type: "URL", text: "See offer", url: "https://kagzso.com/diwali", phone_number: "" },
    { type: "PHONE_NUMBER", text: "Call us", url: "", phone_number: "+919876543210" },
  ],
};

beforeEach(() => {
  store.reset();
  state.role = "ADMIN";
  state.metaFails = false;
  vi.mocked(api).mockClear();
  vi.mocked(uploadWithProgress).mockClear();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  cleanup();
});

describe("auto-save (Create in Meta)", () => {
  it("saves 3 seconds after the last change and shows Draft saved in the dialog header", async () => {
    await openCreate();
    vi.useFakeTimers();
    type(displayName(), "Company intro");
    await advance(2999);
    expect(puts()).toHaveLength(0);
    await advance(1);
    expect(puts()).toHaveLength(1);
    expect(puts()[0][1]).toMatchObject({
      notify: false,
      json: { channel: "whatsapp", name: "Company intro", state: { displayName: "Company intro", language: "en", category: "MARKETING", body: "Hi {{1}}, " } },
    });
    vi.useRealTimers();
    await waitFor(() => expect(dialogTitle().textContent).toMatch(/New WhatsApp template\s*Draft saved \d{1,2}:\d{2}/));
  });

  it("saves at once when the dialog is closed, and sends a keepalive save on refresh", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 200 }));
    setAccessToken("tok-wa");
    await openCreate();
    type(screen.getByPlaceholderText("AI | Automation | App Development"), "Thanks!");
    fireEvent(window, new Event("pagehide"));
    const sent = fetchSpy.mock.calls.filter(([u]) => String(u).startsWith("/api/template-drafts/"));
    expect(sent).toHaveLength(1);
    expect(sent[0][1]).toMatchObject({ method: "PUT", keepalive: true });
    expect(JSON.parse(String(sent[0][1]!.body)).state.footer).toBe("Thanks!");

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(puts()).toHaveLength(1));
    expect(puts()[0][1]!.json.state.footer).toBe("Thanks!");
    setAccessToken(null);
  });

  it("never saves the form as New template opened it", async () => {
    await openCreate();
    vi.useFakeTimers();
    await advance(10_000);
    vi.useRealTimers();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await new Promise((r) => setTimeout(r, 250));
    expect(puts()).toHaveLength(0);
  });

  it("Register existing is unchanged: nothing typed there is saved", async () => {
    await openCreate();
    fireEvent.click(screen.getByRole("tab", { name: "Register existing" }));
    type(control("Name"), "Registered one");
    type(control("Body preview"), "Hi there");
    vi.useFakeTimers();
    await advance(10_000);
    vi.useRealTimers();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await new Promise((r) => setTimeout(r, 250));
    expect(puts()).toHaveLength(0);
  });
});

describe("resume", () => {
  it("restores every field; Submit to Meta sends them all and then deletes the draft", async () => {
    store.drafts = [makeDraft({ id: "draft-wa", channel: "whatsapp", name: "Diwali offer", state: FULL })];
    renderPage();
    fireEvent.click(await screen.findByRole("tab", { name: /Drafts/ }));
    fireEvent.click(within((await screen.findByText("Diwali offer")).closest("tr")!).getByRole("button", { name: "Resume" }));
    await screen.findByRole("button", { name: "Submit to Meta" });

    expect(displayName().value).toBe("Diwali offer");
    expect(metaName().value).toBe("diwali_offer_2026");
    expect(control("Category").value).toBe("UTILITY");
    expect(control("Language").value).toBe("ta");
    expect(control("Header (optional)").value).toBe("TEXT");
    expect(screen.getByPlaceholderText("Kagzso")).toHaveProperty("value", "Kagzso");
    expect(document.querySelector("textarea")!.value).toBe(FULL.body);
    expect((screen.getByLabelText("Variable 1 filled from") as HTMLSelectElement).value).toBe("full_name");
    expect((screen.getByLabelText("Variable 2 filled from") as HTMLSelectElement).value).toBe("business_name");
    expect(screen.getAllByPlaceholderText("Example for Meta, e.g. Karthick").map((e) => (e as HTMLInputElement).value)).toEqual(["Karthick R", "Kagzso"]);
    expect(screen.getByPlaceholderText("AI | Automation | App Development")).toHaveProperty("value", "Reply STOP to opt out");
    expect(screen.getByLabelText("Custom button text")).toHaveProperty("value", "Yes please");
    expect(screen.getByLabelText("Visit website button text")).toHaveProperty("value", "See offer");
    expect(screen.getByLabelText("Website address")).toHaveProperty("value", "https://kagzso.com/diwali");
    expect(screen.getByLabelText("Call phone number button text")).toHaveProperty("value", "Call us");
    expect(screen.getByLabelText("Phone number")).toHaveProperty("value", "+919876543210");

    await submitToMeta();
    await waitFor(() => expect(deletes()).toHaveLength(1));
    expect(sentTemplate()).toMatchObject({
      displayName: "Diwali offer",
      name: "diwali_offer_2026",
      language: "ta",
      category: "UTILITY",
      headerType: "TEXT",
      headerText: "Kagzso",
      body: FULL.body,
      variables: FULL.vars,
      footer: "Reply STOP to opt out",
      buttons: [
        { type: "QUICK_REPLY", text: "Yes please" },
        { type: "URL", text: "See offer", url: "https://kagzso.com/diwali" },
        { type: "PHONE_NUMBER", text: "Call us", phone_number: "+919876543210" },
      ],
    });
    expect(deletes()[0][0]).toBe("/api/template-drafts/draft-wa");
    expect(store.drafts).toEqual([]);
    await new Promise((r) => setTimeout(r, 250));
    expect(puts()).toHaveLength(0);
  });

  it("a media header asks for its file again; Submit stays blocked until it is attached", async () => {
    store.drafts = [
      makeDraft({ id: "draft-img", channel: "whatsapp", name: "With image", state: { ...FULL, displayName: "With image", headerType: "IMAGE", headerText: "", headerFileName: "banner.jpg" } }),
    ];
    renderPage();
    fireEvent.click(await screen.findByRole("tab", { name: /Drafts/ }));
    fireEvent.click(within((await screen.findByText("With image")).closest("tr")!).getByRole("button", { name: "Resume" }));
    expect(await screen.findByText("Attach the file again: drafts don't keep files (it was banner.jpg).")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Submit to Meta" }));
    expect(await screen.findByText(/Attach the header image/)).toBeTruthy();
    expect(metaSubmits()).toHaveLength(0);
    expect(deletes()).toHaveLength(0);
  });

  it("a failed Submit to Meta keeps the draft", async () => {
    state.metaFails = true;
    store.drafts = [makeDraft({ id: "draft-wa", channel: "whatsapp", name: "Diwali offer", state: FULL })];
    renderPage();
    fireEvent.click(await screen.findByRole("tab", { name: /Drafts/ }));
    fireEvent.click(within((await screen.findByText("Diwali offer")).closest("tr")!).getByRole("button", { name: "Resume" }));
    await screen.findByRole("button", { name: "Submit to Meta" });
    await submitToMeta();
    expect(await screen.findByText("Meta rejected the template")).toBeTruthy();
    expect(deletes()).toHaveLength(0);
    expect(store.drafts).toHaveLength(1);
  });
});

describe("Continue your draft?", () => {
  it("Continue draft opens Create in Meta with the draft, even if Register existing was used last", async () => {
    await openCreate();
    fireEvent.click(screen.getByRole("tab", { name: "Register existing" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull());

    store.drafts = [makeDraft({ id: "draft-wa", channel: "whatsapp", name: "Diwali offer", state: FULL })];
    fireEvent.click(screen.getByRole("button", { name: "New template" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByText("Continue your draft?")).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Continue draft" }));
    await screen.findByRole("button", { name: "Submit to Meta" });
    expect(displayName().value).toBe("Diwali offer");
  });

  it("Start new opens a blank Create in Meta form and keeps the draft", async () => {
    store.drafts = [makeDraft({ id: "draft-wa", channel: "whatsapp", name: "Diwali offer", state: FULL })];
    renderPage();
    await screen.findByRole("tab", { name: /Drafts/ });
    fireEvent.click(screen.getByRole("button", { name: "New template" }));
    fireEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Start new" }));
    await screen.findByRole("button", { name: "Submit to Meta" });
    expect(displayName().value).toBe("");
    expect(store.drafts).toHaveLength(1);
  });

  it("only this page's drafts: an email draft isn't offered here", async () => {
    store.drafts = [makeDraft({ id: "draft-email", channel: "email", name: "Email one" })];
    await openCreate();
    expect(screen.queryByRole("alertdialog")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    fireEvent.click(screen.getByRole("tab", { name: /Drafts/ }));
    expect(await screen.findByText("No drafts")).toBeTruthy();
  });
});

describe("access", () => {
  it("editors get no Drafts tab and no draft requests, even with the flag on", async () => {
    state.role = "EDITOR";
    renderPage();
    await screen.findByRole("button", { name: "New template" });
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByRole("tab", { name: /Drafts/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "New template" }));
    await screen.findByText("Body preview", { selector: "label" });
    type(control("Name"), "Editor typed");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await new Promise((r) => setTimeout(r, 250));
    expect(anyDraftCall(calls())).toEqual([]);
  });
});
