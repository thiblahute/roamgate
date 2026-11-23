//! server/src/connections/ssh-profile-runtime.test.ts.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};

use super::*;

fn profile() -> SshConnectionProfile {
    SshConnectionProfile {
        id: "private-remote".into(),
        label: "Secret Host Label".into(),
        ssh_destination: "operator@dev-box".into(),
        remote_control_socket_path: "/remote/herdr.sock".into(),
        remote_client_socket_path: "/remote/herdr-client.sock".into(),
        auto_connect: false,
        remote_platform_windows: false,
        remote_herdr_path: None,
        remote_session: None,
    }
}

fn deps(environment: HashMap<String, String>) -> SshRuntimeConfigDeps {
    let mut deps = SshRuntimeConfigDeps::real(Arc::new(environment));
    deps.platform = "linux".into();
    deps
}

fn configure(
    profile: &SshConnectionProfile,
    deps: &SshRuntimeConfigDeps,
) -> (SshTunnelConfig, Cleanup) {
    let config = create_ssh_profile_runtime_config(profile, deps).unwrap();
    let directory = PathBuf::from(config.owned_runtime_directory.clone().unwrap());
    (config, Cleanup(directory))
}

struct Cleanup(PathBuf);

impl Drop for Cleanup {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

#[cfg(unix)]
#[test]
fn selects_windows_bridges_and_passes_the_explicit_binary_and_session() {
    let windows = SshConnectionProfile {
        remote_control_socket_path: String::new(),
        remote_client_socket_path: String::new(),
        remote_platform_windows: true,
        remote_herdr_path: Some("C:/Test Herdr/herdr.exe".into()),
        remote_session: Some("isolated-session".into()),
        ..profile()
    };
    let (config, _cleanup) = configure(&windows, &deps(HashMap::new()));
    assert_eq!(config.remote_platform, Some(RemotePlatform::Windows));
    assert_eq!(
        config.remote_herdr_path.as_deref(),
        Some(r"C:\Test Herdr\herdr.exe")
    );
    assert_eq!(config.session.as_deref(), Some("isolated-session"));
}

#[cfg(unix)]
#[test]
fn allocates_short_private_paths_without_profile_controlled_names() {
    use std::os::unix::fs::PermissionsExt;
    let (config, cleanup) = configure(&profile(), &deps(HashMap::new()));
    let directory = cleanup.0.to_string_lossy().into_owned();
    let metadata = std::fs::symlink_metadata(&cleanup.0).unwrap();
    assert!(metadata.is_dir());
    assert_eq!(metadata.permissions().mode() & 0o777, 0o700);
    assert_eq!(config.socket_path, format!("{directory}/control.sock"));
    assert_eq!(
        config.client_socket_path,
        format!("{directory}/render.sock")
    );
    assert!(config.socket_path.len() < 100);
    assert_eq!(
        config.master_control_path.as_deref(),
        Some(format!("{directory}/m.ctl").as_str())
    );
    // The orphan sweep leaves directories of a live owner alone.
    assert_eq!(
        std::fs::read_to_string(cleanup.0.join("owner.pid")).unwrap(),
        format!("{}\n", std::process::id())
    );
    // OpenSSH binds "<path>.<16 chars>" first; macOS sun_path is 104 bytes.
    assert!(config.master_control_path.as_ref().unwrap().len() + 17 < 104);
    assert!(!directory.contains("private-remote"));
    assert!(!directory.contains("dev-box"));
    assert_eq!(config.ssh_host.as_deref(), Some("operator@dev-box"));
    assert_eq!(
        config.remote_socket_path.as_deref(),
        Some("/remote/herdr.sock")
    );
    assert_eq!(
        config.remote_client_socket_path.as_deref(),
        Some("/remote/herdr-client.sock")
    );
    assert!(config.has_explicit_socket_path);
    assert!(config.has_explicit_client_socket_path);
}

#[cfg(unix)]
#[test]
fn leaves_the_command_master_off_when_the_operator_disables_it() {
    let environment = HashMap::from([("ROAMGATE_DISABLE_SSH_MASTER".to_owned(), "1".to_owned())]);
    let (config, _cleanup) = configure(&profile(), &deps(environment));
    assert_eq!(config.master_control_path, None);
}

#[cfg(unix)]
#[test]
fn puts_the_herdr_relay_in_front_unless_the_operator_disables_it() {
    let (config, _cleanup) = configure(&profile(), &deps(HashMap::new()));
    assert!(config.herdr_relay);
    let environment = HashMap::from([("ROAMGATE_DISABLE_HERDR_RELAY".to_owned(), "1".to_owned())]);
    let (disabled, _cleanup) = configure(&profile(), &deps(environment));
    assert!(!disabled.herdr_relay);
}

#[cfg(unix)]
#[test]
fn maps_empty_profile_socket_paths_to_remote_home_inference() {
    let inferred = SshConnectionProfile {
        remote_control_socket_path: String::new(),
        remote_client_socket_path: String::new(),
        ..profile()
    };
    let (config, _cleanup) = configure(&inferred, &deps(HashMap::new()));
    assert_eq!(config.ssh_host.as_deref(), Some("operator@dev-box"));
    assert!(!config.has_explicit_socket_path);
    assert!(!config.has_explicit_client_socket_path);
    assert_eq!(config.remote_socket_path, None);
    assert_eq!(config.remote_client_socket_path, None);
}

#[test]
fn rejects_windows_before_allocating_a_unix_socket_directory() {
    let allocated = Arc::new(AtomicBool::new(false));
    let seen = allocated.clone();
    let mut deps = deps(HashMap::new());
    deps.platform = "win32".into();
    deps.create_directory = Arc::new(move || {
        seen.store(true, Ordering::SeqCst);
        Ok(PathBuf::from("unused"))
    });
    let error = create_ssh_profile_runtime_config(&profile(), &deps).unwrap_err();
    assert!(
        error.contains("cannot create a local Windows named pipe"),
        "{error}"
    );
    assert!(!allocated.load(Ordering::SeqCst));
}

#[test]
fn rejects_a_non_private_injected_runtime_directory() {
    let mut deps = deps(HashMap::new());
    deps.create_directory = Arc::new(|| Ok(PathBuf::from("/tmp/injected-runtime")));
    deps.chmod = Arc::new(|_, _| Ok(()));
    deps.stat = Arc::new(|_| {
        Ok(DirectoryStat {
            is_directory: true,
            mode: 0o40755,
        })
    });
    deps.remove_directory = Arc::new(|_| {});
    let error = create_ssh_profile_runtime_config(&profile(), &deps).unwrap_err();
    assert!(error.contains("private directory"), "{error}");
}
