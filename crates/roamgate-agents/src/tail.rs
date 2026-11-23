//! `session-tail.ts`: large transcripts read by their end, and the slim
//! index of everything that needs the whole session.

use std::io;
use std::sync::LazyLock;

use regex::Regex;
use serde_json::Value;

use crate::files::SessionFiles;
use crate::js::{self, Obj, sv};

/// From this size on, a transcript is read by its end and an index.
pub const LARGE_SESSION_BYTES: u64 = 4 * 1024 * 1024;
const FIRST_TAIL_BYTES: u64 = 512 * 1024;
/// The most a history reads back for its window.
pub const MAX_TAIL_BYTES: u64 = 64 * 1024 * 1024;
const INDEX_CHUNK_BYTES: u64 = 4 * 1024 * 1024;
/// Appended bytes past this read the end again instead.
pub const MAX_APPEND_BYTES: u64 = 16 * 1024 * 1024;
const UNREAD_TYPES: [&str; 3] = ["api-request", "api-request-blob", "api-request-shape"];

fn parse_line(bytes: &[u8]) -> Option<Obj> {
    if bytes.is_empty() {
        return None;
    }
    let text = String::from_utf8_lossy(bytes);
    if js::trim(&text).is_empty() {
        return None;
    }
    match js::parse(&text) {
        Some(Value::Object(record)) => Some(record),
        _ => None,
    }
}

/// The records of whole lines, and how many bytes those lines take.
pub fn parse_whole_lines(bytes: &[u8]) -> (Vec<Obj>, usize) {
    let mut records = Vec::new();
    let mut start = 0;
    while let Some(offset) = bytes[start..].iter().position(|&b| b == b'\n') {
        let newline = start + offset;
        if let Some(record) = parse_line(&bytes[start..newline]) {
            records.push(record);
        }
        start = newline + 1;
    }
    (records, start)
}

/// What the end of a transcript read.
#[derive(Debug, Clone)]
pub struct TailRead {
    pub records: Vec<Obj>,
    pub start: u64,
    pub end: u64,
    pub bytes_read: u64,
}

/// Reads a transcript backwards from `size` until `enough` says the
/// records cover what is shown, the start is reached or `max_bytes` read.
pub async fn read_tail_records(
    files: &dyn SessionFiles,
    path: &str,
    size: u64,
    enough: &(dyn Fn(&[Obj]) -> bool + Send + Sync),
    first_bytes: Option<u64>,
    max_bytes: Option<u64>,
) -> io::Result<TailRead> {
    let max_bytes = max_bytes.unwrap_or(MAX_TAIL_BYTES);
    let mut chunk = first_bytes.unwrap_or(FIRST_TAIL_BYTES);
    loop {
        let mut from = size.saturating_sub(chunk);
        let mut bytes = files.read_range(path, from, size).await?;
        let mut bytes_read = bytes.len() as u64;
        let last_newline = bytes.iter().rposition(|&b| b == b'\n');
        let Some(last_newline) = last_newline.or(if from > 0 { None } else { Some(usize::MAX) })
        else {
            chunk *= 2;
            continue;
        };
        // At the file's start with no newline: no whole line (end at 0).
        let (end, keep) = if last_newline == usize::MAX {
            (from, 0)
        } else {
            (from + last_newline as u64 + 1, last_newline + 1)
        };
        bytes.truncate(keep);
        let mut records: Vec<Obj> = Vec::new();
        loop {
            let line_start = if from > 0 {
                bytes
                    .iter()
                    .position(|&b| b == b'\n')
                    .map_or(bytes.len(), |n| n + 1)
            } else {
                0
            };
            let (parsed, _) = parse_whole_lines(&bytes[line_start..]);
            let mut joined = parsed;
            joined.extend(records);
            records = joined;
            let carry = bytes[..line_start].to_vec();
            let start = from + line_start as u64;
            let at_start = from == 0;
            if at_start || enough(&records) || bytes_read >= max_bytes {
                return Ok(TailRead {
                    records,
                    start: if at_start { 0 } else { start },
                    end,
                    bytes_read,
                });
            }
            chunk *= 2;
            let earlier = from.saturating_sub(chunk);
            let mut before = files.read_range(path, earlier, from).await?;
            bytes_read += before.len() as u64;
            before.extend_from_slice(&carry);
            bytes = before;
            from = earlier;
        }
    }
}

fn ends(text: &str, each: usize) -> String {
    if js::len16(text) > 2 * each {
        format!(
            "{}\n\u{2026}\n{}",
            js::head16(text, each),
            js::slice16(text, -(each as i64), None)
        )
    } else {
        text.to_owned()
    }
}

