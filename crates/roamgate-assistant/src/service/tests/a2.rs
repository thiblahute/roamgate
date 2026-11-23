//! The "Ranger scheduled task service" cases of service.test.ts: model
//! edits and task admission, notifications, task tools, child runs and
//! their recovery.

use super::*;
use roamgate_agents::js;
use roamgate_base::clock::{Clock, SystemClock};

use crate::wire::is_snapshot;

/// A child driver whose run waits on `done` (the TS `catalog, login, stop,
/// dispose` of a child, all resolving).
fn child_driver(run: impl Fn(Input) -> Fut<Vec<Value>> + Send + Sync + 'static) -> Arc<FakeDriver> {
    let driver = FakeDriver::new();
    *driver.run.lock().unwrap() = Arc::new(run);
    driver
}

fn task_input(title: &str, prompt: &str, scope: Value, schedule: Value) -> Value {
    json!({
        "request_id": uuid(),
        "title": title,
        "prompt": prompt,
        "scope": scope,
        "schedule": schedule,
    })
}

fn first_task_id(snapshot: &Value) -> String {
    snapshot["tasks"][0]["id"].as_str().unwrap().to_owned()
}

#[tokio::test]
async fn model_connection_edits_defer_task_admission_and_cannot_replace_credentials_during_an_active_task()
 {
    let editing = Deferred::<()>::new();
    let saved = Deferred::<()>::new();
    let finished = Deferred::<()>::new();
    let calls = counter();
    let (e, s) = (editing.clone(), saved.clone());
    let (fin, c) = (finished.clone(), calls.clone());
    let child: ChildDriver = Arc::new(move || {
        let driver = FakeDriver::new();
        let (f1, f2, f3, c) = (fin.clone(), fin.clone(), fin.clone(), c.clone());
        driver.set_stop(move || {
            let f = f1.clone();
            async move {
                f.resolve(());
                Ok(())
            }
        });
        driver.set_dispose(move || {
            let f = f2.clone();
            async move {
                f.resolve(());
                Ok(())
            }
        });
        driver.set_run(move |input| {
            let (f, c) = (f3.clone(), c.clone());
            async move {
                bump(&c);
                let _ = f.wait().await;
                input.message("Done");
                Ok(vec![])
            }
        });
        driver
    });
    let f = setup_with(
        move |d| {
            d.set_configure(move |_, _| {
                let (e, s) = (e.clone(), s.clone());
                async move {
                    e.resolve(());
                    let _ = s.wait().await;
                    Ok(())
                }
            });
        },
        Setup {
            child: Some(child),
            fake_now: Some("2026-10-05T00:00:00Z"),
            ..Setup::default()
        },
    );
    f.context.stable_task_identity();
    f.handle("configure", configured()).await.unwrap();
    let task = f
        .handle(
            "task.create",
            task_input(
                "Scheduled check",
                "Check later",
                allowed(),
                json!({"type": "interval", "minutes": 60}),
            ),
        )
        .await
        .unwrap();
    f.service.resume().await.unwrap();
    f.handle("task.run_now", json!({"task_id": first_task_id(&task)}))
        .await
        .unwrap();
    let connection = json!({
        "provider": "custom-endpoint",
        "model": "model",
        "base_url": "http://localhost:1234/v1",
        "api": "openai-completions",
        "api_key": "synthetic-key",
        "credential_source": "assistant",
    });
    let service = f.service.clone();
    let params = connection.clone();
    let edit = tokio::spawn(async move { service.handle("configure_model", params).await });
    editing.wait().await.unwrap();
    f.advance(0).await;
    for _ in 0..5 {
        flush_tasks().await;
    }
    assert_eq!(count(&calls), 0);
    assert_eq!(f.peek()["tasks"][0]["current_run"]["status"], "queued");
    saved.resolve(());
    edit.await.unwrap().unwrap();
    f.advance(5000).await;
    for _ in 0..5 {
        flush_tasks().await;
    }
    assert_eq!(count(&calls), 1);
    assert_eq!(f.peek()["tasks"][0]["current_run"]["status"], "running");
    assert_err(
        f.handle("configure_model", connection).await,
        "Stop the running Ranger task",
    );
    finished.resolve(());
    for _ in 0..5 {
        flush_tasks().await;
    }
    f.finish().await;
}

#[tokio::test]
async fn task_creation_explains_when_a_connection_lacks_a_stable_boot_identity() {
    let f = setup();
    f.context.stable_task_identity();
    f.context.set_recovery(|_| async { Ok(json!([])) });
    f.handle("configure", json!({"config": configured()}))
        .await
        .unwrap();
    assert_err(
        f.handle(
            "task.create",
            json!({
                "title": "Watch merge requests",
                "prompt": "Check for new merge requests",
                "scope": allowed(),
                "schedule": {"type": "interval", "minutes": 30},
                "request_id": uuid(),
            }),
        )
        .await,
        "the endpoint handshake did not provide a stable Herdr boot identity",
    );
    assert!(
        f.peek()["tasks"]
            .as_array()
            .is_none_or(|tasks| tasks.is_empty())
    );
    f.finish().await;
}

