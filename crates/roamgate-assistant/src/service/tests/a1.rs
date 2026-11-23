//! Tool details, the approval policy and scheduled task runs
//! (service.test.ts, from "live tool details persist" to "a catalog
//! failure releases a coalesced one-time run").

use roamgate_agents::js;

use super::*;
use crate::wire::is_snapshot;

fn pointer() -> Vec<Value> {
    vec![json!({"type": "ranger-durable", "id": uuid()})]
}

fn iso_in(ms: i64) -> String {
    js::iso((SystemClock.now() + ms) as f64)
}

fn tools_of(message: &Value) -> Vec<Value> {
    message["tools"].as_array().cloned().unwrap_or_default()
}

fn parse(result: &ToolResult) -> Value {
    serde_json::from_str(&result.text).unwrap()
}

async fn wait<T: Clone + Send>(deferred: &Deferred<T>) -> T {
    deferred.wait().await.unwrap()
}

/// A child driver with the default members and this run.
fn child<F, R>(run: F) -> ChildDriver
where
    F: Fn(Input) -> R + Send + Sync + Clone + 'static,
    R: Future<Output = AssistantResult<Vec<Value>>> + Send + 'static,
{
    Arc::new(move || {
        let driver = FakeDriver::new();
        driver.set_run(run.clone());
        driver
    })
}

/// A task over the fixture's workspace.
fn task_input(title: &str, prompt: &str, schedule: Value) -> Value {
    json!({
        "request_id": uuid(),
        "title": title,
        "prompt": prompt,
        "scope": allowed(),
        "schedule": schedule,
    })
}

fn writes_action(writes: &Arc<AtomicUsize>, detail: &'static str) -> PreparedAction {
    let writes = writes.clone();
    permission_action(move || async move {
        bump(&writes);
        Ok(json!({"status": "succeeded", "detail": detail}))
    })
}

fn task_id(snapshot: &Value) -> String {
    snapshot["tasks"][0]["id"].as_str().unwrap().to_owned()
}

#[tokio::test]
async fn live_tool_details_persist_while_repeated_call_ids_explicitly_clear_stale_details() {
    let pointer = pointer();
    let returned = pointer.clone();
    let f = setup_driver(move |d| {
        d.set_run(move |input| {
            let pointer = returned.clone();
            async move {
                input.tool(
                    "failed",
                    "workspace_history",
                    "running",
                    Some(json!({"arguments": "{\n  \"pane_id\": \"pane\"\n}"})),
                );
                input.tool(
                    "failed",
                    "workspace_history",
                    "failed",
                    Some(json!({"output": "Workspace tool unavailable."})),
                );
                input.tool(
                    "reused",
                    "workspace_status",
                    "completed",
                    Some(json!({"arguments": "{}", "output": "Old result"})),
                );
                input.tool(
                    "reused",
                    "workspace_status",
                    "completed",
                    Some(json!({"arguments": null, "output": null})),
                );
                input.message("Done");
                Ok(pointer)
            }
        });
    });
    f.handle("configure", json!({"config": configured()}))
        .await
        .unwrap();
    f.handle("send", json!({"text": "Read tools", "request_id": "tools"}))
        .await
        .unwrap();
    until(|| f.peek()["running"] == false).await;
    let tools = tools_of(&last_message(&f.peek()));
    assert_matches(
        &tools[0],
        json!({
            "status": "failed",
            "arguments": "{\n  \"pane_id\": \"pane\"\n}",
            "output": "Workspace tool unavailable.",
        }),
    );
    assert_eq!(
        tools[1],
        json!({"id": "reused", "name": "workspace_status", "status": "completed"})
    );
    assert_eq!(
        last_message(&f.saved())["tools"],
        Value::Array(tools.clone())
    );
    f.service.dispose().await;
    let restored = f.restart(f.driver.clone());
    assert_eq!(
        tools_of(&last_message(&restored.snapshot().await.unwrap())),
        tools
    );
    f.finish().await;
}

