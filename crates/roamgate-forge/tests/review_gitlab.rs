//! review/gitlab-service.test.ts: the merge request reviews of GitLab
//! mode, the review service on roamgate-forge's forge against a fake glab.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use roamgate_base::clock::{BoxFuture, Clock, TokioClock};
use roamgate_base::paths::{DataContext, Platform};
use roamgate_forge::gate::{ForgeGate, ProcessOutput, without_gate_flags};
use roamgate_forge::review::{
    ContextOf, ForgeProcess, ForgeRunner, ForgeTools, MergeRequestForge, RunError,
};
use roamgate_review::diff::parse_unified_diff;
use roamgate_review::model::{ReviewSession, ReviewThread};
use roamgate_review::service::host::{Ask, Load};
use roamgate_review::service::{ReviewForge, ReviewHost, ReviewService, ReviewServiceOptions};
use roamgate_review::storage::ReviewStorage;
use serde_json::{Value, json};
use tokio::sync::watch;

type Hold = Arc<dyn Fn(&str) -> Option<watch::Receiver<bool>> + Send + Sync>;

#[derive(Clone, Default)]
struct Options {
    /// The project GitLab answers in the merge request's web_url.
    web_project: Option<&'static str>,
    /// Every glab call fails, as when GitLab is unreachable.
    fail: Option<Arc<Mutex<bool>>>,
    /// Holds a write (POST/PUT/DELETE) until its gate opens.
    hold: Option<Hold>,
    /// A write GitLab refuses.
    refuse: Option<Arc<Mutex<bool>>>,
    /// What load_diff answers.
    diff: Option<Value>,
    /// Agents' prompts are kept here.
    prompts: Option<Arc<Mutex<Vec<String>>>>,
    /// The merge request's updated_at.
    updated_at: Option<Arc<Mutex<String>>>,
    /// The checkout's branch `fix` is the merge request's source.
    checkout: bool,
}

#[derive(Debug, Clone, PartialEq)]
struct FakeDraft {
    id: i64,
    note: String,
    position: Value,
}

#[derive(Default)]
struct Glab {
    writes: Mutex<Vec<(String, Vec<String>)>>,
    reads: Mutex<Vec<String>>,
    drafts: Mutex<Vec<FakeDraft>>,
    next: Mutex<i64>,
}

fn field(argv: &[String], name: &str) -> Option<String> {
    argv.iter()
        .find_map(|arg| arg.strip_prefix(&format!("{name}=")).map(str::to_owned))
}

fn out(code: i32, stdout: impl Into<String>, stderr: &str) -> Result<ProcessOutput, RunError> {
    Ok(ProcessOutput {
        code,
        stdout: stdout.into(),
        stderr: stderr.into(),
    })
}

struct Runner {
    glab: Arc<Glab>,
    options: Options,
}

impl Runner {
    fn answer(&self, argv: &[String]) -> Result<ProcessOutput, RunError> {
        let glab = &self.glab;
        let method = argv[argv.iter().position(|a| a == "--method").unwrap() + 1].clone();
        let path = argv
            .iter()
            .find(|arg| arg.starts_with("projects/") || arg.starts_with("merge_requests?"))
            .cloned()
            .unwrap_or_default();
        if method != "GET" {
            if self
                .options
                .refuse
                .as_ref()
                .is_some_and(|r| *r.lock().unwrap())
            {
                return out(1, "", "502 Bad Gateway");
            }
            let id: i64 = regex::Regex::new(r"draft_notes/(\d+)")
                .unwrap()
                .captures(&path)
                .map_or(0, |found| found[1].parse().unwrap());
            let mut drafts = glab.drafts.lock().unwrap();
            if method == "DELETE" {
                drafts.retain(|draft| draft.id != id);
                return out(0, "", "");
            }
            let draft_json = |draft: &FakeDraft| {
                json!({"id": draft.id, "note": draft.note, "position": draft.position}).to_string()
            };
            if method == "PUT" {
                let draft = drafts.iter_mut().find(|draft| draft.id == id).unwrap();
                if let Some(note) = field(argv, "note") {
                    draft.note = note;
                }
                return out(0, draft_json(draft), "");
            }
            let mut next = glab.next.lock().unwrap();
            *next += 1;
            let draft = FakeDraft {
                id: 99 + *next,
                note: field(argv, "note").unwrap_or_default(),
                position: field(argv, "position[new_path]")
                    .map_or(Value::Null, |path| json!({"new_path": path})),
            };
            drafts.push(draft.clone());
            return out(0, draft_json(&draft), "");
        }
        glab.reads.lock().unwrap().push(path.clone());
        let body = if path.contains("/discussions") {
            json!([{"id": "d1", "notes": [{"id": 1, "body": "Hm", "author": {"username": "x"}}]}])
        } else if path.contains("/draft_notes") {
            Value::Array(
                glab.drafts
                    .lock()
                    .unwrap()
                    .iter()
                    .map(|d| json!({"id": d.id, "note": d.note, "position": d.position}))
                    .collect(),
            )
        } else if path.starts_with("merge_requests?") {
            json!([{"iid": 3, "state": "opened", "source_project_id": 1,
                    "web_url": "https://gitlab.example/g/p/-/merge_requests/3", "title": "t"}])
        } else if path == "projects/g%2Fp" {
            json!({"id": 1})
        } else {
            let mut mr = json!({
                "web_url": self.options.web_project.map_or("u".to_owned(), |project| {
                    format!("https://gitlab.example/{project}/-/merge_requests/3")
                }),
                "title": "t",
                "state": "opened",
                "diff_refs": {
                    "base_sha": "b".repeat(40),
                    "start_sha": "b".repeat(40),
                    "head_sha": "c".repeat(40),
                },
            });
            if let Some(updated) = &self.options.updated_at {
                mr["updated_at"] = json!(updated.lock().unwrap().clone());
            }
            mr
        };
        out(0, body.to_string(), "")
    }
}

