import { inIsolatedChild } from "./testIsolated";
import { expect, test } from "bun:test";
import type { ReviewSnapshot } from "../../shared/review";

/**
 * Calls on one review session (reviewSessionCall, taken out of the review
 * pane): its id is added, and after a write its state is read back.
 */
if (
  inIsolatedChild(
    import.meta.path,
    "review session calls in an isolated runtime",
    "ROAMGATE_REVIEW_SESSION_CALL_TEST",
    30_000,
  )
) {
  const { mock } = await import("bun:test");
  const calls: [string, string, Record<string, unknown>][] = [];
  const remembered: ReviewSnapshot[] = [];
  let failGet = false;
  mock.module("./review", () => ({
    reviewCall: async (
      connection: string,
      method: string,
      params: Record<string, unknown> = {},
    ) => {
      calls.push([connection, method, params]);
      if (method === "review.get") {
        if (failGet) throw new Error("socket lost");
        return { session: { id: params.session_id } };
      }
      if (method === "review.fail") throw new Error("refused");
      return { ok: method };
    },
    rememberReviewSnapshot: (snapshot: ReviewSnapshot) => {
      remembered.push(snapshot);
    },
    useReviewState: () => ({ sessions: new Map(), openRequest: null }),
  }));
  const { callReviewSession, REVIEW_WRITES } = await import(
    "./reviewSessionCall"
  );
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

  test("a call names its session", async () => {
    calls.length = 0;
    expect(
      await callReviewSession("c1", "s1", "review.diff", { commit: "a" }),
    ).toEqual({ ok: "review.diff" });
    await settle();
    expect(calls).toEqual([
      ["c1", "review.diff", { session_id: "s1", commit: "a" }],
    ]);
    expect(remembered).toEqual([]);
  });

  test("every write is read back and remembered: a lost push loses no comment", async () => {
    expect([...REVIEW_WRITES].sort()).toEqual([
      "review.adopt",
      "review.delete",
      "review.edit",
      "review.reply",
      "review.resolve",
      "review.restore",
      "review.thread.add",
    ]);
    for (const method of REVIEW_WRITES) {
      calls.length = 0;
      remembered.length = 0;
      await callReviewSession("c1", "s1", method, { text: "x" });
      await settle();
      expect(calls.map(([, called]) => called)).toEqual([method, "review.get"]);
      expect(calls[1]![2]).toEqual({ session_id: "s1" });
      expect(remembered).toEqual([
        { session: { id: "s1" } } as unknown as ReviewSnapshot,
      ]);
    }
  });

  test("a read-back that fails is quiet; a call that fails says so and reads nothing", async () => {
    failGet = true;
    remembered.length = 0;
    await callReviewSession("c1", "s1", "review.reply", {});
    await settle();
    expect(remembered).toEqual([]);
    failGet = false;
    calls.length = 0;
    await expect(
      callReviewSession("c1", "s1", "review.fail", {}),
    ).rejects.toThrow("refused");
    expect(calls.map(([, called]) => called)).toEqual(["review.fail"]);
  });
}
