//! Changes' summary and file diffs (workspace/git-diff.ts): the working
//! tree, a branch against its base, and an agent's last step between two
//! snapshots; the parsers of porcelain, name-status, numstat and
//! attributes; patches capped before they leave the host; several
//! scripts in one command; `git pull --ff-only`.

use std::collections::{BTreeMap, BTreeSet};
use std::sync::{Arc, LazyLock, Mutex};
use std::time::{Duration, Instant};

use futures_util::future::join_all;
use regex::Regex;
use roamgate_base::assets::{
    BATCH_BLOCK_SH, BATCH_SH, CAPPED_DIFF_SH, LAST_STEP_REFS_SH, UNTRACKED_NUMSTAT_SH,
    fill_template,
};
use serde::Serialize;
use serde_json::{Map, Value, json};

use crate::actions::{ActionContext, collect_worktree_fingerprints, is_conflicted};
use crate::combined::{
    CombinedStaged, combined_diff_script, cut_patch, parse_combined_diff_output, skip_login_noise,
};
use crate::compare::{js_number, locale_compare_base, safe_size};
use crate::diff_base::{Requested, parse_refs_output, refs_script, resolve_default_base, select_diff_base};
use crate::exec::{GitContext, Ran};
use crate::shell::shell_command;
use crate::steps::LastStepStore;
use crate::{
    GIT_DIFF_MAX_BYTES, GIT_DIFF_TIMEOUT, GIT_PULL_TIMEOUT, GIT_UNTRACKED_NUMSTAT_BATCH_SIZE,
    GIT_UNTRACKED_NUMSTAT_CONCURRENCY, GIT_UNTRACKED_NUMSTAT_MAX_FILES, GitError,
    LARGE_DIFF_PATCH_BYTES, Result, first_text, marker, sanitize_explorer_path, shell_quote,
};

const GIT_ATTRIBUTE_BATCH_SIZE: usize = 100;

/// Undoes git's C quoting of a path (`"a\nb"`); core.quotepath=false only
/// keeps non-ASCII raw.
pub fn unquote_git_path(path: &str) -> String {
    let chars: Vec<char> = path.chars().collect();
    if chars.len() < 2 || chars[0] != '"' || chars[chars.len() - 1] != '"' {
        return path.to_owned();
    }
    let body = &chars[1..chars.len() - 1];
    let mut result = String::new();
    let mut index = 0;
    while index < body.len() {
        let char = body[index];
        if char != '\\' {
            result.push(char);
            index += 1;
            continue;
        }
        index += 1;
        let Some(&next) = body.get(index) else {
            result.push('\\');
            break;
        };
        if ('0'..='7').contains(&next) {
            let octal: String = body[index..(index + 3).min(body.len())].iter().collect();
            if octal.len() == 3 && octal.chars().all(|c| ('0'..='7').contains(&c)) {
                // String.fromCharCode of the byte: one UTF-16 unit.
                let code = u32::from_str_radix(&octal, 8).unwrap_or(0);
                result.push(char::from_u32(code).unwrap_or('\u{fffd}'));
                index += 3;
                continue;
            }
            result.push(next);
            index += 1;
            continue;
        }
        result.push(match next {
            'a' => '\x07',
            'b' => '\x08',
            'f' => '\x0c',
            'n' => '\n',
            'r' => '\r',
            't' => '\t',
            'v' => '\x0b',
            '\\' => '\\',
            other => other,
        });
        index += 1;
    }
    result
}

pub fn status_label(code: &str, kind: &str) -> &'static str {
    match kind {
        "untracked" => return "untracked",
        "conflicted" => return "conflicted",
        _ => {}
    }
    match code {
        "A" => "added",
        "D" => "deleted",
        "R" => "renamed",
        "C" => "copied",
        "T" => "type changed",
        _ => "modified",
    }
}

/// An entry of Changes (`GitDiffEntry`).
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
pub struct DiffEntry {
    pub path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub old_path: Option<String>,
    pub kind: String,
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub additions: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub deletions: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub generated: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub file_size: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mtime_ms: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub size: Option<f64>,
}

impl DiffEntry {
    fn new(path: String, old_path: Option<String>, kind: &str, status: &str) -> Self {
        Self {
            path,
            old_path,
            kind: kind.into(),
            status: status.into(),
            ..Self::default()
        }
    }

    fn key(&self) -> String {
        format!("{}:{}", self.kind, self.path)
    }
}

fn lines(output: &str) -> impl Iterator<Item = &str> {
    output
        .split('\n')
        .map(|l| l.strip_suffix('\r').unwrap_or(l))
}

fn sort_entries(entries: &mut [DiffEntry], by_kind: bool) {
    entries.sort_by(|a, b| {
        let order = locale_compare_base(&a.path, &b.path);
        if by_kind {
            order.then_with(|| a.kind.cmp(&b.kind))
        } else {
            order
        }
    });
}

/// `git status --porcelain=v1` lines as entries: an untracked file, a
/// conflict, or its staged and unstaged parts.
pub fn parse_status_summary(output: &str) -> Vec<DiffEntry> {
    let mut entries = Vec::new();
    for line in lines(output) {
        if line.is_empty() {
            continue;
        }
        let mut chars = line.chars();
        let x = chars.next().unwrap_or(' ');
        let y = chars.next().unwrap_or(' ');
        let raw: String = line.chars().skip(3).collect();
        let parts: Vec<&str> = raw.split(" -> ").collect();
        let old_path = (parts.len() > 1).then(|| unquote_git_path(parts[0]));
        let path = unquote_git_path(&if parts.len() > 1 {
            parts[1..].join(" -> ")
        } else {
            raw.clone()
        });
        if path.is_empty() {
            continue;
        }
        if x == '?' && y == '?' {
            entries.push(DiffEntry::new(path, None, "untracked", "untracked"));
            continue;
        }
        if is_conflicted(x, y) {
            entries.push(DiffEntry::new(path, old_path, "conflicted", "conflicted"));
            continue;
        }
        if x != ' ' {
            entries.push(DiffEntry::new(
                path.clone(),
                old_path.clone(),
                "staged",
                status_label(&x.to_string(), "staged"),
            ));
        }
        if y != ' ' {
            entries.push(DiffEntry::new(
                path,
                old_path,
                "unstaged",
                status_label(&y.to_string(), "unstaged"),
            ));
        }
    }
    sort_entries(&mut entries, true);
    entries
}

