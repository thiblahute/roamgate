//! A checkout's pull or merge request (workspace/pull-request.ts): the
//! card and the sidebar's badges of Changes, read with gh or glab on the
//! checkout's host through the forge gate.
//!
//! [`PullRequests`] holds what Bun kept in module maps keyed by its process
//! runner: CLI versions and glab logins, the GitLab GraphQL batches of the
//! badges, and the badges' shared answers. One per process, as in Bun.
//!
//! Every command runs through roamgate-git's [`GitContext`] as one POSIX
//! line, `cd <root> && GH_PROMPT_DISABLED=1 GIT_TERMINAL_PROMPT=0
//! NO_COLOR=1 <argv>`: over SSH as the host's command (tagged
//! `git.pull_request`), here in a plain `sh -c` (Git Bash on Windows),
//! where a missing CLI exits 127 as Bun's ENOENT mapping said.

use std::collections::{BTreeSet, HashMap};
use std::sync::{Arc, LazyLock, Mutex};
use std::time::Duration;

use futures_util::FutureExt;
use futures_util::future::{BoxFuture, Shared};
use regex::Regex;
use roamgate_base::clock::SharedClock;
use roamgate_base::settings::MrCacheSettings;
use roamgate_base::swr::{HeadFn, SwrOptions};
use roamgate_git::{GitContext, Invocation, shell_quote};
use serde_json::{Map, Value, json};
use tokio::sync::{OnceCell, oneshot};

use crate::gate::{ForgeCall, ForgeGate, ForgeOutput, GateError, ProcessOutput, Spawn};
use crate::mr_cache::{Answer, LoadError, Loaded, MrCache, card_answer_ttl, iso_time};

/// What the CLIs say of their hosts and logins: rarely changes.
const HOSTS_REUSE_MS: i64 = 10 * 60_000;
/// The longest a host listing may take: `glab auth status` can wait
/// forever on a keyring nobody unlocks (a locked macOS keychain over SSH).
const HOSTS_TIMEOUT_MS: i64 = 8_000;
/// The exit status a listing that ran out of time is remembered by.
const TIMED_OUT: i32 = 124;
/// A project's id and fork parent.
const PROJECT_REUSE_MS: i64 = 30 * 60_000;
/// A branch's request list, for the sidebar's summaries.
const LIST_REUSE_MS: i64 = 2 * 60_000;
/// A request's pipeline and approvals, for the card.
const DETAIL_REUSE_MS: i64 = 15_000;
/// A branch with an open request: a push, review or merge shows soon.
pub const BATCH_OPEN_MS: i64 = 2 * 60_000;
/// No request yet: one being opened shows within this.
pub const BATCH_NONE_MS: i64 = 3 * 60_000;
/// Only merged or closed requests.
pub const BATCH_SETTLED_MS: i64 = 30 * 60_000;
/// How long summaries asked together wait for each other.
pub const BATCH_WINDOW_MS: i64 = 100;
/// A branch asked about this recently is refreshed with the others.
const INTEREST_MS: i64 = 15 * 60_000;
const BATCH_BRANCHES: usize = 50;
/// A badge's answer is reused this long while the checkout's HEAD stays.
pub const SHARED_SUMMARY_MS: i64 = LIST_REUSE_MS;
/// The gate's scope of this process's workspace reads (Bun's one
/// `runProcessWithCodeTimeout`).
pub const GATE_OWNER: &str = "workspace";

const REQUEST_FIELDS: &str = "iid title state draft webUrl createdAt sourceBranch targetBranch sourceProjectId targetProjectId author { username }";

/// A failure inside a lookup: `Status` names the step that failed with
/// text this module wrote (commands, API paths, HTTP codes), never CLI
/// output; `Other` may quote anything and is never shown.
#[derive(Debug, Clone, PartialEq, Eq)]
enum Failure {
    Status(String),
    Other(String),
}

type Res<T> = Result<T, Failure>;

fn status_error(message: impl Into<String>) -> Failure {
    Failure::Status(message.into())
}

/// A remote of the checkout as the browser may see it: no credentials.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReviewRemote {
    pub name: String,
    pub host: String,
    pub repository: String,
}

impl ReviewRemote {
    pub fn to_json(&self) -> Value {
        json!({ "name": self.name, "host": self.host, "repository": self.repository })
    }
}

/// `parseReviewRemote`: a network remote's project identity, or None for
/// a local path, an unknown scheme or anything that looks unsafe.
pub fn parse_review_remote(name: &str, value: &str) -> Option<ReviewRemote> {
    static SCP: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"^(?:[^/@:]+@)?([^/:]+):(.+)$").unwrap());
    static HOST: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"(?i)^[a-z0-9][a-z0-9.-]*(?::\d+)?$").unwrap());
    // JS's `\w` is ASCII only.
    static REPOSITORY: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"^[A-Za-z0-9_.-]+(?:/[A-Za-z0-9_.-]+)+$").unwrap());
    // A Windows drive path is a local checkout, never scp's `host:path`
    // (`C:\repo` would read as the host `c`).
    static DRIVE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[A-Za-z]:[\\/]").unwrap());
    if DRIVE.is_match(value) {
        return None;
    }
    let text = if value.contains("://") {
        value.to_owned()
    } else {
        let scp = SCP.captures(value)?;
        format!("ssh://{}/{}", &scp[1], &scp[2])
    };
    let url = url::Url::parse(&text).ok()?;
    let scheme = url.scheme();
    if !["https", "http", "ssh", "git"].contains(&scheme) {
        return None;
    }
    let hostname = url.host_str().unwrap_or("");
    let host = if scheme == "ssh" {
        hostname.to_owned()
    } else {
        match url.port() {
            Some(port) => format!("{hostname}:{port}"),
            None => hostname.to_owned(),
        }
    };
    let path = url.path();
    let trimmed = path.trim_matches('/');
    let repository = trimmed.strip_suffix(".git").unwrap_or(trimmed);
    if !HOST.is_match(&host)
        || !REPOSITORY.is_match(repository)
        || repository
            .split('/')
            .any(|part| part == "." || part == "..")
    {
        return None;
    }
    Some(ReviewRemote {
        name: name.to_owned(),
        host: host.to_lowercase(),
        repository: repository.to_owned(),
    })
}

/// `value.slice(0, max)` in UTF-16 units.
fn slice_utf16(value: &str, max: usize) -> String {
    let mut units = 0;
    let mut out = String::new();
    for c in value.chars() {
        units += c.len_utf16();
        if units > max {
            break;
        }
        out.push(c);
    }
    out
}

fn utf16_len(value: &str) -> usize {
    value.chars().map(char::len_utf16).sum()
}

fn object(value: &Value) -> Res<&Map<String, Value>> {
    value
        .as_object()
        .ok_or_else(|| status_error("invalid provider response"))
}

fn text(value: Option<&Value>, fallback: &str) -> String {
    match value.and_then(Value::as_str) {
        Some(text) if !text.is_empty() => slice_utf16(text, 2000),
        _ => fallback.to_owned(),
    }
}

/// `Number.isSafeInteger(value) && value > 0`.
fn number(value: Option<&Value>) -> Res<i64> {
    let invalid = || status_error("invalid provider identifier");
    let number = value.and_then(Value::as_f64).ok_or_else(invalid)?;
    if number.fract() != 0.0 || number <= 0.0 || number > 9_007_199_254_740_991.0 {
        return Err(invalid());
    }
    Ok(number as i64)
}

fn list(value: Value, step: &str) -> Res<Vec<Value>> {
    let Value::Array(items) = value else {
        return Err(status_error(format!("{step} did not return a list")));
    };
    // Never silently choose from a truncated result set.
    if items.len() >= 100 {
        return Err(status_error(format!(
            "{step} returned 100 or more requests"
        )));
    }
    Ok(items)
}

/// `String(value)` for what a provider may send in place of a URL.
fn js_string(value: Option<&Value>) -> String {
    match value {
        None => "undefined".into(),
        Some(Value::String(text)) => text.clone(),
        Some(Value::Null) => "null".into(),
        Some(Value::Object(_)) => "[object Object]".into(),
        Some(other) => other.to_string(),
    }
}

fn web_url(host: &str, value: Option<&Value>) -> Res<String> {
    let url =
        url::Url::parse(&js_string(value)).map_err(|_| Failure::Other("Invalid URL".into()))?;
    let url_host = match (url.host_str(), url.port()) {
        (Some(name), Some(port)) => format!("{name}:{port}"),
        (Some(name), None) => name.to_owned(),
        (None, _) => String::new(),
    };
    if !["https", "http"].contains(&url.scheme())
        || url_host.to_lowercase() != host
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err(status_error("invalid provider URL"));
    }
    Ok(url.as_str().to_owned())
}

/// Host names listed one per line, as `gh` and `glab auth status` print
/// them.
fn host_lines(output: &str) -> BTreeSet<String> {
    static HOST: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"^[a-z0-9][a-z0-9-]*(?:\.[a-z0-9-]+)+(?::\d+)?$").unwrap());
    output
        .split('\n')
        .map(|line| {
            line.strip_suffix('\r')
                .unwrap_or(line)
                .trim()
                .to_lowercase()
        })
        .filter(|line| HOST.is_match(line))
        .collect()
}

/// A command as an error message names it: `glab api <path>` for API
/// calls.
fn describe_step(argv: &[String]) -> String {
    let step = if argv.get(1).map(String::as_str) == Some("api") {
        format!(
            "{} api {}",
            argv[0],
            argv.last().map(String::as_str).unwrap_or("")
        )
    } else {
        argv.join(" ")
    };
    if utf16_len(&step) > 200 {
        format!("{}...", slice_utf16(&step, 200))
    } else {
        step
    }
}

