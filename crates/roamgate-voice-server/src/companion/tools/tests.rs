use std::collections::HashSet;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

use roamgate_base::clock::TestClock;
use roamgate_claude::mcp::{Listen, McpListener, McpRequest};
use roamgate_work::service::{WorkMeta, WorkService};
use roamgate_work::store::{NoHistory, StoreWrites, WorkStore};
use serde_json::json;

use crate::companion::claude::ClaudeCommand;
use crate::companion::front::parse_front_reply;
use crate::companion::taste::GatheredCall;
use crate::companion::youtube::{Ran, SPOTIFY_MPRIS};
use crate::config::VoiceConfig;
use crate::helper::EventSink;

use super::*;

const SEND: &str = "mcp__claude_ai_WhatsApp__send_message";
const LIST: &str = "mcp__claude_ai_WhatsApp__list_chats";

fn strings(list: &[&str]) -> Option<Vec<String>> {
    Some(list.iter().map(|s| (*s).to_owned()).collect())
}

pub(crate) fn policy() -> CompanionMcpConfig {
    CompanionMcpConfig {
        allow: strings(&["mcp__spotify", "mcp__claude_ai_Youtube__*", LIST]),
        confirm: strings(&[SEND]),
        model: None,
    }
}

pub(crate) fn policy_json() -> Value {
    json!({"allow": ["mcp__spotify", "mcp__claude_ai_Youtube__*", LIST], "confirm": [SEND]})
}

fn decision(tool: &str, input: Value, policy: &CompanionMcpConfig) -> ToolDecision {
    tool_decision(tool, &input, policy, None)
}

fn allows(rules: &[&str], confirms: &[&str]) -> CompanionMcpConfig {
    CompanionMcpConfig {
        allow: strings(rules),
        confirm: if confirms.is_empty() {
            None
        } else {
            strings(confirms)
        },
        model: None,
    }
}

#[test]
fn a_name_a_whole_server_or_a_prefix() {
    assert!(matches_tool(LIST, LIST));
    assert!(matches_tool("mcp__spotify", "mcp__spotify__pause"));
    assert!(!matches_tool("mcp__spotify", "mcp__spotify_other__pause"));
    assert!(matches_tool(
        "mcp__claude_ai_Youtube__*",
        "mcp__claude_ai_Youtube__x"
    ));
    assert!(!matches_tool("mcp__spotify__pause", "mcp__spotify__play"));
    assert!(!matches_tool("", "mcp__spotify__pause"));
    // A star anywhere: the same tool on servers named alike.
    assert!(matches_tool(
        "mcp__claude_ai_Spotify*__pause",
        "mcp__claude_ai_Spotify__home___pause"
    ));
    assert!(!matches_tool(
        "mcp__claude_ai_Spotify*__pause",
        "mcp__claude_ai_Spotify__play"
    ));
    assert!(!matches_tool("mcp__a.b*", "mcp__aXb__c"));
}

#[test]
fn case_does_not_count() {
    assert!(matches_tool(
        "mcp__claude_ai_Spotify*__devices",
        "mcp__claude_ai_spotify__devices"
    ));
    assert!(matches_tool("MCP__Spotify", "mcp__spotify__pause"));
    assert!(matches_tool(&LIST.to_lowercase(), LIST));
    assert!(!matches_tool(
        "mcp__claude_ai_Spotify*__devices",
        "mcp__claude_ai_spotify__play"
    ));
}

#[test]
fn a_tools_own_name_says_when_it_writes() {
    assert!(writes_by_name(SEND));
    assert!(writes_by_name("mcp__claude_ai_Gmail__create_draft"));
    assert!(writes_by_name("mcp__claude_ai_Google_Drive__trash_file"));
    assert!(writes_by_name("mcp__claude_ai_WhatsApp__react"));
    assert!(writes_by_name("mcp__claude_ai_WhatsApp__mark_read"));
    // Playback and reading are not writing.
    for tool in [
        "mcp__spotify__pause",
        "mcp__spotify__resume",
        "mcp__spotify__next",
        "mcp__spotify__volume",
        "mcp__spotify__play",
        "mcp__spotify__now_playing",
        LIST,
        "mcp__claude_ai_Youtube__get_transcript",
        // A server's name is not the tool's.
        "mcp__send_server__list",
    ] {
        assert!(!writes_by_name(tool), "{tool}");
    }
}

#[test]
fn each_tool_called_with_its_input_and_each_call_that_failed() {
    assert_eq!(
        tool_call_log(
            "t4",
            &json!({"type": "assistant", "message": {"content": [
                {"type": "text", "text": "Moving it."},
                {"type": "tool_use", "name": "mcp__spotify__transfer", "input": {"device": "amd-desktop", "play": true}},
            ]}})
        ),
        vec![
            r#"[voice] tool job t4: mcp__spotify__transfer {"device":"amd-desktop","play":true}"#
                .to_owned()
        ]
    );
    assert_eq!(
        tool_call_log(
            "t4",
            &json!({"type": "user", "message": {"content": [
                {"type": "tool_result", "content": "ok"},
                {"type": "tool_result", "is_error": true, "content": [{"type": "text", "text": "No active device"}]},
            ]}})
        ),
        vec!["[voice] tool job t4: a call failed: No active device".to_owned()]
    );
    let long = tool_call_log(
        "t5",
        &json!({"type": "assistant", "message": {"content": [
            {"type": "tool_use", "name": "x", "input": {"a": "b".repeat(500)}},
        ]}}),
    );
    assert!(long[0].ends_with("..."));
    assert!(long[0].len() < 340);
    assert!(tool_call_log("t6", &json!({"type": "result", "result": "done"})).is_empty());
}

#[test]
fn allowed_tools_run_unlisted_ones_are_refused() {
    let policy = policy();
    assert_eq!(
        decision("mcp__spotify__pause", json!({}), &policy),
        ToolDecision::Allow
    );
    assert_eq!(
        decision("mcp__claude_ai_Youtube__search_videos", json!({}), &policy),
        ToolDecision::Allow
    );
    assert!(matches!(
        decision("mcp__claude_ai_Gmail__search_threads", json!({}), &policy),
        ToolDecision::Deny(_)
    ));
    // Built-in tools never run through this.
    assert!(matches!(
        decision("Bash", json!({"command": "ls"}), &policy),
        ToolDecision::Deny(_)
    ));
}

#[test]
fn allowing_and_confirming_ignore_case_and_confirming_still_wins() {
    let policy = allows(
        &[
            "mcp__claude_ai_Spotify*__devices",
            "mcp__claude_ai_Spotify*",
        ],
        &["mcp__claude_ai_SPOTIFY*__start_playback"],
    );
    assert_eq!(
        decision("mcp__claude_ai_spotify__devices", json!({}), &policy),
        ToolDecision::Allow
    );
    assert_eq!(
        decision("mcp__claude_ai_spotify__start_playback", json!({}), &policy),
        ToolDecision::Hold
    );
    assert_eq!(
        decision(
            "mcp__claude_ai_spotify__devices",
            json!({}),
            &allows(
                &["mcp__claude_ai_Spotify*__devices"],
                &["mcp__claude_ai_spotify*__DEVICES"]
            )
        ),
        ToolDecision::Hold
    );
    // Anything else is still refused.
    assert!(matches!(
        decision("mcp__claude_ai_spotifx__devices", json!({}), &policy),
        ToolDecision::Deny(_)
    ));
    assert!(matches!(
        decision("mcp__claude_ai_gmail__search_threads", json!({}), &policy),
        ToolDecision::Deny(_)
    ));
}

#[test]
fn a_tool_to_confirm_is_held_never_run_as_asked() {
    assert_eq!(
        decision(SEND, json!({"jid": "a", "text": "hi"}), &policy()),
        ToolDecision::Hold
    );
}

