use std::collections::VecDeque;

use roamgate_base::paths::Platform;
use roamgate_base::private::mode_of;

use super::*;
use crate::mcp::{McpListener, McpRequest};

/// A line of the fake's output, or a stop until it is killed.
#[derive(Clone)]
enum Out {
    Line(Value),
    Hang,
}

fn stream(event: Value) -> Out {
    Out::Line(json!({ "type": "stream_event", "event": event }))
}

/// What `claude -p --output-format stream-json` says for one tool round.
fn tool_round() -> Vec<Out> {
    vec![
        Out::Line(json!({
            "type": "system", "subtype": "init",
            "mcp_servers": [{ "name": "ranger", "status": "connected" }],
        })),
        stream(json!({
            "type": "content_block_start", "index": 0,
            "content_block": { "type": "thinking", "thinking": "" },
        })),
        stream(json!({
            "type": "content_block_delta", "index": 0,
            "delta": { "type": "thinking_delta", "thinking": "Check w7." },
        })),
        stream(json!({ "type": "content_block_stop", "index": 0 })),
        Out::Line(json!({
            "type": "assistant",
            "message": { "content": [{
                "type": "tool_use", "id": "toolu_1",
                "name": "mcp__ranger__workspace_status",
                "input": { "workspace_id": "w7" },
            }] },
        })),
        Out::Line(json!({
            "type": "user",
            "message": { "content": [{
                "type": "tool_result", "tool_use_id": "toolu_1",
                "content": [{ "type": "text", "text": "w7: idle" }],
            }] },
        })),
        stream(json!({
            "type": "content_block_start", "index": 0,
            "content_block": { "type": "text", "text": "" },
        })),
        stream(json!({
            "type": "content_block_delta", "index": 0,
            "delta": { "type": "text_delta", "text": "w7 is " },
        })),
        stream(json!({
            "type": "content_block_delta", "index": 0,
            "delta": { "type": "text_delta", "text": "idle." },
        })),
        Out::Line(json!({
            "type": "assistant",
            "message": { "content": [{ "type": "text", "text": "w7 is idle." }] },
        })),
        Out::Line(json!({
            "type": "result", "subtype": "success", "is_error": false, "result": "w7 is idle.",
        })),
    ]
}

/// Every run the fake started.
type Runs = Arc<Mutex<Vec<Arc<Mutex<Run>>>>>;

#[derive(Debug, Default)]
struct Run {
    args: Vec<String>,
    cwd: PathBuf,
    written: Vec<String>,
    killed: bool,
    mcp: String,
    mode: u32,
}

impl Run {
    fn arg(&self, flag: &str) -> Option<&str> {
        let at = self.args.iter().position(|arg| arg == flag)?;
        self.args.get(at + 1).map(String::as_str)
    }
}

struct FakeProcess {
    run: Arc<Mutex<Run>>,
    out: VecDeque<Out>,
    hangs: bool,
    exit: i32,
}

impl ClaudeProcess for FakeProcess {
    fn next_line(&mut self) -> BoxFuture<'_, Option<String>> {
        Box::pin(async move {
            if self.run.lock().unwrap().killed {
                return None;
            }
            match self.out.pop_front()? {
                Out::Line(line) => Some(js::stringify(&line)),
                // Killed through the driver, which stops reading.
                Out::Hang => std::future::pending().await,
            }
        })
    }

    fn write<'a>(&'a mut self, line: &'a str) -> BoxFuture<'a, io::Result<()>> {
        self.run.lock().unwrap().written.push(line.to_owned());
        Box::pin(async { Ok(()) })
    }

    fn end(&mut self) {}

    fn kill(&mut self) {
        self.run.lock().unwrap().killed = true;
    }

    fn wait(&mut self) -> BoxFuture<'_, io::Result<i32>> {
        Box::pin(async move {
            if self.run.lock().unwrap().killed {
                return Ok(143);
            }
            // Processes that are not killed exit once their output is read.
            if self.hangs {
                std::future::pending::<()>().await;
            }
            Ok(self.exit)
        })
    }
}

fn fake_claude(out: Vec<Out>, exit: i32) -> (SpawnClaude, Runs) {
    let runs: Runs = Arc::default();
    let recorded = runs.clone();
    let spawn: SpawnClaude = Arc::new(move |args: Vec<String>, cwd: PathBuf| {
        let path = args[args.iter().position(|arg| arg == "--mcp-config").unwrap() + 1].clone();
        let run = Arc::new(Mutex::new(Run {
            mcp: std::fs::read_to_string(&path).unwrap(),
            mode: mode_of(&std::fs::metadata(&path).unwrap()) & 0o777,
            args,
            cwd,
            ..Run::default()
        }));
        recorded.lock().unwrap().push(run.clone());
        Ok(Box::new(FakeProcess {
            run,
            hangs: out.iter().any(|out| matches!(out, Out::Hang)),
            out: out.clone().into(),
            exit,
        }) as Box<dyn ClaudeProcess>)
    });
    (spawn, runs)
}

