//! `roamgate herdr setup|status` (herdr/cli), with the Herdr settings of
//! the server's own flags and environment (config/server-config); the
//! work is roamgate-herdr's.

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use roamgate_base::clock::{SharedClock, SystemClock};
use roamgate_base::env::Env;
use roamgate_exec::process::ProcessRunner;
use roamgate_exec::service::{
    RunCommand, SystemCommands, node_arch, node_platform, resolve_service_platform,
};

use crate::output::Printed;
use crate::server_config::{ConfigRuntime, load_server_config};

/// The Herdr part of the server's configuration.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HerdrSettings {
    pub guard: SetupGuard,
    pub socket_path: String,
}

use roamgate_herdr::bootstrap::{
    Locations, Ping, Setup, SetupGuard, SetupOutcome, SetupState, detect_herdr_setup, setup_herdr,
};
use roamgate_herdr::client::ping;
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

    /// What loadServerConfig reads of the process.
    pub fn config_runtime(&self) -> ConfigRuntime {
        let tmp = if self.platform == "win32" {
            std::env::temp_dir()
        } else {
            self.env
                .var("TMPDIR")
                .filter(|dir| !dir.is_empty())
                .map(|dir| {
                    let trimmed = dir.trim_end_matches('/');
                    PathBuf::from(if trimmed.is_empty() { "/" } else { trimmed })
                })
                .unwrap_or_else(|| PathBuf::from("/tmp"))
        };
        ConfigRuntime {
            platform: self.platform.clone(),
            home: self.home.clone(),
            app_data: self.env.var("APPDATA").map(PathBuf::from),
            tmp,
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
        // loadServerConfig of the words after the action: it may end the
        // command (a bad flag, --help, an invalid setting) and creates the
        // generated login token when no password is set.
        let config = match load_server_config(
            &args[1..],
            self.env.as_ref(),
            &self.config_runtime(),
            &self.version,
        ) {
            Ok(config) => config,
            Err(exit) => return exit,
        };
        let settings = HerdrSettings {
            guard: SetupGuard {
                ssh_host: config.ssh_host,
                session: config.session,
                has_explicit_socket_path: config.has_explicit_socket_path,
                has_explicit_client_socket_path: config.has_explicit_client_socket_path,
            },
            socket_path: config.socket_path,
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

    use std::path::Path;

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
}
