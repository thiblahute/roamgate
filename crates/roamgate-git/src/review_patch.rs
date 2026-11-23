//! The review's read scripts (workspace/review-patch.ts): one shell
//! script per read, so a remote host costs one command on the
//! connection's SSH master; the patch of a range, a step or the working
//! tree, a review's state, its root and default base, the repositories a
//! session changed, a file, heads, commits and patch ids.

use std::collections::BTreeMap;
use std::sync::LazyLock;
use std::time::Duration;

use regex::Regex;
use serde::{Deserialize, Serialize};

use crate::diff_base::{read_invocation, resolve_default_base, short_ref_name};
use crate::exec::{GitContext, Invocation};
use crate::patch::{DiffFile, parse_unified_diff};
use crate::review::{GoneCode, ReviewCommit, ReviewDiff, Target, is_host_path};
use crate::{GitError, Result, shell_quote, trim_slice};

pub const REVIEW_PATCH_MAX_BYTES: usize = 4 * 1024 * 1024;
const REVIEW_PATCH_TIMEOUT: Duration = Duration::from_millis(30_000);
const MAX_UNTRACKED_FILES: usize = 200;
pub const SHAS_MARKER: &str = "ROAMGATE-REVIEW-SHAS";
/// git with the user's settings that change how a diff reads pinned:
/// real UTF-8 names, `a/` and `b/` prefixes, blank context lines kept.
pub const GIT: &str = "git -c core.quotePath=false -c diff.noprefix=false -c diff.mnemonicPrefix=false -c diff.suppressBlankEmpty=false";
/// Diff options that keep the output a plain patch of the files.
pub const DIFF_OPTIONS: &str =
    "--no-color --no-ext-diff --no-textconv --src-prefix=a/ --dst-prefix=b/";
const NO_CHECKOUT_MARKER: &str = "ROAMGATE-REVIEW-NO-CHECKOUT";
/// One file's patch read to place a thread: the 4 MiB cap is the whole
/// patch's.
pub const REVIEW_FILE_PATCH_MAX_BYTES: usize = 16 * 1024 * 1024;
pub const REVIEW_FILE_MAX_BYTES: usize = 2 * 1024 * 1024;
pub const REVIEW_MAX_COMMITS: usize = 500;
const HISTORY_MARKER: &str = "history";
const COMMIT_FIELD: char = '\x1f';
const COMMIT_END: char = '\x1e';
const HEAD_MARKER: &str = "ROAMGATE-REVIEW-HEAD-";
/// How much of an agent's session record is read: its latest work.
const REVIEW_AGENT_RECORD_BYTES: usize = 8 * 1024 * 1024;
/// Neighbours untouched for longer are not this session's work.
const REVIEW_REPO_RECENT_S: f64 = 3.0 * 24.0 * 3600.0;
const REVIEW_REPO_LIMIT: usize = 40;

/// The first line of a review script: into the checkout, or say it is
/// gone.
pub fn enter_checkout(root: &str) -> String {
    format!(
        "cd {} 2>/dev/null || {{ echo {NO_CHECKOUT_MARKER} >&2; exit 2; }}",
        shell_quote(root)
    )
}

/// How a review script is run and its failure told.
pub struct ScriptHow<'a> {
    pub tag: &'a str,
    pub timeout: Duration,
    pub label: &'a str,
    pub target: Option<&'a Target>,
    pub max: Option<usize>,
}

/// Runs a read-only review script in its checkout: over SSH on a remote
/// host (`tag` names it there), else in a plain shell.
pub async fn run_review_script(
    cx: &GitContext,
    root: &str,
    script: &str,
    how: ScriptHow<'_>,
) -> Result<String> {
    let invocation = read_invocation(cx, script, how.tag)?;
    let ran = cx.run(invocation, how.timeout).await?;
    if ran.code != 0 {
        return Err(review_script_error(
            &ran.stderr,
            how.label,
            root,
            how.target,
            how.max,
        ));
    }
    Ok(ran.stdout)
}

static UNKNOWN: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"unknown revision: (\S+)").unwrap());

fn strip_shell_specials(text: &str) -> String {
    text.chars()
        .filter(|c| !matches!(c, '"' | '$' | '`' | '\\'))
        .collect()
}

