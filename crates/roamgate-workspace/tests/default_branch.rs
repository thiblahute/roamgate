//! Origin's default branch with real Git (default-branch.test.ts): the
//! worktree base a creation starts from (`sync_worktree_base`) and the
//! auto-sync merge (`sync_workspace_branch`) write the user's tracking
//! refs and checkout, and must leave everything else as it was.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use futures_util::FutureExt as _;
use futures_util::future::BoxFuture;
use roamgate_git::exec::{LocalRunner, RunFuture};
use roamgate_git::{GitContext, Invocation, Request, Runner};
use roamgate_workspace::auto_sync::sync_workspace_branch;
use roamgate_workspace::connection::WorkspaceError;
use roamgate_workspace::worktree::create::sync_worktree_base;

fn git(args: &[&str]) -> String {
    let output = std::process::Command::new("git")
        .args(args)
        .output()
        .expect("git");
    assert!(
        output.status.success(),
        "git {args:?}: {}{}",
        String::from_utf8_lossy(&output.stderr),
        String::from_utf8_lossy(&output.stdout)
    );
    String::from_utf8_lossy(&output.stdout).trim().to_owned()
}

fn at(root: &Path, args: &[&str]) -> String {
    let mut all = vec!["-C", root.to_str().unwrap()];
    all.extend_from_slice(args);
    git(&all)
}

fn commit(root: &Path, message: &str) -> String {
    at(
        root,
        &[
            "-c",
            "user.name=Test",
            "-c",
            "user.email=test@example.test",
            "-c",
            "commit.gpgsign=false",
            "commit",
            "--allow-empty",
            "-m",
            message,
        ],
    );
    at(root, &["rev-parse", "HEAD"])
}

type After = Box<dyn Fn(&str) + Send + Sync>;

/// This machine's runner without login shells (the host's profile is not
/// what is tested), with a hook after each command's end.
struct Local {
    after: Option<After>,
}

impl Runner for Local {
    fn run(&self, request: Request) -> RunFuture<'_> {
        Box::pin(async move {
            let Invocation::Local(argv) = &request.invocation else {
                panic!("an SSH run in a local test");
            };
            let argv: Vec<String> = argv
                .iter()
                .map(|arg| {
                    if arg == "-lc" {
                        "-c".into()
                    } else {
                        arg.clone()
                    }
                })
                .collect();
            let ran = LocalRunner::system()
                .run_local(&argv, request.input.as_deref(), request.timeout)
                .await?;
            if let Some(after) = &self.after {
                after(argv.last().map(String::as_str).unwrap_or_default());
            }
            Ok(ran)
        })
    }
}

fn cx() -> GitContext {
    GitContext::local(Arc::new(Local { after: None }))
}

async fn base(root: &Path) -> roamgate_workspace::worktree::create::SyncedBase {
    let root = root.to_str().unwrap().to_owned();
    let resolve = move |_: String| -> BoxFuture<'static, Result<String, WorkspaceError>> {
        let root = root.clone();
        async move { Ok(root) }.boxed()
    };
    sync_worktree_base("w1", &resolve, &cx()).await.unwrap()
}

struct Repos {
    _dir: tempfile::TempDir,
    dir: PathBuf,
    seed: PathBuf,
    remote: PathBuf,
    root: PathBuf,
}

/// A seed repository on `initial`, its bare clone as origin and a clone
/// of that at `checkout`; the seed's first commit.
fn repos(prefix: &str, initial: &str, checkout: &str) -> (Repos, String) {
    let dir = tempfile::Builder::new().prefix(prefix).tempdir().unwrap();
    let path = dir.path().to_path_buf();
    let repos = Repos {
        seed: path.join("seed"),
        remote: path.join("remote.git"),
        root: path.join(checkout),
        dir: path,
        _dir: dir,
    };
    git(&[
        "init",
        &format!("--initial-branch={initial}"),
        repos.seed.to_str().unwrap(),
    ]);
    let first = commit(&repos.seed, "initial");
    git(&[
        "clone",
        "--bare",
        repos.seed.to_str().unwrap(),
        repos.remote.to_str().unwrap(),
    ]);
    git(&[
        "clone",
        repos.remote.to_str().unwrap(),
        repos.root.to_str().unwrap(),
    ]);
    (repos, first)
}

impl Repos {
    fn remote(&self) -> &str {
        self.remote.to_str().unwrap()
    }

