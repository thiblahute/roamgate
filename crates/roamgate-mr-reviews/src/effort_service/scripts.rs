//! The git scripts of an effort's parts and their parsers
//! (`mr-reviews/effort-service.ts`): picks, what a branch carries, a
//! part's checkout, content and stops, ports. The same text as Bun's.

use std::collections::{BTreeSet, HashMap, HashSet};
use std::sync::LazyLock;

use regex::Regex;

use crate::connection::sh_quote;

/// The subject of a commit folded into another by an autosquash rebase.
pub const FIXUP_SUBJECT: &str = "^(fixup|squash|amend)! ";

pub static FIXUP: LazyLock<Regex> = LazyLock::new(|| Regex::new(FIXUP_SUBJECT).expect("pattern"));
static SHA: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[0-9a-f]{40,64}$").expect("pattern"));

fn second(targets: &[String]) -> &str {
    targets.get(1).unwrap_or(&targets[0])
}

fn target_line(targets: &[String], or: &str) -> String {
    format!(
        "t=$(git -C \"$d\" rev-parse -q --verify {} 2>/dev/null) || t=$(git -C \"$d\" rev-parse -q --verify {} 2>/dev/null){or}",
        sh_quote(&targets[0]),
        sh_quote(second(targets))
    )
}

fn quoted(list: &[String]) -> String {
    list.iter()
        .map(|each| sh_quote(each))
        .collect::<Vec<_>>()
        .join(" ")
}

