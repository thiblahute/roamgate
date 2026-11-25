//! config/service-manager.test.ts: service commands driving systemctl,
//! launchctl and schtasks over files on disk (the rendered texts are
//! contract/vectors/service-manager.json).

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use roamgate_base::paths::join_relative;
use roamgate_exec::service::{RunCommand, ServicePlatform, escape_systemd_exec_path};

use super::*;
use crate::service::{render_launchd_service, roamgate_service_status};

const ALL: [&str; 3] = ["linux", "darwin", "win32"];

fn platform_of(platform: &str) -> ServicePlatform {
    resolve_service_platform(platform).unwrap()
}

type Answer = Box<dyn Fn(&[String]) -> i32 + Send + Sync>;

/// The commands a service command ran, answered by a closure. With
/// `legacy_absent`, the legacy service probes are answered as absent and
/// left out of the record, as the TS test's own runServiceCommand does.
struct Fake {
    calls: Mutex<Vec<(Vec<String>, bool)>>,
    answer: Answer,
    legacy_absent: bool,
}

impl Fake {
    fn new(answer: impl Fn(&[String]) -> i32 + Send + Sync + 'static) -> Self {
        Self {
            calls: Mutex::default(),
            answer: Box::new(answer),
            legacy_absent: false,
        }
    }

    /// The TS file's runServiceCommand: legacy services absent.
    fn without_legacy(answer: impl Fn(&[String]) -> i32 + Send + Sync + 'static) -> Self {
        Self {
            legacy_absent: true,
            ..Self::new(answer)
        }
    }

    fn argvs(&self) -> Vec<Vec<String>> {
        self.calls
            .lock()
            .unwrap()
            .iter()
            .map(|(argv, _)| argv.clone())
            .collect()
    }

    fn calls(&self) -> Vec<(Vec<String>, bool)> {
        self.calls.lock().unwrap().clone()
    }
}

fn is_user_domain(argv: &[String]) -> bool {
    argv[0] == "launchctl"
        && argv.get(1).map(String::as_str) == Some("print")
        && argv.get(2).is_some_and(|domain| {
            domain
                .strip_prefix("gui/")
                .is_some_and(|uid| !uid.is_empty() && uid.bytes().all(|b| b.is_ascii_digit()))
        })
}

impl RunCommand for Fake {
    fn run(&self, argv: &[String], quiet: bool) -> i32 {
        if self.legacy_absent {
            if has(argv, "herdr-gui.service") {
                return 4;
            }
            if is_user_domain(argv) {
                return 0;
            }
            if argv.join(" ").contains("dev.herdr.herdr-gui") {
                return if argv[0] == "powershell.exe" { 3 } else { 113 };
            }
        }
        self.calls.lock().unwrap().push((argv.to_vec(), quiet));
        (self.answer)(argv)
    }
}

/// A run that must not happen.
fn never(argv: &[String]) -> i32 {
    panic!("should not run: {argv:?}")
}

fn is_windows_task_query(argv: &[String]) -> bool {
    let script = argv.last().map(String::as_str).unwrap_or("");
    argv[0] == "powershell.exe"
        && has(argv, "-Command")
        && script.contains("CmdletizationQuery_NotFound_TaskName")
        && script.contains("$taskInfo.State -eq 'Running'")
}

fn is_windows_task_wait(argv: &[String]) -> bool {
    let script = argv.last().map(String::as_str).unwrap_or("");
    argv[0] == "powershell.exe"
        && has(argv, "-Command")
        && script.contains("Get-ScheduledTask")
        && script.contains("AddSeconds(15)")
}

fn has(argv: &[String], word: &str) -> bool {
    argv.iter().any(|arg| arg == word)
}

fn args(list: &[&str]) -> Vec<String> {
    argv(list)
}

/// Whether every `/TN` names `task`.
fn all_name(argvs: &[Vec<String>], task: &str) -> bool {
    argvs
        .iter()
        .all(|argv| match argv.iter().position(|arg| arg == "/TN") {
            Some(index) => argv[index + 1] == task,
            None => true,
        })
}

/// Answers the probes of the new identity as absent.
fn current_absent(argv: &[String], task: Option<&str>) -> Option<i32> {
    if has(argv, "roamgate.service") {
        return Some(4);
    }
    if has(argv, "gui/501/dev.roamgate") {
        return Some(113);
    }
    if is_windows_task_query(argv) && task.is_some_and(|task| argv.last().unwrap().contains(task)) {
        return Some(3);
    }
    None
}

struct Runtime {
    platform: &'static str,
    home: PathBuf,
    exec: PathBuf,
    uid: Option<u32>,
    app_data: Option<PathBuf>,
    standalone: bool,
}

impl Runtime {
    fn new(platform: &'static str, home: &Path, exec: impl AsRef<Path>) -> Self {
        Self {
            platform,
            home: home.to_path_buf(),
            exec: exec.as_ref().to_path_buf(),
            uid: None,
            app_data: None,
            standalone: true,
        }
    }

    fn uid(mut self, uid: u32) -> Self {
        self.uid = Some(uid);
        self
    }

    fn app_data(mut self, path: PathBuf) -> Self {
        self.app_data = Some(path);
        self
    }

    fn service(&self) -> ServiceRuntime {
        ServiceRuntime {
            platform: self.platform.into(),
            home: self.home.clone(),
            app_data: self.app_data.clone(),
            exec_path: self.exec.clone(),
            uid: self.uid,
        }
    }
}

/// What a command printed and returned.
struct Ran {
    outcome: ServiceOutcome,
    logs: Vec<String>,
    errors: Vec<String>,
}

impl Ran {
    fn code(&self) -> i32 {
        match self.outcome {
            ServiceOutcome::Code(code) => code,
            ServiceOutcome::Continue(_) => panic!("continued to the server"),
        }
    }

    fn log(&self) -> String {
        self.logs.join("\n")
    }

    fn error(&self) -> String {
        self.errors.join("\n")
    }
}

fn run_with(
    tail: &[&str],
    runtime: &Runtime,
    run: &dyn RunCommand,
    lan_ips: Vec<String>,
    check_listener: bool,
) -> Ran {
    let service = runtime.service();
    let lan = move || lan_ips.clone();
    let env = BTreeMap::<String, String>::new();
    let command = ServiceCommand {
        runtime: &service,
        run,
        env: &env,
        standalone: runtime.standalone,
        lan_ips: &lan,
        check_listener,
    };
    let (mut logs, mut errors) = (Vec::new(), Vec::new());
    let outcome = run_service_command(
        &args(tail),
        &command,
        &mut |line| logs.push(line.to_owned()),
        &mut |line| errors.push(line.to_owned()),
    );
    Ran {
        outcome,
        logs,
        errors,
    }
}

fn service(tail: &[&str], runtime: &Runtime, run: &dyn RunCommand) -> Ran {
    run_with(tail, runtime, run, Vec::new(), false)
}

fn home() -> tempfile::TempDir {
    tempfile::tempdir().unwrap()
}

fn paths(platform: ServicePlatform, home: &Path) -> ServicePaths {
    resolve_service_paths(platform, home, None)
}

fn legacy_paths(platform: ServicePlatform, home: &Path) -> ServicePaths {
    resolve_legacy_service_paths(platform, home, None)
}

fn write(path: &Path, contents: &str) {
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, contents).unwrap();
}

fn read(path: &Path) -> String {
    std::fs::read_to_string(path).unwrap()
}

#[cfg(unix)]
fn mode(path: &Path) -> u32 {
    use std::os::unix::fs::PermissionsExt;
    std::fs::metadata(path).unwrap().permissions().mode() & 0o777
}

#[cfg(unix)]
fn chmod(path: &Path, mode: u32) {
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode)).unwrap();
}

fn token_path(paths: &ServicePaths) -> PathBuf {
    dirname(&paths.config).join("auth-token")
}

