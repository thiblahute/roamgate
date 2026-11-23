//! Opens an archived session at a search hit (archive/open.ts): the records
//! around it, read from raw/ (whole messages, tool output included), with
//! the hit marked. A text repo hit names a line of the rendered text; the
//! transcript is rendered again until that line to find its record.

use std::io::Read;
use std::path::Path;
use std::sync::LazyLock;

use regex::Regex;
use roamgate_agents::js::{parse_line, utf16_len, utf16_prefix};
use roamgate_agents::{Agent, ParseState};
use serde::{Deserialize, Serialize};

use crate::hosts::{ArchiveRuntime, local_root, resolve_hosts};
use crate::lines::{CompleteLines, file_range};
use crate::settings::{ArchiveSettings, RuleSubject};
use crate::store::Result;
use crate::sync::zst_path;
use crate::text_render::TextRenderer;
use crate::text_repo::render_options_for;
use crate::text_search::hidden_by;
use crate::zstd_frames::read_archived;

/// Records shown before and after the hit.
pub const OPEN_CONTEXT: usize = 12;
const MESSAGE_CHARS: usize = 6000;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct OpenedMessage {
    pub role: String,
    pub kind: String,
    pub tool: Option<String>,
    pub text: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct OpenedRecord {
    /// The record's line in the transcript, from 1.
    pub line: u64,
    pub ts: Option<String>,
    pub messages: Vec<OpenedMessage>,
    pub hit: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct OpenedSession {
    pub key: String,
    pub host: String,
    pub agent: String,
    pub relpath: String,
    pub session: String,
    pub project: String,
    pub title: Option<String>,
    pub cwd: Option<String>,
    /// The hit's record line; None when it was not found.
    pub hit: Option<u64>,
    pub records: Vec<OpenedRecord>,
    /// More records before the first and after the last shown.
    pub before: bool,
    pub after: bool,
}

/// What to open.
#[derive(Debug, Clone)]
pub struct OpenRequest {
    pub key: String,
    /// A text repo line, or a raw record line with `raw`.
    pub line: i64,
    pub raw: bool,
    pub context: Option<i64>,
}

static SAFE_KEY: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^[A-Za-z0-9][A-Za-z0-9._-]*/[a-z0-9_-]+/[^\x00]+$").unwrap());

fn clip_text(text: &str) -> String {
    if utf16_len(text) > MESSAGE_CHARS {
        format!("{} [...]", utf16_prefix(text, MESSAGE_CHARS))
    } else {
        text.to_owned()
    }
}

/// The transcript's bytes: this machine's live file when it holds more
/// than raw/.
fn transcript(
    archive_dir: &Path,
    settings: &ArchiveSettings,
    runtime: Option<&ArchiveRuntime>,
    host: &str,
    agent: Agent,
    relpath: &str,
) -> Option<Box<dyn Read>> {
    let zst = zst_path(archive_dir, host, agent.id(), relpath);
    if let Some(runtime) = runtime
        && !relpath.starts_with('@')
        && let Some(me) = resolve_hosts(settings, runtime).into_iter().next()
        && me.id == host
    {
        let live = local_root(agent, &me, runtime).join(relpath);
        if let Ok(metadata) = std::fs::metadata(&live)
            && metadata.len() > 0
            && let Ok(range) = file_range(&live, 0, metadata.len())
        {
            return Some(Box::new(range));
        }
    }
    if zst.exists() {
        read_archived(&zst)
            .ok()
            .map(|reader| Box::new(reader) as Box<dyn Read>)
    } else {
        None
    }
}

pub fn open_archived(
    archive_dir: &Path,
    settings: &ArchiveSettings,
    request: &OpenRequest,
    runtime: Option<&ArchiveRuntime>,
) -> Result<Option<OpenedSession>> {
    if !SAFE_KEY.is_match(&request.key)
        || request
            .key
            .split('/')
            .any(|part| part == ".." || part == ".")
    {
        return Ok(None);
    }
    let mut parts = request.key.splitn(3, '/');
    let host = parts.next().unwrap_or("").to_owned();
    let agent_id = parts.next().unwrap_or("").to_owned();
    let relpath = parts.next().unwrap_or("").to_owned();
    let Some(agent) = Agent::from_id(&agent_id) else {
        return Ok(None);
    };
    if !agent.indexable() || relpath.starts_with('@') || !agent.accepts(&relpath) {
        return Ok(None);
    }
    let meta = agent.classify(&relpath);
    if hidden_by(
        &settings.hide,
        RuleSubject {
            host: &host,
            agent: &agent_id,
            project: &meta.project,
        },
    ) {
        return Ok(None);
    }
    let Some(chunks) = transcript(archive_dir, settings, runtime, &host, agent, &relpath) else {
        return Ok(None);
    };
    let context = request.context.unwrap_or(OPEN_CONTEXT as i64).clamp(1, 60) as usize;
    let mut renderer = TextRenderer::new(agent, false, render_options_for(settings), None);
    let mut parse = ParseState::new(settings.thinking);
    let mut before: std::collections::VecDeque<OpenedRecord> = Default::default();
    let mut after = Vec::new();
    let mut hit: Option<OpenedRecord> = None;
    let mut more = false;
    let mut dropped = false;
    let mut title: Option<String> = None;
    let mut line = 0i64;
    let mut last_ts: Option<String> = None;
    let mut lines = CompleteLines::new(chunks);
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
        let messages: Vec<OpenedMessage> = agent
            .parse(&record, &mut parse)
            .into_iter()
            .map(|doc| {
                if doc.kind == "title" {
                    title = Some(doc.text.clone());
                }
                OpenedMessage {
                    role: doc.role,
                    kind: doc.kind,
                    tool: doc.tool,
                    text: clip_text(&doc.text),
                }
            })
            .collect();
        let mut is_hit = false;
        if hit.is_none() {
            if request.raw {
                is_hit = line == request.line;
            } else {
                // The text line this record's messages end at (the header
                // is line 1).
                let raw = raw.to_vec();
                renderer.line(&raw);
                is_hit = renderer.lines.len() as i64 + 1 >= request.line;
            }
        }
        if messages.is_empty() && !is_hit {
            continue;
        }
        let entry = OpenedRecord {
            line: line as u64,
            ts: last_ts.clone(),
            messages,
            hit: is_hit,
        };
        if is_hit {
            hit = Some(entry);
        } else if hit.is_none() {
            before.push_back(entry);
            if before.len() > context {
                before.pop_front();
                dropped = true;
            }
        } else if after.len() < context {
            after.push(entry);
        } else {
            more = true;
            break;
        }
    }
    let hit_line = hit.as_ref().map(|hit| hit.line);
    let mut records: Vec<OpenedRecord> = before.into_iter().collect();
    if let Some(hit) = hit {
        records.push(hit);
        records.extend(after);
    }
    Ok(Some(OpenedSession {
        key: request.key.clone(),
        host,
        agent: agent_id,
        relpath,
        session: meta.session,
        project: parse
            .project
            .filter(|p| !p.is_empty())
            .unwrap_or(meta.project),
        title,
        cwd: parse.cwd,
        hit: hit_line,
        records,
        before: dropped,
        after: more,
    }))
}
