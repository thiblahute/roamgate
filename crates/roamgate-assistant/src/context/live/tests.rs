//! context.test.ts, case for case, on a fake host in place of the fake
//! runtimes. An `AbortController` aborted with a reason becomes a cancelled
//! token, whose rejection is "aborted"; `Object.isFrozen` has nothing to
//! check here (a scope's workspaces are immutable behind its `Arc`).

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use roamgate_agents::js;
use roamgate_base::clock::TestClock;
use roamgate_connections::usage_limit::{LimitPause, LimitPauseState, PaneOwner};
use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;

use super::LiveContext;
use crate::context::fake::{CallCtx, Conn, Deferred, Fake, Reply, fail, flush, until};
use crate::context::{AssistantContext, CapturedScope, Scope};
use crate::errors::{AssistantError, AssistantResult};
use crate::tools::{Family, Handler, ToolResult, call_tool};
use crate::wire::{is_hex64, is_mention_catalog};

fn first() -> Value {
    json!({ "connection_id": "local", "workspace_id": "w1" })
}

/// `{...base, ...extra}`.
fn merged(base: &Value, extra: Value) -> Value {
    let mut out = base.clone();
    for (key, value) in extra.as_object().unwrap() {
        out[key] = value.clone();
    }
    out
}

fn fails<T>(result: AssistantResult<T>, text: &str) -> AssistantError {
    match result {
        Ok(_) => panic!("expected a rejection with {text:?}"),
        Err(error) => {
            assert!(
                error.message().contains(text),
                "{:?} does not contain {text:?}",
                error.message()
            );
            error
        }
    }
}

fn find<'a>(items: &'a [Value], key: &str, value: &Value) -> Option<&'a Value> {
    items.iter().find(|item| item.get(key) == Some(value))
}

/// context.test.ts's Herdr.
fn herdr(conn: &mut Conn, method: &str, params: &Value) -> AssistantResult<Value> {
    let found = |items: &[Value], key: &str, value: &Value| find(items, key, value).cloned();
    Ok(match method {
        "workspace.list" => json!({ "workspaces": conn.workspaces }),
        "workspace.get" => match found(&conn.workspaces, "workspace_id", &params["workspace_id"]) {
            Some(workspace) => json!({ "workspace": workspace }),
            None => json!({}),
        },
        "pane.list" => json!({ "panes": conn.panes }),
        "pane.get" => match found(&conn.panes, "pane_id", &params["pane_id"]) {
            Some(pane) => json!({ "pane": pane }),
            None => json!({}),
        },
        "agent.get" => match found(&conn.panes, "pane_id", &params["target"]) {
            Some(agent) => json!({ "agent": agent }),
            None => json!({}),
        },
        "pane.process_info" => json!({
            "process_info": {
                "pane_id": params["pane_id"],
                "shell_pid": 101,
                "foreground_processes": [{ "pid": 202, "name": "pi" }],
            },
        }),
        "pane.read" => json!({
            "type": "pane_read",
            "read": {
                "pane_id": "w1:p1",
                "workspace_id": "w1",
                "tab_id": "w1:t1",
                "text": "tests passed",
                "source": "recent",
                "truncated": false,
            },
        }),
        _ => return fail(&format!("Unexpected RPC {method}")),
    })
}

fn local(recovery: bool) -> Conn {
    let mut conn = Conn::new(1);
    if recovery {
        conn.fingerprint = Some("1".repeat(64));
    }
    conn.workspaces = vec![
        json!({
            "workspace_id": "w1",
            "label": "Allowed",
            "cwd": "/secret/repo",
            "agent_status": "working",
            "pane_count": 1,
            "tab_count": 1,
            "socket_path": "/secret/socket",
        }),
        json!({ "workspace_id": "w2", "label": "PRIVATE WORKSPACE", "agent_status": "blocked" }),
    ];
    conn.panes = vec![
        json!({
            "pane_id": "w1:p1",
            "workspace_id": "w1",
            "tab_id": "w1:t1",
            "terminal_id": "term1",
            "label": "Agent",
            "agent": "pi",
            "agent_status": "working",
            "agent_session": { "kind": "path", "value": "/secret/session" },
            "api_key": "private-key",
        }),
        json!({
            "pane_id": "w2:p1",
            "workspace_id": "w2",
            "tab_id": "w2:t1",
            "terminal_id": "term2",
            "label": "PRIVATE PANE",
            "agent": "codex",
            "agent_status": "blocked",
        }),
    ];
    conn.history_default = json!({
        "pane_id": "w1:p1",
        "workspace_id": "w1",
        "agent": "pi",
        "status": "ok",
        "updated_at": "2026-10-03T00:00:00.000Z",
        "path": "/secret/session.jsonl",
        "session": { "value": "secret-session-id" },
        "file": { "path": "/secret/session.jsonl" },
        "messages": [{
            "role": "assistant",
            "text": "The feature is ready",
            "sent_at": "2026-10-03T00:00:00.000Z",
        }],
    });
    conn.diff_summary_default = json!({
        "workspace_id": "w1",
        "root": "/secret/repo",
        "mode": "working",
        "baseline_available": true,
        "counts": { "staged": 0, "unstaged": 1 },
        "entries": [{ "path": "src/main.ts", "kind": "unstaged", "status": "M" }],
    });
    conn.diff_file_default = json!({
        "workspace_id": "w1",
        "root": "/secret/repo",
        "path": "src/main.ts",
        "kind": "unstaged",
        "diff": "+good change",
        "truncated": false,
    });
    conn
}

fn scoped(count: usize) -> Conn {
    let mut conn = local(true);
    conn.workspaces = (1..=count)
        .map(|index| {
            json!({
                "agent_status": "working",
                "pane_count": 1,
                "tab_count": 1,
                "socket_path": "/secret/socket",
                "workspace_id": format!("w{index}"),
                "label": format!("Workspace {index}"),
                "cwd": format!("/repo/{index}"),
            })
        })
        .collect();
    conn
}

fn context_of(fake: &Arc<Fake>) -> LiveContext {
    let clock = TestClock::new(js::date_parse("2026-11-09T00:00:00Z") as i64);
    LiveContext::new(fake.clone(), Arc::new(clock))
}

struct F {
    fake: Arc<Fake>,
    context: LiveContext,
}

impl F {
    fn of(conns: Vec<(&str, &str, Conn)>) -> Self {
        let fake = Fake::new(herdr);
        for (id, label, conn) in conns {
            fake.add(id, label, conn);
        }
        let context = context_of(&fake);
        Self { fake, context }
    }

    fn conn<T>(&self, f: impl FnOnce(&mut Conn) -> T) -> T {
        self.fake.with("local", f)
    }

    fn calls(&self) -> usize {
        self.conn(|conn| conn.calls.len())
    }

    fn last_call(&self) -> (String, Value, u64) {
        self.conn(|conn| conn.calls.last().cloned().unwrap())
    }

    fn retire(&self) {
        self.fake.retire("local");
    }

    fn replace_endpoint(&self) {
        self.conn(|conn| conn.fingerprint = Some("2".repeat(64)));
    }

    fn identity(&self, f: impl Fn(Arc<Fake>) -> Option<String> + Send + Sync + 'static) {
        let f = Arc::new(f);
        self.conn(|conn| {
            conn.identity = Arc::new(move |fake| {
                let value = f(fake);
                Box::pin(async move { Ok(value) })
            })
        });
    }

    fn pending_identity(&self, gate: Arc<Deferred<String>>) {
        self.conn(|conn| {
            conn.identity = Arc::new(move |_| {
                let wait = gate.wait();
                Box::pin(async move { Ok(Some(wait.await)) })
            })
        });
    }

    async fn capture(&self, refs: Value) -> AssistantResult<Scope> {
        self.context.capture_scope(refs, None, None).await
    }

    async fn read(&self, kind: &str, scope: &Scope, params: Value) -> AssistantResult<ToolResult> {
        self.context.read(kind, scope, params, None).await
    }

    fn reader(&self, scope: &Scope) -> Handler {
        let (context, scope) = (self.context.clone(), scope.clone());
        Arc::new(move |kind, params, signal| context.read(kind, &scope, params, signal))
    }
}

fn fixture(recovery: bool) -> F {
    F::of(vec![("local", "Local", local(recovery))])
}

fn scope_fixture(count: usize) -> (F, Value) {
    let f = F::of(vec![("local", "Local", scoped(count))]);
    (f, refs_of("local", count))
}

fn refs_of(connection: &str, count: usize) -> Value {
    Value::Array(
        (1..=count)
            .map(
                |index| json!({ "connection_id": connection, "workspace_id": format!("w{index}") }),
            )
            .collect(),
    )
}

fn parsed(result: &ToolResult) -> Value {
    serde_json::from_str(&result.text).unwrap()
}

fn ids(scope: &Scope) -> Vec<String> {
    scope
        .workspaces
        .as_array()
        .unwrap()
        .iter()
        .map(|item| item["workspace_id"].as_str().unwrap().to_owned())
        .collect()
}

fn forged(scope: &Scope) -> Scope {
    CapturedScope::plain(scope.workspaces.clone())
}

type Gate = Arc<Deferred<AssistantResult<Value>>>;

/// `gatedWorkspaceReads(f)`: every workspace.get waits for the test.
#[derive(Clone)]
struct Gated {
    fake: Arc<Fake>,
    connection: String,
    requests: Arc<Mutex<Vec<(String, Gate)>>>,
    active: Arc<AtomicUsize>,
    maximum: Arc<AtomicUsize>,
}

struct Active(Arc<AtomicUsize>);

impl Drop for Active {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::SeqCst);
    }
}

