//! The queue and steers, showing a workspace, and scheduled runs over
//! workspaces closed or connections down since the task was saved.

use sha2::{Digest, Sha256};

use super::*;
use crate::wire::is_snapshot;

fn texts(snapshot: &Value) -> Vec<Value> {
    snapshot["messages"]
        .as_array()
        .unwrap()
        .iter()
        .map(|m| m["text"].clone())
        .collect()
}

fn queue_ids(snapshot: &Value) -> Vec<Value> {
    snapshot["queue"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|item| item["id"].clone())
        .collect()
}

fn queue_empty(snapshot: &Value) -> bool {
    snapshot["queue"].as_array().is_none_or(Vec::is_empty)
}

fn ids(value: &Value) -> Vec<String> {
    value
        .as_array()
        .into_iter()
        .flatten()
        .map(|r| r["workspace_id"].as_str().unwrap_or("").to_owned())
        .collect()
}

fn identity(label: &str) -> String {
    hex::encode(Sha256::digest(label.as_bytes()))
}

fn prompt_at(prompts: &Arc<Mutex<Vec<String>>>, index: usize) -> String {
    prompts.lock().unwrap()[index].clone()
}

#[tokio::test]
async fn queued_follow_ups_wait_for_the_answer_and_are_admitted_in_order() {
    let gate = Deferred::<()>::new();
    let prompts = list::<String>();
    let (g, p) = (gate.clone(), prompts.clone());
    let f = setup_driver(move |d| {
        d.set_run(move |input| {
            let (gate, prompts) = (g.clone(), p.clone());
            async move {
                let n = {
                    let mut prompts = prompts.lock().unwrap();
                    prompts.push(input.text().to_owned());
                    prompts.len()
                };
                if n == 1 {
                    gate.wait().await?;
                }
                input.message(&format!("Answer {n}"));
                Ok(vec![json!({"persisted": true})])
            }
        });
    });
    f.handle("configure", json!({"config": configured()}))
        .await
        .unwrap();
    f.handle("send", json!({"text": "First", "request_id": "first"}))
        .await
        .unwrap();
    for (text, id) in [
        ("Second", "second"),
        ("Second", "second"),
        ("Third", "third"),
    ] {
        f.handle(
            "send",
            json!({"text": text, "request_id": id, "when_busy": "queue"}),
        )
        .await
        .unwrap();
    }
    assert_matches(
        &f.peek()["queue"],
        json!([
            {"id": "second", "mode": "follow_up", "text": "Second"},
            {"id": "third", "mode": "follow_up", "text": "Third"},
        ]),
    );
    assert!(is_snapshot(&f.peek()));
    assert_err(
        f.handle("send", json!({"text": "Busy", "request_id": "busy"}))
            .await,
        "Ranger is busy",
    );
    gate.resolve(());
    until(|| {
        let peek = f.peek();
        peek["running"] == false && peek["messages"].as_array().unwrap().len() == 6
    })
    .await;
    assert_eq!(f.peek()["queue"], json!([]));
    // Draining between turns never reports the queue as held.
    assert!(!f.snapshots().iter().any(|s| s["queue_held"] == true));
    assert_eq!(
        texts(&f.peek()),
        vec![
            json!("First"),
            json!("Answer 1"),
            json!("Second"),
            json!("Answer 2"),
            json!("Third"),
            json!("Answer 3"),
        ]
    );
    assert!(prompt_at(&prompts, 1).contains("User message:\nSecond"));
    assert!(prompt_at(&prompts, 1).contains("Authorized workspace scope"));
    f.finish().await;
}

#[tokio::test]
async fn the_scope_and_receipts_go_once_per_context_said_unchanged_after_whole_again_on_a_fresh_one()
 {
    let prompts = list::<String>();
    let fresh = flag();
    let (p, fr) = (prompts.clone(), fresh.clone());
    let f = setup_driver(move |d| {
        d.set_run(move |input| {
            let (prompts, fresh) = (p.clone(), fr.clone());
            async move {
                let n = {
                    let mut prompts = prompts.lock().unwrap();
                    prompts.push(input.text().to_owned());
                    prompts.len()
                };
                input.message(&format!("Answer {n}"));
                // A context the driver could not keep starts empty.
                Ok(if fresh.load(Ordering::SeqCst) {
                    vec![]
                } else {
                    vec![json!({"persisted": n})]
                })
            }
        });
    });
    f.handle("configure", json!({"config": configured()}))
        .await
        .unwrap();
    let ask = |text: &'static str| {
        let f = &f;
        async move {
            f.handle("send", json!({"text": text, "request_id": text}))
                .await
                .unwrap();
            until(|| f.peek()["running"] == false).await;
        }
    };
    ask("First").await;
    let full = "Authorized workspace scope for this turn (only these IDs may be read or used as action targets):\n[";
    assert!(prompt_at(&prompts, 0).contains(full));
    assert!(prompt_at(&prompts, 0).contains(
        "Recorded operation outcomes (server receipts, not proof of task completion):\n"
    ));
    ask("Second").await;
    let second = prompt_at(&prompts, 1);
    assert!(
        second.contains(
            "Authorized workspace scope for this turn: unchanged since your previous turn"
        )
    );
    assert!(second.contains("Recorded operation outcomes: none new since your previous turn."));
    assert!(second.contains("User message:\nSecond"));
    assert!(second.encode_utf16().count() < prompt_at(&prompts, 0).encode_utf16().count());
    // The context comes back empty: the next turn gets them whole.
    fresh.store(true, Ordering::SeqCst);
    ask("Third").await;
    ask("Fourth").await;
    assert!(prompt_at(&prompts, 3).contains(full));
    f.finish().await;
}

#[tokio::test]
async fn a_steer_joins_the_running_turn_and_its_reply_follows_it() {
    let gate = Deferred::<()>::new();
    let steers = list::<(String, String)>();
    let started = flag();
    let had_steers = slot::<bool>();
    let (g, s, st, hs) = (
        gate.clone(),
        steers.clone(),
        started.clone(),
        had_steers.clone(),
    );
    let pushed = steers.clone();
    let f = setup_driver(move |d| {
        d.set_run(move |input| {
            let (gate, steers, started, had) = (g.clone(), s.clone(), st.clone(), hs.clone());
            async move {
                *had.lock().unwrap() = Some(input.input.steers.is_some());
                started.store(true, Ordering::SeqCst);
                input.message("Before");
                gate.wait().await?;
                let text = steers.lock().unwrap()[0].0.clone();
                input.emit(RunEvent::Steered {
                    request_id: Some("steer".into()),
                    text,
                });
                input.tool("after", "workspace_status", "completed", None);
                input.message("After");
                Ok(vec![json!({"persisted": true})])
            }
        });
        d.set_steer(move |text, id| {
            pushed.lock().unwrap().push((text, id));
            async { Ok(()) }
        });
    });
    f.handle("configure", json!({"config": configured()}))
        .await
        .unwrap();
    f.handle("send", json!({"text": "First", "request_id": "first"}))
        .await
        .unwrap();
    until(|| started.load(Ordering::SeqCst)).await;
    assert_eq!(*had_steers.lock().unwrap(), Some(false));
    f.handle(
        "send",
        json!({"text": "Use the other branch", "request_id": "steer", "when_busy": "steer"}),
    )
    .await
    .unwrap();
    until(|| steers.lock().unwrap().len() == 1).await;
    let (text, id) = steers.lock().unwrap()[0].clone();
    assert_eq!(id, "steer");
    assert!(text.contains("Steering message from the user"));
    assert!(text.contains("User message:\nUse the other branch"));
    assert_matches(
        &f.peek()["queue"],
        json!([{"id": "steer", "mode": "steer"}]),
    );
    assert_err(
        f.handle("queue.remove", json!({"id": "steer"})).await,
        "already steering",
    );
    assert_matches(
        &f.saved()["active_run"]["steers"],
        json!([{"request_id": "steer"}]),
    );
    gate.resolve(());
    until(|| f.peek()["running"] == false).await;
    let messages = f.peek()["messages"].clone();
    let pairs: Vec<(Value, Value)> = messages
        .as_array()
        .unwrap()
        .iter()
        .map(|m| (m["role"].clone(), m["text"].clone()))
        .collect();
    assert_eq!(
        pairs,
        vec![
            (json!("user"), json!("First")),
            (json!("assistant"), json!("Before")),
            (json!("user"), json!("Use the other branch")),
            (json!("assistant"), json!("After")),
        ]
    );
    assert_eq!(messages[1]["tools"], json!([]));
    assert_matches(&messages[3]["tools"], json!([{"id": "after"}]));
    assert_eq!(f.peek()["queue"], json!([]));
    // The placed steer is a sent request now, never queued again.
    f.handle(
        "send",
        json!({"text": "Use the other branch", "request_id": "steer"}),
    )
    .await
    .unwrap();
    assert_eq!(f.peek()["messages"].as_array().unwrap().len(), 4);
    f.finish().await;
}