/// A review script's failure, as a gone review when that is what it is.
pub fn review_script_error(
    stderr: &str,
    fallback: &str,
    root: &str,
    target: Option<&Target>,
    max: Option<usize>,
) -> GitError {
    if stderr.contains(NO_CHECKOUT_MARKER) {
        return GitError::Gone {
            code: GoneCode::CheckoutGone,
            message: format!("This checkout no longer exists: {root}"),
        };
    }
    let unknown = UNKNOWN.captures(stderr).map(|c| c[1].to_owned());
    match (unknown, target) {
        (Some(rev), Some(Target::Step { before, .. })) => {
            let base = rev == *before;
            GitError::Gone {
                code: if base {
                    GoneCode::BaseGone
                } else {
                    GoneCode::HeadGone
                },
                message: format!(
                    "This step's snapshot is gone from this checkout ({} it)",
                    if base { "before" } else { "after" }
                ),
            }
        }
        (Some(rev), Some(Target::Range { base, .. })) => {
            let is_base = rev == strip_shell_specials(base);
            GitError::Gone {
                code: if is_base {
                    GoneCode::BaseGone
                } else {
                    GoneCode::HeadGone
                },
                message: format!(
                    "The review's {} {rev} is gone from this checkout",
                    if is_base { "base" } else { "head" }
                ),
            }
        }
        _ => {
            let text = if stderr.is_empty() { fallback } else { stderr };
            GitError::Message(trim_slice(text, max.unwrap_or(500)))
        }
    }
}

/// A review's base into `$b`: a commit, or a tree (git's empty tree); a
/// root commit's parent (`SHA^`, `SHA~1`, `SHA~`) is the empty tree.
pub fn resolve_base(base: &str) -> String {
    format!("b=$({}) || {}", base_revision(base), unknown_revision(base))
}

/// A script's exit on a revision it cannot find, naming it.
pub fn unknown_revision(name: &str) -> String {
    format!(
        "{{ echo \"unknown revision: {}\" >&2; exit 3; }}",
        strip_shell_specials(name)
    )
}

/// A review's head commit into `$h`.
pub fn resolve_head(head: &str) -> String {
    format!(
        "h=$(git rev-parse --verify --quiet {}) || {}",
        shell_quote(&format!("{head}^{{commit}}")),
        unknown_revision(head)
    )
}

/// Fails the script unless `tree` (a step's snapshot) is there.
pub fn check_tree(tree: &str) -> String {
    format!(
        "git rev-parse --verify --quiet {} >/dev/null || {}",
        shell_quote(&format!("{tree}^{{tree}}")),
        unknown_revision(tree)
    )
}

static PARENT: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^(.+?)(?:\^|~1?)$").unwrap());

fn base_revision(base: &str) -> String {
    let root = PARENT
        .captures(base)
        .map(|c| {
            format!(
                " || {{ c=$(git rev-parse --verify --quiet {}) && ! git rev-parse --verify --quiet \"$c^1\" >/dev/null && git hash-object -t tree /dev/null; }}",
                shell_quote(&format!("{}^{{commit}}", &c[1]))
            )
        })
        .unwrap_or_default();
    format!(
        "git rev-parse --verify --quiet {} 2>/dev/null || git rev-parse --verify --quiet {}{root}",
        shell_quote(&format!("{base}^{{commit}}")),
        shell_quote(&format!("{base}^{{tree}}"))
    )
}

