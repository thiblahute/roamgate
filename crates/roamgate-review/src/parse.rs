//! What the review service checks of what it is given and how it says
//! where things are (the helpers of review/service.ts): targets, anchors,
//! parts of rendered views, efforts and work items, agent names, and the
//! one-line texts agents are sent.

use std::sync::LazyLock;

use regex::Regex;
use serde_json::{Map, Value};

use crate::error::ReviewError;
use crate::js::{head16, integer, len16, trim};
use crate::model::{
    REVIEW_EFFORT_ITEMS, REVIEW_EFFORT_TABS, REVIEW_USER, ReviewAnchor, ReviewChatPart,
    ReviewEffortItem, ReviewEffortPart, ReviewMessagePart, ReviewRegion, ReviewRenderPart,
    ReviewSession, ReviewTarget, ReviewTerminalPart, ReviewWorkFrom, ReviewWorkPart, JsNum,
    describe_step_target, limits,
};

macro_rules! re {
    ($name:ident, $pattern:expr) => {
        static $name: LazyLock<Regex> = LazyLock::new(|| Regex::new($pattern).unwrap());
    };
}

re!(ID, r"^[0-9a-f]{16}$");
re!(EFFORT_ID, r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$");
re!(WORK_ITEM_ID, r"^[0-9a-f]{8,16}$");
re!(AGENT_NAME, r"^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}$");
re!(SHA, r"^[0-9a-f]{7,64}$");
re!(TREE, r"^[0-9a-f]{40,64}$");
re!(STEP, r"^[0-9A-Za-z][0-9A-Za-z_-]{0,63}$");
re!(LINK, r"!?\[([^\]]*)\]\([^)]*\)");
re!(HEADING, r"(?m)^\s{0,3}(?:#{1,6}|>+)\s+");
re!(LIST, r"(?m)^\s*(?:[-*+]|[0-9]+[.)])\s+(?:\[[ xX]\]\s+)?");
re!(MARKS, r"\*\*|__|[*`]");
re!(CONTROL, r"[\x00-\x08\x0b-\x1f\x7f-\u{9f}]");
re!(SPACES, r"[\s\u{feff}]+");
re!(TABS_SPACES, r"[ \t]+");
re!(MR_URL, r"/-/merge_requests/\d+|^https://[^/]+/[\w.-]+/[\w.-]+/pull/\d+");
re!(GITLAB_MR, r"^https://([^/\s]+)/(.+?)/-/merge_requests/(\d+)(?:[/?#].*)?$");
re!(GITHUB_PR, r"^https://([^/\s]+)/([\w.-]+/[\w.-]+)/pull/(\d+)(?:[/?#].*)?$");
re!(SNAPSHOT_PATH, r"/images/[0-9a-f]{16}/[0-9a-f]{16}\.(png|jpg|gif|webp)$");
re!(WINDOWS_PATH, r"^[A-Za-z]:[\\/]");

/// The ids this service makes for reviews, threads and comments.
pub fn is_id(value: &str) -> bool {
    ID.is_match(value)
}

pub fn agent_name_ok(value: &str) -> bool {
    AGENT_NAME.is_match(value)
}

pub fn is_sha(value: &str) -> bool {
    SHA.is_match(value)
}

/// A 16-hex id made here.
pub fn new_id() -> String {
    let bytes: [u8; 8] = rand::random();
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

/// An absolute path on the host: POSIX, or a Windows drive (Git Bash).
pub fn is_host_path(path: &str) -> bool {
    path.starts_with('/') || WINDOWS_PATH.is_match(path)
}

/// A repository-relative path that cannot leave the checkout.
pub fn valid_review_path(path: &str) -> bool {
    !path.is_empty()
        && len16(path) <= 4096
        && !path.starts_with('/')
        && !path.contains('\0')
        && !path.split('/').any(|part| part == ".." || part.is_empty())
}

/// A time the service keeps as given: at most 40 characters that parse.
pub fn iso_time(value: Option<&Value>) -> Option<String> {
    let text = value?.as_str()?;
    (len16(text) <= 40 && crate::js::date_parse(text).is_some()).then(|| text.to_owned())
}

pub fn text(value: Option<&Value>, field: &str, max: usize) -> Result<String, ReviewError> {
    let Some(Value::String(text)) = value else {
        return Err(ReviewError::new(format!("{field} is required")));
    };
    if len16(text) > max {
        return Err(ReviewError::new(format!(
            "{field} is longer than {max} characters"
        )));
    }
    Ok(text.clone())
}

pub fn optional_text(
    value: Option<&Value>,
    field: &str,
    max: usize,
) -> Result<Option<String>, ReviewError> {
    match value {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(text)) if text.is_empty() => Ok(None),
        other => text(other, field, max).map(Some),
    }
}

/// A comment's text: not empty.
pub fn body(value: Option<&Value>, max: usize) -> Result<String, ReviewError> {
    let result = text(value, "text", max)?;
    if trim(&result).is_empty() {
        return Err(ReviewError::new("text is empty"));
    }
    Ok(result)
}

/// The longest a comment may be: a work item's description holds a doc.
pub fn body_limit(anchor: &ReviewAnchor, first: bool) -> usize {
    if first && anchor.work.as_ref().is_some_and(|work| work.description) {
        limits::DESCRIPTION_CHARS
    } else {
        limits::BODY_CHARS
    }
}

/// Words as they read once a comment's Markdown is drawn (readWords).
pub fn read_words(markdown: &str) -> String {
    let text = LINK.replace_all(markdown, "$1");
    let text = HEADING.replace_all(&text, "");
    let text = LIST.replace_all(&text, "");
    let text = MARKS.replace_all(&text, "");
    text.replace('|', " ")
}

fn loose_words(text: &str) -> String {
    trim(&SPACES.replace_all(text, " ")).to_lowercase()
}

/// The words a thread on a part of a comment quotes, as they read
/// (messageQuote).
pub fn message_quote(body: &str, quote: &str) -> Result<String, ReviewError> {
    let words = trim(&TABS_SPACES.replace_all(&read_words(quote), " ")).to_owned();
    let first = loose_words(words.split('\n').next().unwrap_or(""));
    if first.is_empty() {
        return Err(ReviewError::new(
            "quote the words of the part the thread is on",
        ));
    }
    if !loose_words(&read_words(body)).contains(&first) {
        return Err(ReviewError::new(
            "the quote is not in that comment: quote its words as they read (a heading's, a paragraph's, one table cell's)",
        ));
    }
    Ok(words)
}

/// Control characters other than newline and tab are never typed.
pub fn typed(value: &str) -> String {
    CONTROL.replace_all(value, "").into_owned()
}

/// Text from the diff or a title, on one line, cut.
pub fn one_line(value: &str, max: usize) -> String {
    let line = trim(&SPACES.replace_all(&typed(value), " ")).to_owned();
    if len16(&line) > max {
        format!("{}...", head16(&line, max))
    } else {
        line
    }
}

fn record<'a>(value: Option<&'a Value>) -> Option<&'a Map<String, Value>> {
    value.and_then(Value::as_object)
}

