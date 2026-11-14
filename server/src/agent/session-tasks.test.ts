import { expect, test } from "bun:test";
import {
  type AgentTask,
  commandOutputsToWatch,
  parseSessionTasks,
  withCommandActivity,
} from "./session-tasks";

const use = (id: string, name: string, input: Record<string, unknown>) => ({
  type: "assistant",
  timestamp: "2026-10-24T10:00:00.000Z",
  message: {
    role: "assistant",
    content: [{ type: "tool_use", id, name, input }],
  },
});
const result = (
  id: string,
  text: string,
  toolUseResult: Record<string, unknown> = {},
  isError = false,
) => ({
  type: "user",
  timestamp: "2026-10-24T10:00:01.000Z",
  toolUseResult,
  message: {
    role: "user",
    content: [
      {
        type: "tool_result",
        tool_use_id: id,
        content: text,
        is_error: isError,
      },
    ],
  },
});
const notification = (body: string, at = "2026-10-24T10:05:00.000Z") => ({
  type: "attachment",
  timestamp: at,
  attachment: {
    type: "queued_command",
    prompt: `<task-notification>\n${body}\n</task-notification>`,
    origin: { kind: "task-notification" },
  },
});

test("background commands and subagents, with how they ended", () => {
  const tasks = parseSessionTasks([
    use("t1", "Bash", {
      command: "bun run test",
      description: "Run the tests",
      run_in_background: true,
    }),
    result(
      "t1",
      "Command running in background with ID: b1. Output is being written to: /tmp/tasks/b1.output. You will be notified.",
      { backgroundTaskId: "b1" },
    ),
    use("t2", "Agent", {
      description: "Review the diff",
      subagent_type: "Explore",
      prompt: "...",
    }),
    result("t2", "Async agent launched successfully.\nagentId: a9", {
      isAsync: true,
      agentId: "a9",
      outputFile: "/tmp/tasks/a9.output",
    }),
    use("t3", "Bash", { command: "ls", description: "List" }),
    result("t3", "a\nb"),
    use("t4", "Bash", {
      command: "sleep 600",
      description: "Wait",
      run_in_background: true,
    }),
    result("t4", "Command running in background with ID: b4.", {
      backgroundTaskId: "b4",
    }),
    notification(
      '<task-id>b1</task-id>\n<tool-use-id>t1</tool-use-id>\n<status>completed</status>\n<summary>Background command "Run the tests" failed with exit code 1</summary>',
    ),
    notification(
      '<task-id>a9</task-id>\n<status>completed</status>\n<summary>Agent "Review the diff" finished</summary>',
    ),
  ]);
  // Newest first; a foreground command is not a task.
  expect(tasks.map((task) => [task.id, task.kind, task.status])).toEqual([
    ["t4", "command", "running"],
    ["t2", "agent", "completed"],
    ["t1", "command", "failed"],
  ]);
  expect(tasks[2]).toMatchObject({
    title: "Run the tests",
    detail: "bun run test",
    taskId: "b1",
    exitCode: 1,
    outputFile: "/tmp/tasks/b1.output",
    endedAt: "2026-10-24T10:05:00.000Z",
  });
  expect(tasks[1]).toMatchObject({
    detail: "Explore",
    agentId: "a9",
    summary: 'Agent "Review the diff" finished',
  });
});

test("a subagent in the foreground ends with its result", () => {
  const [task] = parseSessionTasks([
    use("t1", "Agent", { description: "Find it", subagent_type: "Explore" }),
    result("t1", "Found in a.ts", { agentId: "a1", status: "completed" }),
  ]);
  expect(task).toMatchObject({
    status: "completed",
    agentId: "a1",
    summary: "Found in a.ts",
  });
});

