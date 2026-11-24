//! The mr_reviews family in the core: roamgate-mr-reviews' module
//! ([`MrReviews`]), owner of `<data>/mr-reviews/state.json`, `agent.json`
//! and the efforts' ledgers, and of the `mr_reviews` pushes.
//!
//! What it needs of what Bun still owns goes through reverse calls
//! (contract/wire/core-channel.md): the connections and their hosts, Herdr
//! and conversation mode (`mr_reviews.connections`, `mr_reviews.connection`),
//! the forge reads through glab and gh and their gate (`mr_reviews.fetch`),
//! settings.json's `mr_reviews` writes (`mr_reviews.settings_write`; the
//! file is read here), the review service (`mr_reviews.review`), the
//! Workspaces tree (`mr_reviews.tree`), worktrees (`mr_reviews.create_worktree`),
//! model runs (`mr_reviews.run_model`, `mr_reviews.inference_models`) and
//! agent profiles (`mr_reviews.agent_command`). The reviews agent has no
//! Claude Code driver in the core yet: its questions fail here until one
//! lands (roamgate-claude).
//!
//! - Browser calls: `bridge.mr_reviews.*`.
//! - The front's own calls: `internal.mr_reviews.board_tool {tool, params,
//!   caller}` (the agent socket's `reviews` command) gives `{text}`;
//!   `internal.mr_reviews.call {method, params}` (the effort leader's pane);
//!   `internal.mr_reviews.tree_changed {tree}`.
//!
//! The module is made, its state read, when the core starts owning the
//! family, and stopped and dropped when it stops.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use roamgate_base::env::ProcessEnv;
use roamgate_base::paths::DataContext;
use roamgate_base::settings::Settings;
use roamgate_channel::family::{CoreFamily, FamilyContext, Reply};
use roamgate_channel::peer::{BoxFuture, IncomingCall};
use roamgate_channel::protocol::{Push, RpcError};
use roamgate_forge::complexity::Provider;
use roamgate_forge::hosts::{discover_forge_hosts, gh_hosts_path, glab_config_path};
use roamgate_mr_reviews::agent_remote::RemoteDriver;
use roamgate_mr_reviews::claude::{AgentCommand, AgentCommandFn};
use roamgate_mr_reviews::connection::{
    BoxFuture as MrFuture, LaunchSpec, MrConnection, ShellResult, SwitchResult,
};
use roamgate_mr_reviews::curation::{ModelAnswer, RunModel};
use roamgate_mr_reviews::fetchers::{FetchCall, FetchError, FetchResult, InboxFetchers};
use roamgate_mr_reviews::module::{
    InferenceModels, MrReviews, MrReviewsChange, MrReviewsOptions, SettingsFile, TreeAccess,
};
use roamgate_mr_reviews::open::DefaultConnection;
use roamgate_mr_reviews::rpc::RpcError as ReviewsError;
use roamgate_mr_reviews::store::{MrStore, state_path};
use serde_json::{Map, Value, json};

use super::activity::settings_file;

pub const FAMILY: &str = "mr_reviews";

/// How often the connections are listed again besides before each call.
const CONNECTIONS_EVERY: Duration = Duration::from_secs(5);
/// settings.json's `mr_reviews` written again when it moved meanwhile.
const WRITE_TRIES: usize = 5;

type Obj = Map<String, Value>;

pub fn family() -> Option<Arc<dyn CoreFamily>> {
    Some(Arc::new(MrReviewsFamily::default()))
}

#[derive(Default)]
struct Slot {
    epoch: u64,
    reviews: Option<MrReviews>,
}

#[derive(Default)]
struct MrReviewsFamily {
    slot: Arc<Mutex<Slot>>,
    host: Arc<HostCache>,
    /// The reviews agent's turns, run by Bun's Claude Code driver.
    agent: Mutex<Option<RemoteDriver>>,
}

/// The connections as Bun last listed them, and the default one.
#[derive(Default)]
struct HostCache {
    connections: Mutex<Vec<Arc<dyn MrConnection>>>,
    default: Mutex<Option<DefaultConnection>>,
    /// The inference's automatic model, as Bun last said it.
    automatic: Mutex<String>,
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|e| e.into_inner())
}

fn text(value: &Value, name: &str) -> String {
    value
        .get(name)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned()
}

/// A module's refusal as the channel carries it: its code kept.
fn channel_error(error: ReviewsError) -> RpcError {
    match error {
        ReviewsError::Reviews { message, code } => RpcError::with_code(message, &code),
        ReviewsError::Failed(message) => RpcError::new(message),
    }
}

