//! `roamgate service` (config/service-manager.ts runServiceCommand, and the
//! service command of cli/index.ts): install, uninstall, status, restart and
//! reload of the per-user service on systemd, launchd and the Windows Task
//! Scheduler, the published herdr-gui service it may still manage, and the
//! internal `service run <env file>` the Windows task starts.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use roamgate_base::env::{Env, roamgate_env};
use roamgate_base::paths::dirname;
use roamgate_exec::service::{
    RunCommand, ServicePlatform, WindowsTaskQuery, argv, escape_systemd_exec_path,
    query_windows_task, register_windows_task, resolve_service_platform, restart_windows_task,
    wait_for_windows_task_stop, write_definition,
};

use crate::args::{Failure, wants_help};
use crate::auth_token::{load_or_create_auth_token, open_error};
use crate::context::CliContext;
use crate::index::{Outcome, command_help};
use crate::server_config::{browser_url_for, get_lan_ips, is_any_host};
use crate::service::{
    DEFAULT_SERVICE_ENV_FILE, GENERATED_MARKER, LAUNCHD_SERVICE_NOT_FOUND_EXIT_CODE,
    LEGACY_GENERATED_MARKER, SERVICE_LABEL, ServiceAccess, ServicePaths, ServiceRuntime, basename,
    managed_service_paths, parse_environment_entries, prepare_service_access,
    render_launchd_service, render_systemd_service, render_windows_task_definition,
    resolve_legacy_service_paths, resolve_service_paths, service_exists, stem,
};
use crate::service_context::with_login_token;

/// What runs a service command, beside the runtime.
pub struct ServiceCommand<'a> {
    pub runtime: &'a ServiceRuntime,
    pub run: &'a dyn RunCommand,
    /// The environment `service run` completes (ROAMGATE_RESTART_SUPERVISOR).
    pub env: &'a dyn Env,
    /// The executable is the standalone binary, not `bun src/index.ts`.
    pub standalone: bool,
    pub lan_ips: &'a dyn Fn() -> Vec<String>,
    /// Whether install checks the launchd listener's port before the
    /// bootstrap: only with the real commands (TS: the default runner).
    pub check_listener: bool,
}

/// What `service run` gives the server: the environment file's entries
/// and whether the restart supervisor must be turned on.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ServiceRunEnvironment {
    pub entries: BTreeMap<String, String>,
    /// Set ROAMGATE_RESTART_SUPERVISOR=1: neither the file nor the
    /// environment names a supervisor setting.
    pub supervisor: bool,
}

/// A service command's result.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ServiceOutcome {
    Code(i32),
    /// `service run`: the server starts with these variables applied.
    Continue(ServiceRunEnvironment),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Action {
    Install,
    Uninstall,
    Status,
    Restart,
    Reload,
}

enum Parsed {
    Help,
    Run(String),
    Action(Action, bool),
}

fn parse_service_command(tail: &[String]) -> Result<Parsed, String> {
    if tail.is_empty() || tail[0] == "help" || tail.iter().any(|arg| arg == "--help" || arg == "-h")
    {
        return Ok(Parsed::Help);
    }
    let action = tail[0].as_str();
    if action == "run" {
        return match tail {
            [_, path] if !path.is_empty() => Ok(Parsed::Run(path.clone())),
            _ => Err("internal service run requires one environment file".into()),
        };
    }
    let action = match action {
        "install" => Action::Install,
        "uninstall" => Action::Uninstall,
        "status" => Action::Status,
        "restart" => Action::Restart,
        "reload" => Action::Reload,
        other => return Err(format!("unknown service action: {other}")),
    };
    let options = &tail[1..];
    if let Some(unknown) = options.iter().find(|option| *option != "--force") {
        return Err(format!("unknown service option: {unknown}"));
    }
    let force = options.iter().any(|option| option == "--force");
    if force && action != Action::Install {
        return Err("--force is only valid with `service install`".into());
    }
    Ok(Parsed::Action(action, force))
}

