import { describe, expect, test } from "bun:test";

/**
 * Threads the review shows from another review of the checkout (a
 * rendered file's), at the behavior level: each goes to its own review's
 * agent. Runs against every review surface (reviewSurfaces.testkit.ts).
 */
if (process.env.ROAMGATE_REVIEW_BEHAVIOR_DOM_TEST !== "1") {
  test("review shared threads in an isolated DOM runtime", async () => {
    const child = Bun.spawn([process.execPath, "test", import.meta.path], {
      env: { ...process.env, ROAMGATE_REVIEW_BEHAVIOR_DOM_TEST: "1" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    if (code !== 0) throw new Error(`${stdout}\n${stderr}`);
    expect(code).toBe(0);
  }, 60_000);
} else {
  const { installReviewDom, file, hunk, numbered, thread } = await import(
    "./reviewSurface.testkit"
  );
  await installReviewDom();
  const { REVIEW_SURFACES } = await import("./reviewSurfaces.testkit");
  type ReviewThread = import("../../../shared/review").ReviewThread;

  /** `count` added lines `${path} line N`. */
  const added = (path: string, count: number) =>
    file(
      path,
      hunk(
        1,
        1,
        numbered(`${path} line`, count).map((line) => `+${line}`),
      ),
    );

  /**
   * A thread with these messages: [author, body, written at?, rewritten
   * at?, comment id?].
   */
  const conversation = (
    id: string,
    line: number | null,
    messages: [string, string, string?, string?, string?][],
    extra: Partial<ReviewThread> = {},
  ): ReviewThread => {
    const base = thread(id, "a.ts", line ?? 1, "");
    return {
      ...base,
      anchor: line === null ? {} : base.anchor,
      comments: messages.map(([author, body, at, editedAt, commentId], i) => {
        const createdAt = at ?? `2026-11-04T14:1${i}:00Z`;
        return {
          id: commentId ?? `${id}c${i}`,
          author,
          body,
          createdAt,
          updatedAt: editedAt ?? createdAt,
        };
      }),
      ...extra,
    } as ReviewThread;
  };

  type Surface = Awaited<ReturnType<(typeof REVIEW_SURFACES)[0]["mount"]>>;
  /** A thread as shown, or null when it is not. */
  const shown = (review: Surface, id: string) =>
    review.shownThreads().find((each) => each.id === id) ?? null;
  /** The agent the comments go to: Claude, in the workspace's pane. */
  const claude = { agent: { name: "Claude", paneId: "w1:p1" } };

  for (const { name, mount } of REVIEW_SURFACES)
    describe(name, () => {
      test("a thread shared from a rendered file's review says how it goes to that review's agent; Retry asks that review again", async () => {
        const rendered = {
          id: "r2",
          connectionId: "desktop",
          workspaceId: "w1",
          root: "/repo",
          title: "a.ts rendered",
          target: { kind: "rendered", path: "a.ts" },
          gitlab: false,
          summary: "",
          agent: { name: "Codex", paneId: "w1:p2" },
          deliveryError: "herdr: pane not found",
          createdAt: "2026-10-30",
          updatedAt: "2026-10-30",
        };
        const review = await mount({
          files: [added("a.ts", 12)],
          session: claude,
          threads: [conversation("t1", 3, [["you", "Mine"]])],
          shared: [
            {
              ...conversation("s1", 6, [["you", "From the rendered file"]]),
              sessionId: "r2",
            },
            // On a file this review does not change: not shown.
            {
              ...thread("s2", "other.md", 1, "Elsewhere"),
              sessionId: "r2",
            },
          ],
          otherReviews: [rendered],
        });
        expect(review.shownThreads().map((each) => each.id)).toEqual([
          "t1",
          "s1",
        ]);
        // Its own review's way: not delivered there, said with Retry.
        expect(shown(review, "t1")?.messages[0]?.marks).toEqual([
          "→ Claude...",
        ]);
        expect(shown(review, "s1")?.messages[0]?.marks).toEqual([
          "not delivered: herdr: pane not found",
        ]);
        await review.threadButton("s1", "Retry", 0);
        expect(review.calls("review.retry")).toEqual([
          { method: "review.retry", params: { session_id: "r2" } },
        ]);
        expect(review.calls("review.handoff")).toEqual([]);
        await review.unmount();
      });
    });
}
