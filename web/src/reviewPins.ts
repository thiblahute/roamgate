import type { ReviewHead, ReviewSummary } from "../../shared/review";
import { roamgateLocalStorage } from "./browserStorage";

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
export function pinHolds(key: string, snapshot: ReviewHead): boolean {
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
  sessions: ReadonlyMap<string, ReviewHead>,
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

/**
 * A review remembered by workspace in this browser (the pins, Option+R's
 * last one): `{ [reviewPinKey]: sessionId }`, empty when unreadable.
 */
export function readReviewMemory(key: string): Record<string, string> {
  try {
    const all = JSON.parse(roamgateLocalStorage.getItem(key) ?? "{}");
    return all && typeof all === "object" && !Array.isArray(all) ? all : {};
  } catch {
    return {};
  }
}

export function writeReviewMemory(
  key: string,
  record: Record<string, string>,
): void {
  try {
    roamgateLocalStorage.setItem(key, JSON.stringify(record));
  } catch {}
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

/*
 * The reviews shown in a workspace's Changes, remembered in this browser:
 * the one shown (back after a reload or a server restart) and the others
 * opened there lately (a commit's, a range, a compare, a merge request),
 * the latest first, offered by the scope picker. Kept small: the
 * WORKSPACE_REVIEWS_KEPT latest of the REVIEW_MEMORY_KEPT workspaces last
 * used; obsolete ones are dropped as they are found (liveWorkspaceReviews).
 */

const WORKSPACE_REVIEWS_KEY = "reviewChangesRecent";
/** The most reviews a workspace's Changes remembers. */
export const WORKSPACE_REVIEWS_KEPT = 12;
/** A review with no thread not shown for this long is forgotten. */
export const WORKSPACE_REVIEW_IDLE_MS = 14 * 24 * 60 * 60 * 1000;

/** A review shown this lately is kept though its review is not listed. */
export const WORKSPACE_REVIEW_GRACE_MS = 60_000;

/** A review shown in a workspace's Changes: when, and as it was named. */
export type WorkspaceReview = { id: string; at: number; label?: string };

export type WorkspaceReviews = {
  /** The review Changes shows, null for its own scope. */
  shown: string | null;
  /** The latest first. */
  reviews: WorkspaceReview[];
};

const NO_REVIEWS: WorkspaceReviews = { shown: null, reviews: [] };

function readAllWorkspaceReviews(): Record<string, WorkspaceReviews> {
  try {
    const all = JSON.parse(
      roamgateLocalStorage.getItem(WORKSPACE_REVIEWS_KEY) ?? "{}",
    );
    return all && typeof all === "object" && !Array.isArray(all) ? all : {};
  } catch {
    return {};
  }
}

/** A workspace's reviews (reviewPinKey); none when unreadable. */
export function readWorkspaceReviews(key: string): WorkspaceReviews {
  const value = readAllWorkspaceReviews()[key];
  if (!value || typeof value !== "object") return NO_REVIEWS;
  const reviews = Array.isArray(value.reviews)
    ? value.reviews.filter(
        (each): each is WorkspaceReview =>
          !!each &&
          typeof each.id === "string" &&
          typeof each.at === "number" &&
          (each.label === undefined || typeof each.label === "string"),
      )
    : [];
  return {
    shown: typeof value.shown === "string" ? value.shown : null,
    reviews,
  };
}

/** Remembers a workspace's reviews, the latest workspace of those kept. */
export function writeWorkspaceReviews(key: string, value: WorkspaceReviews) {
  try {
    const kept = Object.entries(readAllWorkspaceReviews())
      .filter(([known]) => known !== key)
      .slice(-(REVIEW_MEMORY_KEPT - 1));
    const empty = !value.shown && !value.reviews.length;
    roamgateLocalStorage.setItem(
      WORKSPACE_REVIEWS_KEY,
      JSON.stringify(
        Object.fromEntries(empty ? kept : [...kept, [key, value]]),
      ),
    );
  } catch {}
}

/**
 * `id` shown now (first of the list, named `label` when given), or the
 * workspace's own scope (null): the list as it was.
 */
export function withShownReview(
  value: WorkspaceReviews,
  id: string | null,
  now: number,
  label?: string,
): WorkspaceReviews {
  if (id === null)
    return value.shown === null ? value : { ...value, shown: null };
  const before = value.reviews.find((each) => each.id === id);
  // Shown still (a reload): as it was, its time that of its showing.
  if (value.shown === id && before && (!label || label === before.label))
    return value;
  const named = label ?? before?.label;
  return {
    shown: id,
    reviews: [
      { id, at: now, ...(named ? { label: named } : {}) },
      ...value.reviews.filter((each) => each.id !== id),
    ].slice(0, WORKSPACE_REVIEWS_KEPT),
  };
}

/** `id` forgotten (shown no more either). */
export function withoutReview(
  value: WorkspaceReviews,
  id: string,
): WorkspaceReviews {
  if (value.shown !== id && !value.reviews.some((each) => each.id === id))
    return value;
  return {
    shown: value.shown === id ? null : value.shown,
    reviews: value.reviews.filter((each) => each.id !== id),
  };
}

/**
 * Whether a remembered review is still worth offering: "drop" once it is
 * obsolete (its review discarded, its code gone from the checkout, its
 * merge request merged or closed, or no thread and not shown for
 * WORKSPACE_REVIEW_IDLE_MS); "outdated" when it would be but has open
 * threads, never dropped for them; else "live". A review not known is kept
 * until its connection's list has loaded (`loaded`).
 */
export function workspaceReviewStanding(
  entry: WorkspaceReview,
  snapshot: ReviewSummary | undefined,
  { loaded, gone, now }: { loaded: boolean; gone: boolean; now: number },
): "live" | "outdated" | "drop" {
  // Shown a moment ago: its review may not be listed yet.
  if (!snapshot)
    return loaded && now - entry.at > WORKSPACE_REVIEW_GRACE_MS
      ? "drop"
      : "live";
  const state = snapshot.mergeRequest?.state.toLowerCase();
  const obsolete =
    gone ||
    state === "merged" ||
    state === "closed" ||
    (!snapshot.counts.threads && now - entry.at > WORKSPACE_REVIEW_IDLE_MS);
  if (!obsolete) return "live";
  return snapshot.counts.open ? "outdated" : "drop";
}

/**
 * A workspace's reviews with the obsolete ones dropped (the one shown is
 * kept while its review is known: Changes lets go of it itself), and those
 * kept though outdated; the same value when none was dropped.
 */
export function liveWorkspaceReviews(
  value: WorkspaceReviews,
  sessions: ReadonlyMap<string, ReviewSummary>,
  {
    loaded,
    gone,
    now,
  }: { loaded: boolean; gone: ReadonlySet<string>; now: number },
): { value: WorkspaceReviews; outdated: ReadonlySet<string> } {
  const outdated = new Set<string>();
  const dropped = new Set<string>();
  for (const entry of value.reviews) {
    const snapshot = sessions.get(entry.id);
    const standing = workspaceReviewStanding(entry, snapshot, {
      loaded,
      gone: gone.has(entry.id),
      now,
    });
    if (standing === "outdated") outdated.add(entry.id);
    else if (standing === "drop" && (entry.id !== value.shown || !snapshot))
      dropped.add(entry.id);
  }
  if (
    value.shown &&
    loaded &&
    !sessions.has(value.shown) &&
    !value.reviews.some((each) => each.id === value.shown)
  )
    dropped.add(value.shown);
  if (!dropped.size) return { value, outdated };
  return {
    value: {
      shown: value.shown && dropped.has(value.shown) ? null : value.shown,
      reviews: value.reviews.filter((each) => !dropped.has(each.id)),
    },
    outdated,
  };
}
