use std::sync::{Arc, Mutex};
use std::time::Duration;

use roamgate_base::clock::TokioClock;
use serde_json::{Value, json};

use super::*;

const TIMING: ErrandTiming = ErrandTiming {
    poll: 5,
    settled: 20,
    working: 150,
    repeat: 300,
    limit: 2000,
};

async fn sleep(ms: u64) {
    tokio::time::sleep(Duration::from_millis(ms)).await;
}

async fn until(check: impl Fn() -> bool) {
    for _ in 0..400 {
        if check() {
            return;
        }
        sleep(5).await;
    }
}

type Entries = Arc<Mutex<Vec<Value>>>;
type OnPrompt = Box<dyn Fn(&Entries, &str) + Send + Sync>;

/// A session: its history, what a prompt does to it, its status.
struct Session {
    entries: Entries,
    prompted: Mutex<Vec<String>>,
    on_prompt: OnPrompt,
    status: Option<Box<dyn Fn() -> Option<ErrandSessionStatus> + Send + Sync>>,
    kept: Mutex<Vec<KeptAnswer>>,
}

impl Session {
    fn new(on_prompt: OnPrompt) -> Self {
        Self {
            entries: Arc::default(),
            prompted: Mutex::default(),
            on_prompt,
            status: None,
            kept: Mutex::default(),
        }
    }
}

impl ErrandDeps for Session {
    fn read(&self, _: &str, _: &str) -> BoxFuture<'static, Result<Vec<Value>, String>> {
        let entries = self.entries.lock().unwrap().clone();
        Box::pin(async move { Ok(entries) })
    }

    fn prompt(
        &self,
        connection_id: &str,
        pane_id: &str,
        text: &str,
    ) -> BoxFuture<'static, Result<(), String>> {
        self.prompted
            .lock()
            .unwrap()
            .push(format!("{connection_id} {pane_id} {text}"));
        (self.on_prompt)(&self.entries, text);
        Box::pin(async { Ok(()) })
    }

    fn status(
        &self,
        _: &str,
        _: &str,
    ) -> BoxFuture<'static, Result<Option<ErrandSessionStatus>, String>> {
        let status = self.status.as_ref().and_then(|status| status());
        Box::pin(async move { Ok(status) })
    }

    fn has_status(&self) -> bool {
        self.status.is_some()
    }

    fn keep(&self, answer: KeptAnswer) {
        self.kept.lock().unwrap().push(answer);
    }
}

fn entry(id: &str, role: &str, kind: &str, text: &str) -> Value {
    json!({"id": id, "role": role, "kind": kind, "text": text})
}

/// Adds `more` to the history `ms` later.
fn later(entries: &Entries, ms: u64, more: Vec<Value>) {
    let entries = entries.clone();
    tokio::spawn(async move {
        sleep(ms).await;
        entries.lock().unwrap().extend(more);
    });
}

fn errands(session: Arc<Session>, causes: Arc<TurnCauses>) -> VoiceErrands {
    VoiceErrands::new(
        session,
        causes,
        TIMING,
        Arc::new(TokioClock::starting_at(0)),
    )
}

#[tokio::test(start_paused = true)]
async fn sends_the_errand_and_gives_back_the_answer_once_it_settles() {
    let session = Arc::new(Session::new(Box::new(|entries, text| {
        entries.lock().unwrap().extend([
            entry("q", "user", "message", text),
            entry("t", "assistant", "tool_call", "search"),
        ]);
        later(
            entries,
            30,
            vec![
                entry("m", "assistant", "message", "Looking."),
                entry("a", "assistant", "message", "2 to 1."),
            ],
        );
    })));
    session
        .entries
        .lock()
        .unwrap()
        .push(entry("old", "assistant", "message", "Earlier."));
    let errands = errands(session.clone(), Arc::default());
    let job = errands
        .start("local/wF:p5", "[Voice] The score?", ErrandAbout::default())
        .await
        .unwrap();
    assert_eq!(
        *session.prompted.lock().unwrap(),
        ["local wF:p5 [Voice] The score?"]
    );
    assert_eq!(errands.state(&job), Some(ErrandState::default()));
    until(|| errands.state(&job).unwrap().done).await;
    assert_eq!(
        errands.state(&job),
        Some(ErrandState {
            done: true,
            // The whole answer, not only its last message.
            answer: Some("Looking.\n\n2 to 1.".into()),
            notice: None,
        })
    );
}

