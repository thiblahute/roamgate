//! session.test.ts's cases that check what a session writes: the lines the
//! agent is written, the events a browser gets for a turn, the queue,
//! rewinds and the state saved for the next runtime. Run with Claude's own
//! codec (`roamgate-claude`), as Bun's tests run with claude's.

use std::collections::VecDeque;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use roamgate_base::clock::TokioClock;
use roamgate_claude::conversation::claude::{
    DISMISSED_PERMISSION_MESSAGE, DISMISSED_QUESTION_MESSAGE,
};
use roamgate_claude::conversation::claude_driver;
use roamgate_conversation::driver::{BoxFuture, HeadlessProcess, HolderPosition, Transcript};
use roamgate_conversation::headless::{HeadlessSpawnOptions, SpawnHeadless};
use roamgate_conversation::images::ConversationImage;
use roamgate_conversation::session::{
    ConversationPrompt, ConversationSession, ResumeState, SessionOptions, is_spoken_stop,
};
use roamgate_conversation::shared::Obj;
use roamgate_conversation::testing::{FakeClaude, Respond, answer_interrupts, result_line, settle};
use serde_json::{Value, json};
use tokio::sync::oneshot;
use tokio_util::sync::CancellationToken;

fn obj(value: Value) -> Obj {
    value.as_object().cloned().unwrap_or_default()
}

fn stream(event: Value) -> Value {
    json!({"type": "stream_event", "event": event, "parent_tool_use_id": null})
}

// ------------------------------------------------------------ the fakes

/// A fake Claude with what a holder's process says of itself.
struct Proc {
    fake: Arc<FakeClaude>,
    replayed: usize,
    catch_up: usize,
    resume: Option<Value>,
    position: Option<HolderPosition>,
    undelivered: Mutex<Option<Vec<String>>>,
    /// A kill that says nothing (over SSH).
    kill_ignored: bool,
    detached: Mutex<bool>,
}

impl Proc {
    fn of(fake: Arc<FakeClaude>) -> Self {
        Self {
            fake,
            replayed: 0,
            catch_up: 0,
            resume: None,
            position: None,
            undelivered: Mutex::new(None),
            kill_ignored: false,
            detached: Mutex::new(false),
        }
    }
}

impl HeadlessProcess for Proc {
    fn next_line(&self) -> BoxFuture<'_, Option<String>> {
        self.fake.next_line()
    }
    fn write(&self, line: &str) -> Result<(), String> {
        self.fake.write(line)
    }
    fn end(&self) {
        self.fake.end()
    }
    fn kill(&self) {
        if !self.kill_ignored {
            self.fake.kill()
        }
    }
    fn exited(&self) -> BoxFuture<'_, i32> {
        self.fake.exited()
    }
    fn pid(&self) -> Option<u32> {
        self.fake.pid()
    }
    fn replayed(&self) -> usize {
        self.replayed
    }
    fn catch_up(&self) -> usize {
        self.catch_up
    }
    fn undelivered(&self) -> Option<Vec<String>> {
        self.undelivered.lock().unwrap().clone()
    }
    fn resume(&self) -> Option<Value> {
        self.resume.clone()
    }
    fn position(&self) -> Option<Option<HolderPosition>> {
        self.position.map(Some)
    }
    fn detach(&self) {
        *self.detached.lock().unwrap() = true;
        self.fake.exit(0);
    }
}

type Make = Box<dyn Fn() -> Arc<Proc> + Send + Sync>;

/// Hands out fakes, recording each start (`fakeSpawner`).
struct Spawner {
    make: Make,
    spawned: Mutex<Vec<(HeadlessSpawnOptions, Arc<Proc>)>>,
    running: Mutex<VecDeque<Arc<Proc>>>,
    /// Starts wait for this, when set.
    gate: Mutex<Option<oneshot::Receiver<()>>>,
    fail: Mutex<Option<String>>,
}

fn fake(respond: Option<Respond>) -> Arc<FakeClaude> {
    FakeClaude::new(None, true, respond)
}

fn default_make() -> Make {
    Box::new(|| Arc::new(Proc::of(fake(Some(Box::new(answer_interrupts))))))
}

impl Spawner {
    fn new(make: Option<Make>) -> Arc<Self> {
        Arc::new(Self {
            make: make.unwrap_or_else(default_make),
            spawned: Mutex::new(Vec::new()),
            running: Mutex::new(VecDeque::new()),
            gate: Mutex::new(None),
            fail: Mutex::new(None),
        })
    }

    fn count(&self) -> usize {
        self.spawned.lock().unwrap().len()
    }

    fn nth(&self, index: usize) -> Arc<Proc> {
        self.spawned.lock().unwrap()[index].1.clone()
    }
}

impl SpawnHeadless for Spawner {
    fn spawn(
        &self,
        options: HeadlessSpawnOptions,
    ) -> BoxFuture<'_, Result<Option<Arc<dyn HeadlessProcess>>, String>> {
        Box::pin(async move {
            let gate = self.gate.lock().unwrap().take();
            if let Some(gate) = gate {
                let signal = options.signal.clone().unwrap_or_default();
                tokio::select! {
                    _ = gate => {}
                    () = signal.cancelled() => return Err("gave up".into()),
                }
            }
            tokio::task::yield_now().await;
            if let Some(error) = self.fail.lock().unwrap().clone() {
                return Err(error);
            }
            if options.attach_only {
                return Ok(self
                    .running
                    .lock()
                    .unwrap()
                    .pop_front()
                    .map(|proc| proc as Arc<dyn HeadlessProcess>));
            }
            let proc = (self.make)();
            self.spawned.lock().unwrap().push((options, proc.clone()));
            Ok(Some(proc as Arc<dyn HeadlessProcess>))
        })
    }
}

/// A prompt as the test saw it asked.
struct Asked {
    tool: String,
    input: Value,
    can_always: bool,
    questions: Option<Vec<Value>>,
    signal: CancellationToken,
}

type ReadTranscript = Arc<dyn Fn() -> Result<Option<Transcript>, String> + Send + Sync>;
type Later = Arc<Mutex<Option<oneshot::Sender<Option<Value>>>>>;
type Answer = Arc<dyn Fn(&ConversationPrompt) -> BoxFuture<'static, Option<Value>> + Send + Sync>;

#[derive(Default)]
struct Setup {
    answer: Option<Answer>,
    make: Option<Make>,
    queue: Vec<Obj>,
    coalesce_ms: Option<u64>,
    rewind_wait_ms: Option<u64>,
    stop_wait_ms: Option<u64>,
    transcript: Option<ReadTranscript>,
    image_gate: Option<Arc<tokio::sync::Mutex<Option<oneshot::Receiver<()>>>>>,
}

struct Context {
    session: ConversationSession,
    events: Arc<Mutex<Vec<Obj>>>,
    prompts: Arc<Mutex<Vec<Asked>>>,
    spawner: Arc<Spawner>,
    session_ids: Arc<Mutex<Vec<String>>>,
    reported: Arc<Mutex<Vec<String>>>,
}

fn setup(options: Setup) -> Context {
    let events = Arc::new(Mutex::new(Vec::new()));
    let prompts = Arc::new(Mutex::new(Vec::new()));
    let session_ids = Arc::new(Mutex::new(Vec::new()));
    let reported = Arc::new(Mutex::new(Vec::new()));
    let spawner = Spawner::new(options.make);
    let answer = options.answer.unwrap_or_else(|| {
        Arc::new(|_: &ConversationPrompt| {
            Box::pin(async { Some(json!("allow")) }) as BoxFuture<'static, Option<Value>>
        })
    });
    let emit = {
        let events = events.clone();
        Arc::new(move |event: Obj| events.lock().unwrap().push(event))
    };
    let ask = {
        let prompts = prompts.clone();
        Arc::new(move |prompt: ConversationPrompt| {
            let answered = answer(&prompt);
            prompts.lock().unwrap().push(Asked {
                tool: prompt.tool,
                input: prompt.input,
                can_always: prompt.can_always,
                questions: prompt.questions,
                signal: prompt.signal,
            });
            Box::pin(async move { Ok(answered.await) })
                as BoxFuture<'static, Result<Option<Value>, String>>
        })
    };
    let image_gate = options.image_gate.clone();
    let read_image = Arc::new(move |path: String| {
        let gate = image_gate.clone();
        Box::pin(async move {
            if let Some(gate) = gate {
                let receiver = gate.lock().await.take();
                if let Some(receiver) = receiver {
                    let _ = receiver.await;
                }
            }
            Ok(ConversationImage {
                media_type: "image/png".into(),
                data: format!("b64:{path}"),
            })
        }) as BoxFuture<'static, Result<ConversationImage, String>>
    });
    let mut session_options = SessionOptions::new(
        "p1",
        "s1",
        "/work",
        spawner.clone(),
        emit,
        ask,
        read_image,
        Arc::new(TokioClock::starting_at(1_767_225_600_000)),
        claude_driver().protocol,
    );
    session_options.interrupt_wait_ms = 50;
    session_options.stop_wait_ms = options.stop_wait_ms.unwrap_or(50);
    session_options.queue = options.queue;
    if let Some(ms) = options.coalesce_ms {
        session_options.coalesce_ms = ms;
    }
    if let Some(ms) = options.rewind_wait_ms {
        session_options.rewind_wait_ms = ms;
    }
    session_options.on_session_id = Some({
        let session_ids = session_ids.clone();
        Arc::new(move |id: &str, _: &str| session_ids.lock().unwrap().push(id.into()))
    });
    session_options.on_status = Some({
        let reported = reported.clone();
        Arc::new(move |status: &str| reported.lock().unwrap().push(status.into()))
    });
    if let Some(transcript) = options.transcript {
        session_options.read_transcript = Some(Arc::new(move || {
            let read = transcript();
            Box::pin(async move { read }) as BoxFuture<'static, Result<Option<Transcript>, String>>
        }));
    }
    Context {
        session: ConversationSession::new(session_options),
        events,
        prompts,
        spawner,
        session_ids,
        reported,
    }
}

