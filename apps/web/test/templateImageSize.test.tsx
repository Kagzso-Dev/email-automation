import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { ConfirmProvider } from "../src/components/confirm";
import { api } from "../src/lib/api";
import { readNaturalWidth } from "../src/lib/imageSizeControls";
import { TemplatesPage } from "../src/pages/Templates";

// Templates → Images with the image size controls ON (ENABLE_IMAGE_SIZE_CONTROLS): a toolbar under each
// image — Small | Best fit | Original size | Edit alt text | Remove — and the image's own width read in
// the browser (uploads and pasted URLs). Flag off is covered by templateImagesFlagOff.test.tsx.

const state = vi.hoisted(() => ({
  enabled: true,
  role: "ADMIN" as "ADMIN" | "EDITOR",
  templates: [] as Record<string, unknown>[],
}));

vi.mock("../src/lib/auth", () => ({
  useAuth: () => ({ user: { role: state.role, email: "a@example.com" }, loading: false, logout: () => undefined }),
}));
vi.mock("../src/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/api")>()),
  api: vi.fn(async (path: string, opts: { method?: string } = {}) => {
    const method = opts.method ?? "GET";
    if (path === "/api/image-size-controls/config") return { enabled: state.enabled };
    if (path === "/api/templates" && method === "GET") return { items: state.templates };
    if (path === "/api/templates/uploads/image") return { url: "http://localhost:4000/uploads/template-images/new-1.png" };
    if (path.startsWith("/api/templates/") && method === "PUT") return { id: "t1" };
    return {};
  }),
}));

/** Stand-in for the browser's Image: "loads" with the width set in `nextWidth` (0 = fails to load). */
const img = vi.hoisted(() => ({ nextWidth: 640, never: false }));
class FakeImage {
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  naturalWidth = 0;
  set src(_v: string) {
    if (img.never) return;
    setTimeout(() => {
      if (img.nextWidth > 0) {
        this.naturalWidth = img.nextWidth;
        this.onload?.();
      } else this.onerror?.();
    }, 0);
  }
}

const TEMPLATE = {
  id: "t1",
  name: "Welcome",
  kind: "LETTER",
  subject: "Hi",
  bodyText: "Hi {{first_name}},\n\n{{image}}",
  signature: "",
  htmlBody: "<p>x</p>",
  textBody: "",
  links: [],
  meeting: {},
  imageUrl: null,
  videoUrl: null,
  images: ["https://cdn.example.com/old.jpg"],
  videos: [],
  variables: [],
};

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
async function open(name = "Welcome") {
  renderPage();
  fireEvent.click(await screen.findByText(name));
  await screen.findByText("Images (optional)");
  // The toolbars appear once the flag is known (OFF until then).
  if (state.enabled) await waitFor(() => expect(within(section()).queryAllByRole("toolbar").length).toBeGreaterThan(0));
}
const section = () => screen.getByText("Images (optional)").parentElement as HTMLElement;
const rows = () => [...section().querySelectorAll<HTMLElement>(".rounded-lg.border.border-line.p-2")];
const toolbar = (i: number) => within(rows()[i]).getByRole("toolbar");
const urlInput = (i: number) => rows()[i].querySelector<HTMLInputElement>('input[placeholder="https://…/photo.jpg"]')!;
const sizeLabel = (i: number) => within(rows()[i]).getByTestId("image-size-label").textContent;
const pressed = (i: number) =>
  within(toolbar(i))
    .getAllByRole("button")
    .filter((b) => b.getAttribute("aria-pressed") === "true")
    .map((b) => b.textContent);
/** The row's thumbnail finished loading with this width (what the browser reports for a pasted URL). */
const thumbnailLoads = (i: number, width: number) => {
  const thumb = rows()[i].querySelector("img")!;
  Object.defineProperty(thumb, "naturalWidth", { value: width, configurable: true });
  fireEvent.load(thumb);
};
const save = async () => {
  // "Uploading image…" until an upload has fully settled, then "Save".
  fireEvent.click(await screen.findByRole("button", { name: "Save" }));
  await waitFor(() => expect(savedImages()).toBeTruthy());
  return savedImages();
};
const savedImages = () => {
  const call = vi.mocked(api).mock.calls.find(([, o]) => (o as { method?: string } | undefined)?.method === "PUT");
  return ((call?.[1] as { json?: { images?: unknown } } | undefined)?.json ?? undefined)?.images;
};

