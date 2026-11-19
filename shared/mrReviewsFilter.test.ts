import { expect, test } from "bun:test";
import type { MrInboxEntry } from "./mrReviews";
import {
  mrFilterCompletions,
  mrFilterIsOwn,
  mrFilterMatches,
  parseMrFilter,
} from "./mrReviewsFilter";

const entry = (n: number, extra: Partial<MrInboxEntry> = {}): MrInboxEntry => ({
  provider: "gitlab",
  host: "h",
  project: "media/engine",
  number: n,
  key: `gitlab:h/media/engine#${n}`,
  url: `https://h/media/engine/-/merge_requests/${n}`,
  title: `Fix the buffer pool ${n}`,
  author: "me",
  draft: false,
  state: "open",
  updatedAt: "2026-11-15T00:00:00Z",
  headSha: "a",
  sourceBranch: `topic-${n}`,
  targetBranch: "main",
  pipeline: "success",
  notes: 0,
  reasons: ["authored"],
  section: "authored",
  unread: null,
  isNew: false,
  lane: "waiting",
  ...extra,
});

const keys = (list: MrInboxEntry[], query: string) =>
  list
    .filter((each) => mrFilterMatches(each, query))
    .map((each) => each.number);

test("tokens and words, negation, several values of one key", () => {
  expect(
    parseMrFilter('project:media/* -label:"needs work" pool -draft'),
  ).toEqual({
    tokens: [
      { key: "project", value: "media/*", not: false },
      { key: "label", value: "needs work", not: true },
    ],
    words: [
      { text: "pool", not: false },
      { text: "draft", not: true },
    ],
  });
  // An unknown key stays a word.
  expect(parseMrFilter("http://x").words).toEqual([
    { text: "http://x", not: false },
  ]);
  const list = [
    entry(1, { labels: ["audio"] }),
    entry(2, {
      project: "media/plugins",
      override: { labels: ["infra"], at: "t", by: "user", marker: "m" },
    }),
    entry(3, { project: "other/tool", lane: "your_move", pipeline: "failed" }),
    entry(4, {
      draft: true,
      author: "bob",
      reasons: ["review_requested"],
      section: "mine",
      lane: undefined,
    }),
  ];
  expect(keys(list, "project:media/*")).toEqual([1, 2, 4]);
  expect(keys(list, "project:media/")).toEqual([1, 2, 4]);
  expect(keys(list, "project:media/engine project:other/tool")).toEqual([
    1, 3, 4,
  ]);
  expect(keys(list, "label:audio")).toEqual([1]);
  expect(keys(list, "label:infra")).toEqual([2]);
  expect(keys(list, "-label:infra")).toEqual([1, 3, 4]);
  expect(keys(list, "lane:needs-you")).toEqual([3]);
  // The old name still reads.
  expect(keys(list, "lane:your-move")).toEqual([3]);
  expect(keys(list, "waiting:me")).toEqual([3]);
  expect(keys(list, "pipeline:failed")).toEqual([3]);
  expect(keys(list, "draft:yes")).toEqual([4]);
  expect(keys(list, "state:draft")).toEqual([4]);
  expect(keys(list, "author:bob")).toEqual([4]);
  expect(keys(list, "is:review")).toEqual([4]);
  expect(keys(list, "is:mine pool 3")).toEqual([3]);
  expect(keys(list, "-is:mine")).toEqual([4]);
  expect(keys(list, "!2")).toEqual([2]);
});

test("waiting: an override's whose-move, unless outdated", () => {
  const meta = { at: "t", by: "user" as const, marker: "m" };
  const list = [
    entry(1, { override: { whose: { person: "bob" }, ...meta } }),
    entry(2, {
      override: { whose: { person: "bob" }, ...meta },
      overrideOutdated: true,
    }),
    entry(3, { override: { whose: "external", ...meta } }),
  ];
  expect(keys(list, "waiting:bob")).toEqual([1]);
  expect(keys(list, "waiting:external")).toEqual([3]);
  expect(keys(list, "waiting:reviewer")).toEqual([2]);
});

test("own-work filters and completions", () => {
  expect(mrFilterIsOwn("is:mine")).toBe(true);
  expect(mrFilterIsOwn("lane:stale")).toBe(true);
  expect(mrFilterIsOwn("project:x")).toBe(false);
  const list = [
    entry(1, { labels: ["needs work"] }),
    entry(2, { project: "media/plugins", author: "alice" }),
  ];
  expect(mrFilterCompletions("pr", list).map((each) => each.label)).toEqual([
    "project:",
  ]);
  expect(mrFilterCompletions("-lab", list).map((each) => each.insert)).toEqual([
    "-label:",
  ]);
  expect(
    mrFilterCompletions("fix project:media/", list).map((each) => each.insert),
  ).toEqual([
    "fix project:media/* ",
    "fix project:media/engine ",
    "fix project:media/plugins ",
  ]);
  expect(mrFilterCompletions("label:n", list)[0]!.insert).toBe(
    'label:"needs work" ',
  );
  expect(
    mrFilterCompletions("lane:", list).map((each) => each.label),
  ).toContain("lane:needs-you");
  expect(mrFilterCompletions("pool", list)).toEqual([]);
});

test("merge keys: completions, and they keep one's own work", () => {
  const list = [
    entry(1, {
      lane: "merging",
      merge: { bot: { name: "marge-bot", via: "assignee", queued: true } },
    }),
  ];
  expect(mrFilterCompletions("bot:", list).map((each) => each.label)).toEqual(
    expect.arrayContaining(["bot:failed", "bot:marge-bot"]),
  );
  expect(
    mrFilterCompletions("merge-a", list).map((each) => each.label),
  ).toEqual(["merge-after:"]);
  expect(
    mrFilterCompletions("state:m", list).map((each) => each.label),
  ).toEqual(["state:merged", "state:merging"]);
  expect(mrFilterIsOwn("bot:any")).toBe(true);
  expect(mrFilterIsOwn("state:merging")).toBe(true);
  expect(mrFilterIsOwn("-merge-after:yes")).toBe(false);
  expect(mrFilterMatches(list[0]!, "-merge-after:yes bot:queued")).toBe(true);
});
