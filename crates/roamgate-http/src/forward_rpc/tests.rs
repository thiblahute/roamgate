//! bridge/forward-rpc.test.ts, case for case.

use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::time::Duration;

use roamgate_base::clock::{SharedClock, TokioClock};
use roamgate_exec::ssh::forward::{ForwardDeps, MAX_LIVE_FORWARDS, roamgate_own_ports};
use roamgate_exec::ssh::supervised::{ChildControl, KillSignal, SupervisedSsh};
use tokio::sync::{oneshot, watch};

use super::*;

/// The TS `fakeProcess()`: a child that runs until killed (then exits 143)
/// or told to exit, and records its kills.
struct Fake {
    child: SupervisedSsh,
    control: ChildControl,
    killed: Arc<Mutex<Vec<KillSignal>>>,
}

fn fake() -> Fake {
    let killed: Arc<Mutex<Vec<KillSignal>>> = Arc::default();
    let seen = killed.clone();
    let (child, control) = SupervisedSsh::manual(move |signal, control| {
        seen.lock().unwrap().push(signal);
        control.exit(143);
        Ok(())
    });
    control.set_stderr("bind: Address already in use");
    Fake {
        child,
        control,
        killed,
    }
}

impl Fake {
    fn kills(&self) -> usize {
        self.killed.lock().unwrap().len()
    }
}

fn clock() -> SharedClock {
    Arc::new(TokioClock::starting_at(0))
}

/// Forwards whose spawn hands out `children` in order.
fn deps(children: Vec<SupervisedSsh>) -> ForwardDeps {
    let children = Arc::new(Mutex::new(children));
    ForwardDeps {
        spawn: Arc::new(move |_| Ok(children.lock().unwrap().remove(0))),
        is_port_free: Arc::new(|_| true),
        ..ForwardDeps::default()
    }
}

type Probe = Arc<dyn Fn(u16) -> BoxFuture<bool> + Send + Sync>;

fn probe(answer: impl Fn(u16) -> bool + Send + Sync + 'static) -> Probe {
    Arc::new(move |port| {
        let ready = answer(port);
        Box::pin(async move { ready })
    })
}

/// A scanner answering every scan with `answer`.
struct Scanner<F>(F);

impl<F> PortScan for Scanner<F>
where
    F: Fn(ScanCommand, u64) -> BoxFuture<Result<String, String>> + Send + Sync + 'static,
{
    fn run(&self, command: ScanCommand, timeout_ms: u64) -> BoxFuture<Result<String, String>> {
        (self.0)(command, timeout_ms)
    }
}

fn scanning(stdout: &'static str) -> Arc<dyn PortScan> {
    Arc::new(Scanner(move |_, _| -> BoxFuture<Result<String, String>> {
        Box::pin(async move { Ok(stdout.to_owned()) })
    }))
}

/// The TS `harness()`: the handler of an unnamed connection, its errors
/// marked.
#[derive(Clone)]
struct Harness {
    rpc: ForwardRpc,
    errors: Arc<Mutex<Vec<String>>>,
}

fn harness_with(
    forwards: &SshForwards,
    ssh_host: Option<&str>,
    scanner: Arc<dyn PortScan>,
) -> Harness {
    let host = ssh_host.map(str::to_owned);
    Harness {
        rpc: ForwardRpc::new(
            ReplyEnvelope::default(),
            move || host.clone(),
            scanner,
            forwards.clone(),
        ),
        errors: Arc::default(),
    }
}

fn harness(forwards: &SshForwards) -> Harness {
    harness_with(forwards, Some("user@desktop"), scanning(""))
}

impl Harness {
    async fn call_while(
        &self,
        method: &str,
        params: Value,
        current: impl Fn() -> bool + Send,
    ) -> Value {
        let params = params.as_object().cloned().unwrap_or_default();
        let reply = self
            .rpc
            .handle(Some(&Value::from("1")), method, &params, current)
            .await;
        if let Some(error) = reply.error {
            self.errors.lock().unwrap().push(error);
        }
        serde_json::from_str(&reply.payload).unwrap()
    }

    async fn call(&self, method: &str, params: Value) -> Value {
        self.call_while(method, params, || true).await
    }

    /// The call running on its own, as an un-awaited promise.
    fn start(&self, method: &'static str, params: Value) -> tokio::task::JoinHandle<Value> {
        let harness = self.clone();
        tokio::spawn(async move { harness.call(method, params).await })
    }
}

fn error_of(reply: &Value) -> &str {
    reply["error"]["message"].as_str().unwrap_or_default()
}

