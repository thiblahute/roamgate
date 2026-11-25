//! Branches headed upstream (`mr-reviews/upstream.ts`): the workspaces of
//! the Workspaces-tree groups marked "Headed upstream" (and the groups
//! inside them), minus those the user said are not, and the workspaces
//! marked by themselves, read from their checkouts (one cheap script per
//! connection, kept a minute; the commits only when the head or the
//! target moved). A branch whose request is open is the request's: it
//! shows no row of its own. Nothing here reads a forge; the only git fetch
//! is of the user's own requests' heads, into refs/roamgate/mr/*, when the
//! inbox says they moved (D13).

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, LazyLock, Mutex};

use regex::Regex;
use roamgate_agents::js::{self, Obj};
use roamgate_agents::paths::encode_uri_component;
use roamgate_forge::remote::{on_gitlab_host, remote_project};
use serde_json::{Value, json};

use crate::clones::Remote;
use crate::connection::{BoxFuture, MrConnection, sh_quote};
use crate::shared::types::{
    branch_key, same_upstream_workspace, upstream_workspace_home, workspace_ref_key,
};
use crate::workspace_tree::{self, Live, LiveWorkspace, ResolvedNode};
use crate::worktree::{GIT_ENV, forge_head_ref};

/// How long a connection's scan is reused.
pub const UPSTREAM_SCAN_MS: f64 = 60_000.0;
/// Commits read per branch.
pub const BRANCH_COMMITS: usize = 200;
/// Commits a row carries to the pages.
const ROW_COMMITS: usize = 50;

static SHA: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[0-9a-f]{40,64}$").expect("pattern"));

/// `UpstreamMember`: a workspace headed upstream, or an effort's part.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct UpstreamMember {
    pub connection_id: String,
    pub workspace_id: String,
    pub label: String,
    pub path: String,
    /// Its home: the marked group it is in (the nearest), or for a
    /// workspace marked by itself its `upstreamWorkspaceHome`.
    pub group: String,
    /// What an effort's part sits on, tried in order (none: the target).
    pub bases: Vec<String>,
    /// The plan an effort's part is made for.
    pub plan: Option<String>,
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

fn records(value: Option<&Value>) -> Vec<&Obj> {
    value
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_object)
        .collect()
}

fn truthy_str(value: Option<&Value>) -> Option<&str> {
    value
        .and_then(Value::as_str)
        .filter(|text| !text.is_empty())
}

/// `partBases`: what an effort's part sits on, to try in order: the base
/// it was made on, else for the plans it depends on (the last first) their
/// part's branch, the branch that part was made from, or their
/// upstream/<name> branch.
pub fn part_bases(plan: &Value, plans: &[Value]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut add = |reference: Option<&str>| {
        if let Some(reference) = reference.filter(|r| !r.is_empty())
            && !out.iter().any(|each| each == reference)
        {
            out.push(reference.to_owned());
        }
    };
    let part = |plan: &Value| plan.get("part").filter(|part| part.is_object()).cloned();
    add(part(plan)
        .as_ref()
        .and_then(|p| p.get("base"))
        .and_then(Value::as_str));
    let depends_on = strings(plan.get("dependsOn"));
    let deps: Vec<&Value> = plans
        .iter()
        .filter(|each| {
            each.get("id")
                .and_then(Value::as_str)
                .is_some_and(|id| depends_on.iter().any(|dep| dep == id))
        })
        .collect();
    for dep in deps.into_iter().rev() {
        let dep_part = part(dep);
        add(dep_part
            .as_ref()
            .and_then(|p| p.get("branch"))
            .and_then(Value::as_str));
        add(dep_part
            .as_ref()
            .and_then(|p| p.get("from"))
            .and_then(Value::as_str));
        // A template literal: a missing name reads "undefined".
        let name = dep
            .get("name")
            .map_or_else(|| "undefined".to_owned(), js::to_text);
        add(Some(&format!("upstream/{name}")));
    }
    out
}

/// `headedGroups`: the marked groups and every group below them, each
/// with the marked group it is under (the nearest), in tree order.
pub fn headed_groups(tree: &Value, marked: &[String]) -> Vec<(String, String)> {
    let mut out = Vec::new();
    for node in workspace_tree::nodes(tree) {
        if !workspace_tree::is_group(node) {
            continue;
        }
        let id = workspace_tree::node_id(node);
        if let Some(marker) = workspace_tree::ancestors(tree, Some(id))
            .into_iter()
            .find(|id| marked.contains(id))
        {
            match out
                .iter_mut()
                .find(|(each, _): &&mut (String, String)| each == id)
            {
                Some(entry) => entry.1 = marker,
                None => out.push((id.to_owned(), marker)),
            }
        }
    }
    out
}

/// Whether a workspace reference is one of the skipped ones.
fn skipped(reference: &Obj, skip: &[&Obj]) -> bool {
    let key = workspace_ref_key(reference);
    skip.iter().any(|each| {
        workspace_ref_key(each) == key
            || (each.get("connection_id") == reference.get("connection_id")
                && truthy_str(each.get("path")).is_some()
                && each.get("path") == reference.get("path"))
    })
}

/// `upstreamMembers`: the workspaces headed upstream: workspace nodes
/// under a marked group, minus the skipped, and the workspaces marked by
/// themselves (with a node of the tree or not), resolved to the live ones
/// (a connection not listed is not read). `dirs`: where a workspace
/// without a checkout of its own works, by `connection\0workspace`.
pub fn upstream_members(
    tree: &Value,
    settings: &Obj,
    live: &Live,
    dirs: &HashMap<String, String>,
) -> Vec<UpstreamMember> {
    let own = records(settings.get("upstreamWorkspaces"));
    let marked = strings(settings.get("upstreamGroups"));
    if marked.is_empty() && own.is_empty() {
        return Vec::new();
    }
    let skip = records(settings.get("upstreamSkip"));
    let groups = headed_groups(tree, &marked);
    let resolved = workspace_tree::resolve_tree(tree, live);
    let mut out: Vec<UpstreamMember> = Vec::new();
    let add =
        |out: &mut Vec<UpstreamMember>, connection_id: &str, workspace_id: &str, home: String| {
            let identity =
                live.iter()
                    .find(|(id, _)| id == connection_id)
                    .and_then(|(_, workspaces)| {
                        workspaces
                            .iter()
                            .find(|each| each.workspace_id == workspace_id)
                    });
            let Some(identity) = identity else { return };
            let path = identity.path.clone().or_else(|| {
                dirs.get(&format!("{connection_id}\u{0}{workspace_id}"))
                    .cloned()
            });
            let Some(path) = path.filter(|path| !path.is_empty()) else {
                return;
            };
            out.push(UpstreamMember {
                connection_id: connection_id.to_owned(),
                workspace_id: workspace_id.to_owned(),
                label: identity.label.clone(),
                path,
                group: home,
                ..UpstreamMember::default()
            });
        };
    for node in workspace_tree::nodes(tree) {
        if !workspace_tree::is_workspace(node) {
            continue;
        }
        let reference = workspace_tree::node_ref(node);
        let group = workspace_tree::node_parent(node)
            .filter(|parent| !parent.is_empty())
            .and_then(|parent| {
                workspace_tree::ancestors(tree, Some(parent))
                    .into_iter()
                    .find(|id| groups.iter().any(|(group, _)| group == id))
            });
        let home = match group {
            Some(group) => {
                if skipped(reference, &skip) {
                    continue;
                }
                groups
                    .iter()
                    .find(|(each, _)| *each == group)
                    .map(|(_, marker)| marker.clone())
                    .unwrap_or(group)
            }
            None => {
                let Some(mark) = own
                    .iter()
                    .find(|each| same_upstream_workspace(each, reference))
                else {
                    continue;
                };
                upstream_workspace_home(mark)
            }
        };
        if let Some(ResolvedNode::Live {
            connection_id,
            workspace_id,
        }) = resolved.nodes.get(workspace_tree::node_id(node))
        {
            add(&mut out, connection_id, workspace_id, home);
        }
    }
    // Workspaces marked by themselves that the tree has no node for.
    if !own.is_empty() {
        for (connection_id, workspaces) in live {
            for identity in workspaces {
                if resolved
                    .node_by_workspace
                    .contains_key(&workspace_tree::live_workspace_key(
                        connection_id,
                        &identity.workspace_id,
                    ))
                {
                    continue;
                }
                let reference = live_ref(connection_id, identity);
                if let Some(mark) = own
                    .iter()
                    .find(|each| same_upstream_workspace(each, &reference))
                {
                    add(
                        &mut out,
                        connection_id,
                        &identity.workspace_id,
                        upstream_workspace_home(mark),
                    );
                }
            }
        }
    }
    out
}

/// A live workspace's reference: its connection, path, label and id.
fn live_ref(connection_id: &str, identity: &LiveWorkspace) -> Obj {
    let mut reference = Obj::new();
    reference.insert("connection_id".into(), json!(connection_id));
    if let Some(path) = &identity.path {
        reference.insert("path".into(), json!(path));
    }
    if !identity.label.is_empty() {
        reference.insert("label".into(), json!(identity.label));
    }
    reference.insert("workspace_id".into(), json!(identity.workspace_id));
    reference
}

