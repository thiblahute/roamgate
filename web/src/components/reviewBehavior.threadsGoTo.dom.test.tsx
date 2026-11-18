import { inIsolatedChild } from "../testIsolated";
import { describe, expect, test } from "bun:test";

/**
 * The comments panel's Go to it (Enter) at the behavior level: whatever
 * the review shows, the thread's line is brought into view with the cursor
 * on it and the thread's first message selected. Its file folded, not read
 * yet, its line among the hidden ones, its view another commit's or all the
 * changes': all opened on the way. Runs against every review surface
 * (reviewSurfaces.testkit.ts).
 */
if (
  inIsolatedChild(
    import.meta.path,
    "review comments panel's go to in an isolated DOM runtime",
    "ROAMGATE_REVIEW_BEHAVIOR_DOM_TEST",
    60_000,
  )
) {
  const { installReviewDom, file, hunk, numbered, thread } = await import(
    "./reviewSurface.testkit"
  );
  await installReviewDom();
  const { reviewSurfacesWith, testWith } = await import(
    "./reviewSurfaces.testkit"
  );
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
  /** A thread on a line, its anchor's fields over the kit's. */
  const on = (
    id: string,
    path: string,
    line: number,
    body: string,
    anchor: Record<string, unknown> = {},
  ): ReviewThread => {
    const base = thread(id, path, line, body);
    return { ...base, anchor: { ...base.anchor, ...anchor } } as ReviewThread;
  };
  /** A 100-line file with line 31 changed: lines 33-100 hidden after it. */
  const hidden = () => {
    const lines = Array.from({ length: 100 }, (_, i) =>
      i === 30 ? "line thirty-one" : `line ${i + 1}`,
    );
    return {
      file: file(
        "h.ts",
        hunk(30, 30, [" line 30", "-line 31", "+line thirty-one", " line 32"]),
      ),
      text: `${lines.join("\n")}\n`,
    };
  };

  for (const surface of reviewSurfacesWith("threads-panel")) {
    const { name, mount } = surface;
    describe(name, () => {
      testWith(surface, "file-folds")(
        "Go to it opens a file folded by hand, on the thread's line and its message",
        async () => {
          const review = await mount({
            files: [added("a.ts", 6), added("b.ts", 6)],
            threads: [on("t1", "b.ts", 4, "Why four?")],
          });
          await review.clickFileHeader("b.ts");
          expect(review.fileFolded("b.ts")).toBe(true);
          await review.press("T");
          expect(review.threadsPanel()?.ids).toEqual(["t1"]);
          await review.press("<CR>");
          expect(review.threadsPanel()).toBeNull();
          expect(review.fileFolded("b.ts")).toBe(false);
          expect(review.cursorLine()).toMatchObject({ path: "b.ts", new: 4 });
          expect(review.threadStop()).toMatchObject({
            kind: "message",
            text: expect.stringContaining("Why four?"),
          });
          await review.unmount();
        },
      );

      testWith(surface, "file-folds")(
        "Go to it opens a large file that starts folded, not read yet",
        async () => {
          const review = await mount({
            files: [added("a.ts", 2), added("big.ts", 1000)],
            threads: [on("t1", "big.ts", 700, "Seven hundred")],
          });
          expect(review.fileFolded("big.ts")).toBe(true);
          await review.press("T");
          await review.press("<CR>");
          expect(review.fileFolded("big.ts")).toBe(false);
          expect(review.cursorLine()).toMatchObject({
            path: "big.ts",
            new: 700,
          });
          expect(review.threadStop()?.text).toContain("Seven hundred");
          await review.unmount();
        },
      );

      testWith(
        surface,
        "file-folds",
        "expand",
      )(
        "Go to it on a folded file's hidden line shows the lines around it",
        async () => {
          const { file: h, text } = hidden();
          const review = await mount({
            files: [added("a.ts", 4), h],
            texts: { "h.ts": text },
            threads: [on("t1", "h.ts", 60, "Line sixty", { text: "line 60" })],
          });
          await review.clickFileHeader("h.ts");
          expect(review.fileFolded("h.ts")).toBe(true);
          await review.press("T");
          await review.press("<CR>");
          expect(review.fileFolded("h.ts")).toBe(false);
          expect(review.cursorLine()).toMatchObject({ path: "h.ts", new: 60 });
          expect(review.threadStop()?.text).toContain("Line sixty");
          await review.unmount();
        },
      );

      test("Go to it on a thread whose line is gone goes to the nearest line and says so", async () => {
        const review = await mount({
          files: [added("a.ts", 8)],
          threads: [
            on("t1", "a.ts", 5, "Was here", { text: "a line no longer here" }),
          ],
        });
        await review.press("T");
        await review.press("<CR>");
        expect(review.cursorLine()).toMatchObject({ path: "a.ts", new: 5 });
        expect(review.notices().join("\n")).toContain("no longer");
        await review.unmount();
      });

      testWith(surface, "commits")(
        "Go to it on another commit's thread, or on all the changes', shows that view first",
        async () => {
          const a = added("a.ts", 3);
          const b = added("b.ts", 5);
          const second = "b".repeat(40);
          const review = await mount({
            files: [a, b],
            commits: [
              { sha: "a".repeat(40), subject: "First", files: [a] },
              { sha: second, subject: "Second", files: [b] },
            ],
            threads: [
              on("t2", "b.ts", 4, "On the second", {
                commit: second,
                commitSubject: "Second",
              }),
            ],
          });
          expect(review.view()).toBe("1/2 aaaaaaaa First");
          await review.press("T");
          // Listed though its commit is not the one shown.
          expect(review.threadsPanel()?.ids).toEqual(["t2"]);
          await review.press("<CR>");
          expect(review.view()).toBe("2/2 bbbbbbbb Second");
          expect(review.cursorLine()).toMatchObject({ path: "b.ts", new: 4 });
          expect(review.threadStop()?.text).toContain("On the second");
          await review.unmount();

          // A thread on all the changes, from one commit's view.
          const whole = await mount({
            files: [a, b],
            commits: [
              { sha: "a".repeat(40), subject: "First", files: [a] },
              { sha: second, subject: "Second", files: [b] },
            ],
            threads: [on("t3", "b.ts", 2, "On them all")],
          });
          expect(whole.view()).toBe("1/2 aaaaaaaa First");
          await whole.press("T");
          expect(whole.threadsPanel()?.ids).toEqual(["t3"]);
          await whole.press("<CR>");
          expect(whole.view()).toBe("All changes 2 commits");
          expect(whole.cursorLine()).toMatchObject({ path: "b.ts", new: 2 });
          expect(whole.threadStop()?.text).toContain("On them all");
          await whole.unmount();
        },
      );
    });
  }
}
