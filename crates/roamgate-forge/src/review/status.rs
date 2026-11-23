//! The merge and pull requests the agent chats show (review/forge.ts),
//! read through the review pane's GitLab plumbing (glab on the checkout's
//! host, the token only ever to glab's default host or a host glab has its
//! own login for) and the PR card's gh path (gh's own login for each host).
//! It only reads: nothing it learns goes to an agent, and only a request's
//! own https page is linked.
//!
//! What a session's repositories are, and the PR card's own lookup, are
//! the workspace's (S17): [`ForgeWorkspace`] asks them.

use std::collections::HashMap;
use std::sync::{Arc, LazyLock, Mutex};
use std::time::Duration;

use indexmap::IndexMap;
use regex::Regex;
use roamgate_agents::js;
use roamgate_base::clock::{BoxFuture, SharedClock};
use roamgate_base::settings::sections::valid_project;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use tokio::sync::oneshot;

use super::cli::{ForgeContext, run_forge_script, spawn_gh, truthy};
use super::gitlab::{
    GlabCall, GlabHost, ReviewCheckout, enter_checkout, find_branch_merge_request, gitlab_host_for,
    glab, glab_host_access, host_name, is_security_project, merge_request_source, read_checkout,
    remote_project,
};
use super::memo::Memo;
use crate::gate::{ForgeCall, ForgeOutput, Spawn};
use crate::hosts::valid_host;
use crate::mr_cache::{LoadError, Loaded, MrCache, forge_cache_ttl, iso_time, reader_options};

/// How long an answer is shared by every chip and browser asking it.
pub const FORGE_STATUS_TTL_MS: i64 = 15_000;
/// A session's repositories and their branches' requests.
pub const FORGE_SESSION_TTL_MS: i64 = 5 * 60_000;
/// How long chips asked together wait for each other.
pub const FORGE_BATCH_WINDOW_MS: u64 = 100;
/// A request asked about this recently is read again with the others.
const FORGE_INTEREST_MS: i64 = 5 * 60_000;
const FORGE_BATCH_SIZE: usize = 50;
/// What `!N` and `#N` mean in a checkout (its project, or its fork's parent).
const DEFAULT_PROJECT_TTL_MS: i64 = 30 * 60_000;
/// Repositories of one session whose branch's request is looked up.
const SESSION_REPO_LIMIT: usize = 8;
const FAILED_JOBS_SHOWN: usize = 8;

/// A merge or pull request (shared/forge.ts ForgeRef).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ForgeRef {
    /// `gitlab` or `github`.
    pub provider: String,
    pub host: String,
    pub project: String,
    pub number: i64,
}

impl ForgeRef {
    pub fn gitlab(&self) -> bool {
        self.provider == "gitlab"
    }

    pub fn value(&self) -> Value {
        serde_json::to_value(self).unwrap_or(Value::Null)
    }
}

/// shared/forge.ts `forgeRefKey`.
pub fn forge_ref_key(reference: &ForgeRef) -> String {
    format!(
        "{}:{}/{}#{}",
        reference.provider,
        reference.host.to_lowercase(),
        reference.project.to_lowercase(),
        reference.number
    )
}

/// The request a web URL names (shared/forge.ts `parseForgeUrl`): GitLab
/// `/-/merge_requests/N` and GitHub `/pull/N`, https only, without
/// credentials.
pub fn parse_forge_url(value: &str) -> Option<ForgeRef> {
    static HOST: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"(?i)^[a-z0-9][a-z0-9.-]*(?::\d+)?$").unwrap());
    static GITLAB: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"^/(.+?)/-/merge_requests/(\d{1,9})(?:/.*)?$").unwrap());
    static GITHUB: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(r"^/([A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+)/pull/(\d{1,9})(?:/.*)?$").unwrap()
    });
    let url = url::Url::parse(value).ok()?;
    if url.scheme() != "https" || !url.username().is_empty() || url.password().is_some() {
        return None;
    }
    let mut host = url.host_str()?.to_lowercase();
    if let Some(port) = url.port() {
        host = format!("{host}:{port}");
    }
    if !HOST.is_match(&host) {
        return None;
    }
    let path = url.path().trim_end_matches('/');
    if let Some(found) = GITLAB.captures(path) {
        let project = &found[1];
        return valid_project(project).then(|| ForgeRef {
            provider: "gitlab".into(),
            host: host.clone(),
            project: project.to_owned(),
            number: found[2].parse().unwrap_or(0),
        });
    }
    let found = GITHUB.captures(path)?;
    valid_project(&found[1]).then(|| ForgeRef {
        provider: "github".into(),
        host,
        project: found[1].to_owned(),
        number: found[2].parse().unwrap_or(0),
    })
}

/// Whether a URL the forge answered is the request's own web page
/// (shared/forge.ts `ownRequestUrl`): https, on the host asked, no
/// credentials, and naming that request.
pub fn own_request_url(reference: &ForgeRef, value: Option<&Value>) -> Option<String> {
    let value = value?.as_str()?;
    let parsed = parse_forge_url(value)?;
    if parsed.provider != reference.provider
        || parsed.host != reference.host.to_lowercase()
        || parsed.number != reference.number
    {
        return None;
    }
    let mut url = url::Url::parse(value).ok()?;
    url.set_fragment(None);
    url.set_query(None);
    Some(url.to_string())
}

/// How long a batch's answer stands for a chip that asks again (a little
/// less than the browser waits for it, so that a due chip gets news).
pub fn forge_answer_ttl(status: &Value) -> i64 {
    let state = status.get("state").and_then(Value::as_str);
    let request = status
        .get("request")
        .filter(|request| truthy(Some(request)));
    let Some(request) = request.filter(|_| state == Some("ready")) else {
        return if state == Some("not_found") {
            5 * 60_000
        } else {
            0
        };
    };
    if request.get("state").and_then(Value::as_str) != Some("open") {
        return 30 * 60_000;
    }
    match request
        .get("pipeline")
        .and_then(|pipeline| pipeline.get("status"))
        .and_then(Value::as_str)
    {
        Some("running" | "pending") => 45_000,
        _ => 150_000,
    }
}

/// GitLab's pipeline statuses, folded to the chip's.
pub fn gitlab_pipeline_status(value: &str) -> &'static str {
    match value {
        "success" => "success",
        "failed" => "failed",
        "canceled" | "canceling" => "canceled",
        "skipped" => "skipped",
        "manual" => "manual",
        "running" => "running",
        // created, pending, preparing, scheduled, waiting_for_resource...
        _ => "pending",
    }
}

/// A GitHub status check rollup state, folded to the chip's.
pub fn github_pipeline_status(value: Option<&str>) -> &'static str {
    match value {
        Some("SUCCESS") => "success",
        Some("FAILURE" | "ERROR") => "failed",
        Some("PENDING") => "running",
        _ => "pending",
    }
}

fn gitlab_state(value: Option<&str>) -> &'static str {
    match value {
        Some("merged") => "merged",
        Some("closed") => "closed",
        Some("locked") => "locked",
        _ => "open",
    }
}