/// `git diff --name-status` lines as entries of `kind` (`branch` or
/// `last-step`).
pub fn parse_branch_summary(output: &str, kind: &str) -> Vec<DiffEntry> {
    let mut entries: Vec<DiffEntry> = lines(output)
        .filter(|l| !l.is_empty())
        .map(|line| {
            let parts: Vec<&str> = line.split('\t').collect();
            let raw = parts.first().copied().unwrap_or("");
            let renamed = raw.starts_with('R') || raw.starts_with('C');
            let path = unquote_git_path(if renamed {
                parts.get(2).or(parts.get(1)).copied().unwrap_or("")
            } else {
                parts.get(1).copied().unwrap_or("")
            });
            let old_path = parts
                .get(1)
                .filter(|p| renamed && !p.is_empty())
                .map(|p| unquote_git_path(p));
            let code = raw.chars().next().map_or("M".to_owned(), String::from);
            DiffEntry::new(path, old_path, kind, status_label(&code, kind))
        })
        .filter(|e| !e.path.is_empty())
        .collect();
    sort_entries(&mut entries, false);
    entries
}

fn numstat_value(value: &str) -> u64 {
    if value == "-" {
        return 0;
    }
    let digits: String = value
        .trim_start()
        .chars()
        .enumerate()
        .take_while(|(i, c)| c.is_ascii_digit() || (*i == 0 && (*c == '-' || *c == '+')))
        .map(|(_, c)| c)
        .collect();
    digits.parse::<i64>().map_or(0, |n| n.max(0) as u64)
}

static BRACE_RENAME: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\{.*? => (.*?)\}").unwrap());

fn normalize_numstat_path(raw: &str) -> String {
    let trimmed = raw.trim();
    let path = trimmed
        .split('\t')
        .filter(|p| !p.is_empty())
        .next_back()
        .unwrap_or(trimmed);
    if BRACE_RENAME.is_match(path) {
        return BRACE_RENAME.replacen(path, 1, "$1").into_owned();
    }
    if let Some(index) = path.rfind(" => ") {
        return path[index + 4..].replace(['{', '}'], "");
    }
    path.to_owned()
}

/// Additions and deletions by path.
pub fn parse_numstat(output: &str) -> BTreeMap<String, (u64, u64)> {
    let mut stats: BTreeMap<String, (u64, u64)> = BTreeMap::new();
    for line in lines(output) {
        if line.is_empty() {
            continue;
        }
        let parts: Vec<&str> = line.split('\t').collect();
        if parts.len() < 3 {
            continue;
        }
        let additions = numstat_value(parts[0]);
        let deletions = numstat_value(parts[1]);
        let path = unquote_git_path(&normalize_numstat_path(&parts[2..].join("\t")));
        if path.is_empty() {
            continue;
        }
        let entry = stats.entry(path).or_default();
        entry.0 += additions;
        entry.1 += deletions;
    }
    stats
}

/// `git check-attr -z` output: paths marked generated (true) or unmarked
/// (false).
pub fn parse_generated_attributes(output: &str) -> BTreeMap<String, bool> {
    let mut generated = BTreeMap::new();
    let fields: Vec<&str> = output.split('\0').collect();
    let mut index = 0;
    while index + 2 < fields.len() {
        let path = fields[index];
        let attribute = fields[index + 1];
        let value = fields[index + 2].to_lowercase();
        index += 3;
        if path.is_empty() || !matches!(attribute, "linguist-generated" | "gitlab-generated") {
            continue;
        }
        if value == "unset" || value == "false" {
            generated.insert(path.to_owned(), false);
        } else if (value == "set" || value == "true") && generated.get(path) != Some(&false) {
            generated.insert(path.to_owned(), true);
        }
    }
    generated
}

/// `working`, `branch-main` or `last-step`.
pub fn diff_mode(params: &Value) -> &'static str {
    match params.get("mode").and_then(Value::as_str) {
        Some("branch-main") => "branch-main",
        Some("last-step") => "last-step",
        _ => "working",
    }
}

fn diff_file_kind(mode: &str, requested: Option<&Value>) -> &'static str {
    match mode {
        "branch-main" => "branch",
        "last-step" => "last-step",
        _ => match requested.and_then(Value::as_str) {
            Some("staged") => "staged",
            Some("untracked") => "untracked",
            Some("conflicted") => "conflicted",
            Some("combined") => "combined",
            _ => "unstaged",
        },
    }
}

fn working_diff_file_command(kind: &str, path: &str, pathspec: &str) -> String {
    match kind {
        "staged" => format!("diff --cached --no-ext-diff -- {pathspec}"),
        "untracked" => format!(
            "diff --no-ext-diff --no-index -- /dev/null {}",
            shell_quote(path)
        ),
        "conflicted" => format!("diff --cc --no-ext-diff -- {pathspec}"),
        _ => format!("diff --no-ext-diff -- {pathspec}"),
    }
}

/// `git -C root -c core.quotepath=false <command>` on the host.
pub async fn run_git_shell_command(cx: &GitContext, root: &str, command: &str) -> Result<Ran> {
    let full = format!(
        "git -C {} -c core.quotepath=false {command}",
        shell_quote(root)
    );
    Ok(cx
        .run(
            shell_command(&full, cx.host()).map_err(GitError::Message)?,
            GIT_DIFF_TIMEOUT,
        )
        .await?)
}

/// The script writing one patch's size line, then its capped bytes.
fn git_patch_script(root: &str, command: &str, automatic: bool) -> String {
    fill_template(
        CAPPED_DIFF_SH,
        &[
            ("root", shell_quote(root).into()),
            ("command", command.into()),
            ("automatic", if automatic { "1" } else { "0" }.into()),
            ("large_patch_bytes", (LARGE_DIFF_PATCH_BYTES as i64).into()),
            ("head_bytes", ((GIT_DIFF_MAX_BYTES + 4) as i64).into()),
        ],
    )
    .expect("capped-diff.sh")
}

/// A capped patch's reading.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Patch {
    pub code: i32,
    pub stdout: String,
    pub stderr: String,
    pub diff: String,
    pub patch_size: u64,
    pub truncated: bool,
    pub deferred: bool,
}

fn parse_git_patch_output(ran: &Ran, automatic: bool) -> Result<Patch> {
    let mut patch = Patch {
        code: ran.code,
        stdout: ran.stdout.clone(),
        stderr: ran.stderr.clone(),
        ..Patch::default()
    };
    if ran.code != 0 && ran.code != 1 {
        return Ok(patch);
    }
    let newline = ran.stdout.find('\n');
    let size = newline.and_then(|n| safe_size(&ran.stdout[..n]));
    let (Some(newline), Some(size)) = (newline, size) else {
        return Err(GitError::message("invalid Git patch size"));
    };
    let rest = &ran.stdout[newline + 1..];
    patch.patch_size = size;
    patch.truncated = size > GIT_DIFF_MAX_BYTES as u64;
    patch.diff = if patch.truncated {
        cut_patch(rest)
    } else {
        rest.to_owned()
    };
    patch.deferred = automatic && size >= LARGE_DIFF_PATCH_BYTES as u64;
    Ok(patch)
}