fn mcp() -> ClaudeMcp {
    ClaudeMcp::with_listen(
        crate::mcp::RANGER_MCP_SERVER,
        Box::new(|_| {
            Ok(McpListener {
                url: "http://127.0.0.1:1/mcp".to_owned(),
                stop: Box::new(|| {}),
            })
        }),
    )
}

fn system_prompt() -> SystemPrompt {
    Arc::new(|_| "You are Ranger, Roamgate's assistant.".to_owned())
}

struct Harness {
    driver: ClaudeCodeDriver,
    runs: Runs,
    directory: tempfile::TempDir,
}

impl Harness {
    fn run(&self, at: usize) -> Arc<Mutex<Run>> {
        self.runs.lock().unwrap()[at].clone()
    }
}

fn data(directory: &Path) -> DataContext {
    DataContext::new(directory, Platform::current(), None)
}

fn driver_for(out: Vec<Out>, exit: i32) -> Harness {
    let directory = tempfile::Builder::new()
        .prefix("ranger-claude-")
        .tempdir()
        .unwrap();
    let (spawn, runs) = fake_claude(out, exit);
    let driver = ClaudeCodeDriver::new(ClaudeCodeOptions {
        directory: directory.path().to_owned(),
        data: data(directory.path()),
        mcp: mcp(),
        command: CommandSource::default(),
        spawn: Some(spawn),
        available: Some(Arc::new(|| true)),
        system_prompt: system_prompt(),
    });
    Harness {
        driver,
        runs,
        directory,
    }
}

/// The calls a turn made, as the TS recorder lists them.
#[derive(Debug, Clone, PartialEq)]
enum Call {
    Checkpoint(Vec<Value>),
    Event(TurnEvent),
}

#[derive(Clone, Default)]
struct Recorder(Arc<Mutex<Vec<Call>>>);

impl Recorder {
    fn calls(&self) -> Vec<Call> {
        self.0.lock().unwrap().clone()
    }

    fn turn(&self, config: Value, entries: Vec<Value>, text: &str) -> ClaudeTurn {
        let checkpoints = self.0.clone();
        let events = self.0.clone();
        ClaudeTurn {
            config,
            entries,
            text: text.to_owned(),
            recover: false,
            tools: Box::new(|_| Vec::new()),
            checkpoint: Some(Arc::new(move |entries| {
                checkpoints.lock().unwrap().push(Call::Checkpoint(entries));
                Box::pin(async { Ok(()) })
            })),
            events: Arc::new(move |event| events.lock().unwrap().push(Call::Event(event))),
        }
    }
}

fn config(extra: Value) -> Value {
    let mut config = json!({
        "provider": CLAUDE_CODE_PROVIDER,
        "model": "opus",
        "credential_source": "assistant",
        "allowed_workspaces": [],
    });
    for (key, value) in extra.as_object().unwrap() {
        config[key] = value.clone();
    }
    config
}

#[test]
fn lists_claude_models_with_claude_codes_effort_levels() {
    let harness = driver_for(Vec::new(), 0);
    let catalog = harness.driver.catalog();
    assert_eq!(
        catalog["providers"],
        json!([{ "id": "claude-code", "label": "Claude Code", "methods": [], "configured": true }])
    );
    let ids: Vec<&str> = catalog["models"]
        .as_array()
        .unwrap()
        .iter()
        .map(|model| model["id"].as_str().unwrap())
        .collect();
    assert_eq!(ids, ["opus", "sonnet", "haiku"]);
    assert_eq!(
        catalog["models"][0]["thinking_levels"],
        json!(["low", "medium", "high", "xhigh", "max"])
    );
    assert_eq!(
        js::stringify(&catalog["models"][0]),
        r#"{"provider":"claude-code","id":"opus","label":"Claude Opus","thinking_levels":["low","medium","high","xhigh","max"],"default_thinking_level":"high"}"#
    );
}

