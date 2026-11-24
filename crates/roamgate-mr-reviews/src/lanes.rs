//! Lanes of one's own work (`mr-reviews/lanes.ts`): whose move it is and
//! the next step. An override's whose-move (not outdated) wins, then the
//! inference, then rules from what the forge already says; a request
//! waiting for another listed open request is drawn under it.

use std::collections::{HashMap, HashSet};

use roamgate_agents::js::{self, Obj};
use serde_json::{Value, json};

use crate::shared::merge;
use crate::shared::types::{ref_label, whose_label};

const DAY_MS: f64 = 24.0 * 60.0 * 60_000.0;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RuleLane {
    pub lane: &'static str,
    pub why: String,
    pub next: String,
    /// From exact merge facts: wins over the model's inference.
    pub exact: bool,
}

fn rule(lane: &'static str, why: impl Into<String>, next: impl Into<String>) -> RuleLane {
    RuleLane {
        lane,
        why: why.into(),
        next: next.into(),
        exact: false,
    }
}

fn exact(lane: &'static str, why: impl Into<String>, next: impl Into<String>) -> RuleLane {
    RuleLane {
        exact: true,
        ..rule(lane, why, next)
    }
}

fn truthy(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) => false,
        Some(Value::Bool(b)) => *b,
        Some(Value::String(s)) => !s.is_empty(),
        Some(Value::Number(n)) => n.as_f64().is_some_and(|n| n != 0.0),
        Some(_) => true,
    }
}

fn plural(n: f64, word: &str) -> String {
    format!(
        "{} {word}{}",
        js::number_text(n),
        if n == 1.0 { "" } else { "s" }
    )
}

fn quiet_days(entry: &Obj, stale_days: f64, now: f64) -> Option<f64> {
    let updated = js::date_parse(js::sv(entry.get("updatedAt")));
    (updated.is_finite() && now - updated > stale_days * DAY_MS)
        .then(|| ((now - updated) / DAY_MS).floor())
}

