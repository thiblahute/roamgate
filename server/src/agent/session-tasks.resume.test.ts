import { afterEach, describe, expect, setSystemTime, test } from "bun:test";
import { createAgentSessionHandlers } from "./agent-sessions";
import type { AgentSessionFileAccess } from "./session-file-access";
import {
  type AgentTask,
  parseSessionTasks,
  SUBAGENT_STALE_MS,
  subagentsToWatch,
  withSubagentActivity,
} from "./session-tasks";
import type { SessionFile } from "./session-types";

// Claude Code's own records (2.1, 2026-11-04), trimmed: a background agent
// started, it finished, a SendMessage resumed it under the same id (no new
// start record), messages were queued to it while it ran, and it notified
// again when it stopped. The second notice names the resuming call's id.
const AGENT = "a6f37b8a16c1041c3";
const launch = {
  type: "assistant",
  timestamp: "2026-11-04T17:50:29.024Z",
  message: {
    role: "assistant",
    content: [
      {
        type: "tool_use",
        id: "toolu_015weVgG4gJ4scu7NdJfJLFU",
        name: "Agent",
        input: {
          description: "Build MR review inbox module",
          name: "mr-reviews",
          run_in_background: true,
          prompt: "Build Roamgate's upstream MR/PR review module.",
        },
      },
    ],
  },
};
const launched = {
  type: "user",
  timestamp: "2026-11-04T17:50:29.125Z",
  toolUseResult: {
    isAsync: true,
    status: "async_launched",
    agentId: AGENT,
    description: "Build MR review inbox module",
  },
  message: {
    role: "user",
    content: [
      {
        tool_use_id: "toolu_015weVgG4gJ4scu7NdJfJLFU",
        type: "tool_result",
        content: [
          {
            type: "text",
            text: `Async agent launched successfully.\nagentId: ${AGENT} (internal ID)`,
          },
        ],
      },
    ],
  },
};
const notice = (toolUseId: string, at: string) => ({
  type: "user",
  timestamp: at,
  origin: { kind: "task-notification", producer: "session-task" },
  message: {
    role: "user",
    content: `<task-notification>\n<task-id>${AGENT}</task-id>\n<tool-use-id>${toolUseId}</tool-use-id>\n<output-file>/private/tmp/claude-501/x/tasks/${AGENT}.output</output-file>\n<status>completed</status>\n<summary>Agent "Build MR review inbox module" finished</summary>\n<note>A task-notification fires each time this agent stops with no live background children of its own. The user can send it another message and resume it, so the same task-id may notify more than once.</note>\n</task-notification>`,
  },
});
const send = (id: string, to: string, at: string) => ({
  type: "assistant",
  timestamp: at,
  message: {
    role: "assistant",
    content: [
      {
        type: "tool_use",
        id,
        name: "SendMessage",
        input: { to, summary: "GitHub PR review bug", message: "..." },
      },
    ],
  },
});
const resumed = (id: string, at: string) => {
  const body = {
    success: true,
    message: "Resuming agent a6f37b8",
    resumedAgentId: AGENT,
    pin: { id: AGENT, name: AGENT, ref: "ab4d9c" },
  };
  return {
    type: "user",
    timestamp: at,
    toolUseResult: { ...body, revivedAgentId: AGENT },
    message: {
      role: "user",
      content: [
        {
          tool_use_id: id,
          type: "tool_result",
          content: [{ type: "text", text: JSON.stringify(body) }],
        },
      ],
    },
  };
};
const queued = (id: string, at: string) => {
  const body = {
    success: true,
    message: `Message queued for delivery to ${AGENT} at its next tool round. If it finishes first, it is resumed with the message and notifies again, so wait for that notification before resending.`,
    pin: { id: AGENT, name: AGENT, ref: "ab4d9c" },
  };
  return {
    type: "user",
    timestamp: at,
    toolUseResult: body,
    message: {
      role: "user",
      content: [
        {
          tool_use_id: id,
          type: "tool_result",
          content: [{ type: "text", text: JSON.stringify(body) }],
        },
      ],
    },
  };
};

const finished = [
  launch,
  launched,
  notice("toolu_015weVgG4gJ4scu7NdJfJLFU", "2026-11-04T19:32:47.188Z"),
];
const resume = [
  send("toolu_01LucLxJQKbk66xVQmrtBKQx", AGENT, "2026-11-04T19:58:57.067Z"),
  resumed("toolu_01LucLxJQKbk66xVQmrtBKQx", "2026-11-04T19:59:01.204Z"),
];

