import { describe, expect, test } from "bun:test";
import { getSingularPatch } from "@pierre/diffs";
import {
  clampRow,
  diffCursorModel,
  fileStep,
  filesWithHits,
  hunkStep,
  rowAt,
  rowLine,
  screenRow,
  scrollTarget,
  searchHits,
  stepRows,
  wordStep,
} from "./diffCursor";

/*
 * The adapter from Pierre's parsed hunks to the review's cursor rows (plan:
 * review into the inspector, phase 3), on patches as git writes them.
 */

const source = (path: string, patch: string, key = `unstaged:${path}`) => ({
  key,
  path,
  diff: getSingularPatch(patch),
});

const changed = source(
  "a.ts",
  [
    "diff --git a/a.ts b/a.ts",
    "--- a/a.ts",
    "+++ b/a.ts",
    "@@ -1,4 +1,5 @@",
    " top",
    "-old 1",
    "-old 2",
    "+new 1",
    "+new 2",
    "+new 3",
    " bottom",
    "@@ -20,2 +21,3 @@",
    " twenty",
    "+added",
    " twenty one",
    "",
  ].join("\n"),
);
const created = source(
  "new.ts",
  [
    "diff --git a/new.ts b/new.ts",
    "new file mode 100644",
    "--- /dev/null",
    "+++ b/new.ts",
    "@@ -0,0 +1,2 @@",
    "+first",
    "+second",
    "",
  ].join("\n"),
);
const deleted = source(
  "gone.ts",
  [
    "diff --git a/gone.ts b/gone.ts",
    "deleted file mode 100644",
    "--- a/gone.ts",
    "+++ /dev/null",
    "@@ -1,2 +0,0 @@",
    "-was here",
    "-and here",
    "",
  ].join("\n"),
);
const renamed = source(
  "src/moved.ts",
  [
    "diff --git a/lib/moved.ts b/src/moved.ts",
    "similarity index 90%",
    "rename from lib/moved.ts",
    "rename to src/moved.ts",
    "--- a/lib/moved.ts",
    "+++ b/src/moved.ts",
    "@@ -3,2 +3,2 @@",
    " kept",
    "-before",
    "+after",
    "",
  ].join("\n"),
);
const binary = source(
  "logo.png",
  [
    "diff --git a/logo.png b/logo.png",
    "index 1111111..2222222 100644",
    "Binary files a/logo.png and b/logo.png differ",
    "",
  ].join("\n"),
);

