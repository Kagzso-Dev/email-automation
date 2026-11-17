import { vi } from "vitest";
import { fake } from "./fakePrisma.js";

// fakePrisma.ts plus what the import filter step and Upload History need, without changing fakePrisma.ts:
//   - groupBy({ by, where, _max }) on every model (historyFilter.ts's loadHistory and the "last sent / called" dates)
//   - an upload_history model with contains-search, skip/take, createdAt ordering and the 30-day purge's updateMany
//   - history.missing = true: every upload_history call fails like a database without migration 0037
// Not a test file itself. Use it as:
//
//   vi.mock("../src/prisma.js", async () => ({ prisma: (await import("./fakePrismaPlus.js")).db }));

type Row = Record<string, any>;

function groupBy(name: string) {
  return vi.fn(async ({ by, where, _max }: { by: string[]; where?: Row; _max?: Record<string, true> }) => {
    const rows: Row[] = await fake.model(name).findMany({ where });
    const groups = new Map<string, Row>();
    for (const r of rows) {
      const key = JSON.stringify(by.map((k) => r[k]));
      const g = groups.get(key) ?? Object.fromEntries(by.map((k) => [k, r[k]]));
      if (_max) {
        g._max ??= Object.fromEntries(Object.keys(_max).map((f) => [f, null]));
        for (const f of Object.keys(_max)) if (r[f] != null && (g._max[f] == null || r[f] > g._max[f])) g._max[f] = r[f];
      }
      groups.set(key, g);
    }
    return [...groups.values()];
  });
}
const withGroupBy = new Map<string, unknown>();

/* ------------------------------------------------------------------ upload_history */

const missingTable = () => Object.assign(new Error("The table `upload_history` does not exist in the current database."), { code: "P2021" });
const pick = (r: Row | undefined, select?: Row) =>
  !r ? null : select ? Object.fromEntries(Object.entries(select).filter(([, on]) => on).map(([k]) => [k, r[k]])) : { ...r };

export const history = {
  rows: [] as Row[],
  missing: false,
  seq: 0,
  reset() {
    this.rows = [];
    this.missing = false;
    this.seq = 0;
  },
};
const guard = <A extends unknown[], R>(fn: (...a: A) => R) =>
  vi.fn(async (...a: A) => {
    if (history.missing) throw missingTable();
    return fn(...a);
  });
const searchMatch = (r: Row, where: Row = {}) => !where.fileName?.contains || String(r.fileName).toLowerCase().includes(String(where.fileName.contains).toLowerCase());

const uploadHistory = {
  create: guard(({ data, select }: Row) => {
    const row = { id: `uh-${++history.seq}`, excludedPurgedAt: null, ...data };
    history.rows.push(row);
    return pick(row, select);
  }),
  findMany: guard(({ where, skip = 0, take = 100, select }: Row) =>
    history.rows
      .filter((r) => searchMatch(r, where))
      .sort((a, b) => b.createdAt - a.createdAt || (a.id < b.id ? 1 : -1))
      .slice(skip, skip + take)
      .map((r) => pick(r, select)),
  ),
  count: guard(({ where }: Row = {}) => history.rows.filter((r) => searchMatch(r, where)).length),
  findUnique: guard(({ where, select }: Row) => pick(history.rows.find((r) => r.id === where.id), select)),
  updateMany: guard(({ where, data }: Row) => {
    const hit = history.rows.filter((r) => r.excludedExpiresAt <= where.excludedExpiresAt.lte && r.excludedPurgedAt === null);
    for (const r of hit) Object.assign(r, data);
    return { count: hit.length };
  }),
};

export const db = new Proxy({} as Row, {
  get: (_t, p) => {
    if (typeof p !== "string" || p === "then") return undefined;
    if (p === "uploadHistory") return uploadHistory;
    const model = (fake.db as Row)[p];
    if (p.startsWith("$")) return model;
    if (!withGroupBy.has(p)) withGroupBy.set(p, Object.assign(model, { groupBy: groupBy(p) }));
    return withGroupBy.get(p);
  },
});

export { fake };