/// `pickScript`: in a fresh part worktree, refused unless it is on the
/// part's branch; moved onto the target when it is elsewhere, only while
/// clean and only while the branch was just made (one reflog entry: never
/// an existing branch's commits dropped), then the commits picked in
/// order. Prints `P n` (picked), `S sha` for one already in the target
/// (empty, skipped), and on a stop `X sha` with `U file` lines; never
/// aborts. Then what the branch holds over the target, read back: `N
/// count` and an `I patch-id` line per commit with a diff. Then, when the
/// picks all went in, every fixup!, squash! and amend! commit folded into
/// its target (a non-interactive autosquash rebase onto the target; a
/// squash! adds its body to the target's message, never its subject
/// line): `T same|differs` (the tree against the one before folding), `F
/// count` (the commits left) and `K subject` per fixup left as a commit
/// (its target not in the part); on a stop `R sha subject` with `U file`
/// lines, never aborted.
pub fn pick_script(dir: &str, targets: &[String], shas: &[String], branch: &str) -> String {
    let fixup = sh_quote(FIXUP_SUBJECT);
    [
        format!("d={}", sh_quote(dir)),
        "[ -d \"$d\" ] || { echo \"E\tno such worktree\"; exit 0; }".to_owned(),
        format!(
            "[ \"$(git -C \"$d\" symbolic-ref -q HEAD)\" = {} ] || {{ echo \"E\tthe worktree is not on the part's branch\"; exit 0; }}",
            sh_quote(&format!("refs/heads/{branch}"))
        ),
        target_line(targets, ""),
        "report() { [ -n \"$t\" ] || return 0; printf \"N\t%s\n\" \"$(git -C \"$d\" rev-list --count \"$t\"..HEAD)\"; git -C \"$d\" log --no-merges -p --format=\"commit %H\" \"$t\"..HEAD | git -C \"$d\" patch-id --stable | awk '{ print \"I\t\" $1 }'; }".to_owned(),
        format!(
            "fresh=$(git -C \"$d\" reflog show --format=%H {} 2>/dev/null | wc -l)",
            sh_quote(&format!("refs/heads/{branch}"))
        ),
        "if [ -n \"$t\" ] && [ \"$(git -C \"$d\" rev-parse HEAD)\" != \"$t\" ]; then".to_owned(),
        "  if [ \"$fresh\" -ne 1 ] || [ -n \"$(git -C \"$d\" status --porcelain)\" ]; then echo \"E\tthe branch is not a fresh one on a clean worktree: not moved onto the target\"; exit 0; fi".to_owned(),
        "  git -C \"$d\" reset -q --keep \"$t\" || { echo \"E\tcannot move the part onto the target\"; exit 0; }".to_owned(),
        "fi".to_owned(),
        "n=0".to_owned(),
        format!("for c in {}; do", quoted(shas)),
        "  if git -C \"$d\" -c core.editor=true cherry-pick --allow-empty \"$c\" >/dev/null 2>&1; then n=$((n+1)); else".to_owned(),
        // Already in the target (picked empty): skipped and said, not a stop.
        "    if [ -z \"$(git -C \"$d\" diff --name-only --diff-filter=U)\" ] && [ -z \"$(git -C \"$d\" status --porcelain)\" ] && git -C \"$d\" rev-parse -q --verify CHERRY_PICK_HEAD >/dev/null; then git -C \"$d\" cherry-pick --skip >/dev/null 2>&1 && { printf \"S\t%s\n\" \"$c\"; continue; }; fi".to_owned(),
        "    printf \"P\t%s\nX\t%s\n\" \"$n\" \"$c\"".to_owned(),
        "    git -C \"$d\" diff --name-only --diff-filter=U | sed \"s/^/U\t/\"".to_owned(),
        "    report".to_owned(),
        "    exit 0".to_owned(),
        "  fi".to_owned(),
        "done".to_owned(),
        "printf \"P\t%s\n\" \"$n\"".to_owned(),
        "report".to_owned(),
        format!("[ -n \"$t\" ] && git -C \"$d\" log --format=%s \"$t\"..HEAD | grep -qE {fixup} || exit 0"),
        "before=$(git -C \"$d\" rev-parse \"HEAD^{tree}\")".to_owned(),
        // Its own editor for a squash!'s message: the squash! subject lines
        // out, the target's message and any body the squash! adds kept.
        format!(
            "if GIT_EDITOR={} git -C \"$d\" -c sequence.editor=: -c rebase.updateRefs=false -c rebase.autoStash=false -c rebase.abbreviateCommands=false rebase -i --autosquash --empty=keep --no-verify \"$t\" >/dev/null 2>&1; then",
            sh_quote("f() { grep -v \"^squash! \" \"$1\" > \"$1.rg\"; mv \"$1.rg\" \"$1\"; }; f")
        ),
        "  [ \"$(git -C \"$d\" rev-parse \"HEAD^{tree}\")\" = \"$before\" ] && echo \"T\tsame\" || echo \"T\tdiffers\"".to_owned(),
        "  printf \"F\t%s\n\" \"$(git -C \"$d\" rev-list --count \"$t\"..HEAD)\"".to_owned(),
        format!("  git -C \"$d\" log --reverse --format=%s \"$t\"..HEAD | grep -E {fixup} | sed \"s/^/K\t/\""),
        "elif r=$(git -C \"$d\" rev-parse -q --verify REBASE_HEAD 2>/dev/null); then".to_owned(),
        "  printf \"R\t%s\t%s\n\" \"$r\" \"$(git -C \"$d\" log -1 --format=%s \"$r\")\"".to_owned(),
        "  git -C \"$d\" diff --name-only --diff-filter=U | sed \"s/^/U\t/\"".to_owned(),
        "else echo \"E\tfolding the fixups failed\"; fi".to_owned(),
    ]
    .join("\n")
}

