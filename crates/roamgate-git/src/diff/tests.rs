//! Changes' summary and file diffs, and the last-step store
//! (git-diff.test.ts).

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use futures_util::FutureExt as _;
use serde_json::{Value, json};
use tokio::sync::Notify;

use super::*;
use crate::exec::testing::{Hooked, Scripted, local, text};
use crate::exec::{Invocation, Request};
use crate::snapshot::snapshot_worktree_tree;
use crate::steps::DISPOSED;

fn git(root: &Path, args: &[&str]) -> String {
    crate::compare::tests::git(root, args)
}

struct Repo {
    _dir: tempfile::TempDir,
    root: PathBuf,
}

impl Repo {
    fn path(&self) -> &str {
        self.root.to_str().unwrap()
    }
}

fn init_repository() -> Repo {
    let dir = tempfile::Builder::new()
        .prefix("herdr-last-step-")
        .tempdir()
        .unwrap();
    let root = dir.path().to_path_buf();
    git(&root, &["init", "-q"]);
    git(&root, &["config", "user.email", "test@example.com"]);
    git(&root, &["config", "user.name", "Herdr Test"]);
    Repo { _dir: dir, root }
}

fn write(root: &Path, name: &str, text: &str) {
    fs::write(root.join(name), text).unwrap();
}

async fn summary(
    cx: &GitContext,
    root: &str,
    workspace: Value,
    params: Value,
    store: Option<&Arc<LastStepStore>>,
) -> crate::Result<Value> {
    read_diff_summary(SummaryArgs {
        cx,
        workspace_id: "workspace",
        workspace: &workspace,
        root,
        params: &params,
        last_steps: store,
    })
    .await
}

async fn file(
    cx: &GitContext,
    root: &str,
    workspace_id: &str,
    params: Value,
    store: Option<&Arc<LastStepStore>>,
) -> crate::Result<Value> {
    read_diff_file(FilesArgs {
        cx,
        workspace_id,
        root,
        params: &params,
        last_steps: store,
    })
    .await
}

fn paths(summary: &Value) -> Vec<String> {
    summary["entries"]
        .as_array()
        .unwrap()
        .iter()
        .map(|e| e["path"].as_str().unwrap().to_owned())
        .collect()
}

fn store(cx: &GitContext) -> Arc<LastStepStore> {
    LastStepStore::new(cx.clone(), false)
}

fn root_of(root: &str) -> futures_util::future::BoxFuture<'static, crate::Result<String>> {
    let root = root.to_owned();
    async move { Ok(root) }.boxed()
}

fn last_step() -> Value {
    json!({ "mode": "last-step" })
}

fn step_file(path: &str, snapshot: &Value) -> Value {
    json!({ "mode": "last-step", "path": path, "snapshot_id": snapshot })
}

#[tokio::test]
async fn missing_defaults_expose_choices_including_an_empty_unborn_repository() {
    let repo = init_repository();
    let cx = local();
    git(&repo.root, &["config", "init.defaultBranch", "unavailable"]);
    let branch_main = json!({"mode": "branch-main"});
    let empty = summary(&cx, repo.path(), json!({}), branch_main.clone(), None)
        .await
        .unwrap();
    assert_eq!(empty["base_branches"], json!([]));
    assert_eq!(empty["baseline_available"], false);
    git(&repo.root, &["symbolic-ref", "HEAD", "refs/heads/custom"]);
    write(&repo.root, "file.txt", "initial\n");
    git(&repo.root, &["add", "."]);
    git(&repo.root, &["commit", "-q", "-m", "initial"]);
    let missing = summary(&cx, repo.path(), json!({}), branch_main.clone(), None)
        .await
        .unwrap();
    assert_eq!(missing["base_branches"], json!(["refs/heads/custom"]));
    assert_eq!(missing["baseline_available"], false);
    assert_eq!(missing["entries"], json!([]));
    let explicit = summary(
        &cx,
        repo.path(),
        json!({}),
        json!({"mode": "branch-main", "base_branch": "custom"}),
        None,
    )
    .await
    .unwrap();
    assert_eq!(explicit["base"], "refs/heads/custom");
    git(
        &repo.root,
        &["update-ref", "refs/remotes/origin/custom", "HEAD"],
    );
    git(
        &repo.root,
        &[
            "symbolic-ref",
            "refs/remotes/origin/HEAD",
            "refs/remotes/origin/custom",
        ],
    );
    let detected = summary(&cx, repo.path(), json!({}), branch_main, None)
        .await
        .unwrap();
    assert_eq!(detected["base"], "refs/remotes/origin/custom");
}

#[tokio::test]
async fn resolves_comparison_metadata_through_ssh_without_fetching() {
    let runner = Scripted::new(|_: &Request| {
        Ok(Ran::new(
            0,
            "refs/heads/custom\t\n\n--diff-base-config--\n",
            "",
        ))
    });
    let cx = GitContext::new(Some("example.test".into()), runner.clone());
    let result = summary(
        &cx,
        "/remote/repo's root",
        json!({}),
        json!({"mode": "branch-main"}),
        None,
    )
    .await
    .unwrap();
    assert_eq!(result["base_branches"], json!(["refs/heads/custom"]));
    let calls = runner.calls();
    assert_eq!(calls.len(), 1);
    assert!(matches!(calls[0].invocation, Invocation::Ssh { .. }));
    assert!(!text(&calls[0]).contains("fetch"));
}

#[tokio::test]
async fn summary_and_file_use_defaultbranch_and_merge_base_semantics() {
    for default_branch in ["main", "master", "trunk"] {
        let repo = init_repository();
        let root = &repo.root;
        let cx = local();
        git(
            root,
            &[
                "symbolic-ref",
                "HEAD",
                &format!("refs/heads/{default_branch}"),
            ],
        );
        git(root, &["config", "init.defaultBranch", default_branch]);
        write(root, "file.txt", "initial\n");
        git(root, &["add", "."]);
        git(root, &["commit", "-q", "-m", "initial"]);
        git(root, &["checkout", "-q", "-b", "feature"]);
        write(root, "file.txt", "feature\n");
        git(root, &["commit", "-q", "-am", "feature"]);
        git(root, &["checkout", "-q", default_branch]);
        write(root, "base-only.txt", "base only\n");
        git(root, &["add", "."]);
        git(root, &["commit", "-q", "-m", "base moves ahead"]);
        git(root, &["checkout", "-q", "feature"]);
        let before = git(root, &["show-ref"]);
        let result = summary(
            &cx,
            repo.path(),
            json!({}),
            json!({"mode": "branch-main"}),
            None,
        )
        .await
        .unwrap();
        assert_eq!(result["base"], format!("refs/heads/{default_branch}"));
        assert_eq!(paths(&result), ["file.txt"]);
        let diff = file(
            &cx,
            repo.path(),
            "workspace",
            json!({"mode": "branch-main", "base_branch": result["base"], "path": "file.txt"}),
            None,
        )
        .await
        .unwrap();
        assert!(diff["diff"].as_str().unwrap().contains("+feature"));
        let explicit = summary(
            &cx,
            repo.path(),
            json!({}),
            json!({"mode": "branch-main", "base_branch": "feature"}),
            None,
        )
        .await
        .unwrap();
        assert_eq!(explicit["entries"], json!([]));
        let error = summary(
            &cx,
            repo.path(),
            json!({}),
            json!({"mode": "branch-main", "base_branch": "missing"}),
            None,
        )
        .await
        .unwrap_err();
        assert!(
            error
                .to_string()
                .contains("Comparison branch was not found")
        );
        assert_eq!(git(root, &["show-ref"]), before);
    }
}

