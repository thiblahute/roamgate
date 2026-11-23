//! `grok-session.ts`: Grok's sessions, one directory each beside its
//! summary, and what of its records is the user's.

use std::path::{Path, PathBuf};
use std::sync::LazyLock;

use regex::Regex;
use serde_json::Value;

use crate::js::{self, Obj, sv};
use crate::session::SessionFile;
use crate::utils::{clean_message_text, text_from_content};

/// What Grok wrote of the user: the explicit query only.
pub fn grok_user_message_text(record: &Obj) -> String {
    static QUERY: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"(?i)<user_query>\s*([\s\S]*?)\s*</user_query>").unwrap());
    static STRIP: LazyLock<Vec<Regex>> = LazyLock::new(|| {
        [
            r"(?i)<user_info>[\s\S]*?</user_info>",
            r"(?i)<git_status>[\s\S]*?</git_status>",
            r"(?i)<system-reminder>[\s\S]*?</system-reminder>",
        ]
        .iter()
        .map(|p| Regex::new(p).unwrap())
        .collect()
    });
    if sv(record.get("type")) != "user" || !sv(record.get("synthetic_reason")).is_empty() {
        return String::new();
    }
    let content = text_from_content(record.get("content"));
    let queries: Vec<String> = QUERY
        .captures_iter(&content)
        .map(|c| clean_message_text(c.get(1).map_or("", |m| m.as_str())))
        .filter(|q| !q.is_empty())
        .collect();
    if !queries.is_empty() {
        return queries.join("\n\n");
    }
    let mut text = content;
    for pattern in STRIP.iter() {
        text = pattern.replace_all(&text, "").into_owned();
    }
    clean_message_text(&text)
}

pub fn grok_reasoning_text(record: &Obj) -> String {
    let source = match record.get("summary") {
        None | Some(Value::Null) => record.get("content"),
        other => other,
    };
    clean_message_text(&text_from_content(source))
}

/// Grok's home: `GROK_HOME`, else `~/.grok`.
pub fn grok_home(home: &Path, configured: Option<&str>) -> PathBuf {
    let configured = configured.map(js::trim).unwrap_or("");
    if configured.is_empty() {
        return home.join(".grok");
    }
    if configured == "~" {
        return home.to_path_buf();
    }
    if let Some(rest) = configured.strip_prefix("~/") {
        return home.join(rest);
    }
    crate::paths::resolve(configured)
}

pub fn grok_sessions_root(home: &Path, configured: Option<&str>) -> PathBuf {
    grok_home(home, configured).join("sessions")
}

/// A Grok session: its summary's facts and its transcript.
#[derive(Debug, Clone)]
pub struct GrokSession {
    pub session_id: String,
    pub cwd: String,
    pub file: SessionFile,
}

fn date_value_ms(value: Option<&Value>) -> Option<f64> {
    let text = value
        .and_then(Value::as_str)
        .filter(|t| !js::trim(t).is_empty())?;
    let parsed = js::date_parse(text);
    parsed.is_finite().then_some(parsed)
}

fn describe_session_directory(dir: &Path) -> Option<GrokSession> {
    let transcript = dir.join("chat_history.jsonl");
    let summary_path = dir.join("summary.json");
    if !transcript.exists() || !summary_path.exists() {
        return None;
    }
    let raw = js::parse(&std::fs::read_to_string(&summary_path).ok()?)?;
    let raw = raw.as_object()?;
    let empty = Obj::new();
    let info = js::rec(raw.get("info")).unwrap_or(&empty);
    let dir_name = dir
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    let session_id = js::truthy(sv(info.get("id")))
        .map(str::to_owned)
        .unwrap_or(dir_name);
    if session_id.is_empty() {
        return None;
    }
    let meta = std::fs::metadata(&transcript)
        .ok()
        .filter(|m| m.is_file())?;
    let updated = date_value_ms(raw.get("updated_at"));
    Some(GrokSession {
        session_id: session_id.clone(),
        cwd: sv(info.get("cwd")).to_owned(),
        file: SessionFile {
            path: transcript.to_string_lossy().into_owned(),
            mtime_ms: updated.unwrap_or_else(|| crate::paths::mtime_ms(&meta)),
            size: Some(meta.len() as f64),
            session_id: Some(session_id),
            created_at_ms: date_value_ms(raw.get("created_at")),
            model_name: js::truthy(sv(raw.get("current_model_id"))).map(str::to_owned),
            agent_version: js::truthy(sv(raw.get("version"))).map(str::to_owned),
            ..Default::default()
        },
    })
}

fn newest(dirs: Vec<PathBuf>, cwd: Option<&str>) -> Option<GrokSession> {
    let mut found: Vec<GrokSession> = dirs
        .iter()
        .filter_map(|dir| describe_session_directory(dir))
        .filter(|item| match cwd {
            None => true,
            Some(cwd) => {
                !item.cwd.is_empty()
                    && crate::paths::resolve(&item.cwd) == crate::paths::resolve(cwd)
            }
        })
        .collect();
    found.sort_by(|a, b| {
        b.file
            .mtime_ms
            .partial_cmp(&a.file.mtime_ms)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    found.into_iter().next()
}

fn subdirs(root: &Path) -> Option<Vec<PathBuf>> {
    let entries = std::fs::read_dir(root).ok()?;
    let mut dirs: Vec<PathBuf> = entries
        .filter_map(Result::ok)
        .filter(|e| e.file_type().is_ok_and(|t| t.is_dir()))
        .map(|e| e.path())
        .collect();
    dirs.sort();
    Some(dirs)
}

/// The newest session of a directory (Grok percent-encodes it).
pub fn find_grok_session_for_cwd(cwd: &str, root: &Path) -> Option<GrokSession> {
    if cwd.is_empty() {
        return None;
    }
    let cwd_root = root.join(crate::paths::encode_uri_component(
        &crate::paths::resolve(cwd).to_string_lossy(),
    ));
    newest(subdirs(&cwd_root)?, Some(cwd))
}

fn safe_session_id(value: &str) -> bool {
    !value.is_empty() && value != "." && value != ".." && !value.contains(['\\', '/', '\0'])
}

/// A session by id: in its directory's folder first, else any folder.
pub fn find_grok_session_by_id(id: &str, cwd: &str, root: &Path) -> Option<GrokSession> {
    if !safe_session_id(id) {
        return None;
    }
    if !cwd.is_empty() {
        let direct = root
            .join(crate::paths::encode_uri_component(
                &crate::paths::resolve(cwd).to_string_lossy(),
            ))
            .join(id);
        if let Some(found) = describe_session_directory(&direct) {
            return Some(found);
        }
    }
    let dirs = subdirs(root)?;
    newest(dirs.into_iter().map(|d| d.join(id)).collect(), None)
}

/// A session directory or a file inside it.
pub fn describe_grok_session_path(path: &Path) -> Option<GrokSession> {
    let meta = std::fs::metadata(path).ok()?;
    if meta.is_dir() {
        describe_session_directory(path)
    } else {
        describe_session_directory(path.parent()?)
    }
}
