//! service.test.ts, case for case. Its fakes (the context and the driver
//! the TS test changes member by member) are [`FakeContext`] and
//! [`FakeDriver`], whose members can be replaced while the service runs.
//! Bun's real timers are tokio's; `use_fake_timers` switches to the test
//! clock of roamgate-base as `jest.useFakeTimers` does.

#![allow(dead_code)]

use std::future::Future;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use roamgate_base::clock::{Clock, Interval, SharedClock, SystemClock};
use roamgate_base::paths::{DataContext, Platform};
use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;

use super::*;
use crate::context::{CapturedScope, ContextOp, PreparedAction, Scope};
use crate::driver::{AssistantDriver, LoginInteraction, RunEvent, RunInput, SaveModels};
use crate::errors::{AssistantError, AssistantResult};
#[allow(unused_imports)]
pub(super) use crate::test_support::{Deferred, JestClock, clock_at, clock_at_ms};
use crate::tools::{BoxFuture, ToolResult};

mod chats;

// ------------------------------------------------------------ values

pub(super) fn workspace() -> Value {
    json!({
        "connection_id": "local",
        "workspace_id": "ws",
        "connection_label": "Local",
        "label": "Workspace",
        "runtime_generation": 7,
    })
}

pub(super) fn catalog() -> Value {
    json!({
        "providers": [{
            "id": "test", "label": "Test", "methods": ["api_key", "oauth"], "configured": true,
        }],
        "models": [{"provider": "test", "id": "model", "label": "Model"}],
    })
}

pub(super) fn configured() -> Value {
    json!({
        "provider": "test",
        "model": "model",
        "credential_source": "assistant",
        "allowed_workspaces": [{"connection_id": "local", "workspace_id": "ws"}],
    })
}

/// `configured.allowed_workspaces`.
pub(super) fn allowed() -> Value {
    configured()["allowed_workspaces"].clone()
}

pub(super) fn mentioned_agent() -> Value {
    merge(
        &workspace(),
        json!({
            "workspace_label": "Workspace",
            "kind": "agent",
            "label": "Codex",
            "pane_id": "pane",
            "terminal_id": "terminal",
            "agent": "codex",
            "agent_identity": "c".repeat(64),
        }),
    )
}

pub(super) fn agent_marker() -> Value {
    merge(&mentioned_agent(), json!({"start": 6, "end": 12}))
}

/// `{ ...a, ...b }` on JSON objects.
pub(super) fn merge(a: &Value, b: Value) -> Value {
    let mut out = a.clone();
    if let (Some(out), Value::Object(b)) = (out.as_object_mut(), b) {
        for (key, value) in b {
            out.insert(key, value);
        }
    }
    out
}

pub(super) fn uuid() -> String {
    roamgate_base::paths::random_uuid()
}

pub(super) fn user_err(message: &str) -> AssistantError {
    AssistantError::User(message.into())
}

pub(super) fn plain_err(message: &str) -> AssistantError {
    AssistantError::Internal(message.into())
}

pub(super) fn not_ready(message: &str) -> AssistantError {
    AssistantError::RecoveryNotReady(message.into())
}

pub(super) fn read_json(path: &std::path::Path) -> Value {
    serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
}

/// `value[key].at(-1)`.
pub(super) fn last<'a>(value: &'a Value, key: &str) -> &'a Value {
    value[key]
        .as_array()
        .and_then(|items| items.last())
        .unwrap_or(&Value::Null)
}

/// `messages.at(-1)` of a snapshot or saved state.
pub(super) fn last_message(value: &Value) -> Value {
    last(value, "messages").clone()
}

/// Whether `actual` holds every key of `expected` with the same value
/// (`toMatchObject`), recursively for objects.
pub(super) fn matches(actual: &Value, expected: &Value) -> bool {
    match (actual, expected) {
        (Value::Object(actual), Value::Object(expected)) => expected
            .iter()
            .all(|(key, value)| actual.get(key).is_some_and(|got| matches(got, value))),
        (Value::Array(actual), Value::Array(expected)) => {
            actual.len() == expected.len()
                && actual.iter().zip(expected).all(|(a, e)| matches(a, e))
        }
        _ => actual == expected,
    }
}

#[track_caller]
pub(super) fn assert_matches(actual: &Value, expected: Value) {
    assert!(
        matches(actual, &expected),
        "{actual:#} does not match {expected:#}"
    );
}

/// `rejects.toThrow(text)`.
#[track_caller]
pub(super) fn assert_err<T: std::fmt::Debug>(result: AssistantResult<T>, contains: &str) {
    match result {
        Ok(value) => panic!("expected an error with {contains:?}, got {value:?}"),
        Err(error) => assert!(
            error.message().contains(contains),
            "{:?} does not contain {contains:?}",
            error.message()
        ),
    }
}

// ------------------------------------------------------------ timers

/// Bun's timers: real until a test switches to the fake ones.
pub(super) struct Timers {
    fake: Mutex<Option<&'static JestClock>>,
}

