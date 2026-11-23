//! A request's home (`mr-reviews/home.ts`): a workspace of its own, where
//! its review is shown and its agent keeps its notes. Opening a request
//! that has one (on its branch, named after it, or made here) shows its
//! review there, not in the project's shared review workspace. "Start a
//! review with a home" makes one: a worktree through the user's worktree
//! path on the request's head, named after it, placed where the project's
//! reviews go, with a Claude session told its job. Nothing is ever sent to
//! a forge: git only fetches.

use std::sync::LazyLock;

use regex::Regex;
use roamgate_agents::js::{self, Obj};

use crate::connection::{ShellResult, sh_quote};
use crate::shared::types::{forge_ref_label, home_prompt};

/// The workspace label of a request's home: "!3326 rtpgccbwe: Fix...".
pub fn home_label(item: &Obj) -> String {
    let reference = forge_ref_label(item, true);
    let title = js::collapse_space(js::sv(item.get("title")), " ");
    let full = format!("{reference} {}", js::trim(&title));
    if js::len16(&full) > 60 {
        format!("{}\u{2026}", js::trim_end(&js::head16(&full, 59)))
    } else {
        full
    }
}

static NOT_BRANCH: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"[^A-Za-z0-9_./-]+").expect("pattern"));
static DOTS: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\.{2,}").expect("pattern"));
static SLASHES: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"/{2,}").expect("pattern"));
static ENDS: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[-/.]+|[-/.]+$").expect("pattern"));
static LOCK: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\.lock$").expect("pattern"));
static MAIN: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^(main|master)$").expect("pattern"));

fn number_text(item: &Obj) -> String {
    item.get("number")
        .map(js::to_text)
        .unwrap_or_else(|| "undefined".into())
}

/// A branch name git and the worktree command take, from the forge's.
pub fn home_branch_name(item: &Obj) -> String {
    let source = js::sv(item.get("sourceBranch"));
    let cleaned = NOT_BRANCH.replace_all(source, "-");
    let cleaned = DOTS.replace_all(&cleaned, ".");
    let cleaned = SLASHES.replace_all(&cleaned, "/");
    let cleaned = ENDS.replace_all(&cleaned, "");
    let cleaned = LOCK.replace(&cleaned, "");
    // Only ASCII is left.
    let cleaned: String = cleaned.chars().take(120).collect();
    if !cleaned.is_empty() && !MAIN.is_match(&cleaned) {
        cleaned
    } else {
        format!("review/{}", number_text(item))
    }
}

/// The branch to make in the clone: the request's own name unless the
/// clone has a branch of that name (the user's, never moved): then
/// review/N-name. Prints `NAME <branch>`.
pub fn home_branch_script(clone: &str, wanted: &str, number: &str) -> String {
    let other = js::head16(&format!("review/{number}-{wanted}"), 200);
    [
        format!("cd {} || exit 2", sh_quote(clone)),
        format!("b={}", sh_quote(wanted)),
        format!(
            "if git show-ref --verify --quiet \"refs/heads/$b\"; then b={}; fi",
            sh_quote(&other)
        ),
        "if git show-ref --verify --quiet \"refs/heads/$b\"; then b=\"$b-$(date +%Y%m%d-%H%M%S)\"; fi".into(),
        "printf \"NAME %s\\n\" \"$b\"".into(),
    ]
    .join("\n")
}

/// Puts the new worktree's branch on the request's head. The worktree is
/// fresh (made from the target's tip a moment ago): `--keep` still refuses
/// to lose anything a setup hook may have written. Prints `AT <sha>`.
pub fn home_checkout_script(path: &str, sha: &str) -> String {
    [
        format!("cd {} || exit 2", sh_quote(path)),
        format!(
            "git cat-file -e {} 2>/dev/null || {{ echo NOCOMMIT; exit 3; }}",
            sh_quote(&format!("{sha}^{{commit}}"))
        ),
        format!("git reset -q --keep {} >&2 || exit 4", sh_quote(sha)),
        "echo \"AT $(git rev-parse HEAD)\"".into(),
    ]
    .join("\n")
}

