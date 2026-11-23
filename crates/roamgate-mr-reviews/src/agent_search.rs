//! The reviews agent's forge searches (`mr-reviews/agent-search.ts`), as
//! pure query builders and parsers: read-only GraphQL queries (a `query`,
//! never a `mutation`; every value given by the model goes in as a
//! JSON-quoted string, a checked date or a number), run by the agent's
//! tools through the forge gate. Also how the agent (and a pin) names a
//! request.

use std::sync::LazyLock;

use regex::Regex;
use roamgate_agents::js::{self, Obj};
use serde_json::{Value, json};

use crate::forge_ref::{ForgeRef, valid_project};
use crate::queries::{github_item, gitlab_item, graphql_error};

/// Requests asked per project and search, at most.
pub const SEARCH_PAGE: usize = 30;
/// Changed paths read per request found.
pub const SEARCH_FILES: usize = 60;
/// What the search tool reads of a description.
pub const DESCRIPTION_KEPT: usize = 1500;

/// `SearchFilters`: `state` is opened, merged, closed or all.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct SearchFilters {
    /// Words searched in titles and descriptions.
    pub text: Option<String>,
    pub labels: Option<Vec<String>>,
    pub author: Option<String>,
    /// ISO date (YYYY-MM-DD or a full timestamp).
    pub updated_after: Option<String>,
    pub state: String,
    pub first: usize,
}

const GITLAB_FIELDS: &str = "iid title webUrl draft state updatedAt userNotesCount diffHeadSha sourceBranch targetBranch project { fullPath } author { username } headPipeline { status } diffRefs { baseSha } labels { nodes { title } }";

const GITHUB_FIELDS: &str = "number title url isDraft state updatedAt headRefOid baseRefOid headRefName baseRefName repository { nameWithOwner } author { login } comments { totalCount } reviewThreads { totalCount } commits(last: 1) { nodes { commit { statusCheckRollup { state } } } } labels(first: 10) { nodes { name } }";

static DATE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^[0-9]{4}-[0-9]{2}-[0-9]{2}(?:T[0-9]{2}:[0-9]{2}(?::[0-9]{2}(?:\.[0-9]+)?)?(?:Z|[+-][0-9]{2}:[0-9]{2})?)?$")
        .expect("pattern")
});
static DAYS: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)^([0-9]{1,4})[\t\n\x0B\x0C\r ]*d(?:ays?)?$").expect("pattern")
});
static NAME: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^[A-Za-z0-9_.@-]{1,100}$").expect("pattern"));
static REQUEST_URL: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^https://([A-Za-z0-9_.-]+)/(.+?)/(?:-/merge_requests|pull)/([0-9]+)(?-u:\b)")
        .expect("pattern")
});
static FULL_REF: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^([A-Za-z0-9_.-]+(?:/[A-Za-z0-9_.-]+)+)([!#])([0-9]+)$").expect("pattern")
});
static SHORT_REF: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^([!#])([0-9]+)$").expect("pattern"));
static NEWLINES: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"[\r\n]+").expect("pattern"));

/// `searchDate`: a date the forges take, or None. "7d" counts back from `now`.
pub fn search_date(value: &Value, now: f64) -> Option<String> {
    let trimmed = js::trim(value.as_str()?);
    if let Some(days) = DAYS.captures(trimmed) {
        let days: f64 = days[1].parse().ok()?;
        return Some(js::head16(&js::iso(now - days * 86_400_000.0), 10));
    }
    (DATE.is_match(trimmed) && js::date_parse(trimmed).is_finite()).then(|| trimmed.to_owned())
}

/// `validUserName`.
pub fn valid_user_name(value: &Value) -> bool {
    value.as_str().is_some_and(|name| NAME.is_match(name))
}

/// JSON strings are GraphQL strings.
fn quoted(value: &str) -> String {
    js::quote(value)
}

