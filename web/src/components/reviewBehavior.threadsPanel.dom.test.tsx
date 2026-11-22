import { inIsolatedChild } from "../testIsolated";
import { describe, expect, test } from "bun:test";

/**
 * The review's comments panel (T), its chip and the unresolved threads'
 * arrows, at the behavior level. Runs against every review surface
 * (reviewSurfaces.testkit.ts).
 */
if (
  inIsolatedChild(
    import.meta.path,
    "review comments panel in an isolated DOM runtime",
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
  /** The last call the bridge had of a method. */
  const lastCall = (review: Surface, method: string) => {
    const calls = review.calls(method);
    return calls[calls.length - 1];
  };

  for (const surface of reviewSurfacesWith("threads-panel")) {
    const { name, mount } = surface;
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

      test("the comments' one control counts the open ones and opens the panel; its arrows step through them", async () => {
        const review = await mount({
          files: [added("a.ts", 12)],
          threads: four(),
        });
        expect(review.threadsChip()).toBe("3 open · 4");
        await review.clickThreadsChip();
        expect(review.threadsPanel()?.ids).toEqual(["t2", "t3", "t1"]);
        await review.clickThreadsChip();
        expect(review.threadsPanel()).toBeNull();

        expect(review.unresolvedNav()).toEqual({
          label: "3 open",
          disabled: false,
        });
        // In the order of the review, from its first line.
        await review.unresolvedStep("next");
        expect(review.cursorLine()?.new).toBe(2);
        expect(review.unresolvedNav()?.label).toBe("1/3 open");
        await review.unresolvedStep("next");
        expect(review.cursorLine()?.new).toBe(5);
        expect(review.unresolvedNav()?.label).toBe("2/3 open");
        await review.unresolvedStep("previous");
        expect(review.cursorLine()?.new).toBe(2);
        // Past the first: the last one, around.
        await review.unresolvedStep("previous");
        expect(review.cursorLine()?.new).toBe(8);
        expect(review.unresolvedNav()?.label).toBe("3/3 open");
        // Only them: the resolved thread is no longer drawn.
        expect(review.shownThreads().map((each) => each.id)).toContain("t4");
        await review.unresolvedStep("only");
        expect(review.shownThreads().map((each) => each.id)).not.toContain(
          "t4",
        );
        await review.unresolvedStep("only");

        // All resolved: said, the arrows gone.
        await review.push({
          threads: four().map((each) => ({ ...each, resolved: true })),
        });
        expect(review.threadsChip()).toBe("All resolved");
        expect(review.unresolvedNav()).toEqual({
          label: "All resolved",
          disabled: true,
        });
        await review.unmount();
      });

      test("resolving a conversation keeps the list where it is; resolved ones are hidden until shown", async () => {
        /** Every scrollIntoView made in the list, by conversation. */
        const scrolled: string[] = [];
        const scrollIntoView = Element.prototype.scrollIntoView;
        Element.prototype.scrollIntoView = function (this: Element) {
          const id = this.closest("[data-panel-thread]")?.getAttribute(
            "data-panel-thread",
          );
          if (id) scrolled.push(id);
        };
        // Fifteen on the whole review, newest first; the last three resolved.
        const fifteen = (resolved: Set<number>) =>
          Array.from({ length: 15 }, (_, i) =>
            conversation(
              `t${i + 1}`,
              null,
              [
                [
                  "you",
                  `Point ${i + 1}`,
                  `2026-10-31T19:${String(59 - i).padStart(2, "0")}:00Z`,
                ],
              ],
              { resolved: resolved.has(i + 1) },
            ),
          );
        const resolved = new Set([13, 14, 15]);
        const review = await mount({
          files: [added("a.ts", 12)],
          threads: fifteen(resolved),
        });
        try {
          await review.clickThreadsChip();
          const list = () =>
            document.querySelector<HTMLElement>(
              ".threads-panel .threads-panel-list",
            )!;
          const panel = () => review.threadsPanel()!;
          // Open ones only, with the count of the resolved ones to show them.
          expect(panel().ids).toEqual(
            Array.from({ length: 12 }, (_, i) => `t${i + 1}`),
          );
          expect(
            document.querySelector(
              ".threads-panel .threads-panel-head .threads-panel-count",
            )?.textContent,
          ).toBe("12 open \u00b7 3 resolved, show");
          expect(
            list().querySelector(".threads-panel-group")?.textContent,
          ).toBe("3 resolved, show");

          for (let i = 0; i < 6; i++) await review.press("j");
          expect(panel().selected).toBe("t7");
          list().scrollTop = 120;
          scrolled.length = 0;
          // r resolves it; the review comes back with it resolved.
          await review.press("r");
          expect(lastCall(review, "review.resolve")?.params).toMatchObject({
            comment_id: "t7",
            resolved: true,
          });
          resolved.add(7);
          await review.push({ threads: fifteen(resolved) });
          expect(panel().ids).not.toContain("t7");
          expect(panel().selected).toBe("t8");
          expect(list().scrollTop).toBe(120);
          expect(scrolled).toEqual([]);

          // Scrolled up by hand, it stays there through new renders.
          list().scrollTop = 0;
          await review.push({ threads: fifteen(resolved) });
          expect(list().scrollTop).toBe(0);
          expect(scrolled).toEqual([]);
          // A move by key still brings the selection into view.
          await review.press("j");
          expect(scrolled).toEqual(["t9"]);

          // H lists the resolved ones after the open ones, and is remembered.
          await review.press("H");
          expect(panel().ids).toEqual([
            ...[1, 2, 3, 4, 5, 6, 8, 9, 10, 11, 12].map((i) => `t${i}`),
            ...[7, 13, 14, 15].map((i) => `t${i}`),
          ]);
          expect(
            list().querySelector(".threads-panel-group")?.textContent,
          ).toBe("4 resolved, hide");
          expect(
            localStorage.getItem("roamgate:threadsPanel.showResolved"),
          ).toBe("1");

          // R answers the selected one right there; it reloads nothing.
          const reads = review.calls().length;
          await review.press("R");
          expect(panel().selected).toBe("t9");
          expect(
            document.querySelector(
              ".threads-panel [data-panel-thread='t9'] .threads-panel-reply .cm-content",
            ),
          ).not.toBeNull();
          expect(review.calls().slice(reads)).toEqual([]);
          expect(review.hostCalls("reload")).toEqual([]);
        } finally {
          Element.prototype.scrollIntoView = scrollIntoView;
          await review.unmount();
        }
      });

      test("gn / gN go through the unresolved threads only, opening a reviewed file; gH shows only them", async () => {
        const review = await mount({
          files: [added("a.ts", 10), added("b.ts", 10)],
          threads: [
            {
              ...conversation("t3", 3, [["you", "Question t3"]]),
              anchor: { path: "b.ts", line: 3, side: "new" },
            },
            conversation("t1", 2, [["you", "Question t1"]]),
            conversation("t2", 5, [["you", "Question t2"]], {
              resolved: true,
            }),
          ],
        });
        // b.ts is marked reviewed: folded to its header.
        await review.goToFile("b.ts");
        await review.press("v");
        expect(review.fileReviewed("b.ts")).toBe(true);
        await review.goToFile("a.ts");
        await review.press("gg");
        const where = () => review.unresolvedNav()?.label;
        expect(where()).toBe("2 open");
        // The reviewed file shows no line yet.
        expect(review.lines("b.ts").map((line) => line.text)).not.toContain(
          "b.ts line 3",
        );
        await review.press("gn");
        expect(where()).toBe("1/2 open");
        expect(review.notice()).toBe("1 of 2 unresolved");
        expect(review.cursorLine()).toMatchObject({ path: "a.ts", new: 2 });
        // Over the resolved one on a.ts into the reviewed file, opened.
        await review.press("gn");
        expect(review.lines("b.ts").map((line) => line.text)).toContain(
          "b.ts line 3",
        );
        expect(where()).toBe("2/2 open");
        expect(review.cursorLine()).toMatchObject({ path: "b.ts", new: 3 });
        // Past the last: back at the first.
        await review.press("gn");
        expect(where()).toBe("1/2 open");
        expect(review.cursorLine()).toMatchObject({ path: "a.ts", new: 2 });
        await review.press("gN");
        expect(review.cursorLine()).toMatchObject({ path: "b.ts", new: 3 });
        // The arrows do the same.
        await review.unresolvedStep("previous");
        expect(review.cursorLine()).toMatchObject({ path: "a.ts", new: 2 });

        // The resolved one is drawn folded; gH leaves it out, remembered.
        expect(review.text()).toContain("Question t2");
        await review.press("gH");
        expect(review.text()).not.toContain("Question t2");
        expect(localStorage.getItem("roamgate:threads.openOnly")).toBe("1");
        expect(
          document
            .querySelector(
              '[aria-label="Unresolved threads"] [aria-label="Unresolved only"]',
            )
            ?.getAttribute("aria-pressed"),
        ).toBe("true");
        await review.unmount();
      });
    });
  }
}
