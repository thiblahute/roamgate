//! The T0 vectors of the readers (`contract/vectors/*.json`), replayed
//! against the Rust ports: each call dispatched on its `fn`, a name not
//! known here failing the run.

use std::collections::HashMap;

use roamgate_protocol::vectors::{self, Call};
use serde_json::Value;

use crate::js::{self, Obj};
use crate::session::SessionFile;
use crate::shared::tool_summary::{ToolSummaryContext, ToolSummaryNotes};
use crate::{
    artifacts, commands, compaction, grok, history, messages, rewind, shared, tasks, title,
    token_usage, trajectory,
};

/// `$text` long strings written out, recursively (other tags kept).
fn decode(value: &Value) -> Value {
    if let Some(("$text", _)) = vectors::tag(value) {
        return Value::String(vectors::text(value).unwrap_or_default());
    }
    match value {
        Value::Object(map) => {
            Value::Object(map.iter().map(|(k, v)| (k.clone(), decode(v))).collect())
        }
        Value::Array(items) => Value::Array(items.iter().map(decode).collect()),
        other => other.clone(),
    }
}

/// A value as the test compares it: `undefined` properties left out.
fn clean(value: &Value) -> Value {
    match value {
        Value::Object(map) => {
            if vectors::is_undefined(value) {
                return Value::Null;
            }
            if let Some(("$set", Value::Array(items))) = vectors::tag(value) {
                let mut items: Vec<String> = items.iter().map(js::stringify).collect();
                items.sort();
                return Value::Array(items.into_iter().map(Value::String).collect());
            }
            Value::Object(
                map.iter()
                    .filter(|(_, v)| !vectors::is_undefined(v))
                    .map(|(k, v)| (k.clone(), clean(v)))
                    .collect(),
            )
        }
        Value::Array(items) => Value::Array(items.iter().map(clean).collect()),
        Value::Number(n) => js::number(n.as_f64().unwrap_or(0.0)),
        other => other.clone(),
    }
}

fn records(value: &Value) -> Vec<Obj> {
    value
        .as_array()
        .map(|items| {
            items
                .iter()
                .filter_map(|v| js::js_value(v.clone()).as_object().cloned())
                .collect()
        })
        .unwrap_or_default()
}

fn values(value: &Value) -> Vec<Value> {
    value
        .as_array()
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .map(js::js_value)
        .collect()
}

fn map_arg(value: &Value) -> Vec<(Value, Value)> {
    match vectors::tag(value) {
        Some(("$map", Value::Array(pairs))) => pairs
            .iter()
            .filter_map(|pair| {
                let pair = pair.as_array()?;
                Some((pair.first()?.clone(), pair.get(1)?.clone()))
            })
            .collect(),
        _ => Vec::new(),
    }
}

fn set_arg(value: &Value) -> Option<std::collections::HashSet<String>> {
    match vectors::tag(value) {
        Some(("$set", Value::Array(items))) => Some(
            items
                .iter()
                .filter_map(|v| v.as_str().map(str::to_owned))
                .collect(),
        ),
        _ => None,
    }
}

fn mtimes(value: &Value) -> HashMap<String, Option<f64>> {
    map_arg(value)
        .into_iter()
        .map(|(k, v)| {
            (
                k.as_str().unwrap_or("").to_owned(),
                v.get("mtimeMs").and_then(Value::as_f64),
            )
        })
        .collect()
}

enum Handle {
    Notes(ToolSummaryNotes),
    Context { notes: u64, result: Option<String> },
}

struct Runner {
    handles: HashMap<u64, Handle>,
    next: u64,
}

fn arg(call: &Call, index: usize) -> Value {
    call.args.get(index).cloned().unwrap_or(Value::Null)
}

fn text_arg(call: &Call, index: usize) -> String {
    vectors::text(&arg(call, index)).unwrap_or_default()
}

fn opt(value: Option<Value>) -> Value {
    value.unwrap_or(Value::Null)
}

impl Runner {
    fn handle(&mut self, handle: Handle, wanted: Option<&Value>) -> Value {
        self.next += 1;
        let id = wanted
            .and_then(|w| match vectors::tag(w) {
                Some(("$handle", id)) => id.as_u64(),
                _ => None,
            })
            .unwrap_or(self.next);
        self.handles.insert(id, handle);
        serde_json::json!({ "$handle": id })
    }