impl Gated {
    fn new(fake: &Arc<Fake>, connection: &str) -> Self {
        let gated = Self {
            fake: fake.clone(),
            connection: connection.to_owned(),
            requests: Arc::default(),
            active: Arc::default(),
            maximum: Arc::default(),
        };
        let inner = gated.clone();
        fake.with(connection, |conn| conn.calls.clear());
        fake.over(connection, move |ctx: CallCtx| -> Reply {
            assert_eq!(ctx.method, "workspace.get");
            let gate = Deferred::new();
            let workspace_id = ctx.params["workspace_id"].as_str().unwrap().to_owned();
            inner
                .requests
                .lock()
                .unwrap()
                .push((workspace_id, gate.clone()));
            let active = inner.active.fetch_add(1, Ordering::SeqCst) + 1;
            inner.maximum.fetch_max(active, Ordering::SeqCst);
            let guard = Active(inner.active.clone());
            Box::pin(async move {
                let _guard = guard;
                gate.wait().await
            })
        });
        gated
    }

    fn len(&self) -> usize {
        self.requests.lock().unwrap().len()
    }

    fn active(&self) -> usize {
        self.active.load(Ordering::SeqCst)
    }

    fn maximum(&self) -> usize {
        self.maximum.load(Ordering::SeqCst)
    }

    fn request(&self, index: usize) -> (String, Gate) {
        self.requests.lock().unwrap()[index].clone()
    }

    fn resolve(&self, index: usize) {
        let (workspace_id, gate) = self.request(index);
        let workspace = self.fake.with(&self.connection, |conn| {
            find(&conn.workspaces, "workspace_id", &json!(workspace_id)).cloned()
        });
        gate.resolve(Ok(json!({ "workspace": workspace })));
    }

    fn missing(&self, index: usize) {
        self.request(index).1.resolve(Ok(json!({})));
    }

    fn reject(&self, index: usize, message: &str) {
        self.request(index)
            .1
            .resolve(Err(AssistantError::internal(message)));
    }

    async fn wait_for(&self, count: usize) {
        until(|| self.len() >= count).await;
    }
}

fn spawned<T: Send + 'static>(
    work: crate::tools::BoxFuture<AssistantResult<T>>,
) -> tokio::task::JoinHandle<AssistantResult<()>> {
    tokio::spawn(async move { work.await.map(|_| ()) })
}

fn matches(value: &Value, expected: Value) {
    for (key, want) in expected.as_object().unwrap() {
        assert_eq!(&value[key], want, "{key} of {value}");
    }
}

// ------------------------------------------------------------ recovery scope

#[tokio::test]
async fn restores_the_same_endpoint_into_fresh_leases_without_exposing_private_identities() {
    let f = fixture(true);
    let captured = f.capture(json!([first()])).await.unwrap();
    let targets = f.context.recovery_scope(&captured, None).await.unwrap();
    let target = &targets[0];
    assert_eq!(targets.as_array().unwrap().len(), 1);
    assert_eq!(target["connection_id"], "local");
    assert_eq!(target["workspace_id"], "w1");
    assert_eq!(target["endpoint_fingerprint"], "1".repeat(64));
    assert_eq!(target["herdr_boot_id"], "boot-1");
    assert!(is_hex64(target["workspace_identity"].as_str().unwrap()));
    assert_eq!(target.as_object().unwrap().len(), 5);
    assert!(!targets.to_string().contains("/secret/"));
    f.retire();
    f.conn(|conn| conn.workspaces[0]["label"] = json!("Renamed"));
    let restored = f.context.restore_scope(targets, None).await.unwrap();
    assert_eq!(restored.workspaces[0]["runtime_generation"], 2);
    assert_eq!(restored.workspaces[0]["label"], "Renamed");
    let output = f.read("status", &restored, json!({})).await.unwrap();
    let text = json!([restored.workspaces, output.text, output.sources]).to_string();
    assert!(!text.contains("boot-1"));
    assert!(!text.contains("fingerprint"));
    fails(
        f.read("status", &captured, json!({})).await,
        "Connection changed",
    );
}

#[tokio::test]
async fn changed_endpoints_and_server_boots_reject_before_workspace_reads() {
    for change in ["endpoint", "boot"] {
        let f = fixture(true);
        let captured = f.capture(json!([first()])).await.unwrap();
        let targets = f.context.recovery_scope(&captured, None).await.unwrap();
        f.conn(|conn| conn.calls.clear());
        if change == "endpoint" {
            f.replace_endpoint();
        } else {
            f.identity(|_| Some("another-server-boot".into()));
        }
        fails(
            f.context.restore_scope(targets, None).await,
            if change == "endpoint" {
                "endpoint changed"
            } else {
                "server identity changed"
            },
        );
        assert_eq!(f.calls(), 0);
    }
}

#[tokio::test]
async fn same_id_workspace_replacement_rejects_both_capture_and_restore() {
    let f = fixture(true);
    let captured = f.capture(json!([first()])).await.unwrap();
    let targets = f.context.recovery_scope(&captured, None).await.unwrap();
    f.conn(|conn| conn.workspaces[0]["cwd"] = json!("/another/repo"));
    fails(
        f.context.recovery_scope(&captured, None).await,
        "workspace changed",
    );
    fails(
        f.context.restore_scope(targets.clone(), None).await,
        "workspace changed",
    );
    f.conn(|conn| {
        conn.workspaces[0]["cwd"] = json!("/secret/repo");
        conn.workspaces[0]["worktree"] =
            json!({ "repo_key": "another-repo", "checkout_path": "/secret/repo" });
    });
    fails(
        f.context.restore_scope(targets, None).await,
        "workspace changed",
    );
}

#[tokio::test]
async fn unsupported_identity_leaves_ordinary_reads_available_and_cannot_restore() {
    let f = fixture(true);
    let captured = f.capture(json!([first()])).await.unwrap();
    let targets = f.context.recovery_scope(&captured, None).await.unwrap();
    f.identity(|_| None);
    assert_eq!(
        f.context.recovery_scope(&captured, None).await.unwrap(),
        json!([])
    );
    let read = f.read("status", &captured, json!({})).await.unwrap();
    assert_eq!(read.sources.unwrap().len(), 1);
    fails(
        f.context.restore_scope(targets, None).await,
        "server identity changed",
    );
    let legacy = fixture(false);
    let scope = legacy.capture(json!([first()])).await.unwrap();
    assert_eq!(
        legacy.context.recovery_scope(&scope, None).await.unwrap(),
        json!([])
    );
    assert_eq!(legacy.conn(|conn| conn.identity_calls), 0);
}

#[tokio::test]
async fn not_ready_recovery_is_distinguishable_from_changed_or_invalid_targets() {
    let f = fixture(true);
    let captured = f.capture(json!([first()])).await.unwrap();
    let targets = f.context.recovery_scope(&captured, None).await.unwrap();
    f.fake.disconnect("local");
    let error = f
        .context
        .restore_scope(targets.clone(), None)
        .await
        .err()
        .unwrap();
    assert!(matches!(error, AssistantError::RecoveryNotReady(_)));
    f.replace_endpoint();
    fails(
        f.context.restore_scope(targets.clone(), None).await,
        "endpoint changed",
    );
    fails(f.context.restore_scope(json!([]), None).await, "Invalid");
    let target = targets[0].clone();
    let socket = merged(&target, json!({ "endpoint_fingerprint": "/socket" }));
    fails(
        f.context.restore_scope(json!([socket]), None).await,
        "Invalid",
    );
    let other = merged(
        &target,
        json!({ "workspace_id": "w2", "herdr_boot_id": "different" }),
    );
    fails(
        f.context.restore_scope(json!([target, other]), None).await,
        "Inconsistent",
    );
}

#[tokio::test]
async fn aborting_an_identity_probe_rejects_promptly_and_stale_leases_cannot_resume() {
    for operation in ["capture", "restore"] {
        let f = fixture(true);
        let captured = f.capture(json!([first()])).await.unwrap();
        let targets = f.context.recovery_scope(&captured, None).await.unwrap();
        let pending = Deferred::<String>::new();
        f.pending_identity(pending.clone());
        let token = CancellationToken::new();
        let work = if operation == "capture" {
            spawned(f.context.recovery_scope(&captured, Some(token.clone())))
        } else {
            spawned(f.context.restore_scope(targets, Some(token.clone())))
        };
        flush().await;
        token.cancel();
        fails(work.await.unwrap(), "aborted");
        pending.resolve("boot-1".into());
    }
    let f = fixture(true);
    let captured = f.capture(json!([first()])).await.unwrap();
    let targets = f.context.recovery_scope(&captured, None).await.unwrap();
    f.identity(|fake| {
        fake.retire("local");
        Some("boot-1".into())
    });
    fails(
        f.context.restore_scope(targets, None).await,
        "Connection changed",
    );
}

#[tokio::test]
async fn recovery_admission_snapshots_its_input_and_rechecks_endpoint_changes() {
    let f = fixture(true);
    let captured = f.capture(json!([first()])).await.unwrap();
    let mut targets = f.context.recovery_scope(&captured, None).await.unwrap();
    let pending = Deferred::<String>::new();
    f.pending_identity(pending.clone());
    let work = tokio::spawn(f.context.restore_scope(targets.clone(), None));
    flush().await;
    targets[0]["herdr_boot_id"] = json!("mutated-by-caller");
    targets[0]["workspace_id"] = json!("w2");
    pending.resolve("boot-1".into());
    assert_eq!(ids(&work.await.unwrap().unwrap()), ["w1"]);
    let captured = f.capture(json!([first()])).await.unwrap();
    f.identity(|fake| {
        fake.with("local", |conn| conn.fingerprint = Some("2".repeat(64)));
        Some("boot-1".into())
    });
    fails(
        f.context.recovery_scope(&captured, None).await,
        "endpoint changed",
    );
}

// ------------------------------------------------------------ widening

#[tokio::test]
async fn adds_a_workspace_to_a_captured_scope_keeping_the_held_ones() {
    let f = fixture(false);
    let captured = f.capture(json!([first()])).await.unwrap();
    let second = json!({ "connection_id": "local", "workspace_id": "w2" });
    assert!(f.read("status", &captured, second.clone()).await.is_err());
    let widened = f
        .context
        .extend_scope(&captured, json!([first(), second]), None)
        .await
        .unwrap();
    assert_eq!(ids(&widened), ["w1", "w2"]);
    let again = f
        .context
        .extend_scope(&widened, json!([second]), None)
        .await
        .unwrap();
    assert!(Arc::ptr_eq(&again, &widened));
    let output = f.read("status", &widened, second.clone()).await.unwrap();
    assert!(output.text.contains("PRIVATE WORKSPACE"));
    // A reconnected connection does not mix leases into an older scope.
    let stale = f.capture(json!([first()])).await.unwrap();
    f.retire();
    fails(
        f.context.extend_scope(&stale, json!([second]), None).await,
        "changed",
    );
}

