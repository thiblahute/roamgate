//! scheduler.test.ts, case for case, on the test clock.

use std::sync::Mutex;

use roamgate_base::clock::{Clock, TestClock};
use serde_json::{Value, json};

use super::*;
use crate::limit_resume::store::{LimitResumeStore, StoreFile};
use crate::usage_limit::PaneOwner;

/// Tonight's stop: 04:33:24Z, resetting at 04:40:00Z.
const RESETS_S: i64 = 1_794_026_400;
const RESET: i64 = RESETS_S * 1000;
/// 2026-11-07T04:33:30Z.
const T0: i64 = RESET - 390_000;

fn jsonl(records: &[Value]) -> String {
    records.iter().map(|record| format!("{record}\n")).collect()
}

fn stop_record(resets_at: i64, kind: &str, uuid: &str) -> Value {
    let info = json!({"status": "rejected", "resetsAt": resets_at, "rateLimitType": kind});
    json!({
        "isSidechain": false, "type": "assistant", "uuid": uuid,
        "timestamp": "2026-11-07T04:33:24.450Z",
        "message": {"role": "assistant", "content": [{"type": "text", "text": "You've hit your 5-hour limit"}]},
        "apiError": "usage_limit_reached", "apiErrorParams": {"rate_limit_info": info},
        "quotaLimits": info, "error": "rate_limit", "isApiErrorMessage": true,
    })
}

fn user_record(text: &str) -> Value {
    json!({"type": "user", "isSidechain": false, "message": {"role": "user", "content": text}})
}

fn answer_record() -> Value {
    json!({"type": "assistant", "isSidechain": false, "message": {"role": "assistant", "content": [{"type": "text", "text": "Done."}]}})
}

fn bookkeeping() -> Vec<Value> {
    vec![
        json!({"type": "last-prompt", "lastPrompt": "Fix the tests"}),
        json!({"type": "cost-state", "totalCostUSD": 12.5}),
        json!({"type": "system", "subtype": "local_command", "content": "/usage"}),
    ]
}

#[derive(Clone)]
struct FakePane {
    pane: LimitPane,
    tail: String,
}

#[derive(Default)]
struct FakeState {
    panes: Vec<FakePane>,
    sent: Vec<(String, PaneOwner, String)>,
    failures: u32,
    down: bool,
    again: Option<i64>,
    /// Looks asked (panes), transcripts read, and reads at once.
    looks: usize,
    tails: usize,
    in_flight: usize,
    most_at_once: usize,
}

struct Fake {
    id: String,
    state: Arc<Mutex<FakeState>>,
}

impl LimitConnection for Fake {
    fn id(&self) -> &str {
        &self.id
    }

    fn panes(&self) -> BoxFuture<Result<Vec<LimitPane>, String>> {
        let mut state = self.state.lock().unwrap();
        state.looks += 1;
        let answer = if state.down {
            Err("Herdr did not answer".to_owned())
        } else {
            Ok(state.panes.iter().map(|each| each.pane.clone()).collect())
        };
        Box::pin(async move { answer })
    }

    fn transcript_tail(&self, pane_id: &str) -> BoxFuture<Result<Option<String>, String>> {
        let tail = {
            let mut state = self.state.lock().unwrap();
            state.tails += 1;
            state.in_flight += 1;
            state.most_at_once = state.most_at_once.max(state.in_flight);
            state
                .panes
                .iter()
                .find(|each| each.pane.pane_id == pane_id)
                .map(|each| each.tail.clone())
        };
        let state = self.state.clone();
        Box::pin(async move {
            // A read takes a while: others may start meanwhile.
            for _ in 0..3 {
                tokio::task::yield_now().await;
            }
            state.lock().unwrap().in_flight -= 1;
            Ok(tail)
        })
    }

