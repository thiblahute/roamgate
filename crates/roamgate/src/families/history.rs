//! The history family in the core: roamgate-history's runtime, the local
//! history repo's one writer while the core owns the family
//! (contract/wire/core-channel.md, The history family).
//!
//! - HTTP: `/api/history` (status, `PUT` the place and the switch) and
//!   `/api/history/commit` (a pass now), with roamgate-http's route.
//! - The front's own calls: `internal.history.changed {area, id?}` and
//!   `internal.history.work_changed {item, id, change, actor, at}` for the
//!   writes of the stores Bun still owns, sent one at a time, in order;
//!   `internal.history.release` before Bun runs its history again: the
//!   core's last pass is done (or 5 s passed) when it answers.
//! - Reverse calls: `history.release` when the core takes the family:
//!   Bun's runtime stops (its last pass written) before the core's starts;
//!   `history.configure` for the route's settings change while Bun owns
//!   settings.json.
//! - The core's Work board tells it directly ([`tell`]).
//!
//! Git and the files run on blocking threads, never on the event loop.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

use bytes::Bytes;
use roamgate_base::env::{Env, ProcessEnv, roamgate_env};
use roamgate_base::log::{LogFields, LogLevel, Logger, LoggerOptions, parse_log_level};
use roamgate_base::paths::DataContext;
use roamgate_exec::gamemode::{GAME_MODE_TIMEOUT, default_game_mode_command, game_mode_active};
use roamgate_exec::process::ProcessRunner;
use roamgate_history::area::{ReviewSource, history_paths};
use roamgate_history::place::{HistoryPlace, expand_location, history_areas};
use roamgate_history::reviews::SqliteReviews;
use roamgate_history::runtime::{HistoryRuntime, RuntimeOptions, server_place};
use roamgate_history::work::WorkChange;
use roamgate_http::history::{HistoryBackend, HistoryChange, HistoryRoute};
use roamgate_sidecar::family::{CoreFamily, FamilyContext};
use roamgate_sidecar::peer::{BodyReceiver, BoxFuture, HttpRequest, HttpResponse, IncomingCall};
use roamgate_sidecar::protocol::{RpcError, Side};
use serde_json::{Value, json};
use tokio::sync::mpsc;

pub const FAMILY: &str = "history";

/// A store's write, in the order it came.
enum Change {
    Area { area: String, id: Option<String> },
    Work(Box<WorkChange>),
}

struct HistoryFamily {
    /// The runtime while the core owns the family.
    runtime: Mutex<Option<HistoryRuntime>>,
    /// Bumped at each change of hands: a late start does not run.
    turn: Arc<AtomicU64>,
    /// The writes, applied one at a time (a Work change reads its item's
    /// description first).
    changes: OnceLock<mpsc::UnboundedSender<Change>>,
}

/// The family this process made: the core's Work board tells it.
static LATEST: Mutex<std::sync::Weak<HistoryFamily>> = Mutex::new(std::sync::Weak::new());

/// The family, once this build implements it.
pub fn family() -> Option<Arc<dyn CoreFamily>> {
    let family = Arc::new(HistoryFamily {
        runtime: Mutex::new(None),
        turn: Arc::default(),
        changes: OnceLock::new(),
    });
    *LATEST.lock().unwrap() = Arc::downgrade(&family);
    Some(family)
}

/// Whether the core's history takes the stores' writes now.
pub fn owned(cx: &FamilyContext) -> bool {
    cx.owners.owner(FAMILY) == Side::Rust
}

/// A write of the core's own stores (the Work board), while the core owns
/// the history; false when it does not (the caller tells Bun's).
pub fn tell_area(cx: &FamilyContext, area: &str, id: Option<&str>) -> bool {
    tell(
        cx,
        Change::Area {
            area: area.to_owned(),
            id: id.map(str::to_owned),
        },
    )
}

/// A Work change of the core's board, while the core owns the history.
pub fn tell_work(cx: &FamilyContext, change: WorkChange) -> bool {
    tell(cx, Change::Work(Box::new(change)))
}

fn tell(cx: &FamilyContext, change: Change) -> bool {
    if !owned(cx) {
        return false;
    }
    let Some(family) = LATEST.lock().unwrap().upgrade() else {
        return false;
    };
    family.send(change);
    true
}

