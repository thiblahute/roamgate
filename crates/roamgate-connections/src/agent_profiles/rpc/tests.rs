//! server/src/profiles/rpc.test.ts.

use std::sync::Mutex;

use super::*;
use crate::agent_profiles::shared::normalize_profiles_settings;
use crate::agent_profiles::store::SessionProfilesOptions;
use roamgate_base::log::parse_iso_millis;
use roamgate_base::paths::DataContext;

fn settings(return_after_reset: bool) -> Value {
    json!({
        "version": 1,
        "profiles": normalize_profiles_settings(Some(&json!({
            "list": [{
                "name": "Igalia GLM",
                "agent": "claude",
                "env": {"ANTHROPIC_BASE_URL": "https://gw.example", "ANTHROPIC_MODEL": "glm-5p3"},
            }],
            "default": "Claude",
            "return_after_reset": return_after_reset,
        }))),
    })
}

fn limit_tail() -> String {
    json!({
        "type": "assistant",
        "isApiErrorMessage": true,
        "error": "rate_limit",
        "message": {"content": [{"type": "text", "text": "You've hit your 5-hour limit \u{b7} resets 5:20pm (America/Santiago)"}]},
    })
    .to_string()
}

fn answer(model: &str) -> String {
    json!({"type": "assistant", "message": {"model": model, "content": [{"type": "text", "text": "ok"}]}})
        .to_string()
}

fn system_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as i64
}

fn store_with(now: Option<NowMs>) -> Arc<SessionProfiles> {
    Arc::new(SessionProfiles::new(SessionProfilesOptions {
        file: None,
        data: DataContext::from_env(&roamgate_base::env::ProcessEnv),
        now,
        observer: None,
        can_write: None,
    }))
}

struct Host {
    agent: Mutex<Option<Value>>,
    owned: Mutex<Option<String>>,
    live: Mutex<Option<String>>,
    usage: Mutex<Option<Value>>,
    tail: Mutex<Option<String>>,
    terminal: Mutex<Restart>,
    calls: Mutex<Vec<String>>,
    launches: Mutex<Vec<(String, LaunchSpec)>>,
}

impl Host {
    fn new() -> Self {
        Self {
            agent: Mutex::new(Some(json!({
                "agent": "claude",
                "agent_status": "idle",
                "agent_session": {"kind": "id", "value": "s-1"},
            }))),
            owned: Mutex::new(None),
            live: Mutex::new(None),
            usage: Mutex::new(None),
            tail: Mutex::new(Some(limit_tail())),
            terminal: Mutex::new(Restart::ok()),
            calls: Mutex::default(),
            launches: Mutex::default(),
        }
    }

    fn calls(&self) -> Vec<String> {
        self.calls.lock().unwrap().clone()
    }
}

impl ProfileRpcHost for Host {
    fn read_settings(&self) -> HostFuture<'_, Result<Value, String>> {
        Box::pin(async { Ok(settings(true)) })
    }
    fn agent_get<'a>(&'a self, _: &'a str) -> HostFuture<'a, Option<Value>> {
        Box::pin(async { self.agent.lock().unwrap().clone() })
    }
    fn conversation_session<'a>(&'a self, _: &'a str) -> HostFuture<'a, Option<String>> {
        Box::pin(async { self.owned.lock().unwrap().clone() })
    }
    fn conversation_model<'a>(&'a self, _: &'a str) -> HostFuture<'a, Option<String>> {
        Box::pin(async { self.live.lock().unwrap().clone() })
    }
    fn restart_process<'a>(&'a self, pane_id: &'a str) -> HostFuture<'a, Restart> {
        Box::pin(async move {
            self.calls
                .lock()
                .unwrap()
                .push(format!("process {pane_id}"));
            Restart::ok()
        })
    }
    fn restart_terminal<'a>(
        &'a self,
        pane_id: &'a str,
        session_id: Option<&'a str>,
    ) -> HostFuture<'a, Restart> {
        Box::pin(async move {
            let result = self.terminal.lock().unwrap().clone();
            if result.ok {
                self.calls
                    .lock()
                    .unwrap()
                    .push(format!("terminal {pane_id} {}", session_id.unwrap_or("")));
            }
            result
        })
    }
    fn transcript_tail<'a>(&'a self, _: &'a str) -> HostFuture<'a, Option<String>> {
        Box::pin(async { self.tail.lock().unwrap().clone() })
    }
    fn typed_launch<'a>(
        &'a self,
        pane_id: &'a str,
        spec: LaunchSpec,
    ) -> HostFuture<'a, Result<String, String>> {
        Box::pin(async move {
            self.launches.lock().unwrap().push((pane_id.into(), spec));
            Ok(" launch TOKEN\r".into())
        })
    }
    fn send_conversation<'a>(
        &'a self,
        pane_id: &'a str,
        text: &'a str,
    ) -> HostFuture<'a, Result<(), String>> {
        Box::pin(async move {
            self.calls
                .lock()
                .unwrap()
                .push(format!("send {pane_id} {text}"));
            Ok(())
        })
    }
    fn prompt_terminal<'a>(
        &'a self,
        pane_id: &'a str,
        text: &'a str,
    ) -> HostFuture<'a, Result<(), String>> {
        Box::pin(async move {
            self.calls
                .lock()
                .unwrap()
                .push(format!("prompt {pane_id} {text}"));
            Ok(())
        })
    }
    fn mod_usage<'a>(&'a self, _: &'a str) -> HostFuture<'a, Option<Value>> {
        Box::pin(async { self.usage.lock().unwrap().clone() })
    }
}

