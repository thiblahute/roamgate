//! actions.test.ts, case for case, on a fake host. What the TS runs for
//! real behind the runtime (settings.json, `inspectWorkspacePath`, the
//! shared worktree flow, `git rev-parse`) is Bun's side of the host here,
//! so the fake answers as those would; `jest.useFakeTimers` is the test
//! clock; `toBe(result)` on a second execution is equality, the first
//! execution's result.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use futures_util::future::join_all;
use roamgate_agents::js;
use roamgate_base::clock::TestClock;
use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;

use super::Prepared;
use crate::context::fake::{CallCtx, Conn, Deferred, Fake, Reply, default_worktree, fail, flush};
use crate::context::live::{BeforeSend, ContextHost, LiveContext};
use crate::context::{AssistantContext, Authorized, CapturedScope, Scope};
use crate::errors::{AssistantError, AssistantResult};
use crate::tools::BoxFuture;

const MUTATING: [&str; 8] = [
    "workspace.create",
    "worktree.create",
    "tab.create",
    "pane.split",
    "agent.start",
    "agent.prompt",
    "pane.close",
    "workspace.close",
];

fn find_index(items: &[Value], key: &str, value: &Value) -> Option<usize> {
    items.iter().position(|item| item.get(key) == Some(value))
}

fn create_pane(conn: &mut Conn, cwd: Value, tab_id: &str) -> Value {
    let workspace_id = conn.main_pane.split(':').next().unwrap().to_owned();
    let pane = json!({
        "workspace_id": workspace_id,
        "pane_id": format!("{workspace_id}:p{}", conn.panes.len() + 1),
        "tab_id": tab_id,
        "terminal_id": format!("term{}", conn.panes.len() + 1),
        "cwd": cwd,
        "agent": null,
    });
    conn.panes.push(pane.clone());
    pane
}

/// actions.test.ts's Herdr.
fn herdr(conn: &mut Conn, method: &str, params: &Value) -> AssistantResult<Value> {
    if MUTATING.contains(&method) {
        conn.mutations.push(method.to_owned());
    }
    let workspace_id = conn.main_pane.split(':').next().unwrap().to_owned();
    Ok(match method {
        "workspace.get" => {
            match find_index(&conn.workspaces, "workspace_id", &params["workspace_id"]) {
                Some(index) => json!({ "workspace": conn.workspaces[index] }),
                None => json!({}),
            }
        }
        "workspace.list" => json!({ "workspaces": conn.workspaces }),
        "pane.list" => json!({ "panes": conn.panes }),
        "tab.list" => json!({ "tabs": conn.tabs }),
        "pane.get" => match find_index(&conn.panes, "pane_id", &params["pane_id"]) {
            Some(index) => json!({ "pane": conn.panes[index] }),
            None => json!({}),
        },
        "agent.get" => {
            if !conn.agent["agent"]
                .as_str()
                .is_some_and(|agent| !agent.is_empty())
            {
                return fail("agent_not_found: No agent matched the pane");
            }
            json!({ "agent": conn.agent })
        }
        "pane.process_info" => json!({
            "type": "pane_process_info",
            "process_info": if params["pane_id"] == json!(conn.main_pane) {
                conn.process.clone()
            } else {
                json!({
                    "pane_id": params["pane_id"],
                    "shell_pid": 303,
                    "foreground_process_group_id": 303,
                    "foreground_processes": [{ "pid": 303, "name": "shell" }],
                })
            },
        }),
        "pane.close" | "workspace.close" => {
            let (key, value) = if method == "workspace.close" {
                ("workspace_id", &params["workspace_id"])
            } else {
                ("pane_id", &params["pane_id"])
            };
            conn.panes.retain(|pane| pane.get(key) != Some(value));
            let panes = conn.panes.clone();
            conn.tabs
                .retain(|tab| panes.iter().any(|pane| pane["tab_id"] == tab["tab_id"]));
            conn.workspaces.retain(|workspace| {
                panes
                    .iter()
                    .any(|pane| pane["workspace_id"] == workspace["workspace_id"])
            });
            json!({ "type": "ok" })
        }
        "server.agent_manifests" => json!({ "manifests": [{ "agent": "pi" }] }),
        "worktree.list" => json!({ "worktrees": conn.worktrees }),
        "workspace.create" => {
            let workspace =
                json!({ "workspace_id": "w2", "label": params["label"], "cwd": params["cwd"] });
            conn.workspaces.push(workspace.clone());
            conn.panes.push(json!({
                "workspace_id": "w2",
                "pane_id": "w2:p1",
                "terminal_id": "term2",
                "cwd": params["cwd"],
            }));
            json!({ "type": "workspace_created", "workspace": workspace })
        }
        "tab.create" => {
            let tab = json!({
                "workspace_id": params["workspace_id"],
                "tab_id": format!("{workspace_id}:t{}", conn.tabs.len() + 1),
                "label": "Tab",
            });
            conn.tabs.push(tab.clone());
            let tab_id = tab["tab_id"].as_str().unwrap().to_owned();
            let root_pane = create_pane(conn, params["cwd"].clone(), &tab_id);
            json!({ "type": "tab_created", "tab": tab, "root_pane": root_pane })
        }
        "pane.split" => {
            let index = find_index(&conn.panes, "pane_id", &params["target_pane_id"]).unwrap();
            let tab_id = conn.panes[index]["tab_id"].as_str().unwrap().to_owned();
            let pane = create_pane(conn, params["cwd"].clone(), &tab_id);
            json!({ "type": "pane_info", "pane": pane })
        }
        "agent.start" => {
            for (key, value) in [
                ("agent", params["kind"].clone()),
                ("name", params["name"].clone()),
                ("agent_status", json!("idle")),
                ("interactive_ready", json!(true)),
            ] {
                conn.agent[key] = value;
            }
            conn.panes[0]["agent"] = params["kind"].clone();
            conn.process["foreground_process_group_id"] = json!(202);
            conn.process["foreground_processes"] = json!([{ "pid": 202, "name": params["kind"] }]);
            json!({ "type": "agent_started", "agent": conn.agent })
        }
        "agent.prompt" => {
            json!({ "type": "agent_prompted", "agent": conn.agent, "secret": "private-key" })
        }
        _ => return fail(&format!("Unexpected method {method}")),
    })
}

fn same_ref() -> Value {
    json!({ "connection_id": "local", "workspace_id": "w1" })
}

fn merged(base: &Value, extra: Value) -> Value {
    let mut out = base.clone();
    for (key, value) in extra.as_object().unwrap() {
        out[key] = value.clone();
    }
    out
}

struct A {
    fake: Arc<Fake>,
    context: LiveContext,
    clock: TestClock,
    _dir: tempfile::TempDir,
    root: String,
    workspace_id: String,
}

fn fixture() -> A {
    fixture_for("w1:p1")
}

fn fixture_for(pane_id: &str) -> A {
    let dir = tempfile::tempdir().unwrap();
    let root = roamgate_base::paths::realpath(dir.path())
        .unwrap()
        .to_string_lossy()
        .into_owned();
    let workspace_id = pane_id.split(':').next().unwrap().to_owned();
    let mut conn = Conn::new(7);
    conn.main_pane = pane_id.to_owned();
    conn.root = root.clone();
    conn.workspaces = vec![json!({ "workspace_id": workspace_id, "label": "Source", "cwd": root })];
    conn.panes = vec![json!({
        "connection_id": "local",
        "workspace_id": workspace_id,
        "pane_id": pane_id,
        "tab_id": format!("{workspace_id}:t1"),
        "terminal_id": "term1",
        "cwd": root,
        "focused": true,
        "agent": null,
        "agent_session": null,
    })];
    let mut agent = conn.panes[0].clone();
    agent["name"] = Value::Null;
    agent["launch_pending"] = json!(false);
    conn.agent = agent;
    conn.process = json!({
        "pane_id": pane_id,
        "shell_pid": 101,
        "foreground_process_group_id": 101,
        "foreground_processes": [{ "pid": 101, "name": "shell" }],
    });
    conn.tabs = vec![json!({
        "workspace_id": workspace_id,
        "tab_id": format!("{workspace_id}:t1"),
        "label": "Source",
    })];
    let fake = Fake::new(herdr);
    fake.add("local", "Local", conn);
    let clock = TestClock::new(js::date_parse("2026-11-09T00:00:00Z") as i64);
    let context = LiveContext::new(fake.clone(), Arc::new(clock.clone()));
    A {
        fake,
        context,
        clock,
        _dir: dir,
        root,
        workspace_id,
    }
}

impl A {
    fn conn<T>(&self, f: impl FnOnce(&mut Conn) -> T) -> T {
        self.fake.with("local", f)
    }

    fn mutations(&self) -> Vec<String> {
        self.fake.mutations("local")
    }

    fn retire(&self) {
        self.fake.retire("local");
    }

    fn reference(&self) -> Value {
        json!({ "connection_id": "local", "workspace_id": self.workspace_id })
    }

    fn set_setup(&self, setup: Option<&str>) {
        self.conn(|conn| conn.setup = setup.map(str::to_owned));
    }

