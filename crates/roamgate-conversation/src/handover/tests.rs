//! handover.test.ts.

use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use roamgate_agents::obj;
use roamgate_base::clock::{Clock, Interval};
use serde_json::{Value, json};
use tokio::task::JoinHandle;

use super::*;
use crate::herdr::{AgentReport, HerdrResult};
use crate::holder::{HolderReply, hold_reply};
use crate::lease::LeaseOptions;
use crate::shared::reason;
use crate::testing::{
    FakeHerdr, FakeHerdrOptions, background_screen, exit_dialog_screen, idle_screen,
    narrow_idle_screen, narrow_screen, narrowest_screen, settle, test_drivers, writer_text,
};
use crate::time::{BoxFuture as ClockFuture, VirtualClock};

const PANE: &str = "w1:p1";

type SleepHook = Arc<dyn Fn(u64) -> Option<ClockFuture<()>> + Send + Sync>;

/// The virtual clock, a test's hook first on each sleep (its own future,
/// or None for the clock's).
#[derive(Clone)]
struct HookClock {
    base: VirtualClock,
    hook: Option<SleepHook>,
    /// Timers on tokio's time (the holders' long polls are Bun's real
    /// timers in the TS tests), the time read from the virtual clock.
    real_sleep: bool,
}

impl Clock for HookClock {
    fn now(&self) -> i64 {
        self.base.now()
    }
    fn monotonic(&self) -> f64 {
        self.base.monotonic()
    }
    fn sleep_until(&self, deadline: i64) -> ClockFuture<()> {
        self.sleep(Duration::from_millis((deadline - self.now()).max(0) as u64))
    }
    fn sleep(&self, duration: Duration) -> ClockFuture<()> {
        let ms = duration.as_millis() as u64;
        if self.real_sleep {
            return Box::pin(tokio::time::sleep(duration));
        }
        if let Some(hook) = &self.hook
            && let Some(future) = hook(ms)
        {
            return future;
        }
        self.base.sleep(duration)
    }
    fn interval(&self, period: Duration) -> Interval {
        self.base.interval(period)
    }
}

type Hook<T> = Option<Arc<dyn Fn(&str) -> HerdrResult<T> + Send + Sync>>;
type Hook2 = Option<Arc<dyn Fn(&str, &str) -> HerdrResult<()> + Send + Sync>>;

/// Herdr's calls a test changes; the rest are the fake's.
#[derive(Default, Clone)]
struct Hooks {
    agent_get: Hook<Option<Obj>>,
    prompt: Hook2,
    send_text: Hook2,
    send_keys: Hook2,
    pid_alive: Option<Arc<dyn Fn(u32) -> bool + Send + Sync>>,
    pane_exists: Hook<bool>,
}

struct Hooked {
    base: Arc<FakeHerdr>,
    hooks: Hooks,
}

fn now<T: Send + 'static>(answer: T) -> BoxFuture<'static, T> {
    Box::pin(async move { answer })
}

impl ConversationHerdr for Hooked {
    fn agent_get<'a>(&'a self, pane_id: &'a str) -> BoxFuture<'a, HerdrResult<Option<Obj>>> {
        match &self.hooks.agent_get {
            Some(hook) => now(hook(pane_id)),
            None => self.base.agent_get(pane_id),
        }
    }
    fn read_detection<'a>(&'a self, pane_id: &'a str) -> BoxFuture<'a, HerdrResult<String>> {
        self.base.read_detection(pane_id)
    }
    fn process_info<'a>(&'a self, pane_id: &'a str) -> BoxFuture<'a, HerdrResult<PaneProcessInfo>> {
        self.base.process_info(pane_id)
    }
    fn prompt<'a>(&'a self, pane_id: &'a str, text: &'a str) -> BoxFuture<'a, HerdrResult<()>> {
        match &self.hooks.prompt {
            Some(hook) => now(hook(pane_id, text)),
            None => self.base.prompt(pane_id, text),
        }
    }
    fn send_text<'a>(&'a self, pane_id: &'a str, text: &'a str) -> BoxFuture<'a, HerdrResult<()>> {
        match &self.hooks.send_text {
            Some(hook) => now(hook(pane_id, text)),
            None => self.base.send_text(pane_id, text),
        }
    }
    fn send_keys<'a>(&'a self, pane_id: &'a str, keys: &'a str) -> BoxFuture<'a, HerdrResult<()>> {
        match &self.hooks.send_keys {
            Some(hook) => now(hook(pane_id, keys)),
            None => self.base.send_keys(pane_id, keys),
        }
    }
    fn report_agent(&self, report: AgentReport) -> BoxFuture<'_, HerdrResult<()>> {
        self.base.report_agent(report)
    }
    fn release_agent<'a>(
        &'a self,
        pane_id: &'a str,
        agent: Option<&'a str>,
    ) -> BoxFuture<'a, HerdrResult<()>> {
        self.base.release_agent(pane_id, agent)
    }
    fn pid_alive(&self, pid: u32) -> BoxFuture<'_, bool> {
        match &self.hooks.pid_alive {
            Some(hook) => now(hook(pid)),
            None => self.base.pid_alive(pid),
        }
    }
    fn headless_running<'a>(
        &'a self,
        session_ids: &'a [String],
    ) -> BoxFuture<'a, HerdrResult<bool>> {
        self.base.headless_running(session_ids)
    }
    fn pane_exists<'a>(&'a self, pane_id: &'a str) -> BoxFuture<'a, HerdrResult<bool>> {
        match &self.hooks.pane_exists {
            Some(hook) => now(hook(pane_id)),
            None => self.base.pane_exists(pane_id),
        }
    }
    fn writer_elsewhere<'a>(
        &'a self,
        pane_id: &'a str,
        session_ids: &'a [String],
        except_pids: &'a [u32],
    ) -> BoxFuture<'a, HerdrResult<Option<WriterElsewhere>>> {
        self.base
            .writer_elsewhere(pane_id, session_ids, except_pids)
    }
}

type ChangeDeps = Box<dyn FnOnce(&mut HandoverDeps)>;

#[derive(Default)]
struct Options {
    fake: FakeHerdrOptions,
    holder_does_not_start: bool,
    hooks: Hooks,
    sleep: Option<SleepHook>,
    herdr: Option<Arc<dyn ConversationHerdr>>,
    deps: Option<ChangeDeps>,
}

/// The holders' polls a test runs, with what they were told.
#[derive(Clone, Default)]
struct Polls {
    replies: Arc<Mutex<Vec<HolderReply>>>,
    tasks: Arc<Mutex<Vec<JoinHandle<()>>>>,
}

impl Polls {
    fn start(&self, holders: &HolderRegistry) {
        let wait = holders.wait(PANE, hold_reply(""), 1_000_000_000, None);
        let replies = self.replies.clone();
        self.tasks.lock().unwrap().push(tokio::spawn(async move {
            let reply = wait.await;
            replies.lock().unwrap().push(reply);
        }));
    }

    fn abort(&self) {
        for task in self.tasks.lock().unwrap().drain(..) {
            task.abort();
        }
    }

    fn replies(&self) -> Vec<Value> {
        self.replies
            .lock()
            .unwrap()
            .iter()
            .cloned()
            .map(Value::Object)
            .collect()
    }
}

struct Context {
    fake: Arc<FakeHerdr>,
    leases: LeaseStore,
    holders: HolderRegistry,
    handover: Handover,
    polls: Polls,
    phases: Arc<Mutex<Vec<String>>>,
    clock: VirtualClock,
}

impl Drop for Context {
    fn drop(&mut self) {
        self.polls.abort();
    }
}

fn setup(options: Options) -> Context {
    let clock = VirtualClock::new();
    let shared: SharedClock = Arc::new(HookClock {
        base: clock.clone(),
        hook: options.sleep,
        real_sleep: false,
    });
    let holders = HolderRegistry::new(Arc::new(HookClock {
        base: clock.clone(),
        hook: None,
        real_sleep: true,
    }));
    let polls = Polls::default();
    let mut fake_options = options.fake;
    if !options.holder_does_not_start {
        let (polls, holders) = (polls.clone(), holders.clone());
        fake_options.on_holder = Some(Arc::new(move |_| polls.start(&holders)));
    }
    let fake = FakeHerdr::new(fake_options);
    let herdr: Arc<dyn ConversationHerdr> = options.herdr.unwrap_or_else(|| {
        Arc::new(Hooked {
            base: fake.clone(),
            hooks: options.hooks,
        })
    });
    let leases = LeaseStore::new(LeaseOptions {
        connection_id: "local".into(),
        file: None,
        clock: shared.clone(),
        data: None,
    });
    let phases = Arc::new(Mutex::new(Vec::new()));
    let mut deps = HandoverDeps::new(
        herdr,
        leases.clone(),
        holders.clone(),
        test_drivers(),
        shared,
        Arc::new(|id| format!("hold {id}\r")),
    );
    let (seen, store) = (phases.clone(), leases.clone());
    deps.on_lease = Some(Arc::new(move |pane| {
        seen.lock().unwrap().push(
            store
                .get(pane)
                .and_then(|lease| lease_str(&lease, "phase").map(str::to_owned))
                .unwrap_or_else(|| "terminal".into()),
        )
    }));
    if let Some(change) = options.deps {
        change(&mut deps);
    }
    Context {
        fake,
        leases,
        holders,
        handover: Handover::new(deps),
        polls,
        phases,
        clock,
    }
}

fn plain() -> Context {
    setup(Options::default())
}

fn lease(pane: &str, session: &str, cwd: &str, phase: &str) -> Lease {
    obj! {"pane_id" => pane, "session_id" => session, "cwd" => cwd, "phase" => phase}
}

