//! Search of the conversation text repo with `git grep HEAD`
//! (archive/text-search.ts): the query's words (or a Perl regex) as grep
//! patterns, machine, agent and project as pathspecs, role, kind and the
//! time range checked on each matching line. Sessions rank by their number
//! of matching messages, then by their latest one. Sessions of this machine
//! that grew since the repo's last commit are rendered into a scratch
//! directory and grepped with it.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::LazyLock;
use std::sync::atomic::{AtomicBool, Ordering};

use indexmap::IndexMap;
use regex::Regex;
use roamgate_agents::js::{js_lower, js_trim, parse_line, utf16_prefix};
use roamgate_agents::{Agent, ParseState};
use serde::{Deserialize, Serialize};

use crate::hosts::{ArchiveRuntime, enabled_adapters, local_roots, resolve_hosts};
use crate::lines::{CompleteLines, file_range};
use crate::settings::{
    ArchiveRule, ArchiveSettings, IndexLevel, RuleSubject, any_rule_matches, index_level_for,
};
use crate::store::Result;
use crate::sync::{FileKind, file_meta, list_files};
use crate::text_render::{
    ParsedLine, RenderOptions, RenderState, TextFileSubject, header_line, suffixed_path, text_path,
};
use crate::text_repo::{STATE_PATH, TextState, git_env, render_chunks, text_sources};
use crate::zstd_frames::read_archived;

// ------------------------------------------------------------- queries

/// A parsed query.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Node {
    Term(String),
    And(Box<Node>, Box<Node>),
    Or(Box<Node>, Box<Node>),
    Not(Option<Box<Node>>, Box<Node>),
}

const OPERATORS: &[&str] = &["AND", "OR", "NOT", "NEAR"];

static TOKEN: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#""((?:[^"]|"")*)"|([()])|([^\s"()]+)"#).unwrap());

fn tokenize(query: &str) -> Vec<String> {
    TOKEN
        .captures_iter(query)
        .map(|found| match (found.get(1), found.get(2), found.get(3)) {
            (Some(phrase), _, _) => format!("\"{}", phrase.as_str().replace("\"\"", "\"")),
            (_, Some(paren), _) => paren.as_str().to_owned(),
            (_, _, Some(word)) => word.as_str().to_owned(),
            _ => String::new(),
        })
        .collect()
}

struct Parser {
    tokens: Vec<String>,
    at: usize,
}

impl Parser {
    fn peek(&self) -> Option<&str> {
        self.tokens.get(self.at).map(String::as_str)
    }

    fn primary(&mut self) -> Option<Node> {
        let token = self.tokens.get(self.at)?.clone();
        if token == "(" {
            self.at += 1;
            let inner = self.or_expr();
            if self.peek() == Some(")") {
                self.at += 1;
            }
            return inner;
        }
        if token == ")" {
            return None;
        }
        self.at += 1;
        if let Some(text) = token.strip_prefix('"') {
            return if text.is_empty() {
                self.primary()
            } else {
                Some(Node::Term(text.to_owned()))
            };
        }
        if OPERATORS.contains(&token.as_str()) {
            return self.primary();
        }
        let text = token.trim_end_matches('*');
        if text.is_empty() {
            self.primary()
        } else {
            Some(Node::Term(text.to_owned()))
        }
    }

    fn and_expr(&mut self) -> Option<Node> {
        let mut left = if self.peek() == Some("NOT") {
            None
        } else {
            self.primary()
        };
        loop {
            let token = self.peek();
            if matches!(token, None | Some(")") | Some("OR")) {
                break;
            }
            if token == Some("NOT") {
                self.at += 1;
                if let Some(right) = self.primary() {
                    left = Some(Node::Not(left.map(Box::new), Box::new(right)));
                }
                continue;
            }
            if matches!(token, Some("AND") | Some("NEAR")) {
                self.at += 1;
            }
            let Some(right) = self.primary() else {
                break;
            };
            left = Some(match left {
                Some(left) => Node::And(Box::new(left), Box::new(right)),
                None => right,
            });
        }
        left
    }

    fn or_expr(&mut self) -> Option<Node> {
        let mut left = self.and_expr();
        while self.peek() == Some("OR") {
            self.at += 1;
            if let Some(right) = self.and_expr() {
                left = Some(match left {
                    Some(left) => Node::Or(Box::new(left), Box::new(right)),
                    None => right,
                });
            }
        }
        left
    }
}

