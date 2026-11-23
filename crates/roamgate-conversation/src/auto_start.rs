//! Conversation mode taking a claude the user just started in a pane
//! (`auto-start.ts`; the `claude` start setting, told by the claude's
//! SessionStart hook): the usual handover, tried again while Claude is
//! still starting, or busy with a prompt it was started with. Anything that
//! says the user is at work in the terminal ends it.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, LazyLock, Mutex};

use regex::Regex;
use roamgate_agents::obj;

use crate::driver::BoxFuture;
use crate::shared::{LogFn, Obj, is_ok, reason, refuse};
use crate::time::{SharedClock, sleep_ms};

/// What a refusal means for a claude that just started.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AutoStartRetry {
    Starting,
    Busy,
    Stop,
}

static STARTING: LazyLock<Vec<Regex>> = LazyLock::new(|| {
    [
        // Herdr has not seen it yet, or not its session.
        "^Claude is not running in this pane",
        "^Herdr has no session id",
        "^Herdr did not say what runs",
        "^Herdr cannot tell whether Claude is idle",
        "^Herdr did not list the pane's processes",
        // Still drawing its prompt box, or asking first.
        "^Claude's prompt box is not on screen",
        "^Could not read Claude's prompt box",
        "^Claude is waiting for an answer in the terminal",
        "^Cannot tell which process is Claude",
        "^A handover of this pane is already running",
    ]
    .iter()
    .map(|pattern| Regex::new(pattern).unwrap())
    .collect()
});

static BUSY: LazyLock<Vec<Regex>> = LazyLock::new(|| {
    // A prompt given on the command line: its turn ends first.
    ["^Claude is working", "^Claude still runs background work"]
        .iter()
        .map(|pattern| Regex::new(pattern).unwrap())
        .collect()
});

pub fn auto_start_retry(reason: &str) -> AutoStartRetry {
    if STARTING.iter().any(|pattern| pattern.is_match(reason)) {
        AutoStartRetry::Starting
    } else if BUSY.iter().any(|pattern| pattern.is_match(reason)) {
        AutoStartRetry::Busy
    } else {
        AutoStartRetry::Stop
    }
}

/// A handover to conversation mode: (pane, session) to its result.
pub type ToConversation =
    Arc<dyn Fn(String, String) -> BoxFuture<'static, Result<Obj, String>> + Send + Sync>;

#[derive(Clone)]
pub struct AutoStartDeps {
    pub to_conversation: ToConversation,
    /// Conversation mode already has the pane (or is taking it).
    pub owned: Arc<dyn Fn(&str) -> bool + Send + Sync>,
    /// The connection is going away.
    pub closed: Arc<dyn Fn() -> bool + Send + Sync>,
    pub log: Option<LogFn>,
    pub clock: SharedClock,
    /// Before the first try: Claude draws its prompt box.
    pub first_delay_ms: i64,
    /// Between tries while it starts, and for how long in all.
    pub retry_ms: i64,
    pub starting_ms: i64,
    /// Between tries while a prompt it started with runs, and how long.
    pub busy_retry_ms: i64,
    pub busy_ms: i64,
}

impl AutoStartDeps {
    pub fn new(
        to_conversation: ToConversation,
        owned: Arc<dyn Fn(&str) -> bool + Send + Sync>,
        closed: Arc<dyn Fn() -> bool + Send + Sync>,
        clock: SharedClock,
    ) -> Self {
        Self {
            to_conversation,
            owned,
            closed,
            log: None,
            clock,
            first_delay_ms: 1000,
            retry_ms: 1000,
            starting_ms: 2 * 60_000,
            busy_retry_ms: 3000,
            busy_ms: 30 * 60_000,
        }
    }
}

/// Takes panes' new claudes once it can (`createAutoStarter`). Cheap to
/// clone.
#[derive(Clone)]
pub struct AutoStarter {
    deps: Arc<AutoStartDeps>,
    /// The run going on in each pane: a newer start replaces it.
    runs: Arc<Mutex<HashMap<String, u64>>>,
    next: Arc<AtomicU64>,
}

impl AutoStarter {
    pub fn new(deps: AutoStartDeps) -> Self {
        Self {
            deps: Arc::new(deps),
            runs: Arc::new(Mutex::new(HashMap::new())),
            next: Arc::new(AtomicU64::new(1)),
        }
    }

