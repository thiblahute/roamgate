/**
 * Going through the unresolved threads only, in a review or an agent chat:
 * gn / gN, the arrows beside the comments chip, and "2 of 5 unresolved".
 * Pure functions over the threads in the order they are read, resolved ones
 * included, so a step can start from a resolved thread or from a line
 * between threads.
 */

export type NavThread = { id: string; resolved: boolean };

/**
 * Where the reader is in that order: on the thread at `index`, or (not on
 * one) before it; `index` may be the order's length, past the last one.
 */
export type NavPlace = { index: number; on: boolean };

export type UnresolvedStep = {
  /** The thread to go to, in the order given. */
  index: number;
  id: string;
  /** Its place among the unresolved ones, from 1. */
  position: number;
  total: number;
  /** Past the last (or before the first) one, back from the other end. */
  wrapped: boolean;
};

/** The unresolved threads, in order. */
export function unresolvedOf<T extends NavThread>(
  order: readonly T[],
): readonly T[] {
  return order.filter((thread) => !thread.resolved);
}

/** Where the thread `id` is among the unresolved ones (from 1), or null. */
export function unresolvedPosition(
  order: readonly NavThread[],
  id: string | null | undefined,
): number | null {
  if (!id) return null;
  const open = unresolvedOf(order);
  const index = open.findIndex((thread) => thread.id === id);
  return index < 0 ? null : index + 1;
}

/**
 * The next (1) or previous (-1) unresolved thread from `from`, wrapping
 * around; null when none is unresolved. On the only unresolved thread, it
 * is that one again, wrapped.
 */
export function stepUnresolved(
  order: readonly NavThread[],
  from: NavPlace,
  direction: 1 | -1,
): UnresolvedStep | null {
  const total = order.filter((thread) => !thread.resolved).length;
  if (!total) return null;
  const count = order.length;
  const at = Math.max(0, Math.min(count, from.index));
  const found = (index: number, wrapped: boolean): UnresolvedStep => {
    const thread = order[index]!;
    return {
      index,
      id: thread.id,
      position: unresolvedPosition(order, thread.id)!,
      total,
      wrapped,
    };
  };
  if (direction === 1) {
    for (let index = from.on ? at + 1 : at; index < count; index++)
      if (!order[index]!.resolved) return found(index, false);
    for (let index = 0; index < count; index++)
      if (!order[index]!.resolved) return found(index, true);
  } else {
    for (let index = at - 1; index >= 0; index--)
      if (!order[index]!.resolved) return found(index, false);
    for (let index = count - 1; index >= 0; index--)
      if (!order[index]!.resolved) return found(index, true);
  }
  return null;
}

/** Compares sort keys made of numbers and strings, part by part. */
export function compareKeys(
  a: readonly (number | string)[],
  b: readonly (number | string)[],
): number {
  for (let index = 0; index < Math.max(a.length, b.length); index++) {
    const left = a[index];
    const right = b[index];
    if (left === right) continue;
    if (left === undefined) return -1;
    if (right === undefined) return 1;
    if (typeof left === "number" && typeof right === "number")
      return left - right;
    return String(left).localeCompare(String(right));
  }
  return 0;
}

/** What the notice says after a step: "2 of 5 unresolved", and a wrap. */
export function stepNotice(step: UnresolvedStep, direction: 1 | -1): string {
  const where = `${step.position} of ${step.total} unresolved`;
  if (!step.wrapped) return where;
  if (step.total === 1) return `${where}: the only one`;
  return `${where}, back at the ${direction === 1 ? "first" : "last"}`;
}
