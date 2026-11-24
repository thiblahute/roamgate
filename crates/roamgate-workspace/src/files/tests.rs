//! files.test.ts, filesystem-browsing.test.ts and audio-preview.test.ts's
//! handler cases.

use std::fs;
use std::path::Path;
use std::sync::Arc;

use roamgate_git::preview::AUDIO_INLINE_PREVIEW_MAX_BYTES;
use roamgate_git::{Ran, Request, shell_quote};
use serde_json::{Value, json};

use super::*;
use crate::test_support::{Loopback, LoopbackStreams, Scripted, connection};

fn temp(prefix: &str) -> tempfile::TempDir {
    tempfile::Builder::new().prefix(prefix).tempdir().unwrap()
}

fn text(path: &Path) -> String {
    path.to_str().unwrap().to_owned()
}

fn ok(stdout: &str) -> Result<Ran, roamgate_git::RunError> {
    Ok(Ran::new(0, stdout, ""))
}

async fn call(files: &Files, conn: &WorkspaceConnection, method: &str, params: Value) -> RpcResult {
    rpc(files, conn, method, &params, Some("127.0.0.1"))
        .await
        .unwrap()
}

fn unexpected(method: &str) -> Result<Value, String> {
    Err(format!("unexpected call {method}"))
}

#[tokio::test]
async fn commit_history_reports_a_non_git_workspace_without_inventing_an_empty_history() {
    let diagnostic = "fatal: not a git repository (or any of the parent directories): .git";
    let runner = Scripted::new(move |_: &Request| Ok(Ran::new(128, "", diagnostic)));
    let (conn, _) = connection(None, runner.clone(), |method, _| match method {
        "workspace.get" => Ok(json!({ "workspace": { "cwd": "/preview" } })),
        "pane.list" => Ok(json!({ "panes": [
            { "workspace_id": "w1", "focused": true, "cwd": "/preview" },
            { "workspace_id": "other", "cwd": "/unrelated-repo" },
        ] })),
        other => unexpected(other),
    });
    let error = call(
        &Files::new(),
        &conn,
        "git.commits",
        json!({ "workspace_id": "w1" }),
    )
    .await
    .unwrap_err();
    assert_eq!(error.message, diagnostic);
    assert_eq!(
        runner.argvs(),
        [["git", "-C", "/preview", "rev-parse", "--show-toplevel"]]
    );
}

#[tokio::test]
async fn commit_history_uses_the_workspace_checkout_and_renders_an_unborn_head_as_empty() {
    let count = std::sync::atomic::AtomicUsize::new(0);
    let runner = Scripted::new(move |_: &Request| {
        if count.fetch_add(1, std::sync::atomic::Ordering::SeqCst) == 0 {
            ok("/checkout\n")
        } else {
            Ok(Ran::new(1, "", ""))
        }
    });
    let (conn, _) = connection(None, runner.clone(), |method, _| match method {
        "workspace.get" => Ok(json!({ "workspace": {
            "worktree": { "checkout_path": "/checkout" }, "cwd": "/preview",
        } })),
        other => unexpected(other),
    });
    assert_eq!(
        call(
            &Files::new(),
            &conn,
            "git.commits",
            json!({ "workspace_id": "w1" })
        )
        .await
        .unwrap(),
        json!({ "head": null, "commits": [], "has_more": false, "shallow": false })
    );
    let argvs = runner.argvs();
    assert_eq!(argvs.len(), 2);
    assert_eq!(
        argvs[0],
        ["git", "-C", "/checkout", "rev-parse", "--show-toplevel"]
    );
    assert!(
        argvs[1]
            .last()
            .unwrap()
            .contains("git -C '/checkout' rev-parse -q --verify 'HEAD^{commit}'"),
        "{:?}",
        argvs[1]
    );
}

#[tokio::test]
async fn pr_mr_reads_accept_only_available_worktrees_listed_for_the_source_repository() {
    for host in [None, Some("user@server")] {
        let target = "/repo with 'quote/topic";
        let runner = Scripted::new(|_: &Request| ok("/repo\n"));
        let (conn, herdr) = connection(host, runner.clone(), move |method, params| {
            assert_eq!(params["workspace_id"], "w1");
            match method {
                "workspace.get" => {
                    Ok(json!({ "workspace": { "worktree": { "checkout_path": "/repo" } } }))
                }
                "worktree.list" => Ok(json!({ "worktrees": [
                    { "path": target },
                    { "path": "/repo/bare", "is_bare": true },
                    { "path": "/repo/gone", "is_prunable": true },
                ] })),
                other => unexpected(other),
            }
        });
        let files = Files::new();
        let asked = |worktree_path: Value| json!({ "workspace_id": "w1", "worktree_path": worktree_path, "summary": true });
        assert_eq!(
            files
                .pull_request_target(&conn, &asked(json!(target)))
                .await
                .unwrap(),
            PullRequestTarget::Root(target.into())
        );
        for worktree_path in [json!("/other/repo"), json!(42)] {
            runner.1.lock().unwrap().clear();
            let PullRequestTarget::Answer(answer) = files
                .pull_request_target(&conn, &asked(worktree_path))
                .await
                .unwrap()
            else {
                panic!("an answer");
            };
            assert_eq!(answer["state"], "error");
            assert!(
                answer["message"]
                    .as_str()
                    .unwrap()
                    .contains("Worktree is unavailable")
            );
            assert!(answer.get("retryable").is_none());
            assert_eq!(runner.argvs().len(), 1);
        }
        for worktree_path in ["/repo/bare", "/repo/gone"] {
            runner.1.lock().unwrap().clear();
            let PullRequestTarget::Answer(answer) = files
                .pull_request_target(&conn, &asked(json!(worktree_path)))
                .await
                .unwrap()
            else {
                panic!("an answer");
            };
            assert_eq!(answer["state"], "unsupported");
            assert_eq!(answer["root"], worktree_path);
            assert!(
                answer["message"]
                    .as_str()
                    .unwrap()
                    .contains("Bare or prunable")
            );
            assert_eq!(runner.argvs().len(), 1);
        }
        assert!(herdr.methods().contains(&"worktree.list".to_owned()));
    }
}

