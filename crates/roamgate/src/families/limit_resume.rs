//! The limit_resume family in the core: roamgate-connections' resumer,
//! its effects mapped onto the channel (contract/wire/core-channel.md,
//! Reverse targets).
//!
//! - Browser calls: `limit_resume.list`, `.resume_now`, `.skip` (the
//!   connection is the call's `ctx.connection_id`).
//! - The front's own call: `internal.limit_resume.poke {connection_id,
//!   pane_id?}`, for what only Bun sees (a Herdr event, a mod's turn, a
//!   conversation's turn, the settings changed).
//! - Reverse calls: `connections.ready`, `settings.limit_resume.get`,
//!   `herdr.call`, `conversation.owned_panes`, `conversation.prompt`,
//!   `claude_mod.panes`, `claude_mod.deliver`, `agent.transcript_tail`.
//! - Pushes: `{event: "roamgate.limit_pauses", data: {pauses}}` in the
//!   connection's envelope, as Bun sends it.
//!
//! The resumer runs (timers, writes of limit-resume.json) only while the
//! core owns the family. A `limit_resume.list` while it does not (a shadow
//! read) is answered by the core's observer: a resumer that only looks
//! (no timer, no poke, no send, no write), kept between reads so that it
//! reads again only the transcripts that changed, as Bun's own resumer
//! does, and handed to the owner's resumer when the core takes the
//! family, so the first look after a flip is quick too.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use roamgate_base::env::{Env, ProcessEnv, roamgate_env};
use roamgate_base::log::{LogFields, LogLevel, Logger, LoggerOptions, parse_log_level};
use roamgate_base::paths::DataContext;
use roamgate_channel::family::{CoreFamily, FamilyContext};
use roamgate_channel::peer::IncomingCall;
use roamgate_channel::protocol::{Push, RpcError};
use roamgate_connections::BoxFuture;
use roamgate_connections::limit_resume::connection::{
    HostConnection, LimitConnection, LimitHost, ModPane, OwnedPane,
};
use roamgate_connections::limit_resume::scheduler::{
    LimitResumer, ResumerOptions, Timings, WeakLimitResumer,
};
use roamgate_connections::limit_resume::store::{LimitResumeStore, StoreFile};
use roamgate_connections::usage_limit::{
    LIMIT_PAUSES_EVENT, LimitPause, LimitPauseState, LimitResumeSettings, PaneOwner,
};
use serde_json::{Value, json};

pub const FAMILY: &str = "limit_resume";

/// How long a shadow read waits for the observer's look before answering
/// from its last one: well within the front's 10 s for a shadow call, as a
/// look of a connection with tens of conversation panes can take longer.
pub const SHADOW_LOOK_WAIT: std::time::Duration = std::time::Duration::from_secs(5);

/// The family, once this build implements it.
pub fn family() -> Option<Arc<dyn CoreFamily>> {
    Some(Arc::new(LimitResumeFamily::default()))
}

#[derive(Default)]
struct LimitResumeFamily {
    /// The resumer while the core owns the family.
    running: Mutex<Option<LimitResumer>>,
    /// The observer while it does not (made at the first shadow read).
    observer: Mutex<Option<LimitResumer>>,
}

/// The connection generations `connections.ready` last said, for pushes.
type Generations = Arc<Mutex<HashMap<String, u64>>>;

fn logger(cx: &FamilyContext) -> Logger {
    scoped_logger(cx, "bridge.limit-resume")
}

/// A logger of the server's (its level from `ROAMGATE_LOG_LEVEL`) on the
/// families' clock, with a TS scope.
pub(crate) fn scoped_logger(cx: &FamilyContext, scope: &str) -> Logger {
    let level = roamgate_env(&ProcessEnv, "LOG_LEVEL")
        .and_then(|value| parse_log_level(&value).ok())
        .unwrap_or(LogLevel::Info);
    let clock = cx.clock.clone();
    Logger::with(LoggerOptions {
        level: Some(level),
        scope: Some(scope.into()),
        now: Some(Arc::new(move || clock.now())),
        ..LoggerOptions::default()
    })
}

fn store_path(env: &dyn Env) -> std::path::PathBuf {
    DataContext::from_env(env)
        .data_root()
        .join("limit-resume.json")
}