test("workflows, teammates, and tasks lost with their session", () => {
  const tasks = parseSessionTasks([
    use("w1", "Workflow", { script: "export const meta = {}" }),
    result("w1", "Workflow launched in background. Task ID: wt1", {
      status: "async_launched",
      taskId: "wt1",
      runId: "wf_abc-123",
      workflowName: "audit",
      summary: "Audit the code",
    }),
    use("m1", "Agent", {
      name: "lat-git",
      description: "Implement the cache",
      subagent_type: "general-purpose",
      run_in_background: true,
    }),
    result("m1", "Spawned", {
      status: "async_launched",
      agentId: "alat-git-e9",
    }),
    use("old", "Bash", {
      command: "sleep 1000000",
      description: "Forever",
      run_in_background: true,
    }),
    notification(
      "<task-id>wt1</task-id>\n<status>completed</status>\n<summary>Workflow done</summary>",
      "2026-10-26T10:00:00.000Z",
    ),
  ]);
  expect(tasks.map((task) => [task.id, task.kind, task.status])).toEqual([
    ["old", "command", "lost"],
    ["m1", "teammate", "lost"],
    ["w1", "workflow", "completed"],
  ]);
  expect(tasks[2]).toMatchObject({
    title: "Audit the code",
    detail: "audit",
    runId: "wf_abc-123",
  });
  expect(tasks[1]).toMatchObject({ name: "lat-git", agentId: "alat-git-e9" });
});

const said = (text: string, at: string) => ({
  type: "user",
  timestamp: at,
  message: { role: "user", content: text },
});

test("a stopped workflow or command ends, a teammate works until idle", () => {
  const tasks = parseSessionTasks([
    use("w1", "Workflow", { script: "..." }),
    result(
      "w1",
      "Workflow launched in background. Task ID: wf1\nSummary: Build it",
      { runId: "wf_1", summary: "Build it" },
    ),
    use("s1", "TaskStop", { task_id: "wf1" }),
    result("s1", '{"message":"Successfully stopped task: wf1"}'),
    use("t1", "Agent", { name: "helper", description: "Help", prompt: "..." }),
    result("t1", "Spawned successfully.", { status: "teammate_spawned" }),
  ]);
  const workflow = tasks.find((task) => task.id === "w1");
  const teammate = tasks.find((task) => task.id === "t1");
  expect(workflow?.status).toBe("stopped");
  expect(workflow?.endedAt).toBe("2026-10-24T10:00:01.000Z");
  // Spawned is not done: it works on its own.
  expect(teammate?.status).toBe("running");

  const later = parseSessionTasks([
    use("t1", "Agent", { name: "helper", description: "Help", prompt: "..." }),
    result("t1", "Spawned successfully.", { status: "teammate_spawned" }),
    said(
      'Another Claude session sent a message:\n<teammate-message teammate_id="helper" color="blue" summary="Done">\nAll done.\n</teammate-message>',
      "2026-10-24T10:30:00.000Z",
    ),
    said(
      `<teammate-message teammate_id="helper" color="blue">\n${JSON.stringify({ type: "idle_notification", from: "helper", result: "It works now." })}\n</teammate-message>`,
      "2026-10-24T10:31:00.000Z",
    ),
  ]);
  expect(later[0]).toMatchObject({
    status: "completed",
    endedAt: "2026-10-24T10:31:00.000Z",
    summary: "It works now.",
  });
  // Sent a message again, it works again.
  const again = parseSessionTasks([
    use("t1", "Agent", { name: "helper", description: "Help", prompt: "..." }),
    result("t1", "Spawned successfully.", { status: "teammate_spawned" }),
    said(
      `<teammate-message teammate_id="helper">\n${JSON.stringify({ type: "idle_notification" })}\n</teammate-message>`,
      "2026-10-24T10:31:00.000Z",
    ),
    use("m1", "SendMessage", { to: "helper", message: "One more thing" }),
  ]);
  expect(again[0]?.status).toBe("running");
  // A failed stop leaves it running.
  const failed = parseSessionTasks([
    use("b1", "Bash", { command: "sleep 99", run_in_background: true }),
    result("b1", "Command running in background with ID: bg1.", {
      backgroundTaskId: "bg1",
    }),
    use("s1", "TaskStop", { task_id: "bg1" }),
    result("s1", "No such task", {}, true),
  ]);
  expect(failed[0]?.status).toBe("running");
});

