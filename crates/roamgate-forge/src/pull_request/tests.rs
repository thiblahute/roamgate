//! workspace/pull-request.test.ts, the same cases on the Rust lookup.

use std::sync::atomic::{AtomicUsize, Ordering};

use roamgate_base::clock::{Clock, SystemClock, TestClock};
use roamgate_git::exec::RunFuture;
use roamgate_git::{Ran, Request, RunError, Runner};
use serde_json::{Value, json};

use super::*;

const ROOT: &str = "/repo with 'quote";

fn ok(value: Value) -> Result<Ran, RunError> {
    let stdout = match value {
        Value::String(text) => text,
        other => other.to_string(),
    };
    Ok(Ran::new(0, stdout, ""))
}

fn ok_text(text: &str) -> Result<Ran, RunError> {
    ok(Value::String(text.to_owned()))
}

fn fail() -> Result<Ran, RunError> {
    Ok(Ran::new(
        1,
        "secret-token",
        "https://user:secret-token@example.com",
    ))
}

fn fail_empty() -> Result<Ran, RunError> {
    Ok(Ran::new(1, "", "https://user:secret-token@example.com"))
}

/// What the TS fixture's thrown error was: a command that could not run.
fn unexpected(command: &str) -> Result<Ran, RunError> {
    Err(RunError(format!("Unexpected command: {command}")))
}

fn gh_pr() -> Value {
    json!({
        "number": 12,
        "title": "Add card",
        "user": { "login": "alice" },
        "head": {
            "ref": "feature/card",
            "label": "alice:feature/card",
            "repo": { "full_name": "alice/project" },
        },
        "base": { "label": "team:main" },
        "state": "open",
        "draft": true,
        "html_url": "https://github.com/team/project/pull/12",
    })
}

fn gl_mr() -> Value {
    json!({
        "iid": 7,
        "title": "Add card",
        "author": { "username": "bob" },
        "source_branch": "feature/card",
        "target_branch": "main",
        "source_project_id": 1,
        "target_project_id": 2,
        "state": "opened",
        "draft": true,
        "web_url": "https://gitlab.com/team/project/-/merge_requests/7",
    })
}

/// `{...base, ...changes}`.
fn with(base: Value, changes: Value) -> Value {
    let mut out = base.as_object().unwrap().clone();
    for (key, value) in changes.as_object().unwrap() {
        out.insert(key.clone(), value.clone());
    }
    Value::Object(out)
}

type Override = dyn Fn(&str, u64) -> Option<Result<Ran, RunError>> + Send + Sync;

/// A command as the fake sees it: over SSH, and its command line (the
/// remote command, or the local `sh -c` script).
#[derive(Debug, Clone)]
struct Seen {
    ssh: bool,
    command: String,
}

struct FakeHost {
    provider: &'static str,
    host: String,
    ssh: bool,
    remote_output: Option<String>,
    over: Option<Box<Override>>,
    commands: Mutex<Vec<Seen>>,
}

impl FakeHost {
    fn answer(&self, command: &str, timeout: u64) -> Result<Ran, RunError> {
        if let Some(over) = &self.over
            && let Some(answer) = over(command, timeout)
        {
            return answer;
        }
        let host = &self.host;
        let provider = self.provider;
        let has = |needle: &str| command.contains(needle);
        if has("'symbolic-ref'") {
            return ok_text("feature/card\n");
        }
        if has("'--git-path'") {
            return ok_text(".git/rebase-merge/head-name\n.git/rebase-apply/head-name\n");
        }
        if has("'cat' '--'") {
            return fail_empty();
        }
        if has("'for-each-ref'") {
            return ok_text("refs/heads/feature/card\0\0\n");
        }
        // No push remote configured; no glab token in glab's configuration.
        if has("'config' '--get-regexp'") {
            return Ok(Ran::new(1, "", ""));
        }
        if has("'sh' '-c'") {
            return ok_text("");
        }
        if has("'git' 'remote'") {
            return ok_text(self.remote_output.as_deref().unwrap_or(&format!(
                "origin\tgit@{host}:alice/project.git (fetch)\norigin\tgit@{host}:alice/project.git (push)\n"
            )));
        }
        if has("'--version'") {
            return ok_text("CLI version");
        }
        if has("'auth' 'status'") {
            if has("'--json'") {
                return ok_text(&if provider == "github" {
                    format!("{host}\n")
                } else {
                    String::new()
                });
            }
            if has("'--all'") {
                return ok_text(&if provider == "gitlab" {
                    format!("{host}\n  authenticated\n")
                } else {
                    String::new()
                });
            }
            return ok_text("");
        }
        if has("'repos/alice/project'") {
            return ok(json!({ "fork": true, "parent": { "full_name": "team/project" } }));
        }
        if has("'repos/alice/project/pulls?") {
            return ok(json!([]));
        }
        if has("'repos/team/project/pulls?") {
            return ok(json!([with(
                gh_pr(),
                json!({ "html_url": format!("https://{host}/team/project/pull/12") })
            )]));
        }
        if has("'statusCheckRollup'") {
            return ok(json!({ "statusCheckRollup": [
                { "__typename": "CheckRun", "status": "COMPLETED", "conclusion": "FAILURE" }
            ] }));
        }
        if has("'reviewDecision'") {
            return ok(json!({ "reviewDecision": "CHANGES_REQUESTED" }));
        }
        if has("'projects/alice%2Fproject'") {
            return ok(json!({
                "id": 1,
                "path_with_namespace": "alice/project",
                "forked_from_project": { "id": 2, "path_with_namespace": "team/project" },
            }));
        }
        if has("'projects/1/merge_requests?") {
            return ok(json!([]));
        }
        if has("'projects/2/merge_requests?") {
            return ok(json!([with(
                gl_mr(),
                json!({ "web_url": format!("https://{host}/team/project/-/merge_requests/7") })
            )]));
        }
        if has("'projects/2/merge_requests/7/approvals'") {
            return ok(
                json!({ "approved": false, "approved_by": [{ "user": { "username": "alice" } }] }),
            );
        }
        if has("'projects/2/merge_requests/7'") {
            return ok(json!({ "head_pipeline": { "status": "manual" } }));
        }
        unexpected(command)
    }
}

impl Runner for FakeHost {
    fn run(&self, request: Request) -> RunFuture<'_> {
        Box::pin(async move {
            let timeout = request.timeout.as_millis() as u64;
            let (ssh, command) = match &request.invocation {
                Invocation::Ssh {
                    destination,
                    command,
                    tag,
                    ..
                } => {
                    assert_eq!(destination, "user@server");
                    assert_eq!(tag.as_deref(), Some("git.pull_request"));
                    (true, command.clone())
                }
                Invocation::Local(argv) => {
                    assert_eq!(argv.len(), 3, "{argv:?}");
                    (false, argv[2].clone())
                }
            };
            // In the checkout, with the CLIs' prompts and colours off.
            let cd = format!("cd {} && ", shell_quote(ROOT));
            assert!(command.starts_with(&cd), "{command}");
            if !command.contains("'--symbolic-full-name'") {
                assert!(
                    command[cd.len()..]
                        .starts_with("GH_PROMPT_DISABLED=1 GIT_TERMINAL_PROMPT=0 NO_COLOR=1 "),
                    "{command}"
                );
            }
            self.commands.lock().unwrap().push(Seen {
                ssh,
                command: command.clone(),
            });
            self.answer(&command, timeout)
        })
    }
}

struct Fixture {
    host: Arc<FakeHost>,
    reader: Arc<PullRequests>,
    cache: MrCache,
    checkout: Checkout,
}

#[derive(Default)]
struct Options {
    host: Option<&'static str>,
    ssh: bool,
    remote_output: Option<String>,
    over: Option<Box<Override>>,
}

fn over(
    f: impl Fn(&str) -> Option<Result<Ran, RunError>> + Send + Sync + 'static,
) -> Option<Box<Override>> {
    Some(Box::new(move |command, _| f(command)))
}

