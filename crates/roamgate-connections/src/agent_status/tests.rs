//! server/src/connections/agent-status-subscription.test.ts, against a fake
//! Herdr on a unix socket.

use roamgate_base::clock::SystemClock;
use roamgate_herdr::control::{ClientEvent, HerdrClientOptions};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{UnixListener, UnixStream};
use tokio::sync::oneshot;

use super::*;

type Responder = oneshot::Sender<()>;

struct SubscribeCall {
    subscriptions: Value,
    socket: Arc<tokio::sync::Mutex<Option<UnixStream>>>,
}

#[derive(Clone, Default)]
struct FakeHerdr {
    panes: Arc<Mutex<Value>>,
    defer_lists: Arc<AtomicBool>,
    deferred: Arc<Mutex<Vec<Responder>>>,
    calls: Arc<Mutex<Vec<SubscribeCall>>>,
    /// The first subscription is refused with this error.
    refuse_first: Arc<Mutex<Option<String>>>,
}

impl FakeHerdr {
    fn set_panes(&self, panes: Value) {
        *self.panes.lock().unwrap() = panes;
    }
    fn subscribe_count(&self) -> usize {
        self.calls.lock().unwrap().len()
    }
    fn subscriptions(&self, index: usize) -> Value {
        self.calls.lock().unwrap()[index].subscriptions.clone()
    }
    fn socket(&self, index: usize) -> Arc<tokio::sync::Mutex<Option<UnixStream>>> {
        self.calls.lock().unwrap()[index].socket.clone()
    }
}

fn start(fake: &FakeHerdr) -> (tempfile::TempDir, String) {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("herdr.sock");
    let listener = UnixListener::bind(&path).unwrap();
    let fake = fake.clone();
    tokio::spawn(async move {
        loop {
            let Ok((mut stream, _)) = listener.accept().await else {
                return;
            };
            let fake = fake.clone();
            tokio::spawn(async move {
                let mut input = Vec::new();
                let mut chunk = vec![0u8; 4096];
                let request: Value = loop {
                    let read = stream.read(&mut chunk).await.unwrap_or(0);
                    if read == 0 {
                        return;
                    }
                    input.extend_from_slice(&chunk[..read]);
                    if let Some(end) = input.iter().position(|b| *b == b'\n') {
                        break serde_json::from_slice(&input[..end]).unwrap();
                    }
                };
                match request["method"].as_str().unwrap() {
                    "pane.list" => {
                        if fake.defer_lists.load(Ordering::SeqCst) {
                            let (tx, rx) = oneshot::channel();
                            fake.deferred.lock().unwrap().push(tx);
                            let _ = rx.await;
                        }
                        let panes = fake.panes.lock().unwrap().clone();
                        let line = json!({"id": request["id"], "result": {"panes": panes}});
                        let _ = stream.write_all(format!("{line}\n").as_bytes()).await;
                    }
                    "events.subscribe" => {
                        let refusal = {
                            let mut refuse = fake.refuse_first.lock().unwrap();
                            if fake.calls.lock().unwrap().is_empty() {
                                refuse.take()
                            } else {
                                None
                            }
                        };
                        let line = match &refusal {
                            Some(message) => json!({"id": "sub", "error": {"message": message}}),
                            None => {
                                json!({"id": request["id"], "result": {"type": "subscription_started"}})
                            }
                        };
                        let _ = stream.write_all(format!("{line}\n").as_bytes()).await;
                        let socket =
                            Arc::new(tokio::sync::Mutex::new(refusal.is_none().then_some(stream)));
                        fake.calls.lock().unwrap().push(SubscribeCall {
                            subscriptions: request["params"]["subscriptions"].clone(),
                            socket,
                        });
                    }
                    _ => {
                        let line = json!({"id": request["id"], "result": {}});
                        let _ = stream.write_all(format!("{line}\n").as_bytes()).await;
                    }
                }
            });
        }
    });
    (dir, path.to_str().unwrap().to_owned())
}

fn agent_pane(pane_id: &str) -> Value {
    json!({"pane_id": pane_id, "agent": "pi", "agent_status": "idle"})
}

fn plain_pane(pane_id: &str) -> Value {
    json!({"pane_id": pane_id, "agent_status": "unknown"})
}

fn client(path: &str) -> HerdrClient {
    HerdrClient::new(
        path,
        HerdrClientOptions {
            read_reuse_ms: Some(0.0),
            ..HerdrClientOptions::default()
        },
    )
}