    fn log(&self, message: &str, fields: Obj) {
        if let Some(log) = &self.deps.log {
            log(message, fields);
        }
    }

    /// Takes the pane's new claude once it can; the future gives the
    /// outcome. The start counts from the call (a newer one replaces it).
    pub fn start(
        &self,
        pane_id: &str,
        session_id: &str,
    ) -> impl std::future::Future<Output = Obj> + Send + 'static {
        let token = self.next.fetch_add(1, Ordering::SeqCst);
        self.runs.lock().unwrap().insert(pane_id.to_owned(), token);
        let this = self.clone();
        let pane_id = pane_id.to_owned();
        let session_id = session_id.to_owned();
        async move {
            let result = this.run(&pane_id, &session_id, token).await;
            let mut runs = this.runs.lock().unwrap();
            if runs.get(&pane_id) == Some(&token) {
                runs.remove(&pane_id);
            }
            result
        }
    }

    async fn run(&self, pane_id: &str, session_id: &str, token: u64) -> Obj {
        let deps = &self.deps;
        let started = deps.clock.now();
        let current = || {
            self.runs.lock().unwrap().get(pane_id) == Some(&token)
                && !(deps.closed)()
                && !(deps.owned)(pane_id)
        };
        let mut wait = deps.first_delay_ms;
        let mut last = refuse("Stopped before it was tried");
        loop {
            sleep_ms(&*deps.clock, wait.max(0) as u64).await;
            if !current() {
                return last;
            }
            last = (deps.to_conversation)(pane_id.to_owned(), session_id.to_owned())
                .await
                .unwrap_or_else(refuse);
            if is_ok(&last) {
                self.log(
                    "conversation mode took the claude started in the pane",
                    obj! {"pane" => pane_id, "session" => session_id},
                );
                return last;
            }
            let retry = auto_start_retry(reason(&last));
            let elapsed = deps.clock.now() - started;
            if retry == AutoStartRetry::Stop
                || (retry == AutoStartRetry::Starting && elapsed >= deps.starting_ms)
                || (retry == AutoStartRetry::Busy && elapsed >= deps.busy_ms)
            {
                self.log(
                    "the claude started in the pane stays in the terminal",
                    obj! {"pane" => pane_id, "reason" => reason(&last)},
                );
                return last;
            }
            wait = if retry == AutoStartRetry::Busy {
                deps.busy_retry_ms
            } else {
                deps.retry_ms
            };
        }
    }

    /// Whether a start waits on the pane.
    pub fn pending(&self, pane_id: &str) -> bool {
        self.runs.lock().unwrap().contains_key(pane_id)
    }

    pub fn cancel(&self, pane_id: &str) {
        self.runs.lock().unwrap().remove(pane_id);
    }

    pub fn dispose(&self) {
        self.runs.lock().unwrap().clear();
    }
}

#[cfg(test)]
mod tests {
    use std::collections::VecDeque;
    use std::sync::atomic::AtomicBool;

    use super::*;
    use crate::shared::accepted;
    use crate::time::{Clock, VirtualClock};

    fn no(reason: &str) -> Obj {
        refuse(reason)
    }

    struct Starter {
        auto: AutoStarter,
        tries: Arc<Mutex<Vec<(String, String, i64)>>>,
        clock: VirtualClock,
    }

    fn starter(answers: Vec<Obj>, owned: Option<Arc<AtomicBool>>) -> Starter {
        let clock = VirtualClock::new();
        let tries = Arc::new(Mutex::new(Vec::new()));
        let answers = Arc::new(Mutex::new(VecDeque::from(answers)));
        let noted = tries.clone();
        let at = clock.clone();
        let auto = AutoStarter::new(AutoStartDeps::new(
            Arc::new(move |pane, session| {
                noted.lock().unwrap().push((pane, session, at.now()));
                let answer = answers
                    .lock()
                    .unwrap()
                    .pop_front()
                    .unwrap_or_else(|| no("no more answers"));
                Box::pin(async move { Ok(answer) })
            }),
            Arc::new(move |_| {
                owned
                    .as_ref()
                    .is_some_and(|owned| owned.load(Ordering::SeqCst))
            }),
            Arc::new(|| false),
            clock.shared(),
        ));
        Starter { auto, tries, clock }
    }