fn not_owner() -> RpcError {
    RpcError::with_code("the core does not own the reviews", "not_owner")
}

impl HostCache {
    /// Lists the connections again (`mr_reviews.connections`).
    async fn refresh(self: &Arc<Self>, cx: &FamilyContext) {
        let Ok(answer) = cx.reverse("mr_reviews.connections", json!({})).await else {
            return;
        };
        let connections: Vec<Arc<dyn MrConnection>> = answer
            .get("connections")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .map(|each| {
                Arc::new(ReverseConnection {
                    cx: cx.clone(),
                    id: text(each, "id"),
                    label: text(each, "label"),
                    can_launch: each.get("can_launch") == Some(&Value::Bool(true)),
                }) as Arc<dyn MrConnection>
            })
            .collect();
        *lock(&self.connections) = connections;
        *lock(&self.default) =
            answer
                .get("default")
                .filter(|value| value.is_object())
                .map(|each| DefaultConnection {
                    id: text(each, "id"),
                    label: text(each, "label"),
                    ready: each.get("ready") == Some(&Value::Bool(true)),
                });
    }
}

/// A connection Bun runs (`mrReviewConnections`), through
/// `mr_reviews.connection {connection_id, op, ...}`.
struct ReverseConnection {
    cx: FamilyContext,
    id: String,
    label: String,
    can_launch: bool,
}

impl ReverseConnection {
    async fn ask(&self, op: &str, args: Value) -> Result<Value, String> {
        let mut args = match args {
            Value::Object(map) => map,
            _ => Obj::new(),
        };
        args.insert("connection_id".into(), json!(self.id));
        args.insert("op".into(), json!(op));
        self.cx
            .reverse("mr_reviews.connection", Value::Object(args))
            .await
            .map_err(|error| error.message)
    }
}

impl MrConnection for ReverseConnection {
    fn id(&self) -> &str {
        &self.id
    }

    fn label(&self) -> &str {
        &self.label
    }

    fn run<'a>(&'a self, script: &'a str, timeout_ms: u64) -> MrFuture<'a, ShellResult> {
        Box::pin(async move {
            match self
                .ask("run", json!({"script": script, "timeout_ms": timeout_ms}))
                .await
            {
                Ok(result) => ShellResult {
                    code: result.get("code").and_then(Value::as_i64).unwrap_or(-1) as i32,
                    stdout: text(&result, "stdout"),
                    stderr: text(&result, "stderr"),
                },
                Err(message) => ShellResult {
                    code: -1,
                    stdout: String::new(),
                    stderr: message,
                },
            }
        })
    }

    fn dirs(&self) -> MrFuture<'_, Vec<String>> {
        Box::pin(async move {
            self.ask("dirs", json!({}))
                .await
                .ok()
                .and_then(|dirs| dirs.as_array().cloned())
                .unwrap_or_default()
                .into_iter()
                .filter_map(|dir| dir.as_str().map(str::to_owned))
                .collect()
        })
    }

    fn herdr<'a>(&'a self, method: &'a str, params: Value) -> MrFuture<'a, Result<Value, String>> {
        Box::pin(async move {
            self.ask("herdr", json!({"method": method, "params": params}))
                .await
        })
    }

    fn can_launch(&self) -> bool {
        self.can_launch
    }

    fn launch<'a>(
        &'a self,
        pane_id: &'a str,
        spec: LaunchSpec,
    ) -> MrFuture<'a, Result<String, String>> {
        Box::pin(async move {
            let typed = self
                .ask(
                    "launch",
                    json!({"pane_id": pane_id, "spec": spec.to_json()}),
                )
                .await?;
            typed
                .as_str()
                .map(str::to_owned)
                .ok_or_else(|| "no launch here".to_owned())
        })
    }

    fn conversation_owned<'a>(&'a self, pane_id: &'a str) -> MrFuture<'a, Option<String>> {
        Box::pin(async move {
            self.ask("conversation_owned", json!({"pane_id": pane_id}))
                .await
                .ok()
                .and_then(|owned| owned.as_str().map(str::to_owned))
        })
    }

    fn conversation_switch<'a>(
        &'a self,
        pane_id: &'a str,
        session_id: &'a str,
    ) -> MrFuture<'a, SwitchResult> {
        Box::pin(async move {
            match self
                .ask(
                    "conversation_switch",
                    json!({"pane_id": pane_id, "session_id": session_id}),
                )
                .await
            {
                Ok(answer) if answer.get("ok") == Some(&Value::Bool(true)) => SwitchResult::Ok,
                Ok(answer) => SwitchResult::Refused {
                    busy: answer.get("busy") == Some(&Value::Bool(true)),
                    reason: text(&answer, "reason"),
                },
                Err(reason) => SwitchResult::Refused {
                    busy: false,
                    reason,
                },
            }
        })
    }

    fn conversation_prompt<'a>(
        &'a self,
        pane_id: &'a str,
        text: &'a str,
    ) -> MrFuture<'a, Result<bool, String>> {
        Box::pin(async move {
            self.ask(
                "conversation_prompt",
                json!({"pane_id": pane_id, "text": text}),
            )
            .await
            .map(|answer| answer == Value::Bool(true))
        })
    }
}