    fn deliver(&self, pane: &LimitPane, text: &str) -> BoxFuture<Result<(), String>> {
        let mut state = self.state.lock().unwrap();
        let answer = if state.failures > 0 {
            state.failures -= 1;
            Err("Herdr did not answer".to_owned())
        } else {
            state
                .sent
                .push((pane.pane_id.clone(), pane.owner, text.to_owned()));
            let again = state.again;
            let fake = state
                .panes
                .iter_mut()
                .find(|each| each.pane.pane_id == pane.pane_id)
                .unwrap();
            fake.tail += &jsonl(&[user_record(text)]);
            // Still limited: Claude Code stops on the limit again.
            if let Some(again) = again {
                fake.tail += &jsonl(&[stop_record(again, "five_hour", "re")]);
            }
            Ok(())
        };
        Box::pin(async move { answer })
    }
}

struct Opts {
    owner: PaneOwner,
    status: &'static str,
    resets_at: i64,
    kind: &'static str,
}

impl Default for Opts {
    fn default() -> Self {
        Self {
            owner: PaneOwner::Terminal,
            status: "idle",
            resets_at: RESETS_S,
            kind: "five_hour",
        }
    }
}

fn paused(pane_id: &str, options: Opts) -> FakePane {
    let mut records = vec![
        user_record("Fix the tests"),
        stop_record(options.resets_at, options.kind, "243ce981"),
    ];
    records.extend(bookkeeping());
    FakePane {
        pane: LimitPane {
            pane_id: pane_id.into(),
            session_id: format!("session-{pane_id}"),
            owner: options.owner,
            status: options.status.into(),
        },
        tail: jsonl(&records),
    }
}

fn fake(id: &str, panes: Vec<FakePane>) -> (Arc<dyn LimitConnection>, Arc<Mutex<FakeState>>) {
    let state = Arc::new(Mutex::new(FakeState {
        panes,
        ..FakeState::default()
    }));
    (
        Arc::new(Fake {
            id: id.into(),
            state: state.clone(),
        }),
        state,
    )
}

type Changes = Arc<Mutex<Vec<(String, Vec<LimitPause>)>>>;

struct Setup {
    resumer: LimitResumer,
    clock: TestClock,
    settings: Arc<Mutex<LimitResumeSettings>>,
    changes: Changes,
    store: LimitResumeStore,
    connections: Arc<Mutex<Vec<Arc<dyn LimitConnection>>>>,
}

fn setup(
    connections: Vec<Arc<dyn LimitConnection>>,
    settings: LimitResumeSettings,
    file: Option<std::path::PathBuf>,
    now: i64,
) -> Setup {
    setup_as(connections, settings, file, now, false)
}

fn setup_as(
    connections: Vec<Arc<dyn LimitConnection>>,
    settings: LimitResumeSettings,
    file: Option<std::path::PathBuf>,
    now: i64,
    observer: bool,
) -> Setup {
    let clock = TestClock::new(now);
    let settings = Arc::new(Mutex::new(settings));
    let changes: Changes = Arc::default();
    let reading = clock.clone();
    let store_file = match file {
        Some(path) => StoreFile::File {
            context: roamgate_base::paths::DataContext::new(
                path.parent().unwrap(),
                roamgate_base::paths::Platform::current(),
                None,
            ),
            path,
            can_write: Arc::new(|| Ok(())),
        },
        None => StoreFile::ReadOnly(None),
    };
    let store = LimitResumeStore::new(store_file, Arc::new(move || reading.now()));
    let connections = Arc::new(Mutex::new(connections));
    let listed = connections.clone();
    let current = settings.clone();
    let recorded = changes.clone();
    let resumer = LimitResumer::new(ResumerOptions {
        connections: Arc::new(move || {
            let list = listed.lock().unwrap().clone();
            Box::pin(async move { Ok(list) })
        }),
        settings: Arc::new(move || {
            let settings = current.lock().unwrap().clone();
            Box::pin(async move { Ok(settings) })
        }),
        store: store.clone(),
        on_change: Some(Arc::new(move |id: &str, pauses| {
            recorded.lock().unwrap().push((id.to_owned(), pauses));
        })),
        log: None,
        clock: Arc::new(clock.clone()),
        timings: Timings::default(),
        observer,
    });
    Setup {
        resumer,
        clock,
        settings,
        changes,
        store,
        connections,
    }
}

