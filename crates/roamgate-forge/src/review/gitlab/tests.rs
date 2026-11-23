//! review/gitlab.test.ts: merge requests through a fake glab.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use roamgate_review::diff::parse_unified_diff;
use roamgate_review::model::ReviewAnchor;
use serde_json::{Value, json};

use super::*;
use crate::review::cli::{ForgeProcess, RunError};
use crate::review::testkit::{
    Fake, context, fail, host_probe, is_host_probe, json as answer_json, ok, tools, words,
};

const URL: &str = "https://gitlab.example/gst/gstreamer/-/merge_requests/42";

fn mr_json() -> Value {
    json!({
        "web_url": URL,
        "title": "cuda: fix",
        "state": "opened",
        "diff_refs": {
            "base_sha": "b".repeat(40),
            "start_sha": "s".repeat(40),
            "head_sha": "h".repeat(40),
        },
    })
}

type Calls = Arc<Mutex<Vec<Vec<String>>>>;

/// glab answering each `projects/` path with the first response whose key
/// it contains (a string is answered as it is); the host probe answers as
/// glab on gitlab.example.
fn fake_glab(responses: Vec<(&'static str, Value)>) -> (ForgeContext, Calls) {
    let calls: Calls = Arc::default();
    let seen = calls.clone();
    let fake = Fake::sync(move |process| {
        if let Some(probe) = host_probe(process, &[]) {
            return probe;
        }
        let argv = words(process);
        seen.lock().unwrap().push(argv.clone());
        let path = argv
            .iter()
            .find(|arg| arg.starts_with("projects/"))
            .cloned()
            .unwrap_or_default();
        match responses.iter().find(|(key, _)| path.contains(key)) {
            Some((_, Value::String(text))) => ok(text.clone()),
            Some((_, value)) => answer_json(value),
            None => fail(1, format!("404 {path}")),
        }
    });
    (context(fake), calls)
}

#[test]
fn merge_request_urls_and_the_security_guard() {
    assert_eq!(
        parse_merge_request_url(&format!("{URL}/diffs#note_1")),
        Some(MergeRequestRef {
            host: "gitlab.example".into(),
            project: "gst/gstreamer".into(),
            iid: 42,
        })
    );
    assert_eq!(
        parse_merge_request_url("https://gitlab.example/x/merge_requests/1"),
        None
    );
    assert!(is_security_project("gstreamer/security"));
    assert!(!is_security_project("gst/gstreamer"));
}

#[tokio::test]
async fn threads_discussions_without_system_notes_and_every_draft_note() {
    let (context, calls) = fake_glab(vec![
        (
            "merge_requests/42/discussions",
            json!([
                {"id": "abc1", "notes": [
                    {"id": 1, "body": "Why?", "author": {"username": "reviewer"}, "created_at": "2026-10-01",
                     "resolvable": true, "resolved": false,
                     "position": {"new_path": "a.c", "new_line": 5, "old_line": 4, "head_sha": "x"}},
                    {"id": 2, "system": true, "body": "changed the description"},
                ]},
                {"id": "def2", "notes": [{"id": 3, "system": true, "body": "merged"}]},
            ]),
        ),
        // Two pages back to back, as `glab api --paginate` prints them.
        (
            "merge_requests/42/draft_notes",
            json!(
                r#"[{"id":7,"note":"Leak","position":{"new_path":"a.c","new_line":9}}][{"id":8,"note":"Overall","position":null}]"#
            ),
        ),
        ("merge_requests/42", mr_json()),
    ]);
    let mr = read_merge_request(&context, URL).await.unwrap();
    let threads = read_merge_request_threads(&context, &mr, "s1")
        .await
        .unwrap();
    let summary: Vec<(String, String, Value)> = threads
        .iter()
        .map(|t| {
            (
                t.id.clone(),
                t.kind.clone(),
                serde_json::to_value(&t.anchor).unwrap(),
            )
        })
        .collect();
    assert_eq!(
        summary,
        vec![
            (
                "gl:abc1".into(),
                "merge-request".into(),
                json!({"path": "a.c", "line": 5, "side": "new", "contextOld": 4})
            ),
            (
                "gldraft:7".into(),
                "draft".into(),
                json!({"path": "a.c", "line": 9, "side": "new"})
            ),
            ("gldraft:8".into(), "draft".into(), json!({})),
        ]
    );
    assert_eq!(threads[0].comments.len(), 1);
    assert_eq!(threads[0].comments[0].author, "@reviewer");
    assert!(
        calls
            .lock()
            .unwrap()
            .iter()
            .all(|argv| argv.iter().any(|a| a == "--paginate"))
    );
}

#[tokio::test]
async fn a_draft_on_an_unchanged_line_carries_both_line_numbers() {
    let (context, calls) = fake_glab(vec![
        (
            "merge_requests/42/draft_notes",
            json!({"id": 9, "note": "n", "position": null}),
        ),
        ("merge_requests/42", mr_json()),
    ]);
    let mr = read_merge_request(&context, URL).await.unwrap();
    let anchor = ReviewAnchor {
        path: Some("a.c".into()),
        line: Some(10),
        side: Some("new".into()),
        context_old: Some(8),
        ..ReviewAnchor::default()
    };
    create_draft_note(&context, &mr, &anchor, "Context comment", None)
        .await
        .unwrap();
    let argv = calls.lock().unwrap().last().unwrap().clone();
    assert_eq!(
        argv[..7],
        [
            "glab",
            "api",
            "--hostname",
            "gitlab.example",
            "--method",
            "POST",
            "projects/gst%2Fgstreamer/merge_requests/42/draft_notes"
        ]
    );
    let fields: Vec<&String> = argv[7..].iter().skip(1).step_by(2).collect();
    for want in [
        "note=Context comment".to_owned(),
        "position[new_line]=10".to_owned(),
        "position[old_line]=8".to_owned(),
        format!("position[head_sha]={}", "h".repeat(40)),
    ] {
        assert!(fields.contains(&&want), "{want} in {fields:?}");
    }
}

#[tokio::test]
async fn a_drafts_pasted_images_are_uploaded_to_the_project_and_linked() {
    let folder = tempfile::tempdir().unwrap();
    let image = folder.path().join("shot one.png");
    std::fs::write(&image, [0x89, 0x50, 0x4e, 0x47, 1, 2]).unwrap();
    let body: Arc<Mutex<String>> = Arc::default();
    let calls: Calls = Arc::default();
    let (seen, kept) = (calls.clone(), body.clone());
    let fake = Fake::sync(move |process| {
        if let Some(probe) = host_probe(process, &[]) {
            return probe;
        }
        let argv = words(process);
        if let Some(at) = argv.iter().position(|a| a == "--input") {
            *kept.lock().unwrap() =
                String::from_utf8_lossy(&std::fs::read(&argv[at + 1]).unwrap()).into_owned();
        }
        seen.lock().unwrap().push(argv.clone());
        let path = argv
            .iter()
            .find(|a| a.starts_with("projects/"))
            .cloned()
            .unwrap_or_default();
        if path.contains("merge_requests/42/draft_notes") {
            answer_json(&json!({"id": 9, "note": "n", "position": null}))
        } else if path.contains("uploads") {
            answer_json(&json!({"url": "/uploads/0123/image-1.png"}))
        } else {
            answer_json(&mr_json())
        }
    });
    let context = context(fake);
    let mr = read_merge_request(&context, URL).await.unwrap();
    let note = format!(
        "See ![screenshot](<{}>) and ![web](https://x.example/a.png)",
        image.display()
    );
    create_draft_note(&context, &mr, &ReviewAnchor::default(), &note, None)
        .await
        .unwrap();
    let calls = calls.lock().unwrap();
    let upload = calls
        .iter()
        .find(|argv| argv.iter().any(|a| a == "projects/gst%2Fgstreamer/uploads"))
        .unwrap();
    assert!(upload.iter().any(|a| a == "--input"));
    let header = upload.iter().position(|a| a == "--header").unwrap();
    assert!(upload[header + 1].starts_with("Content-Type: multipart/form-data; boundary="));
    let body = body.lock().unwrap();
    assert!(body.contains(r#"name="file"; filename="image-1.png""#));
    assert!(body.contains("Content-Type: image/png"));
    assert!(calls.last().unwrap().contains(
        &"note=See ![screenshot](/uploads/0123/image-1.png) and ![web](https://x.example/a.png)"
            .to_owned()
    ));
}

fn github_mr() -> MergeRequestInfo {
    MergeRequestInfo {
        host: "github.com".into(),
        project: "o/r".into(),
        iid: 1,
        forge: Some("github".into()),
        project_path: None,
        url: "https://github.com/o/r/pull/1".into(),
        title: "t".into(),
        state: "opened".into(),
        base_sha: "b".into(),
        start_sha: "b".into(),
        head_sha: "h".into(),
        updated_at: None,
    }
}

#[tokio::test]
async fn a_pasted_image_refuses_a_github_draft_said_plainly() {
    let (context, calls) = fake_glab(vec![]);
    let error = create_draft_note(
        &context,
        &github_mr(),
        &ReviewAnchor::default(),
        "![screenshot](</tmp/x/shot.png>)",
        None,
    )
    .await
    .unwrap_err();
    assert!(error.contains("GitHub takes no images"), "{error}");
    assert!(calls.lock().unwrap().is_empty());
}

#[tokio::test]
async fn replies_refuse_odd_discussion_ids_the_api_diff_is_rebuilt() {
    let (context, _) = fake_glab(vec![
        (
            "merge_requests/42/diffs",
            json!([
                {"old_path": "a.c", "new_path": "a.c", "diff": "@@ -1 +1 @@\n-x\n+y\n"},
                {"old_path": "big.bin", "new_path": "big.bin", "too_large": true},
            ]),
        ),
        ("merge_requests/42", mr_json()),
    ]);
    let mr = read_merge_request(&context, URL).await.unwrap();
    let error = create_draft_reply(&context, &mr, "abc; rm -rf", "hi")
        .await
        .unwrap_err();
    assert!(error.contains("invalid discussion id"));
    let diff = read_merge_request_diff(&context, &mr).await.unwrap();
    let files: Vec<(String, bool)> = diff
        .files
        .iter()
        .map(|f| (f.path.clone(), f.binary))
        .collect();
    assert_eq!(files, vec![("a.c".into(), false), ("big.bin".into(), true)]);
    assert_eq!(diff.head_sha, Some("h".repeat(40)));
}

fn remote(host: &str, project: &str) -> Option<RemoteProject> {
    Some(RemoteProject {
        host: host.into(),
        project: project.into(),
    })
}

#[test]
fn remote_urls_ssh_scp_like_and_https_give_a_host_and_project() {
    assert_eq!(
        remote_project("git@ssh.gitlab.freedesktop.org:thiblahute/gstreamer.git"),
        remote("ssh.gitlab.freedesktop.org", "thiblahute/gstreamer")
    );
    assert_eq!(
        remote_project("ssh://git@Gitlab.Example:2222/gst/sub/gstreamer.git/"),
        remote("gitlab.example", "gst/sub/gstreamer")
    );
    assert_eq!(
        remote_project("https://gitlab.example/gst/gstreamer"),
        remote("gitlab.example", "gst/gstreamer")
    );
    assert_eq!(remote_project("/srv/git/gstreamer.git"), None);
    assert_eq!(remote_project("C:/src/gstreamer"), None);
    assert_eq!(remote_project("host:~user/repo"), None);
    assert!(on_gitlab_host("ssh.gitlab.example", "gitlab.example"));
    assert!(on_gitlab_host("gitlab.example", "gitlab.example"));
    assert!(!on_gitlab_host("github.com", "gitlab.example"));
}

fn pairs(list: &[(&str, &str)]) -> IndexMap<String, String> {
    list.iter()
        .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
        .collect()
}

fn fork_checkout() -> ReviewCheckout {
    ReviewCheckout {
        branch: Some("fix".into()),
        head: Some("a1".into()),
        default_branch: Some("main".into()),
        remote_heads: IndexMap::new(),
        upstream: None,
        push_remote: None,
        remotes: pairs(&[
            ("origin", "https://gitlab.example/gst/gstreamer.git"),
            ("fork", "git@ssh.gitlab.example:me/gstreamer.git"),
        ]),
        gitlab_host: Some("gitlab.example".into()),
        gitlab_logins: Vec::new(),
    }
}

fn upstream(remote: &str, branch: &str) -> Option<Upstream> {
    Some(Upstream {
        remote: remote.into(),
        branch: branch.into(),
    })
}

fn source(remote: &str, branch: &str, by_name: bool) -> Option<MergeRequestSource> {
    Some(MergeRequestSource {
        remote: remote.into(),
        branch: branch.into(),
        by_name,
    })
}

#[test]
fn the_source_is_the_upstream_else_the_branch_on_its_push_remote_or_origin() {
    let with = |change: &dyn Fn(&mut ReviewCheckout)| {
        let mut checkout = fork_checkout();
        change(&mut checkout);
        merge_request_source(&checkout)
    };
    assert_eq!(
        with(&|c| {
            c.upstream = upstream("fork", "fix-v2");
            c.push_remote = Some("origin".into());
        }),
        source("fork", "fix-v2", false)
    );
    assert_eq!(
        with(&|c| c.push_remote = Some("fork".into())),
        source("fork", "fix", true)
    );
    assert_eq!(with(&|_| {}), source("origin", "fix", true));
    // Detached, or a default branch: no merge request to look for.
    assert_eq!(with(&|c| c.branch = None), None);
    assert_eq!(with(&|c| c.branch = Some("master".into())), None);
    assert_eq!(
        with(&|c| {
            c.branch = Some("devel".into());
            c.default_branch = Some("devel".into());
        }),
        None
    );
    // git checkout -b myfix origin/main: main is where it started, the
    // merge request is the branch's own name.
    assert_eq!(
        with(&|c| {
            c.branch = Some("myfix".into());
            c.upstream = upstream("origin", "main");
        }),
        source("origin", "myfix", true)
    );
    assert_eq!(
        with(&|c| {
            c.branch = Some("myfix".into());
            c.upstream = upstream("fork", "devel");
            c.remote_heads.insert("fork".into(), "devel".into());
            c.push_remote = Some("fork".into());
        }),
        source("fork", "myfix", true)
    );
    assert_eq!(
        with(&|c| {
            c.branch = Some("myfix".into());
            c.upstream = upstream("origin", "devel");
            c.remote_heads.insert("fork".into(), "devel".into());
        }),
        source("origin", "devel", false)
    );
}

#[test]
fn the_checkout_scripts_answer_is_parsed() {
    let checkout = parse_checkout(
        &[
            "branch fix",
            "head a1",
            "default origin/main",
            "remote fork",
            "merge refs/heads/fix-v2",
            "pushremote ",
            "pushdefault fork",
            "rhead refs/remotes/fork/HEAD refs/remotes/fork/devel",
            "rhead refs/remotes/origin/HEAD refs/remotes/origin/main",
            "glab https://gitlab.example/",
            "url origin https://gitlab.example/gst/gstreamer.git",
            "url fork git@ssh.gitlab.example:me/gstreamer.git",
            "login gitlab.example",
            "login Gitlab.Other",
        ]
        .join("\n"),
    );
    let mut want = fork_checkout();
    want.remote_heads = pairs(&[("fork", "devel"), ("origin", "main")]);
    want.upstream = upstream("fork", "fix-v2");
    want.push_remote = Some("fork".into());
    want.gitlab_logins = vec!["gitlab.example".into(), "gitlab.other".into()];
    assert_eq!(checkout, want);
    // A branch tracking another local branch has no remote source.
    let local = parse_checkout("branch fix\nremote .\nmerge refs/heads/main\nglab \n");
    assert_eq!(local.upstream, None);
    assert_eq!(local.gitlab_host, None);
}

#[test]
fn only_an_open_merge_request_from_the_source_project_is_picked() {
    let list = json!([
        {"iid": 1, "state": "opened", "source_project_id": 9, "web_url": "u1", "title": "a"},
        {"iid": 2, "state": "merged", "source_project_id": 7, "web_url": "u2", "title": "b"},
        {"iid": 3, "state": "opened", "source_project_id": 7, "web_url": "u3", "title": "c"},
    ]);
    assert_eq!(
        pick_merge_request(&list, 7, false),
        Some(PickedRequest {
            url: "u3".into(),
            title: "c".into(),
            number: 3,
            state: "opened".into(),
        })
    );
    let two = Value::Array(list.as_array().unwrap()[..2].to_vec());
    assert_eq!(pick_merge_request(&two, 7, false), None);
    assert_eq!(pick_merge_request(&Value::Null, 7, false), None);
}

type Processes = Arc<Mutex<Vec<ForgeProcess>>>;

/// glab answering `projects/...` with `project` and anything else with
/// `list(path)`, keeping each call.
fn lister(
    project: Value,
    list: impl Fn(&str) -> Value + Send + Sync + 'static,
) -> (Arc<Fake>, Processes) {
    let calls: Processes = Arc::default();
    let seen = calls.clone();
    let fake = Fake::sync(move |process| {
        seen.lock().unwrap().push(process.clone());
        let path = words(process).last().cloned().unwrap_or_default();
        if path.starts_with("projects/") {
            answer_json(&project)
        } else {
            answer_json(&list(&path))
        }
    });
    (fake, calls)
}

fn last_words(calls: &Processes) -> Vec<String> {
    calls
        .lock()
        .unwrap()
        .iter()
        .map(|p| words(p).last().cloned().unwrap_or_default())
        .collect()
}

#[tokio::test]
async fn a_branchs_merge_request_the_open_ones_of_its_name_from_its_project() {
    let (fake, calls) = lister(json!({"id": 7}), |_| {
        json!([
            {"iid": 3, "state": "opened", "source_project_id": 9, "web_url": "x"},
            {"iid": 10046, "state": "opened", "source_project_id": 7,
             "web_url": "https://gitlab.example/gst/gstreamer/-/merge_requests/10046", "title": "Fix"},
        ])
    });
    let context = context(fake);
    let ids = Mutex::new(HashMap::new());
    let mut checkout = fork_checkout();
    checkout.upstream = upstream("fork", "fix-v2");
    assert_eq!(
        find_branch_merge_request(&context, &checkout, &ids)
            .await
            .unwrap(),
        Some(BranchMergeRequest {
            url: "https://gitlab.example/gst/gstreamer/-/merge_requests/10046".into(),
            title: "Fix".into(),
            number: 10046,
            state: "opened".into(),
            branch: "fix".into(),
        })
    );
    assert_eq!(
        last_words(&calls),
        vec![
            "projects/me%2Fgstreamer",
            "merge_requests?scope=all&state=opened&source_branch=fix-v2&per_page=100&page=1",
        ]
    );
    for process in calls.lock().unwrap().iter() {
        assert_eq!(
            words(process)[..6],
            [
                "glab",
                "api",
                "--hostname",
                "gitlab.example",
                "--method",
                "GET"
            ]
        );
    }
    // The project's id is remembered: one call next time.
    find_branch_merge_request(&context, &checkout, &ids)
        .await
        .unwrap();
    assert_eq!(calls.lock().unwrap().len(), 3);
    // Another host than glab's, or no branch: GitLab is not asked.
    let mut other = fork_checkout();
    other.gitlab_host = Some("gitlab.other".into());
    assert_eq!(
        find_branch_merge_request(&context, &other, &ids)
            .await
            .unwrap(),
        None
    );
    let mut detached = fork_checkout();
    detached.branch = None;
    assert_eq!(
        find_branch_merge_request(&context, &detached, &ids)
            .await
            .unwrap(),
        None
    );
    assert_eq!(calls.lock().unwrap().len(), 3);
}

#[tokio::test]
async fn a_remote_on_another_host_glab_is_logged_in_to_is_asked_there() {
    let logins = vec!["gitlab.other".to_owned()];
    assert_eq!(
        gitlab_host_for("ssh.gitlab.other", Some("gitlab.example"), &logins),
        Some("gitlab.other".into())
    );
    assert_eq!(
        gitlab_host_for("ssh.gitlab.example", Some("gitlab.example"), &[]),
        Some("gitlab.example".into())
    );
    assert_eq!(gitlab_host_for("github.com", None, &[]), None);

    let (fake, calls) = lister(json!({"id": 7}), |_| {
        json!([{"iid": 4, "state": "opened", "source_project_id": 7,
                "web_url": "https://gitlab.other/gst/gstreamer/-/merge_requests/4", "title": "Fix"}])
    });
    let context = context(fake);
    let mut checkout = fork_checkout();
    checkout.remotes = pairs(&[("origin", "git@ssh.gitlab.other:me/gstreamer.git")]);
    checkout.gitlab_host = Some("gitlab.com".into());
    checkout.gitlab_logins = logins;
    let found = find_branch_merge_request(&context, &checkout, &Mutex::new(HashMap::new()))
        .await
        .unwrap();
    assert_eq!(found.map(|f| f.number), Some(4));
    let calls = calls.lock().unwrap();
    assert_eq!(
        calls
            .iter()
            .map(|p| words(p)[3].clone())
            .collect::<Vec<_>>(),
        ["gitlab.other", "gitlab.other"]
    );
    // A token in the environment is for glab's default host: not sent there.
    for process in calls.iter() {
        let ForgeProcess::Cli { unset, .. } = process else {
            panic!("a CLI on this machine");
        };
        assert_eq!(unset, &TOKEN_VARIABLES.map(str::to_owned).to_vec());
    }
}

#[tokio::test]
async fn the_merge_request_list_is_read_a_page_at_a_time_up_to_a_few() {
    let other = |iid: i64| json!({"iid": iid, "state": "opened", "source_project_id": 9, "web_url": format!("u{iid}")});
    let full: Vec<Value> = (0..100).map(other).collect();
    let pages: Arc<Mutex<Vec<Vec<Value>>>> = Arc::default();
    let served = pages.clone();
    let (fake, calls) = lister(json!({"id": 7}), move |path| {
        let page: usize = path.rsplit("&page=").next().unwrap().parse().unwrap();
        Value::Array(
            served
                .lock()
                .unwrap()
                .get(page - 1)
                .cloned()
                .unwrap_or_default(),
        )
    });
    let context = context(fake);
    let ids = Mutex::new(HashMap::from([(
        "gitlab.example\ngst/gstreamer".to_owned(),
        7,
    )]));
    let mut second = full[1..].to_vec();
    let mut mine = other(500);
    mine["source_project_id"] = json!(7);
    second.push(mine);
    *pages.lock().unwrap() = vec![full.clone(), second, full.clone()];
    let found = find_branch_merge_request(&context, &fork_checkout(), &ids)
        .await
        .unwrap();
    assert_eq!(found.map(|f| f.number), Some(500));
    let asked = |calls: &Processes| -> Vec<Vec<String>> {
        calls.lock().unwrap().iter().map(words).collect()
    };
    let all = asked(&calls);
    assert!(
        all.iter()
            .all(|argv| !argv.iter().any(|a| a == "--paginate"))
    );
    assert_eq!(
        all.iter()
            .map(|argv| argv
                .last()
                .unwrap()
                .rsplit("&page=")
                .next()
                .unwrap()
                .to_owned())
            .collect::<Vec<_>>(),
        ["1", "2"]
    );
    // A short page is the last; and five pages at most (the user's own
    // are asked after, the same way: counted apart).
    let project_pages = |calls: &Processes| {
        asked(calls)
            .iter()
            .filter(|argv| argv.last().unwrap().contains("scope=all"))
            .count()
    };
    calls.lock().unwrap().clear();
    *pages.lock().unwrap() = vec![full.clone(), full[..3].to_vec(), full.clone()];
    assert_eq!(
        find_branch_merge_request(&context, &fork_checkout(), &ids)
            .await
            .unwrap(),
        None
    );
    assert_eq!(project_pages(&calls), 2);
    calls.lock().unwrap().clear();
    *pages.lock().unwrap() = vec![full.clone(); 8];
    assert_eq!(
        find_branch_merge_request(&context, &fork_checkout(), &ids)
            .await
            .unwrap(),
        None
    );
    assert_eq!(project_pages(&calls), 5);
}

#[test]
fn the_checkout_script_applies_insteadof_and_never_prints_a_token() {
    let dir = tempfile::tempdir().unwrap();
    let bin = dir.path().join("bin");
    let repo = dir.path().join("repo");
    std::fs::create_dir(&bin).unwrap();
    std::fs::create_dir(&repo).unwrap();
    // A stand-in glab: a default host, a token of its own for gitlab.other
    // only, and GITLAB_TOKEN or a hostless token for any other host.
    let glab = bin.join("glab");
    std::fs::write(
        &glab,
        [
            "#!/bin/sh",
            r#"if [ "$3" = host ]; then echo https://gitlab.example; exit 0; fi"#,
            r#"if [ "$5" = gitlab.other ]; then echo s3cr3t-token; exit 0; fi"#,
            r#"echo "${GITLAB_TOKEN:-hostless-token}""#,
        ]
        .join("\n"),
    )
    .unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&glab, std::fs::Permissions::from_mode(0o755)).unwrap();
    }
    let git = |argv: &[&str]| {
        let output = std::process::Command::new("git")
            .arg("-C")
            .arg(&repo)
            .args(argv)
            .output()
            .unwrap();
        assert!(output.status.success(), "{output:?}");
    };
    git(&["init", "-q", "-b", "myfix"]);
    git(&["config", "url.git@ssh.gitlab.other:.insteadOf", "other:"]);
    git(&["remote", "add", "fork", "other:me/gstreamer.git"]);
    git(&[
        "remote",
        "add",
        "origin",
        "https://GitLab.Example/gst/gstreamer.git",
    ]);
    git(&["remote", "add", "hub", "git@github.com:me/gstreamer.git"]);
    git(&["config", "branch.myfix.remote", "fork"]);
    git(&["config", "branch.myfix.merge", "refs/heads/myfix"]);
    let path = format!(
        "{}:{}",
        bin.display(),
        std::env::var("PATH").unwrap_or_default()
    );
    let read = || {
        let output = std::process::Command::new("sh")
            .arg("-c")
            .arg(read_checkout_script(&repo.to_string_lossy()))
            .env("PATH", &path)
            .env("GITLAB_TOKEN", "env-token")
            .output()
            .unwrap();
        let stdout = String::from_utf8_lossy(&output.stdout).into_owned();
        assert!(output.status.success());
        for secret in ["s3cr3t", "env-token", "hostless"] {
            assert!(!stdout.contains(secret), "{stdout}");
        }
        parse_checkout(&stdout)
    };
    // Only the source remote is read.
    let checkout = read();
    assert_eq!(checkout.branch.as_deref(), Some("myfix"));
    assert_eq!(checkout.upstream, upstream("fork", "myfix"));
    assert_eq!(
        checkout.remotes,
        pairs(&[("fork", "git@ssh.gitlab.other:me/gstreamer.git")])
    );
    assert_eq!(checkout.gitlab_host.as_deref(), Some("gitlab.example"));
    assert_eq!(checkout.gitlab_logins, ["gitlab.other"]);
    // GITLAB_TOKEN or a hostless token is no login to github.com.
    git(&["config", "branch.myfix.remote", "hub"]);
    let checkout = read();
    assert_eq!(
        checkout.remotes,
        pairs(&[("hub", "git@github.com:me/gstreamer.git")])
    );
    assert!(checkout.gitlab_logins.is_empty());
    // Without an upstream: the push remote, else origin.
    git(&["config", "--unset", "branch.myfix.remote"]);
    let checkout = read();
    assert_eq!(checkout.upstream, None);
    assert_eq!(
        checkout.remotes,
        pairs(&[("origin", "https://GitLab.Example/gst/gstreamer.git")])
    );
    assert!(checkout.gitlab_logins.is_empty());
    git(&["config", "remote.pushDefault", "fork"]);
    let checkout = read();
    assert_eq!(checkout.push_remote.as_deref(), Some("fork"));
    assert_eq!(
        checkout.remotes,
        pairs(&[("fork", "git@ssh.gitlab.other:me/gstreamer.git")])
    );
}

#[tokio::test]
async fn a_branch_started_from_origin_main_finds_the_users_merge_request_from_a_fork() {
    let (fake, calls) = lister(json!({"id": 1357}), |path| {
        if path.contains("scope=created_by_me") {
            json!([
                // Someone else's project into another one: not this.
                {"iid": 4, "state": "opened", "source_project_id": 5, "project_id": 6, "web_url": "y"},
                {"iid": 12855, "state": "opened", "source_project_id": 1372, "project_id": 1357,
                 "web_url": "https://gitlab.example/gst/gstreamer/-/merge_requests/12855", "title": "appsink"},
            ])
        } else {
            json!([])
        }
    });
    let context = context(fake);
    let mut checkout = fork_checkout();
    checkout.branch = Some("appsink-fix".into());
    checkout.upstream = upstream("origin", "main");
    let found = find_branch_merge_request(&context, &checkout, &Mutex::new(HashMap::new()))
        .await
        .unwrap();
    assert_eq!(found.map(|f| f.number), Some(12855));
    assert_eq!(
        last_words(&calls),
        vec![
            "projects/gst%2Fgstreamer",
            "merge_requests?scope=all&state=opened&source_branch=appsink-fix&per_page=100&page=1",
            "merge_requests?scope=created_by_me&state=opened&source_branch=appsink-fix&per_page=100&page=1",
        ]
    );
    // A tracked branch is never looked up by name among the user's own.
    calls.lock().unwrap().clear();
    let mut tracked = fork_checkout();
    tracked.upstream = upstream("fork", "fix-v2");
    find_branch_merge_request(&context, &tracked, &Mutex::new(HashMap::new()))
        .await
        .unwrap();
    assert!(
        !last_words(&calls)
            .iter()
            .any(|path| path.contains("created_by_me"))
    );
}

fn cwd_of(process: &ForgeProcess) -> Option<String> {
    match process {
        ForgeProcess::Cli { cwd, .. } => Some(cwd.clone()),
        ForgeProcess::Script { cwd, .. } => cwd.clone(),
        ForgeProcess::Ssh { .. } => None,
    }
}

#[tokio::test]
async fn a_merge_requests_removed_checkout_reads_from_gitlab_from_home() {
    let root = {
        let gone = tempfile::tempdir().unwrap();
        gone.path().to_string_lossy().into_owned()
    };
    let fake =
        Fake::sync(|process| host_probe(process, &[]).unwrap_or_else(|| answer_json(&mr_json())));
    let local = tools(fake.clone()).context(root.clone(), None);
    assert_eq!(
        read_merge_request(&local, URL).await.unwrap().head_sha,
        "h".repeat(40)
    );
    let home = std::env::var("HOME").unwrap();
    let cwds: Vec<Option<String>> = fake.processes.lock().unwrap().iter().map(cwd_of).collect();
    assert_eq!(cwds, [Some(home.clone()), Some(home)]);
    // Over SSH the shell goes home when the checkout is not there.
    let remote = local.tools.context(root.clone(), Some("builder".into()));
    read_merge_request(&remote, URL).await.unwrap();
    let last = words(fake.processes.lock().unwrap().last().unwrap()).join(" ");
    assert!(
        last.contains(&format!("{{ cd '{root}' 2>/dev/null || cd; }} && ")),
        "{last}"
    );
}

#[tokio::test]
async fn a_missing_glab_is_still_told_as_such() {
    let root = tempfile::tempdir().unwrap();
    let at = root.path().to_string_lossy().into_owned();
    let fake = Fake::sync(|_| Err(RunError::Missing("spawn glab ENOENT".into())));
    let context = tools(fake.clone()).context(at.clone(), None);
    let error = read_merge_request(&context, URL).await.unwrap_err();
    assert_eq!(error, "glab is not installed on this host");
    for process in fake.processes.lock().unwrap().iter() {
        assert_eq!(cwd_of(process).as_deref(), Some(at.as_str()));
    }
}

#[tokio::test]
async fn a_removed_checkout_is_told_as_such_when_finding_its_merge_request() {
    let fake = Fake::sync(|_| fail(2, "ROAMGATE-REVIEW-NO-CHECKOUT\n"));
    let context = tools(fake).context(
        "/var/home/me/upstreaming/validate-comparison-type",
        Some("builder".into()),
    );
    let error = read_checkout(&context).await.unwrap_err();
    assert_eq!(
        error,
        LoadError::Gone {
            code: "checkout-gone".into(),
            message:
                "This checkout no longer exists: /var/home/me/upstreaming/validate-comparison-type"
                    .into(),
        }
    );
}

#[tokio::test]
async fn paged_answers_keep_brackets_inside_code_and_comments() {
    // Two pages back to back, with `][` and `] [` inside strings.
    let (context, _) = fake_glab(vec![
        (
            "merge_requests/42/diffs",
            json!(
                r#"[{"old_path":"a.c","new_path":"a.c","diff":"@@ -1 +1 @@\n-x = m[i];\n+x = m[i][j];\n"}]
[{"old_path":"b.c","new_path":"b.c","diff":"@@ -1 +1 @@\n-a\n+b \"]\" [\n"}]"#
            ),
        ),
        (
            "merge_requests/42/discussions",
            json!(
                r#"[{"id":"abc1","notes":[{"id":1,"body":"see a[0][1] and [x] [y]","author":{"username":"r"}}]}][]"#
            ),
        ),
        ("merge_requests/42/draft_notes", json!("[]")),
        ("merge_requests/42", mr_json()),
    ]);
    let mr = read_merge_request(&context, URL).await.unwrap();
    let diff = read_merge_request_diff(&context, &mr).await.unwrap();
    assert_eq!(
        diff.files
            .iter()
            .map(|f| f.path.as_str())
            .collect::<Vec<_>>(),
        ["a.c", "b.c"]
    );
    assert!(
        serde_json::to_string(&diff.files[0])
            .unwrap()
            .contains("x = m[i][j];")
    );
    assert!(
        serde_json::to_string(&diff.files[1])
            .unwrap()
            .contains(r#"b \"]\" ["#)
    );
    let threads = read_merge_request_threads(&context, &mr, "s1")
        .await
        .unwrap();
    assert_eq!(threads[0].comments[0].body, "see a[0][1] and [x] [y]");
    assert_eq!(
        parse_json_pages(r#"[1, "a][b"] [2]"#).unwrap(),
        vec![json!([1, "a][b"]), json!([2])]
    );
    assert_eq!(
        parse_json_pages(r#"{"a": "}"}"#).unwrap(),
        vec![json!({"a": "}"})]
    );
    assert!(parse_json_pages("[1, 2").unwrap_err().contains("truncated"));
}

#[tokio::test]
async fn tokens_from_the_environment_go_only_to_glabs_default_host() {
    let api: Processes = Arc::default();
    let seen = api.clone();
    let fake = Fake::sync(move |process| {
        if let Some(probe) = host_probe(process, &["gitlab.other"]) {
            return probe;
        }
        seen.lock().unwrap().push(process.clone());
        answer_json(&mr_json())
    });
    let local = context(fake.clone());
    let hostname = regex::Regex::new(r"--hostname'? '?([a-z.]+)").unwrap();
    let host_of = |process: &ForgeProcess| {
        hostname
            .captures(&words(process).join(" "))
            .map(|found| found[1].to_owned())
            .unwrap_or_default()
    };
    let unset_of = |process: &ForgeProcess| match process {
        ForgeProcess::Cli { unset, .. } => unset.clone(),
        _ => panic!("a CLI on this machine"),
    };
    let last = || api.lock().unwrap().last().unwrap().clone();
    read_merge_request(&local, URL).await.unwrap();
    // glab's default host keeps the environment's token.
    assert!(unset_of(&last()).is_empty());
    // Another host glab has a login for: asked without the env's tokens.
    read_merge_request(
        &local,
        "https://gitlab.other/gst/gstreamer/-/merge_requests/42",
    )
    .await
    .unwrap();
    assert_eq!(host_of(&last()), "gitlab.other");
    assert_eq!(
        unset_of(&last()),
        TOKEN_VARIABLES.map(str::to_owned).to_vec()
    );
    // A host glab knows nothing of is never asked.
    let before = api.lock().unwrap().len();
    let error = read_merge_request(&local, "https://evil.example/a/b/-/merge_requests/1")
        .await
        .unwrap_err();
    assert!(
        error.contains("glab has no login for evil.example"),
        "{error}"
    );
    let mut evil = read_merge_request(&local, URL).await.unwrap();
    evil.host = "evil.example".into();
    let error = create_draft_note(&local, &evil, &ReviewAnchor::default(), "secret", None)
        .await
        .unwrap_err();
    assert!(error.contains("no login"), "{error}");
    assert_eq!(api.lock().unwrap().len(), before + 1);
    assert!(
        !api.lock()
            .unwrap()
            .iter()
            .any(|process| host_of(process) == "evil.example")
    );
    // Over SSH, the remote environment's tokens are removed the same way.
    let remote = local.tools.context("/repo", Some("builder".into()));
    read_merge_request(
        &remote,
        "https://gitlab.other/gst/gstreamer/-/merge_requests/42",
    )
    .await
    .unwrap();
    assert!(
        words(&last())
            .join(" ")
            .contains("env -u GITLAB_TOKEN -u GITLAB_ACCESS_TOKEN -u OAUTH_TOKEN")
    );
    read_merge_request(&remote, URL).await.unwrap();
    assert!(!words(&last()).join(" ").contains("env -u"));
    let error = read_merge_request(&remote, "https://evil.example/a/b/-/merge_requests/1")
        .await
        .unwrap_err();
    assert!(error.contains("no login"));
    assert!(
        fake.processes
            .lock()
            .unwrap()
            .iter()
            .all(|p| is_host_probe(p) || words(p).join(" ").contains("glab"))
    );
}

fn position_diff() -> Vec<ReviewDiffFile> {
    parse_unified_diff(
        &[
            "diff --git a/old.c b/a.c",
            "--- a/old.c",
            "+++ b/a.c",
            "@@ -8,5 +8,6 @@",
            " ctx8",
            " ctx9",
            " ctx10",
            "-gone11",
            "+added11",
            "+added12",
            " ctx13",
        ]
        .join("\n"),
    )
}

async fn position_of(anchor: ReviewAnchor, with_diff: bool) -> HashMap<String, String> {
    let (context, calls) = fake_glab(vec![
        (
            "merge_requests/42/draft_notes",
            json!({"id": 9, "note": "n", "position": null}),
        ),
        ("merge_requests/42", mr_json()),
    ]);
    let mr = read_merge_request(&context, URL).await.unwrap();
    let files = position_diff();
    create_draft_note(
        &context,
        &mr,
        &anchor,
        "n",
        with_diff.then_some(files.as_slice()),
    )
    .await
    .unwrap();
    let argv = calls.lock().unwrap().last().unwrap().clone();
    argv[7..]
        .iter()
        .skip(1)
        .step_by(2)
        .filter(|field| field.starts_with("position["))
        .map(|field| {
            let (key, value) = field.split_once('=').unwrap();
            (key.to_owned(), value.to_owned())
        })
        .collect()
}

fn anchor(path: &str, line: i64, end: Option<i64>, side: &str) -> ReviewAnchor {
    ReviewAnchor {
        path: Some(path.into()),
        line: Some(line),
        end_line: end,
        side: Some(side.into()),
        ..ReviewAnchor::default()
    }
}

#[tokio::test]
async fn ranges_and_old_side_lines_are_placed_as_gitlab_numbers_them() {
    let code = hex(&sha1::Sha1::digest(b"a.c"));
    let get = |map: &HashMap<String, String>, key: &str| map.get(key).cloned();
    // From an unchanged line to an added one: a line range, the note on
    // the added line with its new number only.
    let mut ranged = anchor("a.c", 10, Some(12), "new");
    ranged.context_old = Some(10);
    ranged.old_path = Some("old.c".into());
    let range = position_of(ranged, true).await;
    assert_eq!(get(&range, "position[new_line]").as_deref(), Some("12"));
    assert_eq!(get(&range, "position[old_line]"), None);
    assert_eq!(get(&range, "position[old_path]").as_deref(), Some("old.c"));
    assert_eq!(
        get(&range, "position[line_range][start][line_code]"),
        Some(format!("{code}_10_10"))
    );
    for (key, want) in [
        ("position[line_range][start][type]", "old"),
        ("position[line_range][start][old_line]", "10"),
        ("position[line_range][start][new_line]", "10"),
        ("position[line_range][end][type]", "new"),
        ("position[line_range][end][new_line]", "12"),
    ] {
        assert_eq!(get(&range, key).as_deref(), Some(want), "{key}");
    }
    assert_eq!(
        get(&range, "position[line_range][end][line_code]"),
        Some(format!("{code}_12_12"))
    );
    assert_eq!(get(&range, "position[line_range][end][old_line]"), None);
    // An unchanged line asked on the old side: both numbers.
    let unchanged = position_of(anchor("old.c", 9, None, "old"), true).await;
    assert_eq!(get(&unchanged, "position[old_line]").as_deref(), Some("9"));
    assert_eq!(get(&unchanged, "position[new_line]").as_deref(), Some("9"));
    // A removed line of a renamed file: its old number, both paths.
    let removed = position_of(anchor("old.c", 11, None, "old"), true).await;
    assert_eq!(get(&removed, "position[old_line]").as_deref(), Some("11"));
    assert_eq!(get(&removed, "position[new_line]"), None);
    assert_eq!(
        get(&removed, "position[old_path]").as_deref(),
        Some("old.c")
    );
    assert_eq!(get(&removed, "position[new_path]").as_deref(), Some("a.c"));
    assert_eq!(get(&removed, "position[line_range][start][type]"), None);
    // Without the diff, a range never claims an old number for its end.
    let mut blind_anchor = anchor("a.c", 10, Some(12), "new");
    blind_anchor.context_old = Some(10);
    let blind = position_of(blind_anchor, false).await;
    assert_eq!(get(&blind, "position[new_line]").as_deref(), Some("12"));
    assert_eq!(get(&blind, "position[old_line]"), None);
}
