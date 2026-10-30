import { expect, test } from "bun:test";
import { isReviewPush } from "./api";
import { isReviewSnapshot, validReviewSnapshots } from "./reviewValidate";

function snapshot(): Record<string, any> {
  return {
    session: {
      id: "s1",
      connectionId: "desktop",
      root: "/r",
      title: "Review",
      target: { kind: "range", base: "main", head: "HEAD" },
      summary: "",
      agent: {},
      createdAt: "2026-10-30",
      updatedAt: "2026-10-30",
    },
    threads: [
      {
        id: "t1",
        kind: "discussion",
        anchor: {},
        comments: [{ id: "c1", author: "you", body: "Why?" }],
      },
    ],
  };
}

test("a well formed review passes", () => {
  expect(isReviewSnapshot(snapshot())).toBe(true);
  const worktree = snapshot();
  worktree.session.target = { kind: "worktree" };
  expect(isReviewSnapshot(worktree)).toBe(true);
  const mr = snapshot();
  mr.session.target = {
    kind: "mr",
    url: "https://gitlab.example/a/-/merge_requests/1",
  };
  mr.threads[0].kind = "merge-request";
  expect(isReviewSnapshot(mr)).toBe(true);
});

test("a review missing what the pane reads is refused", () => {
  const broken: Array<(value: Record<string, any>) => void> = [
    (value) => delete value.session.root,
    (value) => (value.session.title = 3),
    (value) => (value.session.target = { kind: 3 }),
    (value) => (value.session.target = { kind: "mr" }),
    (value) => (value.session.target = { kind: "range", base: "main" }),
    (value) => (value.session.agent = null),
    (value) => delete value.session.updatedAt,
    (value) => (value.threads = [null]),
    (value) => (value.threads[0].kind = 7),
    (value) => (value.threads[0].comments = "none"),
    (value) => (value.threads[0].comments = [{ id: "c", author: "you" }]),
  ];
  for (const breakIt of broken) {
    const value = snapshot();
    breakIt(value);
    expect(isReviewSnapshot(value)).toBe(false);
  }
});

test("a list keeps only its valid reviews", () => {
  const bad = snapshot();
  bad.threads = [{}];
  expect(validReviewSnapshots([snapshot(), bad, null, "x"]).length).toBe(1);
  expect(validReviewSnapshots(undefined)).toEqual([]);
});

test("pushes are checked down to the review they carry", () => {
  expect(isReviewPush({ type: "session", snapshot: snapshot() })).toBe(true);
  const bad = snapshot();
  bad.threads = [{ id: "t", kind: "draft", comments: [{}] }];
  expect(isReviewPush({ type: "session", snapshot: bad })).toBe(false);
  expect(
    isReviewPush({ type: "removed", sessionId: "s1", connectionId: "d" }),
  ).toBe(true);
  expect(
    isReviewPush({
      type: "open",
      sessionId: "s1",
      connectionId: "d",
      message: "Look at this",
    }),
  ).toBe(true);
  expect(
    isReviewPush({
      type: "open",
      sessionId: "s1",
      connectionId: "d",
      message: { text: "no" },
    }),
  ).toBe(false);
  expect(isReviewPush({ type: "other" })).toBe(false);
});