#[tokio::test]
async fn refuses_a_scope_it_did_not_capture() {
    let f = fixture(false);
    let scope = CapturedScope::plain(json!([merged(
        &first(),
        json!({ "connection_label": "L", "label": "A", "runtime_generation": 1 })
    )]));
    fails(
        f.context.extend_scope(&scope, json!([first()]), None).await,
        "not approved",
    );
}

// ------------------------------------------------------------ bounded validation

async fn finish_in_reverse_batches(reads: &Gated) {
    for start in (0..512).step_by(8) {
        reads.wait_for(start + 8).await;
        assert_eq!(reads.active(), 8);
        for index in (start..start + 8).rev() {
            reads.resolve(index);
        }
    }
}

#[tokio::test]
async fn capture_recovery_and_restore_keep_512_workspace_and_identity_results_ordered_with_at_most_eight_reads()
 {
    let (f, refs) = scope_fixture(512);
    let reads = Gated::new(&f.fake, "local");
    let capturing = tokio::spawn(f.context.capture_scope(refs.clone(), None, None));
    finish_in_reverse_batches(&reads).await;
    let captured = capturing.await.unwrap().unwrap();
    let expected: Vec<String> = (1..=512).map(|index| format!("w{index}")).collect();
    assert_eq!(ids(&captured), expected);
    assert_eq!(reads.maximum(), 8);
    assert_eq!(reads.active(), 0);
    assert_eq!(f.conn(|conn| conn.lease_calls), 1);

    let reads = Gated::new(&f.fake, "local");
    let recovering = tokio::spawn(f.context.recovery_scope(&captured, None));
    finish_in_reverse_batches(&reads).await;
    let targets = recovering.await.unwrap().unwrap();
    assert_eq!(reads.maximum(), 8);
    assert_eq!(reads.active(), 0);
    assert_eq!(f.conn(|conn| conn.identity_calls), 1);
    let expected_targets: Vec<Value> = (1..=512)
        .map(|index| {
            let identity = json!([format!("/repo/{index}"), null, null, null]);
            json!({
                "connection_id": "local",
                "workspace_id": format!("w{index}"),
                "endpoint_fingerprint": "1".repeat(64),
                "herdr_boot_id": "boot-1",
                "workspace_identity": super::sha256_hex(&js::stringify(&identity)),
            })
        })
        .collect();
    assert_eq!(targets, Value::Array(expected_targets));

    let reads = Gated::new(&f.fake, "local");
    let restoring = tokio::spawn(f.context.restore_scope(targets, None));
    finish_in_reverse_batches(&reads).await;
    let restored = restoring.await.unwrap().unwrap();
    assert_eq!(restored.workspaces, captured.workspaces);
    assert_eq!(reads.maximum(), 8);
    assert_eq!(reads.active(), 0);
    assert_eq!(f.conn(|conn| conn.lease_calls), 2);
    assert_eq!(f.conn(|conn| conn.identity_calls), 2);
}

#[tokio::test]
async fn concurrent_scope_failures_preserve_the_first_error_stop_queued_reads_and_expose_no_partial_scope()
 {
    for operation in ["capture", "recovery", "restore"] {
        for change in [
            "abort",
            "retire",
            "disconnect",
            "missing",
            "transport",
            "identity",
        ] {
            if operation == "capture" && change == "identity" {
                continue;
            }
            let (f, refs) = scope_fixture(24);
            let captured = f.capture(refs.clone()).await.unwrap();
            let targets = f.context.recovery_scope(&captured, None).await.unwrap();
            let reads = Gated::new(&f.fake, "local");
            let token = CancellationToken::new();
            let signal = Some(token.clone());
            let pending = match operation {
                "capture" => spawned(f.context.capture_scope(refs.clone(), signal, None)),
                "recovery" => spawned(f.context.recovery_scope(&captured, signal)),
                _ => spawned(f.context.restore_scope(targets, signal)),
            };
            reads.wait_for(8).await;
            let message = match change {
                "abort" => {
                    token.cancel();
                    "aborted"
                }
                "retire" | "disconnect" => {
                    if change == "retire" {
                        f.retire();
                    } else {
                        f.fake.disconnect("local");
                    }
                    reads.resolve(2);
                    "Connection changed"
                }
                "missing" => {
                    reads.missing(2);
                    "Workspace w3 is no longer available"
                }
                "transport" => {
                    reads.reject(2, "SECRET /private/socket");
                    "Unable to read workspace w3"
                }
                _ => {
                    f.conn(|conn| conn.workspaces[2]["cwd"] = json!("/replaced/repo"));
                    reads.resolve(2);
                    "Ranger recovery workspace changed"
                }
            };
            fails(pending.await.unwrap(), message);
            assert_eq!(reads.len(), 8);
            for index in 0..8 {
                if index == 4 {
                    reads.reject(index, "A later failure");
                } else {
                    reads.resolve(index);
                }
            }
            flush().await;
            assert_eq!(reads.active(), 0);
            assert_eq!(reads.len(), 8);
            let leases = if operation == "recovery" { 1 } else { 2 };
            assert_eq!(f.conn(|conn| conn.lease_calls), leases);
            fails(
                f.read("status", &forged(&captured), json!({})).await,
                "not approved",
            );
        }
    }
}

#[tokio::test]
async fn endpoint_changes_while_parallel_validation_is_pending_reject_recovery_and_restore() {
    for operation in ["recovery", "restore"] {
        let (f, refs) = scope_fixture(8);
        let captured = f.capture(refs).await.unwrap();
        let targets = f.context.recovery_scope(&captured, None).await.unwrap();
        let reads = Gated::new(&f.fake, "local");
        let pending = if operation == "recovery" {
            spawned(f.context.recovery_scope(&captured, None))
        } else {
            spawned(f.context.restore_scope(targets, None))
        };
        reads.wait_for(8).await;
        f.replace_endpoint();
        for index in 0..8 {
            reads.resolve(index);
        }
        fails(pending.await.unwrap(), "endpoint changed");
        assert_eq!(reads.len(), 8);
        assert_eq!(reads.active(), 0);
    }
}

#[tokio::test]
async fn the_final_boundary_rejects_an_earlier_connection_retired_while_another_connection_is_still_reading()
 {
    for operation in ["capture", "recovery", "restore"] {
        let mut fast = scoped(4);
        fast.fingerprint = Some("1".repeat(64));
        let mut slow = scoped(8);
        slow.fingerprint = Some("2".repeat(64));
        let f = F::of(vec![("fast", "Fast", fast), ("slow", "Slow", slow)]);
        let mut refs = refs_of("fast", 4).as_array().unwrap().clone();
        refs.extend(refs_of("slow", 8).as_array().unwrap().iter().cloned());
        let refs = Value::Array(refs);
        let captured = f.capture(refs.clone()).await.unwrap();
        let targets = f.context.recovery_scope(&captured, None).await.unwrap();
        let fast_reads = Gated::new(&f.fake, "fast");
        let slow_reads = Gated::new(&f.fake, "slow");
        let pending = match operation {
            "capture" => spawned(f.context.capture_scope(refs, None, None)),
            "recovery" => spawned(f.context.recovery_scope(&captured, None)),
            _ => spawned(f.context.restore_scope(targets, None)),
        };
        fast_reads.wait_for(4).await;
        slow_reads.wait_for(4).await;
        for index in 0..4 {
            fast_reads.resolve(index);
        }
        slow_reads.wait_for(8).await;
        assert_eq!(fast_reads.active(), 0);
        f.fake.retire("fast");
        for index in 0..8 {
            slow_reads.resolve(index);
        }
        fails(pending.await.unwrap(), "Connection changed");
        assert_eq!(fast_reads.active() + slow_reads.active(), 0);
        let expected = if operation == "capture" { 1 } else { 2 };
        assert_eq!(f.fake.with("fast", |conn| conn.identity_calls), expected);
        assert_eq!(f.fake.with("slow", |conn| conn.identity_calls), expected);
    }
}

#[tokio::test]
async fn one_shared_pending_boot_probe_gates_parallel_workspace_reads_and_changed_boots_reject_all_workers()
 {
    let (f, refs) = scope_fixture(24);
    let captured = f.capture(refs).await.unwrap();
    let targets = f.context.recovery_scope(&captured, None).await.unwrap();
    f.conn(|conn| conn.identity_calls = 0);
    let boot = Deferred::<String>::new();
    f.pending_identity(boot.clone());
    let reads = Gated::new(&f.fake, "local");
    let pending = tokio::spawn(f.context.restore_scope(targets, None));
    flush().await;
    assert_eq!(f.conn(|conn| conn.identity_calls), 1);
    assert_eq!(reads.len(), 0);
    boot.resolve("changed-boot".into());
    fails(pending.await.unwrap(), "server identity changed");
    assert_eq!(reads.len(), 0);
    assert_eq!(f.conn(|conn| conn.identity_calls), 1);
}

// ------------------------------------------------------------ approved context

fn not_listed(label: &str, connection_ids: Value) -> Value {
    json!({
        "workspaces": [],
        "errors": [format!("Unable to list workspaces for connection {label}")],
        "connection_ids": connection_ids,
        "complete_connection_ids": [],
        "truncated": false,
    })
}

