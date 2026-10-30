import { expect, test } from "bun:test";
import {
  HISTORY_WINDOW_LIMIT,
  type HistoryEntry,
  historyEntriesFromTrajectory,
  historyUpdate,
  historyTextHash,
  redactHistoryUpdate,
} from "./session-history";
import { conversationMessagesFromTrajectory } from "./session-messages";
import { projectAgentTrajectory } from "./session-trajectory";

const file = { path: "/tmp/history.jsonl", mtimeMs: 1000 };

test("Pi History includes tool arguments, associated outputs and errors in transcript order", () => {
  const records = [
    {
      type: "message",
      message: { role: "user", content: [{ type: "text", text: "run it" }] },
    },
    {
      type: "message",
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "Running" },
          {
            type: "toolCall",
            id: "call1",
            name: "bash",
            arguments: { command: "false" },
          },
        ],
      },
    },
    {
      type: "message",
      message: {
        role: "toolResult",
        toolCallId: "call1",
        isError: true,
        content: [{ type: "text", text: "exit 1" }],
      },
    },
    {
      type: "message",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Failed" }],
      },
    },
  ];
  const entries = historyEntriesFromTrajectory(
    file,
    projectAgentTrajectory("pi", file, records),
  );
  expect(entries.map((entry) => entry.kind)).toEqual([
    "message",
    "message",
    "tool_call",
    "tool_result",
    "message",
  ]);
  expect(entries[2]).toMatchObject({
    tool_name: "bash",
    source_call_id: "call1",
    text: '{\n  "command": "false"\n}',
  });
  expect(entries[3]).toMatchObject({
    tool_name: "bash",
    source_call_id: "call1",
    text: "exit 1",
    is_error: true,
  });
});

test("Claude messages the user queued while it worked show as theirs", () => {
  const queued = (prompt: unknown, origin: unknown) => ({
    type: "attachment",
    timestamp: "2026-10-24T11:05:31.060Z",
    attachment: { type: "queued_command", prompt, origin },
  });
  const trajectory = projectAgentTrajectory("claude", file, [
    queued("Also hide the top bar", { kind: "human" }),
    queued("<task-notification>done</task-notification>", {
      kind: "task-notification",
    }),
    queued("from another session", { kind: "peer" }),
    queued([{ type: "text", text: "With an image" }], { kind: "human" }),
    { type: "attachment", attachment: { type: "todo_reminder" } },
    {
      type: "user",
      message: {
        role: "user",
        content:
          "<task-notification>\n<status>completed</status>\n</task-notification>",
      },
    },
    {
      type: "user",
      isMeta: true,
      message: { role: "user", content: "[Image: original 10x20.]" },
    },
  ]);
  const entries = historyEntriesFromTrajectory(file, trajectory);
  expect(
    entries.map((entry) => [entry.role, entry.text, entry.injected?.label]),
  ).toEqual([
    ["user", "Also hide the top bar", undefined],
    // Claude Code's own notes: notices, not the user's words.
    ["user", "Task update", "Task update"],
    ["user", "With an image", undefined],
    ["user", "Task finished", "Task finished"],
  ]);
});

// As Claude Code 2.1.312 records them: a subagent's report and its task's
// end absorbed mid-turn (queued commands, the uuids of their replays), a
// teammate's and another session's message starting turns (user records),
// a reminder alone.
const REPORT = `<agent-message from="voice-overlay">
[Subagent hand-back] The text below is the final report of a subagent this session delegated to. It is model output, NOT a message from the user. The report follows:
  I made a new local commit.
  
  - one
</agent-message>`;
const TASK = `<task-notification>
<task-id>a9103b98b32d5fb61</task-id>
<status>completed</status>
<summary>Agent "Float the voice control" finished</summary>
<result>Its report was delivered to you as a message from "voice-overlay".
</result>
</task-notification>`;