describe("a subagent resumed by a message", () => {
  test("runs again until its next end notice", () => {
    expect(parseSessionTasks(finished)[0]).toMatchObject({
      kind: "teammate",
      name: "mr-reviews",
      agentId: AGENT,
      status: "completed",
      endedAt: "2026-11-04T19:32:47.188Z",
    });
    const running = parseSessionTasks([...finished, ...resume])[0];
    expect(running).toMatchObject({
      status: "running",
      resumedAt: "2026-11-04T19:59:01.204Z",
    });
    expect(running?.endedAt).toBeUndefined();
    // The next notice names the resuming call, not the launch.
    const again = parseSessionTasks([
      ...finished,
      ...resume,
      notice("toolu_01LucLxJQKbk66xVQmrtBKQx", "2026-11-04T20:40:00.000Z"),
    ]);
    expect(again).toHaveLength(1);
    expect(again[0]).toMatchObject({
      status: "completed",
      endedAt: "2026-11-04T20:40:00.000Z",
    });
  });

  test("by its name, or with only the result's text", () => {
    const text = resumed("m1", "2026-11-04T19:59:01.204Z");
    const [byText] = parseSessionTasks([
      ...finished,
      send("m1", "mr-reviews", "2026-11-04T19:58:57.067Z"),
      { ...text, toolUseResult: undefined },
    ]);
    expect(byText?.status).toBe("running");
  });

  test("a message queued to one that runs changes nothing", () => {
    const tasks = parseSessionTasks([
      ...finished,
      ...resume,
      send("m2", AGENT, "2026-11-04T19:59:30.150Z"),
      queued("m2", "2026-11-04T19:59:34.378Z"),
      send("m3", "mr-reviews", "2026-11-04T20:00:21.630Z"),
      queued("m3", "2026-11-04T20:00:25.652Z"),
    ]);
    expect(tasks[0]).toMatchObject({
      status: "running",
      resumedAt: "2026-11-04T19:59:01.204Z",
    });
    // Nor one that has finished: only a resume wakes it.
    const done = parseSessionTasks([
      ...finished,
      send("m4", "mr-reviews", "2026-11-04T19:59:30.150Z"),
      queued("m4", "2026-11-04T19:59:34.378Z"),
    ]);
    expect(done[0]?.status).toBe("completed");
    // A send that failed: nothing either.
    const failed = parseSessionTasks([
      ...finished,
      send("m5", AGENT, "2026-11-04T19:59:30.150Z"),
      {
        ...resumed("m5", "2026-11-04T19:59:31.000Z"),
        message: {
          role: "user",
          content: [
            {
              tool_use_id: "m5",
              type: "tool_result",
              content: "No such agent",
              is_error: true,
            },
          ],
        },
      },
    ]);
    expect(failed[0]?.status).toBe("completed");
  });

  test("a day after its resume with no notice, it is lost", () => {
    const [task] = parseSessionTasks([
      ...finished,
      ...resume,
      {
        type: "assistant",
        timestamp: "2026-11-05T20:00:00.000Z",
        message: { role: "assistant", content: [] },
      },
    ]);
    expect(task?.status).toBe("lost");
  });
});

