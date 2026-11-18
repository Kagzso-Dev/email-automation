import { vi } from "vitest";

// In-memory Prisma for the Hard stop tests (ENABLE_HARD_STOP) — no MySQL. Not a test file itself. Use it as:
//
//   vi.mock("../src/prisma.js", async () => ({ prisma: (await import("./fakePrismaHardStop.js")).hs.db }));
//
// Unlike fakePrisma.ts it applies conditional writes the way the database does: updateMany / deleteMany change only
// the rows their `where` matches at that moment, so "only if still queued" claims race exactly like real ones. Where
// supports equality, in, not, startsWith, gt / gte / lt / lte, OR / AND, and the relation filters the hard-stop code
// uses (is, some). Unique keys raise P2002. $transaction(fn) rolls back on a throw.
//
// Races: every database call is numbered (hs.ops). hs.before(n, fn) runs fn right before call n starts, so a test can
// press Hard stop at every point of a worker's iteration in turn. hs.events records each successful claim / write.

type Row = Record<string, any>;

interface Relation {
  model: string;
  kind: "one" | "many";
  /** one: this row's foreign key; many (and one with back): the other row's foreign key. */
  fk: string;
  back?: boolean;
}

const RELATIONS: Record<string, Record<string, Relation>> = {
  manualSendBatchItem: { batch: { model: "manualSendBatch", kind: "one", fk: "batchId" } },
  manualSendBatch: { template: { model: "template", kind: "one", fk: "templateId" }, items: { model: "manualSendBatchItem", kind: "many", fk: "batchId" } },
  whatsAppSend: { batch: { model: "whatsAppSendBatch", kind: "one", fk: "batchId" } },
  whatsAppSendBatch: { template: { model: "whatsAppTemplate", kind: "one", fk: "templateId" }, items: { model: "whatsAppSend", kind: "many", fk: "batchId" } },
  hardStopItem: { stop: { model: "hardStop", kind: "one", fk: "stopId" } },
  aiCallRun: { logs: { model: "aiCallLog", kind: "many", fk: "runId" }, flow: { model: "aiCallRunFlow", kind: "one", fk: "runId", back: true } },
  aiCallFollowup: { customer: { model: "aiCallCustomer", kind: "one", fk: "customerId" } },
  // A run's language: run → its pinned flow version → that flow (domain/aiCallLanguages runLanguageWhere).
  aiCallRunFlow: { flowVersion: { model: "callFlowVersion", kind: "one", fk: "flowVersionId" } },
  callFlowVersion: { flow: { model: "callFlow", kind: "one", fk: "flowId" } },
  aiCallCustomerCall: { customer: { model: "aiCallCustomer", kind: "one", fk: "customerId" } },
};

const UNIQUE: Record<string, string[][]> = {
  hardStop: [["activeKey"]],
  hardStopItem: [["stopId", "kind", "refTable", "refId"]],
  job: [["dedupeKey"]],
};

const DEFAULTS: Record<string, () => Row> = {
  hardStop: () => ({ status: "STOPPING", inProgressAtStop: 0, cancelledItems: 0, cancelledFollowups: 0, completedItems: null, finishedAt: null, detail: null }),
  hardStopItem: () => ({ name: null, email: null, phone: null, businessName: null, extra: null }),
  job: () => ({ status: "PENDING", attempts: 0, maxAttempts: 1, lockedAt: null, lockedBy: null, lastError: null, result: null }),
  aiCallLog: () => ({ status: "QUEUED", error: null, outcome: null, startedAt: null, endedAt: null, voiceCallId: null }),
  aiCallRun: () => ({ status: "RUNNING", nextCallAt: null }),
};

const isObj = (v: unknown): v is Row => v !== null && typeof v === "object" && !(v instanceof Date) && !Array.isArray(v);
const cmp = (a: unknown, b: unknown) => (a instanceof Date ? a.getTime() : (a as number)) - (b instanceof Date ? b.getTime() : (b as number));
const eq = (a: unknown, b: unknown) => (a instanceof Date && b instanceof Date ? a.getTime() === b.getTime() : (a ?? null) === (b ?? null));

