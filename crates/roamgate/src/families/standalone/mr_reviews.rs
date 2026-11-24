//! What the mr_reviews family asked of the server (index.ts
//! `mr_reviews.*` targets, `mrReviewConnections`, `mrReviewsHost`,
//! `mrReviewsFetch`): the connections a review may use, their host's
//! commands and Herdr, the inbox's forge reads, settings.json's
//! `mr_reviews`, the review service's reviews, the Workspaces tree, an
//! effort's worktree, a model's one answer and the agents' commands.

use std::sync::Arc;
use std::sync::atomic::AtomicBool;
use std::time::Duration;

use roamgate_agents::extract::stable_stringify;
use roamgate_agents::js::Obj;
use roamgate_connections::agent_profiles::store::{
    as_command, command_env, command_for_session, helper_command, profile_for_session,
};
use roamgate_exec::process::Command;
use roamgate_forge::review::cli::truthy;
use roamgate_git::shell::shell_command;
use roamgate_mr_reviews::fetchers::{FetchCall, FetchError, InboxFetchers};
use roamgate_sidecar::family::FamilyContext;
use roamgate_sidecar::protocol::RpcError;
use serde_json::{Value, json};

use super::forge::LocalFetchers;
use super::{Layer, Lease, Target, call, text};

pub(super) const TARGETS: &[(&str, Target)] = &[
    ("mr_reviews.connections", |layer, _, _| {
        Box::pin(async move { Ok(connections(&layer)) })
    }),
    ("mr_reviews.connection", |layer, cx, args| {
        Box::pin(async move { connection(&layer, &cx, &args).await })
    }),
    ("mr_reviews.fetch", |layer, _, args| {
        Box::pin(async move { Ok(fetch(&layer, &args).await) })
    }),
    ("mr_reviews.settings_write", |_, cx, args| {
        Box::pin(async move { settings_write(&cx, &args).await })
    }),
    ("mr_reviews.review", |_, cx, args| {
        Box::pin(async move { review(&cx, &args).await })
    }),
    ("mr_reviews.tree", |_, _, args| {
        Box::pin(async move { tree(&args).await })
    }),
    ("mr_reviews.create_worktree", |layer, _, args| {
        Box::pin(async move { create_worktree(&layer, &args).await })
    }),
    ("mr_reviews.run_model", |_, cx, args| {
        Box::pin(async move { run_model(&cx, &args).await })
    }),
    ("mr_reviews.inference_models", |_, cx, _| {
        Box::pin(async move { inference_models(&cx).await })
    }),
    ("mr_reviews.agent_command", |_, cx, args| {
        Box::pin(async move {
            let session = text(&args, "session_id")
                .ok_or_else(|| RpcError::new("mr_reviews.agent_command needs a session_id"))?;
            let settings = super::super::settings::read_shared(&cx).await;
            let raw = Value::Object(settings.as_map().clone());
            let store = super::conversation::session_profiles();
            let command = command_for_session(Some(session), Some(&raw), Some(&store), &home())
                .map_err(RpcError::new)?;
            Ok(serde_json::to_value(command).unwrap_or(Value::Null))
        })
    }),
];

fn home() -> std::path::PathBuf {
    std::env::var_os("HOME")
        .map(std::path::PathBuf::from)
        .unwrap_or_default()
}

/// `mrReviewConnections()`: the ready connections off Windows, the default
/// first, then this machine's, then the SSH ones.
fn ready_connections(layer: &Layer) -> Vec<(String, String, Lease)> {
    let Some(manager) = layer.host.manager_now() else {
        return Vec::new();
    };
    let entries = manager
        .list()
        .into_iter()
        .filter_map(|status| {
            let lease = manager.ready_runtime_lease(&status.id).ok().flatten()?;
            if lease.runtime.remote_platform().is_some() {
                return None;
            }
            let remote = lease.runtime.ssh_host().is_some();
            Some((status.is_default, remote, (status.id, status.label, lease)))
        })
        .collect();
    roamgate_mr_reviews::clones::order_connections(entries)
}

