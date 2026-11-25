//! GitLab through `glab api` on the checkout's host (review/gitlab.ts), as
//! the PR/MR card does: the user's own glab login, over the connection's
//! SSH master remotely. Draft notes are the one state shared with
//! maildesk: they are read and written straight on the merge request,
//! never kept here.
//!
//! A merge request URL may name a GitHub pull request: each function then
//! goes to [`super::github`], so that the review service has one path.

use std::collections::HashMap;
use std::sync::{Arc, LazyLock, Mutex};

use indexmap::IndexMap;
use regex::Regex;
use roamgate_agents::js;
use roamgate_agents::paths::encode_uri_component;
use roamgate_review::diff::{ReviewDiff, ReviewDiffFile, parse_unified_diff};
use roamgate_review::model::{
    ReviewAnchor, ReviewComment, ReviewCommit, ReviewThread, ReviewThreadGitlab,
};
use roamgate_review::parse::{MergeRequestRef, is_github_pull_url, parse_merge_request_url};
use roamgate_review::service::LoadError;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use sha1::Digest as _;

use super::cli::{
    ApiFile, CliOptions, ForgeContext, RunError, api_files_patch, base64_file, cli_error,
    commit_from_message, run_forge_cli, run_forge_script, truthy,
};
use super::github;
use crate::gate::{ForgeCall, Spawn};
use crate::pages::parse_json_pages;

/// A merge request as the review reads it (MergeRequestInfo).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MergeRequestInfo {
    pub host: String,
    pub project: String,
    pub iid: i64,
    /// `github`: a GitHub pull request; none: GitLab.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub forge: Option<String>,
    /// The project's path as the forge answers it (from the request's web
    /// URL): the URL may name it by its numeric id or a former path.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project_path: Option<String>,
    pub url: String,
    pub title: String,
    pub state: String,
    pub base_sha: String,
    pub start_sha: String,
    pub head_sha: String,
    /// GitLab's updated_at: a new note or resolution moves it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub updated_at: Option<String>,
}

impl MergeRequestInfo {
    pub fn is_github(&self) -> bool {
        self.forge.as_deref() == Some("github")
    }
}

/// A draft note as GitLab answers it (GitLabDraft); a GitHub pending
/// comment is shaped the same way.
#[derive(Debug, Clone, PartialEq)]
pub struct GitLabDraft {
    pub id: i64,
    pub note: String,
    /// Set on a reply to a discussion.
    pub discussion_id: Option<String>,
    /// `{old_path, new_path, old_line, new_line}`, or null.
    pub position: Value,
}

impl GitLabDraft {
    /// A draft from GitLab's JSON.
    pub fn from_value(value: &Value) -> Self {
        Self {
            id: js::to_number(value.get("id")) as i64,
            note: js::str_of(value.get("note")).unwrap_or("").to_owned(),
            discussion_id: value
                .get("discussion_id")
                .filter(|v| !v.is_null())
                .map(js::to_text),
            position: value.get("position").cloned().unwrap_or(Value::Null),
        }
    }
}

/// How a field is sent: `-f` (a string) or `-F` (typed).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FieldKind {
    Raw,
    Typed,
}

pub type Field = (String, String, FieldKind);

fn raw(key: &str, value: impl Into<String>) -> Field {
    (key.to_owned(), value.into(), FieldKind::Raw)
}

fn typed(key: &str, value: impl ToString) -> Field {
    (key.to_owned(), value.to_string(), FieldKind::Typed)
}

/// The fields as `glab api` and `gh api` take them.
pub fn field_args(fields: &[Field]) -> Vec<String> {
    fields
        .iter()
        .flat_map(|(key, value, kind)| {
            [
                match kind {
                    FieldKind::Raw => "-f",
                    FieldKind::Typed => "-F",
                }
                .to_owned(),
                format!("{key}={value}"),
            ]
        })
        .collect()
}

/// maildesk's rule: confidential security work never leaves GitLab.
pub fn is_security_project(project: &str) -> bool {
    project.to_lowercase().contains("security")
}

fn mr_path(project: &str, iid: i64) -> String {
    format!(
        "projects/{}/merge_requests/{iid}",
        encode_uri_component(project)
    )
}

/// Variables that make glab use one token for every host.
pub const TOKEN_VARIABLES: [&str; 3] = ["GITLAB_TOKEN", "GITLAB_ACCESS_TOKEN", "OAUTH_TOKEN"];

/// How long what glab knows of a host is remembered.
const HOST_CHECK_TTL_MS: i64 = 5 * 60_000;

/// Prints glab's default host, and `login` when glab has a token of its
/// own for `host` (as [`read_checkout_script`] tells logins): never the
/// token.
pub fn glab_host_script(root: &str, host: &str) -> String {
    let q = roamgate_exec::quote::shell_quote;
    [
        format!("{{ cd {} 2>/dev/null || cd; }}", q(root)),
        "command -v glab >/dev/null 2>&1 || exit 127".to_owned(),
        "g=$(GLAB_NO_PROMPT=1 glab config get host 2>/dev/null)".to_owned(),
        r#"printf 'glab %s\n' "$g""#.to_owned(),
        format!(
            r#"token() {{ (unset {}; GLAB_NO_PROMPT=1 glab config get token --host "$1" 2>/dev/null); }}"#,
            TOKEN_VARIABLES.join(" ")
        ),
        format!("t=$(token {})", q(host)),
        r#"[ -n "$t" ] && [ "$t" != "$(token roamgate.invalid)" ] && printf 'login\n'"#.to_owned(),
        "exit 0".to_owned(),
    ]
    .join("\n")
}

/// A host as glab's config may write it: no scheme, no path, lower case.
pub(crate) fn host_name(value: &str) -> String {
    static SCHEME: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)^[a-z]+://").unwrap());
    let trimmed = js::trim(value);
    let bare = SCHEME.replace(trimmed, "");
    let host = bare.split('/').next().unwrap_or("");
    host.to_lowercase()
}

/// Whether a GitLab host may be asked from the checkout's host, and with
/// which token: true when it is asked with glab's own login for it. A
/// token in the environment (GITLAB_TOKEN and the like), or one in glab's
/// config for no host in particular, answers for any host: only glab's
/// default host gets it. Another host is asked only when glab has a login
/// of its own for it, with the environment's tokens removed; any other
/// host is refused before glab runs, so that a merge request URL cannot
/// send the user's token anywhere.
pub async fn glab_host_access(context: &ForgeContext, host: &str) -> Result<bool, String> {
    let key = format!(
        "{}\n{}\n{}",
        context.checkout_key(),
        context.root,
        host.to_lowercase()
    );
    let owned = context.clone();
    let asked = host.to_owned();
    context
        .tools
        .host_checks
        .get(
            &context.tools.clock,
            &key,
            |_| HOST_CHECK_TTL_MS,
            move || Box::pin(async move { check_glab_host(&owned, &asked).await }),
        )
        .await
}

const NOT_INSTALLED: &str = "glab is not installed on this host";

