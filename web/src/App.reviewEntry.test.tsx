import { expect, test } from "bun:test";

/**
 * Where reviews open from (plan: review into the inspector, phase 8): an
 * agent's `review_open` (and `/rg-review`, which raises the same request),
 * Commits' Review this commit, and the review stepping aside (Cmd+K, voice
 * arrival, Go to the agent's pane): the workspace's Changes.
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

  // Vim keys on, as the review's tests set them.
  const withVim = () => localStorage.setItem("reviewPrefs", "{}");
  localStorage.setItem("vimKeys", "true");

  test("an agent's review of the focused workspace shows in its Changes; of another, it waits pinned there while this one keeps its own", async () => {
    const app = await mountAppWithReviews({
      reviews: [reviewOf("r1", "w1"), reviewOf("r2", "w2")],
    });
    try {
      withVim();
      await app.agentOpens("r1");
      expect(app.inspector()).toMatchObject({ open: true, view: "changes" });
      expect(app.inspector()?.scope.workspaceId).toBe("w1");
      const own = app.inspectorGoTo();
      expect(own).toMatchObject({ scope: "working" });
      await app.agentOpens("r2");
      // Not here: w1 keeps its own.
      expect(app.inspector()).toMatchObject({ open: true, view: "changes" });
      expect(app.inspector()?.scope.workspaceId).toBe("w1");
      expect(app.inspectorGoTo()).toBe(own);
      await app.focusWorkspace("w2");
      await app.settle(50);
      expect(app.inspector()).toMatchObject({ open: true, view: "changes" });
      expect(app.inspector()?.scope.workspaceId).toBe("w2");
      expect(app.inspectorGoTo()).not.toBe(own);
      expect(app.inspectorGoTo()).toMatchObject({ scope: "working" });
      expect(app.shown()).toEqual({ mounted: [], shownId: null });
    } finally {
      await app.unmount();
    }
  });

  test("on reviewin=changes, an agent's review of the focused workspace opens its Changes on it, pinned there, never the classic pane", async () => {
    const app = await mountAppWithReviews({
      reviews: [reviewOf("r1", "w1")],
    });
    try {
      withVim();
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

  test("a pinned review whose code is gone lets go of its workspace: the toggle opens the workspace's own review again", async () => {
    const app = await mountAppWithReviews({
      reviews: [reviewOf("r1", "w1"), reviewOf("r2", "w2")],
    });
    try {
      withVim();
      await app.agentOpens("r1");
      await app.agentOpens("r2");
      expect(Object.values(app.changesPins()).sort()).toEqual(["r1", "r2"]);
      // r1's commits are gone (a root commit once reviewed as SHA^..SHA).
      await app.inspectorReviewGone("r1");
      expect(Object.values(app.changesPins())).toEqual(["r2"]);
      await app.toggleReview();
      expect(app.inspector()?.open).toBe(false);
      app.setNextOpened("r1");
      await app.toggleReview();
      await app.settle(50);
      // Not the pin: the workspace's review is looked for again.
      expect(app.openCalls()).toBe(1);
      expect(app.inspector()).toMatchObject({ open: true, view: "changes" });
    } finally {
      await app.unmount();
    }
  });

  test("on reviewin=changes, an agent's review of another workspace waits in that workspace's Changes, shown on arriving there", async () => {
    const app = await mountAppWithReviews({
      reviews: [reviewOf("r1", "w1"), reviewOf("r2", "w2")],
    });
    try {
      withVim();
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

  test("Review this commit: Changes' Branch scope on that commit, each time, never the commit's own review", async () => {
    const app = await mountAppWithReviews({
      reviews: [reviewOf("r1", "w1")],
    });
    try {
      // The inspector's Commits (opened through Changes).
      withVim();
      app.setNextOpened("r1");
      await app.toggleReview();
      await app.settle(50);
      await app.run(() => app.inspectorView("commits"));
      expect(app.inspector()).toMatchObject({ open: true, view: "commits" });
      await app.inspectorReviewCommit("abc123");
      expect(app.commitReviews()).toEqual([]);
      expect(app.inspector()).toMatchObject({ open: true, view: "changes" });
      expect(app.inspectorGoTo()).toMatchObject({
        scope: "branch-main",
        root: "",
        commit: "abc123",
      });
      // Back in Commits, another commit: the Branch scope on that one.
      await app.run(() => app.inspectorView("commits"));
      await app.inspectorReviewCommit("def456");
      expect(app.inspector()).toMatchObject({ open: true, view: "changes" });
      expect(app.inspectorGoTo()).toMatchObject({
        scope: "branch-main",
        root: "",
        commit: "def456",
      });
      expect(app.commitReviews()).toEqual([]);
      expect(app.shown()).toEqual({ mounted: [], shownId: null });
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
      withVim();
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
      withVim();
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
