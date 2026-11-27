//! `server/src/conversation/stream.test.ts`: the stream-json parser.

use serde_json::{Value, json};

use super::StreamParser;

/// A stream event as the CLI wraps it (`wrap` of the TS test), from
/// `{"$wrap": event, "$extra": {...}}`.
fn unwrap(value: Value) -> Value {
    let Some(object) = value.as_object() else {
        return value;
    };
    let Some(event) = object.get("$wrap") else {
        return value;
    };
    let mut wrapped = json!({
        "type": "stream_event",
        "event": event,
        "session_id": "s1",
        "parent_tool_use_id": null,
        "uuid": "u",
    });
    if let Some(Value::Object(extra)) = object.get("$extra") {
        for (key, value) in extra {
            wrapped[key] = value.clone();
        }
    }
    wrapped
}

fn parse_all(events: Value) -> Vec<Value> {
    let mut parser = StreamParser::new();
    let Value::Array(events) = events else {
        panic!("events");
    };
    events
        .into_iter()
        .flat_map(|event| {
            let line = roamgate_agents::js::stringify(&unwrap(event));
            parser.line(&line)
        })
        .map(Value::Object)
        .collect()
}

fn kinds(items: &[Value], wanted: &[&str]) -> Vec<Value> {
    items
        .iter()
        .filter(|item| wanted.contains(&item["kind"].as_str().unwrap_or("")))
        .cloned()
        .collect()
}

#[test]
fn what_a_command_run_in_claude_code_printed_carries_its_transcript_record() {
    // Claude Code's own message, as conversation mode gets it for
    // /reload-plugins: the uuid is the transcript's record of the output.
    let items = parse_all(json!([
      {
        "type": "assistant",
        "message": {
          "id": "06adc7ef-334a-40cf-9093-cb21d2a25139",
          "model": "<synthetic>",
          "role": "assistant",
          "content": [{ "type": "text", "text": "Reloaded: 11 plugins" }],
        },
        "parent_tool_use_id": null,
        "local_command_source":
          "<local-command-stdout>Reloaded: 11 plugins</local-command-stdout>",
        "local_command_run": { "command": "reload-plugins", "args": "" },
        "session_id": "s1",
        "uuid": "a6e4c964-cde0-4d0f-981b-9e54768eb73d",
      },
      {
        "type": "assistant",
        "message": {
          "id": "msg_2",
          "role": "assistant",
          "content": [{ "type": "text", "text": "Hi" }],
        },
        "parent_tool_use_id": null,
        "session_id": "s1",
        "uuid": "u2",
      },
    ]));
    assert_eq!(
        json!(items),
        json!([
          {
            "kind": "assistant_text",
            "message_id": "06adc7ef-334a-40cf-9093-cb21d2a25139",
            "index": 0,
            "text": "Reloaded: 11 plugins",
            "command_output": { "uuid": "a6e4c964-cde0-4d0f-981b-9e54768eb73d" },
          },
          { "kind": "assistant_text", "message_id": "msg_2", "index": 0, "text": "Hi" },
        ])
    );
}

#[test]
fn an_answer_says_which_model_it_came_from_claude_codes_own_do_not() {
    let items = parse_all(json!([
      {
        "type": "assistant",
        "message": {
          "id": "msg_3",
          "model": "claude-sonnet-5-5",
          "content": [{ "type": "text", "text": "Fallen back" }],
        },
        "parent_tool_use_id": null,
      },
      {
        "type": "assistant",
        "message": {
          "id": "msg_4",
          "model": "<synthetic>",
          "content": [{ "type": "text", "text": "API Error" }],
        },
        "parent_tool_use_id": null,
      },
    ]));
    assert_eq!(
        json!(kinds(&items, &["model"])),
        json!([
          { "kind": "model", "model": "claude-sonnet-5-5" },
        ])
    );
}

