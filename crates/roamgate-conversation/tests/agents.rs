//! Conversation mode with two agents behind the service: AGY over ACP
//! (handshake, streaming, tool calls, permission prompts), and a
//! conversation moved between Claude and AGY (`agent_chat.switch_agent`):
//! each agent gets exactly the events it missed, a restart mid-switch
//! leaves one writer, and `AGY -> Claude -> AGY -> Claude` keeps one work
//! session.

use std::sync::{Arc, Mutex};

use roamgate_agents::obj;
use roamgate_agy::agy_driver;
use roamgate_base::paths::DataContext;
use roamgate_claude::conversation::claude_driver;
use roamgate_conversation::continuity::{QueuedHandoffMessage, default_continuity_dir};
use roamgate_conversation::driver::{BoxFuture, Drivers, HeadlessProcess};
use roamgate_conversation::headless::{HeadlessSpawnOptions, SpawnHeadless};
use roamgate_conversation::images::ConversationImage;
use roamgate_conversation::lease::{LeaseOptions, LeaseStore};
use roamgate_conversation::rpc::handle_agent_chat_rpc;
use roamgate_conversation::service::{ConversationService, HolderSideInput, ServiceOptions};
use roamgate_conversation::shared::Obj;
use roamgate_conversation::testing::{FakeClaude, FakeHerdr, FakeHerdrOptions, Respond, settle};
use roamgate_conversation::time::VirtualClock;
use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;

type ResponderFn = Arc<dyn Fn(usize, &str, &FakeClaude) + Send + Sync>;

/// A fake headless process supporting both Claude stream-json and AGY ACP JSON-RPC.
struct MultiBackendSpawner {
    spawned: Mutex<Vec<(String, String, Arc<FakeClaude>)>>,
    claude_responder: ResponderFn,
    agy_responder: ResponderFn,
}

impl MultiBackendSpawner {
    fn new(
        claude_responder: impl Fn(usize, &str, &FakeClaude) + Send + Sync + 'static,
        agy_responder: impl Fn(usize, &str, &FakeClaude) + Send + Sync + 'static,
    ) -> Arc<Self> {
        Arc::new(Self {
            spawned: Mutex::new(Vec::new()),
            claude_responder: Arc::new(claude_responder),
            agy_responder: Arc::new(agy_responder),
        })
    }

    fn count(&self) -> usize {
        self.spawned.lock().unwrap().len()
    }

    fn written_of(&self, index: usize) -> Vec<String> {
        self.spawned.lock().unwrap()[index]
            .2
            .written()
            .into_iter()
            .map(|m| Value::Object(m).to_string())
            .collect()
    }
}

impl SpawnHeadless for MultiBackendSpawner {
    fn spawn(
        &self,
        options: HeadlessSpawnOptions,
    ) -> BoxFuture<'_, Result<Option<Arc<dyn HeadlessProcess>>, String>> {
        Box::pin(async move {
            if options.attach_only {
                return Ok(None);
            }
            let idx = self.spawned.lock().unwrap().len();
            let claude_fn = self.claude_responder.clone();
            let agy_fn = self.agy_responder.clone();
            let responder: Respond = Box::new(move |msg: &Obj, fake: &FakeClaude| {
                let line = Value::Object(msg.clone()).to_string();
                if msg.contains_key("jsonrpc") {
                    agy_fn(idx, &line, fake);
                } else {
                    claude_fn(idx, &line, fake);
                }
            });
            let fake = FakeClaude::new(None, true, Some(responder));
            self.spawned
                .lock()
                .unwrap()
                .push((options.pane_id, options.session_id, fake.clone()));
            Ok(Some(fake as Arc<dyn HeadlessProcess>))
        })
    }
}

fn default_claude_responder(_idx: usize, line: &str, fake: &FakeClaude) {
    let Ok(val) = serde_json::from_str::<Value>(line) else {
        return;
    };
    if val["type"] == "user" {
        let content = &val["message"]["content"];
        let text = match content {
            Value::String(s) => s.clone(),
            Value::Array(parts) => parts
                .iter()
                .filter_map(|p| p.get("text").and_then(Value::as_str))
                .collect::<Vec<_>>()
                .join("\n"),
            _ => String::new(),
        };
        // As --replay-user-messages does.
        fake.push(json!({
            "type": "user",
            "isReplay": true,
            "uuid": val["uuid"],
            "message": val["message"],
        }));
        let reply = format!("Claude ack: {}", text.lines().next().unwrap_or("ok"));
        fake.push(json!({
            "type": "assistant",
            "message": {
                "id": "c-msg-1",
                "model": "claude-opus",
                "content": [{"type": "text", "text": reply}],
            }
        }));
        fake.push(json!({
            "type": "result",
            "subtype": "success",
            "is_error": false,
            "result": reply,
        }));
    } else if val["type"] == "control_request" {
        let req_id = val["request_id"].as_str().unwrap_or("");
        fake.push(json!({
            "type": "control_response",
            "response": {"subtype": "success", "request_id": req_id, "response": {}},
        }));
    }
}

