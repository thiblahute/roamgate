import { describe, expect, test } from "bun:test";

/**
 * The review's comments panel (T), its chip and the unresolved threads'
 * arrows, at the behavior level. Runs against every review surface
 * (reviewSurfaces.testkit.ts).
 */
if (process.env.ROAMGATE_REVIEW_BEHAVIOR_DOM_TEST !== "1") {
  test("review comments panel in an isolated DOM runtime", async () => {
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
  /** The last call the bridge had of a method. */
  const lastCall = (review: Surface, method: string) => {
    const calls = review.calls(method);
    return calls[calls.length - 1];
  };

  for (const { name, mount } of REVIEW_SURFACES)
    describe(name, () => {
      /** Three open threads, the latest answered first, and a resolved one. */
      const four = () => [
        conversation("t1", 2, [["you", "First"]], {}),
        conversation("t2", 5, [
          ["you", "Second"],
          ["Claude", "Answer", "2026-11-04T14:40:00Z"],
        ]),
        conversation("t3", 8, [["you", "Third", "2026-11-04T14:30:00Z"]]),
        conversation("t4", 10, [["you", "Settled"]], { resolved: true }),
      ];

      test("the comments panel's keys: j / k select, Space unfolds, Enter goes to it, r resolves, H shows the resolved, R answers, / searches", async () => {
        const review = await mount({
          files: [added("a.ts", 12)],
          threads: four(),
        });
        expect(review.threadsPanel()).toBeNull();
        await review.press("T");
        // Open ones first, the latest written first; the resolved hidden.
        expect(review.threadsPanel()?.ids).toEqual(["t2", "t3", "t1"]);
        expect(review.threadsPanel()?.text).toContain("1 resolved");
        await review.press("j");
        expect(review.threadsPanel()?.selected).toBe("t3");
        await review.press("j");
        expect(review.threadsPanel()?.selected).toBe("t1");
        await review.press("j");
        expect(review.threadsPanel()?.selected).toBe("t1");
        await review.press("k");
        expect(review.threadsPanel()?.selected).toBe("t3");
        // Space reads it all, and folds it back.
        await review.press("<Space>");
        expect(review.threadsPanel()?.unfolded).toEqual(["t3"]);
        await review.press("<Space>");
        expect(review.threadsPanel()?.unfolded).toEqual([]);
        // r resolves it (or reopens it).
        await review.press("r");
        expect(lastCall(review, "review.resolve")?.params).toMatchObject({
          comment_id: "t3",
          resolved: true,
        });
        // H shows the resolved ones after the open ones, and hides them.
        await review.press("H");
        expect(review.threadsPanel()?.ids).toEqual(["t2", "t3", "t1", "t4"]);
        await review.press("H");
        expect(review.threadsPanel()?.ids).toEqual(["t2", "t3", "t1"]);
        // R answers it in the panel.
        await review.press("R");
        expect(review.editorOpen()).toBe(true);
        await review.press("<Esc>");
        // / goes to the search.
        await review.press("/");
        expect(review.threadsPanel()?.searching).toBe(true);
        await review.press("<Esc>");
        expect(review.threadsPanel()?.searching).toBe(false);
        // Enter goes to the thread, on its line, and closes the panel.
        await review.press("gg");
        expect(review.threadsPanel()?.selected).toBe("t2");
        await review.press("<CR>");
        expect(review.threadsPanel()).toBeNull();
        expect(review.cursorLine()?.new).toBe(5);
        // T opens it again; Esc closes it.
        await review.press("T");
        expect(review.threadsPanel()).not.toBeNull();
        await review.press("<Esc>");
        expect(review.threadsPanel()).toBeNull();
        await review.unmount();
      });

      test("the comments chip counts the open ones and opens the panel; the unresolved arrows beside it step through them", async () => {
        const review = await mount({
          files: [added("a.ts", 12)],
          threads: four(),
        });
        expect(review.threadsChip()).toBe("3 open · 4 comments");
        await review.clickThreadsChip();
        expect(review.threadsPanel()?.ids).toEqual(["t2", "t3", "t1"]);
        await review.clickThreadsChip();
        expect(review.threadsPanel()).toBeNull();

        expect(review.unresolvedNav()).toEqual({
          label: "3 unresolved",
          disabled: false,
        });
        // In the order of the review, from its first line.
        await review.unresolvedStep("next");
        expect(review.cursorLine()?.new).toBe(2);
        expect(review.unresolvedNav()?.label).toBe("1 of 3 unresolved");
        await review.unresolvedStep("next");
        expect(review.cursorLine()?.new).toBe(5);
        expect(review.unresolvedNav()?.label).toBe("2 of 3 unresolved");
        await review.unresolvedStep("previous");
        expect(review.cursorLine()?.new).toBe(2);
        // Past the first: the last one, around.
        await review.unresolvedStep("previous");
        expect(review.cursorLine()?.new).toBe(8);
        expect(review.unresolvedNav()?.label).toBe("3 of 3 unresolved");
        // Only them: the resolved thread is no longer drawn.
        expect(review.shownThreads().map((each) => each.id)).toContain("t4");
        await review.unresolvedStep("only");
        expect(review.shownThreads().map((each) => each.id)).not.toContain(
          "t4",
        );
        await review.unresolvedStep("only");

        // All resolved: said, the arrows off.
        await review.push({
          threads: four().map((each) => ({ ...each, resolved: true })),
        });
        expect(review.threadsChip()).toBe("0 open · 4 comments");
        expect(review.unresolvedNav()).toEqual({
          label: "All resolved",
          disabled: true,
        });
        await review.unmount();
      });
    });
}
