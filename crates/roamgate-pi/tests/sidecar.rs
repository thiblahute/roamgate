//! The Rust client against the sidecar's real TS server
//! (server/src/assistant/pi-sidecar-server.ts) run by Bun with scripted
//! drivers (tests/fixtures/fake-sidecar.ts): the wire across the two
//! languages, the twins of server/src/assistant/pi-sidecar.test.ts.
//! Skipped, saying why, when bun is not on PATH. The tests wait on the
//! real clock: the sidecar is a real process.
#![allow(clippy::disallowed_methods)]

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use roamgate_pi::{
    BoxFuture, LoginInteraction, PiDriver, PiError, PiSidecar, RunEvent, RunHandler, RunInput,
    SaveModels, SidecarConfig,
};
use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;

fn repo() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .canonicalize()
        .unwrap()
}

fn bun() -> Option<PathBuf> {
    let found = std::env::var_os("PATH").and_then(|paths| {
        std::env::split_paths(&paths)
            .map(|dir| dir.join(if cfg!(windows) { "bun.exe" } else { "bun" }))
            .find(|path| path.is_file())
    });
    if found.is_none() {
        eprintln!("skipped: bun is not on PATH, the sidecar cannot run");
    }
    found
}

fn fake(idle: Duration) -> Option<PiSidecar> {
    let bun = bun()?;
    let script = repo().join("crates/roamgate-pi/tests/fixtures/fake-sidecar.ts");
    let mut config = SidecarConfig::new(vec![
        bun.to_string_lossy().into_owned(),
        script.to_string_lossy().into_owned(),
    ]);
    config.idle = idle;
    Some(PiSidecar::new(config))
}

fn config() -> Value {
    json!({
        "provider": "anthropic",
        "model": "test",
        "credential_source": "assistant",
        "allowed_workspaces": [],
    })
}

fn input(text: &str) -> RunInput {
    RunInput {
        config: config(),
        text: text.to_owned(),
        ..RunInput::default()
    }
}

/// A run's handler: records events and tool calls, answers tools by name.
#[derive(Default)]
struct Recorder {
    callbacks: Vec<&'static str>,
    handlers: Vec<&'static str>,
    log: Arc<Mutex<Vec<String>>>,
    events: Mutex<Vec<RunEvent>>,
    checkpoint_delay: Duration,
}

impl Recorder {
    fn events(&self) -> Vec<RunEvent> {
        self.events.lock().unwrap().clone()
    }

    fn log(&self) -> Vec<String> {
        self.log.lock().unwrap().clone()
    }
}

impl RunHandler for Recorder {
    fn callbacks(&self) -> Vec<&'static str> {
        self.callbacks.clone()
    }

    fn handlers(&self) -> Vec<&'static str> {
        self.handlers.clone()
    }

    fn event(&self, event: RunEvent) {
        if let RunEvent::Delta(text) = &event {
            self.log.lock().unwrap().push(format!("delta {text}"));
        }
        self.events.lock().unwrap().push(event);
    }

    fn checkpoint(&self, entries: Vec<Value>) -> BoxFuture<Result<(), PiError>> {
        let delay = self.checkpoint_delay;
        let log = self.log.clone();
        Box::pin(async move {
            tokio::time::sleep(delay).await;
            log.lock()
                .unwrap()
                .push(format!("checkpoint {}", Value::Array(entries)));
            Ok(())
        })
    }

    fn tool(
        &self,
        handler: &str,
        args: Vec<Value>,
        cancel: CancellationToken,
    ) -> BoxFuture<Result<Value, PiError>> {
        let handler = handler.to_owned();
        Box::pin(async move {
            Ok(match handler.as_str() {
                "read" => match args[0].as_str().unwrap() {
                    "user" => return Err(PiError::user("Invalid workspace.")),
                    "other" => return Err(PiError::failed("socket /run/x refused")),
                    kind => json!({
                        "text": format!("read {kind} {} {}", args[1], !cancel.is_cancelled())
                    }),
                },
                "task" => json!({ "text": format!("task {}", args[0].as_str().unwrap()) }),
                "notify" => json!({ "text": format!("notify {}", args[0]) }),
                "show" => {
                    json!({ "text": format!("show {}", args[0]["workspace_id"].as_str().unwrap()) })
                }
                other => json!({ "text": format!("unexpected {other}") }),
            })
        })
    }
}

