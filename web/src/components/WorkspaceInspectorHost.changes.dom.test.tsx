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
  const { useContext } = await import("react");
  const { InspectorCommandsContext } = await import("../useInspectorCommands");
  type ReactNode = import("react").ReactNode;
  /** What the host last gave Changes' diff, and its `:` commands. */
  const diffSeen: {
    repo?: { root: string; own: boolean };
    run?: (input: string) => void;
    /** The toolbar's end (Review only) and the scope line, as given. */
    headEnd?: ReactNode;
    scopeControls?: ReactNode;
    /** The review the scope is (plan phase 6), and the comment writer. */
    reviewScope?: unknown;
    onCreateAnnotation?: (input: Record<string, unknown>) => void;
  } = {};
  mock.module("./DiffContentView", () => ({
    DiffContentView: (props: {
      repo?: { root: string; own: boolean };
      headEnd?: ReactNode;
      scopeControls?: ReactNode;
      reviewScope?: unknown;
      onCreateAnnotation?: (input: Record<string, unknown>) => void;
    }) => {
      diffSeen.repo = props.repo;
      diffSeen.reviewScope = props.reviewScope;
      diffSeen.onCreateAnnotation = props.onCreateAnnotation;
      diffSeen.run = useContext(InspectorCommandsContext)?.run;
      diffSeen.headEnd = props.headEnd;
      diffSeen.scopeControls = props.scopeControls;
      // Drawn as the diff's toolbar draws them.
      return (
        <div data-stub="changes-diff" aria-label="changes-diff">
          {props.scopeControls ? (
            <div data-stub="scope">{props.scopeControls}</div>
          ) : null}
          {props.headEnd ? (
            <div data-stub="head-end">{props.headEnd}</div>
          ) : null}
        </div>
      );
    },
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
    /** The checkout's root, as Changes' summary gives it. */
    root?: string;
    /** The changed files Changes lists, and how many are untracked. */
    entries?: { path: string; kind: string }[];
    untracked?: number;
    /** What Changes' panel shows: its scope, and its Last step. */
    scopeMode?: string;
    step?: Record<string, unknown>;
    /** A review asked to show in Changes (the review toggle). */
    reviewGoTo?: Props["reviewGoTo"];
    /** The comments the host writes. */
    created?: Record<string, unknown>[];
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
                entries: options.entries ?? [],
                files: {},
                fileErrors: {},
                ...(options.root ? { root: options.root } : {}),
                ...(options.untracked !== undefined
                  ? { untracked: options.untracked }
                  : {}),
                ...(options.scopeMode ? { scopeMode: options.scopeMode } : {}),
                ...(options.step ? { step: options.step } : {}),
              } as unknown as Props["diffSelection"]
            }
            {...(options.reviewGoTo ? { reviewGoTo: options.reviewGoTo } : {})}
            connectionClient={client}
            onFileSelectionChange={() => {}}
            onDiffSelectionChange={() => {}}
            onOpenDiffFile={() => {}}
            annotations={[]}
            onCreateAnnotation={(input) =>
              options.created?.push(input as Record<string, unknown>)
            }
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

    test("Changes' diff is given the repository shown, so only its threads are drawn; ( and ) switch it", async () => {
      const { PREFS_KEY } = await import("../reviewPrefs");
      const { rememberReviewSnapshot } = await import("../review");
      localStorage.setItem(
        PREFS_KEY,
        JSON.stringify({ reviewIn: "changes", vim: true }),
      );
      // Two repositories of the workspace, each with a review.
      for (const root of ["/repo", "/repo2"])
        rememberReviewSnapshot({
          session: {
            id: `s${root}`,
            connectionId: "local",
            workspaceId: "w1",
            root,
            title: root,
            target: { kind: "worktree" },
            gitlab: false,
            summary: "",
            agent: {},
            createdAt: "2026-11-10T10:00:00Z",
            updatedAt: "2026-11-10T10:00:00Z",
          },
          threads: [],
        } as unknown as import("../../../shared/review").ReviewSnapshot);
      const inspector = await mountInspector({ root: "/repo" });
      try {
        await act(async () => {});
        expect(diffSeen.repo).toEqual({ root: "/repo", own: true });
        await act(async () => diffSeen.run?.("nextrepo"));
        await act(async () => {});
        expect(diffSeen.repo).toEqual({ root: "/repo2", own: false });
        await act(async () => diffSeen.run?.("prevrepo"));
        await act(async () => {});
        expect(diffSeen.repo).toEqual({ root: "/repo", own: true });
      } finally {
        await inspector.unmount();
        localStorage.removeItem(PREFS_KEY);
      }
    });

    test("in Changes, the scope line is the host's controls: the repository picker, what is compared and the counts", async () => {
      const { PREFS_KEY } = await import("../reviewPrefs");
      localStorage.setItem(
        PREFS_KEY,
        JSON.stringify({ reviewIn: "changes", vim: true }),
      );
      // Two repositories of the workspace, each with a review.
      const { rememberReviewSnapshot } = await import("../review");
      for (const root of ["/repo", "/repo2"])
        rememberReviewSnapshot({
          session: {
            id: `s${root}`,
            connectionId: "local",
            workspaceId: "w1",
            root,
            title: root,
            target: { kind: "worktree" },
            gitlab: false,
            summary: "",
            agent: {},
            createdAt: "2026-11-10T10:00:00Z",
            updatedAt: "2026-11-10T10:00:00Z",
          },
          threads: [],
        } as unknown as import("../../../shared/review").ReviewSnapshot);
      const inspector = await mountInspector({
        root: "/repo",
        entries: [
          { path: "a.ts", kind: "unstaged" },
          { path: "b.ts", kind: "untracked" },
        ],
        untracked: 1,
      });
      try {
        await act(async () => {});
        expect(diffSeen.scopeControls).toBeDefined();
        const bar = inspector.host.querySelector<HTMLElement>(
          "[data-stub=scope] .changes-scope-bar",
        );
        expect(bar?.getAttribute("aria-label")).toBe(
          "repo \u00b7 Working tree: uncommitted changes \u00b7 2 files (1 untracked)",
        );
        // The workspace's repositories: a picker, p and ( ) its keys.
        expect(
          bar?.querySelector(
            '[aria-label="Repository (p; ( and ) the previous and next)"]',
          ),
        ).not.toBeNull();
        expect(
          bar?.querySelector('[aria-label="What Changes compares"]')
            ?.textContent,
        ).toContain("Working tree: uncommitted changes");
        expect(bar?.querySelector(".changes-scope-facts")?.textContent).toBe(
          "2 files (1 untracked)",
        );
        // Not Review only: nothing at the toolbar's end.
        expect(diffSeen.headEnd).toBeUndefined();
      } finally {
        await inspector.unmount();
        localStorage.removeItem(PREFS_KEY);
      }
    });

    test("in Changes, each scope is its review by a lookup: the Last step's comments go to that step's review; a review asked for is the scope, named in the scope line", async () => {
      const { PREFS_KEY } = await import("../reviewPrefs");
      localStorage.setItem(
        PREFS_KEY,
        JSON.stringify({ reviewIn: "changes", vim: true }),
      );
      const step = {
        step: "1763200000000-abcdef01",
        before: "a".repeat(40),
        after: "b".repeat(40),
        at: "2026-11-15T10:02:00.000Z",
      };
      const created: Record<string, unknown>[] = [];
      const lastStep = await mountInspector({
        root: "/repo",
        entries: [{ path: "a.ts", kind: "last-step" }],
        scopeMode: "last-step",
        step,
        created,
      });
      try {
        await act(async () => {});
        expect(diffSeen.reviewScope).toEqual({ kind: "step", step });
        diffSeen.onCreateAnnotation?.({
          source: "diff",
          path: "a.ts",
          kind: "last-step",
          side: "new",
          line: 1,
          hunk: "",
          quote: "x",
          comment: "Why?",
        });
        expect(created[0]?.target).toEqual({ kind: "step", ...step });
      } finally {
        await lastStep.unmount();
      }
      // A compare opened by name shows as the scope, named in the line.
      const { rememberReviewSnapshot } = await import("../review");
      rememberReviewSnapshot({
        session: {
          id: "r9",
          connectionId: "local",
          workspaceId: "w1",
          root: "/repo",
          title: "topic-old vs topic",
          target: {
            kind: "range",
            base: "topic-old",
            head: "topic",
            compare: true,
          },
          gitlab: false,
          summary: "",
          agent: {},
          createdAt: "2026-11-10T10:00:00Z",
          updatedAt: "2026-11-10T10:00:00Z",
        },
        threads: [],
      } as unknown as import("../../../shared/review").ReviewSnapshot);
      const shown = await mountInspector({
        root: "/repo",
        entries: [{ path: "a.ts", kind: "unstaged" }],
        reviewGoTo: { review: "r9", at: Date.now() },
      });
      try {
        await act(async () => {});
        expect(diffSeen.reviewScope).toEqual({
          kind: "review",
          sessionId: "r9",
        });
        const bar = shown.host.querySelector<HTMLElement>(
          "[data-stub=scope] .changes-scope-bar",
        );
        expect(bar?.getAttribute("aria-label")).toBe(
          "repo \u00b7 topic-old vs topic",
        );
      } finally {
        await shown.unmount();
        localStorage.removeItem(PREFS_KEY);
      }
    });

    test("in Changes, Review only gives the diff's one-row header Show all and Zen's docked way out; Show all brings the inspector back", async () => {
      const { PREFS_KEY } = await import("../reviewPrefs");
      localStorage.setItem(
        PREFS_KEY,
        JSON.stringify({ reviewIn: "changes", vim: true }),
      );
      const inspector = await mountInspector({ root: "/repo" });
      try {
        await act(async () => diffSeen.run?.("only"));
        await act(async () => {});
        const end = inspector.host.querySelector<HTMLElement>(
          "[data-stub=head-end] .diff-review-only-end",
        );
        expect(end).not.toBeNull();
        expect(
          [...(end?.querySelectorAll("button") ?? [])].map(
            (button) => button.textContent,
          ),
        ).toEqual(["Show all"]);
        // Zen's way out docks there (in app Zen it draws its Exit Zen).
        expect(end?.querySelector(".zen-dock[data-zen-dock]")).not.toBeNull();
        // No floating hint over the review: its header has the way out.
        expect(
          inspector.host.querySelector(".inspector-review-only-hint"),
        ).toBeNull();
        expect(
          inspector.host
            .querySelector(
              ".inspector-changes-resource, [data-stub=changes-diff]",
            )
            ?.closest(".is-review-only"),
        ).not.toBeNull();
        await act(async () =>
          end?.querySelector<HTMLButtonElement>("button")?.click(),
        );
        await act(async () => {});
        expect(diffSeen.headEnd).toBeUndefined();
        expect(inspector.host.querySelector("[data-stub=head-end]")).toBeNull();
      } finally {
        await inspector.unmount();
        localStorage.removeItem(PREFS_KEY);
      }
    });

    test("on classic Changes the host gives no scope controls nor header end; Review only floats its Show all", async () => {
      const { PREFS_KEY } = await import("../reviewPrefs");
      const { roamgateLocalStorage } = await import("../browserStorage");
      roamgateLocalStorage.setItem(
        PREFS_KEY,
        JSON.stringify({ reviewIn: "classic", vim: true }),
      );
      const inspector = await mountInspector({ root: "/repo" });
      try {
        expect(diffSeen.scopeControls).toBeUndefined();
        await act(async () => diffSeen.run?.("only"));
        await act(async () => {});
        expect(diffSeen.headEnd).toBeUndefined();
        const hint = inspector.host.querySelector(
          ".inspector-review-only-hint",
        );
        expect(hint?.textContent).toBe("Show all");
      } finally {
        await inspector.unmount();
        roamgateLocalStorage.removeItem(PREFS_KEY);
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
