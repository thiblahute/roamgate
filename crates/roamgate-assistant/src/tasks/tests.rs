//! tasks.test.ts, case for case. Bun's fake timers are the test clock of
//! roamgate-base (time moves only on `advance`), and `flush` yields to the
//! single-threaded runtime as the TS awaited resolved promises.

use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

use roamgate_base::clock::{Clock, TestClock};
use roamgate_base::paths::Platform;
use tokio::sync::Notify;

use super::*;
use crate::wire::{ASSISTANT_MAX_MENTIONS, is_hex64};

const START: &str = "2026-10-04T00:00:00Z";

pub(super) async fn flush() {
    for _ in 0..30 {
        tokio::task::yield_now().await;
    }
}

/// A gate a child waits on (`Promise.withResolvers`).
#[derive(Default)]
pub(super) struct Gate {
    open: AtomicBool,
    notify: Notify,
}

impl Gate {
    pub(super) fn open(&self) {
        self.open.store(true, Ordering::SeqCst);
        self.notify.notify_waiters();
    }

    pub(super) async fn wait(&self) {
        loop {
            let notified = self.notify.notified();
            if self.open.load(Ordering::SeqCst) {
                return;
            }
            notified.await;
        }
    }
}

/// What the fixture's child saw.
pub(super) struct Observed {
    pub run: Value,
    pub directory: PathBuf,
    pub recover: Mutex<Option<bool>>,
    pub resumes: AtomicUsize,
    pub stopped: AtomicBool,
    pub disposing: AtomicBool,
    pub disposed: AtomicBool,
    pub dispose_calls: AtomicUsize,
    pub stop_gate: Mutex<Option<Arc<Gate>>>,
    pub dispose_gate: Mutex<Option<Arc<Gate>>>,
    pub dispose_failure: AtomicBool,
    snapshot: Mutex<Value>,
    publish: Publish,
    clock: SharedClock,
}

impl Observed {
    /// The run's model turn ends, with a pending action or an error.
    pub(super) fn complete(&self, pending: bool, error: Option<&str>) {
        let snapshot = {
            let mut snapshot = self.snapshot.lock().unwrap();
            snapshot["running"] = json!(false);
            snapshot["error"] = error.map_or(Value::Null, |e| json!(e));
            let now = js::iso(self.clock.now() as f64);
            let actions = if pending {
                let mut action = self.run["workspaces"][0].clone();
                for (key, value) in [
                    ("workspace_label", json!("Workspace")),
                    ("id", json!("action")),
                    ("kind", json!("send_prompt")),
                    ("status", json!("pending")),
                    ("created_at", json!(now)),
                    ("params", json!({})),
                    ("summary", json!("Review")),
                    ("detail", json!("Waiting")),
                ] {
                    action[key] = value;
                }
                json!([action])
            } else {
                json!([])
            };
            snapshot["messages"] = json!([{
                "id": "answer", "role": "assistant", "text": "Verified", "sent_at": now,
                "tools": [], "sources": [], "actions": actions,
            }]);
            snapshot.clone()
        };
        (self.publish)(snapshot);
    }

    pub(super) fn id(&self) -> &str {
        self.run["id"].as_str().unwrap()
    }
}