beforeEach(() => {
  state.enabled = true;
  state.role = "ADMIN";
  state.templates = [TEMPLATE];
  img.nextWidth = 640;
  img.never = false;
  vi.stubGlobal("Image", FakeImage);
  URL.createObjectURL = vi.fn(() => "blob:fake");
  URL.revokeObjectURL = vi.fn();
  vi.mocked(api).mockClear();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("toolbar", () => {
  it("shows Small | Best fit | Original size | Edit alt text | Remove under each image", async () => {
    await open();
    const buttons = within(toolbar(0)).getAllByRole("button").map((b) => b.textContent);
    expect(buttons).toEqual(["Small", "Best fit", "Original size", "Edit alt text", "Remove"]);
    expect(toolbar(0).textContent).toContain("Small|Best fit|Original size|Edit alt text|Remove");
  });

  it("an existing image has no size selected and keeps rendering as before", async () => {
    await open();
    expect(pressed(0)).toEqual([]);
    expect(sizeLabel(0)).toBe("Size: as before");
  });

  it("a new image starts at Best fit", async () => {
    await open();
    fireEvent.click(screen.getByRole("button", { name: "+ Add image" }));
    expect(pressed(1)).toEqual(["Best fit"]);
    expect(sizeLabel(1)).toBe("Best fit · width unknown");
  });

  it("highlights the chosen size and shows the live size", async () => {
    await open();
    thumbnailLoads(0, 1200);
    fireEvent.click(within(toolbar(0)).getByRole("button", { name: "Small" }));
    expect(pressed(0)).toEqual(["Small"]);
    expect(sizeLabel(0)).toBe("Small · 200 px");
    fireEvent.click(within(toolbar(0)).getByRole("button", { name: "Best fit" }));
    expect(sizeLabel(0)).toBe("Best fit · 600 px");
    fireEvent.click(within(toolbar(0)).getByRole("button", { name: "Original size" }));
    expect(pressed(0)).toEqual(["Original size"]);
    expect(sizeLabel(0)).toBe("Original size · 1200 px");
    expect(rows()[0].textContent).toContain("Outlook on desktop shows it at full width");
  });

  it("never shows a small QR code wider than it is", async () => {
    await open();
    thumbnailLoads(0, 150);
    fireEvent.click(within(toolbar(0)).getByRole("button", { name: "Best fit" }));
    expect(sizeLabel(0)).toBe("Best fit · 150 px");
    fireEvent.click(within(toolbar(0)).getByRole("button", { name: "Small" }));
    expect(sizeLabel(0)).toBe("Small · 150 px");
  });

  it("Remove does the same as the X button", async () => {
    state.templates = [{ ...TEMPLATE, images: ["https://x/a.png", "https://x/b.png"] }];
    await open();
    fireEvent.click(within(toolbar(0)).getByRole("button", { name: "Remove" }));
    expect(rows()).toHaveLength(1);
    expect(urlInput(0).value).toBe("https://x/b.png");
    expect(await save()).toEqual(["https://x/b.png"]);
  });

  it("is disabled for editors (view only)", async () => {
    state.role = "EDITOR";
    await open();
    for (const b of within(toolbar(0)).getAllByRole("button")) expect(b.matches(":disabled")).toBe(true);
  });
});

describe("alt text", () => {
  it("has an input labelled Alt text, max 125 characters, saved with the image", async () => {
    await open();
    fireEvent.click(within(toolbar(0)).getByRole("button", { name: "Edit alt text" }));
    const input = within(rows()[0]).getByLabelText("Alt text") as HTMLInputElement;
    expect(input.maxLength).toBe(125);
    expect(rows()[0].textContent).toContain("Left empty: no alt text, as before");
    fireEvent.change(input, { target: { value: "Our team at the 2026 expo" } });
    expect(rows()[0].textContent).toContain("25/125");
    // Alt text alone keeps the image's size as before.
    expect(await save()).toEqual([{ url: "https://cdn.example.com/old.jpg", alt: "Our team at the 2026 expo" }]);
  });

  it("shows the fallback the email will use when left empty", async () => {
    await open();
    fireEvent.click(within(toolbar(0)).getByRole("button", { name: "Best fit" }));
    fireEvent.click(within(toolbar(0)).getByRole("button", { name: "Edit alt text" }));
    expect(rows()[0].textContent).toContain("Left empty: “old.jpg”");
  });
});

describe("the image's own width", () => {
  it("pasted URL: read from the thumbnail and saved for Original size", async () => {
    await open();
    fireEvent.click(screen.getByRole("button", { name: "+ Add image" }));
    fireEvent.change(urlInput(1), { target: { value: "https://cdn.example.com/qr.png" } });
    thumbnailLoads(1, 150);
    fireEvent.click(within(toolbar(1)).getByRole("button", { name: "Original size" }));
    expect(sizeLabel(1)).toBe("Original size · 150 px");
    expect(await save()).toEqual([
      "https://cdn.example.com/old.jpg", // untouched: still a plain URL
      { url: "https://cdn.example.com/qr.png", size: "original", naturalWidth: 150 },
    ]);
  });

  it("pasted URL that can't be read: Original size falls back to Best fit", async () => {
    await open();
    fireEvent.click(screen.getByRole("button", { name: "+ Add image" }));
    fireEvent.change(urlInput(1), { target: { value: "https://cdn.example.com/{{code}}.png" } });
    fireEvent.error(rows()[1].querySelector("img")!);
    fireEvent.click(within(toolbar(1)).getByRole("button", { name: "Original size" }));
    expect(sizeLabel(1)).toBe("Original size · width unknown, sent as Best fit");
    expect(await save()).toEqual([
      "https://cdn.example.com/old.jpg",
      { url: "https://cdn.example.com/{{code}}.png", size: "original" },
    ]);
  });

  it("a changed URL forgets the old picture's width", async () => {
    await open();
    fireEvent.click(screen.getByRole("button", { name: "+ Add image" }));
    fireEvent.change(urlInput(1), { target: { value: "https://x/one.png" } });
    thumbnailLoads(1, 300);
    expect(sizeLabel(1)).toBe("Best fit · 300 px");
    fireEvent.change(urlInput(1), { target: { value: "https://x/two.png" } });
    expect(sizeLabel(1)).toBe("Best fit · width unknown");
  });

  it("upload: read from the file, saved with the original file name (Best fit by default)", async () => {
    img.nextWidth = 640;
    await open();
    fireEvent.click(screen.getByRole("button", { name: "+ Add image" }));
    const file = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], "Diwali offer.png", { type: "image/png" });
    fireEvent.change(rows()[1].querySelector('input[type="file"]')!, { target: { files: [file] } });
    await waitFor(() => expect(urlInput(1).value).toBe("http://localhost:4000/uploads/template-images/new-1.png"));
    expect(sizeLabel(1)).toBe("Best fit · 600 px");
    expect(URL.createObjectURL).toHaveBeenCalledWith(file);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:fake");
    expect(await save()).toEqual([
      "https://cdn.example.com/old.jpg",
      {
        url: "http://localhost:4000/uploads/template-images/new-1.png",
        size: "fit",
        naturalWidth: 640,
        name: "Diwali offer.png",
      },
    ]);
  });
});

