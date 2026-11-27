//! Antigravity CLI headless protocol driver over Agent Client Protocol
//! (`agy acp --stdio`): newline-delimited JSON-RPC 2.0 on stdin/stdout.

use roamgate_agents::js::{self, Obj};
use roamgate_agents::obj;
use serde_json::{Value, json};

use roamgate_conversation::driver::{
    BoxFuture, CommandContext, CommandNotice, DriverCodec, DriverEvent, DriverMessage,
    DriverPrompt, HolderStartCommand, InputKind, ModelContext, ModelDriver, ModelSet, Object,
    ProtocolDriver, StartOptions, UNNAMED_SESSION_ID, WrittenMessage,
};

const INIT_REQUEST_ID: &str = "roamgate-acp-init";
const RESUME_REQUEST_ID: &str = "roamgate-acp-resume";
const NEW_REQUEST_ID: &str = "roamgate-acp-new";

/// Flags from an interactive `agy` TUI that `agy acp` also accepts.
const ACP_KEPT_FLAGS: [&str; 4] = [
    "--add-dir",
    "--agent",
    "--dangerously-skip-permissions",
    "--sandbox",
];

/// AGY's conversation capabilities (`AgentChatCapabilities`).
pub fn agy_capabilities() -> Value {
    json!({
        "steer": false,
        "questions": false,
        "alwaysAllow": true,
        "rewind": null,
        "promptSuggestions": false,
        "shellLines": "prelude",
        "backgroundTasks": false,
        "images": "base64",
        "slashCommands": "agy",
        "models": true,
        "mcp": false,
        "backgroundTools": false,
    })
}

/// Filters interactive `agy` flags down to those `agy acp` accepts.
pub fn acp_flags(flags: &[String]) -> Vec<String> {
    let mut kept = Vec::new();
    let mut index = 0;
    while index < flags.len() {
        let arg = &flags[index];
        let name = arg.split('=').next().unwrap_or("");
        if !ACP_KEPT_FLAGS.contains(&name) {
            // Skip value of single-arg non-ACP flags like --model foo.
            if matches!(
                name,
                "--model" | "--mode" | "--effort" | "--settings" | "--project"
            ) && !arg.contains('=')
            {
                index += 2;
                continue;
            }
            index += 1;
            continue;
        }
        kept.push(arg.clone());
        if matches!(name, "--add-dir" | "--agent")
            && !arg.contains('=')
            && let Some(value) = flags.get(index + 1)
        {
            kept.push(value.clone());
            index += 2;
            continue;
        }
        index += 1;
    }
    kept
}

/// Arguments for `agy acp --stdio`.
pub fn headless_agy_args(flags: &[String]) -> Vec<String> {
    let mut args = vec!["acp".to_owned(), "--stdio".to_owned()];
    args.extend(acp_flags(flags));
    args
}

/// What the pane holder starts for an AGY conversation session.
pub fn holder_start_command(options: &StartOptions) -> HolderStartCommand {
    let profile = options.profile.as_ref();
    let mut argv = vec![
        profile
            .map(|p| p.program.clone())
            .unwrap_or_else(|| "agy".to_owned()),
    ];
    argv.extend(headless_agy_args(options.flags.as_deref().unwrap_or(&[])));
    let mut set = Obj::new();
    if let Some(pane) = options.pane_id.as_deref().filter(|p| !p.is_empty()) {
        set.insert("HERDR_PANE_ID".into(), Value::String(pane.to_owned()));
    }
    if !options.session_id.is_empty() {
        set.insert(
            "ROAMGATE_AGY_SESSION".into(),
            Value::String(options.session_id.clone()),
        );
    }
    if let Some(profile) = profile {
        for (key, value) in &profile.env {
            set.insert(key.clone(), Value::String(value.clone()));
        }
    }
    let mut command = obj! {
        "argv" => argv.into_iter().map(Value::String).collect::<Vec<_>>(),
        "cwd" => options.cwd.as_str(),
    };
    if !set.is_empty() {
        command.insert("set".into(), Value::Object(set));
    }
    if let Some(profile) = profile
        && !profile.unset.is_empty()
    {
        command.insert(
            "unset".into(),
            Value::Array(profile.unset.iter().cloned().map(Value::String).collect()),
        );
    }
    command
}

fn line(value: Value) -> String {
    js::stringify(&value)
}

fn id_text(value: Option<&Value>) -> String {
    match value {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Number(n)) => n.to_string(),
        _ => String::new(),
    }
}

fn extract_content_text(value: Option<&Value>) -> String {
    match value {
        Some(Value::String(text)) => text.clone(),
        Some(Value::Object(map)) => {
            if let Some(text) = map.get("text").and_then(Value::as_str) {
                return text.to_owned();
            }
            if let Some(content) = map.get("content") {
                return extract_content_text(Some(content));
            }
            String::new()
        }
        Some(Value::Array(items)) => items
            .iter()
            .map(|item| extract_content_text(Some(item)))
            .filter(|text| !text.is_empty())
            .collect::<Vec<_>>()
            .join("\n"),
        _ => String::new(),
    }
}

