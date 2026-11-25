//! The server: `roamgate [server flags]` (and the hidden alias `roamgate
//! front [server flags]`), the Rust front of contract/wire/core-channel.md
//! with its own executable as the standalone `roamgate core` (no Bun), or
//! the Bun server `ROAMGATE_SIDECAR_BIN` names as its portless core (stage
//! 2). Reads the server's configuration as the Bun server does, holds the
//! port and serves until SIGTERM or Ctrl-C.

use std::collections::{BTreeMap, HashMap};
use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Arc;

use roamgate_base::clock::SystemClock;
use roamgate_base::env::{Env, roamgate_env};
use roamgate_base::paths::DataFile;
use roamgate_base::revoked_sessions::RevokedSessions;
use roamgate_base::session_secret::{
    load_or_create_session_secret, revoked_sessions_path, session_secret_path_from_env,
};
use roamgate_base::settings::Settings;
use roamgate_cli::auth_token::auth_token_print_command;
use roamgate_cli::herdr::HerdrCli;
use roamgate_cli::server_config::load_server_config_with_help;
use roamgate_http::auth::{Auth, AuthConfig};
use roamgate_http::front::{
    Front, RustCoreLinkConfig, SidecarCommand, SidecarConfig, Sockets, StandaloneCore, app,
    link_token, run_rust_core_link, run_sidecar, static_dirs,
};
use roamgate_sidecar::peer::Peer;
use serde_json::json;
use tokio::sync::watch;

/// `--public-dir`, `PUBLIC_DIR`, `public` next to the executable, or in
/// the working directory (resolvePublicDir).
fn public_dir(args: &[String], env: &dyn Env) -> PathBuf {
    let mut words = args.iter();
    while let Some(word) = words.next() {
        if word == "--public-dir"
            && let Some(value) = words.next()
        {
            return value.into();
        }
        if let Some(value) = word.strip_prefix("--public-dir=") {
            return value.into();
        }
    }
    if let Some(dir) = env.var("PUBLIC_DIR").filter(|dir| !dir.is_empty()) {
        return dir.into();
    }
    let next_to_exe = std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(|dir| dir.join("public")));
    match next_to_exe {
        Some(dir) if dir.exists() => dir,
        _ => std::env::current_dir().unwrap_or_default().join("public"),
    }
}

/// Where the front's test clock moves the core's.
#[derive(Clone)]
enum CoreClock {
    /// The Bun core's own test clock, on a private socket started at the
    /// front's time.
    Socket(PathBuf),
    /// A standalone core, which follows the front's clock from its
    /// `welcome` on: `internal.clock.advance` on the channel.
    Channel(watch::Receiver<Option<Peer>>),
}

/// The front's test clock (contract/wire/test-clock.md): served on the
/// harness's socket, and relayed to the core. Each `advance` moves the
/// front's clock, then the core's, and replies once both ran their due
/// timers.
#[cfg(unix)]
fn serve_front_clock(
    clock: roamgate_base::clock::TestClock,
    path: &std::path::Path,
    core: CoreClock,
) -> std::io::Result<tokio::task::JoinHandle<()>> {
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
    let _ = std::fs::remove_file(path);
    let listener = tokio::net::UnixListener::bind(path)?;
    Ok(tokio::spawn(async move {
        while let Ok((stream, _)) = listener.accept().await {
            let clock = clock.clone();
            let core = core.clone();
            tokio::spawn(async move {
                let (read, mut write) = stream.into_split();
                let mut lines = BufReader::new(read).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    if line.trim().is_empty() {
                        continue;
                    }
                    let reply = roamgate_base::clock::answer(&clock, &line).await;
                    if line.trim().starts_with("advance") && !reply.starts_with("error") {
                        match &core {
                            CoreClock::Socket(path) => relay_to_core(path, line.trim()).await,
                            CoreClock::Channel(link) => {
                                let peer = link.borrow().clone();
                                if let Some(peer) = peer.filter(|peer| !peer.is_closed()) {
                                    let to = roamgate_base::clock::Clock::now(&clock);
                                    let _ = peer
                                        .call(
                                            "internal.clock.advance",
                                            json!({ "to": to }),
                                            Default::default(),
                                            false,
                                        )
                                        .await;
                                }
                            }
                        }
                    }
                    if write
                        .write_all(format!("{reply}\n").as_bytes())
                        .await
                        .is_err()
                    {
                        return;
                    }
                }
            });
        }
    }))
}

