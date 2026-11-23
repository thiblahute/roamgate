//! The two handovers between a pane's interactive agent and conversation
//! mode's headless one (`handover.ts`). Each step checks; anything
//! unexpected refuses and leaves the session with the writer it had, so the
//! two never run on one session at the same time.
//!
//! Results are Bun's `AgentChatHandoverResult` objects (`{ok: true, owner,
//! session_id, ...}` or `{ok: false, reason, waiting?, writer?}`).

use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use roamgate_agents::js::{self, rec, str_of};
use roamgate_agents::obj;
use serde_json::Value;

use crate::driver::{BoxFuture, ConversationDriver, Drivers, PaneProcess, TerminalDriver};
use crate::herdr::{ConversationHerdr, HerdrResult, PaneProcessInfo, WriterElsewhere};
use crate::holder::{HolderRegistry, resume_reply, suspend_reply};
use crate::holder_script::resume_command as default_resume_command;
use crate::lease::LeaseStore;
use crate::shared::{
    AgentCommand, LaunchSpec, Lease, Obj, accepted, is_ok, lease_headless_ids, lease_str,
    lease_terminal_args, other_writer_doing, other_writer_place, reason, refuse, with_model,
};
use crate::time::{SharedClock, sleep_ms};

/// What a handover needs of the session's headless side (`HeadlessSide`).
pub trait HeadlessSide: Send + Sync {
    fn busy(&self) -> bool;
    /// Tasks that outlive their turn (background commands, subagents).
    fn background_tasks(&self) -> usize;
    fn queue_length(&self) -> usize;
    fn interrupt(&self) -> BoxFuture<'_, bool>;
    fn wait_for_result(&self, timeout_ms: u64) -> BoxFuture<'_, bool>;
    /// Closes stdin and waits; true once no process runs.
    fn stop(&self) -> BoxFuture<'_, bool>;
    fn pid(&self) -> Option<u32>;
}

/// The handover's waits (`HandoverDeps`' times), in milliseconds.
#[derive(Clone, Debug)]
pub struct HandoverTimes {
    /// How long the TUI or the headless process gets to exit.
    pub exit_timeout_ms: i64,
    /// How long the holder gets to show up in the pane.
    pub holder_timeout_ms: i64,
    /// How long Herdr gets to map the pane to the session again.
    pub confirm_timeout_ms: i64,
    /// How long a TUI that missed the exit deadline is still watched.
    pub late_exit_ms: i64,
    /// The first wait between two checks; each wait is longer, up to
    /// `max_poll_ms`.
    pub poll_ms: i64,
    pub max_poll_ms: i64,
    /// The same for the late exit watch, which checks less often.
    pub late_poll_ms: i64,
    pub late_max_poll_ms: i64,
    /// How long the TUI must stay idle at an empty prompt, checked again,
    /// before the exit is typed.
    pub settle_ms: i64,
}

impl Default for HandoverTimes {
    fn default() -> Self {
        Self {
            exit_timeout_ms: 15_000,
            holder_timeout_ms: 10_000,
            confirm_timeout_ms: 20_000,
            late_exit_ms: 120_000,
            poll_ms: 200,
            max_poll_ms: 2000,
            late_poll_ms: 2000,
            late_max_poll_ms: 15_000,
            settle_ms: 400,
        }
    }
}

pub type ResumeCommand = Arc<dyn Fn(&str, &[String], &dyn TerminalDriver) -> String + Send + Sync>;
pub type TerminalTasks =
    Arc<dyn Fn(String, String) -> BoxFuture<'static, Result<usize, String>> + Send + Sync>;
pub type ExitSwallowed =
    Arc<dyn Fn(String, String, i64) -> BoxFuture<'static, Result<bool, String>> + Send + Sync>;

/// What the handover is given (`HandoverDeps`).
#[derive(Clone)]
pub struct HandoverDeps {
    pub herdr: Arc<dyn ConversationHerdr>,
    pub leases: LeaseStore,
    pub holders: HolderRegistry,
    pub drivers: Drivers,
    pub clock: SharedClock,
    pub holder_command: Arc<dyn Fn(&str) -> String + Send + Sync>,
    /// What is typed into a bare shell to resume the session in its TUI
    /// (default: `holder_script::resume_command`).
    pub resume_command: Option<ResumeCommand>,
    /// The driver of the agent Herdr names in a pane; None when
    /// conversation mode cannot drive it (default: the drivers').
    pub driver_for: Option<Arc<dyn Fn(&Value) -> Option<ConversationDriver> + Send + Sync>>,
    /// A pane's lease changed (each phase): the browsers are told.
    pub on_lease: Option<Arc<dyn Fn(&str) + Send + Sync>>,
    /// The connection is going away: nothing more is changed; a handover
    /// still running gives up where it is.
    pub closed: Option<Arc<dyn Fn() -> bool + Send + Sync>>,
    /// The profile a session resumes with (absent or plain: the driver's
    /// own program, typed as before profiles).
    pub resume_profile: Option<Arc<dyn Fn(&str) -> Option<AgentCommand> + Send + Sync>>,
    /// Typed to start a launch roamgate-hold fetches (a profile's agent).
    pub launch_command: Option<Arc<dyn Fn(&str, LaunchSpec) -> String + Send + Sync>>,
    /// A lease's pane is gone: its lease and process go too.
    pub on_pane_gone: Option<Arc<dyn Fn(&str) + Send + Sync>>,
    /// The background commands the pane's session still runs, from its
    /// transcript, asked when the footer cannot say: (pane, Herdr agent).
    pub terminal_tasks: Option<TerminalTasks>,
    /// Someone should know (the log): the exit asked first and was
    /// answered Stay.
    pub on_exit_dialog: Option<Arc<dyn Fn(&str, Option<&str>) + Send + Sync>>,
    /// The pane agent's exact status when something better than Herdr's
    /// screen detection knows it (a Claude mod inside it).
    pub exact_status: Option<Arc<dyn Fn(&str) -> Option<String> + Send + Sync>>,
    /// Whether the pane session's transcript has `command` as an ordinary
    /// user message since `since_ms`: (pane, command, since_ms).
    pub exit_swallowed: Option<ExitSwallowed>,
    pub times: HandoverTimes,
}

impl HandoverDeps {
    pub fn new(
        herdr: Arc<dyn ConversationHerdr>,
        leases: LeaseStore,
        holders: HolderRegistry,
        drivers: Drivers,
        clock: SharedClock,
        holder_command: Arc<dyn Fn(&str) -> String + Send + Sync>,
    ) -> Self {
        Self {
            herdr,
            leases,
            holders,
            drivers,
            clock,
            holder_command,
            resume_command: None,
            driver_for: None,
            on_lease: None,
            closed: None,
            resume_profile: None,
            launch_command: None,
            on_pane_gone: None,
            terminal_tasks: None,
            on_exit_dialog: None,
            exact_status: None,
            exit_swallowed: None,
            times: HandoverTimes::default(),
        }
    }
}

