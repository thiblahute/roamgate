import { describe, expect, test } from "bun:test";

/**
 * The review on a phone, a touch screen and a narrow window, and Review
 * only, at the behavior level: what shows, the Esc button Vim needs, the
 * phone's Back. Runs against every review surface
 * (reviewSurfaces.testkit.ts).
 */
if (process.env.ROAMGATE_REVIEW_BEHAVIOR_DOM_TEST !== "1") {
  test("review on phones and touch screens in an isolated DOM runtime", async () => {
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
  const changed = file("a.ts", hunk(1, 1, ["-old", "+new", " same"]));

  for (const { name, mount } of REVIEW_SURFACES)
    describe(name, () => {
      test("a phone-wide window opens unified; nothing forces it, a remembered side by side stays", async () => {
        const phone = await mount({ files: [changed], width: 390 });
        expect(phone.sideBySide()).toBe(false);
        await phone.press("S");
        expect(phone.sideBySide()).toBe(true);
        await phone.unmount();
        const remembered = await mount({
          files: [changed],
          width: 390,
          split: true,
        });
        expect(remembered.sideBySide()).toBe(true);
        await remembered.unmount();
      });

      test("the file list is hidden in a window 800 px wide or less", async () => {
        const narrow = await mount({
          files: [added("a.ts", 2)],
          width: 800,
          styles: true,
        });
        expect(narrow.filesShown()).toBe(false);
        await narrow.unmount();
        const wide = await mount({
          files: [added("a.ts", 2)],
          width: 801,
          styles: true,
        });
        expect(wide.filesShown()).toBe(true);
        await wide.unmount();
      });

      test("Close stays in reach while the head scrolls, in a window 1100 px wide or less", async () => {
        const narrow = await mount({
          files: [added("a.ts", 2)],
          width: 1100,
          styles: true,
        });
        expect(narrow.control("Close")?.sticky).toBe(true);
        await narrow.unmount();
        const wide = await mount({
          files: [added("a.ts", 2)],
          width: 1101,
          styles: true,
        });
        expect(wide.control("Close")?.sticky).toBe(false);
        await wide.unmount();
      });

      test("on a touch screen, Review only's controls are 40 px touch targets", async () => {
        const touch = await mount({
          files: [added("a.ts", 2)],
          coarse: true,
          styles: true,
        });
        expect(touch.control("Show all")?.minHeight).toBe(40);
        expect(touch.control("Close the review")?.minHeight).toBe(40);
        await touch.unmount();
        const mouse = await mount({
          files: [added("a.ts", 2)],
          styles: true,
        });
        expect(mouse.control("Show all")?.minHeight).toBe(28);
        await mouse.unmount();
      });

      test("o and :only show the diff only; o or Esc bring the rest back, then Esc closes", async () => {
        const review = await mount({
          files: [added("a.ts", 4)],
          width: 1200,
          styles: true,
        });
        expect(review.chromeShown()).toBe(true);
        await review.press("o");
        expect(review.chromeShown()).toBe(false);
        await review.press("o");
        expect(review.chromeShown()).toBe(true);
        await review.command(":only");
        expect(review.chromeShown()).toBe(false);
        // Esc first leaves Review only, then closes.
        await review.press("<Esc>");
        expect(review.chromeShown()).toBe(true);
        expect(review.closes()).toBe(0);
        await review.press("o");
        expect(review.chromeShown()).toBe(false);
        expect(review.control("Show all")).not.toBeNull();
        expect(review.cursorLine()?.text).toBe("a.ts line 1");
        await review.press("<Esc>");
        expect(review.closes()).toBe(0);
        await review.press("<Esc>");
        expect(review.closes()).toBe(1);
        await review.unmount();
      });

      test("on a touch screen with Vim, the comment editor has an Esc button: Vim's normal mode, then closed", async () => {
        const touch = await mount({ files: [added("a.ts", 2)], coarse: true });
        await touch.press("c");
        expect(touch.editorOpen()).toBe(true);
        expect(touch.editorButtons()).toContain("Esc");
        await touch.editorButton("Esc");
        expect(touch.editorOpen()).toBe(true);
        await touch.editorButton("Esc");
        expect(touch.editorOpen()).toBe(false);
        // Without Vim, no Esc button.
        await touch.command(":novim");
        await touch.press("c");
        expect(touch.editorOpen()).toBe(true);
        expect(touch.editorButtons()).not.toContain("Esc");
        await touch.unmount();
        // With a mouse, none either.
        const mouse = await mount({ files: [added("a.ts", 2)] });
        await mouse.press("c");
        expect(mouse.editorOpen()).toBe(true);
        expect(mouse.editorButtons()).not.toContain("Esc");
        await mouse.unmount();
      });

      test("the phone's Back closes the conversations, then the review", async () => {
        const review = await mount({
          files: [added("a.ts", 2)],
          width: 390,
          phone: true,
        });
        await review.press("T");
        expect(review.conversationsShown()).toBe(true);
        await review.systemBack();
        expect(review.conversationsShown()).toBe(false);
        expect(review.closes()).toBe(0);
        await review.systemBack();
        expect(review.closes()).toBe(1);
        await review.unmount();
      });
    });
}
