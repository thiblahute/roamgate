//! create.test.ts.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use roamgate_git::exec::LocalRunner;
use serde_json::{Value, json};

use super::*;
use crate::connection::testing::MemorySettings;
use crate::worktree::testing::{FnRunner, last_word, ran, remote_script};

fn commit() -> String {
    "a".repeat(40)
}

fn remote_head() -> String {
    format!("ref: refs/heads/master\tHEAD\n{}\tHEAD\n", commit())
}

fn fixed_root(
    root: &'static str,
) -> impl Fn(String) -> BoxFuture<'static, Result<String, WorkspaceError>> + Send + Sync {
    move |_| Box::pin(async move { Ok(root.to_owned()) })
}

#[tokio::test]
async fn a_worktree_base_without_origin_is_the_checked_out_commit_in_any_language() {
    let oid = "a".repeat(40);
    let answer = oid.clone();
    let runner = FnRunner::answering(move |request| {
        let command = last_word(request);
        Ok(if command.contains("remote get-url origin") {
            ran(2, "", "error: No such remote 'origin'\n")
        } else if command.contains("rev-parse --verify 'HEAD^{commit}'") {
            ran(0, &format!("{answer}\n"), "")
        } else if command.contains("for-each-ref") {
            ran(0, "", "")
        } else {
            // Git in French, as the user's machine may speak it.
            ran(
                128,
                "",
                "fatal : 'origin' ne semble pas être un dépôt git\nfatal : Impossible de lire le dépôt distant.\n",
            )
        })
    });
    let cx = GitContext::local(runner);
    let resolve = fixed_root("/repo");
    let result = sync_worktree_base("w1", &resolve, &cx).await.unwrap();
    assert_eq!(result.base, "HEAD");
    assert_eq!(result.commit, oid);
}

/// A runner answering from a queue, failing once it is empty.
fn queued(results: Vec<Ran>) -> Arc<FnRunner> {
    let results = Mutex::new(results.into_iter());
    FnRunner::answering(move |_| {
        results
            .lock()
            .unwrap()
            .next()
            .ok_or_else(|| RunError("unexpected process call".into()))
    })
}

#[tokio::test]
async fn fetches_the_advertised_commit_and_refreshes_its_tracking_ref_name() {
    for (host, oid) in [
        (None, "a".repeat(40)),
        (Some("dev@example.test"), "b".repeat(64)),
    ] {
        let fetch = format!("git fetch --no-tags --no-write-fetch-head --refmap= origin '{oid}'");
        let runner = queued(vec![
            ran(0, "", ""),
            ran(
                0,
                &format!("ref: refs/heads/master\tHEAD\n{oid}\tHEAD\n"),
                "",
            ),
            ran(0, "", ""),
            ran(0, "", "fetched\n"),
            ran(0, &format!("{oid}\n"), ""),
            ran(1, "", ""),
            ran(0, "", ""),
        ]);
        let cx = GitContext::new(host.map(str::to_owned), runner.clone());
        let resolve = fixed_root("/repo with spaces");
        let result = sync_worktree_base("w1", &resolve, &cx).await.unwrap();
        let requests = runner.requests();
        assert_eq!(requests.len(), 7);
        match (&requests[0].invocation, host) {
            (Invocation::Ssh { destination, .. }, Some(host)) => assert_eq!(destination, host),
            (Invocation::Local(argv), None) => assert_eq!(argv[..2], ["sh", "-lc"]),
            (other, _) => panic!("ran {other:?}"),
        }
        let prefix = "GIT_TERMINAL_PROMPT=0 git -C '/repo with spaces' ";
        let commands: Vec<String> = requests.iter().map(last_word).collect();
        assert_eq!(
            commands,
            [
                format!(
                    "{prefix}for-each-ref --format='%(refname) %(objectname) %(symref)' refs/remotes/origin/"
                ),
                format!("{prefix}ls-remote --symref origin HEAD"),
                format!("{prefix}check-ref-format 'refs/heads/master'"),
                format!("{prefix}{}", &fetch[4..]),
                format!("{prefix}rev-parse --verify '{oid}^{{commit}}'"),
                format!("{prefix}symbolic-ref --quiet 'refs/remotes/origin/master'"),
                format!("{prefix}update-ref --no-deref 'refs/remotes/origin/master' '{oid}' ''"),
            ]
        );
        assert_eq!(result.workspace_id, "w1");
        assert_eq!(result.root, "/repo with spaces");
        assert_eq!(result.base, "origin/master");
        assert_eq!(result.commit, oid);
        assert_eq!(result.command, fetch);
        assert_eq!(result.stderr, "fetched");
    }
}