/// Resolves `deferred` once the turn's signal aborts
/// (`input.signal.addEventListener("abort", ...)`).
fn on_abort(input: &Input, deferred: &Arc<Deferred<Vec<Value>>>) {
    let (signal, deferred) = (input.signal.clone(), deferred.clone());
    tokio::spawn(async move {
        signal.cancelled().await;
        deferred.resolve(vec![]);
    });
}

fn resolving(
    deferred: &Arc<Deferred<Vec<Value>>>,
    value: Vec<Value>,
) -> impl Fn() -> Fut<()> + Send + Sync + 'static {
    let deferred = deferred.clone();
    move || {
        deferred.resolve(value.clone());
        ok(())
    }
}

#[tokio::test]
async fn confirmed_monitoring_tasks_send_custom_notifications_and_retain_context_without_routine_poll_alerts()
 {
    let inputs = list::<Input>();
    let results = list::<Value>();
    let (seen, recorded) = (inputs.clone(), results.clone());
    let child: ChildDriver = Arc::new(move || {
        let (seen, recorded) = (seen.clone(), recorded.clone());
        child_driver(move |input| {
            let (seen, recorded) = (seen.clone(), recorded.clone());
            Box::pin(async move {
                let n = {
                    let mut seen = seen.lock().unwrap();
                    seen.push(input.clone());
                    seen.len()
                };
                input.read("status", json!({})).await?;
                let early = n < 3;
                let result = input
                    .notify(json!({
                        "event_key": if early { "pane-1:turn-7:completed" } else { "pane-1:turn-8:blocked" },
                        "kind": if early { "completed" } else { "attention" },
                        "title": if early { "Agent finished verification" } else { "Agent needs your decision" },
                        "body": if early {
                            "The tests passed. Open the task to review the evidence."
                        } else {
                            "The Agent needs input before continuing."
                        },
                    }))
                    .await?;
                recorded
                    .lock()
                    .unwrap()
                    .push(serde_json::from_str(&result.text).unwrap());
                input.message("Checked Agent state and notification outcome.");
                Ok(vec![])
            })
        })
    });
    let f = setup_with(
        |d| {
            d.set_run(|input| async move {
                assert!(input.input.handlers.notify.is_none());
                input.message("Monitoring schedule can be proposed in chat.");
                Ok(vec![])
            });
        },
        Setup {
            child: Some(child),
            fake_now: Some("2026-10-05T00:00:00Z"),
            ..Setup::default()
        },
    );
    f.context.stable_task_identity();
    f.handle("configure", json!({"config": configured()}))
        .await
        .unwrap();
    f.handle(
        "send",
        json!({"text": "Monitor later", "request_id": "monitor-chat"}),
    )
    .await
    .unwrap();
    flush_tasks().await;
    assert_eq!(f.notifications(), Vec::<Value>::new());
    let mut input = task_input(
        "Monitor Agent",
        "Notify only when the Agent finishes verification or needs input.",
        allowed(),
        json!({"type": "interval", "minutes": 60}),
    );
    input["notification_mode"] = json!("agent");
    let created = f.handle("task.create", input).await.unwrap();
    let task_id = first_task_id(&created);
    f.service.resume().await.unwrap();
    for _ in 0..3 {
        f.handle("task.run_now", json!({"task_id": task_id}))
            .await
            .unwrap();
        f.advance(0).await;
        for _ in 0..5 {
            flush_tasks().await;
        }
        assert_eq!(f.peek()["tasks"][0]["last_run"]["status"], "succeeded");
    }
    assert_eq!(
        *results.lock().unwrap(),
        vec![
            json!({"accepted": true, "delivery": "best_effort"}),
            json!({"accepted": false, "reason": "already_notified"}),
            json!({"accepted": true, "delivery": "best_effort"}),
        ]
    );
    let inputs = inputs.lock().unwrap().clone();
    let notifications = f.notifications();
    assert_eq!(notifications.len(), 2);
    assert_matches(
        &notifications[0],
        json!({
            "task_id": task_id, "run_id": inputs[0].request_id(), "status": "succeeded",
            "title": "Agent finished verification",
        }),
    );
    assert_matches(
        &notifications[1],
        json!({
            "task_id": task_id, "run_id": inputs[2].request_id(), "status": "waiting",
            "title": "Agent needs your decision",
        }),
    );
    assert!(inputs[1].text().contains("pane-1:turn-7:completed"));
    assert!(inputs[1].text().contains("The tests passed."));
    assert_err(
        inputs[2]
            .notify(json!({
                "event_key": "too-late",
                "kind": "attention",
                "title": "Late notice",
                "body": "Must not send after completion.",
            }))
            .await,
        "no longer active",
    );
    assert_eq!(f.notifications().len(), 2);
    f.finish().await;
}