async fn settle() {
    for _ in 0..40 {
        tokio::task::yield_now().await;
    }
}

impl Setup {
    /// Steps by second so each timer's async work settles before the next.
    async fn advance(&self, ms: i64) {
        let mut left = ms;
        while left > 0 {
            self.clock.advance(left.min(1000) as u64).await;
            settle().await;
            left -= 1000;
        }
    }

    async fn jump(&self, ms: i64) {
        self.clock.advance(ms.max(0) as u64).await;
        settle().await;
    }

    fn now(&self) -> i64 {
        self.clock.now()
    }
}

fn sent(state: &Arc<Mutex<FakeState>>) -> Vec<(String, PaneOwner, String)> {
    state.lock().unwrap().sent.clone()
}

fn sent_panes(state: &Arc<Mutex<FakeState>>) -> Vec<String> {
    sent(state).into_iter().map(|(pane, _, _)| pane).collect()
}

fn tail_push(state: &Arc<Mutex<FakeState>>, records: &[Value]) {
    state.lock().unwrap().panes[0].tail += &jsonl(records);
}

fn defaults() -> LimitResumeSettings {
    LimitResumeSettings::default()
}

#[tokio::test]
async fn a_5_hour_stop_is_resumed_a_minute_after_its_reset_once_as_the_user_would() {
    let (local, state) = fake("local", vec![paused("w1:p1", Opts::default())]);
    let run = setup(vec![local], defaults(), None, T0);
    run.resumer.scan_all().await;
    let pauses = run.resumer.list("local");
    let pause = &pauses[0];
    assert_eq!(
        (
            pause.pane_id.as_str(),
            pause.session_id.as_str(),
            pause.owner,
            pause.kind.as_str()
        ),
        ("w1:p1", "session-w1:p1", PaneOwner::Terminal, "five_hour")
    );
    assert_eq!(
        (pause.resets_at, pause.resume_at, pause.state),
        (RESET, Some(RESET + 60_000), LimitPauseState::Scheduled)
    );
    assert_eq!(run.changes.lock().unwrap().last().unwrap().1.len(), 1);

    run.advance(RESET + 59_000 - T0).await;
    assert!(sent(&state).is_empty());
    run.advance(1000).await;
    assert_eq!(
        sent(&state),
        vec![("w1:p1".into(), PaneOwner::Terminal, defaults().message)]
    );
    // Its transcript shows the message: not paused any more.
    run.advance(5000).await;
    assert!(run.resumer.list("local").is_empty());
    run.advance(60 * 60_000).await;
    assert_eq!(sent(&state).len(), 1);
    run.resumer.stop();
}

#[tokio::test]
async fn a_weekly_stop_is_scheduled_and_resumed_the_same_way_in_conversation_mode() {
    let resets_at = RESETS_S + 2 * 24 * 3600;
    let (local, state) = fake(
        "local",
        vec![paused(
            "w1:p2",
            Opts {
                owner: PaneOwner::Conversation,
                kind: "seven_day",
                resets_at,
                ..Opts::default()
            },
        )],
    );
    let settings = LimitResumeSettings {
        message: "Go on.".into(),
        margin_seconds: 120,
        ..defaults()
    };
    let run = setup(vec![local], settings, None, T0);
    run.resumer.scan_all().await;
    let pause = run.resumer.list("local")[0].clone();
    assert_eq!(
        (pause.kind.as_str(), pause.state, pause.resume_at),
        (
            "seven_day",
            LimitPauseState::Scheduled,
            Some(resets_at * 1000 + 120_000)
        )
    );
    run.jump(resets_at * 1000 + 119_000 - T0).await;
    assert!(sent(&state).is_empty());
    run.advance(1000).await;
    assert_eq!(
        sent(&state),
        vec![("w1:p2".into(), PaneOwner::Conversation, "Go on.".into())]
    );
    run.resumer.stop();
}

