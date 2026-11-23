//! Upstreaming efforts and their ledger (`mr-reviews/efforts.ts`): every
//! commit of `target..source` with one disposition. Derived ones come from
//! git (`derived.json`); authored ones are the user's and the leader's
//! (`ledger.json`, journaled for Undo); each commit's versions are appended
//! to `history.jsonl` (D24). The files are Bun's JSON text, key for key.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock, Mutex};

use regex::Regex;
use roamgate_agents::js::{self, Obj};
use roamgate_base::paths::DataContext;
use roamgate_base::private::create_dir_all_mode;
use serde_json::{Value, json};

use crate::connection::{MrConnection, sh_quote};
use crate::fuzzy::{self, MatchCommit, UpstreamCandidate};

pub const LEDGER_JOURNAL: usize = 100;
pub const LEDGER_BULK_MAX: usize = 500;
pub const LEDGER_PAGE: usize = 200;
pub const TARGET_CHECK_MS: f64 = 15.0 * 60_000.0;
pub const AUTHORED_DISPOSITIONS: [&str; 5] = [
    "not_for_upstream",
    "superseded",
    "planned",
    "upstream",
    "in_review",
];
pub const DISPOSITIONS: [&str; 7] = [
    "upstream",
    "in_review",
    "in_part",
    "planned",
    "not_for_upstream",
    "superseded",
    "unsorted",
];
pub const PLAN_MAX: usize = 200;

/// An effort's declaration (`MrEffort`, camel case as the settings give it).
pub type Effort = Value;

fn s<'a>(value: &'a Value, path: &[&str]) -> &'a str {
    let mut at = value;
    for key in path {
        match at.get(*key) {
            Some(next) => at = next,
            None => return "",
        }
    }
    at.as_str().unwrap_or("")
}

fn strings(value: Option<&Value>) -> Vec<String> {
    value
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(str::to_owned)
        .collect()
}

fn obj(value: Value) -> Obj {
    match value {
        Value::Object(map) => map,
        _ => Obj::new(),
    }
}

/// An empty ledger.
pub fn empty_ledger() -> Obj {
    obj(
        json!({"version": 0, "entries": {}, "aliases": {}, "matches": {}, "plans": [], "journal": []}),
    )
}

/// A ledger as read: fields older files lack filled in.
fn normal_ledger(value: Obj) -> Obj {
    let mut out = empty_ledger();
    for (key, v) in value {
        out.insert(key, v);
    }
    if out.get("matches").is_none_or(Value::is_null) {
        out.insert("matches".into(), json!({}));
    }
    if out.get("plans").is_none_or(Value::is_null) {
        out.insert("plans".into(), json!([]));
    }
    out
}

/// Where an effort's target is kept in its clone (D13).
pub fn upstream_ref(effort: &Effort) -> String {
    format!(
        "refs/roamgate/upstream/{}/{}",
        s(effort, &["target", "remote"]),
        s(effort, &["target", "branch"])
    )
}

