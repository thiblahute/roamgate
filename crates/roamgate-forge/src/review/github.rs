//! GitHub pull requests for the review pane (review/github.ts), shaped
//! like [`super::gitlab`]'s merge requests so the review service has one
//! code path: `gh api` with the user's own gh login on the checkout's host,
//! through the forge gate.
//!
//! The user's pending GitHub review holds their drafts: nobody else sees
//! its comments until the user submits the review on GitHub. Roamgate only
//! adds, edits and deletes them (on the user's own action in the review
//! pane) and never submits the review. The pending review's body is the
//! overall comment, draft id 0.

use std::collections::HashMap;
use std::sync::{Arc, LazyLock};

use regex::Regex;
use roamgate_agents::js;
use roamgate_review::diff::{ReviewDiff, parse_unified_diff};
use roamgate_review::model::{
    ReviewAnchor, ReviewComment, ReviewCommit, ReviewThread, ReviewThreadGitlab,
};
use roamgate_review::parse::{MergeRequestRef, is_github_pull_url, parse_merge_request_url};
use serde_json::{Map, Value, json};

use super::cli::{
    ApiFile, ForgeContext, api_files_patch, base64_file, cli_error, commit_from_message, spawn_gh,
};
use super::gitlab::{Field, FieldKind, GitLabDraft, MergeRequestInfo, field_args, is_commit};
use crate::gate::{ForgeCall, Spawn};
use crate::pages::parse_json_pages;

/// The pull request a URL names.
pub fn parse_github_pull_url(url: &str) -> Option<MergeRequestRef> {
    if !is_github_pull_url(url) {
        return None;
    }
    parse_merge_request_url(url)
}

/// What a `gh api` call sends.
#[derive(Debug, Clone, Default)]
pub struct GhOptions {
    pub paginate: bool,
    pub fields: Vec<Field>,
    pub kind: Option<&'static str>,
}

/// `gh api` on the checkout's host, as JSON; lists paginated.
pub async fn gh_api(
    context: &ForgeContext,
    host: &str,
    method: &str,
    path: &str,
    options: GhOptions,
) -> Result<Value, String> {
    // A GraphQL query reads; a mutation writes, as REST's other methods do.
    static MUTATION: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^\s*mutation\b").unwrap());
    let query = options
        .fields
        .iter()
        .find(|(key, _, _)| key == "query")
        .map_or("", |(_, value, _)| value.as_str());
    let read = method == "GET" || (path == "graphql" && !MUTATION.is_match(query));
    let mut argv = vec!["gh".to_owned(), "api".to_owned()];
    if host != "github.com" {
        argv.extend(["--hostname".to_owned(), host.to_owned()]);
    }
    argv.extend(["--method".to_owned(), method.to_owned()]);
    if options.paginate {
        argv.push("--paginate".into());
    }
    argv.push(path.to_owned());
    argv.extend(field_args(&options.fields));
    let call = ForgeCall {
        checkout: context.host.clone(),
        host: host.to_owned(),
        feature: "review".into(),
        kind: options.kind.map(str::to_owned).unwrap_or_else(|| {
            if read {
                "read".into()
            } else {
                method.to_lowercase()
            }
        }),
        conditional: method == "GET" && !options.paginate,
        ..ForgeCall::default()
    };
    let spawn_context = context.clone();
    let spawn: Spawn = Arc::new(move |full: Vec<String>| {
        let context = spawn_context.clone();
        Box::pin(async move { spawn_gh(&context, full, read).await })
    });
    let result = context
        .tools
        .gate
        .run(&context.tools.owner, call, argv, spawn)
        .await
        .map_err(|error| error.to_string())?;
    if result.code == 127 {
        return Err("gh is not installed on this host".into());
    }
    let body = js::trim(&result.stdout);
    if result.code != 0 {
        // GraphQL errors come with a body.
        if path == "graphql" && body.starts_with('{') {
            return serde_json::from_str(body).map_err(|error| error.to_string());
        }
        let text = if result.stderr.is_empty() {
            body
        } else {
            &result.stderr
        };
        return Err(cli_error("GitHub", text));
    }
    if body.is_empty() {
        return Ok(Value::Null);
    }
    if !options.paginate {
        return serde_json::from_str(body).map_err(|error| error.to_string());
    }
    // --paginate prints one JSON array per page back to back.
    let mut pages = parse_json_pages(body)?;
    if pages.len() == 1 {
        return Ok(pages.remove(0));
    }
    Ok(Value::Array(
        pages
            .into_iter()
            .flat_map(|page| match page {
                Value::Array(items) => items,
                other => vec![other],
            })
            .collect(),
    ))
}

