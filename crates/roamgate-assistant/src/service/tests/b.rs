//! The bridge-global assistant: admission, receipts, confirmation, chats on
//! disk, the provider login, model connections, ceilings and recovery.

use std::sync::atomic::AtomicI64;

use super::*;
use crate::wire::{
    ASSISTANT_MAX_CUSTOM_MODELS, ASSISTANT_MAX_THINKING, ASSISTANT_MAX_THINKING_STEPS, is_snapshot,
};

fn stopped(f: &Fixture) -> bool {
    f.last_snapshot()["running"] == false
}

fn actions_of(snapshot: &Value) -> Vec<Value> {
    snapshot["messages"]
        .as_array()
        .into_iter()
        .flatten()
        .flat_map(|m| m["actions"].as_array().cloned().unwrap_or_default())
        .collect()
}

fn last_action_status(snapshot: &Value) -> Value {
    last_message(snapshot)["actions"][0]["status"].clone()
}

/// A run that records its input and answers as `answer` says.
fn record(inputs: &Arc<Mutex<Vec<Input>>>, input: &Input) -> usize {
    let mut inputs = inputs.lock().unwrap();
    inputs.push(input.clone());
    inputs.len()
}

fn recovery_target(boot: &str) -> Value {
    merge(
        &workspace(),
        json!({
            "endpoint_fingerprint": "a".repeat(64),
            "workspace_identity": "b".repeat(64),
            "herdr_boot_id": boot,
        }),
    )
}

#[tokio::test]
async fn interactive_not_ready_errors_remain_sanitized_and_release_admission_for_a_retry() {
    let f = setup();
    f.handle("configure", configured()).await.unwrap();
    let capture = f.context.capture_fn();
    f.context
        .set_capture(|_| async { Err(not_ready("Private connection detail")) });
    let params = json!({"request_id": "interactive-retry", "text": "Inspect"});
    let error = f.handle("send", params.clone()).await.unwrap_err();
    assert!(!matches!(error, AssistantError::RecoveryNotReady(_)));
    assert_eq!(
        error.message(),
        "A workspace Ranger may read could not be opened: its server may be offline or restarting. Try again."
    );
    assert_eq!(f.peek()["running"], false);
    assert!(
        !serde_json::to_string(&f.snapshots())
            .unwrap()
            .contains("Private connection detail")
    );
    f.context.set_capture(move |refs| capture(refs));
    f.handle("send", params).await.unwrap();
    until(|| f.peek()["running"] == false).await;
    assert_eq!(last_message(&f.peek())["text"], "Hello");
    f.finish().await;
}

#[tokio::test]
async fn a_turn_runs_without_the_workspaces_of_a_connection_it_cannot_reach() {
    let inputs = list::<Input>();
    let seen = inputs.clone();
    let f = setup_driver(move |d| {
        d.set_run(move |input| {
            record(&seen, &input);
            async move {
                input.message("Hello");
                Ok(vec![json!({"persisted": true})])
            }
        });
    });
    let mac = json!({"connection_id": "mac", "workspace_id": "w2"});
    let mac_workspace = merge(
        &merge(&workspace(), mac.clone()),
        json!({"connection_label": "Mac"}),
    );
    let online = Arc::new(AtomicBool::new(true));
    let (on, listed) = (online.clone(), mac_workspace.clone());
    f.context.set_catalog(move || {
        let value = if on.load(Ordering::SeqCst) {
            json!({
                "workspaces": [workspace(), listed],
                "errors": [],
                "connection_ids": ["local", "mac"],
                "complete_connection_ids": ["local", "mac"],
            })
        } else {
            json!({
                "workspaces": [workspace()],
                "errors": ["Unable to list workspaces for connection Mac"],
                "connection_ids": ["local", "mac"],
                "complete_connection_ids": ["local"],
            })
        };
        async move { Ok(value) }
    });
    let (on, captured) = (online.clone(), mac_workspace.clone());
    f.context.set_capture(move |scope| {
        let result: AssistantResult<Vec<Value>> = scope
            .as_array()
            .unwrap()
            .iter()
            .map(|r| {
                if r["connection_id"] == "mac" && !on.load(Ordering::SeqCst) {
                    return Err(plain_err("Connection mac is not ready"));
                }
                Ok(if r["connection_id"] == "mac" {
                    captured.clone()
                } else {
                    workspace()
                })
            })
            .collect();
        async move { result.map(Value::Array) }
    });
    let allowed = json!([{"connection_id": "local", "workspace_id": "ws"}, mac]);
    f.handle(
        "configure",
        merge(&configured(), json!({"allowed_workspaces": allowed})),
    )
    .await
    .unwrap();
    online.store(false, Ordering::SeqCst);
    f.handle(
        "send",
        json!({"request_id": "offline-mac", "text": "Find the blog session", "scope": allowed}),
    )
    .await
    .unwrap();
    until(|| f.peek()["running"] == false).await;
    assert_eq!(last_message(&f.peek())["text"], "Hello");
    assert!(
        inputs.lock().unwrap()[0]
            .text()
            .contains("Unreachable now, left out of this turn: 1 workspace on connection \"mac\"")
    );
    // The grant keeps the Mac's workspaces for when it is back.
    assert_eq!(f.peek()["config"]["allowed_workspaces"], allowed);
    // Nothing reachable: say so, not a generic failure.
    let error = f
        .handle(
            "send",
            json!({"request_id": "only-mac", "text": "Find the blog session", "scope": [mac]}),
        )
        .await
        .unwrap_err();
    assert_eq!(
        error.message(),
        "None of the workspaces Ranger may read can be reached now: their server is offline. Reconnect it and try again."
    );
    assert_eq!(f.peek()["running"], false);
    f.finish().await;
}

#[tokio::test]
async fn a_refused_turn_names_the_step_that_failed_never_what_a_provider_said() {
    let fail_models = flag();
    let failing = fail_models.clone();
    let f = setup_driver(move |d| {
        d.set_catalog(move |_| {
            let fail = failing.load(Ordering::SeqCst);
            async move {
                if fail {
                    Err(plain_err("401 SECRET_TOKEN"))
                } else {
                    Ok(catalog())
                }
            }
        });
    });
    f.handle("configure", configured()).await.unwrap();
    fail_models.store(true, Ordering::SeqCst);
    let error = f
        .handle("send", json!({"request_id": "models", "text": "Inspect"}))
        .await
        .unwrap_err();
    assert_eq!(
        error.message(),
        "The models of test could not be listed. Check its sign-in in Ranger's settings."
    );
    assert!(!error.message().contains("SECRET"));
    fail_models.store(false, Ordering::SeqCst);
    f.context
        .set_catalog(|| async { Err(plain_err("ENOENT /private/socket")) });
    let listing = f
        .handle("send", json!({"request_id": "listing", "text": "Inspect"}))
        .await
        .unwrap_err();
    assert_eq!(
        listing.message(),
        "Ranger could not list the workspaces. Check the server connections and try again."
    );
    assert_eq!(f.peek()["running"], false);
    f.finish().await;
}

#[tokio::test]
async fn operation_receipts_from_another_workspace_or_runtime_are_excluded_from_model_context() {
    let inputs = list::<Input>();
    let seen = inputs.clone();
    let f = setup_driver(move |d| {
        d.set_run(move |input| {
            let count = record(&seen, &input);
            async move {
                if count == 1 {
                    input
                        .propose(
                            "send_prompt",
                            json!({
                                "connection_id": "local", "workspace_id": "ws",
                                "pane_id": "p1", "prompt": "PRIVATE_REVIEW_CONTENT",
                            }),
                        )
                        .await?;
                }
                Ok(vec![json!({"old": "private context"})])
            }
        });
    });
    let generation = Arc::new(AtomicI64::new(7));
    let current = generation.clone();
    f.context.set_capture(move |refs| {
        let generation = current.load(Ordering::SeqCst);
        let scope: Vec<Value> = refs
            .as_array()
            .unwrap()
            .iter()
            .map(|r| {
                merge(
                    &merge(&workspace(), r.clone()),
                    json!({"runtime_generation": generation}),
                )
            })
            .collect();
        async move { Ok(Value::Array(scope)) }
    });
    f.context.set_prepare(|_, _, _| async {
        Ok(action(
            preview(
                "send_prompt",
                "Send feedback",
                json!({"pane_id": "p1", "prompt": "PRIVATE_REVIEW_CONTENT"}),
            ),
            || async { Ok(json!({"status": "uncertain", "detail": "Accepted"})) },
        ))
    });
    let other = json!({"connection_id": "local", "workspace_id": "other"});
    f.handle(
        "configure",
        json!({"config": merge(&configured(), json!({"allowed_workspaces": [workspace(), other]}))}),
    )
    .await
    .unwrap();
    f.handle(
        "send",
        json!({"request_id": "one", "text": "Send feedback", "scope": [workspace()]}),
    )
    .await
    .unwrap();
    until(|| stopped(&f)).await;
    f.handle(
        "send",
        json!({"request_id": "two", "text": "Other workspace", "scope": [other]}),
    )
    .await
    .unwrap();
    until(|| stopped(&f)).await;
    {
        let inputs = inputs.lock().unwrap();
        assert!(!inputs[1].text().contains("PRIVATE_REVIEW_CONTENT"));
        assert_eq!(inputs[1].entries(), json!([]));
    }
    generation.store(8, Ordering::SeqCst);
    f.handle(
        "send",
        json!({"request_id": "three", "text": "Replaced runtime", "scope": [workspace()]}),
    )
    .await
    .unwrap();
    until(|| stopped(&f)).await;
    let inputs = inputs.lock().unwrap().clone();
    assert!(!inputs[2].text().contains("PRIVATE_REVIEW_CONTENT"));
    assert_eq!(inputs[2].entries(), json!([]));
    f.finish().await;
}