/// A shared clock on a test's JestClock.
struct ClockRef(&'static JestClock);

impl Clock for ClockRef {
    fn now(&self) -> i64 {
        self.0.now()
    }

    fn monotonic(&self) -> f64 {
        self.0.monotonic()
    }

    fn sleep_until(&self, deadline: i64) -> BoxFuture<()> {
        self.0.sleep_until(deadline)
    }

    fn sleep(&self, duration: std::time::Duration) -> BoxFuture<()> {
        self.0.sleep(duration)
    }

    fn interval(&self, period: std::time::Duration) -> roamgate_base::clock::Interval {
        self.0.interval(period)
    }
}

pub(super) type Validation =
    Arc<dyn Fn(CancellationToken, Value) -> BoxFuture<AssistantResult<()>> + Send + Sync>;

pub(super) struct Fixture {
    pub directory: PathBuf,
    pub context: DataContext,
    pub manager: AssistantTasks,
    pub runs: Arc<Mutex<Vec<Arc<Observed>>>>,
    pub notifications: Arc<Mutex<Vec<Value>>>,
    pub clock: &'static JestClock,
    deny: Arc<AtomicBool>,
    start_failure: Arc<AtomicBool>,
    home: Option<Arc<tempfile::TempDir>>,
}

struct ChildImpl {
    observed: Arc<Observed>,
    database: PathBuf,
    start_failure: Arc<AtomicBool>,
}

impl ScheduledChild for ChildImpl {
    fn start(&self, recover: bool) -> BoxFuture<AssistantResult<()>> {
        let observed = self.observed.clone();
        let database = self.database.clone();
        let failure = self.start_failure.load(Ordering::SeqCst);
        Box::pin(async move {
            *observed.recover.lock().unwrap() = Some(recover);
            let db = rusqlite::Connection::open_with_flags(
                &database,
                rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
            )
            .unwrap();
            let status: Option<String> = db
                .query_row(
                    "SELECT status FROM runs WHERE id = ?",
                    [observed.id()],
                    |row| row.get(0),
                )
                .ok();
            assert_eq!(status.as_deref(), Some("running"));
            if failure {
                return Err(internal("Private child startup error"));
            }
            let snapshot = {
                let mut snapshot = observed.snapshot.lock().unwrap();
                snapshot["running"] = json!(true);
                snapshot.clone()
            };
            (observed.publish)(snapshot);
            Ok(())
        })
    }

    fn resume(&self) -> BoxFuture<AssistantResult<()>> {
        self.observed.resumes.fetch_add(1, Ordering::SeqCst);
        Box::pin(async { Ok(()) })
    }

    fn stop(&self) -> BoxFuture<AssistantResult<()>> {
        let observed = self.observed.clone();
        Box::pin(async move {
            let gate = observed.stop_gate.lock().unwrap().clone();
            if let Some(gate) = gate {
                gate.wait().await;
            }
            observed.stopped.store(true, Ordering::SeqCst);
            let snapshot = {
                let mut snapshot = observed.snapshot.lock().unwrap();
                snapshot["running"] = json!(false);
                snapshot.clone()
            };
            (observed.publish)(snapshot);
            Ok(())
        })
    }

    fn action(&self, _method: &str, _action_id: &str) -> BoxFuture<AssistantResult<()>> {
        let observed = self.observed.clone();
        Box::pin(async move {
            let snapshot = {
                let mut snapshot = observed.snapshot.lock().unwrap();
                for message in snapshot["messages"].as_array_mut().into_iter().flatten() {
                    for action in message["actions"].as_array_mut().into_iter().flatten() {
                        action["status"] = json!("cancelled");
                    }
                }
                snapshot.clone()
            };
            (observed.publish)(snapshot);
            Ok(())
        })
    }

    fn snapshot(&self) -> Value {
        self.observed.snapshot.lock().unwrap().clone()
    }

    fn dispose(&self) -> BoxFuture<AssistantResult<()>> {
        let observed = self.observed.clone();
        Box::pin(async move {
            observed.dispose_calls.fetch_add(1, Ordering::SeqCst);
            observed.disposing.store(true, Ordering::SeqCst);
            let gate = observed.dispose_gate.lock().unwrap().clone();
            if let Some(gate) = gate {
                gate.wait().await;
            }
            if observed.dispose_failure.load(Ordering::SeqCst) {
                return Err(internal("Synthetic disposal failure"));
            }
            observed.disposed.store(true, Ordering::SeqCst);
            Ok(())
        })
    }
}

#[derive(Default)]
pub(super) struct FixtureOptions {
    pub existing: Option<(PathBuf, DataContext, &'static JestClock)>,
    pub validation: Option<Validation>,
    pub notify: Option<Arc<dyn Fn(&Value) -> Result<(), String> + Send + Sync>>,
    pub rescope: Option<Rescope>,
    pub narrow: Option<Narrow>,
    pub validate_cleanup: Option<Validate>,
}

/// Bun's fake timers: the test clock, where a timer already due waits for
/// the next `advance` as `setTimeout(fn, 0)` waits for
/// `advanceTimersByTime(0)`, where the test clock fires it at once.
pub(super) struct JestClock {
    clock: TestClock,
    /// The advances so far, and their signal.
    advances: Arc<(Notify, AtomicUsize)>,
}

impl JestClock {
    pub(super) async fn advance(&self, ms: u64) {
        self.advances.1.fetch_add(1, Ordering::SeqCst);
        self.advances.0.notify_waiters();
        self.clock.advance(ms).await;
    }
}

impl Clock for JestClock {
    fn now(&self) -> i64 {
        self.clock.now()
    }

    fn monotonic(&self) -> f64 {
        self.clock.monotonic()
    }

    fn sleep_until(&self, deadline: i64) -> BoxFuture<()> {
        if deadline > self.clock.now() {
            return self.clock.sleep_until(deadline);
        }
        let advances = self.advances.clone();
        let seen = advances.1.load(Ordering::SeqCst);
        Box::pin(async move {
            loop {
                let notified = advances.0.notified();
                if advances.1.load(Ordering::SeqCst) != seen {
                    return;
                }
                notified.await;
            }
        })
    }

    fn sleep(&self, duration: std::time::Duration) -> BoxFuture<()> {
        self.sleep_until(self.now() + duration.as_millis() as i64)
    }

    fn interval(&self, period: std::time::Duration) -> roamgate_base::clock::Interval {
        self.clock.interval(period)
    }
}

/// A test's clock, kept for the whole test (managers outlive their tasks).
pub(super) fn clock_at(iso: &str) -> &'static JestClock {
    Box::leak(Box::new(JestClock {
        clock: TestClock::new(js::date_parse(iso) as i64),
        advances: Arc::default(),
    }))
}

pub(super) fn fixture_with(options: FixtureOptions) -> Fixture {
    let (directory, context, clock, home) = match options.existing {
        Some((directory, context, clock)) => (directory, context, clock, None),
        None => {
            let home = Arc::new(tempfile::tempdir().unwrap());
            let context = DataContext::new(home.path(), Platform::Unix, None);
            let directory = home.path().join("assistant");
            (directory, context, clock_at(START), Some(home))
        }
    };
    let runs: Arc<Mutex<Vec<Arc<Observed>>>> = Arc::default();
    let notifications: Arc<Mutex<Vec<Value>>> = Arc::default();
    let deny = Arc::new(AtomicBool::new(false));
    let start_failure = Arc::new(AtomicBool::new(false));
    let validate: Validate = {
        let deny = deny.clone();
        let hook = options.validation.clone();
        Arc::new(move |prepared, signal| {
            let deny = deny.load(Ordering::SeqCst);
            let hook = hook.clone();
            Box::pin(async move {
                if deny {
                    return Err(user("Original identity replaced"));
                }
                if let Some(hook) = hook {
                    hook(signal, prepared).await?;
                }
                Ok(())
            })
        })
    };
    let notify = {
        let notifications = notifications.clone();
        let hook = options.notify.clone();
        Arc::new(move |notification: Value| {
            notifications.lock().unwrap().push(notification.clone());
            match &hook {
                Some(hook) => hook(&notification),
                None => Ok(()),
            }
        }) as Arc<dyn Fn(Value) -> Result<(), String> + Send + Sync>
    };
    let child: MakeChild = {
        let runs = runs.clone();
        let database = directory.join("tasks.sqlite");
        let start_failure = start_failure.clone();
        let clock: SharedClock = Arc::new(ClockRef(clock));
        Arc::new(move |run, path, publish, _before| {
            let snapshot = json!({
                "instance_id": "child", "revision": 0, "config": run["config"],
                "providers": [], "models": [], "messages": [], "running": false,
                "auth": null, "error": null,
            });
            let observed = Arc::new(Observed {
                run,
                directory: path,
                recover: Mutex::new(None),
                resumes: AtomicUsize::new(0),
                stopped: AtomicBool::new(false),
                disposing: AtomicBool::new(false),
                disposed: AtomicBool::new(false),
                dispose_calls: AtomicUsize::new(0),
                stop_gate: Mutex::new(None),
                dispose_gate: Mutex::new(None),
                dispose_failure: AtomicBool::new(false),
                snapshot: Mutex::new(snapshot),
                publish,
                clock: clock.clone(),
            });
            runs.lock().unwrap().push(observed.clone());
            Arc::new(ChildImpl {
                observed,
                database: database.clone(),
                start_failure: start_failure.clone(),
            }) as Arc<dyn ScheduledChild>
        })
    };
    let manager = AssistantTasks::new(TaskOptions {
        directory: directory.clone(),
        context: context.clone(),
        clock: Arc::new(ClockRef(clock)),
        publish: Arc::new(|| {}),
        notify: Some(notify),
        validate,
        validate_cleanup: options.validate_cleanup,
        rescope: options.rescope,
        narrow: options.narrow,
        child,
    });
    Fixture {
        directory,
        context,
        manager,
        runs,
        notifications,
        clock,
        deny,
        start_failure,
        home,
    }
}

pub(super) fn fixture() -> Fixture {
    fixture_with(FixtureOptions::default())
}

impl Fixture {
    /// Another manager on the same directory (a restart).
    pub(super) fn restart(&self) -> Fixture {
        self.restart_with(FixtureOptions::default())
    }

    pub(super) fn restart_with(&self, mut options: FixtureOptions) -> Fixture {
        options.existing = Some((self.directory.clone(), self.context.clone(), self.clock));
        let mut restored = fixture_with(options);
        restored.home = self.home.clone();
        restored
    }

    pub(super) fn fail(&self, value: bool) {
        let db = rusqlite::Connection::open(self.directory.join("tasks.sqlite")).unwrap();
        db.execute_batch(if value {
            "CREATE TRIGGER fail_save BEFORE INSERT ON tasks BEGIN SELECT RAISE(ABORT, 'Synthetic write failure'); END"
        } else {
            "DROP TRIGGER fail_save"
        })
        .unwrap();
    }

    pub(super) fn deny(&self, value: bool) {
        self.deny.store(value, Ordering::SeqCst);
    }

    pub(super) fn fail_start(&self) {
        self.start_failure.store(true, Ordering::SeqCst);
    }

    pub(super) fn run(&self, index: usize) -> Arc<Observed> {
        self.runs.lock().unwrap()[index].clone()
    }

    pub(super) fn last_run(&self) -> Arc<Observed> {
        self.runs.lock().unwrap().last().unwrap().clone()
    }

    pub(super) fn run_count(&self) -> usize {
        self.runs.lock().unwrap().len()
    }

    pub(super) fn notifications(&self) -> Vec<Value> {
        self.notifications.lock().unwrap().clone()
    }

    pub(super) async fn advance(&self, ms: u64) {
        self.clock.advance(ms).await;
        flush().await;
    }
}

pub(super) async fn start_run(f: &Fixture, task_id: &str) -> Arc<Observed> {
    f.manager.control("run_now", task_id).await.unwrap();
    f.advance(0).await;
    f.last_run()
}

pub(super) fn custom_notification(event_key: &str) -> Value {
    json!({
        "event_key": event_key,
        "kind": "completed",
        "title": "Agent finished the requested work",
        "body": "The tests passed. Open Ranger to review the evidence.",
    })
}

pub(super) fn agent_mention() -> Value {
    json!({
        "kind": "agent",
        "connection_id": "local",
        "workspace_id": "workspace",
        "connection_label": "Local",
        "workspace_label": "Workspace",
        "label": "Codex session",
        "runtime_generation": 1,
        "pane_id": "pane",
        "terminal_id": "terminal",
        "agent": "codex",
        "agent_identity": "c".repeat(64),
    })
}

pub(super) fn prepared_with(schedule: Value) -> Value {
    json!({
        "input": {
            "title": "Check workspace",
            "prompt": "Report verified progress",
            "scope": [{"connection_id": "local", "workspace_id": "workspace"}],
            "schedule": schedule,
        },
        "config": {
            "provider": "test",
            "model": "model",
            "credential_source": "assistant",
            "allowed_workspaces": [{"connection_id": "local", "workspace_id": "workspace"}],
        },
        "workspaces": [{
            "connection_id": "local",
            "workspace_id": "workspace",
            "connection_label": "Local",
            "label": "Workspace",
            "runtime_generation": 1,
        }],
        "targets": [{
            "connection_id": "local",
            "workspace_id": "workspace",
            "endpoint_fingerprint": "a".repeat(64),
            "workspace_identity": "b".repeat(64),
            "herdr_boot_id": "original-server",
        }],
    })
}

pub(super) fn prepared() -> Value {
    prepared_with(json!({"type": "interval", "minutes": 1}))
}

pub(super) fn uuid() -> String {
    random_uuid()
}

pub(super) fn merge(base: &Value, extra: Value) -> Value {
    let mut map = base.as_object().unwrap().clone();
    for (key, value) in extra.as_object().unwrap() {
        map.insert(key.clone(), value.clone());
    }
    Value::Object(map)
}

/// `toEqual`: the same values whatever the key order.
pub(super) fn same(a: &Value, b: &Value) -> bool {
    match (a, b) {
        (Value::Object(x), Value::Object(y)) => {
            x.len() == y.len() && x.iter().all(|(k, v)| y.get(k).is_some_and(|w| same(v, w)))
        }
        (Value::Array(x), Value::Array(y)) => {
            x.len() == y.len() && x.iter().zip(y).all(|(v, w)| same(v, w))
        }
        (Value::Number(x), Value::Number(y)) => x.as_f64() == y.as_f64(),
        _ => a == b,
    }
}

macro_rules! assert_same {
    ($a:expr, $b:expr) => {{
        let (a, b) = (&$a, &$b);
        assert!(same(a, b), "left: {a:#}\nright: {b:#}");
    }};
}

pub(super) fn text_json(result: &ToolResult) -> Value {
    serde_json::from_str(&result.text).unwrap()
}

pub(super) async fn create(f: &Fixture, prepared: &Value) -> String {
    let task = f.manager.create(prepared, &uuid()).await.unwrap();
    task["id"].as_str().unwrap().to_owned()
}

#[tokio::test(flavor = "current_thread")]
async fn custom_task_notifications_persist_before_dispatch_deduplicate_across_runs_and_restart_and_cap_each_run()
 {
    let accepted: Arc<Mutex<Vec<Value>>> = Arc::default();
    let seen = accepted.clone();
    let probe: Arc<Mutex<Option<(PathBuf, DataContext)>>> = Arc::default();
    let at = probe.clone();
    let f = fixture_with(FixtureOptions {
        notify: Some(Arc::new(move |_| {
            let (directory, context) = at.lock().unwrap().clone().unwrap();
            let storage = TaskStorage::open(&context, &directory).unwrap();
            *seen.lock().unwrap() = storage.load().unwrap()["tasks"][0]["notifications"]
                .as_array()
                .cloned()
                .unwrap_or_default();
            Ok(())
        })),
        ..FixtureOptions::default()
    });
    *probe.lock().unwrap() = Some((f.directory.clone(), f.context.clone()));
    let id = create(&f, &prepared()).await;
    f.manager.resume().await;
    let first = start_run(&f, &id).await;
    let result = f
        .manager
        .notify_run(
            &id,
            first.id(),
            &custom_notification("agent-work-1:completed"),
            None,
        )
        .await
        .unwrap();
    assert_eq!(
        text_json(&result),
        json!({"accepted": true, "delivery": "best_effort"})
    );
    let receipts = accepted.lock().unwrap().clone();
    assert_eq!(receipts.len(), 1);
    assert!(is_hex64(receipts[0]["scope_key"].as_str().unwrap()));
    assert_eq!(receipts[0]["run_id"], first.id());
    assert!(js::date_parse(receipts[0]["created_at"].as_str().unwrap()).is_finite());
    assert_eq!(
        f.notifications(),
        vec![json!({
            "task_id": id, "run_id": first.id(), "status": "succeeded",
            "title": "Agent finished the requested work",
            "body": "The tests passed. Open Ranger to review the evidence.",
        })]
    );
    let again = f
        .manager
        .notify_run(
            &id,
            first.id(),
            &custom_notification("agent-work-1:completed"),
            None,
        )
        .await
        .unwrap();
    assert_eq!(
        text_json(&again),
        json!({"accepted": false, "reason": "already_notified"})
    );
    let other = f
        .manager
        .notify_run(&id, first.id(), &custom_notification("another-event"), None)
        .await
        .unwrap();
    assert_eq!(
        text_json(&other),
        json!({"accepted": false, "reason": "run_limit"})
    );
    first.complete(false, None);
    assert_eq!(f.notifications().len(), 1);
    f.manager.dispose().await;

    let restored = f.restart();
    restored.manager.resume().await;
    let second = start_run(&restored, &id).await;
    let result = restored
        .manager
        .notify_run(
            &id,
            second.id(),
            &custom_notification("agent-work-1:completed"),
            None,
        )
        .await
        .unwrap();
    assert_eq!(
        text_json(&result),
        json!({"accepted": false, "reason": "already_notified"})
    );
    let mut attention = custom_notification("agent-work-2:attention");
    attention["kind"] = json!("attention");
    let result = restored
        .manager
        .notify_run(&id, second.id(), &attention, None)
        .await
        .unwrap();
    assert_eq!(
        text_json(&result),
        json!({"accepted": true, "delivery": "best_effort"})
    );
    assert_eq!(
        restored.notifications(),
        vec![json!({
            "task_id": id, "run_id": second.id(), "status": "waiting",
            "title": attention["title"], "body": attention["body"],
        })]
    );
    let mut history = restored.manager.notification_history(&id, None).unwrap();
    assert_eq!(history.len(), 2);
    history[0]["event_key"] = json!("modified");
    assert_eq!(
        restored.manager.notification_history(&id, None).unwrap()[0]["event_key"],
        "agent-work-1:completed"
    );
    restored.manager.dispose().await;
}

fn statuses(f: &Fixture) -> Vec<String> {
    f.notifications()
        .iter()
        .map(|n| n["status"].as_str().unwrap().to_owned())
        .collect()
}

#[tokio::test(flavor = "current_thread")]
async fn agent_notification_mode_keeps_successful_polls_quiet_and_retains_failure_and_confirmation_alerts()
 {
    let f = fixture();
    let mut input = prepared();
    input["input"]["notification_mode"] = json!("agent");
    let id = create(&f, &input).await;
    f.manager.resume().await;
    let first = start_run(&f, &id).await;
    input["input"]["notification_mode"] = json!("status");
    f.manager.update(&id, &input, None).await.unwrap();
    first.complete(false, None);
    assert!(f.notifications().is_empty());
    let second = start_run(&f, &id).await;
    second.complete(false, None);
    assert_eq!(statuses(&f), ["succeeded"]);
    input["input"]["notification_mode"] = json!("agent");
    f.manager.update(&id, &input, None).await.unwrap();
    let failed = start_run(&f, &id).await;
    failed.complete(false, Some("Model unavailable"));
    let waiting = start_run(&f, &id).await;
    waiting.complete(true, None);
    assert_eq!(statuses(&f), ["succeeded", "failed", "waiting"]);
    f.manager.dispose().await;
}

pub(super) fn set_workspace(prepared: &mut Value, workspace: &str) {
    prepared["input"]["scope"][0]["workspace_id"] = json!(workspace);
    prepared["config"]["allowed_workspaces"][0]["workspace_id"] = json!(workspace);
    prepared["workspaces"][0]["workspace_id"] = json!(workspace);
    prepared["targets"][0]["workspace_id"] = json!(workspace);
}

#[tokio::test(flavor = "current_thread")]
async fn scope_changes_isolate_notification_history_and_event_deduplication_while_a_running_task_keeps_its_original_scope()
 {
    let f = fixture();
    let id = create(&f, &prepared()).await;
    f.manager.resume().await;
    let first = start_run(&f, &id).await;
    f.manager
        .notify_run(
            &id,
            first.id(),
            &custom_notification("agent-work-1:completed"),
            None,
        )
        .await
        .unwrap();
    let mut replacement = prepared();
    set_workspace(&mut replacement, "other-workspace");
    replacement["targets"][0]["workspace_identity"] = json!("c".repeat(64));
    f.manager.update(&id, &replacement, None).await.unwrap();
    assert!(
        f.manager
            .notification_history(&id, None)
            .unwrap()
            .is_empty()
    );
    assert_eq!(
        f.manager
            .notification_history(&id, Some(first.id()))
            .unwrap()
            .len(),
        1
    );
    first.complete(false, None);
    let second = start_run(&f, &id).await;
    let result = f
        .manager
        .notify_run(
            &id,
            second.id(),
            &custom_notification("agent-work-1:completed"),
            None,
        )
        .await
        .unwrap();
    assert_eq!(text_json(&result)["accepted"], true);
    assert_eq!(
        f.manager
            .notification_history(&id, Some(second.id()))
            .unwrap(),
        f.manager.notification_history(&id, None).unwrap()
    );
    assert_eq!(
        f.manager.notification_history(&id, None).unwrap()[0]["run_id"],
        second.id()
    );
    assert_eq!(f.notifications().len(), 2);
    f.manager.dispose().await;
    let restored = f.restart();
    assert_eq!(
        restored
            .manager
            .notification_history(&id, None)
            .unwrap()
            .len(),
        1
    );
}

#[tokio::test(flavor = "current_thread")]
async fn notification_history_retains_the_latest_100_events_independently_of_pruned_runs() {
    let f = fixture();
    let id = create(&f, &prepared()).await;
    f.manager.resume().await;
    for index in 0..101 {
        let run = start_run(&f, &id).await;
        f.manager
            .notify_run(
                &id,
                run.id(),
                &custom_notification(&format!("work-{index}")),
                None,
            )
            .await
            .unwrap();
        run.complete(false, None);
        flush().await;
    }
    assert_eq!(
        f.manager.detail(&id, None).unwrap()["runs"]
            .as_array()
            .unwrap()
            .len(),
        20
    );
    let history = f.manager.notification_history(&id, None).unwrap();
    assert_eq!(history.len(), 100);
    assert_eq!(history[0]["event_key"], "work-1");
    assert_eq!(history[99]["event_key"], "work-100");
    f.manager.dispose().await;
    assert_eq!(
        f.restart().manager.notification_history(&id, None).unwrap(),
        history
    );
}

#[tokio::test(flavor = "current_thread")]
async fn custom_notification_save_failures_do_not_emit_and_delivery_failures_keep_a_non_replayable_receipt()
 {
    let f = fixture_with(FixtureOptions {
        notify: Some(Arc::new(|_| Err("Delivery failed".into()))),
        ..FixtureOptions::default()
    });
    let id = create(&f, &prepared()).await;
    f.manager.resume().await;
    let run = start_run(&f, &id).await;
    f.fail(true);
    let error = f
        .manager
        .notify_run(
            &id,
            run.id(),
            &custom_notification("agent-work-1:completed"),
            None,
        )
        .await
        .unwrap_err();
    assert!(error.to_string().contains("could not be saved"));
    assert!(f.notifications().is_empty());
    assert!(
        f.manager
            .notification_history(&id, None)
            .unwrap()
            .is_empty()
    );
    f.fail(false);
    let result = f
        .manager
        .notify_run(
            &id,
            run.id(),
            &custom_notification("agent-work-1:completed"),
            None,
        )
        .await
        .unwrap();
    assert_eq!(
        text_json(&result),
        json!({"accepted": true, "delivery": "best_effort"})
    );
    assert_eq!(f.notifications().len(), 1);
    assert_eq!(f.manager.notification_history(&id, None).unwrap().len(), 1);
    let again = f
        .manager
        .notify_run(
            &id,
            run.id(),
            &custom_notification("agent-work-1:completed"),
            None,
        )
        .await
        .unwrap();
    assert_eq!(
        text_json(&again),
        json!({"accepted": false, "reason": "already_notified"})
    );
    f.manager.dispose().await;
}

#[tokio::test(flavor = "current_thread")]
async fn during_a_notification_permission_check_cannot_emit_an_alert() {
    for operation in ["stop", "cancel", "revoke", "complete", "abort"] {
        let block = Arc::new(AtomicBool::new(false));
        let revoked = Arc::new(AtomicBool::new(false));
        let began = Arc::new(Gate::default());
        let checked = Arc::new(Gate::default());
        let validation: Validation = {
            let (block, revoked, began, checked) = (
                block.clone(),
                revoked.clone(),
                began.clone(),
                checked.clone(),
            );
            Arc::new(move |_, _| {
                let (block, revoked, began, checked) = (
                    block.clone(),
                    revoked.clone(),
                    began.clone(),
                    checked.clone(),
                );
                Box::pin(async move {
                    if !block.load(Ordering::SeqCst) {
                        return Ok(());
                    }
                    began.open();
                    checked.wait().await;
                    if revoked.load(Ordering::SeqCst) {
                        return Err(internal("Permission revoked"));
                    }
                    Ok(())
                })
            })
        };
        let f = fixture_with(FixtureOptions {
            validation: Some(validation),
            ..FixtureOptions::default()
        });
        let id = create(&f, &prepared()).await;
        f.manager.resume().await;
        let run = start_run(&f, &id).await;
        block.store(true, Ordering::SeqCst);
        let abort = CancellationToken::new();
        let sending = {
            let manager = f.manager.clone();
            let (id, run_id, abort) = (id.clone(), run.id().to_owned(), abort.clone());
            tokio::spawn(async move {
                manager
                    .notify_run(
                        &id,
                        &run_id,
                        &custom_notification("agent-work-1:completed"),
                        Some(abort),
                    )
                    .await
            })
        };
        began.wait().await;
        match operation {
            "stop" | "cancel" => f.manager.control(operation, &id).await.unwrap(),
            "complete" => run.complete(false, None),
            "abort" => abort.cancel(),
            _ => revoked.store(true, Ordering::SeqCst),
        }
        checked.open();
        assert!(sending.await.unwrap().is_err(), "{operation}");
        assert!(
            f.manager
                .notification_history(&id, None)
                .unwrap()
                .is_empty()
        );
        assert!(
            !f.notifications()
                .iter()
                .any(|n| n["title"] == "Agent finished the requested work"),
            "{operation}"
        );
        f.manager.dispose().await;
    }
}

fn saved_state(notification: &Value) -> Value {
    let now = "2026-10-04T00:00:00.000Z";
    let mut entry = prepared();
    entry["task"] = json!({
        "id": uuid(), "status": "active", "created_at": now, "updated_at": now, "next_run_at": now,
    });
    entry["runs"] = json!([]);
    entry["notifications"] = json!([notification]);
    json!({"tasks": [entry], "proposals": [], "requests": []})
}

#[test]
fn task_inputs_and_saved_notification_history_reject_invalid_modes_and_receipts() {
    let input = prepared()["input"].clone();
    assert_same!(validate_task_input(&input).unwrap(), input);
    let agent = validate_task_input(&merge(&input, json!({"notification_mode": "agent"}))).unwrap();
    assert_eq!(agent["notification_mode"], "agent");
    let quiet = validate_task_input(&merge(&input, json!({"notification_mode": "quiet"})));
    assert_eq!(quiet.unwrap_err().to_string(), "Invalid task input");
    let mut notification = custom_notification("agent-work-1:completed");
    notification["scope_key"] = json!("a".repeat(64));
    notification["run_id"] = json!(uuid());
    notification["created_at"] = json!("2026-10-04T00:00:00.000Z");
    let saved = saved_state(&notification);
    crate::saved::validate_saved_tasks(&saved).unwrap();
    for change in [
        json!({"event_key": " "}),
        json!({"event_key": "x".repeat(201)}),
        json!({"title": "x".repeat(201)}),
        json!({"body": ""}),
        json!({"body": "x".repeat(401)}),
        json!({"kind": "failed"}),
        json!({"run_id": "invalid"}),
        json!({"created_at": "invalid"}),
        json!({"scope_key": "invalid"}),
    ] {
        let mut bad = saved.clone();
        bad["tasks"][0]["notifications"] = json!([merge(&notification, change.clone())]);
        assert_eq!(
            crate::saved::validate_saved_tasks(&bad).unwrap_err(),
            "Invalid saved tasks",
            "{change}"
        );
    }
    let mut twice = saved.clone();
    twice["tasks"][0]["notifications"] = json!([notification, notification]);
    assert_eq!(
        crate::saved::validate_saved_tasks(&twice).unwrap_err(),
        "Invalid saved tasks"
    );
    let mut many = saved.clone();
    many["tasks"][0]["notifications"] = Value::Array(
        (0..101)
            .map(|index| merge(&notification, json!({"event_key": index.to_string()})))
            .collect(),
    );
    assert_eq!(
        crate::saved::validate_saved_tasks(&many).unwrap_err(),
        "Invalid saved tasks"
    );
}

#[test]
fn task_mentions_retain_bounded_identities_within_scope_and_reject_duplicates() {
    let input = prepared()["input"].clone();
    let agent = agent_mention();
    let workspace = json!({
        "kind": "workspace", "connection_id": "local", "workspace_id": "workspace",
        "connection_label": "Local", "workspace_label": "Workspace", "label": "Workspace",
        "runtime_generation": 1,
    });
    let with = |mentions: Value| validate_task_input(&merge(&input, json!({"mentions": mentions})));
    assert_eq!(with(json!([])).unwrap()["mentions"], json!([]));
    assert_same!(
        with(json!([workspace, agent])).unwrap()["mentions"],
        json!([workspace, agent])
    );
    let mentions: Vec<Value> = (0..ASSISTANT_MAX_MENTIONS)
        .map(|index| merge(&agent, json!({"pane_id": format!("pane-{index}")})))
        .collect();
    assert_eq!(
        with(json!(mentions)).unwrap()["mentions"]
            .as_array()
            .unwrap()
            .len(),
        ASSISTANT_MAX_MENTIONS
    );
    let mut overflow = mentions.clone();
    overflow.push(merge(&agent, json!({"pane_id": "overflow"})));
    for invalid in [
        json!(null),
        json!({}),
        json!([merge(&agent, json!({"agent_identity": "invalid"}))]),
        json!(overflow),
    ] {
        assert_eq!(
            with(invalid).unwrap_err().to_string(),
            "Invalid task mentions"
        );
    }
    for duplicate in [
        json!([workspace, merge(&workspace, json!({"label": "Renamed"}))]),
        json!([
            agent,
            merge(&agent, json!({"agent_identity": "d".repeat(64)}))
        ]),
    ] {
        assert_eq!(
            with(duplicate).unwrap_err().to_string(),
            "Duplicate task mention"
        );
    }
    assert_eq!(
        with(json!([merge(&agent, json!({"workspace_id": "other"}))]))
            .unwrap_err()
            .to_string(),
        "Task mention outside task scope"
    );
}

#[tokio::test(flavor = "current_thread")]
async fn task_proposals_plans_and_admitted_runs_preserve_session_bindings_across_restart_and_edits()
{
    let f = fixture();
    let mut input = prepared();
    input["input"]["mentions"] = json!([agent_mention()]);
    let proposal = f.manager.propose(&input, None).await.unwrap();
    f.manager.dispose().await;
    let restored = f.restart();
    let id = proposal["id"].as_str().unwrap();
    assert_same!(
        restored.manager.proposal(id).unwrap()["mentions"],
        proposal["mentions"]
    );
    restored.manager.confirm_proposal(id, None).await.unwrap();
    let task = restored.manager.summaries()[0].clone();
    let task_id = task["id"].as_str().unwrap();
    assert_same!(task["mentions"], proposal["mentions"]);
    restored.manager.resume().await;
    let admitted = start_run(&restored, task_id).await;
    assert_same!(admitted.run["input"]["mentions"], proposal["mentions"]);
    let mut replacement = prepared();
    replacement["input"]["mentions"] =
        json!([merge(&agent_mention(), json!({"pane_id": "another-pane"}))]);
    restored
        .manager
        .update(task_id, &replacement, None)
        .await
        .unwrap();
    assert_same!(admitted.run["input"]["mentions"], proposal["mentions"]);
    restored.manager.dispose().await;
    let recovered = restored.restart();
    assert_same!(
        recovered.manager.summaries()[0]["mentions"],
        replacement["input"]["mentions"]
    );
    recovered.manager.resume().await;
    flush().await;
    assert_same!(
        recovered.run(0).run["input"]["mentions"],
        proposal["mentions"]
    );
    recovered.manager.dispose().await;
}

#[tokio::test(flavor = "current_thread")]
async fn prepared_task_access_returns_an_isolated_admission_without_mutable_task_state() {
    let f = fixture();
    let mut input = prepared();
    input["input"]["mentions"] = json!([agent_mention()]);
    let id = create(&f, &input).await;
    let mut copy = f.manager.prepared(&id).unwrap();
    assert_same!(copy, input);
    copy["input"]["mentions"][0]["label"] = json!("Changed reference");
    copy["targets"][0]["workspace_identity"] = json!("d".repeat(64));
    assert_same!(f.manager.prepared(&id).unwrap(), input);
    f.manager.dispose().await;
}

#[tokio::test(flavor = "current_thread")]
async fn editing_a_monitored_session_isolates_notification_history_and_event_deduplication_from_an_admitted_run()
 {
    let f = fixture();
    let mut input = prepared();
    input["input"]["mentions"] = json!([agent_mention()]);
    let id = create(&f, &input).await;
    f.manager.resume().await;
    let original = start_run(&f, &id).await;
    f.manager
        .notify_run(
            &id,
            original.id(),
            &custom_notification("agent-work-1:completed"),
            None,
        )
        .await
        .unwrap();
    let mut replacement = prepared();
    replacement["input"]["mentions"] = json!([merge(
        &agent_mention(),
        json!({"agent_identity": "d".repeat(64)})
    )]);
    f.manager.update(&id, &replacement, None).await.unwrap();
    assert!(
        f.manager
            .notification_history(&id, None)
            .unwrap()
            .is_empty()
    );
    assert_eq!(
        f.manager
            .notification_history(&id, Some(original.id()))
            .unwrap()
            .len(),
        1
    );
    original.complete(false, None);
    let next = start_run(&f, &id).await;
    let result = f
        .manager
        .notify_run(
            &id,
            next.id(),
            &custom_notification("agent-work-1:completed"),
            None,
        )
        .await
        .unwrap();
    assert_eq!(
        text_json(&result),
        json!({"accepted": true, "delivery": "best_effort"})
    );
    assert_eq!(f.manager.notification_history(&id, None).unwrap().len(), 1);
    f.manager.dispose().await;
}

#[test]
fn saved_task_proposals_validate_their_displayed_input_against_the_confirmed_input_with_status_as_the_default_mode()
 {
    let input = prepared();
    let proposal = merge(
        &input["input"],
        json!({"id": uuid(), "status": "pending", "created_at": "2026-10-04T00:00:00.000Z"}),
    );
    let state = |entry: Value| json!({"tasks": [], "proposals": [entry], "requests": []});
    let check = |entry: Value| crate::saved::validate_saved_tasks(&state(entry));
    check(json!({"prepared": input, "proposal": proposal})).unwrap();
    let with_mode = |mode: &str| {
        let mut prepared = input.clone();
        prepared["input"]["notification_mode"] = json!(mode);
        prepared
    };
    for entry in [
        json!({"prepared": input, "proposal": merge(&proposal, json!({"notification_mode": "status"}))}),
        json!({"prepared": with_mode("status"), "proposal": proposal}),
        json!({"prepared": with_mode("agent"), "proposal": merge(&proposal, json!({"notification_mode": "agent"}))}),
    ] {
        check(entry).unwrap();
    }
    for change in [
        json!({"notification_mode": "invalid"}),
        json!({"notification_mode": "agent"}),
        json!({"title": "Another title"}),
        json!({"prompt": "Another prompt"}),
        json!({"mentions": [agent_mention()]}),
        json!({"scope": [{"connection_id": "local", "workspace_id": "another-workspace"}]}),
        json!({"schedule": {"type": "interval", "minutes": 2}}),
        json!({"title": ""}),
        json!({"scope": []}),
    ] {
        let entry = json!({"prepared": input, "proposal": merge(&proposal, change.clone())});
        assert_eq!(check(entry).unwrap_err(), "Invalid saved tasks", "{change}");
    }
    let entry = json!({"prepared": with_mode("agent"), "proposal": proposal});
    assert_eq!(check(entry).unwrap_err(), "Invalid saved tasks");
}

#[tokio::test(flavor = "current_thread")]
async fn task_notifications_describe_persisted_transitions_once_with_the_original_run_title() {
    let f = fixture();
    let mut input = prepared();
    let id = create(&f, &input).await;
    f.manager.resume().await;
    f.manager.control("run_now", &id).await.unwrap();
    f.advance(0).await;
    assert!(f.notifications().is_empty());
    input["input"]["title"] = json!("Edited task title");
    f.manager.update(&id, &input, None).await.unwrap();
    let child = f.run(0);
    child.complete(true, None);
    child.complete(true, None);
    f.manager.control("pause", &id).await.unwrap();
    assert_eq!(
        f.notifications(),
        vec![json!({
            "task_id": id, "run_id": child.id(), "status": "waiting",
            "title": "Ranger task needs confirmation",
            "body": "Check workspace: needs your confirmation. Open Ranger to review the pending action.",
        })]
    );
    child.complete(false, None);
    child.complete(false, None);
    assert_eq!(
        f.notifications()[1],
        json!({
            "task_id": id, "run_id": child.id(), "status": "succeeded",
            "title": "Ranger task completed", "body": "Check workspace: completed successfully.",
        })
    );
    assert_eq!(f.notifications().len(), 2);
    f.manager.control("run_now", &id).await.unwrap();
    f.advance(0).await;
    let failed = f.run(1);
    failed.complete(false, Some("Private model error and prompt"));
    assert_eq!(
        f.notifications()[2],
        json!({
            "task_id": id, "run_id": failed.id(), "status": "failed",
            "title": "Ranger task failed",
            "body": "Edited task title: failed. Open Ranger to review the task.",
        })
    );
    assert_eq!(f.notifications().len(), 3);
    f.manager.dispose().await;
}

#[tokio::test(flavor = "current_thread")]
async fn startup_failures_notify_after_saving_a_failed_receipt() {
    for failure in ["admission", "child"] {
        let f = fixture();
        let id = create(&f, &prepared()).await;
        f.manager.resume().await;
        f.manager.control("run_now", &id).await.unwrap();
        if failure == "admission" {
            f.deny(true);
        } else {
            f.fail_start();
        }
        f.advance(0).await;
        let run = f.manager.detail(&id, None).unwrap()["runs"][0].clone();
        assert_eq!(run["status"], "failed", "{failure}");
        assert_eq!(
            f.notifications(),
            vec![json!({
                "task_id": id, "run_id": run["id"], "status": "failed",
                "title": "Ranger task failed",
                "body": "Check workspace: failed. Open Ranger to review the task.",
            })]
        );
        f.manager.dispose().await;
        let restored = f.restart();
        restored.manager.resume().await;
        assert!(restored.notifications().is_empty());
        restored.manager.dispose().await;
    }
}

#[tokio::test(flavor = "current_thread")]
async fn notification_delivery_errors_do_not_change_a_saved_task_outcome() {
    let f = fixture_with(FixtureOptions {
        notify: Some(Arc::new(|_| Err("Notification delivery failed".into()))),
        ..FixtureOptions::default()
    });
    let id = create(&f, &prepared()).await;
    f.manager.resume().await;
    f.manager.control("run_now", &id).await.unwrap();
    f.advance(0).await;
    f.run(0).complete(false, None);
    assert_eq!(
        f.manager.detail(&id, None).unwrap()["runs"][0]["status"],
        "succeeded"
    );
    assert_eq!(f.manager.error(), None);
    assert_eq!(f.notifications().len(), 1);
    f.manager.control("run_now", &id).await.unwrap();
    f.advance(0).await;
    assert_eq!(f.run_count(), 2);
    f.manager.dispose().await;
}

#[tokio::test(flavor = "current_thread")]
async fn once_admission_is_durable_immutable_and_isolated_restart_keeps_one_original_run() {
    let f = fixture();
    let input = prepared_with(json!({"type": "once", "at": "2026-10-04T00:01:00.000Z"}));
    let request = uuid();
    let task = f.manager.create(&input, &request).await.unwrap();
    let id = task["id"].as_str().unwrap().to_owned();
    f.manager.resume().await;
    f.advance(60_000).await;
    assert_eq!(f.run_count(), 1);
    assert_eq!(f.run(0).run["input"]["prompt"], "Report verified progress");
    assert_eq!(
        f.run(0).directory,
        f.directory
            .join("tasks")
            .join(&id)
            .join("runs")
            .join(f.run(0).id())
    );
    assert!(f.manager.summaries()[0]["next_run_at"].is_null());
    let original = f.run(0).run.clone();
    f.manager.dispose().await;
    assert!(!f.run(0).stopped.load(Ordering::SeqCst));
    let restored = f.restart();
    restored.manager.resume().await;
    flush().await;
    assert_eq!(restored.run_count(), 1);
    assert_eq!(*restored.run(0).recover.lock().unwrap(), Some(true));
    let mut expected = original.clone();
    expected["status"] = json!("running");
    expected["started_at"] = json!("2026-10-04T00:01:00.000Z");
    assert_same!(restored.run(0).run, expected);
    restored.run(0).complete(false, None);
    flush().await;
    assert_eq!(
        restored.manager.summaries()[0]["last_run"]["status"],
        "succeeded"
    );
    let again = restored
        .manager
        .create(&prepared(), &request)
        .await
        .unwrap();
    assert_eq!(again["id"], id.as_str());
    restored.advance(600_000).await;
    assert_eq!(restored.run_count(), 1);
    restored.manager.dispose().await;
}

#[tokio::test(flavor = "current_thread")]
async fn metadata_edits_do_not_replay_a_consumed_one_time_task_with_a_run() {
    for status in ["succeeded", "failed", "stopped", "running", "waiting"] {
        let f = fixture();
        let mut input = prepared_with(json!({"type": "once", "at": "2026-10-04T00:01:00.000Z"}));
        let id = create(&f, &input).await;
        f.manager.resume().await;
        f.advance(60_000).await;
        let original = f.run(0);
        if status == "stopped" {
            f.manager.control("stop", &id).await.unwrap();
        } else if status != "running" {
            original.complete(
                status == "waiting",
                (status == "failed").then_some("Failed"),
            );
        }
        assert_eq!(
            f.manager.detail(&id, None).unwrap()["runs"][0]["status"],
            status
        );
        input["input"]["title"] = json!("Renamed task");
        input["input"]["prompt"] = json!("Updated instructions");
        input["input"]["notification_mode"] = json!("agent");
        input["config"]["model"] = json!("another-model");
        set_workspace(&mut input, "another-workspace");
        // Equivalent timestamp spelling must also preserve consumed state.
        input["input"]["schedule"] = json!({"at": "2026-10-04T00:01:00Z", "type": "once"});
        f.manager.update(&id, &input, None).await.unwrap();
        assert!(f.manager.detail(&id, None).unwrap()["task"]["next_run_at"].is_null());
        assert_eq!(original.run["input"]["title"], "Check workspace");
        if status == "running" || status == "waiting" {
            original.complete(false, None);
        }
        f.advance(600_000).await;
        assert_eq!(f.run_count(), 1, "{status}");
        f.manager.dispose().await;
        let restored = f.restart();
        restored.manager.resume().await;
        flush().await;
        assert_eq!(restored.run_count(), 0, "{status}");
        let detail = restored.manager.detail(&id, None).unwrap();
        assert!(detail["task"]["next_run_at"].is_null());
        assert_eq!(detail["task"]["title"], "Renamed task");
        restored.manager.dispose().await;
    }
}

#[tokio::test(flavor = "current_thread")]
async fn metadata_edits_preserve_cadence_including_an_overdue_paused_deadline() {
    for kind in ["interval", "daily"] {
        let f = fixture();
        let mut input = prepared_with(if kind == "interval" {
            json!({"type": kind, "minutes": 2})
        } else {
            json!({"type": kind, "time": "00:02", "timezone": "Etc/UTC"})
        });
        let id = create(&f, &input).await;
        f.manager.resume().await;
        f.advance(30_000).await;
        input["input"]["title"] = json!("Renamed before deadline");
        input["input"]["schedule"] = if kind == "interval" {
            json!({"minutes": 2, "type": kind})
        } else {
            json!({"timezone": "UTC", "time": "00:02", "type": kind})
        };
        f.manager.update(&id, &input, None).await.unwrap();
        let next =
            |f: &Fixture| f.manager.detail(&id, None).unwrap()["task"]["next_run_at"].clone();
        assert_eq!(next(&f), "2026-10-04T00:02:00.000Z", "{kind}");
        f.manager.control("pause", &id).await.unwrap();
        f.advance(180_000).await;
        input["input"]["prompt"] = json!("Updated after deadline");
        f.manager.update(&id, &input, None).await.unwrap();
        assert_eq!(next(&f), "2026-10-04T00:02:00.000Z");
        f.manager.control("resume", &id).await.unwrap();
        f.advance(0).await;
        assert_eq!(f.run_count(), 1);
        assert_eq!(f.run(0).run["scheduled_at"], "2026-10-04T00:02:00.000Z");
        assert_eq!(
            next(&f),
            if kind == "interval" {
                "2026-10-04T00:04:00.000Z"
            } else {
                "2026-10-05T00:02:00.000Z"
            }
        );
        f.manager.dispose().await;
    }
}

#[tokio::test(flavor = "current_thread")]
async fn metadata_edits_retain_a_coalesced_occurrence_while_schedule_changes_replace_it() {
    for kind in ["once", "interval"] {
        let f = fixture();
        let mut input = prepared_with(if kind == "once" {
            json!({"type": kind, "at": "2026-10-04T00:01:00.000Z"})
        } else {
            json!({"type": kind, "minutes": 1})
        });
        let id = create(&f, &input).await;
        f.manager.resume().await;
        let manual = start_run(&f, &id).await;
        f.advance(60_000).await;
        let next = f.manager.detail(&id, None).unwrap()["task"]["next_run_at"].clone();
        input["input"]["title"] = json!("Updated while due");
        f.manager.update(&id, &input, None).await.unwrap();
        assert_eq!(
            f.manager.detail(&id, None).unwrap()["task"]["next_run_at"],
            next
        );
        manual.complete(false, None);
        f.advance(0).await;
        assert_eq!(f.run_count(), 2, "{kind}");
        assert_eq!(f.run(1).run["manual"], false);
        assert_eq!(f.run(1).run["scheduled_at"], "2026-10-04T00:01:00.000Z");
        assert_eq!(f.run(1).run["input"]["title"], "Updated while due");
        f.advance(60_000).await;
        input["input"]["schedule"] = if kind == "once" {
            json!({"type": kind, "at": "2026-10-04T00:05:00.000Z"})
        } else {
            json!({"type": kind, "minutes": 3})
        };
        let changed = if kind == "once" {
            "2026-10-04T00:05:00.000Z".to_owned()
        } else {
            js::iso((f.clock.now() + 180_000) as f64)
        };
        f.manager.update(&id, &input, None).await.unwrap();
        assert_eq!(
            f.manager.detail(&id, None).unwrap()["task"]["next_run_at"],
            changed.as_str()
        );
        f.run(1).complete(false, None);
        f.advance(0).await;
        assert_eq!(f.run_count(), 2);
        let wait = js::date_parse(&changed) as i64 - f.clock.now();
        f.advance(wait as u64).await;
        assert_eq!(f.run_count(), 3);
        assert_eq!(f.run(2).run["scheduled_at"], changed.as_str());
        f.manager.dispose().await;
    }
}

/// A gate that ends a validation with success or a failure.
#[derive(Default)]
struct Admission {
    gate: Gate,
    rejected: AtomicBool,
}

#[tokio::test(flavor = "current_thread")]
async fn failed_manual_admission_drains_a_due_one_time_task_with_fresh_validation() {
    for (restart, safety) in [
        (false, "ready"),
        (true, "ready"),
        (false, "revoked"),
        (true, "revoked"),
        (false, "disconnected"),
        (true, "disconnected"),
    ] {
        let admission = Arc::new(Admission::default());
        let mode = Arc::new(Mutex::new("ready".to_owned()));
        let checks = Arc::new(AtomicUsize::new(0));
        let validation: Validation = {
            let (admission, mode, checks) = (admission.clone(), mode.clone(), checks.clone());
            Arc::new(move |_, _| {
                let (admission, mode, checks) = (admission.clone(), mode.clone(), checks.clone());
                Box::pin(async move {
                    checks.fetch_add(1, Ordering::SeqCst);
                    let current = mode.lock().unwrap().clone();
                    if current == "blocked" {
                        admission.gate.wait().await;
                        if admission.rejected.load(Ordering::SeqCst) {
                            return Err(internal("Transient provider catalog failure"));
                        }
                    }
                    let current = mode.lock().unwrap().clone();
                    match current.as_str() {
                        "revoked" => Err(internal("Workspace permission revoked")),
                        "disconnected" => Err(AssistantError::RecoveryNotReady(
                            "Connection unavailable".into(),
                        )),
                        _ => Ok(()),
                    }
                })
            })
        };
        let options = || FixtureOptions {
            validation: Some(validation.clone()),
            ..FixtureOptions::default()
        };
        let mut f = fixture_with(options());
        let id = create(
            &f,
            &prepared_with(json!({"type": "once", "at": "2026-10-04T00:01:00.000Z"})),
        )
        .await;
        f.manager.resume().await;
        f.manager.control("run_now", &id).await.unwrap();
        *mode.lock().unwrap() = "blocked".into();
        f.advance(0).await;
        let manual = f.manager.detail(&id, None).unwrap()["runs"][0].clone();
        f.advance(60_000).await;
        assert!(f.manager.detail(&id, None).unwrap()["task"]["next_run_at"].is_null());
        *mode.lock().unwrap() = safety.into();
        admission.rejected.store(true, Ordering::SeqCst);
        admission.gate.open();
        flush().await;
        assert_eq!(
            f.manager.detail(&id, None).unwrap()["runs"][0]["status"],
            "failed"
        );
        assert_eq!(f.run_count(), 0);
        let before = checks.load(Ordering::SeqCst);
        if restart {
            f.manager.dispose().await;
            f = f.restart_with(options());
            f.manager.resume().await;
        } else {
            f.advance(0).await;
        }
        flush().await;
        assert_eq!(
            checks.load(Ordering::SeqCst),
            before + 1,
            "{restart} {safety}"
        );
        let drained = f.manager.detail(&id, None).unwrap()["runs"][0].clone();
        assert_ne!(drained["id"], manual["id"]);
        assert_eq!(drained["scheduled_at"], "2026-10-04T00:01:00.000Z");
        assert_eq!(
            f.manager.detail(&id, None).unwrap()["runs"]
                .as_array()
                .unwrap()
                .len(),
            2
        );
        if safety == "disconnected" {
            assert_eq!(drained["status"], "queued");
            assert_eq!(f.run_count(), 0);
            f.advance(4_999).await;
            assert_eq!(checks.load(Ordering::SeqCst), before + 1);
            f.advance(1).await;
            assert_eq!(checks.load(Ordering::SeqCst), before + 2);
            *mode.lock().unwrap() = "ready".into();
            f.manager.resume().await;
            flush().await;
            assert_eq!(f.run(0).run["id"], drained["id"]);
        }
        if safety == "revoked" {
            assert_eq!(drained["status"], "failed");
            assert_eq!(f.run_count(), 0);
        } else {
            assert_eq!(f.run_count(), 1);
            assert_eq!(f.run(0).run["manual"], false);
            assert_eq!(*f.run(0).recover.lock().unwrap(), Some(false));
            f.run(0).complete(false, None);
        }
        let last = checks.load(Ordering::SeqCst);
        f.advance(600_000).await;
        f.manager.resume().await;
        assert_eq!(checks.load(Ordering::SeqCst), last);
        assert_eq!(
            f.manager.detail(&id, None).unwrap()["runs"]
                .as_array()
                .unwrap()
                .len(),
            2
        );
        f.manager.dispose().await;
        let restored = f.restart_with(options());
        restored.manager.resume().await;
        flush().await;
        assert_eq!(restored.run_count(), 0);
        assert_eq!(checks.load(Ordering::SeqCst), last);
        restored.manager.dispose().await;
    }
}

/// A validation that blocks on `admission` while `blocked`, failing when
/// it is rejected.
fn blocking(admission: &Arc<Admission>, blocked: &Arc<AtomicBool>) -> Validation {
    let (admission, blocked) = (admission.clone(), blocked.clone());
    Arc::new(move |_, _| {
        let (admission, blocked) = (admission.clone(), blocked.clone());
        Box::pin(async move {
            if blocked.load(Ordering::SeqCst) {
                admission.gate.wait().await;
                if admission.rejected.load(Ordering::SeqCst) {
                    return Err(internal("Transient catalog failure"));
                }
            }
            Ok(())
        })
    })
}

#[tokio::test(flavor = "current_thread")]
async fn restart_drains_the_oldest_stranded_interval_once_before_newer_missed_deadlines() {
    let admission = Arc::new(Admission::default());
    let blocked = Arc::new(AtomicBool::new(false));
    let f = fixture_with(FixtureOptions {
        validation: Some(blocking(&admission, &blocked)),
        ..FixtureOptions::default()
    });
    let id = create(&f, &prepared()).await;
    f.manager.resume().await;
    f.manager.control("run_now", &id).await.unwrap();
    blocked.store(true, Ordering::SeqCst);
    f.advance(0).await;
    f.advance(60_000).await;
    admission.rejected.store(true, Ordering::SeqCst);
    admission.gate.open();
    flush().await;
    f.manager.dispose().await;
    f.advance(150_000).await;
    let restored = f.restart();
    restored.manager.resume().await;
    flush().await;
    assert_eq!(restored.run_count(), 1);
    assert_eq!(
        restored.run(0).run["scheduled_at"],
        "2026-10-04T00:01:00.000Z"
    );
    assert_eq!(
        restored.manager.detail(&id, None).unwrap()["task"]["next_run_at"],
        "2026-10-04T00:04:00.000Z"
    );
    restored.run(0).complete(false, None);
    restored.advance(0).await;
    assert_eq!(restored.run_count(), 1);
    let wait = js::date_parse("2026-10-04T00:04:00.000Z") as i64 - restored.clock.now();
    restored.advance(wait as u64).await;
    assert_eq!(restored.run_count(), 2);
    assert_eq!(
        restored.run(1).run["scheduled_at"],
        "2026-10-04T00:04:00.000Z"
    );
    restored.manager.dispose().await;
}

#[tokio::test(flavor = "current_thread")]
async fn one_model_slot_coalesces_missed_intervals_and_waiting_previews_release_the_slot() {
    let f = fixture();
    let first = create(&f, &prepared()).await;
    let second = create(
        &f,
        &prepared_with(json!({"type": "once", "at": "2026-10-04T00:01:00.000Z"})),
    )
    .await;
    f.manager.resume().await;
    f.advance(60_000).await;
    assert_eq!(f.run_count(), 1);
    let queued = f
        .manager
        .summaries()
        .iter()
        .filter(|task| task["current_run"]["status"] == "queued")
        .count();
    assert_eq!(queued, 1);
    f.advance(600_000).await;
    assert_eq!(f.run_count(), 1);
    let running = f.run(0);
    running.complete(true, None);
    flush().await;
    let waiting_task = running.run["task_id"].as_str().unwrap().to_owned();
    assert_eq!(
        f.manager.detail(&waiting_task, None).unwrap()["task"]["current_run"]["status"],
        "waiting"
    );
    f.advance(0).await;
    assert_eq!(f.run_count(), 2);
    f.manager
        .action("cancel", &waiting_task, running.id(), "action")
        .await
        .unwrap();
    flush().await;
    assert_eq!(
        f.manager.detail(&waiting_task, None).unwrap()["runs"][0]["status"],
        "succeeded"
    );
    assert_eq!(
        f.manager.detail(&first, None).unwrap()["task"]["next_run_at"],
        "2026-10-04T00:12:00.000Z"
    );
    assert!(f.manager.detail(&second, None).unwrap()["task"]["next_run_at"].is_null());
    f.manager.dispose().await;
}

#[tokio::test(flavor = "current_thread")]
async fn restart_expires_a_waiting_preview_and_starts_its_coalesced_occurrence_once() {
    for schedule in ["interval", "once"] {
        let f = fixture();
        let id = create(
            &f,
            &if schedule == "interval" {
                prepared()
            } else {
                prepared_with(json!({"type": "once", "at": "2026-10-04T00:01:00.000Z"}))
            },
        )
        .await;
        f.manager.resume().await;
        if schedule == "once" {
            f.manager.control("run_now", &id).await.unwrap();
        }
        f.advance(if schedule == "interval" { 60_000 } else { 0 })
            .await;
        let expired = f.run(0).id().to_owned();
        f.run(0).complete(true, None);
        flush().await;
        f.advance(60_000).await;
        let scheduled_at = if schedule == "interval" {
            "2026-10-04T00:02:00.000Z"
        } else {
            "2026-10-04T00:01:00.000Z"
        };
        let next = f.manager.detail(&id, None).unwrap()["task"]["next_run_at"].clone();
        assert_eq!(
            f.manager.detail(&id, None).unwrap()["task"]["current_run"]["status"],
            "waiting"
        );
        f.manager.dispose().await;

        let restored = f.restart();
        restored.manager.resume().await;
        flush().await;
        let detail = restored.manager.detail(&id, None).unwrap();
        let old = detail["runs"]
            .as_array()
            .unwrap()
            .iter()
            .find(|run| run["id"] == expired.as_str())
            .unwrap();
        assert_eq!(old["status"], "failed");
        assert!(old["error"].as_str().unwrap().contains("previews expired"));
        assert_eq!(restored.run_count(), 1, "{schedule}");
        let run = restored.run(0);
        assert_eq!(run.run["status"], "running");
        assert_eq!(run.run["scheduled_at"], scheduled_at);
        assert_eq!(run.run["manual"], false);
        assert_ne!(run.id(), expired);
        assert_eq!(
            restored.notifications(),
            vec![json!({
                "task_id": id, "run_id": expired, "status": "failed",
                "title": "Ranger task failed",
                "body": "Check workspace: failed. Open Ranger to review the task.",
            })]
        );
        assert_eq!(*run.recover.lock().unwrap(), Some(false));
        assert_eq!(
            restored.manager.detail(&id, None).unwrap()["task"]["next_run_at"],
            next
        );
        run.complete(false, None);
        flush().await;
        restored.advance(0).await;
        assert_eq!(restored.run_count(), 1);
        restored.manager.dispose().await;

        let restarted = restored.restart();
        restarted.manager.resume().await;
        flush().await;
        assert_eq!(restarted.run_count(), 0);
        assert!(restarted.notifications().is_empty());
        let statuses: Vec<Value> = restarted.manager.detail(&id, None).unwrap()["runs"]
            .as_array()
            .unwrap()
            .iter()
            .map(|run| run["status"].clone())
            .collect();
        assert_eq!(statuses, [json!("succeeded"), json!("failed")]);
        assert_eq!(
            restarted.manager.detail(&id, None).unwrap()["task"]["next_run_at"],
            next
        );
        restarted.advance(60_000).await;
        assert_eq!(restarted.run_count(), usize::from(schedule == "interval"));
        if schedule == "interval" {
            assert_eq!(restarted.run(0).run["scheduled_at"], next);
        }
        restarted.manager.dispose().await;
    }
}

#[tokio::test(flavor = "current_thread")]
async fn restart_expires_a_paused_task_preview_without_restarting_its_coalesced_occurrence() {
    let f = fixture();
    let id = create(&f, &prepared()).await;
    f.manager.resume().await;
    f.manager.control("run_now", &id).await.unwrap();
    f.advance(0).await;
    f.run(0).complete(true, None);
    flush().await;
    f.advance(60_000).await;
    f.manager.control("pause", &id).await.unwrap();
    let next = f.manager.detail(&id, None).unwrap()["task"]["next_run_at"].clone();
    f.manager.dispose().await;
    let restored = f.restart();
    restored.manager.resume().await;
    restored.advance(60_000).await;
    assert_eq!(restored.run_count(), 0);
    let task = restored.manager.detail(&id, None).unwrap()["task"].clone();
    assert_eq!(task["status"], "paused");
    assert_eq!(task["next_run_at"], next);
    assert!(task.get("current_run").is_none());
    let statuses: Vec<Value> = restored.manager.detail(&id, None).unwrap()["runs"]
        .as_array()
        .unwrap()
        .iter()
        .map(|run| run["status"].clone())
        .collect();
    assert_eq!(statuses, [json!("failed")]);
    restored.manager.dispose().await;
}

#[tokio::test(flavor = "current_thread")]
async fn queued_run_now_preserves_a_due_one_time_run() {
    for restart in [false, true] {
        let mut f = fixture();
        let blocker = create(
            &f,
            &prepared_with(json!({"type": "once", "at": "2026-10-04T01:00:00.000Z"})),
        )
        .await;
        let id = create(
            &f,
            &prepared_with(json!({"type": "once", "at": "2026-10-04T00:01:00.000Z"})),
        )
        .await;
        f.manager.resume().await;
        f.manager.control("run_now", &blocker).await.unwrap();
        f.advance(0).await;
        assert_eq!(f.run_count(), 1);
        f.manager.control("run_now", &id).await.unwrap();
        f.advance(60_000).await;
        f.advance(0).await;
        let task = f.manager.detail(&id, None).unwrap()["task"].clone();
        assert!(task["next_run_at"].is_null());
        assert_eq!(task["current_run"]["status"], "queued");
        if restart {
            f.manager.dispose().await;
            f = f.restart();
            f.manager.resume().await;
            flush().await;
            assert_eq!(*f.run(0).recover.lock().unwrap(), Some(true));
        }
        f.run(0).complete(false, None);
        flush().await;
        f.advance(0).await;
        assert_eq!(f.run_count(), 2, "restart {restart}");
        assert_eq!(f.run(1).run["manual"], true);
        assert_eq!(f.run(1).run["task_id"], id.as_str());
        f.run(1).complete(false, None);
        flush().await;
        f.advance(0).await;
        assert_eq!(f.run_count(), 3);
        assert_eq!(f.run(2).run["manual"], false);
        assert_eq!(f.run(2).run["task_id"], id.as_str());
        assert_eq!(f.run(2).run["scheduled_at"], "2026-10-04T00:01:00.000Z");
        f.run(2).complete(false, None);
        flush().await;
        f.advance(300_000).await;
        assert_eq!(f.run_count(), 3);
        let statuses: Vec<Value> = f.manager.detail(&id, None).unwrap()["runs"]
            .as_array()
            .unwrap()
            .iter()
            .map(|run| run["status"].clone())
            .collect();
        assert_eq!(statuses, [json!("succeeded"), json!("succeeded")]);
        f.manager.dispose().await;
    }
}

#[tokio::test(flavor = "current_thread")]
async fn pause_preserves_a_running_child_manual_runs_and_stop_preserve_the_schedule_cancellation_and_deletion_persist_first()
 {
    let f = fixture();
    let id = create(&f, &prepared()).await;
    f.manager.resume().await;
    f.manager.control("run_now", &id).await.unwrap();
    f.advance(0).await;
    f.manager.control("pause", &id).await.unwrap();
    assert!(!f.run(0).stopped.load(Ordering::SeqCst));
    assert_eq!(
        f.manager.detail(&id, None).unwrap()["task"]["status"],
        "paused"
    );
    f.manager.control("stop", &id).await.unwrap();
    assert!(f.run(0).stopped.load(Ordering::SeqCst));
    assert_eq!(
        f.manager.detail(&id, None).unwrap()["runs"][0]["status"],
        "stopped"
    );
    f.manager.control("run_now", &id).await.unwrap();
    f.advance(0).await;
    assert_eq!(f.run_count(), 2);
    f.fail(true);
    let error = f.manager.control("cancel", &id).await.unwrap_err();
    assert!(error.to_string().contains("could not be saved"));
    assert!(!f.run(1).stopped.load(Ordering::SeqCst));
    f.fail(false);
    f.manager.control("cancel", &id).await.unwrap();
    assert!(f.run(1).stopped.load(Ordering::SeqCst));
    assert!(f.notifications().is_empty());
    let error = f.manager.control("resume", &id).await.unwrap_err();
    assert!(error.to_string().contains("cancelled"));
    f.manager.delete(&id).unwrap();
    assert!(f.manager.summaries().is_empty());
    f.manager.dispose().await;
    assert!(f.restart().manager.summaries().is_empty());
}

#[tokio::test(flavor = "current_thread")]
async fn failed_storage_and_revoked_identity_cannot_start_a_model_or_confirm_a_preview() {
    let f = fixture();
    f.fail(true);
    let error = f.manager.create(&prepared(), &uuid()).await.unwrap_err();
    assert!(error.to_string().contains("could not be saved"));
    assert!(f.manager.summaries().is_empty());
    f.fail(false);
    let proposal = f.manager.propose(&prepared(), None).await.unwrap();
    let pid = proposal["id"].as_str().unwrap();
    assert!(f.manager.summaries().is_empty());
    f.deny(true);
    let error = f.manager.confirm_proposal(pid, None).await.unwrap_err();
    assert!(error.to_string().contains("identity"));
    assert!(f.manager.summaries().is_empty());
    f.deny(false);
    f.manager.confirm_proposal(pid, None).await.unwrap();
    f.manager.confirm_proposal(pid, None).await.unwrap();
    assert_eq!(f.manager.summaries().len(), 1);
    f.manager.resume().await;
    f.deny(true);
    f.advance(60_000).await;
    assert_eq!(f.run_count(), 0);
    assert_eq!(f.manager.summaries()[0]["last_run"]["status"], "failed");
    f.manager.dispose().await;
}

/// A validation counting its calls, refused as not ready while `ready` is
/// false (for the inputs `applies` takes).
fn readiness(
    ready: &Arc<AtomicBool>,
    checks: &Arc<AtomicUsize>,
    applies: fn(&Value) -> bool,
) -> Validation {
    let (ready, checks) = (ready.clone(), checks.clone());
    Arc::new(move |_, prepared| {
        let (ready, checks) = (ready.clone(), checks.clone());
        Box::pin(async move {
            checks.fetch_add(1, Ordering::SeqCst);
            if !ready.load(Ordering::SeqCst) && applies(&prepared) {
                return Err(AssistantError::RecoveryNotReady(
                    "Connection is not ready".into(),
                ));
            }
            Ok(())
        })
    })
}

fn always(_: &Value) -> bool {
    true
}

fn with_validation(validation: &Validation) -> FixtureOptions {
    FixtureOptions {
        validation: Some(validation.clone()),
        ..FixtureOptions::default()
    }
}

#[tokio::test(flavor = "current_thread")]
async fn a_due_task_waits_for_its_original_connection_without_spinning_or_losing_the_occurrence() {
    let ready = Arc::new(AtomicBool::new(true));
    let checks = Arc::new(AtomicUsize::new(0));
    let f = fixture_with(with_validation(&readiness(&ready, &checks, always)));
    let id = create(
        &f,
        &prepared_with(json!({"type": "once", "at": "2026-10-04T00:01:00.000Z"})),
    )
    .await;
    f.manager.resume().await;
    ready.store(false, Ordering::SeqCst);
    f.advance(60_000).await;
    let queued = f.manager.detail(&id, None).unwrap()["runs"][0].clone();
    assert_eq!(queued["status"], "queued");
    assert!(
        queued["error"]
            .as_str()
            .unwrap()
            .contains("Waiting for the original workspace connection")
    );
    assert!(queued.get("started_at").is_none());
    assert!(queued.get("finished_at").is_none());
    assert!(f.manager.detail(&id, None).unwrap()["task"]["next_run_at"].is_null());
    assert_eq!(f.run_count(), 0);
    assert_eq!(checks.load(Ordering::SeqCst), 2);
    f.advance(4_999).await;
    assert_eq!(checks.load(Ordering::SeqCst), 2);
    f.advance(1).await;
    assert_eq!(checks.load(Ordering::SeqCst), 3);
    assert_eq!(
        f.manager.detail(&id, None).unwrap()["runs"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    ready.store(true, Ordering::SeqCst);
    f.manager.resume().await;
    flush().await;
    assert_eq!(f.run_count(), 1);
    assert_eq!(f.run(0).run["id"], queued["id"]);
    assert_eq!(f.run(0).run["scheduled_at"], queued["scheduled_at"]);
    assert!(f.run(0).run["error"].is_null());
    f.run(0).complete(false, None);
    f.advance(120_000).await;
    assert_eq!(f.run_count(), 1);
    assert_eq!(
        f.manager.detail(&id, None).unwrap()["runs"][0]["status"],
        "succeeded"
    );
    f.manager.dispose().await;
}

fn disconnected_title(prepared: &Value) -> bool {
    prepared["input"]["title"] == "Disconnected workspace"
}

#[tokio::test(flavor = "current_thread")]
async fn a_disconnected_queued_task_releases_the_slot_for_another_workspace_and_can_be_cancelled() {
    let ready = Arc::new(AtomicBool::new(true));
    let checks = Arc::new(AtomicUsize::new(0));
    let f = fixture_with(with_validation(&readiness(
        &ready,
        &checks,
        disconnected_title,
    )));
    let mut input = prepared_with(json!({"type": "once", "at": "2026-10-04T00:01:00.000Z"}));
    input["input"]["title"] = json!("Disconnected workspace");
    let disconnected = create(&f, &input).await;
    let connected = create(
        &f,
        &prepared_with(json!({"type": "once", "at": "2026-10-04T00:01:01.000Z"})),
    )
    .await;
    f.manager.resume().await;
    ready.store(false, Ordering::SeqCst);
    f.advance(60_000).await;
    f.advance(1_000).await;
    assert_eq!(f.run_count(), 1);
    assert_eq!(f.run(0).run["task_id"], connected.as_str());
    assert_eq!(
        f.manager.detail(&disconnected, None).unwrap()["runs"][0]["status"],
        "queued"
    );
    f.manager.control("cancel", &disconnected).await.unwrap();
    f.run(0).complete(false, None);
    ready.store(true, Ordering::SeqCst);
    f.manager.resume().await;
    f.advance(5_000).await;
    assert_eq!(f.run_count(), 1);
    assert_eq!(
        f.manager.detail(&disconnected, None).unwrap()["runs"][0]["status"],
        "stopped"
    );
    f.manager.dispose().await;
}

#[tokio::test(flavor = "current_thread")]
async fn a_queued_occurrence_survives_restart_and_revalidates_a_connection() {
    for connection in ["ready", "replaced"] {
        let ready = Arc::new(AtomicBool::new(true));
        let checks = Arc::new(AtomicUsize::new(0));
        let validation = readiness(&ready, &checks, always);
        let f = fixture_with(with_validation(&validation));
        let id = create(
            &f,
            &prepared_with(json!({"type": "once", "at": "2026-10-04T00:01:00.000Z"})),
        )
        .await;
        f.manager.resume().await;
        ready.store(false, Ordering::SeqCst);
        f.advance(60_000).await;
        let queued = f.manager.detail(&id, None).unwrap()["runs"][0].clone();
        f.manager.dispose().await;
        let restored = f.restart_with(with_validation(&validation));
        restored.manager.resume().await;
        flush().await;
        let run = restored.manager.detail(&id, None).unwrap()["runs"][0].clone();
        assert_eq!(run["id"], queued["id"]);
        assert_eq!(run["status"], "queued");
        assert_eq!(restored.run_count(), 0);
        ready.store(true, Ordering::SeqCst);
        restored.deny(connection == "replaced");
        restored.manager.resume().await;
        flush().await;
        let runs = restored.manager.detail(&id, None).unwrap()["runs"].clone();
        assert_eq!(runs.as_array().unwrap().len(), 1);
        if connection == "ready" {
            assert_eq!(restored.run_count(), 1);
            assert_eq!(restored.run(0).run["id"], queued["id"]);
            assert_eq!(*restored.run(0).recover.lock().unwrap(), Some(false));
        } else {
            assert_eq!(restored.run_count(), 0);
            assert_eq!(runs[0]["status"], "failed");
            assert!(runs[0].get("finished_at").is_some());
            assert!(runs[0]["error"].as_str().unwrap().contains("identity"));
        }
        restored.manager.dispose().await;
    }
}

#[tokio::test(flavor = "current_thread")]
async fn queued_recovery_survives_another_restart_with_a_target() {
    for target in ["ready", "cancelled", "replaced"] {
        let ready = Arc::new(AtomicBool::new(true));
        let checks = Arc::new(AtomicUsize::new(0));
        let validation = readiness(&ready, &checks, always);
        let f = fixture_with(with_validation(&validation));
        let id = create(
            &f,
            &prepared_with(json!({"type": "once", "at": "2026-10-04T00:01:00.000Z"})),
        )
        .await;
        f.manager.resume().await;
        f.advance(60_000).await;
        let original = f.manager.detail(&id, None).unwrap()["runs"][0].clone();
        f.manager.dispose().await;
        ready.store(false, Ordering::SeqCst);
        let waiting = f.restart_with(with_validation(&validation));
        waiting.manager.resume().await;
        flush().await;
        assert_eq!(waiting.run_count(), 0);
        let run = waiting.manager.detail(&id, None).unwrap()["runs"][0].clone();
        assert_eq!(run["status"], "queued");
        assert_eq!(run["started_at"], original["started_at"]);
        waiting.manager.dispose().await;
        let restored = f.restart_with(with_validation(&validation));
        restored.manager.resume().await;
        flush().await;
        assert_eq!(restored.run_count(), 0);
        if target == "cancelled" {
            restored.manager.control("cancel", &id).await.unwrap();
        }
        restored.deny(target == "replaced");
        ready.store(true, Ordering::SeqCst);
        restored.manager.resume().await;
        flush().await;
        let receipt = restored.manager.detail(&id, None).unwrap()["runs"][0].clone();
        assert_eq!(receipt["id"], original["id"]);
        assert_eq!(receipt["started_at"], original["started_at"]);
        assert_eq!(
            restored.manager.detail(&id, None).unwrap()["runs"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
        if target == "ready" {
            assert_eq!(restored.run_count(), 1);
            assert_eq!(*restored.run(0).recover.lock().unwrap(), Some(true));
            assert_eq!(receipt["status"], "running");
        } else {
            assert_eq!(restored.run_count(), 0, "{target}");
            assert_eq!(
                receipt["status"],
                if target == "cancelled" {
                    "stopped"
                } else {
                    "failed"
                }
            );
        }
        restored.manager.dispose().await;
    }
}

#[tokio::test(flavor = "current_thread")]
async fn recovery_queued_during_disconnection_retains_one_coalesced_occurrence_after_the_interrupted_run()
 {
    let f = fixture();
    let id = create(&f, &prepared()).await;
    f.manager.resume().await;
    f.advance(60_000).await;
    let original = f.manager.detail(&id, None).unwrap()["runs"][0].clone();
    f.manager.dispose().await;
    let ready = Arc::new(AtomicBool::new(false));
    let checks = Arc::new(AtomicUsize::new(0));
    let restored = f.restart_with(with_validation(&readiness(&ready, &checks, always)));
    restored.manager.resume().await;
    flush().await;
    restored.advance(240_000).await;
    let runs = restored.manager.detail(&id, None).unwrap()["runs"].clone();
    assert_eq!(runs.as_array().unwrap().len(), 1);
    assert_eq!(runs[0]["status"], "queued");
    ready.store(true, Ordering::SeqCst);
    restored.manager.resume().await;
    flush().await;
    assert_eq!(restored.run_count(), 1);
    assert_eq!(restored.run(0).run["id"], original["id"]);
    assert_eq!(*restored.run(0).recover.lock().unwrap(), Some(true));
    restored.run(0).complete(false, None);
    restored.advance(0).await;
    assert_eq!(restored.run_count(), 2);
    assert_eq!(*restored.run(1).recover.lock().unwrap(), Some(false));
    assert_eq!(
        restored.run(1).run["scheduled_at"],
        "2026-10-04T00:02:00.000Z"
    );
    assert_eq!(
        restored.manager.detail(&id, None).unwrap()["runs"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
    assert_eq!(
        restored.manager.detail(&id, None).unwrap()["task"]["next_run_at"],
        "2026-10-04T00:06:00.000Z"
    );
    restored.manager.dispose().await;
}

#[tokio::test(flavor = "current_thread")]
async fn completed_history_retains_only_receipts_caps_at_20_runs_and_reloads_large_prompts() {
    let f = fixture();
    let mut input = prepared();
    input["input"]["prompt"] = json!("p".repeat(32_000));
    let id = create(&f, &input).await;
    f.manager.resume().await;
    for _ in 0..22 {
        f.manager.control("run_now", &id).await.unwrap();
        f.advance(0).await;
        let run = f.last_run();
        std::fs::create_dir_all(&run.directory).unwrap();
        std::fs::write(run.directory.join("marker"), "private-history").unwrap();
        run.complete(false, None);
        flush().await;
    }
    let saved = TaskStorage::open(&f.context, &f.directory)
        .unwrap()
        .load()
        .unwrap();
    let runs = saved["tasks"][0]["runs"].as_array().unwrap();
    assert_eq!(runs.len(), 20);
    assert!(runs.iter().all(|run| run.get("input").is_none()
        && run.get("targets").is_none()
        && run.get("config").is_none()));
    assert!(js::stringify(&saved).len() < 50_000);
    assert!(!f.run(0).directory.exists());
    f.manager.dispose().await;
    let restored = f.restart();
    assert!(!restored.manager.invalid());
    let detail = restored.manager.detail(&id, None).unwrap();
    assert_eq!(detail["runs"].as_array().unwrap().len(), 20);
    assert_eq!(detail["task"]["prompt"].as_str().unwrap().len(), 32_000);
    assert!(
        validate_task_input(&merge(&input["input"], json!({"title": "t".repeat(101)}))).is_err()
    );
}

#[tokio::test(flavor = "current_thread")]
async fn cancels_pending_scope_validation_without_starting_a_model() {
    for method in ["stop", "dispose"] {
        let block = Arc::new(AtomicBool::new(false));
        let aborted = Arc::new(AtomicBool::new(false));
        let validation: Validation = {
            let (block, aborted) = (block.clone(), aborted.clone());
            Arc::new(move |signal, _| {
                let (block, aborted) = (block.clone(), aborted.clone());
                Box::pin(async move {
                    if !block.load(Ordering::SeqCst) {
                        return Ok(());
                    }
                    signal.cancelled().await;
                    aborted.store(true, Ordering::SeqCst);
                    Err(internal("Stopped"))
                })
            })
        };
        let f = fixture_with(with_validation(&validation));
        let id = create(&f, &prepared()).await;
        f.manager.resume().await;
        f.manager.control("run_now", &id).await.unwrap();
        block.store(true, Ordering::SeqCst);
        f.advance(0).await;
        assert_eq!(f.run_count(), 0);
        if method == "stop" {
            f.manager.control("stop", &id).await.unwrap();
        } else {
            f.manager.dispose().await;
        }
        flush().await;
        assert!(aborted.load(Ordering::SeqCst), "{method}");
        assert_eq!(f.run_count(), 0);
        assert_eq!(
            f.manager.detail(&id, None).unwrap()["runs"][0]["status"],
            if method == "stop" {
                "stopped"
            } else {
                "running"
            }
        );
        f.manager.dispose().await;
    }
}
