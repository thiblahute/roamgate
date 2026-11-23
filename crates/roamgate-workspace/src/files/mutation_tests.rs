//! file-mutations.test.ts: file.mkdir and file.move here and on an SSH
//! host (its scripts run by `bash -c`).

use std::fs;
use std::path::{Path, PathBuf};

use roamgate_git::shell_quote;
use serde_json::{Value, json};

use super::*;
use crate::atomic_move::REMOTE_EXCLUSIVE_RENAME;
use crate::test_support::{Loopback, connection};

struct Fixture {
    _dir: tempfile::TempDir,
    root: PathBuf,
    outside: PathBuf,
    conn: WorkspaceConnection,
    files: Files,
}

fn fixture(remote: bool, transform: impl Fn(&str) -> String + Send + Sync + 'static) -> Fixture {
    let dir = tempfile::Builder::new()
        .prefix("roamgate-mutations-")
        .tempdir()
        .unwrap();
    let root = dir.path().join("checkout");
    let outside = dir.path().join("outside");
    fs::create_dir(&root).unwrap();
    fs::create_dir(&outside).unwrap();
    let checkout = root.to_str().unwrap().to_owned();
    let (conn, _) = connection(
        remote.then_some("example.invalid"),
        Loopback::with(transform),
        move |_, _| {
            Ok(
                json!({ "workspace": { "workspace_id": "w1", "worktree": { "checkout_path": checkout } } }),
            )
        },
    );
    Fixture {
        _dir: dir,
        root,
        outside,
        conn,
        files: Files::new(),
    }
}

fn plain(remote: bool) -> Fixture {
    fixture(remote, |command| command.to_owned())
}

impl Fixture {
    async fn mkdir(&self, params: Value) -> RpcResult {
        self.call("file.mkdir", params).await
    }

    async fn moving(&self, params: Value) -> RpcResult {
        self.call("file.move", params).await
    }

    async fn call(&self, method: &str, mut params: Value) -> RpcResult {
        let anonymous = params.get("no_id").is_some();
        if let Some(map) = params.as_object_mut() {
            map.remove("no_id");
            if !anonymous {
                map.insert("workspace_id".into(), json!("w1"));
            }
        }
        rpc(&self.files, &self.conn, method, &params, None)
            .await
            .unwrap()
    }

    fn read(&self, path: &str) -> String {
        fs::read_to_string(self.root.join(path)).unwrap()
    }

    fn write(&self, path: &str, text: &str) {
        fs::write(self.root.join(path), text).unwrap();
    }

    fn mkdir_here(&self, path: &str) {
        fs::create_dir(self.root.join(path)).unwrap();
    }

    fn gone(&self, path: &str) -> bool {
        fs::symlink_metadata(self.root.join(path)).is_err()
    }
}

fn path_of(result: RpcResult) -> String {
    result.unwrap()["path"].as_str().unwrap().to_owned()
}

#[tokio::test]
async fn creates_root_nested_folders_and_preserves_existing_entries() {
    for remote in [false, true] {
        let f = plain(remote);
        let name = "folder 'quoted $name";
        assert_eq!(path_of(f.mkdir(json!({ "name": name })).await), name);
        assert_eq!(
            path_of(
                f.mkdir(json!({ "directory": name, "name": "nested" }))
                    .await
            ),
            format!("{name}/nested")
        );
        assert!(f.mkdir(json!({ "name": name })).await.is_err());
        f.write("existing", "keep");
        assert!(f.mkdir(json!({ "name": "existing" })).await.is_err());
        assert_eq!(f.read("existing"), "keep");
    }
}

#[tokio::test]
async fn moves_files_into_folders_and_back_to_root_without_changing_their_contents() {
    for remote in [false, true] {
        let f = plain(remote);
        f.mkdir_here("target");
        let name = "a 'quoted $name.txt";
        f.write(name, "contents");
        assert_eq!(
            path_of(
                f.moving(json!({ "path": name, "directory": "target" }))
                    .await
            ),
            format!("target/{name}")
        );
        assert!(f.gone(name));
        assert_eq!(f.read(&format!("target/{name}")), "contents");
        assert_eq!(
            path_of(
                f.moving(json!({ "path": format!("target/{name}"), "directory": "" }))
                    .await
            ),
            name
        );
    }
}

