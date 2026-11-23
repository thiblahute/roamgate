//! A review's diff file by file (review-files.test.ts).

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

use super::*;
use crate::compare::tests::git;
use crate::exec::testing::local;
use crate::review_patch::read_review_patch;

struct Repo {
    _dir: tempfile::TempDir,
    root: PathBuf,
}

impl Repo {
    fn path(&self) -> &str {
        self.root.to_str().unwrap()
    }
}

/// main: four files; topic: one of each change, generated and binary too.
fn repository() -> Repo {
    let dir = tempfile::Builder::new()
        .prefix("roamgate-review-files-")
        .tempdir()
        .unwrap();
    let root = dir.path().to_path_buf();
    let write = |name: &str, bytes: &[u8]| fs::write(root.join(name), bytes).unwrap();
    git(&root, &["init", "-q", "-b", "main"]);
    write("keep.txt", b"a\nb\nc\nd\ne\nf\n");
    write("gone.txt", b"x\n");
    write("old.txt", b"1\n2\n3\n4\n5\n6\n7\n");
    write(".gitattributes", b"gen.js linguist-generated\n");
    git(&root, &["add", "-A"]);
    git(&root, &["commit", "-q", "-m", "base"]);
    git(&root, &["switch", "-q", "-c", "topic"]);
    git(&root, &["rm", "-q", "gone.txt"]);
    git(&root, &["mv", "old.txt", "new.txt"]);
    write("new.txt", b"1\n2\n3\n4\n5\n6\n7\n8\n");
    write("keep.txt", b"a\nB\nc\nd\ne\nf\n");
    write("gen.js", b"x = 1;\n");
    write("bin.dat", &[0, 1, 2, 0]);
    git(&root, &["add", "-A"]);
    git(&root, &["commit", "-q", "-m", "change"]);
    Repo { _dir: dir, root }
}

fn range(base: &str, head: &str) -> SummaryOf {
    SummaryOf::Target(Target::range(base, head))
}

fn requests(summary: &Summary) -> Vec<FileRequest> {
    summary
        .files
        .iter()
        .map(|f| FileRequest {
            path: f.path.clone(),
            old_path: Some(f.old_path.clone()),
        })
        .collect()
}

#[tokio::test]
async fn a_range_s_summary_lists_each_file_with_its_status_and_counts_between_its_merge_base_and_head()
 {
    let repo = repository();
    let root: &Path = &repo.root;
    git(root, &["switch", "-q", "main"]);
    fs::write(root.join("later.txt"), "later\n").unwrap();
    git(root, &["add", "later.txt"]);
    git(root, &["commit", "-q", "-m", "main moves on"]);
    git(root, &["switch", "-q", "topic"]);
    let summary = read_review_summary(&local(), repo.path(), &range("main", "topic"))
        .await
        .unwrap();
    assert!(summary.summary);
    assert_eq!(
        summary.base_sha.as_deref().unwrap(),
        git(root, &["merge-base", "main", "topic"])
    );
    assert_eq!(
        summary.head_sha.as_deref().unwrap(),
        git(root, &["rev-parse", "topic"])
    );
    let by_path: BTreeMap<&str, &DiffFile> =
        summary.files.iter().map(|f| (f.path.as_str(), f)).collect();
    assert_eq!(
        by_path.keys().copied().collect::<Vec<_>>(),
        ["bin.dat", "gen.js", "gone.txt", "keep.txt", "new.txt"]
    );
    let keep = by_path["keep.txt"];
    assert_eq!(keep.status.as_deref(), Some("modified"));
    assert_eq!((keep.additions, keep.deletions), (Some(1), Some(1)));
    assert!(keep.hunks.is_empty());
    let new = by_path["new.txt"];
    assert_eq!(new.status.as_deref(), Some("renamed"));
    assert_eq!(new.old_path, "old.txt");
    assert_eq!((new.additions, new.deletions), (Some(1), Some(0)));
    let gone = by_path["gone.txt"];
    assert_eq!(gone.status.as_deref(), Some("deleted"));
    assert_eq!(gone.deletions, Some(1));
    let binary = by_path["bin.dat"];
    assert_eq!(binary.status.as_deref(), Some("added"));
    assert_eq!(binary.binary, Some(true));
    let generated = by_path["gen.js"];
    assert_eq!(generated.status.as_deref(), Some("added"));
    assert_eq!(generated.generated, Some(true));
    assert_eq!(keep.generated, None);
}

#[tokio::test]
async fn a_summary_s_files_read_a_few_at_a_time_are_the_whole_patch_s_files() {
    let repo = repository();
    let target = Target::range("main", "topic");
    let cx = local();
    let summary = read_review_summary(&cx, repo.path(), &SummaryOf::Target(target.clone()))
        .await
        .unwrap();
    let files = read_review_files(
        &cx,
        repo.path(),
        summary.base_sha.as_deref().unwrap(),
        summary.head_sha.as_deref().unwrap(),
        &requests(&summary),
    )
    .await
    .unwrap();
    let whole = read_review_patch(&cx, repo.path(), &target, None)
        .await
        .unwrap();
    let strip = |f: &DiffFile| (f.path.clone(), f.old_path.clone(), f.hunks.clone());
    let want: Vec<_> = summary
        .files
        .iter()
        .map(|f| whole.files.iter().find(|w| w.path == f.path).unwrap())
        .map(strip)
        .collect();
    assert_eq!(files.iter().map(strip).collect::<Vec<_>>(), want);
    assert_eq!(
        files.iter().find(|f| f.path == "bin.dat").unwrap().binary,
        Some(true)
    );
}

