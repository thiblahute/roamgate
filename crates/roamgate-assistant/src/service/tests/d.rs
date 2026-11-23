//! Mentions, addressed messages, task references and the task management
//! tools (service.test.ts "Ranger mentions" through "committed
//! cancellation survives concurrent proposals and session changes").

use std::sync::atomic::AtomicI64;

use super::*;

/// `chatSelection(snapshot)`.
fn chat_selection(snapshot: &Value) -> Value {
    let config = &snapshot["config"];
    let mut selection = json!({
        "instance_id": snapshot["instance_id"],
        "provider": config["provider"],
        "model": config["model"],
        "credential_source": config["credential_source"],
    });
    if let Some(level) = config.get("thinking_level") {
        selection["thinking_level"] = level.clone();
    }
    selection
}

fn running(f: &Fixture) -> bool {
    f.peek()["running"] == true
}

fn task_create_input(title: &str, prompt: &str, minutes: u64) -> Value {
    json!({
        "title": title,
        "prompt": prompt,
        "scope": allowed(),
        "schedule": {"type": "interval", "minutes": minutes},
    })
}

fn identity_bind(f: &Fixture) {
    f.context
        .set_bind(|_scope, targets| async move { Ok(targets) });
}

fn last_proposal_mentions(f: &Fixture) -> Value {
    last_message(&f.peek())["task_proposals"][0]["mentions"].clone()
}

#[tokio::test]
async fn catalog_admits_only_granted_workspaces_and_rechecks_permissions_after_discovery() {
    let f = setup();
    let queries = counter();
    let seen = queries.clone();
    f.context.set_mentions(move |_| {
        bump(&seen);
        async { Ok(json!({"targets": [mentioned_agent()], "errors": []})) }
    });
    f.handle("configure", configured()).await.unwrap();
    assert_err(
        f.service
            .mention_catalog(
                json!({"scope": [{"connection_id": "local", "workspace_id": "private"}]}),
            )
            .await,
        "authorized",
    );
    assert_eq!(count(&queries), 0);
    assert_eq!(
        f.service
            .mention_catalog(json!({"scope": allowed()}))
            .await
            .unwrap()["targets"],
        json!([mentioned_agent()])
    );
    let service = f.service.clone();
    f.context.set_mentions(move |_| {
        let service = service.clone();
        async move {
            service
                .handle(
                    "configure",
                    merge(&configured(), json!({"allowed_workspaces": []})),
                )
                .await?;
            Ok(json!({"targets": [mentioned_agent()], "errors": []}))
        }
    });
    assert_err(
        f.service.mention_catalog(json!({"scope": allowed()})).await,
        "authorized",
    );
    f.finish().await;
}

#[tokio::test]
async fn binds_references_before_model_admission_and_preserves_original_labels_through_history_and_retries()
 {
    let inputs = list::<Input>();
    let recorded = inputs.clone();
    let f = setup_driver(move |d| {
        d.set_run(move |input| {
            recorded.lock().unwrap().push(input);
            async { Ok(vec![]) }
        });
    });
    f.context.set_bind(|_scope, targets| async move {
        Ok(Value::Array(
            targets
                .as_array()
                .unwrap()
                .iter()
                .map(|t| merge(t, json!({"label": "Renamed Agent"})))
                .collect(),
        ))
    });
    f.handle("configure", configured()).await.unwrap();
    let submission = json!({
        "text": "Check @Codex",
        "mentions": [agent_marker()],
        "request_id": "mention",
    });
    f.handle("send", submission.clone()).await.unwrap();
    until(|| !running(&f)).await;
    let text = inputs.lock().unwrap()[0].text().to_owned();
    assert!(text.contains("\"label\":\"Renamed Agent\""));
    assert!(text.contains(&"c".repeat(64)));
    assert_eq!(f.peek()["messages"][0]["mentions"], json!([agent_marker()]));
    f.handle("send", submission).await.unwrap();
    assert_eq!(inputs.lock().unwrap().len(), 1);
    f.handle("new_session", json!({})).await.unwrap();
    let original = f.peek()["sessions"]
        .as_array()
        .unwrap()
        .iter()
        .find(|s| s["message_count"].as_u64().unwrap() > 0)
        .unwrap()["id"]
        .clone();
    f.handle("select_session", json!({"session_id": original}))
        .await
        .unwrap();
    assert_eq!(f.peek()["messages"][0]["mentions"], json!([agent_marker()]));
    f.finish().await;
}

// ------------------------------------------------------------ addressed

type RunStep = Arc<dyn Fn(Input) -> Fut<()> + Send + Sync>;

fn addressed_agent() -> Value {
    merge(&mentioned_agent(), json!({"start": 0, "end": 6}))
}

fn addressed_workspace() -> Value {
    merge(
        &workspace(),
        json!({
            "workspace_label": "Workspace",
            "kind": "workspace",
            "label": "Space",
            "start": 0,
            "end": 6,
        }),
    )
}

fn send_args() -> Value {
    json!({
        "connection_id": "local",
        "workspace_id": "ws",
        "pane_id": "pane",
        "prompt": "run the tests",
    })
}

struct Addressed {
    f: Fixture,
    inputs: Arc<Mutex<Vec<Input>>>,
    sent: Arc<Mutex<Vec<String>>>,
}

