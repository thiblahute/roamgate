use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;
#[cfg(unix)]
use std::time::Duration;

use super::*;
use crate::compare::tests::git;
use crate::exec::testing::{Scripted, Wrapped, local};
use crate::exec::{Ran, Request};
use crate::patch::LineKind;

struct Repo {
    _dir: tempfile::TempDir,
    root: PathBuf,
}

impl Repo {
    fn path(&self) -> &str {
        self.root.to_str().unwrap()
    }
}

/// main with a.txt, then topic changing its second line.
fn repository() -> Repo {
    let dir = tempfile::Builder::new()
        .prefix("roamgate-review-git-")
        .tempdir()
        .unwrap();
    let root = dir.path().to_path_buf();
    git(&root, &["init", "-q", "-b", "main"]);
    fs::write(root.join("a.txt"), "one\ntwo\nthree\n").unwrap();
    git(&root, &["add", "a.txt"]);
    git(&root, &["commit", "-q", "-m", "base"]);
    git(&root, &["switch", "-q", "-c", "topic"]);
    fs::write(root.join("a.txt"), "one\n2\nthree\n").unwrap();
    git(&root, &["commit", "-q", "-am", "change"]);
    Repo { _dir: dir, root }
}

fn range(base: &str, head: &str) -> Target {
    Target::range(base, head)
}

/// The real path as git prints it: `/` separators on Windows too.
fn real(path: &Path) -> String {
    let real = roamgate_base::paths::realpath(path)
        .unwrap()
        .to_string_lossy()
        .into_owned();
    if cfg!(windows) {
        real.replace('\\', "/")
    } else {
        real
    }
}

#[tokio::test]
async fn a_range_reviews_what_the_head_adds_since_the_merge_base() {
    let repo = repository();
    let root = &repo.root;
    git(root, &["switch", "-q", "main"]);
    fs::write(root.join("b.txt"), "main only\n").unwrap();
    git(root, &["add", "b.txt"]);
    git(root, &["commit", "-q", "-m", "main moves on"]);
    git(root, &["switch", "-q", "topic"]);
    let diff = read_review_patch(&local(), repo.path(), &range("main", "HEAD"), None)
        .await
        .unwrap();
    assert_eq!(paths(&diff), ["a.txt"]);
    assert_eq!(diff.head_sha.unwrap(), git(root, &["rev-parse", "HEAD"]));
    assert_eq!(
        diff.base_sha.unwrap(),
        git(root, &["merge-base", "main", "HEAD"])
    );
    assert!(!diff.truncated);
}

fn changed_lines(diff: &ReviewDiff) -> Vec<String> {
    diff.files
        .iter()
        .flat_map(|f| f.hunks.iter())
        .flat_map(|h| h.lines.iter())
        .filter(|l| l.kind != LineKind::Context)
        .map(|l| {
            let sign = if l.kind == LineKind::Added { "+" } else { "-" };
            format!("{sign}{}", l.text)
        })
        .collect()
}

#[tokio::test]
async fn comparing_two_versions_of_a_rewritten_branch_shows_only_what_changed() {
    let repo = repository();
    let root = &repo.root;
    git(root, &["branch", "topic-before"]);
    fs::write(root.join("a.txt"), "one\n2\nthree, fixed\n").unwrap();
    git(root, &["commit", "-q", "--amend", "-am", "change, folded"]);
    let whole = read_review_patch(&local(), repo.path(), &range("topic-before", "topic"), None)
        .await
        .unwrap();
    assert_eq!(
        changed_lines(&whole),
        ["-two", "-three", "+2", "+three, fixed"]
    );
    let target = Target::Range {
        base: "topic-before".into(),
        head: "topic".into(),
        compare: true,
    };
    let compare = read_review_patch(&local(), repo.path(), &target, None)
        .await
        .unwrap();
    assert_eq!(changed_lines(&compare), ["-three", "+three, fixed"]);
    assert_eq!(
        compare.base_sha.unwrap(),
        git(root, &["rev-parse", "topic-before"])
    );
    assert_eq!(
        compare.head_sha.unwrap(),
        git(root, &["rev-parse", "topic"])
    );
}

