//! The settings family in the core: Rust is settings.json's one writer
//! (roamgate-http's [`SettingsService`] on roamgate-base's
//! `SettingsStore`), the front a client of it (contract/wire/core-channel.md,
//! The settings family).
//!
//! - Browser calls: [`RPC_METHODS`] (`ctx.connection_id` is the connection
//!   a connection-scoped one came on), and `/api/instance-settings`.
//! - Reverse call: `settings.changed {revision, settings, origin: "core",
//!   cause}` after each write (the method and connection as `cause`),
//!   awaited before the answer, so the other families' copies, the history
//!   and the change listeners follow.
//!
//! The store is made when the family first serves and dropped when it
//! stops.

use std::sync::{Arc, Mutex};

use roamgate_base::env::ProcessEnv;
use roamgate_base::paths::DataContext;
use roamgate_base::settings::{SettingsStore, settings_path};
use roamgate_channel::family::{CoreFamily, FamilyContext};
use roamgate_channel::peer::{BodyReceiver, BoxFuture, HttpRequest, HttpResponse, IncomingCall};
use roamgate_channel::protocol::RpcError;
use roamgate_http::settings::{
    INSTANCE_SETTINGS_MAX_BYTES, INSTANCE_SETTINGS_PATH, InstanceBody, InstanceRequest,
    RPC_METHODS, Revision, SettingsService,
};
use serde_json::{Value, json};

use super::update::{header, json_response, path_of};

pub const FAMILY: &str = "settings";

/// The family, once this build implements it.
pub fn family() -> Option<Arc<dyn CoreFamily>> {
    let family = Arc::new(SettingsFamily::default());
    *LATEST.lock().unwrap() = Arc::downgrade(&family);
    Some(family)
}

/// The family this process made last: the core's other families write
/// settings.json through its writer.
static LATEST: Mutex<std::sync::Weak<SettingsFamily>> = Mutex::new(std::sync::Weak::new());

/// The settings as the core holds them, else (no family) as the file says
/// now.
pub async fn read_shared(cx: &FamilyContext) -> Arc<roamgate_base::settings::Settings> {
    let family = LATEST.lock().unwrap().upgrade();
    if let Some(family) = family
        && let Ok(service) = family.writer(cx)
    {
        return service.store().read().await;
    }
    match settings_file() {
        Ok(path) => SettingsStore::new(path).read().await,
        Err(_) => Arc::new(roamgate_base::settings::Settings::defaults()),
    }
}

/// A write of another family of the core through the settings family's
/// writer, told to the front (`settings.changed`, with `cause`) before it
/// answers. `change` gives the next settings, or None to leave the file
/// as it is (answered with the settings as they are).
pub async fn update_shared(
    cx: &FamilyContext,
    cause: Value,
    change: impl FnOnce(&roamgate_base::settings::Settings) -> Option<Value>,
) -> Result<Arc<roamgate_base::settings::Settings>, RpcError> {
    let family = LATEST.lock().unwrap().upgrade();
    let Some(family) = family else {
        return Err(RpcError::with_code("no settings family", "not_owner"));
    };
    let service = family.writer(cx)?;
    let unchanged = std::sync::atomic::AtomicBool::new(false);
    let written = service
        .update_if(
            |current| match change(current) {
                Some(next) => next,
                None => {
                    unchanged.store(true, std::sync::atomic::Ordering::SeqCst);
                    Value::Object(current.as_map().clone())
                }
            },
            || !unchanged.load(std::sync::atomic::Ordering::SeqCst),
        )
        .await;
    match written {
        Ok(written) => {
            changed(cx, &written, cause).await;
            Ok(written.settings)
        }
        Err(roamgate_base::settings::SettingsError::Cancelled)
            if unchanged.load(std::sync::atomic::Ordering::SeqCst) =>
        {
            Ok(service.store().read().await)
        }
        Err(error) => Err(RpcError::new(error.to_string())),
    }
}

#[derive(Default)]
struct SettingsFamily {
    /// The writer, while the core owns the family (made at first use).
    service: Mutex<Option<Arc<SettingsService>>>,
}

/// settings.json as the server's environment names it (Bun's
/// guiSettingsPath, legacy migration included).
fn settings_file() -> std::io::Result<std::path::PathBuf> {
    let env = ProcessEnv;
    settings_path(&env, &DataContext::from_env(&env))
}

fn new_service(cx: &FamilyContext) -> Result<Arc<SettingsService>, RpcError> {
    let path = settings_file().map_err(|error| RpcError::new(error.to_string()))?;
    Ok(Arc::new(SettingsService::new(
        SettingsStore::new(path),
        cx.clock.now().max(0) as u64,
    )))
}