    fn context_from<'a>(
        &'a self,
        value: &Value,
        holder: &'a mut Option<ToolSummaryContext<'a>>,
    ) -> ToolSummaryContext<'a> {
        let _ = holder;
        if let Some(("$handle", id)) = vectors::tag(value)
            && let Some(Handle::Context { notes, result }) =
                self.handles.get(&id.as_u64().unwrap_or(0))
            && let Some(Handle::Notes(notes)) = self.handles.get(notes)
        {
            return ToolSummaryContext {
                result: result.clone(),
                notes: Some(notes),
                ..Default::default()
            };
        }
        ToolSummaryContext {
            result: value
                .get("result")
                .and_then(Value::as_str)
                .map(str::to_owned),
            ..Default::default()
        }
    }

    /// What the call gave, or None when the name is not known here.
    fn run(&mut self, call: &Call) -> Option<Value> {
        let mut decoded = call.clone();
        decoded.args = call.args.iter().map(decode).collect();
        let call = &decoded;
        let target = call.target();
        let file = || SessionFile::from_value(&arg(call, 1));
        Some(match target.as_str() {
            "session-trajectory.projectAgentTrajectory" => trajectory::project_agent_trajectory(
                arg(call, 0).as_str().unwrap_or(""),
                &file(),
                &records(&arg(call, 2)),
            ),
            "session-history.historyEntriesFromTrajectory" => {
                Value::Array(history::history_entries_from_trajectory(
                    &SessionFile::from_value(&arg(call, 0)),
                    &js::js_value(arg(call, 1)),
                ))
            }
            "session-messages.conversationMessagesFromTrajectory" => {
                Value::Array(messages::conversation_messages_from_trajectory(
                    &SessionFile::from_value(&arg(call, 0)),
                    &js::js_value(arg(call, 1)),
                ))
            }
            "session-history.HISTORY_WINDOW_LIMIT" => js::int(history::HISTORY_WINDOW_LIMIT as i64),
            "session-history.redactHistoryUpdate" => {
                history::redact_history_update(&js::js_value(arg(call, 0)))
            }
            "session-history.historyTextHash" => {
                Value::String(history::history_text_hash(&text_arg(call, 0)))
            }
            "session-history.historyEpoch" => {
                let identity = arg(call, 2);
                let generation = arg(call, 3);
                Value::String(history::history_epoch(
                    &text_arg(call, 0),
                    &text_arg(call, 1),
                    identity.as_str(),
                    generation.as_str(),
                ))
            }
            "session-history.appendOnlyHistory" => {
                Value::Bool(history::append_only_history(&text_arg(call, 0)))
            }
            "session-history.historyUpdate" => {
                let versions: HashMap<i64, Vec<Value>> = map_arg(&arg(call, 3))
                    .into_iter()
                    .map(|(k, v)| (k.as_i64().unwrap_or(0), values(&v)))
                    .collect();
                let requested = arg(call, 2);
                history::history_update(
                    &arg(call, 0),
                    &values(&arg(call, 1)),
                    (!vectors::is_undefined(&requested)).then_some(&requested),
                    &versions,
                )
            }
            "session-tasks.parseSessionTasks" => {
                let rewound = call
                    .args
                    .get(1)
                    .and_then(|o| o.get("rewound"))
                    .and_then(set_arg);
                Value::Array(tasks::parse_session_tasks(
                    &records(&arg(call, 0)),
                    rewound.as_ref(),
                ))
            }
            "session-tasks.withCommandActivity" => {
                let answers = fn_answers(&arg(call, 3));
                let held = |path: &str| {
                    answers
                        .iter()
                        .find(|(args, _)| args.first().and_then(Value::as_str) == Some(path))
                        .and_then(|(_, result)| result.as_bool())
                };
                Value::Array(tasks::with_command_activity(
                    &values(&arg(call, 0)),
                    &mtimes(&arg(call, 1)),
                    arg(call, 2).as_f64().unwrap_or(0.0),
                    &held,
                ))
            }
            "session-tasks.commandOutputsToWatch" => {
                serde_json::to_value(tasks::command_outputs_to_watch(
                    &values(&arg(call, 0)),
                    arg(call, 1).as_f64().unwrap_or(0.0),
                ))
                .unwrap()
            }
            "session-tasks.subagentsToWatch" => serde_json::to_value(tasks::subagents_to_watch(
                &values(&arg(call, 0)),
                arg(call, 1).as_f64().unwrap_or(0.0),
                call.args.get(2).and_then(Value::as_u64).unwrap_or(8) as usize,
            ))
            .unwrap(),
            "session-tasks.withSubagentActivity" => Value::Array(tasks::with_subagent_activity(
                &values(&arg(call, 0)),
                &mtimes(&arg(call, 1)),
                arg(call, 2).as_f64().unwrap_or(0.0),
            )),
            "session-tasks.SUBAGENT_STALE_MS" => js::number(tasks::SUBAGENT_STALE_MS),
            "session-rewind.rewoundRecordIds" => {
                let mut ids: Vec<String> = rewind::rewound_record_ids(&records(&arg(call, 0)))
                    .into_iter()
                    .collect();
                ids.sort();
                serde_json::json!({ "$set": ids })
            }
            "session-artifacts.publishedArtifact" => opt(artifacts::published_artifact(
                js::js_value(arg(call, 0))
                    .as_object()
                    .unwrap_or(&Obj::new()),
                &text_arg(call, 1),
            )
            .map(Value::Object)),
            "session-artifacts.parseSessionArtifacts" => {
                Value::Array(artifacts::parse_session_artifacts(&values(&arg(call, 0))))
            }
            "session-commands.parseSessionCommands" => {
                Value::Array(commands::parse_session_commands(&values(&arg(call, 0))))
            }
            "session-compaction.compactedSince" => Value::Bool(compaction::compacted_since(
                &text_arg(call, 0),
                &text_arg(call, 1),
            )),
            "session-title.parseSessionTitle" => {
                opt(title::parse_session_title(&values(&arg(call, 0))).map(Value::String))
            }
            "token-usage.tokenUsageFrom" => opt(token_usage::token_usage_from(Some(
                &js::js_value(arg(call, 0)),
            ))
            .map(|u| u.to_value())),
            "token-usage.summarizeTokenUsage" => {
                opt(token_usage::summarize_token_usage(&records(&arg(call, 0)))
                    .map(|u| u.to_value()))
            }
            "token-usage.tokenUsageToMetrics" => {
                let usage = usage_from_value(&arg(call, 0));
                opt(token_usage::token_usage_to_metrics(usage.as_ref()).map(Value::Object))
            }
            "grok-session.grokUserMessageText" => Value::String(grok::grok_user_message_text(
                js::js_value(arg(call, 0))
                    .as_object()
                    .unwrap_or(&Obj::new()),
            )),
            "grok-session.grokReasoningText" => Value::String(grok::grok_reasoning_text(
                js::js_value(arg(call, 0))
                    .as_object()
                    .unwrap_or(&Obj::new()),
            )),
            // shared/agentMessage.ts, injectedMessage.ts
            "agentMessage.parseAgentAddress" => opt(shared::agent_message::parse_agent_address(
                &text_arg(call, 0),
            )
            .map(|(c, p)| serde_json::json!({ "connectionId": c, "paneId": p }))),
            "agentMessage.outgoingAgentMessage" => {
                let name = arg(call, 0);
                shared::agent_message::outgoing_agent_message_value(
                    name.as_str(),
                    &text_arg(call, 1),
                )
            }
            "agentMessage.frameAgentMessage" => {
                let sender = shared::agent_message::AgentMessageSender::from_obj(
                    arg(call, 0).as_object().unwrap_or(&Obj::new()),
                );
                let tool = js::is_true(call.args.get(2).and_then(|o| o.get("tool")));
                Value::String(shared::agent_message::frame_agent_message(
                    &sender,
                    &text_arg(call, 1),
                    tool,
                ))
            }
            "agentMessage.AGENT_MESSAGE_TOOL" => {
                Value::String(shared::agent_message::AGENT_MESSAGE_TOOL.into())
            }
            "agentMessage.AGENT_MESSAGE_TAG" => {
                Value::String(shared::agent_message::AGENT_MESSAGE_TAG.into())
            }
            "agentMessage.AGENT_MESSAGE_PREAMBLE" => {
                Value::String(shared::agent_message::AGENT_MESSAGE_PREAMBLE.into())
            }
            "agentMessage.AGENT_MESSAGE_MAX_CHARS" => {
                js::int(shared::agent_message::AGENT_MESSAGE_MAX_CHARS as i64)
            }
            "injectedMessage.parseInjectedMessage" => {
                shared::injected::parse_injected_message_value(&text_arg(call, 0))
            }
            // shared/bashMode.ts
            "bashMode.shellLine" => {
                opt(shared::bash_mode::shell_line(&text_arg(call, 0)).map(Value::String))
            }
            "bashMode.bashModeTexts" => {
                let run = arg(call, 0);
                let texts = shared::bash_mode::bash_mode_texts(
                    js::sv(run.get("command")),
                    js::sv(run.get("stdout")),
                    js::sv(run.get("stderr")),
                );
                serde_json::to_value(texts).unwrap()
            }
            "bashMode.truncateBashOutput" => {
                let limit = call
                    .args
                    .get(1)
                    .and_then(Value::as_u64)
                    .map_or(shared::bash_mode::BASH_OUTPUT_LIMIT, |l| l as usize);
                let (text, truncated) =
                    shared::bash_mode::truncate_bash_output(&text_arg(call, 0), limit);
                serde_json::json!({ "text": text, "truncated": truncated })
            }
            "bashMode.splitBashMode" => {
                shared::bash_mode::split_bash_mode_value(&text_arg(call, 0))
            }
            // shared/fileEdits.ts
            "fileEdits.lineDiff" => serde_json::to_value(shared::file_edits::line_diff(
                &text_arg(call, 0),
                &text_arg(call, 1),
            ))
            .unwrap(),
            "fileEdits.fileEditFromResult" => opt(shared::file_edits::file_edit_from_result(Some(
                &js::js_value(arg(call, 0)),
            ))),
            "fileEdits.fileEditFromArguments" => {
                let tool = arg(call, 0);
                opt(shared::file_edits::file_edit_from_arguments(
                    tool.as_str(),
                    Some(&js::js_value(arg(call, 1))),
                ))
            }
            "fileEdits.fileEditFromArgumentText" => {
                let tool = arg(call, 0);
                opt(shared::file_edits::file_edit_from_argument_text(
                    tool.as_str(),
                    &text_arg(call, 1),
                ))
            }
            // shared/toolSummary.ts
            "toolSummary.toolDisplayName" => {
                Value::String(shared::tool_summary::tool_display_name(&text_arg(call, 0)))
            }
            "toolSummary.reviewClientCall" => {
                opt(shared::tool_summary::review_client_call(&text_arg(call, 0))
                    .map(|(tool, args)| serde_json::json!({ "tool": tool, "args": args })))
            }
            "toolSummary.ROAMGATE_WRITE_TEXT_LIMIT" => {
                js::int(shared::tool_summary::ROAMGATE_WRITE_TEXT_LIMIT as i64)
            }
            "toolSummary.roamgateWrite" => {
                let result = arg(call, 2);
                opt(shared::tool_summary::roamgate_write(
                    &text_arg(call, 0),
                    &js::js_value(arg(call, 1)),
                    result.get("text").and_then(Value::as_str),
                    js::is_true(result.get("is_error")),
                )
                .map(Value::Object))
            }
            "toolSummary.createToolSummaryNotes" => self.handle(
                Handle::Notes(ToolSummaryNotes::default()),
                call.result.as_ref(),
            ),
            "toolSummary.toolCallSummary" => {
                let mut holder = None;
                let context = self.context_from(&arg(call, 2), &mut holder);
                let limit = call
                    .args
                    .get(3)
                    .and_then(Value::as_u64)
                    .map_or(shared::tool_summary::TOOL_SUMMARY_LIMIT, |l| l as usize);
                Value::String(shared::tool_summary::tool_call_summary(
                    &text_arg(call, 0),
                    &text_arg(call, 1),
                    &context,
                    limit,
                ))
            }
            "on.noteCall" | "on.noteMessage" | "on.context" => {
                let id = call.on.unwrap_or(0);
                if target == "on.context" {
                    let result = call.args.first().and_then(Value::as_str).map(str::to_owned);
                    return Some(
                        self.handle(Handle::Context { notes: id, result }, call.result.as_ref()),
                    );
                }
                let Some(Handle::Notes(notes)) = self.handles.get_mut(&id) else {
                    panic!("no notes handle {id}");
                };
                if target == "on.noteMessage" {
                    notes.note_message(&text_arg(call, 0));
                } else {
                    let args = call.args.get(1).map(|v| js::js_value(v.clone()));
                    let result = call.args.get(2).and_then(Value::as_str);
                    notes.note_call(&text_arg(call, 0), args.as_ref(), result);
                }
                serde_json::json!({ "$undefined": true })
            }
            _ => return None,
        })
    }
}

