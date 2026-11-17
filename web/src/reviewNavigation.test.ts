import { expect, test } from "bun:test";
import {
  splitStep,
  commandCompletions,
  latestComment,
  EMPTY_KEY_STATE,
  feedKey,
  findFile,
  findMatches,
  firstNonBlank,
  type HunkUnit,
  hunkIds,
  hunkKey,
  nextMatch,
  nextUnreviewedHunk,
  parseReviewCommand,
  type ReviewedFile,
  reviewedChanges,
  reviewedIndexes,
  reviewedState,
  wordAt,
  wordMotion,
} from "./reviewNavigation";

const lines = ["  if (a->b != c) {", "", "  }", "  return x_y;"];

test("words skip symbols and blank lines", () => {
  expect(wordAt(lines[0]!, 0)).toEqual({ start: 2, end: 4, word: "if" });
  expect(wordAt(lines[0]!, 5)).toEqual({ start: 6, end: 7, word: "a" });
  expect(wordMotion(lines, { at: 0, col: 2 }, "w")).toEqual({ at: 0, col: 6 });
  expect(wordMotion(lines, { at: 0, col: 14 }, "w")).toEqual({ at: 3, col: 2 });
  expect(wordMotion(lines, { at: 3, col: 2 }, "b")).toEqual({ at: 0, col: 14 });
  expect(wordMotion(lines, { at: 3, col: 2 }, "e")).toEqual({ at: 3, col: 7 });
  expect(wordMotion(lines, { at: 0, col: 2 }, "w", true)).toEqual({
    at: 0,
    col: 5,
  });
  expect(firstNonBlank(lines[3]!)).toBe(2);
});

test("search is smart-case, whole-word with *, and wraps", () => {
  const text = ["Foo foo", "food", "FOO"];
  expect(findMatches(text, "foo", false)).toHaveLength(4);
  expect(findMatches(text, "Foo", false)).toEqual([
    { at: 0, start: 0, end: 3 },
  ]);
  const whole = findMatches(text, "foo", true);
  expect(whole.map((m) => m.at)).toEqual([0, 0, 2]);
  expect(nextMatch(whole, { at: 2, col: 0 }, 1)).toEqual(whole[0]!);
  expect(nextMatch(whole, { at: 0, col: 0 }, -1)).toEqual(whole[2]!);
  expect(findMatches(text, "a.b", false)).toEqual([]);
});

test("counts and two-key sequences", () => {
  let state = EMPTY_KEY_STATE;
  const feed = (key: string) => {
    const result = feedKey(state, key);
    state = result.state;
    return result;
  };
  expect(feed("1").type).toBe("wait");
  expect(feed("2").type).toBe("wait");
  expect(feed("j")).toMatchObject({ type: "command", key: "j", count: 12 });
  expect(feed("g").type).toBe("wait");
  expect(feed("g")).toMatchObject({ key: "gg", count: null });
  feed("g");
  expect(feed("m")).toMatchObject({ key: "gm" });
  // Shift on its own keeps the count and the pending key.
  feed("1");
  feed("2");
  expect(feed("Shift").type).toBe("wait");
  expect(feed("G")).toMatchObject({ key: "G", count: 12 });
  feed("z");
  feed("Shift");
  expect(feed("O")).toMatchObject({ key: "zO" });
  expect(feed("z").type).toBe("wait");
  expect(feed("O")).toMatchObject({ key: "zO" });
  expect(feed("d").type).toBe("wait");
  expect(feed("x")).toMatchObject({ key: "x" });
  expect(feed("0")).toMatchObject({ key: "0" });
});

test("command line", () => {
  expect(parseReviewCommand(":42")).toEqual({ type: "line", line: 42 });
  expect(parseReviewCommand("wq")).toEqual({ type: "close" });
  expect(parseReviewCommand(":switch")).toEqual({ type: "switchMode" });
  // :gitlab still opens the merge request.
  expect(parseReviewCommand("gitlab")).toEqual({ type: "open" });
  expect(parseReviewCommand(":conversations")).toEqual({ type: "threads" });
  expect(parseReviewCommand("conv")).toEqual({ type: "threads" });
  expect(parseReviewCommand(":overall")).toEqual({ type: "overall" });
  expect(parseReviewCommand("w")).toEqual({ type: "save" });
  expect(parseReviewCommand("unified")).toEqual({ type: "split" });
  expect(parseReviewCommand("only")).toEqual({ type: "diffOnly" });
  expect(parseReviewCommand("nope")).toEqual({ type: "unknown", text: "nope" });
});

