import { expect, test } from "bun:test";

/**
 * Voice arrival and the review, at the app level: a workspace voice chat
 * goes to shows its agent's chat, its review stepping aside until Option+R
 * (App.review.testkit.tsx).
 */
if (process.env.ROAMGATE_APP_REVIEW_VOICE_TEST !== "1") {
  test("voice arrival and the review, in an isolated DOM runtime", async () => {
    const child = Bun.spawn([process.execPath, "test", import.meta.path], {
      env: { ...process.env, ROAMGATE_APP_REVIEW_VOICE_TEST: "1" },
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
  await installAppReviewDom();

  test("arriving by voice in a workspace puts its review aside, once; Option+R brings it back", async () => {
    const { voiceArrives } = await import("./voiceArrival");
    const app = await mountAppWithReviews({
      reviews: [reviewOf("r1", "w1"), reviewOf("r2", "w2")],
    });
    try {
      await app.focusWorkspace("w2");
      app.setNextOpened("r2");
      await app.toggleReview();
      expect(app.shown().shownId).toBe("r2");
      await app.focusWorkspace("w1");
      expect(app.shown().shownId).toBe(null);
      // Voice chat goes to w2: its review steps aside, kept.
      voiceArrives("local", "w2");
      await app.focusWorkspace("w2");
      expect(app.shown()).toEqual({ mounted: ["r2"], shownId: null });
      await app.toggleReview();
      expect(app.shown().shownId).toBe("r2");
      expect(app.openCalls()).toBe(1);
      expect(app.mounts("r2")).toBe(1);
      // The arrival was taken: arriving again by hand shows the review.
      await app.focusWorkspace("w1");
      await app.focusWorkspace("w2");
      expect(app.shown().shownId).toBe("r2");
      // Voice going to another workspace leaves this one's review alone.
      await app.focusWorkspace("w1");
      voiceArrives("local", "w1");
      await app.focusWorkspace("w2");
      expect(app.shown().shownId).toBe("r2");
    } finally {
      await app.unmount();
    }
  });
}