fn usage_from_value(value: &Value) -> Option<token_usage::TokenUsage> {
    let map = value.as_object()?;
    let n = |key: &str| map.get(key).and_then(Value::as_f64);
    let nullable = |key: &str| map.get(key).map(|v| v.as_f64());
    Some(token_usage::TokenUsage {
        input_tokens: n("input_tokens"),
        cached_input_tokens: n("cached_input_tokens"),
        output_tokens: n("output_tokens"),
        reasoning_output_tokens: n("reasoning_output_tokens"),
        prompt_tokens: nullable("prompt_tokens"),
        total_tokens: nullable("total_tokens"),
    })
}

fn fn_answers(value: &Value) -> Vec<(Vec<Value>, Value)> {
    match vectors::tag(value) {
        Some(("$fn", body)) => body
            .get("calls")
            .and_then(Value::as_array)
            .map(|calls| {
                calls
                    .iter()
                    .map(|c| {
                        (
                            c.get("args")
                                .and_then(Value::as_array)
                                .cloned()
                                .unwrap_or_default(),
                            c.get("result").cloned().unwrap_or(Value::Null),
                        )
                    })
                    .collect()
            })
            .unwrap_or_default(),
        _ => Vec::new(),
    }
}

/// Cases another module's tests replay (the session handlers, with their
/// own fakes), by the call that starts them.
const ELSEWHERE: [&str; 1] = ["agent-sessions.createAgentSessionHandlers"];

