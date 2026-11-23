//! The host runtime: server/src/connections/runtime.test.ts's rows that are
//! the transport's and the subscriptions' (the composition's other rows
//! belong to the front's families), and the handover to the front.

use std::time::Duration;

use roamgate_base::clock::SystemClock;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{UnixListener, UnixStream};

use super::*;

/// A fake Herdr control socket: answers `pane.list` with no panes and acks
/// each `events.subscribe`, keeping its socket until the test closes it.
type HeldSocket = Arc<tokio::sync::Mutex<Option<UnixStream>>>;

#[derive(Clone, Default)]
struct FakeHerdr {
    subscriptions: Arc<Mutex<Vec<(Value, HeldSocket)>>>,
}

impl FakeHerdr {
    fn event_subscriptions(&self) -> Vec<HeldSocket> {
        self.subscriptions
            .lock()
            .unwrap()
            .iter()
            .filter(|(types, _)| {
                types
                    .as_array()
                    .is_some_and(|all| all.iter().any(|each| each["type"] == "layout.updated"))
            })
            .map(|(_, socket)| socket.clone())
            .collect()
    }
}

fn start_fake(fake: &FakeHerdr) -> (tempfile::TempDir, String) {
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
                    "events.subscribe" => {
                        let line = json!({"id": request["id"], "result": {"type": "subscription_started"}});
                        let _ = stream.write_all(format!("{line}\n").as_bytes()).await;
                        fake.subscriptions.lock().unwrap().push((
                            request["params"]["subscriptions"].clone(),
                            Arc::new(tokio::sync::Mutex::new(Some(stream))),
                        ));
                    }
                    "pane.list" => {
                        let line = json!({"id": request["id"], "result": {"panes": []}});
                        let _ = stream.write_all(format!("{line}\n").as_bytes()).await;
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

#[derive(Default)]
struct Hooks {
    log: Mutex<Vec<String>>,
    events: Mutex<Vec<(u64, HostEvent)>>,
    fail_start: Mutex<Option<RuntimeError>>,
}

impl Hooks {
    fn log(&self) -> Vec<String> {
        self.log.lock().unwrap().clone()
    }
    fn events(&self) -> Vec<HostEvent> {
        self.events
            .lock()
            .unwrap()
            .iter()
            .map(|(_, event)| event.clone())
            .collect()
    }
}

impl HostHooks for Hooks {
    fn runtime_start(&self, start: RuntimeStart) -> BoxFuture<'static, Result<(), RuntimeError>> {
        self.log.lock().unwrap().push(format!(
            "start {} {} {}",
            start.identity.id, start.identity.label, start.generation
        ));
        let failure = self.fail_start.lock().unwrap().clone();
        async move { failure.map_or(Ok(()), Err) }.boxed()
    }
    fn runtime_stop(&self, connection_id: &str, generation: u64) -> BoxFuture<'static, ()> {
        self.log
            .lock()
            .unwrap()
            .push(format!("stop {connection_id} {generation}"));
        async {}.boxed()
    }
    fn events(
        &self,
        _connection_id: &str,
        generation: u64,
        events: Vec<HostEvent>,
    ) -> BoxFuture<'static, ()> {
        let mut seen = self.events.lock().unwrap();
        for event in events {
            seen.push((generation, event));
        }
        async {}.boxed()
    }
    fn master_ready(&self, connection_id: &str, generation: u64, host: &str, control_path: &str) {
        self.log.lock().unwrap().push(format!(
            "master {connection_id} {generation} {host} {control_path}"
        ));
    }
}

fn probe_ok() -> Probe {
    Arc::new(|_, _| async { Ok(json!({"ok": true})) }.boxed())
}

fn runtime(
    identity: ConnectionIdentity,
    socket: &str,
    hooks: Arc<Hooks>,
    probe: Probe,
) -> Arc<HostRuntime> {
    let clock: SharedClock = Arc::new(SystemClock);
    let run_process: RunProcess = Arc::new(|_, _, _| {
        async { Err::<roamgate_exec::ssh::tunnel::ProcessOutput, _>("no host".into()) }.boxed()
    });
    HostRuntime::new(HostRuntimeArgs {
        identity,
        context: RuntimeContext::detached(3),
        config: SshTunnelConfig {
            socket_path: socket.into(),
            client_socket_path: format!("{socket}.client"),
            ..SshTunnelConfig::default()
        },
        sessions: SshSessions::new(clock.clone()),
        run_process,
        tunnel_deps: TunnelDeps::default(),
        clock,
        logger: Logger::silent(),
        hooks,
        probe,
        on_transport_exit: None,
        skip_front: false,
    })
    .unwrap()
}