/// `mr_reviews.connections`: the connections, and the default one.
fn connections(layer: &Layer) -> Value {
    let listed: Vec<Value> = ready_connections(layer)
        .into_iter()
        .map(|(id, label, _)| json!({"id": id, "label": label, "can_launch": true}))
        .collect();
    let default = layer.host.manager_now().and_then(|manager| {
        let status = manager
            .list()
            .into_iter()
            .find(|status| status.is_default)?;
        let ready = manager.ready_runtime(&status.id).is_some();
        Some(json!({"id": status.id, "label": status.label, "ready": ready}))
    });
    json!({"connections": listed, "default": default.unwrap_or(Value::Null)})
}

/// `mr_reviews.connection {connection_id, op, ...}`: a review connection's
/// member.
async fn connection(
    layer: &Arc<Layer>,
    cx: &FamilyContext,
    args: &Value,
) -> Result<Value, RpcError> {
    let id = text(args, "connection_id").unwrap_or("");
    let Some((id, _, lease)) = ready_connections(layer)
        .into_iter()
        .find(|(each, _, _)| each == id)
    else {
        let shown = match args.get("connection_id") {
            Some(Value::String(id)) => id.clone(),
            Some(other) => other.to_string(),
            None => "undefined".into(),
        };
        return Err(RpcError::new(format!(
            "connection not ready: {}",
            roamgate_agents::js::head16(&shown, 80)
        )));
    };
    let needs = |key: &str| {
        text(args, key)
            .map(str::to_owned)
            .ok_or_else(|| RpcError::new(format!("mr_reviews.connection needs {key}")))
    };
    let op = text(args, "op").unwrap_or("");
    match op {
        "run" => {
            let script = needs("script")?;
            let timeout = args
                .get("timeout_ms")
                .and_then(Value::as_f64)
                .map_or(60_000, |ms| ms.max(0.0) as u64);
            let invocation =
                shell_command(&script, lease.runtime.ssh_host()).map_err(RpcError::new)?;
            let git = super::super::workspace::ranger_runtime(&id)
                .map(|runtime| runtime.git().clone())
                .ok_or_else(|| RpcError::new(format!("connection not ready: {id}")))?;
            let ran = git
                .run(invocation, Duration::from_millis(timeout))
                .await
                .map_err(|error| RpcError::new(error.to_string()))?;
            Ok(json!({"code": ran.code, "stdout": ran.stdout, "stderr": ran.stderr}))
        }
        "dirs" => {
            let herdr = lease.runtime.herdr();
            let timeout = roamgate_herdr::control::DEFAULT_CALL_TIMEOUT_MS;
            let (workspaces, panes) = tokio::try_join!(
                herdr.call("workspace.list", json!({}), timeout, None, false),
                herdr.call("pane.list", json!({}), timeout, None, false),
            )
            .map_err(RpcError::new)?;
            let text_of = |value: &Value| value.as_str().unwrap_or("").to_owned();
            let mut dirs = Vec::new();
            for workspace in workspaces["workspaces"].as_array().into_iter().flatten() {
                dirs.push(text_of(&workspace["cwd"]));
                dirs.push(text_of(&workspace["worktree"]["checkout_path"]));
            }
            for pane in panes["panes"].as_array().into_iter().flatten() {
                dirs.push(text_of(&pane["cwd"]));
                dirs.push(text_of(&pane["foreground_cwd"]));
            }
            dirs.retain(|dir| dir.starts_with('/'));
            Ok(json!(dirs))
        }
        "herdr" => {
            let method = needs("method")?;
            let params = args.get("params").cloned().unwrap_or_else(|| json!({}));
            lease
                .runtime
                .herdr()
                .call(
                    &method,
                    params,
                    roamgate_herdr::control::DEFAULT_CALL_TIMEOUT_MS,
                    None,
                    false,
                )
                .await
                .map_err(RpcError::new)
        }
        "launch" => {
            let pane = needs("pane_id")?;
            let spec =
                super::conversation::launch_spec_of(args.get("spec").unwrap_or(&Value::Null));
            let token = super::launch_registry().register(&id, &pane, spec);
            Ok(json!(super::conversation::launch_command(&lease, &token)?))
        }
        "conversation_owned" => {
            let pane = needs("pane_id")?;
            Ok(layer
                .owned_session(&id, &pane)
                .map_or(Value::Null, |session| session["session_id"].clone()))
        }
        "conversation_switch" => {
            let (pane, session) = (needs("pane_id")?, needs("session_id")?);
            call(
                cx,
                "internal.conversation.switch_session",
                json!({"connection_id": id, "pane_id": pane, "session_id": session}),
            )
            .await
        }
        "conversation_prompt" => {
            let (pane, text) = (needs("pane_id")?, needs("text")?);
            Ok(json!(
                super::conversation::prompt(layer, cx, &id, &pane, &text, false, None).await?
            ))
        }
        other => Err(RpcError::new(format!(
            "mr_reviews.connection: unknown op {}",
            roamgate_agents::js::head16(other, 40)
        ))),
    }
}