fn prompt_blocks(message: &DriverMessage) -> Vec<Value> {
    let mut parts = Vec::new();
    for prelude in &message.prelude {
        if !prelude.is_empty() {
            parts.push(json!({"type": "text", "text": prelude}));
        }
    }
    if !message.text.is_empty() {
        parts.push(json!({"type": "text", "text": message.text}));
    }
    for image in &message.images {
        if let (Some(media_type), Some(data)) = (&image.media_type, &image.data) {
            parts.push(json!({
                "type": "image",
                "mimeType": media_type,
                "data": data,
            }));
        } else if !image.path.is_empty() {
            parts.push(json!({
                "type": "text",
                "text": format!("[Image attached: {}]", image.path),
            }));
        }
    }
    if parts.is_empty() {
        parts.push(json!({"type": "text", "text": ""}));
    }
    parts
}

#[derive(Clone, Debug, Default)]
struct PendingPrompt {
    uuid: String,
    text: String,
    images: usize,
    blocks: Vec<Value>,
}

/// Stateful ACP JSON-RPC 2.0 codec for `agy acp --stdio`.
#[derive(Clone, Debug, Default)]
pub struct AgyAcpCodec {
    initialized: bool,
    session_ready: bool,
    session_id: String,
    cwd: String,
    next_prompt_seq: u64,
    active_prompt_id: Option<String>,
    /// The prompt the agent has, until it answers: its id, text and
    /// image count.
    pending_user_replay: Option<(String, String, usize)>,
    pending_interrupt_id: Option<String>,
    pending_prompts: Vec<PendingPrompt>,
    pending_out: Vec<String>,
    message_id: String,
    block_index: u64,
    text_open: bool,
    text_buf: String,
    current_model: Option<String>,
    available_models: Vec<Value>,
    current_mode: Option<String>,
    context_used: Option<u64>,
    context_size: Option<u64>,
}

impl AgyAcpCodec {
    fn encode_prompt(&mut self, prompt: PendingPrompt) -> String {
        self.next_prompt_seq += 1;
        let req_id = format!("roamgate-acp-prompt-{}", self.next_prompt_seq);
        self.active_prompt_id = Some(req_id.clone());
        self.pending_user_replay = Some((prompt.uuid.clone(), prompt.text, prompt.images));
        self.message_id = format!("agy-msg-{}", self.next_prompt_seq);
        self.block_index = 0;
        self.text_open = false;
        self.text_buf.clear();
        line(json!({
            "jsonrpc": "2.0",
            "id": req_id,
            "method": "session/prompt",
            "params": {
                "sessionId": self.session_id,
                "prompt": prompt.blocks,
                "_meta": { "roamgate_uuid": prompt.uuid },
            },
        }))
    }

    fn take_user_replay(&mut self, events: &mut Vec<DriverEvent>) {
        if let Some((uuid, text, images)) = self.pending_user_replay.take() {
            events.push(obj! {
                "kind" => "user_replay",
                "uuid" => uuid,
                "text" => text,
                "images" => images as f64,
            });
        }
    }

    fn flush_buffered_prompts(&mut self) {
        if !self.session_ready || self.active_prompt_id.is_some() {
            return;
        }
        if !self.pending_prompts.is_empty() {
            let next = self.pending_prompts.remove(0);
            let encoded = self.encode_prompt(next);
            self.pending_out.push(encoded);
        }
    }

    fn close_text_block(&mut self, events: &mut Vec<DriverEvent>) {
        if self.text_open {
            self.text_open = false;
            events.push(obj! {
                "kind" => "block_stop",
                "message_id" => self.message_id.as_str(),
                "index" => self.block_index as f64,
            });
            self.block_index += 1;
        }
    }

    fn parse_models_from_result(&mut self, result: &Obj) -> Option<String> {
        let models = result.get("models").and_then(Value::as_object)?;
        if let Some(available) = models.get("availableModels").and_then(Value::as_array) {
            self.available_models = available
                .iter()
                .filter_map(|row| {
                    let row = row.as_object()?;
                    let id = row
                        .get("modelId")
                        .or_else(|| row.get("id"))
                        .and_then(Value::as_str)?;
                    let label = row
                        .get("name")
                        .or_else(|| row.get("displayName"))
                        .and_then(Value::as_str)
                        .unwrap_or(id);
                    Some(Value::Object(obj! {
                        "value" => id,
                        "label" => label,
                        "description" => row.get("description").and_then(Value::as_str),
                    }))
                })
                .collect();
        }
        let current = models
            .get("currentModelId")
            .and_then(Value::as_str)
            .filter(|m| !m.is_empty())
            .map(str::to_owned);
        if current.is_some() {
            self.current_model = current.clone();
        }
        current
    }

