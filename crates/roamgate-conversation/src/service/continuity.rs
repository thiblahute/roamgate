//! The service's side of continuity: recording a conversation's events in
//! its work session as they come, and `switch_agent`, which moves the
//! conversation to another agent with one writer at a time.

use std::collections::HashMap;
use std::sync::Mutex;

use roamgate_base::paths::random_uuid;
use serde_json::{Map, Value, json};

use crate::continuity::{
    BootstrapOptions, CanonicalEventKind, ExternalJob, QueuedHandoffMessage, Recovery,
    export_bootstrap,
};
use crate::holder::hold_reply;
use crate::shared::{Obj, lease_str};

use super::{Inner, fail, obj_of, sv};

/// The id of the message that gives an agent the history it is switched
/// to: not the user's, so not recorded as theirs.
const BOOTSTRAP_PREFIX: &str = "roamgate-continuation-";

/// How long a switch waits for the outgoing agent's interrupted turn.
const SWITCH_INTERRUPT_WAIT_MS: u64 = 3000;

/// A pane's running tool calls: id to (name, input summary).
type RunningTools = HashMap<String, (String, String)>;

#[derive(Default)]
pub(crate) struct ContinuityRuntime {
    /// Each pane's running tool calls (name, input summary), for the
    /// record of their results.
    tools: Mutex<HashMap<String, RunningTools>>,
    /// The images of messages sent, by id, until the agent has them (its
    /// replay counts them only).
    images: Mutex<HashMap<String, Vec<String>>>,
}

fn summarize(value: Option<&Value>, max_chars: usize) -> String {
    let raw = match value {
        None | Some(Value::Null) => String::new(),
        Some(Value::String(s)) => s.clone(),
        Some(other) => other.to_string(),
    };
    let single = raw.replace('\n', " ");
    let mut out: String = single.chars().take(max_chars).collect();
    if single.chars().count() > max_chars {
        out.push_str("...");
    }
    out
}

fn strings(value: Option<&Value>) -> Vec<String> {
    value
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|item| item.as_str().map(str::to_owned))
                .collect()
        })
        .unwrap_or_default()
}

fn queue_item(message: &QueuedHandoffMessage) -> Value {
    json!({
        "id": message.id,
        "text": message.text,
        "images": message.images,
        "queued_at": message.queued_at,
    })
}

impl Inner {
    /// Keeps a message's images for its record.
    pub(crate) fn remember_images(&self, id: &str, images: &[String]) {
        if !images.is_empty() {
            self.continuity_rt
                .images
                .lock()
                .unwrap()
                .insert(id.to_owned(), images.to_vec());
        }
    }

    /// The pane's work session, created with its lease's first event.
    pub(crate) fn work_session_id(&self, pane_id: &str) -> Option<String> {
        let _guard = self.lease_lock.lock().unwrap();
        let mut lease = self.lease(pane_id)?;
        if lease_str(&lease, "phase") != Some("conversation") {
            return None;
        }
        if let Some(id) = lease_str(&lease, "work_session_id") {
            return Some(id.to_owned());
        }
        let id = self.continuity.create(
            pane_id,
            lease_str(&lease, "agent").unwrap_or("claude"),
            lease_str(&lease, "session_id").unwrap_or(""),
            lease_str(&lease, "cwd").unwrap_or(""),
        );
        lease.insert("work_session_id".into(), json!(id));
        self.set_lease(lease);
        Some(id)
    }

    /// The pane's `!` lines, as the incoming agent of a switch reads them.
    fn external_jobs(&self, pane_id: &str) -> Vec<ExternalJob> {
        self.shell_list(pane_id)
            .into_iter()
            .map(|shell| {
                let status = sv(shell.get("status"));
                let output = [sv(shell.get("stdout")), sv(shell.get("stderr"))]
                    .into_iter()
                    .filter(|text| !text.is_empty())
                    .collect::<Vec<_>>()
                    .join("\n");
                let tail: String = {
                    let chars: Vec<char> = output.chars().collect();
                    chars[chars.len().saturating_sub(300)..].iter().collect()
                };
                ExternalJob {
                    id: sv(shell.get("id")).to_owned(),
                    kind: "shell".into(),
                    label: sv(shell.get("command")).to_owned(),
                    status: if status.is_empty() {
                        "running".into()
                    } else {
                        status.to_owned()
                    },
                    exit_code: shell
                        .get("exit_code")
                        .and_then(Value::as_i64)
                        .map(|code| code as i32),
                    output_tail: (!tail.is_empty()).then_some(tail),
                }
            })
            .collect()
    }