/// The environment `service run <path>` gives the server
/// (loadServiceEnvironmentFile and the supervisor default).
pub fn service_run_environment(path: &str, env: &dyn Env) -> Result<ServiceRunEnvironment, String> {
    let contents =
        std::fs::read_to_string(path).map_err(|error| open_error(&error, Path::new(path)))?;
    let entries = parse_environment_entries(&contents, path)?;
    let named = roamgate_env(&entries, "RESTART_SUPERVISOR").is_some()
        || roamgate_env(env, "RESTART_SUPERVISOR").is_some();
    Ok(ServiceRunEnvironment {
        entries,
        supervisor: !named,
    })
}

fn task_name(paths: &ServicePaths) -> Result<&str, String> {
    paths
        .task_name
        .as_deref()
        .ok_or_else(|| "Windows service task name is missing".into())
}

fn launchd_uid(runtime: &ServiceRuntime) -> Result<u32, String> {
    runtime
        .uid
        .ok_or_else(|| "cannot determine the current user id for launchd".into())
}

fn text(path: &Path) -> String {
    path.display().to_string()
}

fn ensure_standalone_binary(command: &ServiceCommand) -> Result<String, String> {
    let executable = basename(&command.runtime.exec_path).to_lowercase();
    if !command.standalone || executable == "bun" || executable == "bun.exe" {
        return Err("service install requires the standalone roamgate binary".into());
    }
    Ok(text(&roamgate_base::paths::resolve(
        &command.runtime.exec_path,
    )))
}

fn assert_service_definition_writable(path: &Path, force: bool) -> Result<(), String> {
    if path.exists() {
        let existing = std::fs::read_to_string(path).map_err(|error| error.to_string())?;
        if !existing.contains(GENERATED_MARKER) && !force {
            return Err(format!(
                "{} was not generated by roamgate; rerun with --force to replace it",
                path.display()
            ));
        }
    }
    Ok(())
}

fn is_boundary(character: Option<char>) -> bool {
    character.is_none_or(|character| character.is_whitespace() || matches!(character, '"' | '\''))
}

fn command_contains_argument(command: &str, argument: &str) -> bool {
    if argument.is_empty() {
        return false;
    }
    let mut offset = 0;
    while let Some(found) = command[offset..].find(argument) {
        let index = offset + found;
        let before = command[..index].chars().next_back();
        let after = command[index + argument.len()..].chars().next();
        if is_boundary(before) && is_boundary(after) {
            return true;
        }
        offset = index + argument.len();
    }
    false
}

/// A generated unit's ExecStart to keep: a supervisor wrapper that still
/// launches this exact binary (stale or unrelated commands are replaced).
fn preserved_systemd_exec_start(definition: &Path, binary: &str) -> Option<String> {
    let contents = std::fs::read_to_string(definition).ok()?;
    if !contents.contains(GENERATED_MARKER) {
        return None;
    }
    let commands: Vec<&str> = contents
        .split('\n')
        .map(|line| line.strip_suffix('\r').unwrap_or(line))
        .filter_map(|line| line.strip_prefix("ExecStart="))
        .map(str::trim)
        .filter(|command| !command.is_empty())
        .collect();
    let [command] = commands.as_slice() else {
        return None;
    };
    let direct = [
        binary.to_owned(),
        escape_systemd_exec_path(binary),
        // The quoted form herdr-gui <= 0.2.20 wrote: migrated, not kept.
        format!(
            "\"{}\"",
            binary
                .replace('\\', "\\\\")
                .replace('"', "\\\"")
                .replace('%', "%%")
        ),
    ];
    if direct.iter().any(|form| form == command) {
        return None;
    }
    command_contains_argument(command, binary).then(|| (*command).to_owned())
}

fn ensure_environment_file(runtime: &ServiceRuntime, path: &Path) -> Result<bool, String> {
    let io = |error: std::io::Error| error.to_string();
    roamgate_base::private::create_dir_all_mode(&dirname(path)).map_err(io)?;
    let created = !path.exists();
    if created {
        runtime
            .data()
            .publish_data_file(path, DEFAULT_SERVICE_ENV_FILE.as_bytes(), 0o600)
            .map_err(io)?;
    }
    roamgate_base::private::set_mode(path, 0o600).map_err(io)?;
    Ok(created)
}