#[tokio::test]
async fn catalog_exposes_only_workspace_metadata_and_reports_disconnected_connections() {
    let f = fixture(false);
    assert_eq!(
        f.context.catalog().await.unwrap(),
        json!({
            "workspaces": [
                {
                    "connection_id": "local",
                    "workspace_id": "w1",
                    "connection_label": "Local",
                    "label": "Allowed",
                    "runtime_generation": 1,
                },
                {
                    "connection_id": "local",
                    "workspace_id": "w2",
                    "connection_label": "Local",
                    "label": "PRIVATE WORKSPACE",
                    "runtime_generation": 1,
                },
            ],
            "errors": [],
            "connection_ids": ["local"],
            "complete_connection_ids": ["local"],
            "truncated": false,
        })
    );
    f.fake.disconnect("local");
    assert_eq!(
        f.context.catalog().await.unwrap(),
        json!({
            "workspaces": [],
            "errors": ["Connection Local is not ready"],
            "connection_ids": ["local"],
            "complete_connection_ids": [],
            "truncated": false,
        })
    );
}

#[tokio::test]
async fn catalog_reads_connections_independently_keeps_healthy_results_and_bounds_lists() {
    let f = F::of(vec![
        ("healthy", "Healthy", local(false)),
        ("broken", "Broken", local(false)),
    ]);
    let gate = Deferred::<AssistantResult<Value>>::new();
    let wait = gate.wait();
    f.fake.once("healthy", move |_| wait);
    f.fake.once("broken", |_| {
        Box::pin(async { fail("api_key=SECRET /private/socket") })
    });
    let pending = tokio::spawn(f.context.catalog());
    until(|| {
        f.fake.with("healthy", |conn| conn.calls.len()) == 1
            && f.fake.with("broken", |conn| conn.calls.len()) == 1
    })
    .await;
    let workspaces = f.fake.with("healthy", |conn| conn.workspaces.clone());
    gate.resolve(Ok(json!({ "workspaces": workspaces })));
    let result = pending.await.unwrap().unwrap();
    assert_eq!(result["workspaces"].as_array().unwrap().len(), 2);
    assert_eq!(result["workspaces"][0]["connection_id"], "healthy");
    assert_eq!(
        result["errors"],
        json!(["Unable to list workspaces for connection Broken"])
    );
    assert_eq!(result["connection_ids"], json!(["healthy", "broken"]));
    assert_eq!(result["complete_connection_ids"], json!(["healthy"]));
    assert_eq!(result["truncated"], false);
    assert!(!result.to_string().contains("SECRET"));
    assert!(!result.to_string().contains("/private/socket"));
    let healthy = fixture(false);
    healthy.conn(|conn| {
        let template = conn.workspaces[0].clone();
        for index in 0..600 {
            let id = json!({ "workspace_id": format!("w{}", index + 3) });
            conn.workspaces.push(merged(&template, id));
        }
    });
    let bounded = healthy.context.catalog().await.unwrap();
    assert_eq!(bounded["workspaces"].as_array().unwrap().len(), 512);
    assert!(bounded["errors"][0].as_str().unwrap().contains("truncated"));
    assert_eq!(bounded["complete_connection_ids"], json!([]));
    assert_eq!(bounded["truncated"], true);
}

#[tokio::test]
async fn empty_successful_listings_and_removed_connections_are_authoritative() {
    let f = fixture(false);
    f.conn(|conn| conn.workspaces.clear());
    assert_eq!(
        f.context.catalog().await.unwrap(),
        json!({
            "workspaces": [],
            "errors": [],
            "connection_ids": ["local"],
            "complete_connection_ids": ["local"],
            "truncated": false,
        })
    );
    f.fake.catalog.lock().unwrap().clear();
    let context = context_of(&f.fake);
    assert_eq!(
        context.catalog().await.unwrap(),
        json!({
            "workspaces": [],
            "errors": [],
            "connection_ids": [],
            "complete_connection_ids": [],
            "truncated": false,
        })
    );
    assert_eq!(f.conn(|conn| conn.lease_calls), 1);
}

#[tokio::test]
async fn malformed_or_duplicate_workspace_records_cannot_establish_removals() {
    for payload in [
        json!(null),
        json!({}),
        json!({ "workspaces": null }),
        json!({ "workspaces": [null] }),
        json!({ "workspaces": [{ "workspace_id": "w1" }, false] }),
        json!({ "workspaces": [{ "workspace_id": "w1" }, {}] }),
        json!({ "workspaces": [{ "workspace_id": "w1" }, { "workspace_id": "invalid/id" }] }),
        json!({ "workspaces": [{ "workspace_id": "w1" }, { "workspace_id": "w1" }] }),
        // `new Array(1)`: a hole, which JSON writes as null.
        json!({ "workspaces": [null] }),
    ] {
        let f = fixture(false);
        f.fake.resolve_once("local", payload);
        assert_eq!(
            f.context.catalog().await.unwrap(),
            not_listed("Local", json!(["local"]))
        );
    }
}

#[tokio::test]
async fn catalog_completeness_respects_the_exact_per_connection_bound() {
    let f = fixture(false);
    let workspaces: Vec<Value> = (0..513)
        .map(|index| {
            json!({ "workspace_id": format!("w{index}"), "label": format!("Workspace {index}") })
        })
        .collect();
    f.fake
        .resolve_once("local", json!({ "workspaces": workspaces[..512] }));
    let complete = f.context.catalog().await.unwrap();
    assert_eq!(complete["workspaces"].as_array().unwrap().len(), 512);
    assert_eq!(complete["complete_connection_ids"], json!(["local"]));
    assert_eq!(complete["truncated"], false);
    assert_eq!(complete["errors"], json!([]));
    f.fake
        .resolve_once("local", json!({ "workspaces": workspaces }));
    let partial = f.context.catalog().await.unwrap();
    assert_eq!(partial["workspaces"].as_array().unwrap().len(), 512);
    assert_eq!(partial["complete_connection_ids"], json!([]));
    assert_eq!(partial["truncated"], true);
    assert_eq!(
        partial["errors"],
        json!(["Workspace list for connection Local was truncated to 512 entries"])
    );
}

#[tokio::test]
async fn global_truncation_invalidates_all_connection_completeness() {
    for total in [512, 513] {
        let f = F::of(vec![
            ("first", "First", local(false)),
            ("second", "Second", local(false)),
        ]);
        let entries: Vec<Value> = (0..total)
            .map(|index| json!({ "workspace_id": format!("w{index}") }))
            .collect();
        f.fake
            .resolve_once("first", json!({ "workspaces": entries[..256] }));
        f.fake
            .resolve_once("second", json!({ "workspaces": entries[256..] }));
        let result = f.context.catalog().await.unwrap();
        assert_eq!(result["workspaces"].as_array().unwrap().len(), 512);
        assert_eq!(result["connection_ids"], json!(["first", "second"]));
        let complete = if total == 512 {
            json!(["first", "second"])
        } else {
            json!([])
        };
        assert_eq!(result["complete_connection_ids"], complete);
        assert_eq!(result["truncated"], total > 512);
        let errors = if total == 512 {
            json!([])
        } else {
            json!(["Workspace catalog was truncated to 512 entries"])
        };
        assert_eq!(result["errors"], errors);
    }
}

#[tokio::test]
async fn catalog_uses_the_final_configured_connections_and_omits_removed_listings() {
    let f = fixture(false);
    let gate = Deferred::<AssistantResult<Value>>::new();
    let wait = gate.wait();
    f.fake.once("local", move |_| wait);
    let pending = tokio::spawn(f.context.catalog());
    until(|| f.calls() == 1).await;
    *f.fake.catalog.lock().unwrap() = vec![json!({ "id": "added", "label": "Added" })];
    let workspaces = f.conn(|conn| conn.workspaces.clone());
    gate.resolve(Ok(json!({ "workspaces": workspaces })));
    assert_eq!(
        pending.await.unwrap().unwrap(),
        not_listed("Local", json!(["added"]))
    );
}

#[tokio::test]
async fn catalog_rechecks_successful_leases_after_slower_connections_finish() {
    for change in ["retire", "disconnect", "endpoint"] {
        let fast = local(true);
        let mut slow = local(false);
        slow.fingerprint = Some("2".repeat(64));
        let f = F::of(vec![("fast", "Fast", fast), ("slow", "Slow", slow)]);
        let gate = Deferred::<AssistantResult<Value>>::new();
        let read_finished = Deferred::<()>::new();
        let wait = gate.wait();
        f.fake.once("slow", move |_| wait);
        let finished = read_finished.clone();
        *f.fake.on_check.lock().unwrap() = Some(Arc::new(move |connection, checks| {
            if connection == "fast" && checks == 2 {
                finished.resolve(());
            }
        }));
        let pending = tokio::spawn(f.context.catalog());
        read_finished.wait().await;
        match change {
            "endpoint" => f
                .fake
                .with("fast", |conn| conn.fingerprint = Some("3".repeat(64))),
            "retire" => f.fake.retire("fast"),
            _ => f.fake.disconnect("fast"),
        }
        let workspaces = f.fake.with("slow", |conn| conn.workspaces.clone());
        gate.resolve(Ok(json!({ "workspaces": workspaces })));
        let result = pending.await.unwrap().unwrap();
        let listed = result["workspaces"].as_array().unwrap();
        assert_eq!(listed.len(), 2);
        assert!(listed.iter().all(|item| item["connection_id"] == "slow"));
        assert_eq!(result["connection_ids"], json!(["fast", "slow"]));
        assert_eq!(result["complete_connection_ids"], json!(["slow"]));
        assert_eq!(
            result["errors"],
            json!(["Unable to list workspaces for connection Fast"])
        );
    }
}

#[tokio::test]
async fn scope_captures_512_workspaces_and_rejects_513_before_reading() {
    let f = fixture(false);
    f.conn(|conn| {
        let template = conn.workspaces[0].clone();
        for index in 0..510 {
            let id = json!({ "workspace_id": format!("w{}", index + 3) });
            conn.workspaces.push(merged(&template, id));
        }
    });
    let refs = refs_of("local", 512);
    let captured = f.capture(refs.clone()).await.unwrap();
    assert_eq!(captured.len(), 512);
    assert_eq!(captured.workspaces[511]["workspace_id"], "w512");
    assert_eq!(f.conn(|conn| conn.lease_calls), 1);
    f.conn(|conn| conn.calls.clear());
    let mut more = refs.as_array().unwrap().clone();
    more.push(json!({ "connection_id": "local", "workspace_id": "w513" }));
    fails(
        f.capture(Value::Array(more)).await,
        "Choose between 1 and 512",
    );
    assert_eq!(f.calls(), 0);
}