/// One script per review diff: the resolved commits on its first line,
/// then the patch, cut at the size limit.
pub fn review_patch_script(
    root: &str,
    target: &Target,
    max_bytes: usize,
    paths: Option<&[String]>,
) -> Result<String> {
    let paths = paths.filter(|paths| !paths.is_empty());
    let only = paths
        .map(|paths| {
            format!(
                " -- {}",
                paths
                    .iter()
                    .map(|p| shell_quote(p))
                    .collect::<Vec<_>>()
                    .join(" ")
            )
        })
        .unwrap_or_default();
    let literal = if only.is_empty() {
        ""
    } else {
        "--literal-pathspecs "
    };
    let diff = format!("{GIT} {literal}diff {DIFF_OPTIONS} --find-renames");
    let cap = format!("head -c {}", max_bytes + 1);
    let mut lines = vec![enter_checkout(root)];
    match target {
        Target::Range {
            base,
            head,
            compare,
        } => {
            lines.push(resolve_base(base));
            lines.push(resolve_head(head));
            lines.push(if *compare {
                "m=\"$b\"".to_owned()
            } else {
                "m=$(git merge-base \"$b\" \"$h\" 2>/dev/null) || m=\"$b\"".to_owned()
            });
            lines.push(format!(
                "{{ printf '{SHAS_MARKER} %s %s\\n' \"$m\" \"$h\"; {diff} \"$m\" \"$h\"{only}; }} | {cap}"
            ));
        }
        Target::Step { before, after, .. } => {
            lines.push(check_tree(before));
            lines.push(check_tree(after));
            lines.push(format!(
                "{{ printf '{SHAS_MARKER} %s %s\\n' {} {}; {diff} {} {}{only}; }} | {cap}",
                shell_quote(before),
                shell_quote(after),
                shell_quote(before),
                shell_quote(after)
            ));
        }
        Target::Worktree => {
            lines.push("h=$(git rev-parse --verify --quiet HEAD) || h=".to_owned());
            lines.push(format!("{{ printf '{SHAS_MARKER} %s %s\\n' \"$h\" \"\";"));
            lines.push(format!(
                "  {diff} HEAD{only} 2>/dev/null || {diff} --cached{only};"
            ));
            // A name git still quotes (a newline or quote in it) is skipped.
            lines.push(if only.is_empty() {
                format!(
                    "  {GIT} ls-files --others --exclude-standard | head -n {MAX_UNTRACKED_FILES} |"
                )
            } else {
                format!("  {GIT} --literal-pathspecs ls-files --others --exclude-standard{only} |")
            });
            lines.push(format!(
                "  while IFS= read -r f; do case \"$f\" in \\\"*) continue;; esac; {GIT} diff {DIFF_OPTIONS} --no-index -- /dev/null \"$f\"; done;"
            ));
            lines.push(format!("}} | {cap}"));
        }
        Target::Mr { .. } => {
            return Err(GitError::message("merge request diffs come from the forge"));
        }
    }
    Ok(lines.join("\n"))
}

pub fn parse_review_patch_output(output: &str, max_bytes: usize) -> ReviewDiff {
    // What a login profile printed before the script's output goes.
    let marker = if output.starts_with(SHAS_MARKER) {
        Some(0)
    } else {
        output
            .find(&format!("\n{SHAS_MARKER} "))
            .map(|index| index + 1)
    };
    let mut text: &str = match marker {
        Some(index) if index > 0 => &output[index..],
        _ => output,
    };
    let mut base_sha = None;
    let mut head_sha = None;
    if text.starts_with(SHAS_MARKER) {
        let end = text.find('\n');
        let first = &text[..end.unwrap_or(text.len())];
        let mut parts = first.split(' ').skip(1);
        base_sha = parts.next().filter(|s| !s.is_empty()).map(str::to_owned);
        head_sha = parts.next().filter(|s| !s.is_empty()).map(str::to_owned);
        text = match end {
            Some(end) => &text[end + 1..],
            None => "",
        };
    }
    let truncated = output.len() > max_bytes;
    let mut cut_file = false;
    let mut owned;
    if truncated {
        // The partial file at the cut goes, so no hunk ends mid-line; a
        // file cut on its own keeps its whole lines, marked cut.
        match text.rfind("\ndiff --git ") {
            Some(last) if last > 0 => {
                owned = text[..last + 1].to_owned();
            }
            _ => {
                owned = match text.rfind('\n') {
                    Some(end) => text[..end + 1].to_owned(),
                    None => String::new(),
                };
                cut_file = true;
            }
        }
    } else {
        owned = text.to_owned();
    }
    let mut files = parse_unified_diff(&owned);
    owned.clear();
    if cut_file && files.len() == 1 {
        files[0].truncated = Some(true);
    }
    ReviewDiff {
        files,
        base_sha,
        head_sha,
        truncated,
    }
}

/// A review's patch; only `paths` when given, uncapped but for
/// [`REVIEW_FILE_PATCH_MAX_BYTES`].
pub async fn read_review_patch(
    cx: &GitContext,
    root: &str,
    target: &Target,
    paths: Option<&[String]>,
) -> Result<ReviewDiff> {
    let max_bytes = if paths.is_some_and(|p| !p.is_empty()) {
        REVIEW_FILE_PATCH_MAX_BYTES
    } else {
        REVIEW_PATCH_MAX_BYTES
    };
    let script = review_patch_script(root, target, max_bytes, paths)?;
    let output = run_review_script(
        cx,
        root,
        &script,
        ScriptHow {
            tag: "review.patch",
            timeout: REVIEW_PATCH_TIMEOUT,
            label: "git diff failed",
            target: Some(target),
            max: None,
        },
    )
    .await?;
    Ok(parse_review_patch_output(&output, max_bytes))
}

