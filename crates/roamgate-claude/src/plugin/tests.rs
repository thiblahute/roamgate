//! The Claude mod plugin's install (the TS suite was
//! server/src/agent/claude-mod-plugin.test.ts).

use std::os::unix::fs::PermissionsExt;
use std::process::Command;

use serde_json::{Value, json};

use super::*;

#[test]
fn the_binary_carries_the_mod_its_tests_left_out() {
    let mut paths: Vec<&str> = CLAUDE_MOD_FILES.iter().map(|(p, _)| p.as_str()).collect();
    paths.sort();
    assert_eq!(
        paths,
        [
            ".claude-plugin/marketplace.json",
            "roamgate/.claude-plugin/plugin.json",
            "roamgate/hooks/catalog.gen.ts",
            "roamgate/hooks/client.ts",
            "roamgate/hooks/hooks.json",
            "roamgate/hooks/register.ts",
            "roamgate/hooks/tools.ts",
        ]
    );
    let manifest: Value =
        serde_json::from_str(claude_mod_file("roamgate/.claude-plugin/plugin.json").unwrap())
            .unwrap();
    assert_eq!(manifest["name"], "roamgate");
    let hooks: Value =
        serde_json::from_str(claude_mod_file("roamgate/hooks/hooks.json").unwrap()).unwrap();
    assert_eq!(hooks["modules"], json!(["./register.ts"]));
}

#[test]
fn the_marketplace_is_written_once_per_version() {
    let home = tempfile::tempdir().unwrap();
    assert!(write_claude_mod_plugin(home.path()).unwrap());
    let base = home.path().join(CLAUDE_MOD_MARKETPLACE_DIR);
    assert_eq!(
        std::fs::read_to_string(base.join("roamgate/hooks/register.ts")).unwrap(),
        claude_mod_file("roamgate/hooks/register.ts").unwrap()
    );
    let mode = std::fs::metadata(base.join("roamgate/hooks/client.ts"))
        .unwrap()
        .permissions()
        .mode();
    assert_eq!(mode & 0o777, 0o644);
    assert!(!write_claude_mod_plugin(home.path()).unwrap());
    std::fs::write(base.join(".roamgate-checksum"), "older\n").unwrap();
    assert!(write_claude_mod_plugin(home.path()).unwrap());
}

#[test]
fn an_ssh_host_gets_the_same_files() {
    let home = tempfile::tempdir().unwrap();
    let script = ["set -e".to_owned()]
        .into_iter()
        .chain(remote_claude_mod_script())
        .collect::<Vec<_>>()
        .join("\n");
    let status = Command::new("/bin/sh")
        .args(["-c", &script])
        .env_clear()
        .env("HOME", home.path())
        .env("PATH", std::env::var("PATH").unwrap_or_default())
        .status()
        .unwrap();
    assert!(status.success());
    let base = home.path().join(CLAUDE_MOD_MARKETPLACE_DIR);
    for (path, text) in CLAUDE_MOD_FILES.iter() {
        assert_eq!(&std::fs::read_to_string(base.join(path)).unwrap(), text);
    }
    assert_eq!(
        std::fs::read_to_string(base.join(".roamgate-checksum"))
            .unwrap()
            .trim(),
        CLAUDE_MOD_CHECKSUM.as_str()
    );
}

#[test]
fn versions_compare_by_their_numbers() {
    assert!(compare_versions("2.1.280", "2.1.304") < 0);
    assert!(compare_versions("2.1.319 (Claude Code)", "2.1.304") > 0);
    assert_eq!(compare_versions("2.1.304", "2.1.304"), 0);
    assert!(compare_versions("2.2.0", "2.1.999") > 0);
}

struct HostRun {
    output: String,
    calls: Vec<String>,
    home: tempfile::TempDir,
}

