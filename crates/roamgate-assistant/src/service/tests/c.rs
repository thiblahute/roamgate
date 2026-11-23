//! Quick chat selection, workspace inventory reconciliation and the High
//! workspace permission.

use tokio::task::JoinHandle;

use super::*;

type Listed = Arc<Mutex<Vec<Value>>>;

fn thinking_catalog() -> Value {
    merge(
        &catalog(),
        json!({"models": [
            {
                "provider": "test", "id": "model", "label": "Model",
                "thinking_levels": ["off", "low", "high"], "default_thinking_level": "off",
            },
            {
                "provider": "test", "id": "fast", "label": "Fast",
                "thinking_levels": ["off"], "default_thinking_level": "off",
            },
        ]}),
    )
}

/// `thinkingDriver()`.
fn thinking(d: &FakeDriver) {
    d.set_catalog(|_| async { Ok(thinking_catalog()) });
}

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

fn spawn_handle(
    f: &Fixture,
    method: &'static str,
    params: Value,
) -> JoinHandle<AssistantResult<Value>> {
    let service = f.service.clone();
    tokio::spawn(async move { service.handle(method, params).await })
}

fn spawn_catalog(f: &Fixture) -> JoinHandle<AssistantResult<Value>> {
    let service = f.service.clone();
    tokio::spawn(async move { service.workspace_catalog().await })
}

fn inputs() -> Arc<Mutex<Vec<Input>>> {
    list::<Input>()
}

fn input_at(inputs: &Arc<Mutex<Vec<Input>>>, index: usize) -> Input {
    inputs.lock().unwrap()[index].clone()
}

fn scope_ids(scope: &Value) -> Vec<String> {
    scope
        .as_array()
        .into_iter()
        .flatten()
        .map(|r| r["workspace_id"].as_str().unwrap().to_owned())
        .collect()
}

fn last_read_ids(f: &Fixture) -> Vec<String> {
    scope_ids(&f.context.reads().last().unwrap().0)
}

/// The workspace with the scope given as is (`{...workspace, ...ref}`).
fn capture_as_given(f: &Fixture) {
    f.context.set_capture(|scope| async move {
        Ok(Value::Array(
            scope
                .as_array()
                .into_iter()
                .flatten()
                .map(|r| merge(&workspace(), r.clone()))
                .collect(),
        ))
    });
}

fn complete(workspaces: Value) -> Value {
    json!({
        "workspaces": workspaces,
        "errors": [],
        "connection_ids": ["local"],
        "complete_connection_ids": ["local"],
        "truncated": false,
    })
}

// ------------------------------------------------------------ quick selection

#[tokio::test]
async fn persists_effort_across_restart_without_changing_scope_or_approval_and_clears_unsupported_effort_on_an_explicit_default_switch()
 {
    let f = setup_driver(thinking);
    f.handle("configure", configured()).await.unwrap();
    f.handle("configure_approval", json!({"approval_mode": "auto"}))
        .await
        .unwrap();
    let selected = f
        .handle(
            "configure_chat",
            json!({
                "provider": "test", "model": "model", "thinking_level": "high",
                "expected": chat_selection(&f.peek()),
            }),
        )
        .await
        .unwrap();
    assert_eq!(selected["chat_selection"], true);
    assert_eq!(
        selected["config"],
        merge(
            &configured(),
            json!({"approval_mode": "auto", "thinking_level": "high"})
        )
    );
    assert_eq!(f.saved()["config"], selected["config"]);
    f.service.dispose().await;
    let restarted = f.restart(f.driver.clone());
    assert_eq!(restarted.peek()["config"], selected["config"]);
    assert_ne!(restarted.peek()["instance_id"], selected["instance_id"]);
    assert_err(
        restarted
            .handle(
                "configure_chat",
                json!({
                    "provider": "test", "model": "fast", "thinking_level": null,
                    "expected": chat_selection(&selected),
                }),
            )
            .await,
        "changed",
    );
    let reset = restarted
        .handle(
            "configure_chat",
            json!({
                "provider": "test", "model": "fast", "thinking_level": null,
                "expected": chat_selection(&restarted.peek()),
            }),
        )
        .await
        .unwrap();
    assert_eq!(
        reset["config"],
        merge(
            &configured(),
            json!({"model": "fast", "approval_mode": "auto"})
        )
    );
    f.finish().await;
}

#[tokio::test]
async fn rejects_unsupported_malformed_stale_and_scope_widening_selections_without_altering_state()
{
    let f = setup_driver(thinking);
    f.handle("configure", configured()).await.unwrap();
    let before = f.peek();
    let expected = chat_selection(&before);
    let selection = json!({
        "provider": "test", "model": "model", "thinking_level": "high",
        "expected": expected,
    });
    let changes: Vec<(&str, Option<Value>)> = vec![
        ("thinking_level", Some(json!("max"))),
        ("thinking_level", Some(json!("ultra"))),
        ("thinking_level", None),
        ("model", Some(json!("fast"))),
        ("provider", Some(json!("missing"))),
        ("model", Some(json!("missing"))),
        (
            "expected",
            Some(merge(&expected, json!({"model": "other"}))),
        ),
        ("expected", Some(Value::Null)),
        (
            "expected",
            Some(merge(&expected, json!({"thinking_level": "low"}))),
        ),
        (
            "expected",
            Some(merge(&expected, json!({"credential_source": "pi"}))),
        ),
        ("allowed_workspaces", Some(json!([]))),
        ("approval_mode", Some(json!("auto"))),
        ("credential_source", Some(json!("pi"))),
    ];
    for (key, value) in changes {
        let mut params = selection.clone();
        match value {
            Some(value) => params[key] = value,
            None => {
                params.as_object_mut().unwrap().shift_remove(key);
            }
        }
        assert!(f.handle("configure_chat", params).await.is_err(), "{key}");
        assert_eq!(f.peek()["config"], before["config"]);
    }
    assert!(
        f.handle(
            "configure",
            merge(&configured(), json!({"thinking_level": "max"}))
        )
        .await
        .is_err()
    );
    assert_eq!(f.peek()["config"], before["config"]);
    f.finish().await;
}

#[tokio::test]
async fn serializes_selection_saves_with_sends_and_preserves_a_concurrent_permission_revocation() {
    let f = setup_driver(thinking);
    f.handle("configure", configured()).await.unwrap();
    f.handle("configure_approval", json!({"approval_mode": "auto"}))
        .await
        .unwrap();
    let previous = chat_selection(&f.peek());
    let release = Deferred::<()>::new();
    let load = f.driver.catalog.lock().unwrap().clone();
    let gate = release.clone();
    f.driver.set_catalog(move |source| {
        let (load, gate) = (load.clone(), gate.clone());
        async move {
            gate.wait().await?;
            load(source).await
        }
    });
    let saving = spawn_handle(
        &f,
        "configure_chat",
        json!({"provider": "test", "model": "model", "thinking_level": "high", "expected": previous}),
    );
    flush_tasks().await;
    assert_err(
        f.handle(
            "send",
            json!({"text": "Hello", "request_id": "racing-send", "expected": previous}),
        )
        .await,
        "busy",
    );
    assert_err(
        f.handle(
            "configure_chat",
            json!({"provider": "test", "model": "fast", "thinking_level": null, "expected": previous}),
        )
        .await,
        "busy",
    );
    f.handle("configure_approval", json!({"approval_mode": "manual"}))
        .await
        .unwrap();
    release.resolve(());
    saving.await.unwrap().unwrap();
    assert_eq!(f.peek()["config"]["approval_mode"], "manual");
    assert_eq!(f.peek()["config"]["thinking_level"], "high");
    assert_err(
        f.handle(
            "send",
            json!({"text": "Hello", "request_id": "racing-send", "expected": previous}),
        )
        .await,
        "changed",
    );
    assert_eq!(f.peek()["messages"], json!([]));
    f.handle(
        "send",
        json!({"text": "Hello", "request_id": "racing-send", "expected": chat_selection(&f.peek())}),
    )
    .await
    .unwrap();
    until(|| f.peek()["running"] == false).await;
    assert_eq!(f.peek()["messages"].as_array().unwrap().len(), 2);
    f.finish().await;
}