impl Timers {
    fn clock(&self) -> Option<&'static JestClock> {
        *self.fake.lock().unwrap()
    }
}

impl Clock for Timers {
    fn now(&self) -> i64 {
        self.clock().map_or_else(|| SystemClock.now(), |c| c.now())
    }

    fn monotonic(&self) -> f64 {
        self.clock()
            .map_or_else(|| SystemClock.monotonic(), |c| c.monotonic())
    }

    fn sleep_until(&self, deadline: i64) -> BoxFuture<()> {
        match self.clock() {
            Some(clock) => clock.sleep_until(deadline),
            None => SystemClock.sleep_until(deadline),
        }
    }

    fn sleep(&self, duration: Duration) -> BoxFuture<()> {
        match self.clock() {
            Some(clock) => clock.sleep(duration),
            None => SystemClock.sleep(duration),
        }
    }

    fn interval(&self, period: Duration) -> Interval {
        match self.clock() {
            Some(clock) => clock.interval(period),
            None => SystemClock.interval(period),
        }
    }
}

// ------------------------------------------------------------ the context

pub(super) type Fut<T> = BoxFuture<AssistantResult<T>>;
pub(super) type CatalogFn = Arc<dyn Fn() -> Fut<Value> + Send + Sync>;
/// Refs, or a captured scope's workspaces, to workspaces or targets.
pub(super) type ScopeFn = Arc<dyn Fn(Value) -> Fut<Value> + Send + Sync>;
pub(super) type ExtendFn =
    Arc<dyn Fn(Value, Value, Option<CancellationToken>) -> Fut<Value> + Send + Sync>;
pub(super) type BindFn = Arc<dyn Fn(Value, Value) -> Fut<Value> + Send + Sync>;
pub(super) type ReadFn =
    Arc<dyn Fn(String, Value, Value, Option<CancellationToken>) -> Fut<ToolResult> + Send + Sync>;
pub(super) type PrepareFn = Arc<dyn Fn(String, Value, Value) -> Fut<PreparedAction> + Send + Sync>;
pub(super) type StateFn = Arc<dyn Fn(&str) -> Option<Value> + Send + Sync>;
pub(super) type WatchFn =
    Arc<dyn Fn(Arc<dyn Fn() + Send + Sync>) -> Box<dyn FnOnce() + Send> + Send + Sync>;

/// The test's `AssistantContext`, member by member: an optional member is
/// absent while None.
pub(super) struct FakeContext {
    pub catalog: Mutex<CatalogFn>,
    pub capture: Mutex<ScopeFn>,
    pub read: Mutex<ReadFn>,
    pub recovery: Mutex<Option<ScopeFn>>,
    pub restore: Mutex<Option<ScopeFn>>,
    pub extend: Mutex<Option<ExtendFn>>,
    pub prepare: Mutex<Option<PrepareFn>>,
    pub mentions: Mutex<Option<ScopeFn>>,
    pub bind: Mutex<Option<BindFn>>,
    pub state: Mutex<Option<StateFn>>,
    pub watch: Mutex<Option<WatchFn>>,
    /// `{scope, params}` of each read the default `read` saw.
    pub reads: Mutex<Vec<(Value, Value)>>,
}

pub(super) fn ok<T: Send + 'static>(value: T) -> Fut<T> {
    Box::pin(async move { Ok(value) })
}

pub(super) fn fail<T: Send + 'static>(error: AssistantError) -> Fut<T> {
    Box::pin(async move { Err(error) })
}

fn boxed<T, F>(future: F) -> Fut<T>
where
    F: Future<Output = AssistantResult<T>> + Send + 'static,
{
    Box::pin(future)
}

/// The default read's result.
pub(super) fn status_source() -> Value {
    merge(
        &workspace(),
        json!({
            "id": "source-1", "kind": "status", "title": "Status",
            "read_at": "2026-10-03T00:00:00Z",
        }),
    )
}

impl FakeContext {
    fn new() -> Arc<Self> {
        Arc::new_cyclic(|weak: &std::sync::Weak<FakeContext>| {
            let weak = weak.clone();
            FakeContext {
                catalog: Mutex::new(Arc::new(|| {
                    ok(json!({"workspaces": [workspace()], "errors": []}))
                })),
                capture: Mutex::new(Arc::new(|refs: Value| {
                    if refs
                        .as_array()
                        .into_iter()
                        .flatten()
                        .any(|r| r["workspace_id"] != "ws")
                    {
                        return fail(plain_err("Unknown workspace"));
                    }
                    ok(json!([workspace()]))
                })),
                read: Mutex::new(Arc::new(move |_kind, scope, params, _signal| {
                    if let Some(context) = weak.upgrade() {
                        context.reads.lock().unwrap().push((scope, params));
                    }
                    ok(ToolResult {
                        text: "Workspace is working".into(),
                        sources: Some(vec![status_source()]),
                    })
                })),
                recovery: Mutex::new(None),
                restore: Mutex::new(None),
                extend: Mutex::new(None),
                prepare: Mutex::new(None),
                mentions: Mutex::new(None),
                bind: Mutex::new(None),
                state: Mutex::new(None),
                watch: Mutex::new(None),
                reads: Mutex::new(Vec::new()),
            }
        })
    }

