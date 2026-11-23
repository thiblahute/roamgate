//! `session-tail.test.ts`: large transcripts read by their end, through the
//! handlers, against an in-memory file.

use std::io;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use serde_json::{Value, json};

use crate::files::{BoxFut, SessionFiles};
use crate::handlers::AgentSessionHandlers;
use crate::index_store::SessionIndexStore;
use crate::js;
use crate::projection::read_session_projection;
use crate::resolver::{HerdrCall, ResolverContext};
use crate::session::SessionFile;
use crate::tail::{LARGE_SESSION_BYTES, find_line_from_end, read_tail_records};

pub(crate) const PATH: &str = "/tmp/large-session.jsonl";

/// A transcript in memory, counting what is read of it.
pub(crate) struct MemFiles {
    pub bytes: Mutex<Vec<u8>>,
    pub identity: Mutex<u64>,
    pub range_bytes: AtomicU64,
    pub whole_reads: AtomicU64,
    pub ranges: bool,
}

impl MemFiles {
    pub fn new(bytes: Vec<u8>) -> Arc<Self> {
        Arc::new(Self {
            bytes: Mutex::new(bytes),
            identity: Mutex::new(1),
            range_bytes: AtomicU64::new(0),
            whole_reads: AtomicU64::new(0),
            ranges: true,
        })
    }
    fn file(&self) -> SessionFile {
        let len = self.bytes.lock().unwrap().len();
        SessionFile {
            path: PATH.into(),
            mtime_ms: 1000.0 + len as f64,
            size: Some(len as f64),
            identity: Some(self.identity.lock().unwrap().to_string()),
            change_token: Some(len.to_string()),
            ..Default::default()
        }
    }
    pub fn append(&self, more: &[u8]) {
        self.bytes.lock().unwrap().extend_from_slice(more);
    }
    pub fn replace(&self, next: Vec<u8>) {
        *self.bytes.lock().unwrap() = next;
        *self.identity.lock().unwrap() += 1;
    }
    pub fn take_range_bytes(&self) -> u64 {
        self.range_bytes.swap(0, Ordering::SeqCst)
    }
}

impl SessionFiles for MemFiles {
    fn remote(&self) -> bool {
        false
    }
    fn stat_file<'a>(&'a self, _path: &'a str) -> BoxFut<'a, io::Result<Option<SessionFile>>> {
        let file = self.file();
        Box::pin(async move { Ok(Some(file)) })
    }
    fn read_text<'a>(&'a self, _path: &'a str) -> BoxFut<'a, io::Result<String>> {
        self.whole_reads.fetch_add(1, Ordering::SeqCst);
        let text = String::from_utf8_lossy(&self.bytes.lock().unwrap()).into_owned();
        Box::pin(async move { Ok(text) })
    }
    fn read_prefix<'a>(&'a self, _path: &'a str, limit: u64) -> BoxFut<'a, io::Result<Vec<u8>>> {
        let bytes = self.bytes.lock().unwrap();
        let out = bytes[..bytes.len().min(limit as usize)].to_vec();
        Box::pin(async move { Ok(out) })
    }
    fn read_tail<'a>(&'a self, _path: &'a str, limit: u64) -> BoxFut<'a, io::Result<Vec<u8>>> {
        let bytes = self.bytes.lock().unwrap();
        let out = bytes[bytes.len().saturating_sub(limit as usize)..].to_vec();
        Box::pin(async move { Ok(out) })
    }
    fn has_range(&self) -> bool {
        self.ranges
    }
    fn read_range<'a>(
        &'a self,
        _path: &'a str,
        start: u64,
        end: u64,
    ) -> BoxFut<'a, io::Result<Vec<u8>>> {
        let bytes = self.bytes.lock().unwrap();
        let start = (start as usize).min(bytes.len());
        let end = (end as usize).min(bytes.len()).max(start);
        let out = bytes[start..end].to_vec();
        self.range_bytes
            .fetch_add(out.len() as u64, Ordering::SeqCst);
        Box::pin(async move { Ok(out) })
    }
    fn read_download<'a>(&'a self, _path: &'a str) -> BoxFut<'a, io::Result<Vec<u8>>> {
        let out = self.bytes.lock().unwrap().clone();
        Box::pin(async move { Ok(out) })
    }
    fn find_pi_session_by_id<'a>(
        &'a self,
        _id: &'a str,
    ) -> BoxFut<'a, io::Result<Option<SessionFile>>> {
        Box::pin(async { Ok(None) })
    }
    fn find_pi_session_for_cwd<'a>(
        &'a self,
        _cwd: &'a str,
    ) -> BoxFut<'a, io::Result<Option<SessionFile>>> {
        Box::pin(async { Ok(None) })
    }
    fn find_claude_session_by_id<'a>(
        &'a self,
        _id: &'a str,
    ) -> BoxFut<'a, io::Result<Option<SessionFile>>> {
        Box::pin(async { Ok(None) })
    }
    fn find_claude_successor<'a>(
        &'a self,
        _path: &'a str,
        _id: &'a str,
    ) -> BoxFut<'a, io::Result<Option<String>>> {
        Box::pin(async { Ok(None) })
    }
    fn find_codex_session_by_id<'a>(
        &'a self,
        _id: &'a str,
    ) -> BoxFut<'a, io::Result<Option<SessionFile>>> {
        Box::pin(async { Ok(None) })
    }
}