#[tokio::test]
async fn no_resume_when_the_user_resumed_it_already() {
    let (local, state) = fake("local", vec![paused("w1:p1", Opts::default())]);
    let run = setup(vec![local], defaults(), None, T0);
    run.resumer.scan_all().await;
    // At 04:50 the user typed "Keep going" and it went through.
    tail_push(&state, &[user_record("Keep going"), answer_record()]);
    run.advance(RESET + 120_000 - T0).await;
    assert!(sent(&state).is_empty());
    assert!(run.resumer.list("local").is_empty());
    run.resumer.stop();
}

#[tokio::test]
async fn one_resume_per_reset_stopped_again_on_it_it_waits_for_the_next_reset() {
    let (local, state) = fake("local", vec![paused("w1:p1", Opts::default())]);
    state.lock().unwrap().again = Some(RESETS_S);
    let run = setup(vec![local], defaults(), None, T0);
    run.resumer.scan_all().await;
    run.advance(RESET + 60_000 - T0).await;
    assert_eq!(sent(&state).len(), 1);
    run.advance(5000).await;
    let pause = run.resumer.list("local")[0].clone();
    assert_eq!(
        (pause.state, pause.resume_at),
        (LimitPauseState::Resumed, None)
    );
    run.advance(30 * 60_000).await;
    assert_eq!(sent(&state).len(), 1);

    // It hits the limit again with a new reset: scheduled again.
    let next = RESETS_S + 5 * 3600;
    state.lock().unwrap().again = None;
    tail_push(
        &state,
        &[
            user_record("Keep going"),
            stop_record(next, "five_hour", "new"),
        ],
    );
    run.resumer.poke("local", Some("w1:p1"));
    run.advance(3000).await;
    let pause = run.resumer.list("local")[0].clone();
    assert_eq!(
        (pause.state, pause.resets_at),
        (LimitPauseState::Scheduled, next * 1000)
    );
    run.advance(next * 1000 + 60_000 - run.now()).await;
    assert_eq!(sent(&state).len(), 2);
    run.resumer.stop();
}

#[tokio::test]
async fn a_server_restart_resumes_what_was_seen_in_time_never_what_was_not() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("limit-resume.json");
    let first_pane = paused("w1:p1", Opts::default());
    let (first, _) = fake("local", vec![first_pane.clone()]);
    let before = setup(vec![first], defaults(), Some(file.clone()), T0);
    before.resumer.scan_all().await;
    assert_eq!(
        before.resumer.list("local")[0].state,
        LimitPauseState::Scheduled
    );
    before.resumer.stop();

    // Down across the reset; back ten minutes after it.
    let late = paused("w2:p1", Opts::default());
    let (second, state) = fake("local", vec![first_pane, late]);
    let after = setup(vec![second], defaults(), Some(file), RESET + 10 * 60_000);
    after.resumer.scan_all().await;
    // As the scan saw them (the due one may already be on its way: its
    // timer is due at once).
    let seen = after.changes.lock().unwrap()[0].1.clone();
    let states: Vec<(String, LimitPauseState)> = seen
        .into_iter()
        .map(|each| (each.pane_id, each.state))
        .collect();
    assert_eq!(
        states,
        vec![
            ("w1:p1".into(), LimitPauseState::Scheduled),
            ("w2:p1".into(), LimitPauseState::Missed)
        ]
    );
    after.advance(1000).await;
    assert_eq!(sent_panes(&state), vec!["w1:p1"]);

    // Never seen in time: only "Resume now" sends it.
    after.advance(10 * 60_000).await;
    assert_eq!(sent(&state).len(), 1);
    assert_eq!(
        after.resumer.resume_now("local", "w2:p1").await,
        Outcome::ok()
    );
    assert_eq!(sent_panes(&state), vec!["w1:p1", "w2:p1"]);
    after.resumer.stop();
}

