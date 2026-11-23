//! The pane holders (roamgate-hold) as one runtime sees them
//! (`service-holders.ts`): each one's channel, saved on its lease as it is
//! read, their requests from the review socket, and the guarded start of
//! the headless process they run (`service-start.ts`).

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex, Weak};

use serde_json::{Map, Value, json};
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;

use super::{Inner, obj_of, sv};
use crate::driver::{BoxFuture, HeadlessProcess, StartOptions};
use crate::handover::SuspendedSpec;
use crate::headless::{HeadlessSpawnOptions, SpawnHeadless};
use crate::holder::{HolderReply, HolderShell, hold_reply, refused_reply, resume_reply};
use crate::pane_child::{
    HolderApiKey, HolderChannel, HolderChannelOptions, HolderOutput, HolderSaved, HolderSpawn,
    HolderStatus,
};
use crate::shared::{Obj, lease_str, with_model};
use crate::time::sleep_ms;

/// No holder answered for a pane conversation mode owns (`HolderMissing`).
pub const HOLDER_MISSING: &str =
    "The pane holder is not running; show the terminal to take the session back";
const RELEASED_MS: i64 = 10 * 60_000;

#[derive(Default)]
pub(crate) struct HolderSideState {
    channels: Mutex<HashMap<String, HolderChannel>>,
    save_timers: Mutex<HashMap<String, JoinHandle<()>>>,
    strangers: Mutex<HashSet<String>>,
}

/// One holder request (`hold`'s and `fg`'s input).
#[derive(Clone, Debug, Default)]
pub struct HolderSideInput {
    pub pane_id: String,
    pub session_id: String,
    /// What a holder that runs the headless agent says of it.
    pub status: Option<HolderStatus>,
    /// What it says of itself and its shell (an older one: nothing).
    pub shell: Option<HolderShell>,
    /// Cancelled when the request goes away.
    pub signal: Option<CancellationToken>,
}

/// A holder status as Bun's agent socket parsed it (`HolderStatus`,
/// camelCase); None from a holder without a child.
pub fn parse_holder_status_value(value: &Value) -> Option<HolderStatus> {
    let status = value.as_object()?;
    let number = |key: &str| status.get(key).and_then(Value::as_f64).map(|n| n as u64);
    Some(HolderStatus {
        holder_id: status.get("holderId")?.as_str()?.to_owned(),
        applied: number("applied")?,
        child: number("child")?,
        child_alive: status
            .get("childAlive")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        child_pid: number("childPid").unwrap_or(0),
        log_size: number("logSize")?,
        epoch_offset: number("epochOffset")?,
        api_key: match status.get("apiKey").and_then(Value::as_str) {
            Some("none") => Some(HolderApiKey::None),
            Some("approved") => Some(HolderApiKey::Approved),
            Some("rejected") => Some(HolderApiKey::Rejected),
            Some("new") => Some(HolderApiKey::New),
            _ => None,
        },
    })
}

/// A holder's shell as Bun's agent socket parsed it (`HolderShell`).
pub fn parse_holder_shell_value(value: &Value) -> Option<HolderShell> {
    let shell = value.as_object()?;
    Some(HolderShell {
        job_control: shell
            .get("jobControl")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        pid: shell
            .get("pid")
            .and_then(Value::as_u64)
            .map(|pid| pid as u32),
        job: shell.get("job").and_then(Value::as_str).map(str::to_owned),
    })
}

impl Inner {
    pub(crate) fn channel(&self, pane_id: &str) -> Option<HolderChannel> {
        self.holder_side
            .channels
            .lock()
            .unwrap()
            .get(pane_id)
            .cloned()
    }

    pub(crate) fn has_channel(&self, pane_id: &str) -> bool {
        self.holder_side
            .channels
            .lock()
            .unwrap()
            .contains_key(pane_id)
    }

