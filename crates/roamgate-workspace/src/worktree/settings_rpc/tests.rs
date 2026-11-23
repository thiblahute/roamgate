//! The worktree cases of settings-rpc.test.ts.

use std::fs;
use std::sync::{Arc, Mutex};

use roamgate_base::settings::Settings;
use serde_json::{Value, json};

use super::*;
use crate::connection::testing::{FakeHerdr, MemorySettings};
use crate::worktree::testing::{FnRunner, connection_with, last_word, ran};

fn callbacks(root: &'static str) -> WorktreeCallbacks {
    WorktreeCallbacks {
        resolve_git_root: Arc::new(move |_| Box::pin(async move { Ok(root.to_owned()) })),
        place_created: None,
    }
}

fn current() -> Guard {
    Arc::new(|| true)
}

#[tokio::test]
async fn hook_settings_expose_selected_config_and_errors_without_mislabeling_native_files_as_paseo()
{
    let dir = tempfile::tempdir().unwrap();
    let target = dir.path().join("target");
    let source = dir.path().join("source");
    fs::create_dir(&target).unwrap();
    fs::create_dir(&source).unwrap();
    let (target_path, source_path) = (
        target.to_str().unwrap().to_owned(),
        source.to_str().unwrap().to_owned(),
    );
    let answer = json!({ "workspace": { "worktree": { "checkout_path": target_path, "repo_root": source_path } } });
    let herdr = FakeHerdr::new(move |_, _| Ok(answer.clone()));
    let runner = FnRunner::answering(|_| Ok(ran(1, "", "")));
    let conn = connection_with(None, runner, herdr, json!({}));
    for selected in [Some("roamgate"), Some("paseo"), None] {
        for invalid in [false, true] {
            for name in ["roamgate", "paseo"] {
                let _ = fs::remove_file(source.join(format!("{name}.json")));
            }
            if let Some(selected) = selected {
                fs::write(
                    source.join(format!("{selected}.json")),
                    if invalid {
                        r#"{"worktree":{"setup":1}}"#
                    } else {
                        r#"{"worktree":{"setup":"true"}}"#
                    },
                )
                .unwrap();
            }
            let result = settings_rpc(
                &conn,
                &HookRunner::default(),
                "settings.worktree_hooks.get",
                &json!({ "workspace_id": "workspace" }),
                &current(),
                &callbacks("/source"),
            )
            .await
            .unwrap()
            .unwrap();
            let path = selected.map(|name| format!("{source_path}/{name}.json"));
            assert_eq!(result["config_path"], json!(path));
            assert_eq!(result["config_source"], json!(selected));
            let paseo = if selected == Some("paseo") {
                path.clone()
            } else {
                None
            };
            assert_eq!(result["paseo_path"], json!(paseo));
            assert_eq!(
                result["hooks"],
                if selected.is_some() && !invalid {
                    json!({ "setup": "true" })
                } else {
                    json!({})
                }
            );
            if selected.is_some() && invalid {
                assert!(
                    result["error"]
                        .as_str()
                        .unwrap()
                        .contains(path.as_deref().unwrap())
                );
            } else {
                assert!(result.get("error").is_none(), "{result}");
            }
        }
    }
}

async fn call(conn: &WorkspaceConnection, method: &str, params: Value) -> RpcResult {
    settings_rpc(
        conn,
        &HookRunner::default(),
        method,
        &params,
        &current(),
        &callbacks("/tmp"),
    )
    .await
    .unwrap()
}

