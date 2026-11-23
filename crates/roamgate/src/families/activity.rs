//! The activity family in the core: roamgate-activity's recorder and
//! readers, their effects mapped onto the channel (contract/wire/
//! core-channel.md, Families in the core).
//!
//! - Browser calls: `activity.presence` (the page is the call's
//!   `ctx.socket_id`, its connection `ctx.connection_id`) and
//!   `bridge.activity.timeline`.
//! - The front's own calls: `internal.activity.start` once Bun's recorder
//!   stopped (the handover: the core's recorder never writes before it, or
//!   15 s after the core took the family when no start comes),
//!   `internal.activity.signals {signals}` for what only Bun sees in stage 1
//!   (connection states, Herdr events and listings, the agents conversation
//!   mode runs, closed browser sockets), each stamped with the time Bun saw
//!   it, and `internal.activity.stop` (before Bun takes the family back).
//! - Reverse calls: `herdr.call` (workspace and pane listings),
//!   `conversation.owned_panes`, `activity.hostScript` (git on the
//!   connection's host for branches and remotes).
//!
//! activity.sqlite is written only while the core owns the family; a
//! timeline while it does not (a shadow read) opens it read-only.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use roamgate_activity::BoxFuture as ActivityFuture;
use roamgate_activity::day_input::ActivitySettings;
use roamgate_activity::reader::ActivityReader;
use roamgate_activity::recorder::{ActivityRecorder, OwnedAgent, RecorderHost, RecorderOptions};
use roamgate_activity::repo_info::{RunHostScript, ScriptOutput};
use roamgate_activity::subjects::SubjectResolver;
use roamgate_activity::timeline::timeline_range;
use roamgate_base::clock::{Clock, SystemClock};
use roamgate_base::env::{Env, ProcessEnv, roamgate_env};
use roamgate_base::log::{LogLevel, Logger, LoggerOptions, parse_log_level};
use roamgate_base::paths::DataContext;
use roamgate_sidecar::family::{CoreFamily, FamilyContext};
use roamgate_sidecar::peer::{BoxFuture, IncomingCall};
use roamgate_sidecar::protocol::RpcError;
use serde_json::{Value, json};
use tokio::sync::watch;

pub const FAMILY: &str = "activity";

/// How long the core waits for Bun's `internal.activity.start` after it
/// took the family before recording anyway.
const START_FALLBACK: Duration = Duration::from_secs(15);

/// The family, once this build implements it.
pub fn family() -> Option<Arc<dyn CoreFamily>> {
    let (recorder, _) = watch::channel(None);
    let inner = Arc::new(Inner {
        state: Mutex::default(),
        recorder,
    });
    *CURRENT.lock().unwrap() = Arc::downgrade(&inner);
    Some(Arc::new(ActivityFamily(inner)))
}

/// The core's activity family, for its readers in other families.
static CURRENT: Mutex<std::sync::Weak<Inner>> = Mutex::new(std::sync::Weak::new());

/// How long a read waits for the signals the recorder already has.
const SETTLE: Duration = Duration::from_secs(5);

/// Before reading the log the core writes: its recorder applied every
/// signal it received (a Bun reader reads its own recorder's writes the
/// same way, in one process). Nothing while the core does not record.
pub async fn settle() {
    let inner = CURRENT.lock().unwrap().upgrade();
    if let Some(inner) = inner {
        inner.settle().await;
    }
}

#[derive(Default)]
struct State {
    owned: bool,
    /// Bun said its recorder stopped (or the fallback ran out).
    start_requested: bool,
    /// Bumped at each ownership change: a stale fallback does nothing.
    generation: u64,
}

struct ActivityFamily(Arc<Inner>);

struct Inner {
    state: Mutex<State>,
    /// The running recorder, while the core owns the family and started.
    recorder: watch::Sender<Option<Arc<ActivityRecorder>>>,
}

