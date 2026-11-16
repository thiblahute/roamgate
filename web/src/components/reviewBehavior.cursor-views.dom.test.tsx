import { describe, expect, test } from "bun:test";

/**
 * The review's commits as views, at the behavior level: what is marked
 * reviewed in one view shows in the others. Runs against every review
 * surface (reviewSurfaces.testkit.ts).
 */
if (process.env.ROAMGATE_REVIEW_BEHAVIOR_DOM_TEST !== "1") {
  test("review views in an isolated DOM runtime", async () => {
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

  for (const { name, mount } of reviewSurfacesWith("commits", "reviewed"))
    describe(name, () => {
      test("a chunk marked reviewed in one commit shows reviewed in all the changes, and back", async () => {
        const a = file(
          "a.ts",
          hunk(1, 1, ["+a first", "+a second"]),
          hunk(20, 22, ["+a third"]),
        );
        const b = added("b.ts", 3);
        const review = await mount({
          files: [a, b],
          commits: [
            { sha: "a".repeat(40), subject: "First", files: [a] },
            { sha: "b".repeat(40), subject: "Second", files: [b] },
          ],
        });
        const kinds = (path: string) =>
          review.lines(path).map((line) => line.kind);
        expect(review.view()).toBe("1/2 aaaaaaaa First");
        await review.goToFile("a.ts");
        await review.press("r");
        expect(kinds("a.ts")).toEqual(["reviewed", "+"]);
        expect(review.chunkProgress("a.ts")).toBe("1/2");
        // All the changes: the same chunk, reviewed; the rest not.
        await review.press("<");
        expect(review.view()).toBe("All changes 2 commits");
        expect(kinds("a.ts")).toEqual(["reviewed", "+"]);
        expect(review.chunkProgress("a.ts")).toBe("1/2");
        expect(review.fileReviewed("b.ts")).toBe(false);
        expect(kinds("b.ts")).toEqual(["+", "+", "+"]);
        // Marked here, it shows in its commit.
        await review.goToFile("b.ts");
        await review.press("<A-v>");
        expect(review.fileReviewed("b.ts")).toBe(true);
        await review.press("<");
        expect(review.view()).toBe("2/2 bbbbbbbb Second");
        expect(review.fileReviewed("b.ts")).toBe(true);
        // And after a reload.
        await review.reload();
        expect(review.fileReviewed("b.ts")).toBe(true);
        await review.unmount();
      });
    });

  for (const { name, mount } of reviewSurfacesWith("commits", "expand"))
    describe(name, () => {
      test("a commit's message is drawn whole: no gap row offers more lines of it", async () => {
        const a = added("a.ts", 2);
        const review = await mount({
          files: [a],
          commits: [
            { sha: "a".repeat(40), subject: "One line", files: [a] },
            { sha: "b".repeat(40), subject: "Other", files: [a] },
          ],
        });
        expect(review.view()).toBe("1/2 aaaaaaaa One line");
        expect(review.gaps(":commit-message")).toEqual([]);
        await review.unmount();
      });

      test("side by side, a commit's message is drawn once, in one column; the cursor and a comment work on it", async () => {
        const a = added("a.ts", 2);
        const review = await mount({
          split: true,
          files: [a],
          commits: [
            { sha: "a".repeat(40), subject: "One line", files: [a] },
            { sha: "b".repeat(40), subject: "Other", files: [a] },
          ],
        });
        expect(review.view()).toBe("1/2 aaaaaaaa One line");
        expect(review.fileColumns("a.ts")).toBe(2);
        // Not on both sides: the message is words, not a change.
        expect(review.fileColumns(":commit-message")).toBe(1);
        await review.press("gg");
        expect(review.cursorLine()).toMatchObject({
          path: ":commit-message",
          text: "One line",
        });
        await review.press("j");
        expect(review.cursorLine()?.path).toBe("a.ts");
        await review.press("k");
        expect(review.cursorLine()?.path).toBe(":commit-message");
        await review.press("c");
        await review.type("Say why");
        await review.editorPress("<C-Enter>");
        expect(review.calls("review.thread.add")[0]?.params).toMatchObject({
          anchor: { path: ":commit-message", line: 1, text: "One line" },
          text: "Say why",
        });
        expect(review.commentTexts().join("\n")).toContain("Say why");
        await review.unmount();
      });
    });
}
