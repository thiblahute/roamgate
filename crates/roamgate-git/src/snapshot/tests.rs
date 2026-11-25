//! The snapshot transaction, run for real on throwaway repositories
//! (git-snapshot.test.ts): the script is the contract's, these hold the
//! Rust caller and the script together.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use super::*;
use crate::exec::testing::{Instrumented, local};
use crate::exec::{Invocation, LocalRunner, Ran, Request, RunError, RunFuture, Runner};

struct Repo {
    _dir: tempfile::TempDir,
    root: PathBuf,
}

impl Repo {
    fn path(&self) -> &str {
        self.root.to_str().unwrap()
    }
}

fn run_git(root: &Path, args: &[&str]) -> std::process::Output {
    std::process::Command::new("git")
        .arg("-C")
        .arg(root)
        .args(args)
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .output()
        .unwrap()
}

fn git(root: &Path, args: &[&str]) -> String {
    let output = run_git(root, args);
    assert!(
        output.status.success(),
        "git {args:?}: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8_lossy(&output.stdout).trim().to_owned()
}

fn repository() -> Repo {
    let dir = tempfile::Builder::new()
        .prefix("roamgate-snapshot-safety-")
        .tempdir()
        .unwrap();
    let root = dir.path().to_path_buf();
    git(&root, &["init", "-q"]);
    git(&root, &["config", "core.bigFileThreshold", "1"]);
    Repo { _dir: dir, root }
}

async fn capture(root: &str) -> Result<String> {
    snapshot_worktree_tree(&local(), root).await
}

async fn capture_with(cx: &GitContext, root: &str) -> Result<String> {
    snapshot_worktree_tree(cx, root).await
}

fn instrument(transform: impl Fn(&str) -> String + Send + Sync + 'static) -> GitContext {
    Instrumented::context(transform, None)
}

fn tiny(script: &str) -> String {
    script
        .replace("52428801", "33")
        .replace("52428800", "32")
        .replace("134217728", "64")
}

fn walk(dir: &Path, base: &Path, out: &mut Vec<String>) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        out.push(
            path.strip_prefix(base)
                .unwrap()
                .to_string_lossy()
                .into_owned(),
        );
        if path.is_dir() {
            walk(&path, base, out);
        }
    }
}

fn object_files(root: &Path) -> Vec<String> {
    let objects = root.join(".git").join("objects");
    let mut out = Vec::new();
    walk(&objects, &objects, &mut out);
    out.sort();
    out
}

#[cfg(unix)]
fn object_state(root: &Path) -> Vec<(String, u32, Option<Vec<u8>>)> {
    use std::os::unix::fs::MetadataExt;
    let objects = root.join(".git").join("objects");
    let mut paths = vec![String::new()];
    paths.extend(object_files(root));
    paths
        .into_iter()
        .map(|path| {
            let file = objects.join(&path);
            let meta = fs::metadata(&file).unwrap();
            let contents = meta.is_file().then(|| fs::read(&file).unwrap());
            (path, meta.mode(), contents)
        })
        .collect()
}

fn listing(dir: &Path) -> Vec<String> {
    let mut names: Vec<String> = fs::read_dir(dir)
        .unwrap()
        .flatten()
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .collect();
    names.sort();
    names
}

fn index(root: &Path) -> Vec<u8> {
    fs::read(root.join(".git").join("index")).unwrap()
}

fn no_quarantine(git_dir: &Path) -> bool {
    !listing(git_dir).contains(&"roamgate-last-step-capture".to_owned())
}

fn assert_fails(result: Result<String>, needle: &str) {
    let error = result.expect_err("the capture should fail").to_string();
    assert!(error.contains(needle), "{error:?} lacks {needle:?}");
}

fn commit_args(message: &str) -> Vec<&str> {
    vec![
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.com",
        "commit",
        "-q",
        "-m",
        message,
    ]
}