#[tokio::test]
async fn notifications_recheck_workspace_identity_after_awaiting_the_provider_catalog() {
    let pending_catalog = Deferred::<Value>::new();
    let done = Deferred::<Vec<Value>>::new();
    let delay = flag();
    let entered = flag();
    let input = slot::<Input>();
    let child_done = done.clone();
    let seen = input.clone();
    let child: ChildDriver = Arc::new(move || {
        let driver = FakeDriver::new();
        driver.set_stop({
            let r = resolving(&child_done, vec![]);
            move || r()
        });
        driver.set_dispose({
            let r = resolving(&child_done, vec![]);
            move || r()
        });
        let (done, seen) = (child_done.clone(), seen.clone());
        driver.set_run(move |value| {
            let (done, seen) = (done.clone(), seen.clone());
            async move {
                *seen.lock().unwrap() = Some(value);
                done.wait().await
            }
        });
        driver
    });
    let (d, e, p) = (delay.clone(), entered.clone(), pending_catalog.clone());
    let f = setup_with(
        move |driver| {
            driver.set_catalog(move |_| {
                let (d, e, p) = (d.clone(), e.clone(), p.clone());
                async move {
                    if !d.load(Ordering::SeqCst) {
                        return Ok(catalog());
                    }
                    e.store(true, Ordering::SeqCst);
                    p.wait().await
                }
            });
        },
        Setup {
            child: Some(child),
            fake_now: Some("2026-10-05T00:00:00Z"),
            ..Setup::default()
        },
    );
    f.context.stable_task_identity();
    f.handle("configure", json!({"config": configured()}))
        .await
        .unwrap();
    let mut task = task_input(
        "Identity guard",
        "Notify when the Agent finishes.",
        allowed(),
        json!({"type": "interval", "minutes": 60}),
    );
    task["notification_mode"] = json!("agent");
    let created = f.handle("task.create", task).await.unwrap();
    f.service.resume().await.unwrap();
    f.handle("task.run_now", json!({"task_id": first_task_id(&created)}))
        .await
        .unwrap();
    f.advance(0).await;
    flush_tasks().await;
    let run = input.lock().unwrap().clone().expect("the child ran");
    let notification = json!({
        "event_key": "agent-turn-1-completed",
        "kind": "completed",
        "title": "Agent finished",
        "body": "Open Ranger to review the result.",
    });
    delay.store(true, Ordering::SeqCst);
    let attempt = tokio::spawn(run.notify(notification.clone()));
    flush_tasks().await;
    assert!(entered.load(Ordering::SeqCst));
    let restore = f.context.restore_fn();
    f.context
        .set_restore(|_| async { Err(plain_err("The original workspace identity changed")) });
    pending_catalog.resolve(catalog());
    assert!(attempt.await.unwrap().is_err());
    assert_eq!(f.notifications(), Vec::<Value>::new());
    *f.context.restore.lock().unwrap() = Some(restore);
    delay.store(false, Ordering::SeqCst);
    let result = run.notify(notification).await.unwrap();
    assert_eq!(
        serde_json::from_str::<Value>(&result.text).unwrap(),
        json!({"accepted": true, "delivery": "best_effort"})
    );
    assert_eq!(f.notifications().len(), 1);
    done.resolve(vec![]);
    flush_tasks().await;
    f.finish().await;
}

#[tokio::test]
async fn task_tools_filter_the_current_turn_freeze_proposals_and_require_explicit_confirmation() {
    let listed = slot::<String>();
    let pointer = vec![json!({"type": "ranger-durable", "id": uuid()})];
    let done = Deferred::<Vec<Value>>::new();
    let at = js::iso((SystemClock.now() + 3_600_000) as f64);
    let input = json!({
        "title": "Check later",
        "prompt": "Read verified status",
        "scope": allowed(),
        "schedule": {"type": "once", "at": at},
    });
    let (l, p, d, i) = (listed.clone(), pointer.clone(), done.clone(), input.clone());
    let disposed = done.clone();
    let disposed_pointer = pointer.clone();
    let f = setup_driver(move |driver| {
        driver.set_run(move |turn| {
            let (l, p, d, i) = (l.clone(), p.clone(), d.clone(), i.clone());
            async move {
                turn.checkpoint(p.clone()).await?;
                *l.lock().unwrap() = Some(turn.task("list", json!({})).await?.text);
                assert_err(
                    turn.task(
                        "create",
                        merge(
                            &i,
                            json!({"scope": [{"connection_id": "local", "workspace_id": "other"}]}),
                        ),
                    )
                    .await,
                    "authorized",
                );
                turn.task("create", i).await?;
                d.wait().await
            }
        });
        driver.set_dispose(move || {
            disposed.resolve(disposed_pointer.clone());
            ok(())
        });
    });
    f.context.stable_task_identity();
    f.context.set_capture(|refs| async move {
        Ok(Value::Array(
            refs.as_array()
                .unwrap()
                .iter()
                .map(|r| merge(&workspace(), json!({"workspace_id": r["workspace_id"]})))
                .collect(),
        ))
    });
    f.handle(
        "configure",
        json!({"config": merge(&configured(), json!({
            "allowed_workspaces": [
                {"connection_id": "local", "workspace_id": "ws"},
                {"connection_id": "local", "workspace_id": "other"},
            ],
        }))}),
    )
    .await
    .unwrap();
    f.handle("task.create", merge(&input, json!({"request_id": uuid()})))
        .await
        .unwrap();
    f.handle(
        "task.create",
        merge(
            &input,
            json!({
                "title": "Other private task",
                "scope": [{"connection_id": "local", "workspace_id": "other"}],
                "request_id": uuid(),
            }),
        ),
    )
    .await
    .unwrap();
    f.handle(
        "send",
        json!({"text": "Schedule a check", "request_id": "proposal-turn", "scope": allowed()}),
    )
    .await
    .unwrap();
    until(|| {
        last_message(&f.peek())["task_proposals"]
            .as_array()
            .is_some_and(|p| !p.is_empty())
    })
    .await;
    let before = f.peek();
    assert_eq!(before["error"], Value::Null);
    assert_eq!(before["tasks"].as_array().unwrap().len(), 2);
    assert_eq!(
        last_message(&before)["task_proposals"][0]["status"],
        "pending"
    );
    let listed = listed.lock().unwrap().clone().unwrap();
    assert!(listed.contains("Check later"));
    assert!(!listed.contains("Other private task"));
    assert!(!listed.contains("endpoint_fingerprint"));
    let parsed: Value = serde_json::from_str(&listed).unwrap();
    assert!(parsed["time_zone"].is_string());
    assert!(parsed["now"].is_string());
    let id = last_message(&before)["task_proposals"][0]["id"].clone();
    assert_err(
        f.handle(
            "task.confirm_proposal",
            json!({"proposal_id": id, "prompt": "Changed by browser"}),
        )
        .await,
        "only",
    );
    let (a, b) = tokio::join!(
        f.handle("task.confirm_proposal", json!({"proposal_id": id})),
        f.handle("task.confirm_proposal", json!({"proposal_id": id})),
    );
    a.unwrap();
    b.unwrap();
    let confirmed = f.peek();
    assert_eq!(confirmed["tasks"].as_array().unwrap().len(), 3);
    assert_eq!(
        last_message(&confirmed)["task_proposals"][0]["status"],
        "confirmed"
    );
    assert_eq!(confirmed["tasks"][0]["prompt"], input["prompt"]);
    assert!(is_snapshot(&confirmed));
    let saved = f.saved();
    assert_eq!(
        last_message(&saved)["task_proposals"][0]["status"],
        "confirmed"
    );
    assert_eq!(saved["entries"], Value::Array(pointer.clone()));
    assert_eq!(saved["active_run"]["request_id"], "proposal-turn");
    assert_eq!(confirmed["running"], true);
    done.resolve(pointer);
    until(|| f.peek()["running"] == false).await;
    f.finish().await;
}

