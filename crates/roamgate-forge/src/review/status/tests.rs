//! review/forge.test.ts: the chips' request statuses through fake glab
//! and gh.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{Value, json};

use super::*;
use crate::review::cli::ForgeProcess;
use crate::review::testkit::{Fake, clock, fail, host_probe, json as answer_json, tools, words};

fn gitlab_ref() -> ForgeRef {
    ForgeRef {
        provider: "gitlab".into(),
        host: "gitlab.example".into(),
        project: "gst/gstreamer".into(),
        number: 42,
    }
}

fn with(reference: &ForgeRef, change: impl FnOnce(&mut ForgeRef)) -> ForgeRef {
    let mut reference = reference.clone();
    change(&mut reference);
    reference
}

fn mr_json() -> Value {
    json!({
        "iid": 42,
        "title": "appsink: keep sticky events",
        "state": "opened",
        "draft": false,
        "author": {"username": "me"},
        "source_branch": "appsink",
        "target_branch": "main",
        "updated_at": "2026-11-02T10:00:00Z",
        "web_url": "https://gitlab.example/gst/gstreamer/-/merge_requests/42",
        "references": {"full": "gst/gstreamer!42"},
        "head_pipeline": {"id": 7, "project_id": 3, "status": "failed"},
    })
}

fn full_answers() -> Vec<(String, Value)> {
    vec![
        ("merge_requests/42".into(), mr_json()),
        (
            "merge_requests/42/approvals".into(),
            json!({"approved": false, "approved_by": [{"user": {"username": "a"}}]}),
        ),
        (
            "graphql".into(),
            json!({"data": {"project": {"mergeRequest": {
                "resolvableDiscussionsCount": 5, "resolvedDiscussionsCount": 2,
            }}}}),
        ),
        (
            "pipelines/7/jobs".into(),
            json!([
                {"name": "build fedora", "stage": "build", "allow_failure": false},
                {"name": "lint", "stage": "check", "allow_failure": true},
            ]),
        ),
    ]
}

fn replace(answers: &mut [(String, Value)], key: &str, value: Value) {
    if let Some(entry) = answers.iter_mut().find(|(k, _)| k == key) {
        entry.1 = value;
    }
}

type Processes = Arc<Mutex<Vec<ForgeProcess>>>;

/// glab on a fake host: glab's default host is gitlab.example, and it has
/// a login of its own for `logins`. Every other command is an API call,
/// answered by the longest key its words contain.
fn fake_glab(
    answers: Vec<(String, Value)>,
    logins: &'static [&'static str],
    host: Option<&str>,
) -> (ForgeContext, Processes) {
    let calls: Processes = Arc::default();
    let seen = calls.clone();
    let mut answers = answers;
    answers.sort_by_key(|a| std::cmp::Reverse(a.0.len()));
    let fake = Fake::sync(move |process| {
        if let Some(probe) = host_probe(process, logins) {
            return probe;
        }
        seen.lock().unwrap().push(process.clone());
        let command = words(process).join(" ");
        match answers
            .iter()
            .find(|(key, _)| command.contains(key.as_str()))
        {
            Some((_, value)) => answer_json(value),
            None => fail(1, "404 Not Found"),
        }
    });
    (tools(fake).context("/repo", host.map(str::to_owned)), calls)
}