fn quick_args(herdr: Arc<dyn StatusHerdr>, poll_ms: u64) -> AgentStatusArgs {
    let mut args = AgentStatusArgs::new(herdr, "test", Arc::new(SystemClock));
    args.retry_delay = Duration::from_millis(10);
    args.rebuild_debounce = Duration::from_millis(5);
    args.membership_poll = Duration::from_millis(poll_ms);
    args
}

async fn wait_for(condition: impl Fn() -> bool) {
    for _ in 0..400 {
        if condition() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    panic!("condition was not met before the timeout");
}

fn subscription_for(ids: &[&str]) -> Value {
    Value::Array(
        ids.iter()
            .map(|id| json!({"type": "pane.agent_status_changed", "pane_id": id}))
            .collect(),
    )
}

#[test]
fn collects_sorted_pane_ids_that_currently_host_an_agent() {
    let mut empty_agent = agent_pane("w1:p1");
    empty_agent["agent"] = json!("");
    assert_eq!(
        agent_pane_ids_from_pane_list(&json!({"panes": [
            agent_pane("w1:p2"),
            plain_pane("w1:p1"),
            empty_agent,
            agent_pane("w1:p3"),
            {"pane_id": 7, "agent": "pi"},
            "junk",
            agent_pane("w1:p2"),
        ]})),
        ["w1:p2", "w1:p3"]
    );
    assert!(agent_pane_ids_from_pane_list(&json!({})).is_empty());
    assert!(agent_pane_ids_from_pane_list(&Value::Null).is_empty());
    let ids = |list: &[&str]| list.iter().map(|s| s.to_string()).collect::<Vec<_>>();
    assert!(same_pane_ids(&ids(&["a", "b"]), &ids(&["a", "b"])));
    assert!(!same_pane_ids(&ids(&["a", "b"]), &ids(&["b", "a"])));
    assert!(!same_pane_ids(&ids(&["a"]), &ids(&["a", "b"])));
}

#[tokio::test]
async fn subscribes_per_agent_pane_and_forwards_status_events() {
    let fake = FakeHerdr::default();
    fake.set_panes(json!([agent_pane("w1:p1"), plain_pane("w1:p2")]));
    let (_dir, path) = start(&fake);
    let herdr = client(&path);
    let mut events = herdr.events();
    let lists = Arc::new(Mutex::new(Vec::<(Value, Option<i64>)>::new()));
    let mut args = quick_args(Arc::new(herdr.clone()), 50);
    args.on_pane_list_start = Some(Arc::new(|| 17));
    let seen = lists.clone();
    args.on_pane_list = Some(Arc::new(move |result, revision| {
        seen.lock().unwrap().push((result.clone(), revision))
    }));
    let status = AgentStatusSubscriptionLoop::new(args);
    status.start();
    wait_for(|| fake.subscribe_count() == 1).await;
    assert_eq!(
        lists.lock().unwrap()[0],
        (
            json!({"panes": [agent_pane("w1:p1"), plain_pane("w1:p2")]}),
            Some(17)
        )
    );
    assert_eq!(fake.subscriptions(0), subscription_for(&["w1:p1"]));
    let socket = fake.socket(0);
    let event = json!({"event": "pane.agent_status_changed", "data": {"pane_id": "w1:p1", "workspace_id": "w1", "agent_status": "working", "agent": "pi"}});
    socket
        .lock()
        .await
        .as_mut()
        .unwrap()
        .write_all(format!("{event}\n").as_bytes())
        .await
        .unwrap();
    let received = loop {
        if let ClientEvent::Event(event) = events.recv().await.unwrap() {
            break event;
        }
    };
    assert_eq!(received["data"]["agent_status"], "working");
    status.stop().await;
    assert!(!status.is_running());
}

#[tokio::test]
async fn rebuilds_the_subscription_when_a_membership_event_changes_the_pane_set() {
    let fake = FakeHerdr::default();
    fake.set_panes(json!([agent_pane("w1:p1")]));
    let (_dir, path) = start(&fake);
    let status = AgentStatusSubscriptionLoop::new(quick_args(Arc::new(client(&path)), 10_000));
    status.start();
    wait_for(|| fake.subscribe_count() == 1).await;
    fake.set_panes(json!([agent_pane("w1:p1"), agent_pane("w1:p2")]));
    status.handle_herdr_event(
        &json!({"event": "pane.agent_detected", "data": {"type": "pane.agent_detected"}}),
    );
    wait_for(|| fake.subscribe_count() == 2).await;
    assert_eq!(fake.subscriptions(1), subscription_for(&["w1:p1", "w1:p2"]));
    fake.set_panes(json!([agent_pane("w1:p2")]));
    status.handle_herdr_event(
        &json!({"event": "workspace.closed", "data": {"type": "workspace.closed"}}),
    );
    wait_for(|| fake.subscribe_count() == 3).await;
    assert_eq!(fake.subscriptions(2), subscription_for(&["w1:p2"]));
    status.stop().await;
}

#[tokio::test]
async fn rebuilds_immediately_when_a_pane_move_replaces_the_subscribed_pane_id() {
    let fake = FakeHerdr::default();
    fake.set_panes(json!([agent_pane("w1:p1")]));
    let (_dir, path) = start(&fake);
    let status = AgentStatusSubscriptionLoop::new(quick_args(Arc::new(client(&path)), 10_000));
    status.start();
    wait_for(|| fake.subscribe_count() == 1).await;
    fake.set_panes(json!([agent_pane("w2:p2")]));
    status.handle_herdr_event(&json!({"event": "pane.moved", "data": {
        "type": "pane_moved", "previous_pane_id": "w1:p1", "previous_workspace_id": "w1",
        "pane": {"pane_id": "w2:p2", "workspace_id": "w2", "agent": "pi"},
    }}));
    wait_for(|| fake.subscribe_count() == 2).await;
    assert_eq!(fake.subscriptions(1), subscription_for(&["w2:p2"]));
    status.stop().await;
}

#[tokio::test]
async fn ignores_unrelated_events_and_membership_events_that_do_not_change_the_set() {
    let fake = FakeHerdr::default();
    fake.set_panes(json!([agent_pane("w1:p1")]));
    let (_dir, path) = start(&fake);
    let status = AgentStatusSubscriptionLoop::new(quick_args(Arc::new(client(&path)), 10_000));
    status.start();
    wait_for(|| fake.subscribe_count() == 1).await;
    status.handle_herdr_event(&json!({"event": "pane_focused", "data": {"type": "pane_focused"}}));
    status.handle_herdr_event(
        &json!({"event": "pane.agent_status_changed", "data": {"pane_id": "w1:p1"}}),
    );
    status.handle_herdr_event(
        &json!({"event": "pane_closed", "data": {"type": "pane_closed", "pane_id": "w1:p9"}}),
    );
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert_eq!(fake.subscribe_count(), 1);
    status.stop().await;
}

#[tokio::test]
async fn retries_with_a_fresh_listing_when_herdr_rejects_the_subscription() {
    let fake = FakeHerdr::default();
    fake.set_panes(json!([agent_pane("w1:p1")]));
    *fake.refuse_first.lock().unwrap() = Some("pane not found".into());
    let (_dir, path) = start(&fake);
    let errors = Arc::new(Mutex::new(Vec::<String>::new()));
    let mut args = quick_args(Arc::new(client(&path)), 10_000);
    let seen = errors.clone();
    args.on_subscribe_error = Some(Arc::new(move |error| seen.lock().unwrap().push(error)));
    let status = AgentStatusSubscriptionLoop::new(args);
    status.start();
    wait_for(|| fake.subscribe_count() == 2).await;
    assert_eq!(*errors.lock().unwrap(), ["pane not found"]);
    status.stop().await;
}

#[tokio::test]
async fn waits_for_an_agent_pane_before_subscribing() {
    let fake = FakeHerdr::default();
    fake.set_panes(json!([plain_pane("w1:p1")]));
    let (_dir, path) = start(&fake);
    let status = AgentStatusSubscriptionLoop::new(quick_args(Arc::new(client(&path)), 10_000));
    status.start();
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert_eq!(fake.subscribe_count(), 0);
    fake.set_panes(json!([agent_pane("w1:p1")]));
    status.handle_herdr_event(
        &json!({"event": "pane_agent_detected", "data": {"type": "pane_agent_detected"}}),
    );
    wait_for(|| fake.subscribe_count() == 1).await;
    status.stop().await;
}

#[tokio::test]
async fn resubscribes_when_the_subscription_socket_closes() {
    let fake = FakeHerdr::default();
    fake.set_panes(json!([agent_pane("w1:p1")]));
    let (_dir, path) = start(&fake);
    let status = AgentStatusSubscriptionLoop::new(quick_args(Arc::new(client(&path)), 10_000));
    status.start();
    wait_for(|| fake.subscribe_count() == 1).await;
    fake.socket(0).lock().await.take();
    wait_for(|| fake.subscribe_count() == 2).await;
    status.stop().await;
}

#[tokio::test]
async fn honors_a_rebuild_requested_while_a_listing_was_in_flight() {
    let fake = FakeHerdr::default();
    fake.set_panes(json!([]));
    fake.defer_lists.store(true, Ordering::SeqCst);
    let (_dir, path) = start(&fake);
    let mut args = quick_args(Arc::new(client(&path)), 10_000);
    args.rebuild_debounce = Duration::ZERO;
    let status = AgentStatusSubscriptionLoop::new(args);
    status.start();
    wait_for(|| fake.deferred.lock().unwrap().len() == 1).await;
    status.handle_herdr_event(
        &json!({"event": "pane_agent_detected", "data": {"type": "pane_agent_detected"}}),
    );
    tokio::time::sleep(Duration::from_millis(20)).await;
    // The listing predates the agent; the request must not wait for the
    // fallback poll.
    fake.defer_lists.store(false, Ordering::SeqCst);
    let respond = fake.deferred.lock().unwrap().remove(0);
    let _ = respond.send(());
    fake.set_panes(json!([agent_pane("w1:p1")]));
    wait_for(|| fake.subscribe_count() == 1).await;
    assert_eq!(fake.subscriptions(0), subscription_for(&["w1:p1"]));
    status.stop().await;
}

/// A Herdr whose first subscribe fails before anything is sent.
struct Flaky {
    client: HerdrClient,
    thrown: AtomicBool,
}

impl StatusHerdr for Flaky {
    fn pane_list(&self) -> BoxFuture<'static, Result<Value, String>> {
        StatusHerdr::pane_list(&self.client)
    }
    fn subscribe(&self, subscriptions: Vec<Subscription>) -> Result<LoopSubscription, String> {
        if !self.thrown.swap(true, Ordering::SeqCst) {
            return Err("boom".into());
        }
        StatusHerdr::subscribe(&self.client, subscriptions)
    }
}

