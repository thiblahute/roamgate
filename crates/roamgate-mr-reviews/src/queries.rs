//! The inbox's forge queries and their parsers (`mr-reviews/queries.ts`):
//! one GraphQL query per host gives the user's requests and the followed
//! projects' open ones; the user's own requests come as a light list, then
//! details for those that changed. Pure. Held to `contract/vectors/mr-queries.json`.

use std::collections::BTreeSet;
use std::sync::LazyLock;

use regex::Regex;
use roamgate_agents::js::{self, Obj};
use serde_json::{Value, json};

use crate::forge_ref::{self, ForgeRef};

pub const INBOX_PAGE: usize = 50;
pub const FOLLOWED_PAGE: usize = 40;
pub const FILES_KEPT: usize = 40;

const GITLAB_FIELDS: &str = "iid title webUrl draft state updatedAt userNotesCount diffHeadSha sourceBranch targetBranch project { fullPath } author { username } headPipeline { status } diffRefs { baseSha } labels { nodes { title } }";

/// A part of the inbox query: the user's own lists, or a followed project by index.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum InboxPart {
    Mine,
    Followed(usize),
}

pub fn inbox_parts(followed: &[String]) -> Vec<InboxPart> {
    std::iter::once(InboxPart::Mine)
        .chain((0..followed.len()).map(InboxPart::Followed))
        .collect()
}

fn q(text: &str) -> String {
    js::quote(text)
}

/// One GraphQL query for a GitLab host.
pub fn gitlab_inbox_query(followed: &[String], parts: Option<&[InboxPart]>) -> String {
    let all = inbox_parts(followed);
    let parts = parts.unwrap_or(&all);
    let followed_parts: Vec<String> = parts
        .iter()
        .filter_map(|part| match part {
            InboxPart::Followed(index) => followed.get(*index).map(|project| {
                format!("f{index}: project(fullPath: {}) {{ fullPath mergeRequests(state: opened, sort: UPDATED_DESC, first: {FOLLOWED_PAGE}) {{ nodes {{ {GITLAB_FIELDS} diffStats {{ path }} }} }} }}", q(project))
            }),
            InboxPart::Mine => None,
        })
        .collect();
    let mine = if parts.contains(&InboxPart::Mine) {
        format!(
            "currentUser {{ username rr: reviewRequestedMergeRequests(state: opened, sort: UPDATED_DESC, first: {INBOX_PAGE}) {{ nodes {{ {GITLAB_FIELDS} }} }} as: assignedMergeRequests(state: opened, sort: UPDATED_DESC, first: {INBOX_PAGE}) {{ nodes {{ {GITLAB_FIELDS} }} }} todos(state: pending, action: [mentioned, directly_addressed], type: [MERGEREQUEST], first: {INBOX_PAGE}) {{ nodes {{ action target {{ ... on MergeRequest {{ {GITLAB_FIELDS} }} }} }} }} }} "
        )
    } else {
        String::new()
    };
    format!("query {{ {mine}{} }}", followed_parts.join(" "))
}

const GITHUB_FIELDS: &str = "number title url isDraft state updatedAt headRefOid baseRefOid headRefName baseRefName repository { nameWithOwner } author { login } comments { totalCount } reviewThreads { totalCount } commits(last: 1) { nodes { commit { statusCheckRollup { state } } } } reviews(states: PENDING, first: 1) { nodes { comments { totalCount } } } labels(first: 10) { nodes { name } }";

fn github_search(alias: &str, filter: &str) -> String {
    format!(
        "{alias}: search(type: ISSUE, query: {}, first: {INBOX_PAGE}) {{ nodes {{ ... on PullRequest {{ {GITHUB_FIELDS} }} }} }}",
        q(&format!("is:open is:pr archived:false {filter}"))
    )
}

fn owner_name(project: &str) -> Option<(&str, &str)> {
    let mut parts = project.split('/');
    let owner = parts.next().filter(|s| !s.is_empty())?;
    let name = parts.next().filter(|s| !s.is_empty())?;
    parts.next().is_none().then_some((owner, name))
}

/// One GraphQL query for a GitHub host.
pub fn github_inbox_query(followed: &[String], parts: Option<&[InboxPart]>) -> String {
    let all = inbox_parts(followed);
    let parts = parts.unwrap_or(&all);
    let followed_parts: Vec<String> = parts
        .iter()
        .filter_map(|part| match part {
            InboxPart::Followed(index) => {
                let (owner, name) = owner_name(followed.get(*index)?)?;
                Some(format!("f{index}: repository(owner: {}, name: {}) {{ nameWithOwner pullRequests(states: OPEN, first: {FOLLOWED_PAGE}, orderBy: {{field: UPDATED_AT, direction: DESC}}) {{ nodes {{ {GITHUB_FIELDS} files(first: {FILES_KEPT}) {{ nodes {{ path }} }} }} }} }}", q(owner), q(name)))
            }
            InboxPart::Mine => None,
        })
        .collect();
    let mine = if parts.contains(&InboxPart::Mine) {
        format!(
            "viewer {{ login }} {} {} {} ",
            github_search("rr", "review-requested:@me"),
            github_search("as", "assignee:@me"),
            github_search("mn", "mentions:@me")
        )
    } else {
        String::new()
    };
    format!("query {{ {mine}{} }}", followed_parts.join(" "))
}

/// The answers of a query asked in several parts, as one.
pub fn merge_answers(answers: &[Value]) -> Value {
    if answers.len() == 1 {
        return answers[0].clone();
    }
    let mut data = Obj::new();
    let mut errors: Vec<Value> = Vec::new();
    let mut any = false;
    for answer in answers {
        if let Some(list) = answer.get("errors").and_then(Value::as_array) {
            errors.extend(list.iter().cloned());
        }
        let Some(part) = answer.get("data").and_then(Value::as_object) else {
            continue;
        };
        any = true;
        for (key, value) in part {
            let merged = match (data.get(key), value) {
                (Some(Value::Object(before)), Value::Object(after)) => {
                    Value::Object(js::spread(before.clone(), after))
                }
                _ => value.clone(),
            };
            data.insert(key.clone(), merged);
        }
    }
    let mut out = Obj::new();
    if any {
        out.insert("data".into(), Value::Object(data));
    }
    if !errors.is_empty() {
        out.insert("errors".into(), Value::Array(errors));
    }
    Value::Object(out)
}

