//! What the Reviews author (history/mr-reviews.ts and history/format.ts's
//! stableJson): the `mr_reviews` keys the user and their agents write
//! (order, pins, removals, overrides, views, requests not proposed yet,
//! groups and workspaces headed upstream, efforts, merge rules; since
//! version 2 also the hosts, followed projects and hints) and each effort's
//! authored ledger with its history, as stable key-sorted JSON. Never
//! secrets, never derived data, never the Undo journal. The same code is
//! `roamgate reviews export|import` and `bridge.mr_reviews.export|import`.

use std::cmp::Ordering;
use std::collections::HashSet;
use std::io;
use std::path::Path;

use roamgate_agents::js::{self, Obj};
use roamgate_base::paths::DataContext;
use roamgate_base::secrets::without_secrets;
use serde_json::{Value, json};

use crate::efforts::empty_ledger;

pub const REVIEWS_EXPORT_FORMAT: &str = "roamgate-reviews";
pub const REVIEWS_EXPORT_VERSION: f64 = 3.0;

/// The authored keys of `mr_reviews` in settings.json.
pub const EXPORTED_KEYS: [&str; 14] = [
    "order",
    "pinned",
    "hidden",
    "overrides",
    "views",
    "unsent",
    "upstream_groups",
    "upstream_skip",
    "upstream_workspaces",
    "efforts",
    "merge",
    "hosts",
    "followed",
    "hints",
];

/// The export version each key arrived in: an older export says nothing of
/// a newer key, so importing it keeps the local value (never removes it).
fn key_since(key: &str) -> f64 {
    match key {
        "hosts" | "followed" | "hints" => 2.0,
        "upstream_workspaces" => 3.0,
        _ => 1.0,
    }
}

/// The keys an export of that version carries.
fn keys_of(version: f64) -> impl Iterator<Item = &'static str> {
    EXPORTED_KEYS
        .into_iter()
        .filter(move |key| key_since(key) <= version)
}

/// JavaScript's default string order (UTF-16 code units).
fn utf16_cmp(a: &str, b: &str) -> Ordering {
    a.encode_utf16().cmp(b.encode_utf16())
}

/// A copy of a value with every object's keys sorted (`sortedKeys`).
pub fn sorted_keys(value: &Value) -> Value {
    match value {
        Value::Array(items) => Value::Array(items.iter().map(sorted_keys).collect()),
        Value::Object(map) => {
            let mut keys: Vec<&String> = map.keys().collect();
            keys.sort_by(|a, b| utf16_cmp(a, b));
            Value::Object(
                keys.into_iter()
                    .map(|key| (key.clone(), sorted_keys(&map[key])))
                    .collect(),
            )
        }
        other => other.clone(),
    }
}

/// JSON with every object's keys sorted, two-space indent and one trailing
/// newline: the same state, the same text (`stableJson`).
pub fn stable_json(value: &Value) -> String {
    format!("{}\n", js::stringify_pretty(&sorted_keys(value)))
}

/// `/^[\w-]+$/`.
fn is_effort_id(id: &str) -> bool {
    !id.is_empty()
        && id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
}

/// What the Reviews authored, as exported (`ReviewsExport`). `efforts` maps
/// each effort's id to `{ledger, history}`.
#[derive(Debug, Clone, PartialEq)]
pub struct ReviewsExport {
    pub version: f64,
    pub exported_at: String,
    pub mr_reviews: Obj,
    pub efforts: Obj,
}

impl ReviewsExport {
    /// The export as JSON, in the key order Bun writes it.
    pub fn to_value(&self) -> Value {
        json!({
            "format": REVIEWS_EXPORT_FORMAT,
            "version": js::number(self.version),
            "exported_at": self.exported_at,
            "mr_reviews": self.mr_reviews,
            "efforts": self.efforts,
        })
    }

    /// `withoutSecrets` of the whole export, read back.
    fn without_secrets(&self) -> ReviewsExport {
        let clean = without_secrets(&self.to_value());
        let part = |key: &str| clean.get(key).and_then(Value::as_object).cloned();
        ReviewsExport {
            version: self.version,
            exported_at: js::sv(clean.get("exported_at")).to_owned(),
            mr_reviews: part("mr_reviews").unwrap_or_default(),
            efforts: part("efforts").unwrap_or_default(),
        }
    }

    /// An effort's ledger.
    pub fn ledger(&self, id: &str) -> Option<&Obj> {
        self.efforts.get(id)?.get("ledger")?.as_object()
    }

    /// An effort's history lines.
    pub fn history(&self, id: &str) -> &[Value] {
        self.efforts
            .get(id)
            .and_then(|effort| effort.get("history"))
            .and_then(Value::as_array)
            .map_or(&[], Vec::as_slice)
    }
}

