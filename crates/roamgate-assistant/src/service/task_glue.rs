//! What the scheduled tasks ask of the service: a task prepared and checked
//! (`prepareTask`, `validatePreparedTask`), a run's workspaces found again
//! (`narrowTask`, `rescopeTask`, `reidentify`, `awaitConnections`), and each
//! run as a child service (`child`).

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use roamgate_agents::js;
use serde_json::{Map, Value, json};
use tokio::sync::Notify;
use tokio_util::sync::CancellationToken;

use super::turn::is_user_error;
use super::util::*;
use super::{AssistantService, Inner, ServiceOptions, State, configured_in, throw_if};
use crate::context::{CapturedScope, ContextOp, Scope};
use crate::errors::{AssistantError, AssistantResult};
use crate::saved::ref_key;
use crate::tasks::{
    AssistantTasks, BeforeDispatch, MakeChild, Narrow, Publish, Rescope, ScheduledChild,
    TaskOptions, Validate,
};
use crate::tools::BoxFuture;
use crate::wire::ASSISTANT_MAX_WORKSPACES;

type Refreshed = HashMap<String, (Value, Value)>;

fn list(value: &Value) -> Vec<Value> {
    value.as_array().cloned().unwrap_or_default()
}

fn keys(values: &[Value]) -> Vec<String> {
    values.iter().map(ref_key).collect()
}

fn unavailable() -> AssistantError {
    err("Ranger unavailable")
}

pub(super) fn create_tasks(inner: &Arc<Inner>) -> AssistantTasks {
    let weak = Arc::downgrade(inner);
    let publish = {
        let weak = weak.clone();
        Arc::new(move || {
            if let Some(inner) = weak.upgrade() {
                inner.on_task_publish();
            }
        })
    };
    let validate: Validate = {
        let weak = weak.clone();
        Arc::new(move |prepared, signal| {
            let weak = weak.clone();
            Box::pin(async move {
                let inner = weak.upgrade().ok_or_else(unavailable)?;
                inner.validate_prepared_task(&prepared, Some(signal)).await
            })
        })
    };
    let validate_cleanup: Validate = {
        let weak = weak.clone();
        Arc::new(move |prepared, signal| {
            let weak = weak.clone();
            Box::pin(async move {
                let inner = weak.upgrade().ok_or_else(unavailable)?;
                inner.workspace_catalog().await?;
                throw_if(Some(&signal))?;
                let s = inner.lock();
                if s.disposed {
                    return Err(unavailable());
                }
                // Pausing/deleting our own scheduler state and stopping its
                // child do not dispatch to a workspace.
                inner.assert_scope_value(&s, &prepared["input"]["scope"])
            })
        })
    };
    let rescope: Rescope = {
        let weak = weak.clone();
        Arc::new(move |prepared, signal| {
            let weak = weak.clone();
            Box::pin(async move {
                let inner = weak.upgrade().ok_or_else(unavailable)?;
                inner.rescope_task(&prepared, Some(signal)).await
            })
        })
    };
    let narrow: Narrow = {
        let weak = weak.clone();
        Arc::new(move |prepared, signal, wait| {
            let weak = weak.clone();
            Box::pin(async move {
                let inner = weak.upgrade().ok_or_else(unavailable)?;
                inner.narrow_task(&prepared, signal, wait).await
            })
        })
    };
    let child: MakeChild = {
        let weak = weak.clone();
        Arc::new(
            move |task_run: Value, directory: PathBuf, publish: Publish, before: BeforeDispatch| {
                let inner = weak.upgrade().expect("the service makes its task runs");
                inner.child(task_run, directory, publish, before)
            },
        )
    };
    AssistantTasks::new(TaskOptions {
        directory: inner.directory.clone(),
        context: inner.options.data.clone(),
        clock: inner.options.clock.clone(),
        publish,
        notify: inner.options.notify.clone(),
        validate,
        validate_cleanup: Some(validate_cleanup),
        rescope: Some(rescope),
        narrow: Some(narrow),
        child,
    })
}

/// A task run as the tasks start and stop it: a child service.
struct ChildRun {
    child: AssistantService,
    task_run: Value,
}

