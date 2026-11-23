//! The files of contract/assets, embedded byte for byte (server/src/assets):
//! the scripts Roamgate runs on its hosts and installs there, the login
//! page, the rendered helper and the voice model catalog. Both servers embed
//! these same bytes (contract/assets/README.md); `{{...}}` tags are filled
//! by [`fill_template`].
//!
//! - `{{name}}` is a value written as given (quoting is the caller's);
//! - `{{#name}}...{{/name}}` is kept when `name` is true, and
//!   `{{^name}}...{{/name}}` when it is false.
//!
//! Nothing else is special, so a template is the script it sends but for
//! its tags. Every tag needs its value and every value its tag: a mismatch
//! is an error, so a template and its caller cannot drift apart silently.

use std::collections::{BTreeMap, BTreeSet};
use std::sync::OnceLock;

use serde_json::Value;

/// contract/assets/html/login.html
pub const LOGIN_HTML_TEMPLATE: &str = include_str!("../../../contract/assets/html/login.html");
/// contract/assets/js/rendered-helper.js
pub const RENDERED_HELPER_JS: &str = include_str!("../../../contract/assets/js/rendered-helper.js");
/// contract/assets/ps1/herdr-bridge.ps1
pub const HERDR_BRIDGE_PS1: &str = include_str!("../../../contract/assets/ps1/herdr-bridge.ps1");
/// contract/assets/ps1/herdr-probe.ps1
pub const HERDR_PROBE_PS1: &str = include_str!("../../../contract/assets/ps1/herdr-probe.ps1");
/// contract/assets/ps1/list-directory.ps1
pub const LIST_DIRECTORY_PS1: &str =
    include_str!("../../../contract/assets/ps1/list-directory.ps1");
/// contract/assets/ps1/task-status.ps1
pub const TASK_STATUS_PS1: &str = include_str!("../../../contract/assets/ps1/task-status.ps1");
/// contract/assets/ps1/task-wait-stopped.ps1
pub const TASK_WAIT_STOPPED_PS1: &str =
    include_str!("../../../contract/assets/ps1/task-wait-stopped.ps1");
/// contract/assets/python/claude-start-hook-install.py
pub const CLAUDE_START_HOOK_INSTALL_PY: &str =
    include_str!("../../../contract/assets/python/claude-start-hook-install.py");
/// contract/assets/python/codex-session-find.py
pub const CODEX_SESSION_FIND_PY: &str =
    include_str!("../../../contract/assets/python/codex-session-find.py");
/// contract/assets/python/exclusive-rename.py
pub const EXCLUSIVE_RENAME_PY: &str =
    include_str!("../../../contract/assets/python/exclusive-rename.py");
/// contract/assets/python/herdr-relay.py
pub const HERDR_RELAY_PY: &str = include_str!("../../../contract/assets/python/herdr-relay.py");
/// contract/assets/python/roamgate-hold.py
pub const ROAMGATE_HOLD_PY: &str = include_str!("../../../contract/assets/python/roamgate-hold.py");
/// contract/assets/python/roamgate-review.py
pub const ROAMGATE_REVIEW_PY: &str =
    include_str!("../../../contract/assets/python/roamgate-review.py");
/// contract/assets/sh/batch-block.sh
pub const BATCH_BLOCK_SH: &str = include_str!("../../../contract/assets/sh/batch-block.sh");
/// contract/assets/sh/batch.sh
pub const BATCH_SH: &str = include_str!("../../../contract/assets/sh/batch.sh");
/// contract/assets/sh/capped-diff.sh
pub const CAPPED_DIFF_SH: &str = include_str!("../../../contract/assets/sh/capped-diff.sh");
/// contract/assets/sh/claude-successor.sh
pub const CLAUDE_SUCCESSOR_SH: &str =
    include_str!("../../../contract/assets/sh/claude-successor.sh");