fn why(result: &Obj) -> String {
    if is_ok(result) {
        String::new()
    } else {
        reason(result).to_owned()
    }
}

fn phase(context: &Context, pane: &str) -> Option<String> {
    context
        .leases
        .get(pane)
        .and_then(|lease| lease_str(&lease, "phase").map(str::to_owned))
}

fn calls(fake: &FakeHerdr, name: &str) -> Vec<Vec<String>> {
    fake.calls_of(&[name])
}

fn exits(fake: &FakeHerdr) -> usize {
    fake.calls_of(&["prompt"])
        .iter()
        .filter(|call| call[2] == "/exit")
        .count()
}

fn call(parts: [&str; 3]) -> Vec<String> {
    parts.map(String::from).to_vec()
}

async fn settle_long() {
    for _ in 0..20 {
        settle().await;
    }
}

type Flag = Arc<dyn Fn() -> bool + Send + Sync>;

struct Side {
    busy: Flag,
    background: usize,
    queue: usize,
    interrupts: Arc<AtomicUsize>,
    on_interrupt: Option<Arc<dyn Fn() + Send + Sync>>,
    stop: Option<Flag>,
    events: Arc<Mutex<Vec<String>>>,
}

impl Default for Side {
    fn default() -> Self {
        Self {
            busy: Arc::new(|| false),
            background: 0,
            queue: 0,
            interrupts: Arc::default(),
            on_interrupt: None,
            stop: None,
            events: Arc::default(),
        }
    }
}

impl HeadlessSide for Side {
    fn busy(&self) -> bool {
        (self.busy)()
    }
    fn background_tasks(&self) -> usize {
        self.background
    }
    fn queue_length(&self) -> usize {
        self.queue
    }
    fn interrupt(&self) -> BoxFuture<'_, bool> {
        self.interrupts.fetch_add(1, Ordering::SeqCst);
        if let Some(on_interrupt) = &self.on_interrupt {
            on_interrupt();
        }
        now(true)
    }
    fn wait_for_result(&self, _timeout_ms: u64) -> BoxFuture<'_, bool> {
        now(true)
    }
    fn stop(&self) -> BoxFuture<'_, bool> {
        let stopped = match &self.stop {
            Some(stop) => stop(),
            None => {
                self.events.lock().unwrap().push("stopped".into());
                true
            }
        };
        now(stopped)
    }
    fn pid(&self) -> Option<u32> {
        None
    }
}

fn agent_with(fake: &FakeHerdr, change: impl FnOnce(&mut Obj)) {
    fake.with(|state| {
        let mut agent = state.pane.agent.clone().unwrap();
        change(&mut agent);
        state.pane.agent = Some(agent);
    });
}

fn set_agent(fake: &FakeHerdr, key: &str, value: Value) {
    agent_with(fake, |agent| {
        agent.insert(key.into(), value);
    });
}

type Slot = Arc<Mutex<Option<Arc<FakeHerdr>>>>;

fn slot_fake(slot: &Slot) -> Arc<FakeHerdr> {
    slot.lock().unwrap().clone().unwrap()
}

// ------------------------------------------------- terminal to conversation

#[tokio::test]
async fn stops_the_idle_tui_then_holds_the_pane() {
    let context = plain();
    let result = context
        .handover
        .to_conversation(PANE, None, None)
        .await
        .unwrap();
    assert!(is_ok(&result));
    assert_eq!(result["owner"], "conversation");
    assert_eq!(result["session_id"], context.fake.session_id.as_str());
    let lease = context.leases.get(PANE).unwrap();
    assert_eq!(lease["phase"], "conversation");
    assert_eq!(lease["owner"], "conversation");
    assert_eq!(lease["session_id"], context.fake.session_id.as_str());
    assert_eq!(lease["cwd"], context.fake.cwd.as_str());
    let actions: Vec<String> = context
        .fake
        .calls_of(&["prompt", "sendText"])
        .into_iter()
        .map(|call| call[2].clone())
        .collect();
    assert_eq!(
        actions,
        [
            "/exit".to_owned(),
            format!("hold {}\r", context.fake.session_id)
        ]
    );
    // The holder starts only once the TUI's pid is gone.
    assert!(
        !context
            .fake
            .with(|state| state.live.contains(&context.fake.claude_pid))
    );
}

#[tokio::test]
async fn an_owned_session_is_already_handed_over() {
    let context = plain();
    context
        .handover
        .to_conversation(PANE, None, None)
        .await
        .unwrap();
    assert!(is_ok(
        &context
            .handover
            .to_conversation(PANE, None, None)
            .await
            .unwrap()
    ));
}

#[tokio::test]
async fn refuses_on_name_touching_nothing() {
    type Arrange = Box<dyn Fn(&FakeHerdr)>;
    let screen = |from: &'static str, to: &'static str| -> Arrange {
        Box::new(move |fake: &FakeHerdr| {
            fake.with(|state| state.pane.screen = state.pane.screen.replacen(from, to, 1))
        })
    };
    let refusals: Vec<(&str, Arrange, &str)> = vec![
        (
            "no agent",
            Box::new(|fake| fake.with(|state| state.pane.agent = None)),
            "not running",
        ),
        (
            "another agent",
            Box::new(|fake| set_agent(fake, "agent", json!("codex"))),
            "not running",
        ),
        (
            "a running turn",
            Box::new(|fake| set_agent(fake, "agent_status", json!("working"))),
            "working",
        ),
        (
            "a question in the terminal",
            Box::new(|fake| set_agent(fake, "agent_status", json!("blocked"))),
            "waiting for an answer",
        ),
        (
            "an unknown state",
            Box::new(|fake| set_agent(fake, "agent_status", json!("unknown"))),
            "cannot tell",
        ),
        (
            "no session id",
            Box::new(|fake| set_agent(fake, "agent_session", Value::Null)),
            "no session id",
        ),
        (
            "a draft in the prompt box",
            screen("❯ ", "❯ half typed"),
            "typed in Claude's prompt box",
        ),
        (
            "a multi-line draft",
            screen("❯ ", "❯ \n  second line"),
            "typed in Claude's prompt box",
        ),
        (
            "no prompt box",
            Box::new(|fake| {
                fake.with(|state| state.pane.screen = "Do you want to proceed?\n 1. Yes".into())
            }),
            "prompt box is not on screen",
        ),
        (
            "vim normal mode",
            screen("-- INSERT --", "-- NORMAL --"),
            "vim normal mode",
        ),
        (
            "no claude process",
            Box::new(|fake| fake.with(|state| state.pane.process.foreground_processes.clear())),
            "which process is Claude",
        ),
        (
            "two claude processes",
            Box::new(|fake| {
                fake.with(|state| {
                    state.pane.process.foreground_processes.push(PaneProcess {
                        pid: 950,
                        argv: Some(vec!["claude".into()]),
                        ..PaneProcess::default()
                    })
                })
            }),
            "which process is Claude",
        ),
        (
            "no working directory",
            Box::new(|fake| {
                fake.with(|state| state.pane.process.foreground_processes[0].cwd = None);
                set_agent(fake, "foreground_cwd", json!(""));
            }),
            "working directory",
        ),
    ];
    for (name, arrange, expected) in refusals {
        let context = plain();
        arrange(&context.fake);
        let result = context
            .handover
            .to_conversation(PANE, None, None)
            .await
            .unwrap();
        assert!(!is_ok(&result), "{name}");
        assert!(why(&result).contains(expected), "{name}: {}", why(&result));
        assert!(context.leases.get(PANE).is_none(), "{name}");
        assert!(
            context.fake.calls_of(&["prompt", "sendText"]).is_empty(),
            "{name}"
        );
    }
}

#[tokio::test]
async fn refuses_another_session_than_the_one_expected() {
    let context = plain();
    let result = context
        .handover
        .to_conversation(PANE, Some("other-session"), None)
        .await
        .unwrap();
    assert_eq!(
        Value::Object(result),
        json!({"ok": false, "reason": "The pane now runs another session"})
    );
}

#[tokio::test]
async fn refuses_a_session_conversation_mode_owns_in_another_pane() {
    let context = plain();
    context.leases.set(lease(
        "w2:p9",
        &context.fake.session_id,
        &context.fake.cwd,
        "conversation",
    ));
    let result = context
        .handover
        .to_conversation(PANE, None, None)
        .await
        .unwrap();
    assert!(why(&result).contains("another pane"));
}

#[tokio::test]
async fn refuses_while_a_handover_of_the_pane_runs() {
    let context = plain();
    context.leases.set(lease(
        PANE,
        &context.fake.session_id,
        &context.fake.cwd,
        "to_terminal",
    ));
    let result = context
        .handover
        .to_conversation(PANE, None, None)
        .await
        .unwrap();
    assert!(why(&result).contains("being handed over"));
}

#[tokio::test]
async fn refuses_a_second_handover_started_meanwhile() {
    let context = plain();
    let (first, second) = tokio::join!(
        context.handover.to_conversation(PANE, None, None),
        context.handover.to_conversation(PANE, None, None)
    );
    assert!(is_ok(&first.unwrap()));
    assert_eq!(
        Value::Object(second.unwrap()),
        json!({"ok": false, "reason": "A handover of this pane is already running"})
    );
}

#[tokio::test]
async fn refuses_when_herdr_cannot_be_asked() {
    let context = setup(Options {
        hooks: Hooks {
            agent_get: Some(Arc::new(|_| Err("socket closed".into()))),
            ..Hooks::default()
        },
        ..Options::default()
    });
    let result = context
        .handover
        .to_conversation(PANE, None, None)
        .await
        .unwrap();
    assert!(why(&result).contains("socket closed"));
    assert!(context.leases.get(PANE).is_none());
}

