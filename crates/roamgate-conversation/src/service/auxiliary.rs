//! The service's smaller parts: the API key question
//! (`service-api-key.ts`), turns that seem stuck (`service-stuck.ts`), the
//! chat's `!` lines (`service-shells.ts`) and idle stop
//! (`service-idle.ts`).

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use roamgate_agents::js;
use roamgate_agents::shared::bash_mode::{
    BASH_OUTPUT_LIMIT, bash_mode_texts, truncate_bash_output,
};
use roamgate_base::paths::random_uuid;
use serde_json::{Value, json};
use tokio::sync::oneshot;
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;

pub use roamgate_agents::shared::agent_models::{
    is_model_name, merge_models, model_refusal_text, model_switch_text,
};

use super::{Inner, obj_of, sv};
use crate::driver::ApiKeyAnswer;
use crate::idle_stop::{IdleStopFacts, idle_stop_refusal};
use crate::session::Prelude;
use crate::shared::{Obj, lease_str};
use crate::shell::ShellOutput;
use crate::time::sleep_ms;

const MAX_SHELLS: usize = 20;

/// `/model <name>`: the name; None for anything else (or `/model` alone).
pub fn parse_model_command(text: &str) -> Option<String> {
    roamgate_agents::shared::agent_models::parse_model_command(text).flatten()
}

type ApiKeyWaiter = oneshot::Sender<Result<Option<ApiKeyAnswer>, String>>;

struct ApiKeyEntry {
    question: Obj,
    waiters: Vec<(u64, ApiKeyWaiter)>,
}

struct Shell {
    pane: String,
    value: Obj,
}

#[derive(Default)]
pub(crate) struct AuxState {
    api_keys: Mutex<HashMap<String, ApiKeyEntry>>,
    next_waiter: Mutex<u64>,
    stuck: Mutex<HashMap<String, Obj>>,
    stop_timers: Mutex<HashMap<String, JoinHandle<()>>>,
    checking_stuck: Mutex<bool>,
    /// The `!` lines of each pane Claude has not read yet (by pane, in
    /// order), what each printed, and the stops of those running.
    shells: Mutex<HashMap<String, Vec<Arc<Mutex<Shell>>>>>,
    shell_runs: Mutex<HashMap<String, Arc<dyn Fn() + Send + Sync>>>,
    shell_timers: Mutex<HashMap<String, JoinHandle<()>>>,
    shell_output: Mutex<HashMap<String, (String, String)>>,
    last_peer: Mutex<HashMap<String, i64>>,
    checking_idle: Mutex<bool>,
}

impl Inner {
    // The API key question.

    /// Waits for the user's answer about the pane's API key; None when it
    /// came from elsewhere. Err: the start gives up.
    pub(crate) async fn ask_api_key(
        &self,
        pane_id: &str,
        signal: Option<CancellationToken>,
    ) -> Result<Option<ApiKeyAnswer>, String> {
        let (sender, receiver) = oneshot::channel();
        let id = {
            let mut next = self.aux.next_waiter.lock().unwrap();
            *next += 1;
            *next
        };
        let asked = {
            let mut keys = self.aux.api_keys.lock().unwrap();
            let fresh = !keys.contains_key(pane_id);
            let entry = keys
                .entry(pane_id.to_owned())
                .or_insert_with(|| ApiKeyEntry {
                    question: obj_of(json!({"asked_at": js::iso(self.now() as f64)})),
                    waiters: Vec::new(),
                });
            entry.waiters.push((id, sender));
            fresh.then(|| entry.question.clone())
        };
        if let Some(question) = asked {
            self.log(
                "Claude waits for the user's answer about the pane's API key",
                json!({"pane": pane_id}),
            );
            self.emit(
                pane_id,
                obj_of(json!({"type": "api_key_question", "api_key_question": question})),
            );
        }
        let signal = signal.unwrap_or_default();
        tokio::select! {
            answer = receiver => answer.unwrap_or(Ok(None)),
            () = signal.cancelled() => {
                let empty = {
                    let mut keys = self.aux.api_keys.lock().unwrap();
                    match keys.get_mut(pane_id) {
                        Some(entry) => {
                            entry.waiters.retain(|(each, _)| *each != id);
                            entry.waiters.is_empty()
                        }
                        None => false,
                    }
                };
                if empty {
                    self.settle_api_key(pane_id, None, None);
                }
                Err("Gave up waiting for the API key answer".into())
            }
        }
    }

