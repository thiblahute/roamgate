import {
  MR_LANES,
  type MrInboxEntry,
  type MrLane,
  mrRefLabel,
} from "../../shared/mrReviews";
import { roamgateLocalStorage } from "./browserStorage";

/**
 * One's own requests in lanes (whose move it is), as the panel draws them:
 * each lane's rows in the user's order, a request that waits for another
 * listed one drawn under it (indented, joined by a tree line) whatever its
 * own lane, and counted in its own lane (Blocked).
 */

export type MrLaneRow = {
  entry: MrInboxEntry;
  /** 0 for a lane's own rows, 1 and more under a parent. */
  depth: number;
  /** Requests drawn under it. */
  children: number;
  /** Its children are folded away (za). */
  collapsed: boolean;
  /** Under a parent: "after !12". */
  after?: string;
  /** The last child of its parent (the tree line ends here). */
  last: boolean;
};

export type MrLaneGroup = {
  lane: MrLane;
  /** The requests in this lane, drawn here or under their parent. */
  count: number;
  folded: boolean;
  rows: MrLaneRow[];
};

/** The lanes of `entries` (the user's order), folded and collapsed as asked. */
export function mrLaneGroups(
  entries: MrInboxEntry[],
  options: { folded: ReadonlySet<string>; collapsed: ReadonlySet<string> },
): MrLaneGroup[] {
  const shown = new Map(entries.map((entry) => [entry.key, entry]));
  const children = new Map<string, MrInboxEntry[]>();
  for (const entry of entries) {
    const parent = entry.parent && shown.get(entry.parent);
    if (!parent) continue;
    children.set(parent.key, [...(children.get(parent.key) ?? []), entry]);
  }
  const counts = new Map<MrLane, number>();
  for (const entry of entries)
    if (entry.lane) counts.set(entry.lane, (counts.get(entry.lane) ?? 0) + 1);
  const groups: MrLaneGroup[] = [];
  for (const lane of MR_LANES) {
    const top = entries.filter(
      (entry) =>
        entry.lane === lane && !(entry.parent && shown.has(entry.parent)),
    );
    const count = counts.get(lane) ?? 0;
    if (!top.length && !count) continue;
    const rows: MrLaneRow[] = [];
    const add = (
      entry: MrInboxEntry,
      depth: number,
      last: boolean,
      seen: Set<string>,
    ) => {
      if (seen.has(entry.key)) return;
      seen.add(entry.key);
      const under = children.get(entry.key) ?? [];
      const collapsed = options.collapsed.has(entry.key);
      const parent = depth ? shown.get(entry.parent!) : undefined;
      rows.push({
        entry,
        depth,
        children: under.length,
        collapsed,
        last,
        ...(parent ? { after: `after ${mrRefLabel(parent, true)}` } : {}),
      });
      if (collapsed) return;
      under.forEach((child, index) =>
        add(child, depth + 1, index === under.length - 1, seen),
      );
    };
    const seen = new Set<string>();
    if (!options.folded.has(lane))
      top.forEach((entry, index) =>
        add(entry, 0, index === top.length - 1, seen),
      );
    groups.push({ lane, count, folded: options.folded.has(lane), rows });
  }
  return groups;
}

/**
 * The rows a row moves among with J / K and drag: its lane's own rows, or
 * its parent's children.
 */
export function mrLaneSiblings(
  groups: MrLaneGroup[],
  key: string,
): MrInboxEntry[] {
  for (const group of groups) {
    const row = group.rows.find((each) => each.entry.key === key);
    if (!row) continue;
    return group.rows
      .filter(
        (each) =>
          each.depth === row.depth && each.entry.parent === row.entry.parent,
      )
      .map((each) => each.entry);
  }
  return [];
}

const FOLDED_KEY = "mrReviewsLanesFolded";

/** The lanes folded on this device. */
export function storedFoldedLanes(): Set<string> {
  try {
    const value = JSON.parse(roamgateLocalStorage.getItem(FOLDED_KEY) ?? "[]");
    return new Set(
      Array.isArray(value)
        ? value.filter((lane) => MR_LANES.includes(lane as MrLane))
        : [],
    );
  } catch {
    return new Set();
  }
}

export function keepFoldedLanes(folded: ReadonlySet<string>) {
  try {
    roamgateLocalStorage.setItem(FOLDED_KEY, JSON.stringify([...folded]));
  } catch {
    // Kept for this page only.
  }
}
