//! What the user (or an agent session) sets by hand on one of their
//! requests (`mr-reviews/overrides.ts`): whose move, next step, what it
//! waits for, labels, a link, stale. settings.json keeps them
//! (`mr_reviews.overrides`), normalised by `roamgate-base`'s settings
//! sections; this is what changes them and how they age.

use std::sync::LazyLock;

use regex::Regex;
use roamgate_agents::js::{self, Obj};
use serde_json::{Value, json};

pub const FIELDS: [&str; 6] = ["whose", "next", "dependsOn", "labels", "link", "stale"];
pub const NEXT_MAX: usize = 200;
pub const LABELS_MAX: usize = 10;
pub const LABEL_MAX: usize = 40;
pub const LINK_MAX: usize = 1000;
pub const DEPENDS_MAX: usize = 20;

static PERSON: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^[A-Za-z0-9_.-]{1,80}$").expect("pattern"));
static SPACES: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\s+").expect("pattern"));

fn whose_of(value: Option<&Value>) -> Option<Value> {
    match value? {
        Value::String(s) if s == "me" || s == "reviewer" || s == "external" => Some(json!(s)),
        Value::Object(o) => {
            let person = o.get("person")?.as_str()?;
            let person = person.strip_prefix('@').unwrap_or(person);
            PERSON.is_match(person).then(|| json!({"person": person}))
        }
        _ => None,
    }
}

fn text_of(value: Option<&Value>, max: usize) -> Option<String> {
    let text = value?.as_str()?;
    let text = js::head16(js::trim(&SPACES.replace_all(text, " ")), max);
    (!text.is_empty()).then_some(text)
}

/// Labels: trimmed, capped, unique case-insensitively.
pub fn labels_of(value: Option<&Value>) -> Option<Vec<String>> {
    let items = value?.as_array()?;
    let mut seen: Vec<String> = Vec::new();
    let mut out = Vec::new();
    for each in items.iter().filter_map(Value::as_str) {
        let label = js::head16(js::trim(&SPACES.replace_all(each, " ")), LABEL_MAX);
        let key = label.to_lowercase();
        if label.is_empty() || seen.contains(&key) {
            continue;
        }
        seen.push(key);
        out.push(label);
    }
    out.truncate(LABELS_MAX);
    (!out.is_empty()).then_some(out)
}

fn keys_of(value: Option<&Value>) -> Option<Vec<String>> {
    let items = value?.as_array()?;
    let mut out: Vec<String> = Vec::new();
    for each in items.iter().filter_map(Value::as_str) {
        if !each.is_empty() && js::len16(each) <= 600 && !out.iter().any(|o| o == each) {
            out.push(each.to_owned());
        }
    }
    out.truncate(DEPENDS_MAX);
    (!out.is_empty()).then_some(out)
}

/// A change of an override: fields set (a `set` object, as the RPC gives
/// it), fields cleared (`None`: none; `Some(None)`: all).
#[derive(Clone, Debug, Default)]
pub struct Change {
    pub set: Obj,
    pub clear: Option<Option<Vec<String>>>,
}

impl Change {
    /// `{set?, clear?: [...] | "all"}`.
    pub fn from_json(value: &Value) -> Change {
        let clear = match value.get("clear") {
            Some(Value::String(s)) if s == "all" => Some(None),
            Some(Value::Array(items)) => Some(Some(
                items
                    .iter()
                    .filter_map(Value::as_str)
                    .map(str::to_owned)
                    .collect(),
            )),
            _ => None,
        };
        Change {
            set: value
                .get("set")
                .and_then(Value::as_object)
                .cloned()
                .unwrap_or_default(),
            clear,
        }
    }
}

/// Who changed an override, when, and the request's activity marker then.
#[derive(Clone, Debug)]
pub struct Meta<'a> {
    pub by: &'a str,
    pub at: &'a str,
    pub marker: &'a str,
}