/// A session that took the errand and is busy on a tool step.
fn busy_session(
    status: impl Fn() -> Option<ErrandSessionStatus> + Send + Sync + 'static,
) -> VoiceErrands {
    let mut session = Session::new(Box::new(|entries, _| {
        *entries.lock().unwrap() = vec![
            entry("q", "user", "message", "Send it"),
            entry("t", "assistant", "tool_call", "send"),
        ];
    }));
    session.status = Some(Box::new(status));
    errands(Arc::new(session), Arc::default())
}

fn status(name: &str, waiting: Option<&str>, queued: u32) -> Option<ErrandSessionStatus> {
    Some(ErrandSessionStatus {
        status: Some(name.into()),
        waiting: waiting.map(str::to_owned),
        queued,
    })
}

/// The notices told, each new number once.
fn notices(
    errands: &VoiceErrands,
    job: &str,
) -> (Arc<Mutex<Vec<ErrandNotice>>>, tokio::task::JoinHandle<()>) {
    let told: Arc<Mutex<Vec<ErrandNotice>>> = Arc::default();
    let (kept, errands, job) = (told.clone(), errands.clone(), job.to_owned());
    let watch = tokio::spawn(async move {
        loop {
            if let Some(notice) = errands.state(&job).and_then(|s| s.notice) {
                let mut told = kept.lock().unwrap();
                if told.last().map(ErrandNotice::seq) != Some(notice.seq()) {
                    told.push(notice);
                }
            }
            sleep(2).await;
        }
    });
    (told, watch)
}

#[tokio::test(start_paused = true)]
async fn a_session_quietly_at_work_is_not_told_as_stuck_early() {
    let errands = busy_session(|| status("working", None, 0));
    let job = errands
        .start("local/wF:p5", "Send it", ErrandAbout::default())
        .await
        .unwrap();
    // Well past the time it used to be called stuck: nothing to tell.
    sleep(90).await;
    assert_eq!(errands.state(&job).unwrap().notice, None);
}

#[tokio::test(start_paused = true)]
async fn a_long_quiet_turn_is_told_as_still_working_again_only_after_a_while() {
    let errands = busy_session(|| status("working", None, 0));
    let job = errands
        .start("local/wF:p5", "Send it", ErrandAbout::default())
        .await
        .unwrap();
    let (told, watch) = notices(&errands, &job);
    until(|| errands.state(&job).unwrap().notice.is_some()).await;
    assert!(matches!(
        errands.state(&job).unwrap().notice,
        Some(ErrandNotice::Working { minutes: 0, .. })
    ));
    // Not repeated before the repeat time.
    sleep(150).await;
    assert_eq!(told.lock().unwrap().len(), 1);
    until(|| told.lock().unwrap().len() > 1).await;
    watch.abort();
    let told = told.lock().unwrap();
    assert_eq!(told.len(), 2);
    assert!(
        told.iter()
            .all(|n| matches!(n, ErrandNotice::Working { .. }))
    );
}

#[tokio::test(start_paused = true)]
async fn a_session_waiting_on_a_prompt_is_told_at_once_with_what_it_asks() {
    let errands = busy_session(|| status("blocked", Some("git push origin main"), 0));
    let job = errands
        .start("local/wF:p5", "Send it", ErrandAbout::default())
        .await
        .unwrap();
    until(|| errands.state(&job).unwrap().notice.is_some()).await;
    assert!(matches!(
        errands.state(&job).unwrap().notice,
        Some(ErrandNotice::Waiting { what: Some(what), .. }) if what == "git push origin main"
    ));
}

