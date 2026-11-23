//! `mr-reviews/effort-service.test.ts`: the effort RPCs on real git
//! repositories, through [`handle_effort_rpc`] with the deps module.ts
//! gives (a settings holder, the upstream scanner, worktree and tree
//! stand-ins). The board tools' own texts are board-tools.ts's tests.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use roamgate_agents::js::{self, Obj};
use roamgate_base::paths::{DataContext, Platform};
use serde_json::{Value, json};

use super::rpc::{CallFn, EffortRpcDeps, main_checkout};
use super::scripts::*;
use super::*;
use crate::connection::fixture::{FORGE_HOST, GitFixture, LocalConnection};
use crate::connection::{BoxFuture, MrConnection, ShellResult};
use crate::order::ChangeMeta;
use crate::settings::mr_reviews_settings;
use crate::shared::types::fixup_targets;
use crate::upstream::UpstreamScanner;

fn obj(value: Value) -> Obj {
    match value {
        Value::Object(map) => map,
        _ => Obj::new(),
    }
}

fn p(path: &Path) -> String {
    path.to_str().unwrap().to_owned()
}

/// A connection as the git fixture's, its workspaces changeable and
/// described as Herdr does (`worktree` when given), agents unknown.
struct TestConnection {
    local: LocalConnection,
    workspaces: Mutex<Vec<Value>>,
    /// The session conversation mode holds a pane on.
    held: Mutex<Option<(String, String)>>,
}

impl TestConnection {
    fn add(&self, id: &str, label: &str, cwd: &Path, worktree: Option<Value>) {
        let mut workspace = obj(json!({"workspace_id": id, "label": label, "cwd": p(cwd)}));
        if let Some(worktree) = worktree {
            workspace.insert("worktree".into(), worktree);
        }
        self.workspaces
            .lock()
            .unwrap()
            .push(Value::Object(workspace));
    }

    fn count(&self) -> usize {
        self.workspaces.lock().unwrap().len()
    }
}

impl MrConnection for TestConnection {
    fn id(&self) -> &str {
        "local"
    }
    fn label(&self) -> &str {
        "Desktop"
    }
    fn run<'a>(&'a self, script: &'a str, timeout_ms: u64) -> BoxFuture<'a, ShellResult> {
        self.local.run(script, timeout_ms)
    }
    fn dirs(&self) -> BoxFuture<'_, Vec<String>> {
        let dirs = self
            .workspaces
            .lock()
            .unwrap()
            .iter()
            .map(|w| js::sv(w.get("cwd")).to_owned())
            .collect();
        Box::pin(async move { dirs })
    }
    fn herdr<'a>(
        &'a self,
        method: &'a str,
        _params: Value,
    ) -> BoxFuture<'a, Result<Value, String>> {
        let workspaces = self.workspaces.lock().unwrap().clone();
        let answer = match method {
            "workspace.list" => Ok(json!({"workspaces": workspaces.iter().map(|w| {
                let mut out = obj(json!({"workspace_id": w["workspace_id"], "label": w["label"]}));
                if let Some(worktree) = w.get("worktree") {
                    out.insert("worktree".into(), worktree.clone());
                }
                Value::Object(out)
            }).collect::<Vec<_>>()})),
            "pane.list" => Ok(json!({"panes": workspaces.iter().map(|w| json!({
                "pane_id": format!("{}:p1", js::sv(w.get("workspace_id"))),
                "workspace_id": w["workspace_id"],
                "cwd": w["cwd"],
            })).collect::<Vec<_>>()})),
            "agent.get" => Err("agent_not_found".to_owned()),
            _ => Ok(json!({})),
        };
        Box::pin(async move { answer })
    }
    fn conversation_owned<'a>(&'a self, pane_id: &'a str) -> BoxFuture<'a, Option<String>> {
        let held = self
            .held
            .lock()
            .unwrap()
            .clone()
            .filter(|(pane, _)| pane == pane_id)
            .map(|(_, session)| session);
        Box::pin(async move { held })
    }
}

/// What a test makes worktrees with.
type Create = Arc<dyn Fn(&Obj) -> Result<Obj, String> + Send + Sync>;

struct Env {
    g: Arc<GitFixture>,
    connection: Arc<TestConnection>,
    settings: Arc<Mutex<Obj>>,
    tree: Arc<Mutex<Value>>,
    upstream: Arc<UpstreamScanner>,
    service: EffortService,
    deps: EffortRpcDeps,
    pushes: Arc<Mutex<Vec<Obj>>>,
    calls: Arc<Mutex<Vec<Obj>>>,
    placed: Arc<Mutex<Vec<Obj>>>,
    opened: Arc<Mutex<Vec<Obj>>>,
    threads: Arc<Mutex<Vec<Obj>>>,
    _dir: tempfile::TempDir,
}

fn group_tree(workspace: Value) -> Value {
    json!({"version": 1, "nodes": [
        {"id": "g1", "kind": "group", "parent": null, "label": "Big"},
        {"id": "n1", "kind": "workspace", "parent": "g1", "ref": workspace},
    ]})
}

