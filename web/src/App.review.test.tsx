import { expect, jest, test } from "bun:test";

/**
 * The review at the app level: Option+R, the reviews list, the review's
 * place kept while it is away, Cmd+K and Go to agent's pane putting it
 * aside, the code preload. App is mounted with a stub review surface
 * (App.review.testkit.tsx); what a review draws is the behavior tests'.
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

  test("Option+R shows the workspace's branch review, and hides it again", async () => {
    const app = await mountAppWithReviews({
      reviews: [reviewOf("r1", "w1")],
    });
    try {
      expect(app.shown()).toEqual({ mounted: [], shownId: null });
      app.setNextOpened("r1");
      await app.toggleReview();
      // The workspace's review is found (or made) once.
      expect(app.openCalls()).toBe(1);
      expect(app.shown()).toEqual({ mounted: ["r1"], shownId: "r1" });
      await app.toggleReview();
      expect(app.shown()).toEqual({ mounted: ["r1"], shownId: null });
      // Again: the review pinned to the workspace, not looked up anew.
      await app.toggleReview();
      expect(app.openCalls()).toBe(1);
      expect(app.shown()).toEqual({ mounted: ["r1"], shownId: "r1" });
    } finally {
      await app.unmount();
    }
  });

  test("closing the review only hides it: Option+R brings back the same one, never mounted again", async () => {
    const app = await mountAppWithReviews({
      reviews: [reviewOf("r1", "w1")],
    });
    try {
      app.setNextOpened("r1");
      await app.toggleReview();
      expect(app.mounts("r1")).toBe(1);
      // Its own close (Esc, :q) hides it as Option+R does.
      await app.settle();
      await app.run(() => app.host().onClose());
      expect(app.shown()).toEqual({ mounted: ["r1"], shownId: null });
      await app.toggleReview();
      expect(app.shown().shownId).toBe("r1");
      expect(app.mounts("r1")).toBe(1);
      // Another workspace and back: kept, shown again.
      await app.focusWorkspace("w2");
      expect(app.shown()).toEqual({ mounted: ["r1"], shownId: null });
      await app.focusWorkspace("w1");
      expect(app.shown().shownId).toBe("r1");
      expect(app.mounts("r1")).toBe(1);
      // Closed stays closed across workspace changes, until Option+R.
      await app.toggleReview();
      await app.focusWorkspace("w2");
      await app.focusWorkspace("w1");
      expect(app.shown().shownId).toBe(null);
      expect(app.openCalls()).toBe(1);
    } finally {
      await app.unmount();
    }
  });

  test("Option+Shift+R opens the reviews list over the review, which comes back once it closes", async () => {
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
      await app.toggleList();
      expect(app.listShown()).toBe(true);
      expect(app.shown()).toEqual({ mounted: ["r1"], shownId: null });
      await app.closeList();
      expect(app.listShown()).toBe(false);
      expect(app.shown().shownId).toBe("r1");
      // The review's own way to the list (:reviews) does the same.
      await app.run(() => app.host().onShowList());
      expect(app.listShown()).toBe(true);
      expect(app.shown().shownId).toBe(null);
    } finally {
      await app.unmount();
    }
  });

  test("the tab bar's Review opens and closes the review as Option+R does", async () => {
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
      expect(app.shown().shownId).toBe("r1");
      expect(app.tabBarReview()!.getAttribute("aria-expanded")).toBe("true");
      expect(app.tabBarReview()!.title).toStartWith("Close the review");
      await app.click(app.tabBarReview()!);
      expect(app.shown().shownId).toBe(null);
      expect(app.tabBarReview()!.getAttribute("aria-expanded")).toBe("false");
    } finally {
      await app.unmount();
    }
  });

  test("Cmd+K puts the review aside; Option+R or the next workspace change brings it back", async () => {
    const { COMMAND_MENU_OPENING } = await import(
      "./components/CommandCombobox"
    );
    const app = await mountAppWithReviews({
      reviews: [reviewOf("r1", "w1")],
    });
    try {
      app.setNextOpened("r1");
      await app.toggleReview();
      // The command menu says it opens; the review steps aside, kept.
      window.dispatchEvent(new Event(COMMAND_MENU_OPENING));
      await app.settle();
      expect(app.shown()).toEqual({ mounted: ["r1"], shownId: null });
      await app.toggleReview();
      expect(app.shown().shownId).toBe("r1");
      expect(app.openCalls()).toBe(1);
      expect(app.mounts("r1")).toBe(1);
      // It also closes the reviews list.
      await app.toggleList();
      expect(app.listShown()).toBe(true);
      window.dispatchEvent(new Event(COMMAND_MENU_OPENING));
      await app.settle();
      expect(app.listShown()).toBe(false);
      expect(app.shown().shownId).toBe(null);
      // A workspace change ends the step aside: back in w1, it shows.
      await app.focusWorkspace("w2");
      await app.focusWorkspace("w1");
      expect(app.shown().shownId).toBe("r1");
    } finally {
      await app.unmount();
    }
  });

  test("Go to agent's pane puts the review aside and focuses the pane", async () => {
    const app = await mountAppWithReviews({
      reviews: [reviewOf("r1", "w1")],
    });
    try {
      app.setNextOpened("r1");
      await app.toggleReview();
      await app.run(() => app.host().onFocusAgentPane("a"));
      expect(app.focusedPanes()).toEqual(["a"]);
      expect(app.shown()).toEqual({ mounted: ["r1"], shownId: null });
      await app.toggleReview();
      expect(app.shown().shownId).toBe("r1");
      expect(app.openCalls()).toBe(1);
    } finally {
      await app.unmount();
    }
  });

  test("gf opens the file at its line in Files and the review steps aside; Option+R brings it back", async () => {
    const app = await mountAppWithReviews({
      reviews: [reviewOf("r1", "w1")],
    });
    try {
      app.setNextOpened("r1");
      await app.toggleReview();
      await app.run(() => app.host().onOpenFile("w1", "/repo/r1/src/a.ts", 12));
      expect(app.shown()).toEqual({ mounted: ["r1"], shownId: null });
      const inspector = app.inspector();
      expect(inspector).toMatchObject({ open: true, view: "files" });
      expect(inspector?.scope.workspaceId).toBe("w1");
      expect(app.inspectorFile()).toMatchObject({
        entry: { path: "/repo/r1/src/a.ts", type: "file" },
        line: 12,
      });
      await app.toggleReview();
      expect(app.shown().shownId).toBe("r1");
      expect(app.mounts("r1")).toBe(1);
    } finally {
      await app.unmount();
    }
  });

  test("on reviewin=changes, Option+R opens Changes expanded and focused, and goes back to what the inspector showed", async () => {
    const app = await mountAppWithReviews({
      reviews: [reviewOf("r1", "w1")],
    });
    try {
      localStorage.setItem(
        "reviewPrefs",
        JSON.stringify({ reviewIn: "changes" }),
      );
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

  test("on reviewin=changes, Files' Review opens Changes at that file and line, not the classic pane", async () => {
    const app = await mountAppWithReviews({
      reviews: [reviewOf("r1", "w1")],
    });
    try {
      localStorage.setItem(
        "reviewPrefs",
        JSON.stringify({ reviewIn: "changes" }),
      );
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

  test("on reviewin=changes, a workspace with several repositories keeps the classic pane, which switches between them, and says so", async () => {
    const app = await mountAppWithReviews({
      reviews: [reviewOf("r1", "w1")],
    });
    try {
      localStorage.setItem(
        "reviewPrefs",
        JSON.stringify({ reviewIn: "changes" }),
      );
      localStorage.setItem("vimKeys", "true");
      app.setNextOpened("r1");
      app.setRepos(["/repo/r1", "/repo/other"]);
      await app.toggleReview();
      await app.settle(50);
      expect(app.shown()).toEqual({ mounted: ["r1"], shownId: "r1" });
      expect(app.inspector()?.open ?? false).toBe(false);
      expect(
        app.notices().some((text) => text.includes("Several repositories")),
      ).toBe(true);
      // The toggle hides it again, as on classic.
      await app.toggleReview();
      expect(app.shown()).toEqual({ mounted: ["r1"], shownId: null });
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
      localStorage.setItem(
        "reviewPrefs",
        JSON.stringify({ reviewIn: "changes" }),
      );
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

  test("on reviewin=changes, a review of another repository than the checkout keeps the classic pane", async () => {
    const app = await mountAppWithReviews({
      reviews: [reviewOf("r2", "w1")],
    });
    try {
      localStorage.setItem(
        "reviewPrefs",
        JSON.stringify({ reviewIn: "changes" }),
      );
      localStorage.setItem("vimKeys", "true");
      app.setNextOpened("r2");
      await app.toggleReview();
      await app.settle(50);
      expect(app.shown()).toEqual({ mounted: ["r2"], shownId: "r2" });
      expect(app.inspector()?.open ?? false).toBe(false);
    } finally {
      await app.unmount();
    }
  });

  test("on reviewin=classic, Option+R leaves the inspector alone", async () => {
    const app = await mountAppWithReviews({
      reviews: [reviewOf("r1", "w1")],
    });
    try {
      localStorage.setItem("reviewPrefs", "{}");
      localStorage.setItem("vimKeys", "true");
      app.setNextOpened("r1");
      await app.toggleReview();
      expect(app.shown()).toEqual({ mounted: ["r1"], shownId: "r1" });
      expect(app.inspector()?.open ?? false).toBe(false);
    } finally {
      await app.unmount();
    }
  });

  test("the review's code loads 3 s after the page shows, and the last 6 reviews shown stay mounted", async () => {
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
        // Reviews of the workspace's repositories shown one after the
        // other (the review's ( and ), p): the 6 latest stay mounted.
        app.setNextOpened("r1");
        await app.toggleReview();
        for (const review of reviews.slice(1)) {
          await app.run(() => app.host().onShow(review.session.id));
        }
        expect(app.shown().shownId).toBe("r8");
        expect(app.shown().mounted.sort()).toEqual(
          ["r3", "r4", "r5", "r6", "r7", "r8"].sort(),
        );
        // Each was mounted once, and the one shown again is the same.
        await app.run(() => app.host().onShow("r4"));
        expect(app.shown().shownId).toBe("r4");
        expect(app.mounts("r4")).toBe(1);
      } finally {
        await app.unmount();
      }
    } finally {
      jest.useRealTimers();
    }
  });
}