    fn add_worktree(&self, commit: &str) -> String {
        let created = self.dir.join("created");
        at(
            &self.root,
            &[
                "worktree",
                "add",
                "-b",
                "created",
                created.to_str().unwrap(),
                commit,
            ],
        );
        at(&created, &["rev-parse", "HEAD"])
    }
}

fn fetch_head(root: &Path, commit: &str) -> (PathBuf, String) {
    let path = root.join(".git").join("FETCH_HEAD");
    let text = format!("{commit}\t\tbranch 'unrelated' of test\n");
    std::fs::write(&path, &text).unwrap();
    (path, text)
}

#[tokio::test]
async fn creates_and_syncs_from_s_ignoring_stale_origin_head() {
    for branch in [
        "main",
        "master",
        "release/next",
        "head-topic",
        "HEAD",
        "head",
        "HEAD/topic",
        "head/topic",
        "release/quote'$(printf${IFS}x)&`printf${IFS}y`",
    ] {
        let (repos, before) = repos("roamgate-default-branch-", "main", "checkout with spaces");
        let root = &repos.root;
        at(root, &["checkout", "-b", "feature/test"]);
        let expected = commit(&repos.seed, "default branch update");
        at(
            &repos.seed,
            &["push", repos.remote(), &format!("HEAD:refs/heads/{branch}")],
        );
        at(
            &repos.remote,
            &["symbolic-ref", "HEAD", &format!("refs/heads/{branch}")],
        );
        // A stale local default and a stale main branch on the remote.
        assert_eq!(
            at(
                root,
                &["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]
            ),
            "origin/main"
        );
        // A narrow fetch configuration must not constrain the default commit.
        at(
            root,
            &[
                "config",
                "remote.origin.fetch",
                "+refs/heads/main:refs/remotes/origin/main",
            ],
        );
        let tracking = at(root, &["show-ref", "--verify", "refs/remotes/origin/main"]);
        let (fetch_head_path, fetch_head_text) = fetch_head(root, &before);
        let dirty = root.join("uncommitted.txt");
        std::fs::write(&dirty, "keep me").unwrap();
        let status = at(root, &["status", "--porcelain"]);
        let synced = base(root).await;
        assert_eq!(synced.base, format!("origin/{branch}"), "{branch}");
        assert_eq!(synced.commit, expected, "{branch}");
        let main_tracking = if branch == "main" {
            format!("{expected} refs/remotes/origin/main")
        } else {
            tracking.clone()
        };
        if !["head", "head/topic"].contains(&branch.to_lowercase().as_str()) {
            assert_eq!(
                at(
                    root,
                    &["rev-parse", &format!("refs/remotes/origin/{branch}")]
                ),
                expected
            );
        }
        assert_eq!(
            at(root, &["symbolic-ref", "refs/remotes/origin/HEAD"]),
            "refs/remotes/origin/main"
        );
        assert_eq!(
            at(root, &["show-ref", "--verify", "refs/remotes/origin/main"]),
            main_tracking
        );
        assert_eq!(
            std::fs::read_to_string(&fetch_head_path).unwrap(),
            fetch_head_text
        );
        assert_eq!(at(root, &["rev-parse", "HEAD"]), before);
        assert_eq!(at(root, &["status", "--porcelain"]), status);
        assert_eq!(std::fs::read_to_string(&dirty).unwrap(), "keep me");
        assert_eq!(repos.add_worktree(&synced.commit), expected);
        std::fs::remove_file(&dirty).unwrap();
        let sync = sync_workspace_branch(&cx(), root.to_str().unwrap())
            .await
            .unwrap();
        assert_eq!(sync.last_status.as_deref(), Some("updated"), "{branch}");
        assert_eq!(
            sync.last_message,
            Some(format!("Merged origin/{branch} into feature/test."))
        );
        assert_eq!(at(root, &["rev-parse", "HEAD"]), expected);
        assert_eq!(
            at(root, &["show-ref", "--verify", "refs/remotes/origin/main"]),
            main_tracking
        );
        assert_eq!(
            std::fs::read_to_string(&fetch_head_path).unwrap(),
            fetch_head_text
        );
    }
}

#[tokio::test]
async fn prepares_and_syncs_s_while_preserving_dangling_origin_s() {
    for (branch, blocker) in [
        ("HEAD/topic", "HEAD"),
        ("HEAD/deep/topic", "HEAD"),
        ("release/alias/topic", "release/alias"),
        ("release/next", "HEAD"),
        ("HEAD", "HEAD"),
    ] {
        let (repos, original) = repos("roamgate-dangling-head-", "main", "checkout");
        let root = &repos.root;
        let expected = commit(&repos.seed, "new default");
        at(
            &repos.seed,
            &["push", repos.remote(), &format!("HEAD:refs/heads/{branch}")],
        );
        at(
            &repos.remote,
            &["symbolic-ref", "HEAD", &format!("refs/heads/{branch}")],
        );
        at(&repos.remote, &["update-ref", "-d", "refs/heads/main"]);
        at(root, &["remote", "prune", "origin"]);
        at(
            root,
            &[
                "symbolic-ref",
                &format!("refs/remotes/origin/{blocker}"),
                "refs/remotes/origin/main",
            ],
        );
        assert_eq!(at(root, &["for-each-ref", "refs/remotes/origin/"]), "");
        let (fetch_head_path, fetch_head_text) = fetch_head(root, &original);
        let dirty = root.join("uncommitted.txt");
        std::fs::write(&dirty, "keep me").unwrap();
        let synced = base(root).await;
        assert_eq!(synced.base, format!("origin/{branch}"), "{branch}");
        assert_eq!(synced.commit, expected);
        assert_eq!(at(root, &["rev-parse", "HEAD"]), original);
        assert_eq!(std::fs::read_to_string(&dirty).unwrap(), "keep me");
        assert_eq!(repos.add_worktree(&synced.commit), expected);
        std::fs::remove_file(&dirty).unwrap();
        let sync = sync_workspace_branch(&cx(), root.to_str().unwrap())
            .await
            .unwrap();
        assert_eq!(sync.last_status.as_deref(), Some("updated"), "{branch}");
        assert_eq!(at(root, &["rev-parse", "HEAD"]), expected);
        assert_eq!(
            at(root, &["symbolic-ref", "refs/remotes/origin/HEAD"]),
            "refs/remotes/origin/main"
        );
        assert_eq!(
            at(
                root,
                &["symbolic-ref", &format!("refs/remotes/origin/{blocker}")]
            ),
            "refs/remotes/origin/main"
        );
        assert_eq!(
            std::fs::read_to_string(&fetch_head_path).unwrap(),
            fetch_head_text
        );
        if branch == "release/next" {
            assert_eq!(
                at(
                    root,
                    &["rev-parse", &format!("refs/remotes/origin/{branch}")]
                ),
                expected
            );
        }
    }
}

#[tokio::test]
async fn supports_a_prefix_related_default_rename_from_s_to_s() {
    for (from, to) in [("foo", "foo/bar"), ("foo/bar", "foo")] {
        let (repos, original) = repos("roamgate-default-rename-", from, "checkout");
        let root = &repos.root;
        at(root, &["checkout", "-b", "feature/test"]);
        at(root, &["config", "fetch.prune", "true"]);
        let next = commit(&repos.seed, "renamed default");
        at(
            &repos.remote,
            &["symbolic-ref", "HEAD", &format!("refs/heads/{to}")],
        );
        at(
            &repos.remote,
            &["update-ref", "-d", &format!("refs/heads/{from}")],
        );
        at(
            &repos.seed,
            &["push", repos.remote(), &format!("{next}:refs/heads/{to}")],
        );
        let synced = base(root).await;
        assert_eq!(synced.base, format!("origin/{to}"));
        assert_eq!(synced.commit, next);
        assert_eq!(repos.add_worktree(&synced.commit), next);
        let sync = sync_workspace_branch(&cx(), root.to_str().unwrap())
            .await
            .unwrap();
        assert_eq!(sync.last_status.as_deref(), Some("updated"));
        assert_eq!(at(root, &["rev-parse", "HEAD"]), next);
        assert_eq!(
            at(root, &["rev-parse", &format!("refs/remotes/origin/{from}")]),
            original
        );
    }
}

#[tokio::test]
async fn refreshes_stale_origin_main_when_the_workspace_is_already_up_to_date() {
    let (repos, before) = repos("roamgate-stale-tracking-", "main", "checkout");
    let root = &repos.root;
    let expected = commit(&repos.seed, "remote update");
    at(&repos.seed, &["push", repos.remote(), "main"]);
    at(
        root,
        &[
            "fetch",
            "--no-write-fetch-head",
            "--refmap=",
            "origin",
            &expected,
        ],
    );
    at(root, &["merge", "--no-edit", &expected]);
    assert_eq!(at(root, &["rev-parse", "origin/main"]), before);
    assert!(at(root, &["status", "--porcelain=v1", "--branch"]).contains("ahead 1"));
    let (fetch_head_path, fetch_head_text) = fetch_head(root, &before);
    let sync = sync_workspace_branch(&cx(), root.to_str().unwrap())
        .await
        .unwrap();
    assert_eq!(sync.last_status.as_deref(), Some("up_to_date"));
    assert_eq!(at(root, &["rev-parse", "HEAD"]), expected);
    assert_eq!(at(root, &["rev-parse", "origin/main"]), expected);
    assert_eq!(
        at(root, &["status", "--porcelain=v1", "--branch"]),
        "## main...origin/main"
    );
    assert_eq!(
        std::fs::read_to_string(&fetch_head_path).unwrap(),
        fetch_head_text
    );
}

#[tokio::test]
async fn preserves_a_concurrent_s_tracking_ref_change_during_fetch() {
    for change in ["same", "newer", "symbolic"] {
        let (repos, before) = repos("roamgate-concurrent-tracking-", "main", "checkout");
        let root = repos.root.clone();
        let advertised = commit(&repos.seed, "advertised update");
        at(&repos.seed, &["push", repos.remote(), "main"]);
        let concurrent = Arc::new(Mutex::new(advertised.clone()));
        let (fetch_head_path, fetch_head_text) = fetch_head(&root, &before);
        let marker = format!("--refmap= origin '{advertised}'");
        let after: After = {
            let (seed, remote, root, before, concurrent) = (
                repos.seed.clone(),
                repos.remote.clone(),
                root.clone(),
                before.clone(),
                concurrent.clone(),
            );
            Box::new(move |command: &str| {
                if !command.contains(&marker) {
                    return;
                }
                if change == "newer" {
                    *concurrent.lock().unwrap() = commit(&seed, "concurrent update");
                    at(&seed, &["push", remote.to_str().unwrap(), "main"]);
                }
                if change == "symbolic" {
                    *concurrent.lock().unwrap() = before.clone();
                    at(&root, &["update-ref", "refs/heads/preserved", &before]);
                    at(
                        &root,
                        &[
                            "symbolic-ref",
                            "refs/remotes/origin/main",
                            "refs/heads/preserved",
                        ],
                    );
                } else {
                    at(&root, &["fetch", "--no-write-fetch-head", "origin"]);
                }
            })
        };
        let cx = GitContext::local(Arc::new(Local { after: Some(after) }));
        let sync = sync_workspace_branch(&cx, root.to_str().unwrap())
            .await
            .unwrap();
        let expected_status = if change == "newer" {
            "failed"
        } else {
            "updated"
        };
        assert_eq!(
            sync.last_status.as_deref(),
            Some(expected_status),
            "{change}"
        );
        if change == "newer" {
            assert!(
                sync.last_message
                    .as_deref()
                    .unwrap_or_default()
                    .contains("Unable to update origin/main's tracking ref"),
                "{:?}",
                sync.last_message
            );
        }
        let concurrent = concurrent.lock().unwrap().clone();
        assert_eq!(
            at(&root, &["rev-parse", "origin/main"]),
            concurrent,
            "{change}"
        );
        if change == "symbolic" {
            assert_eq!(
                at(&root, &["symbolic-ref", "refs/remotes/origin/main"]),
                "refs/heads/preserved"
            );
            assert_eq!(at(&root, &["rev-parse", "refs/heads/preserved"]), before);
        }
        let head = if change == "newer" {
            &before
        } else {
            &advertised
        };
        assert_eq!(&at(&root, &["rev-parse", "HEAD"]), head, "{change}");
        assert_eq!(
            std::fs::read_to_string(&fetch_head_path).unwrap(),
            fetch_head_text
        );
    }
}

#[tokio::test]
async fn supports_a_master_only_remote() {
    let (repos, expected) = repos("roamgate-master-only-", "master", "checkout");
    let synced = base(&repos.root).await;
    assert_eq!(synced.base, "origin/master");
    assert_eq!(synced.commit, expected);
    let sync = sync_workspace_branch(&cx(), repos.root.to_str().unwrap())
        .await
        .unwrap();
    assert_eq!(sync.last_status.as_deref(), Some("up_to_date"));
}

#[tokio::test]
async fn starts_from_the_checked_out_commit() {
    let dir = tempfile::Builder::new()
        .prefix("roamgate-no-origin-")
        .tempdir()
        .unwrap();
    git(&["init", "-q", dir.path().to_str().unwrap()]);
    let head = commit(dir.path(), "first");
    let synced = base(dir.path()).await;
    assert_eq!(synced.base, "HEAD");
    assert_eq!(synced.commit, head);
}