#[test]
fn a_writing_tool_is_held_even_when_a_pattern_allows_it() {
    let policy = allows(&["mcp__claude_ai_WhatsApp__*"], &[]);
    assert_eq!(
        decision(SEND, json!({"text": "hi"}), &policy),
        ToolDecision::Hold
    );
    assert_eq!(decision(LIST, json!({}), &policy), ToolDecision::Allow);
    // Unlisted writing tools are refused, not held.
    assert!(matches!(
        decision("mcp__claude_ai_Gmail__send_message", json!({}), &policy),
        ToolDecision::Deny(_)
    ));
}

#[test]
fn a_confirmed_call_runs_once_with_its_exact_input_only() {
    let policy = policy();
    let approved = Approved {
        held: HeldCall {
            tool: SEND.into(),
            input: json!({"jid": "33600@s.whatsapp.net", "text": "J'arrive"}),
        },
        used: false,
    };
    let with = |tool: &str, input: Value, policy: &CompanionMcpConfig, approved: &Approved| {
        tool_decision(tool, &input, policy, Some(approved))
    };
    // Same input, keys in another order, nulls dropped.
    assert_eq!(
        with(
            SEND,
            json!({"text": "J'arrive", "jid": "33600@s.whatsapp.net", "quoted": null}),
            &policy,
            &approved
        ),
        ToolDecision::Allow
    );
    assert!(matches!(
        with(
            SEND,
            json!({"jid": "33600@s.whatsapp.net", "text": "J'arrive !"}),
            &policy,
            &approved
        ),
        ToolDecision::Deny(_)
    ));
    assert!(matches!(
        with(
            SEND,
            json!({"jid": "other", "text": "J'arrive"}),
            &policy,
            &approved
        ),
        ToolDecision::Deny(_)
    ));
    let mut more = policy.clone();
    more.confirm
        .as_mut()
        .unwrap()
        .push("mcp__claude_ai_WhatsApp__send_media".into());
    assert!(matches!(
        with(
            "mcp__claude_ai_WhatsApp__send_media",
            approved.held.input.clone(),
            &more,
            &approved
        ),
        ToolDecision::Deny(_)
    ));
    let used = Approved {
        used: true,
        ..approved.clone()
    };
    assert!(matches!(
        with(SEND, approved.held.input.clone(), &policy, &used),
        ToolDecision::Deny(_)
    ));
}

#[test]
fn canonical_json_ignores_key_order_and_nulls() {
    assert_eq!(
        canonical_json(&json!({"b": 1, "a": {"d": null, "c": [1, {"y": 2, "x": 1}]}})),
        canonical_json(&json!({"a": {"c": [1, {"x": 1, "y": 2}]}, "b": 1}))
    );
}

#[test]
fn p_confirms() {
    for said in [
        "oui",
        "Oui, envoie-le",
        "vas-y",
        "ok",
        "yes, send it",
        "d'accord",
    ] {
        assert!(says_yes(said), "{said}");
    }
}

#[test]
fn p_does_not() {
    for said in [
        "non",
        "oui mais non",
        "attends",
        "no, don't send it",
        "c'est quoi ce message ?",
        "",
        "ok ok ok ok ok ok ok ok ok ok ok ok ok",
    ] {
        assert!(!says_yes(said), "{said}");
    }
}

fn after<'a>(args: &'a [String], flag: &str) -> &'a str {
    let at = args.iter().position(|a| a == flag).unwrap();
    &args[at + 1]
}

#[test]
fn only_toolsearch_built_in_no_hooks_every_call_asked_of_roamgate() {
    let args = tool_args("sonnet", "claude", &policy(), None, None);
    assert_eq!(after(&args, "--tools"), "ToolSearch");
    assert_eq!(after(&args, "--permission-mode"), "default");
    assert_eq!(after(&args, "--permission-prompts"), "host");
    assert_eq!(after(&args, "--permission-prompt-tool"), "stdio");
    let settings: Value = serde_json::from_str(after(&args, "--settings")).unwrap();
    assert_eq!(settings["disableAllHooks"], json!(true));
    assert_eq!(
        settings["permissions"]["ask"],
        json!([
            "mcp__spotify",
            "mcp__claude_ai_Youtube",
            "mcp__claude_ai_WhatsApp"
        ])
    );
    // Never the user's own permission mode, never bypassed.
    assert!(!args.contains(&"--dangerously-skip-permissions".to_owned()));
    assert!(!args.contains(&"--allowedTools".to_owned()));
}

#[test]
fn ask_rules_name_whole_servers() {
    assert_eq!(
        ask_rules(&allows(
            &["mcp__a__b*", "Bash", "mcp__c", "mcp__d*", "mcp__e*__pause"],
            &[]
        )),
        vec!["mcp__a", "mcp__c", "mcp__d"]
    );
}

/// A job process the test drives, answering its control requests.
pub(crate) struct Fake {
    written: Mutex<Vec<Value>>,
    to_read: Mutex<mpsc::UnboundedReceiver<String>>,
    tx: Mutex<Option<mpsc::UnboundedSender<String>>>,
    killed: AtomicBool,
    policy: CompanionMcpConfig,
    mcp_config: Option<String>,
    system: Option<String>,
}

impl Fake {
    fn new(
        policy: CompanionMcpConfig,
        mcp_config: Option<&str>,
        system: Option<&str>,
    ) -> (Arc<Self>, ClaudeProcess) {
        let (input, to_read) = mpsc::unbounded_channel();
        let (tx, lines) = mpsc::unbounded_channel();
        let fake = Arc::new(Self {
            written: Mutex::default(),
            to_read: Mutex::new(to_read),
            tx: Mutex::new(Some(tx)),
            killed: AtomicBool::new(false),
            policy,
            mcp_config: mcp_config.map(str::to_owned),
            system: system.map(str::to_owned),
        });
        let killed = fake.clone();
        let process = ClaudeProcess::from_parts(input, lines, move || {
            killed.killed.store(true, Ordering::SeqCst);
            killed.end();
        });
        (fake, process)
    }

    fn written(&self) -> Vec<Value> {
        let mut written = self.written.lock().unwrap();
        while let Ok(line) = self.to_read.lock().unwrap().try_recv() {
            written.push(serde_json::from_str(&line).unwrap());
        }
        written.clone()
    }

    pub(crate) fn push(&self, line: Value) {
        if let Some(tx) = self.tx.lock().unwrap().as_ref() {
            let _ = tx.send(line.to_string());
        }
    }

    fn end(&self) {
        self.tx.lock().unwrap().take();
    }

    fn killed(&self) -> bool {
        self.killed.load(Ordering::SeqCst)
    }

    /// The answer it was given to control request `id`.
    fn answer(&self, id: &str) -> Option<Value> {
        self.written()
            .into_iter()
            .find(|each| {
                each["type"] == json!("control_response")
                    && each["response"]["request_id"] == json!(id)
            })
            .map(|each| each["response"]["response"].clone())
    }

    fn behavior(&self, id: &str) -> Option<String> {
        self.answer(id)
            .and_then(|a| a["behavior"].as_str().map(str::to_owned))
    }

    /// The request it was given.
    fn prompt(&self) -> String {
        self.written()
            .into_iter()
            .find(|each| each["type"] == json!("user"))
            .and_then(|each| each["message"]["content"].as_str().map(str::to_owned))
            .unwrap()
    }
}

pub(crate) type Spawned = Arc<Mutex<Vec<Arc<Fake>>>>;

pub(crate) fn nth(spawned: &Spawned, n: usize) -> Arc<Fake> {
    spawned.lock().unwrap()[n].clone()
}

pub(crate) fn count(spawned: &Spawned) -> usize {
    spawned.lock().unwrap().len()
}

pub(crate) async fn settle() {
    for _ in 0..30 {
        tokio::task::yield_now().await;
    }
}

