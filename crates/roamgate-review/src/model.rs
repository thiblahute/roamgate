//! Reviews, their threads and comments (shared/review.ts), as stored in
//! reviews.sqlite and sent to browsers and agents, with the shared logic
//! the server uses: counts, summaries, which threads wait on an agent and
//! what it has not heard.
//!
//! Every record keeps the fields it does not know (`extra`), so a row a
//! newer build wrote goes back to the database as it came: reviews.sqlite
//! is opened by Bun and by Rust in turn (one writer at a time) and neither
//! may drop what the other wrote. Fields are declared in the order the TS
//! service makes them, which is the order `JSON.stringify` writes them.

use indexmap::IndexMap;
use serde::de::Error as _;
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use serde_json::{Map, Value};

/// The user is `you`; an agent signs with its own name.
pub const REVIEW_USER: &str = "you";

/// The path comments on a commit message are anchored to.
pub const COMMIT_MESSAGE_PATH: &str = ":commit-message";

/// The agent session an effort review's comments follow (`effort:<id>`).
pub const EFFORT_SESSION_PREFIX: &str = "effort:";
pub const EFFORT_NO_LEADER: &str =
    "no leader session runs for this effort: the comments wait for one";
/// The agent session a work item's review follows (`work:<id>`).
pub const WORK_SESSION_PREFIX: &str = "work:";
pub const WORK_NO_OWNER: &str =
    "no owner session runs for this work item: the comments wait for one";

/// The summaries' form of review.list.
pub const REVIEW_SUMMARIES_VERSION: i64 = 1;
/// The most snapshots one review.snapshots call reads.
pub const REVIEW_SNAPSHOTS_MAX: usize = 100;
/// The most files one `review.diff` with `files` reads.
pub const REVIEW_DIFF_FILES_MAX: usize = 32;

/// `REVIEW_LIMITS`.
pub mod limits {
    pub const BODY_CHARS: usize = 20_000;
    pub const DESCRIPTION_CHARS: usize = 200_000;
    pub const SUMMARY_CHARS: usize = 20_000;
    pub const THREADS_PER_SESSION: usize = 2_000;
    pub const COMMENTS_PER_THREAD: usize = 500;
    pub const MESSAGE_CHARS: usize = 500;
    pub const TITLE_CHARS: usize = 300;
    pub const SESSIONS: usize = 10_000;
}

/// The tabs of an effort's view.
pub const REVIEW_EFFORT_TABS: [&str; 6] =
    ["board", "progress", "ledger", "plans", "feeders", "changes"];
/// What one points at in an effort's view.
pub const REVIEW_EFFORT_ITEMS: [&str; 7] = [
    "plan",
    "commit",
    "counter",
    "directory",
    "feeder",
    "change",
    "card",
];

fn is_false(value: &bool) -> bool {
    !value
}

/// A JavaScript number: written as an integer when it is one, as
/// `JSON.stringify` writes it.
#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub struct JsNum(pub f64);

impl Serialize for JsNum {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let value = self.0;
        if value.fract() == 0.0 && value.abs() < 9.007_199_254_740_992e15 {
            serializer.serialize_i64(value as i64)
        } else {
            serializer.serialize_f64(value)
        }
    }
}

impl<'de> Deserialize<'de> for JsNum {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        Ok(Self(f64::deserialize(deserializer)?))
    }
}

/// What is being reviewed. Ranges keep ref names so they follow rebases.
#[derive(Debug, Clone, PartialEq)]
pub enum ReviewTarget {
    Range {
        base: String,
        head: String,
        compare: bool,
    },
    Worktree,
    Step {
        step: String,
        before: String,
        after: String,
        at: Option<String>,
        skipped: Option<Vec<String>>,
    },
    Mr {
        url: String,
    },
    Chat {
        chat: String,
    },
    Rendered {
        path: Option<String>,
        url: Option<String>,
    },
    Effort {
        effort: String,
    },
    Work {
        item: String,
    },
    /// A kind of a newer build, kept as it came.
    Other(Map<String, Value>),
}

