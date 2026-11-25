//! files-reveal.test.ts: file.reveal through the handlers, the file
//! manager recorded instead of started.

use std::collections::BTreeMap;
use std::fs;
use std::sync::Mutex;

use roamgate_git::{Ran, Request};
use serde_json::{Value, json};

use super::*;
use crate::file_manager::Spawn;
use crate::test_support::{Scripted, connection};

struct MapEnv(BTreeMap<String, String>);

impl Env for MapEnv {
    fn var(&self, name: &str) -> Option<String> {
        self.0.get(name).cloned()
    }
}

struct Fixture {
    _dir: tempfile::TempDir,
    root: String,
    checkout: String,
    launches: Arc<Mutex<Vec<Vec<String>>>>,
    conn: WorkspaceConnection,
    files: Files,
}

fn fixture(ssh_host: Option<&str>, allowed: bool) -> Fixture {
    let dir = tempfile::Builder::new()
        .prefix("roamgate-reveal-handler-")
        .tempdir()
        .unwrap();
    let root = real(dir.path());
    let checkout = join(&root, "checkout");
    fs::create_dir(&checkout).unwrap();
    fs::write(format!("{checkout}/existing.md"), "file").unwrap();
    let launches = Arc::new(Mutex::new(Vec::new()));
    let (expected, top) = (checkout.clone(), root.clone());
    let runner = Scripted::new(move |request: &Request| {
        assert_eq!(
            crate::test_support::local_argv(&request.invocation),
            [
                "git",
                "-C",
                expected.as_str(),
                "rev-parse",
                "--show-toplevel"
            ]
        );
        // The Git root need not equal the explorer root.
        Ok(Ran::new(0, top.clone(), ""))
    });
    let cwd = checkout.clone();
    let (conn, _) = connection(ssh_host, runner, move |_, _| {
        Ok(json!({ "workspace": { "cwd": cwd } }))
    });
    let kept = launches.clone();
    let spawn: Spawn = Arc::new(move |argv: &[String]| {
        kept.lock().unwrap().push(argv.to_vec());
        Ok(())
    });
    let env: BTreeMap<String, String> = if allowed {
        [("ROAMGATE_ALLOW_FILE_REVEAL".to_owned(), "1".to_owned())]
            .into_iter()
            .collect()
    } else {
        BTreeMap::new()
    };
    let files = Files::new()
        .with_env(Arc::new(MapEnv(env)))
        .with_reveal(RevealOptions {
            platform: "darwin".into(),
            spawn,
            ..RevealOptions::default()
        });
    Fixture {
        _dir: dir,
        root,
        checkout,
        launches,
        conn,
        files,
    }
}

impl Fixture {
    async fn reveal(&self, params: Value) -> Result<FileRevealResult, WorkspaceError> {
        self.reveal_from(params, "127.0.0.1").await
    }

    async fn reveal_from(
        &self,
        mut params: Value,
        peer: &str,
    ) -> Result<FileRevealResult, WorkspaceError> {
        params["workspace_id"] = json!("w1");
        self.files.reveal(&self.conn, &params, peer).await
    }

    fn launches(&self) -> Vec<Vec<String>> {
        self.launches.lock().unwrap().clone()
    }
}

/// `name` under `dir`, with the platform's separator as the server
/// answers it.
fn join(dir: &str, name: &str) -> String {
    crate::file_types::path_text(&std::path::Path::new(dir).join(name))
}

fn shown(path: &str, kind: &str) -> FileRevealResult {
    FileRevealResult {
        path: path.into(),
        kind: kind.into(),
    }
}

#[tokio::test]
async fn handler_denies_reveal_by_default_and_for_non_loopback_peers() {
    let denied = fixture(None, false);
    let error = denied
        .reveal(json!({ "path": "existing.md" }))
        .await
        .unwrap_err();
    assert!(error.message.contains("host opt-in"));
    let allowed = fixture(None, true);
    let error = allowed
        .reveal_from(json!({ "path": "existing.md" }), "192.168.1.2")
        .await
        .unwrap_err();
    assert!(error.message.contains("loopback peer"));
    assert!(denied.launches().is_empty());
    assert!(allowed.launches().is_empty());
}

#[tokio::test]
async fn handler_refuses_ssh_profiles_even_with_opt_in_and_a_loopback_peer() {
    let f = fixture(Some("remote"), true);
    let error = f
        .reveal(json!({ "path": "existing.md" }))
        .await
        .unwrap_err();
    assert!(error.message.contains("local profile"));
    assert!(f.launches().is_empty());
}

#[tokio::test]
async fn enabled_local_handler_reveals_existing_files_and_preserves_explorer_enoent() {
    let f = fixture(None, true);
    let file = join(&f.checkout, "existing.md");
    assert_eq!(
        f.reveal(json!({ "path": "existing.md" })).await.unwrap(),
        shown(&file, "file")
    );
    let error = f
        .reveal(json!({ "path": "missing/child.md" }))
        .await
        .unwrap_err();
    assert!(error.message.contains("ENOENT"), "{error}");
    assert_eq!(f.launches(), [["open", "-R", file.as_str()]]);
}