/// `mr_reviews.fetch {op, ...}`: `{value}` or `{error: {kind?, message}}`.
async fn fetch(layer: &Arc<Layer>, args: &Value) -> Value {
    let fetchers = LocalFetchers {
        layer: layer.clone(),
    };
    let call = args.get("call").and_then(Value::as_object).map(|call| {
        let word = |key: &str| {
            call.get(key)
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_owned()
        };
        FetchCall {
            feature: word("feature"),
            kind: word("kind"),
            reuse_ms: call
                .get("reuseMs")
                .and_then(Value::as_f64)
                .map(|ms| ms as u64),
        }
    });
    let call = call.unwrap_or_else(FetchCall::inbox);
    let js_text = |key: &str| match args.get(key) {
        Some(Value::String(text)) => text.clone(),
        Some(other) => roamgate_agents::js::to_text(other),
        None => "undefined".into(),
    };
    let item = || {
        args.get("item")
            .and_then(Value::as_object)
            .cloned()
            .unwrap_or_default()
    };
    let answer = match text(args, "op").unwrap_or("") {
        "gitlab" => {
            fetchers
                .gitlab(&js_text("host"), &js_text("query"), &call)
                .await
        }
        "github" => {
            fetchers
                .github(&js_text("host"), &js_text("query"), &call)
                .await
        }
        "gitlab_drafts" => {
            let item: Obj = item();
            fetchers
                .gitlab_drafts(&item)
                .await
                .map(|count| json!(count))
        }
        "gitlab_label_events" => {
            let item: Obj = item();
            match fetchers.gitlab_label_events(&item) {
                Some(asked) => asked.await.map(Value::Object),
                None => Err(FetchError::Failed("no label events here".into())),
            }
        }
        other => Err(FetchError::Failed(format!(
            "mr_reviews.fetch: unknown op {}",
            roamgate_agents::js::head16(other, 40)
        ))),
    };
    match answer {
        Ok(value) => json!({"value": value}),
        // `{...kind, message}`: the kind first, as Bun wrote it.
        Err(error) => json!({"error": match &error {
            FetchError::NotSignedIn(_) => {
                json!({"kind": "not_signed_in", "message": error.message()})
            }
            FetchError::ToolMissing(_) => {
                json!({"kind": "tool_missing", "message": error.message()})
            }
            FetchError::Failed(_) => json!({"message": error.message()}),
        }}),
    }
}

