//! home.test.ts's service cases: a connection whose shell and Herdr are
//! fakes: the scripts answer by what they do, Herdr keeps workspaces and
//! panes, and the pane's agent becomes an idle Claude a moment after
//! `claude` is typed.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use roamgate_agents::js::Obj;
use serde_json::{Value, json};

use super::test_item::item;
use super::*;
use crate::claude::AgentCommand;
use crate::connection::{BoxFuture, LaunchSpec, MrConnection, ShellResult};
use crate::inbox::test_support::{SharedStore, store};

#[derive(Default)]
struct Fake {
    conversation: bool,
    launch: bool,
    scripts: Mutex<Vec<String>>,
    launches: Mutex<Vec<(String, LaunchSpec)>>,
    herdr_calls: Mutex<Vec<(String, Value)>>,
    workspaces: Mutex<Vec<Value>>,
    panes: Mutex<Vec<Value>>,
    agent: Mutex<Value>,
    held: Mutex<Option<String>>,
    prompted: Mutex<Vec<String>>,
}

struct Conn(Arc<Fake>);

static CD: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"cd '([^']+)'").expect("pattern"));
static SESSION: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"--session-id (\S+)").expect("pattern"));

fn answer(stdout: &str) -> ShellResult {
    ShellResult {
        code: 0,
        stdout: stdout.into(),
        stderr: String::new(),
    }
}

impl MrConnection for Conn {
    fn id(&self) -> &str {
        "local"
    }
    fn label(&self) -> &str {
        "Desktop"
    }
    fn run<'a>(&'a self, script: &'a str, _timeout: u64) -> BoxFuture<'a, ShellResult> {
        self.0.scripts.lock().unwrap().push(script.to_owned());
        let result = if script.contains("show-ref --verify") {
            answer("NAME gcc-fix\n")
        } else if script.contains("reset -q --keep") {
            answer("AT abc1234\n")
        } else if script.contains("printf \"TOP") {
            // The clone is a checkout: its worktrees start from it.
            answer("TOP\t/src/gstreamer\n")
        } else if script.contains("rev-parse --show-toplevel") {
            let dir = CD
                .captures(script)
                .map(|c| c[1].to_owned())
                .unwrap_or_default();
            answer(&format!(
                "T\t{dir}\nR\torigin\tgit@gitlab.example.org:gstreamer/gstreamer.git\nR\tmine\tgit@gitlab.example.org:me/gstreamer.git\n"
            ))
        } else if script.contains("git fetch") || script.contains("cat-file -e") {
            answer("HAVE 3326\n")
        } else {
            answer("")
        };
        Box::pin(async move { result })
    }
    fn herdr<'a>(&'a self, method: &'a str, params: Value) -> BoxFuture<'a, Result<Value, String>> {
        let fake = self.0.clone();
        fake.herdr_calls
            .lock()
            .unwrap()
            .push((method.to_owned(), params.clone()));
        let result = match method {
            "workspace.list" => json!({"workspaces": *fake.workspaces.lock().unwrap()}),
            "pane.list" => json!({"panes": *fake.panes.lock().unwrap()}),
            "workspace.rename" => {
                for each in fake.workspaces.lock().unwrap().iter_mut() {
                    if each["workspace_id"] == params["workspace_id"] {
                        each["label"] = params["label"].clone();
                    }
                }
                json!({})
            }
            "agent.get" => json!({"agent": *fake.agent.lock().unwrap()}),
            "pane.send_text" => {
                let text = params["text"].as_str().unwrap_or("").to_owned();
                if let Some(session) = SESSION.captures(&text).map(|c| c[1].to_owned()) {
                    if fake.conversation {
                        *fake.held.lock().unwrap() = Some(session);
                    } else {
                        *fake.agent.lock().unwrap() =
                            json!({"agent": "claude", "agent_status": "unknown"});
                        // Ready a moment later (its start, a trust question).
                        let later = fake.clone();
                        tokio::spawn(async move {
                            tokio::time::sleep(Duration::from_millis(5)).await;
                            *later.agent.lock().unwrap() =
                                json!({"agent": "claude", "agent_status": "idle"});
                        });
                    }
                }
                json!({})
            }
            "agent.prompt" => {
                fake.prompted
                    .lock()
                    .unwrap()
                    .push(params["text"].as_str().unwrap_or("").to_owned());
                json!({})
            }
            _ => json!({}),
        };
        Box::pin(async move { Ok(result) })
    }
    fn can_launch(&self) -> bool {
        self.0.launch
    }
    fn launch<'a>(
        &'a self,
        pane_id: &'a str,
        spec: LaunchSpec,
    ) -> BoxFuture<'a, Result<String, String>> {
        // The typed text carries the argv only so the fake sees the start.
        let mut launches = self.0.launches.lock().unwrap();
        let typed = format!(
            " roamgate-hold --launch t{} {}\r",
            launches.len() + 1,
            spec.argv.join(" ")
        );
        launches.push((pane_id.to_owned(), spec));
        Box::pin(async move { Ok(typed) })
    }
    fn conversation_owned<'a>(&'a self, _pane_id: &'a str) -> BoxFuture<'a, Option<String>> {
        let held = if self.0.conversation {
            self.0.held.lock().unwrap().clone()
        } else {
            None
        };
        Box::pin(async move { held })
    }
    fn conversation_prompt<'a>(
        &'a self,
        _pane_id: &'a str,
        text: &'a str,
    ) -> BoxFuture<'a, Result<bool, String>> {
        let held = self.0.held.lock().unwrap().is_some();
        if held {
            self.0.prompted.lock().unwrap().push(text.to_owned());
        }
        Box::pin(async move { Ok(held) })
    }
}