/// Sends one request to the core's test clock and waits for its reply;
/// a core that is not up (starting, restarting) is skipped.
#[cfg(unix)]
async fn relay_to_core(core: &std::path::Path, request: &str) {
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
    let Ok(mut stream) = tokio::net::UnixStream::connect(core).await else {
        return;
    };
    if stream
        .write_all(format!("{request}\n").as_bytes())
        .await
        .is_err()
    {
        return;
    }
    let mut reply = String::new();
    let _ = BufReader::new(stream).read_line(&mut reply).await;
}

/// The web build served after the public directory behind a Bun core: its
/// run from source (`server/src/index.ts`) serves `server/public`. With no
/// Bun the front serves the build this binary carries instead
/// ([`crate::embedded_web`]).
fn built_public_dir(sidecar_bin: Option<&str>) -> Option<PathBuf> {
    let entry = PathBuf::from(sidecar_bin.filter(|bin| bin.ends_with(".ts"))?);
    Some(entry.parent()?.parent()?.join("public"))
}

/// Record mode's variable (contract-record/recorder.ts).
pub const CONTRACT_RECORD_ENV: &str = "ROAMGATE_CONTRACT_RECORD";

/// The recorder `ROAMGATE_CONTRACT_RECORD` asks for (`HERDR_GUI_*` names
/// when absent), its lines timed on the server's clock; None when record
/// mode is off or its directory cannot be made (said on stderr).
fn start_recorder(
    env: &dyn Env,
    root: &std::path::Path,
    clock: &roamgate_base::clock::SharedClock,
) -> Option<Arc<roamgate_base::record::ContractRecorder>> {
    let now: roamgate_base::log::NowFn = {
        let clock = clock.clone();
        Arc::new(move || clock.now())
    };
    let options = roamgate_base::record::RecorderOptions::from_env(
        env,
        || root.to_path_buf(),
        "server",
        now,
    )?;
    match roamgate_base::record::ContractRecorder::new(options) {
        Ok(recorder) => Some(Arc::new(recorder)),
        Err(error) => {
            eprintln!("[bridge] contract record mode off: {error}");
            None
        }
    }
}

/// A signal, or the core's `server.scheduleExit` (`exit`).
async fn shutdown(exit: Arc<tokio::sync::Notify>) {
    #[cfg(unix)]
    {
        use tokio::signal::unix::{SignalKind, signal};
        let mut term = signal(SignalKind::terminate()).expect("SIGTERM handler");
        tokio::select! {
            _ = tokio::signal::ctrl_c() => {}
            _ = term.recv() => {}
            () = exit.notified() => {}
        }
    }
    #[cfg(not(unix))]
    tokio::select! {
        _ = tokio::signal::ctrl_c() => {}
        () = exit.notified() => {}
    }
}