    fn yes() -> Obj {
        accepted("conversation", "s")
    }

    #[test]
    fn refusals_while_it_starts_are_tried_again_the_user_s_own_work_ends_it() {
        use AutoStartRetry::*;
        for (reason, retry) in [
            ("Herdr has no session id for this pane", Starting),
            ("Claude's prompt box is not on screen", Starting),
            ("Claude is not running in this pane", Starting),
            ("Claude is waiting for an answer in the terminal", Starting),
            (
                "Claude is working (a turn or a background task); it can switch once it is idle",
                Busy,
            ),
            (
                "Something is typed in Claude's prompt box; send or clear it first",
                Stop,
            ),
            ("The pane now runs another session", Stop),
            (
                "Conversation mode already owns this session in another pane",
                Stop,
            ),
            (
                "The pane holder did not start; Claude was resumed in the terminal",
                Stop,
            ),
        ] {
            assert_eq!(auto_start_retry(reason), retry, "{reason}");
        }
    }

    #[tokio::test]
    async fn waits_for_claude_to_draw_its_prompt_then_takes_it() {
        let s = starter(
            vec![
                no("Herdr has no session id for this pane"),
                no("Claude's prompt box is not on screen"),
                yes(),
            ],
            None,
        );
        assert!(is_ok(&s.auto.start("w1:p1", "s-1").await));
        let tries = s.tries.lock().unwrap().clone();
        assert_eq!(
            tries,
            [1000, 2000, 3000].map(|at| ("w1:p1".to_owned(), "s-1".to_owned(), at))
        );
        assert!(!s.auto.pending("w1:p1"));
    }

    #[tokio::test]
    async fn a_prompt_it_was_started_with_runs_to_its_end_first() {
        let s = starter(
            vec![
                no("Claude is working (a turn or a background task)"),
                no("Claude is working (a turn or a background task)"),
                yes(),
            ],
            None,
        );
        assert!(is_ok(&s.auto.start("w1:p1", "s-1").await));
        let at: Vec<i64> = s
            .tries
            .lock()
            .unwrap()
            .iter()
            .map(|(_, _, at)| *at)
            .collect();
        assert_eq!(at, [1000, 4000, 7000]);
    }

    #[tokio::test]
    async fn something_typed_in_the_terminal_it_stays_there() {
        let s = starter(
            vec![
                no("Something is typed in Claude's prompt box; send or clear it first"),
                yes(),
            ],
            None,
        );
        assert!(!is_ok(&s.auto.start("w1:p1", "s-1").await));
        assert_eq!(s.tries.lock().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn gives_up_on_a_claude_that_never_comes_up() {
        let s = starter(
            (0..1000)
                .map(|_| no("Herdr has no session id for this pane"))
                .collect(),
            None,
        );
        assert!(!is_ok(&s.auto.start("w1:p1", "s-1").await));
        assert!(s.clock.now() >= 120_000);
        assert!(s.clock.now() < 125_000);
        assert!(s.tries.lock().unwrap().len() < 130);
    }

    #[tokio::test]
    async fn a_newer_start_replaces_the_one_waiting_a_pane_taken_meanwhile_ends_it() {
        let owned = Arc::new(AtomicBool::new(false));
        let s = starter(
            vec![no("Herdr has no session id for this pane"), yes()],
            Some(owned.clone()),
        );
        let first = s.auto.start("w1:p1", "s-1");
        let second = s.auto.start("w1:p1", "s-2");
        let (first, second) = tokio::join!(first, second);
        assert!(is_ok(&second));
        assert!(!is_ok(&first));
        // Only the newer one tried, with its own session.
        let sessions: Vec<String> = s
            .tries
            .lock()
            .unwrap()
            .iter()
            .map(|(_, session, _)| session.clone())
            .collect();
        assert_eq!(sessions, ["s-2", "s-2"]);
        owned.store(true, Ordering::SeqCst);
        assert!(!is_ok(&s.auto.start("w1:p1", "s-3").await));
        assert_eq!(s.tries.lock().unwrap().len(), 2);
    }
}
