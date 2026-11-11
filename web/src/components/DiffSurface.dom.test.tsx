import { describe, expect, test } from "bun:test";

/**
 * The shared Pierre diff surface (DiffSurface), mounted alone and through
 * the views that draw with it: Changes, Commits and Files' file changes.
 */
if (process.env.ROAMGATE_DIFF_SURFACE_DOM_TEST !== "1") {
  test("Diff surface in an isolated DOM runtime", async () => {
    const child = Bun.spawn([process.execPath, "test", import.meta.path], {
      env: { ...process.env, ROAMGATE_DIFF_SURFACE_DOM_TEST: "1" },
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
  const { installChangesDom, mountChangesDiff, entry, selectDiffLines } =
    await import("./changesSurface.testkit");
  await installChangesDom();
  const { act, createElement } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { DiffSurface, DiffSurfaceScroll, diffSurfaceOptions } = await import(
    "./DiffSurface"
  );
  type SurfaceProps = import("./DiffSurface").DiffSurfaceProps<Note>;
  type Instance = import("./DiffSurface").DiffSurfaceInstance;
  type Note = { side: "old" | "new"; line: number; text: string };

  const patch = [
    "diff --git a/one.ts b/one.ts",
    "--- a/one.ts",
    "+++ b/one.ts",
    "@@ -1,2 +1,2 @@",
    " a",
    "-b",
    "+B",
    "",
  ].join("\n");
  const options = diffSurfaceOptions({
    diffStyle: "split",
    wrap: false,
    themeType: "dark",
  });

  const settle = async () => {
    for (let round = 0; round < 8; round += 1)
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 2));
      });
  };

  /** One surface in its scrolling list, as the views mount it. */
  async function mountSurface(initial: Partial<SurfaceProps> = {}) {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    let props: SurfaceProps = { patch, path: "one.ts", options, ...initial };
    const render = async () => {
      await act(async () =>
        root.render(
          createElement(DiffSurfaceScroll, {
            className: "pierre-diff-scroll",
            children: createElement(DiffSurface<Note>, props),
          }),
        ),
      );
      await settle();
    };
    await render();
    const shadow = () =>
      host.querySelector("diffs-container")?.shadowRoot ?? null;
    return {
      host,
      shadow,
      /** The drawn lines, `side number text`, both sides of a split view. */
      lines() {
        const found: string[] = [];
        for (const code of shadow()?.querySelectorAll("code") ?? []) {
          const side = code.hasAttribute("data-deletions") ? "old" : "new";
          for (const line of code.querySelectorAll<HTMLElement>(
            "[data-content] [data-line]",
          ))
            found.push(
              `${side} ${line.getAttribute("data-line")} ${line.textContent}`,
            );
        }
        return found;
      },
      /** The selected lines, `side number`. */
      selected() {
        const found: string[] = [];
        for (const code of shadow()?.querySelectorAll("code") ?? []) {
          const side = code.hasAttribute("data-deletions") ? "old" : "new";
          for (const line of code.querySelectorAll(
            "[data-content] [data-line][data-selected-line]",
          ))
            found.push(`${side} ${line.getAttribute("data-line")}`);
        }
        return found;
      },
      async update(next: Partial<SurfaceProps>) {
        props = { ...props, ...next };
        await render();
      },
      async unmount() {
        await act(async () => root.unmount());
        host.remove();
      },
    };
  }

  describe("diffSurfaceOptions", () => {
    test("draws split or unified, wrapped or scrolled, in the app's theme", () => {
      expect(options).toMatchObject({
        diffStyle: "split",
        overflow: "scroll",
        themeType: "dark",
        disableFileHeader: true,
      });
      expect(
        diffSurfaceOptions({
          diffStyle: "unified",
          wrap: true,
          themeType: "light",
        }),
      ).toMatchObject({
        diffStyle: "unified",
        overflow: "wrap",
        themeType: "light",
      });
    });
  });

  describe("DiffSurface", () => {
    test("draws a file's patch, both sides", async () => {
      const surface = await mountSurface();
      try {
        expect(surface.lines()).toEqual([
          "old 1 a",
          "old 2 b",
          "new 1 a",
          "new 2 B",
        ]);
        expect(surface.host.querySelector(".diff-raw-patch")).toBeNull();
      } finally {
        await surface.unmount();
      }
    });

    test("a patch Pierre cannot read is shown raw, and drawn again once it can", async () => {
      const surface = await mountSurface({ patch: "not a patch" });
      try {
        expect(surface.host.querySelector(".diff-raw-patch")?.textContent).toBe(
          "not a patch",
        );
        await surface.update({ patch });
        expect(surface.host.querySelector(".diff-raw-patch")).toBeNull();
        expect(surface.lines()).toContain("new 2 B");
      } finally {
        await surface.unmount();
      }
    });

    test("annotations are drawn under their lines by renderAnnotation", async () => {
      const surface = await mountSurface({
        annotations: [
          { side: "new", line: 2, text: "on the new line" },
          { side: "old", line: 2, text: "on the old line" },
        ],
        renderAnnotation: (note) =>
          createElement("p", { className: "note" }, note.text),
      });
      try {
        expect(
          [...surface.host.querySelectorAll(".note")].map(
            (each) => each.textContent,
          ),
        ).toEqual(["on the new line", "on the old line"]);
      } finally {
        await surface.unmount();
      }
    });

    test("line selection is off without onSelectLines", async () => {
      const surface = await mountSurface();
      try {
        await selectDiffLines(surface.host, { side: "new", line: 2 });
        await settle();
        expect(surface.selected()).toEqual([]);
      } finally {
        await surface.unmount();
      }
    });

    test("a selection ends in onSelectLines; kept while active, cleared on false or once inactive", async () => {
      const ranges: unknown[] = [];
      let keep = true;
      const surface = await mountSurface({
        onSelectLines: (range) => {
          ranges.push(range);
          return keep;
        },
        selectionActive: true,
      });
      try {
        await selectDiffLines(surface.host, { side: "new", line: 2 });
        await settle();
        expect(ranges).toEqual([{ start: 2, end: 2, side: "additions" }]);
        expect(surface.selected()).toContain("new 2");
        await surface.update({ selectionActive: false });
        expect(surface.selected()).toEqual([]);

        keep = false;
        await surface.update({ selectionActive: true });
        await selectDiffLines(
          surface.host,
          { side: "old", line: 1 },
          { side: "old", line: 2 },
        );
        await settle();
        expect(ranges).toHaveLength(2);
        expect(surface.selected()).toEqual([]);
      } finally {
        await surface.unmount();
      }
    });

    test("transformDiff decides what Pierre is given", async () => {
      const seen: string[] = [];
      const surface = await mountSurface({
        transformDiff: (diff) => {
          seen.push(diff.name);
          return { ...diff, hunks: [] };
        },
      });
      try {
        expect(seen).toEqual(["one.ts"]);
        expect(surface.lines()).toEqual([]);
      } finally {
        await surface.unmount();
      }
    });

    test("decorate sees the drawn rows after each render; onInstance hands Pierre's instance, then null", async () => {
      const decorated: string[] = [];
      const instances: (Instance | null)[] = [];
      const surface = await mountSurface({
        decorate: (node) => {
          decorated.push(
            node.shadowRoot?.querySelector("[data-line='2']")?.textContent ??
              "",
          );
        },
        onInstance: (instance) => instances.push(instance),
      });
      try {
        expect(decorated[decorated.length - 1]).toBe("b");
        const instance = instances[instances.length - 1];
        expect(typeof instance?.setSelectedLines).toBe("function");
        expect(instance?.getLineIndex(2, "additions")).toBeDefined();
      } finally {
        await surface.unmount();
      }
      expect(instances[instances.length - 1]).toBeNull();
    });
  });

  describe("Views drawing through the surface", () => {
    test("Changes and Files' file changes draw a patch as the surface alone does", async () => {
      const alone = await mountSurface();
      const expected = alone.lines();
      await alone.unmount();
      const file = entry("one.ts");
      for (const embedded of [false, true]) {
        const view = await mountChangesDiff({
          entries: [file],
          patches: { "unstaged:one.ts": patch },
          embedded,
        });
        try {
          const section = document.querySelector(
            '[data-diff-entry-key="unstaged:one.ts"]',
          );
          expect(section?.querySelector(".pierre-diff-surface")).not.toBeNull();
          expect(
            view
              .lines("unstaged:one.ts")
              .map((line) => `${line.side} ${line.number} ${line.text}`),
          ).toEqual(expected);
        } finally {
          await view.unmount();
        }
      }
    });

    test("Commits draws a commit's file as the surface alone does", async () => {
      const alone = await mountSurface();
      const expected = alone.lines();
      await alone.unmount();
      const { GitCommitHistory } = await import("./GitCommitHistory");
      const author = {
        name: "Author",
        email: "author@example.com",
        date: "2026-10-20T00:00:00Z",
      };
      const client = {
        connectionId: "surface-commits",
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
            return { path: params.path, kind: "branch", diff: patch };
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
              resourceKey: "surface-commits",
            }),
          ),
        );
        let drawn: string[] = [];
        for (let round = 0; round < 40 && !drawn.length; round += 1) {
          await settle();
          const section = host.querySelector(
            '[data-diff-entry-key="branch:one.ts"]',
          );
          drawn = [
            ...(section
              ?.querySelector(".pierre-diff-surface diffs-container")
              ?.shadowRoot?.querySelectorAll("code") ?? []),
          ].flatMap((code) =>
            [
              ...code.querySelectorAll<HTMLElement>(
                "[data-content] [data-line]",
              ),
            ].map(
              (line) =>
                `${code.hasAttribute("data-deletions") ? "old" : "new"} ${line.getAttribute("data-line")} ${line.textContent}`,
            ),
          );
        }
        expect(drawn).toEqual(expected);
      } finally {
        await act(async () => root.unmount());
        host.remove();
      }
    });
  });
}
