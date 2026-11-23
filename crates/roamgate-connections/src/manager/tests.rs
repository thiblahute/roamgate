//! server/src/connections/manager.test.ts.

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use futures_util::FutureExt;
use futures_util::future::{BoxFuture, Shared};

use super::*;

type Gate = Shared<BoxFuture<'static, Result<(), String>>>;

/// A gate opened (or failed) by its sender.
fn deferred() -> (tokio::sync::oneshot::Sender<Result<(), String>>, Gate) {
    let (tx, rx) = tokio::sync::oneshot::channel();
    (
        tx,
        async move { rx.await.unwrap_or(Ok(())) }.boxed().shared(),
    )
}

fn failed(message: &str) -> Gate {
    futures_util::future::ready(Err(message.to_owned()))
        .boxed()
        .shared()
}

fn identity(id: &str) -> ConnectionIdentity {
    ConnectionIdentity::new(id, id, "test")
}

#[derive(Default, Clone)]
struct FakeOptions {
    transport: Option<Gate>,
    stop: Option<Gate>,
    background_error: Option<String>,
}

struct FakeRuntime {
    id: String,
    starts: AtomicUsize,
    backgrounds: AtomicUsize,
    stops: AtomicUsize,
    context: RuntimeContext,
    options: FakeOptions,
}

impl FakeRuntime {
    fn stops(&self) -> usize {
        self.stops.load(Ordering::SeqCst)
    }
}

impl ConnectionRuntime for FakeRuntime {
    fn identity(&self) -> ConnectionIdentity {
        identity(&self.id)
    }
    fn start_transport(&self) -> BoxFuture<'static, Result<(), String>> {
        self.starts.fetch_add(1, Ordering::SeqCst);
        let gate = self.options.transport.clone();
        async move {
            match gate {
                Some(gate) => gate.await,
                None => Ok(()),
            }
        }
        .boxed()
    }
    fn start_background(&self) -> BoxFuture<'static, Result<(), String>> {
        self.backgrounds.fetch_add(1, Ordering::SeqCst);
        let error = self.options.background_error.clone();
        async move { error.map_or(Ok(()), Err) }.boxed()
    }
    fn stop(&self) -> BoxFuture<'static, Result<(), String>> {
        self.stops.fetch_add(1, Ordering::SeqCst);
        let gate = self.options.stop.clone();
        async move {
            match gate {
                Some(gate) => gate.await,
                None => Ok(()),
            }
        }
        .boxed()
    }
}

type Created = Arc<Mutex<Vec<Arc<FakeRuntime>>>>;

fn fake_factory(id: &str, options: FakeOptions, created: Created) -> RuntimeFactory<FakeRuntime> {
    let id = id.to_owned();
    Arc::new(move |context| {
        let runtime = Arc::new(FakeRuntime {
            id: id.clone(),
            starts: AtomicUsize::new(0),
            backgrounds: AtomicUsize::new(0),
            stops: AtomicUsize::new(0),
            context,
            options: options.clone(),
        });
        created.lock().unwrap().push(runtime.clone());
        Ok(runtime)
    })
}

fn plain(id: &str) -> RuntimeFactory<FakeRuntime> {
    fake_factory(id, FakeOptions::default(), Created::default())
}

fn manager(default: &str) -> ConnectionManager<FakeRuntime> {
    ConnectionManager::new(default, None, None)
}

fn observed(
    default: &str,
) -> (
    ConnectionManager<FakeRuntime>,
    Arc<Mutex<Vec<ConnectionStatus>>>,
) {
    let statuses = Arc::new(Mutex::new(Vec::new()));
    let seen = statuses.clone();
    (
        ConnectionManager::new(
            default,
            Some(Arc::new(move |status| seen.lock().unwrap().push(status))),
            None,
        ),
        statuses,
    )
}

fn nth(created: &Created, index: usize) -> Arc<FakeRuntime> {
    created.lock().unwrap()[index].clone()
}