/// contract/assets/sh/combined-diff.sh
pub const COMBINED_DIFF_SH: &str = include_str!("../../../contract/assets/sh/combined-diff.sh");
/// contract/assets/sh/compare-refs.sh
pub const COMPARE_REFS_SH: &str = include_str!("../../../contract/assets/sh/compare-refs.sh");
/// contract/assets/sh/delete-file.sh
pub const DELETE_FILE_SH: &str = include_str!("../../../contract/assets/sh/delete-file.sh");
/// contract/assets/sh/delete-untracked.sh
pub const DELETE_UNTRACKED_SH: &str =
    include_str!("../../../contract/assets/sh/delete-untracked.sh");
/// contract/assets/sh/diff-base-refs.sh
pub const DIFF_BASE_REFS_SH: &str = include_str!("../../../contract/assets/sh/diff-base-refs.sh");
/// contract/assets/sh/diff-base-relation.sh
pub const DIFF_BASE_RELATION_SH: &str =
    include_str!("../../../contract/assets/sh/diff-base-relation.sh");
/// contract/assets/sh/download-file.sh
pub const DOWNLOAD_FILE_SH: &str = include_str!("../../../contract/assets/sh/download-file.sh");
/// contract/assets/sh/find-session.sh
pub const FIND_SESSION_SH: &str = include_str!("../../../contract/assets/sh/find-session.sh");
/// contract/assets/sh/git-status-block.sh
pub const GIT_STATUS_BLOCK_SH: &str =
    include_str!("../../../contract/assets/sh/git-status-block.sh");
/// contract/assets/sh/html-preview-files.sh
pub const HTML_PREVIEW_FILES_SH: &str =
    include_str!("../../../contract/assets/sh/html-preview-files.sh");
/// contract/assets/sh/last-step-refs.sh
pub const LAST_STEP_REFS_SH: &str = include_str!("../../../contract/assets/sh/last-step-refs.sh");
/// contract/assets/sh/list-directory.sh
pub const LIST_DIRECTORY_SH: &str = include_str!("../../../contract/assets/sh/list-directory.sh");
/// contract/assets/sh/list-files.sh
pub const LIST_FILES_SH: &str = include_str!("../../../contract/assets/sh/list-files.sh");
/// contract/assets/sh/mutate-file.sh
pub const MUTATE_FILE_SH: &str = include_str!("../../../contract/assets/sh/mutate-file.sh");
/// contract/assets/sh/process-cwds.sh
pub const PROCESS_CWDS_SH: &str = include_str!("../../../contract/assets/sh/process-cwds.sh");
/// contract/assets/sh/read-file.sh
pub const READ_FILE_SH: &str = include_str!("../../../contract/assets/sh/read-file.sh");
/// contract/assets/sh/read-session-tail.sh
pub const READ_SESSION_TAIL_SH: &str =
    include_str!("../../../contract/assets/sh/read-session-tail.sh");
/// contract/assets/sh/repo-info-block.sh
pub const REPO_INFO_BLOCK_SH: &str = include_str!("../../../contract/assets/sh/repo-info-block.sh");
/// contract/assets/sh/resolve-files.sh
pub const RESOLVE_FILES_SH: &str = include_str!("../../../contract/assets/sh/resolve-files.sh");
/// contract/assets/sh/shell-job.sh
pub const SHELL_JOB_SH: &str = include_str!("../../../contract/assets/sh/shell-job.sh");
/// contract/assets/sh/site-root.sh
pub const SITE_ROOT_SH: &str = include_str!("../../../contract/assets/sh/site-root.sh");
/// contract/assets/sh/stat-batch.sh
pub const STAT_BATCH_SH: &str = include_str!("../../../contract/assets/sh/stat-batch.sh");
/// contract/assets/sh/stat-file.sh
pub const STAT_FILE_SH: &str = include_str!("../../../contract/assets/sh/stat-file.sh");
/// contract/assets/sh/stat-loop.sh
pub const STAT_LOOP_SH: &str = include_str!("../../../contract/assets/sh/stat-loop.sh");
/// contract/assets/sh/step-snapshot.sh
pub const STEP_SNAPSHOT_SH: &str = include_str!("../../../contract/assets/sh/step-snapshot.sh");
/// contract/assets/sh/untracked-numstat.sh
pub const UNTRACKED_NUMSTAT_SH: &str =
    include_str!("../../../contract/assets/sh/untracked-numstat.sh");