    fn use_agent(&self) {
        self.conn(|conn| {
            let session =
                json!({ "source": "herdr:pi", "agent": "pi", "kind": "id", "value": "session1" });
            conn.agent["agent"] = json!("pi");
            conn.agent["name"] = json!("Worker");
            conn.agent["agent_session"] = session.clone();
            conn.panes[0]["agent"] = json!("pi");
            conn.panes[0]["agent_session"] = session;
            conn.process["foreground_process_group_id"] = json!(202);
            conn.process["foreground_processes"] = json!([{ "pid": 202, "name": "pi" }]);
        });
    }

    fn add_sibling(&self) {
        let root = self.root.clone();
        self.conn(|conn| create_pane(conn, json!(root), "w1:t1"));
    }

    fn calls_of(&self, method: &str) -> Vec<(Value, u64)> {
        self.conn(|conn| {
            conn.calls
                .iter()
                .filter(|(m, ..)| m == method)
                .map(|(_, params, timeout)| (params.clone(), *timeout))
                .collect()
        })
    }

    fn called_with(&self, method: &str, params: Value, timeout: u64) -> bool {
        self.calls_of(method).contains(&(params, timeout))
    }

    async fn scope(&self) -> Scope {
        self.context
            .capture_scope(json!([self.reference()]), None, None)
            .await
            .unwrap()
    }

    async fn prepare_with(
        &self,
        kind: &str,
        params: Value,
        signal: Option<CancellationToken>,
    ) -> AssistantResult<Prepared> {
        let scope = self.scope().await;
        let params = merged(&self.reference(), params);
        self.context.prepare(kind, &scope, params, signal).await
    }

    async fn prepare(&self, kind: &str, params: Value) -> AssistantResult<Prepared> {
        self.prepare_with(kind, params, None).await
    }

    /// `call.mockImplementation(...)` around the fixture's own.
    fn over(&self, f: impl Fn(CallCtx) -> Reply + Send + Sync + 'static) {
        self.fake.over("local", f);
    }
}

fn status(result: &Value) -> &str {
    result["status"].as_str().unwrap()
}

fn detail(result: &Value) -> &str {
    result["detail"].as_str().unwrap()
}

fn ready(result: AssistantResult<Value>) -> Reply {
    Box::pin(async move { result })
}

fn allowed_flag() -> (Arc<AtomicBool>, Authorized) {
    let allowed = Arc::new(AtomicBool::new(true));
    let check = allowed.clone();
    (allowed, Arc::new(move || check.load(Ordering::SeqCst)))
}

fn pausing(
    reached: &Arc<Deferred<()>>,
    release: &Arc<Deferred<()>>,
) -> Arc<dyn Fn() -> BoxFuture<()> + Send + Sync> {
    let (reached, release) = (reached.clone(), release.clone());
    Arc::new(move || {
        reached.resolve(());
        release.wait()
    })
}

// ------------------------------------------------------------ confirmed targets

#[tokio::test]
async fn revocation_at_native_dispatch_sends_nothing_and_does_not_enter_lost_reply_recovery() {
    for kind in ["create_workspace", "create_tab", "start_agent"] {
        let f = fixture();
        let params = match kind {
            "create_workspace" => json!({ "label": "Revoked" }),
            "start_agent" => json!({ "pane_id": "w1:p1", "agent": "pi" }),
            _ => json!({}),
        };
        let prepared = f.prepare(kind, params).await.unwrap();
        let (connected, release) = (Deferred::<()>::new(), Deferred::<()>::new());
        let (reached, wait) = (connected.clone(), release.clone());
        f.over(move |ctx| {
            let gated =
                ["workspace.create", "tab.create", "agent.start"].contains(&ctx.method.as_str());
            let (reached, wait) = (reached.clone(), wait.clone());
            Box::pin(async move {
                if gated {
                    reached.resolve(());
                    wait.wait().await;
                }
                ctx.original()
            })
        });
        let (allowed, authorized) = allowed_flag();
        let pending = tokio::spawn(prepared.execute(Some(authorized)));
        connected.wait().await;
        allowed.store(false, Ordering::SeqCst);
        release.resolve(());
        assert_eq!(
            pending.await.unwrap(),
            json!({
                "status": "failed",
                "detail": "Automatic approval was disabled before dispatch. Nothing was sent.",
            })
        );
        assert!(f.mutations().is_empty());
    }
}

#[tokio::test]
async fn worktree_preparation_forwards_live_permission_through_its_awaited_shared_flow() {
    let f = fixture();
    let prepared = f
        .prepare("create_worktree", json!({ "branch": "feature/revoked" }))
        .await
        .unwrap();
    let (fetching, release) = (Deferred::<()>::new(), Deferred::<()>::new());
    let (reached, wait) = (fetching.clone(), release.clone());
    *f.fake.create_worktree.lock().unwrap() = Some(Arc::new(
        move |fake: Arc<Fake>, params, is_current, before_dispatch| {
            let (reached, wait) = (reached.clone(), wait.clone());
            Box::pin(async move {
                reached.resolve(());
                wait.wait().await;
                default_worktree(&fake, "local", &params, &is_current, &before_dispatch)
            })
        },
    ));
    let (allowed, authorized) = allowed_flag();
    let pending = tokio::spawn(prepared.execute(Some(authorized)));
    fetching.wait().await;
    allowed.store(false, Ordering::SeqCst);
    release.resolve(());
    assert_eq!(
        pending.await.unwrap(),
        json!({
            "status": "failed",
            "detail": "Automatic approval was disabled before dispatch. Nothing was sent.",
        })
    );
    assert!(f.mutations().is_empty());
}

#[tokio::test]
async fn worktree_permission_revoked_at_reports_whether_execution_actually_started() {
    for stage in ["preflight", "sync", "connect", "sent"] {
        let f = fixture();
        let prepared = f
            .prepare("create_worktree", json!({ "branch": "feature/revoked" }))
            .await
            .unwrap();
        let (reached, release) = (Deferred::<()>::new(), Deferred::<()>::new());
        let pause = pausing(&reached, &release);
        // createWorkspaceWorktree as Bun runs it: its own current check, a
        // base sync whose process run is its first write, then
        // worktree.create through Herdr's gate.
        let flow_pause = pause.clone();
        *f.fake.create_worktree.lock().unwrap() = Some(Arc::new(
            move |fake: Arc<Fake>, params, is_current, before_dispatch| {
                let pause = flow_pause.clone();
                Box::pin(async move {
                    let current = || {
                        if is_current() {
                            Ok(())
                        } else {
                            fail("The worktree target changed.")
                        }
                    };
                    let gate = (is_current.clone(), before_dispatch.clone());
                    let before_send: BeforeSend = Arc::new(move || {
                        if !(gate.0)() {
                            return fail("The worktree target changed.");
                        }
                        (gate.1)()
                    });
                    current()?;
                    if stage == "sync" {
                        before_send()?;
                        fake.with("local", |conn| conn.mutations.push("base.sync".into()));
                        current()?;
                    }
                    if stage == "preflight" || stage == "sync" {
                        pause().await;
                    }
                    current()?;
                    let lease = fake.lease_of("local");
                    fake.herdr_call(&lease, "worktree.create", params, 30_000, Some(before_send))
                        .await
                })
            },
        ));
        let call_pause = pause.clone();
        f.over(move |ctx| {
            let pause = call_pause.clone();
            Box::pin(async move {
                if ctx.method != "worktree.create" {
                    return ctx.original();
                }
                if stage == "connect" {
                    pause().await;
                }
                ctx.before_send()?;
                ctx.fake
                    .with("local", |conn| conn.mutations.push(ctx.method.clone()));
                if stage == "sent" {
                    pause().await;
                }
                fail("Synthetic lost reply")
            })
        });
        let (allowed, authorized) = allowed_flag();
        let pending = tokio::spawn(prepared.execute(Some(authorized)));
        reached.wait().await;
        allowed.store(false, Ordering::SeqCst);
        release.resolve(());
        let result = pending.await.unwrap();
        let started = stage == "sync" || stage == "sent";
        assert_eq!(
            status(&result),
            if started { "uncertain" } else { "failed" },
            "{stage}"
        );
        assert!(detail(&result).contains(if started {
            "operation started"
        } else {
            "Nothing was sent"
        }));
        let expected: Vec<String> = match stage {
            "sync" => vec!["base.sync".into()],
            "sent" => vec!["worktree.create".into()],
            _ => vec![],
        };
        assert_eq!(f.mutations(), expected);
        assert_eq!(prepared.execute(None).await, result);
    }
}

#[tokio::test]
async fn native_failure_before_sending_does_not_enter_lost_reply_recovery() {
    for kind in [
        "create_workspace",
        "create_tab",
        "split_pane",
        "start_agent",
        "send_prompt",
    ] {
        let f = fixture();
        if kind == "send_prompt" {
            f.use_agent();
        }
        let params = match kind {
            "create_workspace" => json!({ "label": "New" }),
            "split_pane" => json!({ "pane_id": "w1:p1", "direction": "right" }),
            "start_agent" => json!({ "pane_id": "w1:p1", "agent": "pi" }),
            "send_prompt" => json!({ "pane_id": "w1:p1", "prompt": "Review" }),
            _ => json!({}),
        };
        let prepared = f.prepare(kind, params).await.unwrap();
        let method = match kind {
            "create_workspace" => "workspace.create",
            "create_tab" => "tab.create",
            "split_pane" => "pane.split",
            "start_agent" => "agent.start",
            _ => "agent.prompt",
        };
        f.over(move |ctx| {
            if ctx.method == method {
                ready(fail("ECONNREFUSED: synthetic socket"))
            } else {
                ready(ctx.original())
            }
        });
        let result = prepared.execute(None).await;
        assert_eq!(status(&result), "failed");
        assert!(detail(&result).contains("Nothing was sent"));
        assert!(f.mutations().is_empty());
        assert_eq!(prepared.execute(None).await, result);
        assert_eq!(f.calls_of(method).len(), 1);
    }
}