    fn handle_session_ready(&mut self, result: &Obj) -> Vec<DriverEvent> {
        if let Some(id) = result
            .get("sessionId")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
        {
            self.session_id = id.to_owned();
        }
        let model = self.parse_models_from_result(result);
        if let Some(mode) = result
            .get("modes")
            .and_then(|m| m.get("currentModeId"))
            .and_then(Value::as_str)
            .filter(|m| !m.is_empty())
        {
            self.current_mode = Some(mode.to_owned());
        }
        self.session_ready = true;
        self.flush_buffered_prompts();
        let mut init = obj! {
            "kind" => "init",
            "session_id" => self.session_id.as_str(),
            "cwd" => self.cwd.as_str(),
        };
        if let Some(model) = model {
            init.insert("model".into(), Value::String(model));
        }
        vec![init]
    }

    fn handle_update(&mut self, update: &Obj) -> Vec<DriverEvent> {
        let kind = js::sv(update.get("sessionUpdate"));
        let mut events = Vec::new();
        self.take_user_replay(&mut events);
        if self.message_id.is_empty() {
            self.next_prompt_seq += 1;
            self.message_id = format!("agy-msg-{}", self.next_prompt_seq);
        }
        match kind {
            "agent_message_chunk" => {
                let text = extract_content_text(update.get("content"));
                if text.is_empty() {
                    return events;
                }
                if !self.text_open {
                    self.text_open = true;
                    events.push(obj! {
                        "kind" => "block_start",
                        "message_id" => self.message_id.as_str(),
                        "index" => self.block_index as f64,
                        "block" => "text",
                    });
                }
                self.text_buf.push_str(&text);
                events.push(obj! {
                    "kind" => "delta",
                    "message_id" => self.message_id.as_str(),
                    "index" => self.block_index as f64,
                    "text" => text,
                });
            }
            "agent_thought_chunk" => {
                let text = extract_content_text(update.get("content"));
                if !text.is_empty() {
                    events.push(obj! {
                        "kind" => "thinking",
                        "tokens" => (text.len() / 4).max(1) as f64,
                    });
                }
            }
            "tool_call" => {
                self.close_text_block(&mut events);
                let tool_id = js::sv(update.get("toolCallId"));
                let tool_id = if tool_id.is_empty() {
                    format!("agy-tool-{}", self.block_index)
                } else {
                    tool_id.to_owned()
                };
                let name = update
                    .get("name")
                    .or_else(|| update.get("title"))
                    .or_else(|| update.get("kind"))
                    .and_then(Value::as_str)
                    .filter(|s| !s.is_empty())
                    .unwrap_or("tool");
                let input = update
                    .get("args")
                    .or_else(|| update.get("rawInput"))
                    .or_else(|| update.get("input"))
                    .cloned()
                    .unwrap_or_else(|| json!({}));
                let idx = self.block_index as f64;
                self.block_index += 1;
                events.push(obj! {
                    "kind" => "block_start",
                    "message_id" => self.message_id.as_str(),
                    "index" => idx,
                    "block" => "tool_use",
                    "tool_use_id" => tool_id.as_str(),
                    "name" => name,
                });
                events.push(obj! {
                    "kind" => "tool_use",
                    "message_id" => self.message_id.as_str(),
                    "index" => idx,
                    "tool_use_id" => tool_id,
                    "name" => name,
                    "input" => input,
                });
            }
            "tool_call_update" => {
                let status = js::sv(update.get("status"));
                if matches!(status, "completed" | "failed" | "error") {
                    let tool_id = js::sv(update.get("toolCallId"));
                    let text = extract_content_text(update.get("content"))
                        .trim()
                        .to_owned();
                    let text = if text.is_empty() {
                        update
                            .get("rawOutput")
                            .map(|v| {
                                v.as_str()
                                    .map(str::to_owned)
                                    .unwrap_or_else(|| js::stringify(v))
                            })
                            .unwrap_or_default()
                    } else {
                        text
                    };
                    events.push(obj! {
                        "kind" => "tool_result",
                        "tool_use_id" => tool_id,
                        "is_error" => status == "failed" || status == "error",
                        "text" => text,
                    });
                }
            }
            "usage_update" => {
                if let (Some(used), Some(size)) = (
                    update.get("used").and_then(Value::as_u64),
                    update.get("size").and_then(Value::as_u64),
                ) {
                    self.context_used = Some(used);
                    self.context_size = Some(size);
                    events.push(obj! {
                        "kind" => "context_usage",
                        "used" => used as f64,
                        "size" => size as f64,
                    });
                }
            }
            "config_option_update" | "current_mode_update" => {
                if let Some(model) = update
                    .get("currentModelId")
                    .or_else(|| update.get("modelId"))
                    .and_then(Value::as_str)
                    .filter(|s| !s.is_empty())
                {
                    self.current_model = Some(model.to_owned());
                    events.push(obj! {"kind" => "model", "model" => model});
                }
            }
            _ => {}
        }
        events
    }