#[tokio::test]
async fn stopping_holds_unsent_messages_keeps_them_across_restarts_and_resumes_on_request() {
    let prompts = list::<String>();
    let p = prompts.clone();
    let f = setup_driver(move |d| {
        d.set_run(move |input| {
            let prompts = p.clone();
            async move {
                let n = {
                    let mut prompts = prompts.lock().unwrap();
                    prompts.push(input.text().to_owned());
                    prompts.len()
                };
                if n == 1 {
                    input.signal.cancelled().await;
                } else {
                    input.message("Resumed");
                }
                Ok(vec![json!({"persisted": true})])
            }
        });
        d.set_steer(|_, _| async { Err(plain_err("Ranger finished this turn")) });
    });
    f.handle("configure", json!({"config": configured()}))
        .await
        .unwrap();
    f.handle("send", json!({"text": "First", "request_id": "first"}))
        .await
        .unwrap();
    until(|| prompts.lock().unwrap().len() == 1).await;
    f.handle(
        "send",
        json!({"text": "Late steer", "request_id": "late", "when_busy": "steer"}),
    )
    .await
    .unwrap();
    until(|| f.peek()["queue"][0]["mode"] == "follow_up").await;
    f.handle(
        "send",
        json!({"text": "Drop me", "request_id": "drop", "when_busy": "queue"}),
    )
    .await
    .unwrap();
    f.handle("stop", json!({})).await.unwrap();
    until(|| f.peek()["running"] == false).await;
    flush_tasks().await;
    assert_eq!(prompts.lock().unwrap().len(), 1);
    assert_eq!(queue_ids(&f.peek()), vec![json!("late"), json!("drop")]);
    assert_eq!(f.peek()["queue_held"], true);
    f.handle("queue.remove", json!({"id": "drop"}))
        .await
        .unwrap();
    f.service.dispose().await;
    let restored = f.restart(f.driver.clone());
    assert_matches(
        &restored.snapshot().await.unwrap()["queue"],
        json!([{"id": "late", "mode": "follow_up", "text": "Late steer"}]),
    );
    flush_tasks().await;
    assert_eq!(prompts.lock().unwrap().len(), 1);
    restored.handle("queue.resume", json!({})).await.unwrap();
    until(|| restored.peek()["running"] == false).await;
    assert!(prompt_at(&prompts, 1).contains("User message:\nLate steer"));
    assert_eq!(restored.peek()["queue"], json!([]));
    assert_eq!(last_message(&restored.peek())["text"], "Resumed");
    f.finish().await;
}

/// The fixture of the three tests where a preview blocks a follow-up.
fn previewing(gate: Arc<Deferred<()>>, prompts: Arc<Mutex<Vec<String>>>) -> Fixture {
    let f = setup_driver(move |d| {
        d.set_run(move |input| {
            let (gate, prompts) = (gate.clone(), prompts.clone());
            async move {
                let n = {
                    let mut prompts = prompts.lock().unwrap();
                    prompts.push(input.text().to_owned());
                    prompts.len()
                };
                if n == 1 {
                    input
                        .propose(
                            "create_tab",
                            json!({"connection_id": "local", "workspace_id": "ws", "cwd": "/repo"}),
                        )
                        .await?;
                    gate.wait().await?;
                }
                input.message("Done");
                Ok(vec![json!({"persisted": true})])
            }
        });
    });
    f.context.set_prepare(|_, _, _| async {
        Ok(permission_action(|| async {
            Ok(json!({"status": "succeeded", "detail": "Created"}))
        }))
    });
    f
}

async fn preview_then_follow_up(
    f: &Fixture,
    gate: &Deferred<()>,
    prompts: &Arc<Mutex<Vec<String>>>,
) {
    f.handle("configure", json!({"config": configured()}))
        .await
        .unwrap();
    f.handle("send", json!({"text": "Make a tab", "request_id": "tab"}))
        .await
        .unwrap();
    f.handle(
        "send",
        json!({"text": "Then report", "request_id": "next", "when_busy": "queue"}),
    )
    .await
    .unwrap();
    gate.resolve(());
    until(|| f.peek()["running"] == false).await;
    flush_tasks().await;
    assert_eq!(prompts.lock().unwrap().len(), 1);
}

fn first_action(snapshot: &Value) -> Value {
    snapshot["messages"]
        .as_array()
        .unwrap()
        .iter()
        .flat_map(|m| m["actions"].as_array().cloned().unwrap_or_default())
        .next()
        .unwrap()
}

#[tokio::test]
async fn a_queued_follow_up_waits_while_an_action_preview_needs_review() {
    let (gate, prompts) = (Deferred::<()>::new(), list::<String>());
    let f = previewing(gate.clone(), prompts.clone());
    preview_then_follow_up(&f, &gate, &prompts).await;
    let action = last_message(&f.peek())["actions"][0].clone();
    assert_eq!(action["status"], "pending");
    f.handle("action.confirm", json!({"action_id": action["id"]}))
        .await
        .unwrap();
    until(|| prompts.lock().unwrap().len() == 2 && f.peek()["running"] == false).await;
    assert!(prompt_at(&prompts, 1).contains("User message:\nThen report"));
    f.finish().await;
}

#[tokio::test]
async fn a_queued_follow_up_is_retried_when_its_blocking_preview_is_cancelled_as_unavailable() {
    let (gate, prompts) = (Deferred::<()>::new(), list::<String>());
    let f = previewing(gate.clone(), prompts.clone());
    preview_then_follow_up(&f, &gate, &prompts).await;
    let action = last_message(&f.peek())["actions"][0].clone();
    // The target workspace is gone when the preview is confirmed.
    f.context.set_catalog(|| async {
        Ok(json!({"workspaces": [], "errors": [], "complete_connection_ids": ["local"]}))
    });
    f.handle("action.confirm", json!({"action_id": action["id"]}))
        .await
        .unwrap();
    assert_eq!(first_action(&f.peek())["status"], "cancelled");
    // Nothing awaits review now, so the queue tries the follow-up at once;
    // it is held with a reason because its own scope is gone too.
    until(|| {
        f.peek()["error"]
            .as_str()
            .is_some_and(|e| e.contains("queued message"))
    })
    .await;
    assert_eq!(prompts.lock().unwrap().len(), 1);
    assert_matches(&f.peek()["queue"], json!([{"id": "next"}]));
    f.finish().await;
}

#[tokio::test]
async fn saving_settings_that_cancel_a_blocking_preview_sends_the_waiting_follow_up() {
    let (gate, prompts) = (Deferred::<()>::new(), list::<String>());
    let f = previewing(gate.clone(), prompts.clone());
    preview_then_follow_up(&f, &gate, &prompts).await;
    f.handle("configure", json!({"config": configured()}))
        .await
        .unwrap();
    assert_eq!(first_action(&f.peek())["status"], "cancelled");
    until(|| prompts.lock().unwrap().len() == 2 && f.peek()["running"] == false).await;
    assert!(prompt_at(&prompts, 1).contains("User message:\nThen report"));
    f.finish().await;
}