/// Whether a transcript tail (JSONL) has `command` sent as an ordinary user
/// message at or after `since_ms`, alone or after something else in the
/// prompt box ("[Image #2]/exit"). A command the TUI ran is recorded as a
/// `<command-name>` message, which is not one (`exitSentAsMessage`).
pub fn exit_sent_as_message(tail: &str, command: &str, since_ms: i64) -> bool {
    for line in tail.split('\n').rev() {
        let line = js::trim(line);
        if !line.starts_with('{') {
            continue;
        }
        let Some(Value::Object(record)) = js::parse(line) else {
            continue;
        };
        if record.get("type").and_then(Value::as_str) != Some("user") {
            continue;
        }
        let at = str_of(record.get("timestamp"))
            .map(js::date_parse)
            .unwrap_or(f64::NAN);
        // Older than the exit: nothing before it is either (a second's
        // slack for the two clocks).
        if at.is_finite() && at < (since_ms - 1000) as f64 {
            return false;
        }
        if record.get("isMeta") == Some(&Value::Bool(true)) {
            continue;
        }
        let content = rec(record.get("message")).and_then(|message| message.get("content"));
        let text = match content {
            Some(Value::String(text)) => text.clone(),
            Some(Value::Array(parts)) => parts
                .iter()
                .map(|part| match part.as_object() {
                    Some(part) if part.get("type").and_then(Value::as_str) == Some("text") => {
                        str_of(part.get("text")).unwrap_or("").to_owned()
                    }
                    _ => String::new(),
                })
                .collect(),
            _ => String::new(),
        };
        if text.contains("<command-name>") {
            continue;
        }
        if js::trim(&text).ends_with(command) {
            return true;
        }
    }
    false
}

/// Why a handover step stopped before its end.
enum Stop {
    /// The connection is closing.
    Closed,
}

type Step<T> = Result<T, Stop>;

/// Refused for now: the switch waits for the agent's background work.
fn wait_for_background(terminal: &dyn TerminalDriver, work: Option<&str>) -> Obj {
    let mut result = refuse(format!(
        "{} still runs background work{} that exiting would stop; it switches once that work is done",
        terminal.display_name(),
        work.map(|work| format!(" ({work})")).unwrap_or_default()
    ));
    result.insert("waiting".into(), Value::from("background_tasks"));
    result
}

/// Refused while another writer has the session. One in another pane is
/// described (where, whether it is idle); `quit_refusal` says why it did
/// not quit when the user asked.
fn refuse_writer(found: &WriterElsewhere, quit_refusal: Option<&str>) -> Obj {
    let Some(pane) = &found.pane else {
        return refuse(format!("{}; close it there first", found.text));
    };
    let mut writer = pane.clone();
    if let Some(why) = quit_refusal {
        writer.insert("quit_refusal".into(), Value::from(why));
    }
    let place = other_writer_place(&writer);
    let named = if place.starts_with("pane ") {
        place
    } else {
        format!(
            "{place} (pane {})",
            str_of(writer.get("pane_id")).unwrap_or("")
        )
    };
    let name = str_of(writer.get("agent_name")).unwrap_or("").to_owned();
    let mut result = refuse(format!(
        "This session is also open in {named}{}. Only one {name} can write a session at a time, so this waits until that one is closed{}",
        other_writer_doing(&writer),
        quit_refusal
            .map(|why| format!(". It did not quit: {why}"))
            .unwrap_or_default()
    ));
    result.insert("writer".into(), Value::Object(writer));
    result
}

fn session_of(agent: Option<&Obj>) -> Option<String> {
    let session = rec(agent?.get("agent_session"))?;
    if str_of(session.get("kind")) != Some("id") {
        return None;
    }
    str_of(session.get("value"))
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
}

fn shell_in_foreground(info: &PaneProcessInfo, terminal: &dyn TerminalDriver) -> bool {
    info.shell_pid.is_some()
        && info.foreground_process_group_id == info.shell_pid
        && !info
            .foreground_processes
            .iter()
            .any(|process| terminal.is_agent_process(process))
}

/// A pane whose TUI was sent its exit and missed the deadline: it may
/// still exit, and is watched.
struct ExitWatch {
    command: String,
    sent_at: i64,
    /// Ended: the watch resumes nothing, and stops at its next check.
    over: AtomicBool,
}

/// What an exited agent leaves for the handover.
struct ExitedAgent {
    session_id: String,
    terminal: Arc<dyn TerminalDriver>,
    terminal_args: Vec<String>,
    cwd: String,
    /// The lease's `agent` (absent for Claude, as before drivers).
    agent: Option<String>,
    tui: PaneProcess,
}

enum Exit {
    Done(ExitedAgent),
    Refused(Obj),
}

/// Marks of an exit: once the TUI is about to be asked, and when it did
/// not exit after all.
#[derive(Default)]
struct ExitMarks<'a> {
    exiting: Option<&'a (dyn Fn(&ExitedAgent) + Send + Sync)>,
    failed: Option<&'a (dyn Fn() + Send + Sync)>,
}

/// What a session suspended as a shell job kept (`fromSuspended`'s spec).
#[derive(Clone, Debug, Default, PartialEq)]
pub struct SuspendedSpec {
    pub session_id: String,
    pub cwd: String,
    pub agent: Option<String>,
    pub terminal_args: Vec<String>,
}

/// What a hand-back is asked.
#[derive(Clone, Debug, Default)]
pub struct ToTerminal {
    pub interrupt: bool,
    /// Default true: Herdr's mapping of the pane is waited for.
    pub confirm: Option<bool>,
    /// The chat's Ctrl+Z: the holder stops as a shell job, with the
    /// conversation's title (the outer Some).
    pub suspend: Option<Option<String>>,
}

struct Inner {
    deps: HandoverDeps,
    running: Mutex<HashSet<String>>,
    exiting: Mutex<HashMap<String, Arc<ExitWatch>>>,
}

/// The handovers of one connection (`createHandover`). Cheap to clone.
#[derive(Clone)]
pub struct Handover {
    inner: Arc<Inner>,
}

fn add_lease_fields(lease: &mut Lease, agent: &Option<String>, terminal_args: &[String]) {
    if let Some(agent) = agent {
        lease.insert("agent".into(), Value::from(agent.clone()));
    }
    if !terminal_args.is_empty() {
        lease.insert(
            "terminal_args".into(),
            Value::Array(terminal_args.iter().cloned().map(Value::String).collect()),
        );
    }
}

impl Handover {
    pub fn new(deps: HandoverDeps) -> Self {
        Self {
            inner: Arc::new(Inner {
                deps,
                running: Mutex::new(HashSet::new()),
                exiting: Mutex::new(HashMap::new()),
            }),
        }
    }

    fn deps(&self) -> &HandoverDeps {
        &self.inner.deps
    }

    fn times(&self) -> &HandoverTimes {
        &self.inner.deps.times
    }

    fn now(&self) -> i64 {
        self.deps().clock.now()
    }

    async fn sleep(&self, ms: i64) {
        sleep_ms(&*self.deps().clock, ms.max(0) as u64).await
    }

