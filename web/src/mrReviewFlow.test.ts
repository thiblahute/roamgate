import { expect, mock, spyOn, test } from "bun:test";

/**
 * `gf` / Open in Files on a request's review (Changes or the review pane):
 * the review worktree is checked out for browsing when the inbox follows
 * on demand, never over local changes. Runs in a child: it replaces the
 * inbox module.
 */
if (process.env.ROAMGATE_MR_FLOW_TEST !== "1") {
  test("checking a review worktree out for browsing, in an isolated runtime", async () => {
    const child = Bun.spawn([process.execPath, "test", import.meta.path], {
      env: { ...process.env, ROAMGATE_MR_FLOW_TEST: "1" },
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
  const calls: { method: string; params: Record<string, unknown> }[] = [];
  let checkout: "on_demand" | "now" = "on_demand";
  let state: "ready" | "dirty" = "ready";
  mock.module("./mrReviews", () => ({
    latestMrInbox: () => ({
      entries: [
        {
          key: "gitlab.example/group/project!7",
          review: {
            connectionId: "local",
            workspaceId: "reviews-project",
            sessionId: "m1",
          },
        },
      ],
    }),
    loadMrReviewsSettings: async () => ({ checkout }),
    mrReviewsCall: async (method: string, params: Record<string, unknown>) => {
      calls.push({ method, params });
      return state === "dirty"
        ? { state: "dirty", changes: ["a.ts"] }
        : { state: "ready" };
    },
  }));
  const { store } = await import("./store");
  const notices: string[] = [];
  spyOn(store, "notify").mockImplementation(((notice: { message: string }) => {
    notices.push(notice.message);
  }) as typeof store.notify);
  const { checkoutForBrowsing } = await import("./mrReviewFlow");

  test("the review workspace's worktree is checked out for browsing, refusing local changes", async () => {
    calls.length = 0;
    await checkoutForBrowsing("reviews-project");
    expect(calls).toEqual([
      {
        method: "checkout",
        params: { key: "gitlab.example/group/project!7", local: "refuse" },
      },
    ]);
    expect(notices).toEqual([]);
  });

  test("a review worktree with local changes is left as it is, and the user is told where to choose", async () => {
    calls.length = 0;
    state = "dirty";
    await checkoutForBrowsing("reviews-project");
    expect(calls.map((call) => call.params.local)).toEqual(["refuse"]);
    expect(notices).toEqual(["The review worktree has local changes"]);
    state = "ready";
  });

  test("another workspace, or an inbox not following on demand, checks nothing out", async () => {
    calls.length = 0;
    await checkoutForBrowsing("elsewhere");
    checkout = "now";
    await checkoutForBrowsing("reviews-project");
    expect(calls).toEqual([]);
  });
}
