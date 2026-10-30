import { describe, expect, test } from "bun:test";
import { createStreamParser, type StreamItem } from "./stream";

const wrap = (event: unknown, extra: Record<string, unknown> = {}) => ({
  type: "stream_event",
  event,
  session_id: "s1",
  parent_tool_use_id: null,
  uuid: "u",
  ...extra,
});

function parseAll(events: unknown[]): StreamItem[] {
  const parser = createStreamParser();
  return events.flatMap((event) => parser.line(JSON.stringify(event)));
}

describe("stream parser", () => {
  test("text blocks carry the API message id and block index", () => {
    const items = parseAll([
      {
        type: "system",
        subtype: "init",
        session_id: "s1",
        cwd: "/w",
        model: "m",
      },
      { type: "system", subtype: "status", status: "requesting" },
      wrap({ type: "message_start", message: { id: "msg_1" } }),
      wrap(
        {
          type: "content_block_start",
          index: 0,
          content_block: { type: "thinking", thinking: "" },
        },
        { api_message_id: "msg_1" },
      ),
      { type: "system", subtype: "thinking_tokens", estimated_tokens: 12 },
      wrap({ type: "content_block_stop", index: 0 }),
      {
        type: "assistant",
        message: { id: "msg_1", content: [{ type: "thinking", thinking: "" }] },
        parent_tool_use_id: null,
      },
      wrap({
        type: "content_block_start",
        index: 1,
        content_block: { type: "text", text: "" },
      }),
      wrap({
        type: "content_block_delta",
        index: 1,
        delta: { type: "text_delta", text: "Hel" },
      }),
      wrap({
        type: "content_block_delta",
        index: 1,
        delta: { type: "signature_delta", signature: "x" },
      }),
      wrap({
        type: "content_block_delta",
        index: 1,
        delta: { type: "text_delta", text: "lo" },
      }),
      wrap({ type: "content_block_stop", index: 1 }),
      {
        type: "assistant",
        message: { id: "msg_1", content: [{ type: "text", text: "Hello" }] },
        parent_tool_use_id: null,
      },
      {
        type: "result",
        subtype: "success",
        is_error: false,
        result: "Hello",
        terminal_reason: "completed",
        session_id: "s1",
        total_cost_usd: 0.01,
        duration_ms: 900,
      },
    ]);
    expect(items).toEqual([
      { kind: "init", session_id: "s1", cwd: "/w", model: "m" },
      { kind: "status", status: "requesting" },
      { kind: "block_start", message_id: "msg_1", index: 0, block: "thinking" },
      { kind: "thinking", tokens: 12 },
      { kind: "block_stop", message_id: "msg_1", index: 0 },
      { kind: "block_start", message_id: "msg_1", index: 1, block: "text" },
      { kind: "delta", message_id: "msg_1", index: 1, text: "Hel" },
      { kind: "delta", message_id: "msg_1", index: 1, text: "lo" },
      { kind: "block_stop", message_id: "msg_1", index: 1 },
      { kind: "assistant_text", message_id: "msg_1", index: 1, text: "Hello" },
      {
        kind: "result",
        subtype: "success",
        is_error: false,
        text: "Hello",
        interrupted: false,
        session_id: "s1",
        cost_usd: 0.01,
        duration_ms: 900,
      },
    ]);
  });

  test("a complete block sent before its stop keeps its own index", () => {
    // What the CLI writes: each block's assistant event comes between its
    // start and its stop, a thinking block's too.
    const items = parseAll([
      wrap({ type: "message_start", message: { id: "msg_1" } }),
      wrap({
        type: "content_block_start",
        index: 0,
        content_block: { type: "thinking", thinking: "" },
      }),
      {
        type: "assistant",
        message: { id: "msg_1", content: [{ type: "thinking", thinking: "" }] },
        parent_tool_use_id: null,
      },
      wrap({ type: "content_block_stop", index: 0 }),
      wrap({
        type: "content_block_start",
        index: 1,
        content_block: { type: "text", text: "" },
      }),
      wrap({
        type: "content_block_delta",
        index: 1,
        delta: { type: "text_delta", text: "Rain" },
      }),
      {
        type: "assistant",
        message: { id: "msg_1", content: [{ type: "text", text: "Rain" }] },
        parent_tool_use_id: null,
      },
      wrap({ type: "content_block_stop", index: 1 }),
      wrap({
        type: "content_block_start",
        index: 2,
        content_block: { type: "tool_use", id: "toolu_1", name: "Bash" },
      }),
      {
        type: "assistant",
        message: {
          id: "msg_1",
          content: [
            { type: "tool_use", id: "toolu_1", name: "Bash", input: {} },
          ],
        },
        parent_tool_use_id: null,
      },
      wrap({ type: "content_block_stop", index: 2 }),
    ]);
    expect(
      items.filter(
        (item) => item.kind === "assistant_text" || item.kind === "tool_use",
      ),
    ).toEqual([
      { kind: "assistant_text", message_id: "msg_1", index: 1, text: "Rain" },
      {
        kind: "tool_use",
        message_id: "msg_1",
        index: 2,
        tool_use_id: "toolu_1",
        name: "Bash",
        input: {},
      },
    ]);
  });

  test("tool uses, results and the user's replayed message", () => {
    const items = parseAll([
      wrap({ type: "message_start", message: { id: "msg_2" } }),
      wrap({
        type: "content_block_start",
        index: 0,
        content_block: {
          type: "tool_use",
          id: "toolu_1",
          name: "Bash",
          input: {},
        },
      }),
      wrap({ type: "content_block_stop", index: 0 }),
      {
        type: "assistant",
        message: {
          id: "msg_2",
          content: [
            {
              type: "tool_use",
              id: "toolu_1",
              name: "Bash",
              input: { command: "ls" },
            },
          ],
        },
        parent_tool_use_id: null,
      },
      {
        type: "user",
        message: {
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_1",
              content: [{ type: "text", text: "a\nb" }],
              is_error: false,
            },
          ],
        },
        parent_tool_use_id: null,
      },
      {
        type: "user",
        message: {
          role: "user",
          content: [
            { type: "text", text: "look" },
            { type: "image", source: { type: "base64", data: "x" } },
          ],
        },
        uuid: "u-1",
        isReplay: true,
        parent_tool_use_id: null,
      },
    ]);
    expect(items).toEqual([
      {
        kind: "block_start",
        message_id: "msg_2",
        index: 0,
        block: "tool_use",
        tool_use_id: "toolu_1",
        name: "Bash",
      },
      { kind: "block_stop", message_id: "msg_2", index: 0 },
      {
        kind: "tool_use",
        message_id: "msg_2",
        index: 0,
        tool_use_id: "toolu_1",
        name: "Bash",
        input: { command: "ls" },
      },
      {
        kind: "tool_result",
        tool_use_id: "toolu_1",
        is_error: false,
        text: "a\nb",
      },
      { kind: "user_replay", uuid: "u-1", text: "look", images: 1 },
    ]);
  });

  test("an interrupt abandons the streamed blocks", () => {
    const items = parseAll([
      wrap({ type: "message_start", message: { id: "msg_3" } }),
      {
        type: "user",
        message: {
          role: "user",
          content: [{ type: "text", text: "[Request interrupted by user]" }],
        },
        parent_tool_use_id: null,
      },
      wrap(
        { type: "message_stop" },
        {
          api_message_id: "msg_3",
          abandoned_blocks: { api_message_id: "msg_3", from_block_index: 1 },
        },
      ),
      {
        type: "result",
        subtype: "error_during_execution",
        is_error: true,
        terminal_reason: "aborted_streaming",
        stop_reason: null,
      },
    ]);
    expect(items).toEqual([
      { kind: "interrupted" },
      { kind: "abandoned", message_id: "msg_3", from_index: 1 },
      {
        kind: "result",
        subtype: "error_during_execution",
        is_error: true,
        text: "",
        interrupted: true,
      },
    ]);
  });

  test("permission requests, cancels and control responses", () => {
    const items = parseAll([
      {
        type: "control_request",
        request_id: "r1",
        request: {
          subtype: "can_use_tool",
          tool_name: "AskUserQuestion",
          input: { questions: [] },
          tool_use_id: "toolu_q",
          requires_user_interaction: true,
        },
      },
      { type: "control_cancel_request", request_id: "r1" },
      {
        type: "control_response",
        response: { subtype: "success", request_id: "i1", response: {} },
      },
      {
        type: "control_response",
        response: { subtype: "error", request_id: "i2", error: "nope" },
      },
      {
        type: "control_request",
        request_id: "x",
        request: { subtype: "other" },
      },
    ]);
    expect(items).toEqual([
      {
        kind: "permission_request",
        request_id: "r1",
        tool_name: "AskUserQuestion",
        input: { questions: [] },
        tool_use_id: "toolu_q",
        suggestions: [],
        requires_user_interaction: true,
      },
      { kind: "permission_cancel", request_id: "r1" },
      { kind: "control_response", request_id: "i1" },
      { kind: "control_response", request_id: "i2", error: "nope" },
    ]);
  });

  test("system notices: reset, compact, retry, denial", () => {
    const items = parseAll([
      {
        type: "conversation_reset",
        new_conversation_id: "s2",
        trigger: "clear",
        session_id: "s1",
      },
      { type: "system", subtype: "status", status: "compacting" },
      {
        type: "system",
        subtype: "status",
        status: null,
        compact_result: "success",
      },
      {
        type: "system",
        subtype: "compact_boundary",
        compact_metadata: { pre_tokens: 100, post_tokens: 10 },
      },
      {
        type: "system",
        subtype: "api_retry",
        attempt: 1,
        max_retries: 10,
        retry_delay_ms: 555,
        error: "unknown",
      },
      {
        type: "system",
        subtype: "permission_denied",
        tool_name: "Bash",
        message: "needs approval",
      },
      { type: "system", subtype: "hook_started" },
      { type: "rate_limit_event" },
    ]);
    expect(items).toEqual([
      { kind: "reset", new_session_id: "s2", previous_session_id: "s1" },
      { kind: "status", status: "compacting" },
      { kind: "status", status: null, compact_result: "success" },
      { kind: "compact_boundary", pre_tokens: 100, post_tokens: 10 },
      {
        kind: "api_retry",
        attempt: 1,
        max_retries: 10,
        delay_ms: 555,
        error: "unknown",
      },
      {
        kind: "permission_denied",
        tool_name: "Bash",
        message: "needs approval",
      },
    ]);
  });

  test("tasks start and end, a subagent's too", () => {
    // Shapes measured on Claude Code 2.1.312 (a Bash command's task).
    expect(
      parseAll([
        {
          type: "system",
          subtype: "task_started",
          task_id: "b94wgcqft",
          tool_use_id: "toolu_1",
          description: "Sleep 6 seconds then echo slept",
          is_backgrounded: true,
          task_type: "local_bash",
        },
        {
          type: "system",
          subtype: "task_started",
          task_id: "agent1",
          parent_tool_use_id: "toolu_2",
          task_type: "local_agent",
        },
        {
          type: "system",
          subtype: "task_notification",
          task_id: "agent1",
          status: "running",
        },
        {
          type: "system",
          subtype: "task_notification",
          task_id: "b94wgcqft",
          status: "completed",
          summary: "Sleep 6 seconds then echo slept",
        },
      ]),
    ).toEqual([
      { kind: "task_started", task_id: "b94wgcqft", backgrounded: true },
      { kind: "task_started", task_id: "agent1", backgrounded: false },
      { kind: "task_ended", task_id: "b94wgcqft", status: "completed" },
    ]);
  });

  test("subagents and garbage are ignored", () => {
    const parser = createStreamParser();
    expect(parser.line("not json")).toEqual([]);
    expect(
      parser.parse(
        wrap(
          {
            type: "content_block_delta",
            index: 0,
            delta: { type: "text_delta", text: "x" },
          },
          { parent_tool_use_id: "toolu_task" },
        ),
      ),
    ).toEqual([]);
    expect(
      parser.parse({
        type: "assistant",
        message: { id: "m", content: [{ type: "text", text: "sub" }] },
        parent_tool_use_id: "toolu_task",
      }),
    ).toEqual([]);
  });

  test("blocks with no stream are counted in order", () => {
    const items = parseAll([
      {
        type: "assistant",
        message: {
          id: "msg_s",
          model: "<synthetic>",
          content: [{ type: "text", text: "cost" }],
        },
      },
      {
        type: "assistant",
        message: { id: "msg_s", content: [{ type: "text", text: "more" }] },
      },
    ]);
    expect(items.map((item) => "index" in item && item.index)).toEqual([0, 1]);
  });
});