/// The checkout's top and its remotes: `T <top>`, then `R <name> <url>`.
pub fn home_root_script(dir: &str) -> String {
    [
        format!("cd {} 2>/dev/null || exit 2", sh_quote(dir)),
        "printf \"T\\t%s\\n\" \"$(git rev-parse --show-toplevel 2>/dev/null)\"".into(),
        "git config --get-regexp '^remote\\..*\\.url$' 2>/dev/null | while read -r k v; do n=${k#remote.}; printf \"R\\t%s\\t%s\\n\" \"${n%.url}\" \"$v\"; done".into(),
        "exit 0".to_owned(),
    ]
    .join("\n")
}

/// A remote of a checkout.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HomeRemote {
    pub name: String,
    pub url: String,
}

/// What [`home_root_script`] printed.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct HomeRoot {
    pub top: String,
    pub remotes: Vec<HomeRemote>,
}

pub fn parse_home_root(stdout: &str) -> HomeRoot {
    let mut root = HomeRoot::default();
    for line in stdout.split('\n') {
        let mut fields = line.split('\t');
        let kind = fields.next().unwrap_or("");
        let a = fields.next().unwrap_or("");
        let b = fields.next().unwrap_or("");
        if kind == "T" && a.starts_with('/') {
            root.top = a.to_owned();
        } else if kind == "R" && !a.is_empty() && !b.is_empty() {
            root.remotes.push(HomeRemote {
                name: a.to_owned(),
                url: b.to_owned(),
            });
        }
    }
    root
}

static TRAILING_SLASHES: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"/+$").expect("pattern"));
static DOT_GIT: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\.git$").expect("pattern"));

/// The clone's own checkout, where its worktrees start from. Herdr's
/// worktree actions, and Roamgate's worktree path before them, run
/// work-tree commands there (`git rev-parse --show-toplevel`), which a
/// repository directory refuses: "this operation must be run in a work
/// tree". A checkout is its own, and so is the work tree `core.worktree`
/// gives a repository directory. A repository directory such as
/// gstreamer.git (the first entry of `git worktree list`, with no work tree
/// of its own) has the checkout its `gitdir` file names, or the directory
/// beside it without `.git`, when that checkout's repository is this one.
/// Prints `TOP\t<checkout>`, empty when there is none.
pub fn home_source_script(clone: &str) -> String {
    let trimmed = TRAILING_SLASHES.replace(clone, "");
    let beside = DOT_GIT.replace(&trimmed, "");
    [
        format!("cd {} 2>/dev/null || exit 2", sh_quote(clone)),
        "t=$(git rev-parse --show-toplevel 2>/dev/null)".into(),
        "if [ -z \"$t\" ]; then".into(),
        "  c=$(cd \"$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null)\" 2>/dev/null && pwd -P)".into(),
        format!(
            "  for d in \"$(sed -n 's,/\\.git$,,p' gitdir 2>/dev/null)\" {}; do",
            sh_quote(&beside)
        ),
        "    [ -n \"$d\" ] && [ -d \"$d\" ] || continue".into(),
        "    d=$(cd \"$d\" 2>/dev/null && pwd -P) || continue".into(),
        "    [ -n \"$c\" ] && [ \"$(cd \"$(git -C \"$d\" rev-parse --path-format=absolute --git-common-dir 2>/dev/null)\" 2>/dev/null && pwd -P)\" = \"$c\" ] || continue".into(),
        "    t=$(git -C \"$d\" rev-parse --show-toplevel 2>/dev/null) && [ -n \"$t\" ] && break".into(),
        "  done".into(),
        "fi".into(),
        "printf \"TOP\\t%s\\n\" \"$t\"".into(),
        "exit 0".to_owned(),
    ]
    .join("\n")
}

/// The checkout [`home_source_script`] printed; empty when there is none.
pub fn parse_home_source(stdout: &str) -> String {
    let top = stdout
        .split('\n')
        .find_map(|line| line.strip_prefix("TOP\t"))
        .map(js::trim)
        .unwrap_or("");
    if top.starts_with('/') {
        top.to_owned()
    } else {
        String::new()
    }
}