#[tokio::test]
async fn literal_backslashes_in_posix_names_do_not_move_a_different_file() {
    for remote in [false, true] {
        let f = plain(remote);
        f.mkdir_here("from");
        f.mkdir_here("target");
        f.write("from/name", "other file");
        f.write("from\\name", "selected file");
        f.moving(json!({ "path": "from\\name", "directory": "target" }))
            .await
            .unwrap();
        assert_eq!(f.read("target/from\\name"), "selected file");
        assert_eq!(f.read("from/name"), "other file");
        assert!(f.gone("from\\name"));
    }
}

#[tokio::test]
async fn moves_posix_names_that_resemble_windows_paths() {
    for remote in [false, true] {
        let f = plain(remote);
        f.mkdir(json!({ "name": "a:target" })).await.unwrap();
        f.mkdir(json!({ "directory": "a:target", "name": "nested" }))
            .await
            .unwrap();
        for name in ["a:notes", "C:\\notes", "\\notes"] {
            f.write(name, name);
            assert_eq!(
                path_of(
                    f.moving(json!({ "path": name, "directory": "a:target/nested" }))
                        .await
                ),
                format!("a:target/nested/{name}")
            );
            assert_eq!(f.read(&format!("a:target/nested/{name}")), name);
            assert!(f.gone(name));
        }
    }
}

#[tokio::test]
async fn never_overwrites_a_destination_file_directory_or_symlink() {
    for remote in [false, true] {
        let f = plain(remote);
        f.mkdir_here("target");
        for name in ["file", "folder", "link"] {
            f.write(name, "source");
        }
        f.write("target/file", "destination");
        f.mkdir_here("target/folder");
        std::os::unix::fs::symlink(f.outside.join("missing"), f.root.join("target/link")).unwrap();
        for path in ["file", "folder", "link"] {
            assert!(
                f.moving(json!({ "path": path, "directory": "target" }))
                    .await
                    .is_err()
            );
            assert_eq!(f.read(path), "source");
        }
        assert_eq!(f.read("target/file"), "destination");
        assert!(f.root.join("target/folder").is_dir());
        assert_eq!(
            fs::read_link(f.root.join("target/link")).unwrap(),
            f.outside.join("missing")
        );
    }
}

#[tokio::test]
async fn trailing_newlines_in_directory_names_do_not_redirect_a_move() {
    for remote in [false, true] {
        let f = plain(remote);
        for directory in ["source", "source\n", "target", "target\n"] {
            f.mkdir_here(directory);
        }
        f.write("source/a", "other file");
        f.write("source\n/a", "selected file");
        f.moving(json!({ "path": "source\n/a", "directory": "target\n" }))
            .await
            .unwrap();
        assert_eq!(f.read("target\n/a"), "selected file");
        assert_eq!(f.read("source/a"), "other file");
        assert!(f.gone("source\n/a"));
        assert!(f.gone("target/a"));
    }
}

#[tokio::test]
async fn keeps_batch_failures_intact_while_independent_files_move() {
    for remote in [false, true] {
        let f = plain(remote);
        f.mkdir_here("target");
        f.write("a", "a");
        f.write("b", "b");
        f.write("target/b", "keep");
        let (a, b) = tokio::join!(
            f.moving(json!({ "path": "a", "directory": "target" })),
            f.moving(json!({ "path": "b", "directory": "target" })),
        );
        assert!(a.is_ok());
        assert!(b.is_err());
        assert_eq!(f.read("target/a"), "a");
        assert_eq!(f.read("b"), "b");
        assert_eq!(f.read("target/b"), "keep");
    }
}

