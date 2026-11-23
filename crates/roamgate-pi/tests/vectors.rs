//! contract/vectors/pi-sidecar.json, replayed against this crate as
//! `bun test` replays it against server/src/assistant/pi-sidecar-protocol.ts.

use roamgate_pi::protocol::{Message, WireError, encode_message, parse_line, sidecar_command};
use roamgate_protocol::vectors::{self, is_undefined};
use serde_json::{Value, json};

/// A message as the TS side's object: `{kind, id, method, params}`...
fn message_value(message: &Message) -> Value {
    match message {
        Message::Request { id, method, params } => {
            json!({ "kind": "request", "id": id.to_value(), "method": method, "params": params })
        }
        Message::Notification { method, params } => {
            json!({ "kind": "notification", "method": method, "params": params })
        }
        Message::Result { id, result } => {
            json!({ "kind": "result", "id": id.to_value(), "result": result })
        }
        Message::Error { id, error } => json!({
            "kind": "error",
            "id": id.as_ref().map_or(Value::Null, |id| id.to_value()),
            "error": error.to_value(),
        }),
    }
}

fn wire_error(value: &Value) -> WireError {
    WireError {
        code: value["code"].as_i64().unwrap(),
        message: value["message"].as_str().unwrap().to_owned(),
        user: value.get("data").and_then(|data| data["user"].as_bool()),
    }
}

fn message_of(value: &Value) -> Message {
    let id = |value: &Value| match value {
        Value::Number(number) => roamgate_pi::protocol::Id::Num(number.as_i64().unwrap()),
        Value::String(text) => roamgate_pi::protocol::Id::Str(text.clone()),
        _ => panic!("id {value}"),
    };
    // An undefined property is left out, as in the TS call.
    let field = |name: &str| {
        value
            .get(name)
            .filter(|field| !is_undefined(field))
            .cloned()
            .unwrap_or(Value::Null)
    };
    match value["kind"].as_str().unwrap() {
        "request" => Message::Request {
            id: id(&value["id"]),
            method: value["method"].as_str().unwrap().to_owned(),
            params: field("params"),
        },
        "notification" => Message::Notification {
            method: value["method"].as_str().unwrap().to_owned(),
            params: field("params"),
        },
        "result" => Message::Result {
            id: id(&value["id"]),
            result: field("result"),
        },
        "error" => Message::Error {
            id: Some(id(&value["id"])),
            error: wire_error(&value["error"]),
        },
        other => panic!("kind {other}"),
    }
}

fn text_arg(value: &Value) -> Option<String> {
    (!is_undefined(value)).then(|| value.as_str().unwrap().to_owned())
}

#[test]
fn pi_sidecar_vectors() {
    let file = vectors::load("pi-sidecar");
    let mut count = 0;
    for case in &file.cases {
        for call in &case.calls {
            let target = call.target();
            let got = match target.as_str() {
                "piSidecar.parseLine" => parse_line(call.args[0].as_str().unwrap())
                    .as_ref()
                    .map_or(Value::Null, message_value),
                "piSidecar.encodeMessage" => json!(encode_message(&message_of(&call.args[0]))),
                "piSidecar.wireErrorKind" => json!(wire_error(&call.args[0]).kind()),
                "piSidecar.sidecarCommand" => {
                    let value = text_arg(&call.args[0]);
                    let bun = call.args[1].as_str().unwrap();
                    sidecar_command(value.as_deref(), bun).map_or(Value::Null, |argv| json!(argv))
                }
                other => panic!("{}: no Rust function for {other}", case.title()),
            };
            // A null result reads as None.
            let expected = call.result.clone().unwrap_or(Value::Null);
            assert_eq!(got, expected, "{} ({target} {:?})", case.title(), call.args);
            count += 1;
        }
    }
    assert_eq!(count, 38);
}
