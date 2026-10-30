import { describe, expect, test } from "bun:test";

/**
 * The inspector's Changes diff view (upstream DiffContentView, drawn by
 * Pierre), at the behavior level: patches, clicks and drags in; sections,
 * lines, the composer and what is drawn under lines out. Pinned before
 * Changes becomes the review (plan: review into the inspector, phase A);
 * read only through changesSurface.testkit.tsx.
 */
if (process.env.ROAMGATE_CHANGES_DIFF_DOM_TEST !== "1") {
  test("Changes diff view in an isolated DOM runtime", async () => {
    const child = Bun.spawn([process.execPath, "test", import.meta.path], {
      env: { ...process.env, ROAMGATE_CHANGES_DIFF_DOM_TEST: "1" },
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
  const {
    installChangesDom,
    mountChangesDiff,
    entry,
    selectDiffLines,
    shownComposer,
  } = await import("./changesSurface.testkit");
  await installChangesDom();
  const { roamgateLocalStorage } = await import("../browserStorage");
  type NewNote = import("../annotations").NewReviewAnnotation;

  const patch = (path: string, from: string[], to: string[]) =>
    [
      `diff --git a/${path} b/${path}`,
      `--- a/${path}`,
      `+++ b/${path}`,
      `@@ -1,${from.length} +1,${to.length} @@`,
      ...from.flatMap((line, index) =>
        to[index] === line ? [` ${line}`] : [`-${line}`],
      ),
      ...to.flatMap((line, index) =>
        from[index] === line ? [] : [`+${line}`],
      ),
      "",
    ].join("\n");
  const staged = entry("one.ts", "staged");
  const unstaged = entry("one.ts", "unstaged");
  const patches = {
    "staged:one.ts": patch("one.ts", ["a", "b"], ["a", "B"]),
    "unstaged:one.ts": patch("one.ts", ["a", "B"], ["a", "C"]),
  };

  describe("Changes diff sections", () => {
    test("a path staged and unstaged shows as two sections, each with its own changes", async () => {
      const view = await mountChangesDiff({
        entries: [staged, unstaged],
        patches,
      });
      try {
        expect(view.sections()).toEqual([
          { key: "staged:one.ts", path: "one.ts", badge: "M" },
          { key: "unstaged:one.ts", path: "one.ts", badge: "M" },
        ]);
        const changed = (key: string) =>
          view
            .lines(key)
            .filter((line) => line.type !== "context")
            .map((line) => `${line.side} ${line.number} ${line.text}`);
        expect(changed("staged:one.ts")).toEqual(["old 2 b", "new 2 B"]);
        expect(changed("unstaged:one.ts")).toEqual(["old 2 B", "new 2 C"]);
      } finally {
        await view.unmount();
      }
    });

    test("a patch Pierre cannot read is shown raw, the other files drawn as usual", async () => {
      const view = await mountChangesDiff({
        entries: [entry("bad.ts"), entry("good.ts")],
        patches: {
          "unstaged:bad.ts": "not a patch",
          "unstaged:good.ts": patch("good.ts", ["x"], ["y"]),
        },
      });
      try {
        expect(view.rawPatch("unstaged:bad.ts")).toBe("not a patch");
        expect(view.lines("unstaged:bad.ts")).toEqual([]);
        expect(view.rawPatch("unstaged:good.ts")).toBeNull();
        expect(view.lines("unstaged:good.ts").map((line) => line.text)).toEqual(
          ["x", "y"],
        );
      } finally {
        await view.unmount();
      }
    });

    test("the diff's colors follow the app's theme", async () => {
      document.documentElement.dataset.theme = "dark";
      const view = await mountChangesDiff({ entries: [unstaged], patches });
      try {
        expect(view.theme("unstaged:one.ts")).toBe("dark");
        document.documentElement.dataset.theme = "light";
        await view.settle();
        expect(view.theme("unstaged:one.ts")).toBe("light");
        document.documentElement.dataset.theme = "dark";
        await view.settle();
        expect(view.theme("unstaged:one.ts")).toBe("dark");
      } finally {
        delete document.documentElement.dataset.theme;
        await view.unmount();
      }
    });
  });

  describe("Changes wrap and compact layout", () => {
    test("Wrap is kept apart on desktop and on a phone, and remembered", async () => {
      roamgateLocalStorage.removeItem("desktopDiffWrap");
      roamgateLocalStorage.removeItem("mobileDiffWrap");
      const view = await mountChangesDiff({ entries: [unstaged], patches });
      try {
        // Desktop wraps by default; a phone does not.
        expect(view.wrap()).toBe(true);
        await view.toggleWrap();
        expect(view.wrap()).toBe(false);
        expect(roamgateLocalStorage.getItem("desktopDiffWrap")).toBe("false");
        await view.update({ mobile: true });
        expect(view.wrap()).toBe(false);
        await view.toggleWrap();
        expect(view.wrap()).toBe(true);
        expect(roamgateLocalStorage.getItem("mobileDiffWrap")).toBe("true");
        // Back on the desktop layout, its own choice.
        await view.update({ mobile: false });
        expect(view.wrap()).toBe(false);
        await view.remount();
        expect(view.wrap()).toBe(false);
        await view.update({ mobile: true });
        expect(view.wrap()).toBe(true);
      } finally {
        await view.unmount();
      }
    });

    test("on a phone, the way back to the file list is an on-screen button; the system Back does not take it", async () => {
      let backs = 0;
      const view = await mountChangesDiff({
        entries: [unstaged],
        patches,
        mobile: true,
        backAction: { label: "Back to changed files", onClick: () => backs++ },
      });
      try {
        expect(view.backButton()).toBe("Back to changed files");
        window.dispatchEvent(new PopStateEvent("popstate", { state: null }));
        await view.settle();
        expect(backs).toBe(0);
        await view.pressBack();
        expect(backs).toBe(1);
        // The desktop layout has no such button.
        await view.update({ mobile: false });
        expect(view.backButton()).toBeNull();
      } finally {
        await view.unmount();
      }
    });
  });

  describe("Commenting in Changes", () => {
    test("a line number clicked opens the composer on it; Add comment hands the note on and closes it", async () => {
      const notes: NewNote[] = [];
      const view = await mountChangesDiff({
        entries: [unstaged],
        patches,
        onCreateAnnotation: (note) => notes.push(note),
      });
      try {
        expect(view.composer()).toBeNull();
        await view.select("unstaged:one.ts", { side: "new", line: 2 });
        expect(view.composer()).toEqual({
          title: "one.ts · new line 2",
          quote: "C",
        });
        await view.write("Why?");
        await view.save();
        expect(notes).toEqual([
          {
            source: "diff",
            path: "one.ts",
            kind: "unstaged",
            side: "new",
            line: 2,
            quote: "C",
            hunk: "@@ -1,2 +1,2 @@",
            comment: "Why?",
          },
        ]);
        expect(view.composer()).toBeNull();
      } finally {
        await view.unmount();
      }
    });

    test("a drag on one side is a range on it; a drag across sides keeps both ends", async () => {
      const notes: NewNote[] = [];
      const view = await mountChangesDiff({
        entries: [entry("two.ts")],
        patches: {
          "unstaged:two.ts": patch("two.ts", ["a", "b", "c"], ["a", "B", "C"]),
        },
        onCreateAnnotation: (note) => notes.push(note),
      });
      try {
        await view.select(
          "unstaged:two.ts",
          { side: "new", line: 2 },
          { side: "new", line: 3 },
        );
        expect(view.composer()).toEqual({
          title: "two.ts · new lines 2–3",
          quote: "B\nC",
        });
        await view.write("Both?");
        await view.save();
        expect(notes[0]).toMatchObject({
          side: "new",
          line: 2,
          endLine: 3,
          quote: "B\nC",
        });
        expect(notes[0]).not.toHaveProperty("endSide");
        await view.select(
          "unstaged:two.ts",
          { side: "old", line: 1 },
          { side: "new", line: 3 },
        );
        expect(view.composer()?.title).toBe("two.ts · old line 1 → new line 3");
        await view.write("Across");
        await view.save();
        expect(notes[1]).toMatchObject({
          side: "old",
          line: 1,
          endSide: "new",
          endLine: 3,
        });
      } finally {
        await view.unmount();
      }
    });

    test("a comment kept in this browser is drawn under its line, to be opened", async () => {
      const opened: string[] = [];
      const view = await mountChangesDiff({
        entries: [unstaged],
        patches,
        onCreateAnnotation: () => {},
        annotations: [
          {
            id: "local",
            source: "diff",
            path: "one.ts",
            kind: "unstaged",
            side: "new",
            line: 2,
            quote: "C",
            hunk: "@@ -1,2 +1,2 @@",
            comment: "Kept",
            createdAt: 1,
          },
        ],
        onEditAnnotation: (id) => opened.push(id),
      });
      try {
        expect(view.comments("unstaged:one.ts")).toEqual(["Kept"]);
        await view.openComment("unstaged:one.ts", "Kept");
        expect(opened).toEqual(["local"]);
      } finally {
        await view.unmount();
      }
    });

    test("without a comment handler (as Commits mounts it) a line click opens no composer", async () => {
      const view = await mountChangesDiff({ entries: [unstaged], patches });
      try {
        await view.select("unstaged:one.ts", { side: "new", line: 2 });
        expect(view.composer()).toBeNull();
      } finally {
        await view.unmount();
      }
    });

    test("Commits draws a commit's diff without comments: a line click opens no composer", async () => {
      const { act, createElement } = await import("react");
      const { createRoot } = await import("react-dom/client");
      const { GitCommitHistory } = await import("./GitCommitHistory");
      const author = {
        name: "Author",
        email: "author@example.com",
        date: "2026-10-20T00:00:00Z",
      };
      const client = {
        connectionId: "commits-diff",
        generation: 1,
        serverRuntimeGeneration: 1,
        isCurrent: () => true,
        acceptsServerGeneration: () => true,
        call: async (method: string, params: Record<string, unknown> = {}) => {
          if (method === "git.commits")
            return {
              head: "abc123",
              commits: [
                {
                  sha: "abc123",
                  short_sha: "abc123",
                  subject: "First commit",
                  author: author.name,
                  authored_at: author.date,
                },
              ],
              has_more: false,
              shallow: false,
            };
          if (method === "git.commit")
            return {
              sha: params.sha,
              parents: [],
              base: null,
              message: "First commit",
              author,
              committer: author,
              entries: [{ path: "one.ts", kind: "branch", status: "modified" }],
            };
          if (method === "git.commit_file")
            return {
              path: params.path,
              kind: "branch",
              diff: patch("one.ts", ["a", "b"], ["a", "B"]),
              truncated: false,
            };
          throw new Error(method);
        },
      } as unknown as import("../api").ConnectionClient;
      const host = document.createElement("div");
      document.body.append(host);
      const root = createRoot(host);
      try {
        await act(async () =>
          root.render(
            createElement(GitCommitHistory, {
              client,
              compact: false,
              active: true,
              workspaceId: "workspace",
              resourceKey: "commits-diff",
            }),
          ),
        );
        const section = async () => {
          for (let round = 0; round < 40; round += 1) {
            const found = host.querySelector(
              '[data-diff-entry-key="branch:one.ts"]',
            );
            if (
              found
                ?.querySelector("diffs-container")
                ?.shadowRoot?.querySelector("[data-line]")
            )
              return found;
            await act(async () => {
              await new Promise((resolve) => setTimeout(resolve, 5));
            });
          }
          throw new Error("the commit's diff was not drawn");
        };
        await selectDiffLines(await section(), { side: "new", line: 2 });
        expect(shownComposer()).toBeNull();
      } finally {
        await act(async () => root.unmount());
        host.remove();
      }
    });
  });
}
