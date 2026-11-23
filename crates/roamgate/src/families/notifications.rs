//! The notifications family in the core: roamgate-notify's feed and Web
//! Push, while the notification socket stays with the Bun front until
//! Phase 7 (contract/wire/core-channel.md).
//!
//! - Browser calls: `bridge.notifications.status` (the feed's numbers here,
//!   the sockets from the front's `notifications.clients`).
//! - HTTP: `/api/notifications/push` (GET, POST, DELETE), Bun's checks.
//! - The front's own calls: `internal.notifications.state`, `.publish`,
//!   `.clear_tag`, `.clear_pane`, `.clear_blocked_pane`, `.clear_prompt`.
//! - Reverse calls: `notifications.feed` after each change (the events, and
//!   those to send now), one at a time and in order; `notifications.current`
//!   before a Web Push send of a notification that carries a token;
//!   `notifications.clients`.
//! - CLI: `roamgate push`.
//!
//! The feed and Web Push read their files when the core starts owning the
//! family and stop (Web Push's queue dropped) when it stops.

use std::sync::{Arc, OnceLock};

use roamgate_base::clock::SystemClock;
use roamgate_base::env::ProcessEnv;
use roamgate_base::log::Logger;
use roamgate_base::paths::DataContext;
use roamgate_notify::feed::{Change, Extra, notification_feed_path};
use roamgate_notify::service::{Notifications, Options};
use roamgate_notify::web_push::{
    Answer, HttpsSender, IsCurrent, MAX_BODY_BYTES, web_push_path, web_push_subject,
};
use roamgate_sidecar::family::{CoreFamily, FamilyContext};
use roamgate_sidecar::peer::{BodyReceiver, BoxFuture, HttpRequest, HttpResponse, IncomingCall};
use roamgate_sidecar::protocol::RpcError;
use serde_json::{Map, Value, json};
use tokio::sync::mpsc;

use super::update::{header, json_response, path_of};

pub const FAMILY: &str = "notifications";
pub const PUSH_PATH: &str = "/api/notifications/push";

/// The family, once this build implements it.
pub fn family() -> Option<Arc<dyn CoreFamily>> {
    Some(Arc::new(NotificationsFamily::default()))
}

#[derive(Default)]
struct NotificationsFamily {
    service: OnceLock<Arc<Notifications>>,
    /// The feed's changes, sent to the front one at a time.
    changes: OnceLock<mpsc::UnboundedSender<Vec<i64>>>,
}

fn not_owner() -> RpcError {
    RpcError::with_code("the core does not own the notifications", "not_owner")
}

fn string(params: &Value, name: &str) -> Result<String, RpcError> {
    params
        .get(name)
        .and_then(Value::as_str)
        .map(str::to_owned)
        .ok_or_else(|| RpcError::new(format!("{name} must be a string")))
}

impl NotificationsFamily {
    fn service(&self, cx: &FamilyContext) -> Arc<Notifications> {
        self.service
            .get_or_init(|| {
                let env = ProcessEnv;
                let context = DataContext::from_env(&env);
                let root = context.data_root();
                let logger: Logger = super::limit_resume::scoped_logger(cx, "bridge");
                Arc::new(Notifications::new(Options {
                    feed_path: notification_feed_path(&env, &root),
                    push_path: web_push_path(&env, &root),
                    subject: web_push_subject(&env),
                    context,
                    clock: cx.clock.clone(),
                    sender: Arc::new(HttpsSender::new()),
                    warn: Arc::new(move |message: &str| logger.warn(message, None)),
                }))
            })
            .clone()
    }

    /// Hands a change to the front: the feed's events as they are when it
    /// is sent, and the ids to deliver (several changes waiting go as one).
    fn changed(&self, cx: &FamilyContext, change: Change) {
        if !change.changed() {
            return;
        }
        let sender = self.changes.get_or_init(|| {
            let (tx, mut rx) = mpsc::unbounded_channel::<Vec<i64>>();
            let service = self.service(cx);
            let cx = cx.clone();
            tokio::spawn(async move {
                while let Some(mut deliver) = rx.recv().await {
                    while let Ok(more) = rx.try_recv() {
                        deliver.extend(more);
                    }
                    let Ok(state) = service.state() else {
                        continue;
                    };
                    let args = json!({
                        "last": state["last"],
                        "events": state["events"],
                        "deliver": deliver,
                    });
                    if let Err(error) = cx.reverse("notifications.feed", args).await {
                        tracing::warn!(
                            scope = "bridge.notifications",
                            "the front did not take the notification feed: {}",
                            error.message
                        );
                    }
                }
            });
            tx
        });
        let _ = sender.send(change.deliver);
    }

    fn publish(&self, cx: &FamilyContext, params: &Value) -> Result<Value, RpcError> {
        let task: Map<String, Value> = params
            .get("task")
            .and_then(Value::as_object)
            .cloned()
            .ok_or_else(|| RpcError::new("task must be an object"))?;
        let extra = Extra {
            kind: params.get("kind").filter(|kind| kind.is_string()).cloned(),
            actions: params
                .get("actions")
                .filter(|value| value.is_array())
                .cloned(),
            prompt: params
                .get("prompt")
                .filter(|value| value.is_object())
                .cloned(),
            path: params
                .get("path")
                .and_then(Value::as_str)
                .map(str::to_owned),
        };
        let android_connected = params.get("android_connected") == Some(&Value::Bool(true));
        let is_current: Option<IsCurrent> =
            params.get("current").and_then(Value::as_u64).map(|token| {
                let cx = cx.clone();
                let check: IsCurrent = Arc::new(move || {
                    let cx = cx.clone();
                    Box::pin(async move {
                        cx.reverse("notifications.current", json!({ "token": token }))
                            .await
                            .is_ok_and(|current| current == Value::Bool(true))
                    })
                });
                check
            });
        let (id, change) = self
            .service(cx)
            .publish(&task, &extra, android_connected, is_current)
            .map_err(|_| not_owner())?;
        self.changed(cx, change);
        Ok(json!({ "id": id }))
    }
}

