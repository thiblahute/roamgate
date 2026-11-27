//! What the review family asked of the server (index.ts
//! `reviewReverseTargets`): the agent socket's host (`review.socket`,
//! `reviewAgentHost`), the review service's git reads, agent panes and
//! sessions (`review.host`, `reviewServiceHost`), the forge of merge
//! requests (`review.forge`), a browser connection's reads
//! (`review.connection`, `reviewRpcConnection`), and what a push of the
//! service did besides the browsers (`review.published`).

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, LazyLock, Mutex};
use std::time::Duration;

use roamgate_channel::family::FamilyContext;
use roamgate_channel::protocol::RpcError;
use roamgate_conversation::pane_child::{Form, parse_holder_status};
use roamgate_conversation::suspended::{parse_holder_shell, parse_suspended_spec};
use roamgate_forge::review::gitlab::{
    read_commit_diff, read_merge_request, read_merge_request_commits, read_merge_request_diff,
    read_raw_file,
};
use roamgate_forge::review::{ForgeContext, MergeRequestForge};
use roamgate_git::review::Target;
use roamgate_git::review_files::{FileRequest, SummaryOf, read_review_files, read_review_summary};
use roamgate_git::review_patch::{
    read_default_base, read_review_commit_patch, read_review_commits, read_review_file,
    read_review_heads, read_review_patch, read_review_patch_ids, read_review_root,
    read_review_state, scan_review_repos,
};
use roamgate_git::{GitContext, GitError};
use roamgate_review::model::ReviewSession;
use roamgate_review::service::{LoadError, ReviewForge};
use roamgate_workspace::tree::store::{
    GroupPlacement, agent_group_paths, agent_group_placement_ops,
};
use roamgate_workspace::tree::workspace_ref_for;
use serde::Serialize;
use serde_json::{Value, json};

use super::{Layer, Lease, Target as Reverse, call, fields, logger, text};

pub(super) const TARGETS: &[(&str, Reverse)] = &[
    ("review.socket", |layer, cx, args| {
        Box::pin(async move { socket(&layer, &cx, &args).await })
    }),
    ("review.host", |layer, cx, args| {
        Box::pin(async move { host(&layer, &cx, &args).await })
    }),
    ("review.forge", |layer, _, args| {
        Box::pin(async move { forge(&layer, &args).await })
    }),
    ("review.connection", |layer, cx, args| {
        Box::pin(async move { connection(&layer, &cx, &args).await })
    }),
    ("review.published", |layer, cx, args| {
        Box::pin(async move {
            published(&layer, &cx, &args);
            Ok(json!({}))
        })
    }),
];

/// A review error as Bun's channel carried it: its status in `data`.
fn status_error(message: impl Into<String>, status: u16) -> RpcError {
    let mut error = RpcError::new(message);
    error.data = Some(json!({"status": status}));
    error
}

/// `new ReviewError(message)`: status 400.
fn review_error(message: impl Into<String>) -> RpcError {
    status_error(message, 400)
}

fn not_ready() -> RpcError {
    status_error("this connection is not ready", 503)
}

/// `argText`: a string, else "".
fn arg(args: &Value, key: &str) -> String {
    text(args, key).unwrap_or("").to_owned()
}

/// A git read's error as Bun threw it: a gone checkout with its code.
fn git_error(error: GitError) -> RpcError {
    match error {
        GitError::Gone { code, message } => RpcError::with_code(message, code.as_str()),
        GitError::Message(message) => RpcError::new(message),
    }
}

fn to_json<T: Serialize>(value: T) -> Result<Value, RpcError> {
    serde_json::to_value(value).map_err(|error| RpcError::new(error.to_string()))
}

/// The ready connections the agent socket serves (`reviewAgentHost`'s
/// `connections`): none of a Windows host.
fn socket_connections(layer: &Layer) -> Vec<Lease> {
    let Some(manager) = layer.host.manager_now() else {
        return Vec::new();
    };
    manager
        .list()
        .into_iter()
        .filter_map(|status| manager.ready_runtime_lease(&status.id).ok().flatten())
        .filter(|lease| lease.runtime.remote_platform().is_none())
        .collect()
}

/// A connection's git, on its host (`runtime.files`'s).
fn git_of(id: &str) -> Result<GitContext, RpcError> {
    super::super::workspace::ranger_runtime(id)
        .map(|runtime| runtime.git().clone())
        .ok_or_else(|| RpcError::new(format!("connection not ready: {id}")))
}

/// `resolveReadyConnection(...).runtime`: the ready runtime of `id`.
fn runtime_of(layer: &Layer, id: &str) -> Result<Lease, RpcError> {
    layer
        .ready(id)?
        .ok_or_else(|| RpcError::new(format!("connection not ready: {id}")))
}

// ---- review.socket ----