fn replay(name: &str) -> (usize, Vec<String>) {
    let file = vectors::load(name);
    let mut ran = 0;
    let mut failures = Vec::new();
    for case in &file.cases {
        if case
            .calls
            .iter()
            .any(|c| c.fn_.as_deref().is_some_and(|f| ELSEWHERE.contains(&f)))
        {
            continue;
        }
        let mut runner = Runner {
            handles: HashMap::new(),
            next: 0,
        };
        for call in &case.calls {
            let target = call.target();
            if target.starts_with("on.") && call.on.is_none() && call.value.is_none() {
                panic!("{name}: {}: no handle for {target}", case.title());
            }
            let Some(got) = runner.run(call) else {
                panic!("{name}: {}: no Rust port of {target}", case.title());
            };
            let want = call
                .result
                .clone()
                .unwrap_or(serde_json::json!({"$undefined": true}));
            if matches!(vectors::tag(&want), Some(("$handle", _))) {
                continue;
            }
            let (got, want) = (clean(&got), clean(&decode(&want)));
            if got != want {
                failures.push(format!(
                    "{name}: {} > {target}\n  got:  {}\n  want: {}",
                    case.title(),
                    js::stringify(&got),
                    js::stringify(&want)
                ));
            }
            ran += 1;
        }
    }
    (ran, failures)
}