#[tokio::test]
async fn falls_back_to_focused_pane_cwd_when_workspace_has_no_checkout_path() {
    let dir = temp("herdr-gui-handler-test-");
    let root = text(dir.path());
    fs::create_dir(dir.path().join("src")).unwrap();
    fs::write(dir.path().join("README.md"), "hello").unwrap();
    let pane_root = root.clone();
    let (conn, herdr) = connection(None, Loopback::new(), move |method, _| match method {
        "workspace.get" => Ok(json!({ "workspace": { "workspace_id": "w1", "label": "Repo" } })),
        "pane.list" => Ok(json!({ "panes": [
            { "workspace_id": "w1", "focused": true, "foreground_cwd": pane_root },
        ] })),
        other => unexpected(other),
    });
    let list = call(
        &Files::new(),
        &conn,
        "file.list",
        json!({ "workspace_id": "w1" }),
    )
    .await
    .unwrap();
    assert_eq!(list["workspace_id"], "w1");
    assert_eq!(list["repo_name"], "Repo");
    assert_eq!(list["checkout_path"], json!(root));
    let names: Vec<&str> = list["entries"]
        .as_array()
        .unwrap()
        .iter()
        .map(|e| e["name"].as_str().unwrap())
        .collect();
    assert_eq!(names, ["src", "README.md"]);
    assert_eq!(herdr.methods(), ["workspace.get", "pane.list"]);
}

#[tokio::test]
async fn a_home_path_is_read_from_the_host_s_home_and_a_missing_one_says_so() {
    let dir = temp("herdr-gui-handler-test-");
    let home = dir.path().join("home");
    let checkout = dir.path().join("checkout");
    fs::create_dir_all(home.join("out")).unwrap();
    fs::create_dir(&checkout).unwrap();
    fs::write(home.join("out").join("notes.md"), "# Notes").unwrap();
    let checkout_text = text(&checkout);
    let (conn, _) = connection(
        None,
        Scripted::new(|_: &Request| ok("")),
        move |method, _| match method {
            "workspace.get" => {
                Ok(json!({ "workspace": { "worktree": { "checkout_path": checkout_text } } }))
            }
            other => unexpected(other),
        },
    );
    let home_text = text(&home);
    let files = Files::new().with_local_home(move || home_text.clone());
    let notes = json!({ "workspace_id": "w1", "path": "~/out/notes.md" });
    let read = call(&files, &conn, "file.read", notes.clone())
        .await
        .unwrap();
    assert_eq!(
        read["path"],
        json!(text(&home.join("out").join("notes.md")))
    );
    assert_eq!(read["text"], "# Notes");
    let stat = call(&files, &conn, "file.stat", notes).await.unwrap();
    assert_eq!(stat["type"], "file");
    let missing = call(
        &files,
        &conn,
        "file.read",
        json!({ "workspace_id": "w1", "path": "~/out/gone.wav" }),
    )
    .await
    .unwrap_err();
    assert!(
        missing.message.contains(&format!(
            "{} was not found",
            home.join("out").join("gone.wav").display()
        )),
        "{missing}"
    );
}

#[tokio::test]
async fn a_home_path_on_an_ssh_host_is_in_the_home_the_host_says_asked_once() {
    let runner = Scripted::new(|request: &Request| {
        let Invocation::Ssh { command, .. } = &request.invocation else {
            panic!("over SSH");
        };
        if command == "printf %s \"$HOME\"" {
            ok("/home/far\n")
        } else {
            Ok(Ran::new(1, "", "stop"))
        }
    });
    let (conn, _) = connection(Some("remote"), runner.clone(), |method, _| match method {
        "workspace.get" => Ok(json!({ "workspace": { "worktree": { "checkout_path": "/repo" } } })),
        other => unexpected(other),
    });
    let files = Files::new();
    for _ in 0..2 {
        let error = call(
            &files,
            &conn,
            "file.read",
            json!({ "workspace_id": "w1", "path": "~/a.wav" }),
        )
        .await
        .unwrap_err();
        assert_eq!(error.message, "stop");
    }
    let lines: Vec<String> = runner
        .argvs()
        .into_iter()
        .map(|argv| argv.last().unwrap().clone())
        .collect();
    assert_eq!(
        lines.iter().filter(|line| line.contains("$HOME")).count(),
        1
    );
    assert!(
        lines
            .last()
            .unwrap()
            .contains(&shell_quote("/home/far/a.wav"))
    );
}

