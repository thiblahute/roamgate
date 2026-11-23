//! server/src/agent/history-cursor.test.ts: the cursors of
//! agent_history.get on a real-shaped transcript, held to
//! contract/vectors/history-cursor.json with Bun's, so a cursor is the
//! file's in every process and on both sides.

use std::sync::Mutex as StdMutex;

use serde_json::{Map, json};

use super::*;
use crate::files::BoxFut;

const VECTORS: &str = include_str!("../../../../contract/vectors/history-cursor.json");
const FIXTURE: &str = include_str!("../../../../contract/vectors/session-rewind-fixture.json");

/// Ids a copy makes its own: `uuid`, `id` and `tool_use_id`, anywhere.
fn copied_ids(value: &Value, copy: u64) -> Value {
    match value {
        Value::Array(items) => Value::Array(items.iter().map(|i| copied_ids(i, copy)).collect()),
        Value::Object(map) => Value::Object(
            map.iter()
                .map(|(key, item)| {
                    let item = match item {
                        Value::String(text)
                            if ["uuid", "id", "tool_use_id"].contains(&key.as_str()) =>
                        {
                            Value::String(format!("{text}-{copy}"))
                        }
                        _ => copied_ids(item, copy),
                    };
                    (key.clone(), item)
                })
                .collect(),
        ),
        _ => value.clone(),
    }
}

/// The transcript a write describes (`transcriptOf`).
fn transcript_of(write: &Value) -> String {
    let fixture: Value = serde_json::from_str(FIXTURE).unwrap();
    let types: Option<Vec<&str>> = write["types"]
        .as_array()
        .map(|types| types.iter().filter_map(Value::as_str).collect());
    let records: Vec<&Value> = fixture["records"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|r| {
            types
                .as_ref()
                .is_none_or(|t| t.contains(&r["type"].as_str().unwrap_or("")))
        })
        .collect();
    let uuids: Vec<&str> = records.iter().filter_map(|r| r["uuid"].as_str()).collect();
    let last = records
        .iter()
        .rev()
        .find_map(|r| r["uuid"].as_str())
        .unwrap_or("");
    let suffixed = |uuid: &str, copy: u64| {
        if copy > 0 {
            format!("{uuid}-{copy}")
        } else {
            uuid.to_owned()
        }
    };
    let mut lines = Vec::new();
    for copy in 0..write["copies"].as_u64().unwrap() {
        for record in &records {
            let mut copied = if copy > 0 {
                copied_ids(record, copy)
            } else {
                (*record).clone()
            };
            if copy > 0
                && let Some(parent) = record["parentUuid"].as_str()
            {
                let parent = if uuids.contains(&parent) {
                    suffixed(parent, copy)
                } else {
                    suffixed(last, copy - 1)
                };
                copied["parentUuid"] = Value::String(parent);
            }
            lines.push(js::stringify(&copied));
        }
    }
    lines
        .iter()
        .take(write["lines"].as_u64().unwrap() as usize)
        .map(|line| format!("{line}\n"))
        .collect()
}

/// What a step's answer is compared by (`summary`).
fn summary(update: &Value) -> Value {
    let ids = |entries: &Value| {
        Value::Array(
            entries
                .as_array()
                .unwrap()
                .iter()
                .map(|e| {
                    json!(format!(
                        "{} {}",
                        e["id"].as_str().unwrap_or(""),
                        e["text_hash"].as_str().unwrap_or("")
                    ))
                })
                .collect(),
        )
    };
    if update["mode"] == "snapshot" {
        return json!({ "mode": "snapshot", "cursor": update["cursor"], "entries": ids(&update["entries"]) });
    }
    let mut out = Map::new();
    out.insert("mode".into(), update["mode"].clone());
    out.insert("cursor".into(), update["cursor"].clone());
    out.insert("base_revision".into(), update["base_revision"].clone());
    out.insert("upserts".into(), ids(&update["upserts"]));
    out.insert("removed".into(), update["removed"].clone());
    if let Some(order) = update.get("order") {
        out.insert("order".into(), order.clone());
    }
    Value::Object(out)
}

#[derive(Default)]
struct Bytes {
    bytes: Vec<u8>,
    file: Option<SessionFile>,
}

struct Memory(StdMutex<Bytes>);

impl Memory {
    fn bytes(&self) -> Vec<u8> {
        self.0.lock().unwrap().bytes.clone()
    }
}

