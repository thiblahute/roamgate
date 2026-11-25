//! bridge/settings-rpc.test.ts and http/instance-settings.test.ts, for
//! what the settings family answers; the revision's compare-and-set.

use std::path::Path;

use super::*;

fn service(path: &Path) -> SettingsService {
    SettingsService::new(SettingsStore::new(path), 1000)
}

fn file(path: &Path) -> Value {
    serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
}

#[tokio::test]
async fn writes_move_the_revision_and_a_stale_base_is_refused() {
    let home = tempfile::tempdir().unwrap();
    let path = home.path().join("settings.json");
    let settings = service(&path);
    let first = settings.get().await;
    assert_eq!(first.revision, 1000);
    let mut next = first.settings.as_map().clone();
    next.insert("title_suffix".into(), "desk".into());
    let written = settings
        .replace(1000, Value::Object(next.clone()))
        .await
        .unwrap();
    assert_eq!(written.revision, 1001);
    assert_eq!(file(&path)["title_suffix"], "desk");
    // A second write on the old revision loses nothing: it is refused.
    next.insert("title_suffix".into(), "other".into());
    let stale = settings.replace(1000, Value::Object(next)).await;
    assert!(matches!(stale, Err(WriteError::Stale { revision: 1001 })));
    assert_eq!(file(&path)["title_suffix"], "desk");
    // RPC writes move it too.
    let answer = settings
        .rpc(
            "settings.agent_auto_rename.update",
            &json!({"enabled": false}),
            Some("alpha"),
            "",
        )
        .await
        .unwrap();
    assert_eq!(answer.result, json!({"enabled": false}));
    assert_eq!(answer.written.unwrap().revision, 1002);
    assert_eq!(settings.get().await.revision, 1002);
}

#[tokio::test]
async fn connection_settings_validate_and_persist_by_connection() {
    let home = tempfile::tempdir().unwrap();
    let path = home.path().join("settings.json");
    let settings = service(&path);
    let call = |method: &'static str, params: Value| {
        let settings = &settings;
        async move { settings.rpc(method, &params, Some("alpha"), "/x").await }
    };
    assert_eq!(
        call("settings.get", json!({})).await.unwrap().result["path"],
        "/x"
    );
    assert_eq!(
        call(
            "settings.agent_auto_rename.update",
            json!({"enabled": false, "x": 1})
        )
        .await
        .unwrap_err(),
        "settings.agent_auto_rename.update requires only a boolean enabled"
    );
    assert_eq!(
        call(
            "settings.claude_start.update",
            json!({"mode": "conversation"})
        )
        .await
        .unwrap()
        .result,
        json!({"mode": "conversation"})
    );
    assert!(
        call("settings.claude_start.update", json!({"mode": "sideways"}))
            .await
            .is_err()
    );
    assert_eq!(
        call(
            "settings.conversation.update",
            json!({"idle_stop_minutes": 15})
        )
        .await
        .unwrap()
        .result,
        json!({"idle_stop_minutes": 15})
    );
    assert!(
        call(
            "settings.conversation.update",
            json!({"idle_stop_minutes": -1})
        )
        .await
        .unwrap_err()
        .starts_with("settings.conversation.update takes only idle_stop_minutes")
    );
    let resume = call(
        "settings.limit_resume.update",
        json!({"enabled": false, "message": "  go on  ", "margin_seconds": 30}),
    )
    .await
    .unwrap()
    .result;
    assert_eq!(
        resume,
        json!({"enabled": false, "message": "go on", "margin_seconds": 30})
    );
    assert!(
        call("settings.limit_resume.update", json!({"enabled": "maybe"}))
            .await
            .unwrap_err()
            .contains("limit_resume.enabled must be true or false")
    );
    assert_eq!(
        call(
            "settings.terminal_transport.update",
            json!({"surface_codecs": false})
        )
        .await
        .unwrap()
        .result,
        json!({"surface_codecs": false})
    );
    let other = settings
        .rpc(
            "settings.terminal_transport.get",
            &json!({}),
            Some("beta"),
            "",
        )
        .await
        .unwrap();
    assert_eq!(other.result, json!({"surface_codecs": true}));
    let stored = file(&path);
    assert_eq!(
        stored["terminal_transport"],
        json!({"alpha": {"surface_codecs": false}})
    );
    assert_eq!(stored["claude_start_mode"], "conversation");
    assert_eq!(stored["conversation"], json!({"idle_stop_minutes": 15}));
    assert_eq!(stored["auto_rename_agent_tabs"], true);
}