test("request records replaying a task's call do not restart it", () => {
  const replay = {
    type: "api-request-blob",
    timestamp: "2026-10-24T10:09:00.000Z",
    message: {
      role: "assistant",
      content: [
        {
          type: "tool_use",
          id: "t1",
          name: "Bash",
          input: { command: "make", run_in_background: true },
        },
      ],
    },
  };
  const tasks = parseSessionTasks([
    use("t1", "Bash", {
      command: "make",
      description: "Build",
      run_in_background: true,
    }),
    result(
      "t1",
      "Command running in background with ID: b1. Output is being written to: /tmp/tasks/b1.output.",
      { backgroundTaskId: "b1" },
    ),
    notification(
      '<task-id>b1</task-id>\n<tool-use-id>t1</tool-use-id>\n<output-file>/tmp/tasks/b1.output</output-file>\n<status>completed</status>\n<summary>Background command "Build" completed (exit code 0)</summary>',
    ),
    replay,
  ]);
  expect(tasks).toHaveLength(1);
  expect(tasks[0]!.status).toBe("completed");
  expect(tasks[0]!.endedAt).toBe("2026-10-24T10:05:00.000Z");
});

test("a background command the permission check refused never runs", () => {
  const refusal = {
    type: "user",
    timestamp: "2026-10-24T10:00:01.000Z",
    toolUseResult:
      "Error: Permission for this action was denied by the Claude Code auto mode classifier.",
    message: {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "t9",
          content:
            "Permission for this action was denied by the Claude Code auto mode classifier.",
          is_error: false,
        },
      ],
    },
  };
  const tasks = parseSessionTasks([
    use("t9", "Bash", {
      command: "gen --yes",
      description: "Regenerate",
      run_in_background: true,
    }),
    refusal,
  ]);
  expect(tasks[0]!.status).toBe("failed");
  expect(tasks[0]!.summary).toContain("denied");
});

const NOW = Date.parse("2026-10-24T12:00:00.000Z");
const minutesAgo = (minutes: number) =>
  new Date(NOW - minutes * 60_000).toISOString();
const runningCommand = (startedMinutesAgo: number): AgentTask => ({
  id: "t1",
  kind: "command",
  title: "Build",
  status: "running",
  startedAt: minutesAgo(startedMinutesAgo),
  outputFile: "/tmp/tasks/b1.output",
});
const outputAt = (minutes: number) =>
  new Map([["/tmp/tasks/b1.output", { mtimeMs: NOW - minutes * 60_000 }]]);
const nobody = () => false;

test("a silent command runs on only while a process holds its output", () => {
  const task = runningCommand(120);
  const silent = outputAt(30);
  // Held: still running, however long it has been silent.
  expect(withCommandActivity([task], silent, NOW, () => true)[0]!.status).toBe(
    "running",
  );
  // Nothing holds it: lost, ended at its last write.
  const lost = withCommandActivity([task], silent, NOW, nobody)[0]!;
  expect(lost.status).toBe("lost");
  expect(lost.endedAt).toBe(minutesAgo(30));
  expect(lost.summary).toContain("ended without a result");
  // The given task is not changed.
  expect(task.status).toBe("running");
});

test("a command that writes again stays running; a fresh one is not looked at", () => {
  const task = runningCommand(120);
  expect(withCommandActivity([task], outputAt(2), NOW, nobody)[0]!.status).toBe(
    "running",
  );
  expect(commandOutputsToWatch([task], NOW)).toEqual(["/tmp/tasks/b1.output"]);
  expect(commandOutputsToWatch([runningCommand(3)], NOW)).toEqual([]);
});

test("where no process list is available, silence must last an hour", () => {
  const task = runningCommand(180);
  const unknown = () => null;
  expect(
    withCommandActivity([task], outputAt(30), NOW, unknown)[0]!.status,
  ).toBe("running");
  expect(
    withCommandActivity([task], outputAt(61), NOW, unknown)[0]!.status,
  ).toBe("lost");
});

test("a command with an end notice, or an unknown output, is left alone", () => {
  const done = { ...runningCommand(120), status: "completed" as const };
  const unseen = runningCommand(120);
  expect(
    withCommandActivity([done], outputAt(30), NOW, nobody)[0]!.status,
  ).toBe("completed");
  expect(withCommandActivity([unseen], new Map(), NOW, nobody)[0]!.status).toBe(
    "running",
  );
});