/// Runs the host script with a fake `claude` that records its arguments.
fn host_run(action: ClaudeModAction, claude: Option<(&str, &str, i32)>) -> HostRun {
    let home = tempfile::tempdir().unwrap();
    let bin = home.path().join("bin");
    std::fs::create_dir(&bin).unwrap();
    let calls = home.path().join("calls");
    if let Some((version, list, exit)) = claude {
        std::fs::write(
            bin.join("claude"),
            [
                "#!/bin/sh".to_owned(),
                format!("echo \"$*\" >> '{}'", calls.display()),
                "case \"$1 $2\" in".to_owned(),
                format!("  \"--version \") echo '{version}' ;;"),
                format!("  \"plugin list\") echo '{list}' ;;"),
                format!("  \"plugin install\") echo '{{\"ok\":false,\"error\":\"boom\"}}'; exit {exit} ;;"),
                "esac".to_owned(),
            ]
            .join("\n"),
        )
        .unwrap();
        std::fs::set_permissions(bin.join("claude"), std::fs::Permissions::from_mode(0o755))
            .unwrap();
    }
    let output = Command::new("/bin/sh")
        .args(["-c", &claude_mod_host_script(action)])
        .env_clear()
        .env("HOME", home.path())
        .env("PATH", format!("{}:/usr/bin:/bin", bin.display()))
        .output()
        .unwrap();
    let recorded = std::fs::read_to_string(&calls).unwrap_or_default();
    HostRun {
        output: String::from_utf8(output.stdout).unwrap(),
        calls: recorded.trim().split('\n').map(str::to_owned).collect(),
        home,
    }
}

#[test]
fn the_state_of_a_host_without_claude_or_with_an_old_one() {
    let none = host_run(ClaudeModAction::Status, None);
    let state = claude_mod_state_of(&none.output, 0);
    assert_eq!(state["available"], false);
    assert_eq!(state["reason"], "Claude Code was not found on this host");
    let old = host_run(
        ClaudeModAction::Status,
        Some(("2.1.280 (Claude Code)", "[]", 0)),
    );
    let state = claude_mod_state_of(&old.output, 0);
    assert_eq!(state["available"], false);
    assert_eq!(state["claude_version"], "2.1.280");
    assert_eq!(state["installed"], false);
}

#[test]
fn installed_from_roamgates_folder_and_enabled() {
    let listed = serde_json::to_string(&json!([
        {"id": "other@x", "scope": "user", "enabled": true},
        {"id": "roamgate@roamgate", "scope": "user", "enabled": true,
         "readFromFolder": "/home/u/.cache/roamgate/claude-plugins/roamgate"},
    ]))
    .unwrap();
    let run = host_run(
        ClaudeModAction::Status,
        Some(("2.1.319 (Claude Code)", &listed, 0)),
    );
    let state = claude_mod_state_of(&run.output, 2);
    assert_eq!(
        state,
        json!({
            "available": true,
            "claude_version": "2.1.319",
            "min_claude": "2.1.304",
            "installed": true,
            "enabled": true,
            "from_roamgate": true,
            "sessions": 2,
        })
    );
}

#[test]
fn install_runs_claude_codes_own_plugin_command() {
    let run = host_run(
        ClaudeModAction::Install,
        Some(("2.1.319 (Claude Code)", "[]", 0)),
    );
    assert!(run.calls.contains(&format!(
        "plugin install roamgate --marketplace {}/{CLAUDE_MOD_MARKETPLACE_DIR} --scope user --json",
        run.home.path().display()
    )));
    assert!(
        run.calls
            .contains(&"plugin enable roamgate@roamgate --scope user".to_owned())
    );
    assert!(run.output.contains("ROAMGATE_EXIT=0"));
    let failed = host_run(
        ClaudeModAction::Install,
        Some(("2.1.319 (Claude Code)", "[]", 3)),
    );
    assert!(failed.output.contains("ROAMGATE_EXIT=3"));
    assert_eq!(
        parse_claude_mod_host_output(&failed.output).action_output,
        "{\"ok\":false,\"error\":\"boom\"}"
    );
    let uninstall = host_run(
        ClaudeModAction::Uninstall,
        Some(("2.1.319 (Claude Code)", "[]", 0)),
    );
    assert!(
        uninstall
            .calls
            .contains(&"plugin uninstall roamgate@roamgate --scope user --json".to_owned())
    );
    assert!(
        uninstall
            .calls
            .contains(&"plugin marketplace remove roamgate".to_owned())
    );
}

#[tokio::test]
async fn the_integration_says_why_an_install_failed_and_needs_a_unix_host() {
    let windows = claude_mod_integration(ClaudeModAction::Status, false, 1, |_| async {
        String::new()
    })
    .await;
    assert_eq!(windows["reason"], "The Claude mod needs a Unix host");
    assert_eq!(windows["sessions"], 1);
    let failed = |action| {
        let output = host_run(action, Some(("2.1.319 (Claude Code)", "[]", 3))).output;
        async move { output }
    };
    let state = claude_mod_integration(ClaudeModAction::Install, true, 0, failed).await;
    assert_eq!(state["reason"], "claude plugin install failed: boom");
    assert_eq!(state["available"], true);
    let status = claude_mod_integration(ClaudeModAction::Status, true, 0, failed).await;
    assert!(status.get("reason").is_none());
}