fn default_agy_responder(_idx: usize, line: &str, fake: &FakeClaude) {
    let Ok(val) = serde_json::from_str::<Value>(line) else {
        return;
    };
    let method = val["method"].as_str().unwrap_or("");
    let id = val.get("id").cloned().unwrap_or(Value::Null);
    match method {
        "initialize" => {
            fake.push(json!({
                "jsonrpc": "2.0",
                "id": id,
                "result": {"protocolVersion": 1, "agentCapabilities": {"loadSession": true}}
            }));
        }
        "session/resume" => {
            let sid = val["params"]["sessionId"].as_str().unwrap_or("agy-resumed");
            fake.push(json!({
                "jsonrpc": "2.0",
                "id": id,
                "result": {
                    "sessionId": sid,
                    "models": {"currentModelId": "gemini-3-pro"}
                }
            }));
        }
        "session/new" => {
            fake.push(json!({
                "jsonrpc": "2.0",
                "id": id,
                "result": {
                    "sessionId": "agy-fresh-1",
                    "models": {"currentModelId": "gemini-3-pro"}
                }
            }));
        }
        "session/prompt" => {
            let sid = val["params"]["sessionId"].as_str().unwrap_or("agy-1");
            let text = val["params"]["prompt"]
                .as_array()
                .and_then(|arr| arr.first())
                .and_then(|b| b.get("text"))
                .and_then(Value::as_str)
                .unwrap_or("");
            let reply = format!("AGY ack: {}", text.lines().next().unwrap_or("ok"));
            fake.push(json!({
                "jsonrpc": "2.0",
                "method": "session/update",
                "params": {
                    "sessionId": sid,
                    "update": {
                        "sessionUpdate": "agent_message_chunk",
                        "content": {"type": "text", "text": reply}
                    }
                }
            }));
            fake.push(json!({
                "jsonrpc": "2.0",
                "id": id,
                "result": {"stopReason": "end_turn"}
            }));
        }
        _ => {}
    }
}

/// The service, keeping its leases and work sessions under `root` (else
/// in memory).
fn make_service(
    clock: &VirtualClock,
    spawner: Arc<dyn SpawnHeadless>,
    root: Option<&std::path::Path>,
    events: Arc<Mutex<Vec<Obj>>>,
    permission_answer: Option<Value>,
    initial_session_id: &str,
) -> (ConversationService, LeaseStore, CancellationToken) {
    let data =
        root.map(|root| DataContext::new(root, roamgate_base::paths::Platform::current(), None));
    let continuity_dir = data.as_ref().map(default_continuity_dir);
    let lease_file = root.map(|root| root.join("leases.json"));
    let drivers = Drivers::new(vec![claude_driver(), agy_driver()]);
    let herdr = FakeHerdr::new(FakeHerdrOptions::default());
    herdr
        .state
        .lock()
        .unwrap()
        .pane
        .process
        .foreground_processes
        .clear();
    let leases = LeaseStore::new(LeaseOptions {
        connection_id: "local".into(),
        file: lease_file,
        clock: clock.shared(),
        data: data.clone(),
    });
    let ask_answer = permission_answer;
    let mut opts = ServiceOptions::new(
        "local",
        herdr,
        leases.clone(),
        drivers,
        clock.shared(),
        Arc::new(move |_pane, _prompt| {
            let answer = ask_answer.clone();
            Box::pin(async move { Ok(answer) })
        }),
        Arc::new(|path| {
            Box::pin(async move {
                Ok(ConversationImage {
                    media_type: "image/png".into(),
                    data: format!("base64-for-{path}"),
                })
            })
        }),
        Arc::new(move |_socket, envelope| {
            events.lock().unwrap().push(envelope);
        }),
        Arc::new(|sid| format!("roamgate-hold {sid}\r")),
    );
    opts.spawn = Some(spawner);
    opts.continuity_dir = continuity_dir;
    opts.data = data;
    opts.stuck_check_ms = 0;
    opts.holder_watch_ms = 0;
    opts.suspended_watch_ms = 0;
    let service = ConversationService::new(opts);
    let stop_holder = CancellationToken::new();
    let hold_service = service.clone();
    let hold_stop = stop_holder.clone();
    let mut held_sid = initial_session_id.to_owned();
    tokio::spawn(async move {
        while !hold_stop.is_cancelled() {
            let reply = hold_service
                .holder_hold(HolderSideInput {
                    pane_id: "w1:p1".into(),
                    session_id: held_sid.clone(),
                    status: None,
                    shell: None,
                    signal: Some(hold_stop.clone()),
                })
                .await;
            if let Some(next) = reply.get("session_id").and_then(Value::as_str)
                && !next.is_empty()
            {
                held_sid = next.to_owned();
            }
            tokio::task::yield_now().await;
        }
    });
    (service, leases, stop_holder)
}

