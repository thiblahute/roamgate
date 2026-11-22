import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createReviewService } from "./service";
import { openReviewStorage } from "./storage";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function reviewService() {
  const dir = mkdtempSync(join(tmpdir(), "roamgate-review-"));
  const service = createReviewService({
    storage: openReviewStorage(dir),
    publish: () => {},
    loadDiff: async () => ({ files: [], truncated: false }),
  });
  cleanups.push(() => {
    service.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return service;
}

/** An agent answers the user, never itself: replyHere refuses it. */

test("an agent replying to its own last comment is pointed at review_edit", async () => {
  const service = reviewService();
  const session = service.open({
    connectionId: "local",
    root: "/repo",
    target: { kind: "range", base: "main", head: "HEAD" },
    agent: "Claude",
    paneId: "w1:p2",
  }).session;
  const thread = await service.addThread({
    sessionId: session.id,
    text: "Why?",
  });
  const answer = await service.reply({
    sessionId: session.id,
    commentId: thread.id,
    author: "Claude",
    text: "Because",
  });
  const mine = answer.comments.at(-1)!.id.slice(0, 8);
  await expect(
    service.reply({
      sessionId: session.id,
      commentId: thread.id,
      author: "Claude",
      text: "And also",
    }),
  ).rejects.toThrow(
    `the last comment of this thread is yours: correct it with review_edit (comment_id: ${mine}`,
  );
  // The user answers: the agent may again.
  await service.reply({
    sessionId: session.id,
    commentId: thread.id,
    text: "Ok?",
  });
  const again = await service.reply({
    sessionId: session.id,
    commentId: thread.id,
    author: "Claude",
    text: "Yes",
  });
  expect(again.comments.at(-1)!.body).toBe("Yes");
});
