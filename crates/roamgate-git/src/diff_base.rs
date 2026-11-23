//! The branch a branch is compared with (workspace/diff-base.ts):
//! Automatic's base from the refs already here (never a fetch), and the
//! picked branch checked against them.

use std::collections::BTreeSet;
use std::time::Duration;

use roamgate_base::assets::{DIFF_BASE_REFS_SH, DIFF_BASE_RELATION_SH, fill_template};

use crate::exec::{GitContext, Invocation};
use crate::review::is_metadata_ref;
use crate::shell::git_only_command;
use crate::{GitError, Result, first_text, shell_quote};

/// A ref as the refs script lists it.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Ref {
    pub name: String,
    pub symbolic: Option<String>,
    pub sha: Option<String>,
}

impl Ref {
    pub fn named(name: &str) -> Self {
        Self {
            name: name.into(),
            ..Self::default()
        }
    }

    pub fn symbolic(name: &str, target: &str) -> Self {
        Self {
            name: name.into(),
            symbolic: Some(target.into()),
            sha: None,
        }
    }
}

/// The refs and `init.defaultBranch`.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Listed {
    pub refs: Vec<Ref>,
    pub configured_default: String,
}

/// The default branch's local and remote-tracking forms (full names).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Candidates {
    pub local: Option<String>,
    pub remote: Option<String>,
}

/// The repository's recorded default branch: a remote HEAD (origin's
/// first, then other remotes'), else origin's `init.defaultBranch`, main
/// or master, with the local branch of the same name. A remote HEAD
/// naming a metadata ref is passed over.
pub fn default_base_candidates(refs: &[Ref], configured_default: &str) -> Candidates {
    let existing: BTreeSet<&str> = refs
        .iter()
        .filter(|r| r.symbolic.is_none() && !is_metadata_ref(&r.name))
        .map(|r| r.name.as_str())
        .collect();
    let has = |name: String| existing.contains(name.as_str()).then_some(name);
    let mut heads: Vec<&Ref> = refs
        .iter()
        .filter(|r| {
            r.name.starts_with("refs/remotes/")
                && r.name.ends_with("/HEAD")
                && r.symbolic
                    .as_deref()
                    .is_some_and(|s| !s.is_empty() && !is_metadata_ref(s))
        })
        .collect();
    heads.sort_by(|a, b| {
        let origin = |r: &Ref| r.name == "refs/remotes/origin/HEAD";
        origin(b)
            .cmp(&origin(a))
            .then_with(|| crate::compare::locale_compare(&a.name, &b.name))
    });
    for head in heads {
        let target = head.symbolic.as_deref().unwrap();
        let remote_prefix = &head.name[..head.name.len() - "HEAD".len()];
        let local = target
            .strip_prefix(remote_prefix)
            .and_then(|branch| has(format!("refs/heads/{branch}")));
        let remote = has(target.to_owned());
        if local.is_some() || remote.is_some() {
            return Candidates { local, remote };
        }
    }
    for name in [configured_default, "main", "master"] {
        if name.is_empty() {
            continue;
        }
        let local = has(format!("refs/heads/{name}"));
        let remote = has(format!("refs/remotes/origin/{name}"));
        if local.is_some() || remote.is_some() {
            return Candidates { local, remote };
        }
    }
    Candidates::default()
}

/// What git says of the two candidates, against HEAD.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Facts {
    pub on_local: bool,
    pub remote_in_local: bool,
    pub local_in_remote: bool,
    pub local_fork_time: i64,
    pub remote_fork_time: i64,
    pub local_fork_in_remote_fork: bool,
    pub remote_fork_in_local_fork: bool,
}

/// Automatic's base: the more recent of the local default branch and its
/// remote counterpart; on the local default branch itself, the remote.
pub fn choose_default_base(candidates: &Candidates, facts: Option<&Facts>) -> Option<String> {
    let (local, remote) = (&candidates.local, &candidates.remote);
    let (Some(local), Some(remote), Some(facts)) = (local, remote, facts) else {
        return remote.clone().or_else(|| local.clone());
    };
    let pick = if facts.on_local || facts.local_in_remote {
        remote
    } else if facts.remote_in_local {
        local
    } else if facts.local_fork_in_remote_fork {
        remote
    } else if facts.remote_fork_in_local_fork || facts.local_fork_time > facts.remote_fork_time {
        local
    } else {
        remote
    };
    Some(pick.clone())
}

