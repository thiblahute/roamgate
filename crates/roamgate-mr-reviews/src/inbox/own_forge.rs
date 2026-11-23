//! A fake forge for the user's own requests (`own-forge.fixture.ts`),
//! GitLab or GitHub: it answers the inbox's own-request queries (the light
//! list and its pages, the details by project) from a list of requests,
//! with only the fields each query asks, and counts the calls and their
//! bytes. Tests only.

use std::sync::{Arc, LazyLock, Mutex};

use regex::Regex;
use roamgate_agents::js::{self, Obj};
use roamgate_forge::complexity::estimate_complexity;
use serde_json::{Value, json};

use crate::connection::BoxFuture;
use crate::fetchers::{FetchCall, FetchError, FetchResult, InboxFetchers};
use crate::queries::parse_label_events;

#[derive(Clone, Debug, Default)]
pub struct Note {
    pub author: String,
    pub at: String,
    pub body: String,
    pub system: bool,
}

#[derive(Clone, Debug, Default)]
pub struct FakeRequest {
    pub project: String,
    pub number: u64,
    /// open, merged or closed.
    pub state: &'static str,
    pub created_at: String,
    pub updated_at: String,
    pub head: Option<String>,
    /// success, failed, running or pending.
    pub pipeline: Option<&'static str>,
    pub approved_by: Vec<String>,
    pub unresolved: u64,
    pub conflicts: bool,
    /// Section 15: labels, who is assigned, auto-merge, the merge queue.
    pub labels: Vec<String>,
    /// GitLab's label events (REST), oldest first: label, action (add by
    /// default), time.
    pub label_events: Vec<(String, Option<&'static str>, String)>,
    pub assignees: Vec<String>,
    pub reviewers: Vec<String>,
    /// Who set auto-merge, and when.
    pub auto_merge: Option<(String, String)>,
    /// GitHub's merge queue: position, since.
    pub queue: Option<(u64, String)>,
    pub notes: Vec<Note>,
    /// GitHub timeline items, as the API gives them (__typename first).
    pub timeline: Vec<Value>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct FakeCall {
    /// inbox, list, details, labels or other.
    pub kind: &'static str,
    pub query: String,
    /// Bytes sent and received.
    pub bytes: usize,
    /// The requests whose details were asked.
    pub numbers: Vec<u64>,
}

#[derive(Clone, Debug, Default)]
pub struct ForgeOptions {
    pub refuse_full: bool,
    /// GitLab's complexity limit: a query whose complexity (the estimate
    /// times `complexity_scale`, as the real count differs) is above it is
    /// refused as glab refuses it, with an error.
    pub max_complexity: Option<f64>,
    pub complexity_scale: Option<f64>,
    /// Others' open requests, the followed projects' (GitLab).
    pub followed: Vec<FakeRequest>,
}

const PAGE_LIMIT: usize = 100;

static AFTER: LazyLock<Regex> = LazyLock::new(|| Regex::new(r#"after: "(\d+)""#).unwrap());
static FOLLOWED: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#"(f\d+): project\(fullPath: "([^"]+)"\)"#).unwrap());
static FOLLOWED_ANY: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\bf\d+: project\(").unwrap());
static RR: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\brr: ").unwrap());
static FULL_FIELDS: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"approvedBy|approved ").unwrap());
static DETAILS: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"(p\d+): project\(fullPath: "([^"]+)"\) \{ mergeRequests\(iids: (\[[^\]]*\])"#)
        .unwrap()
});
static REPOSITORY_AT: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"p\d+: repository\(").unwrap());
static REPOSITORY: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"^(p\d+): repository\(owner: "([^"]+)", name: "([^"]+)"\)"#).unwrap()
});
static PULL: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(n\d+): pullRequest\(number: (\d+)\)").unwrap());

fn first(query: &str, alias: &str) -> usize {
    let pattern = Regex::new(&format!(r"{alias}: [a-zA-Z]+\([^)]*first: (\d+)")).unwrap();
    let asked = pattern
        .captures(query)
        .and_then(|c| c[1].parse().ok())
        .unwrap_or(PAGE_LIMIT);
    asked.min(PAGE_LIMIT)
}

fn by_created(a: &FakeRequest, b: &FakeRequest) -> std::cmp::Ordering {
    b.created_at
        .cmp(&a.created_at)
        .then(b.number.cmp(&a.number))
}

fn by_updated(a: &FakeRequest, b: &FakeRequest) -> std::cmp::Ordering {
    b.updated_at
        .cmp(&a.updated_at)
        .then(b.number.cmp(&a.number))
}

