//! What a pane's holder is told (`holder.ts`): keep holding, resume the
//! agent's TUI, refused, or stop as a shell job, and the registry of the
//! holders polling from their panes.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use roamgate_agents::{js, obj};
use serde_json::Value;
use tokio::sync::oneshot;

use crate::driver::Drivers;
use crate::shared::{AgentCommand, Lease, Obj, lease_str, lease_terminal_args, with_model};
use crate::time::{SharedClock, sleep_ms};

/// What roamgate-hold is told (`HolderReply`): `{action: "hold" |
/// "resume" | "refused" | "suspend", ...}`, Bun's object.
pub type HolderReply = Obj;

/// `{action: "hold", session_id}`.
pub fn hold_reply(session_id: &str) -> HolderReply {
    obj! {"action" => "hold", "session_id" => session_id}
}

/// `{action: "refused", reason}`.
pub fn refused_reply(reason: &str) -> HolderReply {
    obj! {"action" => "refused", "reason" => reason}
}

/// The reply's action.
pub fn reply_action(reply: &HolderReply) -> &str {
    lease_str(reply, "action").unwrap_or("")
}

/// What a lease's holder is told to stop as a shell job (the chat's
/// Ctrl+Z): its child ended, it stops with the shell prompt back, and `fg`
/// there brings the conversation back. It keeps what the lease said of the
/// session and gives it back with its `fg`.
pub fn suspend_reply(lease: &Lease, title: Option<&str>) -> HolderReply {
    let args = lease_terminal_args(lease);
    obj! {
        "action" => "suspend",
        "session_id" => lease_str(lease, "session_id").unwrap_or(""),
        "cwd" => lease_str(lease, "cwd").unwrap_or(""),
        "title" => title.filter(|title| !title.is_empty()),
        "agent" => lease_str(lease, "agent").filter(|agent| !agent.is_empty()),
        "terminal_args" => (!args.is_empty()).then(|| args.into_iter().map(Value::String).collect::<Vec<_>>()),
    }
}

/// What a holder is told to resume a lease's session in its TUI: the full
/// command line, and the agent's arguments alone for a holder from before
/// drivers (it always runs claude). `profile`: the session's (absent or
/// plain: the driver's own program).
pub fn resume_reply(
    lease: &Lease,
    profile: Option<&AgentCommand>,
    drivers: &Drivers,
) -> HolderReply {
    let terminal = drivers.of(lease_str(lease, "agent")).terminal.clone();
    let profile = profile.filter(|p| p.agent.is_empty() || p.agent == terminal.agent());
    let session_id = lease_str(lease, "session_id").unwrap_or("");
    let mut argv = terminal.resume_argv(
        session_id,
        &with_model(
            &lease_terminal_args(lease),
            profile.and_then(|profile| profile.model.as_deref()),
        ),
    );
    let custom = profile.filter(|profile| !profile.plain);
    if let Some(profile) = custom
        && let Some(first) = argv.first_mut()
    {
        *first = profile.program.clone();
    }
    let strings = |items: &[String]| items.iter().cloned().map(Value::String).collect::<Vec<_>>();
    let mut reply = obj! {
        "action" => "resume",
        "session_id" => session_id,
        "cwd" => lease_str(lease, "cwd").unwrap_or(""),
        "argv" => strings(&argv),
        "args" => strings(argv.get(1..).unwrap_or(&[])),
    };
    if let Some(profile) = custom {
        js::put(&mut reply, "agent", terminal.agent());
        js::put(&mut reply, "env", profile.env_object());
        js::put(&mut reply, "unset", strings(&profile.unset));
    }
    reply
}

/// What the pane's holder said of itself and its shell as it polled.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct HolderShell {
    /// It can stop as a shell job (it runs as its own job in an
    /// interactive shell): a holder from before says nothing.
    pub job_control: bool,
    /// Its pid on the pane's host, when it says.
    pub pid: Option<u32>,
    /// The session id it was started with: a word of its job's command.
    pub job: Option<String>,
}

#[derive(Default)]
struct PaneEntry {
    waiters: Vec<(u64, oneshot::Sender<HolderReply>)>,
    seen: i64,
    /// When its latest poll started.
    started: i64,
    session_id: Option<String>,
    shell: HolderShell,
}

type Entry = Arc<Mutex<PaneEntry>>;

/// The holders polling from their panes (`createHolderRegistry`). A holder
/// is connected while one of its long polls waits here, or just after one
/// ended (it polls again at once). Cheap to clone.
#[derive(Clone)]
pub struct HolderRegistry {
    inner: Arc<RegistryInner>,
}

