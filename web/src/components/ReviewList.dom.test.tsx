import { expect, mock, test } from "bun:test";
import type { ReviewSnapshot } from "../../../shared/review";

/**
 * The reviews list (Option+Shift+R), at the behavior level: keys in, the
 * reviews it lists, the one selected and what the bridge is asked out.
 */
if (process.env.ROAMGATE_REVIEW_LIST_DOM_TEST !== "1") {
  test("the reviews list in an isolated DOM runtime", async () => {
    const child = Bun.spawn([process.execPath, "test", import.meta.path], {
      env: { ...process.env, ROAMGATE_REVIEW_LIST_DOM_TEST: "1" },
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
  const { installReviewDom, parseKeys, settle } = await import(
    "./reviewSurface.testkit"
  );
  await installReviewDom();

  const calls: { method: string; params: Record<string, unknown> }[] = [];
  const remembered: ReviewSnapshot[] = [];
  let activity: unknown[] = [];
  mock.module("../review", () => ({
    reviewCall: async (
      _connection: string,
      method: string,
      params: Record<string, unknown> = {},
    ) => {
      calls.push({ method, params });
      if (method === "review.activity") return { activity };
      if (method === "review.import") return params.snapshot;
      return {};
    },
    rememberReviewSnapshot: (snapshot: ReviewSnapshot) => {
      remembered.push(snapshot);
    },
    useReviewState: () => ({ sessions: new Map(), openRequest: null }),
  }));
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { ReviewList } = await import("./ReviewList");
  const { store } = await import("../store");

  const at = "2026-11-04T14:11:18Z";
  const review = (
    id: string,
    title: string,
    updatedAt: string,
    extra: {
      threads?: unknown[];
      gitlab?: boolean;
      agent?: Record<string, unknown>;
      summary?: string;
      target?: Record<string, unknown>;
    } = {},
  ) =>
    ({
      session: {
        id,
        connectionId: "desktop",
        workspaceId: "w1",
        root: `/src/${id}`,
        title,
        target: extra.target ?? { kind: "worktree" },
        gitlab: extra.gitlab ?? false,
        summary: extra.summary ?? "",
        agent: extra.agent ?? {},
        createdAt: at,
        updatedAt,
      },
      threads: extra.threads ?? [],
    }) as unknown as ReviewSnapshot;
  const comment = (author: string) => ({
    id: `${author}-c`,
    author,
    body: "x",
    createdAt: at,
    updatedAt: at,
  });
  const thread = (kind: string, author: string) => ({
    id: `${kind}-${author}`,
    sessionId: "s",
    kind,
    anchor: {},
    comments: [comment(author)],
    resolved: false,
    createdAt: at,
    updatedAt: at,
  });

  async function mountList(sessions: ReviewSnapshot[]) {
    calls.length = 0;
    remembered.length = 0;
    const opened: string[] = [];
    let closed = 0;
    const notices: string[] = [];
    const stop = store.subscribe(() => {
      const notice = store.get().notice;
      if (notice && notices[notices.length - 1] !== notice.message)
        notices.push(notice.message);
    });
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    await act(async () => {
      root.render(
        <ReviewList
          connectionId="desktop"
          sessions={sessions}
          onOpen={(id) => opened.push(id)}
          onClose={() => closed++}
        />,
      );
    });
    await act(settle);
    const dialog = () =>
      host.querySelector<HTMLElement>('[role="dialog"]') as HTMLElement;
    return {
      /** Each review listed: its text, in order. */
      items: () =>
        [...host.querySelectorAll("[data-review-item]")].map(
          (item) => item.textContent ?? "",
        ),
      /**
       * The review selected: the one drawn highlighted (the list has no
       * other mark of it; the focus follows it).
       */
      selected: () =>
        host.querySelector("[data-review-item].on")?.textContent ?? null,
      /** The review with the focus, if one has it. */
      focused: () =>
        (document.activeElement as HTMLElement | null)?.closest(
          "[data-review-item]",
        )?.textContent ?? null,
      text: () => host.textContent ?? "",
      async press(keys: string) {
        for (const stroke of parseKeys(keys))
          await act(async () => {
            (document.activeElement ?? dialog()).dispatchEvent(
              new KeyboardEvent("keydown", {
                ...stroke,
                bubbles: true,
                cancelable: true,
              }),
            );
          });
        await act(settle);
      },
      opened,
      closed: () => closed,
      notices,
      async rerender(next: ReviewSnapshot[]) {
        await act(async () => {
          root.render(
            <ReviewList
              connectionId="desktop"
              sessions={next}
              onOpen={(id) => opened.push(id)}
              onClose={() => closed++}
            />,
          );
        });
        await act(settle);
      },
      async unmount() {
        stop();
        await act(async () => root.unmount());
        host.remove();
      },
    };
  }

  test("j and k move through the reviews, those needing you first; Enter opens; chips tell each one's state", async () => {
    activity = [
      { sessionId: "moved", newCommits: true },
      { sessionId: "gone", newCommits: false, gone: "checkout-gone" },
    ];
    const list = await mountList([
      review("quiet", "Quiet", "2026-11-04T10:00:00Z", {
        threads: [thread("draft", "you"), thread("draft", "you")],
      }),
      review("gone", "Gone", "2026-11-04T12:00:00Z", {
        summary: "Overall",
        gitlab: true,
        target: {
          kind: "mr",
          url: "https://gitlab.example/g/p/-/merge_requests/7",
        },
      }),
      review("moved", "Moved", "2026-11-04T09:00:00Z"),
      review("asked", "Asked", "2026-11-04T08:00:00Z", {
        threads: [thread("discussion", "Claude")],
        agent: { name: "Claude", working: { at } },
      }),
    ]);
    expect(list.items().map((item) => item.split("  ")[0])).toEqual([
      "Moved",
      "Asked",
      "Gone",
      "Quiet",
    ]);
    const [moved, asked, gone, quiet] = list.items();
    expect(moved).toContain("moved · working tree");
    expect(moved).toContain("empty");
    expect(moved).toContain("new commits since");
    expect(asked).toContain("1 waiting for you");
    expect(asked).toContain("Claude working");
    expect(gone).toContain("gitlab.example/g/p/-/merge_requests/7");
    expect(gone).toContain("overall comment only");
    expect(gone).toContain("GitLab");
    expect(gone).toContain("checkout removed");
    expect(quiet).toContain("2 comments");
    expect(list.selected()).toBe(moved);
    // Opened, the first review has the focus, as j and k then move it.
    expect(list.focused()).toBe(moved);
    await list.press("j");
    expect(list.selected()).toBe(asked);
    expect(list.focused()).toBe(asked);
    await list.press("<Down>j");
    expect(list.selected()).toBe(quiet);
    // At the end it stays.
    await list.press("j");
    expect(list.selected()).toBe(quiet);
    await list.press("kk<Up>");
    expect(list.selected()).toBe(moved);
    await list.press("jj<CR>");
    expect(list.opened).toEqual(["gone"]);
    await list.press("<Esc>");
    await list.press("q");
    expect(list.closed()).toBe(2);
    await list.unmount();
  });

  test("dd discards the selected review and u brings it back with its threads", async () => {
    activity = [];
    const kept = review("kept", "Kept", "2026-11-04T10:00:00Z");
    const dropped = review("dropped", "Dropped", "2026-11-04T09:00:00Z", {
      threads: [thread("draft", "you")],
    });
    const list = await mountList([kept, dropped]);
    await list.press("j");
    // A single d does nothing.
    await list.press("d");
    expect(calls.filter((call) => call.method === "review.remove")).toEqual([]);
    await list.press("d");
    expect(calls.filter((call) => call.method === "review.remove")).toEqual([
      { method: "review.remove", params: { session_id: "dropped" } },
    ]);
    expect(list.notices).toContain("Review discarded (u undoes)");
    // The bridge pushes the list without it.
    await list.rerender([kept]);
    expect(list.items()).toHaveLength(1);
    await list.press("u");
    expect(calls.filter((call) => call.method === "review.import")).toEqual([
      { method: "review.import", params: { snapshot: dropped } },
    ]);
    expect(remembered).toEqual([dropped]);
    // Undone once: a second u has nothing to bring back.
    await list.press("u");
    expect(
      calls.filter((call) => call.method === "review.import"),
    ).toHaveLength(1);
    await list.unmount();
  });

  test("with no review it says how to start one", async () => {
    activity = [];
    const list = await mountList([]);
    expect(list.text()).toContain(
      "No review in progress. Press Option+R in a workspace to start one.",
    );
    await list.unmount();
  });
}