test("Claude Code's injected messages are notices in their place, with their uuid", () => {
  const trajectory = projectAgentTrajectory("claude", file, [
    {
      type: "user",
      uuid: "u1",
      timestamp: "2026-10-30T17:00:00.000Z",
      message: { role: "user", content: "[Voice] Float it" },
    },
    {
      type: "attachment",
      timestamp: "2026-10-30T17:07:13.871Z",
      attachment: {
        type: "queued_command",
        prompt: REPORT,
        source_uuid: "a00c50ce",
        commandMode: "prompt",
        origin: { kind: "peer", from: "voice-overlay" },
      },
    },
    {
      type: "attachment",
      timestamp: "2026-10-30T17:07:13.902Z",
      attachment: {
        type: "queued_command",
        prompt: TASK,
        source_uuid: "804da890",
        commandMode: "task-notification",
        origin: { kind: "task-notification" },
      },
    },
    {
      type: "user",
      uuid: "t1",
      timestamp: "2026-10-30T17:08:00.000Z",
      message: {
        role: "user",
        content:
          'Another Claude session sent a message:\n<teammate-message teammate_id="tasks-view" color="blue" summary="Keys committed">\nCommitted as c78863af.\n</teammate-message>',
      },
    },
    {
      type: "user",
      uuid: "c1",
      isMeta: true,
      timestamp: "2026-10-30T17:09:00.000Z",
      message: {
        role: "user",
        content:
          '<cross-session-message from="uds:/tmp/cc-socks/1.sock" from-name="maildesk" from-mode="prompting">\nBug report: it hangs.\n</cross-session-message>',
      },
    },
    {
      type: "user",
      uuid: "r1",
      message: {
        role: "user",
        content: "<system-reminder>\nBe brief.\n</system-reminder>",
      },
    },
  ]);
  const entries = historyEntriesFromTrajectory(file, trajectory);
  expect(
    entries.map((entry) => [entry.uuid, entry.injected?.label, entry.text]),
  ).toEqual([
    ["u1", undefined, "[Voice] Float it"],
    [
      "a00c50ce",
      "Report from voice-overlay",
      "I made a new local commit.\n\n- one",
    ],
    [
      "804da890",
      'Task finished: Agent "Float the voice control" finished',
      'Its report was delivered to you as a message from "voice-overlay".',
    ],
    ["t1", "Teammate tasks-view: Keys committed", "Committed as c78863af."],
    ["c1", "Message from maildesk", "Bug report: it hangs."],
  ]);
  expect(entries.slice(1).every((entry) => entry.role === "user")).toBe(true);
});

test("injected messages are not the user's turns", () => {
  const trajectory = projectAgentTrajectory("claude", file, [
    { type: "user", message: { role: "user", content: "hello" } },
    { type: "user", uuid: "x", message: { role: "user", content: TASK } },
  ]);
  expect(
    conversationMessagesFromTrajectory(file, trajectory).map((m) => m.text),
  ).toEqual(["hello"]);
});

test("a message steered into a headless turn shows as the user's, with its uuid", () => {
  // As Claude Code 2.1.312 records speech written to stdin mid-turn.
  const trajectory = projectAgentTrajectory("claude", file, [
    {
      type: "attachment",
      timestamp: "2026-10-29T19:58:00.903Z",
      uuid: "3ee7826e-0a10-4260-8021-b65df0f51ceb",
      attachment: {
        type: "queued_command",
        prompt: "Also: end your answer with the word BANANA.",
        source_uuid: "7d19afe2-57fd-4871-bf7c-0742a47f6a22",
        commandMode: "prompt",
      },
    },
    // No origin and no source: not known to be the user's.
    {
      type: "attachment",
      attachment: { type: "queued_command", prompt: "a notification" },
    },
  ]);
  const entries = historyEntriesFromTrajectory(file, trajectory);
  expect(entries.map((entry) => [entry.role, entry.text, entry.uuid])).toEqual([
    [
      "user",
      "Also: end your answer with the word BANANA.",
      "7d19afe2-57fd-4871-bf7c-0742a47f6a22",
    ],
  ]);
});