/// `githubChecks`: the checks of a pull request by state.
pub fn github_checks(value: Option<&Value>) -> Result<String, String> {
    let Some(Value::Array(items)) = value else {
        return Ok("Unavailable".into());
    };
    if items.is_empty() {
        return Ok("No checks reported".into());
    }
    let mut counts: Vec<(String, usize)> = Vec::new();
    for item in items {
        let check = object(item).map_err(|_| "invalid provider response".to_owned())?;
        let kind = check.get("__typename").and_then(Value::as_str);
        let state = match kind {
            Some("CheckRun") => {
                if check.get("status").and_then(Value::as_str) == Some("COMPLETED") {
                    text(check.get("conclusion"), "Unknown")
                } else {
                    text(check.get("status"), "Unknown")
                }
            }
            Some("StatusContext") => text(check.get("state"), "Unknown"),
            _ => "Unknown".into(),
        };
        match counts.iter_mut().find(|(each, _)| *each == state) {
            Some((_, count)) => *count += 1,
            None => counts.push((state, 1)),
        }
    }
    Ok(counts
        .iter()
        .map(|(state, count)| format!("{count} {state}"))
        .collect::<Vec<_>>()
        .join(", "))
}

/// `gitlabApprovals`: what GitLab says of a merge request's approvals.
pub fn gitlab_approvals(value: &Value) -> Result<String, String> {
    let data = object(value).map_err(|_| "invalid provider response".to_owned())?;
    // approved_by alone does not establish that approval rules are satisfied.
    let Some(approved) = data.get("approved").and_then(Value::as_bool) else {
        let left = data.get("approvals_left").and_then(Value::as_f64);
        return Ok(match left {
            Some(left)
                if left.fract() == 0.0 && (0.0..=9_007_199_254_740_991.0).contains(&left) =>
            {
                format!("{} approvals remaining (provider-reported)", left as i64)
            }
            _ => "Unavailable".into(),
        });
    };
    let count = data
        .get("approved_by")
        .and_then(Value::as_array)
        .map(Vec::len);
    Ok(format!(
        "{} (provider-reported){}",
        if approved { "Approved" } else { "Not approved" },
        count.map_or(String::new(), |count| format!("; {count} approver(s)"))
    ))
}

/// One GraphQL query for the requests of several branches of several
/// projects. Strings are JSON literals, which GraphQL reads as its own.
pub fn gitlab_branches_query(projects: &[(String, Vec<String>)]) -> String {
    let parts: Vec<String> = projects
        .iter()
        .enumerate()
        .map(|(index, (path, branches))| {
            format!(
                "p{index}: project(fullPath: {}) {{ mergeRequests(sourceBranches: {}, first: 100) {{ pageInfo {{ hasNextPage }} nodes {{ {REQUEST_FIELDS} }} }} }}",
                Value::String(path.clone()),
                Value::from(branches.clone()),
            )
        })
        .collect();
    format!("query {{ {} }}", parts.join(" "))
}

/// A GraphQL merge request in the REST shape the lookup reads.
fn rest_shape(node: &Value) -> Value {
    let iid = match node.get("iid") {
        Some(Value::String(text)) => text
            .trim()
            .parse::<f64>()
            .map(|n| serde_json::Number::from_f64(n).map_or(Value::Null, Value::Number))
            .unwrap_or(Value::Null),
        Some(Value::Number(n)) => Value::Number(n.clone()),
        _ => Value::Null,
    };
    let iid = match iid {
        Value::Number(n) if n.as_f64().is_some_and(|f| f.fract() == 0.0) => {
            json!(n.as_f64().unwrap() as i64)
        }
        other => other,
    };
    let mut shape = Map::new();
    shape.insert("iid".into(), iid);
    shape.insert(
        "title".into(),
        node.get("title").cloned().unwrap_or(Value::Null),
    );
    let username = node
        .get("author")
        .and_then(|author| author.get("username"))
        .cloned();
    let mut author = Map::new();
    if let Some(username) = username {
        author.insert("username".into(), username);
    }
    shape.insert("author".into(), Value::Object(author));
    for (to, from) in [
        ("source_branch", "sourceBranch"),
        ("target_branch", "targetBranch"),
        ("source_project_id", "sourceProjectId"),
        ("target_project_id", "targetProjectId"),
        ("state", "state"),
        ("draft", "draft"),
        ("web_url", "webUrl"),
        ("created_at", "createdAt"),
    ] {
        if let Some(value) = node.get(from) {
            shape.insert(to.into(), value.clone());
        }
    }
    Value::Object(shape)
}

#[derive(Debug, Clone, PartialEq)]
enum BranchRequests {
    Overflow,
    Listed(Vec<Value>),
}

fn answer_ttl(requests: &BranchRequests) -> i64 {
    match requests {
        BranchRequests::Overflow => 0,
        BranchRequests::Listed(list) if list.is_empty() => BATCH_NONE_MS,
        BranchRequests::Listed(list) => {
            if list.iter().any(|mr| {
                matches!(
                    mr.get("state").and_then(Value::as_str),
                    Some("opened" | "locked")
                )
            }) {
                BATCH_OPEN_MS
            } else {
                BATCH_SETTLED_MS
            }
        }
    }
}

type Ask = Arc<dyn Fn(String) -> BoxFuture<'static, Res<Value>> + Send + Sync>;
type Waiter = (String, String, oneshot::Sender<Res<BranchRequests>>);

#[derive(Default)]
struct BatchState {
    /// Branches asked about, by project path, with when (in the order
    /// first asked, as a JS Map keeps them).
    interest: Vec<(String, Vec<(String, i64)>)>,
    answers: HashMap<String, (i64, BranchRequests)>,
    waiting: Vec<Waiter>,
    timer: bool,
    ask: Option<Ask>,
}

/// A checkout's last few lookups for badges, shared by every browser.
#[derive(Default)]
struct SharedAnswers {
    answers: Vec<(String, i64, String, Value)>,
    in_flight: HashMap<String, Shared<BoxFuture<'static, Value>>>,
}

struct Fact {
    id: u64,
    until: i64,
    value: Shared<BoxFuture<'static, Res<ProcessOutput>>>,
}

/// The answers a card is served from: the MR cache (the core's own while
/// it owns `mr_cache`).
pub trait CardCache: Send + Sync {
    fn settings(&self) -> MrCacheSettings;
    fn get(
        &self,
        key: String,
        options: SwrOptions<Loaded, LoadError>,
    ) -> BoxFuture<'_, Result<Answer, LoadError>>;
}

impl CardCache for MrCache {
    fn settings(&self) -> MrCacheSettings {
        MrCache::settings(self)
    }

    fn get(
        &self,
        key: String,
        options: SwrOptions<Loaded, LoadError>,
    ) -> BoxFuture<'_, Result<Answer, LoadError>> {
        async move { MrCache::get(self, &key, &options).await }.boxed()
    }
}

/// The process's pull request lookups.
pub struct PullRequests {
    clock: SharedClock,
    gate: ForgeGate,
    owner: String,
    facts: Mutex<HashMap<String, Fact>>,
    next_fact: Mutex<u64>,
    batches: Mutex<HashMap<String, Arc<Mutex<BatchState>>>>,
    shared: Mutex<SharedAnswers>,
}

/// Where a lookup runs: the checkout and how its commands run.
#[derive(Clone)]
pub struct Checkout {
    pub git: GitContext,
    pub root: String,
}

impl Checkout {
    pub fn new(git: GitContext, root: impl Into<String>) -> Self {
        Self {
            git,
            root: root.into(),
        }
    }

    fn host(&self) -> Option<&str> {
        self.git.host()
    }

    /// The command line of `argv` in the checkout; `env`: with the prompt
    /// and colour switches the CLIs read.
    fn invocation(&self, argv: &[String], env: bool) -> Res<Invocation> {
        let words: Vec<String> = argv.iter().map(|word| shell_quote(word)).collect();
        let command = format!(
            "cd {} && {}{}",
            shell_quote(&self.root),
            if env {
                "GH_PROMPT_DISABLED=1 GIT_TERMINAL_PROMPT=0 NO_COLOR=1 "
            } else {
                ""
            },
            words.join(" ")
        );
        match self.host() {
            Some(host) => Ok(Invocation::ssh(host, &command, Some("git.pull_request"))),
            None => roamgate_git::shell::git_only_command(&command, None).map_err(Failure::Other),
        }
    }
}

/// A forge call's scope and kind, as the gate files it.
struct CallKind<'a> {
    host: &'a str,
    kind: &'a str,
    conditional: bool,
    include: bool,
    reuse_ms: Option<i64>,
}

/// One lookup's runner: its checkout, deadline and feature.
#[derive(Clone)]
struct Lookup {
    reader: Arc<PullRequests>,
    checkout: Checkout,
    deadline: i64,
    feature: &'static str,
}

const STATUS_MARK: char = '\u{1}';

impl Lookup {
    fn now(&self) -> i64 {
        self.reader.clock.now()
    }

