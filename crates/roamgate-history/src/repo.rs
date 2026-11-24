//! The history repo (history/repo.ts): a git repository of plain files
//! (`<data>/history/` by default), written by passes. A pass writes the
//! areas it is given (only the files whose content changed), removes the
//! files they no longer have, scans what is staged for secrets (a hit keeps
//! that file out of the commit, named in the status) and commits as
//! Roamgate. Work changes come first, one commit each, authored by whoever
//! made them at the time they made them. One pass at a time, across
//! processes too (a lock directory in `.git`, the one Bun takes): the
//! server and `roamgate history commit` never write together.
//!
//! Everything here blocks (files and git): the runtime runs it on a
//! blocking thread. Files are written without fsync (a temporary file,
//! then a rename), as Bun writes them.

use std::collections::HashSet;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use regex::Regex;
use roamgate_agents::js;
use roamgate_base::paths::random_uuid;
use roamgate_base::secrets::scan_diff;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::area::HistoryArea;
use crate::git::{GitRun, GitRunner, git_any, git_ok, git_runner};

pub const HISTORY_FORMAT: i64 = 1;
/// A lock older than this was left by a process that died.
const STALE_LOCK_MS: i64 = 10 * 60_000;
const STATUS_FILE: &str = "roamgate-status.json";
const LOCK_DIR: &str = "roamgate-pass.lock";

const README: &str = "# Roamgate history

This repository is written by Roamgate: what you and your agents authored in
it (the Work board, reviews and their comments, settings without secrets,
connections, the Reviews' state, companion memories, voice settings), as
plain files, committed as it changes. Roamgate keeps it up to date; do not
edit it by hand, your changes would be overwritten by the next pass.

- `work/`: the Work board, one Markdown file per item (`git log -p --
  work/items/<id>.md` is its history, each change authored by who made it).
- `reviews/<year>/<review>/`: a review's `review.json` and one Markdown
  file per thread; `reviews/images/` the pasted screenshots.
- `settings/`: one file per top-level key of settings.json.
- `mr-reviews/`, `companion/`, `voice/` and the top-level JSON files:
  the other areas.

Prose files carry what is not text in one-line JSON headers inside HTML
comments (`<!-- roamgate:... {...} -->`), invisible when rendered.
`FORMAT` is the layout's version. See Roamgate's docs/ARCHITECTURE.md,
\"History\".
";

/// A commit's author.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GitAuthor {
    pub name: String,
    pub email: String,
}

/// One Work change's commit.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkCommit {
    /// The item's file in the repo.
    pub path: String,
    /// Its content after the change; None: the item was removed.
    pub content: Option<String>,
    pub author: GitAuthor,
    /// When the change was made (ISO 8601).
    pub date: String,
    pub subject: String,
    pub body: Option<String>,
}

/// A secret found in a file: the file stays out of the commit.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct HistoryBlocked {
    pub file: String,
    pub line: u64,
    /// What was found, never the secret itself ("glpat-... token").
    pub kind: String,
}

/// An area that could not be written, or a pass that failed.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct HistoryError {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub area: Option<String>,
    pub message: String,
    pub at: String,
}

/// The last pass: when, how long, how many commits.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LastPass {
    pub at: String,
    pub ms: i64,
    pub commits: u64,
}

/// An area with the ids changed (None: all of it).
pub type AreaIds = (Arc<dyn HistoryArea>, Option<Vec<String>>);

/// What a pass is given.
#[derive(Clone, Default)]
pub struct PassInput {
    /// Each area with the ids changed (None: all of it).
    pub areas: Vec<AreaIds>,
    pub work: Vec<WorkCommit>,
    /// Skip `git gc --auto` (a game runs).
    pub light: bool,
}

/// What a pass did.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub struct PassResult {
    /// Another process holds the lock: nothing was done.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub locked: bool,
    pub commits: u64,
    pub blocked: Vec<HistoryBlocked>,
    pub errors: Vec<HistoryError>,
    pub ms: i64,
}