fn fixture_with(provider: &'static str, options: Options, clock: SharedClock) -> Fixture {
    let host = Arc::new(FakeHost {
        provider,
        host: options
            .host
            .map(str::to_owned)
            .unwrap_or_else(|| format!("{provider}.com")),
        ssh: options.ssh,
        remote_output: options.remote_output,
        over: options.over,
        commands: Mutex::default(),
    });
    let git = GitContext::new(options.ssh.then(|| "user@server".to_owned()), host.clone());
    Fixture {
        reader: PullRequests::new(clock.clone(), ForgeGate::new(clock.clone())),
        cache: MrCache::open(clock, None, None),
        checkout: Checkout::new(git, ROOT),
        host,
    }
}

fn fixture(provider: &'static str, options: Options) -> Fixture {
    fixture_with(provider, options, Arc::new(SystemClock))
}

fn params(value: Value) -> Map<String, Value> {
    value.as_object().unwrap().clone()
}

impl Fixture {
    async fn read(&self, value: Value) -> Value {
        assert_eq!(self.host.ssh, self.checkout.host().is_some());
        self.reader
            .read_status(&self.checkout, &params(value))
            .await
    }

    async fn shared(&self, value: Value) -> Value {
        self.reader
            .shared_status(&self.checkout, &params(value), &self.cache)
            .await
            .unwrap()
    }

    fn commands(&self) -> Vec<Seen> {
        self.host.commands.lock().unwrap().clone()
    }

    fn lookups(&self) -> usize {
        self.commands()
            .iter()
            .filter(|seen| seen.command.contains("'remote' '-v'"))
            .count()
    }

    fn heads(&self) -> usize {
        self.commands()
            .iter()
            .filter(|seen| seen.command.contains("'--symbolic-full-name'"))
            .count()
    }
}

fn state(result: &Value) -> &str {
    result["state"].as_str().unwrap()
}

fn per_page_queries(f: &Fixture, needle: &str) -> Vec<String> {
    f.commands()
        .into_iter()
        .filter(|seen| seen.command.contains(needle))
        .map(|seen| seen.command)
        .collect()
}

#[tokio::test]
async fn authentication_checks_the_active_github_account_without_passing_github_only_flags_to_gitlab()
 {
    for provider in ["github", "gitlab"] {
        let result = fixture(
            provider,
            Options {
                over: over(move |command| {
                    if !command.contains("'auth' 'status' '--hostname'") {
                        return None;
                    }
                    // GitHub's inactive account is expired; glab rejects
                    // --active.
                    Some(
                        if command.contains("'--active'") == (provider == "github") {
                            ok_text("")
                        } else {
                            fail()
                        },
                    )
                }),
                ..Options::default()
            },
        )
        .read(json!({}))
        .await;
        assert_eq!(state(&result), "ready");
    }
}

#[test]
fn parses_network_remotes_without_disclosing_credentials_or_accepting_local_paths() {
    assert_eq!(
        parse_review_remote(
            "origin",
            "https://user:secret@gitlab.example.com:8443/team/sub/repo.git"
        ),
        Some(ReviewRemote {
            name: "origin".into(),
            host: "gitlab.example.com:8443".into(),
            repository: "team/sub/repo".into(),
        })
    );
    assert_eq!(
        parse_review_remote("origin", "ssh://git@github.com:2222/team/repo.git")
            .unwrap()
            .host,
        "github.com"
    );
    assert_eq!(parse_review_remote("origin", "/tmp/repo"), None);
    assert_eq!(parse_review_remote("origin", "file:///tmp/repo"), None);
    assert_eq!(
        parse_review_remote("origin", "git@github.com:team/repo;touch secret"),
        None
    );
}

#[tokio::test]
async fn provider_summarizes_open_closed_and_merged_requests_without_ci_review_calls() {
    for provider in ["github", "gitlab"] {
        for wanted in ["open", "closed", "merged"] {
            let f = fixture(
                provider,
                Options {
                    over: over(move |command| {
                        if command.contains("'repos/team/project/pulls?") {
                            return Some(ok(json!([with(
                                gh_pr(),
                                json!({
                                    "state": if wanted == "merged" { "closed" } else { wanted },
                                    "merged_at": if wanted == "merged" { json!("2026-10-01T00:00:00Z") } else { Value::Null },
                                })
                            )])));
                        }
                        if command.contains("'projects/2/merge_requests?") {
                            return Some(ok(json!([with(
                                gl_mr(),
                                json!({ "state": if wanted == "open" { "opened" } else { wanted } })
                            )])));
                        }
                        None
                    }),
                    ..Options::default()
                },
            );
            let result = f.read(json!({ "summary": true })).await;
            assert_eq!(state(&result), "ready");
            assert_eq!(
                result["request"]["state"],
                if provider == "gitlab" && wanted == "open" {
                    "opened"
                } else {
                    wanted
                }
            );
            assert!(result.get("ci").is_none());
            assert!(result.get("review").is_none());
            assert!(!f.commands().iter().any(|seen| {
                seen.command.contains("'view'") || seen.command.contains("/merge_requests/7")
            }));
        }
    }
}

#[tokio::test]
async fn provider_summaries_reject_branch_changes_and_ambiguous_merged_matches() {
    for provider in ["github", "gitlab"] {
        let reads = Arc::new(AtomicUsize::new(0));
        let changed = fixture(
            provider,
            Options {
                over: over(move |command| {
                    (command.contains("'symbolic-ref'")
                        && reads.fetch_add(1, Ordering::SeqCst) + 1 > 1)
                        .then(|| ok_text("other"))
                }),
                ..Options::default()
            },
        )
        .read(json!({ "summary": true }))
        .await;
        assert_eq!(state(&changed), "error");
        assert!(changed.get("request").is_none());
        let ambiguous = fixture(
            provider,
            Options {
                over: over(|command| {
                    if command.contains("'repos/team/project/pulls?") {
                        return Some(ok(json!([
                            gh_pr(),
                            with(
                                gh_pr(),
                                json!({ "number": 13, "state": "closed", "merged_at": "2026-10-01T00:00:00Z" })
                            ),
                        ])));
                    }
                    if command.contains("'projects/2/merge_requests?") {
                        return Some(ok(json!([
                            gl_mr(),
                            with(gl_mr(), json!({ "iid": 8, "state": "merged" })),
                        ])));
                    }
                    None
                }),
                ..Options::default()
            },
        )
        .read(json!({ "summary": true }))
        .await;
        assert_eq!(state(&ambiguous), "select_match");
        assert!(ambiguous.get("request").is_none());
    }
}

