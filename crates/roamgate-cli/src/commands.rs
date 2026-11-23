//! `roamgate update [--check] [--json]` and `roamgate rollback`
//! (cli/update), with the CLI's error conventions (cli/index runCli): a
//! failure is `roamgate <command>: <reason>` and exit 1, a usage error adds
//! `Run \`roamgate <command> --help\` for usage.` and exits 2.

use std::cmp::Ordering;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use roamgate_base::env::{Env, roamgate_env};
use roamgate_exec::service::{RunCommand, escape_systemd_exec_path, xml_escape};

use crate::output::Printed;
use crate::service::{
    ServiceRuntime, read_service_environment, restart_service, roamgate_service_status,
};
use crate::update::{
    RunProcess, UPDATE_INSTALL_TIMEOUT, compare_version, curl_transport_command,
    fetch_latest_update_manifest, normalize_update_base_url, render_update_install_script,
    resolve_update_target, run_failure,
};

pub fn update_help() -> &'static str {
    "Update the standalone roamgate executable to the latest release.

Usage:
  roamgate update [--check] [--json]

Options:
  --check   only report whether a newer release exists
  --json    print machine-readable output (with --check)

The release manifest, archive checksum, package VERSION and binary version are
verified before the executable is replaced in place. The previous executable is
kept as roamgate.previous; `roamgate rollback` restores it. A running managed
service that uses this executable is restarted afterwards.

ROAMGATE_UPDATE_BASE_URL selects a mirror (from the shell, else the service
config). To install a specific version, rerun the installer with
ROAMGATE_VERSION=X.Y.Z. Windows builds update by downloading a release.
"
}

pub fn rollback_help() -> &'static str {
    "Swap the roamgate executable with roamgate.previous.

Usage:
  roamgate rollback

The update command and installer keep the replaced executable as
roamgate.previous. Rollback swaps the two files, so running it again undoes the
rollback. A running managed service that uses this executable is restarted.
"
}

/// The executable the user ran, and where.
#[derive(Clone)]
pub struct CliRuntime {
    pub platform: String,
    pub arch: String,
    pub home: PathBuf,
    pub app_data: Option<PathBuf>,
    /// The executable update and rollback replace.
    pub exec_path: PathBuf,
    /// Its version.
    pub version: String,
    /// The standalone binary, not `bun src/index.ts`.
    pub standalone: bool,
    pub uid: Option<u32>,
    pub env: Arc<dyn Env>,
}

impl CliRuntime {
    /// The private data directory of this user.
    pub fn data_root(&self) -> PathBuf {
        self.service().data().data_root()
    }

    pub(crate) fn service(&self) -> ServiceRuntime {
        ServiceRuntime {
            platform: self.platform.clone(),
            home: self.home.clone(),
            app_data: self.app_data.clone(),
            exec_path: self.exec_path.clone(),
            uid: self.uid,
        }
    }
}

/// The effects the commands use.
#[derive(Clone)]
pub struct Effects {
    pub run_process: RunProcess,
    pub run: Arc<dyn RunCommand>,
}

pub(crate) use crate::args::{Failure, finish, parse_flags, wants_help};