pub(crate) fn asks(id: &str, tool: &str, input: Value) -> Value {
    json!({"type": "control_request", "request_id": id, "request": {"subtype": "can_use_tool", "tool_name": tool, "input": input}})
}

pub(crate) fn result(spoken: &str) -> Value {
    json!({"type": "result", "result": js::stringify(&json!({"spoken": spoken, "answer": spoken, "sources": []}))})
}

fn clock_at(date: &str) -> Arc<TestClock> {
    Arc::new(TestClock::new(js::date_parse(date) as i64))
}

fn spawning(spawned: &Spawned, policy: CompanionMcpConfig) -> SpawnTools {
    let spawned = spawned.clone();
    Arc::new(move |mcp_config, system| {
        let (fake, process) = Fake::new(policy.clone(), mcp_config, system);
        spawned.lock().unwrap().push(fake);
        Ok(process)
    })
}

fn timing(held: i64) -> ToolsTiming {
    ToolsTiming {
        limit: 60_000,
        kept: 60_000,
        held,
    }
}

fn tools_with(policy: CompanionMcpConfig, options: ToolsOptions) -> (VoiceTools, Spawned) {
    let spawned: Spawned = Arc::default();
    let kept = policy.clone();
    let tools = VoiceTools::new(
        spawning(&spawned, policy),
        Arc::new(move || kept.clone()),
        options,
    );
    (tools, spawned)
}

fn tools_held(held: i64) -> (VoiceTools, Spawned) {
    tools_with(
        policy(),
        ToolsOptions {
            timing: timing(held),
            clock: clock_at("2026-11-05T09:30:00Z"),
            ..ToolsOptions::default()
        },
    )
}

/// Jobs on the test policy, held calls kept a minute.
pub(crate) fn tools() -> (VoiceTools, Spawned) {
    tools_held(60_000)
}

pub(crate) fn message() -> Value {
    json!({"jid": "33600@s.whatsapp.net", "text": "J'arrive dans dix minutes"})
}

#[tokio::test]
async fn an_allowed_call_runs_and_the_result_is_told() {
    let (using, spawned) = tools();
    let job = using.start("Mets la musique en pause", false).unwrap();
    assert_eq!(job.status, ResearchStatus::Searching);
    let process = nth(&spawned, 0);
    assert!(
        process
            .prompt()
            .contains("Request: Mets la musique en pause")
    );
    process.push(asks("r1", "mcp__spotify__pause", json!({})));
    settle().await;
    assert_eq!(
        process.answer("r1"),
        Some(json!({"behavior": "allow", "updatedInput": {}}))
    );
    process.push(result("C'est en pause."));
    settle().await;
    let done = using.state(&job.id).unwrap();
    assert_eq!(done.status, ResearchStatus::Done);
    assert_eq!(done.spoken.as_deref(), Some("C'est en pause."));
    assert_eq!(done.steps, vec!["Using spotify pause"]);
    assert_eq!(done.held, None);
    assert!(process.killed());
}

#[tokio::test]
async fn a_refused_call_is_reported_refused() {
    let (using, spawned) = tools();
    using.start("Lis mes mails", false);
    nth(&spawned, 0).push(asks(
        "r1",
        "mcp__claude_ai_Gmail__search_threads",
        json!({}),
    ));
    settle().await;
    assert_eq!(nth(&spawned, 0).behavior("r1").as_deref(), Some("deny"));
}

#[tokio::test]
async fn a_send_is_held_confirmed_by_a_yes_and_made_once_with_its_exact_input() {
    let (using, spawned) = tools();
    let job = using
        .start("Dis à Marie que j'arrive dans dix minutes", false)
        .unwrap();
    let first = nth(&spawned, 0);
    first.push(asks("r1", LIST, json!({})));
    first.push(asks("r2", SEND, message()));
    settle().await;
    assert_eq!(first.behavior("r1").as_deref(), Some("allow"));
    assert_eq!(
        first.answer("r2"),
        Some(json!({"behavior": "deny", "message": HELD_MESSAGE}))
    );
    // A second held call in the same job is refused outright.
    let mut other = message();
    other["text"] = json!("autre");
    first.push(asks("r3", SEND, other));
    settle().await;
    assert_eq!(first.behavior("r3").as_deref(), Some("deny"));
    first.push(result(
        "J'envoie à Marie : « J'arrive dans dix minutes ». Je confirme ?",
    ));
    settle().await;
    let held = using.state(&job.id).unwrap();
    assert_eq!(
        held.held,
        Some(HeldCall {
            tool: SEND.into(),
            input: message()
        })
    );
    assert!(held.answer.unwrap().contains("Waiting for your OK"));
    assert_eq!(using.held_job(None).map(|j| j.id), Some(job.id.clone()));

    // Not a yes: nothing runs.
    assert_eq!(using.confirm("c'est à qui ?", Some(&job.id)), None);
    assert_eq!(count(&spawned), 1);

    let making = using.confirm("oui vas-y", Some(&job.id)).unwrap();
    assert_eq!(making.confirms.as_deref(), Some(job.id.as_str()));
    assert_eq!(using.held_job(None), None);
    // Once only: a second yes finds nothing held.
    assert_eq!(using.confirm("oui", None), None);
    let second = nth(&spawned, 1);
    assert_eq!(
        second.prompt(),
        confirmed_prompt(
            &HeldCall {
                tool: SEND.into(),
                input: message()
            },
            js::date_parse("2026-11-05T09:30:00Z")
        )
    );
    // Another text is refused, the exact one runs, and only once.
    let mut changed = message();
    changed["text"] = json!("J'arrive");
    second.push(asks("c1", SEND, changed));
    second.push(asks(
        "c2",
        SEND,
        json!({"text": message()["text"], "jid": message()["jid"]}),
    ));
    second.push(asks("c3", SEND, message()));
    settle().await;
    assert_eq!(second.behavior("c1").as_deref(), Some("deny"));
    assert_eq!(second.behavior("c2").as_deref(), Some("allow"));
    assert_eq!(second.behavior("c3").as_deref(), Some("deny"));
}

/// A job holding a send, its read-back done.
pub(crate) async fn holding() -> (VoiceTools, Spawned, ToolJob) {
    let (using, spawned) = tools();
    let job = using.start("Envoie un message à Marie", false).unwrap();
    nth(&spawned, 0).push(asks("r1", SEND, message()));
    nth(&spawned, 0).push(result("J'envoie à Marie : « J'arrive ». Je confirme ?"));
    settle().await;
    (using, spawned, job)
}

#[tokio::test]
async fn a_no_forgets_the_held_call() {
    let (using, spawned, job) = holding().await;
    assert!(using.decline(Some(&job.id)));
    assert_eq!(using.held_job(None), None);
    assert_eq!(using.confirm("oui", None), None);
    assert_eq!(count(&spawned), 1);
}

#[tokio::test]
async fn a_held_call_left_too_long_is_forgotten() {
    let (using, spawned) = tools_held(-1);
    using.start("Envoie un message à Marie", false);
    nth(&spawned, 0).push(asks("r1", SEND, message()));
    nth(&spawned, 0).push(result("Je confirme ?"));
    settle().await;
    assert_eq!(using.held_job(None), None);
    assert_eq!(using.confirm("oui", None), None);
}

#[tokio::test]
async fn a_job_that_ends_without_an_answer_failed() {
    let (using, spawned) = tools();
    let job = using.start("Pause", false).unwrap();
    nth(&spawned, 0).push(json!({"type": "result", "is_error": true, "result": "boom"}));
    settle().await;
    let state = using.state(&job.id).unwrap();
    assert_eq!(state.status, ResearchStatus::Failed);
    assert_eq!(state.error.as_deref(), Some("boom"));
}