#[tokio::test]
async fn prefers_pane_cwd_over_an_agent_foreground_directory_for_git_operations() {
    let runner = Scripted::new(|_: &Request| ok("/repo\n"));
    let (conn, _) = connection(None, runner.clone(), |method, _| match method {
        "workspace.get" => Ok(json!({ "workspace": { "workspace_id": "w1", "label": "Repo" } })),
        "pane.list" => Ok(json!({ "panes": [{
            "workspace_id": "w1", "focused": true, "cwd": "/repo", "foreground_cwd": "/agent/plugin",
        }] })),
        other => unexpected(other),
    });
    let resolved = Files::new()
        .workspace_git_root(&conn, &json!({ "workspace_id": "w1" }))
        .await
        .unwrap();
    assert_eq!(resolved.root, "/repo");
    assert_eq!(
        runner.argvs(),
        [["git", "-C", "/repo", "rev-parse", "--show-toplevel"]]
    );
}

#[tokio::test]
async fn finds_the_repository_of_another_pane_when_none_of_the_workspace_is_focused() {
    // Herdr focuses one pane in all of its workspaces: here another
    // workspace's. The workspace's folder holds repositories without being
    // one; its second pane is in one of them.
    let runner = Scripted::new(|request: &Request| {
        let argv = crate::test_support::local_argv(&request.invocation);
        let at = argv.iter().position(|w| w == "-C").unwrap();
        if argv[at + 1] == "/devel/blog" {
            ok("/devel/blog\n")
        } else {
            Ok(Ran::new(
                128,
                "",
                "fatal: not a git repository (or any of the parent directories): .git",
            ))
        }
    });
    let (conn, _) = connection(None, runner.clone(), |method, _| match method {
        "workspace.get" => Ok(json!({ "workspace": { "workspace_id": "w1", "label": "blog" } })),
        "pane.list" => Ok(json!({ "panes": [
            { "workspace_id": "other", "focused": true, "cwd": "/elsewhere" },
            { "workspace_id": "w1", "cwd": "/devel", "foreground_cwd": "/devel" },
            { "workspace_id": "w1", "cwd": "/devel/blog", "foreground_cwd": "/devel/blog" },
        ] })),
        other => unexpected(other),
    });
    let resolved = Files::new()
        .workspace_git_root(&conn, &json!({ "workspace_id": "w1" }))
        .await
        .unwrap();
    assert_eq!(resolved.root, "/devel/blog");
    assert_eq!(
        runner.argvs(),
        [
            ["git", "-C", "/devel", "rev-parse", "--show-toplevel"],
            ["git", "-C", "/devel/blog", "rev-parse", "--show-toplevel"],
        ]
    );
}

#[tokio::test]
async fn tries_the_focused_pane_of_the_workspace_before_its_others() {
    let runner = Scripted::new(|request: &Request| {
        let argv = crate::test_support::local_argv(&request.invocation);
        let at = argv.iter().position(|w| w == "-C").unwrap();
        ok(&format!("{}\n", argv[at + 1]))
    });
    let (conn, _) = connection(None, runner.clone(), |method, _| match method {
        "workspace.get" => Ok(json!({ "workspace": { "workspace_id": "w1" } })),
        "pane.list" => Ok(json!({ "panes": [
            { "workspace_id": "w1", "cwd": "/first" },
            { "workspace_id": "w1", "focused": true, "cwd": "/focused" },
        ] })),
        other => unexpected(other),
    });
    let resolved = Files::new()
        .workspace_git_root(&conn, &json!({ "workspace_id": "w1" }))
        .await
        .unwrap();
    assert_eq!(resolved.root, "/focused");
}

fn top_level_runner(map_lib: bool) -> Arc<Scripted> {
    Scripted::new(move |request: &Request| {
        let argv = crate::test_support::local_argv(&request.invocation);
        let at = argv.iter().position(|w| w == "-C").unwrap();
        let dir = argv[at + 1].clone();
        // /ws/app/lib is a subdirectory of /ws/app, not a repository.
        ok(&format!(
            "{}\n",
            if map_lib && dir == "/ws/app/lib" {
                "/ws/app".into()
            } else {
                dir
            }
        ))
    })
}

#[tokio::test]
async fn reads_another_repository_of_the_workspace_when_asked_by_its_root_and_no_other() {
    let runner = top_level_runner(true);
    let (conn, _) = connection(None, runner.clone(), |method, _| match method {
        "workspace.get" => Ok(json!({ "workspace": { "workspace_id": "w1", "label": "Repo" } })),
        "pane.list" => Ok(json!({ "panes": [
            { "workspace_id": "w1", "focused": true, "cwd": "/ws/app" },
            { "workspace_id": "w2", "cwd": "/elsewhere" },
        ] })),
        other => unexpected(other),
    });
    let files = Files::new();
    // Under a pane's directory, or holding it: read there.
    for root in ["/ws/app/vendor/sub", "/ws"] {
        runner.1.lock().unwrap().clear();
        let resolved = files
            .workspace_git_root(&conn, &json!({ "workspace_id": "w1", "root": root }))
            .await
            .unwrap();
        assert_eq!(resolved.root, root);
        assert_eq!(
            runner.argvs(),
            [["git", "-C", root, "rev-parse", "--show-toplevel"]]
        );
    }
    // Another workspace's directory, a relative path, not a top level.
    for root in ["/elsewhere", "ws/app", "/ws/app/../../etc"] {
        assert!(
            files
                .workspace_git_root(&conn, &json!({ "workspace_id": "w1", "root": root }))
                .await
                .is_err()
        );
    }
    let error = files
        .workspace_git_root(
            &conn,
            &json!({ "workspace_id": "w1", "root": "/ws/app/lib" }),
        )
        .await
        .unwrap_err();
    assert!(error.message.contains("top level"), "{error}");
}