/// Lane, why and next step of one own request from the forge's status.
pub fn rule_lane(entry: &Obj, stale_days: f64, now: f64, waiting_for: &[&Obj]) -> RuleLane {
    if let Some(branch) = entry.get("branch").filter(|b| truthy(Some(b))) {
        return branch_lane(entry, branch, stale_days, now);
    }
    let state = js::sv(entry.get("state"));
    if state == "merged" || state == "closed" {
        return rule(
            "done",
            state,
            if state == "merged" {
                "Merged"
            } else {
                "Closed"
            },
        );
    }
    let open: Vec<&&Obj> = waiting_for
        .iter()
        .filter(|e| js::sv(e.get("state")) == "open")
        .collect();
    if !open.is_empty() {
        let names = open
            .iter()
            .map(|e| ref_label(e, true))
            .collect::<Vec<_>>()
            .join(", ");
        return rule(
            "blocked",
            format!("after {names}"),
            format!("Waits for {names}"),
        );
    }
    let merge_info = entry.get("merge");
    if let Some(bot) = merge_info
        .and_then(|m| m.get("bot"))
        .and_then(Value::as_object)
    {
        if truthy(bot.get("failed")) {
            return exact(
                "your_move",
                merge::bot_failed_label(bot),
                merge::bot_failed_next(bot),
            );
        }
        if js::is_true(bot.get("queued")) {
            let after = merge_info
                .and_then(|m| m.get("after"))
                .filter(|a| truthy(Some(a)));
            let next = match after {
                Some(after) if !js::is_true(after.get("ready")) => format!(
                    "{}, once the merge-after delay ({}) is over",
                    merge::bot_label(bot),
                    js::sv(after.get("delay"))
                ),
                _ => merge::bot_queued_next(bot),
            };
            return exact("merging", merge::bot_label(bot), next);
        }
    }
    if let Some(days) = quiet_days(entry, stale_days, now) {
        return rule(
            "stale",
            format!("quiet {} days", js::number_text(days)),
            format!(
                "No activity for {} days: ping, rebase or close it",
                js::number_text(days)
            ),
        );
    }
    let own = entry.get("own").filter(|o| truthy(Some(o)));
    let target = js::sv(entry.get("targetBranch"));
    let target = if target.is_empty() {
        "the target"
    } else {
        target
    };
    let pipeline = js::sv(entry.get("pipeline"));
    if pipeline == "failed" {
        return rule("your_move", "pipeline failed", "Fix the failed pipeline");
    }
    let own_get = |name: &str| own.and_then(|o| o.get(name));
    if js::is_true(own_get("conflicts")) {
        return rule(
            "your_move",
            "conflicts",
            format!("Rebase on {target}: it conflicts"),
        );
    }
    let changes: Vec<&str> = own_get("changesRequested")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .collect();
    if !changes.is_empty() {
        return rule(
            "your_move",
            "changes requested",
            format!("Address the changes {} asked for", changes.join(", ")),
        );
    }
    if let Some(unresolved) = own_get("unresolved")
        .and_then(Value::as_f64)
        .filter(|n| *n != 0.0)
    {
        return rule(
            "your_move",
            format!("{} unresolved", js::number_text(unresolved)),
            format!(
                "Answer {} unresolved {}",
                js::number_text(unresolved),
                if unresolved == 1.0 {
                    "thread"
                } else {
                    "threads"
                }
            ),
        );
    }
    if js::is_true(own_get("needsRebase")) {
        return rule("your_move", "needs rebase", format!("Rebase on {target}"));
    }
    if js::is_true(entry.get("draft")) {
        return rule("your_move", "draft", "Mark it ready for review");
    }
    if let Some(after) = merge_info
        .and_then(|m| m.get("after"))
        .filter(|a| truthy(Some(a)))
    {
        let delay = js::sv(after.get("delay"));
        if !js::is_true(after.get("ready")) {
            let since = match js::sv(after.get("from")) {
                "label" => "the label",
                "approval" => "the last approval",
                _ => "the last update",
            };
            return exact(
                "waiting",
                format!("merge after {delay}"),
                format!("Waiting on time: {delay} from {since}"),
            );
        }
        return exact(
            "your_move",
            "mergeable",
            format!("Merge it: the merge-after delay ({delay}) is over"),
        );
    }
    let approved_by = own_get("approvedBy")
        .and_then(Value::as_array)
        .is_some_and(|a| !a.is_empty());
    if truthy(own_get("approved")) || approved_by {
        return rule("waiting", "approved", "Approved: waiting to be merged");
    }
    if pipeline == "running" || pipeline == "pending" {
        return rule("waiting", "pipeline running", "Pipeline running");
    }
    rule("waiting", "in review", "Waiting for review")
}

fn branch_lane(entry: &Obj, branch: &Value, stale_days: f64, now: f64) -> RuleLane {
    if let Some(days) = quiet_days(entry, stale_days, now) {
        return rule(
            "stale",
            format!("quiet {} days", js::number_text(days)),
            format!(
                "No commit for {} days: propose it, rebase or drop it",
                js::number_text(days)
            ),
        );
    }
    let n = |name: &str| branch.get(name).and_then(Value::as_f64).unwrap_or(0.0);
    let commits = plural(n("ahead"), "commit");
    let unsent = js::is_true(entry.get("unsent"));
    let dirty = n("dirty");
    let next = if dirty != 0.0 {
        format!("Commit or stash {}", plural(dirty, "changed file"))
    } else if n("behind") > 50.0 {
        format!(
            "Rebase on {} ({} behind), then propose it",
            js::sv(branch.get("target")),
            js::number_text(n("behind"))
        )
    } else if unsent {
        format!("Open the request ({commits})")
    } else {
        format!("Propose {commits} upstream")
    };
    rule(
        "not_sent",
        if unsent { "not proposed yet" } else { "branch" },
        next,
    )
}

fn strings(value: Option<&Value>) -> Vec<String> {
    value
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(str::to_owned)
        .collect()
}

fn authored(entry: &Obj) -> bool {
    strings(entry.get("reasons"))
        .iter()
        .any(|r| r == "authored")
}

/// What an own request waits on: the user's override, else what was
/// inferred and is not outdated.
fn depends_of(entry: &Obj) -> Vec<String> {
    let override_depends = strings(
        entry
            .get("override")
            .and_then(Value::as_object)
            .and_then(|o| o.get("dependsOn")),
    );
    if !override_depends.is_empty() {
        return override_depends;
    }
    strings(
        entry
            .get("inferred")
            .and_then(Value::as_object)
            .filter(|_| !truthy(entry.get("inferredOutdated")))
            .and_then(|i| i.get("dependsOn")),
    )
}

