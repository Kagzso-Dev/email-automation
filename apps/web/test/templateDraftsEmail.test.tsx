import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { ConfirmProvider } from "../src/components/confirm";
import { api, setAccessToken } from "../src/lib/api";
import { TemplatesPage } from "../src/pages/Templates";
import { anyDraftCall, draftCalls, makeDraft, ME, OTHER, store } from "./templateDraftsFakeApi";

// Templates (email) with template drafts ON (ENABLE_TEMPLATE_DRAFTS): a new template is saved as a draft 3 seconds
// after the last change and when the form is left; an empty form never is; Resume restores every field; creating the
// template deletes its draft; "Continue your draft?"; the 10-minute warning; the Drafts tab; a failed save only
// shows "Draft not saved". The API is a canned in-memory fake.

const state = vi.hoisted(() => ({ templates: [] as Record<string, unknown>[], postFails: false }));

vi.mock("../src/lib/auth", () => ({
  useAuth: () => ({ user: { id: "u-me", role: "ADMIN", email: "me@kagzso.test" }, loading: false, logout: () => undefined }),
}));
vi.mock("../src/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/api")>()),
  api: vi.fn(async (path: string, opts: { method?: string; json?: any } = {}) => {
    const drafts = await (await import("./templateDraftsFakeApi")).draftApi(path, opts);
    if (drafts !== (await import("./templateDraftsFakeApi")).NOT_MINE) return drafts;
    const method = opts.method ?? "GET";
    if (path === "/api/image-size-controls/config") return { enabled: false };
    if (path === "/api/templates" && method === "GET") return { items: state.templates };
    if (path === "/api/templates" && method === "POST") {
      if (state.postFails) throw new Error("Validation failed");
      const t = { id: "t-new", ...opts.json, htmlBody: "<p>x</p>" };
      state.templates.push(t);
      return t;
    }
    return {};
  }),
}));

function renderPage() {
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <ConfirmProvider>
        <MemoryRouter>
          <TemplatesPage />
        </MemoryRouter>
      </ConfirmProvider>
    </QueryClientProvider>,
  );
}

const calls = () => vi.mocked(api).mock.calls as unknown as unknown[][];
const puts = () => draftCalls(calls(), "PUT");
const deletes = () => draftCalls(calls(), "DELETE");
const posts = () => vi.mocked(api).mock.calls.filter(([p, o]) => p === "/api/templates" && (o as { method?: string })?.method === "POST");
/** The input / textarea after a form label (labels here aren't linked to their fields). */
function field(label: string): HTMLInputElement {
  let el = screen.getByText(label, { selector: "label" }).nextElementSibling;
  while (el && !/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)) el = el.nextElementSibling;
  return el as HTMLInputElement;
}
const type = (el: HTMLElement, value: string) => fireEvent.change(el, { target: { value } });

async function openNewForm() {
  const view = renderPage();
  await screen.findByRole("tab", { name: /Drafts/ }); // the flag has loaded
  fireEvent.click(screen.getByRole("button", { name: "New template" }));
  await screen.findByText("Declared variables (optional)");
  return view;
}
/** Advance fake timers inside act, letting the saves' promises settle. */
const advance = (ms: number) => act(async () => void (await vi.advanceTimersByTimeAsync(ms)));

beforeEach(() => {
  store.reset();
  state.templates = [];
  state.postFails = false;
  vi.mocked(api).mockClear();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  cleanup();
});

