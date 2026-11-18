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

test("a checkout's code reviews show each other's threads, whatever they compare", async () => {
  const { service, open, pushes } = setup();
  // The three a checkout gathered: its working tree (Files, Working), the
  // branch against Automatic's base, an agent's range of the branch.
  const worktree = open({ kind: "worktree" });
  const branch = open({ kind: "range", base: "origin/main", head: "HEAD" });
  const agents = open({ kind: "range", base: "main", head: "topic" });
  // Not the checkout's code as one review: a compare, a step, another
  // checkout's.
  const compare = open({
    kind: "range",
    base: "topic-before",
    head: "topic",
    compare: true,
  });
  const step = open({
    kind: "step",
    step: "s1",
    before: "a".repeat(40),
    after: "b".repeat(40),
  });
  const elsewhere = open({ kind: "worktree" }, "/elsewhere");
  const add = async (sessionId: string, text: string, path?: string) =>
    (
      await service.addThread({
        sessionId,
        anchor: path ? { path, line: 1, side: "new", text: "x" } : {},
        text,
      })
    ).id;
  const onWorktree = await add(worktree.id, "In Files", "NAMING.md");
  const onBranch = await add(branch.id, "On a commit", "play.c");
  const onAgents = await add(agents.id, "Re-posted", "api.rs");
  const general = await add(branch.id, "On the whole branch");
  const onCompare = await add(compare.id, "Compared", "play.c");
  const onStep = await add(step.id, "A step", "play.c");
  await add(elsewhere.id, "Elsewhere", "play.c");
  const shared = (id: string) =>
    (service.get({ sessionId: id }).shared ?? [])
      .map((thread) => thread.id)
      .sort();
  expect(shared(agents.id)).toEqual([onWorktree, onBranch, general].sort());
  expect(shared(worktree.id)).toEqual([onBranch, onAgents, general].sort());
  expect(shared(branch.id)).toEqual([onWorktree, onAgents].sort());
  // Each stays in its own review, which takes what is written on it.
  expect(
    service
      .get({ sessionId: agents.id })
      .shared?.find((thread) => thread.id === onBranch)?.sessionId,
  ).toBe(branch.id);
  for (const id of [compare.id, step.id, elsewhere.id])
    expect(shared(id)).not.toContain(onBranch);
  expect(shared(agents.id)).not.toContain(onCompare);
  expect(shared(agents.id)).not.toContain(onStep);
  // A reply from the agent's review goes to the thread's own review.
  pushes.length = 0;
  await service.reply({
    sessionId: agents.id,
    commentId: onBranch,
    author: "claude",
    text: "Answered from the agent's review",
  });
  expect(
    service
      .get({ sessionId: branch.id })
      .threads.find((thread) => thread.id === onBranch)
      ?.comments.map((comment) => comment.body),
  ).toEqual(["On a commit", "Answered from the agent's review"]);
  // The reviews showing it are told.
  const told = new Set(
    pushes.flatMap((push) =>
      push.type === "session" ? [push.snapshot.session.id] : [],
    ),
  );
  expect(told.has(agents.id)).toBe(true);
  expect(told.has(worktree.id)).toBe(true);
});