#[tokio::test]
async fn provider_sidebar_summaries_choose_the_newest_creation_across_repositories_regardless_of_state_or_number()
 {
    for provider in ["github", "gitlab"] {
        for wanted in ["open", "closed", "merged"] {
            let f = fixture(
                provider,
                Options {
                    over: over(move |command| {
                        if command.contains("'repos/alice/project/pulls?") {
                            return Some(ok(json!([
                                with(
                                    gh_pr(),
                                    json!({
                                        "number": 99,
                                        "created_at": "2026-10-02T00:00:00Z",
                                        "updated_at": "2026-10-20T00:00:00Z",
                                    })
                                ),
                                with(
                                    gh_pr(),
                                    json!({
                                        "number": 2,
                                        "created_at": "2026-10-03T00:00:00Z",
                                        "state": if wanted == "merged" { "closed" } else { wanted },
                                        "merged_at": if wanted == "merged" { json!("2026-10-04T00:00:00Z") } else { Value::Null },
                                        "html_url": "https://github.com/alice/project/pull/2",
                                    })
                                ),
                            ])));
                        }
                        if command.contains("'repos/team/project/pulls?") {
                            return Some(ok(json!([with(
                                gh_pr(),
                                json!({ "created_at": "2026-10-01T00:00:00Z" })
                            )])));
                        }
                        if command.contains("'projects/1/merge_requests?") {
                            return Some(ok(json!([
                                with(
                                    gl_mr(),
                                    json!({
                                        "iid": 99,
                                        "target_project_id": 1,
                                        "created_at": "2026-10-02T00:00:00Z",
                                        "updated_at": "2026-10-20T00:00:00Z",
                                    })
                                ),
                                with(
                                    gl_mr(),
                                    json!({
                                        "iid": 2,
                                        "target_project_id": 1,
                                        "created_at": "2026-10-03T00:00:00Z",
                                        "state": if wanted == "open" { "opened" } else { wanted },
                                        "web_url": "https://gitlab.com/alice/project/-/merge_requests/2",
                                    })
                                ),
                            ])));
                        }
                        if command.contains("'projects/2/merge_requests?") {
                            return Some(ok(json!([with(
                                gl_mr(),
                                json!({ "created_at": "2026-10-01T00:00:00Z" })
                            )])));
                        }
                        None
                    }),
                    ..Options::default()
                },
            );
            let result = f.read(json!({ "summary": true, "latest": true })).await;
            assert_eq!(state(&result), "ready");
            let request = &result["request"];
            let github = provider == "github";
            assert_eq!(
                request["id"],
                if github { "alice/project#2" } else { "1#2" }
            );
            assert_eq!(request["number"], 2);
            assert_eq!(
                request["state"],
                if !github && wanted == "open" {
                    "opened"
                } else {
                    wanted
                }
            );
            assert_eq!(request["draft"], true);
            assert_eq!(
                request["url"],
                if github {
                    "https://github.com/alice/project/pull/2"
                } else {
                    "https://gitlab.com/alice/project/-/merge_requests/2"
                }
            );
            assert!(result.get("ci").is_none());
            assert!(result.get("review").is_none());
            assert_eq!(
                state(&f.read(json!({ "summary": true })).await),
                "select_match"
            );
            assert_eq!(
                state(&f.read(json!({ "latest": true })).await),
                "select_match"
            );
        }
    }
}

#[tokio::test]
async fn provider_sidebar_summaries_do_not_guess_when_creation_times_are_missing_or_invalid() {
    for provider in ["github", "gitlab"] {
        for created in [None, Some("invalid")] {
            let result = fixture(
                provider,
                Options {
                    over: over(move |command| {
                        let second = |base: Value, changes: Value| {
                            let mut item = with(base, changes);
                            if let Some(created) = created {
                                item["created_at"] = json!(created);
                            }
                            item
                        };
                        if command.contains("'repos/team/project/pulls?") {
                            return Some(ok(json!([
                                with(gh_pr(), json!({ "created_at": "2026-10-01T00:00:00Z" })),
                                second(gh_pr(), json!({ "number": 13 })),
                            ])));
                        }
                        if command.contains("'projects/2/merge_requests?") {
                            return Some(ok(json!([
                                with(gl_mr(), json!({ "created_at": "2026-10-01T00:00:00Z" })),
                                second(gl_mr(), json!({ "iid": 8 })),
                            ])));
                        }
                        None
                    }),
                    ..Options::default()
                },
            )
            .read(json!({ "summary": true, "latest": true }))
            .await;
            assert_eq!(state(&result), "error");
            assert!(result.get("request").is_none());
        }
    }
}

#[tokio::test]
async fn provider_resolves_a_renamed_local_branch_through_its_upstream_over_local_and_ssh() {
    for provider in ["github", "gitlab"] {
        for ssh in [false, true] {
            let f = fixture(
                provider,
                Options {
                    ssh,
                    over: over(|command| {
                        if command.contains("'symbolic-ref'") {
                            return Some(ok_text("pr-299\n"));
                        }
                        if command.contains("'for-each-ref'") {
                            return Some(ok_text(
                                "refs/heads/pr-299\0origin\0refs/heads/feature/card\n",
                            ));
                        }
                        None
                    }),
                    ..Options::default()
                },
            );
            let result = f.read(json!({ "branch": "pr-299" })).await;
            assert_eq!(state(&result), "ready");
            assert_eq!(result["branch"], "pr-299");
            assert_eq!(
                result["request"]["number"],
                if provider == "github" { 12 } else { 7 }
            );
            let queries = per_page_queries(&f, "per_page=");
            assert!(!queries.is_empty());
            assert!(queries.iter().all(|query| query.contains("feature%2Fcard")));
        }
    }
}

type Rebasing = Arc<dyn Fn() -> bool + Send + Sync>;

/// A rebase stopped on `pr-299`: its head-name file, the reflog of HEAD
/// (newest first). Local reads use the file on disk; SSH reads go through
/// `cat`.
fn rebase_state(
    head_name: String,
    reference: &'static str,
    rebasing: Rebasing,
    reflog: &'static str,
) -> impl Fn(&str) -> Option<Result<Ran, RunError>> + Send + Sync + 'static {
    let apply = std::path::Path::new(&head_name)
        .parent()
        .unwrap()
        .parent()
        .unwrap()
        .join("rebase-apply")
        .join("head-name")
        .display()
        .to_string();
    move |command: &str| {
        if command.contains("'symbolic-ref'") {
            return Some(if rebasing() {
                fail()
            } else {
                ok_text("pr-299\n")
            });
        }
        if command.contains("'--git-path'") {
            return Some(ok_text(&format!("{head_name}\n{apply}\n")));
        }
        if command.contains("'cat' '--'") {
            return Some(if command.contains("rebase-merge") {
                ok_text(&format!("{reference}\n"))
            } else {
                fail_empty()
            });
        }
        if command.contains("'--walk-reflogs'") {
            return Some(ok_text(reflog));
        }
        if command.contains("'--verify'") {
            return Some(if command.contains("'refs/heads/pr-299'") {
                ok_text("abc123\n")
            } else {
                fail()
            });
        }
        if command.contains("'for-each-ref'") {
            return Some(ok_text(
                "refs/heads/pr-299\0origin\0refs/heads/feature/card\n",
            ));
        }
        None
    }
}

const STOP_REFLOG: &str = "commit (amend): Amend\nrebase (edit): Add card\n";

fn always() -> Rebasing {
    Arc::new(|| true)
}