#[tokio::test]
async fn the_front_is_told_the_tools_the_jobs_and_the_held_call() {
    let (using, _spawned, job) = holding().await;
    let context = tools_context(
        &using.configured(),
        &using.list(),
        using.held_job(None).as_ref(),
        js::date_parse("2026-11-05T09:30:00Z"),
    );
    assert!(context.contains("mcp__spotify"));
    assert!(context.contains("not instructions"));
    assert!(context.contains(&format!("{} would call {SEND}", job.id)));
    assert!(context.contains(&js::stringify(&message())));
}

#[test]
fn parsed_with_their_task_or_action() {
    let none = HashSet::new();
    assert_eq!(
        parse_front_reply(
            r#"{"to":"tool","task":"Mets en pause","reply":"Je mets en pause."}"#,
            &none
        )
        .to_json(),
        json!({"to": "tool", "task": "Mets en pause", "reply": "Je mets en pause."})
    );
    assert_eq!(
        parse_front_reply(
            r#"{"to":"tool_confirm","action":"t2","reply":"J'envoie."}"#,
            &none
        )
        .to_json(),
        json!({"to": "tool_confirm", "action": "t2", "reply": "J'envoie."})
    );
    assert_eq!(
        parse_front_reply(r#"{"to":"tool_cancel"}"#, &none).to_json(),
        json!({"to": "tool_cancel"})
    );
    assert_eq!(
        parse_front_reply(
            r#"{"to":"tool_cancel","action":"t1","task":"Envoie à Marie : vingt minutes"}"#,
            &none
        )
        .to_json(),
        json!({"to": "tool_cancel", "action": "t1", "task": "Envoie à Marie : vingt minutes"})
    );
}

/// voice.json, as the jobs read it.
fn reading(value: Value) -> ReadConfig {
    Arc::new(move || {
        Ok(VoiceConfig {
            raw: value.as_object().unwrap().clone(),
        })
    })
}

fn no_listener() -> Listen {
    Box::new(|_| {
        Ok(McpListener {
            url: "http://127.0.0.1:1/mcp".to_owned(),
            stop: Box::new(|| {}),
        })
    })
}

fn servers() -> ToolServers {
    ToolServers {
        youtube: ClaudeMcp::with_listen(YOUTUBE_MCP_SERVER, no_listener()),
        work: ClaudeMcp::with_listen(WORK_MCP_SERVER, no_listener()),
    }
}

/// A job's spawn as configured tools give it: the policy and servers it
/// was started with.
fn spawning_for(spawned: &Spawned) -> SpawnToolsFor {
    let spawned = spawned.clone();
    Arc::new(move |_model, _command, policy, mcp_config, system| {
        let (fake, process) = Fake::new(policy.clone(), mcp_config, system);
        spawned.lock().unwrap().push(fake);
        Ok(process)
    })
}

fn configured(config: Value, setup: ToolsSetup) -> (ConfiguredTools, Spawned) {
    let spawned: Spawned = Arc::default();
    let tools = ConfiguredTools::new(
        reading(config),
        Arc::new(|_| ClaudeCommand::default()),
        spawning_for(&spawned),
        ToolsSetup {
            servers: Some(setup.servers.clone().unwrap_or_else(servers)),
            clock: Some(clock_at("2026-11-05T09:30:00Z")),
            ..setup
        },
    );
    (tools, spawned)
}

#[test]
fn only_with_a_front_and_companion_mcp() {
    let none = ToolsSetup::default;
    assert!(
        configured(json!({"helper": "h", "front_model": "opus"}), none())
            .0
            .get()
            .is_none()
    );
    assert!(
        configured(
            json!({"helper": "h", "front_model": "opus", "companion_mcp": policy_json()}),
            none()
        )
        .0
        .get()
        .is_some()
    );
    assert!(
        configured(
            json!({"helper": "h", "companion_mcp": policy_json()}),
            none()
        )
        .0
        .get()
        .is_none()
    );
}

/// The request the job started for "Mets du Miles Davis" was given.
async fn request(device: Option<&str>, on_call: bool, full_volume: Option<bool>) -> String {
    let mut config = json!({"helper": "h", "front_model": "opus", "companion_mcp": policy_json()});
    if let Some(device) = device {
        config["call_music_device"] = json!(device);
    }
    if let Some(full) = full_volume {
        config["call_music_full_volume"] = json!(full);
    }
    let (tools, spawned) = configured(config, ToolsSetup::default());
    tools.get().unwrap().start("Mets du Miles Davis", on_call);
    nth(&spawned, 0).prompt()
}

#[tokio::test]
async fn music_asked_on_a_call_plays_on_call_music_device() {
    let asked = request(Some("amd-desktop"), true, None).await;
    assert!(asked.contains("Request: Mets du Miles Davis"));
    assert!(asked.contains(r#"Spotify Connect device "amd-desktop""#));
}

#[tokio::test]
async fn music_on_call_music_device_is_set_to_full_volume_and_why() {
    let asked = request(Some("amd-desktop"), true, None).await;
    assert!(asked.contains("set that device's volume to 100: the call sets the music's level"));
    assert!(
        request(Some("amd-desktop"), true, Some(true))
            .await
            .contains("volume to 100")
    );
}

#[tokio::test]
async fn call_music_full_volume_false_leaves_the_devices_volume() {
    let asked = request(Some("amd-desktop"), true, Some(false)).await;
    assert!(asked.contains(r#"Spotify Connect device "amd-desktop""#));
    assert!(!asked.contains("volume to 100"));
    assert!(
        !request(Some("amd-desktop"), false, None)
            .await
            .contains("volume to 100")
    );
}

#[tokio::test]
async fn off_a_call_or_without_a_device_the_default_device_stays() {
    assert!(
        !request(Some("amd-desktop"), false, None)
            .await
            .contains("Spotify Connect")
    );
    assert!(!request(None, true, None).await.contains("Spotify Connect"));
    assert!(
        !request(Some("  "), true, None)
            .await
            .contains("Spotify Connect")
    );
}

#[tokio::test]
async fn makes_that_call_once_with_no_words_to_check() {
    let (using, spawned, job) = holding().await;
    let making = using.approve(Some(&job.id)).unwrap();
    assert_eq!(making.confirms.as_deref(), Some(job.id.as_str()));
    assert_eq!(
        using.state(&job.id).unwrap().held_outcome,
        Some(HeldOutcome::Confirmed)
    );
    assert_eq!(count(&spawned), 2);
    // Once: nothing is held any more.
    assert_eq!(using.approve(Some(&job.id)), None);
    assert_eq!(using.confirm("oui", Some(&job.id)), None);
    assert_eq!(count(&spawned), 2);
}

fn playing() -> YoutubeStatus {
    YoutubeStatus {
        state: "playing".into(),
        position: Some(3.0),
        duration: Some(242.0),
        volume: 100.0,
        track: Some((
            "Around the World".into(),
            "https://www.youtube.com/watch?v=K0HSD_i2DvA".into(),
            Some("Daft Punk".into()),
        )),
        ended: None,
        spotify_paused: true,
        music_off: false,
    }
}

type Play = Arc<dyn Fn() -> Result<YoutubeStatus, YoutubeError> + Send + Sync>;

/// A player recording what it is asked.
struct FakeYoutube {
    calls: Mutex<Vec<String>>,
    play: Option<Play>,
}

impl FakeYoutube {
    fn new(play: Option<Play>) -> Arc<Self> {
        Arc::new(Self {
            calls: Mutex::default(),
            play,
        })
    }

    fn calls(&self) -> Vec<String> {
        self.calls.lock().unwrap().clone()
    }

    fn answer(&self, call: String) -> BoxFuture<'_, Result<YoutubeStatus, YoutubeError>> {
        self.calls.lock().unwrap().push(call);
        async { Ok(playing()) }.boxed()
    }
}

impl YoutubeControls for FakeYoutube {
    fn play(&self, query: String) -> BoxFuture<'_, Result<YoutubeStatus, YoutubeError>> {
        self.calls.lock().unwrap().push(format!("play {query}"));
        let done = self
            .play
            .as_ref()
            .map_or_else(|| Ok(playing()), |play| play());
        async move { done }.boxed()
    }

    fn pause(&self) -> BoxFuture<'_, Result<YoutubeStatus, YoutubeError>> {
        self.answer("pause".into())
    }

    fn resume(&self) -> BoxFuture<'_, Result<YoutubeStatus, YoutubeError>> {
        self.answer("resume".into())
    }

    fn stop(&self) -> BoxFuture<'_, Result<YoutubeStatus, YoutubeError>> {
        self.answer("stop".into())
    }

    fn volume(&self, percent: f64) -> BoxFuture<'_, Result<YoutubeStatus, YoutubeError>> {
        self.answer(format!("volume {}", js::number_text(percent)))
    }

    fn seek(
        &self,
        position: Option<f64>,
        by: Option<f64>,
    ) -> BoxFuture<'_, Result<YoutubeStatus, YoutubeError>> {
        let mut asked = Map::new();
        if let Some(position) = position {
            asked.insert("position".into(), js::number(position));
        }
        if let Some(by) = by {
            asked.insert("by".into(), js::number(by));
        }
        self.answer(format!("seek {}", js::stringify(&Value::Object(asked))))
    }

    fn now_playing(&self) -> BoxFuture<'_, Result<YoutubeStatus, YoutubeError>> {
        self.answer("nowPlaying".into())
    }

    fn spotify_started(&self) -> BoxFuture<'_, ()> {
        self.calls.lock().unwrap().push("spotifyStarted".into());
        async {}.boxed()
    }
}

