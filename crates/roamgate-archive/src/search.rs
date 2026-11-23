//! Archive search (archive/search.ts): `search_archive` greps the
//! conversation text repo; `search_raw` reads every transcript of raw/
//! (tool output included, slow). The wire shapes are shared/archiveSearch.

use std::collections::HashMap;
use std::path::Path;
use std::sync::atomic::AtomicBool;

use roamgate_agents::Agent;
use roamgate_agents::js::{collapse_space, js_lower};
use serde::{Deserialize, Serialize};
use serde_json::Number;

use crate::hosts::ArchiveRuntime;
use crate::settings::{ArchiveSettings, RuleSubject};
use crate::store::Result;
use crate::text_render::{ParsedLine, parse_text_line};
use crate::text_repo::{head_commit, read_text_state, text_repo_path};
use crate::text_search::{
    Agg, Aggregator, FileInfo, GrepIn, LineFilter, Node, Overlay, PathFilter, grep_args, hidden_by,
    history_pathspecs, live_overlay, node_matches, node_terms, overlay_files, parse_query,
    path_info, project_of_path, rank_files, raw_docs, run_grep, state_by_path,
    transcript_pathspecs,
};

pub const SNIPPET_WIDTH: usize = 120;

/// What a search asks.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct SearchQuery {
    pub terms: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub host: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub role: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub since: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub until: Option<String>,
    #[serde(default)]
    pub recent: bool,
    #[serde(default)]
    pub history: bool,
    /// The query is one Perl-compatible regular expression (git grep -P).
    #[serde(default)]
    pub regex: bool,
    /// Search tool output too: reads raw/, slow.
    #[serde(default, rename = "toolOutput")]
    pub tool_output: bool,
    pub limit: usize,
}

impl SearchQuery {
    fn line_filter(&self) -> LineFilter {
        LineFilter {
            role: self.role.clone(),
            kind: self.kind.clone(),
            since: self.since.clone(),
            until: self.until.clone(),
        }
    }

    fn path_filter(&self) -> PathFilter {
        PathFilter {
            host: self.host.clone(),
            agent: self.agent.clone(),
            project: self.project.clone(),
        }
    }
}

/// One session that matched.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SearchHit {
    pub session: String,
    pub agent: String,
    pub host: String,
    pub project: String,
    pub subagent: bool,
    pub title: Option<String>,
    pub ts: Option<String>,
    pub role: String,
    pub kind: String,
    pub tool: Option<String>,
    pub snippet: String,
    /// The text repo's line (a raw/ record's line with toolOutput).
    pub doc: u64,
    pub cost_usd: Option<Number>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub matches: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub snippets: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub key: Option<String>,
}

/// A prompt of the history that matched.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct HistoryHit {
    pub host: String,
    pub ts: Option<String>,
    pub project: Option<String>,
    pub snippet: String,
}

/// What a search found.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SearchResult {
    pub query: String,
    pub total: u64,
    pub hits: Vec<SearchHit>,
    pub truncated: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sessions: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub warning: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub history: Option<Vec<HistoryHit>>,
}

impl SearchResult {
    fn empty(query: &str, source: &str) -> Self {
        Self {
            query: query.to_owned(),
            total: 0,
            hits: Vec::new(),
            truncated: false,
            sessions: None,
            source: Some(source.into()),
            warning: None,
            history: None,
        }
    }
}

/// `char.toLowerCase().charAt(0) || char`: the first UTF-16 unit of the
/// lowercased code point.
fn lower_unit(c: char) -> u16 {
    let lowered: String = c.to_lowercase().collect();
    lowered.encode_utf16().next().unwrap_or_else(|| {
        let mut units = [0u16; 2];
        c.encode_utf16(&mut units)[0]
    })
}