#[tokio::test]
async fn provider_keeps_the_rebased_branch_s_request_on_a_detached_head_over_local_and_ssh() {
    for provider in ["github", "gitlab"] {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir(dir.path().join("rebase-merge")).unwrap();
        let head_name = dir
            .path()
            .join("rebase-merge")
            .join("head-name")
            .display()
            .to_string();
        let state_of = |reference: &'static str, rebasing: Rebasing, reflog: &'static str| {
            over(rebase_state(head_name.clone(), reference, rebasing, reflog))
        };
        for ssh in [false, true] {
            std::fs::write(&head_name, "refs/heads/pr-299\n").unwrap();
            // Workspace status reports the rebase as the "detached"
            // sentinel; the upstream alias still selects the
            // provider-side branch.
            for branch in [Some("detached"), Some("pr-299"), None] {
                let f = fixture(
                    provider,
                    Options {
                        ssh,
                        over: state_of("refs/heads/pr-299", always(), STOP_REFLOG),
                        ..Options::default()
                    },
                );
                let result = f
                    .read(branch.map_or(json!({}), |branch| json!({ "branch": branch })))
                    .await;
                assert_eq!(state(&result), "ready", "{result}");
                assert_eq!(result["branch"], "pr-299");
                assert_eq!(result["rebasing"], true);
                assert_eq!(
                    result["request"]["number"],
                    if provider == "github" { 12 } else { 7 }
                );
                assert!(
                    per_page_queries(&f, "per_page=")
                        .iter()
                        .all(|query| query.contains("feature%2Fcard"))
                );
            }
            // Finishing the rebase mid-request keeps the same association.
            let reads = Arc::new(AtomicUsize::new(0));
            let finished = fixture(
                provider,
                Options {
                    ssh,
                    over: state_of(
                        "refs/heads/pr-299",
                        Arc::new(move || reads.fetch_add(1, Ordering::SeqCst) + 1 < 2),
                        STOP_REFLOG,
                    ),
                    ..Options::default()
                },
            )
            .read(json!({ "branch": "detached", "summary": true }))
            .await;
            assert_eq!(state(&finished), "ready");
            assert!(finished.get("request").is_some());
            // Only an explicit detached sentinel or the same branch is
            // accepted.
            let switched = fixture(
                provider,
                Options {
                    ssh,
                    over: state_of("refs/heads/pr-299", always(), STOP_REFLOG),
                    ..Options::default()
                },
            )
            .read(json!({ "branch": "other" }))
            .await;
            assert_eq!(state(&switched), "error");
            assert!(switched.get("retryable").is_none());
            assert!(switched.get("request").is_none());
            // HEAD belongs to the rebase only while a rebase step last
            // moved it; commits made at a stop keep it there. A manual
            // checkout or reset mid-rebase, even back to the rebase's base,
            // does not.
            for (reflog, owned) in [
                ("rebase (start): checkout main\n", true),
                (
                    "commit: Fix\ncommit (amend): Amend\nrebase (edit): Add\n",
                    true,
                ),
                (
                    "pull --rebase git@host:a/b.git main (start): checkout abc\n",
                    true,
                ),
                (
                    "checkout: moving from abc to def\nrebase (edit): Add\n",
                    false,
                ),
                ("reset: moving to HEAD~\nrebase (edit): Add\n", false),
                ("pull: Fast-forward\n", false),
                ("commit: Only commits\n", false),
                ("", false),
            ] {
                let result = fixture(
                    provider,
                    Options {
                        ssh,
                        over: state_of("refs/heads/pr-299", always(), reflog),
                        ..Options::default()
                    },
                )
                .read(json!({ "branch": "detached" }))
                .await;
                assert_eq!(
                    state(&result),
                    if owned { "ready" } else { "detached" },
                    "{reflog}"
                );
                assert_eq!(result.get("request").is_none(), !owned);
            }
            // A rebase of a detached HEAD or a deleted branch is not
            // guessed.
            for reference in ["detached HEAD", "refs/heads/gone"] {
                std::fs::write(&head_name, format!("{reference}\n")).unwrap();
                let detached = fixture(
                    provider,
                    Options {
                        ssh,
                        over: state_of(reference, always(), STOP_REFLOG),
                        ..Options::default()
                    },
                )
                .read(json!({ "branch": "detached" }))
                .await;
                assert_eq!(state(&detached), "detached");
                assert!(detached.get("request").is_none());
            }
        }
        // Without rebase metadata a detached checkout stays unresolved.
        std::fs::remove_file(&head_name).unwrap();
        for ssh in [false, true] {
            let paths = format!(
                "{head_name}\n{}\n",
                dir.path().join("rebase-apply").join("head-name").display()
            );
            let detached = fixture(
                provider,
                Options {
                    ssh,
                    over: over(move |command| {
                        if command.contains("'symbolic-ref'") {
                            return Some(fail());
                        }
                        if command.contains("'--git-path'") {
                            return Some(ok_text(&paths));
                        }
                        if command.contains("'cat' '--'") {
                            return Some(fail_empty());
                        }
                        None
                    }),
                    ..Options::default()
                },
            )
            .read(json!({ "branch": "detached" }))
            .await;
            assert_eq!(state(&detached), "detached");
        }
        // Aborting into a different branch mid-request invalidates the
        // reply.
        std::fs::write(&head_name, "refs/heads/pr-299\n").unwrap();
        let reads = Arc::new(AtomicUsize::new(0));
        let rebase = rebase_state(
            head_name.clone(),
            "refs/heads/pr-299",
            always(),
            STOP_REFLOG,
        );
        let aborted = fixture(
            provider,
            Options {
                over: over(move |command| {
                    if command.contains("'symbolic-ref'")
                        && reads.fetch_add(1, Ordering::SeqCst) + 1 > 1
                    {
                        return Some(ok_text("main\n"));
                    }
                    rebase(command)
                }),
                ..Options::default()
            },
        )
        .read(json!({ "branch": "detached" }))
        .await;
        assert_eq!(state(&aborted), "error");
        assert!(aborted.get("retryable").is_none());
        assert!(aborted.get("request").is_none());
    }
}

#[tokio::test]
async fn provider_never_uses_a_different_remote_or_local_upstream_s_branch() {
    for provider in ["github", "gitlab"] {
        for remote in ["other", "."] {
            let result = fixture(
                provider,
                Options {
                    over: over(move |command| {
                        command.contains("'for-each-ref'").then(|| {
                            ok_text(&format!(
                                "refs/heads/feature/card\0{remote}\0refs/heads/main\n"
                            ))
                        })
                    }),
                    ..Options::default()
                },
            )
            .read(json!({}))
            .await;
            assert_eq!(state(&result), "ready");
        }
    }
}

#[tokio::test]
async fn provider_resolves_a_fork_and_preserves_provider_status_over_local_and_ssh() {
    for provider in ["github", "gitlab"] {
        for ssh in [false, true] {
            let f = fixture(
                provider,
                Options {
                    ssh,
                    ..Options::default()
                },
            );
            let result = f.read(json!({})).await;
            assert_eq!(state(&result), "ready");
            assert_eq!(result["provider"], provider);
            assert_eq!(result["branch"], "feature/card");
            assert_eq!(result["request"]["draft"], true);
            assert_eq!(
                result["ci"],
                if provider == "github" {
                    "1 FAILURE"
                } else {
                    "manual"
                }
            );
            assert_eq!(
                result["review"],
                if provider == "github" {
                    "CHANGES_REQUESTED"
                } else {
                    "Not approved (provider-reported); 1 approver(s)"
                }
            );
            assert!(
                roamgate_base::log::parse_iso_millis(result["refreshedAt"].as_str().unwrap())
                    .is_some()
            );
            assert!(f.commands().iter().all(|seen| seen.ssh == ssh));
            assert!(
                f.commands()
                    .iter()
                    .filter(|seen| seen.command.contains("'api'"))
                    .all(|seen| seen.command.contains("'--method' 'GET'"))
            );
        }
    }
}

#[tokio::test]
async fn provider_recognizes_a_configured_self_hosted_instance() {
    for provider in ["github", "gitlab"] {
        let result = fixture(
            provider,
            Options {
                host: Some("code.example.com"),
                ..Options::default()
            },
        )
        .read(json!({}))
        .await;
        assert_eq!(state(&result), "ready");
        assert_eq!(result["provider"], provider);
    }
}

type Answer = fn() -> Result<Ran, RunError>;

#[tokio::test]
async fn provider_distinguishes_missing_cli_auth_failure_no_match_and_failed_requests() {
    for provider in ["github", "gitlab"] {
        let list = if provider == "github" {
            "'repos/team/project/pulls?"
        } else {
            "'projects/2/merge_requests?"
        };
        let cases: [(&str, Answer, &str); 4] = [
            (
                "'--version'",
                || {
                    Ok(Ran::new(
                        127,
                        "secret-token",
                        "https://user:secret-token@example.com",
                    ))
                },
                "missing_cli",
            ),
            ("'auth' 'status' '--hostname'", fail, "unauthenticated"),
            (list, || ok(json!([])), "no_match"),
            ("'api'", fail, "error"),
        ];
        for (pattern, value, wanted) in cases {
            let pattern = pattern.to_owned();
            let result = fixture(
                provider,
                Options {
                    over: over(move |command| command.contains(&pattern).then(value)),
                    ..Options::default()
                },
            )
            .read(json!({}))
            .await;
            assert_eq!(state(&result), wanted);
            assert!(!result.to_string().contains("secret-token"));
            assert!(result.get("request").is_none());
        }
    }
}

/// Bun's spawn threw ENOENT for a missing executable; here the shell the
/// command runs in says so with its 127, which a real one gives.
#[cfg(unix)]
#[tokio::test]
async fn provider_reports_a_missing_native_executable_explicitly() {
    for provider in ["github", "gitlab"] {
        let result = fixture(
            provider,
            Options {
                over: over(|command| {
                    command.contains("'--version'").then(|| {
                        let output = std::process::Command::new("sh")
                            .args(["-c", "exec roamgate-no-such-cli --version"])
                            .output()
                            .unwrap();
                        Ok(Ran::new(output.status.code().unwrap_or(-1), "", ""))
                    })
                }),
                ..Options::default()
            },
        )
        .read(json!({}))
        .await;
        assert_eq!(state(&result), "missing_cli");
    }
}