struct RegistryInner {
    clock: SharedClock,
    panes: Mutex<HashMap<String, Entry>>,
    next: AtomicU64,
}

/// Removes a waiter whose poll ended or was dropped.
struct WaitGuard {
    entry: Entry,
    id: u64,
    clock: SharedClock,
}

impl Drop for WaitGuard {
    fn drop(&mut self) {
        let mut pane = self.entry.lock().unwrap();
        pane.waiters.retain(|(id, _)| *id != self.id);
        pane.seen = self.clock.now();
    }
}

impl HolderRegistry {
    pub fn new(clock: SharedClock) -> Self {
        Self {
            inner: Arc::new(RegistryInner {
                clock,
                panes: Mutex::new(HashMap::new()),
                next: AtomicU64::new(1),
            }),
        }
    }

    fn entry(&self, pane_id: &str) -> Entry {
        self.inner
            .panes
            .lock()
            .unwrap()
            .entry(pane_id.to_owned())
            .or_default()
            .clone()
    }

    fn found(&self, pane_id: &str) -> Option<Entry> {
        self.inner.panes.lock().unwrap().get(pane_id).cloned()
    }

    /// A holder's long poll: the next reply sent to the pane, or `idle`
    /// after `timeout_ms` (it polls again). Dropped (the request was
    /// aborted), it ends as if answered.
    pub fn wait(
        &self,
        pane_id: &str,
        idle: HolderReply,
        timeout_ms: u64,
        session_id: Option<&str>,
    ) -> impl std::future::Future<Output = HolderReply> + Send + 'static {
        let entry = self.entry(pane_id);
        let clock = self.inner.clock.clone();
        let id = self.inner.next.fetch_add(1, Ordering::Relaxed);
        let (sender, receiver) = oneshot::channel();
        {
            let mut pane = entry.lock().unwrap();
            pane.seen = clock.now();
            pane.started = pane.seen;
            if let Some(session) = session_id.filter(|session| !session.is_empty()) {
                pane.session_id = Some(session.to_owned());
            }
            pane.waiters.push((id, sender));
        }
        let guard = WaitGuard {
            entry,
            id,
            clock: clock.clone(),
        };
        async move {
            let _guard = guard;
            let timer = sleep_ms(&*clock, timeout_ms);
            tokio::select! {
                reply = receiver => reply.unwrap_or(idle),
                () = timer => idle,
            }
        }
    }

    /// A holder polled and is answered at once (it polls again).
    pub fn touch(&self, pane_id: &str, session_id: Option<&str>) {
        let entry = self.entry(pane_id);
        let mut pane = entry.lock().unwrap();
        pane.seen = self.inner.clock.now();
        pane.started = pane.seen;
        if let Some(session) = session_id.filter(|session| !session.is_empty()) {
            pane.session_id = Some(session.to_owned());
        }
    }

    /// Whether a holder runs in the pane: one of its polls waits, or one
    /// ended moments ago (`grace_ms`, 5000 by default). With `since`, only
    /// a holder that polled since then counts.
    pub fn connected(&self, pane_id: &str, grace_ms: Option<i64>, since: Option<i64>) -> bool {
        let Some(entry) = self.found(pane_id) else {
            return false;
        };
        let pane = entry.lock().unwrap();
        if since.is_some_and(|since| pane.started < since) {
            return false;
        }
        !pane.waiters.is_empty() || self.inner.clock.now() - pane.seen < grace_ms.unwrap_or(5000)
    }

    /// What the pane's holder said of itself and its shell as it polled.
    pub fn note_shell(&self, pane_id: &str, shell: HolderShell) {
        self.entry(pane_id).lock().unwrap().shell = shell;
    }

    /// Whether the pane's holder can stop as a shell job (Ctrl+Z).
    pub fn job_control(&self, pane_id: &str) -> bool {
        self.found(pane_id)
            .is_some_and(|entry| entry.lock().unwrap().shell.job_control)
    }

    /// The pane's holder's pid and job word, if it said.
    pub fn shell(&self, pane_id: &str) -> (Option<u32>, Option<String>) {
        self.found(pane_id)
            .map(|entry| {
                let pane = entry.lock().unwrap();
                (pane.shell.pid, pane.shell.job.clone())
            })
            .unwrap_or((None, None))
    }

    /// The session the pane's holder says it holds, if one polled.
    pub fn session(&self, pane_id: &str) -> Option<String> {
        self.found(pane_id)
            .and_then(|entry| entry.lock().unwrap().session_id.clone())
    }

    /// Answers every holder waiting in the pane. Told to resume, the holder
    /// becomes the agent, and told to suspend it stops as a shell job: it
    /// no longer counts as there.
    pub fn send(&self, pane_id: &str, reply: &HolderReply) {
        let Some(entry) = self.found(pane_id) else {
            return;
        };
        let waiters = std::mem::take(&mut entry.lock().unwrap().waiters);
        for (_, sender) in waiters {
            let _ = sender.send(reply.clone());
        }
        if matches!(reply_action(reply), "resume" | "suspend") {
            self.inner.panes.lock().unwrap().remove(pane_id);
        }
    }

    /// Answers every waiting holder (each polls again).
    pub fn release_all(&self, reply: impl Fn(&str) -> HolderReply) {
        let panes: Vec<(String, Entry)> = self
            .inner
            .panes
            .lock()
            .unwrap()
            .iter()
            .map(|(pane, entry)| (pane.clone(), entry.clone()))
            .collect();
        for (pane_id, entry) in panes {
            let waiters = std::mem::take(&mut entry.lock().unwrap().waiters);
            for (_, sender) in waiters {
                let _ = sender.send(reply(&pane_id));
            }
        }
    }

    pub fn forget(&self, pane_id: &str) {
        self.inner.panes.lock().unwrap().remove(pane_id);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testing::test_drivers;
    use crate::time::{TokioClock, VirtualClock};

    #[tokio::test(start_paused = true)]
    async fn a_poll_waits_for_a_reply_or_its_timeout() {
        let clock: SharedClock = Arc::new(TokioClock::starting_at(0));
        let holders = HolderRegistry::new(clock.clone());
        let waiting = tokio::spawn(holders.wait("p", hold_reply("s"), 25_000, Some("s")));
        tokio::task::yield_now().await;
        assert!(holders.connected("p", None, None));
        assert_eq!(holders.session("p").as_deref(), Some("s"));
        holders.send("p", &refused_reply("no"));
        assert_eq!(reply_action(&waiting.await.unwrap()), "refused");
        let idle = holders.wait("p", hold_reply("s"), 1000, None).await;
        assert_eq!(reply_action(&idle), "hold");
        // Told to resume, it is gone.
        let waiting = tokio::spawn(holders.wait("p", hold_reply("s"), 25_000, None));
        tokio::task::yield_now().await;
        holders.send("p", &obj! {"action" => "resume"});
        waiting.await.unwrap();
        assert!(!holders.connected("p", None, None));
    }

    #[test]
    fn a_holder_counts_since_its_latest_poll() {
        let clock = VirtualClock::new();
        let holders = HolderRegistry::new(clock.shared());
        clock.set(1000);
        holders.touch("p", None);
        assert!(holders.connected("p", None, Some(1000)));
        assert!(!holders.connected("p", None, Some(1001)));
        clock.set(7000);
        assert!(!holders.connected("p", None, None));
    }

    #[test]
    fn resume_and_suspend_replies_carry_the_lease() {
        let lease = obj! {
            "pane_id" => "p", "session_id" => "s1", "cwd" => "/w",
            "terminal_args" => vec![Value::from("--model"), Value::from("opus")],
        };
        let drivers = test_drivers();
        assert_eq!(
            js::stringify(&Value::Object(resume_reply(&lease, None, &drivers))),
            r#"{"action":"resume","session_id":"s1","cwd":"/w","argv":["claude","--model","opus","--resume","s1"],"args":["--model","opus","--resume","s1"]}"#
        );
        let profile = AgentCommand {
            program: "glm-claude".into(),
            env: vec![("BASE".into(), "x".into())],
            unset: vec!["KEY".into()],
            model: Some("glm".into()),
            ..AgentCommand::default()
        };
        assert_eq!(
            js::stringify(&Value::Object(resume_reply(
                &lease,
                Some(&profile),
                &drivers
            ))),
            r#"{"action":"resume","session_id":"s1","cwd":"/w","argv":["glm-claude","--model","glm","--resume","s1"],"args":["--model","glm","--resume","s1"],"agent":"claude","env":{"BASE":"x"},"unset":["KEY"]}"#
        );
        assert_eq!(
            js::stringify(&Value::Object(suspend_reply(&lease, Some("Fix")))),
            r#"{"action":"suspend","session_id":"s1","cwd":"/w","title":"Fix","terminal_args":["--model","opus"]}"#
        );
    }
}
