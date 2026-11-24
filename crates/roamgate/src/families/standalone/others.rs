//! The rest of Bun's reverse targets of this package: what a settings
//! write of the core's own handlers set going in Bun (its history, the
//! claude start hook, the usage limit resumer, the connections' transport
//! setting), the local history's writes, the activity log's day, the
//! review's kept Last steps, and the supervisor's restart after an update.

use std::sync::Arc;

use roamgate_activity::time_report::Failure;
use roamgate_base::settings::Settings;
use roamgate_connections::routing::serialize_herdr_event_envelope;
use roamgate_connections::usage_limit::limit_resume_settings_of;
use roamgate_http::history::HistoryChange;
use roamgate_sidecar::family::FamilyContext;
use roamgate_sidecar::protocol::{Ctx, RpcError};
use serde_json::{Value, json};

use super::{Layer, Target, call, text};

pub(super) const TARGETS: &[(&str, Target)] = &[
    ("settings.changed", |layer, cx, args| {
        Box::pin(async move { settings_changed(&layer, &cx, &args) })
    }),
    ("settings.limit_resume.get", |_, cx, _| {
        Box::pin(async move {
            let settings = super::super::settings::read_shared(&cx).await;
            Ok(limit_resume(&settings))
        })
    }),
    ("history.changed", |_, cx, args| {
        Box::pin(async move {
            if text(&args, "area").is_none() {
                return Err(RpcError::new("history.changed needs an area"));
            }
            call(&cx, "internal.history.changed", args).await
        })
    }),
    ("history.work_changed", |_, cx, args| {
        Box::pin(async move { call(&cx, "internal.history.work_changed", args).await })
    }),
    ("history.configure", |_, cx, args| {
        Box::pin(async move { history_configure(&cx, &args).await })
    }),
    ("activity.dayInput", |_, cx, args| {
        Box::pin(async move {
            let date = text(&args, "date")
                .filter(|date| roamgate_activity::timeline::is_date(date))
                .ok_or_else(|| RpcError::new("activity.dayInput needs a date, YYYY-MM-DD"))?
                .to_owned();
            super::super::activity::settle().await;
            super::super::time_report::local_day_input(cx.clock.now(), date)
                .await
                .map_err(|failure| match failure {
                    Failure::Report(error) => match error.code.as_str() {
                        Some(code) => RpcError::with_code(error.message, code),
                        None => RpcError::new(error.message),
                    },
                    Failure::Other(message) => RpcError::new(message),
                })
        })
    }),
    ("workspace.kept_steps", |_, cx, args| {
        Box::pin(async move {
            let root = text(&args, "root")
                .ok_or_else(|| RpcError::new("workspace.kept_steps needs a root"))?;
            call(
                &cx,
                "internal.review.call",
                json!({"method": "keptSteps", "params": {"root": root}}),
            )
            .await
        })
    }),
    // The readers are registered by those who ask `internal.mr_cache.get`
    // with a token: in this process they read the cache themselves, so
    // none is ever registered here.
    ("mr_cache.load", |_, _, _| {
        Box::pin(async move { Err(RpcError::new("unknown MR cache reader")) })
    }),
    // After an install the supervisor starts the new one: the front exits.
    ("server.scheduleExit", |_, cx, _| {
        Box::pin(async move {
            cx.peer
                .reverse_call("server.scheduleExit", json!({}), Ctx::default())
                .await
        })
    }),
];

fn limit_resume(settings: &Settings) -> Value {
    let stored = settings
        .as_map()
        .get("limit_resume")
        .and_then(Value::as_object);
    serde_json::to_value(limit_resume_settings_of(stored)).unwrap_or(Value::Null)
}

/// The settings the front's listeners compare a change against, read once
/// the connections start.
pub(crate) async fn prime_settings(layer: &Layer, cx: &FamilyContext) {
    let settings = super::super::settings::read_shared(cx).await;
    let mut held = layer.settings.lock().unwrap();
    if held.1.is_none() {
        held.1 = Some(Value::Object(settings.as_map().clone()));
    }
}

/// `settings.changed`: the core wrote settings.json (config/gui-settings.ts
/// `applyRemoteGuiSettings`): the local history hears of it, and what the
/// front's handlers would have followed up on a write of the core's own
/// follows (index.ts and runtime.ts `onGuiSettingsChanged`).
fn settings_changed(
    layer: &Arc<Layer>,
    cx: &FamilyContext,
    args: &Value,
) -> Result<Value, RpcError> {
    let (Some(revision), Some(raw)) = (
        args.get("revision").and_then(Value::as_u64),
        args.get("settings").filter(|settings| settings.is_object()),
    ) else {
        return Err(RpcError::new(
            "settings.changed needs a revision and the settings",
        ));
    };
    let previous = {
        let mut held = layer.settings.lock().unwrap();
        if held.0.is_some_and(|known| revision <= known) {
            return Ok(json!({"applied": false}));
        }
        held.0 = Some(revision);
        held.1.replace(raw.clone())
    };
    for area in ["settings", "mr-reviews"] {
        super::tell(cx, "internal.history.changed", json!({"area": area}));
    }
    if text(args, "origin") != Some("core") {
        return Ok(json!({"applied": true}));
    }
    let Some(previous) = previous else {
        return Ok(json!({"applied": true}));
    };
    let (previous, next) = (Settings::normalize(&previous), Settings::normalize(raw));
    let ids: Vec<String> = layer
        .host
        .manager_now()
        .map(|manager| manager.list().into_iter().map(|status| status.id).collect())
        .unwrap_or_default();
    if previous.claude_start_mode() != next.claude_start_mode() {
        for id in &ids {
            let (layer, cx, id) = (layer.clone(), cx.clone(), id.clone());
            tokio::spawn(async move {
                super::runtime::ensure_claude_start_hook(&layer, &cx, &id).await;
            });
        }
    }
    if limit_resume(&previous) != limit_resume(&next) {
        for id in &ids {
            super::runtime::poke_limit(cx, id, None);
        }
    }
    // Each runtime follows its own transport setting.
    for (id, generation) in layer.runtimes.generations() {
        let enabled = next.terminal_surface_codecs_enabled(Some(&id));
        if previous.terminal_surface_codecs_enabled(Some(&id)) == enabled {
            continue;
        }
        let event = json!({
            "event": "settings.terminal_transport.updated",
            "data": {"surface_codecs": enabled},
        });
        if let Ok(line) = serialize_herdr_event_envelope(&id, &event, Some(generation)) {
            layer.clients.broadcast(&line, "event", None);
        }
    }
    Ok(json!({"applied": true}))
}

/// `history.configure`: settings.json's `history`, as `PUT /api/history`
/// asks (index.ts `configureHistory`).
async fn history_configure(cx: &FamilyContext, args: &Value) -> Result<Value, RpcError> {
    let location = match args.get("location") {
        None => None,
        Some(Value::Null) => Some(None),
        Some(Value::String(location)) => Some(Some(location.clone())),
        Some(_) => {
            return Err(RpcError::new(
                "history.configure: location is a path or null",
            ));
        }
    };
    let enabled = match args.get("enabled") {
        None => None,
        Some(Value::Bool(enabled)) => Some(*enabled),
        Some(_) => {
            return Err(RpcError::new("history.configure: enabled is true or false"));
        }
    };
    super::super::history::write_settings(cx, HistoryChange { location, enabled })
        .await
        .map_err(RpcError::new)?;
    Ok(json!({}))
}
