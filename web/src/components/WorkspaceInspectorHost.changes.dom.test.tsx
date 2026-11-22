import { describe, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";

/**
 * The inspector's frame around Changes (upstream WorkspaceInspectorHost):
 * its tab strip, the Changes badge, History's availability and the state
 * of a checkout that is gone. The views it holds are stand-ins; their own
 * behavior is pinned in DiffViewerPanel.behavior and DiffContentView.behavior.
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
  /** The tree's last props: a file picked there drills in to its diff. */
  const treeSeen: {
    onSelectionChange?: (
      selection: { entry: unknown },
      meta?: { userInitiated?: boolean },
    ) => void;
    /** A file of a branch, commit or range review picked in the tree. */
    onPickViewFile?: (path: string) => void;
  } = {};
  mock.module("./DiffViewerPanel", () => ({
    ...diffPanel,
    DiffViewerPanel: (props: typeof treeSeen) => {
      treeSeen.onSelectionChange = props.onSelectionChange;
      treeSeen.onPickViewFile = props.onPickViewFile;
      return <div data-stub="changes-tree" aria-label="changes-tree" />;
    },
  }));
  const preview = await import("./FilePreviewContent");
  mock.module("./FilePreviewContent", () => ({
    ...preview,
    FilePreviewContent: stub("file-preview"),
  }));
  const { useContext, useEffect } = await import("react");
  const { InspectorCommandsContext } = await import("../useInspectorCommands");
  type ReactNode = import("react").ReactNode;
  /** What the host last gave Changes' diff, and its `:` commands. */
  const diffSeen: {
    repo?: { root: string; own: boolean };
    run?: (input: string) => void;
    /** The toolbar's end (Review only) and the scope line, as given. */
    headEnd?: ReactNode;
    scopeControls?: ReactNode;
    /** The review the scope is, and the comment writer. */
    reviewScope?: unknown;
    onCreateAnnotation?: (input: Record<string, unknown>) => void;
    /** What the review in Changes is handed from the host (its jobs). */
    agentPanes?: readonly { paneId: string; agent: string }[];
    onOpenFile?: (
      entry: unknown,
      at?: { line?: number; rendered?: boolean },
    ) => void;
    onCloseReview?: (how: "command" | "escape") => void;
    onShowReviews?: () => void;
    onFocusAgentPane?: (paneId: string) => void;
    forgeHost?: {
      onShowReview?: (snapshot: unknown) => void;
      onOpenLocal?: (root: string) => void;
    };
    cursorGoTo?: unknown;
    onReviewGone?: (sessionId: string, message: string) => void;
    /** The files of the review's view (a branch, commit or range). */
    onViewEntries?: (
      view: { label: string; entries: readonly unknown[] } | null,
    ) => void;
    /** How often the diff was mounted, and unmounted. */
    mounts: number;
    unmounts: number;
  } = { mounts: 0, unmounts: 0 };
  mock.module("./DiffContentView", () => ({
    DiffContentView: (
      props: {
        repo?: { root: string; own: boolean };
        headEnd?: ReactNode;
        scopeControls?: ReactNode;
        reviewScope?: unknown;
        onCreateAnnotation?: (input: Record<string, unknown>) => void;
      } & Pick<
        typeof diffSeen,
        | "agentPanes"
        | "onOpenFile"
        | "onCloseReview"
        | "onShowReviews"
        | "onFocusAgentPane"
        | "forgeHost"
        | "cursorGoTo"
        | "onReviewGone"
        | "onViewEntries"
      >,
    ) => {
      useEffect(() => {
        diffSeen.mounts += 1;
        return () => {
          diffSeen.unmounts += 1;
        };
      }, []);
      diffSeen.agentPanes = props.agentPanes;
      diffSeen.onOpenFile = props.onOpenFile;
      diffSeen.onCloseReview = props.onCloseReview;
      diffSeen.onShowReviews = props.onShowReviews;
      diffSeen.onFocusAgentPane = props.onFocusAgentPane;
      diffSeen.forgeHost = props.forgeHost;
      diffSeen.cursorGoTo = props.cursorGoTo;
      diffSeen.onReviewGone = props.onReviewGone;
      diffSeen.onViewEntries = props.onViewEntries;
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
  /** The directories Changes' repository scan was asked about. */
  const scans: { dirs: string[]; agentDirs: string[] }[] = [];
  const reviewRepos = await import("../reviewRepos");
  mock.module("../reviewRepos", () => ({
    ...reviewRepos,
    scanRepos: async (
      _connection: string,
      dirs: string[],
      agentDirs: string[],
    ) => {
      scans.push({ dirs, agentDirs });
      return [];
    },
  }));

  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { WorkspaceInspectorHost } = await import("./WorkspaceInspectorHost");
  const { inspectorProps, inspectorWorkspace } = await import(
    "./WorkspaceInspectorHost.testkit"
  );
  type Props = Parameters<typeof WorkspaceInspectorHost>[0];
  type View = Props["state"]["view"];
  type Workspace = NonNullable<Props["workspace"]>;

  const workspace = inspectorWorkspace({
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
    } as Workspace["worktree"],
  });

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
    /** The file Changes shows. */
    entry?: { path: string; kind: string };
    /** Calls of the host's onBack (the diff back to its tree). */
    backs?: string[];
    /** The inspector expanded; its onExpandedChange and onClose calls. */
    expanded?: boolean;
    calls?: string[];
    /** The page shows the inspector's workspace (default: yes). */
    visible?: boolean;
    /** The host's callbacks for the review in Changes. */
    onOpenDiffFile?: Props["onOpenDiffFile"];
    onCloseReview?: Props["onCloseReview"];
    onShowReviews?: Props["onShowReviews"];
    onFocusAgentPane?: Props["onFocusAgentPane"];
    onReviewGone?: Props["onReviewGone"];
  }) {
    let view: View = options.view ?? "changes";
    const views: View[] = [];
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const render = () =>
      act(async () =>
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
                expanded: options.expanded ?? false,
              } as Props["state"],
              visible: options.visible ?? true,
              workspace: "workspace" in options ? options.workspace : workspace,
              historyPane: options.agentPane
                ? ({ pane_id: "p1", agent: "claude" } as Props["historyPane"])
                : undefined,
              diffSelection: {
                entry: options.entry ?? null,
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
              } as unknown as Props["diffSelection"],
              ...(options.reviewGoTo ? { reviewGoTo: options.reviewGoTo } : {}),
              onOpenDiffFile: options.onOpenDiffFile ?? (() => {}),
              ...(options.onCloseReview
                ? { onCloseReview: options.onCloseReview }
                : {}),
              ...(options.onShowReviews
                ? { onShowReviews: options.onShowReviews }
                : {}),
              ...(options.onFocusAgentPane
                ? { onFocusAgentPane: options.onFocusAgentPane }
                : {}),
              ...(options.onReviewGone
                ? { onReviewGone: options.onReviewGone }
                : {}),
              onCreateAnnotation: (input) =>
                options.created?.push(input as Record<string, unknown>),
              onViewChange: (next) => {
                views.push(next);
                view = next;
                void render();
              },
              onExpandedChange: (expanded) =>
                options.calls?.push(`expanded ${expanded}`),
              onClose: () => options.calls?.push("close"),
              onBack: () => options.backs?.push("back"),
            })}
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
      /** Drawn again with these options changed (the view too). */
      async set(next: Partial<typeof options>) {
        Object.assign(options, next);
        if (next.view) view = next.view;
        await render();
        await act(async () => {});
      },
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
        expect(inspector.views.slice(-1)[0]).toBe("reviews");
        // Left from the board's tabs skips History for Commits.
        await inspector.key("Reviews", "ArrowLeft");
        expect(inspector.views.slice(-1)[0]).toBe("work");
        await inspector.key("Work", "ArrowLeft");
        expect(inspector.views.slice(-1)[0]).toBe("commits");
      } finally {
        await inspector.unmount();
      }
      const withAgent = await mountInspector({ agentPane: true });
      try {
        expect(withAgent.tab("History").disabled).toBe(false);
        expect(withAgent.tab("History").title).toBe("Agent history");
        await withAgent.key("Changes", "End");
        await withAgent.key("Reviews", "ArrowLeft");
        await withAgent.key("Work", "ArrowLeft");
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
        // Without History, Right from Commits goes to Work; from Reviews,
        // the last tab, it wraps to Files.
        await inspector.key("Commits", "ArrowRight");
        expect(inspector.views.slice(-1)[0]).toBe("work");
        await inspector.key("Work", "ArrowRight");
        expect(inspector.views.slice(-1)[0]).toBe("reviews");
        await inspector.key("Reviews", "ArrowRight");
        expect(inspector.views.slice(-1)[0]).toBe("files");
        await inspector.key("Files", "ArrowLeft");
        expect(inspector.views.slice(-1)[0]).toBe("reviews");
        await inspector.key("Commits", "Home");
        expect(inspector.views.slice(-1)[0]).toBe("files");
        await inspector.key("Files", "End");
        expect(inspector.views.slice(-1)[0]).toBe("reviews");
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
      localStorage.setItem(PREFS_KEY, "{}");
      localStorage.setItem("vimKeys", "true");
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

    test("Open and Rendered in a review of another repository name that repository, so Files reads the file from it", async () => {
      // The review shown and its repository stay this test's own.
      const saved = Object.entries(localStorage);
      const { rememberReviewSnapshot } = await import("../review");
      // The parent repository's range review, shown in a worktree's workspace.
      rememberReviewSnapshot({
        session: {
          id: "rparent",
          connectionId: "local",
          workspaceId: "w1",
          root: "/parent",
          title: "RFC",
          target: { kind: "range", base: "rfc-base", head: "main" },
          gitlab: false,
          summary: "",
          agent: {},
          createdAt: "2026-11-19T10:00:00Z",
          updatedAt: "2026-11-19T10:00:00Z",
        },
        threads: [],
      } as unknown as import("../../../shared/review").ReviewSnapshot);
      const opened: unknown[][] = [];
      const inspector = await mountInspector({
        root: "/repo",
        entries: [{ path: "rfcs/0052.md", kind: "unstaged" }],
        reviewGoTo: { review: "rparent", root: "/parent", at: Date.now() },
        onOpenDiffFile: (...args) => opened.push(args),
      });
      try {
        await act(async () => {});
        expect(diffSeen.reviewScope).toEqual({
          kind: "review",
          sessionId: "rparent",
        });
        await act(async () =>
          diffSeen.onOpenFile?.({ path: "rfcs/0052.md" }, { rendered: true }),
        );
        await act(async () => diffSeen.onOpenFile?.({ path: "rfcs/0052.md" }));
        expect(opened).toEqual([
          [{ path: "rfcs/0052.md" }, { rendered: true, root: "/parent" }],
          [{ path: "rfcs/0052.md" }, { root: "/parent" }],
        ]);
      } finally {
        await inspector.unmount();
        localStorage.clear();
        for (const [key, value] of saved) localStorage.setItem(key, value);
        const { rememberChangesRepo } = await import("../changesRepo");
        const { resourceOwnerKey } = await import("../workspaceResource");
        rememberChangesRepo(
          resourceOwnerKey({
            kind: "workspace",
            connectionId: "local",
            workspaceId: "w1",
          } as Parameters<typeof resourceOwnerKey>[0]),
          undefined,
        );
      }
    });

    test("in Changes, the scope line is the host's controls: the repository picker, what is compared and the counts", async () => {
      const { PREFS_KEY } = await import("../reviewPrefs");
      localStorage.setItem(PREFS_KEY, "{}");
      localStorage.setItem("vimKeys", "true");
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
      localStorage.setItem(PREFS_KEY, "{}");
      localStorage.setItem("vimKeys", "true");
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

    test("the review shown is the workspace's again after a page reload; the others opened there are listed in the scope picker, the latest first, named as what they show", async () => {
      // None remembered from the suite's other reviews.
      localStorage.removeItem("roamgate:reviewChangesRecent");
      const { PREFS_KEY } = await import("../reviewPrefs");
      localStorage.setItem(PREFS_KEY, "{}");
      localStorage.setItem("vimKeys", "true");
      const { rememberReviewSnapshot } = await import("../review");
      const sha = "d272642486c9f06335ef462e866f0798d7a3a4ad";
      const review = (
        id: string,
        title: string,
        target: Record<string, unknown>,
      ) =>
        rememberReviewSnapshot({
          session: {
            id,
            connectionId: "local",
            workspaceId: "w1",
            root: "/repo",
            title,
            target,
            gitlab: false,
            summary: "",
            agent: {},
            createdAt: "2026-11-16T10:00:00Z",
            updatedAt: "2026-11-16T10:00:00Z",
          },
          threads: [],
        } as unknown as import("../../../shared/review").ReviewSnapshot);
      review("rc", `${sha}^..${sha}`, {
        kind: "range",
        base: `${sha}^`,
        head: sha,
      });
      review("rb", "topic vs main", {
        kind: "range",
        base: "main",
        head: "topic",
      });
      const first = await mountInspector({
        root: "/repo",
        entries: [{ path: "a.ts", kind: "unstaged" }],
        reviewGoTo: { review: "rc", at: Date.now() },
      });
      try {
        await act(async () => {});
        // Its commit read: named by it, as it is remembered.
        await act(async () =>
          diffSeen.onViewEntries?.({
            label: "1/1 d2726424 Fix the pads",
            title: "d2726424 Fix the pads",
            entries: [{ path: "a.ts", kind: "branch", status: "M" }],
          } as Parameters<NonNullable<typeof diffSeen.onViewEntries>>[0]),
        );
        await first.set({ reviewGoTo: { review: "rb", at: Date.now() + 1 } });
        expect(diffSeen.reviewScope).toEqual({
          kind: "review",
          sessionId: "rb",
        });
      } finally {
        await first.unmount();
      }
      // The page reloaded (a restart's new build): no review asked for,
      // the one shown is back, the other one offered.
      const again = await mountInspector({
        root: "/repo",
        entries: [{ path: "a.ts", kind: "unstaged" }],
      });
      try {
        await act(async () => {});
        expect(diffSeen.reviewScope).toEqual({
          kind: "review",
          sessionId: "rb",
        });
        const trigger = again.host.querySelector<HTMLElement>(
          '[data-stub=scope] [aria-label="What Changes compares"]',
        );
        await act(async () => {
          trigger?.dispatchEvent(
            new PointerEvent("pointerdown", { bubbles: true, button: 0 }),
          );
          trigger?.click();
        });
        const options = () =>
          [...document.querySelectorAll<HTMLElement>("[cmdk-item]")].map(
            (each) => ({
              element: each,
              title: each.querySelector(".command-item-title")?.textContent,
              detail: each.querySelector(".command-item-detail")?.textContent,
            }),
          );
        // The review shown (by its title), then the others.
        expect(options().map((each) => each.title)).toEqual([
          "topic vs main",
          "commit d2726424 Fix the pads",
          "Working tree: uncommitted changes",
          expect.stringContaining("vs its base") as unknown as string,
          "Last step: what the agent's last step changed",
        ]);
        expect(options()[1]?.detail).toBe("opened here now");
        // Picked: that review is the scope, and the one remembered.
        await act(async () => {
          options()[1]?.element.click();
        });
        await act(async () => {});
        expect(diffSeen.reviewScope).toEqual({
          kind: "review",
          sessionId: "rc",
        });
        // Its own scope picked: none shown after the next reload.
        await act(async () => {
          trigger?.click();
        });
        await act(async () => {
          options()
            .find((each) => each.title?.startsWith("Working tree"))
            ?.element.click();
        });
      } finally {
        await again.unmount();
      }
      const own = await mountInspector({
        root: "/repo",
        entries: [{ path: "a.ts", kind: "unstaged" }],
      });
      try {
        await act(async () => {});
        expect(diffSeen.reviewScope).not.toEqual(
          expect.objectContaining({ kind: "review" }),
        );
      } finally {
        await own.unmount();
        localStorage.removeItem(PREFS_KEY);
        localStorage.removeItem("roamgate:reviewChangesRecent");
      }
    });

    test("a review of one commit is named in the scope line by its short sha and subject (a root commit too), not SHA^..SHA", async () => {
      const { PREFS_KEY } = await import("../reviewPrefs");
      localStorage.setItem(PREFS_KEY, "{}");
      localStorage.setItem("vimKeys", "true");
      const { rememberReviewSnapshot } = await import("../review");
      const sha = "d272642486c9f06335ef462e866f0798d7a3a4ad";
      rememberReviewSnapshot({
        session: {
          id: "r8",
          connectionId: "local",
          workspaceId: "w1",
          root: "/repo",
          title: `${sha}^..${sha}`,
          target: { kind: "range", base: `${sha}^`, head: sha },
          gitlab: false,
          summary: "",
          agent: {},
          createdAt: "2026-11-16T10:00:00Z",
          updatedAt: "2026-11-16T10:00:00Z",
        },
        threads: [],
      } as unknown as import("../../../shared/review").ReviewSnapshot);
      const shown = await mountInspector({
        root: "/repo",
        entries: [{ path: "a.ts", kind: "unstaged" }],
        reviewGoTo: { review: "r8", at: Date.now() },
      });
      const label = () =>
        shown.host
          .querySelector<HTMLElement>("[data-stub=scope] .changes-scope-bar")
          ?.getAttribute("aria-label");
      try {
        await act(async () => {});
        // Its commit not read yet: by its sha, not SHA^..SHA.
        expect(label()).toBe("repo \u00b7 commit d2726424");
        await act(async () =>
          diffSeen.onViewEntries?.({
            label: "1/1 d2726424 base",
            title: "d2726424 base (root commit)",
            entries: [{ path: "a.txt", kind: "branch", status: "A" }],
          } as Parameters<NonNullable<typeof diffSeen.onViewEntries>>[0]),
        );
        expect(label()).toBe(
          "repo \u00b7 d2726424 base (root commit) \u00b7 1 file",
        );
      } finally {
        await shown.unmount();
        localStorage.removeItem(PREFS_KEY);
      }
    });

    test("a review shown whose code is gone lets go of its pin; with no thread Changes goes back to its own scope and says so, with threads it stays", async () => {
      const { PREFS_KEY } = await import("../reviewPrefs");
      localStorage.setItem(PREFS_KEY, "{}");
      localStorage.setItem("vimKeys", "true");
      const { rememberReviewSnapshot } = await import("../review");
      const { store } = await import("../store");
      const review = (id: string, threads: unknown[]) =>
        rememberReviewSnapshot({
          session: {
            id,
            connectionId: "local",
            workspaceId: "w1",
            root: "/repo",
            title: `${id}^..${id}`,
            target: { kind: "range", base: `${id}^`, head: id },
            gitlab: false,
            summary: "",
            agent: {},
            createdAt: "2026-11-16T10:00:00Z",
            updatedAt: "2026-11-16T10:00:00Z",
          },
          threads,
        } as unknown as import("../../../shared/review").ReviewSnapshot);
      review("c0ffee1", []);
      review("c0ffee2", [{ id: "t1", messages: [] }]);
      const gone: string[] = [];
      const notices: string[] = [];
      const notify = store.notify;
      store.notify = (notice) => {
        notices.push(notice.message);
        return notify.call(store, notice);
      };
      const shown = await mountInspector({
        root: "/repo",
        entries: [{ path: "a.ts", kind: "unstaged" }],
        reviewGoTo: { review: "c0ffee1", at: Date.now() },
        onReviewGone: (id) => gone.push(id),
      });
      try {
        await act(async () => {});
        expect(diffSeen.reviewScope).toEqual({
          kind: "review",
          sessionId: "c0ffee1",
        });
        await act(async () =>
          diffSeen.onReviewGone?.(
            "c0ffee1",
            "Cannot load the diff: The review's base c0ffee1^ is gone",
          ),
        );
        expect(gone).toEqual(["c0ffee1"]);
        expect(diffSeen.reviewScope).not.toEqual({
          kind: "review",
          sessionId: "c0ffee1",
        });
        expect(notices).toEqual(["c0ffee1^..c0ffee1: nothing to show"]);
        // One with threads: unpinned, still shown (they are read there).
        await shown.set({
          reviewGoTo: { review: "c0ffee2", at: Date.now() + 1 },
        });
        expect(diffSeen.reviewScope).toEqual({
          kind: "review",
          sessionId: "c0ffee2",
        });
        await act(async () =>
          diffSeen.onReviewGone?.("c0ffee2", "Cannot load the diff: gone"),
        );
        expect(gone).toEqual(["c0ffee1", "c0ffee2"]);
        expect(diffSeen.reviewScope).toEqual({
          kind: "review",
          sessionId: "c0ffee2",
        });
        expect(notices).toHaveLength(1);
      } finally {
        store.notify = notify;
        await shown.unmount();
        localStorage.removeItem(PREFS_KEY);
      }
    });

    test("in Changes, Review only gives the diff's one-row header Show all and Zen's docked way out; Show all brings the inspector back", async () => {
      const { PREFS_KEY } = await import("../reviewPrefs");
      localStorage.setItem(PREFS_KEY, "{}");
      localStorage.setItem("vimKeys", "true");
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
        ).toEqual(["Show all", "×"]);
        // The review's way out too (the inspector's header is hidden).
        expect(
          end?.querySelector('[aria-label="Close the review"]'),
        ).not.toBeNull();
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

    test("expanded, the inspector keeps its one row of tabs above the review's own row: the six views, Restore, More, Close and Zen's way out", async () => {
      const { PREFS_KEY } = await import("../reviewPrefs");
      localStorage.setItem(PREFS_KEY, JSON.stringify({}));
      const calls: string[] = [];
      const inspector = await mountInspector({
        root: "/repo",
        expanded: true,
        calls,
      });
      try {
        const head = inspector.host.querySelector<HTMLElement>(
          ".workspace-inspector-head",
        )!;
        expect(
          [...head.querySelectorAll("[role=tab]")].map(
            (tab) =>
              tab.querySelector(".workspace-inspector-tab-label")?.textContent,
          ),
        ).toEqual([
          "Files",
          "Changes",
          "Commits",
          "History",
          "Work",
          "Reviews",
        ]);
        // Every tab says what it is, its key when it has one.
        for (const tab of head.querySelectorAll<HTMLElement>("[role=tab]"))
          expect(tab.title).toBeTruthy();
        // The review's row holds no copy of the header any more.
        expect(inspector.host.querySelector(".diff-inspector-end")).toBeNull();
        expect(head.querySelector(".zen-dock[data-zen-dock]")).not.toBeNull();
        // Docking is in More; the header's buttons are Restore and Close.
        expect(
          head
            .querySelector(".workspace-inspector-more")
            ?.getAttribute("data-menu-items")
            ?.split("\n"),
        ).toEqual(["Dock at bottom", "Restore Inspector dock", "Commands"]);
        await act(async () =>
          head
            .querySelector<HTMLButtonElement>(
              "[aria-label='Restore Inspector dock']",
            )
            ?.click(),
        );
        await act(async () =>
          head
            .querySelector<HTMLButtonElement>(
              "[aria-label='Close Workspace Inspector']",
            )
            ?.click(),
        );
        expect(calls).toEqual(["expanded false", "close"]);
        // Review only has its own end.
        await act(async () => diffSeen.run?.("only"));
        await act(async () => {});
        expect(
          inspector.host.querySelector(
            "[data-stub=head-end] .diff-review-only-end",
          ),
        ).not.toBeNull();
      } finally {
        await inspector.unmount();
        localStorage.removeItem(PREFS_KEY);
      }
    });

    test("the app's Zen hides no inspector header: the tabs stay one row above the view", () => {
      const css = readFileSync(
        new URL("./WorkspaceInspectorHost.css", import.meta.url),
        "utf8",
      );
      expect(css).not.toContain("has-zen-end");
      expect(css).not.toContain(".diff-inspector-end");
      expect(css).toContain("container: workspace-inspector / inline-size");
    });

    test("in Changes, Review only hides the merge request card; Show all brings it back", async () => {
      const { PREFS_KEY } = await import("../reviewPrefs");
      localStorage.setItem(PREFS_KEY, "{}");
      localStorage.setItem("vimKeys", "true");
      const inspector = await mountInspector({ root: "/repo" });
      try {
        const card = () =>
          inspector.host.querySelector("[data-stub=pull-request]");
        expect(card()).not.toBeNull();
        await act(async () => diffSeen.run?.("only"));
        await act(async () => {});
        expect(card()).toBeNull();
        await act(async () =>
          inspector.host
            .querySelector<HTMLButtonElement>(
              "[data-stub=head-end] .diff-review-only-exit",
            )
            ?.click(),
        );
        await act(async () => {});
        expect(card()).not.toBeNull();
      } finally {
        await inspector.unmount();
        localStorage.removeItem(PREFS_KEY);
      }
    });

    test("on a phone, Back over the review in Changes leaves the prompt, then Review only, then the diff for its tree", async () => {
      const { PREFS_KEY } = await import("../reviewPrefs");
      localStorage.setItem(PREFS_KEY, "{}");
      localStorage.setItem("vimKeys", "true");
      // The phone: mobile mode and a session history Back walks.
      const entries: unknown[] = [null];
      let index = 0;
      const fake = {
        get state() {
          return entries[index];
        },
        get length() {
          return entries.length;
        },
        pushState(value: unknown) {
          entries.splice(index + 1);
          entries.push(value);
          index++;
        },
        replaceState(value: unknown) {
          entries[index] = value;
        },
        back() {
          setTimeout(() => {
            if (index === 0) return;
            index--;
            window.dispatchEvent(
              new PopStateEvent("popstate", { state: entries[index] }),
            );
          }, 0);
        },
        forward() {},
      };
      const historyBefore = Object.getOwnPropertyDescriptor(window, "history");
      Object.defineProperty(window, "history", {
        value: fake,
        configurable: true,
      });
      const { initializeLayoutPreferences, updateLayoutPreferences } =
        await import("../layoutPreferences");
      initializeLayoutPreferences();
      updateLayoutPreferences({ mode: "mobile" });
      // A phone-wide inspector: compact, the tree or the diff.
      const widthBefore = Object.getOwnPropertyDescriptor(
        HTMLElement.prototype,
        "clientWidth",
      );
      Object.defineProperty(HTMLElement.prototype, "clientWidth", {
        get: () => 390,
        configurable: true,
      });
      const settle = () =>
        act(async () => {
          for (let turn = 0; turn < 6; turn++)
            await new Promise((resolve) => setTimeout(resolve, 0));
        });
      const back = async () => {
        await act(async () => window.history.back());
        await settle();
      };
      const backs: string[] = [];
      const inspector = await mountInspector({
        root: "/repo",
        entry: { path: "a.ts", kind: "unstaged" },
        backs,
      });
      try {
        // A file picked in the tree: its diff, then Review only, then `:`.
        await act(async () =>
          treeSeen.onSelectionChange?.(
            { entry: { path: "a.ts", kind: "unstaged" } },
            { userInitiated: true },
          ),
        );
        await act(async () => diffSeen.run?.("only"));
        await settle();
        const onlyShown = () =>
          inspector.host.querySelector("[data-stub=head-end]") !== null;
        expect(onlyShown()).toBe(true);
        const tab = inspector.host.querySelector<HTMLElement>(
          ".inspector-changes-resource [data-stub=changes-diff]",
        );
        await act(async () => {
          (tab ?? inspector.host).dispatchEvent(
            new KeyboardEvent("keydown", {
              key: ":",
              bubbles: true,
              cancelable: true,
            }),
          );
        });
        await settle();
        const prompt = () =>
          inspector.host.querySelector('input[aria-label="Command"]');
        expect(prompt()).not.toBeNull();
        await back();
        expect(prompt()).toBeNull();
        expect(onlyShown()).toBe(true);
        await back();
        expect(onlyShown()).toBe(false);
        expect(backs).toEqual([]);
        await back();
        expect(backs).toEqual(["back"]);
      } finally {
        await inspector.unmount();
        updateLayoutPreferences({ mode: "auto" });
        if (widthBefore)
          Object.defineProperty(
            HTMLElement.prototype,
            "clientWidth",
            widthBefore,
          );
        else
          delete (HTMLElement.prototype as { clientWidth?: number })
            .clientWidth;
        if (historyBefore)
          Object.defineProperty(window, "history", historyBefore);
        localStorage.removeItem(PREFS_KEY);
      }
    });

    test("on a phone, a file picked in a branch, commit or range review's tree opens its diff, as Working's does; Back, the tree again", async () => {
      const { PREFS_KEY } = await import("../reviewPrefs");
      localStorage.setItem(PREFS_KEY, "{}");
      localStorage.setItem("vimKeys", "true");
      const entries: unknown[] = [null];
      let index = 0;
      const fake = {
        get state() {
          return entries[index];
        },
        get length() {
          return entries.length;
        },
        pushState(value: unknown) {
          entries.splice(index + 1);
          entries.push(value);
          index++;
        },
        replaceState(value: unknown) {
          entries[index] = value;
        },
        back() {
          setTimeout(() => {
            if (index === 0) return;
            index--;
            window.dispatchEvent(
              new PopStateEvent("popstate", { state: entries[index] }),
            );
          }, 0);
        },
        forward() {},
      };
      const historyBefore = Object.getOwnPropertyDescriptor(window, "history");
      Object.defineProperty(window, "history", {
        value: fake,
        configurable: true,
      });
      const { initializeLayoutPreferences, updateLayoutPreferences } =
        await import("../layoutPreferences");
      initializeLayoutPreferences();
      updateLayoutPreferences({ mode: "mobile" });
      const widthBefore = Object.getOwnPropertyDescriptor(
        HTMLElement.prototype,
        "clientWidth",
      );
      Object.defineProperty(HTMLElement.prototype, "clientWidth", {
        get: () => 390,
        configurable: true,
      });
      const settle = () =>
        act(async () => {
          for (let turn = 0; turn < 6; turn++)
            await new Promise((resolve) => setTimeout(resolve, 0));
        });
      const backs: string[] = [];
      // A commit's review: Changes' own selection has no file, the
      // review's view lists its files.
      const inspector = await mountInspector({ root: "/repo", backs });
      const detail = () =>
        inspector.host
          .querySelector(".workspace-inspector")
          ?.classList.contains("has-detail") ?? false;
      try {
        await act(async () =>
          diffSeen.onViewEntries?.({
            label: "1/1 abcdef12 Subject",
            entries: [{ path: "a.txt", kind: "branch", status: "M" }],
          }),
        );
        await settle();
        expect(detail()).toBe(false);
        await act(async () => treeSeen.onPickViewFile?.("a.txt"));
        await settle();
        expect(detail()).toBe(true);
        expect(diffSeen.cursorGoTo).toMatchObject({ path: "a.txt" });
        // The diff's Back: its tree.
        await act(async () => window.history.back());
        await settle();
        expect(detail()).toBe(false);
        expect(backs).toEqual(["back"]);
      } finally {
        await inspector.unmount();
        updateLayoutPreferences({ mode: "auto" });
        if (widthBefore)
          Object.defineProperty(
            HTMLElement.prototype,
            "clientWidth",
            widthBefore,
          );
        else
          delete (HTMLElement.prototype as { clientWidth?: number })
            .clientWidth;
        if (historyBefore)
          Object.defineProperty(window, "history", historyBefore);
        localStorage.removeItem(PREFS_KEY);
      }
    });

    test("a stored reviewin=classic (the retired switch) changes nothing: Changes has its scope controls and Review only its header end, no floating Show all", async () => {
      const { PREFS_KEY } = await import("../reviewPrefs");
      const { roamgateLocalStorage } = await import("../browserStorage");
      roamgateLocalStorage.setItem(
        PREFS_KEY,
        JSON.stringify({ reviewIn: "classic" }),
      );
      roamgateLocalStorage.setItem("vimKeys", "true");
      const inspector = await mountInspector({ root: "/repo" });
      try {
        expect(diffSeen.scopeControls).toBeDefined();
        await act(async () => diffSeen.run?.("only"));
        await act(async () => {});
        expect(diffSeen.headEnd).toBeDefined();
        expect(
          inspector.host.querySelector(".inspector-review-only-hint"),
        ).toBeNull();
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

  /**
   * The jobs of the retired review host (ReviewHost), now the inspector's
   * around the review in Changes: what the review is given from
   * the workspace's panes, where its files open, its close, reviews list
   * and Go to agent's pane, the review shown as Changes' scope.
   */
  describe("the review's host in Changes", () => {
    type Snapshot = import("../../../shared/review").ReviewSnapshot;
    type Pane = import("../types").Pane;
    const review = (id: string, fields: Record<string, unknown> = {}) =>
      ({
        session: {
          id,
          connectionId: "local",
          workspaceId: "w1",
          root: "/repo",
          title: id,
          target: { kind: "worktree" },
          gitlab: false,
          summary: "",
          agent: {},
          reviewed: {},
          createdAt: "2026-11-10",
          updatedAt: "2026-11-10",
          ...fields,
        },
        threads: [],
      }) as unknown as Snapshot;
    const pane = (
      paneId: string,
      workspaceId: string,
      fields: Partial<Pane> = {},
    ): Pane => ({
      pane_id: paneId,
      terminal_id: `t-${paneId}`,
      workspace_id: workspaceId,
      tab_id: "tab",
      focused: false,
      agent_status: "idle",
      revision: 1,
      ...fields,
    });
    /** The store's panes, for the inspector's selectors. */
    const withPanes = async (panes: Pane[]) => {
      const { spyOn } = await import("bun:test");
      const { store } = await import("../store");
      const state = { ...store.get(), panes } as ReturnType<typeof store.get>;
      return spyOn(store, "get").mockImplementation(() => state);
    };
    const remember = async (...snapshots: Snapshot[]) => {
      const { rememberReviewSnapshot } = await import("../review");
      for (const snapshot of snapshots) rememberReviewSnapshot(snapshot);
    };

    test("a review out of sight draws no diff and loads nothing until shown; another view puts it away", async () => {
      await remember(review("r1"));
      const before = { mounts: diffSeen.mounts, unmounts: diffSeen.unmounts };
      const inspector = await mountInspector({
        root: "/repo",
        view: "files",
        reviewGoTo: { review: "r1", at: Date.now() },
      });
      try {
        // On another view: no diff, so nothing of the review is read.
        expect(
          inspector.host.querySelector("[data-stub=changes-diff]"),
        ).toBeNull();
        expect(diffSeen.mounts).toBe(before.mounts);
        // Shown: one diff, of that review.
        await inspector.set({ view: "changes" });
        expect(
          inspector.host.querySelector("[data-stub=changes-diff]"),
        ).not.toBeNull();
        expect(diffSeen.mounts).toBe(before.mounts + 1);
        expect(diffSeen.reviewScope).toEqual({
          kind: "review",
          sessionId: "r1",
        });
        // Put away again: no diff left to read anything.
        await inspector.set({ view: "files" });
        expect(
          inspector.host.querySelector("[data-stub=changes-diff]"),
        ).toBeNull();
        expect(diffSeen.unmounts).toBe(before.unmounts + 1);
      } finally {
        await inspector.unmount();
      }
    });

    test("every review shown is Changes' one diff, kept mounted from one to the next and while the workspace is out of sight", async () => {
      await remember(review("r1"), review("r2"));
      const inspector = await mountInspector({
        root: "/repo",
        reviewGoTo: { review: "r2", at: Date.now() },
      });
      try {
        const mounted = diffSeen.mounts;
        expect(diffSeen.reviewScope).toEqual({
          kind: "review",
          sessionId: "r2",
        });
        await inspector.set({
          reviewGoTo: { review: "r1", at: Date.now() + 1 },
        });
        expect(diffSeen.reviewScope).toEqual({
          kind: "review",
          sessionId: "r1",
        });
        // The workspace out of sight: hidden, not unmounted.
        const unmounted = diffSeen.unmounts;
        await inspector.set({ visible: false });
        expect(
          inspector.host.querySelector("[data-stub=changes-diff]"),
        ).not.toBeNull();
        expect(diffSeen.mounts).toBe(mounted);
        expect(diffSeen.unmounts).toBe(unmounted);
      } finally {
        await inspector.unmount();
      }
    });

    test("a review is given its workspace's pane directories and its agents' directories, absolute and once each", async () => {
      const restore = await withPanes([
        pane("p1", "w1", { cwd: "/repo", foreground_cwd: "/repo/sub" }),
        pane("p2", "w1", { cwd: "/repo/sub" }),
        pane("p3", "w1", { cwd: "relative" }),
        pane("p4", "w1", {
          cwd: "/agent/home",
          foreground_cwd: "/agent/now",
          agent: "claude",
        }),
        pane("p5", "w1", { foreground_cwd: "/agent/only-fg", agent: "pi" }),
        pane("p6", "w2", { cwd: "/elsewhere", agent: "claude" }),
        pane("p7", "w1"),
      ]);
      scans.length = 0;
      const inspector = await mountInspector({ root: "/repo" });
      try {
        await act(async () => {});
        // The checkout first, then each pane's directory (where it is).
        expect(scans[scans.length - 1]?.dirs).toEqual([
          "/repo",
          "/repo/sub",
          "/agent/now",
          "/agent/only-fg",
        ]);
        // An agent's directory is where it started (cwd), else where it is.
        expect(scans[scans.length - 1]?.agentDirs).toEqual([
          "/agent/home",
          "/agent/only-fg",
        ]);
      } finally {
        await inspector.unmount();
        restore.mockRestore();
      }
    });

    test("a review's agents are its workspace's agent panes: the focused one first, then by id; its own agent's pane, when it names one, is its agent", async () => {
      const { reviewAgent } = await import("../reviewDelivery");
      const restore = await withPanes([
        pane("p3", "w1", { agent: "claude" }),
        pane("p1", "w1", { agent: "codex" }),
        pane("p2", "w1", { agent: "pi", focused: true }),
        pane("p9", "w1", { agent: "claude" }),
        pane("p4", "w1", { agent: "  " }),
        pane("p5", "w1"),
        pane("p6", "w2", { agent: "claude" }),
      ]);
      const inspector = await mountInspector({ root: "/repo" });
      try {
        expect(diffSeen.agentPanes).toEqual([
          { paneId: "p2", agent: "pi" },
          { paneId: "p1", agent: "codex" },
          { paneId: "p3", agent: "claude" },
          { paneId: "p9", agent: "claude" },
        ]);
        const panes = diffSeen.agentPanes ?? [];
        // A review naming its agent's pane talks to that one, first.
        expect(
          reviewAgent(review("r1", { agent: { paneId: "p9" } }), panes)
            .agentPaneId,
        ).toBe("p9");
        // One naming none, to the workspace's first.
        expect(reviewAgent(review("r2"), panes).agentPaneId).toBe("p2");
      } finally {
        await inspector.unmount();
        restore.mockRestore();
      }
    });

    test("close, the reviews list and Go to agent's pane go straight to the host", async () => {
      const calls: { name: string; args: unknown[] }[] = [];
      const record =
        (name: string) =>
        (...args: unknown[]) =>
          calls.push({ name, args });
      const inspector = await mountInspector({
        root: "/repo",
        onCloseReview: record("close"),
        onShowReviews: record("list"),
        onFocusAgentPane: record("focusPane"),
      });
      try {
        diffSeen.onCloseReview?.("command");
        diffSeen.onShowReviews?.();
        diffSeen.onFocusAgentPane?.("p1");
        expect(calls).toEqual([
          { name: "close", args: ["command"] },
          { name: "list", args: [] },
          { name: "focusPane", args: ["p1"] },
        ]);
      } finally {
        await inspector.unmount();
      }
    });

    test("a file opened from a review opens in its workspace; with no workspace, no review and no file", async () => {
      const opened: unknown[][] = [];
      const inspector = await mountInspector({
        root: "/repo",
        onOpenDiffFile: (...args) => opened.push(args),
      });
      try {
        const entry = { path: "a.ts", kind: "unstaged", status: "M" };
        diffSeen.onOpenFile?.(entry, { line: 12 });
        expect(opened).toEqual([[entry, { line: 12 }]]);
      } finally {
        await inspector.unmount();
      }
      // The inspector's workspace gone: no review drawn to open files from.
      const mounted = diffSeen.mounts;
      const gone = await mountInspector({
        workspace: undefined,
        onOpenDiffFile: (...args) => opened.push(args),
      });
      try {
        expect(gone.host.querySelector("[data-stub=changes-diff]")).toBeNull();
        expect(diffSeen.mounts).toBe(mounted);
        expect(opened).toHaveLength(1);
      } finally {
        await gone.unmount();
      }
    });

    test("another repository, a checkout's local review or a merge request's review open in the workspace and show", async () => {
      const mr = review("mr", {
        target: {
          kind: "mr",
          url: "https://gitlab.example/g/p/-/merge_requests/7",
        },
        gitlab: true,
      });
      await remember(
        review("s/repo"),
        review("s/repo2", { root: "/repo2" }),
        mr,
      );
      const inspector = await mountInspector({ root: "/repo" });
      try {
        await act(async () => {});
        // A merge request's review shown from the local one: Changes' scope.
        await act(async () => diffSeen.forgeHost?.onShowReview?.(mr));
        await act(async () => {});
        expect(diffSeen.reviewScope).toEqual({
          kind: "review",
          sessionId: "mr",
        });
        // The checkout's local review: its branch, the review shown dropped.
        await act(async () => diffSeen.forgeHost?.onOpenLocal?.("/repo"));
        await act(async () => {});
        expect(diffSeen.reviewScope).not.toEqual({
          kind: "review",
          sessionId: "mr",
        });
        expect(diffSeen.repo).toEqual({ root: "/repo", own: true });
        // Another repository's local review: shown on that repository.
        await act(async () => diffSeen.forgeHost?.onOpenLocal?.("/repo2"));
        await act(async () => {});
        expect(diffSeen.repo).toEqual({ root: "/repo2", own: false });
      } finally {
        await inspector.unmount();
      }
    });

    test("Show in code review goes to its review only; a file opened rendered says so", async () => {
      await remember(review("r1"), review("r2"));
      const opened: unknown[][] = [];
      const inspector = await mountInspector({
        root: "/repo",
        reviewGoTo: { review: "r2", path: "a.ts", line: 4, at: Date.now() },
        onOpenDiffFile: (...args) => opened.push(args),
      });
      try {
        await act(async () => {});
        expect(diffSeen.reviewScope).toEqual({
          kind: "review",
          sessionId: "r2",
        });
        expect(diffSeen.cursorGoTo).toMatchObject({ path: "a.ts", line: 4 });
        const readme = { path: "README.md", kind: "unstaged", status: "M" };
        const code = { path: "a.ts", kind: "unstaged", status: "M" };
        diffSeen.onOpenFile?.(readme, { line: 3, rendered: true });
        diffSeen.onOpenFile?.(code);
        expect(opened).toEqual([
          [readme, { line: 3, rendered: true }],
          [code, undefined],
        ]);
      } finally {
        await inspector.unmount();
      }
    });
  });
}