    async fn run(&self, argv: Vec<String>, limit_ms: i64) -> Res<ProcessOutput> {
        let remaining = self.deadline - self.now();
        if remaining <= 0 {
            return Err(status_error(format!(
                "timed out before {}",
                describe_step(&argv)
            )));
        }
        let timeout = limit_ms.min(remaining);
        let invocation = self.checkout.invocation(&argv, true)?;
        match self
            .checkout
            .git
            .run(invocation, Duration::from_millis(timeout as u64))
            .await
        {
            Ok(ran) => Ok(ProcessOutput {
                code: ran.code,
                stdout: ran.stdout,
                stderr: ran.stderr,
            }),
            Err(error) => {
                let timed_out = error.0.to_lowercase().contains("timed out");
                Err(status_error(format!(
                    "{} {}",
                    describe_step(&argv),
                    if timed_out {
                        "timed out"
                    } else {
                        "could not run"
                    }
                )))
            }
        }
    }

    /// A network call to a forge: budgeted per host, shared, logged.
    async fn forge_call(
        &self,
        ask: CallKind<'_>,
        argv: Vec<String>,
        timeout_ms: i64,
    ) -> Res<ForgeOutput> {
        let CallKind {
            host,
            kind,
            conditional,
            include,
            reuse_ms,
        } = ask;
        let call = ForgeCall {
            checkout: Some(self.checkout.host().unwrap_or("").to_owned()),
            host: host.to_owned(),
            feature: self.feature.to_owned(),
            kind: kind.to_owned(),
            deadline: Some(self.deadline),
            include,
            conditional,
            reuse_ms,
        };
        let lookup = self.clone();
        let spawn: Spawn = Arc::new(move |argv: Vec<String>| {
            let lookup = lookup.clone();
            Box::pin(async move {
                lookup
                    .run(argv, timeout_ms)
                    .await
                    .map_err(|failure| match failure {
                        Failure::Status(message) => format!("{STATUS_MARK}{message}"),
                        Failure::Other(message) => message,
                    })
            })
        });
        let step = describe_step(&argv);
        match self
            .reader
            .gate
            .run(&self.reader.owner, call, argv, spawn)
            .await
        {
            Ok(output) => Ok(output),
            Err(GateError::Busy) => Err(status_error(format!(
                "{step} waited too long: {host} is busy or rate limited"
            ))),
            Err(GateError::Spawn(message)) => Err(match message.strip_prefix(STATUS_MARK) {
                Some(message) => Failure::Status(message.to_owned()),
                None => Failure::Other(message),
            }),
        }
    }

    /// `json`: a forge answer's JSON, or a failure naming the step.
    fn json(argv: &[String], output: ForgeOutput) -> Res<Value> {
        static HTTP: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\(HTTP (\d{3})\)").unwrap());
        let step = describe_step(argv);
        if output.code != 0 {
            // Only the HTTP status is taken from the CLI's diagnostics.
            let status = match output.status {
                Some(status) if status >= 400 => Some(status.to_string()),
                _ => HTTP
                    .captures(&output.stderr)
                    .map(|captures| captures[1].to_owned()),
            };
            return Err(status_error(match status {
                Some(status) => format!("{step} returned HTTP {status}"),
                None => format!("{step} failed with exit code {}", output.code),
            }));
        }
        serde_json::from_str(&output.stdout)
            .map_err(|_| status_error(format!("{step} returned invalid JSON")))
    }

    /// `rememberLocal`: an answer of this connection's CLIs, kept.
    fn remember(
        &self,
        key: String,
        load: BoxFuture<'static, Res<ProcessOutput>>,
    ) -> Shared<BoxFuture<'static, Res<ProcessOutput>>> {
        let reader = self.reader.clone();
        let now = reader.clock.now();
        let mut facts = reader.facts.lock().unwrap();
        if let Some(known) = facts.get(&key)
            && known.until > now
        {
            return known.value.clone();
        }
        let id = {
            let mut next = reader.next_fact.lock().unwrap();
            *next += 1;
            *next
        };
        let handle = tokio::spawn(load);
        let value: Shared<BoxFuture<'static, Res<ProcessOutput>>> = async move {
            handle
                .await
                .unwrap_or_else(|error| Err(Failure::Other(error.to_string())))
        }
        .boxed()
        .shared();
        facts.insert(
            key.clone(),
            Fact {
                id,
                until: i64::MAX,
                value: value.clone(),
            },
        );
        drop(facts);
        let settle = value.clone();
        let owner = reader.clone();
        tokio::spawn(async move {
            let result = settle.await;
            let mut facts = owner.facts.lock().unwrap();
            if facts.get(&key).is_none_or(|fact| fact.id != id) {
                return;
            }
            match result {
                // A missing CLI may be installed any time; a present one
                // stays, and one that ran out of time would only hang
                // again soon.
                Ok(output) => {
                    let reuse = if output.code == 0 || output.code == TIMED_OUT {
                        HOSTS_REUSE_MS
                    } else {
                        60_000
                    };
                    if let Some(fact) = facts.get_mut(&key) {
                        fact.until = owner.clock.now() + reuse;
                    }
                }
                Err(_) => {
                    facts.remove(&key);
                }
            }
        });
        value
    }
}

/// A listing that ran out of time answers [`TIMED_OUT`], remembered as
/// long as an answer: the hosts are then unknown.
async fn bounded(
    read: impl std::future::Future<Output = Res<ProcessOutput>>,
) -> Res<ProcessOutput> {
    match read.await {
        Err(Failure::Status(message)) if message.ends_with("timed out") => Ok(ProcessOutput {
            code: TIMED_OUT,
            stdout: String::new(),
            stderr: String::new(),
        }),
        other => other,
    }
}

#[derive(Debug, Clone)]
struct Listing {
    hosts: Option<BTreeSet<String>>,
    error: Option<String>,
}

impl Listing {
    fn of(result: Res<BTreeSet<String>>) -> Self {
        match result {
            Ok(hosts) => Self {
                hosts: Some(hosts),
                error: None,
            },
            Err(failure) => Self {
                hosts: None,
                error: Some(match failure {
                    Failure::Status(message) => message,
                    Failure::Other(_) => "it could not run".into(),
                }),
            },
        }
    }