    pub fn set_catalog<F, R>(&self, f: F)
    where
        F: Fn() -> R + Send + Sync + 'static,
        R: Future<Output = AssistantResult<Value>> + Send + 'static,
    {
        *self.catalog.lock().unwrap() = Arc::new(move || boxed(f()));
    }

    pub fn set_capture<F, R>(&self, f: F)
    where
        F: Fn(Value) -> R + Send + Sync + 'static,
        R: Future<Output = AssistantResult<Value>> + Send + 'static,
    {
        *self.capture.lock().unwrap() = Arc::new(move |refs| boxed(f(refs)));
    }

    pub fn set_read<F, R>(&self, f: F)
    where
        F: Fn(String, Value, Value) -> R + Send + Sync + 'static,
        R: Future<Output = AssistantResult<ToolResult>> + Send + 'static,
    {
        *self.read.lock().unwrap() =
            Arc::new(move |kind, scope, params, _signal| boxed(f(kind, scope, params)));
    }

    pub fn set_recovery<F, R>(&self, f: F)
    where
        F: Fn(Value) -> R + Send + Sync + 'static,
        R: Future<Output = AssistantResult<Value>> + Send + 'static,
    {
        *self.recovery.lock().unwrap() = Some(Arc::new(move |captured| boxed(f(captured))));
    }

    pub fn set_restore<F, R>(&self, f: F)
    where
        F: Fn(Value) -> R + Send + Sync + 'static,
        R: Future<Output = AssistantResult<Value>> + Send + 'static,
    {
        *self.restore.lock().unwrap() = Some(Arc::new(move |targets| boxed(f(targets))));
    }

    pub fn set_extend<F, R>(&self, f: F)
    where
        F: Fn(Value, Value, Option<CancellationToken>) -> R + Send + Sync + 'static,
        R: Future<Output = AssistantResult<Value>> + Send + 'static,
    {
        *self.extend.lock().unwrap() = Some(Arc::new(move |captured, refs, signal| {
            boxed(f(captured, refs, signal))
        }));
    }

    pub fn set_prepare<F, R>(&self, f: F)
    where
        F: Fn(String, Value, Value) -> R + Send + Sync + 'static,
        R: Future<Output = AssistantResult<PreparedAction>> + Send + 'static,
    {
        *self.prepare.lock().unwrap() = Some(Arc::new(move |kind, captured, params| {
            boxed(f(kind, captured, params))
        }));
    }

    pub fn set_mentions<F, R>(&self, f: F)
    where
        F: Fn(Value) -> R + Send + Sync + 'static,
        R: Future<Output = AssistantResult<Value>> + Send + 'static,
    {
        *self.mentions.lock().unwrap() = Some(Arc::new(move |captured| boxed(f(captured))));
    }

    pub fn set_bind<F, R>(&self, f: F)
    where
        F: Fn(Value, Value) -> R + Send + Sync + 'static,
        R: Future<Output = AssistantResult<Value>> + Send + 'static,
    {
        *self.bind.lock().unwrap() = Some(Arc::new(move |captured, targets| {
            boxed(f(captured, targets))
        }));
    }

    pub fn set_state(&self, f: impl Fn(&str) -> Option<Value> + Send + Sync + 'static) {
        *self.state.lock().unwrap() = Some(Arc::new(f));
    }

    pub fn set_watch(
        &self,
        f: impl Fn(Arc<dyn Fn() + Send + Sync>) -> Box<dyn FnOnce() + Send> + Send + Sync + 'static,
    ) {
        *self.watch.lock().unwrap() = Some(Arc::new(f));
    }

    pub fn capture_fn(&self) -> ScopeFn {
        self.capture.lock().unwrap().clone()
    }

    pub fn restore_fn(&self) -> ScopeFn {
        self.restore.lock().unwrap().clone().unwrap()
    }

    pub fn recovery_fn(&self) -> ScopeFn {
        self.recovery.lock().unwrap().clone().unwrap()
    }

    pub fn read_fn(&self) -> ReadFn {
        self.read.lock().unwrap().clone()
    }

    pub fn prepare_fn(&self) -> PrepareFn {
        self.prepare.lock().unwrap().clone().unwrap()
    }

    pub fn catalog_fn(&self) -> CatalogFn {
        self.catalog.lock().unwrap().clone()
    }

    pub fn reads(&self) -> Vec<(Value, Value)> {
        self.reads.lock().unwrap().clone()
    }

