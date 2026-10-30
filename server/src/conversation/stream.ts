import { isRecord } from "../agent/session-utils";

/**
 * What one line of `claude -p --output-format stream-json` means for
 * conversation mode. Subagents' events (a parent tool use) are left to the
 * history: only the main conversation streams.
 */
export type StreamItem =
  | { kind: "init"; session_id: string; cwd?: string; model?: string }
  | { kind: "status"; status: string | null; compact_result?: string }
  | {
      kind: "block_start";
      message_id: string;
      index: number;
      block: "text" | "thinking" | "tool_use";
      tool_use_id?: string;
      name?: string;
    }
  | { kind: "delta"; message_id: string; index: number; text: string }
  | { kind: "block_stop"; message_id: string; index: number }
  | { kind: "abandoned"; message_id: string; from_index: number }
  | { kind: "thinking"; tokens: number }
  | { kind: "assistant_text"; message_id: string; index: number; text: string }
  | {
      kind: "tool_use";
      message_id: string;
      index: number;
      tool_use_id: string;
      name: string;
      input: unknown;
    }
  | {
      kind: "tool_result";
      tool_use_id: string;
      is_error: boolean;
      text: string;
    }
  | { kind: "user_replay"; uuid: string; text: string; images: number }
  | { kind: "interrupted" }
  | {
      kind: "permission_request";
      request_id: string;
      tool_name: string;
      input: unknown;
      tool_use_id?: string;
      suggestions: unknown[];
      requires_user_interaction: boolean;
    }
  | { kind: "permission_cancel"; request_id: string }
  | { kind: "control_response"; request_id: string; error?: string }
  | {
      kind: "result";
      subtype: string;
      is_error: boolean;
      text: string;
      interrupted: boolean;
      session_id?: string;
      cost_usd?: number;
      duration_ms?: number;
      /** Messages the CLI took meanwhile and runs as turns of their own. */
      queued_turns?: number;
    }
  | { kind: "reset"; new_session_id: string; previous_session_id?: string }
  | { kind: "compact_boundary"; pre_tokens?: number; post_tokens?: number }
  | {
      kind: "api_retry";
      attempt: number;
      max_retries: number;
      delay_ms: number;
      error: string;
    }
  | { kind: "permission_denied"; tool_name: string; message: string }
  /** A task (a Bash command, a subagent) started; it may outlive the turn. */
  | { kind: "task_started"; task_id: string; backgrounded: boolean }
  | { kind: "task_ended"; task_id: string; status: string };

const INTERRUPTED = "[Request interrupted by user]";

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .flatMap((part) =>
      isRecord(part) && part.type === "text" && typeof part.text === "string"
        ? [part.text]
        : [],
    )
    .join("\n");
}

function imageCount(content: unknown): number {
  return Array.isArray(content)
    ? content.filter((part) => isRecord(part) && part.type === "image").length
    : 0;
}

/**
 * Turns stream-json lines into StreamItems. Stateful: content block events
 * name only their index, so it keeps the current API message id, and a
 * complete-block `assistant` event is matched to its streamed block by type
 * and order.
 */