#[tokio::test]
async fn scope_requires_explicit_valid_ready_workspaces() {
    let f = fixture(false);
    let with = |extra: Value| json!([merged(&first(), extra)]);
    fails(f.capture(json!([])).await, "Choose between");
    fails(
        f.capture(with(json!({ "connection_id": "" }))).await,
        "Invalid connection_id",
    );
    fails(
        f.capture(with(json!({ "workspace_id": "w".repeat(129) })))
            .await,
        "Invalid workspace_id",
    );
    fails(
        f.capture(with(json!({ "connection_id": "other" }))).await,
        "Unknown connection",
    );
    fails(
        f.capture(with(json!({ "workspace_id": "missing" }))).await,
        "no longer available",
    );
    fails(f.capture(json!([first(), first()])).await, "Duplicate");
    f.fake.disconnect("local");
    fails(f.capture(json!([first()])).await, "not ready");
}

#[tokio::test]
async fn capture_clones_requested_refs_before_waiting_and_freezes_turn_scope() {
    let f = fixture(false);
    let gate = Deferred::<AssistantResult<Value>>::new();
    let wait = gate.wait();
    f.fake.once("local", move |_| wait);
    let mut refs = json!([first(), merged(&first(), json!({ "workspace_id": "w2" }))]);
    let pending = tokio::spawn(f.context.capture_scope(refs.clone(), None, None));
    flush().await;
    refs[1]["workspace_id"] = json!("changed");
    let workspace = f.conn(|conn| conn.workspaces[0].clone());
    gate.resolve(Ok(json!({ "workspace": workspace })));
    let captured = pending.await.unwrap().unwrap();
    assert_eq!(captured.workspaces[1]["workspace_id"], "w2");
}

#[tokio::test]
async fn stopping_scope_admission_rejects_promptly_and_never_dispatches_queued_workspaces() {
    let (f, refs) = scope_fixture(24);
    let reads = Gated::new(&f.fake, "local");
    let token = CancellationToken::new();
    let pending = tokio::spawn(f.context.capture_scope(refs, Some(token.clone()), None));
    reads.wait_for(8).await;
    assert_eq!(reads.len(), 8);
    token.cancel();
    fails(pending.await.unwrap(), "aborted");
    assert_eq!(reads.len(), 8);
    assert_eq!(f.conn(|conn| conn.lease_calls), 1);
    for index in 0..8 {
        reads.resolve(index);
    }
    flush().await;
    assert_eq!(reads.active(), 0);
    assert_eq!(reads.len(), 8);
    fails(
        f.context
            .capture_scope(json!([first()]), Some(token), None)
            .await,
        "aborted",
    );
    assert_eq!(reads.len(), 8);
}

#[tokio::test]
async fn status_tells_of_a_pane_a_usage_limit_paused_and_when_it_resumes() {
    let resets_at = js::date_parse("2026-11-07T04:40:00Z") as i64;
    let mut conn = local(false);
    conn.pauses = vec![LimitPause {
        connection_id: "local".into(),
        pane_id: "w1:p1".into(),
        session_id: "s1".into(),
        owner: PaneOwner::Terminal,
        kind: "five_hour".into(),
        resets_at,
        resume_at: Some(resets_at + 60_000),
        stopped_at: None,
        state: LimitPauseState::Scheduled,
        resumed_at: None,
        reason: None,
        message: "You've hit your 5-hour limit".into(),
    }];
    let f = F::of(vec![("local", "Local", conn)]);
    let captured = f.capture(json!([first()])).await.unwrap();
    let result = f.read("status", &captured, json!({})).await.unwrap();
    assert_eq!(
        parsed(&result)[0]["panes"][0]["usage_limit"],
        json!({
            "paused_by": "5-hour usage limit",
            "resets_at": "2026-11-07T04:40:00.000Z",
            "resumes_at": "2026-11-07T04:41:00.000Z",
            "state": "scheduled",
        })
    );
}

#[tokio::test]
async fn status_includes_only_approved_topology_and_safe_fields() {
    let f = fixture(false);
    let captured = f.capture(json!([first()])).await.unwrap();
    let result = f.read("status", &captured, json!({})).await.unwrap();
    let status = &parsed(&result)[0];
    assert_eq!(
        status["panes"],
        json!([{
            "pane_id": "w1:p1",
            "tab_id": "w1:t1",
            "label": "Agent",
            "agent": "pi",
            "agent_status": "working",
        }])
    );
    assert!(!result.text.contains("PRIVATE"));
    assert!(!result.text.contains("secret"));
    let source = &result.sources.as_ref().unwrap()[0];
    matches(
        source,
        merged(
            &first(),
            json!({ "kind": "status", "runtime_generation": 1 }),
        ),
    );
    assert!(js::date_parse(source["read_at"].as_str().unwrap()).is_finite());
    assert!(f.conn(|conn| conn.history_calls.is_empty()));
    assert_eq!(
        f.last_call(),
        ("pane.list".into(), json!({ "workspace_id": "w1" }), 5000)
    );
}

#[tokio::test]
async fn other_connections_workspaces_panes_and_forged_scopes_are_denied() {
    let f = fixture(false);
    let captured = f.capture(json!([first()])).await.unwrap();
    let with = |extra: Value| merged(&first(), extra);
    fails(
        f.read("status", &captured, with(json!({ "workspace_id": "w2" })))
            .await,
        "outside",
    );
    fails(
        f.read(
            "status",
            &captured,
            with(json!({ "connection_id": "other" })),
        )
        .await,
        "outside",
    );
    fails(
        f.read("status", &captured, json!({ "workspace_id": "w1" }))
            .await,
        "Invalid connection_id",
    );
    fails(
        f.read("history", &captured, with(json!({ "pane_id": "w2:p1" })))
            .await,
        "outside",
    );
    fails(
        f.read("status", &forged(&captured), json!({})).await,
        "not approved",
    );
    assert!(f.conn(|conn| conn.history_calls.is_empty()));
}

#[tokio::test]
async fn history_is_pane_scoped_without_transcript_paths_or_arbitrary_parameters() {
    let f = fixture(false);
    let captured = f.capture(json!([first()])).await.unwrap();
    let pane = merged(&first(), json!({ "pane_id": "w1:p1" }));
    let result = f.read("history", &captured, pane.clone()).await.unwrap();
    assert!(result.text.contains("The feature is ready"));
    assert!(!result.text.contains("secret"));
    assert_eq!(
        f.conn(|conn| conn.history_calls.clone()),
        [json!({ "pane_id": "w1:p1", "workspace_id": "w1" })]
    );
    matches(
        &result.sources.unwrap()[0],
        json!({ "kind": "history", "pane_id": "w1:p1" }),
    );
    fails(
        f.read(
            "history",
            &captured,
            merged(&pane, json!({ "path": "/secret/session" })),
        )
        .await,
        "Unsupported",
    );
    f.conn(|conn| {
        conn.history.push_back(Box::new(|_, _| {
            Box::pin(async {
                Ok(json!({
                    "pane_id": "w1:p1",
                    "workspace_id": "w2",
                    "messages": [{ "text": "PRIVATE" }],
                }))
            })
        }))
    });
    fails(
        f.read("history", &captured, pane).await,
        "changed workspace",
    );
}

#[tokio::test]
async fn large_history_reads_retain_the_newest_messages_within_the_text_budget() {
    let f = fixture(false);
    let captured = f.capture(json!([first()])).await.unwrap();
    let start = js::date_parse("2026-11-09T00:00:00Z") as i64;
    let sent_at = |index: i64| js::iso((start + index * 60_000) as f64);
    let messages: Vec<Value> = (0..80)
        .map(|index| {
            let latest = if index == 79 {
                "LATEST: the MR was merged. "
            } else {
                ""
            };
            json!({
                "role": if index % 2 == 1 { "assistant" } else { "user" },
                "sent_at": sent_at(index),
                "text": format!("{latest}{}", "x".repeat(700)),
            })
        })
        .collect();
    let history = json!({
        "pane_id": "w1:p1",
        "workspace_id": "w1",
        "agent": "claude",
        "status": "ok",
        "updated_at": sent_at(79),
        "messages": messages,
    });
    f.conn(|conn| {
        conn.history
            .push_back(Box::new(move |_, _| Box::pin(async move { Ok(history) })))
    });
    let result = f
        .read(
            "history",
            &captured,
            merged(&first(), json!({ "pane_id": "w1:p1" })),
        )
        .await
        .unwrap();
    assert!(js::len16(&result.text) <= 32_000);
    let output = &parsed(&result)[0];
    let kept = output["messages"].as_array().unwrap();
    let latest = kept.last().unwrap();
    assert_eq!(latest["sent_at"], sent_at(79));
    assert!(
        latest["text"]
            .as_str()
            .unwrap()
            .starts_with("LATEST: the MR was merged.")
    );
    assert!(kept[0]["sent_at"].as_str().unwrap() > sent_at(0).as_str());
    assert_eq!(output["truncated"], true);
    assert!(
        output["warning"]
            .as_str()
            .unwrap()
            .contains("partial evidence")
    );
}