/// A fingerprint of what a review shows, cheap enough to poll.
pub fn review_state_script(root: &str, target: &Target) -> Result<String> {
    let mut lines = vec![enter_checkout(root)];
    match target {
        Target::Range { base, head, .. } => {
            lines.push(resolve_base(base));
            lines.push(resolve_head(head));
            lines.push("printf '%s\\n%s\\n' \"$b\" \"$h\"".to_owned());
        }
        Target::Step { before, after, .. } => {
            for tree in [before, after] {
                lines.push(format!(
                    "git rev-parse --verify --quiet {} || {}",
                    shell_quote(&format!("{tree}^{{tree}}")),
                    unknown_revision(tree)
                ));
            }
        }
        Target::Worktree => {
            lines.push("git rev-parse --verify --quiet HEAD".to_owned());
            lines.push("{ git diff --no-color --no-ext-diff HEAD 2>/dev/null || git diff --no-color --no-ext-diff --cached; } | git hash-object --stdin".to_owned());
            // Every untracked file counts (no 200-file cap).
            lines.push("git ls-files --others --exclude-standard | { git hash-object --stdin-paths 2>/dev/null; git ls-files --others --exclude-standard; } | git hash-object --stdin".to_owned());
        }
        Target::Mr { .. } => {
            return Err(GitError::message(
                "merge request changes come from the forge",
            ));
        }
    }
    lines.push("exit 0".to_owned());
    Ok(lines.join("\n"))
}

pub async fn read_review_state(cx: &GitContext, root: &str, target: &Target) -> Result<String> {
    let output = run_review_script(
        cx,
        root,
        &review_state_script(root, target)?,
        ScriptHow {
            tag: "review.state",
            timeout: Duration::from_millis(20_000),
            label: "git failed",
            target: Some(target),
            max: None,
        },
    )
    .await?;
    Ok(output.split_whitespace().collect::<Vec<_>>().join(" "))
}

/// The repository holding `path` on the connection's host.
pub async fn read_review_root(cx: &GitContext, path: &str) -> Result<String> {
    // An empty or relative path would run Git in the login directory.
    if !is_host_path(path) {
        let shown: String = path.chars().take(200).collect();
        return Err(GitError::Message(format!(
            "a review's checkout must be an absolute path, not \"{shown}\""
        )));
    }
    let invocation = match cx.host() {
        Some(host) => Invocation::ssh_read(
            host,
            &format!("git -C {} rev-parse --show-toplevel", shell_quote(path)),
            Some("review.root"),
        ),
        None => Invocation::local(["git", "-C", path, "rev-parse", "--show-toplevel"]),
    };
    let ran = cx.run(invocation, Duration::from_millis(10_000)).await?;
    let root = ran.stdout.trim();
    if ran.code != 0 || root.is_empty() {
        let text = if ran.stderr.is_empty() {
            "not inside a Git repository"
        } else {
            &ran.stderr
        };
        return Err(GitError::Message(trim_slice(text, 500)));
    }
    Ok(root.to_owned())
}

/// The branch a review compares against when none is named: Automatic's
/// base, as the review writes it (`origin/main`, `main`).
pub async fn read_default_base(cx: &GitContext, root: &str) -> Result<String> {
    let base = resolve_default_base(cx, root, None, None)
        .await
        .ok()
        .and_then(|resolved| resolved.base);
    match base {
        Some(base) => Ok(short_ref_name(&base)),
        None => Err(GitError::message(
            "cannot find the default branch; pass --range BASE..HEAD",
        )),
    }
}

/// A repository a workspace's session may have changed.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ReviewRepo {
    pub root: String,
    pub branch: String,
    pub base: String,
    pub ahead: i64,
    pub dirty: bool,
    pub seed: bool,
    pub touched: bool,
    pub active: i64,
}

fn now_seconds() -> f64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs_f64())
        .unwrap_or(0.0)
}