#[tokio::test]
async fn a_follow_up_cannot_be_removed_once_its_admission_has_started() {
    let gate = Deferred::<()>::new();
    let admitting = Deferred::<()>::new();
    let release = Deferred::<()>::new();
    let prompts = list::<String>();
    let (g, p) = (gate.clone(), prompts.clone());
    let f = setup_driver(move |d| {
        d.set_run(move |input| {
            let (gate, prompts) = (g.clone(), p.clone());
            async move {
                let n = {
                    let mut prompts = prompts.lock().unwrap();
                    prompts.push(input.text().to_owned());
                    prompts.len()
                };
                if n == 1 {
                    gate.wait().await?;
                }
                input.message("Done");
                Ok(vec![json!({"persisted": true})])
            }
        });
    });
    let capture = f.context.capture_fn();
    let (a, r, p) = (admitting.clone(), release.clone(), prompts.clone());
    f.context.set_capture(move |refs| {
        let (capture, admitting, release, prompts) =
            (capture.clone(), a.clone(), r.clone(), p.clone());
        async move {
            if prompts.lock().unwrap().len() == 1 {
                admitting.resolve(());
                release.wait().await?;
            }
            capture(refs).await
        }
    });
    f.handle("configure", json!({"config": configured()}))
        .await
        .unwrap();
    f.handle("send", json!({"text": "First", "request_id": "first"}))
        .await
        .unwrap();
    f.handle(
        "send",
        json!({"text": "Second", "request_id": "second", "when_busy": "queue"}),
    )
    .await
    .unwrap();
    gate.resolve(());
    admitting.wait().await.unwrap();
    // Removal waits behind the send in the queue's worker, then finds it gone.
    let service = f.service.clone();
    let removal = tokio::spawn(async move {
        service
            .handle("queue.remove", json!({"id": "second"}))
            .await
    });
    flush_tasks().await;
    release.resolve(());
    assert_err(removal.await.unwrap(), "already sent");
    until(|| prompts.lock().unwrap().len() == 2 && f.peek()["running"] == false).await;
    assert!(prompt_at(&prompts, 1).contains("User message:\nSecond"));
    assert_eq!(f.peek()["queue"], json!([]));
    f.finish().await;
}

#[tokio::test]
async fn concurrent_steers_reach_the_turn_in_queue_order_and_follow_a_missed_one() {
    let gate = Deferred::<()>::new();
    let binding = Deferred::<()>::new();
    let release = Deferred::<()>::new();
    let steered = list::<String>();
    let fail_binding = flag();
    let started = flag();
    let (g, st, sd) = (gate.clone(), started.clone(), steered.clone());
    let f = setup_driver(move |d| {
        d.set_run(move |input| {
            let (gate, started) = (g.clone(), st.clone());
            async move {
                started.store(true, Ordering::SeqCst);
                gate.wait().await?;
                input.message("Done");
                Ok(vec![json!({"persisted": true})])
            }
        });
        d.set_steer(move |_, id| {
            sd.lock().unwrap().push(id);
            async { Ok(()) }
        });
    });
    let (b, r, fb) = (binding.clone(), release.clone(), fail_binding.clone());
    f.context.set_bind(move |_captured, targets| {
        let (binding, release, fail) = (b.clone(), r.clone(), fb.clone());
        async move {
            binding.resolve(());
            release.wait().await?;
            if fail.load(Ordering::SeqCst) {
                return Err(plain_err("Unavailable"));
            }
            Ok(targets)
        }
    });
    f.handle("configure", json!({"config": configured()}))
        .await
        .unwrap();
    f.handle("send", json!({"text": "First", "request_id": "first"}))
        .await
        .unwrap();
    until(|| started.load(Ordering::SeqCst)).await;
    // The earlier steer is slow to bind its mention; the later one waits.
    let service = f.service.clone();
    let slow = tokio::spawn(async move {
        service
            .handle(
                "send",
                json!({
                    "text": "Check @Codex now", "mentions": [agent_marker()],
                    "request_id": "mentioned", "when_busy": "steer",
                }),
            )
            .await
    });
    binding.wait().await.unwrap();
    let service = f.service.clone();
    let quick = tokio::spawn(async move {
        service
            .handle(
                "send",
                json!({"text": "Then the tests", "request_id": "plain", "when_busy": "steer"}),
            )
            .await
    });
    flush_tasks().await;
    assert!(steered.lock().unwrap().is_empty());
    release.resolve(());
    slow.await.unwrap().unwrap();
    quick.await.unwrap().unwrap();
    assert_eq!(*steered.lock().unwrap(), vec!["mentioned", "plain"]);
    gate.resolve(());
    until(|| f.peek()["running"] == false).await;

    // A steer that cannot bind its mention misses the turn; a later steer
    // follows it into the queue rather than overtaking it.
    let second = Deferred::<()>::new();
    started.store(false, Ordering::SeqCst);
    let (s2, st) = (second.clone(), started.clone());
    f.driver.set_run(move |input| {
        let (second, started) = (s2.clone(), st.clone());
        async move {
            started.store(true, Ordering::SeqCst);
            second.wait().await?;
            input.message("Done");
            Ok(vec![json!({"persisted": true})])
        }
    });
    fail_binding.store(true, Ordering::SeqCst);
    f.handle("send", json!({"text": "Again", "request_id": "again"}))
        .await
        .unwrap();
    until(|| started.load(Ordering::SeqCst)).await;
    f.handle(
        "send",
        json!({
            "text": "Check @Codex now", "mentions": [agent_marker()],
            "request_id": "unbound", "when_busy": "steer",
        }),
    )
    .await
    .unwrap();
    f.handle(
        "send",
        json!({"text": "Then the tests", "request_id": "after", "when_busy": "steer"}),
    )
    .await
    .unwrap();
    assert_eq!(*steered.lock().unwrap(), vec!["mentioned", "plain"]);
    assert_matches(
        &f.peek()["queue"],
        json!([
            {"id": "unbound", "mode": "follow_up"},
            {"id": "after", "mode": "follow_up"},
        ]),
    );
    second.resolve(());
    f.finish().await;
}

#[tokio::test]
async fn a_steer_that_needs_a_workspace_the_turn_did_not_admit_waits_as_a_follow_up() {
    let gate = Deferred::<()>::new();
    let steered = list::<String>();
    let started = flag();
    let (g, st, sd) = (gate.clone(), started.clone(), steered.clone());
    let f = setup_driver(move |d| {
        d.set_run(move |input| {
            let (gate, started) = (g.clone(), st.clone());
            async move {
                started.store(true, Ordering::SeqCst);
                gate.wait().await?;
                input.message("Done");
                Ok(vec![json!({"persisted": true})])
            }
        });
        d.set_steer(move |_, id| {
            sd.lock().unwrap().push(id);
            async { Ok(()) }
        });
    });
    f.handle("configure", json!({"config": configured()}))
        .await
        .unwrap();
    f.handle("send", json!({"text": "First", "request_id": "first"}))
        .await
        .unwrap();
    until(|| started.load(Ordering::SeqCst)).await;
    let admitted = json!({"connection_id": "local", "workspace_id": "ws"});
    f.handle(
        "send",
        json!({"text": "Same scope", "scope": [admitted], "request_id": "same", "when_busy": "steer"}),
    )
    .await
    .unwrap();
    f.handle(
        "send",
        json!({
            "text": "Also check the new workspace",
            "scope": [admitted, {"connection_id": "local", "workspace_id": "new"}],
            "request_id": "wider", "when_busy": "steer",
        }),
    )
    .await
    .unwrap();
    assert_eq!(*steered.lock().unwrap(), vec!["same"]);
    assert_matches(
        &f.peek()["queue"],
        json!([
            {"id": "same", "mode": "steer"},
            {"id": "wider", "mode": "follow_up"},
        ]),
    );
    gate.resolve(());
    f.finish().await;
}

#[test]
fn a_task_s_configuration_is_the_same_whatever_the_order_of_its_fields() {
    let allowed = json!([{"connection_id": "local", "workspace_id": "w1"}]);
    // As saved when Ranger is allowed every workspace, and as read back.
    let saved = json!({
        "provider": "claude-code", "model": "opus", "credential_source": "pi",
        "allowed_workspaces": allowed, "approval_mode": "auto", "workspace_scope": "all",
    });
    let loaded = json!({
        "provider": "claude-code", "model": "opus", "credential_source": "pi",
        "allowed_workspaces": allowed, "workspace_scope": "all", "approval_mode": "auto",
    });
    use roamgate_agents::js;
    assert_ne!(js::stringify(&saved), js::stringify(&loaded));
    assert!(same_assistant_config(&saved, &loaded));
    assert!(!same_assistant_config(
        &saved,
        &merge(&loaded, json!({"model": "sonnet"}))
    ));
    assert!(!same_assistant_config(
        &saved,
        &merge(&loaded, json!({"allowed_workspaces": []}))
    ));
}

