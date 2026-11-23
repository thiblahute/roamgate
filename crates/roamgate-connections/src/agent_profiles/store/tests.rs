//! server/src/profiles/profiles.test.ts: resolving a profile, the session
//! choices and the launches typed into panes.

use std::os::unix::fs::PermissionsExt;
use std::sync::atomic::{AtomicBool, AtomicI64, Ordering};

use super::*;
use crate::agent_profiles::shared::normalize_profiles_settings;
use roamgate_base::log::parse_iso_millis;

fn secret(dir: &Path, value: &str, mode: u32) -> PathBuf {
    let path = dir.join("token");
    std::fs::write(&path, value).unwrap();
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(mode)).unwrap();
    path
}

pub(crate) fn settings_with(dir: &Path, default: &str) -> Value {
    let token = secret(dir, "s3cret\n", 0o600);
    json!({
        "version": 1,
        "profiles": normalize_profiles_settings(Some(&json!({
            "list": [{
                "name": "GLM",
                "agent": "claude",
                "env": {
                    "ANTHROPIC_BASE_URL": "https://gw.example",
                    "ANTHROPIC_AUTH_TOKEN": {"file": token.to_str().unwrap()},
                    "ANTHROPIC_MODEL": "glm-5p3",
                },
            }],
            "default": default,
        }))),
    })
}

fn clock(start: i64) -> (Arc<AtomicI64>, NowMs) {
    let now = Arc::new(AtomicI64::new(start));
    let read = now.clone();
    (now, Arc::new(move || read.load(Ordering::SeqCst)))
}

fn store_at(file: Option<PathBuf>, now: Option<NowMs>) -> SessionProfiles {
    SessionProfiles::new(SessionProfilesOptions {
        file,
        data: DataContext::from_env(&roamgate_base::env::ProcessEnv),
        now,
        observer: None,
    })
}

fn home() -> PathBuf {
    PathBuf::from("/nonexistent-home")
}

#[test]
fn no_profiles_plain_claude_exactly_as_before() {
    assert_eq!(
        command_for_session(Some("s-1"), None, None, &home()).unwrap(),
        AgentCommand::plain_claude()
    );
    let warned = AtomicBool::new(false);
    assert_eq!(
        helper_command(None, None, &home(), &warned, |_| {}),
        CommandOrProgram::Program("claude".into())
    );
    assert!(as_command(Some(&CommandOrProgram::Program("claude".into()))).plain);
}

#[test]
fn a_secret_file_is_read_at_start_its_newline_dropped() {
    let dir = tempfile::tempdir().unwrap();
    let settings = settings_with(dir.path(), "GLM");
    let command = command_for_session(None, Some(&settings), None, &home()).unwrap();
    assert_eq!(command.profile, "GLM");
    assert_eq!(command.program, "claude");
    assert!(!command.plain);
    assert_eq!(
        command.env.iter().collect::<Vec<_>>(),
        vec![
            (
                &"ANTHROPIC_BASE_URL".to_owned(),
                &"https://gw.example".to_owned()
            ),
            (&"ANTHROPIC_AUTH_TOKEN".to_owned(), &"s3cret".to_owned()),
            (&"ANTHROPIC_MODEL".to_owned(), &"glm-5p3".to_owned()),
        ]
    );
    assert!(command.unset.contains(&"ANTHROPIC_API_KEY".to_owned()));
    let base: IndexMap<String, String> = [("ANTHROPIC_API_KEY", "pane"), ("PATH", "/bin")]
        .into_iter()
        .map(|(a, b)| (a.to_owned(), b.to_owned()))
        .collect();
    let mut expected = IndexMap::new();
    expected.insert("PATH".to_owned(), "/bin".to_owned());
    expected.extend(command.env.clone());
    let env = command_env(&command, &base);
    let mut got: Vec<_> = env.into_iter().collect();
    let mut want: Vec<_> = expected.into_iter().collect();
    got.sort();
    want.sort();
    assert_eq!(got, want);
}