#[tokio::test]
async fn only_explicit_confirmation_writes_persists_admission_first_and_deduplicates_concurrent_confirmations()
 {
    let calls = counter();
    let gate = Deferred::<()>::new();
    let observed = list::<Value>();
    let f = setup_driver(|d| {
        d.set_run(|input| async move {
            input
                .propose(
                    "create_workspace",
                    json!({"connection_id": "local", "workspace_id": "ws", "label": "Task"}),
                )
                .await?;
            input.message("Review the operation preview.");
            Ok(vec![])
        });
    });
    let state = f.state_path();
    let (counted, wait, seen) = (calls.clone(), gate.clone(), observed.clone());
    f.context.set_prepare(move |_, _, _| {
        let (count, wait, seen, state) =
            (counted.clone(), wait.clone(), seen.clone(), state.clone());
        async move {
            Ok(action(
                preview(
                    "create_workspace",
                    "Create Task",
                    json!({"cwd": "/repo", "label": "Task"}),
                ),
                move || async move {
                    bump(&count);
                    let saved = read_json(&state);
                    seen.lock().unwrap().push(last_action_status(&saved));
                    let _ = wait.wait().await;
                    Ok(json!({"status": "succeeded", "detail": "Workspace creation verified."}))
                },
            ))
        }
    });
    f.handle("configure", json!({"config": configured()}))
        .await
        .unwrap();
    f.handle(
        "send",
        json!({"request_id": "proposal", "text": "Create Task"}),
    )
    .await
    .unwrap();
    until(|| stopped(&f)).await;
    let proposal = last_message(&f.service.snapshot().await.unwrap())["actions"][0].clone();
    assert_eq!(count(&calls), 0);
    assert_eq!(proposal["status"], "pending");
    assert_err(
        f.handle(
            "action.confirm",
            json!({"action_id": proposal["id"], "params": {"cwd": "/elsewhere"}}),
        )
        .await,
        "only the action identifier",
    );
    let (a, b) = tokio::join!(
        f.handle("action.confirm", json!({"action_id": proposal["id"]})),
        f.handle("action.confirm", json!({"action_id": proposal["id"]})),
    );
    a.unwrap();
    b.unwrap();
    assert_eq!(count(&calls), 1);
    assert_eq!(*observed.lock().unwrap(), vec![json!("executing")]);
    assert_err(
        f.handle("send", json!({"request_id": "busy", "text": "Hello"}))
            .await,
        "busy",
    );
    assert_err(
        f.handle("configure", json!({"config": configured()})).await,
        "busy",
    );
    let session = f.service.snapshot().await.unwrap()["session_id"].clone();
    assert_err(
        f.handle("select_session", json!({"session_id": session}))
            .await,
        "busy",
    );
    f.handle("stop", json!({})).await.unwrap();
    assert_eq!(
        last_action_status(&f.service.snapshot().await.unwrap()),
        "executing"
    );
    gate.resolve(());
    until(|| last_action_status(&f.last_snapshot()) == "succeeded").await;
    f.handle("action.confirm", json!({"action_id": proposal["id"]}))
        .await
        .unwrap();
    assert_eq!(count(&calls), 1);
    assert!(is_snapshot(&f.service.snapshot().await.unwrap()));
    f.finish().await;
}

fn start_pi_driver(d: &FakeDriver) {
    d.set_run(|input| async move {
        input
            .propose(
                "start_agent",
                json!({"connection_id": "local", "workspace_id": "ws", "pane_id": "p1", "agent": "pi"}),
            )
            .await?;
        Ok(vec![])
    });
}

fn start_pi_context(f: &Fixture, calls: &Arc<AtomicUsize>) {
    let count = calls.clone();
    f.context.set_prepare(move |_, _, _| {
        let count = count.clone();
        async move {
            Ok(action(
                preview(
                    "start_agent",
                    "Start Pi",
                    json!({"pane_id": "p1", "agent": "pi"}),
                ),
                move || async move {
                    bump(&count);
                    Ok(json!({"status": "succeeded", "detail": "Started"}))
                },
            ))
        }
    });
}

#[tokio::test]
async fn pending_previews_expire_on_cancellation_scope_changes_new_questions_and_bridge_restart() {
    let calls = counter();
    let f = setup_driver(start_pi_driver);
    start_pi_context(&f, &calls);
    f.handle("configure", json!({"config": configured()}))
        .await
        .unwrap();
    async fn propose(f: &Fixture, id: &str) -> Value {
        f.handle("send", json!({"request_id": id, "text": "Start Pi"}))
            .await
            .unwrap();
        until(|| stopped(f)).await;
        last_message(&f.service.snapshot().await.unwrap())["actions"][0].clone()
    }
    let first = propose(&f, "one").await;
    f.handle("action.cancel", json!({"action_id": first["id"]}))
        .await
        .unwrap();
    f.handle("action.confirm", json!({"action_id": first["id"]}))
        .await
        .unwrap();
    assert_eq!(count(&calls), 0);
    let second = propose(&f, "two").await;
    propose(&f, "three").await;
    let snapshot = f.service.snapshot().await.unwrap();
    let found = actions_of(&snapshot)
        .into_iter()
        .find(|a| a["id"] == second["id"])
        .unwrap();
    assert_eq!(found["status"], "cancelled");
    f.handle(
        "configure",
        json!({"config": merge(&configured(), json!({"allowed_workspaces": []}))}),
    )
    .await
    .unwrap();
    assert_eq!(
        last_action_status(&f.service.snapshot().await.unwrap()),
        "cancelled"
    );
    f.handle("configure", json!({"config": configured()}))
        .await
        .unwrap();
    let last = propose(&f, "four").await;
    f.service.dispose().await;
    let mut saved = f.saved();
    // Also exercise an interrupted receipt without issuing any real operation.
    let interrupted = merge(&last, json!({"id": "interrupted", "status": "executing"}));
    let messages = saved["messages"].as_array_mut().unwrap();
    messages.last_mut().unwrap()["actions"]
        .as_array_mut()
        .unwrap()
        .push(interrupted);
    std::fs::write(f.state_path(), serde_json::to_string(&saved).unwrap()).unwrap();
    let restored = f.restart(f.driver.clone());
    let actions = actions_of(&restored.snapshot().await.unwrap());
    let status = |id: &Value| {
        actions
            .iter()
            .find(|a| a["id"] == *id)
            .map(|a| a["status"].clone())
            .unwrap()
    };
    assert_eq!(status(&last["id"]), "cancelled");
    assert_eq!(status(&json!("interrupted")), "uncertain");
    restored
        .handle("action.confirm", json!({"action_id": "interrupted"}))
        .await
        .unwrap();
    restored
        .handle("action.confirm", json!({"action_id": last["id"]}))
        .await
        .unwrap();
    assert_eq!(count(&calls), 0);
    f.finish().await;
}

#[tokio::test]
async fn an_unsaved_confirmation_cannot_execute_and_invalid_action_snapshots_are_rejected() {
    let calls = counter();
    let f = setup_driver(|d| {
        d.set_run(|input| async move {
            input
                .propose(
                    "send_prompt",
                    json!({
                        "connection_id": "local", "workspace_id": "ws",
                        "pane_id": "p1", "prompt": "Review this change",
                    }),
                )
                .await?;
            Ok(vec![])
        });
    });
    let count_calls = calls.clone();
    f.context.set_prepare(move |_, _, _| {
        let count = count_calls.clone();
        async move {
            Ok(action(
                preview(
                    "send_prompt",
                    "Send review feedback",
                    json!({"pane_id": "p1", "prompt": "Review this change"}),
                ),
                move || async move {
                    bump(&count);
                    Err(plain_err("secret=/private/token"))
                },
            ))
        }
    });
    f.handle("configure", json!({"config": configured()}))
        .await
        .unwrap();
    f.handle(
        "send",
        json!({"request_id": "one", "text": "Send feedback"}),
    )
    .await
    .unwrap();
    until(|| stopped(&f)).await;
    let snapshot = f.service.snapshot().await.unwrap();
    let id = last_message(&snapshot)["actions"][0]["id"].clone();
    let mut tampered = snapshot.clone();
    tampered["messages"]
        .as_array_mut()
        .unwrap()
        .last_mut()
        .unwrap()["actions"][0]["params"]["prompt"] = json!({"html": "invalid"});
    assert!(!is_snapshot(&tampered));
    std::fs::remove_file(f.state_path()).unwrap();
    std::fs::create_dir(f.state_path()).unwrap();
    assert_err(
        f.handle("action.confirm", json!({"action_id": id})).await,
        "Nothing was executed",
    );
    assert_eq!(count(&calls), 0);
    std::fs::remove_dir_all(f.state_path()).unwrap();
    f.handle("action.confirm", json!({"action_id": id}))
        .await
        .unwrap();
    until(|| last_action_status(&f.last_snapshot()) == "uncertain").await;
    assert_eq!(count(&calls), 1);
    assert!(
        !serde_json::to_string(&f.service.snapshot().await.unwrap())
            .unwrap()
            .contains("secret=")
    );
    f.handle("action.confirm", json!({"action_id": id}))
        .await
        .unwrap();
    assert_eq!(count(&calls), 1);
    f.finish().await;
}

