//! Claude Code headless (`drivers/claude.ts`): `claude -p` over
//! stream-json for one session, partial messages, the user's own messages
//! echoed back once accepted, and permissions asked over stdio.

use roamgate_agents::js::{self, Obj};
use roamgate_agents::obj;
use roamgate_conversation::driver::{
    DriverCodec, DriverEvent, DriverMessage, DriverPrompt, HolderStartCommand, InputKind,
    McpDriver, ModelDriver, ProtocolDriver, RewindDriver, StartOptions, WrittenMessage,
};
use serde_json::{Value, json};

use super::env::holder_env_changes;
use super::mcp::ClaudeMcp;
use super::models::ClaudeModels;
use super::rewind::ClaudeRewind;
use super::stream::StreamParser;

/// What the agent is told of a question the user dismissed
/// (`shared/review.ts`).
pub const DISMISSED_QUESTION_MESSAGE: &str = "The user dismissed this question without answering.";
/// What the agent is told of a permission the user dismissed.
pub const DISMISSED_PERMISSION_MESSAGE: &str = "The user dismissed this request without answering.";

/// Claude's conversation capabilities (`CLAUDE_CAPABILITIES`).
pub fn claude_capabilities() -> Value {
    json!({
        "steer": true,
        "questions": true,
        "alwaysAllow": true,
        "rewind": {"conversation": true, "code": true},
        "promptSuggestions": true,
        "shellLines": "prelude",
        "backgroundTasks": true,
        "images": "base64",
        "slashCommands": "claude",
        "models": true,
        "mcp": true,
        "backgroundTools": true,
    })
}

/// The long-lived headless claude for one session (`headlessClaudeArgs`):
/// the pane's claude's own kept flags first. The user's hooks stay on.
/// Prompt suggestions are asked for: Claude Code still sends none when the
/// user turned them off.
pub fn headless_claude_args(session_id: &str, flags: &[String]) -> Vec<String> {
    let mut args = headless_flags(flags);
    args.extend(
        [
            "-p",
            "--resume",
            session_id,
            "--input-format",
            "stream-json",
            "--output-format",
            "stream-json",
            "--include-partial-messages",
            "--verbose",
            "--replay-user-messages",
            "--permission-prompt-tool",
            "stdio",
            "--prompt-suggestions",
            "true",
        ]
        .iter()
        .map(|arg| (*arg).to_owned()),
    );
    args
}

/// What the headless run sets itself, or has no use for.
const NOT_HEADLESS: [&str; 2] = ["--ide", "--verbose"];

/// The flags the pane's claude ran with (already only the kept ones) that
/// its headless run takes too: the model, the permission mode, the
/// directories and MCP configs the user gave it.
pub fn headless_flags(flags: &[String]) -> Vec<String> {
    flags
        .iter()
        .filter(|flag| {
            let name = flag.split('=').next().unwrap_or("");
            !NOT_HEADLESS.contains(&name)
        })
        .cloned()
        .collect()
}

/// What the pane holder is asked to run (`holderStartCommand`): claude
/// resuming the session, in its directory, with the headless environment.
pub fn holder_start_command(options: &StartOptions) -> HolderStartCommand {
    let env = holder_env_changes(options.api_key_answer, options.pane_id.as_deref());
    let profile = options.profile.as_ref();
    let mut argv = vec![
        profile
            .map(|profile| profile.program.clone())
            .unwrap_or_else(|| "claude".to_owned()),
    ];
    argv.extend(headless_claude_args(
        &options.session_id,
        options.flags.as_deref().unwrap_or(&[]),
    ));
    let mut command = obj! {
        "argv" => argv.into_iter().map(Value::String).collect::<Vec<_>>(),
        "cwd" => options.cwd.as_str(),
    };
    for (key, value) in env {
        command.insert(key, value);
    }
    // A profile's environment: set after the drop, its removals after the
    // API key policy (a profile with its own token never sends the pane's
    // key).
    if let Some(profile) = profile {
        let mut set = command
            .get("set")
            .and_then(Value::as_object)
            .cloned()
            .unwrap_or_default();
        for (key, value) in &profile.env {
            set.insert(key.clone(), Value::String(value.clone()));
        }
        command.insert("set".into(), Value::Object(set));
        if !profile.unset.is_empty() {
            command.insert(
                "unset".into(),
                Value::Array(profile.unset.iter().cloned().map(Value::String).collect()),
            );
        }
    }
    command
}

fn line(value: Value) -> String {
    js::stringify(&value)
}

