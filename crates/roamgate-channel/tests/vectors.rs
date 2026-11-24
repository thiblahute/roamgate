//! contract/vectors/core-channel.json, replayed against this crate.

use roamgate_channel::protocol::{
    Families, OutboundQueue, decode_body, encode_body, encode_message, family_of, http_family_of,
};
use roamgate_protocol::vectors::{self, Call};
use serde_json::{Value, json};

fn bytes(value: &Value) -> Vec<u8> {
    match vectors::tag(value) {
        Some(("$bytes", hex)) => vectors::hex(hex.as_str().unwrap()),
        _ => panic!("not bytes: {value}"),
    }
}

fn bytes_value(data: &[u8]) -> Value {
    let hex: String = data.iter().map(|byte| format!("{byte:02x}")).collect();
    json!({"$bytes": hex})
}

fn families(value: &Value) -> Families {
    serde_json::from_value(value.clone()).unwrap()
}

fn call_fn(call: &Call) -> Value {
    let args = &call.args;
    match call.fn_.as_deref().unwrap() {
        "coreChannel.encodeMessage" => bytes_value(&encode_message(&args[0])),
        "coreChannel.encodeBody" => bytes_value(&encode_body(
            args[0].as_u64().unwrap() as u32,
            args[1].as_u64().unwrap() as u8,
            &bytes(&args[2]),
        )),
        "coreChannel.decodeBody" => match decode_body(&bytes(&args[0])) {
            Some(chunk) => {
                json!({"stream": chunk.stream, "flags": chunk.flags, "bytes": bytes_value(&chunk.bytes)})
            }
            None => Value::Null,
        },
        "coreChannel.familyOf" => json!(family_of(args[0].as_str().unwrap(), &families(&args[1]))),
        "coreChannel.httpFamilyOf" => {
            json!(http_family_of(
                args[0].as_str().unwrap(),
                &families(&args[1])
            ))
        }
        other => panic!("no Rust counterpart for {other}"),
    }
}

/// `null` and `undefined` alike: what a method returning nothing gave.
fn expected(call: &Call) -> Value {
    match &call.result {
        Some(value) if !vectors::is_undefined(value) => value.clone(),
        _ => Value::Null,
    }
}

#[test]
fn core_channel_vectors() {
    let file = vectors::load("core-channel");
    assert!(file.modules.contains_key("coreChannel"));
    assert!(!file.cases.is_empty());
    for case in &file.cases {
        let title = case.title();
        let mut queue: Option<OutboundQueue<String>> = None;
        for call in &case.calls {
            let target = call.target();
            if target == "coreChannel.OutboundQueue" {
                assert!(call.new, "{title}: the queue is constructed");
                queue = Some(OutboundQueue::new());
                continue;
            }
            let got = if call.on.is_some() {
                let queue = queue.as_mut().expect("a queue handle");
                let args = &call.args;
                match call.method.as_deref().unwrap() {
                    "enqueue" => json!(queue.enqueue(
                        args[0].as_str().unwrap().to_owned(),
                        args[1].as_str().map(str::to_owned),
                    )),
                    "take" => json!(queue.take()),
                    "size" => json!(queue.size()),
                    other => panic!("{title}: no queue method {other}"),
                }
            } else {
                call_fn(call)
            };
            assert_eq!(got, expected(call), "{title}: {target} {:?}", call.args);
        }
    }
}
