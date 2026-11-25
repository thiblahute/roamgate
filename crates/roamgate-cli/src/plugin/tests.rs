//! config/plugin-command.test.ts, and data-paths.test.ts's plugin URL row.

use std::path::Path;
#[cfg(unix)]
use std::sync::Arc;

use super::*;
use crate::context::testing::{TestCli, test_runtime};

const TOKEN: &str = "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd";

/// A runtime whose service directory holds `files`.
fn fixture(home: &Path, files: &[(&str, &str)]) -> CliRuntime {
    let dir = home.join(".config/roamgate");
    std::fs::create_dir_all(&dir).unwrap();
    for (name, text) in files {
        std::fs::write(dir.join(name), text).unwrap();
    }
    test_runtime(home)
}

#[test]
fn matches_roamgate_url_including_defaults_and_the_login_token() {
    let home = tempfile::tempdir().unwrap();
    assert_eq!(
        service_login_url(&fixture(home.path(), &[])).unwrap(),
        "http://localhost:8787"
    );
    let home = tempfile::tempdir().unwrap();
    let runtime = fixture(
        home.path(),
        &[
            ("roamgate.env", "HOST=0.0.0.0\nPORT=8791\n"),
            ("auth-token", &format!("{TOKEN}\n")),
        ],
    );
    assert_eq!(
        service_login_url(&runtime).unwrap(),
        format!("http://localhost:8791/?token={TOKEN}")
    );
}

#[test]
fn new_password_values_take_precedence_including_empty_values() {
    let home = tempfile::tempdir().unwrap();
    let runtime = fixture(
        home.path(),
        &[
            (
                "roamgate.env",
                "HERDR_GUI_PASSWORD=old-password-value\nROAMGATE_PASSWORD=new-password-value\n",
            ),
            ("auth-token", &format!("{TOKEN}\n")),
        ],
    );
    assert_eq!(
        service_login_url(&runtime).unwrap(),
        "http://localhost:8787"
    );
    std::fs::write(
        home.path().join(".config/roamgate/roamgate.env"),
        "HERDR_GUI_PASSWORD=old-password-value\nROAMGATE_PASSWORD=\n",
    )
    .unwrap();
    assert_eq!(
        service_login_url(&runtime).unwrap(),
        format!("http://localhost:8787/?token={TOKEN}")
    );
}

#[test]
fn honors_exported_and_quoted_entries_and_native_tls() {
    let home = tempfile::tempdir().unwrap();
    let runtime = fixture(
        home.path(),
        &[("roamgate.env", "export HOST=\"0.0.0.0\"\nPORT = \"8799\"\n")],
    );
    assert_eq!(
        service_login_url(&runtime).unwrap(),
        "http://localhost:8799"
    );
}

#[test]
fn rejects_configurations_the_service_could_not_start_with() {
    let home = tempfile::tempdir().unwrap();
    let error =
        service_login_url(&fixture(home.path(), &[("roamgate.env", "PORT=0\n")])).unwrap_err();
    assert!(error.contains("invalid PORT"), "{error}");
}

fn argv(list: &[&str]) -> Vec<String> {
    list.iter().map(|arg| (*arg).to_owned()).collect()
}

#[tokio::test]
async fn plugin_dispatch_rejects_extra_arguments_and_leaves_other_cli_commands_alone() {
    let cli = TestCli::with_runtime(
        |runtime| runtime.version = "9.8.7".into(),
        |_| None,
        |_| None,
    );
    assert_eq!(
        run_plugin(&argv(&["restart", "--force"]), &cli.context).await,
        1
    );
    assert_eq!(cli.errors(), [USAGE]);
    assert_eq!(run_plugin(&argv(&["version"]), &cli.context).await, 0);
    assert_eq!(cli.output(), ["roamgate 9.8.7"]);
    // Only `plugin` reaches it: help and no action print the usage, exit 0.
    assert_eq!(run_plugin(&argv(&["--help"]), &cli.context).await, 0);
    assert_eq!(run_plugin(&[], &cli.context).await, 0);
    assert_eq!(run_plugin(&argv(&["nope"]), &cli.context).await, 1);
    assert!(cli.commands().is_empty());
}

