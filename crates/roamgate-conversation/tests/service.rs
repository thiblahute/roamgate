//! service.test.ts's and suspend.test.ts's cases that check what the
//! conversation service writes: the leases (in memory and on disk), the
//! stopped jobs (conversation-suspended.json's entries), what each holder
//! is told, and what is typed into the pane. Run with Claude's own drivers
//! (`roamgate-claude`), as Bun's tests run with claude's, on tokio's paused
//! clock (Bun's virtual handover clock).

use std::sync::{Arc, Mutex, OnceLock};

use roamgate_base::clock::TokioClock;
use roamgate_claude::conversation::drivers;
use roamgate_conversation::driver::BoxFuture;
use roamgate_conversation::driver::PaneProcess;
use roamgate_conversation::handover::SuspendedSpec;
use roamgate_conversation::herdr::PaneProcessInfo;
use roamgate_conversation::holder::HolderShell;
use roamgate_conversation::images::ConversationImage;
use roamgate_conversation::lease::{
    LeaseOptions, LeaseStore, flush_lease_files, forget_lease_files,
};
use roamgate_conversation::rpc::handle_agent_chat_rpc;
use roamgate_conversation::service::HolderSideInput;
use roamgate_conversation::service::{ConversationService, ServiceOptions};
use roamgate_conversation::shared::{Lease, Obj};
use roamgate_conversation::testing::{
    FakeHerdr, FakeHerdrOptions, FakeSpawner, result_line, settle, writer_text,
};
use serde_json::{Value, json};
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;

const PANE: &str = "w1:p1";

fn obj(value: Value) -> Obj {
    value.as_object().cloned().unwrap_or_default()
}

fn memory_store() -> LeaseStore {
    LeaseStore::new(LeaseOptions {
        connection_id: "c1".into(),
        file: None,
        clock: Arc::new(TokioClock::starting_at(1_767_225_600_000)),
        data: None,
    })
}

/// A lease as a test writes one.
fn lease(pane: &str, session: &str, cwd: &str, phase: &str) -> Lease {
    obj(json!({"pane_id": pane, "session_id": session, "cwd": cwd, "phase": phase}))
}

/// What the holder Herdr is told to type does: it polls as `PANE`'s.
#[derive(Default)]
struct Holders {
    service: OnceLock<ConversationService>,
    session_id: String,
    shell: Option<HolderShell>,
    polls: Mutex<Vec<JoinHandle<Obj>>>,
    aborts: Mutex<Vec<CancellationToken>>,
}

impl Holders {
    fn start(self: &Arc<Self>) {
        let Some(service) = self.service.get().cloned() else {
            return;
        };
        let signal = CancellationToken::new();
        self.aborts.lock().unwrap().push(signal.clone());
        let input = HolderSideInput {
            pane_id: PANE.into(),
            session_id: self.session_id.clone(),
            status: None,
            shell: self.shell.clone(),
            signal: Some(signal),
        };
        let poll = tokio::spawn(async move { service.holder_hold(input).await });
        self.polls.lock().unwrap().push(poll);
    }

    /// The `n`-th poll's answer.
    async fn poll(&self, n: usize) -> Obj {
        let poll = self.polls.lock().unwrap().remove(n);
        poll.await.unwrap()
    }

    fn abort_all(&self) {
        for signal in self.aborts.lock().unwrap().iter() {
            signal.cancel();
        }
    }
}

struct Setup {
    service: ConversationService,
    fake: Arc<FakeHerdr>,
    spawner: Arc<FakeSpawner>,
    store: LeaseStore,
    sent: Arc<Mutex<Vec<(u64, Obj)>>>,
    holders: Arc<Holders>,
}

impl Drop for Setup {
    fn drop(&mut self) {
        self.holders.abort_all();
        self.service.dispose();
    }
}