/// Lanes, next steps and nesting for the own requests among `entries`.
pub fn assign_lanes(entries: &mut [Obj], stale_days: f64, now: f64) {
    let mut by_key: HashMap<String, usize> = HashMap::new();
    for (index, entry) in entries.iter().enumerate() {
        by_key.insert(js::sv(entry.get("key")).to_owned(), index);
    }
    // The entries waited on from an earlier one, as they are before any
    // lane is set: only those are copied.
    let mut snapshot: HashMap<usize, Obj> = HashMap::new();
    for (index, entry) in entries.iter().enumerate() {
        if !authored(entry) {
            continue;
        }
        for key in depends_of(entry) {
            if let Some(&waited) = by_key.get(&key)
                && waited >= index
            {
                snapshot
                    .entry(waited)
                    .or_insert_with(|| entries[waited].clone());
            }
        }
    }
    for index in 0..entries.len() {
        let entry = &entries[index];
        if !authored(entry) {
            continue;
        }
        let over = entry.get("override").and_then(Value::as_object).cloned();
        let inferred = entry
            .get("inferred")
            .and_then(Value::as_object)
            .filter(|_| !truthy(entry.get("inferredOutdated")))
            .cloned();
        let depends_on = depends_of(entry);
        // Entries before this one hold their lanes already, as the TS
        // reads them live from the same objects.
        let waiting_for: Vec<Obj> = depends_on
            .iter()
            .filter_map(|k| by_key.get(k))
            .map(|i| {
                if *i < index {
                    entries[*i].clone()
                } else {
                    snapshot[i].clone()
                }
            })
            .collect();
        let entry = &mut entries[index];
        if !depends_on.is_empty() {
            entry.insert("dependsOn".into(), json!(depends_on));
        }
        let waiting_refs: Vec<&Obj> = waiting_for.iter().collect();
        let rule = rule_lane(entry, stale_days, now, &waiting_refs);
        let mut lane = rule.lane;
        let mut why = rule.why.clone();
        let mut next = json!({"text": rule.next, "from": "rule"});
        let current = over.is_some() && !truthy(entry.get("overrideOutdated"));
        let over_get = |name: &str| over.as_ref().and_then(|o| o.get(name));
        let whose = over_get("whose").filter(|w| truthy(Some(w)));
        if lane != "done" && current && truthy(over_get("stale")) {
            lane = "stale";
            why = "marked stale".into();
        } else if lane != "done" && current && whose.is_some() {
            let whose = whose.unwrap_or(&Value::Null);
            let me = whose.as_str() == Some("me");
            lane = if me { "your_move" } else { "waiting" };
            why = if me {
                format!(
                    "set by {}",
                    if js::sv(over_get("by")) == "agent" {
                        "Claude"
                    } else {
                        "you"
                    }
                )
            } else {
                format!("waiting on {}", whose_label(whose))
            };
        } else if let Some(inferred) = inferred.as_ref().filter(|i| js::sv(i.get("by")) == "model")
            && !rule.exact
            && lane != "done"
            && lane != "blocked"
        {
            if js::is_true(inferred.get("stale")) {
                lane = "stale";
                why = "inferred stale".into();
            } else if !truthy(entry.get("branch")) {
                let whose = inferred.get("whose").unwrap_or(&Value::Null);
                let me = whose.as_str() == Some("me");
                lane = if me { "your_move" } else { "waiting" };
                why = if me {
                    "inferred: needs you".into()
                } else {
                    format!("inferred: waiting on {}", whose_label(whose))
                };
            }
        }
        let inferred_next = inferred
            .as_ref()
            .filter(|i| js::sv(i.get("by")) == "model")
            .map(|i| js::sv(i.get("next")).to_owned())
            .filter(|n| !n.is_empty());
        if let Some(text) = over_get("next")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
        {
            next = json!({"text": text, "from": "override", "by": over_get("by").cloned().unwrap_or(Value::Null)});
        } else if let Some(text) = inferred_next.filter(|_| lane != "done" && !rule.exact) {
            next = json!({"text": text, "from": "inferred"});
        }
        entry.insert("lane".into(), json!(lane));
        entry.insert("laneWhy".into(), json!(why));
        entry.insert("next".into(), next);
    }
    // Drawn under the first open listed request it waits for; never in a cycle.
    let depends: HashMap<String, Vec<String>> = entries
        .iter()
        .map(|e| (js::sv(e.get("key")).to_owned(), strings(e.get("dependsOn"))))
        .collect();
    let mut parents: Vec<(usize, String)> = Vec::new();
    for (index, entry) in entries.iter().enumerate() {
        let lane = js::sv(entry.get("lane"));
        let deps = strings(entry.get("dependsOn"));
        if lane.is_empty() || deps.is_empty() || lane == "done" {
            continue;
        }
        let key = js::sv(entry.get("key"));
        let parent = deps
            .iter()
            .filter_map(|k| by_key.get(k).map(|i| &entries[*i]))
            .find(|found| {
                !js::sv(found.get("lane")).is_empty()
                    && js::sv(found.get("state")) == "open"
                    && js::sv(found.get("key")) != key
            });
        let Some(parent) = parent else { continue };
        let parent_key = js::sv(parent.get("key")).to_owned();
        if reaches(&parent_key, key, &depends) {
            continue;
        }
        parents.push((index, parent_key));
    }
    for (index, parent) in parents {
        entries[index].insert("parent".into(), json!(parent));
    }
}

