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

/**
 * The pins whose review moved elsewhere, dropped; the same object when none
 * did. A review not loaded yet keeps its pin until it is known.
 */
export function livePins(
  pins: Record<string, string>,
  sessions: ReadonlyMap<string, ReviewSnapshot>,
): Record<string, string> {
  const stale = Object.entries(pins).filter(([key, id]) => {
    const snapshot = sessions.get(id);
    return snapshot !== undefined && !pinHolds(key, snapshot);
  });
  if (!stale.length) return pins;
  const live = { ...pins };
  for (const [key] of stale) delete live[key];
  return live;
}
