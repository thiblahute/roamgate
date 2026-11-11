import { expect, test } from "bun:test";
import type { ReviewSnapshot } from "../../shared/review";
import type { WorkspaceRepo } from "./reviewModel";

/**
 * The repositories of a review's workspace (reviewRepos, taken out of the
 * review pane): scans reused for a minute, merged with the workspace's
 * reviews, scanned once the review shows, and how the picker names them.
 */
if (process.env.ROAMGATE_REVIEW_REPOS_TEST !== "1") {
  test("review repositories in an isolated DOM runtime", async () => {
    const child = Bun.spawn([process.execPath, "test", import.meta.path], {
      env: { ...process.env, ROAMGATE_REVIEW_REPOS_TEST: "1" },
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
  const { mock } = await import("bun:test");
  const calls: [string, Record<string, unknown>, unknown][] = [];
  let scanned: WorkspaceRepo[] = [];
  let failScan = false;
  let sessions = new Map<string, ReviewSnapshot>();
  mock.module("./review", () => ({
    reviewCall: async (
      connection: string,
      method: string,
      params: Record<string, unknown> = {},
      _timeout?: number,
      options?: unknown,
    ) => {
      calls.push([`${connection} ${method}`, params, options]);
      if (failScan) throw new Error("host down");
      return { repos: scanned };
    },
    rememberReviewSnapshot: () => {},
    useReviewState: () => ({ sessions, openRequest: null }),
  }));
  const { installReviewDom } = await import(
    "./components/reviewSurface.testkit"
  );
  await installReviewDom();
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const {
    clearRepoScans,
    repoLabel,
    scanRepos,
    useWorkspaceRepos,
    workspaceRepos,
    worktreeOnly,
  } = await import("./reviewRepos");

  type Session = ReviewSnapshot["session"];
  const session = (more: Partial<Session> = {}): Session =>
    ({
      id: "s1",
      connectionId: "c",
      workspaceId: "w1",
      root: "/w/app",
      target: { kind: "worktree" },
      ...more,
    }) as unknown as Session;
  const review = (more: Partial<Session>, threads: string[] = []) =>
    ({
      session: session(more),
      threads: threads.map((kind, index) => ({ id: `t${index}`, kind })),
    }) as unknown as ReviewSnapshot;

  test("a scan is one background call, reused whatever the order of the directories", async () => {
    clearRepoScans();
    calls.length = 0;
    scanned = [{ root: "/w/app" }];
    expect(await scanRepos("c", ["/w/b", "/w/a"], ["/w/agent"])).toEqual(
      scanned,
    );
    expect(await scanRepos("c", ["/w/a", "/w/b"], ["/w/agent"])).toEqual(
      scanned,
    );
    expect(calls).toEqual([
      [
        "c review.repos",
        { paths: ["/w/b", "/w/a"], agent_paths: ["/w/agent"] },
        { lane: "background" },
      ],
    ]);
    // Another connection, or other agent directories: scanned again.
    await scanRepos("d", ["/w/a", "/w/b"], ["/w/agent"]);
    await scanRepos("c", ["/w/a", "/w/b"], []);
    expect(calls).toHaveLength(3);
  });

  test("a scan that fails finds nothing", async () => {
    clearRepoScans();
    failScan = true;
    expect(await scanRepos("c", ["/w"], [])).toEqual([]);
    failScan = false;
  });

  test("the workspace's reviews join the scan with their comment counts; chats, rendered files and other workspaces do not", () => {
    const repos = workspaceRepos(
      [{ root: "/w/lib", branch: "main", dirty: true }],
      [
        review({ id: "a", root: "/w/lib" }, ["discussion", "merge-request"]),
        review({ id: "b", root: "/w/lib" }, ["draft"]),
        review({ id: "c", root: "/w/new" }, []),
        review(
          { id: "d", root: "/w/chat", target: { kind: "chat" } } as never,
          ["discussion"],
        ),
        review({
          id: "e",
          root: "/w/page",
          target: { kind: "rendered" },
        } as never),
        review({ id: "f", root: "/x/other", workspaceId: "w2" }),
        review({ id: "g", root: "/x/conn", connectionId: "d" }),
      ],
      session(),
    );
    expect(repos).toEqual([
      { root: "/w/app" },
      { root: "/w/lib", branch: "main", dirty: true, comments: 2 },
      { root: "/w/new", comments: 0 },
    ]);
  });

  test("a review with no workspace lists only the scan and itself", () => {
    expect(
      workspaceRepos(
        [{ root: "/w/z" }],
        [review({ id: "a", root: "/w/lib", workspaceId: undefined })],
        session({ workspaceId: undefined }),
      ),
    ).toEqual([{ root: "/w/app" }, { root: "/w/z" }]);
  });

  test("the panes' directories are scanned once the review shows", async () => {
    clearRepoScans();
    calls.length = 0;
    scanned = [{ root: "/w/lib", ahead: 2 }];
    sessions = new Map();
    let repos: WorkspaceRepo[] = [];
    const own = session();
    function Host({ shown }: { shown: boolean }) {
      repos = useWorkspaceRepos("c", own, ["/w/lib"], ["/w/agent"], shown);
      return null;
    }
    const root = createRoot(document.createElement("div"));
    await act(async () => root.render(<Host shown={false} />));
    expect(calls).toEqual([]);
    expect(repos).toEqual([{ root: "/w/app" }]);
    await act(async () => root.render(<Host shown />));
    expect(calls.map(([call, params]) => [call, params])).toEqual([
      [
        "c review.repos",
        { paths: ["/w/app", "/w/lib"], agent_paths: ["/w/agent"] },
      ],
    ]);
    expect(repos).toEqual([{ root: "/w/app" }, { root: "/w/lib", ahead: 2 }]);
    await act(async () => root.unmount());
  });

  test("the picker names a repository with what it has; work only in progress opens its worktree review", () => {
    expect(repoLabel({ root: "/w/app" })).toBe("app");
    expect(
      repoLabel({
        root: "/w/app",
        branch: "fix",
        ahead: 3,
        dirty: true,
        comments: 1,
      }),
    ).toBe("app · fix, 3 ahead, uncommitted, 1 comment");
    expect(repoLabel({ root: "/w/app", comments: 2 })).toBe("app · 2 comments");
    expect(worktreeOnly({ root: "/w", dirty: true })).toBe(true);
    expect(worktreeOnly({ root: "/w", dirty: true, ahead: 1 })).toBe(false);
    expect(worktreeOnly({ root: "/w" })).toBe(false);
  });
}