#[tokio::test]
async fn resolves_one_stable_default_without_constructing_it_during_registration() {
    let manager = manager("default");
    manager
        .register(identity("default"), plain("default"))
        .unwrap();
    manager.register(identity("other"), plain("other")).unwrap();
    assert_eq!(manager.default_id(), "default");
    assert!(manager.default_runtime().is_none());
    assert_eq!(
        serde_json::to_value(manager.list()).unwrap(),
        serde_json::json!([
            {"id": "default", "label": "default", "source": "test", "is_default": true, "state": "disconnected", "generation": 0},
            {"id": "other", "label": "other", "source": "test", "is_default": false, "state": "disconnected", "generation": 0},
        ])
    );
}

#[tokio::test]
async fn changes_default_only_to_a_registered_non_removing_connection() {
    let (manager, statuses) = observed("default");
    manager
        .register(identity("default"), plain("default"))
        .unwrap();
    manager.register(identity("other"), plain("other")).unwrap();
    manager.set_default("other").unwrap();
    assert_eq!(manager.default_id(), "other");
    assert!(!manager.status("default").unwrap().is_default);
    assert!(manager.status("other").unwrap().is_default);
    assert!(
        manager
            .set_default("missing")
            .unwrap_err()
            .contains("unknown connection")
    );
    let statuses = statuses.lock().unwrap();
    let last: Vec<(String, bool)> = statuses[statuses.len() - 2..]
        .iter()
        .map(|s| (s.id.clone(), s.is_default))
        .collect();
    assert_eq!(
        last,
        [("default".to_owned(), false), ("other".to_owned(), true)]
    );
}

#[tokio::test]
async fn unregister_drains_a_non_default_runtime_and_prevents_racing_restarts() {
    let (stop_tx, stop) = deferred();
    let created = Created::default();
    let manager = manager("default");
    manager
        .register(identity("default"), plain("default"))
        .unwrap();
    manager
        .register(
            identity("other"),
            fake_factory(
                "other",
                FakeOptions {
                    stop: Some(stop),
                    ..FakeOptions::default()
                },
                created.clone(),
            ),
        )
        .unwrap();
    manager.start("other").await.unwrap();
    let removing = tokio::spawn({
        let manager = manager.clone();
        async move { manager.unregister("other").await }
    });
    tokio::task::yield_now().await;
    assert!(
        manager
            .start("other")
            .await
            .unwrap_err()
            .contains("being removed")
    );
    assert_eq!(nth(&created, 0).stops(), 1);
    stop_tx.send(Ok(())).unwrap();
    removing.await.unwrap().unwrap();
    assert!(!manager.has("other"));
    assert!(
        manager
            .status("other")
            .unwrap_err()
            .contains("unknown connection")
    );
    assert!(
        manager
            .unregister("default")
            .await
            .unwrap_err()
            .contains("cannot remove the default connection")
    );
}

#[tokio::test]
async fn unregister_removes_a_factory_even_when_runtime_cleanup_fails() {
    let manager = manager("default");
    manager
        .register(identity("default"), plain("default"))
        .unwrap();
    manager
        .register(
            identity("other"),
            fake_factory(
                "other",
                FakeOptions {
                    stop: Some(failed("cleanup failed")),
                    ..FakeOptions::default()
                },
                Created::default(),
            ),
        )
        .unwrap();
    manager.start("other").await.unwrap();
    manager.unregister("other").await.unwrap();
    assert!(!manager.has("other"));
    assert!(
        manager
            .start("other")
            .await
            .unwrap_err()
            .contains("unknown connection")
    );
}