#[test]
fn labels_git_statuses() {
    assert_eq!(status_label("A", "staged"), "added");
    assert_eq!(status_label("D", "unstaged"), "deleted");
    assert_eq!(status_label("M", "branch"), "modified");
    assert_eq!(status_label("M", "untracked"), "untracked");
    assert_eq!(status_label("M", "conflicted"), "conflicted");
}

fn entries_json(entries: Vec<DiffEntry>) -> Value {
    serde_json::to_value(entries).unwrap()
}

#[test]
fn parses_working_tree_porcelain_status() {
    let entries = parse_status_summary(
        &[
            " M src/changed.ts",
            "A  src/staged.ts",
            "?? src/new.ts",
            "UU src/conflict.ts",
            "R  src/old.ts -> src/renamed.ts",
        ]
        .join("\n"),
    );
    assert_eq!(
        entries_json(entries),
        json!([
            { "path": "src/changed.ts", "kind": "unstaged", "status": "modified" },
            { "path": "src/conflict.ts", "kind": "conflicted", "status": "conflicted" },
            { "path": "src/new.ts", "kind": "untracked", "status": "untracked" },
            { "path": "src/renamed.ts", "old_path": "src/old.ts", "kind": "staged", "status": "renamed" },
            { "path": "src/staged.ts", "kind": "staged", "status": "added" },
        ])
    );
}

#[test]
fn unquotes_c_style_quoted_paths_in_porcelain_status() {
    let entries = parse_status_summary(
        &[
            " M \"new file.txt\"",
            "?? \"quote\\\"x.txt\"",
            "R  \"old name.txt\" -> new.txt",
        ]
        .join("\n"),
    );
    assert_eq!(
        entries_json(entries),
        json!([
            { "path": "new file.txt", "kind": "unstaged", "status": "modified" },
            { "path": "new.txt", "old_path": "old name.txt", "kind": "staged", "status": "renamed" },
            { "path": "quote\"x.txt", "kind": "untracked", "status": "untracked" },
        ])
    );
}

#[test]
fn parses_branch_name_status_output() {
    let entries = parse_branch_summary(
        "M\tapp.ts\nR100\told.ts\tnew.ts\nM\t\"quote\\\"x.txt\"\n",
        "branch",
    );
    assert_eq!(
        entries_json(entries),
        json!([
            { "path": "app.ts", "kind": "branch", "status": "modified" },
            { "path": "new.ts", "old_path": "old.ts", "kind": "branch", "status": "renamed" },
            { "path": "quote\"x.txt", "kind": "branch", "status": "modified" },
        ])
    );
}

#[test]
fn recognizes_files_marked_generated_by_git_attributes() {
    let output = [
        "dist/app.js",
        "linguist-generated",
        "true",
        "src/app.ts",
        "linguist-generated",
        "unspecified",
        "vendor/schema.ts",
        "gitlab-generated",
        "set",
        "dist/manual.js",
        "linguist-generated",
        "true",
        "dist/manual.js",
        "gitlab-generated",
        "false",
        "dist/unset.js",
        "linguist-generated",
        "unset",
        "",
    ]
    .join("\0");
    let parsed: Vec<(String, bool)> = parse_generated_attributes(&output).into_iter().collect();
    assert_eq!(
        parsed,
        [
            ("dist/app.js".to_owned(), true),
            ("vendor/schema.ts".to_owned(), true),
            ("dist/manual.js".to_owned(), false),
            ("dist/unset.js".to_owned(), false),
        ]
    );
}

#[tokio::test]
async fn adds_git_generated_markers_to_diff_summary_entries() {
    let runner = Scripted::new(|request: &Request| {
        let command = text(request);
        let stdout = if command.contains("status --porcelain") {
            "?? dist/app.js\n M src/app.ts\n".to_owned()
        } else if command.contains("check-attr") {
            [
                "dist/app.js",
                "linguist-generated",
                "true",
                "src/app.ts",
                "linguist-generated",
                "unspecified",
                "",
            ]
            .join("\0")
        } else if command.contains("--no-index") {
            return Ok(Ran::new(1, "1200\t0\tdist/app.js\n", ""));
        } else if command.contains("diff --numstat") {
            "10\t2\tsrc/app.ts\n".to_owned()
        } else {
            String::new()
        };
        Ok(Ran::new(0, stdout, ""))
    });
    let cx = GitContext::local(runner.clone());
    let result = summary(
        &cx,
        "/repo",
        json!({"label": "Repo"}),
        json!({"mode": "working"}),
        None,
    )
    .await
    .unwrap();
    assert!(result["entries"].as_array().unwrap().contains(&json!({
        "path": "dist/app.js",
        "kind": "untracked",
        "status": "untracked",
        "additions": 1200,
        "deletions": 0,
        "generated": true,
    })));
    assert!(
        runner
            .calls()
            .iter()
            .any(|c| text(c).contains("check-attr -z"))
    );
}

#[tokio::test]
async fn lets_git_apply_nested_generated_overrides_and_explicit_unmarking() {
    let repo = init_repository();
    fs::create_dir(repo.root.join("dist")).unwrap();
    write(
        &repo.root,
        ".gitattributes",
        "*.gen.js linguist-generated=true\n*.lab.js gitlab-generated\n",
    );
    write(
        &repo.root,
        "dist/.gitattributes",
        "*.gen.js -linguist-generated\n*.lab.js gitlab-generated=false\n",
    );
    for path in [
        "root.gen.js",
        "root.lab.js",
        "dist/manual.gen.js",
        "dist/manual.lab.js",
        "source.js",
    ] {
        write(&repo.root, path, "export {};\n");
    }
    let result = summary(&local(), repo.path(), json!({}), json!({}), None)
        .await
        .unwrap();
    let generated: BTreeMap<String, Value> = result["entries"]
        .as_array()
        .unwrap()
        .iter()
        .map(|e| {
            (
                e["path"].as_str().unwrap().to_owned(),
                e.get("generated").cloned().unwrap_or(Value::Null),
            )
        })
        .collect();
    assert_eq!(generated["root.gen.js"], true);
    assert_eq!(generated["root.lab.js"], true);
    assert_eq!(generated["dist/manual.gen.js"], false);
    assert_eq!(generated["dist/manual.lab.js"], false);
    assert_eq!(generated["source.js"], Value::Null);
}