    fn has(&self, host: &str) -> bool {
        self.hosts
            .as_ref()
            .is_some_and(|hosts| hosts.contains(host))
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum ForgeOf {
    Found {
        provider: &'static str,
        api_host: String,
    },
    Ambiguous,
    None,
}

/// The CLIs' hosts, asked at most once in a lookup.
struct Hosts {
    lookup: Lookup,
    gh: OnceCell<Listing>,
    glab: OnceCell<Listing>,
    logins: Mutex<HashMap<String, Shared<BoxFuture<'static, bool>>>>,
}

impl Hosts {
    async fn gh_hosts(&self) -> Listing {
        self.gh
            .get_or_init(|| async {
                let argv = words(&[
                    "gh",
                    "auth",
                    "status",
                    "--json",
                    "hosts",
                    "--jq",
                    ".hosts | keys[]",
                ]);
                Listing::of(
                    self.lookup
                        .forge_call(
                            CallKind {
                                host: "*",
                                kind: "auth-hosts",
                                conditional: false,
                                include: false,
                                reuse_ms: Some(HOSTS_REUSE_MS),
                            },
                            argv,
                            15_000,
                        )
                        .await
                        .map(|output| host_lines(&output.stdout)),
                )
            })
            .await
            .clone()
    }

    /// `glab auth status` calls every configured instance's API, which can
    /// take longer than a request may wait, so glab's own configuration is
    /// asked first, without a network call.
    async fn glab_login(&self, host: &str) -> bool {
        let login = {
            let mut logins = self.logins.lock().unwrap();
            logins
                .entry(host.to_owned())
                .or_insert_with(|| {
                    // A token from the environment (or one for no host in
                    // particular, which a made-up host gets) is not a
                    // login for this host. Only the host is printed,
                    // never the token.
                    let script = "token() { (unset GITLAB_TOKEN GITLAB_ACCESS_TOKEN OAUTH_TOKEN; GLAB_NO_PROMPT=1 glab config get token --host \"$1\" 2>/dev/null); }; t=$(token \"$1\"); [ -n \"$t\" ] && [ \"$t\" != \"$(token roamgate.invalid)\" ] && printf '%s\\n' \"$1\"; exit 0";
                    let lookup = self.lookup.clone();
                    let argv = words(&["sh", "-c", script, "sh", host]);
                    let checkout = lookup.checkout.host().unwrap_or("").to_owned();
                    let remembered = lookup.remember(
                        format!("{checkout}\nglab-login\n{host}"),
                        {
                            let lookup = lookup.clone();
                            async move { bounded(lookup.run(argv, HOSTS_TIMEOUT_MS)).await }.boxed()
                        },
                    );
                    let host = host.to_owned();
                    async move {
                        matches!(remembered.await, Ok(output) if output.code == 0 && output.stdout.trim() == host)
                    }
                    .boxed()
                    .shared()
                })
                .clone()
        };
        login.await
    }

    /// Asked once per connection, not per checkout, within
    /// HOSTS_TIMEOUT_MS (a keyring can keep it waiting forever), and an
    /// answer that ran out of time is not asked again for HOSTS_REUSE_MS.
    async fn glab_hosts(&self) -> Listing {
        self.glab
            .get_or_init(|| async {
                let lookup = self.lookup.clone();
                let checkout = lookup.checkout.host().unwrap_or("").to_owned();
                let load = {
                    let lookup = lookup.clone();
                    async move {
                        bounded(async {
                            let status = |argv: Vec<String>| {
                                lookup.forge_call(
                                    CallKind {
                                        host: "*",
                                        kind: "auth-hosts",
                                        conditional: false,
                                        include: false,
                                        reuse_ms: Some(HOSTS_REUSE_MS),
                                    },
                                    argv,
                                    HOSTS_TIMEOUT_MS,
                                )
                            };
                            let all = status(words(&["glab", "auth", "status", "--all"])).await?;
                            // Older glab (1.67, for one) has no --all and
                            // lists every host without it.
                            static UNKNOWN: LazyLock<Regex> = LazyLock::new(|| {
                                Regex::new(r"(?i)unknown flag:? '?--all").unwrap()
                            });
                            let output = if all.code != 0
                                && UNKNOWN.is_match(&format!("{}\n{}", all.stdout, all.stderr))
                            {
                                status(words(&["glab", "auth", "status"])).await?
                            } else {
                                all
                            };
                            Ok(ProcessOutput {
                                code: output.code,
                                stdout: output.stdout,
                                stderr: output.stderr,
                            })
                        })
                        .await
                    }
                    .boxed()
                };
                let result = lookup
                    .remember(format!("{checkout}\nglab-hosts"), load)
                    .await
                    .and_then(|output| {
                        if output.code == TIMED_OUT {
                            Err(status_error("glab auth status timed out"))
                        } else {
                            Ok(host_lines(&format!("{}\n{}", output.stdout, output.stderr)))
                        }
                    });
                Listing::of(result)
            })
            .await
            .clone()
    }

    /// GitLab instances often serve SSH on ssh.<host>; such a remote uses
    /// the API of <host> when that one is a known or configured instance.
    async fn forge_for(&self, host: &str) -> Res<ForgeOf> {
        let hosts: Vec<String> = match host.strip_prefix("ssh.") {
            Some(rest) => vec![host.to_owned(), rest.to_owned()],
            None => vec![host.to_owned()],
        };
        for api_host in &hosts {
            if api_host == "github.com" {
                return Ok(ForgeOf::Found {
                    provider: "github",
                    api_host: api_host.clone(),
                });
            }
            if api_host == "gitlab.com" {
                return Ok(ForgeOf::Found {
                    provider: "gitlab",
                    api_host: api_host.clone(),
                });
            }
        }
        let gh = self.gh_hosts().await;
        for api_host in &hosts {
            let github = gh.has(api_host);
            let gitlab = self.glab_login(api_host).await;
            if let Some(found) = choose(github, gitlab, api_host) {
                return Ok(found);
            }
        }
        let glab = self.glab_hosts().await;
        for api_host in &hosts {
            if let Some(found) = choose(gh.has(api_host), glab.has(api_host), api_host) {
                return Ok(found);
            }
        }
        if let Some(failure) = gh.error.or(glab.error) {
            return Err(status_error(format!(
                "could not list the hosts configured in gh and glab for {host}: {failure}"
            )));
        }
        Ok(ForgeOf::None)
    }
}

fn choose(github: bool, gitlab: bool, api_host: &str) -> Option<ForgeOf> {
    match (github, gitlab) {
        (true, true) => Some(ForgeOf::Ambiguous),
        (true, false) => Some(ForgeOf::Found {
            provider: "github",
            api_host: api_host.to_owned(),
        }),
        (false, true) => Some(ForgeOf::Found {
            provider: "gitlab",
            api_host: api_host.to_owned(),
        }),
        (false, false) => None,
    }
}

fn words(list: &[&str]) -> Vec<String> {
    list.iter().map(|word| (*word).to_owned()).collect()
}

/// `encodeURIComponent`.
fn encode_component(value: &str) -> String {
    let mut out = String::new();
    for byte in value.bytes() {
        if byte.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&byte) {
            out.push(byte as char);
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

/// `new URLSearchParams(pairs).toString()`.
fn search_params(pairs: &[(&str, &str)]) -> String {
    url::form_urlencoded::Serializer::new(String::new())
        .extend_pairs(pairs)
        .finish()
}

fn valid_path(path: &str) -> bool {
    static PATH: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"^[A-Za-z0-9_.-]+(?:/[A-Za-z0-9_.-]+)+$").unwrap());
    PATH.is_match(path) && !path.split('/').any(|part| part == "." || part == "..")
}

/// `Date.parse` of a provider's ISO time; NaN as None.
fn parse_time(value: Option<&Value>) -> Option<i64> {
    let text = text(value, "");
    roamgate_base::log::parse_iso_millis(&text).or_else(|| {
        // A date alone is UTC midnight.
        let date = jiff_date(&text)?;
        Some(date)
    })
}

fn jiff_date(text: &str) -> Option<i64> {
    static DATE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^\d{4}-\d{2}-\d{2}$").unwrap());
    DATE.is_match(text)
        .then(|| roamgate_base::log::parse_iso_millis(&format!("{text}T00:00:00Z")))
        .flatten()
}

fn truthy(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) => false,
        Some(Value::Bool(flag)) => *flag,
        Some(Value::Number(number)) => number.as_f64().is_some_and(|n| n != 0.0 && !n.is_nan()),
        Some(Value::String(text)) => !text.is_empty(),
        Some(_) => true,
    }
}

fn get<'a>(value: &'a Value, path: &[&str]) -> Option<&'a Value> {
    let mut at = value;
    for key in path {
        at = at.get(*key)?;
    }
    Some(at)
}

/// The JS `a !== b` of a provider field against a number.
fn same_number(value: Option<&Value>, number: i64) -> bool {
    value
        .and_then(Value::as_f64)
        .is_some_and(|value| value == number as f64)
}

impl PullRequests {
    pub fn new(clock: SharedClock, gate: ForgeGate) -> Arc<Self> {
        Arc::new(Self {
            clock,
            gate,
            owner: GATE_OWNER.to_owned(),
            facts: Mutex::default(),
            next_fact: Mutex::new(0),
            batches: Mutex::default(),
            shared: Mutex::default(),
        })
    }

    pub fn gate(&self) -> &ForgeGate {
        &self.gate
    }

    pub fn clock(&self) -> &SharedClock {
        &self.clock
    }

    /// Where HEAD is, as one cheap command: its ref and commit.
    async fn read_head(&self, checkout: &Checkout) -> Option<String> {
        let argv = words(&["git", "rev-parse", "--symbolic-full-name", "HEAD", "HEAD"]);
        let invocation = checkout.invocation(&argv, false).ok()?;
        match checkout
            .git
            .run(invocation, Duration::from_millis(15_000))
            .await
        {
            Ok(ran) if ran.code == 0 => Some(ran.stdout.trim().to_owned()),
            _ => None,
        }
    }

    /// `sharedPullRequestStatus`: a checkout's pull or merge request
    /// status, shared by every browser asking: identical lookups in flight
    /// are one, and a badge's answer is reused for [`SHARED_SUMMARY_MS`]
    /// while HEAD is on the same ref and commit. A card's lookup (not a
    /// summary) is served from `cache`, and replaces what the badges of
    /// that checkout knew when it is read.
    pub async fn shared_status(
        self: &Arc<Self>,
        checkout: &Checkout,
        params: &Map<String, Value>,
        cache: &dyn CardCache,
    ) -> Result<Value, String> {
        let place = Value::from(vec![
            Value::String(checkout.host().unwrap_or("").to_owned()),
            Value::String(checkout.root.clone()),
        ])
        .to_string();
        let mut asked: Vec<(&String, &Value)> = params
            .iter()
            .filter(|(name, _)| {
                !matches!(name.as_str(), "workspace_id" | "worktree_path" | "refresh")
            })
            .collect();
        asked.sort_by(|a, b| a.0.cmp(b.0));
        let asked = Value::Array(
            asked
                .into_iter()
                .map(|(name, value)| json!([name, value]))
                .collect(),
        );
        let key = format!("{place}\0{asked}");
        if params.get("summary") != Some(&Value::Bool(true)) {
            return self
                .card_status(checkout, params, cache, &place, &key)
                .await;
        }
        let task = {
            let mut shared = self.shared.lock().unwrap();
            if let Some(flying) = shared.in_flight.get(&key) {
                flying.clone()
            } else {
                let reader = self.clone();
                let checkout = checkout.clone();
                let params = params.clone();
                let task_key = key.clone();
                let handle = tokio::spawn(async move {
                    let status = reader.badge(&checkout, &params, &task_key).await;
                    reader.shared.lock().unwrap().in_flight.remove(&task_key);
                    status
                });
                let task = async move { handle.await.unwrap_or(Value::Null) }
                    .boxed()
                    .shared();
                shared.in_flight.insert(key.clone(), task.clone());
                task
            }
        };
        Ok(task.await)
    }

    async fn badge(
        self: &Arc<Self>,
        checkout: &Checkout,
        params: &Map<String, Value>,
        key: &str,
    ) -> Value {
        let known = self
            .shared
            .lock()
            .unwrap()
            .answers
            .iter()
            .find(|(each, ..)| each == key)
            .cloned();
        let fresh = known
            .as_ref()
            .is_some_and(|(_, at, ..)| self.clock.now() - at < SHARED_SUMMARY_MS);
        // Read before the lookup: a HEAD that moves during it misses next
        // time.
        let head = self.read_head(checkout).await;
        if fresh
            && let (Some(head), Some((_, _, known_head, status))) = (&head, &known)
            && head == known_head
        {
            return status.clone();
        }
        let status = self.read_status(checkout, params).await;
        let mut shared = self.shared.lock().unwrap();
        shared.answers.retain(|(each, ..)| each != key);
        let failed = status.get("state").and_then(Value::as_str) == Some("error")
            || status.get("retryable") == Some(&Value::Bool(true));
        if let Some(head) = head
            && !failed
        {
            let now = self.clock.now();
            shared
                .answers
                .push((key.to_owned(), now, head, status.clone()));
            if shared.answers.len() > 500 {
                shared
                    .answers
                    .retain(|(_, at, ..)| now - at < SHARED_SUMMARY_MS);
            }
        }
        status
    }

