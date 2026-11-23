//! config/session-secret.test.ts.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Barrier;

use super::*;
use crate::paths::Platform;

const PASSWORD: &str = "correct horse battery staple";
const PIN: &str = "987654";

fn context(home: &Path) -> DataContext {
    DataContext::new(
        home,
        Platform::current(),
        Some(home.join("AppData/Roaming")),
    )
}

fn session_path(home: &Path) -> PathBuf {
    home.join("data/session-secret.json")
}

fn stored(path: &Path) -> Value {
    serde_json::from_str(&fs::read_to_string(path).unwrap()).unwrap()
}

fn names(dir: &Path) -> Vec<String> {
    let mut out: Vec<String> = fs::read_dir(dir)
        .unwrap()
        .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    out.sort();
    out
}

fn load(home: &Path, credentials: &[&str], path: &Path) -> Result<String, SessionSecretError> {
    load_or_create_session_secret(&context(home), credentials, path)
}

#[cfg(unix)]
fn mode(path: &Path) -> u32 {
    use std::os::unix::fs::PermissionsExt;
    fs::metadata(path).unwrap().permissions().mode() & 0o777
}

#[test]
fn persists_private_independent_random_material() {
    let home = tempfile::tempdir().unwrap();
    let other = tempfile::tempdir().unwrap();
    let path = session_path(home.path());
    let secret = load(home.path(), &[PASSWORD, PIN], &path).unwrap();
    assert!(is_hex64(&secret));
    assert_eq!(load(home.path(), &[PASSWORD, PIN], &path).unwrap(), secret);
    assert_ne!(
        load(other.path(), &[PASSWORD, PIN], &session_path(other.path())).unwrap(),
        secret
    );
    // The fingerprint is Node's createHmac over the sorted JSON set.
    let mut mac = <Hmac<Sha256> as Mac>::new_from_slice(&hex::decode(&secret).unwrap()).unwrap();
    mac.update(b"roamgate:session-credentials:v1\0");
    mac.update(format!("[\"{PIN}\",\"{PASSWORD}\"]").as_bytes());
    let expected = hex::encode(mac.finalize().into_bytes());
    assert_eq!(
        fs::read_to_string(&path).unwrap(),
        format!(
            "{{\"version\":1,\"secret\":\"{secret}\",\"credentialFingerprint\":\"{expected}\"}}\n"
        )
    );
    assert!(!fs::read_to_string(&path).unwrap().contains(PASSWORD));
    assert_eq!(names(&dirname(&path)), vec!["session-secret.json"]);
    #[cfg(unix)]
    {
        assert_eq!(mode(&path), 0o600);
        assert_eq!(mode(&dirname(&path)), 0o700);
    }
}

#[test]
fn the_default_path_survives_a_restart() {
    let home = tempfile::tempdir().unwrap();
    let context = context(home.path());
    let none: [(&str, &str); 0] = [];
    let path = session_secret_path_from_env(&none, &context.data_root());
    assert_eq!(path, context.data_root().join("session-secret.json"));
    let first = load_or_create_session_secret(&context, &[PASSWORD], &path).unwrap();
    let again = load_or_create_session_secret(&context, &[PASSWORD], &path).unwrap();
    assert_eq!(first, again);
    assert_eq!(stored(&path)["secret"], first.as_str());
}

#[test]
fn signing_state_is_isolated_by_the_effective_settings_path() {
    let home = tempfile::tempdir().unwrap();
    let root = context(home.path()).data_root();
    let a = home.path().join("a.json").to_string_lossy().into_owned();
    let b = home.path().join("b.json").to_string_lossy().into_owned();
    let path_for = |current: Option<&str>, legacy: Option<&str>| {
        let mut env = std::collections::HashMap::new();
        if let Some(current) = current {
            env.insert("ROAMGATE_SETTINGS_PATH".to_owned(), current.to_owned());
        }
        if let Some(legacy) = legacy {
            env.insert("HERDR_GUI_SETTINGS_PATH".to_owned(), legacy.to_owned());
        }
        session_secret_path_from_env(&env, &root)
    };
    let load_at = |path: PathBuf| load(home.path(), &[PASSWORD], &path).unwrap();
    let default_secret = load_at(path_for(None, None));
    let secret_a = load_at(path_for(Some(&a), None));
    let secret_b = load_at(path_for(Some(&b), None));
    assert_ne!(default_secret, secret_a);
    assert_ne!(secret_a, secret_b);
    assert_ne!(default_secret, secret_b);
    assert_eq!(load_at(path_for(Some(&a), Some(&b))), secret_a);
    assert_eq!(load_at(path_for(None, Some(&a))), secret_a);
    assert_eq!(load_at(path_for(Some(""), Some(&a))), default_secret);
    // A relative path is resolved against the working directory first.
    let relative = session_secret_path(Some("./a.json"), &root);
    let absolute = session_secret_path(
        Some(
            &std::env::current_dir()
                .unwrap()
                .join("a.json")
                .to_string_lossy(),
        ),
        &root,
    );
    assert_eq!(relative, absolute);
    let hash = hex::encode(Sha256::digest(a.as_bytes()));
    assert_eq!(
        stored(&root.join(format!("session-secret-{hash}.json")))["secret"],
        secret_a.as_str()
    );
    assert_eq!(names(&root).len(), 3);
    assert!(!Path::new(&a).exists());
}