impl Env {
    /// `tree` the Workspaces tree; `create` the worktree path; `grow`: a
    /// part placed in the group shows in the tree, named by its folder.
    fn new(g: GitFixture, tree: Value, create: Option<Create>, grow: bool) -> Env {
        let g = Arc::new(g);
        let connection = Arc::new(TestConnection {
            local: g.connection(vec![], "local"),
            workspaces: Mutex::new(vec![]),
            held: Mutex::new(None),
        });
        let stored = obj(
            json!({"hosts": [{"host": FORGE_HOST, "provider": "gitlab"}], "upstream_groups": ["g1"]}),
        );
        let settings = Arc::new(Mutex::new(mr_reviews_settings(Some(&stored))));
        let tree = Arc::new(Mutex::new(tree));
        let connections: crate::upstream::ConnectionsFn = {
            let connection = connection.clone();
            Arc::new(move || vec![connection.clone() as Arc<dyn MrConnection>])
        };
        let settings_fn: crate::inbox::SettingsFn = {
            let settings = settings.clone();
            Arc::new(move || {
                let value = settings.lock().unwrap().clone();
                Box::pin(async move { value })
            })
        };
        let upstream = {
            let tree = tree.clone();
            let settings = settings.clone();
            Arc::new(UpstreamScanner::new(
                connections.clone(),
                Arc::new(move || {
                    let value = tree.lock().unwrap().clone();
                    Box::pin(async move { Ok(value) })
                }),
                Arc::new(move || {
                    let value = settings.lock().unwrap().clone();
                    Box::pin(async move { Ok(value) })
                }),
            ))
        };
        let pushes: Arc<Mutex<Vec<Obj>>> = Arc::default();
        let dir = tempfile::tempdir().unwrap();
        let context = DataContext::new(dir.path(), Platform::current(), None);
        let service = EffortService::new(EffortServiceOptions {
            context: context.clone(),
            root: context.data_root().join("mr-reviews").join("efforts"),
            settings: settings_fn.clone(),
            connections,
            items: Arc::new(Vec::new),
            upstream: upstream.clone(),
            publish: Some({
                let pushes = pushes.clone();
                Arc::new(move |push| pushes.lock().unwrap().push(push))
            }),
            current: {
                let settings = settings.clone();
                Arc::new(move || {
                    let value = settings.lock().unwrap().clone();
                    Box::pin(async move {
                        (
                            value.get("orderVersion").cloned().unwrap_or(json!(0)),
                            value.get("order").cloned().unwrap_or(json!([])),
                        )
                    })
                })
            },
            now: None,
        });
        let calls: Arc<Mutex<Vec<Obj>>> = Arc::default();
        let placed: Arc<Mutex<Vec<Obj>>> = Arc::default();
        let opened: Arc<Mutex<Vec<Obj>>> = Arc::default();
        let threads: Arc<Mutex<Vec<Obj>>> = Arc::default();
        let editing = Arc::new(tokio::sync::Mutex::new(()));
        let create_worktree: Option<CallFn> = create.map(|create| {
            let calls = calls.clone();
            Arc::new(move |input: Obj| {
                calls.lock().unwrap().push(input.clone());
                let made = create(&input);
                Box::pin(async move { made }) as BoxFuture<'static, Result<Obj, String>>
            }) as CallFn
        });
        let deps = EffortRpcDeps {
            service: service.clone(),
            settings: settings_fn,
            edit: Arc::new(move |change| {
                let editing = editing.clone();
                Box::pin(async move {
                    let _turn = editing.lock().await;
                    change.await
                })
            }),
            save: {
                let settings = settings.clone();
                Arc::new(move |value: Obj, _meta: ChangeMeta| {
                    *settings.lock().unwrap() = value.clone();
                    Box::pin(async move { Ok(value) })
                })
            },
            upstream: upstream.clone(),
            entries: None,
            group_label: {
                let tree = tree.clone();
                Arc::new(move |group: String| {
                    let label = tree.lock().unwrap()["nodes"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .find(|n| n["id"] == json!(group) && n["kind"] == "group")
                        .map(|n| js::sv(n.get("label")).to_owned());
                    Box::pin(async move { label })
                })
            },
            create_worktree,
            place: Some({
                let placed = placed.clone();
                let tree = tree.clone();
                Arc::new(move |input: Obj| {
                    placed.lock().unwrap().push(input.clone());
                    if grow && input.get("under").is_none() {
                        let mut tree = tree.lock().unwrap();
                        let nodes = tree["nodes"].as_array_mut().unwrap();
                        let id = format!("n{}", nodes.len());
                        let label = js::sv(input.get("path"))
                            .rsplit('/')
                            .next()
                            .unwrap()
                            .to_owned();
                        nodes.push(
                            json!({"id": id, "kind": "workspace", "parent": input["group"],
                            "ref": {"connection_id": "local", "label": label}}),
                        );
                    }
                    Box::pin(async { Ok(Obj::new()) })
                })
            }),
            open_range: Some({
                let opened = opened.clone();
                Arc::new(move |input: Obj| {
                    opened.lock().unwrap().push(input);
                    Box::pin(async { Ok(obj(json!({"sessionId": "s1"}))) })
                })
            }),
            effort_review: Some({
                let threads = threads.clone();
                Arc::new(move |input: Obj| {
                    let open = input["open"] == json!(true);
                    threads.lock().unwrap().push(input);
                    if open {
                        json!({"session": {"id": "rs-effort"}, "threads": []})
                    } else {
                        Value::Null
                    }
                })
            }),
        };
        Env {
            g,
            connection,
            settings,
            tree,
            upstream,
            service,
            deps,
            pushes,
            calls,
            placed,
            opened,
            threads,
            _dir: dir,
        }
    }

    async fn handle(&self, method: &str, params: Value) -> Result<Value, crate::rpc::RpcError> {
        handle_effort_rpc(
            &self.deps,
            &format!("bridge.mr_reviews.{method}"),
            &obj(params),
        )
        .await
        .map(|answer| answer.expect("an effort method"))
    }

    async fn ok(&self, method: &str, params: Value) -> Value {
        match self.handle(method, params).await {
            Ok(answer) => answer,
            Err(error) => panic!("{method}: {}", error.message()),
        }
    }

    async fn refused(&self, method: &str, params: Value) -> String {
        match self.handle(method, params).await {
            Ok(answer) => panic!("{method} answered {answer}"),
            Err(error) => error.message().to_owned(),
        }
    }

    fn efforts(&self) -> Vec<Value> {
        super::efforts_of(&self.settings.lock().unwrap())
    }

    fn summaries(&self) -> Vec<Value> {
        let settings = self.settings.lock().unwrap().clone();
        self.service.summaries(&settings)
    }

    /// The source's commits, oldest first (the ledger's list).
    fn shas(&self, effort: &str) -> Vec<String> {
        let id = find_effort(&self.efforts(), effort).unwrap()["id"]
            .as_str()
            .unwrap()
            .to_owned();
        super::commits_of(self.service.store().derived(&id).as_ref())
            .iter()
            .map(|c| c["sha"].as_str().unwrap().to_owned())
            .collect()
    }

    async fn plan_of(&self, name: &str) -> Value {
        let got = self.ok("effort.get", json!({"id": "Big"})).await;
        got["plans"]
            .as_array()
            .unwrap()
            .iter()
            .find(|plan| plan["name"] == name)
            .cloned()
            .unwrap()
    }

    fn git(&self, dir: &Path, args: &[&str]) -> String {
        self.g.git(dir, args)
    }
}

/// A clone of media/engine on branch big with the given commits.
fn engine(commits: &[(&str, &str, &str)]) -> (GitFixture, PathBuf) {
    let g = GitFixture::new();
    g.project("media/engine");
    let clone = g.clone("media/engine", "engine");
    g.git(&clone, &["checkout", "-q", "-b", "big"]);
    for (file, content, message) in commits {
        g.commit(&clone, file, content, message, None);
    }
    (g, clone)
}

/// git as the fixture runs it, from a worktree path stand-in.
fn run_git(home: &Path, dir: &Path, args: &[&str]) -> Result<String, String> {
    let output = std::process::Command::new("git")
        .arg("-C")
        .arg(dir)
        .args(args)
        .env("HOME", home)
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_AUTHOR_DATE", "2026-01-01T00:00:00Z")
        .env("GIT_COMMITTER_DATE", "2026-01-01T00:00:00Z")
        .stdin(std::process::Stdio::null())
        .output()
        .map_err(|e| e.to_string())?;
    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).into_owned())
    } else {
        Err(String::from_utf8_lossy(&output.stderr).trim().to_owned())
    }
}

type Slot = Arc<Mutex<Option<Arc<TestConnection>>>>;

/// The tests' worktree path: a new branch from origin/main at
/// `part-<branch>` (an existing branch checked out as it is, as Herdr
/// does), its workspace added, each path made kept in `made`.
fn plain_create(
    g: &GitFixture,
    clone: &Path,
    slot: Slot,
    made: Arc<Mutex<Vec<PathBuf>>>,
) -> Create {
    let root = g.root.clone();
    let clone = clone.to_owned();
    Arc::new(move |input: &Obj| {
        let home = root.join("home");
        let branch = js::sv(input.get("branch"));
        let path = root.join(format!("part-{}", branch.replace('/', "-")));
        let exists = !run_git(&home, &clone, &["branch", "--list", branch])?
            .trim()
            .is_empty();
        if exists {
            run_git(&home, &clone, &["worktree", "add", "-q", &p(&path), branch])?;
        } else {
            run_git(
                &home,
                &clone,
                &[
                    "worktree",
                    "add",
                    "-q",
                    "-b",
                    branch,
                    &p(&path),
                    "origin/main",
                ],
            )?;
        }
        made.lock().unwrap().push(path.clone());
        let connection = slot.lock().unwrap().clone().unwrap();
        let id = format!("w{}", connection.count() + 1);
        connection.add(
            &id,
            path.file_name().unwrap().to_str().unwrap(),
            &path,
            None,
        );
        Ok(obj(json!({"path": p(&path), "workspaceId": id})))
    })
}

/// An Env with the clone's workspace w1 "big" in group g1 and the plain
/// worktree path; the paths it made.
fn big_env(g: GitFixture, clone: &Path, grow: bool) -> (Env, Arc<Mutex<Vec<PathBuf>>>) {
    let slot: Slot = Arc::default();
    let made: Arc<Mutex<Vec<PathBuf>>> = Arc::default();
    let create = plain_create(&g, clone, slot.clone(), made.clone());
    let env = Env::new(
        g,
        group_tree(json!({"connection_id": "local", "label": "big"})),
        Some(create),
        grow,
    );
    *slot.lock().unwrap() = Some(env.connection.clone());
    env.connection.add("w1", "big", clone, None);
    (env, made)
}

async fn declare(env: &Env, params: Value) -> Value {
    env.upstream.refresh(true).await;
    let declared = env.ok("effort.set", params).await;
    env.service.refresh(true).await;
    declared
}

async fn propose(env: &Env, name: &str, commits: &[&String], extra: Value) {
    let mut params = obj(
        json!({"id": "Big", "action": "propose", "name": name, "commits": commits, "accepted": true}),
    );
    params.extend(obj(extra));
    env.ok("ledger.plans", Value::Object(params)).await;
}

/// `toMatchObject`.
fn has(value: &Value, wanted: Value) {
    for (key, want) in obj(wanted) {
        match (&value[&key], &want) {
            (Value::Object(_), Value::Object(_)) => has(&value[&key], want.clone()),
            (got, want) => assert_eq!(got, want, "{key} in {value}"),
        }
    }
}

fn matches(pattern: &str, text: &str) -> bool {
    regex::Regex::new(pattern).unwrap().is_match(text)
}

