//! config/data-paths.test.ts.

use std::fs;
use std::path::{Path, PathBuf};

use super::*;

fn write(path: &Path, value: &str, mode: u32) {
    create_dir_all_mode(&dirname(path)).unwrap();
    fs::write(path, value).unwrap();
    crate::private::set_mode(path, mode).unwrap();
}

fn read(path: &Path) -> String {
    fs::read_to_string(path).unwrap()
}

fn names(dir: &Path) -> Vec<String> {
    let mut out: Vec<String> = fs::read_dir(dir)
        .unwrap()
        .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    out.sort();
    out
}

fn linux(home: &Path) -> DataContext {
    DataContext::new(home, Platform::Unix, None)
}

#[cfg(unix)]
fn mode(path: &Path) -> u32 {
    use std::os::unix::fs::PermissionsExt;
    fs::metadata(path).unwrap().permissions().mode() & 0o777
}

#[test]
fn data_roots_respect_appdata() {
    let home = tempfile::tempdir().unwrap();
    let root = home.path();
    assert_eq!(linux(root).data_root(), root.join(".config/roamgate"));
    let custom = DataContext::new(root, Platform::Windows, Some(root.join("custom")));
    assert_eq!(custom.data_root(), root.join("custom/roamgate"));
    let roaming = DataContext::new(root, Platform::Windows, None);
    assert_eq!(roaming.data_root(), root.join("AppData/Roaming/roamgate"));
    assert_eq!(
        roaming.legacy_data_root(),
        root.join("AppData/Roaming/herdr-gui")
    );
    let settings = linux(root).default_data_file(DataFile::Settings).unwrap();
    assert!(!settings.exists());
}

/// A node's data root replaces `~/.config/roamgate`: its files are its
/// own, and nothing of the home-style or legacy roots is copied in.
#[test]
fn a_node_data_root_takes_nothing_from_the_home_style_roots() {
    let home = tempfile::tempdir().unwrap();
    let root = home.path();
    write(&root.join(".config/roamgate/settings.json"), "{}\n", 0o600);
    write(
        &root.join(".config/herdr-gui/connections.json"),
        "{}\n",
        0o600,
    );
    let node_root = root.join(".config/roamgate-node");
    let env = [
        ("HOME", root.to_str().unwrap()),
        (crate::node::DATA_ROOT_ENV, node_root.to_str().unwrap()),
    ];
    let context = DataContext::from_env(&env);
    assert_eq!(context.data_root(), node_root);
    for file in [
        DataFile::Settings,
        DataFile::Connections,
        DataFile::AuthToken,
    ] {
        let path = context.default_data_file(file).unwrap();
        assert_eq!(path, node_root.join(file.name()));
        assert!(!path.exists(), "{}", file.name());
    }
}

#[test]
fn legacy_data_is_copied_without_resetting_credentials() {
    for platform in [Platform::Unix, Platform::Windows] {
        let home = tempfile::tempdir().unwrap();
        let root = home.path();
        let context = DataContext::new(root, platform, Some(root.join("AppData/Roaming")));
        let token = "c".repeat(64);
        let legacy_token = context.legacy_data_root().join("auth-token");
        write(&legacy_token, &format!("{token}\n"), 0o400);
        for file in [DataFile::Settings, DataFile::Connections] {
            let legacy = root.join(".config/herdr-gui").join(file.name());
            write(&legacy, "{\"version\":1}\n", 0o600);
            let target = context.default_data_file(file).unwrap();
            assert_eq!(target, context.data_root().join(file.name()));
            assert_eq!(read(&target), read(&legacy));
            assert_eq!(context.default_data_file(file).unwrap(), target);
        }
        let target = context.default_data_file(DataFile::AuthToken).unwrap();
        assert_eq!(read(&target), format!("{token}\n"));
        assert_eq!(read(&legacy_token), format!("{token}\n"));
        #[cfg(unix)]
        {
            assert_eq!(mode(&target), 0o400);
            assert_eq!(mode(&legacy_token), 0o400);
        }
    }
}

#[test]
fn new_values_win_even_empty_or_malformed() {
    let home = tempfile::tempdir().unwrap();
    let context = linux(home.path());
    let legacy = home.path().join(".config/herdr-gui/settings.json");
    let target = context.data_root().join("settings.json");
    write(&legacy, "old", 0o600);
    write(&target, "", 0o600);
    context.migrate_data_file(&target, &legacy, None).unwrap();
    assert_eq!(read(&target), "");
    write(&target, "new", 0o600);
    context.migrate_data_file(&target, &legacy, None).unwrap();
    assert_eq!(read(&target), "new");
    assert_eq!(read(&legacy), "old");
}

