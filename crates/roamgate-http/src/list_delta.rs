//! Topology lists (workspaces, tabs, panes, agents) answered as changes
//! (bridge/list-delta.ts).
//!
//! A page reads the four lists again on every burst of Herdr events, each
//! whole: on a busy desktop that is megabytes a minute, too much for a
//! slow mobile link. A page that understands deltas sends the stamp of the
//! list it holds (`since`); when the bridge still knows that version for
//! this socket, it answers with the items that changed and the order of
//! all ids, and the page rebuilds the list. Anything else gets the whole
//! list, stamped.
//!
//! The stamp is opaque to the page and only ever compared with stamps the
//! same socket was given: Rust hashes with xxh3 where Bun used `Bun.hash`,
//! both written in base 36.

use std::collections::HashMap;

use serde_json::{Map, Value, json};

/// Each list's array and the field that identifies its items.
pub fn shape_of(method: &str) -> Option<(&'static str, &'static str)> {
    match method {
        "workspace.list" => Some(("workspaces", "workspace_id")),
        "tab.list" => Some(("tabs", "tab_id")),
        "pane.list" => Some(("panes", "pane_id")),
        "agent.list" => Some(("agents", "pane_id")),
        _ => None,
    }
}

/// Versions kept per list and socket: an answer lost on the way still has its base.
const KEPT_VERSIONS: usize = 2;

#[derive(Debug, Clone)]
struct Version {
    stamp: String,
    items: HashMap<String, String>,
}

fn base36(mut value: u64) -> String {
    if value == 0 {
        return "0".into();
    }
    let digits = b"0123456789abcdefghijklmnopqrstuvwxyz";
    let mut out = Vec::new();
    while value > 0 {
        out.push(digits[(value % 36) as usize]);
        value /= 36;
    }
    out.reverse();
    String::from_utf8(out).unwrap()
}

/// The versions one browser socket was given; dropped with the socket.
#[derive(Debug, Default)]
pub struct ListDeltas {
    versions: HashMap<String, Vec<Version>>,
}

impl ListDeltas {
    pub fn new() -> Self {
        Self::default()
    }

