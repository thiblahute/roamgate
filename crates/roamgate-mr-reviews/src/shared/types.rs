//! The pure helpers of `shared/mrReviews.ts` and `shared/forge.ts` the
//! server uses: labels, keys, the seen marks and unread counts, the home
//! prompt. Requests are JavaScript objects ([`Obj`]), as Bun holds them.

use std::sync::LazyLock;

use regex::Regex;
use roamgate_agents::js::{self, Obj};
use serde_json::{Value, json};

/// `forgeRefLabel`: `group/project!12` (GitLab) or `owner/repo#12`; short: `!12`.
pub fn forge_ref_label(item: &Obj, short: bool) -> String {
    let mark = if js::sv(item.get("provider")) == "gitlab" {
        "!"
    } else {
        "#"
    };
    let number = item
        .get("number")
        .map(js::to_text)
        .unwrap_or_else(|| "undefined".into());
    if short {
        format!("{mark}{number}")
    } else {
        format!("{}{mark}{number}", js::sv(item.get("project")))
    }
}

/// `forgeRefKey`: `<provider>:<host>/<project>!<number>`, lower case host and project.
pub fn forge_ref_key(item: &Obj) -> String {
    let number = item.get("number").map(js::to_text).unwrap_or_default();
    format!(
        "{}:{}/{}#{}",
        js::sv(item.get("provider")),
        js::sv(item.get("host")).to_lowercase(),
        js::sv(item.get("project")).to_lowercase(),
        number
    )
}

/// "MR" on GitLab, "PR" on GitHub.
pub fn forge_kind(provider: &str) -> &'static str {
    if provider == "gitlab" { "MR" } else { "PR" }
}

/// A whose-move as it reads: "me", "reviewer", "external" or the person.
pub fn whose_label(whose: &Value) -> String {
    match whose {
        Value::String(s) => s.clone(),
        other => js::sv(other.get("person")).to_owned(),
    }
}

static PERSON: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[\w.-]+$").expect("pattern"));

/// "me" | "reviewer" | "external" | a person's name, as typed.
pub fn parse_whose(text: &str) -> Option<Value> {
    let trimmed = js::trim(text);
    let value = trimmed.strip_prefix('@').unwrap_or(trimmed);
    if value.is_empty() || js::len16(value) > 80 || value.chars().any(js::is_js_space) {
        return None;
    }
    let lower = value.to_lowercase();
    match lower.as_str() {
        "me" | "reviewer" | "external" => return Some(Value::String(lower)),
        "you" | "mine" => return Some(Value::String("me".into())),
        _ => {}
    }
    PERSON.is_match(value).then(|| json!({"person": value}))
}

/// A branch's key: the target project and the branch name.
pub fn branch_key(provider: &str, host: &str, project: &str, branch: &str) -> String {
    format!(
        "branch:{provider}:{}/{}@{branch}",
        host.to_lowercase(),
        project.to_lowercase()
    )
}

static BRANCH_KEY: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^branch:(gitlab|github):([^/]+)/([^@]+)@(.+)$").expect("pattern")
});

/// A branch key's parts: provider, host, project, branch.
pub fn parse_branch_key(key: &str) -> Option<(String, String, String, String)> {
    let c = BRANCH_KEY.captures(key)?;
    Some((
        c[1].to_owned(),
        c[2].to_owned(),
        c[3].to_owned(),
        c[4].to_owned(),
    ))
}

/// How a row is named: a request's reference, or a branch's name.
pub fn ref_label(entry: &Obj, short: bool) -> String {
    if let Some(branch) = entry.get("branch").and_then(Value::as_object) {
        let name = js::sv(branch.get("name"));
        return if short {
            name.to_owned()
        } else {
            format!("{}@{name}", js::sv(entry.get("project")))
        };
    }
    forge_ref_label(entry, short)
}

/// The first prompt of a request's home agent, when the setting is empty.
pub const DEFAULT_HOME_PROMPT: &str = "This workspace is the home of the review of {url} ({ref} \"{title}\" by {author}, into {target}). Review it with Roamgate's review tools: open its review in this workspace's Changes, read the forge discussions, and draft your comments as the user's pending drafts: only the user sends them. Never post to the forge (no comment, approval, push or merge). Keep your notes here, in this workspace, for the next sessions. Start with a short summary of the request and what you plan to look at.";

static HOME_FIELD: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"\{(url|ref|title|author|target|source|project)\}").expect("pattern")
});

/// The home prompt with the request's facts in place of its {fields}.
pub fn home_prompt(template: &str, facts: &[(&str, &str)]) -> String {
    let trimmed = js::trim(template);
    let text = if trimmed.is_empty() {
        DEFAULT_HOME_PROMPT
    } else {
        trimmed
    };
    HOME_FIELD
        .replace_all(text, |c: &regex::Captures| {
            facts
                .iter()
                .find(|(k, _)| *k == &c[1])
                .map_or(String::new(), |(_, v)| (*v).to_owned())
        })
        .into_owned()
}

