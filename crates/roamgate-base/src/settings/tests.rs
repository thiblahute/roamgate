//! config/gui-settings.test.ts, gui-settings.conversation.test.ts,
//! ui-settings.test.ts and overlay-tabs.test.ts.

use std::path::Path;

use serde_json::json;

use super::*;
use crate::paths::Platform;

fn store_at(path: &Path) -> SettingsStore {
    SettingsStore::new(path)
}

fn file(path: &Path) -> Value {
    serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
}

#[tokio::test]
async fn terminal_codecs_survive_a_fresh_store_and_default_to_enabled() {
    let home = tempfile::tempdir().unwrap();
    let path = home.path().join(".config/roamgate/settings.json");
    let settings = store_at(&path).read().await;
    assert!(settings.terminal_surface_codecs_enabled(None));
    assert!(settings.terminal_surface_codecs_enabled(Some("alpha")));
    store_at(&path)
        .update(|current| {
            let changed = current.with("custom", Some(json!({"keep": "yes"})));
            let mut changed = changed;
            changed["terminal_transport"] = json!({
                "legacy-default": {"surface_codecs": false},
                "alpha": {"surface_codecs": false},
                "beta": {"surface_codecs": true},
            });
            changed
        })
        .await
        .unwrap();
    let fresh = store_at(&path).read().await;
    assert!(!fresh.terminal_surface_codecs_enabled(None));
    assert!(!fresh.terminal_surface_codecs_enabled(Some("alpha")));
    assert!(fresh.terminal_surface_codecs_enabled(Some("beta")));
    assert!(fresh.terminal_surface_codecs_enabled(Some("new")));
    assert_eq!(fresh.custom().unwrap()["keep"], "yes");
}

#[tokio::test]
async fn explicit_settings_paths_isolate_writes_and_skip_migration() {
    let home = tempfile::tempdir().unwrap();
    let context = DataContext::new(home.path(), Platform::Unix, None);
    let legacy = home.path().join(".config/herdr-gui/settings.json");
    let default = home.path().join(".config/roamgate/settings.json");
    let isolated = home.path().join("isolated/settings.json");
    let alias = home.path().join("alias/settings.json");
    let legacy_text = r#"{"version":1,"custom":{"legacy":true}}"#;
    std::fs::create_dir_all(dirname(&legacy)).unwrap();
    std::fs::write(&legacy, legacy_text).unwrap();
    let isolated_text = isolated.to_string_lossy().into_owned();
    let alias_text = alias.to_string_lossy().into_owned();

    let env = [
        ("ROAMGATE_SETTINGS_PATH", isolated_text.as_str()),
        ("HERDR_GUI_SETTINGS_PATH", alias_text.as_str()),
    ];
    let store = SettingsStore::from_env(&env, &context).unwrap();
    assert_eq!(store.path(), isolated);
    let before = store.read().await;
    assert_eq!(before.custom(), Some(&json!({})));
    store
        .update(|current| current.with("custom", Some(json!({"isolated": true}))))
        .await
        .unwrap();
    assert_eq!(file(&isolated)["custom"], json!({"isolated": true}));
    assert_eq!(std::fs::read_to_string(&legacy).unwrap(), legacy_text);
    assert!(!default.exists());
    assert!(!alias.exists());

    let legacy_only = [("HERDR_GUI_SETTINGS_PATH", alias_text.as_str())];
    assert_eq!(settings_path(&legacy_only, &context).unwrap(), alias);
    let empty = [
        ("ROAMGATE_SETTINGS_PATH", ""),
        ("HERDR_GUI_SETTINGS_PATH", alias_text.as_str()),
    ];
    assert_eq!(settings_path(&empty, &context).unwrap(), Path::new(""));
}