async fn check_glab_host(context: &ForgeContext, host: &str) -> Result<bool, String> {
    let script = glab_host_script(&context.root, host);
    let result = match run_forge_script(context, script, "review.gitlab", true).await {
        Ok(result) => result,
        Err(RunError::Missing(_)) => return Err(NOT_INSTALLED.to_owned()),
        Err(RunError::Failed(message)) => return Err(message),
    };
    if result.code == 127 {
        return Err(NOT_INSTALLED.to_owned());
    }
    if result.code != 0 {
        let reason = if result.stderr.is_empty() {
            "it failed"
        } else {
            &result.stderr
        };
        return Err(format!(
            "GitLab: cannot ask glab about {host}: {}",
            js::head16(js::trim(reason), 200)
        ));
    }
    let lines: Vec<&str> = result.stdout.split('\n').map(js::trim).collect();
    let default_host = host_name(
        lines
            .iter()
            .find_map(|line| line.strip_prefix("glab "))
            .unwrap_or(""),
    );
    let asked = host.to_lowercase();
    if !default_host.is_empty() && asked == default_host {
        return Ok(false);
    }
    if lines.contains(&"login") {
        return Ok(true);
    }
    Err(format!(
        "GitLab: glab has no login for {host} here; not sending it a token (glab auth login --hostname {host})"
    ))
}

/// Who asks and what, for the forge gate's log (glab's `call`).
#[derive(Debug, Clone, Default)]
pub struct GlabCall {
    pub feature: Option<&'static str>,
    pub kind: Option<&'static str>,
    /// Share an identical read's answer this long.
    pub reuse_ms: Option<i64>,
    /// A body sent from a file of this host, of this type (an upload).
    pub input: Option<(String, String)>,
}

/// The host a call goes to; `own_login` none: [`glab_host_access`] tells,
/// or refuses the host.
#[derive(Debug, Clone)]
pub struct GlabHost {
    pub host: String,
    pub own_login: Option<bool>,
}

impl GlabHost {
    pub fn unchecked(host: &str) -> Self {
        Self {
            host: host.to_owned(),
            own_login: None,
        }
    }
}

/// A `glab api` call, through the forge gate: reads with its budget,
/// sharing and If-None-Match, writes with its budget only. `paginate`:
/// none is a GET's default (paginated).
pub async fn glab(
    context: &ForgeContext,
    host: &GlabHost,
    method: &str,
    path: &str,
    fields: &[Field],
    paginate: Option<bool>,
    call: GlabCall,
) -> Result<Value, String> {
    let own_login = match host.own_login {
        Some(own) => own,
        None => glab_host_access(context, &host.host).await?,
    };
    let paginate = paginate.unwrap_or(method == "GET");
    let read = method == "GET" || path == "graphql";
    let mut argv: Vec<String> = ["glab", "api", "--hostname", &host.host, "--method", method]
        .iter()
        .map(|word| (*word).to_owned())
        .collect();
    if paginate {
        argv.push("--paginate".into());
    }
    if let Some((file, kind)) = &call.input {
        argv.extend([
            "--header".to_owned(),
            format!("Content-Type: {kind}"),
            "--input".to_owned(),
            file.clone(),
        ]);
    }
    argv.push(path.to_owned());
    argv.extend(field_args(fields));
    let kind = call.kind.map(str::to_owned).unwrap_or_else(|| {
        if path == "graphql" {
            "graphql".to_owned()
        } else if read {
            "read".to_owned()
        } else {
            method.to_lowercase()
        }
    });
    let gate_call = ForgeCall {
        checkout: context.host.clone(),
        host: host.host.clone(),
        feature: call.feature.unwrap_or("review").to_owned(),
        kind,
        deadline: None,
        include: read && !paginate,
        conditional: method == "GET" && !paginate,
        reuse_ms: if read { call.reuse_ms } else { None },
    };
    let spawn_context = context.clone();
    let retry_safe = method == "GET";
    let spawn: Spawn = Arc::new(move |full: Vec<String>| {
        let context = spawn_context.clone();
        Box::pin(async move {
            run_forge_cli(
                &context,
                full,
                CliOptions {
                    env: &[
                        ("GLAB_NO_PROMPT", "1"),
                        ("GIT_TERMINAL_PROMPT", "0"),
                        ("NO_COLOR", "1"),
                    ],
                    retry_safe,
                    tag: "review.gitlab",
                    unset: if own_login { &TOKEN_VARIABLES } else { &[] },
                },
            )
            .await
        })
    });
    let result = context
        .tools
        .gate
        .run(&context.tools.owner, gate_call, argv, spawn)
        .await
        .map_err(|error| error.to_string())?;
    if result.code == 127 {
        return Err(NOT_INSTALLED.to_owned());
    }
    if result.code != 0 {
        let text = if result.stderr.is_empty() {
            &result.stdout
        } else {
            &result.stderr
        };
        return Err(cli_error("GitLab", text));
    }
    let text = js::trim(&result.stdout);
    if text.is_empty() {
        return Ok(Value::Null);
    }
    if !paginate {
        return serde_json::from_str(text).map_err(|error| error.to_string());
    }
    // --paginate prints one JSON array per page back to back.
    let mut pages = parse_json_pages(text)?;
    if pages.len() == 1 {
        return Ok(pages.remove(0));
    }
    if !pages.iter().all(Value::is_array) {
        return Err("GitLab: unexpected answer to a paged request".into());
    }
    Ok(Value::Array(
        pages
            .into_iter()
            .flat_map(|page| match page {
                Value::Array(items) => items,
                _ => Vec::new(),
            })
            .collect(),
    ))
}

/// A GET, paginated.
async fn glab_get(context: &ForgeContext, host: &GlabHost, path: &str) -> Result<Value, String> {
    glab(context, host, "GET", path, &[], None, GlabCall::default()).await
}

fn text_of(value: Option<&Value>) -> Option<String> {
    value.and_then(Value::as_str).map(str::to_owned)
}

/// `String(value ?? fallback)`.
fn js_string(value: Option<&Value>, fallback: &str) -> String {
    match value {
        None | Some(Value::Null) => fallback.to_owned(),
        Some(value) => js::to_text(value),
    }
}

fn truthy_text(value: Option<&Value>) -> Option<&str> {
    value
        .and_then(Value::as_str)
        .filter(|text| !text.is_empty())
}

/// The merge request (or pull request) a URL names.
pub async fn read_merge_request(
    context: &ForgeContext,
    url: &str,
) -> Result<MergeRequestInfo, String> {
    if is_github_pull_url(url) {
        return github::read_pull_request(context, url).await;
    }
    let reference =
        parse_merge_request_url(url).ok_or_else(|| "not a GitLab merge request URL".to_owned())?;
    let mr = glab_get(
        context,
        &GlabHost::unchecked(&reference.host),
        &mr_path(&reference.project, reference.iid),
    )
    .await?;
    let refs = mr.get("diff_refs");
    let sha = |name: &str| truthy_text(refs.and_then(|refs| refs.get(name))).map(str::to_owned);
    let (Some(head_sha), Some(base_sha)) = (sha("head_sha"), sha("base_sha")) else {
        return Err("GitLab has no diff for this merge request yet".into());
    };
    let start_sha = refs
        .and_then(|refs| refs.get("start_sha"))
        .and_then(Value::as_str)
        .map(str::to_owned)
        .unwrap_or_else(|| base_sha.clone());
    let web_url = js::str_of(mr.get("web_url")).unwrap_or("").to_owned();
    static FULL: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"!\d+$").unwrap());
    let full_reference = mr
        .get("references")
        .and_then(|references| references.get("full"))
        .and_then(Value::as_str)
        .map(|full| FULL.replace(full, "").into_owned())
        .unwrap_or_default();
    let project_path = parse_merge_request_url(&web_url)
        .map(|found| found.project)
        .filter(|project| !project.is_empty())
        .or_else(|| (!full_reference.is_empty()).then_some(full_reference));
    Ok(MergeRequestInfo {
        host: reference.host,
        project: reference.project,
        iid: reference.iid,
        forge: None,
        project_path,
        url: if web_url.is_empty() {
            url.to_owned()
        } else {
            web_url
        },
        title: js_string(mr.get("title"), ""),
        state: js_string(mr.get("state"), ""),
        base_sha,
        start_sha,
        head_sha,
        updated_at: text_of(mr.get("updated_at")),
    })
}