async fn send_addressed(
    text: &str,
    mention: Value,
    run: Option<RunStep>,
    approval: Option<&str>,
) -> Addressed {
    let inputs = list::<Input>();
    let sent = list::<String>();
    let recorded = inputs.clone();
    let f = setup_driver(move |d| {
        d.set_run(move |input| {
            recorded.lock().unwrap().push(input.clone());
            let run = run.clone();
            async move {
                if let Some(run) = run {
                    run(input).await?;
                }
                Ok(vec![])
            }
        });
    });
    f.context
        .set_bind(|_scope, targets| async move { Ok(targets) });
    let outbox = sent.clone();
    f.context.set_prepare(move |_, _, _| {
        let outbox = outbox.clone();
        async move {
            Ok(action(
                merge(
                    &workspace(),
                    json!({
                        "workspace_label": "Workspace",
                        "kind": "send_prompt",
                        "summary": "Send a prompt",
                        "params": {"pane_id": "pane", "prompt": "run the tests"},
                    }),
                ),
                move || async move {
                    outbox.lock().unwrap().push("run the tests".into());
                    Ok(json!({"status": "succeeded", "detail": "Herdr accepted the prompt"}))
                },
            ))
        }
    });
    f.handle("configure", json!({"config": configured()}))
        .await
        .unwrap();
    if let Some(approval) = approval {
        f.handle("configure_approval", json!({"approval_mode": approval}))
            .await
            .unwrap();
    }
    f.handle(
        "send",
        json!({"request_id": "addressed", "text": text, "mentions": [mention]}),
    )
    .await
    .unwrap();
    until(|| !running(&f)).await;
    Addressed { f, inputs, sent }
}

fn first_text(inputs: &Arc<Mutex<Vec<Input>>>) -> String {
    inputs.lock().unwrap()[0].text().to_owned()
}

#[tokio::test]
async fn tell_the_model_to_send_the_text_after_the_mention_to_that_agent() {
    let a = send_addressed("@Codex run the tests", addressed_agent(), None, None).await;
    let text = first_text(&a.inputs);
    assert!(text.contains("addressed to @Codex, the first referenced object"));
    assert!(text.contains("Call propose_agent_prompt with the exact prompt \"run the tests\""));
    a.f.finish().await;
}

#[tokio::test]
async fn a_question_or_a_mention_inside_the_message_stays_a_reference() {
    let question =
        send_addressed("@Codex what are you doing?", addressed_agent(), None, None).await;
    assert!(!first_text(&question.inputs).contains("This message is addressed"));
    question.f.finish().await;
    let inside = send_addressed(
        "Ask @Codex to run",
        merge(&mentioned_agent(), json!({"start": 4, "end": 10})),
        None,
        None,
    )
    .await;
    assert!(!first_text(&inside.inputs).contains("This message is addressed"));
    inside.f.finish().await;
    let reference = send_addressed(
        "What is @Codex doing",
        merge(&mentioned_agent(), json!({"start": 8, "end": 14})),
        None,
        None,
    )
    .await;
    assert!(!first_text(&reference.inputs).contains("This message is addressed"));
    reference.f.finish().await;
}

#[tokio::test]
async fn a_pending_prompt_waits_for_the_confirmation_a_full_access_one_is_sent() {
    let call: RunStep = Arc::new(|input: Input| {
        Box::pin(async move {
            input.message("Prepared.");
            input.propose("send_prompt", send_args()).await?;
            Ok(())
        })
    });
    let manual = send_addressed(
        "@Codex run the tests",
        addressed_agent(),
        Some(call.clone()),
        None,
    )
    .await;
    assert!(manual.sent.lock().unwrap().is_empty());
    let reply = last_message(&manual.f.peek());
    assert_matches(
        &reply["actions"][0],
        json!({"kind": "send_prompt", "status": "pending"}),
    );
    assert_eq!(reply["text"], "Prepared.");
    manual.f.finish().await;
    let auto = send_addressed(
        "@Codex run the tests",
        addressed_agent(),
        Some(call),
        Some("auto"),
    )
    .await;
    assert_eq!(*auto.sent.lock().unwrap(), vec!["run the tests".to_owned()]);
    auto.f.finish().await;
}

#[tokio::test]
async fn an_addressed_agent_message_with_no_prompt_gets_one_plain_answer() {
    let a = send_addressed(
        "@Codex run the tests",
        addressed_agent(),
        Some(Arc::new(|input: Input| {
            Box::pin(async move {
                input.delta("Hello! Ranger is connected.");
                input.message("Hello! Ranger is connected.");
                Ok(())
            })
        })),
        None,
    )
    .await;
    let reply = last_message(&a.f.peek());
    let text = reply["text"].as_str().unwrap();
    assert!(text.contains("Nothing was sent to @Codex"));
    assert!(!text.contains("Hello"));
    a.f.finish().await;
}

#[tokio::test]
async fn a_workspace_mention_names_workspace_status_and_never_forces_the_answer() {
    let a = send_addressed(
        "@Space run the tests",
        addressed_workspace(),
        Some(Arc::new(|input: Input| {
            Box::pin(async move {
                input.message("Which agent do you mean?");
                Ok(())
            })
        })),
        None,
    )
    .await;
    assert!(first_text(&a.inputs).contains("if exactly one Agent runs there"));
    assert_eq!(
        last_message(&a.f.peek())["text"],
        "Which agent do you mean?"
    );
    a.f.finish().await;
}

#[test]
fn the_system_prompt_says_how_mentions_work_and_that_the_open_workspace_is_unknown() {
    for automatic in [false, true] {
        let prompt = crate::tools::ranger_system_prompt(automatic);
        assert!(prompt.contains("addressed to that Agent"));
        assert!(prompt.contains("propose_agent_prompt"));
        assert!(prompt.contains("Never claim a current workspace"));
    }
}