/// The inbox's forge reads, through Bun's glab and gh and their gate
/// (`mr_reviews.fetch {op, ...}`: `{value}` or `{error: {kind?, message}}`).
struct ReverseFetchers {
    cx: FamilyContext,
}

impl ReverseFetchers {
    async fn fetch(&self, args: Value) -> FetchResult<Value> {
        let answer = self
            .cx
            .reverse("mr_reviews.fetch", args)
            .await
            .map_err(|error| FetchError::Failed(error.message))?;
        if let Some(error) = answer.get("error") {
            return Err(FetchError::from_json(error));
        }
        Ok(answer.get("value").cloned().unwrap_or(Value::Null))
    }
}

impl InboxFetchers for ReverseFetchers {
    fn gitlab<'a>(
        &'a self,
        host: &'a str,
        query: &'a str,
        call: &'a FetchCall,
    ) -> MrFuture<'a, FetchResult<Value>> {
        Box::pin(
            self.fetch(
                json!({"op": "gitlab", "host": host, "query": query, "call": call.to_json()}),
            ),
        )
    }

    fn github<'a>(
        &'a self,
        host: &'a str,
        query: &'a str,
        call: &'a FetchCall,
    ) -> MrFuture<'a, FetchResult<Value>> {
        Box::pin(
            self.fetch(
                json!({"op": "github", "host": host, "query": query, "call": call.to_json()}),
            ),
        )
    }

    fn gitlab_drafts<'a>(&'a self, item: &'a Obj) -> MrFuture<'a, FetchResult<usize>> {
        Box::pin(async move {
            let value = self
                .fetch(json!({"op": "gitlab_drafts", "item": item}))
                .await?;
            Ok(value.as_f64().unwrap_or(0.0).max(0.0) as usize)
        })
    }

    fn gitlab_label_events<'a>(&'a self, item: &'a Obj) -> Option<MrFuture<'a, FetchResult<Obj>>> {
        Some(Box::pin(async move {
            let value = self
                .fetch(json!({"op": "gitlab_label_events", "item": item}))
                .await?;
            Ok(value.as_object().cloned().unwrap_or_default())
        }))
    }
}

/// settings.json: read from its file, `mr_reviews` written by Bun
/// (`mr_reviews.settings_write {expect, mr_reviews}`: written only when
/// `mr_reviews` is still `expect`), asked again when it moved.
struct ReverseSettings {
    cx: FamilyContext,
}

/// settings.json now, normalized. Read at once (a small file), as Bun's
/// cached settings are: the module reads it at every step.
fn read_settings() -> Value {
    let raw = match std::fs::read(settings_file(&ProcessEnv)) {
        Ok(bytes) => serde_json::from_slice::<Value>(&bytes).unwrap_or(Value::Null),
        Err(_) => Value::Null,
    };
    Settings::normalize(&raw).into_value()
}

impl SettingsFile for ReverseSettings {
    fn read(&self) -> MrFuture<'_, Result<Value, String>> {
        let value = read_settings();
        Box::pin(async move { Ok(value) })
    }

    fn update_mr_reviews(&self, change: MrReviewsChange) -> MrFuture<'_, Result<Obj, String>> {
        Box::pin(async move {
            for _ in 0..WRITE_TRIES {
                let current = read_settings();
                let before = current.get("mr_reviews").and_then(Value::as_object);
                let next = change(before);
                let answer = self
                    .cx
                    .reverse(
                        "mr_reviews.settings_write",
                        json!({"expect": before, "mr_reviews": next}),
                    )
                    .await
                    .map_err(|error| error.message)?;
                if answer.get("written") == Some(&Value::Bool(true)) {
                    return Ok(answer
                        .get("mr_reviews")
                        .and_then(Value::as_object)
                        .cloned()
                        .unwrap_or_default());
                }
            }
            Err("settings.json kept changing".to_owned())
        })
    }
}

