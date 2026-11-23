//! server/src/agent/claude-mod.test.ts.

use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::{Arc, Mutex};

use serde_json::{Value, json};

use super::*;

struct Made {
    hub: ClaudeModHub,
    changes: Arc<Mutex<Vec<String>>>,
    at: Arc<AtomicI64>,
}

impl Made {
    fn advance(&self, ms: i64) {
        self.at.fetch_add(ms, Ordering::SeqCst);
    }
}

impl Drop for Made {
    fn drop(&mut self) {
        self.hub.dispose();
    }
}

fn hub_with(file: Option<std::path::PathBuf>, type_message: Option<TypeFn>) -> Made {
    let at = Arc::new(AtomicI64::new(1_000_000));
    let changes: Arc<Mutex<Vec<String>>> = Arc::default();
    let clock = at.clone();
    let sink = changes.clone();
    let hub = ClaudeModHub::new(ClaudeModOptions {
        file,
        now: Arc::new(move || clock.load(Ordering::SeqCst)),
        type_message,
        sweep_ms: 3_600_000,
        log: Some(Arc::new(|_, _| {})),
        on_change: Some(Arc::new(move |connection, pane, change| {
            sink.lock()
                .unwrap()
                .push(format!("{connection}/{pane} {}", change.as_str()))
        })),
        ..ClaudeModOptions::default()
    });
    Made { hub, changes, at }
}

fn hub() -> Made {
    hub_with(None, None)
}

fn poll_input() -> PollInput {
    PollInput {
        connection_id: "local".into(),
        pane_id: "w1-2".into(),
        session_id: "11111111-2222".into(),
        client: "c1".into(),
        claude: "2.1.319".into(),
        protocol: 1.0,
        after: 0.0,
        wait_ms: 0.0,
    }
}

fn ack(id: f64, outcome: &str, reason: &str) -> AckInput {
    AckInput {
        connection_id: "local".into(),
        pane_id: "w1-2".into(),
        client: "c1".into(),
        id,
        outcome: outcome.into(),
        reason: reason.into(),
    }
}

fn event(value: Value, client: &str) -> EventInput {
    EventInput {
        connection_id: "local".into(),
        pane_id: "w1-2".into(),
        client: client.into(),
        session_id: "11111111-2222".into(),
        event: value.as_object().unwrap().clone(),
    }
}

fn deliver(hub: &ClaudeModHub, text: &str) -> Option<i64> {
    hub.deliver("local", "w1-2", text, "").unwrap()
}

#[tokio::test]
async fn nothing_goes_to_a_pane_whose_claude_runs_no_live_mod() {
    let made = hub();
    let h = &made.hub;
    assert_eq!(deliver(h, "hello"), None);
    h.poll(poll_input()).await.unwrap();
    assert!(h.live("local", "w1-2"));
    assert_eq!(deliver(h, "hello"), Some(1));
    made.advance(60_000);
    assert!(!h.live("local", "w1-2"));
    assert_eq!(deliver(h, "late"), None);
}

#[tokio::test]
async fn a_waiting_poll_answers_as_soon_as_a_message_comes_until_acknowledged() {
    let made = hub();
    let h = made.hub.clone();
    h.poll(poll_input()).await.unwrap();
    let waiter = h.clone();
    let waiting = tokio::spawn(async move {
        waiter
            .poll(PollInput {
                wait_ms: 5_000.0,
                ..poll_input()
            })
            .await
    });
    tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    h.deliver("local", "w1-2", "first", "review").unwrap();
    let answered = waiting.await.unwrap().unwrap();
    assert_eq!(answered["protocol"], 1);
    assert_eq!(answered["messages"], json!([{"id": 1, "text": "first"}]));
    // Above the cursor only.
    let above = h
        .poll(PollInput {
            after: 1.0,
            ..poll_input()
        })
        .await
        .unwrap();
    assert_eq!(above["messages"], json!([]));
    // Not acknowledged: a mod that starts over gets it again.
    assert_eq!(
        h.poll(poll_input()).await.unwrap()["messages"],
        json!([{"id": 1, "text": "first"}])
    );
    h.ack(ack(1.0, "submitted", "")).unwrap();
    assert_eq!(h.poll(poll_input()).await.unwrap()["messages"], json!([]));
    assert_eq!(h.waiting("local", "w1-2"), 0);
}

