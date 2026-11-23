//! `conversation/rewind-scan.test.ts` (the Claude transcript's scan the
//! rewind driver reads), and the driver's control requests.

use std::collections::VecDeque;
use std::sync::{Arc, Mutex};

use roamgate_agents::js;
use roamgate_conversation::driver::{
    BoxFuture, ControlAnswer, HeadlessProcess, Object, RewindContext, RewindDriver, RewindInput,
    Transcript,
};
use serde_json::{Value, json};

use super::{ClaudeRewind, scan_transcript_of};
use crate::conversation::fake::answer;

fn lines(records: &[Value]) -> String {
    records
        .iter()
        .map(js::stringify)
        .collect::<Vec<_>>()
        .join("\n")
}

fn prompt(uuid: &str, parent: Option<&str>) -> Value {
    json!({
        "type": "user",
        "uuid": uuid,
        "parentUuid": parent,
        "message": {"role": "user", "content": format!("message {uuid}")},
    })
}

fn tool(uuid: &str, parent: &str, name: &str, input: Value) -> Value {
    json!({
        "type": "assistant",
        "uuid": uuid,
        "parentUuid": parent,
        "message": {
            "role": "assistant",
            "content": [
                {"type": "text", "text": "doing it"},
                {"type": "tool_use", "id": format!("t-{uuid}"), "name": name, "input": input},
            ],
        },
    })
}

fn scan(text: &str, uuid: &str) -> super::RewindScan {
    scan_transcript_of(&Transcript::Text(text.to_owned()), uuid)
}

#[test]
fn the_files_claudes_file_tools_edited_after_the_message_once_each() {
    let transcript = lines(&[
        prompt("u1", None),
        tool("a1", "u1", "Bash", json!({"command": "touch x"})),
        prompt("u2", Some("a1")),
        tool("a2", "u2", "Edit", json!({"file_path": "/w/a.ts"})),
        tool(
            "a3",
            "a2",
            "NotebookEdit",
            json!({"notebook_path": "/w/n.ipynb"}),
        ),
        tool("a4", "a3", "Write", json!({"file_path": "/w/a.ts"})),
        tool("a5", "a4", "Read", json!({"file_path": "/w/r.ts"})),
    ]);
    let found = scan(&transcript, "u1");
    assert!(found.found);
    assert_eq!(found.edited, ["/w/a.ts", "/w/n.ipynb"]);
    assert!(!found.checkpoint);
    assert_eq!(
        scan(&format!("{transcript}\n{{\"half"), "u2").edited,
        ["/w/a.ts", "/w/n.ipynb"]
    );
}

#[test]
fn commands_only_nothing_edited() {
    let transcript = lines(&[
        prompt("u1", None),
        tool("a1", "u1", "Bash", json!({"command": "sed -i s/a/b/ f"})),
    ]);
    let found = scan(&transcript, "u1");
    assert!(found.found && found.edited.is_empty() && !found.checkpoint);
}

#[test]
fn the_checkpoint_claude_code_took_for_the_message() {
    let transcript = lines(&[
        prompt("u1", None),
        json!({
            "type": "file-history-snapshot",
            "messageId": "u1",
            "snapshot": {"messageId": "u1", "trackedFileBackups": {}},
        }),
        tool("a1", "u1", "Edit", json!({"file_path": "/w/a.ts"})),
    ]);
    assert!(scan(&transcript, "u1").checkpoint);
}

#[test]
fn turns_a_rewind_left_behind_do_not_count() {
    let transcript = lines(&[
        prompt("u1", None),
        tool("a1", "u1", "Bash", json!({"command": "ls"})),
        prompt("u2", Some("a1")),
        tool("a2", "u2", "Edit", json!({"file_path": "/w/gone.ts"})),
        // Rewound to before u2: the next message hangs from a1.
        prompt("u3", Some("a1")),
        tool("a3", "u3", "Bash", json!({"command": "ls"})),
    ]);
    assert!(scan(&transcript, "u1").edited.is_empty());
    assert!(!scan(&transcript, "u2").found);
}

/// A process that is never read: the rewind only asks over control.
struct Idle;

impl HeadlessProcess for Idle {
    fn next_line(&self) -> BoxFuture<'_, Option<String>> {
        Box::pin(async { None })
    }
    fn write(&self, _line: &str) -> Result<(), String> {
        Ok(())
    }
    fn end(&self) {}
    fn kill(&self) {}
    fn exited(&self) -> BoxFuture<'_, i32> {
        Box::pin(async { 0 })
    }
}

/// A session answering the control requests in order, noting them.
struct Session {
    transcript: Option<String>,
    answers: Mutex<VecDeque<Option<ControlAnswer>>>,
    asked: Mutex<Vec<Value>>,
    starts: Mutex<usize>,
}