#[tokio::test]
async fn ui_preferences_set_and_clear() {
    let home = tempfile::tempdir().unwrap();
    let path = home.path().join("settings.json");
    let settings = service(&path);
    let set = settings
        .rpc(
            "bridge.ui_settings.update",
            &json!({"key": "theme", "value": "black"}),
            None,
            "",
        )
        .await
        .unwrap();
    assert_eq!(set.result, json!({"key": "theme", "value": "black"}));
    assert_eq!(
        settings
            .rpc("bridge.ui_settings.get", &json!({}), None, "")
            .await
            .unwrap()
            .result,
        json!({"ui": {"theme": "black"}})
    );
    let cleared = settings
        .rpc(
            "bridge.ui_settings.update",
            &json!({"key": "theme"}),
            None,
            "",
        )
        .await
        .unwrap();
    assert_eq!(cleared.result, json!({"key": "theme", "value": null}));
    assert_eq!(
        settings
            .rpc(
                "bridge.ui_settings.update",
                &json!({"key": "9x", "value": 1}),
                None,
                ""
            )
            .await
            .unwrap_err(),
        "UI settings require key matching [A-Za-z][A-Za-z0-9_.-]{0,63}"
    );
}

fn put(body: &str) -> InstanceRequest {
    InstanceRequest {
        method: "PUT".into(),
        settings_header: Some("1".into()),
        fetch_site: None,
        content_type: Some("application/json; charset=utf-8".into()),
        body: InstanceBody::Bytes(body.as_bytes().to_vec()),
    }
}