fn print_service_access(
    access: &ServiceAccess,
    token: Option<(&str, &Path)>,
    lan_ips: &dyn Fn() -> Vec<String>,
    log: &mut dyn FnMut(&str),
) {
    let url = |host: &str| browser_url_for(host, access.port, access.tls);
    let Some((token, token_path)) = token.filter(|_| !access.uses_fixed_password) else {
        log("Authentication: fixed password from the service config");
        log(&format!("Open: {}", url(&access.host)));
        return;
    };
    log(&format!("Login token: {token}"));
    log(&format!("Token file: {}", token_path.display()));
    log(&format!(
        "Open: {}",
        with_login_token(&url(&access.host), Some(token))
    ));
    if is_any_host(&access.host) {
        for ip in lan_ips() {
            log(&format!(
                "LAN: {}",
                with_login_token(&url(&ip), Some(token))
            ));
        }
    }
}

/// launchctl bootout can return before the old process releases its port:
/// wait up to 5 s for it when a job was loaded.
fn assert_launchd_listener_available(
    host: &str,
    port: u16,
    previous_job_loaded: bool,
) -> Result<(), String> {
    let deadline =
        Instant::now() + Duration::from_millis(if previous_job_loaded { 5_000 } else { 0 });
    loop {
        match std::net::TcpListener::bind((host, port)) {
            Ok(listener) => {
                drop(listener);
                return Ok(());
            }
            Err(error) if error.kind() == std::io::ErrorKind::AddrInUse => {
                if Instant::now() >= deadline {
                    return Err(format!(
                        "Cannot listen on {host}:{port}: the port is already in use. Stop the other process or set PORT to a free port in the preserved roamgate.env, then reinstall the service."
                    ));
                }
                std::thread::sleep(Duration::from_millis(100));
            }
            Err(error) => return Err(error.to_string()),
        }
    }
}

fn assert_no_legacy_service(
    platform: ServicePlatform,
    runtime: &ServiceRuntime,
    run: &dyn RunCommand,
) -> Result<(), String> {
    let legacy = resolve_legacy_service_paths(platform, &runtime.home, runtime.app_data.as_deref());
    if service_exists(platform, runtime, &legacy, run, "legacy")? {
        return Err(format!(
            "legacy service detected ({}); stop and uninstall it using the previous binary's service uninstall before activating Roamgate. For custom definitions, explicitly disable and archive them yourself. Preserve the legacy config and token. See docs/DEPLOYMENT.md#transition-from-herdr-studio--herdr-gui. --force does not bypass this check.",
            legacy.definition.display()
        ));
    }
    Ok(())
}