#[cfg(unix)]
#[test]
fn legacy_symlinks_are_refused_and_a_safe_retry_works() {
    let home = tempfile::tempdir().unwrap();
    let root = home.path();
    let context = linux(root);
    let legacy = root.join(".config/herdr-gui/auth-token");
    let target = context.data_root().join("auth-token");
    let secret = root.join("secret");
    write(&secret, &"d".repeat(64), 0o600);
    fs::create_dir_all(dirname(&legacy)).unwrap();
    std::os::unix::fs::symlink(&secret, &legacy).unwrap();
    let error = context
        .migrate_data_file(&target, &legacy, None)
        .unwrap_err();
    assert!(error.to_string().contains("symlink"), "{error}");
    assert!(!target.exists());
    fs::remove_file(&legacy).unwrap();
    write(&legacy, &"e".repeat(64), 0o600);
    context.migrate_data_file(&target, &legacy, None).unwrap();
    assert_eq!(read(&target), "e".repeat(64));
    assert_eq!(read(&secret), "d".repeat(64));
    let other = root.join("other/settings.json");
    std::os::unix::fs::symlink(dirname(&legacy), dirname(&other)).unwrap();
    let error = context
        .migrate_data_file(&context.data_root().join("settings.json"), &other, None)
        .unwrap_err();
    assert!(error.to_string().contains("symlink"), "{error}");
}

#[test]
fn failed_publication_leaves_nothing_and_never_overwrites() {
    let home = tempfile::tempdir().unwrap();
    let context = linux(home.path());
    let target = home.path().join("roamgate/settings.json");
    write(&dirname(&target), "not a directory", 0o600);
    assert!(context.publish_data_file(&target, b"first", 0o600).is_err());
    fs::remove_file(dirname(&target)).unwrap();
    context.publish_data_file(&target, b"first", 0o600).unwrap();
    context
        .publish_data_file(&target, b"second", 0o600)
        .unwrap();
    assert_eq!(read(&target), "first");
    assert_eq!(names(&dirname(&target)), vec!["settings.json"]);
}

#[test]
fn replacement_is_atomic_and_private() {
    let home = tempfile::tempdir().unwrap();
    let context = linux(home.path());
    let target = home.path().join("roamgate/roamgate.env");
    context.publish_data_file(&target, b"first", 0o644).unwrap();
    context
        .replace_data_file(&target, b"second", 0o600)
        .unwrap();
    assert_eq!(read(&target), "second");
    assert_eq!(names(&dirname(&target)), vec!["roamgate.env"]);
    #[cfg(unix)]
    {
        assert_eq!(mode(&target), 0o600);
        let link = home.path().join("roamgate/link.env");
        std::os::unix::fs::symlink(&target, &link).unwrap();
        let error = context
            .replace_data_file(&link, b"third", 0o600)
            .unwrap_err();
        assert!(error.to_string().contains("symlink"));
        assert_eq!(read(&target), "second");
    }
}

#[tokio::test]
async fn asynchronous_replacement_is_atomic_and_private() {
    let home = tempfile::tempdir().unwrap();
    let context = linux(home.path());
    let target = home.path().join("roamgate/leases.json");
    context
        .replace_data_file_async(&target, b"first".to_vec(), 0o644)
        .await
        .unwrap();
    context
        .replace_data_file_async(&target, b"second".to_vec(), 0o600)
        .await
        .unwrap();
    assert_eq!(read(&target), "second");
    assert_eq!(names(&dirname(&target)), vec!["leases.json"]);
    #[cfg(unix)]
    {
        assert_eq!(mode(&target), 0o600);
        let link = home.path().join("roamgate/link.json");
        std::os::unix::fs::symlink(&target, &link).unwrap();
        let error = context
            .replace_data_file_async(&link, b"third".to_vec(), 0o600)
            .await
            .unwrap_err();
        assert!(error.to_string().contains("symlink"));
        assert_eq!(read(&target), "second");
    }
}