#[tokio::test]
async fn the_working_tree_includes_untracked_files() {
    let repo = repository();
    fs::write(repo.root.join("a.txt"), "one\n2\nthree\nfour\n").unwrap();
    fs::write(repo.root.join("new file.txt"), "fresh\n").unwrap();
    let diff = read_review_patch(&local(), repo.path(), &Target::Worktree, None)
        .await
        .unwrap();
    let mut files = paths(&diff);
    files.sort();
    assert_eq!(files, ["a.txt", "new file.txt"]);
}

#[tokio::test]
async fn an_unknown_revision_is_reported() {
    let repo = repository();
    let error = read_review_patch(&local(), repo.path(), &range("nope", "HEAD"), None)
        .await
        .unwrap_err();
    assert!(
        error
            .to_string()
            .contains("The review's base nope is gone from this checkout")
    );
    let error = read_review_commits(&local(), repo.path(), "main", "3996d0feec6")
        .await
        .unwrap_err();
    assert_eq!(
        error,
        GitError::Gone {
            code: GoneCode::HeadGone,
            message: "The review's head 3996d0feec6 is gone from this checkout".into(),
        }
    );
}

#[tokio::test]
async fn a_removed_checkout_is_reported_as_such_not_as_the_shell_s_error() {
    let repo = repository();
    let root = repo.path().to_owned();
    fs::remove_dir_all(&repo.root).unwrap();
    let cx = local();
    let gone = GitError::Gone {
        code: GoneCode::CheckoutGone,
        message: format!("This checkout no longer exists: {root}"),
    };
    let errors = vec![
        read_review_patch(&cx, &root, &range("main", "HEAD"), None)
            .await
            .unwrap_err(),
        read_review_patch(&cx, &root, &Target::Worktree, None)
            .await
            .unwrap_err(),
        read_review_state(&cx, &root, &range("main", "HEAD"))
            .await
            .unwrap_err(),
        read_review_commits(&cx, &root, "main", "HEAD")
            .await
            .unwrap_err(),
        read_review_commit_patch(&cx, &root, &"a".repeat(40))
            .await
            .unwrap_err(),
        read_review_file(&cx, &root, "", "a.txt").await.unwrap_err(),
    ];
    for error in errors {
        assert_eq!(error, gone);
    }
}

#[test]
fn over_ssh_a_removed_checkout_and_other_failures_are_told_apart() {
    let target = range("main", "HEAD");
    let gone = review_script_error(
        "Warning: Permanently added host\nROAMGATE-REVIEW-NO-CHECKOUT\n",
        "git failed",
        "/var/home/me/wt",
        Some(&target),
        None,
    );
    assert_eq!(
        gone,
        GitError::Gone {
            code: GoneCode::CheckoutGone,
            message: "This checkout no longer exists: /var/home/me/wt".into(),
        }
    );
    let base = review_script_error(
        "unknown revision: main\n",
        "git failed",
        "/r",
        Some(&target),
        None,
    );
    assert!(matches!(
        base,
        GitError::Gone {
            code: GoneCode::BaseGone,
            ..
        }
    ));
    let other = review_script_error("fatal: bad object", "git failed", "/r", None, None);
    assert_eq!(other, GitError::message("fatal: bad object"));
    assert_eq!(
        review_script_error("", "git failed", "/r", None, None).to_string(),
        "git failed"
    );
}

#[tokio::test]
async fn the_repository_root_is_found_from_a_subdirectory() {
    let repo = repository();
    let found = read_review_root(&local(), repo.path()).await.unwrap();
    let last = repo.root.file_name().unwrap().to_str().unwrap();
    assert!(found.ends_with(last));
}

#[tokio::test]
async fn an_empty_or_relative_checkout_is_refused_never_run_in_the_login_directory() {
    let runner = Scripted::new(|_: &Request| Ok(Ran::new(0, "/home/me\n", "")));
    let cx = GitContext::local(runner.clone());
    let error = read_review_root(&cx, "").await.unwrap_err();
    assert!(error.to_string().contains("must be an absolute path"));
    let remote = GitContext::new(Some("mac".into()), runner.clone());
    let error = read_review_root(&remote, "blog/public").await.unwrap_err();
    assert!(error.to_string().contains("must be an absolute path"));
    assert!(runner.calls().is_empty());
}

