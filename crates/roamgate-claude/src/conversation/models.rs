//! Claude Code's models over its control protocol (`drivers/claude-models.ts`):
//! `list_models` answers the rows its own /model picker shows (aliases,
//! the default, a gateway's custom slots), `set_model` switches the running
//! session for its next turns and answers the model id it runs then. A
//! switch writes nothing to the transcript: a process started after it,
//! before the session answered with that model, resumes on the model it
//! last answered with.

use roamgate_agents::js;
use roamgate_agents::obj;
use roamgate_conversation::driver::{BoxFuture, ModelContext, ModelDriver, ModelSet, Object};
use serde_json::Value;

fn text(value: Option<&Value>) -> Option<String> {
    value
        .and_then(Value::as_str)
        .map(js::trim)
        .filter(|text| !text.is_empty())
        .map(str::to_owned)
}

/// One row of `list_models` (Claude Code's ModelInfo); None when unusable.
pub fn claude_model_row(value: &Value) -> Option<Value> {
    let row = value.as_object()?;
    let id = text(row.get("value"))?;
    let label = text(row.get("displayName")).unwrap_or_else(|| id.clone());
    Some(Value::Object(obj! {
        "value" => id,
        "label" => label,
        "description" => text(row.get("description")),
        "resolved" => text(row.get("resolvedModel")),
        "disabled" => js::is_true(row.get("disabled")).then_some(true),
    }))
}

/// A non-empty error (JavaScript's `answer.error` being truthy).
pub(crate) fn error_of(error: Option<&String>) -> Option<&str> {
    error.map(String::as_str).filter(|error| !error.is_empty())
}

pub struct ClaudeModels;

impl ModelDriver for ClaudeModels {
    fn list<'a>(&'a self, context: &'a dyn ModelContext) -> BoxFuture<'a, Option<Vec<Value>>> {
        Box::pin(async move {
            let answer = context.control("list_models", Object::new()).await?;
            if error_of(answer.error.as_ref()).is_some() {
                return None;
            }
            let models = answer.response.as_ref()?.get("models")?.as_array()?;
            Some(models.iter().filter_map(claude_model_row).collect())
        })
    }

    fn set<'a>(&'a self, context: &'a dyn ModelContext, model: &'a str) -> BoxFuture<'a, ModelSet> {
        Box::pin(async move {
            let mut params = Object::new();
            params.insert("model".into(), Value::String(model.to_owned()));
            let Some(answer) = context.control("set_model", params).await else {
                return Err("Claude did not answer in time".to_owned());
            };
            if let Some(error) = error_of(answer.error.as_ref()) {
                return Err(error.to_owned());
            }
            Ok(text(answer.response.as_ref().and_then(|r| r.get("model"))))
        })
    }
}

#[cfg(test)]
mod tests;