async fn wait_for(condition: impl Fn() -> bool) {
    for _ in 0..400 {
        if condition() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    panic!("condition never held");
}

#[tokio::test]
async fn legacy_runtime_exposes_and_reports_its_configured_connection_identity() {
    let fake = FakeHerdr::default();
    let (_dir, socket) = start_fake(&fake);
    let hooks = Arc::new(Hooks::default());
    let identity = ConnectionIdentity::new("work", "Work laptop", "local-profile");
    let runtime = runtime(identity.clone(), &socket, hooks.clone(), probe_ok());
    assert_eq!(runtime.identity(), identity);
    runtime.start_transport().await.unwrap();
    runtime.start_background().await.unwrap();
    // The front builds its part under the same identity and generation.
    assert_eq!(hooks.log(), vec!["start work Work laptop 3"]);
    runtime.stop().await.unwrap();
    assert_eq!(hooks.log(), vec!["start work Work laptop 3", "stop work 3"]);
}

#[tokio::test]
async fn layout_subscription_ack_and_reconnect_request_browser_reconciliation() {
    let fake = FakeHerdr::default();
    let (_dir, socket) = start_fake(&fake);
    let hooks = Arc::new(Hooks::default());
    let runtime = runtime(
        ConnectionIdentity::legacy_default(),
        &socket,
        hooks.clone(),
        probe_ok(),
    );
    runtime.start_transport().await.unwrap();
    runtime.start_background().await.unwrap();
    // The first acknowledgement asks browsers to reconcile.
    wait_for(|| hooks.events().contains(&HostEvent::Ready)).await;
    let first = fake.event_subscriptions();
    assert_eq!(first.len(), 1);
    // An event on the subscription reaches the front after it.
    {
        let socket = first[0].clone();
        let mut socket = socket.lock().await;
        let line = json!({"event": "layout.updated", "data": {"workspace_id": "w1"}});
        socket
            .as_mut()
            .unwrap()
            .write_all(format!("{line}\n").as_bytes())
            .await
            .unwrap();
    }
    wait_for(|| {
        hooks.events().iter().any(
            |event| matches!(event, HostEvent::Herdr(value) if value["event"] == "layout.updated"),
        )
    })
    .await;
    // Herdr closes it: the loop subscribes again and the new ACK asks for
    // reconciliation again.
    first[0].lock().await.take();
    wait_for(|| fake.event_subscriptions().len() == 2).await;
    wait_for(|| {
        hooks
            .events()
            .iter()
            .filter(|event| **event == HostEvent::Ready)
            .count()
            == 2
    })
    .await;
    let events = hooks.events();
    let ready = events.iter().position(|e| *e == HostEvent::Ready).unwrap();
    let layout = events
        .iter()
        .position(|e| matches!(e, HostEvent::Herdr(_)))
        .unwrap();
    assert!(ready < layout);
    runtime.stop().await.unwrap();
}

#[tokio::test]
async fn the_front_is_built_before_the_subscriptions_and_only_its_stop_follows() {
    let fake = FakeHerdr::default();
    let (_dir, socket) = start_fake(&fake);
    let hooks = Arc::new(Hooks::default());
    *hooks.fail_start.lock().unwrap() = Some(RuntimeError::new("front refused"));
    let runtime = runtime(
        ConnectionIdentity::legacy_default(),
        &socket,
        hooks.clone(),
        probe_ok(),
    );
    runtime.start_transport().await.unwrap();
    let error = runtime.start_background().await.unwrap_err();
    assert_eq!(error, "front refused");
    tokio::time::sleep(Duration::from_millis(50)).await;
    // Nothing subscribed for a front that has no runtime.
    assert!(fake.event_subscriptions().is_empty());
    runtime.stop().await.unwrap();
    // The front built nothing, so it is told no stop.
    assert_eq!(hooks.log(), vec!["start legacy-default Default 3"]);
}

#[tokio::test]
async fn a_failed_probe_fails_the_transport_with_its_retryable_kind() {
    let hooks = Arc::new(Hooks::default());
    let probe: Probe =
        Arc::new(|_, _| async { Err(RuntimeError::permanent("protocol 9 not supported")) }.boxed());
    let runtime = runtime(
        ConnectionIdentity::legacy_default(),
        "/nonexistent/herdr.sock",
        hooks.clone(),
        probe,
    );
    let error = runtime.start_transport().await.unwrap_err();
    assert_eq!(error, RuntimeError::permanent("protocol 9 not supported"));
    runtime.stop().await.unwrap();
    assert!(hooks.log().is_empty());
}

#[tokio::test]
async fn pane_listings_reach_the_front_with_their_start_in_order() {
    let fake = FakeHerdr::default();
    let (_dir, socket) = start_fake(&fake);
    let hooks = Arc::new(Hooks::default());
    let runtime = runtime(
        ConnectionIdentity::legacy_default(),
        &socket,
        hooks.clone(),
        probe_ok(),
    );
    runtime.start_transport().await.unwrap();
    runtime.start_background().await.unwrap();
    wait_for(|| {
        hooks
            .events()
            .iter()
            .any(|event| matches!(event, HostEvent::PaneList { .. }))
    })
    .await;
    let events = hooks.events();
    let start = events
        .iter()
        .find_map(|event| match event {
            HostEvent::PaneListStart { list, .. } => Some(*list),
            _ => None,
        })
        .unwrap();
    let (list, result) = events
        .iter()
        .find_map(|event| match event {
            HostEvent::PaneList { list, result } => Some((*list, result.clone())),
            _ => None,
        })
        .unwrap();
    assert_eq!(start, list);
    assert_eq!(result, json!({"panes": []}));
    assert!(
        hooks
            .events
            .lock()
            .unwrap()
            .iter()
            .all(|(generation, _)| *generation == 3)
    );
    runtime.stop().await.unwrap();
}

#[test]
fn a_master_ready_before_the_front_part_is_told_once_it_exists() {
    let fired = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let ready = MasterReady::default();
    let count = fired.clone();
    *ready.fire.lock().unwrap() = Some(Box::new(move || {
        count.fetch_add(1, Ordering::SeqCst);
    }));
    ready.ready();
    assert_eq!(fired.load(Ordering::SeqCst), 0);
    ready.front_started();
    assert_eq!(fired.load(Ordering::SeqCst), 1);
    // Ready again (a recycled master): told at once.
    ready.ready();
    assert_eq!(fired.load(Ordering::SeqCst), 2);
}