#[test]
fn text_blocks_carry_the_api_message_id_and_block_index() {
    let items = parse_all(json!([
      {
        "type": "system",
        "subtype": "init",
        "session_id": "s1",
        "cwd": "/w",
        "model": "m",
      },
      { "type": "system", "subtype": "status", "status": "requesting" },
      {"$wrap": { "type": "message_start", "message": { "id": "msg_1" } }},
      {"$wrap": {
          "type": "content_block_start",
          "index": 0,
          "content_block": { "type": "thinking", "thinking": "" },
        }, "$extra": { "api_message_id": "msg_1" }},
      { "type": "system", "subtype": "thinking_tokens", "estimated_tokens": 12 },
      {"$wrap": { "type": "content_block_stop", "index": 0 }},
      {
        "type": "assistant",
        "message": { "id": "msg_1", "content": [{ "type": "thinking", "thinking": "" }] },
        "parent_tool_use_id": null,
      },
      {"$wrap": {
        "type": "content_block_start",
        "index": 1,
        "content_block": { "type": "text", "text": "" },
      }},
      {"$wrap": {
        "type": "content_block_delta",
        "index": 1,
        "delta": { "type": "text_delta", "text": "Hel" },
      }},
      {"$wrap": {
        "type": "content_block_delta",
        "index": 1,
        "delta": { "type": "signature_delta", "signature": "x" },
      }},
      {"$wrap": {
        "type": "content_block_delta",
        "index": 1,
        "delta": { "type": "text_delta", "text": "lo" },
      }},
      {"$wrap": { "type": "content_block_stop", "index": 1 }},
      {
        "type": "assistant",
        "message": { "id": "msg_1", "content": [{ "type": "text", "text": "Hello" }] },
        "parent_tool_use_id": null,
      },
      {
        "type": "result",
        "subtype": "success",
        "is_error": false,
        "result": "Hello",
        "terminal_reason": "completed",
        "session_id": "s1",
        "total_cost_usd": 0.01,
        "duration_ms": 900,
      },
    ]));
    assert_eq!(
        json!(items),
        json!([
          { "kind": "init", "session_id": "s1", "cwd": "/w", "model": "m" },
          { "kind": "status", "status": "requesting" },
          { "kind": "block_start", "message_id": "msg_1", "index": 0, "block": "thinking" },
          { "kind": "thinking", "tokens": 12 },
          { "kind": "block_stop", "message_id": "msg_1", "index": 0 },
          { "kind": "block_start", "message_id": "msg_1", "index": 1, "block": "text" },
          { "kind": "delta", "message_id": "msg_1", "index": 1, "text": "Hel" },
          { "kind": "delta", "message_id": "msg_1", "index": 1, "text": "lo" },
          { "kind": "block_stop", "message_id": "msg_1", "index": 1 },
          { "kind": "assistant_text", "message_id": "msg_1", "index": 1, "text": "Hello" },
          {
            "kind": "result",
            "subtype": "success",
            "is_error": false,
            "text": "Hello",
            "interrupted": false,
            "session_id": "s1",
            "cost_usd": 0.01,
            "duration_ms": 900,
          },
        ])
    );
}