    /// A card's status: the known answer at once (marked stale when it is
    /// older than its state allows, and then read again in the background,
    /// the clients told when it changes), read before answering only when
    /// nothing is known, HEAD is on another branch, or `refresh` asks.
    async fn card_status(
        self: &Arc<Self>,
        checkout: &Checkout,
        params: &Map<String, Value>,
        cache: &dyn CardCache,
        place: &str,
        key: &str,
    ) -> Result<Value, String> {
        let settings = cache.settings();
        let head: HeadFn = {
            let reader = self.clone();
            let checkout = checkout.clone();
            Arc::new(move || {
                let reader = reader.clone();
                let checkout = checkout.clone();
                Box::pin(async move { reader.read_head(&checkout).await })
            })
        };
        let load = {
            let reader = self.clone();
            let checkout = checkout.clone();
            let params = params.clone();
            let place = place.to_owned();
            Arc::new(move || {
                let reader = reader.clone();
                let checkout = checkout.clone();
                let params = params.clone();
                let place = place.clone();
                Box::pin(async move {
                    let status = reader.read_status(&checkout, &params).await;
                    // The badges of this checkout learn what the card just
                    // read.
                    let prefix = format!("{place}\0");
                    reader
                        .shared
                        .lock()
                        .unwrap()
                        .answers
                        .retain(|(each, ..)| !each.starts_with(&prefix));
                    let failed = status.get("state").and_then(Value::as_str) == Some("error")
                        || status.get("retryable") == Some(&Value::Bool(true));
                    let ttl_ms = card_answer_ttl(&status, &settings);
                    Ok(Loaded {
                        value: status,
                        ttl_ms,
                        failed,
                        paused_until: None,
                    })
                }) as roamgate_base::clock::BoxFuture<Result<Loaded, LoadError>>
            })
        };
        let paused = {
            let gate = self.gate.clone();
            let owner = self.owner.clone();
            let checkout_host = checkout.host().unwrap_or("").to_owned();
            Arc::new(move |loaded: Option<&Loaded>| {
                let Some(url) = loaded
                    .and_then(|loaded| get(&loaded.value, &["request", "url"]))
                    .and_then(Value::as_str)
                else {
                    return 0;
                };
                let Ok(url) = url::Url::parse(url) else {
                    return 0;
                };
                let host = match (url.host_str(), url.port()) {
                    (Some(name), Some(port)) => format!("{name}:{port}"),
                    (Some(name), None) => name.to_owned(),
                    _ => return 0,
                };
                gate.paused_until(&owner, &checkout_host, &host)
            })
        };
        let options = SwrOptions {
            ttl: Arc::new(move |loaded: &Loaded| card_answer_ttl(&loaded.value, &settings)),
            load,
            fresh: params.get("refresh") == Some(&Value::Bool(true)),
            failed: Some(Arc::new(|loaded: &Loaded| loaded.failed)),
            paused_until: Some(paused),
            head: Some(head),
        };
        match cache.get(format!("card\0{key}"), options).await {
            Ok(answer) => {
                let mut value = match answer.value.value {
                    Value::Object(map) => map,
                    _ => Map::new(),
                };
                value.insert(
                    "cached".into(),
                    json!({ "fetchedAt": iso_time(answer.fetched_at), "stale": answer.stale }),
                );
                Ok(Value::Object(value))
            }
            Err(error) => Err(error.message),
        }
    }

    /// The merge requests of a branch in a project, from one GraphQL query
    /// per forge host for every branch asked about together (and those
    /// asked lately), remembered for as long as what they say can wait.
    async fn branch_requests(
        self: &Arc<Self>,
        key: String,
        project: String,
        branch: String,
        ask: Ask,
    ) -> Res<BranchRequests> {
        let batch = self.batches.lock().unwrap().entry(key).or_default().clone();
        let now = self.clock.now();
        let receiver = {
            let mut state = batch.lock().unwrap();
            let index = match state.interest.iter().position(|(each, _)| *each == project) {
                Some(index) => index,
                None => {
                    state.interest.push((project.clone(), Vec::new()));
                    state.interest.len() - 1
                }
            };
            let asked = &mut state.interest[index].1;
            match asked.iter_mut().find(|(each, _)| *each == branch) {
                Some(entry) => entry.1 = now,
                None => asked.push((branch.clone(), now)),
            }
            if let Some((until, requests)) = state.answers.get(&format!("{project}\0{branch}"))
                && *until > now
            {
                return Ok(requests.clone());
            }
            state.ask = Some(ask);
            let (sender, receiver) = oneshot::channel();
            state.waiting.push((project, branch, sender));
            if !state.timer {
                state.timer = true;
                let reader = self.clone();
                let batch = batch.clone();
                tokio::spawn(async move {
                    reader
                        .clock
                        .sleep(Duration::from_millis(BATCH_WINDOW_MS as u64))
                        .await;
                    reader.flush_batch(&batch).await;
                });
            }
            receiver
        };
        receiver
            .await
            .unwrap_or_else(|_| Err(Failure::Other("the batch was dropped".into())))
    }

    async fn flush_batch(&self, batch: &Arc<Mutex<BatchState>>) {
        let (waiting, ask, list) = {
            let mut state = batch.lock().unwrap();
            state.timer = false;
            let waiting: Vec<Waiter> = std::mem::take(&mut state.waiting);
            if waiting.is_empty() {
                return;
            }
            let at = self.clock.now();
            let mut projects: Vec<(String, Vec<String>)> = Vec::new();
            for (project, branch, _) in &waiting {
                match projects.iter_mut().find(|(each, _)| each == project) {
                    Some((_, branches)) => {
                        if !branches.contains(branch) {
                            branches.push(branch.clone());
                        }
                    }
                    None => projects.push((project.clone(), vec![branch.clone()])),
                }
            }
            // The other branches asked about lately ride along for free.
            for (project, branches) in &mut projects {
                let Some((_, asked)) = state.interest.iter_mut().find(|(each, _)| each == project)
                else {
                    continue;
                };
                let mut sorted = asked.clone();
                sorted.sort_by_key(|entry| std::cmp::Reverse(entry.1));
                for (branch, when) in sorted {
                    if when <= at - INTEREST_MS {
                        asked.retain(|(each, _)| *each != branch);
                    } else if branches.len() < BATCH_BRANCHES && !branches.contains(&branch) {
                        branches.push(branch);
                    }
                }
            }
            (waiting, state.ask.clone(), projects)
        };
        let Some(ask) = ask else { return };
        let answer = ask(gitlab_branches_query(&list)).await;
        let result: Res<()> = (|| {
            let answer = answer?;
            let data = answer
                .get("data")
                .filter(|data| data.is_object() || data.is_array())
                .ok_or_else(|| status_error("GitLab GraphQL returned no data"))?;
            let done = self.clock.now();
            let mut state = batch.lock().unwrap();
            for (index, (project, branches)) in list.iter().enumerate() {
                let Some(found) = get(data, &[&format!("p{index}"), "mergeRequests"]) else {
                    continue;
                };
                let Some(nodes) = found.get("nodes").and_then(Value::as_array) else {
                    continue;
                };
                let overflow = get(found, &["pageInfo", "hasNextPage"]) == Some(&Value::Bool(true));
                for branch in branches {
                    let requests = if overflow {
                        BranchRequests::Overflow
                    } else {
                        BranchRequests::Listed(
                            nodes
                                .iter()
                                .filter(|node| {
                                    node.get("sourceBranch").and_then(Value::as_str)
                                        == Some(branch.as_str())
                                })
                                .map(rest_shape)
                                .collect(),
                        )
                    };
                    let until = done + answer_ttl(&requests);
                    state
                        .answers
                        .insert(format!("{project}\0{branch}"), (until, requests));
                }
            }
            Ok(())
        })();
        let mut state = batch.lock().unwrap();
        for (project, branch, sender) in waiting {
            let _ = sender.send(match &result {
                Ok(()) => match state.answers.get(&format!("{project}\0{branch}")) {
                    Some((_, requests)) => Ok(requests.clone()),
                    None => Err(status_error("GitLab GraphQL had no such project")),
                },
                Err(failure) => Err(failure.clone()),
            });
        }
        // Old answers go; the map stays small.
        if state.answers.len() > 500 {
            let now = self.clock.now();
            state.answers.retain(|_, (until, _)| *until > now);
        }
    }

    /// `readPullRequestStatus`: the lookup itself.
    pub async fn read_status(
        self: &Arc<Self>,
        checkout: &Checkout,
        params: &Map<String, Value>,
    ) -> Value {
        let mut result = Map::new();
        result.insert("state".into(), json!("error"));
        result.insert("root".into(), json!(checkout.root));
        result.insert("branch".into(), json!(""));
        result.insert("remotes".into(), json!([]));
        result.insert("refreshedAt".into(), json!(iso_time(self.clock.now())));
        let summary = params.get("summary") == Some(&Value::Bool(true));
        let lookup = Lookup {
            reader: self.clone(),
            checkout: checkout.clone(),
            deadline: self.clock.now() + 55_000,
            feature: if summary { "badge" } else { "card" },
        };
        match self.lookup(&lookup, params, &mut result).await {
            Ok(Done::Finish(state, message)) => self.finish(&result, state, message, false),
            Ok(Done::Retryable(state, message)) => self.finish(&result, state, message, true),
            Err(failure) => {
                result.shift_remove("request");
                // Branch-change guards are authoritative; only this
                // catch-all failure may be retried while the browser keeps
                // its last-known status. Only messages written here are
                // shown; other errors may quote output.
                let reason = match failure {
                    Failure::Status(message) => format!(": {message}"),
                    Failure::Other(_) => String::new(),
                };
                self.finish(
                    &result,
                    "error",
                    Some(format!("Could not read PR/MR status{reason}. Check repository access, CLI version and network connectivity on the checkout host, then refresh.")),
                    true,
                )
            }
        }
    }