/// One GraphQL query searching `projects` of a GitLab host.
pub fn gitlab_search_query(projects: &[String], filters: &SearchFilters) -> String {
    let mut args: Vec<String> = Vec::new();
    if filters.state != "all" {
        args.push(format!("state: {}", filters.state));
    }
    if let Some(text) = filters.text.as_deref().filter(|t| !t.is_empty()) {
        args.push(format!("search: {}", quoted(text)));
    }
    if let Some(labels) = filters.labels.as_ref().filter(|l| !l.is_empty()) {
        let labels: Vec<String> = labels.iter().map(|l| quoted(l)).collect();
        args.push(format!("labels: [{}]", labels.join(", ")));
    }
    if let Some(author) = filters.author.as_deref().filter(|a| !a.is_empty()) {
        args.push(format!("authorUsername: {}", quoted(author)));
    }
    if let Some(after) = filters.updated_after.as_deref().filter(|a| !a.is_empty()) {
        args.push(format!("updatedAfter: {}", quoted(after)));
    }
    args.push("sort: UPDATED_DESC".into());
    args.push(format!("first: {}", filters.first));
    let args = args.join(", ");
    let parts: Vec<String> = projects
        .iter()
        .enumerate()
        .map(|(index, project)| {
            format!(
                "p{index}: project(fullPath: {}) {{ fullPath mergeRequests({args}) {{ nodes {{ {GITLAB_FIELDS} diffStats {{ path }} }} }} }}",
                quoted(project)
            )
        })
        .collect();
    format!("query {{ {} }}", parts.join(" "))
}

/// The search qualifier string of a GitHub search.
pub fn github_search_string(projects: &[String], filters: &SearchFilters) -> String {
    let mut words: Vec<String> = vec!["is:pr".into(), "archived:false".into()];
    words.extend(projects.iter().map(|p| format!("repo:{p}")));
    match filters.state.as_str() {
        "opened" => words.push("is:open".into()),
        "merged" => words.push("is:merged".into()),
        "closed" => words.extend(["is:closed".into(), "is:unmerged".into()]),
        _ => {}
    }
    for label in filters.labels.iter().flatten() {
        words.push(format!("label:\"{}\"", label.replace(['"', '\\'], "")));
    }
    if let Some(author) = filters.author.as_deref().filter(|a| !a.is_empty()) {
        words.push(format!("author:{author}"));
    }
    if let Some(after) = filters.updated_after.as_deref().filter(|a| !a.is_empty()) {
        words.push(format!("updated:>={}", js::head16(after, 10)));
    }
    if let Some(text) = filters.text.as_deref().filter(|t| !t.is_empty()) {
        words.push(NEWLINES.replace_all(text, " ").into_owned());
    }
    words.join(" ")
}

/// One GraphQL query searching `projects` of a GitHub host.
pub fn github_search_query(projects: &[String], filters: &SearchFilters) -> String {
    format!(
        "query {{ s: search(type: ISSUE, query: {}, first: {}) {{ nodes {{ ... on PullRequest {{ {GITHUB_FIELDS} files(first: {SEARCH_FILES}) {{ nodes {{ path }} }} }} }} }} }}",
        quoted(&github_search_string(projects, filters)),
        filters.first
    )
}

/// A changed path of a request found.
#[derive(Clone, Debug, PartialEq)]
pub struct PathChange {
    pub path: String,
    pub additions: f64,
    pub deletions: f64,
}

/// A request found, with what the inbox item does not carry.
#[derive(Clone, Debug, PartialEq)]
pub struct FoundRequest {
    pub item: Obj,
    pub labels: Vec<String>,
    pub description: Option<String>,
    /// Per changed path, when the forge said.
    pub changes: Option<Vec<PathChange>>,
}

impl FoundRequest {
    /// `{item, labels, description?, changes?}`.
    pub fn to_json(&self) -> Value {
        let mut out = Obj::new();
        out.insert("item".into(), Value::Object(self.item.clone()));
        out.insert("labels".into(), json!(self.labels));
        if let Some(description) = &self.description {
            out.insert("description".into(), json!(description));
        }
        if let Some(changes) = &self.changes {
            let changes: Vec<Value> = changes
                .iter()
                .map(|c| {
                    json!({"path": c.path, "additions": js::number(c.additions), "deletions": js::number(c.deletions)})
                })
                .collect();
            out.insert("changes".into(), Value::Array(changes));
        }
        Value::Object(out)
    }
}