#[tokio::test]
async fn reads_the_repository_of_a_review_held_for_the_connection_in_any_workspace_exactly_its_root()
 {
    let (conn, _) = connection(None, top_level_runner(false), |method, _| match method {
        "workspace.get" => Ok(json!({ "workspace": { "workspace_id": "w1", "label": "Repo" } })),
        "pane.list" => Ok(json!({ "panes": [{ "workspace_id": "w1", "cwd": "/ws/app" }] })),
        other => unexpected(other),
    });
    // A review from elsewhere: its repository is no pane's.
    let files = Files::new().with_review_roots(|| vec!["/reviews/other/".into()]);
    let resolved = files
        .workspace_git_root(
            &conn,
            &json!({ "workspace_id": "w1", "root": "/reviews/other" }),
        )
        .await
        .unwrap();
    assert_eq!(resolved.root, "/reviews/other");
    // Not what lies below or above it, nor anything else.
    for root in ["/reviews/other/sub", "/reviews", "/elsewhere"] {
        let error = files
            .workspace_git_root(&conn, &json!({ "workspace_id": "w1", "root": root }))
            .await
            .unwrap_err();
        assert!(error.message.contains("not a repository of this workspace"));
    }
}

fn checkout_herdr(root: String) -> impl Fn(&str, &Value) -> Result<Value, String> + Send + Sync {
    move |method, _| match method {
        "workspace.get" => Ok(json!({ "workspace": {
            "workspace_id": "w1",
            "worktree": { "checkout_path": root, "repo_name": "Repo" },
        } })),
        other => unexpected(other),
    }
}

async fn body(response: FileHttpResponse) -> Vec<u8> {
    response.body.collect().await.unwrap()
}

fn query(pairs: &[(&str, &str)]) -> String {
    url::form_urlencoded::Serializer::new(String::new())
        .extend_pairs(pairs)
        .finish()
}

#[tokio::test]
async fn returns_download_responses_with_safe_headers() {
    let dir = temp("herdr-gui-handler-test-");
    let root = dir.path();
    fs::write(root.join("测试.txt"), "hello").unwrap();
    fs::write(root.join("guide.pdf"), "%PDF-1.7").unwrap();
    let (conn, _) = connection(None, Loopback::new(), checkout_herdr(text(root)));
    let files = Files::new();
    let response = files
        .http_download(
            &conn,
            &query(&[("workspace_id", "w1"), ("path", "测试.txt")]),
            None,
            None,
        )
        .await;
    assert!(
        response
            .header("content-disposition")
            .unwrap()
            .contains("filename=\"__.txt\"")
    );
    assert_eq!(
        response.header("x-file-path").unwrap(),
        crate::file_paths::encode_uri_component("测试.txt")
    );
    assert_eq!(body(response).await, b"hello");

    let svg = "<svg xmlns=\"http://www.w3.org/2000/svg\"><script>alert(1)</script></svg>";
    fs::write(root.join("vector.svg"), svg).unwrap();
    let inline =
        |path: &'static str| query(&[("workspace_id", "w1"), ("path", path), ("inline", "1")]);
    let svg_response = files
        .http_download(&conn, &inline("vector.svg"), None, None)
        .await;
    assert_eq!(svg_response.header("content-type"), Some("image/svg+xml"));
    assert_eq!(
        svg_response.header("content-security-policy"),
        Some("sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:")
    );
    assert_eq!(
        svg_response.header("x-content-type-options"),
        Some("nosniff")
    );
    assert_eq!(body(svg_response).await, svg.as_bytes());

    let pdf = files
        .http_download(&conn, &inline("guide.pdf"), None, None)
        .await;
    assert_eq!(pdf.header("content-type"), Some("application/pdf"));
    assert!(
        pdf.header("content-disposition")
            .unwrap()
            .contains("inline;")
    );
    assert_eq!(pdf.header("cache-control"), Some("private, no-store"));
    assert_eq!(pdf.header("x-content-type-options"), Some("nosniff"));
    assert_eq!(body(pdf).await, b"%PDF-1.7");

    fs::write(root.join("take.wav"), "RIFF").unwrap();
    let audio = files
        .http_download(&conn, &inline("take.wav"), None, None)
        .await;
    assert_eq!(audio.header("content-type"), Some("audio/wav"));
    assert!(
        audio
            .header("content-disposition")
            .unwrap()
            .contains("inline;")
    );
    assert_eq!(audio.header("x-content-type-options"), Some("nosniff"));
    assert_eq!(body(audio).await, b"RIFF");
}