impl ForgeRunner for Runner {
    fn run(&self, process: ForgeProcess, _: u64) -> BoxFuture<Result<ProcessOutput, RunError>> {
        let answer = match &process {
            ForgeProcess::Script { script, .. }
                if script.contains("glab config get host") && !script.contains("symbolic-ref") =>
            {
                out(0, "glab gitlab.example\n", "")
            }
            ForgeProcess::Script { .. } if self.options.checkout => out(
                0,
                "branch fix\nhead aaaa\nremote origin\nmerge refs/heads/fix\npushremote \nglab gitlab.example\nurl origin https://gitlab.example/g/p.git\n",
                "",
            ),
            ForgeProcess::Script { .. } => out(1, "", "no checkout here"),
            ForgeProcess::Ssh { .. } => panic!("no SSH here"),
            ForgeProcess::Cli { argv, .. } => {
                if self
                    .options
                    .fail
                    .as_ref()
                    .is_some_and(|f| *f.lock().unwrap())
                {
                    out(1, "", "connection timed out")
                } else {
                    let argv = without_gate_flags(argv);
                    let method =
                        argv[argv.iter().position(|a| a == "--method").unwrap() + 1].clone();
                    if method != "GET" {
                        self.glab
                            .writes
                            .lock()
                            .unwrap()
                            .push((method.clone(), argv.clone()));
                        if let Some(gate) =
                            self.options.hold.as_ref().and_then(|hold| hold(&method))
                        {
                            let runner = Runner {
                                glab: self.glab.clone(),
                                options: self.options.clone(),
                            };
                            return Box::pin(async move {
                                let mut gate = gate;
                                let _ = gate.wait_for(|open| *open).await;
                                runner.answer(&argv)
                            });
                        }
                    }
                    self.answer(&argv)
                }
            }
        };
        Box::pin(async move { answer })
    }
}

/// A load_diff's commit and paths.
type DiffLoad = (Option<String>, Option<Vec<String>>);

struct Host {
    forge: Arc<MergeRequestForge>,
    diff: Option<Value>,
    diff_loads: Mutex<Vec<DiffLoad>>,
    prompts: Option<Arc<Mutex<Vec<String>>>>,
}

impl ReviewHost for Host {
    fn load_diff(
        &self,
        _: &ReviewSession,
        commit: Option<String>,
        paths: Option<Vec<String>>,
    ) -> Load<Value> {
        self.diff_loads.lock().unwrap().push((commit, paths));
        let diff = self
            .diff
            .clone()
            .unwrap_or_else(|| json!({"files": [], "truncated": false}));
        Box::pin(async move { Ok(diff) })
    }

    fn can_prompt(&self) -> bool {
        self.prompts.is_some()
    }

    fn prompt_agent(&self, _: &str, _: &str, text: String) -> Ask<()> {
        if let Some(prompts) = &self.prompts {
            prompts.lock().unwrap().push(text);
        }
        Box::pin(async { Ok(()) })
    }

    fn forge(&self) -> Option<Arc<dyn ReviewForge>> {
        Some(self.forge.clone())
    }
}