/// Restarts the managed service only when its definition runs
/// `executable`.
fn restart_service_using(
    runtime: &CliRuntime,
    effects: &Effects,
    executable: &Path,
    printed: &mut Printed,
) -> Result<i32, Failure> {
    let service = runtime.service();
    let Ok(status) = roamgate_service_status(&service, effects.run.as_ref()) else {
        return Ok(0);
    };
    if !status.installed || !status.active {
        printed.log("Restart any running roamgate process to use the new version.");
        return Ok(0);
    }
    let definition = std::fs::read_to_string(&status.definition)
        .map_err(|error| Failure::Failed(error.to_string()))?;
    let executable = executable.display().to_string();
    let forms = [
        executable.clone(),
        escape_systemd_exec_path(&executable),
        xml_escape(&executable),
    ];
    if !forms.iter().any(|form| definition.contains(form.as_str())) {
        printed.log(&format!(
            "The managed service runs a different executable ({}); it was not restarted.",
            status.definition.display()
        ));
        return Ok(0);
    }
    // restartRunningService: again, then `service restart`.
    let Ok(again) = roamgate_service_status(&service, effects.run.as_ref()) else {
        return Ok(0);
    };
    if !again.installed || !again.active {
        return Ok(0);
    }
    let (mut out, mut err) = (Vec::new(), Vec::new());
    let code = restart_service(
        &service,
        effects.run.as_ref(),
        &mut |line| out.push(line.to_owned()),
        &mut |line| err.push(line.to_owned()),
    );
    for line in out {
        printed.log(&line);
    }
    for line in err {
        printed.error(&line);
    }
    if code == 0 {
        printed.log("Restarted the service.");
    }
    Ok(code)
}

/// `roamgate update <args>`.
pub async fn update(runtime: &CliRuntime, effects: &Effects, args: &[String]) -> Printed {
    let mut printed = Printed::default();
    if wants_help(args) {
        printed.log(update_help());
        return printed.exit(0);
    }
    let result = update_inner(runtime, effects, args, &mut printed).await;
    finish("update", printed, result)
}

async fn update_inner(
    runtime: &CliRuntime,
    effects: &Effects,
    args: &[String],
    printed: &mut Printed,
) -> Result<i32, Failure> {
    let flags = parse_flags(args, &["check", "json"])?;
    let check = flags.iter().any(|flag| flag == "check");
    let json = flags.iter().any(|flag| flag == "json");
    let Some(target) = resolve_update_target(&runtime.platform, &runtime.arch) else {
        printed.error(&format!(
            "roamgate update: no update package for {}-{}; download it from https://github.com/powerfooI/roamgate/releases/latest",
            runtime.platform, runtime.arch
        ));
        return Ok(1);
    };
    let base = roamgate_env(runtime.env.as_ref(), "UPDATE_BASE_URL").or_else(|| {
        read_service_environment(&runtime.service())
            .ok()
            .and_then(|env| {
                env.get("ROAMGATE_UPDATE_BASE_URL")
                    .or_else(|| env.get("HERDR_GUI_UPDATE_BASE_URL"))
                    .cloned()
            })
    });
    let base = normalize_update_base_url(base.as_deref()).map_err(Failure::Failed)?;
    let manifest = fetch_latest_update_manifest(&base, &target, &effects.run_process)
        .await
        .map_err(Failure::Failed)?;
    let available = compare_version(&manifest.version, &runtime.version)
        .map_err(Failure::Failed)?
        == Ordering::Greater;
    if check {
        if json {
            let body = serde_json::json!({
                "current_version": runtime.version,
                "latest_version": manifest.version,
                "update_available": available,
                "platform": target.platform,
            });
            let text = roamgate_base::json_store::to_js_json(
                &body,
                roamgate_base::json_store::JsonFormat::Pretty,
            )
            .unwrap_or_default();
            printed.log(text.trim_end_matches('\n'));
        } else {
            printed.log(&format!("Current: roamgate {}", runtime.version));
            printed.log(&format!("Latest:  roamgate {}", manifest.version));
            printed.log(if available {
                "An update is available: run `roamgate update`."
            } else {
                "Up to date."
            });
        }
        return Ok(0);
    }
    if !available {
        printed.log(&format!("roamgate {} is up to date.", runtime.version));
        return Ok(0);
    }
    if !runtime.standalone {
        printed.error("roamgate update: only the standalone binary can update itself; pull and rebuild source checkouts.");
        return Ok(1);
    }
    printed.log(&format!(
        "Updating roamgate {} -> {}...",
        runtime.version, manifest.version
    ));
    let target_path = runtime.exec_path.display().to_string();
    let script = render_update_install_script(
        &target_path,
        &target,
        &manifest,
        &format!("{base}/{}", target.archive_name),
        &curl_transport_command(&base),
    );
    let ran = (effects.run_process)(
        vec!["sh".into(), "-c".into(), script],
        UPDATE_INSTALL_TIMEOUT,
    )
    .await
    .map_err(Failure::Failed)?;
    if ran.code != 0 {
        printed.error(&format!(
            "roamgate update: {}",
            run_failure(&ran, "install", 1000)
        ));
        return Ok(1);
    }
    printed.log(&format!(
        "Installed roamgate {} at {target_path}.",
        manifest.version
    ));
    printed.log(&format!("Previous executable: {target_path}.previous"));
    restart_service_using(runtime, effects, &runtime.exec_path, printed)
}