/// The scan's script (scanReviewRepos).
pub fn scan_review_repos_script(paths: &[String], agent_paths: &[String]) -> String {
    let quoted = |list: &[String]| {
        list.iter()
            .map(|p| shell_quote(p))
            .collect::<Vec<_>>()
            .join(" ")
    };
    let mut touched: Vec<String> = Vec::new();
    if !agent_paths.is_empty() {
        touched.extend(
            [
                "touched=$(".to_owned(),
                format!("  for a in {}; do", quoted(agent_paths)),
                "    d=\"$HOME/.claude/projects/$(printf %s \"$a\" | sed 's/[^a-zA-Z0-9]/-/g')\"".to_owned(),
                "    f=$(ls -t \"$d\"/*.jsonl 2>/dev/null | head -n 1)".to_owned(),
                "    [ -n \"$f\" ] || continue".to_owned(),
                format!("    tail -c {REVIEW_AGENT_RECORD_BYTES} \"$f\" | grep -o '\"file_path\":\"/[^\"]*\"' | sed 's/^\"file_path\":\"//; s/\"$//; s|/[^/]*$||'"),
                format!("    tail -c {REVIEW_AGENT_RECORD_BYTES} \"$f\" | grep -oE '(cd|git -C) /[^ &;|\"\\]+' | sed -E 's/^(cd|git -C) //'"),
                "  done | sort -u | head -n 200)".to_owned(),
                "set -f; old_ifs=$IFS; IFS='".to_owned(),
                "'".to_owned(),
                "for p in $touched; do".to_owned(),
                "  r=$(git -C \"$p\" rev-parse --show-toplevel 2>/dev/null) || continue".to_owned(),
                "  t_roots=\"$t_roots".to_owned(),
                "$r\"".to_owned(),
                "done".to_owned(),
                "for r in $(printf '%s\\n' \"$t_roots\" | sort -u); do report \"$r\" 2; done".to_owned(),
                "IFS=$old_ifs; set +f".to_owned(),
            ],
        );
    }
    let mut lines = vec![
        format!("set -- {}", quoted(paths)),
        "seen=\" \"; n=0".to_owned(),
        "report() {".to_owned(),
        "  case \"$seen\" in *\" $1 \"*) return;; esac".to_owned(),
        format!("  [ \"$n\" -ge {REVIEW_REPO_LIMIT} ] && return"),
        "  seen=\"$seen$1 \"; n=$((n + 1))".to_owned(),
        "  b=$(git -C \"$1\" symbolic-ref -q --short HEAD || echo HEAD)".to_owned(),
        "  base=\"\"".to_owned(),
        "  for x in \"$(git -C \"$1\" symbolic-ref -q --short refs/remotes/origin/HEAD)\" origin/main origin/master main master; do".to_owned(),
        "    [ -n \"$x\" ] && git -C \"$1\" rev-parse --verify -q \"$x^{commit}\" >/dev/null && { base=$x; break; }".to_owned(),
        "  done".to_owned(),
        "  ahead=0".to_owned(),
        "  [ -n \"$base\" ] && ahead=$(git -C \"$1\" rev-list --count \"$base..HEAD\" 2>/dev/null || echo 0)".to_owned(),
        "  dirty=0".to_owned(),
        "  [ -n \"$(git -C \"$1\" status --porcelain 2>/dev/null | head -n 1)\" ] && dirty=1".to_owned(),
        "  t=$(git -C \"$1\" log -1 --format=%ct 2>/dev/null || echo 0)".to_owned(),
        "  i=$(date -r \"$(git -C \"$1\" rev-parse --git-path index)\" +%s 2>/dev/null || echo 0)".to_owned(),
        "  [ \"$i\" -gt \"$t\" ] 2>/dev/null && t=$i".to_owned(),
        "  printf '%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\n' \"$1\" \"$b\" \"$base\" \"$ahead\" \"$dirty\" \"$2\" \"$t\"".to_owned(),
        "}".to_owned(),
        "for p in \"$@\"; do".to_owned(),
        "  r=$(git -C \"$p\" rev-parse --show-toplevel 2>/dev/null) || continue".to_owned(),
        "  report \"$r\" 1".to_owned(),
        "done".to_owned(),
    ];
    lines.extend(touched);
    lines.extend(
        [
            "for p in \"$@\"; do",
            "  r=$(git -C \"$p\" rev-parse --show-toplevel 2>/dev/null) || continue",
            "  for c in \"$r\"/subprojects/*/; do",
            "    [ -e \"$c.git\" ] || continue",
            "    git -C \"$c\" symbolic-ref -q HEAD >/dev/null || continue",
            "    report \"${c%/}\" 0",
            "  done",
            "done",
        ]
        .map(str::to_owned),
    );
    lines.join("\n")
}