#[tokio::test]
async fn streams_a_bounded_snapshot_deduplicates_browser_sends_freezes_scope_and_rejects_mutations_while_running()
 {
    let calls = counter();
    let pending = Deferred::<()>::new();
    let checks = list::<bool>();
    let (count_calls, wait, seen) = (calls.clone(), pending.clone(), checks.clone());
    let finish = pending.clone();
    let f = setup_driver(move |d| {
        d.set_run(move |input| {
            let (count, wait, seen) = (count_calls.clone(), wait.clone(), seen.clone());
            async move {
                bump(&count);
                let mut ok = Vec::new();
                ok.push(input.config()["allowed_workspaces"] == allowed());
                ok.push(input.text().contains("\"runtime_generation\":7"));
                input.tool("read", "workspace_status", "running", None);
                let read = input.read("status", json!({})).await?;
                ok.push(read.text == "Workspace is working");
                let sources = read.sources.unwrap_or_default();
                ok.push(
                    sources.len() == 1
                        && sources[0]["id"] == "source-1"
                        && sources[0]["kind"] == "status",
                );
                seen.lock().unwrap().extend(ok);
                input.delta("Answer ");
                input.delta("stream");
                let _ = wait.wait().await;
                input.message("Answer stream");
                input.tool("read", "workspace_status", "completed", None);
                Ok(vec![json!({"finalized": true})])
            }
        });
        d.set_stop(move || {
            finish.resolve(());
            async { Ok(()) }
        });
    });
    f.handle("configure", configured()).await.unwrap();
    let admitted = f
        .handle(
            "bridge.assistant.send",
            json!({"request_id": "same", "text": "How is it going?"}),
        )
        .await
        .unwrap();
    assert_eq!(admitted["running"], true);
    f.handle("send", json!({"request_id": "same", "text": "duplicate"}))
        .await
        .unwrap();
    assert_eq!(count(&calls), 1);
    until(|| !f.context.reads().is_empty()).await;
    assert_eq!(f.context.reads()[0].0[0]["runtime_generation"], 7);
    assert_err(
        f.handle("send", json!({"request_id": "new", "text": "other"}))
            .await,
        "busy",
    );
    assert_err(f.handle("configure", configured()).await, "busy");
    assert_err(f.handle("new_session", json!({})).await, "busy");
    assert_err(
        f.handle(
            "select_session",
            json!({"session_id": admitted["session_id"]}),
        )
        .await,
        "busy",
    );
    let stopped_snapshot = f.handle("stop", json!({})).await.unwrap();
    assert_eq!(stopped_snapshot["running"], false);
    assert_eq!(stopped_snapshot["messages"][1]["text"], "Answer stream");
    assert_eq!(
        stopped_snapshot["messages"][1]["sources"][0]["id"],
        "source-1"
    );
    assert_eq!(f.last_snapshot()["running"], false);
    assert_eq!(*checks.lock().unwrap(), vec![true; 4]);
    f.finish().await;
}

#[tokio::test]
async fn keeps_separate_conversations_and_restores_transcript_sdk_history_and_dedup_ids_without_reverting_global_configuration()
 {
    let inputs = list::<Input>();
    let seen = inputs.clone();
    let f = setup_driver(move |d| {
        d.set_run(move |input| {
            let count = record(&seen, &input);
            async move {
                input.message(&format!("Answer {count}"));
                Ok(vec![json!({"turn": count})])
            }
        });
    });
    f.handle("configure", configured()).await.unwrap();
    f.handle(
        "send",
        json!({"request_id": "same-request", "text": "First conversation\nMore details"}),
    )
    .await
    .unwrap();
    until(|| stopped(&f)).await;
    let first = f.service.snapshot().await.unwrap();
    assert_eq!(first["sessions"].as_array().unwrap().len(), 1);
    assert_matches(
        &first["sessions"][0],
        json!({"id": first["session_id"], "title": "First conversation", "message_count": 2}),
    );
    let empty = f.handle("new_session", json!({})).await.unwrap();
    assert_ne!(empty["session_id"], first["session_id"]);
    assert_eq!(empty["messages"], json!([]));
    assert_eq!(empty["sessions"].as_array().unwrap().len(), 2);
    f.handle(
        "send",
        json!({"request_id": "same-request", "text": "Second conversation"}),
    )
    .await
    .unwrap();
    until(|| stopped(&f)).await;
    let second = f.service.snapshot().await.unwrap();
    f.handle(
        "configure",
        merge(&configured(), json!({"credential_source": "pi"})),
    )
    .await
    .unwrap();
    let selected = f
        .handle("select_session", json!({"session_id": first["session_id"]}))
        .await
        .unwrap();
    assert_eq!(selected["messages"], first["messages"]);
    assert_eq!(selected["config"]["credential_source"], "pi");
    f.handle(
        "send",
        json!({"request_id": "same-request", "text": "Duplicate"}),
    )
    .await
    .unwrap();
    assert_eq!(inputs.lock().unwrap().len(), 2);
    f.handle(
        "send",
        json!({"request_id": "continue", "text": "Continue"}),
    )
    .await
    .unwrap();
    until(|| stopped(&f)).await;
    {
        let inputs = inputs.lock().unwrap();
        assert_eq!(inputs[2].entries(), json!([{"turn": 1}]));
        assert_eq!(inputs[2].config()["credential_source"], "pi");
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode =
            |path: &std::path::Path| std::fs::metadata(path).unwrap().permissions().mode() & 0o777;
        let sessions = f.directory.join("sessions");
        assert_eq!(mode(&sessions), 0o700);
        assert_eq!(
            mode(&sessions.join(format!("{}.json", first["session_id"].as_str().unwrap()))),
            0o600
        );
    }
    f.service.dispose().await;
    let restored = f.restart(f.driver.clone());
    let restart = restored.snapshot().await.unwrap();
    assert_eq!(restart["session_id"], first["session_id"]);
    assert_eq!(restart["sessions"].as_array().unwrap().len(), 2);
    let old = restored
        .handle(
            "select_session",
            json!({"session_id": second["session_id"]}),
        )
        .await
        .unwrap();
    assert_eq!(old["messages"], second["messages"]);
    assert_eq!(old["config"]["credential_source"], "pi");
    restored
        .handle(
            "send",
            json!({"request_id": "same-request", "text": "Duplicate after switching and restarting"}),
        )
        .await
        .unwrap();
    assert_eq!(inputs.lock().unwrap().len(), 3);
    assert!(is_snapshot(&restored.snapshot().await.unwrap()));
    f.finish().await;
}