/// A conversation service on a fake Herdr and fake headless processes
/// (`setupService`).
fn setup_with(
    store: Option<LeaseStore>,
    shell: Option<HolderShell>,
    tweak: impl FnOnce(&mut ServiceOptions),
) -> Setup {
    let session_id = "11111111-2222-3333-4444-555555555555".to_owned();
    let holders = Arc::new(Holders {
        session_id: session_id.clone(),
        shell,
        ..Holders::default()
    });
    let starter = holders.clone();
    let fake = FakeHerdr::new(FakeHerdrOptions {
        on_holder: Some(Arc::new(move |_| starter.start())),
        ..FakeHerdrOptions::default()
    });
    let spawner = FakeSpawner::new(None);
    let store = store.unwrap_or_else(memory_store);
    let sent: Arc<Mutex<Vec<(u64, Obj)>>> = Arc::default();
    let sink = sent.clone();
    let mut options = ServiceOptions::new(
        "c1",
        fake.clone(),
        store.clone(),
        drivers(),
        Arc::new(TokioClock::starting_at(1_767_225_600_000)),
        Arc::new(|_, _| Box::pin(async { Ok(Some(json!("allow"))) })),
        Arc::new(
            |_| -> BoxFuture<'static, Result<ConversationImage, String>> {
                Box::pin(async {
                    Ok(ConversationImage {
                        media_type: "image/png".into(),
                        data: String::new(),
                    })
                })
            },
        ),
        Arc::new(move |socket, envelope| sink.lock().unwrap().push((socket, envelope))),
        Arc::new(|id: &str| format!("hold {id}\r")),
    );
    options.spawn = Some(spawner.clone());
    options.hold_poll_ms = 60_000;
    options.session_tweak = Some(Arc::new(|session| {
        session.stop_wait_ms = 50;
        session.interrupt_wait_ms = 50;
    }));
    tweak(&mut options);
    let service = ConversationService::new(options);
    let _ = holders.service.set(service.clone());
    Setup {
        service,
        fake,
        spawner,
        store,
        sent,
        holders,
    }
}

fn setup() -> Setup {
    setup_with(None, None, |_| {})
}

async fn to_conversation(setup: &Setup) -> Obj {
    let result = setup
        .service
        .handover(PANE, "conversation", false, false, None, None, None)
        .await;
    settle().await;
    result
}

async fn to_terminal(setup: &Setup, suspend: Option<Option<String>>) -> Obj {
    setup
        .service
        .handover(PANE, "terminal", false, false, None, None, suspend)
        .await
}

async fn send(setup: &Setup, text: &str, uuid: Option<&str>) -> Result<Value, String> {
    setup
        .service
        .send(PANE, text, Vec::new(), uuid.map(str::to_owned))
        .await
}

/// The pane as conversation mode leaves it: the holder in its shell.
fn held_pane(fake: &FakeHerdr) {
    let claude = fake.claude_pid;
    fake.with(|state| {
        state.live.remove(&claude);
        state.pane.agent = None;
        state.pane.process = PaneProcessInfo {
            shell_pid: Some(800.0),
            foreground_process_group_id: Some(950.0),
            foreground_processes: vec![PaneProcess {
                pid: 950,
                argv: Some(vec!["python3".into(), "roamgate-hold".into()]),
                ..PaneProcess::default()
            }],
        };
    });
}

fn bare_shell(fake: &FakeHerdr) {
    fake.with(|state| {
        state.pane.agent = None;
        state.pane.process = PaneProcessInfo {
            shell_pid: Some(800.0),
            foreground_process_group_id: Some(800.0),
            foreground_processes: Vec::new(),
        };
    });
}

fn shell_at_prompt(fake: &FakeHerdr) {
    fake.with(|state| {
        state.pane.process = PaneProcessInfo {
            shell_pid: Some(800.0),
            foreground_process_group_id: Some(800.0),
            foreground_processes: vec![PaneProcess {
                pid: 800,
                argv0: Some("-bash".into()),
                ..PaneProcess::default()
            }],
        };
    });
}