#[tokio::test]
async fn worktree_commands_are_set_globally_and_per_repository_and_cleared_when_empty() {
    let settings = MemorySettings::new(json!({}));
    let mut conn = connection_with(
        None,
        FnRunner::answering(|_| Ok(ran(1, "", ""))),
        FakeHerdr::new(|_, _| Ok(json!({}))),
        json!({}),
    );
    conn.settings = settings.clone();
    let read = || settings.0.lock().unwrap().clone();
    let repo = |field: &str| {
        read()
            .get("repositories")
            .and_then(|repos| repos.get("local:/repo"))
            .and_then(|repo| repo.get(field))
            .cloned()
    };

    call(
        &conn,
        "settings.worktree_command.update",
        json!({ "command": "  git recworktree add {path} --branch {branch}  " }),
    )
    .await
    .unwrap();
    assert_eq!(
        read().get("worktree_command"),
        Some(&json!("git recworktree add {path} --branch {branch}"))
    );
    call(
        &conn,
        "settings.update_repo",
        json!({ "key": "local:/repo", "settings": { "worktree_command": "make-worktree {path}" } }),
    )
    .await
    .unwrap();
    assert_eq!(
        repo("worktree_command"),
        Some(json!("make-worktree {path}"))
    );
    let error = call(
        &conn,
        "settings.update_repo",
        json!({ "key": "local:/repo", "settings": { "worktree_command": "x".repeat(5000) } }),
    )
    .await
    .unwrap_err();
    assert!(error.message.contains("worktree_command must be"));
    call(
        &conn,
        "settings.update_repo",
        json!({ "key": "local:/repo", "settings": { "worktree_command": "" } }),
    )
    .await
    .unwrap();
    assert_eq!(repo("worktree_command"), None);
    let cleared = call(
        &conn,
        "settings.worktree_command.update",
        json!({ "command": " " }),
    )
    .await
    .unwrap();
    assert_eq!(read().get("worktree_command"), None);
    assert_eq!(
        cleared,
        json!({ "worktree_command": null, "worktree_remove_command": null })
    );

    // The removal command changes only when given, globally or per
    // repository.
    call(
        &conn,
        "settings.worktree_command.update",
        json!({
            "command": "git recworktree add {path} --branch {branch}",
            "remove_command": " git recworktree remove {path} {force} ",
        }),
    )
    .await
    .unwrap();
    assert_eq!(
        read().get("worktree_remove_command"),
        Some(&json!("git recworktree remove {path} {force}"))
    );
    call(
        &conn,
        "settings.worktree_command.update",
        json!({ "command": "" }),
    )
    .await
    .unwrap();
    assert_eq!(
        read().get("worktree_remove_command"),
        Some(&json!("git recworktree remove {path} {force}"))
    );
    call(
        &conn,
        "settings.update_repo",
        json!({ "key": "local:/repo", "settings": { "worktree_remove_command": "rm-worktree {path}" } }),
    )
    .await
    .unwrap();
    assert_eq!(
        repo("worktree_remove_command"),
        Some(json!("rm-worktree {path}"))
    );
    let error = call(
        &conn,
        "settings.update_repo",
        json!({ "key": "local:/repo", "settings": { "worktree_remove_command": "x".repeat(5000) } }),
    )
    .await
    .unwrap_err();
    assert!(error.message.contains("worktree_command must be"));

    // A quoted placeholder would hand its value back to the shell.
    let error = call(
        &conn,
        "settings.worktree_command.update",
        json!({ "command": r#"mk "{path}""# }),
    )
    .await
    .unwrap_err();
    assert!(error.message.contains("Remove the quotes around {path}"));
    let error = call(
        &conn,
        "settings.update_repo",
        json!({ "key": "local:/repo", "settings": { "worktree_remove_command": "rm '{path}'" } }),
    )
    .await
    .unwrap_err();
    assert!(error.message.contains("Remove the quotes around {path}"));
    assert_eq!(
        repo("worktree_remove_command"),
        Some(json!("rm-worktree {path}"))
    );
}

#[tokio::test]
async fn worktree_settings_of_a_workspace_herdr_reports_no_repository_for_are_its_repository_s() {
    let probes = Arc::new(Mutex::new(Vec::<String>::new()));
    let kept = probes.clone();
    let runner = FnRunner::answering(move |request| {
        kept.lock().unwrap().push(last_word(request));
        Ok(ran(0, "/repo/.git\n", ""))
    });
    let herdr = FakeHerdr::new(|_, _| {
        Ok(
            json!({ "workspace": { "cwd": "/repo.worktrees/review", "worktree": { "checkout_path": "/repo.worktrees/review" } } }),
        )
    });
    let settings = MemorySettings::new(json!({ "worktree_command": "global {path}" }));
    let mut conn = connection_with(None, runner, herdr, json!({}));
    conn.id = "alpha".into();
    conn.settings = settings.clone();
    let set = |repositories: Value| {
        *settings.0.lock().unwrap() = Arc::new(Settings::normalize(
            &json!({ "worktree_command": "global {path}", "repositories": repositories }),
        ));
    };
    let get = |method: &'static str| {
        let conn = conn.clone();
        async move {
            settings_rpc(
                &conn,
                &HookRunner::default(),
                method,
                &json!({ "workspace_id": "workspace" }),
                &current(),
                &callbacks("/repo.worktrees/review"),
            )
            .await
            .unwrap()
            .unwrap()
        }
    };
    let repo_key = "connection:alpha:local:/repo/.git";
    let checkout_key = "connection:alpha:local:/repo.worktrees/review";

    // Nothing saved yet: the dialogs save under the repository.
    assert_eq!(
        get("settings.worktree_directory.get").await["key"],
        repo_key
    );
    assert!(probes.lock().unwrap().last().unwrap().contains(
        "git -C '/repo.worktrees/review' rev-parse --path-format=absolute --git-common-dir"
    ));

    set(json!({ repo_key: {
        "worktree_directory": "/trees",
        "worktree_command": "mk {path}",
        "worktree_hooks_enabled": false,
    } }));
    let directory = get("settings.worktree_directory.get").await;
    assert_eq!(directory["key"], repo_key);
    assert_eq!(directory["worktree_directory"], "/trees");
    let hooks = get("settings.worktree_hooks.get").await;
    assert_eq!(hooks["key"], repo_key);
    assert_eq!(hooks["enabled"], false);
    assert_eq!(hooks["worktree_directory"], "/trees");
    assert_eq!(hooks["worktree_command"], "mk {path}");
    assert_eq!(hooks["default_worktree_command"], "global {path}");

    // Settings saved under the checkout path before keep showing.
    set(json!({ checkout_key: { "worktree_directory": "/legacy" } }));
    let directory = get("settings.worktree_directory.get").await;
    assert_eq!(directory["key"], checkout_key);
    assert_eq!(directory["worktree_directory"], "/legacy");
    let hooks = get("settings.worktree_hooks.get").await;
    assert_eq!(hooks["key"], checkout_key);
    assert_eq!(hooks["worktree_directory"], "/legacy");
}