test("commits: gc picks one, :commit goes by number or by name", () => {
  let state = EMPTY_KEY_STATE;
  expect(feedKey(state, "g").type).toBe("wait");
  state = feedKey(state, "g").state;
  expect(feedKey(state, "c")).toMatchObject({ type: "command", key: "gc" });
  expect(feedKey(EMPTY_KEY_STATE, "<")).toMatchObject({ key: "<" });
  expect(feedKey(EMPTY_KEY_STATE, ">")).toMatchObject({ key: ">" });
  expect(parseReviewCommand(":commit 2")).toEqual({ type: "commit", index: 1 });
  expect(parseReviewCommand(":commit")).toEqual({
    type: "commit",
    index: null,
  });
  expect(parseReviewCommand(":all")).toEqual({ type: "commit", index: null });
  expect(parseReviewCommand(":commit fix the parser")).toEqual({
    type: "commits",
    query: "fix the parser",
  });
  expect(parseReviewCommand(":commits")).toEqual({
    type: "commits",
    query: "",
  });
  expect(commandCompletions("commi").map(([name]) => name)).toEqual([
    "commit",
    "commits",
  ]);
});

test("search finds files by their path, after the current one", () => {
  const paths = [
    null,
    "meson.build",
    "video/ocio/tests/ociocolor_rgba_f16_hdr.validatetest",
    "video/ocio/tests/glociocolor_rgba_f16_hdr.validatetest",
  ];
  expect(findFile(paths, "rgba_f16_hdr.validatetest", 0)).toBe(2);
  expect(findFile(paths, "rgba_f16_hdr.validatetest", 2)).toBe(3);
  expect(findFile(paths, "rgba_f16_hdr.validatetest", 3)).toBe(2);
  expect(findFile(paths, "rgba_f16_hdr", 2, -1)).toBe(3);
  expect(findFile(paths, "Meson", 0)).toBe(-1);
  expect(findFile(paths, "meson", 0)).toBe(1);
  expect(findFile(paths, "nothing", 0)).toBe(-1);
});

test("a reviewed file stays reviewed while its diff is the same", () => {
  const paths = ["Cargo.lock", "meson.build", "src/a.rs"];
  const marks = {
    "old1:Cargo.lock": "16:abc",
    "old1:meson.build": "1:x",
    "old2:src/a.rs": "1:y",
  };
  // A rebased commit: the same diffs, but meson.build changed.
  expect([
    ...reviewedIndexes(paths, ["16:abc", "1:z", "1:y"], "new", marks),
  ]).toEqual([0, 2]);
  // Unmarked in this view: not marked again from another one.
  expect([
    ...reviewedIndexes(paths, ["16:abc", "1:z", "1:y"], "new", {
      ...marks,
      "new:Cargo.lock": "",
    }),
  ]).toEqual([2]);
  // Marked here with an older diff: no longer reviewed.
  expect([
    ...reviewedIndexes(paths, ["16:abc", "1:z", "1:y"], "new", {
      "new:meson.build": "1:x",
    }),
  ]).toEqual([]);
});

test("side by side, j and k go line by line on their side", () => {
  // 0 context, then -1 -2 +3 paired as (1, 3) and (2, null), then 4 context.
  const lines = [
    { left: 0, right: 0 },
    { left: 1, right: 3 },
    { left: 2, right: null },
    { left: 4, right: 4 },
  ];
  expect(splitStep(lines, 0, 1, "right")).toBe(3);
  expect(splitStep(lines, 3, 1, "right")).toBe(2);
  expect(splitStep(lines, 1, 1, "left")).toBe(2);
  expect(splitStep(lines, 2, 1, "left")).toBe(4);
  expect(splitStep(lines, 4, -2, "right")).toBe(3);
  expect(splitStep(lines, 4, -9, "left")).toBe(0);
  expect(splitStep(lines, 7, 1, "left")).toBe(null);
});

test("gn / gN / gH and :unresolved go through the unresolved threads", () => {
  expect(parseReviewCommand(":unresolved")).toEqual({ type: "unresolved" });
  expect(parseReviewCommand("openonly")).toEqual({ type: "unresolved" });
  for (const sequence of ["gn", "gN", "gH"]) {
    const first = feedKey(EMPTY_KEY_STATE, "g");
    expect(first.type).toBe("wait");
    const second = feedKey(first.state, sequence[1]!);
    expect(second).toMatchObject({ type: "command", key: sequence });
  }
});

const hunk = (lines: string[]) => ({
  lines: lines.map((line) => ({ kind: line[0]!, text: line.slice(1) })),
});