fn install_service(
    platform: ServicePlatform,
    command: &ServiceCommand,
    force: bool,
    log: &mut dyn FnMut(&str),
) -> Result<i32, String> {
    let runtime = command.runtime;
    let run = command.run;
    let binary = ensure_standalone_binary(command)?;
    if platform == ServicePlatform::Launchd {
        launchd_uid(runtime)?;
    }
    let paths = resolve_service_paths(platform, &runtime.home, runtime.app_data.as_deref());
    if platform == ServicePlatform::WindowsTask {
        let task = task_name(&paths)?;
        match query_windows_task(task, run) {
            WindowsTaskQuery::Error { code } => return Ok(code),
            WindowsTaskQuery::Exists { .. } if !paths.definition.exists() && !force => {
                return Err(format!(
                    "scheduled task {task} already exists; rerun with --force to replace it"
                ));
            }
            _ => {}
        }
    }
    assert_service_definition_writable(&paths.definition, force)?;
    let legacy = resolve_legacy_service_paths(platform, &runtime.home, runtime.app_data.as_deref());
    let data = runtime.data();
    let io = |error: std::io::Error| error.to_string();
    let existing = [&paths.config, &legacy.config]
        .into_iter()
        .find(|path| path.exists());
    if let Some(existing) = existing {
        data.assert_safe_data_path(existing).map_err(io)?;
    }
    // The effective configuration is validated before migrating files,
    // generating a token, rewriting a definition or stopping a job.
    let contents = match existing {
        Some(existing) => std::fs::read_to_string(existing).map_err(io)?,
        None => DEFAULT_SERVICE_ENV_FILE.to_owned(),
    };
    let access = prepare_service_access(
        &text(existing.unwrap_or(&paths.config)),
        &contents,
        platform,
        &text(&runtime.home),
    )?;
    data.migrate_data_file(&paths.config, &legacy.config, None)
        .map_err(io)?;
    let token_path = dirname(&paths.config).join("auth-token");
    data.migrate_data_file(
        &token_path,
        &dirname(&legacy.config).join("auth-token"),
        None,
    )
    .map_err(io)?;
    let environment_created = ensure_environment_file(runtime, &paths.config)?;
    let token = if access.uses_fixed_password {
        None
    } else {
        Some(load_or_create_auth_token(&data, &token_path)?)
    };
    if let Some(stdout_log) = &paths.stdout_log {
        std::fs::create_dir_all(dirname(stdout_log)).map_err(io)?;
    }
    let custom_exec_start = if platform == ServicePlatform::Systemd {
        preserved_systemd_exec_start(&paths.definition, &binary)
    } else {
        None
    };
    let definition = match platform {
        ServicePlatform::Systemd => {
            render_systemd_service(&binary, &text(&paths.config), custom_exec_start.as_deref())
        }
        ServicePlatform::Launchd => render_launchd_service(&binary, &paths),
        ServicePlatform::WindowsTask => render_windows_task_definition(&binary, &paths)?,
    };
    write_definition(&paths.definition, &definition).map_err(io)?;

    let code = match platform {
        ServicePlatform::Systemd => {
            let mut code = run.run(&argv(&["systemctl", "--user", "daemon-reload"]), false);
            if code == 0 {
                code = run.run(
                    &argv(&["systemctl", "--user", "enable", "roamgate.service"]),
                    false,
                );
            }
            if code == 0 {
                // `enable --now` does not restart an active service after its
                // definition changed: an explicit restart does.
                code = run.run(
                    &argv(&["systemctl", "--user", "restart", "roamgate.service"]),
                    false,
                );
            }
            code
        }
        ServicePlatform::Launchd => {
            let domain = format!("gui/{}", launchd_uid(runtime)?);
            let service = format!("{domain}/{SERVICE_LABEL}");
            let loaded = run.run(&argv(&["launchctl", "print", &service]), true) == 0;
            let mut code = if loaded {
                run.run(&argv(&["launchctl", "bootout", &service]), false)
            } else {
                0
            };
            if code == 0 {
                // Bootstrap registers the job before its child binds the port.
                if command.check_listener {
                    assert_launchd_listener_available(&access.host, access.port, loaded)?;
                }
                code = run.run(
                    &argv(&["launchctl", "bootstrap", &domain, &text(&paths.definition)]),
                    false,
                );
            }
            code
        }
        ServicePlatform::WindowsTask => {
            let mut code = register_windows_task(&text(&paths.definition), run);
            if code == 0 {
                code = restart_windows_task(task_name(&paths)?, run);
            }
            code
        }
    };
    if code == 0 {
        log(&format!(
            "Installed {} service: {}",
            platform.name(),
            paths.definition.display()
        ));
        log(&format!(
            "{} service config: {}",
            if environment_created {
                "Created"
            } else {
                "Preserved"
            },
            paths.config.display()
        ));
        if let Some(custom) = &custom_exec_start {
            log(&format!("Preserved custom ExecStart: {custom}"));
        }
        print_service_access(
            &access,
            token.as_deref().map(|token| (token, token_path.as_path())),
            command.lan_ips,
            log,
        );
    }
    Ok(code)
}

/// Puts a systemd definition moved aside back unless it was removed, even
/// when the command run meanwhile panics.
struct Backup {
    backup: PathBuf,
    definition: PathBuf,
}

impl Drop for Backup {
    fn drop(&mut self) {
        if self.backup.exists() {
            let _ = std::fs::rename(&self.backup, &self.definition);
        }
    }
}

fn remove_if_present(path: &Path) -> std::io::Result<()> {
    match std::fs::remove_file(path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        other => other,
    }
}