#[tokio::test]
async fn invalid_spans_and_changed_sessions_fail_without_admitting_the_model_or_losing_the_retry() {
    let runs = counter();
    let seen = runs.clone();
    let f = setup_driver(move |d| {
        d.set_run(move |_| {
            bump(&seen);
            async { Ok(vec![]) }
        });
    });
    let changed = Arc::new(AtomicBool::new(true));
    let state = changed.clone();
    f.context.set_bind(move |_scope, targets| {
        let changed = state.load(Ordering::SeqCst);
        async move {
            if changed {
                return Err(plain_err(
                    "Mentioned agent session changed; select it again",
                ));
            }
            Ok(targets)
        }
    });
    f.handle("configure", configured()).await.unwrap();
    assert_err(
        f.handle(
            "send",
            json!({
                "text": "Check @Codex",
                "request_id": "retry-mention",
                "mentions": [merge(&agent_marker(), json!({"end": 11}))],
            }),
        )
        .await,
        "Invalid Ranger mentions",
    );
    let send = json!({
        "text": "Check @Codex",
        "request_id": "retry-mention",
        "mentions": [agent_marker()],
    });
    // The mentions step's fixed text says the session changed.
    let error = f.handle("send", send.clone()).await.unwrap_err();
    assert!(
        error.message().contains("session changed"),
        "{:?}",
        error.message()
    );
    assert_eq!(count(&runs), 0);
    assert_eq!(f.peek()["messages"], json!([]));
    changed.store(false, Ordering::SeqCst);
    f.handle("send", send).await.unwrap();
    until(|| !running(&f)).await;
    assert_eq!(count(&runs), 1);
    f.finish().await;
}

#[tokio::test]
async fn follow_up_reads_revalidate_the_last_explicitly_mentioned_session() {
    let runs = counter();
    let seen = runs.clone();
    let f = setup_driver(move |d| {
        d.set_run(move |input| {
            let run = bump(&seen);
            async move {
                if run == 2 {
                    input
                        .read(
                            "history",
                            json!({"connection_id": "local", "workspace_id": "ws", "pane_id": "pane"}),
                        )
                        .await?;
                }
                Ok(vec![])
            }
        });
    });
    let changed = flag();
    let state = changed.clone();
    f.context.set_bind(move |_scope, targets| {
        let changed = state.load(Ordering::SeqCst);
        async move {
            if changed {
                return Err(plain_err(
                    "Mentioned agent session changed; select it again",
                ));
            }
            Ok(targets)
        }
    });
    f.handle("configure", configured()).await.unwrap();
    f.handle(
        "send",
        json!({"text": "Check @Codex", "request_id": "first-mention", "mentions": [agent_marker()]}),
    )
    .await
    .unwrap();
    until(|| !running(&f)).await;
    changed.store(true, Ordering::SeqCst);
    f.handle(
        "send",
        json!({"text": "Read its history", "request_id": "follow-up-mention"}),
    )
    .await
    .unwrap();
    until(|| !running(&f)).await;
    assert_eq!(count(&runs), 2);
    assert!(f.context.reads().is_empty());
    assert!(f.peek()["error"].as_str().is_some_and(|e| !e.is_empty()));
    f.finish().await;
}

#[tokio::test]
async fn task_proposals_inherit_bound_targets_rather_than_only_their_names() {
    let f = setup_driver(|d| {
        d.set_run(|input| async move {
            input
                .task(
                    "create",
                    task_create_input(
                        "Monitor Agent",
                        "Notify when the selected Agent finishes",
                        1,
                    ),
                )
                .await?;
            Ok(vec![])
        });
    });
    f.context.stable_task_identity();
    identity_bind(&f);
    f.handle("configure", configured()).await.unwrap();
    f.handle(
        "send",
        json!({"text": "Check @Codex", "request_id": "task-mention", "mentions": [agent_marker()]}),
    )
    .await
    .unwrap();
    until(|| !running(&f)).await;
    assert_eq!(last_proposal_mentions(&f), json!([mentioned_agent()]));
    f.finish().await;
}

#[tokio::test]
async fn durable_recovery_rebinds_the_same_agent_identity_after_verified_workspace_recovery() {
    let closed = Deferred::<()>::new();
    let (waiting, closing) = (closed.clone(), closed.clone());
    let f = setup_driver(move |d| {
        d.set_run(move |input| {
            let closed = waiting.clone();
            async move {
                input
                    .checkpoint(vec![json!({"type": "ranger-durable", "id": "context"})])
                    .await?;
                let _ = closed.wait().await;
                Ok(input.input.entries.clone())
            }
        });
        d.set_dispose(move || {
            closing.resolve(());
            async { Ok(()) }
        });
    });
    f.context.stable_task_identity();
    let bindings = list::<Value>();
    let recorded = bindings.clone();
    f.context.set_bind(move |_scope, targets| {
        recorded.lock().unwrap().push(targets.clone());
        async move { Ok(targets) }
    });
    f.handle("configure", configured()).await.unwrap();
    f.handle(
        "send",
        json!({"text": "Check @Codex", "request_id": "recover-mention", "mentions": [agent_marker()]}),
    )
    .await
    .unwrap();
    until(|| {
        std::fs::read_to_string(f.state_path())
            .ok()
            .and_then(|text| serde_json::from_str::<Value>(&text).ok())
            .is_some_and(|saved| saved["entries"].as_array().is_some_and(|e| !e.is_empty()))
    })
    .await;
    f.service.dispose().await;
    f.context.set_restore(|_| async {
        Ok(json!([merge(
            &workspace(),
            json!({"runtime_generation": 8})
        )]))
    });
    let recovered = flag();
    let driver = f.driver.copy();
    let seen = recovered.clone();
    driver.set_run(move |input| {
        seen.store(input.input.recover, Ordering::SeqCst);
        async { Ok(vec![]) }
    });
    let service = f.restart(driver);
    service.resume().await.unwrap();
    until(|| service.peek()["running"] == false).await;
    assert!(recovered.load(Ordering::SeqCst));
    assert_eq!(
        bindings.lock().unwrap().last().cloned().unwrap(),
        json!([merge(&mentioned_agent(), json!({"runtime_generation": 8}))])
    );
    f.finish().await;
}