fn work_part(value: Option<&Value>) -> Result<Option<ReviewWorkPart>, ReviewError> {
    let Some(value) = value.filter(|value| !value.is_null()) else {
        return Ok(None);
    };
    let Some(raw) = value.as_object() else {
        return Err(ReviewError::new("invalid work part"));
    };
    let item = text(raw.get("item"), "work item", 16)?;
    if !WORK_ITEM_ID.is_match(&item) {
        return Err(ReviewError::new("invalid work item"));
    }
    let mut part = ReviewWorkPart {
        item,
        from: None,
        quote: None,
        description: false,
        triage: false,
    };
    if let Some(from) = record(raw.get("from")) {
        let review = optional_text(from.get("review"), "from review", 64)?;
        let thread = optional_text(from.get("thread"), "from thread", 64)?;
        if let (Some(review), Some(thread)) = (review, thread) {
            part.from = Some(ReviewWorkFrom { review, thread });
        }
    }
    if let Some(quote) = optional_text(raw.get("quote"), "quote", 4000)? {
        let quote = trim(&quote);
        if !quote.is_empty() {
            part.quote = Some(quote.to_owned());
        }
    }
    part.description = raw.get("description") == Some(&Value::Bool(true));
    part.triage = raw.get("triage") == Some(&Value::Bool(true));
    Ok(Some(part))
}

fn effort_part(value: Option<&Value>) -> Result<Option<ReviewEffortPart>, ReviewError> {
    let Some(value) = value.filter(|value| !value.is_null()) else {
        return Ok(None);
    };
    let Some(raw) = value.as_object() else {
        return Err(ReviewError::new("invalid effort part"));
    };
    let tab = raw
        .get("tab")
        .and_then(Value::as_str)
        .filter(|tab| REVIEW_EFFORT_TABS.contains(tab))
        .ok_or_else(|| ReviewError::new("an effort part needs its tab"))?;
    let mut part = ReviewEffortPart {
        tab: tab.into(),
        item: None,
        plan: None,
        quote: None,
    };
    if let Some(item) = raw.get("item").filter(|item| !item.is_null()) {
        let kind = item
            .get("kind")
            .and_then(Value::as_str)
            .filter(|kind| REVIEW_EFFORT_ITEMS.contains(kind));
        let key = optional_text(item.get("key"), "effort item", 300)?
            .map(|key| trim(&key).to_owned())
            .filter(|key| !key.is_empty());
        let (Some(kind), Some(key)) = (kind, key) else {
            return Err(ReviewError::new("invalid effort item"));
        };
        let label = optional_text(item.get("label"), "effort item label", 300)?;
        part.item = Some(ReviewEffortItem {
            kind: kind.into(),
            key,
            label: label.map(|label| one_line(&label, 300)),
        });
    }
    part.plan = optional_text(raw.get("plan"), "plan", 200)?;
    if let Some(quote) = optional_text(raw.get("quote"), "quote", 4000)? {
        let quote = trim(&quote);
        if !quote.is_empty() {
            part.quote = Some(quote.to_owned());
        }
    }
    Ok(Some(part))
}