/// `upstreamScanScript`: for each directory, `W <dir>`, `B <branch>`,
/// `H <head>`, `D <dirty files>`, `P <unpushed>` and `U <remote>/<branch>`
/// (its own upstream branch), `M <name> <url>` per remote, and for
/// `upstream` then `origin`, when they have a default branch: `T <remote>
/// <ref> <sha> <behind> <ahead>`; with bases, `X <ref> <sha> <behind>
/// <ahead>` for the first of them that exists (one HEAD holds, else any).
/// Cheap: no log.
pub fn upstream_scan_script(dirs: &[String], bases: &HashMap<String, Vec<String>>) -> String {
    let mut lines: Vec<String> = [
        "scan() {",
        "  d=$1; shift",
        r#"  [ -d "$d" ] || return 0"#,
        r#"  git -C "$d" rev-parse --git-dir >/dev/null 2>&1 || return 0"#,
        r#"  printf "W\t%s\n" "$d""#,
        r#"  b=$(git -C "$d" symbolic-ref --short -q HEAD 2>/dev/null) && printf "B\t%s\n" "$b""#,
        r#"  h=$(git -C "$d" rev-parse -q --verify HEAD 2>/dev/null) && printf "H\t%s\n" "$h""#,
        r#"  printf "D\t%s\n" "$(git -C "$d" status --porcelain 2>/dev/null | wc -l | tr -d " ")""#,
        r#"  p=$(git -C "$d" rev-list --count '@{u}..HEAD' 2>/dev/null) && printf "P\t%s\n" "$p""#,
        r#"  u=$(git -C "$d" rev-parse --abbrev-ref --symbolic-full-name '@{u}' 2>/dev/null) && printf "U\t%s\n" "$u""#,
        r#"  git -C "$d" config --get-regexp '^remote\..*\.url$' 2>/dev/null | while read -r k u; do n=${k#remote.}; printf "M\t%s\t%s\n" "${n%.url}" "$u"; done"#,
        "  for r in upstream origin; do",
        r#"    git -C "$d" config --get "remote.$r.url" >/dev/null 2>&1 || continue"#,
        r#"    t=$(git -C "$d" symbolic-ref --short -q "refs/remotes/$r/HEAD" 2>/dev/null)"#,
        r#"    if [ -z "$t" ]; then for c in main master; do git -C "$d" rev-parse -q --verify "refs/remotes/$r/$c" >/dev/null 2>&1 && t="$r/$c" && break; done; fi"#,
        r#"    [ -n "$t" ] || continue"#,
        r#"    s=$(git -C "$d" rev-parse -q --verify "$t" 2>/dev/null) || continue"#,
        r#"    c=$(git -C "$d" rev-list --left-right --count "$t...HEAD" 2>/dev/null | tr "\t" " ")"#,
        r#"    printf "T\t%s\t%s\t%s\t%s\n" "$r" "$t" "$s" "$c""#,
        "  done",
        // The base: the first that HEAD holds, else the first that exists.
        r#"  x=; for b in "$@"; do git -C "$d" rev-parse -q --verify "refs/heads/$b^{commit}" >/dev/null 2>&1 && b="refs/heads/$b"; git -C "$d" rev-parse -q --verify "$b^{commit}" >/dev/null 2>&1 || continue; [ -n "$x" ] || x=$b; if git -C "$d" merge-base --is-ancestor "$b" HEAD 2>/dev/null; then x=$b; break; fi; done"#,
        r#"  if [ -n "$x" ]; then s=$(git -C "$d" rev-parse -q --verify "$x^{commit}") && c=$(git -C "$d" rev-list --left-right --count "$x...HEAD" 2>/dev/null | tr "\t" " ") && printf "X\t%s\t%s\t%s\n" "${x#refs/heads/}" "$s" "$c"; fi"#,
        "}",
    ]
    .iter()
    .map(|line| (*line).to_owned())
    .collect();
    for dir in dirs {
        let mut words = vec![sh_quote("scan"), sh_quote(dir)];
        words.extend(
            bases
                .get(dir)
                .into_iter()
                .flatten()
                .map(|base| sh_quote(base)),
        );
        lines.push(words.join(" "));
    }
    lines.push("exit 0".to_owned());
    lines.join("\n")
}

/// A ref and how far behind and ahead of it HEAD is.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Counted {
    /// The remote (targets only).
    pub remote: String,
    pub reference: String,
    pub sha: String,
    pub behind: f64,
    pub ahead: f64,
}

/// `ScannedCheckout`.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct ScannedCheckout {
    pub branch: Option<String>,
    pub head: Option<String>,
    pub dirty: f64,
    pub unpushed: Option<f64>,
    /// Its own upstream branch: `<remote>/<branch>`.
    pub upstream: Option<String>,
    /// What an effort's part sits on, counted from.
    pub base: Option<Counted>,
    pub remotes: Vec<Remote>,
    pub targets: Vec<Counted>,
}

/// Two counts, `behind ahead`, as `split(" ").map(Number)` reads them.
fn counts(text: &str) -> Option<(f64, f64)> {
    let mut parts = text.split(' ').map(js::number_from_text);
    let behind = parts.next()?;
    let ahead = parts.next()?;
    (behind.is_finite() && ahead.is_finite()).then_some((behind, ahead))
}

/// `parseUpstreamScan`: each checkout read, by directory.
pub fn parse_upstream_scan(stdout: &str) -> HashMap<String, ScannedCheckout> {
    let mut dirs: HashMap<String, ScannedCheckout> = HashMap::new();
    let mut current: Option<String> = None;
    for line in stdout.split('\n') {
        let parts: Vec<&str> = line.split('\t').collect();
        let kind = parts[0];
        let field = |at: usize| parts.get(at).copied().filter(|text| !text.is_empty());
        if kind == "W"
            && let Some(dir) = parts.get(1).filter(|dir| dir.starts_with('/'))
        {
            dirs.insert((*dir).to_owned(), ScannedCheckout::default());
            current = Some((*dir).to_owned());
            continue;
        }
        let (Some(dir), Some(a)) = (current.as_ref(), field(1)) else {
            continue;
        };
        let Some(checkout) = dirs.get_mut(dir) else {
            continue;
        };
        match kind {
            "B" => checkout.branch = Some(a.to_owned()),
            "H" if SHA.is_match(a) => checkout.head = Some(a.to_owned()),
            "D" => {
                let dirty = js::number_from_text(a);
                checkout.dirty = if dirty.is_nan() { 0.0 } else { dirty };
            }
            "P" if a.bytes().all(|b| b.is_ascii_digit()) => {
                checkout.unpushed = Some(js::number_from_text(a));
            }
            "U" => checkout.upstream = Some(a.to_owned()),
            "X" => {
                if let (Some(b), Some(c)) = (field(2).filter(|b| SHA.is_match(b)), field(3))
                    && let Some((behind, ahead)) = counts(c)
                {
                    checkout.base = Some(Counted {
                        remote: String::new(),
                        reference: a.to_owned(),
                        sha: b.to_owned(),
                        behind,
                        ahead,
                    });
                }
            }
            "M" => {
                if let Some(b) = field(2) {
                    checkout.remotes.push(Remote {
                        name: a.to_owned(),
                        url: b.to_owned(),
                    });
                }
            }
            "T" => {
                if let (Some(b), Some(c), Some(d)) = (field(2), field(3), field(4))
                    && let Some((behind, ahead)) = counts(d)
                {
                    checkout.targets.push(Counted {
                        remote: a.to_owned(),
                        reference: b.to_owned(),
                        sha: c.to_owned(),
                        behind,
                        ahead,
                    });
                }
            }
            _ => {}
        }
    }
    dirs
}

/// A checkout whose commits to read: beyond `target`, and `base`.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct CommitsWant {
    pub dir: String,
    pub target: String,
    pub base: Option<String>,
}

/// `branchCommitsScript`: the commits of each `dir target` pair beyond the
/// target, newest first: `W <dir>` then `C <sha> <author time> <subject>`
/// and `I <patch id> <sha>` lines; with a base, `O <sha>` for those beyond
/// the base too.
pub fn branch_commits_script(pairs: &[CommitsWant]) -> String {
    let mut lines: Vec<String> = Vec::new();
    for pair in pairs {
        lines.push(format!(
            "d={}; t={}",
            sh_quote(&pair.dir),
            sh_quote(&pair.target)
        ));
        lines.push(r#"printf "W\t%s\n" "$d""#.to_owned());
        lines.push(format!(
            r#"git -C "$d" log --no-merges --max-count={BRANCH_COMMITS} --format='C%x09%H%x09%at%x09%s' "$t..HEAD" 2>/dev/null"#
        ));
        lines.push(format!(
            r#"git -C "$d" log --no-merges --max-count={BRANCH_COMMITS} -p --format='commit %H' "$t..HEAD" 2>/dev/null | git -C "$d" patch-id --stable 2>/dev/null | awk '{{ print "I\t" $1 "\t" $2 }}'"#
        ));
        if let Some(base) = pair.base.as_deref().filter(|base| !base.is_empty()) {
            lines.push(format!(
                r#"git -C "$d" rev-list --no-merges --max-count={BRANCH_COMMITS} {} 2>/dev/null | awk '{{ print "O\t" $1 }}'"#,
                sh_quote(&format!("{base}..HEAD"))
            ));
        }
    }
    lines.push("exit 0".to_owned());
    lines.join("\n")
}

/// `BranchCommit`.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct BranchCommit {
    pub sha: String,
    /// The author time, seconds.
    pub at: f64,
    pub subject: String,
    pub patch_id: Option<String>,
    /// Beyond the base it sits on as well: its own (an effort's part).
    pub own: bool,
}