#[tokio::test]
async fn monitoring_preserves_unique_references_from_a_mention() {
    for variant in ["repeated", "follow-up"] {
        let runs = counter();
        let seen = runs.clone();
        let f = setup_driver(move |d| {
            d.set_run(move |input| {
                let run = bump(&seen);
                async move {
                    if variant == "repeated" || run == 2 {
                        input
                            .task(
                                "create",
                                task_create_input(
                                    "Monitor selected Agent",
                                    "Notify when it finishes",
                                    1,
                                ),
                            )
                            .await?;
                    }
                    Ok(vec![])
                }
            });
        });
        f.context.stable_task_identity();
        identity_bind(&f);
        f.handle("configure", configured()).await.unwrap();
        let (text, mentions) = if variant == "repeated" {
            (
                "Check @Codex and @Codex",
                json!([
                    agent_marker(),
                    merge(&agent_marker(), json!({"start": 17, "end": 23}))
                ]),
            )
        } else {
            ("Check @Codex", json!([agent_marker()]))
        };
        f.handle(
            "send",
            json!({"text": text, "request_id": format!("monitor-{variant}"), "mentions": mentions}),
        )
        .await
        .unwrap();
        until(|| !running(&f)).await;
        if variant == "follow-up" {
            f.handle(
                "send",
                json!({"text": "Notify when it finishes", "request_id": "follow-up-monitor"}),
            )
            .await
            .unwrap();
            until(|| !running(&f)).await;
        }
        assert_eq!(f.peek()["error"], Value::Null, "{variant}");
        assert_eq!(
            last_proposal_mentions(&f),
            json!([mentioned_agent()]),
            "{variant}"
        );
        f.finish().await;
    }
}

#[tokio::test]
async fn editing_a_saved_reference_after_reconnect_verifies_its_original_workspace_before_rebinding()
 {
    let f = setup();
    f.context.stable_task_identity();
    let generation = Arc::new(AtomicI64::new(7));
    let restored = flag();
    let current = generation.clone();
    f.context.set_capture(move |_| {
        let generation = current.load(Ordering::SeqCst);
        async move {
            Ok(json!([merge(
                &workspace(),
                json!({"runtime_generation": generation})
            )]))
        }
    });
    let (current, seen) = (generation.clone(), restored.clone());
    f.context.set_restore(move |_| {
        seen.store(true, Ordering::SeqCst);
        let generation = current.load(Ordering::SeqCst);
        async move {
            Ok(json!([merge(
                &workspace(),
                json!({"runtime_generation": generation})
            )]))
        }
    });
    let (current, seen) = (generation.clone(), restored.clone());
    f.context.set_bind(move |_scope, targets| {
        let generation = current.load(Ordering::SeqCst);
        assert!(
            targets
                .as_array()
                .unwrap()
                .iter()
                .all(|t| t["runtime_generation"] == generation)
        );
        if generation == 8 {
            assert!(seen.load(Ordering::SeqCst));
        }
        async move { Ok(targets) }
    });
    f.handle("configure", configured()).await.unwrap();
    let task = json!({
        "title": "Monitor",
        "prompt": "Watch Agent",
        "scope": allowed(),
        "schedule": {"type": "interval", "minutes": 5},
        "mentions": [mentioned_agent()],
    });
    f.handle("task.create", merge(&task, json!({"request_id": uuid()})))
        .await
        .unwrap();
    let id = f.peek()["tasks"][0]["id"].clone();
    generation.store(8, Ordering::SeqCst);
    restored.store(false, Ordering::SeqCst);
    f.handle(
        "task.update",
        merge(&task, json!({"task_id": id, "title": "Renamed monitor"})),
    )
    .await
    .unwrap();
    let peek = f.peek();
    assert_eq!(peek["error"], Value::Null);
    assert_eq!(peek["tasks"][0]["title"], "Renamed monitor");
    assert_eq!(
        peek["tasks"][0]["mentions"],
        json!([merge(&mentioned_agent(), json!({"runtime_generation": 8}))])
    );
    f.finish().await;
}