fn node_list(value: Option<&Value>) -> &[Value] {
    value.and_then(Value::as_array).map_or(&[], Vec::as_slice)
}

fn labels_of(node: &Value) -> Vec<String> {
    node_list(node.get("labels").and_then(|l| l.get("nodes")))
        .iter()
        .map(|label| match (label.get("title"), label.get("name")) {
            (Some(Value::String(title)), _) => title.clone(),
            (_, Some(Value::String(name))) => name.clone(),
            _ => String::new(),
        })
        .filter(|label| !label.is_empty())
        .take(20)
        .map(|label| js::head16(&label, 80))
        .collect()
}

fn with_files(item: Obj, node: &Value) -> Obj {
    let raw = match (
        node.get("diffStats"),
        node.get("files").and_then(|f| f.get("nodes")),
    ) {
        (Some(Value::Array(list)), _) => list,
        (_, Some(Value::Array(list))) => list,
        _ => return item,
    };
    let files: Vec<Value> = raw
        .iter()
        .map(|entry| match entry.get("path") {
            Some(Value::String(path)) => js::head16(path, 400),
            _ => String::new(),
        })
        .filter(|path| !path.is_empty())
        .take(SEARCH_FILES)
        .map(Value::String)
        .collect();
    let mut item = item;
    item.insert("files".into(), Value::Array(files));
    item
}

fn answer_data<'a>(forge: &str, answer: &'a Value) -> Result<&'a Obj, String> {
    answer
        .get("data")
        .and_then(Value::as_object)
        .ok_or_else(|| {
            format!(
                "{forge}: {}",
                graphql_error(answer).unwrap_or_else(|| "no data in the answer".into())
            )
        })
}

/// A GitLab host's answer to [`gitlab_search_query`]: the requests found,
/// and the projects not seen.
pub fn parse_gitlab_search(
    host: &str,
    projects: &[String],
    answer: &Value,
) -> Result<(Vec<FoundRequest>, Vec<String>), String> {
    let data = answer_data("GitLab", answer)?;
    let mut found = Vec::new();
    let mut missing = Vec::new();
    for (index, project) in projects.iter().enumerate() {
        let entry = data.get(&format!("p{index}"));
        let Some(entry) = entry.filter(|e| js_truthy(e)) else {
            missing.push(project.clone());
            continue;
        };
        for node in node_list(entry.get("mergeRequests").and_then(|m| m.get("nodes"))) {
            if let Some(item) = gitlab_item(host, node) {
                found.push(FoundRequest {
                    item: with_files(item, node),
                    labels: labels_of(node),
                    description: None,
                    changes: None,
                });
            }
        }
    }
    Ok((found, missing))
}

/// A GitHub host's answer to [`github_search_query`].
pub fn parse_github_search(host: &str, answer: &Value) -> Result<Vec<FoundRequest>, String> {
    let data = answer_data("GitHub", answer)?;
    let mut found = Vec::new();
    for node in node_list(data.get("s").and_then(|s| s.get("nodes"))) {
        let Some(mut item) = github_item(host, node) else {
            continue;
        };
        // Not asked: the user's pending review is the inbox's to count.
        item.shift_remove("drafts");
        found.push(FoundRequest {
            item: with_files(item, node),
            labels: labels_of(node),
            description: None,
            changes: None,
        });
    }
    Ok(found)
}

/// One request with its changed files and description.
pub fn gitlab_request_query(reference: &ForgeRef) -> String {
    format!(
        "query {{ project(fullPath: {}) {{ mergeRequest(iid: {}) {{ {GITLAB_FIELDS} description diffStats {{ path additions deletions }} }} }} }}",
        quoted(&reference.project),
        quoted(&reference.number.to_string())
    )
}

