//! server/src/connections/profile-service.test.ts.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use futures_util::FutureExt;
use futures_util::future::Shared;
use roamgate_herdr::thin::{BinReader, BinWriter, encode_frame};
use serde_json::{Value, json};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::UnixListener;

use super::*;
use crate::manager::RuntimeContext;
use crate::profiles::SshConnectionProfile;

/// Waits for `predicate`, letting spawned work run at least once first as
/// awaiting the TS helper does.
async fn wait_until(predicate: impl Fn() -> bool) {
    tokio::task::yield_now().await;
    for _ in 0..1000 {
        if predicate() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(1)).await;
    }
    panic!("condition not reached");
}

fn temp_path(dir: &tempfile::TempDir) -> PathBuf {
    dir.path().join("private").join("connections.json")
}

fn local_socket_path(id: &str, client: bool) -> String {
    format!("/tmp/{id}{}.sock", if client { "-client" } else { "" })
}

fn local_profile(id: &str, auto_connect: bool) -> LocalConnectionProfile {
    LocalConnectionProfile {
        id: id.into(),
        label: id.to_uppercase(),
        control_socket_path: local_socket_path(id, false),
        client_socket_path: local_socket_path(id, true),
        auto_connect,
    }
}

fn local(id: &str, auto_connect: bool) -> ConnectionProfile {
    ConnectionProfile::Local(local_profile(id, auto_connect))
}

fn ssh(id: &str, auto_connect: bool) -> ConnectionProfile {
    ConnectionProfile::Ssh(SshConnectionProfile {
        id: id.into(),
        label: id.to_uppercase(),
        ssh_destination: format!("operator@{id}"),
        remote_control_socket_path: format!("/remote/{id}.sock"),
        remote_client_socket_path: format!("/remote/{id}-client.sock"),
        auto_connect,
        remote_platform_windows: false,
        remote_herdr_path: None,
        remote_session: None,
        node: false,
    })
}

fn legacy() -> ManagedConnectionProfile {
    synthetic_legacy_profile(
        &local_socket_path("ignored", false),
        &local_socket_path("ignored", true),
    )
}

fn legacy_paths() -> (String, String) {
    (
        local_socket_path("ignored", false),
        local_socket_path("ignored", true),
    )
}

type Gate = Shared<BoxFuture<Result<(), RuntimeError>>>;

/// A gate opened by its sender.
fn gate() -> (tokio::sync::oneshot::Sender<()>, Gate) {
    let (tx, rx) = tokio::sync::oneshot::channel::<()>();
    let opened: BoxFuture<Result<(), RuntimeError>> = Box::pin(async move {
        let _ = rx.await;
        Ok(())
    });
    (tx, opened.shared())
}

type Transport = Arc<dyn Fn(&RuntimeContext) -> BoxFuture<Result<(), RuntimeError>> + Send + Sync>;
type Stop = Arc<dyn Fn() -> BoxFuture<Result<(), RuntimeError>> + Send + Sync>;

/// How a fake runtime differs from the plain one, whose transport fails
/// for a local profile on a `bad-start` socket.
#[derive(Clone, Default)]
struct Behaviour {
    transport: Option<Transport>,
    stop: Option<Stop>,
}

struct FakeRuntime {
    profile: ManagedConnectionProfile,
    context: RuntimeContext,
    stops: AtomicUsize,
    behaviour: Behaviour,
}

impl FakeRuntime {
    fn stops(&self) -> usize {
        self.stops.load(Ordering::SeqCst)
    }
}

impl ConnectionRuntime for FakeRuntime {
    fn identity(&self) -> ConnectionIdentity {
        connection_identity_for_profile(&self.profile)
    }
    fn start_transport(&self) -> BoxFuture<Result<(), RuntimeError>> {
        if let Some(transport) = &self.behaviour.transport {
            return transport(&self.context);
        }
        let bad = matches!(&self.profile, ConnectionProfile::Local(local)
            if local.control_socket_path.contains("bad-start"));
        Box::pin(async move {
            if bad {
                return Err("transport unavailable".into());
            }
            Ok(())
        })
    }
    fn start_background(&self) -> BoxFuture<Result<(), RuntimeError>> {
        Box::pin(async { Ok(()) })
    }
    fn stop(&self) -> BoxFuture<Result<(), RuntimeError>> {
        self.stops.fetch_add(1, Ordering::SeqCst);
        match &self.behaviour.stop {
            Some(stop) => stop(),
            None => Box::pin(async { Ok(()) }),
        }
    }
}

type Created = Arc<Mutex<Vec<Arc<FakeRuntime>>>>;

fn created_for(created: &Created, id: &str) -> Vec<Arc<FakeRuntime>> {
    created
        .lock()
        .unwrap()
        .iter()
        .filter(|runtime| runtime.profile.id() == id)
        .cloned()
        .collect()
}

fn factory(
    created: Created,
    customize: impl Fn(&ManagedConnectionProfile) -> Behaviour + Send + Sync + 'static,
) -> ConnectionProfileRuntimeFactory<FakeRuntime> {
    let customize = Arc::new(customize);
    Arc::new(move |profile: &ManagedConnectionProfile| {
        let profile = profile.clone();
        let created = created.clone();
        let customize = customize.clone();
        Arc::new(move |context: RuntimeContext| {
            let runtime = Arc::new(FakeRuntime {
                behaviour: customize(&profile),
                profile: profile.clone(),
                context,
                stops: AtomicUsize::new(0),
            });
            created.lock().unwrap().push(runtime.clone());
            Ok(runtime)
        }) as RuntimeFactory<FakeRuntime>
    })
}

fn runtime_factory(created: Created) -> ConnectionProfileRuntimeFactory<FakeRuntime> {
    factory(created, |_| Behaviour::default())
}

fn failing_transport(error: RuntimeError) -> Transport {
    Arc::new(move |_| {
        let error = error.clone();
        Box::pin(async move { Err(error) })
    })
}

fn gated_stop(gate: Gate) -> Stop {
    Arc::new(move || gate.clone().boxed())
}

fn answering_probe(version: Option<&str>, protocol: i64) -> TestProfile {
    let version = version.map(str::to_owned);
    Arc::new(move |_| {
        let version = version.clone();
        Box::pin(async move {
            Ok(ProbeResult {
                ok: true,
                version,
                protocol,
            })
        })
    })
}

fn recording_probe(
    tested: Arc<Mutex<Vec<ManagedConnectionProfile>>>,
    version: &str,
    protocol: i64,
) -> TestProfile {
    let answer = answering_probe(Some(version), protocol);
    Arc::new(move |profile| {
        tested.lock().unwrap().push(profile.clone());
        answer(profile)
    })
}

fn failing_probe(message: &str) -> TestProfile {
    let message = message.to_owned();
    Arc::new(move |_| {
        let message = message.clone();
        Box::pin(async move { Err(RuntimeError::new(message)) })
    })
}

fn unused_probe() -> TestProfile {
    failing_probe("this test probes nothing")
}

/// Timers scheduled by the service, fired by the test.
#[derive(Clone, Default)]
struct Timers(Arc<Mutex<Vec<FakeTimer>>>);

struct FakeTimer {
    callback: Option<RetryCallback>,
    delay_ms: u64,
    cancelled: Arc<AtomicBool>,
}

impl Timers {
    fn schedule(&self) -> RetrySchedule {
        let timers = self.0.clone();
        Arc::new(move |callback, delay_ms| {
            let cancelled = Arc::new(AtomicBool::new(false));
            timers.lock().unwrap().push(FakeTimer {
                callback: Some(callback),
                delay_ms,
                cancelled: cancelled.clone(),
            });
            RetryTimer::new(move || cancelled.store(true, Ordering::SeqCst))
        })
    }

    fn len(&self) -> usize {
        self.0.lock().unwrap().len()
    }

    fn delays(&self) -> Vec<u64> {
        self.0.lock().unwrap().iter().map(|t| t.delay_ms).collect()
    }

    fn delay(&self, index: usize) -> u64 {
        self.0.lock().unwrap()[index].delay_ms
    }