#[tokio::test]
async fn monitoring_an_earlier_agent_retains_its_identity_after_a_workspace_only_mention() {
    let runs = counter();
    let seen = runs.clone();
    let state = Arc::new(Mutex::new(PathBuf::new()));
    let path = state.clone();
    let f = setup_driver(move |d| {
        d.set_run(move |input| {
            let run = bump(&seen);
            let path = path.lock().unwrap().clone();
            async move {
                if run == 3 {
                    input
                        .read(
                            "history",
                            json!({"connection_id": "local", "workspace_id": "ws", "pane_id": "pane"}),
                        )
                        .await?;
                    let saved = read_json(&path);
                    assert!(
                        saved["active_run"]["mentions"]
                            .as_array()
                            .unwrap()
                            .iter()
                            .all(|t| t["workspace_id"] == "ws")
                    );
                    input
                        .task(
                            "create",
                            task_create_input(
                                "Monitor earlier Agent",
                                "Notify when the earlier Agent finishes",
                                1,
                            ),
                        )
                        .await?;
                }
                Ok(vec![])
            }
        });
    });
    *state.lock().unwrap() = f.state_path();
    f.context.stable_task_identity();
    let other = merge(
        &workspace(),
        json!({"workspace_id": "other", "label": "Other"}),
    );
    let listed = other.clone();
    f.context.set_catalog(move || {
        let other = listed.clone();
        async move { Ok(json!({"workspaces": [workspace(), other], "errors": []})) }
    });
    let held = other.clone();
    f.context.set_capture(move |scope| {
        let all = [workspace(), held.clone()];
        async move {
            Ok(Value::Array(
                all.into_iter()
                    .filter(|t| {
                        scope
                            .as_array()
                            .unwrap()
                            .iter()
                            .any(|r| r["workspace_id"] == t["workspace_id"])
                    })
                    .collect(),
            ))
        }
    });
    identity_bind(&f);
    f.handle(
        "configure",
        merge(
            &configured(),
            json!({"allowed_workspaces": [
                {"connection_id": "local", "workspace_id": "ws"},
                {"connection_id": "local", "workspace_id": "other"},
            ]}),
        ),
    )
    .await
    .unwrap();
    f.handle(
        "send",
        json!({"text": "Check @Codex", "request_id": "earlier-agent", "mentions": [agent_marker()]}),
    )
    .await
    .unwrap();
    until(|| !running(&f)).await;
    let workspace_mention = merge(
        &workspace(),
        json!({"workspace_label": "Workspace", "kind": "workspace", "start": 6, "end": 16}),
    );
    f.handle(
        "send",
        json!({
            "text": "Check @Workspace and @Other",
            "request_id": "intermediate-workspace",
            "mentions": [
                workspace_mention,
                merge(&workspace_mention, json!({
                    "workspace_id": "other", "label": "Other", "workspace_label": "Other",
                    "start": 21, "end": 27,
                })),
            ],
        }),
    )
    .await
    .unwrap();
    until(|| !running(&f)).await;
    f.handle(
        "send",
        json!({
            "text": "Read and monitor the earlier Agent",
            "request_id": "monitor-earlier-agent",
            "scope": allowed(),
        }),
    )
    .await
    .unwrap();
    until(|| !running(&f)).await;
    assert_eq!(f.peek()["error"], Value::Null);
    assert_eq!(f.context.reads().len(), 1);
    assert!(
        last_proposal_mentions(&f)
            .as_array()
            .unwrap()
            .contains(&mentioned_agent())
    );
    f.finish().await;
}

// ------------------------------------------------------------ task management

#[tokio::test]
async fn mode_applies_task_edits_and_controls_with_accurate_receipts() {
    for mode in ["manual", "auto"] {
        let kind: Arc<Mutex<&'static str>> = Arc::new(Mutex::new("update"));
        let task_id = Arc::new(Mutex::new(String::new()));
        let receipt = slot::<Value>();
        let (k, t, r) = (kind.clone(), task_id.clone(), receipt.clone());
        let f = setup_driver(move |d| {
            d.set_run(move |input| {
                let kind = *k.lock().unwrap();
                let id = t.lock().unwrap().clone();
                let receipt = r.clone();
                async move {
                    let mut args = json!({"task_id": id});
                    if kind == "update" {
                        args["title"] = json!("Edited from chat");
                        args["prompt"] = json!("Changed instructions");
                    }
                    let result = input.task(kind, args).await?;
                    *receipt.lock().unwrap() = Some(serde_json::from_str(&result.text).unwrap());
                    Ok(vec![])
                }
            });
        });
        f.context.stable_task_identity();
        f.handle("configure", configured()).await.unwrap();
        if mode == "auto" {
            f.handle("configure_approval", json!({"approval_mode": "auto"}))
                .await
                .unwrap();
        }
        f.handle(
            "task.create",
            merge(
                &task_create_input("Original", "Original instructions", 60),
                json!({"request_id": uuid()}),
            ),
        )
        .await
        .unwrap();
        let id = f.peek()["tasks"][0]["id"].as_str().unwrap().to_owned();
        *task_id.lock().unwrap() = id.clone();
        for operation in ["update", "pause", "resume", "cancel", "delete"] {
            *kind.lock().unwrap() = operation;
            *receipt.lock().unwrap() = None;
            f.handle(
                "send",
                json!({"request_id": uuid(), "text": format!("{operation} the task")}),
            )
            .await
            .unwrap();
            until(|| !running(&f)).await;
            let got = receipt.lock().unwrap().clone().unwrap_or(Value::Null);
            assert_matches(
                &got,
                json!({
                    "task_id": id,
                    "operation": operation,
                    "status": if mode == "auto" { "confirmed" } else { "pending" },
                }),
            );
            assert!(crate::wire::is_snapshot(&f.peek()));
            if mode == "manual" {
                if operation == "update" {
                    assert_eq!(f.peek()["tasks"][0]["title"], "Original");
                }
                if operation == "delete" {
                    assert_eq!(f.peek()["tasks"].as_array().unwrap().len(), 1);
                }
                f.handle("task.confirm_proposal", json!({"proposal_id": got["id"]}))
                    .await
                    .unwrap();
            }
            assert_eq!(
                last_message(&f.peek())["task_proposals"][0]["status"],
                "confirmed",
                "{mode} {operation}"
            );
            if operation == "delete" {
                assert_eq!(f.peek()["tasks"], json!([]));
            } else {
                assert_matches(
                    &f.peek()["tasks"][0],
                    json!({
                        "id": id,
                        "title": "Edited from chat",
                        "status": match operation {
                            "pause" => "paused",
                            "cancel" => "cancelled",
                            _ => "active",
                        },
                    }),
                );
            }
        }
        f.finish().await;
    }
}

