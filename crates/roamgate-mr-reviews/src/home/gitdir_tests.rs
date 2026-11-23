//! home.gitdir.test.ts: a clone kept in a repository directory, as
//! gstreamer.git is: the checkout's `.git` is a file naming the repository,
//! which names the checkout back in its `gitdir` file, and `git worktree
//! list` names the repository directory first, with no work tree of its
//! own. Herdr's worktree actions and Roamgate's worktree path run work-tree
//! commands where a worktree starts from: never there.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use roamgate_agents::js::Obj;
use serde_json::{Value, json};

use super::*;
use crate::connection::fixture::{FORGE_HOST, GitFixture, LocalConnection};
use crate::connection::{BoxFuture, MrConnection, ShellResult};
use crate::inbox::test_support::store;

pub(crate) struct Repo {
    pub git_dir: PathBuf,
    pub checkout: PathBuf,
    pub review: PathBuf,
    pub head: String,
}

fn text(path: &Path) -> String {
    path.to_str().unwrap().to_owned()
}

/// `<name>.git` beside its checkout, with the project's review worktree.
pub(crate) fn repository_directory(fx: &GitFixture, name: &str) -> Repo {
    let clones = fx.root.join("clones");
    std::fs::create_dir_all(&clones).unwrap();
    let git_dir = clones.join(format!("{name}.git"));
    let checkout = clones.join(name);
    fx.git(
        &clones,
        &[
            "clone",
            "-q",
            "--separate-git-dir",
            &text(&git_dir),
            &format!("https://{FORGE_HOST}/gstreamer/gstreamer.git"),
            &text(&checkout),
        ],
    );
    // The repository names its checkout, as gstreamer.git does.
    std::fs::write(
        git_dir.join("gitdir"),
        format!("{}/.git\n", checkout.display()),
    )
    .unwrap();
    let review = clones.join(format!("{name}.worktrees")).join("review");
    fx.git(
        &checkout,
        &["worktree", "add", "-q", "--detach", &text(&review), "HEAD"],
    );
    let head = fx.git(&checkout, &["rev-parse", "HEAD"]).trim().to_owned();
    Repo {
        git_dir,
        checkout,
        review,
        head,
    }
}

pub(crate) fn request(head: &str) -> Obj {
    json!({
        "provider": "gitlab", "host": FORGE_HOST, "project": "gstreamer/gstreamer",
        "number": 3326, "key": format!("gitlab:{FORGE_HOST}/gstreamer/gstreamer#3326"),
        "url": format!("https://{FORGE_HOST}/gstreamer/gstreamer/-/merge_requests/3326"),
        "title": "rtpgccbwe: Fix the estimate", "author": "alice", "draft": false,
        "state": "open", "updatedAt": "2026-11-23T00:00:00.000Z", "headSha": head,
        "sourceBranch": "gcc-fix", "targetBranch": "main", "pipeline": null, "notes": 0,
        "reasons": ["review_requested"],
    })
    .as_object()
    .unwrap()
    .clone()
}

/// Scripts run here; Herdr is a fake keeping workspaces.
struct GitConn {
    base: LocalConnection,
    checkout: String,
    workspaces: Mutex<Vec<Value>>,
    folders: Mutex<HashMap<String, String>>,
    herdr_calls: Mutex<Vec<(String, Value)>>,
}

impl MrConnection for GitConn {
    fn id(&self) -> &str {
        self.base.id()
    }
    fn label(&self) -> &str {
        self.base.label()
    }
    fn run<'a>(&'a self, script: &'a str, timeout_ms: u64) -> BoxFuture<'a, ShellResult> {
        self.base.run(script, timeout_ms)
    }
    fn herdr<'a>(&'a self, method: &'a str, params: Value) -> BoxFuture<'a, Result<Value, String>> {
        self.herdr_calls
            .lock()
            .unwrap()
            .push((method.to_owned(), params.clone()));
        let result = match method {
            "workspace.list" => json!({"workspaces": *self.workspaces.lock().unwrap()}),
            "pane.list" => json!({"panes": []}),
            "workspace.create" => {
                let cwd = params["cwd"].as_str().unwrap_or("").to_owned();
                let id = if cwd == self.checkout {
                    "w-clone"
                } else {
                    "w-home"
                };
                self.workspaces
                    .lock()
                    .unwrap()
                    .push(json!({"workspace_id": id, "label": params["label"], "cwd": cwd}));
                self.folders.lock().unwrap().insert(id.into(), cwd);
                json!({"workspace": {"workspace_id": id}})
            }
            "agent.get" => json!({"agent": null}),
            _ => json!({}),
        };
        Box::pin(async move { Ok(result) })
    }
}