/// Context around the first match, with every match in the window in
/// [brackets].
pub fn make_snippet(text: &str, terms: &[String], width: usize) -> String {
    let chars: Vec<char> = text.chars().collect();
    let low: Vec<u16> = chars.iter().map(|c| lower_unit(*c)).collect();
    let needles: Vec<Vec<u16>> = terms
        .iter()
        .filter(|term| !term.is_empty())
        .map(|term| term.chars().map(lower_unit).collect())
        .collect();
    let find_all = |needle: &[u16], lo: usize, hi: usize| -> Vec<(usize, usize)> {
        let mut found = Vec::new();
        if needle.is_empty() || hi < lo + needle.len() {
            return found;
        }
        let mut i = lo;
        while i + needle.len() <= hi {
            if low[i..i + needle.len()] == *needle {
                found.push((i, i + needle.len()));
                i += needle.len();
            } else {
                i += 1;
            }
        }
        found
    };
    let firsts: Vec<usize> = needles
        .iter()
        .filter_map(|needle| find_all(needle, 0, low.len()).first().map(|range| range.0))
        .collect();
    let Some(&first) = firsts.iter().min() else {
        return chars
            .iter()
            .take(2 * width)
            .collect::<String>()
            .replace('\n', " ");
    };
    let a = first.saturating_sub(width);
    let b = (first + width).min(chars.len());
    let mut ranges: Vec<(usize, usize)> = needles
        .iter()
        .flat_map(|needle| find_all(needle, a, b))
        .collect();
    ranges.sort();
    let mut merged: Vec<(usize, usize)> = Vec::new();
    for range in ranges {
        match merged.last_mut() {
            Some(last) if range.0 <= last.1 => last.1 = last.1.max(range.1),
            _ => merged.push(range),
        }
    }
    let mut out = if a > 0 {
        "... ".to_owned()
    } else {
        String::new()
    };
    let mut at = a;
    for (start, end) in merged {
        out.extend(&chars[at..start]);
        out.push('[');
        out.extend(&chars[start..end]);
        out.push(']');
        at = end;
    }
    out.extend(&chars[at..b]);
    if b < chars.len() {
        out.push_str(" ...");
    }
    out.replace('\n', " ")
}

/// The text repo does not exist yet.
pub const NO_TEXT_REPO: &str =
    "the archive has no text repo yet; run `roamgate archive rebuild-text`";

/// How a search runs.
#[derive(Default)]
pub struct SearchOptions<'a> {
    /// This machine, for the sessions grown since the last commit.
    pub runtime: Option<&'a ArchiveRuntime>,
    /// Search the grown sessions too (default when a runtime is given).
    pub live: Option<bool>,
    pub cancel: Option<&'a AtomicBool>,
    /// Progress of a tool output search, in raw/ files.
    pub on_progress: Option<&'a mut dyn FnMut(usize, usize)>,
}

/// The matches of a JavaScript `RegExp(source, "giu")` in `texts`, for
/// snippets (fancy-regex: Perl syntax, close to JavaScript's).
fn regex_terms(source: &str, texts: &[&str]) -> Vec<String> {
    let Ok(pattern) = fancy_regex::Regex::new(&format!("(?i){source}")) else {
        return Vec::new();
    };
    let mut found: Vec<String> = Vec::new();
    for text in texts {
        for found_match in pattern.find_iter(text).flatten() {
            let value = found_match.as_str();
            if !value.is_empty() && !found.iter().any(|seen| seen == value) {
                found.push(value.to_owned());
            }
            if found.len() > 8 {
                break;
            }
        }
    }
    found
}

struct Built {
    hits: Vec<SearchHit>,
    total: u64,
    sessions: u64,
}

fn build_hits(
    files: Vec<Agg>,
    info: &dyn Fn(&str) -> Option<FileInfo>,
    query: &SearchQuery,
    settings: &ArchiveSettings,
    terms: &[String],
) -> Built {
    let mut hits = Vec::new();
    let mut total = 0u64;
    let mut sessions = 0u64;
    for file in rank_files(files, query.recent) {
        let Some(meta) = info(&file.path) else {
            continue;
        };
        let agent = Agent::from_id(&meta.agent);
        let project = Some(project_of_path(&file.path))
            .filter(|p| !p.is_empty())
            .or_else(|| meta.render.project.clone().filter(|p| !p.is_empty()))
            .unwrap_or_default();
        if hidden_by(
            &settings.hide,
            RuleSubject {
                host: &meta.host,
                agent: &meta.agent,
                project: &project,
            },
        ) {
            continue;
        }
        total += file.count;
        sessions += 1;
        if hits.len() >= query.limit.max(1) {
            continue;
        }
        let classified = if meta.history {
            roamgate_agents::FileMeta {
                project: String::new(),
                session: "history".into(),
                subagent: false,
            }
        } else {
            match agent {
                Some(agent) => agent.classify(&meta.relpath),
                None => roamgate_agents::FileMeta {
                    project: project.clone(),
                    session: meta.relpath.clone(),
                    subagent: false,
                },
            }
        };
        let (line, latest) = file.recent.last().cloned().expect("a file has a match");
        let needles = if query.regex {
            regex_terms(
                &query.terms.join(" "),
                &file
                    .recent
                    .iter()
                    .map(|(_, parsed)| parsed.text.as_str())
                    .collect::<Vec<_>>(),
            )
        } else {
            terms.to_vec()
        };
        hits.push(SearchHit {
            session: classified.session,
            agent: meta.agent.clone(),
            host: meta.host.clone(),
            project,
            subagent: classified.subagent,
            title: meta.render.last_title.clone(),
            ts: latest.ts.clone(),
            role: latest.role.clone(),
            kind: latest.kind.clone(),
            tool: latest.tool.clone(),
            snippet: make_snippet(&latest.text, &needles, SNIPPET_WIDTH),
            doc: line,
            cost_usd: meta.render.cost.clone(),
            matches: Some(file.count),
            snippets: Some(
                file.recent
                    .iter()
                    .map(|(_, parsed)| make_snippet(&parsed.text, &needles, SNIPPET_WIDTH))
                    .collect(),
            ),
            path: Some(file.path.clone()),
            key: Some(meta.key.clone()),
        });
    }
    Built {
        hits,
        total,
        sessions,
    }
}