#[tokio::test]
async fn legacy_tool_details_hydrate_current_and_archived_chats_without_rewriting_their_summaries()
{
    let pointer = pointer();
    let runs = counter();
    let reads = counter();
    let (returned, counted) = (pointer.clone(), runs.clone());
    let f = setup_driver(move |d| {
        d.set_run(move |input| {
            let (pointer, runs) = (returned.clone(), counted.clone());
            async move {
                bump(&runs);
                input.tool("legacy", "workspace_status", "completed", None);
                input.message("Done");
                Ok(pointer)
            }
        });
    });
    f.handle("configure", json!({"config": configured()}))
        .await
        .unwrap();
    f.handle(
        "send",
        json!({"text": "Read status", "request_id": "legacy"}),
    )
    .await
    .unwrap();
    until(|| f.peek()["running"] == false).await;
    let session_id = f.peek()["session_id"].as_str().unwrap().to_owned();
    let before = std::fs::read_to_string(f.state_path()).unwrap();
    let seen = list::<Vec<Value>>();
    let (counted, recorded) = (reads.clone(), seen.clone());
    f.driver.set_details(move |entries, messages, _| {
        bump(&counted);
        recorded.lock().unwrap().push(entries);
        let mut result = messages.clone();
        for message in result.as_array_mut().into_iter().flatten() {
            for tool in message["tools"].as_array_mut().into_iter().flatten() {
                tool["arguments"] = json!("{}");
                tool["output"] = json!("Saved status");
            }
        }
        async move { Ok(result) }
    });
    let detailed = f.handle("get", json!({})).await.unwrap();
    assert_matches(
        &tools_of(&last_message(&detailed))[0],
        json!({"arguments": "{}", "output": "Saved status"}),
    );
    assert_eq!(std::fs::read_to_string(f.state_path()).unwrap(), before);
    f.handle("configure", json!({"config": configured()}))
        .await
        .unwrap();
    assert_eq!(
        tools_of(&last_message(&f.peek()))[0]["output"],
        "Saved status"
    );
    assert!(
        tools_of(&last_message(&f.saved()))[0]
            .get("output")
            .is_none()
    );
    f.handle("new_session", json!({})).await.unwrap();
    let archive = f
        .directory
        .join("sessions")
        .join(format!("{session_id}.json"));
    assert!(
        tools_of(&last_message(&read_json(&archive)))[0]
            .get("output")
            .is_none()
    );
    let selected = f
        .handle("select_session", json!({"session_id": session_id}))
        .await
        .unwrap();
    assert_eq!(
        tools_of(&last_message(&selected))[0]["output"],
        "Saved status"
    );
    assert_eq!(count(&reads), 2);
    for entries in seen.lock().unwrap().iter() {
        assert_eq!(*entries, pointer);
    }
    f.service.dispose().await;
    let restored = f.restart(f.driver.clone());
    assert_eq!(
        tools_of(&last_message(&restored.snapshot().await.unwrap()))[0]["arguments"],
        "{}"
    );
    assert_eq!(count(&runs), 1);
    f.finish().await;
}

#[tokio::test]
async fn an_in_flight_history_read_cannot_restore_details_cleared_by_a_live_tool_update() {
    let done = Deferred::<Vec<Value>>::new();
    let reading = Deferred::<()>::new();
    let details = Deferred::<()>::new();
    let input = slot::<Input>();
    let (finished, kept) = (done.clone(), input.clone());
    let (entered, released) = (reading.clone(), details.clone());
    let f = setup_driver(move |d| {
        d.set_run(move |next| {
            *kept.lock().unwrap() = Some(next.clone());
            next.tool("call", "workspace_status", "running", None);
            let done = finished.clone();
            async move { done.wait().await }
        });
        d.set_details(move |_entries, messages, _| {
            entered.resolve(());
            let details = released.clone();
            let mut messages = messages.clone();
            async move {
                details.wait().await.unwrap();
                let last = messages.as_array_mut().unwrap().last_mut().unwrap();
                last["tools"][0]["arguments"] = json!("{\"stale\": true}");
                Ok(messages)
            }
        });
    });
    f.handle("configure", json!({"config": configured()}))
        .await
        .unwrap();
    f.handle("send", json!({"text": "Read status", "request_id": "race"}))
        .await
        .unwrap();
    until(|| input.lock().unwrap().is_some()).await;
    let service = f.service.clone();
    let pending = tokio::spawn(async move { service.snapshot().await });
    wait(&reading).await;
    let live = input.lock().unwrap().clone().unwrap();
    live.tool(
        "call",
        "workspace_status",
        "completed",
        Some(json!({"arguments": null, "output": null})),
    );
    details.resolve(());
    let snapshot = pending.await.unwrap().unwrap();
    assert!(
        tools_of(&last_message(&snapshot))[0]
            .get("arguments")
            .is_none()
    );
    assert!(
        tools_of(&last_message(&f.peek()))[0]
            .get("arguments")
            .is_none()
    );
    done.resolve(vec![]);
    until(|| f.peek()["running"] == false).await;
    f.finish().await;
}