fn is_token(text: &str) -> bool {
    text.len() == 64
        && text
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

/// The templates published with v0.7.0, for this home and binary.
fn published_legacy_definition(platform: ServicePlatform, home: &Path, binary: &Path) -> String {
    let templates: serde_json::Value =
        serde_json::from_str(include_str!("legacy-definitions.json")).unwrap();
    let paths = legacy_paths(platform, home);
    let values = [
        ("BINARY_PATH", text(binary)),
        ("CONFIG_PATH", text(&paths.config)),
        ("TASK_NAME", paths.task_name.clone().unwrap_or_default()),
        (
            "STDOUT_PATH",
            text(&join_relative(home, "Library/Logs/herdr-gui.stdout.log")),
        ),
        (
            "STDERR_PATH",
            text(&join_relative(home, "Library/Logs/herdr-gui.stderr.log")),
        ),
    ];
    let mut out = templates[platform.name()].as_str().unwrap().to_owned();
    for (key, value) in values {
        let value = match platform {
            ServicePlatform::Systemd => escape_systemd_exec_path(&value),
            ServicePlatform::WindowsTask => value.replace('\'', "''"),
            ServicePlatform::Launchd => roamgate_exec::service::xml_escape(&value),
        };
        out = out.replace(key, &value);
    }
    out
}

const LENGTH_ERROR: &str = "at least 8 characters and at most 1024 characters";

#[test]
#[cfg(unix)]
fn installs_and_starts_a_systemd_user_service() {
    let home = home();
    let fake = Fake::without_legacy(|_| 0);
    let runtime = Runtime::new("linux", home.path(), "/opt/roamgate-test/bin/roamgate").uid(1000);
    let ran = run_with(
        &["install"],
        &runtime,
        &fake,
        vec!["192.0.2.23".into()],
        false,
    );
    assert_eq!(ran.code(), 0);
    assert_eq!(
        fake.calls(),
        vec![
            (args(&["systemctl", "--user", "daemon-reload"]), false),
            (
                args(&["systemctl", "--user", "enable", "roamgate.service"]),
                false
            ),
            (
                args(&["systemctl", "--user", "restart", "roamgate.service"]),
                false
            ),
        ]
    );
    let current = paths(ServicePlatform::Systemd, home.path());
    assert!(read(&current.definition).contains("ExecStart=/opt/roamgate-test/bin/roamgate"));
    assert!(read(&current.config).contains("HOST=0.0.0.0"));
    assert_eq!(mode(&current.config), 0o600);
    let token = read(&token_path(&current)).trim().to_owned();
    assert!(is_token(&token));
    assert_eq!(mode(&token_path(&current)), 0o600);
    let log = ran.log();
    assert!(log.contains("Installed systemd service"));
    assert!(log.contains(&format!("Login token: {token}")));
    assert!(log.contains(&format!("Open: http://localhost:8787/?token={token}")));
    assert!(log.contains(&format!("LAN: http://192.0.2.23:8787/?token={token}")));
}

fn write_unit(home: &Path) {
    write(
        &paths(ServicePlatform::Systemd, home).definition,
        "[Service]\nExecStart=/bin/true\n",
    );
}

#[test]
fn reloads_the_systemd_definition_before_restarting() {
    let home = home();
    write_unit(home.path());
    let fake = Fake::without_legacy(|_| 0);
    let runtime = Runtime::new("linux", home.path(), "/opt/roamgate-test/bin/roamgate");
    assert_eq!(service(&["reload"], &runtime, &fake).code(), 0);
    assert_eq!(
        fake.argvs(),
        vec![
            args(&["systemctl", "--user", "daemon-reload"]),
            args(&["systemctl", "--user", "restart", "roamgate.service"]),
        ]
    );
}

#[test]
fn does_not_restart_systemd_when_daemon_reload_fails() {
    let home = home();
    write_unit(home.path());
    let fake = Fake::without_legacy(|_| 5);
    let runtime = Runtime::new("linux", home.path(), "/opt/roamgate-test/bin/roamgate");
    assert_eq!(service(&["reload"], &runtime, &fake).code(), 5);
    assert_eq!(fake.argvs().len(), 1);
}

#[test]
fn reports_a_missing_service_definition_during_reload() {
    let home = home();
    let fake = Fake::without_legacy(|_| 0);
    let runtime = Runtime::new("linux", home.path(), "/opt/roamgate-test/bin/roamgate");
    let ran = service(&["reload"], &runtime, &fake);
    assert_eq!(ran.code(), 1);
    assert!(fake.argvs().is_empty());
    assert!(
        ran.error()
            .contains("cannot reload missing systemd service")
    );
    assert_eq!(
        ran.errors.last().unwrap(),
        "Run `roamgate service --help` for usage."
    );
}

#[test]
fn preserves_an_existing_environment_file_during_reinstall() {
    let home = home();
    let current = paths(ServicePlatform::Systemd, home.path());
    let contents = "HOST=0.0.0.0\nHERDR_GUI_PASSWORD=fixed-secret-password\n";
    write(&current.config, contents);
    #[cfg(unix)]
    chmod(&current.config, 0o644);
    let fake = Fake::without_legacy(|_| 0);
    let runtime = Runtime::new("linux", home.path(), "/usr/local/bin/roamgate");
    assert_eq!(service(&["install"], &runtime, &fake).code(), 0);
    assert_eq!(read(&current.config), contents);
    #[cfg(unix)]
    assert_eq!(mode(&current.config), 0o600);
    assert!(!token_path(&current).exists());
}

#[test]
fn generates_a_login_token_for_loopback_service_host() {
    for host in ["127.0.0.1", "localhost", "::1"] {
        let home = home();
        let current = paths(ServicePlatform::Systemd, home.path());
        write(&current.config, &format!("HOST={host}\n"));
        let fake = Fake::without_legacy(|_| 0);
        let runtime = Runtime::new("linux", home.path(), "/opt/roamgate");
        let ran = service(&["install"], &runtime, &fake);
        assert_eq!(ran.code(), 0, "{host}");
        let token = read(&token_path(&current)).trim().to_owned();
        assert!(is_token(&token));
        assert!(ran.log().contains(&format!("?token={token}")), "{host}");
    }
}

#[test]
fn rejects_out_of_range_passwords_in_config_before_migrating_or_changing_services() {
    for (identity, password) in [
        ("roamgate", "short".to_owned()),
        ("roamgate", "a".repeat(1025)),
        ("herdr-gui", "short".to_owned()),
        ("herdr-gui", "a".repeat(1025)),
    ] {
        let home = home();
        let current = paths(ServicePlatform::Systemd, home.path());
        let source = if identity == "roamgate" {
            current.clone()
        } else {
            legacy_paths(ServicePlatform::Systemd, home.path())
        };
        let contents = format!("HOST=127.0.0.1\nHERDR_GUI_PASSWORD={password}\n");
        write(&source.config, &contents);
        let fake = Fake::without_legacy(|_| 0);
        let runtime = Runtime::new("linux", home.path(), "/opt/roamgate");
        let ran = service(&["install"], &runtime, &fake);
        assert_eq!(ran.code(), 1);
        assert!(fake.argvs().is_empty());
        assert!(ran.error().contains(LENGTH_ERROR));
        assert_eq!(read(&source.config), contents);
        assert!(!current.definition.exists());
        assert!(!token_path(&current).exists());
        if identity == "herdr-gui" {
            assert!(!current.config.exists());
        }
    }
}

#[test]
fn validates_the_effective_launchd_password() {
    let rocket = "\u{1f680}";
    let cases = [
        (
            "current expansion",
            "SECRET=synthetic-valid-password\nROAMGATE_PASSWORD=\"$SECRET\"\n".to_owned(),
            true,
        ),
        (
            "legacy expansion",
            "SECRET=synthetic-valid-password\nHERDR_GUI_PASSWORD=\"${SECRET}\"\n".to_owned(),
            true,
        ),
        (
            "escaped literal dollar",
            "ROAMGATE_PASSWORD=\"\\$literal-password\"\n".to_owned(),
            true,
        ),
        (
            "single quoted dollar",
            "ROAMGATE_PASSWORD='$literal-password'\n".to_owned(),
            true,
        ),
        (
            "quote concatenation",
            "ROAMGATE_PASSWORD=abcde\"fghij\"'klmno'\n".to_owned(),
            true,
        ),
        (
            "inline comment",
            "ROAMGATE_PASSWORD=synthetic-valid-password # ignored\n".to_owned(),
            true,
        ),
        (
            "minimum Unicode length",
            format!(
                "SECRET={}\nROAMGATE_PASSWORD=\"$SECRET\"\n",
                rocket.repeat(15)
            ),
            true,
        ),
        (
            "maximum Unicode length",
            format!(
                "SECRET={}\nROAMGATE_PASSWORD=\"$SECRET\"\n",
                rocket.repeat(1024)
            ),
            true,
        ),
        (
            "new name precedence",
            "HERDR_GUI_PASSWORD=short\nSECRET=synthetic-valid-password\nROAMGATE_PASSWORD=\"$SECRET\"\n"
                .to_owned(),
            true,
        ),
        (
            "explicit empty new name",
            "HERDR_GUI_PASSWORD=short\nEMPTY=\nROAMGATE_PASSWORD=\"$EMPTY\"\n".to_owned(),
            false,
        ),
    ];
    for (name, password_config, fixed) in cases {
        let home = home();
        let current = paths(ServicePlatform::Launchd, home.path());
        let config = format!("HOST=127.0.0.1\n{password_config}");
        write(&current.config, &config);
        let fake = Fake::without_legacy(|argv| if argv[1] == "print" { 113 } else { 0 });
        let runtime = Runtime::new("darwin", home.path(), "/opt/roamgate").uid(501);
        let ran = service(&["install"], &runtime, &fake);
        assert_eq!(ran.code(), 0, "{name}: {:?}", ran.errors);
        assert!(ran.errors.is_empty(), "{name}");
        assert_eq!(read(&current.config), config, "{name}");
        let log = ran.log();
        assert_eq!(
            log.contains("Authentication: fixed password"),
            fixed,
            "{name}"
        );
        assert_eq!(token_path(&current).exists(), !fixed, "{name}");
        for secret in [
            "synthetic-valid-password",
            "$literal-password",
            "abcdefghijklmno",
        ] {
            assert!(!log.contains(secret), "{name}");
        }
    }
}

#[test]
fn rejects_invalid_effective_launchd_password_from_identity_before_mutations() {
    let rocket = "\u{1f680}";
    for identity in ["roamgate", "herdr-gui"] {
        let cases = [
            (
                "short expansion",
                "LONG_SECRET_VARIABLE=short\nROAMGATE_PASSWORD=\"$LONG_SECRET_VARIABLE\"\n"
                    .to_owned(),
            ),
            (
                "short legacy expansion",
                "LONG_SECRET_VARIABLE=short\nHERDR_GUI_PASSWORD=\"$LONG_SECRET_VARIABLE\"\n"
                    .to_owned(),
            ),
            (
                "short Unicode expansion",
                format!(
                    "SECRET={}\nROAMGATE_PASSWORD=\"$SECRET\"\n",
                    rocket.repeat(7)
                ),
            ),
            (
                "oversized expansion",
                format!(
                    "SECRET={}\nROAMGATE_PASSWORD=\"$SECRET\"\n",
                    rocket.repeat(1025)
                ),
            ),
            (
                "literal dollar stays literal",
                "ROAMGATE_PASSWORD='$SECRET'\n".to_owned(),
            ),
            (
                "escaped dollar stays literal",
                "ROAMGATE_PASSWORD=\"\\$SECRET\"\n".to_owned(),
            ),
        ];
        for (name, password_config) in cases {
            let home = home();
            let current = paths(ServicePlatform::Launchd, home.path());
            let source = if identity == "roamgate" {
                current.clone()
            } else {
                legacy_paths(ServicePlatform::Launchd, home.path())
            };
            let definition = "<!-- Generated by roamgate service install. -->\nexisting definition";
            write(&current.definition, definition);
            let config = format!("HOST=127.0.0.1\n{password_config}");
            write(&source.config, &config);
            #[cfg(unix)]
            chmod(&source.config, 0o644);
            let fake = Fake::without_legacy(|_| 0);
            let runtime = Runtime::new("darwin", home.path(), "/opt/roamgate").uid(501);
            let ran = service(&["install"], &runtime, &fake);
            let what = format!("{identity}: {name}");
            assert_eq!(ran.code(), 1, "{what}");
            assert!(fake.argvs().is_empty(), "{what}");
            assert!(ran.error().contains(LENGTH_ERROR), "{what}");
            assert!(!ran.error().contains("short"), "{what}");
            assert_eq!(read(&source.config), config, "{what}");
            assert_eq!(read(&current.definition), definition, "{what}");
            #[cfg(unix)]
            assert_eq!(mode(&source.config), 0o644, "{what}");
            assert!(!token_path(&current).exists(), "{what}");
            if identity == "herdr-gui" {
                assert!(!current.config.exists(), "{what}");
            }
        }
    }
}

#[test]
fn rejects_unsafe_launchd_syntax_without_execution_or_mutation() {
    for syntax in [
        "command substitution",
        "standalone command",
        "external reference",
        "shell-special variable",
    ] {
        let home = home();
        let current = paths(ServicePlatform::Launchd, home.path());
        let marker = home.path().join("executed");
        let shown = marker.display();
        let expression = match syntax {
            "command substitution" => {
                format!("ROAMGATE_PASSWORD=\"$(touch '{shown}')synthetic-valid-password\"")
            }
            "standalone command" => {
                format!("ROAMGATE_PASSWORD=synthetic-valid-password\ntouch '{shown}'")
            }
            "external reference" => {
                "ROAMGATE_PASSWORD=\"$ROAMGATE_TEST_EXTERNAL_SECRET\"".to_owned()
            }
            _ => "OPTIND=000000000000001\nROAMGATE_PASSWORD=\"$OPTIND\"".to_owned(),
        };
        let config = format!("HOST=127.0.0.1\n{expression}\n");
        write(&current.config, &config);
        let fake = Fake::without_legacy(|_| 0);
        let runtime = Runtime::new("darwin", home.path(), "/opt/roamgate").uid(501);
        let ran = service(&["install"], &runtime, &fake);
        assert_eq!(ran.code(), 1, "{syntax}");
        assert!(fake.argvs().is_empty(), "{syntax}");
        assert!(!marker.exists(), "{syntax}");
        assert!(!current.definition.exists(), "{syntax}");
        assert!(!token_path(&current).exists(), "{syntax}");
        assert_eq!(read(&current.config), config, "{syntax}");
        let messages = format!("{}\n{}", ran.log(), ran.error());
        assert!(messages.contains("invalid launchd environment"), "{syntax}");
        assert!(!messages.contains("synthetic-valid-password"), "{syntax}");
    }
}

// A Linux or macOS service manager, simulated over this machine's paths:
// its units name Unix paths a Windows home cannot give.
#[cfg(unix)]
#[test]
fn preserves_a_managed_custom_wrapper_command() {
    let home = home();
    let definition = paths(ServicePlatform::Systemd, home.path()).definition;
    let binary = home.path().join(".local/bin/roamgate");
    let wrapper = home.path().join(".local/libexec/service-wrapper");
    let wrapper_command = format!(
        "{} --service example -- {} --host 0.0.0.0",
        wrapper.display(),
        binary.display()
    );
    write(
        &definition,
        &format!(
            "# Generated by roamgate service install.\n[Service]\nExecStart={wrapper_command}\n"
        ),
    );
    let fake = Fake::without_legacy(|_| 0);
    let runtime = Runtime::new("linux", home.path(), &binary);
    let ran = service(&["install"], &runtime, &fake);
    assert_eq!(ran.code(), 0);
    let written = read(&definition);
    assert!(written.contains(&format!("ExecStart={wrapper_command}")));
    assert!(written.contains("Restart=always"));
    assert!(
        ran.logs
            .contains(&format!("Preserved custom ExecStart: {wrapper_command}"))
    );
}

// A Linux or macOS service manager, simulated over this machine's paths:
// its units name Unix paths a Windows home cannot give.
#[cfg(unix)]
#[test]
fn replaces_a_stale_custom_command_that_does_not_invoke_this_binary() {
    let home = home();
    let definition = paths(ServicePlatform::Systemd, home.path()).definition;
    write(
        &definition,
        "# Generated by roamgate service install.\n[Service]\nExecStart=/usr/local/bin/service-wrapper -- /opt/roamgate-test/bin/roamgate-old\n",
    );
    let fake = Fake::without_legacy(|_| 0);
    let runtime = Runtime::new("linux", home.path(), "/opt/roamgate-test/bin/roamgate");
    assert_eq!(service(&["install"], &runtime, &fake).code(), 0);
    let written = read(&definition);
    assert!(written.contains("ExecStart=/opt/roamgate-test/bin/roamgate\n"));
    assert!(!written.contains("service-wrapper"));
}

#[test]
fn refuses_to_overwrite_an_unmanaged_service_without_force() {
    let home = home();
    let definition = paths(ServicePlatform::Systemd, home.path()).definition;
    write(&definition, "[Service]\nExecStart=/custom/wrapper\n");
    let fake = Fake::without_legacy(|_| 0);
    let runtime = Runtime::new("linux", home.path(), "/usr/local/bin/roamgate");
    let ran = service(&["install"], &runtime, &fake);
    assert_eq!(ran.code(), 1);
    assert!(fake.argvs().is_empty());
    assert!(read(&definition).contains("/custom/wrapper"));
    assert!(ran.error().contains("rerun with --force"));
}

#[test]
fn validates_launchd_identity_before_writing_service_files() {
    let home = home();
    let fake = Fake::without_legacy(never);
    let runtime = Runtime::new("darwin", home.path(), "/opt/roamgate-test/bin/roamgate");
    let ran = service(&["install"], &runtime, &fake);
    assert_eq!(ran.code(), 1);
    assert!(
        ran.error()
            .contains("cannot determine the current user id for launchd")
    );
    let current = paths(ServicePlatform::Launchd, home.path());
    assert!(!current.config.exists());
    assert!(!current.definition.exists());
}

#[test]
fn installs_inspects_restarts_reloads_and_removes_a_launchd_agent() {
    let home = home();
    let loaded = Arc::new(Mutex::new(false));
    let state = loaded.clone();
    let fake = Fake::without_legacy(move |argv| {
        let mut loaded = state.lock().unwrap();
        match argv[1].as_str() {
            "print" => return if *loaded { 0 } else { 1 },
            "bootstrap" => *loaded = true,
            "bootout" => *loaded = false,
            _ => {}
        }
        0
    });
    let runtime = Runtime::new("darwin", home.path(), "/opt/roamgate-test/bin/roamgate").uid(501);
    for action in ["install", "status", "restart", "reload", "uninstall"] {
        assert_eq!(service(&[action], &runtime, &fake).code(), 0, "{action}");
    }
    let plist = join_relative(home.path(), "Library/LaunchAgents/dev.roamgate.plist");
    assert!(!plist.exists());
    let plist = text(&plist);
    let call = |list: &[&str], quiet: bool| (args(list), quiet);
    assert_eq!(
        fake.calls(),
        vec![
            call(&["launchctl", "print", "gui/501/dev.roamgate"], true),
            call(&["launchctl", "bootstrap", "gui/501", &plist], false),
            call(&["launchctl", "print", "gui/501/dev.roamgate"], false),
            call(
                &["launchctl", "kickstart", "-k", "gui/501/dev.roamgate"],
                false
            ),
            call(&["launchctl", "print", "gui/501/dev.roamgate"], true),
            call(&["launchctl", "bootout", "gui/501/dev.roamgate"], false),
            call(&["launchctl", "bootstrap", "gui/501", &plist], false),
            call(&["launchctl", "print", "gui/501/dev.roamgate"], true),
            call(&["launchctl", "bootout", "gui/501/dev.roamgate"], false),
        ]
    );
    assert!(read(&paths(ServicePlatform::Launchd, home.path()).config).contains("HOST=0.0.0.0"));
}

/// The TS test runs the default runner with a fake `launchctl` script on
/// PATH; here a fake gives the script's answers and the listener check is
/// on, as it is with the real commands.
#[test]
fn launchd_syntax_uses_the_resolved_occupied_or_free_listener() {
    for syntax in ["inline comment", "variable expansion"] {
        for occupied in [false, true] {
            let home = home();
            let current = paths(ServicePlatform::Launchd, home.path());
            let listener = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
            let port = listener.local_addr().unwrap().port();
            let held = occupied.then_some(listener);
            let config = if syntax == "inline comment" {
                format!("HOST=127.0.0.1 # local only\nPORT={port}\n")
            } else {
                format!(
                    "BIND_ADDRESS=127.0.0.1\nBIND_PORT={port}\nHOST=\"$BIND_ADDRESS\"\nPORT=\"$BIND_PORT\"\n"
                )
            };
            write(&current.config, &config);
            let fake =
                Fake::new(
                    |argv| match (argv[1].as_str(), argv.get(2).map(String::as_str)) {
                        ("print", Some("gui/501/dev.herdr.herdr-gui" | "gui/501/dev.roamgate")) => {
                            113
                        }
                        ("print" | "bootstrap", Some("gui/501")) => 0,
                        _ => 1,
                    },
                );
            let runtime = Runtime::new("darwin", home.path(), "/opt/roamgate").uid(501);
            let ran = run_with(&["install"], &runtime, &fake, Vec::new(), true);
            let what = format!("{syntax} occupied={occupied}");
            assert_eq!(ran.code(), i32::from(occupied), "{what}: {:?}", ran.errors);
            assert_eq!(read(&current.config), config, "{what}");
            let commands: Vec<String> = fake
                .argvs()
                .iter()
                .map(|argv| argv[1..].join(" "))
                .collect();
            if occupied {
                assert!(
                    ran.error().contains(&format!(
                        "Cannot listen on 127.0.0.1:{port}: the port is already in use"
                    )),
                    "{what}"
                );
                assert!(
                    !commands.iter().any(|line| line.contains("bootstrap")),
                    "{what}"
                );
            } else {
                assert!(
                    ran.log()
                        .contains(&format!("Open: http://localhost:{port}")),
                    "{what}"
                );
                assert!(
                    commands
                        .iter()
                        .any(|line| line.starts_with("bootstrap gui/501")),
                    "{what}"
                );
            }
            drop(held);
        }
    }
}

#[test]
fn manages_a_windows_login_task() {
    let home = home();
    let app_data = home.path().join("AppData").join("Roaming");
    let executable = home.path().join("bin").join("roamgate.exe");
    let task_paths =
        resolve_service_paths(ServicePlatform::WindowsTask, home.path(), Some(&app_data));
    let task = task_paths.task_name.clone().unwrap();
    let exists = Arc::new(Mutex::new(false));
    let state = exists.clone();
    let fake = Fake::without_legacy(move |argv| {
        let mut exists = state.lock().unwrap();
        if is_windows_task_query(argv) {
            return if *exists { 0 } else { 3 };
        }
        if has(argv, "-File") {
            *exists = true;
        }
        if argv[1] == "/Delete" {
            *exists = false;
        }
        0
    });
    let runtime = Runtime::new("win32", home.path(), &executable).app_data(app_data.clone());
    assert_eq!(service(&["install"], &runtime, &fake).code(), 0);
    let definition = read(&task_paths.definition);
    assert!(definition.starts_with('\u{feff}'));
    assert!(definition.contains(&format!(
        "New-ScheduledTaskAction -Execute '{}'",
        executable.display()
    )));
    assert!(definition.contains(&format!("service run \"{}\"", task_paths.config.display())));
    assert!(read(&task_paths.config).contains("HOST=0.0.0.0"));
    assert!(is_token(read(&app_data.join("roamgate/auth-token")).trim()));
    for action in ["status", "restart", "reload", "uninstall"] {
        assert_eq!(service(&[action], &runtime, &fake).code(), 0, "{action}");
    }
    let calls = fake.calls();
    assert!(is_windows_task_query(&calls[0].0));
    assert!(!calls[0].1);
    assert!(calls[0].0.last().unwrap().contains(&task));
    let argvs = fake.argvs();
    let files: Vec<&Vec<String>> = argvs.iter().filter(|argv| has(argv, "-File")).collect();
    assert_eq!(
        files[0],
        &args(&[
            "powershell.exe",
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            &text(&task_paths.definition),
        ])
    );
    assert_eq!(files.len(), 2);
    assert_eq!(argvs.iter().filter(|argv| argv[1] == "/Run").count(), 3);
    assert!(all_name(&argvs, &task));
    assert!(argvs.iter().any(|argv| is_windows_task_wait(argv)));
    assert!(argvs.iter().any(|argv| argv[1] == "/Delete"));
    assert!(!*exists.lock().unwrap());
    assert!(!task_paths.definition.exists());
    assert!(task_paths.config.exists());
}

fn windows_runtime(home: &Path, app_data: &Path) -> Runtime {
    Runtime::new("win32", home, home.join("roamgate.exe")).app_data(app_data.to_path_buf())
}

#[test]
fn uninstalls_an_inactive_windows_task_when_its_helper_script_is_missing() {
    let home = home();
    let app_data = home.path().join("AppData/Roaming");
    let task_paths =
        resolve_service_paths(ServicePlatform::WindowsTask, home.path(), Some(&app_data));
    let task = task_paths.task_name.clone().unwrap();
    let exists = Arc::new(Mutex::new(true));
    let state = exists.clone();
    let fake = Fake::without_legacy(move |argv| {
        let mut exists = state.lock().unwrap();
        if is_windows_task_query(argv) {
            return if *exists { 4 } else { 3 };
        }
        if argv[1] == "/Delete" {
            *exists = false;
            return 1;
        }
        0
    });
    let runtime = windows_runtime(home.path(), &app_data);
    assert_eq!(service(&["uninstall"], &runtime, &fake).code(), 0);
    let argvs = fake.argvs();
    assert!(argvs.iter().any(|argv| argv[1] == "/End"));
    assert!(argvs.iter().any(|argv| argv[1] == "/Delete"));
    assert_eq!(
        argvs
            .iter()
            .filter(|argv| is_windows_task_query(argv))
            .count(),
        2
    );
    assert!(!*exists.lock().unwrap());
    assert!(!task_paths.definition.exists());
    assert!(all_name(&argvs, &task));
}

#[test]
fn removes_a_stale_windows_helper_when_its_task_is_already_absent() {
    let home = home();
    let app_data = home.path().join("AppData/Roaming");
    let task_paths =
        resolve_service_paths(ServicePlatform::WindowsTask, home.path(), Some(&app_data));
    write(
        &task_paths.definition,
        "# Generated by roamgate service install.\n",
    );
    let fake = Fake::without_legacy(|argv| if is_windows_task_query(argv) { 3 } else { 0 });
    let runtime = windows_runtime(home.path(), &app_data);
    assert_eq!(service(&["uninstall"], &runtime, &fake).code(), 0);
    let argvs = fake.argvs();
    assert_eq!(
        argvs
            .iter()
            .filter(|argv| is_windows_task_query(argv))
            .count(),
        1
    );
    assert!(!argvs.iter().any(|argv| argv[1] == "/Delete"));
    assert!(!task_paths.definition.exists());
}

#[test]
fn propagates_windows_task_query_failures_without_changing_state() {
    let home = home();
    let app_data = home.path().join("AppData/Roaming");
    let task_paths =
        resolve_service_paths(ServicePlatform::WindowsTask, home.path(), Some(&app_data));
    let runtime = windows_runtime(home.path(), &app_data);
    let answer = |argv: &[String]| if is_windows_task_query(argv) { 5 } else { 0 };
    let install = Fake::without_legacy(answer);
    assert_eq!(service(&["install"], &runtime, &install).code(), 5);
    assert_eq!(install.argvs().len(), 1);
    assert!(is_windows_task_query(&install.argvs()[0]));
    assert!(!task_paths.definition.exists());
    assert!(!task_paths.config.exists());

    write(
        &task_paths.definition,
        "# Generated by roamgate service install.\n",
    );
    let uninstall = Fake::without_legacy(answer);
    assert_eq!(service(&["uninstall"], &runtime, &uninstall).code(), 5);
    assert_eq!(uninstall.argvs().len(), 1);
    assert!(is_windows_task_query(&uninstall.argvs()[0]));
    assert!(task_paths.definition.exists());
}

#[test]
fn does_not_restart_when_task_state_confirmation_fails() {
    let home = home();
    let app_data = home.path().join("AppData/Roaming");
    let fake = Fake::without_legacy(|argv| if is_windows_task_wait(argv) { 7 } else { 0 });
    let runtime = windows_runtime(home.path(), &app_data);
    assert_eq!(service(&["restart"], &runtime, &fake).code(), 7);
    let argvs = fake.argvs();
    assert!(argvs.iter().any(|argv| argv[1] == "/End"));
    assert!(argvs.iter().any(|argv| is_windows_task_wait(argv)));
    assert!(!argvs.iter().any(|argv| argv[1] == "/Run"));
}

#[test]
fn loads_environment_for_the_direct_windows_task_process() {
    let home = home();
    let config = home.path().join("roamgate.env");
    std::fs::write(
        &config,
        "# service environment\nHOST=127.0.0.1\nexport PORT=\"9123\"\nHERDR_SESSION=gui-test",
    )
    .unwrap();
    let runtime = Runtime::new("win32", home.path(), home.path().join("roamgate.exe"));
    let ran = service(&["run", &text(&config)], &runtime, &Fake::new(never));
    let ServiceOutcome::Continue(environment) = ran.outcome else {
        panic!("{:?}", ran.errors);
    };
    assert_eq!(environment.entries["HOST"], "127.0.0.1");
    assert_eq!(environment.entries["PORT"], "9123");
    assert_eq!(environment.entries["HERDR_SESSION"], "gui-test");
    assert!(environment.supervisor);
}

#[test]
fn does_not_install_a_development_runtime_as_a_service() {
    let home = home();
    let fake = Fake::without_legacy(never);
    let runtime = Runtime::new("darwin", home.path(), "/opt/homebrew/bin/bun").uid(501);
    let ran = service(&["install"], &runtime, &fake);
    assert_eq!(ran.code(), 1);
    assert!(
        ran.error()
            .contains("service install requires the standalone roamgate binary")
    );
    // A Bun run of the sources is not standalone either, whatever its name.
    let mut sources = Runtime::new("darwin", home.path(), "/opt/roamgate").uid(501);
    sources.standalone = false;
    assert_eq!(service(&["install"], &sources, &fake).code(), 1);
}

#[test]
fn does_not_bootstrap_launchd_when_stopping_the_loaded_job_fails() {
    let home = home();
    let runtime = Runtime::new("darwin", home.path(), "/opt/roamgate-test/bin/roamgate").uid(501);
    let first = Fake::without_legacy(|argv| i32::from(argv[1] == "print"));
    assert_eq!(service(&["install"], &runtime, &first).code(), 0);
    let second = Fake::without_legacy(|argv| match argv[1].as_str() {
        "bootout" => 5,
        _ => 0,
    });
    assert_eq!(service(&["install"], &runtime, &second).code(), 5);
    assert!(!second.argvs().iter().any(|argv| argv[1] == "bootstrap"));
}

#[test]
fn keeps_a_managed_systemd_definition_when_stopping_fails() {
    let home = home();
    let runtime = Runtime::new("linux", home.path(), "/opt/roamgate-test/bin/roamgate");
    assert_eq!(
        service(&["install"], &runtime, &Fake::without_legacy(|_| 0)).code(),
        0
    );
    let stop = Fake::without_legacy(|argv| i32::from(has(argv, "disable")));
    assert_eq!(service(&["uninstall"], &runtime, &stop).code(), 1);
    assert!(
        read(&paths(ServicePlatform::Systemd, home.path()).definition)
            .contains("Generated by roamgate service install.")
    );
}

#[test]
fn treats_uninstall_without_a_managed_definition_as_a_no_op() {
    let home = home();
    let fake = Fake::without_legacy(|_| 0);
    let runtime = Runtime::new("linux", home.path(), "/opt/roamgate-test/bin/roamgate");
    let ran = service(&["uninstall"], &runtime, &fake);
    assert_eq!(ran.code(), 0);
    assert!(fake.argvs().is_empty());
    assert!(ran.log().contains("No managed systemd service found"));
}

// A Linux or macOS service manager, simulated over this machine's paths:
// its units name Unix paths a Windows home cannot give.
#[cfg(unix)]
#[test]
fn platform_action_manages_the_generated_legacy_service_without_migrating_it() {
    for platform in ALL {
        for action in ["status", "restart", "reload", "uninstall"] {
            let home = home();
            let kind = platform_of(platform);
            let legacy = legacy_paths(kind, home.path());
            let current = paths(kind, home.path());
            let binary = home.path().join("roamgate");
            let definition = published_legacy_definition(kind, home.path(), &binary);
            write(&legacy.definition, &definition);
            write(&legacy.config, "HOST=127.0.0.1\nPORT=8899\n");
            let token = dirname(&legacy.config).join("auth-token");
            std::fs::write(&token, "a".repeat(64)).unwrap();
            let runtime = Runtime::new(platform, home.path(), &binary).uid(501);
            let what = format!("{platform} {action}");
            let refused = service(&["install", "--force"], &runtime, &Fake::new(never));
            assert_eq!(refused.code(), 1, "{what}");
            let task = current.task_name.clone();
            let fake = Fake::new(move |argv| current_absent(argv, task.as_deref()).unwrap_or(0));
            let ran = service(&[action], &runtime, &fake);
            assert_eq!(ran.code(), 0, "{what}: {:?}", ran.errors);
            let argvs = fake.argvs();
            if action == "uninstall" {
                assert!(
                    argvs.iter().any(|argv| has(argv, "disable")
                        || has(argv, "bootout")
                        || has(argv, "/Delete")),
                    "{what}"
                );
                assert!(!legacy.definition.exists(), "{what}");
            } else {
                assert!(
                    argvs.last().unwrap().join(" ").contains("herdr-gui"),
                    "{what}"
                );
                assert_eq!(read(&legacy.definition), definition, "{what}");
            }
            // Probes may inspect the new identity, but nothing changes it.
            for argv in &argvs {
                if has(argv, "status")
                    || argv.get(1).map(String::as_str) == Some("print")
                    || is_windows_task_query(argv)
                    || has(argv, "daemon-reload")
                {
                    continue;
                }
                assert!(argv.join(" ").contains("herdr-gui"), "{what}: {argv:?}");
            }
            assert_eq!(
                read(&legacy.config),
                "HOST=127.0.0.1\nPORT=8899\n",
                "{what}"
            );
            assert_eq!(read(&token), "a".repeat(64), "{what}");
            assert!(!current.definition.exists(), "{what}");
            assert!(!current.config.exists(), "{what}");
            assert!(ran.log().contains("legacy service"), "{what}");
        }
    }
}

#[test]
fn platform_refuses_ambiguous_or_unverified_management() {
    for platform in ALL {
        let kind = platform_of(platform);
        for state in [
            "both definitions",
            "current loaded",
            "query failure",
            "custom legacy",
            "custom generated identity",
            "custom generated script",
            "another binary",
            "legacy loaded only",
        ] {
            let home = home();
            let legacy = legacy_paths(kind, home.path());
            let current = paths(kind, home.path());
            let binary = if state == "another binary" {
                "/other/roamgate"
            } else {
                "/opt/roamgate"
            };
            let mut definition = published_legacy_definition(kind, home.path(), Path::new(binary));
            if state == "custom legacy" {
                definition = "custom definition".into();
            }
            if state == "custom generated identity" {
                definition = match platform {
                    "linux" => definition.replacen("ExecStart=", "ExecStart=/custom/wrapper ", 1),
                    "darwin" => definition.replacen(
                        "<string>dev.herdr.herdr-gui</string>",
                        "<string>dev.roamgate</string>",
                        1,
                    ),
                    _ => definition.replacen("$taskName = ", "$taskName = 'custom'; # ", 1),
                };
            }
            if state == "custom generated script" {
                definition.push_str("\nWrite-Output 'custom command'\n");
            }
            if state != "legacy loaded only" {
                write(&legacy.definition, &definition);
            }
            if state == "both definitions" {
                write(
                    &current.definition,
                    "# Generated by roamgate service install.\n",
                );
            }
            let customized = state.starts_with("custom") || state == "another binary";
            let query_failure = state == "query failure";
            for action in ["status", "restart", "reload", "uninstall"] {
                let task = current.task_name.clone();
                let fake = Fake::new(move |argv| {
                    if argv[0] == "launchctl" && argv.get(2).map(String::as_str) == Some("gui/501")
                    {
                        return 0;
                    }
                    if customized && let Some(code) = current_absent(argv, task.as_deref()) {
                        return code;
                    }
                    if query_failure { 5 } else { 0 }
                });
                let runtime = Runtime::new(platform, home.path(), "/opt/roamgate").uid(501);
                let what = format!("{platform} {state} {action}");
                assert_eq!(service(&[action], &runtime, &fake).code(), 1, "{what}");
                let argvs = fake.argvs();
                assert!(
                    argvs.iter().all(|argv| has(argv, "status")
                        || argv.get(1).map(String::as_str) == Some("print")
                        || is_windows_task_query(argv)),
                    "{what}: {argvs:?}"
                );
                if customized {
                    assert!(argvs.is_empty(), "{what}: {argvs:?}");
                }
                assert_eq!(
                    legacy.definition.exists(),
                    state != "legacy loaded only",
                    "{what}"
                );
                if state != "legacy loaded only" {
                    assert_eq!(read(&legacy.definition), definition, "{what}");
                }
                assert_eq!(
                    current.definition.exists(),
                    state == "both definitions",
                    "{what}"
                );
            }
        }
    }
}

// A Linux or macOS service manager, simulated over this machine's paths:
// its units name Unix paths a Windows home cannot give.
#[cfg(unix)]
#[test]
fn platform_preserves_the_legacy_definition_when_stopping_fails() {
    for platform in ALL {
        let home = home();
        let kind = platform_of(platform);
        let legacy = legacy_paths(kind, home.path());
        let task = paths(kind, home.path()).task_name;
        let definition = published_legacy_definition(kind, home.path(), Path::new("/opt/roamgate"));
        write(&legacy.definition, &definition);
        let fake = Fake::new(move |argv| {
            if let Some(code) = current_absent(argv, task.as_deref()) {
                return code;
            }
            if has(argv, "disable") || has(argv, "bootout") || is_windows_task_wait(argv) {
                return 7;
            }
            0
        });
        let runtime = Runtime::new(platform, home.path(), "/opt/roamgate").uid(501);
        assert_eq!(
            service(&["uninstall"], &runtime, &fake).code(),
            7,
            "{platform}"
        );
        assert_eq!(read(&legacy.definition), definition, "{platform}");
        assert!(
            !fake.argvs().iter().any(|argv| has(argv, "/Delete")),
            "{platform}"
        );
    }
}

// A Linux or macOS service manager, simulated over this machine's paths:
// its units name Unix paths a Windows home cannot give.
#[cfg(unix)]
#[test]
fn restores_the_original_systemd_definition_and_permissions_if_daemon_reload_fails() {
    let home = home();
    let legacy = legacy_paths(ServicePlatform::Systemd, home.path());
    let definition = published_legacy_definition(
        ServicePlatform::Systemd,
        home.path(),
        Path::new("/opt/roamgate"),
    );
    write(&legacy.definition, &definition);
    #[cfg(unix)]
    chmod(&legacy.definition, 0o640);
    write(&legacy.config, "HOST=127.0.0.1\n");
    let token = dirname(&legacy.config).join("auth-token");
    std::fs::write(&token, "a".repeat(64)).unwrap();
    let backup = PathBuf::from(format!(
        "{}.uninstall-{}",
        legacy.definition.display(),
        std::process::id()
    ));
    // A failing daemon-reload, then one that panics (the TS runner throws).
    for panics in [false, true] {
        let moved = legacy.definition.clone();
        let fake = Fake::new(move |argv| {
            if has(argv, "roamgate.service") {
                return 4;
            }
            if has(argv, "daemon-reload") {
                assert!(!moved.exists());
                assert!(!panics, "daemon-reload failed");
                return 7;
            }
            0
        });
        let runtime = Runtime::new("linux", home.path(), "/opt/roamgate");
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            service(&["uninstall"], &runtime, &fake).code()
        }));
        if panics {
            assert!(result.is_err());
        } else {
            assert_eq!(result.unwrap(), 7);
        }
        assert_eq!(read(&legacy.definition), definition);
        #[cfg(unix)]
        assert_eq!(mode(&legacy.definition), 0o640);
        assert_eq!(read(&legacy.config), "HOST=127.0.0.1\n");
        assert_eq!(read(&token), "a".repeat(64));
        assert!(!backup.exists());
    }
}