fn text(value: Option<&Value>, max: usize) -> String {
    value
        .and_then(Value::as_str)
        .map(|text| js::head16(text, max))
        .unwrap_or_default()
}

fn at<'a>(value: &'a Value, path: &[&str]) -> Option<&'a Value> {
    path.iter().try_fold(value, |value, key| value.get(key))
}

fn safe_int(value: Option<&Value>) -> Option<i64> {
    let number = value?.as_f64()?;
    js::is_safe_integer(number).then_some(number as i64)
}

/// A status without a request.
fn status(
    reference: &ForgeRef,
    state: &str,
    message: Option<String>,
    clock: &SharedClock,
) -> Value {
    let mut map = Map::new();
    map.insert("ref".into(), reference.value());
    map.insert("state".into(), json!(state));
    if let Some(message) = message {
        map.insert("message".into(), json!(message));
    }
    map.insert("fetchedAt".into(), json!(iso_time(clock.now())));
    Value::Object(map)
}

fn clock_of(context: &ForgeContext) -> &SharedClock {
    &context.tools.clock
}

/// Why glab refused a host: no login, or no glab at all.
fn classify_access(reference: &ForgeRef, reason: &str, clock: &SharedClock) -> Value {
    let lower = reason.to_lowercase();
    if lower.contains("not installed") {
        return status(
            reference,
            "unavailable",
            Some("glab is not installed where the checkout is".into()),
            clock,
        );
    }
    if lower.contains("no login") {
        return status(
            reference,
            "not_signed_in",
            Some(format!(
                "Not signed in to {0} (glab auth login --hostname {0})",
                reference.host
            )),
            clock,
        );
    }
    status(reference, "error", Some(js::head16(reason, 300)), clock)
}

fn chip(kind: &'static str) -> GlabCall {
    GlabCall {
        feature: Some("chip"),
        kind: Some(kind),
        ..GlabCall::default()
    }
}

/// A GitLab merge request, its pipeline, approvals and open threads.
pub async fn read_gitlab_status(context: &ForgeContext, reference: &ForgeRef) -> Value {
    let clock = clock_of(context);
    // Confidential security work never leaves GitLab: not even its title.
    if is_security_project(&reference.project) {
        return status(reference, "security", None, clock);
    }
    let own_login = match glab_host_access(context, &reference.host).await {
        Ok(own) => own,
        Err(reason) => return classify_access(reference, &reason, clock),
    };
    let host = GlabHost {
        host: reference.host.clone(),
        own_login: Some(own_login),
    };
    let path = format!(
        "projects/{}/merge_requests/{}",
        roamgate_agents::paths::encode_uri_component(&reference.project),
        reference.number
    );
    let mr = match glab(
        context,
        &host,
        "GET",
        &path,
        &[],
        Some(false),
        chip("request"),
    )
    .await
    {
        Ok(mr) => mr,
        Err(reason) => {
            let lower = reason.to_lowercase();
            return if lower.contains("404") || lower.contains("not found") {
                status(
                    reference,
                    "not_found",
                    Some("No such merge request".into()),
                    clock,
                )
            } else {
                status(reference, "error", Some(js::head16(&reason, 300)), clock)
            };
        }
    };
    if !mr.is_object() {
        return status(reference, "error", Some("Unexpected answer".into()), clock);
    }
    let Some((_, project)) = guarded_url(
        reference,
        mr.get("web_url"),
        at(&mr, &["references", "full"]),
    ) else {
        return status(reference, "security", None, clock);
    };
    let pipeline = [mr.get("head_pipeline"), mr.get("pipeline")]
        .into_iter()
        .flatten()
        .find(|pipeline| !pipeline.is_null())
        .cloned();
    let jobs_path = pipeline.as_ref().and_then(|pipeline| {
        let failed = pipeline.get("status").and_then(Value::as_str) == Some("failed");
        let id = safe_int(pipeline.get("id"))?;
        let project_id = safe_int(pipeline.get("project_id"))?;
        failed.then(|| {
            format!("projects/{project_id}/pipelines/{id}/jobs?scope[]=failed&per_page=50")
        })
    });
    let query = "query($p: ID!, $i: String!) { project(fullPath: $p) { mergeRequest(iid: $i) { resolvableDiscussionsCount resolvedDiscussionsCount } } }";
    let threads_fields = [
        (
            "query".to_owned(),
            query.to_owned(),
            super::gitlab::FieldKind::Raw,
        ),
        (
            "p".to_owned(),
            project.clone(),
            super::gitlab::FieldKind::Raw,
        ),
        (
            "i".to_owned(),
            reference.number.to_string(),
            super::gitlab::FieldKind::Raw,
        ),
    ];
    let approvals_path = format!("{path}/approvals");
    let (approvals, threads, jobs) = futures_util::join!(
        glab(
            context,
            &host,
            "GET",
            &approvals_path,
            &[],
            Some(false),
            chip("approvals")
        ),
        glab(
            context,
            &host,
            "POST",
            "graphql",
            &threads_fields,
            Some(false),
            chip("graphql")
        ),
        async {
            match &jobs_path {
                Some(jobs_path) => {
                    glab(
                        context,
                        &host,
                        "GET",
                        jobs_path,
                        &[],
                        Some(false),
                        chip("jobs"),
                    )
                    .await
                }
                None => Ok(json!([])),
            }
        }
    );
    let approved = approvals.ok().filter(|value| truthy(Some(value)));
    let counts = threads
        .ok()
        .and_then(|value| at(&value, &["data", "project", "mergeRequest"]).cloned());
    let failed = match jobs {
        Ok(Value::Array(jobs)) => jobs
            .iter()
            .map(|job| FailedJob {
                name: job.get("name").cloned(),
                stage: job.get("stage").cloned(),
                allow_failure: job.get("allow_failure") == Some(&Value::Bool(true)),
            })
            .collect(),
        _ => Vec::new(),
    };
    gitlab_status_of(
        reference,
        GitlabFacts {
            pipeline: pipeline
                .as_ref()
                .map(|pipeline| text(pipeline.get("status"), 40)),
            mr,
            failed,
            approvals: approved.map(|approved| {
                (
                    approved.get("approved").and_then(Value::as_bool),
                    approved
                        .get("approved_by")
                        .and_then(Value::as_array)
                        .map_or(0, Vec::len),
                )
            }),
            resolvable: counts
                .as_ref()
                .and_then(|counts| counts.get("resolvableDiscussionsCount").cloned()),
            resolved: counts
                .as_ref()
                .and_then(|counts| counts.get("resolvedDiscussionsCount").cloned()),
        },
        clock,
    )
}

/// The request's own page and the project it names, when the forge names
/// a project that is not a security one anywhere (fail closed otherwise).
fn guarded_url(
    reference: &ForgeRef,
    web_url: Option<&Value>,
    full_reference: Option<&Value>,
) -> Option<(String, String)> {
    static NUMBER: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"!\d+$").unwrap());
    let url = own_request_url(reference, web_url)?;
    let project = parse_forge_url(&url)?.project;
    let full = NUMBER.replace(&text(full_reference, 500), "").into_owned();
    if is_security_project(&project) || (!full.is_empty() && is_security_project(&full)) {
        return None;
    }
    Some((url, project))
}

