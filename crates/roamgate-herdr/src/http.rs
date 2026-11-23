//! `/api/herdr/status` and `/api/herdr/setup` (http/herdr-setup) and the
//! server identity answer of `/api/herdr-info` (http/herdr-info), as status
//! codes and JSON bodies; the HTTP plumbing is the caller's.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use serde_json::{Map, Value, json};

use crate::BoxFuture;
use crate::bootstrap::{
    Locations, Ping, Setup, SetupGuard, SetupOutcome, SetupState, assert_managed_setup_allowed,
    detect_herdr_setup, setup_herdr,
};
use crate::release::{VERIFIED_HERDR_VERSION, resolve_herdr_release_target};

pub const HERDR_SETUP_CONFIRMATION_HEADER: &str = "x-roamgate-herdr-setup";

/// An answer: its status and JSON body (always sent `cache-control:
/// no-store`).
pub type Answer = (u16, Value);

fn error(status: u16, message: impl Into<String>) -> Answer {
    (status, json!({ "error": message.into() }))
}

/// The default connection's setup guard, or why there is none.
pub type GuardSource = Arc<dyn Fn() -> BoxFuture<Result<SetupGuard, String>> + Send + Sync>;

/// Makes the setup of a request (its guard and ping given).
pub type MakeSetup = Arc<dyn Fn(SetupGuard, Ping) -> Setup + Send + Sync>;

/// The status and setup routes.
pub struct SetupHandlers {
    pub guard: GuardSource,
    pub ping: Ping,
    pub locations: Locations,
    pub arch: String,
    pub make_setup: MakeSetup,
    in_progress: AtomicBool,
}

fn state_payload(state: &SetupState) -> Map<String, Value> {
    let mut payload = Map::new();
    match state {
        SetupState::Running { version, protocol } => {
            payload.insert("state".into(), "running".into());
            payload.insert("version".into(), version.clone().into());
            payload.insert("protocol".into(), Value::Number(protocol.clone()));
        }
        SetupState::Installed { binary_path } => {
            payload.insert("state".into(), "installed".into());
            payload.insert(
                "binary_path".into(),
                binary_path.display().to_string().into(),
            );
        }
        SetupState::Missing => {
            payload.insert("state".into(), "missing".into());
        }
    }
    payload
}

fn outcome_payload(outcome: &SetupOutcome) -> Value {
    match outcome {
        SetupOutcome::AlreadyRunning { version, protocol } => json!({
            "ok": true,
            "outcome": "already-running",
            "version": version,
            "protocol": protocol,
        }),
        SetupOutcome::Started {
            installed,
            binary_path,
            version,
            protocol,
        } => json!({
            "ok": true,
            "outcome": if *installed { "installed-and-started" } else { "started" },
            "version": version,
            "protocol": protocol,
            "binary_path": binary_path.display().to_string(),
        }),
    }
}

impl SetupHandlers {
    pub fn new(
        guard: GuardSource,
        ping: Ping,
        locations: Locations,
        arch: String,
        make_setup: MakeSetup,
    ) -> Self {
        Self {
            guard,
            ping,
            locations,
            arch,
            make_setup,
            in_progress: AtomicBool::new(false),
        }
    }

    /// `GET /api/herdr/status`.
    pub async fn status(&self) -> Answer {
        let guard = match (self.guard)().await {
            Ok(guard) => guard,
            Err(message) => return error(500, message),
        };
        let can_setup = assert_managed_setup_allowed(&guard).is_ok();
        let state = detect_herdr_setup(&self.ping, &self.locations).await;
        let has_release =
            resolve_herdr_release_target(&self.locations.platform, &self.arch).is_some();
        let mut payload = state_payload(&state);
        payload.insert(
            "can_setup".into(),
            (can_setup && (state != SetupState::Missing || has_release)).into(),
        );
        payload.insert("verified_version".into(), VERIFIED_HERDR_VERSION.into());
        (200, Value::Object(payload))
    }

    /// `POST /api/herdr/setup`; `confirmed`: its confirmation header is 1.
    pub async fn setup(&self, confirmed: bool) -> Answer {
        if !confirmed {
            return error(403, "Herdr setup confirmation header is required.");
        }
        if self.in_progress.swap(true, Ordering::SeqCst) {
            return error(409, "A Herdr setup is already in progress.");
        }
        let answer = match (self.guard)().await {
            Err(message) => error(500, message),
            Ok(guard) => {
                let setup = (self.make_setup)(guard, self.ping.clone());
                match setup_herdr(&setup).await {
                    Ok(outcome) => (200, outcome_payload(&outcome)),
                    Err(message) => error(500, message),
                }
            }
        };
        self.in_progress.store(false, Ordering::SeqCst);
        answer
    }
}