/// `carriesScript`: whether a local branch already holds a plan's changes
/// over the target: `M` when there is no such branch, `N reason` when it
/// does not, `Y sha` when it does. The plan's changes, squashed: its
/// commits merged in turn onto the tree where the branch leaves the
/// target; held when merging that squashed change into the branch cleanly
/// leaves its tree as it is (all of it there already). Only read: no ref,
/// index or worktree touched.
pub fn carries_script(
    dir: &str,
    branch: &str,
    targets: &[String],
    shas: &[String],
    onto: Option<&str>,
) -> String {
    [
        format!("d={}", sh_quote(dir)),
        format!(
            "b=$(git -C \"$d\" rev-parse -q --verify {} 2>/dev/null) || {{ echo M; exit 0; }}",
            sh_quote(&format!("refs/heads/{branch}^{{commit}}"))
        ),
        target_line(targets, " || { echo \"N\tthe target is unknown\"; exit 0; }"),
        "[ \"$(git -C \"$d\" rev-list --count \"$t..$b\")\" -gt 0 ] || { echo \"N\tnothing over the target\"; exit 0; }".to_owned(),
        match onto {
            Some(onto) => format!("m={}", sh_quote(onto)),
            None => "m=$(git -C \"$d\" merge-base \"$t\" \"$b\") || { echo \"N\tno common history with the target\"; exit 0; }".to_owned(),
        },
        "base=$(git -C \"$d\" rev-parse \"$m^{tree}\")".to_owned(),
        "cur=$base".to_owned(),
        format!("for c in {}; do", quoted(shas)),
        "  p=$(git -C \"$d\" rev-parse -q --verify \"$c^\" 2>/dev/null) || { printf \"N\t%s is a root commit\n\" \"$c\"; exit 0; }".to_owned(),
        "  out=$(git -C \"$d\" merge-tree --write-tree --merge-base=\"$p\" \"$cur\" \"$c\" 2>/dev/null) || { printf \"N\t%s does not apply where it leaves the target\n\" \"$c\"; exit 0; }".to_owned(),
        "  cur=$(printf \"%s\n\" \"$out\" | head -n 1)".to_owned(),
        "done".to_owned(),
        "[ \"$cur\" != \"$base\" ] || { echo \"N\tthe plan changes nothing there\"; exit 0; }".to_owned(),
        "out=$(git -C \"$d\" merge-tree --write-tree --merge-base=\"$base\" \"$b\" \"$cur\" 2>/dev/null) || { echo \"N\tsome plan changes are not there\"; exit 0; }".to_owned(),
        "[ \"$(printf \"%s\n\" \"$out\" | head -n 1)\" = \"$(git -C \"$d\" rev-parse \"$b^{tree}\")\" ] && printf \"Y\t%s\n\" \"$b\" || echo \"N\tsome plan changes are not there\"".to_owned(),
    ]
    .join("\n")
}

/// `partCheckoutScript`: a part's worktree as it is now: `W branch sha`
/// when it is a worktree on a branch, `U branch` on a branch with no
/// commit (gone), `D` on no branch, `M` when there is no worktree at its
/// path; then `S sha` when the branch it was recorded on still exists.
/// Only read.
pub fn part_checkout_script(path: &str, clone: &str, branch: &str) -> String {
    [
        format!("d={}", sh_quote(path)),
        "if [ -d \"$d\" ] && p=$(cd \"$d\" 2>/dev/null && pwd -P) && [ \"$p\" = \"$(git -C \"$d\" rev-parse --show-toplevel 2>/dev/null)\" ]; then".to_owned(),
        "  if r=$(git -C \"$d\" symbolic-ref -q HEAD); then".to_owned(),
        "    if s=$(git -C \"$d\" rev-parse -q --verify \"$r^{commit}\" 2>/dev/null); then printf \"W\t%s\t%s\n\" \"${r#refs/heads/}\" \"$s\"; else printf \"U\t%s\n\" \"${r#refs/heads/}\"; fi".to_owned(),
        "  else echo D; fi".to_owned(),
        "else echo M; fi".to_owned(),
        format!(
            "s=$(git -C {} rev-parse -q --verify {} 2>/dev/null) && printf \"S\t%s\n\" \"$s\"",
            sh_quote(clone),
            sh_quote(&format!("refs/heads/{branch}^{{commit}}"))
        ),
        "exit 0".to_owned(),
    ]
    .join("\n")
}

/// A part's checkout as [`part_checkout_script`] read it.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct PartCheckout {
    pub branch: Option<String>,
    pub sha: Option<String>,
    /// "ok", "unborn", "detached" or "missing".
    pub state: &'static str,
    pub unborn: Option<String>,
    /// The branch it was recorded on exists still.
    pub stored: bool,
}