#[tokio::test]
async fn a_newer_mod_in_the_pane_takes_it_the_older_one_is_told() {
    let made = hub();
    let h = made.hub.clone();
    h.poll(poll_input()).await.unwrap();
    deliver(&h, "for whoever runs there");
    let waiter = h.clone();
    let older = tokio::spawn(async move {
        waiter
            .poll(PollInput {
                after: 1.0,
                wait_ms: 5_000.0,
                ..poll_input()
            })
            .await
    });
    tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    let newer = h
        .poll(PollInput {
            client: "c2".into(),
            session_id: "33333333".into(),
            ..poll_input()
        })
        .await
        .unwrap();
    assert_eq!(
        newer["messages"],
        json!([{"id": 1, "text": "for whoever runs there"}])
    );
    assert_eq!(
        older.await.unwrap().unwrap(),
        json!({"protocol": 1, "superseded": true})
    );
    assert_eq!(
        h.poll(poll_input()).await.unwrap(),
        json!({"protocol": 1, "superseded": true})
    );
    assert_eq!(h.pane("local", "w1-2").unwrap()["session_id"], "33333333");
    let changes = made.changes.lock().unwrap();
    assert_eq!(changes.iter().filter(|c| c.ends_with("attach")).count(), 2);
}

#[tokio::test]
async fn what_the_mod_says_of_its_session() {
    let made = hub();
    let h = &made.hub;
    h.poll(poll_input()).await.unwrap();
    let status = || h.pane("local", "w1-2").unwrap()["status"].clone();
    h.event(event(json!({"type": "turn_start"}), "c1")).unwrap();
    assert_eq!(status(), "working");
    h.event(event(json!({"type": "blocked"}), "c1")).unwrap();
    assert_eq!(status(), "blocked");
    h.event(event(json!({"type": "unblocked"}), "c1")).unwrap();
    assert_eq!(status(), "working");
    h.event(event(
        json!({
            "type": "turn_complete",
            "reason": "error",
            "model": "claude-opus-5-5",
            "context": {"tokens": 50_000, "window": 200_000, "percent": 25},
            "rate_limits": [
                {"kind": "five_hour", "percent_used": 100, "resets_at": "2026-11-09T10:00:00Z"},
                {"kind": "seven_day", "percent_used": "lots"},
            ],
        }),
        "c1",
    ))
    .unwrap();
    let pane = h.pane("local", "w1-2").unwrap();
    assert_eq!(pane["status"], "idle");
    assert_eq!(pane["turn_reason"], "error");
    assert_eq!(pane["usage"]["model"], "claude-opus-5-5");
    assert_eq!(pane["usage"]["context"]["percent"], 25);
    assert_eq!(
        pane["usage"]["rate_limits"],
        json!([{"kind": "five_hour", "percent_used": 100, "resets_at": "2026-11-09T10:00:00Z"}])
    );
    assert!(
        made.changes
            .lock()
            .unwrap()
            .contains(&"local/w1-2 turn_complete".to_owned())
    );
    h.event(event(
        json!({"type": "bye", "reason": "prompt_input_exit"}),
        "c1",
    ))
    .unwrap();
    assert_eq!(h.pane("local", "w1-2"), None);
    assert!(!h.live("local", "w1-2"));
}

