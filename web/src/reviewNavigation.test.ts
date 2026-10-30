import { expect, test } from "bun:test";
import {
  splitStep,
  commandCompletions,
  EMPTY_KEY_STATE,
  feedKey,
  findFile,
  findMatches,
  firstNonBlank,
  nextMatch,
  parseReviewCommand,
  reviewedIndexes,
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