fn has_field(value: &Obj) -> bool {
    FIELDS
        .iter()
        .any(|f| value.get(*f).is_some_and(|v| !v.is_null()))
}

/// The override after a change, checked and capped; None when no field is left.
pub fn apply_override(current: Option<&Obj>, change: &Change, meta: &Meta) -> Option<Obj> {
    let mut next = match current {
        Some(current) => current.clone(),
        None => {
            let mut o = Obj::new();
            o.insert("at".into(), json!(meta.at));
            o.insert("by".into(), json!(meta.by));
            o.insert("marker".into(), json!(meta.marker));
            o
        }
    };
    match &change.clear {
        Some(None) => FIELDS.iter().for_each(|f| js::delete(&mut next, f)),
        Some(Some(fields)) => fields.iter().for_each(|f| {
            if FIELDS.contains(&f.as_str()) {
                js::delete(&mut next, f)
            }
        }),
        None => {}
    }
    let set = &change.set;
    let mut assign = |name: &str, value: Option<Value>| match value {
        Some(value) => {
            next.insert(name.into(), value);
        }
        None => js::delete(&mut next, name),
    };
    if set.contains_key("whose") {
        assign("whose", whose_of(set.get("whose")));
    }
    if set.contains_key("next") {
        assign(
            "next",
            text_of(set.get("next"), NEXT_MAX).map(Value::String),
        );
    }
    if set.contains_key("dependsOn") {
        assign("dependsOn", keys_of(set.get("dependsOn")).map(|k| json!(k)));
    }
    if set.contains_key("labels") {
        assign("labels", labels_of(set.get("labels")).map(|k| json!(k)));
    }
    if set.contains_key("link") {
        assign(
            "link",
            text_of(set.get("link"), LINK_MAX).map(Value::String),
        );
    }
    if set.contains_key("stale") {
        assign(
            "stale",
            set.get("stale").filter(|v| v.is_boolean()).cloned(),
        );
    }
    if !has_field(&next) {
        return None;
    }
    next.insert("at".into(), json!(meta.at));
    next.insert("by".into(), json!(meta.by));
    if set.contains_key("whose")
        || set.contains_key("next")
        || set.contains_key("stale")
        || current.is_none()
    {
        next.insert("marker".into(), json!(meta.marker));
    }
    Some(next)
}

/// Whose-move, the next step or stale were set before the request moved on.
pub fn override_outdated(value: &Obj, marker: &str) -> bool {
    let marked = js::sv(value.get("marker"));
    ["whose", "next", "stale"]
        .iter()
        .any(|f| value.contains_key(*f))
        && !marked.is_empty()
        && marked != marker
}

/// Two overrides hold the same fields (the time and author aside).
pub fn same_override(a: Option<&Obj>, b: Option<&Obj>) -> bool {
    let strip = |value: Option<&Obj>| {
        value.map_or(String::new(), |v| {
            js::stringify(&Value::Array(
                FIELDS
                    .iter()
                    .map(|f| v.get(*f).cloned().unwrap_or(Value::Null))
                    .collect(),
            ))
        })
    };
    strip(a) == strip(b)
}