/// settings.json as the server's environment names it (never written
/// here: the settings family owns it).
pub fn settings_file(env: &dyn Env) -> std::path::PathBuf {
    match roamgate_env(env, "SETTINGS_PATH") {
        Some(path) => path.into(),
        None => DataContext::from_env(env).data_root().join("settings.json"),
    }
}

/// settings.json's raw content now (Null when missing or invalid).
pub async fn settings_json() -> Value {
    let path = settings_file(&ProcessEnv);
    match tokio::fs::read(&path).await {
        Ok(bytes) => serde_json::from_slice::<Value>(&bytes).unwrap_or_else(|error| {
            tracing::warn!(scope = "bridge.settings", path = %path.display(), %error, "ignoring invalid settings");
            Value::Null
        }),
        Err(_) => Value::Null,
    }
}

fn logger(cx: &FamilyContext) -> Logger {
    let level = roamgate_env(&ProcessEnv, "LOG_LEVEL")
        .and_then(|value| parse_log_level(&value).ok())
        .unwrap_or(LogLevel::Info);
    let clock = cx.clock.clone();
    Logger::with(LoggerOptions {
        level: Some(level),
        scope: Some("bridge.activity".into()),
        now: Some(Arc::new(move || clock.now())),
        ..LoggerOptions::default()
    })
}

/// What only Bun sees, through reverse calls.
struct ReverseHost {
    cx: FamilyContext,
}

impl RunHostScript for ReverseHost {
    fn run(
        &self,
        connection_id: &str,
        script: &str,
    ) -> ActivityFuture<Result<ScriptOutput, String>> {
        let cx = self.cx.clone();
        let args = json!({"connection_id": connection_id, "script": script});
        Box::pin(async move {
            let value = cx
                .reverse("activity.hostScript", args)
                .await
                .map_err(|error| error.message)?;
            Ok(ScriptOutput {
                code: value.get("code").and_then(Value::as_i64).unwrap_or(1) as i32,
                stdout: value
                    .get("stdout")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_owned(),
            })
        })
    }
}

impl RecorderHost for ReverseHost {
    fn herdr_call(
        &self,
        connection_id: &str,
        method: &str,
        params: Value,
    ) -> ActivityFuture<Result<Value, String>> {
        let cx = self.cx.clone();
        let args = json!({"connection_id": connection_id, "method": method, "params": params, "timeout_ms": 5000});
        Box::pin(async move {
            cx.reverse("herdr.call", args)
                .await
                .map_err(|error| error.message)
        })
    }

    fn owned_agents(&self, connection_id: &str) -> ActivityFuture<Vec<OwnedAgent>> {
        let cx = self.cx.clone();
        let args = json!({"connection_id": connection_id});
        Box::pin(async move {
            // A connection that is not ready runs none.
            let Ok(listed) = cx.reverse("conversation.owned_panes", args).await else {
                return Vec::new();
            };
            listed
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|pane| {
                    Some(OwnedAgent {
                        pane_id: pane.get("pane_id")?.as_str()?.to_owned(),
                        session_id: pane
                            .get("session_id")
                            .and_then(Value::as_str)
                            .map(str::to_owned),
                        agent_status: pane
                            .get("agent_status")
                            .and_then(Value::as_str)
                            .unwrap_or("")
                            .to_owned(),
                    })
                })
                .collect()
        })
    }
}

fn text<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    value.get(key).and_then(Value::as_str)
}