struct Setup {
    service: ReviewService,
    glab: Arc<Glab>,
    host: Arc<Host>,
    dir: Arc<tempfile::TempDir>,
}

fn make_in(options: Options, dir: Option<Arc<tempfile::TempDir>>) -> Setup {
    let dir = dir.unwrap_or_else(|| Arc::new(tempfile::tempdir().unwrap()));
    let glab = Arc::new(Glab::default());
    let clock = Arc::new(TokioClock::starting_at(1_767_182_400_000));
    let runner: Arc<dyn ForgeRunner> = Arc::new(Runner {
        glab: glab.clone(),
        options: options.clone(),
    });
    let tools = ForgeTools::new(runner, ForgeGate::new(clock.clone()), clock.clone(), "test");
    let context_of: ContextOf = Arc::new(move |_, root| Ok(tools.context(root, None)));
    let host = Arc::new(Host {
        forge: Arc::new(MergeRequestForge::new(context_of)),
        diff: options.diff.clone(),
        diff_loads: Mutex::default(),
        prompts: options.prompts.clone(),
    });
    let storage = ReviewStorage::open(
        &DataContext::new(dir.path(), Platform::Unix, None),
        dir.path(),
    )
    .unwrap();
    let service = ReviewService::new(ReviewServiceOptions {
        storage,
        publish: Arc::new(|_| {}),
        host: host.clone(),
        clock,
        session_limit: None,
        retry_delay_ms: Some(10),
        delivery_delay_ms: Some(0),
        agent_search_ms: Some(20),
    });
    Setup {
        service,
        glab,
        host,
        dir,
    }
}

fn make(options: Options) -> Setup {
    make_in(options, None)
}

fn open_mr(service: &ReviewService, project: &str, extra: Value) -> ReviewSession {
    let mut params = json!({
        "connectionId": "c",
        "root": "/repo",
        "target": {"kind": "mr", "url": format!("https://gitlab.example/{project}/-/merge_requests/3")},
    });
    if let (Some(params), Value::Object(extra)) = (params.as_object_mut(), extra) {
        params.extend(extra);
    }
    service.open(&params).unwrap().session
}

/// The service's error text.
fn error<T: std::fmt::Debug>(result: Result<T, roamgate_review::error::ReviewError>) -> String {
    result.unwrap_err().message
}

async fn settle() {
    roamgate_base::clock::SystemClock
        .sleep(Duration::from_millis(5))
        .await;
}

fn gate() -> (watch::Sender<bool>, watch::Receiver<bool>) {
    watch::channel(false)
}

#[tokio::test]
async fn the_security_guard_holds_before_gitlab_answered() {
    let down = Arc::new(Mutex::new(true));
    let Setup { service, .. } = make(Options {
        fail: Some(down.clone()),
        ..Options::default()
    });
    let secure = open_mr(&service, "gnome/security", json!({}));
    let plain = open_mr(&service, "gnome/glib", json!({}));
    let _ = service
        .refresh_gitlab(&json!({"sessionId": secure.id}))
        .await;
    // Told by the URL, GitLab or not.
    assert!(
        error(
            service
                .add_thread(&json!({"sessionId": secure.id, "author": "claude", "kind": "discussion", "text": "x"}))
                .await
        )
        .contains("security merge request")
    );
    assert!(
        error(
            service
                .assert_agent_allowed(&json!({"sessionId": secure.id, "author": "claude"}))
                .await
        )
        .contains("security merge request")
    );
    // Any other merge request waits for GitLab to tell.
    assert!(
        error(
            service
                .assert_agent_allowed(&json!({"sessionId": plain.id, "author": "claude"}))
                .await
        )
        .contains("has not told yet")
    );
    assert!(
        !service
            .agent_may_read(&json!({"sessionId": plain.id}))
            .unwrap()
    );
    *down.lock().unwrap() = false;
    service
        .assert_agent_allowed(&json!({"sessionId": plain.id, "author": "claude"}))
        .await
        .unwrap();
    assert!(
        service
            .agent_may_read(&json!({"sessionId": plain.id}))
            .unwrap()
    );
    // The user is never refused.
    service
        .assert_agent_allowed(&json!({"sessionId": secure.id, "author": "you"}))
        .await
        .unwrap();
}