#[tokio::test]
async fn a_pause_long_overdue_is_not_resumed_after_a_restart() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("limit-resume.json");
    let (local, state) = fake("local", vec![paused("w1:p1", Opts::default())]);
    let before = setup(vec![local.clone()], defaults(), Some(file.clone()), T0);
    before.resumer.scan_all().await;
    before.resumer.stop();
    let after = setup(
        vec![local],
        defaults(),
        Some(file),
        RESET + 2 * 24 * 3_600_000,
    );
    after.resumer.scan_all().await;
    assert_eq!(
        after.resumer.list("local")[0].state,
        LimitPauseState::Missed
    );
    after.advance(5000).await;
    assert!(sent(&state).is_empty());
    after.resumer.stop();
}

#[tokio::test]
async fn don_t_resume_holds_the_session_undone_it_is_resumed_at_the_reset() {
    let (local, state) = fake(
        "local",
        vec![
            paused("w1:p1", Opts::default()),
            paused("w1:p2", Opts::default()),
        ],
    );
    let run = setup(vec![local], defaults(), None, T0);
    run.resumer.scan_all().await;
    assert_eq!(
        run.resumer.set_skip("local", "w1:p1", true).await.unwrap(),
        Outcome::ok()
    );
    assert_eq!(run.store.get("session-w1:p1").unwrap()["skip"], true);
    let pause = run.resumer.list("local")[0].clone();
    assert_eq!(
        (pause.pane_id.as_str(), pause.state, pause.resume_at),
        ("w1:p1", LimitPauseState::Skipped, None)
    );
    run.advance(RESET + 60_000 - T0).await;
    assert_eq!(sent_panes(&state), vec!["w1:p2"]);

    // Undone after the reset: it was seen in time, so it goes now.
    run.resumer.set_skip("local", "w1:p1", false).await.unwrap();
    run.advance(1000).await;
    assert_eq!(sent_panes(&state), vec!["w1:p2", "w1:p1"]);
    run.resumer.stop();
}

#[tokio::test]
async fn with_the_setting_off_paused_sessions_are_shown_but_not_resumed() {
    let (local, state) = fake("local", vec![paused("w1:p1", Opts::default())]);
    let run = setup(
        vec![local],
        LimitResumeSettings {
            enabled: false,
            ..defaults()
        },
        None,
        T0,
    );
    run.resumer.scan_all().await;
    assert_eq!(run.resumer.list("local")[0].state, LimitPauseState::Off);
    run.advance(RESET + 5 * 60_000 - T0).await;
    assert!(sent(&state).is_empty());
    // Turned on before the reset of a later stop: scheduled.
    run.settings.lock().unwrap().enabled = true;
    tail_push(
        &state,
        &[
            user_record("again"),
            stop_record(RESETS_S + 3600, "five_hour", "later"),
        ],
    );
    run.resumer.poke("local", Some("w1:p1"));
    run.advance(3000).await;
    assert_eq!(
        run.resumer.list("local")[0].state,
        LimitPauseState::Scheduled
    );
    run.resumer.stop();
}

#[tokio::test]
async fn a_busy_terminal_is_waited_for_never_typed_into() {
    let (local, state) = fake("local", vec![paused("w1:p1", Opts::default())]);
    let run = setup(vec![local], defaults(), None, T0);
    run.resumer.scan_all().await;
    state.lock().unwrap().panes[0].pane.status = "blocked".into();
    run.advance(RESET + 60_000 - T0).await;
    assert!(sent(&state).is_empty());
    run.advance(60_000).await;
    assert!(sent(&state).is_empty());
    state.lock().unwrap().panes[0].pane.status = "idle".into();
    run.advance(60_000).await;
    assert_eq!(sent(&state).len(), 1);
    run.resumer.stop();
}