/// `mr_reviews.settings_write {expect, mr_reviews}`: written only over
/// what the core read, else it reads again.
async fn settings_write(cx: &FamilyContext, args: &Value) -> Result<Value, RpcError> {
    let Some(next) = args.get("mr_reviews").filter(|value| value.is_object()) else {
        return Err(RpcError::new("mr_reviews.settings_write needs mr_reviews"));
    };
    let expect = stable_stringify(args.get("expect").unwrap_or(&Value::Null));
    let written = AtomicBool::new(false);
    let settings = super::super::settings::update_shared(
        cx,
        json!({"method": "mr_reviews.settings_write"}),
        |current| {
            let held = current
                .as_map()
                .get("mr_reviews")
                .cloned()
                .unwrap_or(Value::Null);
            if stable_stringify(&held) != expect {
                return None;
            }
            written.store(true, std::sync::atomic::Ordering::SeqCst);
            let mut map = current.as_map().clone();
            map.insert("mr_reviews".into(), next.clone());
            Some(Value::Object(map))
        },
    )
    .await?;
    Ok(json!({
        "written": written.load(std::sync::atomic::Ordering::SeqCst),
        "mr_reviews": settings.as_map().get("mr_reviews").cloned().unwrap_or_else(|| json!({})),
    }))
}

/// `internal.review.call {method, params}`: the core's review service.
async fn reviews(cx: &FamilyContext, method: &str, params: Value) -> Result<Value, RpcError> {
    call(
        cx,
        "internal.review.call",
        json!({"method": method, "params": params}),
    )
    .await
}

/// `mr_reviews.review {op, params}` (`mrReviewsHost`'s reviews).
async fn review(cx: &FamilyContext, args: &Value) -> Result<Value, RpcError> {
    let given = args.get("params").cloned().unwrap_or_else(|| json!({}));
    let field = |key: &str| given.get(key).cloned().unwrap_or(Value::Null);
    let present = |out: &mut Value, key: &str| {
        if let Some(value) = given.get(key).filter(|value| !value.is_null()) {
            out[key] = value.clone();
        }
    };
    let truthy = |key: &str| given.get(key).is_some_and(|value| truthy(Some(value)));
    match text(args, "op").unwrap_or("") {
        "open" => {
            let mut params = json!({
                "connectionId": field("connectionId"),
                "workspaceId": field("workspaceId"),
                "root": field("root"),
                "target": {"kind": "mr", "url": field("url")},
                "title": field("title"),
            });
            if truthy("paneId") {
                params["paneId"] = field("paneId");
                params["agent"] = json!("Claude");
            }
            params["raise"] = json!(false);
            reviews(cx, "open", params).await
        }
        "open_range" => {
            let mut target = json!({"kind": "range", "base": field("base"), "head": field("head")});
            if truthy("compare") {
                target["compare"] = field("compare");
            }
            let params = json!({
                "connectionId": field("connectionId"),
                "workspaceId": field("workspaceId"),
                "root": field("root"),
                "target": target,
                "title": field("title"),
                "raise": false,
            });
            let snapshot = reviews(cx, "open", params).await?;
            Ok(json!({"sessionId": snapshot["session"]["id"], "snapshot": snapshot}))
        }
        "request" => {
            let mut params = json!({
                "sessionId": field("sessionId"),
                "paneId": field("paneId"),
                "agent": "Claude",
            });
            if truthy("focus") {
                present(&mut params, "focus");
            }
            reviews(cx, "requestAgentReview", params).await?;
            Ok(json!({"ok": true}))
        }
        "remove" => {
            let session = match given.get("sessionId") {
                None | Some(Value::Null) => String::new(),
                Some(Value::String(id)) => id.clone(),
                Some(other) => roamgate_agents::js::to_text(other),
            };
            reviews(cx, "remove", json!({"sessionId": session})).await?;
            Ok(json!({"ok": true}))
        }
        "effort" => {
            let effort = field("effort");
            let listed = reviews(cx, "list", json!({"chats": true})).await?;
            // Listed newest first; wherever it was opened.
            let found = listed.as_array().into_iter().flatten().find(|snapshot| {
                let target = &snapshot["session"]["target"];
                target["kind"] == "effort" && target["effort"] == effort
            });
            if let Some(found) = found {
                return Ok(found.clone());
            }
            if !truthy("open") {
                return Ok(Value::Null);
            }
            let params = json!({
                "connectionId": field("connectionId"),
                "workspaceId": field("workspaceId"),
                "root": field("root"),
                "target": {"kind": "effort", "effort": effort},
                "title": field("title"),
                "agent": "Claude",
                "raise": false,
            });
            reviews(cx, "open", params).await
        }
        other => Err(RpcError::new(format!(
            "mr_reviews.review: unknown op {}",
            roamgate_agents::js::head16(other, 40)
        ))),
    }
}