#[tokio::test]
async fn excludes_an_in_worktree_git_directory_s_without_excluding_neighboring_files() {
    for name in [".repo", ".repo [meta] 'quote"] {
        let repo = repository();
        let root = &repo.root;
        let git_dir = root.join(name);
        git(
            root,
            &[
                "init",
                "-q",
                &format!("--separate-git-dir={}", git_dir.display()),
            ],
        );
        fs::write(root.join("tracked"), "staged\n").unwrap();
        git(root, &["add", "tracked"]);
        git(root, &commit_args("initial"));
        fs::write(root.join("tracked"), "changed\n").unwrap();
        fs::write(root.join("untracked"), "new\n").unwrap();
        let neighbor = format!("{name}-content");
        fs::create_dir(root.join(&neighbor)).unwrap();
        fs::write(root.join(&neighbor).join("file"), "keep\n").unwrap();
        let index = fs::read(git_dir.join("index")).unwrap();
        let first = capture(repo.path()).await.unwrap();
        let mut names: Vec<String> = git(root, &["ls-tree", "-rz", "--name-only", &first])
            .split('\0')
            .filter(|s| !s.is_empty())
            .map(str::to_owned)
            .collect();
        names.sort();
        let mut want = vec![
            format!("{neighbor}/file"),
            "tracked".into(),
            "untracked".into(),
        ];
        want.sort();
        assert_eq!(names, want);
        let mut objects = Vec::new();
        walk(
            &git_dir.join("objects"),
            &git_dir.join("objects"),
            &mut objects,
        );
        objects.sort();
        for _ in 0..2 {
            assert_eq!(capture(repo.path()).await.unwrap(), first);
            let mut now = Vec::new();
            walk(&git_dir.join("objects"), &git_dir.join("objects"), &mut now);
            now.sort();
            assert_eq!(now, objects);
        }
        assert_eq!(fs::read(git_dir.join("index")).unwrap(), index);
        assert!(no_quarantine(&git_dir));
    }
}

#[cfg(unix)]
#[tokio::test]
async fn refuses_shared_or_ambiguous_repository_modes_without_changing_objects_permissions_or_staging()
 {
    let repo = repository();
    let root = &repo.root;
    git(root, &["init", "-q", "--shared=group"]);
    fs::write(root.join("staged"), "staged\n").unwrap();
    git(root, &["add", "staged"]);
    fs::write(root.join("untracked"), "new snapshot content\n").unwrap();
    let staged = index(root);
    let objects = object_state(root);
    for mode in ["group", "all", "0660", "true", "unknown", ""] {
        git(
            root,
            &[
                "-c",
                "core.sharedRepository=0",
                "config",
                "core.sharedRepository",
                mode,
            ],
        );
        assert_fails(capture(repo.path()).await, "shared repositories");
        assert_eq!(object_state(root), objects);
        assert_eq!(index(root), staged);
        assert!(no_quarantine(&root.join(".git")));
    }
}

#[cfg(unix)]
#[tokio::test]
async fn uses_effective_shared_repository_configuration_from_included_files() {
    let repo = repository();
    let root = &repo.root;
    fs::write(root.join("staged"), "staged\n").unwrap();
    git(root, &["add", "staged"]);
    fs::write(root.join("untracked"), "new snapshot content\n").unwrap();
    fs::write(
        root.join(".git").join("shared-config"),
        "[core]\nsharedRepository = group\n",
    )
    .unwrap();
    git(root, &["config", "include.path", "shared-config"]);
    let staged = index(root);
    let objects = object_state(root);
    assert_fails(capture(repo.path()).await, "shared repositories");
    assert_eq!(object_state(root), objects);
    assert_eq!(index(root), staged);
    assert!(no_quarantine(&root.join(".git")));
}

#[tokio::test]
async fn permits_default_and_explicit_non_shared_repository_modes() {
    let repo = repository();
    fs::write(repo.root.join("file"), "small").unwrap();
    let tree = capture(repo.path()).await.unwrap();
    for mode in ["false", "0", "umask", "FALSE"] {
        git(&repo.root, &["config", "core.sharedRepository", mode]);
        assert_eq!(capture(repo.path()).await.unwrap(), tree, "{mode}");
    }
}