/// Serves with `args`, the server flags, and the process environment with
/// `overrides` over it (`service run`'s environment file); the core gets
/// them too. Returns the exit code.
pub async fn run(args: &[String], overrides: BTreeMap<String, String>) -> u8 {
    let mut own_env: HashMap<String, String> = std::env::vars_os()
        .map(|(name, value)| {
            (
                name.to_string_lossy().into_owned(),
                value.to_string_lossy().into_owned(),
            )
        })
        .collect();
    own_env.extend(overrides.clone());
    let env: Arc<dyn Env> = Arc::new(own_env.clone());
    let cli = HerdrCli::system(env.clone(), crate::VERSION.into());
    let runtime = cli.config_runtime();
    // `--help` is the top-level help, the management commands' with the
    // server's options (index.ts's `helpText: topLevelHelp`).
    let help = || {
        roamgate_cli::index::top_level_help(&roamgate_cli::index::cli_commands(
            roamgate_cli::index::rust_runner,
        ))
    };
    let config =
        match load_server_config_with_help(args, env.as_ref(), &runtime, crate::VERSION, &help) {
            Ok(config) => config,
            Err(printed) => {
                print!("{}", printed.stdout);
                eprint!("{}", printed.stderr);
                return printed.code.clamp(0, 255) as u8;
            }
        };
    let tls = match &config.tls {
        Some(tls) => match crate::front_tls::server_config(&tls.cert, &tls.key) {
            Ok(tls) => Some(tls),
            Err(error) => {
                eprintln!("[bridge] FATAL: {error}");
                return 1;
            }
        },
        None => None,
    };
    let data = runtime.data();
    let root = data.data_root();
    let test_clock = match roamgate_base::clock::test_clock_from_env(
        &mut own_env,
        roamgate_base::clock::TEST_CLOCK_HONOURED,
    ) {
        Ok(found) => found,
        Err(error) => {
            eprintln!("roamgate: {error}");
            return 1;
        }
    };
    let virtual_clock = test_clock.as_ref().map(|found| {
        let real = SystemClock;
        found.clock(
            roamgate_base::clock::Clock::now(&real),
            roamgate_base::clock::Clock::monotonic(&real),
        )
    });
    let clock: roamgate_base::clock::SharedClock = match &virtual_clock {
        Some(test) => Arc::new(test.clone()),
        None => Arc::new(SystemClock),
    };
    let clock_for_log = clock.clone();
    let logger = roamgate_base::log::Logger::new(config.log_level, clock_for_log);
    {
        use tracing_subscriber::layer::SubscriberExt;
        let subscriber =
            tracing_subscriber::registry().with(roamgate_base::log::LogLayer::new(logger.clone()));
        let _ = tracing::subscriber::set_global_default(subscriber);
    }
    let mut session_secret = String::new();
    if config.auth_required {
        let mut credentials = vec![config.password.as_str()];
        if let Some(pin) = &config.pin {
            credentials.push(pin);
        }
        match load_or_create_session_secret(
            &data,
            &credentials,
            &session_secret_path_from_env(env.as_ref(), &root),
        ) {
            Ok(secret) => session_secret = secret,
            Err(error) => {
                eprintln!("[bridge] FATAL: could not load the session signing secret: {error}");
                return 1;
            }
        }
    }
    let mut auth_config = AuthConfig::new(&config.password, &session_secret);
    auth_config.auth_required = config.auth_required;
    auth_config.pin = config.pin.clone();
    auth_config.url_login_token = config.generated_auth_token.clone();
    auth_config.token_command = config.generated_auth_token_path.as_ref().and_then(|path| {
        auth_token_print_command(
            &path.to_string_lossy(),
            &runtime.home.to_string_lossy(),
            if runtime.platform == "win32" {
                roamgate_base::paths::Platform::Windows
            } else {
                roamgate_base::paths::Platform::Unix
            },
            runtime.app_data.as_deref().and_then(|dir| dir.to_str()),
        )
    });
    let mut auth = match Auth::new(auth_config, clock.clone()) {
        Ok(auth) => auth,
        Err(error) => {
            eprintln!("[bridge] FATAL: {error}");
            return 1;
        }
    };
    if config.auth_required {
        let path = revoked_sessions_path(
            roamgate_env(env.as_ref(), "SETTINGS_PATH").as_deref(),
            &root,
        );
        auth = auth.with_revoked(RevokedSessions::open(Some(data.clone()), Some(&path)));
    }
    let settings_path = roamgate_base::settings::settings_path(env.as_ref(), &data)
        .unwrap_or_else(|_| data.data_root().join(DataFile::Settings.name()));
    let title_suffix = Box::new(move || {
        let raw = std::fs::read_to_string(&settings_path)
            .ok()
            .and_then(|text| serde_json::from_str(&text).ok())
            .unwrap_or(serde_json::Value::Null);
        Settings::normalize(&raw)
            .get("title_suffix")
            .and_then(|value| value.as_str())
            .unwrap_or("")
            .to_owned()
    });

    let runtime_dir = root.join("runtime");
    if let Err(error) = roamgate_base::private::create_private_dir(&runtime_dir) {
        eprintln!(
            "[bridge] FATAL: cannot create {}: {error}",
            runtime_dir.display()
        );
        return 1;
    }
    let channel = runtime_dir.join(format!("core-{}.sock", std::process::id()));
    let own_exe = std::env::current_exe().unwrap_or_default();
    let command =
        SidecarCommand::resolve(env.var("ROAMGATE_SIDECAR_BIN").as_deref(), &own_exe, args);
    let standalone = command.standalone;
    let (link, core) = watch::channel(None);
    let mut clock_server = None;
    // The environment file's entries reach the core as the front's own.
    let mut core_env: Vec<(String, String)> = overrides.into_iter().collect();
    // Record mode (`ROAMGATE_CONTRACT_RECORD`): with no Bun the front
    // records the browser's requests and sockets, and its core the
    // processes it runs, in the directory the front resolved. Behind a Bun
    // core the recording stays Bun's (its channel's frames).
    let recorder = if standalone {
        let recorder = start_recorder(env.as_ref(), &root, &clock);
        core_env.push((
            CONTRACT_RECORD_ENV.into(),
            recorder.as_ref().map_or_else(
                || "0".into(),
                |recorder| recorder.directory().to_string_lossy().into_owned(),
            ),
        ));
        recorder
    } else {
        None
    };
    if let Some(recorder) = &recorder {
        for secret in [
            config.password.as_str(),
            config.pin.as_deref().unwrap_or(""),
            session_secret.as_str(),
        ] {
            recorder.redactor.add_secret(secret);
        }
        let mut fields = roamgate_base::log::LogFields::new();
        fields.insert(
            "directory".into(),
            recorder.directory().to_string_lossy().into_owned().into(),
        );
        logger.info("contract record mode on", Some(&fields));
    }
    let record_flusher = recorder
        .as_ref()
        .map(|recorder| recorder.run_flusher(clock.clone()));
    // The Bun core runs the Rust core ROAMGATE_CORE_BIN names, as it does
    // behind the Bun front (stage 1): its owners table and handovers are
    // unchanged. The update family replaces this front's executable, in
    // the Bun core's Rust core as in a standalone one.
    core_env.push((
        "ROAMGATE_CLI_EXEC".into(),
        own_exe.to_string_lossy().into_owned(),
    ));
    // With no Bun, a debug build is a checkout's, not an installed binary
    // (an update must not replace it), as the Bun server run from source.
    let from_source = if standalone {
        cfg!(debug_assertions)
    } else {
        env.var("ROAMGATE_SIDECAR_BIN")
            .is_some_and(|bin| bin.ends_with(".ts"))
    };
    core_env.push((
        "ROAMGATE_CLI_STANDALONE".into(),
        if from_source { "0" } else { "1" }.into(),
    ));
    // The Rust core the Bun core runs links to this front for the
    // sockets of the families it owns (the voice family's).
    let link_path = runtime_dir.join(format!("front-{}.sock", std::process::id()));
    let link_token = link_token();
    if !standalone {
        core_env.push((
            roamgate_sidecar::core::FRONT_CHANNEL_ENV.into(),
            link_path.to_string_lossy().into_owned(),
        ));
        core_env.push((
            roamgate_sidecar::core::FRONT_TOKEN_ENV.into(),
            link_token.clone(),
        ));
    }
    let core_clock_path = runtime_dir.join(format!("core-clock-{}.sock", std::process::id()));
    if let (Some(found), Some(test)) = (&test_clock, &virtual_clock) {
        let relay = if standalone {
            CoreClock::Channel(core.clone())
        } else {
            CoreClock::Socket(core_clock_path.clone())
        };
        #[cfg(unix)]
        match serve_front_clock(test.clone(), &found.socket, relay) {
            Ok(task) => clock_server = Some(task),
            Err(error) => {
                eprintln!(
                    "roamgate: cannot serve the test clock at {}: {error}",
                    found.socket.display()
                );
                return 1;
            }
        }
        #[cfg(not(unix))]
        let _ = relay;
        // A standalone core follows this clock over the channel instead
        // (empty: no test clock of its own).
        core_env.push((
            roamgate_base::clock::TEST_CLOCK_ENV.into(),
            if standalone {
                String::new()
            } else {
                core_clock_path.to_string_lossy().into_owned()
            },
        ));
    }
    let start_clock = clock.clone();
    let has_test_clock = virtual_clock.is_some() && !standalone;
    // The CPU profile (`--profile`, utils/cpu-profile.ts) samples where the
    // server's work runs: the standalone core, the first one only (a
    // restarted core is not profiled again, as Bun profiled its one start).
    let profile = config.profile.clone().filter(|_| standalone);
    let profiled = std::sync::atomic::AtomicBool::new(false);
    let core_env = Arc::new(move || {
        let mut env = core_env.clone();
        if let Some(profile) = &profile {
            if profiled.swap(true, std::sync::atomic::Ordering::SeqCst) {
                env.push((crate::PROFILE_ENV.into(), "0".into()));
            } else {
                env.push((crate::PROFILE_ENV.into(), "1".into()));
                env.push((
                    crate::PROFILE_DURATION_ENV.into(),
                    (profile.duration_ms / 1000).to_string(),
                ));
                env.push((
                    crate::PROFILE_DIR_ENV.into(),
                    profile.directory.to_string_lossy().into_owned(),
                ));
            }
        } else if standalone {
            // The front decides: a profile its flags and environment did
            // not ask for is not the core's either.
            env.push((crate::PROFILE_ENV.into(), "0".into()));
        }
        if has_test_clock {
            env.push((
                roamgate_base::clock::TEST_CLOCK_EPOCH_ENV.into(),
                start_clock.now().to_string(),
            ));
        }
        env
    });
    let address = format!("{}:{}", config.host, config.port);
    let listener = match tokio::net::TcpListener::bind(&address).await {
        Ok(listener) => listener,
        Err(error) => {
            eprintln!("[bridge] FATAL: cannot listen on {address}: {error}");
            return 1;
        }
    };
    let bound: SocketAddr = listener.local_addr().expect("listener address");
    let mut fields = roamgate_base::log::LogFields::new();
    fields.insert(
        "url".into(),
        roamgate_cli::server_config::browser_url_for(&config.host, bound.port(), tls.is_some())
            .into(),
    );
    fields.insert("websocket".into(), "/ws".into());
    fields.insert("log_level".into(), config.log_level.as_str().into());
    // Listening as the first core is welcomed, before it starts its
    // connections: the Bun server listens, then connects.
    let listening = {
        let logged = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let logger = logger.clone();
        Arc::new(move || {
            if !logged.swap(true, std::sync::atomic::Ordering::SeqCst) {
                logger.info("listening", Some(&fields));
            }
        })
    };
    // The Bun core says how logins work; with no Bun, the front does.
    if standalone && config.auth_required {
        let mut fields = roamgate_base::log::LogFields::new();
        match &config.generated_auth_token_path {
            Some(path) => {
                fields.insert("mode".into(), "generated token".into());
                fields.insert("path".into(), path.to_string_lossy().into_owned().into());
            }
            None => {
                fields.insert("mode".into(), "password".into());
            }
        }
        logger.info("authentication required", Some(&fields));
    }
    let sockets = match &recorder {
        Some(recorder) => Sockets::recorded(recorder.clone()),
        None => Sockets::default(),
    };
    let (stop_core, core_stop) = watch::channel(false);
    let (rust_link, rust_core) = watch::channel(None);
    // A standalone core is the Rust core: no link besides the channel.
    let rust_link_task = (!standalone).then(|| {
        tokio::spawn(run_rust_core_link(
            RustCoreLinkConfig {
                channel: link_path.to_string_lossy().into_owned(),
                token: link_token,
                clock: Arc::new(SystemClock),
            },
            sockets.clone(),
            rust_link,
            core_stop.clone(),
        ))
    });
    let exit_now = Arc::new(tokio::sync::Notify::new());
    // The front's auth, once the router holds it.
    let front_cell: Arc<std::sync::OnceLock<std::sync::Weak<Front>>> = Arc::default();
    let standalone_core = standalone.then(|| StandaloneCore {
        test_clock: virtual_clock
            .clone()
            .map(|test| Arc::new(test) as roamgate_base::clock::SharedClock),
        start: json!({
            "socket_path": config.socket_path,
            "client_socket_path": config.client_socket_path,
            "ssh_host": config.ssh_host,
            "session": config.session,
            "has_explicit_socket_path": config.has_explicit_socket_path,
            "has_explicit_client_socket_path": config.has_explicit_client_socket_path,
            "task_notification_source": config.task_notification_source,
            "auth_required": config.auth_required,
            "tls": config.tls.is_some(),
            "port": bound.port(),
            "generations": {},
        }),
        // index.ts `scheduleManagedShutdown`: a second, then the server
        // stops as on a signal, with code 0.
        schedule_exit: {
            let exit = exit_now.clone();
            Arc::new(move || {
                let exit = exit.clone();
                tokio::spawn(async move {
                    tokio::time::sleep(std::time::Duration::from_secs(1)).await;
                    exit.notify_one();
                });
            })
        },
        session_cookie: {
            let front = front_cell.clone();
            Arc::new(move || {
                front
                    .get()
                    .and_then(std::sync::Weak::upgrade)
                    .and_then(|front| front.auth.new_session_cookie())
            })
        },
    });
    let sidecar = tokio::spawn(run_sidecar(
        SidecarConfig {
            command,
            channel: channel.to_string_lossy().into_owned(),
            // The channel's pings and silence run on real time, as the Bun
            // front's do: a test clock's advance is no silence.
            clock: Arc::new(SystemClock),
            env: core_env,
            on_welcome: listening.clone(),
            standalone: standalone_core,
        },
        sockets.clone(),
        link,
        core_stop,
    ));
    let front = Arc::new(
        Front::new(
            auth,
            {
                let mut files = static_dirs(
                    public_dir(args, env.as_ref()),
                    built_public_dir(env.var("ROAMGATE_SIDECAR_BIN").as_deref()),
                );
                if standalone {
                    files.embedded = Some(crate::embedded_web());
                }
                files
            },
            title_suffix,
            core,
            sockets,
        )
        .with_rust_core(rust_core)
        .with_node_origins(roamgate_http::node_origins::NodeOrigins::parse(
            roamgate_env(env.as_ref(), "NODE_ORIGINS").as_deref(),
        )),
    );
    let _ = front_cell.set(Arc::downgrade(&front));
    // A core that never comes: listening all the same, its requests 503.
    tokio::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_secs(60)).await;
        listening();
    });
    let service = app(front).into_make_service_with_connect_info::<SocketAddr>();
    let served = match tls {
        Some(tls) => match crate::front_tls::TlsListener::new(listener, tls) {
            Ok(listener) => {
                use axum::serve::ListenerExt;
                axum::serve(listener.tap_io(|_| {}), service)
                    .with_graceful_shutdown(shutdown(exit_now.clone()))
                    .await
            }
            Err(error) => Err(error),
        },
        None => {
            use axum::serve::ListenerExt;
            // No Nagle: a keystroke's echo is one small frame, which would
            // otherwise wait for the browser's delayed ACK (40 ms).
            axum::serve(
                listener.tap_io(|tcp| {
                    let _ = tcp.set_nodelay(true);
                }),
                service,
            )
            .with_graceful_shutdown(shutdown(exit_now.clone()))
            .await
        }
    };
    let _ = stop_core.send(true);
    let _ = sidecar.await;
    if let Some(task) = rust_link_task {
        let _ = task.await;
    }
    if let Some(task) = clock_server {
        task.abort();
    }
    if let Some(task) = record_flusher {
        task.abort();
    }
    if let Some(recorder) = &recorder {
        recorder.close();
    }
    let _ = std::fs::remove_file(&channel);
    let _ = std::fs::remove_file(&core_clock_path);
    match served {
        Ok(()) => 0,
        Err(error) => {
            eprintln!("[bridge] {error}");
            1
        }
    }
}
