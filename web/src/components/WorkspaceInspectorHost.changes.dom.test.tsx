import { describe, expect, mock, test } from "bun:test";

/**
 * The inspector's frame around Changes (upstream WorkspaceInspectorHost):
 * its tab strip, the Changes badge, History's availability and the state
 * of a checkout that is gone. The views it holds are stand-ins; their own
 * behavior is pinned in DiffViewerPanel.behavior and DiffContentView.behavior
 * (plan: review into the inspector, phase A).
 */
if (process.env.ROAMGATE_INSPECTOR_FRAME_DOM_TEST !== "1") {
  test("inspector frame in an isolated DOM runtime", async () => {
    const child = Bun.spawn([process.execPath, "test", import.meta.path], {
      env: { ...process.env, ROAMGATE_INSPECTOR_FRAME_DOM_TEST: "1" },
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
  const stub = (name: string) => () => (
    <div data-stub={name} aria-label={name} />
  );
  mock.module("./AgentHistoryDrawer", () => ({
    AgentHistoryDrawer: stub("history"),
  }));
  mock.module("./FileExplorerDialog", () => ({
    FileExplorerPanel: stub("files"),
  }));
  mock.module("./FilePreviewTabs", () => ({
    FilePreviewTabs: stub("tabs"),
  }));
  mock.module("./PullRequestCard", () => ({
    PullRequestCard: stub("pull-request"),
  }));
  const diffPanel = await import("./DiffViewerPanel");
  mock.module("./DiffViewerPanel", () => ({
    ...diffPanel,
    DiffViewerPanel: stub("changes-tree"),
  }));
  const preview = await import("./FilePreviewContent");
  mock.module("./FilePreviewContent", () => ({
    ...preview,
    FilePreviewContent: stub("file-preview"),
  }));
  mock.module("./DiffContentView", () => ({
    DiffContentView: stub("changes-diff"),
  }));
  mock.module("./GitCommitHistory", () => ({
    GitCommitHistory: stub("commits"),
  }));

  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { WorkspaceInspectorHost } = await import("./WorkspaceInspectorHost");
  type Props = Parameters<typeof WorkspaceInspectorHost>[0];
  type View = Props["state"]["view"];
  type Workspace = NonNullable<Props["workspace"]>;

  const workspace: Workspace = {
    workspace_id: "w1",
    number: 1,
    label: "Repo",
    focused: true,
    pane_count: 1,
    tab_count: 1,
    agent_status: "",
    worktree: {
      repo_name: "repo",
      checkout_path: "/repo",
      git_status: {
        branch: "main",
        ahead: 0,
        behind: 0,
        staged: 1,
        unstaged: 2,
        untracked: 3,
        conflicted: 1,
        dirty: true,
      },
    },
  } as unknown as Workspace;

  async function mountInspector(options: {
    view?: View;
    workspace?: Workspace;
    agentPane?: boolean;
  }) {
    let view: View = options.view ?? "changes";
    const views: View[] = [];
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const client = {
      connectionId: "local",
      generation: 1,
      serverRuntimeGeneration: 1,
      isCurrent: () => true,
      acceptsServerGeneration: () => true,
      call: async () => ({}),
    } as unknown as Props["connectionClient"];
    const empty = { entry: null, preview: null, loading: false, error: null };
    const render = () =>
      act(async () =>
        root.render(
          <WorkspaceInspectorHost
            state={{
              scope: {
                kind: "workspace",
                connectionId: "local",
                workspaceId: "w1",
              } as Props["state"]["scope"],
              open: true,
              view,
              dock: "right",
              size: 480,
              expanded: false,
            }}
            visible
            workspace={"workspace" in options ? options.workspace : workspace}
            historyPane={
              options.agentPane
                ? ({ pane_id: "p1", agent: "claude" } as Props["historyPane"])
                : undefined
            }
            fileSelection={empty as Props["fileSelection"]}
            onSelectFileTab={() => {}}
            previewRequestRef={{ current: 0 }}
            diffSelection={
              {
                entry: null,
                file: null,
                loading: false,
                error: null,
                entries: [],
                files: {},
                fileErrors: {},
              } as unknown as Props["diffSelection"]
            }
            connectionClient={client}
            onFileSelectionChange={() => {}}
            onDiffSelectionChange={() => {}}
            onOpenDiffFile={() => {}}
            annotations={[]}
            onCreateAnnotation={() => {}}
            onReanchorFileAnnotations={() => {}}
            onReanchorDiffAnnotations={() => {}}
            onEditAnnotation={() => {}}
            onOpenDocument={() => {}}
            onRefreshFile={() => {}}
            onViewChange={(next) => {
              views.push(next);
              view = next;
              void render();
            }}
            onDockChange={() => {}}
            onExpandedChange={() => {}}
            onClose={() => {}}
            onBack={() => {}}
          />,
        ),
      );
    await render();
    const tab = (name: string) =>
      [...host.querySelectorAll<HTMLButtonElement>("[role=tab]")].find((each) =>
        each.textContent?.trim().startsWith(name),
      )!;
    return {
      host,
      views,
      tab,
      tabs: () =>
        [...host.querySelectorAll<HTMLButtonElement>("[role=tab]")].map(
          (each) => ({
            text: (each.textContent ?? "").trim(),
            selected: each.getAttribute("aria-selected") === "true",
            disabled: each.disabled,
            tabbable: each.tabIndex === 0,
          }),
        ),
      async key(name: string, key: string) {
        await act(async () => {
          tab(name).dispatchEvent(
            new KeyboardEvent("keydown", {
              key,
              bubbles: true,
              cancelable: true,
            }),
          );
        });
        await act(async () => {});
      },
      async unmount() {
        await act(async () => root.unmount());
        host.remove();
      },
    };
  }

  describe("inspector frame", () => {
    test("the Changes tab counts the checkout's changed files; none, no count", async () => {
      const inspector = await mountInspector({});
      try {
        // Staged, unstaged, untracked and conflicted: 1 + 2 + 3 + 1.
        expect(inspector.tab("Changes").textContent?.trim()).toBe("Changes7");
      } finally {
        await inspector.unmount();
      }
      const clean = await mountInspector({
        workspace: {
          ...workspace,
          worktree: {
            ...workspace.worktree,
            git_status: {
              ...workspace.worktree!.git_status!,
              staged: 0,
              unstaged: 0,
              untracked: 0,
              conflicted: 0,
            },
          },
        } as Workspace,
      });
      try {
        expect(clean.tab("Changes").textContent?.trim()).toBe("Changes");
      } finally {
        await clean.unmount();
      }
    });

    test("History is disabled without an agent pane, and its tab skipped by the keys", async () => {
      const inspector = await mountInspector({});
      try {
        expect(inspector.tab("History").disabled).toBe(true);
        expect(inspector.tab("History").title).toBe(
          "Select an active agent pane to view history",
        );
        await inspector.key("Changes", "End");
        expect(inspector.views.slice(-1)[0]).toBe("commits");
      } finally {
        await inspector.unmount();
      }
      const withAgent = await mountInspector({ agentPane: true });
      try {
        expect(withAgent.tab("History").disabled).toBe(false);
        expect(withAgent.tab("History").title).toBe("Agent history");
        await withAgent.key("Changes", "End");
        expect(withAgent.views.slice(-1)[0]).toBe("history");
      } finally {
        await withAgent.unmount();
      }
    });

    test("the tab strip: Left and Right wrap around, Home and End go to the ends, the tab picked takes the focus", async () => {
      const inspector = await mountInspector({ view: "files" });
      try {
        expect(inspector.tabs().map((each) => each.tabbable)).toEqual([
          true,
          false,
          false,
          false,
        ]);
        await inspector.key("Files", "ArrowRight");
        expect(inspector.views.slice(-1)[0]).toBe("changes");
        expect(document.activeElement).toBe(inspector.tab("Changes"));
        expect(inspector.tabs()[1]).toMatchObject({
          selected: true,
          tabbable: true,
        });
        await inspector.key("Changes", "ArrowRight");
        expect(inspector.views.slice(-1)[0]).toBe("commits");
        // Without History, Right from Commits wraps to Files.
        await inspector.key("Commits", "ArrowRight");
        expect(inspector.views.slice(-1)[0]).toBe("files");
        await inspector.key("Files", "ArrowLeft");
        expect(inspector.views.slice(-1)[0]).toBe("commits");
        await inspector.key("Commits", "Home");
        expect(inspector.views.slice(-1)[0]).toBe("files");
        await inspector.key("Files", "End");
        expect(inspector.views.slice(-1)[0]).toBe("commits");
        // Other keys leave the tab alone.
        const count = inspector.views.length;
        await inspector.key("Commits", "a");
        expect(inspector.views.length).toBe(count);
      } finally {
        await inspector.unmount();
      }
    });

    test("a workspace that is gone shows Checkout unavailable, not its views", async () => {
      const inspector = await mountInspector({ workspace: undefined });
      try {
        expect(inspector.host.textContent).toContain("Checkout unavailable");
        expect(inspector.host.textContent).toContain(
          "The workspace used to route this Inspector is no longer open.",
        );
        expect(inspector.host.textContent).toContain("Unavailable checkout");
        expect(inspector.host.querySelector("[data-stub]")).toBeNull();
        // The tabs stay, without a count.
        expect(inspector.tab("Changes").textContent?.trim()).toBe("Changes");
      } finally {
        await inspector.unmount();
      }
    });
  });
}