struct Setup {
    _dir: tempfile::TempDir,
    store: SharedStore,
    fake: Arc<Fake>,
    homes: MrHomes,
    made: Arc<Mutex<Vec<Obj>>>,
    placed: Arc<Mutex<Vec<Obj>>>,
    reviews: Arc<Mutex<Vec<Obj>>>,
    seen: Arc<Mutex<Vec<String>>>,
    request: Obj,
}

#[derive(Default)]
struct Options {
    conversation: bool,
    launch: bool,
    home_prompt: Option<String>,
    agent_command: Option<AgentCommand>,
}

fn setup(options: Options) -> Setup {
    let (dir, store) = store();
    let fake = Arc::new(Fake {
        conversation: options.conversation,
        launch: options.launch,
        workspaces: Mutex::new(vec![
            // Herdr's list gives no folder here: its pane does.
            json!({"workspace_id": "w-clone", "label": "gstreamer"}),
            json!({"workspace_id": "w-review", "label": "Reviews \u{b7} gstreamer",
                "cwd": "/src/gstreamer.worktrees/review"}),
        ]),
        panes: Mutex::new(vec![
            json!({"pane_id": "p-review", "workspace_id": "w-review"}),
            json!({"pane_id": "p-clone", "workspace_id": "w-clone", "cwd": "/src/gstreamer/"}),
        ]),
        agent: Mutex::new(Value::Null),
        ..Fake::default()
    });
    let conn: Arc<dyn MrConnection> = Arc::new(Conn(fake.clone()));
    let request = item(json!({}));
    let made = Arc::new(Mutex::new(vec![]));
    let placed = Arc::new(Mutex::new(vec![]));
    let reviews = Arc::new(Mutex::new(vec![]));
    let seen = Arc::new(Mutex::new(vec![]));
    let known = request.clone();
    let project_conn = conn.clone();
    let opened = reviews.clone();
    let marked = seen.clone();
    let home_prompt = options.home_prompt.unwrap_or_default();
    let mut deps = MrHomesDeps::new(
        Arc::new(move |key: &str| {
            if key == js::sv(known.get("key")) {
                Ok(known.clone())
            } else {
                Err(RpcError::Failed("no such request".into()))
            }
        }),
        store.clone(),
        {
            let conn = conn.clone();
            Arc::new(move || vec![conn.clone()])
        },
        Arc::new(move || {
            let settings = json!({"homePrompt": home_prompt})
                .as_object()
                .unwrap()
                .clone();
            Box::pin(async move { settings })
        }),
        Arc::new(move |_item| {
            let conn = project_conn.clone();
            Box::pin(async move {
                let record = json!({"connectionId": "local", "clone": "/src/gstreamer",
                    "worktree": "/src/gstreamer.worktrees/review", "workspaceId": "w-review",
                    "remote": "origin"});
                Ok(Some((conn, record.as_object().unwrap().clone())))
            })
        }),
        Arc::new(move |params| {
            let mut opened = opened.lock().unwrap();
            opened.push(params);
            let snapshot = json!({"session": {"id": format!("rs-{}", opened.len())}});
            Box::pin(async move { Ok(snapshot) })
        }),
        Arc::new(move |key: &str| marked.lock().unwrap().push(key.to_owned())),
    );
    let (made_in, fake_in) = (made.clone(), fake.clone());
    deps.create_worktree = Some(Arc::new(move |input: Obj| {
        let path = format!(
            "/home/u/.herdr/worktrees/gstreamer/{}",
            js::sv(input.get("branch"))
        );
        fake_in.workspaces.lock().unwrap().push(json!({
            "workspace_id": "w-home", "label": input["branch"],
            "worktree": {"checkout_path": path},
        }));
        fake_in
            .panes
            .lock()
            .unwrap()
            .push(json!({"pane_id": "p-home", "workspace_id": "w-home"}));
        made_in.lock().unwrap().push(input);
        Box::pin(async move {
            Ok(MadeWorktree {
                path,
                workspace_id: Some("w-home".into()),
            })
        })
    }));
    let placed_in = placed.clone();
    deps.place_workspace = Some(Arc::new(move |params| {
        placed_in.lock().unwrap().push(params);
        Box::pin(async { Ok(()) })
    }));
    if let Some(command) = options.agent_command {
        deps.agent_command = Some(Arc::new(move |_session| {
            let command = command.clone();
            Box::pin(async move { Ok(command) })
        }));
    }
    if options.conversation {
        deps.start_mode = Some(Arc::new(|| Box::pin(async { StartMode::Conversation })));
    }
    deps.poll_ms = 1;
    deps.deliver_ms = 2_000;
    Setup {
        _dir: dir,
        store,
        fake,
        homes: MrHomes::new(deps),
        made,
        placed,
        reviews,
        seen,
        request,
    }
}