fn context(store: Arc<SessionProfiles>) -> ProfileRpcContext {
    ProfileRpcContext {
        store,
        now: Arc::new(system_ms),
        home: PathBuf::from("/nonexistent-home"),
    }
}

async fn call(
    method: &str,
    params: Value,
    host: &Host,
    store: &Arc<SessionProfiles>,
) -> Result<Value, ProfileRpcError> {
    handle_profile_rpc(
        method,
        params.as_object().unwrap(),
        host,
        &context(store.clone()),
    )
    .await
}

#[tokio::test]
async fn get_the_sessions_profile_the_others_and_its_usage_limit() {
    let host = Host::new();
    let store = store_with(None);
    let result = call("agent_profile.get", json!({"pane_id": "p"}), &host, &store)
        .await
        .unwrap();
    assert_eq!(result["session_id"], json!("s-1"));
    assert_eq!(result["owner"], json!("terminal"));
    assert_eq!(result["profile"], json!("Claude"));
    assert_eq!(result["default"], json!("Claude"));
    assert_eq!(result["limit"]["kind"], json!("5-hour"));
    assert_eq!(
        result["profiles"],
        json!([
            {"name": "Claude", "agent": "claude", "label": "Claude", "default": true},
            {"name": "Igalia GLM", "agent": "claude", "label": "GLM 5p3", "default": false},
        ])
    );
}

#[tokio::test]
async fn switch_in_the_terminal_remembered_then_the_tui_restarts() {
    let host = Host::new();
    let store = store_with(None);
    let result = call(
        "agent_profile.switch",
        json!({"pane_id": "p", "profile": "Igalia GLM", "resets_at": system_ms() + 60_000}),
        &host,
        &store,
    )
    .await
    .unwrap();
    assert_eq!(result["ok"], json!(true));
    assert_eq!(result["label"], json!("GLM 5p3"));
    assert_eq!(host.calls(), vec!["terminal p s-1"]);
    let choice = store.get(Some("s-1")).unwrap();
    assert_eq!(choice["profile"], json!("Igalia GLM"));
    assert_eq!(choice["return_to"], json!("Claude"));
    // Back to the default: the choice goes.
    call(
        "agent_profile.switch",
        json!({"pane_id": "p", "profile": "Claude"}),
        &host,
        &store,
    )
    .await
    .unwrap();
    assert_eq!(store.get(Some("s-1")), None);
}

#[tokio::test]
async fn switch_in_conversation_mode_restarts_its_process() {
    let host = Host::new();
    *host.owned.lock().unwrap() = Some("s-9".into());
    let store = store_with(None);
    call(
        "agent_profile.switch",
        json!({"pane_id": "p", "profile": "Igalia GLM"}),
        &host,
        &store,
    )
    .await
    .unwrap();
    assert_eq!(host.calls(), vec!["process p"]);
}

