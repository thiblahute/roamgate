import { describe, expect, test } from "bun:test";

/**
 * The review's Vim cursor and motions, at the behavior level: keys in, the
 * line with the cursor out. Runs against every review surface
 * (reviewSurfaces.testkit.ts).
 */
if (process.env.ROAMGATE_REVIEW_BEHAVIOR_DOM_TEST !== "1") {
  test("review cursor and motions in an isolated DOM runtime", async () => {
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
  const { reviewSurfacesWith } = await import("./reviewSurfaces.testkit");

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

  for (const surface of reviewSurfacesWith("cursor"))
    describe(surface.name, () => {
      const { mount } = surface;
      test("j and k move a line, Down and Up too; a count moves that many", async () => {
        const review = await mount({ files: [added("a.ts", 12)] });
        const at = () => review.cursorLine()?.text;
        expect(at()).toBe("a.ts line 1");
        await review.press("j");
        expect(at()).toBe("a.ts line 2");
        await review.press("5j");
        expect(at()).toBe("a.ts line 7");
        await review.press("3k");
        expect(at()).toBe("a.ts line 4");
        await review.press("<Down><Down>");
        expect(at()).toBe("a.ts line 6");
        await review.press("<Up>");
        expect(at()).toBe("a.ts line 5");
        // Past the last line, it stays on it.
        await review.press("20j");
        expect(at()).toBe("a.ts line 12");
        await review.press("k");
        expect(at()).toBe("a.ts line 11");
        await review.unmount();
      });

      test("J and K move ten lines", async () => {
        const review = await mount({ files: [added("a.ts", 30)] });
        const at = () => review.cursorLine()?.text;
        await review.press("J");
        expect(at()).toBe("a.ts line 11");
        await review.press("J");
        expect(at()).toBe("a.ts line 21");
        await review.press("K");
        expect(at()).toBe("a.ts line 11");
        await review.press("2J");
        expect(at()).toBe("a.ts line 30");
        await review.unmount();
      });

      test("gg and G, Home and End go to the first and last line; 12G and :12 to row 12 of the whole review", async () => {
        const review = await mount({
          files: [added("a.ts", 8), added("b.ts", 8)],
        });
        const at = () => review.cursorLine();
        await review.press("G");
        expect(at()).toMatchObject({ path: "b.ts", text: "b.ts line 8" });
        await review.press("gg");
        expect(at()).toMatchObject({ path: "a.ts", text: "a.ts line 1" });
        await review.press("<End>");
        expect(at()?.text).toBe("b.ts line 8");
        await review.press("<Home>");
        expect(at()?.text).toBe("a.ts line 1");
        // Rows of the whole review, across its files.
        await review.press("12G");
        expect(at()).toMatchObject({ path: "b.ts", text: "b.ts line 4" });
        await review.press("3gg");
        expect(at()?.text).toBe("a.ts line 3");
        await review.command(":10");
        expect(at()).toMatchObject({ path: "b.ts", text: "b.ts line 2" });
        await review.command(":1");
        expect(at()?.text).toBe("a.ts line 1");
        // Past the end, the last line.
        await review.press("99G");
        expect(at()?.text).toBe("b.ts line 8");
        await review.unmount();
      });

      test("a Visual selection keeps 12G and j inside the file it started in", async () => {
        const review = await mount({
          files: [added("a.ts", 8), added("b.ts", 8)],
        });
        await review.press("2jV");
        expect(review.selection().map((line) => line.text)).toEqual([
          "a.ts line 3",
        ]);
        await review.press("12G");
        expect(review.cursorLine()?.text).toBe("a.ts line 8");
        await review.press("j");
        expect(review.cursorLine()?.text).toBe("a.ts line 8");
        expect(review.selection().map((line) => line.text)).toEqual(
          numbered("a.ts line", 6, 3),
        );
        await review.press("<Esc>");
        expect(review.selection()).toEqual([]);
        await review.press("j");
        expect(review.cursorLine()?.text).toBe("b.ts line 1");
        await review.unmount();
      });

      test("} and { go to the next and previous hunk, ] and [ to the next and previous file", async () => {
        const review = await mount({
          files: [
            file(
              "a.ts",
              hunk(1, 1, [" a 1", "-a 2", "+a two", " a 3"]),
              hunk(20, 20, [" a 20", "+a 21", " a 22"]),
            ),
            file("b.ts", hunk(5, 5, [" b 5", "+b 6"])),
            file("c.ts", hunk(1, 1, ["+c 1"])),
          ],
        });
        const at = () => review.cursorLine()?.text;
        expect(at()).toBe("a 1");
        await review.press("}");
        expect(at()).toBe("a 20");
        await review.press("}");
        expect(at()).toBe("b 5");
        await review.press("{");
        expect(at()).toBe("a 20");
        await review.press("2{");
        expect(at()).toBe("a 1");
        await review.press("2}");
        expect(at()).toBe("b 5");
        await review.press("]");
        expect(review.cursorLine()).toMatchObject({
          path: "c.ts",
          text: "c 1",
        });
        await review.press("2[");
        expect(review.cursorLine()).toMatchObject({
          path: "a.ts",
          text: "a 1",
        });
        await review.press("]j");
        expect(at()).toBe("b 6");
        await review.press("[");
        expect(at()).toBe("a 1");
        await review.unmount();
      });

      test("w, b and E go word to word, across lines, skipping symbols and blank lines", async () => {
        const review = await mount({
          files: [
            file(
              "a.ts",
              hunk(1, 1, [
                "+const value = compute(first);",
                "+",
                "+  // ---",
                "+  return value;",
              ]),
            ),
          ],
        });
        const word = () => review.cursorWord();
        expect(word()).toEqual({ start: 0, text: "const" });
        await review.press("w");
        expect(word()).toEqual({ start: 6, text: "value" });
        await review.press("2w");
        expect(word()).toEqual({ start: 22, text: "first" });
        // The blank and symbol-only lines are skipped.
        await review.press("w");
        expect(review.cursorLine()?.text).toBe("  return value;");
        expect(word()).toEqual({ start: 2, text: "return" });
        await review.press("b");
        expect(review.cursorLine()?.text).toBe("const value = compute(first);");
        expect(word()).toEqual({ start: 22, text: "first" });
        await review.press("B");
        expect(word()).toEqual({ start: 14, text: "compute" });
        await review.press("W");
        expect(word()).toEqual({ start: 22, text: "first" });
        // E goes to the end of the word: the same word stays under it.
        await review.press("0E");
        expect(word()).toEqual({ start: 0, text: "const" });
        await review.press("E");
        expect(word()).toEqual({ start: 6, text: "value" });
        await review.unmount();
      });

      test("h and l move a character; 0, ^ and $ to the line's start, first character and end", async () => {
        const review = await mount({
          files: [file("a.ts", hunk(1, 1, ["+  x y z", "+p q"]))],
        });
        const word = () => review.cursorWord();
        // A blank under the cursor shows as itself.
        expect(word()).toEqual({ start: 0, text: " " });
        await review.press("^");
        expect(word()).toEqual({ start: 2, text: "x" });
        await review.press("l");
        expect(word()).toEqual({ start: 3, text: " " });
        await review.press("2l");
        expect(word()).toEqual({ start: 5, text: " " });
        await review.press("$");
        expect(word()).toEqual({ start: 6, text: "z" });
        await review.press("3h");
        expect(word()).toEqual({ start: 3, text: " " });
        await review.press("0");
        expect(word()).toEqual({ start: 0, text: " " });
        // The column is kept, within the line, going to another one.
        await review.press("$j");
        expect(review.cursorLine()?.text).toBe("p q");
        expect(word()).toEqual({ start: 2, text: "q" });
        await review.unmount();
      });

      test("Files' Review puts the cursor on that file's line", async () => {
        const review = await mount({
          files: [
            added("a.ts", 4),
            file(
              "b.ts",
              hunk(8, 8, [" eight", "-nine", "+neuf", " ten", " eleven"]),
            ),
          ],
        });
        expect(review.cursorLine()?.path).toBe("a.ts");
        await review.goToFile("b.ts", 10);
        expect(review.cursorLine()).toMatchObject({
          path: "b.ts",
          new: 10,
          text: "ten",
        });
        await review.unmount();
      });

      test("the cursor's word is drawn on its line, and only there", async () => {
        const review = await mount({
          files: [file("a.ts", hunk(1, 1, ["+alpha beta", "+gamma delta"]))],
        });
        expect(review.cursorWord()).toEqual({ start: 0, text: "alpha" });
        await review.press("wj");
        expect(review.cursorLine()?.text).toBe("gamma delta");
        expect(review.cursorWord()).toEqual({ start: 6, text: "delta" });
        await review.press("k");
        expect(review.cursorWord()).toEqual({ start: 6, text: "beta" });
        await review.unmount();
      });
    });
}