#[tokio::test]
async fn a_failed_rename_leaves_no_temporary_file() {
    let home = tempfile::tempdir().unwrap();
    let context = linux(home.path());
    let target = home.path().join("roamgate/state.json");
    context.replace_data_file(&target, b"first", 0o600).unwrap();
    // A rename that fails after the temporary file is written: the target
    // is replaced by a non-empty directory the rename cannot overwrite.
    let blocked = home.path().join("roamgate/blocked.json");
    fs::create_dir_all(blocked.join("inside")).unwrap();
    assert!(
        context
            .replace_data_file(&blocked, b"second", 0o600)
            .is_err()
    );
    assert!(
        context
            .replace_data_file_async(&blocked, b"second".to_vec(), 0o600)
            .await
            .is_err()
    );
    assert_eq!(read(&target), "first");
    assert_eq!(names(&dirname(&target)), vec!["blocked.json", "state.json"]);
}

#[cfg(unix)]
#[test]
fn startup_removes_only_temporaries_left_before_it_started() {
    let base = tempfile::tempdir().unwrap();
    let root = base.path().join("roamgate");
    let started_at: i64 = 1_800_000_000_000;
    let before =
        std::time::UNIX_EPOCH + std::time::Duration::from_millis((started_at - 60_000) as u64);
    let after =
        std::time::UNIX_EPOCH + std::time::Duration::from_millis((started_at + 1_000) as u64);
    let set_time = |path: &Path, time| {
        fs::File::options()
            .write(true)
            .open(path)
            .unwrap()
            .set_modified(time)
            .unwrap();
    };
    let left = ".roamgate-0b6f3d1e-9a52-4c1e-8f3a-2d7e6c5b4a39.tmp";
    let nested = root.join("mr-reviews/efforts").join(left);
    let fresh = root.join(".roamgate-1c7a4e2f-0b63-4d2f-9a4b-3e8f7d6c5b4a.tmp");
    let others = [
        root.join("settings.json"),
        root.join(".roamgate-not-a-uuid.tmp"),
        root.join("other-0b6f3d1e-9a52-4c1e-8f3a-2d7e6c5b4a39.tmp"),
    ];
    for path in [root.join(left), nested.clone()]
        .iter()
        .chain(others.iter())
    {
        write(path, "x", 0o600);
        set_time(path, before);
    }
    write(&fresh, "x", 0o600);
    set_time(&fresh, after);
    let outside = base.path().join("elsewhere");
    write(&outside.join(left), "x", 0o600);
    set_time(&outside.join(left), before);
    std::os::unix::fs::symlink(&outside, root.join("linked")).unwrap();
    fs::create_dir_all(root.join("dir").join(left)).unwrap();

    assert_eq!(remove_leftover_data_temporaries(&root, started_at), 2);
    assert!(!root.join(left).exists());
    assert!(!nested.exists());
    assert!(fresh.exists());
    assert!(root.join("dir").join(left).exists());
    for path in &others {
        assert!(path.exists());
    }
    assert!(outside.join(left).exists());
    assert_eq!(
        remove_leftover_data_temporaries(&root.join("missing"), started_at),
        0
    );
}

#[test]
fn concurrent_first_use_publishes_one_complete_legacy_token() {
    let home = tempfile::tempdir().unwrap();
    let context = linux(home.path());
    let legacy = home.path().join(".config/herdr-gui/auth-token");
    write(&legacy, &format!("{}\n", "f".repeat(64)), 0o600);
    std::thread::scope(|scope| {
        for _ in 0..6 {
            scope.spawn(|| context.default_data_file(DataFile::AuthToken).unwrap());
        }
    });
    assert_eq!(
        read(&context.data_root().join("auth-token")),
        format!("{}\n", "f".repeat(64))
    );
    assert_eq!(names(&context.data_root()), vec!["auth-token"]);
}

#[test]
fn concurrent_publications_keep_one_complete_winner() {
    // The auth token's first creation (auth-token.ts) publishes through
    // publish_data_file: every writer must read back the same token.
    let home = tempfile::tempdir().unwrap();
    let context = linux(home.path());
    let target = context.data_root().join("auth-token");
    let tokens: Vec<String> = std::thread::scope(|scope| {
        let handles: Vec<_> = (0..6)
            .map(|_| {
                scope.spawn(|| {
                    let mine = format!("{}\n", hex::encode(rand::random::<[u8; 32]>()));
                    context
                        .publish_data_file(&target, mine.as_bytes(), 0o600)
                        .unwrap();
                    read(&target)
                })
            })
            .collect();
        handles
            .into_iter()
            .map(|handle| handle.join().unwrap())
            .collect()
    });
    assert!(tokens.iter().all(|token| token == &tokens[0]));
    assert_eq!(tokens[0].trim().len(), 64);
    assert_eq!(names(&dirname(&target)), vec!["auth-token"]);
}

