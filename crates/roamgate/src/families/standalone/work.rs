//! What the work and voice families asked of the server (index.ts
//! `work.*` and `voice.*` targets, `workServiceDeps`, `voiceErrandDeps`):
//! the review service as the board asks it, the board's notifications,
//! git and files of a rule's checkout, a connection's panes and
//! workspaces, this server's checkout; the companion's errands on a
//! session, its Work tools and a login for a call handed on. And the
//! notification feed's targets, whose sockets this core does not hold.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, LazyLock, Mutex};
use std::time::Duration;

use base64::Engine as _;
use roamgate_exec::quote::shell_quote;
use roamgate_git::GitContext;
use roamgate_git::exec::LocalRunner;
use roamgate_git::shell::shell_command;
use roamgate_sidecar::family::FamilyContext;
use roamgate_sidecar::protocol::RpcError;
use serde_json::{Value, json};

use super::{Layer, Target, call, text};

pub(super) const TARGETS: &[(&str, Target)] = &[
    ("work.review", |_, cx, args| {
        Box::pin(async move { work_review(&cx, &args).await })
    }),
    ("work.notify", |layer, cx, args| {
        Box::pin(async move {
            let item = args
                .get("item")
                .filter(|item| item.is_object())
                .ok_or_else(|| RpcError::new("work.notify needs an item"))?;
            work_notify(&layer, &cx, item, text(&args, "op") == Some("publish"));
            Ok(json!({"ok": true}))
        })
    }),
    ("work.git", |layer, _, args| {
        Box::pin(async move {
            let (Some(root), Some(argv)) = (text(&args, "root"), strings(&args, "args")) else {
                return Err(RpcError::new("work.git needs a root and args"));
            };
            let script = format!(
                "git -C {} {}",
                shell_quote(root),
                argv.iter()
                    .map(|arg| shell_quote(arg))
                    .collect::<Vec<_>>()
                    .join(" ")
            );
            Ok(
                match run_script(&layer, text(&args, "connection_id"), &script).await {
                    Some(Ok(ran)) => json!({"code": ran.code, "stdout": ran.stdout}),
                    _ => json!({"code": null, "stdout": ""}),
                },
            )
        })
    }),
    ("work.read_file", |layer, _, args| {
        Box::pin(async move {
            let (Some(root), Some(path)) = (text(&args, "root"), text(&args, "path")) else {
                return Err(RpcError::new("work.read_file needs a root and a path"));
            };
            if path.starts_with('/') || path.split('/').any(|part| part == "..") {
                return Ok(Value::Null);
            }
            let script = format!("cat {}", shell_quote(&format!("{root}/{path}")));
            Ok(
                match run_script(&layer, text(&args, "connection_id"), &script).await {
                    Some(Ok(ran)) if ran.code == 0 => json!(ran.stdout),
                    _ => Value::Null,
                },
            )
        })
    }),
    ("work.checkout", |_, _, _| {
        Box::pin(async move { Ok(json!(own_checkout().display().to_string())) })
    }),
    ("work.panes", |layer, _, args| {
        Box::pin(async move { herdr_list(&layer, &args, "pane.list", "panes").await })
    }),
    ("work.workspaces", |layer, _, args| {
        Box::pin(async move { herdr_list(&layer, &args, "workspace.list", "workspaces").await })
    }),
    ("voice.errand_read", |_, cx, args| {
        Box::pin(async move {
            let (connection, pane) = voice_pane(&args)?;
            let (readers, _) =
                super::super::agent_sessions::owned_readers(&cx, &connection).await?;
            let history = readers
                .read_history(&json!({"history_version": 2, "cursor": null, "pane_id": pane}))
                .await
                .map_err(|error| RpcError::new(error.message))?;
            Ok(history.get("entries").cloned().unwrap_or_else(|| json!([])))
        })
    }),
    ("voice.errand_prompt", |layer, cx, args| {
        Box::pin(async move {
            let (connection, pane) = voice_pane(&args)?;
            let text = text(&args, "text")
                .ok_or_else(|| RpcError::new("voice.errand_prompt needs a text"))?
                .to_owned();
            errand_prompt(&layer, &cx, &connection, &pane, &text).await?;
            Ok(json!({"ok": true}))
        })
    }),
    ("voice.errand_status", |layer, cx, args| {
        Box::pin(async move {
            let (connection, pane) = voice_pane(&args)?;
            errand_status(&layer, &cx, &connection, &pane).await
        })
    }),
    ("voice.work_tool", |_, cx, args| {
        Box::pin(async move {
            let tool =
                text(&args, "tool").ok_or_else(|| RpcError::new("voice.work_tool needs a tool"))?;
            let params = args.get("params").cloned().unwrap_or(Value::Null);
            let answer = call(
                &cx,
                "internal.work.user_tool",
                json!({"tool": tool, "params": params}),
            )
            .await?;
            Ok(json!({"text": answer.get("text").cloned().unwrap_or(Value::Null)}))
        })
    }),
    ("voice.work_states", |_, _, _| {
        Box::pin(async move {
            // The file as the work family last wrote it (read only).
            let env = roamgate_base::env::ProcessEnv;
            let root = roamgate_base::paths::DataContext::from_env(&env).data_root();
            let store = roamgate_work::store::WorkStore::open(
                &roamgate_work::store::work_directory(&env, &root),
                roamgate_work::store::StoreWrites::Memory,
                Arc::new(roamgate_work::store::NoHistory),
                Arc::new(String::new),
            );
            Ok(Value::Array(
                store.items().iter().map(|item| json!(item.state)).collect(),
            ))
        })
    }),
    ("voice.session_cookie", |_, cx, _| {
        Box::pin(async move {
            let cookie = cx
                .peer
                .reverse_call(
                    "voice.session_cookie",
                    json!({}),
                    roamgate_sidecar::protocol::Ctx::default(),
                )
                .await?;
            Ok(cookie)
        })
    }),
    // The feed's sockets are the front's to hold: none here.
    ("notifications.feed", |_, _, args| {
        Box::pin(async move {
            if !args.get("last").is_some_and(Value::is_number)
                || !args.get("events").is_some_and(Value::is_array)
            {
                return Err(RpcError::new("notifications.feed needs last and events"));
            }
            Ok(json!({"ok": true}))
        })
    }),
    ("notifications.clients", |_, _, _| {
        Box::pin(async move { Ok(json!({"android_connected": false, "clients": []})) })
    }),
    ("notifications.current", |_, _, args| {
        Box::pin(async move {
            Ok(json!(
                args.get("token")
                    .and_then(Value::as_u64)
                    .is_some_and(current_check)
            ))
        })
    }),
    ("notifications.clear_pane", |_, cx, args| {
        Box::pin(async move {
            let pane = text(&args, "pane_id")
                .ok_or_else(|| RpcError::new("needs a pane_id and a text"))?;
            let connection = text(&args, "connection_id")
                .ok_or_else(|| RpcError::new("notifications.clear_pane needs a connection_id"))?;
            call(
                &cx,
                "internal.notifications.clear_pane",
                json!({"connection_id": connection, "pane_id": pane}),
            )
            .await?;
            Ok(json!({"ok": true}))
        })
    }),
];