#[test]
fn settings_keys_keep_the_legacy_format_and_isolate_connections() {
    let workspace =
        json!({"worktree": {"repo_key": "same-repo", "checkout_path": "/same/checkout"}});
    assert_eq!(
        repo_settings_key("same-repo", None, None),
        "local:same-repo"
    );
    assert_eq!(
        repo_settings_key("same-repo", None, Some("legacy-default")),
        "local:same-repo"
    );
    assert_eq!(
        repo_settings_key("same-repo", Some("same-host"), Some("legacy-default")),
        "ssh:same-host:same-repo"
    );
    assert_eq!(
        workspace_repo_settings_key(&workspace, None, Some("alpha")).unwrap(),
        "connection:alpha:local:same-repo"
    );
    assert_eq!(
        workspace_repo_settings_key(&workspace, None, Some("beta")).unwrap(),
        "connection:beta:local:same-repo"
    );
    assert_eq!(
        workspace_auto_sync_settings_key("/same/checkout", Some("same-host"), Some("alpha"))
            .unwrap(),
        "connection:alpha:ssh:same-host:/same/checkout"
    );
    assert_eq!(
        workspace_auto_sync_settings_key("/same/checkout", Some("same-host"), Some("beta"))
            .unwrap(),
        "connection:beta:ssh:same-host:/same/checkout"
    );
    assert_eq!(
        repo_settings_key("same", None, Some("alpha:local:beta")),
        "connection:alpha%3Alocal%3Abeta:local:same"
    );
    assert_eq!(
        workspace_repo_settings_key(&json!({"cwd": "/w"}), None, None).unwrap(),
        "local:/w"
    );
    assert_eq!(workspace_repo_settings_key(&json!({}), None, None), None);
    assert_eq!(workspace_auto_sync_settings_key("  ", None, None), None);
}

#[test]
fn a_worktree_directory_is_kept_only_when_absolute() {
    assert_eq!(
        normalize_worktree_directory(&json!("  /srv/trees//  ")).unwrap(),
        "/srv/trees"
    );
    assert_eq!(normalize_worktree_directory(&json!("/")).unwrap(), "/");
    for value in [
        json!(""),
        json!("   "),
        json!("trees"),
        json!("./trees"),
        json!("~/trees"),
        json!(3),
        json!(null),
    ] {
        assert_eq!(normalize_worktree_directory(&value), None, "{value}");
    }
}

#[test]
fn worktree_commands_are_trimmed_and_a_repositorys_wins() {
    assert_eq!(
        normalize_worktree_command(&json!("  mk {path}\n")).unwrap(),
        "mk {path}"
    );
    for value in [
        json!(null),
        json!(1),
        json!(""),
        json!("  "),
        json!("a\0b"),
        json!("x".repeat(4097)),
    ] {
        assert_eq!(normalize_worktree_command(&value), None);
    }
    let settings = Settings::normalize(&json!({
        "version": 1,
        "worktree_command": "global",
        "repositories": {"local:/a": {"worktree_command": "repo"}, "local:/b": {}},
    }));
    assert_eq!(
        settings.worktree_command_for(Some("local:/a")).unwrap(),
        "repo"
    );
    assert_eq!(
        settings.worktree_command_for(Some("local:/b")).unwrap(),
        "global"
    );
    assert_eq!(settings.worktree_command_for(None).unwrap(), "global");
    let without = Settings::normalize(&settings.with("worktree_command", None));
    assert_eq!(without.worktree_command_for(Some("local:/b")), None);
}

#[test]
fn the_removal_command_follows_the_creation_rule() {
    let settings = Settings::normalize(&json!({
        "version": 1,
        "worktree_command": "add",
        "worktree_remove_command": "global rm",
        "repositories": {
            "local:/a": {"worktree_remove_command": "repo rm"},
            "local:/b": {"worktree_command": "repo add"},
        },
    }));
    assert_eq!(
        settings
            .worktree_remove_command_for(Some("local:/a"))
            .unwrap(),
        "repo rm"
    );
    assert_eq!(
        settings
            .worktree_remove_command_for(Some("local:/b"))
            .unwrap(),
        "global rm"
    );
    let without = Settings::normalize(&settings.with("worktree_remove_command", None));
    assert_eq!(without.worktree_remove_command_for(Some("local:/b")), None);
}

#[test]
fn activity_settings_default_to_off_and_keep_valid_fields() {
    let defaults = default_activity_settings();
    assert_eq!(normalize_activity_settings(None), defaults);
    assert_eq!(defaults["enabled"], false);
    assert_eq!(defaults["retention_days"], 90);
    assert_eq!(defaults["idle_seconds"], 300);
    assert_eq!(defaults["day_start"], "00:00");
    assert_eq!(defaults["record_agent_titles"], false);
    assert_eq!(
        normalize_activity_settings(Some(&json!({
            "enabled": true,
            "retention_days": 30,
            "idle_seconds": 600,
            "day_start": "05:30",
            "subject_roots": ["~/devel/clients", 3, ""],
            "record_agent_titles": true,
            "exclude": {"connections": ["work"], "subjects": ["private"]},
        }))),
        json!({
            "enabled": true,
            "retention_days": 30,
            "idle_seconds": 600,
            "day_start": "05:30",
            "subject_roots": ["~/devel/clients"],
            "record_agent_titles": true,
            "exclude": {"connections": ["work"], "subjects": ["private"]},
        })
    );
    assert_eq!(
        normalize_activity_settings(Some(&json!({
            "enabled": "yes",
            "retention_days": 0,
            "idle_seconds": 1.5,
            "day_start": "24:00",
            "exclude": "all",
        }))),
        defaults
    );
}