#[tokio::test]
async fn measures_compared_blobs_independently_of_the_live_file_across_scopes() {
    let repo = init_repository();
    let root = &repo.root;
    let cx = local();
    let baselines = store(&cx);
    write(root, "file.txt", "initial\n");
    git(root, &["add", "."]);
    git(root, &["commit", "-q", "-m", "initial"]);
    git(root, &["branch", "-M", "main"]);
    git(root, &["checkout", "-q", "-b", "feature"]);
    write(root, "file.txt", &format!("{}\n", "x".repeat(1024)));
    git(root, &["add", "."]);
    write(root, "file.txt", "live\n");
    let working = summary(&cx, repo.path(), json!({}), json!({}), None)
        .await
        .unwrap();
    let entries = working["entries"].as_array().unwrap();
    assert_eq!(entries.len(), 2);
    for (entry, kind) in entries.iter().zip(["staged", "unstaged"]) {
        assert_eq!(entry["path"], "file.txt");
        assert_eq!(entry["kind"], kind);
        assert_eq!(entry["file_size"], 1025);
        assert_eq!(entry["size"], 5);
    }
    git(root, &["commit", "-q", "-m", "feature"]);
    let branch = summary(
        &cx,
        repo.path(),
        json!({}),
        json!({"mode": "branch-main"}),
        None,
    )
    .await
    .unwrap();
    assert_eq!(branch["entries"][0]["path"], "file.txt");
    assert_eq!(branch["entries"][0]["file_size"], 1025);
    baselines
        .capture_workspace("workspace", root_of(repo.path()))
        .await
        .unwrap();
    fs::remove_file(root.join("file.txt")).unwrap();
    baselines.complete_workspace("workspace").await.unwrap();
    let step = summary(&cx, repo.path(), json!({}), last_step(), Some(&baselines))
        .await
        .unwrap();
    assert_eq!(step["entries"][0]["status"], "deleted");
    assert_eq!(step["entries"][0]["file_size"], 5);
    let deleted = summary(&cx, repo.path(), json!({}), json!({}), None)
        .await
        .unwrap();
    assert_eq!(deleted["entries"][0]["status"], "deleted");
    assert_eq!(deleted["entries"][0]["file_size"], 1025);
    baselines.dispose().await;
}

/// The local runner, keeping the byte length of each output.
fn measured(bytes: Arc<AtomicUsize>) -> GitContext {
    Hooked::context(move |request| {
        let bytes = bytes.clone();
        async move {
            let Invocation::Local(argv) = &request.invocation else {
                return None;
            };
            let ran = crate::exec::LocalRunner::system()
                .run_local(argv, None, request.timeout)
                .await;
            if let Ok(ran) = &ran {
                bytes.store(ran.stdout.len(), Ordering::SeqCst);
            }
            Some(ran)
        }
        .boxed()
    })
}

#[tokio::test]
async fn bounds_patch_transport_and_utf_8_bytes_while_reporting_the_full_patch_size() {
    let repo = init_repository();
    let bytes = Arc::new(AtomicUsize::new(0));
    let cx = measured(bytes.clone());
    write(
        &repo.root,
        "large.txt",
        &format!("{}\n", "\u{4e2d}".repeat(GIT_DIFF_MAX_BYTES)),
    );
    let result = file(
        &cx,
        repo.path(),
        "workspace",
        json!({"path": "large.txt", "kind": "untracked"}),
        None,
    )
    .await
    .unwrap();
    assert_eq!(result["truncated"], true);
    let size = result["patch_size"].as_u64().unwrap();
    assert!(size > (GIT_DIFF_MAX_BYTES * 3) as u64);
    let diff = result["diff"].as_str().unwrap();
    assert!(diff.len() <= GIT_DIFF_MAX_BYTES);
    assert!(!diff.contains('\u{fffd}'));
    let transported = bytes.load(Ordering::SeqCst);
    assert!(transported <= GIT_DIFF_MAX_BYTES + 32);
    assert!((transported as u64) < size);
    let missing = file(
        &local(),
        repo.path(),
        "workspace",
        json!({"path": "missing.txt", "kind": "untracked"}),
        None,
    )
    .await;
    assert!(missing.is_err());
}

#[tokio::test]
async fn defers_large_automatic_patches_before_transfer_while_explicit_requests_return_content() {
    let repo = init_repository();
    let bytes = Arc::new(AtomicUsize::new(0));
    let cx = measured(bytes.clone());
    write(
        &repo.root,
        "long.txt",
        &format!("{}\n", "x".repeat(200_000)),
    );
    git(&repo.root, &["add", "."]);
    git(&repo.root, &["commit", "-q", "-m", "initial"]);
    write(
        &repo.root,
        "long.txt",
        &format!("{}\n", "y".repeat(200_000)),
    );
    let listed = summary(&cx, repo.path(), json!({}), json!({}), None)
        .await
        .unwrap();
    let entry = &listed["entries"][0];
    assert_eq!(entry["file_size"], 200_001);
    assert_eq!(entry["additions"], 1);
    assert_eq!(entry["deletions"], 1);
    let automatic = file(
        &cx,
        repo.path(),
        "workspace",
        json!({"path": "long.txt", "automatic": true}),
        None,
    )
    .await
    .unwrap();
    assert_eq!(automatic["diff"], "");
    assert_eq!(automatic["deferred"], true);
    assert_eq!(automatic["truncated"], false);
    assert!(automatic["patch_size"].as_u64().unwrap() > LARGE_DIFF_PATCH_BYTES as u64);
    assert!(bytes.load(Ordering::SeqCst) < 32);
    let explicit = file(
        &cx,
        repo.path(),
        "workspace",
        json!({"path": "long.txt"}),
        None,
    )
    .await
    .unwrap();
    assert!(explicit.get("deferred").is_none());
    assert_eq!(explicit["patch_size"], automatic["patch_size"]);
    let want = format!("+{}", "y".repeat(200_000));
    assert!(explicit["diff"].as_str().unwrap().contains(&want));
    write(&repo.root, "small.txt", "small\n");
    let small = file(
        &cx,
        repo.path(),
        "workspace",
        json!({"path": "small.txt", "kind": "untracked", "automatic": true}),
        None,
    )
    .await
    .unwrap();
    assert!(small.get("deferred").is_none());
    assert!(small["diff"].as_str().unwrap().contains("+small"));
}

#[tokio::test]
async fn counts_untracked_files_with_one_command_per_batch() {
    let names = ["a.txt", "b.txt", "c.txt"];
    let runner = Scripted::new(move |request: &Request| {
        let command = text(request);
        let stdout = if command.contains("status --porcelain") {
            names.iter().map(|p| format!("?? {p}\n")).collect()
        } else if command.contains("--no-index") {
            "1\t0\ta.txt\n2\t0\tb.txt\n3\t0\tc.txt\n".to_owned()
        } else {
            String::new()
        };
        Ok(Ran::new(0, stdout, ""))
    });
    let cx = GitContext::local(runner.clone());
    let result = summary(
        &cx,
        "/repo",
        json!({"label": "Repo"}),
        json!({"mode": "working"}),
        None,
    )
    .await
    .unwrap();
    let numstat: Vec<String> = runner
        .calls()
        .iter()
        .map(text)
        .filter(|c| c.contains("--no-index"))
        .collect();
    assert_eq!(numstat.len(), 1);
    for name in names {
        assert!(numstat[0].contains(name));
    }
    let counted: Vec<(String, Value)> = result["entries"]
        .as_array()
        .unwrap()
        .iter()
        .map(|e| {
            (
                e["path"].as_str().unwrap().to_owned(),
                e["additions"].clone(),
            )
        })
        .collect();
    assert_eq!(
        counted,
        [
            ("a.txt".to_owned(), json!(1)),
            ("b.txt".to_owned(), json!(2)),
            ("c.txt".to_owned(), json!(3)),
        ]
    );
}