#[tokio::test]
async fn a_numeric_project_id_is_judged_by_the_project_gitlab_names() {
    let secure = make(Options {
        web_project: Some("gnome/security"),
        ..Options::default()
    });
    let by_id = open_mr(&secure.service, "1234", json!({}));
    assert!(
        error(
            secure
                .service
                .assert_agent_allowed(&json!({"sessionId": by_id.id, "author": "claude"}))
                .await
        )
        .contains("security merge request")
    );
    let snapshot = secure.service.get(&json!({"sessionId": by_id.id})).unwrap();
    assert!(snapshot.merge_request.unwrap().security);
    // GitLab answered, but without naming the project: still unknown.
    let unnamed = make(Options::default());
    let other = open_mr(&unnamed.service, "1234", json!({}));
    assert!(
        error(
            unnamed
                .service
                .assert_agent_allowed(&json!({"sessionId": other.id, "author": "claude"}))
                .await
        )
        .contains("has not told yet")
    );
    let named = make(Options {
        web_project: Some("gnome/glib"),
        ..Options::default()
    });
    let fine = open_mr(&named.service, "1234", json!({}));
    named
        .service
        .assert_agent_allowed(&json!({"sessionId": fine.id, "author": "claude"}))
        .await
        .unwrap();
}

#[tokio::test]
async fn watch_and_handoff_never_carry_a_security_merge_requests_review() {
    let prompts: Arc<Mutex<Vec<String>>> = Arc::default();
    let Setup { service, .. } = make(Options {
        prompts: Some(prompts.clone()),
        ..Options::default()
    });
    let local = service
        .open(&json!({"connectionId": "c", "root": "/repo", "workspaceId": "w", "agent": "claude", "target": {"kind": "worktree"}}))
        .unwrap()
        .session;
    let secure = open_mr(
        &service,
        "gnome/security",
        json!({"root": "/other", "workspaceId": "w", "agent": "claude", "paneId": "p1"}),
    );
    let _ = service
        .refresh_gitlab(&json!({"sessionId": secure.id}))
        .await;
    // Any change in the workspace: not the security review's.
    let watching = service.clone();
    let local_id = local.id.clone();
    let any = tokio::spawn(async move {
        watching
            .watch(
                &json!({"sessionId": local_id, "agent": "claude", "mode": "any", "timeoutMs": 100}),
                None,
            )
            .await
            .unwrap()
    });
    settle().await;
    service
        .update(&json!({"sessionId": secure.id, "summary": "CVE details"}))
        .await
        .unwrap();
    service
        .add_thread(
            &json!({"sessionId": secure.id, "kind": "discussion", "text": "overflow in parse()"}),
        )
        .await
        .unwrap();
    assert_eq!(any.await.unwrap().outcome, "timeout");
    // Its discussions waiting on the agent: not handed either.
    let unanswered = service
        .watch(
            &json!({"sessionId": local.id, "agent": "claude", "timeoutMs": 50}),
            None,
        )
        .await
        .unwrap();
    assert_eq!(unanswered.outcome, "timeout");
    assert!(unanswered.threads.is_empty());
    // A handoff of it is refused before it wakes anyone.
    let watching = service.clone();
    let local_id = local.id.clone();
    let waiting = tokio::spawn(async move {
        watching
            .watch(
                &json!({"sessionId": local_id, "agent": "claude", "timeoutMs": 100}),
                None,
            )
            .await
            .unwrap()
    });
    settle().await;
    assert!(
        error(service.handoff(&json!({"sessionId": secure.id})).await)
            .contains("security merge request")
    );
    let woken = waiting.await.unwrap();
    assert_eq!(woken.outcome, "timeout");
    assert_eq!(woken.summary, None);
    // The agent's watch of it is refused too, and nothing reached its pane.
    assert!(
        error(
            service
                .watch(
                    &json!({"sessionId": secure.id, "agent": "claude", "timeoutMs": 10}),
                    None
                )
                .await
        )
        .contains("security merge request")
    );
    roamgate_base::clock::SystemClock
        .sleep(Duration::from_millis(20))
        .await;
    let said = prompts.lock().unwrap().join("\n");
    assert!(!said.contains("CVE"));
    assert!(!said.contains("overflow"));
}

async fn agent_draft(service: &ReviewService, session_id: &str, text: &str) -> ReviewThread {
    service
        .add_thread(&json!({
            "sessionId": session_id, "author": "claude", "kind": "draft",
            "anchor": {"path": "a.c", "line": 2, "side": "new"}, "text": text,
        }))
        .await
        .unwrap()
}

fn holding(gate: watch::Receiver<bool>, only: Option<&'static str>) -> Hold {
    Arc::new(move |method| (only.is_none_or(|only| only == method)).then(|| gate.clone()))
}