#[tokio::test]
async fn diff_validates_paths_and_the_public_tool_forwards_working_tree_change_kinds() {
    let f = fixture(false);
    let captured = f.capture(json!([first()])).await.unwrap();
    for path in [
        "../secret",
        "/secret",
        "C:\\secret",
        "\\secret",
        "src/../../secret",
        ":(glob)**",
        "bad\0path",
    ] {
        let params = merged(&first(), json!({ "path": path }));
        assert!(f.read("diff", &captured, params).await.is_err());
    }
    fails(
        f.read(
            "diff",
            &captured,
            merged(&first(), json!({ "scope": "filesystem" })),
        )
        .await,
        "Unsupported",
    );
    fails(
        f.read(
            "diff",
            &captured,
            merged(&first(), json!({ "mode": "arbitrary" })),
        )
        .await,
        "Invalid diff mode",
    );
    assert!(f.conn(|conn| conn.diff_file_calls.is_empty()));
    let read = f.reader(&captured);
    let summary = call_tool(Family::Workspace, "workspace_diff", first(), &read, None)
        .await
        .unwrap();
    assert!(summary.text.contains("src/main.ts"));
    assert!(!summary.text.contains("/secret/repo"));
    for kind in [
        None,
        Some("unstaged"),
        Some("staged"),
        Some("untracked"),
        Some("conflicted"),
    ] {
        let selection = kind.map_or(json!({}), |kind| json!({ "kind": kind }));
        let params = merged(
            &merged(&first(), json!({ "path": "src\\main.ts" })),
            selection.clone(),
        );
        let diff = call_tool(Family::Workspace, "workspace_diff", params, &read, None)
            .await
            .unwrap();
        assert!(diff.text.contains("+good change"));
        assert!(!diff.text.contains("/secret/repo"));
        let expected = json!({ "workspace_id": "w1", "mode": "working", "path": "src/main.ts" });
        assert_eq!(
            f.conn(|conn| conn.diff_file_calls.last().cloned().unwrap()),
            merged(&expected, selection)
        );
    }
}

fn pane_read(lines: Value) -> Value {
    json!({
        "pane_id": "w1:p1",
        "source": "recent",
        "lines": lines,
        "format": "text",
        "strip_ansi": true,
    })
}

#[tokio::test]
async fn terminal_uses_verified_readonly_pane_read_with_bounded_lines() {
    let f = fixture(false);
    let captured = f.capture(json!([first()])).await.unwrap();
    let pane = merged(&first(), json!({ "pane_id": "w1:p1" }));
    let result = f.read("terminal", &captured, pane.clone()).await.unwrap();
    assert!(result.text.contains("tests passed"));
    assert_eq!(parsed(&result)[0]["requested_lines"], 120);
    assert_eq!(
        f.last_call(),
        ("pane.read".into(), pane_read(json!(120)), 25_000)
    );
    let read = f.reader(&captured);
    for lines in [1, 500, 1000] {
        let params = merged(&pane, json!({ "lines": lines }));
        let selected = call_tool(Family::Workspace, "workspace_terminal", params, &read, None)
            .await
            .unwrap();
        assert_eq!(parsed(&selected)[0]["requested_lines"], lines);
        assert_eq!(
            f.last_call(),
            ("pane.read".into(), pane_read(json!(lines)), 25_000)
        );
    }
    // JSON has no NaN or Infinity, the TS's two other cases.
    for lines in [
        json!(null),
        json!("500"),
        json!(0),
        json!(-1),
        json!(1.5),
        json!(1001),
    ] {
        fails(
            f.read(
                "terminal",
                &captured,
                merged(&pane, json!({ "lines": lines })),
            )
            .await,
            "between 1 and 1000",
        );
    }
    f.fake.over("local", |ctx| {
        let result = match ctx.method.as_str() {
            "workspace.get" | "pane.get" => ctx.original(),
            _ => fail("private api_key=SECRET /secret/socket"),
        };
        Box::pin(async move { result })
    });
    let error = f.read("terminal", &captured, pane).await.err().unwrap();
    assert!(error.message().contains("may not support pane.read"));
    assert!(!error.message().contains("SECRET"));
    assert!(!error.message().contains("/secret"));
}

#[tokio::test]
async fn large_terminal_reads_retain_newest_evidence_within_the_text_budget() {
    let f = fixture(false);
    let captured = f.capture(json!([first()])).await.unwrap();
    let text = Arc::new(Mutex::new(format!(
        "VERY OLD MARKER\n{}LATEST RESULT: tests passed",
        "OLDER OUTPUT\n".repeat(4000)
    )));
    let shared = text.clone();
    f.fake.over("local", move |ctx| {
        let result = match ctx.method.as_str() {
            "workspace.get" | "pane.get" => ctx.original(),
            "pane.read" => Ok(json!({
                "read": {
                    "pane_id": "w1:p1",
                    "workspace_id": "w1",
                    "text": *shared.lock().unwrap(),
                    "truncated": false,
                },
            })),
            method => fail(&format!("Unexpected RPC {method}")),
        };
        Box::pin(async move { result })
    });
    let pane = merged(&first(), json!({ "pane_id": "w1:p1", "lines": 1000 }));
    let result = f.read("terminal", &captured, pane.clone()).await.unwrap();
    let output = &parsed(&result)[0];
    let kept = output["text"].as_str().unwrap();
    assert_eq!(output["requested_lines"], 1000);
    assert!(js::len16(&result.text) <= 32_000);
    assert!(!kept.contains("VERY OLD MARKER"));
    assert!(kept.ends_with("LATEST RESULT: tests passed"));
    assert_eq!(output["truncated"], true);
    assert!(
        output["warning"]
            .as_str()
            .unwrap()
            .contains("partial evidence")
    );
    assert!(
        output["terminal_window"]
            .as_str()
            .unwrap()
            .contains("older output")
    );
    matches(
        &result.sources.unwrap()[0],
        json!({ "kind": "terminal", "pane_id": "w1:p1" }),
    );
    *text.lock().unwrap() = format!("{}LATEST RESULT: tests passed", "\0".repeat(7000));
    let escaped = f.read("terminal", &captured, pane).await.unwrap();
    assert!(js::len16(&escaped.text) <= 32_000);
    let output = &parsed(&escaped)[0];
    assert_eq!(output["truncated"], true);
    assert!(
        output["text"]
            .as_str()
            .unwrap()
            .ends_with("LATEST RESULT: tests passed")
    );
}

#[tokio::test]
async fn stopping_a_terminal_read_does_not_wait_for_native_history_collection() {
    let f = fixture(false);
    let captured = f.capture(json!([first()])).await.unwrap();
    let gate = Deferred::<AssistantResult<Value>>::new();
    let started = Deferred::<()>::new();
    let (wait, begun) = (gate.clone(), started.clone());
    f.fake.over("local", move |ctx| -> Reply {
        match ctx.method.as_str() {
            "workspace.get" | "pane.get" => {
                let result = ctx.original();
                Box::pin(async move { result })
            }
            "pane.read" => {
                begun.resolve(());
                wait.wait()
            }
            method => {
                let message = format!("Unexpected RPC {method}");
                Box::pin(async move { fail(&message) })
            }
        }
    });
    let token = CancellationToken::new();
    let pending = tokio::spawn(f.context.read(
        "terminal",
        &captured,
        merged(&first(), json!({ "pane_id": "w1:p1", "lines": 500 })),
        Some(token.clone()),
    ));
    started.wait().await;
    token.cancel();
    fails(pending.await.unwrap(), "aborted");
    assert_eq!(
        f.last_call(),
        ("pane.read".into(), pane_read(json!(500)), 25_000)
    );
    gate.resolve(Ok(json!({ "read": { "text": "late result" } })));
}

fn gated_diff(f: &F) -> (Gate, Arc<Deferred<()>>) {
    let gate = Deferred::<AssistantResult<Value>>::new();
    let started = Deferred::<()>::new();
    let (wait, begun) = (gate.wait(), started.clone());
    f.conn(|conn| {
        conn.diff_file.push_back(Box::new(move |_, _| {
            begun.resolve(());
            wait
        }))
    });
    (gate, started)
}

#[tokio::test]
async fn stale_leases_reject_before_and_after_awaits_without_replacement_fallback() {
    let f = fixture(false);
    let captured = f.capture(json!([first()])).await.unwrap();
    let (gate, started) = gated_diff(&f);
    let pending = tokio::spawn(f.context.read(
        "diff",
        &captured,
        merged(&first(), json!({ "path": "src/main.ts" })),
        None,
    ));
    started.wait().await;
    f.retire();
    gate.resolve(Ok(json!({
        "workspace_id": "w1",
        "path": "src/main.ts",
        "diff": "PRIVATE stale result",
    })));
    fails(pending.await.unwrap(), "Connection changed");
    let calls = f.calls();
    fails(
        f.read("status", &captured, json!({})).await,
        "Connection changed",
    );
    assert_eq!(f.calls(), calls);
    assert_eq!(f.conn(|conn| conn.lease_calls), 1);
}

#[tokio::test]
async fn shared_tool_invocation_preserves_approved_scopes_lease_checks_sources_and_cancellation() {
    let f = fixture(false);
    let captured = f.capture(json!([first()])).await.unwrap();
    let read = f.reader(&captured);
    let result = call_tool(
        Family::Workspace,
        "workspace_status",
        json!({}),
        &read,
        None,
    )
    .await
    .unwrap();
    matches(
        &parsed(&result)[0],
        merged(
            &first(),
            json!({ "label": "Allowed", "agent_status": "working" }),
        ),
    );
    let sources = result.sources.unwrap();
    assert_eq!(sources.len(), 1);
    matches(
        &sources[0],
        merged(
            &first(),
            json!({ "kind": "status", "runtime_generation": 1 }),
        ),
    );

    let calls = f.calls();
    let forged_read = f.reader(&forged(&captured));
    let forged_call = call_tool(
        Family::Workspace,
        "workspace_status",
        json!({}),
        &forged_read,
        None,
    );
    assert!(forged_call.await.is_err());
    assert_eq!(f.calls(), calls);

    let gate = Deferred::<AssistantResult<Value>>::new();
    let started = Deferred::<()>::new();
    let (wait, begun) = (gate.wait(), started.clone());
    f.fake.once("local", move |_| {
        begun.resolve(());
        wait
    });
    let token = CancellationToken::new();
    let (handler, signal) = (read.clone(), Some(token.clone()));
    let pending = tokio::spawn(async move {
        call_tool(
            Family::Workspace,
            "workspace_status",
            json!({}),
            &handler,
            signal,
        )
        .await
    });
    started.wait().await;
    token.cancel();
    assert!(pending.await.unwrap().is_err());
    assert_eq!(f.calls(), calls + 1);
    let workspace = f.conn(|conn| conn.workspaces[0].clone());
    gate.resolve(Ok(json!({ "workspace": workspace })));

    f.retire();
    let stale = call_tool(
        Family::Workspace,
        "workspace_status",
        json!({}),
        &read,
        None,
    );
    assert!(stale.await.is_err());
    assert_eq!(f.calls(), calls + 1);
    assert_eq!(f.conn(|conn| conn.lease_calls), 1);
}