#[tokio::test(flavor = "multi_thread")]
async fn an_effort_declared_its_card_ledger_tools_the_push_with_undo_refusals() {
    let (g, clone) = engine(&[
        ("pool/a.c", "a\n", "pool: add a"),
        ("pool/b.c", "b\n", "pool: add b"),
    ]);
    g.git(&clone, &["branch", "-q", "other-big"]);
    g.git(&clone, &["update-ref", "refs/remotes/origin/big", "HEAD"]);
    let (env, _) = big_env(g, &clone, false);
    *env.tree.lock().unwrap() = json!({"version": 1, "nodes": [
        {"id": "g1", "kind": "group", "parent": null, "label": "Big upstreaming"},
        {"id": "n1", "kind": "workspace", "parent": "g1", "ref": {"connection_id": "local", "label": "big"}},
    ]});
    env.upstream.refresh(true).await;
    // "big" is a local branch and a remote one: the local one, as git reads it.
    let preview = env
        .ok("effort.preview", json!({"group": "g1", "source": "big"}))
        .await;
    assert_eq!(preview["effort"]["source"], "refs/heads/big");
    // Only remote branches, of two remotes: ambiguous, refused.
    env.git(&clone, &["update-ref", "refs/remotes/origin/far", "HEAD"]);
    env.git(&clone, &["update-ref", "refs/remotes/mac/far", "HEAD"]);
    let refused = env
        .refused("effort.set", json!({"group": "g1", "source": "far"}))
        .await;
    assert!(
        matches(
            r"ambiguous.*refs/remotes/mac/far.*refs/remotes/origin/far",
            &refused
        ),
        "{refused}"
    );
    let far = env
        .ok(
            "effort.preview",
            json!({"group": "g1", "source": "mac/far"}),
        )
        .await;
    assert_eq!(far["effort"]["source"], "refs/remotes/mac/far");
    let preview = env
        .ok(
            "effort.preview",
            json!({"group": "g1", "source": "refs/heads/big"}),
        )
        .await;
    has(
        &preview["preview"],
        json!({"total": 2, "counts": {"unsorted": 2}}),
    );
    assert!(env.efforts().is_empty());
    let declared = env
        .ok(
            "effort.set",
            json!({"group": "g1", "source": "refs/heads/big", "by": "agent"}),
        )
        .await;
    has(
        &declared["effort"],
        json!({
            "name": "Big upstreaming",
            "source": "refs/heads/big",
            "target": {"remote": "origin", "branch": "main"},
            "clone": {"connectionId": "local", "path": p(&clone)},
        }),
    );
    let id = declared["effort"]["id"].as_str().unwrap().to_owned();
    assert!(matches("^e[0-9a-z]+$", &id), "{id}");
    env.service.refresh(true).await;
    let card = env.summaries()[0].clone();
    has(
        &card,
        json!({"name": "Big upstreaming", "source": "big", "target": "origin/main", "total": 2, "counts": {"unsorted": 2}}),
    );
    let shas = env.shas("big upstreaming");
    let set = env
        .ok(
            "ledger.set",
            json!({"id": "Big upstreaming", "commits": [shas[1]], "disposition": "not_for_upstream",
            "reason": "debug only", "by": "agent", "summary": "Claude in lead marked 1 commit not for upstream"}),
        )
        .await;
    has(&set, json!({"ok": true, "changed": 1, "journal": 1}));
    let push = env.pushes.lock().unwrap().last().cloned().unwrap();
    has(
        &Value::Object(push),
        json!({
            "changed": ["effort"],
            "by": "agent",
            "summary": "Claude in lead marked 1 commit not for upstream",
            "effort": {"id": id, "journal": 1},
        }),
    );
    assert_eq!(
        env.summaries()[0]["counts"],
        json!({"unsorted": 1, "not_for_upstream": 1})
    );
    env.ok("ledger.undo", json!({"id": id, "journal": 1})).await;
    assert_eq!(env.summaries()[0]["counts"], json!({"unsorted": 2}));
    let unknown = env
        .refused(
            "ledger.set",
            json!({"id": "Big upstreaming", "commits": ["0000000"], "disposition": "planned"}),
        )
        .await;
    assert!(unknown.contains("nothing changed"), "{unknown}");
    // An effort on a group not headed upstream is refused.
    let nope = env
        .refused(
            "effort.set",
            json!({"group": "nope", "source": "refs/heads/big"}),
        )
        .await;
    assert!(nope.contains("headed upstream"), "{nope}");
    assert_eq!(env.summaries()[0]["overlaps"], json!([]));
}