fn pull_path(project: &str, iid: i64) -> String {
    format!("repos/{project}/pulls/{iid}")
}

fn get(path: &str, paginate: bool) -> (String, GhOptions) {
    (
        path.to_owned(),
        GhOptions {
            paginate,
            ..GhOptions::default()
        },
    )
}

async fn read(
    context: &ForgeContext,
    host: &str,
    path: &str,
    paginate: bool,
) -> Result<Value, String> {
    let (path, options) = get(path, paginate);
    gh_api(context, host, "GET", &path, options).await
}

/// `String(value ?? "")`.
fn text(value: Option<&Value>) -> String {
    match value {
        None | Some(Value::Null) => String::new(),
        Some(value) => js::to_text(value),
    }
}

fn at<'a>(value: &'a Value, path: &[&str]) -> Option<&'a Value> {
    path.iter().try_fold(value, |value, key| value.get(key))
}

fn list(value: Option<&Value>) -> &[Value] {
    value
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or(&[])
}

/// A pull request, as [`super::gitlab::read_merge_request`] reads a merge
/// request.
pub async fn read_pull_request(
    context: &ForgeContext,
    url: &str,
) -> Result<MergeRequestInfo, String> {
    let reference =
        parse_github_pull_url(url).ok_or_else(|| "not a GitHub pull request URL".to_owned())?;
    let pr = read(
        context,
        &reference.host,
        &pull_path(&reference.project, reference.iid),
        false,
    )
    .await?;
    let head_sha = text(at(&pr, &["head", "sha"]));
    let base_sha = text(at(&pr, &["base", "sha"]));
    if head_sha.is_empty() || base_sha.is_empty() {
        return Err("GitHub has no diff for this pull request".into());
    }
    let state = if super::cli::truthy(pr.get("merged_at")) {
        "merged"
    } else if pr.get("state").and_then(Value::as_str) == Some("closed") {
        "closed"
    } else {
        "opened"
    };
    let html_url = pr
        .get("html_url")
        .and_then(Value::as_str)
        .unwrap_or(url)
        .to_owned();
    let project_path = parse_github_pull_url(&html_url)
        .map(|found| found.project)
        .unwrap_or_else(|| reference.project.clone());
    Ok(MergeRequestInfo {
        host: reference.host,
        project: reference.project,
        iid: reference.iid,
        forge: Some("github".into()),
        project_path: Some(project_path),
        url: html_url,
        title: text(pr.get("title")),
        state: state.into(),
        base_sha: base_sha.clone(),
        start_sha: base_sha,
        head_sha,
        updated_at: pr
            .get("updated_at")
            .and_then(Value::as_str)
            .map(str::to_owned),
    })
}

fn files_diff(files: &[Value]) -> String {
    let files: Vec<ApiFile> = files
        .iter()
        .map(|file| {
            let new_path = text(file.get("filename"));
            let status = file.get("status").and_then(Value::as_str);
            ApiFile {
                old_path: match file.get("previous_filename") {
                    None | Some(Value::Null) => new_path.clone(),
                    Some(value) => js::to_text(value),
                },
                new_path,
                added: status == Some("added"),
                deleted: status == Some("removed"),
                patch: file.get("patch").and_then(Value::as_str).map(str::to_owned),
            }
        })
        .collect();
    api_files_patch(&files)
}

pub async fn read_pull_diff(
    context: &ForgeContext,
    mr: &MergeRequestInfo,
) -> Result<ReviewDiff, String> {
    let files = read(
        context,
        &mr.host,
        &format!("{}/files?per_page=100", pull_path(&mr.project, mr.iid)),
        true,
    )
    .await?;
    Ok(ReviewDiff {
        files: parse_unified_diff(&files_diff(list(Some(&files)))),
        base_sha: Some(mr.base_sha.clone()),
        head_sha: Some(mr.head_sha.clone()),
        truncated: false,
        extra: Map::new(),
    })
}

