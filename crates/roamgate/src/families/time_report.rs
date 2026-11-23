//! The time_report family in the core (`bridge.time_report`, the Hours
//! view): roamgate-activity's bridge, its provider run on the families'
//! clock. The provider setting is read from settings.json at each call
//! (never written). The day input is built here from activity.sqlite while
//! the core owns the activity family, and comes from Bun through the
//! `activity.dayInput` reverse call while Bun does (contract/wire/
//! core-channel.md).

use std::sync::{Arc, OnceLock};

use roamgate_activity::day_input::{ActivitySettings, build_day_input, system_zone_name};
use roamgate_activity::provider::{BoxFuture, ProviderSettings};
use roamgate_activity::reader::ActivityReader;
use roamgate_activity::subjects::SubjectResolver;
use roamgate_activity::time_report::{Failure, TimeReport, TimeReportError, TimeReportSource};
use roamgate_base::env::ProcessEnv;
use roamgate_base::paths::DataContext;
use roamgate_base::settings::Settings;
use roamgate_exec::process::ProcessRunner;
use roamgate_sidecar::family::{CoreFamily, FamilyContext};
use roamgate_sidecar::peer::IncomingCall;
use roamgate_sidecar::protocol::{RpcError, Side};
use serde_json::{Value, json};

use super::activity::settings_json;

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

/// The provider setting in settings.json now: read whole at each call, as
/// Bun may have changed it.
async fn provider_settings() -> Option<ProviderSettings> {
    let settings = Settings::normalize(&settings_json().await);
    ProviderSettings::from_setting(settings.get("time_report"))
}

/// The day from activity.sqlite (rpc.ts's `dayInput`): recording off or no
/// log are answers, `not_configured`.
async fn local_day_input(now: i64, date: String) -> Result<Value, Failure> {
    let raw = settings_json().await;
    let settings = ActivitySettings::from_settings(&raw);
    if !settings.enabled {
        return Err(TimeReportError::new(
            "Activity recording is off (activity.enabled).",
            "not_configured",
        )
        .into());
    }
    tokio::task::spawn_blocking(move || {
        let context = DataContext::from_env(&ProcessEnv);
        let reader = ActivityReader::open(
            &context,
            &context.data_root(),
            Box::new(move || now),
            Some(SubjectResolver::from_settings(&raw)),
        )
        .map_err(|error| Failure::Other(error.to_string()))?
        .ok_or_else(|| {
            Failure::from(TimeReportError::new(
                "No activity log yet.",
                "not_configured",
            ))
        })?;
        build_day_input(&reader, &settings, &date, &system_zone_name())
            .map_err(|error| Failure::Other(error.to_string()))
    })
    .await
    .map_err(|error| Failure::Other(error.to_string()))?
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
            if cx.owners.owner("activity") == Side::Rust {
                return local_day_input(cx.clock.now(), date).await;
            }
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