fn notes(glab: &Glab) -> Vec<String> {
    glab.drafts
        .lock()
        .unwrap()
        .iter()
        .map(|d| d.note.clone())
        .collect()
}

#[tokio::test]
async fn two_pushes_at_once_send_each_draft_once() {
    let (open, gate) = gate();
    let Setup { service, glab, .. } = make(Options {
        web_project: Some("g/p"),
        hold: Some(holding(gate, None)),
        ..Options::default()
    });
    let review = open_mr(&service, "g/p", json!({}));
    service
        .refresh_gitlab(&json!({"sessionId": review.id}))
        .await
        .unwrap();
    agent_draft(&service, &review.id, "agent draft").await;
    let push = |service: &ReviewService| {
        let service = service.clone();
        let id = review.id.clone();
        tokio::spawn(async move { service.push_local_drafts(&json!({"sessionId": id})).await })
    };
    let (first, second) = (push(&service), push(&service));
    settle().await;
    open.send(true).unwrap();
    first.await.unwrap().unwrap();
    second.await.unwrap().unwrap();
    assert_eq!(
        glab.writes
            .lock()
            .unwrap()
            .iter()
            .filter(|(method, _)| method == "POST")
            .count(),
        1
    );
    assert_eq!(notes(&glab), ["agent draft"]);
}

#[tokio::test]
async fn a_draft_edited_or_deleted_while_it_is_sent_stays_as_the_user_left_it() {
    let current: Arc<Mutex<watch::Receiver<bool>>> = Arc::new(Mutex::new(gate().1));
    let held = current.clone();
    let hold: Hold =
        Arc::new(move |method| (method == "POST").then(|| held.lock().unwrap().clone()));
    let Setup { service, glab, .. } = make(Options {
        web_project: Some("g/p"),
        hold: Some(hold),
        ..Options::default()
    });
    let renew = || {
        let (open, gate) = gate();
        *current.lock().unwrap() = gate;
        open
    };
    let open = renew();
    let review = open_mr(&service, "g/p", json!({}));
    service
        .refresh_gitlab(&json!({"sessionId": review.id}))
        .await
        .unwrap();
    let edited = agent_draft(&service, &review.id, "old").await;
    let push = |service: &ReviewService| {
        let service = service.clone();
        let id = review.id.clone();
        tokio::spawn(async move { service.push_local_drafts(&json!({"sessionId": id})).await })
    };
    let pushing = push(&service);
    settle().await;
    service
        .edit(&json!({"sessionId": review.id, "commentId": edited.comments[0].id, "text": "NEW"}))
        .await
        .unwrap();
    open.send(true).unwrap();
    assert!(error(pushing.await.unwrap()).contains("changed while it was sent"));
    // The old text is taken back from GitLab; the edit stays here.
    assert!(notes(&glab).is_empty());
    let local = |service: &ReviewService| -> Vec<ReviewThread> {
        service
            .get(&json!({"sessionId": review.id}))
            .unwrap()
            .threads
            .into_iter()
            .filter(|t| t.gitlab.is_none())
            .collect()
    };
    assert_eq!(
        local(&service)
            .iter()
            .map(|t| t.comments[0].body.clone())
            .collect::<Vec<_>>(),
        ["NEW"]
    );
    let open = renew();
    let pushing = push(&service);
    settle().await;
    open.send(true).unwrap();
    pushing.await.unwrap().unwrap();
    assert_eq!(notes(&glab), ["NEW"]);
    assert!(local(&service).is_empty());

    // Deleted while it is sent: taken back. Deleted before its turn: not sent.
    let first = agent_draft(&service, &review.id, "first").await;
    let second = agent_draft(&service, &review.id, "second").await;
    let open = renew();
    let pushing = push(&service);
    settle().await;
    for thread in [&first, &second] {
        service
            .delete_comment(&json!({"sessionId": review.id, "commentId": thread.comments[0].id}))
            .await
            .unwrap();
    }
    open.send(true).unwrap();
    pushing.await.unwrap().unwrap();
    assert_eq!(notes(&glab), ["NEW"]);
    assert!(local(&service).is_empty());
    assert!(
        !glab
            .writes
            .lock()
            .unwrap()
            .iter()
            .any(|(_, argv)| argv.iter().any(|a| a == "note=second"))
    );
}