/// The query as the index read it: bare words and "quoted phrases" must
/// all appear in one message; AND, OR, NOT and parentheses combine them.
pub fn parse_query(query: &str) -> Option<Node> {
    Parser {
        tokens: tokenize(query),
        at: 0,
    }
    .or_expr()
}

/// The node as git grep pattern arguments.
pub fn grep_args(node: &Node) -> Vec<String> {
    match node {
        Node::Term(text) => vec!["-e".into(), text.clone()],
        Node::And(left, right) | Node::Or(left, right) => {
            let op = if matches!(node, Node::And(..)) {
                "--and"
            } else {
                "--or"
            };
            let mut out = vec!["(".to_owned()];
            out.extend(grep_args(left));
            out.push(op.into());
            out.extend(grep_args(right));
            out.push(")".into());
            out
        }
        Node::Not(Some(left), right) => {
            let mut out = vec!["(".to_owned()];
            out.extend(grep_args(left));
            out.extend(["--and".into(), "--not".into()]);
            out.extend(grep_args(right));
            out.push(")".into());
            out
        }
        Node::Not(None, right) => {
            let mut out = vec!["--not".to_owned()];
            out.extend(grep_args(right));
            out
        }
    }
}

/// The node as a case-insensitive test of a lowercased text.
pub fn node_matches(node: &Node, lower: &str) -> bool {
    match node {
        Node::Term(text) => lower.contains(&js_lower(text)),
        Node::And(left, right) => node_matches(left, lower) && node_matches(right, lower),
        Node::Or(left, right) => node_matches(left, lower) || node_matches(right, lower),
        Node::Not(left, right) => {
            left.as_ref().is_none_or(|left| node_matches(left, lower))
                && !node_matches(right, lower)
        }
    }
}

/// The positive words of the node, for snippets.
pub fn node_terms(node: Option<&Node>) -> Vec<String> {
    match node {
        None => Vec::new(),
        Some(Node::Term(text)) => vec![text.clone()],
        Some(Node::And(left, right) | Node::Or(left, right)) => {
            let mut out = node_terms(Some(left));
            out.extend(node_terms(Some(right)));
            out
        }
        Some(Node::Not(left, _)) => node_terms(left.as_deref()),
    }
}

// ----------------------------------------------------------- pathspecs

/// A filter value as a path component's characters, for a glob.
fn glob_safe(value: &str) -> String {
    value
        .chars()
        .flat_map(|c| {
            if c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '@' | '-') {
                vec![c]
            } else {
                vec!['_'; c.len_utf16()]
            }
        })
        .collect()
}

/// Host, agent and project filters.
#[derive(Debug, Clone, Default)]
pub struct PathFilter {
    pub host: Option<String>,
    pub agent: Option<String>,
    pub project: Option<String>,
}

/// Pathspecs selecting the transcripts (never the state or the history).
pub fn transcript_pathspecs(filter: &PathFilter) -> Vec<String> {
    let host = filter.host.as_deref().map_or("*".into(), glob_safe);
    let agent = filter.agent.as_deref().map_or("*".into(), glob_safe);
    let mut out = Vec::new();
    if let Some(project) = &filter.project {
        out.push(format!(":(glob){host}/{agent}/*{}*/**", glob_safe(project)));
    } else if filter.host.is_some() || filter.agent.is_some() {
        out.push(format!(":(glob){host}/{agent}/**"));
    }
    let state_dir = STATE_PATH.rsplit_once('/').map_or(".", |(dir, _)| dir);
    out.push(format!(":(exclude){state_dir}"));
    out.push(":(exclude,glob)*/@history/**".into());
    out
}

pub fn history_pathspecs(host: Option<&str>) -> Vec<String> {
    vec![format!(
        ":(glob){}/@history/**",
        host.map_or("*".into(), glob_safe)
    )]
}

// --------------------------------------------------------------- grep

/// A matching line.
#[derive(Debug, Clone)]
pub struct GrepLine {
    pub path: String,
    pub line: u64,
    pub text: String,
}