/// contract/assets/sh/untracked-stats.sh
pub const UNTRACKED_STATS_SH: &str = include_str!("../../../contract/assets/sh/untracked-stats.sh");
/// contract/assets/sh/update-install.sh
pub const UPDATE_INSTALL_SH: &str = include_str!("../../../contract/assets/sh/update-install.sh");
/// contract/assets/sh/upload-cleanup.sh
pub const UPLOAD_CLEANUP_SH: &str = include_str!("../../../contract/assets/sh/upload-cleanup.sh");
/// contract/assets/sh/upload-file.sh
pub const UPLOAD_FILE_SH: &str = include_str!("../../../contract/assets/sh/upload-file.sh");
/// contract/assets/sh/upload-write.sh
pub const UPLOAD_WRITE_SH: &str = include_str!("../../../contract/assets/sh/upload-write.sh");
/// contract/assets/sh/worktree-state.sh
pub const WORKTREE_STATE_SH: &str = include_str!("../../../contract/assets/sh/worktree-state.sh");

/// Every text asset by its path under contract/assets.
pub const ASSET_TEXTS: &[(&str, &str)] = &[
    ("html/login.html", LOGIN_HTML_TEMPLATE),
    ("js/rendered-helper.js", RENDERED_HELPER_JS),
    ("ps1/herdr-bridge.ps1", HERDR_BRIDGE_PS1),
    ("ps1/herdr-probe.ps1", HERDR_PROBE_PS1),
    ("ps1/list-directory.ps1", LIST_DIRECTORY_PS1),
    ("ps1/task-status.ps1", TASK_STATUS_PS1),
    ("ps1/task-wait-stopped.ps1", TASK_WAIT_STOPPED_PS1),
    (
        "python/claude-start-hook-install.py",
        CLAUDE_START_HOOK_INSTALL_PY,
    ),
    ("python/codex-session-find.py", CODEX_SESSION_FIND_PY),
    ("python/exclusive-rename.py", EXCLUSIVE_RENAME_PY),
    ("python/herdr-relay.py", HERDR_RELAY_PY),
    ("python/roamgate-hold.py", ROAMGATE_HOLD_PY),
    ("python/roamgate-review.py", ROAMGATE_REVIEW_PY),
    ("sh/batch-block.sh", BATCH_BLOCK_SH),
    ("sh/batch.sh", BATCH_SH),
    ("sh/capped-diff.sh", CAPPED_DIFF_SH),
    ("sh/claude-successor.sh", CLAUDE_SUCCESSOR_SH),
    ("sh/combined-diff.sh", COMBINED_DIFF_SH),
    ("sh/compare-refs.sh", COMPARE_REFS_SH),
    ("sh/delete-file.sh", DELETE_FILE_SH),
    ("sh/delete-untracked.sh", DELETE_UNTRACKED_SH),
    ("sh/diff-base-refs.sh", DIFF_BASE_REFS_SH),
    ("sh/diff-base-relation.sh", DIFF_BASE_RELATION_SH),
    ("sh/download-file.sh", DOWNLOAD_FILE_SH),
    ("sh/find-session.sh", FIND_SESSION_SH),
    ("sh/git-status-block.sh", GIT_STATUS_BLOCK_SH),
    ("sh/html-preview-files.sh", HTML_PREVIEW_FILES_SH),
    ("sh/last-step-refs.sh", LAST_STEP_REFS_SH),
    ("sh/list-directory.sh", LIST_DIRECTORY_SH),
    ("sh/list-files.sh", LIST_FILES_SH),
    ("sh/mutate-file.sh", MUTATE_FILE_SH),
    ("sh/process-cwds.sh", PROCESS_CWDS_SH),
    ("sh/read-file.sh", READ_FILE_SH),
    ("sh/read-session-tail.sh", READ_SESSION_TAIL_SH),
    ("sh/repo-info-block.sh", REPO_INFO_BLOCK_SH),
    ("sh/resolve-files.sh", RESOLVE_FILES_SH),
    ("sh/shell-job.sh", SHELL_JOB_SH),
    ("sh/site-root.sh", SITE_ROOT_SH),
    ("sh/stat-batch.sh", STAT_BATCH_SH),
    ("sh/stat-file.sh", STAT_FILE_SH),
    ("sh/stat-loop.sh", STAT_LOOP_SH),
    ("sh/step-snapshot.sh", STEP_SNAPSHOT_SH),
    ("sh/untracked-numstat.sh", UNTRACKED_NUMSTAT_SH),
    ("sh/untracked-stats.sh", UNTRACKED_STATS_SH),
    ("sh/update-install.sh", UPDATE_INSTALL_SH),
    ("sh/upload-cleanup.sh", UPLOAD_CLEANUP_SH),
    ("sh/upload-file.sh", UPLOAD_FILE_SH),
    ("sh/upload-write.sh", UPLOAD_WRITE_SH),
    ("sh/worktree-state.sh", WORKTREE_STATE_SH),
    ("skill/SKILL.md", REVIEW_SKILL_MD),
];