    fn handle_permission_request(&self, raw_id: &Value, params: &Obj) -> Vec<DriverEvent> {
        let request_id = id_text(Some(raw_id));
        let tool_call = params.get("toolCall").and_then(Value::as_object);
        let tool_name = tool_call
            .and_then(|tc| tc.get("title").or_else(|| tc.get("kind")))
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
            .unwrap_or("tool");
        let input = tool_call
            .and_then(|tc| tc.get("rawInput").or_else(|| tc.get("input")))
            .cloned()
            .unwrap_or_else(|| json!({}));
        let options = params
            .get("options")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let allow_always: Vec<Value> = options
            .iter()
            .filter(|opt| opt.get("kind").and_then(Value::as_str) == Some("allow_always"))
            .cloned()
            .collect();
        vec![obj! {
            "kind" => "permission_request",
            "request_id" => request_id,
            "acp_id" => raw_id.clone(),
            "tool_name" => tool_name,
            "input" => input,
            "tool_use_id" => tool_call.and_then(|tc| tc.get("toolCallId")).and_then(Value::as_str),
            "options" => options,
            "suggestions" => allow_always,
            "requires_user_interaction" => false,
        }]
    }
}

impl DriverCodec for AgyAcpCodec {
    fn on_start(&mut self, session_id: &str, cwd: &str) -> Vec<String> {
        self.session_id = session_id.to_owned();
        self.cwd = cwd.to_owned();
        self.initialized = false;
        self.session_ready = false;
        vec![line(json!({
            "jsonrpc": "2.0",
            "id": INIT_REQUEST_ID,
            "method": "initialize",
            "params": {
                "protocolVersion": 1,
                "clientCapabilities": {},
            },
        }))]
    }

    fn pending_writes(&mut self) -> Vec<String> {
        std::mem::take(&mut self.pending_out)
    }

    fn line(&mut self, text: &str) -> Vec<DriverEvent> {
        let Some(Value::Object(msg)) = js::parse(text) else {
            return Vec::new();
        };
        let method = msg.get("method").and_then(Value::as_str);
        let raw_id = msg.get("id");

        // 1. Server -> client notification (method, no id)
        if let (Some(method), None) = (method, raw_id) {
            if method == "session/update"
                && let Some(update) = msg
                    .get("params")
                    .and_then(|p| p.get("update"))
                    .and_then(Value::as_object)
            {
                return self.handle_update(update);
            }
            return Vec::new();
        }

        // 2. Server -> client request (method + id)
        if let (Some(method), Some(raw_id)) = (method, raw_id) {
            if method == "session/request_permission" {
                let empty = Obj::new();
                let params = msg
                    .get("params")
                    .and_then(Value::as_object)
                    .unwrap_or(&empty);
                return self.handle_permission_request(raw_id, params);
            }
            return Vec::new();
        }

        // 3. Server -> client response (id, result/error)
        let req_id = id_text(raw_id);
        if req_id.is_empty() {
            return Vec::new();
        }
        let error = msg.get("error").and_then(Value::as_object);
        let result = msg.get("result").and_then(Value::as_object);

        if req_id == INIT_REQUEST_ID {
            self.initialized = true;
            if !self.session_id.is_empty() && self.session_id != UNNAMED_SESSION_ID {
                self.pending_out.push(line(json!({
                    "jsonrpc": "2.0",
                    "id": RESUME_REQUEST_ID,
                    "method": "session/resume",
                    "params": {
                        "sessionId": self.session_id,
                        "cwd": self.cwd,
                        "mcpServers": [],
                    },
                })));
            } else {
                self.pending_out.push(line(json!({
                    "jsonrpc": "2.0",
                    "id": NEW_REQUEST_ID,
                    "method": "session/new",
                    "params": {
                        "cwd": self.cwd,
                        "mcpServers": [],
                    },
                })));
            }
            return Vec::new();
        }

        if req_id == RESUME_REQUEST_ID {
            if error.is_some() {
                // Unknown or unresumable session: fall back to a fresh AGY session.
                self.pending_out.push(line(json!({
                    "jsonrpc": "2.0",
                    "id": NEW_REQUEST_ID,
                    "method": "session/new",
                    "params": {
                        "cwd": self.cwd,
                        "mcpServers": [],
                    },
                })));
                return Vec::new();
            }
            if let Some(res) = result {
                return self.handle_session_ready(res);
            }
            return Vec::new();
        }

        if req_id == NEW_REQUEST_ID {
            if let Some(res) = result {
                return self.handle_session_ready(res);
            }
            return Vec::new();
        }

        if self.active_prompt_id.as_deref() == Some(req_id.as_str()) {
            let mut events = Vec::new();
            self.take_user_replay(&mut events);
            self.close_text_block(&mut events);
            self.active_prompt_id = None;
            if let Some(interrupt_id) = self.pending_interrupt_id.take() {
                events.push(obj! {
                    "kind" => "control_response",
                    "request_id" => interrupt_id,
                    "error" => Value::Null,
                    "response" => obj! {},
                });
            }
            let (subtype, is_error, interrupted, err_text) = if let Some(err) = error {
                let message = js::sv(err.get("message")).to_owned();
                ("error", true, false, message)
            } else {
                let stop_reason = result
                    .and_then(|r| r.get("stopReason"))
                    .and_then(Value::as_str)
                    .unwrap_or("end_turn");
                let cancelled = stop_reason == "cancelled";
                (
                    if cancelled { "interrupted" } else { "success" },
                    false,
                    cancelled,
                    String::new(),
                )
            };
            let result_text = if !err_text.is_empty() {
                err_text
            } else {
                std::mem::take(&mut self.text_buf)
            };
            events.push(obj! {
                "kind" => "result",
                "subtype" => subtype,
                "is_error" => is_error,
                "text" => result_text,
                "interrupted" => interrupted,
                "session_id" => self.session_id.as_str(),
            });
            self.flush_buffered_prompts();
            return events;
        }

        // Control request responses (e.g. session/set_model).
        let err_msg = error.map(|err| {
            let m = js::sv(err.get("message"));
            if m.is_empty() {
                "ACP error".to_owned()
            } else {
                m.to_owned()
            }
        });
        let resp = result.cloned();
        if err_msg.is_none()
            && let Some(model) = resp
                .as_ref()
                .and_then(|r| r.get("modelId").or_else(|| r.get("model")))
                .and_then(Value::as_str)
        {
            self.current_model = Some(model.to_owned());
        }
        vec![obj! {
            "kind" => "control_response",
            "request_id" => req_id,
            "error" => err_msg,
            "response" => resp,
        }]
    }

