//! Where work sessions are kept: `<data>/conversation-continuity/<id>.json`
//! (the session, rewritten at each switch step) and `<id>.events.jsonl`
//! (its events, appended as they come), both private to the user. A
//! session is read when a lease names it.

use std::collections::HashMap;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use roamgate_agents::js;
use roamgate_base::env::ProcessEnv;
use roamgate_base::paths::{DataContext, random_uuid};

use crate::continuity::model::{
    AgentExecution, CanonicalEvent, CanonicalEventKind, ExternalJob, HandoffMachine, HandoffPhase,
    PortableCheckpoint, QueuedHandoffMessage, WorkSession,
};
use crate::time::SharedClock;

pub const CONTINUITY_DIR_NAME: &str = "conversation-continuity";
const FORMAT: u32 = 1;

pub fn default_continuity_dir(data: &DataContext) -> PathBuf {
    data.data_root().join(CONTINUITY_DIR_NAME)
}

/// What a restart found of a switch it cut short, and what became of it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Recovery {
    /// The outgoing agent keeps the conversation (the lease still names
    /// it): the switch is undone, its queued messages given back.
    RolledBack {
        phase: HandoffPhase,
        queued: Vec<QueuedHandoffMessage>,
    },
    /// The lease already names the incoming agent: the switch is ended
    /// there; whether that agent got the history is not known, so it is
    /// given again (`bootstrap`) before the queued messages.
    Finished { queued: Vec<QueuedHandoffMessage> },
}

struct StoreInner {
    connection_id: String,
    dir: Option<PathBuf>,
    data: DataContext,
    clock: SharedClock,
    sessions: Mutex<HashMap<String, WorkSession>>,
}

/// A connection's work sessions. Cheap to clone.
#[derive(Clone)]
pub struct WorkSessionStore {
    inner: Arc<StoreInner>,
}

fn execution_id() -> String {
    format!("exec-{}", &random_uuid()[..8])
}

impl WorkSessionStore {
    /// `dir` None keeps them in memory.
    pub fn new(
        connection_id: impl Into<String>,
        dir: Option<PathBuf>,
        data: Option<DataContext>,
        clock: SharedClock,
    ) -> Self {
        Self {
            inner: Arc::new(StoreInner {
                connection_id: connection_id.into(),
                dir,
                data: data.unwrap_or_else(|| DataContext::from_env(&ProcessEnv)),
                clock,
                sessions: Mutex::new(HashMap::new()),
            }),
        }
    }

    fn now_iso(&self) -> String {
        js::iso(self.inner.clock.now() as f64)
    }