impl SessionFiles for Memory {
    fn remote(&self) -> bool {
        false
    }
    fn stat_file<'a>(&'a self, _: &'a str) -> BoxFut<'a, io::Result<Option<SessionFile>>> {
        let file = self.0.lock().unwrap().file.clone();
        Box::pin(async move { Ok(file) })
    }
    fn read_text<'a>(&'a self, _: &'a str) -> BoxFut<'a, io::Result<String>> {
        let bytes = self.bytes();
        Box::pin(async move { Ok(String::from_utf8_lossy(&bytes).into_owned()) })
    }
    fn read_prefix<'a>(&'a self, _: &'a str, limit: u64) -> BoxFut<'a, io::Result<Vec<u8>>> {
        let bytes = self.bytes();
        Box::pin(async move { Ok(bytes[..bytes.len().min(limit as usize)].to_vec()) })
    }
    fn read_tail<'a>(&'a self, _: &'a str, limit: u64) -> BoxFut<'a, io::Result<Vec<u8>>> {
        let bytes = self.bytes();
        Box::pin(async move { Ok(bytes[bytes.len().saturating_sub(limit as usize)..].to_vec()) })
    }
    fn read_range<'a>(
        &'a self,
        _: &'a str,
        start: u64,
        end: u64,
    ) -> BoxFut<'a, io::Result<Vec<u8>>> {
        let bytes = self.bytes();
        Box::pin(async move {
            let end = (end as usize).min(bytes.len());
            let start = (start as usize).min(end);
            Ok(bytes[start..end].to_vec())
        })
    }
    fn read_download<'a>(&'a self, _: &'a str) -> BoxFut<'a, io::Result<Vec<u8>>> {
        let bytes = self.bytes();
        Box::pin(async move { Ok(bytes) })
    }
    fn find_pi_session_by_id<'a>(
        &'a self,
        _: &'a str,
    ) -> BoxFut<'a, io::Result<Option<SessionFile>>> {
        Box::pin(async { Ok(None) })
    }
    fn find_pi_session_for_cwd<'a>(
        &'a self,
        _: &'a str,
    ) -> BoxFut<'a, io::Result<Option<SessionFile>>> {
        Box::pin(async { Ok(None) })
    }
    fn find_claude_session_by_id<'a>(
        &'a self,
        _: &'a str,
    ) -> BoxFut<'a, io::Result<Option<SessionFile>>> {
        Box::pin(async { Ok(None) })
    }
    fn find_claude_successor<'a>(
        &'a self,
        _: &'a str,
        _: &'a str,
    ) -> BoxFut<'a, io::Result<Option<String>>> {
        Box::pin(async { Ok(None) })
    }
    fn find_codex_session_by_id<'a>(
        &'a self,
        _: &'a str,
    ) -> BoxFut<'a, io::Result<Option<SessionFile>>> {
        Box::pin(async { Ok(None) })
    }
}

#[tokio::test]
async fn history_cursors_are_the_file_s_as_bun_gives_them() {
    let vectors: Value = serde_json::from_str(VECTORS).unwrap();
    let path = vectors["path"].as_str().unwrap();
    for case in vectors["cases"].as_array().unwrap() {
        let memory = Arc::new(Memory(StdMutex::new(Bytes::default())));
        let files: Arc<dyn SessionFiles> = memory.clone();
        let mut caches: Vec<(String, Arc<ProjectionCache>)> = Vec::new();
        let mut cursors: Vec<(String, Value)> = Vec::new();
        for step in case["steps"].as_array().unwrap() {
            let name = step["as"].as_str().unwrap();
            if let Some(write) = step.get("write") {
                let bytes = transcript_of(write).into_bytes();
                let mut state = memory.0.lock().unwrap();
                state.file = Some(SessionFile {
                    path: path.into(),
                    mtime_ms: write["mtimeMs"].as_f64().unwrap(),
                    size: Some(bytes.len() as f64),
                    identity: write["identity"].as_str().map(str::to_owned),
                    change_token: write["changeToken"].as_str().map(str::to_owned),
                    ..Default::default()
                });
                state.bytes = bytes;
            }
            let cache_name = step["read"]["cache"].as_str().unwrap();
            let cache = match caches.iter().find(|(n, _)| n == cache_name) {
                Some((_, cache)) => cache.clone(),
                None => {
                    let cache = ProjectionCache::new(files.clone(), None);
                    caches.push((cache_name.to_owned(), cache.clone()));
                    cache
                }
            };
            let file = memory.0.lock().unwrap().file.clone();
            let mut resolved = Resolved::from_value(
                json!({
                    "agent": case["agent"],
                    "session": { "kind": "path", "value": path },
                })
                .as_object()
                .unwrap()
                .clone(),
            );
            resolved.file = file;
            let cursor = step["read"]["cursor"]
                .as_str()
                .and_then(|n| cursors.iter().find(|(c, _)| c == n).map(|(_, v)| v.clone()));
            let (_, update) = cache.history(&resolved, cursor.as_ref()).await.unwrap();
            cursors.push((name.to_owned(), update["cursor"].clone()));
            assert_eq!(summary(&update), step["expect"], "{}: {name}", case["name"]);
        }
    }
}