fn phase(store: &LeaseStore, pane: &str) -> Option<String> {
    store.get(pane).and_then(|lease| {
        lease
            .get("phase")
            .and_then(Value::as_str)
            .map(str::to_owned)
    })
}

fn typed(fake: &FakeHerdr) -> Vec<Vec<String>> {
    fake.calls_of(&["sendText"])
}

// ------------------------------------------------------------ leases

#[tokio::test(start_paused = true)]
async fn never_starts_a_headless_claude_behind_a_pane_with_no_holder() {
    let first = setup();
    assert_eq!(to_conversation(&first).await["ok"], json!(true));
    first.service.dispose();
    // Roamgate restarts; the holder is gone (the pane is a bare shell).
    let second = setup_with(Some(first.store.clone()), None, |options| {
        options.carried_queue_delay_ms = 60_000;
    });
    bare_shell(&second.fake);
    // The message waits; the terminal has the session again.
    assert_eq!(
        send(&second, "hi", Some("m1")).await.unwrap(),
        json!({"status": "queued", "id": "m1"})
    );
    assert!(second.spawner.spawned.lock().unwrap().is_empty());
    assert!(second.store.get(PANE).is_none());
    let state = second.service.state(PANE);
    assert_eq!(state["owner"], json!("terminal"));
    assert_eq!(state["queue"][0]["id"], json!("m1"));
    assert_eq!(state["queue"][0]["text"], json!("hi"));
    // Nothing was typed into the shell.
    assert!(typed(&second.fake).is_empty());
}

#[tokio::test(start_paused = true)]
async fn never_starts_a_headless_claude_for_a_holder_of_another_session() {
    let made = setup();
    made.store.set(lease(
        PANE,
        &made.fake.session_id,
        &made.fake.cwd,
        "conversation",
    ));
    bare_shell(&made.fake);
    let service = made.service.clone();
    let _poll = tokio::spawn(async move {
        service
            .holder_hold(HolderSideInput {
                pane_id: PANE.into(),
                session_id: "99999999-0000-0000-0000-000000000000".into(),
                status: None,
                shell: None,
                signal: Some(CancellationToken::new()),
            })
            .await
    });
    settle().await;
    let refused = send(&made, "hi", None).await.unwrap_err();
    assert!(refused.contains("another session"), "{refused}");
    assert!(made.spawner.spawned.lock().unwrap().is_empty());
    assert_eq!(phase(&made.store, PANE).as_deref(), Some("conversation"));
}

#[tokio::test(start_paused = true)]
async fn a_stale_lease_on_a_pane_running_claude_again_is_taken_over_afresh() {
    let made = setup();
    made.store.set(lease(
        PANE,
        &made.fake.session_id,
        &made.fake.cwd,
        "conversation",
    ));
    let result = to_conversation(&made).await;
    assert_eq!(result["ok"], json!(true));
    assert_eq!(result["owner"], json!("conversation"));
    // It went through /exit and the holder, not straight to "owned".
    assert!(made.fake.calls().contains(&vec![
        "prompt".to_owned(),
        PANE.to_owned(),
        "/exit".to_owned()
    ]));
}

#[tokio::test(start_paused = true)]
async fn a_closed_pane_takes_its_lease_and_its_process_with_it() {
    let made = setup();
    to_conversation(&made).await;
    send(&made, "a long turn", None).await.unwrap();
    assert_eq!(made.spawner.alive().len(), 1);
    made.service.pane_closed(PANE);
    settle().await;
    assert!(made.store.get(PANE).is_none());
    assert!(made.spawner.alive().is_empty());
}

#[tokio::test(start_paused = true)]
async fn a_sweep_drops_the_leases_whose_pane_is_gone() {
    let made = setup();
    to_conversation(&made).await;
    made.service.sweep().await;
    assert!(made.store.get(PANE).is_some());
    made.fake.with(|state| state.probe.closed = true);
    made.service.sweep().await;
    assert!(made.store.get(PANE).is_none());
}