fn slim_text(text: &str, user: bool) -> String {
    static NOTICE: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"<task-notification>|<teammate-message ").unwrap());
    if NOTICE.is_match(text) {
        text.to_owned()
    } else {
        js::head16(text, if user { 64_000 } else { 120 })
    }
}

fn content_text(content: Option<&Value>) -> String {
    match content {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Array(parts)) => parts
            .iter()
            .map(|p| js::sv(p.as_object().and_then(|p| p.get("text"))).to_owned())
            .collect::<Vec<_>>()
            .join("\n"),
        _ => String::new(),
    }
}

const TOOL_INPUT_KEYS: [&str; 13] = [
    "description",
    "name",
    "subagent_type",
    "command",
    "run_in_background",
    "task_id",
    "shell_id",
    "to",
    "action",
    "asset",
    "title",
    "file_path",
    "notebook_path",
];

fn slim_part(part: &Value, user: bool) -> Value {
    let Value::Object(map) = part else {
        return part.clone();
    };
    let mut out = Obj::new();
    match sv(map.get("type")) {
        "text" => {
            out.insert("type".into(), Value::String("text".into()));
            let text = match map.get("text") {
                Some(Value::String(t)) => slim_text(t, user),
                _ => String::new(),
            };
            out.insert("text".into(), Value::String(text));
        }
        "tool_use" => {
            let mut input = Obj::new();
            if let Some(Value::Object(given)) = map.get("input") {
                for key in TOOL_INPUT_KEYS {
                    if let Some(value) = given.get(key) {
                        let value = match value {
                            Value::String(s) => Value::String(js::head16(s, 2000)),
                            other => other.clone(),
                        };
                        input.insert(key.into(), value);
                    }
                }
            }
            out.insert("type".into(), Value::String("tool_use".into()));
            js::put(&mut out, "id", map.get("id").cloned());
            js::put(&mut out, "name", map.get("name").cloned());
            out.insert("input".into(), Value::Object(input));
        }
        "tool_result" => {
            out.insert("type".into(), Value::String("tool_result".into()));
            js::put(&mut out, "tool_use_id", map.get("tool_use_id").cloned());
            js::put(&mut out, "is_error", map.get("is_error").cloned());
            out.insert(
                "content".into(),
                Value::String(ends(&content_text(map.get("content")), 1000)),
            );
        }
        _ => {
            js::put(&mut out, "type", map.get("type").cloned());
        }
    }
    Value::Object(out)
}

const RECORD_KEYS: [&str; 14] = [
    "type",
    "cwd",
    "content",
    "uuid",
    "parentUuid",
    "logicalParentUuid",
    "isMeta",
    "isCompactSummary",
    "rewound",
    "cutUuid",
    "timestamp",
    "customTitle",
    "aiTitle",
    "usage",
];

/// A Claude record as the index keeps it, or None for one nothing reads.
pub fn slim_record(record: &Obj) -> Option<Obj> {
    let kind = record.get("type").and_then(Value::as_str);
    if kind.is_some_and(|k| UNREAD_TYPES.contains(&k)) {
        return None;
    }
    if kind == Some("file-history-snapshot") {
        let mut out = Obj::new();
        out.insert("type".into(), Value::String("file-history-snapshot".into()));
        js::put(&mut out, "messageId", record.get("messageId").cloned());
        return Some(out);
    }
    let mut slim = Obj::new();
    for key in RECORD_KEYS {
        if let Some(value) = record.get(key) {
            slim.insert(key.into(), value.clone());
        }
    }
    if let Some(Value::Object(result)) = record.get("toolUseResult") {
        let mut kept = Obj::new();
        for (key, value) in result {
            match value {
                Value::Object(_) | Value::Array(_) => {}
                Value::String(s) => {
                    kept.insert(key.clone(), Value::String(js::head16(s, 600)));
                }
                other => {
                    kept.insert(key.clone(), other.clone());
                }
            }
        }
        slim.insert("toolUseResult".into(), Value::Object(kept));
    }
    if let Some(Value::Object(attachment)) = record.get("attachment") {
        let value = match sv(attachment.get("type")) {
            "skill_listing" => attachment.clone(),
            "queued_command" => {
                let mut out = attachment.clone();
                out.insert(
                    "prompt".into(),
                    Value::String(slim_text(&content_text(attachment.get("prompt")), true)),
                );
                out
            }
            _ => {
                let mut out = Obj::new();
                js::put(&mut out, "type", attachment.get("type").cloned());
                out
            }
        };
        slim.insert("attachment".into(), Value::Object(value));
    }
    if let Some(Value::Object(message)) = record.get("message") {
        let user = kind == Some("user");
        let content = match message.get("content") {
            Some(Value::String(text)) => Some(Value::String(slim_text(text, user))),
            Some(Value::Array(parts)) => Some(Value::Array(
                parts.iter().map(|p| slim_part(p, user)).collect(),
            )),
            other => other.cloned(),
        };
        let mut out = Obj::new();
        js::put(&mut out, "role", message.get("role").cloned());
        js::put(&mut out, "id", message.get("id").cloned());
        js::put(&mut out, "usage", message.get("usage").cloned());
        js::put(&mut out, "content", content);
        slim.insert("message".into(), Value::Object(out));
    }
    Some(slim)
}