    /// Records what the session says in the pane's work session: the
    /// user's messages once the agent has them, tool calls once they
    /// ended, each turn's answer.
    pub(crate) fn observe_session_event(&self, pane_id: &str, event: &Obj) {
        match sv(event.get("type")) {
            "user" => {
                let uuid = sv(event.get("uuid"));
                if uuid.starts_with(BOOTSTRAP_PREFIX) {
                    return;
                }
                let images = self
                    .continuity_rt
                    .images
                    .lock()
                    .unwrap()
                    .remove(uuid)
                    .unwrap_or_default();
                let Some(id) = self.work_session_id(pane_id) else {
                    return;
                };
                self.continuity.record_event(
                    &id,
                    "user",
                    CanonicalEventKind::UserMessage {
                        text: sv(event.get("text")).to_owned(),
                        images,
                    },
                    (!uuid.is_empty()).then(|| format!("user:{uuid}")),
                );
            }
            "tool_use" => {
                let tool_id = sv(event.get("tool_use_id"));
                if tool_id.is_empty() {
                    return;
                }
                let name = match sv(event.get("name")) {
                    "" => "tool",
                    name => name,
                };
                self.continuity_rt
                    .tools
                    .lock()
                    .unwrap()
                    .entry(pane_id.to_owned())
                    .or_default()
                    .insert(
                        tool_id.to_owned(),
                        (name.to_owned(), summarize(event.get("input"), 240)),
                    );
            }
            "tool_result" => {
                let tool_id = sv(event.get("tool_use_id"));
                if tool_id.is_empty() {
                    return;
                }
                let (name, input_summary) = self
                    .continuity_rt
                    .tools
                    .lock()
                    .unwrap()
                    .get_mut(pane_id)
                    .and_then(|tools| tools.remove(tool_id))
                    .unwrap_or_else(|| ("tool".into(), String::new()));
                let Some(id) = self.work_session_id(pane_id) else {
                    return;
                };
                let agent = self.driver_of(pane_id).protocol.agent().to_owned();
                self.continuity.record_event(
                    &id,
                    &agent,
                    CanonicalEventKind::ToolRecord {
                        tool_call_id: tool_id.to_owned(),
                        name,
                        input_summary,
                        output_summary: summarize(event.get("text"), 400),
                        is_error: event.get("is_error") == Some(&Value::Bool(true)),
                    },
                    Some(format!("tool:{tool_id}")),
                );
            }
            "result" => {
                let text = sv(event.get("text"));
                if event.get("is_error") == Some(&Value::Bool(true)) || text.trim().is_empty() {
                    return;
                }
                let Some(id) = self.work_session_id(pane_id) else {
                    return;
                };
                let agent = self.driver_of(pane_id).protocol.agent().to_owned();
                let model = self.session(pane_id).and_then(|s| s.model());
                self.continuity.record_event(
                    &id,
                    &agent,
                    CanonicalEventKind::AssistantMessage {
                        text: text.to_owned(),
                        model,
                    },
                    None,
                );
            }
            _ => {}
        }
    }

    /// Keeps a message sent while the pane's agent is being switched, for
    /// the incoming agent; None when no switch runs.
    pub(crate) fn queue_during_switch(
        &self,
        pane_id: &str,
        text: &str,
        images: &[String],
        uuid: Option<String>,
    ) -> Option<Value> {
        let lease = self.lease(pane_id)?;
        lease.get("handoff_phase")?;
        let ws = lease_str(&lease, "work_session_id")?;
        let id = uuid.unwrap_or_else(random_uuid);
        let message = QueuedHandoffMessage {
            id: id.clone(),
            text: text.to_owned(),
            images: images.to_vec(),
            queued_at: self.iso_now(),
        };
        self.continuity
            .queue_during_handoff(ws, message)
            .then(|| json!({"status": "queued", "id": id}))
    }

    /// `agent_chat.state`'s work session fields.
    pub(crate) fn populate_continuity_state(&self, pane_id: &str, state: &mut Map<String, Value>) {
        let Some(lease) = self.lease(pane_id) else {
            return;
        };
        if let Some(id) = lease_str(&lease, "work_session_id") {
            state.insert("work_session_id".into(), json!(id));
        }
        if let Some(phase) = lease_str(&lease, "handoff_phase") {
            state.insert("handoff_phase".into(), json!(phase));
        }
    }