export function createStreamParser() {
  let messageId = "";
  // The blocks of a message as they started, with their type: each
  // complete-block assistant event takes the index of the first one of its
  // type it has not matched yet. The CLI sends that event before the
  // block's stop, and sends one for a thinking block too, so neither the
  // stops nor a count can say which block it is. Counted when nothing
  // streamed (one event per block, in order).
  const started = new Map<string, { index: number; type: string }[]>();
  const blocksSeen = new Map<string, number>();
  function blockIndex(id: string, type: string): number {
    const blocks = started.get(id);
    const at = blocks?.findIndex((block) => block.type === type) ?? -1;
    const index =
      at >= 0 ? blocks!.splice(at, 1)[0]!.index : (blocksSeen.get(id) ?? 0);
    blocksSeen.set(id, Math.max(blocksSeen.get(id) ?? 0, index + 1));
    // Old messages are done with once a newer one starts.
    if (blocksSeen.size > 16)
      blocksSeen.delete(blocksSeen.keys().next().value!);
    return index;
  }
  function blockStarted(id: string, index: number, type: string) {
    const blocks = (started.get(id) ?? []).filter(
      (block) => block.index !== index,
    );
    blocks.push({ index, type });
    started.set(id, blocks);
    if (started.size > 16) started.delete(started.keys().next().value!);
  }

  function parseStreamEvent(wrapper: Record<string, unknown>): StreamItem[] {
    const event = isRecord(wrapper.event) ? wrapper.event : null;
    if (!event) return [];
    const wrapped = str(wrapper.api_message_id);
    if (event.type === "message_start") {
      const message = isRecord(event.message) ? event.message : {};
      messageId = str(message.id) || wrapped || messageId;
      return [];
    }
    const id = wrapped || messageId;
    const index = num(event.index) ?? 0;
    const items: StreamItem[] = [];
    if (event.type === "content_block_start") {
      const block = isRecord(event.content_block) ? event.content_block : {};
      const type = str(block.type);
      blockStarted(id, index, type);
      if (type === "text" || type === "thinking")
        items.push({ kind: "block_start", message_id: id, index, block: type });
      else if (type === "tool_use")
        items.push({
          kind: "block_start",
          message_id: id,
          index,
          block: "tool_use",
          tool_use_id: str(block.id),
          name: str(block.name),
        });
    } else if (event.type === "content_block_delta") {
      const delta = isRecord(event.delta) ? event.delta : {};
      if (delta.type === "text_delta" && typeof delta.text === "string")
        items.push({ kind: "delta", message_id: id, index, text: delta.text });
    } else if (event.type === "content_block_stop") {
      items.push({ kind: "block_stop", message_id: id, index });
    }
    // A retry or an interrupt drops what was streamed of this message.
    const abandoned = isRecord(wrapper.abandoned_blocks)
      ? wrapper.abandoned_blocks
      : isRecord(event.abandoned_blocks)
        ? event.abandoned_blocks
        : null;
    if (abandoned) {
      const message = str(abandoned.api_message_id) || id;
      const from = num(abandoned.from_block_index) ?? 0;
      // A retry streams these blocks again: they start anew.
      const blocks = started.get(message);
      if (blocks)
        started.set(
          message,
          blocks.filter((block) => block.index < from),
        );
      if ((blocksSeen.get(message) ?? 0) > from) blocksSeen.set(message, from);
      items.push({ kind: "abandoned", message_id: message, from_index: from });
    }
    return items;
  }

  function parseAssistant(event: Record<string, unknown>): StreamItem[] {
    const message = isRecord(event.message) ? event.message : null;
    if (!message || !Array.isArray(message.content)) return [];
    const id = str(message.id);
    const items: StreamItem[] = [];
    for (const part of message.content) {
      if (!isRecord(part)) continue;
      const index = blockIndex(id, str(part.type));
      if (part.type === "text" && typeof part.text === "string")
        items.push({
          kind: "assistant_text",
          message_id: id,
          index,
          text: part.text,
        });
      else if (part.type === "tool_use" && typeof part.id === "string")
        items.push({
          kind: "tool_use",
          message_id: id,
          index,
          tool_use_id: part.id,
          name: str(part.name) || "tool",
          input: part.input,
        });
    }
    return items;
  }

  function parseUser(event: Record<string, unknown>): StreamItem[] {
    const message = isRecord(event.message) ? event.message : null;
    if (!message) return [];
    const content = message.content;
    const items: StreamItem[] = [];
    if (Array.isArray(content))
      for (const part of content) {
        if (
          isRecord(part) &&
          part.type === "tool_result" &&
          typeof part.tool_use_id === "string"
        )
          items.push({
            kind: "tool_result",
            tool_use_id: part.tool_use_id,
            is_error: part.is_error === true,
            text: textOf(part.content),
          });
      }
    if (items.length) return items;
    const text = textOf(content);
    if (text.trim() === INTERRUPTED) return [{ kind: "interrupted" }];
    if (event.isReplay === true)
      return [
        {
          kind: "user_replay",
          uuid: str(event.uuid),
          text,
          images: imageCount(content),
        },
      ];
    return [];
  }

  function parseSystem(event: Record<string, unknown>): StreamItem[] {
    switch (event.subtype) {
      case "init":
        return typeof event.session_id === "string"
          ? [
              {
                kind: "init",
                session_id: event.session_id,
                ...(typeof event.cwd === "string" ? { cwd: event.cwd } : {}),
                ...(typeof event.model === "string"
                  ? { model: event.model }
                  : {}),
              },
            ]
          : [];
      case "status":
        return [
          {
            kind: "status",
            status: typeof event.status === "string" ? event.status : null,
            ...(typeof event.compact_result === "string"
              ? { compact_result: event.compact_result }
              : {}),
          },
        ];
      case "thinking_tokens":
        return [{ kind: "thinking", tokens: num(event.estimated_tokens) ?? 0 }];
      case "compact_boundary": {
        const meta = isRecord(event.compact_metadata)
          ? event.compact_metadata
          : {};
        return [
          {
            kind: "compact_boundary",
            pre_tokens: num(meta.pre_tokens),
            post_tokens: num(meta.post_tokens),
          },
        ];
      }
      case "api_retry":
        return [
          {
            kind: "api_retry",
            attempt: num(event.attempt) ?? 0,
            max_retries: num(event.max_retries) ?? 0,
            delay_ms: num(event.retry_delay_ms) ?? 0,
            error: str(event.error),
          },
        ];
      case "task_started":
        return typeof event.task_id === "string" && event.task_id
          ? [
              {
                kind: "task_started",
                task_id: event.task_id,
                backgrounded: event.is_backgrounded === true,
              },
            ]
          : [];
      case "task_notification": {
        const status = str(event.status);
        // A progress note says nothing of its end.
        if (!(typeof event.task_id === "string" && event.task_id)) return [];
        if (status === "running" || status === "pending") return [];
        return [{ kind: "task_ended", task_id: event.task_id, status }];
      }
      case "permission_denied":
        return [
          {
            kind: "permission_denied",
            tool_name: str(event.tool_name),
            message: str(event.message),
          },
        ];
      default:
        return [];
    }
  }

  function parse(event: unknown): StreamItem[] {
    if (!isRecord(event)) return [];
    // Subagents stream and speak too; their work shows in the history.
    // Their tasks still count: a running one keeps the process needed.
    if (
      typeof event.parent_tool_use_id === "string" &&
      event.type !== "result" &&
      !(
        event.type === "system" &&
        (event.subtype === "task_started" ||
          event.subtype === "task_notification")
      )
    )
      return [];
    switch (event.type) {
      case "stream_event":
        return parseStreamEvent(event);
      case "assistant":
        return parseAssistant(event);
      case "user":
        return parseUser(event);
      case "system":
        return parseSystem(event);
      case "conversation_reset":
        return typeof event.new_conversation_id === "string"
          ? [
              {
                kind: "reset",
                new_session_id: event.new_conversation_id,
                ...(typeof event.session_id === "string"
                  ? { previous_session_id: event.session_id }
                  : {}),
              },
            ]
          : [];
      case "control_request": {
        const request = isRecord(event.request) ? event.request : {};
        if (request.subtype !== "can_use_tool") return [];
        return [
          {
            kind: "permission_request",
            request_id: str(event.request_id),
            tool_name: str(request.tool_name) || "tool",
            input: request.input,
            ...(typeof request.tool_use_id === "string"
              ? { tool_use_id: request.tool_use_id }
              : {}),
            suggestions: Array.isArray(request.permission_suggestions)
              ? request.permission_suggestions
              : [],
            requires_user_interaction:
              request.requires_user_interaction === true,
          },
        ];
      }
      case "control_cancel_request":
        return [
          { kind: "permission_cancel", request_id: str(event.request_id) },
        ];
      case "control_response": {
        const response = isRecord(event.response) ? event.response : {};
        return [
          {
            kind: "control_response",
            request_id: str(response.request_id),
            ...(response.subtype === "error"
              ? { error: str(response.error) || "error" }
              : {}),
          },
        ];
      }
      case "result":
        return [
          {
            kind: "result",
            subtype: str(event.subtype) || "success",
            is_error: event.is_error === true,
            text: str(event.result),
            interrupted:
              event.terminal_reason === "aborted_streaming" ||
              event.terminal_reason === "aborted_tools",
            ...(typeof event.session_id === "string"
              ? { session_id: event.session_id }
              : {}),
            ...(num(event.total_cost_usd) !== undefined
              ? { cost_usd: num(event.total_cost_usd) }
              : {}),
            ...(num(event.duration_ms) !== undefined
              ? { duration_ms: num(event.duration_ms) }
              : {}),
            ...(num(event.queued_turn_count)
              ? { queued_turns: num(event.queued_turn_count) }
              : {}),
          },
        ];
      default:
        return [];
    }
  }

  return {
    /** Items for one line; garbage and unknown events give none. */
    line(line: string): StreamItem[] {
      let event: unknown;
      try {
        event = JSON.parse(line);
      } catch {
        return [];
      }
      return parse(event);
    },
    parse,
  };
}

export type StreamParser = ReturnType<typeof createStreamParser>;