impl Session {
    fn new(transcript: Option<String>, answers: Vec<Value>) -> Self {
        Self {
            transcript,
            answers: Mutex::new(answers.into_iter().map(answer).collect()),
            asked: Mutex::new(Vec::new()),
            starts: Mutex::new(0),
        }
    }
}

impl RewindContext for Session {
    fn session_id(&self) -> String {
        "s1".into()
    }
    fn ensure_process(&self) -> BoxFuture<'_, Result<Arc<dyn HeadlessProcess>, String>> {
        *self.starts.lock().unwrap() += 1;
        Box::pin(async { Ok(Arc::new(Idle) as Arc<dyn HeadlessProcess>) })
    }
    fn stop_process(&self) -> BoxFuture<'_, bool> {
        Box::pin(async { true })
    }
    fn control<'a>(
        &'a self,
        _child: &'a Arc<dyn HeadlessProcess>,
        kind: &'a str,
        params: Object,
    ) -> BoxFuture<'a, Option<ControlAnswer>> {
        self.asked
            .lock()
            .unwrap()
            .push(json!([kind, Value::Object(params)]));
        let answer = self.answers.lock().unwrap().pop_front().flatten();
        Box::pin(async move { answer })
    }
    fn read_transcript(&self) -> Option<BoxFuture<'_, Result<Option<Transcript>, String>>> {
        let transcript = self.transcript.clone().map(Transcript::Text);
        Some(Box::pin(async move { Ok(transcript) }))
    }
    fn log(&self, _message: &str, _fields: Option<Object>) {}
}

fn input(mode: &str, last_seen: Option<&str>) -> RewindInput {
    RewindInput {
        uuid: "u1".into(),
        last_seen: last_seen.map(str::to_owned),
        mode: mode.into(),
    }
}

#[tokio::test]
async fn rewinds_the_conversation_and_the_code_it_restored() {
    let transcript = lines(&[
        prompt("u1", None),
        json!({"type": "file-history-snapshot", "messageId": "u1"}),
        tool("a1", "u1", "Edit", json!({"file_path": "/w/a.ts"})),
    ]);
    let session = Session::new(
        Some(transcript),
        vec![
            json!({"response": {"canRewind": true, "filesChanged": ["/w/a.ts"]}}),
            json!({"response": {"rewound": true, "prefillText": "again"}}),
            json!({"response": {"canRewind": true}}),
        ],
    );
    let result = ClaudeRewind.run(&session, input("both", Some("u0"))).await;
    assert_eq!(
        result,
        Ok(json!({"ok": true, "prefill": "again", "files": ["/w/a.ts"], "code": "restored"}))
    );
    assert_eq!(
        Value::Array(session.asked.lock().unwrap().clone()),
        json!([
            ["rewind_files", {"user_message_id": "u1", "dry_run": true}],
            ["rewind_conversation", {"target_message_uuid": "u1", "last_seen_user_message_uuid": "u0"}],
            ["rewind_files", {"user_message_id": "u1"}],
        ])
    );
}

#[tokio::test]
async fn a_refusal_is_said_for_the_user_and_no_checkpoint_names_the_files() {
    let session = Session::new(
        None,
        vec![json!({"response": {"rewound": false, "reason": "turn_running"}})],
    );
    assert_eq!(
        ClaudeRewind
            .run(&session, input("conversation", None))
            .await,
        Ok(json!({"ok": false, "reason": "Claude Code did not rewind: a turn is running"}))
    );
    let transcript = lines(&[
        prompt("u1", None),
        tool("a1", "u1", "Edit", json!({"file_path": "/w/a.ts"})),
    ]);
    let session = Session::new(
        Some(transcript),
        vec![json!({"response": {"canRewind": false, "error": "File rewinding is not enabled."}})],
    );
    assert_eq!(
        ClaudeRewind.run(&session, input("code", None)).await,
        Ok(json!({
            "ok": false,
            "no_checkpoint": true,
            "reason": "Claude Code has no code checkpoint for these changes (made before checkpoints were on)",
            "files": ["/w/a.ts"],
        }))
    );
    assert_eq!(*session.starts.lock().unwrap(), 1);
}

#[test]
fn a_transcript_check_says_what_the_code_comes_to() {
    let transcript = Transcript::Text(lines(&[
        prompt("u1", None),
        tool("a1", "u1", "Write", json!({"file_path": "/w/b.ts"})),
    ]));
    assert_eq!(
        ClaudeRewind.check_transcript(Some(&transcript), "u1"),
        json!({"code": "no_checkpoint", "files": ["/w/b.ts"]})
    );
    assert_eq!(
        ClaudeRewind.check_transcript(None, "u1"),
        json!({"code": "unknown"})
    );
    assert_eq!(
        ClaudeRewind.check_transcript(Some(&transcript), "a1"),
        json!({"code": "none"})
    );
}