#[test]
#[cfg(unix)]
fn refuses_symlinked_legacy_definitions_without_touching_the_target() {
    let home = home();
    let legacy = legacy_paths(ServicePlatform::Systemd, home.path());
    let target = home.path().join("other.service");
    std::fs::write(&target, "# Generated by herdr-gui service install.\n").unwrap();
    std::fs::create_dir_all(legacy.definition.parent().unwrap()).unwrap();
    std::os::unix::fs::symlink(&target, &legacy.definition).unwrap();
    for action in ["status", "restart", "reload", "uninstall"] {
        let runtime = Runtime::new("linux", home.path(), "/opt/roamgate");
        assert_eq!(
            service(&[action], &runtime, &Fake::new(never)).code(),
            1,
            "{action}"
        );
        assert!(read(&target).contains("Generated by herdr-gui"));
    }
}

// A Linux or macOS service manager, simulated over this machine's paths:
// its units name Unix paths a Windows home cannot give.
#[cfg(unix)]
#[test]
fn keeps_the_legacy_launchd_definition_on_query_errors_during_uninstall_or_reload() {
    let home = home();
    let legacy = legacy_paths(ServicePlatform::Launchd, home.path());
    write(
        &legacy.definition,
        &published_legacy_definition(
            ServicePlatform::Launchd,
            home.path(),
            Path::new("/opt/roamgate"),
        ),
    );
    for action in ["uninstall", "reload"] {
        let fake = Fake::new(|argv| match argv.get(2).map(String::as_str) {
            Some("gui/501/dev.roamgate") => 113,
            Some("gui/501/dev.herdr.herdr-gui") => 5,
            _ => 0,
        });
        let runtime = Runtime::new("darwin", home.path(), "/opt/roamgate").uid(501);
        assert_eq!(service(&[action], &runtime, &fake).code(), 5, "{action}");
        assert!(
            fake.argvs().iter().all(|argv| argv[1] == "print"),
            "{action}"
        );
        assert!(legacy.definition.exists());
    }
}