#[cfg(unix)]
#[tokio::test]
async fn repeated_unreadable_captures_leave_no_objects_or_packs_and_preserve_staging() {
    use std::os::unix::fs::PermissionsExt;
    let repo = repository();
    let root = &repo.root;
    fs::write(root.join("staged"), "staged\n").unwrap();
    git(root, &["add", "staged"]);
    let staged = index(root);
    let objects = object_files(root);
    let packs = listing(&root.join(".git").join("objects").join("pack"));
    fs::write(
        root.join("1-binary"),
        [7u8, 0, 255, 1, 2, 3, 0, 9, 8, 7, 6, 5],
    )
    .unwrap();
    fs::write(root.join("2-unreadable"), "unreadable\n").unwrap();
    fs::set_permissions(root.join("2-unreadable"), fs::Permissions::from_mode(0o0)).unwrap();
    for _ in 0..3 {
        let error = capture(repo.path()).await.unwrap_err().to_string();
        assert!(
            error.contains("unreadable") || error.contains("cannot read"),
            "{error}"
        );
        assert_eq!(object_files(root), objects);
        assert_eq!(index(root), staged);
        assert!(no_quarantine(&root.join(".git")));
    }
    fs::set_permissions(root.join("2-unreadable"), fs::Permissions::from_mode(0o600)).unwrap();
    let first = capture(repo.path()).await.unwrap();
    let published = object_files(root);
    assert_eq!(capture(repo.path()).await.unwrap(), first);
    assert_eq!(object_files(root), published);
    assert_eq!(index(root), staged);
    assert_eq!(
        listing(&root.join(".git").join("objects").join("pack")),
        packs
    );
}

#[tokio::test]
async fn caps_actual_file_and_aggregate_bytes_including_tracked_modifications() {
    let repo = repository();
    let root = &repo.root;
    fs::write(root.join("tracked"), "before").unwrap();
    git(root, &["add", "tracked"]);
    let before = object_files(root);
    fs::write(root.join("tracked"), "x".repeat(33)).unwrap();
    assert_fails(
        capture_with(&instrument(tiny), repo.path()).await,
        "file exceeds",
    );
    fs::write(root.join("tracked"), "x".repeat(32)).unwrap();
    fs::write(root.join("other"), "y".repeat(32)).unwrap();
    fs::write(root.join("third"), "z").unwrap();
    assert_fails(
        capture_with(&instrument(tiny), repo.path()).await,
        "worktree exceeds",
    );
    assert_eq!(object_files(root), before);
}

#[tokio::test]
async fn refuses_applicable_filters_without_executing_them_but_permits_unused_filter_config() {
    let repo = repository();
    let root = &repo.root;
    let marker = root.join("filter-ran");
    git(
        root,
        &[
            "config",
            "filter.expand.clean",
            &format!("touch {}; cat", shell_quote(marker.to_str().unwrap())),
        ],
    );
    fs::write(root.join("file"), "small").unwrap();
    capture(repo.path()).await.unwrap();
    let before = object_files(root);
    fs::write(root.join(".gitattributes"), "file filter=expand\n").unwrap();
    assert_fails(capture(repo.path()).await, "Git filter attributes");
    assert!(!listing(root).contains(&"filter-ran".to_owned()));
    assert_eq!(object_files(root), before);
}

#[cfg(unix)]
#[tokio::test]
async fn captures_raw_crlf_bytes_and_executable_files_with_shell_special_names() {
    use std::os::unix::fs::PermissionsExt;
    let repo = repository();
    let root = &repo.root;
    git(root, &["config", "core.autocrlf", "true"]);
    let path = "- quote'\" back\\slash.txt";
    fs::write(root.join(path), "raw\r\nbytes\r\n").unwrap();
    fs::set_permissions(root.join(path), fs::Permissions::from_mode(0o755)).unwrap();
    let tree = capture(repo.path()).await.unwrap();
    assert!(git(root, &["ls-tree", &tree]).contains("100755"));
    let shown = run_git(root, &["show", &format!("{tree}:{path}")]);
    assert_eq!(shown.stdout, b"raw\r\nbytes\r\n");
}