#[tokio::test]
async fn shares_concurrent_starts_and_begins_background_work_after_transport() {
    let (transport_tx, transport) = deferred();
    let created = Created::default();
    let manager = manager("default");
    manager
        .register(
            identity("default"),
            fake_factory(
                "default",
                FakeOptions {
                    transport: Some(transport),
                    ..FakeOptions::default()
                },
                created.clone(),
            ),
        )
        .unwrap();
    let first = manager.start_default();
    let second = manager.start_default();
    assert_eq!(
        manager.status("default").unwrap().state,
        ConnectionState::Connecting
    );
    assert_eq!(created.lock().unwrap().len(), 1);
    assert_eq!(nth(&created, 0).backgrounds.load(Ordering::SeqCst), 0);
    assert!(manager.default_ready_runtime().is_none());
    transport_tx.send(Ok(())).unwrap();
    first.await.unwrap();
    second.await.unwrap();
    assert_eq!(created.lock().unwrap().len(), 1);
    let runtime = nth(&created, 0);
    assert_eq!(runtime.starts.load(Ordering::SeqCst), 1);
    assert_eq!(runtime.backgrounds.load(Ordering::SeqCst), 1);
    assert!(Arc::ptr_eq(
        &manager.default_ready_runtime().unwrap(),
        &runtime
    ));
    let status = manager.status("default").unwrap();
    assert_eq!(
        (status.state, status.generation),
        (ConnectionState::Ready, 1)
    );
}

#[tokio::test]
async fn invalidates_ready_runtime_leases_across_same_id_replacement() {
    let manager = manager("default");
    manager
        .register(identity("default"), plain("default"))
        .unwrap();
    manager.start_default().await.unwrap();
    let lease = manager.ready_runtime_lease("default").unwrap().unwrap();
    assert!(lease.is_current());
    manager
        .replace(identity("default"), plain("default"))
        .await
        .unwrap();
    assert!(!lease.is_current());
}

#[tokio::test]
async fn isolates_a_failed_connection_and_exposes_only_sanitized_status_errors() {
    let manager = manager("good");
    manager.register(identity("good"), plain("good")).unwrap();
    manager
        .register(
            identity("bad"),
            fake_factory(
                "bad",
                FakeOptions {
                    transport: Some(failed("token=secret https://user:pass@example.test failed")),
                    ..FakeOptions::default()
                },
                Created::default(),
            ),
        )
        .unwrap();
    let (good, bad) = tokio::join!(manager.start("good"), manager.start("bad"));
    assert!(good.is_ok());
    assert!(bad.is_err());
    assert_eq!(
        manager.status("good").unwrap().state,
        ConnectionState::Ready
    );
    let status = manager.status("bad").unwrap();
    assert_eq!(status.state, ConnectionState::Error);
    assert_eq!(
        status.error.unwrap().message,
        "token=*** https://***@example.test failed"
    );
}

#[test]
fn redacts_common_credential_forms_and_bounds_public_errors() {
    assert_eq!(
        sanitize_connection_error(
            r#"Authorization: Bearer bearer-secret password: colon-secret {"token":"json-secret"} api_key=key-secret"#
        ),
        r#"Authorization: Bearer *** password: *** {"token":***} api_key=***"#
    );
    assert_eq!(
        sanitize_connection_error(
            "https://user:pass@example.test refresh-token='refresh-secret' failed"
        ),
        "https://***@example.test refresh-token=*** failed"
    );
    assert_eq!(
        sanitize_connection_error("bad\u{1b}[31m\nvalue\0"),
        "bad value"
    );
    assert_eq!(sanitize_connection_error(&"x".repeat(400)).len(), 300);
}

#[tokio::test]
async fn cleans_runtimes_whose_transport_or_background_startup_fails() {
    for failure in ["transport", "background"] {
        let created = Created::default();
        let manager = manager("default");
        let options = if failure == "transport" {
            FakeOptions {
                transport: Some(failed("transport failed")),
                ..FakeOptions::default()
            }
        } else {
            FakeOptions {
                background_error: Some("background failed".into()),
                ..FakeOptions::default()
            }
        };
        manager
            .register(
                identity("default"),
                fake_factory("default", options, created.clone()),
            )
            .unwrap();
        let error = manager.start_default().await.unwrap_err();
        assert!(error.contains(&format!("{failure} failed")), "{error}");
        assert_eq!(nth(&created, 0).stops(), 1);
        assert!(manager.default_runtime().is_none());
        assert!(manager.default_ready_runtime().is_none());
        let status = manager.status("default").unwrap();
        assert_eq!(status.state, ConnectionState::Error);
        assert_eq!(status.error.unwrap().message, format!("{failure} failed"));
    }
}