#[cfg(unix)]
#[tokio::test]
async fn keeps_a_batch_s_counts_when_one_of_its_files_cannot_be_read() {
    use std::os::unix::fs::PermissionsExt;
    let repo = init_repository();
    write(&repo.root, "a.txt", "one\n");
    write(&repo.root, "b.txt", "one\ntwo\n");
    write(&repo.root, "zz-locked.txt", "one\n");
    let locked = repo.root.join("zz-locked.txt");
    fs::set_permissions(&locked, fs::Permissions::from_mode(0)).unwrap();
    let result = summary(
        &local(),
        repo.path(),
        json!({}),
        json!({"mode": "working"}),
        None,
    )
    .await
    .unwrap();
    let additions: BTreeMap<String, Value> = result["entries"]
        .as_array()
        .unwrap()
        .iter()
        .map(|e| {
            (
                e["path"].as_str().unwrap().to_owned(),
                e["additions"].clone(),
            )
        })
        .collect();
    assert_eq!(additions["a.txt"], 1);
    assert_eq!(additions["b.txt"], 2);
    assert!(additions.contains_key("zz-locked.txt"));
    fs::set_permissions(&locked, fs::Permissions::from_mode(0o600)).unwrap();
}

#[tokio::test]
async fn lists_untracked_files_without_line_counts_past_the_cap() {
    let names: Vec<String> = (0..=GIT_UNTRACKED_NUMSTAT_MAX_FILES)
        .map(|i| format!("build/file-{i}.bin"))
        .collect();
    let status: String = names.iter().map(|p| format!("?? {p}\n")).collect();
    let runner = Scripted::new(move |request: &Request| {
        let stdout = if text(request).contains("status --porcelain") {
            status.clone()
        } else {
            String::new()
        };
        Ok(Ran::new(0, stdout, ""))
    });
    let cx = GitContext::local(runner.clone());
    let result = summary(
        &cx,
        "/repo",
        json!({"label": "Repo"}),
        json!({"mode": "working"}),
        None,
    )
    .await
    .unwrap();
    assert!(
        !runner
            .calls()
            .iter()
            .any(|c| text(c).contains("--no-index"))
    );
    let entries = result["entries"].as_array().unwrap();
    assert_eq!(entries.len(), names.len());
    assert!(entries.iter().all(|e| e.get("additions").is_none()));
}

#[tokio::test]
async fn overlapping_refreshes_each_return_complete_untracked_counts() {
    let names: Vec<String> = (0..GIT_UNTRACKED_NUMSTAT_MAX_FILES)
        .map(|i| format!("pending/file-{i}.txt"))
        .collect();
    let status: String = names.iter().map(|p| format!("?? {p}\n")).collect();
    let counts: String = names.iter().map(|p| format!("1\t0\t{p}\n")).collect();
    let numstat_commands = Arc::new(AtomicUsize::new(0));
    let newer: Arc<tokio::sync::OnceCell<()>> = Arc::new(tokio::sync::OnceCell::new());
    let commands = numstat_commands.clone();
    let cx = Hooked::context(move |request| {
        let (status, counts, commands, newer) = (
            status.clone(),
            counts.clone(),
            commands.clone(),
            newer.clone(),
        );
        async move {
            let command = text(&request);
            if command.contains("status --porcelain") {
                return Some(Ok(Ran::new(0, status, "")));
            }
            if command.contains("--no-index") {
                commands.fetch_add(1, Ordering::SeqCst);
                // Another browser's refresh still needs its own answer.
                let quiet_status = status.clone();
                newer
                    .get_or_init(|| async move {
                        let quiet = Scripted::new(move |request: &Request| {
                            let stdout = if text(request).contains("status --porcelain") {
                                quiet_status.clone()
                            } else {
                                String::new()
                            };
                            Ok(Ran::new(0, stdout, ""))
                        });
                        let cx = GitContext::local(quiet);
                        summary(
                            &cx,
                            "/repo",
                            json!({"label": "Repo"}),
                            json!({"mode": "working"}),
                            None,
                        )
                        .await
                        .unwrap();
                    })
                    .await;
                return Some(Ok(Ran::new(0, counts, "")));
            }
            Some(Ok(Ran::new(0, "", "")))
        }
        .boxed()
    });
    let result = summary(
        &cx,
        "/repo",
        json!({"label": "Repo"}),
        json!({"mode": "working"}),
        None,
    )
    .await
    .unwrap();
    let batches = names.len().div_ceil(GIT_UNTRACKED_NUMSTAT_BATCH_SIZE);
    assert!(batches > GIT_UNTRACKED_NUMSTAT_CONCURRENCY);
    assert_eq!(numstat_commands.load(Ordering::SeqCst), batches);
    let entries = result["entries"].as_array().unwrap();
    assert_eq!(entries.len(), names.len());
    assert!(entries.iter().all(|e| e["additions"] == 1));
}

#[tokio::test]
async fn runs_temporary_index_snapshots_through_the_ssh_command_path() {
    let tree = "a".repeat(40);
    let answer = format!("{tree}\n");
    let runner = Scripted::new(move |_: &Request| Ok(Ran::new(0, answer.clone(), "")));
    let cx = GitContext::new(Some("dev.example".into()), runner.clone());
    assert_eq!(
        snapshot_worktree_tree(&cx, "/repo with spaces")
            .await
            .unwrap(),
        tree
    );
    let calls = runner.calls();
    assert_eq!(calls.len(), 1);
    let Invocation::Ssh {
        destination,
        command,
        ..
    } = &calls[0].invocation
    else {
        panic!("{calls:?}");
    };
    assert_eq!(destination, "dev.example");
    assert!(command.contains("GIT_INDEX_FILE"));
    assert!(command.contains("cd '/repo with spaces'"));
    assert!(command.contains("hash-object -w --no-filters"));
    assert!(command.contains("write-tree"));
    assert!(command.contains("trap cleanup EXIT"));
}

#[tokio::test]
async fn tracks_worktree_changes_across_bounded_snapshots() {
    let repo = init_repository();
    let cx = local();
    write(&repo.root, "tracked.txt", "one\n");
    let first = snapshot_worktree_tree(&cx, repo.path()).await.unwrap();
    write(&repo.root, "tracked.txt", "two\n");
    let second = snapshot_worktree_tree(&cx, repo.path()).await.unwrap();
    assert_ne!(second, first);
    write(&repo.root, "untracked.txt", "new\n");
    let third = snapshot_worktree_tree(&cx, repo.path()).await.unwrap();
    let mut files: Vec<String> = git(&repo.root, &["ls-tree", "-r", "--name-only", &third])
        .split('\n')
        .map(str::to_owned)
        .collect();
    files.sort();
    assert_eq!(files, ["tracked.txt", "untracked.txt"]);
    fs::remove_file(repo.root.join("tracked.txt")).unwrap();
    let fourth = snapshot_worktree_tree(&cx, repo.path()).await.unwrap();
    assert_eq!(
        git(&repo.root, &["ls-tree", "-r", "--name-only", &fourth]),
        "untracked.txt"
    );
}

fn no_quarantine(root: &Path) -> bool {
    !root
        .join(".git")
        .join("roamgate-last-step-capture")
        .exists()
}

#[tokio::test]
async fn leaves_no_capture_scratch_directory_after_successful_disposal() {
    let repo = init_repository();
    write(&repo.root, "tracked.txt", "baseline\n");
    let baselines = store(&local());
    baselines
        .capture_workspace("workspace", root_of(repo.path()))
        .await
        .unwrap();
    baselines.complete_workspace("workspace").await.unwrap();
    baselines.dispose().await;
    assert!(no_quarantine(&repo.root));
}