/// `claude -p` as Bun runs it (`mr_reviews.run_model`).
struct ReverseModel {
    cx: FamilyContext,
}

impl RunModel for ReverseModel {
    fn run<'a>(
        &'a self,
        model: &'a str,
        system: &'a str,
        prompt: &'a str,
    ) -> MrFuture<'a, Result<ModelAnswer, String>> {
        Box::pin(async move {
            let answer = self
                .cx
                .reverse(
                    "mr_reviews.run_model",
                    json!({"model": model, "system": system, "prompt": prompt}),
                )
                .await
                .map_err(|error| error.message)?;
            Ok(ModelAnswer {
                text: text(&answer, "text"),
                cost_usd: answer.get("costUsd").and_then(Value::as_f64),
                ms: answer.get("ms").and_then(Value::as_f64).unwrap_or(0.0),
            })
        })
    }
}

/// A reverse call whose `{args}` is an object and whose answer is one.
fn object_call(
    cx: &FamilyContext,
    target: &'static str,
    op: &'static str,
) -> roamgate_mr_reviews::effort_service::rpc::CallFn {
    let cx = cx.clone();
    Arc::new(move |input: Obj| {
        let cx = cx.clone();
        Box::pin(async move {
            let answer = cx
                .reverse(target, json!({"op": op, "params": input}))
                .await
                .map_err(|error| error.message)?;
            Ok(answer.as_object().cloned().unwrap_or_default())
        })
    })
}

/// The forge hosts this machine's glab and gh have logins for.
fn discover_hosts() -> Vec<Value> {
    let home = std::env::var_os("HOME")
        .map(std::path::PathBuf::from)
        .unwrap_or_default();
    let read =
        |path: Option<std::path::PathBuf>| path.and_then(|path| std::fs::read_to_string(path).ok());
    let glab = read(glab_config_path(&ProcessEnv, &home));
    let gh = read(gh_hosts_path(&ProcessEnv, &home));
    discover_forge_hosts(glab.as_deref(), gh.as_deref())
        .into_iter()
        .map(|host| {
            let provider = match host.provider {
                Provider::Gitlab => "gitlab",
                Provider::Github => "github",
            };
            json!({"host": host.host, "provider": provider})
        })
        .collect()
}

/// The reviews agent's driver: its turns asked of Bun
/// (`mr_reviews.agent_turn`, `mr_reviews.agent_stop`).
fn remote_driver(cx: &FamilyContext) -> RemoteDriver {
    let cx = cx.clone();
    RemoteDriver::new(Arc::new(move |op: &'static str, args: Value| {
        let cx = cx.clone();
        Box::pin(async move {
            let target = if op == "turn" {
                "mr_reviews.agent_turn"
            } else {
                "mr_reviews.agent_stop"
            };
            cx.reverse(target, args)
                .await
                .map_err(|error| error.message)
        })
    }))
}