/// Herdr reporting one agent with a fixed answer.
pub(crate) struct FixedHerdr(pub Value);

impl HerdrCall for FixedHerdr {
    fn call(
        &self,
        _method: &str,
        _params: Value,
        _timeout: Option<u64>,
    ) -> BoxFut<'_, Result<Value, String>> {
        let answer = self.0.clone();
        Box::pin(async move { Ok(answer) })
    }
}

/// A Claude transcript: `bulk` large tool results, then `turns` turns.
pub(crate) fn transcript(bulk: usize, turns: usize, from: usize) -> Vec<Value> {
    let mut records: Vec<Value> = Vec::new();
    let mut parent: Option<String> = None;
    let mut add = |records: &mut Vec<Value>, mut record: Value| {
        let uuid = format!("u{}", from + records.len());
        let map = record.as_object_mut().unwrap();
        map.insert("uuid".into(), Value::String(uuid.clone()));
        map.insert(
            "parentUuid".into(),
            parent.clone().map_or(Value::Null, Value::String),
        );
        map.insert(
            "timestamp".into(),
            Value::String(js::iso(1_700_000_000_000.0 + (from + records.len()) as f64)),
        );
        records.push(record);
        parent = Some(uuid);
    };
    if from == 0 {
        add(
            &mut records,
            json!({ "type": "custom-title", "customTitle": "Large session" }),
        );
        add(
            &mut records,
            json!({ "type": "user", "message": { "role": "user", "content": "First prompt" } }),
        );
    }
    for i in 0..bulk {
        let id = format!("toolu_{from}_{i}");
        add(
            &mut records,
            json!({ "type": "assistant", "message": { "id": format!("msg_b{from}_{i}"), "role": "assistant",
            "content": [{ "type": "tool_use", "id": id, "name": "Bash", "input": { "command": "ls" } }],
            "usage": { "input_tokens": 1, "output_tokens": 2 } } }),
        );
        add(
            &mut records,
            json!({ "type": "user", "message": { "role": "user",
            "content": [{ "type": "tool_result", "tool_use_id": id, "content": "x".repeat(4096) }] } }),
        );
    }
    for i in 0..turns {
        add(
            &mut records,
            json!({ "type": "user", "message": { "role": "user", "content": format!("Prompt {from}-{i}") } }),
        );
        add(
            &mut records,
            json!({ "type": "assistant", "message": { "id": format!("msg_t{from}_{i}"), "role": "assistant",
            "content": [{ "type": "text", "text": format!("Answer {from}-{i}") }],
            "usage": { "input_tokens": 1, "output_tokens": 2 } } }),
        );
    }
    records
}

