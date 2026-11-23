//! Files' search (workspace/search.ts): names by `git ls-files`, content
//! by `git grep` (tracked, then untracked but not ignored), read as they
//! come and cut at the hundredth result.

use std::sync::Arc;
use std::time::{Duration, Instant};

use roamgate_git::{GitContext, Invocation, shell_quote};
use serde::Serialize;

use crate::connection::WorkspaceError;
use crate::process::{StreamProcess, StreamedProcess};

const RESULT_LIMIT: usize = 100;
const SEARCH_TIMEOUT: Duration = Duration::from_millis(15_000);
const SNIPPET_LIMIT: usize = 240;

/// `FileSearchResult`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct FileSearchResult {
    pub path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub line: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub snippet: Option<String>,
}

/// The search's answer.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct FileSearch {
    pub results: Vec<FileSearchResult>,
    pub truncated: bool,
}

/// `files` or `content`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SearchMode {
    Files,
    Content,
}

fn commands(mode: SearchMode, query: &str) -> Vec<Vec<String>> {
    let words = |list: &[&str]| list.iter().map(|w| (*w).to_owned()).collect::<Vec<_>>();
    match mode {
        SearchMode::Files => vec![words(&[
            "ls-files",
            "--cached",
            "--others",
            "--exclude-standard",
            "-z",
        ])],
        SearchMode::Content => vec![
            words(&[
                "grep",
                "--no-color",
                "--no-column",
                "-n",
                "-z",
                "-I",
                "-i",
                "-F",
                "-e",
                query,
                "--",
                ".",
            ]),
            words(&[
                "grep",
                "--no-color",
                "--no-column",
                "-n",
                "-z",
                "-I",
                "--untracked",
                "--exclude-standard",
                "-i",
                "-F",
                "-e",
                query,
                "--",
                ".",
            ]),
        ],
    }
}

/// `text.slice(0, n)` in UTF-16 units.
fn take_units(text: &str, units: usize) -> &str {
    let mut count = 0;
    for (at, c) in text.char_indices() {
        if count + c.len_utf16() > units {
            return &text[..at];
        }
        count += c.len_utf16();
    }
    text
}

fn units(text: &str) -> usize {
    text.encode_utf16().count()
}

/// Reads one command's output into `results`; true once cut.
struct Parser<'a> {
    mode: SearchMode,
    needle: String,
    show_hidden: bool,
    results: &'a mut Vec<FileSearchResult>,
    seen: &'a mut std::collections::BTreeSet<String>,
    pending: Vec<u8>,
    path: String,
    path_visible: bool,
    line: String,
    snippet: String,
    field: u8,
}

impl Parser<'_> {
    fn push_snippet(&mut self, piece: &str) {
        let room = SNIPPET_LIMIT.saturating_sub(units(&self.snippet));
        self.snippet.push_str(take_units(piece, room));
    }

    /// Takes a chunk; Ok(true) when the results are cut.
    fn feed(&mut self, chunk: &[u8]) -> Result<bool, WorkspaceError> {
        self.pending.extend_from_slice(chunk);
        while !self.pending.is_empty() {
            let delimiter = if self.field == 2 { b'\n' } else { 0 };
            let Some(end) = self.pending.iter().position(|b| *b == delimiter) else {
                if self.field == 2 {
                    let piece = String::from_utf8_lossy(&self.pending).into_owned();
                    self.push_snippet(&piece);
                    self.pending.clear();
                } else if self.pending.len() > 4096 {
                    return Err(WorkspaceError::new("search result path is too long"));
                }
                break;
            };
            let value = String::from_utf8_lossy(&self.pending[..end]).into_owned();
            self.pending.drain(..=end);
            match self.field {
                0 => {
                    self.path = value.strip_prefix("./").unwrap_or(&value).to_owned();
                    self.path_visible =
                        self.show_hidden || !self.path.split('/').any(|part| part.starts_with('.'));
                    if self.mode == SearchMode::Content {
                        self.field = 1;
                        continue;
                    }
                    if self.path.to_lowercase().contains(&self.needle)
                        && self.path_visible
                        && self.seen.insert(self.path.clone())
                    {
                        self.results.push(FileSearchResult {
                            path: self.path.clone(),
                            line: None,
                            snippet: None,
                        });
                    }
                }
                1 => {
                    self.line = value;
                    self.field = 2;
                    continue;
                }
                _ => {
                    self.push_snippet(&value);
                    let key = format!("{}\0{}", self.path, self.line);
                    if self.path_visible && self.seen.insert(key) {
                        self.results.push(FileSearchResult {
                            path: self.path.clone(),
                            line: Some(
                                roamgate_git::compare::js_number(&self.line).unwrap_or(0.0) as u64
                            ),
                            snippet: Some(self.snippet.trim().to_owned()),
                        });
                    }
                    self.snippet.clear();
                }
            }
            self.field = 0;
            if self.results.len() > RESULT_LIMIT {
                return Ok(true);
            }
        }
        Ok(false)
    }
}