    /// The answer to a list read: a delta from `since` when this socket
    /// was given that version, else the whole result with its stamp.
    pub fn reply(&mut self, key: &str, method: &str, result: Value, since: &Value) -> Value {
        let Some((array, id_field)) = shape_of(method) else {
            return result;
        };
        let Value::Object(record) = &result else {
            return result;
        };
        let Some(Value::Array(list)) = record.get(array) else {
            return result;
        };
        let mut items: HashMap<String, String> = HashMap::new();
        let mut order: Vec<String> = Vec::new();
        let mut texts: Vec<String> = Vec::new();
        for item in list {
            let id = item.get(id_field).and_then(Value::as_str);
            // An item without an id, or one listed twice, cannot be patched.
            let Some(id) = id.filter(|id| !items.contains_key(*id)) else {
                return result;
            };
            let text = item.to_string();
            items.insert(id.to_owned(), text.clone());
            texts.push(text);
            order.push(id.to_owned());
        }
        let rest: Map<String, Value> = record
            .iter()
            .filter(|(field, _)| field.as_str() != array)
            .map(|(field, value)| (field.clone(), value.clone()))
            .collect();
        let stamp = base36(xxhash_rust::xxh3::xxh3_64(
            json!([rest, order, texts]).to_string().as_bytes(),
        ));
        let slot = format!("{key}\0{method}");
        let kept = self.versions.remove(&slot).unwrap_or_default();
        let base = since
            .as_str()
            .and_then(|since| kept.iter().find(|version| version.stamp == since))
            .cloned();
        let mut next = vec![Version {
            stamp: stamp.clone(),
            items: items.clone(),
        }];
        next.extend(kept.into_iter().filter(|version| version.stamp != stamp));
        next.truncate(KEPT_VERSIONS);
        self.versions.insert(slot, next);
        let Some(base) = base else {
            let mut whole = record.clone();
            whole.insert("list_stamp".into(), Value::String(stamp));
            return Value::Object(whole);
        };
        let upsert: Vec<Value> = order
            .iter()
            .enumerate()
            .filter(|(_, id)| base.items.get(*id) != items.get(*id))
            .map(|(index, _)| list[index].clone())
            .collect();
        json!({
            "list_delta": {
                "base": base.stamp,
                "stamp": stamp,
                "array": array,
                "id": id_field,
                "rest": rest,
                "order": order,
                "upsert": upsert,
            }
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn panes(entries: &[(&str, &str)]) -> Value {
        json!({
            "type": "pane_list",
            "panes": entries
                .iter()
                .map(|(pane_id, status)| json!({"pane_id": pane_id, "status": status}))
                .collect::<Vec<_>>(),
        })
    }

    #[test]
    fn a_list_read_with_the_stamp_the_socket_was_given_answers_the_changes() {
        let mut deltas = ListDeltas::new();
        let first = deltas.reply(
            "desktop",
            "pane.list",
            panes(&[("p1", "idle"), ("p2", "idle")]),
            &Value::Null,
        );
        assert_eq!(first["panes"].as_array().unwrap().len(), 2);
        let stamp = first["list_stamp"].as_str().unwrap().to_owned();
        let next = deltas.reply(
            "desktop",
            "pane.list",
            panes(&[("p2", "working"), ("p3", "idle")]),
            &Value::String(stamp.clone()),
        );
        let delta = &next["list_delta"];
        assert_eq!(delta["base"], stamp.as_str());
        assert_eq!(delta["array"], "panes");
        assert_eq!(delta["id"], "pane_id");
        assert_eq!(delta["rest"], json!({"type": "pane_list"}));
        assert_eq!(delta["order"], json!(["p2", "p3"]));
        assert_eq!(
            delta["upsert"],
            json!([{"pane_id": "p2", "status": "working"}, {"pane_id": "p3", "status": "idle"}])
        );
        assert!(delta["stamp"].as_str().is_some_and(|next| next != stamp));
        // The older version is still kept: an answer lost on the way.
        let again = deltas.reply(
            "desktop",
            "pane.list",
            panes(&[("p2", "working")]),
            &Value::String(stamp),
        );
        assert!(again.get("list_delta").is_some());
    }

    #[test]
    fn an_unknown_stamp_another_socket_or_another_list_gets_the_whole_list() {
        let mut deltas = ListDeltas::new();
        let first = deltas.reply("desktop", "pane.list", panes(&[("p1", "a")]), &Value::Null);
        let stamp = first["list_stamp"].clone();
        let mut other_socket = ListDeltas::new();
        let reply = other_socket.reply("desktop", "pane.list", panes(&[("p1", "a")]), &stamp);
        assert!(reply.get("list_delta").is_none());
        assert!(reply["list_stamp"].is_string());
        let reply = deltas.reply(
            "desktop",
            "tab.list",
            json!({"tabs": [{"tab_id": "t1"}]}),
            &stamp,
        );
        assert!(reply.get("list_delta").is_none());
        assert!(reply["list_stamp"].is_string());
        let reply = deltas.reply("laptop", "pane.list", panes(&[("p1", "a")]), &stamp);
        assert!(reply.get("list_delta").is_none());
        // Items without ids cannot be patched: the result goes as it is.
        let odd = json!({"panes": [{"status": "x"}]});
        assert_eq!(
            deltas.reply("desktop", "pane.list", odd.clone(), &Value::Null),
            odd
        );
        let twice = panes(&[("p1", "a"), ("p1", "b")]);
        assert_eq!(
            deltas.reply("desktop", "pane.list", twice.clone(), &Value::Null),
            twice
        );
        assert_eq!(
            deltas.reply("desktop", "session.get", json!({"x": 1}), &Value::Null),
            json!({"x": 1})
        );
    }
}