/// Every record of a transcript, slimmed, built once and then only from
/// what was appended.
#[derive(Debug, Clone, Default)]
pub struct SlimIndex {
    pub path: String,
    pub records: Vec<Obj>,
    pub parsed: usize,
    pub end: u64,
    carry: Vec<u8>,
}

impl SlimIndex {
    pub fn new(path: &str) -> Self {
        Self {
            path: path.to_owned(),
            ..Default::default()
        }
    }

    /// Starts from an index saved earlier (before any update only).
    pub fn restore(&mut self, records: Vec<Obj>, parsed: usize, end: u64) {
        if self.end > 0 || !self.records.is_empty() {
            return;
        }
        self.records = records;
        self.parsed = parsed;
        self.end = end;
    }

    /// Reads on to `size`.
    pub async fn update(&mut self, files: &dyn SessionFiles, size: u64) -> io::Result<()> {
        while self.end + (self.carry.len() as u64) < size {
            let from = self.end + self.carry.len() as u64;
            let to = size.min(from + INDEX_CHUNK_BYTES);
            let chunk = files.read_range(&self.path, from, to).await?;
            if chunk.is_empty() {
                break;
            }
            let mut bytes = std::mem::take(&mut self.carry);
            bytes.extend_from_slice(&chunk);
            let (records, used) = parse_whole_lines(&bytes);
            for record in records {
                self.parsed += 1;
                if let Some(slim) = slim_record(&record) {
                    self.records.push(slim);
                }
            }
            self.end += used as u64;
            self.carry = bytes[used..].to_vec();
        }
        Ok(())
    }
}

fn last_index_of(haystack: &[u8], needle: &[u8], before: usize) -> Option<usize> {
    if needle.is_empty() || haystack.len() < needle.len() {
        return None;
    }
    let mut at = before.min(haystack.len() - needle.len());
    loop {
        if &haystack[at..at + needle.len()] == needle {
            return Some(at);
        }
        if at == 0 {
            return None;
        }
        at -= 1;
    }
}

/// The lines holding `needle`, newest first, read from the end a chunk at
/// a time, until `found` takes one.
pub async fn find_line_from_end<T>(
    files: &dyn SessionFiles,
    path: &str,
    size: u64,
    needle: &str,
    found: &mut (dyn FnMut(&str) -> Option<T> + Send),
) -> io::Result<Option<T>> {
    let pattern = needle.as_bytes();
    let mut to = size;
    let mut carry: Vec<u8> = Vec::new();
    let mut chunk = FIRST_TAIL_BYTES;
    while to > 0 {
        let from = to.saturating_sub(chunk);
        let mut bytes = files.read_range(path, from, to).await?;
        bytes.extend_from_slice(&carry);
        let first = if from > 0 {
            bytes.iter().position(|&b| b == b'\n').map_or(0, |n| n + 1)
        } else {
            0
        };
        if from > 0 && first == 0 {
            carry = bytes;
            to = from;
            chunk *= 2;
            continue;
        }
        let mut at = last_index_of(&bytes, pattern, usize::MAX);
        while let Some(position) = at {
            if position < first {
                break;
            }
            let start = bytes[..position]
                .iter()
                .rposition(|&b| b == b'\n')
                .map_or(0, |n| n + 1);
            let end = bytes[position..]
                .iter()
                .position(|&b| b == b'\n')
                .map_or(bytes.len(), |n| position + n);
            if let Some(value) = found(&String::from_utf8_lossy(&bytes[start..end])) {
                return Ok(Some(value));
            }
            at = if start > 0 {
                last_index_of(&bytes, pattern, start - 1)
            } else {
                None
            };
        }
        carry = bytes[..first].to_vec();
        to = from;
        chunk = (chunk * 2).min(MAX_APPEND_BYTES);
    }
    Ok(None)
}