impl ScheduledChild for ChildRun {
    fn start(&self, recover: bool) -> BoxFuture<AssistantResult<()>> {
        let child = self.child.clone();
        let run = self.task_run.clone();
        Box::pin(async move {
            if recover && child.peek()["running"] == true {
                return child.resume().await;
            }
            let params = json!({"request_id": run["id"], "text": run["input"]["prompt"]});
            match child.handle("send", params).await {
                Ok(_) => Ok(()),
                Err(error)
                    if is_user_error(&error)
                        || matches!(error, AssistantError::RecoveryNotReady(_)) =>
                {
                    Err(error)
                }
                // send's own fixed messages: it masks provider errors.
                Err(error) => {
                    let message = error.message();
                    let message = message.strip_suffix('.').unwrap_or(message);
                    Err(user(format!("Ranger could not start the run: {message}.")))
                }
            }
        })
    }

    fn resume(&self) -> BoxFuture<AssistantResult<()>> {
        let child = self.child.clone();
        Box::pin(async move { child.resume().await })
    }

    fn stop(&self) -> BoxFuture<AssistantResult<()>> {
        let child = self.child.clone();
        Box::pin(async move { child.handle("stop", json!({})).await.map(|_| ()) })
    }

    fn action(&self, method: &str, action_id: &str) -> BoxFuture<AssistantResult<()>> {
        let child = self.child.clone();
        let method = format!("action.{method}");
        let params = json!({"action_id": action_id});
        Box::pin(async move { child.handle(&method, params).await.map(|_| ()) })
    }

    fn snapshot(&self) -> Value {
        self.child.peek()
    }

    fn dispose(&self) -> BoxFuture<AssistantResult<()>> {
        let child = self.child.clone();
        Box::pin(async move {
            child.dispose().await;
            Ok(())
        })
    }
}

impl Inner {
    fn child(
        &self,
        task_run: Value,
        directory: PathBuf,
        publish: Publish,
        before: BeforeDispatch,
    ) -> Arc<dyn ScheduledChild> {
        let weak = self.weak.clone();
        let options = &self.options;
        let task_id = js::sv(task_run.get("task_id")).to_owned();
        let run_id = js::sv(task_run.get("id")).to_owned();
        let tasks = self.tasks().cloned();
        let send_notification: Option<super::SendNotification> =
            options.notify.as_ref().map(|_| {
                let tasks = tasks.clone();
                let (task_id, run_id) = (task_id.clone(), run_id.clone());
                Arc::new(
                    move |notification: Value, signal: Option<CancellationToken>| {
                        let tasks = tasks.clone();
                        let (task_id, run_id) = (task_id.clone(), run_id.clone());
                        Box::pin(async move {
                            let tasks = tasks.ok_or_else(unavailable)?;
                            tasks
                                .notify_run(&task_id, &run_id, &notification, signal)
                                .await
                        }) as crate::tools::ToolFuture
                    },
                ) as super::SendNotification
            });
        let history: super::NotificationHistory = {
            let tasks = tasks.clone();
            let (task_id, run_id) = (task_id.clone(), run_id.clone());
            Arc::new(move || {
                tasks
                    .as_ref()
                    .ok_or_else(unavailable)?
                    .notification_history(&task_id, Some(&run_id))
            })
        };
        let driver = options
            .create_driver
            .as_ref()
            .map(|create| create(directory.clone(), self.directory.clone()))
            .unwrap_or_else(|| (options.default_driver)(directory.clone(), self.directory.clone()));
        let allowed = weak.clone();
        let refresh = weak.clone();
        let mode = weak.clone();
        let child = AssistantService::new(ServiceOptions {
            context: self.base_context.clone(),
            publish,
            notify: None,
            send_notification,
            notification_history: Some(history),
            directory: Some(directory),
            data: options.data.clone(),
            clock: options.clock.clone(),
            driver: Some(driver),
            create_driver: None,
            default_driver: options.default_driver.clone(),
            task_run: Some(task_run.clone()),
            before_task_dispatch: Some(before),
            global_allowed: None,
            global_workspace_allowed: Some(Arc::new(move |item: &Value| {
                allowed.upgrade().is_some_and(|inner| {
                    let s = inner.lock();
                    inner.workspace_allowed(&s, item)
                })
            })),
            refresh_global_scope: Some(Arc::new(move || {
                let refresh = refresh.clone();
                Box::pin(async move {
                    let inner = refresh.upgrade().ok_or_else(unavailable)?;
                    inner.workspace_catalog().await.map(|_| ())
                })
            })),
            global_approval_mode: Some(Arc::new(move || {
                mode.upgrade()
                    .and_then(|inner| inner.lock().approval_mode())
            })),
            workspace_tree: options.workspace_tree.clone(),
            archive: options.archive.clone(),
            chat_threads: None,
        });
        Arc::new(ChildRun { child, task_run })
    }

