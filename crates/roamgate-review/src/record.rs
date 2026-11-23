//! Record mode on the agent socket (contract-record/hooks.ts `recordFetch`
//! on the `agent` channel): each request and its answer as one `exchange`
//! event, the request's body read as a form or JSON whatever its header
//! says, as the socket itself reads it.

use roamgate_base::record::{ContractRecorder, RawKind, RecordInput};
use serde_json::{Map, Value, json};

/// The most of a body recorded (`RECORD_BODY_LIMIT`).
pub const RECORD_BODY_LIMIT: usize = 256 * 1024;

/// One request of an agent socket's client and what it was answered.
#[derive(Debug, Clone, Default)]
pub struct AgentExchange {
    pub method: String,
    /// The request's absolute URL (`http://localhost/v1/...`).
    pub url: String,
    pub headers: Vec<(String, String)>,
    pub body: Option<String>,
    /// Milliseconds to the answer's head.
    pub ms: u64,
    /// The answer; None when the handler failed (`thrown`).
    pub status: Option<u16>,
    pub response_headers: Vec<(String, String)>,
    pub response_body: Option<String>,
    pub thrown: Option<String>,
}

/// How a body of this content type is read (`bodyKind`); None: not kept.
fn body_kind(content_type: Option<&str>) -> Option<RawKind> {
    let lower = content_type?.to_ascii_lowercase();
    let json = lower.starts_with("application/")
        && lower["application/".len()..]
            .split([';', ' '])
            .next()
            .is_some_and(|sub| {
                sub == "json"
                    || sub.strip_suffix("+json").is_some_and(|prefix| {
                        prefix
                            .chars()
                            .all(|c| c.is_ascii_lowercase() || matches!(c, '.' | '+' | '-'))
                    })
            });
    let form = lower.starts_with("application/x-www-form-urlencoded");
    let text = lower.starts_with("text/plain");
    if form {
        Some(RawKind::Form)
    } else if json {
        Some(RawKind::Json)
    } else if text {
        Some(RawKind::Text)
    } else {
        None
    }
}

fn header<'a>(headers: &'a [(String, String)], name: &str) -> Option<&'a str> {
    headers
        .iter()
        .find(|(key, _)| key.eq_ignore_ascii_case(name))
        .map(|(_, value)| value.as_str())
}

fn headers_object(headers: &[(String, String)]) -> Value {
    let mut map = Map::new();
    for (key, value) in headers {
        map.insert(key.to_ascii_lowercase(), json!(value));
    }
    Value::Object(map)
}

/// A body as recorded: its text when kept, and its size and whether it
/// was cut.
fn captured(body: Option<&String>, kind: Option<RawKind>) -> (Option<String>, Option<usize>, bool) {
    let Some(body) = body else {
        return (None, None, false);
    };
    if body.len() > RECORD_BODY_LIMIT {
        return (None, Some(body.len()), true);
    }
    (kind.map(|_| body.clone()), Some(body.len()), false)
}

/// Records an agent socket exchange (`recordServe(recorder, "agent")`).
pub fn record_agent_exchange(recorder: &ContractRecorder, exchange: AgentExchange) {
    let mut fields = Map::new();
    fields.insert("method".into(), json!(exchange.method));
    fields.insert("headers".into(), headers_object(&exchange.headers));
    let mut bodies = Vec::new();
    // The agent socket's clients post JSON or forms, whatever their header.
    let bodyless = matches!(exchange.method.as_str(), "GET" | "HEAD");
    let (body, size, cut) = if bodyless {
        (None, None, false)
    } else {
        captured(exchange.body.as_ref(), Some(RawKind::Form))
    };
    if let Some(thrown) = exchange.thrown {
        fields.insert("ms".into(), json!(exchange.ms));
        fields.insert("thrown".into(), json!(thrown));
        if let Some(body) = body {
            bodies.push(("body".into(), body, RawKind::Form));
        }
    } else {
        if let Some(size) = size {
            fields.insert("size".into(), json!(size));
        }
        if cut {
            fields.insert("cut".into(), json!(true));
        }
        fields.insert("ms".into(), json!(exchange.ms));
        match exchange.status {
            Some(status) => {
                fields.insert("status".into(), json!(status));
                fields.insert(
                    "response_headers".into(),
                    headers_object(&exchange.response_headers),
                );
                let kind = body_kind(header(&exchange.response_headers, "content-type"));
                let (response, response_size, response_cut) = if exchange.method == "HEAD" {
                    (None, None, false)
                } else {
                    captured(exchange.response_body.as_ref(), kind)
                };
                if let Some(size) = response_size {
                    fields.insert("response_size".into(), json!(size));
                }
                if response_cut {
                    fields.insert("response_cut".into(), json!(true));
                }
                if let Some(body) = body {
                    bodies.push(("body".into(), body, RawKind::Form));
                }
                if let (Some(response), Some(kind)) = (response, kind) {
                    bodies.push(("response".into(), response, kind));
                }
            }
            None => {
                fields.insert("upgrade".into(), json!(true));
                if let Some(body) = body {
                    bodies.push(("body".into(), body, RawKind::Form));
                }
            }
        }
    }
    recorder.record(RecordInput {
        fields: Some(fields),
        url: Some(exchange.url),
        bodies,
        ..RecordInput::new("agent", "exchange")
    });
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use roamgate_base::record::RecorderOptions;

    use super::*;

    #[test]
    fn records_the_agent_socket_s_forms() {
        let scratch = tempfile::tempdir().unwrap();
        let directory = scratch.path().join("rec");
        let recorder = ContractRecorder::new(RecorderOptions::new(
            &directory,
            "server",
            Arc::new(|| 1_767_323_045_678),
        ))
        .unwrap();
        let body = "to=desktop%2Fw1%3Ap1&text=hi";
        record_agent_exchange(
            &recorder,
            AgentExchange {
                method: "POST".into(),
                url: "http://127.0.0.1/v1/message".into(),
                // No form header: the socket reads it as one anyway.
                headers: vec![("content-type".into(), "text/plain;charset=UTF-8".into())],
                body: Some(body.into()),
                ms: 1,
                status: Some(200),
                response_headers: vec![(
                    "content-type".into(),
                    "application/json;charset=utf-8".into(),
                )],
                response_body: Some(json!({"ok": body.len()}).to_string()),
                thrown: None,
            },
        );
        recorder.flush();
        let mut text = String::new();
        for entry in std::fs::read_dir(&directory).unwrap() {
            text.push_str(&std::fs::read_to_string(entry.unwrap().path()).unwrap());
        }
        let line: Value = text
            .lines()
            .map(|line| serde_json::from_str::<Value>(line).unwrap())
            .find(|line| line["ch"] == "agent")
            .unwrap();
        assert_eq!(line["ev"], "exchange");
        assert_eq!(line["path"], "/v1/message");
        assert_eq!(line["body"], json!({"to": "desktop/w1:p1", "text": "hi"}));
        assert_eq!(line["response"], json!({"ok": 28}));
        assert_eq!(line["status"], 200);
        recorder.close();
    }

    #[test]
    fn bodies_are_kept_by_their_type() {
        assert_eq!(body_kind(Some("application/json")), Some(RawKind::Json));
        assert_eq!(
            body_kind(Some("application/vnd.x+json; v=1")),
            Some(RawKind::Json)
        );
        assert_eq!(
            body_kind(Some("application/x-www-form-urlencoded")),
            Some(RawKind::Form)
        );
        assert_eq!(body_kind(Some("text/plain")), Some(RawKind::Text));
        assert_eq!(body_kind(Some("image/png")), None);
        assert_eq!(body_kind(None), None);
    }
}
