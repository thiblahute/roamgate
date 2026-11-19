/**
 * Changes between two versions of a JSON state object, as a small payload:
 * the top-level fields that changed, and, for a field that is a list of
 * objects with unique string ids (`id`, or another `*_id` field all its
 * items share), the order of all ids, the items that are new, and for an
 * item that changed, its own changes, found the same way. Unchanged values
 * are recognized by identity first, so a producer that keeps its unchanged
 * parts pays nothing to compare them.
 */
export type StateDelta = {
  set: Record<string, unknown>;
  unset: string[];
  lists: Record<
    string,
    {
      /** The field that identifies the items. */
      by: string;
      order: string[];
      /** Items the base lacks. */
      upsert: unknown[];
      /** Changes to items the base has, by id. */
      patch?: Record<string, StateDelta>;
    }
  >;
};

const ID_FIELDS = [
  "id",
  "connection_id",
  "workspace_id",
  "tab_id",
  "pane_id",
  "session_id",
];

function same(a: unknown, b: unknown): boolean {
  return a === b || JSON.stringify(a) === JSON.stringify(b);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** The field identifying every item of a list, and the ids in order. */
function idsOf(
  list: unknown,
  only?: string,
): { by: string; order: string[] } | null {
  if (!Array.isArray(list) || list.length === 0)
    return Array.isArray(list) && only ? { by: only, order: [] } : null;
  for (const by of only ? [only] : ID_FIELDS) {
    const seen = new Set<string>();
    let ok = true;
    for (const item of list) {
      const id = isRecord(item) ? item[by] : undefined;
      if (typeof id !== "string" || seen.has(id)) {
        ok = false;
        break;
      }
      seen.add(id);
    }
    if (ok) return { by, order: [...seen] };
  }
  return null;
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
    const now = idsOf(value);
    const then = now ? idsOf(before, now.by) : null;
    if (now && then) {
      const old = new Map(
        (before as Record<string, unknown>[]).map((item) => [
          item[now.by] as string,
          item,
        ]),
      );
      const upsert: unknown[] = [];
      const patch: Record<string, StateDelta> = {};
      for (const item of value as Record<string, unknown>[]) {
        const id = item[now.by] as string;
        const was = old.get(id);
        if (!was) upsert.push(item);
        else if (was !== item) {
          const inner = diffState(was, item);
          if (inner) patch[id] = inner;
        }
      }
      if (
        upsert.length ||
        Object.keys(patch).length ||
        !same(now.order, then.order)
      ) {
        delta.lists[key] = {
          by: now.by,
          order: now.order,
          upsert,
          ...(Object.keys(patch).length ? { patch } : {}),
        };
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
  for (const [key, { by, order, upsert, patch }] of Object.entries(
    delta.lists,
  )) {
    const before = base[key];
    const byId = new Map<unknown, unknown>(
      Array.isArray(before)
        ? before.map((item) => [isRecord(item) ? item[by] : undefined, item])
        : [],
    );
    for (const [id, inner] of Object.entries(patch ?? {})) {
      const was = byId.get(id);
      if (!isRecord(was)) return null;
      const now = applyStateDelta(was, inner);
      if (!now) return null;
      byId.set(id, now);
    }
    for (const item of upsert)
      byId.set(isRecord(item) ? item[by] : undefined, item);
    const items = order.map((id) => byId.get(id));
    if (items.some((item) => item === undefined)) return null;
    next[key] = items;
  }
  return next;
}

export function isStateDelta(value: unknown): value is StateDelta {
  return (
    isRecord(value) &&
    isRecord(value.set) &&
    Array.isArray(value.unset) &&
    isRecord(value.lists)
  );
}
