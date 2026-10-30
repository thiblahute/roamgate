import { expect, test } from "bun:test";

/**
 * The review on a phone, at the app level: More options' Review opens and
 * closes it, as Option+R does on a desktop (App.review.testkit.tsx).
 */
if (process.env.ROAMGATE_APP_REVIEW_PHONE_TEST !== "1") {
  test("the review on a phone, in an isolated DOM runtime", async () => {
    const child = Bun.spawn([process.execPath, "test", import.meta.path], {
      env: { ...process.env, ROAMGATE_APP_REVIEW_PHONE_TEST: "1" },
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
  const { installAppReviewDom, mountAppWithReviews, reviewOf } = await import(
    "./App.review.testkit"
  );
  await installAppReviewDom("http://localhost/?layout=mobile");

  test("on a phone, More options' Review opens the review and closes the sheet; again, closes the review", async () => {
    const app = await mountAppWithReviews({
      reviews: [reviewOf("r1", "w1")],
    });
    try {
      const more = () =>
        app.container.querySelector<HTMLButtonElement>(
          'button[aria-label="More options"][aria-controls="mobile-more-options"]',
        )!;
      const review = () =>
        [
          ...app.container.querySelectorAll<HTMLButtonElement>(
            '[aria-label="Workspace view switcher"] button',
          ),
        ].find((button) => button.textContent === "Review")!;
      expect(more()).not.toBeNull();
      await app.click(more());
      expect(more().getAttribute("aria-expanded")).toBe("true");
      expect(review().getAttribute("aria-label")).toBe("Review this branch");
      expect(review().getAttribute("aria-pressed")).toBe("false");
      app.setNextOpened("r1");
      await app.click(review());
      expect(app.shown().shownId).toBe("r1");
      expect(more().getAttribute("aria-expanded")).toBe("false");
      expect(review().getAttribute("aria-label")).toBe("Close the review");
      expect(review().getAttribute("aria-pressed")).toBe("true");
      await app.click(more());
      await app.click(review());
      expect(app.shown()).toEqual({ mounted: ["r1"], shownId: null });
      expect(app.openCalls()).toBe(1);
    } finally {
      await app.unmount();
    }
  });
}
