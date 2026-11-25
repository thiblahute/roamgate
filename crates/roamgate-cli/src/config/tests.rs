//! cli/config.test.ts.

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use roamgate_exec::service::ServicePlatform;
use serde_json::Value;

use super::*;
use crate::args::EXIT_USAGE;
use crate::context::testing::TestCli;
use crate::service::DEFAULT_SERVICE_ENV_FILE;

fn update(contents: &str, entries: &[(&str, Option<&str>)]) -> String {
    let updates: Updates = entries
        .iter()
        .map(|(key, value)| ((*key).to_owned(), value.map(str::to_owned)))
        .collect();
    update_environment_file(contents, &updates).unwrap()
}

#[test]
fn replaces_the_last_assignment_and_drops_earlier_duplicates() {
    assert_eq!(
        update("A=1\n# note\nexport A=2\nB=3\n", &[("A", Some("4"))]),
        "# note\nA=4\nB=3\n"
    );
}

#[test]
fn inserts_below_a_commented_placeholder_else_appends() {
    assert_eq!(
        update("# A=example\nB=1\n", &[("A", Some("x"))]),
        "# A=example\nA=x\nB=1\n"
    );
    assert_eq!(update("B=1", &[("A", Some("x"))]), "B=1\nA=x\n");
}

#[test]
fn removes_every_assignment_on_unset_and_keeps_comments() {
    assert_eq!(
        update("# A=example\nA=1\nB=2\nA=3\n", &[("A", None)]),
        "# A=example\nB=2\n"
    );
}

#[test]
fn keeps_crlf_line_endings() {
    assert_eq!(
        update("A=1\r\nB=2\r\n", &[("B", Some("3"))]),
        "A=1\r\nB=3\r\n"
    );
}

#[test]
fn leaves_similarly_named_keys_alone() {
    assert_eq!(
        update("PORTAL=1\n", &[("PORT", Some("2"))]),
        "PORTAL=1\nPORT=2\n"
    );
}

#[test]
fn quotes_only_when_needed() {
    assert_eq!(encode_environment_value("/a/b.pem").unwrap(), "/a/b.pem");
    assert_eq!(encode_environment_value("").unwrap(), "''");
    assert_eq!(encode_environment_value("a b$c").unwrap(), "'a b$c'");
    assert_eq!(
        encode_environment_value("C:\\Users\\me").unwrap(),
        "'C:\\Users\\me'"
    );
}

#[test]
fn every_service_manager_reads_back_exactly_the_value_written() {
    for value in [
        "plain",
        "two words",
        "it's my long passphrase",
        "$HOME and `cmd`",
        "C:\\Program Files\\x",
        "",
    ] {
        let line = format!("KEY={}\n", encode_environment_value(value).unwrap());
        for platform in [
            ServicePlatform::Systemd,
            ServicePlatform::Launchd,
            ServicePlatform::WindowsTask,
        ] {
            let env = parse_service_environment(&line, "/env", platform, "/home/me").unwrap();
            assert_eq!(env["KEY"], value, "{platform:?} {line}");
        }
    }
    assert_eq!(encode_environment_value("it's").unwrap(), "\"it's\"");
}

#[test]
fn rejects_values_no_service_manager_reads_identically() {
    assert!(
        encode_environment_value("a\nb")
            .unwrap_err()
            .contains("single line")
    );
    assert!(
        encode_environment_value("it's $HOME")
            .unwrap_err()
            .contains("edit the file directly")
    );
}

fn read(path: &PathBuf) -> String {
    std::fs::read_to_string(path).unwrap()
}

#[tokio::test]
async fn set_creates_the_file_from_the_template_with_private_permissions() {
    let cli = TestCli::new();
    assert_eq!(
        cli.run_cli(&["config", "set", "PORT=9123", "HOST=127.0.0.1"])
            .await,
        EXIT_OK
    );
    let contents = read(&cli.config_path);
    assert!(
        contents.contains("HOST=127.0.0.1\nPORT=9123\n"),
        "{contents}"
    );
    assert!(contents.contains("# ROAMGATE_PASSWORD="));
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = std::fs::metadata(&cli.config_path)
            .unwrap()
            .permissions()
            .mode();
        assert_eq!(mode & 0o777, 0o600);
    }
    assert_eq!(
        cli.output(),
        [format!(
            "Updated {}",
            cli.shown(".config/roamgate/roamgate.env")
        )]
    );
}

