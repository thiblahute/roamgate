import { inIsolatedChild } from "./testIsolated";
import { describe, expect, jest, mock, test } from "bun:test";
import { mockReviewStore } from "./reviewState.testkit";

/**
 * The workspace's held Review feedback (`useHeldFeedback`): review threads
 * waiting for the user's Send, shown and edited as the panel's notes.
 * Characterization tests of today's behavior (plan: review into the
 * inspector, phase A), against a bridge held in memory.
 */
if (
  inIsolatedChild(
    import.meta.path,
    "held feedback in an isolated DOM runtime",
    "ROAMGATE_HELD_FEEDBACK_DOM_TEST",
    30_000,
  )
) {
  const { installReviewDom } = await import(
    "./components/reviewSurface.testkit"
  );
  await installReviewDom();
  const { act, useSyncExternalStore } = await import("react");
  const { createRoot } = await import("react-dom/client");
  type Snapshot = import("../../shared/review").ReviewSnapshot;
  type Thread = import("../../shared/review").ReviewThread;

  /** The review store and bridge, in memory. */
  let sessions = new Map<string, Snapshot>();
  const listeners = new Set<() => void>();
  let state = { sessions, openRequest: null };
  const publish = () => {
    state = { sessions, openRequest: null };
    for (const listener of listeners) listener();
  };
  const calls: { connection: string; method: string; params: unknown }[] = [];
  let failing = false;
  mock.module("./review", () => ({
    ...mockReviewStore(() =>
      useSyncExternalStore(
        (listener: () => void) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        () => state,
      ),
    ),
    reviewCall: async (
      connection: string,
      method: string,
      params: Record<string, unknown> = {},
    ) => {
      calls.push({ connection, method, params });
      if (failing && method !== "review.get") throw new Error("refused");
      if (method === "review.edit") {
        // The bridge keeps the words: the next review.get reads them.
        const id = String(params.session_id);
        const kept = sessions.get(id)!;
        sessions = new Map(sessions).set(id, {
          ...kept,
          threads: kept.threads.map((thread) => ({
            ...thread,
            comments: thread.comments.map((comment) =>
              comment.id === params.comment_id
                ? { ...comment, body: String(params.text) }
                : comment,
            ),
          })),
        });
      }
      if (method === "review.get")
        return sessions.get(String(params.session_id));
      return {};
    },
    rememberReviewSnapshot: (snapshot: Snapshot) => {
      sessions = new Map(sessions).set(snapshot.session.id, snapshot);
      publish();
    },
  }));
  const { useHeldFeedback } = await import("./useHeldFeedback");

  const note = (path: string, line: number) =>
    JSON.stringify({
      source: "diff",
      path,
      kind: "unstaged",
      side: "new",
      line,
      quote: "x",
      hunk: "@@ -1 +1 @@",
    });

  function heldThread(
    id: string,
    held: number | undefined,
    body: string,
    extra: Partial<Thread["anchor"]> = {},
  ): Thread {
    return {
      id,
      sessionId: "s1",
      kind: "comment",
      anchor: {
        path: "a.ts",
        line: 1,
        side: "new",
        feedback: note("a.ts", 1),
        ...extra,
      },
      comments: [
        {
          id: `${id}c`,
          author: "You",
          body,
          createdAt: "2026-11-10T10:00:00Z",
          updatedAt: "2026-11-10T10:00:00Z",
        },
      ],
      resolved: false,
      ...(held === undefined ? {} : { held }),
      createdAt: "2026-11-10T10:00:00Z",
      updatedAt: "2026-11-10T10:00:00Z",
    } as unknown as Thread;
  }

  function snapshot(
    id: string,
    workspaceId: string,
    threads: Thread[],
    connectionId = "desktop",
  ): Snapshot {
    return {
      session: {
        id,
        connectionId,
        workspaceId,
        root: "/repo",
        title: "Review",
        target: { kind: "worktree" },
        gitlab: false,
        summary: "",
        agent: {},
        reviewed: {},
        createdAt: "2026-11-10",
        updatedAt: "2026-11-10",
      },
      threads,
    } as unknown as Snapshot;
  }

  function seed(...snapshots: Snapshot[]) {
    sessions = new Map(snapshots.map((each) => [each.session.id, each]));
    publish();
    calls.length = 0;
    failing = false;
  }

  type Held = ReturnType<typeof useHeldFeedback>;
  async function mount(connectionId: string | null, workspaceId?: string) {
    let current: Held | null = null;
    function Host() {
      current = useHeldFeedback(connectionId, workspaceId);
      return null;
    }
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    await act(async () => root.render(<Host />));
    return {
      get held() {
        return current!;
      },
      comments: () => current!.annotations.map((each) => each.comment),
      ids: () => current!.annotations.map((each) => each.id),
      unmount: () => act(async () => root.unmount()),
    };
  }

  /** Let the fake timers and the writes' promises run. */
  async function advance(ms: number) {
    await act(async () => {
      jest.advanceTimersByTime(ms);
    });
    for (let i = 0; i < 5; i++) await act(async () => {});
  }

  describe("held feedback", () => {
    test("the workspace's held threads are its notes, in their held order; others and other workspaces' are left out", async () => {
      seed(
        snapshot("s1", "w1", [
          heldThread("t3", 3, "third"),
          heldThread("t1", 1, "first"),
          heldThread("tx", undefined, "sent as written"),
          heldThread("t2", 2, "second", {
            render: { snapshot: "data:image/png;base64,AA" } as never,
          }),
        ]),
        snapshot("s2", "w2", [heldThread("o1", 0, "other workspace")]),
        snapshot(
          "s3",
          "w1",
          [heldThread("c1", 0, "other connection")],
          "laptop",
        ),
      );
      const view = await mount("desktop", "w1");
      expect(view.ids()).toEqual(["t1", "t2", "t3"]);
      expect(view.comments()).toEqual(["first", "second", "third"]);
      expect(view.held.annotations[0]).toMatchObject({
        source: "diff",
        path: "a.ts",
        line: 1,
      });
      expect(view.held.has("t2")).toBe(true);
      expect(view.held.has("tx")).toBe(false);
      expect(view.held.has("o1")).toBe(false);
      expect(view.held.snapshot("t2")).toBe("data:image/png;base64,AA");
      expect(view.held.snapshot("t1")).toBeUndefined();
      await view.unmount();
      // No connection or no workspace: nothing is held.
      const none = await mount(null, "w1");
      expect(none.ids()).toEqual([]);
      await none.unmount();
      const nowhere = await mount("desktop", undefined);
      expect(nowhere.ids()).toEqual([]);
      await nowhere.unmount();
    });

    test("words typed show at once and are saved 500 ms after the last key, trimmed, then read back; blank words wait", async () => {
      jest.useFakeTimers();
      try {
        seed(snapshot("s1", "w1", [heldThread("t1", 1, "first")]));
        const view = await mount("desktop", "w1");
        await act(async () => view.held.edit("t1", "fir"));
        expect(view.comments()).toEqual(["fir"]);
        await advance(300);
        await act(async () => view.held.edit("t1", " firmly "));
        await advance(499);
        expect(calls).toEqual([]);
        await advance(1);
        expect(calls.map((each) => each.method)).toEqual([
          "review.edit",
          "review.get",
        ]);
        expect(calls[0]).toEqual({
          connection: "desktop",
          method: "review.edit",
          params: { session_id: "s1", comment_id: "t1c", text: "firmly" },
        });
        // Saved and read back, the note shows what the review holds.
        expect(view.comments()).toEqual(["firmly"]);
        calls.length = 0;
        await act(async () => view.held.edit("t1", "   "));
        expect(view.comments()).toEqual(["   "]);
        await advance(1000);
        expect(calls).toEqual([]);
        expect(view.comments()).toEqual(["   "]);
        await view.unmount();
      } finally {
        jest.useRealTimers();
      }
    });

    test("a save that fails keeps the words typed, unsaved", async () => {
      jest.useFakeTimers();
      try {
        seed(snapshot("s1", "w1", [heldThread("t1", 1, "first")]));
        failing = true;
        const view = await mount("desktop", "w1");
        await act(async () => view.held.edit("t1", "changed"));
        await advance(500);
        expect(calls.map((each) => each.method)).toEqual(["review.edit"]);
        expect(view.comments()).toEqual(["changed"]);
        await view.unmount();
      } finally {
        jest.useRealTimers();
      }
    });

    test("an unmount drops the saves still waiting", async () => {
      jest.useFakeTimers();
      try {
        seed(snapshot("s1", "w1", [heldThread("t1", 1, "first")]));
        const view = await mount("desktop", "w1");
        await act(async () => view.held.edit("t1", "never saved"));
        await view.unmount();
        await advance(1000);
        expect(calls).toEqual([]);
      } finally {
        jest.useRealTimers();
      }
    });

    test("remove deletes the thread's first comment; unknown ids do nothing", async () => {
      seed(snapshot("s1", "w1", [heldThread("t1", 1, "first")]));
      const view = await mount("desktop", "w1");
      await act(async () => view.held.remove("nope"));
      expect(calls).toEqual([]);
      await act(async () => view.held.remove("t1"));
      expect(calls[0]).toEqual({
        connection: "desktop",
        method: "review.delete",
        params: { session_id: "s1", comment_id: "t1c" },
      });
      expect(calls[1]?.method).toBe("review.get");
      await view.unmount();
    });

    test("move swaps a note's held place with its neighbour's; past either end nothing moves", async () => {
      seed(
        snapshot("s1", "w1", [
          heldThread("t1", 10, "first"),
          heldThread("t2", 20, "second"),
        ]),
      );
      const view = await mount("desktop", "w1");
      await act(async () => view.held.move("t1", -1));
      await act(async () => view.held.move("t2", 1));
      expect(calls).toEqual([]);
      await act(async () => view.held.move("t1", 1));
      const moves = calls.filter(
        (each) => each.method === "review.thread.move",
      );
      expect(moves.map((each) => each.params)).toEqual([
        { session_id: "s1", comment_id: "t1", held: 20 },
        { session_id: "s1", comment_id: "t2", held: 10 },
      ]);
      await view.unmount();
    });

    test("release hands the held threads named to the agent, each by its thread id, and says whether it was handed", async () => {
      seed(
        snapshot("s1", "w1", [
          heldThread("t1", 1, "first"),
          heldThread("t2", 2, "second"),
        ]),
      );
      const view = await mount("desktop", "w1");
      await act(() => view.held.release(["t2", "gone", "t1"], true));
      const released = calls.filter(
        (each) => each.method === "review.thread.release",
      );
      expect(released.map((each) => each.params)).toEqual([
        { session_id: "s1", comment_id: "t2", handed: true },
        { session_id: "s1", comment_id: "t1", handed: true },
      ]);
      calls.length = 0;
      await act(() => view.held.release(["t1"], false));
      expect(calls[0]?.params).toEqual({
        session_id: "s1",
        comment_id: "t1",
        handed: false,
      });
      await view.unmount();
    });

    test("a question asked in the review pane with no agent is to send at its diff lines: copied as such, handed on Send", async () => {
      const { compileReviewFeedback } = await import("./annotations");
      // As the review pane writes it: no note record, held.
      const asked = {
        ...heldThread("q1", 7, "Why both?"),
        kind: "discussion",
        anchor: {
          path: "a.ts",
          line: 2,
          endLine: 3,
          side: "new",
          text: "deux",
        },
      } as unknown as Thread;
      seed(snapshot("s1", "w1", [asked]));
      const view = await mount("desktop", "w1");
      expect(view.held.annotations).toEqual([
        expect.objectContaining({
          id: "q1",
          source: "diff",
          path: "a.ts",
          side: "new",
          line: 2,
          endLine: 3,
          quote: "deux",
          comment: "Why both?",
        }),
      ]);
      expect(view.held.has("q1")).toBe(true);
      // Copy (or Send with no agent pane) gives the feedback as written.
      expect(compileReviewFeedback(view.held.annotations)).toBe(
        "Review feedback:\n\n1. `a.ts` (new lines 2\u20133):\n> deux\n\nWhy both?",
      );
      // Sent to a picked agent pane: handed, then delivered as any thread.
      await act(() => view.held.release(["q1"], true));
      expect(
        calls.find((each) => each.method === "review.thread.release")?.params,
      ).toEqual({ session_id: "s1", comment_id: "q1", handed: true });
      await view.unmount();
    });
  });
}