#[tokio::test]
async fn tab_creation_stays_in_the_approved_workspace_and_runs_once_after_preview() {
    let f = fixture();
    let prepared = f.prepare("create_tab", json!({})).await.unwrap();
    assert!(f.mutations().is_empty());
    assert_eq!(prepared.preview["params"], json!({ "cwd": f.root }));
    let (first, repeated) = tokio::join!(prepared.execute(None), prepared.execute(None));
    assert_eq!(first, repeated);
    assert_eq!(status(&first), "succeeded");
    assert!(detail(&first).contains("w1:t2"));
    assert!(detail(&first).contains("w1:p2"));
    assert_eq!(f.mutations(), ["tab.create"]);
    assert!(f.called_with(
        "tab.create",
        json!({ "workspace_id": "w1", "cwd": f.root, "focus": false }),
        30_000
    ));
    assert_eq!(f.conn(|conn| conn.workspaces.len()), 1);
}

#[tokio::test]
async fn three_previews_can_create_three_tabs_without_invalidating_sibling_proposals() {
    let f = fixture();
    let proposals = join_all((0..3).map(|_| f.prepare("create_tab", json!({})))).await;
    assert!(f.mutations().is_empty());
    for proposal in proposals {
        let result = proposal.unwrap().execute(None).await;
        assert_eq!(status(&result), "succeeded");
    }
    assert_eq!(f.conn(|conn| conn.tabs.len()), 4);
    assert_eq!(f.conn(|conn| conn.panes.len()), 4);
    assert_eq!(f.mutations(), ["tab.create", "tab.create", "tab.create"]);
}

#[tokio::test]
async fn tab_cwd_is_pinned_despite_another_pane_becoming_focused() {
    let f = fixture();
    f.conn(|conn| conn.workspaces[0].as_object_mut().unwrap().remove("cwd"));
    let prepared = f.prepare("create_tab", json!({})).await.unwrap();
    assert_eq!(
        prepared.preview["params"],
        json!({ "cwd": f.root, "pane_id": "w1:p1", "tab_id": "w1:t1", "terminal_id": "term1" })
    );
    f.conn(|conn| {
        conn.panes[0]["focused"] = json!(false);
        conn.panes.push(json!({
            "workspace_id": "w1",
            "pane_id": "w1:p2",
            "tab_id": "w1:t1",
            "terminal_id": "term2",
            "cwd": "/other",
            "focused": true,
        }));
    });
    assert_eq!(status(&prepared.execute(None).await), "succeeded");
    assert!(f.called_with(
        "tab.create",
        json!({ "workspace_id": "w1", "cwd": f.root, "focus": false }),
        30_000
    ));
}

#[tokio::test]
async fn splitting_a_busy_pane_creates_a_shell_in_the_same_tab_with_its_pinned_cwd() {
    for direction in ["right", "down"] {
        let f = fixture();
        f.use_agent();
        let prepared = f
            .prepare(
                "split_pane",
                json!({ "pane_id": "w1:p1", "direction": direction }),
            )
            .await
            .unwrap();
        assert!(f.mutations().is_empty());
        assert_eq!(
            prepared.preview["params"],
            json!({
                "pane_id": "w1:p1",
                "tab_id": "w1:t1",
                "terminal_id": "term1",
                "cwd": f.root,
                "direction": direction,
            })
        );
        let result = prepared.execute(None).await;
        assert_eq!(status(&result), "succeeded");
        assert!(detail(&result).contains("w1:p2"));
        assert!(detail(&result).contains("w1:t1"));
        assert_eq!(f.mutations(), ["pane.split"]);
        assert!(f.called_with(
            "pane.split",
            json!({ "target_pane_id": "w1:p1", "direction": direction, "cwd": f.root, "focus": false }),
            30_000
        ));
        assert_eq!(f.conn(|conn| conn.panes[0]["agent"].clone()), "pi");
        assert_eq!(f.conn(|conn| conn.tabs.len()), 1);
        assert_eq!(prepared.execute(None).await, result);
    }
}

#[tokio::test]
async fn layout_proposals_reject_extra_parameters_and_targets_outside_the_authorized_workspace() {
    let f = fixture();
    for params in [
        json!({ "cwd": "/private" }),
        json!({ "focus": true }),
        json!({ "env": "SECRET=value" }),
        json!({ "workspace_id": "w2" }),
    ] {
        assert!(f.prepare("create_tab", params).await.is_err());
    }
    for params in [
        json!({ "pane_id": "w1:p1", "direction": "left" }),
        json!({ "pane_id": "w1:p1", "direction": "right", "ratio": "0.9" }),
        json!({ "pane_id": "w1:p1", "direction": "right", "cwd": "/private" }),
        json!({ "pane_id": "w2:p1", "direction": "right" }),
    ] {
        assert!(f.prepare("split_pane", params).await.is_err());
    }
    assert!(f.mutations().is_empty());
}

fn layout_params(kind: &str) -> Value {
    if kind == "split_pane" {
        json!({ "pane_id": "w1:p1", "direction": "right" })
    } else {
        json!({})
    }
}

#[tokio::test]
async fn layout_target_changes_and_retired_runtimes_reject_before_dispatch() {
    for kind in ["create_tab", "split_pane"] {
        for change in [
            "generation",
            "directory",
            "tab",
            "terminal",
            "workspace",
            "closed",
        ] {
            let f = fixture();
            f.conn(|conn| conn.workspaces[0].as_object_mut().unwrap().remove("cwd"));
            let prepared = f.prepare(kind, layout_params(kind)).await.unwrap();
            match change {
                "generation" => f.retire(),
                "directory" => f.conn(|conn| conn.panes[0]["cwd"] = json!("/replacement")),
                "tab" => f.conn(|conn| conn.panes[0]["tab_id"] = json!("w1:t9")),
                "terminal" => f.conn(|conn| conn.panes[0]["terminal_id"] = json!("replacement")),
                "workspace" => f.conn(|conn| conn.panes[0]["workspace_id"] = json!("w2")),
                _ => f.conn(|conn| conn.panes.clear()),
            }
            assert_eq!(
                status(&prepared.execute(None).await),
                "failed",
                "{kind} {change}"
            );
            assert!(f.mutations().is_empty());
        }
    }
}

#[tokio::test]
async fn a_lost_layout_reply_is_uncertain_and_never_replays_the_creation() {
    for kind in ["create_tab", "split_pane"] {
        let f = fixture();
        let prepared = f.prepare(kind, layout_params(kind)).await.unwrap();
        f.over(|ctx| {
            let result = ctx.original();
            if ctx.method == "tab.create" || ctx.method == "pane.split" {
                return ready(fail("timeout SECRET /private/socket"));
            }
            ready(result)
        });
        let result = prepared.execute(None).await;
        assert_eq!(status(&result), "uncertain");
        assert!(!result.to_string().contains("SECRET"));
        assert_eq!(prepared.execute(None).await, result);
        assert_eq!(f.mutations().len(), 1);
    }
}

#[tokio::test]
async fn unexpected_or_replaced_layout_results_are_uncertain() {
    for kind in ["create_tab", "split_pane"] {
        for change in [
            "workspace",
            "tab",
            "directory",
            "terminal",
            "reused",
            "missing",
            "retired",
        ] {
            let f = fixture();
            let prepared = f.prepare(kind, layout_params(kind)).await.unwrap();
            f.over(move |ctx| {
                let result = ctx.original();
                if ctx.method != "tab.create" && ctx.method != "pane.split" {
                    return ready(result);
                }
                // The new pane as Herdr now holds it, not as it answered.
                ctx.fake.with("local", |conn| {
                    let pane = conn.panes.last_mut().unwrap();
                    match change {
                        "workspace" => pane["workspace_id"] = json!("w2"),
                        "tab" => pane["tab_id"] = json!("w1:t9"),
                        "directory" => pane["cwd"] = json!("/wrong"),
                        "terminal" => pane["terminal_id"] = json!("replacement"),
                        "reused" => pane["terminal_id"] = json!("term1"),
                        "missing" => {
                            conn.panes.pop();
                        }
                        _ => conn.generation += 1,
                    }
                });
                ready(result)
            });
            let result = prepared.execute(None).await;
            assert_eq!(status(&result), "uncertain", "{kind} {change}");
            assert_eq!(prepared.execute(None).await, result);
            assert_eq!(f.mutations().len(), 1);
        }
    }
}

