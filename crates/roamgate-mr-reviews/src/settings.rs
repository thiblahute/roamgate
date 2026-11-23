//! The reviews settings in effect and as settings.json keeps them
//! (`mrReviewsSettings`, `storedMrReviews`, `mergeSettingsOf` and
//! `storedMergeOf` of `mr-reviews/settings.ts`). What settings.json holds
//! is checked by `roamgate-base`'s `normalize_stored_mr_reviews`, the one
//! writer's normaliser; this turns it into the camelCase settings the
//! inbox and the web read, and back. Both are JavaScript objects with
//! Bun's key order.

use roamgate_agents::js::Obj;
use serde_json::{Value, json};

use crate::shared::merge::{RULE_KEYS, stored_key};

pub use roamgate_base::settings::sections::normalize_stored_mr_reviews;

/// `DEFAULT_MR_REVIEWS_SETTINGS.inference`.
pub const DEFAULT_INFERENCE: bool = true;
/// `DEFAULT_MR_REVIEWS_SETTINGS.inferenceHours`.
pub const DEFAULT_INFERENCE_HOURS: f64 = 12.0;
/// `DEFAULT_MR_REVIEWS_SETTINGS.staleDays`.
pub const DEFAULT_STALE_DAYS: f64 = 90.0;

/// `DEFAULT_MR_REVIEWS_SETTINGS` (shared/mrReviews.ts), in its key order.
pub fn default_settings() -> Obj {
    let Value::Object(out) = json!({
        "hosts": [],
        "followed": [],
        "checkout": "immediately",
        "retentionDays": 3,
        "curation": true,
        "inference": DEFAULT_INFERENCE,
        "inferenceHours": 12,
        "inferenceModel": "",
        "suggestDays": 30,
        "hints": "",
        "treeGroups": {},
        "clones": {},
        "order": [],
        "pinned": [],
        "hidden": [],
        "overrides": {},
        "staleDays": 90,
        "views": [],
        "upstreamGroups": [],
        "upstreamSkip": [],
        "upstreamWorkspaces": [],
        "unsent": [],
        "efforts": [],
        "merge": { "scopes": {} },
        "panel": { "search": "", "filter": "all", "at": "" },
        "homePrompt": "",
    }) else {
        unreachable!()
    };
    out
}

fn obj(value: Option<&Value>) -> Option<&Obj> {
    value.and_then(Value::as_object)
}

fn truthy(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) => false,
        Some(Value::Bool(b)) => *b,
        Some(Value::Number(n)) => n.as_f64().is_some_and(|n| n != 0.0 && !n.is_nan()),
        Some(Value::String(s)) => !s.is_empty(),
        Some(_) => true,
    }
}

fn non_empty_list(value: Option<&Value>) -> bool {
    value
        .and_then(Value::as_array)
        .is_some_and(|items| !items.is_empty())
}

fn from_stored_lists(lists: &Obj) -> Obj {
    let mut out = Obj::new();
    for key in RULE_KEYS {
        if let Some(list) = lists.get(stored_key(key))
            && truthy(Some(list))
        {
            out.insert(key.into(), list.clone());
        }
    }
    out
}

fn to_stored_lists(lists: &Obj) -> Obj {
    let mut out = Obj::new();
    for key in RULE_KEYS {
        if let Some(list) = lists.get(key)
            && truthy(Some(list))
        {
            out.insert(stored_key(key).into(), list.clone());
        }
    }
    out
}

/// `mergeSettingsOf`: the merge settings in effect.
pub fn merge_settings_of(stored: Option<&Obj>) -> Obj {
    let empty = Obj::new();
    let stored = stored.unwrap_or(&empty);
    let mut out = from_stored_lists(stored);
    let scopes: Obj = obj(stored.get("scopes"))
        .map(|scopes| {
            scopes
                .iter()
                .map(|(scope, lists)| {
                    let lists = obj(Some(lists)).cloned().unwrap_or_default();
                    (scope.clone(), Value::Object(from_stored_lists(&lists)))
                })
                .collect()
        })
        .unwrap_or_default();
    out.insert("scopes".into(), Value::Object(scopes));
    out
}