/// Where a grep runs: HEAD of the bare repo, or the files of a directory.
pub enum GrepIn<'a> {
    Tree(&'a Path),
    Files(&'a Path),
}

/// Streams git grep's matching lines. Exit 1 (no match) is no error.
pub fn run_grep(
    target: GrepIn<'_>,
    patterns: &[String],
    pathspecs: &[String],
    cancel: Option<&AtomicBool>,
    on_line: &mut dyn FnMut(GrepLine),
) -> Result<()> {
    let mut command = Command::new("git");
    let tree = matches!(target, GrepIn::Tree(_));
    match target {
        GrepIn::Tree(repo) => {
            command.arg("--git-dir").arg(repo);
        }
        GrepIn::Files(dir) => {
            command.current_dir(dir);
        }
    }
    command.args(["grep", "-I", "-n", "-i", "--no-color"]);
    if !tree {
        command.arg("--no-index");
    }
    command.args(patterns);
    if tree {
        command.arg("HEAD");
    }
    command.arg("--").args(pathspecs);
    command
        .env_clear()
        .envs(git_env())
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = command.spawn()?;
    let stdout = child.stdout.take().unwrap();
    let mut stderr = child.stderr.take().unwrap();
    let errors = std::thread::spawn(move || {
        let mut text = String::new();
        let _ = stderr.read_to_string(&mut text);
        text
    });
    let prefix = if tree { "HEAD:" } else { "" };
    let mut lines = CompleteLines::new(stdout);
    while let Some((line, _)) = lines.next_line() {
        if cancel.is_some_and(|cancel| cancel.load(Ordering::Relaxed)) {
            let _ = child.kill();
            break;
        }
        let text = String::from_utf8_lossy(line);
        let Some(rest) = text.strip_prefix(prefix) else {
            continue;
        };
        let Some(first) = rest.find(':') else {
            continue;
        };
        let Some(second) = rest[first + 1..].find(':').map(|at| at + first + 1) else {
            continue;
        };
        let number = &rest[first + 1..second];
        on_line(GrepLine {
            path: rest[..first].to_owned(),
            line: number.parse().unwrap_or(0),
            text: rest[second + 1..].to_owned(),
        });
    }
    drop(lines);
    let status = child.wait()?;
    let stderr = errors.join().unwrap_or_default();
    if cancel.is_some_and(|cancel| cancel.load(Ordering::Relaxed)) {
        return Err(crate::Error::msg("The operation was aborted."));
    }
    let code = crate::hosts::exit_code(status);
    if code != 0 && code != 1 {
        return Err(crate::Error::msg(format!(
            "git grep: exit {code} {}",
            utf16_prefix(js_trim(&stderr), 300)
        )));
    }
    Ok(())
}

// ------------------------------------------------------------ overlay

/// A scratch file of a grown session.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct OverlayFile {
    pub key: String,
    /// Lines of the file already in HEAD: the scratch file's line 1 is
    /// offset+1.
    pub offset: u64,
    pub render: RenderState,
}