#[tokio::test]
async fn workspace_preparation_is_readonly_freezes_parameters_and_executes_only_once() {
    let f = fixture();
    let scope = f.scope().await;
    let params = merged(&same_ref(), json!({ "label": "New workspace" }));
    let prepared = f
        .context
        .prepare("create_workspace", &scope, params, None)
        .await
        .unwrap();
    assert!(f.mutations().is_empty());
    let preview = &prepared.preview;
    assert_eq!(preview["connection_id"], "local");
    assert_eq!(preview["workspace_id"], "w1");
    assert_eq!(preview["runtime_generation"], 7);
    assert_eq!(preview["workspace_label"], "Source");
    assert_eq!(
        preview["params"],
        json!({ "label": "New workspace", "cwd": f.root })
    );
    let (first, second) = tokio::join!(prepared.execute(None), prepared.execute(None));
    assert_eq!(status(&first), "succeeded");
    assert_eq!(second, first);
    assert_eq!(f.mutations(), ["workspace.create"]);
    assert!(f.called_with(
        "workspace.create",
        json!({ "label": "New workspace", "cwd": f.root, "source_workspace_id": "w1", "focus": false }),
        30_000
    ));
}

#[tokio::test]
async fn workspace_creation_checks_directories_before_dispatch() {
    for kind in ["explicit", "inferred", "removed", "file"] {
        let f = fixture();
        let root = tempfile::tempdir_in(&f.root).unwrap();
        let cwd = root.path().join("project").to_string_lossy().into_owned();
        if kind == "removed" {
            std::fs::create_dir(&cwd).unwrap();
        }
        if kind == "file" {
            std::fs::write(&cwd, "not a directory").unwrap();
        }
        if kind == "inferred" {
            f.conn(|conn| conn.workspaces[0]["cwd"] = json!(cwd));
        }
        let params = if kind == "inferred" {
            json!({ "label": "New" })
        } else {
            json!({ "label": "New", "cwd": cwd })
        };
        let prepared = f.prepare("create_workspace", params).await.unwrap();
        if kind == "removed" {
            std::fs::remove_dir_all(&cwd).unwrap();
        }
        let result = prepared.execute(None).await;
        assert_eq!(status(&result), "failed");
        assert!(detail(&result).contains(if kind == "file" {
            "Path is not a directory."
        } else {
            "Directory does not exist."
        }));
        assert!(f.mutations().is_empty());
        assert_eq!(prepared.execute(None).await, result);
    }
}

#[tokio::test]
async fn workspace_creation_validates_the_selected_windows_ssh_host() {
    for state in ["valid", "missing", "retired", "unreachable"] {
        let f = fixture();
        f.conn(|conn| {
            conn.ssh_host = Some("windows-host".into());
            conn.remote_platform = Some("windows".into());
        });
        let cwd = "C:\\Users\\remote\\project";
        *f.fake.inspect.lock().unwrap() = Some(Arc::new(move |fake: Arc<Fake>, path: Value| {
            if state == "retired" {
                fake.retire("local");
            }
            let error = if state == "missing" {
                "Directory does not exist."
            } else {
                ""
            };
            let result = if state == "unreachable" {
                fail("SECRET /private/socket")
            } else {
                Ok(json!({ "path": path, "error": error }))
            };
            ready(result)
        }));
        let prepared = f
            .prepare("create_workspace", json!({ "label": "New", "cwd": cwd }))
            .await
            .unwrap();
        let result = prepared.execute(None).await;
        assert_eq!(
            status(&result),
            if state == "valid" {
                "succeeded"
            } else {
                "failed"
            }
        );
        let expected: Vec<&str> = if state == "valid" {
            vec!["workspace.create"]
        } else {
            vec![]
        };
        assert_eq!(f.mutations(), expected);
        assert_eq!(f.fake.inspect_calls.load(Ordering::SeqCst), 1);
        assert_eq!(
            f.fake.inspect_hosts.lock().unwrap()[0],
            (Some("windows-host".into()), Some("windows".into()))
        );
        assert!(!result.to_string().contains("SECRET"));
        assert_eq!(prepared.execute(None).await, result);
    }
}

#[tokio::test]
async fn a_completed_preview_survives_disposal_of_the_model_tool_signal() {
    let f = fixture();
    let token = CancellationToken::new();
    let prepared = f
        .prepare_with(
            "create_workspace",
            json!({ "label": "New" }),
            Some(token.clone()),
        )
        .await
        .unwrap();
    token.cancel();
    assert_eq!(status(&prepared.execute(None).await), "succeeded");
    assert_eq!(f.mutations(), ["workspace.create"]);
}

#[tokio::test]
async fn preparation_cancellation_stops_admission_without_a_write() {
    let f = fixture();
    let scope = f.scope().await;
    let gate = Deferred::<AssistantResult<Value>>::new();
    let wait = gate.wait();
    f.fake.once("local", move |_| wait);
    let token = CancellationToken::new();
    let context = f.context.clone();
    let signal = Some(token.clone());
    let params = merged(&same_ref(), json!({ "label": "New" }));
    let pending = tokio::spawn(async move {
        context
            .prepare("create_workspace", &scope, params, signal)
            .await
            .map(|_| ())
    });
    flush().await;
    token.cancel();
    let error = pending.await.unwrap().err().unwrap();
    assert!(error.message().contains("preview is unavailable"));
    assert!(f.mutations().is_empty());
    let workspace = f.conn(|conn| conn.workspaces[0].clone());
    gate.resolve(Ok(json!({ "workspace": workspace })));
}

fn rejects(result: AssistantResult<Prepared>, text: &str) {
    let error: AssistantError = result.err().expect("a rejection");
    assert!(
        error.message().contains(text),
        "{:?} lacks {text:?}",
        error.message()
    );
}

#[tokio::test]
async fn forged_cross_workspace_and_unsupported_action_inputs_never_acquire_capabilities() {
    let f = fixture();
    let scope = f.scope().await;
    let forged = CapturedScope::plain(scope.workspaces.clone());
    let with = |extra: Value| merged(&same_ref(), extra);
    rejects(
        f.context
            .prepare(
                "create_workspace",
                &forged,
                with(json!({ "label": "New" })),
                None,
            )
            .await,
        "not approved",
    );
    rejects(
        f.context
            .prepare(
                "create_workspace",
                &scope,
                with(json!({ "workspace_id": "w2", "label": "New" })),
                None,
            )
            .await,
        "outside",
    );
    rejects(
        f.context
            .prepare(
                "create_workspace",
                &scope,
                with(json!({ "label": "New", "env": { "SECRET": "key" } })),
                None,
            )
            .await,
        "Unsupported",
    );
    rejects(
        f.context
            .prepare(
                "create_workspace",
                &scope,
                with(json!({ "label": "New", "cwd": "../private" })),
                None,
            )
            .await,
        "preview is unavailable",
    );
    assert!(
        f.prepare("create_worktree", json!({ "branch": "-danger" }))
            .await
            .is_err()
    );
    assert!(f.mutations().is_empty());
}

#[tokio::test]
async fn retired_connections_and_source_directory_changes_reject_before_dispatch() {
    for change in ["generation", "directory", "closed"] {
        let f = fixture();
        let prepared = f
            .prepare("create_workspace", json!({ "label": "New" }))
            .await
            .unwrap();
        match change {
            "generation" => f.retire(),
            "directory" => f.conn(|conn| conn.workspaces[0]["cwd"] = json!("/replacement")),
            _ => f.conn(|conn| conn.workspaces.clear()),
        }
        assert_eq!(status(&prepared.execute(None).await), "failed");
        assert!(f.mutations().is_empty());
        assert_eq!(f.conn(|conn| conn.lease_calls), 1);
    }
}

#[tokio::test]
async fn inferred_shell_directories_stay_tied_to_the_original_pane() {
    let f = fixture();
    f.conn(|conn| conn.workspaces[0].as_object_mut().unwrap().remove("cwd"));
    let prepared = f
        .prepare("create_workspace", json!({ "label": "New" }))
        .await
        .unwrap();
    f.conn(|conn| conn.panes[0]["terminal_id"] = json!("replacement-terminal"));
    assert_eq!(status(&prepared.execute(None).await), "failed");
    assert!(f.mutations().is_empty());
}

#[tokio::test]
async fn workspace_creation_checks_existing_names_and_verifies_a_lost_reply_without_retrying() {
    let f = fixture();
    let prepared = f
        .prepare("create_workspace", json!({ "label": "New" }))
        .await
        .unwrap();
    f.over(|ctx| {
        let result = ctx.original();
        if ctx.method != "workspace.create" {
            return ready(result);
        }
        ready(fail("connection closed: SECRET /private/socket"))
    });
    assert_eq!(status(&prepared.execute(None).await), "succeeded");
    prepared.execute(None).await;
    assert_eq!(f.mutations(), ["workspace.create"]);
    let duplicate = f
        .prepare("create_workspace", json!({ "label": "New" }))
        .await
        .unwrap();
    assert_eq!(status(&duplicate.execute(None).await), "failed");
    assert_eq!(f.mutations(), ["workspace.create"]);
}

#[tokio::test]
async fn an_unverified_creation_directory_never_grants_the_observed_workspace() {
    let f = fixture();
    let prepared = f
        .prepare("create_workspace", json!({ "label": "New" }))
        .await
        .unwrap();
    f.over(|ctx| {
        let response = ctx.original();
        if ctx.method == "workspace.create" {
            ctx.fake.with("local", |conn| {
                for pane in &mut conn.panes {
                    if pane["workspace_id"] == "w2" {
                        pane["cwd"] = json!("/another-private-directory");
                    }
                }
            });
        }
        ready(response)
    });
    let result = prepared.execute(None).await;
    assert_eq!(status(&result), "uncertain");
    assert!(result.get("created").is_none());
    assert_eq!(f.mutations(), ["workspace.create"]);
}