test("a hunk is known by its path and changed lines, not its place", () => {
  const before = hunkIds("a.ts", [
    hunk([" ctx", "-old", "+new", " ctx"]),
    hunk([" x", "+added"]),
    hunk([" y", "+added"]),
  ]);
  // Rebased: other context, the first hunk changed, the others moved.
  const after = hunkIds("a.ts", [
    hunk([" other", "-old", "+newer"]),
    hunk([" moved", "+added"]),
    hunk([" again", "+added"]),
  ]);
  expect(after[0]).not.toBe(before[0]);
  expect(after[1]).toBe(before[1]);
  // The same lines twice in a file: told apart by their order.
  expect(before[2]).toBe(`${before[1]}~2`);
  expect(after[2]).toBe(before[2]);
  // The same lines in another file are another hunk.
  expect(hunkIds("b.ts", [hunk(["+added"])])[0]).not.toBe(before[1]);
  expect(hunkKey("all", "a.ts", "h1.x")).toBe("all:a.ts\nh1.x");
});

test("hunk ids stay the ones reviewed marks were stored with", () => {
  expect(
    hunkIds("a.ts", [
      hunk([" ctx", "-old", "+new", " ctx"]),
      hunk([" x", "+added"]),
      hunk([" y", "+added"]),
      hunk([" only context"]),
      hunk([]),
    ]),
  ).toEqual([
    "h2.o22bei",
    "h1.67bazw",
    "h1.67bazw~2",
    "c1.8ohigm",
    "c0.45f5j9",
  ]);
});

test("a hunk with no changed line, a commit's message, is known by its lines", () => {
  const message = (text: string) =>
    hunkIds(":commit-message", [hunk([` ${text}`])])[0]!;
  expect(message("First")).not.toBe(message("Second"));
  expect(message("First")).toBe(message("First"));
  expect(message("First")).toMatch(/^c1\./);
});

test("a commit's message marked reviewed in its commit is that commit's only, old marks too", () => {
  const info = (text: string): ReviewedFile => {
    const own = [hunk([` ${text}`])];
    return {
      path: ":commit-message",
      fingerprint: `1:${text}`,
      hunks: hunkIds(":commit-message", own),
    };
  };
  const first = info("First");
  const second = info("Second");
  // Marked in the second commit's view (its sha).
  const marks = reviewedChanges(
    second,
    new Set([0]),
    "b".repeat(40),
    {},
  ) as Record<string, string>;
  expect(reviewedState([second], "b".repeat(40), marks).files.has(0)).toBe(
    true,
  );
  expect(reviewedState([first], "a".repeat(40), marks).files.has(0)).toBe(
    false,
  );
  // Written by Changes before (view "all", the old shared message id): only
  // the message whose text the file mark holds is reviewed.
  // The old id hashed the path alone: what an empty hunk's hash is.
  const oldId = hunkIds(":commit-message", [{ lines: [] }])[0]!.replace(
    /^c0\./,
    "h0.",
  );
  const legacy = {
    "all::commit-message": second.fingerprint,
    [`all::commit-message\n${oldId}`]: "1",
  };
  expect(reviewedState([second], "b".repeat(40), legacy).files.has(0)).toBe(
    true,
  );
  expect(reviewedState([first], "a".repeat(40), legacy).files.has(0)).toBe(
    false,
  );
});

test("hunks marked reviewed; all of them make the file reviewed", () => {
  const file: ReviewedFile = {
    path: "a.ts",
    fingerprint: "3:f",
    hunks: ["h1", "h2", "h3"],
  };
  const other: ReviewedFile = { path: "b.ts", fingerprint: "1:b", hunks: [] };
  let marks: Record<string, string> = {};
  const apply = (changes: Record<string, string | null>) => {
    const next = { ...marks };
    for (const [key, value] of Object.entries(changes))
      if (value === null) delete next[key];
      else next[key] = value;
    marks = next;
  };
  const state = () => reviewedState([file, other], "all", marks);

  apply(reviewedChanges(file, new Set([0]), "all", marks));
  expect(marks).toEqual({ "all:a.ts\nh1": "1" });
  expect([...state().hunks[0]!]).toEqual([0]);
  expect(state().files.has(0)).toBe(false);

  // The last hunk marked: the file is reviewed, its fingerprint kept.
  apply(reviewedChanges(file, new Set([0, 1, 2]), "all", marks));
  expect(state().files.has(0)).toBe(true);
  expect(marks["all:a.ts"]).toBe("3:f");

  // One unmarked: the file no longer, the others still.
  apply(reviewedChanges(file, new Set([0, 2]), "all", marks));
  expect(state().files.has(0)).toBe(false);
  expect([...state().hunks[0]!]).toEqual([0, 2]);
  expect(marks["all:a.ts"]).toBe("");
  expect(marks["all:a.ts\nh2"]).toBe("");

  // The file unmarked whole: its hunks too.
  apply(reviewedChanges(file, new Set(), "all", marks, false));
  expect(state().hunks[0]!.size).toBe(0);
  expect(state().files.has(0)).toBe(false);
  // A file without hunks is marked whole.
  apply(reviewedChanges(other, new Set(), "all", marks, true));
  expect(state().files.has(1)).toBe(true);
});