#[tokio::test]
async fn an_isolated_child_can_run_beside_the_main_chat_and_waits_for_a_human_before_a_workspace_write()
 {
    let main_done = Deferred::<Vec<Value>>::new();
    let child_done = Deferred::<Vec<Value>>::new();
    let child_inputs = list::<Input>();
    let writes = counter();
    let child_driver = FakeDriver::new();
    {
        let (done, seen) = (child_done.clone(), child_inputs.clone());
        child_driver.set_run(move |input| {
            let (done, seen) = (done.clone(), seen.clone());
            async move {
                seen.lock().unwrap().push(input.clone());
                on_abort(&input, &done);
                done.wait().await
            }
        });
        child_driver.set_stop(resolving(&child_done, vec![]));
        child_driver.set_dispose(resolving(&child_done, vec![]));
    }
    let shared = child_driver.clone();
    let (main, main_dispose) = (main_done.clone(), main_done.clone());
    let f = setup_with(
        move |d| {
            d.set_run(move |input| {
                let main = main.clone();
                async move {
                    input.message("Main chat answer");
                    main.wait().await
                }
            });
            d.set_dispose(resolving(&main_dispose, vec![]));
        },
        Setup {
            child: Some(Arc::new(move || shared.clone())),
            fake_now: Some("2026-10-04T00:00:00Z"),
            ..Setup::default()
        },
    );
    f.context.stable_task_identity();
    let w = writes.clone();
    f.context.set_prepare(move |_, _, _| {
        let w = w.clone();
        async move {
            Ok(action(
                merge(
                    &workspace(),
                    json!({
                        "workspace_label": "Workspace",
                        "kind": "send_prompt",
                        "params": {"prompt": "Inspect"},
                        "summary": "Send Inspect",
                    }),
                ),
                move || async move {
                    bump(&w);
                    Ok(json!({"status": "succeeded", "detail": "Accepted"}))
                },
            ))
        }
    });
    f.handle("configure", json!({"config": configured()}))
        .await
        .unwrap();
    let created = f
        .handle(
            "task.create",
            task_input(
                "Independent run",
                "Read status",
                allowed(),
                json!({"type": "interval", "minutes": 1}),
            ),
        )
        .await
        .unwrap();
    let task_id = first_task_id(&created);
    f.service.resume().await.unwrap();
    f.handle(
        "send",
        json!({"text": "Continue main chat", "request_id": "main-busy"}),
    )
    .await
    .unwrap();
    f.handle("task.run_now", json!({"task_id": task_id}))
        .await
        .unwrap();
    f.advance(0).await;
    flush_tasks().await;
    let first = {
        let inputs = child_inputs.lock().unwrap();
        assert_eq!(inputs.len(), 1);
        inputs[0].clone()
    };
    assert!(first.input.handlers.task.is_none());
    assert_eq!(f.peek()["running"], true);
    assert_eq!(
        first
            .read("status", json!({}))
            .await
            .unwrap()
            .sources
            .unwrap()
            .len(),
        1
    );
    first
        .propose(
            "send_prompt",
            json!({
                "connection_id": "local", "workspace_id": "ws", "pane_id": "pane", "prompt": "Inspect",
            }),
        )
        .await
        .unwrap();
    first.message("Scheduled answer");
    child_done.resolve(vec![]);
    flush_tasks().await;
    let waiting = f
        .service
        .task_detail(json!({"task_id": task_id, "run_id": first.request_id()}))
        .await
        .unwrap();
    assert_eq!(waiting["task"]["current_run"]["status"], "waiting");
    assert_eq!(last_message(&waiting["run"])["text"], "Scheduled answer");
    assert_eq!(last_message(&f.peek())["text"], "Main chat answer");
    assert_eq!(count(&writes), 0);
    assert_eq!(
        f.notifications(),
        vec![json!({
            "task_id": task_id,
            "run_id": first.request_id(),
            "status": "waiting",
            "title": "Ranger task needs confirmation",
            "body": "Independent run: needs your confirmation. Open Ranger to review the pending action.",
        })]
    );
    let action_id = last_message(&waiting["run"])["actions"][0]["id"].clone();
    f.handle(
        "task.action.confirm",
        json!({"task_id": task_id, "run_id": first.request_id(), "action_id": action_id}),
    )
    .await
    .unwrap();
    flush_tasks().await;
    assert_eq!(count(&writes), 1);
    assert_eq!(
        f.service
            .task_detail(json!({"task_id": task_id}))
            .await
            .unwrap()["task"]["last_run"]["status"],
        "succeeded"
    );
    main_done.resolve(vec![]);
    flush_tasks().await;
    let statuses: Vec<Value> = f
        .notifications()
        .iter()
        .map(|n| n["status"].clone())
        .collect();
    assert_eq!(statuses, vec![json!("waiting"), json!("succeeded")]);
    f.finish().await;
}