pub fn parse_part_checkout(stdout: &str) -> PartCheckout {
    let mut out = PartCheckout {
        state: "missing",
        ..PartCheckout::default()
    };
    let mut stored = false;
    for line in stdout.split('\n') {
        let mut fields = line.split('\t');
        let kind = fields.next().unwrap_or("");
        let value = fields.next().unwrap_or("");
        let sha = fields.next().unwrap_or("");
        if kind == "W" && !value.is_empty() && SHA.is_match(sha) {
            out = PartCheckout {
                branch: Some(value.to_owned()),
                sha: Some(sha.to_owned()),
                state: "ok",
                ..PartCheckout::default()
            };
        } else if kind == "U" && !value.is_empty() {
            out = PartCheckout {
                state: "unborn",
                unborn: Some(value.to_owned()),
                ..PartCheckout::default()
            };
        } else if kind == "D" {
            out = PartCheckout {
                state: "detached",
                ..PartCheckout::default()
            };
        } else if kind == "S" && !value.is_empty() {
            stored = true;
        }
    }
    PartCheckout { stored, ..out }
}

/// `branchWorktreesScript`: a local branch of the clone: `S sha` when it
/// exists, then `W path` for the worktree it is checked out in, if any.
/// Only read.
pub fn branch_worktrees_script(clone: &str, branch: &str) -> String {
    [
        format!("c={}", sh_quote(clone)),
        format!(
            "s=$(git -C \"$c\" rev-parse -q --verify {} 2>/dev/null) || exit 0",
            sh_quote(&format!("refs/heads/{branch}^{{commit}}"))
        ),
        "printf \"S\t%s\n\" \"$s\"".to_owned(),
        format!(
            "git -C \"$c\" worktree list --porcelain | awk -v want={} '/^worktree /{{p=substr($0,10)}} $0==want{{print \"W\t\" p}}'",
            sh_quote(&format!("branch refs/heads/{branch}"))
        ),
    ]
    .join("\n")
}

/// A local branch: its tip, and the worktree it is checked out in.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct BranchWorktrees {
    pub sha: Option<String>,
    pub worktree: Option<String>,
}

pub fn parse_branch_worktrees(stdout: &str) -> BranchWorktrees {
    let mut out = BranchWorktrees::default();
    for line in stdout.split('\n') {
        let (kind, value) = line.split_once('\t').unwrap_or((line, ""));
        if kind == "S" && SHA.is_match(value) {
            out.sha = Some(value.to_owned());
        } else if kind == "W" && !value.is_empty() && out.worktree.is_none() {
            out.worktree = Some(value.to_owned());
        }
    }
    out
}

/// `partContentScript`: what a part's branch holds, read in the clone:
/// `H sha` (its tip), `A sha` when it holds the tip of base (the part it
/// stacks on), `N count` and an `I patch-id` line per commit with a diff
/// over the target, `K subject` per fixup!, squash! or amend! commit over
/// its base (or the target), `U ref` per upstream/* branch at its tip.
/// Only read.
pub fn part_content_script(
    clone: &str,
    branch: &str,
    targets: &[String],
    base: Option<&str>,
) -> String {
    let mut lines = vec![
        format!("d={}", sh_quote(clone)),
        format!(
            "b=$(git -C \"$d\" rev-parse -q --verify {} 2>/dev/null) || exit 0",
            sh_quote(&format!("refs/heads/{branch}^{{commit}}"))
        ),
        target_line(targets, " || exit 0"),
        "printf \"H\t%s\n\" \"$b\"".to_owned(),
        "start=$t".to_owned(),
    ];
    if let Some(base) = base {
        lines.push(format!(
            "if r=$(git -C \"$d\" rev-parse -q --verify {} 2>/dev/null) && [ \"$(git -C \"$d\" merge-base \"$r\" \"$b\")\" = \"$r\" ]; then printf \"A\t%s\n\" \"$r\"; start=$r; fi",
            sh_quote(&format!("{base}^{{commit}}"))
        ));
    }
    lines.extend([
        "printf \"N\t%s\n\" \"$(git -C \"$d\" rev-list --count \"$t..$b\")\"".to_owned(),
        "git -C \"$d\" log --no-merges -p --format=\"commit %H\" \"$t..$b\" | git -C \"$d\" patch-id --stable | awk '{ print \"I\t\" $1 }'".to_owned(),
        format!(
            "git -C \"$d\" log --reverse --no-merges --format=%s \"$start..$b\" | grep -E {} | sed \"s/^/K\t/\"",
            sh_quote(FIXUP_SUBJECT)
        ),
        "git -C \"$d\" for-each-ref --points-at \"$b\" --format=\"U\t%(refname)\" refs/heads/upstream/".to_owned(),
        "exit 0".to_owned(),
    ]);
    lines.join("\n")
}