/// The last commit, as the status shows it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct HistoryCommitInfo {
    pub sha: String,
    pub subject: String,
    /// Its author date (ISO 8601).
    pub at: String,
    pub author: String,
}

/// The repo's status (`RepoStatus`).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct RepoStatus {
    pub exists: bool,
    pub last_commit: Option<HistoryCommitInfo>,
    pub commits: u64,
    pub size_bytes: u64,
    /// Tracked files by area (top-level directory or file), in the order
    /// git lists them.
    pub files: Vec<(String, u64)>,
    pub last_pass: Option<LastPass>,
    pub blocked: Vec<HistoryBlocked>,
    pub errors: Vec<HistoryError>,
}

impl RepoStatus {
    /// Its fields as `HistoryStatus` has them, in Bun's key order.
    pub fn fields(&self) -> serde_json::Map<String, Value> {
        let mut files = serde_json::Map::new();
        for (top, n) in &self.files {
            files.insert(top.clone(), json!(n));
        }
        let value = json!({
            "exists": self.exists,
            "lastCommit": self.last_commit,
            "commits": self.commits,
            "sizeBytes": self.size_bytes,
            "files": roamgate_base::json_store::js_key_order(Value::Object(files)),
            "lastPass": self.last_pass,
            "blocked": self.blocked,
            "errors": self.errors,
        });
        value.as_object().cloned().unwrap_or_default()
    }
}

#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StatusFile {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    last_pass: Option<LastPass>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    blocked: Option<Vec<HistoryBlocked>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    errors: Option<Vec<HistoryError>>,
}

/// A directory and its parents, 0700 where modes exist.
fn create_private_dir(dir: &Path) -> std::io::Result<()> {
    let mut builder = std::fs::DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    std::os::unix::fs::DirBuilderExt::mode(&mut builder, 0o700);
    builder.create(dir)
}

/// A new file, 0600 where modes exist.
fn create_private_file(path: &Path) -> std::io::Result<std::fs::File> {
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
    options.open(path)
}

/// A repo path made safe: forward slashes, no `..`, nothing under `.git`.
fn checked_path(path: &str) -> Result<&str, String> {
    let parts: Vec<&str> = path.split('/').collect();
    if path.is_empty()
        || path.starts_with('/')
        || parts
            .iter()
            .any(|part| part.is_empty() || *part == "." || *part == "..")
        || parts[0] == ".git"
    {
        return Err(format!("bad history path {path}"));
    }
    Ok(path)
}

/// The clock a repo reads (epoch ms).
pub type Now = Arc<dyn Fn() -> i64 + Send + Sync>;

/// The history repo at a directory.
pub struct HistoryRepo {
    pub dir: PathBuf,
    pub host: String,
    git: GitRunner,
    identity: GitAuthor,
    now: Now,
}

impl HistoryRepo {
    /// The repo at `dir`, committing as `Roamgate <roamgate@host>` with a
    /// `Roamgate-Host: host` trailer; git at nice 19 when `low_priority`.
    pub fn new(dir: &Path, host: &str, low_priority: bool, now: Option<Now>) -> Self {
        Self::with_git(dir, host, git_runner(dir, None, low_priority), now)
    }

    pub fn with_git(dir: &Path, host: &str, git: GitRunner, now: Option<Now>) -> Self {
        static UNSAFE: std::sync::LazyLock<Regex> =
            std::sync::LazyLock::new(|| Regex::new(r"[^A-Za-z0-9.-]+").unwrap());
        let email_host = UNSAFE.replace_all(host, "-");
        Self {
            dir: dir.to_path_buf(),
            host: host.to_owned(),
            git,
            identity: GitAuthor {
                name: "Roamgate".into(),
                email: format!(
                    "roamgate@{}",
                    if email_host.is_empty() {
                        "host"
                    } else {
                        &email_host
                    }
                ),
            },
            now: now.unwrap_or_else(|| Arc::new(|| js::now_ms() as i64)),
        }
    }