    fn save(&self) -> Value {
        json!({
            "initialized": self.initialized,
            "session_ready": self.session_ready,
            "session_id": self.session_id,
            "cwd": self.cwd,
            "next_prompt_seq": self.next_prompt_seq,
            "active_prompt_id": self.active_prompt_id,
            "message_id": self.message_id,
            "block_index": self.block_index,
            "text_open": self.text_open,
            "current_model": self.current_model,
            "available_models": self.available_models,
            "current_mode": self.current_mode,
            "context_used": self.context_used,
            "context_size": self.context_size,
        })
    }

    fn restore(&mut self, state: &Value) {
        let Some(state) = state.as_object() else {
            return;
        };
        self.initialized = state
            .get("initialized")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        self.session_ready = state
            .get("session_ready")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        self.session_id = js::sv(state.get("session_id")).to_owned();
        self.cwd = js::sv(state.get("cwd")).to_owned();
        self.next_prompt_seq = state
            .get("next_prompt_seq")
            .and_then(Value::as_u64)
            .unwrap_or(0);
        self.active_prompt_id = state
            .get("active_prompt_id")
            .and_then(Value::as_str)
            .map(str::to_owned);
        self.message_id = js::sv(state.get("message_id")).to_owned();
        self.block_index = state
            .get("block_index")
            .and_then(Value::as_u64)
            .unwrap_or(0);
        self.text_open = state
            .get("text_open")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        self.current_model = state
            .get("current_model")
            .and_then(Value::as_str)
            .map(str::to_owned);
        self.available_models = state
            .get("available_models")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        self.current_mode = state
            .get("current_mode")
            .and_then(Value::as_str)
            .map(str::to_owned);
        self.context_used = state.get("context_used").and_then(Value::as_u64);
        self.context_size = state.get("context_size").and_then(Value::as_u64);
    }

    fn message(&mut self, message: &DriverMessage) -> Vec<String> {
        let pending = PendingPrompt {
            uuid: message.uuid.clone(),
            text: message.text.clone(),
            images: message.images.len(),
            blocks: prompt_blocks(message),
        };
        if !self.session_ready || self.active_prompt_id.is_some() {
            self.pending_prompts.push(pending);
            return Vec::new();
        }
        vec![self.encode_prompt(pending)]
    }

    fn interrupt(&mut self, request_id: &str) -> Vec<String> {
        self.pending_interrupt_id = Some(request_id.to_owned());
        vec![line(json!({
            "jsonrpc": "2.0",
            "method": "session/cancel",
            "params": {
                "sessionId": self.session_id,
            },
        }))]
    }