#[tokio::test]
async fn abort_stops_an_in_flight_read_and_bounded_outputs_mark_truncation() {
    let f = fixture(false);
    let captured = f.capture(json!([first()])).await.unwrap();
    let (gate, started) = gated_diff(&f);
    let token = CancellationToken::new();
    let pending = tokio::spawn(f.context.read(
        "diff",
        &captured,
        merged(&first(), json!({ "path": "src/main.ts" })),
        Some(token.clone()),
    ));
    started.wait().await;
    token.cancel();
    fails(pending.await.unwrap(), "aborted");
    gate.resolve(Ok(json!({})));
    f.conn(|conn| {
        let template = conn.panes[0].clone();
        for index in 0..100 {
            let id = json!({ "pane_id": format!("w1:p{}", index + 2) });
            conn.panes.push(merged(&template, id));
        }
    });
    let status = f.read("status", &captured, json!({})).await.unwrap();
    let status = &parsed(&status)[0];
    assert_eq!(status["panes"].as_array().unwrap().len(), 80);
    assert_eq!(status["truncated"], true);
    assert!(
        status["warning"]
            .as_str()
            .unwrap()
            .contains("partial evidence")
    );
    f.conn(|conn| {
        conn.diff_file.push_back(Box::new(|_, _| {
            Box::pin(async {
                Ok(json!({
                    "workspace_id": "w1",
                    "path": "src/main.ts",
                    "diff": "x".repeat(100_000),
                    "truncated": false,
                }))
            })
        }))
    });
    let diff = f
        .read(
            "diff",
            &captured,
            merged(&first(), json!({ "path": "src/main.ts" })),
        )
        .await
        .unwrap();
    assert!(js::len16(&diff.text) < 32_100);
    assert!(diff.text.contains("[truncated]"));
    assert!(diff.text.contains("partial evidence"));
}

// ------------------------------------------------------------ mention targets

fn agent_of(catalog: &Value) -> Value {
    catalog["targets"]
        .as_array()
        .unwrap()
        .iter()
        .find(|target| target["kind"] == "agent")
        .cloned()
        .unwrap()
}

async fn selected_agent(f: &F, captured: &Scope) -> Value {
    let catalog = f.context.mention_catalog(captured, None).await.unwrap();
    let agent = agent_of(&catalog);
    assert_eq!(agent["kind"], "agent");
    agent
}

fn kinds(catalog: &Value) -> Vec<String> {
    catalog["targets"]
        .as_array()
        .unwrap()
        .iter()
        .map(|target| target["kind"].as_str().unwrap().to_owned())
        .collect()
}

#[tokio::test]
async fn catalog_includes_authorized_canonical_objects_and_only_opaque_concrete_agent_identities() {
    let f = fixture(false);
    let captured = f.capture(json!([first()])).await.unwrap();
    let catalog = f.context.mention_catalog(&captured, None).await.unwrap();
    assert!(is_mention_catalog(&catalog));
    assert_eq!(catalog["targets"].as_array().unwrap().len(), 2);
    matches(
        &catalog["targets"][0],
        merged(
            &first(),
            json!({
                "kind": "workspace",
                "label": "Allowed",
                "workspace_label": "Allowed",
                "connection_label": "Local",
                "runtime_generation": 1,
            }),
        ),
    );
    matches(
        &catalog["targets"][1],
        merged(
            &first(),
            json!({ "kind": "agent", "pane_id": "w1:p1", "terminal_id": "term1", "agent": "pi" }),
        ),
    );
    let serialized = catalog.to_string();
    for secret in [
        "/secret",
        "api_key",
        "private-key",
        "foreground_processes",
        "PRIVATE WORKSPACE",
        "PRIVATE PANE",
    ] {
        assert!(!serialized.contains(secret), "{secret}");
    }
    let calls = f.calls();
    fails(
        f.context.mention_catalog(&forged(&captured), None).await,
        "not approved",
    );
    assert_eq!(f.calls(), calls);
}

#[tokio::test]
async fn duplicate_display_names_preserve_parent_identity_and_cross_workspace_or_forged_references_are_denied()
 {
    let f = fixture(false);
    f.conn(|conn| {
        conn.workspaces[1]["label"] = json!("Allowed");
        conn.panes[1]["label"] = json!("Agent");
        conn.panes[1]["agent_session"] = json!({ "kind": "id", "value": "different-session" });
    });
    let refs = json!([first(), merged(&first(), json!({ "workspace_id": "w2" }))]);
    let captured = f.capture(refs).await.unwrap();
    let catalog = f.context.mention_catalog(&captured, None).await.unwrap();
    let agents: Vec<Value> = catalog["targets"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|target| target["kind"] == "agent")
        .cloned()
        .collect();
    let field = |key: &str| {
        agents
            .iter()
            .map(|agent| agent[key].clone())
            .collect::<Vec<_>>()
    };
    assert_eq!(field("label"), [json!("Agent"), json!("Agent")]);
    assert_eq!(field("workspace_id"), [json!("w1"), json!("w2")]);
    for change in [
        json!({ "connection_id": "other" }),
        json!({ "workspace_id": "private" }),
        json!({ "runtime_generation": 2 }),
        json!({ "workspace_id": "w2" }),
        json!({ "agent_identity": "b".repeat(64) }),
    ] {
        let mention = json!([merged(&agents[0], change)]);
        assert!(
            f.context
                .bind_mentions(&captured, mention, None)
                .await
                .is_err()
        );
    }
    assert!(
        f.context
            .bind_mentions(&forged(&captured), json!(agents), None)
            .await
            .is_err()
    );
    let path = json!([merged(&agents[0], json!({ "path": "/secret" }))]);
    assert!(
        f.context
            .bind_mentions(&captured, path, None)
            .await
            .is_err()
    );
}

#[tokio::test]
async fn catalog_does_not_invent_an_agent_session_binding_when_the_concrete_session_is_unavailable()
{
    let f = fixture(false);
    let captured = f.capture(json!([first()])).await.unwrap();
    f.conn(|conn| conn.panes[0]["agent_session"] = Value::Null);
    let catalog = f.context.mention_catalog(&captured, None).await.unwrap();
    assert_eq!(kinds(&catalog), ["workspace"]);
    // No session to bind is no failure: the pane is left out, silently.
    assert_eq!(catalog["errors"], json!([]));
}

#[tokio::test]
async fn a_conversation_mode_pane_is_mentioned_by_the_session_roamgate_drives_there_guarded_by_it()
{
    let f = fixture(false);
    let session = Arc::new(Mutex::new("session-one".to_owned()));
    let current = session.clone();
    f.conn(|conn| {
        conn.owned = Some(Arc::new(move |pane: &str| {
            let id = current.lock().unwrap().clone();
            (pane == "w1:p1").then(|| json!({ "session_id": id, "cwd": "/secret" }))
        }));
        conn.summary = Some(json!({ "title": "Prores-fixes session" }));
        // Herdr names the agent there, but holds no session for it.
        conn.panes[0]["agent"] = json!("claude");
        conn.panes[0]["agent_session"] = Value::Null;
    });
    let captured = f.capture(json!([first()])).await.unwrap();
    let catalog = f.context.mention_catalog(&captured, None).await.unwrap();
    assert_eq!(catalog["errors"], json!([]));
    let agent = agent_of(&catalog);
    matches(
        &agent,
        json!({
            "kind": "agent",
            "pane_id": "w1:p1",
            "terminal_id": "term1",
            "agent": "claude",
            "label": "Agent",
        }),
    );
    assert!(is_hex64(agent["agent_identity"].as_str().unwrap()));
    assert!(is_mention_catalog(&catalog));
    // Bound, it is readable like any mentioned agent.
    let bound = f
        .context
        .bind_mentions(&captured, json!([agent]), None)
        .await
        .unwrap();
    assert_eq!(bound.as_array().unwrap().len(), 1);
    // The session changing (/clear, another takeover) breaks the binding.
    *session.lock().unwrap() = "session-two".into();
    let again = f.context.mention_catalog(&captured, None).await.unwrap();
    let changed = agent_of(&again);
    matches(&changed, json!({ "kind": "agent", "pane_id": "w1:p1" }));
    assert_ne!(changed["agent_identity"], agent["agent_identity"]);
    assert!(
        f.context
            .bind_mentions(&captured, json!([agent]), None)
            .await
            .is_err()
    );
}

#[tokio::test]
async fn a_conversation_mode_pane_without_a_name_or_label_takes_its_session_s_title() {
    let f = fixture(false);
    f.conn(|conn| {
        conn.owned = Some(Arc::new(|_: &str| {
            Some(json!({ "session_id": "s", "cwd": "/x" }))
        }));
        conn.summary = Some(json!({ "title": "Prores-fixes session" }));
        conn.panes[0]["agent"] = json!("claude");
        conn.panes[0]["agent_session"] = Value::Null;
        conn.panes[0].as_object_mut().unwrap().remove("label");
    });
    let captured = f.capture(json!([first()])).await.unwrap();
    let catalog = f.context.mention_catalog(&captured, None).await.unwrap();
    matches(
        &catalog["targets"][1],
        json!({ "label": "Prores-fixes session" }),
    );
}

#[tokio::test]
async fn agents_that_cannot_be_read_make_one_error_line_not_one_per_pane() {
    let f = fixture(false);
    let refs = json!([first(), merged(&first(), json!({ "workspace_id": "w2" }))]);
    let captured = f.capture(refs).await.unwrap();
    f.fake.over("local", |ctx| {
        let result = if ctx.method == "pane.process_info" {
            fail("socket closed")
        } else {
            ctx.original()
        };
        Box::pin(async move { result })
    });
    let catalog = f.context.mention_catalog(&captured, None).await.unwrap();
    assert_eq!(catalog["errors"], json!(["2 agents could not be read"]));
    assert_eq!(kinds(&catalog), ["workspace", "workspace"]);
}