    /// A task's workspace as named when the task was saved.
    fn saved_name(prepared: &Value, item: &Value) -> String {
        let saved = prepared["workspaces"]
            .as_array()
            .and_then(|w| w.iter().find(|w| same_ref(w, item)));
        let pick = |key: &str, fallback: &str| {
            saved
                .and_then(|s| s.get(key))
                .and_then(Value::as_str)
                .filter(|t| !t.is_empty())
                .map(str::to_owned)
                .unwrap_or_else(|| js::sv(item.get(fallback)).to_owned())
        };
        format!(
            "{} / {}",
            pick("connection_label", "connection_id"),
            pick("label", "workspace_id")
        )
    }

    /// The task targets Ranger may not use now, named and with why.
    fn refused_targets(&self, s: &State, prepared: &Value) -> Option<String> {
        let refused: Vec<String> = list(&prepared["targets"])
            .iter()
            .filter(|t| !self.workspace_allowed(s, t))
            .map(|t| {
                format!(
                    "{} ({})",
                    Self::saved_name(prepared, t),
                    if self.workspace_removed(s, t) {
                        "closed"
                    } else {
                        "no longer allowed"
                    }
                )
            })
            .collect();
        (!refused.is_empty()).then(|| named_list(&refused))
    }

    /// Why a task's workspace is gone: its connection was removed, or it was
    /// closed, perhaps then opened again under a new id.
    async fn gone_reason(
        &self,
        prepared: &Value,
        target: &Value,
        signal: Option<&CancellationToken>,
    ) -> AssistantResult<String> {
        let candidates: Vec<Value> = {
            let s = self.lock();
            let inventory = s.workspace_inventory.clone().unwrap_or(Value::Null);
            if let Some(ids) = inventory.get("connection_ids").and_then(Value::as_array)
                && !ids.iter().any(|id| Some(id) == target.get("connection_id"))
            {
                return Ok("connection removed".into());
            }
            let label = prepared["workspaces"]
                .as_array()
                .and_then(|w| w.iter().find(|w| same_ref(w, target)))
                .and_then(|w| w.get("label").cloned());
            let held = keys(&list(&prepared["targets"]));
            list(&inventory["workspaces"])
                .into_iter()
                .filter(|item| {
                    item.get("connection_id") == target.get("connection_id")
                        && item.get("label") == label.as_ref()
                        && !held.contains(&ref_key(item))
                        && self.workspace_allowed(&s, item)
                })
                .collect()
        };
        for candidate in candidates.into_iter().take(5) {
            let found = async {
                let captured = self
                    .context
                    .capture_scope(json!([candidate]), signal.cloned(), None)
                    .await?;
                let fresh = if self.context.provides(ContextOp::RecoveryScope) {
                    self.context
                        .recovery_scope(&captured, signal.cloned())
                        .await?
                } else {
                    json!([])
                };
                Ok::<_, AssistantError>(fresh.get(0).cloned())
            }
            .await;
            match found {
                Ok(Some(found))
                    if found.get("workspace_identity") == target.get("workspace_identity") =>
                {
                    return Ok(format!(
                        "recreated as {}",
                        js::sv(candidate.get("workspace_id"))
                    ));
                }
                Ok(_) => {}
                Err(_) => throw_if(signal)?,
            }
        }
        Ok("closed".into())
    }

    /// The task's connections that are down now (`downConnections`).
    fn down_connections(&self, ids: &[String]) -> Vec<Value> {
        let mut seen: Vec<&String> = Vec::new();
        let mut down = Vec::new();
        for id in ids {
            if seen.contains(&id) {
                continue;
            }
            seen.push(id);
            if let Some(Value::Object(mut status)) = self.context.connection_state(id)
                && status.get("state") != Some(&json!("ready"))
            {
                status.insert("id".into(), json!(id));
                down.push(Value::Object(status));
            }
        }
        down
    }