#[tokio::test]
async fn a_model_that_completes_during_child_admission_still_records_its_final_receipt_once() {
    let starts = counter();
    let s = starts.clone();
    let child: ChildDriver = Arc::new(move || {
        let s = s.clone();
        child_driver(move |_| {
            bump(&s);
            ok(vec![])
        })
    });
    let f = setup_with(
        |_| {},
        Setup {
            child: Some(child),
            fake_now: Some("2026-10-04T00:00:00Z"),
            ..Setup::default()
        },
    );
    f.context.stable_task_identity();
    f.handle("configure", configured()).await.unwrap();
    let task = f
        .handle(
            "task.create",
            task_input(
                "Immediate response",
                "Inspect",
                allowed(),
                json!({"type": "once", "at": "2026-10-04T00:00:01.000Z"}),
            ),
        )
        .await
        .unwrap();
    let task_id = first_task_id(&task);
    f.service.resume().await.unwrap();
    f.advance(1_000).await;
    flush_tasks().await;
    let detail = f
        .service
        .task_detail(json!({"task_id": task_id}))
        .await
        .unwrap();
    assert_eq!(detail["runs"][0]["status"], "succeeded");
    let (a, b) = tokio::join!(f.service.resume(), f.service.resume());
    a.unwrap();
    b.unwrap();
    assert_eq!(count(&starts), 1);
    let detail = f
        .service
        .task_detail(json!({"task_id": task_id}))
        .await
        .unwrap();
    assert_eq!(detail["runs"].as_array().unwrap().len(), 1);
    f.finish().await;
}

/// A child the test made a driver for.
#[derive(Clone)]
struct ChildRecord {
    done: Arc<Deferred<Vec<Value>>>,
    disposed: Arc<AtomicBool>,
}

fn offline() -> Value {
    json!({"connection_id": "offline", "workspace_id": "ws"})
}

/// `refs.map((ref) => ({ ...workspace, ...ref }))`.
fn capture(refs: &Value) -> Value {
    Value::Array(
        refs.as_array()
            .into_iter()
            .flatten()
            .map(|r| merge(&workspace(), r.clone()))
            .collect(),
    )
}

fn touches_offline(targets: &Value) -> bool {
    targets
        .as_array()
        .into_iter()
        .flatten()
        .any(|t| t["connection_id"] == "offline")
}