/// `searchWorkspaceFiles` in `root` on the connection's host: through
/// `streams` (this machine's, or an SSH host's long-lived session), else
/// over SSH through the runner, whole.
pub async fn search_workspace_files(
    cx: &GitContext,
    streams: Option<&Arc<dyn StreamProcess>>,
    root: &str,
    query: &str,
    mode: SearchMode,
    show_hidden: bool,
) -> Result<FileSearch, WorkspaceError> {
    let mut results = Vec::new();
    let mut seen = std::collections::BTreeSet::new();
    let mut truncated = false;
    let deadline = Instant::now() + SEARCH_TIMEOUT;
    for args in commands(mode, query) {
        let invocation = match cx.host() {
            Some(host) => Invocation::ssh_read(
                host,
                &format!(
                    "git -C {} {}",
                    shell_quote(root),
                    args.iter()
                        .map(|a| shell_quote(a))
                        .collect::<Vec<_>>()
                        .join(" ")
                ),
                Some("file.search"),
            ),
            None => {
                let mut argv = vec!["git".to_owned(), "-C".to_owned(), root.to_owned()];
                argv.extend(args);
                Invocation::Local(argv)
            }
        };
        let mut parser = Parser {
            mode,
            needle: query.to_lowercase(),
            show_hidden,
            results: &mut results,
            seen: &mut seen,
            pending: Vec::new(),
            path: String::new(),
            path_visible: true,
            line: String::new(),
            snippet: String::new(),
            field: 0,
        };
        let remaining = deadline.saturating_duration_since(Instant::now());
        let local_streams: Arc<dyn StreamProcess> = Arc::new(crate::process::LocalStreams);
        let streams = match (&invocation, streams) {
            (Invocation::Local(_), _) => Some(&local_streams),
            (_, streams) => streams,
        };
        let cut = match streams {
            Some(streams) => {
                let proc = streams
                    .spawn(invocation)
                    .await
                    .map_err(WorkspaceError::new)?;
                read_stream(proc, &mut parser, mode, remaining).await?
            }
            None => {
                let ran = cx.run(invocation, remaining).await.map_err(|error| {
                    if error.0.contains("timed out") {
                        WorkspaceError::new("File search timed out")
                    } else {
                        WorkspaceError::new(error.0)
                    }
                })?;
                let cut = parser.feed(ran.stdout.as_bytes())?;
                if !cut && ran.code != 0 && !(mode == SearchMode::Content && ran.code == 1) {
                    return Err(failed(&ran.stderr));
                }
                cut
            }
        };
        if cut {
            truncated = true;
            break;
        }
    }
    results.truncate(RESULT_LIMIT);
    Ok(FileSearch { results, truncated })
}

fn failed(stderr: &str) -> WorkspaceError {
    let text = roamgate_git::trim_slice(stderr, 1000);
    WorkspaceError::new(if text.is_empty() {
        "File search failed".to_owned()
    } else {
        text
    })
}

async fn read_stream(
    mut proc: StreamedProcess,
    parser: &mut Parser<'_>,
    mode: SearchMode,
    remaining: Duration,
) -> Result<bool, WorkspaceError> {
    let timer = tokio::time::sleep(remaining);
    tokio::pin!(timer);
    let mut timed_out = false;
    let mut cut = false;
    loop {
        tokio::select! {
            chunk = proc.stdout.recv() => match chunk {
                Some(Ok(chunk)) => {
                    if parser.feed(&chunk)? {
                        cut = true;
                        proc.kill();
                        break;
                    }
                }
                Some(Err(error)) => return Err(WorkspaceError::new(error)),
                None => break,
            },
            () = &mut timer, if !timed_out => {
                timed_out = true;
                proc.kill();
            }
        }
    }
    let code = proc.exited.clone().await;
    let stderr = proc.stderr.clone().await;
    if timed_out {
        return Err(WorkspaceError::new("File search timed out"));
    }
    if !cut && code != 0 && !(mode == SearchMode::Content && code == 1) {
        return Err(failed(&stderr));
    }
    Ok(cut)
}

#[cfg(test)]
mod tests;