#[tokio::test]
async fn migrates_the_existing_single_chat_and_avoids_accumulating_empty_conversations() {
    let f = setup();
    f.handle("configure", configured()).await.unwrap();
    f.handle(
        "send",
        json!({
            "request_id": "old",
            "text": format!("{}\nPrivate second line", "Long title ".repeat(20)),
        }),
    )
    .await
    .unwrap();
    until(|| stopped(&f)).await;
    f.service.dispose().await;
    let mut legacy = f.saved();
    legacy.as_object_mut().unwrap().shift_remove("session_id");
    legacy.as_object_mut().unwrap().shift_remove("sessions");
    std::fs::write(f.state_path(), serde_json::to_string(&legacy).unwrap()).unwrap();
    let restored = f.restart(f.driver.clone());
    let original = restored.snapshot().await.unwrap();
    assert_eq!(original["messages"], legacy["messages"]);
    assert_eq!(f.saved()["session_id"], original["session_id"]);
    let text = legacy["messages"][0]["text"].as_str().unwrap();
    let expected: String = text.split('\n').next().unwrap().chars().take(72).collect();
    assert_eq!(original["sessions"][0]["title"], expected);
    let empty = restored.handle("new_session", json!({})).await.unwrap();
    assert_eq!(empty["sessions"].as_array().unwrap().len(), 2);
    let another = restored.handle("new_session", json!({})).await.unwrap();
    let sessions = another["sessions"].as_array().unwrap();
    assert_eq!(sessions.len(), 2);
    assert_eq!(
        sessions
            .iter()
            .find(|s| s["id"] == another["session_id"])
            .unwrap()["title"],
        "New chat"
    );
    assert!(!sessions.iter().any(|s| s["id"] == empty["session_id"]));
    assert_eq!(
        restored
            .handle(
                "select_session",
                json!({"session_id": original["session_id"]})
            )
            .await
            .unwrap()["messages"],
        legacy["messages"]
    );
    assert_eq!(
        restored.snapshot().await.unwrap()["sessions"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    f.finish().await;
}

#[tokio::test]
async fn accepts_legacy_snapshots_but_rejects_malformed_session_metadata_without_leaving_an_unusable_service()
 {
    let f = setup();
    let snapshot = f.service.snapshot().await.unwrap();
    let mut legacy = snapshot.clone();
    legacy.as_object_mut().unwrap().shift_remove("session_id");
    legacy.as_object_mut().unwrap().shift_remove("sessions");
    assert!(is_snapshot(&legacy));
    assert!(!is_snapshot(&merge(
        &legacy,
        json!({"session_id": snapshot["session_id"]})
    )));
    assert!(!is_snapshot(&merge(
        &legacy,
        json!({"sessions": snapshot["sessions"]})
    )));
    let session = snapshot["sessions"][0].clone();
    assert!(!is_snapshot(&merge(
        &snapshot,
        json!({"sessions": [merge(&session, json!({"id": "../secret"}))]})
    )));
    assert!(!is_snapshot(&merge(
        &snapshot,
        json!({"sessions": [session, session]})
    )));
    assert!(!is_snapshot(&merge(
        &snapshot,
        json!({"sessions": [merge(&session, json!({"message_count": -1}))]})
    )));
    f.handle("configure", configured()).await.unwrap();
    f.service.dispose().await;
    let saved = f.saved();
    let without = |key: &str| {
        let mut value = saved.clone();
        value.as_object_mut().unwrap().shift_remove(key);
        value
    };
    for malformed in [
        without("sessions"),
        without("session_id"),
        Value::Null,
        json!(42),
    ] {
        std::fs::write(f.state_path(), serde_json::to_string(&malformed).unwrap()).unwrap();
        let restored = f.restart(f.driver.clone());
        let result = restored.snapshot().await.unwrap();
        assert_eq!(
            result["error"],
            "The saved Ranger session could not be loaded."
        );
        assert!(is_snapshot(&result));
        assert_eq!(
            restored.handle("new_session", json!({})).await.unwrap()["messages"],
            json!([])
        );
        restored.dispose().await;
    }
    f.finish().await;
}

#[tokio::test]
async fn rejects_stale_browser_sends_and_invalid_session_selection_without_reading_arbitrary_paths_or_damaging_the_active_chat()
 {
    let f = setup();
    f.handle("configure", configured()).await.unwrap();
    f.handle("send", json!({"request_id": "one", "text": "Saved"}))
        .await
        .unwrap();
    until(|| stopped(&f)).await;
    let saved = f.service.snapshot().await.unwrap();
    let active = f.handle("new_session", json!({})).await.unwrap();
    assert_err(
        f.handle(
            "send",
            json!({"request_id": "one", "text": "Wrong chat", "session_id": saved["session_id"]}),
        )
        .await,
        "active Ranger chat changed",
    );
    for id in [
        "../state",
        "/tmp/secret",
        "",
        "00000000-0000-0000-0000-000000000000",
    ] {
        assert!(
            f.handle("select_session", json!({"session_id": id}))
                .await
                .is_err()
        );
    }
    assert_err(
        f.handle(
            "select_session",
            json!({"session_id": saved["session_id"], "path": "state.json"}),
        )
        .await,
        "only a saved session identifier",
    );
    let path = f
        .directory
        .join("sessions")
        .join(format!("{}.json", saved["session_id"].as_str().unwrap()));
    let original = std::fs::read_to_string(&path).unwrap();
    let select = || f.handle("select_session", json!({"session_id": saved["session_id"]}));
    std::fs::write(&path, "secret=/private/provider-token").unwrap();
    assert_err(select().await, "The saved Ranger chat could not be loaded.");
    let snapshot = f.service.snapshot().await.unwrap();
    assert_eq!(snapshot["session_id"], active["session_id"]);
    assert_eq!(snapshot["messages"], json!([]));
    std::fs::write(&path, "a".repeat(3_000_001)).unwrap();
    assert_err(select().await, "The saved Ranger chat could not be loaded.");
    std::fs::remove_file(&path).unwrap();
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(f.state_path(), &path).unwrap();
        assert_err(select().await, "The saved Ranger chat could not be loaded.");
        std::fs::remove_file(&path).unwrap();
    }
    std::fs::write(&path, original).unwrap();
    assert_eq!(select().await.unwrap()["messages"], saved["messages"]);
    f.finish().await;
}

#[tokio::test]
async fn restored_conversations_retain_confirmed_outcomes_while_their_pending_previews_can_never_execute()
 {
    let calls = counter();
    let f = setup_driver(|d| {
        d.set_run(|input| async move {
            input
                .propose(
                    "start_agent",
                    json!({"connection_id": "local", "workspace_id": "ws", "pane_id": "p1", "agent": "pi"}),
                )
                .await?;
            Ok(vec![json!({"remembered": true})])
        });
    });
    start_pi_context(&f, &calls);
    f.handle("configure", configured()).await.unwrap();
    f.handle("send", json!({"request_id": "confirmed", "text": "Start"}))
        .await
        .unwrap();
    until(|| stopped(&f)).await;
    let confirmed = last_message(&f.service.snapshot().await.unwrap())["actions"][0].clone();
    f.handle("action.confirm", json!({"action_id": confirmed["id"]}))
        .await
        .unwrap();
    until(|| last_action_status(&f.last_snapshot()) == "succeeded").await;
    f.handle("send", json!({"request_id": "pending", "text": "Another"}))
        .await
        .unwrap();
    until(|| stopped(&f)).await;
    let old = f.service.snapshot().await.unwrap();
    let pending = last_message(&old)["actions"][0].clone();
    f.handle("new_session", json!({})).await.unwrap();
    let archived = read_json(
        &f.directory
            .join("sessions")
            .join(format!("{}.json", old["session_id"].as_str().unwrap())),
    );
    assert_eq!(last_action_status(&archived), "cancelled");
    let selected = f
        .handle("select_session", json!({"session_id": old["session_id"]}))
        .await
        .unwrap();
    assert_eq!(
        selected["messages"][1]["actions"][0],
        merge(
            &confirmed,
            json!({"status": "succeeded", "detail": "Started"})
        )
    );
    assert_eq!(last_action_status(&selected), "cancelled");
    f.handle("action.confirm", json!({"action_id": pending["id"]}))
        .await
        .unwrap();
    f.handle("action.confirm", json!({"action_id": confirmed["id"]}))
        .await
        .unwrap();
    assert_eq!(count(&calls), 1);
    f.finish().await;
}

#[tokio::test]
async fn archive_and_active_save_failures_leave_the_previous_conversation_history_and_pending_confirmation_intact()
 {
    let calls = counter();
    let f = setup_driver(|d| {
        d.set_run(|input| async move {
            input
                .propose(
                    "start_agent",
                    json!({"connection_id": "local", "workspace_id": "ws", "pane_id": "p1", "agent": "pi"}),
                )
                .await?;
            Ok(vec![json!({"current": true})])
        });
    });
    start_pi_context(&f, &calls);
    f.handle("configure", configured()).await.unwrap();
    f.handle("send", json!({"request_id": "first", "text": "First"}))
        .await
        .unwrap();
    until(|| stopped(&f)).await;
    let first = f.service.snapshot().await.unwrap();
    f.handle("new_session", json!({})).await.unwrap();
    f.handle("send", json!({"request_id": "second", "text": "Second"}))
        .await
        .unwrap();
    until(|| stopped(&f)).await;
    let before = f.service.snapshot().await.unwrap();
    let index = f.state_path();
    let index_before = std::fs::read_to_string(&index).unwrap();
    let archive = f
        .directory
        .join("sessions")
        .join(format!("{}.json", before["session_id"].as_str().unwrap()));
    std::fs::create_dir_all(&archive).unwrap();
    assert_err(
        f.handle("new_session", json!({})).await,
        "could not be saved",
    );
    assert_eq!(std::fs::read_to_string(&index).unwrap(), index_before);
    let now = f.service.snapshot().await.unwrap();
    assert_eq!(now["messages"], before["messages"]);
    assert_eq!(now["sessions"], before["sessions"]);
    std::fs::remove_dir_all(&archive).unwrap();
    let backup = f.directory.join("state.json.backup");
    std::fs::rename(&index, &backup).unwrap();
    std::fs::create_dir(&index).unwrap();
    assert_err(
        f.handle("select_session", json!({"session_id": first["session_id"]}))
            .await,
        "could not be saved",
    );
    let now = f.service.snapshot().await.unwrap();
    assert_eq!(now["session_id"], before["session_id"]);
    assert_eq!(now["messages"], before["messages"]);
    assert_eq!(now["sessions"], before["sessions"]);
    assert_eq!(std::fs::read_to_string(&backup).unwrap(), index_before);
    assert_eq!(last_action_status(&read_json(&archive)), "cancelled");
    std::fs::remove_dir_all(&index).unwrap();
    std::fs::rename(&backup, &index).unwrap();
    f.handle("send", json!({"request_id": "second", "text": "Duplicate"}))
        .await
        .unwrap();
    assert_eq!(
        f.service.snapshot().await.unwrap()["messages"],
        before["messages"]
    );
    f.handle(
        "action.confirm",
        json!({"action_id": last_message(&before)["actions"][0]["id"]}),
    )
    .await
    .unwrap();
    until(|| last_action_status(&f.last_snapshot()) == "succeeded").await;
    assert_eq!(count(&calls), 1);
    f.finish().await;
}

#[tokio::test]
async fn switching_a_saved_chat_keeps_workspace_scope_and_runtime_safeguards_and_rejects_switching_during_login()
 {
    let histories = list::<Value>();
    let seen = histories.clone();
    let f = setup_driver(move |d| {
        d.set_run(move |input| {
            seen.lock().unwrap().push(input.entries());
            async move {
                input.message("Done");
                Ok(vec![json!({"private_context": true})])
            }
        });
        d.set_login(|_, _, login| async move {
            login
                .prompt(json!({"type": "secret", "message": "Key"}))
                .await?;
            Ok(())
        });
    });
    f.handle("configure", configured()).await.unwrap();
    f.handle("send", json!({"request_id": "first", "text": "Read"}))
        .await
        .unwrap();
    until(|| stopped(&f)).await;
    let first = f.service.snapshot().await.unwrap();
    f.handle("new_session", json!({})).await.unwrap();
    f.handle(
        "auth.start",
        json!({"provider": "test", "method": "api_key"}),
    )
    .await
    .unwrap();
    assert_err(
        f.handle("select_session", json!({"session_id": first["session_id"]}))
            .await,
        "busy",
    );
    f.handle("auth.cancel", json!({})).await.unwrap();
    f.handle(
        "configure",
        merge(&configured(), json!({"allowed_workspaces": []})),
    )
    .await
    .unwrap();
    let selected = f
        .handle("select_session", json!({"session_id": first["session_id"]}))
        .await
        .unwrap();
    assert_eq!(selected["config"]["allowed_workspaces"], json!([]));
    assert_err(
        f.handle("send", json!({"request_id": "escape", "text": "Continue"}))
            .await,
        "authorized",
    );
    f.handle("configure", configured()).await.unwrap();
    f.context.set_capture(|_| async {
        Ok(json!([merge(
            &workspace(),
            json!({"runtime_generation": 8})
        )]))
    });
    f.handle(
        "send",
        json!({"request_id": "generation", "text": "New runtime"}),
    )
    .await
    .unwrap();
    until(|| stopped(&f)).await;
    assert_eq!(histories.lock().unwrap()[1], json!([]));
    f.finish().await;
}

#[tokio::test]
async fn maps_async_authentication_prompts_and_never_broadcasts_submitted_secrets_or_provider_errors()
 {
    let secret = "test-secret-with-private-token";
    let values = list::<String>();
    let seen = values.clone();
    let f = setup_driver(move |d| {
        d.set_login(move |_, _, login| {
            let seen = seen.clone();
            async move {
                let value = login
                    .prompt(json!({"type": "secret", "message": "API key"}))
                    .await?;
                seen.lock().unwrap().push(value.clone());
                Err(plain_err(&format!("Provider failed with {value}")))
            }
        });
    });
    f.handle("configure", configured()).await.unwrap();
    let started = f
        .handle(
            "auth.start",
            json!({"provider": "test", "method": "api_key"}),
        )
        .await
        .unwrap();
    assert_eq!(started["auth"]["prompt"]["type"], "secret");
    assert_err(
        f.handle(
            "auth.respond",
            json!({"auth_id": "old", "prompt_id": "old", "value": secret}),
        )
        .await,
        "no longer active",
    );
    f.handle(
        "auth.respond",
        json!({
            "auth_id": started["auth"]["id"],
            "prompt_id": started["auth"]["prompt"]["id"],
            "value": secret,
        }),
    )
    .await
    .unwrap();
    until(|| f.last_snapshot()["auth"]["status"] == "failed").await;
    assert_eq!(*values.lock().unwrap(), vec![secret.to_owned()]);
    assert_eq!(
        f.last_snapshot()["auth"]["message"],
        "Provider login failed. Try again."
    );
    assert!(
        !serde_json::to_string(&f.snapshots())
            .unwrap()
            .contains(secret)
    );
    assert_eq!(f.service.snapshot().await.unwrap()["messages"], json!([]));
    f.finish().await;
}

#[tokio::test]
async fn cancelling_an_api_key_update_clears_login_state_and_preserves_saved_credentials_for_retry()
{
    let saved_key = Arc::new(Mutex::new("existing-key".to_owned()));
    let key = saved_key.clone();
    let f = setup_driver(move |d| {
        d.set_login(move |_, _, login| {
            let key = key.clone();
            async move {
                let value = login
                    .prompt(json!({"type": "secret", "message": "API key"}))
                    .await?;
                *key.lock().unwrap() = value;
                Ok(())
            }
        });
    });
    f.handle("configure", configured()).await.unwrap();
    for _ in 0..2 {
        let started = f
            .handle(
                "auth.start",
                json!({"provider": "test", "method": "api_key"}),
            )
            .await
            .unwrap();
        assert_eq!(started["auth"]["status"], "waiting");
        let cancelled = f
            .handle("auth.cancel", json!({"auth_id": started["auth"]["id"]}))
            .await
            .unwrap();
        assert_eq!(cancelled["auth"], Value::Null);
        assert_eq!(f.last_snapshot()["auth"], Value::Null);
        assert_eq!(cancelled["providers"][0]["configured"], true);
        assert_eq!(*saved_key.lock().unwrap(), "existing-key");
        assert_err(
            f.handle(
                "auth.respond",
                json!({
                    "auth_id": started["auth"]["id"],
                    "prompt_id": started["auth"]["prompt"]["id"],
                    "value": "late-response",
                }),
            )
            .await,
            "no longer active",
        );
    }
    assert!(
        !f.snapshots()
            .iter()
            .any(|snapshot| snapshot["auth"]["status"] == "failed")
    );
    f.finish().await;
}

#[tokio::test]
async fn cancels_oauth_and_reads_pi_credentials_only_after_explicitly_switching_source() {
    let sources = list::<String>();
    let login_sources = list::<String>();
    let (seen, logins) = (sources.clone(), login_sources.clone());
    let f = setup_driver(move |d| {
        d.set_catalog(move |source| {
            seen.lock().unwrap().push(source);
            async { Ok(catalog()) }
        });
        d.set_login(move |_, _, login| {
            logins.lock().unwrap().push(login.source.clone());
            async move {
                login.notify(json!({
                    "type": "device_code",
                    "userCode": "ABCD",
                    "verificationUri": "https://example.com/device",
                }));
                login
                    .prompt(json!({"type": "manual_code", "message": "Code"}))
                    .await?;
                Ok(())
            }
        });
    });
    assert!(sources.lock().unwrap().is_empty());
    f.handle("get", json!({})).await.unwrap();
    assert_eq!(*sources.lock().unwrap(), vec!["assistant".to_owned()]);
    f.handle("configure", configured()).await.unwrap();
    let start = f
        .handle("auth.start", json!({"provider": "test", "method": "oauth"}))
        .await
        .unwrap();
    assert_eq!(start["auth"]["user_code"], "ABCD");
    let pi = merge(&configured(), json!({"credential_source": "pi"}));
    assert_err(f.handle("configure", pi.clone()).await, "busy");
    assert_eq!(
        f.service.snapshot().await.unwrap()["config"]["credential_source"],
        "assistant"
    );
    let cancelled = f
        .handle("auth.cancel", json!({"auth_id": start["auth"]["id"]}))
        .await
        .unwrap();
    assert_eq!(cancelled["auth"], Value::Null);
    assert_eq!(f.last_snapshot()["auth"], Value::Null);
    f.handle("configure", pi).await.unwrap();
    assert_eq!(sources.lock().unwrap().last().unwrap(), "pi");
    let pi_start = f
        .handle("auth.start", json!({"provider": "test", "method": "oauth"}))
        .await
        .unwrap();
    assert_eq!(pi_start["auth"]["user_code"], "ABCD");
    assert_eq!(
        *login_sources.lock().unwrap(),
        vec!["assistant".to_owned(), "pi".to_owned()]
    );
    assert_err(f.handle("configure", configured()).await, "busy");
    f.handle("auth.cancel", json!({"auth_id": pi_start["auth"]["id"]}))
        .await
        .unwrap();
    let switched = f.handle("configure", configured()).await.unwrap();
    assert_eq!(switched["auth"], Value::Null);
    assert_eq!(switched["config"]["credential_source"], "assistant");
    f.finish().await;
}

// ------------------------------------------------------------ model connections

/// The custom model connections a driver keeps (models.json through the
/// service's save, keys in auth.json), as Pi's driver keeps them.
fn custom_models(f: &Fixture, d: &FakeDriver) {
    let models = f.directory.join("models.json");
    let auth = f.directory.join("auth.json");
    let read = |path: &std::path::Path| -> AssistantResult<Value> {
        match std::fs::read_to_string(path) {
            Ok(text) => serde_json::from_str(&text)
                .map_err(|_| plain_err(&format!("Invalid {}: {text}", path.display()))),
            Err(_) => Ok(json!({})),
        }
    };
    let (path, keys) = (models.clone(), auth.clone());
    d.set_configure(move |input, save| {
        let (path, keys) = (path.clone(), keys.clone());
        async move {
            let provider = input["provider"].as_str().unwrap().to_owned();
            if provider == "anthropic" {
                return Err(plain_err("Built-in providers cannot be replaced"));
            }
            let mut saved = read(&path)?;
            if saved.get("providers").is_none() {
                saved = json!({"providers": {}});
            }
            let mut stored = read(&keys)?;
            if input.get("api_key").is_none() && stored.get(&provider).is_none() {
                return Err(plain_err("A new connection needs its API key"));
            }
            let mut entry = saved["providers"]
                .get(&provider)
                .cloned()
                .unwrap_or_else(|| json!({}));
            entry["baseUrl"] = input["base_url"].clone();
            entry["api"] = input["api"].clone();
            let ids = input
                .get("models")
                .cloned()
                .unwrap_or_else(|| json!([input["model"]]));
            let existing = entry["models"].as_array().cloned().unwrap_or_default();
            let mut list: Vec<Value> = existing.clone();
            for id in ids.as_array().unwrap() {
                if !list.iter().any(|m| m["id"] == *id) {
                    list.push(json!({"id": id}));
                }
            }
            entry["models"] = Value::Array(list);
            if let Some(reasoning) = input.get("reasoning") {
                entry["reasoning"] = reasoning.clone();
            }
            if let Some(levels) = input.get("thinking_levels") {
                entry["thinkingLevels"] = levels.clone();
                entry["reasoning"] = json!(levels.as_array().unwrap().iter().any(|l| l != "off"));
            }
            saved["providers"][&provider] = entry;
            save(path.display().to_string(), saved)?;
            if let Some(key) = input.get("api_key") {
                stored[&provider] = json!({"type": "api_key", "key": key});
                std::fs::write(&keys, serde_json::to_string(&stored).unwrap()).unwrap();
                #[cfg(unix)]
                {
                    use std::os::unix::fs::PermissionsExt;
                    std::fs::set_permissions(&keys, std::fs::Permissions::from_mode(0o600))
                        .unwrap();
                }
            }
            Ok(())
        }
    });
    let (path, keys) = (models, auth);
    d.set_catalog(move |_| {
        let (path, keys) = (path.clone(), keys.clone());
        async move {
            let saved = read(&path)?;
            let stored = read(&keys)?;
            let mut catalog = catalog();
            for (id, entry) in saved["providers"].as_object().into_iter().flatten() {
                let custom = json!({"base_url": entry["baseUrl"], "api": entry["api"]});
                catalog["providers"].as_array_mut().unwrap().push(json!({
                    "id": id, "label": id, "methods": ["api_key"],
                    "configured": stored.get(id).is_some(), "credential_method": "api_key",
                    "custom": custom,
                }));
                let reasoning = entry["reasoning"] == true;
                for model in entry["models"].as_array().into_iter().flatten() {
                    let mut custom = custom.clone();
                    if entry.get("reasoning").is_some() {
                        custom["reasoning"] = json!(reasoning);
                    }
                    let mut listed = json!({
                        "provider": id, "id": model["id"], "label": model["id"], "custom": custom,
                    });
                    if let Some(levels) = entry.get("thinkingLevels") {
                        listed["thinking_levels"] = levels.clone();
                        listed["default_thinking_level"] = levels[0].clone();
                    } else if reasoning {
                        listed["thinking_levels"] =
                            json!(["off", "minimal", "low", "medium", "high"]);
                    }
                    catalog["models"].as_array_mut().unwrap().push(listed);
                }
            }
            Ok(catalog)
        }
    });
}

#[tokio::test]
async fn custom_model_connections_validate_input_preserve_configuration_and_use_their_saved_endpoint_and_key()
 {
    let runs = list::<Value>();
    let seen = runs.clone();
    let f = setup();
    custom_models(&f, &f.driver);
    f.driver.set_run(move |input| {
        seen.lock().unwrap().push(input.config().clone());
        async move {
            input.message("Custom model answer.");
            Ok(vec![])
        }
    });
    let input = json!({
        "provider": "Local.test",
        "model": "local-model",
        "base_url": "http://127.0.0.1:1234/v1",
        "api": "anthropic-messages",
        "api_key": "synthetic-first-key",
        "credential_source": "assistant",
    });
    let without_key = || {
        let mut value = input.clone();
        value.as_object_mut().unwrap().shift_remove("api_key");
        value
    };
    let path = f.directory.join("models.json");
    let auth = f.directory.join("auth.json");
    assert_err(
        f.handle("configure_model", without_key()).await,
        "could not be saved",
    );
    let connected = f
        .handle(
            "configure_model",
            merge(
                &input,
                json!({"models": ["local-model", "second-model", "local-model"]}),
            ),
        )
        .await
        .unwrap();
    assert_eq!(connected["config"]["provider"], "");
    let provider = connected["providers"]
        .as_array()
        .unwrap()
        .iter()
        .find(|p| p["id"] == "Local.test")
        .unwrap()
        .clone();
    assert_matches(
        &provider,
        json!({
            "configured": true,
            "credential_method": "api_key",
            "custom": {"base_url": "http://127.0.0.1:1234/v1", "api": "anthropic-messages"},
        }),
    );
    let saved = read_json(&path);
    assert_eq!(
        saved["providers"]["Local.test"]["models"],
        json!([{"id": "local-model"}, {"id": "second-model"}])
    );
    assert!(
        !std::fs::read_to_string(&path)
            .unwrap()
            .contains("synthetic-first-key")
    );
    let key = "synthetic-replacement-key";
    let batch = f
        .handle(
            "configure_model",
            merge(
                &input,
                json!({
                    "models": ["local-model", " third-model ", "second-model", "third-model"],
                    "api_key": key,
                }),
            ),
        )
        .await
        .unwrap();
    let ids: Vec<Value> = batch["models"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|m| m["provider"] == "Local.test")
        .map(|m| m["id"].clone())
        .collect();
    assert_eq!(
        ids,
        vec![
            json!("local-model"),
            json!("second-model"),
            json!("third-model")
        ]
    );
    f.handle("configure_model", without_key()).await.unwrap();
    assert_eq!(read_json(&auth)["Local.test"]["key"], key);
    let enabled = f
        .handle(
            "configure_model",
            merge(&without_key(), json!({"reasoning": true})),
        )
        .await
        .unwrap();
    let model = |snapshot: &Value| {
        snapshot["models"]
            .as_array()
            .unwrap()
            .iter()
            .find(|m| m["id"] == "local-model")
            .unwrap()
            .clone()
    };
    assert_matches(
        &model(&enabled),
        json!({
            "thinking_levels": ["off", "minimal", "low", "medium", "high"],
            "custom": {"reasoning": true},
        }),
    );
    let before = std::fs::read_to_string(&path).unwrap();
    let auth_before = std::fs::read_to_string(&auth).unwrap();
    let mut invalids = vec![
        json!({"provider": "anthropic"}),
        json!({"provider": "__proto__"}),
        json!({"base_url": "javascript:secret-value"}),
        json!({"base_url": "https://secret:password@example.com"}),
        json!({"base_url": "https://example.com?api_key=secret-value"}),
        json!({"api": "unsupported"}),
        json!({"reasoning": "true"}),
        json!({"reasoning": null}),
        json!({"reasoning": 1}),
        json!({"thinking_levels": "high"}),
        json!({"thinking_levels": null}),
        json!({"thinking_levels": []}),
        json!({"thinking_levels": ["ultra"]}),
        json!({"thinking_levels": ["high", "high"]}),
        json!({"thinking_levels": ["high"], "reasoning": false}),
        json!({"thinking_levels": ["off"], "reasoning": true}),
        json!({"api_key": "!touch secret-value"}),
        json!({"api_key": "$SECRET_VALUE"}),
        json!({"credential_source": "pi"}),
        json!({"models": "local-model,second-model"}),
        json!({"models": null}),
        json!({"models": []}),
        json!({"models": ["other-model"]}),
        json!({"models": ["local-model", "new-model", " "]}),
        json!({"models": ["local-model", "new-model", 123]}),
        json!({"models": ["local-model", "new-model", "x".repeat(501)]}),
        json!({"models": ["local-model", "new-model", "bad\u{0}model"]}),
    ];
    invalids.push(json!({"models": vec!["local-model"; ASSISTANT_MAX_CUSTOM_MODELS + 1]}));
    for invalid in invalids {
        let params = merge(
            &merge(&input, json!({"api_key": "synthetic-should-not-save-key"})),
            invalid.clone(),
        );
        assert_err(
            f.handle("configure_model", params).await,
            "could not be saved",
        );
        assert_eq!(std::fs::read_to_string(&path).unwrap(), before, "{invalid}");
        assert_eq!(
            std::fs::read_to_string(&auth).unwrap(),
            auth_before,
            "{invalid}"
        );
    }
    let custom = |model: &str, level: Option<&str>| {
        let mut value = merge(
            &configured(),
            json!({"provider": "Local.test", "model": model}),
        );
        if let Some(level) = level {
            value["thinking_level"] = json!(level);
        }
        value
    };
    f.handle("configure", custom("local-model", Some("high")))
        .await
        .unwrap();
    f.handle(
        "send",
        json!({"request_id": "custom-first", "text": "Say hello"}),
    )
    .await
    .unwrap();
    until(|| f.peek()["running"] == false).await;
    assert_eq!(last_message(&f.peek())["text"], "Custom model answer.");
    assert_eq!(runs.lock().unwrap()[0]["thinking_level"], "high");
    let restricted = f
        .handle(
            "configure_model",
            merge(
                &without_key(),
                json!({"thinking_levels": ["high", "xhigh", "max"]}),
            ),
        )
        .await
        .unwrap();
    assert_matches(
        &model(&restricted),
        json!({
            "thinking_levels": ["high", "xhigh", "max"],
            "default_thinking_level": "high",
            "custom": {"reasoning": true},
        }),
    );
    assert_err(
        f.handle("configure", custom("local-model", Some("low")))
            .await,
        "could not be saved",
    );
    let disabled = f
        .handle(
            "configure_model",
            merge(&without_key(), json!({"thinking_levels": ["off"]})),
        )
        .await
        .unwrap();
    assert_matches(
        &model(&disabled),
        json!({"thinking_levels": ["off"], "custom": {"reasoning": false}}),
    );
    assert_err(
        f.handle("configure", custom("local-model", Some("high")))
            .await,
        "could not be saved",
    );
    let mut updated = read_json(&path);
    updated["providers"]["Local.test"]["models"]
        .as_array_mut()
        .unwrap()
        .push(json!({"id": "external-model"}));
    std::fs::write(&path, serde_json::to_string(&updated).unwrap()).unwrap();
    assert!(
        f.service.snapshot().await.unwrap()["models"]
            .as_array()
            .unwrap()
            .iter()
            .any(|m| m["id"] == "external-model")
    );
    f.handle("configure", custom("external-model", None))
        .await
        .unwrap();
    f.handle(
        "send",
        json!({"request_id": "custom-refreshed", "text": "Say hello again"}),
    )
    .await
    .unwrap();
    until(|| f.peek()["running"] == false).await;
    assert_eq!(runs.lock().unwrap()[1]["model"], "external-model");
    assert!(!serde_json::to_string(&f.snapshots()).unwrap().contains(key));
    assert!(
        !std::fs::read_to_string(f.state_path())
            .unwrap()
            .contains(key)
    );
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = |p: &std::path::Path| std::fs::metadata(p).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode(&path), 0o600);
        assert_eq!(mode(&auth), 0o600);
    }
    std::fs::write(&path, "private-malformed-model-configuration").unwrap();
    assert_eq!(
        f.service.snapshot().await.unwrap()["error"],
        "The provider catalog could not be loaded."
    );
    assert!(
        !serde_json::to_string(&f.snapshots())
            .unwrap()
            .contains("private-malformed")
    );
    f.finish().await;
}