/// What the Claude Code driver says of an interrupted turn it will not
/// replay (claude-driver.ts).
const CLAUDE_INTERRUPTED: &str = "The Claude Code turn was interrupted. It was not retried because an operation may already have run. Review the action receipts and send a new question.";

#[tokio::test]
async fn an_interrupted_claude_turn_fails_closed_through_service_recovery_and_holds_queued_messages()
 {
    let stopped = Deferred::<()>::new();
    let pointer =
        json!({"type": "ranger-claude", "session": "0b0e8a52-7a4b-4c55-9d3e-2f4a8a1c9d10"});
    let (s1, s2, p) = (stopped.clone(), stopped.clone(), pointer.clone());
    let f = setup_driver(move |d| {
        d.set_catalog(|_| async {
            Ok(json!({
                "providers": [{"id": "claude-code", "label": "Claude Code", "configured": true, "methods": []}],
                "models": [{"provider": "claude-code", "id": "opus", "label": "Opus"}],
            }))
        });
        d.set_run(move |input| {
            let (stopped, pointer) = (s1.clone(), p.clone());
            async move {
                input.checkpoint(vec![pointer.clone()]).await?;
                stopped.wait().await?;
                Ok(vec![pointer])
            }
        });
        d.set_dispose(move || {
            s2.resolve(());
            async { Ok(()) }
        });
    });
    f.context.stable_task_identity();
    f.handle(
        "configure",
        merge(
            &configured(),
            json!({"provider": "claude-code", "model": "opus"}),
        ),
    )
    .await
    .unwrap();
    f.handle(
        "send",
        json!({"request_id": "interrupted-claude", "text": "Perform the operation"}),
    )
    .await
    .unwrap();
    until(|| {
        std::fs::read_to_string(f.state_path())
            .ok()
            .and_then(|t| serde_json::from_str::<Value>(&t).ok())
            .is_some_and(|s| s["entries"][0]["type"] == "ranger-claude")
    })
    .await;
    f.handle(
        "send",
        json!({"request_id": "queued-claude", "text": "Then continue", "when_busy": "queue"}),
    )
    .await
    .unwrap();
    f.service.dispose().await;
    // The Claude driver's recovery: a CLI session pointer has no durable MCP
    // result journal, so the interrupted turn is never replayed.
    let spawned = counter();
    let driver = f.driver.copy();
    let count_spawn = spawned.clone();
    driver.set_run(move |input| {
        let spawned = count_spawn.clone();
        async move {
            let claude = input
                .input
                .entries
                .iter()
                .any(|entry| entry["type"] == "ranger-claude");
            if input.input.recover && claude {
                input.checkpoint(vec![]).await?;
                return Err(user_err(CLAUDE_INTERRUPTED));
            }
            bump(&spawned);
            Err(plain_err("must not replay"))
        }
    });
    driver.set_stop(|| async { Ok(()) });
    driver.set_dispose(|| async { Ok(()) });
    let restored = f.restart(driver);
    restored.resume().await.unwrap();
    until(|| restored.peek()["running"] == false).await;
    assert!(
        restored.peek()["error"]
            .as_str()
            .is_some_and(|e| e.contains("was not retried"))
    );
    assert_eq!(restored.peek()["queue_held"], true);
    assert_eq!(count(&spawned), 0);
    let saved = f.saved();
    assert_eq!(saved["entries"], json!([]));
    assert!(saved.get("active_run").is_none());
    assert!(f.context.reads().is_empty());
    f.finish().await;
}

#[tokio::test]
async fn records_what_the_reply_showed_with_the_question_that_asked() {
    let results = list::<String>();
    let r = results.clone();
    let f = setup_driver(move |d| {
        d.set_run(move |input| {
            let results = r.clone();
            async move {
                let shown = input
                    .show(
                        json!({"connection_id": "local", "workspace_id": "ws", "pane_id": "ws:p2"}),
                    )
                    .await?;
                results.lock().unwrap().push(shown.text);
                input.message("Here it is.");
                Ok(vec![])
            }
        });
    });
    f.handle("configure", json!({"config": configured()}))
        .await
        .unwrap();
    f.handle("send", json!({"request_id": "go-1", "text": "Go to it"}))
        .await
        .unwrap();
    until(|| f.peek()["running"] == false).await;
    assert_eq!(
        last_message(&f.peek())["show"],
        json!({"connection_id": "local", "workspace_id": "ws", "pane_id": "ws:p2", "request_id": "go-1"})
    );
    assert_eq!(
        *results.lock().unwrap(),
        vec!["Shown in the user's Roamgate window."]
    );
    assert!(is_snapshot(&f.peek()));
    f.finish().await;
}

#[tokio::test]
async fn refuses_a_workspace_outside_the_question_s_scope() {
    let refused = slot::<String>();
    let r = refused.clone();
    let f = setup_driver(move |d| {
        d.set_run(move |input| {
            let refused = r.clone();
            async move {
                if let Err(error) = input
                    .show(json!({"connection_id": "desktop", "workspace_id": "other"}))
                    .await
                {
                    *refused.lock().unwrap() = Some(error.message().to_owned());
                }
                Ok(vec![])
            }
        });
    });
    f.handle("configure", json!({"config": configured()}))
        .await
        .unwrap();
    f.handle("send", json!({"request_id": "go-2", "text": "Go there"}))
        .await
        .unwrap();
    until(|| f.peek()["running"] == false).await;
    assert_eq!(
        refused.lock().unwrap().as_deref(),
        Some("That workspace is outside this question's authorized scope.")
    );
    assert!(last_message(&f.peek()).get("show").is_none());
    f.finish().await;
}

/// A child driver that answers "Checked", with the given entries.
fn checking(offered: Option<Arc<Mutex<Vec<bool>>>>, entries: Vec<Value>) -> ChildDriver {
    Arc::new(move || {
        let driver = FakeDriver::new();
        let (offered, entries) = (offered.clone(), entries.clone());
        driver.set_run(move |input| {
            let (offered, entries) = (offered.clone(), entries.clone());
            async move {
                if let Some(offered) = offered {
                    offered
                        .lock()
                        .unwrap()
                        .push(input.input.handlers.show.is_some());
                }
                input.message("Checked");
                Ok(entries)
            }
        });
        driver
    })
}

fn with_child(child: ChildDriver) -> Fixture {
    setup_with(
        |_| {},
        Setup {
            child: Some(child),
            ..Setup::default()
        },
    )
}

#[tokio::test]
async fn a_scheduled_task_run_has_nothing_to_show_anything_in() {
    let offered = list::<bool>();
    let f = with_child(checking(Some(offered.clone()), vec![]));
    f.use_fake_timers(None);
    f.context.stable_task_identity();
    f.handle("configure", json!({"config": configured()}))
        .await
        .unwrap();
    let created = f
        .handle(
            "task.create",
            json!({
                "request_id": uuid(), "title": "Check", "prompt": "Check",
                "scope": allowed(), "schedule": {"type": "interval", "minutes": 1},
            }),
        )
        .await
        .unwrap();
    f.service.resume().await.unwrap();
    f.handle(
        "task.run_now",
        json!({"task_id": created["tasks"][0]["id"]}),
    )
    .await
    .unwrap();
    f.advance(0).await;
    flush_tasks().await;
    assert_eq!(*offered.lock().unwrap(), vec![false]);
    f.finish().await;
}

/// The catalog and capture of a listing the test changes.
fn listing(f: &Fixture, listed: Arc<Mutex<Vec<Value>>>, truncated: Option<Arc<AtomicBool>>) {
    let l = listed.clone();
    f.context.set_catalog(move || {
        let mut catalog = json!({"workspaces": l.lock().unwrap().clone(), "errors": []});
        if let Some(truncated) = &truncated {
            catalog["truncated"] = json!(truncated.load(Ordering::SeqCst));
        }
        async move { Ok(catalog) }
    });
    f.context.set_capture(move |scope| {
        let listed = listed.lock().unwrap().clone();
        async move {
            scope
                .as_array()
                .unwrap()
                .iter()
                .map(|r| {
                    listed
                        .iter()
                        .find(|item| item["workspace_id"] == r["workspace_id"])
                        .cloned()
                        .ok_or_else(|| plain_err("Unknown workspace"))
                })
                .collect::<AssistantResult<Vec<Value>>>()
                .map(Value::Array)
        }
    });
}