#[tokio::test(start_paused = true)]
async fn the_queue_outlives_the_runtime_and_is_sent_by_the_next_one() {
    let first = setup();
    to_conversation(&first).await;
    send(&first, "first", None).await.unwrap();
    assert_eq!(
        send(&first, "later", Some("q1")).await.unwrap(),
        json!({"status": "queued", "id": "q1"})
    );
    // An SSH drop, a Herdr reconnect: the runtime is replaced.
    first.service.dispose();
    let queue = first.store.get(PANE).unwrap()["queue"].clone();
    assert_eq!(queue[0]["id"], json!("q1"));
    assert_eq!(queue[0]["text"], json!("later"));
    // Its holder polls again, from the new runtime.
    assert_eq!(first.holders.poll(0).await["action"], json!("hold"));
    let second = setup_with(Some(first.store.clone()), None, |options| {
        options.carried_queue_delay_ms = 0;
    });
    held_pane(&second.fake);
    assert_eq!(second.service.state(PANE)["queue"][0]["id"], json!("q1"));
    second.holders.start();
    for _ in 0..20 {
        tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        settle().await;
    }
    let fake = second.spawner.spawned.lock().unwrap()[0].1.clone();
    let users: Vec<Value> = fake
        .written()
        .into_iter()
        .filter(|message| message.get("type") == Some(&json!("user")))
        .map(|message| message["message"].clone())
        .collect();
    assert_eq!(users, vec![json!({"role": "user", "content": "later"})]);
    assert!(second.store.get(PANE).unwrap().get("queue").is_none());
    fake.push(result_line());
}

#[tokio::test(start_paused = true)]
async fn nothing_is_typed_into_the_pane_while_a_handover_runs() {
    let made = setup();
    assert_eq!(made.service.input_refusal(PANE), None);
    assert!(!made.service.handing_over());
    let service = made.service.clone();
    let fake = made.fake.clone();
    let during = tokio::spawn(async move {
        // As the switch types /exit into Claude.
        loop {
            let exit = vec!["prompt".to_owned(), PANE.to_owned(), "/exit".to_owned()];
            if fake.calls().contains(&exit) {
                return (service.input_refusal(PANE), service.handing_over());
            }
            // Not a busy loop: the paused clock moves on while all wait.
            tokio::time::sleep(std::time::Duration::from_millis(1)).await;
        }
    });
    to_conversation(&made).await;
    let (refusal, any) = during.await.unwrap();
    let refusal = refusal.unwrap_or_default();
    assert!(refusal.contains("being handed over"), "{refusal}");
    assert!(any);
    assert_eq!(made.service.input_refusal(PANE), None);
    assert!(!made.service.handing_over());
}

#[tokio::test(start_paused = true)]
async fn a_holder_this_runtime_never_knew_keeps_holding_never_resumes() {
    let made = setup_with(None, None, |options| options.hold_poll_ms = 5);
    let reply = made
        .service
        .holder_hold(HolderSideInput {
            pane_id: PANE.into(),
            session_id: "abc".into(),
            status: None,
            shell: None,
            signal: Some(CancellationToken::new()),
        })
        .await;
    assert_eq!(
        Value::Object(reply),
        json!({"action": "hold", "session_id": "abc"})
    );
}

#[tokio::test(start_paused = true)]
async fn a_holder_whose_lease_this_runtime_dropped_resumes_claude() {
    let made = setup_with(None, None, |options| options.hold_poll_ms = 5);
    to_conversation(&made).await;
    assert_eq!(to_terminal(&made, None).await["ok"], json!(true));
    made.holders.abort_all();
    // It missed the reply that resumed it: its next poll gets it.
    let reply = made
        .service
        .holder_hold(HolderSideInput {
            pane_id: PANE.into(),
            session_id: made.fake.session_id.clone(),
            status: None,
            shell: None,
            signal: Some(CancellationToken::new()),
        })
        .await;
    assert_eq!(reply["action"], json!("resume"));
    assert_eq!(reply["session_id"], json!(made.fake.session_id));
}