    /// `stableTaskIdentity(context)`.
    pub fn stable_task_identity(&self) {
        self.set_recovery(|captured| async move {
            Ok(Value::Array(
                captured
                    .as_array()
                    .into_iter()
                    .flatten()
                    .map(|r| {
                        json!({
                            "connection_id": r["connection_id"],
                            "workspace_id": r["workspace_id"],
                            "endpoint_fingerprint": "a".repeat(64),
                            "workspace_identity": "b".repeat(64),
                            "herdr_boot_id": "original-server",
                        })
                    })
                    .collect(),
            ))
        });
        self.set_restore(|targets| async move {
            Ok(Value::Array(
                targets
                    .as_array()
                    .into_iter()
                    .flatten()
                    .map(|t| merge(&workspace(), json!({"workspace_id": t["workspace_id"]})))
                    .collect(),
            ))
        });
    }
}

fn plain(workspaces: Value) -> Scope {
    CapturedScope::plain(workspaces)
}

/// The service's view of the fake.
pub(super) struct ContextRef(pub Arc<FakeContext>);

impl crate::context::AssistantContext for ContextRef {
    fn provides(&self, op: ContextOp) -> bool {
        let c = &self.0;
        match op {
            ContextOp::ConnectionState => c.state.lock().unwrap().is_some(),
            ContextOp::WatchConnections => c.watch.lock().unwrap().is_some(),
            ContextOp::ExtendScope => c.extend.lock().unwrap().is_some(),
            ContextOp::PrepareAction => c.prepare.lock().unwrap().is_some(),
            ContextOp::RecoveryScope => c.recovery.lock().unwrap().is_some(),
            ContextOp::RestoreScope => c.restore.lock().unwrap().is_some(),
            ContextOp::MentionCatalog => c.mentions.lock().unwrap().is_some(),
            ContextOp::BindMentions => c.bind.lock().unwrap().is_some(),
        }
    }

    fn catalog(&self) -> BoxFuture<AssistantResult<Value>> {
        let f = self.0.catalog.lock().unwrap().clone();
        f()
    }

    fn connection_state(&self, connection_id: &str) -> Option<Value> {
        let f = self.0.state.lock().unwrap().clone();
        f.and_then(|f| f(connection_id))
    }

    fn watch_connections(&self, listener: Arc<dyn Fn() + Send + Sync>) -> Box<dyn FnOnce() + Send> {
        let f = self.0.watch.lock().unwrap().clone();
        match f {
            Some(f) => f(listener),
            None => Box::new(|| {}),
        }
    }

    fn capture_scope(
        &self,
        refs: Value,
        _cancel: Option<CancellationToken>,
        _recovery: Option<Value>,
    ) -> BoxFuture<AssistantResult<Scope>> {
        let f = self.0.capture.lock().unwrap().clone();
        Box::pin(async move { f(refs).await.map(plain) })
    }

    fn extend_scope(
        &self,
        captured: &Scope,
        refs: Value,
        cancel: Option<CancellationToken>,
    ) -> BoxFuture<AssistantResult<Scope>> {
        let f = self.0.extend.lock().unwrap().clone().unwrap();
        let captured = captured.workspaces.clone();
        Box::pin(async move { f(captured, refs, cancel).await.map(plain) })
    }

    fn recovery_scope(
        &self,
        captured: &Scope,
        _cancel: Option<CancellationToken>,
    ) -> BoxFuture<AssistantResult<Value>> {
        let f = self.0.recovery.lock().unwrap().clone().unwrap();
        f(captured.workspaces.clone())
    }

    fn restore_scope(
        &self,
        targets: Value,
        _cancel: Option<CancellationToken>,
    ) -> BoxFuture<AssistantResult<Scope>> {
        let f = self.0.restore.lock().unwrap().clone().unwrap();
        Box::pin(async move { f(targets).await.map(plain) })
    }

    fn mention_catalog(
        &self,
        captured: &Scope,
        _cancel: Option<CancellationToken>,
    ) -> BoxFuture<AssistantResult<Value>> {
        let f = self.0.mentions.lock().unwrap().clone().unwrap();
        f(captured.workspaces.clone())
    }

    fn bind_mentions(
        &self,
        captured: &Scope,
        targets: Value,
        _cancel: Option<CancellationToken>,
    ) -> BoxFuture<AssistantResult<Value>> {
        let f = self.0.bind.lock().unwrap().clone().unwrap();
        f(captured.workspaces.clone(), targets)
    }

    fn read(
        &self,
        kind: &str,
        captured: &Scope,
        params: Value,
        cancel: Option<CancellationToken>,
    ) -> BoxFuture<AssistantResult<ToolResult>> {
        let f = self.0.read.lock().unwrap().clone();
        f(kind.to_owned(), captured.workspaces.clone(), params, cancel)
    }

    fn prepare_action(
        &self,
        kind: &str,
        captured: &Scope,
        params: Value,
        _cancel: Option<CancellationToken>,
    ) -> BoxFuture<AssistantResult<PreparedAction>> {
        let f = self.0.prepare.lock().unwrap().clone().unwrap();
        f(kind.to_owned(), captured.workspaces.clone(), params)
    }
}

