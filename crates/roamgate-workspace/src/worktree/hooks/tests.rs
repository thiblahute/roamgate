//! worktree-hooks.test.ts.

use std::fs;
use std::path::Path;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

use serde_json::json;

use super::*;
use crate::worktree::testing::{FnRunner, connection, last_word, ran, shell_runner};

fn temp() -> tempfile::TempDir {
    tempfile::Builder::new()
        .prefix("herdr-gui-hooks-test-")
        .tempdir()
        .unwrap()
}

fn path(dir: &Path) -> String {
    dir.to_str().unwrap().to_owned()
}

/// `name` in `dir` as the hooks name it on the host: joined with `/`.
fn host_join(dir: &Path, name: &str) -> String {
    format!("{}/{name}", path(dir))
}

/// The shell's `$PWD` in `dir`, as the hooks' shell says it: Git for
/// Windows' bash names it its own way (/c/..., /tmp/... for TEMP).
fn shell_pwd(dir: &str) -> String {
    if !cfg!(windows) {
        return dir.to_owned();
    }
    let output = std::process::Command::new("sh")
        .args(["-c", "cd \"$1\" && pwd", "sh", dir])
        .output()
        .unwrap();
    String::from_utf8(output.stdout)
        .unwrap()
        .trim_end()
        .to_owned()
}

fn enabled_always(value: bool) -> HookRunner {
    HookRunner {
        hooks_enabled: Some(Arc::new(move |_| Box::pin(async move { value }))),
    }
}

/// A runner that must not run anything.
fn never() -> Arc<FnRunner> {
    FnRunner::answering(|request| panic!("should not run: {request:?}"))
}

fn counting(count: Arc<AtomicUsize>) -> Arc<FnRunner> {
    FnRunner::answering(move |_| {
        count.fetch_add(1, Ordering::SeqCst);
        Ok(ran(0, "", ""))
    })
}

fn linked(checkout: &str, source: Option<&str>) -> Value {
    let mut worktree = json!({ "is_linked_worktree": true, "checkout_path": checkout });
    if let Some(source) = source {
        worktree["repo_root"] = source.into();
    }
    json!({ "workspace": { "worktree": worktree } })
}

#[tokio::test]
async fn loads_paseo_json_from_checkout_before_source_checkout() {
    let root = temp();
    let checkout = root.path().join("checkout");
    let source = root.path().join("source");
    fs::create_dir(&checkout).unwrap();
    fs::create_dir(&source).unwrap();
    fs::write(
        source.join("paseo.json"),
        r#"{"worktree":{"setup":"echo source"}}"#,
    )
    .unwrap();
    fs::write(
        checkout.join("paseo.json"),
        r#"{"worktree":{"setup":"echo checkout"}}"#,
    )
    .unwrap();
    let conn = connection(None, never());
    let loaded = HookRunner::default()
        .read_worktree_hooks(&conn, &path(&checkout), Some(&path(&source)))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(loaded.path, host_join(&checkout, "paseo.json"));
    assert_eq!(loaded.command(Hook::Setup), Some("echo checkout"));
}

#[tokio::test]
async fn runs_configured_paseo_hooks_with_expected_environment() {
    let root = temp();
    let source = root.path().join("source");
    fs::create_dir(&source).unwrap();
    let setup = concat!(
        r#"printf '%s|%s|%s' "$PASEO_HOOK" "$PASEO_CHECKOUT_PATH" "$PASEO_SOURCE_CHECKOUT_PATH""#,
        r#" && test "$ROAMGATE_HOOK_EVENT" = "worktree.created""#,
        r#" && test "$ROAMGATE_HOOK_EVENT" = "$HERDR_GUI_HOOK_EVENT""#,
        r#" && test "$ROAMGATE_HOOK_CHECKOUT_PATH" = "$PASEO_CHECKOUT_PATH""#,
        r#" && test "$ROAMGATE_HOOK_CHECKOUT_PATH" = "$HERDR_GUI_HOOK_CHECKOUT_PATH""#,
        r#" && test "$ROAMGATE_HOOK_SOURCE_CHECKOUT_PATH" = "$PASEO_SOURCE_CHECKOUT_PATH""#,
        r#" && test "$ROAMGATE_HOOK_SOURCE_CHECKOUT_PATH" = "$HERDR_GUI_HOOK_SOURCE_CHECKOUT_PATH""#,
    );
    fs::write(
        root.path().join("paseo.json"),
        json!({ "worktree": { "setup": setup } }).to_string(),
    )
    .unwrap();
    let conn = connection(None, shell_runner(None));
    let result = HookRunner::default()
        .run_worktree_hook(
            &conn,
            HookCall {
                source_checkout_path: Some(path(&source)),
                ..HookCall::new(Hook::Setup, path(root.path()))
            },
        )
        .await
        .unwrap();
    assert_eq!(result.status, "succeeded");
    assert_eq!(result.event, "worktree.created");
    let stdout = result.stdout.unwrap();
    assert!(stdout.contains(&format!("config: {}", host_join(root.path(), "paseo.json"))));
    assert!(stdout.contains(&format!("setup|{}|{}", path(root.path()), path(&source))));
}