/// One patch, capped on the host: no full patch in the bridge's or the
/// SSH connection's memory.
pub async fn read_git_patch(cx: &GitContext, root: &str, command: &str, automatic: bool) -> Result<Patch> {
    let script = git_patch_script(root, command, automatic);
    let ran = cx
        .run(
            shell_command(&script, cx.host()).map_err(GitError::Message)?,
            GIT_DIFF_TIMEOUT,
        )
        .await?;
    parse_git_patch_output(&ran, automatic)
}

/// Runs several self-contained scripts as one shell command (one process
/// or SSH round trip) and gives each its exit code, output and error.
pub async fn run_script_batch(cx: &GitContext, scripts: &[String], timeout: Duration) -> Result<Vec<Ran>> {
    if scripts.len() == 1 {
        let ran = cx
            .run(
                shell_command(&scripts[0], cx.host()).map_err(GitError::Message)?,
                timeout,
            )
            .await?;
        return Ok(vec![ran]);
    }
    let marker = marker("ROAMGATE-BATCH");
    let blocks: Vec<String> = scripts
        .iter()
        .enumerate()
        .map(|(index, script)| {
            fill_template(
                BATCH_BLOCK_SH,
                &[("index", (index as i64).into()), ("script", script.as_str().into())],
            )
            .expect("batch-block.sh")
        })
        .collect();
    let command = fill_template(
        BATCH_SH,
        &[
            ("marker", marker.as_str().into()),
            ("blocks", blocks.join("\n").into()),
        ],
    )
    .expect("batch.sh");
    let ran = cx
        .run(
            shell_command(&command, cx.host()).map_err(GitError::Message)?,
            timeout,
        )
        .await?;
    let mut outputs: Vec<Ran> = scripts.iter().map(|_| Ran::new(-1, "", "")).collect();
    let separator = format!("\n{marker} ");
    for part in ran.stdout.split(separator.as_str()).skip(1) {
        let newline = part.find('\n');
        let head: Vec<&str> = part[..newline.unwrap_or(part.len())].split(' ').collect();
        let body = newline.map_or("", |n| &part[n + 1..]);
        let Some(index) = head.get(1).and_then(|i| i.parse::<usize>().ok()) else {
            continue;
        };
        let Some(output) = outputs.get_mut(index) else {
            continue;
        };
        match head[0] {
            "B" => output.stdout = body.to_owned(),
            "E" => {
                output.code = head
                    .get(2)
                    .and_then(|c| js_number(c))
                    .map_or(-1, |c| c as i32);
                output.stderr = body.to_owned();
            }
            _ => {}
        }
    }
    let failure = first_text(&[&ran.stderr, &ran.stdout], "", 1000);
    for output in &mut outputs {
        if output.code == -1 {
            output.code = if ran.code != 0 { ran.code } else { 1 };
            if output.stderr.is_empty() {
                output.stderr = if failure.is_empty() {
                    "git diff did not answer".into()
                } else {
                    failure.clone()
                };
            }
        }
    }
    Ok(outputs)
}

/// Whether `tree` exists as a tree in the checkout.
pub async fn tree_exists(cx: &GitContext, root: &str, tree: &str) -> Result<bool> {
    let ran = run_git_shell_command(
        cx,
        root,
        &format!(
            "cat-file --batch-check={} <<'HERDR_EOF'\n{tree}\nHERDR_EOF",
            shell_quote("%(objectname) %(objecttype)")
        ),
    )
    .await?;
    if ran.code != 0 {
        return Err(GitError::Message(first_text(
            &[&ran.stderr, &ran.stdout],
            &format!("git cat-file exited {}", ran.code),
            1000,
        )));
    }
    let output = ran.stdout.trim();
    if output == format!("{tree} missing") {
        return Ok(false);
    }
    if output == format!("{tree} tree") {
        return Ok(true);
    }
    let shown: String = output.chars().take(1000).collect();
    Err(GitError::Message(format!(
        "unexpected git cat-file response: {shown}"
    )))
}

async fn collect_generated_paths(cx: &GitContext, root: &str, entries: &[DiffEntry]) -> BTreeMap<String, bool> {
    let mut generated = BTreeMap::new();
    let mut seen = BTreeSet::new();
    let paths: Vec<&str> = entries
        .iter()
        .map(|e| e.path.as_str())
        .filter(|p| seen.insert(*p))
        .collect();
    for batch in paths.chunks(GIT_ATTRIBUTE_BATCH_SIZE) {
        let command = format!(
            "check-attr -z linguist-generated gitlab-generated -- {}",
            batch
                .iter()
                .map(|p| shell_quote(p))
                .collect::<Vec<_>>()
                .join(" ")
        );
        let Ok(ran) = run_git_shell_command(cx, root, &command).await else {
            continue;
        };
        if ran.code != 0 {
            continue;
        }
        generated.extend(parse_generated_attributes(&ran.stdout));
    }
    generated
}

static OBJECT_ID: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^[a-f0-9]{40}(?:[a-f0-9]{24})?$").unwrap());

async fn collect_diff_file_sizes(
    cx: &GitContext,
    root: &str,
    diffs: &[(&str, String)],
) -> BTreeMap<String, f64> {
    let raws = join_all(diffs.iter().map(|(kind, command)| async move {
        let ran = run_git_shell_command(cx, root, &format!("{command} --raw -z --no-abbrev")).await;
        (*kind, ran)
    }))
    .await;
    let mut blobs_by_entry: BTreeMap<String, Vec<String>> = BTreeMap::new();
    for (kind, ran) in raws {
        let Ok(ran) = ran else { continue };
        if ran.code != 0 {
            continue;
        }
        let fields: Vec<&str> = ran.stdout.split('\0').collect();
        let mut index = 0;
        while index + 1 < fields.len() {
            let header: Vec<&str> = fields[index].split(' ').collect();
            index += 1;
            let first_path = fields.get(index).copied().unwrap_or("");
            index += 1;
            let renamed = header
                .get(4)
                .is_some_and(|s| s.starts_with('R') || s.starts_with('C'));
            let path = if renamed {
                let path = fields.get(index).copied().unwrap_or("");
                index += 1;
                path
            } else {
                first_path
            };
            let blobs: Vec<String> = header
                .iter()
                .skip(2)
                .take(2)
                .filter(|id| OBJECT_ID.is_match(id) && !id.chars().all(|c| c == '0'))
                .map(|id| (*id).to_owned())
                .collect();
            if path.is_empty() || blobs.is_empty() {
                continue;
            }
            blobs_by_entry.insert(format!("{kind}:{path}"), blobs.clone());
            if kind == "unstaged" {
                blobs_by_entry.insert(format!("conflicted:{path}"), blobs);
            }
        }
    }
    let mut seen = BTreeSet::new();
    let objects: Vec<&String> = blobs_by_entry
        .values()
        .flatten()
        .filter(|id| seen.insert(id.as_str()))
        .collect();
    let mut object_sizes: BTreeMap<String, f64> = BTreeMap::new();
    for batch in objects.chunks(GIT_ATTRIBUTE_BATCH_SIZE) {
        let command = format!(
            "cat-file --batch-check={} <<'ROAMGATE_OBJECTS'\n{}\nROAMGATE_OBJECTS",
            shell_quote("%(objectname) %(objecttype) %(objectsize)"),
            batch
                .iter()
                .map(|s| s.as_str())
                .collect::<Vec<_>>()
                .join("\n")
        );
        let Ok(ran) = run_git_shell_command(cx, root, &command).await else {
            continue;
        };
        if ran.code != 0 {
            continue;
        }
        for line in ran.stdout.split('\n') {
            let parts: Vec<&str> = line.trim().split(' ').collect();
            if let (Some(id), Some(&"blob"), Some(size)) = (parts.first(), parts.get(1), parts.get(2))
                && let Some(size) = safe_size(size)
                && !id.is_empty()
            {
                object_sizes.insert((*id).to_owned(), size as f64);
            }
        }
    }
    let mut sizes = BTreeMap::new();
    for (key, objects) in blobs_by_entry {
        let known: Vec<f64> = objects
            .iter()
            .filter_map(|id| object_sizes.get(id).copied())
            .collect();
        if let Some(max) = known.into_iter().reduce(f64::max) {
            sizes.insert(key, max);
        }
    }
    sizes
}