pub fn github_request_query(reference: &ForgeRef) -> String {
    let mut parts = reference.project.split('/');
    let owner = parts.next().unwrap_or("");
    let name = parts.next().unwrap_or("");
    format!(
        "query {{ repository(owner: {}, name: {}) {{ pullRequest(number: {}) {{ {GITHUB_FIELDS} body files(first: 100) {{ nodes {{ path additions deletions }} }} }} }} }}",
        quoted(owner),
        quoted(name),
        reference.number
    )
}

fn number_or_zero(value: Option<&Value>) -> f64 {
    let number = js::to_number(value);
    if number.is_nan() { 0.0 } else { number }
}

fn changes_of(raw: Option<&Value>) -> Option<Vec<PathChange>> {
    let list = raw?.as_array()?;
    Some(
        list.iter()
            .map(|entry| PathChange {
                path: match entry.get("path") {
                    Some(Value::String(path)) => js::head16(path, 400),
                    _ => String::new(),
                },
                additions: number_or_zero(entry.get("additions")),
                deletions: number_or_zero(entry.get("deletions")),
            })
            .filter(|c| !c.path.is_empty())
            .take(200)
            .collect(),
    )
}

fn js_truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64().is_some_and(|n| n != 0.0 && !n.is_nan()),
        Value::String(s) => !s.is_empty(),
        _ => true,
    }
}

/// The answer to [`gitlab_request_query`] / [`github_request_query`], or
/// None when it is not that request.
pub fn parse_request(reference: &ForgeRef, answer: &Value) -> Result<Option<FoundRequest>, String> {
    let gitlab = reference.provider == "gitlab";
    let data = answer_data(if gitlab { "GitLab" } else { "GitHub" }, answer)?;
    let node = if gitlab {
        data.get("project").and_then(|p| p.get("mergeRequest"))
    } else {
        data.get("repository").and_then(|r| r.get("pullRequest"))
    };
    let Some(node) = node.filter(|n| js_truthy(n)) else {
        return Ok(None);
    };
    let item = if gitlab {
        gitlab_item(&reference.host, node)
    } else {
        github_item(&reference.host, node)
    };
    let Some(mut item) = item.filter(|i| js::sv(i.get("key")) == reference.key()) else {
        return Ok(None);
    };
    item.shift_remove("drafts");
    let changes = changes_of(if gitlab {
        node.get("diffStats")
    } else {
        node.get("files").and_then(|f| f.get("nodes"))
    });
    let text = match (node.get("description"), node.get("body")) {
        (Some(Value::String(text)), _) => text.clone(),
        (_, Some(Value::String(text))) => text.clone(),
        _ => String::new(),
    };
    if let Some(changes) = &changes {
        let files: Vec<Value> = changes
            .iter()
            .take(SEARCH_FILES)
            .map(|c| json!(c.path))
            .collect();
        item.insert("files".into(), Value::Array(files));
    }
    Ok(Some(FoundRequest {
        item,
        labels: labels_of(node),
        description: (!text.is_empty()).then(|| js::head16(&text, DESCRIPTION_KEPT)),
        changes,
    }))
}

/// What a request named by the agent is.
#[derive(Clone, Debug, PartialEq)]
pub enum RequestRef {
    Ref(ForgeRef),
    /// "!12" fits several of the known requests.
    Ambiguous(Vec<Obj>),
}

fn ref_of(item: &Obj) -> ForgeRef {
    ForgeRef {
        provider: js::sv(item.get("provider")).to_owned(),
        host: js::sv(item.get("host")).to_owned(),
        project: js::sv(item.get("project")).to_owned(),
        number: item.get("number").and_then(Value::as_f64).unwrap_or(0.0) as u64,
    }
}

fn checked_ref(provider: &str, host: &str, project: &str, digits: &str) -> Option<RequestRef> {
    let number: f64 = digits.parse().ok()?;
    (valid_project(project) && js::is_safe_integer(number) && number > 0.0).then(|| {
        RequestRef::Ref(ForgeRef {
            provider: provider.into(),
            host: host.into(),
            project: project.into(),
            number: number as u64,
        })
    })
}