impl SettingsFamily {
    /// The writer, made on first use.
    fn writer(&self, cx: &FamilyContext) -> Result<Arc<SettingsService>, RpcError> {
        let mut service = self.service.lock().unwrap();
        if let Some(service) = service.as_ref() {
            return Ok(service.clone());
        }
        let made = new_service(cx)?;
        *service = Some(made.clone());
        Ok(made)
    }
}

/// Tells the front of a write the core's own handlers made, before their
/// answer goes out: the front's copy (its manifest, its handlers) is the
/// new one by the time the browser hears.
async fn changed(cx: &FamilyContext, written: &Revision, cause: Value) {
    let mut args = written.to_json();
    args["origin"] = "core".into();
    args["cause"] = cause;
    let told = tokio::time::timeout(
        std::time::Duration::from_secs(5),
        cx.reverse("settings.changed", args),
    )
    .await;
    let error = match told {
        Ok(Ok(_)) => return,
        Ok(Err(error)) => error.message,
        Err(_) => "no answer in 5 s".to_owned(),
    };
    tracing::warn!(
        scope = "core.settings",
        "the front did not hear of a settings change: {error}"
    );
}

fn path_text() -> String {
    settings_file()
        .map(|path| path.display().to_string())
        .unwrap_or_default()
}

impl CoreFamily for SettingsFamily {
    fn name(&self) -> &'static str {
        FAMILY
    }

    fn call(&self, cx: &FamilyContext, call: IncomingCall) -> BoxFuture<Result<Value, RpcError>> {
        let cx = cx.clone();
        let writer = self.writer(&cx);
        Box::pin(async move {
            let method = call.method.as_str();
            let service = writer?;
            if !RPC_METHODS.contains(&method) {
                return Err(RpcError::with_code(
                    format!("unknown method {method}"),
                    "unknown_method",
                ));
            }
            let connection = call.ctx.connection_id.clone();
            let answer = service
                .rpc(method, &call.params, connection.as_deref(), &path_text())
                .await
                .map_err(RpcError::new)?;
            if let Some(written) = &answer.written {
                changed(
                    &cx,
                    written,
                    json!({ "method": method, "connection_id": connection }),
                )
                .await;
            }
            Ok(answer.result)
        })
    }

    fn http(
        &self,
        cx: &FamilyContext,
        request: HttpRequest,
        body: Option<BodyReceiver>,
    ) -> BoxFuture<Result<HttpResponse, RpcError>> {
        let cx = cx.clone();
        let writer = self.writer(&cx);
        Box::pin(async move {
            if path_of(&request.url) != INSTANCE_SETTINGS_PATH {
                return Ok(HttpResponse::status(404));
            }
            let method = request.method.to_ascii_uppercase();
            let service = writer?;
            let body = match body {
                None => InstanceBody::Missing,
                Some(mut body) => {
                    let mut bytes = Vec::new();
                    let mut too_large = false;
                    while let Some(chunk) = body.chunk().await {
                        if too_large {
                            continue;
                        }
                        bytes.extend(chunk);
                        too_large = bytes.len() > INSTANCE_SETTINGS_MAX_BYTES;
                    }
                    if too_large {
                        InstanceBody::TooLarge
                    } else {
                        InstanceBody::Bytes(bytes)
                    }
                }
            };
            let answer = service
                .instance_settings(InstanceRequest {
                    method,
                    settings_header: header(&request, "x-roamgate-settings"),
                    fetch_site: header(&request, "sec-fetch-site"),
                    content_type: header(&request, "content-type"),
                    body,
                })
                .await;
            if let Some(written) = &answer.written {
                changed(
                    &cx,
                    written,
                    json!({ "method": format!("PUT {INSTANCE_SETTINGS_PATH}") }),
                )
                .await;
            }
            if let Some(text) = answer.text {
                let (tx, rx) = tokio::sync::mpsc::channel(1);
                let _ = tx.try_send(text.as_bytes().to_vec());
                let mut headers = vec![
                    (
                        "content-type".to_owned(),
                        "text/plain;charset=utf-8".to_owned(),
                    ),
                    ("cache-control".to_owned(), "no-store".to_owned()),
                ];
                if let Some(allow) = answer.allow {
                    headers.push(("allow".into(), allow.into()));
                }
                return Ok(HttpResponse {
                    status: answer.status,
                    headers,
                    body: Some(rx),
                });
            }
            Ok(json_response(answer.status, &answer.body))
        })
    }

    fn owned(&self, _cx: &FamilyContext, _owned: bool) {
        // Fresh at the next use either way: whoever wrote meanwhile, the
        // file is read again.
        *self.service.lock().unwrap() = None;
    }
}