#[tokio::test]
async fn a_refused_exit_leaves_the_terminal_the_owner() {
    let context = setup(Options {
        hooks: Hooks {
            prompt: Some(Arc::new(|_, _| Err("agent_blocked".into()))),
            ..Hooks::default()
        },
        ..Options::default()
    });
    let result = context
        .handover
        .to_conversation(PANE, None, None)
        .await
        .unwrap();
    assert!(why(&result).contains("did not take /exit"));
    assert!(context.leases.get(PANE).is_none());
}

fn exit_ignored() -> FakeHerdrOptions {
    FakeHerdrOptions {
        exit_ignored: true,
        ..FakeHerdrOptions::default()
    }
}

#[tokio::test]
async fn never_holds_the_pane_while_the_tui_may_still_run() {
    let context = setup(Options {
        fake: exit_ignored(),
        ..Options::default()
    });
    let result = context
        .handover
        .to_conversation(PANE, None, None)
        .await
        .unwrap();
    assert!(why(&result).contains("did not exit in time"));
    assert!(context.leases.get(PANE).is_none());
    assert!(calls(&context.fake, "sendText").is_empty());
}

#[tokio::test]
async fn a_pid_gone_while_another_claude_is_in_the_foreground_is_not_enough() {
    let slot: Slot = Arc::default();
    let fake = slot.clone();
    let context = setup(Options {
        hooks: Hooks {
            // The pid ends but the shell is not back in the foreground.
            prompt: Some(Arc::new(move |_, _| {
                let fake = slot_fake(&fake);
                fake.with(|state| state.live.remove(&fake.claude_pid));
                Ok(())
            })),
            ..Hooks::default()
        },
        ..Options::default()
    });
    *slot.lock().unwrap() = Some(context.fake.clone());
    let result = context
        .handover
        .to_conversation(PANE, None, None)
        .await
        .unwrap();
    assert!(!is_ok(&result));
    assert!(context.leases.get(PANE).is_none());
}

#[tokio::test]
async fn a_holder_that_cannot_be_typed_gives_the_session_back() {
    let context = setup(Options {
        hooks: Hooks {
            send_text: Some(Arc::new(|_, _| Err("pane closed".into()))),
            ..Hooks::default()
        },
        ..Options::default()
    });
    let result = context
        .handover
        .to_conversation(PANE, None, None)
        .await
        .unwrap();
    assert!(why(&result).contains("holder did not start"));
    assert!(context.leases.get(PANE).is_none());
}

#[tokio::test]
async fn a_holder_that_never_shows_up_gives_the_session_back() {
    let context = setup(Options {
        holder_does_not_start: true,
        ..Options::default()
    });
    let result = context
        .handover
        .to_conversation(PANE, None, None)
        .await
        .unwrap();
    assert!(why(&result).contains("Claude was resumed in the terminal"));
    assert!(context.leases.get(PANE).is_none());
    // The shell it left gets claude back, with the session.
    assert_eq!(
        calls(&context.fake, "sendText").last().cloned().unwrap(),
        [
            "sendText".to_owned(),
            PANE.to_owned(),
            format!(
                " env ROAMGATE_CLAUDE_START=terminal claude --resume {}\r",
                context.fake.session_id
            )
        ]
    );
}

#[tokio::test]
async fn a_holder_still_starting_is_not_typed_over() {
    let slot: Slot = Arc::default();
    let fake = slot.clone();
    let context = setup(Options {
        holder_does_not_start: true,
        hooks: Hooks {
            send_text: Some(Arc::new(move |pane, text| {
                slot_fake(&fake).with(|state| {
                    state
                        .calls
                        .push(vec!["sendText".into(), pane.into(), text.into()]);
                    // python is in the foreground, slow to start.
                    state.pane.process = PaneProcessInfo {
                        shell_pid: Some(800.0),
                        foreground_process_group_id: Some(950.0),
                        foreground_processes: vec![PaneProcess {
                            pid: 950,
                            argv: Some(vec!["python3".into(), "hold".into()]),
                            ..PaneProcess::default()
                        }],
                    }
                });
                Ok(())
            })),
            ..Hooks::default()
        },
        ..Options::default()
    });
    *slot.lock().unwrap() = Some(context.fake.clone());
    let result = context
        .handover
        .to_conversation(PANE, None, None)
        .await
        .unwrap();
    assert!(why(&result).contains("run claude --resume"));
    assert_eq!(calls(&context.fake, "sendText").len(), 1);
}

#[tokio::test]
async fn only_a_holder_that_polls_after_the_command_counts() {
    let context = setup(Options {
        holder_does_not_start: true,
        ..Options::default()
    });
    // The holder an earlier hand-back told to resume polled moments ago.
    context.polls.start(&context.holders);
    context.holders.send(PANE, &hold_reply(""));
    context.clock.sleep(Duration::from_millis(1000)).await;
    let result = context
        .handover
        .to_conversation(PANE, None, None)
        .await
        .unwrap();
    assert!(!is_ok(&result));
    assert!(context.leases.get(PANE).is_none());
}

fn shell_back(fake: &FakeHerdr, shell: f64) {
    fake.with(|state| {
        state.live.remove(&fake.claude_pid);
        state.pane.process = PaneProcessInfo {
            shell_pid: Some(shell),
            foreground_process_group_id: Some(shell),
            foreground_processes: Vec::new(),
        };
    });
}

#[tokio::test]
async fn a_tui_that_exits_after_the_deadline_gets_claude_back_in_its_shell() {
    let context = setup(Options {
        fake: exit_ignored(),
        ..Options::default()
    });
    let session = context.fake.session_id.clone();
    context.fake.with(|state| {
        state.pane.process.foreground_processes[0].argv = Some(
            ["claude", "--model", "haiku", "--resume", &session]
                .map(String::from)
                .to_vec(),
        )
    });
    let result = context
        .handover
        .to_conversation(PANE, None, None)
        .await
        .unwrap();
    assert!(why(&result).contains("did not exit in time"));
    assert!(context.leases.get(PANE).is_none());
    // It exits a little later.
    shell_back(&context.fake, 800.0);
    settle_long().await;
    assert_eq!(
        calls(&context.fake, "sendText").last().cloned().unwrap(),
        [
            "sendText".to_owned(),
            PANE.to_owned(),
            format!(
                " env ROAMGATE_CLAUDE_START=terminal claude --model haiku --resume {session}\r"
            )
        ]
    );
}

#[tokio::test]
async fn refuses_while_claude_runs_the_session_elsewhere() {
    let context = plain();
    context.fake.with(|state| {
        state.probe.elsewhere = Some(writer_text("Claude runs this session in pane w2:p1"))
    });
    let result = context
        .handover
        .to_conversation(PANE, None, None)
        .await
        .unwrap();
    assert!(why(&result).contains("pane w2:p1; close it"));
    assert!(context.leases.get(PANE).is_none());
    assert!(calls(&context.fake, "prompt").is_empty());
}

#[tokio::test]
async fn a_lease_whose_pane_was_closed_does_not_block_the_session() {
    let gone = Arc::new(Mutex::new(String::new()));
    let noted = gone.clone();
    let context = setup(Options {
        holder_does_not_start: true,
        hooks: Hooks {
            pane_exists: Some(Arc::new(|pane| Ok(pane != "w9:p9"))),
            ..Hooks::default()
        },
        deps: Some(Box::new(move |deps| {
            let leases = deps.leases.clone();
            deps.on_pane_gone = Some(Arc::new(move |pane| {
                *noted.lock().unwrap() = pane.to_owned();
                leases.delete(pane);
            }));
            deps.times.holder_timeout_ms = 0;
        })),
        ..Options::default()
    });
    context.leases.set(lease(
        "w9:p9",
        &context.fake.session_id,
        "/work/repo",
        "conversation",
    ));
    let result = context
        .handover
        .to_conversation(PANE, None, None)
        .await
        .unwrap();
    assert_eq!(*gone.lock().unwrap(), "w9:p9");
    // It went on (the holder never showed up here).
    assert!(why(&result).contains("holder did not start"));
    // With the pane still there, it refuses.
    let other = plain();
    other.leases.set(lease(
        "w9:p9",
        &other.fake.session_id,
        "/work/repo",
        "conversation",
    ));
    let refused = other
        .handover
        .to_conversation(PANE, None, None)
        .await
        .unwrap();
    assert!(why(&refused).contains("another pane"));
}

#[tokio::test]
async fn handing_back_a_pane_where_claude_already_runs_only_drops_the_lease() {
    let context = plain();
    context.leases.set(lease(
        PANE,
        &context.fake.session_id,
        &context.fake.cwd,
        "conversation",
    ));
    // Claude was resumed by the holder while Roamgate was away.
    let result = context
        .handover
        .to_terminal(PANE, None, ToTerminal::default())
        .await
        .unwrap();
    assert_eq!(
        Value::Object(result),
        json!({"ok": true, "owner": "terminal", "session_id": context.fake.session_id})
    );
    assert!(context.leases.get(PANE).is_none());
    assert!(context.polls.replies().is_empty());
}

fn holder_in_front(fake: &FakeHerdr) {
    fake.with(|state| {
        state.pane.process = PaneProcessInfo {
            shell_pid: Some(800.0),
            foreground_process_group_id: Some(950.0),
            foreground_processes: vec![PaneProcess {
                pid: 950,
                argv: Some(vec!["python3".into(), "roamgate-hold".into()]),
                ..PaneProcess::default()
            }],
        }
    });
}

