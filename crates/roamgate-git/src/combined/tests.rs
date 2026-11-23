//! The combined working diff of one file (git.diff_file, kind
//! `combined`), and the review patch loader's git-config hardening kept
//! for it (git-combined.test.ts).

use std::fs;
use std::path::PathBuf;
use std::time::Duration;

use serde_json::{Value, json};

use super::*;
use crate::compare::tests::git;
use crate::diff::{FilesArgs, read_diff_file};
use crate::exec::GitContext;
use crate::exec::testing::{Wrapped, local};
use crate::patch::{DiffLine, parse_unified_diff};

struct Repo {
    _dir: tempfile::TempDir,
    root: PathBuf,
}

impl Repo {
    fn path(&self) -> &str {
        self.root.to_str().unwrap()
    }
}

fn empty_repository() -> Repo {
    let dir = tempfile::Builder::new()
        .prefix("roamgate-combined-git-")
        .tempdir()
        .unwrap();
    let root = dir.path().to_path_buf();
    git(&root, &["init", "-q", "-b", "main"]);
    Repo { _dir: dir, root }
}

fn repository() -> Repo {
    let repo = empty_repository();
    fs::write(repo.root.join("a.txt"), "one\ntwo\nthree\n").unwrap();
    git(&repo.root, &["add", "a.txt"]);
    git(&repo.root, &["commit", "-q", "-m", "base"]);
    repo
}

fn with_git_config(key: &str, value: &str) -> GitContext {
    Wrapped::env(&[
        ("GIT_CONFIG_COUNT", "1"),
        ("GIT_CONFIG_KEY_0", key),
        ("GIT_CONFIG_VALUE_0", value),
    ])
}

async fn combined_with(cx: &GitContext, repo: &Repo, path: &str, extra: Value) -> crate::Result<Value> {
    let mut params = json!({ "path": path, "kind": "combined" });
    if let (Some(params), Some(extra)) = (params.as_object_mut(), extra.as_object()) {
        params.extend(extra.clone());
    }
    read_diff_file(FilesArgs {
        cx,
        workspace_id: "w",
        root: repo.path(),
        params: &params,
        last_steps: None,
    })
    .await
}

async fn combined(repo: &Repo, path: &str) -> Value {
    combined_with(&local(), repo, path, json!({})).await.unwrap()
}

fn diff_of(file: &Value) -> &str {
    file["diff"].as_str().unwrap()
}

fn lines_of(diff: &str) -> Vec<DiffLine> {
    parse_unified_diff(diff)
        .into_iter()
        .flat_map(|f| f.hunks)
        .flat_map(|h| h.lines)
        .collect()
}

fn changed(diff: &str) -> Value {
    serde_json::to_value(
        lines_of(diff)
            .into_iter()
            .filter(|l| l.kind != LineKind::Context)
            .collect::<Vec<_>>(),
    )
    .unwrap()
}

#[tokio::test]
async fn a_file_s_staged_and_unstaged_changes_read_as_one_diff_against_head() {
    let repo = repository();
    fs::write(repo.root.join("a.txt"), "ONE\ntwo\nthree\n").unwrap();
    git(&repo.root, &["add", "a.txt"]);
    fs::write(repo.root.join("a.txt"), "ONE\ntwo\nTHREE\n").unwrap();
    let file = combined(&repo, "a.txt").await;
    assert_eq!(file["kind"], "combined");
    assert_eq!(
        changed(diff_of(&file)),
        json!([
            { "kind": "-", "old": 1, "new": null, "text": "one" },
            { "kind": "+", "old": null, "new": 1, "text": "ONE" },
            { "kind": "-", "old": 3, "new": null, "text": "three" },
            { "kind": "+", "old": null, "new": 3, "text": "THREE" },
        ])
    );
    assert_eq!(file["staged"], json!({ "old": [[1, 1]], "new": [[1, 1]] }));
}