#[tokio::test]
async fn a_fresh_task_disconnecting_during_scope_check_requeues_before_any_model_admission() {
    for disconnect_at in [2usize, 3, 4] {
        let disposal_gate = Deferred::<()>::new();
        let inputs = list::<Input>();
        let children = list::<ChildRecord>();
        let (gate, seen, made) = (disposal_gate.clone(), inputs.clone(), children.clone());
        let child: ChildDriver = Arc::new(move || {
            let first = made.lock().unwrap().is_empty();
            let record = ChildRecord {
                done: Deferred::new(),
                disposed: flag(),
            };
            made.lock().unwrap().push(record.clone());
            let driver = FakeDriver::new();
            let (done, seen) = (record.done.clone(), seen.clone());
            driver.set_run(move |input| {
                let (done, seen) = (done.clone(), seen.clone());
                async move {
                    seen.lock().unwrap().push(input);
                    done.wait().await
                }
            });
            driver.set_stop(resolving(&record.done, vec![]));
            let gate = gate.clone();
            driver.set_dispose(move || {
                let (gate, record) = (gate.clone(), record.clone());
                async move {
                    if first {
                        let _ = gate.wait().await;
                    }
                    record.disposed.store(true, Ordering::SeqCst);
                    record.done.resolve(vec![]);
                    Ok(())
                }
            });
            driver
        });
        let f = setup_with(
            |_| {},
            Setup {
                child: Some(child),
                fake_now: Some("2026-10-04T00:00:00Z"),
                ..Setup::default()
            },
        );
        f.context.stable_task_identity();
        f.context
            .set_capture(|refs| async move { Ok(capture(&refs)) });
        let armed = flag();
        let blocked = flag();
        let checks = counter();
        let (a, b, c) = (armed.clone(), blocked.clone(), checks.clone());
        f.context.set_restore(move |targets| {
            let (a, b, c) = (a.clone(), b.clone(), c.clone());
            async move {
                if touches_offline(&targets) {
                    let n = bump(&c);
                    if a.load(Ordering::SeqCst) && n == disconnect_at {
                        b.store(true, Ordering::SeqCst);
                    }
                    if b.load(Ordering::SeqCst) {
                        return Err(not_ready("Private connection detail"));
                    }
                }
                Ok(capture(&targets))
            }
        });
        f.handle(
            "configure",
            merge(
                &configured(),
                json!({"allowed_workspaces": [allowed()[0].clone(), offline()]}),
            ),
        )
        .await
        .unwrap();
        let first = first_task_id(
            &f.handle(
                "task.create",
                task_input(
                    "Fresh interrupted admission",
                    "Inspect the offline workspace",
                    json!([offline()]),
                    json!({"type": "once", "at": "2026-10-04T00:00:01.000Z"}),
                ),
            )
            .await
            .unwrap(),
        );
        let created = f
            .handle(
                "task.create",
                task_input(
                    "Ready workspace",
                    "Inspect the ready workspace",
                    allowed(),
                    json!({"type": "interval", "minutes": 1}),
                ),
            )
            .await
            .unwrap();
        let second = created["tasks"]
            .as_array()
            .unwrap()
            .iter()
            .find(|t| t["title"] == "Ready workspace")
            .unwrap()["id"]
            .as_str()
            .unwrap()
            .to_owned();
        f.service.resume().await.unwrap();
        checks.store(0, Ordering::SeqCst);
        armed.store(true, Ordering::SeqCst);
        f.advance(1_000).await;
        flush_tasks().await;
        let detail = |id: &str| f.service.task_detail(json!({"task_id": id}));
        assert_eq!(
            detail(&first).await.unwrap()["runs"][0]["status"],
            "running"
        );
        assert_eq!(inputs.lock().unwrap().len(), 0);
        assert!(!children.lock().unwrap()[0].disposed.load(Ordering::SeqCst));
        f.handle("task.pause", json!({"task_id": second}))
            .await
            .unwrap();
        f.handle("task.resume", json!({"task_id": second}))
            .await
            .unwrap();
        assert_eq!(
            detail(&first).await.unwrap()["runs"][0]["status"],
            "running"
        );
        disposal_gate.resolve(());
        flush_tasks().await;
        let waiting = detail(&first).await.unwrap();
        let original = waiting["runs"][0].clone();
        assert_eq!(original["status"], "queued");
        assert!(original.get("started_at").is_none());
        assert!(original.get("finished_at").is_none());
        let error = original["error"].as_str().unwrap();
        assert!(error.contains("Waiting"));
        assert!(!error.contains("Private connection detail"));
        assert_eq!(f.peek()["error"], Value::Null);
        assert!(f.snapshots().iter().all(|snapshot| {
            snapshot["tasks"]
                .as_array()
                .and_then(|tasks| tasks.iter().find(|t| t["id"] == first.as_str()))
                .is_none_or(|t| t.get("last_run").is_none_or(Value::is_null))
        }));
        assert_eq!(inputs.lock().unwrap().len(), 0);
        assert_eq!(children.lock().unwrap().len(), 1);
        assert!(children.lock().unwrap()[0].disposed.load(Ordering::SeqCst));
        f.advance(4_000).await;
        flush_tasks().await;
        assert_eq!(children.lock().unwrap().len(), 1);
        f.handle("task.run_now", json!({"task_id": second}))
            .await
            .unwrap();
        f.advance(0).await;
        flush_tasks().await;
        assert_eq!(inputs.lock().unwrap().len(), 1);
        assert!(
            inputs.lock().unwrap()[0]
                .text()
                .contains("Inspect the ready workspace")
        );
        armed.store(false, Ordering::SeqCst);
        blocked.store(false, Ordering::SeqCst);
        let (a, b) = tokio::join!(f.service.resume(), f.service.resume());
        a.unwrap();
        b.unwrap();
        flush_tasks().await;
        assert_eq!(inputs.lock().unwrap().len(), 1);
        let latest = || children.lock().unwrap().last().unwrap().done.clone();
        latest().resolve(vec![]);
        flush_tasks().await;
        f.advance(0).await;
        flush_tasks().await;
        {
            let inputs = inputs.lock().unwrap();
            assert_eq!(inputs.len(), 2);
            assert_eq!(inputs[1].request_id(), original["id"].as_str().unwrap());
            assert!(!inputs[1].input.recover);
            assert_eq!(inputs[1].entries(), json!([]));
        }
        let (a, b) = tokio::join!(f.service.resume(), f.service.resume());
        a.unwrap();
        b.unwrap();
        assert_eq!(inputs.lock().unwrap().len(), 2);
        latest().resolve(vec![]);
        flush_tasks().await;
        let finished = detail(&first).await.unwrap();
        let runs = finished["runs"].as_array().unwrap();
        assert_eq!(runs.len(), 1, "disconnect at {disconnect_at}");
        assert_eq!(runs[0]["id"], original["id"]);
        assert_eq!(runs[0]["scheduled_at"], original["scheduled_at"]);
        assert_eq!(runs[0]["status"], "succeeded");
        assert!(
            js::date_parse(runs[0]["started_at"].as_str().unwrap())
                > js::date_parse(original["scheduled_at"].as_str().unwrap())
        );
        f.finish().await;
    }
}

