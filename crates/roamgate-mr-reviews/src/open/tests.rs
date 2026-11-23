//! The opener's cases: prefetch.test.ts, worktree.test.ts's "opening a
//! request" and home.gitdir.test.ts's picked clone.

use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, LazyLock, Mutex};

use regex::Regex;
use roamgate_agents::js::{self, Obj};
use serde_json::{Value, json};

use super::*;
use crate::connection::fixture::{FORGE_HOST, GitFixture};
use crate::connection::{BoxFuture, MrConnection, ShellResult};
use crate::home::gitdir_tests::repository_directory;
use crate::inbox::test_support::{SharedStore, fixed, store};
use crate::settings::default_settings;

type HerdrFn = Box<dyn Fn(&str, &Value) -> Value + Send + Sync>;

/// A connection made of closures.
struct FnConn {
    id: &'static str,
    label: &'static str,
    run: Box<dyn Fn(&str) -> ShellResult + Send + Sync>,
    dirs: Box<dyn Fn() -> Vec<String> + Send + Sync>,
    herdr: HerdrFn,
}

impl MrConnection for FnConn {
    fn id(&self) -> &str {
        self.id
    }
    fn label(&self) -> &str {
        self.label
    }
    fn run<'a>(&'a self, script: &'a str, _timeout: u64) -> BoxFuture<'a, ShellResult> {
        let result = (self.run)(script);
        Box::pin(async move { result })
    }
    fn dirs(&self) -> BoxFuture<'_, Vec<String>> {
        let dirs = (self.dirs)();
        Box::pin(async move { dirs })
    }
    fn herdr<'a>(&'a self, method: &'a str, params: Value) -> BoxFuture<'a, Result<Value, String>> {
        let result = (self.herdr)(method, &params);
        Box::pin(async move { Ok(result) })
    }
}

fn obj(value: Value) -> Obj {
    value.as_object().unwrap().clone()
}

fn item(n: u64, extra: Value) -> Obj {
    let mut base = obj(json!({
        "provider": "gitlab", "host": "h", "project": "g/p", "number": n,
        "key": format!("gitlab:h/g/p#{n}"), "url": format!("https://h/g/p/-/merge_requests/{n}"),
        "title": format!("MR {n}"), "author": "a", "draft": false, "state": "open",
        "updatedAt": "2026-11-04T00:00:00Z", "headSha": format!("{n:a<40}"),
        "sourceBranch": "x", "targetBranch": "main", "pipeline": null, "notes": 0, "reasons": [],
    }));
    for (key, value) in obj(extra) {
        base.insert(key, value);
    }
    base
}

struct Deps {
    store: SharedStore,
    items: Vec<Obj>,
    connections: Vec<Arc<dyn MrConnection>>,
    default_connection: Option<DefaultConnection>,
    placed: Arc<Mutex<Vec<Obj>>>,
    opened: Arc<Mutex<Vec<Obj>>>,
    saved: Arc<Mutex<Vec<(String, Obj)>>>,
}

fn opener(deps: &Deps) -> MrOpener {
    let items = deps.items.clone();
    let connections = deps.connections.clone();
    let (placed, opened, saved) = (deps.placed.clone(), deps.opened.clone(), deps.saved.clone());
    MrOpener::new(MrOpenerDeps {
        item: Arc::new(move |key: &str| {
            items
                .iter()
                .find(|each| js::sv(each.get("key")) == key)
                .cloned()
        }),
        mark_seen: Arc::new(|_key: &str| {}),
        store: deps.store.clone(),
        settings: fixed(&default_settings()),
        save_clone: Arc::new(move |key, clone| {
            saved.lock().unwrap().push((key, clone));
            Box::pin(async { Ok(()) })
        }),
        connections: Arc::new(move || connections.clone()),
        default_connection: deps
            .default_connection
            .clone()
            .map(|preferred| Arc::new(move || Some(preferred.clone())) as DefaultConnectionFn),
        clones: Arc::new(CloneFinder::new()),
        place_workspace: Some(Arc::new(move |params| {
            placed.lock().unwrap().push(params);
            Box::pin(async { Ok(()) })
        })),
        open_review: Arc::new(move |params| {
            let mut opened = opened.lock().unwrap();
            opened.push(params);
            let snapshot = json!({"session": {"id": format!("s-{}", opened.len())}});
            Box::pin(async move { Ok(snapshot) })
        }),
        logger: roamgate_base::log::Logger::silent(),
    })
}