#[derive(Debug, Clone, Default)]
pub struct Overlay {
    pub dir: PathBuf,
    pub files: HashMap<String, OverlayFile>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct ManifestEntry {
    key: String,
    offset: u64,
    render: RenderState,
    size: u64,
    path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct Manifest {
    head: Option<String>,
    files: IndexMap<String, ManifestEntry>,
}

pub fn overlay_dir(archive_dir: &Path) -> PathBuf {
    archive_dir.join("text-live")
}

/// Where the overlay's files are: what its grep runs in.
pub fn overlay_files(archive_dir: &Path) -> PathBuf {
    overlay_dir(archive_dir).join("files")
}

fn write_atomic(target: &Path, body: &[u8]) -> Result<()> {
    let tmp = PathBuf::from(format!("{}.{}.tmp", target.display(), std::process::id()));
    crate::write_private(&tmp, body)?;
    std::fs::rename(&tmp, target)?;
    Ok(())
}

/// This machine's transcripts that grew past what the repo holds, rendered
/// into `<archive>/text-live/` at their repo paths (only the new lines,
/// with the line offset kept). Cached by file size until the next commit.
pub fn live_overlay(
    archive_dir: &Path,
    settings: &ArchiveSettings,
    runtime: &ArchiveRuntime,
    state: Option<&TextState>,
    head: Option<&str>,
) -> Result<Overlay> {
    let dir = overlay_files(archive_dir);
    roamgate_base::private::create_dir_all_mode(&dir)?;
    let manifest_path = overlay_dir(archive_dir).join("manifest.json");
    let mut manifest = Manifest {
        head: head.map(str::to_owned),
        files: IndexMap::new(),
    };
    if let Ok(text) = std::fs::read_to_string(&manifest_path)
        && let Ok(old) = serde_json::from_str::<Manifest>(&text)
        && old.head.as_deref() == head
    {
        manifest = old;
    }
    let hosts = resolve_hosts(settings, runtime);
    let mut files = HashMap::new();
    let mut next = Manifest {
        head: head.map(str::to_owned),
        files: IndexMap::new(),
    };
    let taken: std::collections::HashSet<String> = state
        .map(|state| state.files.values().map(|file| file.path.clone()).collect())
        .unwrap_or_default();
    if let Some(me) = hosts.first() {
        for agent in enabled_adapters(settings) {
            if !agent.indexable() {
                continue;
            }
            let mut candidates: Vec<(PathBuf, String, u64, bool)> = local_roots(agent, me, runtime)
                .iter()
                .flat_map(|root| list_files(root, agent))
                .map(|file| (file.path, file.relpath, file.size, false))
                .collect();
            for extra in agent.extra_files() {
                let path = runtime.home_dir.join(extra.home_path);
                let size = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
                if size > 0 {
                    candidates.push((path, extra.relpath.to_owned(), size, true));
                }
            }
            for (path, relpath, size, history) in candidates {
                let key = format!("{}/{}/{relpath}", me.id, agent.id());
                let kind = if history {
                    FileKind::History
                } else {
                    FileKind::Transcript
                };
                let meta = file_meta(agent, kind, &relpath);
                let subject = RuleSubject {
                    host: &me.id,
                    agent: agent.id(),
                    project: &meta.project,
                };
                if any_rule_matches(&settings.exclude, subject) {
                    continue;
                }
                if index_level_for(settings, subject) == IndexLevel::None {
                    continue;
                }
                let known = state.and_then(|state| state.files.get(&key));
                let from = known.map_or(0, |known| known.text_bytes);
                if size <= from {
                    continue;
                }
                if let Some(cached) = manifest.files.get(&key)
                    && cached.size == size
                {
                    files.insert(
                        cached.path.clone(),
                        OverlayFile {
                            key: cached.key.clone(),
                            offset: cached.offset,
                            render: cached.render.clone(),
                        },
                    );
                    next.files.insert(key, cached.clone());
                    continue;
                }
                let options = state.map_or(
                    RenderOptions {
                        tool_call_chars: 2000,
                        thinking: settings.thinking,
                    },
                    |state| state.options,
                );
                let Ok(range) = file_range(&path, from, size) else {
                    continue;
                };
                let Ok(rendered) = render_chunks(
                    agent,
                    history,
                    options,
                    known.map(|k| &k.render),
                    range,
                    from,
                ) else {
                    continue;
                };
                if rendered.lines.is_empty() {
                    continue;
                }
                let (path, body, offset) = match known.filter(|known| !known.path.is_empty()) {
                    Some(known) => (
                        known.path.clone(),
                        format!("{}\n", rendered.lines.join("\n")),
                        known.lines,
                    ),
                    None => {
                        let subject = TextFileSubject {
                            host: &me.id,
                            agent: agent.id(),
                            relpath: &relpath,
                            history,
                            project: &meta.project,
                            session: &meta.session,
                            subagent: meta.subagent,
                        };
                        let Some(mut path) = text_path(&subject, &rendered.render) else {
                            continue;
                        };
                        if taken.contains(&path) {
                            path = suffixed_path(&path, &key);
                        }
                        let body = format!(
                            "{}\n{}\n",
                            header_line(&key, &rendered.render),
                            rendered.lines.join("\n")
                        );
                        (path, body, 0)
                    }
                };
                let target = dir.join(&path);
                if let Some(parent) = target.parent() {
                    roamgate_base::private::create_dir_all_mode(parent)?;
                }
                write_atomic(&target, body.as_bytes())?;
                let entry = ManifestEntry {
                    key: key.clone(),
                    offset,
                    render: rendered.render.clone(),
                    size,
                    path: path.clone(),
                };
                files.insert(
                    path,
                    OverlayFile {
                        key: key.clone(),
                        offset,
                        render: rendered.render,
                    },
                );
                next.files.insert(key, entry);
            }
        }
    }
    // Scratch files no longer wanted.
    for (key, entry) in &manifest.files {
        if next
            .files
            .get(key)
            .is_none_or(|kept| kept.path != entry.path)
        {
            let _ = std::fs::remove_file(dir.join(&entry.path));
        }
    }
    write_atomic(&manifest_path, serde_json::to_string(&next)?.as_bytes())?;
    Ok(Overlay { dir, files })
}

// ------------------------------------------------------------- search

/// How many matching lines of a session become its snippets.
pub const SNIPPETS_PER_SESSION: usize = 3;

/// One file's matching lines.
#[derive(Debug, Clone)]
pub struct Agg {
    pub path: String,
    pub count: u64,
    pub last_ts: String,
    pub recent: Vec<(u64, ParsedLine)>,
}

/// What a repo path is.
#[derive(Debug, Clone)]
pub struct FileInfo {
    pub key: String,
    pub host: String,
    pub agent: String,
    pub relpath: String,
    pub history: bool,
    pub render: RenderState,
}

/// What a repo path is: from the state, else from the overlay.
pub fn path_info(
    path: &str,
    state: Option<&TextState>,
    overlay: Option<&Overlay>,
    by_path: &HashMap<String, String>,
) -> Option<FileInfo> {
    let key = by_path.get(path).cloned().or_else(|| {
        overlay
            .and_then(|overlay| overlay.files.get(path))
            .map(|file| file.key.clone())
    })?;
    let mut parts = key.splitn(3, '/');
    let host = parts.next().unwrap_or("").to_owned();
    let agent = parts.next().unwrap_or("").to_owned();
    let relpath = parts.next().unwrap_or("").to_owned();
    let render = overlay
        .and_then(|overlay| overlay.files.get(path))
        .map(|file| file.render.clone())
        .or_else(|| {
            state
                .and_then(|state| state.files.get(&key))
                .map(|file| file.render.clone())
        })
        .unwrap_or_default();
    Some(FileInfo {
        history: relpath.starts_with('@'),
        key,
        host,
        agent,
        relpath,
        render,
    })
}

/// Folds matching lines into per-file counts, keeping the latest few.
pub struct Aggregator<'a> {
    filter: Box<dyn Fn(&ParsedLine) -> bool + 'a>,
    files: IndexMap<String, Agg>,
    pub total: u64,
}

impl<'a> Aggregator<'a> {
    pub fn new(filter: impl Fn(&ParsedLine) -> bool + 'a) -> Self {
        Self {
            filter: Box::new(filter),
            files: IndexMap::new(),
            total: 0,
        }
    }