/// A save racing the move, right before and right after it.
fn racing_save(root: &Path) {
    let root = root.to_path_buf();
    let before_root = root.clone();
    let before: Box<dyn Fn(&Path) + Send> = Box::new(move |source: &Path| {
        if source.starts_with(&before_root) {
            let mut save = source.as_os_str().to_owned();
            save.push(".save");
            fs::rename(&save, source).unwrap();
        }
    });
    let after: Box<dyn Fn(&Path) + Send> = Box::new(move |source: &Path| {
        if source.starts_with(&root) {
            fs::write(source, "later save").unwrap();
        }
    });
    *crate::atomic_move::tests::HOOKS.lock().unwrap() = Some((before, after));
}

#[tokio::test]
async fn preserves_saves_immediately_before_and_after_the_atomic_move() {
    for remote in [false, true] {
        let script = REMOTE_EXCLUSIVE_RENAME.replace(
            "result = rename(*args)",
            "os.replace(source + \".save\", source)\nresult = rename(*args)\nif result == 0:\n    with open(source, \"w\") as saved:\n        saved.write(\"later save\")",
        );
        let (from, to) = (shell_quote(REMOTE_EXCLUSIVE_RENAME), shell_quote(&script));
        let f = fixture(remote, move |command| command.replace(&from, &to));
        if !remote {
            racing_save(&f.root);
        }
        f.mkdir_here("target");
        f.write("a", "original");
        f.write("a.save", "concurrent save");
        let moved = f
            .moving(json!({ "path": "a", "directory": "target" }))
            .await;
        *crate::atomic_move::tests::HOOKS.lock().unwrap() = None;
        moved.unwrap();
        assert_eq!(f.read("target/a"), "concurrent save");
        assert_eq!(f.read("a"), "later save");
    }
}

#[tokio::test]
async fn a_read_only_source_directory_leaves_no_destination_and_can_be_retried() {
    if rustix::process::geteuid().is_root() {
        return;
    }
    use std::os::unix::fs::PermissionsExt as _;
    for remote in [false, true] {
        let f = plain(remote);
        let source = f.root.join("source");
        fs::create_dir(&source).unwrap();
        f.mkdir_here("target");
        f.write("source/a", "keep");
        fs::set_permissions(&source, fs::Permissions::from_mode(0o500)).unwrap();
        let refused = f
            .moving(json!({ "path": "source/a", "directory": "target" }))
            .await;
        fs::set_permissions(&source, fs::Permissions::from_mode(0o700)).unwrap();
        assert!(refused.is_err());
        assert_eq!(f.read("source/a"), "keep");
        assert!(f.gone("target/a"));
        f.moving(json!({ "path": "source/a", "directory": "target" }))
            .await
            .unwrap();
        assert_eq!(f.read("target/a"), "keep");
    }
}

#[tokio::test]
async fn concurrent_moves_to_the_same_name_preserve_the_losing_source() {
    for remote in [false, true] {
        let f = plain(remote);
        for directory in ["one", "two", "target"] {
            f.mkdir_here(directory);
        }
        f.write("one/a", "one");
        f.write("two/a", "two");
        let (one, two) = tokio::join!(
            f.moving(json!({ "path": "one/a", "directory": "target" })),
            f.moving(json!({ "path": "two/a", "directory": "target" })),
        );
        assert_eq!(usize::from(one.is_ok()) + usize::from(two.is_ok()), 1);
        let loser = if one.is_err() { "one" } else { "two" };
        assert_eq!(f.read(&format!("{loser}/a")), loser);
        assert_eq!(
            f.read("target/a"),
            if loser == "one" { "two" } else { "one" }
        );
    }
}

#[tokio::test]
async fn unsupported_atomic_primitives_fail_without_changing_either_path() {
    let script = REMOTE_EXCLUSIVE_RENAME.replace(
        "import ctypes, os, sys",
        "import ctypes, os, sys\nsys.platform = \"unsupported\"",
    );
    let (from, to) = (shell_quote(REMOTE_EXCLUSIVE_RENAME), shell_quote(&script));
    let f = fixture(true, move |command| command.replace(&from, &to));
    f.mkdir_here("target");
    f.write("a", "keep");
    let error = f
        .moving(json!({ "path": "a", "directory": "target" }))
        .await
        .unwrap_err();
    assert!(error.message.contains("unsupported"), "{error}");
    assert_eq!(f.read("a"), "keep");
    assert!(f.gone("target/a"));
}