fn text(value: Option<&Value>, max: usize) -> String {
    value
        .and_then(Value::as_str)
        .map(|s| js::head16(s, max))
        .unwrap_or_default()
}

fn count(value: Option<&Value>) -> f64 {
    let number = js::to_number(value);
    if js::is_safe_integer(number) && number >= 0.0 {
        number
    } else {
        0.0
    }
}

static SHA: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)^[0-9a-f]{7,64}$").expect("pattern"));

fn sha(value: Option<&Value>) -> String {
    value
        .and_then(Value::as_str)
        .filter(|s| SHA.is_match(s))
        .map(str::to_lowercase)
        .unwrap_or_default()
}

fn gitlab_state(value: Option<&Value>) -> &'static str {
    match text(value, 20).to_lowercase().as_str() {
        "merged" => "merged",
        "closed" => "closed",
        "locked" => "locked",
        _ => "open",
    }
}

fn github_state(value: Option<&Value>) -> &'static str {
    match value.and_then(Value::as_str) {
        Some("MERGED") => "merged",
        Some("CLOSED") => "closed",
        _ => "open",
    }
}

fn nodes(value: Option<&Value>) -> Vec<Value> {
    value
        .and_then(|v| v.get("nodes"))
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
}

fn path<'a>(value: &'a Value, keys: &[&str]) -> Option<&'a Value> {
    let mut at = value;
    for key in keys {
        at = at.get(*key)?;
    }
    Some(at)
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

fn labels_of(value: Option<&Value>, field: &str, out: &mut Obj) {
    let Some(list) = value.and_then(|v| v.get("nodes")).and_then(Value::as_array) else {
        return;
    };
    let labels: Vec<Value> = list
        .iter()
        .map(|node| text(node.get(field), 60))
        .filter(|s| !s.is_empty())
        .take(10)
        .map(Value::String)
        .collect();
    if !labels.is_empty() {
        out.insert("labels".into(), Value::Array(labels));
    }
}

fn reference(provider: &str, host: &str, project: &str, number: &Value) -> Option<ForgeRef> {
    let number = js::to_number(Some(number));
    if !forge_ref::valid_project(project) || !js::is_safe_integer(number) || number <= 0.0 {
        return None;
    }
    Some(ForgeRef {
        provider: provider.into(),
        host: host.into(),
        project: project.into(),
        number: number as u64,
    })
}

/// A GitLab merge request node, or None when it is not one we can trust.
pub fn gitlab_item(host: &str, node: &Value) -> Option<Obj> {
    let mr = node.as_object()?;
    let project = text(path(node, &["project", "fullPath"]), 300);
    let reference = reference(
        "gitlab",
        host,
        &project,
        mr.get("iid").unwrap_or(&Value::Null),
    )?;
    let url = forge_ref::own_request_url(&reference, mr.get("webUrl"))?;
    let pipeline = if truthy(mr.get("headPipeline")) {
        json!(forge_ref::gitlab_pipeline_status(
            &text(path(node, &["headPipeline", "status"]), 40).to_lowercase()
        ))
    } else {
        Value::Null
    };
    let files = mr.get("diffStats").and_then(Value::as_array).map(|stats| {
        stats
            .iter()
            .map(|stat| text(stat.get("path"), 400))
            .filter(|s| !s.is_empty())
            .take(FILES_KEPT)
            .map(Value::String)
            .collect::<Vec<_>>()
    });
    let mut out = reference.to_obj();
    out.insert("key".into(), json!(reference.key()));
    out.insert("url".into(), json!(url));
    out.insert("title".into(), json!(text(mr.get("title"), 300)));
    out.insert(
        "author".into(),
        json!(text(path(node, &["author", "username"]), 100)),
    );
    out.insert("draft".into(), json!(js::is_true(mr.get("draft"))));
    out.insert("state".into(), json!(gitlab_state(mr.get("state"))));
    out.insert("updatedAt".into(), json!(text(mr.get("updatedAt"), 40)));
    out.insert("headSha".into(), json!(sha(mr.get("diffHeadSha"))));
    let base = sha(path(node, &["diffRefs", "baseSha"]));
    if !base.is_empty() {
        out.insert("baseSha".into(), json!(base));
    }
    out.insert(
        "sourceBranch".into(),
        json!(text(mr.get("sourceBranch"), 300)),
    );
    out.insert(
        "targetBranch".into(),
        json!(text(mr.get("targetBranch"), 300)),
    );
    out.insert("pipeline".into(), pipeline);
    out.insert("notes".into(), js::number(count(mr.get("userNotesCount"))));
    out.insert("reasons".into(), json!([]));
    if let Some(files) = files {
        out.insert("files".into(), Value::Array(files));
    }
    labels_of(mr.get("labels"), "title", &mut out);
    Some(out)
}