#[tokio::test]
async fn downloads_a_large_apk_whole_and_streamed_as_an_android_package_locally_and_over_ssh() {
    let dir = temp("herdr-gui-handler-test-");
    let root = dir.path();
    fs::create_dir_all(root.join("app").join("build")).unwrap();
    // Far past the 512 KB preview and the old base64 read over SSH.
    let size = 20 * 1024 * 1024 + 123;
    let mut bytes = vec![0u8; size];
    for i in (0..size).step_by(4096) {
        bytes[i] = (i / 4096) as u8;
    }
    fs::write(root.join("app").join("build").join("app-debug.apk"), &bytes).unwrap();
    for host in [None, Some("user@server")] {
        let runner = Loopback::new();
        let streams = LoopbackStreams::new(|| {});
        let (conn, _) = connection(host, runner.clone(), checkout_herdr(text(root)));
        let files = Files::new().with_streams(streams.clone());
        let response = files
            .http_download(
                &conn,
                &query(&[("workspace_id", "w1"), ("path", "app/build/app-debug.apk")]),
                None,
                None,
            )
            .await;
        assert_eq!(response.status, 200);
        assert_eq!(
            response.header("content-type"),
            Some("application/vnd.android.package-archive")
        );
        assert_eq!(
            response.header("content-length"),
            Some(size.to_string().as_str())
        );
        assert!(
            response
                .header("content-disposition")
                .unwrap()
                .contains("filename=\"app-debug.apk\"")
        );
        // Over SSH only the metadata is read whole: never the file.
        for output in runner.outputs.lock().unwrap().iter() {
            assert!(*output < 4096);
        }
        match host {
            Some(_) => assert!(matches!(response.body, FileBody::Stream(_))),
            None => assert!(matches!(response.body, FileBody::File { .. })),
        }
        let got = body(response).await;
        assert_eq!(got.len(), size);
        assert!(got == bytes);
        assert_eq!(
            streams.spawned.lock().unwrap().len(),
            usize::from(host.is_some())
        );
    }
}

#[tokio::test]
async fn resolves_existing_workspace_relative_files_and_directories_in_one_batch() {
    let dir = temp("herdr-gui-handler-test-");
    let root = dir.path();
    fs::create_dir_all(root.join("a").join("b")).unwrap();
    fs::write(root.join("a").join("b").join("c.png"), "image").unwrap();
    let (conn, _) = connection(None, Loopback::new(), checkout_herdr(text(root)));
    let result = call(
        &Files::new(),
        &conn,
        "file.resolve",
        json!({ "workspace_id": "w1", "paths": [
            "a/b/c.png", "./a/b/c.png", "a/b", "missing/file.png", "../outside.txt",
        ] }),
    )
    .await
    .unwrap();
    assert_eq!(
        result,
        json!({
            "workspace_id": "w1",
            "checkout_path": text(root),
            "files": [
                { "candidate": "a/b/c.png", "path": "a/b/c.png" },
                { "candidate": "./a/b/c.png", "path": "a/b/c.png" },
                { "candidate": "a/b", "path": "a/b" },
            ],
        })
    );
}

#[tokio::test]
async fn validates_required_workspace_ids() {
    let (conn, _) = connection(None, Loopback::new(), |_, _| Ok(json!({})));
    let files = Files::new();
    for (method, params, message) in [
        ("file.list", json!({}), "file.list requires workspace_id"),
        (
            "file.read",
            json!({ "path": "README.md" }),
            "file.read requires workspace_id",
        ),
        (
            "file.resolve",
            json!({ "paths": [] }),
            "file.resolve requires workspace_id",
        ),
    ] {
        assert_eq!(
            call(&files, &conn, method, params)
                .await
                .unwrap_err()
                .message,
            message
        );
    }
}

#[tokio::test]
async fn a_windows_host_is_refused_its_files_and_transfers() {
    let (mut conn, herdr) = connection(Some("win"), Loopback::new(), |_, _| Ok(json!({})));
    conn.remote_platform = Some("windows".into());
    let files = Files::new();
    assert_eq!(
        call(&files, &conn, "file.list", json!({ "workspace_id": "w1" }))
            .await
            .unwrap_err()
            .message,
        "Workspace file and Git access requires a Unix SSH host and is unavailable on Windows."
    );
    let refused = files.http_delete(&conn, "workspace_id=w1&path=a").await;
    assert_eq!(refused.status, 501);
    assert!(herdr.methods().is_empty());
    assert!(
        rpc(&files, &conn, "git.pull_request", &json!({}), None)
            .await
            .is_none()
    );
}

// filesystem-browsing.test.ts

struct Fixture {
    _dir: tempfile::TempDir,
    workspace: String,
    refs: String,
}

fn browsing_fixture() -> Fixture {
    let dir = temp("herdr-filesystem-");
    let root = real(dir.path());
    let workspace = format!("{root}/workspace");
    let refs = format!("{root}/reference materials");
    fs::create_dir(&workspace).unwrap();
    fs::create_dir(&refs).unwrap();
    fs::write(format!("{workspace}/workspace.md"), "workspace").unwrap();
    fs::write(format!("{refs}/readme.md"), "reference").unwrap();
    fs::write(format!("{refs}/.hidden.md"), "hidden").unwrap();
    std::os::unix::fs::symlink(&refs, format!("{workspace}/external")).unwrap();
    Fixture {
        _dir: dir,
        workspace,
        refs,
    }
}

fn browsing(workspace: &str) -> WorkspaceConnection {
    let cwd = workspace.to_owned();
    let runner = Scripted::new(|request: &Request| {
        // check-ignore outside a repository: nothing ignored.
        assert!(
            matches!(request.invocation, Invocation::Local(_)),
            "Unexpected remote call"
        );
        Ok(Ran::new(128, "", ""))
    });
    connection(None, runner, move |method, _| {
        assert_eq!(method, "workspace.get");
        Ok(json!({ "workspace": { "workspace_id": "w1", "label": "Workspace", "cwd": cwd } }))
    })
    .0
}