test("a Claude compaction summary is flagged, not a plain user message", () => {
  const trajectory = projectAgentTrajectory("claude", file, [
    {
      type: "system",
      subtype: "compact_boundary",
      content: "Conversation compacted",
    },
    {
      type: "user",
      isCompactSummary: true,
      message: { role: "user", content: "This session is being continued" },
    },
    { type: "user", message: { role: "user", content: "Go on" } },
  ]);
  const entries = historyEntriesFromTrajectory(file, trajectory);
  expect(
    entries.map((entry) => [entry.text, entry.compact_summary ?? false]),
  ).toEqual([
    ["This session is being continued", true],
    ["Go on", false],
  ]);
});

test("a Claude reply that ends its turn is flagged", () => {
  const trajectory = projectAgentTrajectory("claude", file, [
    { type: "user", message: { role: "user", content: "Run the survey" } },
    {
      type: "assistant",
      message: {
        role: "assistant",
        stop_reason: "tool_use",
        content: [{ type: "text", text: "Starting it." }],
      },
    },
    {
      type: "assistant",
      message: {
        role: "assistant",
        stop_reason: "end_turn",
        content: [{ type: "text", text: "It runs in the background." }],
      },
    },
  ]);
  const entries = historyEntriesFromTrajectory(file, trajectory);
  expect(entries.map((entry) => [entry.text, entry.turn_end ?? false])).toEqual(
    [
      ["Run the survey", false],
      ["Starting it.", false],
      ["It runs in the background.", true],
    ],
  );
});

test("an Artifact result keeps the page it published when redacted", () => {
  const trajectory = projectAgentTrajectory("claude", file, [
    {
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "a1",
            name: "Artifact",
            input: { file_path: "/tmp/notes.html" },
          },
        ],
      },
    },
    {
      type: "user",
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "a1",
            content:
              "Published /tmp/notes.html at https://claude.ai/artifact/N1",
          },
        ],
      },
    },
  ]);
  const update = redactHistoryUpdate({
    history_version: 2,
    cursor: { epoch: "e", revision: 1 },
    window_limit: HISTORY_WINDOW_LIMIT,
    mode: "snapshot",
    entries: historyEntriesFromTrajectory(file, trajectory),
  });
  const entries = update.mode === "snapshot" ? update.entries : [];
  expect(entries.find((entry) => entry.kind === "tool_result")).toMatchObject({
    text: "",
    artifact: { url: "https://claude.ai/artifact/N1", title: "notes" },
  });
});

test("Claude messages still in its queue show as queued until they land", () => {
  const op = (operation: string, content?: string) => ({
    type: "queue-operation",
    operation,
    timestamp: "2026-10-24T11:05:31.060Z",
    ...(content === undefined ? {} : { content }),
  });
  const project = (records: Record<string, unknown>[]) =>
    historyEntriesFromTrajectory(
      file,
      projectAgentTrajectory("claude", file, records),
    ).map((entry) => [entry.text, entry.queued ?? false]);
  const waiting = [
    op("enqueue", "first"),
    op("enqueue", "<task-notification>x</task-notification>"),
    op("enqueue", "second"),
    op("enqueue", "third"),
  ];
  expect(project(waiting)).toEqual([
    ["first", true],
    ["second", true],
    ["third", true],
  ]);
  // Absorbed mid-turn (a queued command), and the oldest taking a new turn.
  const later = project([
    ...waiting,
    op("remove", "second"),
    {
      type: "attachment",
      attachment: {
        type: "queued_command",
        prompt: "second",
        origin: { kind: "human" },
      },
    },
    op("dequeue"),
    { type: "user", message: { role: "user", content: "first" } },
  ]);
  expect(later).toEqual([
    ["second", false],
    ["first", false],
    ["third", true],
  ]);
  // Up gives the whole queue back to the prompt; one is sent again.
  expect(
    project([
      ...waiting,
      op("popAll", "first"),
      op("popAll", "second"),
      op("popAll", "third"),
      op("enqueue", "third"),
    ]),
  ).toEqual([["third", true]]);
});