fn options(cx: &FamilyContext, host: &Arc<HostCache>, agent: &RemoteDriver) -> MrReviewsOptions {
    let context = DataContext::from_env(&ProcessEnv);
    let store = Arc::new(Mutex::new(MrStore::open(
        context.clone(),
        state_path(&context.data_root()),
    )));
    let mut options = MrReviewsOptions::new(
        context,
        store,
        Arc::new(ReverseSettings { cx: cx.clone() }),
        Arc::new(ReverseFetchers { cx: cx.clone() }),
    );
    options.logger = super::limit_resume::scoped_logger(cx, "bridge");
    options.clock = Some(cx.clock.clone());
    options.discover_hosts = Arc::new(discover_hosts);
    options.connections = {
        let host = host.clone();
        Arc::new(move || lock(&host.connections).clone())
    };
    options.default_connection = Some({
        let host = host.clone();
        Arc::new(move || lock(&host.default).clone())
    });
    options.publish = Some({
        let cx = cx.clone();
        Arc::new(move |push: Obj| {
            cx.push(Push {
                message: json!({"mr_reviews": push}),
                ..Push::default()
            })
        })
    });
    let review = |op: &'static str| {
        let cx = cx.clone();
        move |params: Obj| {
            let cx = cx.clone();
            async move {
                cx.reverse("mr_reviews.review", json!({"op": op, "params": params}))
                    .await
            }
        }
    };
    options.open_review = Some({
        let open = review("open");
        Arc::new(move |params: Obj| {
            let answer = open(params);
            Box::pin(async move {
                answer
                    .await
                    .map_err(|error| ReviewsError::Failed(error.message))
            })
        })
    });
    options.request_review = Some({
        let request = review("request");
        Arc::new(move |params: Obj| {
            let answer = request(params);
            Box::pin(async move {
                answer
                    .await
                    .map(|_| ())
                    .map_err(|error| ReviewsError::Failed(error.message))
            })
        })
    });
    options.remove_review = Some({
        let cx = cx.clone();
        Arc::new(move |session: String| {
            let cx = cx.clone();
            tokio::spawn(async move {
                let _ = cx
                    .reverse(
                        "mr_reviews.review",
                        json!({"op": "remove", "params": {"sessionId": session}}),
                    )
                    .await;
            });
        })
    });
    options.effort_review = Some({
        let effort = review("effort");
        Arc::new(move |params: Obj| {
            let answer = effort(params);
            Box::pin(async move { answer.await.unwrap_or(Value::Null) })
        })
    });
    options.open_range = Some(object_call(cx, "mr_reviews.review", "open_range"));
    options.create_worktree = Some(object_call(cx, "mr_reviews.create_worktree", "create"));
    options.tree = Some(TreeAccess {
        read: {
            let cx = cx.clone();
            Arc::new(move || {
                let cx = cx.clone();
                Box::pin(async move {
                    cx.reverse("mr_reviews.tree", json!({"op": "read"}))
                        .await
                        .map_err(|error| error.message)
                })
            })
        },
        apply: {
            let cx = cx.clone();
            Arc::new(move |ops: Vec<Value>| {
                let cx = cx.clone();
                Box::pin(async move {
                    cx.reverse("mr_reviews.tree", json!({"op": "apply", "ops": ops}))
                        .await
                        .map(|_| ())
                        .map_err(|error| error.message)
                })
            })
        },
    });
    options.run_model = Some(Arc::new(ReverseModel { cx: cx.clone() }));
    options.inference_models = Some(InferenceModels {
        automatic: {
            let host = host.clone();
            Arc::new(move || lock(&host.automatic).clone())
        },
        list: {
            let cx = cx.clone();
            let host = host.clone();
            Arc::new(move || {
                let cx = cx.clone();
                let host = host.clone();
                Box::pin(async move {
                    let answer = cx
                        .reverse("mr_reviews.inference_models", json!({}))
                        .await
                        .map_err(|error| error.message)?;
                    *lock(&host.automatic) = text(&answer, "automatic");
                    Ok(answer
                        .get("models")
                        .and_then(Value::as_array)
                        .into_iter()
                        .flatten()
                        .filter_map(|model| model.as_str().map(str::to_owned))
                        .collect())
                })
            })
        },
    });
    let agent_command: AgentCommandFn = {
        let cx = cx.clone();
        Arc::new(move |session: String| {
            let cx = cx.clone();
            Box::pin(async move {
                let answer = cx
                    .reverse("mr_reviews.agent_command", json!({"session_id": session}))
                    .await
                    .map_err(|error| error.message)?;
                AgentCommand::from_json(&answer).ok_or_else(|| "no agent command".to_owned())
            })
        })
    };
    options.agent_command = Some(agent_command);
    options.agent_driver = Some(Arc::new(agent.clone()));
    options
}

impl MrReviewsFamily {
    fn reviews(&self) -> Option<MrReviews> {
        lock(&self.slot).reviews.clone()
    }
}

