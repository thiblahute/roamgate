//! What one line of `claude -p --output-format stream-json` means for
//! conversation mode (`drivers/claude-stream.ts`): stream items
//! (`{kind: ...}` objects, roamgate-conversation's `DriverEvent`).
//! Subagents' events (a parent tool use) are left to the history: only the
//! main conversation streams.

use indexmap::IndexMap;
use roamgate_agents::js::{self, Obj};
use roamgate_agents::obj;
use roamgate_agents::shared::bash_mode::split_bash_mode;
use serde_json::{Value, json};

const INTERRUPTED: &str = "[Request interrupted by user]";

/// How many messages' blocks are kept: old messages are done with once a
/// newer one starts.
const KEPT_MESSAGES: usize = 16;

fn str_of(value: Option<&Value>) -> &str {
    js::sv(value)
}

/// `typeof value === "string" && value`.
fn filled(value: Option<&Value>) -> Option<&str> {
    value
        .and_then(Value::as_str)
        .filter(|text| !text.is_empty())
}

fn num(value: Option<&Value>) -> Option<f64> {
    js::num(value)
}

fn record(value: Option<&Value>) -> Option<&Obj> {
    js::rec(value)
}

fn text_of(content: Option<&Value>) -> String {
    match content {
        Some(Value::String(text)) => text.clone(),
        Some(Value::Array(parts)) => parts
            .iter()
            .filter_map(|part| {
                let part = part.as_object()?;
                (js::sv(part.get("type")) == "text")
                    .then(|| part.get("text").and_then(Value::as_str))
                    .flatten()
            })
            .collect::<Vec<_>>()
            .join("\n"),
        _ => String::new(),
    }
}

fn image_count(content: Option<&Value>) -> usize {
    content
        .and_then(Value::as_array)
        .map(|parts| {
            parts
                .iter()
                .filter(|part| {
                    part.as_object()
                        .is_some_and(|p| js::sv(p.get("type")) == "image")
                })
                .count()
        })
        .unwrap_or(0)
}

/// A block as it started: its index and type.
#[derive(Clone, Debug, PartialEq)]
struct Started {
    index: f64,
    kind: String,
}

/// Turns stream-json lines into stream items. Stateful: content block
/// events name only their index, so it keeps the current API message id,
/// and a complete-block `assistant` event is matched to its streamed block
/// by type and order.
#[derive(Clone, Debug, Default)]
pub struct StreamParser {
    message_id: String,
    /// The blocks of a message as they started, with their type: each
    /// complete-block assistant event takes the index of the first one of
    /// its type it has not matched yet. The CLI sends that event before the
    /// block's stop, and sends one for a thinking block too, so neither the
    /// stops nor a count can say which block it is. Counted when nothing
    /// streamed (one event per block, in order). Maps in JavaScript's
    /// order: setting a key keeps its place.
    started: IndexMap<String, Vec<Started>>,
    blocks_seen: IndexMap<String, f64>,
}

impl StreamParser {
    pub fn new() -> Self {
        Self::default()
    }

    fn block_index(&mut self, id: &str, kind: &str) -> f64 {
        let taken = self.started.get_mut(id).and_then(|blocks| {
            let at = blocks.iter().position(|block| block.kind == kind)?;
            Some(blocks.remove(at).index)
        });
        let seen = self.blocks_seen.get(id).copied();
        let index = taken.unwrap_or(seen.unwrap_or(0.0));
        let next = seen.unwrap_or(0.0).max(index + 1.0);
        self.blocks_seen.insert(id.to_owned(), next);
        if self.blocks_seen.len() > KEPT_MESSAGES {
            self.blocks_seen.shift_remove_index(0);
        }
        index
    }

    fn block_started(&mut self, id: &str, index: f64, kind: &str) {
        let mut blocks: Vec<Started> = self
            .started
            .get(id)
            .map(|blocks| {
                blocks
                    .iter()
                    .filter(|b| b.index != index)
                    .cloned()
                    .collect()
            })
            .unwrap_or_default();
        blocks.push(Started {
            index,
            kind: kind.to_owned(),
        });
        self.started.insert(id.to_owned(), blocks);
        if self.started.len() > KEPT_MESSAGES {
            self.started.shift_remove_index(0);
        }
    }