#[tokio::test]
async fn reads_state_pipeline_failed_jobs_approvals_and_open_threads() {
    let (context, calls) = fake_glab(full_answers(), &[], None);
    let status = read_gitlab_status(&context, &gitlab_ref()).await;
    assert_eq!(status["state"], "ready");
    assert_eq!(
        status["request"],
        json!({
            "url": "https://gitlab.example/gst/gstreamer/-/merge_requests/42",
            "project": "gst/gstreamer",
            "title": "appsink: keep sticky events",
            "state": "open",
            "draft": false,
            "author": "me",
            "sourceBranch": "appsink",
            "targetBranch": "main",
            "updatedAt": "2026-11-02T10:00:00Z",
            "pipeline": {
                "status": "failed",
                "failed": [
                    {"name": "build fedora", "stage": "build", "allowFailure": false},
                    {"name": "lint", "stage": "check", "allowFailure": true},
                ],
            },
            "approvals": {"approved": false, "count": 1},
            "unresolved": 3,
        })
    );
    // Only reads: GETs, and a GraphQL query.
    for process in calls.lock().unwrap().iter() {
        let argv = words(process);
        assert_eq!(argv[..4], ["glab", "api", "--hostname", "gitlab.example"]);
        let method = &argv[argv.iter().position(|a| a == "--method").unwrap() + 1];
        if method != "GET" {
            assert!(argv.iter().any(|a| a == "graphql"));
        }
    }
}

#[tokio::test]
async fn a_host_glab_has_no_login_for_is_never_asked_and_gets_no_token() {
    let (context, calls) = fake_glab(full_answers(), &[], None);
    let status = read_gitlab_status(
        &context,
        &with(&gitlab_ref(), |r| r.host = "evil.example".into()),
    )
    .await;
    assert_eq!(status["state"], "not_signed_in");
    assert!(status["message"].as_str().unwrap().contains("evil.example"));
    assert!(status.get("request").is_none());
    assert!(calls.lock().unwrap().is_empty());
}

#[tokio::test]
async fn another_host_glab_is_logged_in_to_is_asked_without_the_environments_tokens() {
    let mut answers = full_answers();
    let mut mr = mr_json();
    mr["web_url"] = json!("https://gitlab.other/gst/gstreamer/-/merge_requests/42");
    replace(&mut answers, "merge_requests/42", mr);
    let other = with(&gitlab_ref(), |r| r.host = "gitlab.other".into());
    let (context, calls) = fake_glab(answers.clone(), &["gitlab.other"], None);
    let status = read_gitlab_status(&context, &other).await;
    assert_eq!(status["state"], "ready");
    {
        let calls = calls.lock().unwrap();
        assert!(!calls.is_empty());
        for process in calls.iter() {
            let ForgeProcess::Cli { unset, .. } = process else {
                panic!("a CLI on this machine");
            };
            assert!(unset.iter().any(|name| name == "GITLAB_TOKEN"));
        }
    }
    // Over SSH, removed from the remote environment.
    let (remote, remote_calls) = fake_glab(answers, &["gitlab.other"], Some("builder"));
    read_gitlab_status(&remote, &other).await;
    for process in remote_calls.lock().unwrap().iter() {
        assert!(words(process).join(" ").contains("env -u GITLAB_TOKEN"));
    }
}

#[tokio::test]
async fn security_work_shows_nothing_and_the_guard_fails_closed() {
    let (asked, calls) = fake_glab(full_answers(), &[], None);
    let status = read_gitlab_status(
        &asked,
        &with(&gitlab_ref(), |r| {
            r.project = "gst/security/gstreamer".into()
        }),
    )
    .await;
    assert_eq!(status["state"], "security");
    assert!(calls.lock().unwrap().is_empty());
    // Named by its numeric id, GitLab says it is a security project.
    let mut answers = full_answers();
    let mut mr = mr_json();
    mr["web_url"] = json!("https://gitlab.example/gst/security-fixes/-/merge_requests/42");
    replace(&mut answers, "merge_requests/42", mr);
    let (renamed, _) = fake_glab(answers, &[], None);
    let hidden = read_gitlab_status(
        &renamed,
        &with(&gitlab_ref(), |r| r.project = "1234".into()),
    )
    .await;
    assert_eq!(hidden["state"], "security");
    assert!(hidden.get("request").is_none());
    // A web URL on another host (or none): no link, nothing shown.
    for web_url in [
        json!("https://evil.example/gst/gstreamer/-/merge_requests/42"),
        json!("http://gitlab.example/gst/gstreamer/-/merge_requests/42"),
        json!("https://user:pw@gitlab.example/gst/gstreamer/-/merge_requests/42"),
        json!("https://gitlab.example/gst/gstreamer/-/merge_requests/43"),
        Value::Null,
    ] {
        let mut answers = full_answers();
        let mut mr = mr_json();
        mr["web_url"] = web_url.clone();
        replace(&mut answers, "merge_requests/42", mr);
        let (odd, _) = fake_glab(answers, &[], None);
        let status = read_gitlab_status(&odd, &gitlab_ref()).await;
        assert_eq!(status["state"], "security", "{web_url}");
        assert!(status.get("request").is_none());
    }
}