/// A GitHub pull request node, or None.
pub fn github_item(host: &str, node: &Value) -> Option<Obj> {
    let pr = node.as_object()?;
    let project = text(path(node, &["repository", "nameWithOwner"]), 300);
    let reference = reference(
        "github",
        host,
        &project,
        pr.get("number").unwrap_or(&Value::Null),
    )?;
    let url = forge_ref::own_request_url(&reference, pr.get("url"))?;
    let rollup = path(node, &["commits", "nodes"])
        .and_then(|n| n.get(0))
        .and_then(|n| path(n, &["commit", "statusCheckRollup"]))
        .filter(|r| truthy(Some(r)));
    let pipeline = match rollup {
        Some(rollup) => json!(forge_ref::github_pipeline_status(rollup.get("state"))),
        None => Value::Null,
    };
    let pending = path(node, &["reviews", "nodes"]).and_then(|n| n.get(0));
    let files = path(node, &["files", "nodes"])
        .and_then(Value::as_array)
        .map(|list| {
            list.iter()
                .map(|f| text(f.get("path"), 400))
                .filter(|s| !s.is_empty())
                .take(FILES_KEPT)
                .map(Value::String)
                .collect::<Vec<_>>()
        });
    let mut out = reference.to_obj();
    out.insert("key".into(), json!(reference.key()));
    out.insert("url".into(), json!(url));
    out.insert("title".into(), json!(text(pr.get("title"), 300)));
    out.insert(
        "author".into(),
        json!(text(path(node, &["author", "login"]), 100)),
    );
    out.insert("draft".into(), json!(js::is_true(pr.get("isDraft"))));
    out.insert("state".into(), json!(github_state(pr.get("state"))));
    out.insert("updatedAt".into(), json!(text(pr.get("updatedAt"), 40)));
    out.insert("headSha".into(), json!(sha(pr.get("headRefOid"))));
    let base = sha(pr.get("baseRefOid"));
    if !base.is_empty() {
        out.insert("baseSha".into(), json!(base));
    }
    out.insert(
        "sourceBranch".into(),
        json!(text(pr.get("headRefName"), 300)),
    );
    out.insert(
        "targetBranch".into(),
        json!(text(pr.get("baseRefName"), 300)),
    );
    out.insert("pipeline".into(), pipeline);
    let notes = count(path(node, &["comments", "totalCount"]))
        + count(path(node, &["reviewThreads", "totalCount"]));
    out.insert("notes".into(), js::number(notes));
    out.insert("reasons".into(), json!([]));
    let drafts = match pending.filter(|p| truthy(Some(p))) {
        Some(p) => count(path(p, &["comments", "totalCount"])),
        None => 0.0,
    };
    out.insert("drafts".into(), js::number(drafts));
    if let Some(files) = files {
        out.insert("files".into(), Value::Array(files));
    }
    labels_of(pr.get("labels"), "name", &mut out);
    Some(out)
}

/// A host's answer: the user, their requests with why, the followed projects' open ones, and the followed projects missing.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct HostAnswer {
    pub user: String,
    pub mine: Vec<Obj>,
    pub followed: Vec<Obj>,
    pub missing: Vec<String>,
}

impl HostAnswer {
    pub fn to_json(&self) -> Value {
        json!({"user": self.user, "mine": self.mine, "followed": self.followed, "missing": self.missing})
    }
}

/// Adds an item to a list by key, merging why it is there.
fn add_item(list: &mut Vec<Obj>, item: Obj, reason: Option<&str>) {
    let key = js::sv(item.get("key")).to_owned();
    let known = list.iter().position(|e| js::sv(e.get("key")) == key);
    let mut reasons: Vec<Value> = Vec::new();
    let push = |reasons: &mut Vec<Value>, r: &Value| {
        if !reasons.contains(r) {
            reasons.push(r.clone());
        }
    };
    if let Some(at) = known {
        for r in list[at]
            .get("reasons")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            push(&mut reasons, r);
        }
    }
    for r in item
        .get("reasons")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        push(&mut reasons, r);
    }
    if let Some(reason) = reason {
        push(&mut reasons, &json!(reason));
    }
    match known {
        Some(at) => {
            list[at].insert("reasons".into(), Value::Array(reasons));
        }
        None => {
            let mut item = item;
            item.insert("reasons".into(), Value::Array(reasons));
            list.push(item);
        }
    }
}

fn no_data(forge: &str, answer: &Value) -> String {
    format!(
        "{forge}: {}",
        graphql_error(answer).unwrap_or_else(|| "no data in the answer".into())
    )
}

/// A GitLab host's answer to [`gitlab_inbox_query`].
pub fn parse_gitlab_inbox(
    host: &str,
    followed: &[String],
    answer: &Value,
) -> Result<HostAnswer, String> {
    let data = answer
        .get("data")
        .filter(|d| d.is_object())
        .ok_or_else(|| no_data("GitLab", answer))?;
    let user = data
        .get("currentUser")
        .filter(|u| truthy(Some(u)))
        .ok_or("GitLab: not signed in")?;
    let mut mine = Vec::new();
    for node in nodes(user.get("rr")) {
        if let Some(item) = gitlab_item(host, &node) {
            add_item(&mut mine, item, Some("review_requested"));
        }
    }
    for node in nodes(user.get("as")) {
        if let Some(item) = gitlab_item(host, &node) {
            add_item(&mut mine, item, Some("assigned"));
        }
    }
    for todo in nodes(user.get("todos")) {
        if let Some(item) = todo.get("target").and_then(|t| gitlab_item(host, t))
            && js::sv(item.get("state")) == "open"
        {
            add_item(&mut mine, item, Some("mentioned"));
        }
    }
    let mut followed_items = Vec::new();
    let mut missing = Vec::new();
    for (index, project) in followed.iter().enumerate() {
        let Some(entry) = data.get(format!("f{index}")).filter(|e| truthy(Some(e))) else {
            missing.push(project.clone());
            continue;
        };
        for node in nodes(entry.get("mergeRequests")) {
            if let Some(item) = gitlab_item(host, &node) {
                add_item(&mut followed_items, item, None);
            }
        }
    }
    Ok(HostAnswer {
        user: text(user.get("username"), 100),
        mine,
        followed: followed_items,
        missing,
    })
}

/// A GitHub host's answer to [`github_inbox_query`].
pub fn parse_github_inbox(
    host: &str,
    followed: &[String],
    answer: &Value,
) -> Result<HostAnswer, String> {
    let data = answer
        .get("data")
        .filter(|d| d.is_object())
        .ok_or_else(|| no_data("GitHub", answer))?;
    let mut mine = Vec::new();
    for (alias, reason) in [
        ("rr", "review_requested"),
        ("as", "assigned"),
        ("mn", "mentioned"),
    ] {
        for node in nodes(data.get(alias)) {
            if let Some(item) = github_item(host, &node) {
                add_item(&mut mine, item, Some(reason));
            }
        }
    }
    let mut followed_items = Vec::new();
    let mut missing = Vec::new();
    for (index, project) in followed.iter().enumerate() {
        let Some(entry) = data.get(format!("f{index}")).filter(|e| truthy(Some(e))) else {
            missing.push(project.clone());
            continue;
        };
        for node in nodes(entry.get("pullRequests")) {
            if let Some(item) = github_item(host, &node) {
                add_item(&mut followed_items, item, None);
            }
        }
    }
    Ok(HostAnswer {
        user: text(path(data, &["viewer", "login"]), 100),
        mine,
        followed: followed_items,
        missing,
    })
}