#[cfg(unix)]
#[tokio::test]
async fn refuses_symlinks_and_control_character_paths_rather_than_omitting_them() {
    let repo = repository();
    let root = &repo.root;
    std::os::unix::fs::symlink("missing", root.join("link")).unwrap();
    assert_fails(capture(repo.path()).await, "symlink");
    fs::remove_file(root.join("link")).unwrap();
    for path in ["line\nbreak", "tab\tname"] {
        fs::write(root.join(path), "small").unwrap();
        assert_fails(capture(repo.path()).await, "newline/tab");
        fs::remove_file(root.join(path)).unwrap();
    }
}

#[tokio::test]
// Unix only: it races a symbolic link in, which Git Bash cannot make on
// Windows without privileges.
#[cfg(unix)]
async fn pins_files_without_dereferencing_a_raced_final_symlink() {
    let repo = repository();
    fs::write(repo.root.join("file"), "small").unwrap();
    let runner = instrument(|script| {
        script.replace(
            "    ln -P \"$file\"",
            "    rm \"$file\"; ln -s /etc/passwd \"$file\"\n    ln -P \"$file\"",
        )
    });
    let before = object_files(&repo.root);
    assert_fails(
        capture_with(&runner, repo.path()).await,
        "file changed type",
    );
    assert_eq!(object_files(&repo.root), before);
}

#[tokio::test]
async fn does_not_publish_a_file_that_grows_after_enumeration() {
    let repo = repository();
    let root = &repo.root;
    fs::write(root.join("file"), "small").unwrap();
    let runner = instrument(|script| {
        tiny(&script.replace(
            "    ln -P \"$file\"",
            "    printf \"%040d\" 0 >> \"$file\"\n    ln -P \"$file\"",
        ))
    });
    // Untracked and grown past the bound: left out and named.
    let left = snapshot_worktree(&runner, repo.path()).await.unwrap();
    assert_eq!(left.skipped, ["file"]);
    assert_eq!(git(root, &["ls-tree", "-r", "--name-only", &left.tree]), "");
    // Tracked, it refuses the snapshot: nothing published.
    fs::write(root.join("file"), "small").unwrap();
    git(root, &["add", "file"]);
    let before = object_files(root);
    assert_fails(capture_with(&runner, repo.path()).await, "file exceeds");
    assert_eq!(object_files(root), before);
}

#[tokio::test]
// Unix only: it races a symbolic link in, which Git Bash cannot make on
// Windows without privileges.
#[cfg(unix)]
async fn a_raced_ancestor_symlink_cannot_redirect_capture() {
    let repo = repository();
    let outside = tempfile::Builder::new()
        .prefix("roamgate-snapshot-outside-")
        .tempdir()
        .unwrap();
    fs::create_dir(repo.root.join("directory")).unwrap();
    fs::write(repo.root.join("directory").join("file"), "inside").unwrap();
    fs::write(outside.path().join("file"), "outside secret").unwrap();
    let target = shell_quote(outside.path().to_str().unwrap());
    let runner = instrument(move |script| {
        script.replace(
            "    cd -P \"$expected\"",
            &format!(
                "    mv \"$snapshot_root/directory\" \"$snapshot_root/original\"; ln -s {target} \"$snapshot_root/directory\"\n    cd -P \"$expected\""
            ),
        )
    });
    let before = object_files(&repo.root);
    assert_fails(capture_with(&runner, repo.path()).await, "symlink ancestor");
    assert_eq!(object_files(&repo.root), before);
}