#[tokio::test]
async fn runs_a_turn_in_a_new_session_with_only_rangers_tools() {
    let harness = driver_for(tool_round(), 0);
    let recorder = Recorder::default();
    let entries = harness
        .driver
        .run(
            recorder.turn(config(json!({})), Vec::new(), "What is w7 doing?"),
            CancellationToken::new(),
        )
        .await
        .unwrap();
    let run = harness.run(0);
    let run = run.lock().unwrap();
    assert_eq!(run.cwd, harness.directory.path().join("claude"));
    assert_eq!(run.arg("--model"), Some("opus"));
    assert!(!run.args.iter().any(|arg| arg == "--effort"));
    let session = run.arg("--session-id").unwrap().to_owned();
    assert!(SESSION_ID.is_match(&session));
    assert_eq!(run.arg("--tools"), Some(""));
    assert!(run.args.iter().any(|arg| arg == "--strict-mcp-config"));
    assert_eq!(run.arg("--allowedTools"), Some("mcp__ranger"));
    assert_eq!(
        serde_json::from_str::<Value>(run.arg("--settings").unwrap()).unwrap(),
        json!({ "disableAllHooks": true })
    );
    assert_eq!(
        serde_json::from_str::<Value>(&run.mcp).unwrap()["mcpServers"]["ranger"]["type"],
        "http"
    );
    assert!(!run.args.join(" ").contains("Bearer "));
    if cfg!(unix) {
        assert_eq!(run.mode, 0o600);
    }
    assert!(!Path::new(run.arg("--mcp-config").unwrap()).exists());
    assert!(
        run.arg("--system-prompt")
            .unwrap()
            .starts_with("You are Ranger")
    );
    assert!(run.arg("--system-prompt").unwrap().ends_with(
        "\nYour tools are named mcp__ranger__<name>; these instructions name them without that prefix."
    ));
    assert_eq!(
        run.written,
        ["{\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":\"What is w7 doing?\"}}\n"]
    );
    let pointer = json!({ "type": "ranger-claude", "session": session });
    assert_eq!(entries, std::slice::from_ref(&pointer));
    let arguments = Some("{\n  \"workspace_id\": \"w7\"\n}".to_owned());
    assert_eq!(
        recorder.calls(),
        [
            Call::Checkpoint(vec![pointer]),
            Call::Event(TurnEvent::Thinking(vec!["Check w7.".to_owned()])),
            Call::Event(TurnEvent::Tool {
                id: "toolu_1".to_owned(),
                name: "workspace_status".to_owned(),
                status: ToolStatus::Running,
                arguments: arguments.clone(),
                output: None,
            }),
            Call::Event(TurnEvent::Tool {
                id: "toolu_1".to_owned(),
                name: "workspace_status".to_owned(),
                status: ToolStatus::Completed,
                arguments,
                output: Some("w7: idle".to_owned()),
            }),
            Call::Event(TurnEvent::Delta("w7 is ".to_owned())),
            Call::Event(TurnEvent::Delta("idle.".to_owned())),
            Call::Event(TurnEvent::Message("w7 is idle.".to_owned())),
        ]
    );
}

#[tokio::test]
async fn resumes_the_session_the_last_turn_left_at_the_chosen_effort() {
    let harness = driver_for(tool_round(), 0);
    let session = "0b0e8a52-7a4b-4c55-9d3e-2f4a8a1c9d10";
    let pointer = json!({ "type": "ranger-claude", "session": session });
    let entries = harness
        .driver
        .run(
            Recorder::default().turn(
                config(json!({ "model": "haiku", "thinking_level": "low" })),
                vec![pointer.clone()],
                "And now?",
            ),
            CancellationToken::new(),
        )
        .await
        .unwrap();
    assert_eq!(entries, [pointer]);
    let run = harness.run(0);
    let run = run.lock().unwrap();
    assert_eq!(run.arg("--resume"), Some(session));
    assert_eq!(run.arg("--effort"), Some("low"));
}

#[tokio::test]
async fn a_failed_answer_is_reported() {
    let harness = driver_for(
        vec![Out::Line(
            json!({ "type": "result", "subtype": "error_during_execution", "is_error": true }),
        )],
        1,
    );
    let recorder = Recorder::default();
    harness
        .driver
        .run(
            recorder.turn(config(json!({})), Vec::new(), "Hi"),
            CancellationToken::new(),
        )
        .await
        .unwrap();
    let errors = recorder
        .calls()
        .into_iter()
        .filter(|call| *call == Call::Event(TurnEvent::Error))
        .count();
    assert_eq!(errors, 1);
}

#[tokio::test]
async fn stopping_kills_the_run_and_keeps_its_session_without_an_error() {
    let harness = driver_for(vec![tool_round().remove(0), Out::Hang], 0);
    let recorder = Recorder::default();
    let driver = harness.driver.clone();
    let turn = recorder.turn(config(json!({})), Vec::new(), "Hi");
    let running = tokio::spawn(async move { driver.run(turn, CancellationToken::new()).await });
    while harness.runs.lock().unwrap().is_empty() {
        tokio::time::sleep(std::time::Duration::from_millis(1)).await;
    }
    harness.driver.stop().await;
    let entries = running.await.unwrap().unwrap();
    let run = harness.run(0);
    let run = run.lock().unwrap();
    assert!(run.killed);
    assert!(!Path::new(run.arg("--mcp-config").unwrap()).exists());
    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0]["type"], "ranger-claude");
    assert!(entries[0]["session"].is_string());
    assert!(!recorder.calls().contains(&Call::Event(TurnEvent::Error)));
}

