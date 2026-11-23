//! `roamgate herdr setup|status` (herdr/cli), with the Herdr settings of
//! the server's own flags and environment (config/server-config); the
//! work is roamgate-herdr's.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use roamgate_base::clock::{SharedClock, SystemClock};
use roamgate_base::env::{Env, roamgate_env};
use roamgate_exec::process::ProcessRunner;
use roamgate_exec::service::{
    RunCommand, SystemCommands, node_arch, node_platform, resolve_service_platform,
};
use sha2::{Digest, Sha256};

use crate::output::Printed;

use roamgate_herdr::bootstrap::{
    Locations, Ping, Setup, SetupGuard, SetupOutcome, SetupState, detect_herdr_setup, setup_herdr,
};
use roamgate_herdr::client::{native_socket_path, ping};
use roamgate_herdr::release::{
    InstallHerdr, VERIFIED_HERDR_VERSION, default_download, install_verified_herdr,
};
use roamgate_herdr::service::{
    HerdrServiceDeps, current_uid, herdr_service_status, install_herdr_service,
};

/// `roamgate herdr --help`.
pub fn herdr_help() -> String {
    format!(
        "Install and start the local Herdr server.

Usage:
  roamgate herdr setup
  roamgate herdr status

Setup installs the Roamgate-verified Herdr {VERIFIED_HERDR_VERSION} release
when no herdr binary is found, then installs and starts a user service running
`herdr server` (systemd user service on Linux, launchd LaunchAgent on macOS,
per-user Task Scheduler task on Windows). An existing herdr binary is used as
is and never replaced. Status prints the detected state.
"
    )
}

/// `roamgate --help`'s server part (help/server.txt is what it prints).
const SERVER_OPTIONS_PRINTED: &str = include_str!("../../../contract/cli/help/server.txt");

/// The server flags `parseArgs` knows: name, whether it takes a value.
const SERVER_FLAGS: &[(&str, bool, Option<char>)] = &[
    ("host", true, None),
    ("port", true, None),
    ("password", true, None),
    ("tls-cert", true, None),
    ("tls-key", true, None),
    ("socket-path", true, None),
    ("client-socket-path", true, None),
    ("ssh-host", true, None),
    ("session", true, None),
    ("public-dir", true, None),
    ("log-level", true, None),
    ("notification-source", true, None),
    ("profile", false, None),
    ("profile-duration", true, None),
    ("profile-dir", true, None),
    ("open", false, None),
    ("help", false, Some('h')),
    ("version", false, Some('V')),
];

/// The server flags given, strictly as `parseArgs` reads them (no
/// positionals): values by name, or Bun's message.
fn parse_server_flags(args: &[String]) -> Result<Vec<(String, Option<String>)>, String> {
    let mut values = Vec::new();
    let mut index = 0;
    while index < args.len() {
        let arg = &args[index];
        index += 1;
        if arg == "--" {
            if let Some(next) = args.get(index) {
                return Err(format!(
                    "Unexpected argument '{next}'. This command does not take positional arguments"
                ));
            }
            break;
        }
        let (name, inline) = if let Some(long) = arg.strip_prefix("--") {
            match long.split_once('=') {
                Some((name, value)) => (name.to_owned(), Some(value.to_owned())),
                None => (long.to_owned(), None),
            }
        } else if let Some(short) = arg.strip_prefix('-').filter(|short| !short.is_empty()) {
            let letter = short.chars().next().unwrap();
            match SERVER_FLAGS
                .iter()
                .find(|(_, _, flag)| *flag == Some(letter))
            {
                Some((name, _, _)) if short.len() == 1 => ((*name).to_owned(), None),
                _ => return Err(format!("Unknown option '-{letter}'")),
            }
        } else {
            return Err(format!(
                "Unexpected argument '{arg}'. This command does not take positional arguments"
            ));
        };
        let Some((_, takes_value, _)) = SERVER_FLAGS.iter().find(|(flag, _, _)| *flag == name)
        else {
            return Err(format!("Unknown option '--{name}'"));
        };
        if *takes_value {
            let value = match inline {
                Some(value) => value,
                None => match args.get(index) {
                    None => return Err(format!("Option '--{name} <value>' argument missing")),
                    Some(next) if next.starts_with('-') => {
                        return Err(format!(
                            "Option '--{name}' argument is ambiguous.\nDid you forget to specify the option argument for '--{name}'?\nTo specify an option argument starting with a dash use '--{name}=-XYZ'."
                        ));
                    }
                    Some(next) => {
                        index += 1;
                        next.clone()
                    }
                },
            };
            values.push((name, Some(value)));
        } else {
            if inline.is_some() {
                return Err(format!("Option '--{name}' does not take an argument"));
            }
            values.push((name, None));
        }
    }
    Ok(values)
}