#[tokio::test]
async fn a_refused_switch_leaves_the_session_as_it_was() {
    let host = Host::new();
    *host.terminal.lock().unwrap() = Restart::refused("Claude is working");
    let store = store_with(None);
    store.set("s-1", Some("Claude-old"), None, None);
    let result = call(
        "agent_profile.switch",
        json!({"pane_id": "p", "profile": "Igalia GLM"}),
        &host,
        &store,
    )
    .await
    .unwrap();
    // Said of the agent: the session may run another profile's model.
    assert_eq!(
        result,
        json!({"ok": false, "reason": "The agent is working"})
    );
    assert_eq!(
        store.get(Some("s-1")).unwrap()["profile"],
        json!("Claude-old")
    );
}

#[test]
fn refusals_name_the_agent_not_its_program_commands_stay() {
    assert_eq!(
        agent_neutral(
            "Claude is working (a turn or a background task); it can switch once it is idle"
        ),
        "The agent is working (a turn or a background task); it can switch once it is idle"
    );
    assert_eq!(
        agent_neutral("Something is typed in Claude's prompt box; send or clear it first"),
        "Something is typed in the agent's prompt box; send or clear it first"
    );
    assert_eq!(
        agent_neutral("Claude exited but did not start again: gone; run claude --resume s-1 there"),
        "The agent exited but did not start again: gone; run claude --resume s-1 there"
    );
    assert_eq!(
        agent_neutral("Claude Code did not answer"),
        "Claude Code did not answer"
    );
}

#[tokio::test]
async fn switch_checks_the_pane_still_runs_the_session_it_was_asked_for() {
    let host = Host::new();
    let store = store_with(None);
    let error = call(
        "agent_profile.switch",
        json!({"pane_id": "p", "profile": "Igalia GLM", "session_id": "other"}),
        &host,
        &store,
    )
    .await
    .unwrap_err();
    assert!(error.0.contains("another session"));
}

#[tokio::test]
async fn launch_plain_claude_types_as_before_a_profile_a_token() {
    let host = Host::new();
    let store = store_with(None);
    assert_eq!(
        call(
            "agent_profile.launch",
            json!({"pane_id": "p"}),
            &host,
            &store
        )
        .await
        .unwrap(),
        json!({"text": null, "profile": "Claude"})
    );
    assert_eq!(
        call(
            "agent_profile.launch",
            json!({"pane_id": "p", "profile": "Igalia GLM"}),
            &host,
            &store
        )
        .await
        .unwrap(),
        json!({"text": "launch TOKEN", "profile": "Igalia GLM"})
    );
    let launches = host.launches.lock().unwrap();
    assert_eq!(launches.len(), 1);
    assert_eq!(launches[0].0, "p");
    assert_eq!(launches[0].1.argv, vec!["claude"]);
    assert!(!launches[0].1.terminal);
    assert_eq!(launches[0].1.env["ANTHROPIC_MODEL"], "glm-5p3");
}

#[tokio::test]
async fn the_terminals_idle_claude_is_told_to_continue() {
    let host = Host::new();
    let store = store_with(None);
    let result = call(
        "agent_profile.retry",
        json!({"pane_id": "p"}),
        &host,
        &store,
    )
    .await
    .unwrap();
    assert_eq!(result["ok"], json!(true));
    assert_eq!(host.calls(), vec!["prompt p continue"]);
}

#[tokio::test]
async fn conversation_mode_gets_it_as_a_message() {
    let host = Host::new();
    *host.owned.lock().unwrap() = Some("s-9".into());
    let store = store_with(None);
    call(
        "agent_profile.retry",
        json!({"pane_id": "p"}),
        &host,
        &store,
    )
    .await
    .unwrap();
    assert_eq!(host.calls(), vec!["send p continue"]);
}

#[tokio::test]
async fn a_busy_terminal_is_left_alone() {
    let host = Host::new();
    *host.agent.lock().unwrap() = Some(json!({
        "agent": "claude",
        "agent_status": "working",
        "agent_session": {"kind": "id", "value": "s-1"},
    }));
    let store = store_with(None);
    let result = call(
        "agent_profile.retry",
        json!({"pane_id": "p"}),
        &host,
        &store,
    )
    .await
    .unwrap();
    assert_eq!(result["ok"], json!(false));
    assert!(host.calls().is_empty());
}

