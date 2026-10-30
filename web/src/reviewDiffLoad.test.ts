import { expect, test } from "bun:test";
import { ReviewDiffs } from "./reviewDiffLoad";

test("a slow answer for a view already left neither shows nor caches", () => {
  const diffs = new ReviewDiffs<string>();
  const a = diffs.begin("a");
  const b = diffs.begin("b");
  expect(b.done("diff of b")).toBe(true);
  // A answers last: B's view keeps B's diff.
  expect(a.current()).toBe(false);
  expect(a.done("diff of a")).toBe(false);
  expect(diffs.get("a")).toBeUndefined();
  expect(diffs.get("b")).toBe("diff of b");
});

test("moving to a cached view makes the pending one stale", () => {
  const diffs = new ReviewDiffs<string>();
  expect(diffs.begin("b").done("diff of b")).toBe(true);
  const a = diffs.begin("a");
  const b = diffs.begin("b");
  expect(b.cached).toBe("diff of b");
  expect(a.done("diff of a")).toBe(false);
});

test("an answer asked before a reload does not refill the cache", () => {
  const diffs = new ReviewDiffs<string>();
  const shown = diffs.begin("a");
  const searched = diffs.begin("b", { shown: false });
  diffs.clear();
  expect(shown.done("old a")).toBe(false);
  expect(searched.done("old b")).toBe(false);
  expect(diffs.get("a")).toBeUndefined();
  expect(diffs.get("b")).toBeUndefined();
});

test("looking at another view keeps the shown one current", () => {
  const diffs = new ReviewDiffs<string>();
  const shown = diffs.begin("a");
  const searched = diffs.begin("b", { shown: false });
  expect(searched.done("diff of b")).toBe(true);
  expect(shown.done("diff of a")).toBe(true);
  // Asked fresh: the cached diff is not offered.
  expect(diffs.begin("a", { fresh: true }).cached).toBeUndefined();
  expect(diffs.begin("a").cached).toBe("diff of a");
});

test("only the most recently used diffs are kept", () => {
  const diffs = new ReviewDiffs<string>(2);
  for (const sha of ["a", "b", "c"]) diffs.begin(sha).done(sha);
  expect(diffs.get("a")).toBeUndefined();
  expect(diffs.get("c")).toBe("c");
});