struct FailedJob {
    name: Option<Value>,
    stage: Option<Value>,
    allow_failure: bool,
}

/// What a merge request says, from REST or GraphQL.
struct GitlabFacts {
    /// REST-shaped: web_url, references.full, title, state, draft...
    mr: Value,
    /// The head pipeline's status (REST's lower case), none for none.
    pipeline: Option<String>,
    failed: Vec<FailedJob>,
    /// Approved (or unknown), and by how many.
    approvals: Option<(Option<bool>, usize)>,
    resolvable: Option<Value>,
    resolved: Option<Value>,
}

fn gitlab_status_of(reference: &ForgeRef, facts: GitlabFacts, clock: &SharedClock) -> Value {
    let mr = &facts.mr;
    let Some((url, project)) = guarded_url(
        reference,
        mr.get("web_url"),
        at(mr, &["references", "full"]),
    ) else {
        return status(reference, "security", None, clock);
    };
    let pipeline = facts.pipeline.as_ref().map(|pipeline| {
        json!({
            "status": gitlab_pipeline_status(pipeline),
            "failed": facts.failed.iter().take(FAILED_JOBS_SHOWN).map(|job| {
                let mut entry = Map::new();
                entry.insert("name".into(), json!(text(job.name.as_ref(), 200)));
                let stage = text(job.stage.as_ref(), 100);
                if !stage.is_empty() {
                    entry.insert("stage".into(), json!(stage));
                }
                entry.insert("allowFailure".into(), json!(job.allow_failure));
                Value::Object(entry)
            }).collect::<Vec<_>>(),
        })
    });
    let unresolved = match (
        safe_int(facts.resolvable.as_ref()),
        safe_int(facts.resolved.as_ref()),
    ) {
        (Some(resolvable), Some(resolved)) => json!((resolvable - resolved).max(0)),
        _ => Value::Null,
    };
    let draft = mr.get("draft") == Some(&Value::Bool(true))
        || mr.get("work_in_progress") == Some(&Value::Bool(true));
    json!({
        "ref": reference.value(),
        "state": "ready",
        "fetchedAt": iso_time(clock.now()),
        "request": {
            "url": url,
            "project": project,
            "title": text(mr.get("title"), 300),
            "state": gitlab_state(mr.get("state").and_then(Value::as_str)),
            "draft": draft,
            "author": text(at(mr, &["author", "username"]), 100),
            "sourceBranch": text(mr.get("source_branch"), 300),
            "targetBranch": text(mr.get("target_branch"), 300),
            "updatedAt": text(mr.get("updated_at"), 40),
            "pipeline": pipeline,
            "approvals": facts.approvals.map(|(approved, count)| json!({"approved": approved, "count": count})),
            "unresolved": unresolved,
        },
    })
}

const GITLAB_REQUEST_FIELDS: &str = "iid webUrl reference(full: true) title state draft updatedAt sourceBranch targetBranch author { username } approved approvedBy { nodes { username } } resolvableDiscussionsCount resolvedDiscussionsCount headPipeline { status jobs(statuses: [FAILED], first: 8) { nodes { name allowFailure stage { name } } } }";

fn json_text(value: &impl Serialize) -> String {
    serde_json::to_string(value).unwrap_or_default()
}

/// One GraphQL query for several merge requests of several projects.
/// Strings are JSON literals, which GraphQL reads as its own.
pub fn gitlab_statuses_query(projects: &[(String, Vec<i64>)]) -> String {
    let parts: Vec<String> = projects
        .iter()
        .enumerate()
        .map(|(index, (project, numbers))| {
            let iids: Vec<String> = numbers.iter().map(i64::to_string).collect();
            format!(
                "p{index}: project(fullPath: {}) {{ mergeRequests(iids: {}, first: 100) {{ nodes {{ {GITLAB_REQUEST_FIELDS} }} }} }}",
                json_text(project),
                json_text(&iids)
            )
        })
        .collect();
    format!("query {{ {} }}", parts.join(" "))
}

/// Projects by path (as GitLab compares them), with their refs.
fn by_project(refs: &[ForgeRef]) -> Vec<Vec<ForgeRef>> {
    let mut projects: IndexMap<String, Vec<ForgeRef>> = IndexMap::new();
    for reference in refs {
        projects
            .entry(reference.project.to_lowercase())
            .or_default()
            .push(reference.clone());
    }
    projects.into_values().collect()
}

/// Statuses by [`forge_ref_key`].
pub type Statuses = Vec<(String, Value)>;

/// Several GitLab merge requests of one host in one GraphQL query. Fails
/// when GitLab answers no data at all (the caller reads them one by one).
pub async fn read_gitlab_statuses(
    context: &ForgeContext,
    host: &GlabHost,
    refs: &[ForgeRef],
) -> Result<Statuses, String> {
    let clock = clock_of(context);
    let projects = by_project(refs);
    let query = gitlab_statuses_query(
        &projects
            .iter()
            .map(|group| {
                (
                    group[0].project.clone(),
                    group.iter().map(|reference| reference.number).collect(),
                )
            })
            .collect::<Vec<_>>(),
    );
    let answer = glab(
        context,
        host,
        "POST",
        "graphql",
        &[("query".into(), query, super::gitlab::FieldKind::Raw)],
        Some(false),
        chip("mr-batch"),
    )
    .await?;
    let Some(data) = answer.get("data").and_then(Value::as_object) else {
        return Err("GitLab: no data in the GraphQL answer".into());
    };
    // A project GitLab cannot show is null; an answer without it is not one.
    if (0..projects.len()).any(|index| !data.contains_key(&format!("p{index}"))) {
        return Err("GitLab: unexpected GraphQL answer".into());
    }
    let mut statuses = Vec::new();
    for (index, group) in projects.iter().enumerate() {
        let nodes: &[Value] = data
            .get(&format!("p{index}"))
            .and_then(|project| at(project, &["mergeRequests", "nodes"]))
            .and_then(Value::as_array)
            .map(Vec::as_slice)
            .unwrap_or(&[]);
        for reference in group {
            let node = nodes
                .iter()
                .find(|entry| js::to_number(entry.get("iid")) == reference.number as f64);
            let value = match node {
                Some(node) => {
                    let pipeline = node.get("headPipeline").filter(|p| truthy(Some(p)));
                    let approved_by = at(node, &["approvedBy", "nodes"]).and_then(Value::as_array);
                    let approved = node.get("approved").and_then(Value::as_bool);
                    gitlab_status_of(
                        reference,
                        GitlabFacts {
                            mr: json!({
                                "web_url": node.get("webUrl"),
                                "references": {"full": node.get("reference")},
                                "title": node.get("title"),
                                "state": node.get("state"),
                                "draft": node.get("draft"),
                                "author": node.get("author"),
                                "source_branch": node.get("sourceBranch"),
                                "target_branch": node.get("targetBranch"),
                                "updated_at": node.get("updatedAt"),
                            }),
                            pipeline: pipeline
                                .map(|pipeline| text(pipeline.get("status"), 40).to_lowercase()),
                            failed: pipeline
                                .and_then(|pipeline| at(pipeline, &["jobs", "nodes"]))
                                .and_then(Value::as_array)
                                .map(|jobs| {
                                    jobs.iter()
                                        .map(|job| FailedJob {
                                            name: job.get("name").cloned(),
                                            stage: at(job, &["stage", "name"]).cloned(),
                                            allow_failure: job.get("allowFailure")
                                                == Some(&Value::Bool(true)),
                                        })
                                        .collect()
                                })
                                .unwrap_or_default(),
                            approvals: (approved.is_some() || approved_by.is_some())
                                .then(|| (approved, approved_by.map_or(0, Vec::len))),
                            resolvable: node.get("resolvableDiscussionsCount").cloned(),
                            resolved: node.get("resolvedDiscussionsCount").cloned(),
                        },
                        clock,
                    )
                }
                None => status(
                    reference,
                    "not_found",
                    Some("No such merge request".into()),
                    clock,
                ),
            };
            statuses.push((forge_ref_key(reference), value));
        }
    }
    Ok(statuses)
}