fn merge(into: &mut Value, more: Value) {
    if let (Some(into), Value::Object(more)) = (into.as_object_mut(), more) {
        for (key, value) in more {
            into.insert(key, value);
        }
    }
}

fn nodes<T>(list: &[T], node: impl Fn(&T) -> Value) -> Value {
    Value::Array(list.iter().map(node).collect())
}

pub struct OwnForge {
    provider: &'static str,
    host: String,
    requests: Mutex<Vec<FakeRequest>>,
    calls: Mutex<Vec<FakeCall>>,
    /// Complexity refusals: the queries glab was told off for.
    refused: Mutex<Vec<(String, f64)>>,
    options: ForgeOptions,
}

impl OwnForge {
    pub fn new(
        provider: &'static str,
        host: &str,
        initial: Vec<FakeRequest>,
        options: ForgeOptions,
    ) -> Arc<OwnForge> {
        Arc::new(OwnForge {
            provider,
            host: host.into(),
            requests: Mutex::new(initial),
            calls: Mutex::new(vec![]),
            refused: Mutex::new(vec![]),
            options,
        })
    }

    /// The calls since the last take, and resets them.
    pub fn take(&self) -> Vec<FakeCall> {
        std::mem::take(&mut *self.calls.lock().unwrap())
    }

    pub fn calls(&self) -> Vec<FakeCall> {
        self.calls.lock().unwrap().clone()
    }

    pub fn refused(&self) -> Vec<(String, f64)> {
        self.refused.lock().unwrap().clone()
    }

    pub fn clear_refused(&self) {
        self.refused.lock().unwrap().clear();
    }

    pub fn update(&self, change: impl FnOnce(Vec<FakeRequest>) -> Vec<FakeRequest>) {
        let mut requests = self.requests.lock().unwrap();
        let list = std::mem::take(&mut *requests);
        *requests = change(list);
    }

    fn url(&self, r: &FakeRequest) -> String {
        if self.provider == "gitlab" {
            format!(
                "https://{}/{}/-/merge_requests/{}",
                self.host, r.project, r.number
            )
        } else {
            format!("https://{}/{}/pull/{}", self.host, r.project, r.number)
        }
    }

    fn head(r: &FakeRequest) -> String {
        r.head
            .clone()
            .unwrap_or_else(|| format!("{:a>7}0", r.number))
    }

    fn gitlab_light(&self, r: &FakeRequest) -> Value {
        let state = match r.state {
            "open" => "opened",
            other => other,
        };
        json!({
            "iid": r.number.to_string(),
            "title": format!("Request {} of {}", r.number, r.project),
            "webUrl": self.url(r),
            "draft": false,
            "state": state,
            "updatedAt": r.updated_at,
            "diffHeadSha": Self::head(r),
            "sourceBranch": format!("topic-{}", r.number),
            "targetBranch": "main",
            "project": {"fullPath": r.project},
            "author": {"username": "me"},
            "labels": {"nodes": nodes(&r.labels, |t| json!({"title": t}))},
        })
    }

    fn gitlab_merge(r: &FakeRequest, query: &str) -> Value {
        if !query.contains("assignees") {
            return json!({});
        }
        json!({
            "assignees": {"nodes": nodes(&r.assignees, |u| json!({"username": u}))},
            "reviewers": {"nodes": nodes(&r.reviewers, |u| json!({"username": u}))},
            "autoMergeEnabled": r.auto_merge.is_some(),
            "mergeUser": r.auto_merge.as_ref().map(|(by, _)| json!({"username": by})),
        })
    }

    fn gitlab_notes(r: &FakeRequest, query: &str) -> Value {
        if !query.contains("discussions(") {
            return json!({});
        }
        let discussions = nodes(&r.notes, |note| {
            json!({
                "resolvable": false,
                "resolved": false,
                "notes": {"nodes": [{
                    "author": {"username": note.author},
                    "createdAt": note.at,
                    "body": note.body,
                    "system": note.system,
                }]},
            })
        });
        json!({"discussions": {"nodes": discussions}})
    }