#[tokio::test]
async fn a_run_streams_its_events_in_order_and_returns_the_entries_pi_kept() {
    let Some(sidecar) = fake(Duration::from_secs(60)) else {
        return;
    };
    let driver = PiDriver::new(sidecar.clone(), "/ranger", Some("/credentials"));
    let recorder = Arc::new(Recorder {
        callbacks: vec!["replace", "thinking", "sources", "steered", "checkpoint"],
        ..Recorder::default()
    });
    let mut run = input("events");
    run.request_id = Some("q1".into());
    run.steers = Some(vec![json!({ "requestId": "s1", "text": "earlier" })]);
    run.entries = vec![json!({ "type": "ranger-durable", "id": "d0" })];
    run.recover = true;
    let entries = driver
        .run(run, recorder.clone(), CancellationToken::new())
        .await
        .unwrap();
    assert_eq!(entries[0], json!({ "type": "ranger-durable", "id": "d1" }));
    assert_eq!(
        entries[1],
        json!({
            "request_id": "q1",
            "steers": [{ "requestId": "s1", "text": "earlier" }],
            "recover": true,
            "entries": [{ "type": "ranger-durable", "id": "d0" }],
            "config": config(),
            "present": ["checkpoint", "replace", "thinking", "sources", "steered"],
        })
    );
    assert_eq!(
        recorder.events(),
        [
            RunEvent::Delta("Hel".into()),
            RunEvent::Delta("lo".into()),
            RunEvent::Tool {
                id: "t1".into(),
                name: "workspace_status".into(),
                status: "running".into(),
                details: None,
            },
            RunEvent::Tool {
                id: "t1".into(),
                name: "workspace_status".into(),
                status: "completed".into(),
                details: Some(json!({ "arguments": "{}", "output": "ok" })),
            },
            RunEvent::Thinking(vec!["Thinking".into()]),
            RunEvent::Sources(json!([])),
            RunEvent::Replace("Hello".into()),
            RunEvent::Steered {
                request_id: None,
                text: "more".into(),
            },
            RunEvent::Steered {
                request_id: Some("s2".into()),
                text: "again".into(),
            },
            RunEvent::Message("Hello".into()),
            RunEvent::Error,
        ]
    );
    sidecar.close().await;
}

#[tokio::test]
async fn a_callback_the_server_left_out_stays_out_in_the_sidecar() {
    let Some(sidecar) = fake(Duration::from_secs(60)) else {
        return;
    };
    let driver = PiDriver::new(sidecar.clone(), "/ranger", None);
    let recorder = Arc::new(Recorder {
        callbacks: vec!["replace"],
        ..Recorder::default()
    });
    let entries = driver
        .run(input("events"), recorder.clone(), CancellationToken::new())
        .await
        .unwrap();
    assert_eq!(entries[1]["present"], json!(["replace"]));
    // Without them, Pi's reports of those callbacks are not sent.
    assert!(!recorder.events().iter().any(|event| matches!(
        event,
        RunEvent::Thinking(_) | RunEvent::Sources(_) | RunEvent::Steered { .. }
    )));
    sidecar.close().await;
}