#[tokio::test(flavor = "multi_thread")]
async fn planned_requests_a_part_made_with_its_commits_picked_a_conflict_reported_a_commit_opened()
{
    let (g, clone) = engine(&[
        ("pool/a.c", "a\n", "pool: add a"),
        ("pool/b.c", "b\n", "pool: add b"),
        ("pool/a.c", "a2\n", "pool: change a"),
    ]);
    let (env, made) = big_env(g, &clone, true);
    declare(&env, json!({"group": "g1", "source": "refs/heads/big"})).await;
    let shas = env.shas("Big");
    let (a, b, a2) = (&shas[0], &shas[1], &shas[2]);
    let proposed = env
        .ok(
            "ledger.plans",
            json!({"id": "Big", "action": "propose", "plan": "Pool b", "commits": [b], "by": "agent"}),
        )
        .await;
    has(
        &proposed["plan"],
        json!({"name": "Pool b", "state": "proposed"}),
    );
    // A part only once accepted.
    let refused = env
        .refused("effort.part", json!({"id": "Big", "plan": "Pool b"}))
        .await;
    assert!(refused.contains("accept Pool b first"), "{refused}");
    env.ok(
        "ledger.plans",
        json!({"id": "Big", "action": "accept", "plan": "Pool b"}),
    )
    .await;
    let part = env
        .ok(
            "effort.part",
            json!({"id": "Big", "plan": "Pool b", "branch": "pool-b"}),
        )
        .await;
    has(
        &part,
        json!({"ok": true, "branch": "pool-b", "picked": 1, "of": 1}),
    );
    let made0 = made.lock().unwrap()[0].clone();
    assert_eq!(
        env.git(&made0, &["log", "--format=%s", "origin/main..HEAD"])
            .trim(),
        "pool: add b"
    );
    assert_eq!(env.calls.lock().unwrap()[0]["workspaceId"], "w1");
    // In the group (no head), as the tree would place it.
    let placed = env.placed.lock().unwrap().clone();
    assert_eq!(placed.len(), 1);
    assert_eq!(placed[0]["group"], "g1");
    assert!(placed[0].get("under").is_none());
    // Its branch is a request not proposed yet, titled after the plan.
    let unsent = env.settings.lock().unwrap()["unsent"].clone();
    assert_eq!(unsent.as_array().unwrap().len(), 1);
    assert_eq!(unsent[0]["title"], "Pool b");
    // Its commit counts in a part now.
    env.service.refresh(true).await;
    let card = env.summaries()[0].clone();
    has(&card, json!({"counts": {"in_part": 1, "unsorted": 2}}));
    assert_eq!(card["plans"], json!({"proposed": 0, "accepted": 1}));
    // The change of a, without a: a conflict, reported, left as it is.
    propose(&env, "Change a", &[a2], json!({})).await;
    let conflict = env
        .ok("effort.part", json!({"id": "Big", "plan": "Change a"}))
        .await;
    has(
        &conflict,
        json!({"ok": false, "picked": 0, "conflict": {"files": ["pool/a.c"]}}),
    );
    assert!(matches(
        "^[0-9a-f]{40}$",
        conflict["conflict"]["sha"].as_str().unwrap()
    ));
    let made1 = made.lock().unwrap()[1].clone();
    assert!(matches(
        "^[0-9a-f]{40}$",
        env.git(&made1, &["rev-parse", "-q", "--verify", "CHERRY_PICK_HEAD"])
            .trim()
    ));
    has(
        &env.plan_of("Change a").await["part"]["conflict"],
        json!({"files": ["pool/a.c"]}),
    );
    // Resolved and committed there: the view reads the part as it is now.
    env.git(&made1, &["checkout", "--theirs", "pool/a.c"]);
    env.git(&made1, &["add", "pool/a.c"]);
    env.git(
        &made1,
        &["-c", "core.editor=true", "cherry-pick", "--continue"],
    );
    assert!(
        env.plan_of("Change a").await["part"]
            .get("conflict")
            .is_none()
    );
    // `d`: the commit's diff as a review in the head workspace.
    env.ok("effort.open_commit", json!({"id": "Big", "sha": a}))
        .await;
    let opened = env.opened.lock().unwrap().clone();
    assert_eq!(opened.len(), 1);
    has(
        &Value::Object(opened[0].clone()),
        json!({
            "workspaceId": "w1", "root": p(&clone), "base": format!("{a}^"), "head": a, "title": "pool: add a",
        }),
    );
    // Two versions (D32): compared tree to tree in the same Changes.
    env.ok(
        "effort.open_commit",
        json!({"id": "Big", "sha": a2, "from": a}),
    )
    .await;
    let opened = env.opened.lock().unwrap().clone();
    has(
        &Value::Object(opened[1].clone()),
        json!({"workspaceId": "w1", "base": a, "head": a2, "compare": true}),
    );
    let diff = env
        .ok("effort.diff", json!({"id": "Big", "from": a, "to": a2}))
        .await;
    assert!(diff["text"].as_str().unwrap().contains("pool"));
    // The threads on its view: read, then opened in the head's checkout by
    // the first comment, for its leader.
    assert_eq!(
        env.ok("effort.threads", json!({"id": "Big"})).await,
        json!({"snapshot": null})
    );
    let effort_id = env.efforts()[0]["id"].clone();
    let threads = env.threads.lock().unwrap().clone();
    assert_eq!(
        Value::Object(threads[0].clone()),
        json!({
            "effort": effort_id, "connectionId": "local", "root": p(&clone), "title": "Effort Big", "open": false,
        })
    );
    env.ok("effort.threads", json!({"id": "Big", "open": true}))
        .await;
    let threads = env.threads.lock().unwrap().clone();
    assert_eq!(
        Value::Object(threads[1].clone()),
        json!({
            "effort": effort_id, "connectionId": "local", "workspaceId": "w1", "root": p(&clone), "title": "Effort Big", "open": true,
        })
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn a_part_of_an_effort_headed_in_a_linked_worktree_starts_from_the_parent_workspace_else_its_main_checkout()
 {
    let (g, clone) = engine(&[
        ("pool/a.c", "a\n", "pool: add a"),
        ("pool/b.c", "b\n", "pool: add b"),
    ]);
    g.git(&clone, &["checkout", "-q", "main"]);
    // The effort's head: a linked worktree of the clone, alone in its group.
    let head = g.root.join("head");
    g.git(&clone, &["worktree", "add", "-q", &p(&head), "big"]);
    let repo_key = p(&clone.join(".git"));
    let slot: Slot = Arc::default();
    let create: Create = {
        let slot = slot.clone();
        let root = g.root.clone();
        let clone = clone.clone();
        // As Herdr does: no new worktree from a linked one, by id or by path.
        Arc::new(move |input: &Obj| {
            let connection = slot.lock().unwrap().clone().unwrap();
            let source = connection
                .workspaces
                .lock()
                .unwrap()
                .iter()
                .find(|w| Some(&w["workspace_id"]) == input.get("workspaceId"))
                .cloned();
            let linked = source.is_some_and(|s| s["worktree"]["is_linked_worktree"] == true);
            if linked
                || input
                    .get("cwd")
                    .is_some_and(|c| c.as_str() != Some(&p(&clone)))
            {
                return Err("linked_worktree_source: New and open worktree actions start from the repo parent workspace.".into());
            }
            let branch = js::sv(input.get("branch"));
            let path = root.join(format!("part-{branch}"));
            run_git(
                &root.join("home"),
                &clone,
                &[
                    "worktree",
                    "add",
                    "-q",
                    "-b",
                    branch,
                    &p(&path),
                    "origin/main",
                ],
            )?;
            Ok(obj(json!({"path": p(&path)})))
        })
    };
    let env = Env::new(
        g,
        group_tree(json!({"connection_id": "local", "label": "head"})),
        Some(create),
        false,
    );
    *slot.lock().unwrap() = Some(env.connection.clone());
    env.connection.add(
        "w1",
        "engine",
        &clone,
        Some(json!({"is_linked_worktree": false, "repo_key": repo_key})),
    );
    env.connection.add(
        "w2",
        "head",
        &head,
        Some(json!({"is_linked_worktree": true, "repo_key": repo_key})),
    );
    declare(
        &env,
        json!({"group": "g1", "source": "refs/heads/big", "head": "head"}),
    )
    .await;
    let shas = env.shas("Big");
    propose(&env, "Pool a", &[&shas[0]], json!({})).await;
    propose(&env, "Pool b", &[&shas[1]], json!({})).await;
    // The main checkout's workspace is open: the part starts there.
    has(
        &env.ok(
            "effort.part",
            json!({"id": "Big", "plan": "Pool a", "branch": "pool-a"}),
        )
        .await,
        json!({"ok": true, "picked": 1}),
    );
    assert_eq!(
        Value::Object(env.calls.lock().unwrap()[0].clone()),
        json!({"connectionId": "local", "branch": "pool-a", "workspaceId": "w1"})
    );
    // The part's workspace sits under the effort's head, not in its group.
    let placed = env.placed.lock().unwrap().clone();
    assert_eq!(placed.len(), 1);
    assert_eq!(
        Value::Object(placed[0].clone()),
        json!({
            "connectionId": "local", "path": p(&env.g.root.join("part-pool-a")), "group": "g1",
            "under": {"connectionId": "local", "path": p(&head), "workspaceId": "w2"},
        })
    );
    // None open there: the main checkout's path.
    env.connection.workspaces.lock().unwrap().remove(0);
    has(
        &env.ok(
            "effort.part",
            json!({"id": "Big", "plan": "Pool b", "branch": "pool-b"}),
        )
        .await,
        json!({"ok": true, "picked": 1}),
    );
    assert_eq!(
        Value::Object(env.calls.lock().unwrap()[1].clone()),
        json!({"connectionId": "local", "branch": "pool-b", "cwd": p(&clone)})
    );
}

#[test]
fn herdrs_errors_read_without_their_code_or_a_closing_period() {
    assert_eq!(
        readable_error(
            "linked_worktree_source: New and open worktree actions start from the repo parent workspace."
        ),
        "New and open worktree actions start from the repo parent workspace"
    );
    assert_eq!(
        readable_error("Worktree command failed (exit 1): no"),
        "Worktree command failed (exit 1): no"
    );
}

/// A clone with a part worktree on origin/main, and a pick runner there.
struct PartFixture {
    g: GitFixture,
    clone: PathBuf,
    part: PathBuf,
    connection: LocalConnection,
}

impl PartFixture {
    fn new() -> PartFixture {
        let (g, clone) = engine(&[]);
        let part = g.root.join("part");
        let connection = g.connection(vec![], "local");
        PartFixture {
            g,
            clone,
            part,
            connection,
        }
    }

    async fn run(&self, shas: &[String]) -> Pick {
        let script = pick_script(
            &p(&self.part),
            &["refs/remotes/origin/main".into()],
            shas,
            "part",
        );
        parse_pick(&self.connection.run(&script, 60_000).await.stdout)
    }

    fn worktree(&self) {
        self.g.git(
            &self.clone,
            &[
                "worktree",
                "add",
                "-q",
                "-b",
                "part",
                &p(&self.part),
                "origin/main",
            ],
        );
    }
}

#[tokio::test]
async fn a_pick_already_in_the_target_is_skipped_and_said_a_real_conflict_stops() {
    let (g, clone) = engine(&[]);
    let same = g.commit(&clone, "pool/b.c", "b\n", "pool: add b", None);
    let next = g.commit(&clone, "pool/c.c", "c\n", "pool: add c", None);
    // The target holds b already, within a larger change.
    g.git(&clone, &["checkout", "-q", "-b", "target", "origin/main"]);
    g.commit(&clone, "pool/b.c", "b\n", "pool: b and more", None);
    let part = g.root.join("part");
    g.git(
        &clone,
        &["worktree", "add", "-q", "-b", "part", &p(&part), "target"],
    );
    let connection = g.connection(vec![], "local");
    let script = pick_script(
        &p(&part),
        &["refs/heads/target".into()],
        &[same.clone(), next],
        "part",
    );
    let pick = parse_pick(&connection.run(&script, 60_000).await.stdout);
    assert_eq!(pick.picked, 1);
    assert!(pick.files.is_empty());
    assert_eq!(pick.skipped, vec![same]);
    let on = pick.on_branch.clone().unwrap();
    assert_eq!(on.count, 1);
    assert_eq!(on.ids.len(), 1);
    assert!(matches("^[0-9a-f]{40}$", &on.ids[0]));
    assert!(pick.conflict.is_none() && pick.error.is_none() && pick.fold.is_none());
    assert_eq!(
        g.git(&part, &["log", "--format=%s", "-2"]).trim(),
        "pool: add c\npool: b and more"
    );
}

#[tokio::test]
async fn fixups_fold_into_their_targets_in_the_part_a_squash_adds_its_body_a_fixup_without_its_target_stays()
 {
    let f = PartFixture::new();
    let g = &f.g;
    g.commit(&f.clone, "pool/x.c", "x\n", "pool: add x", None);
    let a = g.commit(&f.clone, "pool/a.c", "a\n", "pool: add a", None);
    let b = g.commit(&f.clone, "pool/b.c", "b\n", "pool: add b", None);
    let fa = g.commit(
        &f.clone,
        "pool/a.c",
        "a fixed\n",
        "fixup! pool: add a",
        None,
    );
    let sb = g.commit(
        &f.clone,
        "pool/b.c",
        "b better\n",
        "squash! pool: add b\n\nAlso why b is better.",
        None,
    );
    let fx = g.commit(&f.clone, "pool/y.c", "y\n", "fixup! pool: add x", None);
    let shas = vec![a, b, fa, sb, fx];
    // The tree the picks make without folding, in a scratch worktree.
    let plain_dir = g.root.join("plain");
    g.git(
        &f.clone,
        &[
            "worktree",
            "add",
            "-q",
            "--detach",
            &p(&plain_dir),
            "origin/main",
        ],
    );
    for sha in &shas {
        g.git(&plain_dir, &["cherry-pick", sha]);
    }
    let plain = g
        .git(&plain_dir, &["rev-parse", "HEAD^{tree}"])
        .trim()
        .to_owned();
    f.worktree();
    let pick = f.run(&shas).await;
    assert_eq!(pick.picked, 5);
    assert!(pick.files.is_empty() && pick.skipped.is_empty());
    assert_eq!(pick.on_branch.as_ref().unwrap().count, 5);
    assert_eq!(
        pick.fold,
        Some(Fold {
            count: 3,
            same_tree: true,
            unfolded: vec!["fixup! pool: add x".into()]
        })
    );
    assert_eq!(g.git(&f.part, &["rev-parse", "HEAD^{tree}"]).trim(), plain);
    assert_eq!(
        g.git(
            &f.part,
            &["log", "--reverse", "--format=%s", "origin/main..HEAD"]
        )
        .trim(),
        "pool: add a\npool: add b\nfixup! pool: add x"
    );
    assert_eq!(
        g.git(&f.part, &["log", "-1", "--format=%B", "HEAD~2"])
            .trim(),
        "pool: add a"
    );
    assert_eq!(
        g.git(&f.part, &["log", "-1", "--format=%B", "HEAD~1"])
            .trim(),
        "pool: add b\n\nAlso why b is better."
    );
    // The Plans tab says the same before the part is made.
    let subjects = [
        "pool: add a",
        "pool: add b",
        "fixup! pool: add a",
        "squash! pool: add b",
        "fixup! pool: add x",
    ];
    let pairs: Vec<(String, String)> = subjects
        .iter()
        .enumerate()
        .map(|(i, s)| (shas[i].clone(), (*s).to_owned()))
        .collect();
    assert_eq!(
        fixup_targets(&pairs),
        vec![None, None, Some(0), Some(1), Some(-1)]
    );
}

#[tokio::test]
async fn folding_a_fixup_that_conflicts_stops_there_and_is_reported_nothing_aborted() {
    let f = PartFixture::new();
    let g = &f.g;
    let a = g.commit(&f.clone, "pool/a.c", "1\n", "pool: add a", None);
    let b = g.commit(&f.clone, "pool/a.c", "2\n", "pool: change a", None);
    let fa = g.commit(&f.clone, "pool/a.c", "3\n", "fixup! pool: add a", None);
    f.worktree();
    let result = f.run(&[a, b, fa]).await;
    let stopped = g
        .git(&f.part, &["rev-parse", "-q", "--verify", "REBASE_HEAD"])
        .trim()
        .to_owned();
    assert_eq!(result.picked, 3);
    assert_eq!(result.files, vec!["pool/a.c".to_owned()]);
    assert_eq!(
        result.folding,
        Some((stopped.clone(), "fixup! pool: add a".to_owned()))
    );
    assert!(result.fold.is_none());
    assert_eq!(
        g.git(&f.part, &["log", "-1", "--format=%s", &stopped])
            .trim(),
        "fixup! pool: add a"
    );
    // The view reads it as that part's stop.
    let stops = parse_part_stops(
        &f.connection
            .run(&part_stops_script(&[p(&f.part)]), 30_000)
            .await
            .stdout,
    );
    assert_eq!(
        stops.get(&p(&f.part)),
        Some(&Some(PartStop {
            sha: stopped,
            files: vec!["pool/a.c".into()],
            subject: Some("fixup! pool: add a".into()),
            folding: true,
        }))
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn a_part_folds_its_plans_fixups_says_the_ones_it_cannot_and_starts_from_an_upstream_branch_holding_the_plan()
 {
    let (g, clone) = engine(&[
        ("pool/x.c", "x\n", "pool: add x"),
        ("pool/a.c", "a\n", "pool: add a"),
        ("pool/b.c", "b\n", "pool: add b"),
        ("pool/a.c", "a fixed\n", "fixup! pool: add a"),
        ("pool/y.c", "y\n", "fixup! pool: add x"),
        ("pool/b.c", "b better\n", "fixup! pool: add b"),
    ]);
    // b and its fixup, already one commit on a local upstream branch.
    g.git(&clone, &["branch", "-q", "upstream/pool-b", "origin/main"]);
    g.git(&clone, &["checkout", "-q", "upstream/pool-b"]);
    let squashed = g.commit(&clone, "pool/b.c", "b better\n", "pool: add b", None);
    g.git(&clone, &["checkout", "-q", "big"]);
    let (env, made) = big_env(g, &clone, true);
    declare(&env, json!({"group": "g1", "source": "refs/heads/big"})).await;
    let shas = env.shas("Big");
    let (a, b, fa, fx, fb) = (&shas[1], &shas[2], &shas[3], &shas[4], &shas[5]);
    propose(&env, "Pool a", &[a, fa, fx], json!({})).await;
    propose(&env, "Pool b", &[b, fb], json!({})).await;
    // a and its fixup: one commit; x's fixup, its target not in the plan,
    // left as a commit and said.
    let part = env
        .ok("effort.part", json!({"id": "Big", "plan": "Pool a"}))
        .await;
    has(
        &part,
        json!({"ok": true, "branch": "pool-a", "picked": 3, "of": 3, "folded": 1}),
    );
    assert_eq!(
        part["unfolded"],
        json!([{"sha": fx, "subject": "fixup! pool: add x"}])
    );
    let made0 = made.lock().unwrap()[0].clone();
    assert_eq!(
        env.git(
            &made0,
            &["log", "--reverse", "--format=%s", "origin/main..HEAD"]
        )
        .trim(),
        "pool: add a\nfixup! pool: add x"
    );
    // A branch named by from that lacks the plan's changes: refused, nothing made.
    let refused = env
        .refused(
            "effort.part",
            json!({"id": "Big", "plan": "Pool b", "from": "pool-a"}),
        )
        .await;
    assert!(
        refused.contains("pool-a does not hold the plan's changes"),
        "{refused}"
    );
    assert_eq!(made.lock().unwrap().len(), 1);
    // upstream/pool-b holds b and its fixup: the part starts there.
    has(
        &env.ok("effort.part", json!({"id": "Big", "plan": "Pool b"}))
            .await,
        json!({"ok": true, "branch": "pool-b", "picked": 2, "of": 2, "from": "upstream/pool-b"}),
    );
    let made1 = made.lock().unwrap()[1].clone();
    assert_eq!(env.git(&made1, &["rev-parse", "HEAD"]).trim(), squashed);
    assert_eq!(
        env.git(&clone, &["rev-parse", "upstream/pool-b"]).trim(),
        squashed
    );
    has(
        &env.plan_of("Pool b").await["part"],
        json!({"branch": "pool-b", "from": "upstream/pool-b"}),
    );
    // Their commits count in a part though their patch ids changed.
    env.service.refresh(true).await;
    has(
        &env.summaries()[0],
        json!({"counts": {"in_part": 5, "unsorted": 1}}),
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn a_part_stacks_on_the_part_it_depends_on_or_fixes_refuses_fixups_of_a_plan_with_no_part_and_starts_from_a_port()
 {
    let (g, clone) = engine(&[
        ("pool/a.c", "a\n", "pool: add a"),
        ("pool/b.c", "b\nvoice\n", "pool: add b"),
        ("pool/c.c", "c\n", "pool: add c"),
        ("pool/a.c", "a fixed\n", "fixup! pool: add a"),
        ("pool/d.c", "d\n", "pool: add d"),
    ]);
    // b ported: its voice stripped, a note added, retitled; on the target.
    g.git(&clone, &["branch", "-q", "upstream/pool-b", "origin/main"]);
    g.git(&clone, &["checkout", "-q", "upstream/pool-b"]);
    g.commit(&clone, "pool/b.c", "b\n", "pool: add b, no voice", None);
    let port = g.commit(&clone, "docs/b.md", "b\n", "docs: b", None);
    // d's upstream branch is built on the source: not a port, d picked.
    g.git(&clone, &["checkout", "-q", "-b", "upstream/pool-d", "big"]);
    let on_source = g.commit(&clone, "pool/d.c", "d2\n", "pool: d again", None);
    g.git(&clone, &["checkout", "-q", "big"]);
    let (env, made) = big_env(g, &clone, false);
    declare(&env, json!({"group": "g1", "source": "refs/heads/big"})).await;
    let shas = env.shas("Big");
    let plan = |name: &str, commit: &String, depends: Option<Value>| {
        let mut params = obj(
            json!({"id": "Big", "action": "propose", "plan": name, "commits": [commit], "by": "agent"}),
        );
        if let Some(depends) = depends {
            params.insert("depends_on".into(), depends);
        }
        Value::Object(params)
    };
    env.ok("ledger.plans", plan("Pool a", &shas[0], None)).await;
    env.ok("ledger.plans", plan("Pool b", &shas[1], None)).await;
    env.ok(
        "ledger.plans",
        plan("Pool c", &shas[2], Some(json!(["Pool a"]))),
    )
    .await;
    env.ok("ledger.plans", plan("Fix a", &shas[3], None)).await;
    env.ok("ledger.plans", plan("Pool d", &shas[4], None)).await;
    for name in ["Pool a", "Pool b", "Pool c", "Fix a", "Pool d"] {
        env.ok(
            "ledger.plans",
            json!({"id": "Big", "action": "accept", "plan": name}),
        )
        .await;
    }
    let part = |name: &str| json!({"id": "Big", "plan": name});
    let made_at = |n: usize| made.lock().unwrap()[n].clone();
    // Only fixups of Pool a's commit: refused while Pool a has no part.
    let refused = env.refused("effort.part", part("Fix a")).await;
    assert!(
        refused.contains("Fix a only fixes commits of Pool a: make the part of Pool a first"),
        "{refused}"
    );
    assert!(made.lock().unwrap().is_empty());
    has(
        &env.ok("effort.part", part("Pool a")).await,
        json!({"ok": true, "picked": 1}),
    );
    let pool_a = env.git(&clone, &["rev-parse", "pool-a"]).trim().to_owned();
    // Pool c depends on Pool a: on its part's branch.
    has(
        &env.ok("effort.part", part("Pool c")).await,
        json!({"ok": true, "picked": 1, "base": "pool-a"}),
    );
    assert_eq!(
        env.git(&made_at(1), &["log", "--format=%s", "pool-a..HEAD"])
            .trim(),
        "pool: add c"
    );
    assert_eq!(
        env.git(&made_at(1), &["merge-base", "HEAD", "pool-a"])
            .trim(),
        pool_a
    );
    // Fix a, now Pool a has its part: on it, the fixup a commit there.
    has(
        &env.ok("effort.part", part("Fix a")).await,
        json!({"ok": true, "picked": 1, "base": "pool-a"}),
    );
    assert_eq!(
        env.git(&made_at(2), &["log", "--format=%s", "pool-a..HEAD"])
            .trim(),
        "fixup! pool: add a"
    );
    // upstream/pool-b is a port of Pool b on the target: used, said so,
    // nothing of the source picked, the branch left as it is.
    has(
        &env.ok("effort.part", part("Pool b")).await,
        json!({
            "ok": true, "picked": 0, "of": 1, "from": "upstream/pool-b", "ported": true,
            "differs": {"only_in_plan": [], "only_in_branch": ["docs/b.md"]},
        }),
    );
    assert_eq!(env.git(&made_at(3), &["rev-parse", "HEAD"]).trim(), port);
    assert_eq!(
        env.git(&clone, &["rev-parse", "upstream/pool-b"]).trim(),
        port
    );
    has(
        &env.plan_of("Pool b").await["part"],
        json!({"from": "upstream/pool-b", "ported": true}),
    );
    has(
        &env.plan_of("Pool c").await["part"],
        json!({"base": "pool-a"}),
    );
    // upstream/pool-d holds the source's commits: no port, d picked.
    has(
        &env.ok("effort.part", part("Pool d")).await,
        json!({"ok": true, "picked": 1}),
    );
    assert!(
        env.refused("effort.part", part("Pool d"))
            .await
            .contains("has its part already")
    );
    assert_eq!(
        env.git(&made_at(4), &["log", "--format=%s", "origin/main..HEAD"])
            .trim(),
        "pool: add d"
    );
    assert_eq!(
        env.git(&clone, &["rev-parse", "upstream/pool-d"]).trim(),
        on_source
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn a_part_moved_by_hand_is_refreshed_from_its_branch_one_gone_is_refused_then_attached_with_from()
 {
    let (g, clone) = engine(&[
        ("pool/a.c", "a\n", "pool: add a"),
        ("pool/b.c", "b\nvoice\n", "pool: add b"),
        ("pool/b.c", "b\nvoice fixed\n", "fixup! pool: add b"),
        ("pool/z.c", "z\n", "fixup! pool: add z"),
        ("pool/c.c", "c\n", "pool: add c"),
    ]);
    let (env, made) = big_env(g, &clone, false);
    declare(&env, json!({"group": "g1", "source": "refs/heads/big"})).await;
    let shas = env.shas("Big");
    propose(&env, "Pool a", &[&shas[0]], json!({})).await;
    propose(
        &env,
        "Pool b",
        &[&shas[1], &shas[2], &shas[3]],
        json!({"depends_on": ["Pool a"]}),
    )
    .await;
    propose(&env, "Pool c", &[&shas[4]], json!({})).await;
    let part = |plan: &str, extra: Value| {
        let mut params = obj(json!({"id": "Big", "plan": plan}));
        params.extend(obj(extra));
        Value::Object(params)
    };
    has(
        &env.ok("effort.part", part("Pool a", json!({}))).await,
        json!({"ok": true}),
    );
    has(
        &env.ok("effort.part", part("Pool b", json!({}))).await,
        json!({"ok": true, "base": "pool-a", "folded": 1}),
    );
    has(
        &env.ok("effort.part", part("Pool c", json!({}))).await,
        json!({"ok": true}),
    );
    let pool_b = made.lock().unwrap()[1].clone();
    // Pool b ported by hand on pool-a: its voice stripped, a note added;
    // its part's branch moved onto it.
    env.git(&clone, &["branch", "-q", "upstream/pool-b", "pool-a"]);
    env.git(&clone, &["checkout", "-q", "upstream/pool-b"]);
    env.g
        .commit(&clone, "pool/b.c", "b\n", "pool: add b, no voice", None);
    let port = env.g.commit(&clone, "docs/b.md", "b\n", "docs: b", None);
    env.git(&clone, &["checkout", "-q", "big"]);
    env.git(&pool_b, &["reset", "-q", "--keep", &port]);
    let stale = env.plan_of("Pool b").await;
    assert!(stale["part"].get("from").is_none() && stale["part"].get("ported").is_none());
    let state = || {
        let mut out = vec![
            env.git(
                &clone,
                &["for-each-ref", "--format=%(refname) %(objectname)"],
            ),
            env.git(&clone, &["worktree", "list", "--porcelain"]),
        ];
        for path in made.lock().unwrap().iter() {
            out.push(env.git(path, &["status", "--porcelain"]));
        }
        out
    };
    let before = state();
    let refreshed = env
        .ok("effort.part", part("Pool b", json!({"refresh": true})))
        .await;
    has(
        &refreshed,
        json!({
            "ok": true, "refreshed": true, "path": p(&pool_b), "branch": "pool-b", "sha": port,
            "from": "upstream/pool-b", "ported": true, "base": "pool-a",
            "differs": {"only_in_plan": ["pool/z.c"], "only_in_branch": ["docs/b.md"]},
        }),
    );
    // Nothing moved, nothing made: only the record.
    assert_eq!(state(), before);
    assert_eq!(made.lock().unwrap().len(), 3);
    let got = env.ok("effort.get", json!({"id": "Big"})).await;
    let after = got["plans"]
        .as_array()
        .unwrap()
        .iter()
        .find(|plan| plan["name"] == "Pool b")
        .unwrap()
        .clone();
    has(
        &after["part"],
        json!({
            "path": p(&pool_b), "branch": "pool-b", "from": "upstream/pool-b", "ported": true, "base": "pool-a", "unfolded": [],
        }),
    );
    let journal = got["journal"].as_array().unwrap().last().unwrap().clone();
    assert_eq!(
        journal["summary"],
        "Part pool-b of Pool b refreshed (from upstream/pool-b, on pool-a, ported)"
    );
    // Undo puts the record back as it was.
    env.ok(
        "ledger.undo",
        json!({"id": "Big", "journal": journal["id"]}),
    )
    .await;
    assert_eq!(env.plan_of("Pool b").await["part"], stale["part"]);
    // Pool c's worktree and branch gone: refused, saying so, nothing changed.
    let pool_c = made.lock().unwrap()[2].clone();
    env.git(&clone, &["worktree", "remove", "--force", &p(&pool_c)]);
    env.git(&clone, &["branch", "-q", "-D", "pool-c"]);
    let gone = env
        .refused("effort.part", part("Pool c", json!({"refresh": true})))
        .await;
    assert!(
        matches(
            r"Pool c's part cannot be read: its worktree .* is gone, and so is its branch pool-c\. Give from",
            &gone
        ),
        "{gone}"
    );
    let nowhere = env
        .refused(
            "effort.part",
            part("Pool c", json!({"refresh": true, "from": "nowhere"})),
        )
        .await;
    assert!(
        nowhere.contains("nowhere is not a local branch of the clone"),
        "{nowhere}"
    );
    // Attached to an existing branch in its own worktree: no worktree made.
    let again = env.g.root.join("c-again");
    env.git(
        &clone,
        &["worktree", "add", "-q", "-b", "c-again", &p(&again), "big"],
    );
    let c_again = env.git(&clone, &["rev-parse", "c-again"]).trim().to_owned();
    has(
        &env.ok(
            "effort.part",
            part("Pool c", json!({"refresh": true, "from": "c-again"})),
        )
        .await,
        json!({"refreshed": true, "attached": "existing", "path": p(&again), "branch": "c-again"}),
    );
    assert_eq!(made.lock().unwrap().len(), 3);
    assert_eq!(env.git(&clone, &["rev-parse", "c-again"]).trim(), c_again);
    // A branch with no worktree: one made at a free path, the branch not moved.
    env.git(&clone, &["worktree", "remove", "--force", &p(&again)]);
    env.git(&clone, &["branch", "-q", "c-later", "big"]);
    let later = env.git(&clone, &["rev-parse", "c-later"]).trim().to_owned();
    let attached = env
        .ok(
            "effort.part",
            part("Pool c", json!({"refresh": true, "from": "c-later"})),
        )
        .await;
    has(
        &attached,
        json!({"refreshed": true, "attached": "made", "branch": "c-later", "sha": later}),
    );
    assert_eq!(made.lock().unwrap().len(), 4);
    let made3 = p(&made.lock().unwrap()[3]);
    assert_eq!(attached["path"], json!(made3));
    assert_eq!(env.git(&clone, &["rev-parse", "c-later"]).trim(), later);
    has(
        &env.plan_of("Pool c").await["part"],
        json!({"branch": "c-later", "path": made3}),
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn a_duplicate_effort_deleted_by_id_only_the_others_ledger_kept_its_declaration_back_restores_it()
 {
    let (g, clone) = engine(&[
        ("pool/a.c", "a\n", "pool: add a"),
        ("pool/b.c", "b\n", "pool: add b"),
    ]);
    let (env, _) = big_env(g, &clone, false);
    env.upstream.refresh(true).await;
    // The same branch declared twice: two efforts named Big, the same commits.
    let mut ids = Vec::new();
    for _ in 0..2 {
        let declared = env
            .ok(
                "effort.set",
                json!({"group": "g1", "source": "refs/heads/big"}),
            )
            .await;
        ids.push(declared["effort"]["id"].as_str().unwrap().to_owned());
    }
    let (kept, duplicate) = (ids[0].clone(), ids[1].clone());
    assert_ne!(kept, duplicate);
    env.service.refresh(true).await;
    let shas = env.shas(&kept);
    // Each marks a different commit (same patch ids in both).
    env.ok(
        "ledger.set",
        json!({"id": kept, "commits": [shas[1]], "disposition": "not_for_upstream", "reason": "debug only"}),
    )
    .await;
    env.ok(
        "ledger.set",
        json!({"id": duplicate, "commits": [shas[0]], "disposition": "superseded", "pointer": "elsewhere"}),
    )
    .await;
    env.ok(
        "ledger.plans",
        json!({"id": kept, "action": "propose", "name": "Pool a", "commits": [shas[0]]}),
    )
    .await;
    let branches = env.git(&clone, &["branch", "--list"]).trim().to_owned();
    let before = env.settings.lock().unwrap().clone();
    // A name both have deletes neither.
    let both = env
        .refused("effort.delete", json!({"effort": "big", "by": "agent"}))
        .await;
    assert!(
        both.contains("several efforts are named Big: give its id"),
        "{both}"
    );
    assert_eq!(env.efforts().len(), 2);
    let done = env
        .ok("effort.delete", json!({"effort": duplicate, "by": "agent"}))
        .await;
    assert_eq!(done["effort"], json!({"id": duplicate, "name": "Big"}));
    assert_eq!(
        env.efforts()
            .iter()
            .map(|e| e["id"].clone())
            .collect::<Vec<_>>(),
        vec![json!(kept)]
    );
    // The other effort's ledger and plans, untouched; no branch moved.
    env.service.refresh(true).await;
    let cards = env.summaries();
    assert_eq!(cards.len(), 1);
    assert_eq!(
        cards[0]["counts"],
        json!({"planned": 1, "not_for_upstream": 1})
    );
    assert_eq!(cards[0]["plans"], json!({"proposed": 1, "accepted": 0}));
    assert_eq!(env.git(&clone, &["branch", "--list"]).trim(), branches);
    // Its declaration back (what the order's Undo saves): its own marks.
    *env.settings.lock().unwrap() = before;
    env.service.refresh(true).await;
    let cards = env.summaries();
    let back = cards
        .iter()
        .find(|each| each["id"] == json!(duplicate))
        .unwrap();
    assert_eq!(back["counts"], json!({"unsorted": 1, "superseded": 1}));
    let other = cards.iter().find(|each| each["id"] == json!(kept)).unwrap();
    assert_eq!(
        other["counts"],
        json!({"planned": 1, "not_for_upstream": 1})
    );
    assert!(
        env.refused("effort.delete", json!({"effort": "nope"}))
            .await
            .contains("no such effort")
    );
}

#[test]
fn what_a_part_holds_is_read_back_from_its_branch_never_taken_from_the_pick() {
    // One commit with a diff and one empty: only what the branch holds.
    let commits = vec!["p1".to_owned(), "sha:e1".to_owned()];
    let on = |count, ids: &[&str]| OnBranch {
        count,
        ids: ids.iter().map(|s| (*s).to_owned()).collect(),
    };
    assert_eq!(picked_on_branch(&commits, &on(2, &["p1"])), 2);
    assert_eq!(picked_on_branch(&commits, &on(1, &["p1"])), 1);
    assert_eq!(picked_on_branch(&commits, &on(1, &["other"])), 0);
    assert_eq!(picked_on_branch(&commits, &on(0, &[])), 0);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_part_never_goes_into_an_existing_worktree_or_onto_an_existing_branch() {
    let (g, clone) = engine(&[
        ("pool/a.c", "a\n", "pool: add a"),
        ("pool/b.c", "b\n", "pool: add b"),
    ]);
    // A layer of the stack already has b, in its own worktree at the path
    // the part's branch would get.
    let layer = g.root.join("pool-b");
    g.git(
        &clone,
        &["worktree", "add", "-q", "-b", "layer", &p(&layer), "big"],
    );
    let layer_head = g.git(&layer, &["rev-parse", "HEAD"]).trim().to_owned();
    // As git recworktree does: the branch made, an existing checkout at
    // the path taken as done, and that path given back.
    let create: Create = {
        let root = g.root.clone();
        let clone = clone.clone();
        Arc::new(move |input: &Obj| {
            let home = root.join("home");
            let branch = js::sv(input.get("branch"));
            let path = root.join(branch);
            run_git(&home, &clone, &["branch", branch, "origin/main"])?;
            let listed = run_git(&home, &clone, &["worktree", "list", "--porcelain"])?;
            if !listed.contains(&format!("worktree {}\n", p(&path))) {
                run_git(&home, &clone, &["worktree", "add", "-q", &p(&path), branch])?;
            }
            Ok(obj(json!({"path": p(&path)})))
        })
    };
    let env = Env::new(
        g,
        group_tree(json!({"connection_id": "local", "label": "big"})),
        Some(create),
        false,
    );
    env.connection.add("w1", "big", &clone, None);
    declare(&env, json!({"group": "g1", "source": "refs/heads/big"})).await;
    let b = env.shas("Big")[1].clone();
    propose(&env, "Pool b", &[&b], json!({})).await;
    // An existing branch is refused before anything is made.
    let taken = env
        .refused(
            "effort.part",
            json!({"id": "Big", "plan": "Pool b", "branch": "layer"}),
        )
        .await;
    assert!(taken.contains("branch layer exists already"), "{taken}");
    // The path held the layer's worktree: refused, nothing picked or moved.
    let held = env
        .refused("effort.part", json!({"id": "Big", "plan": "Pool b"}))
        .await;
    assert!(
        held.contains("not a new worktree on pool-b (it is on layer)"),
        "{held}"
    );
    assert_eq!(env.git(&layer, &["rev-parse", "HEAD"]).trim(), layer_head);
    assert_eq!(
        env.git(&layer, &["symbolic-ref", "HEAD"]).trim(),
        "refs/heads/layer"
    );
    assert!(env.placed.lock().unwrap().is_empty());
    assert!(env.plan_of("Pool b").await.get("part").is_none());
}

#[tokio::test(flavor = "multi_thread")]
async fn a_clone_kept_in_a_repository_directory_parts_start_from_its_checkout_and_a_repository_with_no_checkout_is_named()
 {
    let g = GitFixture::new();
    g.project("media/engine");
    // The clone as gstreamer.git is: the checkout's `.git` is a file naming
    // the repository directory beside it, whose `gitdir` file names the
    // checkout back; `git worktree list` names the repository first, with no
    // work tree of its own, so work-tree commands fail there.
    let clones = g.root.join("clones");
    std::fs::create_dir_all(&clones).unwrap();
    let git_dir = clones.join("engine.git");
    let clone = clones.join("engine");
    g.git(
        &clones,
        &[
            "clone",
            "-q",
            "--separate-git-dir",
            &p(&git_dir),
            &format!("https://{FORGE_HOST}/media/engine.git"),
            &p(&clone),
        ],
    );
    std::fs::write(git_dir.join("gitdir"), format!("{}/.git\n", p(&clone))).unwrap();
    g.git(&clone, &["remote", "set-head", "origin", "main"]);
    g.git(&clone, &["checkout", "-q", "-b", "big"]);
    g.commit(&clone, "pool/a.c", "a\n", "pool: add a", None);
    g.commit(&clone, "pool/b.c", "b\n", "pool: add b", None);
    g.commit(&clone, "pool/c.c", "c\n", "pool: add c", None);
    g.git(&clone, &["checkout", "-q", "main"]);
    // The effort's head: a linked worktree beside the clone, alone in its
    // group; the checkout itself has no workspace.
    let head = clones.join("engine.worktrees").join("big");
    g.git(&clone, &["worktree", "add", "-q", &p(&head), "big"]);
    assert_eq!(
        g.git(&head, &["worktree", "list", "--porcelain"])
            .split('\n')
            .next()
            .unwrap(),
        format!("worktree {}", p(&git_dir))
    );
    let slot: Slot = Arc::default();
    // As the worktree path does: work-tree commands where the worktree
    // starts from (a repository directory refuses them) and, as Herdr,
    // never from a linked worktree.
    let create: Create = {
        let slot = slot.clone();
        let root = g.root.clone();
        let clones = clones.clone();
        Arc::new(move |input: &Obj| {
            let home = root.join("home");
            let connection = slot.lock().unwrap().clone().unwrap();
            let from = match input.get("cwd").and_then(Value::as_str) {
                Some(cwd) => cwd.to_owned(),
                None => connection
                    .workspaces
                    .lock()
                    .unwrap()
                    .iter()
                    .find(|w| Some(&w["workspace_id"]) == input.get("workspaceId"))
                    .map(|w| js::sv(w.get("cwd")).to_owned())
                    .unwrap_or_default(),
            };
            let top = run_git(&home, Path::new(&from), &["rev-parse", "--show-toplevel"])?;
            let dirs = run_git(
                &home,
                Path::new(&from),
                &[
                    "rev-parse",
                    "--path-format=absolute",
                    "--git-dir",
                    "--git-common-dir",
                ],
            )?;
            let dirs: Vec<&str> = dirs.trim().split('\n').collect();
            if dirs.first() != dirs.get(1) {
                return Err("linked_worktree_source: New and open worktree actions start from the repo parent workspace.".into());
            }
            let branch = js::sv(input.get("branch"));
            let path = clones.join("engine.worktrees").join(branch);
            run_git(
                &home,
                Path::new(top.trim()),
                &[
                    "worktree",
                    "add",
                    "-q",
                    "-b",
                    branch,
                    &p(&path),
                    "origin/main",
                ],
            )?;
            Ok(obj(json!({"path": p(&path)})))
        })
    };
    let env = Env::new(
        g,
        group_tree(json!({"connection_id": "local", "path": p(&head)})),
        Some(create),
        false,
    );
    *slot.lock().unwrap() = Some(env.connection.clone());
    env.connection.add(
        "w2",
        "big",
        &head,
        Some(
            json!({"checkout_path": p(&head), "is_linked_worktree": true, "repo_key": p(&git_dir)}),
        ),
    );
    // The main checkout from a worktree, the checkout or the repository
    // itself; a plain clone's as before; none where there is no repository.
    let checkout =
        |repository: &Path, checkout: Option<&Path>| Some((p(repository), checkout.map(p)));
    for at in [&head, &clone, &git_dir] {
        assert_eq!(
            main_checkout(&*env.connection, &p(at)).await,
            checkout(&git_dir, Some(&clone))
        );
    }
    let plain = GitFixture::clone(&env.g, "media/engine", "plain");
    assert_eq!(
        main_checkout(&*env.connection, &p(&plain)).await,
        checkout(&plain.join(".git"), Some(&plain))
    );
    assert_eq!(
        main_checkout(&*env.connection, &p(&env.g.root.join("nowhere"))).await,
        None
    );
    declare(
        &env,
        json!({"group": "g1", "source": "refs/heads/big", "head": p(&head)}),
    )
    .await;
    let shas = env.shas("Big");
    for (name, sha) in [
        ("Pool a", &shas[0]),
        ("Pool b", &shas[1]),
        ("Pool c", &shas[2]),
    ] {
        propose(&env, name, &[sha], json!({})).await;
    }
    // No workspace on the checkout: the part starts from its path, found
    // through the repository's gitdir file, and is a worktree of that repository.
    has(
        &env.ok(
            "effort.part",
            json!({"id": "Big", "plan": "Pool a", "branch": "pool-a"}),
        )
        .await,
        json!({"ok": true, "picked": 1}),
    );
    assert_eq!(
        Value::Object(env.calls.lock().unwrap()[0].clone()),
        json!({"connectionId": "local", "branch": "pool-a", "cwd": p(&clone)})
    );
    assert_eq!(
        env.git(
            &clones.join("engine.worktrees").join("pool-a"),
            &["rev-parse", "--path-format=absolute", "--git-common-dir"]
        )
        .trim(),
        p(&git_dir)
    );
    // A workspace open on the checkout (its repository not described by Herdr
    // yet): the part starts from that workspace.
    env.connection.add(
        "w1",
        "engine",
        &clone,
        Some(json!({"checkout_path": p(&clone)})),
    );
    has(
        &env.ok(
            "effort.part",
            json!({"id": "Big", "plan": "Pool b", "branch": "pool-b"}),
        )
        .await,
        json!({"ok": true, "picked": 1}),
    );
    assert_eq!(
        Value::Object(env.calls.lock().unwrap()[1].clone()),
        json!({"connectionId": "local", "branch": "pool-b", "workspaceId": "w1"})
    );
    // The checkout gone: the repository has none of its own, and the refusal
    // names it instead of asking for a main checkout there is none of.
    env.connection.workspaces.lock().unwrap().pop();
    std::fs::remove_dir_all(&clone).unwrap();
    assert_eq!(
        main_checkout(&*env.connection, &p(&head)).await,
        checkout(&git_dir, None)
    );
    let refused = env
        .refused(
            "effort.part",
            json!({"id": "Big", "plan": "Pool c", "branch": "pool-c"}),
        )
        .await;
    assert!(
        refused.contains(&format!(
            "the repository {} has no checkout of its own (no gitdir file naming one, no core.worktree, nothing beside it without .git): worktrees start from a checkout",
            p(&git_dir)
        )),
        "{refused}"
    );
    assert_eq!(env.calls.lock().unwrap().len(), 2);
}

#[tokio::test(flavor = "multi_thread")]
async fn an_effort_s_leader_is_its_head_workspace_s_conversation_session_even_stopped() {
    let (g, clone) = engine(&[("pool/a.c", "a\n", "pool: add a")]);
    let env = Env::new(
        g,
        group_tree(json!({"connection_id": "local", "label": "big"})),
        None,
        false,
    );
    env.connection.add("w1", "big", &clone, None);
    // Conversation mode holds w1:p1, its process stopped: Herdr sees only
    // the holder there (agent.get: not found).
    *env.connection.held.lock().unwrap() = Some(("w1:p1".into(), "held-session".into()));
    env.upstream.refresh(true).await;
    let id = env
        .ok(
            "effort.set",
            json!({"group": "g1", "source": "refs/heads/big"}),
        )
        .await["effort"]["id"]
        .clone();
    assert_eq!(
        env.ok("effort.leader", json!({"id": id})).await,
        json!({"state": "ready", "connectionId": "local", "workspaceId": "w1", "paneId": "w1:p1"})
    );
    // Given back to the terminal and no agent there: a pane to start one in.
    *env.connection.held.lock().unwrap() = None;
    assert_eq!(
        env.ok("effort.leader", json!({"id": id})).await,
        json!({"state": "none", "connectionId": "local", "workspaceId": "w1"})
    );
}