#[test]
fn the_fingerprint_is_of_the_credential_set() {
    let home = tempfile::tempdir().unwrap();
    let path = session_path(home.path());
    let credentials = [PASSWORD, PIN];
    let secret = load(home.path(), &credentials, &path).unwrap();
    assert_eq!(
        load(home.path(), &[PIN, PASSWORD, PIN], &path).unwrap(),
        secret
    );
    assert_eq!(credentials, [PASSWORD, PIN]);
}

#[test]
fn rotates_on_every_change_without_reviving_old_keys() {
    let home = tempfile::tempdir().unwrap();
    let path = session_path(home.path());
    let changed = format!("{PASSWORD} changed");
    let sets: Vec<Vec<&str>> = vec![
        vec![PASSWORD],
        vec![PASSWORD, PIN],
        vec![PASSWORD, "1234"],
        vec![PASSWORD],
        vec![&changed],
        vec![PASSWORD],
        vec![],
        vec![PASSWORD],
    ];
    let mut secrets = std::collections::HashSet::new();
    for set in &sets {
        let secret = load(home.path(), set, &path).unwrap();
        assert_eq!(load(home.path(), set, &path).unwrap(), secret);
        assert_eq!(stored(&path)["secret"], secret.as_str());
        secrets.insert(secret);
    }
    assert_eq!(secrets.len(), sets.len());
    assert_eq!(names(&dirname(&path)), vec!["session-secret.json"]);
}

#[test]
fn concatenated_or_escaped_credentials_differ() {
    let home = tempfile::tempdir().unwrap();
    let path = session_path(home.path());
    let sets: [&[&str]; 5] = [
        &["ab", "c"],
        &["a", "bc"],
        &["a\0b"],
        &["a", "b"],
        &["a ", "b"],
    ];
    let secrets: std::collections::HashSet<String> = sets
        .iter()
        .map(|set| load(home.path(), set, &path).unwrap())
        .collect();
    assert_eq!(secrets.len(), sets.len());
    // JavaScript's sort is by UTF-16 code units: an astral character sorts
    // before U+FFFD, unlike a sort by code points.
    let secret = "0".repeat(64);
    assert_eq!(
        credential_fingerprint(&secret, &["\u{fffd}", "\u{1f600}"]),
        credential_fingerprint(&secret, &["\u{1f600}", "\u{fffd}"])
    );
}

#[cfg(unix)]
#[test]
fn permissions_are_repaired_and_the_key_kept() {
    let home = tempfile::tempdir().unwrap();
    let path = session_path(home.path());
    let secret = load(home.path(), &[PASSWORD], &path).unwrap();
    crate::private::set_mode(&path, 0o644).unwrap();
    assert_eq!(load(home.path(), &[PASSWORD], &path).unwrap(), secret);
    assert_eq!(mode(&path), 0o600);
    load(home.path(), &[PASSWORD, PIN], &path).unwrap();
    assert_eq!(mode(&path), 0o600);
}

#[test]
fn malformed_or_unsupported_state_is_refused_and_kept() {
    let home = tempfile::tempdir().unwrap();
    let path = session_path(home.path());
    load(home.path(), &[PASSWORD], &path).unwrap();
    let state = stored(&path);
    let with = |key: &str, value: Value| {
        let mut changed = state.clone();
        changed[key] = value;
        changed.to_string()
    };
    let invalid = vec![
        String::new(),
        "{broken".into(),
        "null".into(),
        "[]".into(),
        with("version", 2.into()),
        with("secret", PASSWORD.into()),
        with("secret", "a".repeat(63).into()),
        with("secret", "G".repeat(64).into()),
        with("credentialFingerprint", "not-a-fingerprint".into()),
        serde_json::json!({"version": 1, "secret": state["secret"]}).to_string(),
        with("unexpected", true.into()),
        format!("{}{}", " ".repeat(4097), state),
    ];
    for contents in invalid {
        fs::write(&path, &contents).unwrap();
        for credentials in [[PASSWORD], ["changed"]] {
            let error = load(home.path(), &credentials, &path).unwrap_err();
            assert!(
                error.to_string().contains("Invalid session signing state"),
                "{error}"
            );
        }
        assert_eq!(fs::read_to_string(&path).unwrap(), contents);
        assert_eq!(names(&dirname(&path)), vec!["session-secret.json"]);
    }
}