#[test]
fn a_secret_others_can_read_is_refused_naming_the_file_only() {
    let dir = tempfile::tempdir().unwrap();
    let path = secret(dir.path(), "s3cret", 0o644);
    let error = read_secret_file(path.to_str().unwrap(), &home()).unwrap_err();
    assert!(error.contains("chmod 600"), "{error}");
    assert!(!error.contains("s3cret"));
    let missing = dir.path().join("missing");
    assert!(
        read_secret_file(missing.to_str().unwrap(), &home())
            .unwrap_err()
            .contains("cannot be read")
    );
    assert!(
        read_secret_file("relative/path", &home())
            .unwrap_err()
            .contains("absolute")
    );
}

#[test]
fn a_sessions_choice_wins_over_the_default() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("s.json");
    let store = store_at(Some(file.clone()), None);
    let settings = settings_with(dir.path(), "Claude");
    let name = |store: &SessionProfiles, id: &str| {
        profile_name(&profile_for_session(Some(&settings), Some(id), Some(store))).to_owned()
    };
    assert_eq!(name(&store, "s-1"), "Claude");
    store.set("s-1", Some("GLM"), None, None);
    assert_eq!(name(&store, "s-1"), "GLM");
    // Kept on disk.
    let again = store_at(Some(file), None);
    assert_eq!(again.get(Some("s-1")).unwrap()["profile"], json!("GLM"));
    // A profile since removed: the default.
    store.set("s-2", Some("Removed"), None, None);
    assert_eq!(name(&store, "s-2"), "Claude");
}

#[test]
fn sessions_sent_away_by_a_limit_are_due_back_after_its_reset() {
    let (now, read) = clock(1000);
    let store = store_at(None, Some(read));
    store.set("s-1", Some("GLM"), Some((5000, "Claude")), None);
    store.set("s-2", Some("GLM"), None, None);
    assert_eq!(store.due(), vec![]);
    now.store(5000, Ordering::SeqCst);
    assert_eq!(
        store.due(),
        vec![DueReturn {
            session_id: "s-1".into(),
            to: "Claude".into()
        }]
    );
}

#[test]
fn a_token_is_good_once_for_its_pane_for_a_while() {
    let (now, read) = clock(0);
    let launches = LaunchRegistry::new(Some(read), Some(1000));
    let spec = LaunchSpec {
        argv: vec!["claude".into()],
        env: [("A".to_owned(), "1".to_owned())].into_iter().collect(),
        unset: vec![],
        agent: "claude".into(),
        terminal: false,
    };
    let token = launches.register("c1", "p1", spec.clone());
    assert_eq!(token.len(), 32);
    assert!(
        token
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
    );
    assert_eq!(launches.take("c1", "p2", &token), None);
    assert_eq!(launches.take("c2", "p1", &token), None);
    assert_eq!(launches.take("c1", "p1", &token), Some(spec.clone()));
    assert_eq!(launches.take("c1", "p1", &token), None);
    let late = launches.register("c1", "p1", spec);
    now.store(1000, Ordering::SeqCst);
    assert_eq!(launches.take("c1", "p1", &late), None);
}

#[test]
fn a_profile_command_resolves_once_its_secret_reads() {
    let dir = tempfile::tempdir().unwrap();
    let settings = settings_with(dir.path(), "Claude");
    let profile = &settings["profiles"]["list"][0];
    assert_eq!(
        profile_command(profile, &home()).unwrap().env["ANTHROPIC_AUTH_TOKEN"],
        "s3cret"
    );
}

#[test]
fn every_start_has_it_until_the_session_answered_on_its_profile() {
    let store = store_at(None, None);
    store.set("s-1", None, None, Some("claude-opus-5-5"));
    assert_eq!(
        profile_name(&profile_for_session(None, Some("s-1"), Some(&store))),
        "Claude"
    );
    let command = command_for_session(Some("s-1"), None, Some(&store), &home()).unwrap();
    assert!(command.plain);
    assert_eq!(command.model.as_deref(), Some("claude-opus-5-5"));
    store.settle_model("s-1");
    assert_eq!(store.get(Some("s-1")), None);
    assert_eq!(
        command_for_session(Some("s-1"), None, Some(&store), &home())
            .unwrap()
            .model,
        None
    );
    // A chosen profile stays once its model settled.
    store.set("s-2", Some("GLM"), None, Some("glm-5p3"));
    store.settle_model("s-2");
    let choice = store.get(Some("s-2")).unwrap();
    assert_eq!(choice["profile"], json!("GLM"));
    assert!(choice.get("model").is_none());
}

