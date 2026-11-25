//! The server: `roamgate [server flags]` (and the hidden alias `roamgate
//! front [server flags]`), the front of contract/wire/core-channel.md with
//! its own executable as its portless core (`roamgate core`). Reads the
//! server's configuration, holds the port and serves until SIGTERM or
//! Ctrl-C.

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
use roamgate_http::front::{CoreConfig, CoreSetup, Front, Sockets, app, run_core, static_dirs};
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

/// The front's test clock (contract/wire/test-clock.md): served on the
/// harness's socket, and relayed to the core, which follows it from its
/// `welcome` on (`internal.clock.advance` on the channel). Each `advance`
/// moves the front's clock, then the core's, and replies once both ran
/// their due timers.
fn serve_front_clock(
    clock: roamgate_base::clock::TestClock,
    path: &std::path::Path,
    core: roamgate_http::front::CoreLink,
) -> std::io::Result<tokio::task::JoinHandle<()>> {
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
    let _ = std::fs::remove_file(path);
    let listener = roamgate_base::local_socket::Listener::bind(path)?;
    Ok(tokio::spawn(async move {
        while let Ok(stream) = listener.accept().await {
            let clock = clock.clone();
            let core = core.clone();
            tokio::spawn(async move {
                let (read, mut write) = tokio::io::split(stream);
                let mut lines = BufReader::new(read).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    if line.trim().is_empty() {
                        continue;
                    }
                    let reply = roamgate_base::clock::answer(&clock, &line).await;
                    if line.trim().starts_with("advance") && !reply.starts_with("error") {
                        let peer = core.borrow().peer().cloned();
                        if let Some(peer) = peer.filter(|peer| !peer.is_closed()) {
                            let to = roamgate_base::clock::Clock::now(&clock);
                            let _ = peer
                                .call(
                                    "internal.clock.advance",
                                    json!({ "to": to }),
                                    Default::default(),
                                )
                                .await;
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

/// Record mode's variable.
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

/// Opens the platform's browser on `url` (`--open`, `OPEN_BROWSER=1`); a
/// failure is logged, never fatal.
fn open_browser(logger: &roamgate_base::log::Logger, url: &str) {
    let (opener, args): (&str, Vec<&str>) = if cfg!(target_os = "macos") {
        ("open", vec![url])
    } else if cfg!(windows) {
        ("cmd", vec!["/c", "start", "", url])
    } else {
        ("xdg-open", vec![url])
    };
    let spawned = std::process::Command::new(opener)
        .args(args)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn();
    match spawned {
        // Reaped when it exits.
        Ok(mut child) => {
            std::thread::spawn(move || child.wait());
        }
        Err(error) => {
            let mut fields = roamgate_base::log::LogFields::new();
            fields.insert("error".into(), error.to_string().into());
            logger.warn("failed to open browser", Some(&fields));
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
    // A node's title is its own (`roamgate node --title-suffix`): it has
    // no settings of its own.
    let node_title = env
        .var(crate::node::listen::TITLE_SUFFIX_ENV)
        .filter(|_| roamgate_base::node::home(env.as_ref()).is_some());
    let title_suffix = Box::new(move || {
        if let Some(title) = &node_title {
            return title.clone();
        }
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
    let channel = roamgate_channel::transport::channel_address(&runtime_dir, std::process::id());
    let own_exe = std::env::current_exe().unwrap_or_default();
    let (link, core) = watch::channel(roamgate_http::front::CoreState::Starting);
    let mut clock_server = None;
    // The environment file's entries reach the core as the front's own.
    let mut core_env: Vec<(String, String)> = overrides.into_iter().collect();
    // Record mode (`ROAMGATE_CONTRACT_RECORD`): the front records the
    // browser's requests and sockets, and its core the processes it runs,
    // in the directory the front resolved.
    let recorder = start_recorder(env.as_ref(), &root, &clock);
    core_env.push((
        CONTRACT_RECORD_ENV.into(),
        recorder.as_ref().map_or_else(
            || "0".into(),
            |recorder| recorder.directory().to_string_lossy().into_owned(),
        ),
    ));
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
    // The update family replaces this front's executable.
    core_env.push((
        "ROAMGATE_CLI_EXEC".into(),
        own_exe.to_string_lossy().into_owned(),
    ));
    // A debug build is a checkout's, not an installed binary (an update
    // must not replace it).
    let from_source = cfg!(debug_assertions);
    core_env.push((
        "ROAMGATE_CLI_STANDALONE".into(),
        if from_source { "0" } else { "1" }.into(),
    ));
    if let (Some(found), Some(test)) = (&test_clock, &virtual_clock) {
        match serve_front_clock(test.clone(), &found.socket, core.clone()) {
            Ok(task) => clock_server = Some(task),
            Err(error) => {
                eprintln!(
                    "roamgate: cannot serve the test clock at {}: {error}",
                    found.socket.display()
                );
                return 1;
            }
        }
        // The core follows this clock over the channel (empty: no test
        // clock of its own).
        core_env.push((roamgate_base::clock::TEST_CLOCK_ENV.into(), String::new()));
    }
    // The CPU profile (`--profile`) samples where the server's work runs:
    // the core, the first one only (a restarted core is not profiled
    // again).
    let profile = config.profile.clone();
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
        } else {
            // The front decides: a profile its flags and environment did
            // not ask for is not the core's either.
            env.push((crate::PROFILE_ENV.into(), "0".into()));
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
    let browser_url =
        roamgate_cli::server_config::browser_url_for(&config.host, bound.port(), tls.is_some());
    let mut fields = roamgate_base::log::LogFields::new();
    fields.insert("url".into(), browser_url.clone().into());
    fields.insert("websocket".into(), "/ws".into());
    fields.insert("log_level".into(), config.log_level.as_str().into());
    // Listening as the first core is welcomed, before it starts its
    // connections.
    let listening = {
        let logged = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let logger = logger.clone();
        let open = config.open_browser_requested;
        Arc::new(move || {
            if !logged.swap(true, std::sync::atomic::Ordering::SeqCst) {
                logger.info("listening", Some(&fields));
                if open {
                    open_browser(&logger, &browser_url);
                }
            }
        })
    };
    if config.auth_required {
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
    let exit_now = Arc::new(tokio::sync::Notify::new());
    // The front's auth, once the router holds it.
    let front_cell: Arc<std::sync::OnceLock<std::sync::Weak<Front>>> = Arc::default();
    let setup = CoreSetup {
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
    };
    let core_task = tokio::spawn(run_core(
        CoreConfig {
            program: own_exe,
            channel: channel.clone(),
            // The channel's pings and silence run on real time: a test
            // clock's advance is no silence.
            clock: Arc::new(SystemClock),
            env: core_env,
            on_welcome: listening.clone(),
            setup,
        },
        sockets.clone(),
        link,
        core_stop,
    ));
    let front = Arc::new(
        Front::new(
            auth,
            {
                let mut files = static_dirs(public_dir(args, env.as_ref()), None);
                files.embedded = Some(crate::embedded_web());
                files
            },
            title_suffix,
            core,
            sockets,
        )
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
    let _ = core_task.await;
    if let Some(task) = clock_server {
        task.abort();
    }
    if let Some(task) = record_flusher {
        task.abort();
    }
    if let Some(recorder) = &recorder {
        recorder.close();
    }
    if !roamgate_channel::transport::is_named_pipe(&channel) {
        let _ = std::fs::remove_file(&channel);
    }
    match served {
        Ok(()) => 0,
        Err(error) => {
            eprintln!("[bridge] {error}");
            1
        }
    }
}