/// The repositories of the given directories, the ones next to them and
/// in their `subprojects/`, kept when they have changes or commits ahead
/// of their default branch. One script, one SSH round trip.
pub async fn scan_review_repos(
    cx: &GitContext,
    paths: &[String],
    agent_paths: &[String],
) -> Result<Vec<ReviewRepo>> {
    let paths: Vec<String> = paths
        .iter()
        .filter(|p| is_host_path(p))
        .take(20)
        .cloned()
        .collect();
    if paths.is_empty() {
        return Ok(Vec::new());
    }
    let agent_paths: Vec<String> = agent_paths
        .iter()
        .filter(|p| p.starts_with('/'))
        .take(10)
        .cloned()
        .collect();
    let script = scan_review_repos_script(&paths, &agent_paths);
    let ran = cx
        .run(
            read_invocation(cx, &script, "review.repos")?,
            Duration::from_millis(30_000),
        )
        .await?;
    let number = |text: Option<&str>| {
        text.and_then(crate::compare::js_number)
            .filter(|n| n.is_finite())
            .map_or(0, |n| n as i64)
    };
    let now = now_seconds();
    let mut repos = Vec::new();
    for line in ran.stdout.split('\n') {
        let fields: Vec<&str> = line.split('\t').collect();
        let root = fields.first().copied().unwrap_or("");
        let Some(seed) = fields.get(5).copied() else {
            continue;
        };
        if root.is_empty() || !is_host_path(root) {
            continue;
        }
        let repo = ReviewRepo {
            root: root.to_owned(),
            branch: fields.get(1).copied().unwrap_or("").to_owned(),
            base: fields.get(2).copied().unwrap_or("").to_owned(),
            ahead: number(fields.get(3).copied()),
            dirty: fields.get(4) == Some(&"1"),
            seed: seed == "1",
            touched: seed == "2",
            active: number(fields.get(6).copied()),
        };
        let changed = repo.ahead > 0 || repo.dirty;
        let recent = now - (repo.active as f64) < REVIEW_REPO_RECENT_S;
        // An agent's repositories count while changed or active lately;
        // subprojects need both.
        if repo.seed || (repo.touched && (changed || recent)) || (changed && recent) {
            repos.push(repo);
        }
    }
    // The given directories' repositories first, then the most recent.
    repos.sort_by(|a, b| b.seed.cmp(&a.seed).then(b.active.cmp(&a.active)));
    Ok(repos)
}

/// A repository-relative path that cannot leave the checkout.
pub fn valid_review_path(path: &str) -> bool {
    !path.is_empty()
        && path.encode_utf16().count() <= 4096
        && !path.starts_with('/')
        && !path.contains('\0')
        && !path.split('/').any(|part| part == ".." || part.is_empty())
}

static SHA: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[0-9a-f]{7,64}$").unwrap());

/// One file of the review, at a commit or from the working tree when
/// `rev` is empty; larger files are refused.
pub async fn read_review_file(
    cx: &GitContext,
    root: &str,
    rev: &str,
    path: &str,
) -> Result<String> {
    if !valid_review_path(path) {
        return Err(GitError::message("invalid path"));
    }
    if !rev.is_empty() && !SHA.is_match(rev) {
        return Err(GitError::message("invalid revision"));
    }
    // From the working tree: a regular file whose directory, links
    // resolved, is inside the checkout.
    let read = if rev.is_empty() {
        [
            format!("f={}", shell_quote(path)),
            "top=$(pwd -P)".to_owned(),
            "real=$(cd -P -- \"$(dirname -- \"$f\")\" 2>/dev/null && pwd -P) || { echo \"cannot read the file\" >&2; exit 4; }".to_owned(),
            "case \"$real/\" in \"$top\"/*) ;; *) echo \"the file is outside the checkout\" >&2; exit 4;; esac".to_owned(),
            "{ [ -f \"$f\" ] && [ ! -L \"$f\" ]; } || { echo \"not a regular file of the checkout\" >&2; exit 4; }".to_owned(),
            "cat -- \"$f\"".to_owned(),
        ]
        .join("\n")
    } else {
        format!("git show {}", shell_quote(&format!("{rev}:{path}")))
    };
    let script = format!(
        "{}\n{read} | head -c {}",
        enter_checkout(root),
        REVIEW_FILE_MAX_BYTES + 1
    );
    let output = run_review_script(
        cx,
        root,
        &script,
        ScriptHow {
            tag: "review.file",
            timeout: Duration::from_millis(20_000),
            label: "cannot read the file",
            target: None,
            max: Some(300),
        },
    )
    .await?;
    if output.len() > REVIEW_FILE_MAX_BYTES {
        return Err(GitError::message(
            "the file is too large to show context from",
        ));
    }
    Ok(output)
}