/// Commits over the target and their patch ids (those with a diff).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct OnBranch {
    pub count: usize,
    pub ids: Vec<String>,
}

/// What a part's branch holds, as [`part_content_script`] read it.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct PartContent {
    pub sha: Option<String>,
    pub on_base: Option<String>,
    pub on_branch: OnBranch,
    pub fixups: Vec<String>,
    pub upstream: Vec<String>,
}

/// `Number(value) || 0` for a count.
fn count(value: &str) -> usize {
    let number = roamgate_agents::js::number_from_text(value);
    if number.is_finite() && number > 0.0 {
        number as usize
    } else {
        0
    }
}

pub fn parse_part_content(stdout: &str) -> PartContent {
    let mut out = PartContent::default();
    for line in stdout.split('\n') {
        let (kind, value) = line.split_once('\t').unwrap_or((line, ""));
        if kind == "H" && SHA.is_match(value) {
            out.sha = Some(value.to_owned());
        } else if kind == "A" && SHA.is_match(value) {
            out.on_base = Some(value.to_owned());
        } else if kind == "N" {
            out.on_branch.count = count(value);
        } else if kind == "I" && !value.is_empty() {
            out.on_branch.ids.push(value.to_owned());
        } else if kind == "K" && !value.is_empty() {
            out.fixups.push(value.to_owned());
        } else if kind == "U"
            && let Some(name) = value.strip_prefix("refs/heads/")
        {
            out.upstream.push(name.to_owned());
        }
    }
    out
}

/// `preparedScript`: whether a local branch is a port of a plan sitting
/// on the part's base: `M` when there is no such branch; `N reason` when
/// it is not; else `O label ref sha` for what it is built on (one of ons,
/// each when its tip is where the branch leaves it, or the target, an
/// older commit of it as well), none of its own commits on the source,
/// then `B file` for each file it changes over there. Only read: no ref,
/// index or worktree touched.
pub fn prepared_script(
    dir: &str,
    branch: &str,
    ons: &[(String, String)],
    targets: &[String],
    source: &str,
) -> String {
    let mut lines = vec![
        format!("d={}", sh_quote(dir)),
        format!(
            "b=$(git -C \"$d\" rev-parse -q --verify {} 2>/dev/null) || {{ echo M; exit 0; }}",
            sh_quote(&format!("refs/heads/{branch}^{{commit}}"))
        ),
        target_line(targets, " || { echo \"N\tthe target is unknown\"; exit 0; }"),
        format!(
            "src=$(git -C \"$d\" rev-parse -q --verify {} 2>/dev/null)",
            sh_quote(&format!("{source}^{{commit}}"))
        ),
        "[ \"$(git -C \"$d\" rev-list --count \"$t..$b\")\" -gt 0 ] || { echo \"N\tnothing over the target\"; exit 0; }".to_owned(),
        "own() { [ -z \"$src\" ] || [ \"$(git -C \"$d\" rev-list --count \"$1..$b\" \"^$src\")\" = \"$(git -C \"$d\" rev-list --count \"$1..$b\")\" ]; }".to_owned(),
        "on() { printf \"O\t%s\t%s\t%s\n\" \"$1\" \"$2\" \"$b\"; git -C \"$d\" diff --name-only \"$3\" \"$b\" | sed \"s/^/B\t/\"; exit 0; }".to_owned(),
    ];
    for (label, reference) in ons {
        lines.push(format!(
            "r=$(git -C \"$d\" rev-parse -q --verify {} 2>/dev/null) && [ \"$r\" != \"$b\" ] && [ \"$(git -C \"$d\" merge-base \"$r\" \"$b\")\" = \"$r\" ] && own \"$r\" && on {} {} \"$r\"",
            sh_quote(&format!("{reference}^{{commit}}")),
            sh_quote(label),
            sh_quote(reference)
        ));
    }
    lines.extend([
        "m=$(git -C \"$d\" merge-base \"$t\" \"$b\") || { echo \"N\tno common history with the target\"; exit 0; }".to_owned(),
        format!("own \"$t\" && on target {} \"$m\"", sh_quote(&targets[0])),
        "echo \"N\tsome of its commits are on the source\"".to_owned(),
    ]);
    lines.join("\n")
}