    fn answer(&mut self, request: &DriverEvent, answer: Option<&Value>) -> Vec<String> {
        let acp_id = request
            .get("acp_id")
            .cloned()
            .unwrap_or_else(|| request.get("request_id").cloned().unwrap_or(Value::Null));
        let options = request
            .get("options")
            .and_then(Value::as_array)
            .map(Vec::as_slice)
            .unwrap_or(&[]);
        let find_option = |kinds: &[&str]| -> Option<String> {
            for kind in kinds {
                if let Some(id) = options.iter().find_map(|opt| {
                    let opt = opt.as_object()?;
                    (opt.get("kind").and_then(Value::as_str) == Some(*kind))
                        .then(|| opt.get("optionId").and_then(Value::as_str))
                        .flatten()
                        .map(str::to_owned)
                }) {
                    return Some(id);
                }
            }
            None
        };
        let word = answer.and_then(Value::as_str);
        let outcome = match word {
            Some("allow") => match find_option(&["allow_once", "allow_always"]) {
                Some(option_id) => json!({"outcome": "selected", "optionId": option_id}),
                None => json!({"outcome": "cancelled"}),
            },
            Some("always") => match find_option(&["allow_always", "allow_once"]) {
                Some(option_id) => json!({"outcome": "selected", "optionId": option_id}),
                None => json!({"outcome": "cancelled"}),
            },
            Some("deny") => match find_option(&["reject_once", "reject_always"]) {
                Some(option_id) => json!({"outcome": "selected", "optionId": option_id}),
                None => json!({"outcome": "cancelled"}),
            },
            _ => json!({"outcome": "cancelled"}),
        };
        vec![line(json!({
            "jsonrpc": "2.0",
            "id": acp_id,
            "result": {
                "outcome": outcome,
            },
        }))]
    }

    fn request(&mut self, kind: &str, params: &Object, request_id: &str) -> Option<Vec<String>> {
        match kind {
            "set_model" => {
                let model = params.get("model").and_then(Value::as_str)?;
                Some(vec![line(json!({
                    "jsonrpc": "2.0",
                    "id": request_id,
                    "method": "session/set_model",
                    "params": {
                        "sessionId": self.session_id,
                        "modelId": model,
                    },
                }))])
            }
            "set_mode" => {
                let mode = params.get("mode").and_then(Value::as_str)?;
                self.current_mode = Some(mode.to_owned());
                Some(vec![line(json!({
                    "jsonrpc": "2.0",
                    "id": request_id,
                    "method": "session/set_mode",
                    "params": {
                        "sessionId": self.session_id,
                        "modeId": mode,
                    },
                }))])
            }
            _ => None,
        }
    }
}

/// AGY model switching via ACP `session/set_model`.
pub struct AgyModels;

impl ModelDriver for AgyModels {
    fn list<'a>(&'a self, _context: &'a dyn ModelContext) -> BoxFuture<'a, Option<Vec<Value>>> {
        Box::pin(async { None })
    }

    fn set<'a>(&'a self, context: &'a dyn ModelContext, model: &'a str) -> BoxFuture<'a, ModelSet> {
        Box::pin(async move {
            let mut params = Object::new();
            params.insert("model".into(), Value::String(model.to_owned()));
            let Some(answer) = context.control("set_model", params).await else {
                return Err("AGY did not answer in time".to_owned());
            };
            if let Some(error) = answer.error.as_deref().filter(|e| !e.is_empty()) {
                return Err(error.to_owned());
            }
            let resolved = answer
                .response
                .as_ref()
                .and_then(|r| r.get("modelId").or_else(|| r.get("model")))
                .and_then(Value::as_str)
                .map(str::to_owned)
                .or_else(|| Some(model.to_owned()));
            Ok(resolved)
        })
    }
}

/// Antigravity CLI headless protocol driver (`agy acp --stdio`).
pub struct AgyProtocolDriver;

impl ProtocolDriver for AgyProtocolDriver {
    fn agent(&self) -> &str {
        "agy"
    }

    fn display_name(&self) -> &str {
        "AGY"
    }

    fn capabilities(&self) -> Value {
        agy_capabilities()
    }

    fn start_command(&self, options: &StartOptions) -> HolderStartCommand {
        holder_start_command(options)
    }

    fn create_codec(&self) -> Box<dyn DriverCodec> {
        Box::new(AgyAcpCodec::default())
    }

    fn prompt_of(&self, request: &DriverEvent) -> DriverPrompt {
        let suggestions = request
            .get("suggestions")
            .and_then(Value::as_array)
            .map_or(0, Vec::len);
        DriverPrompt {
            tool: js::sv(request.get("tool_name")).to_owned(),
            input: request.get("input").cloned().unwrap_or(Value::Null),
            can_always: suggestions > 0,
            questions: None,
        }
    }