/// Heads of an effort: `S`, `T`, `M`, `U`, `F ref sha`, `E` on error.
pub fn effort_heads_script(effort: &Effort, check_target: bool) -> String {
    let local = upstream_ref(effort);
    let remote = s(effort, &["target", "remote"]);
    let branch = s(effort, &["target", "branch"]);
    let mut lines = vec![
        format!("d={}", sh_quote(s(effort, &["clone", "path"]))),
        r#"export GIT_TERMINAL_PROMPT=0 GIT_SSH_COMMAND="${GIT_SSH_COMMAND:-ssh} -o BatchMode=yes""#.to_owned(),
        "[ -d \"$d\" ] || { echo \"E\tno such clone\"; exit 0; }".to_owned(),
    ];
    if check_target {
        lines.push(format!(
            "r=$(git -C \"$d\" ls-remote {} {} 2>/dev/null | cut -f1)",
            sh_quote(remote),
            sh_quote(&format!("refs/heads/{branch}"))
        ));
        lines.push(format!(
            "l=$(git -C \"$d\" rev-parse -q --verify {} 2>/dev/null)",
            sh_quote(&local)
        ));
        lines.push(format!(
            "u=$(git -C \"$d\" config --get {})",
            sh_quote(&format!("remote.{remote}.url"))
        ));
        lines.push(format!(
            "if [ -n \"$r\" ] && [ \"$r\" != \"$l\" ]; then git -C \"$d\" fetch -q --no-tags \"$u\" {} >/dev/null 2>&1; fi",
            sh_quote(&format!("+refs/heads/{branch}:{local}"))
        ));
    }
    lines.push(format!(
        "printf \"U\\t%s\\n\" \"$(git -C \"$d\" config --get {} 2>/dev/null)\"",
        sh_quote(&format!("remote.{remote}.url"))
    ));
    lines.push(format!(
        "s=$(git -C \"$d\" rev-parse -q --verify {} 2>/dev/null)",
        sh_quote(s(effort, &["source"]))
    ));
    lines.push("printf \"S\\t%s\\n\" \"$s\"".to_owned());
    lines.push(format!(
        "t=$(git -C \"$d\" rev-parse -q --verify {} 2>/dev/null) || t=$(git -C \"$d\" rev-parse -q --verify {} 2>/dev/null)",
        sh_quote(&local),
        sh_quote(&format!("refs/remotes/{remote}/{branch}"))
    ));
    lines.push("printf \"T\\t%s\\n\" \"$t\"".to_owned());
    lines.push(
        "if [ -n \"$s\" ] && [ -n \"$t\" ]; then printf \"M\\t%s\\n\" \"$(git -C \"$d\" merge-base \"$s\" \"$t\" 2>/dev/null)\"; fi"
            .to_owned(),
    );
    for feeder in strings(effort.get("feeders")) {
        lines.push(format!(
            "printf \"F\\t%s\\t%s\\n\" {} \"$(git -C \"$d\" rev-parse -q --verify {} 2>/dev/null)\"",
            sh_quote(&feeder),
            sh_quote(&feeder)
        ));
    }
    lines.push("exit 0".to_owned());
    lines.join("\n")
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Heads {
    pub source: String,
    pub target: String,
    pub feeders: Vec<(String, String)>,
    pub error: String,
    pub url: String,
    pub merge_base: String,
}

pub fn parse_heads(stdout: &str) -> Heads {
    let mut heads = Heads::default();
    for line in stdout.split('\n') {
        let mut parts = line.split('\t');
        let kind = parts.next().unwrap_or("");
        let a = parts.next().unwrap_or("").to_owned();
        let b = parts.next().unwrap_or("").to_owned();
        match kind {
            "S" => heads.source = a,
            "T" => heads.target = a,
            "F" => heads.feeders.push((a, b)),
            "E" => heads.error = a,
            "U" => heads.url = a,
            "M" => heads.merge_base = a,
            _ => {}
        }
    }
    heads
}

/// Every commit of target..source with files and patch id, the upstream
/// ones (`git cherry`), and each feeder's commits not on the source.
pub fn effort_commits_script(dir: &str, source: &str, target: &str, feeders: &[String]) -> String {
    let range = sh_quote(&format!("{target}..{source}"));
    let mut lines = vec![
        format!(
            "d={}; s={}; t={}",
            sh_quote(dir),
            sh_quote(source),
            sh_quote(target)
        ),
        format!(
            "git -C \"$d\" log --no-merges --reverse --format='C%x09%H%x09%at%x09%an%x09%s' {range}"
        ),
        format!("git -C \"$d\" log --no-merges --format='N%x09%H' --numstat {range}"),
        format!(
            "git -C \"$d\" log --no-merges -p --format='commit %H' {range} | git -C \"$d\" patch-id --stable | awk '{{ print \"I\\t\" $1 \"\\t\" $2 }}'"
        ),
        "git -C \"$d\" cherry \"$t\" \"$s\" | awk '{ print \"Y\\t\" $1 \"\\t\" $2 }'".to_owned(),
    ];
    for feeder in feeders {
        lines.push(format!(
            "printf \"F\\t%s\\t%s\\t%s\\n\" {} \"$(git -C \"$d\" cherry \"$s\" {} 2>/dev/null | grep -c '^+')\" \"$(git -C \"$d\" rev-list --count {}..{} 2>/dev/null)\"",
            sh_quote(feeder),
            sh_quote(feeder),
            sh_quote(feeder),
            sh_quote(source)
        ));
    }
    lines.push("exit 0".to_owned());
    lines.join("\n")
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct ReadCommit {
    pub sha: String,
    pub at: f64,
    pub author: String,
    pub subject: String,
    pub files: Vec<String>,
    pub sizes: Vec<f64>,
    pub patch_id: String,
    pub upstream: bool,
}

#[derive(Clone, Debug, PartialEq)]
pub struct ReadFeeder {
    pub reference: String,
    pub not_ready: f64,
    pub drift: f64,
}

static COUNT: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^(\d+|-)$").expect("pattern"));

fn number(text: &str) -> f64 {
    let n = js::number_from_text(text);
    if n.is_nan() { 0.0 } else { n }
}

pub fn parse_effort_commits(stdout: &str) -> (Vec<ReadCommit>, Vec<ReadFeeder>) {
    let mut commits: Vec<ReadCommit> = Vec::new();
    let mut by_sha: HashMap<String, usize> = HashMap::new();
    let mut feeders = Vec::new();
    let mut files: Option<usize> = None;
    for line in stdout.split('\n') {
        let parts: Vec<&str> = line.split('\t').collect();
        let kind = parts[0];
        if kind == "C" && parts.len() >= 5 {
            commits.push(ReadCommit {
                sha: parts[1].into(),
                at: number(parts[2]),
                author: parts[3].into(),
                subject: parts[4..].join("\t"),
                ..Default::default()
            });
            by_sha.insert(parts[1].into(), commits.len() - 1);
            files = None;
        } else if kind == "N" && parts.len() == 2 {
            files = by_sha.get(parts[1]).copied();
        } else if kind == "I" && parts.len() == 3 {
            if let Some(at) = by_sha.get(parts[2]) {
                commits[*at].patch_id = parts[1].into();
            }
            files = None;
        } else if kind == "Y" && parts.len() == 3 {
            if let Some(at) = by_sha.get(parts[2])
                && parts[1] == "-"
            {
                commits[*at].upstream = true;
            }
            files = None;
        } else if kind == "F" && parts.len() == 4 {
            feeders.push(ReadFeeder {
                reference: parts[1].into(),
                not_ready: number(parts[2]),
                drift: number(parts[3]),
            });
            files = None;
        } else if let Some(at) = files.filter(|_| parts.len() == 3 && COUNT.is_match(kind)) {
            commits[at].files.push(parts[2].into());
            commits[at].sizes.push(number(parts[0]) + number(parts[1]));
        } else if let Some(at) = files.filter(|_| !line.is_empty() && !line.contains('\t')) {
            commits[at].files.push(line.into());
            commits[at].sizes.push(0.0);
        }
    }
    for commit in &mut commits {
        if commit.patch_id.is_empty() {
            commit.patch_id = format!("sha:{}", commit.sha);
        }
    }
    (commits, feeders)
}

/// A path's top directory ("src/a/b.c" -> "src/a"), the most common.
pub fn top_dir(files: &[String]) -> String {
    let mut counts: Vec<(String, usize)> = Vec::new();
    for file in files {
        let parts: Vec<&str> = file.split('/').collect();
        let dir = if parts.len() > 2 {
            parts[..2].join("/")
        } else if parts.len() == 2 {
            parts[0].to_owned()
        } else {
            ".".to_owned()
        };
        match counts.iter_mut().find(|(d, _)| *d == dir) {
            Some((_, n)) => *n += 1,
            None => counts.push((dir, 1)),
        }
    }
    counts.sort_by(|a, b| b.1.cmp(&a.1));
    counts
        .into_iter()
        .next()
        .map_or_else(|| ".".to_owned(), |(d, _)| d)
}

/// The ledger key of each commit: its patch id, or the key it had before a
/// reword or rebase changed it (an alias, or author date and subject).
pub fn assign_keys(commits: &[ReadCommit], ledger: &Obj, previous: &[Value]) -> (Vec<String>, Obj) {
    let mut aliases = Obj::new();
    let mut used: HashSet<String> = HashSet::new();
    let entries = ledger
        .get("entries")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let mut known: HashSet<String> = entries.keys().cloned().collect();
    known.extend(previous.iter().map(|c| s(c, &["key"]).to_owned()));
    let date_text = |v: Option<&Value>| v.map(js::to_text).unwrap_or_else(|| "undefined".into());
    let mut secondary: HashMap<String, String> = HashMap::new();
    for commit in previous {
        secondary.insert(
            format!(
                "{}\0{}",
                date_text(commit.get("authorDate")),
                s(commit, &["subject"])
            ),
            s(commit, &["key"]).into(),
        );
    }
    for (key, entry) in &entries {
        secondary.insert(
            format!(
                "{}\0{}",
                date_text(entry.get("authorDate")),
                s(entry, &["subject"])
            ),
            key.clone(),
        );
    }
    let ledger_aliases = ledger.get("aliases").and_then(Value::as_object);
    let keys = commits
        .iter()
        .map(|commit| {
            let direct = ledger_aliases
                .and_then(|a| a.get(&commit.patch_id))
                .and_then(Value::as_str)
                .unwrap_or(&commit.patch_id)
                .to_owned();
            if known.contains(&direct) && !used.contains(&direct) {
                used.insert(direct.clone());
                return direct;
            }
            let before = secondary.get(&format!(
                "{}\0{}",
                js::number_text(commit.at),
                commit.subject
            ));
            if let Some(before) = before
                && !used.contains(before)
                && *before != commit.patch_id
            {
                used.insert(before.clone());
                aliases.insert(commit.patch_id.clone(), json!(before));
                return before.clone();
            }
            used.insert(commit.patch_id.clone());
            commit.patch_id.clone()
        })
        .collect();
    (keys, aliases)
}

/// One derived commit's disposition (and note, upstreamAnyway), as `{...}`
/// fields in the TS order.
pub fn disposition(
    commit: &ReadCommit,
    authored: Option<&Value>,
    in_review: Option<&str>,
    in_part: Option<&str>,
    planned: Option<&str>,
) -> Obj {
    let mut out = Obj::new();
    let authored_disposition = authored.map(|a| s(a, &["disposition"]));
    let reason = authored
        .map(|a| s(a, &["reason"]))
        .filter(|r| !r.is_empty());
    let pointer = authored
        .map(|a| s(a, &["pointer"]))
        .filter(|r| !r.is_empty());
    let put = |out: &mut Obj, d: &str, note: Option<String>| {
        out.insert("disposition".into(), json!(d));
        if let Some(note) = note {
            out.insert("note".into(), json!(note));
        }
    };
    match authored_disposition {
        Some("not_for_upstream") => {
            put(&mut out, "not_for_upstream", reason.map(str::to_owned));
            if commit.upstream {
                out.insert("upstreamAnyway".into(), json!(true));
            }
        }
        Some("superseded") => put(&mut out, "superseded", pointer.map(|p| format!("by {p}"))),
        _ if commit.upstream => put(&mut out, "upstream", None),
        _ if in_review.is_some() => put(&mut out, "in_review", in_review.map(str::to_owned)),
        _ if in_part.is_some() => put(&mut out, "in_part", in_part.map(str::to_owned)),
        _ if planned.is_some() => put(&mut out, "planned", planned.map(str::to_owned)),
        Some(d) => {
            // `authored.pointer ?? authored.reason`: an empty pointer still wins.
            let note = if pointer.is_some() || reason.is_some() {
                authored
                    .and_then(|a| a.get("pointer").or_else(|| a.get("reason")))
                    .map(js::to_text)
            } else {
                None
            };
            put(&mut out, d, note)
        }
        None => put(&mut out, "unsorted", None),
    }
    out
}

/// Counts by disposition, in first-seen order.
pub fn counts_of(commits: &[Value]) -> Obj {
    let mut counts = Obj::new();
    for commit in commits {
        let d = s(commit, &["disposition"]);
        let n = counts.get(d).and_then(Value::as_f64).unwrap_or(0.0) + 1.0;
        counts.insert(d.to_owned(), js::number(n));
    }
    counts
}

/// Commits two sets share and what to do about it (D23).
pub fn overlap_of(
    mine: &HashSet<String>,
    theirs: &HashSet<String>,
    with: &str,
    kind: &str,
) -> Option<Obj> {
    let shared = mine.iter().filter(|id| theirs.contains(*id)).count();
    if shared == 0 {
        return None;
    }
    let relation = if shared == mine.len() && shared == theirs.len() {
        "same"
    } else if shared == theirs.len() {
        "contains"
    } else if shared == mine.len() {
        "contained"
    } else {
        "partial"
    };
    let proposal = match relation {
        "same" => format!(
            "Same commits as {with}: keep one effort, the other as a feeder (or drop it as a copy)"
        ),
        "contains" => {
            format!("All of {with} is here: stack it under this effort, or make it a feeder")
        }
        "contained" => format!("All of this is in {with}: stack this effort under it"),
        _ => format!("{shared} commits shared with {with}: put them in one part only"),
    };
    Some(obj(
        json!({"with": with, "kind": kind, "shared": shared, "relation": relation, "proposal": proposal}),
    ))
}

/// An effort's files: ledger, derived, seen, history; one change at a time.
#[derive(Clone)]
pub struct LedgerStore {
    context: DataContext,
    root: PathBuf,
    queues: Arc<Mutex<HashMap<String, Arc<Mutex<()>>>>>,
}

impl LedgerStore {
    /// `root`: `<data>/mr-reviews/efforts`.
    pub fn new(context: DataContext, root: impl Into<PathBuf>) -> LedgerStore {
        LedgerStore {
            context,
            root: root.into(),
            queues: Arc::default(),
        }
    }

    fn dir_of(&self, id: &str) -> PathBuf {
        let dir = self.root.join(id);
        let _ = create_dir_all_mode(&dir);
        dir
    }

    fn read(path: &Path) -> Option<Value> {
        let text = std::fs::read_to_string(path).ok()?;
        serde_json::from_str::<Value>(&text).ok().map(js::js_value)
    }

    fn write(&self, path: &Path, value: &Value) {
        let text = format!("{}\n", js::stringify(value));
        if let Err(error) = self.context.replace_data_file(path, text.as_bytes(), 0o600) {
            tracing::warn!(target: "bridge.mr-reviews", "{}: {error}", path.display());
        }
    }

    pub fn ledger(&self, id: &str) -> Obj {
        match Self::read(&self.dir_of(id).join("ledger.json")) {
            Some(Value::Object(map)) => normal_ledger(map),
            _ => empty_ledger(),
        }
    }

    /// What the user saw last (What changed); never exported.
    pub fn seen(&self, id: &str) -> Option<Obj> {
        Self::read(&self.dir_of(id).join("seen.json")).and_then(|v| v.as_object().cloned())
    }

    pub fn write_seen(&self, id: &str, seen: &Obj) {
        self.write(
            &self.dir_of(id).join("seen.json"),
            &Value::Object(seen.clone()),
        );
    }

    pub fn derived(&self, id: &str) -> Option<Obj> {
        Self::read(&self.dir_of(id).join("derived.json")).and_then(|v| v.as_object().cloned())
    }

    pub fn write_ledger(&self, id: &str, ledger: &Obj) {
        self.write(
            &self.dir_of(id).join("ledger.json"),
            &Value::Object(ledger.clone()),
        );
    }

    pub fn write_derived(&self, id: &str, derived: &Obj) {
        self.write(
            &self.dir_of(id).join("derived.json"),
            &Value::Object(derived.clone()),
        );
    }

    /// Appends versions of commits (D24): one line each, never rewritten.
    pub fn append_history(&self, id: &str, lines: &[Obj]) {
        use std::io::Write;
        if lines.is_empty() {
            return;
        }
        let text: String = lines
            .iter()
            .map(|l| format!("{}\n", js::stringify(&Value::Object(l.clone()))))
            .collect();
        let path = self.dir_of(id).join("history.jsonl");
        let result = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&path)
            .and_then(|mut f| f.write_all(text.as_bytes()));
        if let Err(error) = result {
            tracing::warn!(target: "bridge.mr-reviews", "{}: {error}", path.display());
        }
    }

    pub fn history(&self, id: &str, key: Option<&str>) -> Vec<Obj> {
        let Ok(text) = std::fs::read_to_string(self.dir_of(id).join("history.jsonl")) else {
            return vec![];
        };
        text.split('\n')
            .filter(|l| !l.is_empty())
            .filter_map(|l| serde_json::from_str::<Value>(l).ok())
            .filter_map(|v| v.as_object().cloned())
            .filter(|v| key.is_none_or(|k| v.get("key").and_then(Value::as_str) == Some(k)))
            .collect()
    }

    /// One change of an effort's files at a time.
    pub fn queue<T>(&self, id: &str, change: impl FnOnce() -> T) -> T {
        let lock = {
            let mut queues = self.queues.lock().unwrap_or_else(|e| e.into_inner());
            queues.entry(id.to_owned()).or_default().clone()
        };
        let _guard = lock.lock().unwrap_or_else(|e| e.into_inner());
        change()
    }
}

fn change_count(changes: &Obj) -> usize {
    [
        "unsorted",
        "landed",
        "inReview",
        "feeders",
        "partsMerged",
        "upstreamAnyway",
    ]
    .iter()
    .map(|k| {
        changes
            .get(*k)
            .and_then(Value::as_array)
            .map_or(0, Vec::len)
    })
    .sum()
}

static SOURCE_PREFIX: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^refs/(heads|remotes)/").expect("pattern"));

/// The effort's card.
pub fn effort_summary(
    effort: &Effort,
    derived: Option<&Obj>,
    overlaps: Vec<Value>,
    head: Option<Value>,
    more: Option<(&Obj, Option<&Obj>)>,
) -> Obj {
    let commits: Vec<Value> = derived
        .and_then(|d| d.get("commits"))
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let changes = more.map(|(ledger, seen)| changes_of(derived, ledger, seen));
    let not_ready: f64 = derived
        .and_then(|d| d.get("feeders"))
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .map(|f| f.get("notReady").and_then(Value::as_f64).unwrap_or(0.0))
        .sum();
    let mut out = Obj::new();
    out.insert(
        "id".into(),
        effort.get("id").cloned().unwrap_or(Value::Null),
    );
    out.insert(
        "name".into(),
        effort.get("name").cloned().unwrap_or(Value::Null),
    );
    out.insert(
        "group".into(),
        effort.get("group").cloned().unwrap_or(Value::Null),
    );
    out.insert(
        "source".into(),
        json!(SOURCE_PREFIX.replace(s(effort, &["source"]), "")),
    );
    out.insert(
        "target".into(),
        json!(format!(
            "{}/{}",
            s(effort, &["target", "remote"]),
            s(effort, &["target", "branch"])
        )),
    );
    out.insert("total".into(), json!(commits.len()));
    out.insert("counts".into(), Value::Object(counts_of(&commits)));
    out.insert("notReady".into(), js::number(not_ready));
    for key in ["at", "error"] {
        if let Some(value) = derived
            .and_then(|d| d.get(key))
            .filter(|v| v.as_str().is_some_and(|s| !s.is_empty()))
        {
            out.insert(key.into(), value.clone());
        }
    }
    out.insert("overlaps".into(), Value::Array(overlaps));
    if let Some(head) = head {
        out.insert("head".into(), head);
    }
    if let Some(changes) = &changes {
        out.insert(
            "proposals".into(),
            json!(
                changes
                    .get("proposals")
                    .and_then(Value::as_array)
                    .map_or(0, Vec::len)
            ),
        );
        out.insert("changed".into(), json!(change_count(changes)));
    }
    if let Some((ledger, _)) = more {
        let plans = ledger
            .get("plans")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        if !plans.is_empty() {
            let count = |state: &str| plans.iter().filter(|p| s(p, &["state"]) == state).count();
            out.insert(
                "plans".into(),
                json!({"proposed": count("proposed"), "accepted": count("accepted")}),
            );
        }
    }
    out
}

/// Commits matching a filter, as `ledger_list` and the table read it.
pub fn filter_ledger(
    commits: &[Value],
    disposition: Option<&str>,
    text: Option<&str>,
) -> Vec<Value> {
    let lower = text.unwrap_or("").to_lowercase();
    let words: Vec<&str> = lower.split_whitespace().collect();
    commits
        .iter()
        .filter(|commit| {
            if let Some(d) = disposition.filter(|d| !d.is_empty())
                && s(commit, &["disposition"]) != d
            {
                return false;
            }
            words.iter().all(|word| {
                let (key, value) = match word.find(':') {
                    Some(at) => (&word[..at], &word[at + 1..]),
                    None => ("", *word),
                };
                match key {
                    "disposition" => s(commit, &["disposition"]) == value.replace('-', "_"),
                    "dir" => s(commit, &["dir"]).to_lowercase().starts_with(value),
                    "file" => strings(commit.get("files"))
                        .iter()
                        .any(|f| f.to_lowercase().contains(value)),
                    "author" => s(commit, &["author"]).to_lowercase().contains(value),
                    _ => {
                        s(commit, &["subject"]).to_lowercase().contains(value)
                            || s(commit, &["sha"]).starts_with(value)
                    }
                }
            })
        })
        .cloned()
        .collect()
}

static FIX: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^(?:fixup|squash|amend)! (.*)$").expect("pattern"));
static PREFIX: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^([A-Za-z0-9_./-]{2,40}):\s").expect("pattern"));

/// A first grouping of unsorted commits for the leader session (D15).
pub fn cluster_ledger(commits: &[Value]) -> Vec<Obj> {
    let mut by_subject: HashMap<&str, &Value> = HashMap::new();
    for commit in commits {
        by_subject.insert(s(commit, &["subject"]), commit);
    }
    let mut clusters: Vec<(String, Vec<&Value>)> = Vec::new();
    for commit in commits {
        let subject = s(commit, &["subject"]);
        let base = FIX
            .captures(subject)
            .and_then(|c| by_subject.get(c.get(1).map_or("", |m| m.as_str())).copied());
        let subject_of = base.map_or(subject, |b| s(b, &["subject"]));
        let prefix = PREFIX.captures(subject_of).map(|c| c[1].to_owned());
        let dir = base.map_or_else(|| s(commit, &["dir"]), |b| s(b, &["dir"]));
        let label = format!(
            "{dir}{}",
            prefix.map_or(String::new(), |p| format!(" {p}:"))
        );
        match clusters.iter_mut().find(|(l, _)| *l == label) {
            Some((_, list)) => list.push(commit),
            None => clusters.push((label, vec![commit])),
        }
    }
    let mut out: Vec<Obj> = clusters
        .into_iter()
        .map(|(label, list)| {
            let mut files: HashSet<String> = HashSet::new();
            for commit in &list {
                files.extend(strings(commit.get("files")));
            }
            obj(json!({
                "label": label,
                "size": list.len(),
                "files": files.len(),
                "commits": list.iter().map(|c| js::head16(s(c, &["sha"]), 12)).collect::<Vec<_>>(),
            }))
        })
        .collect();
    let n = |o: &Obj, k: &str| o.get(k).and_then(Value::as_u64).unwrap_or(0);
    out.sort_by(|a, b| {
        n(a, "size")
            .cmp(&n(b, "size"))
            .then(n(a, "files").cmp(&n(b, "files")))
    });
    out
}

/// A request's patch ids (for in review), read by the caller.
pub struct RequestIds {
    pub key: String,
    pub label: String,
    pub ids: HashSet<String>,
}

pub struct DeriveInput<'a> {
    pub effort: &'a Effort,
    pub connection: &'a dyn MrConnection,
    pub store: &'a LedgerStore,
    pub check_target: bool,
    /// The user's requests on the target project: given its remote URL and the target sha.
    pub requests: Box<
        dyn FnOnce(
                String,
                String,
            ) -> crate::connection::BoxFuture<'a, Result<Vec<RequestIds>, String>>
            + Send
            + 'a,
    >,
    /// Patch ids in each part (label, ids).
    pub parts: Vec<(String, HashSet<String>)>,
    /// Patch ids in a plan or part of another effort (D4): its name, in order.
    pub elsewhere: Vec<(String, String)>,
    pub now: f64,
    pub force: bool,
}