/// A JSON file, or None when missing or unreadable (`readJson`).
fn read_json(path: &Path) -> Option<Value> {
    let text = std::fs::read_to_string(path).ok()?;
    js::parse(&text)
}

/// An effort's history.jsonl: the lines that are objects or arrays.
fn read_history(path: &Path) -> Vec<Value> {
    let Ok(text) = std::fs::read_to_string(path) else {
        return Vec::new();
    };
    text.split('\n')
        .filter(|line| !line.is_empty())
        .filter_map(js::parse)
        .filter(|value| value.is_object() || value.is_array())
        .collect()
}

/// `{ ...emptyLedger(), ...raw }` without its journal.
fn exported_ledger(raw: Option<&Value>) -> Obj {
    let mut ledger = empty_ledger();
    if let Some(raw) = raw.and_then(Value::as_object) {
        ledger = js::spread(ledger, raw);
    }
    js::delete(&mut ledger, "journal");
    ledger
}

/// What the Reviews authored, from settings.json's `mr_reviews` (as stored)
/// and the efforts' files under `efforts_root` (`<data>/mr-reviews/efforts`).
pub fn export_reviews(stored: Option<&Value>, efforts_root: &Path, now_ms: f64) -> ReviewsExport {
    let empty = Obj::new();
    let stored = stored.and_then(Value::as_object).unwrap_or(&empty);
    let mut mr_reviews = Obj::new();
    for key in EXPORTED_KEYS {
        if let Some(value) = stored.get(key) {
            mr_reviews.insert(key.into(), value.clone());
        }
    }
    let mut ids: Vec<String> = Vec::new();
    let mut seen = HashSet::new();
    for effort in stored
        .get("efforts")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        if let Some(id) = effort.get("id").and_then(Value::as_str)
            && seen.insert(id.to_owned())
        {
            ids.push(id.to_owned());
        }
    }
    // Ledgers of efforts no longer declared are kept too: declaring it
    // again finds it.
    if let Ok(entries) = std::fs::read_dir(efforts_root) {
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            if !name.starts_with('.') && is_effort_id(&name) && seen.insert(name.clone()) {
                ids.push(name);
            }
        }
    }
    ids.sort_by(|a, b| utf16_cmp(a, b));
    let mut efforts = Obj::new();
    for id in ids {
        let dir = efforts_root.join(&id);
        let raw = read_json(&dir.join("ledger.json")).filter(js_truthy);
        let history = read_history(&dir.join("history.jsonl"));
        if raw.is_none() && history.is_empty() {
            continue;
        }
        efforts.insert(
            id,
            json!({"ledger": exported_ledger(raw.as_ref()), "history": history}),
        );
    }
    ReviewsExport {
        version: REVIEWS_EXPORT_VERSION,
        exported_at: js::iso(now_ms),
        mr_reviews,
        efforts: js::js_value(Value::Object(efforts))
            .as_object()
            .cloned()
            .unwrap_or_default(),
    }
    .without_secrets()
}

/// A value JavaScript takes as true.
fn js_truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64().is_some_and(|n| n != 0.0 && !n.is_nan()),
        Value::String(s) => !s.is_empty(),
        Value::Array(_) | Value::Object(_) => true,
    }
}

/// An export read back, checked (`parseReviewsExport`); the error is the
/// message Bun throws.
pub fn parse_reviews_export(text: &str) -> Result<ReviewsExport, String> {
    let value = js::parse(text).ok_or("not JSON")?;
    if value.get("format").and_then(Value::as_str) != Some(REVIEWS_EXPORT_FORMAT) {
        return Err("not a Reviews export".into());
    }
    let version = match value.get("version") {
        Some(Value::Number(n)) => n.as_f64().filter(|v| *v <= REVIEWS_EXPORT_VERSION),
        _ => None,
    };
    let Some(version) = version else {
        let shown = value.get("version").map_or("undefined".into(), js::to_text);
        return Err(format!(
            "export version {shown} is newer than this Roamgate"
        ));
    };
    let incoming = match value.get("mr_reviews") {
        Some(found @ (Value::Object(_) | Value::Array(_))) => found,
        _ => return Err("no mr_reviews in the export".into()),
    };
    let entries: Vec<(String, Value)> = match value.get("efforts") {
        Some(Value::Object(map)) => map.iter().map(|(k, v)| (k.clone(), v.clone())).collect(),
        Some(Value::Array(items)) => items
            .iter()
            .enumerate()
            .map(|(index, v)| (index.to_string(), v.clone()))
            .collect(),
        Some(Value::String(text)) => text
            .encode_utf16()
            .enumerate()
            .map(|(index, unit)| {
                let unit = String::from_utf16_lossy(&[unit]);
                (index.to_string(), Value::String(unit))
            })
            .collect(),
        _ => Vec::new(),
    };
    let mut efforts = Obj::new();
    for (id, each) in entries {
        if !is_effort_id(&id) {
            return Err(format!("bad effort id {id}"));
        }
        let history = match each.get("history") {
            Some(Value::Array(items)) => items.clone(),
            _ => Vec::new(),
        };
        efforts.insert(
            id,
            json!({"ledger": exported_ledger(each.get("ledger")), "history": history}),
        );
    }
    let mut mr_reviews = Obj::new();
    if let Some(map) = incoming.as_object() {
        for key in EXPORTED_KEYS {
            if let Some(value) = map.get(key) {
                mr_reviews.insert(key.into(), value.clone());
            }
        }
    }
    let exported_at = match value.get("exported_at") {
        None | Some(Value::Null) => String::new(),
        Some(found) => js::to_text(found),
    };
    Ok(ReviewsExport {
        version,
        exported_at,
        mr_reviews,
        efforts,
    }
    .without_secrets())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ChangeKind {
    Added,
    Removed,
    Changed,
}

/// One item an import would change.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ImportChange {
    pub path: String,
    pub kind: ChangeKind,
    /// The local value was set after the imported one.
    pub newer_local: bool,
}