#[test]
fn refuses_an_installed_legacy_platform_definition_before_action_even_with_force() {
    for platform in ALL {
        for action in ["install", "restart", "reload"] {
            let home = home();
            let kind = platform_of(platform);
            let legacy = legacy_paths(kind, home.path());
            let current = paths(kind, home.path());
            write(&legacy.definition, "custom old definition");
            let fake = Fake::new(|_| 0);
            let runtime = Runtime::new(platform, home.path(), "/opt/roamgate").uid(501);
            let tail: &[&str] = if action == "install" {
                &["install", "--force"]
            } else {
                &[action]
            };
            let ran = service(tail, &runtime, &fake);
            let what = format!("{platform} {action}");
            assert_eq!(ran.code(), 1, "{what}");
            assert!(fake.argvs().is_empty(), "{what}");
            assert!(!current.config.exists(), "{what}");
            assert!(!current.definition.exists(), "{what}");
            assert_eq!(read(&legacy.definition), "custom old definition", "{what}");
            assert!(
                ran.error().contains("previous binary's service uninstall"),
                "{what}"
            );
        }
    }
}

#[test]
fn detects_loaded_legacy_platform_service_without_its_on_disk_definition() {
    for platform in ALL {
        let home = home();
        let fake = Fake::new(|_| 0);
        let runtime = Runtime::new(platform, home.path(), "/opt/roamgate").uid(501);
        assert_eq!(
            service(&["install", "--force"], &runtime, &fake).code(),
            1,
            "{platform}"
        );
        assert!(
            fake.argvs().last().unwrap().join(" ").contains("herdr-gui"),
            "{platform}"
        );
        assert!(!home.path().join(".config/roamgate").exists(), "{platform}");
    }
}