/// A full ref name as the review writes a base: `origin/main`, `main`.
pub fn short_ref_name(name: &str) -> String {
    name.strip_prefix("refs/heads/")
        .or_else(|| name.strip_prefix("refs/remotes/"))
        .unwrap_or(name)
        .to_owned()
}

/// One script: the refs, then `init.defaultBranch`.
pub fn refs_script(root: &str) -> String {
    fill_template(DIFF_BASE_REFS_SH, &[("root", shell_quote(root).into())])
        .expect("diff-base-refs.sh")
}

pub fn parse_refs_output(stdout: &str) -> Listed {
    let (refs, configured) = stdout
        .split_once("\n--diff-base-config--\n")
        .unwrap_or((stdout, ""));
    Listed {
        refs: refs
            .split('\n')
            .filter(|line| line.starts_with("refs/"))
            .map(parse_ref_line)
            .collect(),
        configured_default: configured.trim().to_owned(),
    }
}

fn parse_ref_line(line: &str) -> Ref {
    let mut parts = line.split('\t');
    let name = parts.next().unwrap_or("").to_owned();
    let nonempty = |value: Option<&str>| value.filter(|v| !v.is_empty()).map(str::to_owned);
    let symbolic = nonempty(parts.next());
    let sha = nonempty(parts.next());
    Ref {
        name,
        symbolic,
        sha,
    }
}

fn facts_script(root: &str, local: &str, remote: &str) -> String {
    fill_template(
        DIFF_BASE_RELATION_SH,
        &[
            ("root", shell_quote(root).into()),
            ("local", shell_quote(local).into()),
            ("remote", shell_quote(remote).into()),
        ],
    )
    .expect("diff-base-relation.sh")
}

/// The facts, from the last seven lines (a login profile may print first).
pub fn parse_facts_output(stdout: &str) -> Option<Facts> {
    let all: Vec<&str> = stdout.trim().split('\n').collect();
    if all.len() < 7 {
        return None;
    }
    let lines = &all[all.len() - 7..];
    let number = |text: &str| crate::compare::js_number(text).map_or(0, |n| n as i64);
    Some(Facts {
        on_local: lines[0] == "1",
        remote_in_local: lines[1] == "1",
        local_in_remote: lines[2] == "1",
        local_fork_time: number(lines[3]),
        remote_fork_time: number(lines[4]),
        local_fork_in_remote_fork: lines[5] == "1",
        remote_fork_in_local_fork: lines[6] == "1",
    })
}

/// Automatic's base, its other candidate, and the branches to offer.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct DefaultBase {
    pub base: Option<String>,
    pub alternate: Option<String>,
    pub branches: Vec<String>,
}

/// A read-only script on the workspace's host: over SSH as a read
/// (`tag`), here in a plain shell.
pub(crate) fn read_invocation(cx: &GitContext, script: &str, tag: &str) -> Result<Invocation> {
    match cx.host() {
        Some(host) => Ok(Invocation::ssh_read(host, script, Some(tag))),
        None => git_only_command(script, None).map_err(GitError::Message),
    }
}

/// Automatic's base, read with only the refs already present (never a
/// fetch), in one or two scripts on the host.
pub async fn resolve_default_base(
    cx: &GitContext,
    root: &str,
    timeout: Option<Duration>,
    listed: Option<Listed>,
) -> Result<DefaultBase> {
    let timeout = timeout.unwrap_or(Duration::from_millis(10_000));
    let listed = match listed {
        Some(listed) => listed,
        None => {
            let ran = cx
                .run(
                    read_invocation(cx, &refs_script(root), "git.refs")?,
                    timeout,
                )
                .await?;
            if ran.code != 0 {
                return Err(GitError::Message(first_text(
                    &[&ran.stderr, &ran.stdout],
                    "Unable to read branches",
                    1000,
                )));
            }
            parse_refs_output(&ran.stdout)
        }
    };
    let refs = &listed.refs;
    let branches: Vec<String> = refs
        .iter()
        .filter(|r| r.symbolic.is_none())
        .map(|r| r.name.clone())
        .collect();
    let candidates = default_base_candidates(refs, &listed.configured_default);
    let mut facts = None;
    if let (Some(local), Some(remote)) = (&candidates.local, &candidates.remote) {
        let sha = |name: &str| {
            refs.iter()
                .find(|r| r.name == name)
                .and_then(|r| r.sha.clone())
        };
        let local_sha = sha(local);
        if local_sha.is_none() || local_sha != sha(remote) {
            let ran = cx
                .run(
                    read_invocation(cx, &facts_script(root, local, remote), "git.base")?,
                    timeout,
                )
                .await?;
            if ran.code == 0 {
                facts = parse_facts_output(&ran.stdout);
            }
        }
    }
    let base = choose_default_base(&candidates, facts.as_ref());
    let alternate = if base.is_some() && base == candidates.local {
        candidates.remote.clone()
    } else if base.is_some() && base == candidates.remote {
        candidates.local.clone()
    } else {
        None
    };
    Ok(DefaultBase {
        base,
        alternate,
        branches,
    })
}