#[tokio::test]
async fn a_failed_send_is_tried_again_then_given_up() {
    let (local, state) = fake("local", vec![paused("w1:p1", Opts::default())]);
    state.lock().unwrap().failures = 1;
    let run = setup(vec![local], defaults(), None, T0);
    run.resumer.scan_all().await;
    run.advance(RESET + 60_000 - T0).await;
    assert!(sent(&state).is_empty());
    let pause = run.resumer.list("local")[0].clone();
    assert_eq!(
        (pause.state, pause.reason.as_deref()),
        (LimitPauseState::Failed, Some("Herdr did not answer"))
    );
    run.advance(30_000).await;
    assert_eq!(sent(&state).len(), 1);

    // Failing every time: five tries, then it waits for the user.
    let (other, other_state) = fake("local", vec![paused("w1:p1", Opts::default())]);
    other_state.lock().unwrap().failures = 100;
    let again = setup(vec![other], defaults(), None, T0);
    again.resumer.scan_all().await;
    again.advance(RESET + 60_000 - T0 + 10 * 60_000).await;
    assert_eq!(other_state.lock().unwrap().failures, 95);
    let pause = again.resumer.list("local")[0].clone();
    assert_eq!(
        (pause.state, pause.resume_at),
        (LimitPauseState::Failed, None)
    );
    run.resumer.stop();
    again.resumer.stop();
}

#[tokio::test]
async fn resume_now_before_the_reset_does_not_use_up_the_reset_s_resume() {
    let (local, state) = fake("local", vec![paused("w1:p1", Opts::default())]);
    state.lock().unwrap().again = Some(RESETS_S);
    let run = setup(vec![local], defaults(), None, T0);
    run.resumer.scan_all().await;
    assert_eq!(
        run.resumer.resume_now("local", "w1:p1").await,
        Outcome::ok()
    );
    assert_eq!(sent(&state).len(), 1);
    state.lock().unwrap().again = None;
    run.advance(5000).await;
    // Still limited: paused by the same reset, which resumes it.
    assert_eq!(
        run.resumer.list("local")[0].state,
        LimitPauseState::Scheduled
    );
    run.advance(RESET + 60_000 - run.now()).await;
    assert_eq!(sent(&state).len(), 2);
    run.resumer.stop();
}