pub const OWN_PAGE: usize = 100;
pub const OWN_MAX_PAGES: usize = 10;
pub const OWN_SETTLED_PAGE: usize = 10;
pub const OWN_DETAILS_BATCH: usize = 40;

const GITLAB_OWN_LIST: &str = "iid title webUrl draft state updatedAt diffHeadSha sourceBranch targetBranch project { fullPath } author { username } labels { nodes { title } }";
const GITLAB_OWN_DETAILS: &str = "iid webUrl updatedAt diffHeadSha userNotesCount project { fullPath } headPipeline { status } diffRefs { baseSha }";
const GITLAB_STATUS_FIELDS: &str = "conflicts shouldBeRebased approved detailedMergeStatus approvedBy { nodes { username } } resolvableDiscussionsCount resolvedDiscussionsCount description discussions(last: 10) { nodes { resolvable resolved notes(last: 1) { nodes { author { username } createdAt body system } } } }";

/// The level of the own requests' details asked: "full", "nomerge" or "basic".
pub fn gitlab_own_fields(fields: &str) -> String {
    match fields {
        "full" => format!(
            "{GITLAB_STATUS_FIELDS} assignees {{ nodes {{ username }} }} reviewers {{ nodes {{ username }} }} autoMergeEnabled mergeUser {{ username }}"
        ),
        "nomerge" => GITLAB_STATUS_FIELDS.to_owned(),
        _ => "conflicts shouldBeRebased".to_owned(),
    }
}

/// The level asked after a host refused one.
pub fn lesser_own_fields(provider: &str, fields: &str) -> Option<&'static str> {
    match fields {
        "full" => Some("nomerge"),
        "nomerge" if provider == "gitlab" => Some("basic"),
        _ => None,
    }
}

const GITHUB_OWN_LIST: &str = "number title url isDraft state updatedAt headRefOid headRefName baseRefName repository { nameWithOwner } author { login } labels(first: 10) { nodes { name } }";
const GITHUB_OWN_DETAILS: &str = "number url updatedAt headRefOid baseRefOid repository { nameWithOwner } comments { totalCount } reviewThreads { totalCount } commits(last: 1) { nodes { commit { statusCheckRollup { state } } } } reviews(states: PENDING, first: 1) { nodes { comments { totalCount } } } mergeable reviewDecision latestOpinionatedReviews(first: 20) { nodes { state submittedAt author { login } } } openThreads: reviewThreads(first: 100) { nodes { isResolved } } body lastComments: comments(last: 5) { nodes { author { login } createdAt body } } lastThreads: reviewThreads(last: 20) { nodes { isResolved comments(last: 1) { nodes { author { login } createdAt body } } } }";
const GITHUB_MERGE_FIELDS: &str = "assignees(first: 10) { nodes { login } } reviewRequests(first: 10) { nodes { requestedReviewer { ... on User { login } ... on Bot { login } ... on Mannequin { login } } } } autoMergeRequest { enabledAt enabledBy { login } } mergeQueueEntry { position enqueuedAt } mergeTimeline: timelineItems(last: 30, itemTypes: [LABELED_EVENT, ASSIGNED_EVENT, UNASSIGNED_EVENT, REVIEW_REQUESTED_EVENT, REVIEW_REQUEST_REMOVED_EVENT, ADDED_TO_MERGE_QUEUE_EVENT, REMOVED_FROM_MERGE_QUEUE_EVENT, AUTO_MERGE_ENABLED_EVENT, AUTO_MERGE_DISABLED_EVENT]) { nodes { __typename ... on LabeledEvent { createdAt actor { login } label { name } } ... on AssignedEvent { createdAt actor { login } assignee { ... on User { login } ... on Bot { login } ... on Mannequin { login } } } ... on UnassignedEvent { createdAt actor { login } assignee { ... on User { login } ... on Bot { login } ... on Mannequin { login } } } ... on ReviewRequestedEvent { createdAt actor { login } requestedReviewer { ... on User { login } ... on Bot { login } ... on Mannequin { login } } } ... on ReviewRequestRemovedEvent { createdAt actor { login } requestedReviewer { ... on User { login } ... on Bot { login } ... on Mannequin { login } } } ... on AddedToMergeQueueEvent { createdAt actor { login } } ... on RemovedFromMergeQueueEvent { createdAt actor { login } reason } ... on AutoMergeEnabledEvent { createdAt actor { login } } ... on AutoMergeDisabledEvent { createdAt actor { login } reason } } }";
const PAGE_INFO: &str = "pageInfo { hasNextPage endCursor }";

/// The lists of an own-requests page: "op", and on the first page "mg" and "cl" (GitLab) or "st" (GitHub).
pub fn own_list_parts(provider: &str, after: Option<&str>) -> Vec<&'static str> {
    if after.is_some_and(|a| !a.is_empty()) {
        return vec!["op"];
    }
    if provider == "gitlab" {
        vec!["op", "mg", "cl"]
    } else {
        vec!["op", "st"]
    }
}

fn after_arg(after: Option<&str>) -> String {
    match after.filter(|a| !a.is_empty()) {
        Some(after) => format!(", after: {}", q(after)),
        None => String::new(),
    }
}

/// One page of the user's open merge requests on a GitLab host.
pub fn gitlab_own_list_query(after: Option<&str>, parts: Option<&[&str]>) -> String {
    let default = own_list_parts("gitlab", after);
    let parts = parts.unwrap_or(&default);
    let open = if parts.contains(&"op") {
        format!(
            " op: authoredMergeRequests(state: opened, sort: CREATED_DESC, first: {OWN_PAGE}{}) {{ {PAGE_INFO} nodes {{ {GITLAB_OWN_LIST} }} }}",
            after_arg(after)
        )
    } else {
        String::new()
    };
    let settled: String = [("mg", "merged"), ("cl", "closed")]
        .iter()
        .filter(|(alias, _)| parts.contains(alias))
        .map(|(alias, state)| format!(" {alias}: authoredMergeRequests(state: {state}, sort: UPDATED_DESC, first: {OWN_SETTLED_PAGE}) {{ nodes {{ {GITLAB_OWN_LIST} }} }}"))
        .collect();
    format!("query {{ currentUser {{ username{open}{settled} }} }}")
}

