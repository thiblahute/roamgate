import { describe, expect, test } from "bun:test";
import { parseSessionTasks } from "./session-tasks";

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
