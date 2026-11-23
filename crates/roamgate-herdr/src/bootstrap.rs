//! Making the local Herdr server reachable (herdr/bootstrap): what is there
//! (running, installed, missing), and managed setup: the verified release
//! when no binary exists, then the user service, then waiting until the
//! socket answers.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use roamgate_base::clock::SharedClock;
use serde_json::{Number, Value};

use crate::BoxFuture;
use crate::protocol::assert_supported_herdr_protocol;
use crate::release::{VERIFIED_HERDR_VERSION, herdr_managed_binary_path};

/// Settings that make a Roamgate-managed Herdr impossible or ambiguous.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SetupGuard {
    pub ssh_host: Option<String>,
    pub session: Option<String>,
    pub has_explicit_socket_path: bool,
    pub has_explicit_client_socket_path: bool,
}

impl SetupGuard {
    /// The guard as the Bun front sends it (`herdr.setupGuard`).
    pub fn from_json(value: &Value) -> Self {
        let text = |name: &str| {
            value
                .get(name)
                .and_then(Value::as_str)
                .filter(|text| !text.is_empty())
                .map(str::to_owned)
        };
        let flag = |name: &str| value.get(name).and_then(Value::as_bool).unwrap_or(false);
        Self {
            ssh_host: text("sshHost"),
            session: text("session"),
            has_explicit_socket_path: flag("hasExplicitSocketPath"),
            has_explicit_client_socket_path: flag("hasExplicitClientSocketPath"),
        }
    }
}

pub fn assert_managed_setup_allowed(guard: &SetupGuard) -> Result<(), String> {
    if guard.ssh_host.is_some() {
        return Err(
            "managed Herdr setup is only available for the local Herdr server, not SSH connections"
                .into(),
        );
    }
    if guard.session.is_some() {
        return Err("managed Herdr setup only supports the default Herdr session; start `herdr server` yourself for a named session".into());
    }
    if guard.has_explicit_socket_path || guard.has_explicit_client_socket_path {
        return Err("managed Herdr setup only supports the default Herdr socket paths; start `herdr server` yourself with your custom paths".into());
    }
    Ok(())
}

/// Where binaries are looked for.
#[derive(Debug, Clone)]
pub struct Locations {
    pub platform: String,
    pub home: PathBuf,
    pub app_data: Option<PathBuf>,
    pub path_env: String,
}

/// The herdr binary: whatever PATH has first, else the install location
/// (~/.local/bin, or Roamgate's managed directory on Windows).
pub fn find_herdr_binary(locations: &Locations) -> Option<PathBuf> {
    let executable = if locations.platform == "win32" {
        "herdr.exe"
    } else {
        "herdr"
    };
    let delimiter = if cfg!(windows) { ';' } else { ':' };
    for directory in locations.path_env.split(delimiter) {
        if directory.is_empty() {
            continue;
        }
        let candidate = Path::new(directory).join(executable);
        if candidate.exists() {
            return Some(candidate);
        }
    }
    let managed = herdr_managed_binary_path(
        &locations.home,
        locations.app_data.as_deref(),
        &locations.platform,
        VERIFIED_HERDR_VERSION,
    );
    managed.exists().then_some(managed)
}

/// A ping of the control socket: Herdr's identity, or why not.
pub type Ping = Arc<dyn Fn() -> BoxFuture<Result<Value, String>> + Send + Sync>;

/// What is there.
#[derive(Debug, Clone, PartialEq)]
pub enum SetupState {
    Running { version: String, protocol: Number },
    Installed { binary_path: PathBuf },
    Missing,
}

fn identity(info: &Value) -> Option<(String, Number)> {
    let version = info.get("version")?.as_str()?.to_owned();
    let Value::Number(protocol) = info.get("protocol")? else {
        return None;
    };
    Some((version, protocol.clone()))
}

pub async fn detect_herdr_setup(ping: &Ping, locations: &Locations) -> SetupState {
    if let Ok(info) = ping().await
        && let Some((version, protocol)) = identity(&info)
    {
        return SetupState::Running { version, protocol };
    }
    match find_herdr_binary(locations) {
        Some(binary_path) => SetupState::Installed { binary_path },
        None => SetupState::Missing,
    }
}

