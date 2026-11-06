import { expect, test } from "bun:test";
import type { ReviewPush } from "../../../shared/review";
import { createAgentPrompts, permissionSummary } from "./prompts";

function setup() {
  const pushes: ReviewPush[] = [];
  const prompts = createAgentPrompts({ publish: (push) => pushes.push(push) });
  const ask = (
    overrides: Partial<Parameters<typeof prompts.request>[0]> = {},
  ) =>
    prompts.request({
      connectionId: "local",
      paneId: "w1:p2",
      agent: "Claude",
      tool: "Bash",
      input: { command: "rm -rf build" },
      canAlways: true,
      timeoutMs: 1_000,
      ...overrides,
    });
  return { pushes, prompts, ask };
}

test("a prompt waits for the browser's answer", async () => {
  const { pushes, prompts, ask } = setup();
  const waiting = ask();
  const [prompt] = prompts.list("local");
  expect(prompt).toMatchObject({
    paneId: "w1:p2",
    tool: "Bash",
    summary: "rm -rf build",
    canAlways: true,
  });
  expect(pushes.at(-1)).toMatchObject({
    type: "prompts",
    connectionId: "local",
  });
  // Another connection cannot answer it.
  expect(
    prompts.answer({ connectionId: "other", id: prompt!.id, answer: "allow" }),
  ).toBe(false);
  expect(
    prompts.answer({ connectionId: "local", id: prompt!.id, answer: "always" }),
  ).toBe(true);
  expect(await waiting).toBe("always");
  expect(prompts.list("local")).toEqual([]);
  expect(pushes.at(-1)).toMatchObject({ type: "prompts", prompts: [] });
  // Answered once only.
  expect(
    prompts.answer({ connectionId: "local", id: prompt!.id, answer: "deny" }),
  ).toBe(false);
});

test("an unanswered prompt goes back to the terminal", async () => {
  const { prompts, ask } = setup();
  expect(await ask({ timeoutMs: 20 })).toBeNull();
  const hook = new AbortController();
  const waiting = ask({ signal: hook.signal });
  hook.abort();
  expect(await waiting).toBeNull();
  expect(prompts.list("local")).toEqual([]);
});

test("always needs the terminal's own don't-ask-again rules", async () => {
  const { prompts, ask } = setup();
  const waiting = ask({ canAlways: false });
  const [prompt] = prompts.list("local");
  expect(
    prompts.answer({ connectionId: "local", id: prompt!.id, answer: "always" }),
  ).toBe(false);
  prompts.answer({ connectionId: "local", id: prompt!.id, answer: "deny" });
  expect(await waiting).toBe("deny");
});

test("the summary is what the tool would do", () => {
  expect(
    permissionSummary("Edit", { file_path: "/a.ts", old_string: "x" }),
  ).toBe("/a.ts");
  expect(permissionSummary("WebFetch", { url: "https://x.y" })).toBe(
    "https://x.y",
  );
  expect(permissionSummary("Mystery", { other: 1 })).toBe("Mystery");
});

test("Claude's questions are answered with the chosen options", async () => {
  const { prompts, ask } = setup();
  const waiting = ask({
    tool: "AskUserQuestion",
    canAlways: false,
    questions: [
      {
        question: "Which colors?",
        options: [{ label: "Red" }, { label: "Blue" }],
        multiSelect: true,
      },
    ],
  });
  const [prompt] = prompts.list("local");
  expect(prompt!.questions?.[0]?.question).toBe("Which colors?");
  // A question takes answers, not a permission decision.
  expect(
    prompts.answer({ connectionId: "local", id: prompt!.id, answer: "allow" }),
  ).toBe(false);
  expect(
    prompts.answer({
      connectionId: "local",
      id: prompt!.id,
      answer: { answers: { "Which colors?": "Red, Blue" } },
    }),
  ).toBe(true);
  expect(await waiting).toEqual({ answers: { "Which colors?": "Red, Blue" } });
});

test("In the terminal hands a prompt back unanswered", async () => {
  const { prompts, ask } = setup();
  const waiting = ask();
  const [prompt] = prompts.list("local");
  expect(prompts.release({ connectionId: "other", id: prompt!.id })).toBe(
    false,
  );
  expect(prompts.release({ connectionId: "local", id: prompt!.id })).toBe(true);
  expect(await waiting).toBeNull();
});

test("a question or a permission may be dismissed, unanswered", async () => {
  for (const questions of [
    [{ question: "Which?", options: [{ label: "A" }], multiSelect: false }],
    undefined,
  ]) {
    const { prompts, ask } = setup();
    const waiting = ask(
      questions ? { tool: "AskUserQuestion", canAlways: false, questions } : {},
    );
    const [prompt] = prompts.list("local");
    expect(
      prompts.answer({
        connectionId: "local",
        id: prompt!.id,
        answer: "dismiss",
      }),
    ).toBe(true);
    expect(await waiting).toBe("dismiss");
    expect(prompts.list("local")).toEqual([]);
  }
});

test("a file edit's prompt carries the change it asks to make", async () => {
  const { prompts, ask } = setup();
  const waiting = ask({
    tool: "Edit",
    input: { file_path: "/w/a.ts", old_string: "a", new_string: "b" },
  });
  const [prompt] = prompts.list("local");
  expect(prompt?.summary).toBe("/w/a.ts");
  expect(prompt?.file_edit).toEqual({
    path: "/w/a.ts",
    added: 1,
    removed: 1,
    hunks: [{ lines: ["-a", "+b"] }],
  });
  prompts.answer({ connectionId: "local", id: prompt!.id, answer: "deny" });
  await waiting;
  // Other tools have none.
  const bash = ask();
  expect(prompts.list("local")[0]?.file_edit).toBeUndefined();
  prompts.answer({
    connectionId: "local",
    id: prompts.list("local")[0]!.id,
    answer: "deny",
  });
  await bash;
});
