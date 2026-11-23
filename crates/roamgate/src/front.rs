//! `roamgate front [server flags]` (hidden): the Rust front of stage 2
//! (contract/wire/core-channel.md), with the Bun server as its portless
//! core. Reads the server's configuration as the Bun server does, holds
//! the port and serves until SIGTERM or Ctrl-C.

use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Arc;

use roamgate_base::clock::SystemClock;
use roamgate_base::env::{Env, ProcessEnv, roamgate_env};
use roamgate_base::paths::DataFile;
use roamgate_base::revoked_sessions::RevokedSessions;
use roamgate_base::session_secret::{
    load_or_create_session_secret, revoked_sessions_path, session_secret_path_from_env,
};
use roamgate_base::settings::Settings;
use roamgate_cli::auth_token::auth_token_print_command;
use roamgate_cli::herdr::HerdrCli;
use roamgate_cli::server_config::load_server_config;
use roamgate_http::auth::{Auth, AuthConfig};
use roamgate_http::front::{
    Front, SidecarCommand, SidecarConfig, Sockets, app, run_sidecar, static_dirs,
};
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
/// harness's socket, and relayed to the core, which runs its own test clock
/// on a private socket started at the front's time. Each `advance` moves
/// the front's clock, then the core's, and replies once both ran their
/// due timers.
#[cfg(unix)]
fn serve_front_clock(
    clock: roamgate_base::clock::TestClock,
    path: &std::path::Path,
    core: PathBuf,
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
                        relay_to_core(&core, line.trim()).await;
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

/// The web build the Bun server serves after the public directory: run
/// from source (`server/src/index.ts`), its `server/public`.
fn built_public_dir(sidecar_bin: Option<&str>) -> Option<PathBuf> {
    let entry = PathBuf::from(sidecar_bin.filter(|bin| bin.ends_with(".ts"))?);
    Some(entry.parent()?.parent()?.join("public"))
}

async fn shutdown() {
    #[cfg(unix)]
    {
        use tokio::signal::unix::{SignalKind, signal};
        let mut term = signal(SignalKind::terminate()).expect("SIGTERM handler");
        tokio::select! {
            _ = tokio::signal::ctrl_c() => {}
            _ = term.recv() => {}
        }
    }
    #[cfg(not(unix))]
    let _ = tokio::signal::ctrl_c().await;
}

pub async fn run(args: &[String]) -> u8 {
    let env: Arc<dyn Env> = Arc::new(ProcessEnv);
    let cli = HerdrCli::system(env.clone(), crate::VERSION.into());
    let runtime = cli.config_runtime();
    let config = match load_server_config(args, env.as_ref(), &runtime, crate::VERSION) {
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
    let mut own_env: std::collections::HashMap<String, String> = std::env::vars().collect();
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
    let mut clock_server = None;
    let mut core_env: Vec<(String, String)> = Vec::new();
    // The Bun core runs the Rust core ROAMGATE_CORE_BIN names, as it does
    // behind the Bun front (stage 1): its owners table and handovers are
    // unchanged. The update family replaces this front's executable.
    core_env.push((
        "ROAMGATE_CLI_EXEC".into(),
        own_exe.to_string_lossy().into_owned(),
    ));
    let from_source = env
        .var("ROAMGATE_SIDECAR_BIN")
        .is_some_and(|bin| bin.ends_with(".ts"));
    core_env.push((
        "ROAMGATE_CLI_STANDALONE".into(),
        if from_source { "0" } else { "1" }.into(),
    ));
    let core_clock_path = runtime_dir.join(format!("core-clock-{}.sock", std::process::id()));
    if let (Some(found), Some(test)) = (&test_clock, &virtual_clock) {
        #[cfg(unix)]
        match serve_front_clock(test.clone(), &found.socket, core_clock_path.clone()) {
            Ok(task) => clock_server = Some(task),
            Err(error) => {
                eprintln!(
                    "roamgate: cannot serve the test clock at {}: {error}",
                    found.socket.display()
                );
                return 1;
            }
        }
        core_env.push((
            roamgate_base::clock::TEST_CLOCK_ENV.into(),
            core_clock_path.to_string_lossy().into_owned(),
        ));
    }
    let start_clock = clock.clone();
    let has_test_clock = virtual_clock.is_some();
    let core_env = Arc::new(move || {
        let mut env = core_env.clone();
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
    let sockets = Sockets::default();
    let (link, core) = watch::channel(None);
    let (stop_core, core_stop) = watch::channel(false);
    let sidecar = tokio::spawn(run_sidecar(
        SidecarConfig {
            command,
            channel: channel.to_string_lossy().into_owned(),
            // The channel's pings and silence run on real time, as the Bun
            // front's do: a test clock's advance is no silence.
            clock: Arc::new(SystemClock),
            env: core_env,
            on_welcome: listening.clone(),
        },
        sockets.clone(),
        link,
        core_stop,
    ));
    let front = Arc::new(Front::new(
        auth,
        static_dirs(
            public_dir(args, env.as_ref()),
            built_public_dir(env.var("ROAMGATE_SIDECAR_BIN").as_deref()),
        ),
        title_suffix,
        core,
        sockets,
    ));
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
                    .with_graceful_shutdown(shutdown())
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
            .with_graceful_shutdown(shutdown())
            .await
        }
    };
    let _ = stop_core.send(true);
    let _ = sidecar.await;
    if let Some(task) = clock_server {
        task.abort();
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