#[tokio::test]
async fn changes_resolves_missing_files_and_removed_ancestor_directories_by_existence() {
    let f = fixture(None, true);
    let entries = roamgate_git::diff::parse_status_summary("MD checkout/deleted.md\n");
    let statuses: Vec<&str> = entries.iter().map(|e| e.status.as_str()).collect();
    assert_eq!(statuses, ["modified", "deleted"]);
    // Both rows of MD use the actual worktree, the staged row included.
    let mut paths: Vec<String> = entries.iter().map(|e| e.path.clone()).collect();
    paths.push("checkout/removed/deep/file.md".into());
    paths.push("checkout/removed".into());
    for path in paths {
        assert_eq!(
            f.reveal(json!({ "path": path, "source": "changes" }))
                .await
                .unwrap(),
            shown(&f.checkout, "directory")
        );
    }
    assert_eq!(
        f.reveal(json!({ "path": "removed/deep/file.md", "source": "changes" }))
            .await
            .unwrap(),
        shown(&f.root, "directory")
    );
    assert_eq!(
        f.reveal(json!({ "path": "checkout/existing.md", "source": "changes" }))
            .await
            .unwrap(),
        shown(&join(&f.checkout, "existing.md"), "file")
    );
    assert_eq!(f.launches().len(), 6);
}

#[tokio::test]
async fn changes_ascends_past_enotdir_while_ordinary_explorer_requests_still_reject() {
    let f = fixture(None, true);
    let ancestor = join(&f.checkout, "dir");
    fs::write(&ancestor, "directory replaced by a file").unwrap();
    let error = f
        .reveal(json!({ "path": "dir/file.md" }))
        .await
        .unwrap_err();
    assert!(error.message.contains("ENOTDIR"), "{error}");
    assert!(f.launches().is_empty());
    assert_eq!(
        f.reveal(json!({ "path": "checkout/dir/file.md", "source": "changes" }))
            .await
            .unwrap(),
        shown(&ancestor, "file")
    );
    assert_eq!(f.launches(), [["open", "-R", ancestor.as_str()]]);
}

#[tokio::test]
async fn handler_validates_scope_and_windows_absolute_paths_on_every_host_platform() {
    let f = fixture(None, true);
    for scope in [Value::Null, json!("workspace")] {
        for path in [
            "C:\\outside\\file.md",
            "C:/outside/file.md",
            "C:relative.md",
            "\\\\server\\share\\file.md",
            "\\rooted\\file.md",
            "/outside/file.md",
            "../outside.md",
        ] {
            let mut params = json!({ "path": path });
            if !scope.is_null() {
                params["scope"] = scope.clone();
            }
            assert!(f.reveal(params.clone()).await.is_err(), "{path}");
            params["source"] = json!("changes");
            assert!(f.reveal(params).await.is_err(), "{path}");
        }
    }
    assert!(
        f.reveal(json!({ "path": "existing.md", "scope": "invalid" }))
            .await
            .unwrap_err()
            .message
            .contains("scope")
    );
    assert!(
        f.reveal(json!({ "path": "existing.md", "scope": "filesystem" }))
            .await
            .unwrap_err()
            .message
            .contains("absolute path")
    );
    assert!(
        f.reveal(json!({ "path": f.root, "scope": "filesystem", "source": "changes" }))
            .await
            .unwrap_err()
            .message
            .contains("Git-root-relative")
    );
    assert!(f.launches().is_empty());
    assert_eq!(
        f.reveal(json!({ "path": f.root, "scope": "filesystem" }))
            .await
            .unwrap(),
        shown(&f.root, "directory")
    );
}

#[cfg(unix)]
#[tokio::test]
async fn workspace_and_changes_requests_cannot_escape_through_symlinks_or_missing_ancestors() {
    let f = fixture(None, true);
    let outside_dir = tempfile::Builder::new()
        .prefix("roamgate-reveal-outside-")
        .tempdir()
        .unwrap();
    let outside = real(outside_dir.path());
    std::os::unix::fs::symlink(&outside, format!("{}/outside", f.checkout)).unwrap();
    std::os::unix::fs::symlink(
        format!("{outside}/absent"),
        format!("{}/dangling", f.checkout),
    )
    .unwrap();
    std::os::unix::fs::symlink(&outside, format!("{}/outside", f.root)).unwrap();
    for path in [
        "outside",
        "outside/missing/deep.md",
        "checkout/dangling/missing.md",
        "../missing/deep.md",
    ] {
        assert!(
            f.reveal(json!({ "path": path, "source": "changes" }))
                .await
                .is_err(),
            "{path}"
        );
    }
    assert!(
        f.reveal(json!({ "path": "outside" }))
            .await
            .unwrap_err()
            .message
            .contains("escaped")
    );
    assert!(f.launches().is_empty());
}