    fn git_dir(&self) -> PathBuf {
        self.dir.join(".git")
    }

    fn trailer(&self) -> String {
        format!("Roamgate-Host: {}", self.host)
    }

    fn roamgate_env(&self) -> Vec<(String, String)> {
        vec![
            ("GIT_AUTHOR_NAME".into(), self.identity.name.clone()),
            ("GIT_AUTHOR_EMAIL".into(), self.identity.email.clone()),
            ("GIT_COMMITTER_NAME".into(), self.identity.name.clone()),
            ("GIT_COMMITTER_EMAIL".into(), self.identity.email.clone()),
        ]
    }

    fn at(&self) -> String {
        js::iso(self.now() as f64)
    }

    fn now(&self) -> i64 {
        (self.now)()
    }

    pub fn exists(&self) -> bool {
        std::fs::metadata(self.git_dir().join("HEAD")).is_ok_and(|info| info.is_file())
    }

    /// The repo there, made when missing (FORMAT and README.md committed).
    /// An error on a layout newer than this Roamgate.
    pub fn ensure(&self) -> Result<(), String> {
        create_private_dir(&self.dir).map_err(|error| error.to_string())?;
        if !self.exists() {
            git_ok(&self.git, &["init", "-q"], &GitRun::default())?;
        }
        // Number.parseInt: the leading digits.
        let format = std::fs::read_to_string(self.dir.join("FORMAT"))
            .ok()
            .map(|text| {
                let trimmed = js::trim_start(&text);
                let (sign, digits) = match trimmed.strip_prefix('-') {
                    Some(rest) => (-1, rest),
                    None => (1, trimmed.strip_prefix('+').unwrap_or(trimmed)),
                };
                let digits: String = digits.chars().take_while(char::is_ascii_digit).collect();
                digits.parse::<i64>().ok().map(|n| sign * n)
            });
        if let Some(Some(format)) = format
            && format > HISTORY_FORMAT
        {
            return Err(format!(
                "the history at {} has format {format}, newer than this Roamgate ({HISTORY_FORMAT})",
                self.dir.display()
            ));
        }
        let mut wrote = false;
        if format.is_none() {
            self.write("FORMAT", format!("{HISTORY_FORMAT}\n").as_bytes())?;
            wrote = true;
        }
        if std::fs::metadata(self.dir.join("README.md")).is_err() {
            self.write("README.md", README.as_bytes())?;
            wrote = true;
        }
        if wrote {
            git_ok(
                &self.git,
                &["add", "--", "FORMAT", "README.md"],
                &GitRun::default(),
            )?;
            if !self.staged(&[])?.is_empty() {
                self.commit("Start the Roamgate history", self.roamgate_env())?;
            }
        }
        Ok(())
    }

    fn full_path(&self, path: &str) -> Result<PathBuf, String> {
        let mut full = self.dir.clone();
        for part in checked_path(path)?.split('/') {
            full.push(part);
        }
        Ok(full)
    }

    /// Writes a file when its content differs; true when it did.
    fn write(&self, path: &str, content: &[u8]) -> Result<bool, String> {
        let full = self.full_path(path)?;
        if std::fs::read(&full).is_ok_and(|current| current == content) {
            return Ok(false);
        }
        let parent = full.parent().unwrap_or(&self.dir).to_path_buf();
        create_private_dir(&parent).map_err(|error| error.to_string())?;
        let temporary = parent.join(format!(".roamgate-{}.tmp", random_uuid()));
        let written = (|| -> std::io::Result<()> {
            let mut file = create_private_file(&temporary)?;
            file.write_all(content)?;
            drop(file);
            std::fs::rename(&temporary, &full)
        })();
        if let Err(error) = written {
            let _ = std::fs::remove_file(&temporary);
            return Err(error.to_string());
        }
        Ok(true)
    }