test("a file marked whole has its hunks reviewed; a changed hunk is not", () => {
  // Marked before hunks were: every hunk of that diff counts.
  const marks = { "all:a.ts": "2:f" };
  const file = { path: "a.ts", fingerprint: "2:f", hunks: ["h1", "h2"] };
  expect([...reviewedState([file], "all", marks).hunks[0]!]).toEqual([0, 1]);
  // Marked with R, then rebased: one hunk changed, the file's diff with it.
  const marked = reviewedChanges(file, new Set([0, 1]), "all", {}, true);
  expect(marked).toEqual({
    "all:a.ts": "2:f",
    "all:a.ts\nh1": "1",
    "all:a.ts\nh2": "1",
  });
  const rebased = { path: "a.ts", fingerprint: "2:g", hunks: ["h1", "h2b"] };
  const state = reviewedState([rebased], "all", marked as never);
  expect([...state.hunks[0]!]).toEqual([0]);
  expect(state.files.has(0)).toBe(false);
  // The same hunk marked in another view (a commit) counts here too,
  // unless unmarked here.
  const view = { path: "a.ts", fingerprint: "9:z", hunks: ["h2", "h9"] };
  expect([...reviewedState([view], "abc", marked as never).hunks[0]!]).toEqual([
    0,
  ]);
  expect(
    reviewedState([view], "abc", { ...marked, "abc:a.ts\nh2": "" }).hunks[0]!
      .size,
  ).toBe(0);
  // Unmarking a hunk only marked in another view keeps "" here.
  expect(
    reviewedChanges(view, new Set(), "abc", marked as never, false),
  ).toEqual({ "abc:a.ts\nh2": "" });
  // File keys and hunk keys do not mix in reviewedIndexes.
  expect([
    ...reviewedIndexes(["a.ts\nh1"], ["1"], "x", { "y:a.ts\nh1": "1" }),
  ]).toEqual([]);
});

test("gu / gU go to the next hunk not reviewed, wrapping", () => {
  const u = (file: number, hunk: number): HunkUnit => ({ file, hunk });
  // a.ts: hunk 0 (rows 0-1), revealed context (2), hunk 1 (3-4);
  // b.ts: hunk 0 (5-6).
  const units = [u(0, 0), u(0, 0), null, u(0, 1), u(0, 1), u(1, 0), u(1, 0)];
  const done = new Set(["0:1"]);
  const reviewed = (file: number, hunk: number) => done.has(`${file}:${hunk}`);
  expect(nextUnreviewedHunk(units, reviewed, 0, 1)).toBe(5);
  expect(nextUnreviewedHunk(units, reviewed, 6, 1)).toBe(0);
  expect(nextUnreviewedHunk(units, reviewed, 6, -1)).toBe(0);
  expect(nextUnreviewedHunk(units, reviewed, 1, -1)).toBe(5);
  done.add("1:0");
  expect(nextUnreviewedHunk(units, reviewed, 0, 1)).toBeNull();
  expect(nextUnreviewedHunk(units, reviewed, 2, 1)).toBe(0);
});

test("g; is the comment written or rewritten last, in any thread", () => {
  const comment = (id: string, createdAt: string, updatedAt = createdAt) => ({
    id,
    createdAt,
    updatedAt,
  });
  const threads = [
    { id: "a", comments: [comment("a1", "2026-11-10T10:00:00Z")] },
    {
      id: "b",
      comments: [
        comment("b1", "2026-11-10T09:00:00Z", "2026-11-10T11:00:00Z"),
        comment("b2", "2026-11-10T10:30:00Z"),
      ],
    },
  ];
  expect(latestComment(threads)?.comment.id).toBe("b1");
  expect(latestComment(threads)?.thread.id).toBe("b");
  expect(latestComment([])).toBeNull();
});