#[tokio::test]
async fn a_chunk_is_partly_staged_when_the_index_holds_some_of_its_lines() {
    let repo = repository();
    fs::write(repo.root.join("a.txt"), "one\nnew 1\ntwo\nthree\n").unwrap();
    git(&repo.root, &["add", "a.txt"]);
    fs::write(repo.root.join("a.txt"), "one\nnew 1\nnew 2\ntwo\nthree\n").unwrap();
    let file = combined(&repo, "a.txt").await;
    let hunks = &parse_unified_diff(diff_of(&file))[0].hunks;
    assert_eq!(hunks.len(), 1);
    let added: Vec<_> = hunks[0]
        .lines
        .iter()
        .filter(|l| l.kind == LineKind::Added)
        .map(|l| l.new)
        .collect();
    assert_eq!(added, [Some(2), Some(3)]);
    assert_eq!(file["staged"], json!({ "old": [], "new": [[2, 2]] }));
}

#[tokio::test]
async fn staging_everything_marks_every_changed_line_staged_the_diff_unchanged() {
    let repo = repository();
    fs::write(repo.root.join("a.txt"), "one\nTWO\nthree\nfour\n").unwrap();
    let before = combined(&repo, "a.txt").await;
    assert_eq!(before["staged"], json!({ "old": [], "new": [] }));
    git(&repo.root, &["add", "a.txt"]);
    let after = combined(&repo, "a.txt").await;
    assert_eq!(after["diff"], before["diff"]);
    assert_eq!(
        after["staged"],
        json!({ "old": [[2, 2]], "new": [[2, 2], [4, 4]] })
    );
}

#[tokio::test]
async fn lines_added_above_an_unstaged_change_keep_the_staged_lines_numbers_right() {
    let repo = repository();
    fs::write(repo.root.join("a.txt"), "one\ntwo\nthree\nstaged\n").unwrap();
    git(&repo.root, &["add", "a.txt"]);
    fs::write(
        repo.root.join("a.txt"),
        "top 1\ntop 2\none\ntwo\nthree\nstaged\n",
    )
    .unwrap();
    let file = combined(&repo, "a.txt").await;
    assert_eq!(file["staged"], json!({ "old": [], "new": [[6, 6]] }));
}

#[tokio::test]
async fn an_untracked_file_is_a_new_file_nothing_of_it_staged() {
    let repo = repository();
    fs::write(repo.root.join("new.txt"), "fresh\nlines\n").unwrap();
    let file = combined(&repo, "new.txt").await;
    assert_eq!(file["untracked"], true);
    assert_eq!(
        serde_json::to_value(lines_of(diff_of(&file))).unwrap(),
        json!([
            { "kind": "+", "old": null, "new": 1, "text": "fresh" },
            { "kind": "+", "old": null, "new": 2, "text": "lines" },
        ])
    );
    assert_eq!(file["staged"], json!({ "old": [], "new": [] }));
}

#[tokio::test]
async fn a_new_file_added_to_the_index_then_edited_is_partly_staged() {
    let repo = repository();
    fs::write(repo.root.join("new.txt"), "first\n").unwrap();
    git(&repo.root, &["add", "new.txt"]);
    fs::write(repo.root.join("new.txt"), "first\nsecond\n").unwrap();
    let file = combined(&repo, "new.txt").await;
    assert!(file.get("untracked").is_none());
    let texts: Vec<_> = lines_of(diff_of(&file)).into_iter().map(|l| l.text).collect();
    assert_eq!(texts, ["first", "second"]);
    assert_eq!(file["staged"], json!({ "old": [], "new": [[1, 1]] }));
}

#[tokio::test]
async fn a_staged_rename_reads_as_a_rename_with_its_edits() {
    let repo = repository();
    git(&repo.root, &["mv", "a.txt", "b.txt"]);
    fs::write(repo.root.join("b.txt"), "one\ntwo\nthree\nfour\n").unwrap();
    let file = combined_with(&local(), &repo, "b.txt", json!({ "old_path": "a.txt" }))
        .await
        .unwrap();
    let parsed = &parse_unified_diff(diff_of(&file))[0];
    assert_eq!((parsed.old_path.as_str(), parsed.path.as_str()), ("a.txt", "b.txt"));
    assert!(diff_of(&file).contains("rename from a.txt"));
    assert_eq!(
        changed(diff_of(&file)),
        json!([{ "kind": "+", "old": null, "new": 4, "text": "four" }])
    );
    assert_eq!(file["staged"], json!({ "old": [], "new": [] }));
}