/// `review.socket {op, input}`: what the agent socket asks of the rest
/// of the server. A failure carries its status.
async fn socket(layer: &Arc<Layer>, cx: &FamilyContext, args: &Value) -> Result<Value, RpcError> {
    let input = args.get("input").cloned().unwrap_or_else(|| json!({}));
    let connection_id = arg(&input, "connectionId");
    let pane_id = arg(&input, "paneId");
    let form = || form_of(&input);
    let connection = || {
        socket_connections(layer)
            .into_iter()
            .find(|lease| lease.connection_id == connection_id)
            .ok_or_else(not_ready)
    };
    let runtime = || {
        layer
            .ready(&connection_id)
            .ok()
            .flatten()
            .ok_or_else(not_ready)
    };
    let op = text(args, "op").unwrap_or("");
    match op {
        "connections" => Ok(Value::Array(
            socket_connections(layer)
                .iter()
                .map(|lease| {
                    let mut out = json!({
                        "id": lease.connection_id,
                        "herdrSocketPath": lease.runtime.config().socket_path,
                    });
                    if let Some(host) = lease.runtime.ssh_host() {
                        out["sshHost"] = json!(host);
                    }
                    out["lastSteps"] = json!(true);
                    out
                })
                .collect(),
        )),
        "readRoot" => {
            let lease = connection()?;
            let git = git_of(&lease.connection_id)?;
            Ok(json!(
                read_review_root(&git, &arg(&input, "path"))
                    .await
                    .map_err(git_error)?
            ))
        }
        "readDefaultBase" => {
            let lease = connection()?;
            let git = git_of(&lease.connection_id)?;
            Ok(json!(
                read_default_base(&git, &arg(&input, "root"))
                    .await
                    .map_err(git_error)?
            ))
        }
        "readLastStep" => {
            let lease = connection()?;
            let Some(runtime) = super::super::workspace::ranger_runtime(&lease.connection_id)
            else {
                return Ok(Value::Null);
            };
            Ok(runtime
                .last_step(&arg(&input, "root"), &arg(&input, "workspaceId"))
                .await
                .unwrap_or(Value::Null))
        }
        "hasViewers" => Ok(json!(!layer.clients.is_empty())),
        "notify" => {
            notify_from_agent(layer, cx, &input).await;
            Ok(json!({}))
        }
        "workspaces" => workspaces_from_agent(layer, &input).await,
        "reviews" => {
            let caller = agent_caller(layer, &input).await;
            let answer = call(
                cx,
                "internal.mr_reviews.board_tool",
                json!({"tool": input["tool"], "params": input["params"], "caller": caller}),
            )
            .await?;
            Ok(answer.get("text").cloned().unwrap_or(Value::Null))
        }
        "work" => {
            let caller = agent_caller(layer, &input).await;
            let mut params =
                json!({"tool": input["tool"], "params": input["params"], "caller": caller});
            if !pane_id.is_empty() {
                params["address"] = json!(format!("{connection_id}/{pane_id}"));
            }
            let answer = call(cx, "internal.work.tool", params).await?;
            Ok(answer.get("text").cloned().unwrap_or(Value::Null))
        }
        "messagesList" => Ok(Value::Array(
            super::connections::messenger(layer, cx).list().await,
        )),
        "messagesSend" => {
            let from = &input["from"];
            super::connections::messenger(layer, cx)
                .send(
                    (
                        from["connectionId"].as_str().unwrap_or(""),
                        from["paneId"].as_str().unwrap_or(""),
                    ),
                    input["to"].as_str().unwrap_or(""),
                    input["text"].as_str().unwrap_or(""),
                )
                .await
                .map_err(|error| status_error(error.message, error.status))
        }
        "claudeStart" => claude_start(layer, cx, &input).await,
        "launch" => Ok(super::launch_registry()
            .take(&connection_id, &pane_id, &arg(&input, "token"))
            .map_or(Value::Null, |spec| {
                serde_json::to_value(spec).unwrap_or(Value::Null)
            })),
        "hold" => {
            runtime()?;
            let form = form();
            let session = arg(&input, "sessionId");
            let mut params = json!({
                "connection_id": connection_id,
                "pane_id": pane_id,
                "session_id": session,
            });
            holder_form(&mut params, &form);
            match call(cx, "internal.conversation.holder_hold", params).await {
                Ok(answer) => Ok(answer),
                // The core went (a stop, a restart): the holder keeps
                // holding and polls again a moment later.
                Err(_) => {
                    tokio::time::sleep(Duration::from_secs(1)).await;
                    Ok(json!({"action": "hold", "session_id": session}))
                }
            }
        }
        "fg" => {
            let form = form();
            let spec = parse_suspended_spec(&form)
                .ok_or_else(|| review_error("invalid stopped session"))?;
            runtime()?;
            let mut spec_json = json!({
                "session_id": spec.session_id,
                "cwd": spec.cwd,
                "terminal_args": spec.terminal_args,
            });
            if let Some(agent) = spec.agent {
                spec_json["agent"] = json!(agent);
            }
            let mut params = json!({
                "connection_id": connection_id,
                "pane_id": pane_id,
                "spec": spec_json,
            });
            holder_form(&mut params, &form);
            call(cx, "internal.conversation.holder_fg", params).await
        }
        "holdOutput" => {
            runtime()?;
            call(
                cx,
                "internal.conversation.holder_output",
                json!({
                    "connection_id": connection_id,
                    "pane_id": pane_id,
                    "holder_id": input["holderId"],
                    "offset": input["offset"],
                    "end": input["end"],
                    "data": input["data"],
                }),
            )
            .await
        }
        "handback" => {
            runtime()?;
            call(
                cx,
                "internal.conversation.holder_handback",
                json!({"connection_id": connection_id, "pane_id": pane_id}),
            )
            .await
        }
        "mod" => {
            let hub = super::super::claude_mod::current()
                .ok_or_else(|| status_error("the Claude mod hub is not running", 503))?;
            let mut form = roamgate_review::agent_socket::Form::default();
            for (key, value) in input["form"].as_object().into_iter().flatten() {
                form.set(key, roamgate_agents::js::to_text(value));
            }
            roamgate_review::agent_socket::ClaudeMods::request(
                &hub,
                connection_id,
                arg(&input, "command"),
                form,
            )
            .await
            .map_err(|error| {
                let mut out = status_error(error.message, error.status);
                out.code = error.code;
                out
            })
        }
        other => Err(review_error(format!("unknown review socket op {other}"))),
    }
}

/// The holder's request form (`new URLSearchParams(input.form)`).
fn form_of(input: &Value) -> Form {
    let pairs: Vec<(String, String)> = input["form"]
        .as_object()
        .into_iter()
        .flatten()
        .map(|(key, value)| (key.clone(), roamgate_agents::js::to_text(value)))
        .collect();
    let borrowed: Vec<(&str, &str)> = pairs
        .iter()
        .map(|(key, value)| (key.as_str(), value.as_str()))
        .collect();
    Form::from_pairs(&borrowed)
}

/// What a holder says of itself and its shell, as Bun's socket parsed it
/// (`parseHolderStatus`, `parseHolderShell`), for conversation mode.
fn holder_form(params: &mut Value, form: &Form) {
    if let Some(status) = parse_holder_status(form) {
        let mut out = json!({
            "holderId": status.holder_id,
            "applied": status.applied,
            "child": status.child,
            "childAlive": status.child_alive,
            "childPid": status.child_pid,
            "logSize": status.log_size,
            "epochOffset": status.epoch_offset,
        });
        if let Some(key) = status.api_key {
            out["apiKey"] = json!(key.as_str());
        }
        params["status"] = out;
    }
    if let Some(shell) = parse_holder_shell(form) {
        let mut out = json!({"jobControl": shell.job_control});
        if let Some(pid) = shell.pid {
            out["pid"] = json!(pid);
        }
        if let Some(job) = shell.job {
            out["job"] = json!(job);
        }
        params["shell"] = out;
    }
}

