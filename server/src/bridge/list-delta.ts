/**
 * Topology lists (workspaces, tabs, panes, agents) answered as changes.
 *
 * A page reads the four lists again on every burst of Herdr events, each
 * whole: on a busy desktop that is megabytes a minute, too much for a slow
 * mobile link. A page that understands deltas sends the stamp of the list
 * it holds (`since`); when the bridge still knows that version for this
 * socket, it answers with the items that changed and the order of all
 * ids, and the page rebuilds the list. Anything else gets the whole list,
 * stamped.
 */

/** Each list's array and the field that identifies its items. */
export const LIST_DELTA_SHAPES: Readonly<
  Record<string, { array: string; id: string }>
> = {
  "workspace.list": { array: "workspaces", id: "workspace_id" },
  "tab.list": { array: "tabs", id: "tab_id" },
  "pane.list": { array: "panes", id: "pane_id" },
  "agent.list": { array: "agents", id: "pane_id" },
};

/** Versions kept per list and socket: an answer lost on the way still has its base. */
const KEPT_VERSIONS = 2;

type Version = { stamp: string; items: Map<string, string> };

export type ListDeltaReply =
  | Record<string, unknown>
  | {
      list_delta: {
        base: string;
        stamp: string;
        array: string;
        id: string;
        rest: Record<string, unknown>;
        order: string[];
        upsert: unknown[];
      };
    };

export function createListDeltas() {
  const versions = new WeakMap<object, Map<string, Version[]>>();

  /**
   * The answer to a list read: a delta from `since` when this socket was
   * given that version, else the whole result with its stamp.
   */
  return function listReply(
    socket: object,
    key: string,
    method: string,
    result: unknown,
    since: unknown,
  ): unknown {
    const shape = LIST_DELTA_SHAPES[method];
    if (!shape || !result || typeof result !== "object") return result;
    const record = result as Record<string, unknown>;
    const list = record[shape.array];
    if (!Array.isArray(list)) return result;
    const items = new Map<string, string>();
    const order: string[] = [];
    for (const item of list) {
      const id =
        item && typeof item === "object"
          ? (item as Record<string, unknown>)[shape.id]
          : undefined;
      // An item without an id, or one listed twice, cannot be patched.
      if (typeof id !== "string" || items.has(id)) return result;
      items.set(id, JSON.stringify(item));
      order.push(id);
    }
    const rest: Record<string, unknown> = {};
    for (const [field, value] of Object.entries(record))
      if (field !== shape.array) rest[field] = value;
    const stamp = Bun.hash(
      JSON.stringify([rest, order, [...items.values()]]),
    ).toString(36);
    let bySocket = versions.get(socket);
    if (!bySocket) {
      bySocket = new Map();
      versions.set(socket, bySocket);
    }
    const slot = `${key}\0${method}`;
    const kept = bySocket.get(slot) ?? [];
    const base = kept.find((version) => version.stamp === since);
    bySocket.set(
      slot,
      [{ stamp, items }, ...kept.filter((each) => each.stamp !== stamp)].slice(
        0,
        KEPT_VERSIONS,
      ),
    );
    if (!base) return { ...record, list_stamp: stamp };
    const upsert: unknown[] = [];
    for (const [index, id] of order.entries())
      if (base.items.get(id) !== items.get(id)) upsert.push(list[index]);
    return {
      list_delta: {
        base: base.stamp,
        stamp,
        array: shape.array,
        id: shape.id,
        rest,
        order,
        upsert,
      },
    };
  };
}
