import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { ConfirmProvider } from "../src/components/confirm";
import { api } from "../src/lib/api";
import { TemplatesPage } from "../src/pages/Templates";

// Templates → "Images (optional)" with the image size controls OFF (ENABLE_IMAGE_SIZE_CONTROLS).
// The snapshots were recorded BEFORE the feature existed: with the flag off (or its config
// endpoint failing), the Images section and what Save sends must stay exactly as they were.

const state = vi.hoisted(() => ({
  config: { enabled: false } as { enabled: boolean } | "error",
  templates: [] as Record<string, unknown>[],
}));

vi.mock("../src/lib/auth", () => ({
  useAuth: () => ({ user: { role: "ADMIN", email: "a@example.com" }, loading: false, logout: () => undefined }),
}));
vi.mock("../src/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/api")>()),
  api: vi.fn(async (path: string, opts: { method?: string; json?: unknown } = {}) => {
    const method = opts.method ?? "GET";
    if (path === "/api/image-size-controls/config") {
      if (state.config === "error") throw new Error("not found");
      return state.config;
    }
    if (path === "/api/templates" && method === "GET") return { items: state.templates };
    if (path === "/api/templates/uploads/image") {
      return { url: "http://localhost:4000/uploads/template-images/new-1.png" };
    }
    if (path.startsWith("/api/templates/") && method === "PUT") return { id: "t1" };
    return {};
  }),
}));

const TEMPLATE = {
  id: "t1",
  name: "Welcome",
  kind: "LETTER",
  subject: "Hi {{first_name}}",
  bodyText: "Hi {{first_name}},\n\n{{image}}\n\nThanks",
  signature: "",
  htmlBody: "<p>x</p>",
  textBody: "",
  links: [],
  meeting: {},
  imageUrl: null,
  videoUrl: null,
  images: ["https://cdn.example.com/a.jpg", "https://cdn.example.com/b.png"],
  videos: [],
  variables: [],
};
const LEGACY_SINGLE = { ...TEMPLATE, id: "t2", name: "Old single", images: null, imageUrl: "https://cdn.example.com/old.jpg" };

function renderPage() {
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <ConfirmProvider>
        <MemoryRouter>
          <TemplatesPage />
        </MemoryRouter>
      </ConfirmProvider>
    </QueryClientProvider>,
  );
}
const settle = () => new Promise((r) => setTimeout(r, 30));
async function open(name: string) {
  renderPage();
  fireEvent.click(await screen.findByText(name));
  await screen.findByText("Images (optional)");
  await settle();
}
const imagesSection = () => screen.getByText("Images (optional)").parentElement as HTMLElement;
const savedBody = () => {
  const call = vi.mocked(api).mock.calls.find(([, o]) => (o as { method?: string } | undefined)?.method === "PUT");
  return (call?.[1] as { json?: unknown } | undefined)?.json;
};

beforeEach(() => {
  state.templates = [TEMPLATE, LEGACY_SINGLE];
  vi.mocked(api).mockClear();
});
afterEach(cleanup);

describe.each([
  ["config says off", { enabled: false }],
  ["config endpoint fails", "error"],
] as const)("Images section exactly as before (%s)", (_label, config) => {
  beforeEach(() => {
    state.config = config as typeof state.config;
  });

  it("renders the same Images section for a template with two images", async () => {
    await open("Welcome");
    expect(imagesSection().outerHTML).toMatchSnapshot();
  });

  it("renders the same Images section for a legacy single-image template", async () => {
    await open("Old single");
    expect(imagesSection().outerHTML).toMatchSnapshot();
  });

  it("saves the same payload when nothing is changed", async () => {
    await open("Welcome");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(savedBody()).toBeTruthy());
    expect(savedBody()).toMatchSnapshot();
  });

  it("saves a pasted and an uploaded image as plain URLs, as before", async () => {
    await open("Welcome");
    fireEvent.click(screen.getByRole("button", { name: "+ Add image" }));
    fireEvent.click(screen.getByRole("button", { name: "+ Add image" }));
    const inputs = imagesSection().querySelectorAll<HTMLInputElement>('input[placeholder="https://…/photo.jpg"]');
    fireEvent.change(inputs[2], { target: { value: "https://cdn.example.com/pasted.gif" } });
    const fileInputs = imagesSection().querySelectorAll<HTMLInputElement>('input[type="file"]');
    const file = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], "Logo.png", { type: "image/png" });
    fireEvent.change(fileInputs[3], { target: { files: [file] } });
    await waitFor(() =>
      expect(
        imagesSection().querySelectorAll<HTMLInputElement>('input[placeholder="https://…/photo.jpg"]')[3].value,
      ).toBe("http://localhost:4000/uploads/template-images/new-1.png"),
    );
    expect(imagesSection().outerHTML).toMatchSnapshot();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(savedBody()).toBeTruthy());
    expect(savedBody()).toMatchSnapshot();
  });
});