#[tokio::test]
async fn cleans_a_runtime_whose_identity_does_not_match_its_entry() {
    let created = Created::default();
    let manager = manager("default");
    manager
        .register(
            identity("default"),
            fake_factory("wrong", FakeOptions::default(), created.clone()),
        )
        .unwrap();
    let error = manager.start_default().await.unwrap_err();
    assert!(
        error.contains("runtime identity mismatch: expected default, received wrong"),
        "{error}"
    );
    assert_eq!(nth(&created, 0).stops(), 1);
    assert!(manager.default_runtime().is_none());
    assert_eq!(
        manager.status("default").unwrap().state,
        ConnectionState::Error
    );
}

fn states(statuses: &Arc<Mutex<Vec<ConnectionStatus>>>) -> Vec<ConnectionState> {
    statuses.lock().unwrap().iter().map(|s| s.state).collect()
}

#[tokio::test]
async fn publishes_deterministic_lifecycle_transitions() {
    let (manager, statuses) = observed("default");
    manager
        .register(identity("default"), plain("default"))
        .unwrap();
    manager.start_default().await.unwrap();
    manager.stop("default").await.unwrap();
    use ConnectionState::*;
    assert_eq!(
        states(&statuses),
        [Disconnected, Connecting, Ready, Stopping, Disconnected]
    );
}

/// A manager whose observer acts on its own transitions.
fn reentrant(
    default: &str,
    act: impl Fn(&ConnectionManager<FakeRuntime>, &ConnectionStatus) + Send + Sync + 'static,
) -> ConnectionManager<FakeRuntime> {
    let slot: Arc<Mutex<Option<ConnectionManager<FakeRuntime>>>> = Arc::default();
    let seen = slot.clone();
    let manager = ConnectionManager::new(
        default,
        Some(Arc::new(move |status| {
            let manager = seen.lock().unwrap().clone();
            if let Some(manager) = manager {
                act(&manager, &status);
            }
        })),
        None,
    );
    *slot.lock().unwrap() = Some(manager.clone());
    manager
}

#[tokio::test]
async fn serializes_a_reentrant_stop_requested_by_the_connecting_observer() {
    let stopping: Arc<Mutex<Option<Task>>> = Arc::default();
    let pending = stopping.clone();
    let asked = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let manager = reentrant("default", move |manager, status| {
        // The stop publishes again from inside this observer: no lock held.
        if status.state == ConnectionState::Connecting && !asked.swap(true, Ordering::SeqCst) {
            let stop = manager.stop("default");
            *pending.lock().unwrap() = Some(stop);
        }
    });
    let created = Created::default();
    manager
        .register(
            identity("default"),
            fake_factory("default", FakeOptions::default(), created.clone()),
        )
        .unwrap();
    let _ = manager.start_default().await;
    let stop = stopping.lock().unwrap().clone().unwrap();
    stop.await.unwrap();
    assert_eq!(created.lock().unwrap().len(), 1);
    let runtime = nth(&created, 0);
    assert_eq!(runtime.starts.load(Ordering::SeqCst), 1);
    assert_eq!(runtime.backgrounds.load(Ordering::SeqCst), 0);
    assert_eq!(runtime.stops(), 1);
    assert!(manager.default_runtime().is_none());
    assert_eq!(
        manager.status("default").unwrap().state,
        ConnectionState::Disconnected
    );
}