#[tokio::test]
async fn provider_does_not_promote_failed_or_missing_ci_review_to_success() {
    for provider in ["github", "gitlab"] {
        let result = fixture(
            provider,
            Options {
                over: over(|command| {
                    (command.contains("'pr' 'view'")
                        || command.contains("'projects/2/merge_requests/7"))
                    .then(fail)
                }),
                ..Options::default()
            },
        )
        .read(json!({}))
        .await;
        assert_eq!(state(&result), "ready");
        assert!(result["ci"].as_str().unwrap().contains("Unavailable"));
        assert!(result["review"].as_str().unwrap().contains("Unavailable"));
    }
}

#[tokio::test]
async fn provider_isolates_malformed_ci_and_review_responses_from_request_metadata() {
    for provider in ["github", "gitlab"] {
        let result = fixture(
            provider,
            Options {
                over: over(|command| {
                    (command.contains("'pr' 'view'")
                        || command.contains("'projects/2/merge_requests/7"))
                    .then(|| ok(Value::Null))
                }),
                ..Options::default()
            },
        )
        .read(json!({}))
        .await;
        assert_eq!(state(&result), "ready");
        assert_eq!(result["request"]["title"], "Add card");
        assert!(result["ci"].as_str().unwrap().contains("Unavailable"));
        assert!(result["review"].as_str().unwrap().contains("Unavailable"));
    }
}

#[tokio::test]
async fn provider_host_detection_survives_a_timeout_in_the_other_cli() {
    for provider in ["github", "gitlab"] {
        let result = fixture(
            provider,
            Options {
                host: Some("code.example.com"),
                over: over(move |command| {
                    let other = if provider == "github" {
                        command.contains("'--all'")
                    } else {
                        command.contains("'.hosts | keys[]'")
                    };
                    other.then(|| Err(RunError("timed out".into())))
                }),
                ..Options::default()
            },
        )
        .read(json!({}))
        .await;
        assert_eq!(state(&result), "ready");
        assert_eq!(result["provider"], provider);
    }
}

#[tokio::test]
async fn provider_preserves_closed_and_merged_states() {
    for provider in ["github", "gitlab"] {
        for wanted in ["closed", "merged"] {
            let result = fixture(
                provider,
                Options {
                    over: over(move |command| {
                        if command.contains("'repos/team/project/pulls?") {
                            return Some(ok(json!([with(gh_pr(), json!({
                                "state": "closed",
                                "merged_at": if wanted == "merged" { json!("2026-09-29T00:00:00Z") } else { Value::Null },
                            }))])));
                        }
                        if command.contains("'projects/2/merge_requests?") {
                            return Some(ok(json!([with(gl_mr(), json!({ "state": wanted }))])));
                        }
                        None
                    }),
                    ..Options::default()
                },
            )
            .read(json!({}))
            .await;
            assert_eq!(state(&result), "ready");
            assert_eq!(result["request"]["state"], wanted);
        }
    }
}

#[tokio::test]
async fn provider_requires_explicit_selection_for_multiple_matches() {
    for provider in ["github", "gitlab"] {
        let f = fixture(
            provider,
            Options {
                over: over(|command| {
                    if command.contains("'repos/team/project/pulls?") {
                        return Some(ok(json!([gh_pr(), with(gh_pr(), json!({ "number": 13 }))])));
                    }
                    if command.contains("'projects/2/merge_requests?") {
                        return Some(ok(json!([gl_mr(), with(gl_mr(), json!({ "iid": 8 }))])));
                    }
                    None
                }),
                ..Options::default()
            },
        );
        let ambiguous = f.read(json!({})).await;
        assert_eq!(state(&ambiguous), "select_match");
        assert!(ambiguous.get("request").is_none());
        let first = ambiguous["matches"][0]["id"].clone();
        assert_eq!(state(&f.read(json!({ "match": first })).await), "ready");
        assert_eq!(
            state(&f.read(json!({ "match": "untrusted#123" })).await),
            "select_match"
        );
    }
}

#[tokio::test]
async fn provider_rejects_same_name_branches_belonging_to_another_source_repository() {
    for provider in ["github", "gitlab"] {
        let result = fixture(
            provider,
            Options {
                over: over(|command| {
                    if command.contains("'repos/team/project/pulls?") {
                        let mut pr = gh_pr();
                        pr["head"]["repo"] = json!({ "full_name": "other/project" });
                        return Some(ok(json!([pr])));
                    }
                    if command.contains("'projects/2/merge_requests?") {
                        return Some(ok(json!([with(
                            gl_mr(),
                            json!({ "source_project_id": 999 })
                        )])));
                    }
                    None
                }),
                ..Options::default()
            },
        )
        .read(json!({}))
        .await;
        assert_eq!(state(&result), "no_match");
    }
}

#[tokio::test]
async fn origin_is_the_default_among_multiple_remotes_explicit_and_unknown_choices_stay_distinct() {
    let f = fixture(
        "github",
        Options {
            remote_output: Some(
                "origin\tgit@github.com:alice/project.git (fetch)\nbackup\thttps://github.com/alice/project.git (fetch)\n".into(),
            ),
            ..Options::default()
        },
    );
    let automatic = f.read(json!({})).await;
    assert_eq!(state(&automatic), "ready");
    assert_eq!(automatic["remote"], "origin");
    assert_eq!(automatic["remotes"].as_array().unwrap().len(), 2);
    assert_eq!(
        f.read(json!({ "remote": "backup" })).await["remote"],
        "backup"
    );
    let before = f.commands().len();
    assert_eq!(
        state(&f.read(json!({ "remote": "'; bad" })).await),
        "select_remote"
    );
    assert!(f.commands()[before..].iter().all(|seen| {
        seen.command
            .contains("&& GH_PROMPT_DISABLED=1 GIT_TERMINAL_PROMPT=0 NO_COLOR=1 'git' ")
    }));
    let other = fixture(
        "github",
        Options {
            remote_output: Some(
                "backup\tgit@github.com:alice/project.git (fetch)\nupstream\tgit@github.com:alice/project.git (fetch)\n".into(),
            ),
            ..Options::default()
        },
    )
    .read(json!({}))
    .await;
    assert_eq!(state(&other), "select_remote");
}

#[tokio::test]
async fn unsupported_hosts_and_detached_head_have_explicit_states() {
    let undiscovered = fixture(
        "gitlab",
        Options {
            host: Some("git.example.com"),
            over: over(|command| command.contains("'auth'").then(|| ok_text(""))),
            ..Options::default()
        },
    )
    .read(json!({}))
    .await;
    assert_eq!(state(&undiscovered), "unsupported");
    assert_eq!(undiscovered["retryable"], true);
    let example = fixture(
        "github",
        Options {
            host: Some("example.com"),
            over: over(|command| command.contains("'auth'").then(|| ok_text(""))),
            ..Options::default()
        },
    )
    .read(json!({}))
    .await;
    assert_eq!(state(&example), "unsupported");
    let detached = fixture(
        "github",
        Options {
            over: over(|command| command.contains("'symbolic-ref'").then(fail)),
            ..Options::default()
        },
    )
    .read(json!({}))
    .await;
    assert_eq!(state(&detached), "detached");
}

#[tokio::test]
async fn branch_switches_before_or_during_a_request_never_return_a_card() {
    let before = fixture("github", Options::default())
        .read(json!({ "branch": "other" }))
        .await;
    assert!(before.get("request").is_none());
    let reads = Arc::new(AtomicUsize::new(0));
    let result = fixture(
        "github",
        Options {
            over: over(move |command| {
                (command.contains("'symbolic-ref'") && reads.fetch_add(1, Ordering::SeqCst) + 1 > 1)
                    .then(|| ok_text("other"))
            }),
            ..Options::default()
        },
    )
    .read(json!({}))
    .await;
    assert_eq!(state(&result), "error");
    assert!(result.get("request").is_none());
}