#[tokio::test]
async fn missing_python_fails_before_changing_either_path() {
    let f = fixture(true, |command| {
        command.replace("command -v python3", "false")
    });
    f.mkdir_here("target");
    f.write("a", "keep");
    let error = f
        .moving(json!({ "path": "a", "directory": "target" }))
        .await
        .unwrap_err();
    assert!(error.message.contains("requires Python 3"), "{error}");
    assert_eq!(f.read("a"), "keep");
    assert!(f.gone("target/a"));
}

#[tokio::test]
async fn moves_symlinks_themselves_and_rejects_directory_or_same_parent_moves() {
    for remote in [false, true] {
        let f = plain(remote);
        f.mkdir_here("target");
        std::os::unix::fs::symlink(f.outside.join("missing"), f.root.join("link")).unwrap();
        f.moving(json!({ "path": "link", "directory": "target" }))
            .await
            .unwrap();
        assert_eq!(
            fs::read_link(f.root.join("target/link")).unwrap(),
            f.outside.join("missing")
        );
        assert!(
            f.moving(json!({ "path": "target", "directory": "" }))
                .await
                .is_err()
        );
        assert!(
            f.moving(json!({ "path": "target/link", "directory": "target" }))
                .await
                .is_err()
        );
        assert!(
            fs::symlink_metadata(f.root.join("target/link"))
                .unwrap()
                .file_type()
                .is_symlink()
        );
    }
}

#[tokio::test]
async fn blocks_symlink_parent_escapes_for_both_source_and_destination() {
    for remote in [false, true] {
        let f = plain(remote);
        std::os::unix::fs::symlink(&f.outside, f.root.join("escape")).unwrap();
        f.write("a", "inside");
        fs::write(f.outside.join("a"), "outside").unwrap();
        assert!(
            f.mkdir(json!({ "directory": "escape", "name": "new" }))
                .await
                .is_err()
        );
        assert!(
            f.moving(json!({ "path": "a", "directory": "escape" }))
                .await
                .is_err()
        );
        assert!(
            f.moving(json!({ "path": "escape/a", "directory": "" }))
                .await
                .is_err()
        );
        assert_eq!(f.read("a"), "inside");
        assert_eq!(fs::read_to_string(f.outside.join("a")).unwrap(), "outside");
        assert!(fs::symlink_metadata(f.outside.join("new")).is_err());
    }
}

#[tokio::test]
async fn rejects_invalid_mutation_paths_names_scopes_and_missing_workspace_identity() {
    for remote in [false, true] {
        let f = plain(remote);
        let invalid = ["../outside", "/absolute", "bad\0path"];
        for directory in invalid {
            assert!(
                f.mkdir(json!({ "directory": directory, "name": "new" }))
                    .await
                    .is_err()
            );
            assert!(
                f.moving(json!({ "path": "a", "directory": directory }))
                    .await
                    .is_err()
            );
        }
        for path in ["", "."].into_iter().chain(invalid) {
            assert!(f.moving(json!({ "path": path })).await.is_err(), "{path:?}");
        }
        for name in ["", ".", "..", "a/b", "a\\b", "bad\0name"] {
            assert!(f.mkdir(json!({ "name": name })).await.is_err(), "{name:?}");
        }
        assert!(
            f.mkdir(json!({ "name": "new", "scope": "filesystem" }))
                .await
                .unwrap_err()
                .message
                .contains("workspace scope")
        );
        assert!(
            f.moving(json!({ "path": "a", "scope": "filesystem" }))
                .await
                .unwrap_err()
                .message
                .contains("workspace scope")
        );
        assert!(
            f.mkdir(json!({ "name": "new", "no_id": true }))
                .await
                .unwrap_err()
                .message
                .contains("workspace_id")
        );
        assert!(
            f.moving(json!({ "path": "a", "no_id": true }))
                .await
                .unwrap_err()
                .message
                .contains("workspace_id")
        );
    }
}