    fn gitlab_details(&self, r: &FakeRequest, full: bool) -> Value {
        let mut out = json!({
            "iid": r.number.to_string(),
            "webUrl": self.url(r),
            "updatedAt": r.updated_at,
            "diffHeadSha": Self::head(r),
            "userNotesCount": 3,
            "project": {"fullPath": r.project},
            "headPipeline": {"status": r.pipeline.unwrap_or("success").to_uppercase()},
            "diffRefs": {"baseSha": "bbbbbbbb"},
            "conflicts": r.conflicts,
            "shouldBeRebased": false,
        });
        if full {
            merge(
                &mut out,
                json!({
                    "approved": !r.approved_by.is_empty(),
                    "detailedMergeStatus": if r.conflicts { "CONFLICT" } else { "MERGEABLE" },
                    "approvedBy": {"nodes": nodes(&r.approved_by, |u| json!({"username": u}))},
                    "resolvableDiscussionsCount": r.unresolved + 2,
                    "resolvedDiscussionsCount": 2,
                }),
            );
        }
        out
    }

    fn github_light(&self, r: &FakeRequest) -> Value {
        json!({
            "number": r.number,
            "title": format!("Request {} of {}", r.number, r.project),
            "url": self.url(r),
            "isDraft": false,
            "state": r.state.to_uppercase(),
            "updatedAt": r.updated_at,
            "headRefOid": Self::head(r),
            "headRefName": format!("topic-{}", r.number),
            "baseRefName": "main",
            "repository": {"nameWithOwner": r.project},
            "author": {"login": "me"},
            "labels": {"nodes": nodes(&r.labels, |n| json!({"name": n}))},
        })
    }

    fn github_merge(r: &FakeRequest, query: &str) -> Value {
        if !query.contains("mergeTimeline") {
            return json!({});
        }
        let comments: Vec<Value> = r
            .notes
            .iter()
            .filter(|n| !n.system)
            .map(|n| json!({"author": {"login": n.author}, "createdAt": n.at, "body": n.body}))
            .collect();
        json!({
            "assignees": {"nodes": nodes(&r.assignees, |l| json!({"login": l}))},
            "reviewRequests": {"nodes": nodes(&r.reviewers, |l| json!({"requestedReviewer": {"login": l}}))},
            "autoMergeRequest": r.auto_merge.as_ref().map(|(by, at)| json!({"enabledAt": at, "enabledBy": {"login": by}})),
            "mergeQueueEntry": r.queue.as_ref().map(|(position, at)| json!({"position": position, "enqueuedAt": at})),
            "mergeTimeline": {"nodes": r.timeline},
            "lastComments": {"nodes": comments},
        })
    }

    fn github_details(&self, r: &FakeRequest) -> Value {
        let rollup = match r.pipeline {
            Some("failed") => "FAILURE",
            Some("running" | "pending") => "PENDING",
            _ => "SUCCESS",
        };
        let open: Vec<Value> = (0..r.unresolved)
            .map(|_| json!({"isResolved": false}))
            .collect();
        json!({
            "number": r.number,
            "url": self.url(r),
            "updatedAt": r.updated_at,
            "headRefOid": Self::head(r),
            "baseRefOid": "bbbbbbbb",
            "repository": {"nameWithOwner": r.project},
            "comments": {"totalCount": 2},
            "reviewThreads": {"totalCount": 1},
            "commits": {"nodes": [{"commit": {"statusCheckRollup": {"state": rollup}}}]},
            "reviews": {"nodes": []},
            "mergeable": if r.conflicts { "CONFLICTING" } else { "MERGEABLE" },
            "reviewDecision": if r.approved_by.is_empty() { "REVIEW_REQUIRED" } else { "APPROVED" },
            "latestOpinionatedReviews": {"nodes": nodes(&r.approved_by, |l| json!({"state": "APPROVED", "author": {"login": l}}))},
            "openThreads": {"nodes": open},
        })
    }

    fn requests(&self) -> Vec<FakeRequest> {
        self.requests.lock().unwrap().clone()
    }

    /// A page of the open ones, from an offset cursor.
    fn open_page(&self, query: &str, alias: &str) -> (Vec<FakeRequest>, Value) {
        let offset: usize = AFTER
            .captures(query)
            .and_then(|c| c[1].parse().ok())
            .unwrap_or(0);
        let size = first(query, alias);
        let mut open: Vec<FakeRequest> = self
            .requests()
            .into_iter()
            .filter(|r| r.state == "open")
            .collect();
        open.sort_by(by_created);
        let page: Vec<FakeRequest> = open.iter().skip(offset).take(size).cloned().collect();
        let info = json!({
            "hasNextPage": offset + size < open.len(),
            "endCursor": (offset + size).to_string(),
        });
        (page, info)
    }