struct Harness {
    _dir: tempfile::TempDir,
    homes: MrHomes,
    conn: Arc<GitConn>,
    key: String,
    made: Arc<Mutex<Vec<Obj>>>,
    reviews: Arc<Mutex<Vec<Obj>>>,
}

/// Homes on the repository: the worktree path does what Roamgate's and
/// Herdr's do first (the source's top level, never a linked worktree),
/// then `git worktree add`.
fn harness(fx: &Arc<GitFixture>, repo: &Repo, fail_worktree: bool) -> Harness {
    let (dir, store) = store();
    let conn = Arc::new(GitConn {
        base: fx.connection(vec![], "local"),
        checkout: text(&repo.checkout),
        workspaces: Mutex::new(vec![json!({
            "workspace_id": "w-review", "label": "Reviews \u{b7} gstreamer",
            "cwd": text(&repo.review),
        })]),
        folders: Mutex::new(HashMap::from([("w-review".to_owned(), text(&repo.review))])),
        herdr_calls: Mutex::new(vec![]),
    });
    let item = request(&repo.head);
    let key = js::sv(item.get("key")).to_owned();
    let made = Arc::new(Mutex::new(vec![]));
    let reviews = Arc::new(Mutex::new(vec![]));
    let record = json!({
        "connectionId": "local", "clone": text(&repo.git_dir), "worktree": text(&repo.review),
        "workspaceId": "w-review", "remote": "origin",
    })
    .as_object()
    .unwrap()
    .clone();
    let shared: Arc<dyn MrConnection> = conn.clone();
    let opened = reviews.clone();
    let mut deps = MrHomesDeps::new(
        Arc::new(move |_key: &str| Ok(item.clone())),
        store,
        {
            let shared = shared.clone();
            Arc::new(move || vec![shared.clone()])
        },
        Arc::new(|| {
            let settings = json!({"homePrompt": ""}).as_object().unwrap().clone();
            Box::pin(async move { settings })
        }),
        {
            let shared = shared.clone();
            Arc::new(move |_item| {
                let (conn, record) = (shared.clone(), record.clone());
                Box::pin(async move { Ok(Some((conn, record))) })
            })
        },
        Arc::new(move |params| {
            let mut opened = opened.lock().unwrap();
            opened.push(params);
            let snapshot = json!({"session": {"id": format!("rs-{}", opened.len())}});
            Box::pin(async move { Ok(snapshot) })
        }),
        Arc::new(|_key: &str| {}),
    );
    let (made_in, conn_in, fx_in) = (made.clone(), conn.clone(), fx.clone());
    deps.create_worktree = Some(Arc::new(move |input: Obj| {
        made_in.lock().unwrap().push(input.clone());
        let (conn, fx) = (conn_in.clone(), fx_in.clone());
        Box::pin(async move {
            if fail_worktree {
                return Err("fatal: this operation must be run in a work tree".to_owned());
            }
            let from = conn
                .folders
                .lock()
                .unwrap()
                .get(js::sv(input.get("workspaceId")))
                .cloned()
                .unwrap_or_default();
            // Roamgate's worktree path reads the source's top level first...
            let top = conn
                .run(
                    &format!("git -C {} rev-parse --show-toplevel", sh_quote(&from)),
                    30_000,
                )
                .await;
            if top.code != 0 {
                return Err(js::trim(&top.stderr).to_owned());
            }
            // ...and Herdr starts no worktree from a linked one.
            let dirs = conn
                .run(
                    &format!(
                        "git -C {} rev-parse --path-format=absolute --git-dir --git-common-dir",
                        sh_quote(&from)
                    ),
                    30_000,
                )
                .await;
            let lines: Vec<&str> = js::trim(&dirs.stdout).split('\n').collect();
            if lines.first() != lines.get(1) {
                return Err(
                    "New and open worktree actions start from the repo parent workspace.".into(),
                );
            }
            let branch = js::sv(input.get("branch")).to_owned();
            let path = text(&fx.root.join("worktrees").join(&branch));
            fx.git(
                Path::new(js::trim(&top.stdout)),
                &["worktree", "add", "-q", "-b", &branch, &path],
            );
            conn.workspaces.lock().unwrap().push(json!({
                "workspace_id": "w-home", "label": branch, "worktree": {"checkout_path": path},
            }));
            conn.folders
                .lock()
                .unwrap()
                .insert("w-home".into(), path.clone());
            Ok(MadeWorktree {
                path,
                workspace_id: Some("w-home".into()),
            })
        })
    }));
    deps.poll_ms = 1;
    deps.deliver_ms = 1;
    Harness {
        _dir: dir,
        homes: MrHomes::new(deps),
        conn,
        key,
        made,
        reviews,
    }
}