test("Claude mixed text/tool blocks retain order and error output is not counted as a user turn", () => {
  const trajectory = projectAgentTrajectory("claude", file, [
    {
      type: "assistant",
      message: {
        role: "assistant",
        model: "claude-test-model",
        usage: { input_tokens: 10, output_tokens: 5 },
        content: [
          { type: "text", text: "Before" },
          {
            type: "tool_use",
            id: "call",
            name: "Read",
            input: { path: "missing" },
          },
          { type: "text", text: "After" },
        ],
      },
    },
    {
      type: "user",
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "call",
            content: "not found",
            is_error: true,
          },
          { type: "text", text: "Try again" },
          {
            type: "text",
            text: "[Image: original 1080x2424, displayed at 891x2000.]",
          },
        ],
      },
    },
  ]);
  const entries = historyEntriesFromTrajectory(file, trajectory);
  expect(entries.map((entry) => entry.kind)).toEqual([
    "message",
    "tool_call",
    "message",
    "tool_result",
    "message",
  ]);
  expect(entries[3]).toMatchObject({
    tool_name: "Read",
    source_call_id: "call",
    is_error: true,
    text: "not found",
  });
  expect(entries.filter((entry) => entry.role === "user")).toHaveLength(1);
  expect(trajectory.steps[2]).toMatchObject({
    extra: { record_type: "assistant", model: "claude-test-model" },
    metrics: { prompt_tokens: 10, completion_tokens: 5 },
  });
  expect(trajectory.steps[4].extra?.record_type).toBe("user");
});

test("Pi interleaved tool and text parts remain in source order", () => {
  const trajectory = projectAgentTrajectory("pi", file, [
    {
      type: "message",
      message: {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "call",
            name: "read",
            arguments: { path: "a" },
          },
          { type: "text", text: "After call" },
          {
            type: "toolCall",
            id: "call2",
            name: "read",
            arguments: { path: "b" },
          },
        ],
      },
    },
  ]);
  expect(
    historyEntriesFromTrajectory(file, trajectory).map((entry) => entry.kind),
  ).toEqual(["tool_call", "message", "tool_call"]);
});

test.each(["stop", "error"])(
  "Pi interleaved ATIF preserves source metadata with stop reason %s",
  (stopReason) => {
    const trajectory = projectAgentTrajectory("pi", file, [
      {
        type: "message",
        message: {
          role: "assistant",
          provider: "test-provider",
          model: "test-model",
          stopReason,
          errorMessage: "interrupted",
          usage: { input: 10, output: 5 },
          content: [
            { type: "toolCall", id: "call", name: "read", arguments: {} },
            { type: "text", text: "After call" },
          ],
        },
      },
    ]);
    const lastStep = trajectory.steps.at(-1)!;
    expect(lastStep).toMatchObject({
      extra: {
        record_type: "message",
        provider: "test-provider",
        model: "test-model",
        stop_reason: stopReason,
      },
      metrics: { prompt_tokens: 10, completion_tokens: 5 },
    });
    expect(lastStep.extra?.error_message).toBe(
      stopReason === "error" ? "interrupted" : undefined,
    );
  },
);

test("Codex preserves explicit tool errors and call association", () => {
  const trajectory = projectAgentTrajectory("codex", file, [
    {
      type: "response_item",
      payload: {
        type: "function_call",
        name: "shell",
        call_id: "call",
        arguments: '{"command":"false"}',
      },
    },
    {
      type: "response_item",
      payload: {
        type: "function_call_output",
        call_id: "call",
        output: "exit 1",
        status: "failed",
      },
    },
  ]);
  expect(historyEntriesFromTrajectory(file, trajectory)[1]).toMatchObject({
    kind: "tool_result",
    source_call_id: "call",
    tool_name: "shell",
    text: "exit 1",
    is_error: true,
  });
});

