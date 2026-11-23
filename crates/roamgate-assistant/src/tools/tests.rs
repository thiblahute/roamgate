//! tools.test.ts, case for case. JavaScript's `NaN` and `Infinity` have no
//! JSON form: those parameters cannot reach a tool from a model, and the
//! cases keep the ones JSON can carry.

use std::sync::Mutex;
use std::sync::atomic::{AtomicUsize, Ordering};

use serde_json::json;

use super::*;
use crate::wire::ASSISTANT_MAX_WORKSPACES;

type Seen = Arc<Mutex<Vec<(&'static str, Value, bool)>>>;

/// A handler that records its calls and answers `text`.
fn recording(text: &'static str) -> (Handler, Seen) {
    let seen: Seen = Arc::default();
    let log = seen.clone();
    let handler: Handler = Arc::new(move |kind, params, signal| {
        log.lock().unwrap().push((kind, params, signal.is_some()));
        Box::pin(async move { Ok(ToolResult::text(text)) })
    });
    (handler, seen)
}

fn failing(error: AssistantError) -> Handler {
    Arc::new(move |_, _, _| {
        let error = error.clone();
        Box::pin(async move { Err(error) })
    })
}

/// A handler that cancels the turn while it runs, then answers late.
fn cancelling(signal: CancellationToken, count: Arc<AtomicUsize>) -> Handler {
    Arc::new(move |_, _, actual| {
        count.fetch_add(1, Ordering::SeqCst);
        assert!(actual.is_some());
        signal.cancel();
        Box::pin(async { Ok(ToolResult::text("late result")) })
    })
}

fn merge(base: &Value, extra: Value) -> Value {
    let mut map = base.as_object().unwrap().clone();
    for (key, value) in extra.as_object().unwrap() {
        map.insert(key.clone(), value.clone());
    }
    Value::Object(map)
}

async fn message(result: AssistantResult<ToolResult>) -> String {
    result.unwrap_err().to_string()
}

#[tokio::test]
async fn task_tools_validate_the_published_schedule_and_reject_effects_outside_the_schema() {
    let (handle, seen) = recording("Pending preview");
    let proposal = json!({
        "title": "Status",
        "prompt": "Summarize status",
        "scope": [{"connection_id": "local", "workspace_id": "workspace"}],
        "schedule": {"type": "daily", "time": "09:00", "timezone": "UTC"},
    });
    let ok = call_tool(
        Family::Task,
        "propose_ranger_task",
        proposal.clone(),
        &handle,
        None,
    )
    .await
    .unwrap();
    assert_eq!(ok, ToolResult::text("Pending preview"));
    for mode in ["status", "agent"] {
        let params = merge(&proposal, json!({"notification_mode": mode}));
        assert!(
            call_tool(Family::Task, "propose_ranger_task", params, &handle, None)
                .await
                .is_ok()
        );
    }
    for extra in [
        json!({"execute": true}),
        json!({"mentions": []}),
        json!({"agent_identity": "invented-session"}),
        json!({"scope": []}),
        json!({"schedule": {"type": "daily", "time": "25:00", "timezone": "UTC"}}),
        json!({"schedule": {"type": "interval", "minutes": 0}}),
        json!({"notification_mode": "always"}),
        json!({"notification_mode": null}),
    ] {
        let params = merge(&proposal, extra);
        let result = call_tool(Family::Task, "propose_ranger_task", params, &handle, None).await;
        assert_eq!(message(result).await, "Invalid task tool parameters.");
    }
    let result = call_tool(Family::Task, "run_ranger_task", json!({}), &handle, None).await;
    assert_eq!(message(result).await, "Unknown task tool.");
    let signal = CancellationToken::new();
    signal.cancel();
    let result = call_tool(
        Family::Task,
        "list_ranger_tasks",
        json!({}),
        &handle,
        Some(signal),
    )
    .await;
    assert!(message(result).await.starts_with("Task unavailable"));
    assert_eq!(seen.lock().unwrap().len(), 3);
}

#[tokio::test]
async fn task_tool_surfaces_user_facing_errors_and_masks_unexpected_failures() {
    let masked = "Task unavailable, invalid, or outside the authorized scope.";
    let user = failing(AssistantError::user("Choose an authorized task scope."));
    let result = call_tool(Family::Task, "list_ranger_tasks", json!({}), &user, None).await;
    assert_eq!(message(result).await, "Choose an authorized task scope.");
    let leak = failing(AssistantError::internal(
        "backend details include synthetic-private-secret",
    ));
    let error = call_tool(Family::Task, "list_ranger_tasks", json!({}), &leak, None)
        .await
        .unwrap_err();
    assert_eq!(error.to_string(), masked);
    assert!(!format!("{error:?}").contains("synthetic-private-secret"));
}

const MANAGEMENT: [(&str, &str); 5] = [
    ("propose_ranger_task_update", "update"),
    ("propose_ranger_task_pause", "pause"),
    ("propose_ranger_task_resume", "resume"),
    ("propose_ranger_task_cancel", "cancel"),
    ("propose_ranger_task_delete", "delete"),
];

fn management_params(kind: &str) -> Value {
    if kind == "update" {
        json!({"task_id": "task", "title": "Updated status"})
    } else {
        json!({"task_id": "task"})
    }
}

/// `toMatchObject`: every field of `want` is in `got`, recursively.
fn matches(got: &Value, want: &Value) -> bool {
    match (got, want) {
        (Value::Object(g), Value::Object(w)) => w
            .iter()
            .all(|(k, v)| g.get(k).is_some_and(|x| matches(x, v))),
        (Value::Array(g), Value::Array(w)) => {
            g.len() == w.len() && g.iter().zip(w).all(|(x, y)| matches(x, y))
        }
        _ => got == want,
    }
}

#[tokio::test]
async fn task_management_tools_expose_explicit_proposals_and_preserve_callback_results_and_signals()
{
    let names: Vec<String> = tools_of(Family::Task).into_iter().map(|t| t.name).collect();
    let mut expected = vec!["list_ranger_tasks", "propose_ranger_task"];
    expected.extend(MANAGEMENT.iter().map(|(name, _)| *name));
    assert_eq!(names, expected);
    let receipt = r#"{"status":"pending","requires_user_confirmation":true}"#;
    for (name, kind) in MANAGEMENT {
        let tool = tools_of(Family::Task)
            .into_iter()
            .find(|t| t.name == name)
            .unwrap();
        assert!(matches(
            &tool.parameters,
            &json!({
                "type": "object",
                "additionalProperties": false,
                "properties": {"task_id": {"type": "string", "minLength": 1}},
                "required": ["task_id"],
            })
        ));
        let (handle, seen) = recording(receipt);
        let params = management_params(kind);
        let signal = CancellationToken::new();
        let result = call_tool(Family::Task, name, params.clone(), &handle, Some(signal))
            .await
            .unwrap();
        assert_eq!(result.text, receipt);
        let seen = seen.lock().unwrap();
        assert_eq!(seen.len(), 1);
        assert_eq!(seen[0], (kind, params, true));
    }
}

#[tokio::test]
async fn task_management_schemas_reject_missing_targets_authority_changes_and_direct_execution() {
    let (handle, seen) = recording("must not propose");
    for (name, kind) in MANAGEMENT {
        let base = management_params(kind);
        let mut cases = vec![json!(null), json!([]), json!({})];
        for extra in [
            json!({"task_id": ""}),
            json!({"task_id": 123}),
            json!({"task_id": null}),
            json!({"scope": [{"connection_id": "other", "workspace_id": "outside"}]}),
            json!({"model": "other-model"}),
            json!({"mentions": []}),
            json!({"approval_mode": "auto"}),
            json!({"execute": true}),
            json!({"confirmed": true}),
            json!({"expected_revision": "invented"}),
            json!({"enabled": true}),
            json!({"command": "synthetic-command"}),
        ] {
            cases.push(merge(&base, extra));
        }
        if kind != "update" {
            for extra in [
                json!({"title": "Changed"}),
                json!({"prompt": "Changed"}),
                json!({"schedule": {"type": "interval", "minutes": 10}}),
                json!({"notification_mode": "agent"}),
                json!({"force": true}),
            ] {
                cases.push(merge(&base, extra));
            }
        }
        for params in cases {
            let result = call_tool(Family::Task, name, params.clone(), &handle, None).await;
            assert_eq!(
                message(result).await,
                "Invalid task tool parameters.",
                "{name} {params}"
            );
        }
    }
    for name in [
        "update_ranger_task",
        "pause_ranger_task",
        "delete_ranger_task",
        "propose_ranger_task_stop",
    ] {
        let result = call_tool(
            Family::Task,
            name,
            json!({"task_id": "task"}),
            &handle,
            None,
        )
        .await;
        assert_eq!(message(result).await, "Unknown task tool.");
    }
    assert!(seen.lock().unwrap().is_empty());
}

#[tokio::test]
async fn task_update_accepts_only_bounded_editable_fields_and_requires_an_actual_edit() {
    let target = json!({"task_id": "task"});
    let edits = [
        json!({"title": "Updated status"}),
        json!({"prompt": "Summarize only important changes"}),
        json!({"notification_mode": "status"}),
        json!({"notification_mode": "agent"}),
        json!({"schedule": {"type": "once", "at": "2027-10-04T00:00:00Z"}}),
        json!({"schedule": {"type": "interval", "minutes": 1}}),
        json!({"schedule": {"type": "daily", "time": "23:59", "timezone": "UTC"}}),
        json!({"title": "Updated status", "prompt": "Watch for needed input",
               "notification_mode": "agent", "schedule": {"type": "interval", "minutes": 525600}}),
    ];
    let (handle, seen) = recording("Pending preview");
    for edit in &edits {
        let params = merge(&target, edit.clone());
        let result = call_tool(
            Family::Task,
            "propose_ranger_task_update",
            params,
            &handle,
            None,
        )
        .await
        .unwrap();
        assert_eq!(result, ToolResult::text("Pending preview"));
    }
    for edit in [
        json!({}),
        json!({"title": ""}),
        json!({"title": "a".repeat(101)}),
        json!({"title": null}),
        json!({"prompt": ""}),
        json!({"prompt": "a".repeat(32001)}),
        json!({"prompt": false}),
        json!({"notification_mode": "always"}),
        json!({"notification_mode": null}),
        json!({"schedule": {"type": "interval", "minutes": 0}}),
        json!({"schedule": {"type": "interval", "minutes": 1.5}}),
        json!({"schedule": {"type": "interval", "minutes": 525601}}),
        json!({"schedule": {"type": "daily", "time": "24:00", "timezone": "UTC"}}),
        json!({"schedule": {"type": "daily", "time": "09:00", "timezone": ""}}),
        json!({"schedule": {"type": "daily", "time": "09:00", "timezone": "UTC", "cron": "* * * * *"}}),
        json!({"schedule": null}),
    ] {
        let params = merge(&target, edit.clone());
        let result = call_tool(
            Family::Task,
            "propose_ranger_task_update",
            params,
            &handle,
            None,
        )
        .await;
        assert_eq!(
            message(result).await,
            "Invalid task tool parameters.",
            "{edit}"
        );
    }
    let seen = seen.lock().unwrap();
    assert_eq!(seen.len(), edits.len());
    assert!(
        seen.iter()
            .all(|(kind, params, _)| *kind == "update" && params["task_id"] == "task")
    );
}

#[tokio::test]
async fn task_management_cancellations_suppress_callbacks_and_late_receipts_while_failures_stay_private()
 {
    let masked = "Task unavailable, invalid, or outside the authorized scope.";
    for (name, kind) in MANAGEMENT {
        let signal = CancellationToken::new();
        let count = Arc::new(AtomicUsize::new(0));
        let handle = cancelling(signal.clone(), count.clone());
        let params = management_params(kind);
        for _ in 0..2 {
            let result = call_tool(
                Family::Task,
                name,
                params.clone(),
                &handle,
                Some(signal.clone()),
            )
            .await;
            assert_eq!(message(result).await, masked);
        }
        assert_eq!(count.load(Ordering::SeqCst), 1);
        let user = failing(AssistantError::user(
            "Task changed; review a fresh proposal.",
        ));
        let result = call_tool(Family::Task, name, params.clone(), &user, None).await;
        assert_eq!(
            message(result).await,
            "Task changed; review a fresh proposal."
        );
        let leak = failing(AssistantError::internal("synthetic-private-secret"));
        let error = call_tool(Family::Task, name, params, &leak, None)
            .await
            .unwrap_err();
        assert_eq!(error.to_string(), masked);
        assert!(!format!("{error:?}").contains("synthetic-private-secret"));
    }
}

fn notification() -> Value {
    json!({
        "event_key": "agent-session-1:verified-success",
        "kind": "completed",
        "title": "Agent completed the release check",
        "body": "The workspace history confirms the checks passed. Review the result.",
    })
}

#[tokio::test]
async fn notification_tool_accepts_bounded_custom_content_without_model_controlled_destinations() {
    let input = notification();
    let receipt = r#"{"accepted":true,"event_key":"agent-session-1:verified-success"}"#;
    let tools = tools_of(Family::Notification);
    assert_eq!(tools.len(), 1);
    assert!(matches(
        &tools[0].parameters,
        &json!({
            "type": "object",
            "additionalProperties": false,
            "properties": {
                "event_key": {"type": "string", "minLength": 1, "maxLength": 200},
                "title": {"type": "string", "minLength": 1, "maxLength": 200},
                "body": {"type": "string", "minLength": 1, "maxLength": 400},
            },
            "required": ["event_key", "kind", "title", "body"],
        })
    ));
    let (send, seen) = recording(receipt);
    let result = call_tool(
        Family::Notification,
        "send_user_notification",
        input.clone(),
        &send,
        Some(CancellationToken::new()),
    )
    .await
    .unwrap();
    assert_eq!(result.text, receipt);
    assert_eq!(seen.lock().unwrap()[0], ("notify", input.clone(), true));
    let result = call_tool(
        Family::Notification,
        "notify_user",
        input.clone(),
        &send,
        None,
    )
    .await;
    assert_eq!(message(result).await, "Unknown notification tool.");
    let mut cases = vec![json!(null), json!([])];
    for extra in [
        json!({"event_key": ""}),
        json!({"event_key": " "}),
        json!({"event_key": "a".repeat(201)}),
        json!({"kind": "failed"}),
        json!({"title": ""}),
        json!({"title": " "}),
        json!({"title": "a".repeat(201)}),
        json!({"body": ""}),
        json!({"body": " "}),
        json!({"body": "a".repeat(401)}),
        json!({"url": "https://example.com"}),
        json!({"destination": "other-user"}),
        json!({"user_id": "other-user"}),
        json!({"task_id": "other-task"}),
        json!({"run_id": "other-run"}),
        json!({"connection_id": "outside-scope"}),
        json!({"workspace_id": "outside-scope"}),
    ] {
        cases.push(merge(&input, extra));
    }
    for params in cases {
        let result = call_tool(
            Family::Notification,
            "send_user_notification",
            params.clone(),
            &send,
            None,
        )
        .await;
        assert_eq!(
            message(result).await,
            "Invalid notification tool parameters.",
            "{params}"
        );
    }
    assert_eq!(seen.lock().unwrap().len(), 1);
}

#[tokio::test]
async fn notification_cancellation_blocks_sending_and_late_results_while_errors_stay_private() {
    let mut input = notification();
    input["kind"] = json!("attention");
    let masked = "Notification unavailable or outside the authorized task.";
    let signal = CancellationToken::new();
    let count = Arc::new(AtomicUsize::new(0));
    let send = cancelling(signal.clone(), count.clone());
    for _ in 0..2 {
        let result = call_tool(
            Family::Notification,
            "send_user_notification",
            input.clone(),
            &send,
            Some(signal.clone()),
        )
        .await;
        assert_eq!(message(result).await, masked);
    }
    assert_eq!(count.load(Ordering::SeqCst), 1);
    let leak = failing(AssistantError::internal("synthetic-private-secret"));
    let error = call_tool(
        Family::Notification,
        "send_user_notification",
        input,
        &leak,
        None,
    )
    .await
    .unwrap_err();
    assert_eq!(error.to_string(), masked);
    assert!(!format!("{error:?}").contains("synthetic-private-secret"));
}

fn result_with_sources() -> ToolResult {
    ToolResult {
        text: "Read-only workspace context.".into(),
        sources: Some(vec![json!({
            "id": "source-status", "kind": "status", "title": "Status",
            "connection_id": "local", "workspace_id": "workspace",
            "runtime_generation": 1, "read_at": "2026-10-03T00:00:00.000Z",
        })]),
    }
}

#[tokio::test]
async fn the_tool_directory_is_json_schema_and_named_calls_preserve_structured_results() {
    let tools = tools_of(Family::Workspace);
    let names: Vec<&str> = tools.iter().map(|t| t.name.as_str()).collect();
    assert_eq!(
        names,
        [
            "workspace_status",
            "workspace_history",
            "workspace_diff",
            "workspace_terminal"
        ]
    );
    assert!(tools.iter().all(|t| t.parameters["type"] == "object"));
    for (name, kind, params) in [
        ("workspace_status", "status", json!({})),
        ("workspace_history", "history", json!({"pane_id": "pane"})),
        ("workspace_diff", "diff", json!({"path": "src/index.ts"})),
        ("workspace_terminal", "terminal", json!({"pane_id": "pane"})),
    ] {
        let seen: Seen = Arc::default();
        let log = seen.clone();
        let read: Handler = Arc::new(move |kind, params, signal| {
            log.lock().unwrap().push((kind, params, signal.is_some()));
            Box::pin(async { Ok(result_with_sources()) })
        });
        let result = call_tool(
            Family::Workspace,
            name,
            params.clone(),
            &read,
            Some(CancellationToken::new()),
        )
        .await
        .unwrap();
        assert_eq!(result, result_with_sources());
        assert_eq!(seen.lock().unwrap()[0], (kind, params, true));
    }
}

#[tokio::test]
async fn named_calls_reject_unknown_tools_and_parameters_beyond_their_published_capability() {
    let (read, seen) = recording("must not read");
    let result = call_tool(Family::Workspace, "workspace_write", json!({}), &read, None).await;
    assert_eq!(message(result).await, "Unknown workspace tool.");
    for (name, params) in [
        ("workspace_status", json!(null)),
        ("workspace_status", json!([])),
        ("workspace_status", json!({"connection_id": 1})),
        ("workspace_status", json!({"method": "pane.write"})),
        ("workspace_history", json!({})),
        ("workspace_terminal", json!({})),
        (
            "workspace_terminal",
            json!({"pane_id": "pane", "source": "scrollback"}),
        ),
        (
            "workspace_history",
            json!({"pane_id": "pane", "lines": 200}),
        ),
        ("workspace_diff", json!({"path": 123})),
        ("workspace_diff", json!({"mode": "branch-main"})),
        ("workspace_diff", json!({"kind": "branch"})),
        ("workspace_diff", json!({"kind": "last-step"})),
        ("workspace_diff", json!({"kind": "invalid"})),
        ("workspace_diff", json!({"kind": 1})),
        ("workspace_diff", json!({"kind": null})),
        ("workspace_diff", json!({"old_path": "secrets.txt"})),
        ("workspace_diff", json!({"snapshot_id": "snapshot"})),
    ] {
        let result = call_tool(Family::Workspace, name, params.clone(), &read, None).await;
        assert_eq!(
            message(result).await,
            "Invalid workspace tool parameters.",
            "{name} {params}"
        );
    }
    assert!(seen.lock().unwrap().is_empty());
}

#[tokio::test]
async fn terminal_tools_let_the_model_choose_a_bounded_recent_line_window() {
    let tool = tools_of(Family::Workspace)
        .into_iter()
        .find(|t| t.name == "workspace_terminal")
        .unwrap();
    assert!(matches(
        &tool.parameters,
        &json!({
            "properties": {"lines": {"type": "integer", "minimum": 1, "maximum": 1000, "default": 120}},
            "required": ["pane_id"],
        })
    ));
    let reads = Arc::new(AtomicUsize::new(0));
    let count = reads.clone();
    let read: Handler = Arc::new(move |kind, params, _| {
        count.fetch_add(1, Ordering::SeqCst);
        assert_eq!(kind, "terminal");
        let lines = params.get("lines").and_then(Value::as_u64).unwrap_or(120);
        Box::pin(async move { Ok(ToolResult::text(lines.to_string())) })
    });
    for lines in [None, Some(1), Some(500), Some(1000)] {
        let mut params = json!({"pane_id": "pane"});
        if let Some(lines) = lines {
            params["lines"] = json!(lines);
        }
        let result = call_tool(Family::Workspace, &tool.name, params, &read, None)
            .await
            .unwrap();
        assert_eq!(result.text, lines.unwrap_or(120).to_string());
    }
    assert_eq!(reads.load(Ordering::SeqCst), 4);
    for lines in [
        json!(null),
        json!("500"),
        json!(0),
        json!(-1),
        json!(1.5),
        json!(1001),
    ] {
        let params = json!({"pane_id": "pane", "lines": lines});
        let result = call_tool(Family::Workspace, &tool.name, params, &read, None).await;
        assert_eq!(message(result).await, "Invalid workspace tool parameters.");
    }
    assert_eq!(reads.load(Ordering::SeqCst), 4);
}

#[tokio::test]
async fn canceled_calls_do_not_read_or_return_a_late_result_and_preserve_the_reader_signal() {
    let masked = "Context unavailable, stale, or outside the authorized scope.";
    let signal = CancellationToken::new();
    let count = Arc::new(AtomicUsize::new(0));
    let read = cancelling(signal.clone(), count.clone());
    let result = call_tool(
        Family::Workspace,
        "workspace_status",
        json!({}),
        &read,
        Some(signal.clone()),
    )
    .await;
    assert_eq!(message(result).await, masked);
    let (never, seen) = recording("must not read");
    let result = call_tool(
        Family::Workspace,
        "workspace_status",
        json!({}),
        &never,
        Some(signal),
    )
    .await;
    assert_eq!(message(result).await, masked);
    assert!(seen.lock().unwrap().is_empty());
}

#[tokio::test]
async fn reader_errors_expose_only_a_fixed_safe_error() {
    let read = failing(AssistantError::internal(
        "backend details include synthetic-private-secret",
    ));
    let error = call_tool(
        Family::Workspace,
        "workspace_status",
        json!({}),
        &read,
        None,
    )
    .await
    .unwrap_err();
    assert_eq!(
        error.to_string(),
        "Context unavailable, stale, or outside the authorized scope."
    );
    assert!(!format!("{error:?}").contains("synthetic-private-secret"));
}

#[tokio::test]
async fn action_tools_only_return_proposals_through_the_supplied_callback() {
    let names: Vec<String> = tools_of(Family::Action)
        .into_iter()
        .map(|t| t.name)
        .collect();
    assert_eq!(
        names,
        [
            "propose_workspace_create",
            "propose_worktree_create",
            "propose_tab_create",
            "propose_pane_split",
            "propose_agent_start",
            "propose_agent_prompt",
            "propose_workspace_close",
            "propose_pane_close",
            "propose_agent_close",
        ]
    );
    for (name, kind, params) in [
        (
            "propose_workspace_create",
            "create_workspace",
            json!({"label": "Workspace", "cwd": "/tmp/project"}),
        ),
        (
            "propose_worktree_create",
            "create_worktree",
            json!({"branch": "feature", "label": "Worktree"}),
        ),
        (
            "propose_agent_start",
            "start_agent",
            json!({"pane_id": "pane", "agent": "pi"}),
        ),
        ("propose_tab_create", "create_tab", json!({})),
        ("propose_workspace_close", "close_workspace", json!({})),
        (
            "propose_pane_close",
            "close_pane",
            json!({"pane_id": "pane"}),
        ),
        (
            "propose_agent_close",
            "close_agent",
            json!({"pane_id": "pane"}),
        ),
        (
            "propose_pane_split",
            "split_pane",
            json!({"pane_id": "pane", "direction": "right"}),
        ),
        (
            "propose_pane_split",
            "split_pane",
            json!({"pane_id": "pane", "direction": "down"}),
        ),
        (
            "propose_agent_prompt",
            "send_prompt",
            json!({"pane_id": "pane", "prompt": "Review the change."}),
        ),
    ] {
        let args = merge(
            &json!({"connection_id": "local", "workspace_id": "workspace"}),
            params,
        );
        let (propose, seen) = recording("Proposal pending user confirmation.");
        let result = call_tool(
            Family::Action,
            name,
            args.clone(),
            &propose,
            Some(CancellationToken::new()),
        )
        .await
        .unwrap();
        assert_eq!(result.text, "Proposal pending user confirmation.");
        assert_eq!(*seen.lock().unwrap(), vec![(kind, args, true)]);
    }
}

#[tokio::test]
async fn action_schemas_require_explicit_targets_and_reject_commands_environment_and_unknown_parameters()
 {
    let (propose, seen) = recording("must not propose");
    for name in ["workspace_status", "workspace_create"] {
        let result = call_tool(Family::Action, name, json!({}), &propose, None).await;
        assert_eq!(message(result).await, "Unknown action tool.");
    }
    let invalid = "Invalid action tool parameters.";
    for (name, params) in [
        ("propose_workspace_create", json!({"label": "Workspace"})),
        ("propose_worktree_create", json!({"branch": "feature"})),
        ("propose_tab_create", json!({})),
        ("propose_workspace_close", json!({})),
        ("propose_pane_close", json!({"pane_id": "pane"})),
        ("propose_agent_close", json!({"pane_id": "pane"})),
        (
            "propose_pane_split",
            json!({"pane_id": "pane", "direction": "right"}),
        ),
        (
            "propose_agent_start",
            json!({"pane_id": "pane", "agent": "pi"}),
        ),
        (
            "propose_agent_prompt",
            json!({"pane_id": "pane", "prompt": "Review."}),
        ),
    ] {
        for target in [
            json!({}),
            json!({"connection_id": "local"}),
            json!({"workspace_id": "workspace"}),
            json!({"connection_id": 1, "workspace_id": "workspace"}),
        ] {
            let result = call_tool(
                Family::Action,
                name,
                merge(&target, params.clone()),
                &propose,
                None,
            )
            .await;
            assert_eq!(message(result).await, invalid);
        }
        let full = merge(
            &json!({"connection_id": "local", "workspace_id": "workspace"}),
            params.clone(),
        );
        for extra in [
            json!({"command": "touch unexpected"}),
            json!({"shell": "/bin/sh"}),
            json!({"env": {"SECRET": "synthetic"}}),
        ] {
            let result = call_tool(Family::Action, name, merge(&full, extra), &propose, None).await;
            assert_eq!(message(result).await, invalid);
        }
        if name != "propose_tab_create" && name != "propose_workspace_close" {
            let bare = json!({"connection_id": "local", "workspace_id": "workspace"});
            let result = call_tool(Family::Action, name, bare, &propose, None).await;
            assert_eq!(message(result).await, invalid);
        }
    }
    for params in [
        json!(null),
        json!([]),
        json!({"connection_id": "local", "workspace_id": "workspace", "label": 1}),
        json!({"connection_id": "local", "workspace_id": "workspace", "label": "Workspace", "cwd": 1}),
    ] {
        let result = call_tool(
            Family::Action,
            "propose_workspace_create",
            params,
            &propose,
            None,
        )
        .await;
        assert_eq!(message(result).await, invalid);
    }
    assert!(seen.lock().unwrap().is_empty());
}

#[tokio::test]
async fn close_proposals_reject_caller_selected_occupant_identities_forced_effects_and_unrelated_targets()
 {
    let target = json!({"connection_id": "local", "workspace_id": "workspace"});
    let invalid = "Invalid action tool parameters.";
    let (propose, seen) = recording("must not propose");
    for name in [
        "propose_workspace_close",
        "propose_pane_close",
        "propose_agent_close",
    ] {
        let params = if name == "propose_workspace_close" {
            target.clone()
        } else {
            merge(&target, json!({"pane_id": "pane"}))
        };
        for extra in [
            json!({"force": true}),
            json!({"close_group": true}),
            json!({"terminal_id": "terminal"}),
            json!({"agent_identity": "invented-session"}),
            json!({"runtime_generation": 123}),
            json!({"expected_panes": ["pane"]}),
            json!({"tab_id": "tab"}),
            json!({"delete_history": true}),
            json!({"confirm": true}),
            json!({"execute": true}),
        ] {
            let result =
                call_tool(Family::Action, name, merge(&params, extra), &propose, None).await;
            assert_eq!(message(result).await, invalid);
        }
    }
    let result = call_tool(
        Family::Action,
        "propose_workspace_close",
        merge(&target, json!({"pane_id": "pane"})),
        &propose,
        None,
    )
    .await;
    assert_eq!(message(result).await, invalid);
    for name in ["propose_pane_close", "propose_agent_close"] {
        for pane in [json!(null), json!(123), json!(["pane"])] {
            let result = call_tool(
                Family::Action,
                name,
                merge(&target, json!({"pane_id": pane})),
                &propose,
                None,
            )
            .await;
            assert_eq!(message(result).await, invalid);
        }
    }
    assert!(seen.lock().unwrap().is_empty());
}

#[tokio::test]
async fn layout_proposals_use_native_defaults_and_only_explicit_right_or_down_splits() {
    let target = json!({"connection_id": "local", "workspace_id": "workspace"});
    let invalid = "Invalid action tool parameters.";
    let (propose, seen) = recording("must not propose");
    for extra in [
        json!({"label": "Custom tab"}),
        json!({"cwd": "/another/project"}),
        json!({"pane_id": "pane"}),
        json!({"focus": false}),
    ] {
        let result = call_tool(
            Family::Action,
            "propose_tab_create",
            merge(&target, extra),
            &propose,
            None,
        )
        .await;
        assert_eq!(message(result).await, invalid);
    }
    for params in [
        json!({"direction": "right"}),
        json!({"pane_id": "pane"}),
        json!({"pane_id": 1, "direction": "right"}),
        json!({"pane_id": "pane", "direction": "left"}),
        json!({"pane_id": "pane", "direction": "vertical"}),
        json!({"pane_id": "pane", "direction": "down", "terminal_id": "terminal"}),
        json!({"pane_id": "pane", "direction": "right", "tab_id": "tab"}),
    ] {
        let result = call_tool(
            Family::Action,
            "propose_pane_split",
            merge(&target, params),
            &propose,
            None,
        )
        .await;
        assert_eq!(message(result).await, invalid);
    }
    assert!(seen.lock().unwrap().is_empty());
}

#[tokio::test]
async fn action_cancellation_and_callback_failures_expose_only_a_fixed_safe_error() {
    let args = json!({
        "connection_id": "local", "workspace_id": "workspace",
        "pane_id": "pane", "prompt": "Review the change.",
    });
    let masked = "Action proposal unavailable, stale, or outside the authorized scope.";
    let signal = CancellationToken::new();
    let count = Arc::new(AtomicUsize::new(0));
    let propose = cancelling(signal.clone(), count);
    let result = call_tool(
        Family::Action,
        "propose_agent_prompt",
        args.clone(),
        &propose,
        Some(signal.clone()),
    )
    .await;
    assert_eq!(message(result).await, masked);
    let (never, seen) = recording("must not propose");
    let result = call_tool(
        Family::Action,
        "propose_agent_prompt",
        args.clone(),
        &never,
        Some(signal),
    )
    .await;
    assert_eq!(message(result).await, masked);
    assert!(seen.lock().unwrap().is_empty());
    let leak = failing(AssistantError::internal(
        "backend details include synthetic-private-secret",
    ));
    let error = call_tool(Family::Action, "propose_agent_prompt", args, &leak, None)
        .await
        .unwrap_err();
    assert_eq!(error.to_string(), masked);
    assert!(!format!("{error:?}").contains("synthetic-private-secret"));
}

#[tokio::test]
async fn task_tool_scope_schema_shares_the_bounded_workspace_limit() {
    let scope: Vec<Value> = (0..ASSISTANT_MAX_WORKSPACES)
        .map(|index| json!({"connection_id": "local", "workspace_id": format!("w{index}")}))
        .collect();
    let input = json!({
        "title": "Status",
        "prompt": "Summarize status",
        "schedule": {"type": "interval", "minutes": 5},
        "scope": scope,
    });
    let (handle, seen) = recording("Pending");
    let result = call_tool(
        Family::Task,
        "propose_ranger_task",
        input.clone(),
        &handle,
        None,
    )
    .await
    .unwrap();
    assert_eq!(result.text, "Pending");
    let mut over = input;
    over["scope"]
        .as_array_mut()
        .unwrap()
        .push(json!({"connection_id": "local", "workspace_id": "overflow"}));
    let result = call_tool(Family::Task, "propose_ranger_task", over, &handle, None).await;
    assert!(
        message(result)
            .await
            .starts_with("Invalid task tool parameters")
    );
    assert_eq!(seen.lock().unwrap().len(), 1);
}

#[tokio::test]
async fn windows_platform_refusals_reach_the_model_instead_of_the_generic_mask() {
    let target = json!({"connection_id": "windows", "workspace_id": "w1"});
    let refusal = AssistantError::Platform(
        "Ranger worktree creation is unavailable on Windows hosts.".into(),
    );
    let result = call_tool(
        Family::Action,
        "propose_worktree_create",
        merge(&target, json!({"branch": "feature"})),
        &failing(refusal.clone()),
        None,
    )
    .await;
    assert_eq!(result.unwrap_err(), refusal);
    let diff = failing(AssistantError::Platform(
        "Ranger diff read is unavailable on Windows hosts.".into(),
    ));
    let result = call_tool(Family::Workspace, "workspace_diff", target, &diff, None).await;
    assert!(message(result).await.contains("unavailable on Windows"));
    let all: Vec<ToolDef> = tools_of(Family::Workspace)
        .into_iter()
        .chain(tools_of(Family::Action))
        .collect();
    for name in [
        "workspace_history",
        "workspace_diff",
        "propose_worktree_create",
    ] {
        let tool = all.iter().find(|t| t.name == name).unwrap();
        assert!(
            tool.description.contains("remote_platform \"windows\""),
            "{name}"
        );
    }
}

#[tokio::test]
async fn ranger_answers_a_chat_thread_with_its_own_tool_only_when_the_turn_has_one() {
    let (reply, seen) = recording("Answered in thread [abcd1234].");
    let names: Vec<String> = tools_of(Family::Thread)
        .into_iter()
        .map(|t| t.name)
        .collect();
    assert_eq!(names, ["chat_thread_reply"]);
    let params = json!({"comment_id": "abcd1234", "text": "The one in index.ts."});
    let result = call_tool(
        Family::Thread,
        "chat_thread_reply",
        params.clone(),
        &reply,
        None,
    )
    .await
    .unwrap();
    assert_eq!(result, ToolResult::text("Answered in thread [abcd1234]."));
    assert_eq!(seen.lock().unwrap()[0].1, params);
    for params in [
        json!({"comment_id": "abcd1234"}),
        json!({"comment_id": "abcd1234", "text": "   "}),
        json!({"comment_id": "", "text": "x"}),
        json!({"comment_id": "abcd1234", "text": "x", "extra": true}),
    ] {
        let result = call_tool(Family::Thread, "chat_thread_reply", params, &reply, None).await;
        assert_eq!(message(result).await, "Invalid thread tool parameters.");
    }
    // A failure that is not the user's says only that it failed.
    let leak = failing(AssistantError::internal(
        "no such comment in this chat at /secret/path",
    ));
    let result = call_tool(
        Family::Thread,
        "chat_thread_reply",
        json!({"comment_id": "abcd1234", "text": "x"}),
        &leak,
        None,
    )
    .await;
    assert_eq!(
        message(result).await,
        "That thread is not in this chat, or could not be answered."
    );
    seen.lock().unwrap().clear();
    let (read, _) = recording("");
    let handlers = RangerHandlers::reading(read);
    assert!(
        !ranger_tools(&handlers, false)
            .iter()
            .any(|tool| tool.name == "chat_thread_reply")
    );
    let with_threads = RangerHandlers {
        threads: Some(reply),
        ..handlers
    };
    let tool = ranger_tools(&with_threads, false)
        .into_iter()
        .find(|tool| tool.name == "chat_thread_reply")
        .unwrap();
    assert_eq!(tool.replay, Replay::Unsafe);
    assert!(!tool.sequential);
    tool.call(json!({"comment_id": "abcd", "text": "Done."}), None)
        .await
        .unwrap();
    assert_eq!(
        seen.lock().unwrap()[0].1,
        json!({"comment_id": "abcd", "text": "Done."})
    );
    assert!(ranger_system_prompt(false).contains("chat_thread_reply"));
}

/// Every Ranger schema uses only what [`schema::check`] reads, and a turn
/// with every handler lists the catalog's tools in its order, automatic
/// descriptions where the catalog has them.
#[test]
fn the_catalog_tables_are_the_turn_tools() {
    let catalog: Value =
        serde_json::from_str(include_str!("../../../../contract/tools/catalog.json")).unwrap();
    let (handler, _) = recording("");
    let handlers = RangerHandlers {
        read: handler.clone(),
        propose: Some(handler.clone()),
        task: Some(handler.clone()),
        notify: Some(handler.clone()),
        show: Some(handler.clone()),
        arrange: Some(handler.clone()),
        threads: Some(handler.clone()),
        archive: Some(handler),
    };
    for (table, automatic) in [("ranger", false), ("ranger-automatic", true)] {
        let tools = ranger_tools(&handlers, automatic);
        for entry in catalog["tables"][table]["tools"].as_array().unwrap() {
            assert!(
                schema::supported(&entry["input_schema"]),
                "{}",
                entry["name"]
            );
            let tool = tools.iter().find(|t| t.name == entry["name"]).unwrap();
            assert_eq!(tool.description, entry["description"].as_str().unwrap());
            assert_eq!(tool.parameters, entry["input_schema"]);
            assert_eq!(tool.sequential, entry["sequential"].as_bool().unwrap());
            assert_eq!(
                tool.replay == Replay::Safe,
                entry["replay"] == "safe",
                "{}",
                entry["name"]
            );
        }
    }
    let manual: Vec<&str> = catalog["tables"]["ranger"]["tools"]
        .as_array()
        .unwrap()
        .iter()
        .map(|t| t["name"].as_str().unwrap())
        .collect();
    let ours: Vec<String> = ranger_tools(&handlers, false)
        .into_iter()
        .map(|t| t.name)
        .collect();
    assert_eq!(ours, manual);
}
