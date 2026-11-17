import { describe, expect, test } from "bun:test";

/**
 * The review under the mouse, at the behavior level: a click puts the
 * cursor, a second one comments, Shift+click extends a Visual selection,
 * a file's header folds it and opens it. Runs against every review surface
 * (reviewSurfaces.testkit.ts).
 */
if (process.env.ROAMGATE_REVIEW_BEHAVIOR_DOM_TEST !== "1") {
  test("review mouse in an isolated DOM runtime", async () => {
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
  }, 30_000);
} else {
  const { installReviewDom, file, hunk, numbered } = await import(
    "./reviewSurface.testkit"
  );
  await installReviewDom();
  const { reviewSurfacesWith, testWith } = await import(
    "./reviewSurfaces.testkit"
  );

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

  for (const surface of reviewSurfacesWith("mouse"))
    describe(surface.name, () => {
      const { mount } = surface;
      testWith(surface, "editor")(
        "a click puts the cursor on a line; a second click on it opens a comment editor",
        async () => {
          const review = await mount({ files: [added("a.ts", 8)] });
          await review.click({ path: "a.ts", new: 3 });
          expect(review.cursorLine()?.text).toBe("a.ts line 3");
          expect(review.editorOpen()).toBe(false);
          // Keys after one click move the cursor, rather than write.
          await review.press("j");
          expect(review.cursorLine()?.text).toBe("a.ts line 4");
          await review.click({ path: "a.ts", new: 6 });
          await review.click({ path: "a.ts", new: 6 });
          expect(review.cursorLine()?.text).toBe("a.ts line 6");
          expect(review.editorOpen()).toBe(true);
          await review.unmount();
        },
      );

      test("Shift+click starts a Visual selection from the cursor, or extends the one there, inside its file", async () => {
        const review = await mount({
          files: [added("a.ts", 8), added("b.ts", 4)],
        });
        const selected = () => review.selection().map((line) => line.new);
        await review.click({ path: "a.ts", new: 2 });
        await review.click({ path: "a.ts", new: 5 }, true);
        expect(selected()).toEqual([2, 3, 4, 5]);
        expect(review.cursorLine()?.new).toBe(5);
        // Again: from the same start.
        await review.click({ path: "a.ts", new: 3 }, true);
        expect(selected()).toEqual([2, 3]);
        // In another file, it stops at the end of this one.
        await review.click({ path: "b.ts", new: 2 }, true);
        expect(selected()).toEqual([2, 3, 4, 5, 6, 7, 8]);
        // A plain click ends it.
        await review.click({ path: "a.ts", new: 4 });
        expect(selected()).toEqual([]);
        // V, then Shift+click extends what V started.
        await review.press("V");
        await review.click({ path: "a.ts", new: 6 }, true);
        expect(selected()).toEqual([4, 5, 6]);
        expect(review.editorOpen()).toBe(false);
        await review.unmount();
      });

      test("Shift+click in another file shows the selection to the end of the file it started in", async () => {
        const review = await mount({
          files: [added("a.ts", 8), added("b.ts", 4)],
        });
        const selected = () =>
          review.selection().map((line) => `${line.path}:${line.new}`);
        await review.click({ path: "a.ts", new: 6 });
        await review.click({ path: "b.ts", new: 2 }, true);
        expect(selected()).toEqual(["a.ts:6", "a.ts:7", "a.ts:8"]);
        await review.unmount();
      });

      testWith(surface, "file-folds")(
        "a click on a file's header folds its lines away, another shows them",
        async () => {
          const review = await mount({
            files: [added("a.ts", 3), added("b.ts", 3)],
          });
          expect(review.fileFolded("a.ts")).toBe(false);
          await review.clickFileHeader("a.ts");
          expect(review.fileFolded("a.ts")).toBe(true);
          expect(review.lines("a.ts")).toEqual([]);
          expect(review.lines("b.ts").length).toBe(3);
          await review.clickFileHeader("a.ts");
          expect(review.fileFolded("a.ts")).toBe(false);
          expect(review.lines("a.ts").length).toBe(3);
          await review.unmount();
        },
      );

      testWith(surface, "file-folds")(
        "a file of more than 600 changed lines starts folded; Show N lines shows it",
        async () => {
          // Changes folds by its own rule: a diff of 1000 changed lines or
          // more, shown by View diff (Pierre draws long files: no 600-line
          // fold there).
          const changes = surface.name === "changes";
          const size = changes ? 1000 : 601;
          const show = changes ? "View diff" : "Show 601 lines";
          const review = await mount({
            files: [added("a.ts", 2), added("big.ts", size)],
          });
          expect(review.fileFolded("big.ts")).toBe(true);
          expect(review.lines("big.ts")).toEqual([]);
          expect(review.fileButtons("big.ts")).toEqual([show]);
          await review.clickFileHeader("big.ts", show);
          expect(review.fileFolded("big.ts")).toBe(false);
          expect(review.lines("big.ts").length).toBe(size);
          expect(review.fileButtons("big.ts")).toEqual([]);
          await review.unmount();
        },
      );

      testWith(surface, "open-files")(
        "Open on a file's header opens it in the Files preview, at the cursor line when it is in that file",
        async () => {
          const review = await mount({
            files: [added("a.ts", 4), added("b.ts", 4)],
            openFiles: true,
          });
          expect(review.fileButtons("a.ts")).toEqual(["Open"]);
          await review.press("j");
          await review.clickFileHeader("a.ts", "Open");
          await review.clickFileHeader("b.ts", "Open");
          expect(review.openedFiles()).toEqual([
            { path: "/repo/a.ts", line: 2 },
            { path: "/repo/b.ts" },
          ]);
          await review.unmount();
        },
      );

      testWith(surface, "open-files")(
        "without a Files preview to open in, a file's header has no Open",
        async () => {
          const review = await mount({ files: [added("doc.md", 2)] });
          expect(review.fileButtons("doc.md")).toEqual([]);
          await review.unmount();
        },
      );
    });
}
