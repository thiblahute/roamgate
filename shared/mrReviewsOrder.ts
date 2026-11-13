/**
 * The user's order of the reviews inbox: one list of request keys (the
 * settings' `order`), applied within each section. It lives on the server
 * and every change is an operation on the latest order (move X before Y),
 * never a stale list written over it. Pure: the server and the page share it.
 */

export const MR_SECTION_ORDER = ["pinned", "mine", "suggested"] as const;
export type MrOrderSection = (typeof MR_SECTION_ORDER)[number];

/** Requests kept in the user's order. */
export const MAX_ORDER = 500;

/** The entries in the user's order; those not in it (new ones) come first. */
export function orderMrEntries<T extends { key: string }>(
  entries: readonly T[],
  order: readonly string[],
): T[] {
  if (!order.length) return [...entries];
  const at = new Map(order.map((key, index) => [key, index]));
  const fresh = entries.filter((entry) => !at.has(entry.key));
  const placed = entries
    .filter((entry) => at.has(entry.key))
    .sort((a, b) => at.get(a.key)! - at.get(b.key)!);
  return [...fresh, ...placed];
}

/** `keys` with `key` moved just before or after `target`. */
export function moveMrKey(
  keys: readonly string[],
  key: string,
  target: string,
  place: "before" | "after",
): string[] {
  if (key === target || !keys.includes(key) || !keys.includes(target))
    return [...keys];
  const rest = keys.filter((each) => each !== key);
  const at = rest.indexOf(target) + (place === "after" ? 1 : 0);
  return [...rest.slice(0, at), key, ...rest.slice(at)];
}

/** What an order operation does. `keys` keep the order they are given in. */
export type MrOrderOp =
  | { op: "top" | "bottom"; keys: string[] }
  | { op: "before" | "after"; keys: string[]; target: string }
  /** The listed requests first, in this order; the rest follow unchanged. */
  | { op: "arrange"; keys: string[] };

export type MrOrderSections = Record<MrOrderSection, string[]>;

export type MrOrderOutcome = {
  sections: MrOrderSections;
  /** Keys whose place changed. */
  moved: string[];
  /** Keys that are not listed in the inbox. */
  unknown: string[];
  /** Keys left alone: they are in another section than the target. */
  elsewhere: string[];
};

function sectionOf(
  sections: MrOrderSections,
  key: string,
): MrOrderSection | null {
  for (const name of MR_SECTION_ORDER)
    if (sections[name].includes(key)) return name;
  return null;
}

/**
 * Applies an operation to the displayed sections (each in its shown order).
 * top, bottom and arrange act within each request's own section; before and
 * after place the keys beside the target, in the target's section.
 */
export function applyMrOrderOp(
  current: MrOrderSections,
  operation: MrOrderOp,
): MrOrderOutcome {
  const sections: MrOrderSections = {
    pinned: [...current.pinned],
    mine: [...current.mine],
    suggested: [...current.suggested],
  };
  const unknown: string[] = [];
  const elsewhere: string[] = [];
  const keys: string[] = [];
  for (const key of operation.keys) {
    if (keys.includes(key)) continue;
    if (!sectionOf(sections, key)) unknown.push(key);
    else keys.push(key);
  }
  const place = (name: MrOrderSection, group: string[], where: number) => {
    const rest = sections[name].filter((key) => !group.includes(key));
    sections[name] = [...rest.slice(0, where), ...group, ...rest.slice(where)];
  };
  if (operation.op === "before" || operation.op === "after") {
    const home = sectionOf(sections, operation.target);
    if (!home) {
      unknown.push(operation.target);
      return { sections, moved: [], unknown, elsewhere };
    }
    const group = keys.filter((key) => {
      if (key === operation.target) return false;
      if (sectionOf(sections, key) === home) return true;
      elsewhere.push(key);
      return false;
    });
    const rest = sections[home].filter((key) => !group.includes(key));
    const at =
      rest.indexOf(operation.target) + (operation.op === "after" ? 1 : 0);
    place(home, group, at);
  } else {
    for (const name of MR_SECTION_ORDER) {
      const group = keys.filter((key) => sections[name].includes(key));
      if (!group.length) continue;
      if (operation.op === "bottom")
        place(name, group, sections[name].length - group.length);
      else place(name, group, 0);
    }
  }
  const moved = MR_SECTION_ORDER.flatMap((name) =>
    sections[name].filter(
      (key, index) => current[name][index] !== key && keys.includes(key),
    ),
  );
  return { sections, moved, unknown, elsewhere };
}

/** The sections as one list, as the settings' `order` keeps them. */
export function flattenMrSections(sections: MrOrderSections): string[] {
  return MR_SECTION_ORDER.flatMap((name) => sections[name]);
}

/**
 * The new stored order: the displayed one, then the keys the old order had
 * that are not listed now (a removed request keeps its place until it
 * returns), capped.
 */
export function storedMrOrder(
  displayed: readonly string[],
  previous: readonly string[],
): string[] {
  const seen = new Set(displayed);
  return [...displayed, ...previous.filter((key) => !seen.has(key))].slice(
    0,
    MAX_ORDER,
  );
}

/** Indices of the longest increasing run of `values`. */
function longestIncreasing(values: readonly number[]): Set<number> {
  const tails: number[] = [];
  const back: number[] = new Array(values.length).fill(-1);
  for (let i = 0; i < values.length; i++) {
    let lo = 0;
    let hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (values[tails[mid]!]! < values[i]!) lo = mid + 1;
      else hi = mid;
    }
    if (lo > 0) back[i] = tails[lo - 1]!;
    tails[lo] = i;
  }
  const out = new Set<number>();
  for (let at = tails[tails.length - 1] ?? -1; at >= 0; at = back[at]!)
    out.add(at);
  return out;
}

/**
 * A whole list written by someone who last saw `base`, put on `current`:
 * only what they moved (keys out of the order `base` had) is applied, each
 * just after the key that precedes it in their list (the end stays the end),
 * so another change made since survives. Keys `current` lacks are placed the same way.
 */
export function rebaseMrOrder(
  base: readonly string[],
  theirs: readonly string[],
  current: readonly string[],
): string[] {
  const baseAt = new Map(base.map((key, index) => [key, index]));
  const known = theirs.filter((key) => baseAt.has(key));
  const stay = longestIncreasing(known.map((key) => baseAt.get(key)!));
  const moves = new Set(known.filter((_, index) => !stay.has(index)));
  const have = new Set(current);
  for (const key of theirs)
    if (!baseAt.has(key) && !have.has(key)) moves.add(key);
  let out = [...current];
  theirs.forEach((key, at) => {
    if (!moves.has(key)) return;
    out = out.filter((each) => each !== key);
    if (at === theirs.length - 1) {
      // Moved to the end: still the end.
      out.push(key);
      return;
    }
    let before = -1;
    for (let i = at - 1; i >= 0 && before < 0; i--)
      before = out.indexOf(theirs[i]!);
    out.splice(before + 1, 0, key);
  });
  return out.slice(0, MAX_ORDER);
}

/** "3 requests" / "1 request": the words of a summary. */
export function mrCount(count: number): string {
  return `${count} request${count === 1 ? "" : "s"}`;
}