fn logger(cx: &FamilyContext) -> Logger {
    let level = roamgate_env(&ProcessEnv, "LOG_LEVEL")
        .and_then(|value| parse_log_level(&value).ok())
        .unwrap_or(LogLevel::Info);
    let clock = cx.clock.clone();
    Logger::with(LoggerOptions {
        level: Some(level),
        scope: Some("history".into()),
        now: Some(Arc::new(move || clock.now())),
        ..LoggerOptions::default()
    })
}

fn fields(value: Value) -> LogFields {
    value.as_object().cloned().unwrap_or_default()
}

/// The server's runtime: its areas, place, review store, GameMode.
fn new_runtime(cx: &FamilyContext) -> HistoryRuntime {
    let env: Arc<dyn Env> = Arc::new(ProcessEnv);
    let context = DataContext::from_env(env.as_ref());
    let paths = history_paths(env.as_ref(), &context);
    let reviews: Arc<dyn ReviewSource> = Arc::new(SqliteReviews::new(&paths.reviews));
    let source = Arc::new(move || Some(reviews.clone()));
    let areas = history_areas(&paths, source.clone());
    let place = server_place(
        paths.settings.clone(),
        paths.data.clone(),
        env,
        context.home,
    );
    let mut options = RuntimeOptions::new(areas, place, source, cx.clock.clone());
    let runner = ProcessRunner::system();
    options.game_mode = Some(Arc::new(move || {
        let runner = runner.clone();
        Box::pin(async move {
            game_mode_active(&runner, default_game_mode_command(), GAME_MODE_TIMEOUT).await
        })
    }));
    let log = logger(cx);
    options.warn = Arc::new(move |message, value| log.warn(message, Some(&fields(value))));
    HistoryRuntime::new(options)
}

impl HistoryFamily {
    fn current(&self) -> Option<HistoryRuntime> {
        self.runtime.lock().unwrap().clone()
    }

    fn send(&self, change: Change) {
        let sender = self.changes.get_or_init(|| {
            let (tx, mut rx) = mpsc::unbounded_channel::<Change>();
            let family = LATEST.lock().unwrap().clone();
            tokio::spawn(async move {
                while let Some(change) = rx.recv().await {
                    let Some(this) = family.upgrade() else { return };
                    let Some(runtime) = this.current() else {
                        continue;
                    };
                    match change {
                        Change::Area { area, id } => runtime.changed(&area, id.as_deref()),
                        Change::Work(change) => {
                            let reader = runtime.clone();
                            let (change, description) = tokio::task::spawn_blocking(move || {
                                let description = reader.description_of(&change);
                                (change, description)
                            })
                            .await
                            .unwrap_or_else(|_| (Box::default(), None));
                            if !change.id.is_empty() {
                                runtime.work_changed(&change, description.as_deref());
                            }
                        }
                    }
                }
            });
            tx
        });
        let _ = sender.send(change);
    }

    /// Stops the core's runtime, its last pass done (5 s at most).
    async fn stop(&self) {
        self.turn.fetch_add(1, Ordering::SeqCst);
        let runtime = self.runtime.lock().unwrap().take();
        if let Some(runtime) = runtime {
            runtime.stop().await;
        }
    }

    /// A status while the core does not run the history (a read of the
    /// repo as it is).
    async fn idle_status() -> Result<Value, String> {
        let env: Arc<dyn Env> = Arc::new(ProcessEnv);
        let context = DataContext::from_env(env.as_ref());
        let paths = history_paths(env.as_ref(), &context);
        let place = server_place(paths.settings, paths.data, env, context.home);
        tokio::task::spawn_blocking(move || -> Result<Value, String> {
            let place: HistoryPlace = place()?;
            let repo = roamgate_history::repo::HistoryRepo::new(
                &place.location,
                &roamgate_history::place::history_host(),
                false,
                None,
            );
            Ok(roamgate_history::runtime::status_value(
                &place,
                &repo.status(),
                Vec::new(),
                false,
                None,
            ))
        })
        .await
        .map_err(|error| error.to_string())?
    }
}

