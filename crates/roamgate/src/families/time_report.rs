//! The time_report family in the core (`bridge.time_report`, the Hours
//! view): roamgate-activity's bridge, its provider run on the families'
//! clock. Until the activity family moves (Phase 3) Bun owns the activity
//! log and settings.json: the provider setting is read from the file at
//! each call (never written), and the day input comes from Bun through
//! the `activity.dayInput` reverse call (contract/wire/core-channel.md).

use std::sync::{Arc, OnceLock};

use roamgate_activity::provider::{BoxFuture, ProviderSettings};
use roamgate_activity::time_report::{Failure, TimeReport, TimeReportError, TimeReportSource};
use roamgate_base::env::{Env, ProcessEnv, roamgate_env};
use roamgate_base::paths::DataContext;
use roamgate_base::settings::Settings;
use roamgate_exec::process::ProcessRunner;
use roamgate_sidecar::family::{CoreFamily, FamilyContext};
use roamgate_sidecar::peer::IncomingCall;
use roamgate_sidecar::protocol::RpcError;
use serde_json::{Value, json};

pub const FAMILY: &str = "time_report";
pub const METHOD: &str = "bridge.time_report";

/// The family, once this build implements it.
pub fn family() -> Option<Arc<dyn CoreFamily>> {
    Some(Arc::new(TimeReportFamily::default()))
}

#[derive(Default)]
struct TimeReportFamily {
    /// Made at the first call, on the families' clock.
    bridge: OnceLock<Arc<TimeReport>>,
}

/// settings.json as the server's environment names it, without the
/// legacy migration (Bun's, the file's owner until Phase 3).
fn settings_file(env: &dyn Env) -> std::path::PathBuf {
    match roamgate_env(env, "SETTINGS_PATH") {
        Some(path) => path.into(),
        None => DataContext::from_env(env).data_root().join("settings.json"),
    }
}

/// The provider setting in settings.json now: read whole at each call, as
/// Bun may have changed it.
async fn provider_settings() -> Option<ProviderSettings> {
    let path = settings_file(&ProcessEnv);
    let raw = match tokio::fs::read(&path).await {
        Ok(bytes) => serde_json::from_slice::<Value>(&bytes).unwrap_or_else(|error| {
            tracing::warn!(scope = "bridge.settings", path = %path.display(), %error, "ignoring invalid settings");
            Value::Null
        }),
        Err(_) => Value::Null,
    };
    let settings = Settings::normalize(&raw);
    ProviderSettings::from_setting(settings.get("time_report"))
}

/// The server, as the bridge sees it from the core.
struct Source {
    cx: FamilyContext,
}

impl TimeReportSource for Source {
    fn settings(&self) -> BoxFuture<Option<ProviderSettings>> {
        Box::pin(provider_settings())
    }

    fn day_input(&self, date: String) -> BoxFuture<Result<Value, Failure>> {
        let cx = self.cx.clone();
        Box::pin(async move {
            cx.reverse("activity.dayInput", json!({ "date": date }))
                .await
                .map_err(|error| match error.code.as_deref() {
                    // Recording off or no log: an answer, as in Bun.
                    Some("not_configured") => {
                        TimeReportError::new(error.message, "not_configured").into()
                    }
                    _ => Failure::Other(error.message),
                })
        })
    }
}

impl TimeReportFamily {
    fn bridge(&self, cx: &FamilyContext) -> Arc<TimeReport> {
        self.bridge
            .get_or_init(|| {
                Arc::new(TimeReport::new(
                    Arc::new(Source { cx: cx.clone() }),
                    Arc::new(ProcessRunner::new(cx.clock.clone())),
                    cx.clock.clone(),
                ))
            })
            .clone()
    }
}

impl CoreFamily for TimeReportFamily {
    fn name(&self) -> &'static str {
        FAMILY
    }

    fn call(
        &self,
        cx: &FamilyContext,
        call: IncomingCall,
    ) -> roamgate_sidecar::peer::BoxFuture<Result<Value, RpcError>> {
        let bridge = self.bridge(cx);
        Box::pin(async move {
            if call.method != METHOD {
                return Err(RpcError::with_code(
                    format!("unknown method {}", call.method),
                    "unknown_method",
                ));
            }
            // Provider failures are answers the Hours view shows, with
            // their code.
            match bridge.handle(&call.params).await {
                Ok(value) => Ok(json!({ "ok": true, "value": value })),
                Err(Failure::Report(error)) => Ok(error.to_result()),
                Err(Failure::Other(message)) => Err(RpcError::new(message)),
            }
        })
    }
}