#[test]
fn model_is_replaced_never_doubled() {
    let args = |list: &[&str]| list.iter().map(|s| (*s).to_owned()).collect::<Vec<_>>();
    assert_eq!(
        with_model(
            &args(&["--model", "opus", "--verbose"]),
            Some("claude-opus-5-5")
        ),
        args(&["--verbose", "--model", "claude-opus-5-5"])
    );
    assert_eq!(
        with_model(&args(&["--model=opus"]), Some("x")),
        args(&["--model", "x"])
    );
    assert_eq!(
        with_model(&args(&["--verbose"]), None),
        args(&["--verbose"])
    );
    assert_eq!(
        without_model(&args(&["--model", "opus", "--model=x", "--verbose"])),
        args(&["--verbose"])
    );
}

#[test]
fn model_kept_with_the_sessions_profile_until_it_answered_with_it() {
    let (now, read) = clock(parse_iso_millis("2026-11-06T10:00:00.000Z").unwrap());
    let store = store_at(None, Some(read));
    store.set("s-1", Some("GLM"), Some((9, "Claude")), Some("glm-5p3"));
    now.fetch_add(1000, Ordering::SeqCst);
    store.choose_model("s-1", Some("glm-5p3-flash"), Some("glm-5p3-flash"));
    assert_eq!(
        Value::Object(store.get(Some("s-1")).unwrap()).to_string(),
        json!({
            "profile": "GLM",
            "at": "2026-11-06T10:00:00.000Z",
            "return_at": 9,
            "return_to": "Claude",
            "model": "glm-5p3-flash",
            "model_at": "2026-11-06T10:00:01.000Z",
            "model_resolved": "glm-5p3-flash",
        })
        .to_string()
    );
    assert_eq!(
        command_for_session(Some("s-1"), None, Some(&store), &home())
            .unwrap()
            .model
            .as_deref(),
        Some("glm-5p3-flash")
    );
    store.settle_model("s-1");
    assert_eq!(
        Value::Object(store.get(Some("s-1")).unwrap()).to_string(),
        json!({
            "profile": "GLM",
            "at": "2026-11-06T10:00:00.000Z",
            "return_at": 9,
            "return_to": "Claude",
        })
        .to_string()
    );
    // On the default profile, the choice alone is kept, and dropped whole.
    store.choose_model("s-2", Some("sonnet"), None);
    let choice = store.get(Some("s-2")).unwrap();
    assert_eq!(choice["profile"], Value::Null);
    assert_eq!(choice["model"], json!("sonnet"));
    store.choose_model("s-2", None, None);
    assert_eq!(store.get(Some("s-2")), None);
}

#[test]
fn the_file_is_bun_s_text_and_reads_back() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("session-profiles.json");
    let (_, read) = clock(parse_iso_millis("2026-11-06T10:00:00.000Z").unwrap());
    let store = store_at(Some(file.clone()), Some(read));
    store.set("s-1", Some("GLM"), Some((5, "Claude")), None);
    store.set("s-2", None, None, Some("opus"));
    let text = std::fs::read_to_string(&file).unwrap();
    assert_eq!(
        text,
        "{\n  \"version\": 1,\n  \"sessions\": {\n    \"s-1\": {\n      \"profile\": \"GLM\",\n      \"at\": \"2026-11-06T10:00:00.000Z\",\n      \"return_at\": 5,\n      \"return_to\": \"Claude\"\n    },\n    \"s-2\": {\n      \"profile\": null,\n      \"at\": \"2026-11-06T10:00:00.000Z\",\n      \"model\": \"opus\"\n    }\n  }\n}\n"
    );
    assert_eq!(
        std::fs::metadata(&file).unwrap().permissions().mode() & 0o777,
        0o600
    );
    // Entries Bun drops on reading are dropped here too.
    std::fs::write(
        &file,
        r#"{"version":1,"sessions":{"a":{"profile":"X","at":"t"},"b":{"profile":null,"at":"t"},"c":{"at":"t"},"d":{"profile":null,"model":"m","at":"t"}}}"#,
    )
    .unwrap();
    let again = store_at(Some(file), None);
    assert_eq!(
        again.snapshot().keys().cloned().collect::<Vec<_>>(),
        vec!["a", "d"]
    );
}