#[cfg(unix)]
#[test]
fn unreadable_state_fails_closed() {
    if rustix::process::getuid().is_root() {
        return;
    }
    let home = tempfile::tempdir().unwrap();
    let path = session_path(home.path());
    load(home.path(), &[PASSWORD], &path).unwrap();
    let contents = fs::read_to_string(&path).unwrap();
    crate::private::set_mode(&path, 0).unwrap();
    assert!(load(home.path(), &["changed"], &path).is_err());
    crate::private::set_mode(&path, 0o600).unwrap();
    assert_eq!(fs::read_to_string(&path).unwrap(), contents);
}

#[cfg(unix)]
#[test]
fn state_file_symlinks_are_refused_even_dangling() {
    let home = tempfile::tempdir().unwrap();
    let path = session_path(home.path());
    load(home.path(), &[PASSWORD], &path).unwrap();
    let target = home.path().join("target");
    let contents = fs::read_to_string(&path).unwrap();
    fs::write(&target, &contents).unwrap();
    fs::remove_file(&path).unwrap();
    std::os::unix::fs::symlink(&target, &path).unwrap();
    let error = load(home.path(), &[PASSWORD, PIN], &path).unwrap_err();
    assert!(error.to_string().contains("symlink"), "{error}");
    assert_eq!(fs::read_to_string(&target).unwrap(), contents);
    fs::remove_file(&target).unwrap();
    let error = load(home.path(), &[PASSWORD], &path).unwrap_err();
    assert!(error.to_string().contains("symlink"), "{error}");
    assert!(!target.exists());
}

#[cfg(unix)]
#[test]
fn symlinked_directories_and_non_file_state_are_refused() {
    let home = tempfile::tempdir().unwrap();
    let target = home.path().join("target");
    fs::create_dir(&target).unwrap();
    let path = session_path(home.path());
    std::os::unix::fs::symlink(&target, dirname(&path)).unwrap();
    let error = load(home.path(), &[PASSWORD], &path).unwrap_err();
    assert!(error.to_string().contains("symlink"), "{error}");
    assert!(names(&target).is_empty());
    fs::remove_file(dirname(&path)).unwrap();
    fs::create_dir_all(&path).unwrap();
    let error = load(home.path(), &[PASSWORD], &path).unwrap_err();
    assert!(error.to_string().contains("file type"), "{error}");
}

#[cfg(unix)]
#[test]
fn hard_linked_state_is_refused() {
    let home = tempfile::tempdir().unwrap();
    let path = session_path(home.path());
    load(home.path(), &[PASSWORD], &path).unwrap();
    let original = fs::read_to_string(&path).unwrap();
    fs::hard_link(&path, home.path().join("hard-link")).unwrap();
    let error = load(home.path(), &[PASSWORD, PIN], &path).unwrap_err();
    assert!(
        error
            .to_string()
            .contains("Invalid session signing state file"),
        "{error}"
    );
    assert_eq!(fs::read_to_string(&path).unwrap(), original);
}

#[cfg(unix)]
#[test]
fn symlinked_or_malformed_locks_are_refused() {
    let home = tempfile::tempdir().unwrap();
    let path = session_path(home.path());
    let original = load(home.path(), &[PASSWORD], &path).unwrap();
    let target = home.path().join("target");
    fs::create_dir(&target).unwrap();
    let lock = lock_path(&path);
    std::os::unix::fs::symlink(&target, &lock).unwrap();
    let error = load(home.path(), &[PASSWORD], &path).unwrap_err();
    assert!(
        error
            .to_string()
            .contains("Invalid session signing state lock"),
        "{error}"
    );
    fs::remove_file(&lock).unwrap();
    fs::write(&lock, "not a directory").unwrap();
    let error = load(home.path(), &[PASSWORD], &path).unwrap_err();
    assert!(
        error
            .to_string()
            .contains("Invalid session signing state lock"),
        "{error}"
    );
    fs::remove_file(&lock).unwrap();
    assert_eq!(load(home.path(), &[PASSWORD], &path).unwrap(), original);
}