fn paths(list: &Value) -> Vec<String> {
    list["entries"]
        .as_array()
        .unwrap()
        .iter()
        .map(|e| e["path"].as_str().unwrap().to_owned())
        .collect()
}

#[tokio::test]
async fn workspace_listings_stay_confined_opt_in_browsing_can_leave_the_checkout() {
    let Fixture {
        _dir,
        workspace,
        refs,
    } = browsing_fixture();
    let conn = browsing(&workspace);
    let files = Files::new();
    let list = |mut params: Value| {
        params["workspace_id"] = json!("w1");
        let (files, conn) = (&files, &conn);
        async move { call(files, conn, "file.list", params).await }
    };
    let default_list = list(json!({})).await.unwrap();
    assert_eq!(default_list["root"], json!(workspace));
    assert_eq!(paths(&default_list), ["external", "workspace.md"]);
    for params in [
        json!({ "path": "../reference materials" }),
        json!({ "path": "external" }),
        json!({ "path": refs, "scope": "workspace" }),
    ] {
        assert!(list(params).await.is_err());
    }
    let filesystem = list(json!({
        "scope": "filesystem",
        "path": format!("{workspace}/../reference materials"),
    }))
    .await
    .unwrap();
    assert_eq!(filesystem["root"], json!(refs));
    assert_eq!(filesystem["checkout_path"], json!(workspace));
    assert_eq!(filesystem["scope"], "filesystem");
    assert_eq!(paths(&filesystem), [format!("{refs}/readme.md")]);
    let hidden = list(json!({ "scope": "filesystem", "path": refs, "show_hidden": true }))
        .await
        .unwrap();
    assert_eq!(hidden["entries"].as_array().unwrap().len(), 2);
    let root_list = list(json!({ "scope": "filesystem", "path": workspace }))
        .await
        .unwrap();
    let external = root_list["entries"]
        .as_array()
        .unwrap()
        .iter()
        .find(|e| e["name"] == "external")
        .unwrap();
    assert_eq!(external["type"], "directory");
    let linked = list(json!({ "scope": "filesystem", "path": format!("{workspace}/external") }))
        .await
        .unwrap();
    assert_eq!(linked["root"], json!(refs));
    assert_eq!(list(json!({})).await.unwrap()["root"], json!(workspace));
}

#[tokio::test]
async fn external_references_preview_and_download_without_widening_upload_or_delete_targets() {
    let Fixture {
        _dir,
        workspace,
        refs,
    } = browsing_fixture();
    let conn = browsing(&workspace);
    let files = Files::new();
    let path = format!("{refs}/readme.md");
    let read = call(
        &files,
        &conn,
        "file.read",
        json!({ "workspace_id": "w1", "path": path }),
    )
    .await
    .unwrap();
    assert_eq!(read["path"], json!(path));
    assert_eq!(read["text"], "reference");
    let response = files
        .http_download(
            &conn,
            &query(&[
                ("workspace_id", "w1"),
                ("path", &path),
                ("scope", "filesystem"),
            ]),
            None,
            None,
        )
        .await;
    assert_eq!(body(response).await, b"reference");
    let workspace_scope = files
        .http_download(
            &conn,
            &query(&[("workspace_id", "w1"), ("path", &path)]),
            None,
            None,
        )
        .await;
    assert_eq!(workspace_scope.status, 400);
    let deleted = files
        .http_delete(
            &conn,
            &query(&[
                ("workspace_id", "w1"),
                ("path", &path),
                ("scope", "filesystem"),
            ]),
        )
        .await;
    assert_eq!(deleted.status, 400);
    let uploaded = files
        .http_upload(
            &conn,
            &query(&[
                ("workspace_id", "w1"),
                ("directory", &refs),
                ("filename", "readme.md"),
                ("scope", "filesystem"),
            ]),
            b"changed",
        )
        .await;
    assert_eq!(uploaded.status, 400);
    assert_eq!(fs::read_to_string(&path).unwrap(), "reference");
}

#[tokio::test]
async fn ssh_directory_listings_support_quoted_external_directories_and_the_filesystem_root() {
    for target in ["quoted external directories", "filesystem root"] {
        let Fixture { _dir, refs, .. } = browsing_fixture();
        let path = if target == "filesystem root" {
            "/".to_owned()
        } else {
            refs.clone()
        };
        let cx = roamgate_git::GitContext::new(Some("fixture".into()), Loopback::new());
        let list = remote_files::list_remote_files(&cx, "fixture", &path, "", false)
            .await
            .unwrap();
        assert_eq!(list.root, path);
        if path == refs {
            let names: Vec<_> = list.entries.iter().map(|e| e.name.as_str()).collect();
            assert_eq!(names, ["readme.md"]);
        }
    }
}

// audio-preview.test.ts's handler case: the HTTP serialization and the
// connection's lease are the adapter's (Bun's publishConnectionHttpResponse).

struct Get {
    path: String,
    inline: bool,
    range: Option<&'static str>,
    if_range: Option<&'static str>,
    scope: Option<&'static str>,
}

fn get(path: impl Into<String>, range: Option<&'static str>) -> Get {
    Get {
        path: path.into(),
        inline: true,
        range,
        if_range: None,
        scope: None,
    }
}