#[tokio::test]
async fn checkpoint_and_save_are_answered_before_the_sidecar_goes_on() {
    let Some(sidecar) = fake(Duration::from_secs(60)) else {
        return;
    };
    let dir = tempfile::tempdir().unwrap();
    let directory = dir.path().to_string_lossy().into_owned();
    let driver = PiDriver::new(sidecar.clone(), &directory, None);
    let recorder = Arc::new(Recorder {
        callbacks: vec!["checkpoint"],
        checkpoint_delay: Duration::from_millis(50),
        ..Recorder::default()
    });
    driver
        .run(
            input("checkpoint"),
            recorder.clone(),
            CancellationToken::new(),
        )
        .await
        .unwrap();
    assert_eq!(
        recorder.log(),
        [
            r#"checkpoint [{"type":"ranger-durable","id":"d2"}]"#,
            "delta admitted",
        ]
    );
    let saves = Arc::new(Mutex::new(Vec::new()));
    let save: SaveModels = {
        let saves = saves.clone();
        Arc::new(move |path: String, value: Value| {
            let saves = saves.clone();
            Box::pin(async move {
                tokio::time::sleep(Duration::from_millis(50)).await;
                std::fs::write(&path, format!("{value}\n")).unwrap();
                saves.lock().unwrap().push(path);
                Ok(())
            })
        })
    };
    driver
        .configure_model(json!({ "provider": "custom" }), save)
        .await
        .unwrap();
    assert_eq!(*saves.lock().unwrap(), [format!("{directory}/models.json")]);
    let catalog = driver.catalog("assistant").await.unwrap();
    assert_eq!(catalog["log"], json!(["reloaded"]));
    sidecar.close().await;
}

#[tokio::test]
async fn a_failed_save_fails_the_model_configuration_in_the_sidecar() {
    let Some(sidecar) = fake(Duration::from_secs(60)) else {
        return;
    };
    let driver = PiDriver::new(sidecar.clone(), "/ranger", None);
    let save: SaveModels = Arc::new(|_path: String, _value: Value| {
        Box::pin(async { Err(PiError::failed("Saved session is too large")) })
    });
    assert_eq!(
        driver.configure_model(json!({}), save).await,
        Err(PiError::Failed("Saved session is too large".into()))
    );
    sidecar.close().await;
}