#[tokio::test]
async fn captures_submodules_through_staging_deinitialization_and_index_only_removal() {
    let repo = repository();
    let source = repository();
    let root = &repo.root;
    for each in [root, &source.root] {
        git(each, &["config", "user.name", "Test"]);
        git(each, &["config", "user.email", "test@example.com"]);
        git(each, &["commit", "-q", "--allow-empty", "-m", "initial"]);
    }
    let baseline = capture(repo.path()).await.unwrap();
    git(
        root,
        &[
            "-c",
            "protocol.file.allow=always",
            "submodule",
            "add",
            "-q",
            source.path(),
            "module",
        ],
    );
    let staged = index(root);
    let tree = capture(repo.path()).await.unwrap();
    assert_eq!(
        git(root, &["ls-tree", &tree, "module"]),
        format!(
            "160000 commit {}\tmodule",
            git(&source.root, &["rev-parse", "HEAD"])
        )
    );
    assert_eq!(
        git(root, &["diff", "--name-only", &baseline, &tree]),
        ".gitmodules\nmodule"
    );
    assert_eq!(index(root), staged);

    git(root, &["commit", "-q", "-m", "add module"]);
    git(root, &["submodule", "deinit", "-q", "-f", "module"]);
    let deinitialized = index(root);
    assert_eq!(capture(repo.path()).await.unwrap(), tree);
    assert_eq!(index(root), deinitialized);

    git(
        root,
        &[
            "-c",
            "protocol.file.allow=always",
            "submodule",
            "update",
            "-q",
            "--init",
            "module",
        ],
    );
    git(root, &["rm", "-q", "--cached", "module"]);
    assert_eq!(git(root, &["ls-files", "--stage", "--", "module"]), "");
    let removed = index(root);
    assert_eq!(capture(repo.path()).await.unwrap(), tree);
    assert_eq!(index(root), removed);
}

#[tokio::test]
async fn preserves_absent_sparse_checkout_entries_with_a_s_index() {
    for mode in ["regular", "sparse", "split"] {
        let repo = repository();
        let root = &repo.root;
        git(root, &["config", "user.name", "Test"]);
        git(root, &["config", "user.email", "test@example.com"]);
        for directory in ["included", "excluded"] {
            fs::create_dir(root.join(directory)).unwrap();
            fs::write(root.join(directory).join("file"), "initial\n").unwrap();
        }
        git(root, &["add", "."]);
        git(root, &["commit", "-q", "-m", "initial"]);
        let sparse = if mode == "sparse" {
            "--sparse-index"
        } else {
            "--no-sparse-index"
        };
        git(
            root,
            &["sparse-checkout", "set", "--cone", sparse, "included"],
        );
        if mode == "split" {
            git(root, &["update-index", "--split-index"]);
        }
        assert!(!listing(root).contains(&"excluded".to_owned()));
        let staged = index(root);
        let baseline = capture(repo.path()).await.unwrap();
        assert_eq!(
            git(root, &["show", &format!("{baseline}:excluded/file")]),
            "initial"
        );
        assert_eq!(index(root), staged, "{mode}");

        git(root, &["sparse-checkout", "set", "included", "excluded"]);
        assert_eq!(capture(repo.path()).await.unwrap(), baseline);
        fs::write(root.join("excluded").join("file"), "committed change\n").unwrap();
        git(root, &["add", "excluded/file"]);
        git(root, &["commit", "-q", "-m", "change excluded file"]);
        git(root, &["sparse-checkout", "set", "included"]);
        assert!(!listing(root).contains(&"excluded".to_owned()));
        let changed = index(root);
        let current = capture(repo.path()).await.unwrap();
        assert_eq!(
            git(root, &["show", &format!("{current}:excluded/file")]),
            "committed change"
        );
        assert_eq!(
            git(root, &["diff", "--name-only", &baseline, &current]),
            "excluded/file"
        );
        assert_eq!(index(root), changed);

        fs::remove_file(root.join("included").join("file")).unwrap();
        let deleted = capture(repo.path()).await.unwrap();
        assert_eq!(
            git(root, &["ls-tree", "-r", "--name-only", &deleted]),
            "excluded/file"
        );
        assert_eq!(index(root), changed);

        // A file materialized by hand overrides its indexed blob.
        fs::create_dir(root.join("excluded")).unwrap();
        fs::write(root.join("excluded").join("file"), "materialized edit\n").unwrap();
        let materialized = capture(repo.path()).await.unwrap();
        assert_eq!(
            git(root, &["show", &format!("{materialized}:excluded/file")]),
            "materialized edit"
        );
        assert_eq!(index(root), changed);
    }
}

