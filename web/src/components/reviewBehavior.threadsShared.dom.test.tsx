import { inIsolatedChild } from "../testIsolated";
import { describe, expect, test } from "bun:test";

/**
 * Threads the review shows from another review of the checkout (a
 * rendered file's), at the behavior level: each goes to its own review's
 * agent. Runs against every review surface (reviewSurfaces.testkit.ts).
 */
if (
  inIsolatedChild(
    import.meta.path,
    "review shared threads in an isolated DOM runtime",
    "ROAMGATE_REVIEW_BEHAVIOR_DOM_TEST",
    60_000,
  )
) {
  const { installReviewDom, file, hunk, numbered, thread } = await import(
    "./reviewSurface.testkit"
  );
  await installReviewDom();
  const { reviewSurfacesWith } = await import("./reviewSurfaces.testkit");
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

  type Surface = Awaited<
    ReturnType<ReturnType<typeof reviewSurfacesWith>[0]["mount"]>
  >;
  /** A thread as shown, or null when it is not. */
  const shown = (review: Surface, id: string) =>
    review.shownThreads().find((each) => each.id === id) ?? null;
  /** The agent the comments go to: Claude, in the workspace's pane. */
  const claude = { agent: { name: "Claude", paneId: "w1:p1" } };

  for (const surface of reviewSurfacesWith("threads-shared")) {
    const { name, mount } = surface;
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

      test("a rendered file's threads show on its lines in the code review, answered in their own review; Rendered shows the file rendered", async () => {
        const lines = numbered("plan line", 12);
        // Written on the rendered file: older anchors keep the words quoted.
        const rendered = (
          id: string,
          path: string,
          line: number,
          body: string,
        ): ReviewThread =>
          ({
            ...thread(id, path, line, body),
            sessionId: "r1",
            kind: "discussion",
            anchor: {
              path,
              line,
              side: "new",
              text: "the words",
              render: { quote: "the words" },
            },
          }) as unknown as ReviewThread;
        const review = await mount({
          files: [
            file(
              "plan.md",
              hunk(
                1,
                1,
                lines.map((text) => `+${text}`),
              ),
            ),
          ],
          texts: { "plan.md": `${lines.join("\n")}\n` },
          shared: [
            rendered("r1t", "plan.md", 4, "Said on the rendered plan"),
            rendered("r2t", "other.md", 2, "On a file not in the changes"),
          ],
          otherReviews: [
            {
              id: "r1",
              connectionId: "desktop",
              root: "/repo",
              title: "plan.md rendered",
              target: { kind: "rendered", path: "plan.md" },
              gitlab: false,
              summary: "",
              agent: {},
              createdAt: "2026-11-10",
              updatedAt: "2026-11-10",
            },
          ],
          openFiles: true,
        });
        // On its line, not apart as outdated; another file's is not here.
        expect(review.text()).toContain("Said on the rendered plan");
        expect(shown(review, "r1t")?.general).toBe(false);
        expect(
          review.markedLines().map((line) => `${line.path}:${line.new}`),
        ).toEqual(["plan.md:4"]);
        expect(review.text()).not.toContain("On a file not in the changes");
        // Answered here: a reply the server writes in the thread's review.
        expect(shown(review, "r1t")?.buttons).toContain("Reply");
        await review.threadButton("r1t", "Reply");
        await review.writeInEditor("Answered from the code");
        await review.editorPress("<C-Enter>");
        expect(review.calls("review.reply")[0]?.params).toMatchObject({
          session_id: "r1",
          comment_id: "r1t",
          text: "Answered from the code",
        });
        // Rendered: the file in the Files preview, rendered.
        expect(review.fileButtons("plan.md")).toContain("Rendered");
        await review.clickFileHeader("plan.md", "Rendered");
        expect(
          review.openedFiles()[review.openedFiles().length - 1],
        ).toMatchObject({
          path: "/repo/plan.md",
          rendered: true,
        });
        await review.unmount();
      });

      test("another repository's thread on a file of the same path is not drawn, walked, counted or listed; the checkout's other review's is", async () => {
        const session = (id: string, root: string) => ({
          id,
          workspaceId: "workspace",
          root,
          title: root,
          target: { kind: "worktree" },
          gitlab: false,
          summary: "",
          agent: {},
          createdAt: "2026-11-04",
          updatedAt: "2026-11-04",
        });
        const mountWith = (root: string) =>
          mount({
            files: [added("a.ts", 12)],
            // The review names its repository: the checkout's, /repo.
            session: { root: "/repo" },
            shared: [
              {
                ...conversation("ta", 2, [["you", "On a.ts of a"]]),
                sessionId: "in-a",
              },
            ],
            otherReviews: [session("in-a", root)],
          });
        // Of another repository, /w/a: its a.ts is not this one's.
        const review = await mountWith("/w/a");
        expect(review.shownThreads()).toEqual([]);
        expect(review.threadsChip()).toBeNull();
        await review.press("gn");
        expect(review.notice()).toBe("No unresolved comment here.");
        expect(review.cursorLine()?.new).toBe(1);
        await review.unmount();
        // Of this checkout: drawn, counted and walked.
        const own = await mountWith("/repo");
        expect(own.shownThreads().map((each) => each.id)).toEqual(["ta"]);
        expect(own.threadsChip()).not.toBeNull();
        await own.press("gn");
        expect(own.cursorLine()?.new).toBe(2);
        await own.unmount();
      });
    });
  }
}