fn deps(store: SharedStore, items: Vec<Obj>, connections: Vec<Arc<dyn MrConnection>>) -> Deps {
    Deps {
        store,
        items,
        connections,
        default_connection: None,
        placed: Arc::new(Mutex::new(vec![])),
        opened: Arc::new(Mutex::new(vec![])),
        saved: Arc::new(Mutex::new(vec![])),
    }
}

static NUMS: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#"nums="\$nums (\d+)""#).expect("pattern"));
static HEADS: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"merge-requests/(\d+)/head").expect("pattern"));

fn wanted(script: &str) -> Vec<u64> {
    HEADS
        .captures_iter(script)
        .map(|c| c[1].parse().unwrap())
        .collect()
}

#[tokio::test]
async fn prefetch_only_the_users_requests_and_the_picks_once_per_head() {
    let (_dir, store) = store();
    store
        .lock()
        .unwrap()
        .update(|state| {
            state.insert(
                "projects".into(),
                json!({"h/g/p": {"connectionId": "c", "clone": "/src/p",
                    "worktree": "/src/p.worktrees/review", "remote": "upstream"}}),
            );
            state.insert(
                "ranked".into(),
                json!({"gitlab:h/g/p#3": {"updatedAt": "t", "pick": true, "score": 80,
                    "reason": "r", "at": "t"}}),
            );
        })
        .unwrap();
    let scripts = Arc::new(Mutex::new(Vec::<String>::new()));
    let ran = scripts.clone();
    let conn: Arc<dyn MrConnection> = Arc::new(FnConn {
        id: "c",
        label: "C",
        run: Box::new(move |script| {
            ran.lock().unwrap().push(script.to_owned());
            // Each wanted head: fetched.
            let stdout = NUMS
                .captures_iter(script)
                .map(|c| format!("FETCHED {}\n", &c[1]))
                .collect();
            ShellResult {
                code: 0,
                stdout,
                stderr: String::new(),
            }
        }),
        dirs: Box::new(Vec::new),
        herdr: Box::new(|_, _| json!({})),
    });
    let opener = opener(&deps(store, vec![], vec![conn]));
    let items = vec![
        item(1, json!({"reasons": ["review_requested"]})),
        // A followed project's request nobody picked: never fetched.
        item(2, json!({})),
        item(3, json!({})),
        // Merged: never fetched.
        item(4, json!({"reasons": ["assigned"], "state": "merged"})),
    ];
    opener.prefetch(&items).await;
    assert_eq!(scripts.lock().unwrap().len(), 1);
    let mut first = wanted(&scripts.lock().unwrap()[0]);
    first.sort();
    assert_eq!(first, vec![1, 3]);
    // The same heads: no git command at all.
    opener.prefetch(&items).await;
    assert_eq!(scripts.lock().unwrap().len(), 1);
    // A push to !1: only it.
    let pushed: Vec<Obj> = items
        .iter()
        .map(|each| {
            let mut each = each.clone();
            if each["number"] == 1 {
                each.insert("headSha".into(), json!("f".repeat(40)));
            }
            each
        })
        .collect();
    opener.prefetch(&pushed).await;
    assert_eq!(scripts.lock().unwrap().len(), 2);
    assert_eq!(wanted(&scripts.lock().unwrap()[1]), vec![1]);
}