#[tokio::test]
async fn captures_current_gitlinks_and_their_deletion() {
    let repo = repository();
    let root = &repo.root;
    let child = root.join("module");
    fs::create_dir(&child).unwrap();
    git(&child, &["init", "-q"]);
    let objects = object_files(root);
    assert!(capture(repo.path()).await.is_err());
    assert_eq!(object_files(root), objects);
    let mut args = commit_args("first");
    args.push("--allow-empty");
    git(&child, &args);
    let first = git(&child, &["rev-parse", "HEAD"]);
    let untracked = capture(repo.path()).await.unwrap();
    assert_eq!(
        git(root, &["ls-tree", &untracked]),
        format!("160000 commit {first}\tmodule")
    );
    git(
        root,
        &[
            "update-index",
            "--add",
            "--cacheinfo",
            &format!("160000,{first},module"),
        ],
    );
    git(root, &commit_args("module"));
    let mut args = commit_args("second");
    args.push("--allow-empty");
    git(&child, &args);
    let current = git(&child, &["rev-parse", "HEAD"]);
    let tree = capture(repo.path()).await.unwrap();
    assert_eq!(
        git(root, &["ls-tree", &tree]),
        format!("160000 commit {current}\tmodule")
    );
    fs::remove_dir_all(&child).unwrap();
    let deleted = capture(repo.path()).await.unwrap();
    assert_eq!(git(root, &["ls-tree", &deleted]), "");
}

/// Starts the SSH command's script here, then fails as a dropped SSH
/// connection would, leaving the script running.
struct Disconnecting {
    remote: Mutex<Option<tokio::task::JoinHandle<Result<Ran, RunError>>>>,
}

impl Runner for Disconnecting {
    fn run(&self, request: Request) -> RunFuture<'_> {
        Box::pin(async move {
            let Invocation::Ssh { command, .. } = &request.invocation else {
                panic!("not an SSH run: {request:?}");
            };
            let argv = vec!["sh".to_owned(), "-lc".to_owned(), command.clone()];
            *self.remote.lock().unwrap() = Some(tokio::spawn(async move {
                LocalRunner::system()
                    .run_local(&argv, None, Duration::from_secs(30))
                    .await
            }));
            Err(RunError(
                "simulated SSH disconnect without remote signal".into(),
            ))
        })
    }
}

#[tokio::test]
async fn an_unsignaled_ssh_transport_failure_may_finish_with_complete_deduplicated_objects() {
    let repo = repository();
    fs::write(repo.root.join("file"), "small").unwrap();
    let runner = Arc::new(Disconnecting {
        remote: Mutex::new(None),
    });
    let cx = GitContext::new(Some("simulated-host".into()), runner.clone());
    assert_fails(
        snapshot_worktree_tree(&cx, repo.path()).await,
        "simulated SSH disconnect",
    );
    let remote = runner.remote.lock().unwrap().take().unwrap();
    let completed = remote.await.unwrap().unwrap();
    assert_eq!(completed.code, 0);
    let tree = completed.stdout.trim().to_owned();
    assert!(TREE.is_match(&tree), "{tree}");
    let objects = object_files(&repo.root);
    assert_eq!(capture(repo.path()).await.unwrap(), tree);
    assert_eq!(object_files(&repo.root), objects);
    assert!(listing(&repo.root.join(".git").join("objects").join("pack")).is_empty());
}

#[tokio::test]
async fn cleans_only_its_quarantine_on_failure_after_object_creation() {
    let repo = repository();
    fs::write(
        repo.root.join("file"),
        [1u8, 0, 2, 255, 3, 0, 4, 5, 6, 7, 8, 9],
    )
    .unwrap();
    let before = object_files(&repo.root);
    let runner = instrument(|script| {
        script.replace("tree=$(git write-tree)", "tree=$(git write-tree)\nexit 1")
    });
    for _ in 0..3 {
        assert!(capture_with(&runner, repo.path()).await.is_err());
        assert_eq!(object_files(&repo.root), before);
        assert!(no_quarantine(&repo.root.join(".git")));
    }
}