fn two_allowed() -> Value {
    json!({"config": merge(&configured(), json!({
        "allowed_workspaces": [
            {"connection_id": "local", "workspace_id": "ws"},
            {"connection_id": "local", "workspace_id": "ws2"},
        ],
    }))})
}

#[tokio::test]
async fn a_task_over_all_workspaces_runs_over_those_ranger_may_use_when_it_starts() {
    let f = with_child(checking(None, vec![json!({"persisted": true})]));
    f.use_fake_timers(None);
    f.context.stable_task_identity();
    let second = merge(
        &workspace(),
        json!({"workspace_id": "ws2", "label": "Second"}),
    );
    let hidden = merge(
        &workspace(),
        json!({"workspace_id": "ws3", "label": "Not allowed"}),
    );
    let listed = list::<Value>();
    *listed.lock().unwrap() = vec![workspace()];
    listing(&f, listed.clone(), None);
    f.handle("configure", json!({"config": configured()}))
        .await
        .unwrap();
    let created = f
        .handle(
            "task.create",
            json!({
                "request_id": uuid(), "title": "Check every agent", "prompt": "Check every agent",
                "scope": allowed(), "all_workspaces": true,
                "schedule": {"type": "interval", "minutes": 60},
            }),
        )
        .await
        .unwrap();
    let task_id = created["tasks"][0]["id"].clone();
    assert_eq!(created["tasks"][0]["all_workspaces"], true);
    // A workspace created since, allowed in Ranger's settings; another not.
    *listed.lock().unwrap() = vec![workspace(), second, hidden];
    f.handle("configure", two_allowed()).await.unwrap();
    f.service.resume().await.unwrap();
    f.handle("task.run_now", json!({"task_id": task_id}))
        .await
        .unwrap();
    f.advance(0).await;
    flush_tasks().await;
    let detail = f
        .service
        .task_detail(json!({"task_id": task_id}))
        .await
        .unwrap();
    assert_ne!(detail["runs"][0]["status"], "failed");
    assert_eq!(ids(&detail["task"]["scope"]), vec!["ws", "ws2"]);
    assert_eq!(ids(&detail["task"]["workspaces"]), vec!["ws", "ws2"]);
    f.finish().await;
}

#[tokio::test]
async fn a_run_over_all_workspaces_says_when_workspaces_past_the_limit_were_left_out() {
    let f = with_child(checking(None, vec![json!({"persisted": true})]));
    f.use_fake_timers(None);
    f.context.stable_task_identity();
    let second = merge(
        &workspace(),
        json!({"workspace_id": "ws2", "label": "Second"}),
    );
    let truncated = flag();
    let listed = list::<Value>();
    *listed.lock().unwrap() = vec![workspace()];
    listing(&f, listed.clone(), Some(truncated.clone()));
    f.handle("configure", json!({"config": configured()}))
        .await
        .unwrap();
    let created = f
        .handle(
            "task.create",
            json!({
                "request_id": uuid(), "title": "Check every agent", "prompt": "Check every agent",
                "scope": allowed(), "all_workspaces": true,
                "schedule": {"type": "interval", "minutes": 60},
            }),
        )
        .await
        .unwrap();
    let task_id = created["tasks"][0]["id"].clone();
    f.service.resume().await.unwrap();
    f.handle("task.run_now", json!({"task_id": task_id}))
        .await
        .unwrap();
    f.advance(0).await;
    flush_tasks().await;
    let detail = f
        .service
        .task_detail(json!({"task_id": task_id}))
        .await
        .unwrap();
    assert_eq!(detail["runs"][0]["status"], "succeeded");
    assert!(detail["runs"][0].get("notice").is_none());

    *listed.lock().unwrap() = vec![workspace(), second];
    f.handle("configure", two_allowed()).await.unwrap();
    // A granted workspace a truncated listing did not reach.
    *listed.lock().unwrap() = vec![workspace()];
    truncated.store(true, Ordering::SeqCst);
    f.handle("task.run_now", json!({"task_id": task_id}))
        .await
        .unwrap();
    f.advance(0).await;
    flush_tasks().await;
    let detail = f
        .service
        .task_detail(json!({"task_id": task_id}))
        .await
        .unwrap();
    assert_eq!(detail["runs"][0]["status"], "succeeded");
    assert!(
        detail["runs"][0]["notice"]
            .as_str()
            .is_some_and(|n| n.contains("may have left out"))
    );
    f.finish().await;
}

// ------------------------------------------------------------ closed since

fn second() -> Value {
    merge(
        &workspace(),
        json!({"workspace_id": "ws2", "label": "Second"}),
    )
}

fn third() -> Value {
    merge(
        &workspace(),
        json!({"workspace_id": "ws3", "label": "Third"}),
    )
}

struct ThreeState {
    listed: Vec<Value>,
    boot: String,
}

/// `threeWorkspaceTask(high)`.
struct Three {
    f: Fixture,
    state: Arc<Mutex<ThreeState>>,
    task_id: Value,
    restored: Arc<Mutex<Vec<Vec<String>>>>,
}

async fn run_now(
    f: &Fixture,
    task_id: &Value,
    restored: &Mutex<Vec<Vec<String>>>,
) -> Option<String> {
    restored.lock().unwrap().clear();
    let outcome = f
        .handle("task.run_now", json!({"task_id": task_id}))
        .await
        .err()
        .map(|error| error.message().to_owned());
    f.advance(0).await;
    flush_tasks().await;
    outcome
}

async fn latest(f: &Fixture, task_id: &Value) -> Value {
    f.service
        .task_detail(json!({"task_id": task_id}))
        .await
        .unwrap()["runs"][0]
        .clone()
}

impl Three {
    async fn run_now(&self) -> Option<String> {
        run_now(&self.f, &self.task_id, &self.restored).await
    }

    async fn detail(&self) -> Value {
        self.f
            .service
            .task_detail(json!({"task_id": self.task_id}))
            .await
            .unwrap()
    }

    fn last_restored(&self) -> Option<Vec<String>> {
        self.restored.lock().unwrap().last().cloned()
    }

    fn set_listed(&self, listed: Vec<Value>) {
        self.state.lock().unwrap().listed = listed;
    }
}

async fn three_workspace_task(high: bool) -> Three {
    let f = with_child(checking(None, vec![json!({"persisted": true})]));
    f.use_fake_timers(None);
    f.context.stable_task_identity();
    let state = Arc::new(Mutex::new(ThreeState {
        listed: vec![workspace(), second(), third()],
        boot: "original-server".into(),
    }));
    // A checkout's identity: one per name, so a recreated one keeps it.
    let s = state.clone();
    f.context.set_recovery(move |captured| {
        let boot = s.lock().unwrap().boot.clone();
        async move {
            Ok(Value::Array(
                captured
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|r| {
                        json!({
                            "connection_id": r["connection_id"],
                            "workspace_id": r["workspace_id"],
                            "endpoint_fingerprint": "a".repeat(64),
                            "workspace_identity": identity(r["label"].as_str().unwrap_or("")),
                            "herdr_boot_id": boot,
                        })
                    })
                    .collect(),
            ))
        }
    });
    let restored = list::<Vec<String>>();
    let (s, r) = (state.clone(), restored.clone());
    f.context.set_restore(move |targets| {
        let (state, restored) = (s.clone(), r.clone());
        async move {
            let targets = targets.as_array().cloned().unwrap_or_default();
            let state = state.lock().unwrap();
            // As the real one: one connection's targets share a server
            // identity, and a target checked on another Herdr boot is refused.
            let boots: std::collections::HashSet<String> = targets
                .iter()
                .map(|t| t["herdr_boot_id"].as_str().unwrap_or("").to_owned())
                .collect();
            if boots.len() > 1 {
                return Err(plain_err(
                    "Inconsistent Ranger recovery connection identity: the workspaces on Local were checked on different Herdr servers",
                ));
            }
            if targets.iter().any(|t| t["herdr_boot_id"] != state.boot.as_str()) {
                return Err(AssistantError::server_restarted("Local"));
            }
            restored.lock().unwrap().push(ids(&Value::Array(targets.clone())));
            Ok(Value::Array(
                targets
                    .iter()
                    .map(|t| {
                        state
                            .listed
                            .iter()
                            .find(|item| item["workspace_id"] == t["workspace_id"])
                            .cloned()
                            .unwrap_or(json!({}))
                    })
                    .collect(),
            ))
        }
    });
    let s = state.clone();
    f.context.set_catalog(move || {
        let listed = s.lock().unwrap().listed.clone();
        async move {
            Ok(json!({
                "workspaces": listed, "errors": [],
                "connection_ids": ["local"], "complete_connection_ids": ["local"],
            }))
        }
    });
    let s = state.clone();
    f.context.set_capture(move |scope| {
        let listed = s.lock().unwrap().listed.clone();
        async move {
            scope
                .as_array()
                .unwrap()
                .iter()
                .map(|r| {
                    listed
                        .iter()
                        .find(|item| item["workspace_id"] == r["workspace_id"])
                        .cloned()
                        .ok_or_else(|| plain_err("Unknown workspace"))
                })
                .collect::<AssistantResult<Vec<Value>>>()
                .map(Value::Array)
        }
    });
    let scope: Vec<Value> = ["ws", "ws2", "ws3"]
        .iter()
        .map(|id| json!({"connection_id": "local", "workspace_id": id}))
        .collect();
    f.handle(
        "configure",
        json!({"config": merge(&configured(), json!({"allowed_workspaces": scope}))}),
    )
    .await
    .unwrap();
    if high {
        f.handle(
            "configure_approval",
            json!({"approval_mode": "auto", "workspace_scope": "all"}),
        )
        .await
        .unwrap();
    }
    let created = f
        .handle(
            "task.create",
            json!({
                "request_id": uuid(), "title": "Check", "prompt": "Check", "scope": scope,
                "schedule": {"type": "interval", "minutes": 60},
            }),
        )
        .await
        .unwrap();
    f.service.resume().await.unwrap();
    let task_id = created["tasks"][0]["id"].clone();
    Three {
        f,
        state,
        task_id,
        restored,
    }
}

