import { describe, expect, test } from "bun:test";
import type { MrInboxEntry } from "../../shared/mrReviews";
import { moveMrKey, mrMatches, orderMrEntries } from "./mrReviewsOrder";

const keyed = (...keys: string[]) => keys.map((key) => ({ key }));

describe("the user's order of the reviews inbox", () => {
  test("no order: the inbox's own", () => {
    expect(orderMrEntries(keyed("a", "b"), [])).toEqual(keyed("a", "b"));
  });

  test("new requests first, then the user's order; gone keys ignored", () => {
    expect(
      orderMrEntries(keyed("a", "b", "c", "new"), ["gone", "c", "a", "b"]),
    ).toEqual(keyed("new", "c", "a", "b"));
  });

  test("a key moves before or after another", () => {
    expect(moveMrKey(["a", "b", "c"], "c", "a", "before")).toEqual([
      "c",
      "a",
      "b",
    ]);
    expect(moveMrKey(["a", "b", "c"], "a", "b", "after")).toEqual([
      "b",
      "a",
      "c",
    ]);
    expect(moveMrKey(["a", "b"], "a", "x", "after")).toEqual(["a", "b"]);
  });
});

test("the search finds a request by every word typed", () => {
  const entry = {
    provider: "gitlab",
    host: "gitlab.freedesktop.org",
    project: "gstreamer/gstreamer",
    number: 1234,
    title: "Fix the GES timeline",
    author: "thiblahute",
    state: "open",
    draft: true,
    sourceBranch: "ges-fix",
    targetBranch: "main",
    reasons: ["review_requested"],
  } as unknown as MrInboxEntry;
  for (const query of [
    "",
    "timeline",
    "ges TIMELINE",
    "!1234",
    "gstreamer!1234",
    "thibla",
    "ges-fix",
    "draft",
    "review requested",
  ])
    expect(mrMatches(entry, query)).toBe(true);
  expect(mrMatches(entry, "timeline audio")).toBe(false);
});
