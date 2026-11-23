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