    /// `awaitConnections`: waits up to TASK_CONNECTION_WAIT_MS for the
    /// connections that may come back on their own.
    async fn await_connections(
        &self,
        ids: &[String],
        signal: Option<&CancellationToken>,
    ) -> AssistantResult<Vec<Value>> {
        let passing = || {
            self.down_connections(ids)
                .iter()
                .any(|item| PASSING_CONNECTION_STATES.contains(&js::sv(item.get("state"))))
        };
        if !passing() || !self.context.provides(ContextOp::WatchConnections) {
            return Ok(self.down_connections(ids));
        }
        if signal.is_some_and(CancellationToken::is_cancelled) {
            return Err(aborted());
        }
        let changed = Arc::new(Notify::new());
        let listener = {
            let changed = changed.clone();
            Arc::new(move || changed.notify_one()) as Arc<dyn Fn() + Send + Sync>
        };
        let unwatch = self.context.watch_connections(listener);
        let timer = self
            .options
            .clock
            .sleep(Duration::from_millis(TASK_CONNECTION_WAIT_MS));
        tokio::pin!(timer);
        let stopped = signal.cloned().unwrap_or_default();
        let outcome = loop {
            if !passing() {
                break Ok(());
            }
            tokio::select! {
                _ = changed.notified() => {}
                _ = &mut timer => break Ok(()),
                _ = stopped.cancelled() => break Err(aborted()),
            }
        };
        unwatch();
        outcome?;
        throw_if(signal)?;
        // A connection back lists its workspaces again.
        self.workspace_catalog().await?;
        throw_if(signal)?;
        Ok(self.down_connections(ids))
    }

    /// `reidentify(targets)`: the targets on connections whose Herdr
    /// restarted since they were checked, found again by their id.
    async fn reidentify(
        &self,
        targets: &[Value],
        signal: Option<&CancellationToken>,
    ) -> AssistantResult<(Refreshed, Vec<(Value, String)>, Vec<String>)> {
        let mut refreshed: Refreshed = HashMap::new();
        let mut changed: Vec<(Value, String)> = Vec::new();
        let mut restarted: Vec<String> = Vec::new();
        if !self.context.provides(ContextOp::RecoveryScope) {
            return Ok((refreshed, changed, restarted));
        }
        let mut by_connection: Vec<(String, Vec<Value>)> = Vec::new();
        for target in targets {
            let id = js::sv(target.get("connection_id")).to_owned();
            match by_connection.iter_mut().find(|(c, _)| *c == id) {
                Some((_, items)) => items.push(target.clone()),
                None => by_connection.push((id, vec![target.clone()])),
            }
        }
        let check = |stale: Vec<Value>| async move {
            let captured = self
                .context
                .capture_scope(Value::Array(stale.clone()), signal.cloned(), None)
                .await?;
            let fresh = self
                .context
                .recovery_scope(&captured, signal.cloned())
                .await?;
            if list(&fresh).len() != stale.len() {
                return Err(err("Unchecked workspace identity"));
            }
            Ok::<_, AssistantError>((list(&captured.workspaces), list(&fresh)))
        };
        for (connection, saved) in by_connection {
            let probe = async {
                let probe = self
                    .context
                    .capture_scope(json!([saved[0]]), signal.cloned(), None)
                    .await?;
                let label = probe.workspaces[0]
                    .get("connection_label")
                    .and_then(Value::as_str)
                    .filter(|l| !l.is_empty())
                    .unwrap_or(&connection)
                    .to_owned();
                let current = self.context.recovery_scope(&probe, signal.cloned()).await?;
                Ok::<_, AssistantError>((label, current.get(0).cloned()))
            }
            .await;
            let (label, current) = match probe {
                Ok(found) => found,
                Err(_) => {
                    throw_if(signal)?;
                    continue;
                }
            };
            let Some(current) = current.filter(|current| {
                current.get("endpoint_fingerprint") == saved[0].get("endpoint_fingerprint")
            }) else {
                continue;
            };
            let stale: Vec<Value> = saved
                .iter()
                .filter(|t| t.get("herdr_boot_id") != current.get("herdr_boot_id"))
                .cloned()
                .collect();
            if stale.is_empty() {
                continue;
            }
            restarted.push(label.clone());
            let found = |target: &Value, current: &Value, workspace: &Value| {
                if ref_key(current) != ref_key(target)
                    || current.get("workspace_identity") != target.get("workspace_identity")
                    || current.get("endpoint_fingerprint") != target.get("endpoint_fingerprint")
                {
                    Err((
                        target.clone(),
                        "its id now holds another workspace".to_owned(),
                    ))
                } else {
                    Ok((ref_key(target), (current.clone(), workspace.clone())))
                }
            };
            let mut record =
                |outcome: Result<(String, (Value, Value)), (Value, String)>| match outcome {
                    Ok((key, value)) => {
                        refreshed.insert(key, value);
                    }
                    Err(change) => changed.push(change),
                };
            match check(stale.clone()).await {
                Ok((captured, fresh)) => {
                    for (index, target) in stale.iter().enumerate() {
                        record(found(
                            target,
                            fresh.get(index).unwrap_or(&Value::Null),
                            captured.get(index).unwrap_or(&Value::Null),
                        ));
                    }
                }
                Err(_) => {
                    throw_if(signal)?;
                    // One that cannot be read must not keep the others from the run.
                    for target in &stale {
                        match check(vec![target.clone()]).await {
                            Ok((captured, fresh)) => record(found(
                                target,
                                fresh.first().unwrap_or(&Value::Null),
                                captured.first().unwrap_or(&Value::Null),
                            )),
                            Err(_) => {
                                throw_if(signal)?;
                                record(Err((
                                    target.clone(),
                                    format!(
                                        "could not be checked again after Herdr on {label} restarted"
                                    ),
                                )));
                            }
                        }
                    }
                }
            }
        }
        Ok((refreshed, changed, restarted))
    }