#[tokio::test]
async fn a_binary_file_has_no_lines_and_nothing_staged_to_tell() {
    let repo = repository();
    fs::write(repo.root.join("img.bin"), [0u8, 1, 2, 3, 0, 255]).unwrap();
    git(&repo.root, &["add", "img.bin"]);
    git(&repo.root, &["commit", "-q", "-m", "bin"]);
    fs::write(repo.root.join("img.bin"), [0u8, 9, 9, 0, 255]).unwrap();
    let file = combined(&repo, "img.bin").await;
    let parsed = &parse_unified_diff(diff_of(&file))[0];
    assert_eq!(parsed.binary, Some(true));
    assert!(parsed.hunks.is_empty());
    assert_eq!(file["staged"], json!({ "old": [], "new": [] }));
}

#[tokio::test]
async fn a_conflicted_file_is_read_against_head_without_staged_lines() {
    let repo = repository();
    let root = &repo.root;
    git(root, &["switch", "-q", "-c", "other"]);
    fs::write(root.join("a.txt"), "one\nother\nthree\n").unwrap();
    git(root, &["commit", "-q", "-am", "other"]);
    git(root, &["switch", "-q", "main"]);
    fs::write(root.join("a.txt"), "one\nmain\nthree\n").unwrap();
    git(root, &["commit", "-q", "-am", "main"]);
    // Fails on the conflict, as wanted.
    let _ = std::process::Command::new("git")
        .args(["-C", repo.path(), "merge", "-q", "other"])
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .env("GIT_AUTHOR_NAME", "T")
        .env("GIT_AUTHOR_EMAIL", "t@example.com")
        .env("GIT_COMMITTER_NAME", "T")
        .env("GIT_COMMITTER_EMAIL", "t@example.com")
        .output();
    let file = combined(&repo, "a.txt").await;
    assert_eq!(file["unmerged"], true);
    assert!(file.get("staged").is_none());
    assert!(diff_of(&file).contains("+<<<<<<<"));
}

#[tokio::test]
async fn a_repository_with_no_commit_yet_reads_its_files_as_new() {
    let repo = empty_repository();
    fs::write(repo.root.join("a.txt"), "one\n").unwrap();
    git(&repo.root, &["add", "a.txt"]);
    fs::write(repo.root.join("a.txt"), "one\ntwo\n").unwrap();
    let file = combined(&repo, "a.txt").await;
    let lines: Vec<_> = lines_of(diff_of(&file))
        .into_iter()
        .map(|l| (l.kind, l.text))
        .collect();
    assert_eq!(
        lines,
        [
            (LineKind::Added, "one".to_owned()),
            (LineKind::Added, "two".to_owned())
        ]
    );
    assert_eq!(file["staged"], json!({ "old": [], "new": [[1, 1]] }));
}

#[tokio::test]
async fn glob_characters_in_a_name_are_taken_literally() {
    let repo = repository();
    fs::write(repo.root.join("x*.txt"), "star\n").unwrap();
    fs::write(repo.root.join("xy.txt"), "other\n").unwrap();
    git(&repo.root, &["add", "x*.txt", "xy.txt"]);
    git(&repo.root, &["commit", "-q", "-m", "names"]);
    fs::write(repo.root.join("x*.txt"), "STAR\n").unwrap();
    fs::write(repo.root.join("xy.txt"), "OTHER\n").unwrap();
    let file = combined(&repo, "x*.txt").await;
    let paths: Vec<_> = parse_unified_diff(diff_of(&file))
        .into_iter()
        .map(|f| f.path)
        .collect();
    assert_eq!(paths, ["x*.txt"]);
}

#[test]
fn stagedlines_tells_a_removed_line_the_index_dropped_from_one_it_kept() {
    let combined =
        parse_unified_diff("diff --git a/f b/f\n--- a/f\n+++ b/f\n@@ -1,3 +1,1 @@\n-a\n-b\n c\n");
    let cached = parse_unified_diff("diff --git a/f b/f\n--- a/f\n+++ b/f\n@@ -1,2 +1,1 @@\n-a\n b\n");
    assert_eq!(
        staged_lines(combined.first(), cached.first(), None),
        CombinedStaged {
            old: vec![[1, 1]],
            new: vec![],
        }
    );
}