#[tokio::test]
async fn an_overall_comment_gitlab_refused_is_kept_and_sent_with_the_drafts() {
    let down = Arc::new(Mutex::new(false));
    let first = make(Options {
        web_project: Some("g/p"),
        refuse: Some(down.clone()),
        ..Options::default()
    });
    let review = open_mr(&first.service, "g/p", json!({}));
    first
        .service
        .refresh_gitlab(&json!({"sessionId": review.id}))
        .await
        .unwrap();
    *down.lock().unwrap() = true;
    assert!(
        error(
            first
                .service
                .update(&json!({"sessionId": review.id, "summary": "long overall"}))
                .await
        )
        .contains("502")
    );
    first.service.close();
    let dir = first.dir.clone();
    drop(first);
    // After a restart it is still there, still to send.
    let again = make_in(
        Options {
            web_project: Some("g/p"),
            ..Options::default()
        },
        Some(dir),
    );
    let kept = again
        .service
        .get(&json!({"sessionId": review.id}))
        .unwrap()
        .session;
    assert_eq!(kept.summary, "long overall");
    assert!(kept.summary_unsent());
    again
        .service
        .refresh_gitlab(&json!({"sessionId": review.id}))
        .await
        .unwrap();
    again
        .service
        .push_local_drafts(&json!({"sessionId": review.id}))
        .await
        .unwrap();
    assert_eq!(notes(&again.glab), ["long overall"]);
    assert_eq!(
        again
            .service
            .get(&json!({"sessionId": review.id}))
            .unwrap()
            .session
            .summary_unsent,
        None
    );
}

#[tokio::test]
async fn overall_comments_saved_at_once_make_one_draft() {
    let (open, gate) = gate();
    let Setup { service, glab, .. } = make(Options {
        web_project: Some("g/p"),
        hold: Some(holding(gate, None)),
        ..Options::default()
    });
    let review = open_mr(&service, "g/p", json!({}));
    service
        .refresh_gitlab(&json!({"sessionId": review.id}))
        .await
        .unwrap();
    let save = |summary: &'static str| {
        let service = service.clone();
        let id = review.id.clone();
        tokio::spawn(async move {
            service
                .update(&json!({"sessionId": id, "summary": summary}))
                .await
        })
    };
    let (a, ab) = (save("a"), save("ab"));
    settle().await;
    open.send(true).unwrap();
    a.await.unwrap().unwrap();
    ab.await.unwrap().unwrap();
    // The second save finds the first one's draft, already with its text.
    assert_eq!(
        glab.writes
            .lock()
            .unwrap()
            .iter()
            .map(|(method, _)| method.clone())
            .collect::<Vec<_>>(),
        ["POST"]
    );
    assert_eq!(notes(&glab), ["ab"]);
    assert_eq!(
        service
            .get(&json!({"sessionId": review.id}))
            .unwrap()
            .session
            .summary_unsent,
        None
    );
}

fn range_diff() -> Value {
    json!({
        "truncated": false,
        "files": parse_unified_diff(
            "diff --git a/a.c b/a.c\n--- a/a.c\n+++ b/a.c\n@@ -1,2 +1,3 @@\n ctx1\n+add2\n ctx2\n",
        ),
    })
}

#[tokio::test]
async fn a_range_comment_goes_to_gitlab_as_a_line_range_from_the_diff() {
    let Setup { service, glab, .. } = make(Options {
        web_project: Some("g/p"),
        diff: Some(range_diff()),
        ..Options::default()
    });
    let review = open_mr(&service, "g/p", json!({}));
    service
        .refresh_gitlab(&json!({"sessionId": review.id}))
        .await
        .unwrap();
    // The user's comment, sent at once, and an agent's, sent with the push.
    service
        .add_thread(&json!({
            "sessionId": review.id, "kind": "draft",
            "anchor": {"path": "a.c", "line": 1, "endLine": 3, "side": "new", "contextOld": 1},
            "text": "range",
        }))
        .await
        .unwrap();
    service
        .add_thread(&json!({
            "sessionId": review.id, "author": "claude", "kind": "draft",
            "anchor": {"path": "a.c", "line": 1, "endLine": 2, "side": "new"},
            "text": "agent range",
        }))
        .await
        .unwrap();
    service
        .push_local_drafts(&json!({"sessionId": review.id}))
        .await
        .unwrap();
    let writes: Vec<Vec<String>> = glab
        .writes
        .lock()
        .unwrap()
        .iter()
        .map(|(_, argv)| argv.clone())
        .collect();
    let (user, pushed) = (&writes[0], &writes[1]);
    for want in [
        "position[line_range][end][old_line]=2",
        "position[line_range][end][new_line]=3",
        "position[old_line]=2",
        "position[new_line]=3",
    ] {
        assert!(user.iter().any(|a| a == want), "{want}");
    }
    assert!(
        pushed
            .iter()
            .any(|a| a == "position[line_range][end][type]=new")
    );
    assert!(pushed.iter().any(|a| a == "position[new_line]=2"));
    assert!(!pushed.iter().any(|a| a.starts_with("position[old_line]=")));
}