/// `parseBranchCommits`: each checkout's commits, by directory.
pub fn parse_branch_commits(stdout: &str) -> HashMap<String, Vec<BranchCommit>> {
    let mut out: HashMap<String, Vec<BranchCommit>> = HashMap::new();
    let mut current: Option<String> = None;
    for line in stdout.split('\n') {
        let parts: Vec<&str> = line.split('\t').collect();
        let kind = parts[0];
        let a = parts.get(1).copied().unwrap_or("");
        let b = parts.get(2).copied();
        if kind == "W" && a.starts_with('/') {
            out.insert(a.to_owned(), Vec::new());
            current = Some(a.to_owned());
            continue;
        }
        let Some(dir) = current.as_ref() else {
            continue;
        };
        if a.is_empty() {
            continue;
        }
        let Some(commits) = out.get_mut(dir) else {
            continue;
        };
        // The commit of that sha, the last listed (as a Map keeps it).
        let by_sha = |commits: &mut Vec<BranchCommit>, sha: &str| -> Option<usize> {
            commits.iter().rposition(|commit| commit.sha == sha)
        };
        match kind {
            "C" if SHA.is_match(a) => {
                let at = js::number_from_text(b.unwrap_or("undefined"));
                commits.push(BranchCommit {
                    sha: a.to_owned(),
                    at: if at.is_nan() { 0.0 } else { at },
                    subject: parts
                        .get(3..)
                        .map(|rest| rest.join("\t"))
                        .unwrap_or_default(),
                    ..BranchCommit::default()
                });
            }
            "I" => {
                if let Some(b) = b.filter(|b| !b.is_empty())
                    && let Some(at) = by_sha(commits, b)
                {
                    commits[at].patch_id = Some(a.to_owned());
                }
            }
            "O" => {
                if let Some(at) = by_sha(commits, a) {
                    commits[at].own = true;
                }
            }
            _ => {}
        }
    }
    out
}

/// The forge project a checkout's work is headed to.
#[derive(Clone, Debug, PartialEq)]
pub struct Target {
    pub provider: String,
    pub host: String,
    pub project: String,
    pub target: Counted,
}

/// `targetOf`: the first of `upstream`, `origin` whose remote is a project
/// on one of the user's hosts (`{host, provider}`), with its default
/// branch.
pub fn target_of(checkout: &ScannedCheckout, hosts: &[Value]) -> Option<Target> {
    for target in &checkout.targets {
        let Some(url) = checkout
            .remotes
            .iter()
            .find(|remote| remote.name == target.remote)
            .map(|remote| remote.url.as_str())
            .filter(|url| !url.is_empty())
        else {
            continue;
        };
        let Some(remote) = remote_project(url) else {
            continue;
        };
        let host = hosts.iter().find(|each| {
            let host = js::sv(each.get("host"));
            if js::sv(each.get("provider")) == "gitlab" {
                on_gitlab_host(&remote.host, host)
            } else {
                remote.host == host || remote.host == format!("ssh.{host}")
            }
        });
        if let Some(host) = host {
            return Some(Target {
                provider: js::sv(host.get("provider")).to_owned(),
                host: js::sv(host.get("host")).to_owned(),
                project: remote.project,
                target: target.clone(),
            });
        }
    }
    None
}

/// `UpstreamBranch`: a branch read from a member's checkout, before its
/// rows are made.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct UpstreamBranch {
    pub key: String,
    pub provider: String,
    pub host: String,
    pub project: String,
    pub branch: String,
    pub member: UpstreamMember,
    pub connection_label: String,
    pub head: String,
    pub dirty: f64,
    pub unpushed: Option<f64>,
    pub target: Counted,
    /// What an effort's part sits on (the part it depends on, say): its own
    /// commits (marked own) and how far behind are counted from there.
    pub base: Option<Counted>,
    /// Where it is pushed, on the forge (its own upstream branch's page).
    pub url: Option<String>,
    pub commits: Vec<BranchCommit>,
}

/// `pushedBranchUrl`: a branch's page on the forge, where its own upstream
/// branch is: the remote's project on the same host as the target (a
/// fork, say).
pub fn pushed_branch_url(
    upstream: Option<&str>,
    remotes: &[Remote],
    provider: &str,
    host: &str,
) -> Option<String> {
    let upstream = upstream.filter(|upstream| !upstream.is_empty())?;
    let mut sorted: Vec<&Remote> = remotes.iter().collect();
    sorted.sort_by_key(|remote| std::cmp::Reverse(js::len16(&remote.name)));
    let remote = sorted
        .into_iter()
        .find(|each| upstream.starts_with(&format!("{}/", each.name)))?;
    let project = remote_project(&remote.url);
    let name = &upstream[remote.name.len() + 1..];
    let project = project.filter(|_| !name.is_empty())?;
    let host = host.to_lowercase();
    let on_host = if provider == "gitlab" {
        on_gitlab_host(&project.host, &host)
    } else {
        project.host == host || project.host == format!("ssh.{host}")
    };
    if !on_host {
        return None;
    }
    let path: Vec<String> = name.split('/').map(encode_uri_component).collect();
    let path = path.join("/");
    Some(if provider == "gitlab" {
        format!("https://{host}/{}/-/tree/{path}", project.project)
    } else {
        format!("https://{host}/{}/tree/{path}", project.project)
    })
}

/// A branch's own commits, and the branch below it.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct OwnCommits {
    pub commits: Vec<BranchCommit>,
    pub below: Option<String>,
}

fn same_project(a: (&str, &str, &str), b: (&str, &str, &str)) -> bool {
    a.0 == b.0
        && a.1.to_lowercase() == b.1.to_lowercase()
        && a.2.to_lowercase() == b.2.to_lowercase()
}

/// `ownCommits`: a branch's own commits, newest first: beyond the base it
/// sits on (an effort's part), else those no other listed branch of the
/// project below it holds (one whose commits, by patch id, are all in this
/// one's), and the branch below it nearest, when there is one.
pub fn own_commits(branch: &UpstreamBranch, others: &[UpstreamBranch]) -> OwnCommits {
    if let Some(base) = &branch.base {
        return OwnCommits {
            commits: branch
                .commits
                .iter()
                .filter(|commit| commit.own)
                .cloned()
                .collect(),
            below: Some(base.reference.clone()),
        };
    }
    let ids: HashSet<&str> = branch
        .commits
        .iter()
        .filter_map(|commit| commit.patch_id.as_deref())
        .collect();
    if ids.is_empty() {
        return OwnCommits {
            commits: branch.commits.clone(),
            below: None,
        };
    }
    let mut below: Vec<&UpstreamBranch> = others
        .iter()
        .filter(|other| {
            other.key != branch.key
                && same_project(
                    (&other.provider, &other.host, &other.project),
                    (&branch.provider, &branch.host, &branch.project),
                )
                && !other.commits.is_empty()
                && other.commits.len() < branch.commits.len()
                && other.commits.iter().all(|commit| {
                    commit
                        .patch_id
                        .as_deref()
                        .is_some_and(|id| !id.is_empty() && ids.contains(id))
                })
        })
        .collect();
    below.sort_by_key(|other| std::cmp::Reverse(other.commits.len()));
    let Some(nearest) = below.first() else {
        return OwnCommits {
            commits: branch.commits.clone(),
            below: None,
        };
    };
    let held: HashSet<&str> = below
        .iter()
        .flat_map(|other| {
            other
                .commits
                .iter()
                .filter_map(|commit| commit.patch_id.as_deref())
        })
        .collect();
    OwnCommits {
        commits: branch
            .commits
            .iter()
            .filter(|commit| {
                commit
                    .patch_id
                    .as_deref()
                    .is_none_or(|id| id.is_empty() || !held.contains(id))
            })
            .cloned()
            .collect(),
        below: Some(nearest.branch.clone()),
    }
}

fn authored(item: &Obj) -> bool {
    item.get("reasons")
        .and_then(Value::as_array)
        .is_some_and(|reasons| reasons.iter().any(|reason| reason == "authored"))
}

/// The patch ids of the user's requests' commits, by request key.
pub type PatchIds = HashMap<String, HashSet<String>>;

/// `requestOfBranch`: the request a branch is: one of the user's on the
/// target project at the branch's head (whatever its source branch is
/// called, a fork's `upstream/<name>` say), else from that branch (or one
/// of `names`; open or merged; a closed one leaves the branch's work
/// unproposed), else one whose commits hold all of the branch's by patch
/// id. A branch with an empty head is matched by name and patch ids only.
pub fn request_of_branch<'a>(
    branch: &UpstreamBranch,
    items: impl IntoIterator<Item = &'a Obj>,
    patch_ids: &PatchIds,
    names: &[String],
) -> Option<&'a Obj> {
    let own: Vec<&Obj> = items
        .into_iter()
        .filter(|item| {
            authored(item)
                && same_project(
                    (
                        js::sv(item.get("provider")),
                        js::sv(item.get("host")),
                        js::sv(item.get("project")),
                    ),
                    (&branch.provider, &branch.host, &branch.project),
                )
                && item.get("state").and_then(Value::as_str) != Some("closed")
        })
        .collect();
    if !branch.head.is_empty()
        && let Some(found) = own
            .iter()
            .find(|item| item.get("headSha").and_then(Value::as_str) == Some(branch.head.as_str()))
    {
        return Some(found);
    }
    let source = |item: &Obj| {
        item.get("sourceBranch")
            .and_then(Value::as_str)
            .map(str::to_owned)
    };
    if let Some(found) = own
        .iter()
        .find(|item| source(item).as_deref() == Some(branch.branch.as_str()))
        .or_else(|| {
            own.iter()
                .find(|item| source(item).is_some_and(|name| names.contains(&name)))
        })
    {
        return Some(found);
    }
    let ids: Vec<&str> = branch
        .commits
        .iter()
        .filter_map(|commit| commit.patch_id.as_deref().filter(|id| !id.is_empty()))
        .collect();
    if ids.is_empty() || ids.len() != branch.commits.len() {
        return None;
    }
    own.into_iter().find(|item| {
        patch_ids
            .get(js::sv(item.get("key")))
            .is_some_and(|held| ids.iter().all(|id| held.contains(*id)))
    })
}