async fn collect_stats(
    cx: &GitContext,
    root: &str,
    mode: &str,
    base: Option<&str>,
    target: Option<&str>,
    entries: &[DiffEntry],
) -> BTreeMap<String, (u64, u64)> {
    let mut stats: BTreeMap<String, (u64, u64)> = BTreeMap::new();
    let mut merge = |kind: &str, output: &str, fallback: Option<&str>| {
        for (path, value) in parse_numstat(output) {
            stats.insert(format!("{kind}:{path}"), value);
            if let Some(fallback) = fallback {
                stats.insert(format!("{fallback}:{path}"), value);
            }
        }
    };
    if mode == "branch-main" || mode == "last-step" {
        let kind = if mode == "branch-main" {
            "branch"
        } else {
            "last-step"
        };
        let range = if mode == "branch-main" {
            format!("{}...HEAD", shell_quote(base.unwrap_or("main")))
        } else {
            format!(
                "{} {}",
                shell_quote(base.unwrap_or("")),
                shell_quote(target.unwrap_or(""))
            )
        };
        if let Ok(ran) =
            run_git_shell_command(cx, root, &format!("diff --numstat --find-renames {range}")).await
            && (ran.code == 0 || ran.code == 1)
        {
            merge(kind, &ran.stdout, None);
        }
        return stats;
    }
    if let Ok(ran) = run_git_shell_command(cx, root, "diff --cached --numstat --find-renames").await
        && (ran.code == 0 || ran.code == 1)
    {
        merge("staged", &ran.stdout, None);
    }
    if let Ok(ran) = run_git_shell_command(cx, root, "diff --numstat --find-renames").await
        && (ran.code == 0 || ran.code == 1)
    {
        merge("unstaged", &ran.stdout, Some("conflicted"));
    }
    let untracked: Vec<&DiffEntry> = entries.iter().filter(|e| e.kind == "untracked").collect();
    // One command per batch, never one per file (a fresh SSH login each);
    // past the cap the files are listed without counts.
    let counted: &[&DiffEntry] = if untracked.len() > GIT_UNTRACKED_NUMSTAT_MAX_FILES {
        &[]
    } else {
        &untracked
    };
    let batches: Vec<&[&DiffEntry]> = counted.chunks(GIT_UNTRACKED_NUMSTAT_BATCH_SIZE).collect();
    let cursor = Mutex::new(0usize);
    let results = Mutex::new(Vec::new());
    let worker = || async {
        loop {
            let batch = {
                let mut at = cursor.lock().unwrap();
                let Some(batch) = batches.get(*at) else {
                    break;
                };
                *at += 1;
                *batch
            };
            let command = fill_template(
                UNTRACKED_NUMSTAT_SH,
                &[
                    (
                        "paths",
                        batch
                            .iter()
                            .map(|e| shell_quote(&e.path))
                            .collect::<Vec<_>>()
                            .join(" ")
                            .into(),
                    ),
                    ("root", shell_quote(root).into()),
                ],
            )
            .expect("untracked-numstat.sh");
            let Ok(invocation) = shell_command(&command, cx.host()) else {
                continue;
            };
            let Ok(ran) = cx.run(invocation, GIT_DIFF_TIMEOUT).await else {
                continue;
            };
            if ran.code != 0 && ran.code != 1 {
                continue;
            }
            let values = parse_numstat(&ran.stdout);
            let mut results = results.lock().unwrap();
            for entry in batch {
                if let Some(value) = values.get(&entry.path) {
                    results.push((entry.key(), *value));
                }
            }
        }
    };
    let workers = GIT_UNTRACKED_NUMSTAT_CONCURRENCY.min(batches.len());
    join_all((0..workers).map(|_| worker())).await;
    stats.extend(results.into_inner().unwrap());
    stats
}

/// A branch review's base and the branches offered.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Comparison {
    pub base: Option<String>,
    pub branches: Vec<String>,
}

async fn resolve_comparison_base(cx: &GitContext, root: &str, requested: Option<&Value>) -> Result<Comparison> {
    let ran = cx
        .run(
            shell_command(&refs_script(root), cx.host()).map_err(GitError::Message)?,
            GIT_DIFF_TIMEOUT,
        )
        .await?;
    if ran.code != 0 {
        return Err(GitError::Message(first_text(
            &[&ran.stderr, &ran.stdout],
            "Unable to read comparison branches",
            1000,
        )));
    }
    let listed = parse_refs_output(&ran.stdout);
    let requested = Requested::from_json(requested);
    if requested != Requested::None {
        let selected = select_diff_base(&listed.refs, None, requested)?;
        return Ok(Comparison {
            base: selected.base,
            branches: selected.branches,
        });
    }
    // Automatic: the same base as the branch's review.
    let resolved = resolve_default_base(cx, root, Some(GIT_DIFF_TIMEOUT), Some(listed)).await?;
    Ok(Comparison {
        base: resolved.base,
        branches: resolved.branches,
    })
}

/// How long a branch review's base, once resolved, serves the next file
/// reads.
pub const COMPARISON_BASE_REUSE: Duration = Duration::from_millis(5000);

type SharedComparison = futures_util::future::Shared<
    futures_util::future::BoxFuture<'static, std::result::Result<Comparison, GitError>>,
>;

static RECENT_BASES: LazyLock<Mutex<BTreeMap<String, (Instant, SharedComparison)>>> =
    LazyLock::new(|| Mutex::new(BTreeMap::new()));