struct Connection {
    panes: Vec<(String, String)>,
    switched: Mutex<Vec<String>>,
}

impl ResetConnection for Connection {
    fn panes(&self) -> HostFuture<'_, Vec<(String, String)>> {
        Box::pin(async { self.panes.clone() })
    }
    fn switch_pane<'a>(&'a self, pane_id: &'a str, profile: &'a str) -> HostFuture<'a, Restart> {
        Box::pin(async move {
            self.switched
                .lock()
                .unwrap()
                .push(format!("{pane_id} {profile}"));
            Restart::ok()
        })
    }
}

#[tokio::test]
async fn a_running_session_is_switched_one_gone_just_forgets() {
    let now = Arc::new(std::sync::atomic::AtomicI64::new(0));
    let read = now.clone();
    let store = store_with(Some(Arc::new(move || {
        read.load(std::sync::atomic::Ordering::SeqCst)
    })));
    store.set("s-1", Some("Igalia GLM"), Some((10, "Claude")), None);
    store.set("s-2", Some("Igalia GLM"), Some((10, "Claude")), None);
    now.store(20, std::sync::atomic::Ordering::SeqCst);
    let connection = Arc::new(Connection {
        panes: vec![("p1".into(), "s-1".into())],
        switched: Mutex::default(),
    });
    let connections: Vec<Arc<dyn ResetConnection>> = vec![connection.clone()];
    return_after_reset(&settings(true), &store, &connections, &|_, _| {}).await;
    assert_eq!(*connection.switched.lock().unwrap(), vec!["p1 Claude"]);
    assert_eq!(store.get(Some("s-2")), None);
}

#[tokio::test]
async fn nothing_happens_with_the_setting_off() {
    let store = store_with(Some(Arc::new(|| 20)));
    store.set("s-1", Some("Igalia GLM"), Some((10, "Claude")), None);
    return_after_reset(&settings(false), &store, &[], &|_, _| {}).await;
    assert_eq!(
        store.get(Some("s-1")).unwrap()["profile"],
        json!("Igalia GLM")
    );
}

#[tokio::test]
async fn back_on_claude_after_kimi_started_on_its_claude_model_until_it_answered() {
    let host = Host::new();
    *host.tail.lock().unwrap() =
        Some([answer("claude-opus-5-5"), answer("kimi-k3p1-pro")].join("\n"));
    let store = store_with(None);
    store.set("s-1", Some("Igalia GLM"), None, None);
    call(
        "agent_profile.switch",
        json!({"pane_id": "p", "profile": "Claude"}),
        &host,
        &store,
    )
    .await
    .unwrap();
    assert_eq!(host.calls(), vec!["terminal p s-1"]);
    let choice = store.get(Some("s-1")).unwrap();
    assert_eq!(choice["profile"], Value::Null);
    assert_eq!(choice["model"], json!("claude-opus-5-5"));
    // Not answered yet: kept.
    call("agent_profile.get", json!({"pane_id": "p"}), &host, &store)
        .await
        .unwrap();
    assert_eq!(
        store.get(Some("s-1")).unwrap()["model"],
        json!("claude-opus-5-5")
    );
    // Answered on Claude: its own model choice holds from now on.
    let tail = host.tail.lock().unwrap().clone().unwrap();
    *host.tail.lock().unwrap() = Some(format!("{tail}\n{}", answer("claude-opus-5-5")));
    call("agent_profile.get", json!({"pane_id": "p"}), &host, &store)
        .await
        .unwrap();
    assert_eq!(store.get(Some("s-1")), None);
}

