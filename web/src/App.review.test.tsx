import { expect, jest, test } from "bun:test";

/**
 * The review at the app level, in the workspace's Changes: Option+R, the
 * reviews list, Changes kept while the review is away, Cmd+K and Go to
 * agent's pane putting it aside, the code preload. App is mounted with a
 * stub inspector (App.review.testkit.tsx); what a review draws is the
 * behavior tests'.
 */
if (process.env.ROAMGATE_APP_REVIEW_TEST !== "1") {
  test("the review at the app level, in an isolated DOM runtime", async () => {
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
  }, 30_000);
} else {
  const { installAppReviewDom, mountAppWithReviews, reviewOf } = await import(
    "./App.review.testkit"
  );
  await installAppReviewDom();

  test("Option+R shows the workspace's review in its Changes, and hides it again; again, the same review", async () => {
    const app = await mountAppWithReviews({
      reviews: [reviewOf("r1", "w1")],
    });
    try {
      expect(app.shown()).toEqual({ mounted: [], shownId: null });
      expect(app.inspector()?.open ?? false).toBe(false);
      app.setNextOpened("r1");
      await app.toggleReview();
      await app.settle(50);
      // The workspace's review is found (or made) once.
      expect(app.openCalls()).toBe(1);
      expect(app.inspector()).toMatchObject({ open: true, view: "changes" });
      expect(app.inspector()?.scope.workspaceId).toBe("w1");
      expect(app.inspectorGoTo()).toMatchObject({ scope: "working" });
      await app.toggleReview();
      expect(app.inspector()?.open).toBe(false);
      // Again: the same review, picked as Option+R picks it (the one shown
      // there last); Changes pins only an agent's.
      await app.toggleReview();
      await app.settle(50);
      expect(app.openCalls()).toBe(2);
      expect(app.inspector()).toMatchObject({ open: true, view: "changes" });
      expect(app.inspectorGoTo()).toMatchObject({ scope: "working" });
      expect(app.shown()).toEqual({ mounted: [], shownId: null });
    } finally {
      await app.unmount();
    }
  });

  test("closing the review in Changes (Esc, :q) goes back to what the inspector showed; Option+R brings it back, and closed stays closed across workspaces", async () => {
    const app = await mountAppWithReviews({
      reviews: [reviewOf("r1", "w1")],
    });
    try {
      app.setNextOpened("r1");
      await app.toggleReview();
      await app.settle(50);
      expect(app.inspector()).toMatchObject({ open: true, view: "changes" });
      // Its own close (Esc, :q) closes it as Option+R does.
      await app.run(() => app.inspectorProps().onCloseReview?.("escape"));
      expect(app.inspector()?.open).toBe(false);
      await app.toggleReview();
      await app.settle(50);
      expect(app.inspector()).toMatchObject({ open: true, view: "changes" });
      expect(app.inspectorGoTo()).toMatchObject({ scope: "working" });
      // Another workspace and back: Changes kept, shown again.
      await app.focusWorkspace("w2");
      await app.focusWorkspace("w1");
      await app.settle(50);
      expect(app.inspector()).toMatchObject({ open: true, view: "changes" });
      expect(app.inspector()?.scope.workspaceId).toBe("w1");
      // Closed stays closed across workspace changes, until Option+R.
      (document.activeElement as HTMLElement | null)?.blur();
      await app.run(() => app.inspectorProps().onCloseReview?.("command"));
      await app.focusWorkspace("w2");
      await app.focusWorkspace("w1");
      await app.settle(50);
      expect(app.inspector()?.open ?? false).toBe(false);
      expect(app.openCalls()).toBe(2);
      expect(app.shown()).toEqual({ mounted: [], shownId: null });
    } finally {
      await app.unmount();
    }
  });

  test("Option+Shift+R opens the reviews list over the review in Changes, which is still there once it closes", async () => {
    const app = await mountAppWithReviews({
      reviews: [reviewOf("r1", "w1")],
    });
    try {
      // With no review shown, it opens the list.
      await app.toggleList();
      expect(app.listShown()).toBe(true);
      await app.toggleList();
      expect(app.listShown()).toBe(false);
      app.setNextOpened("r1");
      await app.toggleReview();
      await app.settle(50);
      await app.toggleList();
      expect(app.listShown()).toBe(true);
      // The review stays in Changes, under the list.
      expect(app.inspector()).toMatchObject({ open: true, view: "changes" });
      await app.closeList();
      expect(app.listShown()).toBe(false);
      expect(app.inspector()).toMatchObject({ open: true, view: "changes" });
      expect(app.inspectorGoTo()).toMatchObject({ scope: "working" });
      // Changes' own way to the list (:reviews) does the same.
      await app.run(() => app.inspectorProps().onShowReviews?.());
      expect(app.listShown()).toBe(true);
      expect(app.inspector()).toMatchObject({ open: true, view: "changes" });
      expect(app.shown()).toEqual({ mounted: [], shownId: null });
    } finally {
      await app.unmount();
    }
  });

  test("the tab bar's Review opens and closes the review in Changes as Option+R does, with no open state of its own", async () => {
    const app = await mountAppWithReviews({
      reviews: [reviewOf("r1", "w1")],
    });
    try {
      const button = app.tabBarReview()!;
      expect(button).not.toBeNull();
      expect(button.getAttribute("aria-expanded")).toBe("false");
      expect(button.title).toStartWith("Review this branch");
      app.setNextOpened("r1");
      await app.click(button);
      await app.settle(50);
      expect(app.inspector()).toMatchObject({ open: true, view: "changes" });
      // Changes is the review: the button says nothing of it.
      expect(app.tabBarReview()!.getAttribute("aria-expanded")).toBe("false");
      expect(app.tabBarReview()!.title).toStartWith("Review this branch");
      await app.click(app.tabBarReview()!);
      expect(app.inspector()?.open).toBe(false);
      expect(app.tabBarReview()!.getAttribute("aria-expanded")).toBe("false");
      expect(app.shown()).toEqual({ mounted: [], shownId: null });
    } finally {
      await app.unmount();
    }
  });

  test("Cmd+K docks the review's expanded Changes and closes the reviews list; Option+R expands it again, a workspace change leaves it docked", async () => {
    const { COMMAND_MENU_OPENING } = await import(
      "./components/CommandCombobox"
    );
    const app = await mountAppWithReviews({
      reviews: [reviewOf("r1", "w1")],
    });
    try {
      app.setNextOpened("r1");
      await app.toggleReview();
      await app.settle(50);
      // The command menu says it opens; the review steps aside, kept.
      window.dispatchEvent(new Event(COMMAND_MENU_OPENING));
      await app.settle();
      expect(app.inspector()).toMatchObject({
        open: true,
        view: "changes",
        expanded: false,
      });
      (document.activeElement as HTMLElement | null)?.blur();
      await app.toggleReview();
      await app.settle(50);
      expect(app.inspector()).toMatchObject({
        open: true,
        view: "changes",
        expanded: true,
      });
      expect(app.inspectorGoTo()).toMatchObject({ scope: "working" });
      // It also closes the reviews list.
      await app.toggleList();
      expect(app.listShown()).toBe(true);
      window.dispatchEvent(new Event(COMMAND_MENU_OPENING));
      await app.settle();
      expect(app.listShown()).toBe(false);
      expect(app.inspector()).toMatchObject({
        open: true,
        view: "changes",
        expanded: false,
      });
      // A workspace change and back: Changes as it was left, docked.
      await app.focusWorkspace("w2");
      await app.focusWorkspace("w1");
      await app.settle(50);
      expect(app.inspector()).toMatchObject({
        open: true,
        view: "changes",
        expanded: false,
      });
      expect(app.shown()).toEqual({ mounted: [], shownId: null });
    } finally {
      await app.unmount();
    }
  });

  test("Changes' Go to agent's pane docks the review and focuses the pane; Option+R expands it again", async () => {
    const app = await mountAppWithReviews({
      reviews: [reviewOf("r1", "w1")],
    });
    try {
      app.setNextOpened("r1");
      await app.toggleReview();
      await app.settle(50);
      await app.run(() => app.inspectorProps().onFocusAgentPane?.("a"));
      expect(app.focusedPanes()).toEqual(["a"]);
      expect(app.inspector()).toMatchObject({
        open: true,
        view: "changes",
        expanded: false,
      });
      // The pane has the keys now.
      (document.activeElement as HTMLElement | null)?.blur();
      await app.toggleReview();
      await app.settle(50);
      expect(app.inspector()).toMatchObject({
        open: true,
        view: "changes",
        expanded: true,
      });
      expect(app.inspectorGoTo()).toMatchObject({ scope: "working" });
      expect(app.shown()).toEqual({ mounted: [], shownId: null });
    } finally {
      await app.unmount();
    }
  });

  test("gf in Changes opens the file at its line in Files; Option+R brings the review back in Changes", async () => {
    const app = await mountAppWithReviews({
      reviews: [reviewOf("r1", "w1")],
    });
    try {
      app.setNextOpened("r1");
      await app.toggleReview();
      await app.settle(50);
      await app.run(() =>
        app.inspectorProps().onOpenDiffFile({ path: "src/a.ts" }, { line: 12 }),
      );
      const inspector = app.inspector();
      expect(inspector).toMatchObject({ open: true, view: "files" });
      expect(inspector?.scope.workspaceId).toBe("w1");
      expect(app.inspectorFile()).toMatchObject({
        entry: { path: "src/a.ts", type: "file" },
        line: 12,
      });
      await app.toggleReview();
      await app.settle(50);
      expect(app.inspector()).toMatchObject({ open: true, view: "changes" });
      expect(app.inspectorGoTo()).toMatchObject({ scope: "working" });
      expect(app.shown()).toEqual({ mounted: [], shownId: null });
    } finally {
      await app.unmount();
    }
  });

  test("on reviewin=changes, Option+R opens Changes expanded and focused, and goes back to what the inspector showed", async () => {
    const app = await mountAppWithReviews({
      reviews: [reviewOf("r1", "w1")],
    });
    try {
      localStorage.setItem("reviewPrefs", "{}");
      localStorage.setItem("vimKeys", "true");
      app.setNextOpened("r1");
      // Inspector closed: the toggle opens Changes, expanded the first time,
      // on the review the classic toggle would show (its uncommitted work:
      // the Working scope).
      await app.toggleReview();
      await app.settle(50);
      expect(app.openCalls()).toBe(1);
      expect(app.inspectorGoTo()).toMatchObject({ scope: "working" });
      expect(app.shown()).toEqual({ mounted: [], shownId: null });
      expect(app.inspector()).toMatchObject({
        open: true,
        view: "changes",
        expanded: true,
      });
      expect(app.inspector()?.scope.workspaceId).toBe("w1");
      // Again: closed, as it was.
      await app.toggleReview();
      expect(app.inspector()).toMatchObject({ open: false, expanded: false });
      // From Files, docked: Changes at its own size, then back to Files.
      await app.toggleReview();
      await app.settle(50);
      await app.run(() => app.inspectorView("files"));
      expect(app.inspector()).toMatchObject({ open: true, view: "files" });
      expect(app.inspector()?.expanded).toBe(false);
      await app.toggleReview();
      await app.settle(50);
      expect(app.inspector()).toMatchObject({
        open: true,
        view: "changes",
        expanded: true,
      });
      await app.toggleReview();
      expect(app.inspector()).toMatchObject({
        open: true,
        view: "files",
        expanded: false,
      });
      // The tab bar's Review does the same.
      const button = app.tabBarReview();
      expect(button).not.toBeNull();
      await app.click(button!);
      await app.settle(50);
      expect(app.inspector()).toMatchObject({ view: "changes" });
      await app.click(button!);
      expect(app.inspector()).toMatchObject({ view: "files" });
      expect(app.shown()).toEqual({ mounted: [], shownId: null });
    } finally {
      await app.unmount();
    }
  });

  test("on reviewin=changes, Changes opened by hand is not the review: the toggle shows the review there, then goes back with the keys", async () => {
    const app = await mountAppWithReviews({
      reviews: [reviewOf("r1", "w1")],
    });
    try {
      localStorage.setItem("reviewPrefs", "{}");
      localStorage.setItem("vimKeys", "true");
      app.setNextOpened("r1");
      // Leave the inspector docked on Changes, opened by hand.
      await app.toggleReview();
      await app.settle(50);
      await app.toggleReview();
      await app.settle(50);
      await app.run(() => app.inspectorView("changes"));
      await app.run(() => app.inspectorExpand(false));
      const terminal = document.createElement("div");
      terminal.tabIndex = 0;
      document.body.append(terminal);
      terminal.focus();
      expect(app.inspector()).toMatchObject({
        open: true,
        view: "changes",
        expanded: false,
      });
      // Every press does something: the review, expanded, with the keys.
      await app.toggleReview();
      await app.settle(50);
      expect(app.inspector()).toMatchObject({
        open: true,
        view: "changes",
        expanded: true,
      });
      expect(app.inspectorGoTo()).toMatchObject({ scope: "working" });
      expect(
        document.activeElement?.classList.contains("diff-content-view"),
      ).toBe(true);
      // The keys away from it (a click), the toggle takes them back to the
      // review.
      terminal.dispatchEvent(new Event("pointerdown", { bubbles: true }));
      terminal.focus();
      await app.toggleReview();
      await app.settle(50);
      expect(app.inspector()).toMatchObject({ open: true, expanded: true });
      expect(
        document.activeElement?.classList.contains("diff-content-view"),
      ).toBe(true);
      // With the keys: back to Changes as it was, the keys where they were.
      await app.toggleReview();
      await app.settle(50);
      expect(app.inspector()).toMatchObject({
        open: true,
        view: "changes",
        expanded: false,
      });
      expect(document.activeElement).toBe(terminal);
      terminal.remove();
    } finally {
      await app.unmount();
    }
  });

  test("on reviewin=changes with :novim, Option+R still gives the review's diff the keys: only the comment editor is plain", async () => {
    const app = await mountAppWithReviews({
      reviews: [reviewOf("r1", "w1")],
    });
    try {
      localStorage.setItem("reviewPrefs", "{}");
      localStorage.setItem("vimKeys", "false");
      app.setNextOpened("r1");
      const terminal = document.createElement("div");
      terminal.tabIndex = 0;
      document.body.append(terminal);
      terminal.focus();
      await app.toggleReview();
      await app.settle(50);
      expect(app.inspector()).toMatchObject({
        open: true,
        view: "changes",
        expanded: true,
      });
      expect(
        document.activeElement?.classList.contains("diff-content-view"),
      ).toBe(true);
      terminal.remove();
    } finally {
      await app.unmount();
    }
  });

  test("on reviewin=changes, Files' Review opens Changes at that file and line, not the classic pane", async () => {
    const app = await mountAppWithReviews({
      reviews: [reviewOf("r1", "w1")],
    });
    try {
      localStorage.setItem("reviewPrefs", "{}");
      localStorage.setItem("vimKeys", "true");
      app.setNextOpened("r1");
      await app.toggleReview();
      await app.settle(50);
      await app.run(() => app.inspectorView("files"));
      const opened = app.openCalls();
      await app.run(() => app.inspectorShowInReview("/repo/r1/src/a.ts", 12));
      expect(app.openCalls()).toBe(opened);
      expect(app.shown()).toEqual({ mounted: [], shownId: null });
      expect(app.inspector()).toMatchObject({ open: true, view: "changes" });
      expect(app.inspectorGoTo()).toMatchObject({
        path: "/repo/r1/src/a.ts",
        line: 12,
      });
      // Pressed again on Changes, Review goes to the new line, Changes stays.
      await app.run(() => app.inspectorShowInReview("/repo/r1/src/a.ts", 3));
      expect(app.inspector()).toMatchObject({ open: true, view: "changes" });
      expect(app.inspectorGoTo()).toMatchObject({ line: 3 });
    } finally {
      await app.unmount();
    }
  });

  test("on reviewin=changes, a workspace with several repositories shows the review's in Changes, which switches between them", async () => {
    const app = await mountAppWithReviews({
      reviews: [reviewOf("r1", "w1")],
    });
    try {
      localStorage.setItem("reviewPrefs", "{}");
      localStorage.setItem("vimKeys", "true");
      app.setNextOpened("r1");
      app.setRepos(["/repo/r1", "/repo/other"]);
      await app.toggleReview();
      await app.settle(50);
      expect(app.shown()).toEqual({ mounted: [], shownId: null });
      expect(app.inspector()).toMatchObject({ open: true, view: "changes" });
      expect(app.inspectorGoTo()).toMatchObject({ scope: "working" });
      expect(
        app.notices().some((text) => text.includes("Several repositories")),
      ).toBe(false);
    } finally {
      await app.unmount();
    }
  });

  test("on reviewin=changes, a review of another repository of the workspace shows in Changes, on that repository", async () => {
    const app = await mountAppWithReviews({
      reviews: [reviewOf("r2", "w1")],
    });
    try {
      localStorage.setItem("reviewPrefs", "{}");
      localStorage.setItem("vimKeys", "true");
      app.setNextOpened("r2");
      app.setRepos(["/repo/r1", "/repo/r2"]);
      await app.toggleReview();
      await app.settle(50);
      expect(app.shown()).toEqual({ mounted: [], shownId: null });
      expect(app.inspector()).toMatchObject({ open: true, view: "changes" });
      expect(app.inspectorGoTo()).toMatchObject({
        scope: "working",
        root: "/repo/r2",
      });
    } finally {
      await app.unmount();
    }
  });

  test("on reviewin=changes, a branch review opens Changes on the Branch scope", async () => {
    const branch = reviewOf("r1", "w1");
    branch.session.target = {
      kind: "range",
      base: "origin/main",
      head: "HEAD",
    };
    const app = await mountAppWithReviews({ reviews: [branch] });
    try {
      localStorage.setItem("reviewPrefs", "{}");
      localStorage.setItem("vimKeys", "true");
      app.setNextOpened("r1");
      await app.toggleReview();
      await app.settle(50);
      expect(app.shown()).toEqual({ mounted: [], shownId: null });
      expect(app.inspector()).toMatchObject({ open: true, view: "changes" });
      expect(app.inspectorGoTo()).toMatchObject({ scope: "branch-main" });
    } finally {
      await app.unmount();
    }
  });

  test("on reviewin=changes, on the default branch with commits and uncommitted work, the toggle shows the work, never an empty Branch scope; pressed again it closes", async () => {
    const branch = reviewOf("r1", "w1");
    branch.session.target = { kind: "range", base: "main", head: "HEAD" };
    const app = await mountAppWithReviews({ reviews: [branch] });
    try {
      localStorage.setItem("reviewPrefs", "{}");
      localStorage.setItem("vimKeys", "true");
      app.setNextOpened("r1");
      app.setChanged("branch-main", []);
      app.setChanged("working", ["notes.txt"]);
      await app.toggleReview();
      await app.settle(50);
      expect(app.inspector()).toMatchObject({ open: true, view: "changes" });
      expect(app.inspectorGoTo()).toMatchObject({ scope: "working" });
      await app.toggleReview();
      await app.settle(50);
      expect(app.inspector()?.open).toBe(false);
      expect(app.shown()).toEqual({ mounted: [], shownId: null });
      // And again: open, then closed.
      await app.toggleReview();
      await app.settle(50);
      expect(app.inspector()).toMatchObject({ open: true, view: "changes" });
      await app.toggleReview();
      await app.settle(50);
      expect(app.inspector()?.open).toBe(false);
    } finally {
      await app.unmount();
    }
  });

  test("on reviewin=changes, with nothing beyond the default branch and no work, the toggle shows the review pane's commits", async () => {
    const branch = reviewOf("r1", "w1");
    branch.session.target = { kind: "range", base: "main", head: "HEAD" };
    const app = await mountAppWithReviews({ reviews: [branch] });
    try {
      localStorage.setItem("reviewPrefs", "{}");
      localStorage.setItem("vimKeys", "true");
      app.setNextOpened("r1");
      app.setChanged("branch-main", []);
      app.setChanged("working", []);
      await app.toggleReview();
      await app.settle(50);
      // Changes shows the review itself, its commits on its commit bar
      // (plan phase 6): no classic pane.
      expect(app.shown()).toEqual({ mounted: [], shownId: null });
      expect(app.inspector()).toMatchObject({ open: true, view: "changes" });
      expect(app.inspectorGoTo()).toMatchObject({ review: "r1" });
      await app.toggleReview();
      await app.settle(50);
      expect(app.inspector()?.open).toBe(false);
      expect(app.shown()).toEqual({ mounted: [], shownId: null });
    } finally {
      await app.unmount();
    }
  });

  test("on reviewin=changes, a range of other ends, a compare, a step's review and a merge request's open in Changes as the review scope, never the classic pane", async () => {
    for (const target of [
      {
        kind: "mr",
        url: "https://gitlab.example/group/project/-/merge_requests/7",
      },
      { kind: "range", base: "v1.0", head: "topic" },
      { kind: "range", base: "topic-old", head: "topic", compare: true },
      {
        kind: "step",
        step: "1763200000000-abcdef01",
        before: "a".repeat(40),
        after: "b".repeat(40),
      },
    ] as const) {
      const review = reviewOf("r1", "w1");
      review.session.target = target;
      const app = await mountAppWithReviews({ reviews: [review] });
      try {
        localStorage.setItem("reviewPrefs", "{}");
        localStorage.setItem("vimKeys", "true");
        app.setNextOpened("r1");
        await app.toggleReview();
        await app.settle(50);
        expect(app.shown()).toEqual({ mounted: [], shownId: null });
        expect(app.inspector()).toMatchObject({ open: true, view: "changes" });
        expect(app.inspectorGoTo()).toMatchObject({ review: "r1" });
        expect(app.notices()).toEqual([]);
      } finally {
        await app.unmount();
      }
    }
  });

  test("on reviewin=changes, a review of a repository the workspace does not hold shows in its Changes, from elsewhere, never the classic pane", async () => {
    const app = await mountAppWithReviews({
      reviews: [reviewOf("r2", "w1")],
    });
    try {
      localStorage.setItem("reviewPrefs", "{}");
      localStorage.setItem("vimKeys", "true");
      app.setNextOpened("r2");
      await app.toggleReview();
      await app.settle(50);
      // D3: in the focused workspace's Changes, on that repository, marked.
      expect(app.shown()).toEqual({ mounted: [], shownId: null });
      expect(app.inspector()).toMatchObject({ open: true, view: "changes" });
      expect(app.inspectorGoTo()).toMatchObject({
        scope: "working",
        root: "/repo/r2",
        elsewhere: true,
      });
    } finally {
      await app.unmount();
    }
  });

  test("on reviewin=changes, the review picked in the reviews list shows in Changes, a merge request's too, never the classic pane", async () => {
    const mr = reviewOf("m1", "w1");
    mr.session.root = "/repo/r1";
    mr.session.target = {
      kind: "mr",
      url: "https://gitlab.example/group/project/-/merge_requests/7",
    };
    const app = await mountAppWithReviews({
      reviews: [reviewOf("r1", "w1"), mr],
    });
    try {
      localStorage.setItem("reviewPrefs", "{}");
      localStorage.setItem("vimKeys", "true");
      await app.toggleList();
      expect(app.listShown()).toBe(true);
      await app.pickFromList("m1");
      await app.settle(50);
      expect(app.listShown()).toBe(false);
      expect(app.shown()).toEqual({ mounted: [], shownId: null });
      expect(app.inspector()).toMatchObject({ open: true, view: "changes" });
      expect(app.inspectorGoTo()).toMatchObject({ review: "m1" });
    } finally {
      await app.unmount();
    }
  });

  test("a stored reviewin=classic (the retired setting) changes nothing: Option+R opens the review in Changes", async () => {
    const app = await mountAppWithReviews({
      reviews: [reviewOf("r1", "w1")],
    });
    try {
      localStorage.setItem(
        "reviewPrefs",
        JSON.stringify({ reviewIn: "classic" }),
      );
      localStorage.setItem("vimKeys", "true");
      app.setNextOpened("r1");
      await app.toggleReview();
      await app.settle(50);
      expect(app.shown()).toEqual({ mounted: [], shownId: null });
      expect(app.inspector()).toMatchObject({ open: true, view: "changes" });
    } finally {
      await app.unmount();
    }
  });

  test("the review's code loads 3 s after the page shows; reviews shown one after the other each take the workspace's Changes", async () => {
    const reviews = Array.from({ length: 8 }, (_, index) =>
      reviewOf(`r${index + 1}`, "w1"),
    );
    try {
      const app = await mountAppWithReviews({ reviews, fakeTimers: true });
      try {
        await app.settle(2900);
        expect(app.highlighterPreloads()).toBe(0);
        await app.settle(200);
        expect(app.highlighterPreloads()).toBe(1);
        // Reviews of the workspace's repositories picked one after the
        // other: Changes holds one at a time, the last picked.
        app.setNextOpened("r1");
        await app.toggleReview();
        await app.settle(50);
        for (const review of reviews.slice(1)) {
          await app.toggleList();
          await app.pickFromList(review.session.id);
          await app.settle(50);
        }
        expect(app.inspector()).toMatchObject({ open: true, view: "changes" });
        expect(app.inspectorGoTo()).toMatchObject({ root: "/repo/r8" });
        // The one picked again is shown again.
        await app.toggleList();
        await app.pickFromList("r4");
        await app.settle(50);
        expect(app.inspectorGoTo()).toMatchObject({ root: "/repo/r4" });
        expect(app.shown()).toEqual({ mounted: [], shownId: null });
      } finally {
        await app.unmount();
      }
    } finally {
      jest.useRealTimers();
    }
  });
}
