import { expect, mock, test } from "bun:test";
import type { ReviewSnapshot } from "../../shared/review";

/**
 * Option+R in a workspace with several repositories: it opens the review
 * of the repository last shown there, not the focused pane's.
 */
if (process.env.ROAMGATE_REVIEW_OPEN_SERIES_TEST !== "1") {
  test("Option+R and the workspace's repositories in an isolated runtime", async () => {
    const child = Bun.spawn([process.execPath, "test", import.meta.path], {
      env: { ...process.env, ROAMGATE_REVIEW_OPEN_SERIES_TEST: "1" },
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
  const { Window } = await import("happy-dom");
  const browser = new Window({ url: "http://localhost/" });
  for (const [key, value] of Object.entries({
    window: browser,
    localStorage: browser.localStorage,
  }))
    Object.defineProperty(globalThis, key, {
      value,
      configurable: true,
      writable: true,
    });

  const calls: { method: string; params: Record<string, unknown> }[] = [];
  mock.module("./review", () => ({
    reviewCall: async (
      _connection: string,
      method: string,
      params: Record<string, unknown> = {},
    ) => {
      calls.push({ method, params });
      throw new Error(`unexpected ${method}`);
    },
    rememberReviewSnapshot: () => {},
    clearReviewOpenRequest: () => {},
  }));
  /** The app's state: the focused workspace and its panes. */
  let focused = "w1";
  const state = () => ({
    activeConnectionId: "desktop",
    workspaces: ["w1", "w2"].map((id) => ({
      workspace_id: id,
      focused: id === focused,
    })),
    panes: [
      { pane_id: "p1", workspace_id: "w1", focused: true, cwd: "/w/app/src" },
      { pane_id: "p2", workspace_id: "w2", focused: true, cwd: "/v/lib" },
    ],
  });
  mock.module("./store", () => ({
    store: { get: state, notify: () => {} },
  }));
  const { openWorkspaceReview } = await import("./reviewOpen");

  const review = (id: string, workspaceId: string, root: string) =>
    ({
      session: {
        id,
        connectionId: "desktop",
        workspaceId,
        root,
        title: id,
        target: { kind: "worktree" },
        gitlab: false,
        summary: "",
        agent: { paneId: "p1" },
        createdAt: "2026-11-04",
        updatedAt: "2026-11-04",
      },
      threads: [],
    }) as unknown as ReviewSnapshot;

  test("Option+R reopens the repository of the series last shown in the workspace", async () => {
    const app = review("app", "w1", "/w/app");
    const lib = review("lib", "w1", "/w/lib");
    const other = review("other", "w2", "/v/lib");
    const sessions = new Map(
      [app, lib, other].map((snapshot) => [snapshot.session.id, snapshot]),
    );
    // Nothing shown yet: the focused pane's repository.
    expect(await openWorkspaceReview(sessions)).toBe("app");
    // ) to the next repository of the series.
    expect(await openWorkspaceReview(sessions, { root: "/w/lib" })).toBe("lib");
    // Option+R: that one again, though the focused pane is in the other.
    expect(await openWorkspaceReview(sessions)).toBe("lib");
    // Each workspace remembers its own.
    focused = "w2";
    expect(await openWorkspaceReview(sessions)).toBe("other");
    focused = "w1";
    expect(await openWorkspaceReview(sessions)).toBe("lib");
    // Gone since: the focused pane's again.
    sessions.delete("lib");
    expect(await openWorkspaceReview(sessions)).toBe("app");
    // Nothing asked of the bridge: every one was there already.
    expect(calls).toEqual([]);
  });
}