/// Claude's AskUserQuestion questions, as its hook passes them on
/// (`parseQuestions` of review/agent-server.ts: S19 ports it to
/// roamgate-review, which replaces this copy once it lands on rust/main).
pub fn parse_questions(value: &Value) -> Vec<Value> {
    let Some(items) = value.as_array() else {
        return Vec::new();
    };
    items
        .iter()
        .filter_map(|item| {
            let item = item.as_object()?;
            let question = item.get("question")?.as_str()?;
            let options = item.get("options")?.as_array()?;
            let options: Vec<Value> = options
                .iter()
                .filter_map(|option| {
                    let option = option.as_object();
                    let label = option?.get("label")?.as_str()?;
                    Some(Value::Object(obj! {
                        "label" => js::slice16(label, 0, Some(200)),
                        "description" => option
                            .and_then(|o| o.get("description"))
                            .and_then(Value::as_str)
                            .map(|d| js::slice16(d, 0, Some(1000))),
                    }))
                })
                .collect();
            Some(Value::Object(obj! {
                "question" => js::slice16(question, 0, Some(2000)),
                "header" => item
                    .get("header")
                    .and_then(Value::as_str)
                    .map(|h| js::slice16(h, 0, Some(40))),
                "options" => options,
                "multiSelect" => js::is_true(item.get("multiSelect")),
            }))
        })
        .collect()
}

/// Claude's AskUserQuestion is a question card, not a permission.
fn questions_of(request: &DriverEvent) -> Vec<Value> {
    if js::sv(request.get("tool_name")) != "AskUserQuestion" {
        return Vec::new();
    }
    let questions = js::rec(request.get("input"))
        .and_then(|input| input.get("questions"))
        .filter(|value| !value.is_null())
        .cloned()
        .unwrap_or_else(|| json!([]));
    parse_questions(&questions)
}

/// Claude Code's stream-json codec.
#[derive(Default)]
pub struct ClaudeCodec {
    parser: StreamParser,
}

impl DriverCodec for ClaudeCodec {
    fn line(&mut self, text: &str) -> Vec<DriverEvent> {
        self.parser.line(text)
    }

    fn save(&self) -> Value {
        self.parser.save()
    }

    fn restore(&mut self, state: &Value) {
        self.parser.restore(state);
    }

    fn message(&mut self, message: &DriverMessage) -> Vec<String> {
        let blocks: Vec<Value> = message
            .images
            .iter()
            .map(|image| {
                Value::Object(obj! {
                    "type" => "image",
                    "source" => obj! {
                        "type" => "base64",
                        "media_type" => image.media_type.clone(),
                        "data" => image.data.clone(),
                    },
                })
            })
            .collect();
        let content = if !blocks.is_empty() || !message.prelude.is_empty() {
            let mut parts: Vec<Value> = message
                .prelude
                .iter()
                .map(|each| json!({"type": "text", "text": each}))
                .collect();
            if !message.text.is_empty() {
                parts.push(json!({"type": "text", "text": message.text}));
            }
            parts.extend(blocks);
            Value::Array(parts)
        } else {
            Value::String(message.text.clone())
        };
        vec![line(json!({
            "type": "user",
            "uuid": message.uuid,
            "message": {"role": "user", "content": content},
        }))]
    }

    fn interrupt(&mut self, request_id: &str) -> Vec<String> {
        vec![line(json!({
            "type": "control_request",
            "request_id": request_id,
            "request": {"subtype": "interrupt"},
        }))]
    }

    fn answer(&mut self, request: &DriverEvent, answer: Option<&Value>) -> Vec<String> {
        let input = js::rec(request.get("input")).cloned().unwrap_or_default();
        let answer = answer.filter(|value| !value.is_null());
        let response = match answer {
            Some(Value::Object(_)) | Some(Value::Array(_)) => {
                let mut updated = input;
                match answer.and_then(|a| a.get("answers")) {
                    Some(answers) => {
                        updated.insert("answers".into(), answers.clone());
                    }
                    // `answers: undefined` is left out of the line.
                    None => {
                        updated.shift_remove("answers");
                    }
                }
                obj! {"behavior" => "allow", "updatedInput" => updated}
            }
            Some(Value::String(word)) if word == "allow" => obj! {
                "behavior" => "allow",
                "updatedInput" => request.get("input").cloned(),
            },
            Some(Value::String(word)) if word == "always" => obj! {
                "behavior" => "allow",
                "updatedInput" => request.get("input").cloned(),
                "updatedPermissions" => request.get("suggestions").cloned(),
            },
            _ => {
                let word = answer.and_then(Value::as_str);
                let message = match word {
                    Some("dismiss") if !questions_of(request).is_empty() => {
                        DISMISSED_QUESTION_MESSAGE
                    }
                    Some("dismiss") => DISMISSED_PERMISSION_MESSAGE,
                    Some("deny") => "The user said no from Roamgate",
                    _ => "Nobody answered in Roamgate in time",
                };
                obj! {"behavior" => "deny", "message" => message, "interrupt" => false}
            }
        };
        vec![line(Value::Object(obj! {
            "type" => "control_response",
            "response" => obj! {
                "subtype" => "success",
                "request_id" => request.get("request_id").cloned(),
                "response" => response,
            },
        }))]
    }