/// `agentWorkspaceLabel`: an agent's workspace as the user knows it.
async fn workspace_label(layer: &Layer, connection_id: &str, workspace_id: &str) -> String {
    let fallback = "a session".to_owned();
    if workspace_id.is_empty() {
        return fallback;
    }
    let Some(lease) = layer.ready(connection_id).ok().flatten() else {
        return fallback;
    };
    let Ok(listed) = lease
        .runtime
        .herdr()
        .call(
            "workspace.list",
            json!({}),
            roamgate_herdr::control::DEFAULT_CALL_TIMEOUT_MS,
            None,
            false,
        )
        .await
    else {
        return fallback;
    };
    listed["workspaces"]
        .as_array()
        .into_iter()
        .flatten()
        .find(|each| each["workspace_id"] == workspace_id)
        .and_then(|found| found["label"].as_str())
        .map(roamgate_agents::js::trim)
        .filter(|label| !label.is_empty())
        .map(|label| roamgate_agents::js::head16(label, 60))
        .unwrap_or(fallback)
}

/// `${agent || "Claude"} in <its workspace>`.
async fn agent_caller(layer: &Layer, input: &Value) -> String {
    let agent = input["agent"].as_str().filter(|agent| !agent.is_empty());
    let label = workspace_label(
        layer,
        input["connectionId"].as_str().unwrap_or(""),
        input["workspaceId"].as_str().unwrap_or(""),
    )
    .await;
    format!("{} in {label}", agent.unwrap_or("Claude"))
}

/// A claude started by hand in a pane: the claude start setting says
/// whether conversation mode takes it.
async fn claude_start(layer: &Layer, cx: &FamilyContext, input: &Value) -> Result<Value, RpcError> {
    let connection = arg(input, "connectionId");
    let pane = arg(input, "paneId");
    if layer.ready(&connection).ok().flatten().is_none() {
        return Ok(json!({"action": "terminal", "reason": "this connection is not ready"}));
    }
    let settings = super::super::settings::read_shared(cx).await;
    if settings.claude_start_mode() != "conversation" {
        return Ok(json!({"action": "terminal", "reason": "the setting says terminal"}));
    }
    let started = call(
        cx,
        "internal.conversation.auto_start",
        json!({"connection_id": connection, "pane_id": pane, "session_id": arg(input, "sessionId")}),
    )
    .await?;
    let ok = started["ok"] == true;
    let mut line = json!({
        "connection": connection,
        "pane": pane,
        "source": input.get("source").cloned().unwrap_or(Value::Null),
        "taken": ok,
    });
    if !ok {
        line["reason"] = started["reason"].clone();
    }
    logger(&cx.clock, "bridge").info("claude started in a pane", Some(&fields(line)));
    Ok(if ok {
        json!({"action": "conversation"})
    } else {
        json!({"action": "terminal", "reason": started["reason"]})
    })
}

/// A pane's workspace and its label, for a notification; empty on
/// errors (`paneWorkspace`).
async fn pane_workspace(layer: &Layer, connection: &str, pane: &str) -> (Value, Option<String>) {
    let Some(lease) = layer.ready(connection).ok().flatten() else {
        return (Value::Null, None);
    };
    let herdr = lease.runtime.herdr();
    let timeout = roamgate_herdr::control::DEFAULT_CALL_TIMEOUT_MS;
    let Ok((panes, workspaces)) = tokio::try_join!(
        herdr.call("pane.list", json!({}), timeout, None, false),
        herdr.call("workspace.list", json!({}), timeout, None, false),
    ) else {
        return (Value::Null, None);
    };
    let found = panes["panes"]
        .as_array()
        .into_iter()
        .flatten()
        .find(|each| each["pane_id"] == pane)
        .cloned()
        .unwrap_or(Value::Null);
    let label = workspaces["workspaces"]
        .as_array()
        .into_iter()
        .flatten()
        .find(|each| {
            !found["workspace_id"].is_null() && each["workspace_id"] == found["workspace_id"]
        })
        .and_then(|each| each["label"].as_str())
        .filter(|label| !label.is_empty())
        .map(str::to_owned);
    (found, label)
}

/// The task of a "blocked" notification on a pane.
fn pane_task(
    connection: &str,
    generation: u64,
    pane_id: &str,
    pane: &Value,
    label: Option<&str>,
    agent: &str,
) -> Value {
    let mut task = json!({
        "kind": "blocked",
        "connectionId": connection,
        "runtimeGeneration": generation,
        "paneId": pane_id,
    });
    for (key, from) in [("workspaceId", "workspace_id"), ("tabId", "tab_id")] {
        if let Some(value) = pane[from].as_str().filter(|value| !value.is_empty()) {
            task[key] = json!(value);
        }
    }
    if let Some(label) = label {
        task["workspaceLabel"] = json!(label);
    }
    task["agent"] = json!(agent);
    task
}

fn generation_of(layer: &Layer, connection: &str) -> Option<u64> {
    layer
        .host
        .manager_now()?
        .list()
        .into_iter()
        .find(|status| status.id == connection)
        .map(|status| status.generation)
}

/// An agent saying the user needs to act (`notifyFromAgent`): kept with
/// the agent until the user looks, pushed to their devices, and the open
/// pages told to read their agents again.
async fn notify_from_agent(layer: &Layer, cx: &FamilyContext, input: &Value) {
    let connection = arg(input, "connectionId");
    let pane = arg(input, "paneId");
    let agent = arg(input, "agent");
    let title = text(input, "title").filter(|title| !title.is_empty());
    let body = arg(input, "text");
    let mut note = json!({"connection_id": connection, "pane_id": pane, "text": body});
    if let Some(title) = title {
        note["title"] = json!(title);
    }
    super::tell(cx, "internal.agent_sessions.note", note);
    let generation = generation_of(layer, &connection);
    let (found, label) = pane_workspace(layer, &connection, &pane).await;
    if let Some(generation) = generation {
        let mut task = pane_task(
            &connection,
            generation,
            &pane,
            &found,
            label.as_deref(),
            &agent,
        );
        task["title"] = json!(format!(
            "{}: {}",
            label.as_deref().unwrap_or(&agent),
            title.unwrap_or("needs you")
        ));
        task["body"] = json!(body);
        super::work::publish_notification(cx, task, json!({"kind": "review"}), None);
    }
    let event = json!({"event": "roamgate.agent_note", "data": {"pane_id": pane}});
    if let Ok(line) = roamgate_connections::routing::serialize_herdr_event_envelope(
        &connection,
        &event,
        generation,
    ) {
        layer.clients.broadcast(&line, "event", None);
    }
}