    /// Saves on the lease how far the holder's log was read.
    pub(crate) fn save_holder(&self, pane_id: &str) {
        if let Some(timer) = self.holder_side.save_timers.lock().unwrap().remove(pane_id) {
            timer.abort();
        }
        let Some(saved) = self.channel(pane_id).and_then(|channel| channel.save()) else {
            return;
        };
        // Where the conversation's lines were handled to, and its state.
        let resume = match self.session(pane_id).map(|session| session.resume_state()) {
            Some(state) => state.to_value(),
            None => None,
        };
        let _guard = self.lease_lock.lock().unwrap();
        let Some(lease) = self.lease(pane_id) else {
            return;
        };
        if lease_str(&lease, "phase") != Some("conversation") {
            return;
        }
        let resume = match resume {
            Some(resume) => resume,
            None => {
                let held = lease.get("holder");
                if held.and_then(|held| held.get("id")).and_then(Value::as_str)
                    == Some(saved.id.as_str())
                {
                    held.and_then(|held| held.get("resume"))
                        .cloned()
                        .unwrap_or(Value::Null)
                } else {
                    Value::Null
                }
            }
        };
        let mut holder = match saved.to_value() {
            Value::Object(map) => map,
            _ => Map::new(),
        };
        holder.shift_remove("resume");
        if !resume.is_null() {
            holder.insert("resume".into(), resume);
        }
        let mut next = lease;
        next.insert("holder".into(), Value::Object(holder));
        self.set_lease(next);
    }

    pub(crate) fn channel_for(&self, pane_id: &str) -> HolderChannel {
        if let Some(channel) = self.channel(pane_id) {
            return channel;
        }
        let saved = self
            .lease(pane_id)
            .and_then(|lease| lease.get("holder").and_then(HolderSaved::from_value));
        let me = self.me.clone();
        let pane = pane_id.to_owned();
        let work_me = me.clone();
        let work_pane = pane.clone();
        let pending_me = me.clone();
        let pending_pane = pane.clone();
        let offset_me = me.clone();
        let offset_pane = pane.clone();
        let kind_me = me.clone();
        let kind_pane = pane.clone();
        let channel = HolderChannel::new(HolderChannelOptions {
            pane_id: pane.clone(),
            saved,
            on_work: Arc::new(move || {
                let Some(me) = work_me.upgrade() else { return };
                if let Some(lease) = me.lease(&work_pane) {
                    me.holders.send(
                        &work_pane,
                        &hold_reply(lease_str(&lease, "session_id").unwrap_or("")),
                    );
                }
            }),
            on_offset: Some(Arc::new(move |_holder: &str, _offset: u64| {
                let Some(me) = offset_me.upgrade() else {
                    return;
                };
                let pane = offset_pane.as_str();
                if me.closed()
                    || me
                        .holder_side
                        .save_timers
                        .lock()
                        .unwrap()
                        .contains_key(pane)
                {
                    return;
                }
                let timer_me = me.clone();
                let key = pane.to_owned();
                let handle = tokio::spawn(async move {
                    sleep_ms(&*timer_me.options.clock, timer_me.options.holder_save_ms).await;
                    timer_me
                        .holder_side
                        .save_timers
                        .lock()
                        .unwrap()
                        .remove(&key);
                    if !timer_me.closed() {
                        timer_me.save_holder(&key);
                    }
                });
                me.holder_side
                    .save_timers
                    .lock()
                    .unwrap()
                    .insert(pane.to_owned(), handle);
            })),
            // Saved at once, off the caller's stack: a write to the process
            // may come from inside its session, which the save reads.
            on_pending: Some(Arc::new(move || {
                if let Some(me) = pending_me.upgrade()
                    && !me.closed()
                {
                    let pane = pending_pane.clone();
                    tokio::spawn(async move {
                        if !me.closed() {
                            me.save_holder(&pane);
                        }
                    });
                }
            })),
            input_kind: Arc::new(move |line: &str| match kind_me.upgrade() {
                Some(me) => me.driver_of(&kind_pane).protocol.input_kind(line),
                None => crate::driver::InputKind {
                    kind: String::new(),
                    request_id: None,
                },
            }),
            log: self.options.log.clone(),
            clock: self.options.clock.clone(),
        });
        self.holder_side
            .channels
            .lock()
            .unwrap()
            .insert(pane_id.to_owned(), channel.clone());
        channel
    }

    pub(crate) fn drop_channel(&self, pane_id: &str) {
        if let Some(timer) = self.holder_side.save_timers.lock().unwrap().remove(pane_id) {
            timer.abort();
        }
        let channel = self.holder_side.channels.lock().unwrap().remove(pane_id);
        if let Some(channel) = channel {
            channel.detach();
        }
    }

