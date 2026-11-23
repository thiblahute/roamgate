//! `session-compaction.ts`: whether a session was compacted since a time.

use serde_json::Value;

use crate::js::{self, Obj};

/// How much of a transcript's end is read: a compaction is recent.
pub const COMPACTION_TAIL_BYTES: u64 = 512 * 1024;

fn is_compaction(record: &Obj) -> bool {
    if js::is_true(record.get("isCompactSummary")) {
        return true;
    }
    let kind = js::sv(record.get("type"));
    if kind == "compacted" || kind == "compaction" {
        return true;
    }
    kind == "system" && js::sv(record.get("subtype")) == "compact_boundary"
}

/// Whether the transcript's end holds a compaction stamped after `since`.
pub fn compacted_since(tail: &str, since: &str) -> bool {
    let since_ms = js::date_parse(since);
    for line in tail.split('\n').rev() {
        let line = js::trim(line);
        if !line.starts_with('{') {
            continue;
        }
        let Some(Value::Object(fields)) = js::parse(line) else {
            continue;
        };
        let stamp = js::sv(fields.get("timestamp"));
        if !stamp.is_empty() && js::date_parse(stamp) <= since_ms {
            return false;
        }
        if is_compaction(&fields) && !stamp.is_empty() {
            return true;
        }
    }
    false
}