#[tokio::test]
async fn a_merge_request_gitlab_does_not_know_is_not_found() {
    let (context, _) = fake_glab(Vec::new(), &[], None);
    assert_eq!(
        read_gitlab_status(&context, &gitlab_ref()).await["state"],
        "not_found"
    );
}

fn gh_ref() -> ForgeRef {
    ForgeRef {
        provider: "github".into(),
        host: "github.com".into(),
        project: "cli/cli".into(),
        number: 7,
    }
}

fn fake_gh(logged_in: bool) -> (ForgeContext, Arc<Mutex<Vec<Vec<String>>>>) {
    let calls: Arc<Mutex<Vec<Vec<String>>>> = Arc::default();
    let seen = calls.clone();
    let fake = Fake::sync(move |process| {
        let argv = words(process);
        seen.lock().unwrap().push(argv.clone());
        if argv[1] == "auth" {
            return fail(if logged_in { 0 } else { 1 }, "");
        }
        answer_json(&json!({"data": {"repository": {
            "nameWithOwner": "cli/cli",
            "pullRequest": {
                "number": 7, "title": "Fix", "url": "https://github.com/cli/cli/pull/7",
                "state": "OPEN", "isDraft": false, "updatedAt": "2026-11-01T00:00:00Z",
                "baseRefName": "trunk", "headRefName": "fix", "author": {"login": "me"},
                "reviewDecision": "APPROVED", "reviews": {"totalCount": 2},
                "reviewThreads": {"nodes": [{"isResolved": false}, {"isResolved": true}]},
                "commits": {"nodes": [{"commit": {"statusCheckRollup": {
                    "state": "FAILURE",
                    "contexts": {"nodes": [
                        {"__typename": "CheckRun", "name": "test (ubuntu)", "status": "COMPLETED", "conclusion": "FAILURE"},
                        {"__typename": "CheckRun", "name": "lint", "status": "COMPLETED", "conclusion": "SUCCESS"},
                    ]},
                }}}]},
            },
        }}}))
    });
    (tools(fake).context("/repo", None), calls)
}

#[tokio::test]
async fn reads_state_checks_approvals_and_open_threads_through_gh() {
    let (context, calls) = fake_gh(true);
    let status = read_github_status(&context, &gh_ref()).await;
    let request = &status["request"];
    assert_eq!(request["url"], "https://github.com/cli/cli/pull/7");
    assert_eq!(request["state"], "open");
    assert_eq!(
        request["pipeline"],
        json!({"status": "failed", "failed": [{"name": "test (ubuntu)"}]})
    );
    assert_eq!(request["approvals"], json!({"approved": true, "count": 2}));
    assert_eq!(request["unresolved"], 1);
    assert_eq!(
        calls.lock().unwrap().last().unwrap()[..5],
        ["gh", "api", "--hostname", "github.com", "graphql"]
    );
}

#[tokio::test]
async fn a_host_gh_is_not_logged_in_to_is_never_asked() {
    let (context, calls) = fake_gh(false);
    let status = read_github_status(
        &context,
        &with(&gh_ref(), |r| r.host = "ghe.example".into()),
    )
    .await;
    assert_eq!(status["state"], "not_signed_in");
    assert_eq!(
        calls
            .lock()
            .unwrap()
            .iter()
            .map(|argv| argv[1].clone())
            .collect::<Vec<_>>(),
        ["auth"]
    );
}

