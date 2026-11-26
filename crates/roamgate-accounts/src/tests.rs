use std::path::Path;

use serde_json::{Value, json};

use super::*;

fn env_of(launch: &LaunchEnv, name: &str) -> Option<String> {
    launch
        .set
        .iter()
        .find(|(key, _)| key == name)
        .map(|(_, value)| value.clone())
}

#[test]
fn agents_and_states_have_their_wire_names() {
    for agent in AccountAgent::ALL {
        assert_eq!(AccountAgent::from_id(agent.id()), Some(agent));
    }
    assert_eq!(AccountAgent::from_id("pi"), None);
    assert_eq!(AuthState::NeedsRelogin.as_str(), "needs_relogin");
}

#[test]
fn an_account_lives_under_the_data_root() {
    let root = Path::new("/data/roamgate");
    assert_eq!(
        account_dir(root, AccountAgent::Codex, "work"),
        Path::new("/data/roamgate/accounts/codex/work")
    );
}

#[test]
fn each_agent_starts_on_its_account_directory() {
    let dir = Path::new("/d/acct");
    let claude = launch_env(AccountAgent::Claude, dir);
    assert_eq!(
        env_of(&claude, "CLAUDE_CONFIG_DIR").as_deref(),
        Some("/d/acct")
    );
    assert!(claude.unset.contains(&"CLAUDE_CODE_OAUTH_TOKEN".to_owned()));

    let codex = launch_env(AccountAgent::Codex, dir);
    assert_eq!(env_of(&codex, "CODEX_HOME").as_deref(), Some("/d/acct"));
    assert!(codex.unset.contains(&"OPENAI_API_KEY".to_owned()));

    let agy = launch_env(AccountAgent::Agy, dir);
    let home = agy_home(dir).to_string_lossy().into_owned();
    assert_eq!(env_of(&agy, "HOME"), Some(home.clone()));
    assert!(
        env_of(&agy, "XDG_CONFIG_HOME")
            .unwrap()
            .starts_with(home.as_str())
    );
    if cfg!(windows) {
        assert_eq!(env_of(&agy, "USERPROFILE"), Some(home));
    } else {
        // The session bus is hidden: an address no bus listens on.
        let bus = env_of(&agy, "DBUS_SESSION_BUS_ADDRESS").unwrap();
        assert!(bus.starts_with("unix:path=") && bus.contains(home.as_str()));
    }
    assert!(agy.unset.contains(&"ANTIGRAVITY_HOME".to_owned()));
}

#[test]
fn the_sign_in_state_comes_from_the_credential_file() {
    let temp = tempfile::tempdir().unwrap();
    let dir = temp.path();
    assert_eq!(auth_state(AccountAgent::Codex, dir), AuthState::SignedOut);
    std::fs::write(dir.join("auth.json"), "{}").unwrap();
    assert_eq!(auth_state(AccountAgent::Codex, dir), AuthState::SignedIn);
    std::fs::write(dir.join(".credentials.json"), "{}").unwrap();
    let claude = if cfg!(target_os = "macos") {
        AuthState::Unknown
    } else {
        AuthState::SignedIn
    };
    assert_eq!(auth_state(AccountAgent::Claude, dir), claude);
    assert_eq!(auth_state(AccountAgent::Agy, dir), AuthState::Unknown);
}

#[test]
fn the_data_root_follows_the_environment() {
    let home = Path::new("/home/u");
    let none = |_: &str| None;
    let expected = match roamgate_base::paths::Platform::current() {
        roamgate_base::paths::Platform::Windows => home.join("AppData").join("Roaming"),
        roamgate_base::paths::Platform::Unix => home.join(".config"),
    }
    .join("roamgate");
    assert_eq!(data_root_of(home, &none), expected);
    let node = |name: &str| (name == "ROAMGATE_DATA_ROOT").then(|| "/node".to_owned());
    assert_eq!(data_root_of(home, &node), Path::new("/node"));
}