#[tokio::test]
async fn interrupted_publication_leaves_only_complete_objects_without_missing_tree_children() {
    let repo = repository();
    fs::create_dir(repo.root.join("nested")).unwrap();
    fs::write(repo.root.join("nested").join("file"), "small").unwrap();
    let runner =
        instrument(|script| script.replace("  done\n}\nif [ -f", "    exit 1\n  done\n}\nif [ -f"));
    assert!(capture_with(&runner, repo.path()).await.is_err());
    git(&repo.root, &["fsck", "--full"]);
    capture(repo.path()).await.unwrap();
    git(&repo.root, &["fsck", "--full"]);
    assert!(listing(&repo.root.join(".git").join("objects").join("pack")).is_empty());
}

#[tokio::test]
async fn refuses_an_existing_ownership_directory_and_permits_explicit_recovery_after_quiescence() {
    let repo = repository();
    let quarantine = repo.root.join(".git").join("roamgate-last-step-capture");
    fs::create_dir(&quarantine).unwrap();
    fs::write(quarantine.join("owner-pid"), "unknown").unwrap();
    for _ in 0..3 {
        assert_fails(capture(repo.path()).await, "capture locked");
        assert_eq!(
            fs::read_to_string(quarantine.join("owner-pid")).unwrap(),
            "unknown"
        );
    }
    // No live writer here; production asks the operator first.
    fs::remove_dir_all(&quarantine).unwrap();
    capture(repo.path()).await.unwrap();
}

#[tokio::test]
async fn an_expired_capture_cannot_begin_publication() {
    let repo = repository();
    fs::write(repo.root.join("file"), "small").unwrap();
    let before = object_files(&repo.root);
    let runner = instrument(|script| {
        script.replace(
            "tree=$(git write-tree)",
            "tree=$(git write-tree)\nstarted=0",
        )
    });
    assert_fails(
        capture_with(&runner, repo.path()).await,
        "capture deadline exceeded",
    );
    assert_eq!(object_files(&repo.root), before);
}

#[cfg(unix)]
#[tokio::test]
async fn actual_timeout_during_phase_retains_ownership_and_blocks_retries() {
    for phase in ["capture", "publication"] {
        let repo = repository();
        fs::write(repo.root.join("file"), "small").unwrap();
        // A pause that holds the script until the deadline passes: a read
        // from a FIFO nobody writes. The deadline is the runner's, as the
        // production 10 s caller timeout is.
        let fifo = repo.root.join(".git").join("pause");
        assert!(
            std::process::Command::new("mkfifo")
                .arg(&fifo)
                .status()
                .unwrap()
                .success()
        );
        let pause = format!("read x < {}", shell_quote(fifo.to_str().unwrap()));
        let runner = Instrumented::context(
            move |script| {
                if phase == "capture" {
                    script.replace(
                        "tree=$(git write-tree)",
                        &format!("{pause}\ntree=$(git write-tree)"),
                    )
                } else {
                    script.replace(
                        "    target=\"$objects/$prefix/$name\"",
                        &format!("{pause}\n    target=\"$objects/$prefix/$name\""),
                    )
                }
            },
            Some(Duration::from_millis(8000)),
        );
        assert_fails(capture_with(&runner, repo.path()).await, "timed out");
        assert_fails(capture(repo.path()).await, "capture locked");
        let git_dir = repo.root.join(".git");
        assert!(!no_quarantine(&git_dir), "{phase}");
        assert!(listing(&git_dir.join("objects").join("pack")).is_empty());
        assert!(git(&repo.root, &["count-objects", "-v"]).contains("count: 0"));
        assert_fails(capture(repo.path()).await, "capture locked");
    }
}