describe("the cursor's rows from Pierre's hunks", () => {
  test("unified: a change's removed lines, then its added ones, with both numbers", () => {
    const model = diffCursorModel([changed]);
    expect(
      model.rows.map((row) => [row.kind, row.old, row.new, row.text, row.hunk]),
    ).toEqual([
      [" ", 1, 1, "top", 0],
      ["-", 2, null, "old 1", 0],
      ["-", 3, null, "old 2", 0],
      ["+", null, 2, "new 1", 0],
      ["+", null, 3, "new 2", 0],
      ["+", null, 4, "new 3", 0],
      [" ", 4, 5, "bottom", 0],
      [" ", 20, 21, "twenty", 1],
      ["+", null, 22, "added", 1],
      [" ", 21, 23, "twenty one", 1],
    ]);
    expect(model.files).toEqual([
      { key: "unstaged:a.ts", path: "a.ts", start: 0, end: 10 },
    ]);
  });

  test("split: removed and added lines face each other, an unchanged line across", () => {
    const model = diffCursorModel([changed]);
    const text = (at: number | null) =>
      at === null ? null : model.rows[at]!.text;
    expect(
      model.splitLines.map((line) => [text(line.left), text(line.right)]),
    ).toEqual([
      ["top", "top"],
      ["old 1", "new 1"],
      ["old 2", "new 2"],
      [null, "new 3"],
      ["bottom", "bottom"],
      ["twenty", "twenty"],
      [null, "added"],
      ["twenty one", "twenty one"],
    ]);
    // j / k on a side: the left side skips the added line with no partner.
    expect(text(stepRows(model, 1, 1, "left"))).toBe("old 2");
    expect(text(stepRows(model, 2, 1, "left"))).toBe("new 3");
    expect(text(stepRows(model, 3, 1, "right"))).toBe("new 2");
  });

  test("new, deleted, renamed and binary files", () => {
    const model = diffCursorModel([created, deleted, renamed, binary]);
    expect(
      model.rows.map((row) => [row.path, row.kind, row.old, row.new, row.text]),
    ).toEqual([
      ["new.ts", "+", null, 1, "first"],
      ["new.ts", "+", null, 2, "second"],
      ["gone.ts", "-", 1, null, "was here"],
      ["gone.ts", "-", 2, null, "and here"],
      ["src/moved.ts", " ", 3, 3, "kept"],
      ["src/moved.ts", "-", 4, null, "before"],
      ["src/moved.ts", "+", null, 4, "after"],
    ]);
    // A binary file has no rows: `]` goes past it.
    expect(
      model.files.map((file) => [file.path, file.end - file.start]),
    ).toEqual([
      ["new.ts", 2],
      ["gone.ts", 2],
      ["src/moved.ts", 3],
      ["logo.png", 0],
    ]);
    expect(fileStep(model, 4, 1)).toBeNull();
    expect(fileStep(model, 0, 2)).toBe(4);
    // Each path's new lines, for suggestions.
    expect([...model.newLinesByPath.get("src/moved.ts")!]).toEqual([
      [3, "kept"],
      [4, "after"],
    ]);
    expect(model.newLinesByPath.get("gone.ts")!.size).toBe(0);
  });

  test("where Pierre draws a row, and the row of a line Pierre drew", () => {
    const model = diffCursorModel([changed]);
    expect(rowLine(model.rows[1]!)).toEqual({ line: 2, side: "deletions" });
    expect(rowLine(model.rows[3]!)).toEqual({ line: 2, side: "additions" });
    expect(rowLine(model.rows[0]!, "left")).toEqual({
      line: 1,
      side: "deletions",
    });
    expect(rowLine(model.rows[6]!, "right")).toEqual({
      line: 5,
      side: "additions",
    });
    expect(rowAt(model, "unstaged:a.ts", 2, "deletions")).toBe(1);
    expect(rowAt(model, "unstaged:a.ts", 2, "additions")).toBe(3);
    expect(rowAt(model, "unstaged:a.ts", 5, "additions")).toBe(6);
    expect(rowAt(model, "unstaged:a.ts", 4, "deletions")).toBe(6);
    expect(rowAt(model, "elsewhere", 1, "additions")).toBe(-1);
  });

  test("hunks, files, a Visual selection's file, words and the screen", () => {
    const model = diffCursorModel([changed, created]);
    expect(hunkStep(model, 0, 1, 1)).toBe(7);
    expect(hunkStep(model, 0, 1, 2)).toBe(10);
    expect(hunkStep(model, 10, -1, 1)).toBe(7);
    expect(hunkStep(model, 8, -1, 1)).toBe(7);
    expect(fileStep(model, 3, 1)).toBe(10);
    expect(fileStep(model, 10, -1)).toBe(0);
    // A selection that began in a.ts stays there.
    expect(clampRow(model, 11, 2)).toBe(9);
    expect(clampRow(model, 11, null)).toBe(11);
    expect(clampRow(model, -4, null)).toBe(0);
    expect(wordStep(model, { at: 0, col: 0 }, "w", 2)).toEqual({
      at: 1,
      col: 4,
    });
    expect(screenRow([4, 5, 6, 7, 8], "H", 2)).toBe(5);
    expect(screenRow([4, 5, 6, 7, 8], "L", 1)).toBe(8);
    expect(screenRow([4, 5, 6, 7, 8], "M", 1)).toBe(6);
    expect(screenRow([], "M", 1)).toBeNull();
  });

  test("search: lines that match, smart case, and files by their path", () => {
    const model = diffCursorModel([changed, created, renamed]);
    expect(searchHits(model, "new", false).map((hit) => hit.at)).toEqual([
      3, 4, 5, 10,
    ]);
    expect(searchHits(model, "New", false)).toEqual([]);
    // A path that matches: a hit at its first line.
    expect(searchHits(model, "moved", false)).toEqual([
      { at: 12, start: 0, end: 0 },
    ]);
    expect(filesWithHits(model, searchHits(model, "e", false))).toEqual([
      "a.ts",
      "new.ts",
      "src/moved.ts",
    ]);
  });
});

describe("where the screen goes for the cursor", () => {
  const row = (top: number) => ({ top, height: 20 });
  const view = (top: number) => ({ top, height: 400 });

  test("a row is put below the header stuck atop the screen, never under it", () => {
    // Under a 40 px header at the screen's top: brought below it.
    expect(scrollTarget(row(1010), view(1000), "nearest", 40)).toBe(970);
    // Below the header already: the screen stays.
    expect(scrollTarget(row(1040), view(1000), "nearest", 40)).toBeNull();
    // zt: right below the header; zz: centred in what it leaves.
    expect(scrollTarget(row(2000), view(1000), "start", 40)).toBe(1960);
    expect(scrollTarget(row(2000), view(1000), "center", 40)).toBe(1790);
    // Never above the top.
    expect(scrollTarget(row(30), view(500), "start", 40)).toBe(0);
  });

  test("a search's hit keeps lines to spare, and is centred from afar", () => {
    // Just under the header: below it, 60 px to spare.
    expect(scrollTarget(row(1030), view(1000), "reveal", 40, 60)).toBe(930);
    // Near the bottom edge: up so 60 px stay below it.
    expect(scrollTarget(row(1350), view(1000), "reveal", 40, 60)).toBe(1030);
    // In the clear: the screen stays.
    expect(scrollTarget(row(1200), view(1000), "reveal", 40, 60)).toBeNull();
    // Far away (more than half a screen): centred below the header.
    expect(scrollTarget(row(5000), view(1000), "reveal", 40, 60)).toBe(4790);
  });
});