#[tokio::test]
async fn never_hands_back_next_to_claude_running_the_session_elsewhere() {
    let context = plain();
    context.leases.set(lease(
        PANE,
        &context.fake.session_id,
        &context.fake.cwd,
        "conversation",
    ));
    holder_in_front(&context.fake);
    context.fake.with(|state| {
        state.probe.elsewhere = Some(writer_text("Claude runs this session in pane w2:p1"))
    });
    let result = context
        .handover
        .to_terminal(PANE, None, ToTerminal::default())
        .await
        .unwrap();
    assert!(why(&result).contains("pane w2:p1; close it"));
    assert_eq!(phase(&context, PANE).as_deref(), Some("conversation"));
}

#[tokio::test]
async fn a_closed_connection_stops_a_takeover_where_it_is() {
    let closed = Arc::new(AtomicBool::new(false));
    let (closing, asked) = (closed.clone(), closed.clone());
    let context = setup(Options {
        fake: exit_ignored(),
        sleep: Some(Arc::new(move |_| {
            closing.store(true, Ordering::SeqCst);
            None
        })),
        deps: Some(Box::new(move |deps| {
            deps.closed = Some(Arc::new(move || asked.load(Ordering::SeqCst)));
            // The first sleep is the exit's wait, not the settle before it.
            deps.times.settle_ms = 0;
        })),
        ..Options::default()
    });
    let result = context
        .handover
        .to_conversation(PANE, None, None)
        .await
        .unwrap();
    assert_eq!(
        Value::Object(result),
        json!({"ok": false, "reason": "The connection is closing"})
    );
    // Left for the runtime after this one (its start fixes it up).
    assert_eq!(phase(&context, PANE).as_deref(), Some("to_conversation"));
}

#[tokio::test]
async fn conversation_mode_owns_nothing_until_the_holder_has_the_pane() {
    let seen = Arc::new(Mutex::new(Vec::new()));
    let store: Arc<Mutex<Option<LeaseStore>>> = Arc::default();
    let (noted, leases) = (seen.clone(), store.clone());
    let context = setup(Options {
        holder_does_not_start: true,
        hooks: Hooks {
            send_text: Some(Arc::new(move |_, _| {
                let lease = leases.lock().unwrap().as_ref().unwrap().get(PANE);
                noted
                    .lock()
                    .unwrap()
                    .push(lease.and_then(|lease| lease_str(&lease, "phase").map(str::to_owned)));
                Ok(())
            })),
            ..Hooks::default()
        },
        ..Options::default()
    });
    *store.lock().unwrap() = Some(context.leases.clone());
    let result = context
        .handover
        .to_conversation(PANE, None, None)
        .await
        .unwrap();
    assert!(!is_ok(&result));
    // Then the shell it left gets claude back (Bun's toEqual skipped the
    // undefined phase of that second typing).
    assert_eq!(
        *seen.lock().unwrap(),
        [Some("to_conversation".to_owned()), None]
    );
    // Each phase reached the browsers as it happened.
    assert_eq!(
        *context.phases.lock().unwrap(),
        ["to_conversation", "terminal"]
    );
}

#[tokio::test]
async fn each_phase_of_a_takeover_is_announced() {
    let context = plain();
    context
        .handover
        .to_conversation(PANE, None, None)
        .await
        .unwrap();
    assert_eq!(
        *context.phases.lock().unwrap(),
        ["to_conversation", "conversation"]
    );
}

// ------------------------------------- terminal to conversation, background

fn waiting(result: &Obj) -> bool {
    !is_ok(result) && result.get("waiting") == Some(&json!("background_tasks"))
}

#[tokio::test]
async fn background_work_on_screen_keeps_the_switch_waiting_with_no_exit() {
    let context = plain();
    context
        .fake
        .with(|state| state.pane.screen = background_screen());
    let result = context
        .handover
        .to_conversation(PANE, None, None)
        .await
        .unwrap();
    assert!(waiting(&result));
    assert!(why(&result).contains("1 shell"));
    assert_eq!(exits(&context.fake), 0);
    assert!(context.leases.get(PANE).is_none());
    assert!(
        context
            .fake
            .with(|state| state.live.contains(&context.fake.claude_pid))
    );
}

#[tokio::test]
async fn a_narrow_pane_s_cut_footer_count_keeps_the_switch_waiting() {
    let context = plain();
    context
        .fake
        .with(|state| state.pane.screen = narrow_screen());
    let result = context
        .handover
        .to_conversation(PANE, None, None)
        .await
        .unwrap();
    assert!(waiting(&result));
    assert_eq!(exits(&context.fake), 0);
}

fn tasks(count: usize, asked: Arc<Mutex<Vec<String>>>) -> TerminalTasks {
    Arc::new(move |pane, _| {
        asked.lock().unwrap().push(pane);
        Box::pin(async move { Ok(count) })
    })
}

#[tokio::test]
async fn too_narrow_for_the_footer_the_transcript_s_running_commands_keep_it_waiting() {
    let asked = Arc::new(Mutex::new(Vec::new()));
    let tasks = tasks(1, asked.clone());
    let context = setup(Options {
        deps: Some(Box::new(move |deps| deps.terminal_tasks = Some(tasks))),
        ..Options::default()
    });
    context
        .fake
        .with(|state| state.pane.screen = narrowest_screen());
    let result = context
        .handover
        .to_conversation(PANE, None, None)
        .await
        .unwrap();
    assert!(waiting(&result));
    assert!(why(&result).contains("1 background command"));
    assert_eq!(*asked.lock().unwrap(), [PANE]);
    assert_eq!(exits(&context.fake), 0);
}

#[tokio::test]
async fn too_narrow_and_nothing_running_in_the_transcript_it_switches() {
    let tasks = tasks(0, Arc::default());
    let context = setup(Options {
        deps: Some(Box::new(move |deps| deps.terminal_tasks = Some(tasks))),
        ..Options::default()
    });
    context
        .fake
        .with(|state| state.pane.screen = narrow_idle_screen());
    let result = context
        .handover
        .to_conversation(PANE, None, None)
        .await
        .unwrap();
    assert!(is_ok(&result));
    assert_eq!(result["owner"], "conversation");
    assert_eq!(exits(&context.fake), 1);
}

#[tokio::test]
async fn a_wide_footer_that_shows_no_work_wins_over_the_transcript() {
    let asked = Arc::new(Mutex::new(Vec::new()));
    let tasks = tasks(2, asked.clone());
    let context = setup(Options {
        deps: Some(Box::new(move |deps| deps.terminal_tasks = Some(tasks))),
        ..Options::default()
    });
    context
        .fake
        .with(|state| state.pane.screen = idle_screen().replace(&"─".repeat(24), &"─".repeat(80)));
    let result = context
        .handover
        .to_conversation(PANE, None, None)
        .await
        .unwrap();
    assert!(is_ok(&result));
    assert!(asked.lock().unwrap().is_empty());
}

#[tokio::test]
async fn an_exit_question_is_answered_stay_once_and_the_switch_waits() {
    let stays = Arc::new(Mutex::new(Vec::new()));
    let noted = stays.clone();
    let context = setup(Options {
        fake: FakeHerdrOptions {
            exit_asks: true,
            ..FakeHerdrOptions::default()
        },
        deps: Some(Box::new(move |deps| {
            deps.on_exit_dialog = Some(Arc::new(move |pane, _| {
                noted.lock().unwrap().push(pane.to_owned())
            }))
        })),
        ..Options::default()
    });
    let result = context
        .handover
        .to_conversation(PANE, None, None)
        .await
        .unwrap();
    assert!(waiting(&result));
    // Stay, never "Exit and stop tasks" nor "Move to background".
    assert_eq!(
        calls(&context.fake, "sendKeys"),
        [call(["sendKeys", PANE, "3"])]
    );
    assert_eq!(
        context.fake.with(|state| state.pane.screen.clone()),
        background_screen()
    );
    assert!(
        context
            .fake
            .with(|state| state.live.contains(&context.fake.claude_pid))
    );
    assert!(context.leases.get(PANE).is_none());
    assert_eq!(*stays.lock().unwrap(), [PANE]);
    // Asked again while the work runs: still no second /exit.
    let again = context
        .handover
        .to_conversation(PANE, None, None)
        .await
        .unwrap();
    assert!(waiting(&again));
    assert_eq!(exits(&context.fake), 1);
}

#[tokio::test]
async fn an_exit_question_without_numbers_is_answered_with_escape() {
    let dialog = regex::Regex::new(r"\d\. ")
        .unwrap()
        .replace_all(&exit_dialog_screen(), "")
        .into_owned();
    let slot: Slot = Arc::default();
    let (on_prompt, on_keys) = (slot.clone(), slot.clone());
    let context = setup(Options {
        hooks: Hooks {
            prompt: Some(Arc::new(move |pane, text| {
                slot_fake(&on_prompt).with(|state| {
                    state
                        .calls
                        .push(vec!["prompt".into(), pane.into(), text.into()]);
                    state.pane.screen = dialog.clone();
                });
                Ok(())
            })),
            send_keys: Some(Arc::new(move |pane, keys| {
                slot_fake(&on_keys).with(|state| {
                    state
                        .calls
                        .push(vec!["sendKeys".into(), pane.into(), keys.into()]);
                    if keys == "\x1b" {
                        state.pane.screen = background_screen();
                    }
                });
                Ok(())
            })),
            ..Hooks::default()
        },
        ..Options::default()
    });
    *slot.lock().unwrap() = Some(context.fake.clone());
    let result = context
        .handover
        .to_conversation(PANE, None, None)
        .await
        .unwrap();
    assert!(waiting(&result));
    assert_eq!(
        calls(&context.fake, "sendKeys"),
        [call(["sendKeys", PANE, "\x1b"])]
    );
}