/// Derives an effort: heads first, then the commits only when a head moved.
pub async fn derive_effort(input: DeriveInput<'_>) -> (Obj, bool) {
    let effort = input.effort;
    let id = s(effort, &["id"]).to_owned();
    let store = input.store;
    let previous = store.derived(&id);
    let heads = parse_heads(
        &input
            .connection
            .run(&effort_heads_script(effort, input.check_target), 120_000)
            .await
            .stdout,
    );
    let ledger = store.ledger(&id);
    let requests = if !heads.source.is_empty() && !heads.target.is_empty() {
        (input.requests)(heads.url.clone(), heads.target.clone())
            .await
            .unwrap_or_default()
    } else {
        vec![]
    };
    let requests_key = requests
        .iter()
        .map(|r| format!("{}:{}", r.key, r.ids.len()))
        .collect::<Vec<_>>()
        .join(",");
    let parts_key = input
        .parts
        .iter()
        .map(|(label, ids)| format!("{label}:{}", ids.len()))
        .chain(
            input
                .elsewhere
                .iter()
                .map(|(id, name)| format!("{id}>{name}")),
        )
        .collect::<Vec<_>>()
        .join(",");
    let mut key_parts = vec![heads.source.clone(), heads.target.clone()];
    key_parts.extend(heads.feeders.iter().map(|(_, sha)| sha.clone()));
    key_parts.push(requests_key);
    key_parts.push(parts_key);
    key_parts.push(
        ledger
            .get("version")
            .map(js::to_text)
            .unwrap_or_else(|| "0".into()),
    );
    let key = key_parts.join("|");
    if !heads.error.is_empty() || heads.source.is_empty() || heads.target.is_empty() {
        let mut derived = previous.unwrap_or_else(|| {
            obj(json!({"heads": "", "at": "", "commits": [], "feeders": [], "daily": [], "seen": {}}))
        });
        let error = if !heads.error.is_empty() {
            heads.error.clone()
        } else if heads.source.is_empty() {
            format!(
                "{} is not in {}",
                s(effort, &["source"]),
                s(effort, &["clone", "path"])
            )
        } else {
            format!(
                "{}/{} could not be read",
                s(effort, &["target", "remote"]),
                s(effort, &["target", "branch"])
            )
        };
        derived.insert("error".into(), json!(error));
        return (derived, false);
    }
    if !input.force
        && let Some(previous) = &previous
        && s(&Value::Object(previous.clone()), &["heads"]) == key
        && previous
            .get("error")
            .is_none_or(|e| !e.as_str().is_some_and(|s| !s.is_empty()))
    {
        return (previous.clone(), false);
    }
    let width = 2 + heads.feeders.len();
    let head_of = |text: &str| text.split('|').take(width).collect::<Vec<_>>().join("|");
    let previous_heads = previous.as_ref().map(|p| js::sv(p.get("heads")).to_owned());
    let same_commits = previous_heads
        .as_deref()
        .is_some_and(|h| head_of(h) == head_of(&key));
    let (read_commits, read_feeders): (Vec<ReadCommit>, Vec<Value>) = if same_commits
        && !input.force
    {
        let previous = previous.as_ref().expect("same commits have a previous");
        let commits = previous
            .get("commits")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .map(|c| {
                let files = strings(c.get("files"));
                let sizes = match c.get("sizes").and_then(Value::as_array) {
                    Some(sizes) => sizes.iter().map(|v| v.as_f64().unwrap_or(0.0)).collect(),
                    None => files.iter().map(|_| 0.0).collect(),
                };
                ReadCommit {
                    sha: s(c, &["sha"]).into(),
                    at: c.get("authorDate").and_then(Value::as_f64).unwrap_or(0.0),
                    author: s(c, &["author"]).into(),
                    subject: s(c, &["subject"]).into(),
                    files,
                    sizes,
                    patch_id: s(c, &["patchId"]).into(),
                    upstream: s(c, &["disposition"]) == "upstream"
                        || js::is_true(c.get("upstreamAnyway")),
                }
            })
            .collect();
        (
            commits,
            previous
                .get("feeders")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default(),
        )
    } else {
        let stdout = input
            .connection
            .run(
                &effort_commits_script(
                    s(effort, &["clone", "path"]),
                    &heads.source,
                    &heads.target,
                    &strings(effort.get("feeders")),
                ),
                300_000,
            )
            .await
            .stdout;
        let (commits, feeders) = parse_effort_commits(&stdout);
        let feeders = feeders
            .into_iter()
            .map(|f| json!({"ref": f.reference, "notReady": js::number(f.not_ready), "drift": js::number(f.drift)}))
            .collect();
        (commits, feeders)
    };
    let upstream_key = format!("{}|{}|{}", heads.source, heads.target, heads.merge_base);
    let mut upstream: Option<Value> = previous
        .as_ref()
        .and_then(|p| p.get("upstream"))
        .filter(|u| s(u, &["key"]) == upstream_key)
        .cloned();
    if upstream.is_none()
        && !heads.merge_base.is_empty()
        && read_commits.iter().any(|c| !c.upstream)
    {
        let stdout = input
            .connection
            .run(
                &fuzzy::upstream_candidates_script(
                    s(effort, &["clone", "path"]),
                    &heads.source,
                    &heads.target,
                    &heads.merge_base,
                    3000,
                    &sh_quote,
                ),
                300_000,
            )
            .await
            .stdout;
        let (found, _) = fuzzy::parse_upstream_candidates(&stdout);
        upstream = Some(
            json!({"key": upstream_key, "commits": found.iter().map(UpstreamCandidate::to_json).collect::<Vec<_>>()}),
        );
    }
    store.queue(&id, || {
        let mut current = store.ledger(&id);
        let previous_commits: Vec<Value> =
            previous.as_ref().and_then(|p| p.get("commits")).and_then(Value::as_array).cloned().unwrap_or_default();
        let (keys, aliases) = assign_keys(&read_commits, &current, &previous_commits);
        if !aliases.is_empty() {
            let mut all = current.get("aliases").and_then(Value::as_object).cloned().unwrap_or_default();
            for (k, v) in aliases {
                all.insert(k, v);
            }
            current.insert("aliases".into(), Value::Object(all));
            store.write_ledger(&id, &current);
        }
        let mut review: HashMap<&str, &str> = HashMap::new();
        for request in &requests {
            for patch in &request.ids {
                review.entry(patch).or_insert(&request.label);
            }
        }
        let mut part: HashMap<String, String> = HashMap::new();
        for (label, ids) in &input.parts {
            for patch in ids {
                part.entry(patch.clone()).or_insert_with(|| label.clone());
            }
        }
        for (patch, name) in &input.elsewhere {
            part.entry(patch.clone()).or_insert_with(|| format!("in a part of {name}"));
        }
        let mut plan_of: HashMap<String, String> = HashMap::new();
        for plan in current.get("plans").and_then(Value::as_array).into_iter().flatten() {
            for key in strings(plan.get("commits")) {
                plan_of.insert(key, s(plan, &["name"]).into());
            }
        }
        let entries = current.get("entries").and_then(Value::as_object).cloned().unwrap_or_default();
        let commits: Vec<Value> = read_commits
            .iter()
            .enumerate()
            .map(|(index, commit)| {
                let ledger_key = &keys[index];
                let mut o = obj(json!({
                    "key": ledger_key,
                    "sha": commit.sha,
                    "patchId": commit.patch_id,
                    "subject": commit.subject,
                    "author": commit.author,
                    "authorDate": js::number(commit.at),
                    "files": commit.files.iter().take(40).collect::<Vec<_>>(),
                    "sizes": commit.sizes.iter().take(40).map(|n| js::number(*n)).collect::<Vec<_>>(),
                    "dir": top_dir(&commit.files),
                }));
                let d = disposition(
                    commit,
                    entries.get(ledger_key),
                    review.get(commit.patch_id.as_str()).copied(),
                    part.get(&commit.patch_id).map(String::as_str),
                    plan_of.get(ledger_key).map(String::as_str),
                );
                for (k, v) in d {
                    o.insert(k, v);
                }
                Value::Object(o)
            })
            .collect();
        let matches = current.get("matches").and_then(Value::as_object).cloned().unwrap_or_default();
        let unsorted: Vec<MatchCommit> = commits
            .iter()
            .filter(|c| s(c, &["disposition"]) == "unsorted")
            .map(|c| MatchCommit {
                key: s(c, &["key"]).into(),
                subject: s(c, &["subject"]).into(),
                author: s(c, &["author"]).into(),
                files: strings(c.get("files")),
                sizes: c.get("sizes").and_then(Value::as_array).map(|a| a.iter().map(|v| v.as_f64().unwrap_or(0.0)).collect()),
            })
            .collect();
        let candidates: Vec<UpstreamCandidate> = upstream
            .as_ref()
            .and_then(|u| u.get("commits"))
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .map(candidate_of)
            .collect();
        let rejected = |key: &str| strings(matches.get(key).and_then(|m| m.get("rejected")));
        let proposals = fuzzy::propose_matches(&unsorted, &candidates, &rejected, None, None);
        let mut seen: Obj =
            previous.as_ref().and_then(|p| p.get("seen")).and_then(Value::as_object).cloned().unwrap_or_default();
        let at = js::iso(input.now);
        let mut lines: Vec<Obj> = Vec::new();
        for commit in &commits {
            let version = format!("{}:{}", s(commit, &["sha"]), s(commit, &["patchId"]));
            let key = s(commit, &["key"]);
            if seen.get(key).and_then(Value::as_str) == Some(version.as_str()) {
                continue;
            }
            seen.insert(key.into(), json!(version));
            lines.push(obj(json!({
                "key": key, "sha": commit["sha"], "patchId": commit["patchId"], "subject": commit["subject"],
                "authorDate": commit["authorDate"], "seenAt": at, "where": "source",
            })));
        }
        store.append_history(&id, &lines);
        let date = at[..10].to_owned();
        let mut daily: Vec<Value> = previous
            .as_ref()
            .and_then(|p| p.get("daily"))
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter(|d| s(d, &["date"]) != date)
            .cloned()
            .collect();
        daily.push(json!({"date": date, "counts": counts_of(&commits)}));
        let skip = daily.len().saturating_sub(365);
        let daily: Vec<Value> = daily.into_iter().skip(skip).collect();
        let feeder_shas: HashMap<&str, &str> = heads.feeders.iter().map(|(r, sha)| (r.as_str(), sha.as_str())).collect();
        let feeders: Vec<Value> = read_feeders
            .iter()
            .map(|f| {
                let mut o = obj(json!({"ref": f["ref"], "notReady": f["notReady"], "drift": f["drift"]}));
                o.insert("sha".into(), json!(feeder_shas.get(s(f, &["ref"])).copied().unwrap_or("")));
                Value::Object(o)
            })
            .collect();
        let mut derived = obj(json!({"heads": key, "at": at, "commits": commits, "feeders": feeders, "daily": daily, "seen": seen}));
        if let Some(upstream) = upstream {
            derived.insert("upstream".into(), upstream);
        }
        let mut proposal_map = Obj::new();
        for (key, list) in proposals {
            proposal_map.insert(key, Value::Array(list.iter().map(fuzzy::Proposal::to_json).collect()));
        }
        derived.insert("proposals".into(), Value::Object(proposal_map));
        store.write_derived(&id, &derived);
        if store.seen(&id).is_none() {
            store.write_seen(&id, &snapshot_of(&derived, &current, input.now));
        }
        (derived, true)
    })
}

