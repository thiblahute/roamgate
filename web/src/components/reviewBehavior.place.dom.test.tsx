import { describe, expect, jest, test } from "bun:test";

/**
 * Where a review is kept: its place (file, line, side) back after a page
 * reload and in each review apart, the 50 reviews remembered, damaged
 * storage read as empty, the preferences (side by side, file list, Vim),
 * and a review put away and shown again kept exactly, the keys back on it.
 * Runs against every review surface (reviewSurfaces.testkit.ts).
 */
if (process.env.ROAMGATE_REVIEW_BEHAVIOR_DOM_TEST !== "1") {
  test("review place and preferences in an isolated DOM runtime", async () => {
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
  const { installReviewDom, file, hunk, numbered } = await import(
    "./reviewSurface.testkit"
  );
  await installReviewDom();
  const { REVIEW_SURFACES } = await import("./reviewSurfaces.testkit");

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
  /** A file whose lines 3 and 4 were replaced by two new ones. */
  const changed = file(
    "c.ts",
    hunk(1, 1, [
      " c.ts 1",
      " c.ts 2",
      "-c.ts old 3",
      "-c.ts old 4",
      "+c.ts new 3",
      "+c.ts new 4",
      " c.ts 5",
    ]),
  );

  for (const { name, mount } of REVIEW_SURFACES)
    describe(name, () => {
      test("a reload puts the cursor back on its file and line, a removed line by its old number", async () => {
        const files = [added("a.ts", 6), changed];
        const review = await mount({ files });
        await review.click({ path: "c.ts", text: "c.ts new 4" });
        await review.reload();
        expect(review.cursorLine()).toMatchObject({
          path: "c.ts",
          old: null,
          new: 4,
          text: "c.ts new 4",
        });
        // A removed line has only its old number: that side is restored.
        await review.click({ path: "c.ts", text: "c.ts old 3" });
        expect(review.cursorLine()).toMatchObject({ old: 3, new: null });
        await review.reload();
        expect(review.cursorLine()).toMatchObject({
          path: "c.ts",
          old: 3,
          new: null,
          text: "c.ts old 3",
        });
        // In another file, on an unchanged line too.
        await review.click({ path: "c.ts", text: "c.ts 5" });
        await review.reload();
        expect(review.cursorLine()).toMatchObject({
          path: "c.ts",
          old: 5,
          new: 5,
        });
        await review.unmount();
        // Opened again later in the same browser: the same place.
        const again = await mount({ files, storage: "keep" });
        expect(again.cursorLine()).toMatchObject({ path: "c.ts", new: 5 });
        await again.unmount();
      });

      test("each review keeps its own place, as each repository of a series does", async () => {
        const first = await mount({
          files: [added("a.ts", 9)],
          sessionId: "a",
        });
        await first.press("5j");
        await first.unmount();
        const second = await mount({
          files: [added("b.ts", 9)],
          sessionId: "b",
          storage: "keep",
        });
        expect(second.cursorLine()?.text).toBe("b.ts line 1");
        await second.press("2j");
        await second.unmount();
        const firstAgain = await mount({
          files: [added("a.ts", 9)],
          sessionId: "a",
          storage: "keep",
        });
        expect(firstAgain.cursorLine()?.text).toBe("a.ts line 6");
        await firstAgain.unmount();
        const secondAgain = await mount({
          files: [added("b.ts", 9)],
          sessionId: "b",
          storage: "keep",
        });
        expect(secondAgain.cursorLine()?.text).toBe("b.ts line 3");
        await secondAgain.unmount();
      });

      test("the places of the last 50 reviews are kept, older ones forgotten", async () => {
        const files = [added("a.ts", 9)];
        // 51 reviews, each left on its own line.
        for (let index = 0; index < 51; index++) {
          const review = await mount({
            files,
            sessionId: `p${index}`,
            storage: index ? "keep" : {},
          });
          await review.press(`${1 + (index % 7)}j`);
          await review.unmount();
        }
        // The first one is forgotten: it opens on its first line.
        const oldest = await mount({ files, sessionId: "p0", storage: "keep" });
        expect(oldest.cursorLine()?.text).toBe("a.ts line 1");
        await oldest.unmount();
        // The next ones kept theirs (p0 opening again pushed out p1).
        for (const index of [2, 9, 50]) {
          const kept = await mount({
            files,
            sessionId: `p${index}`,
            storage: "keep",
          });
          expect(kept.cursorLine()?.text).toBe(`a.ts line ${2 + (index % 7)}`);
          await kept.unmount();
        }
        const pushedOut = await mount({
          files,
          sessionId: "p1",
          storage: "keep",
        });
        expect(pushedOut.cursorLine()?.text).toBe("a.ts line 1");
        await pushedOut.unmount();
      });

      test("damaged place and preferences in storage read as empty, and are written anew", async () => {
        const files = [added("a.ts", 9)];
        const review = await mount({
          files,
          storage: { reviewPlace: "{not json", reviewPrefs: "[1," },
        });
        expect(review.cursorLine()?.text).toBe("a.ts line 1");
        expect(review.sideBySide()).toBe(false);
        expect(review.filesShown()).toBe(true);
        await review.press("4j");
        await review.press("S");
        await review.reload();
        expect(review.cursorLine()?.text).toBe("a.ts line 5");
        expect(review.sideBySide()).toBe(true);
        await review.unmount();
        // A place store that is not a record of reviews: empty too.
        const listed = await mount({
          files,
          storage: { reviewPlace: "[]" },
        });
        expect(listed.cursorLine()?.text).toBe("a.ts line 1");
        await listed.unmount();
      });

      test("preferences stored as JSON that is no record (null) read as empty, and are written anew", async () => {
        const files = [added("a.ts", 9)];
        const review = await mount({
          files,
          storage: { reviewPrefs: "null" },
        });
        expect(review.cursorLine()?.text).toBe("a.ts line 1");
        expect(review.sideBySide()).toBe(false);
        expect(review.filesShown()).toBe(true);
        await review.press("S");
        await review.reload();
        expect(review.sideBySide()).toBe(true);
        await review.unmount();
      });

      test("side by side, the file list hidden and Vim off are remembered across a reload", async () => {
        const files = [added("a.ts", 4)];
        const review = await mount({ files });
        expect(review.sideBySide()).toBe(false);
        expect(review.filesShown()).toBe(true);
        await review.press("S");
        await review.press("f");
        expect(review.sideBySide()).toBe(true);
        expect(review.filesShown()).toBe(false);
        await review.reload();
        expect(review.sideBySide()).toBe(true);
        expect(review.filesShown()).toBe(false);
        await review.command(":files");
        await review.command(":diff");
        await review.reload();
        expect(review.sideBySide()).toBe(false);
        expect(review.filesShown()).toBe(true);

        // Vim on (the default): Esc in a comment leaves insert mode, the
        // editor stays.
        await review.press("c");
        expect(review.editorOpen()).toBe(true);
        await review.press("<Esc>");
        expect(review.editorOpen()).toBe(true);
        await review.press("<Esc>");
        expect(review.editorOpen()).toBe(false);
        await review.command(":novim");
        await review.reload();
        // Vim off, remembered: one Esc closes the comment.
        await review.press("c");
        expect(review.editorOpen()).toBe(true);
        await review.press("<Esc>");
        expect(review.editorOpen()).toBe(false);
        await review.command(":set vim");
        await review.reload();
        await review.press("c");
        await review.press("<Esc>");
        expect(review.editorOpen()).toBe(true);
        await review.unmount();
      });

      test("a review put away and shown again is exactly as it was: cursor, folds, comment being written", async () => {
        const review = await mount({
          files: [added("a.ts", 9), added("b.ts", 3)],
        });
        await review.press("3j");
        // The chunk of b.ts reviewed: it folds to one line.
        await review.goToFile("b.ts");
        await review.press("r");
        expect(review.fileReviewed("b.ts")).toBe(true);
        await review.click({ path: "a.ts", text: "a.ts line 4" });
        await review.press("c");
        await review.typeInEditor("half written");
        const drawn = review.lines();
        // The reviewed file is folded away, its lines not drawn.
        expect(drawn.some((line) => line.path === "b.ts")).toBe(false);
        await review.setHidden(true);
        expect(review.hasFocus()).toBe(false);
        await review.setHidden(false);
        expect(review.editorText()).toBe("half written");
        expect(review.cursorLine()?.text).toBe("a.ts line 4");
        expect(review.fileReviewed("b.ts")).toBe(true);
        expect(review.lines()).toEqual(drawn);
        await review.unmount();
      });

      test("shown, the review takes the keys, and takes them back from a terminal for 800 ms", async () => {
        const review = await mount({ files: [added("a.ts", 4)] });
        expect(review.hasFocus()).toBe(true);
        // A terminal (xterm) of the workspace arriving takes the focus.
        const terminal = document.createElement("div");
        terminal.className = "xterm";
        const input = document.createElement("textarea");
        terminal.append(input);
        document.body.append(terminal);
        const other = document.createElement("textarea");
        document.body.append(other);
        await review.setHidden(true);
        input.focus();
        expect(review.hasFocus()).toBe(false);
        jest.useFakeTimers();
        try {
          await review.setHidden(false);
          expect(review.hasFocus()).toBe(true);
          await review.advance(700);
          input.focus();
          expect(review.hasFocus()).toBe(true);
          // Anything but a terminal keeps the focus it took.
          other.focus();
          expect(review.hasFocus()).toBe(false);
          await review.setHidden(true);
          await review.setHidden(false);
          expect(review.hasFocus()).toBe(true);
          // Past 800 ms the terminal keeps it.
          await review.advance(800);
          input.focus();
          expect(review.hasFocus()).toBe(false);
        } finally {
          jest.useRealTimers();
          terminal.remove();
          other.remove();
          await review.unmount();
        }
      });
    });
}