/// Makes the home's worktree with git, from an existing worktree of the
/// repository (`git worktree add` needs no work tree of the clone), on a
/// new branch at the request's head. Prints `MADE <path>`; the exit code
/// says which step failed ([`home_worktree_error`]).
pub fn home_worktree_script(from: &str, path: &str, branch: &str, sha: &str) -> String {
    [
        format!("cd {} 2>/dev/null || exit 2", sh_quote(from)),
        format!("mkdir -p \"$(dirname {})\" || exit 3", sh_quote(path)),
        format!(
            "git worktree add -q -b {} {} {} >&2 || exit 4",
            sh_quote(branch),
            sh_quote(path),
            sh_quote(sha)
        ),
        format!(
            "printf \"MADE %s\\n\" \"$(cd {} && pwd -P)\"",
            sh_quote(path)
        ),
    ]
    .join("\n")
}

/// Why [`home_worktree_script`] failed: the command and directory, with
/// git's words.
pub fn home_worktree_error(
    result: &ShellResult,
    from: &str,
    path: &str,
    branch: &str,
    sha: &str,
) -> String {
    let output = if result.stderr.is_empty() {
        &result.stdout
    } else {
        &result.stderr
    };
    let said = js::slice16(js::trim(output), -300, None);
    let command = format!(
        "git -C {from} worktree add -b {branch} {path} {}",
        js::head16(sha, 12)
    );
    match result.code {
        2 => format!("cannot enter {from}"),
        3 => format!("cannot create the directory of {path}"),
        _ if said.is_empty() => format!("{command} failed"),
        _ => format!("{command} failed: {said}"),
    }
}

static NOT_NAME: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"[^A-Za-z0-9._-]+").expect("pattern"));
static NAME_START: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[-.]+").expect("pattern"));
static LAST_PART: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"/[^/]*$").expect("pattern"));

/// Where a home made with git goes: beside the review worktree.
pub fn home_worktree_path(review_worktree: &str, branch: &str) -> String {
    let name = NOT_NAME.replace_all(branch, "-");
    let name = NAME_START.replace(&name, "");
    let trimmed = TRAILING_SLASHES.replace(review_worktree, "");
    let parent = LAST_PART.replace(&trimmed, "");
    format!("{parent}/{}", if name.is_empty() { "home" } else { &name })
}

static CONTROL: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"[\x00-\x1f\x7f]+").expect("pattern"));

/// Control characters out of text from a forge, before it reaches an agent.
fn plain(text: &str) -> String {
    js::trim(&CONTROL.replace_all(text, " ")).to_owned()
}

/// `a || b` on a request's text field.
fn or_text<'a>(item: &'a Obj, name: &str, fallback: &'a str) -> &'a str {
    match js::sv(item.get(name)) {
        "" => fallback,
        text => text,
    }
}

/// The first prompt of a request's home agent, from the setting.
pub fn home_prompt_for(template: &str, item: &Obj) -> String {
    let url = js::sv(item.get("url"));
    let reference = forge_ref_label(item, false);
    let title = js::head16(&plain(js::sv(item.get("title"))), 300);
    let author = js::head16(&plain(or_text(item, "author", "unknown")), 100);
    let target = js::head16(
        &plain(or_text(item, "targetBranch", "its target branch")),
        200,
    );
    let source = js::head16(&plain(or_text(item, "sourceBranch", "")), 200);
    home_prompt(
        template,
        &[
            ("url", url),
            ("ref", &reference),
            ("title", &title),
            ("author", &author),
            ("target", &target),
            ("source", &source),
            ("project", js::sv(item.get("project"))),
        ],
    )
}

#[cfg(test)]
pub(crate) mod test_item {
    use roamgate_agents::js::Obj;
    use serde_json::{Value, json};

    /// The request of home.test.ts, with `extra` over it.
    pub fn item(extra: Value) -> Obj {
        let mut base = json!({
            "provider": "gitlab", "host": "gitlab.example.org",
            "project": "gstreamer/gstreamer", "number": 3326,
            "key": "gitlab:gitlab.example.org/gstreamer/gstreamer#3326",
            "url": "https://gitlab.example.org/gstreamer/gstreamer/-/merge_requests/3326",
            "title": "rtpgccbwe: Fix the estimate when packets are lost in bursts of many",
            "author": "alice", "draft": false, "state": "open",
            "updatedAt": "2026-11-23T00:00:00.000Z", "headSha": "abc1234",
            "sourceBranch": "gcc-fix", "targetBranch": "main", "pipeline": null,
            "notes": 0, "reasons": ["review_requested"],
        });
        let map = base.as_object_mut().unwrap();
        for (key, value) in extra.as_object().cloned().unwrap_or_default() {
            map.insert(key, value);
        }
        map.clone()
    }
}