#[tokio::test]
async fn a_range_comments_diff_is_its_files_alone_read_whole_no_patch_cap() {
    let Setup { service, host, .. } = make(Options {
        web_project: Some("g/p"),
        diff: Some(range_diff()),
        ..Options::default()
    });
    let review = open_mr(&service, "g/p", json!({}));
    service
        .refresh_gitlab(&json!({"sessionId": review.id}))
        .await
        .unwrap();
    service
        .add_thread(&json!({
            "sessionId": review.id, "kind": "draft",
            "anchor": {"path": "a.c", "line": 1, "endLine": 3, "side": "new"},
            "text": "range",
        }))
        .await
        .unwrap();
    assert_eq!(
        *host.diff_loads.lock().unwrap(),
        vec![(None, Some(vec!["a.c".to_owned()]))]
    );
}

#[tokio::test]
async fn a_poll_of_an_unchanged_merge_request_reads_only_the_merge_request() {
    let updated = Arc::new(Mutex::new("2026-11-02T10:00:00Z".to_owned()));
    let Setup { service, glab, .. } = make(Options {
        web_project: Some("g/p"),
        updated_at: Some(updated.clone()),
        ..Options::default()
    });
    let review = open_mr(&service, "g/p", json!({}));
    let refresh = |poll: bool| {
        let service = service.clone();
        let id = review.id.clone();
        async move {
            service
                .refresh_gitlab(&json!({"sessionId": id, "poll": poll}))
                .await
                .unwrap();
        }
    };
    let threads = || {
        glab.reads
            .lock()
            .unwrap()
            .iter()
            .filter(|path| path.contains("discussions") || path.contains("draft_notes"))
            .count()
    };
    refresh(false).await;
    assert_eq!(threads(), 2);
    refresh(true).await;
    assert_eq!(threads(), 2);
    // A new note moves updated_at: its threads are read again.
    *updated.lock().unwrap() = "2026-11-02T10:05:00Z".into();
    refresh(true).await;
    assert_eq!(threads(), 4);
    // Not a poll (a reload, or after a write here): read again.
    refresh(false).await;
    assert_eq!(threads(), 6);
}

#[tokio::test]
async fn make_it_mine_an_agents_thread_becomes_the_users_draft_on_the_users_word_only() {
    let Setup { service, glab, .. } = make(Options {
        web_project: Some("g/p"),
        ..Options::default()
    });
    let review = open_mr(&service, "g/p", json!({}));
    service
        .refresh_gitlab(&json!({"sessionId": review.id}))
        .await
        .unwrap();
    let thread = agent_draft(&service, &review.id, "Check the error path").await;
    let talk = service
        .add_thread(&json!({
            "sessionId": review.id, "author": "claude",
            "anchor": {"path": "a.c", "line": 5, "side": "new"}, "text": "This leaks on failure",
        }))
        .await
        .unwrap();
    // The agent's own threads never reached GitLab.
    assert!(glab.writes.lock().unwrap().is_empty());
    // An agent cannot make it the user's.
    assert!(
        error(
            service
                .adopt_thread(
                    &json!({"sessionId": review.id, "threadId": thread.id, "author": "claude"})
                )
                .await
        )
        .contains("only you")
    );
    assert!(glab.writes.lock().unwrap().is_empty());
    service
        .adopt_thread(&json!({"sessionId": review.id, "threadId": thread.id, "author": "you"}))
        .await
        .unwrap();
    service
        .adopt_thread(&json!({
            "sessionId": review.id, "threadId": talk.id, "author": "you",
            "text": "Please free it on the error path",
        }))
        .await
        .unwrap();
    assert_eq!(
        notes(&glab),
        ["Check the error path", "Please free it on the error path"]
    );
    assert!(
        glab.writes
            .lock()
            .unwrap()
            .iter()
            .all(|(method, _)| method == "POST")
    );
    // The review comment is the user's now; the discussion is resolved.
    let snapshot = service.get(&json!({"sessionId": review.id})).unwrap();
    let local: Vec<(String, bool)> = snapshot
        .threads
        .iter()
        .filter(|each| each.gitlab.is_none())
        .map(|each| (each.id.clone(), each.resolved))
        .collect();
    assert_eq!(local, vec![(talk.id, true)]);
}