fn uninstall_service(
    platform: ServicePlatform,
    runtime: &ServiceRuntime,
    paths: &ServicePaths,
    run: &dyn RunCommand,
    log: &mut dyn FnMut(&str),
) -> Result<i32, String> {
    let io = |error: std::io::Error| error.to_string();
    let name = platform.name();
    let definition_exists = paths.definition.exists();
    let nothing = |log: &mut dyn FnMut(&str)| {
        log(&format!(
            "No managed {name} service found: {}",
            paths.definition.display()
        ));
        log(&format!(
            "Preserved service config: {}",
            paths.config.display()
        ));
        Ok(0)
    };
    if !definition_exists && platform != ServicePlatform::WindowsTask {
        return nothing(log);
    }
    if definition_exists {
        let contents = std::fs::read_to_string(&paths.definition).map_err(io)?;
        if ![GENERATED_MARKER, LEGACY_GENERATED_MARKER]
            .iter()
            .any(|marker| contents.contains(marker))
        {
            return Err(format!(
                "{} was not generated by roamgate and will not be removed",
                paths.definition.display()
            ));
        }
    }
    match platform {
        ServicePlatform::Systemd => {
            let stop = run.run(
                &argv(&[
                    "systemctl",
                    "--user",
                    "disable",
                    "--now",
                    &basename(&paths.definition),
                ]),
                false,
            );
            if stop != 0 {
                return Ok(stop);
            }
            let backup = PathBuf::from(format!(
                "{}.uninstall-{}",
                paths.definition.display(),
                std::process::id()
            ));
            if backup.exists() {
                return Err(format!(
                    "service backup already exists: {}",
                    backup.display()
                ));
            }
            std::fs::rename(&paths.definition, &backup).map_err(io)?;
            let guard = Backup {
                backup,
                definition: paths.definition.clone(),
            };
            let code = run.run(&argv(&["systemctl", "--user", "daemon-reload"]), false);
            if code != 0 {
                return Ok(code);
            }
            std::fs::remove_file(&guard.backup).map_err(io)?;
        }
        ServicePlatform::Launchd => {
            let uid = launchd_uid(runtime)?;
            let service = format!("gui/{uid}/{}", stem(&paths.definition, ".plist"));
            let query = run.run(&argv(&["launchctl", "print", &service]), true);
            if query != 0 && query != LAUNCHD_SERVICE_NOT_FOUND_EXIT_CODE {
                return Ok(query);
            }
            if query == 0 {
                let stop = run.run(&argv(&["launchctl", "bootout", &service]), false);
                if stop != 0 {
                    return Ok(stop);
                }
            }
            remove_if_present(&paths.definition).map_err(io)?;
        }
        ServicePlatform::WindowsTask => {
            let task = task_name(paths)?;
            let task_exists = match query_windows_task(task, run) {
                WindowsTaskQuery::Error { code } => return Ok(code),
                WindowsTaskQuery::Exists { .. } => true,
                WindowsTaskQuery::Missing => false,
            };
            if !definition_exists && !task_exists {
                return nothing(log);
            }
            if task_exists {
                run.run(&argv(&["schtasks.exe", "/End", "/TN", task]), true);
                let wait = wait_for_windows_task_stop(task, run);
                if wait != 0 {
                    return Ok(wait);
                }
                let delete = run.run(
                    &argv(&["schtasks.exe", "/Delete", "/TN", task, "/F"]),
                    false,
                );
                if delete != 0 {
                    match query_windows_task(task, run) {
                        WindowsTaskQuery::Error { code } => return Ok(code),
                        WindowsTaskQuery::Exists { .. } => return Ok(delete),
                        WindowsTaskQuery::Missing => {}
                    }
                }
            }
            remove_if_present(&paths.definition).map_err(io)?;
        }
    }
    log(&format!(
        "Removed {name} service: {}",
        paths.definition.display()
    ));
    log(&format!(
        "Preserved service config: {}",
        paths.config.display()
    ));
    Ok(0)
}