#[tokio::test]
async fn an_exit_question_already_on_screen_is_not_answered_for_the_user() {
    let context = plain();
    context
        .fake
        .with(|state| state.pane.screen = exit_dialog_screen());
    let result = context
        .handover
        .to_conversation(PANE, None, None)
        .await
        .unwrap();
    assert!(why(&result).contains("asking whether to exit"));
    assert_eq!(exits(&context.fake), 0);
    assert!(calls(&context.fake, "sendKeys").is_empty());
}

/// The late exit watch waits on a sleep that never ends.
fn stuck_watch(deps: Option<ChangeDeps>) -> Context {
    setup(Options {
        fake: exit_ignored(),
        sleep: Some(Arc::new(|ms| {
            (ms == 7777).then(|| Box::pin(std::future::pending()) as ClockFuture<()>)
        })),
        deps: Some(Box::new(move |handover| {
            handover.times.late_poll_ms = 7777;
            if let Some(deps) = deps {
                deps(handover);
            }
        })),
        ..Options::default()
    })
}

#[tokio::test]
async fn exit_goes_once_no_second_one_while_the_first_may_still_land() {
    let context = stuck_watch(None);
    let first = context
        .handover
        .to_conversation(PANE, None, None)
        .await
        .unwrap();
    assert!(why(&first).contains("did not exit in time"));
    let second = context
        .handover
        .to_conversation(PANE, None, None)
        .await
        .unwrap();
    assert!(why(&second).contains("already asked to exit"));
    assert_eq!(exits(&context.fake), 1);
}

#[tokio::test]
async fn a_late_exit_question_is_answered_stay_and_claude_is_not_resumed() {
    let context = setup(Options {
        fake: exit_ignored(),
        ..Options::default()
    });
    let result = context
        .handover
        .to_conversation(PANE, None, None)
        .await
        .unwrap();
    assert!(why(&result).contains("did not exit in time"));
    // The /exit lands later, and Claude asks.
    context
        .fake
        .with(|state| state.pane.screen = exit_dialog_screen());
    settle_long().await;
    assert_eq!(
        calls(&context.fake, "sendKeys"),
        [call(["sendKeys", PANE, "3"])]
    );
    assert!(
        context
            .fake
            .with(|state| state.live.contains(&context.fake.claude_pid))
    );
    assert!(calls(&context.fake, "sendText").is_empty());
}

#[tokio::test]
async fn waiting_for_the_exit_checks_less_and_less_often() {
    let waits = Arc::new(Mutex::new(Vec::<u64>::new()));
    let alive = Arc::new(AtomicUsize::new(0));
    let (noted, counted) = (waits.clone(), alive.clone());
    let context = setup(Options {
        fake: exit_ignored(),
        hooks: Hooks {
            pid_alive: Some(Arc::new(move |_| {
                counted.fetch_add(1, Ordering::SeqCst);
                true
            })),
            ..Hooks::default()
        },
        sleep: Some(Arc::new(move |ms| {
            noted.lock().unwrap().push(ms);
            None
        })),
        deps: Some(Box::new(|deps| deps.times.settle_ms = 0)),
        ..Options::default()
    });
    context
        .handover
        .to_conversation(PANE, None, None)
        .await
        .unwrap();
    let during = waits.lock().unwrap().len();
    for _ in 0..2 {
        settle_long().await;
    }
    let waits = waits.lock().unwrap().clone();
    // The exit deadline: 200 ms first, then longer, never past 2 s.
    assert_eq!(waits[0], 200);
    assert_eq!(waits[1], 300);
    assert!(waits[..during].iter().max().copied().unwrap() <= 2000);
    // The late watch starts at 2 s and stays under 15 s.
    assert_eq!(waits[during], 2000);
    assert!(waits.iter().max().copied().unwrap() <= 15_000);
    assert!(context.clock.now() >= 15_000 + 120_000);
    // A few dozen checks, not one every 200 ms (some 675).
    assert!(alive.load(Ordering::SeqCst) < 40);
}

// ------------------------- an exit typed at the wrong moment

#[tokio::test]
async fn a_paste_reaching_the_prompt_box_before_exit_stops_it() {
    let slot: Slot = Arc::default();
    let fake = slot.clone();
    let context = setup(Options {
        sleep: Some(Arc::new(move |ms| {
            // The image lands while the switch looks again.
            if ms == 333 {
                slot_fake(&fake).with(|state| {
                    state.pane.screen = idle_screen().replacen("❯ ", "❯ [Image #168]", 1)
                });
            }
            None
        })),
        deps: Some(Box::new(|deps| deps.times.settle_ms = 333)),
        ..Options::default()
    });
    *slot.lock().unwrap() = Some(context.fake.clone());
    let result = context
        .handover
        .to_conversation(PANE, None, None)
        .await
        .unwrap();
    assert!(why(&result).contains("Something is typed"));
    assert_eq!(exits(&context.fake), 0);
    assert!(context.leases.get(PANE).is_none());
}

#[tokio::test]
async fn a_turn_starting_before_exit_stops_it() {
    let status = Arc::new(Mutex::new("idle".to_owned()));
    let (working, read) = (status.clone(), status.clone());
    let context = setup(Options {
        sleep: Some(Arc::new(move |_| {
            *working.lock().unwrap() = "working".into();
            None
        })),
        deps: Some(Box::new(move |deps| {
            deps.exact_status = Some(Arc::new(move |_| Some(read.lock().unwrap().clone())))
        })),
        ..Options::default()
    });
    let result = context
        .handover
        .to_conversation(PANE, None, None)
        .await
        .unwrap();
    assert!(why(&result).contains("is working"));
    assert_eq!(exits(&context.fake), 0);
}

#[tokio::test]
async fn the_claude_mod_s_exact_status_wins_over_herdr_s() {
    let context = setup(Options {
        deps: Some(Box::new(|deps| {
            deps.exact_status = Some(Arc::new(|_| Some("working".into())))
        })),
        ..Options::default()
    });
    // Herdr's screen detection says idle.
    assert_eq!(
        context
            .fake
            .with(|state| state.pane.agent.clone().unwrap()["agent_status"].clone()),
        "idle"
    );
    let result = context
        .handover
        .to_conversation(PANE, None, None)
        .await
        .unwrap();
    assert!(why(&result).contains("is working"));
    assert_eq!(exits(&context.fake), 0);
}

#[tokio::test]
async fn no_mod_status_herdr_s_is_used() {
    let context = setup(Options {
        deps: Some(Box::new(|deps| {
            deps.exact_status = Some(Arc::new(|_| None))
        })),
        ..Options::default()
    });
    assert!(is_ok(
        &context
            .handover
            .to_conversation(PANE, None, None)
            .await
            .unwrap()
    ));
}

#[tokio::test]
async fn an_exit_taken_as_a_message_is_said_so_and_the_switch_may_be_asked_again() {
    let asked = Arc::new(Mutex::new(Vec::<(String, i64)>::new()));
    let noted = asked.clone();
    let context = setup(Options {
        fake: exit_ignored(),
        deps: Some(Box::new(move |deps| {
            deps.exit_swallowed = Some(Arc::new(move |_, command, since| {
                noted.lock().unwrap().push((command, since));
                Box::pin(async { Ok(true) })
            }))
        })),
        ..Options::default()
    });
    let first = context
        .handover
        .to_conversation(PANE, None, None)
        .await
        .unwrap();
    assert!(why(&first).contains("took /exit as a message instead of exiting"));
    assert_eq!(asked.lock().unwrap()[0].0, "/exit");
    assert!(context.leases.get(PANE).is_none());
    // Not "already asked to exit": nothing is exiting.
    let second = context
        .handover
        .to_conversation(PANE, None, None)
        .await
        .unwrap();
    assert!(!why(&second).contains("already asked"));
    assert_eq!(exits(&context.fake), 2);
}

#[tokio::test]
async fn a_turn_the_exit_starts_is_taken_as_swallowed() {
    let status = Arc::new(Mutex::new("idle".to_owned()));
    let slot: Slot = Arc::default();
    let (read, working, fake) = (status.clone(), status.clone(), slot.clone());
    let context = setup(Options {
        fake: exit_ignored(),
        hooks: Hooks {
            prompt: Some(Arc::new(move |pane, text| {
                slot_fake(&fake).with(|state| {
                    state
                        .calls
                        .push(vec!["prompt".into(), pane.into(), text.into()])
                });
                // Sent as a message: Claude starts a turn on it.
                if text == "/exit" {
                    *working.lock().unwrap() = "working".into();
                }
                Ok(())
            })),
            ..Hooks::default()
        },
        deps: Some(Box::new(move |deps| {
            deps.exact_status = Some(Arc::new(move |_| Some(read.lock().unwrap().clone())))
        })),
        ..Options::default()
    });
    *slot.lock().unwrap() = Some(context.fake.clone());
    let result = context
        .handover
        .to_conversation(PANE, None, None)
        .await
        .unwrap();
    assert!(why(&result).contains("as a message"));
    // It may be asked again once the turn ends.
    *status.lock().unwrap() = "idle".into();
    let again = context
        .handover
        .to_conversation(PANE, None, None)
        .await
        .unwrap();
    assert!(!why(&again).contains("already asked"));
}