/// The Herdr part of the server's configuration.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HerdrSettings {
    pub guard: SetupGuard,
    pub socket_path: String,
}

/// Herdr's configuration directory.
pub fn herdr_config_dir(platform: &str, app_data: Option<&Path>, home: &Path) -> PathBuf {
    if platform == "win32" {
        return app_data
            .map(Path::to_path_buf)
            .unwrap_or_else(|| home.join("AppData").join("Roaming"))
            .join("herdr");
    }
    home.join(".config").join("herdr")
}

/// The local end of an SSH connection's tunnelled socket.
fn remote_tunnel_local_path(host: &str, session: Option<&str>, kind: &str) -> String {
    let key = hex::encode(Sha256::digest(
        format!("{host}\0{}\0{kind}", session.unwrap_or("default")).as_bytes(),
    ));
    let tmp = std::env::temp_dir();
    tmp.join(format!("roamgate-{}-{kind}.sock", &key[..12]))
        .display()
        .to_string()
}

/// The Herdr settings `loadServerConfig` would resolve from these flags
/// and this environment, or the message it would exit 2 with.
pub fn herdr_settings(
    flags: &[(String, Option<String>)],
    env: &dyn Env,
    platform: &str,
    home: &Path,
) -> Result<HerdrSettings, String> {
    let flag = |name: &str| {
        flags
            .iter()
            .rev()
            .find(|(flag, _)| flag == name)
            .and_then(|(_, value)| value.clone())
    };
    let log_level = flag("log-level").or_else(|| roamgate_env(env, "LOG_LEVEL"));
    if let Some(level) = log_level
        && let Err(error) = roamgate_base::log::parse_log_level(&level)
    {
        return Err(error.to_string());
    }
    let nonempty = |value: Option<String>| value.filter(|value| !value.is_empty());
    let ssh_host = nonempty(flag("ssh-host")).or_else(|| nonempty(env.var("HERDR_SSH_HOST")));
    if let Some(host) = &ssh_host {
        roamgate_exec::ssh::command::validate_ssh_destination(host)
            .map_err(|error| error.to_string())?;
        if platform == "win32" {
            return Err("SSH connections from Windows are not supported because Roamgate's stream-local forwarding cannot create a local Windows named pipe".into());
        }
    }
    let session = nonempty(flag("session")).or_else(|| nonempty(env.var("HERDR_SESSION")));
    let socket_flag = flag("socket-path");
    let client_flag = flag("client-socket-path");
    let has_explicit_socket_path =
        socket_flag.is_some() || nonempty(env.var("HERDR_SOCKET_PATH")).is_some();
    let has_explicit_client_socket_path =
        client_flag.is_some() || nonempty(env.var("HERDR_CLIENT_SOCKET_PATH")).is_some();
    let explicit = nonempty(socket_flag.clone()).or_else(|| nonempty(env.var("HERDR_SOCKET_PATH")));
    let socket_path = if socket_flag.as_deref() == Some("") {
        native_socket_path("", platform)
    } else if let Some(explicit) = explicit {
        native_socket_path(&explicit, platform)
    } else if let Some(host) = &ssh_host {
        remote_tunnel_local_path(host, session.as_deref(), "control")
    } else {
        let base = herdr_config_dir(
            platform,
            env.var("APPDATA").map(PathBuf::from).as_deref(),
            home,
        );
        let path = match &session {
            Some(session) => base.join("sessions").join(session).join("herdr.sock"),
            None => base.join("herdr.sock"),
        };
        native_socket_path(&path.display().to_string(), platform)
    };
    Ok(HerdrSettings {
        guard: SetupGuard {
            ssh_host,
            session,
            has_explicit_socket_path,
            has_explicit_client_socket_path,
        },
        socket_path,
    })
}