/// The commit of several refs in several checkouts, in one command.
pub async fn read_review_heads(
    cx: &GitContext,
    entries: &[(String, String)],
) -> Result<Vec<Option<String>>> {
    if entries.is_empty() {
        return Ok(Vec::new());
    }
    // Each line says which entry it answers: a login banner cannot shift
    // the answers.
    let script = entries
        .iter()
        .enumerate()
        .map(|(index, (root, reference))| {
            format!(
                "printf '{HEAD_MARKER}{index} %s\\n' \"$(git -C {} rev-parse --verify --quiet {} 2>/dev/null)\"",
                shell_quote(root),
                shell_quote(&format!("{reference}^{{commit}}"))
            )
        })
        .collect::<Vec<_>>()
        .join("\n");
    let ran = cx
        .run(
            read_invocation(cx, &script, "review.heads")?,
            Duration::from_millis(20_000),
        )
        .await?;
    let pattern = Regex::new(&format!(r"^{HEAD_MARKER}(\d+) ([0-9a-f]{{7,64}})\s*$")).unwrap();
    let mut heads: BTreeMap<usize, String> = BTreeMap::new();
    for line in ran.stdout.split('\n') {
        if let Some(found) = pattern.captures(line)
            && let Ok(index) = found[1].parse()
        {
            heads.insert(index, found[2].to_owned());
        }
    }
    Ok((0..entries.len()).map(|i| heads.get(&i).cloned()).collect())
}

/// One commit's own changes against its first parent (nothing, for a
/// root).
pub fn review_commit_script(root: &str, commit: &str, max_bytes: usize) -> Result<String> {
    if !SHA.is_match(commit) {
        return Err(GitError::message("invalid commit"));
    }
    Ok([
        enter_checkout(root),
        format!(
            "c=$(git rev-parse --verify --quiet {}) || {{ echo \"unknown commit\" >&2; exit 3; }}",
            shell_quote(&format!("{commit}^{{commit}}"))
        ),
        "p=$(git rev-parse --verify --quiet \"$c^\" 2>/dev/null) || p=".to_owned(),
        format!(
            "{{ printf '{SHAS_MARKER} %s %s\\n' \"$p\" \"$c\"; {GIT} diff-tree -p -r --root --no-commit-id {DIFF_OPTIONS} --find-renames --first-parent -m \"$c\"; }} | head -c {}",
            max_bytes + 1
        ),
    ]
    .join("\n"))
}

/// The commits a range adds, oldest first.
pub fn review_commits_script(root: &str, base: &str, head: &str) -> String {
    let format = shell_quote("%H%x1f%P%x1f%an%x1f%aI%x1f%s%x1f%b%x1e");
    [
        enter_checkout(root),
        resolve_base(base),
        resolve_head(head),
        format!(
            "if [ \"$(git cat-file -t \"$b\")\" = tree ]; then git log --reverse --no-color --format={format} -n {REVIEW_MAX_COMMITS} \"$h\"; exit 0; fi"
        ),
        "m=$(git merge-base \"$b\" \"$h\") || m=\"$b\"".to_owned(),
        format!(
            "if [ \"$m\" = \"$h\" ]; then printf '{HISTORY_MARKER}{COMMIT_END}'; git log --no-color --format={format} -n {REVIEW_MAX_COMMITS} \"$h\"; exit 0; fi"
        ),
        format!(
            "git log --reverse --no-color --format={format} -n {REVIEW_MAX_COMMITS} \"$m..$h\""
        ),
    ]
    .join("\n")
}