fn host_of(mr: &MergeRequestInfo) -> GlabHost {
    GlabHost::unchecked(&mr.host)
}

/// A file GitLab lists, too large or collapsed shown as binary.
fn api_file(file: &Value) -> ApiFile {
    let truthy = |name: &str| truthy(file.get(name));
    ApiFile {
        old_path: js_string(file.get("old_path"), ""),
        new_path: js_string(file.get("new_path"), ""),
        added: truthy("new_file"),
        deleted: truthy("deleted_file"),
        patch: (!truthy("too_large") && !truthy("collapsed"))
            .then(|| js_string(file.get("diff"), "")),
    }
}

fn items(value: &Value) -> &[Value] {
    value.as_array().map(Vec::as_slice).unwrap_or(&[])
}

/// The MR's diff from the API, for when its commits are not in the
/// checkout.
pub async fn read_merge_request_diff(
    context: &ForgeContext,
    mr: &MergeRequestInfo,
) -> Result<ReviewDiff, String> {
    if mr.is_github() {
        return github::read_pull_diff(context, mr).await;
    }
    let files = glab_get(
        context,
        &host_of(mr),
        &format!("{}/diffs?per_page=100", mr_path(&mr.project, mr.iid)),
    )
    .await?;
    let files: Vec<ApiFile> = items(&files).iter().map(api_file).collect();
    Ok(ReviewDiff {
        files: parse_unified_diff(&api_files_patch(&files)),
        base_sha: Some(mr.base_sha.clone()),
        head_sha: Some(mr.head_sha.clone()),
        truncated: false,
        extra: Map::new(),
    })
}

fn line_of(value: Option<&Value>) -> Option<i64> {
    value
        .and_then(Value::as_f64)
        .filter(|n| *n != 0.0 && !n.is_nan())
        .map(|n| n as i64)
}

/// The anchor of a note's position; on one commit of the MR, that commit
/// against its parent.
pub fn anchor_of(position: &Value, mr: Option<&MergeRequestInfo>) -> ReviewAnchor {
    if !truthy(Some(position)) {
        return ReviewAnchor::default();
    }
    let mut anchor = anchor_of_line(position);
    // A note written on one commit of the MR: its base is that commit's
    // parent (start and base agree), not the MR's base.
    let head = truthy_text(position.get("head_sha"));
    let base = truthy_text(position.get("base_sha"));
    if let (Some(mr), Some(head), Some(base)) = (mr, head, base)
        && position.get("start_sha").and_then(Value::as_str) == Some(base)
        && base != mr.base_sha
    {
        anchor.commit = Some(head.to_owned());
        anchor.commit_parent = Some(base.to_owned());
    }
    anchor
}

fn anchor_of_line(position: &Value) -> ReviewAnchor {
    let new_line = line_of(position.get("new_line"));
    let old_line = line_of(position.get("old_line"));
    let new_path = text_of(position.get("new_path"));
    let old_path = text_of(position.get("old_path"));
    if let Some(line) = new_line {
        return ReviewAnchor {
            path: new_path.clone().or_else(|| old_path.clone()),
            line: Some(line),
            side: Some("new".into()),
            context_old: old_line,
            old_path: old_path.filter(|old| Some(old) != new_path.as_ref()),
            ..ReviewAnchor::default()
        };
    }
    if let Some(line) = old_line {
        return ReviewAnchor {
            path: old_path.or(new_path),
            line: Some(line),
            side: Some("old".into()),
            ..ReviewAnchor::default()
        };
    }
    ReviewAnchor {
        path: new_path.or(old_path),
        ..ReviewAnchor::default()
    }
}

/// The MR's discussions (system notes dropped) as read-only threads, and
/// every page of the user's draft notes as review comments: whichever app
/// wrote them, the user sees all of their pending review.
pub async fn read_merge_request_threads(
    context: &ForgeContext,
    mr: &MergeRequestInfo,
    session_id: &str,
) -> Result<Vec<ReviewThread>, String> {
    if mr.is_github() {
        let (threads, drafts) = futures_util::future::join(
            github::read_pull_threads(context, mr, session_id),
            github::read_pull_drafts(context, mr),
        )
        .await;
        return Ok(with_drafts(threads?, drafts?, session_id, mr));
    }
    let base = mr_path(&mr.project, mr.iid);
    let host = host_of(mr);
    let (discussions, drafts) = futures_util::future::join(
        glab_get(context, &host, &format!("{base}/discussions?per_page=100")),
        glab_get(context, &host, &format!("{base}/draft_notes?per_page=100")),
    )
    .await;
    let (discussions, drafts) = (discussions?, drafts?);
    let mut threads = Vec::new();
    for raw in items(&discussions) {
        let notes: Vec<&Value> = items(raw.get("notes").unwrap_or(&Value::Null))
            .iter()
            .filter(|note| !truthy(note.get("system")))
            .collect();
        let Some(first) = notes.first() else {
            continue;
        };
        let position = first.get("position").cloned().unwrap_or(Value::Null);
        let at = js_string(first.get("created_at"), "");
        let id = js_string(raw.get("id"), "undefined");
        let resolvable = |note: &&Value| truthy(note.get("resolvable"));
        let resolved = notes.iter().any(resolvable)
            && notes
                .iter()
                .all(|note| !resolvable(note) || truthy(note.get("resolved")));
        let comments = notes
            .iter()
            .map(|note| {
                let created = js_string(note.get("created_at"), &at);
                let updated = match note.get("updated_at") {
                    None | Some(Value::Null) => created.clone(),
                    Some(value) => js::to_text(value),
                };
                let username = note
                    .get("author")
                    .and_then(|author| author.get("username"))
                    .filter(|name| !name.is_null())
                    .map(js::to_text)
                    .unwrap_or_else(|| "someone".into());
                ReviewComment {
                    id: format!("gl:{id}:{}", js_string(note.get("id"), "undefined")),
                    author: format!("@{username}"),
                    body: js_string(note.get("body"), ""),
                    created_at: created,
                    updated_at: updated,
                    gitlab_draft_id: None,
                    extra: Map::new(),
                }
            })
            .collect();
        threads.push(ReviewThread {
            id: format!("gl:{id}"),
            session_id: session_id.to_owned(),
            kind: "merge-request".into(),
            anchor: anchor_of(&position, Some(mr)),
            comments,
            resolved,
            created_at: at.clone(),
            updated_at: at,
            held: None,
            gitlab: Some(ReviewThreadGitlab {
                discussion_id: Some(id),
                head_sha: position
                    .get("head_sha")
                    .filter(|sha| truthy(Some(sha)))
                    .map(js::to_text),
                ..ReviewThreadGitlab::default()
            }),
            gitlab_reply_to: None,
            pending_for: None,
            handed_at: None,
            extra: Map::new(),
            inst: 0,
        });
    }
    let drafts = items(&drafts).iter().map(GitLabDraft::from_value).collect();
    Ok(with_drafts(threads, drafts, session_id, mr))
}