#[tokio::test]
async fn queues_a_reentrant_start_requested_by_the_stopping_observer() {
    let (old_tx, old_stop) = deferred();
    let restarting: Arc<Mutex<Option<Task>>> = Arc::default();
    let pending = restarting.clone();
    let manager = reentrant("default", move |manager, status| {
        let mut pending = pending.lock().unwrap();
        if status.state == ConnectionState::Stopping && pending.is_none() {
            *pending = Some(manager.start("default"));
        }
    });
    let created = Created::default();
    let factory: RuntimeFactory<FakeRuntime> = {
        let created = created.clone();
        Arc::new(move |context| {
            let first = created.lock().unwrap().is_empty();
            let options = if first {
                FakeOptions {
                    stop: Some(old_stop.clone()),
                    ..FakeOptions::default()
                }
            } else {
                FakeOptions::default()
            };
            fake_factory("default", options, created.clone())(context)
        })
    };
    manager.register(identity("default"), factory).unwrap();
    manager.start_default().await.unwrap();
    let stopping = manager.stop("default");
    assert!(restarting.lock().unwrap().is_some());
    old_tx.send(Ok(())).unwrap();
    stopping.await.unwrap();
    let restart = restarting.lock().unwrap().clone().unwrap();
    restart.await.unwrap();
    assert_eq!(created.lock().unwrap().len(), 2);
    assert_eq!(nth(&created, 0).stops(), 1);
    assert!(Arc::ptr_eq(
        &manager.default_ready_runtime().unwrap(),
        &nth(&created, 1)
    ));
    assert_eq!(
        manager.status("default").unwrap().state,
        ConnectionState::Ready
    );
}

#[tokio::test]
async fn shares_concurrent_stop_tasks_and_drains_the_runtime_once() {
    let (stop_tx, stop) = deferred();
    let created = Created::default();
    let manager = manager("default");
    manager
        .register(
            identity("default"),
            fake_factory(
                "default",
                FakeOptions {
                    stop: Some(stop),
                    ..FakeOptions::default()
                },
                created.clone(),
            ),
        )
        .unwrap();
    manager.start_default().await.unwrap();
    let first = manager.stop("default");
    let second = manager.stop("default");
    assert_eq!(
        manager.status("default").unwrap().state,
        ConnectionState::Stopping
    );
    assert_eq!(nth(&created, 0).stops(), 1);
    stop_tx.send(Ok(())).unwrap();
    first.await.unwrap();
    second.await.unwrap();
    assert_eq!(
        manager.status("default").unwrap().state,
        ConnectionState::Disconnected
    );
    assert!(manager.default_runtime().is_none());
}

#[tokio::test]
async fn queues_a_restart_behind_stop_while_initial_transport_is_pending() {
    let (transport_tx, transport) = deferred();
    let created = Created::default();
    let manager = manager("default");
    manager
        .register(
            identity("default"),
            fake_factory(
                "default",
                FakeOptions {
                    transport: Some(transport),
                    ..FakeOptions::default()
                },
                created.clone(),
            ),
        )
        .unwrap();
    let initial = manager.start_default();
    let stopping = manager.stop("default");
    let restarting = manager.start_default();
    transport_tx.send(Ok(())).unwrap();
    let (initial, stopping, restarting) = tokio::join!(initial, stopping, restarting);
    initial.unwrap();
    stopping.unwrap();
    restarting.unwrap();
    assert_eq!(created.lock().unwrap().len(), 2);
    assert_eq!(nth(&created, 0).stops(), 1);
    assert!(Arc::ptr_eq(
        &manager.default_runtime().unwrap(),
        &nth(&created, 1)
    ));
    assert!(Arc::ptr_eq(
        &manager.default_ready_runtime().unwrap(),
        &nth(&created, 1)
    ));
    assert_eq!(
        manager.status("default").unwrap().state,
        ConnectionState::Ready
    );
}

