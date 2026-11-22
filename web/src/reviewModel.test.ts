import { describe, expect, test } from "bun:test";
import {
  type ReviewDiff,
  type ReviewThread,
  summarizeReview,
} from "../../shared/review";
import {
  commitChoices,
  contextForLine,
  expandDiff,
  gapForLine,
  relocateLine,
  rankReviews,
  reviewAsMarkdown,
  searchCommits,
} from "./reviewModel";

function thread(
  id: string,
  anchor: ReviewThread["anchor"],
  kind: ReviewThread["kind"] = "draft",
): ReviewThread {
  return {
    id,
    sessionId: "s",
    kind,
    anchor,
    resolved: false,
    createdAt: "t",
    updatedAt: "t",
    comments: [
      {
        id: `${id}c`,
        author: "you",
        body: `on ${id}`,
        createdAt: "t",
        updatedAt: "t",
      },
    ],
  };
}

test("the draft review as Markdown skips discussions", () => {
  const markdown = reviewAsMarkdown("Overall fine.", [
    thread("b", { path: "src/a.c", line: 4, side: "new", text: "int w;" }),
    thread("a", { path: "src/a.c", line: 2, side: "old", text: "int y;" }),
    thread("talk", { path: "src/a.c", line: 1 }, "discussion"),
  ]);
  expect(markdown).toBe(
    [
      "Overall fine.",
      "**`src/a.c:2 (old)`**\n```\nint y;\n```\non a",
      "**`src/a.c:4`**\n```\nint w;\n```\non b",
    ].join("\n\n"),
  );
});