const HOUR: u64 = 60 * 60_000;

#[tokio::test]
async fn runs_over_those_still_open_and_names_the_one_it_skipped() {
    let t = three_workspace_task(false).await;
    t.set_listed(vec![workspace(), second()]);
    assert_eq!(t.run_now().await, None);
    let detail = t.detail().await;
    assert_eq!(detail["runs"][0]["status"], "succeeded");
    assert_eq!(
        detail["runs"][0]["notice"],
        "Skipped a workspace no longer open: Local / Third (closed). Edit the task to update its workspaces."
    );
    assert_eq!(t.last_restored(), Some(vec!["ws".into(), "ws2".into()]));
    // The task keeps its workspaces for the user to update.
    assert_eq!(ids(&detail["task"]["scope"]), vec!["ws", "ws2", "ws3"]);
    t.f.finish().await;
}

#[tokio::test]
async fn says_when_a_skipped_workspace_was_recreated_rather_than_using_it() {
    let t = three_workspace_task(true).await;
    t.set_listed(vec![
        workspace(),
        second(),
        merge(&third(), json!({"workspace_id": "ws4"})),
    ]);
    assert_eq!(t.run_now().await, None);
    let detail = t.detail().await;
    assert_eq!(detail["runs"][0]["status"], "succeeded");
    assert!(
        detail["runs"][0]["notice"]
            .as_str()
            .unwrap()
            .contains("Local / Third (recreated as ws4)")
    );
    assert_eq!(t.last_restored(), Some(vec!["ws".into(), "ws2".into()]));
    t.f.finish().await;
}

#[tokio::test]
async fn fails_naming_them_when_none_is_open_any_more() {
    let t = three_workspace_task(false).await;
    t.set_listed(vec![]);
    assert_eq!(
        t.run_now().await.as_deref(),
        Some(
            "None of the task's workspaces is open any more: Local / Workspace (closed), Local / Second (closed), Local / Third (closed). Edit the task to choose its workspaces again."
        )
    );
    // A scheduled run fails the same way.
    t.f.advance(HOUR).await;
    flush_tasks().await;
    let detail = t.detail().await;
    assert_eq!(detail["runs"][0]["status"], "failed");
    assert!(
        detail["runs"][0]["error"]
            .as_str()
            .unwrap()
            .contains("None of the task's workspaces is open any more: Local / Workspace (closed)")
    );
    t.f.finish().await;
}

#[tokio::test]
async fn a_scheduled_run_after_herdr_restarted_finds_its_workspaces_again() {
    let t = three_workspace_task(false).await;
    t.state.lock().unwrap().boot = "restarted-server".into();
    t.f.advance(HOUR).await;
    flush_tasks().await;
    let detail = t.detail().await;
    assert_eq!(detail["runs"][0]["status"], "succeeded");
    assert_eq!(
        detail["runs"][0]["notice"],
        "Herdr on Local restarted since the task was saved: its workspaces were checked again."
    );
    assert_eq!(
        t.last_restored(),
        Some(vec!["ws".into(), "ws2".into(), "ws3".into()])
    );
    // The task keeps them under the new server identity: no notice again.
    t.f.advance(HOUR).await;
    flush_tasks().await;
    let detail = t.detail().await;
    assert_eq!(detail["runs"][0]["status"], "succeeded");
    assert!(detail["runs"][0].get("notice").is_none());
    t.f.finish().await;
}

#[tokio::test]
async fn run_now_after_herdr_restarted_skips_an_id_that_now_holds_another_workspace() {
    let t = three_workspace_task(false).await;
    {
        let mut state = t.state.lock().unwrap();
        state.boot = "restarted-server".into();
        state.listed = vec![
            workspace(),
            second(),
            merge(&third(), json!({"label": "Elsewhere"})),
        ];
    }
    assert_eq!(t.run_now().await, None);
    let detail = t.detail().await;
    assert_eq!(detail["runs"][0]["status"], "succeeded");
    assert_eq!(
        detail["runs"][0]["notice"],
        "Herdr on Local restarted since the task was saved: its workspaces were checked again. Skipped a workspace no longer open: Local / Third (its id now holds another workspace). Edit the task to update its workspaces."
    );
    assert_eq!(t.last_restored(), Some(vec!["ws".into(), "ws2".into()]));
    t.f.finish().await;
}

#[tokio::test]
async fn the_next_run_checks_again_an_id_skipped_after_herdr_restarted() {
    let t = three_workspace_task(false).await;
    // Herdr restarted and the id of Third now holds another workspace: the
    // task keeps Third under the old server identity, the others under the
    // new one.
    {
        let mut state = t.state.lock().unwrap();
        state.boot = "restarted-server".into();
        state.listed = vec![
            workspace(),
            second(),
            merge(&third(), json!({"label": "Elsewhere"})),
        ];
    }
    let skipped = "Skipped a workspace no longer open: Local / Third (its id now holds another workspace). Edit the task to update its workspaces.";
    let notice = |detail: &Value| {
        detail["runs"][0]["notice"]
            .as_str()
            .unwrap_or("")
            .to_owned()
    };
    assert_eq!(t.run_now().await, None);
    assert!(notice(&t.detail().await).contains(skipped));
    // The next run, with the host up, checks Third again on its own rather
    // than failing on the two server identities of one connection.
    assert_eq!(t.run_now().await, None);
    let detail = t.detail().await;
    assert_eq!(detail["runs"][0]["status"], "succeeded");
    assert!(notice(&detail).contains(skipped));
    assert_eq!(t.last_restored(), Some(vec!["ws".into(), "ws2".into()]));
    // A scheduled run too.
    t.f.advance(HOUR).await;
    flush_tasks().await;
    let detail = t.detail().await;
    assert_eq!(detail["runs"][0]["status"], "succeeded");
    assert!(notice(&detail).contains(skipped));
    assert_eq!(t.last_restored(), Some(vec!["ws".into(), "ws2".into()]));
    t.f.finish().await;
}

#[tokio::test]
async fn still_fails_when_ranger_may_no_longer_use_one_still_open() {
    let t = three_workspace_task(false).await;
    t.f.handle("configure", two_allowed()).await.unwrap();
    assert_eq!(
        t.run_now().await.as_deref(),
        Some("The original task permission is unavailable for Local / Third (no longer allowed).")
    );
    t.f.advance(HOUR).await;
    flush_tasks().await;
    let detail = t.detail().await;
    assert_eq!(detail["runs"][0]["status"], "failed");
    assert_eq!(
        detail["runs"][0]["error"],
        "The task could not safely start: The original task permission is unavailable for Local / Third (no longer allowed)."
    );
    assert!(t.restored.lock().unwrap().is_empty());
    t.f.finish().await;
}