async fn fetch(files: &Files, conn: &WorkspaceConnection, get: Get) -> FileHttpResponse {
    let mut pairs = vec![("workspace_id", "w1".to_owned()), ("path", get.path)];
    if get.inline {
        pairs.push(("inline", "1".into()));
    }
    if let Some(scope) = get.scope {
        pairs.push(("scope", scope.into()));
    }
    let query = url::form_urlencoded::Serializer::new(String::new())
        .extend_pairs(pairs)
        .finish();
    files
        .http_download(conn, &query, get.range, get.if_range)
        .await
}

#[tokio::test]
async fn audio_http_ranges_and_size_limits() {
    for remote in [false, true] {
        let dir = tempfile::Builder::new()
            .prefix("roamgate-audio-'")
            .tempdir()
            .unwrap();
        let root = dir.path();
        let bytes: Vec<u8> = (0..150_000).map(|i| (i % 251) as u8).collect();
        fs::write(root.join("clip.WAV"), &bytes).unwrap();
        let large = fs::File::create(root.join("large.wav")).unwrap();
        large
            .set_len(AUDIO_INLINE_PREVIEW_MAX_BYTES as u64 + 1)
            .unwrap();
        std::os::unix::fs::symlink(root.join("large.wav"), root.join("alias.txt")).unwrap();
        let runner = Loopback::new();
        let host = remote.then_some("example.invalid");
        let (conn, _) = connection(host, runner.clone(), checkout_herdr(text(root)));
        let files = Files::new();
        let whole = fetch(&files, &conn, get("clip.WAV", None)).await;
        assert_eq!(whole.status, 200);
        assert_eq!(whole.header("content-type"), Some("audio/wav"));
        assert_eq!(whole.header("accept-ranges"), Some("bytes"));
        assert_eq!(body(whole).await, bytes);

        for (range, start, end) in [
            ("bytes=0-1", 0usize, 2usize),
            ("bytes=65535-65537", 65535, 65538),
            ("bytes=149997-", 149_997, 150_000),
            ("bytes=-3", 149_997, 150_000),
            ("bytes=149997-999999", 149_997, 150_000),
        ] {
            runner.outputs.lock().unwrap().clear();
            let partial = fetch(&files, &conn, get("clip.WAV", Some(range))).await;
            assert_eq!(partial.status, 206, "{range}");
            assert_eq!(
                partial.header("content-range").unwrap(),
                format!("bytes {start}-{}/{}", end - 1, bytes.len())
            );
            assert_eq!(
                partial.header("content-length").unwrap(),
                (end - start).to_string()
            );
            assert_eq!(partial.header("x-content-type-options"), Some("nosniff"));
            assert_eq!(body(partial).await, &bytes[start..end]);
            if remote {
                let sent: usize = runner.outputs.lock().unwrap().iter().sum();
                assert!(sent < bytes.len() * 4 / 3, "{range}: {sent}");
            }
        }

        let stale = fetch(
            &files,
            &conn,
            Get {
                if_range: Some("\"stale\""),
                ..get("clip.WAV", Some("bytes=1-"))
            },
        )
        .await;
        assert_eq!(stale.status, 200);
        assert_eq!(stale.header("content-range"), None);
        assert_eq!(body(stale).await, bytes);

        let outside = fetch(&files, &conn, get("clip.WAV", Some("bytes=150000-"))).await;
        assert_eq!(outside.status, 416);
        assert_eq!(outside.header("content-range"), Some("bytes */150000"));

        let external = fetch(
            &files,
            &conn,
            Get {
                scope: Some("filesystem"),
                ..get(text(&root.join("clip.WAV")), Some("bytes=0-1"))
            },
        )
        .await;
        assert_eq!(external.status, 206);
        assert_eq!(body(external).await, &bytes[..2]);

        for path in ["large.wav", "alias.txt"] {
            runner.outputs.lock().unwrap().clear();
            let too_large = fetch(&files, &conn, get(path, Some("bytes=0-1"))).await;
            assert_eq!(too_large.status, 413);
            assert!(
                String::from_utf8(body(too_large).await)
                    .unwrap()
                    .contains("Use Download")
            );
            if remote {
                assert_eq!(*runner.outputs.lock().unwrap(), [0]);
            }
        }
        let download = fetch(
            &files,
            &conn,
            Get {
                inline: false,
                ..get("large.wav", Some("bytes=0-1"))
            },
        )
        .await;
        assert_eq!(download.status, 206);
        assert!(
            download
                .header("content-disposition")
                .unwrap()
                .starts_with("attachment;")
        );
        assert_eq!(body(download).await.len(), 2);
    }
}

// git-actions.test.ts: createFileHandlers' Git support end to end.

fn git_in(root: &Path, args: &[&str]) -> String {
    let output = std::process::Command::new("git")
        .arg("-C")
        .arg(root)
        .args(args)
        .output()
        .unwrap();
    assert!(output.status.success(), "{output:?}");
    String::from_utf8_lossy(&output.stdout).into_owned()
}

/// A repository with `tracked.txt` committed.
fn action_repository() -> tempfile::TempDir {
    let dir = temp("herdr-git-actions-");
    let root = dir.path();
    git_in(root, &["init", "-b", "main"]);
    git_in(root, &["config", "user.email", "test@example.com"]);
    git_in(root, &["config", "user.name", "Herdr Test"]);
    fs::write(root.join("tracked.txt"), "base\n").unwrap();
    git_in(root, &["add", "tracked.txt"]);
    git_in(root, &["commit", "-m", "initial"]);
    dir
}

