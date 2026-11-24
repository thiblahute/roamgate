//! The reviews agent's turns (index.ts `mr_reviews.agent_turn` and
//! `.agent_stop`, mr-reviews/core-agent.ts `createCoreAgentTurns`): the
//! mr_reviews family keeps the chat and runs the tools; each turn runs on
//! roamgate-claude's Claude Code driver with the reviews agent's MCP
//! server name and stand-in command. A tool's call goes back to the
//! family (`internal.mr_reviews.agent_tool`), and what the turn reports
//! reaches it in its order (`internal.mr_reviews.agent_event`).

use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};

use roamgate_base::env::ProcessEnv;
use roamgate_base::paths::DataContext;
use roamgate_claude::driver::CLAUDE_CODE_PROVIDER;
use roamgate_claude::{
    ClaudeCodeDriver, ClaudeCodeOptions, ClaudeCommand, ClaudeError, ClaudeMcp, ClaudeTurn,
    CommandSource, McpTool, McpToolResult, TurnEvent,
};
use roamgate_sidecar::family::FamilyContext;
use roamgate_sidecar::protocol::RpcError;
use serde_json::{Map, Value, json};
use tokio_util::sync::CancellationToken;

use super::{Target, call};

pub(super) const TARGETS: &[(&str, Target)] = &[
    ("mr_reviews.agent_turn", |_, cx, args| {
        Box::pin(async move { run(&cx, args).await })
    }),
    ("mr_reviews.agent_stop", |_, _, _| {
        Box::pin(async move {
            let agent = agent();
            let running: Vec<CancellationToken> =
                agent.running.lock().unwrap().values().cloned().collect();
            for token in running {
                token.cancel();
            }
            agent.driver.stop().await;
            Ok(json!({"ok": true}))
        })
    }),
];

struct Agent {
    driver: ClaudeCodeDriver,
    /// The running turn's system prompt.
    prompt: Arc<Mutex<String>>,
    running: Mutex<HashMap<String, CancellationToken>>,
}

/// The driver, made on first use.
fn agent() -> &'static Agent {
    static AGENT: OnceLock<Agent> = OnceLock::new();
    AGENT.get_or_init(|| {
        let data = DataContext::from_env(&ProcessEnv);
        let directory = roamgate_mr_reviews::agent::mr_agent_directory(
            &roamgate_mr_reviews::agent::mr_agent_path(&data.data_root()),
        );
        // Test servers name a stand-in (or a wrapper) for `claude`.
        let command = match std::env::var("ROAMGATE_REVIEWS_AGENT_COMMAND") {
            Ok(command) if !command.is_empty() => CommandSource::Program(command),
            // Else the default profile's, read at each turn.
            _ => CommandSource::Resolve(Arc::new(default_command)),
        };
        let prompt = Arc::new(Mutex::new(String::new()));
        let system = prompt.clone();
        let driver = ClaudeCodeDriver::new(ClaudeCodeOptions {
            directory,
            data,
            mcp: ClaudeMcp::new("reviews"),
            command,
            spawn: None,
            available: None,
            system_prompt: Arc::new(move |_| system.lock().unwrap().clone()),
        });
        Agent {
            driver,
            prompt,
            running: Mutex::default(),
        }
    })
}

/// What a turn reported, as the family reads it (`{kind, ...}`).
fn event_of(event: TurnEvent) -> Value {
    match event {
        TurnEvent::Delta(text) => json!({"kind": "delta", "text": text}),
        TurnEvent::Message(text) => json!({"kind": "message", "text": text}),
        TurnEvent::Thinking(steps) => json!({"kind": "thinking", "steps": steps}),
        TurnEvent::Tool {
            id,
            name,
            status,
            arguments,
            output,
        } => {
            let mut details = Map::new();
            if let Some(arguments) = arguments {
                details.insert("arguments".into(), json!(arguments));
            }
            if let Some(output) = output {
                details.insert("output".into(), json!(output));
            }
            json!({
                "kind": "tool",
                "id": id,
                "name": name,
                "status": status.as_str(),
                "details": details,
            })
        }
        TurnEvent::Sources(_) => Value::Null,
        TurnEvent::Error => json!({"kind": "error"}),
    }
}