async fn recent_comparison_base(cx: &GitContext, root: &str, requested: Option<&Value>) -> Result<Comparison> {
    use futures_util::FutureExt as _;
    let requested_key = match requested {
        None | Some(Value::Null) => String::new(),
        Some(Value::String(s)) => s.clone(),
        Some(other) => other.to_string(),
    };
    let key = serde_json::to_string(&json!([cx.host().unwrap_or(""), root, requested_key])).unwrap();
    let shared = {
        let mut kept = RECENT_BASES.lock().unwrap();
        let now = Instant::now();
        match kept.get(&key) {
            Some((at, base)) if now.duration_since(*at) < COMPARISON_BASE_REUSE => base.clone(),
            _ => {
                kept.retain(|_, (at, _)| now.duration_since(*at) < COMPARISON_BASE_REUSE);
                let (cx, root, requested) = (cx.clone(), root.to_owned(), requested.cloned());
                let base = async move { resolve_comparison_base(&cx, &root, requested.as_ref()).await }
                    .boxed()
                    .shared();
                kept.insert(key.clone(), (now, base.clone()));
                base
            }
        }
    };
    let result = shared.clone().await;
    if result.is_err() {
        let mut kept = RECENT_BASES.lock().unwrap();
        if kept.get(&key).is_some_and(|(_, base)| base.ptr_eq(&shared)) {
            kept.remove(&key);
        }
    }
    result
}

/// A last step's two trees, as resolved for a read.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct StepRange {
    pub baseline: String,
    pub current: String,
    pub step: Option<String>,
    pub at: Option<String>,
    pub skipped: Vec<String>,
}

async fn resolve_last_step_range(
    cx: &GitContext,
    workspace_id: &str,
    root: &str,
    baselines: Option<&Arc<LastStepStore>>,
    snapshot_id: Option<&str>,
) -> Result<Option<StepRange>> {
    if let Some(snapshot_id) = snapshot_id {
        let snapshot = baselines.and_then(|b| b.resolve_snapshot(workspace_id, root, snapshot_id));
        return match snapshot {
            Some((baseline, current)) => Ok(Some(StepRange {
                baseline,
                current,
                ..StepRange::default()
            })),
            None => Err(GitError::message(
                "last-step snapshot expired; refresh Changes",
            )),
        };
    }
    let Some(baselines) = baselines else {
        return Ok(None);
    };
    let Some(completed) = baselines.completed_step(workspace_id, root).await else {
        return Ok(None);
    };
    let (before, after) = tokio::join!(
        tree_exists(cx, root, &completed.baseline),
        tree_exists(cx, root, &completed.current)
    );
    if !before? || !after? {
        baselines.invalidate_workspace(workspace_id, root);
        return Ok(None);
    }
    Ok(Some(completed))
}

fn counts(entries: &[Value]) -> Value {
    let count = |kind: &str| {
        entries
            .iter()
            .filter(|e| e.get("kind").and_then(Value::as_str) == Some(kind))
            .count()
    };
    json!({
        "staged": count("staged"),
        "unstaged": count("unstaged"),
        "untracked": count("untracked"),
        "conflicted": count("conflicted"),
        "branch": count("branch"),
        "last-step": count("last-step"),
    })
}

fn repo_name(workspace: &Value) -> String {
    workspace
        .pointer("/worktree/repo_name")
        .and_then(Value::as_str)
        .or_else(|| workspace.get("label").and_then(Value::as_str))
        .unwrap_or("")
        .to_owned()
}

/// What `readDiffSummary` needs.
pub struct SummaryArgs<'a> {
    pub cx: &'a GitContext,
    pub workspace_id: &'a str,
    pub workspace: &'a Value,
    pub root: &'a str,
    pub params: &'a Value,
    pub last_steps: Option<&'a Arc<LastStepStore>>,
}