#[tokio::test]
async fn refuses_an_unknown_model_and_a_foreign_context() {
    let harness = driver_for(tool_round(), 0);
    let recorder = Recorder::default();
    let error = harness
        .driver
        .run(
            recorder.turn(config(json!({ "model": "gpt" })), Vec::new(), "Hi"),
            CancellationToken::new(),
        )
        .await
        .unwrap_err();
    assert_eq!(error, ClaudeError::internal("Model unavailable"));
    let error = harness
        .driver
        .run(
            recorder.turn(
                config(json!({})),
                vec![json!({ "type": "ranger-durable", "id": "x" })],
                "Hi",
            ),
            CancellationToken::new(),
        )
        .await
        .unwrap_err();
    assert_eq!(error, ClaudeError::internal("Invalid Claude Code context"));
}

#[tokio::test]
async fn recovery_clears_the_cli_context_without_respawning_or_replaying_tools() {
    let harness = driver_for(tool_round(), 0);
    let recorder = Recorder::default();
    let built = Arc::new(AtomicBool::new(false));
    let mut turn = recorder.turn(
        config(json!({ "approval_mode": "auto" })),
        vec![json!({ "type": "ranger-claude", "session": "0b0e8a52-7a4b-4c55-9d3e-2f4a8a1c9d10" })],
        "Perform the operation",
    );
    turn.recover = true;
    let flag = built.clone();
    turn.tools = Box::new(move |_| {
        flag.store(true, Ordering::SeqCst);
        Vec::new()
    });
    let error = harness
        .driver
        .run(turn, CancellationToken::new())
        .await
        .unwrap_err();
    assert!(error.surfaced());
    assert!(error.message().contains("was not retried"), "{error}");
    assert!(harness.runs.lock().unwrap().is_empty());
    assert!(!built.load(Ordering::SeqCst));
    assert_eq!(recorder.calls(), [Call::Checkpoint(Vec::new())]);
}

#[tokio::test]
async fn a_spawn_failure_removes_the_private_mcp_configuration() {
    let directory = tempfile::Builder::new()
        .prefix("ranger-claude-failed-")
        .tempdir()
        .unwrap();
    let path = Arc::new(Mutex::new(PathBuf::new()));
    let seen = path.clone();
    let mcp = mcp();
    let driver = ClaudeCodeDriver::new(ClaudeCodeOptions {
        directory: directory.path().to_owned(),
        data: data(directory.path()),
        mcp: mcp.clone(),
        command: CommandSource::default(),
        spawn: Some(Arc::new(move |args: Vec<String>, _| {
            let config = PathBuf::from(
                &args[args.iter().position(|arg| arg == "--mcp-config").unwrap() + 1],
            );
            assert!(config.exists());
            *seen.lock().unwrap() = config;
            Err(ClaudeError::internal("spawn failed"))
        })),
        available: None,
        system_prompt: system_prompt(),
    });
    let error = driver
        .run(
            Recorder::default().turn(config(json!({})), Vec::new(), "Hi"),
            CancellationToken::new(),
        )
        .await
        .unwrap_err();
    assert_eq!(error, ClaudeError::internal("spawn failed"));
    let path = path.lock().unwrap().clone();
    assert!(!path.as_os_str().is_empty());
    assert!(!path.exists());
    let response = mcp
        .handle(McpRequest::post(
            Some("Bearer expired"),
            &json!({ "jsonrpc": "2.0", "id": 1, "method": "tools/list" }),
        ))
        .await;
    assert_eq!(response.status, 401);
    mcp.stop();
}

#[cfg(unix)]
#[tokio::test]
async fn a_write_after_stdin_closed_throws_instead_of_vanishing() {
    let mut child = spawn_claude_process(SpawnOptions {
        argv: vec!["cat".to_owned()],
        ..SpawnOptions::default()
    })
    .unwrap();
    child.write("kept\n").await.unwrap();
    child.end();
    let error = child.write("lost\n").await.unwrap_err();
    assert!(error.to_string().contains("closing"), "{error}");
    let mut lines = Vec::new();
    while let Some(line) = child.next_line().await {
        lines.push(line);
    }
    assert_eq!(lines, ["kept"]);
    assert_eq!(child.wait().await.unwrap(), 0);
}