#[test]
fn a_cut_patch_drops_its_partial_last_file() {
    let output = [
        "ROAMGATE-REVIEW-SHAS b h",
        "diff --git a/x b/x",
        "--- a/x",
        "+++ b/x",
        "@@ -1 +1 @@",
        "-a",
        "+b",
        "diff --git a/y b/y",
        "--- a/y",
        "+++ b/y",
        "@@ -1 +1 @@",
        "-c",
    ]
    .join("\n");
    let diff = parse_review_patch_output(&output, 60);
    assert!(diff.truncated);
    assert_eq!(paths(&diff), ["x"]);
    assert_eq!(diff.base_sha.as_deref(), Some("b"));
}

#[test]
fn a_single_file_cut_at_the_size_limit_keeps_its_whole_lines_marked_cut() {
    let output = [
        "ROAMGATE-REVIEW-SHAS b h",
        "diff --git a/x b/x",
        "--- a/x",
        "+++ b/x",
        "@@ -0,0 +1,4 @@",
        "+first line",
        "+second line",
        "+third line",
        "+fourth line",
    ]
    .join("\n");
    let cut = output.find("+third").unwrap() + 4;
    let diff = parse_review_patch_output(&output[..cut], cut - 1);
    assert!(diff.truncated);
    assert_eq!(diff.files.len(), 1);
    assert_eq!(diff.files[0].truncated, Some(true));
    let texts: Vec<_> = diff.files[0].hunks[0]
        .lines
        .iter()
        .map(|l| l.text.as_str())
        .collect();
    assert_eq!(texts, ["first line", "second line"]);
}

#[tokio::test]
async fn files_are_read_at_a_commit_or_from_the_working_tree_inside_the_checkout() {
    let repo = repository();
    fs::write(repo.root.join("a.txt"), "one\n2\nthree\nlocal\n").unwrap();
    let base = git(&repo.root, &["rev-parse", "main"]);
    let cx = local();
    assert_eq!(
        read_review_file(&cx, repo.path(), &base, "a.txt")
            .await
            .unwrap(),
        "one\ntwo\nthree\n"
    );
    assert_eq!(
        read_review_file(&cx, repo.path(), "", "a.txt")
            .await
            .unwrap(),
        "one\n2\nthree\nlocal\n"
    );
    let error = read_review_file(&cx, repo.path(), "", "../etc/passwd")
        .await
        .unwrap_err();
    assert!(error.to_string().contains("invalid path"));
    let error = read_review_file(&cx, repo.path(), "HEAD;rm", "a.txt")
        .await
        .unwrap_err();
    assert!(error.to_string().contains("invalid revision"));
    assert!(valid_review_path("src/a.c"));
    for path in ["/abs", "a//b", "a/../b", ""] {
        assert!(!valid_review_path(path), "{path}");
    }
}

#[tokio::test]
async fn heads_of_several_checkouts_in_one_command() {
    let repo = repository();
    let root = repo.path().to_owned();
    let heads = read_review_heads(
        &local(),
        &[
            (root.clone(), "HEAD".into()),
            (root.clone(), "nope".into()),
            (root.clone(), "main".into()),
        ],
    )
    .await
    .unwrap();
    assert_eq!(
        heads,
        [
            Some(git(&repo.root, &["rev-parse", "HEAD"])),
            None,
            Some(git(&repo.root, &["rev-parse", "main"])),
        ]
    );
}