fn number_is(item: &Obj, digits: &str) -> bool {
    let number: f64 = digits.parse().unwrap_or(f64::NAN);
    item.get("number").and_then(Value::as_f64) == Some(number)
}

/// `parseRequestRef`: a request as the agent names it: an inbox key, a
/// URL, "project!12" / "owner/repo#12", or "!12" / "#12" alone (found among
/// `known`). None when it names none; `Ambiguous` when "!12" fits several.
/// `hosts` are the settings' hosts (`{host, provider}`).
pub fn parse_request_ref(value: &str, known: &[Obj], hosts: &[Value]) -> Option<RequestRef> {
    let text = js::trim(value);
    let lower = js::js_lower(text);
    if let Some(item) = known.iter().find(|i| js::sv(i.get("key")) == lower) {
        return Some(RequestRef::Ref(ref_of(item)));
    }
    let host_of = |entry: &Value| js::sv(entry.get("host")).to_owned();
    let provider_of = |entry: &Value| js::sv(entry.get("provider")).to_owned();
    if let Some(url) = REQUEST_URL.captures(text) {
        let host = js::js_lower(&url[1]);
        let provider = if text.contains("/-/merge_requests/") {
            "gitlab"
        } else {
            "github"
        };
        let entry = hosts.iter().find(|entry| host_of(entry) == host)?;
        if provider_of(entry) != provider {
            return None;
        }
        return checked_ref(provider, &host, &url[2], &url[3]);
    }
    if let Some(full) = FULL_REF.captures(text) {
        let provider = if &full[2] == "!" { "gitlab" } else { "github" };
        let project = &full[1];
        let listed: Vec<&Obj> = known
            .iter()
            .filter(|item| {
                js::sv(item.get("provider")) == provider
                    && js::js_lower(js::sv(item.get("project"))) == js::js_lower(project)
                    && number_is(item, &full[3])
            })
            .collect();
        if listed.len() == 1 {
            return Some(RequestRef::Ref(ref_of(listed[0])));
        }
        let on: Vec<&Value> = hosts
            .iter()
            .filter(|entry| provider_of(entry) == provider)
            .collect();
        if on.len() != 1 {
            return (!listed.is_empty())
                .then(|| RequestRef::Ambiguous(listed.into_iter().cloned().collect()));
        }
        return checked_ref(provider, &host_of(on[0]), project, &full[3]);
    }
    if let Some(short) = SHORT_REF.captures(text) {
        let provider = if &short[1] == "!" { "gitlab" } else { "github" };
        let matches: Vec<&Obj> = known
            .iter()
            .filter(|item| js::sv(item.get("provider")) == provider && number_is(item, &short[2]))
            .collect();
        if matches.len() == 1 {
            return Some(RequestRef::Ref(ref_of(matches[0])));
        }
        if matches.len() > 1 {
            return Some(RequestRef::Ambiguous(
                matches.into_iter().cloned().collect(),
            ));
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn gl_node(iid: u64, extra: Value) -> Value {
        let mut node = json!({
            "iid": iid.to_string(),
            "title": format!("MR {iid}"),
            "webUrl": format!("https://gl.example/g/p/-/merge_requests/{iid}"),
            "draft": false,
            "state": "opened",
            "updatedAt": "2026-11-01T00:00:00Z",
            "userNotesCount": 1,
            "diffHeadSha": "a".repeat(40),
            "sourceBranch": "x",
            "targetBranch": "main",
            "project": {"fullPath": "g/p"},
            "author": {"username": "alice"},
            "headPipeline": null,
            "diffRefs": {"baseSha": "b".repeat(40)},
            "labels": {"nodes": [{"title": "ges"}]},
        });
        for (key, value) in extra.as_object().cloned().unwrap_or_default() {
            node[key] = value;
        }
        node
    }

    pub(crate) fn item(number: u64, extra: Value) -> Obj {
        let mut item = json!({
            "provider": "gitlab",
            "host": "gl.example",
            "project": "g/p",
            "number": number,
            "key": format!("gitlab:gl.example/g/p#{number}"),
            "url": format!("https://gl.example/g/p/-/merge_requests/{number}"),
            "title": format!("MR {number}"),
            "author": "alice",
            "draft": false,
            "state": "open",
            "updatedAt": "2026-11-01T00:00:00Z",
            "headSha": "a".repeat(40),
            "sourceBranch": "x",
            "targetBranch": "main",
            "pipeline": null,
            "notes": 0,
            "reasons": [],
        });
        for (key, value) in extra.as_object().cloned().unwrap_or_default() {
            item[key] = value;
        }
        item.as_object().cloned().unwrap()
    }

    fn strings(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| (*s).to_owned()).collect()
    }

    #[test]
    fn gitlab_one_read_only_query_the_models_words_quoted() {
        let query = gitlab_search_query(
            &strings(&["g/p", "g/q"]),
            &SearchFilters {
                text: Some("x\") } mutation { y".into()),
                labels: Some(strings(&["ges"])),
                author: Some("bob".into()),
                updated_after: Some("2026-10-01".into()),
                state: "opened".into(),
                first: 20,
            },
        );
        assert!(query.starts_with("query {"));
        // The injection stays inside its string.
        assert!(query.contains("search: \"x\\\") } mutation { y\""));
        assert!(query.contains("p1: project(fullPath: \"g/q\")"));
        assert!(query.contains("labels: [\"ges\"]"));
        assert!(query.contains("authorUsername: \"bob\""));
        assert!(query.contains("updatedAfter: \"2026-10-01\""));
        assert!(query.contains("state: opened"));
        let all = gitlab_search_query(
            &strings(&["g/p"]),
            &SearchFilters {
                state: "all".into(),
                first: 5,
                ..SearchFilters::default()
            },
        );
        assert!(!all.contains("state:"));
    }

    #[test]
    fn github_the_followed_repositories_and_filters_as_search_qualifiers() {
        assert_eq!(
            github_search_string(
                &strings(&["o/r"]),
                &SearchFilters {
                    text: Some("rtp jitter".into()),
                    labels: Some(strings(&["bug\"x"])),
                    author: Some("carol".into()),
                    updated_after: Some("2026-10-01T00:00:00Z".into()),
                    state: "merged".into(),
                    first: 10,
                }
            ),
            "is:pr archived:false repo:o/r is:merged label:\"bugx\" author:carol updated:>=2026-10-01 rtp jitter"
        );
        let query = github_search_query(
            &strings(&["o/r"]),
            &SearchFilters {
                state: "opened".into(),
                first: 3,
                ..SearchFilters::default()
            },
        );
        assert!(query.starts_with(
            "query { s: search(type: ISSUE, query: \"is:pr archived:false repo:o/r is:open\", first: 3)"
        ));
    }

    #[test]
    fn dates_iso_dates_and_days_back_nothing_else() {
        let now = js::date_parse("2026-11-04T12:00:00Z");
        assert_eq!(
            search_date(&json!("7d"), now).as_deref(),
            Some("2026-10-28")
        );
        assert_eq!(
            search_date(&json!("2026-10-01"), now).as_deref(),
            Some("2026-10-01")
        );
        assert_eq!(search_date(&json!("yesterday"), now), None);
        assert_eq!(search_date(&json!("2026-10-01\" }"), now), None);
    }

    #[test]
    fn answers_requests_with_their_files_and_labels_projects_not_seen() {
        let (found, missing) = parse_gitlab_search(
            "gl.example",
            &strings(&["g/p", "g/gone"]),
            &json!({"data": {
                "p0": {"mergeRequests": {"nodes": [gl_node(5, json!({"diffStats": [{"path": "ges/ges-clip.c"}]}))]}},
                "p1": null,
            }}),
        )
        .unwrap();
        assert_eq!(missing, strings(&["g/gone"]));
        assert_eq!(js::sv(found[0].item.get("key")), "gitlab:gl.example/g/p#5");
        assert_eq!(found[0].item["files"], json!(["ges/ges-clip.c"]));
        assert_eq!(found[0].labels, strings(&["ges"]));
        let github = parse_github_search(
            "github.com",
            &json!({"data": {"s": {"nodes": [{
                "number": 9, "title": "t", "url": "https://github.com/o/r/pull/9", "isDraft": false,
                "state": "OPEN", "updatedAt": "2026-11-01T00:00:00Z", "headRefOid": "c".repeat(40),
                "headRefName": "h", "baseRefName": "main", "repository": {"nameWithOwner": "o/r"},
                "author": {"login": "dan"}, "files": {"nodes": [{"path": "src/a.rs"}]},
                "labels": {"nodes": [{"name": "rtp"}]},
            }]}}}),
        )
        .unwrap();
        assert_eq!(github[0].item["files"], json!(["src/a.rs"]));
        assert!(github[0].item.get("drafts").is_none());
        assert_eq!(
            parse_gitlab_search("h", &[], &json!({"errors": [{"message": "no"}]})).unwrap_err(),
            "GitLab: no"
        );
    }

    #[test]
    fn one_request_its_changes_and_description() {
        let reference = ForgeRef {
            provider: "gitlab".into(),
            host: "gl.example".into(),
            project: "g/p".into(),
            number: 5,
        };
        assert!(gitlab_request_query(&reference).contains("mergeRequest(iid: \"5\")"));
        let found = parse_request(
            &reference,
            &json!({"data": {"project": {"mergeRequest": gl_node(5, json!({
                "description": "Fixes trimming.",
                "diffStats": [{"path": "ges/a.c", "additions": 3, "deletions": 1}],
            }))}}}),
        )
        .unwrap()
        .unwrap();
        assert_eq!(found.description.as_deref(), Some("Fixes trimming."));
        assert_eq!(
            found.to_json()["changes"],
            json!([{"path": "ges/a.c", "additions": 3, "deletions": 1}])
        );
        // Another request than the one asked is not taken.
        let other = ForgeRef {
            number: 6,
            ..reference
        };
        assert_eq!(
            parse_request(
                &other,
                &json!({"data": {"project": {"mergeRequest": gl_node(5, json!({}))}}})
            )
            .unwrap(),
            None
        );
    }

    #[test]
    fn a_request_named_as_the_agent_names_it() {
        let hosts = vec![
            json!({"host": "gl.example", "provider": "gitlab"}),
            json!({"host": "github.com", "provider": "github"}),
        ];
        let known = vec![
            item(12967, json!({})),
            item(
                3,
                json!({"project": "g/q", "key": "gitlab:gl.example/g/q#3"}),
            ),
            item(3, json!({})),
        ];
        let Some(RequestRef::Ref(found)) = parse_request_ref("!12967", &known, &hosts) else {
            panic!("not found");
        };
        assert_eq!((found.number, found.project.as_str()), (12967, "g/p"));
        let Some(RequestRef::Ambiguous(both)) = parse_request_ref("!3", &known, &hosts) else {
            panic!("not ambiguous");
        };
        assert_eq!(
            both.iter()
                .map(|i| js::sv(i.get("project")))
                .collect::<Vec<_>>(),
            ["g/q", "g/p"]
        );
        let Some(RequestRef::Ref(q)) = parse_request_ref("g/q!3", &known, &hosts) else {
            panic!("not found");
        };
        assert_eq!(q.project, "g/q");
        assert_eq!(
            parse_request_ref("other/x!8", &known, &hosts),
            Some(RequestRef::Ref(ForgeRef {
                provider: "gitlab".into(),
                host: "gl.example".into(),
                project: "other/x".into(),
                number: 8,
            }))
        );
        assert_eq!(
            parse_request_ref("https://github.com/o/r/pull/4", &known, &hosts),
            Some(RequestRef::Ref(ForgeRef {
                provider: "github".into(),
                host: "github.com".into(),
                project: "o/r".into(),
                number: 4,
            }))
        );
        // Not one of the user's hosts.
        assert_eq!(
            parse_request_ref("https://evil.example/o/r/pull/4", &known, &hosts),
            None
        );
        assert_eq!(parse_request_ref("!999", &known, &hosts), None);
    }
}