#[tokio::test]
async fn recovery_waiting_for_a_connection_releases_the_task_slot_without_losing_checkpoints_disconnect_after_admission()
 {
    for disconnect_after_admission in [false, true] {
        let inputs = list::<Input>();
        let children = list::<ChildRecord>();
        let checkpoint = vec![json!({"saved_read": "already completed"})];
        let (seen, made, saved_checkpoint) = (inputs.clone(), children.clone(), checkpoint.clone());
        let child: ChildDriver = Arc::new(move || {
            let record = ChildRecord {
                done: Deferred::new(),
                disposed: flag(),
            };
            made.lock().unwrap().push(record.clone());
            let driver = FakeDriver::new();
            let (done, seen, cp) = (record.done.clone(), seen.clone(), saved_checkpoint.clone());
            driver.set_run(move |input| {
                let (done, seen, cp) = (done.clone(), seen.clone(), cp.clone());
                async move {
                    seen.lock().unwrap().push(input.clone());
                    input.checkpoint(cp).await?;
                    done.wait().await
                }
            });
            driver.set_stop(resolving(&record.done, saved_checkpoint.clone()));
            let cp = saved_checkpoint.clone();
            driver.set_dispose(move || {
                record.disposed.store(true, Ordering::SeqCst);
                record.done.resolve(cp.clone());
                ok(())
            });
            driver
        });
        let f = setup_with(
            |_| {},
            Setup {
                child: Some(child),
                fake_now: Some("2026-10-04T00:00:00Z"),
                ..Setup::default()
            },
        );
        f.context.stable_task_identity();
        f.context
            .set_capture(|refs| async move { Ok(capture(&refs)) });
        let ready = Arc::new(AtomicBool::new(true));
        let restore_checks = counter();
        let (r, c) = (ready.clone(), restore_checks.clone());
        f.context.set_restore(move |targets| {
            let (r, c) = (r.clone(), c.clone());
            async move {
                if touches_offline(&targets) {
                    let n = bump(&c);
                    if !r.load(Ordering::SeqCst) && !(disconnect_after_admission && n == 1) {
                        return Err(not_ready("Original connection is not ready"));
                    }
                }
                Ok(capture(&targets))
            }
        });
        f.handle(
            "configure",
            merge(
                &configured(),
                json!({"allowed_workspaces": [allowed()[0].clone(), offline()]}),
            ),
        )
        .await
        .unwrap();
        let first = first_task_id(
            &f.handle(
                "task.create",
                task_input(
                    "Interrupted original run",
                    "Inspect the offline workspace",
                    json!([offline()]),
                    json!({"type": "once", "at": "2026-10-04T00:00:01.000Z"}),
                ),
            )
            .await
            .unwrap(),
        );
        let created = f
            .handle(
                "task.create",
                task_input(
                    "Ready workspace",
                    "Inspect the ready workspace",
                    allowed(),
                    json!({"type": "interval", "minutes": 1}),
                ),
            )
            .await
            .unwrap();
        let second = created["tasks"]
            .as_array()
            .unwrap()
            .iter()
            .find(|t| t["title"] == "Ready workspace")
            .unwrap()["id"]
            .as_str()
            .unwrap()
            .to_owned();
        f.service.resume().await.unwrap();
        f.advance(1_000).await;
        flush_tasks().await;
        assert_eq!(inputs.lock().unwrap().len(), 1);
        let original = f
            .service
            .task_detail(json!({"task_id": first}))
            .await
            .unwrap()["runs"][0]
            .clone();
        f.handle("task.pause", json!({"task_id": first}))
            .await
            .unwrap();
        f.handle("task.run_now", json!({"task_id": second}))
            .await
            .unwrap();
        f.service.dispose().await;
        ready.store(false, Ordering::SeqCst);
        restore_checks.store(0, Ordering::SeqCst);
        let restored = f.restart(f.driver.clone());
        restored.resume().await.unwrap();
        flush_tasks().await;
        let waiting = restored
            .task_detail(json!({"task_id": first, "run_id": original["id"]}))
            .await
            .unwrap();
        assert_eq!(waiting["run"]["status"], "queued");
        assert_eq!(waiting["run"]["started_at"], original["started_at"]);
        assert!(waiting["run"].get("finished_at").is_none());
        assert!(
            waiting["run"]["error"]
                .as_str()
                .unwrap()
                .contains("Waiting")
        );
        assert_eq!(inputs.lock().unwrap().len(), 1);
        if disconnect_after_admission {
            assert!(children.lock().unwrap()[1].disposed.load(Ordering::SeqCst));
        }
        let state = f
            .directory
            .join("tasks")
            .join(&first)
            .join("runs")
            .join(original["id"].as_str().unwrap())
            .join("state.json");
        let saved = read_json(&state);
        assert_eq!(saved["active_run"]["request_id"], original["id"]);
        assert_eq!(saved["entries"], Value::Array(checkpoint.clone()));
        f.advance(0).await;
        flush_tasks().await;
        {
            let inputs = inputs.lock().unwrap();
            assert_eq!(inputs.len(), 2);
            assert!(inputs[1].text().contains("Inspect the ready workspace"));
        }
        ready.store(true, Ordering::SeqCst);
        let (a, b) = tokio::join!(restored.resume(), restored.resume());
        a.unwrap();
        b.unwrap();
        flush_tasks().await;
        assert_eq!(inputs.lock().unwrap().len(), 2);
        let latest = || children.lock().unwrap().last().unwrap().done.clone();
        latest().resolve(vec![]);
        flush_tasks().await;
        f.advance(0).await;
        flush_tasks().await;
        {
            let inputs = inputs.lock().unwrap();
            assert_eq!(
                inputs.len(),
                3,
                "after admission: {disconnect_after_admission}"
            );
            assert_eq!(inputs[2].request_id(), original["id"].as_str().unwrap());
            assert!(inputs[2].input.recover);
            assert_eq!(inputs[2].entries(), Value::Array(checkpoint.clone()));
        }
        let (a, b) = tokio::join!(restored.resume(), restored.resume());
        a.unwrap();
        b.unwrap();
        assert_eq!(inputs.lock().unwrap().len(), 3);
        latest().resolve(checkpoint.clone());
        flush_tasks().await;
        let finished = restored
            .task_detail(json!({"task_id": first}))
            .await
            .unwrap();
        let runs = finished["runs"].as_array().unwrap();
        assert_eq!(runs.len(), 1);
        assert_eq!(runs[0]["status"], "succeeded");
        assert_eq!(runs[0]["started_at"], original["started_at"]);
        assert_eq!(finished["task"]["status"], "paused");
        f.finish().await;
    }
}