pub async fn read_pull_commits(
    context: &ForgeContext,
    mr: &MergeRequestInfo,
) -> Result<Vec<ReviewCommit>, String> {
    let commits = read(
        context,
        &mr.host,
        &format!("{}/commits?per_page=100", pull_path(&mr.project, mr.iid)),
        true,
    )
    .await?;
    Ok(list(Some(&commits))
        .iter()
        .map(|entry| {
            let (subject, body) = commit_from_message(&text(at(entry, &["commit", "message"])));
            ReviewCommit {
                sha: text(entry.get("sha")),
                parent: at(entry, &["parents"])
                    .and_then(|parents| parents.get(0))
                    .and_then(|parent| parent.get("sha"))
                    .filter(|sha| !sha.is_null())
                    .map(js::to_text),
                author: text(at(entry, &["commit", "author", "name"])),
                date: text(at(entry, &["commit", "author", "date"])),
                subject,
                body,
                history: false,
            }
        })
        .collect())
}

pub async fn read_pull_commit_diff(
    context: &ForgeContext,
    mr: &MergeRequestInfo,
    sha: &str,
    parent: Option<&str>,
) -> Result<ReviewDiff, String> {
    if !is_commit(sha) {
        return Err("invalid commit".into());
    }
    let commit = read(
        context,
        &mr.host,
        &format!("repos/{}/commits/{sha}", mr.project),
        false,
    )
    .await?;
    Ok(ReviewDiff {
        files: parse_unified_diff(&files_diff(list(commit.get("files")))),
        base_sha: parent.map(str::to_owned),
        head_sha: Some(sha.to_owned()),
        truncated: false,
        extra: Map::new(),
    })
}

pub async fn read_pull_raw_file(
    context: &ForgeContext,
    mr: &MergeRequestInfo,
    path: &str,
    sha: &str,
) -> Result<String, String> {
    let encoded = path
        .split('/')
        .map(roamgate_agents::paths::encode_uri_component)
        .collect::<Vec<_>>()
        .join("/");
    let result = read(
        context,
        &mr.host,
        &format!("repos/{}/contents/{encoded}?ref={sha}", mr.project),
        false,
    )
    .await?;
    base64_file("GitHub", result.get("content"))
}

fn author_of(comment: &Value) -> String {
    let login = at(comment, &["user", "login"])
        .filter(|login| !login.is_null())
        .map(js::to_text)
        .unwrap_or_else(|| "someone".into());
    format!("@{login}")
}

