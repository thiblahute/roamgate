//! `session-images.ts`: an image the user sent inline in a transcript.

use std::sync::LazyLock;

use regex::Regex;
use serde_json::Value;

use crate::js::{self, sv};

const MEDIA_TYPES: [&str; 4] = ["image/png", "image/jpeg", "image/gif", "image/webp"];
const MAX_IMAGE_CHARS: usize = 16 * 1024 * 1024;
/// The code a sent image that will never load is answered with.
pub const SESSION_IMAGE_GONE: &str = "image_gone";

fn valid_base64(data: &str) -> bool {
    static BASE64: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"^[A-Za-z0-9+/]+={0,2}$").unwrap());
    let len = data.len();
    len > 0
        && len <= MAX_IMAGE_CHARS
        && len % 4 != 1
        && (!data.ends_with('=') || len.is_multiple_of(4))
        && BASE64.is_match(data)
}

/// The index-th image of the user record with this uuid, as
/// `{media_type, data}`, or None.
pub fn session_image(jsonl: &str, uuid: &str, index: f64) -> Option<Value> {
    if uuid.is_empty() || !js::is_safe_integer(index) || index < 0.0 {
        return None;
    }
    let needle = js::quote(uuid);
    for line in jsonl.split('\n') {
        if !line.contains(&needle) {
            continue;
        }
        let Some(Value::Object(record)) = js::parse(line) else {
            continue;
        };
        if sv(record.get("uuid")) != uuid || sv(record.get("type")) != "user" {
            continue;
        }
        let message = js::rec(record.get("message")).unwrap_or(&record);
        let Some(Value::Array(content)) = message.get("content") else {
            return None;
        };
        let image = content
            .iter()
            .filter(|part| {
                part.as_object()
                    .is_some_and(|p| sv(p.get("type")) == "image")
            })
            .nth(index as usize)?;
        let source = js::rec(image.get("source"))?;
        let media = source.get("media_type").and_then(Value::as_str)?;
        let data = source.get("data").and_then(Value::as_str)?;
        if sv(source.get("type")) != "base64"
            || !MEDIA_TYPES.contains(&media)
            || !valid_base64(data)
        {
            return None;
        }
        return Some(serde_json::json!({ "media_type": media, "data": data }));
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn jsonl() -> String {
        [
            json!({ "type": "user", "uuid": "other", "message": { "content": "x" } }).to_string(),
            "{not json".into(),
            json!({ "type": "user", "uuid": "u1", "message": { "role": "user", "content": [
                { "type": "text", "text": "two" },
                { "type": "image", "source": { "type": "base64", "media_type": "image/png", "data": "AAA" } },
                { "type": "image", "source": { "type": "base64", "media_type": "image/jpeg", "data": "BBB" } },
            ] } })
            .to_string(),
            json!({ "type": "user", "uuid": "bad", "message": { "content": [
                { "type": "image", "source": { "type": "base64", "media_type": "text/html", "data": "CCC" } },
            ] } })
            .to_string(),
        ]
        .join("\n")
    }

    #[test]
    fn finds_the_n_th_inline_image_of_a_user_record_by_uuid() {
        assert_eq!(
            session_image(&jsonl(), "u1", 0.0),
            Some(json!({ "media_type": "image/png", "data": "AAA" }))
        );
        assert_eq!(
            session_image(&jsonl(), "u1", 1.0),
            Some(json!({ "media_type": "image/jpeg", "data": "BBB" }))
        );
    }

    #[test]
    fn nothing_for_a_missing_record_index_or_a_type_that_is_not_an_image() {
        let text = jsonl();
        assert_eq!(session_image(&text, "u1", 2.0), None);
        assert_eq!(session_image(&text, "u1", -1.0), None);
        assert_eq!(session_image(&text, "nope", 0.0), None);
        assert_eq!(session_image(&text, "other", 0.0), None);
        assert_eq!(session_image(&text, "bad", 0.0), None);
    }

    #[test]
    fn malformed_base64_is_not_an_image() {
        for data in ["a", "a=", "aa=", "aaaa=", "<svg>", ""] {
            let record = json!({ "type": "user", "uuid": "m", "message": { "content": [
                { "type": "image", "source": { "type": "base64", "media_type": "image/png", "data": data } },
            ] } })
            .to_string();
            assert_eq!(session_image(&record, "m", 0.0), None, "{data}");
        }
    }
}