#[tokio::test]
async fn workspace_identity_reuse_and_global_permission_tightening_fail_closed_throughout_a_child_read()
 {
    let done = Deferred::<Vec<Value>>::new();
    let read_done = Deferred::<ToolResult>::new();
    let input = slot::<Input>();
    let child_driver = FakeDriver::new();
    {
        let (finished, seen) = (done.clone(), input.clone());
        child_driver.set_run(move |value| {
            let done = &finished;
            let (done, seen) = (done.clone(), seen.clone());
            async move {
                *seen.lock().unwrap() = Some(value.clone());
                on_abort(&value, &done);
                done.wait().await
            }
        });
        child_driver.set_stop(resolving(&done, vec![]));
        child_driver.set_dispose(resolving(&done, vec![]));
    }
    let shared = child_driver.clone();
    let f = setup_with(
        |_| {},
        Setup {
            child: Some(Arc::new(move || shared.clone())),
            fake_now: Some("2026-10-04T00:00:00Z"),
            ..Setup::default()
        },
    );
    f.context.stable_task_identity();
    f.handle("configure", json!({"config": configured()}))
        .await
        .unwrap();
    let task_id = first_task_id(
        &f.handle(
            "task.create",
            task_input(
                "Scope guard",
                "Inspect",
                allowed(),
                json!({"type": "interval", "minutes": 1}),
            ),
        )
        .await
        .unwrap(),
    );
    f.service.resume().await.unwrap();
    f.handle("task.run_now", json!({"task_id": task_id}))
        .await
        .unwrap();
    f.advance(0).await;
    flush_tasks().await;
    let run = input.lock().unwrap().clone().expect("the child ran");
    let restore = f.context.restore_fn();
    f.context.set_restore(|_| async {
        Err(plain_err(
            "Same workspace ID now points at a different repository",
        ))
    });
    assert!(run.read("status", json!({})).await.is_err());
    assert_eq!(f.context.reads().len(), 0);
    assert!(
        f.handle("task.run_now", json!({"task_id": task_id}))
            .await
            .is_err()
    );
    *f.context.restore.lock().unwrap() = Some(restore);
    let pending = read_done.clone();
    f.context.set_read(move |_, _, _| {
        let pending = pending.clone();
        async move { pending.wait().await }
    });
    let read = tokio::spawn(run.read("status", json!({})));
    flush_tasks().await;
    f.handle(
        "configure",
        json!({"config": merge(&configured(), json!({"allowed_workspaces": []}))}),
    )
    .await
    .unwrap();
    read_done.resolve(ToolResult {
        text: "New private contents".into(),
        sources: Some(vec![]),
    });
    assert!(read.await.unwrap().is_err());
    assert!(run.signal.is_cancelled());
    assert_eq!(
        f.service
            .task_detail(json!({"task_id": task_id}))
            .await
            .unwrap()["task"]["last_run"]["status"],
        "stopped"
    );
    assert!(
        f.handle("task.resume", json!({"task_id": task_id}))
            .await
            .is_err()
    );
    f.finish().await;
}