#[tokio::test]
async fn does_not_delete_capture_storage_after_an_uncertain_failure() {
    let repo = init_repository();
    write(&repo.root, "tracked.txt", "baseline\n");
    let fail = Arc::new(AtomicBool::new(true));
    let commands = Arc::new(Mutex::new(Vec::<String>::new()));
    let (hook_fail, hook_commands) = (fail.clone(), commands.clone());
    let cx = Hooked::context(move |request| {
        let (fail, commands) = (hook_fail.clone(), hook_commands.clone());
        async move {
            let command = text(&request);
            commands.lock().unwrap().push(command.clone());
            (fail.load(Ordering::SeqCst) && command.contains("roamgate-last-step-capture"))
                .then(|| Ok(Ran::new(1, "", "snapshot failed")))
        }
        .boxed()
    });
    let baselines = store(&cx);
    let error = baselines
        .capture_workspace("workspace", root_of(repo.path()))
        .await
        .unwrap_err();
    assert!(error.to_string().contains("snapshot failed"));
    fail.store(false, Ordering::SeqCst);
    let baseline = baselines
        .capture_workspace("workspace", root_of(repo.path()))
        .await
        .unwrap();
    assert!(baseline.len() >= 40 && baseline.bytes().all(|c| c.is_ascii_hexdigit()));
    assert!(
        !commands
            .lock()
            .unwrap()
            .iter()
            .any(|c| c.contains("rm -f '/tmp/roamgate-last-step-capture"))
    );
    baselines.dispose().await;
}

#[tokio::test]
async fn includes_commits_and_untracked_files_made_after_the_baseline() {
    let repo = init_repository();
    let root = &repo.root;
    let cx = local();
    write(root, "tracked.txt", "before\n");
    git(root, &["add", "tracked.txt"]);
    git(root, &["commit", "-q", "-m", "initial"]);
    let baselines = store(&cx);
    baselines
        .capture_workspace("workspace", root_of(repo.path()))
        .await
        .unwrap();
    write(root, "tracked.txt", "after commit\n");
    git(root, &["add", "tracked.txt"]);
    git(root, &["commit", "-q", "-m", "mid-turn"]);
    write(root, "untracked.txt", "new file\n");
    baselines.complete_workspace("workspace").await.unwrap();
    let result = summary(
        &cx,
        repo.path(),
        json!({"label": "Repo"}),
        last_step(),
        Some(&baselines),
    )
    .await
    .unwrap();
    assert_eq!(result["baseline_available"], true);
    assert_eq!(
        result["entries"],
        json!([
            { "path": "tracked.txt", "kind": "last-step", "status": "modified",
              "additions": 1, "deletions": 1, "file_size": 13 },
            { "path": "untracked.txt", "kind": "last-step", "status": "added",
              "additions": 1, "deletions": 0, "file_size": 9 },
        ])
    );
    let diff = file(
        &cx,
        repo.path(),
        "workspace",
        json!({
            "mode": "last-step",
            "kind": "last-step",
            "path": "tracked.txt",
            "snapshot_id": result["snapshot_id"],
        }),
        Some(&baselines),
    )
    .await
    .unwrap();
    assert_eq!(diff["kind"], "last-step");
    let text = diff["diff"].as_str().unwrap();
    assert!(text.contains("-before"));
    assert!(text.contains("+after commit"));
}

#[tokio::test]
async fn keeps_rename_metadata_in_an_individual_last_step_patch() {
    let repo = init_repository();
    let root = &repo.root;
    let cx = local();
    write(root, "old.txt", "renamed content\n");
    git(root, &["add", "old.txt"]);
    git(root, &["commit", "-q", "-m", "initial"]);
    let baselines = store(&cx);
    baselines
        .capture_workspace("workspace", root_of(repo.path()))
        .await
        .unwrap();
    fs::rename(root.join("old.txt"), root.join("new.txt")).unwrap();
    baselines.complete_workspace("workspace").await.unwrap();
    let result = summary(&cx, repo.path(), json!({}), last_step(), Some(&baselines))
        .await
        .unwrap();
    assert!(result["entries"].as_array().unwrap().iter().any(|e| {
        e["path"] == "new.txt"
            && e["old_path"] == "old.txt"
            && e["kind"] == "last-step"
            && e["status"] == "renamed"
    }));
    let diff = file(
        &cx,
        repo.path(),
        "workspace",
        json!({
            "mode": "last-step",
            "path": "new.txt",
            "old_path": "old.txt",
            "snapshot_id": result["snapshot_id"],
        }),
        Some(&baselines),
    )
    .await
    .unwrap();
    let text = diff["diff"].as_str().unwrap();
    assert!(text.contains("rename from old.txt"));
    assert!(text.contains("rename to new.txt"));
    assert!(!text.contains("new file mode"));
}

#[tokio::test]
async fn keeps_the_previous_completed_step_visible_until_the_active_step_completes() {
    let repo = init_repository();
    let cx = local();
    write(&repo.root, "tracked.txt", "initial\n");
    let baselines = store(&cx);
    baselines
        .capture_workspace("workspace", root_of(repo.path()))
        .await
        .unwrap();
    write(&repo.root, "tracked.txt", "first completed step\n");
    baselines.complete_workspace("workspace").await.unwrap();
    let first = summary(&cx, repo.path(), json!({}), last_step(), Some(&baselines))
        .await
        .unwrap();
    baselines
        .capture_workspace("workspace", root_of(repo.path()))
        .await
        .unwrap();
    write(&repo.root, "tracked.txt", "second active step\n");
    let while_active = summary(&cx, repo.path(), json!({}), last_step(), Some(&baselines))
        .await
        .unwrap();
    assert_eq!(while_active["base"], first["base"]);
    assert_ne!(while_active["snapshot_id"], first["snapshot_id"]);
    baselines.complete_workspace("workspace").await.unwrap();
    let after = summary(&cx, repo.path(), json!({}), last_step(), Some(&baselines))
        .await
        .unwrap();
    assert_ne!(after["base"], first["base"]);
    let diff = file(
        &cx,
        repo.path(),
        "workspace",
        step_file("tracked.txt", &after["snapshot_id"]),
        Some(&baselines),
    )
    .await
    .unwrap();
    let text = diff["diff"].as_str().unwrap();
    assert!(text.contains("-first completed step"));
    assert!(text.contains("+second active step"));
}

/// A gate a hook waits at: `started` once it got there, open after
/// `release`.
#[derive(Default)]
struct Gate {
    started: Notify,
    opened: AtomicBool,
    open: Notify,
}

impl Gate {
    async fn wait(&self) {
        self.started.notify_one();
        loop {
            let notified = self.open.notified();
            if self.opened.load(Ordering::SeqCst) {
                return;
            }
            notified.await;
        }
    }

    fn release(&self) {
        self.opened.store(true, Ordering::SeqCst);
        self.open.notify_waiters();
    }
}