/// gh on the checkout's host for a chip; its own login answers for each
/// host. The chips' gh calls only read.
async fn gh(
    context: &ForgeContext,
    argv: Vec<String>,
    host: &str,
    kind: &str,
    include: bool,
    reuse_ms: Option<i64>,
) -> Result<ForgeOutput, String> {
    let call = ForgeCall {
        checkout: context.host.clone(),
        host: host.to_owned(),
        feature: "chip".into(),
        kind: kind.to_owned(),
        include,
        reuse_ms,
        ..ForgeCall::default()
    };
    let spawn_context = context.clone();
    let spawn: Spawn = Arc::new(move |full: Vec<String>| {
        let context = spawn_context.clone();
        Box::pin(async move { spawn_gh(&context, full, true).await })
    });
    let mut full = vec!["gh".to_owned()];
    full.extend(argv);
    context
        .tools
        .gate
        .run(&context.tools.owner, call, full, spawn)
        .await
        .map_err(|error| error.to_string())
}

/// gh's exit code for `auth status` on that host: 0 when logged in.
pub async fn gh_host_login(context: &ForgeContext, host: &str) -> Result<i32, String> {
    let key = format!("{}\n{host}", context.checkout_key());
    let owned = context.clone();
    let asked = host.to_owned();
    context
        .tools
        .gh_logins
        .get(
            &context.tools.clock,
            &key,
            |_| 5 * 60_000,
            move || {
                Box::pin(async move {
                    gh(
                        &owned,
                        ["auth", "status", "--hostname", &asked]
                            .map(str::to_owned)
                            .to_vec(),
                        &asked,
                        "auth",
                        false,
                        None,
                    )
                    .await
                    .map(|result| result.code)
                })
            },
        )
        .await
}

const GITHUB_QUERY: &str = "query($o: String!, $r: String!, $n: Int!) { repository(owner: $o, name: $r) { nameWithOwner pullRequest(number: $n) { number title url state isDraft updatedAt baseRefName headRefName author { login } reviewDecision reviews(states: APPROVED) { totalCount } reviewThreads(first: 100) { nodes { isResolved } } commits(last: 1) { nodes { commit { statusCheckRollup { state contexts(first: 100) { nodes { __typename ... on CheckRun { name status conclusion } ... on StatusContext { context state } } } } } } } } } }";

fn github_request_fields() -> &'static str {
    static FIELDS: LazyLock<String> = LazyLock::new(|| {
        Regex::new(r"^.*pullRequest\(number: \$n\) \{ (.*) \} \} \}$")
            .unwrap()
            .captures(GITHUB_QUERY)
            .map(|found| found[1].to_owned())
            .unwrap_or_default()
    });
    &FIELDS
}

fn owner_repo(project: &str) -> Option<(&str, &str)> {
    let mut parts = project.split('/');
    let owner = parts.next().filter(|part| !part.is_empty())?;
    let repo = parts.next().filter(|part| !part.is_empty())?;
    parts.next().is_none().then_some((owner, repo))
}

/// A GitHub pull request, its checks, approvals and open threads.
pub async fn read_github_status(context: &ForgeContext, reference: &ForgeRef) -> Value {
    let clock = clock_of(context);
    let Some((owner, repo)) = owner_repo(&reference.project) else {
        return status(reference, "not_found", None, clock);
    };
    let login = gh_host_login(context, &reference.host).await.unwrap_or(-1);
    if login == 127 {
        return status(
            reference,
            "unavailable",
            Some("gh is not installed where the checkout is".into()),
            clock,
        );
    }
    if login != 0 {
        return status(
            reference,
            "not_signed_in",
            Some(format!(
                "Not signed in to {0} (gh auth login --hostname {0})",
                reference.host
            )),
            clock,
        );
    }
    let argv = vec![
        "api".to_owned(),
        "--hostname".to_owned(),
        reference.host.clone(),
        "graphql".to_owned(),
        "-f".to_owned(),
        format!("query={GITHUB_QUERY}"),
        "-f".to_owned(),
        format!("o={owner}"),
        "-f".to_owned(),
        format!("r={repo}"),
        "-F".to_owned(),
        format!("n={}", reference.number),
    ];
    let data: Value = match gh(context, argv, &reference.host, "graphql", true, None).await {
        Ok(result) if result.code != 0 => {
            let both = format!("{}{}", result.stdout, result.stderr).to_lowercase();
            let state = if both.contains("could not resolve") {
                "not_found"
            } else {
                "error"
            };
            let reason = if result.stderr.is_empty() {
                "GitHub request failed"
            } else {
                &result.stderr
            };
            return status(
                reference,
                state,
                Some(js::head16(js::trim(reason), 300)),
                clock,
            );
        }
        Ok(result) => match serde_json::from_str(&result.stdout) {
            Ok(data) => data,
            Err(error) => {
                return status(
                    reference,
                    "error",
                    Some(js::head16(&error.to_string(), 300)),
                    clock,
                );
            }
        },
        Err(error) => return status(reference, "error", Some(js::head16(&error, 300)), clock),
    };
    github_status_of(
        reference,
        at(&data, &["data", "repository", "nameWithOwner"]),
        at(&data, &["data", "repository", "pullRequest"]),
        clock,
    )
}

