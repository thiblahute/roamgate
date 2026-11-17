import { describe, expect, test } from "bun:test";
import { getSingularPatch } from "@pierre/diffs";
import {
  CHANGES_REVIEW_VIEW,
  changesReviewed,
  chunkProgress,
  chunkStageKey,
  chunkStages,
  reviewedLayout,
} from "./changesReviewed";
import { diffCursorModel } from "./diffCursor";
import { reviewedFileOf } from "./reviewFiles";
import { hunkKey } from "./reviewNavigation";
import { fileToggleChanges, hunkToggle, pickHunks } from "./reviewToggle";

/*
 * Reviewed chunks and files on Changes' rows (plan: review into the
 * inspector, phase 5): chunks of a path counted over its staged and
 * unstaged entries, marks surviving staging, the staged markers.
 */

const patch = (path: string, ...hunks: string[]) =>
  [`diff --git a/${path} b/${path}`, `--- a/${path}`, `+++ b/${path}`, ...hunks]
    .join("\n")
    .concat("\n");
const two = patch(
  "a.ts",
  "@@ -1,3 +1,3 @@\n one\n-two\n+deux\n three",
  "@@ -20,3 +20,3 @@\n x\n-y\n+z\n w",
);
const staged = patch("a.ts", "@@ -1,3 +1,3 @@\n one\n-two\n+deux\n three");
const unstaged = patch("a.ts", "@@ -20,3 +20,3 @@\n x\n-y\n+z\n w");
const model = (...entries: { key: string; path: string; diff: string }[]) =>
  diffCursorModel(
    entries.map((entry) => ({
      key: entry.key,
      path: entry.path,
      diff: getSingularPatch(entry.diff),
    })),
  );

describe("reviewedLayout", () => {
  test("a path's chunks are counted over its entries, one id each", () => {
    const layout = reviewedLayout(
      model(
        { key: "staged:a.ts", path: "a.ts", diff: staged },
        { key: "unstaged:a.ts", path: "a.ts", diff: unstaged },
      ),
    );
    expect(layout.files).toHaveLength(1);
    expect(layout.files[0]!.hunks).toHaveLength(2);
    expect(layout.chunks[0]!.map((chunk) => chunk.key)).toEqual([
      "staged:a.ts",
      "unstaged:a.ts",
    ]);
    expect(layout.units.every((unit) => unit?.file === 0)).toBe(true);
    expect(new Set(layout.units.map((unit) => unit?.hunk))).toEqual(
      new Set([0, 1]),
    );
  });

  test("a path's fingerprint and chunk ids stay those marks were stored with", () => {
    const layout = reviewedLayout(
      model({ key: "unstaged:a.ts", path: "a.ts", diff: two }),
    );
    const pinned = {
      path: "a.ts",
      fingerprint: "2:1l8k2hd",
      hunks: ["h2.t3yrgh", "h2.12hng3o"],
    };
    expect(layout.files).toEqual([pinned]);
    // The Files preview's tick reads the same file the same way.
    expect(reviewedFileOf("a.ts", two)).toEqual(pinned);
  });

  test("a chunk keeps its mark when it is staged", () => {
    const before = reviewedLayout(
      model({ key: "unstaged:a.ts", path: "a.ts", diff: two }),
    );
    const marks = hunkToggle(
      pickHunks(before.units, 1, null, (at) => before.units[at] ?? null),
      before.files,
      [new Set()],
      CHANGES_REVIEW_VIEW,
      {},
    ).changes;
    const after = reviewedLayout(
      model(
        { key: "staged:a.ts", path: "a.ts", diff: staged },
        { key: "unstaged:a.ts", path: "a.ts", diff: unstaged },
      ),
    );
    const state = changesReviewed(after, marks as Record<string, string>);
    expect([...state.hunks[0]!]).toEqual([0]);
    expect(chunkProgress(after, state, "a.ts")).toBe("1/2");
  });

  test("marking every chunk marks the file; a changed chunk loses its mark", () => {
    const layout = reviewedLayout(
      model({ key: "unstaged:a.ts", path: "a.ts", diff: two }),
    );
    const marks = fileToggleChanges(
      layout.files[0]!,
      true,
      CHANGES_REVIEW_VIEW,
      {},
    ) as Record<string, string>;
    expect(changesReviewed(layout, marks).files.has(0)).toBe(true);
    const edited = reviewedLayout(
      model({
        key: "unstaged:a.ts",
        path: "a.ts",
        diff: patch(
          "a.ts",
          "@@ -1,3 +1,3 @@\n one\n-two\n+deux!\n three",
          "@@ -20,3 +20,3 @@\n x\n-y\n+z\n w",
        ),
      }),
    );
    const state = changesReviewed(edited, marks);
    expect([...state.hunks[0]!]).toEqual([1]);
    expect(state.files.has(0)).toBe(false);
    expect(
      hunkKey(CHANGES_REVIEW_VIEW, "a.ts", edited.files[0]!.hunks[1]!) in marks,
    ).toBe(true);
  });
});

describe("chunkStages", () => {
  test("each chunk says what the index holds of it", () => {
    const layout = reviewedLayout(
      model(
        { key: "staged:a.ts", path: "a.ts", diff: staged },
        { key: "unstaged:a.ts", path: "a.ts", diff: unstaged },
        {
          key: "unstaged:b.ts",
          path: "b.ts",
          diff: patch("b.ts", "@@ -1,2 +1,2 @@\n p\n-q\n+r"),
        },
      ),
    );
    const stages = chunkStages(layout);
    expect(stages.get(chunkStageKey("staged:a.ts", 0))).toBe("staged");
    expect(stages.get(chunkStageKey("unstaged:a.ts", 0))).toBe("unstaged");
    expect(stages.get(chunkStageKey("unstaged:b.ts", 0))).toBe("unstaged");
  });

  test("the same changed lines in both entries: partly staged", () => {
    const same = patch("a.ts", "@@ -1,3 +1,3 @@\n one\n-two\n+deux\n three");
    const stages = chunkStages(
      reviewedLayout(
        model(
          { key: "staged:a.ts", path: "a.ts", diff: same },
          { key: "unstaged:a.ts", path: "a.ts", diff: same },
        ),
      ),
    );
    expect(stages.get(chunkStageKey("unstaged:a.ts", 0))).toBe("partly");
  });
});