/// The drafts placed among the threads: a draft reply goes under its
/// discussion, after what it answers; any other is a thread of its own.
fn with_drafts(
    mut threads: Vec<ReviewThread>,
    drafts: Vec<GitLabDraft>,
    session_id: &str,
    mr: &MergeRequestInfo,
) -> Vec<ReviewThread> {
    let discussions: HashMap<String, usize> = threads
        .iter()
        .enumerate()
        .filter_map(|(at, thread)| {
            let id = thread.gitlab.as_ref()?.discussion_id.clone()?;
            Some((id, at))
        })
        .collect();
    for draft in drafts {
        match draft
            .discussion_id
            .as_ref()
            .filter(|id| !id.is_empty())
            .and_then(|id| discussions.get(id))
        {
            Some(&at) => threads[at].comments.push(draft_reply(&draft)),
            None => threads.push(draft_thread(&draft, session_id, Some(mr))),
        }
    }
    threads
}

/// `new Date(0).toISOString()`: drafts carry no time.
pub const EPOCH: &str = "1970-01-01T00:00:00.000Z";

/// A draft reply in a discussion: the user's, until they submit it.
pub fn draft_reply(draft: &GitLabDraft) -> ReviewComment {
    ReviewComment {
        id: format!("gldraft:{}", draft.id),
        author: "you".into(),
        body: draft.note.clone(),
        created_at: EPOCH.into(),
        updated_at: EPOCH.into(),
        gitlab_draft_id: Some(draft.id),
        extra: Map::new(),
    }
}

/// A draft note as the user's review comment.
pub fn draft_thread(
    draft: &GitLabDraft,
    session_id: &str,
    mr: Option<&MergeRequestInfo>,
) -> ReviewThread {
    ReviewThread {
        id: format!("gldraft:{}", draft.id),
        session_id: session_id.to_owned(),
        kind: "draft".into(),
        anchor: anchor_of(&draft.position, mr),
        comments: vec![ReviewComment::new(
            format!("gldraft:{}", draft.id),
            "you".into(),
            draft.note.clone(),
            EPOCH,
        )],
        resolved: false,
        created_at: EPOCH.into(),
        updated_at: EPOCH.into(),
        held: None,
        gitlab: Some(ReviewThreadGitlab {
            draft_id: Some(draft.id),
            ..ReviewThreadGitlab::default()
        }),
        gitlab_reply_to: None,
        pending_for: None,
        handed_at: None,
        extra: Map::new(),
        inst: 0,
    }
}

/// A diff line where GitLab places a note, as its diff numbers it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PositionLine {
    /// " ", "+" or "-".
    pub kind: String,
    /// The line's own numbers: none on the side it is not on.
    pub old_line: Option<i64>,
    pub new_line: Option<i64>,
    /// GitLab's counters (an added line's old_pos is the next old line).
    pub old_pos: i64,
    pub new_pos: i64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DiffPosition {
    pub old_path: String,
    pub new_path: String,
    pub start: PositionLine,
    pub end: PositionLine,
    /// Its end was asked apart from its start (a range).
    pub range: bool,
}

fn nonzero(value: Option<i64>) -> Option<i64> {
    value.filter(|n| *n != 0)
}

/// Where an anchor's first and last lines are in the diff, with what
/// GitLab needs of each: whether it is unchanged, added or removed, and
/// both numbers. None when the diff does not show them.
pub fn diff_position(files: &[ReviewDiffFile], anchor: &ReviewAnchor) -> Option<DiffPosition> {
    let path = anchor.path.as_deref().filter(|path| !path.is_empty())?;
    let line = nonzero(anchor.line)?;
    let old = anchor.side.as_deref() == Some("old");
    let file = files
        .iter()
        .find(|entry| {
            if old {
                entry.old_path == path
            } else {
                entry.path == path
            }
        })
        .or_else(|| {
            files.iter().find(|entry| {
                if old {
                    entry.path == path
                } else {
                    entry.old_path == path
                }
            })
        })?;
    if file.commit_message {
        return None;
    }
    static HEADER: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"^@@ -(\d+)(?:,\d+)? \+(\d+)").unwrap());
    let find = |number: i64| -> Option<PositionLine> {
        for hunk in &file.hunks {
            let header = HEADER.captures(&hunk.header);
            let start = |at: usize| {
                header
                    .as_ref()
                    .and_then(|found| found[at].parse::<i64>().ok())
                    .unwrap_or(1)
            };
            let (mut next_old, mut next_new) = (start(1), start(2));
            for row in &hunk.lines {
                if row.expanded {
                    continue;
                }
                let old_pos = row.old.unwrap_or(next_old);
                let new_pos = row.new.unwrap_or(next_new);
                if let Some(at) = row.old {
                    next_old = at + 1;
                }
                if let Some(at) = row.new {
                    next_new = at + 1;
                }
                let own = if old { row.old } else { row.new };
                if own != Some(number) {
                    continue;
                }
                if (old && row.kind == "+") || (!old && row.kind == "-") {
                    continue;
                }
                return Some(PositionLine {
                    kind: row.kind.clone(),
                    old_line: if row.kind == "+" { None } else { row.old },
                    new_line: if row.kind == "-" { None } else { row.new },
                    old_pos,
                    new_pos,
                });
            }
        }
        None
    };
    let start = find(line)?;
    let end_line = nonzero(anchor.end_line);
    let end = match end_line {
        Some(end) => find(end)?,
        None => start.clone(),
    };
    Some(DiffPosition {
        old_path: file.old_path.clone(),
        new_path: file.path.clone(),
        start,
        end,
        range: end_line.is_some(),
    })
}

fn line_fields(prefix: &str, line: &PositionLine) -> Vec<Field> {
    let mut fields = Vec::new();
    if let Some(old) = line.old_line {
        fields.push(typed(&format!("{prefix}[old_line]"), old));
    }
    if let Some(new) = line.new_line {
        fields.push(typed(&format!("{prefix}[new_line]"), new));
    }
    fields
}