describe("auto-save", () => {
  it("saves 3 seconds after the last change, not before; each change restarts the wait", async () => {
    await openNewForm();
    vi.useFakeTimers({ shouldAdvanceTime: false });
    type(field("Name"), "Spring offer");
    await advance(2000);
    type(field("Subject"), "Hello {{first_name}}");
    await advance(2900);
    expect(puts()).toHaveLength(0);
    await advance(100);
    expect(puts()).toHaveLength(1);
    const [path, opts] = puts()[0];
    expect(path).toMatch(/^\/api\/template-drafts\/[A-Za-z0-9_-]{8,64}$/);
    expect(opts!.json).toMatchObject({ channel: "email", name: "Spring offer", state: { name: "Spring offer", subject: "Hello {{first_name}}", kind: "LETTER" } });
    expect(opts!.notify).toBe(false); // never a toast
    vi.useRealTimers();
    expect(await screen.findByText(/^Draft saved \d{1,2}:\d{2}/)).toBeTruthy();
    // Unchanged: nothing more to save.
    await new Promise((r) => setTimeout(r, 50));
    expect(puts()).toHaveLength(1);
  });

  it("saves at once when the editor is closed, and when the page is left", async () => {
    await openNewForm();
    type(field("Name"), "Closing test");
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    await waitFor(() => expect(puts()).toHaveLength(1));
    expect(puts()[0][1]!.json.state.name).toBe("Closing test");

    cleanup();
    vi.mocked(api).mockClear();
    store.drafts = [];
    const view = await openNewForm();
    type(field("Name"), "Navigating away");
    view.unmount(); // another page in the app
    await waitFor(() => expect(puts()).toHaveLength(1));
    expect(puts()[0][1]!.json.state.name).toBe("Navigating away");
  });

  it("refresh / closed tab: sends a keepalive save with the sign-in, once", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 200 }));
    setAccessToken("tok-123");
    await openNewForm();
    type(field("Name"), "Refreshed");
    fireEvent(window, new Event("beforeunload"));
    fireEvent(window, new Event("pagehide"));
    const sent = fetchSpy.mock.calls.filter(([u]) => String(u).startsWith("/api/template-drafts/"));
    expect(sent).toHaveLength(1);
    const [, init] = sent[0];
    expect(init).toMatchObject({ method: "PUT", keepalive: true, credentials: "include" });
    expect((init!.headers as Record<string, string>).Authorization).toBe("Bearer tok-123");
    expect(JSON.parse(String(init!.body))).toMatchObject({ channel: "email", name: "Refreshed", state: { name: "Refreshed" } });
    setAccessToken(null);
  });

  it("never saves an empty form: not after waiting, not on close, not on refresh, not after undoing a change", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 200 }));
    await openNewForm();
    vi.useFakeTimers();
    await advance(10_000);
    type(field("Name"), "x");
    await advance(1000);
    type(field("Name"), ""); // back to how New template opened
    await advance(10_000);
    fireEvent(window, new Event("pagehide"));
    vi.useRealTimers();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    await new Promise((r) => setTimeout(r, 50));
    expect(puts()).toHaveLength(0);
    expect(fetchSpy.mock.calls.filter(([u]) => String(u).includes("template-drafts"))).toHaveLength(0);
  });

  it("a failed save shows Draft not saved (no toast) and never blocks Create", async () => {
    store.putFails = true;
    await openNewForm();
    vi.useFakeTimers();
    type(field("Name"), "Offline");
    await advance(3000);
    vi.useRealTimers();
    expect(await screen.findByText("Draft not saved")).toBeTruthy();
    expect(puts()[0][1]!.notify).toBe(false);
    type(field("Subject"), "Still works");
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    await waitFor(() => expect(posts()).toHaveLength(1));
  });
});

const FULL_STATE = {
  name: "Webinar invite",
  kind: "MEETING",
  subject: "Join us, {{first_name}}",
  bodyText: "Hi {{first_name}},\n\nWe'd love to see you.",
  signature: "Cheers,\nKagzso",
  textBody: "Plain version",
  links: [{ label: "Agenda", url: "https://kagzso.com/agenda" }],
  meeting: {
    title: "Kagzso webinar",
    startAt: "2026-12-01T15:00",
    endAt: "2026-12-01T16:00",
    timezone: "Asia/Kolkata",
    joinUrl: "https://meet.google.com/abc",
    location: "Online",
    description: "Q&A at the end",
  },
  images: [{ url: "https://cdn.kagzso.com/banner.png" }],
  videos: [{ url: "https://youtu.be/xyz", label: "Watch the demo" }],
  variables: ["webinar_date"],
};