const ACTIVATIONS: [&[&str]; 4] = [
    &["install"],
    &["install", "--force"],
    &["restart"],
    &["reload"],
];

#[test]
fn launchd_query_error_blocks_args_with_existing_or_no_current_files() {
    for tail in ACTIVATIONS {
        for existing in [false, true] {
            for query_code in [1, 2, 5] {
                let home = home();
                let current = paths(ServicePlatform::Launchd, home.path());
                let files = [
                    current.definition.clone(),
                    current.config.clone(),
                    token_path(&current),
                ];
                if existing {
                    for path in &files {
                        write(path, "preserve this fixture");
                        #[cfg(unix)]
                        chmod(path, 0o600);
                    }
                }
                let fake = Fake::new(move |argv| {
                    if argv.get(2).map(String::as_str) == Some("gui/501/dev.herdr.herdr-gui") {
                        query_code
                    } else {
                        0
                    }
                });
                let runtime = Runtime::new("darwin", home.path(), "/opt/roamgate").uid(501);
                let ran = service(tail, &runtime, &fake);
                let what = format!("{tail:?} existing={existing} code={query_code}");
                assert_eq!(ran.code(), 1, "{what}");
                assert_eq!(
                    fake.argvs(),
                    vec![
                        args(&["launchctl", "print", "gui/501"]),
                        args(&["launchctl", "print", "gui/501/dev.herdr.herdr-gui"]),
                    ],
                    "{what}"
                );
                assert!(
                    ran.error().contains(&format!(
                        "cannot check legacy launchd service (exit {query_code}); no service changes made"
                    )),
                    "{what}"
                );
                for path in &files {
                    assert_eq!(path.exists(), existing, "{what}");
                    if existing {
                        assert_eq!(read(path), "preserve this fixture", "{what}");
                        #[cfg(unix)]
                        assert_eq!(mode(path), 0o600, "{what}");
                    }
                }
            }
        }
    }
}