fn position_fields(
    mr: &MergeRequestInfo,
    anchor: &ReviewAnchor,
    diff: Option<&[ReviewDiffFile]>,
) -> Vec<Field> {
    let (Some(path), Some(line)) = (
        anchor.path.as_deref().filter(|path| !path.is_empty()),
        nonzero(anchor.line),
    ) else {
        return Vec::new();
    };
    // On one commit's view the position is that commit against its parent,
    // as maildesk posts it; otherwise the MR's whole diff.
    let on_commit = match (
        anchor.commit.as_deref().filter(|c| !c.is_empty()),
        anchor.commit_parent.as_deref().filter(|c| !c.is_empty()),
    ) {
        (Some(commit), Some(parent)) => Some((commit, parent)),
        _ => None,
    };
    let placed = diff.and_then(|files| diff_position(files, anchor));
    let mut fields = vec![
        raw("position[position_type]", "text"),
        raw(
            "position[base_sha]",
            on_commit.map_or(mr.base_sha.as_str(), |(_, parent)| parent),
        ),
        raw(
            "position[start_sha]",
            on_commit.map_or(mr.start_sha.as_str(), |(_, parent)| parent),
        ),
        raw(
            "position[head_sha]",
            on_commit.map_or(mr.head_sha.as_str(), |(commit, _)| commit),
        ),
        raw(
            "position[old_path]",
            placed
                .as_ref()
                .map(|placed| placed.old_path.clone())
                .or_else(|| anchor.old_path.clone())
                .unwrap_or_else(|| path.to_owned()),
        ),
        raw(
            "position[new_path]",
            placed
                .as_ref()
                .map_or(path.to_owned(), |placed| placed.new_path.clone()),
        ),
    ];
    if let Some(placed) = placed {
        // The note sits on the last line: an unchanged one needs both
        // numbers, an added one only the new, a removed one only the old.
        fields.extend(line_fields("position", &placed.end));
        if placed.range {
            let code = hex(&sha1::Sha1::digest(placed.new_path.as_bytes()));
            for (name, line) in [("start", &placed.start), ("end", &placed.end)] {
                let prefix = format!("position[line_range][{name}]");
                fields.push(raw(
                    &format!("{prefix}[line_code]"),
                    format!("{code}_{}_{}", line.old_pos, line.new_pos),
                ));
                fields.push(raw(
                    &format!("{prefix}[type]"),
                    if line.kind == "+" { "new" } else { "old" },
                ));
                fields.extend(line_fields(&prefix, line));
            }
        }
        return fields;
    }
    // Not in the diff at hand: the anchor's own numbers, on its last line.
    let last = anchor.end_line.unwrap_or(line);
    if anchor.side.as_deref() == Some("old") {
        fields.push(typed("position[old_line]", last));
    } else {
        fields.push(typed("position[new_line]", last));
        // Unchanged lines need both numbers, or GitLab refuses the
        // position; only the first line's old number is known.
        if let (Some(old), None) = (anchor.context_old, anchor.end_line) {
            fields.push(typed("position[old_line]", old));
        }
    }
    fields
}

pub(crate) fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// Markdown images in a comment: `![alt](<path>)` or `![alt](path)`, the
/// source in group 2 or 3.
static MARKDOWN_IMAGE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"!\[([^\]\n]*)\]\((?:<([^>\n]+)>|([^)\s]+))\)").unwrap());

/// An image of this host: an absolute path (a drive's on Windows), not
/// `//` nor `/uploads/`.
fn local_image(source: &str) -> Option<String> {
    static EXTENSION: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"(?i)\.(png|jpe?g|gif|webp)$").unwrap());
    let absolute =
        source.starts_with('/') || (cfg!(windows) && std::path::Path::new(source).is_absolute());
    if !absolute
        || source.starts_with("//")
        || source.starts_with("/uploads/")
        || source.contains(['?', '#', '\0'])
    {
        return None;
    }
    EXTENSION
        .captures(source)
        .map(|found| found[1].to_lowercase())
}

fn image_type(extension: &str) -> &'static str {
    match extension {
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        _ => "image/png",
    }
}

/// The images of a comment that are files of this host (pasted ones).
pub fn local_images(note: &str) -> Vec<String> {
    let mut found: Vec<String> = Vec::new();
    for image in MARKDOWN_IMAGE.captures_iter(note) {
        let source = image
            .get(2)
            .or_else(|| image.get(3))
            .map_or("", |m| m.as_str());
        if local_image(source).is_some() && !found.iter().any(|known| known == source) {
            found.push(source.to_owned());
        }
    }
    found
}

/// A comment as it goes to the forge: its images that are files of this
/// host (pasted in Roamgate, read by agents from there) uploaded to the
/// merge request's project and linked from there. GitHub has no upload for
/// them, and a checkout on another host cannot send this host's files:
/// refused then, said plainly, rather than sent with broken images.
pub async fn forge_note(
    context: &ForgeContext,
    mr: &MergeRequestInfo,
    note: &str,
) -> Result<String, String> {
    let images = local_images(note);
    if images.is_empty() {
        return Ok(note.to_owned());
    }
    if mr.is_github() {
        return Err("GitHub takes no images from Roamgate: remove them from the comment, or add them on GitHub".into());
    }
    if context.host.is_some() {
        return Err("images go to GitLab only from a checkout on this machine: remove them from the comment, or add them on GitLab".into());
    }
    let folder = tempfile::Builder::new()
        .prefix("roamgate-forge-image-")
        .tempdir()
        .map_err(|error| error.to_string())?;
    let mut urls: HashMap<String, String> = HashMap::new();
    for (index, path) in images.iter().enumerate() {
        let extension = local_image(path).unwrap_or_else(|| "png".into());
        let name = format!("image-{}.{extension}", index + 1);
        let boundary = format!(
            "roamgate{}",
            &hex(&sha2::Sha256::digest(path.as_bytes()))[..24]
        );
        let data = tokio::fs::read(path)
            .await
            .map_err(|error| format!("{path}: {error}"))?;
        let mut body = format!(
            "--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"{name}\"\r\nContent-Type: {}\r\n\r\n",
            image_type(&extension)
        )
        .into_bytes();
        body.extend_from_slice(&data);
        body.extend_from_slice(format!("\r\n--{boundary}--\r\n").as_bytes());
        let file = folder.path().join(format!("{index}.body"));
        write_private(&file, &body).map_err(|error| error.to_string())?;
        let uploaded = glab(
            context,
            &host_of(mr),
            "POST",
            &format!("projects/{}/uploads", encode_uri_component(&mr.project)),
            &[],
            Some(false),
            GlabCall {
                kind: Some("post"),
                input: Some((
                    file.to_string_lossy().into_owned(),
                    format!("multipart/form-data; boundary={boundary}"),
                )),
                ..GlabCall::default()
            },
        )
        .await?;
        let Some(url) = uploaded.get("url").and_then(Value::as_str) else {
            return Err("GitLab did not take an image of the comment".into());
        };
        urls.insert(path.clone(), url.to_owned());
    }
    drop(folder);
    Ok(MARKDOWN_IMAGE
        .replace_all(note, |found: &regex::Captures| {
            let source = found
                .get(2)
                .or_else(|| found.get(3))
                .map_or("", |m| m.as_str());
            match urls.get(source) {
                Some(url) => format!("![{}]({url})", &found[1]),
                None => found[0].to_owned(),
            }
        })
        .into_owned())
}

fn write_private(path: &std::path::Path, body: &[u8]) -> std::io::Result<()> {
    use std::io::Write;
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options.open(path)?.write_all(body)
}

