import { describe, expect, test } from "bun:test";

/**
 * Side by side in the review, at the behavior level: keys in, the line and
 * side with the cursor out. Runs against every review surface
 * (reviewSurfaces.testkit.ts).
 */
if (process.env.ROAMGATE_REVIEW_BEHAVIOR_DOM_TEST !== "1") {
  test("review side by side in an isolated DOM runtime", async () => {
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
  const { installReviewDom, file, hunk } = await import(
    "./reviewSurface.testkit"
  );
  await installReviewDom();
  const { REVIEW_SURFACES } = await import("./reviewSurfaces.testkit");

  /** Two lines replaced by three, between unchanged ones. */
  const replaced = () => [
    file(
      "a.ts",
      hunk(1, 1, [
        " top",
        "-old 1",
        "-old 2",
        "+new 1",
        "+new 2",
        "+new 3",
        " bottom",
      ]),
    ),
  ];

  for (const { name, mount } of REVIEW_SURFACES)
    describe(name, () => {
      test("side by side, j and k go line by line on their side", async () => {
        const review = await mount({ files: replaced(), split: true });
        expect(review.sideBySide()).toBe(true);
        const at = () => [review.cursorLine()?.text, review.cursorSide()];
        expect(at()).toEqual(["top", "both"]);
        await review.press("j");
        // The added side by default.
        expect(at()).toEqual(["new 1", "new"]);
        await review.press("j");
        expect(at()).toEqual(["new 2", "new"]);
        await review.press("j");
        expect(at()).toEqual(["new 3", "new"]);
        await review.press("j");
        expect(at()).toEqual(["bottom", "both"]);
        await review.press("3k");
        expect(at()).toEqual(["new 1", "new"]);
        await review.unmount();
      });

      test("Left and Right change side on a changed row; j and k then stay on that side", async () => {
        const review = await mount({ files: replaced(), split: true });
        const at = () => [review.cursorLine()?.text, review.cursorSide()];
        await review.press("j");
        expect(at()).toEqual(["new 1", "new"]);
        await review.press("<Left>");
        expect(at()).toEqual(["old 1", "old"]);
        await review.press("j");
        expect(at()).toEqual(["old 2", "old"]);
        // A drawn line without a removed line: the added one beside the gap.
        await review.press("j");
        expect(at()).toEqual(["new 3", "new"]);
        await review.press("j");
        expect(at()).toEqual(["bottom", "both"]);
        await review.press("2k");
        expect(at()).toEqual(["new 2", "new"]);
        await review.press("<Left>");
        expect(at()).toEqual(["old 2", "old"]);
        await review.press("k");
        expect(at()).toEqual(["old 1", "old"]);
        await review.press("<Right>");
        expect(at()).toEqual(["new 1", "new"]);
        // On a row with one side, Left stays there, and k goes on with
        // the side the cursor is on.
        await review.press("2j<Left>");
        expect(at()).toEqual(["new 3", "new"]);
        await review.press("k");
        expect(at()).toEqual(["new 2", "new"]);
        await review.unmount();
      });

      test("Left and Right move a character in a unified diff", async () => {
        const review = await mount({ files: replaced(), split: false });
        expect(review.sideBySide()).toBe(false);
        await review.press("j");
        expect(review.cursorSide()).toBeNull();
        expect(review.cursorLine()?.text).toBe("old 1");
        await review.press("<Right><Right><Right><Right>");
        expect(review.cursorWord()).toEqual({ start: 4, text: "1" });
        await review.press("<Left>");
        expect(review.cursorWord()).toEqual({ start: 3, text: " " });
        await review.unmount();
      });

      test("S and :split, :diff, :unified, :s switch between side by side and unified; the choice is kept", async () => {
        const review = await mount({ files: replaced(), split: false });
        const unified = review.lines().map((line) => line.text);
        expect(unified).toEqual([
          "top",
          "old 1",
          "old 2",
          "new 1",
          "new 2",
          "new 3",
          "bottom",
        ]);
        await review.press("S");
        expect(review.sideBySide()).toBe(true);
        // Removed and added lines face each other.
        expect(review.lines().map((line) => line.text)).toEqual([
          "top",
          "old 1",
          "new 1",
          "old 2",
          "new 2",
          "new 3",
          "bottom",
        ]);
        await review.press("S");
        expect(review.sideBySide()).toBe(false);
        for (const command of [":split", ":diff", ":unified", ":s"]) {
          const before = review.sideBySide();
          await review.command(command);
          expect(review.sideBySide()).toBe(!before);
        }
        // Remembered: the review opens the same way after a reload.
        await review.command(":split");
        expect(review.sideBySide()).toBe(true);
        await review.reload();
        expect(review.sideBySide()).toBe(true);
        await review.press("S");
        await review.reload();
        expect(review.sideBySide()).toBe(false);
        await review.unmount();
      });

      test("side by side by default in a window 1100 px wide or more, unified below", async () => {
        const wide = await mount({ files: replaced(), width: 1100 });
        expect(wide.sideBySide()).toBe(true);
        await wide.unmount();
        const narrow = await mount({ files: replaced(), width: 1099 });
        expect(narrow.sideBySide()).toBe(false);
        await narrow.unmount();
        // A remembered choice wins over the width.
        const kept = await mount({
          files: replaced(),
          width: 1400,
          split: false,
        });
        expect(kept.sideBySide()).toBe(false);
        await kept.unmount();
      });
    });
}