#[tokio::test]
async fn skips_hooks_when_repo_settings_disable_them() {
    let root = temp();
    fs::write(root.path().join("roamgate.json"), "invalid JSON").unwrap();
    let conn = connection(None, never());
    let result = enabled_always(false)
        .run_worktree_hook(
            &conn,
            HookCall {
                repo_settings_key: Some("local:repo".into()),
                ..HookCall::new(Hook::Setup, path(root.path()))
            },
        )
        .await
        .unwrap();
    assert_eq!(result, HookRun::skipped("worktree.created"));
    // From the repository's settings when nothing overrides them.
    let mut conn = connection(None, never());
    conn.settings = crate::connection::testing::MemorySettings::new(json!({
        "repositories": { "local:repo": { "worktree_hooks_enabled": false } }
    }));
    let result = HookRunner::default()
        .run_worktree_hook(
            &conn,
            HookCall {
                repo_settings_key: Some("local:repo".into()),
                ..HookCall::new(Hook::Setup, path(root.path()))
            },
        )
        .await
        .unwrap();
    assert_eq!(result, HookRun::skipped("worktree.created"));
}

#[tokio::test]
async fn does_not_execute_when_name() {
    // (expected, actual): None in actual drops the key.
    let cases: [(Option<&str>, Option<&str>); 5] = [
        (Some("printf source"), Some("printf checkout")),
        (None, Some("printf checkout")),
        (Some(""), Some("printf checkout")),
        (None, Some("")),
        (Some("printf source"), None),
    ];
    for (expected, actual) in cases {
        let root = temp();
        let source = root.path().join("source");
        let checkout = root.path().join("checkout");
        fs::create_dir(&source).unwrap();
        fs::create_dir(&checkout).unwrap();
        let source_config = match expected {
            None => json!({ "worktree": {} }),
            Some(command) => json!({ "worktree": { "setup": command } }),
        };
        fs::write(source.join("roamgate.json"), source_config.to_string()).unwrap();
        let checkout_config = match actual {
            None => json!({ "worktree": {} }),
            Some(command) => json!({ "worktree": { "setup": command } }),
        };
        fs::write(checkout.join("roamgate.json"), checkout_config.to_string()).unwrap();
        let executions = Arc::new(AtomicUsize::new(0));
        let conn = connection(None, counting(executions.clone()));
        let result = enabled_always(true)
            .run_worktree_setup_hook(
                &conn,
                &linked(&path(&checkout), Some(&path(&source))),
                Some(&json!({ "cwd": path(&source) })),
                Some(HookExpectation {
                    command: expected.map(str::to_owned),
                    enabled: true,
                }),
                None,
            )
            .await
            .unwrap();
        assert_eq!(
            result.to_value(),
            json!({"event": "worktree.created", "status": "skipped", "reason": "setup_hook_changed"}),
            "{expected:?} {actual:?}"
        );
        assert_eq!(executions.load(Ordering::SeqCst), 0);
    }
}

