//! session-rewind-history.test.ts: a rewind past messages sent through
//! Claude Code's queue, on the recorded transcript both sides read.

use std::sync::Arc;

use serde_json::{Value, json};

use crate::files::{BoxFut, SessionFiles};
use crate::js::{self, Obj};
use crate::projection::{read_session_projection, read_tail_projection};
use crate::rewind::{REWOUND_PROMPT, kept_records, rewound_record_ids};
use crate::session::SessionFile;

fn records() -> Vec<Obj> {
    let text = include_str!("../../../contract/vectors/session-rewind-fixture.json");
    let fixture: Value = serde_json::from_str(text).unwrap();
    fixture["records"]
        .as_array()
        .unwrap()
        .iter()
        .map(|r| r.as_object().unwrap().clone())
        .collect()
}

fn jsonl(records: &[Obj]) -> String {
    records
        .iter()
        .map(|r| format!("{}\n", js::stringify(&Value::Object(r.clone()))))
        .collect()
}

struct Text(Vec<u8>);

impl SessionFiles for Text {
    fn remote(&self) -> bool {
        false
    }
    fn stat_file<'a>(&'a self, _: &'a str) -> BoxFut<'a, std::io::Result<Option<SessionFile>>> {
        Box::pin(async { Ok(None) })
    }
    fn read_text<'a>(&'a self, _: &'a str) -> BoxFut<'a, std::io::Result<String>> {
        let text = String::from_utf8_lossy(&self.0).into_owned();
        Box::pin(async move { Ok(text) })
    }
    fn read_prefix<'a>(&'a self, _: &'a str, _: u64) -> BoxFut<'a, std::io::Result<Vec<u8>>> {
        Box::pin(async { Ok(Vec::new()) })
    }
    fn read_tail<'a>(&'a self, _: &'a str, _: u64) -> BoxFut<'a, std::io::Result<Vec<u8>>> {
        Box::pin(async { Ok(Vec::new()) })
    }
    fn read_range<'a>(
        &'a self,
        _: &'a str,
        start: u64,
        end: u64,
    ) -> BoxFut<'a, std::io::Result<Vec<u8>>> {
        let len = self.0.len() as u64;
        let bytes = self.0[start.min(len) as usize..end.min(len) as usize].to_vec();
        Box::pin(async move { Ok(bytes) })
    }
    fn read_download<'a>(&'a self, _: &'a str) -> BoxFut<'a, std::io::Result<Vec<u8>>> {
        Box::pin(async { Ok(Vec::new()) })
    }
    fn find_pi_session_by_id<'a>(
        &'a self,
        _: &'a str,
    ) -> BoxFut<'a, std::io::Result<Option<SessionFile>>> {
        Box::pin(async { Ok(None) })
    }
    fn find_pi_session_for_cwd<'a>(
        &'a self,
        _: &'a str,
    ) -> BoxFut<'a, std::io::Result<Option<SessionFile>>> {
        Box::pin(async { Ok(None) })
    }
    fn find_claude_session_by_id<'a>(
        &'a self,
        _: &'a str,
    ) -> BoxFut<'a, std::io::Result<Option<SessionFile>>> {
        Box::pin(async { Ok(None) })
    }
    fn find_claude_successor<'a>(
        &'a self,
        _: &'a str,
        _: &'a str,
    ) -> BoxFut<'a, std::io::Result<Option<String>>> {
        Box::pin(async { Ok(None) })
    }
    fn find_codex_session_by_id<'a>(
        &'a self,
        _: &'a str,
    ) -> BoxFut<'a, std::io::Result<Option<SessionFile>>> {
        Box::pin(async { Ok(None) })
    }
}

fn access(text: String) -> (SessionFile, Arc<Text>) {
    let file = SessionFile {
        path: "/tmp/rewound.jsonl".into(),
        mtime_ms: 1000.0,
        size: Some(text.len() as f64),
        ..Default::default()
    };
    (file, Arc::new(Text(text.into_bytes())))
}

const CUT: [&str; 2] = [
    "I think you should check out his last messages.",
    "No, I'm telling you to look at Romate last messages.",
];

fn shown(entries: &[Value]) -> Vec<(String, String, String)> {
    entries
        .iter()
        .filter(|e| e["kind"] == "message")
        .map(|e| {
            let tag = match e["injected"]["kind"].as_str() {
                Some(kind) => kind.to_owned(),
                None if e["queued"] == json!(true) => "queued".into(),
                None => String::new(),
            };
            (
                js::sv(e.get("role")).to_owned(),
                tag,
                js::head16(js::sv(e.get("text")), 40),
            )
        })
        .collect()
}

fn row(role: &str, tag: &str, text: &str) -> (String, String, String) {
    (role.into(), tag.into(), text.into())
}

