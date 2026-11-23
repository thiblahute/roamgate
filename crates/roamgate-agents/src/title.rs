//! `session-title.ts`: what a Claude session is about.

use serde_json::Value;

use crate::js;

/// The name the user gave the session, else Claude Code's title.
pub fn parse_session_title(records: &[Value]) -> Option<String> {
    let mut custom: Option<String> = None;
    let mut generated: Option<String> = None;
    for record in records {
        let Value::Object(record) = record else {
            continue;
        };
        let kind = record.get("type").and_then(Value::as_str);
        match (kind, record.get("customTitle"), record.get("aiTitle")) {
            (Some("custom-title"), Some(Value::String(title)), _) => {
                custom = Some(js::trim(title).to_owned()).filter(|t| !t.is_empty());
            }
            (Some("ai-title"), _, Some(Value::String(title))) => {
                generated = Some(js::trim(title).to_owned()).filter(|t| !t.is_empty());
            }
            _ => {}
        }
    }
    custom.or(generated)
}