#[tokio::test]
async fn agy_conversation_mode_handles_streaming_tools_and_permissions() {
    let clock = VirtualClock::new();
    clock.set(1_700_000_000_000);
    let events = Arc::new(Mutex::new(Vec::new()));
    let spawner = MultiBackendSpawner::new(default_claude_responder, |_idx, line, fake| {
        let Ok(val) = serde_json::from_str::<Value>(line) else {
            return;
        };
        let method = val["method"].as_str().unwrap_or("");
        let id = val.get("id").cloned().unwrap_or(Value::Null);
        match method {
            "initialize" => {
                fake.push(json!({"jsonrpc": "2.0", "id": id, "result": {"protocolVersion": 1}}))
            }
            "session/resume" => fake.push(json!({
                "jsonrpc": "2.0",
                "id": id,
                "result": {"sessionId": "agy-s1", "models": {"currentModelId": "gemini-3-pro"}}
            })),
            "session/prompt" => {
                fake.push(json!({
                    "jsonrpc": "2.0",
                    "method": "session/update",
                    "params": {
                        "sessionId": "agy-s1",
                        "update": {"sessionUpdate": "tool_call", "toolCallId": "tc-1", "title": "run_command", "rawInput": {"cmd": "cargo check"}}
                    }
                }));
                fake.push(json!({
                    "jsonrpc": "2.0",
                    "id": 99,
                    "method": "session/request_permission",
                    "params": {
                        "sessionId": "agy-s1",
                        "toolCall": {"toolCallId": "tc-1", "title": "run_command", "rawInput": {"cmd": "cargo check"}},
                        "options": [
                            {"optionId": "allow-1", "name": "Allow", "kind": "allow_once"},
                            {"optionId": "deny-1", "name": "Deny", "kind": "reject_once"}
                        ]
                    }
                }));
            }
            "" if val.get("id") == Some(&json!(99)) => {
                fake.push(json!({
                    "jsonrpc": "2.0",
                    "method": "session/update",
                    "params": {
                        "sessionId": "agy-s1",
                        "update": {"sessionUpdate": "tool_call_update", "toolCallId": "tc-1", "status": "completed", "rawOutput": "clean"}
                    }
                }));
                fake.push(json!({
                    "jsonrpc": "2.0",
                    "method": "session/update",
                    "params": {
                        "sessionId": "agy-s1",
                        "update": {"sessionUpdate": "agent_message_chunk", "content": {"type": "text", "text": "Build green."}}
                    }
                }));
                fake.push(json!({
                    "jsonrpc": "2.0",
                    "id": "roamgate-acp-prompt-1",
                    "result": {"stopReason": "end_turn"}
                }));
            }
            _ => {}
        }
    });

    let (service, leases, _holder) = make_service(
        &clock,
        spawner.clone(),
        None,
        events.clone(),
        Some(json!("allow")),
        "agy-s1",
    );
    leases.set(obj! {
        "pane_id" => "w1:p1",
        "session_id" => "agy-s1",
        "cwd" => "/repo",
        "phase" => "conversation",
        "agent" => "agy"
    });
    settle().await;
    service.subscribe(1, "w1:p1");

    let state = service.state("w1:p1");
    assert_eq!(state["agent"], "agy");
    assert_eq!(state["capabilities"]["rewind"], Value::Null);
    assert_eq!(state["capabilities"]["models"], true);

    service
        .send("w1:p1", "Run cargo check", vec![], Some("u1".into()))
        .await
        .unwrap();
    settle().await;

    let written = spawner.written_of(0);
    assert!(
        written
            .iter()
            .any(|l| l.contains("\"method\":\"initialize\""))
    );
    assert!(
        written
            .iter()
            .any(|l| l.contains("\"method\":\"session/resume\""))
    );
    assert!(
        written
            .iter()
            .any(|l| l.contains("\"method\":\"session/prompt\""))
    );
    assert!(
        written
            .iter()
            .any(|l| l.contains("\"optionId\":\"allow-1\""))
    );

    let evs = events.lock().unwrap();
    assert!(evs.iter().any(|e| e["event"] == "agent_chat.tool_use"));
    assert!(evs.iter().any(|e| e["event"] == "agent_chat.tool_result"));
    assert!(
        evs.iter()
            .any(|e| e["event"] == "agent_chat.result" && e["data"]["text"] == "Build green.")
    );
}