/// A draft note on the merge request (a pending comment of the user's
/// GitHub review), placed with `diff` when given: ranges and unchanged
/// lines need it.
pub async fn create_draft_note(
    context: &ForgeContext,
    mr: &MergeRequestInfo,
    anchor: &ReviewAnchor,
    text: &str,
    diff: Option<&[ReviewDiffFile]>,
) -> Result<GitLabDraft, String> {
    let note = forge_note(context, mr, text).await?;
    if mr.is_github() {
        return github::create_pull_draft(context, mr, anchor, &note).await;
    }
    let mut fields = vec![raw("note", note)];
    fields.extend(position_fields(mr, anchor, diff));
    let answer = glab(
        context,
        &host_of(mr),
        "POST",
        &format!("{}/draft_notes", mr_path(&mr.project, mr.iid)),
        &fields,
        None,
        GlabCall::default(),
    )
    .await?;
    Ok(GitLabDraft::from_value(&answer))
}

/// A draft reply to a discussion: nobody else sees it until submitted.
pub async fn create_draft_reply(
    context: &ForgeContext,
    mr: &MergeRequestInfo,
    discussion_id: &str,
    text: &str,
) -> Result<GitLabDraft, String> {
    let note = forge_note(context, mr, text).await?;
    if mr.is_github() {
        return github::create_pull_draft_reply(context, mr, discussion_id, &note).await;
    }
    if discussion_id.is_empty()
        || !discussion_id
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        return Err("invalid discussion id".into());
    }
    let answer = glab(
        context,
        &host_of(mr),
        "POST",
        &format!("{}/draft_notes", mr_path(&mr.project, mr.iid)),
        &[
            raw("note", note),
            raw("in_reply_to_discussion_id", discussion_id),
        ],
        None,
        GlabCall::default(),
    )
    .await?;
    Ok(GitLabDraft::from_value(&answer))
}

pub async fn update_draft_note(
    context: &ForgeContext,
    mr: &MergeRequestInfo,
    id: i64,
    text: &str,
) -> Result<GitLabDraft, String> {
    let note = forge_note(context, mr, text).await?;
    if mr.is_github() {
        return github::update_pull_draft(context, mr, id, &note).await;
    }
    let answer = glab(
        context,
        &host_of(mr),
        "PUT",
        &format!("{}/draft_notes/{id}", mr_path(&mr.project, mr.iid)),
        &[raw("note", note)],
        None,
        GlabCall::default(),
    )
    .await?;
    Ok(GitLabDraft::from_value(&answer))
}

pub async fn delete_draft_note(
    context: &ForgeContext,
    mr: &MergeRequestInfo,
    id: i64,
) -> Result<(), String> {
    if mr.is_github() {
        return github::delete_pull_draft(context, mr, id).await;
    }
    glab(
        context,
        &host_of(mr),
        "DELETE",
        &format!("{}/draft_notes/{id}", mr_path(&mr.project, mr.iid)),
        &[],
        None,
        GlabCall::default(),
    )
    .await
    .map(|_| ())
}

/// A file at a commit, from the forge when the checkout does not have it.
pub async fn read_raw_file(
    context: &ForgeContext,
    mr: &MergeRequestInfo,
    path: &str,
    sha: &str,
) -> Result<String, String> {
    if mr.is_github() {
        return github::read_pull_raw_file(context, mr, path, sha).await;
    }
    let result = glab_get(
        context,
        &host_of(mr),
        &format!(
            "projects/{}/repository/files/{}?ref={sha}",
            encode_uri_component(&mr.project),
            encode_uri_component(path)
        ),
    )
    .await?;
    base64_file("GitLab", result.get("content"))
}

/// The MR's commits, oldest first.
pub async fn read_merge_request_commits(
    context: &ForgeContext,
    mr: &MergeRequestInfo,
) -> Result<Vec<ReviewCommit>, String> {
    if mr.is_github() {
        return github::read_pull_commits(context, mr).await;
    }
    let commits = glab_get(
        context,
        &host_of(mr),
        &format!("{}/commits?per_page=100", mr_path(&mr.project, mr.iid)),
    )
    .await?;
    let mut list: Vec<ReviewCommit> = items(&commits)
        .iter()
        .map(|commit| {
            let message = match commit.get("message").filter(|m| !m.is_null()) {
                Some(message) => js::to_text(message),
                None => js_string(commit.get("title"), ""),
            };
            let (subject, body) = commit_from_message(&message);
            let date = match commit.get("authored_date").filter(|d| !d.is_null()) {
                Some(date) => js::to_text(date),
                None => js_string(commit.get("created_at"), ""),
            };
            ReviewCommit {
                sha: js_string(commit.get("id"), ""),
                parent: commit
                    .get("parent_ids")
                    .and_then(|ids| ids.get(0))
                    .filter(|id| !id.is_null())
                    .map(js::to_text),
                author: js_string(commit.get("author_name"), ""),
                date,
                subject,
                body,
                history: false,
            }
        })
        .collect();
    list.reverse();
    Ok(list)
}

/// Whether a value looks like a commit id.
pub(crate) fn is_commit(sha: &str) -> bool {
    (7..=64).contains(&sha.len())
        && sha
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// One commit's diff from the forge, when the checkout does not have it.
pub async fn read_commit_diff(
    context: &ForgeContext,
    mr: &MergeRequestInfo,
    sha: &str,
    parent: Option<&str>,
) -> Result<ReviewDiff, String> {
    if mr.is_github() {
        return github::read_pull_commit_diff(context, mr, sha, parent).await;
    }
    if !is_commit(sha) {
        return Err("invalid commit".into());
    }
    let files = glab_get(
        context,
        &host_of(mr),
        &format!(
            "projects/{}/repository/commits/{sha}/diff?per_page=100",
            encode_uri_component(&mr.project)
        ),
    )
    .await?;
    let files: Vec<ApiFile> = items(&files).iter().map(api_file).collect();
    Ok(ReviewDiff {
        files: parse_unified_diff(&api_files_patch(&files)),
        base_sha: parent.map(str::to_owned),
        head_sha: Some(sha.to_owned()),
        truncated: false,
        extra: Map::new(),
    })
}

/// The upstream of a branch.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Upstream {
    pub remote: String,
    pub branch: String,
}

/// What finding the checkout's merge request needs, read in one command.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewCheckout {
    /// The local branch, none when HEAD is detached.
    pub branch: Option<String>,
    pub head: Option<String>,
    /// origin's default branch (origin/HEAD), such as main.
    pub default_branch: Option<String>,
    /// Each remote's default branch (`<remote>/HEAD`), when it is known.
    #[serde(default)]
    pub remote_heads: IndexMap<String, String>,
    /// branch.<b>.remote and branch.<b>.merge.
    pub upstream: Option<Upstream>,
    /// branch.<b>.pushRemote, else remote.pushDefault.
    pub push_remote: Option<String>,
    /// The URL of the remote a merge request would come from (see
    /// [`merge_request_source`]), with url.<base>.insteadOf applied.
    #[serde(default)]
    pub remotes: IndexMap<String, String>,
    /// The GitLab host glab uses on the checkout's host.
    pub gitlab_host: Option<String>,
    /// That remote's host (without a leading "ssh."), if glab is logged in
    /// to it.
    #[serde(default)]
    pub gitlab_logins: Vec<String>,
}

/// An open merge request of the checkout's branch.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BranchMergeRequest {
    pub url: String,
    pub title: String,
    pub number: i64,
    pub state: String,
    /// The checkout's local branch.
    pub branch: String,
}

/// The marker a review script prints when its checkout is gone
/// (workspace/review-patch.ts NO_CHECKOUT_MARKER).
pub const NO_CHECKOUT_MARKER: &str = "ROAMGATE-REVIEW-NO-CHECKOUT";