    fn finish(
        &self,
        result: &Map<String, Value>,
        state: &str,
        message: Option<String>,
        retryable: bool,
    ) -> Value {
        let mut out = result.clone();
        out.insert("state".into(), json!(state));
        if let Some(message) = message {
            out.insert("message".into(), json!(message));
        } else {
            out.shift_remove("message");
        }
        out.insert("refreshedAt".into(), json!(iso_time(self.clock.now())));
        if retryable {
            out.insert("retryable".into(), json!(true));
        }
        Value::Object(out)
    }

    async fn lookup(
        self: &Arc<Self>,
        lookup: &Lookup,
        params: &Map<String, Value>,
        result: &mut Map<String, Value>,
    ) -> Res<Done> {
        let summary = params.get("summary") == Some(&Value::Bool(true));
        let Some(branch) = read_branch(lookup).await? else {
            return Ok(Done::finish(
                "detached",
                "Detached HEAD has no branch to resolve.",
            ));
        };
        result.insert("branch".into(), json!(branch.name));
        if branch.rebasing {
            result.insert("rebasing".into(), json!(true));
        }
        let name = branch.name.clone();
        // Workspace status reports any detached HEAD as the "detached"
        // sentinel.
        if let Some(asked) = params.get("branch")
            && truthy(Some(asked))
            && asked.as_str() != Some(name.as_str())
            && !(branch.rebasing && asked.as_str() == Some("detached"))
        {
            return Ok(Done::finish(
                "error",
                "The branch changed. Refresh workspace status and try again.",
            ));
        }
        let remotes_out = lookup.run(words(&["git", "remote", "-v"]), 15_000).await?;
        if remotes_out.code != 0 {
            return Err(status_error("git remote -v failed"));
        }
        static REMOTE: LazyLock<Regex> =
            LazyLock::new(|| Regex::new(r"^(\S+)\s+(.+)\s+\(fetch\)$").unwrap());
        let mut remotes: Vec<ReviewRemote> = Vec::new();
        for line in remotes_out.stdout.split('\n') {
            let line = line.strip_suffix('\r').unwrap_or(line);
            let Some(captures) = REMOTE.captures(line) else {
                continue;
            };
            if let Some(remote) = parse_review_remote(&captures[1], &captures[2]) {
                remotes.push(remote);
            }
        }
        result.insert(
            "remotes".into(),
            Value::Array(remotes.iter().map(ReviewRemote::to_json).collect()),
        );
        if remotes.is_empty() {
            return Ok(Done::finish(
                "unsupported",
                "No supported network remote found.",
            ));
        }
        let named = |name: Option<&str>| -> Option<ReviewRemote> {
            let name = name?;
            remotes.iter().find(|remote| remote.name == name).cloned()
        };
        let hosts = Hosts {
            lookup: lookup.clone(),
            gh: OnceCell::new(),
            glab: OnceCell::new(),
            logins: Mutex::default(),
        };

        let branch_ref = format!("refs/heads/{name}");
        let (refs, config) = tokio::join!(
            lookup.run(
                vec![
                    "git".into(),
                    "for-each-ref".into(),
                    "--format=%(refname)%00%(upstream:remotename)%00%(upstream:remoteref)%00%(symref)".into(),
                    branch_ref.clone(),
                    format!("refs/remotes/*/{name}"),
                    "refs/remotes/*/HEAD".into(),
                ],
                15_000
            ),
            lookup.run(
                words(&[
                    "git",
                    "config",
                    "--get-regexp",
                    "^(branch\\..*\\.pushremote|remote\\.pushdefault)$",
                ]),
                15_000
            ),
        );
        let refs = refs?;
        let config = config?;
        if refs.code != 0 {
            return Err(status_error("git for-each-ref failed"));
        }
        // 1: none of these keys is set.
        if config.code != 0 && config.code != 1 {
            return Err(status_error("git config --get-regexp failed"));
        }
        let mut upstream: Option<(String, String)> = None;
        let mut pushed: Vec<ReviewRemote> = Vec::new();
        let mut remote_heads: HashMap<String, String> = HashMap::new();
        for line in refs.stdout.split('\n') {
            let line = line.strip_suffix('\r').unwrap_or(line);
            let mut fields = line.split('\0');
            let reference = fields.next().unwrap_or("");
            let upstream_remote = fields.next().unwrap_or("");
            let upstream_ref = fields.next().unwrap_or("");
            let symref = fields.next().unwrap_or("");
            if reference == branch_ref {
                upstream = Some((upstream_remote.to_owned(), upstream_ref.to_owned()));
                continue;
            }
            for remote in &remotes {
                let prefix = format!("refs/remotes/{}/", remote.name);
                if reference == format!("{prefix}{name}") {
                    pushed.push(remote.clone());
                } else if reference == format!("{prefix}HEAD") && symref.starts_with(&prefix) {
                    remote_heads.insert(remote.name.clone(), symref[prefix.len()..].to_owned());
                }
            }
        }
        let mut settings: HashMap<String, String> = HashMap::new();
        for line in config.stdout.split('\n') {
            let line = line.strip_suffix('\r').unwrap_or(line);
            if let Some(space) = line.find(' ')
                && space > 0
            {
                settings.insert(line[..space].to_owned(), line[space + 1..].to_owned());
            }
        }
        let tracked = named(upstream.as_ref().map(|(remote, _)| remote.as_str()));

        // The source is where the branch is pushed, chosen as `git push`
        // does: its push remote, then the default push remote, then a
        // remote that has the branch, then the remote it tracks. A fork
        // workflow tracks the upstream's main and pushes to a personal fork.
        let mut selected: Option<ReviewRemote>;
        if let Some(Value::String(remote)) = params.get("remote") {
            selected = named(Some(remote));
        } else {
            selected = named(
                settings
                    .get(&format!("branch.{name}.pushremote"))
                    .map(String::as_str),
            )
            .or_else(|| named(settings.get("remote.pushdefault").map(String::as_str)));
            if selected.is_none() && !pushed.is_empty() {
                let mut usable = Vec::new();
                for remote in &pushed {
                    if let Ok(ForgeOf::Found { .. }) = hosts.forge_for(&remote.host).await {
                        usable.push(remote.clone());
                    }
                }
                let candidates = if usable.is_empty() {
                    pushed.clone()
                } else {
                    usable
                };
                selected = if candidates.len() == 1 {
                    Some(candidates[0].clone())
                } else {
                    candidates
                        .iter()
                        .find(|remote| Some(*remote) == tracked.as_ref())
                        .or_else(|| candidates.iter().find(|remote| remote.name == "origin"))
                        .cloned()
                };
                if selected.is_none() {
                    return Ok(Done::finish(
                        "select_remote",
                        "Several remotes have this branch. Select the source repository remote.",
                    ));
                }
            }
            if selected.is_none() {
                selected = tracked
                    .clone()
                    .or_else(|| named(Some("origin")))
                    .or_else(|| (remotes.len() == 1).then(|| remotes[0].clone()));
            }
        }
        let Some(selected) = selected else {
            return Ok(Done::finish(
                "select_remote",
                "Select the source repository remote to resolve this branch.",
            ));
        };
        result.insert("remote".into(), json!(selected.name));
        // A checkout may use a local alias (e.g. pr-299). Only the source
        // remote's upstream names the provider-side branch, and not when it
        // is the default branch the local one was started from.
        let upstream_branch = match (&tracked, &upstream) {
            (Some(tracked), Some((_, reference))) if *tracked == selected => reference
                .strip_prefix("refs/heads/")
                .filter(|branch| !branch.is_empty())
                .map(str::to_owned),
            _ => None,
        };
        let source_branch = match upstream_branch {
            Some(upstream)
                if upstream == name
                    || !(upstream == "main"
                        || upstream == "master"
                        || remote_heads.get(&selected.name) == Some(&upstream)) =>
            {
                upstream
            }
            _ => name.clone(),
        };
        let forge = hosts.forge_for(&selected.host).await?;
        let (provider, api_host) = match forge {
            ForgeOf::Ambiguous => {
                return Ok(Done::finish(
                    "unsupported",
                    "This host is configured in both gh and glab; provider is ambiguous.",
                ));
            }
            ForgeOf::None => {
                return Ok(Done::Retryable(
                    "unsupported",
                    Some(format!(
                        "Unsupported or unconfigured host {}. Configure this instance in gh or glab on the checkout host.",
                        selected.host
                    )),
                ));
            }
            ForgeOf::Found { provider, api_host } => (provider, api_host),
        };
        result.insert("provider".into(), json!(provider));
        // The tracked remote's project is a target too, when it is on the
        // same instance: a fork's requests usually go there.
        let mut tracked_target: Option<String> = None;
        if let Some(tracked) = &tracked
            && *tracked != selected
            && let Ok(ForgeOf::Found {
                provider: target_provider,
                api_host: target_host,
            }) = hosts.forge_for(&tracked.host).await
            && target_provider == provider
            && target_host == api_host
        {
            tracked_target = Some(tracked.repository.clone());
        }
        let cli = if provider == "github" { "gh" } else { "glab" };
        let place = lookup.checkout.host().unwrap_or("").to_owned();
        let version = lookup
            .remember(format!("{place}\nversion\n{cli}"), {
                let lookup = lookup.clone();
                let argv = words(&[cli, "--version"]);
                async move { lookup.run(argv, 15_000).await }.boxed()
            })
            .await?;
        if version.code == 127 {
            return Ok(Done::finish(
                "missing_cli",
                &format!("Install {cli} on the checkout host."),
            ));
        }
        if version.code != 0 {
            return Err(status_error(format!(
                "{cli} --version failed with exit code {}",
                version.code
            )));
        }
        let mut auth_argv = words(&[cli, "auth", "status", "--hostname", &api_host]);
        if provider == "github" {
            auth_argv.push("--active".into());
        }
        let auth = lookup
            .forge_call(
                CallKind {
                    host: &api_host,
                    kind: "auth",
                    conditional: false,
                    include: false,
                    reuse_ms: Some(HOSTS_REUSE_MS),
                },
                auth_argv,
                15_000,
            )
            .await?;
        if auth.code != 0 {
            return Ok(Done::finish(
                "unauthenticated",
                &format!(
                    "{cli} authentication is unavailable or could not be verified for {api_host}. Check it on the checkout host."
                ),
            ));
        }
        let api_argv =
            |path: &str| words(&[cli, "api", "--hostname", &api_host, "--method", "GET", path]);
        let api = |path: String, kind: &'static str, reuse_ms: Option<i64>| {
            let argv = api_argv(&path);
            let lookup = lookup.clone();
            let host = api_host.clone();
            async move {
                let output = lookup
                    .forge_call(
                        CallKind {
                            host: &host,
                            kind,
                            conditional: true,
                            include: false,
                            reuse_ms,
                        },
                        argv.clone(),
                        15_000,
                    )
                    .await?;
                Lookup::json(&argv, output)
            }
        };
        let api_list = |path: String| {
            let step = describe_step(&api_argv(&path));
            let answer = api(path, "request-list", summary.then_some(LIST_REUSE_MS));
            async move { list(answer.await?, &step) }
        };
        let mut matches: Vec<Value> = Vec::new();
        let mut created_at: HashMap<String, Option<i64>> = HashMap::new();
        let push_match = |matches: &mut Vec<Value>, entry: Value| {
            let id = entry["id"].clone();
            match matches.iter_mut().find(|each| each["id"] == id) {
                Some(slot) => *slot = entry,
                None => matches.push(entry),
            }
        };
        if provider == "github" {
            let repo_answer = api(
                format!("repos/{}", selected.repository),
                "project",
                Some(PROJECT_REUSE_MS),
            )
            .await?;
            let repo = object(&repo_answer)?;
            // GitHub redirects renamed/transferred repositories; compare
            // canonical identity rather than the old name still present in
            // the Git remote.
            let source_repository = text(repo.get("full_name"), &selected.repository);
            let mut repositories = vec![source_repository.clone()];
            if truthy(repo.get("fork"))
                && let Some(parent) = repo
                    .get("parent")
                    .and_then(|parent| parent.get("full_name"))
                && truthy(Some(parent))
            {
                repositories.push(text(Some(parent), "Unknown"));
            }
            if let Some(target) = &tracked_target {
                repositories.push(target.clone());
            }
            let mut seen = BTreeSet::new();
            for repository in repositories {
                if !seen.insert(repository.to_lowercase()) {
                    continue;
                }
                let owner = source_repository.split('/').next().unwrap_or("");
                let head = format!("{owner}:{source_branch}");
                let query =
                    search_params(&[("state", "all"), ("head", &head), ("per_page", "100")]);
                let pulls = api_list(format!("repos/{repository}/pulls?{query}")).await?;
                for raw in pulls {
                    let pr = object(&raw)?;
                    let head_ref = get(&raw, &["head", "ref"]);
                    let head_repo = match get(&raw, &["head", "repo", "full_name"]) {
                        None | Some(Value::Null) => None,
                        Some(Value::String(name)) => Some(name.to_lowercase()),
                        Some(_) => {
                            return Err(Failure::Other("toLowerCase is not a function".into()));
                        }
                    };
                    if head_ref.and_then(Value::as_str) != Some(source_branch.as_str())
                        || head_repo.as_deref() != Some(source_repository.to_lowercase().as_str())
                    {
                        continue;
                    }
                    let id = number(pr.get("number"))?;
                    let key = format!("{repository}#{id}");
                    created_at.insert(key.clone(), parse_time(pr.get("created_at")));
                    let entry = json!({
                        "id": key,
                        "number": id,
                        "title": text(pr.get("title"), "Unknown"),
                        "author": text(get(&raw, &["user", "login"]), "Unknown"),
                        "source": text(get(&raw, &["head", "label"]), "Unknown"),
                        "target": text(get(&raw, &["base", "label"]), "Unknown"),
                        "state": if truthy(pr.get("merged_at")) { "merged".to_owned() } else { text(pr.get("state"), "Unknown") },
                        "draft": pr.get("draft") == Some(&Value::Bool(true)),
                        "url": web_url(&api_host, pr.get("html_url"))?,
                    });
                    push_match(&mut matches, entry);
                }
            }
        } else {
            let repo_answer = api(
                format!("projects/{}", encode_component(&selected.repository)),
                "project",
                Some(PROJECT_REUSE_MS),
            )
            .await?;
            let repo = object(&repo_answer)?;
            let source_id = number(repo.get("id"))?;
            // REST names a project by id; GraphQL by path.
            let own_path = repo
                .get("path_with_namespace")
                .and_then(Value::as_str)
                .map(str::to_owned)
                .unwrap_or_else(|| selected.repository.clone());
            let mut projects: Vec<(String, Option<String>)> =
                vec![(source_id.to_string(), Some(own_path))];
            let parent = repo.get("forked_from_project");
            if let Some(parent) = parent
                && truthy(parent.get("id"))
            {
                projects.push((
                    number(parent.get("id"))?.to_string(),
                    parent
                        .get("path_with_namespace")
                        .and_then(Value::as_str)
                        .map(str::to_owned),
                ));
            }
            // The fork's parent already covers the tracked project.
            let covered: Vec<String> = [
                Some(selected.repository.as_str()),
                repo.get("path_with_namespace").and_then(Value::as_str),
                parent
                    .and_then(|parent| parent.get("path_with_namespace"))
                    .and_then(Value::as_str),
            ]
            .into_iter()
            .flatten()
            .map(str::to_lowercase)
            .collect();
            if let Some(target) = &tracked_target
                && !covered.contains(&target.to_lowercase())
            {
                projects.push((encode_component(target), Some(target.clone())));
            }
            let mut seen = BTreeSet::new();
            let unique: Vec<(String, Option<String>)> = projects
                .into_iter()
                .filter(|(rest, _)| seen.insert(rest.clone()))
                .collect();
            let listed = |rest: String, path: Option<String>| {
                let reader = self.clone();
                let lookup = lookup.clone();
                let host = api_host.clone();
                let source_branch = source_branch.clone();
                let rest_list = {
                    let query = search_params(&[
                        ("scope", "all"),
                        ("state", "all"),
                        ("source_branch", &source_branch),
                        ("per_page", "100"),
                    ]);
                    api_list(format!("projects/{rest}/merge_requests?{query}"))
                };
                async move {
                    // The sidebar's summaries of every branch of a project
                    // share one GraphQL query; the card (and a failed
                    // query) asks REST.
                    if summary && let Some(path) = path.filter(|path| valid_path(path)) {
                        let ask: Ask = {
                            let lookup = lookup.clone();
                            let host = host.clone();
                            Arc::new(move |query: String| {
                                let lookup = lookup.clone();
                                let host = host.clone();
                                let argv = words(&[
                                    "glab",
                                    "api",
                                    "--hostname",
                                    &host,
                                    "graphql",
                                    "-f",
                                    &format!("query={query}"),
                                ]);
                                async move {
                                    let output = lookup
                                        .forge_call(
                                            CallKind {
                                                host: &host,
                                                kind: "mr-batch",
                                                conditional: false,
                                                include: true,
                                                reuse_ms: None,
                                            },
                                            argv.clone(),
                                            15_000,
                                        )
                                        .await?;
                                    Lookup::json(&argv, output)
                                }
                                .boxed()
                            })
                        };
                        let place = lookup.checkout.host().unwrap_or("").to_owned();
                        if let Ok(BranchRequests::Listed(requests)) = reader
                            .branch_requests(format!("{place}\n{host}"), path, source_branch, ask)
                            .await
                        {
                            return Ok(requests);
                        }
                        // REST below says what is wrong, if anything.
                    }
                    rest_list.await
                }
            };
            // Asked together: one GraphQL query covers them all.
            let lists = futures_util::future::join_all(
                unique.into_iter().map(|(rest, path)| listed(rest, path)),
            )
            .await;
            for found in lists {
                for raw in found? {
                    let mr = object(&raw)?;
                    if !same_number(mr.get("source_project_id"), source_id)
                        || mr.get("source_branch").and_then(Value::as_str)
                            != Some(source_branch.as_str())
                    {
                        continue;
                    }
                    let id = number(mr.get("iid"))?;
                    let key = format!("{}#{id}", number(mr.get("target_project_id"))?);
                    created_at.insert(key.clone(), parse_time(mr.get("created_at")));
                    let entry = json!({
                        "id": key,
                        "number": id,
                        "title": text(mr.get("title"), "Unknown"),
                        "author": text(get(&raw, &["author", "username"]), "Unknown"),
                        "source": text(mr.get("source_branch"), "Unknown"),
                        "target": text(mr.get("target_branch"), "Unknown"),
                        "state": text(mr.get("state"), "Unknown"),
                        "draft": mr.get("draft") == Some(&Value::Bool(true)) || mr.get("work_in_progress") == Some(&Value::Bool(true)),
                        "url": web_url(&api_host, mr.get("web_url"))?,
                    });
                    push_match(&mut matches, entry);
                }
            }
        }
        result.insert("matches".into(), Value::Array(matches.clone()));
        if matches.is_empty() {
            return Ok(Done::finish(
                "no_match",
                "No pull or merge request found for this source repository and branch.",
            ));
        }
        let latest = summary && params.get("latest") == Some(&Value::Bool(true));
        // The list shown is the one sorted below, as in Bun (sorted in place).
        if latest && matches.len() > 1 {
            let time = |entry: &Value| {
                created_at
                    .get(entry["id"].as_str().unwrap_or(""))
                    .copied()
                    .flatten()
            };
            if matches.iter().any(|entry| time(entry).is_none()) {
                return Err(status_error("invalid provider creation time"));
            }
            matches.sort_by(|a, b| {
                time(b)
                    .cmp(&time(a))
                    .then_with(|| b["number"].as_i64().cmp(&a["number"].as_i64()))
                    .then_with(|| a["id"].as_str().cmp(&b["id"].as_str()))
            });
        }
        result.insert("matches".into(), Value::Array(matches.clone()));
        let request = match params.get("match") {
            Some(Value::String(wanted)) => {
                matches.iter().find(|entry| entry["id"] == *wanted).cloned()
            }
            _ if matches.len() == 1 || latest => Some(matches[0].clone()),
            _ => None,
        };
        let Some(request) = request else {
            return Ok(Done::finish(
                "select_match",
                "Multiple requests match this branch. Select one explicitly.",
            ));
        };
        result.insert("request".into(), request.clone());
        let request_id = request["id"].as_str().unwrap_or("").to_owned();
        let (repository, id) = request_id
            .split_once('#')
            .unwrap_or((request_id.as_str(), ""));
        if !summary && provider == "github" {
            let read_field = |field: &'static str| {
                let argv = words(&[
                    "gh",
                    "pr",
                    "view",
                    id,
                    "--repo",
                    &format!("{api_host}/{repository}"),
                    "--json",
                    field,
                ]);
                let lookup = lookup.clone();
                let host = api_host.clone();
                async move {
                    let output = lookup
                        .forge_call(
                            CallKind {
                                host: &host,
                                kind: "pr-view",
                                conditional: false,
                                include: false,
                                reuse_ms: Some(DETAIL_REUSE_MS),
                            },
                            argv.clone(),
                            15_000,
                        )
                        .await?;
                    Lookup::json(&argv, output)
                }
            };
            let (ci, review) = tokio::join!(
                async {
                    let data = read_field("statusCheckRollup").await?;
                    let data = object(&data)?;
                    github_checks(data.get("statusCheckRollup")).map_err(status_error)
                },
                async {
                    let data = read_field("reviewDecision").await?;
                    let data = object(&data)?;
                    Ok::<_, Failure>(text(
                        data.get("reviewDecision"),
                        "No review decision reported",
                    ))
                },
            );
            result.insert(
                "ci".into(),
                json!(ci.unwrap_or_else(|_| "Unavailable (checks request failed)".into())),
            );
            result.insert(
                "review".into(),
                json!(review.unwrap_or_else(|_| "Unavailable (review request failed)".into())),
            );
        } else if !summary {
            let path = format!("projects/{repository}/merge_requests/{id}");
            let (ci, review) = tokio::join!(
                async {
                    let data = api(path.clone(), "request", Some(DETAIL_REUSE_MS)).await?;
                    let data = object(&data)?;
                    Ok::<_, Failure>(match data.get("head_pipeline") {
                        Some(Value::Null) => "No pipeline reported".to_owned(),
                        pipeline => text(
                            pipeline.and_then(|pipeline| pipeline.get("status")),
                            "Unavailable",
                        ),
                    })
                },
                async {
                    let data = api(
                        format!("{path}/approvals"),
                        "approvals",
                        Some(DETAIL_REUSE_MS),
                    )
                    .await?;
                    gitlab_approvals(&data).map_err(status_error)
                },
            );
            result.insert(
                "ci".into(),
                json!(ci.unwrap_or_else(|_| "Unavailable (pipeline request failed)".into())),
            );
            result.insert(
                "review".into(),
                json!(review.unwrap_or_else(|_| "Unavailable (approvals request failed)".into())),
            );
        }
        let current = read_branch(lookup).await?;
        if current.map(|branch| branch.name).as_deref() != Some(name.as_str()) {
            result.shift_remove("request");
            result.shift_remove("matches");
            return Ok(Done::finish(
                "error",
                "The branch changed during refresh. Refresh again.",
            ));
        }
        Ok(Done::Finish("ready", None))
    }
}