/// `branchEntry`: a branch's row in the inbox (own work, lane Not proposed
/// upstream yet), as Bun builds it. `others`: the other branches read (one
/// below it holds commits not its own).
pub fn branch_entry(
    branch: &UpstreamBranch,
    settings: &Obj,
    user: &str,
    others: &[UpstreamBranch],
) -> Obj {
    let unsent = records(settings.get("unsent"))
        .into_iter()
        .find(|each| each.get("key").and_then(Value::as_str) == Some(branch.key.as_str()));
    let own = own_commits(branch, others);
    let oldest = own.commits.last();
    let newest = branch.commits.first();
    let below = own.below.as_deref().filter(|below| !below.is_empty());
    let mut info = Obj::new();
    info.insert("name".into(), json!(branch.branch));
    info.insert("connectionId".into(), json!(branch.member.connection_id));
    info.insert("connectionLabel".into(), json!(branch.connection_label));
    info.insert("workspaceId".into(), json!(branch.member.workspace_id));
    info.insert("workspaceLabel".into(), json!(branch.member.label));
    info.insert("path".into(), json!(branch.member.path));
    info.insert(
        "target".into(),
        json!(
            branch
                .base
                .as_ref()
                .map_or(&branch.target.reference, |base| &base.reference)
        ),
    );
    let ahead = match &branch.base {
        Some(base) => base.ahead,
        None if below.is_some() => own.commits.len() as f64,
        None => branch.target.ahead,
    };
    info.insert("ahead".into(), js::number(ahead));
    info.insert(
        "behind".into(),
        js::number(
            branch
                .base
                .as_ref()
                .map_or(branch.target.behind, |base| base.behind),
        ),
    );
    if let Some(below) = below {
        info.insert("below".into(), json!(below));
    }
    if let Some(url) = &branch.url {
        info.insert("url".into(), json!(url));
    }
    info.insert("dirty".into(), js::number(branch.dirty));
    if let Some(unpushed) = branch.unpushed {
        info.insert("unpushed".into(), js::number(unpushed));
    }
    let commits: Vec<Value> = own
        .commits
        .iter()
        .take(ROW_COMMITS)
        .map(|commit| json!({"sha": commit.sha, "subject": commit.subject, "at": js::iso(commit.at * 1000.0)}))
        .collect();
    info.insert("commits".into(), Value::Array(commits));
    info.insert("group".into(), json!(branch.member.group));
    let title = [
        unsent.and_then(|unsent| truthy_str(unsent.get("title"))),
        oldest
            .map(|commit| commit.subject.as_str())
            .filter(|s| !s.is_empty()),
        branch
            .member
            .plan
            .as_deref()
            .filter(|plan| !plan.is_empty()),
    ]
    .into_iter()
    .flatten()
    .next()
    .unwrap_or(&branch.branch);
    let target_branch = unsent
        .and_then(|unsent| unsent.get("target"))
        .filter(|target| !target.is_null())
        .cloned()
        .unwrap_or_else(|| {
            let reference = &branch.target.reference;
            json!(match reference.find('/') {
                Some(at) => &reference[at + 1..],
                None => reference.as_str(),
            })
        });
    let mut entry = Obj::new();
    entry.insert("provider".into(), json!(branch.provider));
    entry.insert("host".into(), json!(branch.host));
    entry.insert("project".into(), json!(branch.project));
    entry.insert("number".into(), json!(0));
    entry.insert("key".into(), json!(branch.key));
    entry.insert("url".into(), json!(""));
    entry.insert("title".into(), json!(title));
    entry.insert("author".into(), json!(user));
    entry.insert("draft".into(), json!(false));
    entry.insert("state".into(), json!("open"));
    entry.insert(
        "updatedAt".into(),
        json!(newest.map_or_else(String::new, |commit| js::iso(commit.at * 1000.0))),
    );
    entry.insert("headSha".into(), json!(branch.head));
    entry.insert("sourceBranch".into(), json!(branch.branch));
    entry.insert("targetBranch".into(), target_branch);
    entry.insert("pipeline".into(), Value::Null);
    entry.insert("notes".into(), json!(0));
    entry.insert("reasons".into(), json!(["authored"]));
    entry.insert("section".into(), json!("authored"));
    entry.insert("unread".into(), Value::Null);
    entry.insert("isNew".into(), json!(false));
    entry.insert("branch".into(), Value::Object(info));
    if unsent.is_some() {
        entry.insert("unsent".into(), json!(true));
    }
    entry
}

/// `readLiveWorkspaces`: the workspaces Herdr lists on each connection (a
/// connection that does not answer is left out), with where those without
/// a checkout of their own work (their first pane's folder), by
/// `connection\0workspace`.
pub async fn read_live_workspaces(
    connections: &[Arc<dyn MrConnection>],
) -> (Live, HashMap<String, String>) {
    let mut live: Live = Vec::new();
    let mut dirs: HashMap<String, String> = HashMap::new();
    for connection in connections {
        let listed = connection.herdr("workspace.list", Value::Null);
        let panes = connection.herdr("pane.list", Value::Null);
        let (listed, panes) = futures_util::future::join(listed, panes).await;
        // Not read: its workspaces show as they were last.
        let Ok(listed) = listed else { continue };
        // Herdr gives a worktree's checkout; any other workspace is where
        // its first pane is (the tree names it by its label then, as the
        // pages do).
        for pane in panes
            .ok()
            .as_ref()
            .and_then(|panes| panes.get("panes"))
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            let dir =
                truthy_str(pane.get("cwd")).or_else(|| truthy_str(pane.get("foreground_cwd")));
            let Some(workspace_id) = truthy_str(pane.get("workspace_id")) else {
                continue;
            };
            let key = format!("{}\u{0}{workspace_id}", connection.id());
            if let Some(dir) = dir.filter(|dir| dir.starts_with('/'))
                && !dirs.contains_key(&key)
            {
                dirs.insert(key, dir.to_owned());
            }
        }
        let workspaces: Vec<LiveWorkspace> = listed
            .get("workspaces")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter(|each| each.get("workspace_id").is_some_and(Value::is_string))
            .map(workspace_tree::workspace_identity)
            .collect();
        match live.iter_mut().find(|(id, _)| id == connection.id()) {
            Some(entry) => entry.1 = workspaces,
            None => live.push((connection.id().to_owned(), workspaces)),
        }
    }
    (live, dirs)
}

/// A branch's commits as read: by its checkout, head, target and base.
fn commits_key(path: &str, head: &str, base: Option<&Counted>, target: &str) -> String {
    format!(
        "{path}\u{0}{head}\u{0}{target}\u{0}{}",
        base.map_or("", |base| base.sha.as_str())
    )
}