    fn set_lease_handoff_phase(&self, pane_id: &str, phase: Option<&str>) {
        let _guard = self.lease_lock.lock().unwrap();
        let Some(mut lease) = self.lease(pane_id) else {
            return;
        };
        match phase {
            Some(phase) => {
                lease.insert("handoff_phase".into(), json!(phase));
            }
            None => {
                lease.shift_remove("handoff_phase");
            }
        }
        self.set_lease(lease);
    }

    /// Gives messages back to the pane's lease queue: they go out with the
    /// next process.
    fn requeue(&self, pane_id: &str, first: Option<Value>, messages: &[QueuedHandoffMessage]) {
        if first.is_none() && messages.is_empty() {
            return;
        }
        let _guard = self.lease_lock.lock().unwrap();
        let Some(mut lease) = self.lease(pane_id) else {
            return;
        };
        let mut queue: Vec<Value> = first.into_iter().collect();
        queue.extend(messages.iter().map(queue_item));
        if let Some(Value::Array(earlier)) = lease.get("queue") {
            queue.extend(earlier.iter().cloned());
        }
        lease.insert("queue".into(), Value::Array(queue));
        self.set_lease(lease);
    }

    /// Ends the switches a restart cut short, before any process starts:
    /// one agent writes. Then forgets the work sessions no lease names.
    pub(crate) fn recover_switches(&self) {
        let mut used = Vec::new();
        for lease in self.options.leases.all() {
            let Some(id) = lease_str(&lease, "work_session_id").map(str::to_owned) else {
                continue;
            };
            used.push(id.clone());
            let pane = lease_str(&lease, "pane_id").unwrap_or("").to_owned();
            let agent = self.driver_of(&pane).protocol.agent().to_owned();
            let Some(recovery) = self.continuity.recover(&id, &agent) else {
                if lease.contains_key("handoff_phase") {
                    self.set_lease_handoff_phase(&pane, None);
                }
                continue;
            };
            self.set_lease_handoff_phase(&pane, None);
            match recovery {
                Recovery::RolledBack { phase, queued } => {
                    self.log(
                        "a switch to another agent was cut short; the conversation stays",
                        json!({"pane": pane, "phase": phase.as_str(), "agent": agent}),
                    );
                    self.requeue(&pane, None, &queued);
                }
                Recovery::Finished { queued } => {
                    self.log(
                        "a switch to another agent was cut short once it had moved; it is finished",
                        json!({"pane": pane, "agent": agent}),
                    );
                    // Whether the agent got the history is not known: it
                    // gets it again, first.
                    let bootstrap = self.continuity.read_with(&id, |session| {
                        let mut previous = session.clone();
                        if let Some(from) =
                            session
                                .events
                                .iter()
                                .rev()
                                .find_map(|event| match &event.kind {
                                    CanonicalEventKind::BackendSwitch { from_agent, .. } => {
                                        Some(from_agent.clone())
                                    }
                                    _ => None,
                                })
                        {
                            previous.active_agent = from;
                        }
                        export_bootstrap(
                            &previous,
                            &agent,
                            &BootstrapOptions {
                                force_fresh_native_session: true,
                                ..BootstrapOptions::default()
                            },
                        )
                    });
                    let first = bootstrap.map(|package| {
                        json!({
                            "id": format!("{BOOTSTRAP_PREFIX}{}", &random_uuid()[..8]),
                            "text": package.prompt_text,
                            "images": package.images,
                            "queued_at": self.iso_now(),
                        })
                    });
                    self.requeue(&pane, first, &queued);
                }
            }
        }
        self.continuity.remove_unused(&used);
    }