fn strings(args: &Value, key: &str) -> Option<Vec<String>> {
    args.get(key)?
        .as_array()?
        .iter()
        .map(|each| each.as_str().map(str::to_owned))
        .collect()
}

/// This server's own checkout (work/deployed.ts `ownCheckout`): the
/// directory the binary was built from, two above its crate.
pub(super) fn own_checkout() -> PathBuf {
    let crate_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    crate_dir
        .parent()
        .and_then(|crates| crates.parent())
        .map(PathBuf::from)
        .unwrap_or(crate_dir)
}

/// A script in a rule's checkout (`gitShellCommandArgv`, 30 s): on its
/// connection's host, or here when it names none. None when the
/// connection it names is not ready, or is a Windows one.
async fn run_script(
    layer: &Layer,
    connection: Option<&str>,
    script: &str,
) -> Option<Result<roamgate_git::Ran, String>> {
    let git = match connection {
        Some(id) => {
            let lease = layer.ready(id).ok().flatten()?;
            if lease.runtime.remote_platform().is_some() {
                return None;
            }
            match super::super::workspace::ranger_runtime(id) {
                Some(runtime) => runtime.git().clone(),
                None if lease.runtime.ssh_host().is_none() => local_git(),
                None => return Some(Err(format!("connection not ready: {id}"))),
            }
        }
        None => local_git(),
    };
    let invocation = match shell_command(script, git.host()) {
        Ok(invocation) => invocation,
        Err(error) => return Some(Err(error)),
    };
    Some(
        git.run(invocation, Duration::from_secs(30))
            .await
            .map_err(|error| error.to_string()),
    )
}