#[tokio::test]
async fn queues_a_rapid_second_completion_while_the_first_is_still_finalizing() {
    let repo = init_repository();
    let gate = Arc::new(Gate::default());
    let calls = Arc::new(AtomicUsize::new(0));
    let (hook_gate, hook_calls) = (gate.clone(), calls.clone());
    let cx = Hooked::context(move |request| {
        let (gate, calls) = (hook_gate.clone(), hook_calls.clone());
        async move {
            if text(&request).contains("roamgate-last-step-capture")
                && calls.fetch_add(1, Ordering::SeqCst) + 1 == 2
            {
                gate.wait().await;
            }
            None
        }
        .boxed()
    });
    write(&repo.root, "tracked.txt", "initial\n");
    let baselines = store(&cx);
    baselines
        .capture_workspace("workspace", root_of(repo.path()))
        .await
        .unwrap();
    write(&repo.root, "tracked.txt", "first step\n");
    let first_store = baselines.clone();
    let first = tokio::spawn(async move { first_store.complete_workspace("workspace").await });
    gate.started.notified().await;
    // Snapshots of one root take turns: this capture waits behind the
    // completion's until its gate opens.
    let (second_store, root) = (baselines.clone(), repo.path().to_owned());
    let second = tokio::spawn(async move {
        second_store
            .capture_workspace("workspace", root_of(&root))
            .await
    });
    tokio::task::yield_now().await;
    gate.release();
    second.await.unwrap().unwrap();
    write(&repo.root, "tracked.txt", "second step\n");
    assert!(first.await.unwrap().unwrap());
    let while_second = summary(&cx, repo.path(), json!({}), last_step(), Some(&baselines))
        .await
        .unwrap();
    let first_file = file(
        &cx,
        repo.path(),
        "workspace",
        step_file("tracked.txt", &while_second["snapshot_id"]),
        Some(&baselines),
    )
    .await
    .unwrap();
    let text1 = first_file["diff"].as_str().unwrap();
    assert!(text1.contains("-initial"));
    assert!(text1.contains("+first step"));
    assert!(!text1.contains("+second step"));
    assert!(baselines.complete_workspace("workspace").await.unwrap());
    let completed = summary(&cx, repo.path(), json!({}), last_step(), Some(&baselines))
        .await
        .unwrap();
    let second_file = file(
        &cx,
        repo.path(),
        "workspace",
        step_file("tracked.txt", &completed["snapshot_id"]),
        Some(&baselines),
    )
    .await
    .unwrap();
    let text2 = second_file["diff"].as_str().unwrap();
    assert!(text2.contains("-first step"));
    assert!(text2.contains("+second step"));
}

#[tokio::test]
async fn binds_file_patches_to_the_exact_tree_pair_returned_by_the_summary() {
    let repo = init_repository();
    let cx = local();
    write(&repo.root, "tracked.txt", "baseline\n");
    git(&repo.root, &["add", "tracked.txt"]);
    git(&repo.root, &["commit", "-q", "-m", "initial"]);
    let baselines = store(&cx);
    baselines
        .capture_workspace("workspace", root_of(repo.path()))
        .await
        .unwrap();
    write(&repo.root, "tracked.txt", "at summary\n");
    baselines.complete_workspace("workspace").await.unwrap();
    let result = summary(&cx, repo.path(), json!({}), last_step(), Some(&baselines))
        .await
        .unwrap();
    assert!(result["snapshot_id"].is_string());
    write(&repo.root, "tracked.txt", "after summary\n");
    let params = step_file("tracked.txt", &result["snapshot_id"]);
    let diff = file(
        &cx,
        repo.path(),
        "workspace",
        params.clone(),
        Some(&baselines),
    )
    .await
    .unwrap();
    assert!(diff["diff"].as_str().unwrap().contains("+at summary"));
    assert!(!diff["diff"].as_str().unwrap().contains("+after summary"));
    baselines
        .capture_workspace("workspace", root_of(repo.path()))
        .await
        .unwrap();
    let retained = file(
        &cx,
        repo.path(),
        "workspace",
        params.clone(),
        Some(&baselines),
    )
    .await
    .unwrap();
    assert!(retained["diff"].as_str().unwrap().contains("+at summary"));
    baselines.complete_workspace("workspace").await.unwrap();
    let error = file(&cx, repo.path(), "workspace", params, Some(&baselines))
        .await
        .unwrap_err();
    assert!(error.to_string().contains("snapshot expired"));
}

