//! Changes between two versions of a JSON state object (shared/stateDelta.ts
//! `diffState`), as a small payload: the top-level fields that changed,
//! and, for a field that is a list of objects with unique string ids
//! (`id`, or another `*_id` field all its items share), the order of all
//! ids, the items that are new, and for an item that changed, its own
//! changes, found the same way. The page applies it with the TS
//! `applyStateDelta`; `contract/vectors/state-delta.json` holds both.

use std::collections::{HashMap, HashSet};

use serde_json::{Map, Value, json};

const ID_FIELDS: &[&str] = &[
    "id",
    "connection_id",
    "workspace_id",
    "tab_id",
    "pane_id",
    "session_id",
];

/// The field identifying every item of a list, and the ids in order.
fn ids_of(list: &Value, only: Option<&str>) -> Option<(String, Vec<String>)> {
    let Value::Array(items) = list else {
        return None;
    };
    if items.is_empty() {
        return only.map(|by| (by.to_owned(), Vec::new()));
    }
    let candidates: Vec<&str> = match only {
        Some(by) => vec![by],
        None => ID_FIELDS.to_vec(),
    };
    'fields: for by in candidates {
        let mut seen = HashSet::new();
        let mut order = Vec::new();
        for item in items {
            let Some(id) = item.as_object().and_then(|item| item.get(by)?.as_str()) else {
                continue 'fields;
            };
            if !seen.insert(id) {
                continue 'fields;
            }
            order.push(id.to_owned());
        }
        return Some((by.to_owned(), order));
    }
    None
}

/// `diffState(base, next)`: None when nothing changed.
pub fn diff_state(base: &Map<String, Value>, next: &Map<String, Value>) -> Option<Value> {
    let mut set = Map::new();
    let mut unset = Vec::new();
    let mut lists = Map::new();
    for key in base.keys() {
        if !next.contains_key(key) {
            unset.push(Value::String(key.clone()));
        }
    }
    for (key, value) in next {
        let before = base.get(key).unwrap_or(&Value::Null);
        if base.contains_key(key) && before == value {
            continue;
        }
        let now = ids_of(value, None);
        let then = now
            .as_ref()
            .and_then(|(by, _)| ids_of(before, Some(by)).filter(|_| base.contains_key(key)));
        if let (Some((by, order)), Some((_, then_order))) = (now, then) {
            let old: HashMap<&str, &Map<String, Value>> = before
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|item| {
                    let item = item.as_object()?;
                    Some((item.get(&by)?.as_str()?, item))
                })
                .collect();
            let mut upsert = Vec::new();
            let mut patch = Map::new();
            for item in value.as_array().into_iter().flatten() {
                let Some(record) = item.as_object() else {
                    continue;
                };
                let id = record.get(&by).and_then(Value::as_str).unwrap_or("");
                match old.get(id) {
                    None => upsert.push(item.clone()),
                    Some(was) if *was != record => {
                        if let Some(inner) = diff_state(was, record) {
                            patch.insert(id.to_owned(), inner);
                        }
                    }
                    Some(_) => {}
                }
            }
            if !upsert.is_empty() || !patch.is_empty() || order != then_order {
                let mut list = Map::new();
                list.insert("by".into(), json!(by));
                list.insert("order".into(), json!(order));
                list.insert("upsert".into(), Value::Array(upsert));
                if !patch.is_empty() {
                    list.insert("patch".into(), Value::Object(patch));
                }
                lists.insert(key.clone(), Value::Object(list));
            }
            continue;
        }
        if !base.contains_key(key) || before != value {
            set.insert(key.clone(), value.clone());
        }
    }
    if set.is_empty() && unset.is_empty() && lists.is_empty() {
        return None;
    }
    Some(json!({ "set": set, "unset": unset, "lists": lists }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::vectors;

    /// A vector's value with its `$text` runs written out.
    fn plain(value: &Value) -> Value {
        if let Some(text) = vectors::tag(value)
            .filter(|(name, _)| *name == "$text")
            .and_then(|_| vectors::text(value))
        {
            return Value::String(text);
        }
        match value {
            Value::Array(items) => Value::Array(items.iter().map(plain).collect()),
            Value::Object(map) => Value::Object(
                map.iter()
                    .map(|(key, value)| (key.clone(), plain(value)))
                    .collect(),
            ),
            other => other.clone(),
        }
    }

    #[test]
    fn diff_state_matches_the_vectors() {
        let file = vectors::load("state-delta");
        let mut checked = 0;
        for case in &file.cases {
            for call in &case.calls {
                if call.target() != "stateDelta.diffState" {
                    continue;
                }
                let base = plain(&call.args[0]);
                let next = plain(&call.args[1]);
                let got = diff_state(base.as_object().unwrap(), next.as_object().unwrap())
                    .unwrap_or(Value::Null);
                let want = plain(call.result.as_ref().unwrap_or(&Value::Null));
                assert_eq!(got, want, "{}", case.title());
                checked += 1;
            }
        }
        assert!(checked >= 3);
    }
}