/// An agent making a worktree or workspace, or naming one it started in
/// (`roamgate-review worktree|workspace|place|groups`, index.ts
/// `workspaceFromAgent`).
async fn workspaces_from_agent(layer: &Layer, input: &Value) -> Result<Value, RpcError> {
    let connection = arg(input, "connectionId");
    let pane = arg(input, "paneId");
    let command = arg(input, "command");
    let params = input["params"].clone();
    let param = |key: &str| params[key].as_str().filter(|value| !value.is_empty());
    let lease = layer
        .ready(&connection)
        .ok()
        .flatten()
        .ok_or_else(not_ready)?;
    let herdr = lease.runtime.herdr();
    let herdr_call = |method: &'static str, params: Value| async move {
        herdr
            .call(
                method,
                params,
                roamgate_herdr::control::DEFAULT_CALL_TIMEOUT_MS,
                None,
                false,
            )
            .await
            .map_err(RpcError::new)
    };
    let mut requester = arg(input, "workspaceId");
    if requester.is_empty() && !pane.is_empty() {
        let found = herdr_call("pane.get", json!({"pane_id": pane})).await?;
        requester = found["pane"]["workspace_id"]
            .as_str()
            .unwrap_or("")
            .to_owned();
    }
    if requester.is_empty() && command != "groups" {
        return Err(review_error("cannot tell which workspace you are in"));
    }
    let tree_runtime = super::super::workspace::tree_runtime(&connection);
    let enrich = |listed: Value| async {
        match &tree_runtime {
            Some(runtime) => runtime.enrich_worktree_parents(listed).await,
            None => listed,
        }
    };
    let listed = enrich(herdr_call("workspace.list", json!({})).await?).await;
    let workspaces: Vec<Value> = listed["workspaces"].as_array().cloned().unwrap_or_default();
    let parent = workspaces
        .iter()
        .find(|each| each["workspace_id"] == requester.as_str())
        .cloned();
    if parent.is_none() && command != "groups" {
        return Err(review_error("your workspace is not listed by Herdr"));
    }
    let usual_parent = parent.as_ref().and_then(|parent| {
        let worktree = &parent["worktree"];
        if worktree["is_linked_worktree"] != true {
            return None;
        }
        let id = worktree["parent_workspace_id"].as_str()?;
        workspaces
            .iter()
            .find(|each| each["workspace_id"] == id)
            .cloned()
    });
    let asker = parent
        .as_ref()
        .map(|parent| workspace_ref_for(&connection, parent));
    let asker_usual = usual_parent
        .as_ref()
        .map(|parent| workspace_ref_for(&connection, parent));
    let read_tree = || async {
        super::super::workspace::tree_read()
            .await
            .map_err(RpcError::new)
    };
    if command == "groups" {
        let tree = read_tree().await?;
        return Ok(agent_group_paths(
            &tree,
            asker.as_ref(),
            asker_usual.as_ref(),
        ));
    }
    let group = param("group")
        .map(roamgate_agents::js::trim)
        .filter(|g| !g.is_empty());
    let create = params["create_group"] == "1";
    // Into the group: refused (nothing made) when the path leads nowhere.
    let into_group = |subject: Option<Value>| {
        let asker = asker.clone();
        let asker_usual = asker_usual.clone();
        let connection = connection.clone();
        async move {
            let tree = read_tree().await?;
            let placement = agent_group_placement_ops(
                &tree,
                GroupPlacement {
                    subject: subject
                        .as_ref()
                        .map(|subject| workspace_ref_for(&connection, subject)),
                    asker,
                    asker_usual_parent: asker_usual,
                    group: group.unwrap_or("").to_owned(),
                    create,
                    new_id: None,
                },
            )
            .map_err(|error| status_error(error.0, 404))?;
            if subject.is_some() {
                super::super::workspace::tree_apply(placement.ops.clone())
                    .await
                    .map_err(|(message, tree)| {
                        if tree {
                            status_error(message, 404)
                        } else {
                            RpcError::new(message)
                        }
                    })?;
            }
            Ok::<_, RpcError>(placement)
        }
    };
    if group.is_some() {
        into_group(None).await?;
    }
    if command == "place" {
        let target = workspaces
            .iter()
            .find(|each| match param("workspace_id") {
                Some(id) => each["workspace_id"] == id,
                None => {
                    let path = params["path"].clone();
                    each["worktree"]["checkout_path"] == path || each["cwd"] == path
                }
            })
            .cloned()
            .ok_or_else(|| status_error("no workspace matches", 404))?;
        if group.is_some() {
            let placement = into_group(Some(target.clone())).await?;
            let mut out = json!({
                "placed": target["workspace_id"],
                "group": placement.path.join("/"),
            });
            if !placement.created.is_empty() {
                out["created"] = json!(placement.created);
            }
            return Ok(out);
        }
        if target["workspace_id"] == requester.as_str() {
            return Err(review_error("that is your own workspace"));
        }
        let parent = parent.unwrap_or(Value::Null);
        super::super::workspace::tree_apply(vec![json!({
            "op": "move",
            "subject": {"workspace": workspace_ref_for(&connection, &target)},
            "parent": {"workspace": workspace_ref_for(&connection, &parent)},
        })])
        .await
        .map_err(|(message, _)| RpcError::new(message))?;
        return Ok(json!({"placed": target["workspace_id"], "under": requester}));
    }
    let dir = param("repo").or(param("dir")).or(param("cwd"));
    let Some(dir) = dir.filter(|dir| roamgate_base::paths::is_host_path(dir)) else {
        return Err(review_error("the client did not send its directory"));
    };
    let result = if command == "worktree" {
        let mut asked = json!({"cwd": dir, "branch": params["branch"]});
        for key in ["base", "path", "label"] {
            if let Some(value) = param(key) {
                asked[key] = json!(value);
            }
        }
        asked["focus"] = json!(false);
        herdr_call("worktree.create", asked).await?
    } else {
        let mut asked = json!({"cwd": dir});
        if let Some(label) = param("label") {
            asked["label"] = json!(label);
        }
        asked["source_workspace_id"] = json!(requester);
        asked["focus"] = json!(false);
        herdr_call("workspace.create", asked).await?
    };
    let created = result["workspace"].clone();
    let path = result["worktree"]["path"]
        .as_str()
        .filter(|path| !path.is_empty())
        .map(str::to_owned);
    if group.is_some()
        && let Some(id) = created["workspace_id"].as_str().filter(|id| !id.is_empty())
    {
        // Named by its checkout as the list will see it.
        let fresh = enrich(herdr_call("workspace.list", json!({})).await?).await;
        let seen = fresh["workspaces"]
            .as_array()
            .into_iter()
            .flatten()
            .find(|each| each["workspace_id"] == id)
            .cloned();
        let placement = into_group(Some(seen.unwrap_or_else(|| created.clone()))).await?;
        let mut out = json!({
            "workspace_id": id,
            "label": created.get("label").cloned().unwrap_or(Value::Null),
        });
        if let Some(path) = &path {
            out["path"] = json!(path);
        }
        out["group"] = json!(placement.path.join("/"));
        if !placement.created.is_empty() {
            out["created"] = json!(placement.created);
        }
        return Ok(out);
    }
    if let Some(runtime) = super::super::workspace::ranger_runtime(&connection)
        && let Err(error) = runtime
            .place_created(result.clone(), Some(requester.clone()))
            .await
    {
        logger(&layer.clock, "bridge").warn(
            "unable to place the created workspace",
            Some(&fields(json!({"connection": connection, "error": error}))),
        );
    }
    let mut out = json!({
        "workspace_id": created.get("workspace_id").cloned().unwrap_or(Value::Null),
        "label": created.get("label").cloned().unwrap_or(Value::Null),
    });
    if let Some(path) = &path {
        out["path"] = json!(path);
    }
    out["under"] = json!(requester);
    Ok(out)
}