#[test]
fn confirmed_launchd_legacy_absence_permits_args() {
    for tail in ACTIVATIONS {
        let home = home();
        let current = paths(ServicePlatform::Launchd, home.path());
        write(
            &current.definition,
            &render_launchd_service("/opt/roamgate", &current),
        );
        let fake = Fake::new(|argv| {
            if argv.get(2).map(String::as_str) == Some("gui/501/dev.herdr.herdr-gui") {
                113
            } else {
                0
            }
        });
        let runtime = Runtime::new("darwin", home.path(), "/opt/roamgate").uid(501);
        let ran = service(tail, &runtime, &fake);
        assert_eq!(ran.code(), 0, "{tail:?}: {:?}", ran.errors);
        let argvs = fake.argvs();
        assert_eq!(
            argvs[..2],
            [
                args(&["launchctl", "print", "gui/501"]),
                args(&["launchctl", "print", "gui/501/dev.herdr.herdr-gui"]),
            ],
            "{tail:?}"
        );
        let last = if tail[0] == "restart" {
            "kickstart"
        } else {
            "bootstrap"
        };
        assert_eq!(argvs.last().unwrap()[1], last, "{tail:?}");
    }
}

#[test]
fn missing_launchd_domain_blocks_args_before_the_service_query() {
    for tail in ACTIVATIONS {
        let home = home();
        let fake = Fake::new(|_| 113);
        let runtime = Runtime::new("darwin", home.path(), "/opt/roamgate").uid(501);
        let ran = service(tail, &runtime, &fake);
        assert_eq!(ran.code(), 1, "{tail:?}");
        assert_eq!(fake.argvs(), vec![args(&["launchctl", "print", "gui/501"])]);
        assert!(ran.error().contains("cannot check launchd user domain"));
        let current = paths(ServicePlatform::Launchd, home.path());
        assert!(!current.config.exists());
        assert!(!current.definition.exists());
    }
}