/// `/api/herdr-info`'s answer to a ping: the identity, or 503.
pub fn herdr_info(ping: Result<Value, String>) -> Answer {
    let info = match ping {
        Ok(info) => info,
        Err(message) => return error(503, message),
    };
    let version = info.get("version").and_then(Value::as_str);
    let protocol = info.get("protocol").and_then(Value::as_f64);
    match (version, protocol) {
        (Some(version), Some(protocol))
            if !version.trim().is_empty() && protocol.fract() == 0.0 && protocol >= 1.0 =>
        {
            (
                200,
                json!({ "version": version, "protocol": info["protocol"].clone() }),
            )
        }
        _ => error(503, "Herdr returned invalid server information"),
    }
}

#[cfg(test)]
mod tests {
    use std::path::{Path, PathBuf};
    use std::time::Duration;

    use roamgate_base::clock::SystemClock;

    use super::*;

    fn handlers(
        guard: SetupGuard,
        ping: Ping,
        platform: &str,
        arch: &str,
        home: &Path,
    ) -> SetupHandlers {
        let guard = Arc::new(guard);
        SetupHandlers::new(
            Arc::new(move || {
                let guard = (*guard).clone();
                Box::pin(async move { Ok(guard) })
            }),
            ping,
            Locations {
                platform: platform.into(),
                home: home.into(),
                app_data: Some(home.into()),
                path_env: home.display().to_string(),
            },
            arch.into(),
            Arc::new(|guard, ping| Setup {
                guard,
                locations: Locations {
                    platform: "linux".into(),
                    home: PathBuf::from("/nowhere"),
                    app_data: None,
                    path_env: String::new(),
                },
                ping,
                install_release: Arc::new(|| {
                    Box::pin(async { Err("no download in tests".to_owned()) })
                }),
                install_service: Arc::new(|_| Err("must not install a service".into())),
                start_timeout: Duration::from_secs(15),
                poll_interval: Duration::from_millis(250),
                clock: Arc::new(SystemClock),
                sleep: Arc::new(|_| Box::pin(async {})),
            }),
        )
    }

    fn not_running() -> Ping {
        Arc::new(|| Box::pin(async { Err("not running".to_owned()) }))
    }

    fn running() -> Ping {
        Arc::new(|| Box::pin(async { Ok(json!({"version": "0.9.0", "protocol": 22})) }))
    }

    #[tokio::test]
    async fn missing_installations_require_a_verified_asset_existing_binaries_do_not() {
        let home = tempfile::tempdir().unwrap();
        for (platform, arch, available) in [
            ("win32", "arm64", false),
            ("freebsd", "x64", false),
            ("linux", "x64", true),
        ] {
            let handlers = handlers(
                SetupGuard::default(),
                not_running(),
                platform,
                arch,
                home.path(),
            );
            let (_, body) = handlers.status().await;
            assert_eq!(body["state"], "missing");
            assert_eq!(body["can_setup"], available, "{platform}-{arch}");
            let binary = home.path().join(if platform == "win32" {
                "herdr.exe"
            } else {
                "herdr"
            });
            std::fs::write(&binary, "existing installation").unwrap();
            let (_, body) = handlers.status().await;
            assert_eq!(body["state"], "installed");
            assert_eq!(body["can_setup"], true);
            std::fs::remove_file(binary).unwrap();
        }
    }

    #[tokio::test]
    async fn setup_ui_metadata_uses_the_pinned_release_and_hides_unsupported_targets() {
        let home = tempfile::tempdir().unwrap();
        for guard in [
            SetupGuard::default(),
            SetupGuard {
                ssh_host: Some("example.com".into()),
                ..Default::default()
            },
            SetupGuard {
                session: Some("work".into()),
                ..Default::default()
            },
            SetupGuard {
                has_explicit_socket_path: true,
                ..Default::default()
            },
        ] {
            let allowed = guard == SetupGuard::default();
            let handlers = handlers(guard, running(), "linux", "x64", home.path());
            assert_eq!(
                handlers.status().await,
                (
                    200,
                    json!({
                        "state": "running",
                        "version": "0.9.0",
                        "protocol": 22,
                        "can_setup": allowed,
                        "verified_version": VERIFIED_HERDR_VERSION,
                    })
                )
            );
            assert_eq!(
                handlers.setup(false).await,
                (
                    403,
                    json!({"error": "Herdr setup confirmation header is required."})
                )
            );
        }
    }