impl Context {
    fn proc(&self) -> Arc<Proc> {
        self.spawner
            .spawned
            .lock()
            .unwrap()
            .last()
            .unwrap()
            .1
            .clone()
    }
    fn users(&self) -> Vec<Obj> {
        self.proc()
            .fake
            .written()
            .into_iter()
            .filter(|message| message.get("type") == Some(&json!("user")))
            .collect()
    }
    fn events(&self) -> Vec<Value> {
        self.events
            .lock()
            .unwrap()
            .iter()
            .cloned()
            .map(Value::Object)
            .collect()
    }
    fn of_type(&self, kind: &str) -> Vec<Value> {
        self.events()
            .into_iter()
            .filter(|event| event["type"] == kind)
            .collect()
    }
    fn statuses(&self) -> Vec<String> {
        self.of_type("status")
            .into_iter()
            .map(|event| event["status"].as_str().unwrap().to_owned())
            .collect()
    }
    fn state(&self) -> Value {
        Value::Object(self.session.state())
    }
    fn prompt_inputs(&self) -> Vec<Value> {
        self.prompts
            .lock()
            .unwrap()
            .iter()
            .map(|p| p.input.clone())
            .collect()
    }
    async fn start_turn(&self, text: &str) -> String {
        let (status, id) = self.session.send(text, Vec::new(), None).await.unwrap();
        assert_eq!(status, "sent");
        settle().await;
        id
    }
}

fn written_types(fake: &FakeClaude) -> Vec<String> {
    fake.written()
        .iter()
        .map(|message| {
            if message.get("type") == Some(&json!("control_request")) {
                message["request"]["subtype"]
                    .as_str()
                    .unwrap_or("")
                    .to_owned()
            } else {
                message["type"].as_str().unwrap_or("").to_owned()
            }
        })
        .collect()
}

fn control_responses(fake: &FakeClaude) -> Vec<Obj> {
    fake.written()
        .into_iter()
        .filter(|message| message.get("type") == Some(&json!("control_response")))
        .collect()
}

fn permission(id: &str) -> Value {
    json!({
        "type": "control_request",
        "request_id": id,
        "request": {"subtype": "can_use_tool", "tool_name": "Bash", "input": {"command": id}},
    })
}

fn answer_with(value: Option<Value>) -> Answer {
    Arc::new(move |_: &ConversationPrompt| {
        let value = value.clone();
        Box::pin(async move { value }) as BoxFuture<'static, Option<Value>>
    })
}

/// Answers once the returned sender is used.
fn answer_later() -> (Answer, Later) {
    let sender = Arc::new(Mutex::new(None));
    let slot = sender.clone();
    let answer: Answer = Arc::new(move |_: &ConversationPrompt| {
        let (tx, rx) = oneshot::channel();
        *slot.lock().unwrap() = Some(tx);
        Box::pin(async move { rx.await.ok().flatten() }) as BoxFuture<'static, Option<Value>>
    });
    (answer, sender)
}

fn never_answered() -> Answer {
    Arc::new(|prompt: &ConversationPrompt| {
        let signal = prompt.signal.clone();
        Box::pin(async move {
            signal.cancelled().await;
            None
        }) as BoxFuture<'static, Option<Value>>
    })
}

// ------------------------------------------------------------ sending

#[tokio::test(start_paused = true)]
async fn starts_the_process_on_demand_and_writes_a_stream_json_user_message() {
    let context = setup(Setup::default());
    context.start_turn("hello").await;
    let spawned = context.spawner.spawned.lock().unwrap();
    assert_eq!(spawned.len(), 1);
    assert_eq!(spawned[0].0.session_id, "s1");
    assert_eq!(spawned[0].0.cwd, "/work");
    assert!(!spawned[0].0.attach_only);
    drop(spawned);
    let users = context.users();
    assert_eq!(users.len(), 1);
    assert!(users[0]["uuid"].is_string());
    assert_eq!(
        users[0]["message"],
        json!({"role": "user", "content": "hello"})
    );
    assert_eq!(context.state()["status"], "working");
}

#[tokio::test(start_paused = true)]
async fn images_go_as_base64_content_blocks_after_the_text() {
    let context = setup(Setup::default());
    context
        .session
        .send("look", vec!["/tmp/a.png".into()], None)
        .await
        .unwrap();
    assert_eq!(
        context.users()[0]["message"],
        json!({"role": "user", "content": [
            {"type": "text", "text": "look"},
            {"type": "image", "source": {"type": "base64", "media_type": "image/png", "data": "b64:/tmp/a.png"}},
        ]})
    );
}

#[tokio::test(start_paused = true)]
async fn the_user_s_replay_settles_the_outbox_with_its_uuid() {
    let context = setup(Setup::default());
    let (_, id) = context
        .session
        .send("hi", Vec::new(), Some("u-1".into()))
        .await
        .unwrap();
    assert_eq!(id, "u-1");
    context.proc().fake.push(json!({
        "type": "user", "message": {"role": "user", "content": "hi"}, "uuid": "u-1", "isReplay": true,
    }));
    settle().await;
    assert!(
        context
            .events()
            .contains(&json!({"type": "user", "uuid": "u-1", "text": "hi", "images": 0}))
    );
}

#[tokio::test(start_paused = true)]
async fn typed_messages_wait_in_roamgate_s_queue_and_go_as_one_turn_at_its_end() {
    let context = setup(Setup::default());
    context.start_turn("hi").await;
    let (status, _) = context
        .session
        .send("second", Vec::new(), None)
        .await
        .unwrap();
    assert_eq!(status, "queued");
    let (_, third) = context
        .session
        .send("third", Vec::new(), None)
        .await
        .unwrap();
    assert!(context.session.edit_queued(&third, "third, edited"));
    let (_, fourth) = context
        .session
        .send("drop me", Vec::new(), None)
        .await
        .unwrap();
    assert_eq!(
        context.session.remove_queued(&fourth).unwrap()["text"],
        "drop me"
    );
    let texts: Vec<Value> = context.state()["queue"]
        .as_array()
        .unwrap()
        .iter()
        .map(|item| item["text"].clone())
        .collect();
    assert_eq!(texts, vec![json!("second"), json!("third, edited")]);
    assert_eq!(context.users().len(), 1);
    context.proc().fake.push(result_line());
    settle().await;
    assert_eq!(context.users().len(), 2);
    assert_eq!(
        context.users()[1]["message"],
        json!({"role": "user", "content": "second\n\nthird, edited"})
    );
    assert_eq!(context.state()["queue"], json!([]));
}

#[tokio::test(start_paused = true)]
async fn nothing_to_send_is_an_error() {
    let context = setup(Setup::default());
    assert_eq!(
        context
            .session
            .send("  ", Vec::new(), None)
            .await
            .unwrap_err(),
        "Nothing to send"
    );
}

// ------------------------------------------------------------ barge-in

#[tokio::test(start_paused = true)]
async fn speech_while_idle_is_a_new_turn() {
    let context = setup(Setup::default());
    let (action, _) = context.session.voice("hello", false, None).await.unwrap();
    assert_eq!(action, "sent");
}

#[tokio::test(start_paused = true)]
async fn speech_while_only_writing_text_interrupts_then_becomes_the_next_turn() {
    let context = setup(Setup::default());
    context.start_turn("hi").await;
    let proc = context.proc();
    proc.fake.push(stream(
        json!({"type": "message_start", "message": {"id": "m1"}}),
    ));
    proc.fake.push(stream(json!({"type": "content_block_start", "index": 0, "content_block": {"type": "text", "text": ""}})));
    settle().await;
    let (action, _) = context
        .session
        .voice("actually, no", false, None)
        .await
        .unwrap();
    assert_eq!(action, "interrupted_then_sent");
    assert_eq!(written_types(&proc.fake), vec!["user", "interrupt", "user"]);
    assert_eq!(
        context.users()[1]["message"],
        json!({"role": "user", "content": "actually, no"})
    );
}

#[tokio::test(start_paused = true)]
async fn speech_while_a_tool_runs_steers_the_same_turn() {
    let context = setup(Setup::default());
    context.start_turn("hi").await;
    let proc = context.proc();
    proc.fake.push(
        json!({"type": "assistant", "message": {"id": "m1", "content": [
            {"type": "tool_use", "id": "toolu_1", "name": "Bash", "input": {}},
        ]}}),
    );
    settle().await;
    assert_eq!(context.state()["tools_running"], true);
    let (action, _) = context
        .session
        .voice("also check tests", false, None)
        .await
        .unwrap();
    assert_eq!(action, "steered");
    assert!(!written_types(&proc.fake).contains(&"interrupt".to_owned()));
    assert_eq!(
        context.users().last().unwrap()["message"],
        json!({"role": "user", "content": "also check tests"})
    );
    proc.fake
        .push(json!({"type": "user", "message": {"content": [
            {"type": "tool_result", "tool_use_id": "toolu_1", "content": "ok"},
        ]}}));
    settle().await;
    assert_eq!(context.state()["tools_running"], false);
}

#[tokio::test(start_paused = true)]
async fn speech_between_two_tool_steps_or_while_thinking_steers() {
    let context = setup(Setup::default());
    context.start_turn("hi").await;
    let proc = context.proc();
    proc.fake.push(
        json!({"type": "assistant", "message": {"id": "m1", "content": [
            {"type": "tool_use", "id": "toolu_1", "name": "Read", "input": {}},
        ]}}),
    );
    proc.fake
        .push(json!({"type": "user", "message": {"content": [
            {"type": "tool_result", "tool_use_id": "toolu_1", "content": "ok"},
        ]}}));
    settle().await;
    assert_eq!(context.state()["tools_running"], false);
    assert_eq!(
        context
            .session
            .voice("use tabs", false, None)
            .await
            .unwrap()
            .0,
        "steered"
    );
    proc.fake.push(stream(
        json!({"type": "message_start", "message": {"id": "m2"}}),
    ));
    proc.fake.push(stream(json!({"type": "content_block_start", "index": 0, "content_block": {"type": "thinking", "thinking": ""}})));
    settle().await;
    assert_eq!(
        context
            .session
            .voice("and spaces", false, None)
            .await
            .unwrap()
            .0,
        "steered"
    );
    assert!(
        !proc
            .fake
            .written()
            .iter()
            .any(|message| message["type"] == "control_request")
    );
}