/// One page of the user's open pull requests on a GitHub host.
pub fn github_own_list_query(after: Option<&str>, parts: Option<&[&str]>) -> String {
    let default = own_list_parts("github", after);
    let parts = parts.unwrap_or(&default);
    let open = if parts.contains(&"op") {
        format!(
            " op: search(type: ISSUE, query: {}, first: {OWN_PAGE}{}) {{ {PAGE_INFO} nodes {{ ... on PullRequest {{ {GITHUB_OWN_LIST} }} }} }}",
            q("is:pr is:open author:@me archived:false sort:created-desc"),
            after_arg(after)
        )
    } else {
        String::new()
    };
    let settled = if parts.contains(&"st") {
        format!(
            " st: search(type: ISSUE, query: {}, first: {OWN_SETTLED_PAGE}) {{ nodes {{ ... on PullRequest {{ {GITHUB_OWN_LIST} }} }} }}",
            q("is:pr is:closed author:@me archived:false sort:updated-desc")
        )
    } else {
        String::new()
    };
    format!("query {{ viewer {{ login }}{open}{settled} }}")
}

/// A page of own requests: the items, and the next page's cursor.
pub fn parse_own_list(
    provider: &str,
    host: &str,
    answer: &Value,
) -> Result<(Vec<Obj>, Option<String>), String> {
    let forge = if provider == "gitlab" {
        "GitLab"
    } else {
        "GitHub"
    };
    let data = answer
        .get("data")
        .filter(|d| d.is_object())
        .ok_or_else(|| no_data(forge, answer))?;
    let root = if provider == "gitlab" {
        data.get("currentUser")
    } else {
        Some(data)
    };
    let root = root
        .filter(|r| truthy(Some(r)))
        .ok_or("GitLab: not signed in")?;
    let lists: &[&str] = if provider == "gitlab" {
        &["op", "mg", "cl"]
    } else {
        &["op", "st"]
    };
    let mut items = Vec::new();
    for list in lists {
        for node in nodes(root.get(*list)) {
            let item = if provider == "gitlab" {
                gitlab_item(host, &node)
            } else {
                github_item(host, &node)
            };
            if let Some(mut item) = item {
                item.insert("reasons".into(), json!(["authored"]));
                items.push(item);
            }
        }
    }
    let info = path(root, &["op", "pageInfo"]);
    let next = match info {
        Some(info) if js::is_true(info.get("hasNextPage")) => info
            .get("endCursor")
            .and_then(Value::as_str)
            .map(|c| js::head16(c, 500)),
        _ => None,
    };
    Ok((items, next))
}

/// The details of some own requests: one alias per project.
pub fn own_details_query(provider: &str, items: &[(String, u64)], fields: &str) -> String {
    let mut by_project: Vec<(String, Vec<u64>)> = Vec::new();
    for (project, number) in items {
        match by_project.iter_mut().find(|(p, _)| p == project) {
            Some((_, numbers)) => numbers.push(*number),
            None => by_project.push((project.clone(), vec![*number])),
        }
    }
    let parts: Vec<String> = by_project
        .iter()
        .enumerate()
        .filter_map(|(index, (project, numbers))| {
            if provider == "gitlab" {
                let iids: Vec<String> = numbers.iter().map(u64::to_string).collect();
                return Some(format!(
                    "p{index}: project(fullPath: {}) {{ mergeRequests(iids: {}, first: {}) {{ nodes {{ {GITLAB_OWN_DETAILS} {} }} }} }}",
                    q(project),
                    js::stringify(&json!(iids)),
                    numbers.len(),
                    gitlab_own_fields(fields)
                ));
            }
            let (owner, name) = owner_name(project)?;
            let merge = if fields == "full" { format!(" {GITHUB_MERGE_FIELDS}") } else { String::new() };
            let pulls: Vec<String> = numbers
                .iter()
                .map(|n| format!("n{n}: pullRequest(number: {n}) {{ {GITHUB_OWN_DETAILS}{merge} }}"))
                .collect();
            Some(format!("p{index}: repository(owner: {}, name: {}) {{ {} }}", q(owner), q(name), pulls.join(" ")))
        })
        .collect();
    format!("query {{ {} }}", parts.join(" "))
}

pub const OWN_DESCRIPTION_KEPT: usize = 1500;
pub const OWN_NOTES_KEPT: usize = 10;
const OWN_NOTE_BODY: usize = 300;

static SPACES: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\s+").expect("pattern"));

fn squash(text: &str) -> String {
    js::trim(&SPACES.replace_all(text, " ")).to_owned()
}

/// The last notes of a request's discussions or comments, oldest first.
pub fn own_notes(provider: &str, node: &Value) -> Vec<Obj> {
    let mut out: Vec<Obj> = Vec::new();
    let mut add = |note: &Value, resolvable: bool, resolved: bool, login: Option<&Value>| {
        if !note.is_object() || js::is_true(note.get("system")) {
            return;
        }
        let body = squash(&text(note.get("body"), 2000));
        if body.is_empty() {
            return;
        }
        let mut o = Obj::new();
        o.insert("author".into(), json!(text(login, 100)));
        o.insert("at".into(), json!(text(note.get("createdAt"), 40)));
        o.insert("body".into(), json!(js::head16(&body, OWN_NOTE_BODY)));
        o.insert("resolvable".into(), json!(resolvable));
        o.insert("resolved".into(), json!(resolved));
        out.push(o);
    };
    if provider == "gitlab" {
        for discussion in nodes(node.get("discussions")) {
            for note in nodes(discussion.get("notes")) {
                add(
                    &note,
                    js::is_true(discussion.get("resolvable")),
                    js::is_true(discussion.get("resolved")),
                    path(&note, &["author", "username"]),
                );
            }
        }
    } else {
        for comment in nodes(node.get("lastComments")) {
            add(&comment, false, false, path(&comment, &["author", "login"]));
        }
        for thread in nodes(node.get("lastThreads")) {
            for comment in nodes(thread.get("comments")) {
                add(
                    &comment,
                    true,
                    js::is_true(thread.get("isResolved")),
                    path(&comment, &["author", "login"]),
                );
            }
        }
    }
    out.sort_by(|a, b| js::locale_compare(js::sv(a.get("at")), js::sv(b.get("at"))));
    let skip = out.len().saturating_sub(OWN_NOTES_KEPT);
    out.split_off(skip)
}

