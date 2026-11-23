//! herdr.test.ts (the Herdr side; Claude's screen and `ps` parsers are
//! tested with its drivers in roamgate-claude).

use std::sync::{Arc, Mutex};

use serde_json::{Value, json};

use super::*;
use crate::testing::test_drivers;

const A: &str = "29616207-48e6-4ee2-b068-8fb98875a053";
const B: &str = "3892d0a6-1111-2222-3333-444444444444";

type Answer = Box<dyn Fn(&str, &Value) -> HerdrResult<Value> + Send + Sync>;

struct Calls {
    answer: Answer,
    ps: Arc<Mutex<String>>,
}

impl HerdrCalls for Calls {
    fn call<'a>(
        &'a self,
        method: &'a str,
        params: Value,
        _timeout_ms: u64,
    ) -> BoxFuture<'a, HerdrResult<Value>> {
        let answer = (self.answer)(method, &params);
        Box::pin(async move { answer })
    }
    fn pid_alive(&self, _pid: u32) -> BoxFuture<'_, bool> {
        Box::pin(async { false })
    }
    fn list_processes(&self) -> BoxFuture<'_, HerdrResult<String>> {
        let ps = self.ps.lock().unwrap().clone();
        Box::pin(async move { Ok(ps) })
    }
}

fn herdr(answer: Answer, ps: Arc<Mutex<String>>) -> HerdrConversation {
    HerdrConversation::new(Arc::new(Calls { answer, ps }), test_drivers(), 0)
}

fn ids(items: &[&str]) -> Vec<String> {
    items.iter().map(|item| item.to_string()).collect()
}

#[tokio::test]
async fn a_pane_herdr_maps_to_the_session_or_a_process_on_the_host() {
    let ps = Arc::new(Mutex::new(String::new()));
    let herdr = herdr(
        Box::new(|method, _| {
            Ok(if method == "agent.list" {
                json!({"agents": [
                    {"pane_id": "w1:p1", "agent_session": {"value": A}},
                    {"pane_id": "w2:p1", "agent_session": {"value": B}},
                ]})
            } else {
                Value::Null
            })
        }),
        ps.clone(),
    );
    assert_eq!(
        herdr.writer_elsewhere("w1:p1", &ids(&[A]), &[]).await,
        Ok(None)
    );
    let found = herdr
        .writer_elsewhere("w1:p1", &ids(&[A, B]), &[])
        .await
        .unwrap()
        .unwrap();
    assert_eq!(found.text, "Claude runs this session in pane w2:p1");
    assert_eq!(
        found.pane.map(Value::Object),
        Some(json!({"pane_id": "w2:p1", "agent_name": "Claude", "status": "unknown"}))
    );
    *ps.lock().unwrap() = format!(" 77 claude --resume {A}");
    assert_eq!(
        herdr.writer_elsewhere("w1:p1", &ids(&[A]), &[]).await,
        Ok(Some(WriterElsewhere {
            text: "Claude runs this session in another terminal (pid 77)".into(),
            pane: None,
        }))
    );
    assert_eq!(
        herdr.writer_elsewhere("w1:p1", &ids(&[A]), &[77]).await,
        Ok(None)
    );
}

#[tokio::test]
async fn names_another_pane_s_writer_as_the_sidebar_does_and_says_whether_it_is_idle() {
    let agent = Arc::new(Mutex::new(json!({
        "pane_id": "w2:p12", "workspace_id": "w2", "tab_id": "w2:t3",
        "agent": "claude", "agent_status": "done", "agent_session": {"value": A},
    })));
    let tab = Arc::new(Mutex::new(json!({"label": "3", "number": 3})));
    let (listed, labelled) = (agent.clone(), tab.clone());
    let herdr = herdr(
        Box::new(move |method, params| {
            Ok(match method {
                "agent.list" => json!({"agents": [listed.lock().unwrap().clone()]}),
                "workspace.get" => {
                    assert_eq!(params, &json!({"workspace_id": "w2"}));
                    json!({"workspace": {"label": "roamgate", "number": 1}})
                }
                "tab.get" => {
                    assert_eq!(params, &json!({"tab_id": "w2:t3"}));
                    json!({"tab": labelled.lock().unwrap().clone()})
                }
                _ => Value::Null,
            })
        }),
        Arc::default(),
    );
    let pane = |found: HerdrResult<Option<WriterElsewhere>>| {
        Value::Object(found.unwrap().unwrap().pane.unwrap())
    };
    assert_eq!(
        pane(herdr.writer_elsewhere("w1:p1", &ids(&[A]), &[]).await),
        json!({
            "pane_id": "w2:p12", "workspace_id": "w2", "tab_id": "w2:t3",
            "workspace_label": "roamgate",
            // A tab named by its number is "Tab 3", as in the tab bar.
            "tab_label": "Tab 3",
            "agent_name": "Claude", "status": "idle",
        })
    );
    *tab.lock().unwrap() = json!({"label": "review", "number": 3});
    agent.lock().unwrap()["agent_status"] = json!("working");
    let found = pane(herdr.writer_elsewhere("w1:p1", &ids(&[A]), &[]).await);
    assert_eq!(found["tab_label"], "review");
    assert_eq!(found["status"], "working");
    agent.lock().unwrap()["agent_status"] = json!("blocked");
    assert_eq!(
        pane(herdr.writer_elsewhere("w1:p1", &ids(&[A]), &[]).await)["status"],
        "blocked"
    );
}