    fn input_kind(&self, text: &str) -> InputKind {
        let other = InputKind {
            kind: "other".into(),
            request_id: None,
        };
        let Some(Value::Object(value)) = js::parse(text) else {
            return other;
        };
        match value.get("method").and_then(Value::as_str) {
            Some("session/prompt") => InputKind {
                kind: "user".into(),
                request_id: None,
            },
            Some("session/cancel" | "session/set_model" | "session/set_mode") => InputKind {
                kind: "control_request".into(),
                request_id: None,
            },
            None if value.contains_key("result") && value.contains_key("id") => InputKind {
                kind: "acp_response".into(),
                request_id: Some(id_text(value.get("id"))),
            },
            _ => other,
        }
    }

    fn answer_kind(&self) -> &str {
        "acp_response"
    }

    fn parse_written_message(&self, text: &str) -> Option<WrittenMessage> {
        let value = js::parse(text)?;
        if value.get("method").and_then(Value::as_str) != Some("session/prompt") {
            return None;
        }
        let params = value.get("params")?.as_object()?;
        let prompt = params.get("prompt")?.as_array()?;
        let content = prompt
            .iter()
            .filter_map(|block| {
                let block = block.as_object()?;
                (js::sv(block.get("type")) == "text")
                    .then(|| block.get("text").and_then(Value::as_str))
                    .flatten()
            })
            .collect::<Vec<_>>()
            .join("\n");
        let uuid = params
            .get("_meta")
            .and_then(|m| m.get("roamgate_uuid"))
            .and_then(Value::as_str)
            .map(str::to_owned);
        Some(WrittenMessage {
            uuid,
            text: content,
        })
    }

    fn models(&self) -> Option<&dyn ModelDriver> {
        Some(&AgyModels)
    }

    /// ACP's `session/new` names the session.
    fn new_session_id(&self) -> String {
        UNNAMED_SESSION_ID.to_owned()
    }