/// A prepared action with its preview, its execute run once.
pub(super) fn action<F, R>(preview: Value, execute: F) -> PreparedAction
where
    F: FnOnce() -> R + Send + 'static,
    R: Future<Output = AssistantResult<Value>> + Send + 'static,
{
    PreparedAction {
        preview,
        execute: Box::new(move |_authorized| Box::pin(execute())),
    }
}

/// `permissionAction(execute)`: a tab created in the workspace.
pub(super) fn permission_action<F, R>(execute: F) -> PreparedAction
where
    F: FnOnce() -> R + Send + 'static,
    R: Future<Output = AssistantResult<Value>> + Send + 'static,
{
    action(permission_preview(), execute)
}

pub(super) fn permission_preview() -> Value {
    merge(
        &workspace(),
        json!({
            "workspace_label": "Workspace",
            "kind": "create_tab",
            "summary": "Create a tab",
            "params": {"cwd": "/repo"},
        }),
    )
}

/// A preview of `kind` on the fixture's workspace.
pub(super) fn preview(kind: &str, summary: &str, params: Value) -> Value {
    json!({
        "connection_id": "local",
        "workspace_id": "ws",
        "runtime_generation": 7,
        "connection_label": "Local",
        "workspace_label": "Workspace",
        "kind": kind,
        "summary": summary,
        "params": params,
    })
}

// ------------------------------------------------------------ the driver

pub(super) type RunFn = Arc<dyn Fn(Input) -> Fut<Vec<Value>> + Send + Sync>;
pub(super) type LoginFn = Arc<dyn Fn(String, String, Login) -> Fut<()> + Send + Sync>;
pub(super) type SourceFn = Arc<dyn Fn(String) -> Fut<Value> + Send + Sync>;
pub(super) type UnitFn = Arc<dyn Fn() -> Fut<()> + Send + Sync>;
pub(super) type DetailsFn =
    Arc<dyn Fn(Vec<Value>, Value, Option<PathBuf>) -> Fut<Value> + Send + Sync>;
pub(super) type ConfigureFn = Arc<dyn Fn(Value, SaveModels) -> Fut<()> + Send + Sync>;
pub(super) type SteerFn = Arc<dyn Fn(String, String) -> Fut<()> + Send + Sync>;

/// The test's `AssistantDriver`, member by member.
pub(super) struct FakeDriver {
    pub catalog: Mutex<SourceFn>,
    pub login: Mutex<LoginFn>,
    pub run: Mutex<RunFn>,
    pub stop: Mutex<UnitFn>,
    pub dispose: Mutex<UnitFn>,
    pub details: Mutex<Option<DetailsFn>>,
    pub configure: Mutex<Option<ConfigureFn>>,
    pub steer: Mutex<Option<SteerFn>>,
}

impl FakeDriver {
    pub fn new() -> Arc<Self> {
        Arc::new(Self {
            catalog: Mutex::new(Arc::new(|_| ok(catalog()))),
            login: Mutex::new(Arc::new(|_, _, _| ok(()))),
            run: Mutex::new(Arc::new(|input: Input| {
                Box::pin(async move {
                    input.delta("Hello");
                    input.message("Hello");
                    Ok(vec![json!({"persisted": true})])
                })
            })),
            stop: Mutex::new(Arc::new(|| ok(()))),
            dispose: Mutex::new(Arc::new(|| ok(()))),
            details: Mutex::new(None),
            configure: Mutex::new(None),
            steer: Mutex::new(None),
        })
    }

    /// `{ ...driver }`: the same members, replaced independently after.
    pub fn copy(&self) -> Arc<Self> {
        Arc::new(Self {
            catalog: Mutex::new(self.catalog.lock().unwrap().clone()),
            login: Mutex::new(self.login.lock().unwrap().clone()),
            run: Mutex::new(self.run.lock().unwrap().clone()),
            stop: Mutex::new(self.stop.lock().unwrap().clone()),
            dispose: Mutex::new(self.dispose.lock().unwrap().clone()),
            details: Mutex::new(self.details.lock().unwrap().clone()),
            configure: Mutex::new(self.configure.lock().unwrap().clone()),
            steer: Mutex::new(self.steer.lock().unwrap().clone()),
        })
    }

    pub fn set_run<F, R>(&self, f: F)
    where
        F: Fn(Input) -> R + Send + Sync + 'static,
        R: Future<Output = AssistantResult<Vec<Value>>> + Send + 'static,
    {
        *self.run.lock().unwrap() = Arc::new(move |input| boxed(f(input)));
    }

    pub fn set_catalog<F, R>(&self, f: F)
    where
        F: Fn(String) -> R + Send + Sync + 'static,
        R: Future<Output = AssistantResult<Value>> + Send + 'static,
    {
        *self.catalog.lock().unwrap() = Arc::new(move |source| boxed(f(source)));
    }

