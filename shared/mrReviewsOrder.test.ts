import { describe, expect, test } from "bun:test";
import {
  applyMrOrderOp,
  flattenMrSections,
  type MrOrderSections,
  orderMrEntries,
  rebaseMrOrder,
  storedMrOrder,
} from "./mrReviewsOrder";

const sections = (): MrOrderSections => ({
  pinned: ["p1"],
  mine: ["m1", "m2", "m3"],
  suggested: ["s1", "s2", "s3", "s4"],
});

describe("order operations", () => {
  test("top and bottom act within each request's own section", () => {
    const top = applyMrOrderOp(sections(), {
      op: "top",
      keys: ["s3", "m3", "s4"],
    });
    expect(top.sections).toEqual({
      pinned: ["p1"],
      mine: ["m3", "m1", "m2"],
      suggested: ["s3", "s4", "s1", "s2"],
    });
    expect(top.moved.sort()).toEqual(["m3", "s3", "s4"]);
    const bottom = applyMrOrderOp(sections(), { op: "bottom", keys: ["m1"] });
    expect(bottom.sections.mine).toEqual(["m2", "m3", "m1"]);
  });

  test("before and after place beside the target; other sections are reported, not moved", () => {
    const out = applyMrOrderOp(sections(), {
      op: "after",
      keys: ["s4", "m1", "s1"],
      target: "s2",
    });
    expect(out.sections.suggested).toEqual(["s2", "s4", "s1", "s3"]);
    expect(out.sections.mine).toEqual(["m1", "m2", "m3"]);
    expect(out.elsewhere).toEqual(["m1"]);
    const before = applyMrOrderOp(sections(), {
      op: "before",
      keys: ["s3"],
      target: "s1",
    });
    expect(before.sections.suggested).toEqual(["s3", "s1", "s2", "s4"]);
  });

  test("an explicit list comes first in its order; the rest follow unchanged", () => {
    const out = applyMrOrderOp(sections(), {
      op: "arrange",
      keys: ["s4", "s2", "m2"],
    });
    expect(out.sections.suggested).toEqual(["s4", "s2", "s1", "s3"]);
    expect(out.sections.mine).toEqual(["m2", "m1", "m3"]);
  });

  test("unknown keys are reported, never silently dropped", () => {
    const out = applyMrOrderOp(sections(), {
      op: "top",
      keys: ["nope", "s2", "s2"],
    });
    expect(out.unknown).toEqual(["nope"]);
    expect(out.sections.suggested[0]).toBe("s2");
    const noTarget = applyMrOrderOp(sections(), {
      op: "before",
      keys: ["s2"],
      target: "ghost",
    });
    expect(noTarget.unknown).toEqual(["ghost"]);
    expect(noTarget.moved).toEqual([]);
    expect(noTarget.sections).toEqual(sections());
  });

  test("moving what is already there changes nothing", () => {
    const out = applyMrOrderOp(sections(), { op: "top", keys: ["s1"] });
    expect(out.moved).toEqual([]);
  });

  test("the stored order keeps the keys of removed requests after the shown ones", () => {
    const shown = flattenMrSections(sections());
    expect(storedMrOrder(shown, ["gone", "s2"]).slice(-1)).toEqual(["gone"]);
    expect(
      storedMrOrder(
        ["a"],
        new Array(600).fill(0).map((_, i) => `k${i}`),
      ),
    ).toHaveLength(500);
  });

  test("entries not in the order come first, then the order", () => {
    const rows = ["a", "b", "c", "d"].map((key) => ({ key }));
    expect(orderMrEntries(rows, ["c", "a"]).map((row) => row.key)).toEqual([
      "b",
      "d",
      "c",
      "a",
    ]);
  });
});

describe("a stale list is rebased", () => {
  test("a move made since stays, and so does the stale list's own move", () => {
    const base = ["a", "b", "c", "d", "e"];
    // Someone moved e to the top meanwhile.
    const current = ["e", "a", "b", "c", "d"];
    // A page that still saw `base` moved b to the end.
    const theirs = ["a", "c", "d", "e", "b"];
    expect(rebaseMrOrder(base, theirs, current)).toEqual([
      "e",
      "a",
      "c",
      "d",
      "b",
    ]);
  });

  test("keys the stale list never knew are left where they are", () => {
    const out = rebaseMrOrder(["a", "b"], ["b", "a"], ["n", "a", "b"]);
    expect(out).toHaveLength(3);
    expect(out).toContain("n");
    expect(out.indexOf("b")).toBeLessThan(out.indexOf("a"));
  });

  test("a list with no change on the base changes nothing", () => {
    expect(
      rebaseMrOrder(["a", "b", "c"], ["a", "b", "c"], ["c", "a", "b"]),
    ).toEqual(["c", "a", "b"]);
  });
});
