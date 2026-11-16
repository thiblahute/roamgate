import { expect, test } from "bun:test";

/**
 * Voice arrival and the review, at the app level: a workspace voice chat
 * goes to shows its agent's chat, its review's expanded Changes docking
 * until Option+R (App.review.testkit.tsx).
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

  test("arriving by voice in a workspace docks the review's expanded Changes, once; Option+R expands it again", async () => {
    const { voiceArrives } = await import("./voiceArrival");
    const app = await mountAppWithReviews({
      reviews: [reviewOf("r1", "w1"), reviewOf("r2", "w2")],
    });
    const changes = (expanded: boolean) => {
      expect(app.inspector()?.scope.workspaceId).toBe("w2");
      expect(app.inspector()).toMatchObject({
        open: true,
        view: "changes",
        expanded,
      });
    };
    try {
      await app.focusWorkspace("w2");
      app.setNextOpened("r2");
      await app.toggleReview();
      await app.settle(50);
      changes(true);
      await app.focusWorkspace("w1");
      // Voice chat goes to w2: its review steps aside, kept.
      voiceArrives("local", "w2");
      await app.focusWorkspace("w2");
      await app.settle(50);
      changes(false);
      // The agent's chat has the keys.
      (document.activeElement as HTMLElement | null)?.blur();
      await app.toggleReview();
      await app.settle(50);
      changes(true);
      expect(app.inspectorGoTo()).toMatchObject({ scope: "working" });
      // The arrival was taken: arriving again by hand leaves it as left.
      await app.focusWorkspace("w1");
      await app.focusWorkspace("w2");
      await app.settle(50);
      changes(true);
      // Voice going to another workspace leaves this one's review alone.
      await app.focusWorkspace("w1");
      voiceArrives("local", "w1");
      await app.focusWorkspace("w2");
      await app.settle(50);
      changes(true);
      expect(app.shown()).toEqual({ mounted: [], shownId: null });
    } finally {
      await app.unmount();
    }
  });
}