    fn remove(&self, path: &str) -> Result<(), String> {
        let full = self.full_path(path)?;
        match std::fs::remove_file(&full) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.to_string()),
        }
        // Empty directories left behind go too, up to the repo.
        let mut parent = full.parent().map(Path::to_path_buf);
        while let Some(dir) = parent {
            if dir == self.dir || !dir.starts_with(&self.dir) {
                break;
            }
            if std::fs::remove_dir(&dir).is_err() {
                break;
            }
            parent = dir.parent().map(Path::to_path_buf);
        }
        Ok(())
    }

    /// The files under an owned path, repo-relative; a `*` segment stands
    /// for any directory there.
    fn files_under(&self, owned: &str) -> Vec<String> {
        let parts: Vec<&str> = owned.split('/').collect();
        if let Some(star) = parts.iter().position(|part| *part == "*") {
            let mut base = self.dir.clone();
            for part in parts[..star].iter().filter(|part| !part.is_empty()) {
                base.push(part);
            }
            let names: Vec<String> = std::fs::read_dir(&base)
                .map(|read| {
                    read.flatten()
                        .filter(|entry| entry.file_type().is_ok_and(|kind| kind.is_dir()))
                        .map(|entry| entry.file_name().to_string_lossy().into_owned())
                        .filter(|name| name != ".git")
                        .collect()
                })
                .unwrap_or_default();
            let mut out = Vec::new();
            for name in names {
                let mut next: Vec<&str> = parts[..star].to_vec();
                next.push(&name);
                next.extend_from_slice(&parts[star + 1..]);
                out.extend(self.files_under(&next.join("/")));
            }
            return out;
        }
        let mut full = self.dir.clone();
        for part in owned.trim_end_matches('/').split('/') {
            full.push(part);
        }
        if !owned.ends_with('/') {
            return if std::fs::metadata(&full).is_ok_and(|info| info.is_file()) {
                vec![owned.to_owned()]
            } else {
                Vec::new()
            };
        }
        let mut out = Vec::new();
        self.walk(&full, &mut out);
        out
    }

    fn walk(&self, dir: &Path, out: &mut Vec<String>) {
        let Ok(read) = std::fs::read_dir(dir) else {
            return;
        };
        for entry in read.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            let path = entry.path();
            if entry.file_type().is_ok_and(|kind| kind.is_dir()) {
                if name != ".git" {
                    self.walk(&path, out);
                }
            } else if !name.starts_with(".roamgate-")
                && let Ok(relative) = path.strip_prefix(&self.dir)
            {
                out.push(
                    relative
                        .components()
                        .map(|part| part.as_os_str().to_string_lossy().into_owned())
                        .collect::<Vec<_>>()
                        .join("/"),
                );
            }
        }
    }

    fn staged(&self, paths: &[&str]) -> Result<Vec<String>, String> {
        let mut args = vec![
            "diff",
            "--cached",
            "--name-only",
            "-z",
            "--no-renames",
            "--",
        ];
        args.extend_from_slice(paths);
        let out = git_ok(&self.git, &args, &GitRun::default())?;
        Ok(out
            .split('\0')
            .filter(|path| !path.is_empty())
            .map(str::to_owned)
            .collect())
    }

    /// Secret hits in what is staged; their files unstaged.
    fn block_secrets(&self) -> Result<Vec<HistoryBlocked>, String> {
        let diff = git_ok(
            &self.git,
            &[
                "diff",
                "--cached",
                "-U0",
                "--no-color",
                "--no-ext-diff",
                "--no-renames",
                "--text",
            ],
            &GitRun::default(),
        )?;
        let hits = scan_diff(&diff);
        if hits.is_empty() {
            return Ok(Vec::new());
        }
        let mut seen = HashSet::new();
        let files: Vec<&str> = hits
            .iter()
            .map(|hit| hit.file.as_str())
            .filter(|file| seen.insert(*file))
            .collect();
        self.unstage(&files)?;
        Ok(hits
            .into_iter()
            .map(|hit| HistoryBlocked {
                file: hit.file,
                line: hit.line,
                kind: hit.kind,
            })
            .collect())
    }

    fn unstage(&self, files: &[&str]) -> Result<(), String> {
        if files.is_empty() {
            return Ok(());
        }
        let head = git_any(&self.git, &["rev-parse", "-q", "--verify", "HEAD"]);
        let mut args = if head.code == 0 {
            vec!["reset", "-q", "HEAD", "--"]
        } else {
            vec!["rm", "-q", "--cached", "--"]
        };
        args.extend_from_slice(files);
        git_ok(&self.git, &args, &GitRun::default()).map(|_| ())
    }

    fn commit(&self, message: &str, env: Vec<(String, String)>) -> Result<(), String> {
        git_ok(
            &self.git,
            &["commit", "-q", "--no-verify", "--no-gpg-sign", "-F", "-"],
            &GitRun {
                env,
                input: Some(format!("{}\n\n{}\n", js::trim(message), self.trailer())),
            },
        )
        .map(|_| ())
    }

    fn lock(&self) -> bool {
        let path = self.git_dir().join(LOCK_DIR);
        if std::fs::create_dir(&path).is_ok() {
            return true;
        }
        let modified = std::fs::metadata(&path)
            .and_then(|info| info.modified())
            .ok()
            .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|since| since.as_millis() as i64);
        if let Some(modified) = modified
            && self.now() - modified > STALE_LOCK_MS
        {
            let _ = std::fs::remove_dir_all(&path);
            return std::fs::create_dir(&path).is_ok();
        }
        false
    }

    fn unlock(&self) {
        let _ = std::fs::remove_dir_all(self.git_dir().join(LOCK_DIR));
    }

    /// One pass: the Work changes one commit each, then the areas in one.
    pub fn pass(&self, input: &PassInput) -> Result<PassResult, String> {
        let started = self.now();
        self.ensure()?;
        if !self.lock() {
            return Ok(PassResult {
                locked: true,
                ..PassResult::default()
            });
        }
        let mut errors: Vec<HistoryError> = Vec::new();
        let mut blocked: Vec<HistoryBlocked> = Vec::new();
        let mut commits = 0u64;
        let outcome = (|| -> Result<(), String> {
            for change in &input.work {
                let done = (|| -> Result<bool, String> {
                    match &change.content {
                        None => self.remove(&change.path)?,
                        Some(content) => {
                            self.write(&change.path, content.as_bytes())?;
                        }
                    }
                    let tracked = git_any(
                        &self.git,
                        &["ls-files", "--error-unmatch", "--", &change.path],
                    )
                    .code
                        == 0;
                    if change.content.is_none() && !tracked {
                        return Ok(false);
                    }
                    git_ok(
                        &self.git,
                        &["add", "-A", "--", &change.path],
                        &GitRun::default(),
                    )?;
                    if self.staged(&[&change.path])?.is_empty() {
                        return Ok(false);
                    }
                    blocked.extend(self.block_secrets()?);
                    if self.staged(&[])?.is_empty() {
                        return Ok(false);
                    }
                    let message = match &change.body {
                        Some(body) if !body.is_empty() => format!("{}\n\n{body}", change.subject),
                        _ => change.subject.clone(),
                    };
                    let mut env = self.roamgate_env();
                    env.push(("GIT_AUTHOR_NAME".into(), change.author.name.clone()));
                    env.push(("GIT_AUTHOR_EMAIL".into(), change.author.email.clone()));
                    env.push(("GIT_AUTHOR_DATE".into(), change.date.clone()));
                    self.commit(&message, env)?;
                    Ok(true)
                })();
                match done {
                    Ok(true) => commits += 1,
                    Ok(false) => {}
                    Err(message) => errors.push(HistoryError {
                        area: Some("work".into()),
                        message,
                        at: self.at(),
                    }),
                }
            }
            let mut owners: Vec<(String, Arc<dyn HistoryArea>)> = Vec::new();
            for (area, ids) in &input.areas {
                let written = (|| -> Result<(), String> {
                    let render = area.render(ids.as_deref())?;
                    for owned in &render.owns {
                        owners.push((owned.clone(), area.clone()));
                    }
                    for (path, content) in &render.files {
                        self.write(path, content)?;
                    }
                    for owned in &render.owns {
                        for path in self.files_under(owned) {
                            if !render.files.contains_key(&path) {
                                self.remove(&path)?;
                            }
                        }
                    }
                    Ok(())
                })();
                if let Err(message) = written {
                    errors.push(HistoryError {
                        area: Some(area.name().to_owned()),
                        message,
                        at: self.at(),
                    });
                }
            }
            git_ok(&self.git, &["add", "-A"], &GitRun::default())?;
            if !self.staged(&[])?.is_empty() {
                blocked.extend(self.block_secrets()?);
                let paths = self.staged(&[])?;
                if !paths.is_empty() {
                    self.commit(&message(&paths, &owners), self.roamgate_env())?;
                    commits += 1;
                }
            }
            if commits > 0 && !input.light {
                let _ = git_any(&self.git, &["gc", "--auto", "--quiet"]);
            }
            Ok(())
        })();
        if let Err(message) = outcome {
            errors.push(HistoryError {
                area: None,
                message,
                at: self.at(),
            });
        }
        let ms = self.now() - started;
        let blocked = dedupe(blocked);
        let _ = self.write_status(&StatusFile {
            last_pass: Some(LastPass {
                at: self.at(),
                ms,
                commits,
            }),
            blocked: Some(blocked.clone()),
            errors: Some(errors.clone()),
        });
        self.unlock();
        Ok(PassResult {
            locked: false,
            commits,
            blocked,
            errors,
            ms: self.now() - started,
        })
    }

    fn write_status(&self, file: &StatusFile) -> std::io::Result<()> {
        let path = self.git_dir().join(STATUS_FILE);
        let temporary = PathBuf::from(format!("{}.{}.tmp", path.display(), random_uuid()));
        let text = format!(
            "{}\n",
            js::stringify_pretty(&serde_json::to_value(file).unwrap_or(Value::Null))
        );
        let mut handle = create_private_file(&temporary)?;
        handle.write_all(text.as_bytes())?;
        drop(handle);
        std::fs::rename(&temporary, &path)
    }

    fn read_status(&self) -> StatusFile {
        std::fs::read_to_string(self.git_dir().join(STATUS_FILE))
            .ok()
            .and_then(|text| serde_json::from_str(&text).ok())
            .unwrap_or_default()
    }

    pub fn status(&self) -> RepoStatus {
        if !self.exists() {
            return RepoStatus::default();
        }
        let file = self.read_status();
        let log = git_any(&self.git, &["log", "-1", "--format=%H%x00%s%x00%aI%x00%an"]);
        let trimmed = js::trim(&log.stdout).to_owned();
        let mut fields = trimmed.split('\0');
        let sha = fields.next().unwrap_or("").to_owned();
        let subject = fields.next().unwrap_or("").to_owned();
        let date = fields.next().unwrap_or("").to_owned();
        let author = fields.next().unwrap_or("").to_owned();
        let count = git_any(&self.git, &["rev-list", "--count", "HEAD"]);
        let listed = git_any(&self.git, &["ls-files", "-z"]);
        let mut files: Vec<(String, u64)> = Vec::new();
        for path in listed.stdout.split('\0').filter(|path| !path.is_empty()) {
            let top = match path.find('/') {
                Some(at) => path[..at].to_owned(),
                None => path.strip_suffix(".json").unwrap_or(path).to_owned(),
            };
            match files.iter_mut().find(|(name, _)| *name == top) {
                Some((_, n)) => *n += 1,
                None => files.push((top, 1)),
            }
        }
        RepoStatus {
            exists: true,
            last_commit: (log.code == 0 && !sha.is_empty()).then_some(HistoryCommitInfo {
                sha,
                subject,
                at: date,
                author,
            }),
            commits: if count.code == 0 {
                js::trim(&count.stdout).parse().unwrap_or(0)
            } else {
                0
            },
            size_bytes: size_of(&self.dir),
            files,
            last_pass: file.last_pass,
            blocked: file.blocked.unwrap_or_default(),
            errors: file.errors.unwrap_or_default(),
        }
    }

    /// The git runner, for tests and the CLI's log.
    pub fn run(&self, args: &[&str]) -> crate::git::GitResult {
        git_any(&self.git, args)
    }
}