    fn driver_for(&self, herdr_agent: &Value) -> Option<ConversationDriver> {
        match &self.deps().driver_for {
            Some(driver_for) => driver_for(herdr_agent),
            None => herdr_agent
                .as_str()
                .and_then(|name| self.deps().drivers.for_herdr_agent(name))
                .cloned(),
        }
    }

    /// A lease's driver: the agent it was taken from (absent: the default).
    fn lease_terminal(&self, lease: &Lease) -> Arc<dyn TerminalDriver> {
        self.deps()
            .drivers
            .of(lease_str(lease, "agent"))
            .terminal
            .clone()
    }

    fn closed(&self) -> bool {
        self.deps().closed.as_ref().is_some_and(|closed| closed())
    }

    /// Fails once the connection closes: the handover stops there.
    fn guard(&self) -> Step<()> {
        if self.closed() {
            Err(Stop::Closed)
        } else {
            Ok(())
        }
    }

    fn lease_changed(&self, pane_id: &str) {
        if let Some(on_lease) = &self.deps().on_lease {
            on_lease(pane_id);
        }
    }

    fn set_lease(&self, lease: Lease) -> Step<Lease> {
        self.guard()?;
        let pane = lease_str(&lease, "pane_id").unwrap_or("").to_owned();
        let next = self.deps().leases.set(lease);
        self.lease_changed(&pane);
        Ok(next)
    }

    fn delete_lease(&self, pane_id: &str) -> Step<()> {
        self.guard()?;
        self.deps().leases.delete(pane_id);
        self.lease_changed(pane_id);
        Ok(())
    }

    /// Ends a pane's exit watch; true when there was one.
    fn end_exit_watch(&self, pane_id: &str) -> bool {
        match self.inner.exiting.lock().unwrap().remove(pane_id) {
            Some(watch) => {
                watch.over.store(true, Ordering::SeqCst);
                true
            }
            None => false,
        }
    }

    /// Whether the exit typed into the pane's TUI was taken as a message:
    /// its transcript has it as one, or the TUI started a turn.
    async fn exit_was_swallowed(&self, pane_id: &str, command: &str, sent_at: i64) -> bool {
        if self
            .deps()
            .exact_status
            .as_ref()
            .and_then(|exact| exact(pane_id))
            .as_deref()
            == Some("working")
        {
            return true;
        }
        let Some(swallowed) = &self.deps().exit_swallowed else {
            return false;
        };
        swallowed(pane_id.to_owned(), command.to_owned(), sent_at)
            .await
            .unwrap_or(false)
    }

