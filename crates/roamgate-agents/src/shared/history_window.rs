//! `shared/agentHistory.ts`: the window both sides cut a History to.

use serde_json::Value;

use crate::js;

/// The window counts conversation entries only (messages and errors); tool
/// entries ride along with the ones that survive the cut.
pub fn history_window_entries(entries: &[Value], limit: f64) -> Vec<Value> {
    let mut remaining = limit.floor().max(1.0) as i64;
    let mut start = entries.len();
    while start > 0 && remaining > 0 {
        start -= 1;
        if js::sv(entries[start].get("role")) != "tool" {
            remaining -= 1;
        }
    }
    entries[start..].to_vec()
}
