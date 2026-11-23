//! search.test.ts.

use std::fs;
use std::path::Path;
use std::process::Command;

use roamgate_git::exec::LocalRunner;

use super::*;

fn git(root: &Path, args: &[&str]) {
    let status = Command::new("git")
        .arg("-C")
        .arg(root)
        .args(args)
        .status()
        .unwrap();
    assert!(status.success(), "git {args:?}");
}

fn init() -> tempfile::TempDir {
    let dir = tempfile::Builder::new()
        .prefix("roamgate-search-")
        .tempdir()
        .unwrap();
    git(dir.path(), &["init", "-q"]);
    dir
}

async fn search(root: &Path, query: &str, mode: SearchMode, show_hidden: bool) -> FileSearch {
    let cx = GitContext::local(Arc::new(LocalRunner::system()));
    search_workspace_files(&cx, None, root.to_str().unwrap(), query, mode, show_hidden)
        .await
        .unwrap()
}

fn hit(path: &str, line: u64, snippet: &str) -> FileSearchResult {
    FileSearchResult {
        path: path.into(),
        line: Some(line),
        snippet: Some(snippet.into()),
    }
}

#[tokio::test]
async fn ignores_git_grep_output_settings() {
    for (color, column) in [("always", "false"), ("never", "true"), ("always", "true")] {
        let dir = init();
        let root = dir.path();
        git(root, &["config", "color.grep", color]);
        git(root, &["config", "grep.column", column]);
        fs::write(root.join("tracked.txt"), "first\ntracked needle\n").unwrap();
        fs::write(root.join(".tracked"), "needle hidden tracked\n").unwrap();
        git(root, &["add", "tracked.txt", ".tracked"]);
        fs::write(root.join("untracked.txt"), "first\nuntracked needle\n").unwrap();
        fs::write(root.join(".untracked"), "needle hidden untracked\n").unwrap();
        assert_eq!(
            search(root, "needle", SearchMode::Content, false).await,
            FileSearch {
                results: vec![
                    hit("tracked.txt", 2, "tracked needle"),
                    hit("untracked.txt", 2, "untracked needle"),
                ],
                truncated: false,
            },
            "color={color} column={column}"
        );
    }
}

#[tokio::test]
async fn searches_unloaded_checkout_files_and_content_while_respecting_ignores_and_binary_files() {
    let dir = init();
    let root = dir.path();
    fs::create_dir(root.join("deep")).unwrap();
    fs::create_dir(root.join("ignored")).unwrap();
    fs::write(root.join(".gitignore"), "ignored/\n").unwrap();
    fs::write(root.join(".secret"), "needle hidden\n").unwrap();
    fs::create_dir(root.join(".private")).unwrap();
    fs::write(root.join(".private").join("target.txt"), "needle hidden\n").unwrap();
    fs::write(root.join("deep").join("target.txt"), "first\nneedle here\n").unwrap();
    fs::write(root.join("ignored").join("target.txt"), "needle hidden\n").unwrap();
    fs::write(root.join("binary.dat"), [0u8, 110, 101, 101, 100, 108, 101]).unwrap();

    assert_eq!(
        search(root, "target", SearchMode::Files, false).await,
        FileSearch {
            results: vec![FileSearchResult {
                path: "deep/target.txt".into(),
                line: None,
                snippet: None
            }],
            truncated: false,
        }
    );
    assert_eq!(
        search(root, "NEEDLE", SearchMode::Content, false).await,
        FileSearch {
            results: vec![hit("deep/target.txt", 2, "needle here")],
            truncated: false,
        }
    );
    let hidden = search(root, "needle", SearchMode::Content, true).await;
    let paths: Vec<_> = hidden.results.iter().map(|r| r.path.as_str()).collect();
    assert_eq!(paths, [".private/target.txt", ".secret", "deep/target.txt"]);

    fs::write(root.join("tracked.log"), "needle tracked\n").unwrap();
    git(root, &["add", "tracked.log"]);
    fs::write(root.join(".gitignore"), "ignored/\n*.log\n").unwrap();
    let tracked = search(root, "needle", SearchMode::Content, false).await;
    assert!(
        tracked
            .results
            .contains(&hit("tracked.log", 1, "needle tracked"))
    );
    assert_eq!(
        tracked
            .results
            .iter()
            .filter(|r| r.path == "deep/target.txt")
            .count(),
        1
    );

    for index in 0..101 {
        fs::write(root.join(format!("match-{index}.txt")), "needle\n").unwrap();
    }
    let bounded = search(root, "match-", SearchMode::Files, false).await;
    assert_eq!(bounded.results.len(), 100);
    assert!(bounded.truncated);
}