#[test]
fn a_complete_block_sent_before_its_stop_keeps_its_own_index() {
    // What the CLI writes: each block's assistant event comes between its
    // start and its stop, a thinking block's too.
    let items = parse_all(json!([
      {"$wrap": { "type": "message_start", "message": { "id": "msg_1" } }},
      {"$wrap": {
        "type": "content_block_start",
        "index": 0,
        "content_block": { "type": "thinking", "thinking": "" },
      }},
      {
        "type": "assistant",
        "message": { "id": "msg_1", "content": [{ "type": "thinking", "thinking": "" }] },
        "parent_tool_use_id": null,
      },
      {"$wrap": { "type": "content_block_stop", "index": 0 }},
      {"$wrap": {
        "type": "content_block_start",
        "index": 1,
        "content_block": { "type": "text", "text": "" },
      }},
      {"$wrap": {
        "type": "content_block_delta",
        "index": 1,
        "delta": { "type": "text_delta", "text": "Rain" },
      }},
      {
        "type": "assistant",
        "message": { "id": "msg_1", "content": [{ "type": "text", "text": "Rain" }] },
        "parent_tool_use_id": null,
      },
      {"$wrap": { "type": "content_block_stop", "index": 1 }},
      {"$wrap": {
        "type": "content_block_start",
        "index": 2,
        "content_block": { "type": "tool_use", "id": "toolu_1", "name": "Bash" },
      }},
      {
        "type": "assistant",
        "message": {
          "id": "msg_1",
          "content": [
            { "type": "tool_use", "id": "toolu_1", "name": "Bash", "input": {} },
          ],
        },
        "parent_tool_use_id": null,
      },
      {"$wrap": { "type": "content_block_stop", "index": 2 }},
    ]));
    assert_eq!(
        json!(kinds(&items, &["assistant_text", "tool_use"])),
        json!([
          { "kind": "assistant_text", "message_id": "msg_1", "index": 1, "text": "Rain" },
          {
            "kind": "tool_use",
            "message_id": "msg_1",
            "index": 2,
            "tool_use_id": "toolu_1",
            "name": "Bash",
            "input": {},
          },
        ])
    );
}

#[test]
fn tool_uses_results_and_the_users_replayed_message() {
    let items = parse_all(json!([
      {"$wrap": { "type": "message_start", "message": { "id": "msg_2" } }},
      {"$wrap": {
        "type": "content_block_start",
        "index": 0,
        "content_block": {
          "type": "tool_use",
          "id": "toolu_1",
          "name": "Bash",
          "input": {},
        },
      }},
      {"$wrap": { "type": "content_block_stop", "index": 0 }},
      {
        "type": "assistant",
        "message": {
          "id": "msg_2",
          "content": [
            {
              "type": "tool_use",
              "id": "toolu_1",
              "name": "Bash",
              "input": { "command": "ls" },
            },
          ],
        },
        "parent_tool_use_id": null,
      },
      {
        "type": "user",
        "message": {
          "content": [
            {
              "type": "tool_result",
              "tool_use_id": "toolu_1",
              "content": [{ "type": "text", "text": "a\nb" }],
              "is_error": false,
            },
          ],
        },
        "parent_tool_use_id": null,
      },
      {
        "type": "user",
        "message": {
          "role": "user",
          "content": [
            { "type": "text", "text": "look" },
            { "type": "image", "source": { "type": "base64", "data": "x" } },
          ],
        },
        "uuid": "u-1",
        "isReplay": true,
        "parent_tool_use_id": null,
      },
    ]));
    assert_eq!(
        json!(items),
        json!([
          {
            "kind": "block_start",
            "message_id": "msg_2",
            "index": 0,
            "block": "tool_use",
            "tool_use_id": "toolu_1",
            "name": "Bash",
          },
          { "kind": "block_stop", "message_id": "msg_2", "index": 0 },
          {
            "kind": "tool_use",
            "message_id": "msg_2",
            "index": 0,
            "tool_use_id": "toolu_1",
            "name": "Bash",
            "input": { "command": "ls" },
          },
          {
            "kind": "tool_result",
            "tool_use_id": "toolu_1",
            "is_error": false,
            "text": "a\nb",
          },
          { "kind": "user_replay", "uuid": "u-1", "text": "look", "images": 1 },
        ])
    );
}

#[test]
fn a_replayed_local_command_reads_as_typed_and_its_output_is_not_the_users() {
    let items = parse_all(json!([
      {
        "type": "user",
        "message": {
          "role": "user",
          "content": "<command-name>/model</command-name>\n<command-message>model</command-message>\n<command-args>opus</command-args>",
        },
        "uuid": "u-1",
        "isReplay": true,
      },
      {
        "type": "user",
        "message": {
          "role": "user",
          "content": "<local-command-stdout>Set model to opus (claude-opus-5-5)</local-command-stdout>",
        },
        "uuid": "u-2",
        "isReplay": true,
      },
    ]));
    assert_eq!(
        json!(kinds(&items, &["user_replay"])),
        json!([{ "kind": "user_replay", "uuid": "u-1", "text": "/model opus", "images": 0 }])
    );
}