/// Search the conversation text with git grep: words or phrases that must
/// all appear in one message (AND, OR, NOT as the index had them), or one
/// Perl regex; one hit per session, sessions ranked by matching messages,
/// then by the latest one (or newest first with `recent`).
pub fn search_archive(
    archive_dir: &Path,
    query: &SearchQuery,
    settings: &ArchiveSettings,
    mut options: SearchOptions<'_>,
) -> Result<SearchResult> {
    let raw = roamgate_agents::js::js_trim(&query.terms.join(" ")).to_owned();
    if query.tool_output {
        return search_raw(archive_dir, query, settings, options);
    }
    let repo = text_repo_path(archive_dir);
    let Some(head) = head_commit(&repo) else {
        return Err(crate::Error::with_code(NO_TEXT_REPO, "no_text_repo"));
    };
    let node: Option<Node> = if query.regex { None } else { parse_query(&raw) };
    if !query.regex && node.is_none() {
        return Ok(SearchResult::empty(&raw, "text"));
    }
    let patterns: Vec<String> = if query.regex {
        vec!["-P".into(), "-e".into(), raw.clone()]
    } else {
        std::iter::once("-F".to_owned())
            .chain(grep_args(node.as_ref().unwrap()))
            .collect()
    };
    let state = read_text_state(&repo);
    let by_path = state_by_path(state.as_ref());
    let filter = query.line_filter();
    let mut agg = Aggregator::new(|parsed: &ParsedLine| filter.keeps(parsed));
    let pathspecs = transcript_pathspecs(&query.path_filter());
    run_grep(
        GrepIn::Tree(&repo),
        &patterns,
        &pathspecs,
        options.cancel,
        &mut |hit| agg.add(&hit.path, hit.line, parse_text_line(&hit.text)),
    )?;
    let mut overlay: Option<Overlay> = None;
    if let Some(runtime) = options.runtime
        && options.live != Some(false)
    {
        let built = live_overlay(archive_dir, settings, runtime, state.as_ref(), Some(&head))?;
        if !built.files.is_empty() {
            let offsets: HashMap<String, u64> = built
                .files
                .iter()
                .map(|(path, file)| (path.clone(), file.offset))
                .collect();
            run_grep(
                GrepIn::Files(&overlay_files(archive_dir)),
                &patterns,
                &pathspecs,
                options.cancel,
                &mut |hit| {
                    let offset = offsets.get(&hit.path).copied().unwrap_or(0);
                    agg.add(&hit.path, hit.line + offset, parse_text_line(&hit.text))
                },
            )?;
        }
        overlay = Some(built);
    }
    let files = agg.files();
    let terms = node_terms(node.as_ref());
    let built = build_hits(
        files,
        &|path| path_info(path, state.as_ref(), overlay.as_ref(), &by_path),
        query,
        settings,
        &terms,
    );
    let mut result = SearchResult {
        query: raw.clone(),
        total: built.total,
        truncated: built.sessions > built.hits.len() as u64,
        hits: built.hits,
        sessions: Some(built.sessions),
        source: Some("text".into()),
        warning: None,
        history: None,
    };
    if query.history {
        let mut entries = Vec::new();
        run_grep(
            GrepIn::Tree(&repo),
            &patterns,
            &history_pathspecs(query.host.as_deref()),
            options.cancel,
            &mut |hit| {
                let Some(parsed) = parse_text_line(&hit.text) else {
                    return;
                };
                let needles = if query.regex {
                    regex_terms(&raw, &[parsed.text.as_str()])
                } else {
                    terms.clone()
                };
                entries.push(HistoryHit {
                    host: hit.path.split('/').next().unwrap_or("").to_owned(),
                    ts: parsed.ts.clone(),
                    project: parsed.tool.clone().filter(|tool| tool != "-"),
                    snippet: make_snippet(&parsed.text, &needles, SNIPPET_WIDTH),
                })
            },
        )?;
        entries.sort_by(|a, b| {
            b.ts.as_deref()
                .unwrap_or("")
                .cmp(a.ts.as_deref().unwrap_or(""))
        });
        entries.truncate(query.limit);
        result.history = Some(entries);
    }
    let _ = &mut options;
    Ok(result)
}