#[tokio::test(start_paused = true)]
async fn a_spoken_stop_or_the_stop_button_always_interrupts() {
    assert!(is_spoken_stop("Stop."));
    assert!(!is_spoken_stop("stop the server and restart"));
    let context = setup(Setup::default());
    context.start_turn("hi").await;
    assert_eq!(
        context.session.voice("stop!", false, None).await.unwrap(),
        ("interrupted", None)
    );
    assert_eq!(context.users().len(), 1);
    settle().await;
    assert_eq!(context.state()["status"], "idle");
    let again = setup(Setup::default());
    again.start_turn("hi").await;
    assert_eq!(
        again.session.voice("", true, None).await.unwrap(),
        ("interrupted", None)
    );
}

#[tokio::test(start_paused = true)]
async fn speech_sent_twice_with_one_uuid_is_taken_once() {
    let context = setup(Setup::default());
    for _ in 0..2 {
        assert_eq!(
            context
                .session
                .voice("hello", false, Some("v1".into()))
                .await
                .unwrap(),
            ("sent", Some("v1".into()))
        );
    }
    assert_eq!(context.users().len(), 1);
}

#[tokio::test(start_paused = true)]
async fn speech_while_a_permission_waits_is_queued() {
    let (answer, later) = answer_later();
    let context = setup(Setup {
        answer: Some(answer),
        ..Setup::default()
    });
    context.start_turn("hi").await;
    context.proc().fake.push(json!({
        "type": "control_request", "request_id": "r1",
        "request": {"subtype": "can_use_tool", "tool_name": "Bash", "input": {}},
    }));
    settle().await;
    assert_eq!(
        context.session.voice("later", false, None).await.unwrap().0,
        "queued"
    );
    let _ = later
        .lock()
        .unwrap()
        .take()
        .unwrap()
        .send(Some(json!("allow")));
}

// ------------------------------------------------------------ permissions

fn bash() -> Value {
    json!({"tool_name": "Bash", "input": {"command": "echo hi > f"}, "permission_suggestions": [{"type": "addRules"}]})
}

async fn ask(answer: Option<Value>, request: Value) -> (Context, Option<Obj>) {
    let context = setup(Setup {
        answer: Some(answer_with(answer)),
        ..Setup::default()
    });
    context.start_turn("hi").await;
    let mut body = obj(json!({"subtype": "can_use_tool"}));
    body.extend(obj(request));
    context
        .proc()
        .fake
        .push(json!({"type": "control_request", "request_id": "r1", "request": body}));
    settle().await;
    let response = control_responses(&context.proc().fake).into_iter().next();
    (context, response)
}

#[tokio::test(start_paused = true)]
async fn allow() {
    let (context, response) = ask(Some(json!("allow")), bash()).await;
    {
        let prompts = context.prompts.lock().unwrap();
        assert_eq!(prompts[0].tool, "Bash");
        assert_eq!(prompts[0].input, bash()["input"]);
        assert!(prompts[0].can_always);
    }
    assert_eq!(
        Value::Object(response.unwrap()),
        json!({"type": "control_response", "response": {
            "subtype": "success", "request_id": "r1",
            "response": {"behavior": "allow", "updatedInput": bash()["input"]},
        }})
    );
}

#[tokio::test(start_paused = true)]
async fn always_adds_the_suggested_rules() {
    let (_, response) = ask(Some(json!("always")), bash()).await;
    assert_eq!(
        response.unwrap()["response"]["response"],
        json!({"behavior": "allow", "updatedInput": bash()["input"], "updatedPermissions": bash()["permission_suggestions"]})
    );
}

#[tokio::test(start_paused = true)]
async fn deny_and_no_answer_in_time_deny() {
    for answer in [Some(json!("deny")), None] {
        let (_, response) = ask(answer, bash()).await;
        let response = &response.unwrap()["response"]["response"];
        assert_eq!(response["behavior"], "deny");
        assert_eq!(response["interrupt"], false);
    }
}

#[tokio::test(start_paused = true)]
async fn ask_user_question_answers_go_in_updated_input_answers() {
    let questions = json!([{"question": "Which colour?", "header": "Colour",
        "options": [{"label": "Red"}, {"label": "Blue"}], "multiSelect": false}]);
    let (context, response) = ask(
        Some(json!({"answers": {"Which colour?": "Blue"}})),
        json!({"tool_name": "AskUserQuestion", "input": {"questions": questions}, "requires_user_interaction": true}),
    )
    .await;
    {
        let prompts = context.prompts.lock().unwrap();
        assert_eq!(prompts[0].tool, "AskUserQuestion");
        assert!(!prompts[0].can_always);
        assert_eq!(
            Value::from(prompts[0].questions.clone().unwrap()),
            questions
        );
    }
    assert_eq!(
        response.unwrap()["response"]["response"],
        json!({"behavior": "allow", "updatedInput": {"questions": questions, "answers": {"Which colour?": "Blue"}}})
    );
}

#[tokio::test(start_paused = true)]
async fn a_dismissed_question_or_permission_denies_it_saying_so_the_turn_goes_on() {
    let questions = json!([{"question": "What should I delete?",
        "options": [{"label": "Worktree"}, {"label": "Images"}], "multiSelect": true}]);
    for (request, message) in [
        (
            json!({"tool_name": "AskUserQuestion", "input": {"questions": questions}}),
            DISMISSED_QUESTION_MESSAGE,
        ),
        (bash(), DISMISSED_PERMISSION_MESSAGE),
    ] {
        let (answer, later) = answer_later();
        let context = setup(Setup {
            answer: Some(answer),
            ..Setup::default()
        });
        context.start_turn("hi").await;
        let mut body = obj(json!({"subtype": "can_use_tool"}));
        body.extend(obj(request));
        context
            .proc()
            .fake
            .push(json!({"type": "control_request", "request_id": "r1", "request": body}));
        settle().await;
        assert_eq!(context.state()["status"], "blocked");
        let _ = later
            .lock()
            .unwrap()
            .take()
            .unwrap()
            .send(Some(json!("dismiss")));
        settle().await;
        let response = control_responses(&context.proc().fake).remove(0);
        assert_eq!(
            Value::Object(response.clone()),
            json!({"type": "control_response", "response": {
                "subtype": "success", "request_id": "r1",
                "response": {"behavior": "deny", "message": message, "interrupt": false},
            }})
        );
        assert!(
            !serde_json::to_string(&response)
                .unwrap()
                .contains("Worktree")
        );
        assert_eq!(context.state()["status"], "working");
        assert!(context.session.busy());
    }
}

#[tokio::test(start_paused = true)]
async fn blocked_while_it_waits_a_cancel_answers_nothing() {
    let (answer, later) = answer_later();
    let context = setup(Setup {
        answer: Some(answer),
        ..Setup::default()
    });
    context.start_turn("hi").await;
    context.proc().fake.push(json!({
        "type": "control_request", "request_id": "r1",
        "request": {"subtype": "can_use_tool", "tool_name": "Bash", "input": {}},
    }));
    settle().await;
    assert_eq!(context.state()["status"], "blocked");
    assert!(context.session.busy());
    context
        .proc()
        .fake
        .push(json!({"type": "control_cancel_request", "request_id": "r1"}));
    settle().await;
    assert!(context.prompts.lock().unwrap()[0].signal.is_cancelled());
    let _ = later
        .lock()
        .unwrap()
        .take()
        .unwrap()
        .send(Some(json!("allow")));
    settle().await;
    assert!(control_responses(&context.proc().fake).is_empty());
    assert_eq!(context.state()["status"], "working");
}

// ------------------------------------------------------------ stream events

fn text_delta(text: &str) -> Value {
    stream(
        json!({"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": text}}),
    )
}

#[tokio::test(start_paused = true)]
async fn deltas_are_coalesced_to_about_a_frame() {
    let context = setup(Setup {
        coalesce_ms: Some(16),
        ..Setup::default()
    });
    context.start_turn("hi").await;
    let proc = context.proc();
    proc.fake.push(stream(
        json!({"type": "message_start", "message": {"id": "m1"}}),
    ));
    for text in ["a", "b", "c"] {
        proc.fake.push(text_delta(text));
    }
    settle().await;
    assert!(context.of_type("delta").is_empty());
    tokio::time::advance(Duration::from_millis(16)).await;
    settle().await;
    assert_eq!(
        context.of_type("delta"),
        vec![json!({"type": "delta", "message_id": "m1", "index": 0, "text": "abc"})]
    );
}

#[tokio::test(start_paused = true)]
async fn an_interrupt_keeps_the_partial_reply_it_cut() {
    let context = setup(Setup {
        make: Some(Box::new(|| {
            Arc::new(Proc::of(fake(Some(Box::new(
                |message: &Obj, fake: &FakeClaude| {
                    if message.get("type") == Some(&json!("control_request")) {
                        fake.push(
                            json!({"type": "stream_event", "event": {"type": "message_stop"},
                        "abandoned_blocks": {"api_message_id": "m1", "from_block_index": 0}}),
                        );
                    }
                    answer_interrupts(message, fake);
                },
            )))))
        })),
        ..Setup::default()
    });
    context.start_turn("hi").await;
    let proc = context.proc();
    proc.fake.push(stream(
        json!({"type": "message_start", "message": {"id": "m1"}}),
    ));
    proc.fake.push(stream(json!({"type": "content_block_start", "index": 0, "content_block": {"type": "text", "text": ""}})));
    proc.fake.push(text_delta("One, two"));
    settle().await;
    assert!(context.session.interrupt().await.unwrap());
    tokio::time::sleep(Duration::from_millis(60)).await;
    settle().await;
    assert!(context.of_type("abandoned").is_empty());
    assert!(
        context.events().contains(
            &json!({"type": "delta", "message_id": "m1", "index": 0, "text": "One, two"})
        )
    );
}