#[tokio::test]
async fn validates_optional_credential_metadata_while_retaining_old_snapshot_compatibility() {
    let f = setup();
    let mut snapshot = f.service.snapshot().await.unwrap();
    assert!(is_snapshot(&snapshot));
    snapshot["providers"][0]["credential_method"] = json!("oauth");
    assert!(is_snapshot(&snapshot));
    let mut expired = snapshot.clone();
    expired["providers"][0]["credential_method"] = json!("expired");
    assert!(!is_snapshot(&expired));
    f.finish().await;
}

#[tokio::test]
async fn a_changed_workspace_generation_clears_historical_model_context() {
    let histories = list::<Value>();
    let seen = histories.clone();
    let f = setup_driver(move |d| {
        d.set_run(move |input| {
            seen.lock().unwrap().push(input.entries());
            async move {
                input.message("Done");
                Ok(vec![json!({"last_generation": 7})])
            }
        });
    });
    f.handle("configure", configured()).await.unwrap();
    f.handle(
        "send",
        json!({"request_id": "first", "text": "Read status"}),
    )
    .await
    .unwrap();
    until(|| stopped(&f)).await;
    f.handle("send", json!({"request_id": "second", "text": "Continue"}))
        .await
        .unwrap();
    until(|| stopped(&f)).await;
    assert_eq!(
        histories.lock().unwrap()[1],
        json!([{"last_generation": 7}])
    );
    f.context.set_capture(|_| async {
        Ok(json!([merge(
            &workspace(),
            json!({"runtime_generation": 8})
        )]))
    });
    f.handle(
        "send",
        json!({"request_id": "third", "text": "Read new runtime"}),
    )
    .await
    .unwrap();
    until(|| stopped(&f)).await;
    assert_eq!(histories.lock().unwrap()[2], json!([]));
    f.finish().await;
}