/// `git.diff_summary`: Changes' list for a scope.
pub async fn read_diff_summary(args: SummaryArgs<'_>) -> Result<Value> {
    let SummaryArgs {
        cx,
        workspace_id,
        workspace,
        root,
        params,
        last_steps,
    } = args;
    let mode = diff_mode(params);
    let comparison = if mode == "branch-main" {
        Some(resolve_comparison_base(cx, root, params.get("base_branch")).await?)
    } else {
        None
    };
    let base = comparison.as_ref().and_then(|c| c.base.clone());
    if let Some(comparison) = &comparison
        && base.is_none()
    {
        return Ok(json!({
            "workspace_id": workspace_id,
            "repo_name": repo_name(workspace),
            "root": root,
            "mode": mode,
            "base_branches": comparison.branches,
            "baseline_available": false,
            "entries": [],
            "counts": counts(&[]),
        }));
    }
    let step = if mode == "last-step" {
        resolve_last_step_range(cx, workspace_id, root, last_steps, None).await?
    } else {
        None
    };
    let ran = match (mode, &step) {
        ("branch-main", _) => {
            run_git_shell_command(
                cx,
                root,
                &format!(
                    "diff --name-status --find-renames {}...HEAD",
                    shell_quote(base.as_deref().unwrap_or("main"))
                ),
            )
            .await?
        }
        ("last-step", Some(step)) => {
            run_git_shell_command(
                cx,
                root,
                &format!(
                    "diff --name-status --find-renames {} {}",
                    shell_quote(&step.baseline),
                    shell_quote(&step.current)
                ),
            )
            .await?
        }
        ("working", _) => {
            run_git_shell_command(cx, root, "status --porcelain=v1 --untracked-files=all").await?
        }
        _ => Ran::default(),
    };
    if ran.code != 0 {
        let verb = if mode == "working" { "status" } else { "diff" };
        return Err(GitError::Message(first_text(
            &[&ran.stderr, &ran.stdout],
            &format!("git {verb} exited {}", ran.code),
            1000,
        )));
    }
    let entries = match mode {
        "branch-main" => parse_branch_summary(&ran.stdout, "branch"),
        "last-step" => parse_branch_summary(&ran.stdout, "last-step"),
        _ => parse_status_summary(&ran.stdout),
    };
    let stats_task = async {
        if mode == "last-step" && step.is_none() {
            BTreeMap::new()
        } else {
            let stats_base = if mode == "last-step" {
                step.as_ref().map(|s| s.baseline.as_str())
            } else {
                base.as_deref()
            };
            collect_stats(
                cx,
                root,
                mode,
                stats_base,
                step.as_ref().map(|s| s.current.as_str()),
                &entries,
            )
            .await
        }
    };
    let fingerprint_task = async {
        if mode != "working" {
            return BTreeMap::new();
        }
        let context = ActionContext {
            git: cx.clone(),
            root: root.to_owned(),
        };
        let paths: Vec<String> = entries.iter().map(|e| e.path.clone()).collect();
        collect_worktree_fingerprints(&context, &paths)
            .await
            .unwrap_or_default()
    };
    let size_diffs: Vec<(&str, String)> = match (mode, &step) {
        ("working", _) => vec![
            ("staged", "diff --cached --no-ext-diff --find-renames".into()),
            ("unstaged", "diff --no-ext-diff --find-renames".into()),
        ],
        ("branch-main", _) => vec![(
            "branch",
            format!(
                "diff --no-ext-diff --find-renames {}...HEAD",
                shell_quote(base.as_deref().unwrap_or("main"))
            ),
        )],
        (_, Some(step)) => vec![(
            "last-step",
            format!(
                "diff --no-ext-diff --find-renames {} {}",
                shell_quote(&step.baseline),
                shell_quote(&step.current)
            ),
        )],
        _ => vec![],
    };
    // What the scope line says: the branch, and its commits past the base.
    let git_line = |command: String| async move {
        match run_git_shell_command(cx, root, &command).await {
            Ok(ran) if ran.code == 0 => ran.stdout.trim().to_owned(),
            _ => String::new(),
        }
    };
    let commits_task = async {
        if mode == "branch-main" {
            git_line(format!(
                "rev-list --count {}..HEAD",
                shell_quote(base.as_deref().unwrap_or("main"))
            ))
            .await
        } else {
            String::new()
        }
    };
    let (stats, generated, fingerprints, file_sizes, branch, commits) = tokio::join!(
        stats_task,
        collect_generated_paths(cx, root, &entries),
        fingerprint_task,
        collect_diff_file_sizes(cx, root, &size_diffs),
        git_line("rev-parse --abbrev-ref HEAD".into()),
        commits_task,
    );
    let with_stats: Vec<Value> = entries
        .into_iter()
        .map(|mut entry| {
            let key = entry.key();
            let fingerprint = fingerprints.get(&entry.path);
            let blob = file_sizes.get(&key).copied();
            let worktree = (entry.kind != "staged")
                .then(|| fingerprint.map(|f| f.size))
                .flatten();
            if let Some((additions, deletions)) = stats.get(&key) {
                entry.additions = Some(*additions);
                entry.deletions = Some(*deletions);
            }
            if let Some(f) = fingerprint {
                entry.mtime_ms = Some(f.mtime_ms);
                entry.size = Some(f.size);
            }
            if blob.is_some() || worktree.is_some() {
                entry.file_size = Some(blob.unwrap_or(0.0).max(worktree.unwrap_or(0.0)));
            }
            entry.generated = generated.get(&entry.path).copied();
            serde_json::to_value(entry).unwrap()
        })
        .collect();
    let snapshot_id = match (mode, &step, last_steps) {
        ("last-step", Some(step), Some(store)) => {
            Some(store.remember_snapshot(workspace_id, root, &step.baseline, &step.current)?)
        }
        _ => None,
    };
    let mut result = Map::new();
    result.insert("workspace_id".into(), json!(workspace_id));
    result.insert("repo_name".into(), json!(repo_name(workspace)));
    result.insert("root".into(), json!(root));
    result.insert("mode".into(), json!(mode));
    let shown_base = if mode == "last-step" {
        step.as_ref().map(|s| s.baseline.clone())
    } else {
        base.clone()
    };
    if let Some(base) = shown_base {
        result.insert("base".into(), json!(base));
    }
    if let Some(comparison) = &comparison {
        result.insert("base_branches".into(), json!(comparison.branches));
    }
    if !branch.is_empty() && branch != "HEAD" {
        result.insert("branch".into(), json!(branch));
    }
    if !commits.is_empty() && commits.bytes().all(|c| c.is_ascii_digit()) {
        result.insert("commits".into(), json!(commits.parse::<u64>().unwrap_or(0)));
    }
    result.insert(
        "baseline_available".into(),
        json!(mode != "last-step" || step.is_some()),
    );
    if let Some(id) = snapshot_id {
        result.insert("snapshot_id".into(), json!(id));
    }
    if let Some(step) = step.as_ref().filter(|s| s.step.is_some()) {
        let mut target = Map::new();
        target.insert("step".into(), json!(step.step));
        target.insert("before".into(), json!(step.baseline));
        target.insert("after".into(), json!(step.current));
        if let Some(at) = &step.at {
            target.insert("at".into(), json!(at));
        }
        if !step.skipped.is_empty() {
            target.insert("skipped".into(), json!(step.skipped));
        }
        result.insert("step".into(), Value::Object(target));
    }
    result.insert("counts".into(), counts(&with_stats));
    result.insert("entries".into(), Value::Array(with_stats));
    Ok(Value::Object(result))
}

/// Most files one `git.diff_files` call reads.
pub const GIT_DIFF_FILES_MAX: usize = 32;

/// What `readDiffFiles` needs.
pub struct FilesArgs<'a> {
    pub cx: &'a GitContext,
    pub workspace_id: &'a str,
    pub root: &'a str,
    pub params: &'a Value,
    pub last_steps: Option<&'a Arc<LastStepStore>>,
}

struct FileEntry {
    path: String,
    old_path: Option<String>,
    pathspec: String,
    kind: &'static str,
}

fn staged_json(staged: &CombinedStaged) -> Value {
    serde_json::to_value(staged).unwrap()
}

/// `git.diff_file`: one file of a scope.
pub async fn read_diff_file(args: FilesArgs<'_>) -> Result<Value> {
    let path = sanitize_explorer_path(args.params.get("path"))?;
    if path.is_empty() {
        return Err(GitError::message("git.diff_file requires path"));
    }
    let mut params = args.params.as_object().cloned().unwrap_or_default();
    params.insert(
        "entries".into(),
        json!([{
            "path": path,
            "old_path": args.params.get("old_path").cloned().unwrap_or(Value::Null),
            "kind": args.params.get("kind").cloned().unwrap_or(Value::Null),
        }]),
    );
    let params = Value::Object(params);
    let files = read_diff_files(FilesArgs {
        params: &params,
        ..args
    })
    .await?;
    let file = files
        .get("files")
        .and_then(|f| f.get(0))
        .cloned()
        .ok_or_else(|| GitError::message("git.diff_file requires path"))?;
    if let Some(error) = file.get("error").and_then(Value::as_str) {
        return Err(GitError::message(error));
    }
    Ok(file)
}

