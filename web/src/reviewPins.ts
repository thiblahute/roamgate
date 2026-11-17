import type { ReviewSnapshot } from "../../shared/review";

/*
 * Reviews pinned to workspaces (App.tsx): a small module of its own, as the
 * review model is not part of the first paint.
 */

/** Where a review is pinned: its connection and workspace. */
export function reviewPinKey(connectionId: string, workspaceId: string) {
  return `${connectionId}\n${workspaceId}`;
}

/**
 * Whether a workspace's pin still holds its review: the review must still be
 * of that connection and workspace (one without a workspace stays where it
 * was pinned). A review opened again from another workspace moves there;
 * the old pin would show it, and un-close it, in that other workspace.
 */
export function pinHolds(key: string, snapshot: ReviewSnapshot): boolean {
  const { connectionId, workspaceId } = snapshot.session;
  if (!key.startsWith(`${connectionId}\n`)) return false;
  return !workspaceId || key === reviewPinKey(connectionId, workspaceId);
}

/** The connection of a pin, as reviewPinKey wrote it. */
function pinConnection(key: string) {
  const end = key.indexOf("\n");
  return end < 0 ? key : key.slice(0, end);
}

/**
 * The pins whose review moved elsewhere or is gone, dropped; the same object
 * when none was. A review not known is gone once its connection's list has
 * loaded (`loaded`); until then it keeps its pin.
 */
export function livePins(
  pins: Record<string, string>,
  sessions: ReadonlyMap<string, ReviewSnapshot>,
  loaded: ReadonlySet<string>,
): Record<string, string> {
  const stale = Object.entries(pins).filter(([key, id]) => {
    const snapshot = sessions.get(id);
    if (!snapshot) return loaded.has(pinConnection(key));
    return !pinHolds(key, snapshot);
  });
  if (!stale.length) return pins;
  const live = { ...pins };
  for (const [key] of stale) delete live[key];
  return live;
}

/** The most workspaces whose closed or last review is remembered. */
export const REVIEW_MEMORY_KEPT = 50;

/** The record with `key` set last, its oldest entries dropped past `max`. */
export function withLatest(
  record: Record<string, string>,
  key: string,
  value: string,
  max = REVIEW_MEMORY_KEPT,
): Record<string, string> {
  const kept = Object.entries(record)
    .filter(([known]) => known !== key)
    .slice(-(max - 1));
  return Object.fromEntries([...kept, [key, value]]);
}
