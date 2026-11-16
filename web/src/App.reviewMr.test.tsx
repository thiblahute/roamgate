import { expect, spyOn, test } from "bun:test";

/**
 * A request's review (the reviews inbox) and Files, at the app level: gf
 * from it asks the bridge to check out the review worktree first when the
 * checkout follows on demand, and says so when local changes refuse it
 * (App.review.testkit.tsx).
 */
if (process.env.ROAMGATE_APP_REVIEW_MR_TEST !== "1") {
  test("gf from a request's review, in an isolated DOM runtime", async () => {
    const child = Bun.spawn([process.execPath, "test", import.meta.path], {
      env: { ...process.env, ROAMGATE_APP_REVIEW_MR_TEST: "1" },
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

  test("gf in Changes on an inbox request's review checks out its review worktree first; local changes refuse it, with a notice", async () => {
    const { mock } = await import("bun:test");
    /** The checkout setting, the inbox, and what the bridge was asked. */
    const bridge = {
      checkout: "on_demand",
      answer: { state: "done", head: "abc" } as Record<string, unknown>,
      calls: [] as { method: string; params: unknown }[],
    };
    const app = await mountAppWithReviews({
      reviews: [reviewOf("r1", "w1"), reviewOf("r2", "w2")],
      before: async () => {
        const real = await import("./mrReviews");
        mock.module("./mrReviews", () => ({
          ...real,
          latestMrInbox: () => ({
            entries: [
              {
                key: "gitlab:group/project!7",
                review: {
                  connectionId: "local",
                  workspaceId: "w1",
                  sessionId: "r1",
                },
              },
            ],
          }),
          loadMrReviewsSettings: async () => ({ checkout: bridge.checkout }),
          mrReviewsCall: async (method: string, params: unknown) => {
            bridge.calls.push({ method, params });
            return bridge.answer;
          },
        }));
      },
    });
    const { store } = await import("./store");
    const notices: string[] = [];
    const notify = spyOn(store, "notify").mockImplementation((notice) => {
      notices.push(notice.message);
      return "" as never;
    });
    try {
      /** Changes' gf on a changed file, at a line. */
      const gf = (path: string, line: number) =>
        app.run(() => app.inspectorProps().onOpenDiffFile({ path }, { line }));
      app.setNextOpened("r1");
      await app.toggleReview();
      await app.settle(50);
      await gf("src/a.ts", 12);
      await app.settle(50);
      expect(bridge.calls).toEqual([
        {
          method: "checkout",
          params: { key: "gitlab:group/project!7", local: "refuse" },
        },
      ]);
      expect(notices).toEqual([]);
      expect(app.inspector()).toMatchObject({ open: true, view: "files" });
      expect(app.inspectorFile()).toMatchObject({ line: 12 });

      // Local changes in the worktree: nothing touched, the user is told.
      bridge.answer = { state: "dirty", changes: ["a.ts"] };
      await app.toggleReview();
      await app.settle(50);
      await gf("src/a.ts", 3);
      await app.settle(50);
      expect(bridge.calls).toHaveLength(2);
      expect(notices).toEqual(["The review worktree has local changes"]);

      // Checked out at once (not on demand): nothing asked.
      bridge.checkout = "immediately";
      await app.toggleReview();
      await app.settle(50);
      await gf("src/a.ts", 4);
      await app.settle(50);
      expect(bridge.calls).toHaveLength(2);

      // A workspace with no request's review: nothing asked either.
      bridge.checkout = "on_demand";
      await app.focusWorkspace("w2");
      app.setNextOpened("r2");
      await app.toggleReview();
      await app.settle(50);
      expect(app.inspector()?.scope.workspaceId).toBe("w2");
      await gf("src/b.ts", 1);
      await app.settle(50);
      expect(bridge.calls).toHaveLength(2);
    } finally {
      notify.mockRestore();
      await app.unmount();
    }
  });
}