test("external call IDs with commas are hashed before order comparison", () => {
  const trajectory = projectAgentTrajectory("pi", file, [
    {
      type: "message",
      message: {
        role: "assistant",
        content: ["a,b", "c", "a", "b,c"].map((id) => ({
          type: "toolCall",
          id,
          name: "read",
          arguments: {},
        })),
      },
    },
  ]);
  const entries = historyEntriesFromTrajectory(file, trajectory);
  for (const entry of entries) expect(entry.id).toMatch(/^[0-9a-f]{24}:\d+$/);
  expect(entries.map((entry) => entry.source_call_id)).toEqual([
    "a,b",
    "c",
    "a",
    "b,c",
  ]);
  const reversed = entries.toReversed();
  const update = historyUpdate(
    { epoch: "test", revision: 2 },
    reversed,
    { epoch: "test", revision: 1 },
    new Map([[1, entries]]),
  );
  expect(update).toMatchObject({
    mode: "delta",
    upserts: [],
    removed: [],
    order: reversed.map((entry) => entry.id),
  });
});

test("window counts conversation entries only; tool entries ride along", () => {
  const records = [];
  for (let index = 0; index < HISTORY_WINDOW_LIMIT + 5; index++) {
    records.push({
      type: "message",
      message: {
        role: "user",
        content: [{ type: "text", text: `turn ${index}` }],
      },
    });
    records.push({
      type: "message",
      message: {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: `call-${index}`,
            name: "bash",
            arguments: { command: `echo ${index}` },
          },
        ],
      },
    });
  }
  const entries = historyEntriesFromTrajectory(
    file,
    projectAgentTrajectory("pi", file, records),
  );
  const conversation = entries.filter((entry) => entry.role !== "tool");
  expect(conversation).toHaveLength(HISTORY_WINDOW_LIMIT);
  // The five oldest user turns are evicted; their tool calls drop with them.
  expect(conversation[0].text).toBe("turn 5");
  expect(entries.filter((entry) => entry.role === "tool")).toHaveLength(
    HISTORY_WINDOW_LIMIT,
  );
  expect(entries[0].text).toBe("turn 5");
  expect(entries[1].kind).toBe("tool_call");
});

test("redaction strips tool payloads but keeps metadata for on-demand fetches", () => {
  const tool: HistoryEntry = {
    id: "t:0",
    role: "tool",
    kind: "tool_result",
    text: "bulk output",
    sent_at: "2026-01-01T00:00:00Z",
    tool_name: "bash",
    is_error: false,
  };
  const user: HistoryEntry = {
    id: "u:0",
    role: "user",
    kind: "message",
    text: "keep me",
    sent_at: "2026-01-01T00:00:00Z",
  };
  const snapshot = redactHistoryUpdate({
    history_version: 2,
    mode: "snapshot",
    cursor: { epoch: "e", revision: 1 },
    window_limit: HISTORY_WINDOW_LIMIT,
    entries: [user, tool],
  });
  if (snapshot.mode !== "snapshot") throw new Error("Expected snapshot");
  expect(snapshot.entries[0]).toEqual(user);
  expect(snapshot.entries[1]).toMatchObject({
    id: "t:0",
    text: "",
    text_bytes: "bulk output".length,
    tool_name: "bash",
  });
  // Non-ASCII payloads report real UTF-8 bytes, not string length.
  const nonAscii = redactHistoryUpdate({
    history_version: 2,
    mode: "snapshot",
    cursor: { epoch: "e", revision: 1 },
    window_limit: HISTORY_WINDOW_LIMIT,
    entries: [{ ...tool, id: "t:1", text: "你好世界" }],
  });
  if (nonAscii.mode !== "snapshot") throw new Error("Expected snapshot");
  expect(nonAscii.entries[0].text_bytes).toBe(
    Buffer.byteLength("你好世界", "utf8"),
  );
  const delta = redactHistoryUpdate({
    history_version: 2,
    mode: "delta",
    cursor: { epoch: "e", revision: 2 },
    base_revision: 1,
    window_limit: HISTORY_WINDOW_LIMIT,
    upserts: [tool],
    removed: [user.id],
  });
  if (delta.mode !== "delta") throw new Error("Expected delta");
  expect(delta.upserts[0].text).toBe("");
  expect(delta.upserts[0].text_bytes).toBe("bulk output".length);
  expect(delta.removed).toEqual([user.id]);
});