#[test]
fn an_interrupt_abandons_the_streamed_blocks() {
    let items = parse_all(json!([
      {"$wrap": { "type": "message_start", "message": { "id": "msg_3" } }},
      {
        "type": "user",
        "message": {
          "role": "user",
          "content": [{ "type": "text", "text": "[Request interrupted by user]" }],
        },
        "parent_tool_use_id": null,
      },
      {"$wrap": { "type": "message_stop" }, "$extra": {
          "api_message_id": "msg_3",
          "abandoned_blocks": { "api_message_id": "msg_3", "from_block_index": 1 },
        }},
      {
        "type": "result",
        "subtype": "error_during_execution",
        "is_error": true,
        "terminal_reason": "aborted_streaming",
        "stop_reason": null,
      },
    ]));
    assert_eq!(
        json!(items),
        json!([
          { "kind": "interrupted" },
          { "kind": "abandoned", "message_id": "msg_3", "from_index": 1 },
          {
            "kind": "result",
            "subtype": "error_during_execution",
            "is_error": true,
            "text": "",
            "interrupted": true,
          },
        ])
    );
}

#[test]
fn permission_requests_cancels_and_control_responses() {
    let items = parse_all(json!([
      {
        "type": "control_request",
        "request_id": "r1",
        "request": {
          "subtype": "can_use_tool",
          "tool_name": "AskUserQuestion",
          "input": { "questions": [] },
          "tool_use_id": "toolu_q",
          "requires_user_interaction": true,
        },
      },
      { "type": "control_cancel_request", "request_id": "r1" },
      {
        "type": "control_response",
        "response": {
          "subtype": "success",
          "request_id": "i1",
          "response": { "rewound": true, "prefillText": "again" },
        },
      },
      {
        "type": "control_response",
        "response": { "subtype": "error", "request_id": "i2", "error": "nope" },
      },
      {
        "type": "control_request",
        "request_id": "x",
        "request": { "subtype": "other" },
      },
    ]));
    assert_eq!(
        json!(items),
        json!([
          {
            "kind": "permission_request",
            "request_id": "r1",
            "tool_name": "AskUserQuestion",
            "input": { "questions": [] },
            "tool_use_id": "toolu_q",
            "suggestions": [],
            "requires_user_interaction": true,
          },
          { "kind": "permission_cancel", "request_id": "r1" },
          {
            "kind": "control_response",
            "request_id": "i1",
            "response": { "rewound": true, "prefillText": "again" },
          },
          { "kind": "control_response", "request_id": "i2", "error": "nope" },
        ])
    );
}

#[test]
fn system_notices_reset_compact_retry_denial() {
    let items = parse_all(json!([
      {
        "type": "conversation_reset",
        "new_conversation_id": "s2",
        "trigger": "clear",
        "session_id": "s1",
      },
      { "type": "system", "subtype": "status", "status": "compacting" },
      {
        "type": "system",
        "subtype": "status",
        "status": null,
        "compact_result": "success",
      },
      {
        "type": "system",
        "subtype": "compact_boundary",
        "compact_metadata": { "pre_tokens": 100, "post_tokens": 10 },
      },
      {
        "type": "system",
        "subtype": "api_retry",
        "attempt": 1,
        "max_retries": 10,
        "retry_delay_ms": 555,
        "error": "unknown",
      },
      {
        "type": "system",
        "subtype": "permission_denied",
        "tool_name": "Bash",
        "message": "needs approval",
      },
      { "type": "system", "subtype": "hook_started" },
      { "type": "rate_limit_event" },
    ]));
    assert_eq!(
        json!(items),
        json!([
          { "kind": "reset", "new_session_id": "s2", "previous_session_id": "s1" },
          { "kind": "status", "status": "compacting" },
          { "kind": "status", "status": null, "compact_result": "success" },
          { "kind": "compact_boundary", "pre_tokens": 100, "post_tokens": 10 },
          {
            "kind": "api_retry",
            "attempt": 1,
            "max_retries": 10,
            "delay_ms": 555,
            "error": "unknown",
          },
          {
            "kind": "permission_denied",
            "tool_name": "Bash",
            "message": "needs approval",
          },
        ])
    );
}