/// An agent's name: plain, never the user's.
pub fn parse_agent_name(value: Option<&Value>) -> Result<Option<String>, ReviewError> {
    match value {
        None | Some(Value::Null) => return Ok(None),
        Some(Value::String(text)) if text.is_empty() => return Ok(None),
        _ => {}
    }
    let name = trim(&text(value, "agent", 100)?).to_owned();
    if !AGENT_NAME.is_match(&name) || name.to_lowercase() == REVIEW_USER {
        return Err(ReviewError::new("invalid agent name"));
    }
    Ok(Some(name))
}

/// Who writes: the user unless an agent's name is given.
pub fn author(value: Option<&Value>) -> Result<String, ReviewError> {
    if value.and_then(Value::as_str) == Some(REVIEW_USER) {
        return Ok(REVIEW_USER.into());
    }
    Ok(parse_agent_name(value)?.unwrap_or_else(|| REVIEW_USER.into()))
}

pub fn ref_name(value: Option<&Value>, field: &str) -> Result<String, ReviewError> {
    let raw = text(value, field, 256)?;
    let name = trim(&raw).to_owned();
    if name.is_empty()
        || name.starts_with('-')
        || name.chars().any(|ch| crate::js::js_space(ch) || ch == '\0')
    {
        return Err(ReviewError::new(format!("invalid {field}")));
    }
    Ok(name)
}

const STEP_SKIPPED_MAX: usize = 200;

fn parse_step_target(target: &Map<String, Value>) -> Result<ReviewTarget, ReviewError> {
    let tree = |value: Option<&Value>, field: &str| match value.and_then(Value::as_str) {
        Some(tree) if TREE.is_match(tree) => Ok(tree.to_owned()),
        _ => Err(ReviewError::new(format!("invalid {field}"))),
    };
    let step = match target.get("step").and_then(Value::as_str) {
        Some(step) if STEP.is_match(step) => step.to_owned(),
        _ => return Err(ReviewError::new("invalid step")),
    };
    let at = iso_time(target.get("at"));
    let skipped: Vec<String> = target
        .get("skipped")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .filter(|path| valid_review_path(path))
                .take(STEP_SKIPPED_MAX)
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_default();
    Ok(ReviewTarget::Step {
        step,
        before: tree(target.get("before"), "before")?,
        after: tree(target.get("after"), "after")?,
        at,
        skipped: (!skipped.is_empty()).then_some(skipped),
    })
}

/// An http(s) URL a review may open, cleaned of credentials and fragment.
pub fn parse_site_url(value: Option<&Value>) -> Option<String> {
    let text = value?.as_str()?;
    if len16(text) > 2048 {
        return None;
    }
    let mut url = url::Url::parse(trim(text)).ok()?;
    if url.scheme() != "http" && url.scheme() != "https" {
        return None;
    }
    if !url.username().is_empty() || url.password().is_some() {
        return None;
    }
    url.set_fragment(None);
    Some(url.to_string())
}

/// What is reviewed, checked (parseReviewTarget).
pub fn parse_review_target(value: Option<&Value>) -> Result<ReviewTarget, ReviewError> {
    let Some(target) = record(value) else {
        return Err(ReviewError::new("target is required"));
    };
    let kind = target.get("kind").and_then(Value::as_str).unwrap_or("");
    match kind {
        "worktree" => Ok(ReviewTarget::Worktree),
        "step" => parse_step_target(target),
        "range" => Ok(ReviewTarget::Range {
            base: ref_name(target.get("base"), "base")?,
            head: ref_name(
                Some(target.get("head").unwrap_or(&Value::String("HEAD".into()))),
                "head",
            )?,
            compare: target.get("compare") == Some(&Value::Bool(true)),
        }),
        "chat" => Ok(ReviewTarget::Chat {
            chat: text(target.get("chat"), "chat", 300)?,
        }),
        "rendered" => {
            if target.contains_key("path") == target.contains_key("url") {
                return Err(ReviewError::new("a rendered review shows a path or a URL"));
            }
            if target.contains_key("path") {
                let path = text(target.get("path"), "path", 4096)?;
                if !valid_review_path(&path) {
                    return Err(ReviewError::new("the path must be relative to the checkout"));
                }
                return Ok(ReviewTarget::Rendered {
                    path: Some(path),
                    url: None,
                });
            }
            let url = parse_site_url(target.get("url"))
                .ok_or_else(|| ReviewError::new("the URL must be an http(s) URL"))?;
            Ok(ReviewTarget::Rendered {
                path: None,
                url: Some(url),
            })
        }
        "effort" => {
            let effort = text(target.get("effort"), "effort", 200)?;
            if !EFFORT_ID.is_match(&effort) {
                return Err(ReviewError::new("invalid effort"));
            }
            Ok(ReviewTarget::Effort { effort })
        }
        "work" => {
            let item = text(target.get("item"), "item", 16)?;
            if !WORK_ITEM_ID.is_match(&item) {
                return Err(ReviewError::new("invalid work item"));
            }
            Ok(ReviewTarget::Work { item })
        }
        "mr" => {
            let raw = text(target.get("url"), "url", 2048)?;
            let url = trim(&raw).to_owned();
            let parsed = url::Url::parse(&url)
                .map_err(|_| ReviewError::new("invalid merge request URL"))?;
            if parsed.scheme() != "https" || !MR_URL.is_match(&url) {
                return Err(ReviewError::new("invalid merge request URL"));
            }
            let cut = url.find(['#', '?']).map_or(url.as_str(), |at| &url[..at]);
            Ok(ReviewTarget::Mr { url: cut.to_owned() })
        }
        _ => Err(ReviewError::new("unknown target kind")),
    }
}