#[test]
fn user_dirs_honour_the_agents_variables() {
    let home = Path::new("/home/u");
    let dirs = UserDirs::of(home, &|_| None);
    assert_eq!(dirs.claude_dir, home.join(".claude"));
    assert_eq!(dirs.claude_json, home.join(".claude.json"));
    assert_eq!(dirs.codex_home, home.join(".codex"));
    let dirs = UserDirs::of(home, &|name| match name {
        "CLAUDE_CONFIG_DIR" => Some("/c".into()),
        "CODEX_HOME" => Some("/x".into()),
        _ => None,
    });
    assert_eq!(dirs.claude_dir, Path::new("/c"));
    assert_eq!(dirs.claude_json, Path::new("/c/.claude.json"));
    assert_eq!(dirs.codex_home, Path::new("/x"));
}

fn user_dirs(home: &Path) -> UserDirs {
    UserDirs::of(home, &|_| None)
}

fn read_json(path: &Path) -> Value {
    serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
}

#[test]
fn a_claude_account_shares_all_but_its_sign_in() {
    let temp = tempfile::tempdir().unwrap();
    let home = temp.path().join("home");
    let claude = home.join(".claude");
    std::fs::create_dir_all(claude.join("plugins")).unwrap();
    std::fs::write(claude.join("settings.json"), "{}").unwrap();
    std::fs::write(claude.join(".credentials.json"), "user's").unwrap();
    std::fs::write(
        home.join(".claude.json"),
        json!({
            "userID": "u",
            "oauthAccount": {"emailAddress": "me@user"},
            "mcpServers": {"a": {"command": "a"}},
        })
        .to_string(),
    )
    .unwrap();
    let dir = temp.path().join("data/accounts/claude/work");

    let prepared = prepare(AccountAgent::Claude, &dir, &user_dirs(&home)).unwrap();

    // Never the user's sign-in.
    assert!(std::fs::symlink_metadata(dir.join(".credentials.json")).is_err());
    assert_eq!(
        std::fs::read_to_string(claude.join(".credentials.json")).unwrap(),
        "user's"
    );
    // Its own .claude.json, without the user's account.
    let own = read_json(&dir.join(".claude.json"));
    assert_eq!(own["userID"], "u");
    assert!(own.get("oauthAccount").is_none());
    assert!(prepared.copied.contains(&".claude.json".to_owned()));
    // The stores exist in the user's directory, so transcripts land there.
    assert!(claude.join("projects").is_dir());
    if cfg!(unix) {
        for name in ["settings.json", "plugins", "projects", "sessions", "jobs"] {
            assert!(prepared.linked.contains(&name.to_owned()), "{name}");
            assert_eq!(
                std::fs::read_link(dir.join(name)).unwrap(),
                claude.join(name)
            );
        }
        // Its transcripts are the user's: no root of its own to scan.
        let data = temp.path().join("data");
        assert!(session_roots(&data, AccountAgent::Claude).is_empty());
    }

    // An MCP server the user adds reaches the account on its next start;
    // the account's sign-in stays.
    let mut with_account = own.clone();
    with_account["oauthAccount"] = json!({"emailAddress": "me@work"});
    with_account["mcpServers"]["mine"] = json!({"command": "m"});
    std::fs::write(dir.join(".claude.json"), with_account.to_string()).unwrap();
    std::fs::write(
        home.join(".claude.json"),
        json!({"mcpServers": {"a": {"command": "a2"}, "b": {"command": "b"}}}).to_string(),
    )
    .unwrap();
    prepare(AccountAgent::Claude, &dir, &user_dirs(&home)).unwrap();
    let own = read_json(&dir.join(".claude.json"));
    assert_eq!(own["oauthAccount"]["emailAddress"], "me@work");
    assert_eq!(
        own["mcpServers"],
        json!({"a": {"command": "a2"}, "mine": {"command": "m"}, "b": {"command": "b"}})
    );
}

