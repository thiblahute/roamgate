import { expect, test } from "bun:test";
import type { ReviewThread } from "../../shared/review";
import {
  newClientId,
  type PendingWrite,
  pendingWriteCall,
  withPendingWrites,
  writeLanded,
} from "./reviewPending";

const thread: ReviewThread = {
  id: "t1",
  sessionId: "s1",
  kind: "discussion",
  anchor: { path: "a.ts", line: 2 },
  comments: [
    {
      id: "c1",
      author: "you",
      body: "Why?",
      createdAt: "2026-10-31T19:16:11Z",
      updatedAt: "2026-10-31T19:16:11Z",
    },
  ],
  resolved: false,
  createdAt: "2026-10-31T19:16:11Z",
  updatedAt: "2026-10-31T19:16:11Z",
};

const reply: PendingWrite = {
  id: "00112233aabbccdd",
  sessionId: "s1",
  replyTo: "t1",
  kind: "discussion",
  anchor: thread.anchor,
  text: "but i like my overlay!",
  at: "2026-10-31T19:22:36Z",
};

test("client ids are shaped as the server's", () => {
  const id = newClientId();
  expect(id).toMatch(/^[0-9a-f]{16}$/);
  expect(newClientId()).not.toBe(id);
});

test("a reply shows at the end of its thread until it landed", () => {
  const [shown] = withPendingWrites([thread], [reply]);
  expect(shown!.comments.map((comment) => comment.id)).toEqual([
    "c1",
    "00112233aabbccdd",
  ]);
  expect(shown!.comments[1]!.author).toBe("you");
  const landed = {
    ...thread,
    comments: [...thread.comments, { ...shown!.comments[1]! }],
  };
  expect(writeLanded([landed], reply)).toBe(true);
  // Landed: not shown twice.
  expect(withPendingWrites([landed], [reply])[0]!.comments).toHaveLength(2);
});

test("a new thread shows as one of its own until it landed", () => {
  const write: PendingWrite = {
    ...reply,
    id: "aabbccdd00112233",
    replyTo: undefined,
    anchor: { path: "b.ts", line: 9 },
  };
  const shown = withPendingWrites([thread], [write]);
  expect(shown.map((t) => t.id)).toEqual(["t1", "aabbccdd00112233"]);
  expect(shown[1]!.anchor).toEqual({ path: "b.ts", line: 9 });
  expect(
    withPendingWrites([thread, { ...thread, id: write.id }], [write]),
  ).toHaveLength(2);
  // Nothing pending: the same threads.
  const threads = [thread];
  expect(withPendingWrites(threads, [])).toBe(threads);
});

test("a write is sent with its id, the same every time", () => {
  expect(pendingWriteCall(reply)).toEqual({
    method: "review.reply",
    params: {
      comment_id: "t1",
      new_comment_id: "00112233aabbccdd",
      text: "but i like my overlay!",
    },
  });
  const write = { ...reply, replyTo: undefined };
  expect(pendingWriteCall(write).method).toBe("review.thread.add");
  expect(pendingWriteCall(write).params.new_thread_id).toBe("00112233aabbccdd");
});