fn fixture() -> Arc<GitFixture> {
    let fx = GitFixture::new();
    fx.project("gstreamer/gstreamer");
    Arc::new(fx)
}

fn creates(conn: &GitConn) -> Vec<Value> {
    conn.herdr_calls
        .lock()
        .unwrap()
        .iter()
        .filter(|(method, _)| method == "workspace.create")
        .map(|(_, params)| params.clone())
        .collect()
}

#[tokio::test]
async fn a_repository_directory_what_git_lists_first_with_no_work_tree_its_checkout_found_and_only_its_own()
 {
    let fx = fixture();
    let repo = repository_directory(&fx, "shape");
    let conn = fx.connection(vec![], "local");
    let source = |dir: PathBuf| {
        let script = home_source_script(&text(&dir));
        let conn = &conn;
        async move { parse_home_source(&conn.run(&script, 30_000).await.stdout) }
    };
    assert_eq!(
        fx.git(&repo.review, &["worktree", "list", "--porcelain"])
            .split('\n')
            .next()
            .unwrap(),
        format!("worktree {}", repo.git_dir.display())
    );
    let top = conn
        .run(
            &format!(
                "git -C {} rev-parse --show-toplevel",
                sh_quote(&text(&repo.git_dir))
            ),
            30_000,
        )
        .await;
    assert_ne!(top.code, 0);
    assert!(top.stderr.contains("must be run in a work tree"));
    // Through its gitdir file; a checkout is its own.
    assert_eq!(source(repo.git_dir.clone()).await, text(&repo.checkout));
    assert_eq!(source(repo.checkout.clone()).await, text(&repo.checkout));
    // Without the file: the directory beside it, when it is this repository's.
    std::fs::remove_file(repo.git_dir.join("gitdir")).unwrap();
    assert_eq!(source(repo.git_dir.clone()).await, text(&repo.checkout));
    // The checkout elsewhere: unknown, unless core.worktree says.
    let moved = fx.root.join("clones").join("shape-main");
    std::fs::rename(&repo.checkout, &moved).unwrap();
    assert_eq!(source(repo.git_dir.clone()).await, "");
    fx.git(&repo.git_dir, &["config", "core.worktree", &text(&moved)]);
    assert_eq!(source(repo.git_dir.clone()).await, text(&moved));
    fx.git(&repo.git_dir, &["config", "--unset", "core.worktree"]);
    // Another repository's checkout beside it is not this one's.
    fx.git(
        &fx.root.join("clones"),
        &[
            "clone",
            "-q",
            &format!("https://{FORGE_HOST}/gstreamer/gstreamer.git"),
            &text(&repo.checkout),
        ],
    );
    assert_eq!(source(repo.git_dir.clone()).await, "");
    assert_eq!(parse_home_source("TOP\t\n"), "");
    assert_eq!(parse_home_source("TOP\t/a/b\n"), "/a/b");
}