#[tokio::test]
async fn claude_to_agy_gives_the_history_once_and_a_restart_mid_switch_leaves_one_writer() {
    let tmp = tempfile::tempdir().unwrap();
    let clock = VirtualClock::new();
    clock.set(1_700_000_000_000);
    let events = Arc::new(Mutex::new(Vec::new()));
    let spawner = MultiBackendSpawner::new(default_claude_responder, default_agy_responder);

    let (service, leases, holder) = make_service(
        &clock,
        spawner.clone(),
        Some(tmp.path()),
        events.clone(),
        Some(json!("allow")),
        "claude-1",
    );
    leases.set(obj! {
        "pane_id" => "w1:p1",
        "session_id" => "claude-1",
        "cwd" => "/repo",
        "phase" => "conversation",
        "agent" => "claude",
        "terminal_args" => vec![Value::from("--permission-mode"), Value::from("plan")],
    });
    settle().await;
    service.subscribe(1, "w1:p1");
    service
        .send("w1:p1", "Fix the Windows test", vec![], Some("u1".into()))
        .await
        .unwrap();
    settle().await;

    let switched = handle_agent_chat_rpc(
        &service,
        1,
        "agent_chat.switch_agent",
        &json!({"pane_id": "w1:p1", "agent": "agy", "reason": "usage_limit"}),
    )
    .await
    .unwrap();
    settle().await;
    assert_eq!(switched["ok"], true);
    assert_eq!(switched["agent"], "agy");
    assert_eq!(switched["reused_session"], false);
    let work_session = switched["work_session_id"].as_str().unwrap().to_owned();
    assert_eq!(spawner.count(), 2);

    // AGY got the conversation in one continuation block, then nothing twice.
    let agy_written = spawner.written_of(1).join("\n");
    assert!(agy_written.contains("<roamgate-continuation from=\\\"claude\\\""));
    assert!(agy_written.contains("Fix the Windows test"));
    assert!(agy_written.contains("Claude ack: Fix the Windows test"));
    assert_eq!(
        agy_written
            .matches("[#1] User: Fix the Windows test")
            .count(),
        1
    );
    // The lease is AGY's, without Claude's terminal flags.
    let lease = leases.get("w1:p1").unwrap();
    assert_eq!(lease["agent"], "agy");
    assert_eq!(lease["session_id"], "agy-fresh-1");
    assert!(!lease.contains_key("terminal_args"));
    assert_eq!(
        lease["agent_terminal_args"],
        json!({"claude": ["--permission-mode", "plan"]})
    );
    assert!(!lease.contains_key("handoff_phase"));
    {
        let evs = events.lock().unwrap();
        assert!(evs.iter().any(|e| {
            e["event"] == "agent_chat.backend_switched"
                && e["data"]["from_agent"] == "claude"
                && e["data"]["to_agent"] == "agy"
                && e["data"]["reason"] == "usage_limit"
        }));
        // The continuation is not the user's message: the work session
        // has the user's one message, Claude's answer, the switch, AGY's.
    }
    let recorded = service.continuity().get(&work_session).unwrap();
    let users = recorded.events.iter().filter(|e| e.actor == "user").count();
    assert_eq!(users, 1);

    // A restart once the lease names Claude again, mid-switch: the switch
    // ends on Claude, which gets the history again, then the message sent
    // meanwhile.
    let store = service.continuity().clone();
    let generation = store
        .begin_quiescing(&work_session, "claude", "manual")
        .unwrap();
    store.queue_during_handoff(
        &work_session,
        QueuedHandoffMessage {
            id: "q-mid".into(),
            text: "Do not lose this message".into(),
            images: vec![],
            queued_at: "2026-11-26T12:00:00.000Z".into(),
        },
    );
    store
        .mark_checkpointed(&work_session, generation, true, vec![])
        .unwrap();
    store
        .begin_starting_replacement(&work_session, generation, "claude-2", None)
        .unwrap();
    let mut moved = leases.get("w1:p1").unwrap();
    moved.insert("agent".into(), json!("claude"));
    moved.insert("session_id".into(), json!("claude-2"));
    moved.insert("handoff_phase".into(), json!("starting_replacement"));
    leases.set(moved);
    holder.cancel();
    service.dispose();

    let (restarted, leases, _holder) = make_service(
        &clock,
        spawner.clone(),
        Some(tmp.path()),
        events.clone(),
        None,
        "claude-2",
    );
    settle().await;
    // The restart resumed Claude with the history, then the message.
    let lease = leases.get("w1:p1").unwrap();
    assert!(!lease.contains_key("handoff_phase"));
    assert_eq!(spawner.count(), 3);
    let claude_written = spawner.written_of(2).join("\n");
    let history = claude_written
        .find("<roamgate-continuation from=\\\"agy\\\"")
        .expect("the history");
    let message = claude_written
        .find("Do not lose this message")
        .expect("the message");
    assert!(history < message);
    let recovered = restarted.continuity().get(&work_session).unwrap();
    assert_eq!(recovered.active_agent, "claude");
    assert!(!recovered.handoff.phase.is_switching());
}

