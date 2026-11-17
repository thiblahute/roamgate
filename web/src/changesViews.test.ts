import { describe, expect, test } from "bun:test";
import type { ReviewCommit } from "../../shared/review";
import { oneCommitTitle } from "./changesViews";

const commit = (
  sha: string,
  subject: string,
  parent: string | null,
): ReviewCommit => ({
  sha,
  parent,
  author: "A",
  date: "2026-11-16T00:00:00Z",
  subject,
  body: "",
});

describe("oneCommitTitle", () => {
  const root = "d272642486c9f06335ef462e866f0798d7a3a4ad";
  const other = "8fe1b1501234567890abcdef1234567890abcdef";

  test("a review of one commit (SHA^..SHA) is named by its short sha and subject", () => {
    expect(
      oneCommitTitle({ kind: "range", base: `${other}^`, head: other }, [
        commit(other, "step 2", "0".repeat(40)),
      ]),
    ).toBe("8fe1b150 step 2");
    for (const base of [`${other}~1`, `${other}~`])
      expect(
        oneCommitTitle({ kind: "range", base, head: other }, [
          commit(other, "step 2", "0".repeat(40)),
        ]),
      ).toBe("8fe1b150 step 2");
  });

  test("a root commit's says so", () => {
    expect(
      oneCommitTitle({ kind: "range", base: `${root}^`, head: root }, [
        commit(root, "base", null),
      ]),
    ).toBe("d2726424 base (root commit)");
  });

  test("anything else keeps its own title", () => {
    expect(
      oneCommitTitle({ kind: "range", base: "main", head: other }, [
        commit(other, "step 2", "0".repeat(40)),
      ]),
    ).toBeNull();
    expect(
      oneCommitTitle(
        { kind: "range", base: `${other}^`, head: other, compare: true },
        [commit(other, "step 2", "0".repeat(40))],
      ),
    ).toBeNull();
    // Its commits not read yet, or not that one commit.
    expect(
      oneCommitTitle({ kind: "range", base: `${other}^`, head: other }, null),
    ).toBeNull();
    expect(
      oneCommitTitle({ kind: "range", base: `${other}^`, head: other }, [
        commit(root, "base", null),
        commit(other, "step 2", root),
      ]),
    ).toBeNull();
    expect(oneCommitTitle({ kind: "worktree" }, [])).toBeNull();
  });
});