#[tokio::test(start_paused = true)]
async fn abandoned_blocks_drop_their_held_deltas() {
    let context = setup(Setup {
        coalesce_ms: Some(16),
        ..Setup::default()
    });
    context.start_turn("hi").await;
    let proc = context.proc();
    proc.fake.push(stream(
        json!({"type": "message_start", "message": {"id": "m1"}}),
    ));
    proc.fake.push(text_delta("half"));
    proc.fake.push(
        json!({"type": "stream_event", "event": {"type": "message_stop"},
        "abandoned_blocks": {"api_message_id": "m1", "from_block_index": 0}}),
    );
    settle().await;
    tokio::time::advance(Duration::from_millis(16)).await;
    settle().await;
    assert!(context.of_type("delta").is_empty());
    assert!(
        context
            .events()
            .contains(&json!({"type": "abandoned", "message_id": "m1", "from_index": 0}))
    );
}

#[tokio::test(start_paused = true)]
async fn clear_moves_the_session_to_its_new_id() {
    let context = setup(Setup::default());
    context.start_turn("/clear").await;
    context.proc().fake.push(
        json!({"type": "conversation_reset", "new_conversation_id": "s2", "session_id": "s1"}),
    );
    context
        .proc()
        .fake
        .push(json!({"type": "system", "subtype": "init", "session_id": "s2"}));
    settle().await;
    assert_eq!(context.session.session_id(), "s2");
    assert_eq!(*context.session_ids.lock().unwrap(), vec!["s2".to_owned()]);
    assert!(
        context
            .events()
            .contains(&json!({"type": "session", "session_id": "s2", "previous": "s1"}))
    );
}

#[tokio::test(start_paused = true)]
async fn the_reply_text_streamed_so_far_is_kept_for_a_browser_coming_in() {
    let context = setup(Setup {
        coalesce_ms: Some(0),
        ..Setup::default()
    });
    context.start_turn("hi").await;
    let proc = context.proc();
    proc.fake.push(stream(
        json!({"type": "message_start", "message": {"id": "m1"}}),
    ));
    proc.fake.push(stream(json!({"type": "content_block_start", "index": 0, "content_block": {"type": "text", "text": ""}})));
    for text in ["Rain ", "falls"] {
        proc.fake.push(text_delta(text));
    }
    settle().await;
    tokio::time::sleep(Duration::from_millis(5)).await;
    settle().await;
    let streamed = |c: &Context| {
        Value::from(
            c.session
                .streamed()
                .into_iter()
                .map(Value::Object)
                .collect::<Vec<_>>(),
        )
    };
    assert_eq!(
        streamed(&context),
        json!([{"message_id": "m1", "index": 0, "text": "Rain falls", "done": false}])
    );
    proc.fake.push(json!({"type": "assistant", "message": {"id": "m1", "content": [{"type": "text", "text": "Rain falls."}]}, "parent_tool_use_id": null}));
    settle().await;
    assert_eq!(
        streamed(&context),
        json!([{"message_id": "m1", "index": 0, "text": "Rain falls.", "done": true}])
    );
    proc.fake.push(result_line());
    settle().await;
    assert_eq!(streamed(&context), json!([]));
}

#[tokio::test(start_paused = true)]
async fn status_follows_the_turn_its_tools_and_compaction() {
    let context = setup(Setup::default());
    context.start_turn("hi").await;
    context
        .proc()
        .fake
        .push(json!({"type": "system", "subtype": "status", "status": "compacting"}));
    settle().await;
    assert_eq!(context.state()["status"], "working");
    assert_eq!(context.state()["activity"], "compacting");
    context.proc().fake.push(result_line());
    settle().await;
    assert_eq!(context.state()["status"], "idle");
    assert_eq!(context.state()["activity"], Value::Null);
    assert_eq!(
        context.statuses(),
        vec!["starting", "working", "working", "idle"]
    );
}

// ------------------------------------------------------------ the process

#[tokio::test(start_paused = true)]
async fn an_idle_process_lives_on_like_the_terminal_s_claude() {
    let context = setup(Setup::default());
    context.start_turn("hi").await;
    context.proc().fake.push(result_line());
    settle().await;
    tokio::time::advance(Duration::from_secs(24 * 3600)).await;
    settle().await;
    assert!(!context.proc().fake.ended());
    assert_eq!(context.state()["status"], "idle");
    context
        .session
        .send("again", Vec::new(), None)
        .await
        .unwrap();
    assert_eq!(context.spawner.count(), 1);
}

#[tokio::test(start_paused = true)]
async fn a_message_sent_while_the_process_closes_waits_for_the_next_one() {
    let context = setup(Setup {
        make: Some(Box::new(|| {
            let mut proc = Proc::of(FakeClaude::new(
                None,
                false,
                Some(Box::new(answer_interrupts)),
            ));
            proc.kill_ignored = true;
            Arc::new(proc)
        })),
        ..Setup::default()
    });
    context.session.warm().await.unwrap();
    let first = context.proc();
    assert!(!context.session.stop().await);
    assert!(first.fake.ended());
    let session = context.session.clone();
    let sent = tokio::spawn(async move { session.send("late", Vec::new(), None).await });
    settle().await;
    assert!(first.fake.written().is_empty());
    first.fake.exit(0);
    assert_eq!(sent.await.unwrap().unwrap().0, "sent");
    assert_eq!(context.spawner.count(), 2);
    let written = context.proc().fake.written();
    assert_eq!(written.len(), 1);
    assert_eq!(
        written[0]["message"],
        json!({"role": "user", "content": "late"})
    );
}

#[tokio::test(start_paused = true)]
async fn a_process_started_ahead_of_any_turn_does_not_look_busy() {
    let context = setup(Setup::default());
    let (open, gate) = oneshot::channel();
    *context.spawner.gate.lock().unwrap() = Some(gate);
    let session = context.session.clone();
    let warming = tokio::spawn(async move { session.warm().await });
    settle().await;
    assert_eq!(context.state()["status"], "idle");
    assert_eq!(
        context
            .session
            .send("first", Vec::new(), None)
            .await
            .unwrap()
            .0,
        "queued"
    );
    assert_eq!(context.state()["status"], "starting");
    let _ = open.send(());
    warming.await.unwrap().unwrap();
    settle().await;
    assert_eq!(context.state()["status"], "working");
    let statuses = context.statuses();
    assert_eq!(statuses[0], "idle");
    assert!(!statuses.contains(&"stopped".to_owned()));
    let from = statuses.iter().position(|s| s == "starting").unwrap();
    assert_eq!(
        statuses[from..],
        ["starting".to_owned(), "working".to_owned()]
    );
}

#[tokio::test(start_paused = true)]
async fn a_message_on_its_way_to_stdin_counts_as_busy_for_a_hand_back() {
    let (open, gate) = oneshot::channel();
    let context = setup(Setup {
        image_gate: Some(Arc::new(tokio::sync::Mutex::new(Some(gate)))),
        ..Setup::default()
    });
    context.session.warm().await.unwrap();
    let session = context.session.clone();
    let sent = tokio::spawn(async move { session.send("look", vec!["/a.png".into()], None).await });
    settle().await;
    assert!(context.session.busy());
    assert_eq!(
        context
            .session
            .send("and this", Vec::new(), None)
            .await
            .unwrap()
            .0,
        "queued"
    );
    let _ = open.send(());
    assert_eq!(sent.await.unwrap().unwrap().0, "sent");
}

#[tokio::test(start_paused = true)]
async fn messages_left_by_a_start_that_failed_go_first_with_the_next_one() {
    let context = setup(Setup::default());
    *context.spawner.fail.lock().unwrap() = Some("Claude runs in the pane's terminal".into());
    let session = context.session.clone();
    let warming = tokio::spawn(async move { session.warm().await });
    tokio::task::yield_now().await;
    assert_eq!(
        context
            .session
            .send("first", Vec::new(), None)
            .await
            .unwrap()
            .0,
        "queued"
    );
    assert!(warming.await.unwrap().is_err());
    assert!(
        context
            .events()
            .iter()
            .any(|e| e["type"] == "notice" && e["kind"] == "error")
    );
    assert_eq!(context.session.queue_length(), 1);
    *context.spawner.fail.lock().unwrap() = None;
    assert_eq!(
        context
            .session
            .send("second", Vec::new(), None)
            .await
            .unwrap()
            .0,
        "sent"
    );
    assert_eq!(context.session.queue_length(), 0);
    let written = context.spawner.nth(0).fake.written();
    assert_eq!(written.len(), 1);
    assert_eq!(
        written[0]["message"],
        json!({"role": "user", "content": "first\n\nsecond"})
    );
}

#[tokio::test(start_paused = true)]
async fn a_stop_gives_up_a_start_still_waiting_for_its_process() {
    let context = setup(Setup::default());
    let (_open, gate) = oneshot::channel::<()>();
    *context.spawner.gate.lock().unwrap() = Some(gate);
    let session = context.session.clone();
    let warming = tokio::spawn(async move { session.warm().await });
    settle().await;
    assert!(context.session.stop().await);
    assert_eq!(warming.await.unwrap().unwrap_err(), "gave up");
}

#[tokio::test(start_paused = true)]
async fn a_process_dying_mid_turn_ends_the_turn_and_sends_the_queue_on() {
    let context = setup(Setup::default());
    context.start_turn("hi").await;
    context
        .session
        .send("queued", Vec::new(), None)
        .await
        .unwrap();
    context.proc().fake.exit(1);
    settle().await;
    assert!(
        context
            .of_type("result")
            .iter()
            .any(|e| e["subtype"] == "process_exited")
    );
    assert_eq!(context.spawner.count(), 2);
    let messages: Vec<Value> = context
        .users()
        .iter()
        .map(|u| u["message"].clone())
        .collect();
    assert_eq!(messages, vec![json!({"role": "user", "content": "queued"})]);
    assert_eq!(context.session.queue_length(), 0);
}

#[tokio::test(start_paused = true)]
async fn a_message_claude_never_got_goes_again_with_no_cut_off_notice() {
    let context = setup(Setup::default());
    context.session.warm().await.unwrap();
    let first = context.proc();
    context.start_turn("lost one").await;
    let written = first.fake.written();
    let line = roamgate_agents::js::stringify(&Value::Object(written[0].clone()));
    *first.undelivered.lock().unwrap() = Some(vec![line]);
    first.fake.exit(0);
    settle().await;
    assert!(
        !context
            .of_type("notice")
            .iter()
            .any(|e| e["kind"] == "process_exited")
    );
    assert_eq!(context.spawner.count(), 2);
    let users = context.users();
    assert_eq!(users.len(), 1);
    assert_eq!(
        users[0]["message"],
        json!({"role": "user", "content": "lost one"})
    );
    assert_eq!(users[0]["uuid"], written[0]["uuid"]);
}