#[tokio::test]
async fn legacy_task_run_details_read_the_childs_saved_durable_pointer_without_rerunning_it() {
    let pointer = pointer();
    let runs = counter();
    let (returned, counted) = (pointer.clone(), runs.clone());
    let f = setup_with(
        |_| {},
        Setup {
            child: Some(child(move |input: Input| {
                let (pointer, runs) = (returned.clone(), counted.clone());
                async move {
                    bump(&runs);
                    input.tool("child-call", "workspace_status", "completed", None);
                    input.message("Saved task status");
                    Ok(pointer)
                }
            })),
            ..Setup::default()
        },
    );
    f.use_fake_timers(None);
    f.context.stable_task_identity();
    f.handle("configure", json!({"config": configured()}))
        .await
        .unwrap();
    let created = f
        .handle(
            "task.create",
            task_input(
                "Read status",
                "Read status",
                json!({"type": "interval", "minutes": 1}),
            ),
        )
        .await
        .unwrap();
    let task = task_id(&created);
    f.service.resume().await.unwrap();
    f.handle("task.run_now", json!({"task_id": task}))
        .await
        .unwrap();
    f.advance(0).await;
    flush_tasks().await;
    let run_id = f
        .service
        .task_detail(json!({"task_id": task}))
        .await
        .unwrap()["runs"][0]["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let source = f
        .directory
        .join("tasks")
        .join(&task)
        .join("runs")
        .join(&run_id);
    let state_path = source.join("state.json");
    let before = std::fs::read_to_string(&state_path).unwrap();
    let seen = list::<(Vec<Value>, Option<PathBuf>)>();
    let recorded = seen.clone();
    f.driver.set_details(move |entries, messages, directory| {
        recorded.lock().unwrap().push((entries, directory));
        let mut result = messages.clone();
        let last = result.as_array_mut().unwrap().last_mut().unwrap();
        last["tools"][0]["arguments"] = json!("{}");
        last["tools"][0]["output"] = json!("Saved task status");
        async move { Ok(result) }
    });
    let detailed = f
        .service
        .task_detail(json!({"task_id": task, "run_id": run_id}))
        .await
        .unwrap();
    assert_matches(
        &tools_of(&last_message(&detailed["run"]))[0],
        json!({"arguments": "{}", "output": "Saved task status"}),
    );
    assert_eq!(
        *seen.lock().unwrap(),
        vec![(pointer.clone(), Some(source.clone()))]
    );
    assert_eq!(std::fs::read_to_string(&state_path).unwrap(), before);
    assert_eq!(count(&runs), 1);
    f.finish().await;
}

// ------------------------------------------------------------ approval policy

#[tokio::test]
async fn auto_actions_and_schedules_return_real_receipts_and_retain_durable_admission() {
    let pointer = pointer();
    let writes = counter();
    let receipts = list::<Value>();
    let modes = list::<Value>();
    let (returned, recorded, seen) = (pointer.clone(), receipts.clone(), modes.clone());
    let f = setup_driver(move |d| {
        d.set_run(move |input| {
            let (pointer, receipts, modes) = (returned.clone(), recorded.clone(), seen.clone());
            async move {
                modes
                    .lock()
                    .unwrap()
                    .push(input.config()["approval_mode"].clone());
                input.checkpoint(pointer.clone()).await?;
                let receipt = input.propose("create_tab", allowed()[0].clone()).await?;
                receipts.lock().unwrap().push(parse(&receipt));
                let receipt = input
                    .task(
                        "create",
                        json!({
                            "title": "Read later",
                            "prompt": "Read verified status",
                            "scope": allowed(),
                            "schedule": {"type": "once", "at": iso_in(3_600_000)},
                        }),
                    )
                    .await?;
                receipts.lock().unwrap().push(parse(&receipt));
                input.message("Verified tab and schedule created.");
                Ok(pointer)
            }
        });
    });
    f.context.stable_task_identity();
    let saved_during = list::<Value>();
    let (counted, path, recorded) = (writes.clone(), f.state_path(), saved_during.clone());
    f.context.set_prepare(move |_, _, _| {
        let (writes, path, saved) = (counted.clone(), path.clone(), recorded.clone());
        async move {
            Ok(permission_action(move || async move {
                bump(&writes);
                saved.lock().unwrap().push(read_json(&path));
                Ok(json!({"status": "succeeded", "detail": "Verified new pane p2"}))
            }))
        }
    });
    f.handle("configure", json!({"config": configured()}))
        .await
        .unwrap();
    assert!(f.peek()["config"].get("approval_mode").is_none());
    f.handle("configure_approval", json!({"approval_mode": "auto"}))
        .await
        .unwrap();
    f.handle(
        "send",
        json!({"request_id": "automatic", "text": "Create a tab and schedule"}),
    )
    .await
    .unwrap();
    until(|| f.peek()["running"] == false).await;
    assert_eq!(*modes.lock().unwrap(), vec![json!("auto")]);
    assert_eq!(count(&writes), 1);
    let saved = saved_during.lock().unwrap()[0].clone();
    assert_eq!(last_message(&saved)["actions"][0]["status"], "executing");
    assert_eq!(saved["entries"], Value::Array(pointer.clone()));
    assert_eq!(saved["active_run"]["request_id"], "automatic");
    let receipts = receipts.lock().unwrap().clone();
    assert_matches(
        &receipts[0],
        json!({"status": "succeeded", "detail": "Verified new pane p2"}),
    );
    assert_matches(&receipts[1], json!({"status": "confirmed"}));
    assert_eq!(f.peek()["tasks"][0]["approval_mode"], "auto");
    assert!(
        last_message(&f.peek())["text"]
            .as_str()
            .unwrap()
            .contains("Verified")
    );
    assert!(is_snapshot(&f.peek()));
    f.finish().await;
}

#[tokio::test]
async fn revoking_during_action_preparation_leaves_a_pending_receipt_and_blocks_later_effects() {
    let preparing = Deferred::<()>::new();
    let release = Deferred::<()>::new();
    let writes = counter();
    let receipt = slot::<String>();
    let kept = receipt.clone();
    let f = setup_driver(move |d| {
        d.set_run(move |input| {
            let receipt = kept.clone();
            async move {
                let result = input.propose("create_tab", allowed()[0].clone()).await?;
                *receipt.lock().unwrap() = Some(result.text);
                Ok(vec![])
            }
        });
    });
    let (entered, released, counted) = (preparing.clone(), release.clone(), writes.clone());
    f.context.set_prepare(move |_, _, _| {
        let (entered, released, writes) = (entered.clone(), released.clone(), counted.clone());
        async move {
            entered.resolve(());
            released.wait().await.unwrap();
            Ok(writes_action(&writes, "Created"))
        }
    });
    f.handle("configure", json!({"config": configured()}))
        .await
        .unwrap();
    f.handle("configure_approval", json!({"approval_mode": "auto"}))
        .await
        .unwrap();
    f.handle("send", json!({"request_id": "revoke", "text": "Create"}))
        .await
        .unwrap();
    wait(&preparing).await;
    assert_err(
        f.handle("configure_approval", json!({"approval_mode": "auto"}))
            .await,
        "busy",
    );
    f.handle("configure_approval", json!({"approval_mode": "manual"}))
        .await
        .unwrap();
    release.resolve(());
    until(|| f.peek()["running"] == false).await;
    let text = receipt.lock().unwrap().clone().unwrap();
    assert_eq!(
        serde_json::from_str::<Value>(&text).unwrap()["status"],
        "pending"
    );
    assert_eq!(count(&writes), 0);
    f.finish().await;
}

// Preparation, proposal creation, and automatic confirmation revalidate.
#[tokio::test]
async fn revoking_during_task_validation_keeps_manual_confirmation_manual_after_re_enabling_auto() {
    for validation in [1usize, 2, 3] {
        let entered = Deferred::<()>::new();
        let release = Deferred::<()>::new();
        let child_finished = Deferred::<()>::new();
        let preparing = flag();
        let checks = counter();
        let writes = counter();
        let receipt = slot::<String>();
        let child_modes = list::<Value>();
        let (gate, released, prep, checked) = (
            entered.clone(),
            release.clone(),
            preparing.clone(),
            checks.clone(),
        );
        let (started, kept) = (preparing.clone(), receipt.clone());
        let (finished, modes) = (child_finished.clone(), child_modes.clone());
        let f = setup_with(
            move |d| {
                d.set_catalog(move |_| {
                    let (gate, released) = (gate.clone(), released.clone());
                    let blocked = prep.load(Ordering::SeqCst) && bump(&checked) == validation;
                    async move {
                        if blocked {
                            gate.resolve(());
                            released.wait().await.unwrap();
                        }
                        Ok(catalog())
                    }
                });
                d.set_run(move |input| {
                    let (started, receipt) = (started.clone(), kept.clone());
                    async move {
                        started.store(true, Ordering::SeqCst);
                        let result = input
                            .task(
                                "create",
                                json!({
                                    "title": "Create later",
                                    "prompt": "Create a tab",
                                    "scope": allowed(),
                                    "schedule": {"type": "once", "at": iso_in(3_600_000)},
                                }),
                            )
                            .await?;
                        *receipt.lock().unwrap() = Some(result.text);
                        Ok(vec![])
                    }
                });
            },
            Setup {
                child: Some(child(move |input: Input| {
                    let (finished, modes) = (finished.clone(), modes.clone());
                    async move {
                        modes
                            .lock()
                            .unwrap()
                            .push(input.config()["approval_mode"].clone());
                        input.propose("create_tab", allowed()[0].clone()).await?;
                        finished.resolve(());
                        Ok(vec![])
                    }
                })),
                ..Setup::default()
            },
        );
        f.context.stable_task_identity();
        let counted = writes.clone();
        f.context.set_prepare(move |_, _, _| {
            let writes = counted.clone();
            async move { Ok(writes_action(&writes, "Created")) }
        });
        f.handle("configure", json!({"config": configured()}))
            .await
            .unwrap();
        f.handle("configure_approval", json!({"approval_mode": "auto"}))
            .await
            .unwrap();
        f.handle(
            "send",
            json!({"request_id": "revoke-task", "text": "Schedule a tab"}),
        )
        .await
        .unwrap();
        wait(&entered).await;
        f.handle("configure_approval", json!({"approval_mode": "manual"}))
            .await
            .unwrap();
        release.resolve(());
        until(|| f.peek()["running"] == false).await;
        let proposal: Value =
            serde_json::from_str(&receipt.lock().unwrap().clone().unwrap()).unwrap();
        assert_eq!(proposal["status"], "pending", "validation {validation}");
        f.handle(
            "task.confirm_proposal",
            json!({"proposal_id": proposal["id"]}),
        )
        .await
        .unwrap();
        let task = f.peek()["tasks"][0].clone();
        assert_eq!(task["approval_mode"], "manual", "validation {validation}");
        f.handle("configure_approval", json!({"approval_mode": "auto"}))
            .await
            .unwrap();
        f.use_fake_timers(None);
        f.service.resume().await.unwrap();
        f.handle("task.run_now", json!({"task_id": task["id"]}))
            .await
            .unwrap();
        f.advance(0).await;
        wait(&child_finished).await;
        assert_eq!(*child_modes.lock().unwrap(), vec![json!("manual")]);
        assert_eq!(count(&writes), 0, "validation {validation}");
        f.finish().await;
    }
}

#[tokio::test]
async fn failed_revocation_preserves_live_action_and_streamed_message_references() {
    let executing = Deferred::<()>::new();
    let release = Deferred::<()>::new();
    let f = setup_driver(|d| {
        d.set_run(|input| async move {
            input.delta("Before ");
            input.propose("create_tab", allowed()[0].clone()).await?;
            input.delta("after");
            Ok(vec![])
        });
    });
    let (entered, released) = (executing.clone(), release.clone());
    f.context.set_prepare(move |_, _, _| {
        let (entered, released) = (entered.clone(), released.clone());
        async move {
            Ok(permission_action(move || async move {
                entered.resolve(());
                released.wait().await.unwrap();
                Ok(json!({"status": "succeeded", "detail": "Verified"}))
            }))
        }
    });
    f.handle("configure", json!({"config": configured()}))
        .await
        .unwrap();
    f.handle("configure_approval", json!({"approval_mode": "auto"}))
        .await
        .unwrap();
    f.handle(
        "send",
        json!({"request_id": "failed-revoke", "text": "Create"}),
    )
    .await
    .unwrap();
    wait(&executing).await;
    let path = f.state_path();
    let backup = f.directory.join("state.json.backup");
    std::fs::rename(&path, &backup).unwrap();
    std::fs::create_dir(&path).unwrap();
    assert_err(
        f.handle("configure_approval", json!({"approval_mode": "manual"}))
            .await,
        "could not be saved",
    );
    assert_eq!(f.peek()["config"]["approval_mode"], "auto");
    std::fs::remove_dir_all(&path).unwrap();
    std::fs::rename(&backup, &path).unwrap();
    release.resolve(());
    until(|| f.peek()["running"] == false).await;
    let last = last_message(&f.peek());
    assert_eq!(last["actions"][0]["status"], "succeeded");
    assert_eq!(last["text"], "Before after");
    assert_eq!(
        last_message(&f.saved())["actions"][0]["status"],
        "succeeded"
    );
    f.finish().await;
}

#[tokio::test]
async fn stop_retains_an_outstanding_automatic_effect_until_its_receipt_settles() {
    let executing = Deferred::<()>::new();
    let release = Deferred::<()>::new();
    let f = setup_driver(|d| {
        d.set_run(|input| async move {
            let effect = tokio::spawn(input.propose("create_tab", allowed()[0].clone()));
            tokio::select! {
                _ = effect => {}
                _ = input.signal.cancelled() => {}
            }
            Ok(vec![])
        });
    });
    let (entered, released) = (executing.clone(), release.clone());
    f.context.set_prepare(move |_, _, _| {
        let (entered, released) = (entered.clone(), released.clone());
        async move {
            Ok(permission_action(move || async move {
                entered.resolve(());
                released.wait().await.unwrap();
                Ok(json!({"status": "succeeded", "detail": "Created before Stop"}))
            }))
        }
    });
    f.handle("configure", json!({"config": configured()}))
        .await
        .unwrap();
    f.handle("configure_approval", json!({"approval_mode": "auto"}))
        .await
        .unwrap();
    f.handle("send", json!({"request_id": "stop-auto", "text": "Create"}))
        .await
        .unwrap();
    wait(&executing).await;
    f.handle("stop", json!({})).await.unwrap();
    assert_eq!(f.peek()["running"], false);
    assert_eq!(last_message(&f.peek())["actions"][0]["status"], "executing");
    assert_err(f.handle("new_session", json!({})).await, "busy");
    assert_err(
        f.handle("configure", json!({"config": configured()})).await,
        "busy",
    );
    release.resolve(());
    until(|| last_message(&f.peek())["actions"][0]["status"] == "succeeded").await;
    assert_eq!(
        last_message(&f.saved())["actions"][0]["status"],
        "succeeded"
    );
    f.handle("new_session", json!({})).await.unwrap();
    f.finish().await;
}

#[tokio::test]
async fn a_delayed_connection_save_preserves_the_latest_permission_mode() {
    let entered = Deferred::<()>::new();
    let release = Deferred::<()>::new();
    let f = setup();
    f.handle("configure", json!({"config": configured()}))
        .await
        .unwrap();
    f.handle("configure_approval", json!({"approval_mode": "auto"}))
        .await
        .unwrap();
    let (gate, released) = (entered.clone(), release.clone());
    f.driver.set_catalog(move |_| {
        let (gate, released) = (gate.clone(), released.clone());
        async move {
            gate.resolve(());
            released.wait().await.unwrap();
            Ok(catalog())
        }
    });
    let service = f.service.clone();
    let saving = tokio::spawn(async move {
        service
            .handle(
                "configure",
                json!({"config": merge(&configured(), json!({"approval_mode": "auto"}))}),
            )
            .await
    });
    wait(&entered).await;
    f.handle("configure_approval", json!({"approval_mode": "manual"}))
        .await
        .unwrap();
    release.resolve(());
    saving.await.unwrap().unwrap();
    assert_eq!(f.peek()["config"]["approval_mode"], "manual");
    f.handle(
        "configure",
        json!({"config": merge(&configured(), json!({"approval_mode": "auto"}))}),
    )
    .await
    .unwrap();
    assert_eq!(f.peek()["config"]["approval_mode"], "manual");
    f.finish().await;
}

#[tokio::test]
async fn scheduled_tasks_require_both_their_saved_auto_policy_and_current_global_permission() {
    let policies = list::<Value>();
    let third_turn = Deferred::<()>::new();
    let release_third = Deferred::<()>::new();
    let writes = counter();
    let (recorded, third, released) = (policies.clone(), third_turn.clone(), release_third.clone());
    let f = setup_with(
        |_| {},
        Setup {
            fake_now: Some("2026-10-05T00:00:00Z"),
            child: Some(child(move |input: Input| {
                let (policies, third, released) =
                    (recorded.clone(), third.clone(), released.clone());
                async move {
                    let count = {
                        let mut policies = policies.lock().unwrap();
                        policies.push(input.config()["approval_mode"].clone());
                        policies.len()
                    };
                    if count == 3 {
                        third.resolve(());
                        released.wait().await.unwrap();
                    }
                    input.propose("create_tab", allowed()[0].clone()).await?;
                    Ok(vec![])
                }
            })),
            ..Setup::default()
        },
    );
    f.context.stable_task_identity();
    let counted = writes.clone();
    f.context.set_prepare(move |_, _, _| {
        let writes = counted.clone();
        async move { Ok(writes_action(&writes, "Created")) }
    });
    f.handle("configure", json!({"config": configured()}))
        .await
        .unwrap();
    async fn create(f: &Fixture, title: &str) -> String {
        f.handle(
            "task.create",
            task_input(
                title,
                "Create tab",
                json!({"type": "interval", "minutes": 60}),
            ),
        )
        .await
        .unwrap();
        f.peek()["tasks"]
            .as_array()
            .unwrap()
            .iter()
            .find(|task| task["title"] == title)
            .unwrap()["id"]
            .as_str()
            .unwrap()
            .to_owned()
    }
    async fn run(f: &Fixture, id: &str) {
        f.handle("task.run_now", json!({"task_id": id}))
            .await
            .unwrap();
        f.advance(0).await;
        flush_tasks().await;
    }
    let task_of = |id: &str| {
        f.peek()["tasks"]
            .as_array()
            .unwrap()
            .iter()
            .find(|task| task["id"] == id)
            .cloned()
            .unwrap()
    };
    let old_manual = create(&f, "Old manual").await;
    f.handle("configure_approval", json!({"approval_mode": "auto"}))
        .await
        .unwrap();
    let saved_auto = create(&f, "Saved auto").await;
    assert_eq!(task_of(&saved_auto)["approval_mode"], "auto");
    f.service.resume().await.unwrap();
    run(&f, &old_manual).await;
    assert_eq!(count(&writes), 0);
    let run_id = task_of(&old_manual)["current_run"]["id"].clone();
    let waiting = f
        .service
        .task_detail(json!({"task_id": old_manual, "run_id": run_id}))
        .await
        .unwrap();
    assert_eq!(waiting["task"]["current_run"]["status"], "waiting");
    f.handle(
        "task.action.cancel",
        json!({
            "task_id": old_manual,
            "run_id": waiting["task"]["current_run"]["id"],
            "action_id": last_message(&waiting["run"])["actions"][0]["id"],
        }),
    )
    .await
    .unwrap();
    flush_tasks().await;
    run(&f, &saved_auto).await;
    assert_eq!(count(&writes), 1);
    f.handle("configure_approval", json!({"approval_mode": "manual"}))
        .await
        .unwrap();
    run(&f, &saved_auto).await;
    wait(&third_turn).await;
    f.handle("configure_approval", json!({"approval_mode": "auto"}))
        .await
        .unwrap();
    release_third.resolve(());
    flush_tasks().await;
    assert_eq!(count(&writes), 1);
    assert_eq!(
        *policies.lock().unwrap(),
        vec![json!("manual"), json!("auto"), json!("manual")]
    );
    f.finish().await;
}

// ------------------------------------------------------------ scheduled tasks

#[tokio::test]
async fn editing_a_completed_one_time_task_cannot_repeat_its_auto_approved_workspace_write() {
    let writes = counter();
    let starts = list::<String>();
    let recorded = starts.clone();
    let f = setup_with(
        |_| {},
        Setup {
            fake_now: Some("2026-10-04T00:00:00Z"),
            child: Some(child(move |input: Input| {
                let starts = recorded.clone();
                async move {
                    starts.lock().unwrap().push(input.request_id());
                    input.propose("create_tab", allowed()[0].clone()).await?;
                    Ok(vec![])
                }
            })),
            ..Setup::default()
        },
    );
    f.context.stable_task_identity();
    let counted = writes.clone();
    f.context.set_prepare(move |_, _, _| {
        let writes = counted.clone();
        async move { Ok(writes_action(&writes, "Created")) }
    });
    f.handle("configure", json!({"config": configured()}))
        .await
        .unwrap();
    f.handle("configure_approval", json!({"approval_mode": "auto"}))
        .await
        .unwrap();
    let input = json!({
        "title": "Create tab once",
        "prompt": "Create a tab",
        "scope": allowed(),
        "schedule": {"type": "once", "at": "2026-10-04T00:01:00.000Z"},
    });
    let created = f
        .handle("task.create", merge(&input, json!({"request_id": uuid()})))
        .await
        .unwrap();
    let task = task_id(&created);
    f.service.resume().await.unwrap();
    f.advance(60_000).await;
    flush_tasks().await;
    assert_eq!(count(&writes), 1);
    assert_eq!(f.peek()["tasks"][0]["next_run_at"], Value::Null);
    assert_eq!(
        f.service
            .task_detail(json!({"task_id": task}))
            .await
            .unwrap()["runs"][0]["status"],
        "succeeded"
    );
    for edit in [
        json!({"title": "Renamed completed task"}),
        json!({"prompt": "Edited instructions"}),
        json!({"notification_mode": "agent"}),
        json!({"schedule": {"at": "2026-10-04T00:01:00Z", "type": "once"}}),
    ] {
        let params = merge(&merge(&input, edit), json!({"task_id": task}));
        f.handle("task.update", params).await.unwrap();
        f.advance(0).await;
        flush_tasks().await;
        assert_eq!(f.peek()["tasks"][0]["next_run_at"], Value::Null);
        assert_eq!(count(&writes), 1);
    }
    f.service.resume().await.unwrap();
    f.advance(600_000).await;
    flush_tasks().await;
    assert_eq!(starts.lock().unwrap().len(), 1);
    assert_eq!(
        f.service
            .task_detail(json!({"task_id": task}))
            .await
            .unwrap()["runs"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    f.finish().await;
}

#[tokio::test]
async fn a_catalog_failure_releases_a_coalesced_one_time_run_with_a_workspace() {
    for safety in ["ready", "revoked permission", "replaced identity"] {
        let admission = Deferred::<()>::new();
        let starts = counter();
        let counted = starts.clone();
        let f = setup_with(
            |_| {},
            Setup {
                fake_now: Some("2026-10-04T00:00:00Z"),
                child: Some(child(move |_input: Input| {
                    let starts = counted.clone();
                    async move {
                        bump(&starts);
                        Ok(vec![])
                    }
                })),
                ..Setup::default()
            },
        );
        f.context.stable_task_identity();
        f.handle("configure", configured()).await.unwrap();
        let created = f
            .handle(
                "task.create",
                task_input(
                    "Check once",
                    "Check status",
                    json!({"type": "once", "at": "2026-10-04T00:01:00.000Z"}),
                ),
            )
            .await
            .unwrap();
        let task = task_id(&created);
        f.service.resume().await.unwrap();
        f.handle("task.run_now", json!({"task_id": task}))
            .await
            .unwrap();
        let catalog_checks = counter();
        let (checks, gate) = (catalog_checks.clone(), admission.clone());
        f.driver.set_catalog(move |_| {
            let first = bump(&checks) == 1;
            let gate = gate.clone();
            async move {
                if first {
                    gate.wait().await?;
                }
                Ok(catalog())
            }
        });
        f.advance(0).await;
        flush_tasks().await;
        assert_eq!(count(&catalog_checks), 1, "{safety}");
        assert_eq!(count(&starts), 0, "{safety}");
        f.advance(60_000).await;
        flush_tasks().await;
        f.advance(0).await;
        flush_tasks().await;
        assert_eq!(f.peek()["tasks"][0]["next_run_at"], Value::Null, "{safety}");
        if safety == "revoked permission" {
            f.handle(
                "configure",
                merge(&configured(), json!({"allowed_workspaces": []})),
            )
            .await
            .unwrap();
        }
        if safety == "replaced identity" {
            f.context
                .set_restore(|_| async { Err(plain_err("Workspace identity changed")) });
        }
        admission.reject(plain_err("Transient provider catalog failure"));
        flush_tasks().await;
        f.advance(0).await;
        flush_tasks().await;
        let detail = f
            .service
            .task_detail(json!({"task_id": task}))
            .await
            .unwrap();
        let runs = detail["runs"].as_array().unwrap();
        assert_eq!(runs.len(), 2, "{safety}");
        assert_eq!(runs[1]["status"], "failed", "{safety}");
        assert_matches(
            &runs[0],
            json!({
                "scheduled_at": "2026-10-04T00:01:00.000Z",
                "status": if safety == "ready" { "succeeded" } else { "failed" },
            }),
        );
        assert_eq!(
            count(&starts),
            if safety == "ready" { 1 } else { 0 },
            "{safety}"
        );
        let checks = count(&catalog_checks);
        f.advance(600_000).await;
        flush_tasks().await;
        assert_eq!(count(&catalog_checks), checks, "{safety}");
        assert_eq!(
            count(&starts),
            if safety == "ready" { 1 } else { 0 },
            "{safety}"
        );
        f.finish().await;
    }
}