/// What GraphQL says of a pull request, as a chip shows it.
fn github_status_of(
    reference: &ForgeRef,
    name_with_owner: Option<&Value>,
    pr: Option<&Value>,
    clock: &SharedClock,
) -> Value {
    let pr = pr.filter(|pr| truthy(Some(pr)));
    let url = pr.and_then(|pr| own_request_url(reference, pr.get("url")));
    let (Some(pr), Some(url)) = (pr, url) else {
        return status(reference, "not_found", None, clock);
    };
    let rollup = at(pr, &["commits", "nodes"])
        .and_then(|nodes| nodes.get(0))
        .and_then(|node| at(node, &["commit", "statusCheckRollup"]))
        .filter(|rollup| !rollup.is_null());
    let contexts: &[Value] = rollup
        .and_then(|rollup| at(rollup, &["contexts", "nodes"]))
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or(&[]);
    let failed: Vec<Value> = contexts
        .iter()
        .filter(|check| {
            if check.get("__typename").and_then(Value::as_str) == Some("CheckRun") {
                matches!(
                    check.get("conclusion").and_then(Value::as_str),
                    Some("FAILURE" | "TIMED_OUT" | "STARTUP_FAILURE" | "ACTION_REQUIRED")
                )
            } else {
                matches!(
                    check.get("state").and_then(Value::as_str),
                    Some("FAILURE" | "ERROR")
                )
            }
        })
        .take(FAILED_JOBS_SHOWN)
        .map(|check| {
            let name = match check.get("name") {
                None | Some(Value::Null) => check.get("context"),
                name => name,
            };
            json!({"name": text(name, 200)})
        })
        .collect();
    let threads: &[Value] = at(pr, &["reviewThreads", "nodes"])
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or(&[]);
    let project = text(name_with_owner, 300);
    let decision = pr.get("reviewDecision");
    json!({
        "ref": reference.value(),
        "state": "ready",
        "fetchedAt": iso_time(clock.now()),
        "request": {
            "url": url,
            "project": if project.is_empty() { reference.project.clone() } else { project },
            "title": text(pr.get("title"), 300),
            "state": match pr.get("state").and_then(Value::as_str) {
                Some("MERGED") => "merged",
                Some("CLOSED") => "closed",
                _ => "open",
            },
            "draft": pr.get("isDraft") == Some(&Value::Bool(true)),
            "author": text(at(pr, &["author", "login"]), 100),
            "sourceBranch": text(pr.get("headRefName"), 300),
            "targetBranch": text(pr.get("baseRefName"), 300),
            "updatedAt": text(pr.get("updatedAt"), 40),
            "pipeline": rollup.map(|rollup| json!({
                "status": github_pipeline_status(rollup.get("state").and_then(Value::as_str)),
                "failed": failed,
            })),
            "approvals": {
                "approved": if decision.and_then(Value::as_str) == Some("APPROVED") {
                    json!(true)
                } else if truthy(decision) {
                    json!(false)
                } else {
                    Value::Null
                },
                "count": safe_int(at(pr, &["reviews", "totalCount"])).unwrap_or(0),
            },
            "unresolved": threads.iter().filter(|thread| thread.get("isResolved") == Some(&Value::Bool(false))).count(),
        },
    })
}

/// One GraphQL query for several pull requests of several repositories.
pub fn github_statuses_query(repos: &[(String, Vec<i64>)]) -> String {
    let parts: Vec<String> = repos
        .iter()
        .enumerate()
        .map(|(index, (project, numbers))| {
            let mut split = project.split('/');
            let owner = split.next().unwrap_or("");
            let name = split.next().unwrap_or("");
            let pulls: Vec<String> = numbers
                .iter()
                .map(|number| {
                    format!(
                        "n{number}: pullRequest(number: {number}) {{ {} }}",
                        github_request_fields()
                    )
                })
                .collect();
            format!(
                "r{index}: repository(owner: {}, name: {}) {{ nameWithOwner {} }}",
                json_text(&owner),
                json_text(&name),
                pulls.join(" ")
            )
        })
        .collect();
    format!("query {{ {} }}", parts.join(" "))
}

/// Several GitHub pull requests of one host in one GraphQL query; one that
/// does not exist is not found, the others are read. Fails when GitHub
/// answers no data at all.
pub async fn read_github_statuses(
    context: &ForgeContext,
    host: &str,
    refs: &[ForgeRef],
) -> Result<Statuses, String> {
    let clock = clock_of(context);
    let repos: Vec<Vec<ForgeRef>> = by_project(refs)
        .into_iter()
        .filter(|group| owner_repo(&group[0].project).is_some())
        .collect();
    let query = github_statuses_query(
        &repos
            .iter()
            .map(|group| {
                let mut numbers: Vec<i64> = Vec::new();
                for reference in group {
                    if !numbers.contains(&reference.number) {
                        numbers.push(reference.number);
                    }
                }
                (group[0].project.clone(), numbers)
            })
            .collect::<Vec<_>>(),
    );
    let result = gh(
        context,
        vec![
            "api".into(),
            "--hostname".into(),
            host.to_owned(),
            "graphql".into(),
            "-f".into(),
            format!("query={query}"),
        ],
        host,
        "pr-batch",
        true,
        None,
    )
    .await?;
    // A missing pull request is an error beside the others' data.
    let data = serde_json::from_str::<Value>(&result.stdout)
        .ok()
        .and_then(|answer| answer.get("data").cloned())
        .filter(Value::is_object);
    let Some(data) = data else {
        let reason = if result.stderr.is_empty() {
            "GitHub request failed"
        } else {
            &result.stderr
        };
        return Err(js::head16(js::trim(reason), 300));
    };
    let mut statuses: IndexMap<String, Value> = refs
        .iter()
        .map(|reference| {
            (
                forge_ref_key(reference),
                status(reference, "not_found", None, clock),
            )
        })
        .collect();
    if (0..repos.len()).any(|index| data.get(format!("r{index}")).is_none()) {
        return Err("GitHub: unexpected GraphQL answer".into());
    }
    for (index, group) in repos.iter().enumerate() {
        let repo = &data[format!("r{index}").as_str()];
        for reference in group {
            statuses.insert(
                forge_ref_key(reference),
                github_status_of(
                    reference,
                    repo.get("nameWithOwner"),
                    repo.get(format!("n{}", reference.number).as_str()),
                    clock,
                ),
            );
        }
    }
    Ok(statuses.into_iter().collect())
}

/// What a session's repositories are, and the PR card's lookup: the
/// workspace's (workspace/review-patch.ts, workspace/pull-request.ts),
/// asked of Bun until it moves (S17).
pub trait ForgeWorkspace: Send + Sync + 'static {
    /// `scanReviewRepos({paths: [root], agentPaths, host})`: the pane's
    /// checkout, its subprojects and the repositories its agent's record
    /// shows it worked in.
    fn scan_repos(
        &self,
        context: &ForgeContext,
        agent_path: Option<String>,
    ) -> BoxFuture<Result<Vec<ScannedRepo>, String>>;
    /// `readPullRequestStatus(context, {summary: true, latest: true})`: the
    /// PR card's answer for the checkout.
    fn pull_request_status(&self, context: &ForgeContext) -> BoxFuture<Result<Value, String>>;
}

/// A repository a session works in.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ScannedRepo {
    pub root: String,
    /// Its branch, `HEAD` when detached.
    pub branch: String,
    /// The pane's own checkout.
    #[serde(default)]
    pub seed: bool,
}

type Reader = Arc<dyn Fn(Vec<ForgeRef>) -> BoxFuture<Result<Statuses, String>> + Send + Sync>;

