import { describe, expect, test } from "bun:test";
import {
  clearDiffContentResourceState,
  diffSectionCollapsed,
  expandDiffEntryOnActivate,
  MAX_NEARBY_DIFF_FILES,
  nearestDiffEntryKeys,
  readDiffCollapseState,
  visibleDiffEntryKey,
  writeDiffCollapseState,
} from "./diffContentState";

/*
 * Changes' per-view state (upstream): which file sections are folded, which
 * file is on screen and which ones load next. Characterization tests of
 * today's behavior (plan: review into the inspector, phase A).
 */

describe("diff collapse state per resource", () => {
  test("a resource keeps its folds until cleared; the eight latest resources are kept", () => {
    const folds = (key: string) => new Map([[`unstaged:${key}.ts`, true]]);
    for (let index = 0; index < 9; index += 1)
      writeDiffCollapseState(`resource-${index}`, folds(String(index)));
    // The first written is gone, the eight after it kept.
    expect(readDiffCollapseState("resource-0")).toBeUndefined();
    for (let index = 1; index < 9; index += 1)
      expect(readDiffCollapseState(`resource-${index}`)).toEqual(
        folds(String(index)),
      );
    // Writing again makes a resource the latest: the oldest goes instead.
    writeDiffCollapseState("resource-1", folds("again"));
    writeDiffCollapseState("resource-9", folds("9"));
    expect(readDiffCollapseState("resource-1")).toEqual(folds("again"));
    expect(readDiffCollapseState("resource-2")).toBeUndefined();
    clearDiffContentResourceState("resource-1");
    expect(readDiffCollapseState("resource-1")).toBeUndefined();
    for (let index = 0; index < 10; index += 1)
      clearDiffContentResourceState(`resource-${index}`);
  });
});

describe("diffSectionCollapsed", () => {
  const base = {
    continuous: true,
    embedded: false,
    active: false,
    manual: undefined,
    autoCollapsed: false,
  };

  test("an embedded diff never folds a section", () => {
    expect(
      diffSectionCollapsed({
        ...base,
        embedded: true,
        continuous: false,
        manual: true,
        autoCollapsed: true,
      }),
    ).toBe(false);
  });

  test("click-to-load (not continuous) folds every section but the active one", () => {
    expect(diffSectionCollapsed({ ...base, continuous: false })).toBe(true);
    expect(
      diffSectionCollapsed({ ...base, continuous: false, active: true }),
    ).toBe(false);
    // The active one still follows a manual fold.
    expect(
      diffSectionCollapsed({
        ...base,
        continuous: false,
        active: true,
        manual: true,
      }),
    ).toBe(true);
  });

  test("a manual fold or unfold wins over the automatic one", () => {
    expect(diffSectionCollapsed({ ...base, autoCollapsed: true })).toBe(true);
    expect(
      diffSectionCollapsed({ ...base, autoCollapsed: true, manual: false }),
    ).toBe(false);
    expect(diffSectionCollapsed({ ...base, manual: true })).toBe(true);
    expect(diffSectionCollapsed(base)).toBe(false);
  });
});

describe("expandDiffEntryOnActivate", () => {
  test("an automatic fold stays when the file is only shown, and yields to an explicit request", () => {
    const current = new Map([["unstaged:b.ts", true]]);
    expect(
      expandDiffEntryOnActivate(current, "unstaged:big.ts", true, false),
    ).toBe(current);
    expect(expandDiffEntryOnActivate(undefined, "x", true, false)).toEqual(
      new Map(),
    );
    const explicit = expandDiffEntryOnActivate(
      current,
      "unstaged:big.ts",
      true,
      true,
    );
    expect(explicit.get("unstaged:big.ts")).toBe(false);
    expect(explicit.get("unstaged:b.ts")).toBe(true);
    // A manual fold of the file itself is undone by selecting it.
    expect(
      expandDiffEntryOnActivate(current, "unstaged:b.ts").get("unstaged:b.ts"),
    ).toBe(false);
  });
});

describe("visible and nearby file sections", () => {
  const sections = [
    { key: "a", top: 0, bottom: 100 },
    { key: "b", top: 100, bottom: 300 },
    { key: "c", top: 300, bottom: 350 },
    { key: "d", top: 350, bottom: 900 },
  ];

  test("the visible file is the first one reaching into the viewport, past a one-pixel edge", () => {
    expect(visibleDiffEntryKey(sections, { top: 0, bottom: 200 })).toBe("a");
    // A section ending exactly one pixel under the top is not on screen.
    expect(visibleDiffEntryKey(sections, { top: 99, bottom: 200 })).toBe("b");
    expect(visibleDiffEntryKey(sections, { top: 98, bottom: 200 })).toBe("a");
    expect(visibleDiffEntryKey(sections, { top: 320, bottom: 400 })).toBe("c");
    expect(
      visibleDiffEntryKey([...sections].reverse(), { top: 0, bottom: 900 }),
    ).toBe("a");
    expect(
      visibleDiffEntryKey(sections, { top: 1000, bottom: 1200 }),
    ).toBeNull();
    expect(visibleDiffEntryKey([], { top: 0, bottom: 100 })).toBeNull();
  });

  test("nearby files are the closest to the viewport, ties in page order, at most twelve", () => {
    expect(nearestDiffEntryKeys(sections, { top: 310, bottom: 340 })).toEqual([
      "c",
      "b",
      "d",
      "a",
    ]);
    const many = Array.from({ length: 20 }, (_, index) => ({
      key: `f${index}`,
      top: index * 100,
      bottom: index * 100 + 100,
    }));
    const nearby = nearestDiffEntryKeys(many, { top: 1000, bottom: 1100 });
    expect(nearby).toHaveLength(MAX_NEARBY_DIFF_FILES);
    expect(MAX_NEARBY_DIFF_FILES).toBe(12);
    // On screen first, then by distance, an earlier file before a later one
    // at the same distance.
    expect(nearby.slice(0, 5)).toEqual(["f9", "f10", "f11", "f8", "f12"]);
  });
});
