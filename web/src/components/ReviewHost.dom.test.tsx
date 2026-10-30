import { describe, expect, mock, test } from "bun:test";

/**
 * ReviewHost: the reviews pinned to a connection's workspaces, each kept
 * mounted, only the shown one visible, and what each review is handed from
 * the workspace's panes. Characterization tests of today's behavior (plan:
 * review into the inspector, phase A); the review itself is replaced by a
 * stand-in recording what it is given.
 */
if (process.env.ROAMGATE_REVIEW_HOST_DOM_TEST !== "1") {
  test("review host in an isolated DOM runtime", async () => {
    const child = Bun.spawn([process.execPath, "test", import.meta.path], {
      env: { ...process.env, ROAMGATE_REVIEW_HOST_DOM_TEST: "1" },
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
  const { installReviewDom } = await import("./reviewSurface.testkit");
  await installReviewDom();
  const { act, useEffect } = await import("react");
  const { createRoot } = await import("react-dom/client");
  type Snapshot = import("../../../shared/review").ReviewSnapshot;
  type Pane = import("../types").Pane;
  type Props = Record<string, unknown> & { snapshot: Snapshot };

  /** What each mounted review was last given, and how often it mounted. */
  const given = new Map<string, Props>();
  const mounts: string[] = [];
  mock.module("./ReviewOverlay", () => {
    return {
      ReviewOverlay: (props: Props) => {
        const id = props.snapshot.session.id;
        given.set(id, props);
        useEffect(() => {
          mounts.push(id);
        }, [id]);
        return null;
      },
    };
  });
  const sessions = new Map<string, Snapshot>();
  mock.module("../review", () => ({
    useReviewState: () => ({ sessions, openRequest: null }),
  }));
  const opens: unknown[] = [];
  const remembered: string[] = [];
  let openAnswer: string | null = "opened";
  mock.module("../reviewOpen", () => ({
    openWorkspaceReview: async (
      _sessions: unknown,
      request: Record<string, unknown>,
    ) => {
      opens.push(request);
      return openAnswer;
    },
    rememberWorkspaceReview: (snapshot: Snapshot) => {
      remembered.push(snapshot.session.id);
    },
  }));
  const { ReviewHost } = await import("./ReviewHost");

  const review = (id: string, workspaceId?: string, paneId?: string) =>
    ({
      session: {
        id,
        connectionId: "desktop",
        ...(workspaceId === undefined ? {} : { workspaceId }),
        root: "/repo",
        title: id,
        target: { kind: "worktree" },
        gitlab: false,
        summary: "",
        agent: paneId ? { paneId } : {},
        reviewed: {},
        createdAt: "2026-11-10",
        updatedAt: "2026-11-10",
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

  async function mount(props: {
    pinned: Snapshot[];
    shownId: string | null;
    panes?: Pane[];
  }) {
    given.clear();
    mounts.length = 0;
    opens.length = 0;
    remembered.length = 0;
    const calls: { name: string; args: unknown[] }[] = [];
    const record =
      (name: string) =>
      (...args: unknown[]) =>
        calls.push({ name, args });
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const render = (next: typeof props) =>
      act(async () =>
        root.render(
          <ReviewHost
            connectionId="desktop"
            pinned={next.pinned}
            shownId={next.shownId}
            panes={next.panes ?? []}
            onClose={record("close")}
            onShow={record("show")}
            onShowList={record("list")}
            onFocusAgentPane={record("focusPane")}
            onOpenFile={record("openFile")}
          />,
        ),
      );
    await render(props);
    return {
      calls,
      render,
      unmount: async () => {
        await act(async () => root.unmount());
        host.remove();
      },
    };
  }

  describe("ReviewHost", () => {
    test("every pinned review is mounted, only the shown one visible; showing another keeps them all mounted", async () => {
      const view = await mount({
        pinned: [review("r1", "w1"), review("r2", "w2")],
        shownId: "r2",
      });
      expect([...given.keys()]).toEqual(["r1", "r2"]);
      expect(given.get("r1")?.hidden).toBe(true);
      expect(given.get("r2")?.hidden).toBe(false);
      expect(given.get("r1")?.connectionId).toBe("desktop");
      await view.render({
        pinned: [review("r1", "w1"), review("r2", "w2")],
        shownId: "r1",
      });
      expect(given.get("r1")?.hidden).toBe(false);
      expect(given.get("r2")?.hidden).toBe(true);
      // No review shown: all hidden, none unmounted.
      await view.render({
        pinned: [review("r1", "w1"), review("r2", "w2")],
        shownId: null,
      });
      expect(given.get("r1")?.hidden).toBe(true);
      expect(given.get("r2")?.hidden).toBe(true);
      expect(mounts).toEqual(["r1", "r2"]);
      await view.unmount();
    });

    test("a review is given its workspace's pane directories and its agents' directories, absolute and once each", async () => {
      const view = await mount({
        pinned: [review("r1", "w1")],
        shownId: "r1",
        panes: [
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
        ],
      });
      const props = given.get("r1")!;
      expect(props.repoDirs).toEqual([
        "/repo/sub",
        "/agent/now",
        "/agent/only-fg",
      ]);
      // An agent's directory is where it started (cwd), else where it is.
      expect(props.agentDirs).toEqual(["/agent/home", "/agent/only-fg"]);
      await view.unmount();
    });

    test("a review's agents are its workspace's agent panes: its own agent's pane first, then the focused one, then by id", async () => {
      const view = await mount({
        pinned: [review("r1", "w1", "p9"), review("r2", "w1")],
        shownId: "r1",
        panes: [
          pane("p3", "w1", { agent: "claude" }),
          pane("p1", "w1", { agent: "codex" }),
          pane("p2", "w1", { agent: "pi", focused: true }),
          pane("p9", "w1", { agent: "claude" }),
          pane("p4", "w1", { agent: "  " }),
          pane("p5", "w1"),
          pane("p6", "w2", { agent: "claude" }),
        ],
      });
      expect(given.get("r1")?.agentPanes).toEqual([
        { paneId: "p9", agent: "claude" },
        { paneId: "p2", agent: "pi" },
        { paneId: "p1", agent: "codex" },
        { paneId: "p3", agent: "claude" },
      ]);
      expect(given.get("r2")?.agentPanes).toEqual([
        { paneId: "p2", agent: "pi" },
        { paneId: "p1", agent: "codex" },
        { paneId: "p3", agent: "claude" },
        { paneId: "p9", agent: "claude" },
      ]);
      await view.unmount();
    });

    test("close, the reviews list and Go to agent's pane go straight to the host", async () => {
      const view = await mount({ pinned: [review("r1", "w1")], shownId: "r1" });
      const props = given.get("r1")!;
      (props.onClose as () => void)();
      (props.onShowList as () => void)();
      (props.onFocusAgentPane as (id: string) => void)("p1");
      expect(view.calls).toEqual([
        { name: "close", args: [] },
        { name: "list", args: [] },
        { name: "focusPane", args: ["p1"] },
      ]);
      await view.unmount();
    });

    test("a file opened from a review opens in its workspace; a review of no workspace opens no file", async () => {
      const view = await mount({
        pinned: [review("r1", "w1"), review("r2")],
        shownId: "r1",
      });
      const open = given.get("r1")?.onOpenFile as (
        path: string,
        line?: number,
      ) => void;
      open("/repo/a.ts", 12);
      expect(view.calls[0]?.name).toBe("openFile");
      expect(view.calls[0]?.args.slice(0, 3)).toEqual(["w1", "/repo/a.ts", 12]);
      expect(given.get("r2")?.onOpenFile).toBeUndefined();
      await view.unmount();
    });

    test("another repository, a checkout's local review or a merge request's review open in the workspace and show", async () => {
      const view = await mount({ pinned: [review("r1", "w1")], shownId: "r1" });
      const props = given.get("r1")!;
      await act(async () => {
        (props.onOpenRepo as (root: string, worktree?: boolean) => void)(
          "/other",
          true,
        );
      });
      await act(async () => {
        (props.onOpenLocal as (root: string, reviews: string[]) => void)(
          "/repo",
          ["mr1"],
        );
      });
      expect(opens).toEqual([
        { root: "/other", worktree: true },
        { root: "/repo", local: ["mr1"] },
      ]);
      expect(view.calls).toEqual([
        { name: "show", args: ["opened"] },
        { name: "show", args: ["opened"] },
      ]);
      // Nothing opened: nothing shown.
      openAnswer = null;
      await act(async () => {
        (props.onOpenRepo as (root: string) => void)("/none");
      });
      expect(view.calls).toHaveLength(2);
      openAnswer = "opened";
      // A merge request's review shown from the local one is remembered as
      // the workspace's, then shown.
      (props.onShowReview as (snapshot: Snapshot) => void)(review("mr", "w1"));
      expect(remembered).toEqual(["mr"]);
      expect(view.calls[2]).toEqual({ name: "show", args: ["mr"] });
      await view.unmount();
    });
  });
}