/// `mr_reviews.tree {op: read}` or `{op: apply, ops}`: the Workspaces
/// arrangement the workspace family keeps.
async fn tree(args: &Value) -> Result<Value, RpcError> {
    match (text(args, "op"), args.get("ops").and_then(Value::as_array)) {
        (Some("read"), _) => super::super::workspace::tree_read()
            .await
            .map_err(RpcError::new),
        (Some("apply"), Some(ops)) => {
            super::super::workspace::tree_apply(ops.clone())
                .await
                .map_err(|(message, _)| RpcError::new(message))?;
            Ok(json!({"ok": true}))
        }
        _ => Err(RpcError::new(
            "mr_reviews.tree needs op read, or apply with ops",
        )),
    }
}

/// `mr_reviews.create_worktree {params}`: an effort's part, the same
/// worktree path as the workspace menu's, never an existing checkout.
async fn create_worktree(layer: &Layer, args: &Value) -> Result<Value, RpcError> {
    let given = args.get("params").cloned().unwrap_or_else(|| json!({}));
    let id = text(&given, "connectionId").unwrap_or("");
    let not_ready = || RpcError::new("this connection is not ready");
    if layer
        .host
        .manager_now()
        .and_then(|m| m.ready_runtime(id))
        .is_none()
    {
        return Err(not_ready());
    }
    let runtime = super::super::workspace::ranger_runtime(id).ok_or_else(not_ready)?;
    let mut params = json!({});
    match given.get("workspaceId").filter(|id| truthy(Some(id))) {
        Some(workspace) => params["workspace_id"] = workspace.clone(),
        None => params["cwd"] = given.get("cwd").cloned().unwrap_or(Value::Null),
    }
    params["branch"] = given.get("branch").cloned().unwrap_or(Value::Null);
    params["focus"] = json!(false);
    let result = runtime
        .create_part(&params)
        .await
        .map_err(|error| RpcError::new(error.message))?;
    let path = [
        &result["worktree"]["path"],
        &result["worktree"]["checkout_path"],
        &result["workspace"]["worktree"]["checkout_path"],
        &result["workspace"]["cwd"],
    ]
    .into_iter()
    .find(|value| truthy(Some(value)))
    .cloned()
    .unwrap_or(Value::Null);
    let Some(path) = path.as_str().filter(|path| !path.is_empty()) else {
        return Err(RpcError::new(
            "the worktree was made but its path is unknown",
        ));
    };
    let mut out = json!({"path": path});
    if let Some(workspace) = result["workspace"]["workspace_id"].as_str() {
        out["workspaceId"] = json!(workspace);
    }
    Ok(out)
}

/// How long one model answer may take (curation.ts TIMEOUT_MS).
const MODEL_TIMEOUT: Duration = Duration::from_secs(180);