/// A merge request or pull request named by its URL.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MergeRequestRef {
    pub host: String,
    pub project: String,
    pub iid: i64,
}

/// parseMergeRequestUrl (review/gitlab.ts, GitHub's pull requests too).
pub fn parse_merge_request_url(url: &str) -> Option<MergeRequestRef> {
    let found = GITHUB_PR.captures(url).or_else(|| GITLAB_MR.captures(url))?;
    Some(MergeRequestRef {
        host: found[1].to_owned(),
        project: found[2].to_owned(),
        iid: found[3].parse().ok()?,
    })
}

/// Whether a merge request is confidential security work
/// (mergeRequestSecurity): "security", "open" or "unknown".
pub fn merge_request_security(url: &str, mr: Option<&Value>) -> &'static str {
    let reference = parse_merge_request_url(url);
    let field = |name: &str| mr.and_then(|mr| mr.get(name)).and_then(Value::as_str);
    let from_url = field("url").and_then(parse_merge_request_url).map(|r| r.project);
    let names = [
        reference.as_ref().map(|r| r.project.clone()),
        field("project").map(str::to_owned),
        field("projectPath").map(str::to_owned),
        from_url,
    ];
    if names
        .iter()
        .flatten()
        .any(|name| !name.is_empty() && name.to_lowercase().contains("security"))
    {
        return "security";
    }
    let path = field("projectPath").or_else(|| field("project"));
    match (reference, path) {
        (Some(_), Some(path)) if !path.is_empty() && !path.bytes().all(|b| b.is_ascii_digit()) => {
            "open"
        }
        _ => "unknown",
    }
}

pub fn same_merge_request(a: &MergeRequestRef, b: &MergeRequestRef) -> bool {
    a.host == b.host && a.project == b.project && a.iid == b.iid
}

/// `main` and `origin/main`: one branch's local and remote forms.
pub fn counterpart_bases(a: &str, b: &str) -> bool {
    let remote_of = |remote: &str, local: &str| {
        remote.len() > local.len()
            && remote.ends_with(&format!("/{local}"))
            && !remote[..remote.len() - local.len() - 1].contains('/')
    };
    a != b && (remote_of(a, b) || remote_of(b, a))
}

pub fn same_target(a: &ReviewTarget, b: &ReviewTarget) -> bool {
    use ReviewTarget as T;
    match (a, b) {
        (
            T::Range {
                base,
                head,
                compare,
            },
            T::Range {
                base: other_base,
                head: other_head,
                compare: other_compare,
            },
        ) => base == other_base && head == other_head && compare == other_compare,
        (T::Mr { url: left }, T::Mr { url: right }) => {
            match (parse_merge_request_url(left), parse_merge_request_url(right)) {
                (Some(left), Some(right)) => same_merge_request(&left, &right),
                _ => left == right,
            }
        }
        (T::Chat { chat: left }, T::Chat { chat: right }) => left == right,
        (
            T::Step { before, after, .. },
            T::Step {
                before: other_before,
                after: other_after,
                ..
            },
        ) => before == other_before && after == other_after,
        (T::Rendered { path, url }, T::Rendered { path: p, url: u }) => path == p && url == u,
        (T::Effort { effort: left }, T::Effort { effort: right }) => left == right,
        (T::Work { item: left }, T::Work { item: right }) => left == right,
        _ => a.kind() == b.kind(),
    }
}

/// Only a review of a merge request is a GitLab review.
pub fn is_gitlab_target(target: &ReviewTarget) -> bool {
    matches!(target, ReviewTarget::Mr { .. })
}

/// Whether the checkout's branch is the one a review's target shows.
pub fn reviews_branch(target: &ReviewTarget, branch: &str) -> bool {
    match target {
        ReviewTarget::Range { head, .. } => {
            head == "HEAD" || head == branch || *head == format!("refs/heads/{branch}")
        }
        ReviewTarget::Worktree | ReviewTarget::Step { .. } | ReviewTarget::Mr { .. } => true,
        _ => false,
    }
}