/// `storedMergeOf`: as settings.json keeps them; None when all default.
pub fn stored_merge_of(merge: Option<&Obj>) -> Option<Obj> {
    let merge = merge?;
    let mut out = to_stored_lists(merge);
    let scopes: Obj = obj(merge.get("scopes"))
        .map(|scopes| {
            scopes
                .iter()
                .filter_map(|(scope, lists)| {
                    let lists = to_stored_lists(obj(Some(lists))?);
                    (!lists.is_empty()).then(|| (scope.clone(), Value::Object(lists)))
                })
                .collect()
        })
        .unwrap_or_default();
    if !scopes.is_empty() {
        out.insert("scopes".into(), Value::Object(scopes));
    }
    (!out.is_empty()).then_some(out)
}

/// The fields an override has besides `at`, `by` and `marker`: stored name, settings name.
const OVERRIDE_FIELDS: [(&str, &str); 6] = [
    ("whose", "whose"),
    ("next", "next"),
    ("depends_on", "dependsOn"),
    ("labels", "labels"),
    ("link", "link"),
    ("stale", "stale"),
];

fn convert_override(value: &Value, to_stored: bool) -> Value {
    let empty = Obj::new();
    let from = obj(Some(value)).unwrap_or(&empty);
    let mut out = Obj::new();
    for (stored, settings) in OVERRIDE_FIELDS {
        let (source, target) = if to_stored {
            (settings, stored)
        } else {
            (stored, settings)
        };
        let Some(field) = from.get(source) else {
            continue;
        };
        // dependsOn and labels are kept when truthy, the others when defined.
        let kept = if matches!(stored, "depends_on" | "labels") {
            truthy(Some(field))
        } else {
            true
        };
        if kept {
            out.insert(target.into(), field.clone());
        }
    }
    // `at: stored.at` and the others: undefined drops out of JSON.
    for key in ["at", "by", "marker"] {
        if let Some(field) = from.get(key) {
            out.insert(key.into(), field.clone());
        }
    }
    Value::Object(out)
}

fn convert_overrides(value: Option<&Value>, to_stored: bool) -> Obj {
    obj(value)
        .map(|overrides| {
            overrides
                .iter()
                .map(|(key, value)| (key.clone(), convert_override(value, to_stored)))
                .collect()
        })
        .unwrap_or_default()
}

fn clone_ref(value: &Value, to_stored: bool) -> Value {
    let (id_from, id_to) = if to_stored {
        ("connectionId", "connection_id")
    } else {
        ("connection_id", "connectionId")
    };
    let mut out = Obj::new();
    if let Some(id) = value.get(id_from) {
        out.insert(id_to.into(), id.clone());
    }
    if let Some(path) = value.get("path") {
        out.insert("path".into(), path.clone());
    }
    Value::Object(out)
}

fn effort_head(head: &Value, to_stored: bool) -> Value {
    let Value::Object(mut out) = clone_ref(head, to_stored) else {
        unreachable!()
    };
    let (from, to) = if to_stored {
        ("workspaceId", "workspace_id")
    } else {
        ("workspace_id", "workspaceId")
    };
    if let Some(id) = head.get(from)
        && truthy(Some(id))
    {
        out.insert(to.into(), id.clone());
    }
    Value::Object(out)
}

fn effort(value: &Value, to_stored: bool) -> Value {
    let mut out = Obj::new();
    for key in ["id", "group", "name"] {
        if let Some(field) = value.get(key) {
            out.insert(key.into(), field.clone());
        }
    }
    if let Some(clone) = value.get("clone") {
        out.insert("clone".into(), clone_ref(clone, to_stored));
    }
    for key in ["source", "target"] {
        if let Some(field) = value.get(key) {
            out.insert(key.into(), field.clone());
        }
    }
    let feeders = value.get("feeders");
    if to_stored {
        if non_empty_list(feeders) {
            out.insert("feeders".into(), feeders.cloned().unwrap_or_default());
        }
    } else {
        out.insert(
            "feeders".into(),
            feeders
                .filter(|f| truthy(Some(f)))
                .cloned()
                .unwrap_or_else(|| json!([])),
        );
    }
    if let Some(head) = value.get("head")
        && truthy(Some(head))
    {
        out.insert("head".into(), effort_head(head, to_stored));
    }
    Value::Object(out)
}