/// One signal Bun forwarded.
fn apply(recorder: &ActivityRecorder, signal: &Value) {
    let ts = signal.get("ts").and_then(Value::as_i64);
    let connection = text(signal, "connection_id").unwrap_or("");
    match text(signal, "op") {
        Some("connection_status") => {
            if let Some(state) = text(signal, "state") {
                recorder.connection_status(connection, state, ts);
            }
        }
        Some("herdr_event") => recorder.herdr_event(
            connection,
            signal.get("event").cloned().unwrap_or(Value::Null),
            ts,
        ),
        Some("pane_list") => recorder.pane_list(
            connection,
            signal.get("result").cloned().unwrap_or(Value::Null),
            signal
                .get("started_at")
                .and_then(Value::as_i64)
                .unwrap_or(0),
            ts,
        ),
        Some("owned_agent") => {
            if let Some(pane) = text(signal, "pane_id") {
                recorder.owned_agent_changed(connection, pane, ts);
            }
        }
        Some("socket_closed") => {
            if let Some(socket) = signal.get("socket_id").and_then(Value::as_u64) {
                recorder.socket_closed(socket, ts);
            }
        }
        _ => {}
    }
}

impl Inner {
    fn current(&self) -> Option<Arc<ActivityRecorder>> {
        self.recorder.borrow().clone()
    }

    /// Starts the recorder if the core owns the family and Bun's stopped.
    async fn start_if_due(&self, cx: &FamilyContext) {
        {
            let state = self.state.lock().unwrap();
            if !state.owned || !state.start_requested || self.current().is_some() {
                return;
            }
        }
        if cx.owners.check_write(FAMILY).is_err() {
            return;
        }
        let raw = settings_json().await;
        let env = ProcessEnv;
        let context = DataContext::from_env(&env);
        let recorder = ActivityRecorder::start(RecorderOptions {
            settings: ActivitySettings::from_settings(&raw),
            directory: context.data_root(),
            context,
            host: Arc::new(ReverseHost { cx: cx.clone() }),
            clock: cx.clock.clone(),
            logger: logger(cx),
        });
        let state = self.state.lock().unwrap();
        if state.owned && self.current().is_none() {
            self.recorder.send_replace(Some(Arc::new(recorder)));
        } else {
            recorder.stop_now();
        }
    }

    /// The recorder the core runs now, waiting a little for one being
    /// handed over.
    async fn settle(&self) {
        if let Some(recorder) = self.recorder_for_call().await {
            let _ = roamgate_base::clock::timeout(&SystemClock, SETTLE, recorder.flush()).await;
        }
    }

    async fn recorder_for_call(&self) -> Option<Arc<ActivityRecorder>> {
        if !self.state.lock().unwrap().owned {
            return None;
        }
        let mut watch = self.recorder.subscribe();
        let wait = async {
            loop {
                if let Some(recorder) = watch.borrow_and_update().clone() {
                    return Some(recorder);
                }
                if watch.changed().await.is_err() {
                    return None;
                }
            }
        };
        roamgate_base::clock::timeout(&SystemClock, START_FALLBACK, wait)
            .await
            .ok()
            .flatten()
    }

    async fn stop(&self) {
        let previous = self.recorder.send_replace(None);
        if let Some(recorder) = previous {
            recorder.stop().await;
        }
    }

    async fn timeline(&self, params: &Value, now: i64) -> Result<Value, RpcError> {
        let raw = settings_json().await;
        let settings = ActivitySettings::from_settings(&raw);
        self.settle().await;
        let recording = match self.current() {
            Some(recorder) => recorder.ready().await,
            // Not this side's to record (a shadow read): Bun records while
            // the setting is on.
            None => !self.state.lock().unwrap().owned,
        };
        if !settings.enabled || !recording {
            return Ok(json!({"recording": false}));
        }
        let range = timeline_range(params, now, &settings.day_start).map_err(RpcError::new)?;
        let context = DataContext::from_env(&ProcessEnv);
        let reader = ActivityReader::open(
            &context,
            &context.data_root(),
            Box::new(move || now),
            Some(SubjectResolver::from_settings(&raw)),
        )
        .map_err(|error| RpcError::new(error.to_string()))?;
        let Some(reader) = reader else {
            return Ok(json!({"recording": false}));
        };
        reader
            .timeline(
                range,
                &settings.day_start,
                &settings.exclude_connections,
                Some(settings.idle_seconds),
            )
            .map_err(|error| RpcError::new(error.to_string()))
    }
}