/// How a review's target reads in its title and to agents.
pub fn describe_target(target: &ReviewTarget) -> String {
    match target {
        ReviewTarget::Range {
            base,
            head,
            compare,
        } => {
            if *compare {
                format!("{base} vs {head}")
            } else {
                format!("{base}..{head}")
            }
        }
        ReviewTarget::Mr { url } => url.strip_prefix("https://").unwrap_or(url).to_owned(),
        ReviewTarget::Chat { .. } => "chat".into(),
        ReviewTarget::Rendered { path, url } => path.clone().or_else(|| url.clone()).unwrap_or_default(),
        ReviewTarget::Effort { .. } => "effort".into(),
        ReviewTarget::Work { item } => format!("work item {}", head16(item, 8)),
        ReviewTarget::Step {
            before, after, at, ..
        } => describe_step_target(before, after, at.as_deref()),
        ReviewTarget::Worktree => "working tree".into(),
        ReviewTarget::Other(_) => "review".into(),
    }
}

/// The first line of what an agent is sent (deliveryHeader).
pub fn delivery_header(session: &ReviewSession, triage: bool) -> String {
    match &session.target {
        ReviewTarget::Chat { .. } => "[Roamgate chat comment]".into(),
        ReviewTarget::Work { item } => {
            let title = session.title.strip_prefix("Work: ").unwrap_or(&session.title);
            format!(
                "[Roamgate work item {} \"{}\" (yours{})]",
                head16(item, 8),
                one_line(title, 200),
                if triage { ", needs triage" } else { "" }
            )
        }
        target => format!(
            "[Roamgate review \"{}\" ({})]",
            one_line(&session.title, 200),
            one_line(&describe_target(target), 300)
        ),
    }
}

/// A chat message's time, as the agent's chat shows it (local, HH:MM).
pub fn chat_time(at: &str) -> String {
    crate::js::date_parse(at)
        .and_then(crate::js::local_hh_mm)
        .unwrap_or_else(|| at.to_owned())
}

/// Where a comment on a file a chat's tool call changed is
/// (fileChangePlace).
pub fn file_change_place(anchor: &ReviewAnchor, at: Option<&str>) -> String {
    let path = one_line(anchor.path.as_deref().unwrap_or(""), 300);
    let change = format!(
        "your change{}",
        at.map(|at| format!(" of {}", chat_time(at))).unwrap_or_default()
    );
    let Some(line) = anchor.line.filter(|line| *line != 0) else {
        return format!("on the file {path}, as {change} left it");
    };
    let end = anchor.end_line.filter(|end| *end != 0);
    let lines = match end {
        Some(end) => format!("lines {line}-{end}"),
        None => format!("line {line}"),
    };
    let these = if end.is_some() { "these lines" } else { "this line" };
    let range = end.map(|end| format!("-{end}")).unwrap_or_default();
    if anchor.side.as_deref() == Some("old") {
        format!(
            "on {path}:{line}{range} ({lines} as the file was before {change}, which removed {}), about {these}",
            if end.is_some() { "them" } else { "it" }
        )
    } else {
        format!("on {path}:{line}{range} ({lines} as {change} left the file), about {these}")
    }
}