/// Search everything raw/ holds, tool output included, by reading every
/// transcript: minutes on a large archive, so only on explicit request.
pub fn search_raw(
    archive_dir: &Path,
    query: &SearchQuery,
    settings: &ArchiveSettings,
    mut options: SearchOptions<'_>,
) -> Result<SearchResult> {
    let raw = roamgate_agents::js::js_trim(&query.terms.join(" ")).to_owned();
    let regex;
    let node;
    let mut terms = Vec::new();
    if query.regex {
        regex = Some(
            fancy_regex::Regex::new(&format!("(?i){raw}"))
                .map_err(|error| crate::Error::msg(format!("invalid regex: {error}")))?,
        );
        node = None;
    } else {
        regex = None;
        node = parse_query(&raw);
        let Some(parsed) = &node else {
            return Ok(SearchResult::empty(&raw, "raw"));
        };
        terms = node_terms(Some(parsed));
    }
    let filter = query.line_filter();
    let mut agg = Aggregator::new(|parsed: &ParsedLine| filter.keeps(parsed));
    let mut infos: HashMap<String, FileInfo> = HashMap::new();
    let mut no_progress = |_: usize, _: usize| {};
    let progress: &mut dyn FnMut(usize, usize) = match options.on_progress.as_mut() {
        Some(progress) => *progress,
        None => &mut no_progress,
    };
    raw_docs(
        archive_dir,
        settings,
        &query.path_filter(),
        progress,
        options.cancel,
        &mut |entry| {
            let matched = match (&regex, &node) {
                (Some(pattern), _) => pattern.is_match(&entry.doc.text).unwrap_or(false),
                (None, Some(node)) => node_matches(node, &entry.lower),
                _ => false,
            };
            if !matched {
                return;
            }
            infos.insert(
                entry.key.clone(),
                FileInfo {
                    key: entry.key.clone(),
                    host: entry.host.clone(),
                    agent: entry.agent.clone(),
                    relpath: entry.relpath.clone(),
                    history: false,
                    render: crate::text_render::RenderState {
                        project: Some(entry.project.clone()),
                        ..Default::default()
                    },
                },
            );
            agg.add(
                &entry.key,
                entry.line,
                Some(ParsedLine {
                    ts: entry.ts.clone(),
                    role: entry.doc.role.clone(),
                    kind: entry.doc.kind.clone(),
                    tool: entry.doc.tool.clone(),
                    text: collapse_space(&entry.doc.text, " "),
                }),
            );
        },
    )?;
    let files = agg.files();
    let mut built = build_hits(
        files,
        &|key| infos.get(key).cloned(),
        query,
        settings,
        &terms,
    );
    for hit in &mut built.hits {
        if let Some(project) = hit
            .path
            .as_ref()
            .and_then(|path| infos.get(path))
            .and_then(|info| info.render.project.clone())
        {
            hit.project = project;
        }
        hit.path = None;
    }
    let _ = js_lower;
    Ok(SearchResult {
        query: raw,
        total: built.total,
        truncated: built.sessions > built.hits.len() as u64,
        hits: built.hits,
        sessions: Some(built.sessions),
        source: Some("raw".into()),
        warning: Some(
            "searched tool output by reading every archived transcript in raw/: slow".into(),
        ),
        history: None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn snippets_mark_matches() {
        let text = "the quick brown fox jumps over the lazy dog";
        assert_eq!(
            make_snippet(text, &["QUICK".into(), "the".into()], 120),
            "[the] [quick] brown fox jumps over [the] lazy dog"
        );
        let long = format!("{}needle{}", "a".repeat(200), "b".repeat(200));
        let snippet = make_snippet(&long, &["needle".into()], 10);
        assert_eq!(
            snippet,
            format!("... {}[needle]{} ...", "a".repeat(10), "b".repeat(4))
        );
        assert_eq!(make_snippet("a\nb", &["zzz".into()], 120), "a b");
    }
}