/// `git patch-id --stable` of each of these commits the checkout has.
pub fn review_patch_ids_script(root: &str, shas: &[String]) -> Result<String> {
    if shas.iter().any(|sha| !SHA.is_match(sha)) {
        return Err(GitError::message("invalid commit"));
    }
    Ok([
        enter_checkout(root),
        format!(
            "s=$(for c in {}; do git rev-parse --verify --quiet \"$c^{{commit}}\"; done)",
            shas.iter()
                .map(|s| shell_quote(s))
                .collect::<Vec<_>>()
                .join(" ")
        ),
        "[ -n \"$s\" ] || exit 0".to_owned(),
        format!("{GIT} show {DIFF_OPTIONS} --format='commit %H' -p $s | git patch-id --stable"),
    ]
    .join("\n"))
}

static LONG_SHA: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[0-9a-f]{40,64}$").unwrap());

/// `patch-id sha` lines, as patch ids by sha.
pub fn parse_review_patch_ids(output: &str) -> BTreeMap<String, String> {
    let mut ids = BTreeMap::new();
    for line in output.split('\n') {
        let mut parts = line.split_whitespace();
        if let (Some(id), Some(sha)) = (parts.next(), parts.next())
            && LONG_SHA.is_match(id)
            && LONG_SHA.is_match(sha)
        {
            ids.insert(sha.to_owned(), id.to_owned());
        }
    }
    ids
}

pub async fn read_review_patch_ids(
    cx: &GitContext,
    root: &str,
    shas: &[String],
) -> Result<BTreeMap<String, String>> {
    if shas.is_empty() {
        return Ok(BTreeMap::new());
    }
    let output = run_review_script(
        cx,
        root,
        &review_patch_ids_script(root, shas)?,
        ScriptHow {
            tag: "review.patch-ids",
            timeout: Duration::from_millis(20_000),
            label: "git patch-id failed",
            target: None,
            max: Some(300),
        },
    )
    .await?;
    Ok(parse_review_patch_ids(&output))
}

pub fn parse_review_commits(output: &str) -> Vec<ReviewCommit> {
    let history = output.starts_with(&format!("{HISTORY_MARKER}{COMMIT_END}"));
    output
        .split(COMMIT_END)
        .map(|record| record.strip_prefix('\n').unwrap_or(record))
        .filter(|record| record.contains(COMMIT_FIELD))
        .map(|record| {
            let mut fields = record.split(COMMIT_FIELD);
            let mut next = || fields.next().unwrap_or("").to_owned();
            let sha = next();
            let parents = next();
            let author = next();
            let date = next();
            let subject = next();
            let body = next();
            ReviewCommit {
                sha,
                parent: parents
                    .split(' ')
                    .next()
                    .filter(|p| !p.is_empty())
                    .map(str::to_owned),
                author,
                date,
                subject,
                body: body.trim().to_owned(),
                history,
            }
        })
        .collect()
}

pub async fn read_review_commits(
    cx: &GitContext,
    root: &str,
    base: &str,
    head: &str,
) -> Result<Vec<ReviewCommit>> {
    let target = Target::range(base, head);
    let output = run_review_script(
        cx,
        root,
        &review_commits_script(root, base, head),
        ScriptHow {
            tag: "review.commits",
            timeout: Duration::from_millis(20_000),
            label: "git log failed",
            target: Some(&target),
            max: Some(300),
        },
    )
    .await?;
    Ok(parse_review_commits(&output))
}

pub async fn read_review_commit_patch(
    cx: &GitContext,
    root: &str,
    commit: &str,
) -> Result<ReviewDiff> {
    let output = run_review_script(
        cx,
        root,
        &review_commit_script(root, commit, REVIEW_PATCH_MAX_BYTES)?,
        ScriptHow {
            tag: "review.commit",
            timeout: Duration::from_millis(30_000),
            label: "git diff failed",
            target: None,
            max: Some(300),
        },
    )
    .await?;
    Ok(parse_review_patch_output(&output, REVIEW_PATCH_MAX_BYTES))
}

/// A diff's files as they come, for callers that only want the paths.
pub fn paths(diff: &ReviewDiff) -> Vec<String> {
    diff.files
        .iter()
        .map(|f: &DiffFile| f.path.clone())
        .collect()
}

#[cfg(test)]
mod tests;