    pub(crate) fn save_all_holders(&self) {
        let panes: Vec<String> = self
            .holder_side
            .channels
            .lock()
            .unwrap()
            .keys()
            .cloned()
            .collect();
        for pane in panes {
            self.save_holder(&pane);
        }
    }

    pub(crate) fn drop_all_channels(&self) {
        let panes: Vec<String> = self
            .holder_side
            .channels
            .lock()
            .unwrap()
            .keys()
            .cloned()
            .collect();
        for pane in panes {
            self.drop_channel(&pane);
        }
    }

    /// The pane holder runs the headless agent (`holderSpawn`).
    async fn holder_spawn(
        &self,
        spawn: HeadlessSpawnOptions,
    ) -> Result<Option<Arc<dyn HeadlessProcess>>, String> {
        let channel = self
            .channel(&spawn.pane_id)
            .filter(|channel| channel.holder_id().is_some());
        let Some(channel) = channel else {
            return Err(if self.holders.connected(&spawn.pane_id, None, None) {
                "The pane holder is from an older Roamgate; show the terminal, then the chat, to restart it".into()
            } else {
                "The pane holder is not connected".into()
            });
        };
        let terminal_args = self
            .lease(&spawn.pane_id)
            .map(|lease| crate::shared::lease_terminal_args(&lease))
            .unwrap_or_default();
        let model = self
            .resume_profile(&spawn.session_id)
            .and_then(|command| command.model.clone());
        let profile = self.profile_of(&spawn.session_id)?;
        let command = self
            .driver_of(&spawn.pane_id)
            .protocol
            .start_command(&StartOptions {
                session_id: spawn.session_id.clone(),
                pane_id: Some(spawn.pane_id.clone()),
                cwd: spawn.cwd.clone(),
                flags: Some(with_model(&terminal_args, model.as_deref())),
                api_key_answer: spawn.api_key_answer,
                profile,
            });
        channel
            .spawn(HolderSpawn {
                command,
                attach_only: spawn.attach_only,
                signal: spawn.signal.clone(),
                timeout_ms: None,
            })
            .await
            .map_err(|error| error.message)
    }

    /// Whether Herdr shows the pane without its holder.
    pub(crate) async fn holder_gone(&self, pane_id: &str) -> bool {
        if self.holders.connected(pane_id, None, None) {
            return false;
        }
        let Ok(info) = self.options.herdr.process_info(pane_id).await else {
            return false;
        };
        if info.shell_pid.is_some() && info.foreground_process_group_id == info.shell_pid {
            return true;
        }
        if info.foreground_processes.is_empty() {
            return false;
        }
        !info.foreground_processes.iter().any(|process| {
            let mut words = vec![process.argv0.clone().unwrap_or_default()];
            words.extend(process.argv.clone().unwrap_or_default());
            words.push(process.cmdline.clone().unwrap_or_default());
            words.join(" ").contains("roamgate-hold")
        })
    }