#[tokio::test]
async fn does_not_fall_back_to_another_base_when_name() {
    let c = commit();
    let head = remote_head();
    let cases: Vec<(Vec<Ran>, &str)> = vec![
        (
            vec![ran(128, "", "unable to read refs")],
            "Unable to read origin's tracking refs: unable to read refs",
        ),
        (
            vec![ran(0, "", ""), ran(128, "", "origin is unavailable")],
            "Unable to determine origin's default branch: origin is unavailable",
        ),
        (
            vec![ran(0, "", ""), ran(0, &format!("{c}\tHEAD\n"), "")],
            "origin HEAD does not identify a branch",
        ),
        (
            vec![ran(0, "", ""), ran(0, "", "")],
            "origin HEAD does not identify a branch",
        ),
        (
            vec![
                ran(0, "", ""),
                ran(0, "ref: refs/heads/bad:name\tHEAD\n", ""),
                ran(1, "", ""),
            ],
            "origin HEAD contains an invalid branch ref",
        ),
        (
            vec![
                ran(0, "", ""),
                ran(0, "ref: refs/heads/master\tHEAD\n$(id)\tHEAD\n", ""),
                ran(0, "", ""),
            ],
            "origin HEAD does not identify a commit",
        ),
        (
            vec![
                ran(0, "", ""),
                ran(0, &head, ""),
                ran(0, "", ""),
                ran(128, "", "remote master is unavailable"),
            ],
            "Unable to update origin/master: remote master is unavailable",
        ),
        (
            vec![
                ran(0, "", ""),
                ran(0, &head, ""),
                ran(0, "", ""),
                ran(0, "", ""),
                ran(128, "", "missing commit"),
            ],
            "Unable to resolve origin/master after fetching it: missing commit",
        ),
        (
            vec![
                ran(0, "", ""),
                ran(0, &head, ""),
                ran(0, "", ""),
                ran(0, "", ""),
                ran(0, &"b".repeat(40), ""),
            ],
            "Unable to resolve origin/master after fetching it",
        ),
        (
            vec![
                ran(0, "", ""),
                ran(0, &head, ""),
                ran(0, "", ""),
                ran(0, "", ""),
                ran(0, &c, ""),
                ran(128, "", "unable to read tracking ref"),
            ],
            "Unable to check origin/master's tracking ref: unable to read tracking ref",
        ),
        (
            vec![
                ran(0, "", ""),
                ran(0, &head, ""),
                ran(0, "", ""),
                ran(0, "", ""),
                ran(0, &c, ""),
                ran(1, "", ""),
                ran(128, "", "tracking ref changed"),
                ran(1, "", ""),
            ],
            "Unable to update origin/master's tracking ref: tracking ref changed",
        ),
    ];
    for (results, error) in cases {
        let count = results.len();
        let runner = queued(results);
        let cx = GitContext::local(runner.clone());
        let resolve = fixed_root("/repo");
        let failure = sync_worktree_base("w1", &resolve, &cx).await.unwrap_err();
        assert!(failure.message.contains(error), "{failure} / {error}");
        assert_eq!(runner.requests().len(), count, "{error}");
    }
}

/// The source workspace the fixture's Herdr describes.
fn source_workspace() -> Value {
    json!({
        "cwd": "/source",
        "worktree": {
            "checkout_path": "/source/checkout",
            "repo_key": "/source/.git",
            "repo_name": "Source",
        },
    })
}

/// A runtime recording each stage, retiring the request after one.
struct Fixture {
    calls: Arc<Mutex<Vec<String>>>,
    runner: Arc<FnRunner>,
    methods: Mutex<Vec<String>>,
    rpc_params: Mutex<Vec<Value>>,
    hook_args: Mutex<Vec<(Value, Value, Option<HookExpectation>)>>,
    roots: Mutex<Vec<String>>,
    retire_after: Option<&'static str>,
    current: Arc<AtomicBool>,
    fail_parent: bool,
    source: Mutex<Option<Value>>,
    git: GitContext,
    settings: Arc<MemorySettings>,
    windows: bool,
    /// What Herdr's `worktree.open` answers.
    open_answer: Mutex<Value>,
    resolve_fails: bool,
    /// Whether the parent recorded is checked (a workspace source's).
    checks_parent: bool,
}

impl Fixture {
    fn record(&self, stage: &str) {
        self.calls.lock().unwrap().push(stage.into());
        if self.retire_after == Some(stage) {
            self.current.store(false, Ordering::SeqCst);
        }
    }

    fn guard(&self) -> Guard {
        let current = self.current.clone();
        Arc::new(move || current.load(Ordering::SeqCst))
    }

    fn calls(&self) -> Vec<String> {
        self.calls.lock().unwrap().clone()
    }

    fn methods(&self) -> Vec<String> {
        self.methods.lock().unwrap().clone()
    }

    fn params(&self) -> Vec<Value> {
        self.rpc_params.lock().unwrap().clone()
    }
}

impl CreateRuntime for Fixture {
    fn is_windows(&self) -> bool {
        self.windows
    }

    fn connection_id(&self) -> Option<&str> {
        None
    }

    fn git(&self) -> &GitContext {
        &self.git
    }

    fn settings(&self) -> &dyn SettingsAccess {
        &*self.settings
    }

    fn resolve_git_root(
        &self,
        workspace_id: String,
    ) -> BoxFuture<'_, Result<String, WorkspaceError>> {
        Box::pin(async move {
            if self.resolve_fails {
                return Err(WorkspaceError::new("no workspace to resolve"));
            }
            assert_eq!(workspace_id, "source");
            self.record("resolve");
            let mut roots = self.roots.lock().unwrap();
            Ok(if roots.is_empty() {
                "/source/root".into()
            } else {
                roots.remove(0)
            })
        })
    }

    fn herdr(&self, method: &str, params: Value) -> BoxFuture<'_, Result<Value, String>> {
        let method = method.to_owned();
        Box::pin(async move {
            self.methods.lock().unwrap().push(method.clone());
            self.rpc_params.lock().unwrap().push(params);
            self.record("create");
            let workspace = json!({ "workspace_id": "created", "cwd": "/created" });
            Ok(if method == "worktree.open" {
                self.open_answer.lock().unwrap().clone()
            } else {
                json!({ "workspace": workspace })
            })
        })
    }

    fn source_workspace<'a>(
        &'a self,
        params: &'a Value,
    ) -> BoxFuture<'a, Result<Option<Value>, WorkspaceError>> {
        Box::pin(async move {
            for key in [
                "expected_setup_hook",
                "expected_hooks_enabled",
                "expected_source_root",
            ] {
                assert!(params.get(key).is_none());
            }
            self.record("source");
            Ok(self.source.lock().unwrap().clone())
        })
    }

    fn remember_parent<'a>(
        &'a self,
        result: &'a Value,
        parent: &'a str,
        _is_current: &'a Guard,
    ) -> BoxFuture<'a, Result<(), String>> {
        Box::pin(async move {
            if !self.checks_parent {
                return Ok(());
            }
            assert_eq!(
                result,
                &json!({ "workspace": { "workspace_id": "created", "cwd": "/created" } })
            );
            assert_eq!(parent, "source");
            self.record("parent");
            if self.fail_parent {
                return Err("parent storage unavailable".into());
            }
            Ok(())
        })
    }

    fn run_setup_hook<'a>(
        &'a self,
        result: &'a Value,
        source: Value,
        expected: Option<HookExpectation>,
        _is_current: &'a Guard,
    ) -> BoxFuture<'a, Result<HookRun, WorkspaceError>> {
        Box::pin(async move {
            self.hook_args
                .lock()
                .unwrap()
                .push((result.clone(), source, expected));
            self.record("setup");
            Ok(setup_hook())
        })
    }
}