fn music(extra: Value) -> Value {
    let mut config = json!({
        "helper": "h",
        "front_model": "opus",
        "companion_mcp": policy_json(),
        "call_background": "pulsesrc device=roamgate-music.monitor ! audioconvert",
    });
    for (key, value) in extra.as_object().unwrap() {
        if value.is_null() {
            config.as_object_mut().unwrap().remove(key);
        } else {
            config[key] = value.clone();
        }
    }
    config
}

/// A JSON-RPC call to a job's server: its answer, or the status when it
/// is not 200.
async fn rpc(server: &ClaudeMcp, mcp_config: &str, body: Value) -> Value {
    let config: Value = serde_json::from_str(mcp_config).unwrap();
    let auth = config["mcpServers"][server.name()]["headers"]["Authorization"]
        .as_str()
        .unwrap()
        .to_owned();
    let mut message = json!({"jsonrpc": "2.0", "id": 1});
    for (key, value) in body.as_object().unwrap() {
        message[key] = value.clone();
    }
    let response = server.handle(McpRequest::post(Some(&auth), &message)).await;
    if response.status == 200 {
        response.body_json().unwrap()
    } else {
        json!(response.status)
    }
}

fn call(name: &str, arguments: Value) -> Value {
    json!({"method": "tools/call", "params": {"name": name, "arguments": arguments}})
}

