use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde_json::json;

use super::*;
use crate::exec::testing::{Scripted, local};
use crate::exec::{Ran, Request};
use crate::ignore::{NotARepoCache, collect_ignored_names};

struct Repo {
    _dir: tempfile::TempDir,
    root: PathBuf,
    context: ActionContext,
}

fn git_output(root: &Path, args: &[&str]) -> std::process::Output {
    std::process::Command::new("git")
        .arg("-C")
        .arg(root)
        .args(args)
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .output()
        .unwrap()
}

fn git(root: &Path, args: &[&str]) -> String {
    let output = git_output(root, args);
    assert!(
        output.status.success(),
        "git {args:?}: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8_lossy(&output.stdout).into_owned()
}

fn status(root: &Path) -> String {
    git(
        root,
        &[
            "-c",
            "core.quotepath=false",
            "status",
            "--porcelain=v1",
            "--untracked-files=all",
        ],
    )
}

fn repo(commit: bool) -> Repo {
    let dir = tempfile::Builder::new()
        .prefix("herdr-git-actions-")
        .tempdir()
        .unwrap();
    let root = dir.path().to_path_buf();
    git(&root, &["init", "-q", "-b", "main"]);
    git(&root, &["config", "user.email", "test@example.com"]);
    git(&root, &["config", "user.name", "Herdr Test"]);
    // Git for Windows' system config converts line endings on checkout;
    // these tests compare the bytes a discard restores.
    git(&root, &["config", "core.autocrlf", "false"]);
    if commit {
        fs::write(root.join("tracked.txt"), "base\n").unwrap();
        git(&root, &["add", "tracked.txt"]);
        git(&root, &["commit", "-q", "-m", "initial"]);
    }
    let context = ActionContext {
        git: local(),
        root: root.to_str().unwrap().to_owned(),
    };
    Repo {
        _dir: dir,
        root,
        context,
    }
}

fn read(root: &Path, name: &str) -> String {
    fs::read_to_string(root.join(name)).unwrap()
}

async fn fingerprint(repo: &Repo, path: &str) -> Option<Fingerprint> {
    collect_worktree_fingerprints(&repo.context, &[path.to_owned()])
        .await
        .unwrap()
        .remove(path)
}

fn assert_err(result: Result<impl std::fmt::Debug>, needle: &str) {
    let error = result.expect_err("should fail").to_string();
    assert!(error.contains(needle), "{error:?} lacks {needle:?}");
}

/// main and side changing tracked.txt each way, merged: a conflict.
fn conflict(repo: &Repo) {
    let root = &repo.root;
    git(root, &["checkout", "-q", "-b", "side"]);
    fs::write(root.join("tracked.txt"), "side\n").unwrap();
    git(root, &["commit", "-q", "-am", "side"]);
    git(root, &["checkout", "-q", "main"]);
    fs::write(root.join("tracked.txt"), "main\n").unwrap();
    git(root, &["commit", "-q", "-am", "main"]);
    assert!(!git_output(root, &["merge", "side"]).status.success());
}

#[test]
fn matches_actions_to_xy_states() {
    assert!(porcelain_allows_file_action("stage", "?? new.ts\n"));
    assert!(porcelain_allows_file_action("stage", " M mod.ts\n"));
    assert!(porcelain_allows_file_action("stage", "UU conflict.ts\n"));
    assert!(!porcelain_allows_file_action("stage", "M  staged.ts\n"));
    assert!(!porcelain_allows_file_action("stage", ""));
    assert!(porcelain_allows_file_action("unstage", "M  staged.ts\n"));
    assert!(!porcelain_allows_file_action("unstage", "?? new.ts\n"));
    assert!(!porcelain_allows_file_action("unstage", "UU conflict.ts\n"));
    assert!(porcelain_allows_file_action(
        "discard_unstaged",
        " M mod.ts\n"
    ));
    assert!(porcelain_allows_file_action(
        "discard_unstaged",
        "MM both.ts\n"
    ));
    assert!(!porcelain_allows_file_action(
        "discard_unstaged",
        "M  staged.ts\n"
    ));
    assert!(!porcelain_allows_file_action(
        "discard_unstaged",
        "?? new.ts\n"
    ));
    assert!(!porcelain_allows_file_action(
        "discard_unstaged",
        "UU c.ts\n"
    ));
    assert!(porcelain_allows_file_action(
        "delete_untracked",
        "?? new.ts\n"
    ));
    assert!(!porcelain_allows_file_action(
        "delete_untracked",
        " M mod.ts\n"
    ));
}

#[test]
fn counts_each_working_tree_bucket() {
    assert_eq!(
        parse_working_tree_counts(
            &[
                " M mod.ts",
                "M  staged.ts",
                "MM both.ts",
                "?? new.ts",
                "UU c.ts"
            ]
            .join("\n")
        ),
        WorkingTreeCounts {
            staged: 2,
            unstaged: 2,
            untracked: 1,
            conflicted: 1,
        }
    );
}

#[test]
fn decodes_base64_paths_and_numeric_values() {
    let path = "src/uni \u{fc}.ts";
    let output = format!(
        "{}\t12\t1700000000\n",
        base64::engine::general_purpose::STANDARD.encode(path)
    );
    assert_eq!(
        parse_fingerprint_listing(&output).get(path),
        Some(&Fingerprint {
            size: 12.0,
            mtime_ms: 1_700_000_000_000.0,
        })
    );
}

#[tokio::test]
async fn stages_untracked_and_unstaged_files() {
    let repo = repo(true);
    fs::write(repo.root.join("new file \u{fc}.txt"), "fresh\n").unwrap();
    fs::write(repo.root.join("tracked.txt"), "changed\n").unwrap();
    run_git_file_action(
        &repo.context,
        &json!({"action": "stage", "path": "new file \u{fc}.txt"}),
    )
    .await
    .unwrap();
    run_git_file_action(
        &repo.context,
        &json!({"action": "stage", "path": "tracked.txt"}),
    )
    .await
    .unwrap();
    let output = status(&repo.root);
    assert!(output.contains("A  \"new file \u{fc}.txt\""), "{output}");
    assert!(output.contains("M  tracked.txt"));
}

#[tokio::test]
async fn rejects_staging_when_nothing_changed_and_reports_a_refresh() {
    let repo = repo(true);
    assert_err(
        run_git_file_action(
            &repo.context,
            &json!({"action": "stage", "path": "tracked.txt"}),
        )
        .await,
        "refresh Changes",
    );
}

#[tokio::test]
async fn unstages_while_preserving_the_worktree() {
    let repo = repo(true);
    fs::write(repo.root.join("tracked.txt"), "changed\n").unwrap();
    git(&repo.root, &["add", "tracked.txt"]);
    run_git_file_action(
        &repo.context,
        &json!({"action": "unstage", "path": "tracked.txt"}),
    )
    .await
    .unwrap();
    assert!(status(&repo.root).contains(" M tracked.txt"));
    assert_eq!(read(&repo.root, "tracked.txt"), "changed\n");
}

#[tokio::test]
async fn unstages_a_rename_using_both_paths() {
    let repo = repo(true);
    git(&repo.root, &["mv", "tracked.txt", "renamed.txt"]);
    assert!(status(&repo.root).contains("R  tracked.txt -> renamed.txt"));
    run_git_file_action(
        &repo.context,
        &json!({"action": "unstage", "path": "renamed.txt", "old_path": "tracked.txt"}),
    )
    .await
    .unwrap();
    let output = status(&repo.root);
    assert!(output.contains("?? renamed.txt"));
    assert!(!output.contains("R  "));
}

#[tokio::test]
async fn unstages_on_an_unborn_head() {
    let repo = repo(false);
    fs::write(repo.root.join("new.txt"), "fresh\n").unwrap();
    git(&repo.root, &["add", "new.txt"]);
    run_git_file_action(
        &repo.context,
        &json!({"action": "unstage", "path": "new.txt"}),
    )
    .await
    .unwrap();
    assert!(status(&repo.root).contains("?? new.txt"));
    assert_eq!(read(&repo.root, "new.txt"), "fresh\n");
}

#[tokio::test]
async fn marks_conflicted_files_resolved_by_staging() {
    let repo = repo(true);
    conflict(&repo);
    assert!(status(&repo.root).contains("UU tracked.txt"));
    fs::write(repo.root.join("tracked.txt"), "resolved\n").unwrap();
    run_git_file_action(
        &repo.context,
        &json!({"action": "stage", "path": "tracked.txt"}),
    )
    .await
    .unwrap();
    assert!(status(&repo.root).contains("M  tracked.txt"));
}

#[tokio::test]
async fn discards_unstaged_changes_and_preserves_the_staged_version() {
    let repo = repo(true);
    fs::write(repo.root.join("tracked.txt"), "staged\n").unwrap();
    git(&repo.root, &["add", "tracked.txt"]);
    fs::write(repo.root.join("tracked.txt"), "newer work\n").unwrap();
    let print = fingerprint(&repo, "tracked.txt").await.unwrap();
    run_git_file_action(
        &repo.context,
        &json!({
            "action": "discard_unstaged",
            "path": "tracked.txt",
            "mtime_ms": print.mtime_ms,
            "size": print.size,
        }),
    )
    .await
    .unwrap();
    assert_eq!(read(&repo.root, "tracked.txt"), "staged\n");
    assert!(status(&repo.root).contains("M  tracked.txt"));
}

#[tokio::test]
async fn restores_a_deleted_file_when_discarding() {
    let repo = repo(true);
    fs::remove_file(repo.root.join("tracked.txt")).unwrap();
    run_git_file_action(
        &repo.context,
        &json!({"action": "discard_unstaged", "path": "tracked.txt"}),
    )
    .await
    .unwrap();
    assert_eq!(read(&repo.root, "tracked.txt"), "base\n");
}

#[tokio::test]
async fn refuses_to_discard_when_the_file_changed_after_the_refresh() {
    let repo = repo(true);
    fs::write(repo.root.join("tracked.txt"), "changed\n").unwrap();
    assert_err(
        run_git_file_action(
            &repo.context,
            &json!({"action": "discard_unstaged", "path": "tracked.txt", "mtime_ms": 1, "size": 999}),
        )
        .await,
        "refresh Changes",
    );
    assert_eq!(read(&repo.root, "tracked.txt"), "changed\n");
}

#[tokio::test]
async fn deletes_untracked_files_including_dash_prefixed_names() {
    let repo = repo(true);
    let name = "-odd name \u{fc}.txt";
    fs::write(repo.root.join(name), "temp\n").unwrap();
    let print = fingerprint(&repo, name).await.unwrap();
    run_git_file_action(
        &repo.context,
        &json!({
            "action": "delete_untracked",
            "path": name,
            "mtime_ms": print.mtime_ms,
            "size": print.size,
        }),
    )
    .await
    .unwrap();
    assert!(!status(&repo.root).contains(name));
}

#[tokio::test]
async fn refuses_to_delete_untracked_directories() {
    let repo = repo(true);
    fs::create_dir(repo.root.join("scratch")).unwrap();
    fs::write(repo.root.join("scratch").join("notes.txt"), "temp\n").unwrap();
    assert_err(
        run_git_file_action(
            &repo.context,
            &json!({"action": "delete_untracked", "path": "scratch"}),
        )
        .await,
        "not supported",
    );
    assert_eq!(read(&repo.root, "scratch/notes.txt"), "temp\n");
}

#[cfg(unix)]
#[tokio::test]
async fn deletes_untracked_symlinks_that_point_at_directories() {
    let repo = repo(true);
    fs::create_dir(repo.root.join("real-dir")).unwrap();
    std::os::unix::fs::symlink("real-dir", repo.root.join("dir-link")).unwrap();
    run_git_file_action(
        &repo.context,
        &json!({"action": "delete_untracked", "path": "dir-link"}),
    )
    .await
    .unwrap();
    assert!(fs::symlink_metadata(repo.root.join("dir-link")).is_err());
    assert!(
        fs::symlink_metadata(repo.root.join("real-dir"))
            .unwrap()
            .is_dir()
    );
}

#[cfg(unix)]
#[tokio::test]
async fn reads_local_fingerprints_in_process_as_the_stat_script_does() {
    use std::os::unix::fs::symlink;
    let repo = repo(true);
    let root = &repo.root;
    fs::write(root.join("-odd name \u{fc}.txt"), "temp\n").unwrap();
    fs::create_dir(root.join("dir")).unwrap();
    fs::write(root.join("dir/inner.txt"), "inner file\n").unwrap();
    symlink("dir/inner.txt", root.join("file-link")).unwrap();
    symlink("dir", root.join("dir-link")).unwrap();
    symlink("missing", root.join("dangling")).unwrap();
    let paths: Vec<String> = [
        "tracked.txt",
        "-odd name \u{fc}.txt",
        "dir/inner.txt",
        "file-link",
        "dir-link",
        "dangling",
        "dir",
        "absent.txt",
    ]
    .map(String::from)
    .to_vec();
    let runner = Scripted::new(|_: &Request| Ok(Ran::new(1, "", "spawned")));
    let context = ActionContext {
        git: GitContext::local(runner.clone()),
        root: repo.context.root.clone(),
    };
    let local = collect_worktree_fingerprints(&context, &paths)
        .await
        .unwrap();
    assert!(runner.calls().is_empty());
    let script = fill_template(
        UNTRACKED_STATS_SH,
        &[
            (
                "paths",
                paths
                    .iter()
                    .map(|p| shell_quote(p))
                    .collect::<Vec<_>>()
                    .join(" ")
                    .into(),
            ),
            ("root", shell_quote(&repo.context.root).into()),
        ],
    )
    .unwrap();
    let output = std::process::Command::new("sh")
        .args(["-c", &script])
        .output()
        .unwrap();
    assert!(output.status.success());
    let scripted = parse_fingerprint_listing(&String::from_utf8(output.stdout).unwrap());
    let mut keys: Vec<&String> = scripted.keys().collect();
    keys.sort();
    let mut wanted = vec![
        "-odd name \u{fc}.txt",
        "dir/inner.txt",
        "file-link",
        "tracked.txt",
    ];
    wanted.sort();
    assert_eq!(keys, wanted);
    assert_eq!(local, scripted);
}

#[tokio::test]
async fn fails_closed_on_destructive_actions_without_a_fingerprint() {
    let repo = repo(true);
    fs::write(repo.root.join("tracked.txt"), "changed\n").unwrap();
    fs::write(repo.root.join("untracked.txt"), "temp\n").unwrap();
    assert_err(
        run_git_file_action(
            &repo.context,
            &json!({"action": "discard_unstaged", "path": "tracked.txt"}),
        )
        .await,
        "refresh Changes",
    );
    assert_err(
        run_git_file_action(
            &repo.context,
            &json!({"action": "delete_untracked", "path": "untracked.txt"}),
        )
        .await,
        "refresh Changes",
    );
    assert_eq!(read(&repo.root, "tracked.txt"), "changed\n");
    assert_eq!(read(&repo.root, "untracked.txt"), "temp\n");
}

#[tokio::test]
async fn refuses_to_delete_a_tracked_file() {
    let repo = repo(true);
    assert_err(
        run_git_file_action(
            &repo.context,
            &json!({"action": "delete_untracked", "path": "tracked.txt"}),
        )
        .await,
        "refresh Changes",
    );
    assert_eq!(read(&repo.root, "tracked.txt"), "base\n");
}

#[tokio::test]
async fn rejects_paths_escaping_the_repository() {
    let repo = repo(true);
    assert_err(
        run_git_file_action(
            &repo.context,
            &json!({"action": "stage", "path": "../outside.txt"}),
        )
        .await,
        "invalid file explorer path",
    );
}

#[tokio::test]
async fn stages_and_unstages_everything() {
    let repo = repo(true);
    fs::write(repo.root.join("new.txt"), "fresh\n").unwrap();
    fs::write(repo.root.join("tracked.txt"), "changed\n").unwrap();
    let staged = run_git_repo_action(&repo.context, &json!({"action": "stage_all"}))
        .await
        .unwrap();
    assert_eq!(
        (
            staged.counts.staged,
            staged.counts.unstaged,
            staged.counts.untracked
        ),
        (2, 0, 0)
    );
    let unstaged = run_git_repo_action(&repo.context, &json!({"action": "unstage_all"}))
        .await
        .unwrap();
    assert_eq!(
        (
            unstaged.counts.staged,
            unstaged.counts.unstaged,
            unstaged.counts.untracked
        ),
        (0, 1, 1)
    );
    assert_eq!(read(&repo.root, "new.txt"), "fresh\n");
}

#[tokio::test]
async fn unstages_everything_on_an_unborn_head() {
    let repo = repo(false);
    fs::write(repo.root.join("new.txt"), "fresh\n").unwrap();
    git(&repo.root, &["add", "new.txt"]);
    let result = run_git_repo_action(&repo.context, &json!({"action": "unstage_all"}))
        .await
        .unwrap();
    assert_eq!((result.counts.staged, result.counts.untracked), (0, 1));
    assert_eq!(read(&repo.root, "new.txt"), "fresh\n");
}

#[tokio::test]
async fn discards_all_unstaged_changes_but_preserves_staged_ones() {
    let repo = repo(true);
    fs::write(repo.root.join("tracked.txt"), "staged\n").unwrap();
    git(&repo.root, &["add", "tracked.txt"]);
    fs::write(repo.root.join("tracked.txt"), "worktree\n").unwrap();
    let result = run_git_repo_action(
        &repo.context,
        &json!({"action": "discard_all_unstaged", "expected_counts": {"unstaged": 1}}),
    )
    .await
    .unwrap();
    assert_eq!((result.counts.staged, result.counts.unstaged), (1, 0));
    assert_eq!(read(&repo.root, "tracked.txt"), "staged\n");
}

#[tokio::test]
async fn refuses_repo_wide_discard_when_the_counts_are_stale() {
    let repo = repo(true);
    fs::write(repo.root.join("tracked.txt"), "changed\n").unwrap();
    assert_err(
        run_git_repo_action(
            &repo.context,
            &json!({"action": "discard_all_unstaged", "expected_counts": {"unstaged": 0}}),
        )
        .await,
        "refresh Changes",
    );
    assert_eq!(read(&repo.root, "tracked.txt"), "changed\n");
}

#[tokio::test]
async fn refuses_repo_wide_discard_while_conflicts_are_open() {
    let repo = repo(true);
    conflict(&repo);
    assert_err(
        run_git_repo_action(&repo.context, &json!({"action": "discard_all_unstaged"})).await,
        "resolve conflicted files",
    );
}

#[tokio::test]
async fn deletes_all_untracked_files_but_keeps_ignored_ones() {
    let repo = repo(true);
    fs::write(repo.root.join(".gitignore"), "ignored.txt\n").unwrap();
    git(&repo.root, &["add", ".gitignore"]);
    git(&repo.root, &["commit", "-q", "-m", "ignore"]);
    fs::write(repo.root.join("temp.txt"), "temp\n").unwrap();
    fs::write(repo.root.join("ignored.txt"), "keep\n").unwrap();
    let result = run_git_repo_action(
        &repo.context,
        &json!({"action": "delete_all_untracked", "expected_counts": {"untracked": 1}}),
    )
    .await
    .unwrap();
    assert_eq!(result.counts.untracked, 0);
    assert_eq!(read(&repo.root, "ignored.txt"), "keep\n");
}

fn names(list: &[&str]) -> Vec<String> {
    list.iter().map(|n| (*n).to_owned()).collect()
}

#[tokio::test]
async fn marks_ignored_entries_and_leaves_others_alone() {
    let repo = repo(true);
    fs::write(repo.root.join(".gitignore"), "build/\n*.log\n").unwrap();
    fs::write(repo.root.join("debug.log"), "log\n").unwrap();
    let ignored = collect_ignored_names(
        &local(),
        &NotARepoCache::default(),
        repo.context.root.as_str(),
        &names(&["tracked.txt", "debug.log", ".gitignore", "missing dir"]),
    )
    .await;
    assert_eq!(ignored.into_iter().collect::<Vec<_>>(), ["debug.log"]);
}

#[tokio::test]
async fn returns_an_empty_set_outside_a_repository() {
    let dir = tempfile::Builder::new()
        .prefix("herdr-not-a-repo-")
        .tempdir()
        .unwrap();
    let ignored = collect_ignored_names(
        &local(),
        &NotARepoCache::default(),
        dir.path().to_str().unwrap(),
        &names(&["file.txt"]),
    )
    .await;
    assert!(ignored.is_empty());
}

#[tokio::test]
async fn caches_non_repository_directories_and_skips_spawning_again() {
    let cache = NotARepoCache::default();
    let runner = Scripted::new(|_: &Request| Ok(Ran::new(128, "", "not a repo")));
    let cx = GitContext::local(runner.clone() as Arc<_>);
    for _ in 0..2 {
        assert!(
            collect_ignored_names(&cx, &cache, "/not-a-repo", &names(&["file.txt"]))
                .await
                .is_empty()
        );
    }
    assert_eq!(runner.calls().len(), 1);
}

#[tokio::test]
async fn does_not_cache_successful_ignore_checks() {
    let cache = NotARepoCache::default();
    let runner = Scripted::new(|_: &Request| Ok(Ran::new(1, "", "")));
    let cx = GitContext::local(runner.clone() as Arc<_>);
    for _ in 0..2 {
        collect_ignored_names(&cx, &cache, "/some-repo", &names(&["file.txt"])).await;
    }
    assert_eq!(runner.calls().len(), 2);
}