#[tokio::test]
async fn github_follows_canonical_identity_after_repository_renames() {
    let result = fixture(
        "github",
        Options {
            remote_output: Some("origin\tgit@github.com:old/project.git (fetch)\n".into()),
            over: over(|command| {
                command.contains("'repos/old/project'").then(|| {
                    ok(json!({
                        "full_name": "alice/project",
                        "fork": true,
                        "parent": { "full_name": "team/project" },
                    }))
                })
            }),
            ..Options::default()
        },
    )
    .read(json!({}))
    .await;
    assert_eq!(state(&result), "ready");
    assert_eq!(result["request"]["number"], 12);
}

#[tokio::test]
async fn gitlab_deduplicates_outgoing_fork_requests_listed_by_both_projects() {
    let result = fixture(
        "gitlab",
        Options {
            over: over(|command| {
                command
                    .contains("'projects/1/merge_requests?")
                    .then(|| ok(json!([gl_mr()])))
            }),
            ..Options::default()
        },
    )
    .read(json!({}))
    .await;
    assert_eq!(state(&result), "ready");
    assert_eq!(result["matches"].as_array().unwrap().len(), 1);
    assert_eq!(
        gitlab_approvals(&json!({ "approvals_left": 0 })).unwrap(),
        "0 approvals remaining (provider-reported)"
    );
}

#[tokio::test]
async fn invalid_payloads_and_unsafe_provider_urls_fail_closed() {
    let hundred = Value::Array(vec![gh_pr(); 100]);
    for value in [
        json!("invalid json"),
        json!({}),
        hundred,
        json!([with(gh_pr(), json!({ "html_url": "javascript:alert(1)" }))]),
        json!([with(
            gh_pr(),
            json!({ "html_url": "https://user:secret@github.com/team/project/pull/12" })
        )]),
    ] {
        let value = Arc::new(value);
        let result = fixture(
            "github",
            Options {
                over: over(move |command| {
                    command
                        .contains("'repos/team/project/pulls?")
                        .then(|| ok((*value).clone()))
                }),
                ..Options::default()
            },
        )
        .read(json!({}))
        .await;
        assert_eq!(state(&result), "error");
    }
    let failed = fixture(
        "github",
        Options {
            over: over(|command| command.contains("'repos/team/project/pulls?").then(fail)),
            ..Options::default()
        },
    )
    .read(json!({}))
    .await;
    assert_eq!(state(&failed), "error");
    assert_eq!(failed["retryable"], true);
}

#[tokio::test]
async fn glab_without_all_lists_its_hosts_through_plain_auth_status() {
    let result = fixture(
        "gitlab",
        Options {
            host: Some("code.example.com"),
            over: over(|command| {
                if command.contains("'glab' 'auth' 'status' '--all'") {
                    return Some(Ok(Ran::new(1, "", "ERROR: unknown flag: --all")));
                }
                if command.ends_with("'glab' 'auth' 'status'") {
                    return Some(Ok(Ran::new(
                        0,
                        "",
                        "code.example.com\n  \u{2713} Logged in to code.example.com\n",
                    )));
                }
                None
            }),
            ..Options::default()
        },
    )
    .read(json!({}))
    .await;
    assert_eq!(state(&result), "ready");
    assert_eq!(result["provider"], "gitlab");
}

#[tokio::test]
async fn a_glab_auth_status_that_hangs_is_cut_short_and_not_asked_again_soon() {
    let asked = Arc::new(Mutex::new(Vec::<u64>::new()));
    let kept = asked.clone();
    let setup = fixture(
        "gitlab",
        Options {
            host: Some("code.example.com"),
            ssh: true,
            over: Some(Box::new(move |command: &str, timeout: u64| {
                if command.contains("'glab' 'auth' 'status'") {
                    kept.lock().unwrap().push(timeout);
                    // The process helper kills ssh at the deadline (a
                    // locked keychain on the host keeps glab waiting
                    // forever).
                    return Some(Err(RunError(format!("ssh timed out after {timeout}ms"))));
                }
                None
            })),
            ..Options::default()
        },
    );
    let first = setup.read(json!({})).await;
    assert_eq!(state(&first), "error");
    assert!(
        first["message"]
            .as_str()
            .unwrap()
            .contains("glab auth status timed out")
    );
    assert_eq!(*asked.lock().unwrap(), [8_000]);
    // Another checkout on the same connection: the hosts stay unknown
    // rather than asked again.
    let second = setup.read(json!({})).await;
    assert_eq!(state(&second), "error");
    assert_eq!(*asked.lock().unwrap(), [8_000]);
}

const FORK_REMOTES: &str = "origin\tgit@gitlab.com:team/project.git (fetch)\nfork\tgit@gitlab.com:alice/project.git (fetch)\nmirror\tgit@git.example.org:alice/project.git (fetch)\n";

type Extra = fn(&str) -> Option<Result<Ran, RunError>>;

/// Fork workflow: origin is the upstream, the branch is pushed to a fork.
fn fork_fixture(
    refs: Option<&'static str>,
    config: Option<&'static str>,
    extra: Option<Extra>,
) -> Fixture {
    fixture(
        "gitlab",
        Options {
            remote_output: Some(FORK_REMOTES.into()),
            over: over(move |command| {
                if let Some(extra) = extra
                    && let Some(answer) = extra(command)
                {
                    return Some(answer);
                }
                if command.contains("'for-each-ref'") {
                    return Some(ok_text(
                        refs.unwrap_or("refs/heads/feature/card\0origin\0refs/heads/main\0\n"),
                    ));
                }
                if command.contains("'config' '--get-regexp'")
                    && let Some(config) = config
                {
                    return Some(ok_text(config));
                }
                // The upstream's own merge requests are not the fork's.
                if command.contains("'projects/team%2Fproject'") {
                    return Some(ok(json!({ "id": 2 })));
                }
                None
            }),
            ..Options::default()
        },
    )
}