// ------------------------------------------------------------ connection down

fn desktop(id: &str, label: &str) -> Value {
    merge(
        &workspace(),
        json!({"connection_id": "desktop", "connection_label": "Desktop", "workspace_id": id, "label": label}),
    )
}

#[derive(Clone, Copy, PartialEq)]
enum FailChild {
    No,
    Armed,
    Next,
}

struct TwoState {
    boot: std::collections::HashMap<String, String>,
    connections: Vec<(String, Value)>,
    restore_error: Option<String>,
    fail_child: FailChild,
    all: Vec<Value>,
}

impl TwoState {
    fn ready(&self, id: &str) -> bool {
        self.connections
            .iter()
            .any(|(c, s)| c == id && s["state"] == "ready")
    }
}

type Listeners = Arc<Mutex<Vec<(u64, Arc<dyn Fn() + Send + Sync>)>>>;

/// `twoConnectionTask(options)`.
struct Two {
    f: Fixture,
    state: Arc<Mutex<TwoState>>,
    task_id: Value,
    restored: Arc<Mutex<Vec<Vec<String>>>>,
    listeners: Listeners,
}

impl Two {
    async fn run_now(&self) -> Option<String> {
        run_now(&self.f, &self.task_id, &self.restored).await
    }

    async fn latest(&self) -> Value {
        latest(&self.f, &self.task_id).await
    }

    fn set_connection(&self, id: &str, state: &str, error: Option<&str>) {
        {
            let mut s = self.state.lock().unwrap();
            let mut value = json!({
                "label": if id == "local" { "Local" } else { "Desktop" },
                "state": state,
            });
            if let Some(error) = error {
                value["error"] = json!(error);
            }
            for (c, v) in &mut s.connections {
                if c == id {
                    *v = value.clone();
                }
            }
        }
        let listeners: Vec<_> = self
            .listeners
            .lock()
            .unwrap()
            .iter()
            .map(|(_, l)| l.clone())
            .collect();
        for listener in listeners {
            listener();
        }
    }

    fn last_restored(&self) -> Option<Vec<String>> {
        self.restored.lock().unwrap().last().cloned()
    }
}

async fn two_connection_task(fail_catalog: Option<Arc<AtomicBool>>) -> Two {
    let child: ChildDriver = Arc::new(|| {
        let driver = FakeDriver::new();
        driver.set_run(|input| async move {
            input.message("Checked");
            Ok(vec![json!({"persisted": true})])
        });
        driver
    });
    let f = setup_with(
        move |d| {
            if let Some(fail) = fail_catalog {
                d.set_catalog(move |_| {
                    let fail = fail.load(Ordering::SeqCst);
                    async move {
                        if fail {
                            return Err(plain_err("token sk-SECRET expired"));
                        }
                        Ok(catalog())
                    }
                });
            }
        },
        Setup {
            child: Some(child),
            ..Setup::default()
        },
    );
    f.use_fake_timers(None);
    let state = Arc::new(Mutex::new(TwoState {
        boot: [
            ("local".to_owned(), "local-server".to_owned()),
            ("desktop".to_owned(), "desktop-server".to_owned()),
        ]
        .into(),
        connections: vec![
            ("local".into(), json!({"label": "Local", "state": "ready"})),
            (
                "desktop".into(),
                json!({"label": "Desktop", "state": "ready"}),
            ),
        ],
        restore_error: None,
        fail_child: FailChild::No,
        all: vec![workspace(), desktop("d1", "Build"), desktop("d2", "Docs")],
    }));
    let listeners: Listeners = Arc::default();
    let s = state.clone();
    f.context.set_state(move |id| {
        s.lock()
            .unwrap()
            .connections
            .iter()
            .find(|(c, _)| c == id)
            .map(|(_, v)| v.clone())
    });
    let l = listeners.clone();
    let next_id = Arc::new(AtomicUsize::new(0));
    f.context.set_watch(move |listener| {
        let id = next_id.fetch_add(1, Ordering::SeqCst) as u64;
        l.lock().unwrap().push((id, listener));
        let l = l.clone();
        Box::new(move || l.lock().unwrap().retain(|(k, _)| *k != id))
    });
    let s = state.clone();
    f.context.set_catalog(move || {
        let state = s.lock().unwrap();
        let workspaces: Vec<Value> = state
            .all
            .iter()
            .filter(|item| state.ready(item["connection_id"].as_str().unwrap()))
            .cloned()
            .collect();
        let complete: Vec<&str> = ["local", "desktop"]
            .into_iter()
            .filter(|id| state.ready(id))
            .collect();
        let catalog = json!({
            "workspaces": workspaces, "errors": [],
            "connection_ids": ["local", "desktop"], "complete_connection_ids": complete,
        });
        async move { Ok(catalog) }
    });
    let s = state.clone();
    f.context.set_capture(move |scope| {
        let result = {
            let state = s.lock().unwrap();
            scope
                .as_array()
                .unwrap()
                .iter()
                .map(|r| {
                    let connection = r["connection_id"].as_str().unwrap_or("");
                    if !state.ready(connection) {
                        return Err(plain_err(&format!("Connection {connection} is not ready")));
                    }
                    state
                        .all
                        .iter()
                        .find(|item| {
                            item["connection_id"] == r["connection_id"]
                                && item["workspace_id"] == r["workspace_id"]
                        })
                        .cloned()
                        .ok_or_else(|| plain_err("Unknown workspace"))
                })
                .collect::<AssistantResult<Vec<Value>>>()
                .map(Value::Array)
        };
        async move { result }
    });
    let s = state.clone();
    f.context.set_recovery(move |captured| {
        let state = s.lock().unwrap();
        let targets: Vec<Value> = captured
            .as_array()
            .unwrap()
            .iter()
            .map(|r| {
                json!({
                    "connection_id": r["connection_id"],
                    "workspace_id": r["workspace_id"],
                    "endpoint_fingerprint": "a".repeat(64),
                    "workspace_identity": identity(r["label"].as_str().unwrap_or("")),
                    "herdr_boot_id": state.boot[r["connection_id"].as_str().unwrap()],
                })
            })
            .collect();
        async move { Ok(Value::Array(targets)) }
    });
    let restored = list::<Vec<String>>();
    let (s, r) = (state.clone(), restored.clone());
    f.context.set_restore(move |targets| {
        let result = (|| {
            let mut state = s.lock().unwrap();
            if let Some(error) = &state.restore_error {
                return Err(plain_err(error));
            }
            if state.fail_child == FailChild::Next {
                return Err(plain_err("Connection Desktop is not ready"));
            }
            if state.fail_child == FailChild::Armed {
                state.fail_child = FailChild::Next;
            }
            let targets = targets.as_array().cloned().unwrap_or_default();
            for target in &targets {
                let connection = target["connection_id"].as_str().unwrap_or("");
                if !state.ready(connection) {
                    return Err(not_ready(&format!("Connection {connection} is not ready")));
                }
                // As the real one: one connection's targets share a server identity.
                if target["herdr_boot_id"] != state.boot[connection].as_str() {
                    return Err(plain_err(
                        "Inconsistent Ranger recovery connection identity",
                    ));
                }
            }
            r.lock().unwrap().push(ids(&Value::Array(targets.clone())));
            Ok(Value::Array(
                targets
                    .iter()
                    .map(|t| {
                        state
                            .all
                            .iter()
                            .find(|item| {
                                item["connection_id"] == t["connection_id"]
                                    && item["workspace_id"] == t["workspace_id"]
                            })
                            .cloned()
                            .unwrap()
                    })
                    .collect(),
            ))
        })();
        async move { result }
    });
    let scope: Vec<Value> = state.lock().unwrap().all.iter().map(ref_of).collect();
    f.handle(
        "configure",
        json!({"config": merge(&configured(), json!({"allowed_workspaces": scope}))}),
    )
    .await
    .unwrap();
    // As the user's: High, so a workspace closed for a run stays allowed.
    f.handle(
        "configure_approval",
        json!({"approval_mode": "auto", "workspace_scope": "all"}),
    )
    .await
    .unwrap();
    let created = f
        .handle(
            "task.create",
            json!({
                "request_id": uuid(), "title": "Check", "prompt": "Check", "scope": scope,
                "schedule": {"type": "interval", "minutes": 60},
            }),
        )
        .await
        .unwrap();
    f.service.resume().await.unwrap();
    restored.lock().unwrap().clear();
    let task_id = created["tasks"][0]["id"].clone();
    Two {
        f,
        state,
        task_id,
        restored,
        listeners,
    }
}