fn reaches(from: &str, to: &str, depends: &HashMap<String, Vec<String>>) -> bool {
    let mut seen: HashSet<String> = HashSet::new();
    let mut stack = vec![from.to_owned()];
    while let Some(key) = stack.pop() {
        if key == to {
            return true;
        }
        if !seen.insert(key.clone()) {
            continue;
        }
        stack.extend(depends.get(&key).cloned().unwrap_or_default());
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    fn now() -> f64 {
        js::date_parse("2026-11-16T12:00:00Z")
    }

    fn entry(n: u64, extra: Value, status: Value) -> Obj {
        let mut own = json!({"approvedBy": [], "approved": false, "changesRequested": [], "unresolved": 0,
            "conflicts": false, "needsRebase": false});
        for (k, v) in status.as_object().unwrap() {
            own[k] = v.clone();
        }
        let mut e = json!({"provider": "gitlab", "host": "h", "project": "g/p", "number": n,
            "key": format!("gitlab:h/g/p#{n}"), "url": format!("https://h/g/p/-/merge_requests/{n}"),
            "title": format!("MR {n}"), "author": "me", "draft": false, "state": "open",
            "updatedAt": "2026-11-15T00:00:00Z", "headSha": "a", "sourceBranch": "b", "targetBranch": "main",
            "pipeline": "success", "notes": 0, "reasons": ["authored"], "section": "authored", "unread": null,
            "isNew": false, "own": own});
        for (k, v) in extra.as_object().unwrap() {
            e[k] = v.clone();
        }
        e.as_object().cloned().unwrap()
    }

    fn e(n: u64, extra: Value) -> Obj {
        entry(n, extra, json!({}))
    }

    fn lanes(entries: &mut [Obj]) -> Vec<(u64, String, String)> {
        assign_lanes(entries, 90.0, now());
        entries
            .iter()
            .map(|e| {
                (
                    e["number"].as_u64().unwrap(),
                    js::sv(e.get("lane")).to_owned(),
                    js::sv(e.get("next").and_then(|n| n.get("text"))).to_owned(),
                )
            })
            .collect()
    }

    #[test]
    fn rules_from_the_forges_status_give_lanes_and_next_steps() {
        let mut entries = vec![
            e(1, json!({"pipeline": "failed"})),
            entry(2, json!({}), json!({"conflicts": true})),
            entry(3, json!({}), json!({"changesRequested": ["bob"]})),
            entry(4, json!({}), json!({"unresolved": 2})),
            e(5, json!({"draft": true})),
            entry(6, json!({}), json!({"approvedBy": ["bob"]})),
            e(7, json!({})),
            e(
                8,
                json!({"updatedAt": "2026-01-01T00:00:00Z", "pipeline": "failed"}),
            ),
            e(9, json!({"state": "merged"})),
        ];
        let got = lanes(&mut entries);
        let want: Vec<(u64, &str, &str)> = vec![
            (1, "your_move", "Fix the failed pipeline"),
            (2, "your_move", "Rebase on main: it conflicts"),
            (3, "your_move", "Address the changes bob asked for"),
            (4, "your_move", "Answer 2 unresolved threads"),
            (5, "your_move", "Mark it ready for review"),
            (6, "waiting", "Approved: waiting to be merged"),
            (7, "waiting", "Waiting for review"),
            (
                8,
                "stale",
                "No activity for 319 days: ping, rebase or close it",
            ),
            (9, "done", "Merged"),
        ];
        let want: Vec<(u64, String, String)> = want
            .into_iter()
            .map(|(n, l, t)| (n, l.into(), t.into()))
            .collect();
        assert_eq!(got, want);
    }

    #[test]
    fn others_requests_get_no_lane() {
        let mut entries = vec![e(
            1,
            json!({"reasons": ["review_requested"], "section": "mine"}),
        )];
        assign_lanes(&mut entries, 90.0, now());
        assert!(!entries[0].contains_key("lane"));
    }

    #[test]
    fn an_overrides_whose_move_wins_unless_outdated_its_next_step_shows() {
        let meta = json!({"at": "t", "by": "agent", "marker": "m"});
        let with = |extra: Value| {
            let mut o = meta.clone();
            for (k, v) in extra.as_object().unwrap() {
                o[k] = v.clone();
            }
            o
        };
        let mut entries = vec![
            e(
                1,
                json!({"pipeline": "failed", "override": with(json!({"whose": "reviewer", "next": "bob reruns CI"}))}),
            ),
            e(
                2,
                json!({"pipeline": "failed", "override": with(json!({"whose": "reviewer"})), "overrideOutdated": true}),
            ),
            e(3, json!({"override": with(json!({"stale": true}))})),
        ];
        lanes(&mut entries);
        assert_eq!(entries[0]["lane"], json!("waiting"));
        assert_eq!(entries[0]["laneWhy"], json!("waiting on reviewer"));
        assert_eq!(
            entries[0]["next"],
            json!({"text": "bob reruns CI", "from": "override", "by": "agent"})
        );
        assert_eq!(entries[1]["lane"], json!("your_move"));
        assert_eq!(entries[2]["lane"], json!("stale"));
    }

    fn depends(keys: Value) -> Value {
        json!({"override": {"dependsOn": keys, "at": "t", "by": "user", "marker": "m"}})
    }

    #[test]
    fn a_request_waiting_for_another_is_drawn_under_it_and_blocked() {
        let mut entries = vec![
            e(1, json!({})),
            e(2, depends(json!(["gitlab:h/g/p#1"]))),
            e(3, depends(json!(["gitlab:h/g/p#2"]))),
            e(4, depends(json!(["gitlab:h/other#9"]))),
            e(5, json!({"state": "merged"})),
            e(6, depends(json!(["gitlab:h/g/p#5"]))),
        ];
        lanes(&mut entries);
        assert_eq!(entries[1]["lane"], json!("blocked"));
        assert_eq!(entries[1]["parent"], json!("gitlab:h/g/p#1"));
        assert_eq!(entries[2]["parent"], json!("gitlab:h/g/p#2"));
        assert_eq!(entries[1]["next"]["text"], json!("Waits for !1"));
        assert!(!entries[3].contains_key("parent"));
        assert_eq!(entries[3]["dependsOn"], json!(["gitlab:h/other#9"]));
        assert_eq!(entries[5]["lane"], json!("waiting"));
        assert!(!entries[5].contains_key("parent"));
    }

    #[test]
    fn cycles_are_drawn_flat() {
        let mut entries = vec![
            e(1, depends(json!(["gitlab:h/g/p#2"]))),
            e(2, depends(json!(["gitlab:h/g/p#1"]))),
        ];
        lanes(&mut entries);
        assert!(!entries[0].contains_key("parent"));
        assert!(!entries[1].contains_key("parent"));
        assert_eq!(entries[0]["lane"], json!("blocked"));
    }
}