/// A thread's place, checked (parseAnchor).
pub fn parse_anchor(value: Option<&Value>) -> Result<ReviewAnchor, ReviewError> {
    let Some(value) = value.filter(|value| !value.is_null()) else {
        return Ok(ReviewAnchor::default());
    };
    let Some(raw) = value.as_object() else {
        return Err(ReviewError::new("invalid anchor"));
    };
    let mut anchor = ReviewAnchor {
        path: optional_text(raw.get("path"), "path", 4096)?,
        ..ReviewAnchor::default()
    };
    if let Some(commit) = optional_text(raw.get("commit"), "commit", 64)? {
        if !SHA.is_match(&commit) {
            return Err(ReviewError::new("invalid commit"));
        }
        anchor.commit = Some(commit);
        anchor.commit_subject = optional_text(raw.get("commitSubject"), "commit subject", 1000)?;
        anchor.commit_parent = optional_text(raw.get("commitParent"), "commit parent", 64)?
            .filter(|parent| SHA.is_match(parent));
    }
    if let Some(context) = raw.get("contextOld").and_then(integer).filter(|n| *n > 0) {
        anchor.context_old = Some(context);
    }
    anchor.old_path = optional_text(raw.get("oldPath"), "old path", 4096)?;
    if let Some(line) = raw.get("line").filter(|line| !line.is_null()) {
        if anchor.path.is_none() {
            return Err(ReviewError::new("a line needs a path"));
        }
        let line = integer(line)
            .filter(|line| *line >= 1)
            .ok_or_else(|| ReviewError::new("invalid line"))?;
        anchor.line = Some(line);
        let end = raw
            .get("endLine")
            .filter(|end| !end.is_null())
            .or_else(|| raw.get("end_line"))
            .filter(|end| !end.is_null());
        if let Some(end) = end {
            let end = integer(end)
                .filter(|end| *end >= line)
                .ok_or_else(|| ReviewError::new("invalid end line"))?;
            if end != line {
                anchor.end_line = Some(end);
            }
        }
        let side = match raw.get("side") {
            None | Some(Value::Null) => "new",
            Some(Value::String(side)) if side == "old" || side == "new" => side.as_str(),
            _ => return Err(ReviewError::new("invalid side")),
        };
        anchor.side = Some(side.into());
        anchor.text = optional_text(raw.get("text"), "line text", 4000)?;
    }
    if let Some(message) = raw.get("message").filter(|v| !v.is_null()) {
        let Some(part) = message.as_object() else {
            return Err(ReviewError::new("invalid message part"));
        };
        let thread = optional_text(part.get("thread"), "message thread", 64)?;
        let comment = optional_text(part.get("comment"), "message comment", 64)?;
        let quote = optional_text(part.get("quote"), "quote", 4000)?
            .map(|quote| trim(&quote).to_owned())
            .filter(|quote| !quote.is_empty());
        let (Some(thread), Some(comment)) = (thread, comment) else {
            return Err(ReviewError::new(
                "a message part needs its thread and comment",
            ));
        };
        anchor.message = Some(ReviewMessagePart {
            thread,
            comment,
            quote,
        });
    }
    if let Some(chat) = raw.get("chat").filter(|v| !v.is_null()) {
        let Some(part) = chat.as_object() else {
            return Err(ReviewError::new("invalid chat part"));
        };
        let entry = optional_text(part.get("entry"), "chat message", 300)?;
        let quote = optional_text(part.get("quote"), "quote", 4000)?
            .map(|quote| trim(&quote).to_owned())
            .filter(|quote| !quote.is_empty());
        let (Some(entry), Some(quote)) = (entry, quote) else {
            return Err(ReviewError::new("a chat part needs its message and quote"));
        };
        anchor.chat = Some(ReviewChatPart {
            entry,
            quote,
            at: optional_text(part.get("at"), "chat message time", 64)?,
            excerpt: optional_text(part.get("excerpt"), "chat message excerpt", 300)?,
            call: optional_text(part.get("call"), "tool call", 300)?,
        });
    }
    if let Some(render) = raw.get("render").filter(|v| !v.is_null()) {
        anchor.render = Some(parse_render_part(render)?);
    }
    if let Some(terminal) = raw.get("terminal").filter(|v| !v.is_null()) {
        let Some(part) = terminal.as_object() else {
            return Err(ReviewError::new("invalid terminal part"));
        };
        anchor.terminal = Some(ReviewTerminalPart {
            pane: text(part.get("pane"), "pane", 200)?,
            title: one_line(&text(part.get("title"), "title", 500)?, 300),
            quote: text(part.get("quote"), "quote", 20_000)?,
        });
    }
    anchor.feedback = optional_text(raw.get("feedback"), "feedback", 30_000)?;
    anchor.effort = effort_part(raw.get("effort"))?;
    anchor.work = work_part(raw.get("work"))?;
    Ok(anchor)
}

/// A held comment's place in the feedback list.
pub fn held_place(value: Option<&Value>) -> Option<i64> {
    let number = value?.as_number()?;
    if let Some(int) = number.as_i64() {
        return (int.abs() <= 9_007_199_254_740_991).then_some(int);
    }
    let float = number.as_f64()?;
    (float.fract() == 0.0 && float.abs() <= 9_007_199_254_740_991.0).then_some(float as i64)
}

fn fraction(value: Option<&Value>) -> Result<f64, ReviewError> {
    let value = value
        .and_then(Value::as_f64)
        .filter(|value| value.is_finite() && (0.0..=1.0).contains(value))
        .ok_or_else(|| ReviewError::new("invalid region"))?;
    Ok((value * 10_000.0).round() / 10_000.0)
}

/// A part of a rendered view, checked (parseRenderPart).
pub fn parse_render_part(value: &Value) -> Result<ReviewRenderPart, ReviewError> {
    let Some(raw) = value.as_object() else {
        return Err(ReviewError::new("invalid rendered part"));
    };
    let mut part = ReviewRenderPart {
        quote: optional_text(raw.get("quote"), "quote", 4000)?
            .map(|quote| trim(&quote).to_owned())
            .filter(|quote| !quote.is_empty()),
        url: optional_text(raw.get("url"), "page", 2048)?,
        selector: optional_text(raw.get("selector"), "selector", 1000)?,
        ..ReviewRenderPart::default()
    };
    if let Some(region) = raw.get("region").filter(|v| !v.is_null()) {
        let Some(region) = region.as_object() else {
            return Err(ReviewError::new("invalid region"));
        };
        let zero = Value::from(0);
        let x = fraction(region.get("x"))?;
        let y = fraction(region.get("y"))?;
        let w = fraction(Some(region.get("w").unwrap_or(&zero)))?;
        let h = fraction(Some(region.get("h").unwrap_or(&zero)))?;
        if x + w > 1.0001 || y + h > 1.0001 {
            return Err(ReviewError::new("invalid region"));
        }
        part.region = Some(ReviewRegion {
            x: JsNum(x),
            y: JsNum(y),
            w: JsNum(w),
            h: JsNum(h),
        });
    }
    part.graphic = optional_text(raw.get("graphic"), "graphic", 300)?.map(|g| one_line(&g, 300));
    part.element = optional_text(raw.get("element"), "element", 300)?.map(|e| one_line(&e, 200));
    part.moment = optional_text(raw.get("moment"), "moment", 200)?.map(|m| one_line(&m, 200));
    if let Some(snapshot) = optional_text(raw.get("snapshot"), "snapshot", 4096)? {
        if !SNAPSHOT_PATH.is_match(&snapshot) || !is_host_path(&snapshot) {
            return Err(ReviewError::new(
                "a snapshot is an image saved with the review",
            ));
        }
        part.snapshot = Some(snapshot);
    }
    if part.is_empty() {
        return Err(ReviewError::new("invalid rendered part"));
    }
    Ok(part)
}