// ---- review.host ----

/// The review a Ranger chat's threads are in names it `ranger:<id>`.
fn ranger_chat(key: &str) -> Option<&str> {
    key.strip_prefix("ranger:").filter(|id| !id.is_empty())
}

const EFFORT_SESSION_PREFIX: &str = "effort:";
const WORK_SESSION_PREFIX: &str = "work:";

fn session_of(args: &Value) -> Result<ReviewSession, RpcError> {
    serde_json::from_value(args.get("session").cloned().unwrap_or(Value::Null))
        .map_err(|error| RpcError::new(format!("not a review session: {error}")))
}

/// The session's target as git reads it (a merge request's is its url).
fn git_target(session: &Value) -> Result<Target, RpcError> {
    serde_json::from_value(session["target"].clone())
        .map_err(|_| RpcError::new("not a target git reads"))
}

/// `reviewGlabContext(runtime, root)`: the checkout's forge context.
fn glab_context(layer: &Arc<Layer>, lease: &Lease, root: &str) -> ForgeContext {
    super::forge::context(layer, root, lease.runtime.ssh_host())
}

/// A merge request's commit not in the checkout: the forge's diff, whole.
async fn forge_commit_diff(
    context: &ForgeContext,
    url: &str,
    commit: &str,
) -> Result<Value, RpcError> {
    let mr = read_merge_request(context, url)
        .await
        .map_err(RpcError::new)?;
    let listed = read_merge_request_commits(context, &mr)
        .await
        .map_err(RpcError::new)?;
    let parent = listed
        .iter()
        .find(|entry| entry.sha.starts_with(commit))
        .and_then(|entry| entry.parent.clone());
    to_json(
        read_commit_diff(context, &mr, commit, parent.as_deref())
            .await
            .map_err(RpcError::new)?,
    )
}

fn mr_url(session: &Value) -> Option<String> {
    (session["target"]["kind"] == "mr")
        .then(|| session["target"]["url"].as_str().map(str::to_owned))
        .flatten()
}