    pub fn add(&mut self, path: &str, line: u64, parsed: Option<ParsedLine>) {
        let Some(parsed) = parsed else {
            return;
        };
        if !(self.filter)(&parsed) {
            return;
        }
        self.total += 1;
        let agg = self.files.entry(path.to_owned()).or_insert_with(|| Agg {
            path: path.to_owned(),
            count: 0,
            last_ts: String::new(),
            recent: Vec::new(),
        });
        agg.count += 1;
        if let Some(ts) = &parsed.ts
            && js_greater(ts, &agg.last_ts)
        {
            agg.last_ts = ts.clone();
        }
        agg.recent.push((line, parsed));
        if agg.recent.len() > SNIPPETS_PER_SESSION {
            agg.recent.remove(0);
        }
    }

    pub fn files(self) -> Vec<Agg> {
        self.files.into_values().collect()
    }
}

fn js_greater(a: &str, b: &str) -> bool {
    a.encode_utf16().gt(b.encode_utf16())
}

/// `localeCompare` as the ranking uses it on timestamps (ASCII).
fn compare(a: &str, b: &str) -> std::cmp::Ordering {
    a.cmp(b)
}

/// The line filters of a query.
#[derive(Debug, Clone, Default)]
pub struct LineFilter {
    pub role: Option<String>,
    pub kind: Option<String>,
    pub since: Option<String>,
    pub until: Option<String>,
}

impl LineFilter {
    pub fn keeps(&self, parsed: &ParsedLine) -> bool {
        self.role.as_deref().is_none_or(|role| parsed.role == role)
            && self.kind.as_deref().is_none_or(|kind| parsed.kind == kind)
            && self.since.as_deref().is_none_or(|since| {
                parsed
                    .ts
                    .as_deref()
                    .is_some_and(|ts| !js_greater(since, ts))
            })
            && self.until.as_deref().is_none_or(|until| {
                parsed
                    .ts
                    .as_deref()
                    .is_some_and(|ts| !js_greater(ts, until))
            })
    }
}

/// Ranked by matches, then recency; or recency first.
pub fn rank_files(mut files: Vec<Agg>, recent: bool) -> Vec<Agg> {
    files.sort_by(|a, b| {
        if recent {
            compare(&b.last_ts, &a.last_ts).then(b.count.cmp(&a.count))
        } else {
            b.count.cmp(&a.count).then(compare(&b.last_ts, &a.last_ts))
        }
    });
    files
}

/// A project rule or filter against a path's project component.
pub fn hidden_by(rules: &[ArchiveRule], subject: RuleSubject<'_>) -> bool {
    let safe: Vec<ArchiveRule> = rules
        .iter()
        .map(|rule| ArchiveRule {
            project: rule.project.as_deref().map(glob_safe),
            ..rule.clone()
        })
        .collect();
    any_rule_matches(&safe, subject)
}

pub fn project_of_path(path: &str) -> String {
    let parts: Vec<&str> = path.split('/').collect();
    if parts.get(1) == Some(&"@history") {
        String::new()
    } else {
        parts.get(2).copied().unwrap_or("").to_owned()
    }
}

/// One document of raw/, for the slow search of tool output.
pub struct RawDoc {
    pub key: String,
    pub host: String,
    pub agent: String,
    pub relpath: String,
    pub project: String,
    pub line: u64,
    pub ts: Option<String>,
    pub doc: roamgate_agents::extract::Doc,
    pub lower: String,
}

/// Each raw/ file's documents, for the slow search of tool output.
pub fn raw_docs(
    archive_dir: &Path,
    settings: &ArchiveSettings,
    filter: &PathFilter,
    on_progress: &mut dyn FnMut(usize, usize),
    cancel: Option<&AtomicBool>,
    on_doc: &mut dyn FnMut(RawDoc),
) -> Result<()> {
    let sources: Vec<_> = text_sources(archive_dir, settings)?
        .into_iter()
        .filter(|source| {
            !source.history
                && filter
                    .host
                    .as_deref()
                    .is_none_or(|host| source.host == host)
                && filter
                    .agent
                    .as_deref()
                    .is_none_or(|agent| source.agent.id() == agent)
        })
        .collect();
    let total = sources.len();
    for (done, source) in sources.iter().enumerate() {
        if cancel.is_some_and(|cancel| cancel.load(Ordering::Relaxed)) {
            return Err(crate::Error::msg("The operation was aborted."));
        }
        on_progress(done, total);
        let agent: Agent = source.agent;
        let meta = agent.classify(&source.relpath);
        if filter
            .project
            .as_deref()
            .is_some_and(|project| !meta.project.contains(project))
        {
            continue;
        }
        if !source.zst.exists() {
            continue;
        }
        let mut state = ParseState::new(settings.thinking);
        let Ok(reader) = read_archived(&source.zst) else {
            continue;
        };
        let mut lines = CompleteLines::new(reader);
        let mut line = 0u64;
        let mut last_ts: Option<String> = None;
        while let Some((raw, _)) = lines.next_line() {
            line += 1;
            if raw.is_empty() {
                continue;
            }
            let Some(record) = parse_line(raw) else {
                continue;
            };
            if let Some(ts) = agent.timestamp_of(&record) {
                last_ts = Some(utf16_prefix(&ts, 19).to_owned());
            }
            for doc in agent.parse(&record, &mut state) {
                let project = state
                    .project
                    .clone()
                    .filter(|p| !p.is_empty())
                    .unwrap_or_else(|| meta.project.clone());
                on_doc(RawDoc {
                    key: source.key.clone(),
                    host: source.host.clone(),
                    agent: agent.id().to_owned(),
                    relpath: source.relpath.clone(),
                    project,
                    line,
                    ts: last_ts.clone(),
                    lower: js_lower(&doc.text),
                    doc,
                });
            }
        }
    }
    on_progress(total, total);
    Ok(())
}

pub fn state_by_path(state: Option<&TextState>) -> HashMap<String, String> {
    state
        .map(|state| {
            state
                .files
                .iter()
                .filter(|(_, file)| !file.path.is_empty())
                .map(|(key, file)| (file.path.clone(), key.clone()))
                .collect()
        })
        .unwrap_or_default()
}

/// Lines of a grep output read back.
pub fn read_lines(reader: impl Read) -> Vec<String> {
    BufReader::new(reader)
        .lines()
        .map_while(std::io::Result::ok)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn term(text: &str) -> Node {
        Node::Term(text.into())
    }

    #[test]
    fn words_and_phrases_must_all_appear_operators_as_the_index_read_them() {
        assert_eq!(
            parse_query("alpha \"beta gamma\""),
            Some(Node::And(
                Box::new(term("alpha")),
                Box::new(term("beta gamma"))
            ))
        );
        assert_eq!(
            parse_query("a OR b"),
            Some(Node::Or(Box::new(term("a")), Box::new(term("b"))))
        );
        assert_eq!(
            parse_query("a NOT b"),
            Some(Node::Not(Some(Box::new(term("a"))), Box::new(term("b"))))
        );
        assert_eq!(
            parse_query("NOT b"),
            Some(Node::Not(None, Box::new(term("b"))))
        );
        assert_eq!(
            parse_query("pre* (x)"),
            Some(Node::And(Box::new(term("pre")), Box::new(term("x"))))
        );
        assert_eq!(parse_query("\"say \"\"hi\"\"\""), Some(term("say \"hi\"")));
        assert_eq!(parse_query("AND"), None);
        assert_eq!(
            grep_args(&parse_query("a NOT b").unwrap()),
            vec!["(", "-e", "a", "--and", "--not", "-e", "b", ")"]
        );
        assert_eq!(
            grep_args(&parse_query("NOT b").unwrap()),
            vec!["--not", "-e", "b"]
        );
        assert_eq!(
            node_terms(parse_query("a OR (b NOT c)").as_ref()),
            vec!["a", "b"]
        );
    }

    #[test]
    fn the_same_query_tests_a_text_for_the_raw_search() {
        let node = parse_query("Alpha NOT gamma").unwrap();
        assert!(node_matches(&node, "the alpha beta"));
        assert!(!node_matches(&node, "alpha gamma"));
    }

    #[test]
    fn host_agent_and_project_are_pathspecs_state_and_history_excluded() {
        assert_eq!(
            transcript_pathspecs(&PathFilter::default()),
            vec![":(exclude).roamgate", ":(exclude,glob)*/@history/**"]
        );
        assert_eq!(
            transcript_pathspecs(&PathFilter {
                host: Some("my host".into()),
                agent: None,
                project: Some("/x".into()),
            })[0],
            ":(glob)my_host/*/*_x*/**"
        );
        assert_eq!(history_pathspecs(None), vec![":(glob)*/@history/**"]);
    }

    fn parsed(ts: Option<&str>, role: &str, kind: &str) -> ParsedLine {
        ParsedLine {
            ts: ts.map(str::to_owned),
            role: role.into(),
            kind: kind.into(),
            tool: None,
            text: "x".into(),
        }
    }

    #[test]
    fn role_kind_and_the_time_range_are_checked_on_each_line() {
        let filter = LineFilter {
            role: Some("user".into()),
            kind: None,
            since: Some("2026-01-02".into()),
            until: Some("2026-01-03".into()),
        };
        assert!(filter.keeps(&parsed(Some("2026-01-02T10:00:00"), "user", "text")));
        assert!(!filter.keeps(&parsed(Some("2026-01-02T10:00:00"), "assistant", "text")));
        assert!(!filter.keeps(&parsed(None, "user", "text")));
        assert!(!filter.keeps(&parsed(Some("2026-01-03T00:00:01"), "user", "text")));
    }

    #[test]
    fn ranked_by_matches_then_recency_or_recency_first() {
        let mut agg = Aggregator::new(|_| true);
        agg.add("a", 1, Some(parsed(Some("2026-01-01"), "user", "text")));
        agg.add("a", 2, Some(parsed(Some("2026-01-01"), "user", "text")));
        agg.add("b", 1, Some(parsed(Some("2026-01-05"), "user", "text")));
        let files = agg.files();
        let ranked: Vec<_> = rank_files(files.clone(), false)
            .into_iter()
            .map(|f| f.path)
            .collect();
        assert_eq!(ranked, vec!["a", "b"]);
        let ranked: Vec<_> = rank_files(files, true)
            .into_iter()
            .map(|f| f.path)
            .collect();
        assert_eq!(ranked, vec!["b", "a"]);
    }
}