/// A request's activity marker: head, notes and state.
pub fn activity_marker(item: &Obj) -> String {
    format!(
        "{}|{}|{}",
        js::sv(item.get("headSha")),
        item.get("notes")
            .map(js::to_text)
            .unwrap_or_else(|| "undefined".into()),
        item.get("state")
            .map(js::to_text)
            .unwrap_or_else(|| "undefined".into())
    )
}

/// A project's key: host and project, lower case.
pub fn project_key(host: &str, project: &str) -> String {
    format!("{}/{}", host.to_lowercase(), project.to_lowercase())
}

/// What the user saw of a request at `at`.
pub fn seen_of(item: &Obj, at: &str) -> Obj {
    let mut out = Obj::new();
    out.insert("at".into(), Value::String(at.to_owned()));
    for name in ["updatedAt", "headSha", "notes", "state", "pipeline"] {
        if let Some(value) = item.get(name) {
            out.insert(name.into(), value.clone());
        }
    }
    if let Some(own) = item.get("own").and_then(Value::as_object) {
        for name in ["approvedBy", "unresolved", "conflicts"] {
            if let Some(value) = own.get(name) {
                out.insert(name.into(), value.clone());
            }
        }
    }
    out
}

fn n(value: Option<&Value>) -> f64 {
    value.and_then(Value::as_f64).unwrap_or(0.0)
}

/// What changed on a request since the user saw it; None when never seen.
pub fn unread(item: &Obj, seen: Option<&Obj>) -> Option<Obj> {
    let seen = seen?;
    let head = js::sv(item.get("headSha"));
    let new_commits = !head.is_empty() && Some(head) != seen.get("headSha").and_then(Value::as_str);
    let new_notes = (n(item.get("notes")) - n(seen.get("notes"))).max(0.0);
    let changed = new_commits
        || new_notes > 0.0
        || js::sv(item.get("updatedAt")) > js::sv(seen.get("updatedAt"));
    let mut out = Obj::new();
    out.insert("newCommits".into(), Value::Bool(new_commits));
    out.insert("newNotes".into(), js::number(new_notes));
    out.insert("changed".into(), Value::Bool(changed));
    let item_state = js::sv(item.get("state"));
    let seen_state = js::sv(seen.get("state"));
    if !seen_state.is_empty() && !item_state.is_empty() && item_state != seen_state {
        out.insert("state".into(), Value::String(item_state.to_owned()));
    }
    if let (Some(before), Some(now)) = (seen.get("pipeline"), item.get("pipeline"))
        && before != now
    {
        out.insert("pipeline".into(), now.clone());
    }
    let own = item.get("own").and_then(Value::as_object);
    if let (Some(own), Some(before)) = (own, seen.get("approvedBy").and_then(Value::as_array)) {
        let added: Vec<Value> = own
            .get("approvedBy")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter(|name| !before.contains(name))
            .cloned()
            .collect();
        if !added.is_empty() {
            out.insert("newApprovals".into(), Value::Array(added));
        }
    }
    if let (Some(own), Some(before)) = (own, seen.get("conflicts"))
        && own.get("conflicts") != Some(before)
    {
        out.insert(
            "conflicts".into(),
            own.get("conflicts").cloned().unwrap_or(Value::Null),
        );
    }
    if let Some(own) = own
        && let Some(now) = own.get("unresolved").filter(|v| !v.is_null())
        && seen.get("unresolved").is_some_and(Value::is_number)
        && Some(now) != seen.get("unresolved")
    {
        out.insert("unresolved".into(), now.clone());
    }
    if [
        "state",
        "pipeline",
        "newApprovals",
        "conflicts",
        "unresolved",
    ]
    .iter()
    .any(|k| out.contains_key(*k))
    {
        out.insert("changed".into(), Value::Bool(true));
    }
    Some(out)
}

/// `workspaceRefKey`: the connection and the workspace's path, label or id.
pub fn workspace_ref_key(reference: &Obj) -> String {
    let path = js::sv(reference.get("path"));
    let label = js::sv(reference.get("label"));
    let identity = if !path.is_empty() {
        format!("p:{path}")
    } else if !label.is_empty() {
        format!("l:{label}")
    } else {
        format!("i:{}", js::sv(reference.get("workspace_id")))
    };
    format!("{}\u{0}{identity}", js::sv(reference.get("connection_id")))
}

/// Whether a stored upstream workspace is `reference`.
pub fn same_upstream_workspace(stored: &Obj, reference: &Obj) -> bool {
    workspace_ref_key(stored) == workspace_ref_key(reference)
        || (stored.get("connection_id") == reference.get("connection_id")
            && !js::sv(stored.get("path")).is_empty()
            && stored.get("path") == reference.get("path"))
}

/// The id of an upstream workspace's home: two FNV-1a passes over its key.
pub fn upstream_workspace_home(reference: &Obj) -> String {
    let text = workspace_ref_key(reference);
    let mut a: u32 = 0x811c_9dc5;
    let mut b: u32 = 0x0100_0193 ^ 0x5bd1_e995;
    for code in text.encode_utf16() {
        a = (a ^ u32::from(code)).wrapping_mul(0x0100_0193);
        b = (b ^ u32::from(code)).wrapping_mul(0x0100_0193 + 2);
    }
    format!("ws-{a:08x}{b:08x}")
}