/// The pull request's review comments, grouped in their threads (read
/// only), and its conversation comments as general threads; the user's
/// pending review comes with them as drafts ([`read_pull_drafts`]),
/// whichever app wrote them.
pub async fn read_pull_threads(
    context: &ForgeContext,
    mr: &MergeRequestInfo,
    session_id: &str,
) -> Result<Vec<ReviewThread>, String> {
    let comments = read(
        context,
        &mr.host,
        &format!("{}/comments?per_page=100", pull_path(&mr.project, mr.iid)),
        true,
    )
    .await?;
    let mut order: Vec<i64> = Vec::new();
    let mut threads: HashMap<i64, ReviewThread> = HashMap::new();
    for comment in list(Some(&comments)) {
        let id = js::to_number(comment.get("id")) as i64;
        let root = match comment.get("in_reply_to_id") {
            None | Some(Value::Null) => id,
            Some(value) => js::to_number(Some(value)) as i64,
        };
        let created = text(comment.get("created_at"));
        let entry = ReviewComment {
            id: format!("gh:{root}:{id}"),
            author: author_of(comment),
            body: text(comment.get("body")),
            created_at: created.clone(),
            updated_at: match comment.get("updated_at") {
                None | Some(Value::Null) => created.clone(),
                Some(value) => js::to_text(value),
            },
            gitlab_draft_id: None,
            extra: Map::new(),
        };
        if let Some(known) = threads.get_mut(&root) {
            known.comments.push(entry);
            continue;
        }
        let line_value = match comment.get("line") {
            None | Some(Value::Null) => comment.get("original_line"),
            line => line,
        };
        let line = Some(js::to_number(line_value))
            .filter(|n| *n != 0.0 && !n.is_nan())
            .map(|n| n as i64);
        let side = if comment.get("side").and_then(Value::as_str) == Some("LEFT") {
            "old"
        } else {
            "new"
        };
        order.push(root);
        threads.insert(
            root,
            ReviewThread {
                id: format!("gh:{root}"),
                session_id: session_id.to_owned(),
                kind: "merge-request".into(),
                anchor: ReviewAnchor {
                    path: Some(text(comment.get("path"))),
                    line,
                    side: line.map(|_| side.to_owned()),
                    ..ReviewAnchor::default()
                },
                comments: vec![entry],
                resolved: false,
                created_at: created.clone(),
                updated_at: created,
                held: None,
                gitlab: Some(ReviewThreadGitlab {
                    discussion_id: Some(root.to_string()),
                    head_sha: comment
                        .get("commit_id")
                        .filter(|sha| super::cli::truthy(Some(sha)))
                        .map(js::to_text),
                    ..ReviewThreadGitlab::default()
                }),
                gitlab_reply_to: None,
                pending_for: None,
                handed_at: None,
                extra: Map::new(),
                inst: 0,
            },
        );
    }
    // The pull request's conversation (issue) comments: general threads,
    // one per comment. GitHub has no draft reply to them: no discussion id.
    let conversation = read(
        context,
        &mr.host,
        &format!(
            "repos/{}/issues/{}/comments?per_page=100",
            mr.project, mr.iid
        ),
        true,
    )
    .await?;
    let mut all: Vec<ReviewThread> = list(Some(&conversation))
        .iter()
        .map(|comment| {
            let created = text(comment.get("created_at"));
            let id = js::to_text(comment.get("id").unwrap_or(&Value::Null));
            let id = if comment.get("id").is_none() {
                "undefined".to_owned()
            } else {
                id
            };
            ReviewThread {
                id: format!("ghc:{id}"),
                session_id: session_id.to_owned(),
                kind: "merge-request".into(),
                anchor: ReviewAnchor::default(),
                comments: vec![ReviewComment {
                    id: format!("ghc:{id}"),
                    author: author_of(comment),
                    body: text(comment.get("body")),
                    created_at: created.clone(),
                    updated_at: match comment.get("updated_at") {
                        None | Some(Value::Null) => created.clone(),
                        Some(value) => js::to_text(value),
                    },
                    gitlab_draft_id: None,
                    extra: Map::new(),
                }],
                resolved: false,
                created_at: created.clone(),
                updated_at: created,
                held: None,
                gitlab: Some(ReviewThreadGitlab::default()),
                gitlab_reply_to: None,
                pending_for: None,
                handed_at: None,
                extra: Map::new(),
                inst: 0,
            }
        })
        .collect();
    all.extend(order.into_iter().filter_map(|root| threads.remove(&root)));
    Ok(all)
}

const PENDING_QUERY: &str = "query($o: String!, $r: String!, $n: Int!) { repository(owner: $o, name: $r) { pullRequest(number: $n) { id reviews(states: PENDING, first: 1) { nodes { id body } } reviewThreads(first: 100) { nodes { id diffSide comments(first: 100) { nodes { id fullDatabaseId body path line originalLine startLine replyTo { fullDatabaseId } pullRequestReview { id } } } } } } } }";

/// A comment's fields; its side is its thread's.
const COMMENT_FIELDS: &str = "id fullDatabaseId body path line originalLine startLine replyTo { fullDatabaseId } pullRequestReview { id }";

/// A comment as GitHub answers it, with its thread's side.
fn with_side(comment: &Value, diff_side: Option<&Value>) -> Value {
    let mut comment = comment.clone();
    let side = if diff_side.and_then(Value::as_str) == Some("LEFT") {
        "LEFT"
    } else {
        "RIGHT"
    };
    if let Some(object) = comment.as_object_mut() {
        object.insert("diffSide".into(), json!(side));
    }
    comment
}

struct PendingReview {
    id: String,
    body: String,
    comments: Vec<Value>,
}

struct Pending {
    pull_id: String,
    /// Each thread's node id, by its first comment's id (our discussion id).
    threads: HashMap<String, String>,
    review: Option<PendingReview>,
}

/// A GraphQL variable: a number is typed, the rest raw.
enum Var<'a> {
    Text(&'a str),
    Number(i64),
}