    /// `narrowTask`: a new run of a task over fixed workspaces runs over
    /// those still open and says which it skipped.
    async fn narrow_task(
        &self,
        prepared: &Value,
        signal: Option<CancellationToken>,
        wait: bool,
    ) -> AssistantResult<Option<Value>> {
        let signal = signal.as_ref();
        self.workspace_catalog().await?;
        throw_if(signal)?;
        let targets = list(&prepared["targets"]);
        let connections: Vec<String> = {
            let s = self.lock();
            targets
                .iter()
                .filter(|t| !self.workspace_removed(&s, t))
                .map(|t| js::sv(t.get("connection_id")).to_owned())
                .collect()
        };
        let down = if wait {
            self.await_connections(&connections, signal).await?
        } else {
            self.down_connections(&connections)
        };
        let down_ids: Vec<&str> = down.iter().map(|d| js::sv(d.get("id"))).collect();
        let (gone, away, open) = {
            let s = self.lock();
            let mut gone = Vec::new();
            let mut away = Vec::new();
            let mut open = Vec::new();
            for target in &targets {
                if self.workspace_removed(&s, target) {
                    gone.push(target.clone());
                } else if down_ids.contains(&js::sv(target.get("connection_id"))) {
                    away.push(target.clone());
                } else {
                    open.push(target.clone());
                }
            }
            (gone, away, open)
        };
        let (refreshed, changed, restarted) = self.reidentify(&open, signal).await?;
        throw_if(signal)?;
        if gone.is_empty() && away.is_empty() && changed.is_empty() && refreshed.is_empty() {
            return Ok(None);
        }
        let mut skipped = Vec::new();
        for target in &gone {
            skipped.push(format!(
                "{} ({})",
                Self::saved_name(prepared, target),
                self.gone_reason(prepared, target, signal).await?
            ));
        }
        for (target, why) in &changed {
            skipped.push(format!("{} ({why})", Self::saved_name(prepared, target)));
        }
        throw_if(signal)?;
        let unreachable: Vec<String> = down
            .iter()
            .filter_map(|item| {
                let count = away
                    .iter()
                    .filter(|t| t.get("connection_id") == item.get("id"))
                    .count();
                (count > 0).then(|| {
                    let label = item
                        .get("label")
                        .and_then(Value::as_str)
                        .filter(|l| !l.is_empty())
                        .unwrap_or(js::sv(item.get("id")));
                    format!(
                        "{label} unreachable: {} skipped ({})",
                        if count == 1 {
                            "a workspace".to_owned()
                        } else {
                            format!("{count} workspaces")
                        },
                        connection_why(item)
                    )
                })
            })
            .collect();
        if gone.len() + away.len() + changed.len() == targets.len() {
            // A check before the run: the run waits for them first.
            if !wait && !away.is_empty() {
                return Err(AssistantError::RecoveryNotReady(
                    "None of the task's workspaces can be reached yet.".into(),
                ));
            }
            return Err(user(if away.is_empty() {
                format!(
                    "None of the task's workspaces is open any more: {}. Edit the task to choose its workspaces again.",
                    named_list(&skipped)
                )
            } else {
                let mut parts = unreachable.clone();
                if !skipped.is_empty() {
                    parts.push(format!("no longer open: {}", named_list(&skipped)));
                }
                format!(
                    "None of the task's workspaces can be reached: {}.",
                    parts.join("; ")
                )
            }));
        }
        let left: Vec<String> = gone
            .iter()
            .chain(&away)
            .chain(changed.iter().map(|(t, _)| t))
            .map(ref_key)
            .collect();
        let keep = |values: &Value| -> Vec<Value> {
            list(values)
                .into_iter()
                .filter(|r| !left.contains(&ref_key(r)))
                .collect()
        };
        let mut input = match prepared["input"].clone() {
            Value::Object(map) => map,
            _ => Map::new(),
        };
        let mentions = input.shift_remove("mentions");
        input.insert(
            "scope".into(),
            Value::Array(keep(&prepared["input"]["scope"])),
        );
        if let Some(mentions) = mentions {
            let kept = keep(&mentions);
            if !kept.is_empty() {
                input.insert("mentions".into(), Value::Array(kept));
            }
        }
        let mut config = prepared["config"].clone();
        config["allowed_workspaces"] =
            Value::Array(keep(&prepared["config"]["allowed_workspaces"]));
        let mut notices = Vec::new();
        if !restarted.is_empty() {
            notices.push(format!(
                "Herdr on {} restarted since the task was saved: its workspaces were checked again.",
                named_list(&restarted)
            ));
        }
        notices.extend(unreachable.iter().map(|line| format!("{line}.")));
        if !skipped.is_empty() {
            notices.push(format!(
                "Skipped {} no longer open: {}. Edit the task to update its workspaces.",
                if skipped.len() == 1 {
                    "a workspace".to_owned()
                } else {
                    format!("{} workspaces", skipped.len())
                },
                named_list(&skipped)
            ));
        }
        let targets: Vec<Value> = keep(&prepared["targets"])
            .into_iter()
            .map(|t| {
                refreshed
                    .get(&ref_key(&t))
                    .map_or(t, |(fresh, _)| fresh.clone())
            })
            .collect();
        let workspaces: Vec<Value> = keep(&prepared["workspaces"])
            .into_iter()
            .map(|w| {
                refreshed
                    .get(&ref_key(&w))
                    .map_or(w, |(_, fresh)| fresh.clone())
            })
            .collect();
        Ok(Some(json!({
            "input": input,
            "config": config,
            "targets": targets,
            "workspaces": workspaces,
            "notice": notices.join(" "),
        })))
    }

