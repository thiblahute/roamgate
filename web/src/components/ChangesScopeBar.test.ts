import { describe, expect, test } from "bun:test";
import { changesScopeChoice, changesScopeFacts } from "./ChangesScopeBar";

describe("Changes' scope line", () => {
  test("says plainly what is compared", () => {
    expect(changesScopeChoice("working", "x", undefined)).toBe(
      "Working tree: uncommitted changes",
    );
    expect(changesScopeChoice("branch-main", "iga-185", "origin/main")).toBe(
      "branch iga-185 vs origin/main",
    );
    expect(changesScopeChoice("branch-main", undefined, undefined)).toBe(
      "this branch vs its base",
    );
    expect(changesScopeChoice("last-step", "x", "y")).toMatch(/^Last step/);
  });

  test("counts the commits and the files, and says when all are untracked", () => {
    expect(
      changesScopeFacts({ mode: "branch-main", commits: 12, files: 4 }),
    ).toBe("12 commits · 4 files");
    expect(changesScopeFacts({ mode: "working", files: 4, untracked: 4 })).toBe(
      "4 files, all untracked",
    );
    expect(changesScopeFacts({ mode: "working", files: 3, untracked: 1 })).toBe(
      "3 files (1 untracked)",
    );
    expect(changesScopeFacts({ mode: "working", files: 1 })).toBe("1 file");
    expect(changesScopeFacts({ mode: "last-step", files: 0 })).toBe(
      "no change",
    );
  });
});
