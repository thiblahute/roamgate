//! `session-rewind.ts`: a Claude transcript without the turns a rewind
//! left behind.

use std::collections::{HashMap, HashSet};

use serde_json::Value;

use crate::js::{self, Obj, sv};

/// What stands for a prompt of the user's a rewind cut.
pub const REWOUND_PROMPT: &str = "rewound-prompt";

fn is_prompt(record: Option<&Obj>) -> bool {
    let Some(record) = record else { return false };
    if sv(record.get("type")) != "user" || js::is_true(record.get("isMeta")) {
        return false;
    }
    match js::rec(record.get("message")).and_then(|m| m.get("content")) {
        Some(Value::String(_)) => true,
        Some(Value::Array(parts)) => {
            let parts: Vec<&Obj> = parts.iter().filter_map(Value::as_object).collect();
            parts.iter().any(|p| sv(p.get("type")) == "text")
                && !parts.iter().any(|p| sv(p.get("type")) == "tool_result")
        }
        _ => false,
    }
}

fn parent_of(record: &Obj) -> Option<&str> {
    let parent = match record.get("parentUuid") {
        None | Some(Value::Null) => record.get("logicalParentUuid"),
        other => other,
    };
    parent.and_then(Value::as_str)
}

/// The ids of the records a rewind undid.
pub fn rewound_record_ids(records: &[Obj]) -> HashSet<String> {
    let mut by_id: HashMap<&str, &Obj> = HashMap::new();
    let mut children: HashMap<&str, Vec<&Obj>> = HashMap::new();
    let mut leaf: Option<&str> = None;
    let mut cuts: Vec<&str> = Vec::new();
    for record in records {
        if sv(record.get("type")) == "last-prompt"
            && js::is_true(record.get("rewound"))
            && let Some(Value::String(cut)) = record.get("cutUuid")
        {
            cuts.push(cut);
        }
        let Some(Value::String(uuid)) = record.get("uuid") else {
            continue;
        };
        by_id.insert(uuid, record);
        leaf = Some(uuid);
        if let Some(parent) = parent_of(record).filter(|p| !p.is_empty()) {
            children.entry(parent).or_default().push(record);
        }
    }
    let mut line: Vec<&str> = Vec::new();
    let mut on_line: HashSet<&str> = HashSet::new();
    let mut at = leaf;
    while let Some(id) = at {
        if id.is_empty() || !on_line.insert(id) {
            break;
        }
        line.push(id);
        at = by_id.get(id).and_then(|r| parent_of(r));
    }
    let mut undone: HashSet<String> = HashSet::new();
    fn drop<'a>(
        record: &'a Obj,
        undone: &mut HashSet<String>,
        children: &HashMap<&str, Vec<&'a Obj>>,
    ) {
        let id = sv(record.get("uuid"));
        if !undone.insert(id.to_owned()) {
            return;
        }
        for child in children.get(id).into_iter().flatten() {
            drop(child, undone, children);
        }
    }
    for cut in cuts {
        if let Some(record) = by_id.get(cut) {
            drop(record, &mut undone, &children);
        }
    }
    for parent in &line {
        let siblings = children.get(parent).cloned().unwrap_or_default();
        let kept = siblings
            .iter()
            .find(|r| on_line.contains(sv(r.get("uuid"))))
            .copied();
        if !is_prompt(kept) {
            continue;
        }
        for record in siblings {
            if !std::ptr::eq(record, kept.unwrap()) && is_prompt(Some(record)) {
                drop(record, &mut undone, &children);
            }
        }
    }
    undone
}

/// The records without those a rewind undid.
pub fn without_rewound_turns(records: Vec<Obj>) -> Vec<Obj> {
    let undone = rewound_record_ids(&records);
    if undone.is_empty() {
        return records;
    }
    records
        .into_iter()
        .filter(|r| match r.get("uuid") {
            Some(Value::String(uuid)) => !undone.contains(uuid),
            _ => true,
        })
        .collect()
}