/// "work: 2 items; reviews: 3 threads in 2 reviews", then the paths.
fn message(paths: &[String], owners: &[(String, Arc<dyn HistoryArea>)]) -> String {
    type Owned = (Option<Arc<dyn HistoryArea>>, Vec<String>);
    let mut by_area: Vec<Owned> = Vec::new();
    for path in paths {
        let owner = owners
            .iter()
            .find(|(prefix, _)| owned_by(prefix, path))
            .map(|(_, area)| area.clone());
        let slot = by_area.iter_mut().find(|(area, _)| match (area, &owner) {
            (Some(a), Some(b)) => std::ptr::addr_eq(Arc::as_ptr(a), Arc::as_ptr(b)),
            (None, None) => true,
            _ => false,
        });
        match slot {
            Some((_, changed)) => changed.push(path.clone()),
            None => by_area.push((owner, vec![path.clone()])),
        }
    }
    let parts: Vec<String> = by_area
        .iter()
        .map(|(area, changed)| {
            let name = area.as_ref().map_or("history", |area| area.name());
            let what = area
                .as_ref()
                .and_then(|area| area.describe(changed))
                .filter(|what| !what.is_empty())
                .unwrap_or_else(|| {
                    format!(
                        "{} file{}",
                        changed.len(),
                        if changed.len() == 1 { "" } else { "s" }
                    )
                });
            format!("{name}: {what}")
        })
        .collect();
    let subject = parts.join("; ");
    let mut listed: Vec<String> = paths
        .iter()
        .take(40)
        .map(|path| format!("- {path}"))
        .collect();
    if paths.len() > 40 {
        listed.push(format!("- and {} more", paths.len() - 40));
    }
    let subject = if js::len16(&subject) > 200 {
        format!("{}...", js::head16(&subject, 197))
    } else {
        subject
    };
    format!("{subject}\n\n{}", listed.join("\n"))
}

/// Whether a path is under an owned path (`*`: any one directory).
pub fn owned_by(owned: &str, path: &str) -> bool {
    let body = owned
        .split('*')
        .map(regex::escape)
        .collect::<Vec<_>>()
        .join("[^/]+");
    let pattern = format!("^{body}{}", if owned.ends_with('/') { "" } else { "$" });
    Regex::new(&pattern).is_ok_and(|pattern| pattern.is_match(path))
}

fn dedupe(hits: Vec<HistoryBlocked>) -> Vec<HistoryBlocked> {
    let mut seen = HashSet::new();
    hits.into_iter()
        .filter(|hit| seen.insert(format!("{}:{}", hit.file, hit.line)))
        .collect()
}

/// Bytes used by a directory tree (the repo with its .git).
pub fn size_of(dir: &Path) -> u64 {
    let Ok(read) = std::fs::read_dir(dir) else {
        return 0;
    };
    let mut total = 0;
    for entry in read.flatten() {
        let Ok(kind) = entry.file_type() else {
            continue;
        };
        if kind.is_dir() {
            total += size_of(&entry.path());
        } else if kind.is_file() {
            total += entry.metadata().map_or(0, |info| info.len());
        }
    }
    total
}

#[cfg(test)]
mod tests;