#[tokio::test(start_paused = true)]
async fn a_process_that_dies_again_keeps_the_queue_for_the_next_message() {
    let context = setup(Setup::default());
    context.start_turn("hi").await;
    context
        .session
        .send("queued", Vec::new(), None)
        .await
        .unwrap();
    context.proc().fake.exit(1);
    settle().await;
    context
        .session
        .send("again", Vec::new(), None)
        .await
        .unwrap();
    context.proc().fake.exit(1);
    settle().await;
    assert_eq!(context.spawner.count(), 2);
    let state = context.state();
    assert_eq!(state["status"], "stopped");
    let queue = state["queue"].as_array().unwrap();
    assert_eq!(queue.len(), 1);
    assert_eq!(queue[0]["text"], "again");
    assert!(
        context
            .of_type("notice")
            .iter()
            .any(|e| e["text"].as_str().unwrap().contains("stopped again"))
    );
}

#[tokio::test(start_paused = true)]
async fn a_message_steered_in_as_the_turn_ends_keeps_the_session_working() {
    let context = setup(Setup::default());
    context.start_turn("hi").await;
    let mut result = result_line();
    result["queued_turn_count"] = json!(1);
    context.proc().fake.push(result);
    settle().await;
    assert!(context.session.busy());
    context
        .session
        .send("after", Vec::new(), None)
        .await
        .unwrap();
    assert_eq!(context.session.queue_length(), 1);
    context.proc().fake.push(result_line());
    settle().await;
    assert_eq!(context.session.queue_length(), 0);
    context.proc().fake.push(result_line());
    settle().await;
    assert!(!context.session.busy());
}

#[tokio::test(start_paused = true)]
async fn a_message_sent_twice_with_one_id_is_taken_once() {
    let context = setup(Setup::default());
    context.start_turn("hi").await;
    for _ in 0..2 {
        assert_eq!(
            context
                .session
                .send("x", Vec::new(), Some("u-1".into()))
                .await
                .unwrap(),
            ("queued", "u-1".to_owned())
        );
    }
    assert_eq!(context.session.queue_length(), 1);
    context.proc().fake.push(result_line());
    settle().await;
    assert_eq!(
        context
            .session
            .send("x", Vec::new(), Some("u-1".into()))
            .await
            .unwrap(),
        ("sent", "u-1".to_owned())
    );
    assert_eq!(context.users().len(), 2);
}

#[tokio::test(start_paused = true)]
async fn a_single_queued_message_goes_out_under_its_own_uuid() {
    let context = setup(Setup::default());
    context.start_turn("hi").await;
    context
        .session
        .send("next", Vec::new(), Some("u-9".into()))
        .await
        .unwrap();
    context.proc().fake.push(result_line());
    settle().await;
    assert_eq!(context.users()[1]["uuid"], "u-9");
    assert_eq!(
        context.users()[1]["message"],
        json!({"role": "user", "content": "next"})
    );
    assert_eq!(
        context
            .session
            .send("next", Vec::new(), Some("u-9".into()))
            .await
            .unwrap(),
        ("sent", "u-9".to_owned())
    );
    assert_eq!(context.users().len(), 2);
}

fn carried(id: &str, text: &str) -> Obj {
    obj(json!({"id": id, "text": text, "images": [], "queued_at": "t"}))
}

#[tokio::test(start_paused = true)]
async fn a_carried_queued_message_keeps_its_id_when_the_process_starts() {
    let context = setup(Setup {
        queue: vec![carried("q1", "left")],
        ..Setup::default()
    });
    context.session.warm().await.unwrap();
    settle().await;
    assert_eq!(context.users()[0]["uuid"], "q1");
}

#[tokio::test(start_paused = true)]
async fn several_queued_messages_go_as_one_turn_under_a_new_uuid() {
    let context = setup(Setup::default());
    context.start_turn("hi").await;
    context
        .session
        .send("a", Vec::new(), Some("u-a".into()))
        .await
        .unwrap();
    context
        .session
        .send("b", Vec::new(), Some("u-b".into()))
        .await
        .unwrap();
    context.proc().fake.push(result_line());
    settle().await;
    let uuid = context.users()[1]["uuid"].clone();
    assert_ne!(uuid, "u-a");
    assert_ne!(uuid, "u-b");
}

#[tokio::test(start_paused = true)]
async fn a_queue_carried_from_an_earlier_process_is_kept_and_taken_whole() {
    let context = setup(Setup {
        queue: vec![carried("q1", "left")],
        ..Setup::default()
    });
    assert_eq!(context.state()["queue"], json!([carried("q1", "left")]));
    context.session.warm().await.unwrap();
    settle().await;
    let messages: Vec<Value> = context
        .users()
        .iter()
        .map(|u| u["message"].clone())
        .collect();
    assert_eq!(messages, vec![json!({"role": "user", "content": "left"})]);
    let other = setup(Setup {
        queue: vec![carried("q2", "kept")],
        ..Setup::default()
    });
    assert_eq!(other.session.take_queue(), vec![carried("q2", "kept")]);
    assert_eq!(other.session.queue_length(), 0);
}

#[tokio::test(start_paused = true)]
async fn stop_closes_stdin_and_waits_for_the_exit_killing_a_stuck_one() {
    let context = setup(Setup::default());
    context.start_turn("hi").await;
    context.proc().fake.push(result_line());
    settle().await;
    assert!(context.session.stop().await);
    assert!(context.proc().fake.ended());
    let stuck = setup(Setup {
        make: Some(Box::new(|| {
            Arc::new(Proc::of(FakeClaude::new(
                None,
                false,
                Some(Box::new(answer_interrupts)),
            )))
        })),
        stop_wait_ms: Some(10),
        ..Setup::default()
    });
    stuck.session.warm().await.unwrap();
    assert!(stuck.session.stop().await);
    assert!(stuck.proc().fake.killed());
}

#[tokio::test(start_paused = true)]
async fn idle_at_once_a_turn_when_its_result_comes_or_false_past_the_wait() {
    let context = setup(Setup::default());
    assert!(context.session.wait_for_result(10).await);
    context.start_turn("hi").await;
    assert!(!context.session.wait_for_result(10).await);
    let session = context.session.clone();
    let waiting = tokio::spawn(async move { session.wait_for_result(1000).await });
    settle().await;
    context.proc().fake.push(result_line());
    assert!(waiting.await.unwrap());
}

// ------------------------------------------------------------ rewinding

type Answers = (Option<Value>, Option<Value>);

/// Answers rewinds as Claude Code does (`answerRewinds`).
fn answer_rewinds(answers: Answers) -> Respond {
    Box::new(move |message: &Obj, fake: &FakeClaude| {
        answer_interrupts(message, fake);
        if message.get("type") != Some(&json!("control_request")) {
            return;
        }
        let request = &message["request"];
        let response = match request["subtype"].as_str() {
            Some("rewind_files") => answers.0.clone().unwrap_or_else(|| {
                json!({"canRewind": true, "filesChanged": ["/work/a.txt"], "insertions": 1, "deletions": 2})
            }),
            Some("rewind_conversation") => answers.1.clone().unwrap_or_else(|| {
                json!({"rewound": true, "targetMessageUuid": request["target_message_uuid"],
                    "prefillText": "the message", "precedingAssistantUuid": "a0"})
            }),
            _ => return,
        };
        fake.push(json!({"type": "control_response", "response": {
            "subtype": "success", "request_id": message["request_id"], "response": response,
        }}));
    })
}

fn with_rewinds(answers: Answers) -> Make {
    Box::new(move || Arc::new(Proc::of(fake(Some(answer_rewinds(answers.clone()))))))
}

fn rewind_requests(fake: &FakeClaude) -> Vec<Value> {
    fake.written()
        .into_iter()
        .filter(|message| message.get("type") == Some(&json!("control_request")))
        .map(|message| message["request"].clone())
        .collect()
}

fn not_enabled() -> Option<Value> {
    Some(json!({"canRewind": false, "error": "File rewinding is not enabled."}))
}

/// Answers by start: the first, then every later one.
fn counted(first: Answers, later: Answers) -> Make {
    let starts = Arc::new(Mutex::new(0));
    Box::new(move || {
        let mut count = starts.lock().unwrap();
        *count += 1;
        let answers = if *count == 1 {
            first.clone()
        } else {
            later.clone()
        };
        Arc::new(Proc::of(fake(Some(answer_rewinds(answers)))))
    })
}

#[tokio::test(start_paused = true)]
async fn the_conversation_one_control_request_to_the_process_no_restart() {
    let context = setup(Setup {
        make: Some(with_rewinds((None, None))),
        ..Setup::default()
    });
    context.start_turn("hi").await;
    context.proc().fake.push(result_line());
    settle().await;
    let result = context
        .session
        .rewind("u2", Some("u3"), "conversation", false)
        .await
        .unwrap();
    assert_eq!(result, json!({"ok": true, "prefill": "the message"}));
    assert_eq!(context.spawner.count(), 1);
    assert!(!context.proc().fake.ended());
    assert!(
        context
            .events()
            .contains(&json!({"type": "rewound", "uuid": "u2"}))
    );
    assert_eq!(
        rewind_requests(&context.proc().fake),
        vec![
            json!({"subtype": "rewind_conversation", "target_message_uuid": "u2", "last_seen_user_message_uuid": "u3"})
        ]
    );
}