    pub fn set_login<F, R>(&self, f: F)
    where
        F: Fn(String, String, Login) -> R + Send + Sync + 'static,
        R: Future<Output = AssistantResult<()>> + Send + 'static,
    {
        *self.login.lock().unwrap() =
            Arc::new(move |provider, method, login| boxed(f(provider, method, login)));
    }

    pub fn set_stop<F, R>(&self, f: F)
    where
        F: Fn() -> R + Send + Sync + 'static,
        R: Future<Output = AssistantResult<()>> + Send + 'static,
    {
        *self.stop.lock().unwrap() = Arc::new(move || boxed(f()));
    }

    pub fn set_dispose<F, R>(&self, f: F)
    where
        F: Fn() -> R + Send + Sync + 'static,
        R: Future<Output = AssistantResult<()>> + Send + 'static,
    {
        *self.dispose.lock().unwrap() = Arc::new(move || boxed(f()));
    }

    pub fn set_details<F, R>(&self, f: F)
    where
        F: Fn(Vec<Value>, Value, Option<PathBuf>) -> R + Send + Sync + 'static,
        R: Future<Output = AssistantResult<Value>> + Send + 'static,
    {
        *self.details.lock().unwrap() = Some(Arc::new(move |entries, messages, dir| {
            boxed(f(entries, messages, dir))
        }));
    }

    pub fn set_configure<F, R>(&self, f: F)
    where
        F: Fn(Value, SaveModels) -> R + Send + Sync + 'static,
        R: Future<Output = AssistantResult<()>> + Send + 'static,
    {
        *self.configure.lock().unwrap() = Some(Arc::new(move |input, save| boxed(f(input, save))));
    }

    pub fn set_steer<F, R>(&self, f: F)
    where
        F: Fn(String, String) -> R + Send + Sync + 'static,
        R: Future<Output = AssistantResult<()>> + Send + 'static,
    {
        *self.steer.lock().unwrap() = Some(Arc::new(move |text, id| boxed(f(text, id))));
    }
}

/// The service's view of the fake.
pub(super) struct DriverRef(pub Arc<FakeDriver>);

impl AssistantDriver for DriverRef {
    fn catalog(&self, source: &str) -> BoxFuture<AssistantResult<Value>> {
        let f = self.0.catalog.lock().unwrap().clone();
        f(source.to_owned())
    }

    fn configures_models(&self) -> bool {
        self.0.configure.lock().unwrap().is_some()
    }

    fn configure_model(&self, input: Value, save: SaveModels) -> BoxFuture<AssistantResult<()>> {
        let f = self.0.configure.lock().unwrap().clone().unwrap();
        f(input, save)
    }

    fn reads_tool_details(&self) -> bool {
        self.0.details.lock().unwrap().is_some()
    }

    fn read_tool_details(
        &self,
        entries: Vec<Value>,
        messages: Value,
        source_directory: Option<PathBuf>,
    ) -> BoxFuture<AssistantResult<Value>> {
        let f = self.0.details.lock().unwrap().clone().unwrap();
        f(entries, messages, source_directory)
    }

    fn login(
        &self,
        provider: &str,
        method: &str,
        source: &str,
        interaction: Arc<dyn LoginInteraction>,
        cancel: CancellationToken,
    ) -> BoxFuture<AssistantResult<()>> {
        let f = self.0.login.lock().unwrap().clone();
        f(
            provider.to_owned(),
            method.to_owned(),
            Login {
                interaction,
                source: source.to_owned(),
                signal: cancel,
            },
        )
    }

    fn run(
        &self,
        input: RunInput,
        cancel: CancellationToken,
    ) -> BoxFuture<AssistantResult<Vec<Value>>> {
        let f = self.0.run.lock().unwrap().clone();
        f(Input {
            input,
            signal: cancel,
        })
    }

    fn steers(&self) -> bool {
        self.0.steer.lock().unwrap().is_some()
    }

    fn steer(&self, text: &str, request_id: &str) -> BoxFuture<AssistantResult<()>> {
        let f = self.0.steer.lock().unwrap().clone().unwrap();
        f(text.to_owned(), request_id.to_owned())
    }

    fn stop(&self) -> BoxFuture<AssistantResult<()>> {
        let f = self.0.stop.lock().unwrap().clone();
        f()
    }

    fn dispose(&self) -> BoxFuture<AssistantResult<()>> {
        let f = self.0.dispose.lock().unwrap().clone();
        f()
    }
}

/// A login's interaction as the TS test sees it.
#[derive(Clone)]
pub(super) struct Login {
    pub interaction: Arc<dyn LoginInteraction>,
    pub source: String,
    pub signal: CancellationToken,
}

impl Login {
    pub async fn prompt(&self, prompt: Value) -> AssistantResult<String> {
        self.interaction.prompt(prompt, self.signal.clone()).await
    }

    pub fn notify(&self, event: Value) {
        self.interaction.event(event);
    }
}