/// Entering the checkout, or saying it is gone (review-patch.ts
/// `enterCheckout`; it moves to roamgate-git with the review scripts, S17).
pub fn enter_checkout(root: &str) -> String {
    format!(
        "cd {} 2>/dev/null || {{ echo {NO_CHECKOUT_MARKER} >&2; exit 2; }}",
        roamgate_exec::quote::shell_quote(root)
    )
}

/// A failed review script's error (review-patch.ts `reviewScriptError`,
/// without targets): the checkout gone, or its last words.
pub fn review_script_error(stderr: &str, fallback: &str, root: &str, max: usize) -> LoadError {
    if stderr.contains(NO_CHECKOUT_MARKER) {
        return LoadError::Gone {
            code: "checkout-gone".into(),
            message: format!("This checkout no longer exists: {root}"),
        };
    }
    let text = if stderr.is_empty() { fallback } else { stderr };
    LoadError::Failed(js::head16(js::trim(text), max))
}

pub fn read_checkout_script(root: &str) -> String {
    [
        enter_checkout(root),
        "b=$(git symbolic-ref -q --short HEAD)".to_owned(),
        r#"printf 'branch %s\n' "$b""#.to_owned(),
        r#"printf 'head %s\n' "$(git rev-parse -q --verify HEAD)""#.to_owned(),
        r#"printf 'default %s\n' "$(git symbolic-ref -q --short refs/remotes/origin/HEAD)""#
            .to_owned(),
        "pd=$(git config --get remote.pushDefault)".to_owned(),
        r#"printf 'pushdefault %s\n' "$pd""#.to_owned(),
        "git for-each-ref --format='rhead %(refname) %(symref)' 'refs/remotes/*/HEAD'".to_owned(),
        "g=$(GLAB_NO_PROMPT=1 glab config get host 2>/dev/null)".to_owned(),
        r#"printf 'glab %s\n' "$g""#.to_owned(),
        r#"[ -n "$b" ] || exit 0"#.to_owned(),
        r#"r=$(git config --get "branch.$b.remote")"#.to_owned(),
        r#"m=$(git config --get "branch.$b.merge")"#.to_owned(),
        r#"pr=$(git config --get "branch.$b.pushRemote")"#.to_owned(),
        r#"printf 'remote %s\nmerge %s\npushremote %s\n' "$r" "$m" "$pr""#.to_owned(),
        // The source remote, as merge_request_source picks it: only its URL
        // and host are read, which keeps a checkout with many remotes quick.
        r#"case "$m" in refs/heads/*) ;; *) r= ;; esac"#.to_owned(),
        r#"[ "$r" = . ] && r="#.to_owned(),
        "r=${r:-${pr:-${pd:-origin}}}".to_owned(),
        // get-url applies url.<base>.insteadOf.
        r#"u=$(git remote get-url "$r" 2>/dev/null) || exit 0"#.to_owned(),
        r#"printf 'url %s %s\n' "$r" "$u""#.to_owned(),
        r#"h=$(printf '%s\n' "$u" | sed -n -E -e 's#^[A-Za-z+]+://([^@/]*@)?([^/:]+).*#\2#p' -e t -e 's#^([^@/:]*@)?([^/:]+):.*#\2#p' | tr 'A-Z' 'a-z')"#.to_owned(),
        "h=${h#ssh.}".to_owned(),
        r#"g=$(printf '%s\n' "$g" | sed -e 's#^[A-Za-z]*://##' -e 's#/.*##' | tr 'A-Z' 'a-z')"#
            .to_owned(),
        r#"{ [ -z "$h" ] || [ "$h" = "$g" ]; } && exit 0"#.to_owned(),
        // Another host is a login when glab's config has a token of its own
        // for it: GITLAB_TOKEN and the like answer for any host, as does a
        // token for no host in particular, which a made-up host gets. Only
        // whether there is one is printed, never the token.
        r#"token() { (unset GITLAB_TOKEN GITLAB_ACCESS_TOKEN OAUTH_TOKEN; GLAB_NO_PROMPT=1 glab config get token --host "$1" 2>/dev/null); }"#.to_owned(),
        r#"t=$(token "$h")"#.to_owned(),
        r#"[ -n "$t" ] && [ "$t" != "$(token roamgate.invalid)" ] && printf 'login %s\n' "$h""#
            .to_owned(),
        "exit 0".to_owned(),
    ]
    .join("\n")
}

/// The checkout script's answer.
pub fn parse_checkout(stdout: &str) -> ReviewCheckout {
    static URL: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^(\S+)\s+(.+)$").unwrap());
    static RHEAD: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"^refs/remotes/(.+)/HEAD\s+refs/remotes/(.+)$").unwrap());
    let mut lines: HashMap<String, String> = HashMap::new();
    let mut checkout = ReviewCheckout::default();
    for line in stdout.split('\n') {
        let Some(space) = line.find(' ') else {
            continue;
        };
        let kind = &line[..space];
        let value = js::trim(&line[space + 1..]);
        match kind {
            "url" => {
                if let Some(found) = URL.captures(value) {
                    checkout
                        .remotes
                        .insert(found[1].to_owned(), found[2].to_owned());
                }
            }
            "rhead" => {
                if let Some(found) = RHEAD.captures(value) {
                    let (remote, target) = (&found[1], &found[2]);
                    if let Some(head) = target.strip_prefix(&format!("{remote}/")) {
                        checkout
                            .remote_heads
                            .insert(remote.to_owned(), head.to_owned());
                    }
                }
            }
            "login" => {
                if !value.is_empty() {
                    checkout.gitlab_logins.push(value.to_lowercase());
                }
            }
            _ => {
                lines.insert(kind.to_owned(), value.to_owned());
            }
        }
    }
    let get = |kind: &str| lines.get(kind).filter(|v| !v.is_empty()).cloned();
    let remote = get("remote");
    let merge = get("merge");
    checkout.branch = get("branch");
    checkout.head = get("head");
    checkout.default_branch = get("default").map(|name| {
        name.strip_prefix("origin/")
            .map(str::to_owned)
            .unwrap_or(name)
    });
    // "." tracks a local branch, which no merge request comes from.
    checkout.upstream = match (remote, merge) {
        (Some(remote), Some(merge)) if remote != "." => {
            merge.strip_prefix("refs/heads/").map(|branch| Upstream {
                remote,
                branch: branch.to_owned(),
            })
        }
        _ => None,
    };
    checkout.push_remote = get("pushremote").or_else(|| get("pushdefault"));
    checkout.gitlab_host = get("glab")
        .map(|host| host_name(&host))
        .filter(|host| !host.is_empty());
    checkout
}

/// Where a merge request of the checkout's branch comes from.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MergeRequestSource {
    pub remote: String,
    pub branch: String,
    /// Known by its name only (no upstream that says where it goes).
    pub by_name: bool,
}