#[tokio::test]
async fn runtime_failure_immediately_invalidates_its_generation_and_reports_reconnecting() {
    let created = Created::default();
    let (manager, statuses) = observed("default");
    manager
        .register(
            identity("default"),
            fake_factory("default", FakeOptions::default(), created.clone()),
        )
        .unwrap();
    manager.start_default().await.unwrap();
    let lease = manager.ready_runtime_lease("default").unwrap().unwrap();
    let ready_generation = lease.generation;
    let runtime = nth(&created, 0);
    runtime.context.report_error("tunnel exited", true);
    assert!(!lease.is_current());
    assert!(!runtime.context.is_current());
    let status = manager.status("default").unwrap();
    assert_eq!(status.state, ConnectionState::Reconnecting);
    assert_eq!(status.generation, ready_generation + 1);
    assert_eq!(status.error.unwrap().message, "tunnel exited");
    assert!(
        manager
            .mark_reconnecting("default", "retry queued")
            .unwrap()
    );
    let last = statuses.lock().unwrap().last().cloned().unwrap();
    assert_eq!(last.state, ConnectionState::Reconnecting);
    assert_eq!(last.error.unwrap().message, "retry queued");
    manager
        .retire_failed_runtime("default")
        .unwrap()
        .await
        .unwrap();
    assert_eq!(runtime.stops(), 1);
    assert!(manager.current_runtime("default").unwrap().is_none());
    assert_eq!(
        manager.status("default").unwrap().state,
        ConnectionState::Reconnecting
    );
}

#[tokio::test]
async fn does_not_resurrect_a_runtime_when_stop_cancels_a_reconnect() {
    let (stop_tx, stop) = deferred();
    let created = Created::default();
    let manager = manager("default");
    manager
        .register(
            identity("default"),
            fake_factory(
                "default",
                FakeOptions {
                    stop: Some(stop),
                    ..FakeOptions::default()
                },
                created.clone(),
            ),
        )
        .unwrap();
    manager.start_default().await.unwrap();
    nth(&created, 0)
        .context
        .report_error("retry requested", false);
    assert!(manager.default_ready_runtime().is_none());
    let reconnect = manager.start_default();
    let stopping = manager.stop("default");
    stop_tx.send(Ok(())).unwrap();
    let (reconnect, stopping) = tokio::join!(reconnect, stopping);
    reconnect.unwrap();
    stopping.unwrap();
    assert_eq!(created.lock().unwrap().len(), 1);
    assert!(manager.default_runtime().is_none());
    assert_eq!(
        manager.status("default").unwrap().state,
        ConnectionState::Disconnected
    );
}

#[tokio::test]
async fn a_queued_restart_constructs_the_replacement_factory() {
    let (old_tx, old_stop) = deferred();
    let old = Created::default();
    let replacements = Created::default();
    let manager = manager("default");
    manager
        .register(
            identity("default"),
            fake_factory(
                "default",
                FakeOptions {
                    stop: Some(old_stop),
                    ..FakeOptions::default()
                },
                old.clone(),
            ),
        )
        .unwrap();
    manager.start_default().await.unwrap();
    let stopping = manager.stop("default");
    let restarting = manager.start_default();
    let replacing = {
        let manager = manager.clone();
        let replacements = replacements.clone();
        tokio::spawn(async move {
            manager
                .replace(
                    ConnectionIdentity::new("default", "replacement", "test"),
                    fake_factory("default", FakeOptions::default(), replacements),
                )
                .await
        })
    };
    tokio::task::yield_now().await;
    old_tx.send(Ok(())).unwrap();
    let (stopping, restarting) = tokio::join!(stopping, restarting);
    stopping.unwrap();
    restarting.unwrap();
    replacing.await.unwrap().unwrap();
    assert_eq!(old.lock().unwrap().len(), 1);
    assert_eq!(replacements.lock().unwrap().len(), 1);
    let replacement = nth(&replacements, 0);
    assert!(Arc::ptr_eq(
        &manager.default_runtime().unwrap(),
        &replacement
    ));
    assert!(Arc::ptr_eq(
        &manager.default_ready_runtime().unwrap(),
        &replacement
    ));
    let status = manager.status("default").unwrap();
    assert_eq!(
        (status.label.as_str(), status.state),
        ("replacement", ConnectionState::Ready)
    );
}