pub(crate) fn lines(records: &[Value]) -> Vec<u8> {
    records
        .iter()
        .map(|r| format!("{}\n", js::stringify(r)))
        .collect::<String>()
        .into_bytes()
}

pub(crate) struct Session {
    pub files: Arc<MemFiles>,
    pub handlers: AgentSessionHandlers,
}

pub(crate) fn fixture(bytes: Vec<u8>, store: Option<Arc<SessionIndexStore>>) -> Session {
    let files = MemFiles::new(bytes);
    let herdr = Arc::new(FixedHerdr(
        json!({ "agent": { "agent": "claude", "agent_session": { "kind": "path", "value": PATH } } }),
    ));
    let handlers = AgentSessionHandlers::new(
        herdr,
        files.clone(),
        Arc::new(ResolverContext::default()),
        store,
        Arc::new(js::now_ms),
    );
    Session { files, handlers }
}

impl Session {
    async fn history(&self, cursor: Value) -> Value {
        self.handlers
            .read_history(&json!({ "pane_id": "p", "history_version": 2, "cursor": cursor }))
            .await
            .map_err(|e| e.message)
            .unwrap()
    }
    async fn full(&self) -> crate::projection::Projection {
        let bytes = self.files.bytes.lock().unwrap().clone();
        let file = SessionFile {
            path: PATH.into(),
            mtime_ms: 1000.0 + bytes.len() as f64,
            size: Some(bytes.len() as f64),
            ..Default::default()
        };
        let whole = MemFiles::new(bytes);
        let whole = Arc::new(MemFiles {
            ranges: false,
            ..Arc::try_unwrap(whole).ok().unwrap()
        });
        read_session_projection("claude", &file, whole.as_ref(), None)
            .await
            .unwrap()
            .0
    }
    async fn summary(&self) -> Value {
        self.handlers
            .read_summary(&json!({ "pane_id": "p" }))
            .await
            .map_err(|e| e.message)
            .unwrap()
    }
    async fn whole_summary(&self) -> Value {
        for _ in 0..400 {
            let summary = self.summary().await;
            if summary.get("partial").is_none() {
                return summary;
            }
            tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        }
        panic!("the index never got ready");
    }
}

fn shape(entries: &[Value]) -> Vec<(String, String, String)> {
    entries
        .iter()
        .map(|e| {
            (
                js::sv(e.get("kind")).into(),
                js::sv(e.get("role")).into(),
                js::sv(e.get("text")).into(),
            )
        })
        .collect()
}

#[tokio::test]
async fn a_history_load_reads_the_end_of_the_file_not_all_of_it() {
    let session = fixture(lines(&transcript(1500, 300, 0)), None);
    assert!(session.files.bytes.lock().unwrap().len() as u64 > LARGE_SESSION_BYTES);
    let result = session.history(Value::Null).await;
    assert_eq!(session.files.whole_reads.load(Ordering::SeqCst), 0);
    assert!(session.files.take_range_bytes() < 1024 * 1024);
    assert_eq!(result["mode"], json!("snapshot"));
    let full = session.full().await;
    let expected: Vec<_> = shape(&full.entries)
        .into_iter()
        .map(|(k, r, t)| {
            let text = if r == "tool" { String::new() } else { t };
            (k, r, text)
        })
        .collect();
    assert_eq!(shape(result["entries"].as_array().unwrap()), expected);
}

