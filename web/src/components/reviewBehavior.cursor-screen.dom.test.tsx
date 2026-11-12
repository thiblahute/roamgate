import { describe, expect, test } from "bun:test";

/**
 * The review's screen motions, at the behavior level: page keys, H M L and
 * zz zt zb on a screen of a known height, keys in, the cursor line and the
 * lines on the screen out. Runs against every review surface
 * (reviewSurfaces.testkit.ts).
 */
if (process.env.ROAMGATE_REVIEW_BEHAVIOR_DOM_TEST !== "1") {
  test("review screen motions in an isolated DOM runtime", async () => {
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
      test("Ctrl-d and Ctrl-u move half a screen", async () => {
        // A screen of 11 lines: half of it is 5.
        const review = await mount({
          files: [added("a.ts", 60)],
          viewport: 11,
        });
        const at = () => review.cursorLine()?.text;
        expect(at()).toBe("a.ts line 1");
        await review.press("<C-d>");
        expect(at()).toBe("a.ts line 6");
        await review.press("<C-d>");
        expect(at()).toBe("a.ts line 11");
        await review.press("<C-u>");
        expect(at()).toBe("a.ts line 6");
        // The cursor line is centred on the screen after each.
        await review.press("<C-d><C-d><C-d>");
        expect(at()).toBe("a.ts line 21");
        expect(review.screenLines()[5]?.text).toBe("a.ts line 21");
        // At the top, it stops on the first line.
        await review.press("<C-u><C-u><C-u><C-u><C-u><C-u>");
        expect(at()).toBe("a.ts line 1");
        await review.unmount();
      });

      test("Ctrl-f and Ctrl-b, Ctrl-j and Ctrl-k, PageDown and PageUp move a screen", async () => {
        const review = await mount({
          files: [added("a.ts", 60)],
          viewport: 11,
        });
        const at = () => review.cursorLine()?.text;
        // A screen is twice half of it: 10 lines on a screen of 11.
        await review.press("<C-f>");
        expect(at()).toBe("a.ts line 11");
        await review.press("<C-j>");
        expect(at()).toBe("a.ts line 21");
        await review.press("<PageDown>");
        expect(at()).toBe("a.ts line 31");
        await review.press("<C-b>");
        expect(at()).toBe("a.ts line 21");
        await review.press("<C-k>");
        expect(at()).toBe("a.ts line 11");
        await review.press("<PageUp>");
        expect(at()).toBe("a.ts line 1");
        // Past the end, the last line.
        await review.press("<C-f><C-f><C-f><C-f><C-f><C-f><C-f>");
        expect(at()).toBe("a.ts line 60");
        await review.unmount();
      });

      test("Ctrl-e and Ctrl-y move the cursor a line, the screen following it", async () => {
        // Today they move the cursor (as j / k), not the screen alone.
        const review = await mount({
          files: [added("a.ts", 60)],
          viewport: 11,
        });
        const at = () => review.cursorLine()?.text;
        await review.press("20G");
        expect(at()).toBe("a.ts line 20");
        expect(review.screenLines()[5]?.text).toBe("a.ts line 20");
        await review.press("<C-e>");
        expect(at()).toBe("a.ts line 21");
        expect(review.screenLines()[5]?.text).toBe("a.ts line 21");
        await review.press("<C-y><C-y>");
        expect(at()).toBe("a.ts line 19");
        expect(review.screenLines()[5]?.text).toBe("a.ts line 19");
        await review.unmount();
      });

      test("H, M and L go to the top, middle and bottom line of the screen; a count from the top or bottom", async () => {
        const review = await mount({
          files: [added("a.ts", 60)],
          viewport: 11,
        });
        const at = () => review.cursorLine()?.text;
        // Line 30 centred: lines 25 to 35 on the screen.
        await review.press("30G");
        expect(review.screenLines().map((line) => line.text)).toEqual(
          numbered("a.ts line", 11, 25),
        );
        await review.press("H");
        expect(at()).toBe("a.ts line 25");
        await review.press("L");
        expect(at()).toBe("a.ts line 35");
        await review.press("M");
        expect(at()).toBe("a.ts line 30");
        await review.press("3H");
        expect(at()).toBe("a.ts line 27");
        await review.press("2L");
        expect(at()).toBe("a.ts line 34");
        // The screen did not move.
        expect(review.screenLines()[0]?.text).toBe("a.ts line 25");
        await review.unmount();
      });

      test("zt, zz (and z.) and zb put the cursor line at the top, middle and bottom of the screen", async () => {
        const review = await mount({
          files: [added("a.ts", 60)],
          viewport: 11,
        });
        const screen = () => review.screenLines().map((line) => line.text);
        await review.press("30G");
        await review.press("zt");
        expect(screen()[0]).toBe("a.ts line 30");
        await review.press("zb");
        expect(screen()[10]).toBe("a.ts line 30");
        await review.press("zz");
        expect(screen()[5]).toBe("a.ts line 30");
        await review.press("zt");
        await review.press("z.");
        expect(screen()[5]).toBe("a.ts line 30");
        // The cursor stays on its line.
        expect(review.cursorLine()?.text).toBe("a.ts line 30");
        // j moves the screen only once the cursor reaches its edge.
        await review.press("zt");
        await review.press("5j");
        expect(screen()[0]).toBe("a.ts line 30");
        await review.unmount();
      });
    });
}