/// A requested comparison branch: a string naming one of the refs.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Requested<'a> {
    None,
    Name(&'a str),
    /// Not a string (`{}`, `null`): refused.
    Invalid,
}

impl<'a> Requested<'a> {
    /// From a JSON parameter: absent or `""` is none.
    pub fn from_json(value: Option<&'a serde_json::Value>) -> Self {
        match value {
            None => Self::None,
            Some(serde_json::Value::String(text)) if text.is_empty() => Self::None,
            Some(serde_json::Value::String(text)) => Self::Name(text),
            Some(_) => Self::Invalid,
        }
    }
}

/// The picked base and the branches, from the refs already here.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Selected {
    pub base: Option<String>,
    pub branches: Vec<String>,
}

/// The picked branch (or Automatic's), checked against the refs.
pub fn select_diff_base(
    refs: &[Ref],
    automatic: Option<&str>,
    requested: Requested<'_>,
) -> Result<Selected> {
    let branches: Vec<String> = refs
        .iter()
        .filter(|r| r.symbolic.is_none())
        .map(|r| r.name.clone())
        .collect();
    let resolve = |name: &str| {
        [
            name.to_owned(),
            format!("refs/heads/{name}"),
            format!("refs/remotes/{name}"),
        ]
        .into_iter()
        .find(|candidate| branches.contains(candidate))
    };
    match requested {
        Requested::None => Ok(Selected {
            base: automatic.and_then(resolve),
            branches,
        }),
        Requested::Name(name) => match resolve(name) {
            Some(base) => Ok(Selected {
                base: Some(base),
                branches,
            }),
            None => Err(not_found()),
        },
        Requested::Invalid => Err(not_found()),
    }
}

