import { inIsolatedChild } from "./testIsolated";
import { expect, test } from "bun:test";
import type { ReviewSnapshot, ReviewThread } from "../../shared/review";
import { mockReviewStore } from "./reviewState.testkit";

/**
 * The checkout's own review in Changes: the lookup of its worktree review,
 * and the agent group on it.
 */
if (
  inIsolatedChild(
    import.meta.path,
    "the checkout's review in Changes in an isolated DOM runtime",
    "ROAMGATE_CHANGES_REVIEW_TEST",
    30_000,
  )
) {
  const { mock } = await import("bun:test");
  const calls: { method: string; params: Record<string, unknown> }[] = [];
  const remembered: ReviewSnapshot[] = [];
  let snapshots = new Map<string, ReviewSnapshot>();
  mock.module("./review", () => ({
    reviewCall: async (
      _connection: string,
      method: string,
      params: Record<string, unknown>,
    ) => {
      calls.push({ method, params });
      return {};
    },
    rememberReviewSnapshot: (snapshot: ReviewSnapshot) => {
      remembered.push(snapshot);
    },
    ...mockReviewStore(() => ({ sessions: snapshots, openRequest: null })),
  }));
  const { installReviewDom } = await import(
    "./components/reviewSurface.testkit"
  );
  await installReviewDom();
  const { act, createElement } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { worktreeReview, useChangesAgent } = await import("./changesReview");
  const { ChangesAgentBar } = await import("./components/ChangesAgentBar");

  type Session = ReviewSnapshot["session"];
  const snapshot = (
    id: string,
    more: Partial<Session> = {},
    threads: ReviewThread[] = [],
  ): ReviewSnapshot =>
    ({
      session: {
        id,
        connectionId: "c",
        workspaceId: "w1",
        root: "/repo",
        updatedAt: "2026-11-10T10:00:00Z",
        target: { kind: "worktree" },
        gitlab: false,
        summary: "",
        agent: { name: "Claude", paneId: "p1" },
        ...more,
      },
      threads,
    }) as unknown as ReviewSnapshot;

  test("the worktree review of a checkout is found by its root, the last updated one; none is made by looking", () => {
    const sessions = [
      snapshot("old", { updatedAt: "2026-11-09T10:00:00Z" }),
      snapshot("new", { updatedAt: "2026-11-10T11:00:00Z", root: "/repo/" }),
      snapshot("other", { root: "/elsewhere" }),
      snapshot("range", {
        target: { kind: "range", base: "main", head: "HEAD" },
      }),
      snapshot("foreign", { connectionId: "d" }),
    ];
    expect(worktreeReview(sessions, "c", "/repo")?.session.id).toBe("new");
    expect(worktreeReview(sessions, "c", "/none")).toBeNull();
    expect(worktreeReview([], "c", "/repo")).toBeNull();
    expect(worktreeReview(sessions, "c", null)).toBeNull();
  });

  const mount = async (overall = false) => {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    let open = overall;
    const Bar = () => {
      const agent = useChangesAgent("c", "/repo");
      return createElement(ChangesAgentBar, {
        agent,
        overallOpen: open,
        onOverall: (value: boolean) => {
          open = value;
        },
        onAsk: () => {},
      });
    };
    await act(async () => root.render(createElement(Bar)));
    const chip = () =>
      host.querySelector<HTMLButtonElement>(".diff-agent-name > button") ??
      host.querySelector<HTMLButtonElement>(".diff-agent-name");
    const menuItems = async () => {
      if (!host.querySelector(".rv-menu"))
        await act(async () => chip()!.click());
      return [...host.querySelectorAll<HTMLButtonElement>(".rv-menu button")];
    };
    const closeMenu = async () => {
      if (host.querySelector(".rv-menu"))
        await act(async () => chip()!.click());
    };
    return {
      host,
      // The agent's controls: its chip's menu (Live, Hold, Send, Review,
      // Overall), before the line and pane entries.
      buttons: async () => {
        const items = await menuItems();
        const labels = items
          .map(
            (each) => each.querySelector(".rv-menu-label")?.textContent ?? "",
          )
          .filter((label) => !/^Ask |^Go to /.test(label));
        await closeMenu();
        return labels;
      },
      click: async (label: string) => {
        const button = (await menuItems()).find(
          (each) => each.querySelector(".rv-menu-label")?.textContent === label,
        );
        if (!button) throw new Error(`no ${label}`);
        await act(async () => button.click());
        await closeMenu();
      },
      mode: () =>
        host.querySelector(".diff-agent-bar")?.getAttribute("data-mode"),
      disabled: async (label: string) => {
        const item = (await menuItems()).find((each) =>
          each.querySelector(".rv-menu-label")?.textContent?.startsWith(label),
        );
        await closeMenu();
        return item?.disabled;
      },
      badge: () =>
        host.querySelector(".diff-agent-name .rv-badge")?.textContent ?? null,
      unmount: async () => {
        await act(async () => root.unmount());
        host.remove();
      },
    };
  };

  test("with no review yet, or none with an agent, Changes shows no agent group", async () => {
    snapshots = new Map();
    const none = await mount();
    expect(none.host.querySelector(".diff-agent-bar")).toBeNull();
    await none.unmount();
    snapshots = new Map([["a", snapshot("a", { agent: {} })]]);
    const bare = await mount();
    expect(bare.host.querySelector(".diff-agent-bar")).toBeNull();
    await bare.unmount();
  });

  test("Live and Hold set how comments reach the agent; Send waits for something to send; Review asks the agent's pane", async () => {
    calls.length = 0;
    snapshots = new Map([["a", snapshot("a")]]);
    const bar = await mount();
    expect(bar.mode()).toBe("live");
    expect(await bar.buttons()).toEqual([
      "Live",
      "Hold",
      "Send",
      "Review",
      "Overall",
    ]);
    expect(await bar.disabled("Send")).toBe(true);
    await bar.click("Hold");
    await bar.click("Live");
    await bar.click("Review");
    expect(calls).toEqual([
      {
        method: "review.update",
        params: { session_id: "a", holdComments: true },
      },
      { method: "review.update", params: { session_id: "a", autoSend: false } },
      {
        method: "review.agent.review",
        params: { session_id: "a", pane_id: "p1", agent: "Claude" },
      },
    ]);
    await bar.unmount();
  });

  test("held comments make Send say how many, and send the review to the agent", async () => {
    calls.length = 0;
    const held: ReviewThread = {
      id: "t",
      sessionId: "a",
      kind: "discussion",
      anchor: { path: "a.ts", line: 1, side: "new" },
      comments: [
        {
          id: "c",
          author: "you",
          body: "Why?",
          createdAt: "2026-11-10T10:00:00Z",
          updatedAt: "2026-11-10T10:00:00Z",
        },
      ],
      resolved: false,
      createdAt: "2026-11-10T10:00:00Z",
      updatedAt: "2026-11-10T10:00:00Z",
    } as unknown as ReviewThread;
    snapshots = new Map([["a", snapshot("a", { holdComments: true }, [held])]]);
    const bar = await mount();
    expect(bar.mode()).toBe("holding");
    expect(await bar.buttons()).toContain("Send (1)");
    // The held count shows on the chip itself.
    expect(bar.badge()).toBe("1");
    await bar.click("Send (1)");
    expect(calls).toEqual([
      { method: "review.handoff", params: { session_id: "a" } },
    ]);
    expect(bar.host.querySelector(".diff-agent-status")?.textContent).toContain(
      "Sent to Claude",
    );
    await bar.unmount();
  });

  test("a review that sends nothing as written is manual; turning Live on sends it", async () => {
    calls.length = 0;
    snapshots = new Map([["a", snapshot("a", { autoSend: false })]]);
    const bar = await mount();
    expect(bar.mode()).toBe("manual");
    expect(await bar.buttons()).toEqual(["Live", "Send", "Review", "Overall"]);
    await bar.click("Live");
    expect(calls).toEqual([
      { method: "review.update", params: { session_id: "a", autoSend: true } },
    ]);
    await bar.unmount();
  });
}