#[tokio::test]
async fn a_stop_holds_a_message_until_a_turn_starts() {
    let made = hub();
    let h = &made.hub;
    h.poll(poll_input()).await.unwrap();
    deliver(h, "held one");
    h.ack(ack(1.0, "held", "stopped")).unwrap();
    let pane = h.pane("local", "w1-2").unwrap();
    assert_eq!(
        (pane["waiting"].clone(), pane["held"].clone()),
        (json!(1), json!(1))
    );
    h.event(event(json!({"type": "turn_start"}), "c1")).unwrap();
    let pane = h.pane("local", "w1-2").unwrap();
    assert_eq!(
        (pane["waiting"].clone(), pane["held"].clone()),
        (json!(1), json!(0))
    );
    h.ack(ack(1.0, "failed", "a hook dropped it")).unwrap();
    assert_eq!(h.waiting("local", "w1-2"), 0);
}

#[tokio::test]
async fn what_a_mod_left_is_typed_once_its_agent_is_idle_unless_it_comes_back() {
    let typed: Arc<Mutex<Vec<String>>> = Arc::default();
    let answer = Arc::new(Mutex::new(ClaudeModTypeResult::Wait));
    let (sink, reply) = (typed.clone(), answer.clone());
    let made = hub_with(
        None,
        Some(Arc::new(move |_, _, text| {
            let answer = *reply.lock().unwrap();
            if answer == ClaudeModTypeResult::Typed {
                sink.lock().unwrap().push(text);
            }
            Box::pin(async move { Ok(answer) })
        })),
    );
    let h = &made.hub;
    h.poll(poll_input()).await.unwrap();
    deliver(h, "one");
    deliver(h, "two");
    // Gone but not long enough: nothing is typed.
    made.advance(60_000);
    h.sweep().await;
    assert!(typed.lock().unwrap().is_empty());
    made.advance(40_000);
    h.sweep().await;
    assert!(typed.lock().unwrap().is_empty());
    assert_eq!(h.waiting("local", "w1-2"), 2);
    // Back meanwhile: the mod has them again.
    h.poll(poll_input()).await.unwrap();
    assert!(h.live("local", "w1-2"));
    made.advance(100_000);
    *answer.lock().unwrap() = ClaudeModTypeResult::Typed;
    h.sweep().await;
    h.sweep().await;
    assert_eq!(*typed.lock().unwrap(), vec!["one", "two"]);
    assert_eq!(h.waiting("local", "w1-2"), 0);
}

#[tokio::test]
async fn a_message_for_a_pane_with_no_agent_left_is_dropped() {
    let made = hub_with(
        None,
        Some(Arc::new(|_, _, _| {
            Box::pin(async { Ok(ClaudeModTypeResult::Gone) })
        })),
    );
    let h = &made.hub;
    h.poll(poll_input()).await.unwrap();
    deliver(h, "nobody");
    h.event(event(json!({"type": "bye", "reason": "other"}), "c1"))
        .unwrap();
    h.sweep().await;
    assert_eq!(h.waiting("local", "w1-2"), 0);
}

#[tokio::test]
async fn the_inbox_and_its_ids_survive_a_restart() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("claude-mod-inbox.json");
    let first = hub_with(Some(file.clone()), None);
    first.hub.poll(poll_input()).await.unwrap();
    first
        .hub
        .deliver("local", "w1-2", "kept", "message")
        .unwrap();
    deliver(&first.hub, "taken");
    first.hub.ack(ack(2.0, "submitted", "")).unwrap();
    let epoch = first
        .hub
        .poll(PollInput {
            after: 2.0,
            ..poll_input()
        })
        .await
        .unwrap()["epoch"]
        .clone();
    first.hub.flush();
    first.hub.dispose();

    let second = hub_with(Some(file), None);
    let again = second
        .hub
        .poll(PollInput {
            client: "c9".into(),
            ..poll_input()
        })
        .await
        .unwrap();
    assert_eq!(again["epoch"], epoch);
    assert_eq!(again["messages"], json!([{"id": 1, "text": "kept"}]));
    assert_eq!(deliver(&second.hub, "next"), Some(3));
}