#[tokio::test]
async fn a_manual_edit_downgrades_an_old_high_permission_task_without_changing_model_or_bound_references()
 {
    let id = Arc::new(Mutex::new(String::new()));
    let receipt = slot::<Value>();
    let (t, r) = (id.clone(), receipt.clone());
    let f = setup_driver(move |d| {
        d.set_run(move |input| {
            let id = t.lock().unwrap().clone();
            let receipt = r.clone();
            async move {
                let result = input
                    .task(
                        "update",
                        json!({"task_id": id, "prompt": "Newly approved instructions"}),
                    )
                    .await?;
                *receipt.lock().unwrap() = Some(serde_json::from_str(&result.text).unwrap());
                Ok(vec![])
            }
        });
    });
    f.context.stable_task_identity();
    identity_bind(&f);
    f.handle("configure", configured()).await.unwrap();
    f.handle("configure_approval", json!({"approval_mode": "auto"}))
        .await
        .unwrap();
    f.handle(
        "task.create",
        json!({
            "request_id": uuid(),
            "title": "Monitor",
            "prompt": "Original prompt",
            "mentions": [mentioned_agent()],
            "scope": allowed(),
            "schedule": {"type": "interval", "minutes": 60},
        }),
    )
    .await
    .unwrap();
    *id.lock().unwrap() = f.peek()["tasks"][0]["id"].as_str().unwrap().to_owned();
    assert_eq!(f.peek()["tasks"][0]["approval_mode"], "auto");
    f.handle("configure_approval", json!({"approval_mode": "manual"}))
        .await
        .unwrap();
    f.handle(
        "send",
        json!({"request_id": uuid(), "text": "Edit the task"}),
    )
    .await
    .unwrap();
    until(|| !running(&f)).await;
    let proposal = receipt.lock().unwrap().clone().unwrap()["id"].clone();
    f.handle("task.confirm_proposal", json!({"proposal_id": proposal}))
        .await
        .unwrap();
    f.handle("configure_approval", json!({"approval_mode": "auto"}))
        .await
        .unwrap();
    assert_matches(
        &f.peek()["tasks"][0],
        json!({
            "approval_mode": "manual",
            "model": {"provider": "test", "id": "model"},
            "mentions": [mentioned_agent()],
            "prompt": "Newly approved instructions",
        }),
    );
    f.finish().await;
}

#[tokio::test]
async fn cleanup_remains_available_after_its_original_model_and_monitored_agent_disappear() {
    let id = Arc::new(Mutex::new(String::new()));
    let operation: Arc<Mutex<&'static str>> = Arc::new(Mutex::new("pause"));
    let receipt = slot::<Value>();
    let (t, o, r) = (id.clone(), operation.clone(), receipt.clone());
    let f = setup_driver(move |d| {
        d.set_run(move |input| {
            let id = t.lock().unwrap().clone();
            let operation = *o.lock().unwrap();
            let receipt = r.clone();
            async move {
                let result = input.task(operation, json!({"task_id": id})).await?;
                *receipt.lock().unwrap() = Some(serde_json::from_str(&result.text).unwrap());
                Ok(vec![])
            }
        });
    });
    f.context.stable_task_identity();
    identity_bind(&f);
    f.handle("configure", configured()).await.unwrap();
    f.handle(
        "task.create",
        json!({
            "request_id": uuid(),
            "title": "Old monitor",
            "prompt": "Original prompt",
            "mentions": [mentioned_agent()],
            "scope": allowed(),
            "schedule": {"type": "interval", "minutes": 60},
        }),
    )
    .await
    .unwrap();
    *id.lock().unwrap() = f.peek()["tasks"][0]["id"].as_str().unwrap().to_owned();
    f.context
        .set_bind(|_, _| async { Err(plain_err("Monitored session ended")) });
    f.driver.set_catalog(|_| async {
        Ok(merge(
            &catalog(),
            json!({"models": [{"provider": "test", "id": "replacement", "label": "Replacement"}]}),
        ))
    });
    f.handle(
        "configure_chat",
        json!({
            "provider": "test",
            "model": "replacement",
            "thinking_level": null,
            "expected": chat_selection(&f.peek()),
        }),
    )
    .await
    .unwrap();
    for op in ["pause", "cancel", "delete"] {
        *operation.lock().unwrap() = op;
        f.handle(
            "send",
            json!({"request_id": uuid(), "text": format!("{op} old task")}),
        )
        .await
        .unwrap();
        until(|| !running(&f)).await;
        let got = receipt.lock().unwrap().clone().unwrap_or(Value::Null);
        assert_matches(&got, json!({"operation": op, "status": "pending"}));
        f.handle("task.confirm_proposal", json!({"proposal_id": got["id"]}))
            .await
            .unwrap();
    }
    assert_eq!(f.peek()["tasks"], json!([]));
    f.finish().await;
}