/// `review.host {op, ...}`: the review service's effects
/// (`reviewServiceHost`).
async fn host(layer: &Arc<Layer>, cx: &FamilyContext, args: &Value) -> Result<Value, RpcError> {
    let connection_id = arg(args, "connection_id");
    let pane_id = arg(args, "pane_id");
    let raw = args.get("session").cloned().unwrap_or(Value::Null);
    let root = raw["root"].as_str().unwrap_or("").to_owned();
    let session_connection = raw["connectionId"].as_str().unwrap_or("").to_owned();
    let commit = text(args, "commit").map(str::to_owned);
    match text(args, "op").unwrap_or("") {
        "loadCommits" => {
            let lease = runtime_of(layer, &session_connection)?;
            let git = git_of(&session_connection)?;
            let target = &raw["target"];
            if target["kind"] == "range"
                && roamgate_forge::review::cli::truthy(target.get("compare"))
            {
                return Ok(json!([]));
            }
            if target["kind"] == "range" {
                let (base, head) = (
                    target["base"].as_str().unwrap_or(""),
                    target["head"].as_str().unwrap_or(""),
                );
                return to_json(
                    read_review_commits(&git, &root, base, head)
                        .await
                        .map_err(git_error)?,
                );
            }
            let Some(url) = mr_url(&raw) else {
                return Ok(json!([]));
            };
            let context = glab_context(layer, &lease, &root);
            let mr = read_merge_request(&context, &url)
                .await
                .map_err(RpcError::new)?;
            match read_review_commits(&git, &root, &mr.base_sha, &mr.head_sha).await {
                Ok(commits) => to_json(commits),
                Err(_) => to_json(
                    read_merge_request_commits(&context, &mr)
                        .await
                        .map_err(RpcError::new)?,
                ),
            }
        }
        "loadPatchIds" => {
            runtime_of(layer, &session_connection)?;
            let git = git_of(&session_connection)?;
            let shas: Vec<String> =
                serde_json::from_value(args["shas"].clone()).unwrap_or_default();
            to_json(
                read_review_patch_ids(&git, &root, &shas)
                    .await
                    .map_err(git_error)?,
            )
        }
        "loadSummary" => {
            let lease = runtime_of(layer, &session_connection)?;
            let git = git_of(&session_connection)?;
            if let Some(commit) = commit {
                return match read_review_summary(&git, &root, &SummaryOf::Commit(commit.clone()))
                    .await
                {
                    Ok(summary) => to_json(summary),
                    Err(error) => match mr_url(&raw) {
                        Some(url) => {
                            forge_commit_diff(&glab_context(layer, &lease, &root), &url, &commit)
                                .await
                        }
                        None => Err(git_error(error)),
                    },
                };
            }
            let Some(url) = mr_url(&raw) else {
                return to_json(
                    read_review_summary(&git, &root, &SummaryOf::Target(git_target(&raw)?))
                        .await
                        .map_err(git_error)?,
                );
            };
            // A merge request: its files from the checkout when it has its
            // commits, else the forge's whole diff.
            let context = glab_context(layer, &lease, &root);
            let mr = read_merge_request(&context, &url)
                .await
                .map_err(RpcError::new)?;
            let range = Target::range(&mr.base_sha, &mr.head_sha);
            match read_review_summary(&git, &root, &SummaryOf::Target(range)).await {
                Ok(summary) => to_json(summary),
                Err(_) => to_json(
                    read_merge_request_diff(&context, &mr)
                        .await
                        .map_err(RpcError::new)?,
                ),
            }
        }
        "loadFiles" => {
            runtime_of(layer, &session_connection)?;
            let git = git_of(&session_connection)?;
            let ends = &args["ends"];
            let files: Vec<FileRequest> = args["files"]
                .as_array()
                .into_iter()
                .flatten()
                .map(|file| FileRequest {
                    path: file["path"].as_str().unwrap_or("").to_owned(),
                    old_path: file["oldPath"].as_str().map(str::to_owned),
                })
                .collect();
            to_json(
                read_review_files(
                    &git,
                    &root,
                    ends["base"].as_str().unwrap_or(""),
                    ends["head"].as_str().unwrap_or(""),
                    &files,
                )
                .await
                .map_err(git_error)?,
            )
        }
        "loadDiff" => {
            let lease = runtime_of(layer, &session_connection)?;
            let git = git_of(&session_connection)?;
            let paths: Option<Vec<String>> = args
                .get("paths")
                .filter(|paths| paths.is_array())
                .and_then(|paths| serde_json::from_value(paths.clone()).ok());
            if let Some(commit) = commit {
                return match read_review_commit_patch(&git, &root, &commit).await {
                    Ok(diff) => to_json(diff),
                    Err(error) => match mr_url(&raw) {
                        Some(url) => {
                            forge_commit_diff(&glab_context(layer, &lease, &root), &url, &commit)
                                .await
                        }
                        None => Err(git_error(error)),
                    },
                };
            }
            let Some(url) = mr_url(&raw) else {
                return to_json(
                    read_review_patch(&git, &root, &git_target(&raw)?, paths.as_deref())
                        .await
                        .map_err(git_error)?,
                );
            };
            // A merge request: its commits diffed locally when the
            // checkout has them (one host command), else the forge's diff.
            let context = glab_context(layer, &lease, &root);
            let mr = read_merge_request(&context, &url)
                .await
                .map_err(RpcError::new)?;
            let range = Target::range(&mr.base_sha, &mr.head_sha);
            match read_review_patch(&git, &root, &range, paths.as_deref()).await {
                Ok(mut diff) => {
                    diff.base_sha = Some(mr.base_sha.clone());
                    diff.head_sha = Some(mr.head_sha.clone());
                    to_json(diff)
                }
                Err(_) => to_json(
                    read_merge_request_diff(&context, &mr)
                        .await
                        .map_err(RpcError::new)?,
                ),
            }
        }
        "loadState" => {
            runtime_of(layer, &session_connection)?;
            let git = git_of(&session_connection)?;
            Ok(json!(
                read_review_state(&git, &root, &git_target(&raw)?)
                    .await
                    .map_err(git_error)?
            ))
        }
        "loadHeads" => {
            runtime_of(layer, &connection_id)?;
            let git = git_of(&connection_id)?;
            let entries: Vec<(String, String)> = args["entries"]
                .as_array()
                .into_iter()
                .flatten()
                .map(|entry| {
                    (
                        entry["root"].as_str().unwrap_or("").to_owned(),
                        entry["ref"].as_str().unwrap_or("").to_owned(),
                    )
                })
                .collect();
            to_json(read_review_heads(&git, &entries).await.map_err(git_error)?)
        }
        "loadFile" => {
            let lease = runtime_of(layer, &session_connection)?;
            let git = git_of(&session_connection)?;
            let (rev, path) = (arg(args, "rev"), arg(args, "path"));
            match read_review_file(&git, &root, &rev, &path).await {
                Ok(text) => Ok(json!(text)),
                Err(error) => {
                    // An MR's commits may not be in the checkout; the forge
                    // has the file.
                    let forge = !raw["gitlab"].is_null() && raw["gitlab"] != false;
                    let (true, Some(url)) = (!rev.is_empty() && forge, mr_url(&raw)) else {
                        return Err(git_error(error));
                    };
                    let context = glab_context(layer, &lease, &root);
                    let mr = read_merge_request(&context, &url)
                        .await
                        .map_err(RpcError::new)?;
                    Ok(json!(
                        read_raw_file(&context, &mr, &path, &rev)
                            .await
                            .map_err(RpcError::new)?
                    ))
                }
            }
        }
        "promptAgent" => {
            let text = arg(args, "text");
            // A Ranger chat's threads go to Ranger, as a message in that chat.
            if let Some(chat) = ranger_chat(&pane_id) {
                call(
                    cx,
                    "internal.assistant.deliver_chat_comments",
                    json!({"session_id": chat, "text": text}),
                )
                .await?;
                return Ok(json!({}));
            }
            let lease = runtime_of(layer, &connection_id)?;
            prompt_pane_agent(layer, cx, &lease, &pane_id, &text, "review").await?;
            Ok(json!({}))
        }
        "sessionPane" => {
            let session = arg(args, "session_id");
            if ranger_chat(&session).is_some() {
                return Ok(json!(session));
            }
            if let Some(effort) = session.strip_prefix(EFFORT_SESSION_PREFIX) {
                return Ok(effort_leader_pane(cx, &connection_id, effort).await);
            }
            if let Some(item) = session.strip_prefix(WORK_SESSION_PREFIX) {
                let answer = call(
                    cx,
                    "internal.work.owner_pane",
                    json!({"item": item, "connection_id": connection_id}),
                )
                .await?;
                return Ok(answer.get("pane").cloned().unwrap_or(Value::Null));
            }
            runtime_of(layer, &connection_id)?;
            let (readers, _) =
                super::super::agent_sessions::owned_readers(cx, &connection_id).await?;
            Ok(json!(
                readers
                    .session_pane(&session)
                    .await
                    .map_err(|error| RpcError::new(error.message))?
            ))
        }
        "paneSession" => {
            if ranger_chat(&pane_id).is_some() {
                return Ok(Value::Null);
            }
            runtime_of(layer, &connection_id)?;
            let (readers, _) =
                super::super::agent_sessions::owned_readers(cx, &connection_id).await?;
            Ok(json!(
                readers
                    .pane_session(&pane_id)
                    .await
                    .map_err(|error| RpcError::new(error.message))?
            ))
        }
        "agentCompactedSince" => {
            if ranger_chat(&pane_id).is_some() {
                return Ok(json!(false));
            }
            match layer.ready(&connection_id).ok().flatten() {
                Some(lease) if lease.runtime.remote_platform().is_none() => {}
                _ => return Ok(json!(false)),
            }
            let (readers, _) =
                super::super::agent_sessions::owned_readers(cx, &connection_id).await?;
            Ok(json!(
                readers
                    .compacted_since(&pane_id, &arg(args, "since"))
                    .await
                    .map_err(|error| RpcError::new(error.message))?
            ))
        }
        "noteCause" => {
            // All an agent is sent by a review is the user's doing.
            super::super::voice::note_turn_cause(
                &connection_id,
                &pane_id,
                &json!({"by": "user", "via": "review"}),
            );
            Ok(json!({}))
        }
        other => Err(RpcError::new(format!("unknown review host op {other}"))),
    }
}