    /// The question is answered (or moot), or with `error` the starts
    /// waiting on it give up; false if none waits.
    pub(crate) fn settle_api_key(
        &self,
        pane_id: &str,
        answer: Option<ApiKeyAnswer>,
        error: Option<String>,
    ) -> bool {
        let Some(entry) = self.aux.api_keys.lock().unwrap().remove(pane_id) else {
            return false;
        };
        if let Some(answer) = answer {
            self.log(
                "the user answered the API key question",
                json!({"pane": pane_id, "answer": answer.as_str()}),
            );
        }
        for (_, waiter) in entry.waiters {
            let _ = waiter.send(match &error {
                Some(error) => Err(error.clone()),
                None => Ok(answer),
            });
        }
        self.emit(
            pane_id,
            obj_of(json!({"type": "api_key_question", "api_key_question": null})),
        );
        true
    }

    pub(crate) fn api_key_waits(&self, pane_id: &str) -> bool {
        self.aux.api_keys.lock().unwrap().contains_key(pane_id)
    }

    pub(crate) fn api_key_question(&self, pane_id: &str) -> Option<Obj> {
        self.aux
            .api_keys
            .lock()
            .unwrap()
            .get(pane_id)
            .map(|entry| entry.question.clone())
    }

    // Turns that seem stuck.

    fn set_stuck(&self, pane_id: &str, next: Obj) {
        if self.closed() || !self.owns(pane_id) {
            return;
        }
        {
            let mut stuck = self.aux.stuck.lock().unwrap();
            if let Some(current) = stuck.get(pane_id)
                && current.get("reason") == next.get("reason")
                && current.get("since") == next.get("since")
            {
                return;
            }
            stuck.insert(pane_id.to_owned(), next.clone());
        }
        let mut fields = json!({"pane": pane_id});
        for (key, value) in &next {
            fields[key] = value.clone();
        }
        self.log("the turn seems stuck", fields);
        self.emit(
            pane_id,
            obj_of(json!({"type": "stuck", "stuck": Value::Object(next)})),
        );
    }

    pub(crate) fn clear_stuck(&self, pane_id: &str) {
        if let Some(timer) = self.aux.stop_timers.lock().unwrap().remove(pane_id) {
            timer.abort();
        }
        if self.aux.stuck.lock().unwrap().remove(pane_id).is_none() {
            return;
        }
        self.emit(pane_id, obj_of(json!({"type": "stuck", "stuck": null})));
    }

    pub(crate) fn stuck_of(&self, pane_id: &str) -> Option<Obj> {
        self.aux.stuck.lock().unwrap().get(pane_id).cloned()
    }

    pub(crate) fn stuck_output(&self, pane_id: &str) {
        let pending = self.aux.stuck.lock().unwrap().contains_key(pane_id)
            || self.aux.stop_timers.lock().unwrap().contains_key(pane_id);
        if pending {
            self.clear_stuck(pane_id);
        }
    }

    pub(crate) async fn check_stuck(&self) {
        if self.closed() {
            return;
        }
        {
            let mut checking = self.aux.checking_stuck.lock().unwrap();
            if *checking {
                return;
            }
            *checking = true;
        }
        let sessions: Vec<_> = self
            .sessions
            .lock()
            .unwrap()
            .iter()
            .map(|(pane, session)| (pane.clone(), session.clone()))
            .collect();
        for (pane, session) in sessions {
            if self
                .stuck_of(&pane)
                .is_some_and(|stuck| sv(stuck.get("reason")) == "stop_unanswered")
            {
                continue;
            }
            let activity = session.activity();
            if !activity.running || !self.owns(&pane) {
                self.clear_stuck(&pane);
                continue;
            }
            let limit = if activity.tools {
                self.options.stuck_tool_after_ms
            } else {
                self.options.stuck_after_ms
            };
            let mut since = activity.since;
            if self.now() - since < limit {
                continue;
            }
            if let Some(stat) = &self.options.transcript_stat
                && let Some(mtime) = stat(pane.clone()).await
                && mtime as i64 > since
            {
                since = mtime as i64;
            }
            if self.now() - since < limit {
                continue;
            }
            let same = self
                .session(&pane)
                .is_some_and(|current| current.same(&session));
            if !same || !session.activity().running {
                continue;
            }
            self.set_stuck(
                &pane,
                obj_of(json!({"since": js::iso(since as f64), "reason": "silent"})),
            );
        }
        *self.aux.checking_stuck.lock().unwrap() = false;
    }