fn candidate_of(value: &Value) -> UpstreamCandidate {
    UpstreamCandidate {
        sha: s(value, &["sha"]).into(),
        subject: s(value, &["subject"]).into(),
        author: s(value, &["author"]).into(),
        at: value.get("at").and_then(Value::as_f64).unwrap_or(0.0),
        files: strings(value.get("files")),
        sizes: value
            .get("sizes")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .map(|v| v.as_f64().unwrap_or(0.0))
            .collect(),
    }
}

/// Commits named by key, patch id or a sha of 7 characters at least.
pub fn resolve_commits(commits: &[Value], names: &[String]) -> (Vec<Value>, Vec<String>) {
    let mut found = Vec::new();
    let mut unknown = Vec::new();
    for name in names {
        let lower = name.to_lowercase();
        let matches: Vec<&Value> = commits
            .iter()
            .filter(|c| {
                s(c, &["key"]) == name
                    || s(c, &["patchId"]) == name
                    || (js::len16(&lower) >= 7 && s(c, &["sha"]).starts_with(&lower))
            })
            .collect();
        if matches.len() == 1 {
            found.push(matches[0].clone());
        } else {
            unknown.push(name.clone());
        }
    }
    (found, unknown)
}

pub fn is_authored_disposition(value: &str) -> bool {
    value == "unsorted" || AUTHORED_DISPOSITIONS.contains(&value)
}

