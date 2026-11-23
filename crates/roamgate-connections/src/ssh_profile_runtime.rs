//! An SSH profile's runtime configuration
//! (server/src/connections/ssh-profile-runtime.ts): a private directory of
//! short local socket paths (never named after the profile), the owner
//! file the orphan sweep reads, and the tunnel's remote paths (empty
//! profile paths ask the tunnel to infer them under the remote home).

use std::path::{Path, PathBuf};
use std::sync::Arc;

use roamgate_base::env::{Env, roamgate_env};
use roamgate_exec::ssh::master::{SSH_RUNTIME_OWNER_FILE, ssh_runtime_directory_root};
use roamgate_exec::ssh::tunnel::{
    RemotePlatform, SshTunnelConfig, assert_ssh_tunnel_platform_supported,
};

use crate::profiles::SshConnectionProfile;

/// A directory's kind and mode, as the check reads it.
#[derive(Debug, Clone, Copy)]
pub struct DirectoryStat {
    pub is_directory: bool,
    pub mode: u32,
}

type PathMode = Arc<dyn Fn(&Path, u32) -> Result<(), String> + Send + Sync>;
type PathStat = Arc<dyn Fn(&Path) -> Result<DirectoryStat, String> + Send + Sync>;
type PathAction = Arc<dyn Fn(&Path) -> Result<(), String> + Send + Sync>;

/// What the configuration touches, replaceable in tests.
pub struct SshRuntimeConfigDeps {
    pub create_directory: Arc<dyn Fn() -> Result<PathBuf, String> + Send + Sync>,
    pub chmod: PathMode,
    pub stat: PathStat,
    pub remove_directory: Arc<dyn Fn(&Path) + Send + Sync>,
    pub write_owner: PathAction,
    /// Node's platform name (`linux`, `darwin`, `win32`).
    pub platform: String,
    pub environment: Arc<dyn Env>,
}

impl SshRuntimeConfigDeps {
    /// The real ones: a `roamgate-ssh-XXXXXX` directory under the runtime
    /// root (ROAMGATE_SSH_RUNTIME_DIR, else /tmp).
    pub fn real(environment: Arc<dyn Env>) -> Self {
        let root = ssh_runtime_directory_root(environment.as_ref());
        Self {
            create_directory: Arc::new(move || {
                tempfile::Builder::new()
                    .prefix("roamgate-ssh-")
                    .rand_bytes(6)
                    .tempdir_in(&root)
                    .map(tempfile::TempDir::keep)
                    .map_err(|error| error.to_string())
            }),
            chmod: Arc::new(|path, mode| {
                roamgate_base::private::set_mode(path, mode).map_err(|error| error.to_string())
            }),
            stat: Arc::new(|path| {
                let metadata = std::fs::metadata(path).map_err(|error| error.to_string())?;
                Ok(DirectoryStat {
                    is_directory: metadata.is_dir(),
                    mode: roamgate_base::private::mode_of(&metadata),
                })
            }),
            remove_directory: Arc::new(|path| {
                let _ = std::fs::remove_dir_all(path);
            }),
            write_owner: Arc::new(|directory| {
                let path = directory.join(SSH_RUNTIME_OWNER_FILE);
                let mut options = std::fs::OpenOptions::new();
                options.write(true).create(true).truncate(true);
                #[cfg(unix)]
                std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
                let mut file = options.open(path).map_err(|error| error.to_string())?;
                std::io::Write::write_all(&mut file, format!("{}\n", std::process::id()).as_bytes())
                    .map_err(|error| error.to_string())
            }),
            platform: crate::profiles::current_platform().into(),
            environment,
        }
    }
}

pub fn create_ssh_profile_runtime_config(
    profile: &SshConnectionProfile,
    deps: &SshRuntimeConfigDeps,
) -> Result<SshTunnelConfig, String> {
    assert_ssh_tunnel_platform_supported(deps.platform == "win32")
        .map_err(|error| error.message)?;
    let directory = (deps.create_directory)()?;
    let configured = (|| -> Result<SshTunnelConfig, String> {
        (deps.chmod)(&directory, 0o700)?;
        let stat = (deps.stat)(&directory)?;
        let socket_path = directory.join("control.sock");
        let client_socket_path = directory.join("render.sock");
        let master_control_path = directory.join("m.ctl");
        let length = |path: &Path| path.as_os_str().len();
        if !stat.is_directory
            || (deps.platform != "win32" && (stat.mode & 0o077) != 0)
            || length(&socket_path) > 100
            || length(&client_socket_path) > 100
            // The master first binds "<path>.<16 random chars>".
            || length(&master_control_path) + 17 > 100
        {
            return Err(
                "SSH runtime directory must be a private directory with short socket paths".into(),
            );
        }
        (deps.write_owner)(&directory)?;
        let text = |path: &Path| path.to_string_lossy().into_owned();
        let control = (!profile.remote_control_socket_path.is_empty())
            .then(|| profile.remote_control_socket_path.clone());
        let client = (!profile.remote_client_socket_path.is_empty())
            .then(|| profile.remote_client_socket_path.clone());
        let master_disabled =
            roamgate_env(deps.environment.as_ref(), "DISABLE_SSH_MASTER").as_deref() == Some("1");
        Ok(SshTunnelConfig {
            socket_path: text(&socket_path),
            client_socket_path: text(&client_socket_path),
            ssh_host: Some(profile.ssh_destination.clone()),
            session: profile.remote_session.clone(),
            has_explicit_socket_path: control.is_some(),
            has_explicit_client_socket_path: client.is_some(),
            remote_socket_path: control,
            remote_client_socket_path: client,
            owned_runtime_directory: Some(text(&directory)),
            remote_platform: profile
                .remote_platform_windows
                .then_some(RemotePlatform::Windows),
            remote_herdr_path: profile
                .remote_herdr_path
                .as_ref()
                .map(|path| path.replace('/', "\\")),
            master_control_path: (!master_disabled).then(|| text(&master_control_path)),
            herdr_relay: roamgate_env(deps.environment.as_ref(), "DISABLE_HERDR_RELAY").as_deref()
                != Some("1"),
        })
    })();
    if configured.is_err() {
        (deps.remove_directory)(&directory);
    }
    configured
}

#[cfg(test)]
mod tests;
