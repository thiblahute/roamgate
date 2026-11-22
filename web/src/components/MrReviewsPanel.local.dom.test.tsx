import { expect, mock, test } from "bun:test";
import { inIsolatedChild } from "../testIsolated";

/**
 * The board's Local reviews: the workspace's reviews of its checkouts, at
 * once, their branches' chips filling in as each checkout answers, the
 * offline connection's said without asking; Enter shows one, dd discards
 * it and u brings it back.
 */
if (
  inIsolatedChild(
    import.meta.path,
    "the board's Local reviews, in an isolated DOM runtime",
    "ROAMGATE_MR_REVIEWS_LOCAL_TEST",
    30_000,
  )
) {
  const { installTestDom } = await import("../testDom");
  installTestDom({ url: "http://localhost/" });
  (
    window.HTMLElement.prototype as unknown as { scrollIntoView: () => void }
  ).scrollIntoView = () => {};
  const React = await import("react");
  const { act } = React;
  const { createRoot } = await import("react-dom/client");
  const { bridge } = await import("../api");
  const { store, __storeTesting } = await import("../store");
  const reviewModule = await import("../review");
  type Snapshot = import("../../../shared/review").ReviewSnapshot;
  type Activity = import("../../../shared/review").ReviewActivity;

  /** Each review.activity call, answered when the test says. */
  const activityCalls: {
    connectionId: string;
    ids: string[];
    answer: (activity: Activity[]) => void;
  }[] = [];
  const calls: [string, Record<string, unknown>][] = [];
  const shown: [string, string][] = [];
  mock.module("../review", () => ({
    ...reviewModule,
    requestReviewShown: (connectionId: string, sessionId: string) =>
      shown.push([connectionId, sessionId]),
    reviewCall: (
      connectionId: string,
      method: string,
      params: Record<string, unknown> = {},
    ) => {
      calls.push([method, params]);
      if (method === "review.activity")
        return new Promise((resolve) =>
          activityCalls.push({
            connectionId,
            ids: params.session_ids as string[],
            answer: (activity) => resolve({ activity }),
          }),
        );
      if (method === "review.import") return Promise.resolve(params.snapshot);
      return Promise.resolve({});
    },
  }));
  (bridge as unknown as { call: (method: string) => unknown }).call = async (
    method: string,
  ) =>
    method === "bridge.mr_reviews.inbox"
      ? {
          entries: [],
          hosts: [],
          curation: { state: "idle" },
          refreshedAt: new Date().toISOString(),
          refreshing: false,
        }
      : { ok: true };

  const review = (
    id: string,
    connectionId: string,
    workspaceId: string,
    root: string,
    extra: Partial<Snapshot["session"]> = {},
    threads: unknown[] = [],
  ): Snapshot =>
    ({
      session: {
        id,
        connectionId,
        workspaceId,
        root,
        target: { kind: "range", base: "main", head: "HEAD" },
        title: `Review ${id}`,
        summary: "",
        updatedAt: "2026-11-20T10:00:00.000Z",
        agent: {},
        gitlab: false,
        ...extra,
      },
      threads,
    }) as unknown as Snapshot;
  const waiting = {
    id: "t1",
    kind: "discussion",
    resolved: false,
    comments: [{ id: "c1", author: "Claude", text: "Why?" }],
  };
  const reviews = [
    review("aaaaaaaaaaaaaaa1", "desk", "w1", "/repo/a"),
    review("bbbbbbbbbbbbbbb2", "desk", "w1", "/repo/b", {}, [waiting]),
    review("ccccccccccccccc3", "desk", "w2", "/repo/c"),
    review("ddddddddddddddd4", "desk", "w1", "/repo/a", {
      target: { kind: "chat", chat: "w1:p1" },
    } as Partial<Snapshot["session"]>),
    review("eeeeeeeeeeeeeee5", "mac", "w9", "/Users/me/m"),
  ];
  for (const each of reviews) reviewModule.rememberReviewSnapshot(each);
  __storeTesting.replaceState({
    ...store.get(),
    activeConnectionId: "desk",
    connections: [
      { id: "desk", label: "Desktop", state: "ready" },
      { id: "mac", label: "Mac", state: "disconnected" },
    ],
    workspaces: [
      { workspace_id: "w1", label: "roamgate", focused: true },
      { workspace_id: "w2", label: "other", focused: false },
    ],
    panes: [],
  } as unknown as ReturnType<typeof store.get>);
  const jumps: [string, string][] = [];
  (
    store as unknown as {
      jumpToConnectionWorkspace: (c: string, w: string) => Promise<void>;
    }
  ).jumpToConnectionWorkspace = async (connectionId, workspaceId) => {
    jumps.push([connectionId, workspaceId]);
  };

  const { MrReviewsPanel } = await import("./MrReviewsPanel");
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const closes: unknown[] = [];
  const settle = (ms = 20) =>
    act(async () => {
      await new Promise((resolve) => setTimeout(resolve, ms));
    });
  const lane = () =>
    host.querySelector<HTMLElement>("section[aria-label='Local reviews']");
  const rows = () =>
    [...(lane()?.querySelectorAll<HTMLElement>("[data-local-review]") ?? [])]
      .map((row) => row.dataset.localReview)
      .map((id) => id?.slice(0, 1));
  const chips = (id: string) =>
    [
      ...(lane()
        ?.querySelector(`[data-local-review^="${id}"]`)
        ?.querySelectorAll(".mr-reviews-chip") ?? []),
    ].map((chip) => chip.textContent);
  const selected = () =>
    host
      .querySelector(".mr-reviews-row.is-selected")
      ?.getAttribute("data-mr-key");
  const panel = () => host.querySelector<HTMLElement>(".mr-reviews-panel")!;
  const key = async (name: string) => {
    await act(async () => {
      panel().dispatchEvent(
        new KeyboardEvent("keydown", { key: name, bubbles: true }),
      );
    });
    await settle(5);
  };

  test("the workspace's reviews show at once, their chips as each checkout answers; Enter, dd and u", async () => {
    await act(async () => {
      root.render(
        <MrReviewsPanel
          mode="mr"
          initialLocal
          onClose={(options) => closes.push(options)}
        />,
      );
    });
    await settle();
    // The workspace's reviews of its checkouts, waiting discussion first,
    // drawn before any branch is read: no chat's threads, no other
    // workspace's.
    expect(rows()).toEqual(["b", "a"]);
    expect(chips("b")).toEqual(["empty", "1 waiting for you"]);
    expect(selected()).toBe("local:bbbbbbbbbbbbbbb2");
    // One read per checkout, of its reviews only.
    expect(
      activityCalls.map((call) => `${call.connectionId} ${call.ids.join(",")}`),
    ).toEqual(["desk aaaaaaaaaaaaaaa1", "desk bbbbbbbbbbbbbbb2"]);
    // /repo/a answers first: its chip shows while /repo/b is still read.
    await act(async () =>
      activityCalls[0]!.answer([
        {
          sessionId: "aaaaaaaaaaaaaaa1",
          newCommits: false,
          gone: "checkout-gone",
        },
      ]),
    );
    await settle();
    expect(chips("a")).toEqual(["empty", "checkout removed"]);
    expect(chips("b")).toEqual(["empty", "1 waiting for you"]);
    await act(async () =>
      activityCalls[1]!.answer([
        { sessionId: "bbbbbbbbbbbbbbb2", newCommits: true, headSha: "f00" },
      ]),
    );
    await settle();
    expect(chips("b")).toEqual([
      "empty",
      "new commits since",
      "1 waiting for you",
    ]);

    // Every workspace's: the other one's, and the Mac's said offline,
    // never asked.
    const only = lane()!.querySelector<HTMLButtonElement>(
      ".mr-local-reviews-scope",
    )!;
    expect(only.textContent).toContain("Only roamgate");
    await act(async () => only.click());
    await settle();
    expect(rows().sort()).toEqual(["a", "b", "c", "e"]);
    expect(chips("e")).toEqual(["empty", "on Mac, offline"]);
    expect(activityCalls.map((call) => call.connectionId)).toEqual([
      "desk",
      "desk",
      "desk",
    ]);
    expect(activityCalls[2]!.ids).toEqual(["ccccccccccccccc3"]);
    await act(async () =>
      lane()!
        .querySelector<HTMLButtonElement>(".mr-local-reviews-scope")!
        .click(),
    );
    await settle();
    expect(rows()).toEqual(["b", "a"]);

    // The scope changed: nothing selected; j from the first.
    expect(selected()).toBeUndefined();
    await key("j");
    expect(selected()).toBe("local:bbbbbbbbbbbbbbb2");
    // Enter on the second: shown in Changes, the board stepping aside.
    await key("j");
    expect(selected()).toBe("local:aaaaaaaaaaaaaaa1");
    await key("Enter");
    await settle();
    expect(shown).toEqual([["desk", "aaaaaaaaaaaaaaa1"]]);
    expect(jumps).toEqual([]);
    expect(closes).toEqual([{ keepFocus: true }]);

    // dd discards it, its whole snapshot kept; u brings it back.
    await key("d");
    await key("d");
    await settle();
    expect(calls.filter(([method]) => method === "review.remove")).toEqual([
      ["review.remove", { session_id: "aaaaaaaaaaaaaaa1" }],
    ]);
    await act(async () =>
      reviewModule.acceptReviewPush({
        type: "removed",
        sessionId: "aaaaaaaaaaaaaaa1",
      } as Parameters<typeof reviewModule.acceptReviewPush>[0]),
    );
    await settle();
    expect(rows()).toEqual(["b"]);
    expect(host.textContent).toContain("Discarded Review aaaaaaaaaaaaaaa1");
    await key("u");
    await settle();
    const imported = calls.find(([method]) => method === "review.import");
    expect((imported?.[1].snapshot as Snapshot | undefined)?.session.id).toBe(
      "aaaaaaaaaaaaaaa1",
    );
    expect(rows()).toEqual(["b", "a"]);
    await act(async () => root.unmount());
  });
}