#[tokio::test]
async fn a_panes_inbox_is_bounded() {
    let made = hub();
    let h = &made.hub;
    h.poll(poll_input()).await.unwrap();
    for _ in 0..50 {
        deliver(h, "x");
    }
    let refused = h.deliver("local", "w1-2", "one too many", "").unwrap_err();
    assert!(refused.message.contains("50 messages already wait"));
    assert_eq!(refused.status, 429);
}

fn module(status: &str) -> Value {
    json!({
        "connection_id": "local", "pane_id": "w1-2", "session_id": "mod-session",
        "claude": "2.1.319", "protocol": 1, "waiting": 0, "held": 0,
        "since": "", "updated_at": "", "status": status,
    })
}

#[test]
fn the_mods_state_is_laid_over_herdrs_screen_detection() {
    let herdr = |status: &str, agent: &str| {
        json!({"panes": [
            {"pane_id": "w1-2", "agent": agent, "agent_status": status,
             "agent_session": {"source": "herdr:claude", "kind": "id", "value": "old"}},
            {"pane_id": "w1-3", "agent": "claude", "agent_status": "working"},
        ]})
    };
    let over = |status: &str, mod_status: &str| {
        overlay_mod_panes(
            "pane.list",
            Some(&json!({})),
            herdr(status, "claude"),
            &[module(mod_status)],
        )["panes"]
            .clone()
    };
    assert_eq!(over("working", "idle")[0]["agent_status"], "idle");
    // Idle and unseen stays done.
    assert_eq!(over("done", "idle")[0]["agent_status"], "done");
    assert_eq!(over("idle", "working")[0]["agent_status"], "working");
    // A dialog on screen during a turn is blocked.
    assert_eq!(over("blocked", "working")[0]["agent_status"], "blocked");
    assert_eq!(over("idle", "blocked")[0]["agent_status"], "blocked");
    assert_eq!(
        over("working", "idle")[0]["agent_session"],
        json!({"source": "roamgate:mod", "agent": "claude", "kind": "id", "value": "mod-session"})
    );
    // Another pane, or another agent, is left as Herdr says.
    assert_eq!(over("working", "idle")[1]["agent_status"], "working");
    let codex = overlay_mod_panes(
        "pane.list",
        Some(&json!({})),
        herdr("working", "codex"),
        &[module("idle")],
    );
    assert_eq!(codex["panes"][0]["agent_status"], "working");
    let single = overlay_mod_panes(
        "agent.get",
        Some(&json!({"target": "w1-2"})),
        json!({"agent": {"agent": "claude", "agent_status": "working"}}),
        &[module("idle")],
    );
    assert_eq!(single["agent"]["agent_status"], "idle");
}

#[tokio::test]
async fn a_mods_first_event_says_hello_too_a_replaced_one_speaks_for_nothing() {
    let made = hub();
    let h = &made.hub;
    // Before its first poll: the usage it reports at start is kept.
    let known = h
        .event(event(json!({"type": "usage", "model": "haiku"}), "c1"))
        .unwrap();
    assert_eq!(known["known"], true);
    assert_eq!(h.pane("local", "w1-2").unwrap()["usage"]["model"], "haiku");
    // A newer claude in the pane: the older one's events change nothing.
    h.poll(PollInput {
        client: "c2".into(),
        ..poll_input()
    })
    .await
    .unwrap();
    assert_eq!(
        h.event(event(json!({"type": "turn_start"}), "c1")).unwrap()["known"],
        false
    );
    assert_eq!(
        h.event(event(json!({"type": "bye", "reason": "x"}), "c1"))
            .unwrap()["known"],
        false
    );
    assert_eq!(h.pane("local", "w1-2").unwrap()["status"], "idle");
}

fn tools() -> ToolsInput {
    ToolsInput {
        connection_id: "local".into(),
        pane_id: "w1-2".into(),
        session_id: "11111111-2222".into(),
        client: "t1".into(),
        headless: false,
        gone: false,
        work: false,
        rules: false,
    }
}