/// Renames a request's key in the overrides, and in what others wait for.
pub fn rename_override_keys(overrides: &Obj, from: &str, to: &str) -> Obj {
    let mut out = Obj::new();
    for (key, value) in overrides {
        let mut value = value.clone();
        if let Some(depends) = value.get("dependsOn").and_then(Value::as_array)
            && depends.iter().any(|d| d.as_str() == Some(from))
        {
            let mut renamed: Vec<Value> = Vec::new();
            for each in depends {
                let each = if each.as_str() == Some(from) {
                    json!(to)
                } else {
                    each.clone()
                };
                if !renamed.contains(&each) {
                    renamed.push(each);
                }
            }
            value["dependsOn"] = Value::Array(renamed);
        }
        out.insert(
            if key == from {
                to.to_owned()
            } else {
                key.clone()
            },
            value,
        );
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    const META: Meta = Meta {
        by: "user",
        at: "2026-11-16T10:00:00Z",
        marker: "m1",
    };

    fn change(value: Value) -> Change {
        Change::from_json(&value)
    }

    #[test]
    fn fields_are_set_capped_and_cleared_an_empty_override_goes() {
        let first = apply_override(
            None,
            &change(json!({"set": {
                "whose": "reviewer",
                "next": format!("  {}  ", "x".repeat(300)),
                "labels": ["infra", "INFRA", "", "a".repeat(60)],
                "link": "https://notes.example/plan",
            }})),
            &META,
        )
        .unwrap();
        assert_eq!(first["whose"], json!("reviewer"));
        assert_eq!(js::sv(first.get("next")).len(), 200);
        assert_eq!(first["labels"], json!(["infra", "a".repeat(40)]));
        assert_eq!(first["marker"], json!("m1"));
        let m2 = Meta {
            marker: "m2",
            ..META
        };
        let second = apply_override(
            Some(&first),
            &change(json!({"set": {"labels": ["x"]}})),
            &m2,
        )
        .unwrap();
        assert_eq!(second["marker"], json!("m1"));
        assert_eq!(second["labels"], json!(["x"]));
        let m3 = Meta {
            marker: "m3",
            ..META
        };
        assert_eq!(
            apply_override(
                Some(&second),
                &change(json!({"set": {"next": "ping"}})),
                &m3
            )
            .unwrap()["marker"],
            json!("m3")
        );
        assert!(
            !apply_override(
                Some(&second),
                &change(json!({"clear": ["whose", "next"]})),
                &META
            )
            .unwrap()
            .contains_key("whose")
        );
        assert!(apply_override(Some(&second), &change(json!({"clear": "all"})), &META).is_none());
        assert!(
            apply_override(
                Some(&second),
                &change(json!({"clear": ["whose", "next", "labels", "link"]})),
                &META
            )
            .is_none()
        );
    }

    #[test]
    fn whose_move_and_next_step_age_with_the_request_labels_never() {
        let set = apply_override(
            None,
            &change(json!({"set": {"next": "wait", "labels": ["l"]}})),
            &META,
        )
        .unwrap();
        assert!(!override_outdated(&set, "m1"));
        assert!(override_outdated(&set, "m2"));
        let labels =
            apply_override(None, &change(json!({"set": {"labels": ["l"]}})), &META).unwrap();
        assert!(!override_outdated(&labels, "m2"));
    }

    #[test]
    fn renaming_a_key_follows_into_other_rows_dependencies() {
        let overrides = json!({
            "old": {"next": "x", "at": "t", "by": "user", "marker": "m"},
            "other": {"dependsOn": ["old", "new"], "at": "t", "by": "user", "marker": "m"},
        });
        let out = rename_override_keys(overrides.as_object().unwrap(), "old", "new");
        let mut keys: Vec<&String> = out.keys().collect();
        keys.sort();
        assert_eq!(keys, ["new", "other"]);
        assert_eq!(out["other"]["dependsOn"], json!(["new"]));
    }

    #[test]
    fn people_are_checked_and_overrides_compare_by_fields() {
        let a = apply_override(
            None,
            &change(json!({"set": {"whose": {"person": "@bob"}}})),
            &META,
        )
        .unwrap();
        assert_eq!(a["whose"], json!({"person": "bob"}));
        assert!(
            apply_override(
                None,
                &change(json!({"set": {"whose": {"person": "two words"}}})),
                &META
            )
            .is_none()
        );
        let b = apply_override(
            None,
            &change(json!({"set": {"whose": {"person": "bob"}}})),
            &Meta {
                by: "agent",
                ..META
            },
        )
        .unwrap();
        assert!(same_override(Some(&a), Some(&b)));
        assert!(!same_override(Some(&a), None));
    }
}