/// A turn's input as the TS test sees it (`input.delta`, `input.read`...).
#[derive(Clone)]
pub(super) struct Input {
    pub input: RunInput,
    pub signal: CancellationToken,
}

fn call(
    handler: Option<&crate::tools::Handler>,
    kind: &'static str,
    args: Value,
) -> Fut<ToolResult> {
    match handler {
        Some(handler) => handler(kind, args, None),
        None => panic!("the turn has no {kind} handler"),
    }
}

impl Input {
    pub fn text(&self) -> &str {
        &self.input.text
    }

    pub fn request_id(&self) -> String {
        self.input.request_id.clone().unwrap_or_default()
    }

    pub fn config(&self) -> &Value {
        &self.input.config
    }

    pub fn entries(&self) -> Value {
        Value::Array(self.input.entries.clone())
    }

    pub fn emit(&self, event: RunEvent) {
        (self.input.events)(event);
    }

    pub fn delta(&self, text: &str) {
        self.emit(RunEvent::Delta(text.into()));
    }

    pub fn message(&self, text: &str) {
        self.emit(RunEvent::Message(text.into()));
    }

    pub fn tool(&self, id: &str, name: &str, status: &str, details: Option<Value>) {
        self.emit(RunEvent::Tool {
            id: id.into(),
            name: name.into(),
            status: status.into(),
            details,
        });
    }

    pub async fn checkpoint(&self, entries: Vec<Value>) -> AssistantResult<()> {
        (self.input.checkpoint.clone().unwrap())(entries).await
    }

    pub fn read(&self, kind: &'static str, args: Value) -> Fut<ToolResult> {
        call(Some(&self.input.handlers.read), kind, args)
    }

    pub fn propose(&self, kind: &'static str, args: Value) -> Fut<ToolResult> {
        call(self.input.handlers.propose.as_ref(), kind, args)
    }

    pub fn task(&self, kind: &'static str, args: Value) -> Fut<ToolResult> {
        call(self.input.handlers.task.as_ref(), kind, args)
    }

    pub fn notify(&self, notification: Value) -> Fut<ToolResult> {
        call(self.input.handlers.notify.as_ref(), "notify", notification)
    }

    pub fn show(&self, target: Value) -> Fut<ToolResult> {
        call(self.input.handlers.show.as_ref(), "show", target)
    }

    pub fn threads(&self, params: Value) -> Fut<ToolResult> {
        call(self.input.handlers.threads.as_ref(), "reply", params)
    }
}

// ------------------------------------------------------------ setup

/// Makes a child's driver (`childDriver`).
pub(super) type ChildDriver = Arc<dyn Fn() -> Arc<FakeDriver> + Send + Sync>;

#[derive(Default)]
pub(super) struct Setup {
    pub child: Option<ChildDriver>,
    pub chat_threads: Option<ChatThreads>,
    /// `jest.useFakeTimers({now})` before the service is made.
    pub fake_now: Option<&'static str>,
}

pub(super) struct Fixture {
    pub service: AssistantService,
    pub directory: PathBuf,
    pub snapshots: Arc<Mutex<Vec<Value>>>,
    pub notifications: Arc<Mutex<Vec<Value>>>,
    pub context: Arc<FakeContext>,
    pub driver: Arc<FakeDriver>,
    pub timers: Arc<Timers>,
    pub data: DataContext,
    pub child: Option<ChildDriver>,
    services: Mutex<Vec<AssistantService>>,
    _home: tempfile::TempDir,
}

fn never_driver() -> CreateDriver {
    Arc::new(|_, _| panic!("the test gives every driver"))
}

pub(super) fn setup() -> Fixture {
    setup_with(|_| {}, Setup::default())
}

pub(super) fn setup_driver(overrides: impl FnOnce(&FakeDriver)) -> Fixture {
    setup_with(overrides, Setup::default())
}

/// The options of a service on a directory and the fakes.
pub(super) fn service_options(
    context: &Arc<FakeContext>,
    data: &DataContext,
    timers: &Arc<Timers>,
    directory: &std::path::Path,
    driver: Option<Arc<FakeDriver>>,
    child: Option<ChildDriver>,
) -> ServiceOptions {
    let mut options = ServiceOptions::new(
        Arc::new(ContextRef(context.clone())),
        Arc::new(|_| {}),
        data.clone(),
        timers.clone() as SharedClock,
        never_driver(),
    );
    options.directory = Some(directory.to_path_buf());
    options.driver = driver.map(|d| Arc::new(DriverRef(d)) as Arc<dyn AssistantDriver>);
    if let Some(child) = child {
        options.create_driver = Some(Arc::new(move |_, _| {
            Arc::new(DriverRef(child())) as Arc<dyn AssistantDriver>
        }));
    }
    options
}

