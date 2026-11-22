import { describe, expect, test } from "bun:test";
import { type ReviewSnapshot, summarizeReview } from "../../shared/review";
import { changesReviewChoice } from "./changesReviewOpen";

/** A review of the checkout /repo, of `target`. */
const review = (id: string, target: Record<string, unknown>) =>
  ({
    session: {
      id,
      connectionId: "desktop",
      workspaceId: "w1",
      root: "/repo",
      title: id,
      target,
      gitlab: false,
      summary: "",
      agent: {},
      createdAt: "2026-11-10",
      updatedAt: "2026-11-10",
    },
    threads: [],
  }) as unknown as ReviewSnapshot;

const choose = (snapshot: ReviewSnapshot) =>
  changesReviewChoice({
    snapshot,
    checkoutRoot: "/repo",
    connectionId: "no-such-connection",
    panes: [],
    sessions: [summarizeReview(snapshot)],
    changed: async () => true,
  });

describe("where a review shows", () => {
  test("a rendered file's or site's review is not shown in Changes: it is discussed in the Files preview", async () => {
    for (const target of [
      { kind: "rendered", path: "README.md" },
      { kind: "rendered", url: "https://example.org/" },
    ])
      expect(await choose(review("doc", target))).toEqual({
        kind: "home",
        sessionId: "doc",
        home: "files",
        reason: "A rendered file's review is discussed in the Files preview.",
      });
    // The checkout's own reviews do show there.
    const own = await choose(review("r1", { kind: "worktree" }));
    expect(own.kind).toBe("changes");
    expect(own.sessionId).toBe("r1");
  });
});