    /// Stop that the agent does not answer: after a while the chat says so.
    pub(crate) async fn interrupt(&self, pane_id: &str) -> Result<bool, String> {
        let Some(session) = self.session(pane_id) else {
            return Ok(false);
        };
        let asked = self.now();
        let ok = session.interrupt().await?;
        if ok || self.closed() || !session.activity().running {
            return Ok(ok);
        }
        if let Some(previous) = self.aux.stop_timers.lock().unwrap().remove(pane_id) {
            previous.abort();
        }
        let wait = (self.options.stop_answer_ms - (self.now() - asked)).max(0) as u64;
        let me = self.me();
        let pane = pane_id.to_owned();
        let handle = tokio::spawn(async move {
            sleep_ms(&*me.options.clock, wait).await;
            me.aux.stop_timers.lock().unwrap().remove(&pane);
            let same = me
                .session(&pane)
                .is_some_and(|current| current.same(&session));
            if me.closed() || !same {
                return;
            }
            let activity = session.activity();
            if !activity.running || activity.since > asked {
                return;
            }
            me.set_stuck(
                &pane,
                obj_of(json!({
                    "since": js::iso(activity.since as f64),
                    "reason": "stop_unanswered",
                })),
            );
        });
        self.aux
            .stop_timers
            .lock()
            .unwrap()
            .insert(pane_id.to_owned(), handle);
        Ok(ok)
    }

    // The chat's `!` lines.

    fn emit_shell(&self, pane_id: &str, shell: &Obj, now: bool) {
        let id = sv(shell.get("id")).to_owned();
        if !now {
            let mut timers = self.aux.shell_timers.lock().unwrap();
            if timers.contains_key(&id) {
                return;
            }
            let me = self.me();
            let pane = pane_id.to_owned();
            let key = id.clone();
            timers.insert(
                id,
                tokio::spawn(async move {
                    sleep_ms(&*me.options.clock, 100).await;
                    me.aux.shell_timers.lock().unwrap().remove(&key);
                    let current = me.shell_value(&pane, &key);
                    if let Some(shell) = current {
                        me.emit(&pane, obj_of(json!({"type": "shell", "shell": shell})));
                    }
                }),
            );
            return;
        }
        if let Some(timer) = self.aux.shell_timers.lock().unwrap().remove(&id) {
            timer.abort();
        }
        self.emit(
            pane_id,
            obj_of(json!({"type": "shell", "shell": Value::Object(shell.clone())})),
        );
    }

    fn shell_value(&self, pane_id: &str, id: &str) -> Option<Obj> {
        self.aux
            .shells
            .lock()
            .unwrap()
            .get(pane_id)?
            .iter()
            .map(|each| each.lock().unwrap().value.clone())
            .find(|value| sv(value.get("id")) == id)
    }

    /// The `!` lines done since the last message, for the next one.
    pub(crate) fn take_shells(&self, pane_id: &str) -> Option<Prelude> {
        let done: Vec<Obj> = self
            .aux
            .shells
            .lock()
            .unwrap()
            .get(pane_id)?
            .iter()
            .map(|each| each.lock().unwrap().value.clone())
            .filter(|value| sv(value.get("status")) != "running")
            .collect();
        if done.is_empty() {
            return None;
        }
        let outputs = self.aux.shell_output.lock().unwrap().clone();
        let texts = done
            .iter()
            .flat_map(|each| {
                let id = sv(each.get("id"));
                let (stdout, stderr) = outputs.get(id).cloned().unwrap_or_else(|| {
                    (
                        sv(each.get("stdout")).to_owned(),
                        sv(each.get("stderr")).to_owned(),
                    )
                });
                let stderr = match each.get("error").and_then(Value::as_str) {
                    Some(error) => format!("{stderr}{error}"),
                    None => stderr,
                };
                bash_mode_texts(
                    sv(each.get("command")),
                    &truncate_bash_output(&stdout, BASH_OUTPUT_LIMIT).0,
                    &truncate_bash_output(&stderr, BASH_OUTPUT_LIMIT).0,
                )
            })
            .collect();
        let me = self.me();
        let pane = pane_id.to_owned();
        Some(Prelude {
            texts,
            commit: Box::new(move || {
                let sent: Vec<String> = done
                    .iter()
                    .map(|each| sv(each.get("id")).to_owned())
                    .collect();
                {
                    let mut outputs = me.aux.shell_output.lock().unwrap();
                    for id in &sent {
                        outputs.remove(id);
                    }
                }
                if let Some(list) = me.aux.shells.lock().unwrap().get_mut(&pane) {
                    list.retain(|each| {
                        !sent
                            .iter()
                            .any(|id| id == sv(each.lock().unwrap().value.get("id")))
                    });
                }
                for each in done {
                    let mut delivered = each;
                    delivered.insert("delivered".into(), json!(true));
                    me.emit_shell(&pane, &delivered, true);
                }
            }),
        })
    }

