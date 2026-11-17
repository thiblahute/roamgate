import { reviewServiceForTest } from "./testkit";
import { expect, test } from "bun:test";

/**
 * Threads shared between a rendered file and the code reviews of its
 * checkout: each lives in the review it was written in, and shows in both.
 */
function setup() {
  const prompts: { pane: string; text: string }[] = [];
  const { service, pushes } = reviewServiceForTest({
    deliveryDelayMs: 10,
    promptAgent: async (_connection, pane, text) => {
      prompts.push({ pane, text });
    },
  });
  const open = (target: Record<string, unknown>, root = "/repo") =>
    service.open({
      connectionId: "local",
      root,
      target,
      agent: "claude",
      paneId: "w1:p1",
      raise: false,
    }).session;
  return { service, prompts, pushes, open };
}

const onPlan = (line: number) => ({
  path: "plan.md",
  line,
  side: "new",
  text: `line ${line}`,
});

test("a thread made in either view shows in the other", async () => {
  const { service, open } = setup();
  const rendered = open({ kind: "rendered", path: "plan.md" });
  const code = open({ kind: "range", base: "main", head: "topic" });
  const other = open({ kind: "rendered", path: "other.md" });
  const elsewhere = open({ kind: "worktree" }, "/elsewhere");
  const fromRendered = await service.addThread({
    sessionId: rendered.id,
    anchor: { ...onPlan(3), render: { quote: "the words" } },
    text: "From the rendered view",
  });
  const fromCode = await service.addThread({
    sessionId: code.id,
    anchor: onPlan(5),
    text: "From the diff",
  });
  await service.addThread({
    sessionId: code.id,
    anchor: { path: "src/main.rs", line: 1, side: "new" },
    text: "Not on the file",
  });
  const shared = (id: string) =>
    (service.get({ sessionId: id }).shared ?? []).map((thread) => thread.id);
  // The code review shows the rendered file's threads, each in its review.
  expect(shared(code.id)).toEqual([fromRendered.id]);
  expect(service.get({ sessionId: code.id }).shared?.[0]?.sessionId).toBe(
    rendered.id,
  );
  // The rendered file shows the code review's threads on that file only.
  expect(shared(rendered.id)).toEqual([fromCode.id]);
  expect(shared(other.id)).toEqual([]);
  // Another checkout's reviews are not linked.
  expect(shared(elsewhere.id)).toEqual([]);
  // A thread's own review keeps it in `threads`, never twice.
  expect(
    service.get({ sessionId: code.id }).threads.map((thread) => thread.id),
  ).not.toContain(fromRendered.id);
});

test("a change in one review is pushed to the reviews showing its threads", async () => {
  const { service, pushes, open } = setup();
  const rendered = open({ kind: "rendered", path: "plan.md" });
  const code = open({ kind: "worktree" });
  pushes.length = 0;
  const thread = await service.addThread({
    sessionId: rendered.id,
    anchor: onPlan(2),
    text: "Pushed to both",
  });
  const pushed = pushes.flatMap((push) =>
    push.type === "session" && push.snapshot.session.id === code.id
      ? [push.snapshot]
      : [],
  );
  expect(pushed.at(-1)?.shared?.map((each) => each.id)).toEqual([thread.id]);
});

test("replies, resolve and reopen from the other view go to the thread's review, delivered once", async () => {
  const { service, prompts, open } = setup();
  const rendered = open({ kind: "rendered", path: "plan.md" });
  const code = open({ kind: "range", base: "main", head: "topic" });
  const thread = await service.addThread({
    sessionId: rendered.id,
    anchor: onPlan(4),
    text: "First words",
  });
  await Bun.sleep(60);
  expect(prompts.filter((p) => p.text.includes("First words"))).toHaveLength(1);
  // Answered from the code review: a comment of the rendered review.
  await service.reply({
    sessionId: code.id,
    commentId: thread.id,
    text: "Said in the diff",
  });
  expect(
    service
      .get({ sessionId: rendered.id })
      .threads.find((each) => each.id === thread.id)
      ?.comments.map((comment) => comment.body),
  ).toEqual(["First words", "Said in the diff"]);
  await Bun.sleep(60);
  // Once, by the review the thread is in; the code review sends nothing.
  expect(
    prompts.filter((p) => p.text.includes("Said in the diff")),
  ).toHaveLength(1);
  expect(prompts.at(-1)?.text).toContain(`[${thread.id.slice(0, 8)}]`);
  expect(service.get({ sessionId: code.id }).session.deliveredAt).toBe(
    undefined,
  );
  // Resolved from the code review, reopened from the rendered view.
  service.resolve({ sessionId: code.id, commentId: thread.id });
  expect(
    service.get({ sessionId: code.id }).shared?.find((t) => t.id === thread.id)
      ?.resolved,
  ).toBe(true);
  service.resolve({
    sessionId: rendered.id,
    commentId: thread.id,
    resolved: false,
  });
  expect(
    service.get({ sessionId: code.id }).shared?.find((t) => t.id === thread.id)
      ?.resolved,
  ).toBe(false);
  // The agent answers by the comment id alone: its review is found.
  expect(
    service.sessionOfComment({ connectionId: "local", commentId: thread.id }),
  ).toBe(rendered.id);
});

test("a sub-thread on a part of a shared thread's comment lives in that thread's review", async () => {
  const { service, open } = setup();
  const rendered = open({ kind: "rendered", path: "plan.md" });
  const code = open({ kind: "worktree" });
  const thread = await service.addThread({
    sessionId: code.id,
    anchor: onPlan(7),
    text: "Option a or option b?",
  });
  const part = await service.addThread({
    sessionId: rendered.id,
    anchor: {
      ...onPlan(7),
      message: {
        thread: thread.id,
        comment: thread.comments[0]!.id,
        quote: "option b",
      },
    },
    text: "Why b?",
  });
  expect(part.sessionId).toBe(code.id);
  expect(
    service.get({ sessionId: rendered.id }).shared?.map((t) => t.id),
  ).toEqual([thread.id, part.id]);
});