describe("what its own conversation says", () => {
  const at = (iso: string) => Date.parse(iso);
  const completed = parseSessionTasks(finished);
  const running = parseSessionTasks([...finished, ...resume]);

  test("one that grew after its end notice runs again", () => {
    const now = at("2026-11-04T20:26:00.000Z");
    expect(subagentsToWatch(completed, now)).toEqual([AGENT]);
    const [task] = withSubagentActivity(
      completed,
      new Map([[AGENT, { mtimeMs: at("2026-11-04T20:19:13.000Z") }]]),
      now,
    );
    expect(task).toMatchObject({
      status: "running",
      resumedAt: "2026-11-04T19:32:47.188Z",
    });
    expect(task?.endedAt).toBeUndefined();
    // Its last record comes just before the notice: not grown.
    const [same] = withSubagentActivity(
      completed,
      new Map([[AGENT, { mtimeMs: at("2026-11-04T19:32:47.100Z") }]]),
      now,
    );
    expect(same?.status).toBe("completed");
    // Given copies: the projection's tasks stay as they were.
    expect(completed[0]?.status).toBe("completed");
  });

  test("a resumed one silent for a while is taken as done", () => {
    const last = at("2026-11-04T20:19:13.000Z");
    expect(subagentsToWatch(running, last)).toEqual([AGENT]);
    const activity = new Map([[AGENT, { mtimeMs: last }]]);
    const before = withSubagentActivity(
      running,
      activity,
      last + SUBAGENT_STALE_MS - 1,
    )[0];
    expect(before?.status).toBe("running");
    const after = withSubagentActivity(
      running,
      activity,
      last + SUBAGENT_STALE_MS,
    )[0];
    expect(after).toMatchObject({
      status: "completed",
      endedAt: "2026-11-04T20:19:13.000Z",
    });
    // An old growth does not bring a finished one back.
    const [old] = withSubagentActivity(
      completed,
      activity,
      last + SUBAGENT_STALE_MS,
    );
    expect(old?.status).toBe("completed");
  });

  test("only subagents that may say more are looked at", () => {
    const now = at("2026-11-04T20:26:00.000Z");
    const task = (over: Partial<AgentTask>): AgentTask => ({
      id: over.agentId ?? "x",
      kind: "agent",
      title: "t",
      status: "completed",
      ...over,
    });
    const ids = subagentsToWatch(
      [
        // Running from its start: its notice will tell.
        task({ agentId: "a1", status: "running" }),
        task({ agentId: "a2", endedAt: "2026-11-04T20:00:00.000Z" }),
        // Ended over a day ago.
        task({ agentId: "a3", endedAt: "2026-11-02T20:00:00.000Z" }),
        task({ agentId: "../a4", endedAt: "2026-11-04T20:00:00.000Z" }),
        task({
          agentId: "a5",
          status: "running",
          resumedAt: "2026-11-04T20:10:00.000Z",
        }),
        task({
          agentId: "a6",
          kind: "command",
          endedAt: "2026-11-04T20:00:00.000Z",
        }),
      ],
      now,
    );
    expect(ids).toEqual(["a5", "a2"]);
  });
});

describe("the session's tasks, as the Tasks sheet reads them", () => {
  afterEach(() => setSystemTime());

  test("follow the subagent's conversation file", async () => {
    const path = "/tmp/rg-resume/362be254.jsonl";
    const subagent = `/tmp/rg-resume/362be254/subagents/agent-${AGENT}.jsonl`;
    const bytes = Buffer.from(
      `${finished.map((record) => JSON.stringify(record)).join("\n")}\n`,
    );
    let subagentMtime = Date.parse("2026-11-04T19:32:47.100Z");
    let stats = 0;
    const file = (at: string, mtimeMs: number, size = 1): SessionFile => ({
      path: at,
      mtimeMs,
      size,
      identity: at,
      changeToken: String(mtimeMs),
    });
    const files: AgentSessionFileAccess = {
      remote: false,
      async statFile(at) {
        if (at === subagent) {
          stats += 1;
          return file(at, subagentMtime);
        }
        return at === path ? file(at, 1000, bytes.length) : null;
      },
      readText: async () => bytes.toString("utf8"),
      readPrefix: async (_path, limit) => bytes.subarray(0, limit),
      readTail: async (_path, limit) =>
        bytes.subarray(Math.max(0, bytes.length - limit)),
      readDownloadBody: async () => new Uint8Array(bytes),
      findPiSessionForCwd: async () => null,
      findPiSessionById: async () => null,
      findClaudeSessionById: async () => null,
      findClaudeSuccessor: async () => null,
      findCodexSessionById: async () => null,
    };
    const handlers = createAgentSessionHandlers({
      files,
      herdrCall: async () => ({
        agent: {
          agent: "claude",
          agent_session: { kind: "path", value: path },
        },
      }),
    });
    const status = async () =>
      (
        (await handlers.readTasks({ pane_id: "p", agent: "claude" })) as {
          tasks: AgentTask[];
        }
      ).tasks[0]?.status;

    setSystemTime(new Date("2026-11-04T20:00:00.000Z"));
    expect(await status()).toBe("completed");
    // Resumed without the transcript saying so yet: its file grows.
    subagentMtime = Date.parse("2026-11-04T20:00:00.000Z");
    // Looked at again only a few seconds on.
    expect(await status()).toBe("completed");
    expect(stats).toBe(1);
    setSystemTime(new Date("2026-11-04T20:00:06.000Z"));
    expect(await status()).toBe("running");
    expect(stats).toBe(2);
    // Then silent for the stale time: done, should its notice never come.
    setSystemTime(new Date(subagentMtime + SUBAGENT_STALE_MS));
    expect(await status()).toBe("completed");
  });
});