fn objects(list: &Mutex<Vec<Obj>>) -> Value {
    Value::Array(
        list.lock()
            .unwrap()
            .iter()
            .cloned()
            .map(Value::Object)
            .collect(),
    )
}

fn sent_texts(fake: &Fake) -> Vec<Value> {
    fake.herdr_calls
        .lock()
        .unwrap()
        .iter()
        .filter(|(method, _)| method == "pane.send_text")
        .map(|(_, params)| params.clone())
        .collect()
}

/// GLM, a gateway profile with a secret read from its file.
fn glm() -> AgentCommand {
    AgentCommand {
        profile: "GLM".into(),
        agent: "claude".into(),
        program: "claude".into(),
        env: vec![
            ("ANTHROPIC_BASE_URL".into(), "https://gw.example".into()),
            ("ANTHROPIC_AUTH_TOKEN".into(), "s3cret".into()),
        ],
        unset: vec!["ANTHROPIC_API_KEY".into()],
        plain: false,
        model: None,
    }
}

const LABEL: &str = "!3326 rtpgccbwe: Fix the estimate when packets are lost in\u{2026}";
const PATH: &str = "/home/u/.herdr/worktrees/gstreamer/gcc-fix";

#[tokio::test(start_paused = true)]
async fn start_a_review_with_a_home_workspace_made_named_placed_review_shown_there_claude_started_and_told_link_recorded()
 {
    let t = setup(Options::default());
    let key = js::sv(t.request.get("key")).to_owned();
    let started = t.homes.start(&key).await.unwrap();
    // The worktree through the user's worktree path, from the clone's own
    // workspace, on the request's branch name, moved to its head.
    assert_eq!(
        objects(&t.made),
        json!([{"connectionId": "local", "workspaceId": "w-clone", "branch": "gcc-fix"}])
    );
    let scripts = t.fake.scripts.lock().unwrap().clone();
    assert!(
        scripts
            .iter()
            .any(|s| s.contains(PATH) && s.contains("reset -q --keep 'abc1234'"))
    );
    // Only fetches towards the forge.
    assert!(
        !scripts
            .iter()
            .any(|s| s.contains("git push") || s.contains("git commit"))
    );
    let renamed = t
        .fake
        .herdr_calls
        .lock()
        .unwrap()
        .iter()
        .find(|(method, _)| method == "workspace.rename")
        .map(|(_, params)| params.clone());
    assert_eq!(
        renamed,
        Some(json!({"workspace_id": "w-home", "label": LABEL}))
    );
    assert_eq!(
        objects(&t.placed),
        json!([{"projectKey": "gitlab.example.org/gstreamer/gstreamer", "connectionId": "local",
            "workspaceId": "w-home", "label": LABEL, "worktree": PATH, "clone": "/src/gstreamer"}])
    );
    // Its review, in the home, bound to the pane its Claude runs in.
    assert_eq!(
        objects(&t.reviews),
        json!([{"connectionId": "local", "workspaceId": "w-home", "root": PATH,
            "url": t.request["url"],
            "title": format!("gstreamer/gstreamer!3326 {}", js::sv(t.request.get("title"))),
            "paneId": "p-home"}])
    );
    assert_eq!(started["created"], json!(true));
    assert_eq!(started["branch"], json!("gcc-fix"));
    assert_eq!(started["connectionId"], json!("local"));
    assert_eq!(started["workspaceId"], json!("w-home"));
    assert_eq!(started["sessionId"], json!("rs-1"));
    assert_eq!(started["agent"]["state"], json!("starting"));
    assert_eq!(started["agent"]["paneId"], json!("p-home"));
    let session = started["agent"]["session"].as_str().unwrap().to_owned();
    // Claude typed into the home's pane, then its job once it is idle.
    let typed = sent_texts(&t.fake);
    assert_eq!(typed[0]["pane_id"], "p-home");
    assert!(
        typed[0]["text"]
            .as_str()
            .unwrap()
            .contains(&format!("--session-id {session}"))
    );
    assert!(t.homes.delivered(&key).await);
    let prompted = t.fake.prompted.lock().unwrap().clone();
    assert_eq!(prompted.len(), 1);
    assert!(prompted[0].contains(js::sv(t.request.get("url"))));
    assert!(prompted[0].contains("pending drafts"));
    // The board links the request to it from now on.
    let home = t.store.lock().unwrap().get()["homes"][key.as_str()].clone();
    assert_eq!(home["connectionId"], "local");
    assert_eq!(home["workspaceId"], "w-home");
    assert_eq!(home["path"], PATH);
    assert_eq!(home["branch"], "gcc-fix");
    assert_eq!(home["sessionId"], "rs-1");
    assert_eq!(home["claudeSession"], json!(session));

    // Again: the home made before, no second worktree.
    let again = t.homes.start(&key).await.unwrap();
    assert_eq!(again["created"], json!(false));
    assert_eq!(t.made.lock().unwrap().len(), 1);
    assert_eq!(again["workspaceId"], json!("w-home"));
}