#[tokio::test]
async fn rejects_invalid_values_before_writing_anything() {
    let cli = TestCli::new();
    assert_eq!(
        cli.run_cli(&["config", "set", "PORT=70000"]).await,
        EXIT_USAGE
    );
    assert!(cli.errors()[0].contains("PORT: must be a port number"));
    assert_eq!(
        cli.run_cli(&["config", "set", "ROAMGATE_PASSWORD=short"])
            .await,
        EXIT_USAGE
    );
    assert_eq!(cli.run_cli(&["config", "set", "NOPE=1"]).await, EXIT_USAGE);
    assert!(!cli.config_path.exists());
    assert_eq!(
        cli.errors(),
        [
            "roamgate config: PORT: must be a port number from 1 to 65535",
            "Run `roamgate config --help` for usage.",
            "Warning: ROAMGATE_PASSWORD on the command line can be saved in shell history; prefer ROAMGATE_PASSWORD=-",
            "roamgate config: ROAMGATE_PASSWORD: Login password must contain at least 8 characters and at most 1024 characters (--password or ROAMGATE_PASSWORD).",
            "Run `roamgate config --help` for usage.",
            "roamgate config: unknown setting: NOPE (run `roamgate config show` for the list; edit the file directly for other variables)",
            "Run `roamgate config --help` for usage.",
        ]
    );
}

#[tokio::test]
async fn validates_the_whole_file_so_tls_halves_must_be_set_together() {
    let cli = TestCli::new();
    assert_eq!(
        // An absolute path (a drive's on Windows) to no file.
        cli.run_cli(&[
            "config",
            "set",
            if cfg!(windows) {
                r"ROAMGATE_TLS_CERT=C:\missing.pem"
            } else {
                "ROAMGATE_TLS_CERT=/missing.pem"
            }
        ])
        .await,
        EXIT_FAILURE
    );
    assert!(cli.errors()[0].contains("TLS requires both"));
    assert!(!cli.config_path.exists());
}

#[tokio::test]
async fn writes_roamgate_names_and_removes_legacy_aliases() {
    let cli = TestCli::new();
    cli.write_config("HERDR_GUI_LOG_LEVEL=warn\n");
    assert_eq!(
        cli.run_cli(&["config", "set", "HERDR_GUI_LOG_LEVEL=debug"])
            .await,
        EXIT_OK
    );
    assert_eq!(read(&cli.config_path), "ROAMGATE_LOG_LEVEL=debug\n");
    assert_eq!(
        cli.run_cli(&["config", "unset", "ROAMGATE_LOG_LEVEL"])
            .await,
        EXIT_OK
    );
    assert_eq!(read(&cli.config_path), "");
}

#[tokio::test]
async fn get_prints_effective_values_and_fallbacks() {
    let cli = TestCli::new();
    cli.write_config("PORT=9000\nHERDR_GUI_PIN=123456\n");
    cli.run_cli(&["config", "get", "PORT"]).await;
    cli.run_cli(&["config", "get", "ROAMGATE_PIN"]).await;
    cli.run_cli(&["config", "get", "ROAMGATE_LOG_LEVEL"]).await;
    assert_eq!(cli.output(), ["9000", "123456", "info"]);
    assert_eq!(
        cli.run_cli(&["config", "get", "HERDR_SSH_HOST"]).await,
        EXIT_FAILURE
    );
}

#[tokio::test]
async fn show_hides_secrets_unless_revealed() {
    let cli = TestCli::new();
    cli.write_config("ROAMGATE_PASSWORD=correct-horse-battery\nCUSTOM=1\nANOTHER=2\n");
    cli.run_cli(&["config", "show", "--json"]).await;
    let shown: Value = serde_json::from_str(&cli.output().join("\n")).unwrap();
    assert_eq!(
        shown["settings"]["ROAMGATE_PASSWORD"],
        serde_json::json!({"value": "(hidden)", "source": "file"})
    );
    assert_eq!(
        shown["settings"]["HOST"],
        serde_json::json!({"value": "127.0.0.1", "source": "default"})
    );
    assert_eq!(
        shown["settings"]["HERDR_SESSION"],
        serde_json::json!({"value": null, "source": "unset"})
    );
    assert_eq!(shown["other"], serde_json::json!(["CUSTOM", "ANOTHER"]));
    let before = cli.output().len();
    cli.run_cli(&["config", "show", "--json", "--reveal"]).await;
    let revealed: Value = serde_json::from_str(&cli.output()[before..].join("\n")).unwrap();
    assert_eq!(
        revealed["settings"]["ROAMGATE_PASSWORD"]["value"],
        "correct-horse-battery"
    );
    assert_eq!(
        revealed["other"],
        serde_json::json!({"CUSTOM": "1", "ANOTHER": "2"})
    );
}