#[tokio::test]
async fn model_is_kept_until_the_session_answered_with_it_not_settled_by_an_older_answer() {
    let stamped = |model: &str, timestamp: &str| {
        json!({"type": "assistant", "timestamp": timestamp, "message": {"model": model, "content": [{"type": "text", "text": "ok"}]}})
            .to_string()
    };
    let host = Host::new();
    *host.tail.lock().unwrap() = Some(stamped("claude-opus-5-5", "2026-11-06T09:00:00.000Z"));
    let at = parse_iso_millis("2026-11-06T10:00:00.000Z").unwrap();
    let store = store_with(Some(Arc::new(move || at)));
    store.choose_model("s-1", Some("haiku"), Some("claude-haiku-5-5"));
    // The chip asks every minute: an answer from before is not the choice.
    call("agent_profile.get", json!({"pane_id": "p"}), &host, &store)
        .await
        .unwrap();
    assert_eq!(store.get(Some("s-1")).unwrap()["model"], json!("haiku"));
    let tail = host.tail.lock().unwrap().clone().unwrap();
    *host.tail.lock().unwrap() = Some(format!(
        "{tail}\n{}",
        stamped("claude-haiku-5-5", "2026-11-06T10:05:00.000Z")
    ));
    call("agent_profile.get", json!({"pane_id": "p"}), &host, &store)
        .await
        .unwrap();
    assert_eq!(store.get(Some("s-1")), None);
}

#[tokio::test]
async fn get_says_the_model_the_session_runs_the_surest_first() {
    let host = Host::new();
    *host.tail.lock().unwrap() = Some(answer("claude-opus-5-5"));
    let at = parse_iso_millis("2026-11-06T10:00:00.000Z").unwrap();
    let store = store_with(Some(Arc::new(move || at)));
    async fn model(host: &Host, store: &Arc<SessionProfiles>) -> Value {
        call("agent_profile.get", json!({"pane_id": "p"}), host, store)
            .await
            .unwrap()
            .get("model")
            .cloned()
            .unwrap_or(Value::Null)
    }
    // What it last answered with.
    assert_eq!(model(&host, &store).await, json!("claude-opus-5-5"));
    // A /model not answered yet: the model it runs from its next turn.
    store.choose_model("s-1", Some("haiku"), Some("claude-haiku-5-5"));
    assert_eq!(model(&host, &store).await, json!("claude-haiku-5-5"));
    // Conversation mode's running agent says best (a fallback too).
    *host.owned.lock().unwrap() = Some("s-1".into());
    *host.live.lock().unwrap() = Some("claude-sonnet-5-5".into());
    assert_eq!(model(&host, &store).await, json!("claude-sonnet-5-5"));
    // A terminal's Claude mod says what its status line shows.
    *host.owned.lock().unwrap() = None;
    *host.live.lock().unwrap() = None;
    *host.usage.lock().unwrap() =
        Some(json!({"at": "2026-11-06T10:00:00.000Z", "model": "claude-opus-5-5[1m]"}));
    assert_eq!(model(&host, &store).await, json!("claude-opus-5-5[1m]"));
    *host.usage.lock().unwrap() = None;
    // Nothing answered yet: the profile's own model.
    *host.tail.lock().unwrap() = Some(String::new());
    store.set("s-1", Some("Igalia GLM"), None, None);
    assert_eq!(model(&host, &store).await, json!("glm-5p3"));
}

#[tokio::test]
async fn get_says_another_agents_model_from_its_transcript() {
    let host = Host::new();
    *host.agent.lock().unwrap() = Some(json!({"agent": "pi", "agent_status": "idle"}));
    *host.tail.lock().unwrap() = Some(
        [
            json!({"type": "model_change", "modelId": "glm-5p3"}).to_string(),
            json!({"type": "message", "message": {"role": "assistant", "model": "deepseek-v4-flash"}})
                .to_string(),
        ]
        .join("\n"),
    );
    let store = store_with(None);
    let result = call("agent_profile.get", json!({"pane_id": "p"}), &host, &store)
        .await
        .unwrap();
    assert_eq!(result["session_id"], Value::Null);
    assert_eq!(result["model"], json!("deepseek-v4-flash"));
}

#[tokio::test]
async fn a_refused_switch_keeps_the_one_time_model_it_had() {
    let host = Host::new();
    *host.tail.lock().unwrap() = Some(answer("kimi-k3p1-pro"));
    *host.terminal.lock().unwrap() = Restart::refused("busy");
    let store = store_with(None);
    store.set("s-1", None, None, Some("claude-opus-5-5"));
    call(
        "agent_profile.switch",
        json!({"pane_id": "p", "profile": "Igalia GLM"}),
        &host,
        &store,
    )
    .await
    .unwrap();
    let choice = store.get(Some("s-1")).unwrap();
    assert_eq!(choice["profile"], Value::Null);
    assert_eq!(choice["model"], json!("claude-opus-5-5"));
}