fn local_git() -> GitContext {
    GitContext::local(Arc::new(LocalRunner::system()))
}

/// `work.panes` and `work.workspaces`: Herdr's list of a connection.
async fn herdr_list(
    layer: &Layer,
    args: &Value,
    method: &str,
    key: &str,
) -> Result<Value, RpcError> {
    let id = text(args, "connection_id").ok_or_else(|| RpcError::new("needs a connection_id"))?;
    let Some(manager) = layer.host.manager_now() else {
        return Ok(json!([]));
    };
    let Some(runtime) = manager.ready_runtime(id) else {
        return Ok(json!([]));
    };
    let listed = runtime
        .herdr()
        .call(
            method,
            json!({}),
            roamgate_herdr::control::DEFAULT_CALL_TIMEOUT_MS,
            None,
            false,
        )
        .await
        .map_err(RpcError::new)?;
    Ok(listed.get(key).cloned().unwrap_or_else(|| json!([])))
}

/// `internal.review.call {method, params}`.
async fn reviews(cx: &FamilyContext, method: &str, params: Value) -> Result<Value, RpcError> {
    call(
        cx,
        "internal.review.call",
        json!({"method": method, "params": params}),
    )
    .await
}

/// The newest review `matches` takes (`coreNewestReview`), or null.
async fn newest(cx: &FamilyContext, matches: impl Fn(&Value) -> bool) -> Result<Value, RpcError> {
    let listed = reviews(cx, "list", json!({"chats": true})).await?;
    Ok(listed
        .as_array()
        .into_iter()
        .flatten()
        .find(|snapshot| matches(&snapshot["session"]))
        .cloned()
        .unwrap_or(Value::Null))
}

/// `work.review {op, ...}`: the review service as the board asks it.
async fn work_review(cx: &FamilyContext, args: &Value) -> Result<Value, RpcError> {
    let needs = |key: &str| {
        text(args, key)
            .map(str::to_owned)
            .ok_or_else(|| RpcError::new(format!("work.review needs {key}")))
    };
    let anchor = || {
        args.get("anchor")
            .filter(|anchor| !anchor.is_null())
            .cloned()
            .unwrap_or_else(|| json!({}))
    };
    match text(args, "op").unwrap_or("") {
        "find" => {
            let item = needs("item")?;
            newest(cx, |session| {
                session["target"]["kind"] == "work" && session["target"]["item"] == item.as_str()
            })
            .await
        }
        "open" => {
            let (item, connection, root, title) = (
                needs("item")?,
                needs("connection_id")?,
                needs("root")?,
                needs("title")?,
            );
            reviews(
                cx,
                "open",
                json!({
                    "connectionId": connection,
                    "root": root,
                    "target": {"kind": "work", "item": item},
                    "title": title,
                    "agent": "Claude",
                    "raise": false,
                }),
            )
            .await
        }
        "get" => {
            let review = needs("review")?;
            newest(cx, |session| {
                session["id"]
                    .as_str()
                    .is_some_and(|id| id.starts_with(review.as_str()))
            })
            .await
        }
        "session_of_comment" => {
            let id = needs("id")?;
            let listed = reviews(cx, "list", json!({"chats": true})).await?;
            let matches = |each: &Value| {
                each.as_str()
                    .is_some_and(|each| each == id || each.starts_with(id.as_str()))
            };
            Ok(listed
                .as_array()
                .into_iter()
                .flatten()
                .find(|snapshot| {
                    snapshot["threads"]
                        .as_array()
                        .into_iter()
                        .flatten()
                        .any(|thread| {
                            matches(&thread["id"])
                                || thread["comments"]
                                    .as_array()
                                    .into_iter()
                                    .flatten()
                                    .any(|comment| matches(&comment["id"]))
                        })
                })
                .map(|snapshot| snapshot["session"].clone())
                .unwrap_or(Value::Null))
        }
        "add_thread" => {
            let params = json!({
                "sessionId": needs("session_id")?,
                "author": needs("author")?,
                "text": needs("text")?,
                "anchor": anchor(),
                "kind": "discussion",
            });
            reviews(cx, "addThread", params).await
        }
        "move_thread" | "set_anchor" => {
            let method = if text(args, "op") == Some("move_thread") {
                "moveThread"
            } else {
                "setThreadAnchor"
            };
            let params = json!({
                "sessionId": needs("session_id")?,
                "threadId": needs("thread_id")?,
                "anchor": anchor(),
            });
            reviews(cx, method, params).await
        }
        "add_image" => {
            let (session, kind, data) = (needs("session_id")?, needs("type")?, needs("data")?);
            let bytes = base64::engine::general_purpose::STANDARD
                .decode(data.as_bytes())
                .unwrap_or_default();
            let directory =
                roamgate_review::storage::review_directory(&roamgate_base::env::ProcessEnv);
            let path =
                roamgate_review::images::save_review_image(&directory, &session, &kind, &bytes)
                    .map_err(|error| RpcError::new(error.message))?;
            Ok(json!(path.display().to_string()))
        }
        "edit_comment" => {
            let params = json!({
                "sessionId": needs("session_id")?,
                "commentId": needs("comment_id")?,
                "author": needs("author")?,
                "text": needs("text")?,
            });
            reviews(cx, "edit", params).await
        }
        "delete_comment" => {
            let params = json!({
                "sessionId": needs("session_id")?,
                "commentId": needs("comment_id")?,
                "author": needs("author")?,
            });
            reviews(cx, "deleteComment", params).await
        }
        other => Err(RpcError::new(format!(
            "work.review: unknown op {}",
            roamgate_agents::js::head16(other, 40)
        ))),
    }
}