/// What the route asks of the history.
struct Backend {
    family: Arc<HistoryFamily>,
    cx: FamilyContext,
}

impl HistoryBackend for Backend {
    fn status(&self) -> roamgate_base::clock::BoxFuture<Value> {
        let runtime = self.family.current();
        Box::pin(async move {
            let status = match runtime {
                Some(runtime) => runtime.status().await,
                None => HistoryFamily::idle_status().await,
            };
            status.unwrap_or_else(|error| json!({"error": error}))
        })
    }

    fn configure(
        &self,
        change: HistoryChange,
    ) -> roamgate_base::clock::BoxFuture<Result<(), String>> {
        let cx = self.cx.clone();
        let family = self.family.clone();
        Box::pin(async move {
            let written = write_settings(&cx, change).await;
            // settings.json changed, as Bun's writer tells its history (the
            // status answered next shows it waiting).
            if written.is_ok()
                && let Some(runtime) = family.current()
            {
                runtime.changed("settings", None);
                runtime.changed("mr-reviews", None);
            }
            written
        })
    }

    fn commit(&self) -> roamgate_base::clock::BoxFuture<()> {
        let runtime = self.family.current();
        Box::pin(async move {
            if let Some(runtime) = runtime {
                runtime.commit_now().await;
            }
        })
    }
}

/// settings.json's `history` changed as `PUT /api/history` asks.
pub(crate) async fn write_settings(
    cx: &FamilyContext,
    change: HistoryChange,
) -> Result<(), String> {
    let home = DataContext::from_env(&ProcessEnv).home;
    let expanded = match &change.location {
        Some(Some(location)) => Some(Some(expand_location(location, &home)?)),
        Some(None) => Some(None),
        None => None,
    };
    if cx.owners.owner("settings") != Side::Rust {
        // settings.json is Bun's to write: its route's own code.
        let mut args = serde_json::Map::new();
        match &expanded {
            Some(Some(location)) => {
                args.insert("location".into(), json!(location.display().to_string()));
            }
            Some(None) => {
                args.insert("location".into(), Value::Null);
            }
            None => {}
        }
        if let Some(enabled) = change.enabled {
            args.insert("enabled".into(), json!(enabled));
        }
        return cx
            .reverse("history.configure", Value::Object(args))
            .await
            .map(|_| ())
            .map_err(|error| error.message);
    }
    super::settings::update_shared(cx, json!({"method": "PUT /api/history"}), move |current| {
        let mut next = current.as_map().clone();
        let mut history = next
            .get("history")
            .and_then(Value::as_object)
            .cloned()
            .unwrap_or_default();
        match &expanded {
            Some(None) => {
                history.shift_remove("location");
            }
            Some(Some(location)) => {
                history.insert("location".into(), json!(location.display().to_string()));
            }
            None => {}
        }
        if let Some(enabled) = change.enabled {
            history.insert("enabled".into(), json!(enabled));
        }
        if history.is_empty() {
            next.shift_remove("history");
        } else {
            next.insert("history".into(), Value::Object(history));
        }
        Some(Value::Object(next))
    })
    .await
    .map(|_| ())
    .map_err(|error| error.message)
}

/// The request's head as roamgate-http's routes read it.
fn parts_of(request: &HttpRequest) -> Option<http::request::Parts> {
    let mut builder = http::Request::builder()
        .method(request.method.as_str())
        .uri(request.url.as_str());
    for (name, value) in &request.headers {
        builder = builder.header(name.as_str(), value.as_str());
    }
    builder.body(()).ok().map(|request| request.into_parts().0)
}

fn response_of(response: http::Response<Bytes>) -> HttpResponse {
    let (head, body) = response.into_parts();
    let (tx, rx) = mpsc::channel(1);
    let _ = tx.try_send(body.to_vec());
    HttpResponse {
        status: head.status.as_u16(),
        headers: head
            .headers
            .iter()
            .filter_map(|(name, value)| {
                Some((name.as_str().to_owned(), value.to_str().ok()?.to_owned()))
            })
            .collect(),
        body: Some(rx),
    }
}