#[tokio::test]
async fn an_exit_found_swallowed_later_frees_the_pane_for_a_new_switch() {
    let swallowed = Arc::new(AtomicBool::new(false));
    let read = swallowed.clone();
    let context = stuck_watch(Some(Box::new(move |deps| {
        deps.exit_swallowed = Some(Arc::new(move |_, _, _| {
            let swallowed = read.load(Ordering::SeqCst);
            Box::pin(async move { Ok(swallowed) })
        }))
    })));
    let first = context
        .handover
        .to_conversation(PANE, None, None)
        .await
        .unwrap();
    assert!(why(&first).contains("did not exit in time"));
    assert!(!is_ok(
        &context
            .handover
            .to_conversation(PANE, None, None)
            .await
            .unwrap()
    ));
    assert_eq!(exits(&context.fake), 1);
    // The transcript now shows the /exit as a message.
    swallowed.store(true, Ordering::SeqCst);
    let again = context
        .handover
        .to_conversation(PANE, None, None)
        .await
        .unwrap();
    assert!(!why(&again).contains("already asked"));
    assert_eq!(exits(&context.fake), 2);
}

#[tokio::test]
async fn cancelling_the_switch_ends_the_wait_for_an_exit() {
    let context = stuck_watch(None);
    let first = context
        .handover
        .to_conversation(PANE, None, None)
        .await
        .unwrap();
    assert!(why(&first).contains("did not exit in time"));
    let blocked = context
        .handover
        .to_conversation(PANE, None, None)
        .await
        .unwrap();
    assert!(why(&blocked).contains("already asked to exit"));
    assert!(context.handover.cancel_exit(PANE));
    assert!(!context.handover.cancel_exit(PANE));
    let again = context
        .handover
        .to_conversation(PANE, None, None)
        .await
        .unwrap();
    assert!(!why(&again).contains("already asked"));
    assert_eq!(exits(&context.fake), 2);
}

#[tokio::test]
async fn a_cancelled_watch_resumes_nothing_when_claude_exits_late() {
    let context = setup(Options {
        fake: exit_ignored(),
        ..Options::default()
    });
    let first = context
        .handover
        .to_conversation(PANE, None, None)
        .await
        .unwrap();
    assert!(why(&first).contains("did not exit in time"));
    context.handover.cancel_exit(PANE);
    // The /exit lands after all.
    shell_back(&context.fake, 800.0);
    context.fake.with(|state| state.pane.agent = None);
    settle_long().await;
    assert!(calls(&context.fake, "sendText").is_empty());
}

// ------------------------------------------------------ exitSentAsMessage

fn record(text: Value, at: &str, meta: bool) -> String {
    let mut record =
        json!({"type": "user", "timestamp": at, "message": {"role": "user", "content": text}});
    if meta {
        record["isMeta"] = json!(true);
    }
    record.to_string()
}

fn since() -> i64 {
    roamgate_agents::js::date_parse("2026-11-10T15:46:19.600Z") as i64
}

#[test]
fn finds_the_exit_sent_after_a_pasted_image() {
    let tail = [
        record(json!("earlier"), "2026-11-10T15:00:00.000Z", false),
        record(
            json!([{"type": "text", "text": "[Image #168]/exit"}, {"type": "image", "source": {}}]),
            "2026-11-10T15:46:20.000Z",
            false,
        ),
        record(
            json!("[Image: source: /tmp/x.png]"),
            "2026-11-10T15:46:20.050Z",
            true,
        ),
    ]
    .join("\n");
    assert!(exit_sent_as_message(&tail, "/exit", since()));
}

#[test]
fn an_exit_claude_ran_as_its_command_is_not_one() {
    let tail = record(
        json!("<command-name>/exit</command-name>\n<command-message>exit</command-message>"),
        "2026-11-10T15:46:20.000Z",
        false,
    );
    assert!(!exit_sent_as_message(&tail, "/exit", since()));
}

#[test]
fn an_older_exit_message_is_not_this_exit() {
    let tail = record(json!("/exit"), "2026-11-10T15:40:00.000Z", false);
    assert!(!exit_sent_as_message(&tail, "/exit", since()));
}

#[test]
fn a_partial_first_line_and_other_text_are_skipped() {
    let tail = format!(
        "ial\":\"line\"}}\n{}",
        record(
            json!("talk about /exit please"),
            "2026-11-10T15:46:21.000Z",
            false
        )
    );
    assert!(!exit_sent_as_message(&tail, "/exit", since()));
}

// --------------------------------------------------- conversation to terminal

async fn owned(options: Options) -> Context {
    let context = setup(options);
    assert!(is_ok(
        &context
            .handover
            .to_conversation(PANE, None, None)
            .await
            .unwrap()
    ));
    context
}

fn side(side: Side) -> Option<Arc<dyn HeadlessSide>> {
    Some(Arc::new(side))
}

#[tokio::test]
async fn stops_the_headless_process_then_the_holder_resumes_claude() {
    let context = owned(Options::default()).await;
    let events = Arc::new(Mutex::new(Vec::new()));
    let (noted, polls) = (events.clone(), context.polls.clone());
    let headless = side(Side {
        stop: Some(Arc::new(move || {
            // The holder hears nothing before the process is gone.
            assert!(polls.replies().is_empty());
            noted.lock().unwrap().push("stopped".to_owned());
            true
        })),
        ..Side::default()
    });
    let handover = context.handover.clone();
    let resumed = tokio::spawn(async move {
        handover
            .to_terminal(PANE, headless, ToTerminal::default())
            .await
    });
    tokio::task::yield_now().await;
    context.fake.resumed(None, None);
    let result = resumed.await.unwrap().unwrap();
    assert!(is_ok(&result));
    assert_eq!(result["owner"], "terminal");
    assert_eq!(result["session_id"], context.fake.session_id.as_str());
    assert_eq!(result["confirmed"], true);
    assert_eq!(*events.lock().unwrap(), ["stopped"]);
    settle().await;
    let session = context.fake.session_id.clone();
    assert_eq!(
        context.polls.replies(),
        [json!({
            "action": "resume",
            "session_id": session,
            "cwd": context.fake.cwd,
            "argv": ["claude", "--resume", session],
            "args": ["--resume", session],
        })]
    );
    assert!(context.leases.get(PANE).is_none());
    assert!(!calls(&context.fake, "releaseAgent").is_empty());
}

#[tokio::test]
async fn an_unowned_session_is_the_terminal_s_already() {
    let context = plain();
    let result = context
        .handover
        .to_terminal(PANE, None, ToTerminal::default())
        .await
        .unwrap();
    assert!(is_ok(&result));
    assert_eq!(result["owner"], "terminal");
}

#[tokio::test]
async fn refuses_during_a_turn() {
    let context = owned(Options::default()).await;
    let events = Arc::new(Mutex::new(Vec::<String>::new()));
    let headless = side(Side {
        busy: Arc::new(|| true),
        events: events.clone(),
        ..Side::default()
    });
    let result = context
        .handover
        .to_terminal(PANE, headless, ToTerminal::default())
        .await
        .unwrap();
    assert!(why(&result).contains("middle of a turn"));
    assert!(events.lock().unwrap().is_empty());
    assert_eq!(phase(&context, PANE).as_deref(), Some("conversation"));
    assert!(context.polls.replies().is_empty());
}

#[tokio::test]
async fn interrupts_the_turn_when_asked_and_refuses_when_it_will_not_stop() {
    let context = owned(Options::default()).await;
    let interrupts = Arc::new(AtomicUsize::new(0));
    let headless = side(Side {
        busy: Arc::new(|| true),
        interrupts: interrupts.clone(),
        ..Side::default()
    });
    let result = context
        .handover
        .to_terminal(
            PANE,
            headless,
            ToTerminal {
                interrupt: true,
                ..ToTerminal::default()
            },
        )
        .await
        .unwrap();
    assert_eq!(interrupts.load(Ordering::SeqCst), 1);
    assert!(why(&result).contains("did not stop its turn"));
    assert_eq!(phase(&context, PANE).as_deref(), Some("conversation"));
}

#[tokio::test]
async fn interrupts_the_turn_when_asked_then_hands_back() {
    let context = owned(Options::default()).await;
    let busy = Arc::new(AtomicBool::new(true));
    let (read, cleared) = (busy.clone(), busy.clone());
    let headless = side(Side {
        busy: Arc::new(move || read.load(Ordering::SeqCst)),
        on_interrupt: Some(Arc::new(move || cleared.store(false, Ordering::SeqCst))),
        ..Side::default()
    });
    let options = ToTerminal {
        interrupt: true,
        confirm: Some(false),
        ..ToTerminal::default()
    };
    let result = context
        .handover
        .to_terminal(PANE, headless, options)
        .await
        .unwrap();
    assert!(is_ok(&result));
}

#[tokio::test]
async fn refuses_with_messages_in_the_queue() {
    let context = owned(Options::default()).await;
    let result = context
        .handover
        .to_terminal(
            PANE,
            side(Side {
                queue: 2,
                ..Side::default()
            }),
            ToTerminal::default(),
        )
        .await
        .unwrap();
    assert!(why(&result).contains("2 messages wait"));
}

#[tokio::test]
async fn keeps_conversation_mode_when_the_process_does_not_stop() {
    let context = owned(Options::default()).await;
    let (fake, session) = (context.fake.clone(), context.fake.session_id.clone());
    let headless = side(Side {
        stop: Some(Arc::new(move || {
            fake.with(|state| state.probe.running.insert(session.clone()));
            false
        })),
        ..Side::default()
    });
    let result = context
        .handover
        .to_terminal(PANE, headless, ToTerminal::default())
        .await
        .unwrap();
    assert!(why(&result).contains("did not stop"));
    assert_eq!(phase(&context, PANE).as_deref(), Some("conversation"));
    assert!(context.polls.replies().is_empty());
}