    /// Runs a `!` line typed in the chat on the pane's host.
    pub(crate) fn run_shell(
        &self,
        pane_id: &str,
        command: &str,
        id: Option<String>,
    ) -> Result<Value, String> {
        let Some(runner) = self.options.run_shell.clone() else {
            return Err("Shell lines are unavailable on this connection".into());
        };
        self.session_for(pane_id)?;
        let cwd = self
            .lease(pane_id)
            .and_then(|lease| lease_str(&lease, "cwd").map(str::to_owned))
            .unwrap_or_default();
        {
            let shells = self.aux.shells.lock().unwrap();
            let list = shells.get(pane_id);
            if let Some(id) = &id
                && list.is_some_and(|list| {
                    list.iter()
                        .any(|each| sv(each.lock().unwrap().value.get("id")) == id)
                })
            {
                return Ok(json!({"id": id}));
            }
            if list.is_some_and(|list| list.len() >= MAX_SHELLS) {
                return Err(format!(
                    "{MAX_SHELLS} commands wait for Claude: send a message first"
                ));
            }
        }
        let id = id.unwrap_or_else(random_uuid);
        let value = obj_of(json!({
            "id": id,
            "command": command,
            "status": "running",
            "stdout": "",
            "stderr": "",
            "truncated": false,
            "exit_code": null,
            "cwd": cwd,
            "started_at": js::iso(self.now() as f64),
        }));
        let shell = Arc::new(Mutex::new(Shell {
            pane: pane_id.to_owned(),
            value: value.clone(),
        }));
        self.aux
            .shells
            .lock()
            .unwrap()
            .entry(pane_id.to_owned())
            .or_default()
            .push(shell.clone());
        self.emit_shell(pane_id, &value, true);
        let me = self.me();
        let output_shell = shell.clone();
        let output_me = me.clone();
        let run = runner.run(
            &cwd,
            command,
            Arc::new(move |output: ShellOutput| {
                let id = {
                    let mut each = output_shell.lock().unwrap();
                    let id = sv(each.value.get("id")).to_owned();
                    let limit = |text: &str| js::slice16(text, 0, Some(BASH_OUTPUT_LIMIT as i64));
                    each.value
                        .insert("stdout".into(), json!(limit(&output.stdout)));
                    each.value
                        .insert("stderr".into(), json!(limit(&output.stderr)));
                    each.value.insert(
                        "truncated".into(),
                        json!(
                            output.truncated
                                || js::len16(&output.stdout) > BASH_OUTPUT_LIMIT
                                || js::len16(&output.stderr) > BASH_OUTPUT_LIMIT
                        ),
                    );
                    id
                };
                output_me
                    .aux
                    .shell_output
                    .lock()
                    .unwrap()
                    .insert(id, (output.stdout, output.stderr));
                let (pane, value) = {
                    let each = output_shell.lock().unwrap();
                    (each.pane.clone(), each.value.clone())
                };
                output_me.emit_shell(&pane, &value, false);
            }),
        );
        let stop = run.stop.clone();
        self.aux.shell_runs.lock().unwrap().insert(id.clone(), stop);
        let done = run.done;
        let pane = pane_id.to_owned();
        tokio::spawn(async move {
            let (status, code, error) = match done.await {
                Ok(done) => (
                    if done.stopped { "stopped" } else { "done" },
                    done.code.map(Value::from).unwrap_or(Value::Null),
                    None,
                ),
                Err(error) => ("failed", Value::Null, Some(error)),
            };
            me.finish_shell(&pane, &shell, status, code, error);
        });
        Ok(json!({"id": id}))
    }

    fn finish_shell(
        &self,
        pane_id: &str,
        shell: &Arc<Mutex<Shell>>,
        status: &str,
        code: Value,
        error: Option<String>,
    ) {
        let value = {
            let mut each = shell.lock().unwrap();
            let id = sv(each.value.get("id")).to_owned();
            self.aux.shell_runs.lock().unwrap().remove(&id);
            each.value.insert("status".into(), json!(status));
            each.value.insert("exit_code".into(), code.clone());
            each.value
                .insert("finished_at".into(), json!(js::iso(self.now() as f64)));
            if let Some(error) = error {
                each.value.insert("error".into(), json!(error));
            }
            each.value.clone()
        };
        self.log(
            "shell line ended",
            json!({"pane": pane_id, "status": status, "code": code}),
        );
        self.emit_shell(pane_id, &value, true);
    }

