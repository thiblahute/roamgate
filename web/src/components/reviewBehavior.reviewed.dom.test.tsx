import { describe, expect, test } from "bun:test";

/**
 * Reviewed chunks and files, at the behavior level: keys in, what is folded,
 * ticked and remembered out. Runs against every review surface
 * (reviewSurfaces.testkit.ts).
 */
if (process.env.ROAMGATE_REVIEW_BEHAVIOR_DOM_TEST !== "1") {
  test("review reviewed chunks in an isolated DOM runtime", async () => {
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
  const { REVIEW_SURFACES } = await import("./reviewSurfaces.testkit");

  /** a.ts: two chunks; b.ts and c.ts: one each. */
  const files = () => [
    file(
      "a.ts",
      hunk(1, 1, [" a 1", "+a 2", "+a 3", " a 4"]),
      hunk(20, 22, [" a 22", "-a 23", "+a twenty-three", " a 24"]),
    ),
    file("b.ts", hunk(1, 1, ["+b 1", "+b 2"])),
    file("c.ts", hunk(1, 1, ["+c 1"])),
  ];
  const texts = (review: { lines(path?: string): { text: string }[] }) =>
    review.lines().map((line) => line.text);

  for (const { name, mount } of REVIEW_SURFACES)
    describe(name, () => {
      test("v marks the file under the cursor reviewed, every chunk folded with it; v again unmarks it", async () => {
        const review = await mount({ files: files() });
        expect(review.fileReviewed("a.ts")).toBe(false);
        await review.press("v");
        expect(review.fileReviewed("a.ts")).toBe(true);
        expect(review.reviewedMarks()["all:a.ts"]).toBeTruthy();
        expect(texts(review)).not.toContain("a 2");
        expect(texts(review)).not.toContain("a twenty-three");
        expect(review.text()).toContain("✓ reviewed");
        // The cursor goes on to what is left to review.
        expect(review.cursorLine()?.path).toBe("b.ts");
        // Folded whole: gg goes to the first line left to review.
        await review.press("gg");
        expect(review.cursorLine()?.path).toBe("b.ts");
        // Picked in the file list, it shows, and v unmarks it.
        await review.goToFile("a.ts");
        expect(review.cursorLine()?.path).toBe("a.ts");
        await review.press("v");
        expect(review.fileReviewed("a.ts")).toBe(false);
        expect(review.reviewedMarks()["all:a.ts"]).toBe("");
        expect(texts(review)).toContain("a 2");
        await review.unmount();
      });

      test("V then r marks every chunk the selection touches reviewed", async () => {
        const review = await mount({ files: files() });
        // From the first chunk of a.ts to its second.
        await review.press("jV}j");
        expect(review.selection().map((line) => line.text)).toEqual([
          "a 2",
          "a 3",
          "a 4",
          "a 22",
          "a 23",
        ]);
        await review.press("r");
        expect(review.selection()).toEqual([]);
        // Both chunks: the file is reviewed.
        expect(review.fileReviewed("a.ts")).toBe(true);
        expect(texts(review)).not.toContain("a 2");
        expect(texts(review)).not.toContain("a twenty-three");
        expect(review.fileReviewed("b.ts")).toBe(false);
        await review.unmount();
      });

      test("V then r on part of a file marks its chunk, and the list counts it", async () => {
        const review = await mount({ files: files() });
        await review.press("jVj");
        await review.press("r");
        expect(review.fileReviewed("a.ts")).toBe(false);
        expect(review.chunkProgress("a.ts")).toBe("1/2");
        expect(texts(review)).not.toContain("a 3");
        expect(texts(review)).toContain("a twenty-three");
        await review.unmount();
      });

      test("a reviewed chunk shows again on a click or za, and za folds it back", async () => {
        const review = await mount({ files: files() });
        await review.press("r");
        const folded = () =>
          review.lines("a.ts").filter((line) => line.kind === "reviewed");
        expect(folded()).toHaveLength(1);
        expect(texts(review)).not.toContain("a 3");
        // The cursor went on to the next chunk; back on the folded one.
        await review.press("gg");
        expect(review.cursorLine()?.kind).toBe("reviewed");
        await review.press("za");
        expect(texts(review)).toContain("a 3");
        expect(folded()).toHaveLength(0);
        // Still reviewed: shown, not unmarked.
        expect(review.chunkProgress("a.ts")).toBe("1/2");
        await review.press("za");
        expect(texts(review)).not.toContain("a 3");
        await review.click({ path: "a.ts", kind: "reviewed" });
        expect(texts(review)).toContain("a 3");
        expect(review.chunkProgress("a.ts")).toBe("1/2");
        await review.unmount();
      });

      test("a chunk with comments stays open when reviewed", async () => {
        const review = await mount({
          files: files(),
          threads: [thread("t1", "a.ts", 3, "Why a 3?")],
        });
        expect(review.text()).toContain("Why a 3?");
        // r on a line with a thread resolves it: mark from the chunk's
        // first line.
        await review.press("j");
        expect(review.cursorLine()?.text).toBe("a 2");
        await review.press("r");
        expect(review.chunkProgress("a.ts")).toBe("1/2");
        expect(texts(review)).toContain("a 2");
        expect(texts(review)).toContain("a 3");
        expect(review.text()).toContain("Why a 3?");
        expect(
          review.lines("a.ts").filter((line) => line.kind === "reviewed"),
        ).toHaveLength(0);
        await review.unmount();
      });

      test("reviewed chunks and files are ticked and counted in the file list", async () => {
        const review = await mount({ files: files() });
        expect(review.chunkProgress("a.ts")).toBeNull();
        expect(review.text()).toContain("0/3 reviewed");
        await review.press("r");
        expect(review.chunkProgress("a.ts")).toBe("1/2");
        expect(review.fileReviewed("a.ts")).toBe(false);
        await review.press("r");
        // Whole: ticked, no count.
        expect(review.fileReviewed("a.ts")).toBe(true);
        expect(review.chunkProgress("a.ts")).toBeNull();
        expect(review.text()).toContain("1/3 reviewed");
        await review.press("<A-v>");
        expect(review.fileReviewed("b.ts")).toBe(true);
        expect(review.text()).toContain("2/3 reviewed");
        await review.unmount();
      });

      test("reviewed marks are kept across a reload", async () => {
        const review = await mount({ files: files() });
        await review.press("r");
        await review.press("]]v");
        expect(review.fileReviewed("c.ts")).toBe(true);
        const marks = review.reviewedMarks();
        await review.reload();
        expect(review.reviewedMarks()).toEqual(marks);
        expect(review.chunkProgress("a.ts")).toBe("1/2");
        expect(review.fileReviewed("c.ts")).toBe(true);
        expect(texts(review)).not.toContain("a 3");
        expect(texts(review)).not.toContain("c 1");
        // A new review opened with those marks shows the same.
        await review.unmount();
        const again = await mount({ files: files(), reviewed: marks });
        expect(again.chunkProgress("a.ts")).toBe("1/2");
        expect(again.fileReviewed("c.ts")).toBe(true);
        expect(texts(again)).not.toContain("a 3");
        await again.unmount();
      });
    });
}