describe("saving", () => {
  it("leaves untouched images as plain URLs and keeps stored settings", async () => {
    state.templates = [
      {
        ...TEMPLATE,
        images: ["https://x/a.png", { url: "https://x/b.png", size: "small", alt: "B", naturalWidth: 900, name: "b.png" }],
      },
    ];
    await open();
    expect(pressed(1)).toEqual(["Small"]);
    expect(await save()).toEqual([
      "https://x/a.png",
      { url: "https://x/b.png", size: "small", alt: "B", naturalWidth: 900, name: "b.png" },
    ]);
  });

  it("flag off: no toolbar, and sizes saved while it was on are kept, not lost", async () => {
    state.enabled = false;
    state.templates = [{ ...TEMPLATE, images: [{ url: "https://x/b.png", size: "original", naturalWidth: 300 }, "https://x/c.png"] }];
    await open();
    await act(() => new Promise((r) => setTimeout(r, 30)));
    expect(within(section()).queryByRole("toolbar")).toBeNull();
    expect(urlInput(0).value).toBe("https://x/b.png");
    expect(await save()).toEqual([{ url: "https://x/b.png", size: "original", naturalWidth: 300 }, "https://x/c.png"]);
  });
});

describe("readNaturalWidth", () => {
  it("reads a URL's width", async () => {
    img.nextWidth = 320;
    await expect(readNaturalWidth("https://cdn.example.com/a.png")).resolves.toBe(320);
  });

  it("reads an uploaded file's width and frees the temporary URL", async () => {
    img.nextWidth = 1024;
    const file = new File(["x"], "a.png", { type: "image/png" });
    await expect(readNaturalWidth(file)).resolves.toBe(1024);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:fake");
  });

  it("is null when it can't be read: a broken image, a non-URL, too wide, or too slow", async () => {
    img.nextWidth = 0;
    await expect(readNaturalWidth("https://cdn.example.com/broken.png")).resolves.toBeNull();
    await expect(readNaturalWidth("{{image_url}}")).resolves.toBeNull();
    img.nextWidth = 25_000;
    await expect(readNaturalWidth("https://cdn.example.com/huge.png")).resolves.toBeNull();
    img.never = true;
    await expect(readNaturalWidth("https://cdn.example.com/slow.png", 20)).resolves.toBeNull();
  });
});