#[tokio::test]
async fn set_restart_restarts_only_a_running_service() {
    let cli = TestCli::with(|_| Some(0), |_| None);
    cli.write_config(DEFAULT_SERVICE_ENV_FILE);
    // No service definition exists, so nothing is restarted.
    assert_eq!(
        cli.run_cli(&["config", "set", "PORT=9001", "--restart"])
            .await,
        EXIT_OK
    );
    assert!(cli.commands().is_empty());
    assert!(cli.output().last().unwrap().contains("not running"));
}

#[tokio::test]
async fn existing_values_the_server_accepts_never_block_unrelated_changes() {
    let cli = TestCli::new();
    cli.write_config("ROAMGATE_WEB_PUSH_PATH=web-push.json\nHOST=my host\n");
    assert_eq!(cli.run_cli(&["config", "set", "PORT=9000"]).await, EXIT_OK);
    assert!(read(&cli.config_path).contains("PORT=9000"));
    // Settings the server refuses to start with are still always checked.
    cli.write_config("ROAMGATE_LOG_LEVEL=loud\n");
    assert_eq!(
        cli.run_cli(&["config", "set", "PORT=9001"]).await,
        EXIT_FAILURE
    );
    assert!(cli.errors().last().unwrap().contains("ROAMGATE_LOG_LEVEL"));
}

/// A TestCli whose `fake-editor` writes what `script` holds then.
fn editor_cli(script: Arc<Mutex<Option<String>>>, only_fake: bool) -> TestCli {
    let config: Arc<Mutex<Option<PathBuf>>> = Arc::default();
    let seen = config.clone();
    let cli = TestCli::with_runtime(
        |runtime| {
            runtime.env = Arc::new(BTreeMap::from([(
                "EDITOR".to_owned(),
                "fake-editor".to_owned(),
            )]));
        },
        move |argv| {
            if only_fake && argv[0] != "fake-editor" {
                return Some(4);
            }
            let path = seen.lock().unwrap().clone().unwrap();
            if let Some(text) = script.lock().unwrap().clone() {
                std::fs::write(path, text).unwrap();
            }
            Some(0)
        },
        |_| None,
    );
    *config.lock().unwrap() = Some(cli.config_path.clone());
    cli
}

#[tokio::test]
async fn path_and_edit_still_work_when_the_file_cannot_be_parsed() {
    let script: Arc<Mutex<Option<String>>> = Arc::default();
    let cli = editor_cli(script.clone(), true);
    cli.write_config("this is not an assignment\n");
    assert_eq!(cli.run_cli(&["config", "path"]).await, EXIT_OK);
    assert_eq!(
        cli.output().last().unwrap(),
        &cli.config_path.display().to_string()
    );
    assert_eq!(cli.run_cli(&["config", "show"]).await, EXIT_FAILURE);

    // Saving a still-broken file is reported with guidance, not failed.
    *script.lock().unwrap() = Some("still broken\n".into());
    assert_eq!(cli.run_cli(&["config", "edit"]).await, EXIT_FAILURE);
    let errors = cli.errors();
    assert!(errors[errors.len() - 2].contains("the edited file is invalid"));
    assert!(errors[errors.len() - 1].contains("roamgate config edit"));

    *script.lock().unwrap() = Some("PORT=9002\n".into());
    assert_eq!(cli.run_cli(&["config", "edit"]).await, EXIT_OK);
    assert_eq!(
        cli.commands()[0],
        [
            "fake-editor".to_owned(),
            cli.config_path.display().to_string()
        ]
    );
}

#[tokio::test]
async fn edit_applies_strict_checks_only_to_settings_that_changed() {
    let script = Arc::new(Mutex::new(Some(
        "HOST=my host\nROAMGATE_WEB_PUSH_PATH=relative.json\n".to_owned(),
    )));
    let cli = editor_cli(script, false);
    cli.write_config("HOST=my host\n");
    assert_eq!(cli.run_cli(&["config", "edit"]).await, EXIT_FAILURE);
    let errors = cli.errors();
    assert!(errors[errors.len() - 2].contains("ROAMGATE_WEB_PUSH_PATH"));
}

#[tokio::test]
async fn help_and_unknown_actions() {
    let cli = TestCli::new();
    assert_eq!(run(&[], &cli.context).await, Ok(Outcome::Code(EXIT_OK)));
    assert_eq!(
        cli.output().join("\n") + "\n",
        include_str!("../../../../contract/cli/help/config.txt")
    );
    assert_eq!(cli.run_cli(&["config", "frobnicate"]).await, EXIT_USAGE);
}
