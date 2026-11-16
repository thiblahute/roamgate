import { expect, test } from "bun:test";

/**
 * Where reviews open from (plan: review into the inspector, phase 8): an
 * agent's `review_open` (and `/rg-review`, which raises the same request),
 * Commits' Review this commit, and the review stepping aside (Cmd+K, voice
 * arrival, Go to the agent's pane) on both switch settings: the classic
 * pane on "classic", the workspace's Changes on "in Changes".
 */
if (process.env.ROAMGATE_APP_REVIEW_TEST !== "1") {
  test("where reviews open from, in an isolated DOM runtime", async () => {
    const child = Bun.spawn([process.execPath, "test", import.meta.path], {
      env: { ...process.env, ROAMGATE_APP_REVIEW_TEST: "1" },
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
  }, 60_000);
} else {
  const { installAppReviewDom, mountAppWithReviews, reviewOf } = await import(
    "./App.review.testkit"
  );
  await installAppReviewDom();

  const inChanges = () =>
    localStorage.setItem(
      "reviewPrefs",
      JSON.stringify({ reviewIn: "changes", vim: true }),
    );

  test("on reviewin=classic, an agent's review of the focused workspace shows in the review pane; of another, it waits pinned there", async () => {
    const app = await mountAppWithReviews({
      reviews: [reviewOf("r1", "w1"), reviewOf("r2", "w2")],
    });
    try {
      await app.agentOpens("r1");
      expect(app.shown().shownId).toBe("r1");
      expect(app.inspector()?.open ?? false).toBe(false);
      await app.agentOpens("r2");
      // Not here: w1 keeps its own.
      expect(app.shown().shownId).toBe("r1");
      await app.focusWorkspace("w2");
      expect(app.shown().shownId).toBe("r2");
    } finally {
      await app.unmount();
    }
  });

  test("on reviewin=changes, an agent's review of the focused workspace opens its Changes on it, pinned there, never the classic pane", async () => {
    const app = await mountAppWithReviews({
      reviews: [reviewOf("r1", "w1")],
    });
    try {
      inChanges();
      await app.agentOpens("r1");
      // Never mounted in the classic pane.
      expect(app.shown()).toEqual({ mounted: [], shownId: null });
      expect(app.inspector()).toMatchObject({
        open: true,
        view: "changes",
        expanded: true,
      });
      expect(app.inspector()?.scope.workspaceId).toBe("w1");
      expect(app.inspectorGoTo()).toMatchObject({ scope: "working" });
      // Pinned as the classic pane pins it: the toggle comes back to it
      // without looking for another.
      await app.toggleReview();
      expect(app.inspector()?.open).toBe(false);
      await app.toggleReview();
      await app.settle(50);
      expect(app.inspector()).toMatchObject({ open: true, view: "changes" });
      expect(app.openCalls()).toBe(0);
      expect(app.shown().shownId).toBe(null);
    } finally {
      await app.unmount();
    }
  });

  test("on reviewin=changes, an agent's review of another workspace waits in that workspace's Changes, shown on arriving there", async () => {
    const app = await mountAppWithReviews({
      reviews: [reviewOf("r1", "w1"), reviewOf("r2", "w2")],
    });
    try {
      inChanges();
      await app.agentOpens("r2");
      // Nothing moves here.
      expect(app.inspector()?.open ?? false).toBe(false);
      expect(app.shown().shownId).toBe(null);
      await app.focusWorkspace("w2");
      await app.settle(50);
      expect(app.inspector()).toMatchObject({ open: true, view: "changes" });
      expect(app.inspector()?.scope.workspaceId).toBe("w2");
      expect(app.inspectorGoTo()).toMatchObject({ scope: "working" });
      expect(app.shown().shownId).toBe(null);
      expect(app.openCalls()).toBe(0);
      // Once: arriving again leaves Changes as it was left.
      await app.toggleReview();
      expect(app.inspector()?.open).toBe(false);
      await app.focusWorkspace("w1");
      await app.focusWorkspace("w2");
      await app.settle(50);
      expect(app.inspector()?.open ?? false).toBe(false);
    } finally {
      await app.unmount();
    }
  });

  test("Review this commit: on reviewin=changes, Changes' Branch scope on that commit; on classic, the commit's review in the pane", async () => {
    const app = await mountAppWithReviews({
      reviews: [reviewOf("r1", "w1")],
    });
    try {
      // The inspector's Commits (opened through Changes).
      inChanges();
      app.setNextOpened("r1");
      await app.toggleReview();
      await app.settle(50);
      await app.run(() => app.inspectorView("commits"));
      expect(app.inspector()).toMatchObject({ open: true, view: "commits" });
      // Classic: the commit's own review, in the review pane.
      const { writeReviewPrefs } = await import("./reviewPrefs");
      writeReviewPrefs({ reviewIn: "classic" });
      await app.inspectorReviewCommit("abc123");
      expect(app.commitReviews()).toEqual(["abc123"]);
      expect(app.shown().shownId).toBe("commit-abc123");
      await app.run(() => app.host().onClose());
      expect(app.shown().shownId).toBe(null);
      // In Changes: the Branch scope, at that commit, on the checkout.
      writeReviewPrefs({ reviewIn: "changes" });
      await app.inspectorReviewCommit("def456");
      expect(app.inspector()).toMatchObject({ open: true, view: "changes" });
      expect(app.inspectorGoTo()).toMatchObject({
        scope: "branch-main",
        root: "",
        commit: "def456",
      });
      expect(app.commitReviews()).toEqual(["abc123"]);
      expect(app.shown().shownId).toBe(null);
    } finally {
      await app.unmount();
    }
  });

  test("on reviewin=changes, Cmd+K collapses an expanded Changes and leaves a docked one; Option+R expands it again", async () => {
    const { COMMAND_MENU_OPENING } = await import(
      "./components/CommandCombobox"
    );
    const app = await mountAppWithReviews({
      reviews: [reviewOf("r1", "w1")],
    });
    try {
      inChanges();
      app.setNextOpened("r1");
      await app.toggleReview();
      await app.settle(50);
      expect(app.inspector()).toMatchObject({
        view: "changes",
        expanded: true,
      });
      window.dispatchEvent(new Event(COMMAND_MENU_OPENING));
      await app.settle();
      // Kept, docked: the terminals show.
      expect(app.inspector()).toMatchObject({
        open: true,
        view: "changes",
        expanded: false,
      });
      // The keys went elsewhere (the menu): the toggle shows it again,
      // expanded.
      (document.activeElement as HTMLElement | null)?.blur();
      await app.toggleReview();
      await app.settle(50);
      expect(app.inspector()).toMatchObject({
        open: true,
        view: "changes",
        expanded: true,
      });
      // Docked by hand: Cmd+K leaves it as it is.
      await app.run(() => app.inspectorExpand(false));
      window.dispatchEvent(new Event(COMMAND_MENU_OPENING));
      await app.settle();
      expect(app.inspector()).toMatchObject({
        open: true,
        view: "changes",
        expanded: false,
      });
      expect(app.shown().shownId).toBe(null);
    } finally {
      await app.unmount();
    }
  });

  test("on reviewin=changes, arriving by voice in a workspace collapses its expanded Changes, once", async () => {
    const { voiceArrives } = await import("./voiceArrival");
    const app = await mountAppWithReviews({
      reviews: [reviewOf("r1", "w1"), reviewOf("r2", "w2")],
    });
    try {
      inChanges();
      await app.focusWorkspace("w2");
      app.setNextOpened("r2");
      await app.toggleReview();
      await app.settle(50);
      expect(app.inspector()).toMatchObject({
        view: "changes",
        expanded: true,
      });
      await app.focusWorkspace("w1");
      voiceArrives("local", "w2");
      await app.focusWorkspace("w2");
      await app.settle(50);
      expect(app.inspector()?.scope.workspaceId).toBe("w2");
      expect(app.inspector()).toMatchObject({
        open: true,
        view: "changes",
        expanded: false,
      });
      expect(app.shown().shownId).toBe(null);
    } finally {
      await app.unmount();
    }
  });
}