#[allow(clippy::disallowed_methods)]
#[test]
fn an_old_orphan_lock_times_out_and_is_never_stolen() {
    let home = tempfile::tempdir().unwrap();
    let path = session_path(home.path());
    load(home.path(), &[PASSWORD], &path).unwrap();
    let original = fs::read_to_string(&path).unwrap();
    let lock = lock_path(&path);
    fs::create_dir(&lock).unwrap();
    fs::File::open(&lock)
        .unwrap()
        .set_modified(std::time::UNIX_EPOCH)
        .unwrap();
    let start = std::time::Instant::now();
    let error = load(home.path(), &[PASSWORD, PIN], &path).unwrap_err();
    assert!(
        error
            .to_string()
            .contains("remove this lock only after stopping all processes sharing this state"),
        "{error}"
    );
    assert!(start.elapsed() < Duration::from_secs(8));
    assert_eq!(fs::read_to_string(&path).unwrap(), original);
    assert!(lock.exists());
    fs::remove_dir(&lock).unwrap();
    let rotated = load(home.path(), &[PASSWORD, PIN], &path).unwrap();
    assert_ne!(Value::String(rotated), stored_secret(&original));
}

fn stored_secret(text: &str) -> Value {
    serde_json::from_str::<Value>(text).unwrap()["secret"].clone()
}

fn concurrent(home: &Path, path: &Path, credentials: &[&str]) -> Vec<String> {
    let barrier = Barrier::new(8);
    std::thread::scope(|scope| {
        let handles: Vec<_> = (0..8)
            .map(|_| {
                scope.spawn(|| {
                    barrier.wait();
                    load(home, credentials, path).unwrap()
                })
            })
            .collect();
        handles
            .into_iter()
            .map(|handle| handle.join().unwrap())
            .collect()
    })
}

#[test]
fn concurrent_first_starts_converge_on_one_secret() {
    let home = tempfile::tempdir().unwrap();
    let path = session_path(home.path());
    let secrets = concurrent(home.path(), &path, &[PASSWORD, PIN]);
    assert!(secrets.iter().all(|secret| secret == &secrets[0]));
    assert_eq!(stored(&path)["secret"], secrets[0].as_str());
    assert_eq!(
        load(home.path(), &[PASSWORD, PIN], &path).unwrap(),
        secrets[0]
    );
    assert_eq!(names(&dirname(&path)), vec!["session-secret.json"]);
}

#[test]
fn concurrent_rotations_converge_without_reviving() {
    let home = tempfile::tempdir().unwrap();
    let path = session_path(home.path());
    let original = load(home.path(), &[PASSWORD], &path).unwrap();
    let changed = concurrent(home.path(), &path, &[PASSWORD, PIN]);
    assert!(changed.iter().all(|secret| secret == &changed[0]));
    assert_ne!(changed[0], original);
    let reverted = concurrent(home.path(), &path, &[PASSWORD]);
    assert!(reverted.iter().all(|secret| secret == &reverted[0]));
    assert_ne!(reverted[0], original);
    assert_ne!(reverted[0], changed[0]);
    assert_eq!(stored(&path)["secret"], reverted[0].as_str());
    assert_eq!(names(&dirname(&path)), vec!["session-secret.json"]);
}

#[test]
fn a_live_lock_holder_is_waited_for() {
    // The same with a Bun holder is tests/lock_coexistence.rs.
    let home = tempfile::tempdir().unwrap();
    let path = session_path(home.path());
    let original = load(home.path(), &[PASSWORD], &path).unwrap();
    let held = crate::lock::try_lock(&path, SESSION_LOCK).unwrap();
    let releaser = std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(250));
        drop(held);
    });
    assert_eq!(load(home.path(), &[PASSWORD], &path).unwrap(), original);
    releaser.join().unwrap();
    assert!(!lock_path(&path).exists());
}

#[test]
fn revoking_removes_the_secret() {
    let home = tempfile::tempdir().unwrap();
    let context = context(home.path());
    let root = home.path().join(".config/roamgate");
    let path = session_secret_path(None, &root);
    assert_eq!(path, root.join("session-secret.json"));
    assert!(!revoke_session_secret(&context, &path).unwrap());
    let original = load_or_create_session_secret(&context, &[PASSWORD], &path).unwrap();
    assert!(revoke_session_secret(&context, &path).unwrap());
    assert!(!path.exists());
    assert_ne!(
        load_or_create_session_secret(&context, &[PASSWORD], &path).unwrap(),
        original
    );
}

#[test]
fn the_path_is_keyed_by_the_settings_file() {
    let home = tempfile::tempdir().unwrap();
    let root = home.path().join("data");
    let settings = root.join("custom-settings.json");
    let text = settings.to_string_lossy().into_owned();
    assert_eq!(
        session_secret_path(Some(&text), &root),
        root.join(format!(
            "session-secret-{}.json",
            hex::encode(Sha256::digest(text.as_bytes()))
        ))
    );
}