#[tokio::test]
async fn a_tool_cannot_propose_management_of_a_task_outside_the_captured_turn() {
    let task_id = Arc::new(Mutex::new(String::new()));
    let failure = Arc::new(Mutex::new(String::new()));
    let (t, out) = (task_id.clone(), failure.clone());
    let f = setup_driver(move |d| {
        d.set_run(move |input| {
            let id = t.lock().unwrap().clone();
            let out = out.clone();
            async move {
                if let Err(error) = input.task("pause", json!({"task_id": id})).await {
                    *out.lock().unwrap() = error.message().to_owned();
                }
                Ok(vec![])
            }
        });
    });
    f.context.stable_task_identity();
    let other = merge(&workspace(), json!({"workspace_id": "other"}));
    let listed = other.clone();
    f.context.set_catalog(move || {
        let other = listed.clone();
        async move { Ok(json!({"workspaces": [workspace(), other], "errors": []})) }
    });
    let held = other.clone();
    f.context.set_capture(move |refs| {
        let other = held.clone();
        async move {
            Ok(Value::Array(
                refs.as_array()
                    .unwrap()
                    .iter()
                    .map(|r| {
                        if r["workspace_id"] == "other" {
                            other.clone()
                        } else {
                            workspace()
                        }
                    })
                    .collect(),
            ))
        }
    });
    f.handle(
        "configure",
        merge(
            &configured(),
            json!({"allowed_workspaces": [
                {"connection_id": "local", "workspace_id": "ws"},
                {"connection_id": "local", "workspace_id": "other"},
            ]}),
        ),
    )
    .await
    .unwrap();
    f.handle(
        "task.create",
        json!({
            "request_id": uuid(),
            "title": "Other task",
            "prompt": "Original",
            "scope": [{"connection_id": "local", "workspace_id": "other"}],
            "schedule": {"type": "interval", "minutes": 60},
        }),
    )
    .await
    .unwrap();
    *task_id.lock().unwrap() = f.peek()["tasks"][0]["id"].as_str().unwrap().to_owned();
    f.handle(
        "send",
        json!({"request_id": uuid(), "text": "Pause task", "scope": allowed()}),
    )
    .await
    .unwrap();
    until(|| !running(&f)).await;
    assert!(
        failure.lock().unwrap().contains("authorized scope"),
        "{:?}",
        failure.lock().unwrap()
    );
    assert!(last_message(&f.peek()).get("task_proposals").is_none());
    assert_eq!(f.peek()["tasks"][0]["status"], "active");
    f.finish().await;
}

async fn promise_turns(count: usize) {
    for _ in 0..count {
        tokio::task::yield_now().await;
    }
}