describe("resume", () => {
  it("restores every field, saves nothing until it changes, and creating the template deletes the draft", async () => {
    store.drafts = [makeDraft({ id: "draft-full", name: "Webinar invite", state: FULL_STATE })];
    renderPage();
    fireEvent.click(await screen.findByRole("tab", { name: /Drafts/ }));
    const row = (await screen.findByText("Webinar invite")).closest("tr")!;
    fireEvent.click(within(row).getByRole("button", { name: "Resume" }));
    await screen.findByText("Meeting details");

    expect(field("Name").value).toBe("Webinar invite");
    expect(field("Subject").value).toBe("Join us, {{first_name}}");
    expect(field("Message").value).toBe(FULL_STATE.bodyText);
    expect(field("Closing / regards (optional)").value).toBe(FULL_STATE.signature);
    expect(field("Plain-text body (optional)").value).toBe("Plain version");
    expect(screen.getByDisplayValue("webinar_date")).toBeTruthy();
    expect(screen.getByDisplayValue("https://cdn.kagzso.com/banner.png")).toBeTruthy();
    expect(screen.getByDisplayValue("https://youtu.be/xyz")).toBeTruthy();
    expect(screen.getByDisplayValue("Watch the demo")).toBeTruthy();
    expect(screen.getByDisplayValue("Agenda")).toBeTruthy();
    expect(screen.getByDisplayValue("https://kagzso.com/agenda")).toBeTruthy();
    for (const v of Object.values(FULL_STATE.meeting)) expect(screen.getByDisplayValue(v)).toBeTruthy();

    await new Promise((r) => setTimeout(r, 50));
    expect(puts()).toHaveLength(0);

    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    await waitFor(() => expect(deletes()).toHaveLength(1));
    // What Create sent is the whole restored form.
    expect(posts()[0][1]).toMatchObject({
      json: {
        ...FULL_STATE,
        images: ["https://cdn.kagzso.com/banner.png"],
        videos: [{ url: "https://youtu.be/xyz", label: "Watch the demo" }],
      },
    });
    expect(deletes()[0][0]).toBe("/api/template-drafts/draft-full");
    expect(store.drafts).toEqual([]);
    await new Promise((r) => setTimeout(r, 50));
    expect(puts()).toHaveLength(0); // the editor closing doesn't bring it back
  });

  it("creating a new template deletes the draft it autosaved; a failed Create keeps it", async () => {
    await openNewForm();
    vi.useFakeTimers();
    type(field("Name"), "Launch");
    type(field("Subject"), "We launched");
    await advance(3000);
    vi.useRealTimers();
    expect(store.drafts).toHaveLength(1);
    const id = store.drafts[0].id;

    state.postFails = true;
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    await screen.findByText("Validation failed");
    expect(deletes()).toHaveLength(0);
    expect(store.drafts).toHaveLength(1);

    state.postFails = false;
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    await waitFor(() => expect(deletes()).toHaveLength(1));
    expect(deletes()[0][0]).toBe(`/api/template-drafts/${id}`);
    expect(store.drafts).toEqual([]);
    await new Promise((r) => setTimeout(r, 50));
    const lastPut = calls().map(([p, o]) => `${(o as { method?: string })?.method ?? "GET"} ${p}`).lastIndexOf(`PUT /api/template-drafts/${id}`);
    const del = calls().map(([p, o]) => `${(o as { method?: string })?.method ?? "GET"} ${p}`).lastIndexOf(`DELETE /api/template-drafts/${id}`);
    expect(lastPut).toBeLessThan(del);
  });

  it("warns before resuming a draft someone else edited in the last 10 minutes", async () => {
    store.drafts = [
      makeDraft({ id: "draft-busy", name: "Busy one", ownerId: OTHER.id, ownerEmail: OTHER.email, lastEditedById: OTHER.id, lastEditedByEmail: OTHER.email, editedMinutesAgo: 3, state: { ...FULL_STATE, name: "Busy one" } }),
    ];
    renderPage();
    fireEvent.click(await screen.findByRole("tab", { name: /Drafts/ }));
    fireEvent.click(within((await screen.findByText("Busy one")).closest("tr")!).getByRole("button", { name: "Resume" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByText("Someone else is editing this draft")).toBeTruthy();
    expect(within(dialog).getByText(/other@kagzso\.test edited it 3 minutes ago/)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(screen.queryByText("Meeting details")).toBeNull();

    const resume = within(screen.getByText("Busy one").closest("tr")!).getByRole("button", { name: "Resume" }) as HTMLButtonElement;
    await waitFor(() => expect(resume.disabled).toBe(false));
    fireEvent.click(resume);
    fireEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Resume anyway" }));
    await screen.findByText("Meeting details");
    expect(field("Name").value).toBe("Busy one");
  });

  it("no warning for a draft someone else edited longer ago, or one you edited last", async () => {
    store.drafts = [
      makeDraft({ id: "draft-old-other", name: "Quiet one", lastEditedById: OTHER.id, lastEditedByEmail: OTHER.email, editedMinutesAgo: 11, state: { name: "Quiet one" } }),
    ];
    renderPage();
    fireEvent.click(await screen.findByRole("tab", { name: /Drafts/ }));
    fireEvent.click(within((await screen.findByText("Quiet one")).closest("tr")!).getByRole("button", { name: "Resume" }));
    await screen.findByText("Declared variables (optional)");
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });
});

describe("Continue your draft?", () => {
  it("New template offers your recent draft: Continue draft opens it", async () => {
    store.drafts = [makeDraft({ id: "draft-mine", name: "My draft", state: { ...FULL_STATE, name: "My draft" } })];
    renderPage();
    await screen.findByRole("tab", { name: /Drafts/ });
    fireEvent.click(screen.getByRole("button", { name: "New template" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByText("Continue your draft?")).toBeTruthy();
    expect(within(dialog).getByText(/“My draft”/)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Continue draft" }));
    await screen.findByText("Meeting details");
    expect(field("Name").value).toBe("My draft");
  });

  it("Start new opens a blank form and keeps the draft", async () => {
    store.drafts = [makeDraft({ id: "draft-mine", name: "My draft", state: { ...FULL_STATE, name: "My draft" } })];
    renderPage();
    await screen.findByRole("tab", { name: /Drafts/ });
    fireEvent.click(screen.getByRole("button", { name: "New template" }));
    fireEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Start new" }));
    await screen.findByText("Declared variables (optional)");
    expect(field("Name").value).toBe("");
    expect(screen.queryByText("Meeting details")).toBeNull();
    expect(store.drafts).toHaveLength(1);
    expect(deletes()).toHaveLength(0);
  });

  it("isn't offered for a draft older than 7 days, or someone else's", async () => {
    store.drafts = [
      makeDraft({ id: "draft-old", name: "Old", editedMinutesAgo: 8 * 24 * 60 }),
      makeDraft({ id: "draft-theirs", name: "Theirs", ownerId: OTHER.id, ownerEmail: OTHER.email, editedMinutesAgo: 5 }),
    ];
    renderPage();
    await screen.findByRole("tab", { name: /Drafts/ });
    fireEvent.click(screen.getByRole("button", { name: "New template" }));
    await screen.findByText("Declared variables (optional)");
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });
});

describe("Drafts tab", () => {
  it("count badge, newest first, Untitled draft, owner, last edited (by), footer note", async () => {
    store.drafts = [
      makeDraft({ id: "draft-a", name: null, editedMinutesAgo: 5 }),
      makeDraft({ id: "draft-b", name: "Named one", ownerId: OTHER.id, ownerEmail: OTHER.email, lastEditedById: ME.id, lastEditedByEmail: ME.email, editedMinutesAgo: 120 }),
    ];
    renderPage();
    const tab = await screen.findByRole("tab", { name: /Drafts/ });
    await waitFor(() => expect(within(tab).getByText("2")).toBeTruthy());
    fireEvent.click(tab);
    const rows = (await screen.findAllByRole("row")).slice(1);
    expect(screen.getAllByRole("columnheader").map((h) => h.textContent)).toEqual(["Name", "Owner", "Last edited", ""]);
    expect(within(rows[0]).getByText("Untitled draft")).toBeTruthy();
    expect(within(rows[0]).getByText(ME.email)).toBeTruthy();
    expect(within(rows[1]).getByText("Named one")).toBeTruthy();
    expect(within(rows[1]).getByText(OTHER.email)).toBeTruthy();
    expect(within(rows[1]).getByText(`by ${ME.email}`)).toBeTruthy();
    expect(screen.getByText("Drafts are deleted 30 days after they were last edited.")).toBeTruthy();
  });

  it("Delete asks first; Cancel keeps the draft", async () => {
    store.drafts = [makeDraft({ id: "draft-x", name: "Delete me" })];
    renderPage();
    fireEvent.click(await screen.findByRole("tab", { name: /Drafts/ }));
    const row = (await screen.findByText("Delete me")).closest("tr")!;
    fireEvent.click(within(row).getByRole("button", { name: "Delete" }));
    let dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByText('Delete "Delete me"?')).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(deletes()).toHaveLength(0);

    fireEvent.click(within(screen.getByText("Delete me").closest("tr")!).getByRole("button", { name: "Delete" }));
    dialog = await screen.findByRole("alertdialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(deletes()).toHaveLength(1));
    expect(await screen.findByText("No drafts")).toBeTruthy();
  });

  it("an open editor keeps its work while you look at the Drafts tab", async () => {
    await openNewForm();
    type(field("Name"), "Half done");
    fireEvent.click(screen.getByRole("tab", { name: /Drafts/ }));
    fireEvent.click(screen.getByRole("tab", { name: "Templates" }));
    expect(field("Name").value).toBe("Half done");
  });

  it("before the migration: the Drafts tab says what to run; New template and Create still work", async () => {
    store.listFails = "Template drafts need a database update — run `npm run prisma:deploy` (migration 0039), then reload.";
    store.putFails = true;
    renderPage();
    fireEvent.click(await screen.findByRole("tab", { name: /Drafts/ }));
    expect(await screen.findByText(/migration 0039/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "New template" }));
    await screen.findByText("Declared variables (optional)");
    type(field("Name"), "Works anyway");
    type(field("Subject"), "Hi");
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(anyDraftCall(calls()).every(([p]) => !String(p).includes("/api/templates"))).toBe(true);
  });
});