#[tokio::test(start_paused = true)]
async fn messages_queued_for_an_idle_looking_session_count_as_busy() {
    let queued = Arc::new(Mutex::new(1));
    let read = queued.clone();
    let errands = busy_session(move || status("idle", None, *read.lock().unwrap()));
    let job = errands
        .start("local/wF:p5", "Send it", ErrandAbout::default())
        .await
        .unwrap();
    until(|| errands.state(&job).unwrap().notice.is_some()).await;
    let notice = errands.state(&job).unwrap().notice.unwrap();
    assert!(matches!(notice, ErrandNotice::Working { .. }));
    // Idle with nothing queued: it is not working, nothing more is told.
    *queued.lock().unwrap() = 0;
    sleep(400).await;
    assert_eq!(
        errands.state(&job).unwrap().notice.unwrap().seq(),
        notice.seq()
    );
}

#[tokio::test(start_paused = true)]
async fn only_the_oldest_job_on_a_session_tells_how_it_goes() {
    let errands = busy_session(|| status("working", None, 1));
    let first = errands
        .start("local/wF:p5", "Send it", ErrandAbout::default())
        .await
        .unwrap();
    let second = errands
        .start("local/wF:p5", "And this", ErrandAbout::default())
        .await
        .unwrap();
    until(|| errands.state(&first).unwrap().notice.is_some()).await;
    sleep(30).await;
    assert!(matches!(
        errands.state(&first).unwrap().notice,
        Some(ErrandNotice::Working { .. })
    ));
    assert_eq!(errands.state(&second).unwrap().notice, None);
}

#[tokio::test(start_paused = true)]
async fn an_answer_nobody_follows_is_kept_with_the_sessions_name_and_the_question() {
    let turn = Arc::new(Mutex::new(0));
    let session = Arc::new(Session::new(Box::new(move |entries, text| {
        let n = {
            let mut turn = turn.lock().unwrap();
            *turn += 1;
            *turn
        };
        *entries.lock().unwrap() = vec![entry(&format!("q{n}"), "user", "message", text)];
        later(
            entries,
            30,
            vec![entry(
                &format!("a{n}"),
                "assistant",
                "message",
                "We use pyannote.",
            )],
        );
    })));
    let errands = errands(session.clone(), Arc::default());
    // The page reloaded right after: nothing polls the job's state.
    let job = errands
        .start(
            "local/w3:p1",
            "[Voice] What speaker recognition tool do we use?",
            ErrandAbout {
                label: Some("gst".into()),
                question: Some("What speaker recognition tool do we use?".into()),
            },
        )
        .await
        .unwrap();
    until(|| !session.kept.lock().unwrap().is_empty()).await;
    assert_eq!(
        *session.kept.lock().unwrap(),
        vec![KeptAnswer {
            job: job.clone(),
            pane: "local/w3:p1".into(),
            label: "gst".into(),
            question: "What speaker recognition tool do we use?".into(),
            answer: "We use pyannote.".into(),
        }]
    );
    // Kept before the job shows as done: a page following it marks it
    // heard once told.
    assert_eq!(errands.state(&job).map(|s| s.done), Some(true));
    // Without a name or the words, the pane and the text sent stand in.
    let bare = errands
        .start("local/w3:p1", "[Voice] Again?", ErrandAbout::default())
        .await
        .unwrap();
    until(|| session.kept.lock().unwrap().len() > 1).await;
    let second = session.kept.lock().unwrap()[1].clone();
    assert_eq!(second.job, bare);
    assert_eq!(second.label, "local/w3:p1");
    assert_eq!(second.question, "[Voice] Again?");
}

#[tokio::test(start_paused = true)]
async fn the_turn_an_errand_starts_is_noted_as_the_companions() {
    let causes: Arc<TurnCauses> = Arc::default();
    let errands = errands(Arc::new(Session::new(Box::new(|_, _| {}))), causes.clone());
    errands
        .start("local/wF:p5", "[Voice] The score?", ErrandAbout::default())
        .await
        .unwrap();
    let turn = causes.turn("local", "wF:p5", None);
    assert_eq!(
        turn.cause.unwrap().cause,
        crate::companion::turn_causes::TurnCause::Companion
    );
    assert_eq!(turn.user_at, None);
}