#[tokio::test]
async fn every_connection_is_looked_at_remote_ones_included() {
    let fine = FakePane {
        pane: LimitPane {
            pane_id: "w1:p1".into(),
            session_id: "fine".into(),
            owner: PaneOwner::Terminal,
            status: "idle".into(),
        },
        tail: jsonl(&[user_record("hi"), answer_record()]),
    };
    let (local, local_state) = fake("local", vec![fine]);
    let (desktop, desktop_state) = fake(
        "desktop",
        vec![paused(
            "w3:p1",
            Opts {
                owner: PaneOwner::Conversation,
                ..Opts::default()
            },
        )],
    );
    let run = setup(vec![local, desktop], defaults(), None, T0);
    run.resumer.scan_all().await;
    assert!(run.resumer.list("local").is_empty());
    assert_eq!(run.resumer.list("desktop")[0].connection_id, "desktop");
    assert!(
        run.changes
            .lock()
            .unwrap()
            .iter()
            .any(|(id, _)| id == "desktop")
    );

    // The host does not answer for a while: what was known stays.
    desktop_state.lock().unwrap().down = true;
    run.resumer.scan_all().await;
    assert_eq!(run.resumer.list("desktop").len(), 1);
    desktop_state.lock().unwrap().down = false;

    run.advance(RESET + 60_000 - T0).await;
    assert_eq!(
        sent(&desktop_state),
        vec![("w3:p1".into(), PaneOwner::Conversation, defaults().message)]
    );
    assert!(sent(&local_state).is_empty());

    // A connection removed loses its pauses.
    run.connections.lock().unwrap().pop();
    run.resumer.scan_all().await;
    assert!(run.resumer.list("desktop").is_empty());
    assert_eq!(
        run.changes.lock().unwrap().last().unwrap(),
        &("desktop".to_owned(), Vec::new())
    );
    run.resumer.stop();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn started_it_looks_after_its_first_delay_then_every_minute() {
    let (local, _) = fake("local", vec![paused("w1:p1", Opts::default())]);
    let run = setup(vec![local], defaults(), None, T0);
    run.resumer.start(5_000);
    run.jump(4_999).await;
    assert!(run.changes.lock().unwrap().is_empty());
    run.jump(1).await;
    for _ in 0..100 {
        if !run.changes.lock().unwrap().is_empty() {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
    assert_eq!(run.changes.lock().unwrap().len(), 1);
    run.resumer.stop();
}

fn many(count: usize) -> Vec<FakePane> {
    (0..count)
        .map(|index| paused(&format!("w{index}:p1"), Opts::default()))
        .collect()
}

#[tokio::test]
async fn a_look_reads_a_few_transcripts_at_once_and_keeps_the_panes_order() {
    let (local, state) = fake("local", many(10));
    let run = setup(vec![local], defaults(), None, T0);
    run.resumer.scan_all().await;
    let state = state.lock().unwrap();
    assert_eq!(state.tails, 10);
    assert_eq!(state.most_at_once, READ_CONCURRENCY);
    let panes: Vec<String> = run
        .changes
        .lock()
        .unwrap()
        .last()
        .unwrap()
        .1
        .iter()
        .map(|pause| pause.pane_id.clone())
        .collect();
    assert_eq!(panes.len(), 10);
    run.resumer.stop();
}

#[tokio::test]
async fn an_observer_only_looks_it_never_arms_pokes_or_sends() {
    // Due at once: an owner would send it on the next turn.
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("limit-resume.json");
    let (first, _) = fake("local", vec![paused("w1:p1", Opts::default())]);
    let before = setup(vec![first], defaults(), Some(file.clone()), T0);
    before.resumer.scan_all().await;
    before.resumer.stop();
    let (local, state) = fake("local", vec![paused("w1:p1", Opts::default())]);
    let run = setup_as(vec![local], defaults(), None, RESET + 60_000, true);
    // Reads the owner's store, writes nothing.
    let read = LimitResumeStore::new(StoreFile::ReadOnly(Some(file.clone())), Arc::new(|| 0));
    assert!(read.get("session-w1:p1").is_some());
    run.resumer.look("local").await;
    assert_eq!(run.clock.pending(), 0);
    run.resumer.poke("local", Some("w1:p1"));
    assert_eq!(run.clock.pending(), 0);
    run.advance(5 * 60_000).await;
    assert!(sent(&state).is_empty());
    assert_eq!(run.resumer.list("local").len(), 1);
    run.resumer.stop();
}

#[tokio::test]
async fn a_look_joins_the_one_under_way_without_asking_for_another() {
    let (local, state) = fake("local", many(3));
    let run = setup_as(vec![local], defaults(), None, T0, true);
    let first = run.resumer.look("local");
    let second = run.resumer.look("local");
    first.await;
    second.await;
    settle().await;
    assert_eq!(state.lock().unwrap().looks, 1);
    // Read once: the next look reads no transcript again.
    run.resumer.look("local").await;
    let state = state.lock().unwrap();
    assert_eq!((state.looks, state.tails), (2, 3));
    drop(state);
    run.resumer.stop();
}

#[tokio::test]
async fn an_owner_adopts_what_the_observer_read() {
    let (local, state) = fake("local", many(3));
    let observer = setup_as(vec![local.clone()], defaults(), None, T0, true);
    observer.resumer.look("local").await;
    assert_eq!(state.lock().unwrap().tails, 3);
    let owner = setup(vec![local], defaults(), None, T0);
    owner.resumer.adopt_reads(&observer.resumer);
    owner.resumer.scan_all().await;
    assert_eq!(state.lock().unwrap().tails, 3);
    assert_eq!(owner.resumer.list("local").len(), 3);
    observer.resumer.stop();
    owner.resumer.stop();
}