#[tokio::test]
async fn a_new_project_waits_for_the_default_connection_a_known_one_does_not() {
    let (_dir, store) = store();
    let scans = Arc::new(AtomicUsize::new(0));
    let counted = scans.clone();
    let conn: Arc<dyn MrConnection> = Arc::new(FnConn {
        id: "local",
        label: "Local",
        run: Box::new(|_| ShellResult::default()),
        dirs: Box::new(move || {
            counted.fetch_add(1, Ordering::SeqCst);
            vec!["/src/q".into()]
        }),
        herdr: Box::new(|_, _| json!({})),
    });
    let mut deps = deps(
        store,
        vec![
            item(1, json!({})),
            item(2, json!({"project": "g/q", "key": "gitlab:h/g/q#2"})),
        ],
        vec![conn],
    );
    deps.default_connection = Some(DefaultConnection {
        id: "desktop".into(),
        label: "desktop".into(),
        ready: false,
    });
    let error = opener(&deps)
        .open("gitlab:h/g/q#2", None)
        .await
        .unwrap_err();
    assert!(
        error
            .message()
            .contains("desktop, the default connection, is not connected")
    );
    // Nothing was looked for elsewhere meanwhile.
    assert_eq!(scans.load(Ordering::SeqCst), 0);
}

/// `sh -c` in `dir`, git with no user configuration.
fn sh(script: &str, dir: &Path) -> ShellResult {
    let output = Command::new("sh")
        .arg("-c")
        .arg(script)
        .current_dir(dir)
        .env("GIT_AUTHOR_NAME", "T")
        .env("GIT_AUTHOR_EMAIL", "t@example.org")
        .env("GIT_COMMITTER_NAME", "T")
        .env("GIT_COMMITTER_EMAIL", "t@example.org")
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .stdin(Stdio::null())
        .output()
        .unwrap();
    ShellResult {
        code: output.status.code().unwrap_or(-1),
        stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
        stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
    }
}

#[tokio::test]
async fn worktree_workspace_review_checkout_asks_for_a_clone_when_none() {
    let tmp = tempfile::tempdir().unwrap();
    let dir = tmp.path().canonicalize().unwrap();
    // The "forge": a bare repository with merge request refs.
    let setup = sh(
        r#"
    set -e
    git init -q -b main forge-src && cd forge-src
    git config user.email t@example.org && git config user.name T
    echo base > a.txt && git add a.txt && git commit -qm base
    git checkout -qb mr1 && echo one > b.txt && git add b.txt && git commit -qm one
    git checkout -q main && git checkout -qb mr2 && echo two > c.txt && git add c.txt && git commit -qm two
    git checkout -q main
    cd .. && git clone -q --bare forge-src forge.git
    cd forge.git
    git update-ref refs/merge-requests/1/head $(git rev-parse mr1)
    git update-ref refs/merge-requests/2/head $(git rev-parse mr2)
    git branch -D mr1 mr2 >/dev/null
    cd .. && git clone -q --no-local forge.git clone
    git -C clone remote rename origin upstream
    git -C clone remote set-url upstream https://gitlab.example.org/group/app.git
    git -C clone config "url.$PWD/forge.git.insteadOf" https://gitlab.example.org/group/app.git
    git -C clone remote add mine git@gitlab.example.org:me/app.git
  "#,
        &dir,
    );
    assert_eq!(setup.code, 0, "{}", setup.stderr);
    let head = |n: u64| {
        js::trim(
            &sh(
                &format!("git -C forge.git rev-parse refs/merge-requests/{n}/head"),
                &dir,
            )
            .stdout,
        )
        .to_owned()
    };
    let heads = [head(1), head(2)];
    let clone = dir.join("clone").to_str().unwrap().to_owned();
    let herdr_calls = Arc::new(Mutex::new(Vec::<(String, Value)>::new()));
    let (calls, run_dir, scan) = (herdr_calls.clone(), dir.clone(), clone.clone());
    let conn: Arc<dyn MrConnection> = Arc::new(FnConn {
        id: "local",
        label: "Local",
        run: Box::new(move |script| sh(script, &run_dir)),
        dirs: Box::new(move || vec![scan.clone()]),
        herdr: Box::new(move |method, params| {
            calls
                .lock()
                .unwrap()
                .push((method.to_owned(), params.clone()));
            match method {
                "workspace.list" => json!({"workspaces": []}),
                "workspace.create" => json!({"workspace": {"workspace_id": "w9"}}),
                _ => json!({}),
            }
        }),
    });
    let request = |number: u64, project: &str| {
        obj(json!({
            "provider": "gitlab", "host": "gitlab.example.org", "project": project,
            "number": number, "key": format!("gitlab:gitlab.example.org/{project}#{number}"),
            "url": format!("https://gitlab.example.org/{project}/-/merge_requests/{number}"),
            "title": format!("MR {number}"), "author": "a", "draft": false, "state": "open",
            "updatedAt": "2026-11-04T00:00:00Z",
            "headSha": heads.get(number as usize - 1).cloned().unwrap_or_else(|| "f".repeat(40)),
            "sourceBranch": "x", "targetBranch": "main", "pipeline": null, "notes": 0,
            "reasons": ["review_requested"],
        }))
    };
    let items = vec![
        request(1, "group/app"),
        request(2, "group/app"),
        request(3, "group/elsewhere"),
    ];
    let (_store_dir, store) = store();
    let deps = deps(store.clone(), items.clone(), vec![conn]);
    let fresh = opener(&deps);
    let key = js::sv(items[1].get("key"));
    let result = fresh.open(key, None).await.unwrap();
    assert!(result.get("needClone").is_none(), "no clone");
    let worktree = format!("{clone}.worktrees/review");
    assert_eq!(result["workspaceId"], "w9");
    assert_eq!(result["worktree"], json!(worktree));
    assert_eq!(result["checkout"]["state"], "done");
    assert_eq!(result["checkout"]["head"], json!(heads[1]));
    let created = herdr_calls
        .lock()
        .unwrap()
        .iter()
        .find(|(method, _)| method == "workspace.create")
        .map(|(_, params)| params.clone());
    assert_eq!(
        created,
        Some(json!({"cwd": worktree, "label": "Reviews \u{b7} app", "focus": false}))
    );
    let last = deps.opened.lock().unwrap().last().cloned().unwrap();
    assert_eq!(last["connectionId"], "local");
    assert_eq!(last["workspaceId"], "w9");
    assert_eq!(last["root"], json!(worktree));
    assert_eq!(last["url"], items[1]["url"]);
    assert_eq!(
        store.lock().unwrap().get()["reviews"][key]["sessionId"],
        "s-1"
    );
    // The new workspace is placed in the tree, next to its clone's.
    assert_eq!(
        Value::Array(
            deps.placed
                .lock()
                .unwrap()
                .iter()
                .cloned()
                .map(Value::Object)
                .collect()
        ),
        json!([{"projectKey": "gitlab.example.org/group/app", "connectionId": "local",
            "workspaceId": "w9", "label": "Reviews \u{b7} app", "worktree": worktree,
            "clone": clone}])
    );
    // Another project without a clone: the user is asked.
    let other = fresh.open(js::sv(items[2].get("key")), None).await.unwrap();
    assert_eq!(other["needClone"]["project"], "group/elsewhere");
}