/// `stored?.x ?? base.x`: a value that is neither absent nor null, else the default.
fn or_default(stored: Option<&Obj>, key: &str, default: &Value) -> Value {
    stored
        .and_then(|s| s.get(key))
        .filter(|v| !v.is_null())
        .cloned()
        .unwrap_or_else(|| default.clone())
}

/// `mrReviewsSettings`: the settings in effect, defaults filled in.
pub fn mr_reviews_settings(stored: Option<&Obj>) -> Obj {
    let base = default_settings();
    let pick = |key: &str, from: &str| or_default(stored, key, &base[from]);
    let get = |key: &str| stored.and_then(|s| s.get(key)).filter(|v| !v.is_null());
    let mut out = Obj::new();
    out.insert("hosts".into(), pick("hosts", "hosts"));
    out.insert("followed".into(), pick("followed", "followed"));
    out.insert("checkout".into(), pick("checkout", "checkout"));
    out.insert(
        "retentionDays".into(),
        pick("retention_days", "retentionDays"),
    );
    out.insert("curation".into(), pick("curation", "curation"));
    out.insert("inference".into(), pick("inference", "inference"));
    out.insert(
        "inferenceHours".into(),
        pick("inference_hours", "inferenceHours"),
    );
    out.insert(
        "inferenceModel".into(),
        pick("inference_model", "inferenceModel"),
    );
    out.insert("suggestDays".into(), pick("suggest_days", "suggestDays"));
    out.insert("hints".into(), pick("hints", "hints"));
    out.insert("treeGroups".into(), pick("tree_groups", "treeGroups"));
    let clones: Obj = obj(get("clones"))
        .map(|clones| {
            clones
                .iter()
                .map(|(key, clone)| (key.clone(), clone_ref(clone, false)))
                .collect()
        })
        .unwrap_or_default();
    out.insert("clones".into(), Value::Object(clones));
    out.insert("order".into(), pick("order", "order"));
    out.insert(
        "orderVersion".into(),
        get("order_version").cloned().unwrap_or_else(|| json!(0)),
    );
    out.insert("pinned".into(), pick("pinned", "pinned"));
    out.insert("hidden".into(), pick("hidden", "hidden"));
    out.insert(
        "overrides".into(),
        Value::Object(convert_overrides(get("overrides"), false)),
    );
    out.insert("staleDays".into(), pick("stale_days", "staleDays"));
    out.insert("views".into(), pick("views", "views"));
    out.insert(
        "upstreamGroups".into(),
        pick("upstream_groups", "upstreamGroups"),
    );
    out.insert("upstreamSkip".into(), pick("upstream_skip", "upstreamSkip"));
    out.insert(
        "upstreamWorkspaces".into(),
        pick("upstream_workspaces", "upstreamWorkspaces"),
    );
    out.insert("unsent".into(), pick("unsent", "unsent"));
    out.insert(
        "merge".into(),
        Value::Object(merge_settings_of(obj(get("merge")))),
    );
    out.insert("panel".into(), pick("panel", "panel"));
    out.insert("homePrompt".into(), pick("home_prompt", "homePrompt"));
    let efforts: Vec<Value> = get("efforts")
        .and_then(Value::as_array)
        .map(|efforts| efforts.iter().map(|e| effort(e, false)).collect())
        .unwrap_or_default();
    out.insert("efforts".into(), Value::Array(efforts));
    out
}