fn on_checkout(root: &Path) -> WorkspaceConnection {
    connection(None, Loopback::new(), checkout_herdr(text(root))).0
}

#[tokio::test]
async fn runs_file_and_repo_actions_against_a_real_repository() {
    let dir = action_repository();
    let root = dir.path();
    let conn = on_checkout(root);
    let files = Files::new();
    fs::write(root.join("new.txt"), "fresh\n").unwrap();
    let staged = call(
        &files,
        &conn,
        "git.file_action",
        json!({ "workspace_id": "w1", "action": "stage", "path": "new.txt" }),
    )
    .await
    .unwrap();
    assert_eq!(staged["workspace_id"], "w1");
    assert_eq!(staged["root"], text(&fs::canonicalize(root).unwrap()));
    assert_eq!(staged["action"], "stage");
    assert_eq!(staged["path"], "new.txt");
    let status = git_in(
        root,
        &[
            "-c",
            "core.quotepath=false",
            "status",
            "--porcelain=v1",
            "--untracked-files=all",
        ],
    );
    assert!(status.contains("A  new.txt"), "{status}");
    let repo = call(
        &files,
        &conn,
        "git.repo_action",
        json!({ "workspace_id": "w1", "action": "unstage_all" }),
    )
    .await
    .unwrap();
    assert_eq!(repo["counts"]["staged"], 0);
    assert_eq!(repo["counts"]["untracked"], 1);
}

#[tokio::test]
async fn attaches_worktree_fingerprints_to_working_summary_entries() {
    let dir = action_repository();
    let root = dir.path();
    fs::write(root.join("tracked.txt"), "changed\n").unwrap();
    let summary = call(
        &Files::new(),
        &on_checkout(root),
        "git.diff_summary",
        json!({ "workspace_id": "w1", "mode": "working" }),
    )
    .await
    .unwrap();
    let modified = summary["entries"]
        .as_array()
        .unwrap()
        .iter()
        .find(|entry| entry["path"] == "tracked.txt")
        .unwrap();
    assert_eq!(modified["size"], "changed\n".len());
    assert!(modified["mtime_ms"].as_f64().unwrap_or(0.0) > 0.0);
}

#[tokio::test]
async fn marks_git_ignored_entries_in_file_listings() {
    let dir = action_repository();
    let root = dir.path();
    fs::write(root.join(".gitignore"), "build-output/\n*.log\n").unwrap();
    fs::create_dir(root.join("build-output")).unwrap();
    fs::write(root.join("debug.log"), "x").unwrap();
    let list = call(
        &Files::new(),
        &on_checkout(root),
        "file.list",
        json!({ "workspace_id": "w1", "show_hidden": true }),
    )
    .await
    .unwrap();
    let entry = |name: &str| {
        list["entries"]
            .as_array()
            .unwrap()
            .iter()
            .find(|entry| entry["name"] == name)
            .cloned()
            .unwrap()
    };
    assert_eq!(entry("debug.log")["ignored"], true);
    assert_eq!(entry("build-output")["ignored"], true);
    assert!(entry("tracked.txt").get("ignored").is_none());
    assert!(entry(".gitignore").get("ignored").is_none());
}

// html-preview.test.ts's handler case.

#[tokio::test]
async fn renders_bounded_utf_8_html_with_exact_policy_and_leaves_ordinary_downloads_intact() {
    let dir = temp("roamgate-html-preview-");
    let root = dir.path();
    let max = roamgate_git::preview::PREVIEW_MAX_BYTES;
    let mut html = "<!doctype html><h1>boundary marker</h1>".to_owned();
    html.push_str(&" ".repeat(max - html.len()));
    fs::write(root.join("page.HTM"), &html).unwrap();
    let conn = on_checkout(root);
    let files = Files::new();
    let inline = query(&[
        ("workspace_id", "w1"),
        ("path", "page.HTM"),
        ("inline", "1"),
    ]);
    let plain = query(&[("workspace_id", "w1"), ("path", "page.HTM")]);
    let response = files.http_download(&conn, &inline, None, None).await;
    assert_eq!(response.status, 200);
    assert_eq!(
        response.header("content-type"),
        Some("text/html; charset=utf-8")
    );
    assert!(
        response
            .header("content-disposition")
            .unwrap()
            .starts_with("inline;")
    );
    assert_eq!(
        response.header("content-security-policy"),
        Some(crate::html_preview::HTML_PREVIEW_CSP)
    );
    assert_eq!(
        crate::html_preview::HTML_PREVIEW_CSP,
        "sandbox; default-src 'none'; base-uri 'none'; form-action 'none'; style-src 'unsafe-inline' data: https:; img-src data:; font-src data:"
    );
    assert_eq!(response.header("referrer-policy"), Some("no-referrer"));
    assert_eq!(response.header("x-content-type-options"), Some("nosniff"));
    assert!(
        String::from_utf8(body(response).await)
            .unwrap()
            .contains("boundary marker")
    );
    fs::write(root.join("page.HTM"), format!("{html}x")).unwrap();
    assert_eq!(
        files.http_download(&conn, &inline, None, None).await.status,
        413
    );
    let download = files.http_download(&conn, &plain, None, None).await;
    assert!(
        download
            .header("content-disposition")
            .unwrap()
            .starts_with("attachment;")
    );
    assert_eq!(body(download).await, format!("{html}x").into_bytes());
}