#[test]
fn unknown_legacy_windows_query_errors_refuse_activation_without_replacing_files() {
    let home = home();
    let runtime = Runtime::new("win32", home.path(), "/opt/roamgate");
    let ran = service(&["install", "--force"], &runtime, &Fake::new(|_| 1));
    assert_eq!(ran.code(), 1);
    assert!(ran.error().contains("cannot check legacy scheduled task"));
    assert!(
        !paths(ServicePlatform::WindowsTask, home.path())
            .config
            .exists()
    );
}

#[test]
fn legacy_windows_task_hash_stays_tied_to_its_old_per_user_config_directory() {
    let home = home();
    let old = legacy_paths(ServicePlatform::WindowsTask, home.path())
        .task_name
        .unwrap();
    let current = paths(ServicePlatform::WindowsTask, home.path())
        .task_name
        .unwrap();
    assert!(old.starts_with("dev.herdr.herdr-gui-"));
    assert!(current.starts_with("dev.roamgate-"));
    assert_ne!(old.rsplit('-').next(), current.rsplit('-').next());
}

#[test]
#[cfg(unix)]
fn after_explicit_legacy_removal_install_preserves_old_env_and_token() {
    let home = home();
    let legacy = legacy_paths(ServicePlatform::Systemd, home.path());
    let current = paths(ServicePlatform::Systemd, home.path());
    write(
        &legacy.config,
        "HOST=0.0.0.0\nPORT=8899\nHERDR_GUI_LOG_LEVEL=debug\n",
    );
    chmod(legacy.config.parent().unwrap(), 0o700);
    chmod(&legacy.config, 0o600);
    let token = "a".repeat(64);
    let legacy_token = dirname(&legacy.config).join("auth-token");
    std::fs::write(&legacy_token, format!("{token}\n")).unwrap();
    chmod(&legacy_token, 0o600);
    let fake = Fake::new(|argv| if has(argv, "herdr-gui.service") { 4 } else { 0 });
    let runtime = Runtime::new("linux", home.path(), "/opt/roamgate");
    assert_eq!(service(&["install"], &runtime, &fake).code(), 0);
    let argvs = fake.argvs();
    assert_eq!(
        argvs[0],
        args(&[
            "systemctl",
            "--user",
            "--no-pager",
            "status",
            "herdr-gui.service"
        ])
    );
    assert_eq!(
        argvs.last().unwrap(),
        &args(&["systemctl", "--user", "restart", "roamgate.service"])
    );
    assert_eq!(read(&current.config), read(&legacy.config));
    assert_eq!(read(&token_path(&current)), format!("{token}\n"));
    assert_eq!(read(&legacy_token), format!("{token}\n"));
}

