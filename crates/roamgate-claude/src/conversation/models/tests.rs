//! `drivers/claude-models.test.ts`.

use roamgate_conversation::driver::ModelDriver;
use serde_json::{Value, json};

use super::{ClaudeModels, claude_model_row};
use crate::conversation::fake::Context;

#[test]
fn a_list_models_row_its_name_label_model_and_whether_it_may_be_picked() {
    assert_eq!(
        claude_model_row(&json!({
            "value": "opus",
            "resolvedModel": "gpt-6-luna",
            "displayName": "gpt-6-luna",
            "description": "Custom Opus model",
            "supportsEffort": true,
        })),
        Some(json!({
            "value": "opus",
            "label": "gpt-6-luna",
            "description": "Custom Opus model",
            "resolved": "gpt-6-luna",
        }))
    );
    assert_eq!(
        claude_model_row(&json!({"value": "x", "disabled": true, "description": " "})),
        Some(json!({"value": "x", "label": "x", "disabled": true}))
    );
    assert_eq!(claude_model_row(&json!({"displayName": "no value"})), None);
    assert_eq!(claude_model_row(&json!("opus")), None);
}

#[tokio::test]
async fn the_list_or_none_when_the_cli_refuses_or_says_nothing() {
    let listing = Context::new(
        json!({"list_models": {"response": {"models": [{"value": "haiku"}, null, {"value": ""}]}}}),
        Value::Null,
    );
    assert_eq!(
        ClaudeModels.list(&listing).await,
        Some(vec![json!({"value": "haiku", "label": "haiku"})])
    );
    assert_eq!(listing.asked(), json!([["list_models", {}]]));
    let refused = Context::new(json!({"list_models": {"error": "unknown"}}), Value::Null);
    assert_eq!(ClaudeModels.list(&refused).await, None);
    assert_eq!(
        ClaudeModels
            .list(&Context::new(json!({}), Value::Null))
            .await,
        None
    );
}

#[tokio::test]
async fn a_switch_the_model_it_runs_then_or_the_clis_refusal() {
    let switching = Context::new(
        json!({"set_model": {"response": {"model": "claude-sonnet-5-5"}}}),
        Value::Null,
    );
    assert_eq!(
        ClaudeModels.set(&switching, "sonnet").await,
        Ok(Some("claude-sonnet-5-5".to_owned()))
    );
    assert_eq!(
        switching.asked(),
        json!([["set_model", {"model": "sonnet"}]])
    );
    let refused = Context::new(
        json!({"set_model": {"error": "Model 'x' not found"}}),
        Value::Null,
    );
    assert_eq!(
        ClaudeModels.set(&refused, "x").await,
        Err("Model 'x' not found".to_owned())
    );
    assert_eq!(
        ClaudeModels
            .set(&Context::new(json!({}), Value::Null), "x")
            .await,
        Err("Claude did not answer in time".to_owned())
    );
    assert_eq!(
        ClaudeModels
            .set(
                &Context::new(json!({"set_model": {"response": {}}}), Value::Null),
                "x"
            )
            .await,
        Ok(None)
    );
}