#[tokio::test]
async fn reserved_and_streaming_turns_retain_their_model_and_effort_while_quick_changes_apply_to_the_next_turn()
 {
    let admitted = list::<Value>();
    let release_turn = Deferred::<()>::new();
    let (seen, turn) = (admitted.clone(), release_turn.clone());
    let disposed = release_turn.clone();
    let f = setup_driver(move |d| {
        thinking(d);
        d.set_run(move |input| {
            let (seen, turn) = (seen.clone(), turn.clone());
            async move {
                let count = {
                    let mut seen = seen.lock().unwrap();
                    seen.push(input.config().clone());
                    seen.len()
                };
                if count == 1 {
                    turn.wait().await?;
                }
                input.message("Done");
                Ok(vec![])
            }
        });
        d.set_dispose(move || {
            disposed.resolve(());
            async { Ok(()) }
        });
    });
    f.handle(
        "configure",
        merge(&configured(), json!({"thinking_level": "high"})),
    )
    .await
    .unwrap();
    let release_scope = Deferred::<()>::new();
    let capture = f.context.capture_fn();
    let gate = release_scope.clone();
    f.context.set_capture(move |refs| {
        let (capture, gate) = (capture.clone(), gate.clone());
        async move {
            gate.wait().await?;
            capture(refs).await
        }
    });
    let sending = spawn_handle(
        &f,
        "send",
        json!({"text": "Hello", "request_id": "reserved", "expected": chat_selection(&f.peek())}),
    );
    flush_tasks().await;
    let next = f
        .handle(
            "configure_chat",
            json!({
                "provider": "test", "model": "fast", "thinking_level": null,
                "expected": chat_selection(&f.peek()),
            }),
        )
        .await
        .unwrap();
    assert_eq!(next["running"], true);
    release_scope.resolve(());
    sending.await.unwrap().unwrap();
    assert_matches(
        &admitted.lock().unwrap()[0],
        json!({"model": "model", "thinking_level": "high"}),
    );
    assert_matches(
        &f.saved()["active_run"]["config"],
        json!({"model": "model", "thinking_level": "high"}),
    );
    f.handle(
        "configure_chat",
        json!({
            "provider": "test", "model": "model", "thinking_level": "low",
            "expected": chat_selection(&f.peek()),
        }),
    )
    .await
    .unwrap();
    assert_matches(
        &admitted.lock().unwrap()[0],
        json!({"model": "model", "thinking_level": "high"}),
    );
    release_turn.resolve(());
    until(|| f.peek()["running"] == false).await;
    f.handle(
        "send",
        json!({"text": "Next", "request_id": "next", "expected": chat_selection(&f.peek())}),
    )
    .await
    .unwrap();
    until(|| f.peek()["running"] == false).await;
    assert_matches(
        &admitted.lock().unwrap()[1],
        json!({"model": "model", "thinking_level": "low"}),
    );
    f.finish().await;
}

#[tokio::test]
async fn failed_catalog_and_persistence_writes_preserve_the_old_selection_and_release_the_save_lock()
 {
    let f = setup_driver(thinking);
    f.handle("configure", configured()).await.unwrap();
    let before = f.peek()["config"].clone();
    let select = || {
        f.handle(
            "configure_chat",
            json!({
                "provider": "test", "model": "model", "thinking_level": "high",
                "expected": chat_selection(&f.peek()),
            }),
        )
    };
    let load = f.driver.catalog.lock().unwrap().clone();
    f.driver
        .set_catalog(|_| async { Err(plain_err("Catalog unavailable")) });
    assert_err(select().await, "model catalog could not be loaded");
    assert_eq!(f.peek()["config"], before);
    *f.driver.catalog.lock().unwrap() = load;
    let path = f.state_path();
    std::fs::remove_file(&path).unwrap();
    std::fs::create_dir(&path).unwrap();
    assert_err(select().await, "could not be saved");
    assert_eq!(f.peek()["config"], before);
    std::fs::remove_dir_all(&path).unwrap();
    select().await.unwrap();
    assert_eq!(f.peek()["config"]["thinking_level"], "high");
    f.finish().await;
}

#[tokio::test]
async fn a_stored_effort_becoming_unsupported_fails_admission_without_running_or_losing_the_preference()
 {
    let runs = counter();
    let ran = runs.clone();
    let f = setup_driver(move |d| {
        thinking(d);
        d.set_run(move |_| {
            bump(&ran);
            async { Ok(vec![]) }
        });
    });
    f.handle(
        "configure",
        merge(&configured(), json!({"thinking_level": "high"})),
    )
    .await
    .unwrap();
    f.driver.set_catalog(|_| async { Ok(catalog()) });
    assert_err(
        f.handle(
            "send",
            json!({"text": "Hello", "request_id": "unsupported"}),
        )
        .await,
        "thinking effort is not supported",
    );
    assert_eq!(count(&runs), 0);
    assert_eq!(f.peek()["running"], false);
    assert_eq!(f.peek()["config"]["thinking_level"], "high");
    f.finish().await;
}

#[tokio::test]
async fn a_failed_quick_selection_save_keeps_the_active_stream_attached_to_its_original_draft() {
    let release = Deferred::<()>::new();
    let (gate, disposed) = (release.clone(), release.clone());
    let f = setup_driver(move |d| {
        thinking(d);
        d.set_run(move |input| {
            let gate = gate.clone();
            async move {
                input.delta("Before");
                gate.wait().await?;
                input.delta(" after");
                input.message("Before after");
                Ok(vec![])
            }
        });
        d.set_dispose(move || {
            disposed.resolve(());
            async { Ok(()) }
        });
    });
    f.handle("configure", configured()).await.unwrap();
    f.handle(
        "send",
        json!({"request_id": "stream-save", "text": "Hello"}),
    )
    .await
    .unwrap();
    let path = f.state_path();
    std::fs::remove_file(&path).unwrap();
    std::fs::create_dir(&path).unwrap();
    assert_err(
        f.handle(
            "configure_chat",
            json!({
                "provider": "test", "model": "model", "thinking_level": "high",
                "expected": chat_selection(&f.peek()),
            }),
        )
        .await,
        "could not be saved",
    );
    assert!(f.peek()["config"].get("thinking_level").is_none());
    std::fs::remove_dir_all(&path).unwrap();
    release.resolve(());
    until(|| f.peek()["running"] == false).await;
    assert_eq!(last_message(&f.peek())["text"], "Before after");
    assert_eq!(last_message(&f.saved())["text"], "Before after");
    f.finish().await;
}

#[tokio::test]
async fn streaming_task_proposals_keep_the_admitted_model_and_effort_while_direct_task_edits_use_current_defaults()
 {
    let release = Deferred::<()>::new();
    let at = roamgate_agents::js::iso((SystemClock.now() + 3_600_000) as f64);
    let input = json!({
        "title": "Check later",
        "prompt": "Summarize status",
        "scope": allowed(),
        "schedule": {"type": "once", "at": at},
    });
    let proposal_id = slot::<String>();
    let (gate, disposed, task_input, found) = (
        release.clone(),
        release.clone(),
        input.clone(),
        proposal_id.clone(),
    );
    let f = setup_driver(move |d| {
        thinking(d);
        d.set_run(move |turn| {
            let (gate, task_input, found) = (gate.clone(), task_input.clone(), found.clone());
            async move {
                gate.wait().await?;
                let text = turn.task("create", task_input).await?.text;
                let proposal: Value = serde_json::from_str(&text).unwrap();
                *found.lock().unwrap() = Some(proposal["id"].as_str().unwrap().to_owned());
                Ok(vec![])
            }
        });
        d.set_dispose(move || {
            disposed.resolve(());
            async { Ok(()) }
        });
    });
    f.context.stable_task_identity();
    f.handle(
        "configure",
        merge(&configured(), json!({"thinking_level": "high"})),
    )
    .await
    .unwrap();
    f.handle(
        "send",
        json!({"request_id": "task-old-model", "text": "Check later"}),
    )
    .await
    .unwrap();
    f.handle(
        "configure_chat",
        json!({
            "provider": "test", "model": "fast", "thinking_level": null,
            "expected": chat_selection(&f.peek()),
        }),
    )
    .await
    .unwrap();
    release.resolve(());
    until(|| f.peek()["running"] == false).await;
    let proposal = proposal_id.lock().unwrap().clone().unwrap();
    assert!(!proposal.is_empty());
    f.handle("task.confirm_proposal", json!({"proposal_id": proposal}))
        .await
        .unwrap();
    let task_id = f.peek()["tasks"][0]["id"].as_str().unwrap().to_owned();
    assert_eq!(
        f.peek()["tasks"][0]["model"],
        json!({"provider": "test", "id": "model"})
    );
    let database = f.directory.join("tasks.sqlite");
    let saved_config = |id: &str| -> Value {
        let db = rusqlite::Connection::open_with_flags(
            &database,
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
        )
        .unwrap();
        let text: String = db
            .query_row("SELECT config FROM tasks WHERE id = ?", [id], |row| {
                row.get(0)
            })
            .unwrap();
        serde_json::from_str(&text).unwrap()
    };
    assert_matches(
        &saved_config(&task_id),
        json!({"provider": "test", "model": "model", "thinking_level": "high"}),
    );
    f.handle(
        "task.create",
        merge(
            &input,
            json!({"title": "Direct task", "request_id": uuid()}),
        ),
    )
    .await
    .unwrap();
    let direct = f.peek()["tasks"]
        .as_array()
        .unwrap()
        .iter()
        .find(|task| task["title"] == "Direct task")
        .unwrap()["id"]
        .as_str()
        .unwrap()
        .to_owned();
    assert_matches(
        &saved_config(&direct),
        json!({"provider": "test", "model": "fast"}),
    );
    assert!(saved_config(&direct).get("thinking_level").is_none());
    f.handle(
        "task.update",
        merge(&input, json!({"title": "Updated task", "task_id": task_id})),
    )
    .await
    .unwrap();
    assert_matches(
        &saved_config(&task_id),
        json!({"provider": "test", "model": "fast"}),
    );
    assert!(saved_config(&task_id).get("thinking_level").is_none());
    f.finish().await;
}