#[tokio::test]
async fn appended_records_are_read_alone_and_sent_as_a_delta() {
    let session = fixture(lines(&transcript(1500, 300, 0)), None);
    let first = session.history(Value::Null).await;
    session.files.take_range_bytes();
    let more = lines(&transcript(0, 2, 1_000_000));
    session.files.append(&more);
    let next = session.history(first["cursor"].clone()).await;
    assert_eq!(session.files.take_range_bytes(), more.len() as u64);
    assert_eq!(next["mode"], json!("delta"));
    assert_eq!(next["cursor"]["epoch"], first["cursor"]["epoch"]);
    let texts: Vec<&str> = next["upserts"]
        .as_array()
        .unwrap()
        .iter()
        .map(|e| js::sv(e.get("text")))
        .collect();
    assert_eq!(
        texts,
        [
            "Prompt 1000000-0",
            "Answer 1000000-0",
            "Prompt 1000000-1",
            "Answer 1000000-1"
        ]
    );
    assert_eq!(session.files.whole_reads.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn a_replaced_transcript_starts_a_new_epoch() {
    let session = fixture(lines(&transcript(1500, 300, 0)), None);
    let first = session.history(Value::Null).await;
    session.files.replace(lines(&transcript(1400, 250, 0)));
    let next = session.history(first["cursor"].clone()).await;
    assert_eq!(next["mode"], json!("snapshot"));
    assert_ne!(next["cursor"]["epoch"], first["cursor"]["epoch"]);
}

#[tokio::test]
async fn the_summary_comes_from_an_index_streamed_in_chunks() {
    let session = fixture(lines(&transcript(1500, 300, 0)), None);
    let first = session.summary().await;
    assert_eq!(first["partial"], json!(true));
    let summary = session.whole_summary().await;
    assert_eq!(session.files.whole_reads.load(Ordering::SeqCst), 0);
    let full = session.full().await;
    assert_eq!(summary["title"], json!("Large session"));
    assert_eq!(summary["stats"], full.aggregates.stats);
    session.files.take_range_bytes();
    let more = lines(&transcript(0, 1, 2_000_000));
    session.files.append(&more);
    let next = session.summary().await;
    assert_eq!(
        next["stats"]["turns"].as_f64(),
        Some(full.aggregates.stats["turns"].as_f64().unwrap() + 1.0)
    );
    assert_eq!(session.files.take_range_bytes(), 2 * more.len() as u64);
}

#[tokio::test]
async fn a_restart_takes_the_index_from_disk_and_reads_only_what_was_appended() {
    let dir = tempfile::tempdir().unwrap();
    let store = || {
        Some(Arc::new(SessionIndexStore::new(
            Some(dir.path().to_path_buf()),
            "local",
        )))
    };
    let before = fixture(lines(&transcript(1500, 300, 0)), store());
    let full = before.whole_summary().await;
    for _ in 0..200 {
        if std::fs::read_dir(dir.path()).unwrap().count() >= 2 {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(5)).await;
    }
    let mut names: Vec<String> = std::fs::read_dir(dir.path())
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    names.sort();
    assert_eq!(names.len(), 2);
    assert!(names[0].ends_with(".json") && names[1].ends_with(".jsonl"));
    let more = lines(&transcript(0, 1, 2_000_000));
    let mut grown = before.files.bytes.lock().unwrap().clone();
    grown.extend_from_slice(&more);
    let after = fixture(grown, store());
    let first = after.summary().await;
    assert_eq!(first["partial"], json!(true));
    assert_eq!(first["title"], json!("Large session"));
    assert_eq!(first["stats"]["turns"], full["stats"]["turns"]);
    after.files.take_range_bytes();
    let next = after.whole_summary().await;
    assert_eq!(
        next["stats"]["turns"].as_f64(),
        Some(full["stats"]["turns"].as_f64().unwrap() + 1.0)
    );
    assert_eq!(next["title"], json!("Large session"));
    assert!(after.files.take_range_bytes() < more.len() as u64 + 16 * 1024);

    let idle = fixture(before.files.bytes.lock().unwrap().clone(), store());
    idle.files.take_range_bytes();
    let idle_first = idle.summary().await;
    assert!(idle_first.get("partial").is_none());
    assert_eq!(idle_first["stats"], full["stats"]);
    idle.handlers
        .read_tasks(&json!({ "pane_id": "p" }))
        .await
        .map_err(|e| e.message)
        .unwrap();
    assert_eq!(idle.files.take_range_bytes(), 0);

    let other = fixture(lines(&transcript(1500, 2, 0)), store());
    other.files.replace(lines(&transcript(1500, 2, 0)));
    let rebuilt = other.whole_summary().await;
    assert_eq!(rebuilt["stats"], other.full().await.aggregates.stats);
}

#[tokio::test]
async fn a_saved_index_that_no_longer_matches_its_file_is_dropped() {
    let dir = tempfile::tempdir().unwrap();
    let store = SessionIndexStore::new(Some(dir.path().to_path_buf()), "local");
    let bytes = lines(&transcript(10, 3, 0));
    let files = MemFiles::new(bytes.clone());
    let path = PATH;
    let records: Vec<crate::js::Obj> = vec![
        json!({ "type": "user" }).as_object().unwrap().clone(),
        json!({ "type": "assistant" }).as_object().unwrap().clone(),
    ];
    let len = bytes.len() as u64;
    store
        .save(files.as_ref(), path, Some("1"), len, 2, &records, None)
        .await
        .unwrap();
    let load = |identity: &'static str, size: u64, files: Arc<MemFiles>| {
        let dir = dir.path().to_path_buf();
        async move {
            SessionIndexStore::new(Some(dir), "local")
                .load(files.as_ref(), PATH, Some(identity), size)
                .await
        }
    };
    assert_eq!(
        load("1", len, files.clone()).await.unwrap().records,
        records
    );
    assert!(
        SessionIndexStore::new(Some(dir.path().to_path_buf()), "desktop")
            .load(files.as_ref(), path, Some("1"), len)
            .await
            .is_none()
    );
    assert!(load("1", len - 1, files.clone()).await.is_none());
    store
        .save(files.as_ref(), path, Some("1"), len, 2, &records, None)
        .await
        .unwrap();
    let mut rewritten = bytes.clone();
    let at = rewritten.len() - 2;
    rewritten[at] = 0x20;
    assert!(load("1", len, MemFiles::new(rewritten)).await.is_none());
    assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 0);
    store
        .save(files.as_ref(), path, Some("1"), len, 2, &records, None)
        .await
        .unwrap();
    let jsonl = std::fs::read_dir(dir.path())
        .unwrap()
        .map(|e| e.unwrap().path())
        .find(|p| p.extension().is_some_and(|x| x == "jsonl"))
        .unwrap();
    std::fs::write(
        &jsonl,
        "{\"type\":\"user\"}\n{\"type\":\"assistant\"}\n{\"ty",
    )
    .unwrap();
    assert_eq!(
        load("1", len, files.clone()).await.unwrap().records,
        records
    );
}