impl CoreFamily for MrReviewsFamily {
    fn name(&self) -> &'static str {
        FAMILY
    }

    /// The inbox written as text from what it holds; the rest as
    /// [`CoreFamily::call`] answers.
    fn call_reply(
        &self,
        cx: &FamilyContext,
        call: IncomingCall,
    ) -> BoxFuture<Result<Reply, RpcError>> {
        let reviews = self.reviews();
        let (Some(reviews), "bridge.mr_reviews.inbox") = (reviews, call.method.as_str()) else {
            let answer = self.call(cx, call);
            return Box::pin(async move { answer.await.map(Reply::Value) });
        };
        let host = self.host.clone();
        let cx = cx.clone();
        Box::pin(async move {
            host.refresh(&cx).await;
            let params = call.params.as_object().cloned().unwrap_or_default();
            reviews
                .inbox()
                .get_text(roamgate_mr_reviews::rpc::inbox_options(&params))
                .await
                .map(Reply::Text)
                .map_err(|error| RpcError::new(error.to_string()))
        })
    }

    fn call(&self, cx: &FamilyContext, call: IncomingCall) -> BoxFuture<Result<Value, RpcError>> {
        let reviews = self.reviews();
        let host = self.host.clone();
        let agent = lock(&self.agent).clone();
        let cx = cx.clone();
        Box::pin(async move {
            // Served once the family started.
            let Some(reviews) = reviews else {
                return Err(not_owner());
            };
            if call
                .method
                .starts_with(roamgate_channel::family::INTERNAL_PREFIX)
            {
                roamgate_channel::core::note_served(&ProcessEnv, FAMILY, &call.method);
            }
            // What the reviews agent's turn reports, and its tools' calls.
            match (call.method.as_str(), agent) {
                ("internal.mr_reviews.agent_event", Some(agent)) => {
                    agent.event(&call.params);
                    return Ok(json!({"ok": true}));
                }
                ("internal.mr_reviews.agent_tool", Some(agent)) => {
                    let tool_params = call.params.get("params").cloned().unwrap_or(json!({}));
                    return Ok(agent
                        .tool(
                            &text(&call.params, "turn_id"),
                            &text(&call.params, "name"),
                            &tool_params,
                        )
                        .await);
                }
                _ => {}
            }
            host.refresh(&cx).await;
            let params = call.params.as_object().cloned().unwrap_or_default();
            match call.method.as_str() {
                "internal.mr_reviews.board_tool" => {
                    let tool = text(&call.params, "tool");
                    let caller = text(&call.params, "caller");
                    let tool_params = call.params.get("params").cloned().unwrap_or(json!({}));
                    reviews
                        .board_tool(&tool, &tool_params, &caller)
                        .await
                        .map(|text| json!({"text": text}))
                        .map_err(channel_error)
                }
                "internal.mr_reviews.call" => {
                    let method = text(&call.params, "method");
                    let inner = call
                        .params
                        .get("params")
                        .and_then(Value::as_object)
                        .cloned()
                        .unwrap_or_default();
                    reviews.handle(&method, &inner).await.map_err(channel_error)
                }
                "internal.mr_reviews.tree_changed" => {
                    let tree = call.params.get("tree").cloned().unwrap_or(Value::Null);
                    tokio::spawn(async move { reviews.tree_changed(&tree).await });
                    Ok(json!({"ok": true}))
                }
                // A browser's: its error as Bun's reply says it, the message alone.
                method if method.starts_with("bridge.mr_reviews.") => reviews
                    .handle(method, &params)
                    .await
                    .map_err(|error| RpcError::new(error.message())),
                method => Err(RpcError::with_code(
                    format!("unknown method {method}"),
                    "unknown_method",
                )),
            }
        })
    }

    fn owned(&self, cx: &FamilyContext, owned: bool) {
        let mut slot = lock(&self.slot);
        slot.epoch += 1;
        let epoch = slot.epoch;
        if let Some(previous) = slot.reviews.take() {
            previous.stop();
        }
        if !owned {
            return;
        }
        // The reviews read the time as Bun's Date.now does: the families'
        // clock (a test clock followed, or the system's).
        let clock = cx.clock.clone();
        roamgate_agents::js::set_now_source(Some(Arc::new(move || clock.now() as f64)));
        let agent = remote_driver(cx);
        *lock(&self.agent) = Some(agent.clone());
        let reviews = MrReviews::new(options(cx, &self.host, &agent));
        slot.reviews = Some(reviews.clone());
        drop(slot);
        let cx = cx.clone();
        let host = self.host.clone();
        let slots = self.slot.clone();
        tokio::spawn(async move {
            host.refresh(&cx).await;
            if let Ok(answer) = cx.reverse("mr_reviews.inference_models", json!({})).await {
                *lock(&host.automatic) = text(&answer, "automatic");
            }
            if lock(&slots).epoch != epoch {
                return;
            }
            reviews.start();
            // The connections come and go: listed again now and then.
            loop {
                cx.clock.sleep(CONNECTIONS_EVERY).await;
                if lock(&slots).epoch != epoch {
                    return;
                }
                host.refresh(&cx).await;
            }
        });
    }
}