fn pct(value: f64) -> String {
    let rounded = (value * 1000.0).round() / 10.0;
    format!("{}%", crate::js::number_text(rounded))
}

/// What a comment on a rendered view points at (renderedPlace).
pub fn rendered_place(part: &ReviewRenderPart) -> String {
    let mut bits = Vec::new();
    if let Some(url) = part.url.as_deref().filter(|u| !u.is_empty()) {
        bits.push(format!("page {}", one_line(url, 300)));
    }
    if let Some(graphic) = part.graphic.as_deref().filter(|g| !g.is_empty()) {
        bits.push(one_line(graphic, 120));
    }
    if let Some(region) = &part.region {
        let (x, y, w, h) = (region.x.0, region.y.0, region.w.0, region.h.0);
        bits.push(if w != 0.0 || h != 0.0 {
            format!(
                "region x {} y {} w {} h {} of it",
                pct(x),
                pct(y),
                pct(w),
                pct(h)
            )
        } else {
            format!("point x {} y {} of it", pct(x), pct(y))
        });
    }
    if let Some(element) = part.element.as_deref().filter(|e| !e.is_empty()) {
        bits.push(format!("element \"{}\"", element.replace('"', "'")));
    }
    if let Some(selector) = part.selector.as_deref().filter(|s| !s.is_empty()) {
        bits.push(format!("at `{}`", selector.replace('`', "'")));
    }
    if let Some(moment) = part.moment.as_deref().filter(|m| !m.is_empty()) {
        bits.push(format!("at {moment}"));
    }
    bits.join(", ")
}

/// A commit or tree name as git prints it.
pub fn object_name(value: Option<&Value>, field: &str) -> Result<String, ReviewError> {
    match value.and_then(Value::as_str) {
        Some(name) if SHA.is_match(name) => Ok(name.to_owned()),
        _ => Err(ReviewError::new(format!("invalid {field}"))),
    }
}

/// The files `review.diff` is asked to read (`{path, oldPath?}` each).
pub fn file_requests(value: Option<&Value>) -> Result<Vec<Value>, ReviewError> {
    let max = crate::model::REVIEW_DIFF_FILES_MAX;
    let items = value
        .and_then(Value::as_array)
        .filter(|items| !items.is_empty() && items.len() <= max)
        .ok_or_else(|| ReviewError::new(format!("files takes 1 to {max} files")))?;
    items
        .iter()
        .map(|item| {
            let path = item.get("path").and_then(Value::as_str);
            let old = item.get("oldPath");
            let old_ok = match old {
                None => true,
                Some(Value::String(old)) => valid_review_path(old),
                Some(_) => false,
            };
            match path {
                Some(path) if valid_review_path(path) && old_ok => {
                    let mut map = Map::new();
                    map.insert("path".into(), path.into());
                    if let Some(Value::String(old)) = old
                        && old != path
                    {
                        map.insert("oldPath".into(), old.clone().into());
                    }
                    Ok(Value::Object(map))
                }
                _ => Err(ReviewError::new("invalid file")),
            }
        })
        .collect()
}