export function createHardStopFake() {
  let seq = 0;
  // createdAt of seeded / created rows: an hour back, a second apart, so rows made before a Hard stop are older than
  // it (the stop stamps the real time). updatedAt is the real time, so nothing looks stuck unless a test says so.
  let clock = Date.now() - 3_600_000;
  let tables: Record<string, Row[]> = {};
  const T = (name: string) => (tables[name] ??= []);
  const hooks = new Map<number, () => Promise<void>>();
  const state = { ops: 0, events: [] as { op: number; what: string; id: string }[] };
  /** The rows each update / updateMany call really changed, as they were before it (for a transaction's undo). */
  const changed = new WeakMap<object, { ref: Row; copy: Row }[]>();

  function matchField(model: string, row: Row, key: string, cond: unknown): boolean {
    const rel = RELATIONS[model]?.[key];
    if (rel) {
      const c = cond as Row;
      if (rel.kind === "one") {
        const other = T(rel.model).find((r) => (rel.back ? r[rel.fk] === row.id : r.id === row[rel.fk]));
        const inner = c !== null && "is" in c ? c.is : c;
        return inner === null ? !other : !!other && matches(rel.model, other, inner);
      }
      const others = T(rel.model).filter((r) => r[rel.fk] === row.id);
      if ("some" in c) return others.some((o) => matches(rel.model, o, c.some));
      if ("none" in c) return !others.some((o) => matches(rel.model, o, c.none));
      return true;
    }
    const v = row[key];
    if (!isObj(cond)) return eq(v, cond);
    return Object.entries(cond).every(([op, x]) => {
      switch (op) {
        case "equals":
          return eq(v, x);
        case "in":
          return (x as unknown[]).some((y) => eq(v, y));
        case "notIn":
          return !(x as unknown[]).some((y) => eq(v, y));
        case "not":
          return isObj(x) ? !matchField(model, row, key, x) : !eq(v, x);
        case "startsWith":
          return typeof v === "string" && v.startsWith(x as string);
        case "contains":
          return typeof v === "string" && v.includes(x as string);
        case "gt":
          return v != null && cmp(v, x) > 0;
        case "gte":
          return v != null && cmp(v, x) >= 0;
        case "lt":
          return v != null && cmp(v, x) < 0;
        case "lte":
          return v != null && cmp(v, x) <= 0;
        default:
          throw new Error(`fakePrismaHardStop: unsupported filter ${model}.${key}.${op}`);
      }
    });
  }

  function matches(model: string, row: Row, where: Row = {}): boolean {
    return Object.entries(where).every(([k, cond]) => {
      if (cond === undefined) return true;
      if (k === "OR") return (cond as Row[]).some((w) => matches(model, row, w));
      if (k === "AND") return (cond as Row[]).every((w) => matches(model, row, w));
      if (k === "NOT") return !matches(model, row, cond as Row);
      return matchField(model, row, k, cond);
    });
  }

  function attach(model: string, row: Row, args: Row): Row {
    const out: Row = { ...row };
    for (const spec of [args.include, args.select]) {
      if (!spec) continue;
      for (const [k, v] of Object.entries(spec as Row)) {
        const rel = RELATIONS[model]?.[k];
        if (!rel || !v) continue;
        if (rel.kind === "one") {
          const other = T(rel.model).find((r) => (rel.back ? r[rel.fk] === row.id : r.id === row[rel.fk]));
          out[k] = other ? attach(rel.model, other, isObj(v) ? v : {}) : null;
        } else {
          out[k] = list(rel.model, { ...(isObj(v) ? v : {}), where: { ...(isObj(v) ? v.where : {}), [rel.fk]: row.id } });
        }
      }
    }
    return out;
  }

  function list(model: string, args: Row = {}): Row[] {
    let out = T(model).filter((r) => matches(model, r, args.where));
    const orders = (Array.isArray(args.orderBy) ? args.orderBy : args.orderBy ? [args.orderBy] : []) as Row[];
    for (const o of [...orders].reverse()) {
      const [key, dir] = Object.entries(o)[0] as [string, "asc" | "desc"];
      const sign = dir === "desc" ? -1 : 1;
      out = [...out].sort((a, b) => (a[key] < b[key] ? -sign : a[key] > b[key] ? sign : 0));
    }
    if (typeof args.skip === "number") out = out.slice(args.skip);
    if (typeof args.take === "number") out = out.slice(0, args.take);
    return out.map((r) => attach(model, r, args));
  }

  const now = () => new Date((clock += 1000));
  const defined = (data: Row) => Object.fromEntries(Object.entries(data).filter(([, v]) => v !== undefined));

  function applyData(row: Row, data: Row) {
    for (const [k, v] of Object.entries(defined(data))) {
      if (isObj(v) && "increment" in v) row[k] = (row[k] ?? 0) + (v.increment as number);
      else if (isObj(v) && "decrement" in v) row[k] = (row[k] ?? 0) - (v.decrement as number);
      else row[k] = v;
    }
    row.updatedAt = new Date();
  }

  function insert(model: string, data: Row, skipDuplicates = false): Row | null {
    const nested: [string, Row][] = [];
    const flat: Row = {};
    for (const [k, v] of Object.entries(defined(data))) {
      const rel = RELATIONS[model]?.[k];
      if (rel && isObj(v) && "create" in v) nested.push([k, v]);
      else if (k === "flow" && isObj(v)) continue; // aiCallRun.flow (pinned flow) is not modelled
      else flat[k] = v;
    }
    const row: Row = { id: `${model}-${++seq}`, ...(DEFAULTS[model]?.() ?? {}), createdAt: now(), ...flat };
    row.updatedAt = row.updatedAt ?? new Date();
    for (const keys of UNIQUE[model] ?? []) {
      if (keys.some((k) => row[k] == null)) continue;
      if (T(model).some((r) => keys.every((k) => eq(r[k], row[k])))) {
        if (skipDuplicates) return null;
        throw Object.assign(new Error(`Unique constraint failed on ${model}(${keys.join(",")})`), { code: "P2002" });
      }
    }
    T(model).push(row);
    for (const [k, v] of nested) {
      const rel = RELATIONS[model]![k]!;
      for (const child of [v.create].flat() as Row[]) insert(rel.model, { ...child, [rel.fk]: row.id });
    }
    return row;
  }

  /** Each database call: numbered, a yield (so concurrent workers interleave), and any hook for that number first. */
  const op =
    <A extends unknown[], R>(fn: (...a: A) => R) =>
    async (...a: A): Promise<Awaited<R>> => {
      const n = ++state.ops;
      const hook = hooks.get(n);
      if (hook) {
        hooks.delete(n);
        await hook();
      }
      await new Promise((r) => setImmediate(r));
      return fn(...a) as Awaited<R>;
    };

  function model(name: string) {
    return {
      findUnique: vi.fn(op((args: Row) => {
        const r = list(name, { ...args, take: 1 })[0];
        return r ?? null;
      })),
      findUniqueOrThrow: vi.fn(op((args: Row) => {
        const r = list(name, { ...args, take: 1 })[0];
        if (!r) throw Object.assign(new Error("Not found"), { code: "P2025" });
        return r;
      })),
      findFirst: vi.fn(op((args: Row = {}) => list(name, { ...args, take: 1 })[0] ?? null)),
      findMany: vi.fn(op((args: Row = {}) => list(name, args))),
      count: vi.fn(op((args: Row = {}) => list(name, args).length)),
      groupBy: vi.fn(op((args: Row) => {
        const groups = new Map<string, Row>();
        for (const r of list(name, { where: args.where })) {
          const key = JSON.stringify((args.by as string[]).map((k) => r[k]));
          const g = groups.get(key) ?? { ...Object.fromEntries((args.by as string[]).map((k) => [k, r[k]])), _count: { _all: 0 } };
          g._count._all++;
          groups.set(key, g);
        }
        return [...groups.values()];
      })),
      create: vi.fn(op((args: Row) => attach(name, insert(name, args.data)!, args))),
      createMany: vi.fn(op((args: Row) => {
        let count = 0;
        for (const d of args.data as Row[]) if (insert(name, d, !!args.skipDuplicates)) count++;
        return { count };
      })),
      upsert: vi.fn(op((args: Row) => {
        const r = T(name).find((x) => matches(name, x, args.where));
        if (r) {
          applyData(r, args.update ?? {});
          return { ...r };
        }
        return { ...insert(name, args.create)! };
      })),
      update: vi.fn(op((args: Row) => {
        const r = T(name).find((x) => matches(name, x, args.where));
        if (!r) throw Object.assign(new Error("Record to update not found."), { code: "P2025" });
        changed.set(args, [{ ref: r, copy: { ...r } }]);
        applyData(r, args.data);
        state.events.push({ op: state.ops, what: `${name}.update:${JSON.stringify(defined(args.data)).slice(0, 80)}`, id: r.id });
        return attach(name, r, args);
      })),
      updateMany: vi.fn(op((args: Row) => {
        const hit = T(name).filter((x) => matches(name, x, args.where));
        changed.set(args, hit.map((r) => ({ ref: r, copy: { ...r } })));
        for (const r of hit) {
          applyData(r, args.data);
          state.events.push({ op: state.ops, what: `${name}.updateMany:${JSON.stringify(defined(args.data)).slice(0, 80)}`, id: r.id });
        }
        return { count: hit.length };
      })),
      delete: vi.fn(op((args: Row) => {
        const i = T(name).findIndex((x) => matches(name, x, args.where));
        if (i === -1) throw Object.assign(new Error("Record to delete does not exist."), { code: "P2025" });
        return T(name).splice(i, 1)[0];
      })),
      deleteMany: vi.fn(op((args: Row = {}) => {
        const keep = T(name).filter((x) => !matches(name, x, args.where));
        const count = T(name).length - keep.length;
        tables[name] = keep;
        return { count };
      })),
    };
  }

  const models: Record<string, ReturnType<typeof model>> = {};
  const getModel = (name: string) => (models[name] ??= model(name));

  /**
   * The client a $transaction(fn) callback gets: the same models, but every write it makes is undone if fn throws.
   * Only its own writes: rows another caller (a concurrent Hard stop) changed meanwhile stay as they are, as in MySQL.
   */
  function txClient(undo: (() => void)[]): Row {
    return new Proxy({} as Row, {
      get: (_t, p) => {
        if (typeof p !== "string" || p === "then") return undefined;
        const m = getModel(p);
        const restore = (saved: { ref: Row; copy: Row }[]) => () => {
          for (const s of saved) {
            for (const k of Object.keys(s.ref)) delete s.ref[k];
            Object.assign(s.ref, s.copy);
          }
        };
        return {
          ...m,
          create: async (args: Row) => {
            const r = await m.create(args);
            undo.push(() => {
              tables[p] = T(p).filter((x) => x.id !== r.id);
              for (const rel of Object.values(RELATIONS[p] ?? {})) {
                if (rel.kind === "many" || rel.back) tables[rel.model] = T(rel.model).filter((x) => x[rel.fk] !== r.id);
              }
            });
            return r;
          },
          update: async (args: Row) => {
            const r = await m.update(args);
            undo.push(restore(changed.get(args) ?? []));
            return r;
          },
          updateMany: async (args: Row) => {
            const r = await m.updateMany(args);
            undo.push(restore(changed.get(args) ?? []));
            return r;
          },
          deleteMany: async (args: Row = {}) => {
            const gone = T(p).filter((x) => matches(p, x, args.where));
            const r = await m.deleteMany(args);
            undo.push(() => T(p).push(...gone));
            return r;
          },
        };
      },
    });
  }

  const db: Row = new Proxy({} as Row, {
    get: (_t, p) => {
      if (typeof p !== "string" || p === "then") return undefined;
      if (p === "$transaction") {
        return async (arg: unknown) => {
          if (Array.isArray(arg)) return Promise.all(arg);
          const undo: (() => void)[] = [];
          try {
            return await (arg as (tx: Row) => Promise<unknown>)(txClient(undo));
          } catch (err) {
            for (const u of undo.reverse()) u(); // rolled back
            throw err;
          }
        };
      }
      return getModel(p);
    },
  });

  return {
    db,
    /** A model's rows, to seed or inspect. */
    T,
    /** Seed one row (defaults and createdAt like create). */
    seed(name: string, data: Row): Row {
      return insert(name, data)!;
    },
    model: getModel,
    /** Database calls made so far. */
    get ops() {
      return state.ops;
    },
    /** Successful writes, in order, with the call number they ran at. */
    get events() {
      return state.events;
    },
    /** Run fn right before database call number n starts. */
    before(n: number, fn: () => Promise<void>) {
      hooks.set(n, fn);
    },
    /** Move the fake clock (createdAt / updatedAt of later rows). */
    advance(ms: number) {
      clock += ms;
    },
    reset() {
      tables = {};
      hooks.clear();
      state.ops = 0;
      state.events = [];
      for (const m of Object.values(models)) for (const fn of Object.values(m)) fn.mockClear();
      seq = 0;
      clock = Date.now() - 3_600_000;
    },
  };
}

export const hs = createHardStopFake();