    fn parse_stream_event(&mut self, wrapper: &Obj) -> Vec<Obj> {
        let Some(event) = record(wrapper.get("event")) else {
            return Vec::new();
        };
        let wrapped = str_of(wrapper.get("api_message_id"));
        let kind = str_of(event.get("type"));
        if kind == "message_start" {
            let empty = Obj::new();
            let message = record(event.get("message")).unwrap_or(&empty);
            let id = str_of(message.get("id"));
            self.message_id = if !id.is_empty() {
                id.to_owned()
            } else if !wrapped.is_empty() {
                wrapped.to_owned()
            } else {
                self.message_id.clone()
            };
            return Vec::new();
        }
        let id = if wrapped.is_empty() {
            self.message_id.clone()
        } else {
            wrapped.to_owned()
        };
        let index = num(event.get("index")).unwrap_or(0.0);
        let mut items = Vec::new();
        match kind {
            "content_block_start" => {
                let empty = Obj::new();
                let block = record(event.get("content_block")).unwrap_or(&empty);
                let block_type = str_of(block.get("type")).to_owned();
                self.block_started(&id, index, &block_type);
                if block_type == "text" || block_type == "thinking" {
                    items.push(obj! {
                        "kind" => "block_start",
                        "message_id" => id.as_str(),
                        "index" => index,
                        "block" => block_type.as_str(),
                    });
                } else if block_type == "tool_use" {
                    items.push(obj! {
                        "kind" => "block_start",
                        "message_id" => id.as_str(),
                        "index" => index,
                        "block" => "tool_use",
                        "tool_use_id" => str_of(block.get("id")),
                        "name" => str_of(block.get("name")),
                    });
                }
            }
            "content_block_delta" => {
                let empty = Obj::new();
                let delta = record(event.get("delta")).unwrap_or(&empty);
                if str_of(delta.get("type")) == "text_delta"
                    && let Some(text) = delta.get("text").and_then(Value::as_str)
                {
                    items.push(obj! {
                        "kind" => "delta",
                        "message_id" => id.as_str(),
                        "index" => index,
                        "text" => text,
                    });
                }
            }
            "content_block_stop" => items.push(obj! {
                "kind" => "block_stop",
                "message_id" => id.as_str(),
                "index" => index,
            }),
            _ => {}
        }
        // A retry or an interrupt drops what was streamed of this message.
        let abandoned = record(wrapper.get("abandoned_blocks"))
            .or_else(|| record(event.get("abandoned_blocks")));
        if let Some(abandoned) = abandoned {
            let named = str_of(abandoned.get("api_message_id"));
            let message = if named.is_empty() {
                id.clone()
            } else {
                named.to_owned()
            };
            let from = num(abandoned.get("from_block_index")).unwrap_or(0.0);
            // A retry streams these blocks again: they start anew.
            if let Some(blocks) = self.started.get_mut(&message) {
                blocks.retain(|block| block.index < from);
            }
            if let Some(seen) = self.blocks_seen.get_mut(&message)
                && *seen > from
            {
                *seen = from;
            }
            items.push(obj! {
                "kind" => "abandoned",
                "message_id" => message.as_str(),
                "from_index" => from,
            });
        }
        items
    }

    fn parse_assistant(&mut self, event: &Obj) -> Vec<Obj> {
        let Some(message) = record(event.get("message")) else {
            return Vec::new();
        };
        let Some(content) = message.get("content").and_then(Value::as_array) else {
            return Vec::new();
        };
        let id = str_of(message.get("id")).to_owned();
        let mut items = Vec::new();
        // Claude Code's own notices (<synthetic>) come from no model.
        let model = str_of(message.get("model"));
        if !model.is_empty() && model != "<synthetic>" {
            items.push(obj! {"kind" => "model", "model" => model});
        }
        let uuid = str_of(event.get("uuid"));
        let command_output = (event.contains_key("local_command_source") && !uuid.is_empty())
            .then(|| obj! {"uuid" => uuid});
        for part in content {
            let Some(part) = part.as_object() else {
                continue;
            };
            let part_type = str_of(part.get("type"));
            let index = self.block_index(&id, part_type);
            if part_type == "text"
                && let Some(text) = part.get("text").and_then(Value::as_str)
            {
                items.push(obj! {
                    "kind" => "assistant_text",
                    "message_id" => id.as_str(),
                    "index" => index,
                    "text" => text,
                    "command_output" => command_output.clone(),
                });
            } else if part_type == "tool_use"
                && let Some(tool_id) = part.get("id").and_then(Value::as_str)
            {
                let name = str_of(part.get("name"));
                items.push(obj! {
                    "kind" => "tool_use",
                    "message_id" => id.as_str(),
                    "index" => index,
                    "tool_use_id" => tool_id,
                    "name" => if name.is_empty() { "tool" } else { name },
                    "input" => part.get("input").cloned(),
                });
            }
        }
        items
    }