/// A tool as the family describes it, its calls asked of the family.
fn tool_of(cx: &FamilyContext, turn_id: &str, described: &Value) -> McpTool {
    let name = described["name"].as_str().unwrap_or("").to_owned();
    let (cx, turn, called) = (cx.clone(), turn_id.to_owned(), name.clone());
    McpTool {
        name,
        description: described["description"].as_str().unwrap_or("").to_owned(),
        parameters: described["parameters"].clone(),
        call: Arc::new(move |params, _cancel| {
            let (cx, turn, name) = (cx.clone(), turn.clone(), called.clone());
            Box::pin(async move {
                let answer = call(
                    &cx,
                    "internal.mr_reviews.agent_tool",
                    json!({"turn_id": turn, "name": name, "params": params}),
                )
                .await
                .map_err(|error| ClaudeError::Internal(error.message))?;
                if let Some(error) = answer.get("error").filter(|error| !error.is_null()) {
                    let message = error["message"]
                        .as_str()
                        .unwrap_or("the tool failed")
                        .to_owned();
                    return Err(if error["user"] == true {
                        ClaudeError::User(message)
                    } else {
                        ClaudeError::Internal(message)
                    });
                }
                Ok(McpToolResult {
                    text: answer["text"].as_str().unwrap_or("").to_owned(),
                    sources: None,
                })
            })
        }),
    }
}

/// `mr_reviews.agent_turn {turn_id, model, resume?, text, system_prompt,
/// tools}`: the turn, its events told in order, `{ok: true}` once over.
async fn run(cx: &FamilyContext, turn: Value) -> Result<Value, RpcError> {
    let agent = agent();
    let turn_id = turn["turn_id"].as_str().unwrap_or("").to_owned();
    let cancel = CancellationToken::new();
    agent
        .running
        .lock()
        .unwrap()
        .insert(turn_id.clone(), cancel.clone());
    // What the turn reports reaches the family in its order.
    type Told = (Value, Option<tokio::sync::oneshot::Sender<()>>);
    let (events, mut queued) = tokio::sync::mpsc::unbounded_channel::<Told>();
    let sender = {
        let cx = cx.clone();
        let turn_id = turn_id.clone();
        tokio::spawn(async move {
            while let Some((event, told)) = queued.recv().await {
                let mut ordered = json!({"turn_id": turn_id});
                for (key, value) in event.as_object().into_iter().flatten() {
                    ordered[key] = value.clone();
                }
                let _ = call(&cx, "internal.mr_reviews.agent_event", ordered).await;
                if let Some(told) = told {
                    let _ = told.send(());
                }
            }
        })
    };
    *agent.prompt.lock().unwrap() = turn["system_prompt"].as_str().unwrap_or("").to_owned();
    let tools: Vec<McpTool> = turn["tools"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|tool| tool_of(cx, &turn_id, tool))
        .collect();
    let entries = match turn["resume"].as_str().filter(|resume| !resume.is_empty()) {
        Some(session) => vec![json!({"type": "ranger-claude", "session": session})],
        None => Vec::new(),
    };
    let checkpoint_events = events.clone();
    let reported = events.clone();
    let ran = agent
        .driver
        .run(
            ClaudeTurn {
                config: json!({
                    "provider": CLAUDE_CODE_PROVIDER,
                    "model": turn["model"],
                    "credential_source": "assistant",
                    "allowed_workspaces": [],
                    "approval_mode": "manual",
                }),
                entries,
                text: turn["text"].as_str().unwrap_or("").to_owned(),
                recover: false,
                tools: Box::new(move |_| tools),
                // Kept (told to the family) before the process runs a tool.
                checkpoint: Some(Arc::new(move |entries| {
                    let (told, kept) = tokio::sync::oneshot::channel();
                    let _ = checkpoint_events.send((
                        json!({"kind": "checkpoint", "entries": entries}),
                        Some(told),
                    ));
                    Box::pin(async move {
                        let _ = kept.await;
                        Ok(())
                    })
                })),
                events: Arc::new(move |event| {
                    let event = event_of(event);
                    if !event.is_null() {
                        let _ = reported.send((event, None));
                    }
                }),
            },
            cancel,
        )
        .await;
    agent.running.lock().unwrap().remove(&turn_id);
    drop(events);
    let _ = sender.await;
    ran.map_err(|error| match error {
        ClaudeError::User(message) | ClaudeError::Internal(message) => RpcError::new(message),
    })?;
    Ok(json!({"ok": true}))
}

/// `defaultCommand()`: the default profile's command, from settings.json
/// as it is now; a profile whose secret cannot be read is an error.
fn default_command() -> Result<ClaudeCommand, ClaudeError> {
    let env = ProcessEnv;
    let settings = roamgate_base::settings::settings_path(&env, &DataContext::from_env(&env))
        .ok()
        .and_then(|path| std::fs::read_to_string(path).ok())
        .and_then(|text| serde_json::from_str::<Value>(&text).ok())
        .map(|raw| {
            Value::Object(
                roamgate_base::settings::Settings::normalize(&raw)
                    .as_map()
                    .clone(),
            )
        });
    let home = std::env::var_os("HOME")
        .map(std::path::PathBuf::from)
        .unwrap_or_default();
    let command =
        roamgate_connections::agent_profiles::store::default_command(settings.as_ref(), &home)
            .map_err(ClaudeError::User)?;
    Ok(ClaudeCommand {
        program: command.program,
        env: command.env.into_iter().collect(),
        unset: command.unset,
        profile: !command.plain,
    })
}