    /// `validatePreparedTask`: the task's model, permission and workspaces,
    /// checked again before it is saved or run.
    async fn validate_prepared_task(
        &self,
        prepared: &Value,
        signal: Option<CancellationToken>,
    ) -> AssistantResult<()> {
        let signal = signal.as_ref();
        let changing =
            || AssistantError::RecoveryNotReady("The model connection is changing.".into());
        throw_if(signal)?;
        if self.lock().model_changing {
            return Err(changing());
        }
        self.workspace_catalog().await?;
        throw_if(signal)?;
        {
            let s = self.lock();
            let refused = self.refused_targets(&s, prepared);
            if list(&prepared["targets"]).is_empty()
                || !self.context.provides(ContextOp::RestoreScope)
                || refused.is_some()
            {
                return Err(user(match refused {
                    Some(refused) => {
                        format!("The original task permission is unavailable for {refused}.")
                    }
                    None => "The original task permission is unavailable.".into(),
                }));
            }
        }
        let config = &prepared["config"];
        let available = match self
            .driver
            .catalog(js::sv(config.get("credential_source")))
            .await
        {
            Ok(available) => available,
            Err(_) => {
                throw_if(signal)?;
                // Provider errors can carry credentials: say which.
                return Err(user(models_unlisted(js::sv(config.get("provider")))));
            }
        };
        let restore = async {
            let restored = self
                .context
                .restore_scope(prepared["targets"].clone(), signal.cloned())
                .await?;
            if let Some(mentions) = prepared["input"]["mentions"]
                .as_array()
                .filter(|m| !m.is_empty())
            {
                if !self.context.provides(ContextOp::BindMentions) {
                    return Err(user("This bridge cannot restore the task's references."));
                }
                let targets = restored_mentions(mentions, &restored.workspaces)?;
                self.context
                    .bind_mentions(&restored, Value::Array(targets), signal.cloned())
                    .await?;
            }
            Ok(())
        };
        if let Err(error) = restore.await {
            throw_if(signal)?;
            if is_user_error(&error) || matches!(error, AssistantError::RecoveryNotReady(_)) {
                return Err(error);
            }
            // The workspace context's own messages: transport details are
            // masked there already.
            return Err(user(format!(
                "The task's workspaces could not be checked: {}.",
                error.message()
            )));
        }
        throw_if(signal)?;
        let s = self.lock();
        if s.model_changing {
            return Err(changing());
        }
        if let Some(revoked) = self.refused_targets(&s, prepared) {
            return Err(user(format!(
                "The original task permission is unavailable for {revoked}."
            )));
        }
        if s.disposed || !configured_in(&available, config) {
            return Err(user(
                "The original task model or permission is unavailable.",
            ));
        }
        Self::check_thinking(config, &available["models"])
    }

