/**
 * Changes between two versions of a JSON state object, as a small payload:
 * the top-level fields that changed, and, for a field that is a list of
 * objects with unique string `id`s, only the items that changed with the
 * order of all ids. Unchanged values are recognized by identity first, so a
 * producer that keeps its unchanged parts pays nothing to compare them.
 */
export type StateDelta = {
  set: Record<string, unknown>;
  unset: string[];
  lists: Record<string, { order: string[]; upsert: unknown[] }>;
};

function same(a: unknown, b: unknown): boolean {
  return a === b || JSON.stringify(a) === JSON.stringify(b);
}

function ids(list: unknown): string[] | null {
  if (!Array.isArray(list)) return null;
  const seen = new Set<string>();
  for (const item of list) {
    const id =
      item && typeof item === "object"
        ? (item as Record<string, unknown>).id
        : undefined;
    if (typeof id !== "string" || seen.has(id)) return null;
    seen.add(id);
  }
  return [...seen];
}

export function diffState(
  base: Record<string, unknown>,
  next: Record<string, unknown>,
): StateDelta | null {
  const delta: StateDelta = { set: {}, unset: [], lists: {} };
  let changed = false;
  for (const key of Object.keys(base))
    if (!(key in next)) {
      delta.unset.push(key);
      changed = true;
    }
  for (const [key, value] of Object.entries(next)) {
    const before = base[key];
    if (before === value) continue;
    const order = ids(value);
    if (order && ids(before)) {
      const old = new Map(
        (before as Record<string, unknown>[]).map((item) => [item.id, item]),
      );
      const upsert = (value as Record<string, unknown>[]).filter(
        (item) => !same(old.get(item.id), item),
      );
      const reordered =
        order.length !== old.size || order.some((id) => !old.has(id));
      if (upsert.length || reordered || !same(order, ids(before))) {
        delta.lists[key] = { order, upsert };
        changed = true;
      }
      continue;
    }
    if (!same(before, value)) {
      delta.set[key] = value;
      changed = true;
    }
  }
  return changed ? delta : null;
}

/** The state `delta` leads to from `base`; null when it does not fit it. */
export function applyStateDelta(
  base: Record<string, unknown>,
  delta: StateDelta,
): Record<string, unknown> | null {
  const next: Record<string, unknown> = { ...base, ...delta.set };
  for (const key of delta.unset) delete next[key];
  for (const [key, { order, upsert }] of Object.entries(delta.lists)) {
    const before = base[key];
    const byId = new Map<unknown, unknown>(
      Array.isArray(before)
        ? before.map((item) => [(item as Record<string, unknown>)?.id, item])
        : [],
    );
    for (const item of upsert)
      byId.set((item as Record<string, unknown>)?.id, item);
    const items = order.map((id) => byId.get(id));
    if (items.some((item) => item === undefined)) return null;
    next[key] = items;
  }
  return next;
}

export function isStateDelta(value: unknown): value is StateDelta {
  if (!value || typeof value !== "object") return false;
  const delta = value as Record<string, unknown>;
  return (
    !!delta.set &&
    typeof delta.set === "object" &&
    Array.isArray(delta.unset) &&
    !!delta.lists &&
    typeof delta.lists === "object"
  );
}