#[tokio::test]
async fn tool_calls_reach_the_handlers_the_run_declared_and_no_other() {
    let Some(sidecar) = fake(Duration::from_secs(60)) else {
        return;
    };
    let driver = PiDriver::new(sidecar.clone(), "/ranger", None);
    let recorder = Arc::new(Recorder {
        handlers: vec!["task", "notify", "show"],
        ..Recorder::default()
    });
    let results = driver
        .run(input("tools"), recorder, CancellationToken::new())
        .await
        .unwrap();
    assert_eq!(
        results,
        [
            json!({ "text": r#"read status {"a":1} true"# }),
            json!({ "text": "task list" }),
            json!({ "text": r#"notify {"title":"T","body":"B"}"# }),
            json!({ "text": "show w" }),
            // archive was not declared: the sidecar gave Pi no handler.
            json!("no archive"),
        ]
    );
    sidecar.close().await;
}

#[tokio::test]
async fn a_user_error_keeps_its_class_across_the_wire_other_errors_their_message() {
    let Some(sidecar) = fake(Duration::from_secs(60)) else {
        return;
    };
    let driver = PiDriver::new(sidecar.clone(), "/ranger", None);
    let recorder = Arc::new(Recorder::default());
    assert_eq!(
        driver
            .run(input("errors"), recorder.clone(), CancellationToken::new())
            .await,
        Err(PiError::User("Model unavailable".into()))
    );
    assert_eq!(
        recorder.log(),
        [
            r#"delta [true,"Invalid workspace."]"#,
            r#"delta [false,"socket /run/x refused"]"#,
        ]
    );
    assert_eq!(
        driver.catalog("fail").await,
        Err(PiError::Failed("Invalid model configuration".into()))
    );
    sidecar.close().await;
}

#[tokio::test]
async fn cancelling_a_run_aborts_it_in_the_sidecar() {
    let Some(sidecar) = fake(Duration::from_secs(60)) else {
        return;
    };
    let driver = PiDriver::new(sidecar.clone(), "/ranger", None);
    let recorder = Arc::new(Recorder::default());
    let cancel = CancellationToken::new();
    let run = tokio::spawn({
        let driver = driver.clone();
        let recorder = recorder.clone();
        let cancel = cancel.clone();
        async move { driver.run(input("hang"), recorder, cancel).await }
    });
    while recorder.log().is_empty() {
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    cancel.cancel();
    assert_eq!(
        run.await.unwrap(),
        Err(PiError::Failed("Ranger stopped".into()))
    );
    assert_eq!(recorder.log(), ["delta started", "delta aborted Cancelled"]);
    sidecar.close().await;
}

#[tokio::test]
async fn steer_and_stop_reach_the_driver_of_their_directory() {
    let Some(sidecar) = fake(Duration::from_secs(60)) else {
        return;
    };
    let a = PiDriver::new(sidecar.clone(), "/a", None);
    let b = PiDriver::new(sidecar.clone(), "/b", Some("/a"));
    a.steer("more", "r1").await.unwrap();
    b.stop().await.unwrap();
    a.stop().await.unwrap();
    assert_eq!(
        a.catalog("assistant").await.unwrap()["log"],
        json!(["/a steer more r1", "/b stop", "/a stop"])
    );
    sidecar.close().await;
}

#[tokio::test]
async fn drivers_are_kept_per_directory_pair_and_dispose_forgets_one() {
    let Some(sidecar) = fake(Duration::from_secs(60)) else {
        return;
    };
    let main = PiDriver::new(sidecar.clone(), "/ranger", None);
    let task = PiDriver::new(sidecar.clone(), "/ranger/tasks/t1", Some("/ranger"));
    main.catalog("assistant").await.unwrap();
    main.catalog("pi").await.unwrap();
    task.catalog("assistant").await.unwrap();
    task.dispose().await.unwrap();
    let catalog = task.catalog("assistant").await.unwrap();
    assert_eq!(
        catalog["created"],
        json!([
            "/ranger|/ranger",
            "/ranger/tasks/t1|/ranger",
            "/ranger/tasks/t1|/ranger"
        ])
    );
    assert_eq!(catalog["disposed"], json!(["/ranger/tasks/t1"]));
    sidecar.close().await;
}

/// A login's user: answers prompts from a list, records events.
#[derive(Default)]
struct User {
    answers: Mutex<Vec<&'static str>>,
    prompts: Mutex<Vec<Value>>,
    events: Mutex<Vec<Value>>,
    cancelled: Arc<Mutex<bool>>,
}

impl LoginInteraction for User {
    fn prompt(
        &self,
        prompt: Value,
        cancel: CancellationToken,
    ) -> BoxFuture<Result<String, PiError>> {
        self.prompts.lock().unwrap().push(prompt);
        let answer = self.answers.lock().unwrap().pop();
        let cancelled = self.cancelled.clone();
        Box::pin(async move {
            match answer {
                Some(answer) => Ok(answer.to_owned()),
                None => {
                    cancel.cancelled().await;
                    *cancelled.lock().unwrap() = true;
                    Err(PiError::failed("Login cancelled"))
                }
            }
        })
    }

    fn event(&self, event: Value) {
        self.events.lock().unwrap().push(event);
    }
}

#[tokio::test]
async fn login_prompts_and_events_go_through_the_interaction_and_a_cancelled_login_aborts_its_prompt()
 {
    let Some(sidecar) = fake(Duration::from_secs(60)) else {
        return;
    };
    let driver = PiDriver::new(sidecar.clone(), "/ranger", None);
    let user = Arc::new(User {
        answers: Mutex::new(vec!["a"]),
        ..User::default()
    });
    driver
        .login(
            "kimi",
            "oauth",
            "assistant",
            user.clone(),
            CancellationToken::new(),
        )
        .await
        .unwrap();
    assert_eq!(
        *user.events.lock().unwrap(),
        [
            json!({ "type": "info", "message": "kimi oauth" }),
            json!({
                "type": "device_code",
                "userCode": "ABCD",
                "verificationUri": "https://example.test/device",
            }),
            json!({ "type": "progress", "message": "got a" }),
        ]
    );
    assert_eq!(
        *user.prompts.lock().unwrap(),
        [json!({ "type": "select", "message": "Pick", "options": [{ "id": "a", "label": "A" }] })]
    );
    let waiting = Arc::new(User {
        answers: Mutex::new(vec!["wait"]),
        ..User::default()
    });
    let cancel = CancellationToken::new();
    let login = tokio::spawn({
        let driver = driver.clone();
        let waiting = waiting.clone();
        let cancel = cancel.clone();
        async move {
            driver
                .login("kimi", "api_key", "assistant", waiting, cancel)
                .await
        }
    });
    while waiting.prompts.lock().unwrap().len() < 2 {
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    cancel.cancel();
    assert!(login.await.unwrap().is_err());
    assert!(*waiting.cancelled.lock().unwrap());
    sidecar.close().await;
}

#[tokio::test]
async fn the_sidecar_exiting_fails_what_is_in_flight_and_the_next_call_starts_it_again() {
    let Some(sidecar) = fake(Duration::from_secs(60)) else {
        return;
    };
    let driver = PiDriver::new(sidecar.clone(), "/ranger", None);
    let recorder = Arc::new(Recorder::default());
    let run = tokio::spawn({
        let driver = driver.clone();
        let recorder = recorder.clone();
        async move {
            driver
                .run(input("forever"), recorder, CancellationToken::new())
                .await
        }
    });
    while recorder.log().is_empty() {
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    let first = sidecar.pid();
    sidecar.kill();
    assert_eq!(
        run.await.unwrap(),
        // Windows has no signals: a killed process exits with code 1.
        Err(PiError::Closed(
            if cfg!(windows) {
                "The Pi sidecar exited (1)"
            } else {
                "The Pi sidecar exited (signal)"
            }
            .into()
        ))
    );
    assert!(!sidecar.running());
    driver.catalog("assistant").await.unwrap();
    assert!(sidecar.running());
    assert_ne!(sidecar.pid(), first);
    sidecar.close().await;
}

#[tokio::test]
async fn the_sidecar_stops_after_its_idle_time_never_while_a_call_is_in_flight() {
    let Some(sidecar) = fake(Duration::from_millis(100)) else {
        return;
    };
    let driver = PiDriver::new(sidecar.clone(), "/ranger", None);
    let run = tokio::spawn({
        let driver = driver.clone();
        async move {
            driver
                .run(
                    input("slow"),
                    Arc::new(Recorder::default()),
                    CancellationToken::new(),
                )
                .await
        }
    });
    driver.catalog("assistant").await.unwrap();
    tokio::time::sleep(Duration::from_millis(150)).await;
    assert!(sidecar.running());
    run.await.unwrap().unwrap();
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    while sidecar.running() && tokio::time::Instant::now() < deadline {
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert!(!sidecar.running());
    // Stop and dispose do not start a sidecar that is not running.
    driver.stop().await.unwrap();
    driver.dispose().await.unwrap();
    assert!(!sidecar.running());
}

#[tokio::test]
async fn an_unknown_method_is_refused_with_its_json_rpc_code() {
    let Some(sidecar) = fake(Duration::from_secs(60)) else {
        return;
    };
    assert_eq!(
        sidecar.request("nope", json!({})).await,
        Err(PiError::Failed("Unknown method nope".into()))
    );
    assert_eq!(
        sidecar
            .request("initialize", json!({ "protocol": 2 }))
            .await,
        Err(PiError::Failed("Pi sidecar protocol 2 is not 1".into()))
    );
    let pid = sidecar.pid().unwrap();
    assert_eq!(
        sidecar
            .request("initialize", json!({ "protocol": 1 }))
            .await,
        Ok(json!({ "protocol": 1, "pid": pid }))
    );
    sidecar.close().await;
}