pub(super) fn setup_with(overrides: impl FnOnce(&FakeDriver), options: Setup) -> Fixture {
    let home = tempfile::tempdir().unwrap();
    let data = DataContext::new(home.path(), Platform::Unix, None);
    let directory = home.path().join("assistant");
    let timers = Arc::new(Timers {
        fake: Mutex::new(options.fake_now.map(clock_at)),
    });
    let context = FakeContext::new();
    let driver = FakeDriver::new();
    overrides(&driver);
    let snapshots: Arc<Mutex<Vec<Value>>> = Arc::default();
    let notifications: Arc<Mutex<Vec<Value>>> = Arc::default();
    let mut service = service_options(
        &context,
        &data,
        &timers,
        &directory,
        Some(driver.clone()),
        options.child.clone(),
    );
    let recorded = snapshots.clone();
    service.publish = Arc::new(move |snapshot| recorded.lock().unwrap().push(snapshot));
    let recorded = notifications.clone();
    service.notify = Some(Arc::new(move |notification| {
        recorded.lock().unwrap().push(notification);
        Ok(())
    }));
    service.chat_threads = options.chat_threads;
    let service = AssistantService::new(service);
    Fixture {
        services: Mutex::new(vec![service.clone()]),
        service,
        directory,
        snapshots,
        notifications,
        context,
        driver,
        timers,
        data,
        child: options.child,
        _home: home,
    }
}

impl Fixture {
    /// The options of another service on this fixture's state.
    pub fn options(&self, driver: Option<Arc<FakeDriver>>) -> ServiceOptions {
        service_options(
            &self.context,
            &self.data,
            &self.timers,
            &self.directory,
            driver,
            self.child.clone(),
        )
    }

    /// `createAssistantService({directory, context, driver, publish})`
    /// again on this fixture's state.
    pub fn restart(&self, driver: Arc<FakeDriver>) -> AssistantService {
        self.restart_with(self.options(Some(driver)))
    }

    pub fn restart_with(&self, options: ServiceOptions) -> AssistantService {
        let service = AssistantService::new(options);
        self.services.lock().unwrap().push(service.clone());
        service
    }

    pub fn peek(&self) -> Value {
        self.service.peek()
    }

    pub fn snapshots(&self) -> Vec<Value> {
        self.snapshots.lock().unwrap().clone()
    }

    pub fn last_snapshot(&self) -> Value {
        self.snapshots
            .lock()
            .unwrap()
            .last()
            .cloned()
            .unwrap_or(Value::Null)
    }

    pub fn notifications(&self) -> Vec<Value> {
        self.notifications.lock().unwrap().clone()
    }

    pub fn state_path(&self) -> PathBuf {
        self.directory.join("state.json")
    }

    pub fn saved(&self) -> Value {
        read_json(&self.state_path())
    }

    pub async fn handle(&self, method: &str, params: Value) -> AssistantResult<Value> {
        self.service.handle(method, params).await
    }

    /// `jest.useFakeTimers({now})`.
    pub fn use_fake_timers(&self, now: Option<&str>) -> &'static JestClock {
        let clock = match now {
            Some(now) => clock_at(now),
            None => clock_at_ms(SystemClock.now()),
        };
        *self.timers.fake.lock().unwrap() = Some(clock);
        clock
    }

    /// `jest.advanceTimersByTime(ms)`.
    pub async fn advance(&self, ms: u64) {
        self.timers.clock().expect("fake timers").advance(ms).await;
    }

    pub fn now(&self) -> i64 {
        self.timers.now()
    }

    /// The `afterEach`: every service disposed.
    pub async fn finish(self) {
        let services: Vec<AssistantService> = self.services.lock().unwrap().drain(..).collect();
        for service in services {
            service.dispose().await;
        }
    }
}

/// `until(check)`: the runtime turns until the check holds.
pub(super) async fn until(check: impl Fn() -> bool) {
    for _ in 0..100 {
        if check() {
            return;
        }
        for _ in 0..10 {
            tokio::task::yield_now().await;
        }
        tokio::time::sleep(Duration::from_millis(1)).await;
    }
    panic!("State did not settle");
}

/// `flushTasks()`.
pub(super) async fn flush_tasks() {
    for _ in 0..100 {
        tokio::task::yield_now().await;
    }
}

pub(super) fn counter() -> Arc<AtomicUsize> {
    Arc::new(AtomicUsize::new(0))
}

pub(super) fn count(counter: &AtomicUsize) -> usize {
    counter.load(Ordering::SeqCst)
}

pub(super) fn bump(counter: &AtomicUsize) -> usize {
    counter.fetch_add(1, Ordering::SeqCst) + 1
}

pub(super) fn flag() -> Arc<AtomicBool> {
    Arc::new(AtomicBool::new(false))
}

/// What a closure keeps for the test to read after (a `let` the TS test
/// assigns from a callback).
pub(super) fn slot<T>() -> Arc<Mutex<Option<T>>> {
    Arc::new(Mutex::new(None))
}

pub(super) fn list<T>() -> Arc<Mutex<Vec<T>>> {
    Arc::new(Mutex::new(Vec::new()))
}