    fn cancelled(&self, index: usize) -> bool {
        self.0.lock().unwrap()[index]
            .cancelled
            .load(Ordering::SeqCst)
    }

    fn all_cancelled(&self) -> bool {
        self.0
            .lock()
            .unwrap()
            .iter()
            .all(|timer| timer.cancelled.load(Ordering::SeqCst))
    }

    /// Runs a timer's callback, cancelled or not, as the TS tests do.
    fn fire(&self, index: usize) {
        let callback = self.0.lock().unwrap()[index].callback.take();
        if let Some(callback) = callback {
            callback();
        }
    }

    fn retry(&self) -> ConnectionRetryOptions {
        ConnectionRetryOptions {
            schedule: Some(self.schedule()),
            ..ConnectionRetryOptions::default()
        }
    }
}

fn fixed(value: f64) -> Option<RetryRandom> {
    Some(Arc::new(move || value))
}

fn registry(
    version: u64,
    default_connection_id: &str,
    profiles: Vec<ConnectionProfile>,
) -> PersistedConnectionRegistry {
    PersistedConnectionRegistry {
        version,
        default_connection_id: default_connection_id.into(),
        profiles,
    }
}

fn persisted_store(
    dir: &tempfile::TempDir,
    registry: &PersistedConnectionRegistry,
) -> Arc<ConnectionProfileStore> {
    let store = ConnectionProfileStore::at(temp_path(dir)).unwrap();
    store.save(registry).unwrap();
    Arc::new(store)
}

fn empty_store(dir: &tempfile::TempDir) -> Arc<ConnectionProfileStore> {
    Arc::new(ConnectionProfileStore::at(temp_path(dir)).unwrap())
}

fn load(store: &ConnectionProfileStore, explicit: bool) -> ConnectionProfileBootstrap {
    load_connection_profile_bootstrap(store, &legacy(), explicit).unwrap()
}

fn ids(bootstrap: &ConnectionProfileBootstrap) -> Vec<String> {
    bootstrap
        .registrations
        .iter()
        .map(|registration| registration.profile.id().to_owned())
        .collect()
}

fn manager(default: &str) -> ConnectionManager<FakeRuntime> {
    ConnectionManager::new(default, None, None)
}

fn make_service(
    manager: &ConnectionManager<FakeRuntime>,
    store: &Arc<ConnectionProfileStore>,
    bootstrap: ConnectionProfileBootstrap,
    create_runtime: ConnectionProfileRuntimeFactory<FakeRuntime>,
    test_profile: TestProfile,
    retry: ConnectionRetryOptions,
) -> ConnectionProfileService<FakeRuntime> {
    ConnectionProfileService::new(ConnectionProfileServiceArgs {
        manager: manager.clone(),
        store: store.clone(),
        bootstrap,
        create_runtime,
        test_profile,
        retry,
    })
    .unwrap()
}

fn list_ids(service: &ConnectionProfileService<FakeRuntime>) -> Vec<String> {
    service
        .list()
        .unwrap()
        .iter()
        .map(|item| item["id"].as_str().unwrap().to_owned())
        .collect()
}

fn read(path: &Path) -> String {
    std::fs::read_to_string(path).unwrap()
}

fn transient() -> RuntimeError {
    RuntimeError::new("SSH destination is temporarily unreachable")
}

fn state(manager: &ConnectionManager<FakeRuntime>, id: &str) -> ConnectionState {
    manager.status(id).unwrap().state
}

type ServiceSlot = Arc<OnceLock<ConnectionProfileService<FakeRuntime>>>;

#[test]
fn uses_persisted_default_and_profiles_when_no_legacy_override_exists() {
    let dir = tempfile::tempdir().unwrap();
    let store = persisted_store(
        &dir,
        &registry(1, "beta", vec![local("alpha", false), local("beta", true)]),
    );
    let bootstrap = load(&store, false);
    assert_eq!(bootstrap.default_connection_id, "beta");
    assert_eq!(ids(&bootstrap), ["alpha", "beta"]);
}

#[test]
fn explicit_legacy_config_remains_process_default_without_overwriting_persisted_registry() {
    let dir = tempfile::tempdir().unwrap();
    let store = persisted_store(&dir, &registry(1, "alpha", vec![local("alpha", true)]));
    let before = read(store.path());
    let bootstrap = load(&store, true);
    assert_eq!(bootstrap.default_connection_id, "legacy-default");
    assert_eq!(ids(&bootstrap), ["legacy-default", "alpha"]);
    assert_eq!(read(store.path()), before);
}

#[tokio::test]
async fn preserves_an_invalid_registry_and_blocks_mutations_in_degraded_fallback() {
    use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt};
    let dir = tempfile::tempdir().unwrap();
    let path = temp_path(&dir);
    std::fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(path.parent().unwrap())
        .unwrap();
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(&path)
        .unwrap();
    std::io::Write::write_all(&mut file, b"{not-json").unwrap();
    drop(file);
    let store = empty_store(&dir);
    let error = load_connection_profile_bootstrap(&store, &legacy(), false).unwrap_err();
    assert!(error.contains("not valid JSON"), "{error}");
    let bootstrap = ConnectionProfileBootstrap {
        default_connection_id: "legacy-default".into(),
        explicit_legacy_override: false,
        persisted_registry: None,
        registry_load_error: Some("connection registry is not valid JSON".into()),
        registrations: vec![ProfileRegistration {
            profile: legacy(),
            read_only: true,
        }],
    };
    let manager = manager("legacy-default");
    let service = make_service(
        &manager,
        &store,
        bootstrap,
        runtime_factory(Created::default()),
        answering_probe(Some("test"), 14),
        ConnectionRetryOptions::default(),
    );

    let error = service
        .create(local("alpha", true).to_value())
        .await
        .unwrap_err();
    assert!(error.message.contains("registry is invalid"), "{error}");
    let probed = service
        .test(json!({ "id": "legacy-default" }))
        .await
        .unwrap();
    assert!(probed.ok);
    assert_eq!(read(&path), "{not-json");
}