fn setup_hook() -> HookRun {
    HookRun {
        event: "worktree.created",
        status: "skipped",
        reason: Some("setup_hook_changed"),
        ..HookRun::default()
    }
}

fn no_process() -> Arc<FnRunner> {
    FnRunner::answering(|request| panic!("unexpected process {request:?}"))
}

fn fixture(
    retire_after: Option<&'static str>,
    fail_parent: bool,
    roots: &[&str],
    settings: Value,
) -> Fixture {
    fixture_on(retire_after, fail_parent, roots, settings, no_process())
}

fn fixture_on(
    retire_after: Option<&'static str>,
    fail_parent: bool,
    roots: &[&str],
    settings: Value,
    runner: Arc<FnRunner>,
) -> Fixture {
    Fixture {
        calls: Arc::default(),
        runner: runner.clone(),
        methods: Mutex::default(),
        rpc_params: Mutex::default(),
        hook_args: Mutex::default(),
        roots: Mutex::new(roots.iter().map(|root| (*root).to_owned()).collect()),
        retire_after,
        current: Arc::new(AtomicBool::new(retire_after != Some("initial"))),
        fail_parent,
        source: Mutex::new(Some(source_workspace())),
        git: GitContext::new(Some("host".into()), runner),
        settings: MemorySettings::new(settings),
        windows: false,
        open_answer: Mutex::new(json!({
            "workspace": { "workspace_id": "created", "cwd": "/created" },
            "already_open": false,
        })),
        resolve_fails: false,
        checks_parent: true,
    }
}

fn base_fixture() -> Fixture {
    fixture(None, false, &["/source/root"], json!({}))
}

/// The fixture's refresh of the base: records `sync`, resolves the root.
fn sync_base(fixture: &Arc<Fixture>) -> SyncBase {
    let fixture = fixture.clone();
    Arc::new(move |workspace_id, resolve, cx| {
        let fixture = fixture.clone();
        Box::pin(async move {
            fixture.record("sync");
            assert_eq!(workspace_id, "source");
            assert_eq!(cx.host(), fixture.git.host());
            let root = resolve(workspace_id.to_owned()).await?;
            Ok(SyncedBase {
                workspace_id: "source".into(),
                root,
                base: "origin/master".into(),
                commit: commit(),
                command: "git fetch".into(),
                stdout: String::new(),
                stderr: String::new(),
            })
        })
    })
}

async fn create(fixture: &Arc<Fixture>, params: Value) -> Result<Value, WorkspaceError> {
    create_with(fixture, params, CreateOptions::default()).await
}

async fn create_with(
    fixture: &Arc<Fixture>,
    params: Value,
    mut options: CreateOptions,
) -> Result<Value, WorkspaceError> {
    if options.sync_base.is_none() {
        options.sync_base = Some(sync_base(fixture));
    }
    let guard = fixture.guard();
    create_workspace_worktree(&**fixture, &params, &guard, &options).await
}

#[tokio::test]
async fn retains_sync_create_parent_setup_ordering_and_strips_trusted_hook_confirmation_data() {
    let fixture = Arc::new(base_fixture());
    let result = create(
        &fixture,
        json!({
            "workspace_id": "source",
            "branch": "feature",
            "base": "ignored-base",
            "expected_setup_hook": "printf approved",
            "expected_hooks_enabled": true,
            "expected_source_root": "/source/root",
        }),
    )
    .await
    .unwrap();
    assert_eq!(
        fixture.calls(),
        [
            "source", "sync", "resolve", "resolve", "create", "parent", "setup"
        ]
    );
    assert_eq!(
        fixture.params(),
        [json!({ "cwd": "/source/root", "branch": "feature", "base": commit() })]
    );
    let (hook_result, hook_source, expected) = fixture.hook_args.lock().unwrap()[0].clone();
    assert_eq!(hook_result, json!({ "workspace": result["workspace"] }));
    assert_eq!(
        hook_source,
        json!({
            "cwd": "/source/checkout",
            "worktree": {
                "checkout_path": "/source/checkout",
                "repo_key": "/source/.git",
                "repo_name": "Source",
            },
        })
    );
    assert_eq!(
        expected,
        Some(HookExpectation {
            command: Some("printf approved".into()),
            enabled: true
        })
    );
    assert_eq!(result["base_sync"]["commit"], commit());
    assert_eq!(result["setup_hook"], setup_hook().to_value());
    assert!(result.get("parent_tracking_failed").is_none());
}

#[tokio::test]
async fn gui_creation_needs_no_expectations_and_parent_storage_failure_does_not_skip_setup() {
    let fixture = Arc::new(fixture(None, true, &["/source/root"], json!({})));
    let warnings = Arc::new(Mutex::new(Vec::<String>::new()));
    let kept = warnings.clone();
    let result = create_with(
        &fixture,
        json!({ "workspace_id": "source", "branch": "feature" }),
        CreateOptions {
            parent_warning: Some(Box::new(move |error| {
                kept.lock().unwrap().push(error.into());
            })),
            ..CreateOptions::default()
        },
    )
    .await
    .unwrap();
    assert_eq!(fixture.calls().last().map(String::as_str), Some("setup"));
    assert_eq!(fixture.hook_args.lock().unwrap()[0].2, None);
    assert_eq!(warnings.lock().unwrap().len(), 1);
    assert_eq!(result["parent_tracking_failed"], true);
    assert!(!result.to_string().contains("parent storage unavailable"));
    assert_eq!(fixture.methods(), ["worktree.create"]);
    assert_eq!(
        fixture.params(),
        [json!({ "workspace_id": "source", "branch": "feature", "base": commit() })]
    );
}