#[tokio::test(start_paused = true)]
async fn code_and_conversation_the_code_is_checked_the_conversation_cut_then_the_code_restored() {
    let context = setup(Setup {
        make: Some(with_rewinds((None, None))),
        ..Setup::default()
    });
    let result = context
        .session
        .rewind("u2", None, "both", false)
        .await
        .unwrap();
    assert_eq!(
        result,
        json!({"ok": true, "prefill": "the message", "files": ["/work/a.txt"], "code": "restored"})
    );
    assert_eq!(context.spawner.count(), 1);
    assert_eq!(
        rewind_requests(&context.proc().fake),
        vec![
            json!({"subtype": "rewind_files", "user_message_id": "u2", "dry_run": true}),
            json!({"subtype": "rewind_conversation", "target_message_uuid": "u2"}),
            json!({"subtype": "rewind_files", "user_message_id": "u2"}),
        ]
    );
}

#[tokio::test(start_paused = true)]
async fn the_code_only_leaves_the_conversation_alone() {
    let context = setup(Setup {
        make: Some(with_rewinds((None, None))),
        ..Setup::default()
    });
    assert_eq!(
        context
            .session
            .rewind("u2", None, "code", false)
            .await
            .unwrap(),
        json!({"ok": true, "files": ["/work/a.txt"], "code": "restored"})
    );
    let subtypes: Vec<Value> = rewind_requests(&context.proc().fake)
        .into_iter()
        .map(|r| r["subtype"].clone())
        .collect();
    assert_eq!(subtypes, vec![json!("rewind_files"), json!("rewind_files")]);
    assert!(context.of_type("rewound").is_empty());
}

#[tokio::test(start_paused = true)]
async fn a_process_without_checkpoints_is_replaced_by_one_that_has_them() {
    let context = setup(Setup {
        make: Some(counted((not_enabled(), None), (None, None))),
        ..Setup::default()
    });
    context.session.warm().await.unwrap();
    let result = context
        .session
        .rewind("u2", None, "both", false)
        .await
        .unwrap();
    assert_eq!(result["ok"], true);
    assert_eq!(context.spawner.count(), 2);
    let first = context.spawner.nth(0);
    assert!(first.fake.ended());
    assert!(!first.fake.alive());
    assert_eq!(rewind_requests(&first.fake).len(), 1);
    assert_eq!(rewind_requests(&context.proc().fake).len(), 3);
}

#[tokio::test(start_paused = true)]
async fn no_checkpoint_of_the_code_nothing_is_rewound() {
    let context = setup(Setup {
        make: Some(with_rewinds((
            Some(
                json!({"canRewind": false, "error": "No file checkpoint found for this message."}),
            ),
            None,
        ))),
        ..Setup::default()
    });
    assert_eq!(
        context
            .session
            .rewind("u2", None, "both", false)
            .await
            .unwrap(),
        json!({"ok": false, "no_checkpoint": true,
            "reason": "Claude Code has no code checkpoint for these changes (made before checkpoints were on)"})
    );
    assert_eq!(rewind_requests(&context.proc().fake).len(), 1);
}

fn transcript(checkpoints: &[&str]) -> String {
    let line = |value: Value| roamgate_agents::js::stringify(&value);
    let prompt = |uuid: &str, parent: Value| {
        line(json!({"type": "user", "uuid": uuid, "parentUuid": parent,
            "message": {"role": "user", "content": format!("message {uuid}")}}))
    };
    let tool = |uuid: &str, parent: &str, name: &str, input: Value| {
        line(
            json!({"type": "assistant", "uuid": uuid, "parentUuid": parent,
            "message": {"role": "assistant", "content": [{"type": "tool_use", "id": format!("t-{uuid}"), "name": name, "input": input}]}}),
        )
    };
    let mut lines: Vec<String> = checkpoints
        .iter()
        .map(|id| {
            line(json!({"type": "file-history-snapshot", "messageId": id,
                "snapshot": {"messageId": id, "trackedFileBackups": {}}, "isSnapshotUpdate": false}))
        })
        .collect();
    lines.extend([
        prompt("u1", Value::Null),
        tool("a1", "u1", "Edit", json!({"file_path": "/work/a.txt"})),
        tool("a2", "a1", "Write", json!({"file_path": "/work/b.txt"})),
        prompt("u2", json!("a2")),
        tool("a3", "u2", "Bash", json!({"command": "rm -rf build"})),
        prompt("u3", json!("a3")),
        tool("a4", "u3", "Bash", json!({"command": "ls"})),
    ]);
    lines.join("\n")
}

fn reads(text: String) -> Option<ReadTranscript> {
    Some(Arc::new(move || Ok(Some(Transcript::Text(text.clone())))))
}

#[tokio::test(start_paused = true)]
async fn nothing_edited_after_the_message_the_conversation_alone_no_restart() {
    let context = setup(Setup {
        make: Some(with_rewinds((not_enabled(), None))),
        transcript: reads(transcript(&[])),
        ..Setup::default()
    });
    context.session.warm().await.unwrap();
    assert_eq!(
        context
            .session
            .rewind("u2", None, "both", false)
            .await
            .unwrap(),
        json!({"ok": true, "prefill": "the message", "code": "none"})
    );
    assert_eq!(context.spawner.count(), 1);
    assert!(!context.proc().fake.ended());
    assert_eq!(
        rewind_requests(&context.proc().fake),
        vec![
            json!({"subtype": "rewind_files", "user_message_id": "u2", "dry_run": true}),
            json!({"subtype": "rewind_conversation", "target_message_uuid": "u2"}),
        ]
    );
    assert_eq!(
        context
            .session
            .rewind("u2", None, "code", false)
            .await
            .unwrap(),
        json!({"ok": true, "code": "none"})
    );
    assert_eq!(context.spawner.count(), 1);
}

#[tokio::test(start_paused = true)]
async fn edits_with_no_checkpoint_refused_with_the_files_no_restart_nothing_rewound() {
    let context = setup(Setup {
        make: Some(with_rewinds((not_enabled(), None))),
        transcript: reads(transcript(&["u2", "u3"])),
        ..Setup::default()
    });
    context.session.warm().await.unwrap();
    assert_eq!(
        context
            .session
            .rewind("u1", None, "both", false)
            .await
            .unwrap(),
        json!({"ok": false, "no_checkpoint": true,
            "reason": "Claude Code has no code checkpoint for these changes (made before checkpoints were on)",
            "files": ["/work/a.txt", "/work/b.txt"]})
    );
    assert_eq!(context.spawner.count(), 1);
    assert_eq!(rewind_requests(&context.proc().fake).len(), 1);
}

#[tokio::test(start_paused = true)]
async fn edits_whose_checkpoint_the_new_process_lacks_refused_with_the_files() {
    let context = setup(Setup {
        make: Some(with_rewinds((
            Some(
                json!({"canRewind": false, "error": "No file checkpoint found for this message."}),
            ),
            None,
        ))),
        transcript: reads(transcript(&["u1"])),
        ..Setup::default()
    });
    let result = context
        .session
        .rewind("u1", None, "both", false)
        .await
        .unwrap();
    assert_eq!(result["ok"], false);
    assert_eq!(result["no_checkpoint"], true);
    assert_eq!(result["files"], json!(["/work/a.txt", "/work/b.txt"]));
    assert_eq!(rewind_requests(&context.proc().fake).len(), 1);
}

#[tokio::test(start_paused = true)]
async fn edits_with_a_checkpoint_the_old_process_restarts_once_the_code_is_restored() {
    let context = setup(Setup {
        make: Some(counted((not_enabled(), None), (None, None))),
        transcript: reads(transcript(&["u1"])),
        ..Setup::default()
    });
    context.session.warm().await.unwrap();
    assert_eq!(
        context
            .session
            .rewind("u1", None, "both", false)
            .await
            .unwrap(),
        json!({"ok": true, "prefill": "the message", "files": ["/work/a.txt"], "code": "restored"})
    );
    assert_eq!(context.spawner.count(), 2);
    assert_eq!(rewind_requests(&context.proc().fake).len(), 3);
}

#[tokio::test(start_paused = true)]
async fn an_unreadable_transcript_the_dry_run_decides_as_before() {
    let context = setup(Setup {
        make: Some(counted((not_enabled(), None), (None, None))),
        transcript: Some(Arc::new(|| Err("gone".into()))),
        ..Setup::default()
    });
    context.session.warm().await.unwrap();
    assert_eq!(
        context
            .session
            .rewind("u2", None, "both", false)
            .await
            .unwrap()["ok"],
        true
    );
    assert_eq!(context.spawner.count(), 2);
}

#[tokio::test(start_paused = true)]
async fn the_check_from_the_transcript_alone_nothing_started() {
    let context = setup(Setup {
        make: Some(with_rewinds((None, None))),
        transcript: reads(transcript(&["u1"])),
        ..Setup::default()
    });
    assert_eq!(
        context.session.rewind_check("u2").await,
        json!({"code": "none"})
    );
    assert_eq!(
        context.session.rewind_check("u3").await,
        json!({"code": "none"})
    );
    assert_eq!(
        context.session.rewind_check("u1").await,
        json!({"code": "restorable", "files": ["/work/a.txt", "/work/b.txt"]})
    );
    assert_eq!(
        context.session.rewind_check("u9").await,
        json!({"code": "unknown"})
    );
    assert_eq!(context.spawner.count(), 0);
    let before = setup(Setup {
        transcript: reads(transcript(&[])),
        ..Setup::default()
    });
    assert_eq!(
        before.session.rewind_check("u1").await,
        json!({"code": "no_checkpoint", "files": ["/work/a.txt", "/work/b.txt"]})
    );
}

#[tokio::test(start_paused = true)]
async fn claude_code_s_refusal_is_said_and_the_code_is_left_alone() {
    let context = setup(Setup {
        make: Some(with_rewinds((
            None,
            Some(json!({"rewound": false, "error": "stale target", "reason": "stale_target"})),
        ))),
        ..Setup::default()
    });
    let result = context
        .session
        .rewind("u2", None, "both", false)
        .await
        .unwrap();
    assert_eq!(result["ok"], false);
    assert!(result["reason"].as_str().unwrap().contains("moved on"));
    let dry: Vec<bool> = rewind_requests(&context.proc().fake)
        .iter()
        .map(|r| r["dry_run"].as_bool().unwrap_or(false))
        .collect();
    assert_eq!(dry, vec![true, false]);
}