impl ReviewTarget {
    pub fn kind(&self) -> &str {
        match self {
            Self::Range { .. } => "range",
            Self::Worktree => "worktree",
            Self::Step { .. } => "step",
            Self::Mr { .. } => "mr",
            Self::Chat { .. } => "chat",
            Self::Rendered { .. } => "rendered",
            Self::Effort { .. } => "effort",
            Self::Work { .. } => "work",
            Self::Other(map) => map.get("kind").and_then(Value::as_str).unwrap_or(""),
        }
    }

    pub fn to_value(&self) -> Value {
        let mut map = Map::new();
        let kind = |map: &mut Map<String, Value>, kind: &str| {
            map.insert("kind".into(), Value::String(kind.into()));
        };
        match self {
            Self::Range {
                base,
                head,
                compare,
            } => {
                kind(&mut map, "range");
                map.insert("base".into(), base.clone().into());
                map.insert("head".into(), head.clone().into());
                if *compare {
                    map.insert("compare".into(), true.into());
                }
            }
            Self::Worktree => kind(&mut map, "worktree"),
            Self::Step {
                step,
                before,
                after,
                at,
                skipped,
            } => {
                kind(&mut map, "step");
                map.insert("step".into(), step.clone().into());
                map.insert("before".into(), before.clone().into());
                map.insert("after".into(), after.clone().into());
                if let Some(at) = at {
                    map.insert("at".into(), at.clone().into());
                }
                if let Some(skipped) = skipped {
                    map.insert("skipped".into(), skipped.clone().into());
                }
            }
            Self::Mr { url } => {
                kind(&mut map, "mr");
                map.insert("url".into(), url.clone().into());
            }
            Self::Chat { chat } => {
                kind(&mut map, "chat");
                map.insert("chat".into(), chat.clone().into());
            }
            Self::Rendered { path, url } => {
                kind(&mut map, "rendered");
                if let Some(path) = path {
                    map.insert("path".into(), path.clone().into());
                }
                if let Some(url) = url {
                    map.insert("url".into(), url.clone().into());
                }
            }
            Self::Effort { effort } => {
                kind(&mut map, "effort");
                map.insert("effort".into(), effort.clone().into());
            }
            Self::Work { item } => {
                kind(&mut map, "work");
                map.insert("item".into(), item.clone().into());
            }
            Self::Other(other) => return Value::Object(other.clone()),
        }
        Value::Object(map)
    }

    /// A stored target, whatever its kind; `None` for one that is not an
    /// object.
    pub fn from_value(value: &Value) -> Option<Self> {
        let map = value.as_object()?;
        let text = |name: &str| map.get(name).and_then(Value::as_str).map(str::to_owned);
        let kind = map.get("kind").and_then(Value::as_str).unwrap_or("");
        let known = match kind {
            "range" => text("base")
                .zip(text("head"))
                .map(|(base, head)| Self::Range {
                    base,
                    head,
                    compare: map.get("compare") == Some(&Value::Bool(true)),
                }),
            "worktree" => Some(Self::Worktree),
            "step" => match (text("step"), text("before"), text("after")) {
                (Some(step), Some(before), Some(after)) => Some(Self::Step {
                    step,
                    before,
                    after,
                    at: text("at"),
                    skipped: map.get("skipped").and_then(Value::as_array).map(|items| {
                        items
                            .iter()
                            .filter_map(|item| item.as_str().map(str::to_owned))
                            .collect()
                    }),
                }),
                _ => None,
            },
            "mr" => text("url").map(|url| Self::Mr { url }),
            "chat" => text("chat").map(|chat| Self::Chat { chat }),
            "rendered" => Some(Self::Rendered {
                path: text("path"),
                url: text("url"),
            }),
            "effort" => text("effort").map(|effort| Self::Effort { effort }),
            "work" => text("item").map(|item| Self::Work { item }),
            _ => None,
        };
        Some(known.unwrap_or_else(|| Self::Other(map.clone())))
    }
}

impl Serialize for ReviewTarget {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        self.to_value().serialize(serializer)
    }
}