#[tokio::test]
async fn an_unverified_write_is_uncertain_sanitized_and_is_never_replayed() {
    let f = fixture();
    let prepared = f
        .prepare("create_workspace", json!({ "label": "New" }))
        .await
        .unwrap();
    f.over(|ctx| {
        if ctx.method != "workspace.create" {
            return ready(ctx.original());
        }
        let sent = ctx.before_send();
        ctx.fake
            .with("local", |conn| conn.mutations.push(ctx.method.clone()));
        ready(sent.and_then(|()| fail("timeout: SECRET /private/socket")))
    });
    let result = prepared.execute(None).await;
    assert_eq!(status(&result), "uncertain");
    assert!(!result.to_string().contains("SECRET"));
    assert!(!result.to_string().contains("/private"));
    assert_eq!(prepared.execute(None).await, result);
    assert_eq!(f.mutations(), ["workspace.create"]);
}

#[tokio::test]
async fn worktree_preview_includes_the_hook_and_uses_the_complete_injected_gui_flow() {
    let f = fixture();
    f.set_setup(Some("bun install"));
    let prepared = f
        .prepare(
            "create_worktree",
            json!({ "branch": "feature/ranger", "label": "Task" }),
        )
        .await
        .unwrap();
    assert!(f.mutations().is_empty());
    let params = &prepared.preview["params"];
    assert_eq!(params["branch"], "feature/ranger");
    assert_eq!(params["setup_hook"], "bun install");
    assert_eq!(params["setup_hook_enabled"], "true");
    assert_eq!(status(&prepared.execute(None).await), "succeeded");
    assert_eq!(f.mutations(), ["worktree.flow"]);
    assert_eq!(
        f.fake.worktree_calls.lock().unwrap()[0],
        json!({
            "workspace_id": "w1",
            "branch": "feature/ranger",
            "label": "Task",
            "focus": false,
            "expected_setup_hook": "bun install",
            "expected_hooks_enabled": true,
            "expected_source_root": f.root,
            "expected_worktree_command": null,
        })
    );
    assert!(f.calls_of("worktree.create").is_empty());
}

#[tokio::test]
async fn worktree_preview_shows_the_location_s_path_and_a_changed_location_blocks_dispatch() {
    let f = fixture();
    let unset = f
        .prepare("create_worktree", json!({ "branch": "feature/ranger" }))
        .await
        .unwrap();
    assert_eq!(
        unset.preview["params"]["path"],
        "(Herdr's default worktree location)"
    );
    // Any repository key the fixture's workspace maps to gets a location.
    let key = format!("repo:{}", f.root);
    *f.fake.settings.lock().unwrap() =
        json!({ "repositories": { key.clone(): { "worktree_directory": "/srv/trees" } } });
    let prepared = f
        .prepare("create_worktree", json!({ "branch": "feature/ranger" }))
        .await
        .unwrap();
    assert_eq!(
        prepared.preview["params"]["path"],
        "/srv/trees/feature-ranger"
    );
    assert_eq!(status(&prepared.execute(None).await), "succeeded");
    assert_eq!(
        f.fake.worktree_calls.lock().unwrap()[0]["path"],
        "/srv/trees/feature-ranger"
    );
    let moved = f
        .prepare("create_worktree", json!({ "branch": "feature/ranger" }))
        .await
        .unwrap();
    *f.fake.settings.lock().unwrap() =
        json!({ "repositories": { key: { "worktree_directory": "/elsewhere" } } });
    assert_eq!(status(&moved.execute(None).await), "failed");
    assert_eq!(f.fake.worktree_calls.lock().unwrap().len(), 1);
}

#[tokio::test]
async fn worktree_preview_shows_the_worktree_command_and_a_changed_command_blocks_dispatch() {
    let f = fixture();
    *f.fake.settings.lock().unwrap() = json!({ "worktree_command": "mk {path} {branch}" });
    let prepared = f
        .prepare("create_worktree", json!({ "branch": "feature/ranger" }))
        .await
        .unwrap();
    assert_eq!(
        prepared.preview["params"]["worktree_command"],
        "mk {path} {branch}"
    );
    *f.fake.settings.lock().unwrap() = json!({ "worktree_command": "other {path}" });
    assert_eq!(status(&prepared.execute(None).await), "failed");
    assert!(f.fake.worktree_calls.lock().unwrap().is_empty());
    let next = f
        .prepare("create_worktree", json!({ "branch": "feature/ranger" }))
        .await
        .unwrap();
    assert_eq!(status(&next.execute(None).await), "succeeded");
    assert_eq!(
        f.fake.worktree_calls.lock().unwrap()[0]["expected_worktree_command"],
        "other {path}"
    );
}

#[tokio::test]
async fn worktree_source_hook_changes_block_dispatch_and_target_hook_guards_report_partial_failure()
{
    let f = fixture();
    f.set_setup(Some("bun install"));
    let prepared = f
        .prepare("create_worktree", json!({ "branch": "feature/ranger" }))
        .await
        .unwrap();
    f.set_setup(Some("changed command"));
    assert_eq!(status(&prepared.execute(None).await), "failed");
    assert!(f.fake.worktree_calls.lock().unwrap().is_empty());
    f.set_setup(Some("bun install"));
    let next = f
        .prepare("create_worktree", json!({ "branch": "feature/ranger" }))
        .await
        .unwrap();
    *f.fake.create_worktree.lock().unwrap() = Some(Arc::new(
        |fake: Arc<Fake>, params, is_current, before_dispatch| {
            let mut result =
                default_worktree(&fake, "local", &params, &is_current, &before_dispatch);
            if let Ok(result) = &mut result {
                result["setup_hook"] = json!({ "status": "skipped", "reason": "setup_hook_changed", "stderr": "SECRET" });
            }
            ready(result)
        },
    ));
    let result = next.execute(None).await;
    assert_eq!(status(&result), "failed");
    assert!(detail(&result).contains("worktree was created"));
    assert!(!detail(&result).contains("SECRET"));
}

#[tokio::test]
async fn a_repository_herdr_does_not_describe_confirms_the_settings_creation_applies() {
    let f = fixture();
    // Herdr names no repository for the workspace: Bun's resolver keys it by
    // the checkout's git common directory, for the preview and for creation.
    let repo = format!("{}/repo", f.root);
    std::fs::create_dir(&repo).unwrap();
    let key = format!("connection:local:local:{repo}/.git");
    *f.fake.repo_key.lock().unwrap() = Some(key.clone());
    *f.fake.settings.lock().unwrap() = json!({
        "repositories": { key: { "worktree_directory": "/srv/trees", "worktree_command": "mk {path}" } },
    });
    f.conn(|conn| {
        conn.workspaces[0]["cwd"] = json!(repo);
        conn.panes[0]["cwd"] = json!(repo);
        conn.root = repo.clone();
    });
    let prepared = f
        .prepare("create_worktree", json!({ "branch": "feature/ranger" }))
        .await
        .unwrap();
    assert_eq!(prepared.preview["params"]["worktree_command"], "mk {path}");
    assert_eq!(
        prepared.preview["params"]["path"],
        "/srv/trees/feature-ranger"
    );
    let inputs = f.fake.repo_inputs.lock().unwrap().clone();
    assert_eq!(inputs[0]["root"], json!(repo));
    assert_eq!(inputs[0]["workspace"]["cwd"], json!(repo));
    // Creation resolves the same repository and reaches the command's
    // install probe instead of refusing a changed command.
    let failures = Arc::new(Mutex::new(Vec::<String>::new()));
    let seen = failures.clone();
    *f.fake.create_worktree.lock().unwrap() = Some(Arc::new(move |_, _, _, _| {
        let message = "Synthetic probe stop";
        seen.lock().unwrap().push(message.into());
        ready(fail(message))
    }));
    prepared.execute(None).await;
    let calls = f.fake.worktree_calls.lock().unwrap().clone();
    assert_eq!(calls.len(), 1);
    assert_eq!(calls[0]["expected_worktree_command"], "mk {path}");
    assert!(failures.lock().unwrap()[0].contains("Synthetic probe stop"));
}

fn name_is_valid(name: &str) -> bool {
    regex::Regex::new(r"^[a-z][a-z0-9_-]{0,31}$")
        .unwrap()
        .is_match(name)
}

#[tokio::test]
async fn start_uses_a_supported_manifest_handles_empty_shells_and_verifies_the_agent_once() {
    let f = fixture();
    let prepared = f
        .prepare("start_agent", json!({ "pane_id": "w1:p1", "agent": "pi" }))
        .await
        .unwrap();
    let name = prepared.preview["params"]["name"]
        .as_str()
        .unwrap()
        .to_owned();
    assert!(name_is_valid(&name));
    assert!(f.mutations().is_empty());
    assert!(f.calls_of("agent.get").is_empty());
    assert_eq!(status(&prepared.execute(None).await), "succeeded");
    prepared.execute(None).await;
    assert_eq!(f.mutations(), ["agent.start"]);
    assert!(f.called_with(
        "agent.start",
        json!({ "pane_id": "w1:p1", "kind": "pi", "name": name, "timeout_ms": 60_000 }),
        65_000
    ));
    assert!(
        f.prepare(
            "start_agent",
            json!({ "pane_id": "w1:p1", "agent": "uninstalled" })
        )
        .await
        .is_err()
    );
}

