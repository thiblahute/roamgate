use serde_json::json;

use super::*;

#[test]
fn stable_json_sorts_every_object_s_keys_and_ends_with_one_newline() {
    assert_eq!(
        stable_json(&json!({"b": 1, "a": {"d": [{"z": 1, "y": 2}]}})),
        "{\n  \"a\": {\n    \"d\": [\n      {\n        \"y\": 2,\n        \"z\": 1\n      }\n    ]\n  },\n  \"b\": 1\n}\n",
    );
    assert_eq!(
        stable_json(&json!({"b": 1, "a": 2})),
        stable_json(&json!({"a": 2, "b": 1}))
    );
    // As Bun prints it: integer-like keys first, by number.
    assert_eq!(
        stable_json(&json!({"b": 1, "10": 2, "9": 3, "01": 4})),
        "{\n  \"9\": 3,\n  \"10\": 2,\n  \"01\": 4,\n  \"b\": 1\n}\n",
    );
}

#[test]
fn list_items_are_named_by_id_key_name_request_project_host_or_place() {
    let mut out = Obj::new();
    items_of(
        &mut out,
        "x",
        Some(&json!([
            "plain",
            {"id": 3},
            {"key": "k", "name": "n"},
            {"provider": "gitlab", "host": "h", "project": "g/p", "number": 9},
            {"provider": "gitlab", "project": "g/p"},
            {"provider": "github", "host": "github.com"},
            {"connection_id": "local", "label": "Home"},
            {"connection_id": "local"},
            7,
            {"id": null},
        ])),
    );
    let names: Vec<&str> = out.keys().map(String::as_str).collect();
    assert_eq!(
        names,
        [
            "x[plain]",
            "x[3]",
            "x[k]",
            "x[gitlab:h/g/p#9]",
            "x[gitlab:undefined/g/p]",
            "x[github:github.com]",
            "x[local:Home]",
            "x[local:]",
            "x[#8]",
            "x[#9]",
        ]
    );
}

#[test]
fn a_newer_export_or_another_file_is_refused() {
    assert_eq!(parse_reviews_export("{").unwrap_err(), "not JSON");
    assert_eq!(
        parse_reviews_export(r#"{"format":"other"}"#).unwrap_err(),
        "not a Reviews export"
    );
    assert_eq!(
        parse_reviews_export(r#"{"format":"roamgate-reviews","version":4,"mr_reviews":{}}"#)
            .unwrap_err(),
        "export version 4 is newer than this Roamgate"
    );
    assert_eq!(
        parse_reviews_export(r#"{"format":"roamgate-reviews","mr_reviews":{}}"#).unwrap_err(),
        "export version undefined is newer than this Roamgate"
    );
    assert_eq!(
        parse_reviews_export(r#"{"format":"roamgate-reviews","version":3}"#).unwrap_err(),
        "no mr_reviews in the export"
    );
    assert_eq!(
        parse_reviews_export(
            r#"{"format":"roamgate-reviews","version":3,"mr_reviews":{},"efforts":{"a/b":{}}}"#
        )
        .unwrap_err(),
        "bad effort id a/b"
    );
}