struct Waiter {
    reference: ForgeRef,
    answer: oneshot::Sender<Result<Value, String>>,
}

struct Group {
    interest: IndexMap<String, (ForgeRef, i64)>,
    answers: HashMap<String, (i64, Value)>,
    waiting: Vec<Waiter>,
    timer: bool,
    read: Reader,
}

/// Shares answers: one request per (checkout host, forge host, project,
/// number) in flight, and each answer for a few seconds, whichever chips
/// and browsers ask; chips of one forge host asked together, and those
/// asked lately, are read with one GraphQL query.
#[derive(Clone)]
pub struct ForgeCache {
    clock: SharedClock,
    mr_cache: MrCache,
    workspace: Option<Arc<dyn ForgeWorkspace>>,
    projects: Memo<Value>,
    project_ids: Arc<Mutex<HashMap<String, i64>>>,
    groups: Arc<Mutex<HashMap<String, Group>>>,
}

fn with_ref(status: &Value, reference: &ForgeRef) -> Value {
    let mut status = status.clone();
    if let Some(map) = status.as_object_mut() {
        map.insert("ref".into(), reference.value());
    }
    status
}

impl ForgeCache {
    pub fn new(
        clock: SharedClock,
        mr_cache: MrCache,
        workspace: Option<Arc<dyn ForgeWorkspace>>,
    ) -> Self {
        Self {
            clock,
            mr_cache,
            workspace,
            projects: Memo::default(),
            project_ids: Arc::default(),
            groups: Arc::default(),
        }
    }

    /// A cache in memory only, as `createForgeCache(clock)` makes one.
    pub fn in_memory(clock: SharedClock) -> Self {
        let mr_cache = MrCache::open(clock.clone(), None, None);
        Self::new(clock, mr_cache, None)
    }

    async fn flush(&self, key: String) {
        let (waiting, refs, read) = {
            let mut groups = self.groups.lock().unwrap();
            let Some(group) = groups.get_mut(&key) else {
                return;
            };
            group.timer = false;
            let waiting: Vec<Waiter> = std::mem::take(&mut group.waiting);
            if waiting.is_empty() {
                return;
            }
            let mut refs: IndexMap<String, ForgeRef> = IndexMap::new();
            for waiter in &waiting {
                refs.insert(forge_ref_key(&waiter.reference), waiter.reference.clone());
            }
            let now = self.clock.now();
            let mut interest: Vec<(String, ForgeRef, i64)> = group
                .interest
                .iter()
                .map(|(key, (reference, at))| (key.clone(), reference.clone(), *at))
                .collect();
            interest.sort_by_key(|a| std::cmp::Reverse(a.2));
            for (key, reference, at) in interest {
                if at <= now - FORGE_INTEREST_MS {
                    group.interest.shift_remove(&key);
                } else if refs.len() < FORGE_BATCH_SIZE {
                    refs.entry(key).or_insert(reference);
                }
            }
            (
                waiting,
                refs.into_values().collect::<Vec<_>>(),
                group.read.clone(),
            )
        };
        let read = read(refs).await;
        let mut groups = self.groups.lock().unwrap();
        let now = self.clock.now();
        match read {
            Ok(statuses) => {
                if let Some(group) = groups.get_mut(&key) {
                    for (key, status) in &statuses {
                        let ttl = forge_answer_ttl(status);
                        if ttl > 0 {
                            group
                                .answers
                                .insert(key.clone(), (now + ttl, status.clone()));
                        } else {
                            group.answers.remove(key);
                        }
                    }
                    if group.answers.len() > 500 {
                        group.answers.retain(|_, (until, _)| *until > now);
                    }
                }
                let found: HashMap<&String, &Value> =
                    statuses.iter().map(|(key, status)| (key, status)).collect();
                for waiter in waiting {
                    let answer = match found.get(&forge_ref_key(&waiter.reference)) {
                        Some(status) => Ok(with_ref(status, &waiter.reference)),
                        None => Err("not in the batch's answer".to_owned()),
                    };
                    let _ = waiter.answer.send(answer);
                }
            }
            Err(error) => {
                for waiter in waiting {
                    let _ = waiter.answer.send(Err(error.clone()));
                }
            }
        }
    }

    async fn batched(
        &self,
        key: String,
        reference: &ForgeRef,
        fresh: bool,
        read: Reader,
    ) -> Result<Value, String> {
        let receiver = {
            let mut groups = self.groups.lock().unwrap();
            let group = groups.entry(key.clone()).or_insert_with(|| Group {
                interest: IndexMap::new(),
                answers: HashMap::new(),
                waiting: Vec::new(),
                timer: false,
                read: read.clone(),
            });
            let ref_key = forge_ref_key(reference);
            let now = self.clock.now();
            group
                .interest
                .insert(ref_key.clone(), (reference.clone(), now));
            if !fresh
                && let Some((until, status)) = group.answers.get(&ref_key)
                && *until > now
            {
                return Ok(with_ref(status, reference));
            }
            group.read = read;
            let (answer, receiver) = oneshot::channel();
            group.waiting.push(Waiter {
                reference: reference.clone(),
                answer,
            });
            if !group.timer {
                group.timer = true;
                let cache = self.clone();
                tokio::spawn(async move {
                    cache
                        .clock
                        .sleep(Duration::from_millis(FORGE_BATCH_WINDOW_MS))
                        .await;
                    cache.flush(key).await;
                });
            }
            receiver
        };
        receiver
            .await
            .unwrap_or_else(|_| Err("the batch was dropped".into()))
    }

    async fn gitlab_status(
        &self,
        context: &ForgeContext,
        reference: &ForgeRef,
        fresh: bool,
    ) -> Value {
        // Confidential security work never leaves GitLab: not even its title.
        if is_security_project(&reference.project) {
            return status(reference, "security", None, &self.clock);
        }
        let own_login = match glab_host_access(context, &reference.host).await {
            Ok(own) => own,
            Err(reason) => return classify_access(reference, &reason, &self.clock),
        };
        let host = GlabHost {
            host: reference.host.clone(),
            own_login: Some(own_login),
        };
        let reader_context = context.clone();
        let read: Reader = Arc::new(move |refs| {
            let context = reader_context.clone();
            let host = host.clone();
            Box::pin(async move { read_gitlab_statuses(&context, &host, &refs).await })
        });
        let key = format!(
            "gitlab\n{}\n{}\n{own_login}",
            context.checkout_key(),
            reference.host
        );
        match self.batched(key, reference, fresh, read).await {
            Ok(status) => status,
            // An older GitLab, or no answer: one by one, through REST.
            Err(_) => read_gitlab_status(context, reference).await,
        }
    }