fn run_service_action(
    action: Action,
    platform: ServicePlatform,
    runtime: &ServiceRuntime,
    paths: &ServicePaths,
    run: &dyn RunCommand,
) -> Result<i32, String> {
    let name = stem(&paths.definition, ".plist");
    if action == Action::Reload {
        if !paths.definition.exists() {
            return Err(format!(
                "cannot reload missing {} service: {}",
                platform.name(),
                paths.definition.display()
            ));
        }
        return Ok(match platform {
            ServicePlatform::Systemd => {
                let reload = run.run(&argv(&["systemctl", "--user", "daemon-reload"]), false);
                if reload != 0 {
                    return Ok(reload);
                }
                run.run(&argv(&["systemctl", "--user", "restart", &name]), false)
            }
            ServicePlatform::WindowsTask => {
                let register = register_windows_task(&text(&paths.definition), run);
                if register == 0 {
                    restart_windows_task(task_name(paths)?, run)
                } else {
                    register
                }
            }
            ServicePlatform::Launchd => {
                let domain = format!("gui/{}", launchd_uid(runtime)?);
                let service = format!("{domain}/{name}");
                let query = run.run(&argv(&["launchctl", "print", &service]), true);
                if query != 0 && query != LAUNCHD_SERVICE_NOT_FOUND_EXIT_CODE {
                    return Ok(query);
                }
                if query == 0 {
                    let bootout = run.run(&argv(&["launchctl", "bootout", &service]), false);
                    if bootout != 0 {
                        return Ok(bootout);
                    }
                }
                run.run(
                    &argv(&["launchctl", "bootstrap", &domain, &text(&paths.definition)]),
                    false,
                )
            }
        });
    }
    let status = action == Action::Status;
    Ok(match platform {
        ServicePlatform::Systemd => run.run(
            &if status {
                argv(&["systemctl", "--user", "--no-pager", "status", &name])
            } else {
                argv(&["systemctl", "--user", "restart", &name])
            },
            false,
        ),
        ServicePlatform::WindowsTask => {
            let task = task_name(paths)?;
            if status {
                run.run(
                    &argv(&["schtasks.exe", "/Query", "/TN", task, "/V", "/FO", "LIST"]),
                    false,
                )
            } else {
                restart_windows_task(task, run)
            }
        }
        ServicePlatform::Launchd => {
            let service = format!("gui/{}/{name}", launchd_uid(runtime)?);
            run.run(
                &if status {
                    argv(&["launchctl", "print", &service])
                } else {
                    argv(&["launchctl", "kickstart", "-k", &service])
                },
                false,
            )
        }
    })
}

/// `roamgate service <tail>` (runServiceCommand without its leading
/// `service`): failures are `roamgate service: <reason>` with the usage
/// hint, exit 1.
pub fn run_service_command(
    tail: &[String],
    command: &ServiceCommand,
    log: &mut dyn FnMut(&str),
    error: &mut dyn FnMut(&str),
) -> ServiceOutcome {
    let result = (|| -> Result<ServiceOutcome, String> {
        let (action, force) = match parse_service_command(tail)? {
            Parsed::Help => {
                log(command_help("service"));
                return Ok(ServiceOutcome::Code(0));
            }
            Parsed::Run(path) => {
                return Ok(ServiceOutcome::Continue(service_run_environment(
                    &path,
                    command.env,
                )?));
            }
            Parsed::Action(action, force) => (action, force),
        };
        let runtime = command.runtime;
        let platform = resolve_service_platform(&runtime.platform)?;
        let code = if action == Action::Install {
            assert_no_legacy_service(platform, runtime, command.run)?;
            install_service(platform, command, force, log)?
        } else {
            let paths = managed_service_paths(platform, runtime, command.run, log)?;
            if action == Action::Uninstall {
                uninstall_service(platform, runtime, &paths, command.run, log)?
            } else {
                run_service_action(action, platform, runtime, &paths, command.run)?
            }
        };
        Ok(ServiceOutcome::Code(code))
    })();
    result.unwrap_or_else(|message| {
        error(&format!("roamgate service: {message}"));
        error("Run `roamgate service --help` for usage.");
        ServiceOutcome::Code(1)
    })
}

/// `roamgate service <args>` (the service command of cli/index.ts):
/// `logs` goes to the log viewer; `run` hands over to the server, which
/// applies [`service_run_environment`] of the same file.
pub async fn run(args: &[String], context: &CliContext) -> Result<Outcome, Failure> {
    if args.first().map(String::as_str) == Some("logs") && !wants_help(&args[1..]) {
        return crate::service_logs::run(&args[1..], context).map(Outcome::Code);
    }
    let runtime = context.service();
    let command = ServiceCommand {
        runtime: &runtime,
        run: context.run.as_ref(),
        env: context.runtime.env.as_ref(),
        standalone: context.runtime.standalone,
        lan_ips: &get_lan_ips,
        check_listener: context.console.is_live(),
    };
    Ok(
        match run_service_command(args, &command, &mut |line| context.log(line), &mut |line| {
            context.error(line)
        }) {
            ServiceOutcome::Code(code) => Outcome::Code(code),
            ServiceOutcome::Continue(_) => Outcome::ContinueToServer,
        },
    )
}

#[cfg(test)]
mod tests;