#[tokio::test]
async fn a_job_gets_the_players_tools_allowed_and_when_to_use_them() {
    let player = FakeYoutube::new(None);
    let servers = servers();
    let (tools, spawned) = configured(
        music(json!({})),
        ToolsSetup {
            youtube: Some(YoutubeSource::Player(player.clone())),
            servers: Some(servers.clone()),
            ..ToolsSetup::default()
        },
    );
    let using = tools.get().unwrap();
    using.start("Mets Around the World de Daft Punk sur YouTube", true);
    let process = nth(&spawned, 0);
    assert!(ask_rules(&process.policy).contains(&"mcp__roamgate_youtube".to_owned()));
    assert_eq!(
        decision(
            "mcp__roamgate_youtube__play",
            json!({"query": "x"}),
            &process.policy
        ),
        ToolDecision::Allow
    );
    assert!(tools_context(&using.configured(), &[], None, 0.0).contains("mcp__roamgate_youtube"));
    assert!(process.prompt().contains(YOUTUBE_PROMPT));
    assert!(YOUTUBE_PROMPT.contains("says YouTube"));
    assert!(YOUTUBE_PROMPT.contains("Spotify does not have"));

    let mcp_config = process.mcp_config.clone().unwrap();
    let listed = rpc(
        &servers.youtube,
        &mcp_config,
        json!({"method": "tools/list"}),
    )
    .await;
    let names: Vec<&str> = listed["result"]["tools"]
        .as_array()
        .unwrap()
        .iter()
        .map(|t| t["name"].as_str().unwrap())
        .collect();
    assert_eq!(
        names,
        [
            "play",
            "pause",
            "resume",
            "stop",
            "volume",
            "seek",
            "now_playing"
        ]
    );
    let played = rpc(
        &servers.youtube,
        &mcp_config,
        call("play", json!({"query": "around the world"})),
    )
    .await;
    assert_eq!(player.calls(), vec!["play around the world"]);
    assert_eq!(played["result"].get("isError"), None);
    let text = played["result"]["content"][0]["text"].as_str().unwrap();
    assert!(text.contains(r#"Playing on YouTube: "Around the World" (Daft Punk), 0:03 of 4:02"#));
    assert!(text.contains("Spotify was paused"));
    rpc(
        &servers.youtube,
        &mcp_config,
        call("seek", json!({"by": 30})),
    )
    .await;
    assert_eq!(player.calls().last().unwrap(), r#"seek {"by":30}"#);

    // The job's server ends with the job.
    process.push(result("C'est parti sur YouTube."));
    settle().await;
    assert_eq!(
        rpc(
            &servers.youtube,
            &mcp_config,
            json!({"method": "tools/list"})
        )
        .await,
        json!(401)
    );
}

#[tokio::test]
async fn a_video_that_cannot_play_is_told_with_its_reason() {
    let player = FakeYoutube::new(Some(Arc::new(|| {
        Err(YoutubeError("Video unavailable".into()))
    })));
    let servers = servers();
    let (tools, spawned) = configured(
        music(json!({})),
        ToolsSetup {
            youtube: Some(YoutubeSource::Player(player)),
            servers: Some(servers.clone()),
            ..ToolsSetup::default()
        },
    );
    tools
        .get()
        .unwrap()
        .start("Mets la vidéo sur YouTube", false);
    let failed = rpc(
        &servers.youtube,
        nth(&spawned, 0).mcp_config.as_deref().unwrap(),
        call("play", json!({"query": "x"})),
    )
    .await;
    assert_eq!(failed["result"]["isError"], json!(true));
    assert_eq!(
        failed["result"]["content"][0]["text"],
        json!("The video could not be played: Video unavailable")
    );
}

type HelperAnswer =
    Arc<dyn Fn(&Map<String, Value>) -> Result<Map<String, Value>, String> + Send + Sync>;

/// The voice helper as the player sees it: what it was sent.
struct FakeHelper {
    sent: Mutex<Vec<Value>>,
    answer: HelperAnswer,
}

impl YoutubeHelper for FakeHelper {
    fn in_call(&self) -> bool {
        true
    }

    fn call_youtube(
        &self,
        command: Map<String, Value>,
        music_on: bool,
    ) -> BoxFuture<'_, Result<Map<String, Value>, String>> {
        let mut sent = command.clone();
        if music_on {
            sent.insert("musicOn".into(), json!(true));
        }
        self.sent.lock().unwrap().push(Value::Object(sent));
        let answer = (self.answer)(&command);
        async move { answer }.boxed()
    }

    fn on_youtube(&self, _listener: EventSink) {}
}

#[tokio::test]
async fn the_tools_play_in_the_helpers_call_the_video_found_by_yt_dlp() {
    let video = json!({
        "title": "Around the World",
        "webpage_url": "https://www.youtube.com/watch?v=K0HSD_i2DvA",
        "channel": "Daft Punk",
        "duration": 242,
        "url": "https://rr3.googlevideo.com/videoplayback?x=1",
        "ext": "webm",
        "acodec": "opus",
        "http_headers": {"User-Agent": "UA"},
    });
    let helper = Arc::new(FakeHelper {
        sent: Mutex::default(),
        answer: Arc::new(|_| {
            Ok(json!({"state": "playing", "position": 1, "duration": 242})
                .as_object()
                .unwrap()
                .clone())
        }),
    });
    // yt-dlp's JSON, from a stand-in that keeps what it was run with.
    let ran: Arc<Mutex<Vec<Vec<String>>>> = Arc::default();
    let runs = ran.clone();
    let stdout = format!("{video}\n");
    let run: RunCommand = Arc::new(move |args, _timeout| {
        runs.lock().unwrap().push(args);
        let stdout = stdout.clone();
        async move {
            Ok(Ran {
                code: Some(0),
                stdout,
                stderr: String::new(),
            })
        }
        .boxed()
    });
    let servers = servers();
    let (tools, spawned) = configured(
        music(json!({"yt_dlp": ["my-yt-dlp", "--flag"]})),
        ToolsSetup {
            youtube: Some(YoutubeSource::Helper(helper.clone(), run)),
            servers: Some(servers.clone()),
            ..ToolsSetup::default()
        },
    );
    tools
        .get()
        .unwrap()
        .start("Mets Around the World sur YouTube", true);
    let mcp_config = nth(&spawned, 0).mcp_config.clone().unwrap();
    let played = rpc(
        &servers.youtube,
        &mcp_config,
        call("play", json!({"query": "around the world"})),
    )
    .await;
    assert!(
        played["result"]["content"][0]["text"]
            .as_str()
            .unwrap()
            .contains(r#"Playing on YouTube: "Around the World" (Daft Punk), 0:01 of 4:02"#)
    );
    assert_eq!(ran.lock().unwrap()[0][..2], ["my-yt-dlp", "--flag"]);
    assert_eq!(
        *helper.sent.lock().unwrap(),
        vec![
            json!({"action": "status"}),
            json!({
                "action": "play",
                "url": video["url"],
                "headers": {"User-Agent": "UA"},
                "volume": 1,
                "pause_mpris": SPOTIFY_MPRIS,
                "musicOn": true,
            }),
        ]
    );
    rpc(&servers.youtube, &mcp_config, call("pause", json!({}))).await;
    assert_eq!(
        helper.sent.lock().unwrap().last().unwrap(),
        &json!({"action": "pause"})
    );
}

#[tokio::test]
async fn an_older_voice_helper_says_youtube_needs_the_new_one() {
    let helper = Arc::new(FakeHelper {
        sent: Mutex::default(),
        answer: Arc::new(|_| Err("unknown op call_youtube".into())),
    });
    let servers = servers();
    let run: RunCommand = Arc::new(|_, _| async { Err("not run".to_owned()) }.boxed());
    let (tools, spawned) = configured(
        music(json!({})),
        ToolsSetup {
            youtube: Some(YoutubeSource::Helper(helper, run)),
            servers: Some(servers.clone()),
            ..ToolsSetup::default()
        },
    );
    tools
        .get()
        .unwrap()
        .start("Mets la vidéo sur YouTube", false);
    let failed = rpc(
        &servers.youtube,
        nth(&spawned, 0).mcp_config.as_deref().unwrap(),
        call("play", json!({"query": "x"})),
    )
    .await;
    assert_eq!(failed["result"]["isError"], json!(true));
    assert_eq!(
        failed["result"]["content"][0]["text"],
        json!(
            "The video could not be played: YouTube needs the new voice helper: the one installed cannot play it"
        )
    );
}

#[tokio::test]
async fn off_without_call_background_with_youtube_false_or_without_a_helper() {
    for (config, player) in [
        (json!({"call_background": null}), true),
        (json!({"youtube": false}), true),
        (json!({}), false),
    ] {
        let (tools, spawned) = configured(
            music(config),
            ToolsSetup {
                youtube: player.then(|| YoutubeSource::Player(FakeYoutube::new(None))),
                ..ToolsSetup::default()
            },
        );
        tools.get().unwrap().start("Mets du Daft Punk", true);
        let process = nth(&spawned, 0);
        assert_eq!(process.mcp_config, None);
        assert!(!ask_rules(&process.policy).contains(&"mcp__roamgate_youtube".to_owned()));
        assert!(!process.prompt().contains("roamgate_youtube"));
    }
}

/// A job's YouTube counting Spotify's starts and its servers' closes.
struct CountingYoutube {
    stopped: AtomicUsize,
    closed: Arc<AtomicUsize>,
}

impl JobYoutube for CountingYoutube {
    fn open(&self) -> io::Result<ServerLease> {
        let closed = self.closed.clone();
        Ok(ServerLease::new(r#"{"mcpServers":{}}"#.into(), move || {
            closed.fetch_add(1, Ordering::SeqCst);
        }))
    }

    fn spotify_started(&self) {
        self.stopped.fetch_add(1, Ordering::SeqCst);
    }
}

#[tokio::test]
async fn spotify_starting_on_the_calls_device_stops_youtube_anything_else_leaves_it() {
    let youtube = Arc::new(CountingYoutube {
        stopped: AtomicUsize::new(0),
        closed: Arc::default(),
    });
    let job_youtube = youtube.clone();
    let mut allow = policy().allow.unwrap();
    allow.push("mcp__claude_ai_Spotify*__play".into());
    let (using, spawned) = tools_with(
        CompanionMcpConfig {
            allow: Some(allow),
            confirm: None,
            model: None,
        },
        ToolsOptions {
            timing: timing(60_000),
            clock: clock_at("2026-11-05T09:30:00Z"),
            music_device: Arc::new(|| {
                Some(CallMusicDevice {
                    name: "amd-desktop".into(),
                    full_volume: true,
                })
            }),
            youtube: Arc::new(move || Some(job_youtube.clone() as Arc<dyn JobYoutube>)),
            ..ToolsOptions::default()
        },
    );
    let stopped = || youtube.stopped.load(Ordering::SeqCst);
    using.start("Remets Spotify", false);
    let process = nth(&spawned, 0);
    assert_eq!(process.mcp_config.as_deref(), Some(r#"{"mcpServers":{}}"#));
    process.push(asks("r1", "mcp__spotify__pause", json!({})));
    process.push(asks("r2", "mcp__claude_ai_Youtube__x", json!({})));
    settle().await;
    assert_eq!(stopped(), 0);
    // Someone else's phone on the same account, or no device named.
    process.push(asks(
        "r3",
        "mcp__spotify__play",
        json!({"query": "x", "device": "Simon's phone"}),
    ));
    process.push(asks("r3b", "mcp__spotify__resume", json!({})));
    settle().await;
    assert_eq!(stopped(), 0);
    process.push(asks(
        "r3c",
        "mcp__spotify__play",
        json!({"query": "x", "device": "amd-desktop"}),
    ));
    settle().await;
    assert_eq!(stopped(), 1);
    process.push(asks(
        "r4",
        "mcp__claude_ai_Spotify__play",
        json!({"device": "AMD-Desktop"}),
    ));
    process.push(asks(
        "r5",
        "mcp__spotify__resume",
        json!({"device": "amd-desktop"}),
    ));
    settle().await;
    assert_eq!(stopped(), 3);
    // A refused Spotify call starts nothing.
    process.push(asks(
        "r6",
        "mcp__claude_ai_Spotify__resume",
        json!({"device": "amd-desktop"}),
    ));
    settle().await;
    assert_eq!(process.behavior("r6").as_deref(), Some("deny"));
    assert_eq!(stopped(), 3);
    process.push(result("C'est reparti."));
    settle().await;
    assert_eq!(youtube.closed.load(Ordering::SeqCst), 1);
}

#[test]
fn which_calls_start_spotify_on_the_calls_music_device() {
    let here = json!({"device": "amd-desktop"});
    let device = Some("amd-desktop");
    assert!(starts_spotify("mcp__spotify__play", &here, device));
    assert!(starts_spotify(
        "mcp__claude_ai_Spotify__resume",
        &here,
        device
    ));
    assert!(starts_spotify("mcp__spotify__transfer", &here, device));
    assert!(starts_spotify(
        "mcp__spotify__play",
        &json!({"device_name": "AMD-desktop"}),
        device
    ));
    assert!(!starts_spotify("mcp__spotify__pause", &here, device));
    assert!(!starts_spotify("mcp__spotify__now_playing", &here, device));
    assert!(!starts_spotify(
        "mcp__roamgate_youtube__play",
        &here,
        device
    ));
    assert!(!starts_spotify("mcp__spotify", &here, device));
    // Another device, none named, no call device known, or not playing.
    assert!(!starts_spotify(
        "mcp__spotify__play",
        &json!({"device": "Simon's phone"}),
        device
    ));
    assert!(!starts_spotify("mcp__spotify__resume", &json!({}), device));
    assert!(!starts_spotify("mcp__spotify__play", &here, None));
    assert!(!starts_spotify(
        "mcp__spotify__transfer",
        &json!({"device": "amd-desktop", "play": false}),
        device
    ));
}

#[test]
fn roamgates_servers_go_to_the_jobs_claude_code() {
    let args = tool_args(
        "sonnet",
        "claude",
        &policy(),
        Some(r#"{"mcpServers":{}}"#),
        None,
    );
    assert_eq!(after(&args, "--mcp-config"), r#"{"mcpServers":{}}"#);
    assert!(!args.contains(&"--strict-mcp-config".to_owned()));
    assert!(
        !tool_args("sonnet", "claude", &policy(), None, None).contains(&"--mcp-config".to_owned())
    );
}

const SAVED: &str =
    r#"{"items":[{"name":"Liked","artists":["Band"],"uri":"spotify:track:liked"}]}"#;
const PLAYLISTS: &str = r#"{"items":[{"name":"Focus","owner":"Me","items":3,"uri":"spotify:playlist:focus"},{"name":"Run","owner":"Me","items":5,"uri":"spotify:playlist:run"}]}"#;

struct TasteKit {
    using: VoiceTools,
    spawned: Spawned,
    taste: VoiceTaste,
    _dir: tempfile::TempDir,
}

fn taste_tools() -> TasteKit {
    let dir = tempfile::tempdir().unwrap();
    let clock = clock_at("2026-11-21T09:30:00Z");
    let taste = VoiceTaste::with(dir.path().join("taste.json"), None, clock.clone());
    let kept = taste.clone();
    let (using, spawned) = tools_with(
        policy(),
        ToolsOptions {
            timing: timing(60_000),
            clock,
            taste: Arc::new(move || Some(kept.clone())),
            ..ToolsOptions::default()
        },
    );
    TasteKit {
        using,
        spawned,
        taste,
        _dir: dir,
    }
}

fn tool_use(id: &str, name: &str, input: Value) -> Value {
    json!({"type": "assistant", "message": {"content": [{"type": "tool_use", "id": id, "name": name, "input": input}]}})
}

fn tool_result(id: &str, text: &str, is_error: bool) -> Value {
    let mut part = json!({"type": "tool_result", "tool_use_id": id, "content": [{"type": "text", "text": text}]});
    if is_error {
        part["is_error"] = json!(true);
    }
    json!({"type": "user", "message": {"content": [part]}})
}

fn playlists_call() -> Vec<GatheredCall> {
    vec![GatheredCall {
        tool: "mcp__spotify__my_playlists".into(),
        input: json!({}),
        output: PLAYLISTS.into(),
        error: false,
    }]
}

#[tokio::test]
async fn the_taste_job_gathers_spotifys_answers_hidden_from_the_companion() {
    let kit = taste_tools();
    let calls = tokio::spawn(kit.using.gather());
    let process = nth(&kit.spawned, 0);
    assert!(
        process
            .system
            .as_deref()
            .unwrap()
            .contains("Spotify MCP tools")
    );
    assert!(process.prompt().contains("recently_played"));
    process.push(asks("c1", "mcp__spotify__top", json!({"kind": "artists"})));
    process.push(asks("c2", "mcp__spotify__saved", json!({"limit": 50})));
    process.push(asks(
        "c3",
        "mcp__spotify__my_playlists",
        json!({"limit": 50}),
    ));
    process.push(asks("c4", "mcp__spotify__play", json!({"query": "x"})));
    process.push(asks(
        "c5",
        "mcp__claude_ai_Youtube__search_videos",
        json!({}),
    ));
    settle().await;
    assert_eq!(process.behavior("c1").as_deref(), Some("allow"));
    assert_eq!(process.behavior("c2").as_deref(), Some("allow"));
    // Nothing but Spotify's read tools, even allowed ones.
    assert_eq!(process.behavior("c4").as_deref(), Some("deny"));
    assert_eq!(process.behavior("c5").as_deref(), Some("deny"));
    process.push(tool_use(
        "u1",
        "mcp__spotify__top",
        json!({"kind": "artists"}),
    ));
    process.push(tool_use("u2", "mcp__spotify__saved", json!({"limit": 50})));
    process.push(tool_use(
        "u3",
        "mcp__spotify__my_playlists",
        json!({"limit": 50}),
    ));
    process.push(tool_result(
        "u1",
        "403: insufficient scope, log in again",
        true,
    ));
    process.push(tool_result("u2", SAVED, false));
    process.push(tool_result("u3", PLAYLISTS, false));
    process.push(result("done"));
    let calls = calls.await.unwrap();
    assert_eq!(
        calls
            .iter()
            .map(|c| (c.tool.as_str(), c.error))
            .collect::<Vec<_>>(),
        vec![
            ("mcp__spotify__top", true),
            ("mcp__spotify__saved", false),
            ("mcp__spotify__my_playlists", false),
        ]
    );
    assert_eq!(calls[1].output, SAVED);
    assert!(kit.using.list().is_empty());
    assert!(process.killed());
}

#[tokio::test]
async fn a_refresh_folds_them_spotifys_403_leaves_a_partial_profile() {
    let kit = taste_tools();
    assert!(kit.using.refresh_taste());
    // One at a time.
    assert!(!kit.using.refresh_taste());
    let process = nth(&kit.spawned, 0);
    process.push(tool_use("u2", "mcp__spotify__saved", json!({"limit": 50})));
    process.push(tool_result("u2", SAVED, false));
    process.push(tool_use(
        "u1",
        "mcp__spotify__top",
        json!({"kind": "artists"}),
    ));
    process.push(tool_result("u1", "403 Forbidden: log in again", true));
    process.push(result("done"));
    settle().await;
    assert_eq!(kit.taste.profile().unwrap().liked[0].name, "Liked");
    assert!(kit.taste.read().needs_login);
    assert!(kit.using.taste_line().contains(r#""Liked""#));
}

#[tokio::test]
async fn never_refreshed_while_a_request_runs() {
    let kit = taste_tools();
    kit.using.start("mets de la musique", false);
    assert!(!kit.using.refresh_taste());
    assert_eq!(count(&kit.spawned), 1);
}

#[tokio::test]
async fn a_music_request_gets_the_taste_block_others_and_no_profile_do_not() {
    let kit = taste_tools();
    kit.using.start("mets de la musique", false);
    // No profile yet: as today.
    assert!(!nth(&kit.spawned, 0).prompt().contains("Taste:"));
    nth(&kit.spawned, 0).end();
    kit.taste
        .refresh(|| async { Ok(playlists_call()) }.boxed())
        .await;
    settle().await;
    kit.using.start("mets de la musique calme", false);
    let prompt = nth(&kit.spawned, 1).prompt();
    assert!(prompt.contains("Taste: when the request is open"));
    assert!(prompt.contains(r#""Focus" spotify:playlist:focus"#));
    kit.using.start("qu'a écrit Marie ?", false);
    assert!(!nth(&kit.spawned, 2).prompt().contains("Taste:"));
}

#[tokio::test]
async fn what_an_open_request_plays_is_a_pick_turning_it_down_avoids_it() {
    let kit = taste_tools();
    kit.taste
        .refresh(|| async { Ok(playlists_call()) }.boxed())
        .await;
    kit.using.start("mets un truc pour bosser", false);
    let process = nth(&kit.spawned, 0);
    process.push(asks(
        "r1",
        "mcp__spotify__play",
        json!({"uri": "spotify:playlist:focus"}),
    ));
    settle().await;
    process.push(result("Ta playlist Focus."));
    settle().await;
    let picks = kit.taste.read().picks;
    assert_eq!(picks.len(), 1);
    assert_eq!(picks[0].what, "spotify:playlist:focus");
    assert_eq!(picks[0].label.as_deref(), Some("Ta playlist Focus."));
    kit.using.start("non, pas ça, autre chose", false);
    let prompt = nth(&kit.spawned, 1).prompt();
    assert!(prompt.contains("The user just turned down"));
    assert!(prompt.contains(
        r#"Never pick (the user turned these down): "Ta playlist Focus. (spotify:playlist:focus)""#
    ));
    assert_eq!(kit.taste.avoid_list().len(), 1);
}

#[test]
fn a_pick_is_a_plays_uri_or_words_spotifys_or_youtubes() {
    assert_eq!(
        pick_of("mcp__spotify__play", &json!({"uri": "spotify:album:x"})).as_deref(),
        Some("spotify:album:x")
    );
    assert_eq!(
        pick_of(
            "mcp__claude_ai_spotify__play",
            &json!({"query": "Nils Frahm"})
        )
        .as_deref(),
        Some("Nils Frahm")
    );
    assert_eq!(
        pick_of("mcp__roamgate_youtube__play", &json!({"query": "lofi"})).as_deref(),
        Some("lofi")
    );
    assert_eq!(pick_of("mcp__spotify__pause", &json!({})), None);
    assert_eq!(
        pick_of("mcp__claude_ai_Youtube__play", &json!({"query": "x"})),
        None
    );
}

#[test]
fn the_block_goes_after_the_request() {
    let prompt = tool_prompt("mets de la musique", 0.0, None, false, "Taste: x", false);
    assert!(prompt.ends_with("\n\nTaste: x"));
    assert!(!tool_prompt("mets de la musique", 0.0, None, false, "", false).contains("Taste:"));
}

/// A Work board in memory.
pub(crate) fn work_board() -> WorkService {
    WorkService::new(
        WorkStore::open(
            &std::env::temp_dir().join("roamgate-voice-work-in-memory"),
            StoreWrites::Memory,
            Arc::new(NoHistory),
            Arc::new(|| "2026-11-21T10:00:00.000Z".into()),
        ),
        Arc::new(NoDeps),
        Arc::new(TestClock::new(js::date_parse("2026-11-21T10:00:00Z") as i64)),
    )
}

struct NoDeps;

impl roamgate_work::service::WorkDeps for NoDeps {}

#[tokio::test]
async fn a_job_reads_the_board_freely_and_every_write_waits_for_the_users_yes() {
    let service = work_board();
    service
        .add(
            json!({
                "title": "Pick the car audio",
                "state": "you",
                "ask": "Choose: media or no music",
                "answers": ["Media", "No music"],
            })
            .as_object()
            .unwrap(),
            &WorkMeta::user(),
        )
        .await
        .unwrap();
    let servers = servers();
    let board = service.clone();
    let (tools, spawned) = configured(
        json!({"helper": "h", "front_model": "opus", "companion_mcp": policy_json()}),
        ToolsSetup {
            work: Some(Arc::new(move || {
                Arc::new(board.clone()) as Arc<dyn VoiceWorkBoard>
            })),
            servers: Some(servers.clone()),
            ..ToolsSetup::default()
        },
    );
    let using = tools.get().unwrap();
    using.start("Qu'est-ce qui m'attend sur le board ?", true);
    let process = nth(&spawned, 0);
    let policy = &process.policy;
    assert!(ask_rules(policy).contains(&"mcp__roamgate_work".to_owned()));
    assert_eq!(
        decision(
            "mcp__roamgate_work__work_list",
            json!({"state": "you"}),
            policy
        ),
        ToolDecision::Allow
    );
    for write in [
        "work_add",
        "work_update",
        "work_done",
        "work_reopen",
        "work_comment",
        "work_answer",
    ] {
        assert_eq!(
            decision(
                &format!("mcp__roamgate_work__{write}"),
                json!({"item": "x"}),
                policy
            ),
            ToolDecision::Hold,
            "{write}"
        );
    }
    // The companion's own tools are still given as voice.json says.
    assert!(policy.confirm.as_ref().unwrap().contains(&SEND.to_owned()));
    assert!(process.prompt().contains(WORK_PROMPT));

    let mcp_config = process.mcp_config.clone().unwrap();
    let listed = rpc(&servers.work, &mcp_config, json!({"method": "tools/list"})).await;
    let names: Vec<&str> = listed["result"]["tools"]
        .as_array()
        .unwrap()
        .iter()
        .map(|t| t["name"].as_str().unwrap())
        .collect();
    assert_eq!(
        names,
        [
            "work_list",
            "work_add",
            "work_update",
            "work_done",
            "work_reopen",
            "work_comment",
            "work_answer"
        ]
    );
    let read = rpc(
        &servers.work,
        &mcp_config,
        call("work_list", json!({"state": "you"})),
    )
    .await;
    assert!(
        read["result"]["content"][0]["text"]
            .as_str()
            .unwrap()
            .contains("Choose: media or no music")
    );
    // An error says what went wrong, for the job to tell.
    let wrong = rpc(
        &servers.work,
        &mcp_config,
        call("work_done", json!({"item": "ffffffffffff"})),
    )
    .await;
    assert_eq!(wrong["result"]["isError"], json!(true));
    assert!(
        wrong["result"]["content"][0]["text"]
            .as_str()
            .unwrap()
            .contains("no work item ffffffffffff")
    );

    // The front's state says what waits on the user, in one line.
    assert_eq!(using.work_line(), work_state_line(&service));
    assert!(using.work_line().contains("1 For you"));

    process.push(result("Une chose t'attend."));
    settle().await;
    assert_eq!(
        rpc(&servers.work, &mcp_config, json!({"method": "tools/list"})).await,
        json!(401)
    );
}

#[tokio::test]
async fn nothing_waiting_no_line_each_leases_servers_in_one_config() {
    assert_eq!(work_state_line(&work_board()), "");
    assert_eq!(merge_mcp_configs(&[]), None);
    assert_eq!(
        merge_mcp_configs(&[r#"{"mcpServers":{"a":1}}"#.into()]).as_deref(),
        Some(r#"{"mcpServers":{"a":1}}"#)
    );
    let merged: Value = serde_json::from_str(
        &merge_mcp_configs(&[
            r#"{"mcpServers":{"a":{"url":"x"}}}"#.into(),
            r#"{"mcpServers":{"b":{"url":"y"}}}"#.into(),
        ])
        .unwrap(),
    )
    .unwrap();
    assert_eq!(
        merged,
        json!({"mcpServers": {"a": {"url": "x"}, "b": {"url": "y"}}})
    );
}