#[tokio::test]
async fn instance_settings_refuse_cross_site_and_simple_browser_writes_and_keep_roots_of_listed_sites()
 {
    let home = tempfile::tempdir().unwrap();
    let path = home.path().join("settings.json");
    let settings = service(&path);
    let forbidden = settings
        .instance_settings(InstanceRequest {
            settings_header: None,
            ..put("{}")
        })
        .await;
    assert_eq!(forbidden.status, 403);
    let cross = settings
        .instance_settings(InstanceRequest {
            fetch_site: Some("cross-site".into()),
            ..put("{}")
        })
        .await;
    assert_eq!(cross.status, 403);
    let wrong = settings
        .instance_settings(InstanceRequest {
            method: "DELETE".into(),
            ..put("{}")
        })
        .await;
    assert_eq!((wrong.status, wrong.allow), (405, Some("GET, PUT")));
    let large = settings
        .instance_settings(InstanceRequest {
            body: InstanceBody::TooLarge,
            ..put("")
        })
        .await;
    assert_eq!(large.status, 413);
    assert_eq!(settings.instance_settings(put("{")).await.status, 400);
    let bad = settings
        .instance_settings(put(r#"{"title_suffix": "x\u0007"}"#))
        .await;
    assert_eq!(bad.status, 400);
    let ok = settings
        .instance_settings(put(
            r#"{"title_suffix": " desk ", "rendered_sites": ["https://a.test/docs/x.html", "/srv/site"], "rendered_site_roots": {"https://a.test/docs/": "https://a.test/", "/srv/site/": "/srv/", "https://gone.test/": "https://gone.test/"}}"#,
        ))
        .await;
    assert_eq!(ok.status, 200);
    assert_eq!(
        ok.body,
        json!({
            "title_suffix": "desk",
            "rendered_sites": ["https://a.test/docs/", "/srv/site/"],
            "rendered_site_roots": {"https://a.test/docs/": "https://a.test/", "/srv/site/": "/srv/"},
        })
    );
    assert!(ok.written.is_some());
    // Dropping a site drops its root; the title stays.
    let fewer = settings
        .instance_settings(put(r#"{"rendered_sites": ["/srv/site/"]}"#))
        .await;
    assert_eq!(
        fewer.body,
        json!({"title_suffix": "desk", "rendered_sites": ["/srv/site/"], "rendered_site_roots": {"/srv/site/": "/srv/"}})
    );
    // Neither field: the title is read, and must be text, as in Bun.
    let neither = settings.instance_settings(put("{}")).await;
    assert_eq!(
        (neither.status, neither.body),
        (400, json!({"error": "Title suffix must be text"}))
    );
    let cleared = settings
        .instance_settings(put(r#"{"title_suffix": ""}"#))
        .await;
    assert_eq!(cleared.body["title_suffix"], "");
    let get = settings
        .instance_settings(InstanceRequest {
            method: "GET".into(),
            ..put("")
        })
        .await;
    assert_eq!(get.status, 200);
    assert!(get.written.is_none());
}

#[tokio::test]
async fn idle_stop_is_30_minutes_by_default_and_a_whole_number_up_to_a_day() {
    let home = tempfile::tempdir().unwrap();
    let settings = service(&home.path().join("settings.json"));
    let get = settings
        .rpc("settings.conversation.get", &json!({}), None, "")
        .await
        .unwrap();
    assert_eq!(get.result, json!({"idle_stop_minutes": 30}));
    for minutes in [json!(0), json!(1440)] {
        let set = settings
            .rpc(
                "settings.conversation.update",
                &json!({"idle_stop_minutes": minutes}),
                None,
                "",
            )
            .await
            .unwrap();
        assert_eq!(set.result["idle_stop_minutes"], minutes);
    }
    for minutes in [json!(1441), json!(1.5), json!("5"), json!(-1)] {
        assert_eq!(
            settings
                .rpc(
                    "settings.conversation.update",
                    &json!({"idle_stop_minutes": minutes}),
                    None,
                    ""
                )
                .await
                .unwrap_err(),
            "settings.conversation.update takes only idle_stop_minutes: a whole number of minutes from 0 (never) to 1440"
        );
    }
}

#[tokio::test]
async fn limit_resume_is_on_a_minute_after_the_reset_and_each_key_is_checked() {
    let home = tempfile::tempdir().unwrap();
    let settings = service(&home.path().join("settings.json"));
    let get = settings
        .rpc("settings.limit_resume.get", &json!({}), None, "")
        .await
        .unwrap();
    assert_eq!(get.result["enabled"], true);
    assert_eq!(get.result["margin_seconds"], 60);
    assert!(
        get.result["message"]
            .as_str()
            .unwrap()
            .starts_with("The usage limit has reset.")
    );
    let partial = settings
        .rpc(
            "settings.limit_resume.update",
            &json!({"margin_seconds": 0}),
            None,
            "",
        )
        .await
        .unwrap();
    assert_eq!(partial.result["margin_seconds"], 0);
    assert_eq!(partial.result["enabled"], true);
    for (params, error) in [
        (
            json!({"extra": 1}),
            "limit_resume takes enabled, message and margin_seconds, not extra",
        ),
        (
            json!({"message": "  "}),
            "limit_resume.message must be some text",
        ),
        (
            json!({"margin_seconds": 3601}),
            "limit_resume.margin_seconds must be a whole number of seconds from 0 to 3600",
        ),
    ] {
        assert_eq!(
            settings
                .rpc("settings.limit_resume.update", &params, None, "")
                .await
                .unwrap_err(),
            format!("settings.limit_resume.update: {error}")
        );
    }
}

#[tokio::test]
async fn invalid_or_oversized_instance_settings_never_reach_the_file() {
    let home = tempfile::tempdir().unwrap();
    let path = home.path().join("settings.json");
    let settings = service(&path);
    for request in [
        put(r#"{"title_suffix": 3}"#),
        put(r#"{"rendered_sites": "x"}"#),
        put(r#"{"rendered_site_roots": {"https://a.test/": " "}}"#),
        put(r#"{"rendered_site_roots": []}"#),
        put("not json"),
        InstanceRequest {
            body: InstanceBody::TooLarge,
            ..put("")
        },
        InstanceRequest {
            body: InstanceBody::Missing,
            ..put("")
        },
    ] {
        let answer = settings.instance_settings(request).await;
        assert!(matches!(answer.status, 400 | 413), "{}", answer.status);
        assert!(answer.written.is_none());
    }
    assert!(!path.exists());
}

#[tokio::test]
async fn settings_rpc_errors_carry_their_runtime_connection_identity() {
    let home = tempfile::tempdir().unwrap();
    let settings = service(&home.path().join("settings.json"));
    let error = settings
        .rpc("settings.unknown", &json!({}), Some("remote-dev"), "")
        .await
        .unwrap_err();
    let reply = crate::rpc_reply::ReplyEnvelope::new(Some("remote-dev"), Some(6))
        .error(Some(&Value::from("settings-id")), &error);
    assert_eq!(
        serde_json::from_str::<Value>(&reply.payload).unwrap(),
        json!({
            "connection_id": "remote-dev",
            "connection_generation": 6,
            "id": "settings-id",
            "error": { "message": "unknown settings method: settings.unknown" },
        })
    );
}

/// An absolute path to no file (a drive's on Windows).
const MISSING_SECRET: &str = if cfg!(windows) {
    r"C:\nonexistent\token"
} else {
    "/nonexistent/token"
};

#[tokio::test]
async fn agent_profiles_listed_with_the_built_in_secrets_by_path_validated_on_update() {
    let home = tempfile::tempdir().unwrap();
    let path = home.path().join("settings.json");
    let settings = service(&path);
    let read = settings.store().read().await;
    assert_eq!(
        profiles_reply(&read, home.path()),
        json!({
            "profiles": [{
                "name": "Claude",
                "agent": "claude",
                "builtin": true,
                "env": [],
                "unset": [],
                "label": "Claude",
            }],
            "default": "Claude",
            "return_after_reset": false,
        })
    );
    // Nothing written until the user saves profiles.
    assert!(!path.exists() || file(&path).get("profiles").is_none());
    let profiles = profiles_update(&json!({
        "list": [{
            "name": "Igalia GLM",
            "agent": "claude",
            "env": [
                {"name": "ANTHROPIC_MODEL", "value": "glm-5p3"},
                {"name": "ANTHROPIC_AUTH_TOKEN", "file": MISSING_SECRET},
            ],
            "unset": [],
        }],
        "default": "Claude",
        "return_after_reset": true,
    }))
    .unwrap();
    let written = settings
        .update(|current| current.with("profiles", Some(profiles)))
        .await
        .unwrap();
    let result = profiles_reply(&written.settings, home.path());
    assert_eq!(result["default"], "Claude");
    assert_eq!(result["return_after_reset"], true);
    let glm = &result["profiles"][1];
    assert_eq!(glm["name"], "Igalia GLM");
    assert_eq!(glm["label"], "GLM 5p3");
    assert_eq!(
        glm["env"][0],
        json!({"name": "ANTHROPIC_MODEL", "value": "glm-5p3"})
    );
    assert_eq!(glm["env"][1]["file"], MISSING_SECRET);
    assert!(
        glm["env"][1]["problem"]
            .as_str()
            .is_some_and(|problem| problem.contains("cannot be read"))
    );
    assert_eq!(
        file(&path)["profiles"]["list"][0]["env"]["ANTHROPIC_AUTH_TOKEN"],
        json!({"file": MISSING_SECRET})
    );
    for params in [
        json!({"list": [], "default": "Nope"}),
        json!({"list": [{"name": "", "agent": "claude", "env": []}], "default": "Claude"}),
        json!({"list": [], "default": "Claude", "other": 1}),
    ] {
        assert!(profiles_update(&params).is_err(), "{params}");
    }
    assert_eq!(
        file(&path)["profiles"]["list"].as_array().map(Vec::len),
        Some(1)
    );
}
