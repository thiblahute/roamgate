import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  DRAFTS_MAX_CHARS,
  DRAFTS_PER_SESSION,
  discardReviewDrafts,
  keepReviewDraft,
  reviewDraftCount,
  takeReviewDraft,
} from "./reviewDrafts";

const original = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
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
    keepReviewDraft("s1", `reply:${i}`, `text ${i}`, 1000 + i);
  expect(reviewDraftCount("s1")).toBe(DRAFTS_PER_SESSION);
  expect(takeReviewDraft("s1", "reply:0")).toBeUndefined();
  expect(takeReviewDraft("s1", `reply:${DRAFTS_PER_SESSION + 2}`)).toBe(
    `text ${DRAFTS_PER_SESSION + 2}`,
  );
});

test("past the room for all drafts the oldest go first", () => {
  const big = "x".repeat(Math.floor(DRAFTS_MAX_CHARS / 3));
  keepReviewDraft("old", "overall", big, 1);
  keepReviewDraft("mid", "overall", big, 2);
  keepReviewDraft("new", "overall", big, 3);
  expect(reviewDraftCount("old")).toBe(0);
  expect(reviewDraftCount("mid")).toBe(1);
  expect(reviewDraftCount("new")).toBe(1);
  // One too large for the room is not kept, and pushes nothing out.
  keepReviewDraft("huge", "overall", "y".repeat(DRAFTS_MAX_CHARS), 4);
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
    JSON.stringify({ s1: { a: { text: 3 }, b: { text: "ok", at: 1 } } }),
  );
  expect(reviewDraftCount("s1")).toBe(1);
});