#[tokio::test(start_paused = true)]
async fn coalesces_identical_requests_and_keeps_an_answer_until_its_state_allows_another_read() {
    let cache = ForgeCache::in_memory(clock());
    let (context, calls) = fake_glab(full_answers(), &[], None);
    let count = || {
        calls
            .lock()
            .unwrap()
            .iter()
            .filter(|process| {
                words(process)
                    .iter()
                    .any(|arg| arg.ends_with("merge_requests/42"))
            })
            .count()
    };
    let upper = with(&gitlab_ref(), |r| r.project = "GST/gstreamer".into());
    let first = gitlab_ref();
    let (a, b) = futures_util::join!(
        cache.status(&context, &first, false),
        cache.status(&context, &upper, false)
    );
    a.unwrap();
    b.unwrap();
    assert_eq!(count(), 1);
    tokio::time::advance(Duration::from_secs(60)).await;
    let known = cache.status(&context, &gitlab_ref(), false).await.unwrap();
    assert_eq!(count(), 1);
    assert!(known.get("stale").is_none());
    // Past what an open request at rest allows: the known answer at once,
    // and one read in the background.
    tokio::time::advance(Duration::from_secs(10 * 60)).await;
    let old = cache.status(&context, &gitlab_ref(), false).await.unwrap();
    assert_eq!(old["stale"], true);
    clock().sleep(Duration::from_millis(300)).await;
    assert_eq!(count(), 2);
    let again = cache.status(&context, &gitlab_ref(), false).await.unwrap();
    assert!(again.get("stale").is_none());
    assert_eq!(count(), 2);
}

fn node(iid: i64, extra: Value) -> Value {
    let mut node = json!({
        "iid": iid.to_string(),
        "webUrl": format!("https://gitlab.example/gst/gstreamer/-/merge_requests/{iid}"),
        "reference": format!("gst/gstreamer!{iid}"),
        "title": format!("MR {iid}"),
        "state": "opened",
        "draft": false,
        "updatedAt": "2026-11-02T10:00:00Z",
        "sourceBranch": "b",
        "targetBranch": "main",
        "author": {"username": "me"},
        "approved": true,
        "approvedBy": {"nodes": [{"username": "a"}]},
        "resolvableDiscussionsCount": 4,
        "resolvedDiscussionsCount": 1,
        "headPipeline": {
            "status": "FAILED",
            "jobs": {"nodes": [{"name": "build", "allowFailure": false, "stage": {"name": "b"}}]},
        },
    });
    if let (Some(node), Value::Object(extra)) = (node.as_object_mut(), extra) {
        node.extend(extra);
    }
    node
}