#[tokio::test]
async fn pausing_during_child_preparation_prevents_model_dispatch_and_preserves_one_shot_resume() {
    let blocked = Arc::new(AtomicBool::new(true));
    let entered = flag();
    let dispatches = counter();
    let gate = Deferred::<()>::new();
    let (b, e, d, g) = (
        blocked.clone(),
        entered.clone(),
        dispatches.clone(),
        gate.clone(),
    );
    let child: ChildDriver = Arc::new(move || {
        let driver = FakeDriver::new();
        let (b, e, g) = (b.clone(), e.clone(), g.clone());
        driver.set_catalog(move |_| {
            let (b, e, g) = (b.clone(), e.clone(), g.clone());
            async move {
                if b.load(Ordering::SeqCst) {
                    e.store(true, Ordering::SeqCst);
                    let _ = g.wait().await;
                }
                Ok(catalog())
            }
        });
        let d = d.clone();
        driver.set_run(move |_| {
            bump(&d);
            async { Ok(vec![]) }
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
    f.handle("configure", configured()).await.unwrap();
    f.handle(
        "task.create",
        json!({
            "request_id": uuid(),
            "title": "Once",
            "prompt": "Check",
            "scope": allowed(),
            "schedule": {"type": "once", "at": "2026-10-04T00:01:00.000Z"},
        }),
    )
    .await
    .unwrap();
    let task_id = f.peek()["tasks"][0]["id"].clone();
    f.service.resume().await.unwrap();
    f.advance(60_000).await;
    promise_turns(100).await;
    assert!(entered.load(Ordering::SeqCst));
    f.handle("task.pause", json!({"task_id": task_id}))
        .await
        .unwrap();
    blocked.store(false, Ordering::SeqCst);
    gate.resolve(());
    promise_turns(200).await;
    assert_eq!(count(&dispatches), 0);
    assert_eq!(f.peek()["tasks"][0]["current_run"]["status"], "queued");
    f.handle("task.resume", json!({"task_id": task_id}))
        .await
        .unwrap();
    f.advance(0).await;
    promise_turns(200).await;
    assert_eq!(count(&dispatches), 1);
    assert_eq!(f.peek()["tasks"][0]["last_run"]["status"], "succeeded");
    f.finish().await;
}

#[tokio::test]
async fn direct_task_edits_capture_the_original_revision_before_asynchronous_preparation() {
    let f = setup();
    f.context.stable_task_identity();
    f.handle("configure", configured()).await.unwrap();
    let input = task_create_input("Original", "Original prompt", 60);
    f.handle("task.create", merge(&input, json!({"request_id": uuid()})))
        .await
        .unwrap();
    let task_id = f.peek()["tasks"][0]["id"].clone();
    let original = f.context.recovery_fn();
    let block = Arc::new(AtomicBool::new(true));
    let entered = Deferred::<()>::new();
    let gate = Deferred::<()>::new();
    let (b, e, g) = (block.clone(), entered.clone(), gate.clone());
    f.context.set_recovery(move |captured| {
        let (b, e, g, original) = (b.clone(), e.clone(), g.clone(), original.clone());
        async move {
            if b.load(Ordering::SeqCst) {
                e.resolve(());
                let _ = g.wait().await;
            }
            original(captured).await
        }
    });
    let service = f.service.clone();
    let update = merge(&input, json!({"task_id": task_id, "title": "Older edit"}));
    let older = tokio::spawn(async move { service.handle("task.update", update).await });
    let _ = entered.wait().await;
    block.store(false, Ordering::SeqCst);
    f.handle(
        "task.update",
        merge(&input, json!({"task_id": task_id, "title": "Newer edit"})),
    )
    .await
    .unwrap();
    gate.resolve(());
    assert!(older.await.unwrap().is_err());
    assert_eq!(f.peek()["tasks"][0]["title"], "Newer edit");
    f.finish().await;
}

fn proposal_status(snapshot: &Value, id: &Value) -> Option<Value> {
    snapshot["messages"]
        .as_array()
        .into_iter()
        .flatten()
        .flat_map(|m| m["task_proposals"].as_array().into_iter().flatten())
        .find(|p| p["id"] == *id)
        .cloned()
}

#[tokio::test]
async fn committed_cancellation_survives_concurrent_proposals_and_session_changes() {
    for (cleanup_failure, switch_session) in [(false, false), (true, false), (true, true)] {
        let task_id = Arc::new(Mutex::new(String::new()));
        let next = flag();
        let child_started = flag();
        let child_gate = Deferred::<()>::new();
        let input = task_create_input("Monitor", "Observe", 60);
        let (t, n, task) = (task_id.clone(), next.clone(), input.clone());
        let (started, gate) = (child_started.clone(), child_gate.clone());
        let child: ChildDriver = Arc::new(move || {
            let driver = FakeDriver::new();
            driver.set_stop(move || async move {
                if cleanup_failure {
                    return Err(plain_err("Child stop failed"));
                }
                Ok(())
            });
            let (started, gate) = (started.clone(), gate.clone());
            driver.set_run(move |_| {
                started.store(true, Ordering::SeqCst);
                let gate = gate.clone();
                async move {
                    let _ = gate.wait().await;
                    Ok(vec![])
                }
            });
            driver
        });
        let f = setup_with(
            move |d| {
                d.set_run(move |run| {
                    let next = n.load(Ordering::SeqCst);
                    let id = t.lock().unwrap().clone();
                    let task = task.clone();
                    async move {
                        if !next {
                            run.task("cancel", json!({"task_id": id})).await?;
                        } else {
                            run.task("create", task).await?;
                        }
                        Ok(vec![])
                    }
                });
            },
            Setup {
                child: Some(child),
                fake_now: Some("2026-10-04T00:00:00Z"),
                ..Setup::default()
            },
        );
        let label = format!("cleanup_failure {cleanup_failure}, switch_session {switch_session}");
        f.context.stable_task_identity();
        f.handle("configure", configured()).await.unwrap();
        f.handle("task.create", merge(&input, json!({"request_id": uuid()})))
            .await
            .unwrap();
        *task_id.lock().unwrap() = f.peek()["tasks"][0]["id"].as_str().unwrap().to_owned();
        f.service.resume().await.unwrap();
        f.handle("task.run_now", json!({"task_id": *task_id.lock().unwrap()}))
            .await
            .unwrap();
        f.advance(0).await;
        flush_tasks().await;
        assert!(child_started.load(Ordering::SeqCst), "{label}");
        f.handle(
            "send",
            json!({"request_id": uuid(), "text": "Cancel monitor"}),
        )
        .await
        .unwrap();
        flush_tasks().await;
        let proposal_id = last_message(&f.peek())["task_proposals"][0]["id"].clone();
        let service = f.service.clone();
        let confirm = json!({"proposal_id": proposal_id});
        let confirming =
            tokio::spawn(async move { service.handle("task.confirm_proposal", confirm).await });
        flush_tasks().await;
        let receipt = || proposal_status(&f.peek(), &proposal_id);
        assert_eq!(f.peek()["tasks"][0]["status"], "cancelled", "{label}");
        assert_eq!(receipt().unwrap()["status"], "confirmed", "{label}");
        assert_eq!(
            proposal_status(&f.saved(), &proposal_id).unwrap()["status"],
            "confirmed",
            "{label}"
        );
        let original_session = f.peek()["session_id"].clone();
        if switch_session {
            f.handle("new_session", json!({})).await.unwrap();
        }
        next.store(true, Ordering::SeqCst);
        f.handle(
            "send",
            json!({"request_id": uuid(), "text": "Create another monitor"}),
        )
        .await
        .unwrap();
        flush_tasks().await;
        assert_eq!(
            receipt().map(|r| r["status"].clone()),
            if switch_session {
                None
            } else {
                Some(json!("confirmed"))
            },
            "{label}"
        );
        assert_eq!(
            last_message(&f.peek())["task_proposals"][0]["status"],
            "pending",
            "{label}"
        );
        child_gate.resolve(());
        let result = confirming.await.unwrap();
        // Prune the manager's completed receipt before reopening its archive.
        f.handle(
            "send",
            json!({"request_id": uuid(), "text": "Create one more monitor"}),
        )
        .await
        .unwrap();
        flush_tasks().await;
        if switch_session {
            assert!(receipt().is_none(), "{label}");
            f.handle("select_session", json!({"session_id": original_session}))
                .await
                .unwrap();
        }
        assert_eq!(receipt().unwrap()["status"], "confirmed", "{label}");
        if cleanup_failure {
            assert!(result.is_err(), "{label}");
            let detail = receipt().unwrap()["detail"].clone();
            assert!(
                detail
                    .as_str()
                    .is_some_and(|d| d.contains("could not be fully stopped")),
                "{label}: {detail}"
            );
            assert_eq!(
                proposal_status(&f.saved(), &proposal_id).unwrap()["detail"],
                detail,
                "{label}"
            );
        }
        f.finish().await;
    }
}