#[tokio::test]
async fn failed_admission_can_retry_the_same_request_and_save_failures_roll_back_mutations() {
    let f = setup();
    f.handle("configure", configured()).await.unwrap();
    let capture = f.context.capture_fn();
    f.context
        .set_capture(|_| async { Err(plain_err("Disconnected")) });
    assert_err(
        f.handle("send", json!({"request_id": "retry", "text": "Hello"}))
            .await,
        "could not be opened",
    );
    f.context.set_capture(move |refs| capture(refs));
    f.handle("send", json!({"request_id": "retry", "text": "Hello"}))
        .await
        .unwrap();
    until(|| stopped(&f)).await;
    assert_eq!(
        f.service.snapshot().await.unwrap()["messages"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
    std::fs::remove_file(f.state_path()).unwrap();
    std::fs::create_dir(f.state_path()).unwrap();
    assert_err(
        f.handle(
            "configure",
            merge(&configured(), json!({"provider": "", "model": ""})),
        )
        .await,
        "could not be saved",
    );
    assert_eq!(
        f.service.snapshot().await.unwrap()["config"]["provider"],
        "test"
    );
    assert_err(
        f.handle("new_session", json!({})).await,
        "could not be saved",
    );
    assert_eq!(
        f.service.snapshot().await.unwrap()["messages"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
    f.finish().await;
}

#[tokio::test]
async fn keeps_the_transcript_and_sdk_history_within_storage_and_snapshot_ceilings() {
    let f = setup_driver(|d| {
        d.set_run(|input| async move {
            input.delta(&"a".repeat(100_000));
            input.message(&"a".repeat(100_000));
            Ok(vec![json!({"too_large": "a".repeat(1_100_000)})])
        });
    });
    f.handle("configure", configured()).await.unwrap();
    f.handle("send", json!({"request_id": "large", "text": "Answer"}))
        .await
        .unwrap();
    until(|| stopped(&f)).await;
    let state = f.service.snapshot().await.unwrap();
    assert_eq!(state["messages"][1]["text"].as_str().unwrap().len(), 32_000);
    assert!(serde_json::to_string(&state).unwrap().len() < 4_000_000);
    assert_eq!(f.saved()["entries"], json!([]));
    f.finish().await;
}

#[test]
fn reasoning_limits_keep_the_newest_steps_and_report_what_was_dropped() {
    let bound = |steps: Vec<String>| {
        let result = bound_assistant_thinking(&steps);
        json!({"steps": result.steps, "skipped": result.skipped, "truncated": result.truncated})
    };
    let s = |text: &str| text.to_owned();
    assert_eq!(
        bound(vec![]),
        json!({"steps": [], "skipped": 0, "truncated": false})
    );
    assert_eq!(
        bound(vec![s("plan"), s("check")]),
        json!({"steps": ["plan", "check"], "skipped": 0, "truncated": false})
    );
    let half = ASSISTANT_MAX_THINKING / 2;
    // The oldest kept step loses its start; earlier steps are skipped.
    assert_eq!(
        bound(vec![
            s("first"),
            format!("{}tail", "a".repeat(half)),
            "b".repeat(half)
        ]),
        json!({
            "steps": [format!("{}tail", "a".repeat(half - 4)), "b".repeat(half)],
            "skipped": 1,
            "truncated": true,
        })
    );
    assert_eq!(
        bound(vec![s("early"), "c".repeat(ASSISTANT_MAX_THINKING)]),
        json!({"steps": ["c".repeat(ASSISTANT_MAX_THINKING)], "skipped": 1, "truncated": true})
    );
    // A cut through an emoji drops its orphaned half and fills the budget.
    assert_eq!(
        bound(vec![
            s("earlier"),
            format!("x\u{1F600}{}", "b".repeat(ASSISTANT_MAX_THINKING - 1))
        ]),
        json!({"steps": ["b".repeat(ASSISTANT_MAX_THINKING - 1)], "skipped": 1, "truncated": true})
    );
    // One unit of budget over an older emoji leaves nothing to keep.
    assert_eq!(
        bound(vec![
            s("older \u{1F600}"),
            "n".repeat(ASSISTANT_MAX_THINKING - 1)
        ]),
        json!({"steps": ["n".repeat(ASSISTANT_MAX_THINKING - 1)], "skipped": 1, "truncated": true})
    );
    let many: Vec<String> = (0..ASSISTANT_MAX_THINKING_STEPS + 2)
        .map(|index| index.to_string())
        .collect();
    assert_eq!(
        bound(many.clone()),
        json!({"steps": many[2..], "skipped": 2, "truncated": true})
    );
}

#[tokio::test]
async fn keeps_bounded_reasoning_and_sheds_it_from_older_turns_before_history() {
    let f = setup_driver(|d| {
        d.set_run(|input| async move {
            input.emit(RunEvent::Thinking(vec![
                "early".into(),
                "t".repeat(ASSISTANT_MAX_THINKING),
            ]));
            input.delta(&"a".repeat(32_000));
            input.message(&"a".repeat(32_000));
            Ok(vec![])
        });
    });
    f.handle("configure", configured()).await.unwrap();
    // Each turn holds about 48 KB, so 24 turns exceed the 1 MB message
    // budget with reasoning and fit without it.
    for turn in 0..24 {
        f.handle(
            "send",
            json!({"request_id": format!("r{turn}"), "text": "Go"}),
        )
        .await
        .unwrap();
        until(|| stopped(&f)).await;
    }
    let messages = f.service.snapshot().await.unwrap()["messages"].clone();
    let list = messages.as_array().unwrap();
    assert_eq!(list.len(), 48);
    assert_matches(
        list.last().unwrap(),
        json!({
            "thinking": ["t".repeat(ASSISTANT_MAX_THINKING)],
            "thinking_skipped": 1,
            "thinking_truncated": true,
        }),
    );
    for key in ["thinking", "thinking_skipped", "thinking_truncated"] {
        assert!(list[1].get(key).is_none());
    }
    assert!(serde_json::to_string(&messages).unwrap().len() <= 1_000_000);
    f.finish().await;
}

// ------------------------------------------------------------ recovery

#[tokio::test]
async fn persists_the_admitted_run_before_execution_and_resumes_its_original_model_with_fresh_leases()
 {
    let closed = Deferred::<()>::new();
    let (wait, close) = (closed.clone(), closed.clone());
    let f = setup_driver(move |d| {
        d.set_run(move |input| {
            let wait = wait.clone();
            async move {
                input
                    .checkpoint(vec![json!({"type": "ranger-durable", "id": "context"})])
                    .await?;
                input.emit(RunEvent::Replace("Interrupted partial".into()));
                let _ = wait.wait().await;
                Ok(input.input.entries.clone())
            }
        });
        d.set_dispose(move || {
            close.resolve(());
            async { Ok(()) }
        });
    });
    let targets = json!([{
        "connection_id": "local",
        "workspace_id": "ws",
        "endpoint_fingerprint": "a".repeat(64),
        "workspace_identity": "b".repeat(64),
        "herdr_boot_id": "same-herdr",
    }]);
    let given = targets.clone();
    f.context.set_recovery(move |_| {
        let given = given.clone();
        async move { Ok(given) }
    });
    f.handle("configure", configured()).await.unwrap();
    f.handle(
        "send",
        json!({"request_id": "durable", "text": "Read status"}),
    )
    .await
    .unwrap();
    until(|| {
        std::fs::read_to_string(f.state_path())
            .ok()
            .and_then(|text| serde_json::from_str::<Value>(&text).ok())
            .is_some_and(|saved| saved["entries"][0]["type"] == "ranger-durable")
    })
    .await;
    let admitted = f.saved();
    assert_eq!(admitted["active_run"]["request_id"], "durable");
    assert_eq!(admitted["active_run"]["config"], configured());
    f.service.dispose().await;
    assert!(f.saved().get("active_run").is_some());
    let inputs = list::<Input>();
    let restored = flag();
    let order = list::<bool>();
    let driver = f.driver.copy();
    let (seen, was_restored, checked) = (inputs.clone(), restored.clone(), order.clone());
    driver.set_run(move |input| {
        checked
            .lock()
            .unwrap()
            .push(was_restored.load(Ordering::SeqCst));
        seen.lock().unwrap().push(input.clone());
        async move {
            input.emit(RunEvent::Replace("Recovered answer".into()));
            input.read("status", json!({})).await?;
            Ok(input.input.entries.clone())
        }
    });
    let (expected, marked) = (targets.clone(), restored.clone());
    let compared = list::<bool>();
    let same = compared.clone();
    f.context.set_restore(move |saved| {
        same.lock().unwrap().push(saved == expected);
        marked.store(true, Ordering::SeqCst);
        async {
            Ok(json!([merge(
                &workspace(),
                json!({"runtime_generation": 8})
            )]))
        }
    });
    let mut options = f.options(Some(driver));
    let recorded = f.snapshots.clone();
    options.publish = Arc::new(move |snapshot| recorded.lock().unwrap().push(snapshot));
    let service = f.restart_with(options);
    service.resume().await.unwrap();
    until(|| stopped(&f)).await;
    assert_eq!(*compared.lock().unwrap(), vec![true]);
    assert_eq!(*order.lock().unwrap(), vec![true]);
    {
        let inputs = inputs.lock().unwrap();
        assert_eq!(inputs.len(), 1);
        assert!(inputs[0].input.recover);
        assert_eq!(inputs[0].request_id(), "durable");
        assert_matches(inputs[0].config(), configured());
    }
    assert_eq!(f.context.reads()[0].0[0]["runtime_generation"], 8);
    let snapshot = service.snapshot().await.unwrap();
    assert_eq!(
        snapshot["messages"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|m| m["role"] == "user")
            .count(),
        1
    );
    assert_eq!(snapshot["messages"][1]["text"], "Recovered answer");
    assert!(f.saved().get("active_run").is_none());
    service
        .handle(
            "send",
            json!({"request_id": "durable", "text": "Duplicate"}),
        )
        .await
        .unwrap();
    assert_eq!(inputs.lock().unwrap().len(), 1);
    f.finish().await;
}

#[tokio::test]
async fn stop_durably_revokes_recovery_before_awaiting_the_drivers_abort() {
    let completed = Deferred::<()>::new();
    let (wait, done) = (completed.clone(), completed.clone());
    let f = setup_driver(move |d| {
        d.set_run(move |input| {
            let wait = wait.clone();
            async move {
                let _ = wait.wait().await;
                Ok(input.input.entries.clone())
            }
        });
        d.set_dispose(move || {
            done.resolve(());
            async { Ok(()) }
        });
    });
    let observed = slot::<Value>();
    let (path, seen, finish) = (f.state_path(), observed.clone(), completed.clone());
    f.driver.set_stop(move || {
        *seen.lock().unwrap() = Some(read_json(&path));
        finish.resolve(());
        async { Ok(()) }
    });
    f.handle("configure", configured()).await.unwrap();
    f.handle(
        "send",
        json!({"request_id": "cancel-before-abort", "text": "Read"}),
    )
    .await
    .unwrap();
    assert!(f.saved().get("active_run").is_some());
    f.handle("stop", json!({})).await.unwrap();
    assert_eq!(f.service.snapshot().await.unwrap()["running"], false);
    let saved = observed.lock().unwrap().clone().unwrap();
    assert!(saved.get("active_run").is_none());
    assert_eq!(saved["entries"], json!([]));
    f.finish().await;
}

/// A turn left waiting on `closed`, its fixture disposed while it runs.
fn interrupted(run_tool: bool) -> Fixture {
    let closed = Deferred::<()>::new();
    let (wait, close) = (closed.clone(), closed);
    setup_driver(move |d| {
        d.set_run(move |input| {
            let wait = wait.clone();
            async move {
                if run_tool {
                    input.tool("interrupted-read", "workspace_status", "running", None);
                    input.checkpoint(input.input.entries.clone()).await?;
                }
                let _ = wait.wait().await;
                Ok(input.input.entries.clone())
            }
        });
        d.set_dispose(move || {
            close.resolve(());
            async { Ok(()) }
        });
    })
}

fn counting_driver(f: &Fixture, starts: &Arc<AtomicUsize>) -> Arc<FakeDriver> {
    let driver = f.driver.copy();
    let counted = starts.clone();
    driver.set_run(move |_| {
        bump(&counted);
        async { Ok(vec![]) }
    });
    driver
}

#[tokio::test]
async fn rejects_recovery_for_without_starting_a_model() {
    for reason in [
        "removed permission",
        "changed endpoint",
        "unsupported identity",
    ] {
        let f = interrupted(false);
        let unsupported = reason == "unsupported identity";
        f.context.set_recovery(move |_| async move {
            Ok(if unsupported {
                json!([])
            } else {
                json!([recovery_target("same")])
            })
        });
        f.handle("configure", configured()).await.unwrap();
        f.handle("send", json!({"request_id": "blocked", "text": "Read"}))
            .await
            .unwrap();
        f.service.dispose().await;
        if reason == "removed permission" {
            let mut state = f.saved();
            state["config"]["allowed_workspaces"] = json!([]);
            std::fs::write(f.state_path(), serde_json::to_string(&state).unwrap()).unwrap();
        }
        let starts = counter();
        f.context
            .set_restore(|_| async { Err(plain_err("Target changed")) });
        let service = f.restart(counting_driver(&f, &starts));
        service.resume().await.unwrap();
        assert_eq!(count(&starts), 0, "{reason}");
        let state = service.snapshot().await.unwrap();
        assert_eq!(state["running"], false, "{reason}");
        assert!(
            state["error"]
                .as_str()
                .unwrap()
                .contains("could not safely resume"),
            "{reason}"
        );
        f.finish().await;
    }
}

#[tokio::test]
async fn waiting_recovery_can_resume_or_be_explicitly_cancelled_cancel() {
    for cancel in [false, true] {
        let f = interrupted(true);
        f.context
            .set_recovery(|_| async { Ok(json!([recovery_target("same")])) });
        f.handle("configure", configured()).await.unwrap();
        f.handle("send", json!({"request_id": "waiting", "text": "Read"}))
            .await
            .unwrap();
        f.service.dispose().await;
        let starts = counter();
        let ready = flag();
        let is_ready = ready.clone();
        f.context.set_restore(move |_| {
            let ready = is_ready.load(Ordering::SeqCst);
            async move {
                if ready {
                    Ok(json!([workspace()]))
                } else {
                    Err(not_ready("Not ready"))
                }
            }
        });
        let service = f.restart(counting_driver(&f, &starts));
        service.resume().await.unwrap();
        let waiting = service.snapshot().await.unwrap();
        assert_eq!(waiting["running"], true);
        assert!(waiting["error"].as_str().unwrap().contains("Waiting"));
        assert_eq!(count(&starts), 0);
        if cancel {
            service.handle("stop", json!({})).await.unwrap();
        }
        ready.store(true, Ordering::SeqCst);
        let (a, b) = tokio::join!(service.resume(), service.resume());
        a.unwrap();
        b.unwrap();
        assert_eq!(
            count(&starts),
            if cancel { 0 } else { 1 },
            "cancel: {cancel}"
        );
        let snapshot = service.snapshot().await.unwrap();
        assert_eq!(snapshot["running"], false, "cancel: {cancel}");
        assert_eq!(
            last_message(&snapshot)["tools"][0]["status"],
            "failed",
            "cancel: {cancel}"
        );
        assert!(f.saved().get("active_run").is_none(), "cancel: {cancel}");
        f.finish().await;
    }
}