fn last_journal_id(ledger: &Obj) -> f64 {
    ledger
        .get("journal")
        .and_then(Value::as_array)
        .and_then(|j| j.last())
        .and_then(|e| e.get("id"))
        .and_then(Value::as_f64)
        .unwrap_or(0.0)
}

fn bump_version(ledger: &mut Obj) {
    let version = ledger.get("version").and_then(Value::as_f64).unwrap_or(0.0) + 1.0;
    ledger.insert("version".into(), js::number(version));
}

fn push_journal(ledger: &mut Obj, entry: Obj) {
    let mut journal = ledger
        .get("journal")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    journal.push(Value::Object(entry));
    let skip = journal.len().saturating_sub(LEDGER_JOURNAL);
    ledger.insert(
        "journal".into(),
        Value::Array(journal.into_iter().skip(skip).collect()),
    );
}

fn entries_mut(ledger: &mut Obj, name: &str) -> Obj {
    ledger
        .get(name)
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default()
}

/// Who changes the ledger, and when.
pub struct Author<'a> {
    pub by: &'a str,
    pub summary: &'a str,
    pub now: f64,
}

/// Sets authored dispositions (all or nothing, journaled); `unsorted` clears.
/// `(changed, unknown, journal)`.
pub fn set_dispositions(
    store: &LedgerStore,
    effort: &Effort,
    commits_named: &[String],
    disposition: &str,
    reason: Option<&str>,
    pointer: Option<&str>,
    author: &Author,
) -> Result<(usize, Vec<String>, f64), String> {
    let id = s(effort, &["id"]).to_owned();
    store.queue(&id, || {
        if commits_named.len() > LEDGER_BULK_MAX {
            return Err(format!("At most {LEDGER_BULK_MAX} commits a call."));
        }
        let commits: Vec<Value> =
            store.derived(&id).and_then(|d| d.get("commits").and_then(Value::as_array).cloned()).unwrap_or_default();
        let mut ledger = store.ledger(&id);
        let (found, unknown) = resolve_commits(&commits, commits_named);
        if !unknown.is_empty() {
            return Ok((0, unknown, last_journal_id(&ledger)));
        }
        let at = js::iso(author.now);
        let mut before = Obj::new();
        let mut entries = entries_mut(&mut ledger, "entries");
        for commit in &found {
            let key = s(commit, &["key"]).to_owned();
            before.insert(key.clone(), entries.get(&key).cloned().unwrap_or(Value::Null));
            if disposition == "unsorted" {
                entries.shift_remove(&key);
            } else {
                let mut entry = obj(json!({"disposition": disposition}));
                if let Some(reason) = reason.filter(|r| !r.is_empty()) {
                    entry.insert("reason".into(), json!(js::head16(reason, 300)));
                }
                if let Some(pointer) = pointer.filter(|p| !p.is_empty()) {
                    entry.insert("pointer".into(), json!(js::head16(pointer, 300)));
                }
                for (k, v) in obj(json!({"subject": commit["subject"], "authorDate": commit["authorDate"], "sha": commit["sha"], "at": at, "by": author.by})) {
                    entry.insert(k, v);
                }
                entries.insert(key, Value::Object(entry));
            }
        }
        ledger.insert("entries".into(), Value::Object(entries));
        let journal = last_journal_id(&ledger) + 1.0;
        push_journal(
            &mut ledger,
            obj(json!({"id": js::number(journal), "at": at, "by": author.by, "summary": js::head16(author.summary, 200), "before": before})),
        );
        bump_version(&mut ledger);
        store.write_ledger(&id, &ledger);
        Ok((found.len(), vec![], journal))
    })
}