/// The verbs run `<binary> service ...` and give back its exit code; the
/// service command (service_manager's own tests) keeps or replaces the
/// definition, and nothing here touches the configuration or the token.
#[cfg(unix)]
#[tokio::test]
async fn native_verb_preserves_configuration_for_a_definition_type_service_with_exit_exit_code() {
    use std::os::unix::fs::PermissionsExt;
    for (verb, exit_code, args) in [
        ("start", 0, "service install --force"),
        ("restart", 0, "service install"),
        ("restart", 23, "service install"),
        ("restart", 1, "service install"),
        ("status", 4, "service status"),
        ("uninstall", 0, "service uninstall"),
    ] {
        let root = tempfile::tempdir().unwrap();
        let home = root.path().join("home");
        let config_dir = home.join(".config/roamgate");
        std::fs::create_dir_all(&config_dir).unwrap();
        let config = "HOST=127.0.0.1\nPORT=8799\n";
        let token = "a".repeat(64);
        std::fs::write(config_dir.join("roamgate.env"), config).unwrap();
        std::fs::write(config_dir.join("auth-token"), &token).unwrap();
        let log = root.path().join("service.log");
        let binary = root.path().join("roamgate");
        std::fs::write(
            &binary,
            format!(
                "#!/bin/sh\nprintf '%s\\n' \"$*\" >> '{}'\nexit {exit_code}\n",
                log.display()
            ),
        )
        .unwrap();
        std::fs::set_permissions(&binary, std::fs::Permissions::from_mode(0o755)).unwrap();
        let mut runtime = test_runtime(&home);
        runtime.exec_path = binary;
        let context = CliContext {
            runtime,
            run: Arc::new(roamgate_exec::service::fake::Recorder::new(|_| 0)),
            console: crate::context::Console::recorded(),
        };
        assert_eq!(
            run_plugin(&argv(&[verb]), &context).await,
            exit_code,
            "{verb}"
        );
        assert_eq!(std::fs::read_to_string(&log).unwrap(), format!("{args}\n"));
        assert_eq!(
            std::fs::read_to_string(config_dir.join("roamgate.env")).unwrap(),
            config
        );
        assert_eq!(
            std::fs::read_to_string(config_dir.join("auth-token")).unwrap(),
            token
        );
    }
}

/// data-paths.test.ts: the plugin's URL reads the herdr-gui files without
/// migrating them, and prefers the new ones once they exist.
#[test]
fn plugin_url_reads_legacy_files_without_migrating_and_prefers_new_paths() {
    for platform in ["linux", "win32"] {
        let home = tempfile::tempdir().unwrap();
        let app_data = home.path().join("AppData").join("Roaming");
        let (legacy, current) = if platform == "win32" {
            (app_data.join("herdr-gui"), app_data.join("roamgate"))
        } else {
            (
                home.path().join(".config/herdr-gui"),
                home.path().join(".config/roamgate"),
            )
        };
        std::fs::create_dir_all(&legacy).unwrap();
        std::fs::write(legacy.join("herdr-gui.env"), "HOST=0.0.0.0\nPORT=8890\n").unwrap();
        std::fs::write(legacy.join("auth-token"), format!("{}\n", "c".repeat(64))).unwrap();
        let mut runtime = test_runtime(home.path());
        runtime.platform = platform.into();
        runtime.app_data = Some(app_data.clone());
        assert_eq!(
            service_login_url(&runtime).unwrap(),
            format!("http://localhost:8890/?token={}", "c".repeat(64)),
            "{platform}"
        );
        assert!(!current.exists());
        std::fs::create_dir_all(&current).unwrap();
        std::fs::write(current.join("roamgate.env"), "HOST=127.0.0.1\nPORT=8891\n").unwrap();
        assert_eq!(
            service_login_url(&runtime).unwrap(),
            format!("http://localhost:8891/?token={}", "c".repeat(64))
        );
        assert_eq!(
            std::fs::read_to_string(legacy.join("herdr-gui.env")).unwrap(),
            "HOST=0.0.0.0\nPORT=8890\n"
        );
    }
}