    /// Checks until true or the deadline, waiting longer each time (a check
    /// may be a command on the pane's host, over SSH).
    async fn until<'c>(
        &self,
        mut check: impl FnMut() -> BoxFuture<'c, HerdrResult<bool>> + Send,
        timeout_ms: i64,
        first: Option<i64>,
        most: Option<i64>,
    ) -> Step<bool> {
        let deadline = self.now() + timeout_ms;
        let mut wait = first.unwrap_or(self.times().poll_ms);
        let most = most.unwrap_or(self.times().max_poll_ms);
        loop {
            self.guard()?;
            if check().await.unwrap_or(false) {
                return Ok(true);
            }
            if self.now() >= deadline {
                return Ok(false);
            }
            self.sleep(wait.min((deadline - self.now()).max(0))).await;
            wait = most.min((wait as f64 * 1.5).ceil() as i64);
        }
    }

    /// The exit found background work and asks what to do: Stay is
    /// answered, and the prompt is waited back. True when the question was
    /// there.
    async fn answer_exit_dialog(&self, pane_id: &str, terminal: &dyn TerminalDriver) -> Step<bool> {
        let herdr = &self.deps().herdr;
        let screen = herdr.read_detection(pane_id).await.unwrap_or_default();
        let Some(stay_key) = terminal.exit_dialog(&screen) else {
            return Ok(false);
        };
        let _ = herdr.send_keys(pane_id, &stay_key).await;
        let work: Mutex<Option<String>> = Mutex::new(None);
        self.until(
            || {
                Box::pin(async {
                    let after = herdr.read_detection(pane_id).await?;
                    if terminal.exit_dialog(&after).is_some() {
                        return Ok(false);
                    }
                    *work.lock().unwrap() = terminal.background_work(&after);
                    Ok(true)
                })
            },
            5000,
            None,
            None,
        )
        .await?;
        if let Some(on_exit_dialog) = &self.deps().on_exit_dialog {
            on_exit_dialog(pane_id, work.lock().unwrap().as_deref());
        }
        Ok(true)
    }

    async fn exclusive(
        &self,
        pane_id: &str,
        run: impl std::future::Future<Output = Step<Obj>>,
    ) -> Result<Obj, String> {
        if !self
            .inner
            .running
            .lock()
            .unwrap()
            .insert(pane_id.to_owned())
        {
            return Ok(refuse("A handover of this pane is already running"));
        }
        let result = match self.guard() {
            Err(stop) => Err(stop),
            Ok(()) => run.await,
        };
        self.inner.running.lock().unwrap().remove(pane_id);
        match result {
            Ok(result) => Ok(result),
            Err(Stop::Closed) => Ok(refuse("The connection is closing")),
        }
    }

    /// The pane is a bare shell (the agent gone, no holder): the agent is
    /// resumed there, so the session is never left with no writer and no
    /// way back.
    async fn resume_in_shell(
        &self,
        pane_id: &str,
        terminal: &dyn TerminalDriver,
        session_id: &str,
        args: &[String],
    ) -> Result<bool, String> {
        if self.closed() || self.deps().leases.get(pane_id).is_some() {
            return Ok(false);
        }
        let Ok(info) = self.deps().herdr.process_info(pane_id).await else {
            return Ok(false);
        };
        if !shell_in_foreground(&info, terminal) {
            return Ok(false);
        }
        let text = self.resume_text(pane_id, session_id, args, terminal);
        self.deps().herdr.send_text(pane_id, &text).await?;
        Ok(true)
    }

    /// What is typed to resume a session in its TUI: plain as before
    /// profiles, else a one-use launch roamgate-hold fetches (its
    /// environment is never typed).
    fn resume_text(
        &self,
        pane_id: &str,
        session_id: &str,
        args: &[String],
        terminal: &dyn TerminalDriver,
    ) -> String {
        let profile = self
            .deps()
            .resume_profile
            .as_ref()
            .and_then(|profile| profile(session_id));
        let flags = with_model(
            args,
            profile
                .as_ref()
                .and_then(|profile| profile.model.as_deref()),
        );
        let custom = profile.filter(|profile| !profile.plain);
        match (custom, &self.deps().launch_command) {
            (Some(profile), Some(launch)) => {
                let mut argv = terminal.resume_argv(session_id, &flags);
                argv[0] = profile.program.clone();
                launch(
                    pane_id,
                    LaunchSpec {
                        argv,
                        env: profile.env.clone(),
                        unset: profile.unset.clone(),
                        agent: terminal.agent().to_owned(),
                        terminal: true,
                    },
                )
            }
            _ => match &self.deps().resume_command {
                Some(resume) => resume(session_id, &flags, terminal),
                None => default_resume_command(session_id, &flags, terminal).unwrap_or_default(),
            },
        }
    }

    /// A TUI that missed the exit deadline (slow hooks, an exit queued
    /// behind a turn) may still exit: it is watched a while longer and, if
    /// it does, the agent is resumed in the shell it leaves.
    fn watch_late_exit(
        &self,
        pane_id: &str,
        terminal: Arc<dyn TerminalDriver>,
        pid: u32,
        session_id: String,
        args: Vec<String>,
        resume: bool,
        sent_at: i64,
    ) {
        let watch = {
            let mut exiting = self.inner.exiting.lock().unwrap();
            if exiting.contains_key(pane_id) {
                return;
            }
            let watch = Arc::new(ExitWatch {
                command: terminal.exit_command().to_owned(),
                sent_at,
                over: AtomicBool::new(false),
            });
            exiting.insert(pane_id.to_owned(), watch.clone());
            watch
        };
        let this = self.clone();
        let pane_id = pane_id.to_owned();
        tokio::spawn(async move {
            // The agent asking about background work does not exit: it is
            // answered Stay, and the watch ends. So does an exit taken as
            // a message.
            let stayed = AtomicBool::new(false);
            let exited = this
                .until(
                    || {
                        Box::pin(async {
                            if watch.over.load(Ordering::SeqCst) {
                                return Ok(true);
                            }
                            if this.deps().herdr.pid_alive(pid).await {
                                let asked = this
                                    .answer_exit_dialog(&pane_id, &*terminal)
                                    .await
                                    .unwrap_or(false);
                                stayed.store(asked, Ordering::SeqCst);
                                if asked {
                                    return Ok(true);
                                }
                                if this
                                    .exit_was_swallowed(&pane_id, &watch.command, watch.sent_at)
                                    .await
                                {
                                    watch.over.store(true, Ordering::SeqCst);
                                    return Ok(true);
                                }
                                return Ok(false);
                            }
                            let info = this.deps().herdr.process_info(&pane_id).await?;
                            Ok(shell_in_foreground(&info, &*terminal))
                        })
                    },
                    this.times().late_exit_ms,
                    Some(this.times().late_poll_ms),
                    Some(this.times().late_max_poll_ms),
                )
                .await
                .unwrap_or(false);
            if resume
                && exited
                && !stayed.load(Ordering::SeqCst)
                && !watch.over.load(Ordering::SeqCst)
                && !this.inner.running.lock().unwrap().contains(&pane_id)
            {
                let _ = this
                    .resume_in_shell(&pane_id, &*terminal, &session_id, &args)
                    .await;
            }
            // Not another watch started since this one was ended.
            let mut exiting = this.inner.exiting.lock().unwrap();
            if exiting
                .get(&pane_id)
                .is_some_and(|current| Arc::ptr_eq(current, &watch))
            {
                exiting.remove(&pane_id);
            }
        });
    }

    /// The other pane holding this session in conversation mode, if live.
    async fn live_owner_elsewhere(&self, pane_id: &str, session_id: &str) -> Step<Option<Lease>> {
        let Some(other) = self.deps().leases.by_session(session_id) else {
            return Ok(None);
        };
        let other_pane = lease_str(&other, "pane_id").unwrap_or("").to_owned();
        if other_pane == pane_id {
            return Ok(None);
        }
        // A pane that was closed leaves its lease behind: it goes now.
        if !self
            .deps()
            .herdr
            .pane_exists(&other_pane)
            .await
            .unwrap_or(true)
        {
            self.guard()?;
            if let Some(gone) = &self.deps().on_pane_gone {
                gone(&other_pane);
            }
            return Ok(self.deps().leases.get(&other_pane).map(|_| other));
        }
        Ok(Some(other))
    }

    /// Why the pane's agent cannot be asked to exit now, if so.
    fn not_idle(&self, pane_id: &str, agent: &Obj, name: &str) -> Option<Obj> {
        let exact = self
            .deps()
            .exact_status
            .as_ref()
            .and_then(|exact| exact(pane_id));
        let status = exact.or_else(|| str_of(agent.get("agent_status")).map(str::to_owned));
        match status.as_deref() {
            Some("idle" | "done") => None,
            Some("working") => Some(refuse(format!(
                "{name} is working (a turn or a background task); it can switch once it is idle"
            ))),
            Some("blocked") => Some(refuse(format!(
                "{name} is waiting for an answer in the terminal"
            ))),
            _ => Some(refuse(format!("Herdr cannot tell whether {name} is idle"))),
        }
    }

    /// The pane's TUI looked at again just before the exit is typed: still
    /// idle, its prompt box still empty, no background work. None when so,
    /// else the refusal.
    async fn idle_at_empty_prompt(
        &self,
        pane_id: &str,
        terminal: &dyn TerminalDriver,
    ) -> Option<Obj> {
        let name = terminal.display_name();
        let agent = match self.deps().herdr.agent_get(pane_id).await {
            Ok(agent) => agent,
            Err(error) => {
                return Some(refuse(format!(
                    "Herdr did not say what runs in the pane: {error}"
                )));
            }
        };
        let Some(agent) = agent else {
            return Some(refuse(format!("{name} is not running in this pane")));
        };
        if let Some(busy) = self.not_idle(pane_id, &agent, name) {
            return Some(busy);
        }
        let screen = match self.deps().herdr.read_detection(pane_id).await {
            Ok(screen) => screen,
            Err(error) => {
                return Some(refuse(format!(
                    "Could not read {name}'s prompt box: {error}"
                )));
            }
        };
        let ready = terminal.readiness(&screen);
        if let Some(work) = ready.background {
            return Some(wait_for_background(terminal, Some(&work)));
        }
        ready.refusal.map(refuse)
    }

    /// Checks the pane's idle TUI may exit (nothing typed, no background
    /// work, no other writer), sends it its exit and waits for its shell.
    ///
    /// `quit_writer` names the other pane whose idle TUI the user chose to
    /// quit, should it be the writer found: it gets the exit the same way,
    /// and this pane is checked again from the start. `quitting` is that
    /// other pane's own exit: the writer it is quit for is not asked about,
    /// and nothing is resumed there if it exits late.
    fn exit_agent<'a>(
        &'a self,
        pane_id: &'a str,
        expected_session_id: Option<&'a str>,
        marks: ExitMarks<'a>,
        quit_writer: Option<&'a str>,
        quitting: bool,
    ) -> BoxFuture<'a, Step<Exit>> {
        Box::pin(async move {
            let herdr = self.deps().herdr.clone();
            let fail = |marks: &ExitMarks<'_>| {
                if let Some(failed) = marks.failed {
                    failed();
                }
            };
            // The exit went already and the agent may still be exiting:
            // never twice, unless it was taken as a message.
            let watch = self.inner.exiting.lock().unwrap().get(pane_id).cloned();
            if let Some(watch) = watch {
                if !self
                    .exit_was_swallowed(pane_id, &watch.command, watch.sent_at)
                    .await
                {
                    return Ok(Exit::Refused(refuse(
                        "Claude was already asked to exit and may still be exiting; wait for it, or cancel the switch to ask again",
                    )));
                }
                self.end_exit_watch(pane_id);
            }
            let agent = match herdr.agent_get(pane_id).await {
                Ok(agent) => agent,
                Err(error) => {
                    return Ok(Exit::Refused(refuse(format!(
                        "Herdr did not say what runs in the pane: {error}"
                    ))));
                }
            };
            let driver = agent
                .as_ref()
                .and_then(|agent| self.driver_for(agent.get("agent").unwrap_or(&Value::Null)));
            let (Some(agent), Some(driver)) = (agent, driver) else {
                return Ok(Exit::Refused(refuse("Claude is not running in this pane")));
            };
            let terminal = driver.terminal.clone();
            let name = terminal.display_name().to_owned();
            if let Some(busy) = self.not_idle(pane_id, &agent, &name) {
                return Ok(Exit::Refused(busy));
            }
            let Some(session_id) = session_of(Some(&agent)) else {
                return Ok(Exit::Refused(refuse(
                    "Herdr has no session id for this pane",
                )));
            };
            if expected_session_id
                .is_some_and(|expected| !expected.is_empty() && expected != session_id)
            {
                return Ok(Exit::Refused(refuse("The pane now runs another session")));
            }
            if self
                .live_owner_elsewhere(pane_id, &session_id)
                .await?
                .is_some()
            {
                return Ok(Exit::Refused(refuse(
                    "Conversation mode already owns this session in another pane",
                )));
            }
            let screen = match herdr.read_detection(pane_id).await {
                Ok(screen) => screen,
                Err(error) => {
                    return Ok(Exit::Refused(refuse(format!(
                        "Could not read {name}'s prompt box: {error}"
                    ))));
                }
            };
            // Exiting would stop it (or ask first): not idle yet.
            let ready = terminal.readiness(&screen);
            if let Some(work) = &ready.background {
                return Ok(Exit::Refused(wait_for_background(&*terminal, Some(work))));
            }
            // A narrow pane cuts the footer short: the transcript says.
            if !ready.background_known
                && let Some(tasks) = &self.deps().terminal_tasks
            {
                let count = tasks(pane_id.to_owned(), terminal.herdr_agent().to_owned())
                    .await
                    .unwrap_or(0);
                if count > 0 {
                    let work = if count == 1 {
                        "1 background command".to_owned()
                    } else {
                        format!("{count} background commands")
                    };
                    return Ok(Exit::Refused(wait_for_background(&*terminal, Some(&work))));
                }
            }
            if let Some(refusal) = ready.refusal {
                return Ok(Exit::Refused(refuse(refusal)));
            }
            let info = match herdr.process_info(pane_id).await {
                Ok(info) => info,
                Err(error) => {
                    return Ok(Exit::Refused(refuse(format!(
                        "Herdr did not list the pane's processes: {error}"
                    ))));
                }
            };
            let tuis: Vec<&PaneProcess> = info
                .foreground_processes
                .iter()
                .filter(|process| terminal.is_agent_process(process))
                .collect();
            if tuis.len() != 1 || info.shell_pid.is_none() {
                return Ok(Exit::Refused(refuse(format!(
                    "Cannot tell which process is {name} in this pane"
                ))));
            }
            let tui = tuis[0].clone();
            if !quitting {
                let ids = vec![session_id.clone()];
                let pids = vec![tui.pid];
                let elsewhere = match herdr.writer_elsewhere(pane_id, &ids, &pids).await {
                    Ok(found) => found,
                    Err(error) => {
                        return Ok(Exit::Refused(refuse(format!(
                            "Could not check for other writers on the session: {error}"
                        ))));
                    }
                };
                if let Some(elsewhere) = elsewhere {
                    let other = elsewhere.pane.as_ref();
                    let other_pane = other.and_then(|other| str_of(other.get("pane_id")));
                    // Only the one the user chose, and only while idle.
                    if other.is_none()
                        || other_pane != quit_writer
                        || other.and_then(|other| str_of(other.get("status"))) != Some("idle")
                    {
                        return Ok(Exit::Refused(refuse_writer(&elsewhere, None)));
                    }
                    let other_pane = other_pane.unwrap_or("").to_owned();
                    let why = self
                        .quit_other_writer(&other_pane, &session_id, pane_id, &ids, &pids)
                        .await?;
                    if let Some(why) = why {
                        let still = herdr
                            .writer_elsewhere(pane_id, &ids, &pids)
                            .await
                            .unwrap_or(Some(elsewhere.clone()));
                        if let Some(still) = still {
                            return Ok(Exit::Refused(refuse_writer(&still, Some(&why))));
                        }
                    }
                    // Checked afresh, from the start: this pane's TUI,
                    // other writers.
                    return self
                        .exit_agent(pane_id, Some(&session_id), marks, None, false)
                        .await;
                }
            }
            let terminal_args = terminal.kept_flags(&tui);
            let cwd = tui
                .cwd
                .clone()
                .filter(|cwd| !cwd.is_empty())
                .or_else(|| str_of(agent.get("foreground_cwd")).map(str::to_owned))
                .unwrap_or_default();
            if !quitting && !cwd.starts_with('/') {
                return Ok(Exit::Refused(refuse(format!(
                    "Herdr did not report {name}'s working directory"
                ))));
            }
            // Claude's leases name no agent (as before drivers).
            let agent_field = (terminal.agent() != "claude").then(|| terminal.agent().to_owned());
            let exited_agent = ExitedAgent {
                session_id: session_id.clone(),
                terminal: terminal.clone(),
                terminal_args: terminal_args.clone(),
                cwd,
                agent: agent_field,
                tui: tui.clone(),
            };
            // The exit goes only to a TUI idle at an empty prompt: looked
            // at again a moment later, so a paste or a turn starting just
            // now shows.
            if self.times().settle_ms > 0 {
                self.sleep(self.times().settle_ms).await;
                self.guard()?;
                if let Some(changed) = self.idle_at_empty_prompt(pane_id, &*terminal).await {
                    return Ok(Exit::Refused(changed));
                }
            }
            if let Some(exiting) = marks.exiting {
                exiting(&exited_agent);
                self.guard()?;
            }
            let sent_at = self.now();
            if let Err(error) = herdr.prompt(pane_id, terminal.exit_command()).await {
                fail(&marks);
                return Ok(Exit::Refused(refuse(format!(
                    "{name} did not take {}: {error}",
                    terminal.exit_command()
                ))));
            }
            // Background work the screen did not show: the agent asks
            // before exiting. It is answered Stay, and the switch waits.
            let stayed = AtomicBool::new(false);
            let swallowed = AtomicBool::new(false);
            let exited = self
                .until(
                    || {
                        Box::pin(async {
                            if herdr.pid_alive(tui.pid).await {
                                let asked = self
                                    .answer_exit_dialog(pane_id, &*terminal)
                                    .await
                                    .unwrap_or(false);
                                stayed.store(asked, Ordering::SeqCst);
                                if asked {
                                    return Ok(true);
                                }
                                let taken = self
                                    .exit_was_swallowed(pane_id, terminal.exit_command(), sent_at)
                                    .await;
                                swallowed.store(taken, Ordering::SeqCst);
                                return Ok(taken);
                            }
                            let info = herdr.process_info(pane_id).await?;
                            Ok(shell_in_foreground(&info, &*terminal))
                        })
                    },
                    self.times().exit_timeout_ms,
                    None,
                    None,
                )
                .await?;
            if swallowed.load(Ordering::SeqCst) {
                // Nothing exits: the switch may be asked again once idle.
                fail(&marks);
                return Ok(Exit::Refused(refuse(format!(
                    "{name} took {} as a message instead of exiting (something reached its prompt box at the same moment), so the terminal keeps the session; switch again once it is idle",
                    terminal.exit_command()
                ))));
            }
            if stayed.load(Ordering::SeqCst) {
                fail(&marks);
                let screen = herdr.read_detection(pane_id).await.unwrap_or_default();
                return Ok(Exit::Refused(wait_for_background(
                    &*terminal,
                    terminal.background_work(&screen).as_deref(),
                )));
            }
            if !exited {
                // The TUI may still run: it keeps the session. Should it
                // exit after all, the agent is resumed in the shell it
                // leaves (not in a pane it was quit in for another).
                fail(&marks);
                self.watch_late_exit(
                    pane_id,
                    terminal.clone(),
                    tui.pid,
                    session_id,
                    terminal_args,
                    !quitting,
                    sent_at,
                );
                return Ok(Exit::Refused(refuse(format!(
                    "{name} did not exit in time; the terminal keeps the session"
                ))));
            }
            Ok(Exit::Done(exited_agent))
        })
    }

    /// The user chose to quit the idle TUI another pane runs the session
    /// in: it is checked and sent its exit as a switch's own would be, and
    /// the pane and its shell stay. Waits until the writer check no longer
    /// finds it there. None once it quit, else why not.
    async fn quit_other_writer(
        &self,
        other_pane: &str,
        session_id: &str,
        pane_id: &str,
        ids: &[String],
        pids: &[u32],
    ) -> Step<Option<String>> {
        if !self
            .inner
            .running
            .lock()
            .unwrap()
            .insert(other_pane.to_owned())
        {
            return Ok(Some("a switch of that pane is already running".into()));
        }
        let result = async {
            let quit = self
                .exit_agent(
                    other_pane,
                    Some(session_id),
                    ExitMarks::default(),
                    None,
                    true,
                )
                .await?;
            if let Exit::Refused(refusal) = quit {
                return Ok(Some(
                    if refusal.get("waiting").and_then(Value::as_str) == Some("background_tasks") {
                        "it still runs background work that quitting would stop".to_owned()
                    } else {
                        reason(&refusal).to_owned()
                    },
                ));
            }
            // Herdr may take a moment to see the agent gone.
            let herdr = self.deps().herdr.clone();
            self.until(
                || {
                    Box::pin(async {
                        let found = herdr.writer_elsewhere(pane_id, ids, pids).await?;
                        Ok(found
                            .and_then(|found| found.pane)
                            .and_then(|pane| str_of(pane.get("pane_id")).map(str::to_owned))
                            .as_deref()
                            != Some(other_pane))
                    })
                },
                self.times().exit_timeout_ms,
                None,
                None,
            )
            .await?;
            Ok(None)
        }
        .await;
        self.inner.running.lock().unwrap().remove(other_pane);
        result
    }

    /// Terminal to conversation: stop the idle TUI, then hold the pane.
    /// `quit_writer`: the other pane whose idle TUI runs the session too,
    /// which the user chose to quit first. With `lease` the lease taken.
    pub async fn to_conversation(
        &self,
        pane_id: &str,
        expected_session_id: Option<&str>,
        quit_writer: Option<&str>,
    ) -> Result<Obj, String> {
        self.exclusive(
            pane_id,
            self.take(pane_id, expected_session_id, quit_writer),
        )
        .await
    }

    async fn take(
        &self,
        pane_id: &str,
        expected_session_id: Option<&str>,
        quit_writer: Option<&str>,
    ) -> Step<Obj> {
        let herdr = self.deps().herdr.clone();
        let mut current = self.deps().leases.get(pane_id);
        if let Some(lease) = current.clone()
            && lease_str(&lease, "phase") == Some("conversation")
        {
            // The holder may have resumed the agent by itself while
            // Roamgate was away: then the terminal has the session, and
            // the lease is stale.
            let terminal = self.lease_terminal(&lease);
            let info = herdr.process_info(pane_id).await.ok();
            let mut ids = vec![lease_str(&lease, "session_id").unwrap_or("").to_owned()];
            ids.extend(lease_headless_ids(&lease));
            let resumed = info.is_some_and(|info| {
                info.foreground_processes
                    .iter()
                    .any(|process| terminal.is_agent_process(process))
            }) && !herdr.headless_running(&ids).await.unwrap_or(true);
            if !resumed {
                return Ok(accepted(
                    "conversation",
                    lease_str(&lease, "session_id").unwrap_or(""),
                ));
            }
            self.delete_lease(pane_id)?;
            current = None;
        }
        if current.is_some() {
            return Ok(refuse(
                "This session is being handed over; try again shortly",
            ));
        }
        let handing: Mutex<Option<Lease>> = Mutex::new(None);
        let lease_error: Mutex<Option<Stop>> = Mutex::new(None);
        let exiting = |context: &ExitedAgent| {
            let mut lease = obj! {
                "pane_id" => pane_id,
                "session_id" => context.session_id.clone(),
                "cwd" => context.cwd.clone(),
                "phase" => "to_conversation",
            };
            if let Some(agent) = &context.agent {
                lease.insert("agent".into(), Value::from(agent.clone()));
            }
            lease.insert("terminal_pid".into(), Value::from(context.tui.pid));
            add_lease_fields(&mut lease, &None, &context.terminal_args);
            match self.set_lease(lease) {
                Ok(lease) => *handing.lock().unwrap() = Some(lease),
                Err(stop) => *lease_error.lock().unwrap() = Some(stop),
            }
        };
        let failed = || {
            if let Err(stop) = self.delete_lease(pane_id) {
                *lease_error.lock().unwrap() = Some(stop);
            }
        };
        let exited = self
            .exit_agent(
                pane_id,
                expected_session_id,
                ExitMarks {
                    exiting: Some(&exiting),
                    failed: Some(&failed),
                },
                quit_writer,
                false,
            )
            .await?;
        if let Some(stop) = lease_error.lock().unwrap().take() {
            return Err(stop);
        }
        let ExitedAgent {
            session_id,
            terminal,
            terminal_args,
            cwd,
            agent,
            ..
        } = match exited {
            Exit::Refused(refusal) => return Ok(refusal),
            Exit::Done(exited) => exited,
        };
        let name = terminal.display_name().to_owned();
        // The TUI is gone, and nothing writes until the holder has the
        // pane: the lease stays in to_conversation so a holder that never
        // shows up leaves nothing running behind it. Only a holder polling
        // from now on counts.
        let typed_at = self.now();
        self.guard()?;
        let typed = herdr
            .send_text(pane_id, &(self.deps().holder_command)(&session_id))
            .await
            .err();
        let held = typed.is_none()
            && self
                .until(
                    || {
                        Box::pin(async move {
                            Ok(self.deps().holders.connected(pane_id, None, Some(typed_at)))
                        })
                    },
                    self.times().holder_timeout_ms,
                    None,
                    None,
                )
                .await?;
        let handing = handing.lock().unwrap().clone();
        if !held || self.deps().leases.get(pane_id) != handing {
            // A holder that shows up later is told to resume the agent; a
            // shell left bare (the holder could not run) gets it back now.
            self.delete_lease(pane_id)?;
            let resumed = self
                .resume_in_shell(pane_id, &*terminal, &session_id, &terminal_args)
                .await
                .unwrap_or(false);
            let why = typed.map(|error| format!(" ({error})")).unwrap_or_default();
            return Ok(refuse(if resumed {
                format!("The pane holder did not start{why}; {name} was resumed in the terminal")
            } else {
                format!(
                    "The pane holder did not start{why}; run {} there to continue",
                    terminal.resume_argv(&session_id, &[]).join(" ")
                )
            }));
        }
        // Only from here may conversation mode write.
        let mut lease = obj! {
            "pane_id" => pane_id,
            "session_id" => session_id.clone(),
            "cwd" => cwd,
            "phase" => "conversation",
        };
        add_lease_fields(&mut lease, &agent, &terminal_args);
        let lease = self.set_lease(lease)?;
        let mut result = accepted("conversation", &session_id);
        result.insert("lease".into(), Value::Object(lease));
        Ok(result)
    }

    /// Waits for Herdr to map the pane to the session again.
    pub async fn confirm_mapping(&self, pane_id: &str, session_id: &str) -> bool {
        let herdr = self.deps().herdr.clone();
        self.until(
            || {
                Box::pin(async {
                    Ok(
                        session_of(herdr.agent_get(pane_id).await?.as_ref()).as_deref()
                            == Some(session_id),
                    )
                })
            },
            self.times().confirm_timeout_ms,
            None,
            None,
        )
        .await
        .unwrap_or(false)
    }

    /// Whether the pane's holder polls and can stop as a shell job.
    fn suspendable(&self, pane_id: &str) -> bool {
        self.deps().holders.connected(pane_id, None, None)
            && self.deps().holders.job_control(pane_id)
    }

    /// Conversation to terminal: only between turns, with nothing queued;
    /// the headless process exits first, then the holder resumes the
    /// agent. With `suspend` (the chat's Ctrl+Z) the holder stops as a
    /// shell job instead: the shell's prompt is back, no agent runs, and
    /// `fg` there brings the conversation back ([`Self::from_suspended`]).
    pub async fn to_terminal(
        &self,
        pane_id: &str,
        headless: Option<Arc<dyn HeadlessSide>>,
        options: ToTerminal,
    ) -> Result<Obj, String> {
        self.exclusive(
            pane_id,
            self.give_back(pane_id, headless.as_deref(), &options),
        )
        .await
    }

    async fn give_back(
        &self,
        pane_id: &str,
        headless: Option<&dyn HeadlessSide>,
        options: &ToTerminal,
    ) -> Step<Obj> {
        let herdr = self.deps().herdr.clone();
        let lease = self.deps().leases.get(pane_id);
        let Some(lease) = lease.filter(|lease| lease_str(lease, "phase") != Some("terminal"))
        else {
            return Ok(accepted(
                "terminal",
                self.deps()
                    .leases
                    .get(pane_id)
                    .as_ref()
                    .and_then(|lease| lease_str(lease, "session_id"))
                    .unwrap_or(""),
            ));
        };
        let session_id = lease_str(&lease, "session_id").unwrap_or("").to_owned();
        if lease_str(&lease, "phase") != Some("conversation") {
            return Ok(refuse(
                "This session is being handed over; try again shortly",
            ));
        }
        let terminal = self.lease_terminal(&lease);
        let name = terminal.display_name().to_owned();
        // Only a holder that runs as a job of an interactive shell can stop
        // as one.
        if options.suspend.is_some() && !self.suspendable(pane_id) {
            return Ok(refuse(
                "The pane's holder cannot stop as a shell job (it is from an older Roamgate, or its shell has no job control); open it in the terminal instead",
            ));
        }
        if let Some(headless) = headless
            && headless.busy()
        {
            if !options.interrupt {
                return Ok(refuse(format!(
                    "{name} is in the middle of a turn; wait for it to end or stop it"
                )));
            }
            headless.interrupt().await;
            headless
                .wait_for_result(self.times().exit_timeout_ms.max(0) as u64)
                .await;
            if headless.busy() {
                return Ok(refuse(format!(
                    "{name} did not stop its turn; the session stays in conversation mode"
                )));
            }
        }
        let queued = headless
            .map(|headless| headless.queue_length())
            .unwrap_or(0);
        if queued > 0 {
            return Ok(refuse(if queued == 1 {
                "A message waits in the queue; send or remove it first".to_owned()
            } else {
                format!("{queued} messages wait in the queue; send or remove them first")
            }));
        }
        let tasks = headless
            .map(|headless| headless.background_tasks())
            .unwrap_or(0);
        if tasks > 0 {
            return Ok(refuse(if tasks == 1 {
                "A background task still runs in conversation mode; it would die with the process"
                    .to_owned()
            } else {
                format!(
                    "{tasks} background tasks still run in conversation mode; it would die with the process"
                )
            }));
        }
        let mut ids = vec![session_id.clone()];
        for id in lease_headless_ids(&lease) {
            if !ids.contains(&id) {
                ids.push(id);
            }
        }
        // The holder resumed the agent by itself (Roamgate was away): the
        // terminal has the session already.
        let info = herdr.process_info(pane_id).await.ok();
        let in_pane: Vec<u32> = info
            .map(|info| {
                info.foreground_processes
                    .iter()
                    .filter(|process| terminal.is_agent_process(process))
                    .map(|process| process.pid)
                    .collect()
            })
            .unwrap_or_default();
        if !in_pane.is_empty()
            && headless
                .and_then(|headless| headless.pid())
                .is_none_or(|pid| pid == 0)
            && !herdr.headless_running(&ids).await.unwrap_or(true)
        {
            self.delete_lease(pane_id)?;
            return Ok(accepted("terminal", &session_id));
        }
        // Resumed here, the agent would be a second writer next to that one.
        match herdr.writer_elsewhere(pane_id, &ids, &in_pane).await {
            Err(error) => {
                return Ok(refuse(format!(
                    "Could not check for other writers on the session: {error}"
                )));
            }
            Ok(Some(elsewhere)) => {
                return Ok(refuse(format!("{}; close it there first", elsewhere.text)));
            }
            Ok(None) => {}
        }
        let mut handing = lease.clone();
        handing.insert("phase".into(), Value::from("to_terminal"));
        self.set_lease(handing)?;
        if let Some(headless) = headless {
            headless.stop().await;
        }
        self.guard()?;
        // Whatever stop() says, the host is asked: a process from before a
        // restart, or one an SSH client left behind, has no handle here.
        let stopped = self
            .until(
                || Box::pin(async { Ok(!herdr.headless_running(&ids).await?) }),
                self.times().exit_timeout_ms,
                None,
                None,
            )
            .await?;
        if !stopped {
            let mut back = lease.clone();
            back.insert("phase".into(), Value::from("conversation"));
            self.set_lease(back)?;
            return Ok(refuse(
                "The conversation process did not stop; the session stays in conversation mode",
            ));
        }
        self.guard()?;
        let _ = herdr
            .release_agent(pane_id, Some(terminal.herdr_agent()))
            .await;
        let holder = self.deps().holders.connected(pane_id, None, None);
        self.delete_lease(pane_id)?;
        if let Some(title) = &options.suspend
            && holder
        {
            self.deps()
                .holders
                .send(pane_id, &suspend_reply(&lease, title.as_deref()));
            let mut result = accepted("terminal", &session_id);
            result.insert("suspended".into(), Value::Bool(true));
            return Ok(result);
        }
        // A holder gone meanwhile resumes the agent when it polls again.
        let profile = self
            .deps()
            .resume_profile
            .as_ref()
            .and_then(|profile| profile(&session_id));
        self.deps().holders.send(
            pane_id,
            &resume_reply(&lease, profile.as_ref(), &self.deps().drivers),
        );
        if !holder {
            let mut result = accepted("terminal", &session_id);
            result.insert("confirmed".into(), Value::Bool(false));
            result.insert(
                "detail".into(),
                Value::from(format!(
                    "No holder runs in the pane; run {} there",
                    terminal.resume_argv(&session_id, &[]).join(" ")
                )),
            );
            return Ok(result);
        }
        let mut result = accepted("terminal", &session_id);
        if options.confirm != Some(false) {
            let confirmed = self.confirm_mapping(pane_id, &session_id).await;
            result.insert("confirmed".into(), Value::Bool(confirmed));
            if !confirmed {
                result.insert(
                    "detail".into(),
                    Value::from("Herdr has not mapped the pane to the session yet"),
                );
            }
        }
        Ok(result)
    }

    /// A holder stopped as a shell job was brought back with `fg`: it
    /// holds the pane again, and conversation mode takes the session once
    /// nothing else writes it.
    pub async fn from_suspended(&self, pane_id: &str, spec: SuspendedSpec) -> Result<Obj, String> {
        self.exclusive(pane_id, self.fg(pane_id, &spec)).await
    }

    async fn fg(&self, pane_id: &str, spec: &SuspendedSpec) -> Step<Obj> {
        let herdr = self.deps().herdr.clone();
        if let Some(current) = self.deps().leases.get(pane_id) {
            return Ok(
                if lease_str(&current, "phase") == Some("conversation")
                    && lease_str(&current, "session_id") == Some(spec.session_id.as_str())
                {
                    accepted("conversation", &spec.session_id)
                } else {
                    refuse("Conversation mode holds another session in this pane")
                },
            );
        }
        if self
            .live_owner_elsewhere(pane_id, &spec.session_id)
            .await?
            .is_some()
        {
            return Ok(refuse(
                "Conversation mode already owns this session in another pane",
            ));
        }
        let ids = vec![spec.session_id.clone()];
        match herdr.writer_elsewhere(pane_id, &ids, &[]).await {
            Err(error) => {
                return Ok(refuse(format!(
                    "Could not check for other writers on the session: {error}"
                )));
            }
            Ok(Some(elsewhere)) => {
                return Ok(refuse(format!("{}; close it there first", elsewhere.text)));
            }
            Ok(None) => {}
        }
        if herdr.headless_running(&ids).await.unwrap_or(true) {
            return Ok(refuse("A conversation process still runs on the session"));
        }
        let mut lease = obj! {
            "pane_id" => pane_id,
            "session_id" => spec.session_id.clone(),
            "cwd" => spec.cwd.clone(),
            "phase" => "conversation",
        };
        add_lease_fields(
            &mut lease,
            &spec.agent.clone().filter(|agent| !agent.is_empty()),
            &spec.terminal_args,
        );
        let lease = self.set_lease(lease)?;
        let mut result = accepted("conversation", &spec.session_id);
        result.insert("lease".into(), Value::Object(lease));
        Ok(result)
    }

    /// The pane's idle TUI exits and the same session resumes there with
    /// its profile now (a switch of profile). Refused as a handover would
    /// be.
    pub async fn restart_terminal(
        &self,
        pane_id: &str,
        expected_session_id: Option<&str>,
    ) -> Result<Obj, String> {
        self.exclusive(pane_id, async {
            if self.deps().leases.get(pane_id).is_some() {
                return Ok(refuse("Conversation mode holds this session"));
            }
            let exited = self
                .exit_agent(
                    pane_id,
                    expected_session_id,
                    ExitMarks::default(),
                    None,
                    false,
                )
                .await?;
            let exited = match exited {
                Exit::Refused(refusal) => return Ok(refusal),
                Exit::Done(exited) => exited,
            };
            self.guard()?;
            let text = self.resume_text(
                pane_id,
                &exited.session_id,
                &exited.terminal_args,
                &*exited.terminal,
            );
            if let Err(error) = self.deps().herdr.send_text(pane_id, &text).await {
                return Ok(refuse(format!(
                    "{} exited but did not start again: {error}; run {} there",
                    exited.terminal.display_name(),
                    exited
                        .terminal
                        .resume_argv(&exited.session_id, &[])
                        .join(" ")
                )));
            }
            Ok(accepted("terminal", &exited.session_id))
        })
        .await
    }

    /// Waits a while for a holder in the pane.
    pub async fn wait_for_holder(&self, pane_id: &str) -> bool {
        self.until(
            || Box::pin(async move { Ok(self.deps().holders.connected(pane_id, None, None)) }),
            self.times().holder_timeout_ms,
            None,
            None,
        )
        .await
        .unwrap_or(false)
    }

    /// Whether a handover of the pane runs.
    pub fn running(&self, pane_id: &str) -> bool {
        self.inner.running.lock().unwrap().contains(pane_id)
    }

    /// The user cancelled the switch: a pane asked to exit that has not is
    /// no longer waited for. True when one was.
    pub fn cancel_exit(&self, pane_id: &str) -> bool {
        self.end_exit_watch(pane_id)
    }
}

/// Whether a handover result says ok (re-exported for the service).
pub fn result_ok(result: &Obj) -> bool {
    is_ok(result)
}

/// The lease's terminal args (re-exported for the service).
pub fn terminal_args_of(lease: &Lease) -> Vec<String> {
    lease_terminal_args(lease)
}

#[cfg(test)]
mod tests;