describe("context expansion", () => {
  // Two hunks in a 30-line file: lines 5 and 20 changed.
  const file = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`);
  const two: ReviewDiff = {
    truncated: false,
    files: [
      {
        path: "f.c",
        oldPath: "f.c",
        hunks: [
          {
            header: "@@ -4,3 +4,3 @@",
            lines: [
              { kind: " ", old: 4, new: 4, text: "line 4" },
              { kind: "-", old: 5, new: null, text: "old 5" },
              { kind: "+", old: null, new: 5, text: "line 5" },
              { kind: " ", old: 6, new: 6, text: "line 6" },
            ],
          },
          {
            header: "@@ -19,3 +19,3 @@",
            lines: [
              { kind: " ", old: 19, new: 19, text: "line 19" },
              { kind: "-", old: 20, new: null, text: "old 20" },
              { kind: "+", old: null, new: 20, text: "line 20" },
              { kind: " ", old: 21, new: 21, text: "line 21" },
            ],
          },
        ],
      },
    ],
  };

  test("gaps are known from the headers before the file is read", () => {
    const { gaps } = expandDiff(two, new Map());
    expect([...gaps.entries()]).toEqual([
      ["0:0", { file: 0, gap: 0, hidden: 3, canDown: false, canUp: true }],
      ["0:1", { file: 0, gap: 1, hidden: 12, canDown: true, canUp: true }],
      ["0:end", { file: 0, gap: 2, hidden: null, canDown: true, canUp: false }],
    ]);
  });

  test("revealed lines join their hunk with both line numbers", () => {
    const { diff, gaps } = expandDiff(
      two,
      new Map([
        [
          0,
          {
            lines: file,
            gaps: new Map([
              [1, { top: 2, bottom: 1 }],
              [2, { top: 3, bottom: 0 }],
            ]),
          },
        ],
      ]),
    );
    const [first, second] = diff.files[0]!.hunks;
    expect(first!.lines.slice(-2)).toEqual([
      { kind: " ", old: 7, new: 7, text: "line 7", expanded: true },
      { kind: " ", old: 8, new: 8, text: "line 8", expanded: true },
    ]);
    expect(second!.lines[0]).toEqual({
      kind: " ",
      old: 18,
      new: 18,
      text: "line 18",
      expanded: true,
    });
    expect(second!.lines.slice(-3).map((l) => l.new)).toEqual([22, 23, 24]);
    expect(gaps.get("0:1")?.hidden).toBe(9);
    expect(gaps.get("0:end")?.hidden).toBe(6);
  });

  test("a thread between the hunks is shown on its line, three lines around it", () => {
    const f = two.files[0]!;
    const state = { top: 0, bottom: 0 };
    // Line 12: nearer the hunk above, which grows down to line 15.
    const above = contextForLine(f, 12)!;
    expect(above.gap).toBe(1);
    expect(above.change(state)).toEqual({ top: 9, bottom: 0 });
    // Line 16: the hunk below grows up from line 13.
    expect(contextForLine(f, 16)!.change(state)).toEqual({ top: 0, bottom: 6 });
    // Above the first hunk only from below, after the last only from above.
    expect(contextForLine(f, 2)!.change(state)).toEqual({ top: 0, bottom: 3 });
    expect(contextForLine(f, 26)!.change(state)).toEqual({ top: 8, bottom: 0 });
    // In a hunk: nothing to reveal.
    expect(contextForLine(f, 5)).toBeNull();
    // What was revealed already is kept.
    expect(above.change({ top: 12, bottom: 1 })).toEqual({
      top: 12,
      bottom: 1,
    });

    const { diff } = expandDiff(
      two,
      new Map([
        [0, { lines: file, gaps: new Map([[1, above.change(state)]]) }],
      ]),
    );
    const shown = diff.files[0]!.hunks.flatMap((hunk) => hunk.lines)
      .filter((line) => line.new !== null && line.expanded)
      .map((line) => line.new);
    expect(shown).toEqual([7, 8, 9, 10, 11, 12, 13, 14, 15]);
  });

  test("a fully shown gap merges the hunks and drops its header", () => {
    const { diff, gaps } = expandDiff(
      two,
      new Map([
        [
          0,
          {
            lines: file,
            gaps: new Map([[1, { top: 0, bottom: 0, all: true }]]),
          },
        ],
      ]),
    );
    expect(diff.files[0]!.hunks).toHaveLength(1);
    expect(diff.files[0]!.hunks[0]!.lines.map((l) => l.new ?? l.old)).toContain(
      12,
    );
    expect(gaps.has("0:1")).toBe(false);
    expect(gaps.has("0:0")).toBe(true);
  });
});

test("reviews needing you come first", () => {
  const snap = (
    id: string,
    updatedAt: string,
    threads: ReviewThread[] = [],
  ) => ({
    session: {
      id,
      connectionId: "c",
      root: "/r",
      title: id,
      target: { kind: "worktree" as const },
      gitlab: false,
      summary: "",
      agent: {},
      createdAt: updatedAt,
      updatedAt,
    },
    threads,
  });
  const asked = thread("q", {}, "discussion");
  asked.comments.push({ ...asked.comments[0]!, id: "a", author: "Claude" });
  const ranked = rankReviews(
    [
      snap("old", "2026-10-01"),
      snap("recent", "2026-10-10", [thread("d", { path: "a" })]),
      snap("asked", "2026-10-02", [asked]),
      snap("moved", "2026-10-03"),
    ].map(summarizeReview),
    new Set(["moved"]),
  );
  expect(ranked.map((item) => item.snapshot.session.id)).toEqual([
    "moved",
    "asked",
    "recent",
    "old",
  ]);
  expect(ranked[1]!.waiting).toBe(1);
  expect(ranked[2]!.comments).toBe(1);
});

test("older threads find their line again, or give up when unsure", () => {
  const old = ["a", "int x = 0;", "foo();", "bar();", "baz();", "z"];
  const now = [
    "new",
    "lines",
    "a",
    "int x = 0;",
    "foo();",
    "bar();",
    "baz();",
    "z",
  ];
  expect(relocateLine(old, 3, now)).toBe(5);
  // Too short to match safely.
  expect(relocateLine(old, 1, now)).toBeNull();
  // Two equally good candidates with no matching context.
  expect(
    relocateLine(["x", "same();", "y"], 2, [
      "p",
      "same();",
      "q",
      "same();",
      "r",
    ]),
  ).toBeNull();
  expect(relocateLine(old, 3, ["nothing"])).toBeNull();
});

test("the gap holding a line", () => {
  const file = {
    path: "f",
    oldPath: "f",
    hunks: [
      { header: "@@ -4,3 +4,3 @@", lines: [] },
      { header: "@@ -19,3 +19,3 @@", lines: [] },
    ],
  };
  expect(gapForLine(file, 2)).toBe(0);
  expect(gapForLine(file, 5)).toBeNull();
  expect(gapForLine(file, 10)).toBe(1);
  expect(gapForLine(file, 25)).toBe(2);
});

test("the commit picker: all changes first, then commits found by name", () => {
  const commit = (sha: string, subject: string, author = "Thibault") => ({
    sha,
    parent: null,
    author,
    date: "2026-10-30T10:00:00Z",
    subject,
    body: "",
  });
  const commits = [
    commit("a1b2c3d4e5", "Add the review overlay"),
    commit("f00dbabe12", "Fix the parser on Windows", "Ana Lopez"),
    commit("0badc0de99", "Rename the cache"),
  ];
  const choices = commitChoices(commits, true);
  expect(choices.map((choice) => [choice.sha, choice.position])).toEqual([
    [null, 0],
    ["a1b2c3d4e5", 1],
    ["f00dbabe12", 2],
    ["0badc0de99", 3],
  ]);
  // A branch's history has no "all changes"; a commit gone comes last.
  const gone = commit("deadbeef00", "Dropped by a rebase");
  expect(
    commitChoices(commits, false, gone).map((choice) => choice.position),
  ).toEqual([1, 2, 3, 0]);
  expect(commitChoices(commits, false, commits[0]!)).toHaveLength(3);

  const subjects = (query: string) =>
    searchCommits(choices, query).map(
      (choice) => choice.commit?.subject ?? "all",
    );
  expect(subjects("")).toEqual([
    "all",
    "Add the review overlay",
    "Fix the parser on Windows",
    "Rename the cache",
  ]);
  // Words of the subject, any case, in any order.
  expect(subjects("PARSER fix")).toEqual(["Fix the parser on Windows"]);
  // A sha prefix, or the commit's number.
  expect(subjects("f00d")).toEqual(["Fix the parser on Windows"]);
  expect(subjects("3")).toEqual(["Rename the cache"]);
  // A word's start before its middle, then letters in order.
  expect(subjects("re")).toEqual([
    "Add the review overlay",
    "Rename the cache",
    "Fix the parser on Windows",
  ]);
  expect(subjects("rvwovl")).toEqual(["Add the review overlay"]);
  expect(subjects("all")).toEqual(["all"]);
  // The author too, accents ignored.
  expect(subjects("lópez")).toEqual(["Fix the parser on Windows"]);
  expect(subjects("zzz")).toEqual([]);
});