/// Takes back a bulk change (the last one when no id is given): its summary.
pub fn undo_ledger(
    store: &LedgerStore,
    effort_id: &str,
    journal_id: Option<f64>,
) -> Option<String> {
    store.queue(effort_id, || {
        let mut ledger = store.ledger(effort_id);
        let mut journal = ledger
            .get("journal")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let at = match journal_id {
            None => journal.len().checked_sub(1)?,
            Some(wanted) => journal
                .iter()
                .position(|e| e.get("id").and_then(Value::as_f64) == Some(wanted))?,
        };
        let entry = journal.remove(at);
        for (name, field) in [("entries", "before"), ("matches", "matches")] {
            let mut map = entries_mut(&mut ledger, name);
            for (key, value) in entry
                .get(field)
                .and_then(Value::as_object)
                .into_iter()
                .flatten()
            {
                if value.is_null() {
                    map.shift_remove(key);
                } else {
                    map.insert(key.clone(), value.clone());
                }
            }
            ledger.insert(name.into(), Value::Object(map));
        }
        if let Some(plans) = entry.get("plans").filter(|p| p.is_array()) {
            ledger.insert("plans".into(), plans.clone());
        }
        ledger.insert("journal".into(), Value::Array(journal));
        bump_version(&mut ledger);
        store.write_ledger(effort_id, &ledger);
        Some(js::sv(entry.get("summary")).to_owned())
    })
}

fn journal_of(ledger: &mut Obj, author: &Author, before: Obj, extra: Obj) -> f64 {
    let id = last_journal_id(ledger) + 1.0;
    let mut entry = obj(
        json!({"id": js::number(id), "at": js::iso(author.now), "by": author.by,
        "summary": js::head16(author.summary, 200), "before": before}),
    );
    for (k, v) in extra {
        entry.insert(k, v);
    }
    push_journal(ledger, entry);
    bump_version(ledger);
    id
}

/// A fuzzy match decision: the commit, the upstream sha, accepted or not.
pub struct Decision {
    pub commit: String,
    pub matched: String,
    pub accept: bool,
}

/// Confirms or rejects fuzzy matches (D14), all or nothing.
/// `(accepted, rejected, journal)`.
pub fn decide_matches(
    store: &LedgerStore,
    effort: &Effort,
    decisions: &[Decision],
    author: &Author,
) -> Result<(usize, usize, f64), String> {
    let id = s(effort, &["id"]).to_owned();
    store.queue(&id, || {
        if decisions.len() > LEDGER_BULK_MAX {
            return Err(format!("At most {LEDGER_BULK_MAX} decisions a call."));
        }
        let derived = store.derived(&id);
        let commits: Vec<Value> = derived.as_ref().and_then(|d| d.get("commits")).and_then(Value::as_array).cloned().unwrap_or_default();
        let candidates: Vec<Value> = derived
            .as_ref()
            .and_then(|d| d.get("upstream"))
            .and_then(|u| u.get("commits"))
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let mut ledger = store.ledger(&id);
        let mut problems: Vec<String> = Vec::new();
        let mut resolved: Vec<(&Decision, Value, Option<Value>)> = Vec::new();
        for decision in decisions {
            let (found, _) = resolve_commits(&commits, std::slice::from_ref(&decision.commit));
            let commit = found.into_iter().next();
            let lower = decision.matched.to_lowercase();
            let proposed: Vec<Value> = commit
                .as_ref()
                .and_then(|c| derived.as_ref()?.get("proposals")?.get(s(c, &["key"]))?.as_array().cloned())
                .unwrap_or_default();
            let mut pool: Vec<Value> = proposed.iter().map(|p| json!({"sha": p["sha"], "subject": p["subject"], "at": 0})).collect();
            pool.extend(candidates.iter().cloned());
            let mut shas: Vec<String> = Vec::new();
            for each in &pool {
                let sha = s(each, &["sha"]);
                if js::len16(&lower) >= 7 && sha.starts_with(&lower) && !shas.iter().any(|x| x == sha) {
                    shas.push(sha.into());
                }
            }
            match &commit {
                None => problems.push(format!("{}: not in the ledger", decision.commit)),
                Some(_) if shas.len() != 1 => problems.push(format!(
                    "{}: {}",
                    decision.matched,
                    if shas.is_empty() { "not an upstream commit since the merge base" } else { "ambiguous" }
                )),
                _ => {}
            }
            let matched = shas.first().and_then(|sha| pool.iter().find(|e| s(e, &["sha"]) == sha).cloned());
            resolved.push((decision, commit.unwrap_or(Value::Null), matched));
        }
        if !problems.is_empty() {
            return Err(format!("{}; nothing changed", problems.iter().take(20).cloned().collect::<Vec<_>>().join("; ")));
        }
        let at = js::iso(author.now);
        let mut before = Obj::new();
        let mut matches_before = Obj::new();
        let mut lines: Vec<Obj> = Vec::new();
        let (mut accepted, mut rejected) = (0, 0);
        let mut entries = entries_mut(&mut ledger, "entries");
        let mut matches = entries_mut(&mut ledger, "matches");
        for (decision, commit, matched) in resolved {
            let key = s(&commit, &["key"]).to_owned();
            let matched = matched.unwrap_or(Value::Null);
            let sha = s(&matched, &["sha"]).to_owned();
            if !matches_before.contains_key(&key) {
                matches_before.insert(key.clone(), matches.get(&key).cloned().unwrap_or(Value::Null));
            }
            let current = matches
                .get(&key)
                .and_then(Value::as_object)
                .cloned()
                .unwrap_or_else(|| obj(json!({"rejected": [], "at": at, "by": author.by})));
            if decision.accept {
                accepted += 1;
                if !before.contains_key(&key) {
                    before.insert(key.clone(), entries.get(&key).cloned().unwrap_or(Value::Null));
                }
                entries.insert(
                    key.clone(),
                    json!({"disposition": "upstream", "pointer": sha, "reason": "matched by hand", "subject": commit["subject"],
                        "authorDate": commit["authorDate"], "sha": commit["sha"], "at": at, "by": author.by}),
                );
                let mut next = current.clone();
                next.insert("accepted".into(), json!(sha));
                let kept: Vec<String> = strings(current.get("rejected")).into_iter().filter(|x| *x != sha).collect();
                next.insert("rejected".into(), json!(kept));
                next.insert("at".into(), json!(at));
                next.insert("by".into(), json!(author.by));
                matches.insert(key.clone(), Value::Object(next));
                lines.push(obj(json!({"key": key, "sha": sha, "patchId": "", "subject": matched["subject"],
                    "authorDate": matched.get("at").cloned().unwrap_or(json!(0)), "seenAt": at, "where": "upstream"})));
            } else {
                rejected += 1;
                let mut list = strings(current.get("rejected"));
                if !list.contains(&sha) {
                    list.push(sha.clone());
                }
                let skip = list.len().saturating_sub(50);
                let mut next = current.clone();
                next.insert("rejected".into(), json!(list.into_iter().skip(skip).collect::<Vec<_>>()));
                next.insert("at".into(), json!(at));
                next.insert("by".into(), json!(author.by));
                let was_accepted = current.get("accepted").and_then(Value::as_str) == Some(sha.as_str());
                if was_accepted {
                    next.shift_remove("accepted");
                }
                matches.insert(key.clone(), Value::Object(next));
                if was_accepted {
                    if !before.contains_key(&key) {
                        before.insert(key.clone(), entries.get(&key).cloned().unwrap_or(Value::Null));
                    }
                    entries.shift_remove(&key);
                }
            }
        }
        ledger.insert("entries".into(), Value::Object(entries));
        ledger.insert("matches".into(), Value::Object(matches));
        let journal = journal_of(&mut ledger, author, before, obj(json!({"matches": matches_before})));
        store.write_ledger(&id, &ledger);
        store.append_history(&id, &lines);
        Ok((accepted, rejected, journal))
    })
}