#[tokio::test]
async fn a_commit_s_summary_is_against_its_first_parent_a_root_commit_s_against_the_empty_tree() {
    let repo = repository();
    let cx = local();
    let second = git(&repo.root, &["rev-parse", "topic"]);
    let first = git(&repo.root, &["rev-parse", "main"]);
    let commit = read_review_summary(&cx, repo.path(), &SummaryOf::Commit(second.clone()))
        .await
        .unwrap();
    assert_eq!(commit.base_sha.as_deref(), Some(first.as_str()));
    assert_eq!(commit.head_sha.as_deref(), Some(second.as_str()));
    assert_eq!(commit.files.len(), 5);
    let root_commit = read_review_summary(&cx, repo.path(), &SummaryOf::Commit(first))
        .await
        .unwrap();
    assert_eq!(
        root_commit.base_sha.as_deref().unwrap(),
        git(&repo.root, &["hash-object", "-t", "tree", "/dev/null"])
    );
    let statuses: Vec<_> = root_commit
        .files
        .iter()
        .map(|f| f.status.as_deref().unwrap())
        .collect();
    assert_eq!(statuses, ["added", "added", "added", "added"]);
    let files = read_review_files(
        &cx,
        repo.path(),
        root_commit.base_sha.as_deref().unwrap(),
        root_commit.head_sha.as_deref().unwrap(),
        &[FileRequest::new("keep.txt")],
    )
    .await
    .unwrap();
    assert!(files[0].hunks[0].header.starts_with("@@ -0,0 +1,6 @@"));
}

#[tokio::test]
async fn a_compare_s_summary_is_tree_against_tree_a_step_s_between_its_snapshots() {
    let repo = repository();
    let cx = local();
    let compare = read_review_summary(
        &cx,
        repo.path(),
        &SummaryOf::Target(Target::Range {
            base: "main".into(),
            head: "topic".into(),
            compare: true,
        }),
    )
    .await
    .unwrap();
    assert_eq!(
        compare.base_sha.as_deref().unwrap(),
        git(&repo.root, &["rev-parse", "main"])
    );
    let before = git(&repo.root, &["rev-parse", "main^{tree}"]);
    let after = git(&repo.root, &["rev-parse", "topic^{tree}"]);
    let step = read_review_summary(
        &cx,
        repo.path(),
        &SummaryOf::Target(Target::Step {
            step: "1-abcdef01".into(),
            before: before.clone(),
            after,
            at: None,
            skipped: None,
        }),
    )
    .await
    .unwrap();
    assert_eq!(step.base_sha.as_deref(), Some(before.as_str()));
    assert_eq!(step.files.len(), 5);
}

#[tokio::test]
async fn a_range_whose_base_is_gone_says_so_as_the_whole_patch_does() {
    let repo = repository();
    let error = read_review_summary(&local(), repo.path(), &range("nothing-here", "topic"))
        .await
        .unwrap_err();
    assert!(matches!(error, GitError::Gone { .. }), "{error:?}");
}

#[test]
fn each_file_s_patch_is_cut_at_the_limit_on_a_whole_hunk_and_marked_the_others_are_whole() {
    let big = [
        "diff --git a/a.txt b/a.txt",
        "--- a/a.txt",
        "+++ b/a.txt",
        "@@ -1,1 +1,1 @@",
        "-one",
        "+ONE",
        "@@ -10,1 +10,1 @@",
        "-ten",
        "+TEN",
        "",
    ]
    .join("\n");
    let small = [
        "diff --git a/b.txt b/b.txt",
        "--- a/b.txt",
        "+++ b/b.txt",
        "@@ -1 +1 @@",
        "-b",
        "+B",
        "",
    ]
    .join("\n");
    let cut_at = big.find("@@ -10").unwrap() + 8;
    let output = format!(
        "\nROAMGATE-REVIEW-FILE 0\n{}\nROAMGATE-REVIEW-FILE 1\n{small}",
        &big[..cut_at + 1]
    );
    let files = parse_review_files(
        &output,
        &[
            FileRequest::new("a.txt"),
            FileRequest::new("b.txt"),
            FileRequest::new("c.txt"),
        ],
        cut_at,
    );
    assert_eq!(files[0].path, "a.txt");
    assert_eq!(files[0].truncated, Some(true));
    assert_eq!(files[0].hunks.len(), 1);
    assert_eq!(files[1].path, "b.txt");
    assert_eq!(files[1].truncated, None);
    assert_eq!(files[1].hunks.len(), 1);
    assert_eq!(files[2], DiffFile::new("c.txt", "c.txt"));
}

#[test]
fn the_files_script_refuses_names_that_are_not_revisions_paths_out_of_the_checkout_and_too_many_files()
 {
    let (base, head) = ("a".repeat(40), "b".repeat(40));
    let error = review_files_script(
        "/r",
        "main",
        &head,
        &[FileRequest::new("a")],
        GIT_DIFF_MAX_BYTES,
    )
    .unwrap_err();
    assert!(error.to_string().contains("invalid revision"));
    let error = review_files_script(
        "/r",
        &base,
        &head,
        &[FileRequest::new("../etc/passwd")],
        GIT_DIFF_MAX_BYTES,
    )
    .unwrap_err();
    assert!(error.to_string().contains("invalid path"));
    let many: Vec<FileRequest> = (0..33)
        .map(|i| FileRequest::new(&format!("f{i}")))
        .collect();
    let error = review_files_script("/r", &base, &head, &many, GIT_DIFF_MAX_BYTES).unwrap_err();
    assert!(error.to_string().contains("at most 32"));
}