/// An id the browser made for what it writes (clientId).
pub fn client_id(value: Option<&Value>, field: &str) -> Result<Option<String>, ReviewError> {
    match value {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(id)) if ID.is_match(id) => Ok(Some(id.clone())),
        _ => Err(ReviewError::new(format!(
            "{field} must be 16 hexadecimal digits"
        ))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn targets_refuse_option_like_or_multi_word_refs_and_non_mr_urls() {
        let target = |value: Value| parse_review_target(Some(&value));
        assert!(target(json!({"kind": "range", "base": "--upload-pack=x"})).is_err());
        assert!(target(json!({"kind": "range", "base": "main two"})).is_err());
        assert!(target(json!({"kind": "mr", "url": "https://example.com/x"})).is_err());
        assert!(target(json!({"kind": "mr", "url": "http://gitlab.com/g/p/-/merge_requests/1"})).is_err());
        assert_eq!(
            target(json!({"kind": "mr", "url": "https://gitlab.com/g/p/-/merge_requests/1/diffs?x#y"})).unwrap(),
            ReviewTarget::Mr {
                url: "https://gitlab.com/g/p/-/merge_requests/1/diffs".into()
            }
        );
        assert_eq!(
            target(json!({"kind": "range", "base": "main"})).unwrap(),
            ReviewTarget::Range {
                base: "main".into(),
                head: "HEAD".into(),
                compare: false
            }
        );
        assert!(target(json!({"kind": "rendered", "path": "../x"})).is_err());
        assert_eq!(
            target(json!({"kind": "rendered", "url": "https://u:p@x.y/a#b"})).unwrap_err().message,
            "the URL must be an http(s) URL"
        );
        assert_eq!(
            target(json!({"kind": "rendered", "url": "https://x.y/a?q=1#b"})).unwrap(),
            ReviewTarget::Rendered {
                path: None,
                url: Some("https://x.y/a?q=1".into())
            }
        );
    }

    #[test]
    fn comparing_two_versions_is_its_own_review_titled_old_vs_new() {
        let compare = ReviewTarget::Range {
            base: "v1".into(),
            head: "v2".into(),
            compare: true,
        };
        assert_eq!(describe_target(&compare), "v1 vs v2");
        let plain = ReviewTarget::Range {
            base: "v1".into(),
            head: "v2".into(),
            compare: false,
        };
        assert!(!same_target(&compare, &plain));
    }

    #[test]
    fn the_checkouts_branch_is_the_one_of_a_range_up_to_head_or_that_branch() {
        let range = |head: &str| ReviewTarget::Range {
            base: "main".into(),
            head: head.into(),
            compare: false,
        };
        assert!(reviews_branch(&range("HEAD"), "topic"));
        assert!(reviews_branch(&range("topic"), "topic"));
        assert!(reviews_branch(&range("refs/heads/topic"), "topic"));
        assert!(!reviews_branch(&range("other"), "topic"));
        assert!(reviews_branch(&ReviewTarget::Worktree, "x"));
        assert!(!reviews_branch(&ReviewTarget::Chat { chat: "c".into() }, "x"));
    }

    #[test]
    fn anchors_are_checked_field_by_field() {
        let anchor = parse_anchor(Some(&json!({"path": "a.c", "line": 3, "end_line": 5, "text": "x", "junk": 1}))).unwrap();
        assert_eq!(
            serde_json::to_value(&anchor).unwrap(),
            json!({"path": "a.c", "line": 3, "endLine": 5, "side": "new", "text": "x"})
        );
        assert!(parse_anchor(Some(&json!({"line": 3}))).is_err());
        assert!(parse_anchor(Some(&json!({"path": "a", "line": 3, "endLine": 2}))).is_err());
        assert!(parse_anchor(Some(&json!({"path": "a", "commit": "XYZ"}))).is_err());
        let region = parse_anchor(Some(&json!({"render": {"region": {"x": 0.123456, "y": 0.5}}}))).unwrap();
        assert_eq!(
            serde_json::to_value(region.render.unwrap()).unwrap(),
            json!({"region": {"x": 0.1235, "y": 0.5, "w": 0, "h": 0}})
        );
        assert!(parse_anchor(Some(&json!({"render": {}}))).is_err());
    }

    #[test]
    fn quotes_of_a_comment_read_as_rendered() {
        assert_eq!(message_quote("## The **plan**\n\nSome `code` here", "the plan").unwrap(), "the plan");
        assert!(message_quote("Some text", "other words").is_err());
        assert_eq!(read_words("- [x] a [link](u) | b"), "a link   b");
    }

    #[test]
    fn rendered_places_name_the_region_and_element() {
        let part = parse_render_part(&json!({"graphic": "diagram 2", "region": {"x": 0.1, "y": 0.2, "w": 0.3, "h": 0.4}, "element": "a\"b"})).unwrap();
        assert_eq!(
            rendered_place(&part),
            "diagram 2, region x 10% y 20% w 30% h 40% of it, element \"a'b\""
        );
    }

    #[test]
    fn security_merge_requests_are_told_by_their_url_or_gitlab() {
        let url = "https://gitlab.com/g/p/-/merge_requests/1";
        assert_eq!(merge_request_security(url, None), "unknown");
        assert_eq!(merge_request_security(url, Some(&json!({"project": "g/p"}))), "open");
        assert_eq!(
            merge_request_security("https://gitlab.com/g/security/-/merge_requests/1", None),
            "security"
        );
        assert_eq!(merge_request_security(url, Some(&json!({"project": "123"}))), "unknown");
        assert_eq!(
            parse_merge_request_url("https://github.com/o/r/pull/7/files"),
            Some(MergeRequestRef {
                host: "github.com".into(),
                project: "o/r".into(),
                iid: 7
            })
        );
    }
}
