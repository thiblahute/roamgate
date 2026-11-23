//! Commit history on real repositories (git-history.test.ts).

use std::fs;
use std::path::Path;

use serde_json::json;

use super::*;
use crate::exec::testing::local;

fn git(root: &Path, args: &[&str]) -> String {
    crate::compare::tests::git(root, args)
}

fn context(root: &Path) -> HistoryContext {
    HistoryContext {
        git: local(),
        root: root.to_str().unwrap().to_owned(),
    }
}

fn init(prefix: &str) -> tempfile::TempDir {
    let dir = tempfile::Builder::new().prefix(prefix).tempdir().unwrap();
    git(dir.path(), &["init", "-q"]);
    git(dir.path(), &["config", "user.name", "Test User"]);
    git(dir.path(), &["config", "user.email", "test@example.com"]);
    dir
}

fn shas(page: &Value) -> Vec<String> {
    page["commits"]
        .as_array()
        .unwrap()
        .iter()
        .map(|c| c["sha"].as_str().unwrap().to_owned())
        .collect()
}

#[tokio::test]
async fn commit_history_reads_root_rename_and_deleted_content_from_revisions() {
    let dir = init("roamgate-commits-");
    let root = dir.path();
    let cx = context(root);
    assert_eq!(
        list_commits(&cx, &json!({})).await.unwrap()["commits"],
        json!([])
    );
    fs::write(root.join("original.txt"), "original\n").unwrap();
    git(root, &["add", "."]);
    git(
        root,
        &["commit", "-q", "-m", "First commit", "-m", "Body line"],
    );
    let first = git(root, &["rev-parse", "HEAD"]);
    let detail = read_commit(&cx, Some(&json!(first))).await.unwrap();
    assert_eq!(detail["base"], json!(null));
    assert_eq!(detail["parents"], json!([]));
    assert_eq!(detail["message"], "First commit\n\nBody line");
    let entry = &detail["entries"][0];
    assert_eq!(entry["path"], "original.txt");
    assert_eq!(entry["status"], "added");
    assert_eq!(entry["additions"], 1);
    assert_eq!(entry["deletions"], 0);
    let patch = read_commit_file(
        &cx,
        &json!({"sha": first, "base": null, "path": "original.txt"}),
    )
    .await
    .unwrap();
    assert!(patch["diff"].as_str().unwrap().contains("+original"));

    fs::rename(root.join("original.txt"), root.join("renamed.txt")).unwrap();
    git(root, &["add", "-A"]);
    git(root, &["commit", "-q", "-m", "Rename file"]);
    let second = git(root, &["rev-parse", "HEAD"]);
    let renamed = read_commit(&cx, Some(&json!(second))).await.unwrap();
    let entry = &renamed["entries"][0];
    assert_eq!(entry["path"], "renamed.txt");
    assert_eq!(entry["old_path"], "original.txt");
    assert_eq!(entry["status"], "renamed");

    git(root, &["rm", "-q", "renamed.txt"]);
    git(root, &["commit", "-q", "-m", "Delete file"]);
    let third = git(root, &["rev-parse", "HEAD"]);
    let deleted = read_commit(&cx, Some(&json!(third))).await.unwrap();
    let entry = &deleted["entries"][0];
    assert_eq!(entry["path"], "renamed.txt");
    assert_eq!(entry["status"], "deleted");
    assert_eq!(entry["deletions"], 1);
    fs::write(root.join("renamed.txt"), "uncommitted\n").unwrap();
    let preview = read_commit_preview(&cx, &json!({"sha": second, "path": "renamed.txt"}))
        .await
        .unwrap();
    assert_eq!(preview["text"], "original\n");
    let preview = read_commit_preview(&cx, &json!({"sha": first, "path": "original.txt"}))
        .await
        .unwrap();
    assert_eq!(preview["text"], "original\n");
    let page = list_commits(&cx, &json!({})).await.unwrap();
    assert_eq!(shas(&page), [third, second, first]);
    assert_eq!(page["has_more"], false);
    let error = read_commit_file(&cx, &json!({"sha": "HEAD", "base": null, "path": "x"}))
        .await
        .unwrap_err();
    assert!(error.to_string().contains("invalid commit id"));
}