/// A connection's runtime, through reverse calls into Bun.
struct ReverseHost {
    cx: FamilyContext,
    connection_id: String,
}

impl ReverseHost {
    fn call<T: serde::de::DeserializeOwned + Send + 'static>(
        &self,
        target: &'static str,
        mut args: Value,
    ) -> BoxFuture<Result<T, String>> {
        let cx = self.cx.clone();
        args["connection_id"] = json!(self.connection_id);
        Box::pin(async move {
            let value = cx
                .reverse(target, args)
                .await
                .map_err(|error| error.message)?;
            serde_json::from_value(value).map_err(|error| format!("{target}: {error}"))
        })
    }
}

impl LimitHost for ReverseHost {
    fn herdr_call(
        &self,
        method: &str,
        params: Value,
        timeout_ms: u64,
    ) -> BoxFuture<Result<Value, String>> {
        self.call(
            "herdr.call",
            json!({"method": method, "params": params, "timeout_ms": timeout_ms}),
        )
    }

    fn owned_panes(&self) -> BoxFuture<Result<Vec<OwnedPane>, String>> {
        self.call("conversation.owned_panes", json!({}))
    }

    fn mod_panes(&self) -> BoxFuture<Result<Vec<ModPane>, String>> {
        // The core's own hub while it runs here (families/claude_mod.rs).
        if let Some(hub) = super::claude_mod::current() {
            let panes = hub.panes(&self.connection_id);
            return Box::pin(async move {
                serde_json::from_value(Value::Array(panes)).map_err(|error| error.to_string())
            });
        }
        self.call("claude_mod.panes", json!({}))
    }

    fn transcript_tail(&self, pane_id: &str) -> BoxFuture<Result<Option<String>, String>> {
        self.call("agent.transcript_tail", json!({"pane_id": pane_id}))
    }

    fn conversation_prompt(&self, pane_id: &str, text: &str) -> BoxFuture<Result<bool, String>> {
        self.call(
            "conversation.prompt",
            json!({"pane_id": pane_id, "text": text}),
        )
    }

    fn mod_deliver(
        &self,
        pane_id: &str,
        text: &str,
        kind: &str,
    ) -> BoxFuture<Result<bool, String>> {
        if let Some(hub) = super::claude_mod::current() {
            let delivered = hub
                .deliver(&self.connection_id, pane_id, text, kind)
                .map(|id| id.is_some())
                .map_err(|error| error.message);
            super::claude_mod::changed();
            return Box::pin(async move { delivered });
        }
        self.call(
            "claude_mod.deliver",
            json!({"pane_id": pane_id, "text": text, "kind": kind}),
        )
    }
}

type OnChange = Arc<dyn Fn(&str, Vec<LimitPause>) + Send + Sync>;
type Log = Arc<dyn Fn(LogLevel, &str, LogFields) + Send + Sync>;