#[tokio::test]
async fn a_workspace_repointed_during_fetch_cannot_dispatch_worktree_creation() {
    let fixture = Arc::new(fixture(
        None,
        false,
        &["/source/root", "/another/repository"],
        json!({}),
    ));
    let error = create(
        &fixture,
        json!({ "workspace_id": "source", "branch": "feature", "expected_source_root": "/source/root" }),
    )
    .await
    .unwrap_err();
    assert_eq!(error.message, "The worktree source repository changed.");
    assert_eq!(fixture.calls(), ["source", "sync", "resolve", "resolve"]);
    assert!(fixture.params().is_empty());
    assert!(fixture.hook_args.lock().unwrap().is_empty());
}

#[tokio::test]
async fn the_root_supplied_to_fetch_and_its_reported_root_must_match_the_preview() {
    for changed_before_fetch in [false, true] {
        let root = if changed_before_fetch {
            "/another/repository"
        } else {
            "/source/root"
        };
        let fixture = Arc::new(fixture(None, false, &[root], json!({})));
        let inner = sync_base(&fixture);
        let sync: SyncBase = Arc::new(move |workspace_id, resolve, cx| {
            let inner = inner.clone();
            Box::pin(async move {
                let mut synced = inner(workspace_id, resolve, cx).await?;
                synced.root = "/another/repository".into();
                Ok(synced)
            })
        });
        let error = create_with(
            &fixture,
            json!({ "workspace_id": "source", "branch": "feature", "expected_source_root": "/source/root" }),
            CreateOptions {
                sync_base: Some(sync),
                ..CreateOptions::default()
            },
        )
        .await
        .unwrap_err();
        assert_eq!(error.message, "The worktree source repository changed.");
        assert!(fixture.params().is_empty());
        assert!(fixture.hook_args.lock().unwrap().is_empty());
    }
}

#[tokio::test]
async fn rejects_invalid_expected_roots_before_preparing_or_mutating_a_worktree() {
    // JSON has no `undefined`: a missing key is no confirmation.
    for expected in [json!(null), json!(""), json!(" ")] {
        let fixture = Arc::new(base_fixture());
        let error = create(
            &fixture,
            json!({ "workspace_id": "source", "branch": "feature", "expected_source_root": expected }),
        )
        .await
        .unwrap_err();
        assert_eq!(error.message, "Confirmed source repository is invalid.");
        assert!(fixture.calls().is_empty());
    }
}

#[tokio::test]
async fn stops_the_pipeline_when_the_target_retires_at_s() {
    let cases: [(&str, &[&str]); 6] = [
        ("initial", &[]),
        ("source", &["source"]),
        ("resolve", &["source", "sync", "resolve"]),
        ("sync", &["source", "sync"]),
        ("create", &["source", "sync", "resolve", "create"]),
        ("parent", &["source", "sync", "resolve", "create", "parent"]),
    ];
    for (stage, calls) in cases {
        let fixture = Arc::new(fixture(Some(stage), false, &["/source/root"], json!({})));
        let error = create(
            &fixture,
            json!({ "workspace_id": "source", "branch": "feature" }),
        )
        .await
        .unwrap_err();
        assert_eq!(error.message, "The worktree target changed.", "{stage}");
        assert_eq!(fixture.calls(), calls, "{stage}");
        assert!(fixture.hook_args.lock().unwrap().is_empty());
    }
}

#[tokio::test]
async fn rejects_incomplete_hook_confirmation_before_mutations() {
    for expected in [
        json!({ "expected_setup_hook": "printf approved" }),
        json!({ "expected_hooks_enabled": true }),
        json!({ "expected_setup_hook": null, "expected_hooks_enabled": "true" }),
    ] {
        let fixture = Arc::new(base_fixture());
        let mut params = json!({ "workspace_id": "source", "branch": "feature" });
        for (key, value) in expected.as_object().unwrap() {
            params[key] = value.clone();
        }
        let error = create(&fixture, params).await.unwrap_err();
        assert_eq!(
            error.message,
            "Confirmed setup hook configuration is invalid."
        );
        assert!(fixture.calls().is_empty());
    }
}

const REPO_KEY: &str = "ssh:host:/source/.git";
const TEMPLATE: &str = "git recworktree add {path} --branch {branch} --base {base}";

/// A fixture whose host records `probe` and `command` among its stages:
/// the install probe answers `probe_code`, the command `result`.
fn command_fixture(settings: Value, result: Ran, probe_code: i32, host: Option<&str>) -> Fixture {
    let calls: Arc<Mutex<Vec<String>>> = Arc::default();
    let recorded = calls.clone();
    let runner = FnRunner::answering(move |request| {
        let probe = last_word(request).contains("command -v");
        recorded
            .lock()
            .unwrap()
            .push(if probe { "probe" } else { "command" }.into());
        Ok(if probe {
            ran(probe_code, "", "")
        } else {
            result.clone()
        })
    });
    let mut fixture = fixture_on(None, false, &["/source/root"], settings, runner);
    fixture.calls = calls;
    fixture.git = GitContext::new(host.map(str::to_owned), fixture.runner.clone());
    fixture
}

fn made_it() -> Ran {
    ran(0, "made it\n\n/created/checkout\n", "")
}

impl Fixture {
    fn probes(&self) -> Vec<Request> {
        self.runner
            .requests()
            .into_iter()
            .filter(|request| last_word(request).contains("command -v"))
            .collect()
    }