/// `git.diff_files`: several files of one scope in one shell command; a
/// file that fails carries its `error`.
pub async fn read_diff_files(args: FilesArgs<'_>) -> Result<Value> {
    let FilesArgs {
        cx,
        workspace_id,
        root,
        params,
        last_steps,
    } = args;
    let requested = params
        .get("entries")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    if requested.is_empty() {
        return Err(GitError::message("git.diff_files requires entries"));
    }
    if requested.len() > GIT_DIFF_FILES_MAX {
        return Err(GitError::Message(format!(
            "git.diff_files reads at most {GIT_DIFF_FILES_MAX} files"
        )));
    }
    let mode = diff_mode(params);
    let snapshot_id = params
        .get("snapshot_id")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty());
    if mode == "last-step" && snapshot_id.is_none() {
        return Err(GitError::message(
            "last-step diff requires a fresh summary snapshot",
        ));
    }
    let automatic = params.get("automatic") == Some(&Value::Bool(true));
    let mut entries = Vec::new();
    for each in &requested {
        let path = sanitize_explorer_path(each.get("path"))?;
        if path.is_empty() {
            return Err(GitError::message("git.diff_file requires path"));
        }
        let old_path = sanitize_explorer_path(each.get("old_path"))?;
        let old_path = (!old_path.is_empty()).then_some(old_path);
        let pathspec = match &old_path {
            Some(old) if *old != path => format!("{} {}", shell_quote(old), shell_quote(&path)),
            _ => shell_quote(&path),
        };
        entries.push(FileEntry {
            path,
            old_path,
            pathspec,
            kind: diff_file_kind(mode, each.get("kind")),
        });
    }
    let comparison = if mode == "branch-main" {
        Some(recent_comparison_base(cx, root, params.get("base_branch")).await?)
    } else {
        None
    };
    let base = comparison.as_ref().and_then(|c| c.base.clone());
    if comparison.is_some() && base.is_none() {
        return Err(GitError::message(
            "Default comparison branch was not found; select a comparison branch.",
        ));
    }
    let step = if mode == "last-step" {
        resolve_last_step_range(cx, workspace_id, root, last_steps, snapshot_id).await?
    } else {
        None
    };
    let markers: Vec<String> = entries.iter().map(|_| marker("ROAMGATE-COMBINED")).collect();
    let scripts: Vec<Option<String>> = entries
        .iter()
        .enumerate()
        .map(|(index, entry)| {
            if entry.kind == "combined" {
                return Some(combined_diff_script(
                    root,
                    &entry.path,
                    entry.old_path.as_deref(),
                    &markers[index],
                    automatic,
                ));
            }
            let command = match (mode, &step) {
                ("branch-main", _) => Some(format!(
                    "diff --no-ext-diff --find-renames {}...HEAD -- {}",
                    shell_quote(base.as_deref().unwrap_or("main")),
                    entry.pathspec
                )),
                ("last-step", Some(step)) => Some(format!(
                    "diff --no-ext-diff --find-renames {} {} -- {}",
                    shell_quote(&step.baseline),
                    shell_quote(&step.current),
                    entry.pathspec
                )),
                ("working", _) => Some(working_diff_file_command(
                    entry.kind,
                    &entry.path,
                    &entry.pathspec,
                )),
                _ => None,
            };
            command.map(|command| git_patch_script(root, &command, automatic))
        })
        .collect();
    let runnable: Vec<String> = scripts.iter().flatten().cloned().collect();
    let outputs = if runnable.is_empty() {
        Vec::new()
    } else {
        let timeout = GIT_DIFF_TIMEOUT + Duration::from_millis(1000 * (runnable.len() as u64 - 1));
        run_script_batch(cx, &runnable, timeout).await?
    };
    let mut next = 0;
    let mut expired: Option<bool> = None;
    let mut files = Vec::new();
    for (index, entry) in entries.iter().enumerate() {
        let mut head = Map::new();
        head.insert("workspace_id".into(), json!(workspace_id));
        head.insert("root".into(), json!(root));
        head.insert("path".into(), json!(entry.path));
        head.insert("kind".into(), json!(entry.kind));
        let failed = |ran: &Ran| {
            first_text(
                &[&ran.stderr, &ran.stdout],
                &format!("git diff exited {}", ran.code),
                1000,
            )
        };
        let with_error = |mut head: Map<String, Value>, error: String| {
            head.insert("error".into(), json!(error));
            Value::Object(head)
        };
        if scripts[index].is_none() {
            head.insert("diff".into(), json!(""));
            head.insert("patch_size".into(), json!(0));
            head.insert("truncated".into(), json!(false));
            files.push(Value::Object(head));
            continue;
        }
        let output = &outputs[next];
        next += 1;
        if entry.kind == "combined" {
            if output.code != 0 {
                files.push(with_error(head, failed(output)));
                continue;
            }
            // What a login profile printed before the output goes.
            let text = skip_login_noise(&output.stdout);
            match parse_combined_diff_output(text, &markers[index], &entry.path, automatic) {
                Ok(combined) => {
                    head.insert("diff".into(), json!(combined.diff));
                    head.insert("patch_size".into(), json!(combined.patch_size));
                    head.insert("truncated".into(), json!(combined.truncated));
                    if combined.deferred {
                        head.insert("deferred".into(), json!(true));
                    }
                    if combined.untracked {
                        head.insert("untracked".into(), json!(true));
                    }
                    if combined.unmerged {
                        head.insert("unmerged".into(), json!(true));
                    }
                    if let Some(staged) = &combined.staged {
                        head.insert("staged".into(), staged_json(staged));
                    }
                    files.push(Value::Object(head));
                }
                Err(error) => files.push(with_error(head, error.to_string())),
            }
            continue;
        }
        let patch = match parse_git_patch_output(output, automatic) {
            Ok(patch) => patch,
            Err(error) => {
                files.push(with_error(head, error.to_string()));
                continue;
            }
        };
        let ok = if entry.kind == "untracked" {
            patch.code == 0
                || (patch.code == 1 && (patch.patch_size > 0 || patch.stderr.trim().is_empty()))
        } else {
            patch.code == 0
        };
        if !ok {
            if mode == "last-step"
                && let (Some(snapshot_id), Some(step)) = (snapshot_id, &step)
            {
                if expired.is_none() {
                    let (before, after) = tokio::join!(
                        tree_exists(cx, root, &step.baseline),
                        tree_exists(cx, root, &step.current)
                    );
                    match (before, after) {
                        (Ok(true), Ok(true)) => expired = Some(false),
                        (Ok(_), Ok(_)) => {
                            if let Some(store) = last_steps {
                                store.delete_snapshot(snapshot_id);
                            }
                            expired = Some(true);
                        }
                        (Err(error), _) | (_, Err(error)) => {
                            files.push(with_error(head, error.to_string()));
                            continue;
                        }
                    }
                }
                if expired == Some(true) {
                    files.push(with_error(
                        head,
                        "last-step snapshot expired; refresh Changes".into(),
                    ));
                    continue;
                }
            }
            files.push(with_error(head, failed(&Ran::new(patch.code, patch.stdout, patch.stderr))));
            continue;
        }
        head.insert("diff".into(), json!(patch.diff));
        head.insert("patch_size".into(), json!(patch.patch_size));
        head.insert("truncated".into(), json!(patch.truncated));
        if patch.deferred {
            head.insert("deferred".into(), json!(true));
        }
        files.push(Value::Object(head));
    }
    Ok(json!({ "workspace_id": workspace_id, "root": root, "files": files }))
}