    fn parse_user(&self, event: &Obj) -> Vec<Obj> {
        let Some(message) = record(event.get("message")) else {
            return Vec::new();
        };
        let content = message.get("content");
        let mut items = Vec::new();
        if let Some(parts) = content.and_then(Value::as_array) {
            for part in parts {
                let Some(part) = part.as_object() else {
                    continue;
                };
                if str_of(part.get("type")) == "tool_result"
                    && let Some(tool_use_id) = part.get("tool_use_id").and_then(Value::as_str)
                {
                    items.push(obj! {
                        "kind" => "tool_result",
                        "tool_use_id" => tool_use_id,
                        "is_error" => js::is_true(part.get("is_error")),
                        "text" => text_of(part.get("content")),
                    });
                }
            }
        }
        if !items.is_empty() {
            return items;
        }
        // The `!` lines sent before a message are not the user's words.
        let raw = text_of(content);
        let text = split_bash_mode(&raw).map(|(_, rest)| rest).unwrap_or(raw);
        if js::trim(&text) == INTERRUPTED {
            return vec![obj! {"kind" => "interrupted"}];
        }
        if js::is_true(event.get("isReplay")) {
            return vec![obj! {
                "kind" => "user_replay",
                "uuid" => str_of(event.get("uuid")),
                "text" => text,
                "images" => image_count(content),
            }];
        }
        Vec::new()
    }

    fn parse_system(&self, event: &Obj) -> Vec<Obj> {
        match str_of(event.get("subtype")) {
            "init" => match event.get("session_id").and_then(Value::as_str) {
                Some(session) => vec![obj! {
                    "kind" => "init",
                    "session_id" => session,
                    "cwd" => js::str_of(event.get("cwd")),
                    "model" => js::str_of(event.get("model")),
                }],
                None => Vec::new(),
            },
            "status" => vec![obj! {
                "kind" => "status",
                "status" => event
                    .get("status")
                    .and_then(Value::as_str)
                    .map_or(Value::Null, |s| Value::String(s.to_owned())),
                "compact_result" => js::str_of(event.get("compact_result")),
            }],
            "thinking_tokens" => vec![obj! {
                "kind" => "thinking",
                "tokens" => num(event.get("estimated_tokens")).unwrap_or(0.0),
            }],
            "compact_boundary" => {
                let empty = Obj::new();
                let meta = record(event.get("compact_metadata")).unwrap_or(&empty);
                vec![obj! {
                    "kind" => "compact_boundary",
                    "pre_tokens" => num(meta.get("pre_tokens")),
                    "post_tokens" => num(meta.get("post_tokens")),
                }]
            }
            "api_retry" => vec![obj! {
                "kind" => "api_retry",
                "attempt" => num(event.get("attempt")).unwrap_or(0.0),
                "max_retries" => num(event.get("max_retries")).unwrap_or(0.0),
                "delay_ms" => num(event.get("retry_delay_ms")).unwrap_or(0.0),
                "error" => str_of(event.get("error")),
            }],
            "task_started" => match filled(event.get("task_id")) {
                Some(task) => vec![obj! {
                    "kind" => "task_started",
                    "task_id" => task,
                    "backgrounded" => js::is_true(event.get("is_backgrounded")),
                }],
                None => Vec::new(),
            },
            "task_notification" => {
                let status = str_of(event.get("status"));
                // A progress note says nothing of its end.
                let Some(task) = filled(event.get("task_id")) else {
                    return Vec::new();
                };
                if status == "running" || status == "pending" {
                    return Vec::new();
                }
                vec![obj! {"kind" => "task_ended", "task_id" => task, "status" => status}]
            }
            "permission_denied" => vec![obj! {
                "kind" => "permission_denied",
                "tool_name" => str_of(event.get("tool_name")),
                "message" => str_of(event.get("message")),
            }],
            _ => Vec::new(),
        }
    }