fn login(value: Option<&Value>) -> String {
    let value = value.unwrap_or(&Value::Null);
    let name = value
        .get("login")
        .filter(|v| !v.is_null())
        .or_else(|| value.get("username"));
    text(name, 100)
}

static MENTION: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"@([A-Za-z0-9_.-]+)").expect("pattern"));

fn mentioned(clause: &str) -> Vec<Value> {
    MENTION
        .captures_iter(clause)
        .map(|c| json!(c[1].to_owned()))
        .collect()
}

macro_rules! event_regex {
    ($name:ident, $pattern:literal) => {
        static $name: LazyLock<Regex> = LazyLock::new(|| Regex::new($pattern).expect("pattern"));
    };
}
event_regex!(
    ASSIGNED,
    r"(?i)\bassigned to ((?:@[A-Za-z0-9_.-]+(?:,\s*|\s+and\s+)?)+)"
);
event_regex!(
    UNASSIGNED,
    r"(?i)\bunassigned ((?:@[A-Za-z0-9_.-]+(?:,\s*|\s+and\s+)?)+)"
);
event_regex!(
    REQUESTED,
    r"(?i)\brequested reviews? from ((?:@[A-Za-z0-9_.-]+(?:,\s*|\s+and\s+)?)+)"
);
event_regex!(
    REMOVED,
    r"(?i)\bremoved review requests? for ((?:@[A-Za-z0-9_.-]+(?:,\s*|\s+and\s+)?)+)"
);
event_regex!(APPROVED, r"(?i)^approved this merge request");
event_regex!(
    AUTO_ON,
    r"(?i)\b(enabled an automatic merge|set to auto-merge|enabled auto-merge)"
);
event_regex!(
    ABORTED,
    r"(?i)\b(?:aborted|canceled|cancelled) the automatic merge(?: because (.*))?"
);

fn event(at: &str, actor: &str, kind: &str) -> Obj {
    let mut o = Obj::new();
    o.insert("at".into(), json!(at));
    if !actor.is_empty() {
        o.insert("actor".into(), json!(actor));
    }
    o.insert("kind".into(), json!(kind));
    o
}

/// A GitLab system note read as merge events.
pub fn gitlab_system_events(body: &str, at: &str, actor: &str) -> Vec<Obj> {
    let mut out = Vec::new();
    let with_who = |kind: &str, re: &Regex, out: &mut Vec<Obj>| {
        if let Some(c) = re.captures(body) {
            let mut e = event(at, actor, kind);
            e.insert("who".into(), Value::Array(mentioned(&c[1])));
            out.push(e);
        }
    };
    with_who("assigned", &ASSIGNED, &mut out);
    with_who("unassigned", &UNASSIGNED, &mut out);
    with_who("review_requested", &REQUESTED, &mut out);
    with_who("review_removed", &REMOVED, &mut out);
    if APPROVED.is_match(body) {
        out.push(event(at, actor, "approved"));
    }
    if AUTO_ON.is_match(body) {
        out.push(event(at, actor, "auto_merge_on"));
    }
    if let Some(c) = ABORTED.captures(body) {
        let reason = c.get(1).map_or("canceled", |m| m.as_str());
        let mut e = event(at, actor, "auto_merge_off");
        e.insert("reason".into(), json!(js::head16(&squash(reason), 200)));
        out.push(e);
    }
    out
}

fn github_event(node: &Value) -> Option<Obj> {
    let at = text(node.get("createdAt"), 40);
    if at.is_empty() {
        return None;
    }
    let actor = login(node.get("actor"));
    let who = |value: Option<&Value>| {
        let name = login(value);
        if name.is_empty() {
            json!([])
        } else {
            json!([name])
        }
    };
    let reason = || squash_reason(node.get("reason"));
    let with = |kind: &str, extra: Option<(&str, Value)>| {
        let mut e = event(&at, &actor, kind);
        if let Some((k, v)) = extra {
            e.insert(k.into(), v);
        }
        Some(e)
    };
    match js::sv(node.get("__typename")) {
        "LabeledEvent" => {
            let label = text(path(node, &["label", "name"]), 60);
            if label.is_empty() {
                None
            } else {
                with("labeled", Some(("label", json!(label))))
            }
        }
        "AssignedEvent" => with("assigned", Some(("who", who(node.get("assignee"))))),
        "UnassignedEvent" => with("unassigned", Some(("who", who(node.get("assignee"))))),
        "ReviewRequestedEvent" => with(
            "review_requested",
            Some(("who", who(node.get("requestedReviewer")))),
        ),
        "ReviewRequestRemovedEvent" => with(
            "review_removed",
            Some(("who", who(node.get("requestedReviewer")))),
        ),
        "AddedToMergeQueueEvent" => with("queued", None),
        "RemovedFromMergeQueueEvent" => {
            let r = reason();
            with("dequeued", (!r.is_empty()).then(|| ("reason", json!(r))))
        }
        "AutoMergeEnabledEvent" => with("auto_merge_on", None),
        "AutoMergeDisabledEvent" => {
            let r = reason();
            with(
                "auto_merge_off",
                (!r.is_empty()).then(|| ("reason", json!(r))),
            )
        }
        _ => None,
    }
}

fn squash_reason(value: Option<&Value>) -> String {
    text(value, 200).replace('_', " ").to_lowercase()
}

const MERGE_EVENTS_KEPT: usize = 20;

fn names(list: Option<&Value>, field: impl Fn(&Value) -> Option<&Value>) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for node in nodes(list) {
        let name = text(field(&node), 100);
        if !name.is_empty() && !out.contains(&name) {
            out.push(name);
        }
    }
    out
}