/// The default connection, else the first (`workServiceDeps`'s
/// notifications): `(id, generation)`.
fn notice_connection(layer: &Layer) -> Option<(String, u64)> {
    let listed = layer.host.manager_now()?.list();
    listed
        .iter()
        .find(|status| status.is_default)
        .or(listed.first())
        .map(|status| (status.id.clone(), status.generation))
}

/// A work item for the user: one notification, the item standing as the
/// pane (its tag stays whatever its title becomes).
fn work_notify(layer: &Layer, cx: &FamilyContext, item: &Value, publish: bool) {
    let Some((connection, generation)) = notice_connection(layer) else {
        return;
    };
    let id = roamgate_agents::js::to_text(&item["id"]);
    if !publish {
        let tag = json!([
            "roamgate-task",
            connection,
            generation,
            format!("work:{id}")
        ]);
        super::tell(
            cx,
            "internal.notifications.clear_tag",
            json!({"tag": tag.to_string()}),
        );
        return;
    }
    let title = roamgate_agents::js::to_text(&item["title"]);
    let ask = item["ask"].as_str().filter(|ask| !ask.is_empty());
    let tags: Vec<String> = item["tags"]
        .as_array()
        .into_iter()
        .flatten()
        .map(roamgate_agents::js::to_text)
        .collect();
    let body = match ask {
        Some(ask) => roamgate_agents::js::head16(ask, 240),
        None if !tags.is_empty() => tags.join(", "),
        None => "On the Work board".to_owned(),
    };
    publish_notification(
        cx,
        json!({
            "kind": "blocked",
            "connectionId": connection,
            "runtimeGeneration": generation,
            "paneId": format!("work:{id}"),
            "agent": "Work",
            "workspaceLabel": "Work",
            "title": format!("For you: {}", roamgate_agents::js::head16(&title, 120)),
            "body": body,
        }),
        json!({"kind": "work", "path": format!("/#roamgate-work={id}")}),
        None,
    );
}

/// What the core queued for Web Push under a token, and whether it still
/// holds (`currentChecks`).
type CurrentCheck = Arc<dyn Fn() -> bool + Send + Sync>;
static CURRENT: LazyLock<Mutex<(u64, HashMap<u64, CurrentCheck>)>> = LazyLock::new(Mutex::default);
/// How many of those are kept (notification-feed.ts MAX_CURRENT_CHECKS).
const MAX_CURRENT_CHECKS: usize = 1000;

fn current_check(token: u64) -> bool {
    let check = CURRENT.lock().unwrap().1.get(&token).cloned();
    check.is_some_and(|check| check())
}