#[test]
fn synthesizes_the_local_legacy_profile_when_no_registry_exists() {
    let dir = tempfile::tempdir().unwrap();
    let store = empty_store(&dir);
    let bootstrap = load(&store, false);
    assert_eq!(bootstrap.default_connection_id, "legacy-default");
    assert_eq!(
        bootstrap.registrations,
        [ProfileRegistration {
            profile: legacy(),
            read_only: true,
        }]
    );
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum RenderMode {
    Valid,
    Malformed,
}

struct ProbeServers {
    _dir: tempfile::TempDir,
    profile: LocalConnectionProfile,
    control_connections: Arc<AtomicUsize>,
    render_connections: Arc<AtomicUsize>,
    /// What the render server found wrong in a Hello.
    problems: Arc<Mutex<Vec<String>>>,
}

impl ProbeServers {
    fn counts(&self) -> (usize, usize) {
        let problems = self.problems.lock().unwrap().clone();
        assert!(problems.is_empty(), "{problems:?}");
        (
            self.control_connections.load(Ordering::SeqCst),
            self.render_connections.load(Ordering::SeqCst),
        )
    }
}

/// Checks a Hello as the fake Herdr expects it: 80x24, no pixels, then
/// the protocol's own tail.
fn check_hello(payload: &[u8], ping_protocol: &Value) -> Result<u64, String> {
    let mut reader = BinReader::new(payload);
    let expect = |what: &str, actual: u64, expected: u64| {
        (actual == expected)
            .then_some(())
            .ok_or_else(|| format!("{what}: {actual} != {expected}"))
    };
    expect("variant", reader.variant()?, 0)?;
    let protocol = reader.varint()?;
    if ping_protocol.as_u64() != Some(protocol) {
        return Err(format!("protocol {protocol} != {ping_protocol}"));
    }
    expect("cols", reader.varint()?, 80)?;
    expect("rows", reader.varint()?, 24)?;
    expect("cell width", reader.varint()?, 0)?;
    expect("cell height", reader.varint()?, 0)?;
    if protocol == 22 {
        expect("pixel mouse", u64::from(reader.bool()?), 0)?;
    } else {
        reader.varint()?; // encoding
        expect("keybindings", reader.varint()?, 0)?;
        expect("app", reader.varint()?, 0)?;
    }
    expect("remaining", reader.remaining() as u64, 0)?;
    Ok(protocol)
}

/// A fake Herdr: a control socket answering one ping, and a client socket
/// answering a Hello with a Welcome (or a malformed frame).
async fn start_probe_servers(
    id: &str,
    render_mode: RenderMode,
    ping_protocol: Value,
    welcome_protocol: Option<u64>,
) -> ProbeServers {
    let dir = tempfile::tempdir().unwrap();
    let control_path = dir.path().join("control.sock");
    let render_path = dir.path().join("render.sock");
    let control_connections = Arc::new(AtomicUsize::new(0));
    let render_connections = Arc::new(AtomicUsize::new(0));
    let problems = Arc::new(Mutex::new(Vec::new()));
    let control = UnixListener::bind(&control_path).unwrap();
    let render = UnixListener::bind(&render_path).unwrap();
    {
        let connections = control_connections.clone();
        let version = format!("fake-{id}");
        let protocol = ping_protocol.clone();
        tokio::spawn(async move {
            while let Ok((mut stream, _)) = control.accept().await {
                connections.fetch_add(1, Ordering::SeqCst);
                let version = version.clone();
                let protocol = protocol.clone();
                tokio::spawn(async move {
                    let mut input = Vec::new();
                    let mut chunk = vec![0u8; 4096];
                    loop {
                        let read = stream.read(&mut chunk).await.unwrap_or(0);
                        if read == 0 {
                            return;
                        }
                        input.extend_from_slice(&chunk[..read]);
                        let Some(end) = input.iter().position(|byte| *byte == b'\n') else {
                            continue;
                        };
                        let request: Value = serde_json::from_slice(&input[..end]).unwrap();
                        let answer = json!({
                            "id": request["id"],
                            "result": {
                                "version": version,
                                "protocol": protocol,
                                "workspace_id": "shared-workspace",
                                "pane_id": "shared-pane",
                                "terminal_id": "shared-terminal",
                            },
                        });
                        let _ = stream.write_all(format!("{answer}\n").as_bytes()).await;
                        let _ = stream.shutdown().await;
                        return;
                    }
                });
            }
        });
    }
    {
        let connections = render_connections.clone();
        let problems = problems.clone();
        tokio::spawn(async move {
            while let Ok((mut stream, _)) = render.accept().await {
                connections.fetch_add(1, Ordering::SeqCst);
                let problems = problems.clone();
                let ping_protocol = ping_protocol.clone();
                tokio::spawn(async move {
                    let mut input = Vec::new();
                    let mut chunk = vec![0u8; 4096];
                    let payload = loop {
                        let read = stream.read(&mut chunk).await.unwrap_or(0);
                        if read == 0 {
                            return;
                        }
                        input.extend_from_slice(&chunk[..read]);
                        if input.len() < 4 {
                            continue;
                        }
                        let length = u32::from_le_bytes(input[..4].try_into().unwrap()) as usize;
                        if input.len() >= length + 4 {
                            break input[4..4 + length].to_vec();
                        }
                    };
                    if render_mode == RenderMode::Malformed {
                        let _ = stream.write_all(&encode_frame(&[])).await;
                        let _ = stream.shutdown().await;
                        return;
                    }
                    let protocol = match check_hello(&payload, &ping_protocol) {
                        Ok(protocol) => protocol,
                        Err(problem) => {
                            problems.lock().unwrap().push(problem);
                            return;
                        }
                    };
                    let mut writer = BinWriter::new();
                    writer.variant(0);
                    writer.varint(welcome_protocol.unwrap_or(protocol));
                    writer.varint(1);
                    writer.option(None::<&str>, |writer, value| writer.string(value));
                    let _ = stream.write_all(&encode_frame(&writer.into_bytes())).await;
                    // Herdr keeps the socket open; the probe closes it.
                    let _ = stream.read(&mut chunk).await;
                });
            }
        });
    }
    let text = |path: PathBuf| path.to_str().unwrap().to_owned();
    ProbeServers {
        profile: LocalConnectionProfile {
            control_socket_path: text(control_path),
            client_socket_path: text(render_path),
            ..local_profile(id, true)
        },
        _dir: dir,
        control_connections,
        render_connections,
        problems,
    }
}

#[tokio::test]
async fn probes_protocol_with_a_complete_hello_welcome() {
    for protocol in [20, 22] {
        let server = start_probe_servers("tagged", RenderMode::Valid, json!(protocol), None).await;
        let probed = test_local_connection_profile(&server.profile)
            .await
            .unwrap();
        assert!(probed.ok);
        assert_eq!(probed.protocol, protocol);
        assert_eq!(server.counts(), (1, 1), "protocol {protocol}");
    }
}

#[tokio::test]
async fn rejects_unsupported_control_probe_without_opening_render_socket() {
    for protocol in [
        json!(13),
        json!(21),
        json!(23),
        json!(999),
        json!("22"),
        Value::Null,
    ] {
        let server =
            start_probe_servers("unsupported", RenderMode::Valid, protocol.clone(), None).await;
        let error = test_local_connection_profile(&server.profile)
            .await
            .unwrap_err();
        assert!(!error.retryable, "{protocol}");
        assert!(
            error.message.contains("supports protocols 14-20 and 22"),
            "{protocol}: {error}"
        );
        assert_eq!(server.counts(), (1, 0), "{protocol}");
    }
}

#[tokio::test]
async fn classifies_unsupported_binary_welcome_as_permanent() {
    for protocol in [21, 23, 999] {
        let server = start_probe_servers(
            "unsupported-welcome",
            RenderMode::Valid,
            json!(22),
            Some(protocol),
        )
        .await;
        let error = test_local_connection_profile(&server.profile)
            .await
            .unwrap_err();
        assert!(!error.retryable, "{protocol}");
        assert!(
            error
                .message
                .contains(&format!("Herdr protocol {protocol} is not supported")),
            "{protocol}: {error}"
        );
    }
}

#[tokio::test]
async fn probes_two_colliding_id_local_servers_through_their_own_control_and_render_sockets() {
    let alpha = start_probe_servers("alpha", RenderMode::Valid, json!(14), None).await;
    let beta = start_probe_servers("beta", RenderMode::Valid, json!(14), None).await;

    let (alpha_result, beta_result) = tokio::join!(
        test_local_connection_profile(&alpha.profile),
        test_local_connection_profile(&beta.profile),
    );

    assert_eq!(
        alpha_result.unwrap(),
        ProbeResult {
            ok: true,
            version: Some("fake-alpha".into()),
            protocol: 14,
        }
    );
    assert_eq!(
        serde_json::to_value(beta_result.unwrap()).unwrap(),
        json!({ "ok": true, "version": "fake-beta", "protocol": 14 })
    );
    assert_eq!(alpha.counts(), (1, 1));
    assert_eq!(beta.counts(), (1, 1));
}

#[tokio::test]
async fn contains_missing_and_malformed_render_probe_failures() {
    let healthy_control =
        start_probe_servers("missing-render", RenderMode::Valid, json!(14), None).await;
    let absent = Path::new(&healthy_control.profile.client_socket_path)
        .parent()
        .unwrap()
        .join("absent.sock");
    let missing = LocalConnectionProfile {
        client_socket_path: absent.to_str().unwrap().to_owned(),
        ..healthy_control.profile.clone()
    };
    assert!(test_local_connection_profile(&missing).await.is_err());

    let malformed =
        start_probe_servers("malformed-render", RenderMode::Malformed, json!(14), None).await;
    let error = test_local_connection_profile(&malformed.profile)
        .await
        .unwrap_err();
    assert!(!error.retryable);
    assert!(error.message.contains("bincode: short read"), "{error}");
}

fn seeded(id: &str) -> ConnectionProfile {
    let (control_socket_path, client_socket_path) = legacy_paths();
    ConnectionProfile::Local(LocalConnectionProfile {
        id: id.into(),
        label: "Local".into(),
        control_socket_path,
        client_socket_path,
        auto_connect: true,
    })
}

#[tokio::test]
async fn first_create_persists_a_restart_consistent_default_and_retires_synthetic_runtime() {
    let dir = tempfile::tempdir().unwrap();
    let store = empty_store(&dir);
    let bootstrap = load(&store, false);
    let manager = manager(&bootstrap.default_connection_id);
    let created = Created::default();
    let service = make_service(
        &manager,
        &store,
        bootstrap,
        runtime_factory(created.clone()),
        unused_probe(),
        ConnectionRetryOptions::default(),
    );
    manager.start_default().await.unwrap();
    let retired = manager.default_runtime().unwrap();

    let result = service
        .create(local("alpha", true).to_value())
        .await
        .unwrap();
    assert_eq!(result["id"], "alpha");
    assert_eq!(result["is_default"], false);
    assert_eq!(result["state"], "ready");
    assert_eq!(manager.default_id(), "local");
    assert!(!manager.has("legacy-default"));
    assert_eq!(retired.stops(), 1);
    assert_eq!(
        store.load().unwrap(),
        Some(registry(
            2,
            "local",
            vec![seeded("local"), local("alpha", true)]
        ))
    );
    // The seeded local profile preserves the default server and is writable.
    assert_eq!(list_ids(&service), ["local", "alpha"]);
    let first = &service.list().unwrap()[0];
    assert_eq!(first["id"], "local");
    assert_eq!(first["label"], "Local");
    assert_eq!(first["is_default"], true);
    assert_eq!(first["state"], "ready");
    assert_eq!(first["read_only"], false);
}

#[tokio::test]
async fn first_failed_ssh_profile_remains_removable_retryable() {
    for retryable in [false, true] {
        let dir = tempfile::tempdir().unwrap();
        let store = empty_store(&dir);
        let bootstrap = load(&store, false);
        let manager = manager(&bootstrap.default_connection_id);
        let timers = Timers::default();
        let failure = RuntimeError {
            message: "SSH connection failed".into(),
            retryable,
        };
        let service = make_service(
            &manager,
            &store,
            bootstrap,
            factory(Created::default(), move |profile| Behaviour {
                transport: profile.is_ssh().then(|| failing_transport(failure.clone())),
                ..Behaviour::default()
            }),
            unused_probe(),
            timers.retry(),
        );
        service.start_configured().await;

        let result = service
            .create(ssh("remote", true).to_value())
            .await
            .unwrap();
        assert_eq!(result["id"], "remote");
        assert_eq!(result["is_default"], false);
        assert_eq!(
            result["state"],
            if retryable { "reconnecting" } else { "error" }
        );
        let default = manager.status("local").unwrap();
        assert!(default.is_default);
        assert_eq!(default.state, ConnectionState::Ready);
        assert_eq!(
            store.load().unwrap().unwrap().default_connection_id,
            "local"
        );
        assert_eq!(
            service.remove(json!("remote")).await.unwrap(),
            json!({ "ok": true })
        );
        assert!(!manager.has("remote"));
        assert!(timers.all_cancelled());
        let restarted = load(&store, false);
        assert_eq!(restarted.default_connection_id, "local");
        assert_eq!(ids(&restarted), ["local"]);
        service.stop_supervision();
        manager.stop_all().await.unwrap();
    }
}

#[tokio::test]
async fn first_create_named_local_seeds_the_default_server_under_a_distinct_id() {
    let dir = tempfile::tempdir().unwrap();
    let store = empty_store(&dir);
    let bootstrap = load(&store, false);
    let manager = manager(&bootstrap.default_connection_id);
    let service = make_service(
        &manager,
        &store,
        bootstrap,
        runtime_factory(Created::default()),
        unused_probe(),
        ConnectionRetryOptions::default(),
    );

    let result = service
        .create(local("local", true).to_value())
        .await
        .unwrap();
    assert_eq!(result["id"], "local");
    assert_eq!(result["is_default"], false);
    assert_eq!(manager.default_id(), "localhost");
    assert_eq!(
        store.load().unwrap(),
        Some(registry(
            2,
            "localhost",
            vec![seeded("localhost"), local("local", true)]
        ))
    );
    assert_eq!(list_ids(&service), ["localhost", "local"]);
}

#[tokio::test]
async fn first_create_cannot_leave_a_failed_synthetic_cleanup_reconnectable() {
    let dir = tempfile::tempdir().unwrap();
    let store = empty_store(&dir);
    let failing_legacy = synthetic_legacy_profile(
        &local_socket_path("bad-stop", false),
        &local_socket_path("ignored", true),
    );
    let bootstrap = load_connection_profile_bootstrap(&store, &failing_legacy, false).unwrap();
    let manager = manager(&bootstrap.default_connection_id);
    let failing_stop: Stop =
        Arc::new(|| Box::pin(async { Err("synthetic cleanup failed".into()) }));
    let service = make_service(
        &manager,
        &store,
        bootstrap,
        factory(Created::default(), move |profile| Behaviour {
            stop: (profile.id() == "legacy-default").then(|| failing_stop.clone()),
            ..Behaviour::default()
        }),
        unused_probe(),
        ConnectionRetryOptions::default(),
    );
    manager.start_default().await.unwrap();

    let result = service
        .create(local("alpha", true).to_value())
        .await
        .unwrap();
    assert_eq!(result["id"], "alpha");
    assert_eq!(result["is_default"], false);
    assert!(!manager.has("legacy-default"));
    assert_eq!(list_ids(&service), ["local", "alpha"]);
    let error = manager.start("legacy-default").await.unwrap_err();
    assert!(error.contains("unknown connection"), "{error}");
}

#[tokio::test]
async fn starts_default_and_auto_connect_profiles_independently_and_isolates_failures() {
    let dir = tempfile::tempdir().unwrap();
    let store = persisted_store(
        &dir,
        &registry(
            1,
            "alpha",
            vec![
                local("alpha", false),
                local("bad-start", true),
                local("beta", true),
            ],
        ),
    );
    let bootstrap = load(&store, false);
    let manager = manager(&bootstrap.default_connection_id);
    let service = make_service(
        &manager,
        &store,
        bootstrap,
        runtime_factory(Created::default()),
        unused_probe(),
        ConnectionRetryOptions::default(),
    );

    service.start_configured().await;
    assert_eq!(state(&manager, "alpha"), ConnectionState::Ready);
    assert_eq!(state(&manager, "beta"), ConnectionState::Ready);
    assert_eq!(state(&manager, "bad-start"), ConnectionState::Error);
}

#[tokio::test]
async fn lists_tests_connects_disconnects_changes_default_updates_and_removes_without_crossing_runtimes()
 {
    let dir = tempfile::tempdir().unwrap();
    let store = persisted_store(
        &dir,
        &registry(
            1,
            "alpha",
            vec![local("alpha", false), local("beta", false)],
        ),
    );
    let bootstrap = load(&store, false);
    let manager = manager(&bootstrap.default_connection_id);
    let tested = Arc::new(Mutex::new(Vec::new()));
    let service = make_service(
        &manager,
        &store,
        bootstrap,
        runtime_factory(Created::default()),
        recording_probe(tested.clone(), "test", 13),
        ConnectionRetryOptions::default(),
    );

    let listed = service.list().unwrap();
    assert_eq!(listed.len(), 2);
    for (item, id) in listed.iter().zip(["alpha", "beta"]) {
        assert_eq!(item["id"], id);
        assert_eq!(item["type"], "local");
        assert_eq!(item["read_only"], false);
    }
    service.connect(json!("alpha")).await.unwrap();
    assert_eq!(
        manager.ready_runtime("alpha").unwrap().identity().id,
        "alpha"
    );
    assert!(manager.ready_runtime("beta").is_none());
    service.test(json!({ "id": "beta" })).await.unwrap();
    let tested_ids: Vec<String> = tested
        .lock()
        .unwrap()
        .iter()
        .map(|profile: &ConnectionProfile| profile.id().to_owned())
        .collect();
    assert_eq!(tested_ids, ["beta"]);
    service.disconnect(json!("alpha")).await.unwrap();
    let error = service.remove(json!("alpha")).await.unwrap_err();
    assert!(
        error
            .message
            .contains("cannot remove the default connection"),
        "{error}"
    );
    service.set_default(json!("beta")).await.unwrap();
    assert_eq!(manager.default_id(), "beta");
    let mut edited = local("alpha", false).to_value();
    edited["label"] = json!("Alpha edited");
    service.update(json!("alpha"), edited).await.unwrap();
    assert_eq!(manager.status("alpha").unwrap().label, "Alpha edited");
    service.remove(json!("alpha")).await.unwrap();
    assert!(!manager.has("alpha"));
    assert!(manager.has("beta"));
}

#[tokio::test]
async fn explicit_legacy_mode_can_remove_the_last_persisted_non_default_profile() {
    let dir = tempfile::tempdir().unwrap();
    let store = persisted_store(&dir, &registry(1, "alpha", vec![local("alpha", false)]));
    let bootstrap = load(&store, true);
    let manager = manager(&bootstrap.default_connection_id);
    let service = make_service(
        &manager,
        &store,
        bootstrap,
        runtime_factory(Created::default()),
        unused_probe(),
        ConnectionRetryOptions::default(),
    );

    let error = service.remove(json!("legacy-default")).await.unwrap_err();
    assert!(
        error.message.contains("connection profile is read-only"),
        "{error}"
    );
    service.remove(json!("alpha")).await.unwrap();
    assert_eq!(store.load().unwrap(), None);
    assert_eq!(manager.default_id(), "legacy-default");
    assert!(!manager.has("alpha"));
}

#[tokio::test]
async fn remove_leaves_persistence_untouched_when_unregister_rejects() {
    let dir = tempfile::tempdir().unwrap();
    let initial = persisted_store(
        &dir,
        &registry(
            1,
            "alpha",
            vec![local("alpha", false), local("beta", false)],
        ),
    );
    let before = read(initial.path());
    let save_calls = Arc::new(AtomicUsize::new(0));
    let counted = save_calls.clone();
    let store = Arc::new(
        ConnectionProfileStore::at(temp_path(&dir))
            .unwrap()
            .with_before_rename(Box::new(move |_, _| {
                counted.fetch_add(1, Ordering::SeqCst);
                Err("rollback save would fail".into())
            })),
    );
    let bootstrap = load(&store, false);
    let manager = manager(&bootstrap.default_connection_id);
    let (release, stop_gate) = gate();
    let service = make_service(
        &manager,
        &store,
        bootstrap,
        factory(Created::default(), move |profile| Behaviour {
            stop: (profile.id() == "beta").then(|| gated_stop(stop_gate.clone())),
            ..Behaviour::default()
        }),
        unused_probe(),
        ConnectionRetryOptions::default(),
    );
    // The manager's unregister cannot be replaced as the TS test does; an
    // unregister already draining beta makes the service's own reject.
    manager.start("beta").await.unwrap();
    let draining = tokio::spawn({
        let manager = manager.clone();
        async move { manager.unregister("beta").await }
    });
    tokio::task::yield_now().await;

    let error = service.remove(json!("beta")).await.unwrap_err();
    assert!(
        error
            .message
            .contains("connection is already being removed"),
        "{error}"
    );
    assert_eq!(save_calls.load(Ordering::SeqCst), 0);
    assert_eq!(read(store.path()), before);
    assert!(manager.has("beta"));
    let _ = release.send(());
    draining.await.unwrap().unwrap();
}

#[tokio::test]
async fn remove_restores_the_old_registration_when_persistence_fails() {
    let dir = tempfile::tempdir().unwrap();
    let initial = persisted_store(
        &dir,
        &registry(
            1,
            "alpha",
            vec![local("alpha", false), local("beta", false)],
        ),
    );
    let before = read(initial.path());
    let store = Arc::new(
        ConnectionProfileStore::at(temp_path(&dir))
            .unwrap()
            .with_before_rename(Box::new(|_, _| Err("remove persistence failed".into()))),
    );
    let bootstrap = load(&store, false);
    let manager = manager(&bootstrap.default_connection_id);
    let service = make_service(
        &manager,
        &store,
        bootstrap,
        runtime_factory(Created::default()),
        unused_probe(),
        ConnectionRetryOptions::default(),
    );
    manager.start("beta").await.unwrap();

    let error = service.remove(json!("beta")).await.unwrap_err();
    assert!(
        error.message.contains("remove persistence failed"),
        "{error}"
    );
    assert_eq!(read(store.path()), before);
    assert!(manager.has("beta"));
    assert_eq!(state(&manager, "beta"), ConnectionState::Ready);
    assert!(list_ids(&service).contains(&"beta".to_owned()));
}

fn remote_store(dir: &tempfile::TempDir, auto_connect: bool) -> Arc<ConnectionProfileStore> {
    persisted_store(
        dir,
        &registry(2, "remote", vec![ssh("remote", auto_connect)]),
    )
}

#[tokio::test]
async fn retries_transient_ssh_failures_with_bounded_exponential_jitter_and_generation_retirement()
{
    let dir = tempfile::tempdir().unwrap();
    let store = remote_store(&dir, true);
    let bootstrap = load(&store, false);
    let manager = manager("remote");
    let created = Created::default();
    let timers = Timers::default();
    let service = make_service(
        &manager,
        &store,
        bootstrap,
        runtime_factory(created.clone()),
        unused_probe(),
        ConnectionRetryOptions {
            base_delay_ms: Some(100),
            max_delay_ms: Some(1000),
            max_attempts: Some(3),
            stable_reset_ms: Some(10_000),
            random: fixed(0.0),
            schedule: Some(timers.schedule()),
            clock: None,
        },
    );
    service.start_configured().await;
    let first = created_for(&created, "remote")[0].clone();
    let old_lease = manager.ready_runtime_lease("remote").unwrap().unwrap();
    let transient = transient();

    let reconnecting = service.will_retry("remote", &transient);
    first.context.report_error(&transient, reconnecting);
    service.runtime_failed("remote", &transient);
    assert!(reconnecting);
    assert!(!old_lease.is_current());
    assert_eq!(state(&manager, "remote"), ConnectionState::Reconnecting);
    wait_until(|| manager.current_runtime("remote").unwrap().is_none()).await;
    assert_eq!(timers.delay(0), 50);
    assert!(!timers.cancelled(0));

    timers.fire(0);
    wait_until(|| state(&manager, "remote") == ConnectionState::Ready).await;
    assert_eq!(created_for(&created, "remote").len(), 2);
    let stable = timers
        .delays()
        .iter()
        .position(|delay| *delay == 10_000)
        .unwrap();
    assert!(!timers.cancelled(stable));

    let second = created_for(&created, "remote")[1].clone();
    second.context.report_error(&transient, true);
    service.runtime_failed("remote", &transient);
    wait_until(|| manager.current_runtime("remote").unwrap().is_none()).await;
    assert!(timers.cancelled(stable));
    let last = timers.len() - 1;
    assert_eq!(timers.delay(last), 100);
    assert!(!timers.cancelled(last));
    service.stop_supervision();
    assert!(timers.cancelled(last));
}

/// A transport that reports its own exit before its startup fails.
fn exiting_transport(slot: ServiceSlot, id: &str, error: RuntimeError) -> Transport {
    let id = id.to_owned();
    Arc::new(move |context: &RuntimeContext| {
        context.report_error(&error, true);
        slot.get().unwrap().runtime_failed(&id, &error);
        let error = error.clone();
        Box::pin(async move { Err(error) })
    })
}

#[tokio::test]
async fn queues_one_retry_when_an_exit_callback_and_startup_rejection_report_the_same_failure() {
    let dir = tempfile::tempdir().unwrap();
    let store = remote_store(&dir, false);
    let bootstrap = load(&store, false);
    let manager = manager("remote");
    let timers = Timers::default();
    let slot = ServiceSlot::default();
    let service = make_service(
        &manager,
        &store,
        bootstrap,
        factory(Created::default(), {
            let slot = slot.clone();
            move |profile| Behaviour {
                transport: Some(exiting_transport(slot.clone(), profile.id(), transient())),
                ..Behaviour::default()
            }
        }),
        unused_probe(),
        ConnectionRetryOptions {
            base_delay_ms: Some(100),
            max_attempts: Some(3),
            random: fixed(0.0),
            schedule: Some(timers.schedule()),
            ..ConnectionRetryOptions::default()
        },
    );
    let _ = slot.set(service.clone());

    let error = service.connect(json!("remote")).await.unwrap_err();
    assert!(error.message.contains("temporarily unreachable"), "{error}");

    assert_eq!(timers.len(), 1);
    assert_eq!(timers.delay(0), 50);
    assert!(!timers.cancelled(0));
    timers.fire(0);
    wait_until(|| timers.len() == 2).await;
    assert_eq!(timers.delays(), [50, 100]);
    service.stop_supervision();
}

type LateExit = Box<dyn FnOnce() + Send>;

async fn flush(late_master_exits: &Mutex<Vec<LateExit>>) {
    for _ in 0..50 {
        tokio::task::yield_now().await;
    }
    let exits: Vec<LateExit> = late_master_exits.lock().unwrap().drain(..).collect();
    for exit in exits {
        exit();
    }
    for _ in 0..50 {
        tokio::task::yield_now().await;
    }
}

async fn advance(ms: u64, late_master_exits: &Mutex<Vec<LateExit>>) {
    let mut elapsed = 0;
    while elapsed < ms {
        tokio::time::advance(Duration::from_millis(1000)).await;
        flush(late_master_exits).await;
        elapsed += 1000;
    }
}

#[tokio::test(start_paused = true)]
async fn keeps_retrying_an_ssh_connection_through_a_long_outage_and_connects_once_ssh_works_again()
{
    let dir = tempfile::tempdir().unwrap();
    let store = remote_store(&dir, true);
    let bootstrap = load(&store, false);
    let manager = manager("remote");
    let ssh_down = Arc::new(AtomicBool::new(true));
    let attempts = Arc::new(AtomicUsize::new(0));
    let late_master_exits: Arc<Mutex<Vec<LateExit>>> = Arc::default();
    let outage = || {
        RuntimeError::new(
            "ssh exited 255: ssh: connect to host example.com port 22: Operation timed out",
        )
    };
    let slot = ServiceSlot::default();
    let transport: Transport = {
        let ssh_down = ssh_down.clone();
        let attempts = attempts.clone();
        let late_master_exits = late_master_exits.clone();
        let slot = slot.clone();
        Arc::new(move |context: &RuntimeContext| {
            attempts.fetch_add(1, Ordering::SeqCst);
            if !ssh_down.load(Ordering::SeqCst) {
                return Box::pin(async { Ok(()) });
            }
            // The home probe fails first; the ssh master exits right
            // after, once its runtime is no longer current.
            let context = context.clone();
            let slot = slot.clone();
            late_master_exits.lock().unwrap().push(Box::new(move || {
                if !context.is_current() {
                    return;
                }
                let service = slot.get().unwrap();
                let error = outage();
                context.report_error(&error, service.will_retry("remote", &error));
                service.runtime_failed("remote", &error);
            }));
            Box::pin(async move { Err(outage()) })
        })
    };
    let service = make_service(
        &manager,
        &store,
        bootstrap,
        factory(Created::default(), move |_| Behaviour {
            transport: Some(transport.clone()),
            ..Behaviour::default()
        }),
        unused_probe(),
        ConnectionRetryOptions {
            base_delay_ms: Some(1000),
            max_delay_ms: Some(30_000),
            random: fixed(1.0),
            ..ConnectionRetryOptions::default()
        },
    );
    let _ = slot.set(service.clone());

    service.start_configured().await;
    flush(&late_master_exits).await;
    assert_eq!(attempts.load(Ordering::SeqCst), 1);
    assert_eq!(state(&manager, "remote"), ConnectionState::Reconnecting);

    // Twenty minutes of outage: far more failures than any attempt budget.
    advance(20 * 60_000, &late_master_exits).await;
    let after_twenty_minutes = attempts.load(Ordering::SeqCst);
    assert!(after_twenty_minutes > 30, "{after_twenty_minutes}");
    assert_eq!(state(&manager, "remote"), ConnectionState::Reconnecting);
    advance(10 * 60_000, &late_master_exits).await;
    // The backoff is capped at 30 s rather than growing without bound.
    assert_eq!(attempts.load(Ordering::SeqCst) - after_twenty_minutes, 20);
    assert_eq!(state(&manager, "remote"), ConnectionState::Reconnecting);

    ssh_down.store(false, Ordering::SeqCst);
    advance(30_000, &late_master_exits).await;
    assert_eq!(attempts.load(Ordering::SeqCst) - after_twenty_minutes, 21);
    assert_eq!(state(&manager, "remote"), ConnectionState::Ready);
    service.stop_supervision();
}

#[tokio::test]
async fn runs_a_waiting_ssh_retry_at_once_when_asked_as_after_a_network_change() {
    let dir = tempfile::tempdir().unwrap();
    let store = remote_store(&dir, true);
    let bootstrap = load(&store, false);
    let manager = manager("remote");
    let ssh_down = Arc::new(AtomicBool::new(true));
    let attempts = Arc::new(AtomicUsize::new(0));
    let timers = Timers::default();
    let transport: Transport = {
        let ssh_down = ssh_down.clone();
        let attempts = attempts.clone();
        Arc::new(move |_: &RuntimeContext| {
            attempts.fetch_add(1, Ordering::SeqCst);
            let down = ssh_down.load(Ordering::SeqCst);
            Box::pin(async move {
                if down {
                    return Err("ssh exited 255: Operation timed out".into());
                }
                Ok(())
            })
        })
    };
    let service = make_service(
        &manager,
        &store,
        bootstrap,
        factory(Created::default(), move |_| Behaviour {
            transport: Some(transport.clone()),
            ..Behaviour::default()
        }),
        unused_probe(),
        ConnectionRetryOptions {
            base_delay_ms: Some(30_000),
            random: fixed(1.0),
            schedule: Some(timers.schedule()),
            ..ConnectionRetryOptions::default()
        },
    );
    service.start_configured().await;
    assert_eq!(timers.len(), 1);
    assert_eq!(attempts.load(Ordering::SeqCst), 1);

    ssh_down.store(false, Ordering::SeqCst);
    service.retry_now();
    assert!(timers.cancelled(0));
    wait_until(|| state(&manager, "remote") == ConnectionState::Ready).await;
    assert_eq!(attempts.load(Ordering::SeqCst), 2);
    // Nothing is waiting any more, so another call does nothing.
    service.retry_now();
    tokio::time::sleep(Duration::from_millis(5)).await;
    assert_eq!(attempts.load(Ordering::SeqCst), 2);
    service.stop_supervision();
}

#[tokio::test]
async fn cancels_a_fired_retry_while_failed_runtime_cleanup_is_still_pending() {
    let dir = tempfile::tempdir().unwrap();
    let store = remote_store(&dir, false);
    let bootstrap = load(&store, false);
    let manager = manager("remote");
    let (release_stop, stop_gate) = gate();
    let created = Created::default();
    let timers = Timers::default();
    let service = make_service(
        &manager,
        &store,
        bootstrap,
        factory(created.clone(), move |_| Behaviour {
            stop: Some(gated_stop(stop_gate.clone())),
            ..Behaviour::default()
        }),
        unused_probe(),
        ConnectionRetryOptions {
            base_delay_ms: Some(100),
            random: fixed(0.0),
            schedule: Some(timers.schedule()),
            ..ConnectionRetryOptions::default()
        },
    );
    service.connect(json!("remote")).await.unwrap();
    let transient = RuntimeError::new("SSH tunnel exited");
    let first = created_for(&created, "remote")[0].clone();
    first.context.report_error(&transient, true);
    service.runtime_failed("remote", &transient);
    wait_until(|| timers.len() == 1 && first.stops() == 1).await;

    timers.fire(0);
    let disconnecting = service.disconnect(json!("remote"));
    let _ = release_stop.send(());
    disconnecting.await.unwrap();
    tokio::time::sleep(Duration::from_millis(1)).await;

    assert_eq!(created_for(&created, "remote").len(), 1);
    assert_eq!(state(&manager, "remote"), ConnectionState::Disconnected);
    assert_eq!(timers.len(), 1);
}

#[tokio::test]
async fn does_not_double_count_a_startup_exit_after_its_retry_timer_has_fired() {
    let dir = tempfile::tempdir().unwrap();
    let store = remote_store(&dir, false);
    let bootstrap = load(&store, false);
    let manager = manager("remote");
    let (release_first_probe, first_probe) = gate();
    let timers = Timers::default();
    let created_count = Arc::new(AtomicUsize::new(0));
    let slot = ServiceSlot::default();
    let service = make_service(
        &manager,
        &store,
        bootstrap,
        factory(Created::default(), {
            let created_count = created_count.clone();
            let slot = slot.clone();
            move |profile| {
                let ordinal = created_count.fetch_add(1, Ordering::SeqCst) + 1;
                if ordinal != 1 {
                    return Behaviour::default();
                }
                let slot = slot.clone();
                let first_probe = first_probe.clone();
                let id = profile.id().to_owned();
                Behaviour {
                    transport: Some(Arc::new(move |context: &RuntimeContext| {
                        let transient = transient();
                        context.report_error(&transient, true);
                        slot.get().unwrap().runtime_failed(&id, &transient);
                        let first_probe = first_probe.clone();
                        Box::pin(async move {
                            let _ = first_probe.await;
                            Err(transient)
                        })
                    })),
                    ..Behaviour::default()
                }
            }
        }),
        unused_probe(),
        ConnectionRetryOptions {
            base_delay_ms: Some(100),
            max_attempts: Some(3),
            stable_reset_ms: Some(10_000),
            random: fixed(0.0),
            schedule: Some(timers.schedule()),
            ..ConnectionRetryOptions::default()
        },
    );
    let _ = slot.set(service.clone());

    let connecting = service.connect(json!("remote"));
    wait_until(|| timers.len() == 1).await;
    timers.fire(0);
    let _ = release_first_probe.send(());
    let error = connecting.await.unwrap_err();
    assert!(error.message.contains("temporarily unreachable"), "{error}");
    wait_until(|| state(&manager, "remote") == ConnectionState::Ready).await;

    assert_eq!(created_count.load(Ordering::SeqCst), 2);
    let retries: Vec<u64> = timers
        .delays()
        .into_iter()
        .filter(|delay| *delay != 10_000)
        .collect();
    assert_eq!(retries, [50]);
    service.stop_supervision();
}

#[tokio::test]
async fn bounds_repeated_ssh_startup_retries_and_caps_exponential_delays() {
    let dir = tempfile::tempdir().unwrap();
    let store = remote_store(&dir, true);
    let bootstrap = load(&store, false);
    let manager = manager("remote");
    let created = Created::default();
    let timers = Timers::default();
    let service = make_service(
        &manager,
        &store,
        bootstrap,
        factory(created.clone(), |_| Behaviour {
            transport: Some(failing_transport(transient())),
            ..Behaviour::default()
        }),
        unused_probe(),
        ConnectionRetryOptions {
            base_delay_ms: Some(100),
            max_delay_ms: Some(200),
            max_attempts: Some(3),
            random: fixed(0.0),
            schedule: Some(timers.schedule()),
            ..ConnectionRetryOptions::default()
        },
    );

    service.start_configured().await;
    assert_eq!(timers.delays(), [50]);
    timers.fire(0);
    wait_until(|| timers.len() == 2).await;
    assert_eq!(timers.delay(1), 100);
    timers.fire(1);
    wait_until(|| timers.len() == 3).await;
    assert_eq!(timers.delay(2), 100);
    timers.fire(2);
    wait_until(|| state(&manager, "remote") == ConnectionState::Error).await;
    tokio::time::sleep(Duration::from_millis(1)).await;
    assert_eq!(timers.len(), 3);
    assert_eq!(created_for(&created, "remote").len(), 4);
}

#[tokio::test]
async fn does_not_retry_permanent_ssh_failures_and_disconnect_cancels_queued_retry() {
    let dir = tempfile::tempdir().unwrap();
    let store = remote_store(&dir, true);
    let bootstrap = load(&store, false);
    let manager = manager("remote");
    let created = Created::default();
    let timers = Timers::default();
    let service = make_service(
        &manager,
        &store,
        bootstrap,
        runtime_factory(created.clone()),
        unused_probe(),
        ConnectionRetryOptions {
            base_delay_ms: Some(10),
            max_delay_ms: Some(20),
            random: fixed(0.0),
            schedule: Some(timers.schedule()),
            ..ConnectionRetryOptions::default()
        },
    );
    service.start_configured().await;
    let permanent = RuntimeError::permanent("SSH authentication failed");
    assert!(!service.will_retry("remote", &RuntimeError::permanent("unsupported protocol")));
    assert!(!service.will_retry(
        "remote",
        &RuntimeError::permanent("SSH is unsupported on this platform")
    ));
    let first = created_for(&created, "remote")[0].clone();
    first.context.report_error(&permanent, false);
    service.runtime_failed("remote", &permanent);
    wait_until(|| manager.current_runtime("remote").unwrap().is_none()).await;
    assert_eq!(state(&manager, "remote"), ConnectionState::Error);
    assert_eq!(timers.len(), 0);

    service.connect(json!("remote")).await.unwrap();
    let second = created_for(&created, "remote")[1].clone();
    let transient = RuntimeError::new("SSH tunnel exited");
    second.context.report_error(&transient, true);
    service.runtime_failed("remote", &transient);
    service.disconnect(json!("remote")).await.unwrap();
    assert_eq!(state(&manager, "remote"), ConnectionState::Disconnected);
    assert_eq!(timers.len(), 1);
    assert!(timers.cancelled(0));
    timers.fire(0);
    tokio::time::sleep(Duration::from_millis(1)).await;
    assert_eq!(created_for(&created, "remote").len(), 2);
}

#[tokio::test]
async fn migrates_a_v1_registry_while_creating_testing_and_connecting_an_ssh_profile() {
    let dir = tempfile::tempdir().unwrap();
    let store = persisted_store(&dir, &registry(1, "alpha", vec![local("alpha", false)]));
    let bootstrap = load(&store, false);
    let manager = manager(&bootstrap.default_connection_id);
    let tested = Arc::new(Mutex::new(Vec::new()));
    let service = make_service(
        &manager,
        &store,
        bootstrap,
        runtime_factory(Created::default()),
        recording_probe(tested.clone(), "remote", 14),
        ConnectionRetryOptions::default(),
    );

    let result = service
        .create(ssh("remote", false).to_value())
        .await
        .unwrap();
    for (key, value) in [
        ("id", json!("remote")),
        ("type", json!("ssh")),
        ("state", json!("disconnected")),
        ("ssh_destination", json!("operator@remote")),
        ("remote_control_socket_path", json!("/remote/remote.sock")),
        (
            "remote_client_socket_path",
            json!("/remote/remote-client.sock"),
        ),
        ("read_only", json!(false)),
    ] {
        assert_eq!(result[key], value, "{key}");
    }
    assert_eq!(
        store.load().unwrap(),
        Some(registry(
            2,
            "alpha",
            vec![local("alpha", false), ssh("remote", false)]
        ))
    );
    let probed = service.test(json!({ "id": "remote" })).await.unwrap();
    assert_eq!(probed.version.as_deref(), Some("remote"));
    assert_eq!(*tested.lock().unwrap(), [ssh("remote", false)]);
    let connected = service.connect(json!("remote")).await.unwrap();
    assert_eq!(connected["state"], "ready");
    assert_eq!(connected["type"], "ssh");
    assert_eq!(
        manager.ready_runtime("remote").unwrap().identity().source,
        "ssh-profile"
    );
}

#[tokio::test]
async fn failed_ssh_update_rollback_cancels_replacement_retry_intent() {
    let dir = tempfile::tempdir().unwrap();
    let old_remote = ssh("remote", false);
    let store = persisted_store(
        &dir,
        &registry(2, "alpha", vec![local("alpha", false), old_remote.clone()]),
    );
    let bootstrap = load(&store, false);
    let manager = manager("alpha");
    let created = Created::default();
    let timers = Timers::default();
    let service = make_service(
        &manager,
        &store,
        bootstrap,
        factory(created.clone(), |profile| Behaviour {
            transport: (profile.is_ssh() && profile.auto_connect())
                .then(|| failing_transport(transient())),
            ..Behaviour::default()
        }),
        unused_probe(),
        timers.retry(),
    );

    let error = service
        .update(json!("remote"), ssh("remote", true).to_value())
        .await
        .unwrap_err();
    assert!(error.message.contains("temporarily unreachable"), "{error}");
    assert_eq!(
        store.load().unwrap(),
        Some(registry(
            2,
            "alpha",
            vec![local("alpha", false), old_remote.clone()]
        ))
    );
    assert_eq!(state(&manager, "remote"), ConnectionState::Disconnected);
    assert_eq!(timers.len(), 1);
    assert!(timers.cancelled(0));
    timers.fire(0);
    tokio::time::sleep(Duration::from_millis(1)).await;
    assert_eq!(created_for(&created, "remote").len(), 1);
}

#[tokio::test]
async fn disables_mutations_and_preserves_the_durable_replacement_when_rollback_persistence_fails()
{
    let dir = tempfile::tempdir().unwrap();
    let original = local("alpha", true);
    persisted_store(&dir, &registry(1, "alpha", vec![original.clone()]));
    let save_calls = Arc::new(AtomicUsize::new(0));
    let counted = save_calls.clone();
    let store = Arc::new(
        ConnectionProfileStore::at(temp_path(&dir))
            .unwrap()
            .with_before_rename(Box::new(move |_, _| {
                if counted.fetch_add(1, Ordering::SeqCst) == 0 {
                    return Ok(());
                }
                Err("rollback persistence failed".into())
            })),
    );
    let bootstrap = load(&store, false);
    let manager = manager("alpha");
    let service = make_service(
        &manager,
        &store,
        bootstrap,
        runtime_factory(Created::default()),
        answering_probe(None, 14),
        ConnectionRetryOptions::default(),
    );
    manager.start_default().await.unwrap();
    let replacement = ConnectionProfile::Local(LocalConnectionProfile {
        control_socket_path: local_socket_path("bad-start", false),
        ..local_profile("alpha", true)
    });

    let error = service
        .update(json!("alpha"), replacement.to_value())
        .await
        .unwrap_err();
    assert!(error.message.contains("rollback was incomplete"), "{error}");
    let causes: Vec<&str> = error.errors.iter().map(|e| e.message.as_str()).collect();
    assert_eq!(
        causes,
        ["transport unavailable", "rollback persistence failed"]
    );

    assert_eq!(
        store.load().unwrap(),
        Some(registry(2, "alpha", vec![replacement]))
    );
    let first = &service.list().unwrap()[0];
    assert_eq!(first["id"], "alpha");
    assert_eq!(
        first["control_socket_path"],
        local_socket_path("bad-start", false)
    );
    assert!(manager.ready_runtime("alpha").is_none());
    let error = service
        .create(local("beta", true).to_value())
        .await
        .unwrap_err();
    assert!(
        error.message.contains("persistence rollback failed"),
        "{error}"
    );
}

#[tokio::test]
async fn failed_replacement_start_rolls_back_the_old_file_factory_and_ready_runtime() {
    let dir = tempfile::tempdir().unwrap();
    let store = persisted_store(&dir, &registry(1, "alpha", vec![local("alpha", true)]));
    let bootstrap = load(&store, false);
    let manager = manager(&bootstrap.default_connection_id);
    let created = Created::default();
    let service = make_service(
        &manager,
        &store,
        bootstrap,
        runtime_factory(created.clone()),
        answering_probe(Some("test"), 14),
        ConnectionRetryOptions::default(),
    );
    service.start_configured().await;
    let before = read(store.path());

    let replacement = ConnectionProfile::Local(LocalConnectionProfile {
        control_socket_path: local_socket_path("bad-start", false),
        ..local_profile("alpha", true)
    });
    let error = service
        .update(json!("alpha"), replacement.to_value())
        .await
        .unwrap_err();
    assert!(error.message.contains("transport unavailable"), "{error}");
    let status = manager.status("alpha").unwrap();
    assert_eq!(status.label, "ALPHA");
    assert_eq!(status.state, ConnectionState::Ready);
    assert_eq!(created_for(&created, "alpha").len(), 3);
    assert_eq!(read(store.path()), before);
}

#[tokio::test]
async fn failed_ready_profile_validation_preserves_old_runtime_and_exact_persisted_file() {
    let dir = tempfile::tempdir().unwrap();
    let store = persisted_store(&dir, &registry(1, "alpha", vec![local("alpha", true)]));
    let bootstrap = load(&store, false);
    let manager = manager(&bootstrap.default_connection_id);
    let service = make_service(
        &manager,
        &store,
        bootstrap,
        runtime_factory(Created::default()),
        failing_probe("probe rejected replacement"),
        ConnectionRetryOptions::default(),
    );
    service.start_configured().await;
    let runtime = manager.ready_runtime("alpha").unwrap();
    let before = read(store.path());

    let mut unsafe_edit = local("alpha", true).to_value();
    unsafe_edit["label"] = json!("Unsafe edit");
    let error = service
        .update(json!("alpha"), unsafe_edit)
        .await
        .unwrap_err();
    assert!(
        error.message.contains("probe rejected replacement"),
        "{error}"
    );
    assert!(Arc::ptr_eq(
        &manager.ready_runtime("alpha").unwrap(),
        &runtime
    ));
    assert_eq!(manager.status("alpha").unwrap().label, "ALPHA");
    assert_eq!(read(store.path()), before);
}

#[tokio::test]
async fn an_edit_without_node_keeps_the_profiles_node_and_an_explicit_false_turns_it_off() {
    let dir = tempfile::tempdir().unwrap();
    let ConnectionProfile::Ssh(mut remote) = ssh("remote", false) else {
        unreachable!()
    };
    remote.node = true;
    let store = persisted_store(
        &dir,
        &registry(
            2,
            "alpha",
            vec![
                local("alpha", false),
                ConnectionProfile::Ssh(remote.clone()),
            ],
        ),
    );
    let bootstrap = load(&store, false);
    let manager = manager("alpha");
    let service = make_service(
        &manager,
        &store,
        bootstrap,
        factory(Created::default(), |_| Behaviour::default()),
        unused_probe(),
        Timers::default().retry(),
    );
    let saved_node = |store: &ConnectionProfileStore| {
        let saved = store.load().unwrap().unwrap();
        match &saved.profiles[1] {
            ConnectionProfile::Ssh(profile) => profile.node,
            ConnectionProfile::Local(_) => unreachable!(),
        }
    };

    let mut edited = ConnectionProfile::Ssh(remote.clone()).to_value();
    edited.as_object_mut().unwrap().remove("node");
    edited["label"] = json!("Remote edited");
    service
        .update(json!("remote"), edited.clone())
        .await
        .unwrap();
    assert!(saved_node(&store));
    assert_eq!(
        std::fs::read_to_string(temp_path(&dir))
            .unwrap()
            .matches("\"node\": true")
            .count(),
        1
    );

    edited["node"] = json!(false);
    service.update(json!("remote"), edited).await.unwrap();
    assert!(!saved_node(&store));
}