#[tokio::test]
async fn recovers_when_subscribe_throws_synchronously() {
    let fake = FakeHerdr::default();
    fake.set_panes(json!([agent_pane("w1:p1")]));
    let (_dir, path) = start(&fake);
    let errors = Arc::new(Mutex::new(Vec::<String>::new()));
    let mut args = quick_args(
        Arc::new(Flaky {
            client: client(&path),
            thrown: AtomicBool::new(false),
        }),
        10_000,
    );
    let seen = errors.clone();
    args.on_subscribe_error = Some(Arc::new(move |error| seen.lock().unwrap().push(error)));
    let status = AgentStatusSubscriptionLoop::new(args);
    status.start();
    wait_for(|| fake.subscribe_count() == 1).await;
    assert_eq!(*errors.lock().unwrap(), ["boom"]);
    assert!(status.is_running());
    status.stop().await;
}

#[tokio::test]
async fn stop_is_idempotent_and_closes_the_active_subscription() {
    let fake = FakeHerdr::default();
    fake.set_panes(json!([agent_pane("w1:p1")]));
    let (_dir, path) = start(&fake);
    let status = AgentStatusSubscriptionLoop::new(quick_args(Arc::new(client(&path)), 10_000));
    status.start();
    wait_for(|| fake.subscribe_count() == 1).await;
    let socket = fake.socket(0);
    tokio::join!(status.stop(), status.stop());
    assert!(!status.is_running());
    // The server sees the client close the subscription's socket.
    let mut buffer = [0u8; 16];
    let closed = tokio::time::timeout(Duration::from_secs(2), async {
        let mut guard = socket.lock().await;
        let stream = guard.as_mut().unwrap();
        loop {
            match stream.read(&mut buffer).await {
                Ok(0) | Err(_) => break,
                Ok(_) => {}
            }
        }
    })
    .await;
    assert!(closed.is_ok());
    let calls = fake.subscribe_count();
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert_eq!(fake.subscribe_count(), calls);
}