/// glab whose GraphQL answers each project alias with these nodes; any
/// other API call fails as fake_glab({}) does.
fn batch_glab(
    nodes: Vec<(&'static str, Vec<Value>)>,
) -> (ForgeContext, Processes, Arc<Mutex<Vec<String>>>) {
    let queries: Arc<Mutex<Vec<String>>> = Arc::default();
    let calls: Processes = Arc::default();
    let (seen_queries, seen_calls) = (queries.clone(), calls.clone());
    let alias = regex::Regex::new(r#"(p\d+): project\(fullPath: "([^"]+)"\)"#).unwrap();
    let fake = Fake::sync(move |process| {
        if let Some(probe) = host_probe(process, &[]) {
            return probe;
        }
        let argv = words(process);
        let Some(query) = argv.iter().find(|arg| arg.starts_with("query=")).cloned() else {
            seen_calls.lock().unwrap().push(process.clone());
            return fail(1, "404 Not Found");
        };
        seen_queries.lock().unwrap().push(query.clone());
        let mut data = serde_json::Map::new();
        for found in alias.captures_iter(&query) {
            let answer = nodes
                .iter()
                .find(|(path, _)| *path == &found[2])
                .map(|(_, nodes)| nodes.clone())
                .unwrap_or_default();
            data.insert(
                found[1].to_owned(),
                json!({"mergeRequests": {"nodes": answer}}),
            );
        }
        answer_json(&json!({ "data": data }))
    });
    (tools(fake).context("/repo", None), calls, queries)
}

#[tokio::test(start_paused = true)]
async fn one_graphql_query_reads_every_request_of_a_host_on_screen() {
    let cache = ForgeCache::in_memory(clock());
    let (context, calls, queries) = batch_glab(vec![
        (
            "gst/gstreamer",
            vec![
                node(42, json!({})),
                node(43, json!({"state": "merged", "headPipeline": null})),
            ],
        ),
        ("gst/gst-plugins-rs", Vec::new()),
    ]);
    let (one, two, three) = (
        gitlab_ref(),
        with(&gitlab_ref(), |r| r.number = 43),
        with(&gitlab_ref(), |r| {
            r.project = "gst/gst-plugins-rs".into();
            r.number = 7;
        }),
    );
    let (a, b, c) = futures_util::join!(
        cache.status(&context, &one, false),
        cache.status(&context, &two, false),
        cache.status(&context, &three, false)
    );
    let (a, b, c) = (a.unwrap(), b.unwrap(), c.unwrap());
    assert_eq!(queries.lock().unwrap().len(), 1);
    // Nothing else: no REST reads.
    assert!(calls.lock().unwrap().is_empty());
    let request = &a["request"];
    assert_eq!(request["state"], "open");
    assert_eq!(
        request["pipeline"],
        json!({"status": "failed", "failed": [{"name": "build", "stage": "b", "allowFailure": false}]})
    );
    assert_eq!(request["approvals"], json!({"approved": true, "count": 1}));
    assert_eq!(request["unresolved"], 3);
    assert_eq!(b["request"]["state"], "merged");
    assert_eq!(b["request"]["pipeline"], Value::Null);
    assert_eq!(c["state"], "not_found");
}

#[tokio::test(start_paused = true)]
async fn a_chip_asked_later_brings_the_others_along_and_answers_stand() {
    let cache = ForgeCache::in_memory(clock());
    let (context, _, queries) = batch_glab(vec![(
        "gst/gstreamer",
        vec![node(42, json!({})), node(44, json!({}))],
    )]);
    cache.status(&context, &gitlab_ref(), false).await.unwrap();
    tokio::time::advance(Duration::from_secs(20)).await;
    cache
        .status(&context, &with(&gitlab_ref(), |r| r.number = 44), false)
        .await
        .unwrap();
    assert_eq!(queries.lock().unwrap().len(), 2);
    assert!(queries.lock().unwrap()[1].contains(r#"["44","42"]"#));
    // 42 was read with 44: asked again past the shared 15 s, no call.
    tokio::time::advance(Duration::from_secs(20)).await;
    cache.status(&context, &gitlab_ref(), false).await.unwrap();
    assert_eq!(queries.lock().unwrap().len(), 2);
    // A click on refresh asks anyway.
    cache.status(&context, &gitlab_ref(), true).await.unwrap();
    assert_eq!(queries.lock().unwrap().len(), 3);
}

#[tokio::test(start_paused = true)]
async fn github_pull_requests_of_a_repository_share_one_query() {
    let cache = ForgeCache::in_memory(clock());
    let calls: Arc<Mutex<Vec<Vec<String>>>> = Arc::default();
    let seen = calls.clone();
    let pr = |number: i64| {
        json!({
            "number": number, "title": format!("PR {number}"),
            "url": format!("https://github.com/cli/cli/pull/{number}"),
            "state": "OPEN", "isDraft": false, "reviewThreads": {"nodes": []},
        })
    };
    let fake = Fake::sync(move |process| {
        let argv = words(process);
        seen.lock().unwrap().push(argv.clone());
        if argv[1] == "auth" {
            return fail(0, "");
        }
        // A missing one is an error beside the others' data.
        Ok(crate::gate::ProcessOutput {
            code: 1,
            stdout: json!({
                "data": {"r0": {"nameWithOwner": "cli/cli", "n7": pr(7), "n9": null}},
                "errors": [{"type": "NOT_FOUND"}],
            })
            .to_string(),
            stderr: "gh: Could not resolve to a PullRequest".into(),
        })
    });
    let context = tools(fake).context("/repo", None);
    let (first, second) = (gh_ref(), with(&gh_ref(), |r| r.number = 9));
    let (seven, nine) = futures_util::join!(
        cache.status(&context, &first, false),
        cache.status(&context, &second, false)
    );
    let api: Vec<Vec<String>> = calls
        .lock()
        .unwrap()
        .iter()
        .filter(|argv| argv[1] == "api")
        .cloned()
        .collect();
    assert_eq!(api.len(), 1);
    assert!(
        api[0]
            .last()
            .unwrap()
            .contains("n7: pullRequest(number: 7)")
    );
    assert_eq!(
        seven.unwrap()["request"]["url"],
        "https://github.com/cli/cli/pull/7"
    );
    assert_eq!(nine.unwrap()["state"], "not_found");
}

#[test]
fn references_from_the_browser_are_checked_before_anything_runs() {
    let good = gitlab_ref().value();
    assert_eq!(parse_forge_ref_param(&good), Some(gitlab_ref()));
    let changed = |key: &str, value: Value| {
        let mut bad = good.clone();
        bad[key] = value;
        bad
    };
    for bad in [
        Value::Null,
        changed("provider", json!("bitbucket")),
        changed("host", json!("a b")),
        changed("host", json!("-x")),
        changed("project", json!("../etc")),
        changed("project", json!("one")),
        changed("project", json!("a/b;rm -rf")),
        changed("number", json!(0)),
        changed("number", json!(1.5)),
        changed("number", json!("42")),
    ] {
        assert_eq!(parse_forge_ref_param(&bad), None, "{bad}");
    }
}

#[test]
fn n_means_the_upstream_remotes_project_else_origins() {
    let remotes = |pairs: &[(&str, &str)]| -> IndexMap<String, String> {
        pairs
            .iter()
            .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
            .collect()
    };
    assert_eq!(
        pick_default_remote(&remotes(&[("origin", "o"), ("upstream", "u")])).as_deref(),
        Some("upstream")
    );
    assert_eq!(
        pick_default_remote(&remotes(&[("origin", "o"), ("fork", "f")])).as_deref(),
        Some("origin")
    );
    assert_eq!(
        pick_default_remote(&remotes(&[("fork", "f")])).as_deref(),
        Some("fork")
    );
    assert_eq!(
        pick_default_remote(&remotes(&[("a", "a"), ("b", "b")])),
        None
    );
}

#[test]
fn a_request_a_command_opened_is_found_in_its_output() {
    use roamgate_agents::history::{created_request, creates_request};
    assert!(creates_request(Some(&json!("glab mr create --fill --yes"))));
    assert!(creates_request(Some(&json!(
        "cd x && gh pr create -t T -b B"
    ))));
    assert!(!creates_request(Some(&json!("glab mr list"))));
    assert!(!creates_request(None));
    assert_eq!(
        created_request(
            "Creating merge request for appsink into main in gst/gstreamer\n\n!42 appsink (appsink)\n https://gitlab.example/gst/gstreamer/-/merge_requests/42\n"
        )
        .as_deref(),
        Some("https://gitlab.example/gst/gstreamer/-/merge_requests/42")
    );
    assert_eq!(
        created_request("https://github.com/cli/cli/pull/7\n").as_deref(),
        Some("https://github.com/cli/cli/pull/7")
    );
    assert_eq!(created_request("error: no commits"), None);
}