    fn path(&self, id: &str, suffix: &str) -> Option<PathBuf> {
        // An id from a lease: a file name, nothing else.
        if id.is_empty() || !id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
            return None;
        }
        Some(self.inner.dir.as_ref()?.join(format!("{id}{suffix}")))
    }

    fn persist(&self, session: &WorkSession) {
        let Some(path) = self.path(&session.work_session_id, ".json") else {
            return;
        };
        if let Ok(mut bytes) = serde_json::to_vec(session) {
            bytes.push(b'\n');
            if let Err(error) = self.inner.data.replace_data_file(&path, &bytes, 0o600) {
                tracing::warn!(%error, "work session not saved");
            }
        }
    }

    fn append(&self, id: &str, event: &CanonicalEvent) {
        let Some(path) = self.path(id, ".events.jsonl") else {
            return;
        };
        let Ok(mut line) = serde_json::to_vec(event) else {
            return;
        };
        line.push(b'\n');
        let written = (|| {
            if !path.exists() {
                // Created private, as the session's file is.
                self.inner.data.publish_data_file(&path, b"", 0o600)?;
            }
            self.inner.data.assert_safe_data_path(&path)?;
            std::fs::OpenOptions::new()
                .append(true)
                .open(&path)?
                .write_all(&line)
        })();
        if let Err(error) = written {
            tracing::warn!(%error, "work session event not saved");
        }
    }

    /// The session from its files; a torn last event line is skipped.
    fn read(&self, id: &str) -> Option<WorkSession> {
        let text = std::fs::read_to_string(self.path(id, ".json")?).ok()?;
        let mut session: WorkSession = serde_json::from_str(&text).ok()?;
        if session.connection_id != self.inner.connection_id || session.work_session_id != id {
            return None;
        }
        let events = self
            .path(id, ".events.jsonl")
            .and_then(|path| std::fs::read_to_string(path).ok())
            .unwrap_or_default();
        for line in events.lines() {
            if let Ok(event) = serde_json::from_str::<CanonicalEvent>(line)
                && event.seq > session.latest_seq()
            {
                if let Some(key) = &event.source_key {
                    session.keys.insert(key.clone());
                }
                session.events.push(event);
            }
        }
        Some(session)
    }

    /// Runs `f` on the session, read from its files the first time.
    fn with<R>(&self, id: &str, f: impl FnOnce(&mut WorkSession) -> R) -> Option<R> {
        let mut sessions = self.inner.sessions.lock().unwrap();
        if !sessions.contains_key(id) {
            let read = self.read(id)?;
            sessions.insert(id.to_owned(), read);
        }
        Some(f(sessions.get_mut(id)?))
    }

    /// Changes the session and saves it, under the store's lock: saves
    /// never overtake each other.
    fn mutate<R>(&self, id: &str, f: impl FnOnce(&mut WorkSession) -> R) -> Option<R> {
        self.with(id, |session| {
            let result = f(session);
            self.persist(session);
            result
        })
    }

    pub fn get(&self, id: &str) -> Option<WorkSession> {
        self.with(id, |session| session.clone())
    }

    /// Reads something of the session without copying it.
    pub fn read_with<R>(&self, id: &str, f: impl FnOnce(&WorkSession) -> R) -> Option<R> {
        self.with(id, |session| f(session))
    }

    /// A new work session, its first agent's native session running.
    pub fn create(&self, pane_id: &str, agent: &str, native_session_id: &str, cwd: &str) -> String {
        let now = self.now_iso();
        let id = random_uuid();
        let execution = AgentExecution {
            id: execution_id(),
            agent: agent.to_owned(),
            native_session_id: native_session_id.to_owned(),
            started_at: now.clone(),
            ended_at: None,
            delivered_through_seq: 0,
            resync_safe: true,
        };
        let session = WorkSession {
            version: FORMAT,
            work_session_id: id.clone(),
            connection_id: self.inner.connection_id.clone(),
            pane_id: pane_id.to_owned(),
            cwd: cwd.to_owned(),
            created_at: now,
            active_agent: agent.to_owned(),
            active_execution_id: Some(execution.id.clone()),
            executions: vec![execution],
            checkpoint: PortableCheckpoint::default(),
            handoff: HandoffMachine::default(),
            events: Vec::new(),
            keys: Default::default(),
        };
        let mut sessions = self.inner.sessions.lock().unwrap();
        self.persist(&session);
        sessions.insert(id.clone(), session);
        id
    }

    /// Appends an event, unless one with its `source_key` is in already.
    /// Its number, None when it was in.
    pub fn record_event(
        &self,
        id: &str,
        actor: &str,
        kind: CanonicalEventKind,
        source_key: Option<String>,
    ) -> Option<u64> {
        let now = self.now_iso();
        self.with(id, |session| {
            self.push(session, now, actor, kind, source_key)
        })
        .flatten()
    }

    fn push(
        &self,
        session: &mut WorkSession,
        at: String,
        actor: &str,
        kind: CanonicalEventKind,
        source_key: Option<String>,
    ) -> Option<u64> {
        if let Some(key) = &source_key
            && !session.keys.insert(key.clone())
        {
            return None;
        }
        let event = CanonicalEvent {
            seq: session.latest_seq() + 1,
            at,
            actor: actor.to_owned(),
            source_key,
            kind,
        };
        self.append(&session.work_session_id, &event);
        let seq = event.seq;
        session.events.push(event);
        Some(seq)
    }

    /// The switch event, recorded once when the lease names the incoming
    /// agent: what that agent says comes after it.
    fn push_switch(&self, session: &mut WorkSession, at: String) {
        let handoff = &session.handoff;
        let kind = CanonicalEventKind::BackendSwitch {
            from_agent: handoff.from_agent.clone().unwrap_or_default(),
            to_agent: handoff.to_agent.clone().unwrap_or_default(),
            reason: handoff.reason.clone().unwrap_or_else(|| "manual".into()),
            checkpoint_version: session.checkpoint.version,
        };
        let key = format!("switch:{}", handoff.generation);
        self.push(session, at, "roamgate", kind, Some(key));
    }

    /// The active native session's id changed (AGY's `session/new`
    /// answered, Claude's /clear).
    pub fn set_active_native_session(&self, id: &str, native_session_id: &str) {
        self.mutate(id, |session| {
            if let Some(exec) = session.active_execution_mut() {
                exec.native_session_id = native_session_id.to_owned();
            }
        });
    }

    /// `Running -> Quiescing`; refused while another switch runs. The
    /// switch's generation.
    pub fn begin_quiescing(&self, id: &str, to_agent: &str, reason: &str) -> Result<u64, String> {
        let now = self.now_iso();
        self.mutate(id, |session| {
            if session.handoff.phase.is_switching() {
                return Err(format!(
                    "A switch to another agent is already running ({})",
                    session.handoff.phase.as_str()
                ));
            }
            let generation = session.handoff.generation + 1;
            session.handoff = HandoffMachine {
                phase: HandoffPhase::Quiescing,
                generation,
                from_agent: Some(session.active_agent.clone()),
                to_agent: Some(to_agent.to_owned()),
                reason: Some(reason.to_owned()),
                started_at: Some(now),
                ..HandoffMachine::default()
            };
            Ok(generation)
        })
        .unwrap_or_else(|| Err("The work session is gone".into()))
    }

    /// Keeps a message sent during a switch for the incoming agent; false
    /// when no switch runs.
    pub fn queue_during_handoff(&self, id: &str, message: QueuedHandoffMessage) -> bool {
        self.mutate(id, |session| {
            if !session.handoff.phase.is_switching() {
                return false;
            }
            let queued = &mut session.handoff.queued_during_handoff;
            if !queued.iter().any(|m| m.id == message.id) {
                queued.push(message);
            }
            true
        })
        .unwrap_or(false)
    }

    /// The messages queued during the switch so far, taken.
    pub fn take_handoff_queue(&self, id: &str) -> Vec<QueuedHandoffMessage> {
        self.mutate(id, |session| {
            std::mem::take(&mut session.handoff.queued_during_handoff)
        })
        .unwrap_or_default()
    }

    /// `Quiescing -> Checkpointed`, the outgoing agent stopped: its native
    /// session has seen every event so far.
    pub fn mark_checkpointed(
        &self,
        id: &str,
        generation: u64,
        resync_safe: bool,
        running_jobs: Vec<ExternalJob>,
    ) -> Result<WorkSession, String> {
        let now = self.now_iso();
        self.mutate(id, |session| {
            if session.handoff.generation != generation
                || session.handoff.phase != HandoffPhase::Quiescing
            {
                return Err("The switch changed before its checkpoint".into());
            }
            let latest = session.latest_seq();
            if let Some(exec) = session.active_execution_mut() {
                exec.ended_at = Some(now);
                exec.delivered_through_seq = latest;
                exec.resync_safe = resync_safe;
            }
            session.checkpoint = PortableCheckpoint {
                version: session.checkpoint.version + 1,
                at_seq: latest,
                running_jobs,
            };
            session.handoff.phase = HandoffPhase::Checkpointed;
            Ok(session.clone())
        })
        .unwrap_or_else(|| Err("The work session is gone".into()))
    }

    /// `Checkpointed -> StartingReplacement`: the incoming agent's native
    /// session, an earlier one of its resumed (`reused_execution_id`) or a
    /// new one.
    pub fn begin_starting_replacement(
        &self,
        id: &str,
        generation: u64,
        native_session_id: &str,
        reused_execution_id: Option<&str>,
    ) -> Result<AgentExecution, String> {
        let now = self.now_iso();
        let now_switch = now.clone();
        self.mutate(id, |session| {
            if session.handoff.generation != generation
                || session.handoff.phase != HandoffPhase::Checkpointed
            {
                return Err("The switch changed before the next agent started".into());
            }
            let agent = session.handoff.to_agent.clone().unwrap_or_default();
            let exec = match reused_execution_id.and_then(|reused| {
                session
                    .executions
                    .iter_mut()
                    .find(|e| e.id == reused && e.agent == agent && e.resync_safe)
            }) {
                Some(existing) => {
                    existing.ended_at = None;
                    existing.clone()
                }
                None => {
                    let exec = AgentExecution {
                        id: execution_id(),
                        agent,
                        native_session_id: native_session_id.to_owned(),
                        started_at: now,
                        ended_at: None,
                        delivered_through_seq: 0,
                        resync_safe: true,
                    };
                    session.executions.push(exec.clone());
                    exec
                }
            };
            session.handoff.phase = HandoffPhase::StartingReplacement;
            session.handoff.replacement_execution_id = Some(exec.id.clone());
            self.push_switch(session, now_switch);
            Ok(exec)
        })
        .unwrap_or_else(|| Err("The work session is gone".into()))
    }

    /// `StartingReplacement -> Running`: the incoming agent has the
    /// history. The session, and the messages queued meanwhile (taken:
    /// each goes once).
    pub fn finish_switch(
        &self,
        id: &str,
        generation: u64,
    ) -> Result<(WorkSession, Vec<QueuedHandoffMessage>), String> {
        self.mutate(id, |session| {
            if session.handoff.generation != generation
                || session.handoff.phase != HandoffPhase::StartingReplacement
            {
                return Err("The switch changed before the next agent took over".into());
            }
            let queued = Self::finish(session);
            Ok((session.clone(), queued))
        })
        .unwrap_or_else(|| Err("The work session is gone".into()))
    }

    /// Makes the replacement the active agent; the queued messages.
    fn finish(session: &mut WorkSession) -> Vec<QueuedHandoffMessage> {
        let handoff = std::mem::take(&mut session.handoff);
        if let Some(to_agent) = handoff.to_agent {
            session.active_agent = to_agent;
        }
        session.active_execution_id = handoff.replacement_execution_id;
        session.handoff.generation = handoff.generation;
        handoff.queued_during_handoff
    }

    /// Undoes a switch that failed before the incoming agent took over:
    /// the outgoing agent's native session is the active one again, the
    /// incoming one never resumed. The messages queued meanwhile.
    pub fn abort_switch(&self, id: &str, generation: u64) -> Vec<QueuedHandoffMessage> {
        let now = self.now_iso();
        self.mutate(id, |session| {
            if session.handoff.generation != generation || !session.handoff.phase.is_switching() {
                return Vec::new();
            }
            self.roll_back(session, now)
        })
        .unwrap_or_default()
    }

    fn roll_back(&self, session: &mut WorkSession, now: String) -> Vec<QueuedHandoffMessage> {
        // The history said it moved: it says it came back.
        if session.handoff.phase == HandoffPhase::StartingReplacement {
            let handoff = &session.handoff;
            let kind = CanonicalEventKind::BackendSwitch {
                from_agent: handoff.to_agent.clone().unwrap_or_default(),
                to_agent: handoff.from_agent.clone().unwrap_or_default(),
                reason: "failed".into(),
                checkpoint_version: session.checkpoint.version,
            };
            let key = format!("switch-back:{}", handoff.generation);
            self.push(session, now.clone(), "roamgate", kind, Some(key));
        }
        let handoff = std::mem::take(&mut session.handoff);
        if let Some(replacement) = &handoff.replacement_execution_id
            && session.active_execution_id.as_ref() != Some(replacement)
            && let Some(exec) = session.executions.iter_mut().find(|e| &e.id == replacement)
        {
            // It may have started: never resumed as is.
            exec.resync_safe = false;
            exec.ended_at.get_or_insert(now);
        }
        if let Some(exec) = session.active_execution_mut() {
            exec.ended_at = None;
        }
        session.handoff.generation = handoff.generation;
        handoff.queued_during_handoff
    }

    /// A restart found the session mid-switch (`lease_agent`: the agent
    /// its lease names now). One agent ends up writing: the outgoing one,
    /// unless the lease already names the incoming one.
    pub fn recover(&self, id: &str, lease_agent: &str) -> Option<Recovery> {
        let now = self.now_iso();
        self.mutate(id, |session| {
            let phase = session.handoff.phase;
            if !phase.is_switching() {
                return None;
            }
            let incoming = phase == HandoffPhase::StartingReplacement
                && session.handoff.to_agent.as_deref() == Some(lease_agent);
            Some(if incoming {
                Recovery::Finished {
                    queued: Self::finish(session),
                }
            } else {
                Recovery::RolledBack {
                    phase,
                    queued: self.roll_back(session, now),
                }
            })
        })?
    }

    /// Deletes this connection's work sessions no lease names any more
    /// (their conversations went back to the terminal).
    pub fn remove_unused(&self, used: &[String]) {
        let Some(dir) = &self.inner.dir else {
            return;
        };
        let Ok(entries) = std::fs::read_dir(dir) else {
            return;
        };
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            let Some(id) = name.strip_suffix(".json") else {
                continue;
            };
            if used.iter().any(|kept| kept == id) {
                continue;
            }
            let mine = std::fs::read_to_string(entry.path())
                .ok()
                .and_then(|text| serde_json::from_str::<WorkSession>(&text).ok())
                .is_some_and(|session| session.connection_id == self.inner.connection_id);
            if mine {
                let _ = std::fs::remove_file(entry.path());
                if let Some(events) = self.path(id, ".events.jsonl") {
                    let _ = std::fs::remove_file(events);
                }
                self.inner.sessions.lock().unwrap().remove(id);
            }
        }
    }

    pub fn dir(&self) -> Option<&Path> {
        self.inner.dir.as_deref()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::time::VirtualClock;

    fn store(dir: &Path, clock: &VirtualClock) -> WorkSessionStore {
        let data = DataContext::new(dir, roamgate_base::paths::Platform::current(), None);
        WorkSessionStore::new(
            "local",
            Some(default_continuity_dir(&data)),
            Some(data),
            clock.shared(),
        )
    }

    fn user(text: &str) -> CanonicalEventKind {
        CanonicalEventKind::UserMessage {
            text: text.into(),
            images: vec![],
        }
    }

    #[test]
    fn events_are_numbered_once_and_kept_across_a_restart() {
        let tmp = tempfile::tempdir().unwrap();
        let clock = VirtualClock::new();
        let first = store(tmp.path(), &clock);
        let id = first.create("w1:p1", "claude", "c1", "/repo");
        assert_eq!(
            first.record_event(&id, "user", user("one"), Some("user:u1".into())),
            Some(1)
        );
        assert_eq!(
            first.record_event(&id, "user", user("one"), Some("user:u1".into())),
            None
        );
        assert_eq!(
            first.record_event(&id, "claude", user("two"), None),
            Some(2)
        );

        let second = store(tmp.path(), &clock);
        let session = second.get(&id).unwrap();
        assert_eq!(session.latest_seq(), 2);
        assert_eq!(session.goal(), Some("one"));
        assert_eq!(
            second.record_event(&id, "user", user("one"), Some("user:u1".into())),
            None
        );
        // Another connection's id is not this one's.
        let other = WorkSessionStore::new(
            "ssh-1",
            first.dir().map(Path::to_path_buf),
            None,
            clock.shared(),
        );
        assert!(other.get(&id).is_none());
        // Not a file name: nothing is read.
        assert!(second.get("../x").is_none());
    }

    #[test]
    fn a_restart_mid_switch_leaves_one_writer() {
        let tmp = tempfile::tempdir().unwrap();
        let clock = VirtualClock::new();
        let s = store(tmp.path(), &clock);
        let id = s.create("w1:p1", "claude", "c1", "/repo");
        s.record_event(&id, "user", user("Migrate the parser"), None);
        let generation = s.begin_quiescing(&id, "agy", "usage_limit").unwrap();
        assert!(s.begin_quiescing(&id, "agy", "again").is_err());
        assert!(s.queue_during_handoff(
            &id,
            QueuedHandoffMessage {
                id: "q1".into(),
                text: "Also run clippy".into(),
                images: vec![],
                queued_at: "t".into(),
            },
        ));
        s.mark_checkpointed(&id, generation, true, vec![]).unwrap();

        // Before the lease moved: back to Claude, the message given back.
        let restarted = store(tmp.path(), &clock);
        match restarted.recover(&id, "claude") {
            Some(Recovery::RolledBack { phase, queued }) => {
                assert_eq!(phase, HandoffPhase::Checkpointed);
                assert_eq!(queued.len(), 1);
            }
            other => panic!("{other:?}"),
        }
        let session = restarted.get(&id).unwrap();
        assert_eq!(session.handoff.phase, HandoffPhase::Running);
        assert_eq!(session.active_agent, "claude");
        assert!(session.active_execution().unwrap().ended_at.is_none());

        // The lease moved to AGY: the switch ends there.
        let generation = restarted.begin_quiescing(&id, "agy", "manual").unwrap();
        restarted
            .mark_checkpointed(&id, generation, true, vec![])
            .unwrap();
        restarted
            .begin_starting_replacement(&id, generation, "new", None)
            .unwrap();
        let again = store(tmp.path(), &clock);
        assert_eq!(
            again.recover(&id, "agy"),
            Some(Recovery::Finished { queued: vec![] })
        );
        let session = again.get(&id).unwrap();
        assert_eq!(session.active_agent, "agy");
        assert!(matches!(
            session.events.last().unwrap().kind,
            CanonicalEventKind::BackendSwitch { .. }
        ));
        assert_eq!(again.recover(&id, "agy"), None);
    }

    #[test]
    fn removes_the_sessions_no_lease_names() {
        let tmp = tempfile::tempdir().unwrap();
        let clock = VirtualClock::new();
        let s = store(tmp.path(), &clock);
        let kept = s.create("w1:p1", "claude", "c1", "/repo");
        let gone = s.create("w1:p2", "claude", "c2", "/repo");
        s.record_event(&gone, "user", user("x"), None);
        s.remove_unused(std::slice::from_ref(&kept));
        let dir = s.dir().unwrap();
        assert!(dir.join(format!("{kept}.json")).exists());
        assert!(!dir.join(format!("{gone}.json")).exists());
        assert!(!dir.join(format!("{gone}.events.jsonl")).exists());
    }
}
