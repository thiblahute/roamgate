//! Several files of one scope in one shell command (git-diff-files.test.ts).

use std::fs;
#[cfg(unix)]
use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;

use serde_json::{Value, json};

use super::*;
use crate::compare::tests::git;
use crate::exec::testing::{Loopback, Wrapped, local};

struct Repo {
    _dir: tempfile::TempDir,
    root: PathBuf,
}

impl Repo {
    fn path(&self) -> &str {
        self.root.to_str().unwrap()
    }
}

/// main with a.txt..e.txt, a branch changing each.
fn repository() -> Repo {
    let dir = tempfile::Builder::new()
        .prefix("roamgate-diff-files-")
        .tempdir()
        .unwrap();
    let root = dir.path().to_path_buf();
    git(&root, &["init", "-q", "-b", "main"]);
    for name in ["a", "b", "c", "d", "e"] {
        fs::write(
            root.join(format!("{name}.txt")),
            format!("{name} one\n{name} two\n"),
        )
        .unwrap();
    }
    git(&root, &["add", "-A"]);
    git(&root, &["commit", "-qm", "base"]);
    git(&root, &["checkout", "-qb", "feature"]);
    for name in ["a", "b", "c", "d", "e"] {
        fs::write(
            root.join(format!("{name}.txt")),
            format!("{name} one\n{name} 2\n"),
        )
        .unwrap();
    }
    git(&root, &["commit", "-qam", "change"]);
    Repo { _dir: dir, root }
}

async fn files(cx: &GitContext, root: &str, params: Value) -> crate::Result<Value> {
    read_diff_files(FilesArgs {
        cx,
        workspace_id: "w",
        root,
        params: &params,
        last_steps: None,
    })
    .await
}

async fn file(cx: &GitContext, root: &str, params: Value) -> crate::Result<Value> {
    read_diff_file(FilesArgs {
        cx,
        workspace_id: "w",
        root,
        params: &params,
        last_steps: None,
    })
    .await
}

#[tokio::test]
async fn reads_several_files_of_a_branch_review_with_one_shell_command_each_its_own_patch() {
    let repo = repository();
    let paths = ["a.txt", "b.txt", "c.txt", "d.txt", "e.txt"];
    let mut one = Vec::new();
    for path in paths {
        one.push(
            file(
                &local(),
                repo.path(),
                json!({"mode": "branch-main", "path": path, "kind": "branch"}),
            )
            .await
            .unwrap(),
        );
    }
    // The base is kept a few seconds from its first resolution: resolved
    // again right before the batch, so a slow machine still reuses it.
    forget_recent_bases();
    let warmed = std::time::Instant::now();
    file(
        &local(),
        repo.path(),
        json!({"mode": "branch-main", "path": "a.txt", "kind": "branch"}),
    )
    .await
    .unwrap();
    let counting = Loopback::new();
    let cx = GitContext::local(counting.clone() as Arc<_>);
    let read = files(
        &cx,
        repo.path(),
        json!({
            "mode": "branch-main",
            "entries": paths.iter().map(|p| json!({"path": p, "kind": "branch"})).collect::<Vec<_>>(),
        }),
    )
    .await
    .unwrap();
    // The base resolved within the last seconds is reused: only the batch
    // runs (unless this machine took the whole reuse window to get here).
    if warmed.elapsed() < COMPARISON_BASE_REUSE {
        assert_eq!(counting.calls().len(), 1);
    }
    let read = read["files"].as_array().unwrap();
    for (index, each) in read.iter().enumerate() {
        assert_eq!(each["path"], paths[index]);
        assert_eq!(each, &one[index]);
        assert!(
            each["diff"]
                .as_str()
                .unwrap()
                .contains(&format!("+{} 2", &paths[index][..1]))
        );
    }
}

#[cfg(unix)]
fn mkfifo(path: &Path) {
    assert!(
        std::process::Command::new("mkfifo")
            .arg(path)
            .status()
            .unwrap()
            .success()
    );
}