    async fn github_status(
        &self,
        context: &ForgeContext,
        reference: &ForgeRef,
        fresh: bool,
    ) -> Value {
        if owner_repo(&reference.project).is_none() {
            return status(reference, "not_found", None, &self.clock);
        }
        let login = gh_host_login(context, &reference.host).await.unwrap_or(-1);
        if login != 0 {
            return read_github_status(context, reference).await;
        }
        let reader_context = context.clone();
        let host = reference.host.clone();
        let read: Reader = Arc::new(move |refs| {
            let context = reader_context.clone();
            let host = host.clone();
            Box::pin(async move { read_github_statuses(&context, &host, &refs).await })
        });
        let key = format!("github\n{}\n{}", context.checkout_key(), reference.host);
        match self.batched(key, reference, fresh, read).await {
            Ok(status) => status,
            Err(error) => status(
                reference,
                "error",
                Some(js::head16(&error, 300)),
                &self.clock,
            ),
        }
    }

    /// The status of a request, from the MR cache: known answers at once
    /// (marked stale, and read again in the background, once older than
    /// their state allows); `fresh`: a click on refresh, read now.
    pub async fn status(
        &self,
        context: &ForgeContext,
        reference: &ForgeRef,
        fresh: bool,
    ) -> Result<Value, String> {
        let key = format!(
            "chip\0{}\0{}",
            context.checkout_key(),
            forge_ref_key(reference)
        );
        let paused = context.tools.gate.paused_until(
            &context.tools.owner,
            &context.checkout_key(),
            &reference.host,
        );
        let cache = self.clone();
        let loader_context = context.clone();
        let loader_ref = reference.clone();
        let mr_cache = self.mr_cache.clone();
        let options = reader_options(
            move || {
                let cache = cache.clone();
                let context = loader_context.clone();
                let reference = loader_ref.clone();
                let mr_cache = mr_cache.clone();
                Box::pin(async move {
                    let value = if reference.gitlab() {
                        cache.gitlab_status(&context, &reference, fresh).await
                    } else {
                        cache.github_status(&context, &reference, fresh).await
                    };
                    let paused_until = context.tools.gate.paused_until(
                        &context.tools.owner,
                        &context.checkout_key(),
                        &reference.host,
                    );
                    Ok(Loaded {
                        ttl_ms: forge_cache_ttl(&value, &mr_cache.settings()),
                        failed: value.get("state").and_then(Value::as_str) == Some("error"),
                        paused_until: Some(paused_until),
                        value,
                    })
                })
            },
            fresh,
            None,
            paused,
        );
        let answer = self
            .mr_cache
            .get(&key, &options)
            .await
            .map_err(|error: LoadError| error.message)?;
        let mut value = with_ref(&answer.value.value, reference);
        if answer.stale
            && let Some(map) = value.as_object_mut()
        {
            map.insert("stale".into(), json!(true));
        }
        Ok(value)
    }

    /// A session's repositories and their requests, the same way.
    pub async fn session(
        &self,
        context: &ForgeContext,
        agent_path: Option<&str>,
        fresh: bool,
    ) -> Result<Value, String> {
        let Some(workspace) = self.workspace.clone() else {
            return Err("no workspace to read the session's repositories".into());
        };
        let key = format!(
            "session\0{}\0{}\0{}",
            context.checkout_key(),
            context.root,
            agent_path.unwrap_or("")
        );
        let cache = self.clone();
        let loader_context = context.clone();
        let agent_path = agent_path.map(str::to_owned);
        let options = reader_options(
            move || {
                let cache = cache.clone();
                let context = loader_context.clone();
                let agent_path = agent_path.clone();
                let workspace = workspace.clone();
                Box::pin(async move {
                    let value =
                        read_forge_session(&context, agent_path, &cache, workspace.as_ref())
                            .await
                            .map_err(|message| LoadError {
                                message,
                                paused_until: None,
                            })?;
                    Ok(Loaded {
                        value,
                        ttl_ms: FORGE_SESSION_TTL_MS,
                        failed: false,
                        paused_until: None,
                    })
                })
            },
            fresh,
            None,
            0,
        );
        let answer = self
            .mr_cache
            .get(&key, &options)
            .await
            .map_err(|error| error.message)?;
        let mut value = answer.value.value.clone();
        if answer.stale
            && let Some(map) = value.as_object_mut()
        {
            map.insert("stale".into(), json!(true));
        }
        Ok(value)
    }

    /// What `!N` and `#N` mean at `root`, remembered a while.
    async fn default_project(&self, context: &ForgeContext, root: &str) -> Result<Value, String> {
        let key = format!("{}\n{root}", context.checkout_key());
        self.projects.prune(&self.clock, &key, 500);
        let context = context.at(root);
        self.projects
            .get(
                &self.clock,
                &key,
                |_| DEFAULT_PROJECT_TTL_MS,
                move || Box::pin(async move { Ok(read_default_project(&context).await) }),
            )
            .await
    }
}

/// The fetch remotes of a checkout, by name.
pub fn remotes_script(root: &str) -> String {
    [
        enter_checkout(root),
        r#"printf 'glab %s\n' "$(GLAB_NO_PROMPT=1 glab config get host 2>/dev/null)""#.to_owned(),
        r#"git remote -v | while read -r n u k; do [ "$k" = "(fetch)" ] && printf 'url %s %s\n' "$n" "$u"; done"#.to_owned(),
        "exit 0".to_owned(),
    ]
    .join("\n")
}

/// The remote whose project `!N` and `#N` name: `upstream` when there is
/// one, else `origin`, else the only remote.
pub fn pick_default_remote(remotes: &IndexMap<String, String>) -> Option<String> {
    if remotes.contains_key("upstream") {
        return Some("upstream".into());
    }
    if remotes.contains_key("origin") {
        return Some("origin".into());
    }
    (remotes.len() == 1)
        .then(|| remotes.keys().next().cloned())
        .flatten()
}

fn project(provider: &str, host: &str, project: &str) -> Value {
    json!({"provider": provider, "host": host, "project": project})
}