    /// A holder's poll (`endpoints.hold`).
    pub(crate) async fn holder_hold(&self, input: HolderSideInput) -> HolderReply {
        let pane = input.pane_id.clone();
        if let Some(shell) = &input.shell {
            self.holders.note_shell(&pane, shell.clone());
        }
        let lease = self.lease(&pane);
        if let Some(lease) = &lease
            && lease_str(lease, "phase") == Some("terminal")
        {
            return obj_of(json!({
                "action": "resume",
                "session_id": lease_str(lease, "session_id"),
                "cwd": lease_str(lease, "cwd"),
            }));
        }
        let Some(lease) = lease else {
            let was = self.released.lock().unwrap().get(&pane).cloned();
            if let Some(was) = was
                && self.now() - was.at < RELEASED_MS
            {
                return obj_of(json!({
                    "action": "resume",
                    "session_id": was.session_id,
                    "cwd": was.cwd,
                }));
            }
            if self
                .holder_side
                .strangers
                .lock()
                .unwrap()
                .insert(pane.clone())
            {
                self.log(
                    "a holder this runtime does not know polled; it keeps holding",
                    json!({"pane": pane}),
                );
            }
            let signal = input.signal.clone().unwrap_or_default();
            tokio::select! {
                () = sleep_ms(&*self.options.clock, self.options.hold_poll_ms) => {}
                () = signal.cancelled() => {}
            }
            return hold_reply(&input.session_id);
        };
        let channel = input.status.as_ref().map(|_| self.channel_for(&pane));
        if let (Some(channel), Some(status)) = (&channel, &input.status) {
            channel.update(status.clone());
        }
        if input
            .status
            .as_ref()
            .is_some_and(|status| status.api_key != Some(HolderApiKey::New))
        {
            self.settle_api_key(&pane, None, None);
        }
        if (channel.is_some() || self.options.spawn.is_some())
            && lease_str(&lease, "phase") == Some("conversation")
            && self.recovery.unread.lock().unwrap().contains(&pane)
        {
            self.reattach(&pane);
        }
        let session_id = lease_str(&lease, "session_id").unwrap_or("").to_owned();
        let with_work = |mut reply: HolderReply, channel: &HolderChannel| {
            let work = channel.work();
            if let Some(commands) = work.commands {
                reply.insert(
                    "commands".into(),
                    Value::Array(commands.into_iter().map(Value::Object).collect()),
                );
            }
            if let Some(from) = work.output_from {
                reply.insert("output_from".into(), json!(from));
            }
            reply
        };
        if let Some(channel) = &channel
            && channel.has_work()
        {
            self.holders.touch(&pane, Some(&input.session_id));
            return with_work(hold_reply(&session_id), channel);
        }
        let wait = self.holders.wait(
            &pane,
            hold_reply(&session_id),
            self.options.hold_poll_ms,
            Some(&input.session_id),
        );
        let reply = match input.signal.clone() {
            Some(signal) => tokio::select! {
                reply = wait => reply,
                () = signal.cancelled() => hold_reply(&session_id),
            },
            None => wait.await,
        };
        match &channel {
            Some(channel) if sv(reply.get("action")) == "hold" => with_work(reply, channel),
            _ => reply,
        }
    }

    /// A holder sending its log: what Roamgate takes, once.
    pub(crate) fn holder_output(
        &self,
        pane_id: &str,
        holder_id: &str,
        offset: i64,
        end: i64,
        data: &str,
    ) -> Value {
        let Some(channel) = self.channel(pane_id) else {
            return json!({});
        };
        match channel.receive(HolderOutput {
            holder_id,
            offset,
            end,
            data,
        }) {
            Some(offset) => json!({"offset": offset}),
            None => json!({}),
        }
    }

    /// `fg` in the pane's shell brought a stopped holder back.
    pub(crate) async fn holder_fg(
        &self,
        input: HolderSideInput,
        spec: SuspendedSpec,
    ) -> HolderReply {
        let pane = input.pane_id.clone();
        let session_id = spec.session_id.clone();
        let result = self
            .from_suspended(&pane, spec, || {
                self.holders.touch(&pane, Some(&session_id));
                if let Some(shell) = &input.shell {
                    self.holders.note_shell(&pane, shell.clone());
                }
                if let Some(status) = &input.status {
                    self.channel_for(&pane).update(status.clone());
                }
            })
            .await;
        if result.get("ok") == Some(&Value::Bool(true)) {
            hold_reply(&session_id)
        } else {
            refused_reply(sv(result.get("reason")))
        }
    }

    pub(crate) async fn holder_handback(&self, pane_id: &str) -> HolderReply {
        let Some(lease) = self.lease(pane_id) else {
            return obj_of(json!({"action": "resume", "session_id": "", "cwd": ""}));
        };
        let result = self.to_terminal(pane_id, false, Some(false), None).await;
        if result.get("ok") != Some(&Value::Bool(true)) {
            return refused_reply(sv(result.get("reason")));
        }
        let me = self.me();
        let pane = pane_id.to_owned();
        let session = lease_str(&lease, "session_id").unwrap_or("").to_owned();
        tokio::spawn(async move {
            if !me.handover.confirm_mapping(&pane, &session).await {
                me.log(
                    "Herdr did not map the pane to its session again",
                    json!({"pane": pane}),
                );
            }
        });
        let profile = self.resume_profile(lease_str(&lease, "session_id").unwrap_or(""));
        resume_reply(&lease, profile.as_ref(), &self.options.drivers)
    }
}

/// Starts the headless process only while conversation mode owns the
/// session and nothing else writes it (`guardedSpawn`).
pub(crate) struct GuardedSpawn {
    pub(crate) service: Weak<Inner>,
    pub(crate) pane_id: String,
}