#[tokio::test]
async fn start_a_review_with_a_home_in_a_repository_directory_the_worktree_starts_from_its_checkout_never_from_the_git_dir()
 {
    let fx = fixture();
    let repo = repository_directory(&fx, "gstreamer");
    let t = harness(&fx, &repo, false);
    let started = t.homes.start(&t.key).await.unwrap();
    // Herdr opened the checkout, not the repository directory, and the
    // worktree started from that workspace through the worktree path.
    let cwds: Vec<Value> = creates(&t.conn).iter().map(|p| p["cwd"].clone()).collect();
    assert_eq!(cwds, vec![json!(text(&repo.checkout))]);
    assert_eq!(
        Value::Array(
            t.made
                .lock()
                .unwrap()
                .iter()
                .cloned()
                .map(Value::Object)
                .collect()
        ),
        json!([{"connectionId": "local", "workspaceId": "w-clone", "branch": "gcc-fix"}])
    );
    assert_eq!(started["created"], json!(true));
    assert_eq!(started["branch"], json!("gcc-fix"));
    assert_eq!(started["workspaceId"], json!("w-home"));
    assert_eq!(started["agent"]["state"], json!("none"));
    // The home: a worktree of the repository, on the request's branch at its head.
    let root = PathBuf::from(started["root"].as_str().unwrap());
    assert_eq!(
        fx.git(
            &root,
            &["rev-parse", "--path-format=absolute", "--git-common-dir"]
        )
        .trim(),
        text(&repo.git_dir)
    );
    assert_eq!(
        fx.git(&root, &["symbolic-ref", "HEAD"]).trim(),
        "refs/heads/gcc-fix"
    );
    assert_eq!(fx.git(&root, &["rev-parse", "HEAD"]).trim(), repo.head);
    let reviews = t.reviews.lock().unwrap().clone();
    assert_eq!(reviews[0]["workspaceId"], "w-home");
    assert_eq!(reviews[0]["root"], started["root"]);
    // Only fetches towards the forge.
    assert!(
        !t.conn
            .base
            .scripts
            .lock()
            .unwrap()
            .iter()
            .any(|s| s.contains("git push") || s.contains("git commit"))
    );
    // A worktree path that fails says where it started from.
    let failing_repo = repository_directory(&fx, "failing");
    let failing = harness(&fx, &failing_repo, true);
    let error = failing.homes.start(&failing.key).await.unwrap_err();
    assert_eq!(
        error.message(),
        format!(
            "cannot make the home's worktree from {} on Desktop: fatal: this operation must be run in a work tree",
            fx.root.join("clones").join("failing").display()
        )
    );
}

#[tokio::test]
async fn a_repository_directory_whose_checkout_is_gone_git_makes_the_home_from_the_review_worktree_and_says_what_failed()
 {
    let fx = fixture();
    let repo = repository_directory(&fx, "gone");
    std::fs::remove_dir_all(&repo.checkout).unwrap();
    let t = harness(&fx, &repo, false);
    let started = t.homes.start(&t.key).await.unwrap();
    // Not through the worktree path: beside the review worktree, opened as a workspace.
    assert!(t.made.lock().unwrap().is_empty());
    let path = fx
        .root
        .join("clones")
        .join("gone.worktrees")
        .join("gcc-fix");
    assert_eq!(started["root"], json!(text(&path)));
    assert_eq!(
        fx.git(&path, &["symbolic-ref", "HEAD"]).trim(),
        "refs/heads/gcc-fix"
    );
    assert_eq!(fx.git(&path, &["rev-parse", "HEAD"]).trim(), repo.head);
    assert_eq!(
        creates(&t.conn).first(),
        Some(&json!({"cwd": text(&path), "label": "gcc-fix", "focus": false}))
    );
    // Made again where it is: the command, its directory and git's words.
    let review = text(&repo.review);
    let again = t
        .conn
        .run(
            &home_worktree_script(&review, &text(&path), "gcc-fix", &repo.head),
            30_000,
        )
        .await;
    assert_eq!(again.code, 4);
    let why = home_worktree_error(&again, &review, &text(&path), "gcc-fix", &repo.head);
    assert!(why.starts_with(&format!(
        "git -C {review} worktree add -b gcc-fix {} {} failed: fatal: ",
        path.display(),
        &repo.head[..12]
    )));
    let entered = ShellResult {
        code: 2,
        stdout: String::new(),
        stderr: String::new(),
    };
    assert_eq!(
        home_worktree_error(&entered, "/gone/review", &text(&path), "b", &repo.head),
        "cannot enter /gone/review"
    );
    assert_eq!(
        home_worktree_path("/src/gstreamer.worktrees/review", "me/fix it"),
        "/src/gstreamer.worktrees/me-fix-it"
    );
}