#[tokio::test]
async fn does_not_execute_when_enabled_changes_from_expected_to_enabled() {
    for (expected, enabled) in [(false, true), (true, false)] {
        let root = temp();
        fs::write(
            root.path().join("roamgate.json"),
            r#"{"worktree":{"setup":"printf approved"}}"#,
        )
        .unwrap();
        let executions = Arc::new(AtomicUsize::new(0));
        let conn = connection(None, counting(executions.clone()));
        let result = enabled_always(enabled)
            .run_worktree_hook(
                &conn,
                HookCall {
                    expected: Some(HookExpectation {
                        command: Some("printf approved".into()),
                        enabled: expected,
                    }),
                    ..HookCall::new(Hook::Setup, path(root.path()))
                },
            )
            .await
            .unwrap();
        assert_eq!(
            result.to_value(),
            json!({"event": "worktree.created", "status": "skipped", "reason": "hooks_enabled_changed"})
        );
        assert_eq!(executions.load(Ordering::SeqCst), 0);
    }
}

#[tokio::test]
async fn matching_confirmed_setup_executes_exactly_once_with_enabled_rechecked_before_launch() {
    let root = temp();
    fs::write(
        root.path().join("roamgate.json"),
        r#"{"worktree":{"setup":"printf approved"}}"#,
    )
    .unwrap();
    let runner = FnRunner::answering(|_| Ok(ran(0, "approved", "")));
    let conn = connection(None, runner.clone());
    let reads = Arc::new(AtomicUsize::new(0));
    let counted = reads.clone();
    let hooks = HookRunner {
        hooks_enabled: Some(Arc::new(move |_| {
            counted.fetch_add(1, Ordering::SeqCst);
            Box::pin(async { true })
        })),
    };
    let current = || true;
    let result = hooks
        .run_worktree_setup_hook(
            &conn,
            &linked(&path(root.path()), None),
            None,
            Some(HookExpectation {
                command: Some("printf approved".into()),
                enabled: true,
            }),
            Some(&current),
        )
        .await
        .unwrap();
    assert_eq!(result.status, "succeeded");
    assert_eq!(reads.load(Ordering::SeqCst), 2);
    let requests = runner.requests();
    assert_eq!(requests.len(), 1);
    assert!(last_word(&requests[0]).contains("sh -c 'printf approved'"));
}

#[tokio::test]
async fn a_late_enabled_change_or_retired_target_cannot_start_the_confirmed_command() {
    let root = temp();
    fs::write(
        root.path().join("roamgate.json"),
        r#"{"worktree":{"setup":"printf approved"}}"#,
    )
    .unwrap();
    for retire in [false, true] {
        let reads = Arc::new(AtomicUsize::new(0));
        let current = Arc::new(AtomicBool::new(true));
        let executions = Arc::new(AtomicUsize::new(0));
        let conn = connection(None, counting(executions.clone()));
        let (counted, flag) = (reads.clone(), current.clone());
        let hooks = HookRunner {
            hooks_enabled: Some(Arc::new(move |_| {
                let reads = counted.fetch_add(1, Ordering::SeqCst) + 1;
                if reads == 2 && retire {
                    flag.store(false, Ordering::SeqCst);
                }
                Box::pin(async move { reads == 1 || retire })
            })),
        };
        let is_current = || current.load(Ordering::SeqCst);
        let result = hooks
            .run_worktree_hook(
                &conn,
                HookCall {
                    expected: Some(HookExpectation {
                        command: Some("printf approved".into()),
                        enabled: true,
                    }),
                    is_current: Some(&is_current),
                    ..HookCall::new(Hook::Setup, path(root.path()))
                },
            )
            .await;
        if retire {
            assert_eq!(result.unwrap_err().message, "The worktree target changed.");
        } else {
            assert_eq!(
                result.unwrap().to_value(),
                json!({"event": "worktree.created", "status": "skipped", "reason": "hooks_enabled_changed"})
            );
        }
        assert_eq!(executions.load(Ordering::SeqCst), 0);
    }
}

#[tokio::test]
async fn unverifiable_checkout_configuration_fails_closed_without_raw_errors() {
    let root = temp();
    fs::write(
        root.path().join("roamgate.json"),
        "invalid synthetic-private-config",
    )
    .unwrap();
    let conn = connection(None, never());
    let result = enabled_always(true)
        .run_worktree_hook(
            &conn,
            HookCall {
                expected: Some(HookExpectation {
                    command: Some("printf approved".into()),
                    enabled: true,
                }),
                ..HookCall::new(Hook::Setup, path(root.path()))
            },
        )
        .await
        .unwrap();
    assert_eq!(
        result.to_value(),
        json!({"event": "worktree.created", "status": "skipped", "reason": "setup_hook_changed"})
    );
}

const HOST: &str = "hook-test-host";