/// The records without those undone, each of the user's prompts among them
/// kept as a `REWOUND_PROMPT` stand-in.
pub fn kept_records(records: Vec<Obj>, rewound: Option<&HashSet<String>>) -> Vec<Obj> {
    let Some(rewound) = rewound.filter(|r| !r.is_empty()) else {
        return records;
    };
    let mut kept = Vec::with_capacity(records.len());
    for record in records {
        let cut = match record.get("uuid") {
            Some(Value::String(uuid)) => rewound.contains(uuid),
            _ => false,
        };
        if !cut {
            kept.push(record);
            continue;
        }
        if !is_prompt(Some(&record)) {
            continue;
        }
        let content = js::rec(record.get("message"))
            .and_then(|m| m.get("content"))
            .cloned();
        let mut stand_in = Obj::new();
        stand_in.insert("type".into(), Value::String(REWOUND_PROMPT.into()));
        js::put(&mut stand_in, "content", content);
        js::put(&mut stand_in, "timestamp", record.get("timestamp").cloned());
        js::put(&mut stand_in, "cutUuid", record.get("uuid").cloned());
        kept.push(stand_in);
    }
    kept
}

/// What a transcript says of the code a rewind to before `uuid` would
/// restore (`scanRewind`, the Claude driver's): whether the message is
/// there, the files Claude's file tools edited after it, and whether Claude
/// Code took a checkpoint of the code for it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RewindScan {
    pub found: bool,
    pub edited: Vec<String>,
    pub checkpoint: bool,
}

/// The transcript as its text, or its records (a large one's from its slim
/// index, which keeps what this reads).
pub enum Transcript<'a> {
    Text(&'a str),
    Records(Vec<Obj>),
}

const EDIT_TOOLS: [&str; 4] = ["Edit", "Write", "MultiEdit", "NotebookEdit"];