impl SpawnHeadless for GuardedSpawn {
    fn spawn(
        &self,
        options: HeadlessSpawnOptions,
    ) -> BoxFuture<'_, Result<Option<Arc<dyn HeadlessProcess>>, String>> {
        Box::pin(async move {
            let Some(me) = self.service.upgrade() else {
                return Err("The connection is closing".into());
            };
            me.guarded_spawn(&self.pane_id, options).await
        })
    }
}

impl Inner {
    async fn spawn_headless(
        &self,
        options: HeadlessSpawnOptions,
    ) -> Result<Option<Arc<dyn HeadlessProcess>>, String> {
        match &self.options.spawn {
            Some(spawn) => spawn.spawn(options).await,
            None => self.holder_spawn(options).await,
        }
    }

    async fn guarded_spawn(
        &self,
        pane_id: &str,
        spawn: HeadlessSpawnOptions,
    ) -> Result<Option<Arc<dyn HeadlessProcess>>, String> {
        let lease = self
            .lease(pane_id)
            .filter(|lease| lease_str(lease, "phase") == Some("conversation"))
            .ok_or("Conversation mode does not own this session")?;
        if !self.handover.wait_for_holder(pane_id).await {
            let me = self.me();
            let pane = pane_id.to_owned();
            tokio::spawn(async move {
                me.recover_later(&pane).await;
            });
            return Err(HOLDER_MISSING.into());
        }
        let attach = HeadlessSpawnOptions {
            attach_only: true,
            ..spawn.clone()
        };
        let attached = match self.spawn_headless(attach).await {
            Ok(attached) => attached,
            Err(error) => {
                let aborted = spawn
                    .signal
                    .as_ref()
                    .is_some_and(CancellationToken::is_cancelled);
                if self.holders.connected(pane_id, None, None) && !aborted {
                    self.set_lost(pane_id, &error);
                }
                return Err(error);
            }
        };
        self.clear_lost(pane_id);
        if attached.is_some() || spawn.attach_only {
            return Ok(attached);
        }
        let api_key_answer = if self
            .channel(pane_id)
            .and_then(|channel| channel.status())
            .is_some_and(|status| status.api_key == Some(HolderApiKey::New))
        {
            self.ask_api_key(pane_id, spawn.signal.clone()).await?
        } else {
            None
        };
        let mut ids: Vec<String> = Vec::new();
        for id in [
            lease_str(&lease, "session_id").unwrap_or("").to_owned(),
            spawn.session_id.clone(),
        ]
        .into_iter()
        .chain(crate::shared::lease_headless_ids(&lease))
        {
            if !ids.contains(&id) {
                ids.push(id);
            }
        }
        let info = self.options.herdr.process_info(pane_id).await?;
        let running = self.options.herdr.headless_running(&ids).await?;
        let terminal = self
            .options
            .drivers
            .of(lease_str(&lease, "agent"))
            .terminal
            .clone();
        if info
            .foreground_processes
            .iter()
            .any(|process| terminal.is_agent_process(process))
        {
            if !running && self.lease(pane_id).as_ref() == Some(&lease) {
                self.log(
                    "claude runs in a held pane; the terminal has the session",
                    json!({"pane": pane_id}),
                );
                self.delete_lease(pane_id);
                let me = self.me();
                let pane = pane_id.to_owned();
                tokio::spawn(async move { me.emit_lease(&pane) });
            }
            return Err(
                "Claude runs in the pane's terminal; conversation mode will not start a second one"
                    .into(),
            );
        }
        if running {
            return Err("An earlier conversation process still works on this session; try again once it has finished".into());
        }
        if let Some(elsewhere) = self
            .options
            .herdr
            .writer_elsewhere(pane_id, &ids, &[])
            .await?
        {
            return Err(format!(
                "{}; conversation mode will not start a second writer",
                elsewhere.text
            ));
        }
        if let Some(held) = self.holders.session(pane_id)
            && !ids.contains(&held)
        {
            return Err("The pane holder holds another session".into());
        }
        if !self.owns(pane_id) || self.closed() {
            return Err("Conversation mode does not own this session".into());
        }
        let mut spawn = spawn;
        if api_key_answer.is_some() {
            spawn.api_key_answer = api_key_answer;
        }
        self.spawn_headless(spawn).await
    }
}

#[allow(dead_code)]
fn _obj(_: Obj) {}