#[tokio::test]
async fn start_names_stay_valid_and_stable_for_uppercase_and_maximum_length_pane_ids() {
    let mut names = Vec::new();
    for pane_id in [
        "wN:pW".to_owned(),
        "wn:pw".to_owned(),
        format!("wN:p{}", "W".repeat(124)),
    ] {
        let f = fixture_for(&pane_id);
        let params = json!({ "pane_id": pane_id, "agent": "pi" });
        let prepared = f.prepare("start_agent", params.clone()).await.unwrap();
        let name = prepared.preview["params"]["name"]
            .as_str()
            .unwrap()
            .to_owned();
        assert!(name_is_valid(&name));
        let again = f.prepare("start_agent", params).await.unwrap();
        assert_eq!(again.preview["params"]["name"], json!(name));
        assert_eq!(status(&prepared.execute(None).await), "succeeded");
        assert!(f.called_with(
            "agent.start",
            json!({ "pane_id": pane_id, "kind": "pi", "name": name, "timeout_ms": 60_000 }),
            65_000
        ));
        assert_eq!(f.mutations(), ["agent.start"]);
        names.push(name);
    }
    let mut distinct = names.clone();
    distinct.sort();
    distinct.dedup();
    assert_eq!(distinct.len(), names.len());
}

#[tokio::test]
async fn raw_asynchronous_startup_waits_for_agent_get_readiness_in_the_original_terminal() {
    let f = fixture();
    let prepared = f
        .prepare("start_agent", json!({ "pane_id": "w1:p1", "agent": "pi" }))
        .await
        .unwrap();
    let polled = Deferred::<()>::new();
    let seen = polled.clone();
    f.over(move |ctx| {
        let response = ctx.original();
        if ctx.method == "agent.start" {
            let agent = ctx.fake.with("local", |conn| {
                conn.agent["launch_pending"] = json!(true);
                conn.agent["interactive_ready"] = json!(false);
                conn.agent.clone()
            });
            return ready(response.map(|mut response| {
                response["agent"] = agent;
                response
            }));
        }
        let waiting = ctx.fake.with("local", |conn| {
            conn.agent["interactive_ready"] == json!(false)
        });
        if ctx.method == "agent.get" && waiting {
            seen.resolve(());
        }
        ready(response)
    });
    let executing = tokio::spawn(prepared.execute(None));
    polled.wait().await;
    flush().await;
    assert!(!executing.is_finished());
    assert_eq!(f.mutations(), ["agent.start"]);
    f.conn(|conn| {
        conn.agent["agent_status"] = json!("done");
        conn.agent["interactive_ready"] = json!(true);
    });
    // A stale launch_pending flag does not override explicit readiness from agent.get.
    f.clock.advance(100).await;
    let result = executing.await.unwrap();
    assert_eq!(status(&result), "succeeded");
    assert!(detail(&result).contains("interactive"));
    assert_eq!(prepared.execute(None).await, result);
    assert_eq!(f.mutations(), ["agent.start"]);
    assert!(f.calls_of("agent.wait").is_empty());
}

#[tokio::test]
async fn startup_blocked_or_ended_before_readiness_reports_attempted_startup_without_relaunching() {
    for state in ["blocked", "exited"] {
        let f = fixture();
        let prepared = f
            .prepare("start_agent", json!({ "pane_id": "w1:p1", "agent": "pi" }))
            .await
            .unwrap();
        f.over(move |ctx| {
            let response = ctx.original();
            if ctx.method == "agent.start" {
                ctx.fake.with("local", |conn| {
                    conn.agent["agent_status"] = json!(if state == "blocked" {
                        "blocked"
                    } else {
                        "done"
                    });
                    conn.agent["interactive_ready"] = json!(false);
                    conn.agent["launch_pending"] = json!(state == "blocked");
                });
            }
            ready(response)
        });
        let result = prepared.execute(None).await;
        assert_eq!(status(&result), "failed");
        assert!(detail(&result).contains("startup was attempted"));
        assert!(detail(&result).to_lowercase().contains("inspect this pane"));
        assert_eq!(prepared.execute(None).await, result);
        assert_eq!(f.mutations(), ["agent.start"]);
    }
}

#[tokio::test]
async fn startup_wait_is_bounded_and_stops_on_retirement_or_terminal_name_replacement() {
    for change in ["timeout", "retired", "terminal", "name"] {
        let f = fixture();
        let prepared = f
            .prepare("start_agent", json!({ "pane_id": "w1:p1", "agent": "pi" }))
            .await
            .unwrap();
        let polled = Deferred::<()>::new();
        let seen = polled.clone();
        f.over(move |ctx| {
            let response = ctx.original();
            if ctx.method == "agent.start" {
                ctx.fake.with("local", |conn| {
                    conn.agent["interactive_ready"] = json!(false);
                    conn.agent["launch_pending"] = json!(true);
                });
            }
            if ctx.method == "agent.get" {
                seen.resolve(());
            }
            ready(response)
        });
        let executing = tokio::spawn(prepared.execute(None));
        polled.wait().await;
        flush().await;
        match change {
            "retired" => f.retire(),
            "terminal" => f.conn(|conn| {
                conn.panes[0]["terminal_id"] = json!("replacement");
                conn.agent["terminal_id"] = json!("replacement");
            }),
            "name" => f.conn(|conn| conn.agent["name"] = json!("Replacement")),
            _ => {}
        }
        f.clock
            .advance(if change == "timeout" { 60_000 } else { 100 })
            .await;
        let result = executing.await.unwrap();
        assert_eq!(status(&result), "uncertain", "{change}");
        if change == "timeout" {
            assert!(detail(&result).contains("timeout"));
        }
        assert_eq!(prepared.execute(None).await, result);
        assert_eq!(f.mutations(), ["agent.start"]);
        assert_eq!(f.conn(|conn| conn.lease_calls), 1);
    }
}

#[tokio::test]
async fn created_worktrees_report_a_lost_parent_relationship_without_retrying() {
    let f = fixture();
    let prepared = f
        .prepare("create_worktree", json!({ "branch": "feature/ranger" }))
        .await
        .unwrap();
    *f.fake.create_worktree.lock().unwrap() = Some(Arc::new(
        |fake: Arc<Fake>, params, is_current, before_dispatch| {
            let mut result =
                default_worktree(&fake, "local", &params, &is_current, &before_dispatch);
            if let Ok(result) = &mut result {
                result["parent_tracking_failed"] = json!(true);
            }
            ready(result)
        },
    ));
    let result = prepared.execute(None).await;
    assert_eq!(status(&result), "failed");
    assert!(detail(&result).contains("worktree was created"));
    assert!(detail(&result).contains("source relationship could not be saved"));
    assert_eq!(prepared.execute(None).await, result);
    assert_eq!(f.fake.worktree_calls.lock().unwrap().len(), 1);
}

#[tokio::test]
async fn target_terminal_session_process_and_workspace_replacements_prevent_prompting() {
    for change in ["terminal", "session", "process", "workspace"] {
        let f = fixture();
        f.use_agent();
        let prepared = f
            .prepare(
                "send_prompt",
                json!({ "pane_id": "w1:p1", "prompt": "Review the selected changes." }),
            )
            .await
            .unwrap();
        f.conn(|conn| match change {
            "terminal" => {
                conn.panes[0]["terminal_id"] = json!("replacement");
                conn.agent["terminal_id"] = json!("replacement");
            }
            "session" => conn.agent["agent_session"]["value"] = json!("session2"),
            "process" => {
                conn.process["foreground_processes"] = json!([{ "pid": 303, "name": "pi" }])
            }
            _ => {
                conn.panes[0]["workspace_id"] = json!("w2");
                conn.agent["workspace_id"] = json!("w2");
            }
        });
        assert_eq!(status(&prepared.execute(None).await), "failed", "{change}");
        assert!(f.mutations().is_empty());
    }
}

#[tokio::test]
async fn prompt_acceptance_stays_uncertain_and_its_exact_content_is_submitted_only_once() {
    let f = fixture();
    f.use_agent();
    let scope = f.scope().await;
    let params = merged(
        &same_ref(),
        json!({ "pane_id": "w1:p1", "prompt": "Feedback:\nPlease add coverage." }),
    );
    let prepared = f
        .context
        .prepare("send_prompt", &scope, params, None)
        .await
        .unwrap();
    let result = prepared.execute(None).await;
    assert_eq!(status(&result), "uncertain");
    assert!(detail(&result).contains("accepted"));
    assert!(!detail(&result).contains("private-key"));
    assert_eq!(prepared.execute(None).await, result);
    assert_eq!(f.mutations(), ["agent.prompt"]);
    assert!(f.called_with(
        "agent.prompt",
        json!({ "target": "w1:p1", "text": "Feedback:\nPlease add coverage." }),
        5000
    ));
}

#[tokio::test]
async fn a_prompt_that_reached_the_agent_says_from_which_state() {
    let f = fixture();
    f.use_agent();
    f.conn(|conn| {
        conn.agent["state_change_seq"] = json!(12);
        conn.agent["agent_status"] = json!("idle");
    });
    let scope = f.scope().await;
    let params = merged(
        &same_ref(),
        json!({ "pane_id": "w1:p1", "prompt": "Check your MR." }),
    );
    let prepared = f
        .context
        .prepare("send_prompt", &scope, params, None)
        .await
        .unwrap();
    assert!(f.fake.prompted.lock().unwrap().is_empty());
    prepared.execute(None).await;
    assert_eq!(
        *f.fake.prompted.lock().unwrap(),
        [json!({
            "connectionId": "local",
            "paneId": "w1:p1",
            "terminalId": "term1",
            "seq": 12,
            "status": "idle",
        })]
    );
}