impl ImportChange {
    /// `{path, kind, newerLocal?}` as Bun answers it.
    pub fn to_value(&self) -> Value {
        let kind = match self.kind {
            ChangeKind::Added => "added",
            ChangeKind::Removed => "removed",
            ChangeKind::Changed => "changed",
        };
        let mut out = json!({"path": self.path, "kind": kind});
        if self.newer_local {
            out["newerLocal"] = Value::Bool(true);
        }
        out
    }
}

/// `String(value)`, undefined included.
fn text_of(value: Option<&Value>) -> String {
    value.map_or_else(|| "undefined".into(), js::to_text)
}

/// `a ?? b`: the value unless it is null or undefined.
fn present(value: Option<&Value>) -> Option<&Value> {
    value.filter(|value| !value.is_null())
}

/// The name of an item of a list, for a diff by item.
fn item_name(each: &Value, index: usize) -> String {
    if let Value::String(text) = each {
        return text.clone();
    }
    let Some(map) = each.as_object() else {
        return format!("#{index}");
    };
    if let Some(name) = present(map.get("id"))
        .or_else(|| present(map.get("key")))
        .or_else(|| present(map.get("name")))
    {
        return js::to_text(name);
    }
    let truthy = |key: &str| map.get(key).is_some_and(js_truthy);
    if truthy("provider") && truthy("project") && map.contains_key("number") {
        format!(
            "{}:{}/{}#{}",
            text_of(map.get("provider")),
            text_of(map.get("host")),
            text_of(map.get("project")),
            text_of(map.get("number"))
        )
    } else if truthy("provider") && truthy("project") {
        format!(
            "{}:{}/{}",
            text_of(map.get("provider")),
            text_of(map.get("host")),
            text_of(map.get("project"))
        )
    } else if truthy("provider") && truthy("host") {
        format!(
            "{}:{}",
            text_of(map.get("provider")),
            text_of(map.get("host"))
        )
    } else if truthy("connection_id") {
        let rest = present(map.get("path"))
            .or_else(|| present(map.get("label")))
            .map_or_else(String::new, js::to_text);
        format!("{}:{rest}", text_of(map.get("connection_id")))
    } else {
        format!("#{index}")
    }
}

/// The items of a value, by a stable name, added to `out` (`itemsOf`).
fn items_of(out: &mut Obj, path: &str, value: Option<&Value>) {
    match value {
        Some(Value::Array(items)) => {
            for (index, each) in items.iter().enumerate() {
                out.insert(format!("{path}[{}]", item_name(each, index)), each.clone());
            }
        }
        Some(Value::Object(map)) => {
            for (key, each) in map {
                out.insert(format!("{path}.{key}"), each.clone());
            }
        }
        Some(other) => {
            out.insert(path.to_owned(), other.clone());
        }
        None => {}
    }
}

/// When a value was set: its `at` when it is a string.
fn at_of(value: Option<&Value>) -> &str {
    value
        .and_then(Value::as_object)
        .and_then(|map| map.get("at"))
        .and_then(Value::as_str)
        .unwrap_or("")
}