/// The remote and branch a merge request of the checkout's branch comes
/// from: its upstream when it has one, else the branch's own name on its
/// push remote (or origin). None for a detached HEAD, or when the branch
/// or its source is a default branch: a branch made from origin/main
/// tracks main, whose name an unrelated merge request may come from.
pub fn merge_request_source(checkout: &ReviewCheckout) -> Option<MergeRequestSource> {
    let is_default = |name: &str, remote: Option<&str>| {
        name == "main"
            || name == "master"
            || checkout.default_branch.as_deref() == Some(name)
            || remote.is_some_and(|remote| {
                checkout.remote_heads.get(remote).map(String::as_str) == Some(name)
            })
    };
    let branch = checkout.branch.as_deref()?;
    if is_default(branch, None) {
        return None;
    }
    if let Some(upstream) = &checkout.upstream
        && !is_default(&upstream.branch, Some(&upstream.remote))
    {
        return Some(MergeRequestSource {
            remote: upstream.remote.clone(),
            branch: upstream.branch.clone(),
            by_name: false,
        });
    }
    // No upstream, or one that only says where it started (git checkout -b
    // fix origin/main): the merge request is the branch's name, pushed to
    // its push remote or a fork of it.
    Some(MergeRequestSource {
        remote: checkout
            .push_remote
            .clone()
            .unwrap_or_else(|| "origin".into()),
        branch: branch.to_owned(),
        by_name: true,
    })
}

// The remote URL parsing is crate::remote's, shared with the MR reviews.
pub use crate::remote::{RemoteProject, on_gitlab_host, remote_project};

/// The GitLab host to ask about a remote's host: glab's default host, or
/// another one glab is logged in to; none when glab knows none.
pub fn gitlab_host_for(
    remote_host: &str,
    gitlab_host: Option<&str>,
    gitlab_logins: &[String],
) -> Option<String> {
    if let Some(gitlab) = gitlab_host
        && on_gitlab_host(remote_host, gitlab)
    {
        return Some(gitlab.to_owned());
    }
    let host = remote_host.strip_prefix("ssh.").unwrap_or(remote_host);
    gitlab_logins
        .iter()
        .any(|login| login == host)
        .then(|| host.to_owned())
}

/// The merge request list is read a page at a time, up to this many.
const MR_PAGE_SIZE: usize = 100;
const MR_MAX_PAGES: usize = 5;

/// A merge request a list names (BranchMergeRequest without its branch).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PickedRequest {
    pub url: String,
    pub title: String,
    pub number: i64,
    pub state: String,
}

/// The first open merge request from that source project in the list;
/// `or_target`: also one into that project, from another (a fork's).
pub fn pick_merge_request(
    list: &Value,
    source_project_id: i64,
    or_target: bool,
) -> Option<PickedRequest> {
    let is =
        |value: Option<&Value>| value.and_then(Value::as_f64) == Some(source_project_id as f64);
    list.as_array()?.iter().find_map(|item| {
        let iid = item.get("iid").and_then(Value::as_f64)?;
        let url = item.get("web_url").and_then(Value::as_str)?;
        (item.get("state").and_then(Value::as_str) == Some("opened")
            && (is(item.get("source_project_id")) || (or_target && is(item.get("project_id")))))
        .then(|| PickedRequest {
            url: url.to_owned(),
            title: js_string(item.get("title"), ""),
            number: iid as i64,
            state: "opened".into(),
        })
    })
}

/// The checkout's branch, its source remote and glab's host; it only reads.
pub async fn read_checkout(context: &ForgeContext) -> Result<ReviewCheckout, LoadError> {
    let script = read_checkout_script(&context.root);
    let result = run_forge_script(context, script, "review.checkout", false)
        .await
        .map_err(|error| LoadError::Failed(error.to_string()))?;
    if result.code != 0 {
        return Err(review_script_error(
            &result.stderr,
            "cannot read the checkout",
            &context.root,
            300,
        ));
    }
    Ok(parse_checkout(&result.stdout))
}

/// The open merge request whose source is the checkout's branch, matched by
/// its name only, none when there is none; it only reads. It lists the
/// open merge requests from branches of that name across the host (they
/// live in their target project) a page at a time, stopping at the first
/// from the source project, whose id, asked once, is remembered in
/// `project_ids`.
pub async fn find_branch_merge_request(
    context: &ForgeContext,
    checkout: &ReviewCheckout,
    project_ids: &Mutex<HashMap<String, i64>>,
) -> Result<Option<BranchMergeRequest>, String> {
    let Some(source) = merge_request_source(checkout) else {
        return Ok(None);
    };
    let Some(remote) = checkout
        .remotes
        .get(&source.remote)
        .and_then(|url| remote_project(url))
    else {
        return Ok(None);
    };
    let Some(host) = gitlab_host_for(
        &remote.host,
        checkout.gitlab_host.as_deref(),
        &checkout.gitlab_logins,
    ) else {
        return Ok(None);
    };
    // Not glab's default host: a token from the environment is for that one.
    let glab_host = GlabHost {
        own_login: Some(Some(&host) != checkout.gitlab_host.as_ref()),
        host: host.clone(),
    };
    let key = format!("{host}\n{}", remote.project);
    let known = project_ids.lock().unwrap().get(&key).copied();
    let id = match known {
        Some(id) => id,
        None => {
            let project = glab(
                context,
                &glab_host,
                "GET",
                &format!("projects/{}", encode_uri_component(&remote.project)),
                &[],
                Some(false),
                GlabCall {
                    feature: Some("branch-request"),
                    kind: Some("project"),
                    reuse_ms: Some(30 * 60_000),
                    input: None,
                },
            )
            .await?;
            let Some(id) = project.get("id").and_then(Value::as_f64) else {
                return Err(format!("GitLab: no project {}", remote.project));
            };
            let id = id as i64;
            project_ids.lock().unwrap().insert(key, id);
            id
        }
    };
    let branch = checkout.branch.clone().unwrap_or_default();
    let find = |scope: &'static str, or_target: bool| {
        let glab_host = glab_host.clone();
        let branch = branch.clone();
        let source_branch = source.branch.clone();
        async move {
            for page in 1..=MR_MAX_PAGES {
                let list = glab(
                    context,
                    &glab_host,
                    "GET",
                    &format!(
                        "merge_requests?scope={scope}&state=opened&source_branch={}&per_page={MR_PAGE_SIZE}&page={page}",
                        encode_uri_component(&source_branch)
                    ),
                    &[],
                    Some(false),
                    GlabCall {
                        feature: Some("branch-request"),
                        kind: Some("mr-search"),
                        ..GlabCall::default()
                    },
                )
                .await?;
                if let Some(found) = pick_merge_request(&list, id, or_target) {
                    return Ok::<_, String>(Some(BranchMergeRequest {
                        url: found.url,
                        title: found.title,
                        number: found.number,
                        state: found.state,
                        branch: branch.clone(),
                    }));
                }
                if list
                    .as_array()
                    .is_none_or(|items| items.len() < MR_PAGE_SIZE)
                {
                    break;
                }
            }
            Ok(None)
        }
    };
    // Known only by its name: the user's own, pushed to that project or to
    // a fork of it with the same branch name.
    if let Some(found) = find("all", false).await? {
        return Ok(Some(found));
    }
    if source.by_name {
        return find("created_by_me", true).await;
    }
    Ok(None)
}

/// A merge request reference from its info.
pub fn reference_of(mr: &MergeRequestInfo) -> MergeRequestRef {
    MergeRequestRef {
        host: mr.host.clone(),
        project: mr.project.clone(),
        iid: mr.iid,
    }
}

#[cfg(test)]
mod tests;