/// contract/assets/data/voice-models.json, as text.
pub const VOICE_MODELS_JSON: &str = include_str!("../../../contract/assets/data/voice-models.json");
const TOOL_CATALOG_JSON: &str = include_str!("../../../contract/tools/catalog.json");

/// contract/assets/skill/SKILL.md
pub const REVIEW_SKILL_MD: &str = include_str!("../../../contract/assets/skill/SKILL.md");

/// The voice model catalog.
pub fn voice_models() -> &'static Value {
    static PARSED: OnceLock<Value> = OnceLock::new();
    PARSED
        .get_or_init(|| serde_json::from_str(VOICE_MODELS_JSON).expect("voice-models.json is JSON"))
}

/// The Claude mod's name in its requests (`via`), a constant of the tool
/// catalog (contract/tools/catalog.json), which the mod reads too.
pub fn mod_via() -> &'static str {
    static VIA: OnceLock<String> = OnceLock::new();
    VIA.get_or_init(|| {
        let catalog: Value = serde_json::from_str(TOOL_CATALOG_JSON).expect("catalog.json is JSON");
        catalog["constants"]["MOD_VIA"]
            .as_str()
            .expect("MOD_VIA")
            .to_owned()
    })
}

/// A template's value: text or a number written as given, or a section's
/// flag.
#[derive(Debug, Clone, PartialEq)]
pub enum TemplateValue {
    Text(String),
    Number(f64),
    Flag(bool),
}

impl From<&str> for TemplateValue {
    fn from(text: &str) -> Self {
        Self::Text(text.to_owned())
    }
}

impl From<String> for TemplateValue {
    fn from(text: String) -> Self {
        Self::Text(text)
    }
}

impl From<bool> for TemplateValue {
    fn from(flag: bool) -> Self {
        Self::Flag(flag)
    }
}

impl From<i64> for TemplateValue {
    fn from(number: i64) -> Self {
        Self::Number(number as f64)
    }
}

impl From<f64> for TemplateValue {
    fn from(number: f64) -> Self {
        Self::Number(number)
    }
}

/// JavaScript's `String(number)` for the numbers templates take.
fn number_text(number: f64) -> String {
    if number.fract() == 0.0 && number.abs() < 1e21 {
        format!("{}", number as i64)
    } else {
        format!("{number}")
    }
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("template: {0}")]
pub struct TemplateError(String);