/// `git.pull`: `git pull --ff-only`, never prompting.
pub async fn pull_git(cx: &GitContext, workspace_id: &str, root: &str) -> Result<Value> {
    let command = format!(
        "GIT_TERMINAL_PROMPT=0 git -C {} -c core.quotepath=false pull --ff-only",
        shell_quote(root)
    );
    let ran = cx
        .run(
            shell_command(&command, cx.host()).map_err(GitError::Message)?,
            GIT_PULL_TIMEOUT,
        )
        .await?;
    if ran.code != 0 {
        return Err(GitError::Message(first_text(
            &[&ran.stderr, &ran.stdout],
            &format!("git pull exited {}", ran.code),
            2000,
        )));
    }
    Ok(json!({
        "workspace_id": workspace_id,
        "root": root,
        "stdout": ran.stdout.trim(),
        "stderr": ran.stderr.trim(),
    }))
}

/// The refs of a workspace's steps: `refs/roamgate/steps/<workspace>/`.
pub fn last_step_ref_prefix(workspace_id: &str) -> String {
    let name: String = workspace_id
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '_' || c == '-' {
                c
            } else {
                '_'
            }
        })
        .take(100)
        .collect();
    format!(
        "refs/roamgate/steps/{}",
        if name.is_empty() { "_" } else { &name }
    )
}

/// Steps kept under refs besides the ones with threads.
pub const LAST_STEPS_KEPT: usize = 5;

pub(crate) static STEP_ID: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^[0-9A-Za-z][0-9A-Za-z_-]{0,63}$").unwrap());

/// Keeps a step's trees under refs (and the untracked files it left out,
/// as a blob), then drops the refs of the workspace's older steps but the
/// last [`LAST_STEPS_KEPT`] and the ones `keep` names.
pub async fn persist_last_step(
    cx: &GitContext,
    root: &str,
    workspace_id: &str,
    step: &str,
    range: &StepRange,
    keep: &[String],
) -> Result<()> {
    let prefix = last_step_ref_prefix(workspace_id);
    let kept = keep
        .iter()
        .filter(|id| STEP_ID.is_match(id))
        .cloned()
        .collect::<Vec<_>>()
        .join(" ");
    let command = fill_template(
        LAST_STEP_REFS_SH,
        &[
            ("root", shell_quote(root).into()),
            ("prefix", shell_quote(&prefix).into()),
            (
                "before_ref",
                shell_quote(&format!("{prefix}/{step}/before")).into(),
            ),
            ("baseline", shell_quote(&range.baseline).into()),
            (
                "after_ref",
                shell_quote(&format!("{prefix}/{step}/after")).into(),
            ),
            ("current", shell_quote(&range.current).into()),
            ("skipped", (!range.skipped.is_empty()).into()),
            (
                "skipped_paths",
                range
                    .skipped
                    .iter()
                    .map(|p| shell_quote(p))
                    .collect::<Vec<_>>()
                    .join(" ")
                    .into(),
            ),
            (
                "skipped_ref",
                shell_quote(&format!("{prefix}/{step}/skipped")).into(),
            ),
            ("keep_from", ((LAST_STEPS_KEPT + 1) as i64).into()),
            ("kept", kept.into()),
        ],
    )
    .expect("last-step-refs.sh");
    let ran = cx
        .run(
            shell_command(&command, cx.host()).map_err(GitError::Message)?,
            GIT_DIFF_TIMEOUT,
        )
        .await?;
    if ran.code != 0 {
        return Err(GitError::Message(first_text(
            &[&ran.stderr],
            &format!("git update-ref exited {}", ran.code),
            1000,
        )));
    }
    Ok(())
}

/// When a step ended, from its id (its end in ms).
pub(crate) fn last_step_time(step: &str) -> Option<String> {
    let ms = js_number(step.split('-').next().unwrap_or(""))?;
    (ms.is_finite() && ms > 0.0).then(|| crate::steps::iso_time(ms as i64))
}

/// The workspace's latest step kept under refs, after a restart lost the
/// one in memory.
pub async fn read_last_step_refs(cx: &GitContext, root: &str, workspace_id: &str) -> Result<Option<StepRange>> {
    let prefix = last_step_ref_prefix(workspace_id);
    let listed = cx
        .run(
            shell_command(
                &format!(
                    "cd {} && git for-each-ref --format='%(refname) %(objectname)' {}",
                    shell_quote(root),
                    shell_quote(&format!("{prefix}/"))
                ),
                cx.host(),
            )
            .map_err(GitError::Message)?,
            GIT_DIFF_TIMEOUT,
        )
        .await?;
    if listed.code != 0 {
        return Ok(None);
    }
    let mut steps: BTreeMap<String, BTreeMap<String, String>> = BTreeMap::new();
    for line in listed.stdout.split('\n') {
        let mut parts = line.trim().split(' ');
        let (Some(reference), Some(object)) = (parts.next(), parts.next()) else {
            continue;
        };
        let Some(rest) = reference.strip_prefix(&format!("{prefix}/")) else {
            continue;
        };
        let mut ends = rest.split('/');
        let (Some(id), Some(end)) = (ends.next(), ends.next()) else {
            continue;
        };
        if id.is_empty() || end.is_empty() || !STEP_ID.is_match(id) {
            continue;
        }
        steps
            .entry(id.to_owned())
            .or_default()
            .insert(end.to_owned(), object.to_owned());
    }
    let Some(step) = steps
        .iter()
        .filter(|(_, ends)| ends.contains_key("before") && ends.contains_key("after"))
        .map(|(id, _)| id.clone())
        .max()
    else {
        return Ok(None);
    };
    let ends = &steps[&step];
    let mut skipped = Vec::new();
    if let Some(blob) = ends.get("skipped") {
        let ran = cx
            .run(
                shell_command(
                    &format!(
                        "cd {} && git cat-file blob {}",
                        shell_quote(root),
                        shell_quote(blob)
                    ),
                    cx.host(),
                )
                .map_err(GitError::Message)?,
                GIT_DIFF_TIMEOUT,
            )
            .await?;
        if ran.code == 0 {
            skipped = ran
                .stdout
                .split('\n')
                .filter(|l| !l.is_empty())
                .map(str::to_owned)
                .collect();
        }
    }
    Ok(Some(StepRange {
        baseline: ends["before"].clone(),
        current: ends["after"].clone(),
        at: last_step_time(&step),
        step: Some(step),
        skipped,
    }))
}

/// Shared by the store: the store is cheap to clone.
pub type SharedStore = Arc<LastStepStore>;

#[cfg(test)]
mod tests;