    fn command<'a>(
        &'a self,
        text: &'a str,
        context: &'a dyn CommandContext,
    ) -> Option<BoxFuture<'a, CommandNotice>> {
        crate::commands::command(text, context)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn handshake_resumes_and_flushes_buffered_prompt() {
        let mut codec = AgyAcpCodec::default();
        let start = codec.on_start("conv-123", "/work/repo");
        assert_eq!(start.len(), 1);
        assert!(start[0].contains("\"method\":\"initialize\""));

        // Prompt written before session/resume completes is buffered.
        let early = codec.message(&DriverMessage {
            text: "Continue task".into(),
            uuid: "u-1".into(),
            ..Default::default()
        });
        assert!(early.is_empty());

        // Initialize response queues session/resume.
        let events = codec
            .line(r#"{"jsonrpc":"2.0","id":"roamgate-acp-init","result":{"protocolVersion":1}}"#);
        assert!(events.is_empty());
        let pending = codec.pending_writes();
        assert_eq!(pending.len(), 1);
        assert!(pending[0].contains("\"method\":\"session/resume\""));
        assert!(pending[0].contains("\"sessionId\":\"conv-123\""));

        // Resume response emits init and flushes the buffered prompt.
        let events = codec.line(r#"{"jsonrpc":"2.0","id":"roamgate-acp-resume","result":{"sessionId":"conv-123","models":{"currentModelId":"gemini-3-pro","availableModels":[{"modelId":"gemini-3-pro","name":"Gemini 3 Pro"}]}}}"#);
        assert_eq!(events.len(), 1);
        assert_eq!(events[0]["kind"], "init");
        assert_eq!(events[0]["session_id"], "conv-123");
        assert_eq!(events[0]["model"], "gemini-3-pro");

        let flushed = codec.pending_writes();
        assert_eq!(flushed.len(), 1);
        assert!(flushed[0].contains("\"method\":\"session/prompt\""));
        assert!(flushed[0].contains("Continue task"));
    }

    #[test]
    fn resume_error_falls_back_to_session_new() {
        let mut codec = AgyAcpCodec::default();
        codec.on_start("missing-session", "/work/repo");
        codec.line(r#"{"jsonrpc":"2.0","id":"roamgate-acp-init","result":{"protocolVersion":1}}"#);
        let _ = codec.pending_writes();

        codec.line(r#"{"jsonrpc":"2.0","id":"roamgate-acp-resume","error":{"code":-32000,"message":"not found"}}"#);
        let pending = codec.pending_writes();
        assert_eq!(pending.len(), 1);
        assert!(pending[0].contains("\"method\":\"session/new\""));

        let events = codec.line(
            r#"{"jsonrpc":"2.0","id":"roamgate-acp-new","result":{"sessionId":"fresh-456"}}"#,
        );
        assert_eq!(events[0]["kind"], "init");
        assert_eq!(events[0]["session_id"], "fresh-456");
    }

    #[test]
    fn streams_chunks_tools_permissions_and_result() {
        let mut codec = AgyAcpCodec::default();
        codec.on_start("", "/work");
        codec.line(r#"{"jsonrpc":"2.0","id":"roamgate-acp-init","result":{"protocolVersion":1}}"#);
        let _ = codec.pending_writes();
        codec.line(r#"{"jsonrpc":"2.0","id":"roamgate-acp-new","result":{"sessionId":"s-1"}}"#);
        let _ = codec.pending_writes();

        let sent = codec.message(&DriverMessage {
            text: "Fix bug".into(),
            uuid: "u-2".into(),
            ..Default::default()
        });
        assert_eq!(sent.len(), 1);
        let parsed_back = AgyProtocolDriver.parse_written_message(&sent[0]).unwrap();
        assert_eq!(parsed_back.text, "Fix bug");
        assert_eq!(parsed_back.uuid.as_deref(), Some("u-2"));

        // Text streaming (first update settles the outbox via user_replay)
        let ev1 = codec.line(r#"{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"s-1","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"Working "}}}}"#);
        assert_eq!(ev1.len(), 3);
        assert_eq!(ev1[0]["kind"], "user_replay");
        assert_eq!(ev1[0]["uuid"], "u-2");
        assert_eq!(ev1[0]["text"], "Fix bug");
        assert_eq!(ev1[1]["kind"], "block_start");
        assert_eq!(ev1[2]["kind"], "delta");
        assert_eq!(ev1[2]["text"], "Working ");

        // Tool call closes text block and starts tool
        let ev2 = codec.line(r#"{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"s-1","update":{"sessionUpdate":"tool_call","toolCallId":"tc-1","title":"run_command","rawInput":{"cmd":"cargo test"}}}}"#);
        assert_eq!(ev2[0]["kind"], "block_stop");
        assert_eq!(ev2[1]["kind"], "block_start");
        assert_eq!(ev2[2]["kind"], "tool_use");
        assert_eq!(ev2[2]["tool_use_id"], "tc-1");

        // Permission request
        let perm = codec.line(r#"{"jsonrpc":"2.0","id":7,"method":"session/request_permission","params":{"sessionId":"s-1","toolCall":{"toolCallId":"tc-1","title":"run_command","rawInput":{"cmd":"cargo test"}},"options":[{"optionId":"opt-once","name":"Allow once","kind":"allow_once"},{"optionId":"opt-always","name":"Always allow","kind":"allow_always"},{"optionId":"opt-deny","name":"Deny","kind":"reject_once"}]}}"#);
        assert_eq!(perm.len(), 1);
        assert_eq!(perm[0]["kind"], "permission_request");
        let prompt = AgyProtocolDriver.prompt_of(&perm[0]);
        assert_eq!(prompt.tool, "run_command");
        assert!(prompt.can_always);

        let reply = codec.answer(&perm[0], Some(&json!("allow")));
        assert_eq!(reply.len(), 1);
        let reply_json: Value = serde_json::from_str(&reply[0]).unwrap();
        assert_eq!(reply_json["id"], 7);
        assert_eq!(reply_json["result"]["outcome"]["optionId"], "opt-once");
        assert_eq!(AgyProtocolDriver.input_kind(&reply[0]).kind, "acp_response");

        // Tool completion
        let ev3 = codec.line(r#"{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"s-1","update":{"sessionUpdate":"tool_call_update","toolCallId":"tc-1","status":"completed","rawOutput":"ok"}}}"#);
        assert_eq!(ev3.len(), 1);
        assert_eq!(ev3[0]["kind"], "tool_result");
        assert_eq!(ev3[0]["text"], "ok");

        // Final prompt result
        let res = codec.line(
            r#"{"jsonrpc":"2.0","id":"roamgate-acp-prompt-1","result":{"stopReason":"end_turn"}}"#,
        );
        assert_eq!(res.len(), 1);
        assert_eq!(res[0]["kind"], "result");
        assert_eq!(res[0]["subtype"], "success");
        assert_eq!(res[0]["text"], "Working ");
    }

    #[test]
    fn save_and_restore_preserves_acp_state() {
        let mut codec = AgyAcpCodec::default();
        codec.on_start("s-restore", "/tmp");
        codec.line(r#"{"jsonrpc":"2.0","id":"roamgate-acp-init","result":{"protocolVersion":1}}"#);
        let _ = codec.pending_writes();
        codec.line(
            r#"{"jsonrpc":"2.0","id":"roamgate-acp-resume","result":{"sessionId":"s-restore"}}"#,
        );
        let saved = codec.save();

        let mut restored = AgyAcpCodec::default();
        restored.restore(&saved);
        let sent = restored.message(&DriverMessage {
            text: "After restart".into(),
            uuid: "u-3".into(),
            ..Default::default()
        });
        assert_eq!(sent.len(), 1);
        assert!(sent[0].contains("\"sessionId\":\"s-restore\""));
    }
}