type ForkCase = (&'static str, Option<&'static str>, Option<&'static str>);

#[tokio::test]
async fn the_source_is_name() {
    let cases: [ForkCase; 5] = [
        (
            "the branch's push remote",
            None,
            Some("branch.feature/card.pushremote fork\n"),
        ),
        (
            "the default push remote",
            None,
            Some("remote.pushdefault fork\n"),
        ),
        (
            "the remote that has the branch",
            Some(
                "refs/heads/feature/card\0origin\0refs/heads/main\0\nrefs/remotes/origin/HEAD\0\0\0refs/remotes/origin/main\nrefs/remotes/fork/feature/card\0\0\0\n",
            ),
            None,
        ),
        (
            "the configured forge among remotes that have the branch",
            Some(
                "refs/heads/feature/card\0origin\0refs/heads/main\0\nrefs/remotes/mirror/feature/card\0\0\0\nrefs/remotes/fork/feature/card\0\0\0\n",
            ),
            None,
        ),
        (
            "the tracked remote when nothing else says",
            Some("refs/heads/feature/card\0fork\0refs/heads/feature/card\0\n"),
            None,
        ),
    ];
    for (name, refs, config) in cases {
        let result = fork_fixture(refs, config, None).read(json!({})).await;
        assert_eq!(state(&result), "ready", "{name}: {result}");
        assert_eq!(result["remote"], "fork", "{name}");
        assert_eq!(result["request"]["number"], 7, "{name}");
    }
}

#[tokio::test]
async fn a_branch_specific_push_remote_wins_over_the_default_one() {
    let result = fork_fixture(
        None,
        Some(
            "remote.pushdefault origin\nbranch.other.pushremote origin\nbranch.feature/card.pushremote fork\n",
        ),
        None,
    )
    .read(json!({}))
    .await;
    assert_eq!(result["remote"], "fork");
}

#[tokio::test]
async fn the_merge_request_is_found_in_the_tracked_upstream_when_the_fork_link_is_gone() {
    let f = fork_fixture(
        Some(
            "refs/heads/feature/card\0origin\0refs/heads/main\0\nrefs/remotes/fork/feature/card\0\0\0\n",
        ),
        None,
        Some(|command| {
            if command.contains("'projects/alice%2Fproject'") {
                return Some(ok(
                    json!({ "id": 1, "path_with_namespace": "alice/project" }),
                ));
            }
            if command.contains("'projects/team%2Fproject/merge_requests?") {
                return Some(ok(json!([gl_mr()])));
            }
            None
        }),
    );
    let result = f.read(json!({ "summary": true })).await;
    assert_eq!(state(&result), "ready", "{result}");
    assert_eq!(result["request"]["number"], 7);
}

#[tokio::test]
async fn a_branch_started_from_the_upstream_s_main_is_not_looked_up_as_main() {
    let f = fixture(
        "gitlab",
        Options {
            over: over(|command| {
                command
                    .contains("'for-each-ref'")
                    .then(|| ok_text("refs/heads/feature/card\0origin\0refs/heads/main\0\n"))
            }),
            ..Options::default()
        },
    );
    let result = f.read(json!({})).await;
    assert_eq!(state(&result), "ready");
    let queries = per_page_queries(&f, "source_branch=");
    assert!(!queries.is_empty());
    assert!(
        queries
            .iter()
            .all(|query| query.contains("source_branch=feature%2Fcard"))
    );
}

/// ssh.<host> remotes use the API of <host>.
const SSH_HOST_REMOTE: &str = "origin\tgit@ssh.code.example.com:alice/project.git (fetch)\n";

#[tokio::test]
async fn when_glab_lists_host() {
    let f = fixture(
        "gitlab",
        Options {
            host: Some("code.example.com"),
            remote_output: Some(SSH_HOST_REMOTE.into()),
            ..Options::default()
        },
    );
    let result = f.read(json!({})).await;
    assert_eq!(state(&result), "ready");
    assert_eq!(result["provider"], "gitlab");
    assert!(
        result["request"]["url"]
            .as_str()
            .unwrap()
            .starts_with("https://code.example.com/")
    );
    assert!(
        f.commands()
            .iter()
            .filter(|seen| seen.command.contains("'--hostname'"))
            .all(|seen| seen.command.contains("'--hostname' 'code.example.com'"))
    );
}

#[tokio::test]
async fn when_glab_s_configuration_has_a_token_for_host_without_listing_every_host() {
    let result = fixture(
        "gitlab",
        Options {
            host: Some("code.example.com"),
            remote_output: Some(SSH_HOST_REMOTE.into()),
            over: over(|command| {
                if command.contains("'--all'") {
                    return Some(Err(RunError("timed out".into())));
                }
                if command.contains("'sh' '-c'") {
                    return Some(if command.ends_with("'sh' 'code.example.com'") {
                        ok_text("code.example.com\n")
                    } else {
                        ok_text("")
                    });
                }
                None
            }),
            ..Options::default()
        },
    )
    .read(json!({}))
    .await;
    assert_eq!(state(&result), "ready");
    assert_eq!(result["provider"], "gitlab");
}

/// The sidebar's GitLab summaries: workspaces in /repo/<branch>, all forks
/// of team/project.
struct Sidebar {
    reader: Arc<PullRequests>,
    git: GitContext,
    commands: Arc<Mutex<Vec<String>>>,
}

type Graphql = Box<dyn Fn(&str) -> Result<Ran, RunError> + Send + Sync>;

struct SidebarHost {
    graphql: Graphql,
    commands: Arc<Mutex<Vec<String>>>,
}

impl Runner for SidebarHost {
    fn run(&self, request: Request) -> RunFuture<'_> {
        Box::pin(async move {
            let Invocation::Local(argv) = &request.invocation else {
                panic!("a local checkout");
            };
            let command = argv[2].clone();
            self.commands.lock().unwrap().push(command.clone());
            let branch = command
                .strip_prefix("cd '/repo/")
                .and_then(|rest| rest.split('\'').next())
                .unwrap_or("")
                .to_owned();
            let has = |needle: &str| command.contains(needle);
            if has("'symbolic-ref'") {
                return ok_text(&format!("{branch}\n"));
            }
            if has("'for-each-ref'") {
                return ok_text(&format!("refs/heads/{branch}\0\0\0\n"));
            }
            if has("'config' '--get-regexp'") {
                return Ok(Ran::new(1, "", ""));
            }
            if has("'git' 'remote'") {
                return ok_text("origin\tgit@gitlab.com:alice/project.git (fetch)\n");
            }
            if has("'--version'") {
                return ok_text("glab 1");
            }
            if has("'auth' 'status'") {
                return ok_text("");
            }
            if has("'projects/alice%2Fproject'") {
                return ok(json!({
                    "id": 1,
                    "path_with_namespace": "alice/project",
                    "forked_from_project": { "id": 2, "path_with_namespace": "team/project" },
                }));
            }
            if has("'graphql'") {
                return (self.graphql)(&command);
            }
            unexpected(&command)
        })
    }
}

impl Sidebar {
    fn new(graphql: impl Fn(&str) -> Result<Ran, RunError> + Send + Sync + 'static) -> Self {
        let commands = Arc::new(Mutex::new(Vec::new()));
        let host = Arc::new(SidebarHost {
            graphql: Box::new(graphql),
            commands: commands.clone(),
        });
        let clock: SharedClock = Arc::new(SystemClock);
        Self {
            reader: PullRequests::new(clock.clone(), ForgeGate::new(clock)),
            git: GitContext::local(host),
            commands,
        }
    }

    async fn read(&self, branch: &str) -> Value {
        self.reader
            .read_status(
                &Checkout::new(self.git.clone(), format!("/repo/{branch}")),
                &params(json!({ "summary": true, "latest": true, "branch": branch })),
            )
            .await
    }

    fn commands(&self) -> Vec<String> {
        self.commands.lock().unwrap().clone()
    }

    fn forge(&self) -> Vec<String> {
        self.commands()
            .into_iter()
            .filter(|command| command.contains("'api'") || command.contains("'auth'"))
            .collect()
    }

    fn queries(&self) -> Vec<String> {
        self.commands()
            .into_iter()
            .filter(|command| command.contains("'graphql'"))
            .collect()
    }
}

fn node(branch: &str, iid: i64, state: &str) -> Value {
    json!({
        "iid": iid.to_string(),
        "title": format!("On {branch}"),
        "state": state,
        "draft": false,
        "webUrl": format!("https://gitlab.com/team/project/-/merge_requests/{iid}"),
        "createdAt": "2026-10-01T00:00:00Z",
        "sourceBranch": branch,
        "targetBranch": "main",
        "sourceProjectId": 1,
        "targetProjectId": 2,
        "author": { "username": "alice" },
    })
}