#[tokio::test(start_paused = true)]
async fn clear_moves_the_lease_the_holder_and_herdrs_mapping() {
    let made = setup();
    to_conversation(&made).await;
    made.service.subscribe(7, PANE);
    send(&made, "/clear", None).await.unwrap();
    let fake = made.spawner.spawned.lock().unwrap()[0].1.clone();
    let next = "22222222-0000-0000-0000-000000000000";
    fake.push(json!({
        "type": "conversation_reset",
        "new_conversation_id": next,
        "session_id": made.fake.session_id,
    }));
    settle().await;
    assert_eq!(made.store.get(PANE).unwrap()["session_id"], json!(next));
    assert_eq!(
        Value::Object(made.holders.poll(0).await),
        json!({"action": "hold", "session_id": next})
    );
    let reports = made.fake.with(|state| state.reports.clone());
    assert_eq!(reports.last().unwrap().1, next);
    // The push names the new session, not the lease's old one.
    let pushed: Vec<Value> = made
        .sent
        .lock()
        .unwrap()
        .iter()
        .filter(|(_, envelope)| envelope.get("event") == Some(&json!("agent_chat.session")))
        .map(|(_, envelope)| envelope["data"].clone())
        .collect();
    assert_eq!(
        pushed,
        vec![json!({
            "type": "session",
            "pane_id": PANE,
            "session_id": next,
            "previous": made.fake.session_id,
        })]
    );
}

#[tokio::test(start_paused = true)]
async fn a_restart_mid_handover_settles_the_leases_safely() {
    let store = memory_store();
    store.set(lease("a", "s-a", "/a", "to_terminal"));
    store.set(lease("b", "s-b", "/b", "to_conversation"));
    let _made = setup_with(Some(store.clone()), None, |_| {});
    assert_eq!(phase(&store, "a").as_deref(), Some("conversation"));
    assert!(store.get("b").is_none());
}

#[tokio::test(start_paused = true)]
async fn a_running_turn_is_marked_on_the_lease_until_its_result() {
    let made = setup();
    to_conversation(&made).await;
    assert!(
        made.store
            .get(PANE)
            .unwrap()
            .get("turn_started_at")
            .is_none()
    );
    send(&made, "work", None).await.unwrap();
    assert!(made.store.get(PANE).unwrap()["turn_started_at"].is_string());
    let fake = made.spawner.spawned.lock().unwrap()[0].1.clone();
    fake.push(result_line());
    settle().await;
    assert!(
        made.store
            .get(PANE)
            .unwrap()
            .get("turn_started_at")
            .is_none()
    );
    assert_eq!(made.service.state(PANE)["interrupted"], Value::Null);
}

#[tokio::test(start_paused = true)]
async fn a_holder_polling_a_pane_whose_lease_says_terminal_is_told_to_resume() {
    let made = setup();
    to_conversation(&made).await;
    let mut current = made.store.get(PANE).unwrap();
    current.insert("phase".into(), json!("terminal"));
    made.store.set(current);
    let reply = made
        .service
        .holder_hold(HolderSideInput {
            pane_id: PANE.into(),
            session_id: made.fake.session_id.clone(),
            status: None,
            shell: None,
            signal: Some(CancellationToken::new()),
        })
        .await;
    assert_eq!(
        Value::Object(reply),
        json!({"action": "resume", "session_id": made.fake.session_id, "cwd": made.fake.cwd})
    );
}

// ------------------------------------------------------------ leases on disk

/// The lease files' registry is the process's: the disk tests take turns.
static DISK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

/// A restart: what this process knew is gone, the file is read again.
async fn restart() {
    flush_lease_files().await;
    forget_lease_files();
}

fn disk_store(connection: &str, file: &std::path::Path) -> LeaseStore {
    LeaseStore::new(LeaseOptions {
        connection_id: connection.into(),
        file: Some(file.to_owned()),
        clock: Arc::new(TokioClock::starting_at(1_767_225_600_000)),
        data: None,
    })
}