impl CoreFamily for ActivityFamily {
    fn name(&self) -> &'static str {
        FAMILY
    }

    fn call(&self, cx: &FamilyContext, call: IncomingCall) -> BoxFuture<Result<Value, RpcError>> {
        let this = self.0.clone();
        let cx = cx.clone();
        Box::pin(async move {
            let params = &call.params;
            match call.method.as_str() {
                "internal.activity.start" => {
                    this.state.lock().unwrap().start_requested = true;
                    this.start_if_due(&cx).await;
                    Ok(json!({"ok": true, "recording": this.current().is_some()}))
                }
                "internal.activity.signals" => {
                    let Some(recorder) = this.current() else {
                        return Ok(json!({"ok": false}));
                    };
                    for signal in params
                        .get("signals")
                        .and_then(Value::as_array)
                        .into_iter()
                        .flatten()
                    {
                        apply(&recorder, signal);
                    }
                    Ok(json!({"ok": true}))
                }
                "internal.activity.flush" => {
                    if let Some(recorder) = this.current() {
                        let _ =
                            roamgate_base::clock::timeout(&SystemClock, SETTLE, recorder.flush())
                                .await;
                    }
                    Ok(json!({"ok": true}))
                }
                "internal.activity.stop" => {
                    {
                        let mut state = this.state.lock().unwrap();
                        state.start_requested = false;
                    }
                    this.stop().await;
                    Ok(json!({"ok": true}))
                }
                "activity.presence" => {
                    let socket = call
                        .ctx
                        .socket_id
                        .ok_or_else(|| RpcError::new("activity.presence needs a socket"))?;
                    let connection = call
                        .ctx
                        .connection_id
                        .clone()
                        .ok_or_else(|| RpcError::new("activity.presence needs a connection"))?;
                    match this.recorder_for_call().await {
                        Some(recorder) => recorder
                            .presence(socket, &connection, params, None)
                            .await
                            .map_err(RpcError::new),
                        None => {
                            roamgate_activity::recorder::parse_presence(params)
                                .map_err(RpcError::new)?;
                            let settings = ActivitySettings::from_settings(&settings_json().await);
                            Ok(
                                json!({"recording": false, "idle_seconds": settings.idle_seconds, "attention": false}),
                            )
                        }
                    }
                }
                "bridge.activity.timeline" => this.timeline(params, cx.clock.now()).await,
                other => Err(RpcError::with_code(
                    format!("unknown method {other}"),
                    "unknown_method",
                )),
            }
        })
    }

    fn owned(&self, cx: &FamilyContext, owned: bool) {
        let this = self.0.clone();
        let generation = {
            let mut state = this.state.lock().unwrap();
            if state.owned == owned {
                return;
            }
            state.owned = owned;
            state.generation += 1;
            if !owned {
                state.start_requested = false;
            }
            state.generation
        };
        let cx = cx.clone();
        if owned {
            // Bun says when its recorder stopped (maybe already, before the
            // table reached the core); record anyway if it never does.
            tokio::spawn(async move {
                this.start_if_due(&cx).await;
                SystemClock.sleep(START_FALLBACK).await;
                {
                    let mut state = this.state.lock().unwrap();
                    if state.generation != generation || !state.owned {
                        return;
                    }
                    state.start_requested = true;
                }
                this.start_if_due(&cx).await;
            });
        } else {
            tokio::spawn(async move { this.stop().await });
        }
    }
}

/// `roamgate activity ...`; returns the exit code.
pub fn cli(args: &[String]) -> u8 {
    roamgate_sidecar::core::note_served(&ProcessEnv, FAMILY, "cli activity");
    let runtime = super::update::cli_runtime(Arc::new(ProcessEnv));
    let now = || SystemClock.now();
    super::update::emit(
        roamgate_cli::activity::ActivityCli {
            runtime: &runtime,
            now: &now,
        }
        .run(args),
    )
}