    /// Moves an owned conversation to another agent (`switch_agent`):
    /// the outgoing agent is stopped (its turn interrupted, what it cut
    /// off recorded), the lease names the incoming one, which is given the
    /// history it has not seen, then the messages sent meanwhile.
    pub(crate) async fn switch_agent(
        &self,
        pane_id: &str,
        target_agent: &str,
        reason: &str,
        fresh_session: bool,
    ) -> Value {
        if self.closed() {
            return fail("The connection is closing");
        }
        let Some(lease) = self.lease(pane_id) else {
            return fail("Conversation mode does not own this pane");
        };
        if lease_str(&lease, "phase") != Some("conversation") || self.handover.running(pane_id) {
            return fail("This session is being handed over; try again shortly");
        }
        if !self
            .options
            .drivers
            .all()
            .iter()
            .any(|d| d.protocol.agent() == target_agent)
        {
            return fail(format!("Conversation mode cannot drive {target_agent}"));
        }
        let from_agent = self.driver_of(pane_id).protocol.agent().to_owned();
        let Some(ws) = self.work_session_id(pane_id) else {
            return fail("Conversation mode does not own this pane");
        };
        if from_agent == target_agent {
            return json!({
                "ok": true,
                "unchanged": true,
                "agent": target_agent,
                "work_session_id": ws,
                "session_id": lease_str(&lease, "session_id"),
            });
        }

        // Running -> Quiescing: the outgoing agent stops.
        let generation = match self.continuity.begin_quiescing(&ws, target_agent, reason) {
            Ok(generation) => generation,
            Err(error) => return fail(error),
        };
        self.set_lease_handoff_phase(pane_id, Some("quiescing"));
        let mut resync_safe = true;
        let outgoing = self.sessions.lock().unwrap().remove(pane_id);
        if let Some(old) = outgoing {
            let running: Vec<String> = strings(old.state().get("running_tools"));
            if old.busy() {
                let _ = old.interrupt().await;
                if !old.wait_for_result(SWITCH_INTERRUPT_WAIT_MS).await {
                    resync_safe = false;
                }
            }
            for tool_id in running {
                let (name, input) = self
                    .continuity_rt
                    .tools
                    .lock()
                    .unwrap()
                    .get_mut(pane_id)
                    .and_then(|tools| tools.remove(&tool_id))
                    .unwrap_or_else(|| ("tool".into(), String::new()));
                self.continuity.record_event(
                    &ws,
                    &from_agent,
                    CanonicalEventKind::UncertainAction {
                        tool_call_id: Some(tool_id.clone()),
                        summary: format!("{name} ({input})"),
                        name,
                    },
                    Some(format!("uncertain:{tool_id}")),
                );
            }
            // What waited in its queue goes to the incoming agent, once.
            for item in old.take_queue() {
                self.continuity.queue_during_handoff(
                    &ws,
                    QueuedHandoffMessage {
                        id: sv(item.get("id")).to_owned(),
                        text: sv(item.get("text")).to_owned(),
                        images: strings(item.get("images")),
                        queued_at: sv(item.get("queued_at")).to_owned(),
                    },
                );
            }
            if !old.stop().await {
                resync_safe = false;
            }
            old.dispose(false);
        }
        self.continuity_rt.tools.lock().unwrap().remove(pane_id);

        // Quiescing -> Checkpointed.
        let snapshot = match self.continuity.mark_checkpointed(
            &ws,
            generation,
            resync_safe,
            self.external_jobs(pane_id),
        ) {
            Ok(snapshot) => snapshot,
            Err(error) => {
                let queued = self.continuity.abort_switch(&ws, generation);
                self.set_lease_handoff_phase(pane_id, None);
                self.requeue(pane_id, None, &queued);
                return fail(error);
            }
        };
        self.set_lease_handoff_phase(pane_id, Some("checkpointed"));

        // Checkpointed -> StartingReplacement: the lease names the
        // incoming agent, its terminal flags dropped (the outgoing
        // agent's).
        let bootstrap = export_bootstrap(
            &snapshot,
            target_agent,
            &BootstrapOptions {
                force_fresh_native_session: fresh_session,
                ..BootstrapOptions::default()
            },
        );
        let native = bootstrap
            .reused_native_session_id
            .clone()
            .unwrap_or_else(|| {
                self.options
                    .drivers
                    .of(Some(target_agent))
                    .protocol
                    .new_session_id()
            });
        if let Err(error) = self.continuity.begin_starting_replacement(
            &ws,
            generation,
            &native,
            bootstrap.reused_execution_id.as_deref(),
        ) {
            let queued = self.continuity.abort_switch(&ws, generation);
            self.set_lease_handoff_phase(pane_id, None);
            self.requeue(pane_id, None, &queued);
            return fail(error);
        }
        let previous = {
            let _guard = self.lease_lock.lock().unwrap();
            let Some(previous) = self.lease(pane_id) else {
                drop(_guard);
                self.continuity.abort_switch(&ws, generation);
                return fail("Conversation mode does not own this pane any more");
            };
            let mut next = previous.clone();
            next.insert("agent".into(), json!(target_agent));
            next.insert("session_id".into(), json!(native));
            next.insert("handoff_phase".into(), json!("starting_replacement"));
            for key in ["asleep_at", "interrupted", "holder"] {
                next.shift_remove(key);
            }
            // Each agent keeps its own terminal flags.
            let mut kept = match next.shift_remove("agent_terminal_args") {
                Some(Value::Object(kept)) => kept,
                _ => Map::new(),
            };
            if let Some(args) = next.shift_remove("terminal_args") {
                kept.insert(from_agent.clone(), args);
            }
            if let Some(args) = kept.remove(target_agent) {
                next.insert("terminal_args".into(), args);
            }
            if !kept.is_empty() {
                next.insert("agent_terminal_args".into(), Value::Object(kept));
            }
            self.set_lease(next);
            previous
        };
        self.holders.send(pane_id, &hold_reply(&native));

        let replacement = match self.session_for(pane_id) {
            Ok(session) => session,
            Err(error) => {
                self.roll_back_switch(pane_id, &ws, generation, previous);
                return fail(error);
            }
        };
        let bootstrap_id = format!("{BOOTSTRAP_PREFIX}{}", &random_uuid()[..8]);
        if let Err(error) = replacement
            .send(
                &bootstrap.prompt_text,
                bootstrap.images.clone(),
                Some(bootstrap_id),
            )
            .await
        {
            self.sessions.lock().unwrap().remove(pane_id);
            replacement.dispose(false);
            self.roll_back_switch(pane_id, &ws, generation, previous);
            return fail(format!("{target_agent} did not start: {error}"));
        }
        // What was sent so far goes now, behind the history.
        for queued in self.continuity.take_handoff_queue(&ws) {
            self.remember_images(&queued.id, &queued.images);
            let _ = replacement
                .send(&queued.text, queued.images, Some(queued.id))
                .await;
        }

        // StartingReplacement -> Running.
        let (updated, late) = match self.continuity.finish_switch(&ws, generation) {
            Ok(done) => done,
            Err(error) => {
                self.set_lease_handoff_phase(pane_id, None);
                return fail(error);
            }
        };
        self.set_lease_handoff_phase(pane_id, None);
        for queued in late {
            self.remember_images(&queued.id, &queued.images);
            let _ = replacement
                .send(&queued.text, queued.images, Some(queued.id))
                .await;
        }
        // None until an agent that names its sessions has.
        let session_id = self
            .lease(pane_id)
            .and_then(|l| lease_str(&l, "session_id").map(str::to_owned))
            .unwrap_or(native)
            .clone();
        let session_id = (session_id != crate::driver::UNNAMED_SESSION_ID).then_some(session_id);
        let reused = bootstrap.reused_execution_id.is_some();
        self.log(
            "conversation moved to another agent",
            json!({
                "pane": pane_id,
                "from": from_agent,
                "to": target_agent,
                "reason": reason,
                "from_seq": bootstrap.from_seq,
                "through_seq": bootstrap.through_seq,
                "reused": reused,
            }),
        );
        self.emit_lease(pane_id);
        self.emit(
            pane_id,
            obj_of(json!({
                "type": "backend_switched",
                "from_agent": from_agent,
                "to_agent": target_agent,
                "work_session_id": ws,
                "session_id": session_id,
                "reason": reason,
                "capabilities": self.options.drivers.of(Some(target_agent)).protocol.capabilities(),
                "at": self.iso_now(),
            })),
        );
        self.report(pane_id, "working");
        json!({
            "ok": true,
            "work_session_id": ws,
            "from_agent": from_agent,
            "agent": target_agent,
            "session_id": session_id,
            "checkpoint_version": updated.checkpoint.version,
            "from_seq": bootstrap.from_seq,
            "through_seq": bootstrap.through_seq,
            "reused_session": reused,
        })
    }

    /// The incoming agent did not start: the lease is the outgoing
    /// agent's again, and what was sent meanwhile waits for it.
    fn roll_back_switch(&self, pane_id: &str, ws: &str, generation: u64, mut previous: Obj) {
        let queued = self.continuity.abort_switch(ws, generation);
        {
            let _guard = self.lease_lock.lock().unwrap();
            previous.shift_remove("handoff_phase");
            self.set_lease(previous);
        }
        self.requeue(pane_id, None, &queued);
        self.emit_lease(pane_id);
    }
}