/// What `!N` and `#N` mean in a checkout: the project of its upstream (or
/// origin) remote, or that project's parent when it is a fork (merge
/// requests of a fork go to its parent). Null when there is none.
pub async fn read_default_project(context: &ForgeContext) -> Value {
    static URL: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^url (\S+) (\S+)$").unwrap());
    let Ok(result) = run_forge_script(
        context,
        remotes_script(&context.root),
        "forge.remotes",
        false,
    )
    .await
    else {
        return Value::Null;
    };
    if result.code != 0 {
        return Value::Null;
    }
    let mut remotes: IndexMap<String, String> = IndexMap::new();
    let mut glab_host = String::new();
    for line in result.stdout.split('\n') {
        if let Some(found) = URL.captures(js::trim(line)) {
            remotes.insert(found[1].to_owned(), found[2].to_owned());
        } else if let Some(host) = line.strip_prefix("glab ") {
            glab_host = host_name(host);
        }
    }
    let name = pick_default_remote(&remotes);
    let Some(remote) = name
        .as_ref()
        .and_then(|name| remote_project(&remotes[name.as_str()]))
    else {
        return Value::Null;
    };
    if !valid_project(&remote.project) {
        return Value::Null;
    }
    let mut host = remote
        .host
        .strip_prefix("ssh.")
        .unwrap_or(&remote.host)
        .to_owned();
    if !valid_host(&host) {
        return Value::Null;
    }
    if !glab_host.is_empty() && remote.host == format!("ssh.{glab_host}") {
        host = glab_host.clone();
    }
    let upstream = name.as_deref() == Some("upstream");
    let github = host != glab_host
        && (host == "github.com" || gh_host_login(context, &host).await.unwrap_or(1) == 0);
    if github {
        // The fork's parent, where its pull requests go.
        if !upstream {
            let repo = gh(
                context,
                vec![
                    "api".into(),
                    "--hostname".into(),
                    host.clone(),
                    format!("repos/{}", remote.project),
                ],
                &host,
                "project",
                true,
                Some(30 * 60_000),
            )
            .await
            .ok();
            let parent = repo
                .filter(|repo| repo.code == 0)
                .and_then(|repo| serde_json::from_str::<Value>(&repo.stdout).ok())
                .and_then(|repo| {
                    at(&repo, &["parent", "full_name"])
                        .and_then(Value::as_str)
                        .map(str::to_owned)
                })
                .filter(|parent| valid_project(parent));
            if let Some(parent) = parent {
                return project("github", &host, &parent);
            }
        }
        return project("github", &host, &remote.project);
    }
    if upstream {
        return project("gitlab", &host, &remote.project);
    }
    if let Ok(own_login) = glab_host_access(context, &host).await {
        let answer = glab(
            context,
            &GlabHost {
                host: host.clone(),
                own_login: Some(own_login),
            },
            "GET",
            &format!(
                "projects/{}",
                roamgate_agents::paths::encode_uri_component(&remote.project)
            ),
            &[],
            Some(false),
            GlabCall {
                feature: Some("chip"),
                kind: Some("project"),
                reuse_ms: Some(30 * 60_000),
                input: None,
            },
        )
        .await;
        let parent = answer.ok().and_then(|answer| {
            at(&answer, &["forked_from_project", "path_with_namespace"])
                .and_then(Value::as_str)
                .map(str::to_owned)
        });
        if let Some(parent) = parent.filter(|parent| valid_project(parent)) {
            return project("gitlab", &host, &parent);
        }
    }
    // Not signed in, or unreachable: the remote's own project, whose chips
    // say why they cannot show more.
    project("gitlab", &host, &remote.project)
}

/// The repositories a session works in, as the review pane finds them,
/// each with its branch's request.
async fn read_forge_session(
    context: &ForgeContext,
    agent_path: Option<String>,
    cache: &ForgeCache,
    workspace: &dyn ForgeWorkspace,
) -> Result<Value, String> {
    let scanned = workspace.scan_repos(context, agent_path).await?;
    let seed_root = scanned
        .iter()
        .find(|repo| repo.seed)
        .map_or(context.root.clone(), |repo| repo.root.clone());
    let repos: Vec<ScannedRepo> = scanned
        .into_iter()
        .filter(|repo| repo.seed || repo.branch != "HEAD")
        .take(SESSION_REPO_LIMIT)
        .collect();
    let default_project = cache.default_project(context, &seed_root);
    let found = futures_util::future::join_all(repos.iter().map(|repo| {
        let context = context.at(&repo.root);
        async move {
            read_repo_request(&context, &cache.project_ids, workspace)
                .await
                .unwrap_or((Value::Null, Value::Null))
        }
    }));
    let (default_project, found) = futures_util::join!(default_project, found);
    Ok(json!({
        "defaultProject": default_project.unwrap_or(Value::Null),
        "repos": repos.iter().zip(found).map(|(repo, (project, request))| json!({
            "root": repo.root,
            "branch": repo.branch,
            "project": project,
            "request": request,
        })).collect::<Vec<_>>(),
        "refreshedAt": iso_time(cache.clock.now()),
    }))
}

/// A repository's forge project and its branch's request.
async fn read_repo_request(
    context: &ForgeContext,
    project_ids: &Mutex<HashMap<String, i64>>,
    workspace: &dyn ForgeWorkspace,
) -> Result<(Value, Value), String> {
    let checkout: ReviewCheckout = read_checkout(context)
        .await
        .map_err(|error| error.message().to_owned())?;
    let Some(source) = merge_request_source(&checkout) else {
        return Ok((Value::Null, Value::Null));
    };
    let Some(remote) = checkout
        .remotes
        .get(&source.remote)
        .and_then(|url| remote_project(url))
    else {
        return Ok((Value::Null, Value::Null));
    };
    let remote_host = remote
        .host
        .strip_prefix("ssh.")
        .unwrap_or(&remote.host)
        .to_owned();
    let github = remote_host == "github.com"
        || (Some(&remote_host) != checkout.gitlab_host.as_ref()
            && gh_host_login(context, &remote_host).await.unwrap_or(1) == 0);
    if github {
        // The PR card's own lookup, through gh.
        let status = workspace.pull_request_status(context).await?;
        let request = (status.get("state").and_then(Value::as_str) == Some("ready")
            && status.get("provider").and_then(Value::as_str) == Some("github"))
        .then(|| status.get("request"))
        .flatten()
        .filter(|request| truthy(Some(request)));
        return Ok((
            project("github", &remote_host, &remote.project),
            request.map_or(Value::Null, |request| {
                json!({"url": request.get("url"), "number": request.get("number"), "title": request.get("title")})
            }),
        ));
    }
    let host = gitlab_host_for(
        &remote.host,
        checkout.gitlab_host.as_deref(),
        &checkout.gitlab_logins,
    );
    let found_project = project(
        "gitlab",
        host.as_deref().unwrap_or(&remote_host),
        &remote.project,
    );
    // No login for that host: its token is never sent there.
    if host.is_none() || is_security_project(&remote.project) {
        return Ok((found_project, Value::Null));
    }
    let found = find_branch_merge_request(context, &checkout, project_ids).await?;
    match found {
        Some(found)
            if !is_security_project(
                &parse_forge_url(&found.url)
                    .map(|reference| reference.project)
                    .unwrap_or_default(),
            ) =>
        {
            Ok((
                found_project,
                json!({"url": found.url, "number": found.number, "title": found.title}),
            ))
        }
        _ => Ok((found_project, Value::Null)),
    }
}

/// A reference from the browser, checked before anything runs.
pub fn parse_forge_ref_param(value: &Value) -> Option<ForgeRef> {
    let raw = value.as_object()?;
    let provider = raw.get("provider").and_then(Value::as_str)?;
    if provider != "gitlab" && provider != "github" {
        return None;
    }
    let host = raw
        .get("host")
        .and_then(Value::as_str)
        .map(str::to_lowercase)
        .unwrap_or_default();
    let project = raw.get("project").and_then(Value::as_str).unwrap_or("");
    let number = raw.get("number").and_then(Value::as_f64)?;
    if !valid_host(&host)
        || !valid_project(project)
        || !js::is_safe_integer(number)
        || number <= 0.0
    {
        return None;
    }
    Some(ForgeRef {
        provider: provider.to_owned(),
        host,
        project: project.to_owned(),
        number: number as i64,
    })
}

#[cfg(test)]
mod tests;
