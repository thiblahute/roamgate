import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  DRAFT_MAX_AGE_MS,
  DRAFTS_MAX_CHARS,
  DRAFTS_PER_SESSION,
  describeDraftPlace,
  discardReviewDrafts,
  draftImagesNow,
  draftPlaceOf,
  draftSessionIds,
  keepDraftImages,
  keepReviewDraft,
  peekReviewDraft,
  reviewDraftCount,
  reviewDraftKeys,
  reviewDraftPlaces,
  takeReviewDraft,
} from "./reviewDrafts";

const original = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
/** Now, as drafts older than DRAFT_MAX_AGE_MS are dropped. */
const T = Date.now();
let values: Map<string, string>;

beforeEach(() => {
  values = new Map();
  const storage: Storage = {
    get length() {
      return values.size;
    },
    key: (index) => [...values.keys()][index] ?? null,
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value);
    },
    removeItem: (key) => {
      values.delete(key);
    },
    clear: () => values.clear(),
  };
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: storage,
  });
});

afterEach(() => {
  if (original) Object.defineProperty(globalThis, "localStorage", original);
  else Reflect.deleteProperty(globalThis, "localStorage");
});

test("a draft outlives the overlay and is handed back once", () => {
  keepReviewDraft("s1", "reply:c1", "half a thought");
  keepReviewDraft("s2", "overall", "other review");
  // What a new overlay, after a reload, reads.
  expect([...values.keys()].some((key) => key.includes("reviewDrafts"))).toBe(
    true,
  );
  expect(reviewDraftCount("s1")).toBe(1);
  expect(takeReviewDraft("s1", "reply:c1")).toBe("half a thought");
  expect(takeReviewDraft("s1", "reply:c1")).toBeUndefined();
  expect(takeReviewDraft("s2", "overall")).toBe("other review");
  // Empty text is no draft.
  keepReviewDraft("s1", "overall", "  ");
  expect(reviewDraftCount("s1")).toBe(0);
});

test("a review keeps its newest drafts only", () => {
  for (let i = 0; i < DRAFTS_PER_SESSION + 3; i++)
    keepReviewDraft("s1", `reply:${i}`, `text ${i}`, T + 1000 + i);
  expect(reviewDraftCount("s1")).toBe(DRAFTS_PER_SESSION);
  expect(takeReviewDraft("s1", "reply:0")).toBeUndefined();
  expect(takeReviewDraft("s1", `reply:${DRAFTS_PER_SESSION + 2}`)).toBe(
    `text ${DRAFTS_PER_SESSION + 2}`,
  );
});

test("past the room for all drafts the oldest go first", () => {
  const big = "x".repeat(Math.floor(DRAFTS_MAX_CHARS / 3));
  keepReviewDraft("old", "overall", big, T + 1);
  keepReviewDraft("mid", "overall", big, T + 2);
  keepReviewDraft("new", "overall", big, T + 3);
  expect(reviewDraftCount("old")).toBe(0);
  expect(reviewDraftCount("mid")).toBe(1);
  expect(reviewDraftCount("new")).toBe(1);
  // One too large for the room is not kept, and pushes nothing out.
  keepReviewDraft("huge", "overall", "y".repeat(DRAFTS_MAX_CHARS), T + 4);
  expect(reviewDraftCount("huge")).toBe(0);
  expect(reviewDraftCount("new")).toBe(1);
});

test("a removed review keeps its drafts until they are discarded", () => {
  keepReviewDraft("gone", "new:draft:{}", "kept for later");
  keepReviewDraft("other", "overall", "stays");
  // Nothing drops a review's drafts but a discard (or a cap).
  expect(reviewDraftCount("gone")).toBe(1);
  discardReviewDrafts("gone");
  expect(reviewDraftCount("gone")).toBe(0);
  expect(reviewDraftCount("other")).toBe(1);
});

test("damaged storage reads as no drafts", () => {
  values.set("roamgate:reviewDrafts", "{not json");
  expect(reviewDraftCount("s1")).toBe(0);
  values.set(
    "roamgate:reviewDrafts",
    JSON.stringify({ s1: { a: { text: 3 }, b: { text: "ok", at: T } } }),
  );
  expect(reviewDraftCount("s1")).toBe(1);
});

test("each draft says where it was written, the newest first", () => {
  keepReviewDraft(
    "s1",
    `new:discussion:${JSON.stringify({ path: "play.c", line: 144, side: "new", text: "die (" })}`,
    "Logging?",
    T + 1,
  );
  keepReviewDraft("s1", "reply:t1", "And?", T + 3);
  keepReviewDraft("s1", "edit:c1", "Reworded", T + 2);
  keepReviewDraft("s1", "overall", "All good", T + 4);
  keepReviewDraft("s1", "new:bogus", "Lost key", T + 5);
  const places = reviewDraftPlaces("s1");
  expect(places.map((place) => place.kind)).toEqual([
    "overall",
    "reply",
    "edit",
    "new",
  ]);
  expect(places[3]).toMatchObject({
    kind: "new",
    comment: "discussion",
    path: "play.c",
    line: 144,
    side: "new",
    text: "die (",
  });
  const whereOf = (ids: { threadId?: string; commentId?: string }) =>
    ids.threadId === "t1" ? "api.rs:100" : undefined;
  expect(places.map((place) => describeDraftPlace(place, whereOf))).toEqual([
    "the overall comment",
    "a reply on api.rs:100",
    "an edit",
    "play.c:144",
  ]);
  // A key from no editor is no place.
  expect(draftPlaceOf("new:bogus", 0)).toBeNull();
});

test("a draft read for its box stays until sent; one left too long goes", () => {
  keepReviewDraft("work:1", "comment", "half", Date.now());
  keepReviewDraft("work:2", "ask", "old", Date.now() - DRAFT_MAX_AGE_MS - 1);
  expect(peekReviewDraft("work:1", "comment")).toBe("half");
  expect(peekReviewDraft("work:1", "comment")).toBe("half");
  expect(reviewDraftKeys("work:1")).toEqual(["comment"]);
  // Thirty days on: as if never written.
  expect(peekReviewDraft("work:2", "ask")).toBeUndefined();
  expect(draftSessionIds("work:")).toEqual(["work:1"]);
});

test("a draft's images go with it", () => {
  const image = {
    token: "work-image:1",
    name: "a.png",
    type: "image/png",
    data: "AQID",
  };
  keepReviewDraft("work-add", "p", "See ![a](<work-image:1>)");
  keepDraftImages("work-add", "p", [image]);
  expect(draftImagesNow("work-add", "p")).toEqual([image]);
  // Another box's draft written: these stay.
  keepReviewDraft("work:1", "comment", "other");
  expect(draftImagesNow("work-add", "p")).toEqual([image]);
  // Sent: the text goes, and its images.
  expect(takeReviewDraft("work-add", "p")).toContain("work-image:1");
  expect(draftImagesNow("work-add", "p")).toEqual([]);
});