async fn tick() {
    for _ in 0..20 {
        tokio::task::yield_now().await;
    }
}

// forward.open readiness.

#[tokio::test(start_paused = true)]
async fn a_local_forward_is_reported_open_only_once_its_port_accepts_connections() {
    let process = fake();
    let bound = Arc::new(AtomicBool::new(false));
    let probes = Arc::new(AtomicUsize::new(0));
    let seen = (bound.clone(), probes.clone());
    let forwards = SshForwards::new(
        clock(),
        ForwardDeps {
            probe_port: probe(move |_| {
                if seen.1.fetch_add(1, Ordering::SeqCst) + 1 == 3 {
                    seen.0.store(true, Ordering::SeqCst);
                }
                seen.0.load(Ordering::SeqCst)
            }),
            poll_interval_ms: 0,
            ..deps(vec![process.child.clone()])
        },
    );
    let reply = harness(&forwards)
        .call("forward.open", json!({"remote_port": 5173}))
        .await;
    assert!(bound.load(Ordering::SeqCst));
    assert_eq!(reply["result"]["forward"]["local_port"], 5173);
    assert_eq!(reply["result"]["forward"]["state"], "open");
}

#[tokio::test(start_paused = true)]
async fn a_remote_forward_waits_for_sshs_confirmation_of_the_far_bind() {
    let process = fake();
    let forwards = SshForwards::new(clock(), deps(vec![process.child.clone()]));
    let pending = harness(&forwards).start(
        "forward.open",
        json!({"remote_port": 11434, "direction": "remote"}),
    );
    tick().await;
    process
        .control
        .emit_stderr("debug1: Authentication succeeded (publickey).\n");
    // Another port's confirmation is not ours.
    process
        .control
        .emit_stderr("debug1: remote forward success for: listen 127.0.0.1:9999, ");
    process.control.emit_stderr("connect localhost:9999\n");
    tick().await;
    assert!(!pending.is_finished());
    assert_eq!(forwards.list()[0].state, SshForwardState::Starting);
    // Split across chunks, as a pipe is free to deliver it.
    process
        .control
        .emit_stderr("debug1: remote forward success for: listen 127.0.0.1:11");
    process
        .control
        .emit_stderr("434, connect localhost:11434\n");
    assert_eq!(pending.await.unwrap()["result"]["forward"]["state"], "open");
}

#[tokio::test(start_paused = true)]
async fn a_forward_whose_ssh_exits_is_reported_failed_with_sshs_reason() {
    let process = fake();
    let forwards = SshForwards::new(
        clock(),
        ForwardDeps {
            probe_port: probe(|_| false),
            poll_interval_ms: 0,
            ..deps(vec![process.child.clone()])
        },
    );
    let pending = harness(&forwards).start("forward.open", json!({"remote_port": 5173}));
    tick().await;
    process.control.exit(255);
    let reply = pending.await.unwrap();
    assert!(!error_of(&reply).is_empty());
    assert_eq!(forwards.list()[0].state, SshForwardState::Failed);
}

#[tokio::test(start_paused = true)]
async fn a_forward_that_never_becomes_ready_is_killed_at_the_deadline() {
    let process = fake();
    let forwards = SshForwards::new(
        clock(),
        ForwardDeps {
            ready_timeout_ms: 20_000,
            ..deps(vec![process.child.clone()])
        },
    );
    let pending = harness(&forwards).start(
        "forward.open",
        json!({"remote_port": 11434, "direction": "remote"}),
    );
    tick().await;
    tokio::time::advance(Duration::from_millis(20_000)).await;
    let reply = pending.await.unwrap();
    assert!(error_of(&reply).contains("not ready"), "{reply}");
    assert_eq!(process.kills(), 1);
    assert_eq!(forwards.list()[0].state, SshForwardState::Failed);
}

// forward.open against a real ssh process: a stand-in ssh that binds (or
// confirms) only after a delay longer than any fixed grace period would
// allow, so the reply must wait for it.

#[cfg(unix)]
mod real_ssh {
    use std::os::unix::fs::PermissionsExt;
    use std::path::{Path, PathBuf};

    use roamgate_exec::process::ProcessRunner;

    use super::*;