/// How a lookup ended, before [`PullRequests::finish`] stamps it.
enum Done {
    Finish(&'static str, Option<String>),
    /// An answer the browser may retry (its `retryable: true`).
    Retryable(&'static str, Option<String>),
}

impl Done {
    fn finish(state: &'static str, message: &str) -> Self {
        Self::Finish(state, Some(message.to_owned()))
    }
}

struct Branch {
    name: String,
    rebasing: bool,
}

/// Rebases stop on a detached HEAD, but Git records the branch being
/// rebased. That ref is trusted only while the rebase itself last moved
/// HEAD; other detached checkouts stay unresolved instead of guessing
/// from commits.
async fn read_branch(lookup: &Lookup) -> Res<Option<Branch>> {
    let branch = lookup
        .run(
            words(&["git", "symbolic-ref", "--quiet", "--short", "HEAD"]),
            15_000,
        )
        .await?;
    if branch.code == 0 {
        return Ok(Some(Branch {
            name: branch.stdout.trim().to_owned(),
            rebasing: false,
        }));
    }
    if branch.code != 1 {
        return Err(status_error("git symbolic-ref HEAD failed"));
    }
    // --git-path resolves linked worktrees' private rebase state.
    let paths = lookup
        .run(
            words(&[
                "git",
                "rev-parse",
                "--git-path",
                "rebase-merge/head-name",
                "--git-path",
                "rebase-apply/head-name",
            ]),
            15_000,
        )
        .await?;
    if paths.code != 0 {
        return Err(status_error("git rev-parse --git-path failed"));
    }
    static MOVED: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"^commit(?: \([a-z]+\))?: ").unwrap());
    static REBASE: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(r"^(?:rebase(?: \([a-z-]+\))?|pull\b.* \([a-z-]+\)): ").unwrap()
    });
    for path in paths
        .stdout
        .split('\n')
        .map(|line| line.strip_suffix('\r').unwrap_or(line))
        .filter(|line| !line.is_empty())
    {
        let Some(reference) = read_git_file(lookup, path).await? else {
            continue;
        };
        let reference = reference.trim();
        if reference.is_empty() {
            continue;
        }
        if !reference.starts_with("refs/heads/") || reference == "refs/heads/" {
            return Ok(None);
        }
        let exists = lookup
            .run(
                words(&["git", "rev-parse", "--verify", "--quiet", reference]),
                15_000,
            )
            .await?;
        if exists.code != 0 {
            return Ok(None);
        }
        // A manual checkout or reset mid-rebase (even to the rebase's own
        // base) must not inherit the rebased branch's request. Commits and
        // amends made at a rebase stop keep HEAD on the rebase.
        let reflog = lookup
            .run(
                words(&[
                    "git",
                    "log",
                    "--walk-reflogs",
                    "--format=%gs",
                    "-n",
                    "50",
                    "HEAD",
                ]),
                15_000,
            )
            .await?;
        if reflog.code != 0 {
            return Ok(None);
        }
        let moved = reflog
            .stdout
            .split('\n')
            .map(|line| line.strip_suffix('\r').unwrap_or(line))
            .find(|entry| !entry.is_empty() && !MOVED.is_match(entry));
        // `pull --rebase` logs its whole command line before each step; a
        // merge pull logs no step and never leaves rebase metadata behind.
        match moved {
            Some(moved) if REBASE.is_match(moved) => {}
            _ => return Ok(None),
        }
        return Ok(Some(Branch {
            name: reference["refs/heads/".len()..].to_owned(),
            rebasing: true,
        }));
    }
    Ok(None)
}

async fn read_git_file(lookup: &Lookup, path: &str) -> Res<Option<String>> {
    if lookup.checkout.host().is_some() {
        let output = lookup.run(words(&["cat", "--", path]), 15_000).await?;
        return Ok((output.code == 0).then_some(output.stdout));
    }
    let full = std::path::Path::new(&lookup.checkout.root).join(path);
    match tokio::fs::read(&full).await {
        Ok(bytes) => Ok(Some(String::from_utf8_lossy(&bytes).into_owned())),
        Err(error)
            if error.kind() == std::io::ErrorKind::NotFound
                || error.kind() == std::io::ErrorKind::NotADirectory =>
        {
            Ok(None)
        }
        Err(error) => Err(Failure::Other(error.to_string())),
    }
}

#[cfg(test)]
mod tests;
