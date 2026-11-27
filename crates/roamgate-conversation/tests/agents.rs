//! Conversation mode with two agents behind the service: AGY over ACP
//! (handshake, streaming, tool calls, permission prompts) next to Claude.

use std::sync::{Arc, Mutex};

use roamgate_agents::obj;
use roamgate_agy::agy_driver;
use roamgate_claude::conversation::claude_driver;
use roamgate_conversation::driver::{BoxFuture, Drivers, HeadlessProcess};
use roamgate_conversation::headless::{HeadlessSpawnOptions, SpawnHeadless};
use roamgate_conversation::images::ConversationImage;
use roamgate_conversation::lease::{LeaseOptions, LeaseStore};
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

fn make_service(
    clock: &VirtualClock,
    spawner: Arc<dyn SpawnHeadless>,
    events: Arc<Mutex<Vec<Obj>>>,
    permission_answer: Option<Value>,
    initial_session_id: &str,
) -> (ConversationService, LeaseStore, CancellationToken) {
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
        file: None,
        clock: clock.shared(),
        data: None,
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