#[test]
fn service_run_honors_explicit_new_and_legacy_supervisor_overrides() {
    let home = home();
    let config = home.path().join("roamgate.env");
    let path = text(&config);
    let none = BTreeMap::<String, String>::new();
    std::fs::write(&config, "HERDR_GUI_RESTART_SUPERVISOR=0\n").unwrap();
    let environment = service_run_environment(&path, &none).unwrap();
    assert!(!environment.supervisor);
    assert_eq!(environment.entries["HERDR_GUI_RESTART_SUPERVISOR"], "0");
    std::fs::write(
        &config,
        "HERDR_GUI_RESTART_SUPERVISOR=1\nROAMGATE_RESTART_SUPERVISOR=\n",
    )
    .unwrap();
    let environment = service_run_environment(&path, &none).unwrap();
    assert!(!environment.supervisor);
    assert_eq!(environment.entries["ROAMGATE_RESTART_SUPERVISOR"], "");
    // A setting already in the environment counts too.
    std::fs::write(&config, "HOST=127.0.0.1\n").unwrap();
    let set = BTreeMap::from([("HERDR_GUI_RESTART_SUPERVISOR".to_owned(), "0".to_owned())]);
    assert!(!service_run_environment(&path, &set).unwrap().supervisor);
    assert!(service_run_environment(&path, &none).unwrap().supervisor);
}

#[test]
fn rejects_an_invalid_service_pin_before_installation() {
    for pin in ["12345", "1234567890123", "12345a"] {
        let home = home();
        let current = paths(ServicePlatform::Systemd, home.path());
        let contents =
            format!("HOST=127.0.0.1\nROAMGATE_PASSWORD=strong-test-password\nROAMGATE_PIN={pin}\n");
        write(&current.config, &contents);
        let fake = Fake::without_legacy(|_| 0);
        let runtime = Runtime::new("linux", home.path(), "/opt/roamgate");
        let ran = service(&["install"], &runtime, &fake);
        assert_eq!(ran.code(), 1, "{pin}");
        assert!(fake.argvs().is_empty(), "{pin}");
        assert!(ran.error().contains("6 to 12 ASCII digits"), "{pin}");
        assert!(!ran.error().contains(pin), "{pin}");
        assert_eq!(read(&current.config), contents);
        assert!(!current.definition.exists());
    }
}

#[test]
fn reports_a_published_legacy_service_that_service_commands_manage() {
    let home = home();
    let exec = home.path().join("roamgate");
    let legacy = legacy_paths(ServicePlatform::Systemd, home.path());
    write(
        &legacy.definition,
        &published_legacy_definition(ServicePlatform::Systemd, home.path(), &exec),
    );
    let fake = Fake::new(|_| 0);
    let runtime = Runtime::new("linux", home.path(), &exec);
    let status = roamgate_service_status(&runtime.service(), &fake).unwrap();
    assert!(status.installed && status.active);
    assert_eq!(status.definition, legacy.definition);
    assert_eq!(
        fake.argvs(),
        vec![args(&[
            "systemctl",
            "--user",
            "is-active",
            "--quiet",
            "herdr-gui.service"
        ])]
    );
}

#[test]
fn ignores_a_customized_legacy_definition() {
    let home = home();
    let legacy = legacy_paths(ServicePlatform::Systemd, home.path());
    write(&legacy.definition, "[Service]\nExecStart=/custom\n");
    let runtime = Runtime::new("linux", home.path(), home.path().join("roamgate"));
    let status = roamgate_service_status(&runtime.service(), &Fake::new(|_| 0)).unwrap();
    assert!(!status.installed);
    assert_eq!(
        status.definition,
        paths(ServicePlatform::Systemd, home.path()).definition
    );
}

/// The command's help and its parse errors, as runServiceCommand prints them.
#[test]
fn prints_help_and_refuses_unknown_actions_and_options() {
    let home = home();
    let runtime = Runtime::new("linux", home.path(), "/opt/roamgate");
    for tail in [&[][..], &["help"], &["install", "--help"], &["-h"]] {
        let ran = service(tail, &runtime, &Fake::new(never));
        assert_eq!(ran.code(), 0);
        assert_eq!(ran.log(), command_help("service"));
    }
    for (tail, message) in [
        (&["nope"][..], "unknown service action: nope"),
        (&["status", "--x"], "unknown service option: --x"),
        (
            &["status", "--force"],
            "--force is only valid with `service install`",
        ),
        (
            &["run"],
            "internal service run requires one environment file",
        ),
        (
            &["run", "a", "b"],
            "internal service run requires one environment file",
        ),
    ] {
        let ran = service(tail, &runtime, &Fake::new(never));
        assert_eq!(ran.code(), 1);
        assert_eq!(
            ran.errors,
            vec![
                format!("roamgate service: {message}"),
                "Run `roamgate service --help` for usage.".to_owned(),
            ]
        );
    }
}