fn not_found() -> GitError {
    GitError::message("Comparison branch was not found; select an existing branch.")
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use serde_json::json;

    use super::*;
    use crate::exec::testing::Scripted;
    use crate::exec::{Ran, Request};
    use crate::review::is_metadata_ref;

    fn refs(names: &[&str]) -> Vec<Ref> {
        names.iter().map(|name| Ref::named(name)).collect()
    }

    fn automatic(list: &[Ref], configured: &str) -> Option<String> {
        choose_default_base(&default_base_candidates(list, configured), None)
    }

    #[test]
    fn supports_local_main_and_master_without_a_remote() {
        for branch in ["main", "master"] {
            let list = refs(&[&format!("refs/heads/{branch}"), "refs/heads/feature"]);
            assert_eq!(
                automatic(&list, "").unwrap(),
                format!("refs/heads/{branch}")
            );
        }
    }

    #[test]
    fn prefers_the_recorded_custom_remote_default_and_its_local_branch() {
        let mut branches = refs(&[
            "refs/heads/main",
            "refs/heads/release/stable",
            "refs/remotes/origin/release/stable",
        ]);
        branches.push(Ref::symbolic(
            "refs/remotes/origin/HEAD",
            "refs/remotes/origin/release/stable",
        ));
        assert_eq!(
            default_base_candidates(&branches, "main"),
            Candidates {
                local: Some("refs/heads/release/stable".into()),
                remote: Some("refs/remotes/origin/release/stable".into()),
            }
        );
        assert_eq!(
            automatic(&branches, "main").unwrap(),
            "refs/remotes/origin/release/stable"
        );
        assert_eq!(
            automatic(&branches[2..], "").unwrap(),
            "refs/remotes/origin/release/stable"
        );
    }

    #[test]
    fn passes_over_a_remote_head_naming_a_metadata_branch_entire_s_checkpoints() {
        let mut branches = refs(&[
            "refs/heads/main",
            "refs/heads/feature",
            "refs/remotes/origin/feature",
            "refs/remotes/origin/entire/checkpoints/v1",
        ]);
        branches.push(Ref::symbolic(
            "refs/remotes/origin/HEAD",
            "refs/remotes/origin/entire/checkpoints/v1",
        ));
        assert_eq!(automatic(&branches, "main").unwrap(), "refs/heads/main");
        assert_eq!(automatic(&branches, "").unwrap(), "refs/heads/main");
        let mut more = branches.clone();
        more.push(Ref::named("refs/remotes/upstream/main"));
        more.push(Ref::symbolic(
            "refs/remotes/upstream/HEAD",
            "refs/remotes/upstream/main",
        ));
        assert_eq!(automatic(&more, "").unwrap(), "refs/remotes/upstream/main");
    }

    #[test]
    fn tells_metadata_refs_from_branches() {
        for name in [
            "refs/remotes/origin/entire/checkpoints/v1",
            "entire/checkpoints/v1",
            "origin/entire/checkpoints/v1",
            "refs/notes/commits",
            "refs/stash",
        ] {
            assert!(is_metadata_ref(name), "{name}");
        }
        for name in [
            "refs/heads/main",
            "refs/remotes/origin/main",
            "origin/release/stable",
            "main",
            "entirely-new",
        ] {
            assert!(!is_metadata_ref(name), "{name}");
        }
    }

    #[test]
    fn supports_other_remotes_configured_local_defaults_and_origin_fallbacks() {
        let mut list = refs(&["refs/remotes/upstream/trunk"]);
        list.push(Ref::symbolic(
            "refs/remotes/upstream/HEAD",
            "refs/remotes/upstream/trunk",
        ));
        assert_eq!(automatic(&list, "").unwrap(), "refs/remotes/upstream/trunk");
        assert_eq!(
            automatic(&refs(&["refs/heads/trunk", "refs/heads/main"]), "trunk").unwrap(),
            "refs/heads/trunk"
        );
        assert_eq!(
            automatic(&refs(&["refs/remotes/origin/master"]), "").unwrap(),
            "refs/remotes/origin/master"
        );
    }

    #[test]
    fn explicit_selection_wins_and_rejects_revisions_options_and_missing_branches() {
        let branches = refs(&[
            "refs/heads/main",
            "refs/heads/custom",
            "refs/remotes/upstream/custom",
        ]);
        for name in ["custom", "refs/heads/custom"] {
            let selected =
                select_diff_base(&branches, Some("refs/heads/main"), Requested::Name(name))
                    .unwrap();
            assert_eq!(selected.base.unwrap(), "refs/heads/custom");
        }
        let selected =
            select_diff_base(&branches, None, Requested::Name("upstream/custom")).unwrap();
        assert_eq!(selected.base.unwrap(), "refs/remotes/upstream/custom");
        let selected =
            select_diff_base(&branches, Some("refs/heads/main"), Requested::None).unwrap();
        assert_eq!(selected.base.unwrap(), "refs/heads/main");
        let invalid = [
            json!("missing"),
            json!("HEAD~1"),
            json!("--help"),
            json!("main; touch /tmp/nope"),
            json!({}),
            json!(null),
        ];
        for value in &invalid {
            let error =
                select_diff_base(&branches, None, Requested::from_json(Some(value))).unwrap_err();
            assert!(
                error
                    .to_string()
                    .contains("Comparison branch was not found")
            );
        }
    }

    #[test]
    fn does_not_mistake_current_feature_or_stale_metadata_for_a_default() {
        let mut list = refs(&["refs/heads/feature"]);
        list.push(Ref::symbolic(
            "refs/remotes/origin/HEAD",
            "refs/remotes/origin/missing",
        ));
        assert_eq!(automatic(&list, "missing"), None);
    }

    fn both() -> Candidates {
        Candidates {
            local: Some("refs/heads/main".into()),
            remote: Some("refs/remotes/origin/main".into()),
        }
    }

    fn choose(facts: Facts) -> String {
        choose_default_base(&both(), Some(&facts)).unwrap()
    }

    #[test]
    fn a_stale_local_main_behind_origin_main_origin_main() {
        let facts = Facts {
            local_in_remote: true,
            ..Facts::default()
        };
        assert_eq!(choose(facts), "refs/remotes/origin/main");
    }

    #[test]
    fn a_local_main_ahead_of_origin_main_the_local_one_unless_it_is_checked_out() {
        let ahead = Facts {
            remote_in_local: true,
            ..Facts::default()
        };
        assert_eq!(choose(ahead.clone()), "refs/heads/main");
        let on = Facts {
            on_local: true,
            ..ahead
        };
        assert_eq!(choose(on), "refs/remotes/origin/main");
    }

    #[test]
    fn diverged_the_one_whose_merge_base_with_head_is_newest() {
        let facts = |f: Facts| choose(f);
        assert_eq!(
            facts(Facts {
                local_fork_in_remote_fork: true,
                ..Facts::default()
            }),
            "refs/remotes/origin/main"
        );
        assert_eq!(
            facts(Facts {
                remote_fork_in_local_fork: true,
                ..Facts::default()
            }),
            "refs/heads/main"
        );
        assert_eq!(
            facts(Facts {
                local_fork_time: 20,
                remote_fork_time: 10,
                ..Facts::default()
            }),
            "refs/heads/main"
        );
        assert_eq!(
            facts(Facts {
                local_fork_time: 10,
                remote_fork_time: 20,
                ..Facts::default()
            }),
            "refs/remotes/origin/main"
        );
    }

    #[test]
    fn the_facts_are_read_from_the_last_lines_after_what_a_login_profile_printed() {
        assert_eq!(
            parse_facts_output("welcome\n0\n1\n0\n5\n6\n0\n1\n"),
            Some(Facts {
                on_local: false,
                remote_in_local: true,
                local_in_remote: false,
                local_fork_time: 5,
                remote_fork_time: 6,
                local_fork_in_remote_fork: false,
                remote_fork_in_local_fork: true,
            })
        );
        assert_eq!(parse_facts_output("1\n0\n"), None);
    }

    #[tokio::test]
    async fn over_ssh_two_read_only_scripts_on_the_host_never_a_fetch_one_when_local_and_remote_are_the_same_commit()
     {
        let answers = std::sync::Mutex::new(vec![
            [
                "refs/heads/main\t\taaa",
                "refs/remotes/origin/HEAD\trefs/remotes/origin/main\t",
                "refs/remotes/origin/main\t\tbbb",
                "\n--diff-base-config--\n",
            ]
            .join("\n"),
            "0\n0\n1\n100\n200\n1\n0\n".to_owned(),
        ]);
        let runner = Scripted::new(move |_: &Request| {
            let mut answers = answers.lock().unwrap();
            let stdout = if answers.is_empty() {
                String::new()
            } else {
                answers.remove(0)
            };
            Ok(Ran::new(0, stdout, ""))
        });
        let cx = GitContext::new(Some("example.test".into()), runner.clone());
        let resolved = resolve_default_base(&cx, "/remote/repo's root", None, None)
            .await
            .unwrap();
        assert_eq!(
            resolved,
            DefaultBase {
                base: Some("refs/remotes/origin/main".into()),
                alternate: Some("refs/heads/main".into()),
                branches: vec!["refs/heads/main".into(), "refs/remotes/origin/main".into()],
            }
        );
        let calls = runner.calls();
        assert_eq!(calls.len(), 2);
        for call in &calls {
            let Invocation::Ssh { command, read, .. } = &call.invocation else {
                panic!("{call:?}");
            };
            assert!(*read);
            assert!(!command.contains("fetch"));
        }
        let Invocation::Ssh { command, .. } = &calls[1].invocation else {
            unreachable!()
        };
        assert!(command.contains("merge-base --is-ancestor"));

        let same = Scripted::new(|_: &Request| {
            Ok(Ran::new(
                0,
                "refs/heads/main\t\taaa\nrefs/remotes/origin/main\t\taaa\n\n--diff-base-config--\n",
                "",
            ))
        });
        let cx = GitContext::new(Some("example.test".into()), same.clone() as Arc<_>);
        let resolved = resolve_default_base(&cx, "/repo", None, None)
            .await
            .unwrap();
        assert_eq!(resolved.base.unwrap(), "refs/remotes/origin/main");
        assert_eq!(same.calls().len(), 1);
    }
}