// ------------------------------------------------------------ inventory

#[tokio::test]
async fn pruning_an_unrelated_grant_while_preserves_the_original_durable_root() {
    for phase in ["running", "recovering"] {
        let pointer = vec![json!({"type": "ranger-durable", "id": uuid()})];
        let entered = Deferred::<()>::new();
        let release = Deferred::<()>::new();
        let (kept, open, gate, disposed) = (
            pointer.clone(),
            entered.clone(),
            release.clone(),
            release.clone(),
        );
        let f = setup_driver(move |d| {
            d.set_run(move |input| {
                let (kept, open, gate) = (kept.clone(), open.clone(), gate.clone());
                async move {
                    input.checkpoint(kept.clone()).await?;
                    open.resolve(());
                    gate.wait().await?;
                    Ok(kept)
                }
            });
            d.set_dispose(move || {
                disposed.resolve(());
                async { Ok(()) }
            });
        });
        f.context.stable_task_identity();
        let other = merge(&workspace(), json!({"workspace_id": "other"}));
        let listed: Listed = Arc::new(Mutex::new(vec![workspace(), other.clone()]));
        let shown = listed.clone();
        f.context.set_catalog(move || {
            let workspaces = shown.lock().unwrap().clone();
            async move {
                let mut listing = complete(Value::Array(workspaces));
                listing.as_object_mut().unwrap().shift_remove("truncated");
                Ok(listing)
            }
        });
        capture_as_given(&f);
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
            json!({
                "request_id": "recover-after-pruning",
                "text": "Read only the retained workspace",
                "scope": allowed(),
            }),
        )
        .await
        .unwrap();
        entered.wait().await.unwrap();
        *listed.lock().unwrap() = vec![workspace()];
        if phase == "running" {
            f.service.workspace_catalog().await.unwrap();
            let saved = f.saved();
            assert_eq!(saved["entries"], Value::Array(pointer.clone()));
            assert_eq!(saved["active_run"]["request_id"], "recover-after-pruning");
        }
        f.service.dispose().await;
        let resumed = slot::<Input>();
        let driver = f.driver.copy();
        let seen = resumed.clone();
        driver.set_run(move |input| {
            let seen = seen.clone();
            async move {
                let entries = input.input.entries.clone();
                *seen.lock().unwrap() = Some(input);
                Ok(entries)
            }
        });
        let service = f.restart(driver);
        service.resume().await.unwrap();
        until(|| service.peek()["running"] == false).await;
        assert_eq!(
            service.peek()["config"]["allowed_workspaces"],
            allowed(),
            "{phase}"
        );
        let resumed = resumed.lock().unwrap().clone().unwrap();
        assert!(resumed.input.recover);
        assert_eq!(resumed.request_id(), "recover-after-pruning");
        assert_eq!(resumed.entries(), Value::Array(pointer.clone()));
        f.finish().await;
    }
}

#[tokio::test]
async fn complete_inventories_prune_missing_workspaces_and_removed_connections_durably() {
    let f = setup();
    let extra = json!({"connection_id": "local", "workspace_id": "deleted"});
    let removed = json!({"connection_id": "removed", "workspace_id": "ws"});
    capture_as_given(&f);
    let widened = json!({"allowed_workspaces": [allowed()[0], extra, removed]});
    f.handle("configure", merge(&configured(), widened.clone()))
        .await
        .unwrap();
    f.context
        .set_catalog(|| async { Ok(complete(json!([workspace()]))) });
    f.service.workspace_catalog().await.unwrap();
    assert_eq!(f.peek()["config"]["allowed_workspaces"], allowed());
    assert_eq!(f.saved()["config"]["allowed_workspaces"], allowed());
    // A stale browser saving its old checked list must not reintroduce deleted IDs.
    f.handle("configure", merge(&configured(), widened))
        .await
        .unwrap();
    assert_eq!(f.peek()["config"]["allowed_workspaces"], allowed());
    f.context.set_catalog(|| async { Ok(complete(json!([]))) });
    f.service.workspace_catalog().await.unwrap();
    assert_eq!(f.peek()["config"]["allowed_workspaces"], json!([]));
    f.finish().await;
}

#[tokio::test]
async fn legacy_disconnected_truncated_and_failed_catalogs_preserve_the_saved_manual_selection() {
    let f = setup();
    f.handle("configure", configured()).await.unwrap();
    for inventory in [
        json!({"workspaces": [], "errors": []}),
        json!({
            "workspaces": [], "errors": ["Offline"],
            "connection_ids": ["local"], "complete_connection_ids": [],
        }),
        json!({
            "workspaces": [], "errors": ["Truncated"],
            "connection_ids": ["local"], "complete_connection_ids": [], "truncated": true,
        }),
    ] {
        f.context.set_catalog(move || {
            let inventory = inventory.clone();
            async move { Ok(inventory) }
        });
        f.service.workspace_catalog().await.unwrap();
        assert_eq!(f.peek()["config"]["allowed_workspaces"], allowed());
    }
    f.context
        .set_catalog(|| async { Err(plain_err("Unavailable")) });
    assert_err(f.service.workspace_catalog().await, "Unavailable");
    assert_eq!(f.peek()["config"]["allowed_workspaces"], allowed());
    f.finish().await;
}

#[tokio::test]
async fn an_older_inventory_response_cannot_prune_a_newer_verified_selection() {
    let f = setup();
    f.handle("configure", configured()).await.unwrap();
    let old = Deferred::<Value>::new();
    let calls = counter();
    let latest = complete(json!([workspace()]));
    let (pending, calls_seen, newest) = (old.clone(), calls.clone(), latest.clone());
    f.context.set_catalog(move || {
        let (pending, newest) = (pending.clone(), newest.clone());
        let call = bump(&calls_seen);
        async move {
            if call == 1 {
                pending.wait().await
            } else {
                Ok(newest)
            }
        }
    });
    let first = spawn_catalog(&f);
    flush_tasks().await;
    f.service.workspace_catalog().await.unwrap();
    old.resolve(merge(&latest, json!({"workspaces": []})));
    assert_eq!(first.await.unwrap().unwrap(), latest);
    assert_eq!(f.peek()["config"]["allowed_workspaces"], allowed());
    f.finish().await;
}