#[tokio::test]
async fn an_ssh_client_killed_is_not_enough_the_host_says_the_claude_is_gone() {
    let context = owned(Options::default()).await;
    // stop() cannot tell over SSH (false), the host's ps can.
    let headless = side(Side {
        stop: Some(Arc::new(|| false)),
        ..Side::default()
    });
    let options = ToTerminal {
        confirm: Some(false),
        ..ToTerminal::default()
    };
    let result = context
        .handover
        .to_terminal(PANE, headless, options)
        .await
        .unwrap();
    assert!(is_ok(&result));
    assert!(!calls(&context.fake, "headlessRunning").is_empty());
}

#[tokio::test]
async fn keeps_conversation_mode_while_a_headless_claude_from_before_runs() {
    // Roamgate died mid-turn (or an SSH client went away): no handle here,
    // and after /clear the process still names the old session.
    let context = owned(Options::default()).await;
    let mut lease = context.leases.get(PANE).unwrap();
    lease.insert(
        "session_id".into(),
        json!("22222222-0000-0000-0000-000000000000"),
    );
    lease.insert(
        "headless_session_ids".into(),
        json!([context.fake.session_id]),
    );
    context.leases.set(lease);
    context
        .fake
        .with(|state| state.probe.running.insert(context.fake.session_id.clone()));
    let result = context
        .handover
        .to_terminal(PANE, None, ToTerminal::default())
        .await
        .unwrap();
    assert!(why(&result).contains("did not stop"));
    assert_eq!(phase(&context, PANE).as_deref(), Some("conversation"));
    assert!(context.polls.replies().is_empty());
}

#[tokio::test]
async fn refuses_when_the_host_cannot_say_whether_one_runs() {
    let context = owned(Options::default()).await;
    context.fake.with(|state| state.probe.fails = true);
    let result = context
        .handover
        .to_terminal(PANE, side(Side::default()), ToTerminal::default())
        .await
        .unwrap();
    assert!(!is_ok(&result));
    assert_eq!(phase(&context, PANE).as_deref(), Some("conversation"));
}

#[tokio::test]
async fn a_stale_headless_pid_taken_by_another_process_does_not_block() {
    let context = owned(Options::default()).await;
    let mut lease = context.leases.get(PANE).unwrap();
    lease.insert("headless_pid".into(), json!(812));
    context.leases.set(lease);
    // After a reboot, 812 is some daemon: alive, but not a headless claude.
    context.fake.with(|state| state.live.insert(812));
    let options = ToTerminal {
        confirm: Some(false),
        ..ToTerminal::default()
    };
    let result = context
        .handover
        .to_terminal(PANE, None, options)
        .await
        .unwrap();
    assert!(is_ok(&result));
}

#[tokio::test]
async fn refuses_while_a_background_task_runs() {
    let context = owned(Options::default()).await;
    let events = Arc::new(Mutex::new(Vec::<String>::new()));
    let headless = side(Side {
        background: 1,
        events: events.clone(),
        ..Side::default()
    });
    let result = context
        .handover
        .to_terminal(PANE, headless, ToTerminal::default())
        .await
        .unwrap();
    assert!(why(&result).contains("background task"));
    assert!(events.lock().unwrap().is_empty());
    assert_eq!(phase(&context, PANE).as_deref(), Some("conversation"));
}

#[tokio::test]
async fn without_a_holder_says_how_to_resume() {
    let context = owned(Options::default()).await;
    context.polls.abort();
    settle().await;
    context.holders.forget(PANE);
    let result = context
        .handover
        .to_terminal(PANE, side(Side::default()), ToTerminal::default())
        .await
        .unwrap();
    assert!(is_ok(&result));
    assert_eq!(result["confirmed"], false);
    assert!(
        result["detail"]
            .as_str()
            .unwrap()
            .contains("claude --resume")
    );
}

#[tokio::test]
async fn reports_when_herdr_does_not_map_the_pane_again() {
    let context = owned(Options::default()).await;
    let result = context
        .handover
        .to_terminal(PANE, side(Side::default()), ToTerminal::default())
        .await
        .unwrap();
    assert!(is_ok(&result));
    assert_eq!(result["confirmed"], false);
}

// ------------------------------- a terminal session restarts with its profile

fn glm(plain: bool) -> AgentCommand {
    AgentCommand {
        program: "claude".into(),
        env: if plain {
            vec![]
        } else {
            vec![(
                "ANTHROPIC_BASE_URL".into(),
                "https://gateway.example".into(),
            )]
        },
        unset: if plain {
            vec![]
        } else {
            vec!["ANTHROPIC_API_KEY".into()]
        },
        plain,
        ..AgentCommand::default()
    }
}

#[tokio::test]
async fn exits_the_idle_tui_and_types_a_launch_of_the_same_session() {
    let launches = Arc::new(Mutex::new(Vec::<(String, LaunchSpec)>::new()));
    let noted = launches.clone();
    let context = setup(Options {
        holder_does_not_start: true,
        deps: Some(Box::new(move |deps| {
            deps.resume_profile = Some(Arc::new(|_| Some(glm(false))));
            deps.launch_command = Some(Arc::new(move |pane, spec| {
                noted.lock().unwrap().push((pane.to_owned(), spec));
                " launch TOKEN\r".into()
            }));
        })),
        ..Options::default()
    });
    let session = context.fake.session_id.clone();
    let result = context
        .handover
        .restart_terminal(PANE, Some(&session))
        .await
        .unwrap();
    assert_eq!(
        Value::Object(result),
        json!({"ok": true, "owner": "terminal", "session_id": session})
    );
    let actions: Vec<String> = context
        .fake
        .calls_of(&["prompt", "sendText"])
        .into_iter()
        .map(|call| call[2].clone())
        .collect();
    assert_eq!(actions, ["/exit", " launch TOKEN\r"]);
    let profile = glm(false);
    assert_eq!(
        *launches.lock().unwrap(),
        [(
            PANE.to_owned(),
            LaunchSpec {
                argv: vec!["claude".into(), "--resume".into(), session.clone()],
                env: profile.env,
                unset: profile.unset,
                agent: "claude".into(),
                terminal: true,
            }
        )]
    );
    // No lease: the terminal keeps the session throughout.
    assert!(context.leases.get(PANE).is_none());
}

#[tokio::test]
async fn plain_claude_resumes_as_it_always_did() {
    let context = setup(Options {
        holder_does_not_start: true,
        deps: Some(Box::new(|deps| {
            deps.resume_profile = Some(Arc::new(|_| Some(glm(true))));
            deps.launch_command = Some(Arc::new(|_, _| panic!("not for plain claude")));
        })),
        ..Options::default()
    });
    let result = context.handover.restart_terminal(PANE, None).await.unwrap();
    assert!(is_ok(&result));
    let typed = calls(&context.fake, "sendText");
    assert!(typed[0][2].contains(&format!("claude --resume {}", context.fake.session_id)));
}

#[tokio::test]
async fn refuses_while_claude_works_and_touches_nothing() {
    let context = setup(Options {
        hooks: Hooks {
            agent_get: Some(Arc::new(|_| {
                Ok(json!({"agent": "claude", "agent_status": "working", "agent_session": {"kind": "id", "value": "s"}})
                    .as_object()
                    .cloned())
            })),
            ..Hooks::default()
        },
        ..Options::default()
    });
    let result = context.handover.restart_terminal(PANE, None).await.unwrap();
    assert!(why(&result).contains("working"));
    assert!(calls(&context.fake, "prompt").is_empty());
}

#[tokio::test]
async fn refuses_a_session_conversation_mode_holds() {
    let context = plain();
    assert!(is_ok(
        &context
            .handover
            .to_conversation(PANE, None, None)
            .await
            .unwrap()
    ));
    let session = context.fake.session_id.clone();
    let result = context
        .handover
        .restart_terminal(PANE, Some(&session))
        .await
        .unwrap();
    assert!(why(&result).contains("Conversation mode holds"));
    assert_eq!(phase(&context, PANE).as_deref(), Some("conversation"));
}

// ------------------------ another claude on the session in another pane

const OTHER: &str = "w2:p12";

/// Two panes, each its own fake; each sees the other as the session's
/// other writer.
struct TwoPanes {
    pane: Slot,
    other: Arc<FakeHerdr>,
    order: Arc<Mutex<Vec<String>>>,
}

impl TwoPanes {
    fn pick(&self, pane_id: &str) -> Arc<FakeHerdr> {
        if pane_id == OTHER {
            self.other.clone()
        } else {
            slot_fake(&self.pane)
        }
    }

    fn writer_in(&self, pane_id: &str) -> Option<WriterElsewhere> {
        let agent = self.pick(pane_id).with(|state| state.pane.agent.clone())?;
        let status = match agent.get("agent_status").and_then(Value::as_str) {
            Some(status @ ("idle" | "working" | "blocked")) => status.to_owned(),
            _ => "unknown".into(),
        };
        Some(WriterElsewhere {
            text: format!("Claude runs this session in pane {pane_id}"),
            pane: Some(obj! {
                "pane_id" => pane_id, "workspace_id" => "w2", "tab_id" => "w2:t1",
                "workspace_label" => "roamgate", "tab_label" => "Tab 1",
                "agent_name" => "Claude", "status" => status,
            }),
        })
    }
}