async fn graphql(
    context: &ForgeContext,
    host: &str,
    query: &str,
    variables: &[(&str, Var<'_>)],
    kind: &'static str,
) -> Result<Value, String> {
    let mut fields: Vec<Field> = vec![("query".into(), query.into(), FieldKind::Raw)];
    for (key, value) in variables {
        fields.push(match value {
            Var::Text(text) => ((*key).to_owned(), (*text).to_owned(), FieldKind::Raw),
            Var::Number(number) => ((*key).to_owned(), number.to_string(), FieldKind::Typed),
        });
    }
    let answer = gh_api(
        context,
        host,
        "POST",
        "graphql",
        GhOptions {
            paginate: false,
            fields,
            kind: Some(kind),
        },
    )
    .await?;
    if let Some(error) = at(&answer, &["errors"])
        .and_then(|errors| errors.get(0))
        .and_then(|error| error.get("message"))
        .filter(|message| super::cli::truthy(Some(message)))
    {
        return Err(format!("GitHub: {}", js::head16(&js::to_text(error), 300)));
    }
    Ok(answer.get("data").cloned().unwrap_or(Value::Null))
}

async fn read_pending(context: &ForgeContext, mr: &MergeRequestInfo) -> Result<Pending, String> {
    let mut parts = mr.project.split('/');
    let owner = parts.next().unwrap_or("");
    let name = parts.next().unwrap_or("");
    let data = graphql(
        context,
        &mr.host,
        PENDING_QUERY,
        &[
            ("o", Var::Text(owner)),
            ("r", Var::Text(name)),
            ("n", Var::Number(mr.iid)),
        ],
        "drafts",
    )
    .await?;
    let pull = at(&data, &["repository", "pullRequest"])
        .cloned()
        .unwrap_or(Value::Null);
    if !super::cli::truthy(pull.get("id")) {
        return Err("GitHub: no such pull request".into());
    }
    let review = at(&pull, &["reviews", "nodes"])
        .and_then(|nodes| nodes.get(0))
        .filter(|r| !r.is_null());
    let thread_nodes = list(at(&pull, &["reviewThreads", "nodes"]));
    // The pending review's comments, each with its thread's side (only the
    // viewer's pending review is ever listed).
    let comments: Vec<Value> = match review {
        Some(review) => thread_nodes
            .iter()
            .flat_map(|thread| {
                list(at(thread, &["comments", "nodes"]))
                    .iter()
                    .filter(|comment| at(comment, &["pullRequestReview", "id"]) == review.get("id"))
                    .map(|comment| with_side(comment, thread.get("diffSide")))
                    .collect::<Vec<_>>()
            })
            .collect(),
        None => Vec::new(),
    };
    let mut threads = HashMap::new();
    for thread in thread_nodes {
        let root = list(at(thread, &["comments", "nodes"]))
            .first()
            .and_then(|first| first.get("fullDatabaseId"))
            .filter(|root| super::cli::truthy(Some(root)));
        if let (Some(id), Some(root)) = (
            thread.get("id").filter(|id| super::cli::truthy(Some(id))),
            root,
        ) {
            threads.insert(js::to_text(root), js::to_text(id));
        }
    }
    Ok(Pending {
        pull_id: js::to_text(pull.get("id").unwrap_or(&Value::Null)),
        threads,
        review: review.map(|review| PendingReview {
            id: text(review.get("id")),
            body: text(review.get("body")),
            comments,
        }),
    })
}

/// A pending comment as GitLab would answer a draft note.
fn as_draft(comment: &Value) -> GitLabDraft {
    let line = match comment.get("line") {
        None | Some(Value::Null) => comment.get("originalLine").cloned().unwrap_or(Value::Null),
        Some(line) => line.clone(),
    };
    let old = comment.get("diffSide").and_then(Value::as_str) == Some("LEFT");
    let path = comment
        .get("path")
        .filter(|path| super::cli::truthy(Some(path)));
    GitLabDraft {
        id: js::to_number(comment.get("fullDatabaseId")) as i64,
        note: text(comment.get("body")),
        discussion_id: at(comment, &["replyTo"])
            .filter(|reply| super::cli::truthy(Some(reply)))
            .map(|reply| text(reply.get("fullDatabaseId"))),
        position: match path {
            Some(path) => json!({
                "old_path": path,
                "new_path": path,
                "old_line": if old { line.clone() } else { Value::Null },
                "new_line": if old { Value::Null } else { line },
            }),
            None => Value::Null,
        },
    }
}

fn overall(note: &str) -> GitLabDraft {
    GitLabDraft {
        id: 0,
        note: note.to_owned(),
        discussion_id: None,
        position: Value::Null,
    }
}

/// The user's pending drafts on the pull request, the overall one first.
pub async fn read_pull_drafts(
    context: &ForgeContext,
    mr: &MergeRequestInfo,
) -> Result<Vec<GitLabDraft>, String> {
    let Some(review) = read_pending(context, mr).await?.review else {
        return Ok(Vec::new());
    };
    let mut drafts = Vec::new();
    if !js::trim(&review.body).is_empty() {
        drafts.push(overall(&review.body));
    }
    drafts.extend(review.comments.iter().map(as_draft));
    Ok(drafts)
}

/// The pending review, made (without an event, so it stays pending).
async fn pending_review(
    context: &ForgeContext,
    mr: &MergeRequestInfo,
) -> Result<PendingReview, String> {
    let pending = read_pending(context, mr).await?;
    if let Some(review) = pending.review {
        return Ok(review);
    }
    let data = graphql(
        context,
        &mr.host,
        "mutation($p: ID!, $c: GitObjectID) { addPullRequestReview(input: {pullRequestId: $p, commitOID: $c}) { pullRequestReview { id state } } }",
        &[("p", Var::Text(&pending.pull_id)), ("c", Var::Text(&mr.head_sha))],
        "draft-review",
    )
    .await?;
    let review = at(&data, &["addPullRequestReview", "pullRequestReview"]);
    match review {
        Some(review)
            if super::cli::truthy(review.get("id"))
                && review.get("state").and_then(Value::as_str) == Some("PENDING") =>
        {
            Ok(PendingReview {
                id: text(review.get("id")),
                body: String::new(),
                comments: Vec::new(),
            })
        }
        _ => Err("GitHub did not start a pending review".into()),
    }
}

pub async fn create_pull_draft(
    context: &ForgeContext,
    mr: &MergeRequestInfo,
    anchor: &ReviewAnchor,
    note: &str,
) -> Result<GitLabDraft, String> {
    let review = pending_review(context, mr).await?;
    let Some(path) = anchor.path.as_deref().filter(|path| !path.is_empty()) else {
        set_review_body(context, mr, &review.id, note).await?;
        return Ok(overall(note));
    };
    if anchor
        .commit
        .as_deref()
        .is_some_and(|commit| !commit.is_empty())
    {
        return Err(
            "GitHub takes review comments on the whole change: comment there, not on one commit"
                .into(),
        );
    }
    let line = anchor.end_line.or(anchor.line);
    let side = if anchor.side.as_deref() == Some("old") {
        "LEFT"
    } else {
        "RIGHT"
    };
    let fields = match line {
        None => "subjectType: FILE".to_owned(),
        Some(line) => {
            let start = match (anchor.end_line, anchor.line) {
                (Some(end), Some(start)) if start < end => {
                    format!(", startLine: {start}, startSide: {side}")
                }
                _ => String::new(),
            };
            format!("line: {line}, side: {side}{start}")
        }
    };
    let data = graphql(
        context,
        &mr.host,
        &format!("mutation($r: ID!, $path: String!, $body: String!) {{ addPullRequestReviewThread(input: {{pullRequestReviewId: $r, path: $path, body: $body, {fields}}}) {{ thread {{ diffSide comments(first: 1) {{ nodes {{ {COMMENT_FIELDS} }} }} }} }} }}"),
        &[("r", Var::Text(&review.id)), ("path", Var::Text(path)), ("body", Var::Text(note))],
        "draft",
    )
    .await?;
    let thread = at(&data, &["addPullRequestReviewThread", "thread"]);
    let comment = thread
        .and_then(|thread| list(at(thread, &["comments", "nodes"])).first())
        .filter(|comment| super::cli::truthy(Some(comment)));
    let (Some(thread), Some(comment)) = (thread, comment) else {
        return Err("GitHub did not add the draft comment".into());
    };
    Ok(as_draft(&with_side(comment, thread.get("diffSide"))))
}

async fn set_review_body(
    context: &ForgeContext,
    mr: &MergeRequestInfo,
    review_id: &str,
    body: &str,
) -> Result<(), String> {
    graphql(
        context,
        &mr.host,
        "mutation($r: ID!, $b: String!) { updatePullRequestReview(input: {pullRequestReviewId: $r, body: $b}) { pullRequestReview { id } } }",
        &[("r", Var::Text(review_id)), ("b", Var::Text(body))],
        "draft",
    )
    .await
    .map(|_| ())
}

/// The pending comment with that id, from the user's pending review.
async fn pending_comment(
    context: &ForgeContext,
    mr: &MergeRequestInfo,
    id: i64,
) -> Result<(PendingReview, Option<Value>), String> {
    let review = read_pending(context, mr).await?.review;
    let comment = review.as_ref().and_then(|review| {
        review
            .comments
            .iter()
            .find(|each| js::to_number(each.get("fullDatabaseId")) as i64 == id)
            .cloned()
    });
    match review {
        Some(review) if id == 0 || comment.is_some() => Ok((review, comment)),
        _ => Err("that draft is no longer in your pending GitHub review".into()),
    }
}

pub async fn update_pull_draft(
    context: &ForgeContext,
    mr: &MergeRequestInfo,
    id: i64,
    note: &str,
) -> Result<GitLabDraft, String> {
    let (review, comment) = pending_comment(context, mr, id).await?;
    let Some(comment) = comment.filter(|_| id != 0) else {
        set_review_body(context, mr, &review.id, note).await?;
        return Ok(overall(note));
    };
    let node = text(comment.get("id"));
    let data = graphql(
        context,
        &mr.host,
        &format!("mutation($c: ID!, $b: String!) {{ updatePullRequestReviewComment(input: {{pullRequestReviewCommentId: $c, body: $b}}) {{ pullRequestReviewComment {{ {COMMENT_FIELDS} }} }} }}"),
        &[("c", Var::Text(&node)), ("b", Var::Text(note))],
        "draft",
    )
    .await?;
    let Some(updated) = at(
        &data,
        &["updatePullRequestReviewComment", "pullRequestReviewComment"],
    )
    .filter(|updated| super::cli::truthy(Some(updated))) else {
        return Err("GitHub did not update the draft".into());
    };
    Ok(as_draft(&with_side(updated, comment.get("diffSide"))))
}

pub async fn delete_pull_draft(
    context: &ForgeContext,
    mr: &MergeRequestInfo,
    id: i64,
) -> Result<(), String> {
    let (review, comment) = pending_comment(context, mr, id).await?;
    let Some(comment) = comment.filter(|_| id != 0) else {
        return set_review_body(context, mr, &review.id, "").await;
    };
    let node = text(comment.get("id"));
    graphql(
        context,
        &mr.host,
        "mutation($c: ID!) { deletePullRequestReviewComment(input: {id: $c}) { pullRequestReview { id } } }",
        &[("c", Var::Text(&node))],
        "draft",
    )
    .await
    .map(|_| ())
}

/// A draft reply in a discussion: a reply comment of the user's pending
/// review, published only when they submit it on GitHub.
pub async fn create_pull_draft_reply(
    context: &ForgeContext,
    mr: &MergeRequestInfo,
    discussion_id: &str,
    note: &str,
) -> Result<GitLabDraft, String> {
    let pending = read_pending(context, mr).await?;
    let Some(thread_id) = pending.threads.get(discussion_id).cloned() else {
        return Err("GitHub: no such discussion on the pull request".into());
    };
    let review = match pending.review {
        Some(review) => review,
        None => pending_review(context, mr).await?,
    };
    let data = graphql(
        context,
        &mr.host,
        &format!("mutation($r: ID!, $t: ID!, $b: String!) {{ addPullRequestReviewThreadReply(input: {{pullRequestReviewId: $r, pullRequestReviewThreadId: $t, body: $b}}) {{ comment {{ {COMMENT_FIELDS} }} }} }}"),
        &[("r", Var::Text(&review.id)), ("t", Var::Text(&thread_id)), ("b", Var::Text(note))],
        "draft",
    )
    .await?;
    let Some(comment) = at(&data, &["addPullRequestReviewThreadReply", "comment"])
        .filter(|comment| super::cli::truthy(Some(comment)))
    else {
        return Err("GitHub did not add the draft reply".into());
    };
    if at(comment, &["pullRequestReview", "id"]).and_then(Value::as_str) != Some(review.id.as_str())
    {
        return Err("GitHub did not keep the reply in your pending review".into());
    }
    let mut draft = as_draft(&with_side(comment, Some(&json!("RIGHT"))));
    draft.discussion_id = Some(discussion_id.to_owned());
    Ok(draft)
}

#[cfg(test)]
mod tests;