#[test]
fn tasks_start_and_end_a_subagents_too() {
    // Shapes measured on Claude Code 2.1.312 (a Bash command's task).
    assert_eq!(
        json!(parse_all(json!([
          {
            "type": "system",
            "subtype": "task_started",
            "task_id": "b94wgcqft",
            "tool_use_id": "toolu_1",
            "description": "Sleep 6 seconds then echo slept",
            "is_backgrounded": true,
            "task_type": "local_bash",
          },
          {
            "type": "system",
            "subtype": "task_started",
            "task_id": "agent1",
            "parent_tool_use_id": "toolu_2",
            "task_type": "local_agent",
          },
          {
            "type": "system",
            "subtype": "task_notification",
            "task_id": "agent1",
            "status": "running",
          },
          {
            "type": "system",
            "subtype": "task_notification",
            "task_id": "b94wgcqft",
            "status": "completed",
            "summary": "Sleep 6 seconds then echo slept",
          },
        ]))),
        json!([
          { "kind": "task_started", "task_id": "b94wgcqft", "backgrounded": true },
          { "kind": "task_started", "task_id": "agent1", "backgrounded": false },
          { "kind": "task_ended", "task_id": "b94wgcqft", "status": "completed" },
        ])
    );
}

#[test]
fn subagents_and_garbage_are_ignored() {
    let mut parser = StreamParser::new();
    assert_eq!(json!(parser.line("not json")), json!([]));
    assert_eq!(
        json!(parser.parse(&unwrap(json!({"$wrap": {
            "type": "content_block_delta",
            "index": 0,
            "delta": { "type": "text_delta", "text": "x" },
          }, "$extra": { "parent_tool_use_id": "toolu_task" }})))),
        json!([])
    );
    assert_eq!(
        json!(parser.parse(&json!({
          "type": "assistant",
          "message": { "id": "m", "content": [{ "type": "text", "text": "sub" }] },
          "parent_tool_use_id": "toolu_task",
        }))),
        json!([])
    );
}

#[test]
fn blocks_with_no_stream_are_counted_in_order() {
    let items = parse_all(json!([
      {
        "type": "assistant",
        "message": {
          "id": "msg_s",
          "model": "<synthetic>",
          "content": [{ "type": "text", "text": "cost" }],
        },
      },
      {
        "type": "assistant",
        "message": { "id": "msg_s", "content": [{ "type": "text", "text": "more" }] },
      },
    ]));
    assert_eq!(
        json!(
            items
                .iter()
                .map(|item| item["index"].clone())
                .collect::<Vec<_>>()
        ),
        json!([0, 1])
    );
}

#[test]
fn a_predicted_next_prompt_as_claude_code_sends_it_after_a_turn() {
    assert_eq!(
        json!(parse_all(json!([
          {
            "type": "prompt_suggestion",
            "suggestion": "show me a full example",
            "uuid": "d7cff111",
            "session_id": "s1",
          },
          { "type": "prompt_suggestion", "suggestion": "  ", "uuid": "x" },
          { "type": "prompt_suggestion", "uuid": "y" },
        ]))),
        json!([
          {
            "kind": "prompt_suggestion",
            "suggestion": "show me a full example",
            "uuid": "d7cff111",
          },
        ])
    );
}