    /// The followed projects a GitLab inbox query asks, by alias.
    fn followed_answer(&self, query: &str) -> Obj {
        let mut data = Obj::new();
        for found in FOLLOWED.captures_iter(query) {
            let project = &found[2];
            let list: Vec<Value> = self
                .options
                .followed
                .iter()
                .filter(|r| r.project == project && r.state == "open")
                .map(|r| {
                    let mut node = self.gitlab_light(r);
                    merge(
                        &mut node,
                        json!({"author": {"username": "someone"}, "diffStats": []}),
                    );
                    node
                })
                .collect();
            data.insert(
                found[1].to_owned(),
                json!({"fullPath": project, "mergeRequests": {"nodes": list}}),
            );
        }
        data
    }

    fn settled(&self, keep: impl Fn(&FakeRequest) -> bool, count: usize) -> Vec<FakeRequest> {
        let mut list: Vec<FakeRequest> = self.requests().into_iter().filter(keep).collect();
        list.sort_by(by_updated);
        list.truncate(count);
        list
    }

    fn answer(&self, query: &str) -> (&'static str, Value, Vec<u64>) {
        let gitlab = self.provider == "gitlab";
        let empty_user = json!({"username": "me", "rr": {"nodes": []}, "as": {"nodes": []}, "todos": {"nodes": []}});
        if gitlab && FOLLOWED_ANY.is_match(query) {
            let mut data = Obj::new();
            if RR.is_match(query) {
                data.insert("currentUser".into(), empty_user);
            }
            for (k, v) in self.followed_answer(query) {
                data.insert(k, v);
            }
            return ("inbox", json!({"data": data}), vec![]);
        }
        if RR.is_match(query) {
            let body = if gitlab {
                json!({"data": {"currentUser": empty_user}})
            } else {
                json!({"data": {"viewer": {"login": "me"}, "rr": {"nodes": []}, "as": {"nodes": []}, "mn": {"nodes": []}}})
            };
            return ("inbox", body, vec![]);
        }
        let full = !self.options.refuse_full;
        if FULL_FIELDS.is_match(query) && self.options.refuse_full {
            return (
                "details",
                json!({"errors": [{"message": "Field 'approved' doesn't exist on type 'MergeRequest'"}]}),
                vec![],
            );
        }
        let requests = self.requests();
        if gitlab {
            if query.contains("mergeRequests(iids:") {
                let mut data = Obj::new();
                let mut numbers = Vec::new();
                for found in DETAILS.captures_iter(query) {
                    let iids: Vec<u64> = serde_json::from_str::<Vec<String>>(&found[3])
                        .unwrap()
                        .iter()
                        .map(|n| n.parse().unwrap())
                        .collect();
                    numbers.extend(&iids);
                    let list: Vec<Value> = requests
                        .iter()
                        .filter(|r| r.project == found[2] && iids.contains(&r.number))
                        .map(|r| {
                            let mut node =
                                self.gitlab_details(r, full && query.contains("approvedBy"));
                            merge(&mut node, Self::gitlab_notes(r, query));
                            merge(&mut node, Self::gitlab_merge(r, query));
                            node
                        })
                        .collect();
                    data.insert(
                        found[1].to_owned(),
                        json!({"mergeRequests": {"nodes": list}}),
                    );
                }
                return ("details", json!({"data": data}), numbers);
            }
            if query.contains("op: authoredMergeRequests") {
                let (page, info) = self.open_page(query, "op");
                let mut user = json!({
                    "username": "me",
                    "op": {"pageInfo": info, "nodes": nodes(&page, |r| self.gitlab_light(r))},
                });
                for (state, alias) in [("merged", "mg"), ("closed", "cl")] {
                    if query.contains(&format!("{alias}: authoredMergeRequests")) {
                        let list = self.settled(|r| r.state == state, first(query, alias));
                        merge(
                            &mut user,
                            json!({alias: {"nodes": nodes(&list, |r| self.gitlab_light(r))}}),
                        );
                    }
                }
                return ("list", json!({"data": {"currentUser": user}}), vec![]);
            }
            return ("other", json!({"data": {}}), vec![]);
        }
        if query.contains("pullRequest(number:") {
            let mut data = Obj::new();
            let mut numbers = Vec::new();
            let starts: Vec<usize> = REPOSITORY_AT.find_iter(query).map(|m| m.start()).collect();
            for (index, start) in starts.iter().enumerate() {
                let end = starts.get(index + 1).copied().unwrap_or(query.len());
                let segment = &query[*start..end];
                let Some(repo) = REPOSITORY.captures(segment) else {
                    continue;
                };
                let project = format!("{}/{}", &repo[2], &repo[3]);
                let mut pulls = Obj::new();
                for pull in PULL.captures_iter(segment) {
                    let number: u64 = pull[2].parse().unwrap();
                    numbers.push(number);
                    let node = match requests
                        .iter()
                        .find(|r| r.project == project && r.number == number)
                    {
                        Some(r) => {
                            let mut node = self.github_details(r);
                            merge(&mut node, Self::github_merge(r, query));
                            node
                        }
                        None => Value::Null,
                    };
                    pulls.insert(pull[1].to_owned(), node);
                }
                data.insert(repo[1].to_owned(), Value::Object(pulls));
            }
            return ("details", json!({"data": data}), numbers);
        }
        if query.contains("op: search") {
            let (page, info) = self.open_page(query, "op");
            let mut data = json!({
                "viewer": {"login": "me"},
                "op": {"pageInfo": info, "nodes": nodes(&page, |r| self.github_light(r))},
            });
            if query.contains("st: search") {
                let list = self.settled(|r| r.state != "open", first(query, "st"));
                merge(
                    &mut data,
                    json!({"st": {"nodes": nodes(&list, |r| self.github_light(r))}}),
                );
            }
            return ("list", json!({"data": data}), vec![]);
        }
        ("other", json!({"data": {}}), vec![])
    }