#[tokio::test]
async fn make_it_mine_takes_an_agents_draft_of_a_local_review_shown_in_the_merge_requests_review() {
    // The local review's branch is the merge request's source: its agent's
    // drafts learn they are pending for that merge request.
    let Setup { service, glab, .. } = make(Options {
        web_project: Some("g/p"),
        checkout: true,
        ..Options::default()
    });
    let review = open_mr(&service, "g/p", json!({}));
    service
        .refresh_gitlab(&json!({"sessionId": review.id}))
        .await
        .unwrap();
    let local = service
        .open(&json!({"connectionId": "c", "root": "/repo", "target": {"kind": "worktree"}, "raise": false}))
        .unwrap()
        .session;
    let draft = agent_draft(&service, &local.id, "Check the error path").await;
    // Pending for the merge request of its branch: shown in the review.
    let mut shown = false;
    for _ in 0..200 {
        shown = service
            .get(&json!({"sessionId": review.id}))
            .unwrap()
            .threads
            .iter()
            .any(|each| each.id == draft.id);
        if shown {
            break;
        }
        settle().await;
    }
    assert!(shown);
    // As the review pane's RPC asks it: the user's click.
    service
        .adopt_thread(&json!({"sessionId": review.id, "threadId": draft.id, "author": "you"}))
        .await
        .unwrap();
    assert_eq!(notes(&glab), ["Check the error path"]);
    assert!(
        !service
            .get(&json!({"sessionId": local.id}))
            .unwrap()
            .threads
            .iter()
            .any(|each| each.id == draft.id)
    );
}

#[tokio::test]
async fn a_rendered_file_and_its_merge_requests_review_share_their_threads_only_the_users_drafts_go_to_gitlab()
 {
    let Setup { service, glab, .. } = make(Options::default());
    let mr = open_mr(&service, "gnome/glib", json!({}));
    let rendered = service
        .open(&json!({
            "connectionId": "c", "root": "/repo", "target": {"kind": "rendered", "path": "plan.md"},
            "agent": "claude", "paneId": "p1", "raise": false,
        }))
        .unwrap()
        .session;
    service
        .refresh_gitlab(&json!({"sessionId": mr.id}))
        .await
        .unwrap();
    let posts = || {
        glab.writes
            .lock()
            .unwrap()
            .iter()
            .filter(|(method, _)| method == "POST")
            .count()
    };
    // Written in the rendered view: a discussion with the agent, shown in
    // the merge request's review, never written to GitLab.
    let said = service
        .add_thread(&json!({
            "sessionId": rendered.id, "kind": "discussion",
            "anchor": {"path": "plan.md", "line": 3, "side": "new"}, "text": "Rendered words",
        }))
        .await
        .unwrap();
    assert_eq!(posts(), 0);
    let in_mr = service.get(&json!({"sessionId": mr.id})).unwrap();
    assert_eq!(
        in_mr
            .shared
            .unwrap_or_default()
            .iter()
            .map(|t| t.id.clone())
            .collect::<Vec<_>>(),
        vec![said.id.clone()]
    );
    assert!(!in_mr.threads.iter().any(|t| t.id == said.id));
    // Answered from the merge request's review: still local, in its review.
    service
        .reply(&json!({"sessionId": mr.id, "commentId": said.id, "text": "Local answer"}))
        .await
        .unwrap();
    assert_eq!(posts(), 0);
    assert_eq!(
        service
            .get(&json!({"sessionId": rendered.id}))
            .unwrap()
            .threads[0]
            .comments
            .len(),
        2
    );
    // The user's review comment on the file in the merge request's review
    // is a GitLab draft, shown in the rendered view too.
    let draft = service
        .add_thread(&json!({
            "sessionId": mr.id, "kind": "draft", "author": "you",
            "anchor": {"path": "plan.md", "line": 5, "side": "new"}, "text": "For GitLab",
        }))
        .await
        .unwrap();
    assert_eq!(posts(), 1);
    let shared = service
        .get(&json!({"sessionId": rendered.id}))
        .unwrap()
        .shared
        .unwrap_or_default();
    let found = shared.iter().find(|t| t.id == draft.id).unwrap();
    assert_eq!(
        found.gitlab.as_ref().and_then(|g| g.draft_id),
        draft.gitlab.as_ref().and_then(|g| g.draft_id)
    );
    assert_eq!(found.session_id, mr.id);
}