#[tokio::test]
async fn a_range_s_commits_come_oldest_first_each_with_its_own_diff() {
    let repo = repository();
    let root = &repo.root;
    fs::write(root.join("b.txt"), "second\n").unwrap();
    git(root, &["add", "b.txt"]);
    git(root, &["commit", "-q", "-m", "add b", "-m", "Body line."]);
    let cx = local();
    let commits = read_review_commits(&cx, repo.path(), "main", "HEAD")
        .await
        .unwrap();
    let subjects: Vec<_> = commits.iter().map(|c| c.subject.as_str()).collect();
    assert_eq!(subjects, ["change", "add b"]);
    assert_eq!(commits[1].body, "Body line.");
    assert_eq!(commits[1].parent.as_deref(), Some(commits[0].sha.as_str()));
    let first = read_review_commit_patch(&cx, repo.path(), &commits[0].sha)
        .await
        .unwrap();
    assert_eq!(paths(&first), ["a.txt"]);
    assert_eq!(first.head_sha.as_deref(), Some(commits[0].sha.as_str()));
    let second = read_review_commit_patch(&cx, repo.path(), &commits[1].sha)
        .await
        .unwrap();
    assert_eq!(paths(&second), ["b.txt"]);
    assert_eq!(second.base_sha.as_deref(), Some(commits[0].sha.as_str()));
    let base = git(root, &["rev-list", "--max-parents=0", "HEAD"]);
    let root_diff = read_review_commit_patch(&cx, repo.path(), &base)
        .await
        .unwrap();
    assert_eq!(paths(&root_diff), ["a.txt"]);
    let error = read_review_commit_patch(&cx, repo.path(), "HEAD; rm")
        .await
        .unwrap_err();
    assert!(error.to_string().contains("invalid commit"));
}

#[tokio::test]
async fn a_reworded_or_rebased_commit_keeps_its_patch_id_an_amended_one_not() {
    let repo = repository();
    let root = &repo.root;
    fs::write(root.join("b.txt"), "second\n").unwrap();
    git(root, &["add", "b.txt"]);
    git(root, &["commit", "-q", "-m", "add b"]);
    let before = git(root, &["rev-parse", "HEAD"]);
    let first = git(root, &["rev-parse", "HEAD~1"]);
    git(root, &["commit", "-q", "--amend", "-m", "add b, reworded"]);
    let reworded = git(root, &["rev-parse", "HEAD"]);
    fs::write(root.join("b.txt"), "second, amended\n").unwrap();
    git(root, &["commit", "-q", "-am", "add b, amended"]);
    let amended = git(root, &["rev-parse", "HEAD"]);
    let cx = local();
    let shas = vec![
        before.clone(),
        first.clone(),
        reworded.clone(),
        amended.clone(),
        "0".repeat(40),
    ];
    let ids = read_review_patch_ids(&cx, repo.path(), &shas)
        .await
        .unwrap();
    let mut keys: Vec<_> = ids.keys().cloned().collect();
    keys.sort();
    let mut want = vec![
        before.clone(),
        first.clone(),
        reworded.clone(),
        amended.clone(),
    ];
    want.sort();
    assert_eq!(keys, want);
    assert_eq!(ids[&reworded], ids[&before]);
    assert_ne!(ids[&first], ids[&before]);
    assert_ne!(ids[&amended], ids[&before]);
    assert!(
        read_review_patch_ids(&cx, repo.path(), &["0".repeat(40)])
            .await
            .unwrap()
            .is_empty()
    );
    let error = read_review_patch_ids(&cx, repo.path(), &["HEAD; rm".into()])
        .await
        .unwrap_err();
    assert!(error.to_string().contains("invalid commit"));
}

#[tokio::test]
async fn the_default_branch_itself_shows_its_recent_history() {
    let repo = repository();
    let cx = local();
    let commits = read_review_commits(&cx, repo.path(), "main", "main")
        .await
        .unwrap();
    assert!(!commits.is_empty());
    assert!(commits.iter().all(|c| c.history));
    assert_eq!(commits[0].sha, git(&repo.root, &["rev-parse", "main"]));
    let work = read_review_commits(&cx, repo.path(), "main", "HEAD")
        .await
        .unwrap();
    assert!(!work.iter().any(|c| c.history));
}

#[tokio::test]
async fn a_review_from_the_empty_tree_covers_the_whole_repository() {
    let repo = repository();
    let empty = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
    let cx = local();
    let diff = read_review_patch(&cx, repo.path(), &range(empty, "HEAD"), None)
        .await
        .unwrap();
    assert_eq!(paths(&diff), ["a.txt"]);
    assert!(diff.files[0].hunks[0].header.starts_with("@@ -0,0 "));
    let commits = read_review_commits(&cx, repo.path(), empty, "HEAD")
        .await
        .unwrap();
    let subjects: Vec<_> = commits.iter().map(|c| c.subject.as_str()).collect();
    assert_eq!(subjects, ["base", "change"]);
    assert!(!commits.iter().any(|c| c.history));
}