/// `mr_reviews.run_model {model, system, prompt}` (curation.ts
/// `runClaudeModel`): one answer of a bare headless Claude.
async fn run_model(cx: &FamilyContext, args: &Value) -> Result<Value, RpcError> {
    let (Some(model), Some(system), Some(prompt)) = (
        text(args, "model"),
        text(args, "system"),
        text(args, "prompt"),
    ) else {
        return Err(RpcError::new(
            "mr_reviews.run_model needs a model, system and prompt",
        ));
    };
    let started = cx.clock.now();
    let settings = super::super::settings::read_shared(cx).await;
    let raw = Value::Object(settings.as_map().clone());
    static WARNED: AtomicBool = AtomicBool::new(false);
    let log = super::logger(&cx.clock, "bridge");
    let helper = helper_command(None, Some(&raw), &home(), &WARNED, |error| {
        log.info(
            "the default profile cannot be used; helpers run plain claude",
            Some(&super::fields(json!({"error": error}))),
        );
    });
    let command = as_command(Some(&helper));
    let base: indexmap::IndexMap<String, String> =
        roamgate_claude::background::background_claude_env(std::env::vars())
            .into_iter()
            .collect();
    let env = command_env(&command, &base);
    let mut process = Command::new([
        command.program.clone(),
        "-p".into(),
        "--model".into(),
        model.to_owned(),
        "--output-format".into(),
        "json".into(),
        "--tools".into(),
        String::new(),
        "--safe-mode".into(),
        "--strict-mcp-config".into(),
        "--no-session-persistence".into(),
        "--system-prompt".into(),
        system.to_owned(),
    ])
    .cwd(std::env::temp_dir())
    .env_clear()
    .stdin(prompt.as_bytes().to_vec())
    .timeout(MODEL_TIMEOUT);
    for (key, value) in env {
        process = process.env(key, value);
    }
    let output = roamgate_exec::process::ProcessRunner::new(cx.clock.clone())
        .run(&process)
        .await
        .map_err(|error| RpcError::new(error.to_string()))?;
    let (stdout, stderr) = (output.stdout_text(), output.stderr_text());
    if output.code != 0 {
        let said = if stderr.is_empty() { &stdout } else { &stderr };
        let said = roamgate_agents::js::trim(said);
        let tail: String = {
            let units: Vec<u16> = said.encode_utf16().collect();
            let from = units.len().saturating_sub(300);
            String::from_utf16_lossy(&units[from..])
        };
        return Err(RpcError::new(format!(
            "claude exited {}: {tail}",
            output.code
        )));
    }
    let answer: Value =
        serde_json::from_str(&stdout).map_err(|error| RpcError::new(error.to_string()))?;
    let result_text = |value: &Value| match value {
        Value::Null => None,
        Value::String(text) => Some(text.clone()),
        other => Some(roamgate_agents::js::to_text(other)),
    };
    if truthy(Some(&answer["is_error"])) {
        let said = result_text(&answer["result"]).unwrap_or_else(|| "error".into());
        return Err(RpcError::new(roamgate_agents::js::head16(&said, 300)));
    }
    let mut out = json!({"text": result_text(&answer["result"]).unwrap_or_default()});
    if let Some(cost) = answer["total_cost_usd"].as_f64() {
        out["costUsd"] = json!(cost);
    }
    out["ms"] = json!(cx.clock.now() - started);
    Ok(out)
}

/// `mr_reviews.inference_models`: the default profile's automatic model
/// and its models (its server's list, or Claude's aliases).
async fn inference_models(cx: &FamilyContext) -> Result<Value, RpcError> {
    let settings = super::super::settings::read_shared(cx).await;
    let raw = Value::Object(settings.as_map().clone());
    let profile = profile_for_session(Some(&raw), None, None);
    let automatic = roamgate_mr_reviews::inference::profile_inference_model(
        profile.get("env").and_then(Value::as_object),
    );
    let models = super::conversation::discovery()
        .models(&profile, false)
        .await;
    Ok(json!({
        "automatic": automatic,
        "models": models.get("models").cloned().unwrap_or_else(|| json!([])),
    }))
}