#[tokio::test]
async fn a_blocked_prompt_is_explicitly_rejected_without_claiming_acceptance() {
    let f = fixture();
    f.use_agent();
    let prepared = f
        .prepare(
            "send_prompt",
            json!({ "pane_id": "w1:p1", "prompt": "Review" }),
        )
        .await
        .unwrap();
    f.over(|ctx| {
        if ctx.method != "agent.prompt" {
            return ready(ctx.original());
        }
        ready(
            ctx.before_send()
                .and_then(|()| fail("agent_blocked: SECRET /private/session")),
        )
    });
    let result = prepared.execute(None).await;
    assert_eq!(status(&result), "failed");
    assert!(detail(&result).contains("No prompt was submitted"));
    assert!(!detail(&result).contains("SECRET"));
}

#[tokio::test]
async fn generation_retirement_during_preflight_prevents_writes_and_after_dispatch_stays_uncertain()
{
    for stage in ["before", "after"] {
        let f = fixture();
        let prepared = f
            .prepare("create_workspace", json!({ "label": "New" }))
            .await
            .unwrap();
        f.over(move |ctx| {
            let result = ctx.original();
            let trigger = if stage == "before" {
                "workspace.get"
            } else {
                "workspace.create"
            };
            if ctx.method == trigger {
                ctx.fake.retire("local");
            }
            ready(result)
        });
        let result = prepared.execute(None).await;
        assert_eq!(
            status(&result),
            if stage == "before" {
                "failed"
            } else {
                "uncertain"
            }
        );
        let expected: Vec<&str> = if stage == "before" {
            vec![]
        } else {
            vec!["workspace.create"]
        };
        assert_eq!(f.mutations(), expected);
        assert_eq!(f.conn(|conn| conn.lease_calls), 1);
    }
}

// ------------------------------------------------------------ close actions

const CLOSE_KINDS: [&str; 3] = ["close_workspace", "close_pane", "close_agent"];

fn close_params(kind: &str) -> Value {
    if kind == "close_workspace" {
        json!({})
    } else {
        json!({ "pane_id": "w1:p1" })
    }
}

fn close_method(kind: &str) -> &'static str {
    if kind == "close_workspace" {
        "workspace.close"
    } else {
        "pane.close"
    }
}

fn is_close(method: &str) -> bool {
    method == "workspace.close" || method == "pane.close"
}

#[tokio::test]
async fn verifies_a_successful_close_after_the_native_automatic_label_changes() {
    for kind in ["close_pane", "close_agent"] {
        let f = fixture();
        if kind == "close_agent" {
            f.use_agent();
        }
        f.conn(|conn| {
            conn.tabs
                .push(json!({ "workspace_id": "w1", "tab_id": "w1:t2", "label": "Second" }));
            create_pane(conn, json!("/second-directory"), "w1:t2");
        });
        f.over(|ctx| {
            let result = ctx.original();
            if ctx.method == "pane.close" {
                ctx.fake.with("local", |conn| {
                    conn.workspaces[0]["label"] = json!("second-directory")
                });
            }
            ready(result)
        });
        let prepared = f.prepare(kind, close_params(kind)).await.unwrap();
        let result = prepared.execute(None).await;
        assert_eq!(status(&result), "succeeded", "{kind}");
        assert_eq!(prepared.execute(None).await, result);
        let panes: Vec<Value> =
            f.conn(|conn| conn.panes.iter().map(|p| p["pane_id"].clone()).collect());
        assert_eq!(panes, [json!("w1:p2")]);
        assert_eq!(f.mutations(), ["pane.close"]);
    }
}

#[tokio::test]
async fn post_close_verification_still_rejects_changed_workspace_identity() {
    for identity in ["cwd", "worktree"] {
        let f = fixture();
        f.add_sibling();
        let prepared = f
            .prepare("close_pane", close_params("close_pane"))
            .await
            .unwrap();
        f.over(move |ctx| {
            let result = ctx.original();
            if ctx.method == "pane.close" {
                ctx.fake.with("local", |conn| {
                    conn.workspaces[0]["label"] = json!("different-label");
                    if identity == "cwd" {
                        conn.workspaces[0]["cwd"] = json!("/replacement");
                    } else {
                        conn.workspaces[0]["worktree"] = json!({
                            "repo_key": "replacement",
                            "repo_root": "/replacement",
                            "checkout_path": "/replacement",
                            "is_linked_worktree": true,
                        });
                    }
                });
            }
            ready(result)
        });
        let result = prepared.execute(None).await;
        assert_eq!(status(&result), "uncertain");
        assert_eq!(prepared.execute(None).await, result);
        assert_eq!(f.mutations(), ["pane.close"]);
    }
}

#[tokio::test]
async fn is_preview_only_and_executes_once() {
    for kind in CLOSE_KINDS {
        let f = fixture();
        f.use_agent();
        f.add_sibling();
        let root = f.root.clone();
        f.conn(|conn| {
            conn.worktrees
                .push(json!({ "branch": "feature", "path": root }))
        });
        let prepared = f.prepare(kind, close_params(kind)).await.unwrap();
        assert_eq!(prepared.preview["kind"], kind);
        let summary = prepared.preview["summary"].as_str().unwrap();
        assert!(summary.contains("Unsaved terminal work may be lost"));
        assert!(summary.contains("history will not be deleted"));
        assert!(f.mutations().is_empty());
        let (first, repeated) = tokio::join!(prepared.execute(None), prepared.execute(None));
        assert_eq!(first, repeated);
        assert_eq!(status(&first), "succeeded", "{kind}");
        let method = close_method(kind);
        assert_eq!(f.mutations(), [method]);
        let query = if kind == "close_workspace" {
            json!({ "workspace_id": "w1" })
        } else {
            json!({ "pane_id": "w1:p1" })
        };
        assert!(f.called_with(method, query, 30_000));
        assert_eq!(f.conn(|conn| conn.worktrees.len()), 1);
        let left = if kind == "close_workspace" { 0 } else { 1 };
        assert_eq!(f.conn(|conn| conn.panes.len()), left);
    }
}

#[tokio::test]
async fn previews_last_pane_workspace_closure_and_uses_the_explicit_no_group_endpoint() {
    for kind in ["close_pane", "close_agent"] {
        let f = fixture();
        f.use_agent();
        let prepared = f.prepare(kind, close_params(kind)).await.unwrap();
        assert_eq!(prepared.preview["params"]["closes_workspace"], "true");
        assert!(
            prepared.preview["summary"]
                .as_str()
                .unwrap()
                .contains("workspace will also close")
        );
        assert_eq!(status(&prepared.execute(None).await), "succeeded");
        assert_eq!(f.mutations(), ["workspace.close"]);
        assert!(f.called_with("workspace.close", json!({ "workspace_id": "w1" }), 30_000));
    }
}

#[tokio::test]
async fn blocks_multi_pane_worktree_roots_but_allows_linked_workspaces() {
    for kind in ["close_pane", "close_agent"] {
        for linked in [Some(false), None, Some(true)] {
            let f = fixture();
            f.use_agent();
            f.add_sibling();
            let root = f.root.clone();
            f.conn(|conn| {
                let mut worktree =
                    json!({ "repo_key": "repo", "repo_root": root, "checkout_path": root });
                if let Some(linked) = linked {
                    worktree["is_linked_worktree"] = json!(linked);
                }
                conn.workspaces[0]["worktree"] = worktree;
            });
            if linked == Some(true) {
                let prepared = f.prepare(kind, close_params(kind)).await.unwrap();
                assert_eq!(status(&prepared.execute(None).await), "succeeded");
                assert_eq!(f.mutations(), ["pane.close"]);
            } else {
                assert!(f.prepare(kind, close_params(kind)).await.is_err());
                assert!(f.mutations().is_empty());
            }
        }
    }
}

#[tokio::test]
async fn rechecks_worktree_root_identity() {
    for kind in CLOSE_KINDS {
        let f = fixture();
        f.use_agent();
        f.add_sibling();
        let root = f.root.clone();
        f.conn(|conn| {
            conn.workspaces[0]["worktree"] = json!({
                "repo_key": "repo",
                "repo_root": root,
                "checkout_path": root,
                "is_linked_worktree": true,
            })
        });
        let prepared = f.prepare(kind, close_params(kind)).await.unwrap();
        f.conn(|conn| conn.workspaces[0]["worktree"]["is_linked_worktree"] = json!(false));
        assert_eq!(status(&prepared.execute(None).await), "failed");
        assert!(f.mutations().is_empty());
    }
}

#[tokio::test]
async fn agent_close_rejects_an_empty_shell_and_all_close_tools_reject_extra_parameters() {
    let f = fixture();
    assert!(
        f.prepare("close_agent", json!({ "pane_id": "w1:p1" }))
            .await
            .is_err()
    );
    for kind in CLOSE_KINDS {
        for extra in [
            json!({ "force": "true" }),
            json!({ "close_group": "true" }),
            json!({ "remove_worktree": "true" }),
            json!({ "delete_history": "true" }),
            json!({ "cwd": "/other" }),
        ] {
            let params = merged(&close_params(kind), extra);
            assert!(f.prepare(kind, params).await.is_err());
        }
    }
    assert!(f.mutations().is_empty());
}