/// The runner of the shell tests: SSH command bodies run in a real sh.
fn shell(ssh: bool) -> (WorkspaceConnection, HookRunner) {
    let host = ssh.then_some(HOST);
    (connection(host, shell_runner(host)), enabled_always(true))
}

#[tokio::test]
async fn runs_the_s_opened_hook_when_the_source_workspace_has_no_path_metadata() {
    for ssh in [false, true] {
        for location in ["source", "target"] {
            let root = temp();
            let checkout = root.path().join("target ' quoted");
            let source = root.path().join("source");
            fs::create_dir(&checkout).unwrap();
            fs::create_dir(&source).unwrap();
            let dir = if location == "source" {
                &source
            } else {
                &checkout
            };
            fs::write(
                dir.join("roamgate.json"),
                json!({ "worktree": { "opened": r#"printf "%s|%s" "$PWD" "$ROAMGATE_HOOK_SOURCE_CHECKOUT_PATH""# } })
                    .to_string(),
            )
            .unwrap();
            let (conn, hooks) = shell(ssh);
            let result = hooks
                .run_worktree_opened_hook(
                    &conn,
                    &linked(&path(&checkout), Some(&path(&source))),
                    Some(&json!({ "workspace_id": "plain-workspace" })),
                )
                .await
                .unwrap();
            assert_eq!(result.status, "succeeded", "{ssh} {location} {result:?}");
            let stdout = result.stdout.unwrap();
            let expected = format!("{}|{}", shell_pwd(&path(&checkout)), path(&source));
            assert!(stdout.contains(&expected), "{stdout:?} lacks {expected:?}");
        }
    }
}

#[tokio::test]
async fn selects_one_file_in_native_legacy_target_source_order_for_every_combination() {
    for ssh in [false, true] {
        let root = temp();
        let checkout = root.path().join("target ' quoted");
        let source = root.path().join("source");
        fs::create_dir(&checkout).unwrap();
        fs::create_dir(&source).unwrap();
        let paths = [
            checkout.join("roamgate.json"),
            source.join("roamgate.json"),
            checkout.join("paseo.json"),
            source.join("paseo.json"),
        ];
        let hosted = [
            host_join(&checkout, "roamgate.json"),
            host_join(&source, "roamgate.json"),
            host_join(&checkout, "paseo.json"),
            host_join(&source, "paseo.json"),
        ];
        let (conn, hooks) = shell(ssh);
        for mask in 0..16 {
            for (index, file) in paths.iter().enumerate() {
                let _ = fs::remove_file(file);
                if mask & (1 << index) != 0 {
                    fs::write(
                        file,
                        json!({ "worktree": { "setup": format!("printf selected-{index}") } })
                            .to_string(),
                    )
                    .unwrap();
                }
            }
            let selected = (0..4).find(|index| mask & (1 << index) != 0);
            let loaded = hooks
                .read_worktree_hooks(&conn, &path(&checkout), Some(&path(&source)))
                .await
                .unwrap();
            let result = hooks
                .run_worktree_hook(
                    &conn,
                    HookCall {
                        source_checkout_path: Some(path(&source)),
                        ..HookCall::new(Hook::Setup, path(&checkout))
                    },
                )
                .await
                .unwrap();
            match selected {
                None => {
                    assert!(loaded.is_none());
                    assert_eq!(result.status, "skipped");
                }
                Some(selected) => {
                    let loaded = loaded.unwrap();
                    assert_eq!(loaded.path, hosted[selected]);
                    assert_eq!(
                        loaded.source,
                        if selected < 2 { "roamgate" } else { "paseo" }
                    );
                    assert_eq!(result.status, "succeeded");
                    let stdout = result.stdout.unwrap();
                    let found: Vec<&str> = stdout
                        .match_indices("selected-")
                        .map(|(at, _)| &stdout[at..at + 10])
                        .collect();
                    assert_eq!(found, [format!("selected-{selected}")]);
                }
            }
        }
    }
}

#[tokio::test]
async fn empty_and_partial_configurations_suppress_fallback_and_ignore_unknown_fields() {
    for ssh in [false, true] {
        let root = temp();
        let (conn, hooks) = shell(ssh);
        fs::write(
            root.path().join("paseo.json"),
            r#"{"worktree":{"setup":"exit 42"}}"#,
        )
        .unwrap();
        for config in [
            json!({}),
            json!({ "worktree": {} }),
            json!({ "worktree": { "setup": " " } }),
            json!({ "worktree": { "opened": "true", "future": 3 }, "future": [] }),
        ] {
            fs::write(root.path().join("roamgate.json"), config.to_string()).unwrap();
            let result = hooks
                .run_worktree_hook(
                    &conn,
                    HookCall {
                        source_checkout_path: Some(path(root.path())),
                        ..HookCall::new(Hook::Setup, path(root.path()))
                    },
                )
                .await
                .unwrap();
            assert_eq!(result.status, "skipped", "{config}");
        }
    }
}

#[tokio::test]
async fn invalid_json_types_and_unreadable_files_fail_with_their_path_without_fallback() {
    for ssh in [false, true] {
        let root = temp();
        let (conn, hooks) = shell(ssh);
        let file = root.path().join("roamgate.json");
        let file_path = host_join(root.path(), "roamgate.json");
        fs::write(
            root.path().join("paseo.json"),
            r#"{"worktree":{"setup":"true"}}"#,
        )
        .unwrap();
        let mut texts: Vec<String> = [
            "",
            " ",
            "{",
            "null",
            "[]",
            "1",
            r#"{"worktree":null}"#,
            r#"{"worktree":[]}"#,
        ]
        .map(str::to_owned)
        .to_vec();
        for hook in ["setup", "opened", "teardown", "removed"] {
            for value in [json!(null), json!(1), json!(false), json!([]), json!({})] {
                texts.push(json!({ "worktree": { hook: value } }).to_string());
            }
        }
        for text in texts {
            fs::write(&file, &text).unwrap();
            let error = hooks
                .read_worktree_hooks(&conn, &path(root.path()), None)
                .await
                .unwrap_err();
            assert!(error.to_string().contains(&file_path), "{text}: {error}");
            let result = hooks
                .run_worktree_hook(&conn, HookCall::new(Hook::Setup, path(root.path())))
                .await
                .unwrap();
            assert_eq!(result.status, "failed");
            assert!(result.error.unwrap().contains(&file_path));
        }
        #[cfg(unix)]
        if user_id() != 0 {
            use std::os::unix::fs::PermissionsExt as _;
            fs::set_permissions(&file, fs::Permissions::from_mode(0o000)).unwrap();
            let error = hooks
                .read_worktree_hooks(&conn, &path(root.path()), None)
                .await
                .unwrap_err();
            fs::set_permissions(&file, fs::Permissions::from_mode(0o600)).unwrap();
            assert!(error.to_string().contains(&file_path));
        }
        fs::remove_file(&file).unwrap();
        fs::create_dir(&file).unwrap();
        let error = hooks
            .read_worktree_hooks(&conn, &path(root.path()), None)
            .await
            .unwrap_err();
        assert!(error.to_string().contains(&file_path));
    }
}

/// The user id, from `id -u` (root reads any file).
#[cfg(unix)]
fn user_id() -> u32 {
    let output = std::process::Command::new("id").arg("-u").output().unwrap();
    String::from_utf8_lossy(&output.stdout)
        .trim()
        .parse()
        .unwrap_or(0)
}

#[tokio::test]
async fn reads_a_utf_8_bom_in_filename_and_runs_teardown() {
    for ssh in [false, true] {
        for filename in ["roamgate.json", "paseo.json"] {
            let root = temp();
            let file = root.path().join(filename);
            let teardown = "printf 'bom-\u{feff}-kept'";
            fs::write(
                &file,
                format!(
                    "\u{feff}{}",
                    json!({ "worktree": { "teardown": teardown } })
                ),
            )
            .unwrap();
            let (conn, hooks) = shell(ssh);
            let loaded = hooks
                .read_worktree_hooks(&conn, &path(root.path()), None)
                .await
                .unwrap()
                .unwrap();
            assert_eq!(loaded.path, host_join(root.path(), filename));
            assert_eq!(loaded.command(Hook::Teardown), Some(teardown));
            let result = hooks
                .run_worktree_hook(&conn, HookCall::new(Hook::Teardown, path(root.path())))
                .await
                .unwrap();
            assert_eq!(result.status, "succeeded");
            assert!(result.stdout.unwrap().contains("bom-\u{feff}-kept"));
        }
    }
}

#[tokio::test]
async fn runs_all_lifecycle_hooks_from_filename_with_cwd_aliases_and_source_after_removal() {
    for ssh in [false, true] {
        for filename in ["roamgate.json", "paseo.json"] {
            let root = temp();
            let checkout = root.path().join("target ' quoted");
            let source = root.path().join("source");
            fs::create_dir(&checkout).unwrap();
            fs::create_dir(&source).unwrap();
            let hook = |name: &str| {
                format!(
                    "{}{}{}{}{}test \"$PASEO_HOOK\" = {name} && {}",
                    r#"test "$ROAMGATE_HOOK_EVENT" = "$HERDR_GUI_HOOK_EVENT" && "#,
                    r#"test "$ROAMGATE_HOOK_CHECKOUT_PATH" = "$PASEO_CHECKOUT_PATH" && "#,
                    r#"test "$ROAMGATE_HOOK_CHECKOUT_PATH" = "$HERDR_GUI_HOOK_CHECKOUT_PATH" && "#,
                    r#"test "$ROAMGATE_HOOK_SOURCE_CHECKOUT_PATH" = "$PASEO_SOURCE_CHECKOUT_PATH" && "#,
                    r#"test "$ROAMGATE_HOOK_SOURCE_CHECKOUT_PATH" = "$HERDR_GUI_HOOK_SOURCE_CHECKOUT_PATH" && "#,
                    r#"printf "%s|%s|%s|%s" "$PWD" "$ROAMGATE_HOOK_EVENT" "$ROAMGATE_HOOK_CHECKOUT_PATH" "$ROAMGATE_HOOK_SOURCE_CHECKOUT_PATH""#,
                )
            };
            let hooks_json = json!({
                "setup": hook("setup"),
                "opened": hook("opened"),
                "teardown": hook("teardown"),
                "removed": hook("removed"),
            });
            fs::write(
                checkout.join(filename),
                json!({ "worktree": hooks_json }).to_string(),
            )
            .unwrap();
            fs::write(
                source.join(filename),
                json!({ "worktree": { "removed": format!("{} && printf source-only", hook("removed")) } })
                    .to_string(),
            )
            .unwrap();
            let (conn, hooks) = shell(ssh);
            let (checkout_path, source_path) = (path(&checkout), path(&source));
            let workspace = linked(&checkout_path, Some(&source_path));
            let source_workspace = json!({ "cwd": source_path });
            let setup = hooks
                .run_worktree_setup_hook(&conn, &workspace, Some(&source_workspace), None, None)
                .await
                .unwrap();
            let opened = hooks
                .run_worktree_opened_hook(&conn, &workspace, Some(&source_workspace))
                .await
                .unwrap();
            let teardown = hooks
                .run_worktree_hook(
                    &conn,
                    HookCall {
                        source_checkout_path: Some(source_path.clone()),
                        ..HookCall::new(Hook::Teardown, checkout_path.clone())
                    },
                )
                .await
                .unwrap();
            for (result, event) in [
                (setup, "worktree.created"),
                (opened, "worktree.opened"),
                (teardown, "worktree.before_remove"),
            ] {
                assert_eq!(result.status, "succeeded", "{event} {result:?}");
                let pwd = shell_pwd(&checkout_path);
                let stdout = result.stdout.unwrap();
                let expected = format!("{pwd}|{event}|{checkout_path}|{source_path}");
                assert!(stdout.contains(&expected), "{stdout:?} lacks {expected:?}");
            }
            fs::remove_dir_all(&checkout).unwrap();
            let removed = hooks
                .run_worktree_removed_hook(
                    &conn,
                    Some(&RemoveHookContext {
                        checkout_path: checkout_path.clone(),
                        source_checkout_path: source_path.clone(),
                        repo_settings_key: None,
                    }),
                )
                .await
                .unwrap();
            assert_eq!(removed.status, "succeeded");
            let stdout = removed.stdout.unwrap();
            assert!(stdout.contains(&format!("config: {}", host_join(&source, filename))));
            // $PWD as the shell names it (/c/... in Git Bash).
            let source_pwd = shell_pwd(&source_path);
            assert!(stdout.contains(&format!(
                "{source_pwd}|worktree.removed|{checkout_path}|{source_path}source-only"
            )));
        }
    }
}