/// A port of a plan as [`prepared_script`] read it.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Prepared {
    pub sha: Option<String>,
    /// What it is built on: label and ref.
    pub on: Option<(String, String)>,
    pub files: Vec<String>,
    pub missing: bool,
    pub not: Option<String>,
}

pub fn parse_prepared(stdout: &str) -> Prepared {
    let mut files = Vec::new();
    let mut found: Option<(String, (String, String))> = None;
    for line in stdout.split('\n') {
        let fields: Vec<&str> = line.split('\t').collect();
        let kind = fields[0];
        let value = fields.get(1).copied().unwrap_or("");
        let rest = if fields.len() > 2 {
            &fields[2..]
        } else {
            &[][..]
        };
        if kind == "M" {
            return Prepared {
                missing: true,
                files,
                ..Prepared::default()
            };
        }
        if kind == "N" {
            return Prepared {
                not: Some(value.to_owned()),
                files,
                ..Prepared::default()
            };
        }
        if kind == "O" && SHA.is_match(rest.get(1).copied().unwrap_or("")) {
            found = Some((rest[1].to_owned(), (value.to_owned(), rest[0].to_owned())));
        } else if kind == "B" && !value.is_empty() && found.is_some() {
            files.push(fields[1..].join("\t"));
        }
    }
    match found {
        Some((sha, on)) => Prepared {
            sha: Some(sha),
            on: Some(on),
            files,
            ..Prepared::default()
        },
        None => Prepared {
            not: Some("it could not be read".into()),
            files,
            ..Prepared::default()
        },
    }
}

/// A port against the plan: the files only one of them changes, in short.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct PortedDifference {
    pub only_in_plan: Vec<String>,
    pub only_in_branch: Vec<String>,
    pub summary: String,
}

/// `portedDifference`.
pub fn ported_difference(plan_files: &[String], branch_files: &[String]) -> PortedDifference {
    let in_plan: HashSet<&String> = plan_files.iter().collect();
    let in_branch: HashSet<&String> = branch_files.iter().collect();
    // `[...new Set(files)].sort()`: by UTF-16 units, as JavaScript sorts.
    let sorted = |files: &[String], other: &HashSet<&String>| -> Vec<String> {
        let unique: BTreeSet<Vec<u16>> = files
            .iter()
            .filter(|file| !other.contains(file))
            .map(|file| file.encode_utf16().collect())
            .collect();
        unique
            .into_iter()
            .map(|units| String::from_utf16_lossy(&units))
            .collect()
    };
    let only_in_plan = sorted(plan_files, &in_branch);
    let only_in_branch = sorted(branch_files, &in_plan);
    let some = |files: &[String]| {
        let head = files.iter().take(5).cloned().collect::<Vec<_>>().join(", ");
        if files.len() > 5 {
            format!("{head} and {} more", files.len() - 5)
        } else {
            head
        }
    };
    let mut parts = Vec::new();
    if !only_in_plan.is_empty() {
        parts.push(format!("only in the plan: {}", some(&only_in_plan)));
    }
    if !only_in_branch.is_empty() {
        parts.push(format!("only in the branch: {}", some(&only_in_branch)));
    }
    PortedDifference {
        only_in_plan: only_in_plan.into_iter().take(50).collect(),
        only_in_branch: only_in_branch.into_iter().take(50).collect(),
        summary: if parts.is_empty() {
            "the same files, their content its own".into()
        } else {
            parts.join("; ")
        },
    }
}