const SSH_DOWN: &str = "ssh exited 255: ssh: connect to host desktop port 22: Operation timed out";

#[tokio::test]
async fn waits_for_it_then_runs_without_its_workspaces_and_says_why() {
    let t = two_connection_task(None).await;
    t.set_connection("desktop", "reconnecting", Some(SSH_DOWN));
    assert_eq!(t.run_now().await, None);
    // Still waiting for it: neither failed nor run. Run now only checked
    // what it can reach.
    assert_eq!(t.latest().await["status"], "running");
    assert_eq!(*t.restored.lock().unwrap(), vec![vec!["ws".to_owned()]]);
    t.f.advance(TASK_CONNECTION_WAIT_MS - 1_000).await;
    flush_tasks().await;
    assert_eq!(t.latest().await["status"], "running");
    t.f.advance(1_000).await;
    flush_tasks().await;
    let run = t.latest().await;
    assert_eq!(run["status"], "succeeded");
    assert_eq!(
        run["notice"],
        format!(
            "Desktop unreachable: 2 workspaces skipped (connection: reconnecting, {SSH_DOWN})."
        )
    );
    assert_eq!(t.last_restored(), Some(vec!["ws".into()]));
    t.f.finish().await;
}

#[tokio::test]
async fn a_scheduled_run_covers_it_when_it_comes_back_within_the_wait() {
    let t = two_connection_task(None).await;
    t.set_connection("desktop", "error", Some(SSH_DOWN));
    t.f.advance(HOUR).await;
    flush_tasks().await;
    assert_eq!(t.latest().await["status"], "running");
    t.f.advance(90_000).await;
    t.set_connection("desktop", "connecting", None);
    flush_tasks().await;
    assert!(t.restored.lock().unwrap().is_empty());
    t.set_connection("desktop", "ready", None);
    flush_tasks().await;
    let run = t.latest().await;
    assert_eq!(run["status"], "succeeded");
    assert!(run.get("notice").is_none());
    assert_eq!(
        t.last_restored(),
        Some(vec!["ws".into(), "d1".into(), "d2".into()])
    );
    t.f.finish().await;
}

#[tokio::test]
async fn one_the_user_disconnected_is_skipped_without_waiting() {
    let t = two_connection_task(None).await;
    t.set_connection("desktop", "disconnected", None);
    assert_eq!(t.run_now().await, None);
    let run = t.latest().await;
    assert_eq!(run["status"], "succeeded");
    assert_eq!(
        run["notice"],
        "Desktop unreachable: 2 workspaces skipped (connection: disconnected)."
    );
    assert_eq!(t.last_restored(), Some(vec!["ws".into()]));
    t.f.finish().await;
}

#[tokio::test]
async fn fails_naming_the_connections_when_none_can_be_reached() {
    let t = two_connection_task(None).await;
    t.set_connection("desktop", "reconnecting", Some(SSH_DOWN));
    t.set_connection("local", "connecting", None);
    // Run now does not refuse it: the run waits for them first.
    assert_eq!(t.run_now().await, None);
    assert_eq!(t.latest().await["status"], "running");
    t.f.advance(TASK_CONNECTION_WAIT_MS).await;
    flush_tasks().await;
    let run = t.latest().await;
    assert_eq!(run["status"], "failed");
    assert_eq!(
        run["error"],
        format!(
            "The task could not safely start: None of the task's workspaces can be reached: Local unreachable: a workspace skipped (connection: connecting); Desktop unreachable: 2 workspaces skipped (connection: reconnecting, {SSH_DOWN})."
        )
    );
    assert!(t.restored.lock().unwrap().is_empty());
    t.f.finish().await;
}

#[tokio::test]
async fn checks_a_workspace_kept_under_an_older_herdr_again_with_the_others() {
    let t = two_connection_task(None).await;
    // The Desktop Herdr restarted and the id of Docs now holds another
    // workspace: the task keeps it under the old server identity, Build
    // under the new one.
    {
        let mut state = t.state.lock().unwrap();
        state
            .boot
            .insert("desktop".into(), "desktop-restarted".into());
        state.all[2] = merge(&state.all[2], json!({"label": "Elsewhere"}));
    }
    let skipped = "Skipped a workspace no longer open: Desktop / Docs (its id now holds another workspace). Edit the task to update its workspaces.";
    assert_eq!(t.run_now().await, None);
    assert_eq!(
        t.latest().await["notice"],
        format!(
            "Herdr on Desktop restarted since the task was saved: its workspaces were checked again. {skipped}"
        )
    );
    let detail =
        t.f.service
            .task_detail(json!({"task_id": t.task_id}))
            .await
            .unwrap();
    let boots: std::collections::HashSet<String> =
        ids(&detail["task"]["workspaces"]).into_iter().collect();
    assert_eq!(
        boots,
        ["ws", "d1", "d2"].into_iter().map(String::from).collect()
    );
    // The next run checks Docs again on its own, rather than failing on the
    // two server identities of one connection.
    assert_eq!(t.run_now().await, None);
    let run = t.latest().await;
    assert_eq!(run["status"], "succeeded");
    assert!(run["notice"].as_str().unwrap().contains(skipped));
    assert_eq!(t.last_restored(), Some(vec!["ws".into(), "d1".into()]));
    // And with Desktop down, as on the morning it failed.
    t.set_connection("desktop", "error", Some(SSH_DOWN));
    assert_eq!(t.run_now().await, None);
    t.f.advance(TASK_CONNECTION_WAIT_MS).await;
    flush_tasks().await;
    let run = t.latest().await;
    assert_eq!(run["status"], "succeeded");
    assert_eq!(
        run["notice"],
        format!("Desktop unreachable: 2 workspaces skipped (connection: error, {SSH_DOWN}).")
    );
    assert_eq!(t.last_restored(), Some(vec!["ws".into()]));
    t.f.finish().await;
}

#[tokio::test]
async fn names_what_failed_instead_of_a_generic_message() {
    let fail_catalog = flag();
    let t = two_connection_task(Some(fail_catalog.clone())).await;
    // A workspace check: the workspace context's own message.
    t.state.lock().unwrap().restore_error =
        Some("Ranger recovery endpoint changed: connection Desktop now points elsewhere".into());
    assert_eq!(
        t.run_now().await.as_deref(),
        Some(
            "The task's workspaces could not be checked: Ranger recovery endpoint changed: connection Desktop now points elsewhere."
        )
    );
    t.f.advance(HOUR).await;
    flush_tasks().await;
    assert_eq!(
        t.latest().await["error"],
        "The task could not safely start: The task's workspaces could not be checked: Ranger recovery endpoint changed: connection Desktop now points elsewhere."
    );
    t.state.lock().unwrap().restore_error = None;
    // The model provider: named, without what it said.
    fail_catalog.store(true, Ordering::SeqCst);
    t.f.advance(HOUR).await;
    flush_tasks().await;
    let run = t.latest().await;
    assert_eq!(
        run["error"],
        "The task could not safely start: The models of test could not be listed. Check its sign-in in Ranger's settings."
    );
    assert!(!run["error"].as_str().unwrap().contains("SECRET"));
    fail_catalog.store(false, Ordering::SeqCst);
    // The run's own start.
    t.state.lock().unwrap().fail_child = FailChild::Armed;
    t.f.advance(HOUR).await;
    flush_tasks().await;
    let run = t.latest().await;
    assert_eq!(run["status"], "failed");
    assert_eq!(
        run["error"],
        "The task could not safely start: Ranger could not start the run: A workspace Ranger may read could not be opened: its server may be offline or restarting. Try again."
    );
    assert_eq!(t.f.peek()["error"], Value::Null);
    t.f.finish().await;
}