#[tokio::test]
async fn a_review_of_a_root_commit_as_root_root_compares_it_with_the_empty_tree() {
    let repo = repository();
    let cx = local();
    let first = git(&repo.root, &["rev-list", "--max-parents=0", "HEAD"]);
    for base in [
        format!("{first}^"),
        format!("{first}~1"),
        format!("{first}~"),
    ] {
        let target = range(&base, &first);
        let diff = read_review_patch(&cx, repo.path(), &target, None)
            .await
            .unwrap();
        assert_eq!(paths(&diff), ["a.txt"]);
        assert!(diff.files[0].hunks[0].header.starts_with("@@ -0,0 +1,3 @@"));
        let commits = read_review_commits(&cx, repo.path(), &base, &first)
            .await
            .unwrap();
        let subjects: Vec<_> = commits.iter().map(|c| c.subject.as_str()).collect();
        assert_eq!(subjects, ["base"]);
        assert!(
            !read_review_state(&cx, repo.path(), &target)
                .await
                .unwrap()
                .is_empty()
        );
    }
    let second = git(&repo.root, &["rev-parse", "HEAD"]);
    let diff = read_review_patch(
        &cx,
        repo.path(),
        &range(&format!("{second}^"), &second),
        None,
    )
    .await
    .unwrap();
    assert!(diff.files[0].hunks[0].header.starts_with("@@ -1,3 +1,3 @@"));
    let error = read_review_patch(&cx, repo.path(), &range("nothing-here^", &second), None)
        .await
        .unwrap_err();
    assert!(matches!(error, GitError::Gone { .. }));
    for target in [
        range("nothing-here^", &second),
        range(&format!("{second}^"), "gone-branch"),
    ] {
        let error = read_review_state(&cx, repo.path(), &target)
            .await
            .unwrap_err();
        assert!(matches!(error, GitError::Gone { .. }), "{error:?}");
    }
}

#[tokio::test]
async fn a_review_s_state_changes_when_its_code_does() {
    let repo = repository();
    let cx = local();
    let range = range("main", "HEAD");
    let read = |target: Target| {
        let cx = cx.clone();
        let root = repo.path().to_owned();
        async move { read_review_state(&cx, &root, &target).await.unwrap() }
    };
    let range0 = read(range.clone()).await;
    let work0 = read(Target::Worktree).await;
    assert_eq!(read(range.clone()).await, range0);
    assert_eq!(read(Target::Worktree).await, work0);
    fs::write(repo.root.join("a.txt"), "edited\n").unwrap();
    let work1 = read(Target::Worktree).await;
    assert_ne!(work1, work0);
    assert_eq!(read(range.clone()).await, range0);
    fs::write(repo.root.join("new.txt"), "x\n").unwrap();
    let work2 = read(Target::Worktree).await;
    assert_ne!(work2, work1);
    fs::write(repo.root.join("new.txt"), "y\n").unwrap();
    assert_ne!(read(Target::Worktree).await, work2);
    git(&repo.root, &["commit", "-q", "-am", "more"]);
    assert_ne!(read(range).await, range0);
}