/// `notifications.publish(task, extra)` of Bun's feed while the core owns
/// it: the core builds, keeps and pushes it (`internal.notifications
/// .publish`); `is_current` is asked again before each Web Push send.
pub(super) fn publish_notification(
    cx: &FamilyContext,
    task: Value,
    extra: Value,
    is_current: Option<CurrentCheck>,
) {
    if is_current.as_ref().is_some_and(|check| !check()) {
        return;
    }
    let mut params = json!({"task": task});
    for key in ["kind", "path", "prompt"] {
        if let Some(value) = extra.get(key).filter(|value| !value.is_null()) {
            params[key] = value.clone();
        }
    }
    if let Some(actions) = extra["actions"].as_array().filter(|a| !a.is_empty()) {
        params["actions"] = json!(actions);
    }
    params["android_connected"] = json!(false);
    if let Some(check) = is_current {
        let mut current = CURRENT.lock().unwrap();
        current.0 += 1;
        let token = current.0;
        current.1.insert(token, check);
        if current.1.len() > MAX_CURRENT_CHECKS
            && let Some(oldest) = current.1.keys().min().copied()
        {
            current.1.remove(&oldest);
        }
        params["current"] = json!(token);
    }
    super::tell(cx, "internal.notifications.publish", params);
}

fn voice_pane(args: &Value) -> Result<(String, String), RpcError> {
    match (text(args, "connection_id"), text(args, "pane_id")) {
        (Some(connection), Some(pane)) => Ok((connection.to_owned(), pane.to_owned())),
        _ => Err(RpcError::new(
            "a voice errand needs a connection_id and a pane_id",
        )),
    }
}

/// `voiceErrandDeps.prompt`: any mode, as `roamgate-review message`
/// reaches a session (conversation queue, else its Claude mod, else typed
/// once the terminal is idle); a Windows host is not the messenger's.
async fn errand_prompt(
    layer: &Arc<Layer>,
    cx: &FamilyContext,
    connection: &str,
    pane: &str,
    text: &str,
) -> Result<(), RpcError> {
    let lease = layer
        .ready(connection)?
        .ok_or_else(|| RpcError::new(format!("{connection} is not connected")))?;
    if lease.runtime.remote_platform().is_some() {
        if super::conversation::prompt(layer, cx, connection, pane, text, false, None).await? {
            return Ok(());
        }
        if !super::conversation::mod_deliver(connection, pane, text, "companion")?.is_null() {
            return Ok(());
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
        return Ok(());
    }
    super::connections::messenger(layer, cx)
        .deliver(&format!("{connection}/{pane}"), text)
        .await
        .map_err(|error| RpcError::new(error.to_string()))
}

/// `voiceErrandDeps.status`: what the session asks the user, its status
/// and the messages queued for it.
async fn errand_status(
    layer: &Arc<Layer>,
    cx: &FamilyContext,
    connection: &str,
    pane: &str,
) -> Result<Value, RpcError> {
    let Some(lease) = layer.ready(connection).ok().flatten() else {
        return Ok(Value::Null);
    };
    let prompts = reviews(cx, "prompts.list", json!({"connectionId": connection})).await?;
    let asked = prompts
        .as_array()
        .into_iter()
        .flatten()
        .find(|prompt| prompt["paneId"] == pane)
        .cloned();
    let mirror = layer.mirror(connection);
    let held = !mirror["leases"][pane].is_null();
    let mut status = held.then(|| {
        mirror["status"][pane]
            .as_str()
            .unwrap_or("stopped")
            .to_owned()
    });
    if status.is_none() {
        let info = lease
            .runtime
            .herdr()
            .call("agent.get", json!({"target": pane}), 5000, None, false)
            .await
            .ok();
        status = info.and_then(|info| info["agent"]["agent_status"].as_str().map(str::to_owned));
    }
    let waiting = asked.map(|asked| {
        let question = &asked["questions"][0]["question"];
        [question, &asked["summary"], &asked["tool"]]
            .into_iter()
            .find(|value| value.as_str().is_some_and(|text| !text.is_empty()))
            .cloned()
            .unwrap_or_else(|| asked["tool"].clone())
    });
    let queued =
        super::connections::messenger(layer, cx).waiting_for(&format!("{connection}/{pane}"));
    Ok(json!({
        "status": status,
        "waiting": waiting.unwrap_or(Value::Null),
        "queued": queued,
    }))
}