impl ConversationHerdr for TwoPanes {
    fn agent_get<'a>(&'a self, pane_id: &'a str) -> BoxFuture<'a, HerdrResult<Option<Obj>>> {
        Box::pin(async move { self.pick(pane_id).agent_get(pane_id).await })
    }
    fn read_detection<'a>(&'a self, pane_id: &'a str) -> BoxFuture<'a, HerdrResult<String>> {
        Box::pin(async move { self.pick(pane_id).read_detection(pane_id).await })
    }
    fn process_info<'a>(&'a self, pane_id: &'a str) -> BoxFuture<'a, HerdrResult<PaneProcessInfo>> {
        Box::pin(async move { self.pick(pane_id).process_info(pane_id).await })
    }
    fn prompt<'a>(&'a self, pane_id: &'a str, text: &'a str) -> BoxFuture<'a, HerdrResult<()>> {
        self.order.lock().unwrap().push(format!("{pane_id} {text}"));
        Box::pin(async move { self.pick(pane_id).prompt(pane_id, text).await })
    }
    fn send_text<'a>(&'a self, pane_id: &'a str, text: &'a str) -> BoxFuture<'a, HerdrResult<()>> {
        self.order.lock().unwrap().push(format!("{pane_id} typed"));
        Box::pin(async move { self.pick(pane_id).send_text(pane_id, text).await })
    }
    fn send_keys<'a>(&'a self, pane_id: &'a str, keys: &'a str) -> BoxFuture<'a, HerdrResult<()>> {
        Box::pin(async move { self.pick(pane_id).send_keys(pane_id, keys).await })
    }
    fn report_agent(&self, report: AgentReport) -> BoxFuture<'_, HerdrResult<()>> {
        Box::pin(async move { self.pick(PANE).report_agent(report).await })
    }
    fn release_agent<'a>(
        &'a self,
        pane_id: &'a str,
        agent: Option<&'a str>,
    ) -> BoxFuture<'a, HerdrResult<()>> {
        Box::pin(async move { self.pick(pane_id).release_agent(pane_id, agent).await })
    }
    fn pid_alive(&self, pid: u32) -> BoxFuture<'_, bool> {
        Box::pin(
            async move { self.other.pid_alive(pid).await || self.pick(PANE).pid_alive(pid).await },
        )
    }
    fn headless_running<'a>(
        &'a self,
        session_ids: &'a [String],
    ) -> BoxFuture<'a, HerdrResult<bool>> {
        Box::pin(async move { self.pick(PANE).headless_running(session_ids).await })
    }
    fn pane_exists<'a>(&'a self, pane_id: &'a str) -> BoxFuture<'a, HerdrResult<bool>> {
        Box::pin(async move { self.pick(pane_id).pane_exists(pane_id).await })
    }
    fn writer_elsewhere<'a>(
        &'a self,
        pane_id: &'a str,
        _session_ids: &'a [String],
        _except_pids: &'a [u32],
    ) -> BoxFuture<'a, HerdrResult<Option<WriterElsewhere>>> {
        now(Ok(self.writer_in(if pane_id == OTHER {
            PANE
        } else {
            OTHER
        })))
    }
}

fn with_other(
    other_options: FakeHerdrOptions,
) -> (Context, Arc<FakeHerdr>, Arc<Mutex<Vec<String>>>) {
    let other = FakeHerdr::new(FakeHerdrOptions {
        claude_pid: Some(700),
        shell_pid: Some(600),
        ..other_options
    });
    let order = Arc::new(Mutex::new(Vec::new()));
    let pane: Slot = Arc::default();
    let two = Arc::new(TwoPanes {
        pane: pane.clone(),
        other: other.clone(),
        order: order.clone(),
    });
    let context = setup(Options {
        herdr: Some(two),
        ..Options::default()
    });
    *pane.lock().unwrap() = Some(context.fake.clone());
    (context, other, order)
}

#[tokio::test]
async fn refuses_saying_where_the_other_one_is_and_that_it_is_idle() {
    let (context, _, order) = with_other(FakeHerdrOptions::default());
    let result = context
        .handover
        .to_conversation(PANE, None, None)
        .await
        .unwrap();
    assert!(!is_ok(&result));
    let writer = result["writer"].clone();
    assert_eq!(writer["pane_id"], OTHER);
    assert_eq!(writer["workspace_label"], "roamgate");
    assert_eq!(writer["tab_label"], "Tab 1");
    assert_eq!(writer["status"], "idle");
    assert_eq!(
        why(&result),
        "This session is also open in roamgate / Tab 1 (pane w2:p12), where Claude is idle. Only one Claude can write a session at a time, so this waits until that one is closed"
    );
    assert!(context.leases.get(PANE).is_none());
    assert!(order.lock().unwrap().is_empty());
}

#[tokio::test]
async fn quits_the_idle_one_there_leaving_its_shell_then_switches() {
    let (context, other, order) = with_other(FakeHerdrOptions::default());
    let result = context
        .handover
        .to_conversation(PANE, None, Some(OTHER))
        .await
        .unwrap();
    assert!(is_ok(&result));
    assert_eq!(result["owner"], "conversation");
    assert_eq!(phase(&context, PANE).as_deref(), Some("conversation"));
    // The other one quit first, then this pane's: nothing typed there.
    assert_eq!(
        *order.lock().unwrap(),
        [
            format!("{OTHER} /exit"),
            format!("{PANE} /exit"),
            format!("{PANE} typed")
        ]
    );
    assert!(!other.with(|state| state.live.contains(&other.claude_pid)));
    assert_eq!(
        other.with(|state| state.pane.process.foreground_process_group_id),
        Some(600.0)
    );
    assert!(other.calls_of(&["sendText"]).is_empty());
    assert!(context.leases.get(OTHER).is_none());
    assert!(
        !context
            .fake
            .with(|state| state.live.contains(&context.fake.claude_pid))
    );
}

#[tokio::test]
async fn never_quits_it_while_it_is_status() {
    for status in ["working", "blocked"] {
        let (context, other, order) = with_other(FakeHerdrOptions::default());
        set_agent(&other, "agent_status", json!(status));
        let result = context
            .handover
            .to_conversation(PANE, None, Some(OTHER))
            .await
            .unwrap();
        assert!(!is_ok(&result));
        assert_eq!(result["writer"]["status"], status);
        assert!(why(&result).contains(if status == "working" {
            "where Claude is working"
        } else {
            "where Claude waits for an answer"
        }));
        assert!(order.lock().unwrap().is_empty());
        assert!(other.with(|state| state.live.contains(&other.claude_pid)));
    }
}

#[tokio::test]
async fn quits_only_the_pane_the_user_chose() {
    let (context, _, order) = with_other(FakeHerdrOptions::default());
    let result = context
        .handover
        .to_conversation(PANE, None, Some("w9:p9"))
        .await
        .unwrap();
    assert!(!is_ok(&result));
    assert_eq!(result["writer"]["pane_id"], OTHER);
    assert!(order.lock().unwrap().is_empty());
}

#[tokio::test]
async fn says_why_the_other_one_did_not_quit_and_this_pane_keeps_its_claude() {
    let (context, other, order) = with_other(FakeHerdrOptions::default());
    other.with(|state| state.pane.screen = idle_screen().replacen('❯', "❯ half a thought", 1));
    let result = context
        .handover
        .to_conversation(PANE, None, Some(OTHER))
        .await
        .unwrap();
    assert!(!is_ok(&result));
    assert_eq!(result["writer"]["pane_id"], OTHER);
    assert_eq!(result["writer"]["status"], "idle");
    assert!(
        result["writer"]["quit_refusal"]
            .as_str()
            .unwrap()
            .contains("typed in Claude's prompt box")
    );
    assert!(why(&result).contains("It did not quit: "));
    assert!(order.lock().unwrap().is_empty());
    assert!(
        context
            .fake
            .with(|state| state.live.contains(&context.fake.claude_pid))
    );
}

#[tokio::test]
async fn one_quit_late_is_not_resumed_there() {
    let (context, other, order) = with_other(exit_ignored());
    let result = context
        .handover
        .to_conversation(PANE, None, Some(OTHER))
        .await
        .unwrap();
    assert!(
        result["writer"]["quit_refusal"]
            .as_str()
            .unwrap()
            .contains("did not exit in time")
    );
    assert_eq!(*order.lock().unwrap(), [format!("{OTHER} /exit")]);
    // It exits a little later: its shell stays bare.
    other.with(|state| state.pane.agent = None);
    shell_back(&other, 600.0);
    settle_long().await;
    assert!(other.calls_of(&["sendText"]).is_empty());
    // The switch goes now.
    let again = context
        .handover
        .to_conversation(PANE, None, None)
        .await
        .unwrap();
    assert!(is_ok(&again));
    assert_eq!(again["owner"], "conversation");
}

#[tokio::test]
async fn a_suspended_conversation_comes_back_unless_another_writer_has_it() {
    let context = plain();
    holder_in_front(&context.fake);
    let spec = SuspendedSpec {
        session_id: context.fake.session_id.clone(),
        cwd: context.fake.cwd.clone(),
        agent: None,
        terminal_args: vec!["--model".into(), "opus".into()],
    };
    context.fake.with(|state| {
        state.probe.elsewhere = Some(writer_text("Claude runs this session in pane w2:p1"))
    });
    let refused = context
        .handover
        .from_suspended(PANE, spec.clone())
        .await
        .unwrap();
    assert!(why(&refused).contains("w2:p1; close it there first"));
    context.fake.with(|state| state.probe.elsewhere = None);
    let result = context.handover.from_suspended(PANE, spec).await.unwrap();
    assert!(is_ok(&result));
    assert_eq!(result["lease"]["terminal_args"], json!(["--model", "opus"]));
    assert_eq!(phase(&context, PANE).as_deref(), Some("conversation"));
}