/// A resumer on the channel. `owned`: it pushes, logs and writes the
/// store; otherwise it writes nothing and tells no one.
fn resumer(cx: &FamilyContext, owned: bool) -> LimitResumer {
    let generations: Generations = Arc::default();
    let connections = {
        let cx = cx.clone();
        let generations = generations.clone();
        Arc::new(move || {
            let cx = cx.clone();
            let generations = generations.clone();
            Box::pin(async move {
                let listed = cx
                    .reverse("connections.ready", json!({}))
                    .await
                    .map_err(|error| error.message)?;
                let mut found: Vec<Arc<dyn LimitConnection>> = Vec::new();
                let mut known = generations.lock().unwrap();
                for each in listed.as_array().into_iter().flatten() {
                    let Some(id) = each.get("id").and_then(Value::as_str) else {
                        continue;
                    };
                    // No transcripts to read on a Windows host (Agent
                    // history is Unix).
                    if each.get("remote_platform").and_then(Value::as_str) == Some("windows") {
                        continue;
                    }
                    if let Some(generation) = each.get("generation").and_then(Value::as_u64) {
                        known.insert(id.to_owned(), generation);
                    }
                    found.push(Arc::new(HostConnection::new(
                        id,
                        Arc::new(ReverseHost {
                            cx: cx.clone(),
                            connection_id: id.to_owned(),
                        }),
                    )));
                }
                Ok(found)
            }) as BoxFuture<_>
        })
    };
    let settings = {
        let cx = cx.clone();
        Arc::new(move || {
            let cx = cx.clone();
            Box::pin(async move {
                let value = cx
                    .reverse("settings.limit_resume.get", json!({}))
                    .await
                    .map_err(|error| error.message)?;
                serde_json::from_value::<LimitResumeSettings>(value)
                    .map_err(|error| format!("settings.limit_resume.get: {error}"))
            }) as BoxFuture<_>
        })
    };
    let clock = cx.clock.clone();
    let path = store_path(&ProcessEnv);
    let file = if owned {
        StoreFile::File {
            path,
            context: DataContext::from_env(&ProcessEnv),
            can_write: Arc::new(|| Ok(())),
        }
    } else {
        StoreFile::ReadOnly(Some(path))
    };
    let store = LimitResumeStore::new(file, Arc::new(move || clock.now()));
    // A conversation that hit its limit continues on the fallback agent,
    // once per limit; set once the resumer exists.
    let fallen_back: Arc<Mutex<std::collections::HashSet<(String, String, i64)>>> = Arc::default();
    let this: Arc<std::sync::OnceLock<WeakLimitResumer>> = Arc::default();
    let on_change: Option<OnChange> = owned.then(|| {
        let cx = cx.clone();
        let this = this.clone();
        Arc::new(move |connection_id: &str, pauses: Vec<LimitPause>| {
            let generation = generations.lock().unwrap().get(connection_id).copied();
            for pause in &pauses {
                if pause.owner == PaneOwner::Conversation
                    && pause.state == LimitPauseState::Scheduled
                    && fallen_back.lock().unwrap().insert((
                        connection_id.to_owned(),
                        pause.pane_id.clone(),
                        pause.resets_at,
                    ))
                {
                    tokio::spawn(fall_back(
                        cx.clone(),
                        this.clone(),
                        connection_id.to_owned(),
                        pause.pane_id.clone(),
                    ));
                }
            }
            cx.push(Push {
                message: json!({"event": LIMIT_PAUSES_EVENT, "data": {"pauses": pauses}}),
                connection_id: Some(connection_id.to_owned()),
                connection_generation: generation,
                ..Push::default()
            });
        }) as OnChange
    });
    let log: Option<Log> = owned.then(|| {
        let logger = logger(cx);
        Arc::new(move |level: LogLevel, message: &str, fields: LogFields| {
            logger.log(level, message, Some(&fields));
        }) as Log
    });
    let resumer = LimitResumer::new(ResumerOptions {
        connections,
        settings,
        store,
        on_change,
        log,
        clock: cx.clock.clone(),
        timings: Timings::default(),
        observer: !owned,
    });
    let _ = this.set(resumer.downgrade());
    resumer
}

/// How often, and how far apart, a refused fallback is asked again.
const FALLBACK_ATTEMPTS: usize = 10;
const FALLBACK_RETRY: std::time::Duration = std::time::Duration::from_secs(2);

/// Moves a conversation that hit its usage limit to the fallback agent
/// (`conversation.fallback_agent`), if one is set; once it moved, the
/// pause is skipped: nothing is resumed on the old agent at the reset.
async fn fall_back(
    cx: FamilyContext,
    resumer: Arc<std::sync::OnceLock<WeakLimitResumer>>,
    connection_id: String,
    pane_id: String,
) {
    let settings = super::settings::read_shared(&cx).await;
    let Some(agent) = settings.conversation_fallback_agent().map(str::to_owned) else {
        return;
    };
    // A conversation being handed over (its takeover may still run when the
    // pause is seen) is asked again a little later.
    let mut refusal = String::new();
    for attempt in 0..FALLBACK_ATTEMPTS {
        if attempt > 0 {
            tokio::time::sleep(FALLBACK_RETRY).await;
        }
        let answer = match super::standalone::call(
            &cx,
            "internal.conversation.switch_agent",
            json!({
                "connection_id": connection_id,
                "pane_id": pane_id,
                "agent": agent,
                "reason": "usage_limit",
            }),
        )
        .await
        {
            Ok(answer) => answer,
            Err(error) => {
                refusal = error.message;
                continue;
            }
        };
        if answer.get("ok") != Some(&Value::Bool(true)) {
            refusal = answer
                .get("reason")
                .and_then(Value::as_str)
                .unwrap_or("refused")
                .to_owned();
            continue;
        }
        // Moved (not already on that agent): nothing is resumed at the reset.
        if answer.get("unchanged").is_none()
            && let Some(resumer) = resumer.get().and_then(WeakLimitResumer::upgrade)
        {
            let _ = resumer.set_skip(&connection_id, &pane_id, true).await;
        }
        return;
    }
    let mut fields = LogFields::new();
    fields.insert("connection".into(), json!(connection_id));
    fields.insert("pane".into(), json!(pane_id));
    fields.insert("agent".into(), json!(agent));
    fields.insert("reason".into(), json!(refusal));
    logger(&cx).log(
        LogLevel::Warn,
        "the conversation did not move to its fallback agent",
        Some(&fields),
    );
}