impl<'de> Deserialize<'de> for ReviewTarget {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let value = Value::deserialize(deserializer)?;
        Self::from_value(&value).ok_or_else(|| D::Error::custom("invalid review target"))
    }
}

/// A box (or a point: no size) in fractions of a graphic's drawn size.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ReviewRegion {
    pub x: JsNum,
    pub y: JsNum,
    pub w: JsNum,
    pub h: JsNum,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
pub struct ReviewRenderPart {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub quote: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub selector: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub region: Option<ReviewRegion>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub graphic: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub element: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub moment: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub snapshot: Option<String>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

impl ReviewRenderPart {
    pub fn is_empty(&self) -> bool {
        self.quote.is_none()
            && self.url.is_none()
            && self.selector.is_none()
            && self.region.is_none()
            && self.graphic.is_none()
            && self.element.is_none()
            && self.moment.is_none()
            && self.snapshot.is_none()
            && self.extra.is_empty()
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ReviewEffortItem {
    pub kind: String,
    pub key: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ReviewEffortPart {
    pub tab: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub item: Option<ReviewEffortItem>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub plan: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub quote: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ReviewWorkFrom {
    pub review: String,
    pub thread: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ReviewWorkPart {
    pub item: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub from: Option<ReviewWorkFrom>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub quote: Option<String>,
    #[serde(default, skip_serializing_if = "is_false")]
    pub description: bool,
    #[serde(default, skip_serializing_if = "is_false")]
    pub triage: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ReviewChatPart {
    pub entry: String,
    pub quote: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub excerpt: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub call: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ReviewMessagePart {
    pub thread: String,
    pub comment: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub quote: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ReviewTerminalPart {
    pub pane: String,
    pub title: String,
    pub quote: String,
}

/// Where a thread was written (see shared/review.ts).
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewAnchor {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub commit: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub commit_subject: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub commit_parent: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub context_old: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub old_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub line: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub end_line: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub side: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<ReviewMessagePart>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub chat: Option<ReviewChatPart>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub render: Option<ReviewRenderPart>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub terminal: Option<ReviewTerminalPart>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub feedback: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub effort: Option<ReviewEffortPart>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub work: Option<ReviewWorkPart>,
    #[serde(default, skip_serializing_if = "is_false")]
    pub outdated: bool,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

impl ReviewAnchor {
    /// The side a line counts on (`new` when none is said).
    pub fn side_or_new(&self) -> &str {
        self.side.as_deref().unwrap_or("new")
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewComment {
    pub id: String,
    pub author: String,
    pub body: String,
    pub created_at: String,
    pub updated_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub gitlab_draft_id: Option<i64>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

impl ReviewComment {
    pub fn new(id: String, author: String, body: String, at: &str) -> Self {
        Self {
            id,
            author,
            body,
            created_at: at.to_owned(),
            updated_at: at.to_owned(),
            gitlab_draft_id: None,
            extra: Map::new(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewThreadGitlab {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub draft_id: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub discussion_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub head_sha: Option<String>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewThread {
    pub id: String,
    pub session_id: String,
    /// `discussion`, `draft` or `merge-request`.
    pub kind: String,
    pub anchor: ReviewAnchor,
    pub comments: Vec<ReviewComment>,
    pub resolved: bool,
    pub created_at: String,
    pub updated_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub held: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub gitlab: Option<ReviewThreadGitlab>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub gitlab_reply_to: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pending_for: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub handed_at: Option<String>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewWorking {
    pub at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ReviewUpdate {
    pub at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewAgentStatus {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pane_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub working: Option<ReviewWorking>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub update: Option<ReviewUpdate>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewSession {
    pub id: String,
    pub connection_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub workspace_id: Option<String>,
    pub root: String,
    pub title: String,
    pub target: ReviewTarget,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub automatic_base: Option<bool>,
    pub gitlab: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub auto_send: Option<bool>,
    pub summary: String,
    pub agent: ReviewAgentStatus,
    pub created_at: String,
    pub updated_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub summary_unsent: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub summary_sent: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub handoff_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub seen_head_sha: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hold_comments: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub delivered_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub delivery_error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reviewed: Option<IndexMap<String, String>>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

impl ReviewSession {
    pub fn summary_unsent(&self) -> bool {
        self.summary_unsent == Some(true)
    }
    pub fn holds_comments(&self) -> bool {
        self.hold_comments == Some(true)
    }
}

/// What a review can no longer find.
pub fn is_review_gone_code(code: &str) -> bool {
    matches!(code, "checkout-gone" | "base-gone" | "head-gone")
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewMergeRequest {
    pub url: String,
    pub title: String,
    pub state: String,
    pub head_sha: String,
    pub security: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ReviewMergeRequestLink {
    pub url: String,
    pub title: String,
    pub number: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewSnapshot {
    pub session: ReviewSession,
    pub threads: Vec<ReviewThread>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub shared: Option<Vec<ReviewThread>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub merge_request: Option<ReviewMergeRequest>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub gitlab_error: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
pub struct ReviewCounts {
    pub threads: usize,
    pub open: usize,
    pub drafts: usize,
    pub comments: usize,
    pub waiting: usize,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewSummary {
    /// The session without `reviewed` and `summarySent`.
    pub session: Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub merge_request: Option<ReviewMergeRequest>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub gitlab_error: Option<String>,
    pub counts: ReviewCounts,
}

/// The counts of a review's threads, as its summary gives them.
pub fn review_counts(threads: &[ReviewThread]) -> ReviewCounts {
    let mut counts = ReviewCounts {
        threads: threads.len(),
        ..ReviewCounts::default()
    };
    for thread in threads {
        if !thread.resolved {
            counts.open += 1;
        }
        if thread.kind == "draft" {
            counts.drafts += 1;
        }
        if thread.kind != "merge-request" {
            counts.comments += 1;
        }
        if thread.kind == "discussion"
            && !thread.resolved
            && let Some(last) = thread.comments.last()
            && last.author != REVIEW_USER
        {
            counts.waiting += 1;
        }
    }
    counts
}

/// A review's summary, from its snapshot (`shared` threads not counted).
pub fn summarize_review(snapshot: &ReviewSnapshot) -> ReviewSummary {
    let mut session = serde_json::to_value(&snapshot.session).unwrap_or(Value::Null);
    if let Some(map) = session.as_object_mut() {
        map.shift_remove("reviewed");
        map.shift_remove("summarySent");
    }
    ReviewSummary {
        session,
        merge_request: snapshot.merge_request.clone(),
        gitlab_error: snapshot.gitlab_error.clone(),
        counts: review_counts(&snapshot.threads),
    }
}

/// A comment rewritten after it was first written.
pub fn comment_edited(comment: &ReviewComment) -> bool {
    comment.updated_at > comment.created_at
}

/// A review comment that suggests a change (a ```suggestion block).
pub fn is_suggestion(thread: &ReviewThread) -> bool {
    thread.kind == "draft"
        && thread
            .comments
            .iter()
            .any(|comment| suggestion_block(&comment.body))
}

fn suggestion_block(body: &str) -> bool {
    let mut rest = body;
    while let Some(at) = rest.find("```suggestion") {
        let after = &rest[at + "```suggestion".len()..];
        match after.chars().next() {
            Some(ch) if ch.is_alphanumeric() || ch == '_' => rest = after,
            _ => return true,
        }
    }
    false
}

/// A review comment (a draft for the forge) the agent wrote in.
pub fn agent_joined(thread: &ReviewThread) -> bool {
    thread.kind == "draft"
        && thread
            .comments
            .iter()
            .any(|comment| comment.author != REVIEW_USER)
}

/// Whether a discussion needs an answer from `agent` (threadNeedsAnswer).
pub fn thread_needs_answer(thread: &ReviewThread, agent: &str, suggestions: bool) -> bool {
    if thread.resolved || thread.held.is_some() {
        return false;
    }
    if thread.kind != "discussion"
        && !(suggestions && is_suggestion(thread))
        && !agent_joined(thread)
    {
        return false;
    }
    let Some(last) = thread.comments.last() else {
        return false;
    };
    if last.author != agent {
        return true;
    }
    let answered = thread
        .comments
        .iter()
        .filter(|comment| comment.author == agent)
        .map(|comment| comment.updated_at.as_str())
        .fold("", |latest, at| if at > latest { at } else { latest });
    thread
        .comments
        .iter()
        .any(|comment| comment.author != agent && comment.updated_at.as_str() > answered)
}

/// The user's comments in a thread the agent has not had (unheardComments).
pub fn unheard_comments<'a>(thread: &'a ReviewThread, since: &str) -> Vec<&'a ReviewComment> {
    if thread.held.is_some() {
        return Vec::new();
    }
    let heard = match &thread.handed_at {
        Some(handed) if handed.as_str() > since => handed.as_str(),
        _ => since,
    };
    let comments = &thread.comments;
    comments
        .iter()
        .enumerate()
        .filter(|(index, comment)| {
            comment.author == REVIEW_USER
                && comment.updated_at.as_str() > heard
                && !comments[index + 1..].iter().any(|answer| {
                    answer.author != REVIEW_USER
                        && answer.gitlab_draft_id.is_none()
                        && answer.updated_at >= comment.updated_at
                })
        })
        .map(|(_, comment)| comment)
        .collect()
}

/// A ref that holds a tool's metadata rather than code (isMetadataRef).
pub fn is_metadata_ref(name: &str) -> bool {
    if name.starts_with("refs/")
        && !(name.starts_with("refs/heads/") || name.starts_with("refs/remotes/"))
    {
        return true;
    }
    let stripped = name
        .strip_prefix("refs/heads/")
        .or_else(|| name.strip_prefix("refs/remotes/"))
        .unwrap_or(name);
    stripped.split('/').any(|part| {
        let lower = part.to_lowercase();
        lower == "entire" || lower == "checkpoint" || lower == "checkpoints"
    })
}

/// A last step's review: "last step 14:02" (when it ended), else its trees.
pub fn describe_step_target(before: &str, after: &str, at: Option<&str>) -> String {
    if let Some(at) = at
        && let Some(ms) = crate::js::date_parse(at)
        && let Some(time) = crate::js::local_hh_mm(ms)
    {
        return format!("last step {time}");
    }
    format!(
        "last step {}..{}",
        crate::js::head16(before, 7),
        crate::js::head16(after, 7)
    )
}

/// A thread's place in an effort's view, in words (describeEffortPart).
pub fn describe_effort_part(part: &ReviewEffortPart) -> String {
    let tab = match part.tab.as_str() {
        "board" => "Board",
        "progress" => "Progress",
        "ledger" => "Ledger",
        "plans" => "Plans",
        "feeders" => "Feeders",
        "changes" => "What changed",
        _ => "",
    };
    let Some(item) = &part.item else {
        return format!("the {tab} tab");
    };
    let label = item
        .label
        .as_ref()
        .map(|label| format!(" \"{label}\""))
        .unwrap_or_default();
    let name = match item.kind.as_str() {
        "plan" => format!("planned request {}{label}", item.key),
        "commit" => format!(
            "commit{label} (ledger key {}){}",
            item.key,
            part.plan
                .as_ref()
                .map(|plan| format!(" in planned request {plan}"))
                .unwrap_or_default()
        ),
        "counter" => match &item.label {
            Some(label) => format!("the count \"{label}\""),
            None => format!("the {} count", item.key),
        },
        "directory" => format!("directory {}", item.key),
        "feeder" => format!("feeder {}", item.key),
        "card" => format!("the card of planned request {}{label}", item.key),
        _ => format!("\"{}\"", item.label.as_deref().unwrap_or(&item.key)),
    };
    format!("{name} in the {tab} tab")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn comment(id: &str, author: &str, at: &str) -> ReviewComment {
        ReviewComment::new(id.into(), author.into(), "text".into(), at)
    }

    fn thread(kind: &str, comments: Vec<ReviewComment>) -> ReviewThread {
        ReviewThread {
            id: "t".into(),
            session_id: "s".into(),
            kind: kind.into(),
            anchor: ReviewAnchor::default(),
            comments,
            resolved: false,
            created_at: "2025-01-01T00:00:00.000Z".into(),
            updated_at: "2025-01-01T00:00:00.000Z".into(),
            held: None,
            gitlab: None,
            gitlab_reply_to: None,
            pending_for: None,
            handed_at: None,
            extra: Map::new(),
        }
    }

    #[test]
    fn a_thread_waits_on_the_agent_until_it_answers_the_last_word() {
        let mut open = thread("discussion", vec![comment("a", REVIEW_USER, "1")]);
        assert!(thread_needs_answer(&open, "claude", false));
        open.comments.push(comment("b", "claude", "2"));
        assert!(!thread_needs_answer(&open, "claude", false));
        // The user rewrote a comment after the answer.
        open.comments[0].updated_at = "3".into();
        assert!(thread_needs_answer(&open, "claude", false));
        open.resolved = true;
        assert!(!thread_needs_answer(&open, "claude", false));
        let mut draft = thread("draft", vec![comment("a", REVIEW_USER, "1")]);
        assert!(!thread_needs_answer(&draft, "claude", true));
        draft.comments[0].body = "```suggestion\nx\n```".into();
        assert!(thread_needs_answer(&draft, "claude", true));
        assert!(!thread_needs_answer(&draft, "claude", false));
    }

    #[test]
    fn unheard_comments_skip_answered_and_handed_ones() {
        let mut talk = thread(
            "discussion",
            vec![
                comment("a", REVIEW_USER, "1"),
                comment("b", "claude", "2"),
                comment("c", REVIEW_USER, "3"),
            ],
        );
        let ids = |list: Vec<&ReviewComment>| list.iter().map(|c| c.id.clone()).collect::<Vec<_>>();
        assert_eq!(ids(unheard_comments(&talk, "")), vec!["c"]);
        talk.handed_at = Some("4".into());
        assert!(unheard_comments(&talk, "").is_empty());
        talk.held = Some(1);
        talk.handed_at = None;
        assert!(unheard_comments(&talk, "").is_empty());
    }

    #[test]
    fn counts_and_summaries_leave_out_what_a_list_does_not_need() {
        let threads = vec![
            thread("discussion", vec![comment("a", "claude", "1")]),
            thread("draft", vec![comment("b", REVIEW_USER, "1")]),
            thread("merge-request", vec![comment("c", "x", "1")]),
        ];
        let counts = review_counts(&threads);
        assert_eq!(
            counts,
            ReviewCounts {
                threads: 3,
                open: 3,
                drafts: 1,
                comments: 2,
                waiting: 1
            }
        );
    }

    #[test]
    fn metadata_refs_are_never_a_base() {
        assert!(is_metadata_ref("refs/notes/x"));
        assert!(is_metadata_ref("entire/checkpoints/v1"));
        assert!(is_metadata_ref("refs/remotes/origin/entire/x"));
        assert!(!is_metadata_ref("refs/remotes/origin/main"));
        assert!(!is_metadata_ref("main"));
    }

    #[test]
    fn records_keep_fields_they_do_not_know() {
        let raw = serde_json::json!({
            "id": "0123456789abcdef", "sessionId": "s", "kind": "discussion",
            "anchor": {"path": "a", "future": 1}, "comments": [], "resolved": false,
            "createdAt": "1", "updatedAt": "1", "later": {"x": true}
        });
        let parsed: ReviewThread = serde_json::from_value(raw.clone()).unwrap();
        assert_eq!(serde_json::to_value(&parsed).unwrap(), raw);
        let target: ReviewTarget =
            serde_json::from_value(serde_json::json!({"kind": "space", "x": 1})).unwrap();
        assert_eq!(target.kind(), "space");
        assert_eq!(
            target.to_value(),
            serde_json::json!({"kind": "space", "x": 1})
        );
    }
}