/// What the details say about merging, when the "full" fields were asked.
pub fn own_merge_facts(provider: &str, node: &Value) -> Option<Obj> {
    let object = node.as_object()?;
    if !object.contains_key("assignees") {
        return None;
    }
    let mut events: Vec<Obj> = Vec::new();
    let mut approved_at: Option<String> = None;
    let mut labels_added_at = Obj::new();
    if provider == "gitlab" {
        for discussion in nodes(node.get("discussions")) {
            for note in nodes(discussion.get("notes")) {
                if !js::is_true(note.get("system")) {
                    continue;
                }
                events.extend(gitlab_system_events(
                    &text(note.get("body"), 500),
                    &text(note.get("createdAt"), 40),
                    &text(path(&note, &["author", "username"]), 100),
                ));
            }
        }
    } else {
        for each in nodes(node.get("mergeTimeline")) {
            let Some(event) = github_event(&each) else {
                continue;
            };
            if js::sv(event.get("kind")) == "labeled" && !js::sv(event.get("label")).is_empty() {
                let label = js::sv(event.get("label")).to_owned();
                labels_added_at.insert(label, event.get("at").cloned().unwrap_or(Value::Null));
            } else {
                events.push(event);
            }
        }
        for review in nodes(node.get("latestOpinionatedReviews")) {
            if js::sv(review.get("state")) == "APPROVED" {
                let at = text(review.get("submittedAt"), 40);
                if !at.is_empty()
                    && approved_at
                        .as_ref()
                        .is_none_or(|a| at.as_str() > a.as_str())
                {
                    approved_at = Some(at);
                }
            }
        }
    }
    events.sort_by(|a, b| js::locale_compare(js::sv(a.get("at")), js::sv(b.get("at"))));
    for event in &events {
        let at = js::sv(event.get("at"));
        if js::sv(event.get("kind")) == "approved"
            && approved_at.as_ref().is_none_or(|a| at > a.as_str())
        {
            approved_at = Some(at.to_owned());
        }
    }
    let auto_merge = if provider == "gitlab" {
        js::is_true(node.get("autoMergeEnabled")).then(|| {
            let by = login(node.get("mergeUser"));
            let mut o = Obj::new();
            if !by.is_empty() {
                o.insert("by".into(), json!(by));
            }
            o
        })
    } else {
        node.get("autoMergeRequest")
            .filter(|a| truthy(Some(a)))
            .map(|request| {
                let mut o = Obj::new();
                let by = login(request.get("enabledBy"));
                if !by.is_empty() {
                    o.insert("by".into(), json!(by));
                }
                let at = text(request.get("enabledAt"), 40);
                if !at.is_empty() {
                    o.insert("at".into(), json!(at));
                }
                o
            })
    };
    let entry = if provider == "github" {
        node.get("mergeQueueEntry").filter(|e| truthy(Some(e)))
    } else {
        None
    };
    let queue = entry.map(|entry| {
        let mut o = Obj::new();
        let position = js::to_number(entry.get("position"));
        if js::is_safe_integer(position) && position > 0.0 {
            o.insert("position".into(), js::number(position));
        }
        let at = text(entry.get("enqueuedAt"), 40);
        if !at.is_empty() {
            o.insert("at".into(), json!(at));
        }
        o
    });
    let user_field = if provider == "gitlab" {
        "username"
    } else {
        "login"
    };
    let mut out = Obj::new();
    out.insert(
        "assignees".into(),
        json!(names(node.get("assignees"), |n| n.get(user_field))),
    );
    let reviewers = if provider == "gitlab" {
        names(node.get("reviewers"), |n| n.get("username"))
    } else {
        let mut out: Vec<String> = Vec::new();
        for request in nodes(node.get("reviewRequests")) {
            let name = js::head16(&login(request.get("requestedReviewer")), 100);
            if !name.is_empty() && !out.contains(&name) {
                out.push(name);
            }
        }
        out
    };
    out.insert("reviewers".into(), json!(reviewers));
    if let Some(auto) = auto_merge {
        out.insert("autoMerge".into(), Value::Object(auto));
    }
    if let Some(queue) = queue {
        out.insert("queue".into(), Value::Object(queue));
    }
    if let Some(at) = approved_at {
        out.insert("approvedAt".into(), json!(at));
    }
    let skip = events.len().saturating_sub(MERGE_EVENTS_KEPT);
    out.insert(
        "events".into(),
        Value::Array(events.into_iter().skip(skip).map(Value::Object).collect()),
    );
    if !labels_added_at.is_empty() {
        out.insert("labelsAddedAt".into(), Value::Object(labels_added_at));
    }
    Some(out)
}

/// GitLab's label events: when each label present was last added.
pub fn parse_label_events(answer: &Value) -> Obj {
    let mut added = Obj::new();
    let Some(events) = answer.as_array() else {
        return added;
    };
    for event in events {
        let name = text(path(event, &["label", "name"]), 60);
        let at = text(event.get("created_at"), 40);
        if name.is_empty() || at.is_empty() {
            continue;
        }
        match js::sv(event.get("action")) {
            "add" => {
                added.insert(name, json!(at));
            }
            "remove" => {
                added.shift_remove(&name);
            }
            _ => {}
        }
    }
    added
}

const GITLAB_MERGE_SETTLING: [&str; 4] = ["CHECKING", "UNCHECKED", "PREPARING", "CI_STILL_RUNNING"];