#[tokio::test]
async fn does_not_revalidate_snapshot_trees_for_every_file_patch() {
    let repo = init_repository();
    let count = Arc::new(AtomicUsize::new(0));
    let hook_count = count.clone();
    let cx = Hooked::context(move |request| {
        let count = hook_count.clone();
        async move {
            if text(&request).contains("cat-file --batch-check") {
                count.fetch_add(1, Ordering::SeqCst);
            }
            None
        }
        .boxed()
    });
    write(&repo.root, "tracked.txt", "baseline\n");
    git(&repo.root, &["add", "tracked.txt"]);
    git(&repo.root, &["commit", "-q", "-m", "initial"]);
    let baselines = store(&cx);
    baselines
        .capture_workspace("workspace", root_of(repo.path()))
        .await
        .unwrap();
    write(&repo.root, "tracked.txt", "changed\n");
    baselines.complete_workspace("workspace").await.unwrap();
    let result = summary(&cx, repo.path(), json!({}), last_step(), Some(&baselines))
        .await
        .unwrap();
    assert_eq!(count.load(Ordering::SeqCst), 3);
    count.store(0, Ordering::SeqCst);
    let diff = file(
        &cx,
        repo.path(),
        "workspace",
        step_file("tracked.txt", &result["snapshot_id"]),
        Some(&baselines),
    )
    .await
    .unwrap();
    assert!(diff["diff"].as_str().unwrap().contains("+changed"));
    assert_eq!(count.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn returns_a_usable_summary_token_when_a_newer_step_completes_mid_request() {
    let repo = init_repository();
    let gate = Arc::new(Gate::default());
    let block = Arc::new(AtomicBool::new(false));
    let (hook_gate, hook_block) = (gate.clone(), block.clone());
    let cx = Hooked::context(move |request| {
        let (gate, block) = (hook_gate.clone(), hook_block.clone());
        async move {
            if text(&request).contains("diff --name-status") && block.swap(false, Ordering::SeqCst)
            {
                gate.wait().await;
            }
            None
        }
        .boxed()
    });
    write(&repo.root, "tracked.txt", "initial\n");
    let baselines = store(&cx);
    baselines
        .capture_workspace("workspace", root_of(repo.path()))
        .await
        .unwrap();
    write(&repo.root, "tracked.txt", "first step\n");
    baselines.complete_workspace("workspace").await.unwrap();
    baselines
        .capture_workspace("workspace", root_of(repo.path()))
        .await
        .unwrap();
    write(&repo.root, "tracked.txt", "second step\n");
    block.store(true, Ordering::SeqCst);
    let (task_cx, task_store, root) = (cx.clone(), baselines.clone(), repo.path().to_owned());
    let task = tokio::spawn(async move {
        summary(&task_cx, &root, json!({}), last_step(), Some(&task_store)).await
    });
    gate.started.notified().await;
    baselines.complete_workspace("workspace").await.unwrap();
    gate.release();
    let result = task.await.unwrap().unwrap();
    let diff = file(
        &cx,
        repo.path(),
        "workspace",
        step_file("tracked.txt", &result["snapshot_id"]),
        Some(&baselines),
    )
    .await
    .unwrap();
    let text = diff["diff"].as_str().unwrap();
    assert!(text.contains("-initial"));
    assert!(text.contains("+first step"));
}

#[tokio::test]
async fn expires_only_the_snapshot_whose_tree_is_missing() {
    let repo = init_repository();
    let cx = local();
    write(&repo.root, "tracked.txt", "baseline\n");
    let baselines = store(&cx);
    let baseline = snapshot_worktree_tree(&cx, repo.path()).await.unwrap();
    let missing = "0".repeat(40);
    let valid = baselines
        .remember_snapshot("workspace", repo.path(), &baseline, &baseline)
        .unwrap();
    let expired = baselines
        .remember_snapshot("workspace", repo.path(), &baseline, &missing)
        .unwrap();
    let error = file(
        &cx,
        repo.path(),
        "workspace",
        step_file("tracked.txt", &json!(expired)),
        Some(&baselines),
    )
    .await
    .unwrap_err();
    assert!(error.to_string().contains("snapshot expired"));
    let pair = Some((baseline.clone(), baseline.clone()));
    assert_eq!(
        baselines.resolve_snapshot("workspace", repo.path(), &valid),
        pair
    );
    assert_eq!(
        baselines.resolve_snapshot("workspace", repo.path(), &expired),
        None
    );
    let old = baselines
        .remember_snapshot("old-workspace", repo.path(), &missing, &baseline)
        .unwrap();
    let error = file(
        &cx,
        repo.path(),
        "old-workspace",
        step_file("tracked.txt", &json!(old)),
        Some(&baselines),
    )
    .await
    .unwrap_err();
    assert!(error.to_string().contains("snapshot expired"));
    assert_eq!(
        baselines.resolve_snapshot("workspace", repo.path(), &valid),
        pair
    );
    assert_eq!(
        baselines.resolve_snapshot("old-workspace", repo.path(), &old),
        None
    );
}

#[tokio::test]
async fn does_not_let_an_older_failed_capture_erase_a_newer_same_root_baseline() {
    let repo = init_repository();
    let gate = Arc::new(Gate::default());
    let calls = Arc::new(AtomicUsize::new(0));
    let (hook_gate, hook_calls) = (gate.clone(), calls.clone());
    let cx = Hooked::context(move |request| {
        let (gate, calls) = (hook_gate.clone(), hook_calls.clone());
        async move {
            if text(&request).contains("roamgate-last-step-capture")
                && calls.fetch_add(1, Ordering::SeqCst) == 0
            {
                gate.wait().await;
                return Some(Ok(Ran::new(1, "", "older capture failed")));
            }
            None
        }
        .boxed()
    });
    write(&repo.root, "tracked.txt", "current\n");
    let baselines = store(&cx);
    let (older_store, root) = (baselines.clone(), repo.path().to_owned());
    let older =
        tokio::spawn(async move { older_store.capture_workspace("older", root_of(&root)).await });
    gate.started.notified().await;
    // Snapshots of one root take turns: this one waits behind the older
    // capture and must survive its failure.
    let (newer_store, root) = (baselines.clone(), repo.path().to_owned());
    let newer =
        tokio::spawn(async move { newer_store.capture_workspace("newer", root_of(&root)).await });
    tokio::task::yield_now().await;
    gate.release();
    let error = older.await.unwrap().unwrap_err();
    assert!(error.to_string().contains("older capture failed"));
    let baseline = newer.await.unwrap().unwrap();
    assert!(baseline.len() >= 40);
    assert!(baselines.complete_workspace("newer").await.unwrap());
    assert_eq!(
        baselines.resolve_completed("newer", repo.path()).await,
        Some((baseline.clone(), baseline))
    );
}

#[tokio::test]
async fn preserves_the_real_index_in_a_linked_worktree() {
    let repo = init_repository();
    let cx = local();
    let linked = PathBuf::from(format!("{}-linked", repo.path()));
    let linked_path = linked.to_str().unwrap().to_owned();
    write(&repo.root, "tracked.txt", "base\n");
    git(&repo.root, &["add", "tracked.txt"]);
    git(&repo.root, &["commit", "-q", "-m", "initial"]);
    git(
        &repo.root,
        &["worktree", "add", "-q", "-b", "linked-test", &linked_path],
    );
    write(&linked, "staged.txt", "baseline\n");
    git(&linked, &["add", "staged.txt"]);
    let before = git(&linked, &["status", "--porcelain=v1"]);
    let baselines = store(&cx);
    baselines
        .capture_workspace("workspace", root_of(&linked_path))
        .await
        .unwrap();
    assert_eq!(git(&linked, &["status", "--porcelain=v1"]), before);
    write(&linked, "staged.txt", "changed\n");
    baselines.complete_workspace("workspace").await.unwrap();
    let result = summary(&cx, &linked_path, json!({}), last_step(), Some(&baselines))
        .await
        .unwrap();
    assert!(result["entries"].as_array().unwrap().iter().any(|e| {
        e["path"] == "staged.txt" && e["kind"] == "last-step" && e["status"] == "modified"
    }));
    git(&repo.root, &["worktree", "remove", "--force", &linked_path]);
    let _ = fs::remove_dir_all(&linked);
}

#[tokio::test]
async fn snapshots_an_unborn_repository_without_mutating_the_user_index() {
    let repo = init_repository();
    let cx = local();
    write(&repo.root, "existing.txt", "baseline\n");
    git(&repo.root, &["add", "existing.txt"]);
    let before = git(&repo.root, &["status", "--porcelain=v1"]);
    let baselines = store(&cx);
    baselines
        .capture_workspace("workspace", root_of(repo.path()))
        .await
        .unwrap();
    assert_eq!(git(&repo.root, &["status", "--porcelain=v1"]), before);
    write(&repo.root, "existing.txt", "changed\n");
    write(&repo.root, "new.txt", "new\n");
    baselines.complete_workspace("workspace").await.unwrap();
    let result = summary(&cx, repo.path(), json!({}), last_step(), Some(&baselines))
        .await
        .unwrap();
    let pairs: Vec<(String, String)> = result["entries"]
        .as_array()
        .unwrap()
        .iter()
        .map(|e| {
            (
                e["path"].as_str().unwrap().to_owned(),
                e["status"].as_str().unwrap().to_owned(),
            )
        })
        .collect();
    assert_eq!(
        pairs,
        [
            ("existing.txt".to_owned(), "modified".to_owned()),
            ("new.txt".to_owned(), "added".to_owned())
        ]
    );
}

#[tokio::test]
async fn waits_for_step_completion_before_publishing_its_replacement() {
    let repo = init_repository();
    let gate = Arc::new(Gate::default());
    let hold = Arc::new(AtomicBool::new(false));
    let cat_files = Arc::new(AtomicUsize::new(0));
    let (hook_gate, hook_hold, hook_cat) = (gate.clone(), hold.clone(), cat_files.clone());
    let cx = Hooked::context(move |request| {
        let (gate, hold, cat) = (hook_gate.clone(), hook_hold.clone(), hook_cat.clone());
        async move {
            let command = text(&request);
            if command.contains("cat-file --batch-check") {
                cat.fetch_add(1, Ordering::SeqCst);
            }
            if hold.load(Ordering::SeqCst) && command.contains("roamgate-last-step-capture") {
                gate.wait().await;
            }
            None
        }
        .boxed()
    });
    write(&repo.root, "tracked.txt", "first baseline\n");
    let baselines = store(&cx);
    baselines
        .capture_workspace("workspace", root_of(repo.path()))
        .await
        .unwrap();
    write(&repo.root, "tracked.txt", "second baseline\n");
    hold.store(true, Ordering::SeqCst);
    let completion_store = baselines.clone();
    let completion =
        tokio::spawn(async move { completion_store.complete_workspace("workspace").await });
    let (task_cx, task_store, root) = (cx.clone(), baselines.clone(), repo.path().to_owned());
    let summary_task = tokio::spawn(async move {
        summary(&task_cx, &root, json!({}), last_step(), Some(&task_store)).await
    });
    gate.started.notified().await;
    for _ in 0..5 {
        tokio::task::yield_now().await;
    }
    assert_eq!(cat_files.load(Ordering::SeqCst), 0);
    hold.store(false, Ordering::SeqCst);
    gate.release();
    completion.await.unwrap().unwrap();
    let result = summary_task.await.unwrap().unwrap();
    assert_eq!(result["baseline_available"], true);
    assert_eq!(paths(&result), ["tracked.txt"]);
}

#[tokio::test]
async fn retains_the_completed_step_when_the_next_baseline_capture_fails() {
    let repo = init_repository();
    let fail = Arc::new(AtomicBool::new(false));
    let hook_fail = fail.clone();
    let cx = Hooked::context(move |request| {
        let fail = hook_fail.clone();
        async move {
            (text(&request).contains("roamgate-last-step-capture")
                && fail.swap(false, Ordering::SeqCst))
            .then(|| Ok(Ran::new(1, "", "snapshot failed")))
        }
        .boxed()
    });
    write(&repo.root, "tracked.txt", "old baseline\n");
    let baselines = store(&cx);
    baselines
        .capture_workspace("workspace", root_of(repo.path()))
        .await
        .unwrap();
    write(&repo.root, "tracked.txt", "completed turn\n");
    baselines.complete_workspace("workspace").await.unwrap();
    fail.store(true, Ordering::SeqCst);
    let error = baselines
        .capture_workspace("workspace", root_of(repo.path()))
        .await
        .unwrap_err();
    assert!(error.to_string().contains("snapshot failed"));
    assert!(!baselines.complete_workspace("workspace").await.unwrap());
    let result = summary(&cx, repo.path(), json!({}), last_step(), Some(&baselines))
        .await
        .unwrap();
    assert_eq!(result["baseline_available"], true);
    assert_eq!(paths(&result), ["tracked.txt"]);
}

#[tokio::test]
async fn invalidates_only_one_workspace_sharing_a_repository_root() {
    let repo = init_repository();
    let baselines = store(&local());
    write(&repo.root, "tracked.txt", "baseline\n");
    for workspace in ["expired", "valid"] {
        baselines
            .capture_workspace(workspace, root_of(repo.path()))
            .await
            .unwrap();
        baselines.complete_workspace(workspace).await.unwrap();
    }
    let expired = baselines
        .resolve_completed("expired", repo.path())
        .await
        .unwrap();
    let valid = baselines
        .resolve_completed("valid", repo.path())
        .await
        .unwrap();
    let expired_id = baselines
        .remember_snapshot("expired", repo.path(), &expired.0, &expired.1)
        .unwrap();
    let valid_id = baselines
        .remember_snapshot("valid", repo.path(), &valid.0, &valid.1)
        .unwrap();
    baselines.invalidate_workspace("expired", repo.path());
    assert_eq!(
        baselines.resolve_completed("expired", repo.path()).await,
        None
    );
    assert_eq!(
        baselines.resolve_completed("valid", repo.path()).await,
        Some(valid.clone())
    );
    assert_eq!(
        baselines.resolve_snapshot("expired", repo.path(), &expired_id),
        None
    );
    assert_eq!(
        baselines.resolve_snapshot("valid", repo.path(), &valid_id),
        Some(valid)
    );
    baselines.dispose().await;
}

#[tokio::test]
async fn preserves_a_valid_baseline_across_transient_cat_file_failures() {
    let repo = init_repository();
    let fail = Arc::new(AtomicBool::new(false));
    let hook_fail = fail.clone();
    let cx = Hooked::context(move |request| {
        let fail = hook_fail.clone();
        async move {
            (fail.load(Ordering::SeqCst) && text(&request).contains("cat-file --batch-check"))
                .then(|| Ok(Ran::new(255, "", "ssh disconnected")))
        }
        .boxed()
    });
    write(&repo.root, "tracked.txt", "baseline\n");
    let baselines = store(&cx);
    baselines
        .capture_workspace("workspace", root_of(repo.path()))
        .await
        .unwrap();
    write(&repo.root, "tracked.txt", "changed\n");
    baselines.complete_workspace("workspace").await.unwrap();
    fail.store(true, Ordering::SeqCst);
    let error = summary(&cx, repo.path(), json!({}), last_step(), Some(&baselines))
        .await
        .unwrap_err();
    assert!(error.to_string().contains("ssh disconnected"));
    fail.store(false, Ordering::SeqCst);
    let result = summary(&cx, repo.path(), json!({}), last_step(), Some(&baselines))
        .await
        .unwrap();
    assert_eq!(paths(&result), ["tracked.txt"]);
}

#[tokio::test]
async fn drains_and_invalidates_in_flight_captures_during_disposal() {
    let repo = init_repository();
    let gate = Arc::new(Gate::default());
    let hook_gate = gate.clone();
    let cx = Hooked::context(move |request| {
        let gate = hook_gate.clone();
        async move {
            if text(&request).contains("roamgate-last-step-capture") {
                gate.wait().await;
            }
            None
        }
        .boxed()
    });
    write(&repo.root, "tracked.txt", "baseline\n");
    let baselines = store(&cx);
    let (capture_store, root) = (baselines.clone(), repo.path().to_owned());
    let capture = tokio::spawn(async move {
        capture_store
            .capture_workspace("workspace", root_of(&root))
            .await
    });
    gate.started.notified().await;
    let disposed = Arc::new(AtomicBool::new(false));
    let (dispose_store, dispose_flag) = (baselines.clone(), disposed.clone());
    let disposal = tokio::spawn(async move {
        dispose_store.dispose().await;
        dispose_flag.store(true, Ordering::SeqCst);
    });
    tokio::task::yield_now().await;
    assert!(!disposed.load(Ordering::SeqCst));
    gate.release();
    let error = capture.await.unwrap().unwrap_err();
    disposal.await.unwrap();
    assert_eq!(error.to_string(), DISPOSED);
    assert_eq!(
        baselines.resolve_completed("workspace", repo.path()).await,
        None
    );
    let error = baselines
        .capture_workspace("workspace", root_of(repo.path()))
        .await
        .unwrap_err();
    assert_eq!(error.to_string(), DISPOSED);
}

#[tokio::test]
async fn returns_an_empty_state_when_the_baseline_object_is_missing() {
    let repo = init_repository();
    let cx = local();
    let baselines = store(&cx);
    let missing = "0".repeat(40);
    baselines.set_completed(
        "workspace",
        repo.path(),
        StepRange {
            baseline: missing.clone(),
            current: missing,
            ..StepRange::default()
        },
    );
    let result = summary(&cx, repo.path(), json!({}), last_step(), Some(&baselines))
        .await
        .unwrap();
    assert_eq!(result["baseline_available"], false);
    assert_eq!(result["entries"], json!([]));
    // The step was forgotten for this workspace and checkout.
    assert_eq!(
        baselines.resolve_completed("workspace", repo.path()).await,
        None
    );
}