impl CoreFamily for HistoryFamily {
    fn name(&self) -> &'static str {
        FAMILY
    }

    fn call(&self, _cx: &FamilyContext, call: IncomingCall) -> BoxFuture<Result<Value, RpcError>> {
        let this = LATEST.lock().unwrap().upgrade();
        Box::pin(async move {
            roamgate_sidecar::core::note_served(&ProcessEnv, FAMILY, &call.method);
            let Some(this) = this else {
                return Err(RpcError::new("no history family"));
            };
            let params = call.params;
            match call.method.as_str() {
                "internal.history.changed" => {
                    let area = params
                        .get("area")
                        .and_then(Value::as_str)
                        .ok_or_else(|| RpcError::new("history.changed needs an area"))?;
                    this.send(Change::Area {
                        area: area.to_owned(),
                        id: params.get("id").and_then(Value::as_str).map(str::to_owned),
                    });
                    Ok(json!({"ok": true}))
                }
                "internal.history.work_changed" => {
                    let change: WorkChange = serde_json::from_value(params)
                        .map_err(|error| RpcError::new(format!("invalid Work change: {error}")))?;
                    this.send(Change::Work(Box::new(change)));
                    Ok(json!({"ok": true}))
                }
                // Bun takes the history back: the core's last pass first.
                "internal.history.release" => {
                    this.stop().await;
                    Ok(json!({}))
                }
                other => Err(RpcError::with_code(
                    format!("unknown method {other}"),
                    "unknown_method",
                )),
            }
        })
    }

    fn http(
        &self,
        cx: &FamilyContext,
        request: HttpRequest,
        body: Option<BodyReceiver>,
    ) -> BoxFuture<Result<HttpResponse, RpcError>> {
        let cx = cx.clone();
        let family = LATEST.lock().unwrap().upgrade();
        Box::pin(async move {
            let Some(family) = family else {
                return Ok(HttpResponse::status(404));
            };
            let path = super::update::path_of(&request.url).to_owned();
            roamgate_sidecar::core::note_served(
                &ProcessEnv,
                FAMILY,
                &format!("{} {path}", request.method),
            );
            let Some(head) = parts_of(&request) else {
                return Ok(HttpResponse::status(400));
            };
            let mut bytes = Vec::new();
            if let Some(mut body) = body {
                while let Some(chunk) = body.chunk().await {
                    bytes.extend(chunk);
                }
            }
            let stream = futures_util::stream::iter([Ok::<Bytes, std::convert::Infallible>(
                Bytes::from(bytes),
            )]);
            let route = HistoryRoute::new(Arc::new(Backend { family, cx }));
            match route.handle(&head, &path, Some(stream)).await {
                Some(response) => Ok(response_of(response)),
                None => Ok(HttpResponse::status(404)),
            }
        })
    }

    fn owned(&self, cx: &FamilyContext, owned: bool) {
        let turn = self.turn.fetch_add(1, Ordering::SeqCst) + 1;
        let Some(this) = LATEST.lock().unwrap().upgrade() else {
            return;
        };
        let cx = cx.clone();
        if owned {
            // Bun's runtime stops first (its last pass written): one writer.
            tokio::spawn(async move {
                if let Err(error) = cx.reverse("history.release", json!({})).await {
                    logger(&cx).warn(
                        "Bun did not release the history",
                        Some(&fields(json!({"error": error.message}))),
                    );
                }
                if this.turn.load(Ordering::SeqCst) != turn {
                    return;
                }
                let runtime = new_runtime(&cx);
                runtime.start();
                *this.runtime.lock().unwrap() = Some(runtime);
                logger(&cx).info("the local history runs in the Rust core", None);
            });
        } else {
            tokio::spawn(async move {
                let runtime = this.runtime.lock().unwrap().take();
                if let Some(runtime) = runtime {
                    runtime.stop().await;
                }
            });
        }
    }
}

/// `roamgate history ...` (the Bun CLI passes it through while Rust owns
/// the family); returns the exit code.
pub fn cli(args: &[String]) -> u8 {
    roamgate_sidecar::core::note_served(&ProcessEnv, FAMILY, "cli history");
    let runtime = super::update::cli_runtime(Arc::new(ProcessEnv));
    super::update::emit(
        roamgate_cli::history::HistoryCli {
            runtime: &runtime,
            host: None,
        }
        .run(args),
    )
}