/// A GraphQL answer giving each project of the query its nodes.
fn answer(
    nodes: Vec<(&'static str, Vec<Value>)>,
) -> impl Fn(&str) -> Result<Ran, RunError> + Send + Sync + 'static {
    let project = Regex::new(r#"(p\d+): project\(fullPath: \\?"([^"\\]+)\\?"\)"#).unwrap();
    move |query: &str| {
        let mut data = Map::new();
        for captures in project.captures_iter(query) {
            let found = nodes
                .iter()
                .find(|(path, _)| *path == &captures[2])
                .map(|(_, nodes)| nodes.clone())
                .unwrap_or_default();
            data.insert(
                captures[1].to_owned(),
                json!({ "mergeRequests": { "pageInfo": { "hasNextPage": false }, "nodes": found } }),
            );
        }
        ok(json!({ "data": data }))
    }
}

#[tokio::test]
async fn ask_one_graphql_query_for_every_branch_of_the_fork_and_its_parent() {
    let w = Sidebar::new(answer(vec![(
        "team/project",
        vec![node("one", 7, "opened"), node("two", 8, "merged")],
    )]));
    let (one, two) = tokio::join!(w.read("one"), w.read("two"));
    assert_eq!(one["request"]["number"], 7);
    assert_eq!(two["request"]["number"], 8);
    assert_eq!(two["request"]["state"], "merged");
    let queries = w.queries();
    assert_eq!(queries.len(), 1);
    assert!(queries[0].contains(r#""alice/project""#));
    assert!(queries[0].contains(r#""team/project""#));
    // In the order the two lookups reached the batch, which the runtime
    // decides here (Bun's microtasks kept the order they were asked in).
    assert!(
        queries[0].contains(r#"["one","two"]"#) || queries[0].contains(r#"["two","one"]"#),
        "{}",
        queries[0]
    );
    // No REST request lists.
    assert!(!w.commands().iter().any(|c| c.contains("merge_requests?")));
}

#[tokio::test]
async fn answers_again_from_what_is_known_and_other_branches_ride_along() {
    let w = Sidebar::new(answer(vec![(
        "team/project",
        vec![node("one", 7, "opened")],
    )]));
    w.read("one").await;
    let asked = w.forge().len();
    // Open: known for two minutes, CLIs and logins for ten.
    let again = w.read("one").await;
    assert_eq!(again["request"]["number"], 7);
    assert_eq!(w.forge().len(), asked);
    // A new branch asks, and the query refreshes "one" with it.
    w.read("three").await;
    let queries = w.queries();
    assert_eq!(queries.len(), 2);
    assert!(queries[1].contains(r#""three""#));
    assert!(queries[1].contains(r#""one""#));
    assert_eq!(w.forge().iter().filter(|c| c.contains("'auth'")).count(), 1);
    assert_eq!(
        w.forge()
            .iter()
            .filter(|c| c.contains("'projects/alice%2Fproject'"))
            .count(),
        1
    );
}

#[tokio::test]
async fn a_failed_graphql_query_falls_back_to_the_rest_lists() {
    let w = Sidebar::new(|_| Ok(Ran::new(1, "", "HTTP 500")));
    let result = w.read("one").await;
    // The REST list is not answered: the lookup names that step.
    assert_eq!(state(&result), "error");
    assert!(
        result["message"]
            .as_str()
            .unwrap()
            .contains("merge_requests?")
    );
}

#[tokio::test]
async fn errors_name_the_step_that_failed_without_quoting_cli_output() {
    let not_found = fixture(
        "gitlab",
        Options {
            over: over(|command| {
                command.contains("'projects/alice%2Fproject'").then(|| {
                    Ok(Ran::new(
                        1,
                        "secret-token",
                        "https://user:secret-token@gitlab.com glab: 404 Project Not Found (HTTP 404)",
                    ))
                })
            }),
            ..Options::default()
        },
    )
    .read(json!({}))
    .await;
    assert_eq!(state(&not_found), "error");
    assert!(
        not_found["message"]
            .as_str()
            .unwrap()
            .contains("glab api projects/alice%2Fproject returned HTTP 404")
    );
    assert!(!not_found.to_string().contains("secret-token"));
    let truncated = fixture(
        "gitlab",
        Options {
            over: over(|command| {
                command
                    .contains("'projects/2/merge_requests?")
                    .then(|| ok(Value::Array(vec![gl_mr(); 100])))
            }),
            ..Options::default()
        },
    )
    .read(json!({}))
    .await;
    assert!(truncated["message"].as_str().unwrap().contains(
        "glab api projects/2/merge_requests?scope=all&state=all&source_branch=feature%2Fcard&per_page=100 returned 100 or more requests"
    ));
    let timed_out = fixture(
        "github",
        Options {
            over: over(|command| {
                command
                    .contains("'repos/alice/project'")
                    .then(|| Err(RunError("ssh timed out after 15000ms".into())))
            }),
            ..Options::default()
        },
    )
    .read(json!({}))
    .await;
    assert!(
        timed_out["message"]
            .as_str()
            .unwrap()
            .contains("gh api repos/alice/project timed out")
    );
}

#[test]
fn missing_skipped_and_pending_checks_retain_their_meaning() {
    assert_eq!(github_checks(Some(&Value::Null)).unwrap(), "Unavailable");
    assert_eq!(
        github_checks(Some(&json!([]))).unwrap(),
        "No checks reported"
    );
    assert_eq!(
        github_checks(Some(&json!([
            { "__typename": "CheckRun", "status": "COMPLETED", "conclusion": "SKIPPED" },
            { "__typename": "StatusContext", "state": "PENDING" },
            {},
        ])))
        .unwrap(),
        "1 SKIPPED, 1 PENDING, 1 Unknown"
    );
    assert_eq!(
        gitlab_approvals(&json!({ "approved_by": [{}] })).unwrap(),
        "Unavailable"
    );
    assert_eq!(
        gitlab_approvals(&json!({ "approved": true, "approved_by": [] })).unwrap(),
        "Approved (provider-reported); 0 approver(s)"
    );
}

/// Shared PR/MR status: a GitHub checkout over SSH whose HEAD the test
/// moves.
fn shared_fixture(clock: SharedClock) -> (Fixture, Arc<Mutex<String>>) {
    let head = Arc::new(Mutex::new("refs/heads/feature/card\nabc123".to_owned()));
    let current = head.clone();
    let f = fixture_with(
        "github",
        Options {
            ssh: true,
            over: over(move |command| {
                command
                    .contains("'--symbolic-full-name'")
                    .then(|| ok_text(&format!("{}\n", current.lock().unwrap())))
            }),
            ..Options::default()
        },
        clock,
    );
    (f, head)
}

#[tokio::test]
async fn browsers_asking_the_same_badge_together_share_one_lookup() {
    let (setup, _) = shared_fixture(Arc::new(SystemClock));
    let (a, b) = tokio::join!(
        setup.shared(json!({ "summary": true, "workspace_id": "w1" })),
        setup.shared(json!({ "summary": true, "workspace_id": "w2" })),
    );
    assert_eq!(state(&a), "ready");
    assert_eq!(b, a);
    assert_eq!(setup.lookups(), 1);
}

#[tokio::test]
async fn a_badge_is_reused_while_head_stays_and_read_again_once_it_moves() {
    let (setup, head) = shared_fixture(Arc::new(SystemClock));
    let first = setup.shared(json!({ "summary": true })).await;
    assert_eq!(setup.shared(json!({ "summary": true })).await, first);
    assert_eq!(setup.lookups(), 1);
    assert_eq!(setup.heads(), 2);
    *head.lock().unwrap() = "refs/heads/feature/card\ndef456".into();
    let moved = setup.shared(json!({ "summary": true })).await;
    assert_eq!(state(&moved), "ready");
    assert_eq!(setup.lookups(), 2);
    // Another branch asked: never the answer of the first one.
    let other = setup
        .shared(json!({ "summary": true, "branch": "other" }))
        .await;
    assert_eq!(state(&other), "error");
}

#[tokio::test]
async fn a_badge_older_than_its_reuse_is_read_again() {
    let clock = Arc::new(TestClock::new(1_800_000_000_000));
    let (setup, _) = shared_fixture(clock.clone());
    setup.shared(json!({ "summary": true })).await;
    clock.advance(SHARED_SUMMARY_MS as u64 + 1).await;
    setup.shared(json!({ "summary": true })).await;
    assert_eq!(setup.lookups(), 2);
    assert!(clock.now() > 1_800_000_000_000);
}

#[tokio::test]
async fn a_card_is_served_from_the_cache_a_refresh_reads_it_afresh_and_replaces_the_badges() {
    let (setup, _) = shared_fixture(Arc::new(SystemClock));
    setup.shared(json!({ "summary": true })).await;
    let card = setup.shared(json!({})).await;
    setup.shared(json!({})).await;
    assert_eq!(card["cached"]["stale"], false);
    assert_eq!(setup.lookups(), 2);
    // A click on refresh reads again, whatever the TTL says.
    setup.shared(json!({ "refresh": true })).await;
    assert_eq!(setup.lookups(), 3);
    // The card read dropped the badge's answer.
    setup.shared(json!({ "summary": true })).await;
    assert_eq!(setup.lookups(), 4);
}