    #[tokio::test]
    async fn a_failed_setup_releases_the_setup_lock() {
        let home = tempfile::tempdir().unwrap();
        let handlers = handlers(
            SetupGuard::default(),
            not_running(),
            "linux",
            "x64",
            home.path(),
        );
        let (status, body) = handlers.setup(true).await;
        assert_eq!(status, 500);
        assert_eq!(body["error"], "no download in tests");
        // Released: the next request runs again rather than 409.
        assert_eq!(handlers.setup(true).await.0, 500);
    }

    /// The download's own deadline is the shared module's (tested with a
    /// stalled server in roamgate-exec): here, a stalled download holds the
    /// lock (409) until its deadline fails it, which leaves no staging and
    /// frees the lock.
    #[tokio::test]
    async fn download_deadline_aborts_stalled_headers_and_bodies_and_releases_the_setup_lock() {
        use crate::release::{InstallHerdr, herdr_install_root, install_verified_herdr};
        let home = tempfile::tempdir().unwrap();
        let root = home.path().to_path_buf();
        let (release_tx, release_rx) = tokio::sync::watch::channel(false);
        let started = Arc::new(tokio::sync::Notify::new());
        let running_flag = Arc::new(AtomicBool::new(false));
        let ping_flag = running_flag.clone();
        let ping: Ping = Arc::new(move || {
            let up = ping_flag.load(Ordering::SeqCst);
            Box::pin(async move {
                if up {
                    Ok(json!({"version": "0.9.0", "protocol": 22}))
                } else {
                    Err("not running".to_owned())
                }
            })
        });
        let notify = started.clone();
        let handlers = SetupHandlers::new(
            Arc::new(|| Box::pin(async { Ok(SetupGuard::default()) })),
            ping,
            Locations {
                platform: "linux".into(),
                home: root.clone(),
                app_data: None,
                path_env: String::new(),
            },
            "x64".into(),
            Arc::new(move |guard, ping| {
                let root = root.clone();
                let notify = notify.clone();
                let release_rx = release_rx.clone();
                Setup {
                    guard,
                    locations: Locations {
                        platform: "linux".into(),
                        home: root.clone(),
                        app_data: None,
                        path_env: String::new(),
                    },
                    ping,
                    install_release: Arc::new(move || {
                        let root = root.clone();
                        let notify = notify.clone();
                        let release_rx = release_rx.clone();
                        Box::pin(async move {
                            let download: crate::release::Download =
                                Arc::new(move |_url, _path| {
                                    let notify = notify.clone();
                                    let mut release_rx = release_rx.clone();
                                    Box::pin(async move {
                                        notify.notify_one();
                                        let _ = release_rx.wait_for(|fired| *fired).await;
                                        Err("Herdr download timed out".to_owned())
                                    })
                                });
                            install_verified_herdr(&InstallHerdr {
                                platform: "linux".into(),
                                arch: "x64".into(),
                                home: root,
                                app_data: None,
                                download,
                                run: Arc::new(roamgate_exec::service::fake::Recorder::new(|_| 0)),
                                expected_sha256: None,
                            })
                            .await
                            .map(|installed| installed.binary_path)
                        })
                    }),
                    install_service: Arc::new(|_| Err("must not install a service".into())),
                    start_timeout: Duration::from_secs(15),
                    poll_interval: Duration::from_millis(250),
                    clock: Arc::new(SystemClock),
                    sleep: Arc::new(|_| Box::pin(async {})),
                }
            }),
        );
        let handlers = Arc::new(handlers);
        let pending = tokio::spawn({
            let handlers = handlers.clone();
            async move { handlers.setup(true).await }
        });
        started.notified().await;
        assert_eq!(handlers.setup(true).await.0, 409);
        release_tx.send(true).unwrap();
        let (status, body) = pending.await.unwrap();
        assert_eq!(status, 500);
        assert!(
            body["error"].as_str().unwrap().contains("timed out"),
            "{body}"
        );
        let install_root = herdr_install_root(home.path(), None, "linux");
        assert!(!install_root.join("herdr").exists());
        assert_eq!(std::fs::read_dir(&install_root).unwrap().count(), 0);
        running_flag.store(true, Ordering::SeqCst);
        assert_eq!(handlers.setup(true).await.0, 200);
    }

    #[test]
    fn returns_only_the_connected_server_identity() {
        assert_eq!(
            herdr_info(Ok(
                json!({"version": "0.7.4", "protocol": 16, "extra": true})
            )),
            (200, json!({"version": "0.7.4", "protocol": 16}))
        );
    }

    #[test]
    fn does_not_hide_connection_or_malformed_response_failures() {
        assert_eq!(herdr_info(Err("Herdr is unavailable".into())).0, 503);
        assert_eq!(herdr_info(Ok(json!({"version": "", "protocol": 0}))).0, 503);
    }
}
