import { afterEach, beforeEach, expect, test } from "bun:test";
import type { ReviewSnapshot, ReviewThread } from "../../shared/review";
import {
  liveWorkspaceReviews,
  readWorkspaceReviews,
  REVIEW_MEMORY_KEPT,
  reviewPinKey,
  WORKSPACE_REVIEW_GRACE_MS,
  WORKSPACE_REVIEW_IDLE_MS,
  WORKSPACE_REVIEWS_KEPT,
  type WorkspaceReviews,
  withoutReview,
  withShownReview,
  workspaceReviewStanding,
  writeWorkspaceReviews,
} from "./reviewPins";

/*
 * The reviews a workspace's Changes remembers: the one shown (back after a
 * reload), the others opened there lately, the latest first, and the
 * obsolete ones forgotten (never one with open threads: outdated instead).
 */

const original = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
let values: Map<string, string>;

beforeEach(() => {
  values = new Map();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      get length() {
        return values.size;
      },
      key: (index: number) => [...values.keys()][index] ?? null,
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => {
        values.set(key, value);
      },
      removeItem: (key: string) => {
        values.delete(key);
      },
      clear: () => values.clear(),
    } satisfies Storage,
  });
});

afterEach(() => {
  if (original) Object.defineProperty(globalThis, "localStorage", original);
  else Reflect.deleteProperty(globalThis, "localStorage");
});

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse("2026-11-19T12:00:00Z");

function snap(
  id: string,
  {
    threads = [],
    state,
  }: { threads?: Partial<ReviewThread>[]; state?: string } = {},
): ReviewSnapshot {
  return {
    session: {
      id,
      connectionId: "desktop",
      workspaceId: "w1",
      root: "/r",
      title: id,
      target: state
        ? { kind: "mr", url: "https://gitlab.example/g/p/-/merge_requests/7" }
        : { kind: "range", base: `${id}^`, head: id },
      gitlab: !!state,
      summary: "",
      agent: {},
      createdAt: "2026-10-30",
      updatedAt: "2026-10-30",
    },
    threads: threads as ReviewThread[],
    ...(state
      ? {
          mergeRequest: {
            url: "https://gitlab.example/g/p/-/merge_requests/7",
            title: "Fix",
            state,
            headSha: "f".repeat(40),
            security: false,
          },
        }
      : {}),
  } as ReviewSnapshot;
}

test("the review shown comes first and is the one shown; its own scope keeps the list", () => {
  let value: WorkspaceReviews = { shown: null, reviews: [] };
  value = withShownReview(value, "a", NOW - 3000);
  value = withShownReview(value, "b", NOW - 2000, "d2726424 Fix the pads");
  value = withShownReview(value, "a", NOW - 1000);
  expect(value).toEqual({
    shown: "a",
    reviews: [
      { id: "a", at: NOW - 1000 },
      { id: "b", at: NOW - 2000, label: "d2726424 Fix the pads" },
    ],
  });
  // Shown still (a reload): the same value, its time kept.
  expect(withShownReview(value, "a", NOW)).toBe(value);
  // Named once its commit is read.
  expect(withShownReview(value, "a", NOW, "abc Named").reviews[0]).toEqual({
    id: "a",
    at: NOW,
    label: "abc Named",
  });
  const own = withShownReview(value, null, NOW);
  expect(own.shown).toBeNull();
  expect(own.reviews).toEqual(value.reviews);
  expect(withoutReview(value, "a")).toEqual({
    shown: null,
    reviews: [{ id: "b", at: NOW - 2000, label: "d2726424 Fix the pads" }],
  });
  expect(withoutReview(value, "zz")).toBe(value);
});