macro_rules! vector_test {
    ($test:ident, $file:literal) => {
        #[test]
        fn $test() {
            let (ran, failures) = replay($file);
            assert!(ran > 0, "{}: no call replayed", $file);
            assert!(
                failures.is_empty(),
                "{} failures:\n{}",
                failures.len(),
                failures.join("\n")
            );
        }
    };
}

vector_test!(session_history_vectors, "session-history");
vector_test!(
    session_history_agent_message_vectors,
    "session-history-agent-message"
);
vector_test!(session_trajectory_vectors, "session-trajectory");
vector_test!(session_tasks_vectors, "session-tasks");
vector_test!(session_tasks_resume_vectors, "session-tasks-resume");
vector_test!(session_artifacts_vectors, "session-artifacts");
vector_test!(session_commands_vectors, "session-commands");
vector_test!(session_compaction_vectors, "session-compaction");
vector_test!(session_title_vectors, "session-title");
vector_test!(token_usage_vectors, "token-usage");
vector_test!(muse_session_vectors, "muse-session");
vector_test!(grok_session_vectors, "grok-session");
vector_test!(agent_message_vectors, "agent-message");
vector_test!(bash_mode_vectors, "bash-mode");
vector_test!(file_edits_vectors, "file-edits");
vector_test!(tool_summary_vectors, "tool-summary");