    /// Items for one event, parsed.
    pub fn parse(&mut self, event: &Value) -> Vec<Obj> {
        let Some(event) = event.as_object() else {
            return Vec::new();
        };
        let kind = str_of(event.get("type"));
        let subtype = str_of(event.get("subtype"));
        // Subagents stream and speak too; their work shows in the history.
        // Their tasks still count: a running one keeps the process needed.
        if event
            .get("parent_tool_use_id")
            .is_some_and(Value::is_string)
            && kind != "result"
            && !(kind == "system" && (subtype == "task_started" || subtype == "task_notification"))
        {
            return Vec::new();
        }
        match kind {
            "stream_event" => self.parse_stream_event(event),
            "assistant" => self.parse_assistant(event),
            "user" => self.parse_user(event),
            "system" => self.parse_system(event),
            "prompt_suggestion" => {
                let suggestion = js::trim(str_of(event.get("suggestion")));
                if suggestion.is_empty() {
                    return Vec::new();
                }
                vec![obj! {
                    "kind" => "prompt_suggestion",
                    "suggestion" => suggestion,
                    "uuid" => str_of(event.get("uuid")),
                }]
            }
            "conversation_reset" => {
                match event.get("new_conversation_id").and_then(Value::as_str) {
                    Some(new) => vec![obj! {
                        "kind" => "reset",
                        "new_session_id" => new,
                        "previous_session_id" => js::str_of(event.get("session_id")),
                    }],
                    None => Vec::new(),
                }
            }
            "control_request" => {
                let empty = Obj::new();
                let request = record(event.get("request")).unwrap_or(&empty);
                if str_of(request.get("subtype")) != "can_use_tool" {
                    return Vec::new();
                }
                let tool = str_of(request.get("tool_name"));
                vec![obj! {
                    "kind" => "permission_request",
                    "request_id" => str_of(event.get("request_id")),
                    "tool_name" => if tool.is_empty() { "tool" } else { tool },
                    "input" => request.get("input").cloned(),
                    "tool_use_id" => js::str_of(request.get("tool_use_id")),
                    "suggestions" => request
                        .get("permission_suggestions")
                        .filter(|value| value.is_array())
                        .cloned()
                        .unwrap_or_else(|| json!([])),
                    "requires_user_interaction" => js::is_true(request.get("requires_user_interaction")),
                }]
            }
            "control_cancel_request" => vec![obj! {
                "kind" => "permission_cancel",
                "request_id" => str_of(event.get("request_id")),
            }],
            "control_response" => {
                let empty = Obj::new();
                let response = record(event.get("response")).unwrap_or(&empty);
                let error = (str_of(response.get("subtype")) == "error").then(|| {
                    let error = str_of(response.get("error"));
                    if error.is_empty() { "error" } else { error }
                });
                vec![obj! {
                    "kind" => "control_response",
                    "request_id" => str_of(response.get("request_id")),
                    "error" => error,
                    "response" => record(response.get("response")).cloned(),
                }]
            }
            "result" => {
                let subtype = if subtype.is_empty() {
                    "success"
                } else {
                    subtype
                };
                let reason = str_of(event.get("terminal_reason"));
                let queued = num(event.get("queued_turn_count")).filter(|n| *n != 0.0);
                vec![obj! {
                    "kind" => "result",
                    "subtype" => subtype,
                    "is_error" => js::is_true(event.get("is_error")),
                    "text" => str_of(event.get("result")),
                    "interrupted" => reason == "aborted_streaming" || reason == "aborted_tools",
                    "session_id" => js::str_of(event.get("session_id")),
                    "cost_usd" => num(event.get("total_cost_usd")),
                    "duration_ms" => num(event.get("duration_ms")),
                    "queued_turns" => queued,
                }]
            }
            _ => Vec::new(),
        }
    }

    /// Items for one line; garbage and unknown events give none.
    pub fn line(&mut self, line: &str) -> Vec<Obj> {
        match js::parse(line) {
            Some(event) => self.parse(&event),
            None => Vec::new(),
        }
    }

    /// What it keeps between lines, for a reader after a restart
    /// (`StreamParserState`).
    pub fn save(&self) -> Value {
        let started: Vec<Value> = self
            .started
            .iter()
            .map(|(id, blocks)| {
                let blocks: Vec<Value> = blocks
                    .iter()
                    .map(|block| {
                        Value::Object(obj! {"index" => block.index, "type" => block.kind.as_str()})
                    })
                    .collect();
                json!([id, blocks])
            })
            .collect();
        let seen: Vec<Value> = self
            .blocks_seen
            .iter()
            .map(|(id, count)| json!([id, js::number(*count)]))
            .collect();
        Value::Object(obj! {
            "message_id" => self.message_id.as_str(),
            "started" => started,
            "blocks_seen" => seen,
        })
    }

    /// Takes up where `save` stopped.
    pub fn restore(&mut self, state: &Value) {
        let empty = Obj::new();
        let state = state.as_object().unwrap_or(&empty);
        self.message_id = js::str_of(state.get("message_id")).unwrap_or("").to_owned();
        self.started.clear();
        self.blocks_seen.clear();
        for entry in state
            .get("started")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            let Some(pair) = entry.as_array() else {
                continue;
            };
            let (Some(Value::String(id)), Some(Value::Array(blocks))) = (pair.first(), pair.get(1))
            else {
                continue;
            };
            let blocks = blocks
                .iter()
                .filter_map(|block| {
                    let block = block.as_object()?;
                    Some(Started {
                        index: block.get("index")?.as_f64()?,
                        kind: block.get("type")?.as_str()?.to_owned(),
                    })
                })
                .collect();
            self.started.insert(id.clone(), blocks);
        }
        for entry in state
            .get("blocks_seen")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            let Some(pair) = entry.as_array() else {
                continue;
            };
            if let (Some(Value::String(id)), Some(count)) =
                (pair.first(), pair.get(1).and_then(Value::as_f64))
            {
                self.blocks_seen.insert(id.clone(), count);
            }
        }
    }
}

#[cfg(test)]
mod tests;