    /// The fake ssh in `dir`. A local forward asks the test (through
    /// `listen-request`) to bind its port, as the TS one runs a listener;
    /// the bind writes `bound`. A remote forward writes `bound` and logs
    /// ssh's confirmation.
    fn install_fake_ssh(dir: &Path) -> PathBuf {
        let marker = dir.join("bound");
        let request = dir.join("listen-request");
        let script = format!(
            r#"#!/bin/sh
mode=""; spec=""
while [ $# -gt 0 ]; do
  case "$1" in
    -L|-R) mode="$1"; spec="$2"; shift 2 ;;
    *) shift ;;
  esac
done
port=$(echo "$spec" | cut -d: -f2)
sleep 0.6
if [ "$mode" = "-R" ]; then
  : > '{marker}'
  echo "debug1: remote forward success for: listen 127.0.0.1:$port, connect localhost:$port" >&2
  exec sleep 30
fi
echo "$port" > '{request}.tmp' && mv '{request}.tmp' '{request}'
exec sleep 30
"#,
            marker = marker.display(),
            request = request.display(),
        );
        let ssh = dir.join("ssh");
        std::fs::write(&ssh, script).unwrap();
        std::fs::set_permissions(&ssh, std::fs::Permissions::from_mode(0o755)).unwrap();
        ssh
    }

    /// Binds the port the fake ssh asks for, once it asks, and keeps it.
    fn serve_listen_requests(dir: &Path) -> std::thread::JoinHandle<()> {
        let request = dir.join("listen-request");
        let marker = dir.join("bound");
        std::thread::spawn(move || {
            for _ in 0..1000 {
                if let Ok(text) = std::fs::read_to_string(&request) {
                    let port: u16 = text.trim().parse().unwrap();
                    let listener = std::net::TcpListener::bind(("127.0.0.1", port)).unwrap();
                    std::fs::write(&marker, "").unwrap();
                    std::thread::sleep(Duration::from_secs(2));
                    drop(listener);
                    return;
                }
                std::thread::sleep(Duration::from_millis(10));
            }
        })
    }

    fn forwards(ssh: PathBuf) -> SshForwards {
        let runner = ProcessRunner::system();
        let spawn_runner = runner.clone();
        SshForwards::new(
            Arc::new(roamgate_base::clock::SystemClock),
            ForwardDeps {
                spawn: Arc::new(move |mut command| {
                    command.argv[0] = ssh.to_string_lossy().into_owned();
                    SupervisedSsh::spawn(&spawn_runner, &command)
                }),
                ..ForwardDeps::real(runner)
            },
        )
    }

    fn free_port() -> u16 {
        let server = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        server.local_addr().unwrap().port()
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_local_forward_that_binds_late_is_reported_open_only_once_it_is_reachable() {
        let dir = tempfile::tempdir().unwrap();
        let forwards = forwards(install_fake_ssh(dir.path()));
        let listening = serve_listen_requests(dir.path());
        let port = free_port();
        let reply = harness(&forwards)
            .call("forward.open", json!({"remote_port": port}))
            .await;
        assert_eq!(reply["result"]["forward"]["state"], "open", "{reply}");
        assert!(dir.path().join("bound").exists());
        let local = reply["result"]["forward"]["local_port"].as_u64().unwrap() as u16;
        assert!(
            tokio::net::TcpStream::connect(("127.0.0.1", local))
                .await
                .is_ok()
        );
        forwards.close_all();
        listening.join().unwrap();
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_remote_forward_is_reported_open_only_after_ssh_confirms_it() {
        let dir = tempfile::tempdir().unwrap();
        let forwards = forwards(install_fake_ssh(dir.path()));
        let reply = harness(&forwards)
            .call(
                "forward.open",
                json!({"remote_port": free_port(), "direction": "remote"}),
            )
            .await;
        assert_eq!(reply["result"]["forward"]["state"], "open", "{reply}");
        assert!(dir.path().join("bound").exists());
        forwards.close_all();
    }
}

// forward.candidates.

#[tokio::test(start_paused = true)]
async fn a_failed_scan_lists_nothing_instead_of_failing_the_request() {
    let forwards = SshForwards::new(clock(), deps(vec![fake().child]));
    let failing: Arc<dyn PortScan> =
        Arc::new(Scanner(|_, _| -> BoxFuture<Result<String, String>> {
            Box::pin(async { Err("netstat exited 64: illegal option -- l".to_owned()) })
        }));
    let harness = harness_with(&forwards, Some("user@desktop"), failing);
    for direction in ["local", "remote"] {
        let reply = harness
            .call("forward.candidates", json!({"direction": direction}))
            .await;
        assert!(reply.get("error").is_none());
        assert_eq!(reply["result"]["candidates"], json!([]));
    }
}

// Roamgate's own ports.

const OWN_SCAN: &str = concat!(
    "LISTEN 0 511 127.0.0.1:8787 0.0.0.0:* users:((\"roamgate\",pid=7,fd=7))\n",
    "LISTEN 0 511 127.0.0.1:5173 0.0.0.0:* users:((\"node\",pid=8,fd=7))\n",
    "LISTEN 0 511 127.0.0.1:11434 0.0.0.0:* users:((\"ollama\",pid=9,fd=7))",
);

#[tokio::test(start_paused = true)]
async fn are_neither_offered_nor_opened_as_remote_forwards() {
    let spawns = Arc::new(AtomicUsize::new(0));
    let counted = spawns.clone();
    let forwards = SshForwards::new(
        clock(),
        ForwardDeps {
            spawn: Arc::new(move |_| {
                counted.fetch_add(1, Ordering::SeqCst);
                Ok(fake().child)
            }),
            reserved_ports: Arc::new(|| roamgate_own_ports(8787, true)),
            ..ForwardDeps::default()
        },
    );
    let harness = harness_with(&forwards, Some("user@desktop"), scanning(OWN_SCAN));
    let remote = harness
        .call("forward.candidates", json!({"direction": "remote"}))
        .await;
    assert_eq!(
        remote["result"]["candidates"],
        json!([{"port": 11434, "process": "ollama"}])
    );
    // Bringing a remote 8787 here exposes nothing of ours, so it stays.
    let local = harness
        .call("forward.candidates", json!({"direction": "local"}))
        .await;
    let ports: Vec<u64> = local["result"]["candidates"]
        .as_array()
        .unwrap()
        .iter()
        .map(|candidate| candidate["port"].as_u64().unwrap())
        .collect();
    assert_eq!(ports, [5173, 8787, 11434]);
    for port in [8787, 5173] {
        let reply = harness
            .call(
                "forward.open",
                json!({"remote_port": port, "direction": "remote"}),
            )
            .await;
        assert!(error_of(&reply).contains("Roamgate's own"), "{reply}");
    }
    assert_eq!(spawns.load(Ordering::SeqCst), 0);
}

#[test]
fn the_vite_port_is_roamgates_only_in_development() {
    assert_eq!(roamgate_own_ports(8787, false), [8787]);
    assert_eq!(roamgate_own_ports(8788, true), [8788, 5173]);
}

// forward.open racing a disposed connection.

#[tokio::test(start_paused = true)]
async fn a_request_already_stale_spawns_nothing() {
    let spawns = Arc::new(AtomicUsize::new(0));
    let counted = spawns.clone();
    let forwards = SshForwards::new(
        clock(),
        ForwardDeps {
            spawn: Arc::new(move |_| {
                counted.fetch_add(1, Ordering::SeqCst);
                Ok(fake().child)
            }),
            is_port_free: Arc::new(|_| true),
            ..ForwardDeps::default()
        },
    );
    let reply = harness(&forwards)
        .call_while("forward.open", json!({"remote_port": 5173}), || false)
        .await;
    assert!(!error_of(&reply).is_empty());
    assert_eq!(spawns.load(Ordering::SeqCst), 0);
    assert!(forwards.list().is_empty());
}

#[tokio::test(start_paused = true)]
async fn a_connection_disposed_while_ssh_starts_leaves_no_ssh_behind() {
    let process = fake();
    let current = Arc::new(AtomicBool::new(true));
    let disposed = current.clone();
    let forwards = SshForwards::new(
        clock(),
        ForwardDeps {
            // The runtime is disposed (and swept its forwards) mid-startup.
            probe_port: probe(move |_| {
                disposed.store(false, Ordering::SeqCst);
                true
            }),
            ..deps(vec![process.child.clone()])
        },
    );
    let reply = harness(&forwards)
        .call_while("forward.open", json!({"remote_port": 5173}), || {
            current.load(Ordering::SeqCst)
        })
        .await;
    assert!(!error_of(&reply).is_empty());
    assert_eq!(process.kills(), 1);
    assert!(forwards.list().is_empty());
}

#[tokio::test(start_paused = true)]
async fn a_stale_request_leaves_a_forward_opened_since_alone() {
    let first = fake();
    let second = fake();
    let spawned = Arc::new(AtomicUsize::new(0));
    let counted = spawned.clone();
    let children = Arc::new(Mutex::new(vec![first.child.clone(), second.child.clone()]));
    // The first process's probe waits until the test lets it through; the
    // second's answers at once.
    let (stale_open, stale_gate) = watch::channel(false);
    let forwards = SshForwards::new(
        clock(),
        ForwardDeps {
            spawn: Arc::new(move |_| {
                counted.fetch_add(1, Ordering::SeqCst);
                Ok(children.lock().unwrap().remove(0))
            }),
            is_port_free: Arc::new(|_| true),
            probe_port: Arc::new(move |_| {
                let both = spawned.load(Ordering::SeqCst) == 2;
                let mut gate = stale_gate.clone();
                Box::pin(async move {
                    if !both {
                        let _ = gate.wait_for(|open| *open).await;
                    }
                    true
                })
            }),
            ..ForwardDeps::default()
        },
    );
    let current = Arc::new(AtomicBool::new(true));
    let harness = harness(&forwards);
    let stale = {
        let harness = harness.clone();
        let current = current.clone();
        tokio::spawn(async move {
            harness
                .call_while("forward.open", json!({"remote_port": 5173}), || {
                    current.load(Ordering::SeqCst)
                })
                .await
        })
    };
    tick().await;
    // The runtime is replaced: its forward is swept and the new one reopens
    // the same port.
    current.store(false, Ordering::SeqCst);
    forwards.lose_connection("");
    let fresh = harness
        .call("forward.open", json!({"remote_port": 5173}))
        .await;
    assert_eq!(fresh["result"]["forward"]["state"], "open", "{fresh}");
    stale_open.send(true).unwrap();
    assert!(!error_of(&stale.await.unwrap()).is_empty());
    assert!(second.killed.lock().unwrap().is_empty());
    assert_eq!(forwards.list()[0].state, SshForwardState::Open);
}

// Bounded discovery and forwards.

#[tokio::test(start_paused = true)]
async fn concurrent_scans_share_one_process_with_a_deadline_and_a_capped_list() {
    let forwards = SshForwards::new(clock(), deps(vec![fake().child]));
    let runs: Arc<Mutex<Vec<(ScanCommand, u64)>>> = Arc::default();
    let finish: Arc<Mutex<Option<oneshot::Sender<String>>>> = Arc::default();
    let scanner: Arc<dyn PortScan> = Arc::new(Scanner({
        let runs = runs.clone();
        let finish = finish.clone();
        move |command, timeout_ms| -> BoxFuture<Result<String, String>> {
            runs.lock().unwrap().push((command, timeout_ms));
            let (tx, rx) = oneshot::channel();
            *finish.lock().unwrap() = Some(tx);
            Box::pin(async move { rx.await.map_err(|error| error.to_string()) })
        }
    }));
    let harness = harness_with(&forwards, Some("user@desktop"), scanner);
    let first = harness.start("forward.candidates", json!({"direction": "local"}));
    let second = harness.start("forward.candidates", json!({"direction": "local"}));
    tick().await;
    {
        let runs = runs.lock().unwrap();
        assert_eq!(runs.len(), 1);
        assert_eq!(runs[0].1, FORWARD_SCAN_TIMEOUT_MS);
        // Whatever the remote login shell is, the chain runs under sh.
        assert_eq!(
            runs[0].0,
            ScanCommand::Ssh {
                destination: "user@desktop".into(),
                command: format!("sh -c '{LISTENING_PORTS_COMMAND}'"),
            }
        );
    }
    let lines: Vec<String> = (0..MAX_FORWARD_CANDIDATES + 20)
        .map(|i| {
            format!(
                "LISTEN 0 511 127.0.0.1:{} 0.0.0.0:* users:((\"node\",pid=1,fd=1))",
                20000 + i
            )
        })
        .collect();
    let finish = finish.lock().unwrap().take().unwrap();
    finish.send(lines.join("\n")).unwrap();
    for reply in [first.await.unwrap(), second.await.unwrap()] {
        let candidates = reply["result"]["candidates"].as_array().unwrap();
        assert_eq!(candidates.len(), MAX_FORWARD_CANDIDATES);
        assert_eq!(candidates[0]["port"], 20000);
    }
}

#[tokio::test(start_paused = true)]
async fn the_server_refuses_forwards_past_its_cap() {
    let forwards = SshForwards::new(
        clock(),
        ForwardDeps {
            spawn: Arc::new(|_| Ok(fake().child)),
            is_port_free: Arc::new(|_| true),
            ..ForwardDeps::default()
        },
    );
    let request = |port: u16| ForwardRequest {
        connection_id: "desktop".into(),
        destination: "user@desktop".into(),
        port,
        direction: SshForwardDirection::Local,
        label: None,
    };
    for i in 0..MAX_LIVE_FORWARDS as u16 {
        forwards.open(request(20000 + i * 100)).unwrap();
    }
    let refused = forwards.open(request(30000)).unwrap_err();
    assert!(
        refused.contains(&format!("Already forwarding {MAX_LIVE_FORWARDS} ports")),
        "{refused}"
    );
    // A port already forwarded is still answered: that is not a new one.
    assert_eq!(
        forwards.open(request(20000)).unwrap().state,
        SshForwardState::Starting
    );
}

// forward.list, forward.close and local connections.

#[tokio::test(start_paused = true)]
async fn lists_and_closes_forwards_in_wire_form() {
    let process = fake();
    let forwards = SshForwards::new(
        clock(),
        ForwardDeps {
            probe_port: probe(|_| true),
            ..deps(vec![process.child.clone()])
        },
    );
    let harness = harness(&forwards);
    let opened = harness
        .call(
            "forward.open",
            json!({"remote_port": 5173, "label": "  vite  "}),
        )
        .await;
    assert_eq!(
        opened["result"]["forward"],
        json!({
            "id": ":local:5173",
            "connection_id": "",
            "direction": "local",
            "remote_port": 5173,
            "local_port": 5173,
            "label": "vite",
            "state": "open",
        })
    );
    assert_eq!(
        harness.call("forward.list", json!({})).await["result"]["forwards"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    assert!(error_of(&harness.call("forward.close", json!({})).await).contains("requires id"));
    assert_eq!(
        harness
            .call("forward.close", json!({"id": ":local:5173"}))
            .await["result"],
        json!({"closed": true})
    );
    assert_eq!(process.kills(), 1);
    assert_eq!(
        harness.call("forward.list", json!({})).await["result"]["forwards"],
        json!([])
    );
    assert_eq!(
        *harness.errors.lock().unwrap(),
        ["forward.close requires id"]
    );
}

#[tokio::test(start_paused = true)]
async fn a_connection_without_an_ssh_transport_is_refused() {
    let forwards = SshForwards::new(clock(), deps(vec![fake().child]));
    let reply = harness_with(&forwards, None, scanning(""))
        .call("forward.open", json!({"remote_port": 5173}))
        .await;
    assert!(error_of(&reply).contains("SSH connections"));
}

#[tokio::test(start_paused = true)]
async fn an_invalid_port_is_refused_before_anything_starts() {
    let forwards = SshForwards::new(clock(), deps(vec![fake().child]));
    let reply = harness(&forwards)
        .call("forward.open", json!({"remote_port": 70000}))
        .await;
    assert!(error_of(&reply).contains("Invalid port"));
    assert!(forwards.list().is_empty());
}

#[tokio::test(start_paused = true)]
async fn the_global_forward_registry_can_be_closed_while_a_local_profile_is_active() {
    let process = fake();
    let forwards = SshForwards::new(clock(), deps(vec![process.child.clone()]));
    let record = forwards
        .open(ForwardRequest {
            connection_id: "ssh-profile".into(),
            destination: "user@host".into(),
            port: 3000,
            direction: SshForwardDirection::Local,
            label: None,
        })
        .unwrap();
    let reply = harness_with(&forwards, None, scanning(""))
        .call("forward.close", json!({"id": record.id}))
        .await;
    assert_eq!(reply["result"], json!({"closed": true}));
    assert_eq!(process.kills(), 1);
    assert!(forwards.list().is_empty());
    forwards.close_all();
}

// The reply around a named connection.

#[tokio::test(start_paused = true)]
async fn a_named_connections_replies_are_in_its_envelope() {
    let forwards = SshForwards::new(clock(), deps(vec![]));
    let rpc = ForwardRpc::new(
        ReplyEnvelope::new(Some("desk"), Some(3)),
        || None,
        scanning(""),
        forwards,
    );
    let reply = rpc
        .handle(Some(&Value::from("9")), "forward.nope", &Map::new(), || {
            true
        })
        .await;
    assert_eq!(
        reply.payload,
        r#"{"connection_id":"desk","connection_generation":3,"id":"9","error":{"message":"This connection is local; port forwarding applies to SSH connections"}}"#
    );
    let listed = rpc
        .handle(Some(&Value::from("9")), "forward.list", &Map::new(), || {
            false
        })
        .await;
    assert_eq!(
        listed.error.as_deref(),
        Some(CONNECTION_CHANGED_DURING_REQUEST)
    );
}