#[tokio::test(start_paused = true)]
async fn refused_while_a_turn_runs_unless_it_is_interrupted_first() {
    let context = setup(Setup {
        make: Some(with_rewinds((None, None))),
        ..Setup::default()
    });
    context.start_turn("hi").await;
    assert_eq!(
        context
            .session
            .rewind("u1", None, "conversation", false)
            .await
            .unwrap(),
        json!({"ok": false, "reason": "A turn is running; stop it first"})
    );
    assert!(rewind_requests(&context.proc().fake).is_empty());
    let result = context
        .session
        .rewind("u1", None, "conversation", true)
        .await
        .unwrap();
    assert_eq!(result["ok"], true);
    let subtypes: Vec<Value> = rewind_requests(&context.proc().fake)
        .into_iter()
        .map(|r| r["subtype"].clone())
        .collect();
    assert_eq!(
        subtypes,
        vec![json!("interrupt"), json!("rewind_conversation")]
    );
}

#[tokio::test(start_paused = true)]
async fn refused_while_messages_wait_in_the_queue() {
    let context = setup(Setup {
        make: Some(with_rewinds((None, None))),
        ..Setup::default()
    });
    context.start_turn("hi").await;
    context
        .session
        .send("later", Vec::new(), None)
        .await
        .unwrap();
    assert_eq!(context.session.queue_length(), 1);
    let result = context
        .session
        .rewind("u1", None, "conversation", true)
        .await
        .unwrap();
    assert_eq!(result["ok"], false);
    assert!(result["reason"].as_str().unwrap().contains("queue"));
    assert!(rewind_requests(&context.proc().fake).is_empty());
}

#[tokio::test(start_paused = true)]
async fn a_message_sent_during_a_rewind_waits_for_it_then_goes() {
    let context = setup(Setup {
        make: Some(Box::new(|| Arc::new(Proc::of(fake(None))))),
        ..Setup::default()
    });
    context.session.warm().await.unwrap();
    let session = context.session.clone();
    let rewound =
        tokio::spawn(async move { session.rewind("u1", None, "conversation", false).await });
    settle().await;
    assert!(context.session.busy());
    assert_eq!(
        context
            .session
            .send("next", Vec::new(), None)
            .await
            .unwrap()
            .0,
        "queued"
    );
    assert!(context.users().is_empty());
    // Claude answers the rewind now.
    let request = context
        .proc()
        .fake
        .written()
        .into_iter()
        .find(|m| m["request"]["subtype"] == "rewind_conversation")
        .unwrap();
    context
        .proc()
        .fake
        .push(json!({"type": "control_response", "response": {
            "subtype": "success", "request_id": request["request_id"],
            "response": {"rewound": true, "targetMessageUuid": "u1", "prefillText": "the message"},
        }}));
    assert_eq!(rewound.await.unwrap().unwrap()["ok"], true);
    settle().await;
    assert_eq!(context.users().len(), 1);
}

#[tokio::test(start_paused = true)]
async fn no_answer_from_claude_the_rewind_fails_the_process_stays() {
    let context = setup(Setup {
        make: Some(Box::new(|| Arc::new(Proc::of(fake(None))))),
        rewind_wait_ms: Some(20),
        ..Setup::default()
    });
    context.session.warm().await.unwrap();
    assert_eq!(
        context
            .session
            .rewind("u1", None, "conversation", false)
            .await
            .unwrap(),
        json!({"ok": false, "reason": "Claude did not answer"})
    );
    assert!(!context.session.busy());
    assert!(!context.proc().fake.ended());
}

// ------------------------------------------------------------ reading again

fn running(respond: bool) -> Arc<FakeClaude> {
    if respond {
        fake(Some(Box::new(answer_interrupts)))
    } else {
        fake(None)
    }
}

fn input(seq: u64, kind: &str) -> Value {
    json!({"type": "roamgate_input", "seq": seq, "child": 1, "kind": kind})
}

#[tokio::test(start_paused = true)]
async fn rebuilds_the_turn_from_the_replayed_head_asks_open_prompts_once() {
    let context = setup(Setup::default());
    let fake = running(true);
    fake.push(input(1, "user"));
    fake.push(stream(
        json!({"type": "message_start", "message": {"id": "m1"}}),
    ));
    fake.push(stream(json!({"type": "content_block_start", "index": 0, "content_block": {"type": "text", "text": ""}})));
    fake.push(text_delta("Half a reply"));
    fake.push(permission("old"));
    fake.push(json!({"type": "roamgate_input", "seq": 2, "child": 1, "kind": "control_response", "request_id": "old"}));
    fake.push(permission("open"));
    let mut proc = Proc::of(fake.clone());
    proc.replayed = 6;
    context
        .spawner
        .running
        .lock()
        .unwrap()
        .push_back(Arc::new(proc));
    assert!(context.session.attach().await.unwrap());
    settle().await;
    assert_eq!(context.spawner.count(), 0);
    assert!(context.of_type("delta").is_empty());
    assert_eq!(
        Value::from(
            context
                .session
                .streamed()
                .into_iter()
                .map(Value::Object)
                .collect::<Vec<_>>()
        ),
        json!([{"message_id": "m1", "index": 0, "text": "Half a reply", "done": false}])
    );
    assert_eq!(context.prompt_inputs(), vec![json!({"command": "open"})]);
    let written = fake.written();
    assert_eq!(written.len(), 1);
    assert_eq!(written[0]["type"], "control_response");
    assert_eq!(written[0]["response"]["request_id"], "open");
    assert!(context.session.busy());
    fake.push(result_line());
    settle().await;
    assert_eq!(context.state()["status"], "idle");
}

#[tokio::test(start_paused = true)]
async fn takes_up_a_saved_state_and_reads_only_the_lines_after_it() {
    let before = setup(Setup {
        answer: Some(never_answered()),
        ..Setup::default()
    });
    let first = running(false);
    let mut proc = Proc::of(first.clone());
    proc.position = Some(HolderPosition {
        child: 1,
        epoch_offset: 0,
        offset: 900,
    });
    before
        .spawner
        .running
        .lock()
        .unwrap()
        .push_back(Arc::new(proc));
    assert!(before.session.attach().await.unwrap());
    first.push(input(1, "user"));
    first.push(stream(
        json!({"type": "message_start", "message": {"id": "m1"}}),
    ));
    first.push(stream(json!({"type": "content_block_start", "index": 0, "content_block": {"type": "text", "text": ""}})));
    first.push(text_delta("Half a reply"));
    first.push(permission("open"));
    settle().await;
    assert_eq!(before.prompts.lock().unwrap().len(), 1);
    let ResumeState::Saved { position, state } = before.session.resume_state() else {
        panic!("no state saved");
    };
    assert_eq!(
        position,
        HolderPosition {
            child: 1,
            epoch_offset: 0,
            offset: 900
        }
    );
    // A save is plain JSON (it goes on the lease).
    let state: Value =
        serde_json::from_str(&roamgate_agents::js::stringify(&Value::Object(state))).unwrap();
    before.session.dispose(true);

    let context = setup(Setup {
        coalesce_ms: Some(0),
        ..Setup::default()
    });
    let fake = running(true);
    let mut proc = Proc::of(fake.clone());
    proc.resume = Some(state);
    fake.push(text_delta(" and more"));
    context
        .spawner
        .running
        .lock()
        .unwrap()
        .push_back(Arc::new(proc));
    assert!(context.session.attach().await.unwrap());
    tokio::time::sleep(Duration::from_millis(5)).await;
    settle().await;
    assert!(context.session.busy());
    assert_eq!(
        Value::from(
            context
                .session
                .streamed()
                .into_iter()
                .map(Value::Object)
                .collect::<Vec<_>>()
        ),
        json!([{"message_id": "m1", "index": 0, "text": "Half a reply and more", "done": false}])
    );
    let deltas: Vec<Value> = context
        .of_type("delta")
        .iter()
        .map(|e| e["text"].clone())
        .collect();
    assert_eq!(deltas, vec![json!(" and more")]);
    assert_eq!(context.prompt_inputs(), vec![json!({"command": "open"})]);
    fake.push(result_line());
    settle().await;
    assert_eq!(context.state()["status"], "idle");
}

#[tokio::test(start_paused = true)]
async fn gives_no_state_to_save_while_it_replays_none_without_a_process() {
    let context = setup(Setup::default());
    assert_eq!(context.session.resume_state(), ResumeState::None);
    let fake = running(false);
    let mut proc = Proc::of(fake.clone());
    proc.replayed = 2;
    proc.position = Some(HolderPosition {
        child: 1,
        epoch_offset: 0,
        offset: 9,
    });
    fake.push(input(1, "user"));
    context
        .spawner
        .running
        .lock()
        .unwrap()
        .push_back(Arc::new(proc));
    let session = context.session.clone();
    let attaching = tokio::spawn(async move { session.attach().await });
    tokio::task::yield_now().await;
    assert_eq!(context.session.resume_state(), ResumeState::Unknown);
    fake.push(json!({"type": "system", "subtype": "status", "status": "requesting"}));
    assert!(attaching.await.unwrap().unwrap());
    settle().await;
    let ResumeState::Saved { state, .. } = context.session.resume_state() else {
        panic!("no state");
    };
    assert_eq!(state["turn"], true);
    fake.exit(0);
    settle().await;
    assert_eq!(context.session.resume_state(), ResumeState::None);
}

#[tokio::test(start_paused = true)]
async fn a_turn_replayed_to_its_end_sends_nothing_queued_until_it_is_live() {
    let context = setup(Setup {
        queue: vec![carried("q1", "next")],
        ..Setup::default()
    });
    let fake = running(true);
    fake.push(input(1, "user"));
    fake.push(result_line());
    fake.push(input(2, "user"));
    fake.push(json!({"type": "system", "subtype": "status", "status": "requesting"}));
    let mut proc = Proc::of(fake.clone());
    proc.replayed = 3;
    context
        .spawner
        .running
        .lock()
        .unwrap()
        .push_back(Arc::new(proc));
    context.session.attach().await.unwrap();
    settle().await;
    assert!(fake.written().is_empty());
    assert_eq!(context.session.queue_length(), 1);
    fake.push(result_line());
    settle().await;
    let written = fake.written();
    assert_eq!(written.len(), 1);
    assert_eq!(
        written[0]["message"],
        json!({"role": "user", "content": "next"})
    );
}