    fn ask(&self, query: &str) -> FetchResult<Value> {
        if let Some(max) = self.options.max_complexity {
            let complexity =
                (estimate_complexity(query) * self.options.complexity_scale.unwrap_or(1.0)).ceil();
            if complexity > max {
                self.refused
                    .lock()
                    .unwrap()
                    .push((query.to_owned(), complexity));
                return Err(FetchError::Failed(format!(
                    "GitLab: glab: Query has complexity of {complexity}, which exceeds max complexity of {max}"
                )));
            }
        }
        let (kind, body, numbers) = self.answer(query);
        self.calls.lock().unwrap().push(FakeCall {
            kind,
            query: query.to_owned(),
            numbers,
            bytes: query.len() + js::stringify(&body).len(),
        });
        Ok(body)
    }
}

impl InboxFetchers for OwnForge {
    fn gitlab<'a>(
        &'a self,
        _host: &'a str,
        query: &'a str,
        _call: &'a FetchCall,
    ) -> BoxFuture<'a, FetchResult<Value>> {
        let answer = if self.provider == "gitlab" {
            self.ask(query)
        } else {
            Err(FetchError::Failed("not this forge".into()))
        };
        Box::pin(async move { answer })
    }

    fn github<'a>(
        &'a self,
        _host: &'a str,
        query: &'a str,
        _call: &'a FetchCall,
    ) -> BoxFuture<'a, FetchResult<Value>> {
        let answer = if self.provider == "github" {
            self.ask(query)
        } else {
            Err(FetchError::Failed("not this forge".into()))
        };
        Box::pin(async move { answer })
    }

    fn gitlab_drafts<'a>(&'a self, _item: &'a Obj) -> BoxFuture<'a, FetchResult<usize>> {
        Box::pin(async { Ok(0) })
    }

    fn gitlab_label_events<'a>(&'a self, item: &'a Obj) -> Option<BoxFuture<'a, FetchResult<Obj>>> {
        let number = item.get("number").and_then(Value::as_u64).unwrap_or(0);
        let project = js::sv(item.get("project")).to_owned();
        let events: Vec<Value> = self
            .requests()
            .iter()
            .find(|r| r.project == project && r.number == number)
            .map(|r| {
                r.label_events
                    .iter()
                    .map(|(label, action, at)| {
                        json!({"action": action.unwrap_or("add"), "label": {"name": label}, "created_at": at})
                    })
                    .collect()
            })
            .unwrap_or_default();
        let body = Value::Array(events);
        self.calls.lock().unwrap().push(FakeCall {
            kind: "labels",
            query: format!("{project}!{number}"),
            numbers: vec![number],
            bytes: js::stringify(&body).len(),
        });
        let added = parse_label_events(&body);
        Some(Box::pin(async move { Ok(added) }))
    }
}

/// The projects `fakeRequests` spreads over by default.
pub const PROJECTS: [&str; 3] = ["group/app", "group/lib", "other/tool"];

/// `count` requests spread over the projects, numbered from `from`.
pub fn fake_requests(
    count: usize,
    state: &'static str,
    at: impl Fn(usize) -> String,
    from: u64,
    projects: &[&str],
) -> Vec<FakeRequest> {
    (0..count)
        .map(|index| FakeRequest {
            project: projects[index % projects.len()].to_owned(),
            number: from + index as u64,
            state,
            created_at: at(index),
            updated_at: at(index),
            ..FakeRequest::default()
        })
        .collect()
}