impl CoreFamily for NotificationsFamily {
    fn name(&self) -> &'static str {
        FAMILY
    }

    fn call(&self, cx: &FamilyContext, call: IncomingCall) -> BoxFuture<Result<Value, RpcError>> {
        let service = self.service(cx);
        // The front's own calls are this family's work too (the core notes
        // only browser calls): the parity suite's proof that Rust served it.
        if call
            .method
            .starts_with(roamgate_sidecar::family::INTERNAL_PREFIX)
        {
            roamgate_sidecar::core::note_served(&ProcessEnv, FAMILY, &call.method);
        }
        let params = call.params;
        let outcome: Result<Value, RpcError> = match call.method.as_str() {
            "internal.notifications.state" => service.state().map_err(|_| not_owner()),
            "internal.notifications.publish" => self.publish(cx, &params),
            "internal.notifications.clear_tag" => string(&params, "tag")
                .and_then(|tag| service.clear_tag(&tag).map_err(|_| not_owner()))
                .map(|change| {
                    self.changed(cx, change);
                    json!({ "ok": true })
                }),
            "internal.notifications.clear_pane" | "internal.notifications.clear_blocked_pane" => {
                let blocked = call.method.ends_with("clear_blocked_pane");
                string(&params, "connection_id")
                    .and_then(|connection| Ok((connection, string(&params, "pane_id")?)))
                    .and_then(|(connection, pane)| {
                        if blocked {
                            service.clear_blocked_pane(&connection, &pane)
                        } else {
                            service.clear_pane(&connection, &pane)
                        }
                        .map_err(|_| not_owner())
                    })
                    .map(|change| {
                        self.changed(cx, change);
                        json!({ "ok": true })
                    })
            }
            "internal.notifications.clear_prompt" => string(&params, "prompt_id")
                .and_then(|prompt| service.clear_prompt(&prompt).map_err(|_| not_owner()))
                .map(|change| {
                    self.changed(cx, change);
                    json!({ "ok": true })
                }),
            "bridge.notifications.status" => {
                return Box::pin(status(service, cx.clone()));
            }
            method => Err(RpcError::with_code(
                format!("unknown method {method}"),
                "unknown_method",
            )),
        };
        Box::pin(async move { outcome })
    }

    fn http(
        &self,
        cx: &FamilyContext,
        request: HttpRequest,
        body: Option<BodyReceiver>,
    ) -> BoxFuture<Result<HttpResponse, RpcError>> {
        let service = self.service(cx);
        Box::pin(async move {
            if path_of(&request.url) != PUSH_PATH {
                return Ok(HttpResponse::status(404));
            }
            let method = request.method.to_ascii_uppercase();
            // At most one byte past the limit: enough to refuse it.
            let bytes = match body {
                Some(mut body) if method == "POST" || method == "DELETE" => {
                    let mut all = Vec::new();
                    while let Some(chunk) = body.chunk().await {
                        all.extend(chunk);
                        if all.len() > MAX_BODY_BYTES {
                            break;
                        }
                    }
                    Some(all)
                }
                _ => None,
            };
            let answer = service
                .http(&method, &|name| header(&request, name), bytes.as_deref())
                .map_err(|_| not_owner())?;
            Ok(match answer {
                Answer::Json(status, body) => json_response(status, &body),
                Answer::Text(status, text) => text_response(status, text),
            })
        })
    }

    fn owned(&self, cx: &FamilyContext, owned: bool) {
        let service = self.service(cx);
        if owned {
            service.start();
        } else {
            service.stop();
        }
    }
}

/// `bridge.notifications.status`: the feed's numbers, and the sockets the
/// front holds.
async fn status(service: Arc<Notifications>, cx: FamilyContext) -> Result<Value, RpcError> {
    let (last, events) = service.counts().map_err(|_| not_owner())?;
    let clients = cx.reverse("notifications.clients", json!({})).await?;
    Ok(json!({
        "last": last,
        "events": events,
        "android_connected": clients.get("android_connected").cloned().unwrap_or(Value::Bool(false)),
        "clients": clients.get("clients").cloned().unwrap_or_else(|| json!([])),
    }))
}

/// A plain text answer as Bun's `new Response(text, {headers})` sends it.
fn text_response(status: u16, text: &str) -> HttpResponse {
    let (tx, rx) = mpsc::channel(1);
    let _ = tx.try_send(text.as_bytes().to_vec());
    HttpResponse {
        status,
        headers: vec![
            ("content-type".into(), "text/plain;charset=utf-8".into()),
            ("cache-control".into(), "no-store".into()),
        ],
        body: Some(rx),
    }
}

/// `roamgate push ...`, passed through by the Bun CLI; the exit code.
pub async fn cli(args: &[String]) -> u8 {
    use roamgate_base::clock::Clock;
    roamgate_sidecar::core::note_served(&ProcessEnv, FAMILY, "cli push");
    let runtime = super::update::cli_runtime(Arc::new(ProcessEnv));
    super::update::emit(
        roamgate_cli::push::push(
            &runtime,
            Arc::new(HttpsSender::new()),
            SystemClock.now(),
            args,
        )
        .await,
    )
}
