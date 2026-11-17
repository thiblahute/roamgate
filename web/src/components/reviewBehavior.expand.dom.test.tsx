import { describe, expect, test } from "bun:test";

/**
 * Context expansion around hunks, at the behavior level: keys and gap
 * buttons in, the lines shown out. Runs against every review surface
 * (reviewSurfaces.testkit.ts).
 */
if (process.env.ROAMGATE_REVIEW_BEHAVIOR_DOM_TEST !== "1") {
  test("review context expansion in an isolated DOM runtime", async () => {
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
  const { installReviewDom, file, hunk, thread } = await import(
    "./reviewSurface.testkit"
  );
  await installReviewDom();
  const { reviewSurfacesWith } = await import("./reviewSurfaces.testkit");

  /**
   * A 100-line file with line 31 and line 71 changed: hidden lines 1-29
   * above the first hunk, 33-69 between the hunks, 73-100 after the last.
   */
  const lines = Array.from({ length: 100 }, (_, i) =>
    i === 30
      ? "line thirty-one"
      : i === 70
        ? "line seventy-one"
        : `line ${i + 1}`,
  );
  const options = () => ({
    files: [
      file(
        "a.ts",
        hunk(30, 30, [" line 30", "-line 31", "+line thirty-one", " line 32"]),
        hunk(70, 70, [" line 70", "-line 71", "+line seventy-one", " line 72"]),
      ),
    ],
    texts: { "a.ts": `${lines.join("\n")}\n` },
  });
  /** The new-side numbers of the unchanged lines shown. */
  const shown = (review: {
    lines(path?: string): { new: number | null; kind: string }[];
  }) =>
    review
      .lines("a.ts")
      .filter((line) => line.kind === " ")
      .map((line) => line.new!);
  /** The unchanged lines from `from` to `to` (31 and 71 are changed). */
  const range = (from: number, to: number) =>
    Array.from({ length: to - from + 1 }, (_, i) => from + i).filter(
      (n) => n !== 31 && n !== 71,
    );

  for (const { name, mount } of reviewSurfacesWith("expand"))
    describe(name, () => {
      test("gap buttons sit between hunks and at the file's ends, and show 20 lines or all of them", async () => {
        const review = await mount(options());
        expect(shown(review)).toEqual([30, 32, 70, 72]);
        expect(review.gaps("a.ts")).toEqual([
          { label: "29 hidden lines", buttons: ["Show all 29", "↑ 20"] },
          {
            label: "37 hidden lines",
            buttons: ["↓ 20", "Show all 37", "↑ 20"],
          },
          { label: "more lines", buttons: ["↓ 20", "Show the rest"] },
        ]);
        // Between the hunks: 20 below the hunk above, then 20 above the one
        // below, which shows the whole gap and joins the hunks.
        await review.expandGap("a.ts", 1, "↓ 20");
        expect(shown(review)).toEqual([30, 32, ...range(33, 52), 70, 72]);
        expect(review.gaps("a.ts")[1]?.label).toBe("17 hidden lines");
        await review.expandGap("a.ts", 1, "↑ 20");
        expect(shown(review)).toEqual([30, 32, ...range(33, 69), 70, 72]);
        expect(review.gaps("a.ts")).toHaveLength(2);
        // Above the first hunk, all; then after the last.
        await review.expandGap("a.ts", 0, "Show all 29");
        expect(shown(review).slice(0, 30)).toEqual(range(1, 30));
        // The file read, the end's gap knows its size.
        expect(review.gaps("a.ts")).toEqual([
          { label: "28 hidden lines", buttons: ["↓ 20", "Show all 28"] },
        ]);
        await review.expandGap("a.ts", 0, "Show all 28");
        expect(shown(review)).toEqual(range(1, 100));
        expect(review.gaps("a.ts")).toEqual([]);
        await review.unmount();
      });

      test("side by side, each gap row is one row across both sides; in one column, in it", async () => {
        const review = await mount({ ...options(), split: true });
        expect(review.sideBySide()).toBe(true);
        expect(review.gapRows("a.ts")).toEqual(["across", "across", "across"]);
        // Its buttons still show the lines.
        await review.expandGap("a.ts", 1, "↓ 20");
        expect(review.gaps("a.ts")[1]?.label).toBe("17 hidden lines");
        expect(review.gapRows("a.ts")).toEqual(["across", "across", "across"]);
        await review.unmount();
        // A comment under that row: the gap stays on the new side, under
        // it, not drawn over it.
        const commented = await mount({
          ...options(),
          split: true,
          threads: [
            {
              id: "t1",
              sessionId: "s1",
              kind: "draft",
              anchor: { path: "a.ts", line: 32, side: "new", text: "line 32" },
              comments: [
                {
                  id: "t1c",
                  author: "you",
                  body: "Here",
                  createdAt: "2026-11-04T14:11:18Z",
                  updatedAt: "2026-11-04T14:11:18Z",
                },
              ],
              resolved: false,
              createdAt: "2026-11-04T14:11:18Z",
              updatedAt: "2026-11-04T14:11:18Z",
            } as unknown as import("../../../shared/review").ReviewThread,
          ],
        });
        expect(commented.commentTexts().join("\n")).toContain("Here");
        expect(commented.gapRows("a.ts")).toEqual([
          "across",
          "new side",
          "across",
        ]);
        await commented.unmount();
        const unified = await mount({ ...options(), split: false });
        expect(unified.sideBySide()).toBe(false);
        expect(unified.gapRows("a.ts")).toEqual(["one", "one", "one"]);
        await unified.unmount();
      });

      test("zo and x show 20 more lines on both sides of the hunk under the cursor", async () => {
        const review = await mount(options());
        await review.press("zo");
        expect(shown(review)).toEqual([
          ...range(10, 30),
          ...range(32, 52),
          70,
          72,
        ]);
        // The cursor stays on its line.
        expect(review.cursorLine()?.text).toBe("line 30");
        await review.press("x");
        expect(shown(review)).toEqual([...range(1, 30), ...range(32, 72)]);
        expect(review.cursorLine()?.text).toBe("line 30");
        // A count asks for that many times 20.
        await review.press("G2x");
        expect(shown(review)).toEqual([
          ...range(1, 30),
          ...range(32, 70),
          ...range(72, 100),
        ]);
        await review.unmount();
      });

      test("zO and X show every hidden line around the hunk; on the last hunk, the rest of the file", async () => {
        const review = await mount(options());
        await review.press("zO");
        expect(shown(review)).toEqual([...range(1, 30), ...range(32, 72)]);
        await review.unmount();
        const last = await mount(options());
        await last.press("G");
        expect(last.cursorLine()?.text).toBe("line 72");
        await last.press("zO");
        expect(shown(last)).toEqual([30, ...range(32, 70), ...range(72, 100)]);
        expect(last.cursorLine()?.text).toBe("line 72");
        await last.unmount();
        const big = await mount(options());
        await big.press("}X");
        expect(shown(big)).toEqual([30, ...range(32, 70), ...range(72, 100)]);
        await big.unmount();
      });

      test("zR shows the whole file", async () => {
        const review = await mount(options());
        await review.press("}zR");
        expect(shown(review)).toEqual(range(1, 100));
        expect(review.gaps("a.ts")).toEqual([]);
        expect(review.cursorLine()?.text).toBe("line 70");
        await review.unmount();
      });

      test("a thread on an unchanged line between hunks shows on its line: the nearer hunk grows to three lines past it", async () => {
        const review = await mount({
          ...options(),
          threads: [thread("t1", "a.ts", 50, "What about line 50?")],
        });
        expect(review.text()).toContain("What about line 50?");
        // Nearer the hunk above: it grows down to line 53.
        expect(shown(review)).toEqual([30, ...range(32, 53), 70, 72]);
        await review.unmount();
        const below = await mount({
          ...options(),
          threads: [thread("t2", "a.ts", 60, "And line 60?")],
        });
        expect(below.text()).toContain("And line 60?");
        // Nearer the hunk below: it grows up from line 57.
        expect(shown(below)).toEqual([30, 32, ...range(57, 70), 72]);
        await below.unmount();
      });
    });
}