#[tokio::test]
async fn an_inventory_already_in_flight_cannot_prune_a_workspace_granted_after_it_started() {
    let f = setup();
    f.handle("configure", configured()).await.unwrap();
    let other = merge(&workspace(), json!({"workspace_id": "new"}));
    let entered = Deferred::<()>::new();
    let provider = Deferred::<()>::new();
    let pending = Deferred::<Value>::new();
    let fresh = complete(json!([workspace(), other]));
    let listing_fresh = fresh.clone();
    f.context.set_catalog(move || {
        let fresh = listing_fresh.clone();
        async move { Ok(fresh) }
    });
    capture_as_given(&f);
    let (open, gate) = (entered.clone(), provider.clone());
    f.driver.set_catalog(move |_| {
        let (open, gate) = (open.clone(), gate.clone());
        async move {
            open.resolve(());
            gate.wait().await?;
            Ok(catalog())
        }
    });
    let saving = spawn_handle(
        &f,
        "configure",
        merge(
            &configured(),
            json!({"allowed_workspaces": [allowed()[0], {"connection_id": "local", "workspace_id": "new"}]}),
        ),
    );
    entered.wait().await.unwrap();
    let reads = counter();
    let (seen, waiting, listing_fresh) = (reads.clone(), pending.clone(), fresh.clone());
    f.context.set_catalog(move || {
        let (waiting, fresh) = (waiting.clone(), listing_fresh.clone());
        let read = bump(&seen);
        async move {
            if read == 1 {
                waiting.wait().await
            } else {
                Ok(fresh)
            }
        }
    });
    let listing = spawn_catalog(&f);
    flush_tasks().await;
    provider.resolve(());
    saving.await.unwrap().unwrap();
    pending.resolve(merge(&fresh, json!({"workspaces": [workspace()]})));
    let received = listing.await.unwrap().unwrap();
    assert_eq!(received, fresh);
    assert_eq!(count(&reads), 2);
    assert_eq!(
        f.peek()["config"]["allowed_workspaces"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
    assert_eq!(
        f.saved()["config"]["allowed_workspaces"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
    // A subsequent fresh, complete listing may prune the same grant.
    let pruned = merge(&fresh, json!({"workspaces": [workspace()]}));
    f.context.set_catalog(move || {
        let pruned = pruned.clone();
        async move { Ok(pruned) }
    });
    f.service.workspace_catalog().await.unwrap();
    assert_eq!(f.peek()["config"]["allowed_workspaces"], allowed());
    f.finish().await;
}

#[tokio::test]
async fn a_capture_verified_manual_addition_can_send_after_a_stale_catalog_lands_before_its_save() {
    let inputs = inputs();
    let seen = inputs.clone();
    let f = setup_driver(move |d| {
        d.set_run(move |input| {
            seen.lock().unwrap().push(input);
            async { Ok(vec![]) }
        });
    });
    f.handle("configure", configured()).await.unwrap();
    let other = merge(&workspace(), json!({"workspace_id": "new"}));
    let reference = json!({"connection_id": "local", "workspace_id": "new"});
    let fresh = complete(json!([workspace(), other]));
    let entered = Deferred::<()>::new();
    let provider = Deferred::<()>::new();
    let listing = fresh.clone();
    f.context.set_catalog(move || {
        let listing = listing.clone();
        async move { Ok(listing) }
    });
    capture_as_given(&f);
    let (open, gate) = (entered.clone(), provider.clone());
    f.driver.set_catalog(move |_| {
        let (open, gate) = (open.clone(), gate.clone());
        async move {
            open.resolve(());
            gate.wait().await?;
            Ok(catalog())
        }
    });
    let saving = spawn_handle(
        &f,
        "configure",
        merge(
            &configured(),
            json!({"allowed_workspaces": [allowed()[0], reference]}),
        ),
    );
    entered.wait().await.unwrap();
    let stale = merge(&fresh, json!({"workspaces": [workspace()]}));
    f.context.set_catalog(move || {
        let stale = stale.clone();
        async move { Ok(stale) }
    });
    f.service.workspace_catalog().await.unwrap();
    provider.resolve(());
    saving.await.unwrap().unwrap();
    assert!(
        f.peek()["config"]["allowed_workspaces"]
            .as_array()
            .unwrap()
            .contains(&reference)
    );
    let listing = fresh.clone();
    f.context.set_catalog(move || {
        let listing = listing.clone();
        async move { Ok(listing) }
    });
    f.handle(
        "send",
        json!({"request_id": "manual-after-stale-cache", "text": "Read new", "scope": [reference]}),
    )
    .await
    .unwrap();
    until(|| f.peek()["running"] == false).await;
    assert_eq!(
        input_at(&inputs, 0).config()["allowed_workspaces"],
        json!([reference])
    );
    f.finish().await;
}

#[tokio::test]
async fn repeated_configuration_races_stop_a_refresh_without_discarding_newer_grants() {
    let f = setup();
    f.handle("configure", configured()).await.unwrap();
    let second = merge(&workspace(), json!({"workspace_id": "second"}));
    let third = merge(&workspace(), json!({"workspace_id": "third"}));
    let fresh = complete(json!([workspace(), second, third]));
    let first = Deferred::<Value>::new();
    let retry = Deferred::<Value>::new();
    let retry_entered = Deferred::<()>::new();
    let reads = counter();
    let (seen, one, again, entered, listing) = (
        reads.clone(),
        first.clone(),
        retry.clone(),
        retry_entered.clone(),
        fresh.clone(),
    );
    f.context.set_catalog(move || {
        let (one, again, entered, listing) =
            (one.clone(), again.clone(), entered.clone(), listing.clone());
        let read = bump(&seen);
        async move {
            match read {
                1 => one.wait().await,
                3 => {
                    entered.resolve(());
                    again.wait().await
                }
                _ => Ok(listing),
            }
        }
    });
    capture_as_given(&f);
    let listing = spawn_catalog(&f);
    flush_tasks().await;
    let refs = |ids: &[&str]| -> Value {
        Value::Array(
            ids.iter()
                .map(|id| json!({"connection_id": "local", "workspace_id": id}))
                .collect(),
        )
    };
    f.handle(
        "configure",
        merge(
            &configured(),
            json!({"allowed_workspaces": refs(&["ws", "second"])}),
        ),
    )
    .await
    .unwrap();
    first.resolve(merge(&fresh, json!({"workspaces": [workspace()]})));
    retry_entered.wait().await.unwrap();
    f.handle(
        "configure",
        merge(
            &configured(),
            json!({"allowed_workspaces": refs(&["ws", "second", "third"])}),
        ),
    )
    .await
    .unwrap();
    retry.resolve(merge(
        &fresh,
        json!({"workspaces": [workspace(), fresh["workspaces"][1]]}),
    ));
    assert_err(listing.await.unwrap(), "changed during refresh");
    assert_eq!(count(&reads), 4);
    assert_eq!(
        f.peek()["config"]["allowed_workspaces"],
        refs(&["ws", "second", "third"])
    );
    assert_eq!(f.service.workspace_catalog().await.unwrap(), fresh);
    f.finish().await;
}

#[tokio::test]
async fn a_failed_inventory_save_preserves_the_active_stream_s_message_references() {
    let entered = Deferred::<()>::new();
    let release = Deferred::<()>::new();
    let (open, gate) = (entered.clone(), release.clone());
    let f = setup_driver(move |d| {
        d.set_run(move |input| {
            let (open, gate) = (open.clone(), gate.clone());
            async move {
                input.delta("Before ");
                open.resolve(());
                gate.wait().await?;
                input.delta("after");
                Ok(vec![])
            }
        });
    });
    f.handle("configure", configured()).await.unwrap();
    f.handle(
        "send",
        json!({"request_id": "inventory-save", "text": "Read"}),
    )
    .await
    .unwrap();
    entered.wait().await.unwrap();
    f.context.set_catalog(|| async {
        Ok(json!({
            "workspaces": [], "errors": [],
            "connection_ids": ["local"], "complete_connection_ids": ["local"],
        }))
    });
    let path = f.state_path();
    let backup = f.directory.join("state.json.backup");
    std::fs::rename(&path, &backup).unwrap();
    std::fs::create_dir(&path).unwrap();
    assert_err(f.service.workspace_catalog().await, "could not be saved");
    assert_eq!(f.peek()["config"]["allowed_workspaces"], allowed());
    std::fs::remove_dir_all(&path).unwrap();
    std::fs::rename(&backup, &path).unwrap();
    release.resolve(());
    until(|| f.peek()["running"] == false).await;
    assert_eq!(last_message(&f.peek())["text"], "Before after");
    f.service.workspace_catalog().await.unwrap();
    assert_eq!(f.peek()["config"]["allowed_workspaces"], json!([]));
    f.finish().await;
}

// ------------------------------------------------------------ High permission

fn other() -> Value {
    merge(
        &workspace(),
        json!({"workspace_id": "other", "label": "Other"}),
    )
}

fn created() -> Value {
    merge(
        &workspace(),
        json!({"workspace_id": "w17", "label": "youtube-mcp"}),
    )
}

fn reference(item: &Value) -> Value {
    json!({"connection_id": item["connection_id"], "workspace_id": item["workspace_id"]})
}

/// `inventory(f, initial)`: the listing, changed by writing to it.
fn inventory_on(f: &Fixture, listed: Listed) {
    let shown = listed.clone();
    f.context.set_catalog(move || {
        let workspaces = shown.lock().unwrap().clone();
        async move { Ok(complete(Value::Array(workspaces))) }
    });
    let held = listed;
    f.context.set_capture(move |scope| {
        let listed = held.lock().unwrap().clone();
        async move {
            scope
                .as_array()
                .into_iter()
                .flatten()
                .map(|r| {
                    listed
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
        }
    });
    f.context.stable_task_identity();
}

fn inventory(f: &Fixture, initial: Vec<Value>) -> Listed {
    let listed: Listed = Arc::new(Mutex::new(initial));
    inventory_on(f, listed.clone());
    listed
}

fn set(listed: &Listed, next: Vec<Value>) {
    *listed.lock().unwrap() = next;
}

async fn enable(f: &Fixture) {
    f.handle(
        "configure_approval",
        json!({"approval_mode": "auto", "workspace_scope": "all"}),
    )
    .await
    .unwrap();
}

/// The captured scope with the refs not held yet, captured now.
async fn widen_with(
    context: &Arc<FakeContext>,
    captured: Value,
    refs: Value,
) -> AssistantResult<Value> {
    let held = captured.as_array().cloned().unwrap_or_default();
    let missing: Vec<Value> = refs
        .as_array()
        .into_iter()
        .flatten()
        .filter(|r| {
            !held.iter().any(|h| {
                h["connection_id"] == r["connection_id"] && h["workspace_id"] == r["workspace_id"]
            })
        })
        .cloned()
        .collect();
    let capture = context.capture_fn();
    let added = capture(Value::Array(missing)).await?;
    let mut all = held;
    all.extend(added.as_array().cloned().unwrap_or_default());
    Ok(Value::Array(all))
}

/// The real context's extendScope, over the fake catalog.
fn extendable(f: &Fixture) {
    let context = f.context.clone();
    f.context.set_extend(move |captured, refs, _signal| {
        let context = context.clone();
        async move { widen_with(&context, captured, refs).await }
    });
}

/// `creating(f, set)`: what was prepared, by kind and scope.
fn creating(f: &Fixture, listed: &Listed) -> Arc<Mutex<Vec<Value>>> {
    let prepared = list::<Value>();
    let (seen, listed) = (prepared.clone(), listed.clone());
    f.context.set_prepare(move |kind, captured, _params| {
        seen.lock()
            .unwrap()
            .push(json!({"kind": kind, "scope": scope_ids(&captured)}));
        let listed = listed.clone();
        let preview = merge(
            &workspace(),
            json!({
                "workspace_label": "Workspace",
                "kind": "create_workspace",
                "summary": "Create a workspace",
                "params": {"label": "youtube-mcp", "cwd": "/repo"},
            }),
        );
        async move {
            Ok(action(preview, move || async move {
                set(&listed, vec![workspace(), other(), created()]);
                Ok(json!({
                    "status": "succeeded",
                    "detail": "The new workspace and its directory were verified.",
                    "created": reference(&created()),
                }))
            }))
        }
    });
    prepared
}

fn texts(answers: &Arc<Mutex<Vec<String>>>) -> Vec<String> {
    answers.lock().unwrap().clone()
}

#[tokio::test]
async fn a_workspace_ranger_creates_joins_its_turn_at_once_and_the_chat_s_later_turns() {
    let inputs = inputs();
    let answers = list::<String>();
    let (seen, said) = (inputs.clone(), answers.clone());
    let f = setup_driver(move |d| {
        d.set_run(move |input| {
            let (seen, said) = (seen.clone(), said.clone());
            async move {
                let count = {
                    let mut seen = seen.lock().unwrap();
                    seen.push(input.clone());
                    seen.len()
                };
                if count == 1 {
                    let text = input
                        .propose(
                            "create_workspace",
                            merge(&reference(&workspace()), json!({"label": "youtube-mcp"})),
                        )
                        .await?
                        .text;
                    said.lock().unwrap().push(text);
                }
                // Its status, then a prompt to an agent in it, in the same turn.
                let text = input.read("status", reference(&created())).await?.text;
                said.lock().unwrap().push(text);
                let text = input
                    .propose(
                        "send_prompt",
                        merge(
                            &reference(&created()),
                            json!({"pane_id": "p1", "prompt": "Investigate"}),
                        ),
                    )
                    .await?
                    .text;
                said.lock().unwrap().push(text);
                Ok(vec![])
            }
        });
    });
    let listed = inventory(&f, vec![workspace(), other()]);
    extendable(&f);
    let prepared = creating(&f, &listed);
    f.handle("configure", configured()).await.unwrap();
    f.handle("configure_approval", json!({"approval_mode": "auto"}))
        .await
        .unwrap();
    f.handle(
        "send",
        json!({
            "request_id": "create",
            "text": "Create a new mcp workspace and start Claude in it",
            "scope": [reference(&workspace())],
        }),
    )
    .await
    .unwrap();
    until(|| f.peek()["running"] == false).await;
    assert_eq!(f.peek()["error"], Value::Null);
    let said = texts(&answers);
    let first: Value = serde_json::from_str(&said[0]).unwrap();
    assert_matches(&first, json!({"status": "succeeded"}));
    assert!(said[0].contains("workspace_id w17"));
    assert_eq!(said[1], "Workspace is working");
    assert_eq!(last_read_ids(&f), vec!["ws", "w17"]);
    let third: Value = serde_json::from_str(&said[2]).unwrap();
    assert_matches(&third, json!({"kind": "send_prompt"}));
    assert_eq!(
        prepared.lock().unwrap()[1],
        json!({"kind": "send_prompt", "scope": ["ws", "w17"]})
    );
    // The settings' grant is unchanged: the workspace is this chat's.
    assert_eq!(f.peek()["config"]["allowed_workspaces"], allowed());
    // A later turn of the chat, sent with the grant only, holds it too.
    f.handle(
        "send",
        json!({"request_id": "later", "text": "How is it going?", "scope": [reference(&workspace())]}),
    )
    .await
    .unwrap();
    until(|| f.peek()["running"] == false).await;
    assert_eq!(
        input_at(&inputs, 1).config()["allowed_workspaces"],
        json!([reference(&workspace()), reference(&created())])
    );
    assert_eq!(texts(&answers)[3], "Workspace is working");
    // So does the chat after a restart, but not another chat.
    assert_eq!(
        f.saved()["created_workspaces"],
        json!([reference(&created())])
    );
    f.handle("new_session", json!({})).await.unwrap();
    f.handle(
        "send",
        json!({"request_id": "other-chat", "text": "And there?", "scope": [reference(&workspace())]}),
    )
    .await
    .unwrap();
    until(|| f.peek()["running"] == false).await;
    assert_eq!(
        input_at(&inputs, 2).config()["allowed_workspaces"],
        json!([reference(&workspace())])
    );
    assert_eq!(last_read_ids(&f), vec!["ws"]);
    f.finish().await;
}

#[tokio::test]
async fn a_workspace_created_on_confirmation_joins_the_chat_s_next_turn() {
    let inputs = inputs();
    let seen = inputs.clone();
    let f = setup_driver(move |d| {
        d.set_run(move |input| {
            let seen = seen.clone();
            async move {
                let count = {
                    let mut seen = seen.lock().unwrap();
                    seen.push(input.clone());
                    seen.len()
                };
                if count == 1 {
                    input
                        .propose(
                            "create_workspace",
                            merge(&reference(&workspace()), json!({"label": "youtube-mcp"})),
                        )
                        .await?;
                } else {
                    input.read("status", reference(&created())).await?;
                }
                Ok(vec![])
            }
        });
    });
    let listed = inventory(&f, vec![workspace(), other()]);
    extendable(&f);
    creating(&f, &listed);
    f.handle("configure", configured()).await.unwrap();
    f.handle(
        "send",
        json!({"request_id": "propose", "text": "Create a workspace", "scope": [reference(&workspace())]}),
    )
    .await
    .unwrap();
    until(|| f.peek()["running"] == false).await;
    let action = last_message(&f.peek())["actions"][0].clone();
    f.handle("action.confirm", json!({"action_id": action["id"]}))
        .await
        .unwrap();
    until(|| last_message(&f.peek())["actions"][0]["status"] == "succeeded").await;
    flush_tasks().await;
    f.handle(
        "send",
        json!({"request_id": "status", "text": "What is in it?", "scope": [reference(&workspace())]}),
    )
    .await
    .unwrap();
    until(|| f.peek()["running"] == false).await;
    assert_eq!(f.peek()["error"], Value::Null);
    assert_eq!(
        input_at(&inputs, 1).config()["allowed_workspaces"],
        json!([reference(&workspace()), reference(&created())])
    );
    f.finish().await;
}

#[tokio::test]
async fn full_access_reaches_a_workspace_created_after_its_turn_started() {
    let answers = list::<String>();
    let listed: Listed = Arc::new(Mutex::new(vec![workspace(), other()]));
    let brand_new = merge(&workspace(), json!({"workspace_id": "brand-new"}));
    let (said, shown, fresh) = (answers.clone(), listed.clone(), brand_new.clone());
    let f = setup_driver(move |d| {
        d.set_run(move |input| {
            let (said, shown, fresh) = (said.clone(), shown.clone(), fresh.clone());
            async move {
                // Made outside Ranger while it answers.
                set(&shown, vec![workspace(), other(), fresh.clone()]);
                let text = input.read("status", reference(&fresh)).await?.text;
                said.lock().unwrap().push(text);
                let text = input.read("status", json!({})).await?.text;
                said.lock().unwrap().push(text);
                Ok(vec![])
            }
        });
    });
    inventory_on(&f, listed);
    extendable(&f);
    f.handle(
        "configure",
        merge(&configured(), json!({"allowed_workspaces": []})),
    )
    .await
    .unwrap();
    enable(&f).await;
    f.handle(
        "send",
        json!({
            "request_id": "full",
            "text": "Look at the new one",
            "scope": [reference(&workspace()), reference(&other())],
        }),
    )
    .await
    .unwrap();
    until(|| f.peek()["running"] == false).await;
    assert_eq!(f.peek()["error"], Value::Null);
    assert_eq!(
        texts(&answers),
        vec!["Workspace is working", "Workspace is working"]
    );
    assert_eq!(last_read_ids(&f), vec!["ws", "other", "brand-new"]);
    f.finish().await;
}

#[tokio::test]
async fn selected_workspaces_do_not_reach_one_ranger_did_not_create() {
    let f = setup_driver(|d| {
        d.set_run(|input| async move {
            input.read("status", reference(&other())).await?;
            Ok(vec![])
        });
    });
    inventory(&f, vec![workspace(), other()]);
    extendable(&f);
    f.handle("configure", configured()).await.unwrap();
    f.handle("configure_approval", json!({"approval_mode": "auto"}))
        .await
        .unwrap();
    f.handle(
        "send",
        json!({"request_id": "outside", "text": "Read the other one", "scope": [reference(&workspace())]}),
    )
    .await
    .unwrap();
    until(|| f.peek()["running"] == false).await;
    // The reader refuses a target outside the scope it is given.
    assert_eq!(scope_ids(&f.context.reads()[0].0), vec!["ws"]);
    f.finish().await;
}

#[tokio::test]
async fn a_task_does_not_cover_a_workspace_only_the_chat_created() {
    let refused = slot::<String>();
    let said = refused.clone();
    let f = setup_driver(move |d| {
        d.set_run(move |input| {
            let said = said.clone();
            async move {
                input
                    .propose(
                        "create_workspace",
                        merge(&reference(&workspace()), json!({"label": "youtube-mcp"})),
                    )
                    .await?;
                let at = roamgate_agents::js::iso((SystemClock.now() + 3_600_000) as f64);
                if let Err(error) = input
                    .task(
                        "create",
                        json!({
                            "title": "Watch it",
                            "prompt": "Check the new workspace",
                            "scope": [reference(&workspace()), reference(&created())],
                            "schedule": {"type": "once", "at": at},
                        }),
                    )
                    .await
                {
                    *said.lock().unwrap() = Some(error.message().to_owned());
                }
                Ok(vec![])
            }
        });
    });
    let listed = inventory(&f, vec![workspace(), other()]);
    extendable(&f);
    creating(&f, &listed);
    f.handle("configure", configured()).await.unwrap();
    f.handle("configure_approval", json!({"approval_mode": "auto"}))
        .await
        .unwrap();
    f.handle(
        "send",
        json!({
            "request_id": "task",
            "text": "Create a workspace and watch it hourly",
            "scope": [reference(&workspace())],
        }),
    )
    .await
    .unwrap();
    until(|| f.peek()["running"] == false).await;
    // A task outlives the chat: only the settings' grant counts for it.
    assert_eq!(
        refused.lock().unwrap().as_deref(),
        Some("Choose an authorized task scope.")
    );
    assert!(f.peek()["tasks"].as_array().is_none_or(Vec::is_empty));
    f.finish().await;
}

#[tokio::test]
async fn a_workspace_ranger_created_is_forgotten_once_closed_so_its_id_reused_later_is_not_reached()
{
    let turn = counter();
    let seen = turn.clone();
    let f = setup_driver(move |d| {
        d.set_run(move |input| {
            let turn = bump(&seen);
            async move {
                if turn == 1 {
                    input
                        .propose(
                            "create_workspace",
                            merge(&reference(&workspace()), json!({"label": "youtube-mcp"})),
                        )
                        .await?;
                } else {
                    input.read("status", reference(&created())).await?;
                }
                Ok(vec![])
            }
        });
    });
    let listed = inventory(&f, vec![workspace(), other()]);
    extendable(&f);
    creating(&f, &listed);
    f.handle("configure", configured()).await.unwrap();
    f.handle("configure_approval", json!({"approval_mode": "auto"}))
        .await
        .unwrap();
    f.handle(
        "send",
        json!({"request_id": "create", "text": "Create a workspace", "scope": [reference(&workspace())]}),
    )
    .await
    .unwrap();
    until(|| f.peek()["running"] == false).await;
    assert_eq!(
        f.saved()["created_workspaces"],
        json!([reference(&created())])
    );
    // Closed: the next listing forgets it.
    set(&listed, vec![workspace(), other()]);
    f.handle(
        "send",
        json!({"request_id": "closed", "text": "Is it there?", "scope": [reference(&workspace())]}),
    )
    .await
    .unwrap();
    until(|| f.peek()["running"] == false).await;
    assert!(f.saved().get("created_workspaces").is_none());
    // Another workspace later gets the same id: this chat does not reach it.
    set(
        &listed,
        vec![
            workspace(),
            other(),
            merge(&created(), json!({"label": "someone else's"})),
        ],
    );
    f.handle(
        "send",
        json!({"request_id": "reused", "text": "And now?", "scope": [reference(&workspace())]}),
    )
    .await
    .unwrap();
    until(|| f.peek()["running"] == false).await;
    assert_eq!(last_read_ids(&f), vec!["ws"]);
    f.finish().await;
}

#[tokio::test]
async fn tool_calls_widening_a_turn_at_once_keep_every_workspace_they_add() {
    let third = merge(&workspace(), json!({"workspace_id": "third"}));
    let slow = Deferred::<()>::new();
    let answers = list::<String>();
    let listed: Listed = Arc::new(Mutex::new(vec![workspace()]));
    let (said, shown, released, extra) =
        (answers.clone(), listed.clone(), slow.clone(), third.clone());
    let f = setup_driver(move |d| {
        d.set_run(move |input| {
            let (said, shown, released, extra) =
                (said.clone(), shown.clone(), released.clone(), extra.clone());
            async move {
                // Both appear after the turn started.
                set(&shown, vec![workspace(), other(), extra.clone()]);
                let first = tokio::spawn(input.read("status", reference(&other())));
                let second = tokio::spawn(input.read("status", reference(&extra)));
                flush_tasks().await;
                released.resolve(());
                let first = first.await.unwrap()?.text;
                let second = second.await.unwrap()?.text;
                said.lock().unwrap().extend([first, second]);
                let text = input.read("status", reference(&other())).await?.text;
                said.lock().unwrap().push(text);
                Ok(vec![])
            }
        });
    });
    inventory_on(&f, listed);
    let extending = counter();
    let (context, gate) = (f.context.clone(), slow.clone());
    f.context.set_extend(move |captured, refs, _signal| {
        let (context, gate) = (context.clone(), gate.clone());
        let first = bump(&extending) == 1;
        async move {
            // The first widening is slow: the second starts while it runs.
            if first {
                gate.wait().await?;
            }
            widen_with(&context, captured, refs).await
        }
    });
    f.handle(
        "configure",
        merge(&configured(), json!({"allowed_workspaces": []})),
    )
    .await
    .unwrap();
    enable(&f).await;
    f.handle(
        "send",
        json!({"request_id": "parallel", "text": "Look at both", "scope": [reference(&workspace())]}),
    )
    .await
    .unwrap();
    until(|| f.peek()["running"] == false).await;
    assert_eq!(f.peek()["error"], Value::Null);
    assert_eq!(
        texts(&answers),
        vec![
            "Workspace is working",
            "Workspace is working",
            "Workspace is working"
        ]
    );
    // Neither widening dropped the other's workspace.
    assert_eq!(last_read_ids(&f), vec!["ws", "other", "third"]);
    f.finish().await;
}

#[tokio::test]
async fn explicit_high_covers_more_than_64_current_workspaces_and_future_workspaces_without_altering_manual_grants()
 {
    let inputs = inputs();
    let seen = inputs.clone();
    let f = setup_driver(move |d| {
        d.set_run(move |input| {
            seen.lock().unwrap().push(input);
            async { Ok(vec![]) }
        });
    });
    let listed_workspaces: Vec<Value> = (0..65)
        .map(|i| merge(&workspace(), json!({"workspace_id": format!("ws-{i}")})))
        .collect();
    let listed = inventory(&f, listed_workspaces.clone());
    f.handle(
        "configure",
        merge(&configured(), json!({"allowed_workspaces": []})),
    )
    .await
    .unwrap();
    enable(&f).await;
    f.handle("send", json!({"request_id": "all-65", "text": "Read all"}))
        .await
        .unwrap();
    until(|| f.peek()["running"] == false).await;
    assert_eq!(
        input_at(&inputs, 0).config()["allowed_workspaces"],
        Value::Array(listed_workspaces.iter().map(reference).collect())
    );
    assert_eq!(f.peek()["config"]["allowed_workspaces"], json!([]));
    let future = merge(&workspace(), json!({"workspace_id": "future"}));
    let mut next = listed_workspaces.clone();
    next.push(future.clone());
    set(&listed, next);
    f.handle(
        "send",
        json!({"request_id": "future-explicit", "text": "Read future", "scope": [reference(&future)]}),
    )
    .await
    .unwrap();
    until(|| f.peek()["running"] == false).await;
    assert_eq!(
        input_at(&inputs, 1).config()["allowed_workspaces"],
        json!([reference(&future)])
    );
    f.handle(
        "send",
        json!({"request_id": "future-all", "text": "Read all again"}),
    )
    .await
    .unwrap();
    until(|| f.peek()["running"] == false).await;
    assert_eq!(
        input_at(&inputs, 2).config()["allowed_workspaces"]
            .as_array()
            .unwrap()
            .len(),
        66
    );
    assert_matches(
        &f.saved()["config"],
        json!({"allowed_workspaces": [], "workspace_scope": "all"}),
    );
    f.handle("configure_approval", json!({"approval_mode": "manual"}))
        .await
        .unwrap();
    assert_eq!(f.peek()["config"]["allowed_workspaces"], json!([]));
    assert!(f.peek()["config"].get("workspace_scope").is_none());
    assert_err(
        f.handle(
            "send",
            json!({"request_id": "revoked", "text": "Read future", "scope": [reference(&future)]}),
        )
        .await,
        "authorized",
    );
    f.finish().await;
}

#[tokio::test]
async fn legacy_auto_and_generic_configuration_cannot_silently_grant_all_workspaces() {
    let f = setup();
    inventory(&f, vec![workspace(), other()]);
    f.handle("configure", configured()).await.unwrap();
    f.handle("configure_approval", json!({"approval_mode": "auto"}))
        .await
        .unwrap();
    assert!(f.peek()["config"].get("workspace_scope").is_none());
    assert_err(
        f.handle(
            "send",
            json!({"request_id": "legacy", "text": "Read other", "scope": [reference(&other())]}),
        )
        .await,
        "authorized",
    );
    let all = merge(
        &configured(),
        json!({"approval_mode": "auto", "workspace_scope": "all"}),
    );
    f.handle("configure", all.clone()).await.unwrap();
    assert!(f.peek()["config"].get("workspace_scope").is_none());
    assert!(
        f.handle(
            "configure_approval",
            json!({"approval_mode": "auto", "workspace_scope": "anything"}),
        )
        .await
        .is_err()
    );
    enable(&f).await;
    f.handle("configure", configured()).await.unwrap();
    assert_eq!(f.peek()["config"]["workspace_scope"], "all");
    f.handle("configure_approval", json!({"approval_mode": "manual"}))
        .await
        .unwrap();
    assert_eq!(f.peek()["config"]["allowed_workspaces"], allowed());
    f.handle("configure", all).await.unwrap();
    assert_matches(
        &f.peek()["config"],
        json!({"approval_mode": "manual", "allowed_workspaces": allowed()}),
    );
    assert!(f.peek()["config"].get("workspace_scope").is_none());
    f.finish().await;
}

#[tokio::test]
async fn a_restarted_legacy_auto_configuration_stays_restricted_until_explicit_all_workspace_consent()
 {
    let f = setup();
    inventory(&f, vec![workspace(), other()]);
    f.handle("configure", configured()).await.unwrap();
    f.handle("configure_approval", json!({"approval_mode": "auto"}))
        .await
        .unwrap();
    f.service.dispose().await;
    let inputs = inputs();
    let seen = inputs.clone();
    let driver = f.driver.copy();
    driver.set_run(move |input| {
        seen.lock().unwrap().push(input);
        async { Ok(vec![]) }
    });
    let restored = f.restart(driver);
    assert!(restored.peek()["config"].get("workspace_scope").is_none());
    restored
        .handle(
            "send",
            json!({"request_id": "legacy-default", "text": "Read"}),
        )
        .await
        .unwrap();
    until(|| restored.peek()["running"] == false).await;
    assert_eq!(
        input_at(&inputs, 0).config()["allowed_workspaces"],
        allowed()
    );
    assert_err(
        restored
            .handle(
                "send",
                json!({"request_id": "legacy-outside", "text": "Read other", "scope": [reference(&other())]}),
            )
            .await,
        "authorized",
    );
    restored
        .handle(
            "configure_approval",
            json!({"approval_mode": "auto", "workspace_scope": "all"}),
        )
        .await
        .unwrap();
    restored
        .handle(
            "send",
            json!({"request_id": "consented", "text": "Read all"}),
        )
        .await
        .unwrap();
    until(|| restored.peek()["running"] == false).await;
    assert_eq!(
        input_at(&inputs, 1).config()["allowed_workspaces"],
        json!([reference(&workspace()), reference(&other())])
    );
    f.finish().await;
}

#[tokio::test]
async fn a_default_manual_send_uses_the_surviving_grants_after_authoritative_pruning() {
    let inputs = inputs();
    let seen = inputs.clone();
    let f = setup_driver(move |d| {
        d.set_run(move |input| {
            seen.lock().unwrap().push(input);
            async { Ok(vec![]) }
        });
    });
    let listed = inventory(&f, vec![workspace(), other()]);
    f.handle(
        "configure",
        merge(
            &configured(),
            json!({"allowed_workspaces": [reference(&workspace()), reference(&other())]}),
        ),
    )
    .await
    .unwrap();
    set(&listed, vec![workspace()]);
    f.handle(
        "send",
        json!({"request_id": "surviving-manual", "text": "Read"}),
    )
    .await
    .unwrap();
    until(|| f.peek()["running"] == false).await;
    assert_eq!(
        input_at(&inputs, 0).config()["allowed_workspaces"],
        allowed()
    );
    assert_eq!(f.peek()["config"]["allowed_workspaces"], allowed());
    f.finish().await;
}

#[tokio::test]
async fn truncated_high_inventory_fails_closed_with_explicit_scope() {
    for explicit in [false, true] {
        let runs = counter();
        let ran = runs.clone();
        let f = setup_driver(move |d| {
            d.set_run(move |_| {
                bump(&ran);
                async { Ok(vec![]) }
            });
        });
        inventory(&f, vec![workspace(), other()]);
        f.handle("configure", configured()).await.unwrap();
        enable(&f).await;
        f.context.set_catalog(|| async {
            Ok(json!({
                "workspaces": [workspace()], "errors": ["Truncated"],
                "connection_ids": ["local"], "complete_connection_ids": [], "truncated": true,
            }))
        });
        let mut params = json!({"request_id": "truncated", "text": "Read all"});
        if explicit {
            params["scope"] = allowed();
        }
        assert_err(f.handle("send", params).await, "complete workspace list");
        assert_eq!(count(&runs), 0);
        assert_eq!(f.peek()["config"]["allowed_workspaces"], allowed());
        f.finish().await;
    }
}

#[tokio::test]
async fn high_off_during_admission_prevents_the_broader_turn_from_starting() {
    for stage in ["inventory", "provider", "capture", "recovery"] {
        let runs = counter();
        let ran = runs.clone();
        let f = setup_driver(move |d| {
            d.set_run(move |_| {
                bump(&ran);
                async { Ok(vec![]) }
            });
        });
        inventory(&f, vec![workspace(), other()]);
        f.handle("configure", configured()).await.unwrap();
        enable(&f).await;
        let entered = Deferred::<()>::new();
        let release = Deferred::<()>::new();
        let gate = move |entered: Arc<Deferred<()>>, release: Arc<Deferred<()>>| async move {
            entered.resolve(());
            release.wait().await
        };
        let (open, close) = (entered.clone(), release.clone());
        match stage {
            "inventory" => {
                let previous = f.context.catalog_fn();
                f.context.set_catalog(move || {
                    let (previous, open, close) = (previous.clone(), open.clone(), close.clone());
                    async move {
                        let result = previous().await?;
                        gate(open, close).await?;
                        Ok(result)
                    }
                });
            }
            "provider" => {
                let previous = f.driver.catalog.lock().unwrap().clone();
                f.driver.set_catalog(move |source| {
                    let (previous, open, close) = (previous.clone(), open.clone(), close.clone());
                    async move {
                        let result = previous(source).await?;
                        gate(open, close).await?;
                        Ok(result)
                    }
                });
            }
            "capture" => {
                let previous = f.context.capture_fn();
                f.context.set_capture(move |refs| {
                    let (previous, open, close) = (previous.clone(), open.clone(), close.clone());
                    async move {
                        let result = previous(refs).await?;
                        gate(open, close).await?;
                        Ok(result)
                    }
                });
            }
            _ => {
                let previous = f.context.recovery_fn();
                f.context.set_recovery(move |captured| {
                    let (previous, open, close) = (previous.clone(), open.clone(), close.clone());
                    async move {
                        let result = previous(captured).await?;
                        gate(open, close).await?;
                        Ok(result)
                    }
                });
            }
        }
        let send = spawn_handle(
            &f,
            "send",
            json!({"request_id": format!("race-{stage}"), "text": "Read all"}),
        );
        entered.wait().await.unwrap();
        f.handle("configure_approval", json!({"approval_mode": "manual"}))
            .await
            .unwrap();
        release.resolve(());
        assert_err(send.await.unwrap(), "workspace permissions changed");
        assert_eq!(count(&runs), 0, "{stage}");
        assert_eq!(f.peek()["messages"], json!([]));
        f.finish().await;
    }
}

/// A driver whose run waits on `done`, stopped and disposed by resolving it.
fn waiting_driver(
    input: Arc<Mutex<Option<Input>>>,
    done: Arc<Deferred<Vec<Value>>>,
) -> impl FnOnce(&FakeDriver) {
    move |d| {
        let (stop, dispose) = (done.clone(), done.clone());
        d.set_run(move |value| {
            let (input, done) = (input.clone(), done.clone());
            *input.lock().unwrap() = Some(value);
            async move { done.wait().await }
        });
        d.set_stop(move || {
            stop.resolve(vec![]);
            async { Ok(()) }
        });
        d.set_dispose(move || {
            dispose.resolve(vec![]);
            async { Ok(()) }
        });
    }
}

#[tokio::test]
async fn high_off_rejects_an_in_flight_read_result_and_new_action_preparations() {
    let entered = Deferred::<()>::new();
    let release = Deferred::<ToolResult>::new();
    let done = Deferred::<Vec<Value>>::new();
    let input = slot::<Input>();
    let prepared = counter();
    let f = setup_driver(waiting_driver(input.clone(), done.clone()));
    inventory(&f, vec![workspace(), other()]);
    let (open, result) = (entered.clone(), release.clone());
    f.context.set_read(move |_, _, _| {
        let (open, result) = (open.clone(), result.clone());
        async move {
            open.resolve(());
            result.wait().await
        }
    });
    let counted = prepared.clone();
    f.context.set_prepare(move |_, _, _| {
        bump(&counted);
        async {
            Ok(permission_action(|| async {
                Ok(json!({"status": "succeeded", "detail": "Created"}))
            }))
        }
    });
    f.handle("configure", configured()).await.unwrap();
    enable(&f).await;
    f.handle(
        "send",
        json!({"request_id": "live-read", "text": "Read all"}),
    )
    .await
    .unwrap();
    let turn = input.lock().unwrap().clone().unwrap();
    let reading = tokio::spawn(turn.read("status", json!({})));
    entered.wait().await.unwrap();
    f.handle("configure_approval", json!({"approval_mode": "manual"}))
        .await
        .unwrap();
    release.resolve(ToolResult {
        text: "Private result".into(),
        sources: Some(vec![]),
    });
    assert_err(reading.await.unwrap(), "authorized");
    assert_err(
        turn.propose("create_tab", reference(&other())).await,
        "authorized",
    );
    assert_eq!(count(&prepared), 0);
    done.resolve(vec![]);
    until(|| f.peek()["running"] == false).await;
    f.finish().await;
}

#[tokio::test]
async fn high_off_while_preparing_a_broader_action_prevents_storing_or_executing_its_preview() {
    let entered = Deferred::<()>::new();
    let release = Deferred::<()>::new();
    let done = Deferred::<Vec<Value>>::new();
    let input = slot::<Input>();
    let writes = counter();
    let f = setup_driver(waiting_driver(input.clone(), done.clone()));
    inventory(&f, vec![workspace(), other()]);
    let (open, gate, written) = (entered.clone(), release.clone(), writes.clone());
    f.context.set_prepare(move |_, _, _| {
        let (open, gate, written) = (open.clone(), gate.clone(), written.clone());
        async move {
            open.resolve(());
            gate.wait().await?;
            Ok(permission_action(move || async move {
                bump(&written);
                Ok(json!({"status": "succeeded", "detail": "Created"}))
            }))
        }
    });
    f.handle("configure", configured()).await.unwrap();
    enable(&f).await;
    f.handle(
        "send",
        json!({"request_id": "live-preview", "text": "Create in other"}),
    )
    .await
    .unwrap();
    let turn = input.lock().unwrap().clone().unwrap();
    let preparing = tokio::spawn(turn.propose("create_tab", reference(&other())));
    entered.wait().await.unwrap();
    f.handle("configure_approval", json!({"approval_mode": "manual"}))
        .await
        .unwrap();
    release.resolve(());
    assert_err(preparing.await.unwrap(), "authorized");
    assert_eq!(count(&writes), 0);
    assert!(
        last_message(&f.peek())["actions"]
            .as_array()
            .is_none_or(Vec::is_empty)
    );
    done.resolve(vec![]);
    until(|| f.peek()["running"] == false).await;
    f.finish().await;
}

#[tokio::test]
async fn a_high_turn_and_its_recovery_retain_their_original_concrete_scope() {
    let stopped = Deferred::<Vec<Value>>::new();
    let (waiting, disposed) = (stopped.clone(), stopped.clone());
    let f = setup_driver(move |d| {
        d.set_run(move |_| {
            let waiting = waiting.clone();
            async move { waiting.wait().await }
        });
        d.set_dispose(move || {
            disposed.resolve(vec![]);
            async { Ok(()) }
        });
    });
    let listed = inventory(&f, vec![workspace(), other()]);
    f.handle("configure", configured()).await.unwrap();
    enable(&f).await;
    f.handle(
        "send",
        json!({"request_id": "recover-high", "text": "Read all"}),
    )
    .await
    .unwrap();
    let saved = f.saved();
    assert_eq!(saved["config"]["allowed_workspaces"], allowed());
    assert_eq!(
        saved["active_run"]["config"]["allowed_workspaces"],
        json!([reference(&workspace()), reference(&other())])
    );
    let future = merge(&workspace(), json!({"workspace_id": "future"}));
    set(&listed, vec![workspace(), other(), future]);
    f.service.workspace_catalog().await.unwrap();
    f.service.dispose().await;
    let inputs = inputs();
    let seen = inputs.clone();
    let driver = f.driver.copy();
    driver.set_run(move |input| {
        seen.lock().unwrap().push(input);
        async { Ok(vec![]) }
    });
    let restored = f.restart(driver);
    restored.resume().await.unwrap();
    until(|| restored.peek()["running"] == false).await;
    assert_eq!(inputs.lock().unwrap().len(), 1);
    assert_eq!(
        input_at(&inputs, 0).config()["allowed_workspaces"],
        json!([reference(&workspace()), reference(&other())])
    );
    assert_eq!(restored.peek()["config"]["workspace_scope"], "all");
    restored
        .handle("configure_approval", json!({"approval_mode": "manual"}))
        .await
        .unwrap();
    assert_eq!(restored.peek()["config"]["allowed_workspaces"], allowed());
    f.finish().await;
}

/// A child driver whose runs are recorded and return `run`'s outcome.
fn child_driver(
    run: impl Fn(Input) -> Fut<Vec<Value>> + Send + Sync + 'static,
    stop: Option<Arc<Deferred<Vec<Value>>>>,
) -> ChildDriver {
    let run: RunFn = Arc::new(run);
    Arc::new(move || {
        let driver = FakeDriver::new();
        *driver.run.lock().unwrap() = run.clone();
        if let Some(done) = stop.clone() {
            let disposed = done.clone();
            driver.set_stop(move || {
                done.resolve(vec![]);
                async { Ok(()) }
            });
            driver.set_dispose(move || {
                disposed.resolve(vec![]);
                async { Ok(()) }
            });
        }
        driver
    })
}

#[tokio::test]
async fn high_scheduled_tasks_keep_fixed_targets_and_reject_global_high_off_during_reads() {
    let done = Deferred::<Vec<Value>>::new();
    let input = slot::<Input>();
    let (seen, waiting) = (input.clone(), done.clone());
    let f = setup_with(
        |_| {},
        Setup {
            child: Some(child_driver(
                move |value| {
                    *seen.lock().unwrap() = Some(value);
                    let waiting = waiting.clone();
                    Box::pin(async move { waiting.wait().await })
                },
                Some(done.clone()),
            )),
            fake_now: Some("2026-10-04T00:00:00Z"),
            ..Setup::default()
        },
    );
    let listed = inventory(&f, vec![workspace(), other()]);
    f.handle("configure", configured()).await.unwrap();
    enable(&f).await;
    let task_id = f
        .handle(
            "task.create",
            json!({
                "request_id": uuid(),
                "title": "Other only",
                "prompt": "Read other",
                "scope": [reference(&other())],
                "schedule": {"type": "interval", "minutes": 1},
            }),
        )
        .await
        .unwrap()["tasks"][0]["id"]
        .clone();
    set(
        &listed,
        vec![
            workspace(),
            other(),
            merge(&workspace(), json!({"workspace_id": "future"})),
        ],
    );
    f.service.resume().await.unwrap();
    f.handle("task.run_now", json!({"task_id": task_id}))
        .await
        .unwrap();
    f.advance(0).await;
    flush_tasks().await;
    let turn = input.lock().unwrap().clone().unwrap();
    assert_eq!(
        turn.config()["allowed_workspaces"],
        json!([reference(&other())])
    );
    f.handle("configure_approval", json!({"approval_mode": "manual"}))
        .await
        .unwrap();
    assert!(turn.read("status", json!({})).await.is_err());
    assert!(f.context.reads().is_empty());
    done.resolve(vec![]);
    flush_tasks().await;
    f.finish().await;
}

#[tokio::test]
async fn a_disconnected_high_only_scheduled_target_waits_and_resumes_without_adding_targets() {
    let inputs = inputs();
    let seen = inputs.clone();
    let f = setup_with(
        |_| {},
        Setup {
            child: Some(child_driver(
                move |input| {
                    seen.lock().unwrap().push(input);
                    Box::pin(async { Ok(vec![]) })
                },
                None,
            )),
            fake_now: Some("2026-10-04T00:00:00Z"),
            ..Setup::default()
        },
    );
    inventory(&f, vec![workspace(), other()]);
    f.handle("configure", configured()).await.unwrap();
    enable(&f).await;
    let task_id = f
        .handle(
            "task.create",
            json!({
                "request_id": uuid(),
                "title": "Wait for other",
                "prompt": "Read other",
                "scope": [reference(&other())],
                "schedule": {"type": "once", "at": "2026-10-04T00:00:01.000Z"},
            }),
        )
        .await
        .unwrap()["tasks"][0]["id"]
        .clone();
    let ready_catalog = f.context.catalog_fn();
    let restore = f.context.restore_fn();
    f.context.set_catalog(|| async {
        Ok(json!({
            "workspaces": [], "errors": ["Offline"],
            "connection_ids": ["local"], "complete_connection_ids": [], "truncated": false,
        }))
    });
    f.context
        .set_restore(|_| async { Err(not_ready("Offline")) });
    f.service.resume().await.unwrap();
    f.advance(1_000).await;
    flush_tasks().await;
    assert!(inputs.lock().unwrap().is_empty());
    assert_eq!(
        f.service
            .task_detail(json!({"task_id": task_id}))
            .await
            .unwrap()["runs"][0]["status"],
        "queued"
    );
    assert_eq!(f.peek()["config"]["allowed_workspaces"], allowed());
    *f.context.catalog.lock().unwrap() = ready_catalog;
    *f.context.restore.lock().unwrap() = Some(restore);
    f.advance(5_000).await;
    flush_tasks().await;
    assert_eq!(inputs.lock().unwrap().len(), 1);
    assert_eq!(
        input_at(&inputs, 0).config()["allowed_workspaces"],
        json!([reference(&other())])
    );
    assert_eq!(
        f.service
            .task_detail(json!({"task_id": task_id}))
            .await
            .unwrap()["runs"][0]["status"],
        "succeeded"
    );
    f.finish().await;
}