    /// `prepareTask`: a task's input checked, its workspaces captured and
    /// identified, its model and permission validated.
    pub(super) async fn prepare_task(
        &self,
        value: Value,
        signal: Option<CancellationToken>,
        captured_turn: Option<Scope>,
        admitted_config: Option<Value>,
        inherited_mentions: Option<Vec<Value>>,
    ) -> AssistantResult<Value> {
        let mut input = crate::saved::validate_task_input(&value)?;
        let scope = list(&input["scope"]);
        let selected = keys(&scope);
        if let Some(inherited) = inherited_mentions.filter(|m| !m.is_empty()) {
            let mentions: Vec<Value> = inherited
                .into_iter()
                .filter(|t| selected.contains(&ref_key(t)))
                .collect();
            if !mentions.is_empty() {
                input["mentions"] = Value::Array(mentions);
            }
        }
        // A tool proposal belongs to the admitted turn.
        let task_config = admitted_config.unwrap_or_else(|| self.lock().config.clone());
        self.workspace_catalog().await?;
        throw_if(signal.as_ref())?;
        {
            let s = self.lock();
            let turn = captured_turn
                .as_ref()
                .map(|scope| keys(&list(&scope.workspaces)));
            if scope.iter().any(|r| {
                !self.workspace_allowed(&s, r)
                    || turn
                        .as_ref()
                        .is_some_and(|turn| !turn.contains(&ref_key(r)))
            }) {
                return Err(user("Choose an authorized task scope."));
            }
        }
        if !self.context.provides(ContextOp::RecoveryScope)
            || !self.context.provides(ContextOp::RestoreScope)
        {
            return Err(user(
                "These workspace connections do not support safe scheduled tasks.",
            ));
        }
        let original = match captured_turn {
            Some(scope) => scope,
            None => {
                self.context
                    .capture_scope(Value::Array(scope.clone()), signal.clone(), None)
                    .await?
            }
        };
        if input["mentions"].as_array().is_some_and(|m| !m.is_empty()) {
            if !self.context.provides(ContextOp::BindMentions) {
                return Err(err("Task references are unavailable."));
            }
            input["mentions"] = self
                .context
                .bind_mentions(&original, input["mentions"].clone(), signal.clone())
                .await?;
        }
        let targets: Vec<Value> = list(
            &self
                .context
                .recovery_scope(&original, signal.clone())
                .await?,
        )
        .into_iter()
        .filter(|t| selected.contains(&ref_key(t)))
        .collect();
        if targets.len() != scope.len() {
            return Err(user(
                "These workspace connections do not support safe scheduled tasks: the endpoint handshake did not provide a stable Herdr boot identity. Upgrade the Herdr server and try again.",
            ));
        }
        let workspaces = self
            .context
            .restore_scope(Value::Array(targets.clone()), signal.clone())
            .await?;
        let mut config = task_config;
        config["allowed_workspaces"] = Value::Array(scope);
        let prepared = json!({
            "input": input,
            "targets": targets,
            "workspaces": workspaces.workspaces,
            "config": config,
        });
        self.validate_prepared_task(&prepared, signal).await?;
        Ok(prepared)
    }

