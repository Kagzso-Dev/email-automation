import type { TriggerCondition } from "@dispatch/shared";

function getPath(obj: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((acc, key) => {
    if (acc && typeof acc === "object" && key in (acc as Record<string, unknown>)) {
      return (acc as Record<string, unknown>)[key];
    }
    return undefined;
  }, obj);
}

/** All conditions must pass (AND). An empty condition list always passes. */
export function evaluateConditions(
  conditions: TriggerCondition[],
  payload: Record<string, unknown>,
): boolean {
  return conditions.every((c) => {
    const actual = getPath(payload, c.field);
    switch (c.op) {
      case "exists":
        return actual !== undefined && actual !== null;
      case "eq":
        return actual === c.value;
      case "ne":
        return actual !== c.value;
      case "contains":
        return typeof actual === "string" && typeof c.value === "string" && actual.includes(c.value);
      case "gt":
        return typeof actual === "number" && typeof c.value === "number" && actual > c.value;
      case "lt":
        return typeof actual === "number" && typeof c.value === "number" && actual < c.value;
      default:
        return false;
    }
  });
}
