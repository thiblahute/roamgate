import { describe, expect, test } from "bun:test";
import type { ReviewAnnotation } from "./annotations";
import { pendingFeedback } from "./feedbackPending";

const note = (id: string) =>
  ({ id, source: "diff", comment: id }) as unknown as ReviewAnnotation;

describe("pendingFeedback", () => {
  test("a write is pending, fails with its reason, and is gone once done", () => {
    const calls: string[] = [];
    pendingFeedback.start(note("n1"), {
      retry: () => calls.push("retry"),
      discard: () => calls.push("discard"),
    });
    expect(pendingFeedback.get("n1")?.error).toBeUndefined();
    pendingFeedback.fail("n1", "offline");
    expect(pendingFeedback.get("n1")?.error).toBe("offline");
    pendingFeedback.get("n1")?.retry();
    pendingFeedback.get("n1")?.discard();
    expect(calls).toEqual(["retry", "discard"]);
    // Retried: pending again, no error.
    pendingFeedback.start(note("n1"), { retry() {}, discard() {} });
    expect(pendingFeedback.get("n1")?.error).toBeUndefined();
    pendingFeedback.done("n1");
    expect(pendingFeedback.get("n1")).toBeUndefined();
    expect(pendingFeedback.all().size).toBe(0);
  });

  test("listeners hear each change and stop when they leave", () => {
    let heard = 0;
    const leave = pendingFeedback.subscribe(() => heard++);
    pendingFeedback.start(note("n2"), { retry() {}, discard() {} });
    pendingFeedback.done("n2");
    leave();
    pendingFeedback.start(note("n3"), { retry() {}, discard() {} });
    pendingFeedback.done("n3");
    expect(heard).toBe(2);
  });
});