#[tokio::test]
async fn leases_survive_a_restart_per_connection() {
    let _turn = DISK.lock().await;
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("leases.json");
    let one = disk_store("c1", &file);
    let two = disk_store("c2", &file);
    one.set(lease("p", "s1", "/x", "conversation"));
    two.set(lease("p", "s2", "/y", "conversation"));
    restart().await;
    let again = disk_store("c1", &file);
    let found = again.get("p").unwrap();
    assert_eq!(found["connection_id"], json!("c1"));
    assert_eq!(found["session_id"], json!("s1"));
    assert_eq!(found["owner"], json!("conversation"));
    again.delete("p");
    restart().await;
    assert!(disk_store("c1", &file).get("p").is_none());
    assert_eq!(
        disk_store("c2", &file).get("p").unwrap()["session_id"],
        json!("s2")
    );
    restart().await;
}

#[tokio::test]
async fn a_burst_of_lease_saves_is_written_once_off_the_caller() {
    let _turn = DISK.lock().await;
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("leases.json");
    let store = disk_store("c1", &file);
    for offset in 0..50 {
        store.set(lease(
            &format!("p{}", offset % 5),
            &format!("s{offset}"),
            "/x",
            "conversation",
        ));
    }
    // Nothing is written in the caller's turn.
    assert!(!file.exists());
    flush_lease_files().await;
    let written: Value = serde_json::from_str(&std::fs::read_to_string(&file).unwrap()).unwrap();
    let mut sessions: Vec<String> = written["leases"]
        .as_array()
        .unwrap()
        .iter()
        .map(|lease| lease["session_id"].as_str().unwrap().to_owned())
        .collect();
    sessions.sort();
    assert_eq!(sessions, ["s45", "s46", "s47", "s48", "s49"]);
    // A change while a write is under way goes in the next one.
    store.set(lease("p0", "late", "/x", "conversation"));
    tokio::time::sleep(std::time::Duration::from_millis(1)).await;
    store.set(lease("p1", "later", "/x", "conversation"));
    flush_lease_files().await;
    restart().await;
    let again = disk_store("c1", &file);
    assert_eq!(again.get("p0").unwrap()["session_id"], json!("late"));
    assert_eq!(again.get("p1").unwrap()["session_id"], json!("later"));
    restart().await;
}

// ------------------------------------------------------------ Ctrl+Z and fg

fn job() -> HolderShell {
    HolderShell {
        job_control: true,
        pid: Some(4321),
        job: Some("11111111-2222-3333-4444-555555555555".into()),
    }
}

/// A pane in conversation mode, its holder able to stop as a shell job.
async fn held(shell: HolderShell, tweak: impl FnOnce(&mut ServiceOptions)) -> Setup {
    let made = setup_with(None, Some(shell), tweak);
    assert_eq!(to_conversation(&made).await["ok"], json!(true));
    held_pane(&made.fake);
    made
}

#[tokio::test(start_paused = true)]
async fn suspend_stops_the_process_releases_the_pane_and_tells_the_holder_what_to_keep() {
    let made = held(job(), |_| {}).await;
    let result = to_terminal(&made, Some(Some("Fix the build".into()))).await;
    assert_eq!(
        Value::Object(result),
        json!({"ok": true, "owner": "terminal", "session_id": made.fake.session_id, "suspended": true})
    );
    // Nothing runs on the session, and no claude is started in the pane.
    assert!(made.spawner.alive().is_empty());
    assert_eq!(
        Value::Object(made.holders.poll(0).await),
        json!({
            "action": "suspend",
            "session_id": made.fake.session_id,
            "cwd": made.fake.cwd,
            "title": "Fix the build",
        })
    );
    let state = made.service.state(PANE);
    assert_eq!(state["owner"], json!("terminal"));
    assert_eq!(state["phase"], json!("terminal"));
    let stopped = made.service.suspended_panes();
    assert_eq!(stopped.len(), 1);
    let entry = &stopped[0];
    assert_eq!(entry["pane_id"], json!(PANE));
    assert_eq!(entry["session_id"], json!(made.fake.session_id));
    assert_eq!(entry["title"], json!("Fix the build"));
    assert!(entry["suspended_at"].is_string());
    assert_eq!(entry["holder_pid"], json!(4321));
    assert_eq!(entry["job"], json!(job().job.unwrap()));
    assert_eq!(
        entry.keys().cloned().collect::<Vec<_>>(),
        [
            "pane_id",
            "session_id",
            "title",
            "suspended_at",
            "holder_pid",
            "job"
        ]
    );
    // Herdr's agent goes: the pane is a shell again.
    assert!(
        made.fake
            .calls()
            .contains(&vec!["releaseAgent".to_owned(), PANE.to_owned()])
    );
}