/// `requestPatchIdsScript`: fetches the user's open requests' heads of a
/// branch's target project into refs/roamgate/mr/<number> when the local
/// ref is not at the head the inbox knows (D13), then prints `R <key>` and
/// the patch ids of the request's commits beyond the target
/// (`I <patch id>`).
pub fn request_patch_ids_script(
    dir: &str,
    remote: &str,
    target: &str,
    requests: &[PatchIdsWant],
) -> String {
    let mut lines = vec![
        format!(
            "d={}; r={}; t={}",
            sh_quote(dir),
            sh_quote(remote),
            sh_quote(target)
        ),
        GIT_ENV.to_owned(),
    ];
    for request in requests {
        let local = format!("refs/roamgate/mr/{}", request.number);
        lines.push(format!(
            r#"if [ "$(git -C "$d" rev-parse -q --verify {local} 2>/dev/null)" != {} ]; then git -C "$d" fetch -q --no-tags "$r" {} >/dev/null 2>&1; fi"#,
            sh_quote(&request.head),
            sh_quote(&format!(
                "+{}:{local}",
                forge_head_ref(&request.provider, request.number)
            ))
        ));
        lines.push(format!(r#"printf "R\t%s\n" {}"#, sh_quote(&request.key)));
        lines.push(format!(
            r#"git -C "$d" log --no-merges --max-count={BRANCH_COMMITS} -p --format='commit %H' "$t..{local}" 2>/dev/null | git -C "$d" patch-id --stable 2>/dev/null | awk '{{ print "I\t" $1 }}'"#
        ));
    }
    lines.push("exit 0".to_owned());
    lines.join("\n")
}

/// A request whose patch ids to read.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct PatchIdsWant {
    pub key: String,
    pub provider: String,
    pub number: u64,
    pub head: String,
}

/// `parseRequestPatchIds`.
pub fn parse_request_patch_ids(stdout: &str) -> PatchIds {
    let mut out = PatchIds::new();
    let mut current: Option<String> = None;
    for line in stdout.split('\n') {
        let mut parts = line.split('\t');
        let kind = parts.next().unwrap_or("");
        let Some(value) = parts.next().filter(|value| !value.is_empty()) else {
            continue;
        };
        if kind == "R" {
            out.insert(value.to_owned(), HashSet::new());
            current = Some(value.to_owned());
        } else if kind == "I"
            && let Some(set) = current.as_ref().and_then(|key| out.get_mut(key))
        {
            set.insert(value.to_owned());
        }
    }
    out
}

pub type ConnectionsFn = Arc<dyn Fn() -> Vec<Arc<dyn MrConnection>> + Send + Sync>;
pub type TreeFn = Arc<dyn Fn() -> BoxFuture<'static, Result<Value, String>> + Send + Sync>;
pub type SettingsFn = Arc<dyn Fn() -> BoxFuture<'static, Result<Obj, String>> + Send + Sync>;
pub type ItemsFn = Arc<dyn Fn() -> Vec<Obj> + Send + Sync>;
pub type PartsFn = Arc<dyn Fn(&Obj) -> Vec<UpstreamMember> + Send + Sync>;

#[derive(Default)]
struct ScanState {
    branches: Vec<UpstreamBranch>,
    members: Vec<UpstreamMember>,
    at: f64,
    /// Commits by `dir\0head\0target\0base`.
    commits: HashMap<String, Vec<BranchCommit>>,
    /// The patch ids of the user's requests' commits, by key, at a head.
    request_ids: HashMap<String, (String, HashSet<String>)>,
}

/// `createUpstreamScanner`: reads the members' branches, each connection
/// at most every UPSTREAM_SCAN_MS, the commits only when a head or a
/// target moved.
pub struct UpstreamScanner {
    pub connections: ConnectionsFn,
    pub tree: TreeFn,
    pub settings: SettingsFn,
    /// The inbox's requests: a branch's own request covers it.
    pub items: Option<ItemsFn>,
    /// The efforts' parts' checkouts, read as well wherever they sit in the
    /// Workspaces tree (under the effort's head workspace, say), with their
    /// effort's group as home.
    pub parts: Option<PartsFn>,
    pub now: Arc<dyn Fn() -> f64 + Send + Sync>,
    state: Mutex<ScanState>,
    running: tokio::sync::Mutex<()>,
}

impl UpstreamScanner {
    pub fn new(connections: ConnectionsFn, tree: TreeFn, settings: SettingsFn) -> Self {
        UpstreamScanner {
            connections,
            tree,
            settings,
            items: None,
            parts: None,
            now: Arc::new(js::now_ms),
            state: Mutex::new(ScanState::default()),
            running: tokio::sync::Mutex::new(()),
        }
    }

    fn state(&self) -> std::sync::MutexGuard<'_, ScanState> {
        self.state.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// The branches as last read.
    pub fn branches(&self) -> Vec<UpstreamBranch> {
        self.state().branches.clone()
    }

    /// The workspaces headed upstream as last read.
    pub fn members(&self) -> Vec<UpstreamMember> {
        self.state().members.clone()
    }

    /// Every workspace Herdr lists on the connections, read now.
    pub async fn live(&self) -> (Live, HashMap<String, String>) {
        read_live_workspaces(&(self.connections)()).await
    }

    /// Branches and members as a scan would leave them, for tests.
    #[cfg(test)]
    pub fn seed(&self, branches: Vec<UpstreamBranch>, members: Vec<UpstreamMember>) {
        let mut state = self.state();
        state.branches = branches;
        state.members = members;
    }

    /// The user's requests' patch ids read for linking, by key.
    pub fn patch_ids(&self) -> PatchIds {
        self.state()
            .request_ids
            .iter()
            .map(|(key, (_, ids))| (key.clone(), ids.clone()))
            .collect()
    }

    /// Whether [`UpstreamScanner::refresh`] would read no checkout now:
    /// read within UPSTREAM_SCAN_MS, or nothing marked and no effort's
    /// part (`has_parts`) to read.
    pub fn quick(&self, settings: &Obj, has_parts: bool) -> bool {
        let empty = |key: &str| {
            settings
                .get(key)
                .and_then(Value::as_array)
                .is_none_or(|list| list.is_empty())
        };
        (self.now)() - self.state().at < UPSTREAM_SCAN_MS
            || (empty("upstreamGroups") && empty("upstreamWorkspaces") && !has_parts)
    }

    /// Reads them again unless read within UPSTREAM_SCAN_MS (or forced); a
    /// call while a scan runs waits for that scan.
    pub async fn refresh(&self, force: bool) {
        let Ok(_running) = self.running.try_lock() else {
            let _ = self.running.lock().await;
            return;
        };
        {
            let mut state = self.state();
            let now = (self.now)();
            if !force && now - state.at < UPSTREAM_SCAN_MS {
                return;
            }
            state.at = now;
        }
        self.scan().await;
    }

    /// For branches no request names, the patch ids of the user's open
    /// requests on their project, read from the branch's clone (their
    /// heads fetched there only when they moved).
    async fn read_request_ids(&self, connection: &dyn MrConnection, found: &[UpstreamBranch]) {
        let items = self.items.as_ref().map(|items| items()).unwrap_or_default();
        for branch in found {
            if request_of_branch(branch, &items, &self.patch_ids(), &[]).is_some() {
                continue;
            }
            let candidates: Vec<&Obj> = {
                let state = self.state();
                items
                    .iter()
                    .filter(|item| {
                        let head = js::sv(item.get("headSha"));
                        authored(item)
                            && item.get("state").and_then(Value::as_str) == Some("open")
                            && same_project(
                                (
                                    js::sv(item.get("provider")),
                                    js::sv(item.get("host")),
                                    js::sv(item.get("project")),
                                ),
                                (&branch.provider, &branch.host, &branch.project),
                            )
                            && !head.is_empty()
                            && state
                                .request_ids
                                .get(js::sv(item.get("key")))
                                .is_none_or(|(known, _)| known != head)
                    })
                    .collect()
            };
            if candidates.is_empty() {
                continue;
            }
            let reference = &branch.target.reference;
            // `slice(0, indexOf("/"))`: all but the last unit without one.
            let remote = match reference.find('/') {
                Some(at) => reference[..at].to_owned(),
                None => js::slice16(reference, 0, Some(-1)),
            };
            let chosen: Vec<&Obj> = candidates.into_iter().take(20).collect();
            let wants: Vec<PatchIdsWant> = chosen
                .iter()
                .map(|item| PatchIdsWant {
                    key: js::sv(item.get("key")).to_owned(),
                    provider: js::sv(item.get("provider")).to_owned(),
                    number: item.get("number").and_then(Value::as_u64).unwrap_or(0),
                    head: js::sv(item.get("headSha")).to_owned(),
                })
                .collect();
            let script = request_patch_ids_script(&branch.member.path, &remote, reference, &wants);
            let read = parse_request_patch_ids(&connection.run(&script, 120_000).await.stdout);
            let mut state = self.state();
            for want in wants {
                let ids = read.get(&want.key).cloned().unwrap_or_default();
                state.request_ids.insert(want.key, (want.head, ids));
            }
        }
    }

    async fn scan(&self) {
        let Ok(settings) = (self.settings)().await else {
            return;
        };
        let parts = self
            .parts
            .as_ref()
            .map(|parts| parts(&settings))
            .unwrap_or_default();
        let empty = |key: &str| {
            settings
                .get(key)
                .and_then(Value::as_array)
                .is_none_or(|list| list.is_empty())
        };
        if empty("upstreamGroups") && empty("upstreamWorkspaces") && parts.is_empty() {
            self.state().branches = Vec::new();
            return;
        }
        let Ok(tree) = (self.tree)().await else {
            return;
        };
        let connections = (self.connections)();
        let (live, dirs) = read_live_workspaces(&connections).await;
        let members = upstream_members(&tree, &settings, &live, &dirs);
        self.state().members = members.clone();
        let mut known: HashSet<String> = members
            .iter()
            .map(|member| format!("{}\u{0}{}", member.connection_id, member.path))
            .collect();
        let mut read = members;
        for part in parts {
            let id = format!("{}\u{0}{}", part.connection_id, part.path);
            if known.contains(&id) {
                // Marked by itself as well: still the part, on its base.
                if let Some(member) = read.iter_mut().find(|member| {
                    member.connection_id == part.connection_id && member.path == part.path
                }) && (!part.bases.is_empty()
                    || part.plan.as_deref().is_some_and(|p| !p.is_empty()))
                {
                    if !part.bases.is_empty() {
                        member.bases = part.bases.clone();
                    }
                    if let Some(plan) = part.plan.as_deref().filter(|p| !p.is_empty()) {
                        member.plan = Some(plan.to_owned());
                    }
                }
                continue;
            }
            known.insert(id);
            let label = live
                .iter()
                .find(|(id, _)| *id == part.connection_id)
                .and_then(|(_, workspaces)| {
                    workspaces
                        .iter()
                        .find(|each| each.workspace_id == part.workspace_id)
                })
                .map(|identity| identity.label.clone())
                .filter(|label| !label.is_empty());
            read.push(match label {
                Some(label) => UpstreamMember { label, ..part },
                None => part,
            });
        }
        let hosts: Vec<Value> = settings
            .get("hosts")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let mut next: Vec<UpstreamBranch> = Vec::new();
        for connection in &connections {
            let mine: Vec<&UpstreamMember> = read
                .iter()
                .filter(|member| member.connection_id == connection.id())
                .collect();
            if mine.is_empty() {
                continue;
            }
            let mut dirs: Vec<String> = Vec::new();
            let mut bases: HashMap<String, Vec<String>> = HashMap::new();
            for member in &mine {
                if !dirs.contains(&member.path) {
                    dirs.push(member.path.clone());
                }
                if !member.bases.is_empty() {
                    bases.insert(member.path.clone(), member.bases.clone());
                }
            }
            let scanned = parse_upstream_scan(
                &connection
                    .run(&upstream_scan_script(&dirs, &bases), 30_000)
                    .await
                    .stdout,
            );
            let mut wanted: Vec<(CommitsWant, String)> = Vec::new();
            let mut found: Vec<(&UpstreamMember, &ScannedCheckout, Target)> = Vec::new();
            for member in &mine {
                let Some(checkout) = scanned.get(&member.path) else {
                    continue;
                };
                let (Some(_), Some(head)) = (&checkout.branch, &checkout.head) else {
                    continue;
                };
                let Some(target) = target_of(checkout, &hosts) else {
                    continue;
                };
                if target.target.ahead == 0.0 || target.target.ahead.is_nan() {
                    continue;
                }
                let cache = commits_key(
                    &member.path,
                    head,
                    checkout.base.as_ref(),
                    &target.target.sha,
                );
                if !self.state().commits.contains_key(&cache) {
                    wanted.push((
                        CommitsWant {
                            dir: member.path.clone(),
                            target: target.target.reference.clone(),
                            base: checkout.base.as_ref().map(|base| base.sha.clone()),
                        },
                        cache,
                    ));
                }
                found.push((member, checkout, target));
            }
            if !wanted.is_empty() {
                let pairs: Vec<CommitsWant> = wanted.iter().map(|(want, _)| want.clone()).collect();
                let read = parse_branch_commits(
                    &connection
                        .run(&branch_commits_script(&pairs), 120_000)
                        .await
                        .stdout,
                );
                let mut state = self.state();
                for (want, cache) in wanted {
                    state
                        .commits
                        .insert(cache, read.get(&want.dir).cloned().unwrap_or_default());
                }
            }
            let before = next.len();
            for (member, checkout, target) in found {
                let head = checkout.head.clone().unwrap_or_default();
                let branch = checkout.branch.clone().unwrap_or_default();
                let commits = self
                    .state()
                    .commits
                    .get(&commits_key(
                        &member.path,
                        &head,
                        checkout.base.as_ref(),
                        &target.target.sha,
                    ))
                    .cloned()
                    .unwrap_or_default();
                let url = pushed_branch_url(
                    checkout.upstream.as_deref(),
                    &checkout.remotes,
                    &target.provider,
                    &target.host,
                );
                next.push(UpstreamBranch {
                    key: branch_key(&target.provider, &target.host, &target.project, &branch),
                    provider: target.provider,
                    host: target.host,
                    project: target.project,
                    branch,
                    member: member.clone(),
                    connection_label: connection.label().to_owned(),
                    head,
                    dirty: checkout.dirty,
                    unpushed: checkout.unpushed,
                    target: target.target,
                    base: checkout.base.clone(),
                    url,
                    commits,
                });
            }
            let fresh = next[before..].to_vec();
            self.read_request_ids(connection.as_ref(), &fresh).await;
        }
        // A cache entry no branch uses any more goes.
        let used: HashSet<String> = next
            .iter()
            .map(|branch| {
                commits_key(
                    &branch.member.path,
                    &branch.head,
                    branch.base.as_ref(),
                    &branch.target.sha,
                )
            })
            .collect();
        let mut state = self.state();
        state.commits.retain(|key, _| used.contains(key));
        state.branches = next;
    }
}

#[cfg(test)]
// Some of its tests run on Unix only (POSIX clone paths).
#[cfg_attr(not(unix), allow(dead_code, unused_imports))]
mod tests {
    //! `upstream.test.ts` (its tests through the module wait for module.ts).

    use std::path::Path;

    use super::*;
    use crate::connection::fixture::{FORGE_HOST, GitFixture, LocalConnection, Workspace};
    use crate::effort_board::effort_plan_entries;
    use crate::settings::mr_reviews_settings;

    fn obj(value: Value) -> Obj {
        match value {
            Value::Object(map) => map,
            _ => Obj::new(),
        }
    }

    fn tree(workspaces: &[(&str, &str, &str)]) -> Value {
        let mut nodes = vec![
            json!({"id": "g1", "kind": "group", "parent": null, "label": "Upstream"}),
            json!({"id": "g2", "kind": "group", "parent": "g1", "label": "Media"}),
            json!({"id": "g3", "kind": "group", "parent": null, "label": "Other"}),
        ];
        for (id, parent, label) in workspaces {
            nodes.push(json!({"id": id, "kind": "workspace", "parent": parent, "ref": {"connection_id": "local", "label": label}}));
        }
        json!({"version": 1, "nodes": nodes})
    }

    fn live_of(names: &[&str], with_path: impl Fn(&str) -> bool) -> Live {
        vec![(
            "local".to_owned(),
            names
                .iter()
                .map(|name| LiveWorkspace {
                    workspace_id: format!("w-{name}"),
                    label: (*name).to_owned(),
                    path: with_path(name).then(|| format!("/{name}")),
                })
                .collect(),
        )]
    }

    fn groups_of(members: &[UpstreamMember]) -> Vec<(String, String)> {
        members
            .iter()
            .map(|member| (member.workspace_id.clone(), member.group.clone()))
            .collect()
    }

    fn pairs(list: &[(&str, &str)]) -> Vec<(String, String)> {
        list.iter()
            .map(|(a, b)| ((*a).to_owned(), (*b).to_owned()))
            .collect()
    }

    #[test]
    fn members_under_a_marked_group_nested_groups_too_minus_the_skipped() {
        let t = tree(&[
            ("a", "g1", "a"),
            ("b", "g2", "b"),
            ("c", "g3", "c"),
            ("d", "g2", "d"),
        ]);
        assert_eq!(
            headed_groups(&t, &["g1".to_owned()]),
            pairs(&[("g1", "g1"), ("g2", "g1")])
        );
        let live = live_of(&["a", "b", "c", "d"], |_| false);
        let dirs: HashMap<String, String> = ["a", "b", "c", "d"]
            .iter()
            .map(|name| (format!("local\u{0}w-{name}"), format!("/{name}")))
            .collect();
        let settings = obj(json!({
            "upstreamGroups": ["g1"],
            "upstreamSkip": [{"connection_id": "local", "label": "d"}],
        }));
        assert_eq!(
            groups_of(&upstream_members(&t, &settings, &live, &dirs)),
            pairs(&[("w-a", "g1"), ("w-b", "g1")])
        );
        let none = obj(json!({"upstreamGroups": [], "upstreamSkip": []}));
        assert!(upstream_members(&t, &none, &live, &HashMap::new()).is_empty());
    }

    #[test]
    fn members_a_workspace_headed_upstream_by_itself_with_a_node_or_none() {
        let t = tree(&[("a", "g1", "a"), ("b", "g3", "b")]);
        // The tree's nodes name a and b by their label.
        let live = live_of(&["a", "b", "c", "d"], |name| name != "a" && name != "b");
        let dirs: HashMap<String, String> = [
            ("local\u{0}w-a".to_owned(), "/a".to_owned()),
            ("local\u{0}w-b".to_owned(), "/b".to_owned()),
        ]
        .into();
        let b = obj(json!({"connection_id": "local", "label": "b"}));
        let c = obj(json!({"connection_id": "local", "path": "/c", "label": "c"}));
        let settings =
            obj(json!({"upstreamGroups": [], "upstreamSkip": [], "upstreamWorkspaces": [b, c]}));
        assert_eq!(
            groups_of(&upstream_members(&t, &settings, &live, &dirs)),
            vec![
                ("w-b".to_owned(), upstream_workspace_home(&b)),
                ("w-c".to_owned(), upstream_workspace_home(&c)),
            ]
        );
        // In a marked group, the group is its home.
        let settings = obj(json!({
            "upstreamGroups": ["g1"],
            "upstreamSkip": [],
            "upstreamWorkspaces": [{"connection_id": "local", "label": "a"}],
        }));
        assert_eq!(
            groups_of(&upstream_members(&t, &settings, &live, &dirs)),
            pairs(&[("w-a", "g1")])
        );
        assert!(
            Regex::new("^ws-[0-9a-f]{16}$")
                .unwrap()
                .is_match(&upstream_workspace_home(&c))
        );
    }

    fn own(n: u64, extra: Value) -> Obj {
        let mut item = obj(json!({
            "provider": "gitlab",
            "host": FORGE_HOST,
            "project": "media/engine",
            "number": n,
            "key": format!("gitlab:{FORGE_HOST}/media/engine#{n}"),
            "url": format!("https://{FORGE_HOST}/media/engine/-/merge_requests/{n}"),
            "title": format!("MR {n}"),
            "author": "me",
            "draft": false,
            "state": "open",
            "updatedAt": js::iso(js::now_ms()),
            "headSha": "",
            "sourceBranch": format!("b{n}"),
            "targetBranch": "main",
            "pipeline": "success",
            "notes": 0,
            "reasons": ["authored"],
        }));
        for (key, value) in obj(extra) {
            item.insert(key, value);
        }
        item
    }

    fn run(connection: &LocalConnection, script: &str) -> String {
        futures_util::FutureExt::now_or_never(connection.run(script, 0))
            .expect("ready")
            .stdout
    }

    fn path(dir: &Path) -> String {
        dir.display().to_string()
    }

    #[test]
    // Unix only: merge request clones and worktrees are found by POSIX
    // paths (as the Bun server did); a Windows machine's are not yet.
    #[cfg(unix)]
    fn a_checkouts_branch_target_commits_and_a_requests_patch_ids_from_real_git() {
        let g = GitFixture::new();
        let bare = g.project("media/engine");
        let clone = g.clone("media/engine", "engine");
        // A request on the forge: one commit on top of main.
        let work = g.clone("media/engine", "theirs");
        g.git(&work, &["checkout", "-q", "-b", "mr7"]);
        g.commit(&work, "fix.c", "int fixed;\n", "Fix the pool", None);
        let head7 = g.git(&work, &["rev-parse", "HEAD"]).trim().to_owned();
        g.git(
            &work,
            &[
                "push",
                "-q",
                bare.to_str().unwrap(),
                "HEAD:refs/merge-requests/7/head",
            ],
        );
        // Here: a feature branch, and the same fix under another sha.
        g.git(&clone, &["checkout", "-q", "-b", "feature"]);
        g.commit(&clone, "a.c", "a\n", "Add a", None);
        g.commit(&clone, "b.c", "b\n", "Add b", None);
        g.commit(&clone, "dirty.c", "x\n", "Add dirty", None);
        std::fs::write(clone.join("dirty.c"), "changed\n").unwrap();
        let sh = g.connection(Vec::new(), "local");
        let scan = parse_upstream_scan(&run(
            &sh,
            &upstream_scan_script(&[path(&clone), "/nowhere".into()], &HashMap::new()),
        ));
        let checkout = &scan[&path(&clone)];
        assert!(!scan.contains_key("/nowhere"));
        assert_eq!(checkout.branch.as_deref(), Some("feature"));
        assert_eq!(checkout.dirty, 1.0);
        assert_eq!(
            checkout.targets,
            vec![Counted {
                remote: "origin".into(),
                reference: "origin/main".into(),
                sha: g
                    .git(&clone, &["rev-parse", "origin/main"])
                    .trim()
                    .to_owned(),
                behind: 0.0,
                ahead: 3.0,
            }]
        );
        let hosts = vec![json!({"host": FORGE_HOST, "provider": "gitlab"})];
        let target = target_of(checkout, &hosts).unwrap();
        assert_eq!(
            (
                target.provider.as_str(),
                target.host.as_str(),
                target.project.as_str()
            ),
            ("gitlab", FORGE_HOST, "media/engine")
        );
        assert!(
            target_of(
                checkout,
                &[json!({"host": "other.org", "provider": "gitlab"})]
            )
            .is_none()
        );

        g.git(
            &clone,
            &["checkout", "-q", "-f", "-b", "fix", "origin/main"],
        );
        g.commit(&clone, "fix.c", "int fixed;\n", "Fix the pool (mine)", None);
        let commits = parse_branch_commits(&run(
            &sh,
            &branch_commits_script(&[CommitsWant {
                dir: path(&clone),
                target: "origin/main".into(),
                base: None,
            }]),
        ))
        .remove(&path(&clone))
        .unwrap();
        assert_eq!(
            commits
                .iter()
                .map(|c| c.subject.as_str())
                .collect::<Vec<_>>(),
            vec!["Fix the pool (mine)"]
        );
        let patch = commits[0].patch_id.clone().unwrap();
        assert!(Regex::new("^[0-9a-f]{40}$").unwrap().is_match(&patch));

        let request = PatchIdsWant {
            key: js::sv(own(7, json!({})).get("key")).to_owned(),
            provider: "gitlab".into(),
            number: 7,
            head: head7.clone(),
        };
        let ids = parse_request_patch_ids(&run(
            &sh,
            &request_patch_ids_script(
                &path(&clone),
                "origin",
                "origin/main",
                std::slice::from_ref(&request),
            ),
        ));
        assert_eq!(
            ids[&request.key].iter().cloned().collect::<Vec<_>>(),
            vec![patch.clone()]
        );
        assert_eq!(
            g.git(&clone, &["rev-parse", "refs/roamgate/mr/7"]).trim(),
            head7
        );
        // At that head already: no fetch (the forge may be gone), same answer.
        std::fs::remove_dir_all(&bare).unwrap();
        assert_eq!(
            parse_request_patch_ids(&run(
                &sh,
                &request_patch_ids_script(
                    &path(&clone),
                    "origin",
                    "origin/main",
                    std::slice::from_ref(&request)
                ),
            )),
            ids
        );

        let branch = UpstreamBranch {
            provider: "gitlab".into(),
            host: FORGE_HOST.into(),
            project: "media/engine".into(),
            branch: "fix".into(),
            commits,
            ..UpstreamBranch::default()
        };
        let number = |found: Option<&Obj>| {
            found
                .and_then(|item| item.get("number"))
                .and_then(Value::as_u64)
        };
        // By patch id: the request holds every commit of the branch.
        assert_eq!(
            number(request_of_branch(&branch, &[own(7, json!({}))], &ids, &[])),
            Some(7)
        );
        // By name first; a closed one leaves the work unproposed.
        assert_eq!(
            number(request_of_branch(
                &branch,
                &[own(8, json!({"sourceBranch": "fix"}))],
                &PatchIds::new(),
                &[]
            )),
            Some(8)
        );
        assert!(
            request_of_branch(
                &branch,
                &[own(8, json!({"sourceBranch": "fix", "state": "closed"}))],
                &PatchIds::new(),
                &[]
            )
            .is_none()
        );
        assert!(request_of_branch(&branch, &[own(7, json!({}))], &PatchIds::new(), &[]).is_none());
    }

    fn scanner(
        connection: Arc<LocalConnection>,
        tree: Value,
        settings: Obj,
        items: Vec<Obj>,
        parts: Vec<UpstreamMember>,
    ) -> UpstreamScanner {
        let connections: ConnectionsFn =
            Arc::new(move || vec![connection.clone() as Arc<dyn MrConnection>]);
        let mut scanner = UpstreamScanner::new(
            connections,
            Arc::new(move || {
                let tree = tree.clone();
                Box::pin(async move { Ok(tree) })
            }),
            Arc::new(move || {
                let settings = settings.clone();
                Box::pin(async move { Ok(settings) })
            }),
        );
        scanner.items = Some(Arc::new(move || items.clone()));
        if !parts.is_empty() {
            scanner.parts = Some(Arc::new(move |_: &Obj| parts.clone()));
        }
        scanner
    }

    fn workspace(id: &str, label: &str, cwd: &Path) -> Workspace {
        Workspace {
            workspace_id: id.into(),
            label: label.into(),
            cwd: path(cwd),
        }
    }

    #[tokio::test]
    // Unix only: merge request clones and worktrees are found by POSIX
    // paths (as the Bun server did); a Windows machine's are not yet.
    #[cfg(unix)]
    async fn a_part_nested_under_its_efforts_head_workspace_links_to_its_fork_request_at_the_same_head()
     {
        let g = GitFixture::new();
        g.project("media/engine");
        let head = g.clone("media/engine", "upstreaming");
        let clone = g.clone("media/engine", "part");
        // The part's branch X, pushed to the fork as upstream/X (#591 on GitHub).
        g.git(&clone, &["checkout", "-q", "-b", "pr-badge-fork-remote"]);
        let tip = g.commit(&clone, "a.c", "a\n", "Find a branch's request", None);
        let connection = Arc::new(g.connection(
            vec![
                workspace("w-head", "upstreaming", &head),
                workspace("w-part", "pr-badge-fork-remote", &clone),
            ],
            "local",
        ));
        // Only the head workspace is marked; the part sits under it in the tree.
        let home = upstream_workspace_home(&obj(
            json!({"connection_id": "local", "path": path(&head), "workspace_id": "w-head"}),
        ));
        let settings = mr_reviews_settings(Some(&obj(json!({
            "hosts": [{"host": FORGE_HOST, "provider": "gitlab"}],
            "upstream_workspaces": [{"connection_id": "local", "path": path(&head), "workspace_id": "w-head"}],
        }))));
        let workspace_tree = json!({"version": 1, "nodes": [
            {"id": "n-head", "kind": "workspace", "parent": null, "ref": {"connection_id": "local", "path": path(&head), "workspace_id": "w-head"}},
            {"id": "n-part", "kind": "workspace", "parent": "n-head", "ref": {"connection_id": "local", "path": path(&clone), "workspace_id": "w-part"}},
        ]});
        let part = json!({
            "connectionId": "local",
            "path": path(&clone),
            "branch": "pr-badge-fork-remote",
            "workspaceId": "w-part",
            "from": "upstream/pr-badge-fork-remote",
        });
        let request = own(
            591,
            json!({"sourceBranch": "upstream/pr-badge-fork-remote", "headSha": tip}),
        );
        let member = UpstreamMember {
            connection_id: "local".into(),
            workspace_id: "w-part".into(),
            label: "pr-badge-fork-remote".into(),
            path: path(&clone),
            group: home.clone(),
            ..UpstreamMember::default()
        };
        // Without the effort's parts, only the head workspace is read.
        let before = scanner(
            connection.clone(),
            workspace_tree.clone(),
            settings.clone(),
            vec![request.clone()],
            Vec::new(),
        );
        before.refresh(true).await;
        assert!(before.branches().is_empty());
        let scanned = scanner(
            connection.clone(),
            workspace_tree,
            settings,
            vec![request.clone()],
            vec![member],
        );
        scanned.refresh(true).await;
        let branches = scanned.branches();
        let branch = branches
            .iter()
            .find(|each| each.member.path == path(&clone))
            .unwrap();
        assert_eq!(branch.branch, "pr-badge-fork-remote");
        assert_eq!(branch.head, tip);
        assert_eq!(branch.member.group, home);
        assert_eq!(branch.member.label, "pr-badge-fork-remote");
        // The workspaces headed upstream are still only the marked ones.
        assert!(
            !scanned
                .members()
                .iter()
                .any(|each| each.path == path(&clone))
        );
        // At its head, whatever the request's source branch is called; no
        // request head fetched for it.
        let number = |found: Option<&Obj>| {
            found
                .and_then(|item| item.get("number"))
                .and_then(Value::as_u64)
        };
        assert_eq!(
            number(request_of_branch(
                branch,
                std::slice::from_ref(&request),
                &PatchIds::new(),
                &[]
            )),
            Some(591)
        );
        assert!(
            !connection
                .scripts
                .lock()
                .unwrap()
                .iter()
                .any(|script| script.contains("refs/roamgate/mr/"))
        );
        // Elsewhere: not by head, nor by that other name unless given.
        let mut moved = request.clone();
        moved.insert("headSha".into(), json!("f".repeat(40)));
        assert!(
            request_of_branch(branch, std::slice::from_ref(&moved), &PatchIds::new(), &[])
                .is_none()
        );
        assert_eq!(
            number(request_of_branch(
                branch,
                std::slice::from_ref(&moved),
                &PatchIds::new(),
                &["upstream/pr-badge-fork-remote".to_owned()]
            )),
            Some(591)
        );
        // On the effort's Board: in its request's lane, scanned or not.
        let mut entry = moved.clone();
        for (key, value) in [
            ("section", json!("authored")),
            ("unread", Value::Null),
            ("isNew", json!(false)),
            ("lane", json!("waiting")),
        ] {
            entry.insert(key.into(), value);
        }
        let plan = json!({
            "id": "p1", "name": "pr-badge-fork-remote", "commits": ["c1"], "dependsOn": [],
            "state": "accepted", "at": "", "by": "agent", "part": part,
        });
        for branches in [scanned.branches(), before.branches()] {
            let linked = effort_plan_entries(
                &home,
                std::slice::from_ref(&plan),
                &branches,
                std::slice::from_ref(&entry),
                &PatchIds::new(),
            );
            assert_eq!(linked["p1"]["number"], 591);
        }
        // Not made from upstream/X: found under that name all the same.
        let mut plain = plan.clone();
        plain["part"].as_object_mut().unwrap().remove("from");
        let linked = effort_plan_entries(
            &home,
            &[plain],
            &before.branches(),
            std::slice::from_ref(&entry),
            &PatchIds::new(),
        );
        assert_eq!(linked["p1"]["number"], 591);
    }

    #[tokio::test]
    // Unix only: merge request clones and worktrees are found by POSIX
    // paths (as the Bun server did); a Windows machine's are not yet.
    #[cfg(unix)]
    async fn a_stacked_parts_row_titled_and_counted_from_the_branch_it_sits_on_linked_where_it_is_pushed()
     {
        let g = GitFixture::new();
        g.project("media/engine");
        let clone = g.clone("media/engine", "stack");
        // The plans below it: kept on upstream/<name> branches, no part of
        // their own; the part's branch sits on the last one.
        g.git(&clone, &["checkout", "-q", "-b", "upstream/test-prep"]);
        g.commit(&clone, "a.c", "a\n", "Share the test runner", None);
        g.git(&clone, &["checkout", "-q", "-b", "upstream/core"]);
        g.commit(&clone, "b.c", "b\n", "Add the review service", None);
        g.git(&clone, &["checkout", "-q", "-b", "site-proxy"]);
        let tip = g.commit(&clone, "c.c", "c\n", "Preview sites through a proxy", None);
        // main moved on since: the target is behind, the base is not.
        let other = g.clone("media/engine", "other");
        g.commit(&other, "m.c", "m\n", "Upstream work", None);
        g.git(&other, &["push", "-q", "origin", "HEAD:main"]);
        g.git(&clone, &["fetch", "-q", "origin"]);
        // Pushed to the user's fork, on the same host.
        g.git(
            &clone,
            &[
                "remote",
                "add",
                "fork",
                &format!("https://{FORGE_HOST}/me/engine.git"),
            ],
        );
        g.git(
            &clone,
            &["update-ref", "refs/remotes/fork/site-proxy", &tip],
        );
        g.git(
            &clone,
            &["branch", "-q", "--set-upstream-to=fork/site-proxy"],
        );

        let part = json!({"connectionId": "local", "path": path(&clone), "branch": "site-proxy"});
        let plans = vec![
            json!({"id": "p1", "name": "test-prep"}),
            json!({"id": "p2", "name": "core"}),
            json!({"id": "p3", "name": "site-proxy", "dependsOn": ["p2"], "part": part}),
        ];
        assert_eq!(
            part_bases(&json!({"dependsOn": ["p2"], "part": part}), &plans),
            vec!["upstream/core"]
        );
        // A base it was made on comes first, then the plans it depends on, last first.
        let mut based = part.clone();
        based["base"] = json!("core-part");
        let mut prep = plans[0].clone();
        let mut prep_part = part.clone();
        prep_part["branch"] = json!("prep-part");
        prep["part"] = prep_part;
        assert_eq!(
            part_bases(
                &json!({"dependsOn": ["p1", "p2"], "part": based}),
                &[prep, plans[1].clone()]
            ),
            vec![
                "core-part",
                "upstream/core",
                "prep-part",
                "upstream/test-prep"
            ]
        );

        let connection =
            Arc::new(g.connection(vec![workspace("w-part", "site-proxy", &clone)], "local"));
        let home = upstream_workspace_home(&obj(
            json!({"connection_id": "local", "path": path(&clone), "workspace_id": "w-part"}),
        ));
        let settings = mr_reviews_settings(Some(&obj(
            json!({"hosts": [{"host": FORGE_HOST, "provider": "gitlab"}]}),
        )));
        let scanner = scanner(
            connection,
            json!({"version": 1, "nodes": []}),
            settings.clone(),
            Vec::new(),
            vec![UpstreamMember {
                connection_id: "local".into(),
                workspace_id: "w-part".into(),
                label: "site-proxy".into(),
                path: path(&clone),
                group: home,
                plan: Some("site-proxy".into()),
                // One gone first: the next that exists is used.
                bases: vec!["upstream/gone".into(), "upstream/core".into()],
            }],
        );
        scanner.refresh(true).await;
        let branch = scanner.branches().remove(0);
        assert_eq!(
            (
                branch.target.reference.as_str(),
                branch.target.behind,
                branch.target.ahead
            ),
            ("origin/main", 1.0, 3.0)
        );
        let base = branch.base.clone().unwrap();
        assert_eq!(
            (base.reference.as_str(), base.behind, base.ahead),
            ("upstream/core", 0.0, 1.0)
        );
        let url = format!("https://{FORGE_HOST}/me/engine/-/tree/site-proxy");
        assert_eq!(branch.url.as_deref(), Some(url.as_str()));
        // The branch still holds every commit beyond the target (overlaps, links).
        assert_eq!(branch.commits.len(), 3);
        let entry = branch_entry(&branch, &settings, "me", &[]);
        assert_eq!(entry["title"], "Preview sites through a proxy");
        let info = &entry["branch"];
        assert_eq!(info["target"], "upstream/core");
        assert_eq!(info["below"], "upstream/core");
        assert_eq!(info["ahead"], 1);
        assert_eq!(info["behind"], 0);
        assert_eq!(info["url"], json!(url));
        let subjects: Vec<&str> = info["commits"]
            .as_array()
            .unwrap()
            .iter()
            .map(|commit| commit["subject"].as_str().unwrap())
            .collect();
        assert_eq!(subjects, vec!["Preview sites through a proxy"]);
    }

    fn commit(n: u32) -> BranchCommit {
        BranchCommit {
            sha: n.to_string().repeat(40),
            at: f64::from(n),
            subject: format!("Commit {n}"),
            patch_id: Some(format!("p{n}")),
            own: false,
        }
    }

    fn listed(branch: &str, commits: Vec<BranchCommit>) -> UpstreamBranch {
        UpstreamBranch {
            key: format!("branch:{branch}"),
            branch: branch.into(),
            provider: "gitlab".into(),
            host: FORGE_HOST.into(),
            project: "media/engine".into(),
            commits,
            ..UpstreamBranch::default()
        }
    }

    fn remote(name: &str, url: &str) -> Remote {
        Remote {
            name: name.into(),
            url: url.into(),
        }
    }

    #[test]
    fn a_branchs_own_commits_those_no_listed_branch_below_it_holds() {
        let prep = listed("prep", vec![commit(1)]);
        let core = listed("core", vec![commit(2), commit(1)]);
        let top = listed("top", vec![commit(3), commit(2), commit(1)]);
        let elsewhere = UpstreamBranch {
            project: "media/other".into(),
            ..listed("other", vec![commit(1)])
        };
        let others = [prep.clone(), core.clone(), top.clone(), elsewhere];
        assert_eq!(
            own_commits(&top, &others),
            OwnCommits {
                commits: vec![commit(3)],
                below: Some("core".into()),
            }
        );
        assert_eq!(
            own_commits(&prep, &[prep.clone(), core, top.clone()]),
            OwnCommits {
                commits: vec![commit(1)],
                below: None,
            }
        );
        // A branch holding another's commits under other patches is not below.
        let reworked = listed("reworked", vec![commit(9)]);
        assert_eq!(own_commits(&top, &[reworked]).commits.len(), 3);
        // Not pushed, or pushed to another host: no page.
        assert_eq!(
            pushed_branch_url(
                None,
                &[remote("origin", "git@github.com:me/engine.git")],
                "github",
                "github.com"
            ),
            None
        );
        assert_eq!(
            pushed_branch_url(
                Some("my/fork/feature/x"),
                &[
                    remote("my", "git@github.com:other/engine.git"),
                    remote("my/fork", "git@github.com:me/engine.git"),
                ],
                "github",
                "github.com"
            )
            .as_deref(),
            Some("https://github.com/me/engine/tree/feature/x")
        );
        assert_eq!(
            pushed_branch_url(
                Some("origin/x"),
                &[remote("origin", "git@gitlab.example.org:me/e.git")],
                "github",
                "github.com"
            ),
            None
        );
    }
}