#[tokio::test]
// Unix only: an agent's records are searched for POSIX paths (as the Bun
// server did); a Windows machine's records name drive paths.
#[cfg(unix)]
async fn an_agent_s_session_record_brings_in_the_repositories_it_edits() {
    let work = tempfile::Builder::new()
        .prefix("roamgate-review-scan-")
        .tempdir()
        .unwrap();
    let notes = work.path().join("notes");
    fs::create_dir(&notes).unwrap();
    git(&notes, &["init", "-q", "-b", "main"]);
    fs::write(notes.join("n.txt"), "n\n").unwrap();
    git(&notes, &["add", "n.txt"]);
    git(&notes, &["commit", "-q", "-m", "notes"]);
    let app = work.path().join("elsewhere").join("app");
    fs::create_dir_all(app.join("src")).unwrap();
    git(&app, &["init", "-q", "-b", "main"]);
    fs::write(app.join("src").join("main.rs"), "fn main() {}\n").unwrap();
    let home = work.path().join("home");
    let mangled: String = notes
        .to_str()
        .unwrap()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect();
    let records = home.join(".claude").join("projects").join(mangled);
    fs::create_dir_all(&records).unwrap();
    let record = serde_json::json!({"input": {"file_path": app.join("src").join("main.rs")}});
    fs::write(records.join("s.jsonl"), format!("{record}\n")).unwrap();
    let cx = Wrapped::env(&[("HOME", home.to_str().unwrap())]);
    let notes_path = notes.to_str().unwrap().to_owned();
    let repos = scan_review_repos(
        &cx,
        std::slice::from_ref(&notes_path),
        std::slice::from_ref(&notes_path),
    )
    .await
    .unwrap();
    let own = repos.iter().find(|r| r.seed).unwrap();
    let edited = repos.iter().find(|r| r.touched).unwrap();
    assert!(!own.dirty);
    assert_eq!(edited.root, real(&app));
    assert!(edited.dirty);
    assert_eq!(edited.ahead, 0);
}

#[tokio::test]
async fn subprojects_someone_works_in_count_pinned_ones_and_neighbors_do_not() {
    let work = tempfile::Builder::new()
        .prefix("roamgate-review-scan-")
        .tempdir()
        .unwrap();
    let commit = |root: &Path, file: &str| {
        fs::write(root.join(file), format!("{file}\n")).unwrap();
        git(root, &["add", file]);
        git(root, &["commit", "-q", "-m", file]);
    };
    let repo = |root: PathBuf| {
        fs::create_dir_all(&root).unwrap();
        git(&root, &["init", "-q", "-b", "main"]);
        commit(&root, "a.txt");
        git(&root, &["switch", "-q", "-c", "topic"]);
        commit(&root, "b.txt");
        root
    };
    let app = repo(work.path().join("app"));
    let other = work.path().join("other-branch");
    git(
        &app,
        &[
            "worktree",
            "add",
            "-q",
            "-b",
            "elsewhere",
            other.to_str().unwrap(),
            "main",
        ],
    );
    commit(&other, "c.txt");
    let lib = repo(work.path().join("lib"));
    let worked = repo(app.join("subprojects").join("worked"));
    let pinned = repo(app.join("subprojects").join("pinned"));
    git(&pinned, &["switch", "-q", "--detach", "HEAD"]);
    let roots: Vec<String> = scan_review_repos(&local(), &[app.to_str().unwrap().into()], &[])
        .await
        .unwrap()
        .into_iter()
        .map(|r| r.root)
        .collect();
    assert!(roots.contains(&real(&app)));
    assert!(roots.contains(&real(&worked)));
    assert!(!roots.contains(&real(&pinned)));
    assert!(!roots.contains(&real(&other)));
    assert!(!roots.contains(&real(&lib)));
}

/// git run as if the user's config set `key` to `value`.
fn with_git_config(key: &str, value: &str) -> GitContext {
    Wrapped::env(&[
        ("GIT_CONFIG_COUNT", "1"),
        ("GIT_CONFIG_KEY_0", key),
        ("GIT_CONFIG_VALUE_0", value),
    ])
}

#[tokio::test]
async fn diff_suppressblankempty_does_not_shift_line_numbers() {
    let repo = repository();
    fs::write(repo.root.join("a.txt"), "a\n\nb\n").unwrap();
    git(&repo.root, &["commit", "-q", "-am", "blank line"]);
    fs::write(repo.root.join("a.txt"), "a\n\nB\n").unwrap();
    let cx = with_git_config("diff.suppressBlankEmpty", "true");
    let diff = read_review_patch(&cx, repo.path(), &Target::Worktree, None)
        .await
        .unwrap();
    let lines = serde_json::to_value(&diff.files[0].hunks[0].lines).unwrap();
    assert_eq!(
        lines,
        serde_json::json!([
            { "kind": " ", "old": 1, "new": 1, "text": "a" },
            { "kind": " ", "old": 2, "new": 2, "text": "" },
            { "kind": "-", "old": 3, "new": null, "text": "b" },
            { "kind": "+", "old": null, "new": 3, "text": "B" },
        ])
    );
}