/// What a branch carries, as [`carries_script`] read it.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Carries {
    pub sha: Option<String>,
    pub missing: bool,
    pub not: Option<String>,
}

pub fn parse_carries(stdout: &str) -> Carries {
    for line in stdout.split('\n') {
        let mut fields = line.split('\t');
        let kind = fields.next().unwrap_or("");
        let value = fields.next().unwrap_or("");
        if kind == "M" {
            return Carries {
                missing: true,
                ..Carries::default()
            };
        }
        if kind == "Y" && SHA.is_match(value) {
            return Carries {
                sha: Some(value.to_owned()),
                ..Carries::default()
            };
        }
        if kind == "N" {
            return Carries {
                not: Some(value.to_owned()),
                ..Carries::default()
            };
        }
    }
    Carries {
        not: Some("it could not be read".into()),
        ..Carries::default()
    }
}

/// `partStopsScript`: for each part worktree, `X path sha` with `U path
/// file` lines while a pick is stopped there (`R path sha subject` while
/// folding its fixups is), `D path` when none is. A missing worktree says
/// nothing (its stop is kept as it was).
pub fn part_stops_script(paths: &[String]) -> String {
    [
        format!("for d in {}; do", quoted(paths)),
        "  [ -d \"$d\" ] || continue".to_owned(),
        "  if c=$(git -C \"$d\" rev-parse -q --verify CHERRY_PICK_HEAD 2>/dev/null); then".to_owned(),
        "    printf \"X\t%s\t%s\n\" \"$d\" \"$c\"".to_owned(),
        "    git -C \"$d\" diff --name-only --diff-filter=U | while IFS= read -r f; do printf \"U\t%s\t%s\n\" \"$d\" \"$f\"; done".to_owned(),
        "  elif c=$(git -C \"$d\" rev-parse -q --verify REBASE_HEAD 2>/dev/null); then".to_owned(),
        "    printf \"R\t%s\t%s\t%s\n\" \"$d\" \"$c\" \"$(git -C \"$d\" log -1 --format=%s \"$c\")\"".to_owned(),
        "    git -C \"$d\" diff --name-only --diff-filter=U | while IFS= read -r f; do printf \"U\t%s\t%s\n\" \"$d\" \"$f\"; done".to_owned(),
        "  elif git -C \"$d\" rev-parse -q --verify HEAD >/dev/null 2>&1; then printf \"D\t%s\n\" \"$d\"; fi".to_owned(),
        "done".to_owned(),
    ]
    .join("\n")
}

/// A part's stop: the commit, the files in conflict, and while folding
/// its fixups the subject.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct PartStop {
    pub sha: String,
    pub files: Vec<String>,
    pub subject: Option<String>,
    pub folding: bool,
}