#[test]
fn keeps_the_cut_prompts_as_stand_ins_without_their_uuids() {
    let records = records();
    let rewound = rewound_record_ids(&records);
    let kept = kept_records(records, Some(&rewound));
    let stand: Vec<&Obj> = kept
        .iter()
        .filter(|r| js::sv(r.get("type")) == REWOUND_PROMPT)
        .collect();
    assert_eq!(
        stand
            .iter()
            .map(|r| js::sv(r.get("content")))
            .collect::<Vec<_>>(),
        CUT
    );
    assert!(stand.iter().all(|r| r.get("uuid").is_none()));
    for cut in ["f7f8aeb9", "2ee463be", "dc0ae100"] {
        assert!(
            !kept.iter().any(|r| js::sv(r.get("uuid")).starts_with(cut)),
            "{cut}"
        );
    }
}

#[tokio::test]
async fn the_history_shows_the_current_branch_only_and_none_of_it_queued() {
    let (file, files) = access(jsonl(&records()));
    let (projection, _) = read_session_projection("claude", &file, files.as_ref(), None)
        .await
        .unwrap();
    assert!(
        !projection
            .entries
            .iter()
            .any(|e| e["queued"] == json!(true))
    );
    let messages: Vec<&Value> = projection
        .entries
        .iter()
        .filter(|e| e["kind"] == "message")
        .collect();
    for text in CUT {
        assert!(!messages.iter().any(|e| e["text"] == json!(text)));
    }
    assert!(
        !messages
            .iter()
            .any(|e| js::sv(e.get("text")).starts_with("I'm not sure"))
    );
    let last: Vec<String> = messages[messages.len() - 2..]
        .iter()
        .map(|e| js::head16(js::sv(e.get("text")), 26))
        .collect();
    assert_eq!(
        last,
        ["whether the um mcp the sou", "Yes, there are two levels:"]
    );
}

#[tokio::test]
async fn the_cut_messages_stay_as_one_notice_where_they_were() {
    let (file, files) = access(jsonl(&records()));
    let (projection, _) = read_session_projection("claude", &file, files.as_ref(), None)
        .await
        .unwrap();
    assert_eq!(
        shown(&projection.entries),
        [
            row("user", "task", "Agent \"Vet Spotify MCP servers\" finished"),
            row(
                "user",
                "rewound",
                "I think you should check out his last me"
            ),
            row("user", "", "whether the um mcp the sound can be used"),
            row(
                "assistant",
                "",
                "Yes, there are two levels:\n\n1. **In Clau"
            ),
        ]
    );
    let notice = projection
        .entries
        .iter()
        .find(|e| e["injected"]["kind"] == "rewound")
        .unwrap();
    assert_eq!(
        notice["injected"]["label"],
        json!("Rewound: 2 of your messages left the conversation")
    );
    assert_eq!(
        notice["rewound"],
        json!([{ "text": CUT[0], "sent_at": "2026-11-05T00:27:47.794Z" }, { "text": CUT[1], "sent_at": "2026-11-05T00:28:03.746Z" }])
    );
    assert_eq!(projection.aggregates.stats["turns"], json!(1));
}

#[tokio::test]
async fn before_the_next_message_the_cut_messages_are_already_out_and_not_queued() {
    let records = records();
    let at = records
        .iter()
        .position(|r| {
            js::sv(r.get("type")) == "last-prompt" && r.get("rewound") == Some(&json!(true))
        })
        .unwrap();
    let (file, files) = access(jsonl(&records[..=at]));
    let (projection, _) = read_session_projection("claude", &file, files.as_ref(), None)
        .await
        .unwrap();
    assert_eq!(
        shown(&projection.entries),
        [
            row("user", "task", "Agent \"Vet Spotify MCP servers\" finished"),
            row(
                "user",
                "rewound",
                "I think you should check out his last me"
            ),
        ]
    );
}

#[tokio::test]
async fn a_large_transcript_read_by_its_end_shows_the_same() {
    let (file, files) = access(jsonl(&records()));
    let tail = read_tail_projection(&file, files.as_ref()).await.unwrap();
    let whole = read_session_projection("claude", &file, files.as_ref(), None)
        .await
        .unwrap()
        .0;
    assert_eq!(shown(&tail), shown(&whole.entries));
}

#[tokio::test]
async fn a_rewind_empties_what_the_history_still_counted_as_queued() {
    let records: Vec<Obj> = [
        json!({ "type": "queue-operation", "operation": "enqueue", "timestamp": "2026-11-05T00:28:03.652Z", "content": "left behind" }),
        json!({ "type": "last-prompt", "rewound": true, "cutUuid": "unknown" }),
    ]
    .into_iter()
    .map(|r| r.as_object().unwrap().clone())
    .collect();
    let (file, files) = access(jsonl(&records));
    let (projection, _) = read_session_projection("claude", &file, files.as_ref(), None)
        .await
        .unwrap();
    assert!(
        !projection
            .entries
            .iter()
            .any(|e| e["queued"] == json!(true))
    );
}
