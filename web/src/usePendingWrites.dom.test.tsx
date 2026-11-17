import { inIsolatedChild } from "./testIsolated";
import { expect, test } from "bun:test";
import type { ReviewThread } from "../../shared/review";

/**
 * A review's writes on their way (usePendingWrites): shown at once, pending,
 * until the review has them; a failure kept with its error, Retry with the
 * same id, Discard.
 */
if (
  inIsolatedChild(
    import.meta.path,
    "pending writes in an isolated DOM runtime",
    "ROAMGATE_PENDING_WRITES_TEST",
    30_000,
  )
) {
  const { installReviewDom } = await import(
    "./components/reviewSurface.testkit"
  );
  await installReviewDom();
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { keepReviewDraft, takeReviewDraft } = await import("./reviewDrafts");
  const { usePendingWrites } = await import("./usePendingWrites");
  type PendingWrite = import("./reviewPending").PendingWrite;
  type Writes = ReturnType<typeof usePendingWrites>;

  const at = "2026-11-11T10:00:00Z";
  const thread: ReviewThread = {
    id: "t1",
    sessionId: "s1",
    kind: "discussion",
    anchor: { path: "a.ts", line: 2 },
    comments: [
      { id: "c1", author: "you", body: "Why?", createdAt: at, updatedAt: at },
    ],
    resolved: false,
    createdAt: at,
    updatedAt: at,
  };
  const reply: PendingWrite = {
    id: "00112233aabbccdd",
    sessionId: "s1",
    replyTo: "t1",
    kind: "discussion",
    anchor: thread.anchor,
    text: "Because.",
    at,
  };

  async function mount() {
    const calls: [string, Record<string, unknown>][] = [];
    const statuses: string[] = [];
    const notices: string[] = [];
    const answers: { fail: string | null; release: Promise<void> } = {
      fail: null,
      release: Promise.resolve(),
    };
    const call = (async (method: string, params?: Record<string, unknown>) => {
      calls.push([method, params ?? {}]);
      await answers.release;
      if (answers.fail) throw new Error(answers.fail);
      return {};
    }) as Parameters<typeof usePendingWrites>[0]["call"];
    let current: Writes | null = null;
    function Host({ threads }: { threads: ReviewThread[] }) {
      current = usePendingWrites({
        threads,
        sessionId: "s1",
        call,
        setStatus: (status) => statuses.push(status),
        notify: (message) => notices.push(message),
      });
      return null;
    }
    const root = createRoot(document.createElement("div"));
    const render = (threads: ReviewThread[]) =>
      act(async () => root.render(<Host threads={threads} />));
    await render([thread]);
    return {
      calls,
      statuses,
      notices,
      answers,
      render,
      get: () => current!,
      unmount: () => act(async () => root.unmount()),
    };
  }

  test("a reply shows at once, pending, and goes once the review has it", async () => {
    const host = await mount();
    let release = () => {};
    host.answers.release = new Promise((resolve) => {
      release = resolve;
    });
    await act(async () => host.get().sendWrite(reply, "reply:t1"));
    expect(host.get().threads[0]!.comments.map((c) => c.id)).toEqual([
      "c1",
      reply.id,
    ]);
    expect(host.get().pendingById.has(reply.id)).toBe(true);
    // A second send while it is on its way is ignored.
    await act(async () => host.get().sendWrite(reply, "reply:t1"));
    expect(host.calls).toEqual([
      [
        "review.reply",
        { comment_id: "t1", new_comment_id: reply.id, text: "Because." },
      ],
    ]);
    await act(async () => release());
    // The review sent back has it: no longer pending.
    const landed = {
      ...thread,
      comments: [
        ...thread.comments,
        {
          id: reply.id,
          author: "you",
          body: "Because.",
          createdAt: at,
          updatedAt: at,
        },
      ],
    };
    await host.render([landed]);
    expect(host.get().pendingById.size).toBe(0);
    expect(host.get().threads[0]!.comments).toHaveLength(2);
    await host.unmount();
  });

  test("a failed write stays with its error, its text kept; Retry sends the same id and clears the draft", async () => {
    const host = await mount();
    host.answers.fail = "connection lost";
    await act(async () => host.get().sendWrite(reply, "reply:t1"));
    expect(host.get().pendingById.get(reply.id)?.error).toBe("connection lost");
    expect(host.statuses[host.statuses.length - 1]).toContain(
      "connection lost",
    );
    expect(takeReviewDraft("s1", "reply:t1")).toBe("Because.");
    keepReviewDraft("s1", "reply:t1", "Because.");
    host.answers.fail = null;
    await act(async () =>
      host.get().retryWrite(host.get().pendingById.get(reply.id)!),
    );
    expect(host.calls.map(([, params]) => params.new_comment_id)).toEqual([
      reply.id,
      reply.id,
    ]);
    expect(host.get().pendingById.get(reply.id)?.error).toBeUndefined();
    expect(takeReviewDraft("s1", "reply:t1")).toBeUndefined();
    await host.unmount();
  });

  test("Discard forgets a failed write and says where its text is", async () => {
    const host = await mount();
    host.answers.fail = "refused";
    const thread2: PendingWrite = { ...reply, id: "aa", replyTo: undefined };
    await act(async () => host.get().sendWrite(thread2, "new:x"));
    expect(host.calls[0]![0]).toBe("review.thread.add");
    await act(async () =>
      host.get().discardWrite(host.get().pendingById.get("aa")!),
    );
    expect(host.get().pendingById.size).toBe(0);
    expect(host.notices).toEqual([
      "Not sent. Reopen the comment to find your text.",
    ]);
    expect(takeReviewDraft("s1", "new:x")).toBe("Because.");
    await host.unmount();
  });
}
