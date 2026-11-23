//! The Rust record checker finds what the TS one finds (when Bun is here).

use std::process::Command;

use roamgate_parity::check::check_recordings;
use roamgate_parity::paths::{contract_dir, repo_root};
use serde_json::{Value, json};

fn line(seq: u64, fields: Value) -> String {
    let mut record = json!({"v": 1, "seq": seq, "t": "2026-01-01T00:00:00.000Z", "pid": 1});
    record
        .as_object_mut()
        .unwrap()
        .extend(fields.as_object().unwrap().clone());
    format!("{record}\n")
}

#[test]
fn findings_match_the_ts_checker() {
    let dir = tempfile::tempdir().unwrap();
    let text = [
        line(1, json!({"ch": "ws", "ev": "in", "sock": "s", "msg": {"id": "1", "method": "no.such_method", "params": {}}})),
        line(2, json!({"ch": "ws", "ev": "in", "sock": "s", "msg": {"id": "2", "method": "limit_resume.list", "params": {}}})),
        line(3, json!({"ch": "ws", "ev": "out", "sock": "s", "msg": {"id": "2", "result": {"pauses": "not a list"}}})),
        line(4, json!({"ch": "ws", "ev": "out", "sock": "s", "msg": {"hello": true, "socket": "/x", "bridge_protocol_version": 2, "default_connection_id": null, "capabilities": {}, "extra": 1}})),
        line(5, json!({"ch": "http", "ev": "exchange", "method": "POST", "path": "/api/no/such/route", "status": 404})),
        line(6, json!({"ch": "ws", "ev": "out", "sock": "s", "msg": {"event": "no.such_event", "data": {}}})),
    ]
    .concat();
    std::fs::write(dir.path().join("rec-0001.jsonl"), text).unwrap();
    let report = check_recordings(dir.path(), &contract_dir()).unwrap();
    let mut keys: Vec<String> = report
        .findings
        .iter()
        .map(|finding| {
            format!(
                "{} {} {} {}",
                finding.kind, finding.surface, finding.name, finding.path
            )
        })
        .collect();
    keys.sort();
    for wanted in [
        "unlisted rpc.request no.such_method /",
        "unknown-field push hello message/extra",
        "unlisted http POST /api/no/such/route /",
        "unlisted push event:no.such_event /",
    ] {
        assert!(
            keys.iter().any(|key| key == wanted),
            "{wanted} not in {keys:#?}"
        );
    }
    assert!(
        keys.iter()
            .any(|key| key.starts_with("mismatch rpc.reply limit_resume.list reply/pauses")),
        "{keys:#?}"
    );
    let Ok(output) = Command::new("bun")
        .args(["scripts/contract-record.ts", "check"])
        .arg(dir.path())
        .arg("--contract")
        .arg(contract_dir())
        .arg("--json")
        .current_dir(repo_root())
        .output()
    else {
        eprintln!("no bun: the TS side is not compared");
        return;
    };
    let text = String::from_utf8_lossy(&output.stdout);
    let value: Value = serde_json::from_str(&text[text.find('{').unwrap()..]).unwrap();
    let mut theirs: Vec<String> = value["findings"]
        .as_array()
        .unwrap()
        .iter()
        .map(|finding| {
            format!(
                "{} {} {} {}",
                finding["kind"].as_str().unwrap(),
                finding["surface"].as_str().unwrap(),
                finding["name"].as_str().unwrap(),
                finding["path"].as_str().unwrap()
            )
        })
        .collect();
    theirs.sort();
    theirs.dedup();
    let mut ours = keys.clone();
    ours.dedup();
    assert_eq!(ours, theirs);
}

#[test]
fn a_key_of_several_branches_is_unknown_only_if_every_one_lacks_it() {
    use roamgate_parity::check::unknown_fields;
    let branch = |kind: &str, field: &str| json!({"type": "object", "properties": {"kind": {"const": kind}, "status": {"type": "object", "properties": {field: {}}}}});
    let schema = json!({"anyOf": [branch("status", "a"), branch("card", "b")]});
    assert!(
        unknown_fields(
            &schema,
            &json!({"kind": "card", "status": {"b": 1}}),
            &schema,
            "",
            0
        )
        .is_empty()
    );
    assert_eq!(
        unknown_fields(
            &schema,
            &json!({"kind": "card", "status": {"c": 1}}),
            &schema,
            "",
            0
        ),
        vec!["/status/c".to_owned()]
    );
}

#[test]
fn a_redacted_string_matches_any_string_schema() {
    let dir = tempfile::tempdir().unwrap();
    let contract = dir.path().join("contract");
    std::fs::create_dir_all(contract.join("push")).unwrap();
    std::fs::write(
        contract.join("push/secret.json"),
        json!({"type": "object", "properties": {"secret": {"enum": ["a", "b"]}, "auth": {"anyOf": [{"type": "object", "properties": {"status": {"enum": ["x"]}}}, {"type": "null"}]}, "other": {"enum": ["a"]}}}).to_string(),
    )
    .unwrap();
    let recording = dir.path().join("record");
    std::fs::create_dir_all(&recording).unwrap();
    std::fs::write(
        recording.join("rec-0001.jsonl"),
        line(1, json!({"ch": "ws", "ev": "out", "sock": "s", "msg": {"secret": "[redacted:0a1b]", "auth": {"status": "[redacted:0c]"}, "other": "c"}})),
    )
    .unwrap();
    // The push is named by its keys: "auth+other+secret".
    std::fs::rename(
        contract.join("push/secret.json"),
        contract.join("push/auth+other+secret.json"),
    )
    .unwrap();
    let report = check_recordings(&recording, &contract).unwrap();
    let paths: Vec<&str> = report
        .findings
        .iter()
        .map(|finding| finding.path.as_str())
        .collect();
    assert_eq!(paths, vec!["message/other"]);
}
