import { vi } from "vitest";

// In-memory stand-in for the Prisma calls the sending-domain code (and the email paths it sits in) makes —
// no MySQL. Not a test file itself. Use it as:
//
//   vi.mock("../src/prisma.js", async () => ({ prisma: (await import("./fakePrisma.js")).fake.db }));
//   import { fake } from "./fakePrisma.js";
//
// Rows are plain objects per model; `where` matches on equality, `in` and nested keys; `orderBy` takes one
// field; `take` limits. Each call is a vi.fn spy (fake.model("setting").findUnique). $transaction runs the
// already-started operations together.

type Row = Record<string, any>;

function matches(row: Row, where: Row = {}): boolean {
  return Object.entries(where).every(([k, cond]) => {
    if (cond !== null && typeof cond === "object" && !(cond instanceof Date)) {
      if ("in" in cond) return (cond.in as unknown[]).includes(row[k]);
      return matches(row, cond);
    }
    return (row[k] ?? null) === cond;
  });
}

function select(rows: Row[], args: Row = {}): Row[] {
  let out = rows.filter((r) => matches(r, args.where));
  const order = Object.entries((args.orderBy ?? {}) as Record<string, "asc" | "desc">)[0];
  if (order) {
    const [key, dir] = order;
    const sign = dir === "desc" ? -1 : 1;
    out = [...out].sort((a, b) => (a[key] < b[key] ? -sign : a[key] > b[key] ? sign : 0));
  }
  return typeof args.take === "number" ? out.slice(0, args.take) : out;
}

const defined = (data: Row) => Object.fromEntries(Object.entries(data).filter(([, v]) => v !== undefined));
const copy = (r: Row | undefined) => (r ? { ...r } : null);
const missing = () => Object.assign(new Error("Record to update not found."), { code: "P2025" });

export function createFakePrisma() {
  let seq = 0;
  const tables: Record<string, Row[]> = {};
  const T = (name: string) => (tables[name] ??= []);
  // Each new row is a second later than the last, so "newest first" is deterministic.
  const nextCreatedAt = () => new Date(Date.UTC(2026, 10, 17, 9) + ++seq * 1000);

  function model(name: string) {
    const rows = () => T(name);
    const find = (where: Row) => rows().find((r) => matches(r, where));
    return {
      findUnique: vi.fn(async ({ where }: Row) => copy(find(where))),
      findFirst: vi.fn(async (args: Row = {}) => copy(select(rows(), args)[0])),
      findMany: vi.fn(async (args: Row = {}) => select(rows(), args).map((r) => ({ ...r }))),
      count: vi.fn(async (args: Row = {}) => select(rows(), args).length),
      create: vi.fn(async ({ data }: Row) => {
        const row: Row = { id: `${name}-${seq + 1}`, createdAt: nextCreatedAt(), ...defined(data) };
        rows().push(row);
        return { ...row };
      }),
      upsert: vi.fn(async ({ where, create, update }: Row) => {
        const r = find(where);
        if (r) return { ...Object.assign(r, defined(update)) };
        const row: Row = { id: `${name}-${seq + 1}`, createdAt: nextCreatedAt(), ...defined(create) };
        rows().push(row);
        return { ...row };
      }),
      update: vi.fn(async ({ where, data }: Row) => {
        const r = find(where);
        if (!r) throw missing();
        return { ...Object.assign(r, defined(data)) };
      }),
      delete: vi.fn(async ({ where }: Row) => {
        const i = rows().findIndex((r) => matches(r, where));
        if (i === -1) throw missing();
        return rows().splice(i, 1)[0];
      }),
      deleteMany: vi.fn(async (args: Row = {}) => {
        const keep = rows().filter((r) => !matches(r, args.where));
        const count = rows().length - keep.length;
        tables[name] = keep;
        return { count };
      }),
    };
  }

  const models: Record<string, ReturnType<typeof model>> = {};
  const getModel = (name: string) => (models[name] ??= model(name));
  const db = new Proxy({} as Row, {
    get: (_t, p) => {
      if (typeof p !== "string" || p === "then") return undefined;
      if (p === "$transaction") return (ops: Promise<unknown>[]) => Promise.all(ops);
      return getModel(p);
    },
  });

  return {
    db,
    /** A model's rows, to seed or inspect: fake.T("blockedSendingDomain"). */
    T,
    /** A model's spies: fake.model("setting").findUnique. */
    model: getModel,
    reset() {
      for (const k of Object.keys(tables)) delete tables[k];
      for (const m of Object.values(models)) for (const fn of Object.values(m)) fn.mockClear();
      seq = 0;
    },
  };
}

export const fake = createFakePrisma();