#[tokio::test]
async fn suppresses_stale_generation_reports_across_replacement() {
    let retired = Created::default();
    let replacements = Created::default();
    let manager = manager("default");
    manager
        .register(
            identity("default"),
            fake_factory("default", FakeOptions::default(), retired.clone()),
        )
        .unwrap();
    manager.start_default().await.unwrap();
    let old = nth(&retired, 0);
    assert!(old.context.is_current());
    manager
        .replace(
            ConnectionIdentity::new("default", "replacement", "test"),
            fake_factory("default", FakeOptions::default(), replacements.clone()),
        )
        .await
        .unwrap();
    old.context.report_error("stale secret", false);
    assert!(!old.context.is_current());
    let status = manager.status("default").unwrap();
    assert_eq!(
        (status.label.as_str(), status.state),
        ("replacement", ConnectionState::Disconnected)
    );
    assert!(status.error.is_none());
    manager.start_default().await.unwrap();
    assert!(nth(&replacements, 0).context.is_current());
    old.context.report_error("still stale", false);
    assert_eq!(
        manager.status("default").unwrap().state,
        ConnectionState::Ready
    );
}

#[tokio::test]
async fn records_synchronous_runtime_stop_failures_without_blocking_peers() {
    let second = Created::default();
    let manager = manager("first");
    manager
        .register(
            identity("first"),
            fake_factory(
                "first",
                FakeOptions {
                    stop: Some(failed("synchronous stop failure")),
                    ..FakeOptions::default()
                },
                Created::default(),
            ),
        )
        .unwrap();
    manager
        .register(
            identity("second"),
            fake_factory("second", FakeOptions::default(), second.clone()),
        )
        .unwrap();
    let (first, other) = tokio::join!(manager.start("first"), manager.start("second"));
    first.unwrap();
    other.unwrap();
    manager.stop_all().await.unwrap();
    assert_eq!(nth(&second, 0).stops(), 1);
    assert!(manager.current_runtimes().is_empty());
    let status = manager.status("first").unwrap();
    assert_eq!(status.state, ConnectionState::Error);
    assert_eq!(status.error.unwrap().message, "synchronous stop failure");
    assert_eq!(
        manager.status("second").unwrap().state,
        ConnectionState::Disconnected
    );
}

#[tokio::test]
async fn rejects_reentrant_starts_before_shutdown_publishes_stopping() {
    let reentrant_start: Arc<Mutex<Option<Task>>> = Arc::default();
    let pending = reentrant_start.clone();
    let manager = reentrant("first", move |manager, status| {
        if status.id == "first" && status.state == ConnectionState::Stopping {
            *pending.lock().unwrap() = Some(manager.start("second"));
        }
    });
    for id in ["first", "second"] {
        manager.register(identity(id), plain(id)).unwrap();
        manager.start(id).await.unwrap();
    }
    manager.stop_all().await.unwrap();
    let start = reentrant_start.lock().unwrap().clone().unwrap();
    assert!(
        start
            .await
            .unwrap_err()
            .contains("connection manager is stopping")
    );
    assert!(manager.current_runtimes().is_empty());
}

#[tokio::test]
async fn stops_every_current_runtime_exactly_once_during_manager_shutdown() {
    let created = Created::default();
    let manager = manager("first");
    for id in ["first", "second"] {
        manager
            .register(
                identity(id),
                fake_factory(id, FakeOptions::default(), created.clone()),
            )
            .unwrap();
        manager.start(id).await.unwrap();
    }
    let first = manager.stop_all();
    let second = manager.stop_all();
    first.await.unwrap();
    second.await.unwrap();
    let stops: Vec<usize> = created.lock().unwrap().iter().map(|r| r.stops()).collect();
    assert_eq!(stops, [1, 1]);
    assert!(manager.current_runtimes().is_empty());
    let states: Vec<ConnectionState> = manager.list().iter().map(|s| s.state).collect();
    assert_eq!(
        states,
        [ConnectionState::Disconnected, ConnectionState::Disconnected]
    );
    assert!(
        manager
            .register(identity("late"), plain("late"))
            .unwrap_err()
            .contains("connection manager is stopping")
    );
}