/// `parsePartStops`: a part's path, its stop now, or None when the pick
/// is no longer stopped.
pub fn parse_part_stops(stdout: &str) -> HashMap<String, Option<PartStop>> {
    let mut out: HashMap<String, Option<PartStop>> = HashMap::new();
    for line in stdout.split('\n') {
        let fields: Vec<&str> = line.split('\t').collect();
        let kind = fields[0];
        let path = fields.get(1).copied().unwrap_or("");
        let value = fields.get(2).copied().unwrap_or("");
        let rest = if fields.len() > 3 {
            &fields[3..]
        } else {
            &[][..]
        };
        if kind == "D" && !path.is_empty() {
            out.insert(path.to_owned(), None);
        } else if kind == "X" && !path.is_empty() && !value.is_empty() {
            out.insert(
                path.to_owned(),
                Some(PartStop {
                    sha: value.to_owned(),
                    ..PartStop::default()
                }),
            );
        } else if kind == "R" && !path.is_empty() && !value.is_empty() {
            out.insert(
                path.to_owned(),
                Some(PartStop {
                    sha: value.to_owned(),
                    files: vec![],
                    subject: Some(rest.join("\t")),
                    folding: true,
                }),
            );
        } else if kind == "U"
            && !value.is_empty()
            && let Some(Some(stop)) = out.get_mut(path)
        {
            stop.files.push(value.to_owned());
        }
    }
    out
}

/// What a pick did, as [`pick_script`] printed it.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Pick {
    pub picked: usize,
    pub conflict: Option<String>,
    pub files: Vec<String>,
    pub skipped: Vec<String>,
    pub error: Option<String>,
    /// Read back: commits over the target and their patch ids (with a diff).
    pub on_branch: Option<OnBranch>,
    /// The fixups folded: the commits left, the same tree, those left as commits.
    pub fold: Option<Fold>,
    /// Folding the fixups stopped here: the part's commit and its subject.
    pub folding: Option<(String, String)>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Fold {
    pub count: usize,
    pub same_tree: bool,
    pub unfolded: Vec<String>,
}

pub fn parse_pick(stdout: &str) -> Pick {
    let mut out = Pick::default();
    let mut same_tree = false;
    let mut unfolded: Vec<String> = Vec::new();
    let mut fold_count: Option<usize> = None;
    let mut fold_same = false;
    for line in stdout.split('\n') {
        let fields: Vec<&str> = line.split('\t').collect();
        let kind = fields[0];
        let value = fields.get(1).copied().unwrap_or("");
        let rest = if fields.len() > 2 {
            &fields[2..]
        } else {
            &[][..]
        };
        match kind {
            "P" => out.picked = count(value),
            "X" => out.conflict = Some(value.to_owned()).filter(|v| !v.is_empty()),
            "U" if !value.is_empty() => out.files.push(value.to_owned()),
            "S" if !value.is_empty() => out.skipped.push(value.to_owned()),
            "E" => out.error = Some(value.to_owned()).filter(|v| !v.is_empty()),
            "N" => {
                out.on_branch = Some(OnBranch {
                    count: count(value),
                    ids: vec![],
                });
            }
            "I" if !value.is_empty() => {
                if let Some(on) = out.on_branch.as_mut() {
                    on.ids.push(value.to_owned());
                }
            }
            "T" => same_tree = value == "same",
            "F" => {
                fold_count = Some(count(value));
                fold_same = same_tree;
            }
            "K" if !value.is_empty() => unfolded.push(fields[1..].join("\t")),
            "R" if !value.is_empty() => out.folding = Some((value.to_owned(), rest.join("\t"))),
            _ => {}
        }
    }
    // The fold's unfolded list is the one filled to the end, as in Bun.
    out.fold = fold_count.map(|count| Fold {
        count,
        same_tree: fold_same,
        unfolded,
    });
    out
}

/// `pickedOnBranch`: how many of a part's commits its branch really
/// holds over the target: those with a diff by patch id, the empty ones
/// (no patch id) by the commits left over. Never more than were asked for.
pub fn picked_on_branch(patch_ids: &[String], on_branch: &OnBranch) -> usize {
    let ids: HashSet<&String> = on_branch.ids.iter().collect();
    let with_diff: Vec<&String> = patch_ids
        .iter()
        .filter(|id| !id.starts_with("sha:"))
        .collect();
    let found = with_diff.iter().filter(|id| ids.contains(*id)).count();
    let empty = patch_ids.len() - with_diff.len();
    let spare = on_branch.count.saturating_sub(on_branch.ids.len());
    found + empty.min(spare)
}
