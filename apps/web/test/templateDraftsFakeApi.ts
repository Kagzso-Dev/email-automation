// An in-memory /api/template-drafts for the page tests (not a test file itself). Each test file's `api` mock calls
// `draftApi(path, opts)` first; it answers the drafts endpoints and returns NOT_MINE for everything else.
//
// The real endpoints: GET /config, GET ?channel=, GET /:id, PUT /:id (create or update), DELETE /:id.

export const NOT_MINE = Symbol("not a template drafts call");

export const ME = { id: "u-me", email: "me@kagzso.test" };
export const OTHER = { id: "u-other", email: "other@kagzso.test" };

export interface StoredDraft {
  id: string;
  channel: "email" | "whatsapp";
  name: string | null;
  ownerId: string;
  ownerEmail: string;
  lastEditedById: string;
  lastEditedByEmail: string;
  createdAt: string;
  updatedAt: string;
  state: Record<string, unknown>;
}

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const summary = ({ state: _state, ...d }: StoredDraft) => d;

export const store = {
  /** The flag as GET /config answers it; "error" = the endpoint fails (an API without this feature). */
  flag: true as boolean | "error",
  drafts: [] as StoredDraft[],
  /** Every PUT fails (e.g. the migration isn't applied). */
  putFails: false,
  /** The list fails with this message. */
  listFails: null as string | null,
  reset() {
    this.flag = true;
    this.drafts = [];
    this.putFails = false;
    this.listFails = null;
  },
};

const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();

export function makeDraft(over: Partial<StoredDraft> & { editedMinutesAgo?: number } = {}): StoredDraft {
  const { editedMinutesAgo = 60, ...rest } = over;
  return {
    id: "draft-1",
    channel: "email",
    name: "Saved draft",
    ownerId: ME.id,
    ownerEmail: ME.email,
    lastEditedById: ME.id,
    lastEditedByEmail: ME.email,
    createdAt: minutesAgo(editedMinutesAgo + 5),
    updatedAt: minutesAgo(editedMinutesAgo),
    state: {},
    ...rest,
  };
}

export async function draftApi(path: string, opts: { method?: string; json?: any } = {}): Promise<unknown> {
  const method = (opts.method ?? "GET").toUpperCase();
  if (path === "/api/template-drafts/config") {
    if (store.flag === "error") throw new Error("Not found");
    return { enabled: store.flag };
  }
  if (path.startsWith("/api/template-drafts?")) {
    if (store.listFails) throw new Error(store.listFails);
    const channel = new URLSearchParams(path.split("?")[1]).get("channel");
    return {
      items: store.drafts
        .filter((d) => d.channel === channel)
        .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
        .map(summary),
      retentionDays: 30,
    };
  }
  const m = /^\/api\/template-drafts\/([^/?]+)$/.exec(path);
  if (!m) return NOT_MINE;
  const id = decodeURIComponent(m[1]);
  if (method === "GET") {
    const d = store.drafts.find((x) => x.id === id);
    if (!d) throw new Error("Draft not found");
    return clone(d);
  }
  if (method === "PUT") {
    if (store.putFails) throw new Error("Template drafts need a database update");
    const now = new Date().toISOString();
    const hit = store.drafts.find((x) => x.id === id);
    if (hit) Object.assign(hit, { name: opts.json.name, state: clone(opts.json.state), lastEditedById: ME.id, lastEditedByEmail: ME.email, updatedAt: now });
    else
      store.drafts.push({
        id,
        channel: opts.json.channel,
        name: opts.json.name,
        state: clone(opts.json.state),
        ownerId: ME.id,
        ownerEmail: ME.email,
        lastEditedById: ME.id,
        lastEditedByEmail: ME.email,
        createdAt: now,
        updatedAt: now,
      });
    return summary(store.drafts.find((x) => x.id === id)!);
  }
  if (method === "DELETE") {
    const before = store.drafts.length;
    store.drafts = store.drafts.filter((x) => x.id !== id);
    if (store.drafts.length === before) throw new Error("Draft not found");
    return undefined;
  }
  return NOT_MINE;
}

type Call = [string, ({ method?: string; json?: any; notify?: unknown } | undefined)?];

/** Calls to one draft (PUT / GET / DELETE /api/template-drafts/:id), in order. */
export const draftCalls = (calls: readonly unknown[][], method: string) =>
  (calls as unknown as Call[]).filter(
    ([p, o]) => /^\/api\/template-drafts\/(?!config$)[^/?]+$/.test(p) && (o?.method ?? "GET").toUpperCase() === method,
  );

/** Any drafts call except GET /config. */
export const anyDraftCall = (calls: readonly unknown[][]) =>
  (calls as unknown as Call[]).filter(([p]) => p.startsWith("/api/template-drafts") && p !== "/api/template-drafts/config");