/// `storedMrReviews`: the settings in effect, as settings.json keeps them.
pub fn stored_mr_reviews(settings: &Obj) -> Obj {
    let field = |key: &str| settings.get(key).cloned();
    let mut out = Obj::new();
    let put = |out: &mut Obj, key: &str, value: Option<Value>| {
        if let Some(value) = value {
            out.insert(key.into(), value);
        }
    };
    put(&mut out, "hosts", field("hosts"));
    put(&mut out, "followed", field("followed"));
    put(&mut out, "checkout", field("checkout"));
    put(&mut out, "retention_days", field("retentionDays"));
    put(&mut out, "curation", field("curation"));
    if settings.get("inference") != Some(&json!(DEFAULT_INFERENCE)) {
        put(&mut out, "inference", field("inference"));
    }
    if settings.get("inferenceHours").and_then(Value::as_f64) != Some(DEFAULT_INFERENCE_HOURS) {
        put(&mut out, "inference_hours", field("inferenceHours"));
    }
    if truthy(settings.get("inferenceModel")) {
        put(&mut out, "inference_model", field("inferenceModel"));
    }
    put(&mut out, "suggest_days", field("suggestDays"));
    put(&mut out, "hints", field("hints"));
    put(&mut out, "tree_groups", field("treeGroups"));
    let clones: Obj = obj(settings.get("clones"))
        .map(|clones| {
            clones
                .iter()
                .map(|(key, clone)| (key.clone(), clone_ref(clone, true)))
                .collect()
        })
        .unwrap_or_default();
    out.insert("clones".into(), Value::Object(clones));
    if non_empty_list(settings.get("order")) {
        put(&mut out, "order", field("order"));
    }
    if truthy(settings.get("orderVersion")) {
        put(&mut out, "order_version", field("orderVersion"));
    }
    for (from, to) in [("pinned", "pinned"), ("hidden", "hidden")] {
        if non_empty_list(settings.get(from)) {
            put(&mut out, to, field(from));
        }
    }
    let overrides = convert_overrides(settings.get("overrides"), true);
    if !overrides.is_empty() {
        out.insert("overrides".into(), Value::Object(overrides));
    }
    for (from, to) in [
        ("views", "views"),
        ("upstreamGroups", "upstream_groups"),
        ("upstreamSkip", "upstream_skip"),
        ("upstreamWorkspaces", "upstream_workspaces"),
        ("unsent", "unsent"),
    ] {
        if non_empty_list(settings.get(from)) {
            put(&mut out, to, field(from));
        }
    }
    if let Some(efforts) = settings.get("efforts").and_then(Value::as_array)
        && !efforts.is_empty()
    {
        let efforts = efforts.iter().map(|e| effort(e, true)).collect();
        out.insert("efforts".into(), Value::Array(efforts));
    }
    if settings.get("staleDays").and_then(Value::as_f64) != Some(DEFAULT_STALE_DAYS) {
        put(&mut out, "stale_days", field("staleDays"));
    }
    if let Some(merge) = stored_merge_of(obj(settings.get("merge"))) {
        out.insert("merge".into(), Value::Object(merge));
    }
    if obj(settings.get("panel")).is_some_and(|panel| truthy(panel.get("at"))) {
        put(&mut out, "panel", field("panel"));
    }
    if truthy(settings.get("homePrompt")) {
        put(&mut out, "home_prompt", field("homePrompt"));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn normalized(raw: Value) -> Obj {
        normalize_stored_mr_reviews(Some(&raw))
            .and_then(|v| v.as_object().cloned())
            .expect("an object")
    }

    // inbox.test.ts
    #[test]
    fn defaults_are_empty_nothing_user_specific() {
        let value = mr_reviews_settings(None);
        assert_eq!(value["hosts"], json!([]));
        assert_eq!(value["followed"], json!([]));
        assert_eq!(value["hints"], json!(""));
        assert_eq!(value["orderVersion"], json!(0));
        assert_eq!(value["merge"], json!({"scopes": {}}));
        let keys: Vec<&str> = value.keys().map(String::as_str).collect();
        assert_eq!(keys.last(), Some(&"efforts"));
    }

    #[test]
    fn normalizes_what_settings_json_holds() {
        let stored = normalized(json!({
            "hosts": [
                { "host": "GitLab.Example.org", "provider": "gitlab" },
                { "host": "bad host", "provider": "gitlab" },
                { "host": "x.org", "provider": "svn" },
            ],
            "followed": [
                { "host": "gitlab.example.org", "provider": "gitlab", "project": "/g/p/" },
                { "host": "gitlab.example.org", "provider": "gitlab", "project": "g/p" },
                { "host": "gitlab.example.org", "provider": "gitlab", "project": "../x" },
            ],
            "checkout": "on_demand",
            "retention_days": 7,
            "curation": false,
            "hints": "I maintain ges",
            "clones": { "h/p": { "connection_id": "c", "path": "/src/p" }, "x": {} },
        }));
        assert_eq!(
            Value::Object(stored.clone()),
            json!({
                "hosts": [{ "host": "gitlab.example.org", "provider": "gitlab" }],
                "followed": [
                    { "host": "gitlab.example.org", "provider": "gitlab", "project": "g/p" },
                ],
                "checkout": "on_demand",
                "retention_days": 7,
                "curation": false,
                "hints": "I maintain ges",
                "clones": { "h/p": { "connection_id": "c", "path": "/src/p" } },
            })
        );
        let settings = mr_reviews_settings(Some(&stored));
        assert_eq!(
            settings["clones"],
            json!({ "h/p": { "connectionId": "c", "path": "/src/p" } })
        );
        assert_eq!(settings["retentionDays"], json!(7));
    }

    // overrides.test.ts
    #[test]
    fn settings_json_keeps_overrides_checked_capped_and_round_trips() {
        let stored = normalized(json!({
            "overrides": {
                "gitlab:h/p#1": {
                    "whose": { "person": "@bob" },
                    "next": "ask bob",
                    "depends_on": ["gitlab:h/p#2", "gitlab:h/p#2", 3],
                    "at": "2026-11-16T10:00:00Z",
                    "by": "agent",
                    "marker": "m",
                },
                "gitlab:h/p#2": { "whose": "nobody", "at": "x", "marker": "m" },
                "": { "next": "no key" },
            },
            "stale_days": 30,
        }));
        let keys: Vec<&String> = stored["overrides"].as_object().unwrap().keys().collect();
        assert_eq!(keys, ["gitlab:h/p#1"]);
        let settings = mr_reviews_settings(Some(&stored));
        assert_eq!(
            settings["overrides"]["gitlab:h/p#1"],
            json!({
                "whose": { "person": "bob" },
                "next": "ask bob",
                "dependsOn": ["gitlab:h/p#2"],
                "at": "2026-11-16T10:00:00Z",
                "by": "agent",
                "marker": "m",
            })
        );
        assert_eq!(settings["staleDays"], json!(30));
        let again = normalized(Value::Object(stored_mr_reviews(&settings)));
        assert_eq!(mr_reviews_settings(Some(&again)), settings);
        assert!(
            roamgate_base::settings::sections::normalize_override(
                &json!({ "at": "x", "marker": "m" })
            )
            .is_none()
        );
    }

    #[test]
    fn the_oldest_overrides_are_forgotten_past_the_cap() {
        let mut overrides = Obj::new();
        for n in 0..510u32 {
            overrides.insert(
                format!("k{n}"),
                json!({
                    "next": "n",
                    "at": format!("2026-01-01T{:02}:{:02}:00.000Z", n / 60, n % 60),
                    "marker": "m",
                }),
            );
        }
        let stored = normalized(json!({ "overrides": overrides }));
        let kept = stored["overrides"].as_object().unwrap();
        assert_eq!(kept.len(), 500);
        assert!(!kept.contains_key("k0"));
        assert!(kept.contains_key("k509"));
    }

    #[test]
    fn every_field_round_trips_through_the_stored_form() {
        let settings = json!({
            "hosts": [{ "host": "h", "provider": "gitlab" }],
            "followed": [],
            "checkout": "on_demand",
            "retentionDays": 3,
            "curation": true,
            "inference": false,
            "inferenceHours": 6,
            "inferenceModel": "opus",
            "suggestDays": 30,
            "hints": "",
            "treeGroups": {},
            "clones": { "h/p": { "connectionId": "c", "path": "/p" } },
            "order": ["a"],
            "orderVersion": 2,
            "pinned": [],
            "hidden": [],
            "overrides": {},
            "staleDays": 90,
            "views": [],
            "upstreamGroups": [],
            "upstreamSkip": [],
            "upstreamWorkspaces": [],
            "unsent": [],
            "merge": { "bots": ["marge"], "scopes": { "h/p": { "afterLabels": ["go"] }, "h/q": {} } },
            "panel": { "search": "", "filter": "all", "at": "" },
            "homePrompt": "hi",
            "efforts": [{
                "id": "e", "group": "g", "name": "n",
                "clone": { "connectionId": "c", "path": "/p" },
                "source": "refs/heads/x", "target": { "remote": "o", "branch": "main" },
                "feeders": [],
                "head": { "connectionId": "c", "path": "/w", "workspaceId": "w1" },
            }],
        });
        let stored = stored_mr_reviews(settings.as_object().unwrap());
        assert_eq!(
            Value::Object(stored.clone()),
            json!({
                "hosts": [{ "host": "h", "provider": "gitlab" }],
                "followed": [],
                "checkout": "on_demand",
                "retention_days": 3,
                "curation": true,
                "inference": false,
                "inference_hours": 6,
                "inference_model": "opus",
                "suggest_days": 30,
                "hints": "",
                "tree_groups": {},
                "clones": { "h/p": { "connection_id": "c", "path": "/p" } },
                "order": ["a"],
                "order_version": 2,
                "efforts": [{
                    "id": "e", "group": "g", "name": "n",
                    "clone": { "connection_id": "c", "path": "/p" },
                    "source": "refs/heads/x", "target": { "remote": "o", "branch": "main" },
                    "head": { "connection_id": "c", "path": "/w", "workspace_id": "w1" },
                }],
                "merge": { "bots": ["marge"], "scopes": { "h/p": { "after_labels": ["go"] } } },
                "home_prompt": "hi",
            })
        );
        // Bun's bytes (storedMrReviews, then mrReviewsSettings of them).
        assert_eq!(
            roamgate_agents::js::stringify(&Value::Object(stored.clone())),
            r#"{"hosts":[{"host":"h","provider":"gitlab"}],"followed":[],"checkout":"on_demand","retention_days":3,"curation":true,"inference":false,"inference_hours":6,"inference_model":"opus","suggest_days":30,"hints":"","tree_groups":{},"clones":{"h/p":{"connection_id":"c","path":"/p"}},"order":["a"],"order_version":2,"efforts":[{"id":"e","group":"g","name":"n","clone":{"connection_id":"c","path":"/p"},"source":"refs/heads/x","target":{"remote":"o","branch":"main"},"head":{"connection_id":"c","path":"/w","workspace_id":"w1"}}],"merge":{"bots":["marge"],"scopes":{"h/p":{"after_labels":["go"]}}},"home_prompt":"hi"}"#
        );
        assert_eq!(
            roamgate_agents::js::stringify(&Value::Object(mr_reviews_settings(Some(&stored)))),
            r#"{"hosts":[{"host":"h","provider":"gitlab"}],"followed":[],"checkout":"on_demand","retentionDays":3,"curation":true,"inference":false,"inferenceHours":6,"inferenceModel":"opus","suggestDays":30,"hints":"","treeGroups":{},"clones":{"h/p":{"connectionId":"c","path":"/p"}},"order":["a"],"orderVersion":2,"pinned":[],"hidden":[],"overrides":{},"staleDays":90,"views":[],"upstreamGroups":[],"upstreamSkip":[],"upstreamWorkspaces":[],"unsent":[],"merge":{"bots":["marge"],"scopes":{"h/p":{"afterLabels":["go"]}}},"panel":{"search":"","filter":"all","at":""},"homePrompt":"hi","efforts":[{"id":"e","group":"g","name":"n","clone":{"connectionId":"c","path":"/p"},"source":"refs/heads/x","target":{"remote":"o","branch":"main"},"feeders":[],"head":{"connectionId":"c","path":"/w","workspaceId":"w1"}}]}"#
        );
        assert_eq!(
            roamgate_agents::js::stringify(&Value::Object(mr_reviews_settings(None))),
            r#"{"hosts":[],"followed":[],"checkout":"immediately","retentionDays":3,"curation":true,"inference":true,"inferenceHours":12,"inferenceModel":"","suggestDays":30,"hints":"","treeGroups":{},"clones":{},"order":[],"orderVersion":0,"pinned":[],"hidden":[],"overrides":{},"staleDays":90,"views":[],"upstreamGroups":[],"upstreamSkip":[],"upstreamWorkspaces":[],"unsent":[],"merge":{"scopes":{}},"panel":{"search":"","filter":"all","at":""},"homePrompt":"","efforts":[]}"#
        );
        let mut back = mr_reviews_settings(Some(&stored));
        // `scopes` without lists is not kept.
        back["merge"]["scopes"]
            .as_object_mut()
            .unwrap()
            .insert("h/q".into(), json!({}));
        assert_eq!(Value::Object(back), settings);
    }
}