#[tokio::test]
async fn rejects_stale_workspace_membership_and_occupants() {
    for kind in CLOSE_KINDS {
        for change in [
            "add",
            "remove",
            "terminal",
            "session",
            "process",
            "directory",
            "label",
            "lease",
        ] {
            let f = fixture();
            f.use_agent();
            f.add_sibling();
            let prepared = f.prepare(kind, close_params(kind)).await.unwrap();
            match change {
                "add" => f.add_sibling(),
                "remove" => f.conn(|conn| {
                    conn.panes.pop();
                }),
                "terminal" => f.conn(|conn| conn.panes[0]["terminal_id"] = json!("replacement")),
                // The fixture's pane and agent share one session object.
                "session" => f.conn(|conn| {
                    conn.agent["agent_session"]["value"] = json!("replacement");
                    conn.panes[0]["agent_session"]["value"] = json!("replacement");
                }),
                "process" => f.conn(|conn| {
                    conn.process["foreground_processes"] =
                        json!([{ "pid": 404, "name": "replacement" }])
                }),
                "directory" => f.conn(|conn| conn.workspaces[0]["cwd"] = json!("/other")),
                "label" => f.conn(|conn| conn.workspaces[0]["label"] = json!("Renamed")),
                _ => f.retire(),
            }
            assert_eq!(
                status(&prepared.execute(None).await),
                "failed",
                "{kind} {change}"
            );
            assert!(f.mutations().is_empty());
        }
    }
}

#[tokio::test]
async fn workspace_close_rechecks_every_occupant_and_refuses_a_new_process_in_a_sibling() {
    let f = fixture();
    f.add_sibling();
    let prepared = f.prepare("close_workspace", json!({})).await.unwrap();
    f.over(|ctx| {
        let mut result = ctx.original();
        if ctx.method == "pane.process_info"
            && ctx.params["pane_id"] == "w1:p2"
            && let Ok(result) = &mut result
        {
            result["process_info"]["foreground_processes"] =
                json!([{ "pid": 505, "name": "new-job" }]);
        }
        ready(result)
    });
    assert_eq!(status(&prepared.execute(None).await), "failed");
    assert!(f.mutations().is_empty());
}

#[tokio::test]
async fn refuses_cross_workspace_and_missing_targets() {
    for kind in CLOSE_KINDS {
        let f = fixture();
        f.use_agent();
        let other = merged(&close_params(kind), json!({ "workspace_id": "other" }));
        assert!(f.prepare(kind, other).await.is_err());
        if kind != "close_workspace" {
            assert!(
                f.prepare(kind, json!({ "pane_id": "w2:p1" }))
                    .await
                    .is_err()
            );
            assert!(
                f.prepare(kind, json!({ "pane_id": "missing" }))
                    .await
                    .is_err()
            );
        }
        let prepared = f.prepare(kind, close_params(kind)).await.unwrap();
        f.conn(|conn| conn.workspaces.clear());
        assert_eq!(status(&prepared.execute(None).await), "failed");
        assert!(f.mutations().is_empty());
    }
}

#[tokio::test]
async fn checks_permission_again_at_native_dispatch() {
    for kind in CLOSE_KINDS {
        for invalidate in ["permission", "lease"] {
            let f = fixture();
            f.use_agent();
            f.add_sibling();
            let prepared = f.prepare(kind, close_params(kind)).await.unwrap();
            let (reached, release) = (Deferred::<()>::new(), Deferred::<()>::new());
            let pause = pausing(&reached, &release);
            f.over(move |ctx| {
                let pause = pause.clone();
                Box::pin(async move {
                    if is_close(&ctx.method) {
                        pause().await;
                    }
                    ctx.original()
                })
            });
            let (allowed, authorized) = allowed_flag();
            let pending = tokio::spawn(prepared.execute(Some(authorized)));
            reached.wait().await;
            if invalidate == "permission" {
                allowed.store(false, Ordering::SeqCst);
            } else {
                f.retire();
            }
            release.resolve(());
            assert_eq!(status(&pending.await.unwrap()), "failed");
            assert!(f.mutations().is_empty());
        }
    }
}

#[tokio::test]
async fn fails_without_readback_when_native_dispatch_never_sends() {
    for kind in CLOSE_KINDS {
        let f = fixture();
        f.use_agent();
        f.add_sibling();
        let prepared = f.prepare(kind, close_params(kind)).await.unwrap();
        let lists = f.calls_of("workspace.list").len();
        f.over(|ctx| {
            if is_close(&ctx.method) {
                return ready(fail("Synthetic connection refused"));
            }
            ready(ctx.original())
        });
        let result = prepared.execute(None).await;
        assert_eq!(status(&result), "failed");
        assert!(detail(&result).contains("Nothing was sent"));
        assert!(f.mutations().is_empty());
        assert_eq!(f.calls_of("workspace.list").len(), lists);
    }
}

#[tokio::test]
async fn verifies_lost_replies_without_repeating_the_close() {
    for kind in CLOSE_KINDS {
        let f = fixture();
        f.use_agent();
        f.add_sibling();
        let prepared = f.prepare(kind, close_params(kind)).await.unwrap();
        f.over(|ctx| {
            let result = ctx.original();
            if is_close(&ctx.method) {
                return ready(fail("Lost reply"));
            }
            ready(result)
        });
        let result = prepared.execute(None).await;
        assert_eq!(status(&result), "succeeded", "{kind}");
        assert_eq!(prepared.execute(None).await, result);
        assert_eq!(f.mutations().len(), 1);
    }
}

#[tokio::test]
async fn reports_unverified_completion_conservatively() {
    for kind in CLOSE_KINDS {
        for outcome in ["unchanged", "bad-list", "lost-lease"] {
            let f = fixture();
            f.use_agent();
            f.add_sibling();
            let prepared = f.prepare(kind, close_params(kind)).await.unwrap();
            let sent = Arc::new(AtomicBool::new(false));
            f.over(move |ctx| {
                if is_close(&ctx.method) {
                    let gate = ctx.before_send();
                    sent.store(true, Ordering::SeqCst);
                    ctx.fake
                        .with("local", |conn| conn.mutations.push(ctx.method.clone()));
                    if outcome == "lost-lease" {
                        ctx.fake.retire("local");
                    }
                    return ready(gate.map(|()| json!({ "type": "ok" })));
                }
                if sent.load(Ordering::SeqCst)
                    && outcome == "bad-list"
                    && ctx.method == "workspace.list"
                {
                    return ready(Ok(json!({ "workspaces": [{}] })));
                }
                ready(ctx.original())
            });
            let result = prepared.execute(None).await;
            assert_eq!(status(&result), "uncertain", "{kind} {outcome}");
            assert_eq!(prepared.execute(None).await, result);
            assert_eq!(f.mutations().len(), 1);
        }
    }
}

#[tokio::test]
async fn never_retries_a_refused_group_close() {
    for kind in ["close_workspace", "close_agent"] {
        let f = fixture();
        f.use_agent();
        let prepared = f.prepare(kind, close_params(kind)).await.unwrap();
        f.over(|ctx| {
            if ctx.method == "workspace.close" {
                let gate = ctx.before_send();
                ctx.fake
                    .with("local", |conn| conn.mutations.push(ctx.method.clone()));
                return ready(
                    gate.and_then(|()| fail("workspace_group_close_required: use --group")),
                );
            }
            ready(ctx.original())
        });
        let result = prepared.execute(None).await;
        assert_eq!(status(&result), "failed");
        assert!(detail(&result).contains("No group close was requested"));
        assert_eq!(prepared.execute(None).await, result);
        assert_eq!(f.conn(|conn| conn.panes.len()), 1);
        assert_eq!(f.mutations(), ["workspace.close"]);
    }
}

// ------------------------------------------------------------ Windows actions

#[tokio::test]
async fn create_worktree_refuses_unix_resource_helpers() {
    let f = fixture();
    f.conn(|conn| conn.remote_platform = Some("windows".into()));
    let scope = f.scope().await;
    f.conn(|conn| conn.calls.clear());
    let params = merged(&same_ref(), json!({ "branch": "feature" }));
    rejects(
        f.context
            .prepare("create_worktree", &scope, params, None)
            .await,
        "unavailable on Windows",
    );
    assert_eq!(f.conn(|conn| conn.git_root_calls), 0);
    assert_eq!(f.conn(|conn| conn.hooks_calls), 0);
    assert!(f.fake.worktree_calls.lock().unwrap().is_empty());
    // Only the native lease and workspace check runs before the refusal.
    assert_eq!(f.conn(|conn| conn.methods()), ["workspace.get"]);
    assert!(f.mutations().is_empty());
}

#[tokio::test]
async fn native_create_tab_keeps_working() {
    let f = fixture();
    f.conn(|conn| conn.remote_platform = Some("windows".into()));
    let prepared = f.prepare("create_tab", json!({})).await.unwrap();
    assert_eq!(status(&prepared.execute(None).await), "succeeded");
    assert_eq!(f.conn(|conn| conn.git_root_calls), 0);
    assert_eq!(f.conn(|conn| conn.hooks_calls), 0);
}