/// An export flattened to its items, for a diff by item.
fn flat(state: &ReviewsExport, version: f64) -> Obj {
    let mut out = Obj::new();
    for key in keys_of(version) {
        let value = state.mr_reviews.get(key);
        if key == "order" {
            if let Some(value) = value {
                out.insert("mr_reviews.order".into(), value.clone());
            }
            continue;
        }
        items_of(&mut out, &format!("mr_reviews.{key}"), value);
    }
    for (id, effort) in &state.efforts {
        let base = format!("efforts.{id}");
        let ledger = effort.get("ledger");
        for part in ["entries", "matches", "plans", "aliases"] {
            items_of(
                &mut out,
                &format!("{base}.{part}"),
                ledger.and_then(|ledger| ledger.get(part)),
            );
        }
        let lines = state.history(id).len();
        if lines > 0 {
            out.insert(format!("{base}.history"), js::int(lines as i64));
        }
    }
    out
}

/// What importing would change, item by item: added, removed and changed
/// keys, each changed one flagged when the local value is the newer. The
/// order is one item (its arrangement as a whole).
pub fn import_changes(local: &ReviewsExport, incoming: &ReviewsExport) -> Vec<ImportChange> {
    let version = local.version.min(incoming.version);
    let mine = flat(local, version);
    let theirs = flat(incoming, version);
    let mut changes = Vec::new();
    for (path, value) in &theirs {
        let Some(local) = mine.get(path) else {
            changes.push(ImportChange {
                path: path.clone(),
                kind: ChangeKind::Added,
                newer_local: false,
            });
            continue;
        };
        if path.ends_with(".history") {
            // History is merged, never replaced: only new lines count.
            if js::to_number(Some(value)) > js::to_number(Some(local)) {
                changes.push(ImportChange {
                    path: path.clone(),
                    kind: ChangeKind::Changed,
                    newer_local: false,
                });
            }
        } else if stable_json(local) != stable_json(value) {
            let newer = utf16_cmp(at_of(Some(local)), at_of(Some(value))) == Ordering::Greater;
            changes.push(ImportChange {
                path: path.clone(),
                kind: ChangeKind::Changed,
                newer_local: newer,
            });
        }
    }
    for path in mine.keys() {
        if !theirs.contains_key(path) && !path.ends_with(".history") {
            changes.push(ImportChange {
                path: path.clone(),
                kind: ChangeKind::Removed,
                newer_local: false,
            });
        }
    }
    changes.sort_by(|a, b| js::locale_compare(&a.path, &b.path));
    changes
}

/// Applies an import to the efforts' files: each ledger replaced (its Undo
/// journal emptied, its version moved past the local one), each history
/// merged (lines not there yet appended). The settings part is the
/// caller's. Returns how many ledgers were written.
pub fn apply_ledgers(
    context: &DataContext,
    incoming: &ReviewsExport,
    efforts_root: &Path,
) -> io::Result<usize> {
    let mut written = 0;
    for (id, effort) in &incoming.efforts {
        let dir = efforts_root.join(id);
        let local = read_json(&dir.join("ledger.json"));
        let imported = effort
            .get("ledger")
            .and_then(Value::as_object)
            .cloned()
            .unwrap_or_default();
        let version_of = |value: Option<&Value>| match value {
            None | Some(Value::Null) => 0.0,
            found => js::to_number(found),
        };
        let version = version_of(local.as_ref().and_then(|local| local.get("version")))
            .max(version_of(imported.get("version")))
            + 1.0;
        let mut ledger = js::spread(empty_ledger(), &imported);
        ledger.insert("version".into(), js::number(version));
        ledger.insert("journal".into(), json!([]));
        context.replace_data_file(
            &dir.join("ledger.json"),
            format!("{}\n", js::stringify(&Value::Object(ledger))).as_bytes(),
            0o600,
        )?;
        let path = dir.join("history.jsonl");
        let have: HashSet<String> = read_history(&path).iter().map(stable_json).collect();
        let add: Vec<String> = incoming
            .history(id)
            .iter()
            .filter(|line| !have.contains(&stable_json(line)))
            .map(js::stringify)
            .collect();
        if !add.is_empty() {
            let before = std::fs::read_to_string(&path).unwrap_or_default();
            context.replace_data_file(
                &path,
                format!("{before}{}\n", add.join("\n")).as_bytes(),
                0o600,
            )?;
        }
        written += 1;
    }
    Ok(written)
}

/// settings.json's `mr_reviews` with the imported authored keys (others
/// kept), its order_version moved on so pages read the inbox again.
pub fn imported_mr_reviews(stored: Option<&Value>, incoming: &ReviewsExport) -> Obj {
    let mut next = stored
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    for key in keys_of(incoming.version) {
        match incoming.mr_reviews.get(key) {
            None => js::delete(&mut next, key),
            Some(value) => {
                next.insert(key.into(), value.clone());
            }
        }
    }
    let previous = match stored.and_then(|stored| stored.get("order_version")) {
        Some(Value::Number(n)) => n.as_f64().unwrap_or(0.0),
        _ => 0.0,
    };
    next.insert("order_version".into(), js::number(previous + 1.0));
    next
}

#[cfg(test)]
mod tests;
