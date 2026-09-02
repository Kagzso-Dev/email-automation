import { describe, expect, it } from "vitest";
import { evaluateConditions } from "../src/domain/conditions.js";

describe("evaluateConditions", () => {
  it("passes with no conditions", () => {
    expect(evaluateConditions([], {})).toBe(true);
  });

  it("evaluates eq / ne / contains", () => {
    const payload = { plan: "pro", note: "hello world" };
    expect(evaluateConditions([{ field: "plan", op: "eq", value: "pro" }], payload)).toBe(true);
    expect(evaluateConditions([{ field: "plan", op: "ne", value: "free" }], payload)).toBe(true);
    expect(evaluateConditions([{ field: "note", op: "contains", value: "world" }], payload)).toBe(true);
    expect(evaluateConditions([{ field: "plan", op: "eq", value: "free" }], payload)).toBe(false);
  });

  it("supports dot paths and exists / gt / lt", () => {
    const payload = { order: { total: 120 } };
    expect(evaluateConditions([{ field: "order.total", op: "gt", value: 100 }], payload)).toBe(true);
    expect(evaluateConditions([{ field: "order.total", op: "lt", value: 100 }], payload)).toBe(false);
    expect(evaluateConditions([{ field: "order.missing", op: "exists" }], payload)).toBe(false);
    expect(evaluateConditions([{ field: "order.total", op: "exists" }], payload)).toBe(true);
  });

  it("ANDs multiple conditions", () => {
    const payload = { a: 1, b: 2 };
    expect(
      evaluateConditions(
        [
          { field: "a", op: "eq", value: 1 },
          { field: "b", op: "eq", value: 2 },
        ],
        payload,
      ),
    ).toBe(true);
    expect(
      evaluateConditions(
        [
          { field: "a", op: "eq", value: 1 },
          { field: "b", op: "eq", value: 99 },
        ],
        payload,
      ),
    ).toBe(false);
  });
});