/// What `roamgate herdr` works with (tests swap the effects).
pub struct HerdrCli {
    pub env: Arc<dyn Env>,
    pub version: String,
    pub platform: String,
    pub arch: String,
    pub home: PathBuf,
    pub clock: SharedClock,
    pub run: Arc<dyn RunCommand>,
}

impl HerdrCli {
    /// This process's.
    pub fn system(env: Arc<dyn Env>, version: String) -> Self {
        let home = if cfg!(windows) {
            env.var("USERPROFILE").or_else(|| env.var("HOME"))
        } else {
            env.var("HOME")
        }
        .map(PathBuf::from)
        .unwrap_or_default();
        Self {
            env,
            version,
            platform: node_platform().into(),
            arch: node_arch().into(),
            home,
            clock: Arc::new(SystemClock),
            run: Arc::new(SystemCommands),
        }
    }

    fn locations(&self) -> Locations {
        Locations {
            platform: self.platform.clone(),
            home: self.home.clone(),
            app_data: self.env.var("APPDATA").map(PathBuf::from),
            path_env: self.env.var("PATH").unwrap_or_default(),
        }
    }

    fn service_deps(&self) -> Result<HerdrServiceDeps<'_>, String> {
        Ok(HerdrServiceDeps {
            platform: resolve_service_platform(&self.platform)?,
            home: self.home.clone(),
            app_data: self.env.var("APPDATA").map(PathBuf::from),
            uid: current_uid(),
            run: self.run.as_ref(),
        })
    }

    /// `roamgate herdr <args>` (the words after `herdr`).
    pub async fn run(&self, args: &[String]) -> Printed {
        let mut printed = Printed::default();
        let action = args.first().map(String::as_str);
        if matches!(action, None | Some("help" | "--help" | "-h")) {
            printed.log(&herdr_help());
            return printed.exit(0);
        }
        let action = action.unwrap();
        if action != "setup" && action != "status" {
            printed.error(&format!("unknown herdr action: {action}"));
            printed.error("Run `roamgate herdr --help` for usage.");
            return printed.exit(1);
        }
        // What loadServerConfig does with the words after the action.
        let flags = match parse_server_flags(&args[1..]) {
            Ok(flags) => flags,
            Err(message) => {
                printed.error(&format!("[bridge] {message}"));
                printed.error("Run `roamgate --help` for usage.");
                return printed.exit(2);
            }
        };
        if flags.iter().any(|(name, _)| name == "help") {
            printed.stdout.push_str(
                "Roamgate \u{2014} Web and PWA client for Herdr\n\nUsage: roamgate [options]\n\n",
            );
            printed.stdout.push_str(SERVER_OPTIONS_PRINTED);
            return printed.exit(0);
        }
        if flags.iter().any(|(name, _)| name == "version") {
            printed.log(&format!("roamgate {}", self.version));
            return printed.exit(0);
        }
        let settings = match herdr_settings(&flags, self.env.as_ref(), &self.platform, &self.home) {
            Ok(settings) => settings,
            Err(message) => {
                printed.error(&format!("[bridge] {message}"));
                return printed.exit(2);
            }
        };
        match self.act(action, settings, &mut printed).await {
            Ok(()) => printed.exit(0),
            Err(message) => {
                printed.error(&format!("roamgate herdr: {message}"));
                printed.error("Run `roamgate herdr --help` for usage.");
                printed.exit(1)
            }
        }
    }

    async fn act(
        &self,
        action: &str,
        settings: HerdrSettings,
        printed: &mut Printed,
    ) -> Result<(), String> {
        let clock = self.clock.clone();
        let socket = settings.socket_path.clone();
        let ping_herdr: Ping = Arc::new(move || {
            let clock = clock.clone();
            let socket = socket.clone();
            Box::pin(async move { ping(&clock, &socket).await })
        });
        if action == "status" {
            match detect_herdr_setup(&ping_herdr, &self.locations()).await {
                SetupState::Running { version, protocol } => printed.log(&format!(
                    "Herdr is running (version {version}, protocol {protocol})."
                )),
                SetupState::Installed { binary_path } => {
                    printed.log(&format!(
                        "Herdr is installed but not running: {}",
                        binary_path.display()
                    ));
                    printed.log("Run `roamgate herdr setup` to start it as a user service.");
                }
                SetupState::Missing => {
                    printed.log("Herdr is not installed.");
                    printed.log(&format!(
                        "Run `roamgate herdr setup` to install the verified Herdr {VERIFIED_HERDR_VERSION} and start it."
                    ));
                }
            }
            let service = herdr_service_status(&self.service_deps()?);
            printed.log(&format!(
                "Managed service: {}",
                match (service.installed, service.active) {
                    (false, _) => "not installed",
                    (true, true) => "installed, active",
                    (true, false) => "installed, inactive",
                }
            ));
            return Ok(());
        }
        let outcome = setup_herdr(&self.setup(settings.guard, ping_herdr)).await?;
        match outcome {
            SetupOutcome::AlreadyRunning { version, protocol } => printed.log(&format!(
                "Herdr is already running (version {version}, protocol {protocol})."
            )),
            SetupOutcome::Started {
                installed,
                binary_path,
                version,
                ..
            } => {
                printed.log(&if installed {
                    format!("Installed Herdr {version} and started it as a user service.")
                } else {
                    format!("Started Herdr {version} as a user service.")
                });
                printed.log(&format!("Binary: {}", binary_path.display()));
            }
        }
        Ok(())
    }

    /// Setup on this process: the verified release, the user service, the
    /// clock's waits.
    pub fn setup(&self, guard: SetupGuard, ping: Ping) -> Setup {
        let locations = self.locations();
        let install = Arc::new(InstallHerdr {
            platform: self.platform.clone(),
            arch: self.arch.clone(),
            home: self.home.clone(),
            app_data: locations.app_data.clone(),
            download: default_download(ProcessRunner::new(self.clock.clone())),
            run: self.run.clone(),
            expected_sha256: None,
        });
        let platform = self.platform.clone();
        let home = self.home.clone();
        let app_data = locations.app_data.clone();
        let run = self.run.clone();
        let clock = self.clock.clone();
        Setup {
            guard,
            locations,
            ping,
            install_release: Arc::new(move || {
                let install = install.clone();
                Box::pin(async move {
                    install_verified_herdr(&install)
                        .await
                        .map(|installed| installed.binary_path)
                })
            }),
            install_service: Arc::new(move |binary| {
                install_herdr_service(
                    &binary,
                    &HerdrServiceDeps {
                        platform: resolve_service_platform(&platform)?,
                        home: home.clone(),
                        app_data: app_data.clone(),
                        uid: current_uid(),
                        run: run.as_ref(),
                    },
                )
                .map(|_| ())
            }),
            start_timeout: Duration::from_millis(15_000),
            poll_interval: Duration::from_millis(250),
            clock: self.clock.clone(),
            sleep: Arc::new(move |duration| clock.sleep(duration)),
        }
    }
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use roamgate_exec::service::fake::Recorder;

    use super::*;

    fn cli(env: HashMap<String, String>, home: &Path, run: Arc<dyn RunCommand>) -> HerdrCli {
        HerdrCli {
            env: Arc::new(env),
            version: "0.0.0".into(),
            platform: "linux".into(),
            arch: "x64".into(),
            home: home.into(),
            clock: Arc::new(SystemClock),
            run,
        }
    }

    fn args(list: &[&str]) -> Vec<String> {
        list.iter().map(|arg| (*arg).to_owned()).collect()
    }

    #[test]
    fn the_help_is_the_contract_s_golden() {
        let golden = include_str!("../../../contract/cli/help/herdr.txt");
        assert_eq!(format!("{}\n", herdr_help()), golden);
    }

    #[tokio::test]
    async fn prints_help_for_bare_or_unknown_herdr_commands() {
        let home = tempfile::tempdir().unwrap();
        let cli = cli(HashMap::new(), home.path(), Arc::new(Recorder::new(|_| 1)));
        let help = cli.run(&[]).await;
        assert_eq!(help.code, 0);
        assert!(help.stdout.contains("roamgate herdr setup"));
        let unknown = cli.run(&args(&["restart"])).await;
        assert_eq!(unknown.code, 1);
        assert!(unknown.stderr.contains("unknown herdr action"));
    }

    #[tokio::test]
    async fn status_points_missing_installs_at_setup() {
        let home = tempfile::tempdir().unwrap();
        let env = HashMap::from([
            ("PATH".to_owned(), String::new()),
            (
                "HERDR_SOCKET_PATH".to_owned(),
                home.path().join("none.sock").display().to_string(),
            ),
        ]);
        let cli = cli(env, home.path(), Arc::new(Recorder::new(|_| 3)));
        let printed = cli.run(&args(&["status"])).await;
        assert_eq!(printed.code, 0);
        assert_eq!(
            printed.stdout,
            format!(
                "Herdr is not installed.\nRun `roamgate herdr setup` to install the verified Herdr {VERIFIED_HERDR_VERSION} and start it.\nManaged service: not installed\n"
            )
        );
    }

    #[tokio::test]
    async fn setup_refuses_custom_sockets_and_bad_flags() {
        let home = tempfile::tempdir().unwrap();
        let env = HashMap::from([("HERDR_SOCKET_PATH".to_owned(), "/x.sock".to_owned())]);
        let cli = cli(env, home.path(), Arc::new(Recorder::new(|_| 0)));
        let printed = cli.run(&args(&["setup"])).await;
        assert_eq!(printed.code, 1);
        assert!(printed.stderr.starts_with(
            "roamgate herdr: managed Herdr setup only supports the default Herdr socket paths"
        ));
        let bad = cli.run(&args(&["status", "--nope"])).await;
        assert_eq!(
            bad,
            Printed {
                code: 2,
                stdout: String::new(),
                stderr: "[bridge] Unknown option '--nope'\nRun `roamgate --help` for usage.\n"
                    .into()
            }
        );
        let version = cli.run(&args(&["status", "-V"])).await;
        assert_eq!(version.stdout, "roamgate 0.0.0\n");
    }

    #[test]
    fn resolves_herdr_sockets_like_the_server() {
        let home = Path::new("/home/me");
        let none: HashMap<String, String> = HashMap::new();
        let settings = herdr_settings(&[], &none, "linux", home).unwrap();
        assert_eq!(settings.socket_path, "/home/me/.config/herdr/herdr.sock");
        assert_eq!(settings.guard, SetupGuard::default());
        let session = herdr_settings(
            &[("session".into(), Some("work".into()))],
            &none,
            "linux",
            home,
        )
        .unwrap();
        assert_eq!(
            session.socket_path,
            "/home/me/.config/herdr/sessions/work/herdr.sock"
        );
        let flagged = herdr_settings(
            &[("socket-path".into(), Some("/run/h.sock".into()))],
            &none,
            "linux",
            home,
        )
        .unwrap();
        assert_eq!(flagged.socket_path, "/run/h.sock");
        assert!(flagged.guard.has_explicit_socket_path);
        let ssh = herdr_settings(
            &[("ssh-host".into(), Some("box".into()))],
            &none,
            "linux",
            home,
        )
        .unwrap();
        assert!(
            ssh.socket_path.ends_with("-control.sock"),
            "{}",
            ssh.socket_path
        );
        assert!(
            herdr_settings(
                &[("ssh-host".into(), Some("-bad".into()))],
                &none,
                "linux",
                home
            )
            .is_err()
        );
        assert_eq!(
            parse_server_flags(&args(&["--open=1"])),
            Err("Option '--open' does not take an argument".into())
        );
        assert_eq!(
            parse_server_flags(&args(&["x"])),
            Err("Unexpected argument 'x'. This command does not take positional arguments".into())
        );
        assert_eq!(
            parse_server_flags(&args(&["--socket-path"])),
            Err("Option '--socket-path <value>' argument missing".into())
        );
    }
}