#[tokio::test]
async fn older_entries_are_read_a_page_at_a_time_when_asked() {
    let mut bytes = lines(&transcript(1100, 0, 0));
    bytes.extend(lines(&transcript(0, 1200, 5_000_000)));
    let padded = fixture(bytes, None);
    let first = padded.history(Value::Null).await;
    let first_read = padded.files.take_range_bytes();
    let oldest = first["entries"][0]["id"].clone();
    let page = padded
        .handlers
        .read_older(&json!({ "pane_id": "p", "before_id": oldest, "limit": 50 }))
        .await
        .map_err(|e| e.message)
        .unwrap();
    let texts: Vec<String> = page["entries"]
        .as_array()
        .unwrap()
        .iter()
        .map(|e| js::sv(e.get("text")).to_owned())
        .collect();
    let expected: Vec<String> = (1075..1100)
        .flat_map(|i| [format!("Prompt 5000000-{i}"), format!("Answer 5000000-{i}")])
        .collect();
    assert_eq!(texts, expected);
    assert_eq!(page["has_more"], json!(true));
    assert!(padded.files.take_range_bytes() < first_read + 1024 * 1024);
    assert_eq!(padded.files.whole_reads.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn reads_back_across_lines_split_by_chunk_boundaries() {
    let records = transcript(0, 400, 0);
    let bytes = lines(&records);
    let files = MemFiles::new(bytes.clone());
    let tail = read_tail_records(
        files.as_ref(),
        "",
        bytes.len() as u64,
        &|got| got.len() >= 100,
        Some(1000),
        None,
    )
    .await
    .unwrap();
    let got: Vec<Value> = tail.records.iter().cloned().map(Value::Object).collect();
    assert_eq!(
        got,
        records[records.len() - got.len()..]
            .iter()
            .map(|r| js::js_value(r.clone()))
            .collect::<Vec<_>>()
    );
    assert!(tail.records.len() >= 100);
    assert_eq!(tail.end, bytes.len() as u64);
    assert!(files.take_range_bytes() < bytes.len() as u64);
}

#[tokio::test]
async fn leaves_an_unfinished_last_line_for_later() {
    let mut bytes = lines(&transcript(0, 3, 0));
    bytes.extend_from_slice(b"{\"type\":\"user\"");
    let files = MemFiles::new(bytes.clone());
    let tail = read_tail_records(
        files.as_ref(),
        "",
        bytes.len() as u64,
        &|_| false,
        None,
        None,
    )
    .await
    .unwrap();
    assert_eq!(tail.records.len(), 8);
    assert_eq!(tail.end, (bytes.len() - "{\"type\":\"user\"".len()) as u64);
}

#[tokio::test]
async fn finds_a_record_s_line_from_the_end_decoding_only_matches() {
    let records = transcript(0, 2000, 0);
    let bytes = lines(&records);
    let files = MemFiles::new(bytes.clone());
    let mut seen: Vec<String> = Vec::new();
    let mut found = |text: &str| {
        seen.push(text.to_owned());
        (js::sv(js::parse(text).unwrap().get("uuid")) == "u3900").then(|| text.to_owned())
    };
    let line = find_line_from_end(
        files.as_ref(),
        "",
        bytes.len() as u64,
        &js::quote("u3900"),
        &mut found,
    )
    .await
    .unwrap()
    .unwrap();
    assert_eq!(
        js::parse(&line).unwrap(),
        js::js_value(records[3900].clone())
    );
    assert_eq!(seen.len(), 2);
    assert!(files.take_range_bytes() < bytes.len() as u64);
}

#[tokio::test]
async fn reaches_lines_at_the_file_s_start() {
    let bytes = lines(&transcript(0, 50, 0));
    let files = MemFiles::new(bytes.clone());
    let mut found = |text: &str| Some(text.to_owned());
    let line = find_line_from_end(
        files.as_ref(),
        "",
        bytes.len() as u64,
        "\"custom-title\"",
        &mut found,
    )
    .await
    .unwrap()
    .unwrap();
    assert_eq!(
        js::parse(&line).unwrap()["customTitle"],
        json!("Large session")
    );
}

#[tokio::test]
async fn a_rewind_s_scan_reads_the_slim_index_as_it_would_the_text() {
    use crate::rewind::{RewindScan, Transcript, scan_rewind};
    let mut records = transcript(1500, 3, 0);
    let prompt = records.iter().rev().find(|r| r["type"] == "user").unwrap()["uuid"].clone();
    records.push(json!({ "type": "file-history-snapshot", "messageId": prompt, "snapshot": {} }));
    records.push(json!({ "type": "assistant", "uuid": "edit", "parentUuid": prompt, "message": {
        "id": "msg_edit", "role": "assistant", "content": [{ "type": "tool_use", "id": "toolu_edit", "name": "Edit",
            "input": { "file_path": "/src/a.ts", "old_string": "a".repeat(9000) } }] } }));
    let bytes = lines(&records);
    let session = fixture(bytes.clone(), None);
    let slim = session.handlers.read_records(&json!({ "pane_id": "p" })).await.map_err(|e| e.message).unwrap().unwrap();
    assert_eq!(session.files.whole_reads.load(Ordering::SeqCst), 0);
    let uuid = prompt.as_str().unwrap();
    let from_slim = scan_rewind(Transcript::Records(slim), uuid);
    assert_eq!(from_slim, scan_rewind(Transcript::Text(&String::from_utf8(bytes).unwrap()), uuid));
    assert_eq!(from_slim, RewindScan { found: true, edited: vec!["/src/a.ts".into()], checkpoint: true });
}