/// The answer to [`own_details_query`], by request key (in answer order).
pub fn parse_own_details(
    provider: &str,
    host: &str,
    answer: &Value,
) -> Result<Vec<(String, Obj)>, String> {
    let forge = if provider == "gitlab" {
        "GitLab"
    } else {
        "GitHub"
    };
    let data = answer
        .get("data")
        .and_then(Value::as_object)
        .ok_or_else(|| no_data(forge, answer))?;
    let mut found: Vec<(String, Obj)> = Vec::new();
    for entry in data.values() {
        let Some(entry_obj) = entry.as_object() else {
            continue;
        };
        let list: Vec<Value> = if provider == "gitlab" {
            nodes(entry.get("mergeRequests"))
        } else {
            entry_obj.values().cloned().collect()
        };
        for node in list {
            let item = if provider == "gitlab" {
                gitlab_item(host, &node)
            } else {
                github_item(host, &node)
            };
            let Some(item) = item else { continue };
            let pipeline = js::sv(item.get("pipeline"));
            let running = pipeline == "running" || pipeline == "pending";
            let settling = if provider == "gitlab" {
                GITLAB_MERGE_SETTLING.contains(
                    &text(node.get("detailedMergeStatus"), 60)
                        .to_uppercase()
                        .as_str(),
                )
            } else {
                js::sv(node.get("mergeable")) == "UNKNOWN"
            };
            let description = text(
                node.get(if provider == "gitlab" {
                    "description"
                } else {
                    "body"
                }),
                OWN_DESCRIPTION_KEPT,
            );
            let last_notes = own_notes(provider, &node);
            let merge = own_merge_facts(provider, &node);
            let mut details = Obj::new();
            for name in ["updatedAt", "headSha", "pipeline", "notes"] {
                details.insert(name.into(), item.get(name).cloned().unwrap_or(Value::Null));
            }
            if !description.is_empty() {
                details.insert("description".into(), json!(description));
            }
            if !last_notes.is_empty() {
                details.insert(
                    "lastNotes".into(),
                    Value::Array(last_notes.into_iter().map(Value::Object).collect()),
                );
            }
            if let Some(base) = item.get("baseSha").filter(|b| truthy(Some(b))) {
                details.insert("baseSha".into(), base.clone());
            }
            if let Some(drafts) = item.get("drafts") {
                details.insert("drafts".into(), drafts.clone());
            }
            if let Some(merge) = merge {
                details.insert("merge".into(), Value::Object(merge));
            }
            details.insert(
                "own".into(),
                Value::Object(if provider == "gitlab" {
                    gitlab_own_status(&node)
                } else {
                    github_own_status(&node)
                }),
            );
            details.insert("settling".into(), json!(running || settling));
            let key = js::sv(item.get("key")).to_owned();
            match found.iter_mut().find(|(k, _)| *k == key) {
                Some(slot) => slot.1 = details,
                None => found.push((key, details)),
            }
        }
    }
    Ok(found)
}

/// A listed own request with its details, as the inbox shows it.
pub fn with_own_details(item: &Obj, details: Option<&Obj>) -> Obj {
    let Some(details) = details else {
        return item.clone();
    };
    let mut out = item.clone();
    out.insert(
        "pipeline".into(),
        details.get("pipeline").cloned().unwrap_or(Value::Null),
    );
    out.insert(
        "notes".into(),
        details.get("notes").cloned().unwrap_or(Value::Null),
    );
    if let Some(base) = details.get("baseSha").filter(|b| truthy(Some(b))) {
        out.insert("baseSha".into(), base.clone());
    }
    if let Some(drafts) = details.get("drafts") {
        out.insert("drafts".into(), drafts.clone());
    }
    out.insert(
        "own".into(),
        details.get("own").cloned().unwrap_or(Value::Null),
    );
    out
}

/// A GitLab own merge request's status.
pub fn gitlab_own_status(node: &Value) -> Obj {
    let resolvable = js::to_number(node.get("resolvableDiscussionsCount"));
    let resolved = js::to_number(node.get("resolvedDiscussionsCount"));
    let merge = text(node.get("detailedMergeStatus"), 60).to_uppercase();
    let mut o = Obj::new();
    o.insert(
        "approvedBy".into(),
        json!(names(node.get("approvedBy"), |u| u.get("username"))),
    );
    o.insert(
        "approved".into(),
        node.get("approved")
            .filter(|a| a.is_boolean())
            .cloned()
            .unwrap_or(Value::Null),
    );
    o.insert("changesRequested".into(), json!([]));
    o.insert(
        "unresolved".into(),
        if js::is_safe_integer(resolvable) && js::is_safe_integer(resolved) {
            js::number((resolvable - resolved).max(0.0))
        } else {
            Value::Null
        },
    );
    o.insert(
        "conflicts".into(),
        json!(js::is_true(node.get("conflicts")) || merge == "CONFLICT"),
    );
    o.insert(
        "needsRebase".into(),
        json!(js::is_true(node.get("shouldBeRebased")) || merge == "NEED_REBASE"),
    );
    o
}

/// A GitHub own pull request's status.
pub fn github_own_status(node: &Value) -> Obj {
    let reviews = nodes(node.get("latestOpinionatedReviews"));
    let by = |state: &str| {
        let list: Vec<Value> = reviews
            .iter()
            .filter(|r| js::sv(r.get("state")) == state)
            .cloned()
            .collect();
        names(Some(&json!({"nodes": list})), |r| {
            path(r, &["author", "login"])
        })
    };
    let threads = node
        .get("openThreads")
        .filter(|t| truthy(Some(t)))
        .map(|t| nodes(Some(t)));
    let decision = node.get("reviewDecision");
    let mut o = Obj::new();
    o.insert("approvedBy".into(), json!(by("APPROVED")));
    o.insert(
        "approved".into(),
        if js::sv(decision) == "APPROVED" {
            json!(true)
        } else if truthy(decision) {
            json!(false)
        } else {
            Value::Null
        },
    );
    o.insert("changesRequested".into(), json!(by("CHANGES_REQUESTED")));
    o.insert(
        "unresolved".into(),
        match threads {
            Some(threads) => json!(
                threads
                    .iter()
                    .filter(|t| t.get("isResolved") == Some(&json!(false)))
                    .count()
            ),
            None => Value::Null,
        },
    );
    o.insert(
        "conflicts".into(),
        json!(js::sv(node.get("mergeable")) == "CONFLICTING"),
    );
    o.insert("needsRebase".into(), json!(false));
    o
}

static UNKNOWN_FIELD: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)field|doesn't exist|does not exist|undefined").expect("pattern")
});

/// Whether a GraphQL answer refused a field (an older or smaller forge).
pub fn unknown_field_error(answer: &Value) -> bool {
    graphql_error(answer)
        .is_some_and(|m| !m.is_empty() && !truthy(answer.get("data")) && UNKNOWN_FIELD.is_match(&m))
}

/// The first GraphQL error's message, if the answer has one.
pub fn graphql_error(answer: &Value) -> Option<String> {
    let errors = answer.get("errors")?.as_array().filter(|e| !e.is_empty())?;
    Some(match errors[0].get("message").and_then(Value::as_str) {
        Some(message) => js::head16(message, 300),
        None => "error".into(),
    })
}

/// Unique, sorted label names (the merge-after labels whose times were read).
pub fn sorted_unique(names: impl IntoIterator<Item = String>) -> Vec<String> {
    names
        .into_iter()
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect()
}