    fn processes(&self) -> Vec<Request> {
        self.runner
            .requests()
            .into_iter()
            .filter(|request| !last_word(request).contains("command -v"))
            .collect()
    }
}

fn command_params(extra: Value) -> Value {
    let mut params = json!({ "workspace_id": "source", "branch": "feature/x", "focus": true });
    for (key, value) in extra.as_object().unwrap() {
        params[key] = value.clone();
    }
    params
}

#[test]
fn defaults_to_herdr_s_own_checkout_path() {
    assert_eq!(
        herdr_default_checkout_path("herdr", "worktree/brave-river"),
        "~/.herdr/worktrees/herdr/worktree-brave-river"
    );
    assert_eq!(
        herdr_default_checkout_path("r", "Issue/137 Spaces"),
        "~/.herdr/worktrees/r/issue-137-spaces"
    );
    assert_eq!(
        herdr_default_checkout_path("r", "///"),
        "~/.herdr/worktrees/r/worktree"
    );
}

#[tokio::test]
async fn runs_over_ssh_from_the_source_root_then_opens_the_path_in_herdr() {
    let fixture = Arc::new(command_fixture(
        json!({ "repositories": { REPO_KEY: { "worktree_command": TEMPLATE, "worktree_directory": "/wt" } } }),
        made_it(),
        0,
        Some("host"),
    ));
    let result = create(&fixture, command_params(json!({ "label": "X" })))
        .await
        .unwrap();
    assert_eq!(
        fixture.calls(),
        [
            "source", "sync", "resolve", "probe", "command", "create", "parent", "setup"
        ]
    );
    assert_eq!(
        remote_script(&last_word(&fixture.probes()[0])),
        "command -v -- 'git' >/dev/null 2>&1 || exit 127; git --list-cmds=main,others,alias 2>/dev/null | grep -qxF -- 'recworktree' || exit 127"
    );
    let process = &fixture.processes()[0];
    assert_eq!(process.timeout, WORKTREE_COMMAND_TIMEOUT);
    let Invocation::Ssh { destination, .. } = &process.invocation else {
        panic!("not over ssh");
    };
    assert_eq!(destination, "host");
    let c = commit();
    assert_eq!(
        remote_script(&last_word(process)),
        format!(
            r#"export ROAMGATE_WORKTREE_PATH='/wt/feature-x'; export ROAMGATE_WORKTREE_BRANCH='feature/x'; export ROAMGATE_WORKTREE_BASE='{c}'; export ROAMGATE_WORKTREE_REPO='/source/root'; cd "$ROAMGATE_WORKTREE_REPO" && git recworktree add "$ROAMGATE_WORKTREE_PATH" --branch "$ROAMGATE_WORKTREE_BRANCH" --base "$ROAMGATE_WORKTREE_BASE" && cd "$ROAMGATE_WORKTREE_PATH" && printf '\n%s\n' "$PWD""#
        )
    );
    assert_eq!(fixture.methods(), ["worktree.open"]);
    assert_eq!(
        fixture.params(),
        [
            json!({ "path": "/created/checkout", "workspace_id": "source", "focus": true, "label": "X" })
        ]
    );
    assert!(result.get("already_open").is_none());
    assert_eq!(
        result["workspace"],
        json!({ "workspace_id": "created", "cwd": "/created" })
    );
}

#[tokio::test]
async fn uses_the_global_default_locally_at_herdr_s_default_path() {
    let fixture = Arc::new(command_fixture(
        json!({ "worktree_command": "mk {path} {repo}" }),
        made_it(),
        0,
        None,
    ));
    create(&fixture, command_params(json!({}))).await.unwrap();
    let c = commit();
    assert_eq!(
        fixture.processes()[0].invocation,
        Invocation::local([
            "sh".to_owned(),
            "-lc".to_owned(),
            format!(
                r#"export ROAMGATE_WORKTREE_PATH="$HOME"/'.herdr/worktrees/Source/feature-x'; export ROAMGATE_WORKTREE_BRANCH='feature/x'; export ROAMGATE_WORKTREE_BASE='{c}'; export ROAMGATE_WORKTREE_REPO='/source/root'; cd "$ROAMGATE_WORKTREE_REPO" && mk "$ROAMGATE_WORKTREE_PATH" "$ROAMGATE_WORKTREE_REPO" && cd "$ROAMGATE_WORKTREE_PATH" && printf '\n%s\n' "$PWD""#
            ),
        ])
    );
    assert_eq!(
        fixture.params(),
        [json!({ "path": "/created/checkout", "workspace_id": "source", "focus": true })]
    );
}