impl LimitResumeFamily {
    fn running(&self) -> Option<LimitResumer> {
        self.running.lock().unwrap().clone()
    }

    fn observer(&self, cx: &FamilyContext) -> LimitResumer {
        self.observer
            .lock()
            .unwrap()
            .get_or_insert_with(|| resumer(cx, false))
            .clone()
    }
}

impl CoreFamily for LimitResumeFamily {
    fn name(&self) -> &'static str {
        FAMILY
    }

    fn call(&self, cx: &FamilyContext, call: IncomingCall) -> BoxFuture<Result<Value, RpcError>> {
        let running = self.running();
        let observer = running.is_none().then(|| self.observer(cx));
        let clock = cx.clock.clone();
        Box::pin(async move {
            let method = call.method.as_str();
            let params = &call.params;
            if method == "internal.limit_resume.poke" {
                let connection_id = params.get("connection_id").and_then(Value::as_str);
                if let (Some(resumer), Some(connection_id)) = (&running, connection_id) {
                    resumer.poke(connection_id, params.get("pane_id").and_then(Value::as_str));
                }
                return Ok(json!({"ok": true}));
            }
            let connection_id = call
                .ctx
                .connection_id
                .clone()
                .ok_or_else(|| RpcError::new(format!("{method} needs a connection")))?;
            let pane_id = params
                .get("pane_id")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_owned();
            match method {
                "limit_resume.list" => {
                    let pauses = match &running {
                        Some(resumer) => resumer.list(&connection_id),
                        None => {
                            // Not this side's to run (a shadow read): the
                            // observer looks, with the owner's store.
                            let observer = observer.expect("an observer when not owned");
                            observer.store().reload();
                            // Bun answers from what its last look saw; the
                            // observer waits a little for a fresh one, and
                            // otherwise answers from its own last look
                            // while this one goes on.
                            let look = observer.look(&connection_id);
                            let _ = roamgate_base::clock::timeout(
                                clock.as_ref(),
                                SHADOW_LOOK_WAIT,
                                look,
                            )
                            .await;
                            observer.list(&connection_id)
                        }
                    };
                    Ok(json!({"pauses": pauses}))
                }
                "limit_resume.resume_now" | "limit_resume.skip" => {
                    let Some(resumer) = running.filter(|_| !pane_id.is_empty()) else {
                        return Err(RpcError::new(format!("{method} needs a pane_id")));
                    };
                    if method == "limit_resume.resume_now" {
                        Ok(resumer.resume_now(&connection_id, &pane_id).await.to_json())
                    } else {
                        let skip = params.get("skip") != Some(&Value::Bool(false));
                        resumer
                            .set_skip(&connection_id, &pane_id, skip)
                            .await
                            .map(|outcome| outcome.to_json())
                            .map_err(RpcError::new)
                    }
                }
                other => Err(RpcError::new(format!("unknown method {other}"))),
            }
        })
    }

    fn owned(&self, cx: &FamilyContext, owned: bool) {
        let mut running = self.running.lock().unwrap();
        if let Some(previous) = running.take() {
            previous.stop();
        }
        let observer = self.observer.lock().unwrap().take();
        if let Some(observer) = &observer {
            observer.stop();
        }
        if owned {
            let started = resumer(cx, true);
            if let Some(observer) = &observer {
                started.adopt_reads(observer);
            }
            started.start(5_000);
            *running = Some(started);
        }
    }
}