#[cfg(unix)]
#[tokio::test]
async fn gives_each_file_of_the_working_review_its_combined_diff_and_a_failing_file_its_own_error()
{
    let repo = repository();
    fs::write(repo.root.join("a.txt"), "a one\na staged\n").unwrap();
    git(&repo.root, &["add", "a.txt"]);
    fs::write(repo.root.join("a.txt"), "a one\na staged\nand more\n").unwrap();
    fs::write(repo.root.join("new.txt"), "brand new\n").unwrap();
    mkfifo(&repo.root.join("pipe"));
    let read = files(
        &local(),
        repo.path(),
        json!({
            "mode": "working",
            "entries": [
                {"path": "a.txt", "kind": "combined"},
                {"path": "pipe", "kind": "combined"},
                {"path": "new.txt", "kind": "combined"},
            ],
        }),
    )
    .await
    .unwrap();
    let read = read["files"].as_array().unwrap();
    let single = file(
        &local(),
        repo.path(),
        json!({"mode": "working", "path": "a.txt", "kind": "combined"}),
    )
    .await
    .unwrap();
    assert_eq!(read[0], single);
    assert!(read[0].get("staged").is_some());
    assert!(
        read[1]["error"]
            .as_str()
            .unwrap()
            .contains("not a regular file")
    );
    assert_eq!(read[2]["path"], "new.txt");
    assert_eq!(read[2]["untracked"], true);
    assert!(read[2]["diff"].as_str().unwrap().contains("+brand new"));
}

#[tokio::test]
async fn keeps_the_per_file_caps_a_large_automatic_file_is_deferred_not_sent() {
    let repo = repository();
    fs::write(
        repo.root.join("b.txt"),
        format!("{}\n", "x".repeat(LARGE_DIFF_PATCH_BYTES + 10)),
    )
    .unwrap();
    let read = files(
        &local(),
        repo.path(),
        json!({
            "mode": "working",
            "automatic": true,
            "entries": [
                {"path": "a.txt", "kind": "unstaged"},
                {"path": "b.txt", "kind": "unstaged"},
            ],
        }),
    )
    .await
    .unwrap();
    assert_eq!(read["files"][1]["deferred"], true);
    assert_eq!(read["files"][1]["diff"], "");
    assert!(read["files"][0].get("deferred").is_none());
}

#[tokio::test]
async fn refuses_no_entries_and_more_than_its_maximum() {
    let error = files(&local(), "/nowhere", json!({"entries": []}))
        .await
        .unwrap_err();
    assert!(error.to_string().contains("requires entries"));
    let entries: Vec<Value> = (0..=GIT_DIFF_FILES_MAX)
        .map(|i| json!({"path": format!("f{i}")}))
        .collect();
    let error = files(&local(), "/nowhere", json!({"entries": entries}))
        .await
        .unwrap_err();
    assert!(error.to_string().contains("at most"));
}

#[tokio::test]
async fn frames_each_script_s_output_error_output_and_exit_code_past_a_login_profile_s_noise() {
    let cx = Wrapped::banner("profile noise\n");
    let outputs = run_script_batch(
        &cx,
        &[
            "printf 'one\\n\\ntwo'".into(),
            "echo oops >&2; exit 3".into(),
            "trap 'echo bye' 0; printf 'last\\n'".into(),
        ],
        GIT_DIFF_TIMEOUT,
    )
    .await
    .unwrap();
    assert_eq!(
        outputs,
        [
            Ran::new(0, "one\n\ntwo", ""),
            Ran::new(3, "", "oops\n"),
            Ran::new(0, "last\nbye\n", ""),
        ]
    );
}

#[tokio::test]
async fn a_batch_cut_short_gives_the_unanswered_scripts_the_failure() {
    let outputs = run_script_batch(
        &local(),
        &[
            "printf ok".into(),
            "kill -9 $$".into(),
            "printf never".into(),
        ],
        GIT_DIFF_TIMEOUT,
    )
    .await
    .unwrap();
    assert_eq!(outputs[0], Ran::new(0, "ok", ""));
    assert_ne!(outputs[2].code, 0);
    assert!(!outputs[2].stderr.is_empty());
}