#[tokio::test]
async fn a_terminal_session_has_the_tools_while_it_says_so_until_it_leaves() {
    let made = hub();
    let h = &made.hub;
    assert!(!h.has_tools("local", "w1-2"));
    h.tools(tools()).unwrap();
    assert!(h.has_tools("local", "w1-2"));
    assert!(!h.has_tools("local", "w1-3"));
    // Its hellos come every few minutes: one missed for ten, it is gone.
    made.advance(9 * 60_000);
    assert!(h.has_tools("local", "w1-2"));
    made.advance(2 * 60_000);
    assert!(!h.has_tools("local", "w1-2"));
    h.tools(tools()).unwrap();
    // Another session's goodbye changes nothing; its own does.
    h.tools(ToolsInput {
        client: "t0".into(),
        gone: true,
        ..tools()
    })
    .unwrap();
    assert!(h.has_tools("local", "w1-2"));
    h.tools(ToolsInput {
        gone: true,
        ..tools()
    })
    .unwrap();
    assert!(!h.has_tools("local", "w1-2"));
    let refused = h
        .tools(ToolsInput {
            client: String::new(),
            ..tools()
        })
        .unwrap_err();
    assert!(refused.message.contains("client id"));
    // A mod from before the Work board's tools says nothing of them.
    h.tools(tools()).unwrap();
    assert!(h.has_tools("local", "w1-2"));
    assert!(!h.has_work_tools("local", "w1-2"));
    h.tools(ToolsInput {
        work: true,
        ..tools()
    })
    .unwrap();
    assert!(h.has_work_tools("local", "w1-2"));
    h.tools(ToolsInput {
        gone: true,
        ..tools()
    })
    .unwrap();
    assert!(!h.has_work_tools("local", "w1-2"));
}

#[tokio::test]
async fn a_session_whose_system_prompt_holds_the_rules_says_so_a_mod_from_before_says_nothing() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("claude-mod-inbox.json");
    let first = hub_with(Some(file.clone()), None);
    first
        .hub
        .tools(ToolsInput {
            work: true,
            ..tools()
        })
        .unwrap();
    assert!(!first.hub.has_rules("local", "w1-2"));
    first
        .hub
        .tools(ToolsInput {
            work: true,
            rules: true,
            headless: true,
            ..tools()
        })
        .unwrap();
    assert!(first.hub.has_rules("local", "w1-2"));
    assert!(!first.hub.has_rules("local", "w1-3"));
    first.hub.flush();
    first.hub.dispose();
    // Kept with the headless session across a restart.
    let second = hub_with(Some(file), None);
    assert!(second.hub.has_rules("local", "w1-2"));
    second
        .hub
        .tools(ToolsInput {
            gone: true,
            ..tools()
        })
        .unwrap();
    assert!(!second.hub.has_rules("local", "w1-2"));
}

#[tokio::test]
async fn a_headless_sessions_tools_outlive_its_process_and_a_restart() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("claude-mod-inbox.json");
    let first = hub_with(Some(file.clone()), None);
    first
        .hub
        .tools(ToolsInput {
            headless: true,
            ..tools()
        })
        .unwrap();
    first
        .hub
        .tools(ToolsInput {
            pane_id: "w1-3".into(),
            client: "t2".into(),
            ..tools()
        })
        .unwrap();
    first.hub.flush();
    first.hub.dispose();

    let second = hub_with(Some(file), None);
    // Stopped when idle, started again with the same tools.
    second.advance(24 * 60 * 60_000);
    assert!(second.hub.has_tools("local", "w1-2"));
    // A terminal session's hello is long stale.
    assert!(!second.hub.has_tools("local", "w1-3"));
    second.advance(7 * 24 * 60 * 60_000);
    assert!(!second.hub.has_tools("local", "w1-2"));
}
