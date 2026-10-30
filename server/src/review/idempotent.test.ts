import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ReviewThread } from "../../../shared/review";
import { handleReviewRpc } from "./rpc";
import { createReviewService, type ReviewService } from "./service";
import { openReviewStorage } from "./storage";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function setup(): { service: ReviewService; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "roamgate-review-idem-"));
  const service = createReviewService({
    storage: openReviewStorage(dir),
    publish: () => {},
    loadDiff: async () => ({ files: [], truncated: false }),
  });
  cleanups.push(() => {
    service.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return { service, dir };
}

const local = { id: "local", resolveRoot: async () => "/repo" };

async function open(
  service: ReviewService,
  target: Record<string, unknown> = { kind: "worktree" },
) {
  const opened = (await handleReviewRpc(service, local, "review.open", {
    workspace_id: "w1",
    target,
  })) as { session: { id: string } };
  return opened.session.id;
}

const call = (
  service: ReviewService,
  method: string,
  params: Record<string, unknown>,
) => handleReviewRpc(service, local, method, params) as Promise<ReviewThread>;

test("a reply sent again with the same id is written once", async () => {
  const { service } = setup();
  const session = await open(service);
  const thread = await call(service, "review.thread.add", {
    session_id: session,
    kind: "discussion",
    anchor: {},
    text: "Why?",
  });
  const reply = {
    session_id: session,
    comment_id: thread.id,
    new_comment_id: "00112233aabbccdd",
    text: "but i like my overlay!",
  };
  await call(service, "review.reply", reply);
  await call(service, "review.reply", reply);
  const again = await call(service, "review.reply", reply);
  expect(again.comments.map((comment) => comment.id)).toEqual([
    thread.comments[0]!.id,
    "00112233aabbccdd",
  ]);
  const { threads } = service.get({ sessionId: session });
  expect(threads[0]!.comments).toHaveLength(2);
});

test("a new thread sent again with the same id is made once", async () => {
  const { service, dir } = setup();
  const session = await open(service);
  const add = {
    session_id: session,
    kind: "discussion",
    anchor: { path: "a.ts", line: 3, side: "new" },
    new_thread_id: "aabbccdd00112233",
    text: "Look here",
  };
  const first = await call(service, "review.thread.add", add);
  const second = await call(service, "review.thread.add", add);
  expect(first.id).toBe("aabbccdd00112233");
  expect(second.id).toBe(first.id);
  expect(service.get({ sessionId: session }).threads).toHaveLength(1);
  // Still once after a restart.
  service.close();
  const reopened = createReviewService({
    storage: openReviewStorage(dir),
    publish: () => {},
    loadDiff: async () => ({ files: [], truncated: false }),
  });
  cleanups.unshift(() => reopened.close());
  await call(reopened, "review.thread.add", add);
  expect(reopened.get({ sessionId: session }).threads).toHaveLength(1);
});

test("an id taken elsewhere or badly shaped is refused", async () => {
  const { service } = setup();
  const one = await open(service);
  const two = await open(service, {
    kind: "range",
    base: "main",
    head: "HEAD",
  });
  expect(two).not.toBe(one);
  await call(service, "review.thread.add", {
    session_id: one,
    kind: "discussion",
    anchor: {},
    new_thread_id: "aabbccdd00112233",
    text: "Mine",
  });
  // Another review cannot take (and overwrite) it.
  await expect(
    call(service, "review.thread.add", {
      session_id: two,
      kind: "discussion",
      anchor: {},
      new_thread_id: "aabbccdd00112233",
      text: "Theirs",
    }),
  ).rejects.toThrow("already used");
  const other = await call(service, "review.thread.add", {
    session_id: one,
    kind: "discussion",
    anchor: {},
    text: "Another",
  });
  // A reply cannot reuse a thread's id, nor a comment of another thread.
  await expect(
    call(service, "review.reply", {
      session_id: one,
      comment_id: other.id,
      new_comment_id: "aabbccdd00112233",
      text: "x",
    }),
  ).rejects.toThrow("already used");
  for (const bad of ["../..", "ABCDEF0011223344", "abc", 12]) {
    await expect(
      call(service, "review.reply", {
        session_id: one,
        comment_id: other.id,
        new_comment_id: bad,
        text: "x",
      }),
    ).rejects.toThrow("16 hexadecimal digits");
  }
  expect(service.get({ sessionId: two }).threads).toHaveLength(0);
});