#[tokio::test]
async fn activity_settings_survive_other_writes_and_are_not_added() {
    let home = tempfile::tempdir().unwrap();
    let path = home.path().join("settings.json");
    let update = |path: std::path::PathBuf| async move {
        store_at(&path)
            .update(|current| current.with("title_suffix", Some(json!("x"))))
            .await
            .unwrap();
        file(&path)
    };
    std::fs::write(&path, r#"{"version":1}"#).unwrap();
    assert!(update(path.clone()).await.get("activity").is_none());
    std::fs::write(
        &path,
        r#"{"version":1,"activity":{"enabled":true,"subject_roots":["~/devel/clients"]}}"#,
    )
    .unwrap();
    let mut expected = default_activity_settings();
    expected["enabled"] = json!(true);
    expected["subject_roots"] = json!(["~/devel/clients"]);
    assert_eq!(update(path.clone()).await["activity"], expected);
}

#[tokio::test]
async fn a_claude_started_by_hand_stays_in_the_terminal_unless_set() {
    assert_eq!(Settings::defaults().claude_start_mode(), "terminal");
    let home = tempfile::tempdir().unwrap();
    let path = home.path().join("settings.json");
    std::fs::write(&path, r#"{"version":1,"claude_start_mode":"conversation"}"#).unwrap();
    let settings = store_at(&path)
        .update(|current| current.clone().into_value())
        .await
        .unwrap();
    assert_eq!(settings.claude_start_mode(), "conversation");
    std::fs::write(&path, r#"{"version":1,"claude_start_mode":"tui"}"#).unwrap();
    let settings = store_at(&path)
        .update(|current| current.clone().into_value())
        .await
        .unwrap();
    assert_eq!(settings.claude_start_mode(), "terminal");
    assert!(file(&path).get("claude_start_mode").is_none());
}

#[test]
fn mr_cache_keeps_each_valid_field_and_falls_back_to_defaults() {
    let settings = Settings::normalize(&json!({
        "version": 1,
        "mr_cache": {"running_seconds": 45, "budget_per_minute": "many", "open_seconds": 900},
    }));
    assert_eq!(
        settings.get("mr_cache").unwrap(),
        &json!({"running_seconds": 45, "open_seconds": 900})
    );
    let effective = settings.mr_cache();
    assert_eq!(effective.running_ms, 45_000);
    assert_eq!(effective.open_ms, 900_000);
    assert_eq!(effective.budget_per_minute, 20);
    assert_eq!(mr_cache_settings(None).settled_ms, 6 * 60 * 60_000);
    // A default given explicitly is kept.
    let explicit = Settings::normalize(&json!({"mr_cache": {"running_seconds": 75}}));
    assert_eq!(
        explicit.get("mr_cache").unwrap(),
        &json!({"running_seconds": 75})
    );
}

#[test]
fn permission_timeout_defaults_to_15_minutes_and_bad_values_are_dropped() {
    assert_eq!(
        Settings::defaults().conversation_permission_timeout_seconds(),
        900
    );
    for (given, read) in [(json!(0), 0), (json!(90), 90), (json!(86_400), 86_400)] {
        let settings =
            Settings::normalize(&json!({"conversation": {"permission_timeout_seconds": given}}));
        assert_eq!(settings.conversation_permission_timeout_seconds(), read);
    }
    for bad in [json!(-1), json!(86_401), json!(1.5), json!("60")] {
        let settings =
            Settings::normalize(&json!({"conversation": {"permission_timeout_seconds": bad}}));
        assert_eq!(settings.get("conversation").unwrap(), &json!({}));
        assert_eq!(settings.conversation_permission_timeout_seconds(), 900);
    }
}

#[tokio::test]
async fn idle_stop_defaults_to_30_minutes_and_bad_values_are_dropped() {
    assert_eq!(Settings::defaults().conversation_idle_stop_minutes(), 30);
    let off = Settings::normalize(&json!({"conversation": {"idle_stop_minutes": 0}}));
    assert_eq!(off.conversation_idle_stop_minutes(), 0);
    let home = tempfile::tempdir().unwrap();
    let path = home.path().join("settings.json");
    std::fs::write(
        &path,
        r#"{"version":1,"conversation":{"idle_stop_minutes":90}}"#,
    )
    .unwrap();
    let settings = store_at(&path)
        .update(|current| current.clone().into_value())
        .await
        .unwrap();
    assert_eq!(settings.conversation_idle_stop_minutes(), 90);
    std::fs::write(
        &path,
        r#"{"version":1,"conversation":{"idle_stop_minutes":-5}}"#,
    )
    .unwrap();
    let settings = store_at(&path)
        .update(|current| current.clone().into_value())
        .await
        .unwrap();
    assert_eq!(settings.conversation_idle_stop_minutes(), 30);
    assert_eq!(file(&path)["conversation"], json!({}));
}

#[test]
fn ui_keys_are_namespace_identifiers() {
    for key in ["keyboardShortcuts", "terminal.theme", "sidebar-order_2"] {
        assert!(ui_setting_key_is_valid(key), "{key}");
    }
    let long = "a".repeat(65);
    for key in ["", "2fast", "../escape", "has space", long.as_str()] {
        assert!(!ui_setting_key_is_valid(key), "{key}");
    }
}

#[test]
fn ui_values_must_round_trip_through_the_file() {
    assert_eq!(
        ui_setting_value_error(Some(&json!({"active": "auto", "presets": []}))),
        None
    );
    assert_eq!(ui_setting_value_error(Some(&Value::Null)), None);
    assert_eq!(ui_setting_value_error(None), None);
    // Cyclic and function values have no form in serde_json::Value: every
    // value that reaches Rust round-trips, so only the size is checked.
}

#[test]
fn ui_values_are_capped() {
    let large = json!({"blob": "x".repeat(UI_SETTING_MAX_BYTES)});
    assert!(
        ui_setting_value_error(Some(&large))
            .unwrap()
            .contains(&format!("limit is {UI_SETTING_MAX_BYTES}"))
    );
    assert_eq!(
        ui_setting_value_error(Some(&json!({"blob": "x".repeat(1000)}))),
        None
    );
    let settings = Settings::normalize(&json!({"ui": {"ok": 1, "bad key": 2, "big": large}}));
    assert_eq!(settings.ui(), json!({"ok": 1}).as_object().unwrap().clone());
}

#[test]
fn overlay_tabs_are_read_from_the_interface_setting() {
    let ui = json!({
        "overlayTabs": {
            "version": 1,
            "connections": {"local": {"w1": "w1:t2", "w2": "w2:t1"}, "other": {"w1": "x"}},
        },
    });
    let ui = ui.as_object().unwrap();
    assert_eq!(
        overlay_tab_ids_in(ui, "local")
            .into_iter()
            .collect::<Vec<_>>(),
        vec!["w1:t2", "w2:t1"]
    );
    assert!(overlay_tab_ids_in(ui, "missing").is_empty());
}

#[test]
fn a_malformed_overlay_value_hides_nothing() {
    for ui in [
        json!({}),
        json!({"overlayTabs": "x"}),
        json!({"overlayTabs": {"version": 1, "connections": {"local": ["w1:t2"]}}}),
        json!({"overlayTabs": {"version": 1, "connections": {"local": {"w1": 3}}}}),
    ] {
        assert!(
            overlay_tab_ids_in(ui.as_object().unwrap(), "local").is_empty(),
            "{ui}"
        );
    }
}

#[tokio::test]
async fn the_file_is_written_as_the_bun_server_writes_it() {
    let home = tempfile::tempdir().unwrap();
    let path = home.path().join("roamgate/settings.json");
    let store = store_at(&path);
    let mut changes = store.subscribe();
    std::fs::create_dir_all(dirname(&path)).unwrap();
    std::fs::write(
        &path,
        r#"{"ui":{"b":1,"a":2},"unknown":true,"custom":{"2":"x","1":"y"},"version":1,"history":{"enabled":false,"location":" /h "},"archive":{"agents":["claude"]}}"#,
    )
    .unwrap();
    store
        .update(|current| current.clone().into_value())
        .await
        .unwrap();
    assert_eq!(
        std::fs::read_to_string(&path).unwrap(),
        "{\n  \"version\": 1,\n  \"title_suffix\": \"\",\n  \"auto_rename_agent_tabs\": true,\n  \"repositories\": {},\n  \"workspace_auto_sync\": {},\n  \"terminal_transport\": {},\n  \"archive\": {\n    \"agents\": [\n      \"claude\"\n    ],\n    \"hosts\": {},\n    \"stale_hours\": 48,\n    \"thinking\": false,\n    \"index\": {\n      \"default\": \"full\",\n      \"rules\": []\n    },\n    \"exclude\": [],\n    \"hide\": [],\n    \"min_free_gb\": 20\n  },\n  \"custom\": {\n    \"1\": \"y\",\n    \"2\": \"x\"\n  },\n  \"ui\": {\n    \"b\": 1,\n    \"a\": 2\n  },\n  \"history\": {\n    \"enabled\": false,\n    \"location\": \"/h\"\n  }\n}\n"
    );
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o600
        );
    }
    assert!(changes.has_changed().unwrap());
    assert_eq!(
        changes
            .borrow_and_update()
            .as_ref()
            .unwrap()
            .get("archive")
            .unwrap()["agents"][0],
        "claude"
    );
    let leftovers: Vec<_> = std::fs::read_dir(dirname(&path)).unwrap().collect();
    assert_eq!(leftovers.len(), 1);
    let cancelled = store
        .update_if(|current| current.clone().into_value(), || false)
        .await;
    assert!(matches!(cancelled, Err(SettingsError::Cancelled)));
    assert!(!changes.has_changed().unwrap());
}

#[test]
fn title_suffixes_are_cleaned_like_the_instance_name() {
    assert_eq!(normalize_title_suffix(&json!("  a \t b  ")).unwrap(), "a b");
    assert!(normalize_title_suffix(&json!(3)).is_err());
    assert!(normalize_title_suffix(&json!("x".repeat(33))).is_err());
    assert!(normalize_title_suffix(&json!("a\u{202e}b")).is_err());
    let settings = Settings::normalize(&json!({"title_suffix": "a\u{0007}"}));
    assert_eq!(settings.get("title_suffix").unwrap(), "");
}

#[test]
fn instance_name_vectors() {
    let file = roamgate_protocol::vectors::load("instance-name");
    for case in &file.cases {
        for call in &case.calls {
            let target = call.target();
            match target.as_str() {
                "instanceName.normalizeTitleSuffix" => {
                    let arg = call.args.first().cloned().unwrap_or(Value::Null);
                    match (&call.result, &call.throws) {
                        (_, Some(message)) => {
                            assert_eq!(
                                normalize_title_suffix(&arg).unwrap_err(),
                                *message,
                                "{}",
                                case.title()
                            )
                        }
                        (Some(result), None) => assert_eq!(
                            Value::String(normalize_title_suffix(&arg).unwrap()),
                            *result,
                            "{}",
                            case.title()
                        ),
                        _ => panic!("{}: no result", case.title()),
                    }
                }
                "instanceName.instanceDisplayName" => assert_eq!(
                    Value::String(instance_display_name(call.args[0].as_str().unwrap())),
                    *call.result.as_ref().unwrap()
                ),
                "instanceName.MAX_TITLE_SUFFIX_LENGTH" => {
                    assert_eq!(
                        *call.result.as_ref().unwrap(),
                        json!(MAX_TITLE_SUFFIX_LENGTH)
                    )
                }
                other => panic!("{}: unknown call {other}", case.title()),
            }
        }
    }
}

/// `$text` tags of the vectors back to their strings.
fn untag(value: &Value) -> Value {
    if let Some(text) = roamgate_protocol::vectors::text(value)
        && !value.is_string()
    {
        return Value::String(text);
    }
    match value {
        Value::Array(items) => Value::Array(items.iter().map(untag).collect()),
        Value::Object(map) => Value::Object(
            map.iter()
                .map(|(key, value)| (key.clone(), untag(value)))
                .collect(),
        ),
        other => other.clone(),
    }
}

/// contract/vectors/settings.json: every section normalised as
/// normalizeGuiSettings does, in the file's key order.
#[test]
fn settings_vectors() {
    let file = roamgate_protocol::vectors::load("settings");
    let mut failures = Vec::new();
    for case in &file.cases {
        for call in &case.calls {
            assert_eq!(call.target(), "guiSettings.normalizeGuiSettings");
            let raw = untag(&call.args[0]);
            let want = untag(call.result.as_ref().expect("a result"));
            let got = Settings::normalize(&raw).into_value();
            let (got, want) = (
                serde_json::to_string_pretty(&got).unwrap(),
                serde_json::to_string_pretty(&want).unwrap(),
            );
            if got != want {
                failures.push(format!("{}:\n got {got}\nwant {want}", case.title()));
            }
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n\n"));
}