    /// `rescopeTask`: a task over all workspaces, prepared again over every
    /// workspace Ranger may use now.
    async fn rescope_task(
        &self,
        prepared: &Value,
        signal: Option<CancellationToken>,
    ) -> AssistantResult<Value> {
        self.workspace_catalog().await?;
        throw_if(signal.as_ref())?;
        if !self.context.provides(ContextOp::RecoveryScope) {
            return Err(user(
                "These workspace connections do not support safe scheduled tasks.",
            ));
        }
        let connections: Vec<String> = {
            let s = self.lock();
            if self.all_workspaces(&s.config) {
                s.workspace_inventory
                    .as_ref()
                    .and_then(|i| i["connection_ids"].as_array())
                    .into_iter()
                    .flatten()
                    .map(|id| js::sv(Some(id)).to_owned())
                    .collect()
            } else {
                self.effective_scope(&s, &s.config)
                    .iter()
                    .map(|r| js::sv(r.get("connection_id")).to_owned())
                    .collect()
            }
        };
        let down = self
            .await_connections(&connections, signal.as_ref())
            .await?;
        let unreachable: Vec<String> = down
            .iter()
            .map(|item| {
                let label = item
                    .get("label")
                    .and_then(Value::as_str)
                    .filter(|l| !l.is_empty())
                    .unwrap_or(js::sv(item.get("id")));
                format!(
                    "{label} unreachable: its workspaces were skipped ({})",
                    connection_why(item)
                )
            })
            .collect();
        let (allowed, cut) = {
            let s = self.lock();
            let inventory = s.workspace_inventory.clone().unwrap_or(Value::Null);
            let listed = keys(&list(&inventory["workspaces"]));
            let granted = self.effective_scope(&s, &s.config);
            let usable: Vec<Value> = granted
                .iter()
                .filter(|r| listed.contains(&ref_key(r)) && self.workspace_allowed(&s, r))
                .cloned()
                .collect();
            let allowed: Vec<Value> = usable
                .iter()
                .take(ASSISTANT_MAX_WORKSPACES)
                .cloned()
                .collect();
            // Past the limit, in the grant or in a listing, workspaces are left out.
            let cut = usable.len() > allowed.len()
                || (inventory["truncated"] == true
                    && (self.all_workspaces(&s.config) || usable.len() < granted.len()));
            (allowed, cut)
        };
        let captured = self
            .context
            .capture_scope(Value::Array(allowed.clone()), signal.clone(), None)
            .await?;
        let supported = keys(&list(
            &self
                .context
                .recovery_scope(&captured, signal.clone())
                .await?,
        ));
        let scope: Vec<Value> = allowed
            .into_iter()
            .filter(|r| supported.contains(&ref_key(r)))
            .collect();
        if scope.is_empty() {
            return Err(user(if unreachable.is_empty() {
                "No workspace Ranger may use is available for this task.".to_owned()
            } else {
                format!(
                    "No workspace Ranger may use can be reached for this task: {}.",
                    unreachable.join("; ")
                )
            }));
        }
        let in_scope = keys(&scope);
        let mut input = match prepared["input"].clone() {
            Value::Object(map) => map,
            _ => Map::new(),
        };
        let mentions = input.shift_remove("mentions");
        input.insert("scope".into(), Value::Array(scope));
        if let Some(mentions) = mentions {
            let kept: Vec<Value> = list(&mentions)
                .into_iter()
                .filter(|m| in_scope.contains(&ref_key(m)))
                .collect();
            if !kept.is_empty() {
                input.insert("mentions".into(), Value::Array(kept));
            }
        }
        let turn = CapturedScope::plain(Value::Array(
            list(&captured.workspaces)
                .into_iter()
                .filter(|w| in_scope.contains(&ref_key(w)))
                .collect(),
        ));
        let mut rescoped = Box::pin(self.prepare_task(
            Value::Object(input),
            signal,
            Some(turn),
            Some(prepared["config"].clone()),
            None,
        ))
        .await?;
        let mut notices: Vec<String> = unreachable.iter().map(|line| format!("{line}.")).collect();
        if cut {
            notices.push(format!(
                "Ranger uses at most {ASSISTANT_MAX_WORKSPACES} workspaces at once: this run may have left out some it may use."
            ));
        }
        if !notices.is_empty() {
            rescoped["notice"] = json!(notices.join(" "));
        }
        Ok(rescoped)
    }
}
