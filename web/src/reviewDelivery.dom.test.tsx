import { expect, test } from "bun:test";
import type { ReviewSnapshot, ReviewThread } from "../../shared/review";

/**
 * How a review's comments reach its agent (reviewDelivery, taken out of
 * the review pane): talk, hold, held for Send, why delivery failed, shared
 * threads' own reviews, and the agent pane told to the review once.
 */
if (process.env.ROAMGATE_REVIEW_DELIVERY_TEST !== "1") {
  test("review delivery in an isolated DOM runtime", async () => {
    const child = Bun.spawn([process.execPath, "test", import.meta.path], {
      env: { ...process.env, ROAMGATE_REVIEW_DELIVERY_TEST: "1" },
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
  const remembered: ReviewSnapshot[] = [];
  mock.module("./review", () => ({
    reviewCall: async () => ({}),
    rememberReviewSnapshot: (snapshot: ReviewSnapshot) => {
      remembered.push(snapshot);
    },
    useReviewState: () => ({ sessions: new Map(), openRequest: null }),
  }));
  const { installReviewDom } = await import(
    "./components/reviewSurface.testkit"
  );
  await installReviewDom();
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const {
    heldCommentCount,
    latestAnswerAt,
    paneToAttach,
    reviewAgent,
    sharedThreadDelivery,
    undeliveredReason,
    useAttachAgentPane,
  } = await import("./reviewDelivery");

  type Session = ReviewSnapshot["session"];
  const session = (more: Partial<Session> = {}): Session =>
    ({
      id: "s1",
      connectionId: "c",
      workspaceId: "w1",
      root: "/repo",
      target: { kind: "worktree" },
      gitlab: false,
      summary: "",
      agent: { name: "Claude", paneId: "p1" },
      ...more,
    }) as unknown as Session;
  const snapshot = (
    more: Partial<Session> = {},
    mergeRequest?: { security: boolean },
  ) => ({ session: session(more), mergeRequest }) as unknown as ReviewSnapshot;
  const panes = [{ paneId: "p9", agent: "codex" }];

  test("comments go to the agent as written when it has a pane, not on GitLab, not when turned off", () => {
    const live = reviewAgent(snapshot(), []);
    expect(live).toMatchObject({
      agentName: "Claude",
      agentPaneId: "p1",
      talk: true,
      commentKind: "discussion",
      held: false,
      holdForSend: false,
    });
    expect(reviewAgent(snapshot({ gitlab: true }), []).talk).toBe(false);
    expect(reviewAgent(snapshot({ autoSend: false }), []).commentKind).toBe(
      "draft",
    );
    expect(reviewAgent(snapshot({ holdComments: true }), []).held).toBe(true);
  });

  test("an agent with no pane named takes the workspace's agent pane and its name", () => {
    const agent = reviewAgent(
      snapshot({ agent: {} as Session["agent"] }),
      panes,
    );
    expect(agent).toMatchObject({
      agentName: "Codex",
      agentPaneId: "p9",
      talk: true,
    });
    expect(
      reviewAgent(snapshot({ agent: {} as Session["agent"] }), []),
    ).toMatchObject({
      agentName: "Agent",
      agentPaneId: undefined,
      talk: false,
    });
  });

  test("a review with no agent holds a question for Send in its workspace", () => {
    const none = { agent: {} as Session["agent"] };
    expect(reviewAgent(snapshot(none), []).holdForSend).toBe(true);
    expect(
      reviewAgent(snapshot({ ...none, workspaceId: undefined }), [])
        .holdForSend,
    ).toBe(false);
  });

  test("a merge request's review reaches the agent only once known not confidential", () => {
    const mr = {
      target: { kind: "mr", url: "u" },
    } as unknown as Partial<Session>;
    expect(reviewAgent(snapshot(mr), []).agentAllowed).toBe(false);
    expect(reviewAgent(snapshot(mr, { security: true }), []).talk).toBe(false);
    expect(reviewAgent(snapshot(mr, { security: false }), []).talk).toBe(true);
  });

  test("a delivery failure is said, except an agent busy with a question", () => {
    expect(undeliveredReason(session({ deliveryError: "pane gone" }))).toBe(
      "pane gone",
    );
    expect(
      undeliveredReason(session({ deliveryError: "agent_blocked: asking" })),
    ).toBeNull();
    expect(undeliveredReason(session())).toBeNull();
  });

  const at = (minute: number) => `2026-11-11T10:0${minute}:00Z`;
  const thread = (
    id: string,
    comments: [string, string][],
    more: Partial<ReviewThread> = {},
  ): ReviewThread => ({
    id,
    sessionId: "s1",
    kind: "discussion",
    anchor: {},
    comments: comments.map(([author, time], index) => ({
      id: `${id}${index}`,
      author,
      body: "x",
      createdAt: time,
      updatedAt: time,
    })),
    resolved: false,
    createdAt: at(0),
    updatedAt: at(0),
    ...more,
  });

  test("held: your open discussion comments written since the last delivery", () => {
    const threads = [
      thread("a", [
        ["you", at(1)],
        ["claude", at(2)],
        ["you", at(3)],
      ]),
      thread("b", [["you", at(4)]], { resolved: true }),
      thread("c", [["you", at(5)]], { kind: "draft" }),
      thread("d", [["you", at(6)]], { sessionId: "other" }),
    ];
    const s = session({ deliveredAt: at(2) });
    expect(heldCommentCount(threads, s, true)).toBe(1);
    expect(heldCommentCount(threads, session(), true)).toBe(2);
    expect(heldCommentCount(threads, s, false)).toBe(0);
  });

  test("the latest answer is the agent's newest message in a discussion", () => {
    expect(latestAnswerAt([])).toBe("");
    expect(
      latestAnswerAt([
        thread("a", [
          ["you", at(1)],
          ["claude", at(3)],
        ]),
        thread("b", [["claude", at(5)]], { kind: "merge-request" }),
        thread("c", [
          ["you", at(7)],
          ["claude", at(2)],
        ]),
      ]),
    ).toBe(at(3));
  });

  test("a shared thread goes its own review's way, named after this one's agent when unnamed", () => {
    const own = session({
      id: "s2",
      agent: { paneId: "p2" } as Session["agent"],
      holdComments: true,
      deliveryError: "down",
    });
    expect(sharedThreadDelivery(own, "Claude")).toEqual({
      review: own,
      talk: true,
      held: true,
      undeliveredReason: "down",
      agentName: "Claude",
    });
    const quiet = session({ id: "s3", agent: {} as Session["agent"] });
    expect(sharedThreadDelivery(quiet, "Claude")).toMatchObject({
      talk: false,
      held: false,
    });
  });

  test("the pane is told only while comments go out and the review names none", () => {
    expect(
      paneToAttach(session(), { talk: true, agentPaneId: "p1" }),
    ).toBeNull();
    const none = session({ agent: {} as Session["agent"] });
    expect(paneToAttach(none, { talk: true, agentPaneId: "p9" })).toBe("p9");
    expect(paneToAttach(none, { talk: false, agentPaneId: "p9" })).toBeNull();
  });

  test("the agent pane is told to the review once per review and pane, again after a failure", async () => {
    const calls: unknown[][] = [];
    let fail = true;
    const call = (async <T,>(
      method: string,
      params?: Record<string, unknown>,
    ) => {
      calls.push([method, params]);
      if (fail) throw new Error("down");
      return { session: { id: "s1" } } as T;
    }) as Parameters<typeof useAttachAgentPane>[3];
    function Host({ pane, tick }: { pane: string | null; tick: number }) {
      useAttachAgentPane("s1", pane, "Claude", call);
      void tick;
      return null;
    }
    const root = createRoot(document.createElement("div"));
    await act(async () => root.render(<Host pane="p9" tick={0} />));
    expect(calls).toEqual([
      ["review.update", { agent: "Claude", agent_pane: "p9" }],
    ]);
    // Failed: told again on the next change, not on every render.
    fail = false;
    await act(async () => root.render(<Host pane="p9" tick={1} />));
    expect(calls).toHaveLength(1);
    await act(async () => root.render(<Host pane="p8" tick={1} />));
    expect(calls).toHaveLength(2);
    expect(remembered).toHaveLength(1);
    await act(async () => root.render(<Host pane="p8" tick={2} />));
    await act(async () => root.render(<Host pane={null} tick={2} />));
    expect(calls).toHaveLength(2);
    await act(async () => root.unmount());
  });
}