pub fn scan_rewind(transcript: Transcript<'_>, uuid: &str) -> RewindScan {
    let records: Vec<Obj> = match transcript {
        Transcript::Records(records) => records,
        Transcript::Text(text) => text
            .split('\n')
            .filter(|line| !js::trim(line).is_empty())
            .filter_map(|line| match js::parse(line) {
                Some(Value::Object(record)) => Some(record),
                _ => None,
            })
            .collect(),
    };
    let checkpoint = records.iter().any(|r| {
        js::str_of(r.get("type")) == Some("file-history-snapshot")
            && js::str_of(r.get("messageId")) == Some(uuid)
    });
    let kept = without_rewound_turns(records);
    let Some(at) = kept
        .iter()
        .position(|r| js::str_of(r.get("uuid")) == Some(uuid))
    else {
        return RewindScan {
            found: false,
            edited: Vec::new(),
            checkpoint,
        };
    };
    let mut edited: Vec<String> = Vec::new();
    for record in &kept[at + 1..] {
        if js::str_of(record.get("type")) != Some("assistant") {
            continue;
        }
        let Some(content) = js::rec(record.get("message"))
            .and_then(|m| m.get("content"))
            .and_then(Value::as_array)
        else {
            continue;
        };
        for block in content {
            let Some(block) = block.as_object() else {
                continue;
            };
            let Some(name) = js::str_of(block.get("name")) else {
                continue;
            };
            if js::str_of(block.get("type")) != Some("tool_use") || !EDIT_TOOLS.contains(&name) {
                continue;
            }
            let Some(input) = js::rec(block.get("input")) else {
                continue;
            };
            // `file_path ?? notebook_path`: a null file_path falls through.
            let path = match input.get("file_path") {
                None | Some(Value::Null) => input.get("notebook_path"),
                other => other,
            };
            if let Some(Value::String(path)) = path
                && !path.is_empty()
                && !edited.contains(path)
            {
                edited.push(path.clone());
            }
        }
    }
    RewindScan {
        found: true,
        edited,
        checkpoint,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{Value, json};

    fn rec(value: Value) -> Obj {
        value.as_object().unwrap().clone()
    }
    fn prompt(uuid: &str, parent: Option<&str>, text: &str) -> Obj {
        rec(
            json!({ "type": "user", "uuid": uuid, "parentUuid": parent, "message": { "role": "user", "content": text } }),
        )
    }
    fn reply(uuid: &str, parent: &str, text: &str) -> Obj {
        rec(
            json!({ "type": "assistant", "uuid": uuid, "parentUuid": parent, "message": { "role": "assistant", "content": [{ "type": "text", "text": text }] } }),
        )
    }
    fn tool_use(uuid: &str, parent: &str, id: &str) -> Obj {
        rec(
            json!({ "type": "assistant", "uuid": uuid, "parentUuid": parent, "message": { "role": "assistant", "content": [{ "type": "tool_use", "id": id, "name": "Bash", "input": {} }] } }),
        )
    }
    fn tool_result(uuid: &str, parent: &str, id: &str) -> Obj {
        rec(
            json!({ "type": "user", "uuid": uuid, "parentUuid": parent, "message": { "role": "user", "content": [{ "type": "tool_result", "tool_use_id": id, "content": "ok" }] } }),
        )
    }
    fn ids(records: &[Obj]) -> Vec<Option<String>> {
        records
            .iter()
            .map(|r| r.get("uuid").and_then(Value::as_str).map(str::to_owned))
            .collect()
    }
    fn some(ids: &[Option<&str>]) -> Vec<Option<String>> {
        ids.iter().map(|i| i.map(str::to_owned)).collect()
    }

    #[test]
    fn drops_the_turns_a_rewind_went_back_before() {
        let records = vec![
            prompt("u1", None, "write a.txt"),
            reply("a1", "u1", "done"),
            prompt("u2", Some("a1"), "write b.txt"),
            tool_use("t2", "u2", "call-2"),
            tool_result("r2", "t2", "call-2"),
            reply("a2", "r2", "done"),
            prompt("u3", Some("a2"), "third"),
            reply("a3", "u3", "third"),
            rec(json!({ "type": "last-prompt", "leafUuid": "a3" })),
            prompt("u4", Some("a1"), "gamma"),
            reply("a4", "u4", "gamma"),
        ];
        assert_eq!(
            ids(&without_rewound_turns(records)),
            some(&[Some("u1"), Some("a1"), None, Some("u4"), Some("a4")])
        );
    }

    #[test]
    fn keeps_the_results_of_tool_calls_run_side_by_side() {
        let records = vec![
            prompt("u1", None, "look"),
            tool_use("t1", "u1", "call-1"),
            tool_use("t2", "t1", "call-2"),
            tool_result("r1", "t1", "call-1"),
            tool_result("r2", "t2", "call-2"),
            reply("a1", "r2", "seen"),
            prompt("u2", Some("a1"), "next"),
        ];
        assert_eq!(without_rewound_turns(records.clone()), records);
    }

    #[test]
    fn leaves_what_came_before_a_compaction() {
        let records = vec![
            prompt("u1", None, "first"),
            reply("a1", "u1", "one"),
            rec(
                json!({ "type": "system", "subtype": "compact_boundary", "uuid": "c1", "parentUuid": null, "logicalParentUuid": "a1" }),
            ),
            prompt("u2", Some("c1"), "after"),
        ];
        assert_eq!(without_rewound_turns(records.clone()), records);
    }

    #[test]
    fn drops_what_a_rewind_recorded_as_cut_before_anything_is_sent() {
        let records = vec![
            prompt("u1", None, "first"),
            reply("a1", "u1", "one"),
            prompt("u2", Some("a1"), "second"),
            tool_use("t2", "u2", "call-2"),
            tool_result("r2", "t2", "call-2"),
            reply("a2", "r2", "two"),
            prompt("u3", Some("a2"), "third"),
            reply("a3", "u3", "three"),
            rec(
                json!({ "type": "last-prompt", "leafUuid": "a1", "explicit": true, "rewound": true, "cutUuid": "u2" }),
            ),
        ];
        assert_eq!(
            ids(&without_rewound_turns(records.clone())),
            some(&[Some("u1"), Some("a1"), None])
        );
        let mut more = records;
        more.push(prompt("u4", Some("a1"), "again"));
        more.push(reply("a4", "u4", "four"));
        assert_eq!(
            ids(&without_rewound_turns(more)),
            some(&[Some("u1"), Some("a1"), None, Some("u4"), Some("a4")])
        );
    }

    #[test]
    fn a_recorded_cut_naming_nothing_known_changes_nothing() {
        let records = vec![
            prompt("u1", None, "first"),
            reply("a1", "u1", "one"),
            rec(json!({ "type": "last-prompt", "rewound": true, "cutUuid": "gone" })),
        ];
        assert_eq!(without_rewound_turns(records.clone()), records);
    }
}