#[tokio::test]
async fn diff_mnemonicprefix_does_not_change_the_paths() {
    let repo = repository();
    fs::write(repo.root.join("a.txt"), "edited\n").unwrap();
    fs::write(repo.root.join("new.txt"), "fresh\n").unwrap();
    let cx = with_git_config("diff.mnemonicPrefix", "true");
    let diff = read_review_patch(&cx, repo.path(), &Target::Worktree, None)
        .await
        .unwrap();
    let mut pairs: Vec<_> = diff
        .files
        .iter()
        .map(|f| (f.old_path.clone(), f.path.clone()))
        .collect();
    pairs.sort();
    assert_eq!(
        pairs,
        [
            ("a.txt".to_owned(), "a.txt".to_owned()),
            ("new.txt".to_owned(), "new.txt".to_owned())
        ]
    );
}

#[tokio::test]
async fn diff_noprefix_keeps_a_real_top_level_a_directory() {
    let repo = repository();
    fs::create_dir(repo.root.join("a")).unwrap();
    fs::write(repo.root.join("a").join("x.txt"), "one\n").unwrap();
    git(&repo.root, &["add", "a/x.txt"]);
    git(&repo.root, &["commit", "-q", "-m", "a dir"]);
    fs::write(repo.root.join("a").join("x.txt"), "two\n").unwrap();
    let cx = with_git_config("diff.noprefix", "true");
    let diff = read_review_patch(&cx, repo.path(), &Target::Worktree, None)
        .await
        .unwrap();
    assert_eq!(paths(&diff), ["a/x.txt"]);
}

#[tokio::test]
async fn non_ascii_names_show_as_they_are_in_a_worktree_review() {
    let repo = repository();
    let tracked = "caf\u{e9}.txt";
    let untracked = "na\u{ef}ve.txt";
    fs::write(repo.root.join(tracked), "one\n").unwrap();
    git(&repo.root, &["add", tracked]);
    git(&repo.root, &["commit", "-q", "-m", "accent"]);
    fs::write(repo.root.join(tracked), "two\n").unwrap();
    fs::write(repo.root.join(untracked), "fresh\n").unwrap();
    let diff = read_review_patch(&local(), repo.path(), &Target::Worktree, None)
        .await
        .unwrap();
    let mut files = paths(&diff);
    files.sort();
    assert_eq!(files, [tracked, untracked]);
}

#[cfg(unix)]
#[tokio::test]
async fn the_working_tree_read_refuses_links_out_of_the_checkout_and_fifos() {
    let repo = repository();
    let outside = tempfile::Builder::new()
        .prefix("roamgate-review-outside-")
        .tempdir()
        .unwrap();
    fs::write(outside.path().join("secret.txt"), "secret\n").unwrap();
    std::os::unix::fs::symlink(
        outside.path().join("secret.txt"),
        repo.root.join("link.txt"),
    )
    .unwrap();
    std::os::unix::fs::symlink(outside.path(), repo.root.join("linked")).unwrap();
    let fifo = repo.root.join("pipe");
    assert!(
        std::process::Command::new("mkfifo")
            .arg(&fifo)
            .status()
            .unwrap()
            .success()
    );
    let cx = Wrapped::deadline(Duration::from_millis(10_000));
    let read = |path: &'static str| {
        let cx = cx.clone();
        let root = repo.path().to_owned();
        async move { read_review_file(&cx, &root, "", path).await }
    };
    assert!(
        read("link.txt")
            .await
            .unwrap_err()
            .to_string()
            .contains("not a regular file")
    );
    assert!(
        read("linked/secret.txt")
            .await
            .unwrap_err()
            .to_string()
            .contains("outside the checkout")
    );
    assert!(
        read("pipe")
            .await
            .unwrap_err()
            .to_string()
            .contains("not a regular file")
    );
    assert_eq!(read("a.txt").await.unwrap(), "one\n2\nthree\n");
}