#[tokio::test]
async fn workspace_rename_and_bridge_reconnect_preserve_concrete_agent_identity_without_relaxing_generation_checks()
 {
    let f = fixture(false);
    let captured = f.capture(json!([first()])).await.unwrap();
    let selected = selected_agent(&f, &captured).await;
    f.conn(|conn| {
        conn.workspaces[0]["label"] = json!("Renamed");
        conn.panes[0]["label"] = json!("Renamed agent");
    });
    let canonical = f
        .context
        .bind_mentions(&captured, json!([selected]), None)
        .await
        .unwrap();
    matches(
        &canonical[0],
        json!({
            "workspace_label": "Renamed",
            "label": "Renamed agent",
            "agent_identity": selected["agent_identity"],
        }),
    );
    f.retire();
    fails(
        f.context
            .bind_mentions(&captured, json!([selected]), None)
            .await,
        "Connection changed",
    );
    let restored = f.capture(json!([first()])).await.unwrap();
    let current = selected_agent(&f, &restored).await;
    assert_eq!(current["agent_identity"], selected["agent_identity"]);
    fails(
        f.context
            .bind_mentions(&restored, json!([selected]), None)
            .await,
        "connection changed",
    );
    let generation = json!({ "runtime_generation": current["runtime_generation"] });
    let rebound = f
        .context
        .bind_mentions(&restored, json!([merged(&selected, generation)]), None)
        .await
        .unwrap();
    assert_eq!(rebound.as_array().unwrap().len(), 1);
}

#[tokio::test]
async fn selection_and_bound_history_or_terminal_reads_fail_when_the_agent_session_changes() {
    for kind in ["history", "terminal"] {
        let f = fixture(false);
        let captured = f.capture(json!([first()])).await.unwrap();
        let selected = selected_agent(&f, &captured).await;
        f.context
            .bind_mentions(&captured, json!([selected]), None)
            .await
            .unwrap();
        f.conn(|conn| conn.panes[0]["agent_session"]["value"] = json!("/secret/new-session"));
        fails(
            f.context
                .bind_mentions(&captured, json!([selected]), None)
                .await,
            "session changed",
        );
        let params = merged(&first(), json!({ "pane_id": selected["pane_id"] }));
        fails(f.read(kind, &captured, params).await, "session changed");
        assert!(f.conn(|conn| conn.history_calls.is_empty()));
        assert_eq!(f.conn(|conn| conn.count("pane.read")), 0);
    }
}

#[tokio::test]
async fn a_replacement_during_history_reading_is_rejected_before_evidence_can_leave_the_context() {
    let f = fixture(false);
    let captured = f.capture(json!([first()])).await.unwrap();
    let selected = selected_agent(&f, &captured).await;
    f.context
        .bind_mentions(&captured, json!([selected]), None)
        .await
        .unwrap();
    let pane = selected["pane_id"].clone();
    f.conn(|conn| {
        conn.history.push_back(Box::new(move |fake, _| {
            fake.with("local", |conn| {
                conn.panes[0]["agent_session"]["value"] = json!("/secret/replaced")
            });
            Box::pin(async move {
                Ok(json!({
                    "pane_id": pane,
                    "workspace_id": "w1",
                    "agent": "pi",
                    "status": "ok",
                    "messages": [{ "role": "assistant", "text": "Wrong agent private data" }],
                }))
            })
        }))
    });
    let params = merged(&first(), json!({ "pane_id": selected["pane_id"] }));
    fails(
        f.read("history", &captured, params).await,
        "session changed",
    );
    assert_eq!(f.conn(|conn| conn.history_calls.len()), 1);
}

#[tokio::test]
async fn binding_another_subset_does_not_erase_existing_agent_guards() {
    let f = fixture(false);
    let captured = f.capture(json!([first()])).await.unwrap();
    let catalog = f.context.mention_catalog(&captured, None).await.unwrap();
    let selected = agent_of(&catalog);
    f.context
        .bind_mentions(&captured, json!([selected]), None)
        .await
        .unwrap();
    f.context
        .bind_mentions(&captured, json!([catalog["targets"][0]]), None)
        .await
        .unwrap();
    f.conn(|conn| conn.panes[0]["terminal_id"] = json!("replacement-terminal"));
    fails(
        f.read(
            "history",
            &captured,
            merged(&first(), json!({ "pane_id": "w1:p1" })),
        )
        .await,
        "session changed",
    );
}

#[tokio::test]
async fn a_replacement_during_terminal_reading_is_rejected_after_the_native_read() {
    let f = fixture(false);
    let captured = f.capture(json!([first()])).await.unwrap();
    let selected = selected_agent(&f, &captured).await;
    f.context
        .bind_mentions(&captured, json!([selected]), None)
        .await
        .unwrap();
    f.fake.over("local", |ctx| {
        let result = match ctx.method.as_str() {
            "workspace.get" | "pane.get" | "agent.get" | "pane.process_info" => ctx.original(),
            "pane.read" => {
                ctx.fake.with("local", |conn| {
                    conn.panes[0]["agent_session"]["value"] = json!("/secret/replaced")
                });
                Ok(json!({
                    "read": {
                        "pane_id": "w1:p1",
                        "workspace_id": "w1",
                        "text": "Wrong agent private output",
                    },
                }))
            }
            _ => fail("Unexpected RPC"),
        };
        Box::pin(async move { result })
    });
    let params = merged(&first(), json!({ "pane_id": selected["pane_id"] }));
    fails(
        f.read("terminal", &captured, params).await,
        "session changed",
    );
    assert_eq!(f.conn(|conn| conn.count("pane.read")), 1);
}

#[tokio::test]
async fn agent_replacements_block_both_proposal_preparation_and_later_confirmation_without_sending_a_prompt()
 {
    let f = fixture(false);
    let captured = f.capture(json!([first()])).await.unwrap();
    let selected = selected_agent(&f, &captured).await;
    f.context
        .bind_mentions(&captured, json!([selected]), None)
        .await
        .unwrap();
    let params = merged(
        &first(),
        json!({ "pane_id": selected["pane_id"], "prompt": "Continue" }),
    );
    let prepared = f
        .context
        .prepare("send_prompt", &captured, params.clone(), None)
        .await
        .unwrap();
    f.conn(|conn| conn.panes[0]["agent_session"]["value"] = json!("/secret/replaced"));
    fails(
        f.context
            .prepare("send_prompt", &captured, params, None)
            .await,
        "session changed",
    );
    let result = prepared.execute(None).await;
    assert_eq!(result["status"], "failed");
    assert!(
        result["detail"]
            .as_str()
            .unwrap()
            .contains("Nothing was sent")
    );
    assert_eq!(f.conn(|conn| conn.count("agent.prompt")), 0);
}

#[tokio::test]
async fn catalog_discovery_bounds_large_inventories_while_preserving_the_requested_workspace_order()
{
    let (f, refs) = scope_fixture(65);
    let mut reversed = refs.as_array().unwrap().clone();
    reversed.reverse();
    let captured = f.capture(Value::Array(reversed)).await.unwrap();
    let catalog = f.context.mention_catalog(&captured, None).await.unwrap();
    let workspaces = kinds(&catalog)
        .iter()
        .filter(|kind| *kind == "workspace")
        .count();
    assert_eq!(workspaces, 65);
    assert_eq!(catalog["targets"][0]["workspace_id"], "w65");
    assert_eq!(catalog["truncated"], true);
    assert_eq!(f.conn(|conn| conn.count("pane.list")), 64);
    let many = fixture(false);
    many.conn(|conn| {
        conn.panes.remove(1);
        let template = conn.panes[0].clone();
        for index in 0..200 {
            let ids = json!({
                "pane_id": format!("w1:p{}", index + 2),
                "terminal_id": format!("term{}", index + 2),
            });
            conn.panes.push(merged(&template, ids));
        }
    });
    let scope = many.capture(json!([first()])).await.unwrap();
    let limited = many.context.mention_catalog(&scope, None).await.unwrap();
    let agents = kinds(&limited)
        .iter()
        .filter(|kind| *kind == "agent")
        .count();
    assert_eq!(agents, 200);
    assert_eq!(limited["truncated"], true);
    assert_eq!(many.conn(|conn| conn.count("agent.get")), 200);
}

// These paths use Unix-only resource helpers, unlike native status/terminal RPCs.
#[tokio::test]
async fn windows_ranger_reads_refuse_unix_resource_helpers() {
    for (kind, query) in [
        ("history", json!({ "pane_id": "w1:p1" })),
        ("diff", json!({})),
        ("diff", json!({ "path": "src/main.ts", "kind": "unstaged" })),
    ] {
        let f = fixture(false);
        f.conn(|conn| conn.remote_platform = Some("windows".into()));
        let captured = f.capture(json!([first()])).await.unwrap();
        f.conn(|conn| conn.calls.clear());
        fails(
            f.read(kind, &captured, merged(&first(), query)).await,
            "unavailable on Windows",
        );
        f.conn(|conn| {
            assert!(conn.history_calls.is_empty());
            assert!(conn.diff_summary_calls.is_empty());
            assert!(conn.diff_file_calls.is_empty());
            assert!(conn.calls.is_empty());
        });
    }
}

#[tokio::test]
async fn windows_ranger_reads_keep_native_rpc_support() {
    for kind in ["status", "terminal"] {
        let f = fixture(false);
        f.conn(|conn| conn.remote_platform = Some("windows".into()));
        let captured = f.capture(json!([first()])).await.unwrap();
        let params = if kind == "terminal" {
            merged(&first(), json!({ "pane_id": "w1:p1" }))
        } else {
            first()
        };
        let result = f.read(kind, &captured, params).await.unwrap();
        // Status tells the model which workspaces cannot use Unix-only tools.
        let platform = (kind == "status").then(|| json!("windows"));
        assert_eq!(parsed(&result)[0].get("remote_platform"), platform.as_ref());
        f.conn(|conn| {
            assert!(conn.history_calls.is_empty());
            assert!(conn.diff_summary_calls.is_empty());
            assert!(conn.diff_file_calls.is_empty());
        });
    }
}