/// `promptPaneAgent`: conversation mode's queue, else the pane's Claude
/// mod, else typed into the terminal.
pub(super) async fn prompt_pane_agent(
    layer: &Layer,
    cx: &FamilyContext,
    lease: &Lease,
    pane: &str,
    text: &str,
    kind: &str,
) -> Result<&'static str, RpcError> {
    let id = &lease.connection_id;
    if super::conversation::prompt(layer, cx, id, pane, text, false, None).await? {
        return Ok("conversation");
    }
    if !super::conversation::mod_deliver(id, pane, text, kind)?.is_null() {
        return Ok("mod");
    }
    lease
        .runtime
        .herdr()
        .call(
            "agent.prompt",
            json!({"target": pane, "text": text}),
            5000,
            None,
            false,
        )
        .await
        .map_err(RpcError::new)?;
    Ok("terminal")
}

/// An effort's threads go to its leader, whichever pane runs it now.
async fn effort_leader_pane(cx: &FamilyContext, connection: &str, effort: &str) -> Value {
    let answer = call(
        cx,
        "internal.mr_reviews.call",
        json!({"method": "bridge.mr_reviews.effort.leader", "params": {"id": effort}}),
    )
    .await;
    match answer {
        Ok(answer)
            if answer["state"] == "ready"
                && answer["connectionId"] == connection
                && answer["paneId"]
                    .as_str()
                    .is_some_and(|pane| !pane.is_empty()) =>
        {
            answer["paneId"].clone()
        }
        _ => Value::Null,
    }
}

// ---- review.forge ----

/// `review.forge {op, session, ...}`: merge requests' reviews on the
/// checkout's host.
async fn forge(layer: &Arc<Layer>, args: &Value) -> Result<Value, RpcError> {
    let session = session_of(args)?;
    let forge = {
        let layer = layer.clone();
        MergeRequestForge::new(Arc::new(move |connection: &str, root: &str| {
            let lease = runtime_of(&layer, connection).map_err(|error| error.message)?;
            Ok(glab_context(&layer, &lease, root))
        }))
    };
    let failed = |message: String| RpcError::new(message);
    let mr = args.get("mr").cloned().unwrap_or(Value::Null);
    match text(args, "op").unwrap_or("") {
        "checkout" => forge.checkout(&session).await.map_err(|error| match error {
            LoadError::Gone { code, message } => RpcError::with_code(message, &code),
            LoadError::Failed(message) => RpcError::new(message),
        }),
        "find" => Ok(forge
            .find(
                &session,
                args.get("checkout").cloned().unwrap_or(Value::Null),
            )
            .await
            .map_err(failed)?
            .unwrap_or(Value::Null)),
        "readMergeRequest" => forge
            .read_merge_request(&session, &arg(args, "url"))
            .await
            .map_err(failed),
        "readThreads" => to_json(forge.read_threads(&session, &mr).await.map_err(failed)?),
        "createDraftNote" => {
            let anchor = serde_json::from_value(args["anchor"].clone())
                .map_err(|error| RpcError::new(error.to_string()))?;
            let diff = args.get("diff").filter(|diff| !diff.is_null()).cloned();
            to_json(
                forge
                    .create_draft_note(&session, &mr, anchor, arg(args, "note"), diff)
                    .await
                    .map_err(failed)?,
            )
        }
        "updateDraftNote" => {
            let id = roamgate_agents::js::to_number(args.get("id")) as i64;
            to_json(
                forge
                    .update_draft_note(&session, &mr, id, arg(args, "note"))
                    .await
                    .map_err(failed)?,
            )
        }
        "deleteDraftNote" => {
            let id = roamgate_agents::js::to_number(args.get("id")) as i64;
            forge
                .delete_draft_note(&session, &mr, id)
                .await
                .map_err(failed)?;
            Ok(json!({}))
        }
        "createDraftReply" => to_json(
            forge
                .create_draft_reply(&session, &mr, &arg(args, "discussion"), arg(args, "note"))
                .await
                .map_err(failed)?,
        ),
        other => Err(RpcError::new(format!("unknown review forge op {other}"))),
    }
}