#[tokio::test(start_paused = true)]
async fn the_prompt_setting_and_conversation_modes_own_delivery() {
    let t = setup(Options {
        conversation: true,
        home_prompt: Some("Home of {ref}: {url}".into()),
        ..Options::default()
    });
    let key = js::sv(t.request.get("key")).to_owned();
    t.homes.start(&key).await.unwrap();
    assert!(t.homes.delivered(&key).await);
    assert_eq!(
        *t.fake.prompted.lock().unwrap(),
        vec![format!(
            "Home of gstreamer/gstreamer!3326: {}",
            js::sv(t.request.get("url"))
        )]
    );
    assert!(
        !t.fake
            .herdr_calls
            .lock()
            .unwrap()
            .iter()
            .any(|(method, _)| method == "agent.prompt")
    );
}

#[tokio::test(start_paused = true)]
async fn opening_in_a_home_its_head_fetched_from_the_projects_remote_there_the_review_shown_in_it()
{
    let t = setup(Options::default());
    let key = js::sv(t.request.get("key")).to_owned();
    t.fake.workspaces.lock().unwrap().push(json!({
        "workspace_id": "w-branch", "label": "gcc work", "cwd": "/src/gstreamer.worktrees/gcc",
    }));
    let at = WorkspaceAt {
        connection_id: "local".into(),
        workspace_id: "w-branch".into(),
    };
    let opened = t.homes.open_in(&key, &at, None).await.unwrap();
    assert_eq!(opened["connectionId"], "local");
    assert_eq!(opened["workspaceId"], "w-branch");
    assert_eq!(opened["root"], "/src/gstreamer.worktrees/gcc");
    let scripts = t.fake.scripts.lock().unwrap().clone();
    let fetch = scripts.iter().find(|s| s.contains("git fetch")).unwrap();
    assert!(fetch.contains("cd '/src/gstreamer.worktrees/gcc'"));
    assert!(fetch.contains("'origin'"));
    let reviews = objects(&t.reviews);
    assert_eq!(reviews[0]["workspaceId"], "w-branch");
    assert_eq!(reviews[0]["root"], "/src/gstreamer.worktrees/gcc");
    assert_eq!(*t.seen.lock().unwrap(), vec![key.clone()]);
    let gone = WorkspaceAt {
        connection_id: "local".into(),
        workspace_id: "gone".into(),
    };
    let error = t.homes.open_in(&key, &gone, None).await.unwrap_err();
    assert!(error.message().contains("not open any more"));
}

