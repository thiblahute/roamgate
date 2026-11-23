//! `bridge.work.*` (server/src/work/rpc.ts): the Work board for every
//! browser, machine-wide. The pages read the board and write the user's
//! changes; agents write through the tools with `by: agent`.

use serde_json::{Value, json};

use crate::model::By;
use crate::service::{WorkMeta, WorkService};
use crate::store::{Params, WorkError, WorkResult};
use crate::text::slice_utf16;

pub fn is_work_method(method: &str) -> bool {
    method.starts_with("bridge.work.")
}

fn meta_of(params: &Params) -> WorkMeta {
    if params.get("by").and_then(Value::as_str) == Some("agent") {
        WorkMeta {
            by: By::Agent,
            caller: None,
            address: None,
            summary: params
                .get("summary")
                .and_then(Value::as_str)
                .map(|summary| slice_utf16(summary, 200).to_owned()),
        }
    } else {
        WorkMeta::user()
    }
}

/// A `bridge.work.*` call's result.
pub async fn handle_work_rpc(
    service: &WorkService,
    method: &str,
    params: &Params,
) -> WorkResult<Value> {
    let meta = meta_of(params);
    Ok(match method {
        "bridge.work.board" => service.board().await?,
        "bridge.work.list" => json!({"items": service.list(params, None).await?}),
        "bridge.work.project.set" => json!({"project": service.project_set(params, &meta).await?}),
        "bridge.work.add" => {
            let added = service.add_or_update(params, &meta).await?;
            let mut out = json!({"item": added.item});
            if added.updated {
                out["updated"] = json!(true);
            }
            out
        }
        "bridge.work.update" => json!({"item": service.update(params, &meta).await?}),
        "bridge.work.done" => json!({"item": service.done(params, &meta)?}),
        "bridge.work.reopen" => json!({"item": service.reopen(params, &meta).await?}),
        "bridge.work.remove" => json!({"item": service.remove(params, &meta)?}),
        "bridge.work.threads" => {
            let reference = params
                .get("item")
                .and_then(Value::as_str)
                .ok_or_else(|| WorkError::invalid("item is required"))?;
            let open = params.get("open") == Some(&Value::Bool(true));
            let snapshot = service.threads(reference, open).await?;
            json!({"snapshot": snapshot.map(|snapshot| snapshot.raw)})
        }
        "bridge.work.promote" => json!({"item": service.promote(params, &meta).await?}),
        "bridge.work.owner_target" => {
            json!({"target": service.owner_target(params).await?.map(|target| target.to_json())})
        }
        "bridge.work.session_target" => {
            json!({"target": service.session_target(params).await?.map(|target| target.to_json())})
        }
        "bridge.work.link_target" => {
            json!({"target": service.link_target(params).await?.to_json()})
        }
        "bridge.work.adopt" => json!({"item": service.adopt(params, &meta).await?}),
        "bridge.work.check" => serde_json::to_value(service.check().await?).expect("JSON"),
        other => {
            return Err(WorkError::not_found(format!(
                "unknown method {}",
                slice_utf16(other, 60)
            )));
        }
    })
}