#[tokio::test]
async fn merge_changes_compare_with_the_first_parent() {
    let dir = init("roamgate-merge-");
    let root = dir.path();
    let cx = context(root);
    fs::write(root.join("base.txt"), "base\n").unwrap();
    git(root, &["add", "."]);
    git(root, &["commit", "-q", "-m", "Base"]);
    let branch = git(root, &["branch", "--show-current"]);
    git(root, &["checkout", "-q", "-b", "feature"]);
    fs::write(root.join("feature.txt"), "feature\n").unwrap();
    git(root, &["add", "."]);
    git(root, &["commit", "-q", "-m", "Feature"]);
    git(root, &["checkout", "-q", &branch]);
    fs::write(root.join("main.txt"), "main\n").unwrap();
    git(root, &["add", "."]);
    git(root, &["commit", "-q", "-m", "Main"]);
    let first_parent = git(root, &["rev-parse", "HEAD"]);
    git(
        root,
        &["merge", "-q", "--no-ff", "feature", "-m", "Merge feature"],
    );
    let head = git(root, &["rev-parse", "HEAD"]);
    let merge = read_commit(&cx, Some(&json!(head))).await.unwrap();
    assert_eq!(merge["parents"].as_array().unwrap().len(), 2);
    assert_eq!(merge["base"], first_parent);
    let paths: Vec<&str> = merge["entries"]
        .as_array()
        .unwrap()
        .iter()
        .map(|e| e["path"].as_str().unwrap())
        .collect();
    assert_eq!(paths, ["feature.txt"]);
}

#[tokio::test]
async fn history_pages_remain_anchored_and_shallow_boundaries_are_explicit() {
    let dir = init("roamgate-history-pages-");
    let root = dir.path();
    let cx = context(root);
    for index in 0..32 {
        fs::write(root.join("file.txt"), format!("{index}\n")).unwrap();
        git(root, &["add", "."]);
        git(root, &["commit", "-q", "-m", &format!("Commit {index}")]);
    }
    let first = list_commits(&cx, &json!({})).await.unwrap();
    assert_eq!(first["commits"].as_array().unwrap().len(), 30);
    assert_eq!(first["has_more"], true);
    fs::write(root.join("file.txt"), "new head\n").unwrap();
    git(root, &["commit", "-q", "-am", "New head"]);
    let second = list_commits(&cx, &json!({"head": first["head"], "offset": 30}))
        .await
        .unwrap();
    let subjects: Vec<&str> = second["commits"]
        .as_array()
        .unwrap()
        .iter()
        .map(|c| c["subject"].as_str().unwrap())
        .collect();
    assert_eq!(subjects, ["Commit 1", "Commit 0"]);
    assert_eq!(second["has_more"], false);

    let clone_dir = tempfile::Builder::new()
        .prefix("roamgate-history-shallow-")
        .tempdir()
        .unwrap();
    let clone = clone_dir.path().join("clone");
    git(
        root,
        &[
            "clone",
            "-q",
            "--depth=1",
            &format!("file://{}", root.display()),
            clone.to_str().unwrap(),
        ],
    );
    let shallow_cx = context(&clone);
    let shallow = list_commits(&shallow_cx, &json!({})).await.unwrap();
    assert_eq!(shallow["shallow"], true);
    assert_eq!(shallow["commits"].as_array().unwrap().len(), 1);
    let boundary = read_commit(&shallow_cx, Some(&shallow["commits"][0]["sha"]))
        .await
        .unwrap();
    assert_eq!(boundary["shallow_boundary"], true);
    assert_eq!(boundary["entries"], json!([]));
}

#[tokio::test]
async fn binary_files_and_oversized_historical_previews_are_bounded() {
    let dir = init("roamgate-history-binary-");
    let root = dir.path();
    let cx = context(root);
    fs::write(root.join("data.bin"), [0u8, 1, 2, 3]).unwrap();
    fs::write(root.join("large.txt"), "x".repeat(PREVIEW_MAX_BYTES + 1)).unwrap();
    git(root, &["add", "."]);
    git(root, &["commit", "-q", "-m", "Add assets"]);
    let sha = git(root, &["rev-parse", "HEAD"]);
    let detail = read_commit(&cx, Some(&json!(sha))).await.unwrap();
    let binary = detail["entries"]
        .as_array()
        .unwrap()
        .iter()
        .find(|e| e["path"] == "data.bin")
        .unwrap();
    assert_eq!(binary["binary"], true);
    assert!(binary.get("additions").is_none());
    assert!(binary.get("deletions").is_none());
    let preview = read_commit_preview(&cx, &json!({"sha": sha, "path": "data.bin"}))
        .await
        .unwrap();
    assert_eq!(preview["binary"], true);
    assert_eq!(preview["text"], json!(null));
    assert_eq!(preview["truncated"], false);
    let large = read_commit_preview(&cx, &json!({"sha": sha, "path": "large.txt"}))
        .await
        .unwrap();
    assert_eq!(large["text"], json!(null));
    assert_eq!(large["truncated"], true);
    let patch = read_commit_file(&cx, &json!({"sha": sha, "base": null, "path": "large.txt"}))
        .await
        .unwrap();
    assert_eq!(patch["truncated"], true);
}