#[derive(Debug)]
enum Node<'a> {
    Text(&'a str),
    Value(&'a str),
    Section {
        name: &'a str,
        inverted: bool,
        body: Vec<Node<'a>>,
    },
}

/// The tags of a template: `{{` then an optional `#`, `^` or `/`, then a
/// name (`[A-Za-z_][A-Za-z0-9_]*`), then `}}`.
fn tags(template: &str) -> Vec<(usize, usize, Option<u8>, &str)> {
    let bytes = template.as_bytes();
    let mut out = Vec::new();
    let mut at = 0;
    while let Some(found) = template[at..].find("{{") {
        let start = at + found;
        let mut index = start + 2;
        let sigil = match bytes.get(index) {
            Some(&byte @ (b'#' | b'^' | b'/')) => {
                index += 1;
                Some(byte)
            }
            _ => None,
        };
        let name_start = index;
        if bytes
            .get(index)
            .is_some_and(|byte| byte.is_ascii_alphabetic() || *byte == b'_')
        {
            index += 1;
            while bytes
                .get(index)
                .is_some_and(|byte| byte.is_ascii_alphanumeric() || *byte == b'_')
            {
                index += 1;
            }
            if template[index..].starts_with("}}") {
                out.push((start, index + 2, sigil, &template[name_start..index]));
                at = index + 2;
                continue;
            }
        }
        at = start + 1;
    }
    out
}

fn parse(template: &str) -> Result<Vec<Node<'_>>, TemplateError> {
    let mut stack: Vec<(&str, bool, Vec<Node<'_>>)> = vec![("", false, Vec::new())];
    let mut at = 0;
    for (start, end, sigil, name) in tags(template) {
        let top = stack.last_mut().expect("root");
        if start > at {
            top.2.push(Node::Text(&template[at..start]));
        }
        at = end;
        match sigil {
            Some(b'/') => {
                if top.0 != name {
                    return Err(TemplateError(format!(
                        "{{{{/{name}}}}} closes {{{{{}}}}}",
                        top.0
                    )));
                }
                let (name, inverted, body) = stack.pop().expect("section");
                stack.last_mut().expect("root").2.push(Node::Section {
                    name,
                    inverted,
                    body,
                });
            }
            Some(sigil) => stack.push((name, sigil == b'^', Vec::new())),
            None => top.2.push(Node::Value(name)),
        }
    }
    if stack.len() > 1 {
        return Err(TemplateError(format!(
            "{{{{{}}}}} not closed",
            stack.last().expect("open").0
        )));
    }
    let mut root = stack.pop().expect("root").2;
    if at < template.len() {
        root.push(Node::Text(&template[at..]));
    }
    Ok(root)
}

fn names<'a>(nodes: &[Node<'a>], into: &mut BTreeSet<&'a str>) {
    for node in nodes {
        match node {
            Node::Text(_) => {}
            Node::Value(name) => {
                into.insert(name);
            }
            Node::Section { name, body, .. } => {
                into.insert(name);
                names(body, into);
            }
        }
    }
}

fn render(
    nodes: &[Node<'_>],
    values: &BTreeMap<&str, TemplateValue>,
    out: &mut String,
) -> Result<(), TemplateError> {
    for node in nodes {
        match node {
            Node::Text(text) => out.push_str(text),
            Node::Value(name) => match &values[name] {
                TemplateValue::Flag(_) => {
                    return Err(TemplateError(format!("{{{{{name}}}}} is a section's flag")));
                }
                TemplateValue::Text(text) => out.push_str(text),
                TemplateValue::Number(number) => out.push_str(&number_text(*number)),
            },
            Node::Section {
                name,
                inverted,
                body,
            } => match &values[name] {
                TemplateValue::Flag(flag) => {
                    if flag != inverted {
                        render(body, values, out)?;
                    }
                }
                _ => {
                    return Err(TemplateError(format!(
                        "{{{{#{name}}}}} needs true or false"
                    )));
                }
            },
        }
    }
    Ok(())
}

/// The template with its tags filled from `values`.
pub fn fill_template(
    template: &str,
    values: &[(&str, TemplateValue)],
) -> Result<String, TemplateError> {
    let nodes = parse(template)?;
    let mut used = BTreeSet::new();
    names(&nodes, &mut used);
    let values: BTreeMap<&str, TemplateValue> = values
        .iter()
        .map(|(name, value)| (*name, value.clone()))
        .collect();
    for name in &used {
        if !values.contains_key(name) {
            return Err(TemplateError(format!("no value for {{{{{name}}}}}")));
        }
    }
    for name in values.keys() {
        if !used.contains(name) {
            return Err(TemplateError(format!("no {{{{{name}}}}} to fill")));
        }
    }
    let mut out = String::new();
    render(&nodes, &values, &mut out)?;
    Ok(out)
}

/// The names a template asks for, sorted.
pub fn template_names(template: &str) -> Result<Vec<String>, TemplateError> {
    let mut used = BTreeSet::new();
    names(&parse(template)?, &mut used);
    Ok(used.into_iter().map(str::to_owned).collect())
}

#[cfg(test)]
mod tests;