/// What setup did.
#[derive(Debug, Clone, PartialEq)]
pub enum SetupOutcome {
    AlreadyRunning {
        version: String,
        protocol: Number,
    },
    Started {
        installed: bool,
        binary_path: PathBuf,
        version: String,
        protocol: Number,
    },
}

/// What setup works with.
pub struct Setup {
    pub guard: SetupGuard,
    pub locations: Locations,
    pub ping: Ping,
    /// Installs the verified release: the binary's path.
    pub install_release: Arc<dyn Fn() -> BoxFuture<Result<PathBuf, String>> + Send + Sync>,
    /// Installs and starts the service (blocking: run off the runtime).
    pub install_service: Arc<dyn Fn(String) -> Result<(), String> + Send + Sync>,
    pub start_timeout: Duration,
    pub poll_interval: Duration,
    pub clock: SharedClock,
    /// Waits between pings (the clock's sleep).
    pub sleep: Arc<dyn Fn(Duration) -> BoxFuture<()> + Send + Sync>,
}

/// Makes the local Herdr server reachable.
pub async fn setup_herdr(setup: &Setup) -> Result<SetupOutcome, String> {
    assert_managed_setup_allowed(&setup.guard)?;
    let state = detect_herdr_setup(&setup.ping, &setup.locations).await;
    let (binary_path, installed) = match state {
        SetupState::Running { version, protocol } => {
            return Ok(SetupOutcome::AlreadyRunning { version, protocol });
        }
        SetupState::Installed { binary_path } => (binary_path, false),
        SetupState::Missing => ((setup.install_release)().await?, true),
    };
    let install_service = setup.install_service.clone();
    let path = binary_path.display().to_string();
    tokio::task::spawn_blocking(move || install_service(path))
        .await
        .map_err(|error| error.to_string())??;
    let timeout_ms = setup.start_timeout.as_millis() as i64;
    let deadline = setup.clock.now() + timeout_ms;
    let mut last_error: Option<String>;
    loop {
        let answer = match (setup.ping)().await {
            Ok(info) => {
                assert_supported_herdr_protocol(info.get("protocol").unwrap_or(&Value::Null))
                    .and_then(|()| {
                        identity(&info)
                            .ok_or_else(|| "Herdr returned invalid server information".to_owned())
                    })
            }
            Err(error) => Err(error),
        };
        match answer {
            Ok((version, protocol)) => {
                return Ok(SetupOutcome::Started {
                    installed,
                    binary_path,
                    version,
                    protocol,
                });
            }
            Err(error) => {
                last_error = Some(error);
                if setup.clock.now() >= deadline {
                    break;
                }
                (setup.sleep)(setup.poll_interval).await;
            }
        }
    }
    Err(format!(
        "Herdr service was installed but the server did not become reachable within {}s: {}",
        (timeout_ms as f64 / 1000.0).round() as i64,
        last_error.unwrap_or_else(|| "timeout".into())
    ))
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;
    use std::sync::atomic::{AtomicUsize, Ordering};

    use roamgate_base::clock::SystemClock;
    use serde_json::json;

    use super::*;

    fn reachable() -> Ping {
        Arc::new(|| {
            Box::pin(async { Ok(json!({"version": VERIFIED_HERDR_VERSION, "protocol": 22})) })
        })
    }

    fn failing() -> Ping {
        Arc::new(|| Box::pin(async { Err("ENOENT: no socket".to_owned()) }))
    }

    /// Fails the first time, answers after.
    fn second_time() -> Ping {
        let pings = Arc::new(AtomicUsize::new(0));
        Arc::new(move || {
            let pings = pings.clone();
            Box::pin(async move {
                if pings.fetch_add(1, Ordering::SeqCst) < 1 {
                    Err("ENOENT: no socket".to_owned())
                } else {
                    Ok(json!({"version": VERIFIED_HERDR_VERSION, "protocol": 22}))
                }
            })
        })
    }

    fn locations(platform: &str, home: &Path, path_env: &str) -> Locations {
        Locations {
            platform: platform.into(),
            home: home.into(),
            app_data: None,
            path_env: path_env.into(),
        }
    }

    struct Calls {
        releases: Arc<AtomicUsize>,
        serviced: Arc<Mutex<Vec<String>>>,
    }

    fn setup(ping: Ping, locations: Locations, release: PathBuf) -> (Setup, Calls) {
        let releases = Arc::new(AtomicUsize::new(0));
        let serviced = Arc::new(Mutex::new(Vec::new()));
        let counted = releases.clone();
        let recorded = serviced.clone();
        (
            Setup {
                guard: SetupGuard::default(),
                locations,
                ping,
                install_release: Arc::new(move || {
                    counted.fetch_add(1, Ordering::SeqCst);
                    let release = release.clone();
                    Box::pin(async move { Ok(release) })
                }),
                install_service: Arc::new(move |path| {
                    recorded.lock().unwrap().push(path);
                    Ok(())
                }),
                start_timeout: Duration::from_secs(15),
                poll_interval: Duration::from_millis(250),
                clock: Arc::new(SystemClock),
                sleep: Arc::new(|_| Box::pin(async {})),
            },
            Calls { releases, serviced },
        )
    }

    #[test]
    fn rejects_non_local_or_customized_herdr_targets() {
        let error = |guard: SetupGuard| assert_managed_setup_allowed(&guard).unwrap_err();
        assert!(
            error(SetupGuard {
                ssh_host: Some("box".into()),
                ..Default::default()
            })
            .contains("only available for the local Herdr server")
        );
        assert!(
            error(SetupGuard {
                session: Some("work".into()),
                ..Default::default()
            })
            .contains("default Herdr session")
        );
        assert!(
            error(SetupGuard {
                has_explicit_socket_path: true,
                ..Default::default()
            })
            .contains("default Herdr socket paths")
        );
        assert!(
            error(SetupGuard {
                has_explicit_client_socket_path: true,
                ..Default::default()
            })
            .contains("default Herdr socket paths")
        );
        assert_eq!(assert_managed_setup_allowed(&SetupGuard::default()), Ok(()));
    }

    #[test]
    fn prefers_whatever_is_on_path() {
        let home = tempfile::tempdir().unwrap();
        let official =
            herdr_managed_binary_path(home.path(), None, "linux", VERIFIED_HERDR_VERSION);
        std::fs::create_dir_all(official.parent().unwrap()).unwrap();
        std::fs::write(&official, "official").unwrap();
        let path_dir = tempfile::tempdir().unwrap();
        std::fs::write(path_dir.path().join("herdr"), "path").unwrap();
        assert_eq!(
            find_herdr_binary(&locations(
                "linux",
                home.path(),
                path_dir.path().to_str().unwrap()
            )),
            Some(path_dir.path().join("herdr"))
        );
    }

    #[test]
    fn falls_back_to_the_official_installer_location() {
        let home = tempfile::tempdir().unwrap();
        let local_bin = home.path().join(".local").join("bin");
        std::fs::create_dir_all(&local_bin).unwrap();
        std::fs::write(local_bin.join("herdr"), "local").unwrap();
        assert_eq!(
            find_herdr_binary(&locations("linux", home.path(), "")),
            Some(local_bin.join("herdr"))
        );
    }

    #[test]
    fn returns_null_when_no_herdr_binary_exists() {
        let home = tempfile::tempdir().unwrap();
        assert_eq!(
            find_herdr_binary(&locations("linux", home.path(), "")),
            None
        );
    }

    #[test]
    fn looks_for_herdr_exe_on_windows_including_the_managed_directory() {
        let home = tempfile::tempdir().unwrap();
        let path_dir = tempfile::tempdir().unwrap();
        std::fs::write(path_dir.path().join("herdr.exe"), "exe").unwrap();
        assert_eq!(
            find_herdr_binary(&locations(
                "win32",
                home.path(),
                path_dir.path().to_str().unwrap()
            )),
            Some(path_dir.path().join("herdr.exe"))
        );
        let managed_home = tempfile::tempdir().unwrap();
        let managed =
            herdr_managed_binary_path(managed_home.path(), None, "win32", VERIFIED_HERDR_VERSION);
        std::fs::create_dir_all(managed.parent().unwrap()).unwrap();
        std::fs::write(&managed, "managed").unwrap();
        assert_eq!(
            find_herdr_binary(&locations("win32", managed_home.path(), "")),
            Some(managed)
        );
    }

    #[tokio::test]
    async fn reports_a_reachable_server_as_running() {
        let home = tempfile::tempdir().unwrap();
        assert_eq!(
            detect_herdr_setup(&reachable(), &locations("linux", home.path(), "")).await,
            SetupState::Running {
                version: VERIFIED_HERDR_VERSION.into(),
                protocol: 22.into()
            }
        );
    }

    #[tokio::test]
    async fn distinguishes_installed_but_down_from_missing() {
        let home = tempfile::tempdir().unwrap();
        let path_dir = tempfile::tempdir().unwrap();
        std::fs::write(path_dir.path().join("herdr"), "path").unwrap();
        assert_eq!(
            detect_herdr_setup(
                &failing(),
                &locations("linux", home.path(), path_dir.path().to_str().unwrap())
            )
            .await,
            SetupState::Installed {
                binary_path: path_dir.path().join("herdr")
            }
        );
        let empty = tempfile::tempdir().unwrap();
        assert_eq!(
            detect_herdr_setup(&failing(), &locations("linux", empty.path(), "")).await,
            SetupState::Missing
        );
    }

    #[tokio::test]
    async fn does_nothing_when_herdr_is_already_running() {
        let home = tempfile::tempdir().unwrap();
        let (setup, calls) = setup(
            reachable(),
            locations("linux", home.path(), ""),
            "/unused".into(),
        );
        assert!(matches!(
            setup_herdr(&setup).await,
            Ok(SetupOutcome::AlreadyRunning { .. })
        ));
        assert_eq!(calls.releases.load(Ordering::SeqCst), 0);
        assert!(calls.serviced.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn starts_an_installed_binary_as_a_service_without_downloading() {
        let home = tempfile::tempdir().unwrap();
        let path_dir = tempfile::tempdir().unwrap();
        let binary = path_dir.path().join("herdr");
        std::fs::write(&binary, "path").unwrap();
        let (setup, calls) = setup(
            second_time(),
            locations("linux", home.path(), path_dir.path().to_str().unwrap()),
            "/unused".into(),
        );
        assert_eq!(
            setup_herdr(&setup).await,
            Ok(SetupOutcome::Started {
                installed: false,
                binary_path: binary.clone(),
                version: VERIFIED_HERDR_VERSION.into(),
                protocol: 22.into()
            })
        );
        assert_eq!(
            *calls.serviced.lock().unwrap(),
            vec![binary.display().to_string()]
        );
        assert_eq!(calls.releases.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn installs_the_verified_release_when_no_binary_exists() {
        let home = tempfile::tempdir().unwrap();
        let managed = herdr_managed_binary_path(home.path(), None, "linux", VERIFIED_HERDR_VERSION);
        let (setup, calls) = setup(
            second_time(),
            locations("linux", home.path(), ""),
            managed.clone(),
        );
        assert!(matches!(
            setup_herdr(&setup).await,
            Ok(SetupOutcome::Started {
                installed: true,
                ..
            })
        ));
        assert_eq!(
            *calls.serviced.lock().unwrap(),
            vec![managed.display().to_string()]
        );
    }

    #[tokio::test]
    async fn fails_when_the_server_never_becomes_reachable() {
        let home = tempfile::tempdir().unwrap();
        let (mut setup, _) = setup(
            failing(),
            locations("linux", home.path(), ""),
            "/managed/herdr".into(),
        );
        setup.start_timeout = Duration::from_millis(1);
        let error = setup_herdr(&setup).await.unwrap_err();
        assert!(error.contains("did not become reachable"), "{error}");
    }

    #[tokio::test]
    async fn fails_fast_for_ssh_or_customized_setups() {
        let home = tempfile::tempdir().unwrap();
        let (mut setup, calls) = setup(failing(), locations("linux", home.path(), ""), "/x".into());
        setup.guard.ssh_host = Some("box".into());
        let error = setup_herdr(&setup).await.unwrap_err();
        assert!(
            error.contains("only available for the local Herdr server"),
            "{error}"
        );
        assert_eq!(calls.releases.load(Ordering::SeqCst), 0);
    }
}