#[cfg(unix)]
#[test]
fn a_dangling_link_is_dropped_and_an_own_entry_kept() {
    let temp = tempfile::tempdir().unwrap();
    let home = temp.path().join("home");
    let claude = home.join(".claude");
    std::fs::create_dir_all(&claude).unwrap();
    std::fs::write(claude.join("CLAUDE.md"), "notes").unwrap();
    let dir = temp.path().join("acct");
    std::fs::create_dir_all(&dir).unwrap();
    std::os::unix::fs::symlink(temp.path().join("gone"), dir.join("old")).unwrap();
    std::fs::write(dir.join("CLAUDE.md"), "the account's").unwrap();

    let prepared = prepare(AccountAgent::Claude, &dir, &user_dirs(&home)).unwrap();

    assert!(std::fs::symlink_metadata(dir.join("old")).is_err());
    assert!(prepared.own.contains(&"CLAUDE.md".to_owned()));
    assert_eq!(
        std::fs::read_to_string(dir.join("CLAUDE.md")).unwrap(),
        "the account's"
    );
}

#[test]
fn a_codex_account_keeps_its_auth_and_shares_its_config() {
    let temp = tempfile::tempdir().unwrap();
    let home = temp.path().join("home");
    let codex = home.join(".codex");
    std::fs::create_dir_all(&codex).unwrap();
    std::fs::write(codex.join("config.toml"), "model = \"x\"").unwrap();
    std::fs::write(codex.join("auth.json"), "user's").unwrap();
    let dir = temp.path().join("acct");

    let prepared = prepare(AccountAgent::Codex, &dir, &user_dirs(&home)).unwrap();

    assert!(std::fs::symlink_metadata(dir.join("auth.json")).is_err());
    assert_eq!(
        std::fs::read_to_string(dir.join("config.toml")).unwrap(),
        "model = \"x\""
    );
    assert!(codex.join("sessions").is_dir());
    if cfg!(unix) {
        assert_eq!(prepared.linked, vec!["config.toml", "sessions"]);
    }
}

#[test]
fn nothing_of_the_user_is_needed() {
    let temp = tempfile::tempdir().unwrap();
    let home = temp.path().join("empty-home");
    let dir = temp.path().join("acct");
    let prepared = prepare(AccountAgent::Claude, &dir, &user_dirs(&home)).unwrap();
    assert_eq!(prepared, Prepared::default());
    assert!(dir.is_dir());
    assert!(!home.exists());
}

#[test]
fn an_agy_account_gets_a_home_of_its_own_and_nothing_else() {
    let temp = tempfile::tempdir().unwrap();
    let home = temp.path().join("home");
    std::fs::create_dir_all(home.join(".gemini")).unwrap();
    let dir = temp.path().join("acct");
    let prepared = prepare(AccountAgent::Agy, &dir, &user_dirs(&home)).unwrap();
    assert_eq!(prepared, Prepared::default());
    assert!(agy_home(&dir).is_dir());
    assert_eq!(std::fs::read_dir(agy_home(&dir)).unwrap().count(), 0);
}

#[test]
fn sessions_kept_apart_are_found_per_account() {
    let temp = tempfile::tempdir().unwrap();
    let data = temp.path();
    let claude = account_dir(data, AccountAgent::Claude, "work");
    std::fs::create_dir_all(claude.join("projects")).unwrap();
    // Not an account: its name is no account id.
    std::fs::create_dir_all(accounts_root(data).join("claude").join("Bad Name/projects")).unwrap();
    let codex = account_dir(data, AccountAgent::Codex, "perso");
    std::fs::create_dir_all(codex.join("sessions")).unwrap();
    std::fs::create_dir_all(codex.join("archived_sessions")).unwrap();
    let agy = account_dir(data, AccountAgent::Agy, "a");
    std::fs::create_dir_all(agy_conversations_root(&agy)).unwrap();

    assert_eq!(
        session_roots(data, AccountAgent::Claude),
        vec![claude.join("projects")]
    );
    assert_eq!(
        session_roots(data, AccountAgent::Codex),
        vec![codex.join("sessions")]
    );
    assert_eq!(
        codex_session_dirs(data),
        vec![codex.join("sessions"), codex.join("archived_sessions")]
    );
    assert_eq!(
        session_roots(data, AccountAgent::Agy),
        vec![agy_conversations_root(&agy)]
    );
}