#[tokio::test]
async fn a_repository_command_overrides_the_global_default() {
    let fixture = Arc::new(command_fixture(
        json!({
            "worktree_command": "global {path}",
            "repositories": { REPO_KEY: { "worktree_command": "repo {branch}" } },
        }),
        made_it(),
        0,
        Some("host"),
    ));
    create(&fixture, command_params(json!({}))).await.unwrap();
    assert!(
        remote_script(&last_word(&fixture.processes()[0]))
            .contains(r#"cd "$ROAMGATE_WORKTREE_REPO" && repo "$ROAMGATE_WORKTREE_BRANCH" && "#)
    );
}

#[tokio::test]
async fn a_failing_command_surfaces_its_output_and_opens_nothing() {
    let fixture = Arc::new(command_fixture(
        json!({ "worktree_command": TEMPLATE }),
        ran(2, "progress\n", "\nfatal: branch exists\n\n"),
        0,
        Some("host"),
    ));
    let error = create(&fixture, command_params(json!({})))
        .await
        .unwrap_err();
    assert_eq!(
        error.message,
        "Worktree command failed (exit 2): fatal: branch exists"
    );
    assert!(fixture.methods().is_empty());
    assert!(fixture.hook_args.lock().unwrap().is_empty());
}

#[tokio::test]
async fn a_command_not_installed_on_the_host_falls_back_to_herdr_s_worktree_and_says_so() {
    let fixture = Arc::new(command_fixture(
        json!({ "worktree_command": TEMPLATE }),
        made_it(),
        127,
        Some("host"),
    ));
    let result = create(&fixture, command_params(json!({}))).await.unwrap();
    assert!(fixture.processes().is_empty());
    assert_eq!(fixture.methods(), ["worktree.create"]);
    assert_eq!(
        result["command_fallback"],
        "git recworktree is not installed on host. Herdr created the worktree."
    );
}

#[tokio::test]
async fn an_exit_127_from_inside_an_installed_command_is_a_failure_not_a_fallback() {
    let fixture = Arc::new(command_fixture(
        json!({ "worktree_command": TEMPLATE }),
        ran(127, "", "post-checkout: mk: not found\n"),
        0,
        Some("host"),
    ));
    let error = create(&fixture, command_params(json!({})))
        .await
        .unwrap_err();
    assert_eq!(
        error.message,
        "Worktree command failed (exit 127): post-checkout: mk: not found"
    );
    assert!(fixture.methods().is_empty());
}

#[tokio::test]
async fn a_checkout_already_open_in_herdr_does_not_rerun_its_setup_hook() {
    let fixture = Arc::new(command_fixture(
        json!({ "worktree_command": TEMPLATE }),
        made_it(),
        0,
        Some("host"),
    ));
    *fixture.open_answer.lock().unwrap() =
        json!({ "workspace": { "workspace_id": "old" }, "already_open": true });
    let error = create(&fixture, command_params(json!({})))
        .await
        .unwrap_err();
    assert_eq!(
        error.message,
        "The worktree command left /created/checkout, which was already open in Herdr; the setup hook was not run again."
    );
    assert_eq!(fixture.methods(), ["worktree.open"]);
    assert!(fixture.hook_args.lock().unwrap().is_empty());
}

#[tokio::test]
async fn a_command_changed_since_ranger_s_confirmation_runs_nothing() {
    let fixture = Arc::new(command_fixture(
        json!({ "worktree_command": TEMPLATE }),
        made_it(),
        0,
        Some("host"),
    ));
    for expected in [json!("other {path}"), json!(null)] {
        let error = create(
            &fixture,
            command_params(json!({ "expected_worktree_command": expected })),
        )
        .await
        .unwrap_err();
        assert_eq!(error.message, "The worktree command changed.");
    }
    assert!(fixture.processes().is_empty());
    assert!(fixture.methods().is_empty());
    create(
        &fixture,
        command_params(json!({ "expected_worktree_command": TEMPLATE })),
    )
    .await
    .unwrap();
    assert_eq!(fixture.methods(), ["worktree.open"]);
}

#[tokio::test]
async fn refuses_a_branch_name_with_shell_syntax_before_anything_runs() {
    let fixture = Arc::new(command_fixture(
        json!({ "worktree_command": TEMPLATE }),
        made_it(),
        0,
        Some("host"),
    ));
    for branch in ["a$(touch${IFS}/tmp/x)", "a`id`", "-b", "a..b"] {
        let error = create(&fixture, command_params(json!({ "branch": branch })))
            .await
            .unwrap_err();
        assert!(error.message.contains("Invalid branch name"), "{error}");
    }
    assert!(fixture.calls().is_empty());
    assert!(fixture.processes().is_empty());
}

#[tokio::test]
async fn a_target_retired_while_the_command_runs_is_not_opened() {
    let current = Arc::new(AtomicBool::new(true));
    let flag = current.clone();
    let runner = FnRunner::answering(move |_| {
        flag.store(false, Ordering::SeqCst);
        Ok(ran(0, "", ""))
    });
    let mut fixture = fixture_on(
        None,
        false,
        &["/source/root"],
        json!({ "worktree_command": TEMPLATE }),
        runner,
    );
    fixture.current = current;
    let fixture = Arc::new(fixture);
    let error = create(
        &fixture,
        json!({ "workspace_id": "source", "branch": "feature" }),
    )
    .await
    .unwrap_err();
    assert_eq!(error.message, "The worktree target changed.");
    assert!(fixture.methods().is_empty());
}

#[tokio::test]
async fn a_main_checkout_given_by_its_path_is_a_source_its_repository_s_directory_and_command_apply()
 {
    let runner = FnRunner::answering(|request| {
        let command = last_word(request);
        Ok(if command.contains("--git-common-dir") {
            ran(0, "/repo/.git\n", "")
        } else if command.contains("command -v") {
            ran(0, "", "")
        } else {
            ran(0, "\n/wt/part\n", "")
        })
    });
    let mut fixture = fixture_on(
        None,
        false,
        &[],
        json!({ "repositories": { "local:/repo/.git": { "worktree_command": "mk {path}", "worktree_directory": "/wt" } } }),
        runner,
    );
    fixture.git = GitContext::local(fixture.runner.clone());
    *fixture.source.lock().unwrap() = None;
    fixture.resolve_fails = true;
    fixture.checks_parent = false;
    *fixture.open_answer.lock().unwrap() =
        json!({ "workspace": { "workspace_id": "created", "cwd": "/wt/part" } });
    let fixture = Arc::new(fixture);
    let sync: SyncBase = Arc::new(|workspace_id, resolve, _| {
        Box::pin(async move {
            Ok(SyncedBase {
                workspace_id: workspace_id.to_owned(),
                root: resolve(workspace_id.to_owned()).await?,
                base: "origin/main".into(),
                commit: commit(),
                command: String::new(),
                stdout: String::new(),
                stderr: String::new(),
            })
        })
    });
    let guard: Guard = Arc::new(|| true);
    create_workspace_worktree(
        &*fixture,
        &json!({ "cwd": "/repo", "branch": "part", "focus": false }),
        &guard,
        &CreateOptions {
            sync_base: Some(sync),
            ..CreateOptions::default()
        },
    )
    .await
    .unwrap();
    let last = last_word(fixture.runner.requests().last().unwrap());
    assert!(last.contains("export ROAMGATE_WORKTREE_PATH='/wt/part'"));
    assert!(last.contains("export ROAMGATE_WORKTREE_REPO='/repo'"));
    assert_eq!(fixture.methods(), ["worktree.open"]);
    assert_eq!(
        fixture.params(),
        [json!({ "path": "/wt/part", "cwd": "/repo", "focus": false })]
    );
}

#[tokio::test]
async fn windows_runtimes_refuse_worktree_creation_before_any_helper_runs() {
    let mut fixture = base_fixture();
    fixture.windows = true;
    let fixture = Arc::new(fixture);
    let error = create(
        &fixture,
        json!({ "workspace_id": "source", "branch": "feature" }),
    )
    .await
    .unwrap_err();
    assert!(error.message.contains("unavailable on Windows"));
    assert!(fixture.calls().is_empty());
}

#[test]
fn a_branch_becomes_one_safe_directory_name_under_it() {
    assert_eq!(
        worktree_checkout_path("/w/repo", "feature/login").unwrap(),
        "/w/repo/feature-login"
    );
    assert_eq!(
        worktree_checkout_path("/w/repo/", "  fix: a b  ").unwrap(),
        "/w/repo/fix-a-b"
    );
    // Leading dots never climb out of the directory.
    assert_eq!(
        worktree_checkout_path("/w/repo", "../../etc").unwrap(),
        "/w/repo/etc"
    );
    assert!(
        worktree_checkout_path("/w/repo", "///")
            .unwrap_err()
            .contains("empty")
    );
}

#[tokio::test]
async fn creation_puts_the_worktree_in_the_repository_s_directory_unless_a_path_is_given() {
    let key = workspace_repo_settings_key(
        &json!({ "cwd": "/source", "worktree": { "checkout_path": "/source/checkout", "repo_key": "/source/.git" } }),
        Some("host"),
        None,
    )
    .unwrap();
    let settings = json!({ "repositories": { key: { "worktree_directory": "/srv/trees" } } });

    let placed = Arc::new(fixture(None, false, &["/source/root"], settings.clone()));
    create(
        &placed,
        json!({ "workspace_id": "source", "branch": "team/feature" }),
    )
    .await
    .unwrap();
    assert_eq!(placed.params()[0]["path"], "/srv/trees/team-feature");

    let explicit = Arc::new(fixture(None, false, &["/source/root"], settings.clone()));
    create(
        &explicit,
        json!({ "workspace_id": "source", "branch": "team/feature", "path": "/elsewhere" }),
    )
    .await
    .unwrap();
    assert_eq!(explicit.params()[0]["path"], "/elsewhere");

    // An effort's part: the first path free on the host, never one that
    // exists.
    let probed = Arc::new(Mutex::new(Vec::<String>::new()));
    let kept = probed.clone();
    let runner = FnRunner::answering(move |request| {
        let script = remote_script(&last_word(request));
        Ok(if script.contains("worktree list") {
            kept.lock().unwrap().push(script);
            ran(0, "/srv/trees/team-feature-part\n", "")
        } else {
            ran(1, "", "")
        })
    });
    let fresh = Arc::new(fixture_on(None, false, &["/source/root"], settings, runner));
    create_with(
        &fresh,
        json!({ "workspace_id": "source", "branch": "team/feature" }),
        CreateOptions {
            fresh_path: Some("part".into()),
            ..CreateOptions::default()
        },
    )
    .await
    .unwrap();
    assert!(probed.lock().unwrap()[0].contains(
        "'/srv/trees/team-feature' '/srv/trees/team-feature-part' '/srv/trees/team-feature-part-2'"
    ));
    assert_eq!(fresh.params()[0]["path"], "/srv/trees/team-feature-part");
}

/// Herdr describes the source workspace without its repository: git
/// names it from the root, a linked worktree of the configured repository.
fn unreported(settings: Value, common_dir: Option<&'static str>) -> Arc<Fixture> {
    let runner = FnRunner::answering(move |request| {
        let command = last_word(request);
        Ok(if command.contains("--git-common-dir") {
            match common_dir {
                Some(dir) => ran(0, &format!("{dir}\n"), ""),
                None => ran(128, "", "fatal: not a git repo"),
            }
        } else if command.contains("command -v") {
            ran(0, "", "")
        } else {
            ran(0, "/created/checkout\n", "")
        })
    });
    let fixture = fixture_on(None, false, &["/repo.worktrees/review"], settings, runner);
    *fixture.source.lock().unwrap() = Some(json!({ "workspace_id": "source", "label": "repo" }));
    Arc::new(fixture)
}

fn common_dir_probes(fixture: &Fixture) -> Vec<Request> {
    fixture
        .runner
        .requests()
        .into_iter()
        .filter(|request| last_word(request).contains("--git-common-dir"))
        .collect()
}

#[tokio::test]
async fn a_workspace_herdr_reports_no_repository_for_uses_its_repository_s_directory() {
    let fixture = unreported(
        json!({ "repositories": { "ssh:host:/repo/.git": { "worktree_directory": "/trees" } } }),
        Some("/repo/.git"),
    );
    create(
        &fixture,
        json!({ "workspace_id": "source", "branch": "feature/x" }),
    )
    .await
    .unwrap();
    let probes = common_dir_probes(&fixture);
    assert_eq!(probes.len(), 1);
    assert_eq!(
        probes[0].invocation,
        Invocation::ssh(
            "host",
            "GIT_TERMINAL_PROMPT=0 git -C '/repo.worktrees/review' rev-parse --path-format=absolute --git-common-dir",
            None
        )
    );
    assert_eq!(fixture.methods(), ["worktree.create"]);
    assert_eq!(fixture.params()[0]["path"], "/trees/feature-x");
}

#[tokio::test]
async fn a_worktree_command_defaults_under_the_repository_s_name_not_the_linked_checkout_s() {
    let fixture = unreported(
        json!({ "worktree_command": "mk {path}" }),
        Some("/repo/.git"),
    );
    create(
        &fixture,
        json!({ "workspace_id": "source", "branch": "feature/x" }),
    )
    .await
    .unwrap();
    let command = fixture
        .runner
        .requests()
        .into_iter()
        .map(|request| last_word(&request))
        .find(|command| !command.contains("--git-common-dir") && !command.contains("command -v"))
        .unwrap();
    assert!(
        remote_script(&command)
            .contains(r#"export ROAMGATE_WORKTREE_PATH="$HOME"/'.herdr/worktrees/repo/feature-x'"#)
    );
}

#[tokio::test]
async fn settings_saved_under_the_checkout_path_still_apply() {
    let legacy = unreported(
        json!({ "repositories": { "ssh:host:/repo.worktrees/review": { "worktree_directory": "/legacy" } } }),
        Some("/repo/.git"),
    );
    *legacy.source.lock().unwrap() = Some(json!({ "cwd": "/repo.worktrees/review" }));
    create(
        &legacy,
        json!({ "workspace_id": "source", "branch": "feature/x" }),
    )
    .await
    .unwrap();
    assert_eq!(legacy.params()[0]["path"], "/legacy/feature-x");

    let no_git = unreported(
        json!({ "repositories": { "ssh:host:/repo/.git": { "worktree_directory": "/t" } } }),
        None,
    );
    create(
        &no_git,
        json!({ "workspace_id": "source", "branch": "feature/x" }),
    )
    .await
    .unwrap();
    assert!(no_git.params()[0].get("path").is_none());
}

#[tokio::test]
async fn a_repository_herdr_reports_is_not_asked_of_git() {
    let fixture = unreported(
        json!({ "repositories": { "ssh:host:/source/.git": { "worktree_directory": "/s" } } }),
        Some("/repo/.git"),
    );
    *fixture.source.lock().unwrap() =
        Some(json!({ "worktree": { "repo_key": "/source/.git", "checkout_path": "/source/wt" } }));
    create(
        &fixture,
        json!({ "workspace_id": "source", "branch": "feature/x" }),
    )
    .await
    .unwrap();
    assert!(common_dir_probes(&fixture).is_empty());
    assert_eq!(fixture.params()[0]["path"], "/s/feature-x");
}

#[tokio::test]
async fn a_command_changed_while_its_install_probe_runs_is_not_dispatched() {
    let template = "git recworktree add {path} --branch {branch}";
    let settings = MemorySettings::new(json!({ "worktree_command": template }));
    let executed = Arc::new(AtomicBool::new(false));
    let (store, ran_command) = (settings.clone(), executed.clone());
    let runner = FnRunner::answering(move |request| {
        if last_word(request).contains("command -v") {
            *store.0.lock().unwrap() = Arc::new(Settings::normalize(
                &json!({ "worktree_command": "different-command {path}" }),
            ));
            return Ok(ran(0, "", ""));
        }
        ran_command.store(true, Ordering::SeqCst);
        Ok(ran(0, "/created/checkout\n", ""))
    });
    let mut fixture = fixture_on(None, false, &["/source/root"], json!({}), runner);
    fixture.settings = settings;
    let fixture = Arc::new(fixture);
    let error = create(
        &fixture,
        json!({ "workspace_id": "source", "branch": "feature", "expected_worktree_command": template }),
    )
    .await
    .unwrap_err();
    assert!(error.message.contains("The worktree command changed"));
    assert!(!executed.load(Ordering::SeqCst));
    assert!(fixture.methods().is_empty());
}

#[tokio::test]
async fn a_fresh_worktree_path_skips_any_existing_directory_and_any_worktree_git_still_lists() {
    let dir = tempfile::Builder::new()
        .prefix("rg-fresh-")
        .tempdir()
        .unwrap();
    // Without Windows' \\?\ prefix, which git cannot make directories under.
    let root = crate::file_types::realpath(dir.path()).unwrap();
    let repo = root.join("repo");
    let git = |args: &[&str]| {
        let output = std::process::Command::new("git")
            .args(args)
            .env("GIT_AUTHOR_NAME", "T")
            .env("GIT_AUTHOR_EMAIL", "t@example.org")
            .env("GIT_COMMITTER_NAME", "T")
            .env("GIT_COMMITTER_EMAIL", "t@example.org")
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
    };
    let repo_path = repo.to_str().unwrap();
    git(&["init", "-q", repo_path]);
    git(&[
        "-C",
        repo_path,
        "commit",
        "-q",
        "--allow-empty",
        "-m",
        "init",
    ]);
    let base = root.join("wt").join("layer");
    let base = base.to_str().unwrap();
    let cx = GitContext::local(Arc::new(LocalRunner::system()));
    assert_eq!(
        free_worktree_path(base, "part", repo_path, &cx)
            .await
            .unwrap(),
        base
    );
    // Another branch's worktree at the path, a plain directory at the
    // next, and a removed worktree Git still lists at the one after.
    git(&[
        "-C", repo_path, "worktree", "add", "-q", "-b", "layer", base,
    ]);
    std::fs::create_dir_all(format!("{base}-part")).unwrap();
    git(&[
        "-C",
        repo_path,
        "worktree",
        "add",
        "-q",
        "-b",
        "gone",
        &format!("{base}-part-2"),
    ]);
    std::fs::remove_dir_all(format!("{base}-part-2")).unwrap();
    assert_eq!(
        free_worktree_path(base, "part", repo_path, &cx)
            .await
            .unwrap(),
        format!("{base}-part-3")
    );
}