#[tokio::test]
async fn picking_a_clone_kept_in_a_repository_directory() {
    let fx = GitFixture::new();
    fx.project("gstreamer/gstreamer");
    let repo = repository_directory(&fx, "picked");
    let (_dir, store) = store();
    let conn: Arc<dyn MrConnection> = Arc::new(fx.connection(vec![], "local"));
    let deps = deps(store, vec![], vec![conn]);
    let opener = opener(&deps);
    let project = ProjectRef {
        host: FORGE_HOST.into(),
        project: "gstreamer/gstreamer".into(),
        provider: "gitlab".into(),
    };
    let git_dir = repo.git_dir.to_str().unwrap();
    assert_eq!(
        opener.set_clone(&project, "local", git_dir).await.unwrap(),
        json!({"ok": true, "remote": "origin"})
    );
    let saved: Vec<Value> = deps
        .saved
        .lock()
        .unwrap()
        .iter()
        .map(|(key, clone)| json!([key, clone]))
        .collect();
    assert_eq!(
        saved,
        vec![json!([format!("{FORGE_HOST}/gstreamer/gstreamer"),
            {"connectionId": "local", "path": git_dir}])]
    );
    let nowhere = fx.root.join("nowhere");
    let error = opener
        .set_clone(&project, "local", nowhere.to_str().unwrap())
        .await
        .unwrap_err();
    assert!(error.message().contains("is not a Git checkout there"));
}