#[tokio::test]
async fn agy_claude_agy_claude_gives_each_agent_exactly_what_it_missed() {
    let clock = VirtualClock::new();
    clock.set(1_700_000_000_000);
    let events = Arc::new(Mutex::new(Vec::new()));
    let spawner = MultiBackendSpawner::new(default_claude_responder, default_agy_responder);
    let (service, leases, _holder) =
        make_service(&clock, spawner.clone(), None, events, None, "agy-orig");
    leases.set(obj! {
        "pane_id" => "w1:p1",
        "session_id" => "agy-orig",
        "cwd" => "/repo",
        "phase" => "conversation",
        "agent" => "agy"
    });
    settle().await;
    service.subscribe(1, "w1:p1");

    service
        .send(
            "w1:p1",
            "Keep one history across agents",
            vec!["/tmp/arch.png".into()],
            Some("u-agy-1".into()),
        )
        .await
        .unwrap();
    settle().await;

    // AGY -> Claude: a new Claude session gets everything, the image inline.
    let hop1 = service
        .switch_agent("w1:p1", "claude", "manual", false)
        .await;
    settle().await;
    assert_eq!(hop1["ok"], true);
    assert_eq!(hop1["reused_session"], false);
    let claude_1 = spawner.written_of(1).join("\n");
    assert!(claude_1.contains("Keep one history across agents"));
    assert!(claude_1.contains("AGY ack: Keep one history across agents"));
    assert!(claude_1.contains("base64-for-/tmp/arch.png"));

    service
        .send(
            "w1:p1",
            "Correction: one writer during a switch",
            vec![],
            Some("u-claude-2".into()),
        )
        .await
        .unwrap();
    settle().await;

    // Claude -> AGY: AGY's own session resumes, given only what it missed.
    let hop2 = service
        .switch_agent("w1:p1", "agy", "usage_limit", false)
        .await;
    settle().await;
    assert_eq!(hop2["ok"], true);
    assert_eq!(hop2["reused_session"], true);
    let agy_2 = spawner.written_of(2).join("\n");
    assert!(agy_2.contains("\"method\":\"session/resume\""));
    assert!(agy_2.contains("\"sessionId\":\"agy-orig\""));
    assert!(agy_2.contains("Correction: one writer during a switch"));
    assert!(!agy_2.contains("[#1] User: Keep one history across agents"));

    service
        .send(
            "w1:p1",
            "Add the recovery test",
            vec![],
            Some("u-agy-3".into()),
        )
        .await
        .unwrap();
    settle().await;

    // AGY -> Claude: Claude's session resumes with AGY's turn, not again
    // the correction it had.
    let hop3 = service
        .switch_agent("w1:p1", "claude", "manual", false)
        .await;
    settle().await;
    assert_eq!(hop3["ok"], true);
    assert_eq!(hop3["reused_session"], true);
    let claude_2 = spawner.written_of(3).join("\n");
    assert!(claude_2.contains("Add the recovery test"));
    assert!(claude_2.contains("AGY ack: Add the recovery test"));
    assert!(!claude_2.contains("Correction: one writer during a switch"));

    let state = service.state("w1:p1");
    assert_eq!(state["work_session_id"], hop1["work_session_id"]);
    assert_eq!(state["work_session_id"], hop3["work_session_id"]);
    assert_eq!(state["agent"], "claude");
}