    pub(crate) fn stop_shell(&self, pane_id: &str, id: &str) -> bool {
        let Some(stop) = self.aux.shell_runs.lock().unwrap().get(id).cloned() else {
            return false;
        };
        let known = self
            .aux
            .shells
            .lock()
            .unwrap()
            .get(pane_id)
            .is_some_and(|list| {
                list.iter()
                    .any(|each| sv(each.lock().unwrap().value.get("id")) == id)
            });
        if !known {
            return false;
        }
        stop();
        true
    }

    pub(crate) fn shell_list(&self, pane_id: &str) -> Vec<Obj> {
        self.aux
            .shells
            .lock()
            .unwrap()
            .get(pane_id)
            .map(|list| {
                list.iter()
                    .map(|each| each.lock().unwrap().value.clone())
                    .collect()
            })
            .unwrap_or_default()
    }

    pub(crate) fn shells_running(&self, pane_id: &str) -> bool {
        self.shell_list(pane_id)
            .iter()
            .any(|each| sv(each.get("status")) == "running")
    }

    pub(crate) fn dispose_shells(&self) {
        for stop in self.aux.shell_runs.lock().unwrap().values() {
            stop();
        }
        for (_, timer) in self.aux.shell_timers.lock().unwrap().drain() {
            timer.abort();
        }
    }

    // Idle stop.

    pub(crate) fn note_peer(&self, pane_id: &str) {
        self.aux
            .last_peer
            .lock()
            .unwrap()
            .insert(pane_id.to_owned(), self.now());
    }

    pub(crate) fn forget_peer(&self, pane_id: &str) {
        self.aux.last_peer.lock().unwrap().remove(pane_id);
    }

    pub(crate) fn set_asleep(&self, pane_id: &str, asleep: bool) {
        if self.closed() {
            return;
        }
        let guard = self.lease_lock.lock().unwrap();
        let Some(current) = self.lease(pane_id) else {
            return;
        };
        if current.contains_key("asleep_at") == asleep {
            return;
        }
        let mut next = current;
        if asleep {
            next.insert("asleep_at".into(), json!(js::iso(self.now() as f64)));
        } else {
            next.shift_remove("asleep_at");
        }
        let since = next.get("asleep_at").cloned();
        self.set_lease(next);
        drop(guard);
        self.emit(
            pane_id,
            obj_of(json!({
                "type": "asleep",
                "asleep": since.map(|since| json!({"since": since})).unwrap_or(Value::Null),
            })),
        );
    }

    pub(crate) async fn check_idle(&self) {
        let Some(minutes) = self.options.idle_stop_minutes.clone() else {
            return;
        };
        if self.closed() {
            return;
        }
        {
            let mut checking = self.aux.checking_idle.lock().unwrap();
            if *checking {
                return;
            }
            *checking = true;
        }
        let minutes = minutes().await;
        if minutes > 0.0 {
            let sessions: Vec<_> = self
                .sessions
                .lock()
                .unwrap()
                .iter()
                .map(|(pane, session)| (pane.clone(), session.clone()))
                .collect();
            for (pane, session) in sessions {
                let kept_awake = match &self.options.keep_awake {
                    Some(keep) => keep(pane.clone()).await,
                    None => None,
                };
                let live = session.state();
                let refusal = idle_stop_refusal(&IdleStopFacts {
                    limit_ms: (minutes * 60_000.0) as i64,
                    now: self.now(),
                    idle_since: session.idle_since(),
                    last_peer_at: self.aux.last_peer.lock().unwrap().get(&pane).copied(),
                    peer_quiet_ms: self.options.peer_quiet_ms,
                    conversation: self.owns(&pane) && !self.handover.running(&pane),
                    alive: session.alive() && !session.asleep(),
                    status: sv(live.get("status")).to_owned(),
                    busy: session.busy(),
                    queued: live
                        .get("queue")
                        .and_then(Value::as_array)
                        .map_or(0, Vec::len),
                    background_tasks: session.background_tasks(),
                    shell_running: self.shells_running(&pane),
                    api_key_question: self.api_key_waits(&pane),
                    kept_awake,
                });
                if refusal.is_some() {
                    continue;
                }
                self.log(
                    "idle conversation stopped; its next message wakes it",
                    json!({
                        "pane": pane,
                        "idle_minutes": ((self.now() - session.idle_since()) as f64 / 60_000.0).round(),
                    }),
                );
                tokio::spawn(async move {
                    session.sleep_process().await;
                });
            }
        }
        *self.aux.checking_idle.lock().unwrap() = false;
    }

    pub(crate) fn dispose_aux(&self) {
        for (_, timer) in self.aux.stop_timers.lock().unwrap().drain() {
            timer.abort();
        }
    }
}