#[test]
fn the_shas_are_found_after_what_a_login_profile_printed() {
    let diff = parse_review_patch_output(
        &[
            "Welcome to the host!",
            "ROAMGATE-REVIEW-SHAS b h",
            "diff --git a/x b/x",
            "--- a/x",
            "+++ b/x",
            "@@ -1 +1 @@",
            "-a",
            "+b",
        ]
        .join("\n"),
        REVIEW_PATCH_MAX_BYTES,
    );
    assert_eq!(diff.base_sha.as_deref(), Some("b"));
    assert_eq!(diff.head_sha.as_deref(), Some("h"));
    assert_eq!(paths(&diff), ["x"]);
}

#[tokio::test]
async fn heads_match_their_entries_despite_a_login_banner() {
    let repo = repository();
    let root = repo.path().to_owned();
    let cx = Wrapped::banner("Last login: today\n");
    let heads = read_review_heads(
        &cx,
        &[
            (root.clone(), "HEAD".into()),
            (root.clone(), "nope".into()),
            (root.clone(), "main".into()),
        ],
    )
    .await
    .unwrap();
    assert_eq!(
        heads,
        [
            Some(git(&repo.root, &["rev-parse", "HEAD"])),
            None,
            Some(git(&repo.root, &["rev-parse", "main"])),
        ]
    );
}

#[tokio::test]
async fn a_windows_host_s_repositories_are_scanned_and_kept() {
    let now = now_seconds() as i64;
    let runner = Scripted::new(move |_: &Request| {
        Ok(Ran::new(
            0,
            format!("C:/work/app\tmain\tmain\t0\t1\t1\t{now}\n"),
            "",
        ))
    });
    let cx = GitContext::local(runner.clone() as Arc<_>);
    let repos = scan_review_repos(&cx, &["C:\\work".into()], &[])
        .await
        .unwrap();
    let Invocation::Local(argv) = &runner.calls()[0].invocation else {
        panic!()
    };
    assert!(argv.join(" ").contains("'C:\\work'"));
    assert_eq!(
        repos,
        [ReviewRepo {
            root: "C:/work/app".into(),
            branch: "main".into(),
            base: "main".into(),
            ahead: 0,
            dirty: true,
            seed: true,
            touched: false,
            active: now,
        }]
    );
}

#[tokio::test]
async fn a_review_s_state_sees_every_untracked_file_past_the_first_200() {
    let repo = repository();
    for at in 0..230 {
        fs::write(repo.root.join(format!("u{at:03}.txt")), "x\n").unwrap();
    }
    let cx = local();
    let before = read_review_state(&cx, repo.path(), &Target::Worktree)
        .await
        .unwrap();
    fs::write(repo.root.join("u229.txt"), "y\n").unwrap();
    assert_ne!(
        read_review_state(&cx, repo.path(), &Target::Worktree)
            .await
            .unwrap(),
        before
    );
}

#[tokio::test]
async fn one_file_s_patch_is_read_whole_past_200_untracked_files_and_the_4_mib_cut() {
    let repo = repository();
    for at in 0..210 {
        fs::write(repo.root.join(format!("u{at:03}.txt")), "x\n").unwrap();
    }
    let cx = local();
    let whole = read_review_patch(&cx, repo.path(), &Target::Worktree, None)
        .await
        .unwrap();
    assert!(!whole.files.iter().any(|f| f.path == "u209.txt"));
    let late = read_review_patch(
        &cx,
        repo.path(),
        &Target::Worktree,
        Some(&["u209.txt".into()]),
    )
    .await
    .unwrap();
    assert_eq!(paths(&late), ["u209.txt"]);
    let big = "line of text that is long enough\n".repeat(140_000);
    fs::write(repo.root.join("big.txt"), big).unwrap();
    git(&repo.root, &["add", "big.txt"]);
    git(&repo.root, &["commit", "-q", "-m", "big"]);
    let target = range("main", "HEAD");
    assert!(
        read_review_patch(&cx, repo.path(), &target, None)
            .await
            .unwrap()
            .truncated
    );
    let one = read_review_patch(&cx, repo.path(), &target, Some(&["big.txt".into()]))
        .await
        .unwrap();
    assert!(!one.truncated);
    assert_eq!(paths(&one), ["big.txt"]);
    assert_eq!(one.files[0].hunks[0].lines.len(), 140_000);
}