/// A regular file, not a symlink.
fn regular_file(path: &Path) -> bool {
    std::fs::symlink_metadata(path).is_ok_and(|metadata| metadata.file_type().is_file())
}

/// `roamgate rollback <args>`.
pub async fn rollback(runtime: &CliRuntime, effects: &Effects, args: &[String]) -> Printed {
    let mut printed = Printed::default();
    if wants_help(args) {
        printed.log(rollback_help());
        return printed.exit(0);
    }
    let result = rollback_inner(runtime, effects, args, &mut printed);
    finish("rollback", printed, result)
}

fn rollback_inner(
    runtime: &CliRuntime,
    effects: &Effects,
    args: &[String],
    printed: &mut Printed,
) -> Result<i32, Failure> {
    parse_flags(args, &[])?;
    if !runtime.standalone || runtime.platform == "win32" {
        printed
            .error("roamgate rollback: only the standalone Linux and macOS binary can roll back.");
        return Ok(1);
    }
    let current = runtime.exec_path.clone();
    let previous = PathBuf::from(format!("{}.previous", current.display()));
    if !regular_file(&current) || !regular_file(&previous) {
        printed.error(&format!(
            "roamgate rollback: no previous executable at {}",
            previous.display()
        ));
        return Ok(1);
    }
    let probe = std::process::Command::new(&previous)
        .arg("--version")
        .stdin(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .output();
    let previous_version = probe
        .as_ref()
        .map(|output| String::from_utf8_lossy(&output.stdout).trim().to_owned())
        .unwrap_or_default();
    let working = probe.as_ref().is_ok_and(|output| output.status.success())
        && regex::Regex::new(r"^roamgate \S+$")
            .unwrap()
            .is_match(&previous_version);
    if !working {
        printed.error(&format!(
            "roamgate rollback: {} is not a working roamgate executable; nothing changed.",
            previous.display()
        ));
        return Ok(1);
    }
    let name = current
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default();
    let parked = current
        .parent()
        .unwrap_or(Path::new("."))
        .join(format!(".{name}.rollback-{}", std::process::id()));
    let io = |error: std::io::Error| Failure::Failed(error.to_string());
    std::fs::rename(&current, &parked).map_err(io)?;
    if let Err(error) = std::fs::rename(&previous, &current) {
        let _ = std::fs::rename(&parked, &current);
        return Err(io(error));
    }
    std::fs::rename(&parked, &previous).map_err(io)?;
    printed.log(&format!(
        "Rolled back roamgate {} -> {}.",
        runtime.version,
        &previous_version["roamgate ".len()..]
    ));
    printed.log("Run `roamgate rollback` again to undo.");
    restart_service_using(runtime, effects, &current, printed)
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;
    use std::sync::Mutex;

    use roamgate_exec::service::fake::Recorder;

    use super::*;
    use crate::update::Ran;

    fn manifest(version: &str) -> String {
        serde_json::json!({
            "schema": 1, "name": "roamgate", "version": version, "platform": "linux-x64",
            "archive": "roamgate-linux-x64.tar.xz", "sha256": "a".repeat(64),
        })
        .to_string()
    }

    struct Test {
        _home: tempfile::TempDir,
        runtime: CliRuntime,
        calls: Arc<Mutex<Vec<Vec<String>>>>,
    }

    fn test(platform: &str) -> Test {
        let home = tempfile::tempdir().unwrap();
        let runtime = CliRuntime {
            platform: platform.into(),
            arch: "x64".into(),
            home: home.path().into(),
            app_data: None,
            exec_path: home.path().join("bin").join("roamgate"),
            version: "1.2.3".into(),
            standalone: true,
            uid: Some(1000),
            env: Arc::new(HashMap::<String, String>::new()),
        };
        Test {
            _home: home,
            runtime,
            calls: Arc::default(),
        }
    }

    /// curl answers `version`'s manifest, sh exits `install`.
    fn effects(test: &Test, version: &'static str, install: i32) -> Effects {
        let calls = test.calls.clone();
        Effects {
            run_process: Arc::new(move |argv, _| {
                calls.lock().unwrap().push(argv.clone());
                Box::pin(async move {
                    Ok(if argv[0] == "curl" {
                        Ran {
                            code: 0,
                            stdout: manifest(version),
                            stderr: String::new(),
                        }
                    } else {
                        Ran {
                            code: install,
                            stdout: String::new(),
                            stderr: if install == 0 {
                                String::new()
                            } else {
                                "checksum mismatch".into()
                            },
                        }
                    })
                })
            }),
            // Unknown commands fail like a missing service.
            run: Arc::new(Recorder::new(|_| 4)),
        }
    }

    fn args(list: &[&str]) -> Vec<String> {
        list.iter().map(|arg| (*arg).to_owned()).collect()
    }

    #[test]
    fn the_help_is_the_contract_s_golden() {
        assert_eq!(
            format!("{}\n", update_help()),
            include_str!("../../../contract/cli/help/update.txt")
        );
        assert_eq!(
            format!("{}\n", rollback_help()),
            include_str!("../../../contract/cli/help/rollback.txt")
        );
    }

    #[tokio::test]
    async fn uses_a_mirror_from_the_service_config() {
        let test = test("linux");
        let config = test.runtime.home.join(".config/roamgate/roamgate.env");
        std::fs::create_dir_all(config.parent().unwrap()).unwrap();
        std::fs::write(
            &config,
            "ROAMGATE_UPDATE_BASE_URL=https://mirror.example/roamgate/\n",
        )
        .unwrap();
        let printed = update(
            &test.runtime,
            &effects(&test, "1.2.3", 0),
            &args(&["--check"]),
        )
        .await;
        assert_eq!(
            test.calls.lock().unwrap()[0].last().unwrap(),
            "https://mirror.example/roamgate/roamgate-linux-x64.update.json"
        );
        assert!(printed.stdout.ends_with("Up to date.\n"), "{printed:?}");
    }

    #[tokio::test]
    async fn installs_over_the_running_executable_with_the_shared_verifier() {
        let test = test("linux");
        let printed = update(&test.runtime, &effects(&test, "1.3.0", 0), &[]).await;
        assert_eq!(printed.code, 0, "{printed:?}");
        let calls = test.calls.lock().unwrap();
        assert_eq!(&calls[1][..2], &args(&["sh", "-c"])[..]);
        let exec = test.runtime.exec_path.display().to_string();
        assert!(calls[1][2].contains(&format!("target='{exec}'")));
        assert!(calls[1][2].contains(&format!("expected_sha256='{}'", "a".repeat(64))));
        assert!(calls[1][2].contains("backup=\"$target.previous\""));
        assert!(
            printed
                .stdout
                .contains(&format!("Installed roamgate 1.3.0 at {exec}.\n"))
        );
        assert!(
            printed
                .stdout
                .ends_with("Restart any running roamgate process to use the new version.\n")
        );
    }

    #[tokio::test]
    async fn explains_platforms_without_update_packages() {
        let test = test("win32");
        let printed = update(&test.runtime, &effects(&test, "1.3.0", 0), &[]).await;
        assert_eq!(printed.code, 1);
        assert!(printed.stderr.contains("no update package for win32-x64"));
    }

    #[tokio::test]
    async fn reports_failures_and_usage_errors_as_the_cli_does() {
        let test = test("linux");
        let failed = update(&test.runtime, &effects(&test, "1.3.0", 1), &[]).await;
        assert_eq!(
            (failed.code, failed.stderr.as_str()),
            (1, "roamgate update: checksum mismatch\n")
        );
        let mut source = test.runtime.clone();
        source.standalone = false;
        assert_eq!(
            update(&source, &effects(&test, "1.3.0", 0), &[]).await.code,
            1
        );
        let usage = update(
            &test.runtime,
            &effects(&test, "1.3.0", 0),
            &args(&["--nope"]),
        )
        .await;
        assert_eq!(
            usage,
            Printed {
                code: 2,
                stdout: String::new(),
                stderr: "roamgate update: Unknown option '--nope'. To specify a positional argument starting with a '-', place it at the end of the command after '--', as in '-- \"--nope\"\nRun `roamgate update --help` for usage.\n".into()
            }
        );
        let json = update(
            &test.runtime,
            &effects(&test, "1.3.0", 0),
            &args(&["--check", "--json"]),
        )
        .await;
        assert_eq!(
            json.stdout,
            "{\n  \"current_version\": \"1.2.3\",\n  \"latest_version\": \"1.3.0\",\n  \"update_available\": true,\n  \"platform\": \"linux-x64\"\n}\n"
        );
    }

    #[cfg(unix)]
    fn executable(path: &Path, version: &str) {
        use std::os::unix::fs::PermissionsExt;
        std::fs::write(path, format!("#!/bin/sh\necho 'roamgate {version}'\n")).unwrap();
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755)).unwrap();
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn swaps_the_executable_with_roamgate_previous_and_back() {
        let test = test("linux");
        let current = test.runtime.exec_path.clone();
        std::fs::create_dir_all(current.parent().unwrap()).unwrap();
        executable(&current, "1.2.3");
        let previous = PathBuf::from(format!("{}.previous", current.display()));
        executable(&previous, "1.1.0");
        let effects = effects(&test, "1.3.0", 0);
        let printed = rollback(&test.runtime, &effects, &[]).await;
        assert_eq!(printed.code, 0, "{printed:?}");
        assert!(
            std::fs::read_to_string(&current)
                .unwrap()
                .contains("roamgate 1.1.0")
        );
        assert!(
            std::fs::read_to_string(&previous)
                .unwrap()
                .contains("roamgate 1.2.3")
        );
        assert!(
            printed
                .stdout
                .starts_with("Rolled back roamgate 1.2.3 -> 1.1.0.\n")
        );
        assert_eq!(rollback(&test.runtime, &effects, &[]).await.code, 0);
        assert!(
            std::fs::read_to_string(&current)
                .unwrap()
                .contains("roamgate 1.2.3")
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn leaves_files_alone_when_the_previous_executable_is_unusable() {
        use std::os::unix::fs::PermissionsExt;
        let test = test("linux");
        let current = test.runtime.exec_path.clone();
        std::fs::create_dir_all(current.parent().unwrap()).unwrap();
        executable(&current, "1.2.3");
        let effects = effects(&test, "1.3.0", 0);
        assert_eq!(rollback(&test.runtime, &effects, &[]).await.code, 1);
        let previous = PathBuf::from(format!("{}.previous", current.display()));
        std::fs::write(&previous, "#!/bin/sh\nexit 3\n").unwrap();
        std::fs::set_permissions(&previous, std::fs::Permissions::from_mode(0o755)).unwrap();
        let printed = rollback(&test.runtime, &effects, &[]).await;
        assert_eq!(printed.code, 1);
        assert!(
            printed
                .stderr
                .contains("is not a working roamgate executable; nothing changed.")
        );
        assert!(
            std::fs::read_to_string(&current)
                .unwrap()
                .contains("roamgate 1.2.3")
        );
    }
}