#[tokio::test(start_paused = true)]
async fn suspend_is_refused_by_a_holder_that_cannot_stop_as_a_job_the_session_kept() {
    let made = held(
        HolderShell {
            job_control: false,
            pid: None,
            job: None,
        },
        |_| {},
    )
    .await;
    let result = to_terminal(&made, Some(None)).await;
    assert_eq!(result["ok"], json!(false));
    assert!(
        result["reason"]
            .as_str()
            .unwrap()
            .contains("cannot stop as a shell job"),
        "{result:?}"
    );
    assert_eq!(made.service.state(PANE)["owner"], json!("conversation"));
    assert_eq!(made.spawner.alive().len(), 1);
    assert!(made.service.suspended_panes().is_empty());
}

#[tokio::test(start_paused = true)]
async fn the_suspend_rpc_takes_a_one_line_title_and_only_to_the_terminal() {
    let made = held(job(), |_| {}).await;
    handle_agent_chat_rpc(
        &made.service,
        1,
        "agent_chat.handover",
        &json!({"pane_id": PANE, "to": "terminal", "suspend": true, "title": "two\nlines\u{7}"}),
    )
    .await
    .unwrap();
    let reply = made.holders.poll(0).await;
    assert_eq!(reply["action"], json!("suspend"));
    assert_eq!(reply["title"], json!("two lines"));
}

#[tokio::test(start_paused = true)]
async fn fg_resumes_the_same_session_in_conversation_mode() {
    let made = held(job(), |_| {}).await;
    to_terminal(&made, Some(Some("t".into()))).await;
    shell_at_prompt(&made.fake);
    let reply = made
        .service
        .holder_fg(
            HolderSideInput {
                pane_id: PANE.into(),
                session_id: made.fake.session_id.clone(),
                status: None,
                shell: Some(job()),
                signal: None,
            },
            SuspendedSpec {
                session_id: made.fake.session_id.clone(),
                cwd: made.fake.cwd.clone(),
                ..SuspendedSpec::default()
            },
        )
        .await;
    assert_eq!(
        Value::Object(reply),
        json!({"action": "hold", "session_id": made.fake.session_id})
    );
    settle().await;
    let state = made.service.state(PANE);
    assert_eq!(state["owner"], json!("conversation"));
    assert_eq!(state["phase"], json!("conversation"));
    assert_eq!(state["session_id"], json!(made.fake.session_id));
    // The same session resumed, history and all.
    let starts: Vec<String> = made
        .spawner
        .spawned
        .lock()
        .unwrap()
        .iter()
        .map(|(options, _)| options.session_id.clone())
        .collect();
    assert_eq!(
        starts,
        [made.fake.session_id.clone(), made.fake.session_id.clone()]
    );
    assert_eq!(made.spawner.alive().len(), 1);
    assert!(made.service.suspended_panes().is_empty());
    assert_eq!(
        made.store.get(PANE).unwrap()["phase"],
        json!("conversation")
    );
    let reports = made.fake.with(|state| state.reports.clone());
    assert_eq!(
        reports.last().unwrap(),
        &("idle".to_owned(), made.fake.session_id.clone())
    );
}

