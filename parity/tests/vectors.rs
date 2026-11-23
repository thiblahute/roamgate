//! T0 vectors (contract/vectors/*.json) that have a Rust side already: the
//! same files are read by bun test against the TS functions.

use roamgate_parity::fakes::voice;
use roamgate_parity::paths::contract_dir;
use serde_json::Value;

fn hex(text: &str) -> Vec<u8> {
    (0..text.len())
        .step_by(2)
        .map(|at| u8::from_str_radix(&text[at..at + 2], 16).unwrap())
        .collect()
}

#[test]
fn voice_frames() {
    let path = contract_dir().join("vectors/voice-frames.json");
    let doc: Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
    assert_eq!(
        doc["max_frame"].as_u64().unwrap() as usize,
        voice::MAX_FRAME
    );
    for case in doc["frames"].as_array().unwrap() {
        let name = case["name"].as_str().unwrap();
        let kind = case["kind"].as_u64().unwrap() as u8;
        let payload = match case.get("payload_text") {
            Some(text) => text.as_str().unwrap().as_bytes().to_vec(),
            None => hex(case["payload_hex"].as_str().unwrap()),
        };
        let frame = hex(case["frame_hex"].as_str().unwrap());
        assert_eq!(voice::encode_frame(kind, &payload), frame, "{name}: encode");
        let decoded = voice::read_frame(&mut frame.as_slice()).unwrap().unwrap();
        assert_eq!(decoded, (kind, payload), "{name}: decode");
    }
    for case in doc["invalid"].as_array().unwrap() {
        let bytes = hex(case["bytes_hex"].as_str().unwrap());
        assert!(
            voice::read_frame(&mut bytes.as_slice()).is_err(),
            "{}",
            case["name"]
        );
    }
}