#[tokio::test(start_paused = true)]
async fn the_homes_claude_starts_with_the_default_profile_through_roamgate_hold() {
    let t = setup(Options {
        launch: true,
        agent_command: Some(glm()),
        ..Options::default()
    });
    let key = js::sv(t.request.get("key")).to_owned();
    let started = t.homes.start(&key).await.unwrap();
    let session = started["agent"]["session"].as_str().unwrap().to_owned();
    // The profile's program and environment go through a one-use token:
    // nothing secret is typed into the pane.
    let launches = t.fake.launches.lock().unwrap().clone();
    assert_eq!(launches.len(), 1);
    assert_eq!(launches[0].0, "p-home");
    let spec = &launches[0].1;
    assert_eq!(
        spec.argv,
        vec!["claude".to_owned(), "--session-id".into(), session]
    );
    assert_eq!(
        spec.to_json()["env"],
        json!({"ANTHROPIC_BASE_URL": "https://gw.example", "ANTHROPIC_AUTH_TOKEN": "s3cret"})
    );
    assert!(spec.unset.contains(&"ANTHROPIC_API_KEY".to_owned()));
    assert_eq!(spec.agent, "claude");
    assert!(spec.terminal);
    let typed = sent_texts(&t.fake);
    assert_eq!(typed.len(), 1);
    let text = typed[0]["text"].as_str().unwrap();
    assert!(text.starts_with(" roamgate-hold --launch t1 "));
    assert!(!text.contains("s3cret"));
    // Told its job as any home's Claude.
    assert!(t.homes.delivered(&key).await);
    assert_eq!(t.fake.prompted.lock().unwrap().len(), 1);
}

#[tokio::test(start_paused = true)]
async fn conversation_modes_home_start_takes_the_profile_too_the_plain_default_types_claude_as_before()
 {
    let held = setup(Options {
        launch: true,
        conversation: true,
        agent_command: Some(glm()),
        ..Options::default()
    });
    let key = js::sv(held.request.get("key")).to_owned();
    held.homes.start(&key).await.unwrap();
    let launches = held.fake.launches.lock().unwrap().clone();
    assert_eq!(launches.len(), 1);
    assert!(!launches[0].1.terminal);
    assert!(held.homes.delivered(&key).await);

    let plain = setup(Options {
        launch: true,
        agent_command: Some(AgentCommand::plain_claude()),
        ..Options::default()
    });
    let started = plain.homes.start(&key).await.unwrap();
    assert!(plain.fake.launches.lock().unwrap().is_empty());
    let session = started["agent"]["session"].as_str().unwrap();
    assert_eq!(
        sent_texts(&plain.fake)[0]["text"],
        json!(claude_command(session, false, StartMode::Terminal, None).unwrap())
    );
}