#[tokio::test]
async fn a_pane_herdr_still_maps_to_the_session_once_its_agent_has_gone_writes_nothing() {
    let foreground = Arc::new(Mutex::new(json!([])));
    let shown = foreground.clone();
    let herdr = herdr(
        Box::new(move |method, _| match method {
            "agent.list" => Ok(json!({"agents": [
                {"pane_id": "w2:p12", "agent_status": "unknown", "agent_session": {"value": A}},
            ]})),
            "pane.process_info" => {
                let foreground = shown.lock().unwrap().clone();
                let group = foreground
                    .get(0)
                    .and_then(|first| first.get("pid"))
                    .cloned()
                    .unwrap_or(json!(800));
                Ok(
                    json!({"process_info": {"shell_pid": 800, "foreground_process_group_id": group, "foreground_processes": foreground}}),
                )
            }
            _ => Err("not found".into()),
        }),
        Arc::default(),
    );
    // The shell is back at its prompt.
    assert_eq!(
        herdr.writer_elsewhere("w1:p1", &ids(&[A]), &[]).await,
        Ok(None)
    );
    // Something still runs in front of it (a holder): it counts.
    *foreground.lock().unwrap() = json!([{"pid": 950, "argv": ["python3", "roamgate-hold", A]}]);
    let found = herdr
        .writer_elsewhere("w1:p1", &ids(&[A]), &[])
        .await
        .unwrap()
        .unwrap()
        .pane
        .unwrap();
    assert_eq!(found["pane_id"], "w2:p12");
    assert_eq!(found["status"], "unknown");
}

#[tokio::test]
async fn a_pane_herdr_no_longer_knows_is_gone() {
    let herdr = herdr(
        Box::new(
            |_, params| match params.get("pane_id").and_then(Value::as_str) {
                Some("w9:p9") => Err("pane_not_found: w9:p9".into()),
                Some("w8:p8") => Err("timed out".into()),
                _ => Ok(json!({"pane": {}})),
            },
        ),
        Arc::default(),
    );
    assert_eq!(herdr.pane_exists("w1:p1").await, Ok(true));
    assert_eq!(herdr.pane_exists("w9:p9").await, Ok(false));
    assert!(
        herdr
            .pane_exists("w8:p8")
            .await
            .unwrap_err()
            .contains("timed out")
    );
}

#[test]
fn accepts_herdr_s_wire_spelling_and_the_dotted_one() {
    // Herdr 0.9 sends pane_closed on the socket.
    assert_eq!(
        conversation_close_event(
            &json!({"event": "pane_closed", "data": {"type": "pane_closed", "pane_id": "w6:p1"}})
        ),
        Some(CloseEvent::Pane("w6:p1".into()))
    );
    assert_eq!(
        conversation_close_event(&json!({"event": "pane.closed", "data": {"pane_id": "w1:p2"}})),
        Some(CloseEvent::Pane("w1:p2".into()))
    );
    for event in [
        "tab_closed",
        "tab.closed",
        "workspace_closed",
        "workspace.closed",
    ] {
        assert_eq!(
            conversation_close_event(&json!({"event": event, "data": {}})),
            Some(CloseEvent::Sweep)
        );
    }
}

#[test]
fn a_pane_close_without_a_pane_id_still_sweeps_other_events_do_nothing() {
    assert_eq!(
        conversation_close_event(&json!({"event": "pane_closed", "data": {}})),
        Some(CloseEvent::Sweep)
    );
    assert_eq!(
        conversation_close_event(&json!({"event": "pane_focused", "data": {"pane_id": "w1:p1"}})),
        None
    );
    assert_eq!(conversation_close_event(&Value::Null), None);
}

#[tokio::test]
async fn is_read_with_its_styles_or_as_plain_text_from_a_herdr_without_them() {
    let reads = Arc::new(Mutex::new(Vec::<Value>::new()));
    let styled = Arc::new(Mutex::new(true));
    let (noted, style) = (reads.clone(), styled.clone());
    let herdr = herdr(
        Box::new(move |method, params| {
            if method != "agent.read" {
                return Ok(Value::Null);
            }
            noted.lock().unwrap().push(params.clone());
            let styled = *style.lock().unwrap();
            if params.get("format").and_then(Value::as_str) == Some("ansi") && !styled {
                return Err("invalid request: unknown field `format`".into());
            }
            Ok(json!({"read": {"text": if styled { "styled" } else { "plain" }}}))
        }),
        Arc::default(),
    );
    assert_eq!(herdr.read_detection("w1:p1").await, Ok("styled".into()));
    let first = reads.lock().unwrap()[0].clone();
    assert_eq!(first["target"], "w1:p1");
    assert_eq!(first["format"], "ansi");
    assert_eq!(first["strip_ansi"], false);
    *styled.lock().unwrap() = false;
    assert_eq!(herdr.read_detection("w1:p1").await, Ok("plain".into()));
    assert_eq!(reads.lock().unwrap().last().unwrap()["source"], "detection");
}

#[test]
fn process_info_is_read_from_either_shape() {
    let info = parse_process_info(
        &json!({"shell_pid": 1, "foreground_processes": [{"pid": 2, "argv": ["a", 3], "cwd": "/w"}, {"x": 1}]}),
    );
    assert_eq!(info.shell_pid, Some(1.0));
    assert_eq!(info.foreground_process_group_id, None);
    assert_eq!(info.foreground_processes.len(), 1);
    assert_eq!(
        info.foreground_processes[0].argv,
        Some(vec!["a".to_owned()])
    );
}