    fn request(&mut self, kind: &str, params: &Obj, request_id: &str) -> Option<Vec<String>> {
        let mut request = obj! {"subtype" => kind};
        for (key, value) in params {
            request.insert(key.clone(), value.clone());
        }
        Some(vec![line(Value::Object(obj! {
            "type" => "control_request",
            "request_id" => request_id,
            "request" => request,
        }))])
    }
}

/// Claude Code, headless: `claude -p` over stream-json.
pub struct ClaudeProtocolDriver;

impl ProtocolDriver for ClaudeProtocolDriver {
    fn agent(&self) -> &str {
        "claude"
    }

    fn display_name(&self) -> &str {
        "Claude"
    }

    fn capabilities(&self) -> Value {
        claude_capabilities()
    }

    fn start_command(&self, options: &StartOptions) -> HolderStartCommand {
        holder_start_command(options)
    }

    fn create_codec(&self) -> Box<dyn DriverCodec> {
        Box::new(ClaudeCodec::default())
    }

    fn prompt_of(&self, request: &DriverEvent) -> DriverPrompt {
        let questions = questions_of(request);
        let suggestions = request
            .get("suggestions")
            .and_then(Value::as_array)
            .map_or(0, Vec::len);
        DriverPrompt {
            tool: js::sv(request.get("tool_name")).to_owned(),
            input: match questions.first() {
                Some(first) => json!({"question": first["question"]}),
                None => request.get("input").cloned().unwrap_or(Value::Null),
            },
            can_always: questions.is_empty() && suggestions > 0,
            questions: (!questions.is_empty()).then_some(questions),
        }
    }

    fn input_kind(&self, text: &str) -> InputKind {
        let kind = |kind: &str, request_id: Option<String>| InputKind {
            kind: kind.to_owned(),
            request_id,
        };
        if let Some(Value::Object(value)) = js::parse(text) {
            match js::sv(value.get("type")) {
                "user" => return kind("user", None),
                "control_response" => {
                    let id = js::rec(value.get("response"))
                        .and_then(|r| r.get("request_id"))
                        .and_then(Value::as_str)
                        .map(str::to_owned);
                    return kind("control_response", id);
                }
                "control_request" => return kind("control_request", None),
                _ => {}
            }
        }
        // Written as is; the holder notes it as "other".
        kind("other", None)
    }

    fn answer_kind(&self) -> &str {
        "control_response"
    }

    fn parse_written_message(&self, text: &str) -> Option<WrittenMessage> {
        let message = js::parse(text)?;
        // JSON null: the TS threw reading it; nothing to give back.
        if message.is_null() {
            return None;
        }
        let content = message.get("message").and_then(|m| m.get("content"));
        let text = match content {
            Some(Value::String(text)) => text.clone(),
            Some(Value::Array(blocks)) => blocks
                .iter()
                .filter_map(|block| {
                    let block = block.as_object()?;
                    (js::sv(block.get("type")) == "text")
                        .then(|| block.get("text").and_then(Value::as_str))
                        .flatten()
                })
                .collect::<Vec<_>>()
                .join("\n\n"),
            _ => String::new(),
        };
        Some(WrittenMessage {
            uuid: message
                .get("uuid")
                .and_then(Value::as_str)
                .map(str::to_owned),
            text,
        })
    }

    fn rewind(&self) -> Option<&dyn RewindDriver> {
        Some(&ClaudeRewind)
    }

    fn models(&self) -> Option<&dyn ModelDriver> {
        Some(&ClaudeModels)
    }

    fn mcp(&self) -> Option<&dyn McpDriver> {
        Some(&ClaudeMcp)
    }
}
