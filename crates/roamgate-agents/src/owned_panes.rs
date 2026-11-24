//! Herdr's view of the panes conversation mode holds
//! (agent/agent-sessions.ts `overlayOwnedPanes`): while a pane's holder
//! runs, its claude is headless and Herdr knows no agent there (or the
//! holder's child, idle with no session), so the pane is shown as the
//! Claude pane it is. An owned pane is conversation mode's record of it:
//! `pane_id`, `session_id`, `cwd`, `agent_status?`, `phase?`, `agent?`.

use std::collections::{HashMap, HashSet};

use serde_json::{Map, Value, json};

fn text<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    value.get(key).and_then(Value::as_str)
}

fn owned_agent_session(owned: &Value) -> Value {
    json!({
        "source": "roamgate:headless",
        "agent": text(owned, "agent").unwrap_or("claude"),
        "kind": "id",
        "value": owned.get("session_id").cloned().unwrap_or(Value::Null),
    })
}

/// Whether what Herdr says of the pane is still the terminal claude's:
/// only while a takeover starts, and only with the session Herdr got from
/// it.
fn herdr_still_right(pane: &Map<String, Value>, owned: &Value) -> bool {
    if text(owned, "phase") != Some("to_conversation") {
        return false;
    }
    if !pane
        .get("agent")
        .and_then(Value::as_str)
        .is_some_and(|agent| !agent.is_empty())
    {
        return false;
    }
    pane.get("agent_session")
        .and_then(Value::as_object)
        .is_some_and(|session| session.get("value") == owned.get("session_id"))
}

fn overlay_pane(pane: Map<String, Value>, owned: &Value) -> Map<String, Value> {
    if herdr_still_right(&pane, owned) {
        return pane;
    }
    let mut pane = pane;
    pane.insert(
        "agent".into(),
        json!(text(owned, "agent").unwrap_or("claude")),
    );
    pane.insert(
        "agent_status".into(),
        json!(text(owned, "agent_status").unwrap_or("idle")),
    );
    pane.insert("agent_session".into(), owned_agent_session(owned));
    pane.insert(
        "foreground_cwd".into(),
        owned.get("cwd").cloned().unwrap_or(Value::Null),
    );
    pane
}

/// What Herdr says of panes and agents (`method`'s answer), with the
/// panes conversation mode holds shown as the Claude panes they are.
pub fn overlay_owned_panes(
    method: &str,
    params: Option<&Value>,
    result: Value,
    owned: &[Value],
) -> Value {
    if owned.is_empty() {
        return result;
    }
    let by_pane: HashMap<&str, &Value> = owned
        .iter()
        .filter_map(|each| Some((text(each, "pane_id")?, each)))
        .collect();
    let empty = Map::new();
    let record = result.as_object().unwrap_or(&empty);
    let over = |item: &Value| -> Value {
        let Some(object) = item.as_object() else {
            return item.clone();
        };
        let Some(pane) = object.get("pane_id").and_then(Value::as_str) else {
            return item.clone();
        };
        match by_pane.get(pane) {
            Some(mine) => Value::Object(overlay_pane(object.clone(), mine)),
            None => item.clone(),
        }
    };
    match method {
        "agent.get" => {
            let pane_id = params
                .and_then(|params| params.get("target"))
                .and_then(Value::as_str)
                .unwrap_or("");
            let Some(mine) = by_pane.get(pane_id) else {
                return result;
            };
            let mut agent = record
                .get("agent")
                .and_then(Value::as_object)
                .cloned()
                .unwrap_or_default();
            agent.insert("pane_id".into(), json!(pane_id));
            let mut out = record.clone();
            out.insert("agent".into(), Value::Object(overlay_pane(agent, mine)));
            Value::Object(out)
        }
        "agent.list" => {
            let Some(agents) = record.get("agents").and_then(Value::as_array) else {
                return result;
            };
            let listed: HashSet<&str> = agents
                .iter()
                .filter_map(|agent| agent.get("pane_id").and_then(Value::as_str))
                .collect();
            let mut all: Vec<Value> = agents.iter().map(over).collect();
            for each in owned {
                let Some(pane_id) = text(each, "pane_id") else {
                    continue;
                };
                if !listed.contains(pane_id) {
                    let mut pane = Map::new();
                    pane.insert("pane_id".into(), json!(pane_id));
                    all.push(Value::Object(overlay_pane(pane, each)));
                }
            }
            let mut out = record.clone();
            out.insert("agents".into(), Value::Array(all));
            Value::Object(out)
        }
        "pane.list" => match record.get("panes").and_then(Value::as_array) {
            Some(panes) => {
                let mut out = record.clone();
                out.insert(
                    "panes".into(),
                    Value::Array(panes.iter().map(over).collect()),
                );
                Value::Object(out)
            }
            None => result,
        },
        "pane.get" => match record.get("pane").filter(|pane| pane.is_object()) {
            Some(pane) => {
                let mut out = record.clone();
                out.insert("pane".into(), over(pane));
                Value::Object(out)
            }
            None => result,
        },
        _ => result,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_held_pane_is_shown_as_its_claude_and_a_missing_one_is_listed() {
        let owned = vec![json!({"pane_id": "p1", "session_id": "s1", "cwd": "/w"})];
        let listed = overlay_owned_panes(
            "agent.list",
            None,
            json!({"agents": [{"pane_id": "p0", "agent": "codex"}]}),
            &owned,
        );
        assert_eq!(
            listed,
            json!({"agents": [
                {"pane_id": "p0", "agent": "codex"},
                {"pane_id": "p1", "agent": "claude", "agent_status": "idle",
                 "agent_session": {"source": "roamgate:headless", "agent": "claude", "kind": "id", "value": "s1"},
                 "foreground_cwd": "/w"},
            ]})
        );
        let got = overlay_owned_panes(
            "agent.get",
            Some(&json!({"target": "p1"})),
            json!({}),
            &owned,
        );
        assert_eq!(got["agent"]["agent_status"], "idle");
        assert_eq!(got["agent"]["pane_id"], "p1");
    }

    #[test]
    fn herdr_stays_right_while_a_takeover_starts_with_its_session() {
        let owned = vec![json!({
            "pane_id": "p1", "session_id": "s1", "cwd": "/w", "phase": "to_conversation",
        })];
        let pane = json!({"panes": [{"pane_id": "p1", "agent": "claude",
            "agent_status": "working", "agent_session": {"value": "s1"}}]});
        assert_eq!(
            overlay_owned_panes("pane.list", None, pane.clone(), &owned),
            pane
        );
    }
}
