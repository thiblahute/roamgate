import { describe, expect, test } from "bun:test";
import { rewoundRecordIds } from "./session-rewind";
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

test("a foreground command or subagent moved to the background becomes a task", () => {
  const tasks = parseSessionTasks([
    use("t1", "Bash", { command: "make", description: "Build" }),
    result(
      "t1",
      "Command was manually backgrounded by user with ID: b1. Output is being written to: /tmp/tasks/b1.output.",
      { backgroundTaskId: "b1", backgroundedByUser: true },
    ),
    use("t2", "Bash", { command: "bun run test" }),
    // Its timeout moved it there; the payload withheld, the text says so.
    result(
      "t2",
      "Command did not complete within its 120s timeout and was moved to the background (ID: b2). Output is being written to: /tmp/tasks/b2.output.",
    ),
    use("t3", "Agent", { description: "Review", subagent_type: "Explore" }),
    result("t3", "Async agent launched successfully.\nagentId: a3", {
      isAsync: true,
      status: "async_launched",
      agentId: "a3",
    }),
    notification(
      '<task-id>b1</task-id>\n<tool-use-id>t1</tool-use-id>\n<status>killed</status>\n<summary>Background command "Build" was stopped</summary>',
    ),
  ]);
  expect(tasks.map((task) => [task.id, task.kind, task.status])).toEqual([
    ["t3", "agent", "running"],
    ["t2", "command", "running"],
    ["t1", "command", "stopped"],
  ]);
  expect(tasks[1]).toMatchObject({
    title: "bun run test",
    taskId: "b2",
    outputFile: "/tmp/tasks/b2.output",
  });
  expect(tasks[2]).toMatchObject({
    title: "Build",
    detail: "make",
    taskId: "b1",
    outputFile: "/tmp/tasks/b1.output",
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

// A conversation with a rewind, in Claude Code's own records: each record
// names its parent, and the rewind adds a last-prompt record naming the
// message it cut. The conversation goes on from before that message.
describe("tasks started in a rewound part", () => {
  const session = "362be254-14eb-4390-a96c-25032526572a";
  const record = (
    uuid: string,
    parentUuid: string | null,
    timestamp: string,
    fields: Record<string, unknown>,
  ) => ({
    parentUuid,
    isSidechain: false,
    uuid,
    timestamp,
    userType: "external",
    entrypoint: "sdk-cli",
    sessionId: session,
    version: "2.1.316",
    ...fields,
  });
  const prompt = (
    uuid: string,
    parent: string | null,
    at: string,
    text: string,
  ) =>
    record(uuid, parent, at, {
      type: "user",
      promptId: `${uuid}-prompt`,
      message: { role: "user", content: text },
    });
  const reply = (uuid: string, parent: string, at: string, text: string) =>
    record(uuid, parent, at, {
      type: "assistant",
      message: {
        role: "assistant",
        type: "message",
        content: [{ type: "text", text }],
      },
    });
  const call = (
    uuid: string,
    parent: string,
    at: string,
    id: string,
    name: string,
    input: Record<string, unknown>,
  ) =>
    record(uuid, parent, at, {
      type: "assistant",
      message: {
        role: "assistant",
        type: "message",
        content: [
          { type: "tool_use", id, name, input, caller: { type: "direct" } },
        ],
        stop_reason: "tool_use",
      },
    });
  const launched = (
    uuid: string,
    parent: string,
    at: string,
    id: string,
    text: string,
    toolUseResult: Record<string, unknown>,
  ) =>
    record(uuid, parent, at, {
      type: "user",
      message: {
        role: "user",
        content: [
          {
            tool_use_id: id,
            type: "tool_result",
            content: [{ type: "text", text }],
          },
        ],
      },
      toolUseResult,
      sourceToolAssistantUUID: parent,
    });
  const system = (uuid: string, parent: string, at: string) =>
    record(uuid, parent, at, { type: "system", subtype: "turn_duration" });
  const lastPrompt = (fields: Record<string, unknown>) => ({
    type: "last-prompt",
    sessionId: session,
    ...fields,
  });
  const ended = (
    uuid: string,
    parent: string,
    at: string,
    taskId: string,
    toolUseId: string,
  ) =>
    record(uuid, parent, at, {
      type: "user",
      promptId: `${uuid}-prompt`,
      message: {
        role: "user",
        content: [
          "<task-notification>",
          `<task-id>${taskId}</task-id>`,
          `<tool-use-id>${toolUseId}</tool-use-id>`,
          `<output-file>/private/tmp/claude-501/x/${session}/tasks/${taskId}.output</output-file>`,
          "<status>completed</status>",
          '<summary>Agent "Make rewind degrade without checkpoints" finished</summary>',
          "</task-notification>",
        ].join("\n"),
      },
      origin: { kind: "task-notification", producer: "session-task" },
      promptSource: "system",
    });

  const agentId = "a2ad3ca23f343e44c";
  const toolUseId = "toolu_0154ikGxTsuGRZr77UMQ6jrb";
  /** Up to the rewind: an agent started in the turn the rewind cut. */
  const rewound = (
    input: Record<string, unknown>,
    toolUseResult = {},
  ): Record<string, unknown>[] => [
    prompt("u1", null, "2026-10-31T16:00:00.000Z", "Let's see"),
    reply("a1", "u1", "2026-10-31T16:00:05.000Z", "Looking."),
    system("s1", "a1", "2026-10-31T16:00:06.000Z"),
    lastPrompt({ lastPrompt: "Let's see", leafUuid: "s1" }),
    prompt("u2", "s1", "2026-10-31T16:07:00.000Z", "Fix the rewind"),
    call("c2", "u2", "2026-10-31T16:07:35.161Z", toolUseId, "Agent", input),
    launched(
      "r2",
      "c2",
      "2026-10-31T16:07:35.483Z",
      toolUseId,
      `Async agent launched successfully.\nagentId: ${agentId}`,
      {
        isAsync: true,
        status: "async_launched",
        agentId,
        outputFile: `/private/tmp/claude-501/x/${session}/tasks/${agentId}.output`,
        ...toolUseResult,
      },
    ),
    reply("a2", "r2", "2026-10-31T16:07:40.000Z", "Started it."),
    system("s2", "a2", "2026-10-31T16:07:41.000Z"),
    lastPrompt({
      leafUuid: "s1",
      explicit: true,
      rewound: true,
      cutUuid: "u2",
    }),
    prompt("u3", "s1", "2026-10-31T16:10:00.000Z", "Something else"),
    reply("a3", "u3", "2026-10-31T16:10:05.000Z", "Sure."),
  ];
  const tasksOf = (records: Record<string, unknown>[]) =>
    parseSessionTasks(records, { rewound: rewoundRecordIds(records) });
  const agent = {
    description: "Make rewind degrade without checkpoints",
    prompt: "...",
    run_in_background: true,
  };

  test("still running: listed and flagged", () => {
    expect(tasksOf(rewound(agent))).toEqual([
      expect.objectContaining({
        id: toolUseId,
        kind: "agent",
        status: "running",
        agentId,
        rewound: true,
      }),
    ]);
  });

  test("an end notice after the rewind ends it, and it leaves the list", () => {
    const records = rewound(agent);
    expect(
      tasksOf([
        ...records,
        ended("n1", "a3", "2026-10-31T16:35:17.060Z", agentId, toolUseId),
      ]),
    ).toEqual([]);
    // Matched by its agent id alone too.
    const byId = ended("n1", "a3", "2026-10-31T16:35:17.060Z", agentId, "");
    expect(tasksOf([...records, byId])).toEqual([]);
  });

  test("a day on with no end notice it is lost, and leaves the list", () => {
    expect(
      tasksOf([
        ...rewound(agent),
        reply("a4", "a3", "2026-11-01T17:00:00.000Z", "Later."),
      ]),
    ).toEqual([]);
  });

  test("tasks on the conversation's line are unchanged", () => {
    const records = [
      ...rewound(agent),
      call("c4", "a3", "2026-10-31T16:11:00.000Z", "toolu_bash", "Bash", {
        command: "bun run test",
        description: "Run the tests",
        run_in_background: true,
      }),
      launched(
        "r4",
        "c4",
        "2026-10-31T16:11:01.000Z",
        "toolu_bash",
        "Command running in background with ID: b1k2",
        { backgroundTaskId: "b1k2" },
      ),
      call(
        "c5",
        "r4",
        "2026-10-31T16:12:00.000Z",
        "toolu_done",
        "Agent",
        agent,
      ),
      launched(
        "r5",
        "c5",
        "2026-10-31T16:12:01.000Z",
        "toolu_done",
        "Async agent launched successfully.\nagentId: adone",
        { isAsync: true, status: "async_launched", agentId: "adone" },
      ),
      ended("n5", "r5", "2026-10-31T16:20:00.000Z", "adone", "toolu_done"),
    ];
    const tasks = tasksOf(records);
    expect(tasks.map((task) => [task.id, task.status, task.rewound])).toEqual([
      ["toolu_done", "completed", undefined],
      ["toolu_bash", "running", undefined],
      [toolUseId, "running", true],
    ]);
    // Without a rewind, the same tasks read the same.
    const line = records.filter(
      (each) => !["u2", "c2", "r2", "a2", "s2"].includes(String(each.uuid)),
    );
    expect(tasksOf(line)).toEqual(tasks.slice(0, 2));
  });

  test("a teammate idle but alive stays listed, until it ends", () => {
    const teammate = { ...agent, name: "rewind-no-checkpoint" };
    const idle = prompt(
      "i1",
      "a3",
      "2026-10-31T16:30:00.000Z",
      `<teammate-message teammate_id="rewind-no-checkpoint" color="blue">\n${JSON.stringify(
        {
          type: "idle_notification",
          from: "rewind-no-checkpoint",
          result: "Rebased the stack.",
        },
      )}\n</teammate-message>`,
    );
    const records = [
      ...rewound(teammate, { status: "teammate_spawned" }),
      idle,
    ];
    expect(tasksOf(records)).toEqual([
      expect.objectContaining({
        kind: "teammate",
        name: "rewind-no-checkpoint",
        status: "completed",
        summary: "Rebased the stack.",
        rewound: true,
      }),
    ]);
    expect(
      tasksOf([
        ...records,
        ended("n1", "i1", "2026-10-31T16:35:17.060Z", agentId, toolUseId),
      ]),
    ).toEqual([]);
  });
});

describe("what a session lists", () => {
  const at = (minutes: number) =>
    new Date(
      Date.parse("2026-11-10T00:00:00.000Z") + minutes * 60_000,
    ).toISOString();
  const call = (
    id: string,
    minutes: number,
    input: Record<string, unknown>,
    message = `m-${id}`,
  ) => ({
    type: "assistant",
    timestamp: at(minutes),
    message: {
      role: "assistant",
      id: message,
      content: [{ type: "tool_use", id, name: "Bash", input }],
    },
  });
  const answered = (id: string, minutes: number, taskId?: string) => ({
    type: "user",
    timestamp: at(minutes),
    toolUseResult: taskId ? { backgroundTaskId: taskId } : {},
    message: {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: id, content: "ok" }],
    },
  });
  const background = (id: string, minutes: number, ended: number) => [
    call(id, minutes, {
      command: `job ${id}`,
      description: `Job ${id}`,
      run_in_background: true,
    }),
    answered(id, minutes, `b${id}`),
    notification(
      `<task-id>b${id}</task-id>\n<status>completed</status>`,
      at(ended),
    ),
  ];

  test("ended tasks: the latest 30 of its last day, running ones all", () => {
    const records = [
      // Started and ended days before the session's latest record.
      ...background("old", 0, 5),
      // Running for two days: lost, a day after it started.
      call("forgotten", 10, {
        command: "sleep inf",
        description: "Forgotten",
        run_in_background: true,
      }),
      answered("forgotten", 10, "bforgotten"),
      ...Array.from({ length: 35 }, (_, n) =>
        background(`r${n}`, 3 * 24 * 60 + n, 3 * 24 * 60 + n + 1),
      ).flat(),
      call("live", 3 * 24 * 60 + 50, {
        command: "watch",
        description: "Still running",
        run_in_background: true,
      }),
      answered("live", 3 * 24 * 60 + 50, "blive"),
    ];
    const tasks = parseSessionTasks(records);
    const ids = tasks.map((task) => task.id);
    expect(ids[0]).toBe("live");
    expect(ids).not.toContain("old");
    expect(ids).not.toContain("forgotten");
    expect(ids).not.toContain("r4");
    expect(ids).toContain("r5");
    expect(tasks.length).toBe(31);
  });

  test("the foreground command its latest message runs comes first", () => {
    const tasks = parseSessionTasks([
      ...background("bg", 0, 1),
      call("fg", 2, { command: "cargo build", description: "Build it" }),
    ]);
    expect(tasks.map((task) => [task.id, task.foreground ?? false])).toEqual([
      ["fg", true],
      ["bg", false],
    ]);
    expect(tasks[0]).toMatchObject({
      title: "Build it",
      detail: "cargo build",
      status: "running",
    });
  });

  test("a foreground command answered, or left behind, is not running now", () => {
    const done = parseSessionTasks([
      call("fg", 2, { command: "cargo build" }),
      answered("fg", 3),
    ]);
    expect(done).toEqual([]);
    // A later message: the call was left with no answer (an interrupt).
    const left = parseSessionTasks([
      call("fg", 2, { command: "cargo build" }),
      {
        type: "assistant",
        timestamp: at(4),
        message: { role: "assistant", id: "m-next", content: [] },
      },
    ]);
    expect(left).toEqual([]);
  });

  test("calls of one message in several records run now together", () => {
    const tasks = parseSessionTasks([
      call("one", 2, { command: "a" }, "m-same"),
      call("two", 2, { command: "b" }, "m-same"),
    ]);
    expect(tasks.map((task) => task.id)).toEqual(["one", "two"]);
  });
});