static FIXUP_PREFIX: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^(?:(?:fixup|squash|amend)! )+").expect("pattern"));

/// For each commit (oldest first), the index of the commit a fixup folds
/// into (-1: not found), None for a commit that is no fixup.
pub fn fixup_targets(commits: &[(String, String)]) -> Vec<Option<i64>> {
    let mut out: Vec<Option<i64>> = Vec::new();
    for (index, (_, subject)) in commits.iter().enumerate() {
        let Some(prefix) = FIXUP_PREFIX.find(subject) else {
            out.push(None);
            continue;
        };
        let wanted = &subject[prefix.end()..];
        let before = &commits[..index];
        let mut found = before.iter().position(|(_, s)| s == wanted);
        if found.is_none() && js::len16(wanted) >= 4 && !wanted.contains(' ') {
            found = before.iter().position(|(sha, _)| sha.starts_with(wanted));
        }
        if found.is_none() {
            found = before.iter().position(|(_, s)| s.starts_with(wanted));
        }
        out.push(Some(match found {
            None => -1,
            Some(f) => match out[f] {
                Some(further) if further >= 0 => further,
                _ => f as i64,
            },
        }));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn obj(value: Value) -> Obj {
        value.as_object().cloned().unwrap()
    }

    #[test]
    fn reads_whose_moves_as_typed() {
        assert_eq!(parse_whose(" @Mine "), Some(json!("me")));
        assert_eq!(parse_whose("Reviewer"), Some(json!("reviewer")));
        assert_eq!(parse_whose("alice.b"), Some(json!({"person": "alice.b"})));
        assert_eq!(parse_whose("two words"), None);
        assert_eq!(parse_whose("bad!name"), None);
        assert_eq!(whose_label(&json!({"person": "bob"})), "bob");
    }

    #[test]
    fn branch_keys_round_trip() {
        let key = branch_key("gitlab", "GitLab.com", "Group/Proj", "feat/x");
        assert_eq!(key, "branch:gitlab:gitlab.com/group/proj@feat/x");
        assert_eq!(
            parse_branch_key(&key),
            Some((
                "gitlab".into(),
                "gitlab.com".into(),
                "group/proj".into(),
                "feat/x".into()
            ))
        );
        assert_eq!(parse_branch_key("gitlab:x/y!1"), None);
    }

    #[test]
    fn unread_says_only_what_the_seen_record_holds() {
        let item = obj(
            json!({"updatedAt": "2", "headSha": "b", "notes": 3, "state": "merged", "pipeline": "failed",
            "own": {"approvedBy": ["a", "c"], "unresolved": 2, "conflicts": true}}),
        );
        let old = obj(json!({"at": "0", "updatedAt": "1", "headSha": "a", "notes": 1}));
        assert_eq!(
            Value::Object(unread(&item, Some(&old)).unwrap()),
            json!({"newCommits": true, "newNotes": 2, "changed": true})
        );
        let seen = obj(
            json!({"at": "0", "updatedAt": "2", "headSha": "b", "notes": 3, "state": "open",
            "pipeline": null, "approvedBy": ["a"], "unresolved": 1, "conflicts": false}),
        );
        assert_eq!(
            Value::Object(unread(&item, Some(&seen)).unwrap()),
            json!({"newCommits": false, "newNotes": 0, "changed": true, "state": "merged", "pipeline": "failed",
                "newApprovals": ["c"], "conflicts": true, "unresolved": 2})
        );
        assert!(unread(&item, None).is_none());
    }

    #[test]
    fn fixups_fold_into_their_first_target() {
        let commits: Vec<(String, String)> = [
            ("aaaa1111", "Add x"),
            ("bbbb", "fixup! Add x"),
            ("cccc", "fixup! fixup! Add x"),
            ("dddd", "squash! aaaa1"),
            ("eeee", "amend! nothing"),
            ("ffff", "Plain"),
        ]
        .iter()
        .map(|(a, b)| ((*a).into(), (*b).into()))
        .collect();
        assert_eq!(
            fixup_targets(&commits),
            vec![None, Some(0), Some(0), Some(0), Some(-1), None]
        );
    }

    #[test]
    fn upstream_workspace_homes_are_stable() {
        let a = obj(json!({"connection_id": "local", "path": "/x"}));
        let b = obj(json!({"connection_id": "local", "path": "/x", "label": "y"}));
        assert_eq!(upstream_workspace_home(&a), upstream_workspace_home(&b));
        assert!(upstream_workspace_home(&a).starts_with("ws-"));
        assert_eq!(upstream_workspace_home(&a).len(), 19);
        assert!(same_upstream_workspace(&a, &b));
    }

    #[test]
    fn fills_the_home_prompt() {
        let text = home_prompt(
            "{ref} by {author} {nope}",
            &[("ref", "!1"), ("author", "al")],
        );
        assert_eq!(text, "!1 by al {nope}");
        assert!(home_prompt(" ", &[]).starts_with("This workspace is the home of the review of "));
    }
}