// ---- review.connection ----

/// `review.connection {op, connection_id?, ...}`: a browser connection's
/// reads for the review calls (`reviewRpcConnection`).
async fn connection(
    layer: &Arc<Layer>,
    cx: &FamilyContext,
    args: &Value,
) -> Result<Value, RpcError> {
    if text(args, "op") == Some("id") {
        return Ok(json!(layer.default_id()));
    }
    let lease = layer.lease(args)?;
    let id = lease.connection_id.clone();
    match text(args, "op").unwrap_or("") {
        "resolveRoot" => {
            let runtime = super::super::workspace::ranger_runtime(&id).ok_or_else(not_ready)?;
            let root = runtime
                .git_root(&json!({"workspace_id": arg(args, "workspace_id")}))
                .await?;
            Ok(root["root"].clone())
        }
        "readDefaultBase" => Ok(json!(
            read_default_base(&git_of(&id)?, &arg(args, "root"))
                .await
                .map_err(git_error)?
        )),
        "readRoot" => Ok(json!(
            read_review_root(&git_of(&id)?, &arg(args, "path"))
                .await
                .map_err(git_error)?
        )),
        "scanRepos" => {
            let list = |key: &str| -> Vec<String> {
                serde_json::from_value(args[key].clone()).unwrap_or_default()
            };
            to_json(
                scan_review_repos(&git_of(&id)?, &list("paths"), &list("agent_paths"))
                    .await
                    .map_err(git_error)?,
            )
        }
        op @ ("renderedPage" | "renderedSvg" | "renderedStorage" | "clearRenderedStorage") => {
            super::rendered::connection_op(layer, cx, &id, op, args).await
        }
        other => Err(RpcError::new(format!(
            "unknown review connection op {other}"
        ))),
    }
}

// ---- review.published ----

/// The prompts each connection was last notified of (`notifiedPrompts`).
static NOTIFIED: LazyLock<Mutex<HashMap<String, HashSet<String>>>> = LazyLock::new(Mutex::default);

/// What a push of the core's review service does besides the browsers:
/// the notification feed's prompts, the Work board's questions, the
/// local history.
fn published(layer: &Arc<Layer>, cx: &FamilyContext, push: &Value) {
    let session = push["sessionId"].as_str().filter(|id| !id.is_empty());
    match push["type"].as_str() {
        Some("prompts") => notify_prompts(layer, cx, push),
        Some("removed") => {
            if let Some(session) = session {
                history_changed(cx, "reviews", session);
            }
        }
        Some("session") => {
            if let Some(session) = session {
                history_changed(cx, "reviews", session);
                if let Some(item) = push["workItem"].as_str().filter(|item| !item.is_empty()) {
                    history_changed(cx, "work", item);
                    let threads = push["threads"].as_array().cloned().unwrap_or_default();
                    super::tell(
                        cx,
                        "internal.work.questions_seen",
                        json!({"item": item, "threads": threads}),
                    );
                }
            }
        }
        _ => {}
    }
}

fn history_changed(cx: &FamilyContext, area: &str, id: &str) {
    super::tell(
        cx,
        "internal.history.changed",
        json!({"area": area, "id": id}),
    );
}

/// An agent's permission prompt or question waits on the user: one
/// notification each, Allow and Deny on a permission; withdrawn once it
/// is answered or back in the terminal (`notifyPrompts`).
fn notify_prompts(layer: &Arc<Layer>, cx: &FamilyContext, push: &Value) {
    let connection = push["connectionId"].as_str().unwrap_or("").to_owned();
    let prompts = push["prompts"].as_array().cloned().unwrap_or_default();
    let open: HashSet<String> = prompts
        .iter()
        .filter_map(|prompt| prompt["id"].as_str().map(str::to_owned))
        .collect();
    let before = {
        let mut notified = NOTIFIED.lock().unwrap();
        let before = notified.get(&connection).cloned().unwrap_or_default();
        if open.is_empty() {
            notified.remove(&connection);
        } else {
            notified.insert(connection.clone(), open.clone());
        }
        before
    };
    for id in before.difference(&open) {
        super::tell(
            cx,
            "internal.notifications.clear_prompt",
            json!({"prompt_id": id}),
        );
    }
    for prompt in prompts {
        let Some(id) = prompt["id"].as_str() else {
            continue;
        };
        if before.contains(id) {
            continue;
        }
        let (layer, cx) = (layer.clone(), cx.clone());
        tokio::spawn(async move { notify_prompt(&layer, &cx, &prompt).await });
    }
}

async fn notify_prompt(layer: &Layer, cx: &FamilyContext, prompt: &Value) {
    let connection = prompt["connectionId"].as_str().unwrap_or("");
    let pane = prompt["paneId"].as_str().unwrap_or("");
    let Some(generation) = generation_of(layer, connection) else {
        return;
    };
    let (found, label) = pane_workspace(layer, connection, pane).await;
    let id = prompt["id"].as_str().unwrap_or("");
    // Answered while its workspace was looked up: nothing to say any more.
    if !NOTIFIED
        .lock()
        .unwrap()
        .get(connection)
        .is_some_and(|open| open.contains(id))
    {
        return;
    }
    let agent = prompt["agent"].as_str().unwrap_or("");
    let question = prompt["questions"][0]["question"].as_str();
    let mut task = pane_task(
        connection,
        generation,
        pane,
        &found,
        label.as_deref(),
        agent,
    );
    let wants = match question {
        Some(_) => format!("{agent} asks"),
        None => format!(
            "{agent} wants {}",
            roamgate_agents::js::to_text(&prompt["tool"])
        ),
    };
    task["title"] = json!(format!("{}: {wants}", label.as_deref().unwrap_or(agent)));
    let body = question
        .map(str::to_owned)
        .unwrap_or_else(|| roamgate_agents::js::to_text(&prompt["summary"]));
    task["body"] = json!(roamgate_agents::js::head16(&body, 300));
    let extra = if prompt["questions"].is_null() {
        json!({
            "actions": [{"id": "allow", "label": "Allow"}, {"id": "deny", "label": "Deny"}],
            "prompt": {"connectionId": connection, "promptId": id},
        })
    } else {
        json!({})
    };
    super::work::publish_notification(cx, task, extra, None);
}