#[tokio::test(start_paused = true)]
async fn leaving_it_detached_keeps_the_process() {
    let context = setup(Setup::default());
    let fake = running(false);
    let proc = Arc::new(Proc::of(fake.clone()));
    context
        .spawner
        .running
        .lock()
        .unwrap()
        .push_back(proc.clone());
    context.session.attach().await.unwrap();
    context.session.dispose(true);
    assert!(*proc.detached.lock().unwrap());
    assert!(!fake.ended());
    assert!(!fake.killed());
}

#[tokio::test(start_paused = true)]
async fn attach_resolves_only_once_the_lines_that_were_in_are_handled() {
    let context = setup(Setup {
        queue: vec![carried("q1", "next")],
        ..Setup::default()
    });
    let fake = running(true);
    fake.push(input(1, "user"));
    fake.push(stream(
        json!({"type": "message_start", "message": {"id": "m1"}}),
    ));
    fake.push(stream(json!({"type": "content_block_start", "index": 0, "content_block": {"type": "text", "text": ""}})));
    for _ in 0..300 {
        fake.push(text_delta("."));
    }
    fake.push(json!({"type": "system", "subtype": "task_started", "task_id": "t1"}));
    let mut proc = Proc::of(fake.clone());
    proc.replayed = 304;
    proc.catch_up = 304;
    context
        .spawner
        .running
        .lock()
        .unwrap()
        .push_back(Arc::new(proc));
    assert!(context.session.attach().await.unwrap());
    assert!(context.session.busy());
    assert_eq!(context.session.background_tasks(), 1);
    assert!(fake.written().is_empty());
    assert_eq!(context.session.queue_length(), 1);
}

#[tokio::test(start_paused = true)]
async fn prompts_answered_in_the_lines_read_on_are_not_asked_again() {
    let context = setup(Setup::default());
    let fake = running(true);
    fake.push(input(1, "user"));
    fake.push(permission("answered"));
    fake.push(json!({"type": "roamgate_input", "seq": 2, "child": 1, "kind": "control_response", "request_id": "answered"}));
    let mut proc = Proc::of(fake.clone());
    proc.replayed = 1;
    proc.catch_up = 3;
    context
        .spawner
        .running
        .lock()
        .unwrap()
        .push_back(Arc::new(proc));
    assert!(context.session.attach().await.unwrap());
    settle().await;
    assert!(context.prompts.lock().unwrap().is_empty());
    fake.push(permission("live"));
    settle().await;
    assert_eq!(context.prompt_inputs(), vec![json!({"command": "live"})]);
}

#[tokio::test(start_paused = true)]
async fn a_prompt_another_runtime_answered_goes_when_its_note_comes_in() {
    let context = setup(Setup {
        answer: Some(never_answered()),
        ..Setup::default()
    });
    let fake = running(true);
    fake.push(input(1, "user"));
    fake.push(permission("late"));
    let mut proc = Proc::of(fake.clone());
    proc.replayed = 2;
    proc.catch_up = 2;
    context
        .spawner
        .running
        .lock()
        .unwrap()
        .push_back(Arc::new(proc));
    context.session.attach().await.unwrap();
    settle().await;
    assert_eq!(context.prompts.lock().unwrap().len(), 1);
    assert_eq!(context.state()["status"], "blocked");
    fake.push(json!({"type": "roamgate_input", "seq": 2, "child": 1, "kind": "control_response", "request_id": "late"}));
    settle().await;
    assert!(context.prompts.lock().unwrap()[0].signal.is_cancelled());
    assert!(fake.written().is_empty());
    assert_eq!(context.state()["status"], "working");
}

#[tokio::test(start_paused = true)]
async fn a_message_another_runtime_sent_starts_a_turn_here() {
    let context = setup(Setup::default());
    let fake = running(true);
    context
        .spawner
        .running
        .lock()
        .unwrap()
        .push_back(Arc::new(Proc::of(fake.clone())));
    context.session.attach().await.unwrap();
    assert!(!context.session.busy());
    fake.push(input(4, "user"));
    settle().await;
    assert!(context.session.busy());
    assert_eq!(
        context
            .session
            .send("later", Vec::new(), None)
            .await
            .unwrap()
            .0,
        "queued"
    );
    assert!(fake.written().is_empty());
}

#[tokio::test(start_paused = true)]
async fn nothing_running_no_process_is_started_by_an_attach() {
    let context = setup(Setup::default());
    assert!(!context.session.attach().await.unwrap());
    assert_eq!(context.spawner.count(), 0);
    assert_eq!(context.state()["status"], "stopped");
}

// ------------------------------------------------------------ what Herdr hears

fn finished_turns(count: u64) -> (Arc<FakeClaude>, Proc) {
    let fake = running(true);
    for seq in 1..=count {
        fake.push(input(seq, "user"));
        fake.push(result_line());
    }
    let mut proc = Proc::of(fake.clone());
    proc.replayed = (count * 2) as usize;
    proc.catch_up = (count * 2) as usize;
    (fake, proc)
}

#[tokio::test(start_paused = true)]
async fn a_turn_that_finished_before_the_restart_is_not_reported_again() {
    let context = setup(Setup::default());
    let (_, proc) = finished_turns(2);
    context
        .spawner
        .running
        .lock()
        .unwrap()
        .push_back(Arc::new(proc));
    assert!(context.session.attach().await.unwrap());
    settle().await;
    assert_eq!(*context.reported.lock().unwrap(), vec!["idle".to_owned()]);
}

#[tokio::test(start_paused = true)]
async fn a_turn_that_finishes_after_the_restart_is_reported_once() {
    let context = setup(Setup::default());
    let (fake, proc) = finished_turns(1);
    context
        .spawner
        .running
        .lock()
        .unwrap()
        .push_back(Arc::new(proc));
    context.session.attach().await.unwrap();
    settle().await;
    fake.push(input(2, "user"));
    settle().await;
    fake.push(result_line());
    settle().await;
    assert_eq!(
        *context.reported.lock().unwrap(),
        vec!["idle", "working", "idle"]
    );
}

#[tokio::test(start_paused = true)]
async fn reading_it_again_a_reconnect_does_not_report_that_turn_again() {
    let before = setup(Setup::default());
    let (fake, proc) = finished_turns(1);
    before
        .spawner
        .running
        .lock()
        .unwrap()
        .push_back(Arc::new(proc));
    before.session.attach().await.unwrap();
    settle().await;
    fake.push(input(2, "user"));
    fake.push(result_line());
    settle().await;
    before.session.dispose(true);
    assert_eq!(
        *before.reported.lock().unwrap(),
        vec!["idle", "working", "idle"]
    );
    let after = setup(Setup::default());
    let (_, proc) = finished_turns(2);
    after
        .spawner
        .running
        .lock()
        .unwrap()
        .push_back(Arc::new(proc));
    after.session.attach().await.unwrap();
    settle().await;
    assert_eq!(*after.reported.lock().unwrap(), vec!["idle".to_owned()]);
}

#[tokio::test(start_paused = true)]
async fn a_process_with_nothing_to_replay_is_reported_idle() {
    let context = setup(Setup::default());
    let (_, proc) = finished_turns(0);
    context
        .spawner
        .running
        .lock()
        .unwrap()
        .push_back(Arc::new(proc));
    assert!(context.session.attach().await.unwrap());
    settle().await;
    assert_eq!(*context.reported.lock().unwrap(), vec!["idle".to_owned()]);
}

#[tokio::test(start_paused = true)]
async fn a_turn_the_replay_ends_in_is_reported_as_working() {
    let context = setup(Setup::default());
    let (fake, mut proc) = finished_turns(1);
    fake.push(input(2, "user"));
    proc.replayed = 3;
    proc.catch_up = 3;
    context
        .spawner
        .running
        .lock()
        .unwrap()
        .push_back(Arc::new(proc));
    context.session.attach().await.unwrap();
    settle().await;
    assert_eq!(
        *context.reported.lock().unwrap(),
        vec!["working".to_owned()]
    );
    fake.push(result_line());
    settle().await;
    assert_eq!(*context.reported.lock().unwrap(), vec!["working", "idle"]);
}

// ------------------------------------------------------------ next prompt

fn suggestion() -> Value {
    json!({"type": "prompt_suggestion", "suggestion": "run the tests", "uuid": "g-1", "session_id": "s1"})
}

#[tokio::test(start_paused = true)]
async fn offered_after_a_turn_and_gone_when_the_next_one_starts() {
    let context = setup(Setup::default());
    context.start_turn("hi").await;
    context.proc().fake.push(result_line());
    context.proc().fake.push(suggestion());
    settle().await;
    assert_eq!(
        context.state()["next_prompt"],
        json!({"uuid": "g-1", "text": "run the tests"})
    );
    context.start_turn("something else").await;
    assert_eq!(context.state()["next_prompt"], Value::Null);
    let offered: Vec<Value> = context
        .of_type("next_prompt")
        .iter()
        .map(|e| e["next_prompt"].clone())
        .collect();
    assert_eq!(
        offered,
        vec![json!({"uuid": "g-1", "text": "run the tests"}), Value::Null]
    );
}

#[tokio::test(start_paused = true)]
async fn dropped_when_it_comes_while_a_turn_runs() {
    let context = setup(Setup::default());
    context.start_turn("hi").await;
    context.proc().fake.push(suggestion());
    settle().await;
    assert_eq!(context.state()["next_prompt"], Value::Null);
    assert!(context.of_type("next_prompt").is_empty());
}

#[tokio::test(start_paused = true)]
async fn gone_when_the_turn_starts_from_elsewhere_a_replayed_message() {
    let context = setup(Setup::default());
    context.start_turn("hi").await;
    context.proc().fake.push(result_line());
    context.proc().fake.push(suggestion());
    context.proc().fake.push(json!({"type": "user", "message": {"role": "user", "content": "from the phone"}, "uuid": "u-9", "isReplay": true}));
    settle().await;
    assert_eq!(context.state()["next_prompt"], Value::Null);
}
