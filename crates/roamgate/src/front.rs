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
    if config.tls.is_some() {
        eprintln!(
            "[bridge] FATAL: the Rust front does not serve TLS yet; run the Bun front for --tls-cert"
        );
        return 1;
    }
    let data = runtime.data();
    let root = data.data_root();
    let clock = Arc::new(SystemClock);
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
    let settings_path = data.data_root().join(DataFile::Settings.name());
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
    let sockets = Sockets::default();
    let (link, core) = watch::channel(None);
    let sidecar = tokio::spawn(run_sidecar(
        SidecarConfig {
            command,
            channel: channel.to_string_lossy().into_owned(),
            clock,
        },
        sockets.clone(),
        link,
    ));
    let front = Arc::new(Front::new(
        auth,
        static_dirs(public_dir(args, env.as_ref()), None),
        title_suffix,
        core,
        sockets,
    ));
    let address = format!("{}:{}", config.host, config.port);
    let listener = match tokio::net::TcpListener::bind(&address).await {
        Ok(listener) => listener,
        Err(error) => {
            eprintln!("[bridge] FATAL: cannot listen on {address}: {error}");
            sidecar.abort();
            return 1;
        }
    };
    let bound: SocketAddr = listener.local_addr().expect("listener address");
    println!("[bridge] Rust front listening on http://{bound}");
    let served = axum::serve(
        listener,
        app(front).into_make_service_with_connect_info::<SocketAddr>(),
    )
    .with_graceful_shutdown(shutdown())
    .await;
    sidecar.abort();
    let _ = std::fs::remove_file(&channel);
    match served {
        Ok(()) => 0,
        Err(error) => {
            eprintln!("[bridge] {error}");
            1
        }
    }
}