/// A plan by id or name (case-insensitive): its index.
pub fn find_plan(plans: &[Value], name: &str) -> Option<usize> {
    let lower = js::trim(name).to_lowercase();
    plans
        .iter()
        .position(|p| s(p, &["id"]) == name)
        .or_else(|| {
            plans
                .iter()
                .position(|p| s(p, &["name"]).to_lowercase() == lower)
        })
}

/// A plan change (`PlanAction`), as the tools and the RPC give it.
pub type PlanAction = Value;

fn plan_id(now: f64) -> String {
    use rand::Rng;
    let mut rng = rand::rng();
    let tail: String = (0..4)
        .map(|_| std::char::from_digit(rng.random_range(0..36), 36).unwrap_or('0'))
        .collect();
    format!("p{}{tail}", base36(now as u64))
}

fn base36(mut n: u64) -> String {
    if n == 0 {
        return "0".into();
    }
    let mut digits = Vec::new();
    while n > 0 {
        digits.push(std::char::from_digit((n % 36) as u32, 36).unwrap_or('0'));
        n /= 36;
    }
    digits.into_iter().rev().collect()
}

/// Proposes, accepts, edits, splits or drops planned requests (D25), all
/// or nothing, journaled. `taken`: other efforts' planned commits by patch
/// id, to their effort's name. `(plan, journal)`.
pub fn change_plans(
    store: &LedgerStore,
    effort: &Effort,
    change: &PlanAction,
    author: &Author,
    taken: &HashMap<String, String>,
) -> Result<(Option<Value>, f64), String> {
    let id = s(effort, &["id"]).to_owned();
    store.queue(&id, || {
        let commits: Vec<Value> =
            store.derived(&id).and_then(|d| d.get("commits").and_then(Value::as_array).cloned()).unwrap_or_default();
        let mut ledger = store.ledger(&id);
        let before = ledger.get("plans").cloned().unwrap_or(json!([]));
        let mut plans: Vec<Value> = before.as_array().cloned().unwrap_or_default();
        let at = js::iso(author.now);
        let order: HashMap<String, usize> = commits.iter().enumerate().map(|(i, c)| (s(c, &["key"]).to_owned(), i)).collect();
        let sort = |keys: &mut Vec<String>| keys.sort_by_key(|k| order.get(k).copied().unwrap_or(0));
        let keys_of = |plans: &[Value], names: &[String], plan: Option<usize>| -> Result<Vec<String>, String> {
            let (found, unknown) = resolve_commits(&commits, names);
            if !unknown.is_empty() {
                return Err(format!(
                    "not in the ledger (or ambiguous): {}; nothing changed",
                    unknown.iter().take(20).cloned().collect::<Vec<_>>().join(", ")
                ));
            }
            let mut problems: Vec<String> = Vec::new();
            for commit in &found {
                let key = s(commit, &["key"]);
                let short = js::head16(s(commit, &["sha"]), 10);
                if let Some(other) = plans
                    .iter()
                    .enumerate()
                    .find(|(i, p)| Some(*i) != plan && strings(p.get("commits")).iter().any(|k| k == key))
                {
                    problems.push(format!("{short} is in {}", s(other.1, &["name"])));
                }
                if let Some(elsewhere) = taken.get(s(commit, &["patchId"])) {
                    problems.push(format!("{short} is in a part of {elsewhere}"));
                }
                if s(commit, &["disposition"]) == "upstream" {
                    problems.push(format!("{short} is upstream"));
                }
            }
            if !problems.is_empty() {
                return Err(format!(
                    "a commit is in one planned request only: {}; nothing changed",
                    problems.iter().take(10).cloned().collect::<Vec<_>>().join("; ")
                ));
            }
            let mut keys: Vec<String> = Vec::new();
            for commit in &found {
                let key = s(commit, &["key"]).to_owned();
                if !keys.contains(&key) {
                    keys.push(key);
                }
            }
            sort(&mut keys);
            Ok(keys)
        };
        let named = |plans: &[Value], name: &str| find_plan(plans, name).ok_or_else(|| format!("no planned request \"{name}\""));
        let depends = |plans: &[Value], names: Option<Vec<String>>, me: Option<usize>| -> Result<Vec<Value>, String> {
            names
                .unwrap_or_default()
                .iter()
                .map(|name| {
                    let at = named(plans, name)?;
                    if Some(at) == me {
                        return Err("a plan cannot come after itself".to_owned());
                    }
                    Ok(plans[at]["id"].clone())
                })
                .collect()
        };
        let fresh = |plans: &[Value], name: &str| -> Result<String, String> {
            let clean = js::head16(js::trim(name), 120);
            if clean.is_empty() {
                return Err("a planned request needs a name".into());
            }
            if find_plan(plans, &clean).is_some() {
                return Err(format!("there is already a planned request \"{clean}\""));
            }
            Ok(clean)
        };
        let text = |name: &str| js::sv(change.get(name)).to_owned();
        let list = |name: &str| change.get(name).filter(|v| v.is_array()).map(|v| strings(Some(v)));
        let plan: Option<Value> = match js::sv(change.get("action")) {
            "propose" => {
                if plans.len() >= PLAN_MAX {
                    return Err(format!("At most {PLAN_MAX} planned requests an effort."));
                }
                let name = fresh(&plans, &text("name"))?;
                let keys = keys_of(&plans, &list("commits").unwrap_or_default(), None)?;
                let depends_on = depends(&plans, list("dependsOn"), None)?;
                let state = if js::is_true(change.get("accepted")) && author.by == "user" { "accepted" } else { "proposed" };
                let plan = json!({"id": plan_id(js::now_ms()), "name": name, "commits": keys, "dependsOn": depends_on,
                    "state": state, "at": at, "by": author.by});
                if keys_empty(&plan) {
                    return Err("no commit given".into());
                }
                plans.push(plan.clone());
                Some(plan)
            }
            "accept" => {
                let at_index = named(&plans, &text("plan"))?;
                plans[at_index]["state"] = json!("accepted");
                plans[at_index]["at"] = json!(at);
                Some(plans[at_index].clone())
            }
            "edit" => {
                let index = named(&plans, &text("plan"))?;
                let new_name = text("name");
                if !new_name.is_empty() && js::trim(&new_name) != s(&plans[index], &["name"]) {
                    let name = fresh(&plans, &new_name)?;
                    plans[index]["name"] = json!(name);
                }
                let mut keys = match list("commits") {
                    Some(names) => keys_of(&plans, &names, Some(index))?,
                    None => strings(plans[index].get("commits")),
                };
                if let Some(add) = list("add").filter(|a| !a.is_empty()) {
                    for key in keys_of(&plans, &add, Some(index))? {
                        if !keys.contains(&key) {
                            keys.push(key);
                        }
                    }
                }
                if let Some(remove) = list("remove").filter(|r| !r.is_empty()) {
                    let (found, _) = resolve_commits(&commits, &remove);
                    let drop: HashSet<String> = found.iter().map(|c| s(c, &["key"]).to_owned()).collect();
                    keys.retain(|k| !drop.contains(k));
                }
                sort(&mut keys);
                plans[index]["commits"] = json!(keys);
                if list("dependsOn").is_some() {
                    let d = depends(&plans, list("dependsOn"), Some(index))?;
                    plans[index]["dependsOn"] = Value::Array(d);
                }
                plans[index]["at"] = json!(at);
                Some(plans[index].clone())
            }
            "split" => {
                let from = named(&plans, &text("plan"))?;
                let (found, unknown) = resolve_commits(&commits, &list("commits").unwrap_or_default());
                if !unknown.is_empty() {
                    return Err(format!("not in the ledger: {}", unknown.iter().take(20).cloned().collect::<Vec<_>>().join(", ")));
                }
                let mut moved: Vec<String> = Vec::new();
                for c in &found {
                    let key = s(c, &["key"]).to_owned();
                    if !moved.contains(&key) {
                        moved.push(key);
                    }
                }
                let from_commits = strings(plans[from].get("commits"));
                if moved.iter().any(|k| !from_commits.contains(k)) {
                    return Err(format!("a commit to split off is not in {}", s(&plans[from], &["name"])));
                }
                if moved.len() == from_commits.len() {
                    return Err("a split leaves some commits in the plan".into());
                }
                let name = fresh(&plans, &text("name"))?;
                plans[from]["commits"] = json!(from_commits.into_iter().filter(|k| !moved.contains(k)).collect::<Vec<_>>());
                sort(&mut moved);
                let plan = json!({"id": plan_id(js::now_ms()), "name": name, "commits": moved,
                    "dependsOn": plans[from]["dependsOn"].clone(), "state": plans[from]["state"].clone(), "at": at, "by": author.by});
                plans.push(plan.clone());
                Some(plan)
            }
            "drop" => {
                let gone = named(&plans, &text("plan"))?;
                let plan = plans.remove(gone);
                let gone_id = plan["id"].clone();
                for each in &mut plans {
                    let kept: Vec<Value> =
                        each["dependsOn"].as_array().cloned().unwrap_or_default().into_iter().filter(|d| *d != gone_id).collect();
                    each["dependsOn"] = Value::Array(kept);
                }
                Some(plan)
            }
            "part" => {
                let index = named(&plans, &text("plan"))?;
                plans[index]["part"] = change.get("part").cloned().unwrap_or(Value::Null);
                Some(plans[index].clone())
            }
            other => return Err(format!("unknown plan action {other}")),
        };
        ledger.insert("plans".into(), Value::Array(plans));
        let journal = journal_of(&mut ledger, author, Obj::new(), obj(json!({"plans": before})));
        store.write_ledger(&id, &ledger);
        Ok((plan, journal))
    })
}

