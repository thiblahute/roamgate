import { describe, expect, mock, test } from "bun:test";

/**
 * Arriving in an inspector view gives the keys to what it shows (the
 * review's diff, the file shown, the commits), not to the tab or header
 * button that led there; typed text, an open menu and the tab strip's own
 * arrows keep them. The views are stand-ins drawn as the real ones are.
 */
if (process.env.ROAMGATE_INSPECTOR_FOCUS_DOM_TEST !== "1") {
  test("inspector arrival focus in an isolated DOM runtime", async () => {
    const child = Bun.spawn([process.execPath, "test", import.meta.path], {
      env: { ...process.env, ROAMGATE_INSPECTOR_FOCUS_DOM_TEST: "1" },
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
  const { installChangesDom } = await import("./changesSurface.testkit");
  await installChangesDom();
  mock.module("./AgentHistoryDrawer", () => ({
    AgentHistoryDrawer: () => (
      <div className="agent-history-chat" aria-label="history" />
    ),
  }));
  mock.module("./FileExplorerDialog", () => ({
    FileExplorerPanel: () => (
      <div role="tree" aria-label="files">
        <div className="file-row" role="treeitem" tabIndex={0}>
          README.md
        </div>
      </div>
    ),
  }));
  mock.module("./FilePreviewTabs", () => ({
    FilePreviewTabs: () => (
      <div className="file-preview-tabs" role="tablist">
        <button type="button" role="tab" data-file-tab="">
          README.md
        </button>
      </div>
    ),
  }));
  mock.module("./PullRequestCard", () => ({ PullRequestCard: () => null }));
  const diffPanel = await import("./DiffViewerPanel");
  /** Changes' tree as last drawn: a file picked there. */
  const treeSeen: {
    onSelectionChange?: (
      selection: { entry: unknown },
      meta?: { userInitiated?: boolean },
    ) => void;
  } = {};
  mock.module("./DiffViewerPanel", () => ({
    ...diffPanel,
    DiffViewerPanel: (props: typeof treeSeen) => {
      treeSeen.onSelectionChange = props.onSelectionChange;
      return (
        <div aria-label="changes-tree">
          <button type="button" className="diff-tree-row diff-tree-file">
            code.ts
          </button>
        </div>
      );
    },
  }));
  const preview = await import("./FilePreviewContent");
  /** The file preview as drawn: rendered Markdown, or read still. */
  const previewShows: { loading: boolean } = { loading: false };
  mock.module("./FilePreviewContent", () => ({
    ...preview,
    FilePreviewContent: (props: { entry: unknown }) =>
      props.entry ? (
        <section className="file-preview" tabIndex={-1}>
          <div className="file-preview-head">
            <button type="button" data-preview-head="">
              Source
            </button>
          </div>
          <div className="file-preview-file-content">
            {previewShows.loading ? (
              <span className="file-loading-spinner" />
            ) : (
              <article className="file-preview-markdown">README</article>
            )}
          </div>
        </section>
      ) : null,
  }));
  mock.module("./DiffContentView", () => ({
    DiffContentView: () => (
      <section
        className="diff-content-view"
        tabIndex={-1}
        data-review-cursor=""
      >
        <div className="diff-content-head">
          <button type="button" data-diff-head="">
            Review
          </button>
        </div>
      </section>
    ),
  }));
  mock.module("./GitCommitHistory", () => ({
    GitCommitHistory: () => (
      <div className="git-commit-list">
        <button type="button" className="git-commit-row">
          First commit
        </button>
      </div>
    ),
  }));
  const reviewRepos = await import("../reviewRepos");
  mock.module("../reviewRepos", () => ({
    ...reviewRepos,
    scanRepos: async () => [],
  }));

  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { WorkspaceInspectorHost } = await import("./WorkspaceInspectorHost");
  const { inspectorProps } = await import("./WorkspaceInspectorHost.testkit");
  type Props = Parameters<typeof WorkspaceInspectorHost>[0];
  type View = Props["state"]["view"];

  const file = {
    path: "README.md",
    name: "README.md",
    type: "file",
  } as unknown as NonNullable<Props["fileSelection"]["entry"]>;

  /** A few frames: the arrival waits for the view to be drawn. */
  const frames = () =>
    act(async () => {
      for (let i = 0; i < 6; i += 1)
        await new Promise((resolve) => setTimeout(resolve, 5));
    });

  async function mountInspector(options: {
    view: View;
    entry?: Props["fileSelection"]["entry"];
    line?: number;
    visible?: boolean;
  }) {
    const outside = document.createElement("div");
    outside.innerHTML = `
      <header class="topbar"><button type="button" data-top="">Files</button>
        <button type="button" data-menu="" aria-expanded="true">More</button></header>
      <input data-field="" />`;
    document.body.append(outside);
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    let view = options.view;
    // Drawn again from within the act of the event that changed the view.
    const draw = () =>
      root.render(
        <WorkspaceInspectorHost
          {...inspectorProps({
            state: {
              scope: {
                kind: "workspace",
                connectionId: "local",
                workspaceId: "w1",
              },
              open: true,
              view,
              dock: "right",
              size: 480,
              expanded: false,
            } as Props["state"],
            visible: options.visible ?? true,
            fileSelection: {
              entry: options.entry ?? null,
              preview: null,
              loading: false,
              error: null,
              ...(options.line !== undefined ? { line: options.line } : {}),
            } as Props["fileSelection"],
            onViewChange: (next) => {
              view = next;
              draw();
            },
          })}
        />,
      );
    const render = () => act(async () => draw());
    await render();
    await frames();
    const tab = (name: string) =>
      [
        ...host.querySelectorAll<HTMLButtonElement>(
          ".workspace-inspector-tabs [role=tab]",
        ),
      ].find((each) => each.textContent?.trim().startsWith(name))!;
    return {
      host,
      outside,
      tab,
      /** A tab picked with the pointer: pressed, focused, clicked. */
      async pick(name: string) {
        await act(async () => {
          const button = tab(name);
          button.dispatchEvent(
            new PointerEvent("pointerdown", { bubbles: true }),
          );
          button.focus();
          button.click();
        });
        await frames();
      },
      async key(target: HTMLElement, key: string) {
        await act(async () => {
          target.dispatchEvent(
            new KeyboardEvent("keydown", {
              key,
              bubbles: true,
              cancelable: true,
            }),
          );
        });
        await frames();
      },
      async set(next: Partial<typeof options>) {
        Object.assign(options, next);
        if (next.view) view = next.view;
        await render();
        await frames();
      },
      async unmount() {
        await act(async () => root.unmount());
        host.remove();
        outside.remove();
      },
    };
  }

  const active = () => document.activeElement as HTMLElement | null;

  describe("arriving in a view gives the keys to its content", () => {
    test("a tab picked: Changes' review diff, the file shown, the commits", async () => {
      const inspector = await mountInspector({ view: "files", entry: file });
      try {
        await inspector.pick("Changes");
        expect(active()?.matches(".diff-content-view")).toBe(true);
        await inspector.pick("Files");
        expect(active()?.matches(".file-preview-markdown")).toBe(true);
        // Focusable by script only: no extra stop for Tab.
        expect(active()?.tabIndex).toBe(-1);
        await inspector.pick("Commits");
        expect(active()?.matches(".git-commit-row")).toBe(true);
      } finally {
        await inspector.unmount();
      }
    });

    test("the view restored with the page (the keys nowhere) gives its content the keys", async () => {
      const inspector = await mountInspector({ view: "changes" });
      try {
        expect(active()?.matches(".diff-content-view")).toBe(true);
      } finally {
        await inspector.unmount();
      }
    });

    test("the inspector's tab focused by a shortcut or a command (gt, :view) hands the keys on", async () => {
      const inspector = await mountInspector({ view: "changes" });
      try {
        // gt from the diff: its `t` focuses the view's tab.
        await inspector.key(active()!, "t");
        await act(async () => inspector.tab("Changes").focus());
        await frames();
        expect(active()?.matches(".diff-content-view")).toBe(true);
      } finally {
        await inspector.unmount();
      }
    });

    test("a file opened (from the tree, a review's Rendered, its tab) gives the file the keys once read", async () => {
      previewShows.loading = true;
      const inspector = await mountInspector({ view: "files" });
      try {
        // No file yet: the tree has them.
        expect(active()?.matches(".file-row[role=treeitem]")).toBe(true);
        await inspector.set({ entry: file });
        // Read still: the keys wait for the file.
        expect(active()?.matches(".file-row[role=treeitem]")).toBe(true);
        previewShows.loading = false;
        await inspector.set({ line: 3 });
        expect(active()?.matches(".file-preview-markdown")).toBe(true);
        // Its tab picked again: the file keeps them.
        await act(async () => {
          inspector.host.querySelector<HTMLElement>("[data-file-tab]")?.focus();
        });
        await inspector.set({ line: 4 });
        expect(active()?.matches(".file-preview-markdown")).toBe(true);
      } finally {
        previewShows.loading = false;
        await inspector.unmount();
      }
    });

    test("a file picked in Changes' tree gives its diff the keys", async () => {
      const inspector = await mountInspector({ view: "changes" });
      try {
        const row =
          inspector.host.querySelector<HTMLElement>(".diff-tree-file")!;
        await act(async () => {
          row.focus();
          treeSeen.onSelectionChange?.(
            { entry: { path: "code.ts" } },
            { userInitiated: true },
          );
        });
        await frames();
        expect(active()?.matches(".diff-content-view")).toBe(true);
      } finally {
        await inspector.unmount();
      }
    });

    test("on a phone, the view switcher's button hands the keys to the view shown", async () => {
      const inspector = await mountInspector({
        view: "changes",
        visible: false,
      });
      try {
        const top = inspector.outside.querySelector<HTMLElement>("[data-top]")!;
        await act(async () => top.focus());
        await inspector.set({ visible: true });
        expect(active()?.matches(".diff-content-view")).toBe(true);
      } finally {
        await inspector.unmount();
      }
    });

    test("typed text and an open menu keep the keys", async () => {
      const typed = await mountInspector({ view: "files", entry: file });
      try {
        const field = typed.outside.querySelector<HTMLElement>("[data-field]")!;
        await act(async () => field.focus());
        await typed.set({ view: "changes" });
        expect(active()).toBe(field);
        const menu = typed.outside.querySelector<HTMLElement>("[data-menu]")!;
        await act(async () => menu.focus());
        await typed.set({ view: "files" });
        expect(active()).toBe(menu);
      } finally {
        await typed.unmount();
      }
    });

    test("Tab, and the tab strip's arrows, leave the focus where they put it", async () => {
      const inspector = await mountInspector({ view: "files", entry: file });
      try {
        // Shift+Tab from the content to the tabs: they stay there.
        await inspector.key(active()!, "Tab");
        await act(async () => inspector.tab("Files").focus());
        await frames();
        expect(active()).toBe(inspector.tab("Files"));
        await inspector.key(inspector.tab("Files"), "ArrowRight");
        expect(active()).toBe(inspector.tab("Changes"));
        await inspector.key(inspector.tab("Changes"), "ArrowRight");
        expect(active()).toBe(inspector.tab("Commits"));
      } finally {
        await inspector.unmount();
      }
    });
  });
}