#[cfg(test)]
mod tests {
    use super::test_item::item;
    use super::*;
    use crate::shared::types::DEFAULT_HOME_PROMPT;
    use serde_json::json;

    #[test]
    fn a_homes_name_branch_and_prompt() {
        assert_eq!(
            home_label(&item(json!({}))),
            "!3326 rtpgccbwe: Fix the estimate when packets are lost in\u{2026}"
        );
        assert_eq!(
            home_label(&item(json!({"title": "short", "provider": "github"}))),
            "#3326 short"
        );
        assert_eq!(
            home_branch_name(&item(json!({"sourceBranch": "me/fix it.."}))),
            "me/fix-it"
        );
        assert_eq!(
            home_branch_name(&item(json!({"sourceBranch": "main"}))),
            "review/3326"
        );
        let text = home_prompt_for("", &item(json!({"title": "evil\n/clear title"})));
        assert!(text.contains(
            "home of the review of https://gitlab.example.org/gstreamer/gstreamer/-/merge_requests/3326"
        ));
        assert!(text.contains("\"evil /clear title\" by alice, into main"));
        assert!(text.contains("pending drafts"));
        assert!(text.contains("Never post to the forge"));
        assert!(DEFAULT_HOME_PROMPT.contains("{url}"));
        assert_eq!(
            home_prompt_for("Review {ref} ({source})", &item(json!({}))),
            "Review gstreamer/gstreamer!3326 (gcc-fix)"
        );
        assert_eq!(
            parse_home_root("T\t/a/b\nR\torigin\tgit@h:g/p.git\nR\tbad\n").remotes,
            vec![HomeRemote {
                name: "origin".into(),
                url: "git@h:g/p.git".into()
            }]
        );
        // mrHomeLinks (the shared review workspace is no home) is the web
        // panel's, not the server's: it stays with the TS test.
    }

    #[test]
    fn the_scripts_are_buns_text() {
        assert_eq!(
            home_root_script("/a b"),
            "cd '/a b' 2>/dev/null || exit 2\nprintf \"T\\t%s\\n\" \"$(git rev-parse --show-toplevel 2>/dev/null)\"\ngit config --get-regexp '^remote\\..*\\.url$' 2>/dev/null | while read -r k v; do n=${k#remote.}; printf \"R\\t%s\\t%s\\n\" \"${n%.url}\" \"$v\"; done\nexit 0"
        );
        assert!(home_source_script("/src/gst.git/").contains(
            "  for d in \"$(sed -n 's,/\\.git$,,p' gitdir 2>/dev/null)\" '/src/gst'; do"
        ));
        assert_eq!(parse_home_source("x\nTOP\t/src/gst \n"), "/src/gst");
        assert_eq!(parse_home_source("TOP\t\n"), "");
        assert_eq!(
            home_worktree_path("/src/p.worktrees/review/", "me/fix"),
            "/src/p.worktrees/me-fix"
        );
        assert_eq!(
            home_worktree_path("/src/p.worktrees/review", ".."),
            "/src/p.worktrees/home"
        );
        let failed = ShellResult {
            code: 4,
            stdout: String::new(),
            stderr: "fatal: no\n".into(),
        };
        assert_eq!(
            home_worktree_error(&failed, "/w", "/p", "b", "0123456789abcdef"),
            "git -C /w worktree add -b b /p 0123456789ab failed: fatal: no"
        );
        assert!(
            home_checkout_script("/p", "abc").contains(
                "git cat-file -e 'abc^{commit}' 2>/dev/null || { echo NOCOMMIT; exit 3; }"
            )
        );
        assert!(home_branch_script("/c", "fix", "3").contains("b='review/3-fix'"));
    }
}