#[cfg(unix)]
#[test]
fn unreadable_legacy_credentials_fail_rather_than_reset() {
    if rustix::process::getuid().is_root() {
        return;
    }
    let home = tempfile::tempdir().unwrap();
    let context = linux(home.path());
    let legacy = context.legacy_data_root().join("auth-token");
    write(&legacy, &"a".repeat(64), 0o600);
    crate::private::set_mode(&legacy, 0).unwrap();
    assert!(context.default_data_file(DataFile::AuthToken).is_err());
    crate::private::set_mode(&legacy, 0o600).unwrap();
    assert!(!context.data_root().join("auth-token").exists());
}

#[test]
fn invalid_legacy_settings_stop_migration() {
    let home = tempfile::tempdir().unwrap();
    let context = linux(home.path());
    let legacy = home.path().join(".config/herdr-gui/settings.json");
    write(&legacy, "{broken", 0o600);
    for _ in 0..2 {
        assert!(context.default_data_file(DataFile::Settings).is_err());
        assert!(!context.data_root().join("settings.json").exists());
    }
    assert_eq!(read(&legacy), "{broken");
}

#[test]
fn cleared_connections_stay_cleared_and_settings_migrate_privately() {
    let home = tempfile::tempdir().unwrap();
    let context = linux(home.path());
    let legacy_settings = home.path().join(".config/herdr-gui/settings.json");
    write(
        &legacy_settings,
        r#"{"version":1,"custom":{"saved":"kept"}}"#,
        0o644,
    );
    let settings = context.default_data_file(DataFile::Settings).unwrap();
    assert_eq!(read(&settings), read(&legacy_settings));
    #[cfg(unix)]
    assert_eq!(mode(&settings), 0o600);
    let registry = r#"{"version":1,"profiles":[]}"#;
    let legacy_connections = home.path().join(".config/herdr-gui/connections.json");
    write(&legacy_connections, registry, 0o600);
    let cleared = PathBuf::from(format!(
        "{}.legacy-cleared",
        context.data_root().join("connections.json").display()
    ));
    write(&cleared, "", 0o600);
    let connections = context.default_data_file(DataFile::Connections).unwrap();
    assert!(!connections.exists());
    assert_eq!(read(&legacy_connections), registry);
}

#[cfg(unix)]
#[test]
fn a_symlinked_user_config_root_is_followed_but_not_roamgates_links() {
    let home = tempfile::tempdir().unwrap();
    let root = home.path();
    let dotfiles = root.join("dotfiles/config");
    fs::create_dir_all(&dotfiles).unwrap();
    std::os::unix::fs::symlink(&dotfiles, root.join(".config")).unwrap();
    let context = linux(root);
    let token = context.default_data_file(DataFile::AuthToken).unwrap();
    context.publish_data_file(&token, b"t\n", 0o600).unwrap();
    assert_eq!(read(&dotfiles.join("roamgate/auth-token")), "t\n");
    context.default_data_file(DataFile::Settings).unwrap();

    fs::remove_dir_all(dotfiles.join("roamgate")).unwrap();
    let elsewhere = root.join("elsewhere");
    fs::create_dir(&elsewhere).unwrap();
    std::os::unix::fs::symlink(&elsewhere, dotfiles.join("roamgate")).unwrap();
    let error = context.default_data_file(DataFile::AuthToken).unwrap_err();
    assert!(
        error.to_string().contains("data path contains a symlink"),
        "{error}"
    );
}

#[test]
fn temporary_names_and_uuids() {
    let id = random_uuid();
    assert_eq!(id.len(), 36);
    assert_eq!(&id[14..15], "4");
    assert!(is_data_temporary(&format!(".roamgate-{id}.tmp")));
    assert!(!is_data_temporary(".roamgate-not-a-uuid.tmp"));
    assert!(!is_data_temporary(
        ".roamgate-0B6F3D1E-9A52-4C1E-8F3A-2D7E6C5B4A39.tmp"
    ));
}