test("redacted tool payloads carry a content hash that tracks rewrites", () => {
  const tool: HistoryEntry = {
    id: "t:0",
    role: "tool",
    kind: "tool_call",
    tool_name: "bash",
    text: '{"command":"a"}',
    sent_at: "2026-01-01T00:00:00Z",
  };
  const redact = (entry: HistoryEntry) => {
    const update = redactHistoryUpdate({
      history_version: 2,
      mode: "snapshot",
      cursor: { epoch: "e", revision: 1 },
      window_limit: HISTORY_WINDOW_LIMIT,
      entries: [entry],
    });
    if (update.mode !== "snapshot") throw new Error("Expected snapshot");
    return update.entries[0];
  };
  const before = redact(tool);
  // Rewritten in place at the same byte length: only the hash changes.
  const after = redact({ ...tool, text: '{"command":"b"}' });
  expect(before.text_hash).toBe(historyTextHash(tool.text));
  expect(after.text_bytes).toBe(before.text_bytes);
  expect(after.text_hash).not.toBe(before.text_hash);
});

test("content identities survive early step renumbering and disambiguate repeated messages", () => {
  const trajectory = projectAgentTrajectory("pi", file, [
    { type: "message", message: { role: "user", content: "same" } },
    { type: "message", message: { role: "user", content: "same" } },
  ]);
  const first = historyEntriesFromTrajectory(file, trajectory);
  const next = historyEntriesFromTrajectory(file, {
    ...trajectory,
    steps: trajectory.steps.map((step) => ({
      ...step,
      step_id: step.step_id + 3,
    })),
  });
  expect(first.map((entry) => entry.id)).toEqual(next.map((entry) => entry.id));
  expect(new Set(first.map((entry) => entry.id)).size).toBe(2);
});

test("Claude entries carry the API message id, block index and record uuid", () => {
  const block = (uuid: string, content: unknown[]) => ({
    type: "assistant",
    uuid,
    message: { id: "msg_1", role: "assistant", content },
  });
  const trajectory = projectAgentTrajectory("claude", file, [
    {
      type: "user",
      uuid: "u-0",
      message: { role: "user", content: "hello" },
    },
    block("u-1", [{ type: "thinking", thinking: "" }]),
    block("u-2", [{ type: "text", text: "Looking." }]),
    block("u-3", [
      {
        type: "tool_use",
        id: "toolu_1",
        name: "Bash",
        input: { command: "ls" },
      },
    ]),
    {
      type: "assistant",
      uuid: "u-4",
      message: {
        id: "msg_2",
        role: "assistant",
        stop_reason: "end_turn",
        content: [{ type: "text", text: "Done." }],
      },
    },
  ]);
  const entries = historyEntriesFromTrajectory(file, trajectory).filter(
    (entry) => entry.kind === "message",
  );
  expect(
    entries.map(({ text, message_id, block_index, uuid }) => ({
      text,
      message_id,
      block_index,
      uuid,
    })),
  ).toEqual([
    {
      text: "hello",
      message_id: undefined,
      block_index: undefined,
      uuid: "u-0",
    },
    { text: "Looking.", message_id: "msg_1", block_index: 1, uuid: "u-2" },
    { text: "Done.", message_id: "msg_2", block_index: 0, uuid: "u-4" },
  ]);
});