#[tokio::test]
async fn diff_suppressblankempty_does_not_shift_line_numbers() {
    let repo = repository();
    fs::write(repo.root.join("a.txt"), "a\n\nb\n").unwrap();
    git(&repo.root, &["commit", "-q", "-am", "blank line"]);
    fs::write(repo.root.join("a.txt"), "a\n\nB\n").unwrap();
    let cx = with_git_config("diff.suppressBlankEmpty", "true");
    let file = combined_with(&cx, &repo, "a.txt", json!({})).await.unwrap();
    assert_eq!(
        serde_json::to_value(&parse_unified_diff(diff_of(&file))[0].hunks[0].lines).unwrap(),
        json!([
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
    let mut pairs = Vec::new();
    for path in ["a.txt", "new.txt"] {
        let file = combined_with(&cx, &repo, path, json!({})).await.unwrap();
        pairs.extend(
            parse_unified_diff(diff_of(&file))
                .into_iter()
                .map(|f| (f.old_path, f.path)),
        );
    }
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
    let file = combined_with(&cx, &repo, "a/x.txt", json!({})).await.unwrap();
    let paths: Vec<_> = parse_unified_diff(diff_of(&file))
        .into_iter()
        .map(|f| f.path)
        .collect();
    assert_eq!(paths, ["a/x.txt"]);
}

#[tokio::test]
async fn non_ascii_names_show_as_they_are_in_the_combined_diff() {
    let repo = repository();
    let tracked = "caf\u{e9}.txt";
    let untracked = "na\u{ef}ve.txt";
    fs::write(repo.root.join(tracked), "one\n").unwrap();
    git(&repo.root, &["add", tracked]);
    git(&repo.root, &["commit", "-q", "-m", "accent"]);
    fs::write(repo.root.join(tracked), "two\n").unwrap();
    fs::write(repo.root.join(untracked), "fresh\n").unwrap();
    let mut paths = Vec::new();
    for path in [tracked, untracked] {
        let file = combined(&repo, path).await;
        paths.extend(parse_unified_diff(diff_of(&file)).into_iter().map(|f| f.path));
    }
    paths.sort();
    assert_eq!(paths, [tracked, untracked]);
}

#[cfg(unix)]
#[tokio::test]
async fn the_combined_read_refuses_links_out_of_the_checkout_and_fifos() {
    let repo = repository();
    let outside = tempfile::Builder::new()
        .prefix("roamgate-combined-outside-")
        .tempdir()
        .unwrap();
    fs::write(outside.path().join("secret.txt"), "secret\n").unwrap();
    std::os::unix::fs::symlink(outside.path().join("secret.txt"), repo.root.join("link.txt")).unwrap();
    std::os::unix::fs::symlink(outside.path(), repo.root.join("linked")).unwrap();
    assert!(
        std::process::Command::new("mkfifo")
            .arg(repo.root.join("pipe"))
            .status()
            .unwrap()
            .success()
    );
    let cx = Wrapped::deadline(Duration::from_millis(3000));
    let link = combined_with(&cx, &repo, "link.txt", json!({})).await.unwrap();
    assert!(diff_of(&link).contains("new file mode 120000"));
    assert!(!diff_of(&link).contains("secret\n"));
    let error = combined_with(&cx, &repo, "linked/secret.txt", json!({}))
        .await
        .unwrap_err();
    assert!(error.to_string().contains("outside the checkout"), "{error}");
    let error = combined_with(&cx, &repo, "pipe", json!({})).await.unwrap_err();
    assert!(error.to_string().contains("not a regular file"), "{error}");
    fs::write(repo.root.join("a.txt"), "one\n2\nthree\n").unwrap();
    let file = combined_with(&cx, &repo, "a.txt", json!({})).await.unwrap();
    assert!(diff_of(&file).contains("+2"));
}

#[tokio::test]
async fn what_a_login_profile_prints_before_the_output_is_skipped() {
    let repo = repository();
    fs::write(repo.root.join("a.txt"), "ONE\ntwo\nthree\n").unwrap();
    let cx = Wrapped::banner("Welcome 1 0 0\nmotd\n");
    let file = combined_with(&cx, &repo, "a.txt", json!({})).await.unwrap();
    let added: Vec<_> = lines_of(diff_of(&file))
        .into_iter()
        .filter(|l| l.kind == LineKind::Added)
        .collect();
    assert_eq!(
        serde_json::to_value(added).unwrap(),
        json!([{ "kind": "+", "old": null, "new": 1, "text": "ONE" }])
    );
}