fn keys_empty(plan: &Value) -> bool {
    plan["commits"].as_array().is_none_or(Vec::is_empty)
}

fn merged_plans(derived: &Obj, ledger: &Obj) -> Vec<String> {
    let state: HashMap<String, String> = derived
        .get("commits")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .map(|c| (s(c, &["key"]).to_owned(), s(c, &["disposition"]).to_owned()))
        .collect();
    ledger
        .get("plans")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|p| {
            let keys = strings(p.get("commits"));
            !keys.is_empty()
                && keys
                    .iter()
                    .all(|k| state.get(k).map(String::as_str) == Some("upstream"))
        })
        .map(|p| s(p, &["id"]).to_owned())
        .collect()
}

/// What the user saw of an effort, to tell what changed since.
pub fn snapshot_of(derived: &Obj, ledger: &Obj, now: f64) -> Obj {
    let commits: Vec<Value> = derived
        .get("commits")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let mut dispositions = Obj::new();
    for c in &commits {
        dispositions.insert(s(c, &["key"]).into(), c["disposition"].clone());
    }
    let mut not_ready = Obj::new();
    for f in derived
        .get("feeders")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        not_ready.insert(s(f, &["ref"]).into(), f["notReady"].clone());
    }
    obj(json!({
        "at": js::iso(now),
        "dispositions": dispositions,
        "notReady": not_ready,
        "upstreamAnyway": commits.iter().filter(|c| js::is_true(c.get("upstreamAnyway"))).map(|c| c["key"].clone()).collect::<Vec<_>>(),
        "merged": merged_plans(derived, ledger),
    }))
}

/// What changed since the snapshot (`MrEffortChanges`).
pub fn changes_of(derived: Option<&Obj>, ledger: &Obj, seen: Option<&Obj>) -> Obj {
    let mut unsorted = Vec::new();
    let mut landed = Vec::new();
    let mut in_review = Vec::new();
    let mut feeders = Vec::new();
    let mut parts_merged = Vec::new();
    let mut proposals = Vec::new();
    let mut anyway_new = Vec::new();
    let finish =
        |unsorted, landed, in_review, feeders, parts_merged, proposals, anyway: Vec<Value>| {
            obj(json!({
                "since": seen.and_then(|s| s.get("at")).cloned().unwrap_or(Value::Null),
                "unsorted": unsorted, "landed": landed, "inReview": in_review, "feeders": feeders,
                "partsMerged": parts_merged, "proposals": proposals, "upstreamAnyway": anyway,
            }))
        };
    let Some(derived) = derived else {
        return finish(
            unsorted,
            landed,
            in_review,
            feeders,
            parts_merged,
            proposals,
            anyway_new,
        );
    };
    let matches = ledger.get("matches").and_then(Value::as_object);
    let decided = |key: &str| {
        matches
            .and_then(|m| m.get(key))
            .and_then(|m| m.get("accepted"))
            .is_some_and(|a| a.as_str().is_some_and(|s| !s.is_empty()))
    };
    for key in derived
        .get("proposals")
        .and_then(Value::as_object)
        .into_iter()
        .flatten()
        .map(|(k, _)| k)
    {
        if !decided(key) {
            proposals.push(json!(key));
        }
    }
    let Some(seen) = seen else {
        return finish(
            unsorted,
            landed,
            in_review,
            feeders,
            parts_merged,
            proposals,
            anyway_new,
        );
    };
    let commits: Vec<Value> = derived
        .get("commits")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    for commit in &commits {
        let key = s(commit, &["key"]);
        let was = seen.get("dispositions").and_then(|d| d.get(key));
        let now = &commit["disposition"];
        if was == Some(now) {
            continue;
        }
        match now.as_str() {
            Some("unsorted") => unsorted.push(json!(key)),
            Some("upstream") => landed.push(json!(key)),
            Some("in_review") => in_review.push(json!(key)),
            _ => {}
        }
    }
    for feeder in derived
        .get("feeders")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        let reference = s(feeder, &["ref"]);
        let now = feeder
            .get("notReady")
            .and_then(Value::as_f64)
            .unwrap_or(0.0);
        if let Some(before) = seen
            .get("notReady")
            .and_then(|n| n.get(reference))
            .and_then(Value::as_f64)
            && now < before
        {
            feeders.push(json!({"ref": reference, "landed": js::number(before - now)}));
        }
    }
    let merged = strings(seen.get("merged"));
    let plans = ledger
        .get("plans")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    for id in merged_plans(derived, ledger)
        .into_iter()
        .filter(|id| !merged.contains(id))
    {
        let name = plans
            .iter()
            .find(|p| s(p, &["id"]) == id)
            .map_or(id.clone(), |p| s(p, &["name"]).to_owned());
        parts_merged.push(json!(name));
    }
    let anyway = strings(seen.get("upstreamAnyway"));
    for commit in &commits {
        if js::is_true(commit.get("upstreamAnyway"))
            && !anyway.iter().any(|k| k == s(commit, &["key"]))
        {
            anyway_new.push(commit["key"].clone());
        }
    }
    finish(
        unsorted,
        landed,
        in_review,
        feeders,
        parts_merged,
        proposals,
        anyway_new,
    )
}

#[cfg(test)]
mod tests;