test("a workspace keeps its latest reviews, and the latest workspaces; damaged storage reads as none", () => {
  let value: WorkspaceReviews = { shown: null, reviews: [] };
  for (let i = 0; i < WORKSPACE_REVIEWS_KEPT + 3; i++)
    value = withShownReview(value, `r${i}`, NOW + i);
  expect(value.reviews).toHaveLength(WORKSPACE_REVIEWS_KEPT);
  expect(value.reviews[0]?.id).toBe(`r${WORKSPACE_REVIEWS_KEPT + 2}`);
  const key = reviewPinKey("desktop", "workspace:w1");
  writeWorkspaceReviews(key, value);
  expect(readWorkspaceReviews(key)).toEqual(value);
  for (let i = 0; i < REVIEW_MEMORY_KEPT; i++)
    writeWorkspaceReviews(reviewPinKey("desktop", `workspace:o${i}`), {
      shown: "x",
      reviews: [{ id: "x", at: NOW }],
    });
  // The oldest workspace is forgotten past the ones kept.
  expect(readWorkspaceReviews(key)).toEqual({ shown: null, reviews: [] });
  // Nothing remembered: no entry kept for it.
  writeWorkspaceReviews(reviewPinKey("desktop", "workspace:o1"), {
    shown: null,
    reviews: [],
  });
  expect(values.get("roamgate:reviewChangesRecent")).not.toContain(
    'workspace:o1"',
  );
  values.set("roamgate:reviewChangesRecent", "{oops");
  expect(readWorkspaceReviews(key)).toEqual({ shown: null, reviews: [] });
  values.set(
    "roamgate:reviewChangesRecent",
    JSON.stringify({
      [key]: { shown: 3, reviews: [{ id: 1 }, { id: "ok", at: 1 }] },
    }),
  );
  expect(readWorkspaceReviews(key)).toEqual({
    shown: null,
    reviews: [{ id: "ok", at: 1 }],
  });
});

test("obsolete reviews are dropped: discarded, gone, merged or closed, idle with no thread; open threads keep one, outdated", () => {
  const standing = (
    snapshot: ReviewSnapshot | undefined,
    { at = NOW - DAY, gone = false, loaded = true } = {},
  ) =>
    workspaceReviewStanding({ id: "x", at }, snapshot, {
      loaded,
      gone,
      now: NOW,
    });
  const open = { threads: [{ resolved: false }] };
  const resolved = { threads: [{ resolved: true }] };
  expect(standing(snap("a"))).toBe("live");
  // Discarded: gone once the connection's list is read; shown just now,
  // kept (its review may not be listed yet).
  expect(standing(undefined)).toBe("drop");
  expect(standing(undefined, { loaded: false })).toBe("live");
  expect(standing(undefined, { at: NOW - WORKSPACE_REVIEW_GRACE_MS / 2 })).toBe(
    "live",
  );
  // Its commits or checkout gone.
  expect(standing(snap("a"), { gone: true })).toBe("drop");
  expect(standing(snap("a", resolved), { gone: true })).toBe("drop");
  expect(standing(snap("a", open), { gone: true })).toBe("outdated");
  // Its merge request merged or closed.
  expect(standing(snap("m", { state: "opened" }))).toBe("live");
  expect(standing(snap("m", { state: "merged" }))).toBe("drop");
  expect(standing(snap("m", { state: "closed", ...open }))).toBe("outdated");
  // Not shown for long, with no thread: forgotten; with threads, kept.
  const old = NOW - WORKSPACE_REVIEW_IDLE_MS - DAY;
  expect(standing(snap("a"), { at: old })).toBe("drop");
  expect(standing(snap("a", resolved), { at: old })).toBe("live");
});

test("a workspace's list loses its obsolete reviews, the one shown only once its review is gone", () => {
  const value: WorkspaceReviews = {
    shown: "merged",
    reviews: [
      { id: "merged", at: NOW - DAY },
      { id: "live", at: NOW - DAY },
      { id: "discarded", at: NOW - DAY },
      { id: "gone", at: NOW - DAY },
      { id: "kept", at: NOW - DAY },
    ],
  };
  const sessions = new Map([
    ["merged", snap("merged", { state: "merged" })],
    ["live", snap("live")],
    ["gone", snap("gone")],
    ["kept", snap("kept", { threads: [{ resolved: false }] })],
  ]);
  const result = liveWorkspaceReviews(value, sessions, {
    loaded: true,
    gone: new Set(["gone", "kept"]),
    now: NOW,
  });
  expect(result.value).toEqual({
    shown: "merged",
    reviews: [
      { id: "merged", at: NOW - DAY },
      { id: "live", at: NOW - DAY },
      { id: "kept", at: NOW - DAY },
    ],
  });
  expect([...result.outdated]).toEqual(["kept"]);
  // Nothing obsolete: the same value.
  expect(
    liveWorkspaceReviews(result.value, sessions, {
      loaded: true,
      gone: new Set(["kept"]),
      now: NOW,
    }).value,
  ).toEqual(result.value);
  // The review shown discarded: Changes back on its own scope.
  sessions.delete("merged");
  expect(
    liveWorkspaceReviews(result.value, sessions, {
      loaded: true,
      gone: new Set(),
      now: NOW,
    }).value.shown,
  ).toBeNull();
  // Before the list is read, nothing is dropped.
  expect(
    liveWorkspaceReviews(value, new Map(), {
      loaded: false,
      gone: new Set(),
      now: NOW,
    }).value,
  ).toBe(value);
});