#[tokio::test(start_paused = true)]
async fn fg_is_refused_while_another_claude_writes_the_session_and_the_job_stays() {
    let made = held(job(), |_| {}).await;
    to_terminal(&made, Some(None)).await;
    made.fake.with(|state| {
        state.probe.elsewhere = Some(writer_text("claude runs the session in pane w2:p1"))
    });
    let reply = made
        .service
        .holder_fg(
            HolderSideInput {
                pane_id: PANE.into(),
                session_id: made.fake.session_id.clone(),
                status: None,
                shell: None,
                signal: None,
            },
            SuspendedSpec {
                session_id: made.fake.session_id.clone(),
                cwd: made.fake.cwd.clone(),
                ..SuspendedSpec::default()
            },
        )
        .await;
    assert_eq!(reply["action"], json!("refused"));
    assert!(
        reply["reason"]
            .as_str()
            .unwrap()
            .contains("w2:p1; close it there first"),
        "{reply:?}"
    );
    assert_eq!(made.service.state(PANE)["owner"], json!("terminal"));
    assert_eq!(made.service.suspended_panes().len(), 1);
}

#[tokio::test(start_paused = true)]
async fn the_pages_fg_names_the_stopped_job_never_the_shells_current_one() {
    let made = held(job(), |_| {}).await;
    to_terminal(&made, Some(None)).await;
    shell_at_prompt(&made.fake);
    assert_eq!(made.service.foreground(PANE).await, json!({"ok": true}));
    assert!(typed(&made.fake).contains(&vec![
        "sendText".to_owned(),
        PANE.to_owned(),
        format!(" fg '%?{}'\r", job().job.unwrap()),
    ]));
}

#[tokio::test(start_paused = true)]
async fn the_pages_fg_waits_for_the_shells_prompt_and_needs_a_stopped_conversation() {
    let made = held(job(), |_| {}).await;
    assert_eq!(
        made.service.foreground(PANE).await,
        json!({"ok": false, "reason": "No conversation is stopped in this pane"})
    );
    to_terminal(&made, Some(None)).await;
    // Something else runs in the pane (vim, a build): fg is not typed.
    made.fake.with(|state| {
        state.pane.process = PaneProcessInfo {
            shell_pid: Some(800.0),
            foreground_process_group_id: Some(960.0),
            foreground_processes: vec![PaneProcess {
                pid: 960,
                argv: Some(vec!["vim".into()]),
                ..PaneProcess::default()
            }],
        };
    });
    let refused = made.service.foreground(PANE).await;
    assert_eq!(refused["ok"], json!(false));
    assert!(
        refused["reason"]
            .as_str()
            .unwrap()
            .contains("Something runs in the pane's terminal")
    );
    assert!(!typed(&made.fake).iter().any(|call| call[2].contains("fg")));
}

#[tokio::test(start_paused = true)]
async fn a_stopped_job_whose_holder_is_gone_is_forgotten() {
    let changed: Arc<Mutex<Vec<String>>> = Arc::default();
    let sink = changed.clone();
    let made = held(job(), move |options| {
        options.suspended_watch_ms = 5;
        options.on_lease_changed = Some(Arc::new(move |pane: &str| {
            sink.lock().unwrap().push(pane.to_owned())
        }));
    })
    .await;
    made.fake.with(|state| state.live.insert(4321));
    to_terminal(&made, Some(None)).await;
    tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    assert_eq!(made.service.suspended_panes().len(), 1);
    // `kill %1`: the holder is gone, and the browsers are told.
    made.fake.with(|state| state.live.remove(&4321));
    changed.lock().unwrap().clear();
    for _ in 0..100 {
        if made.service.suspended_panes().is_empty() {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        settle().await;
    }
    assert!(made.service.suspended_panes().is_empty());
    assert!(changed.lock().unwrap().contains(&PANE.to_owned()));
}
