//! Test doubles for conversation mode (`testing.ts`): a Herdr that knows
//! one pane with an idle Claude, a stand-in headless process, a spawner,
//! the screens Claude's TUI draws, and a test driver that reads them. The
//! test driver is a double of Claude's drivers (`roamgate-claude` has the
//! real ones): it reads these screens and `ps` lines as Claude's do, no
//! more. Public so the service's tests use the same doubles.

use std::collections::{HashSet, VecDeque};
use std::sync::{Arc, LazyLock, Mutex};

use regex::Regex;
use roamgate_agents::js;
use serde_json::{Value, json};
use tokio::sync::{Notify, watch};

use crate::driver::{
    BackgroundMemoryLaunch, BoxFuture, CompanionMemoryDriver, ConversationDriver, DriverCodec,
    DriverEvent, DriverMessage, DriverPrompt, Drivers, HeadlessProcess, InputKind, Object,
    PaneProcess, ProtocolDriver, StartOptions, TerminalDriver, TerminalReadiness, WrittenMessage,
};
use crate::headless::{HeadlessSpawnOptions, SpawnHeadless};
use crate::herdr::{AgentReport, ConversationHerdr, HerdrResult, PaneProcessInfo, WriterElsewhere};
use crate::shared::Obj;

/// Lets queued tasks run, without timers.
pub async fn settle() {
    for _ in 0..30 {
        tokio::task::yield_now().await;
    }
}

// ------------------------------------------------------------ the driver

/// What the holder notes of a line Claude is written (Claude's
/// `inputKind`).
pub fn claude_input_kind(text: &str) -> InputKind {
    let other = InputKind {
        kind: "other".into(),
        request_id: None,
    };
    let Some(Value::Object(value)) = js::parse(text) else {
        return other;
    };
    match value.get("type").and_then(Value::as_str) {
        Some("user") => InputKind {
            kind: "user".into(),
            request_id: None,
        },
        Some("control_response") => InputKind {
            kind: "control_response".into(),
            request_id: value
                .get("response")
                .and_then(|response| response.get("request_id"))
                .and_then(Value::as_str)
                .map(str::to_owned),
        },
        Some("control_request") => InputKind {
            kind: "control_request".into(),
            request_id: None,
        },
        _ => other,
    }
}

static ESCAPE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"\x1b(?:\[[0-9;:?]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[@-Z\\-_])").unwrap()
});
static RULE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^\s*[─━═╭╮╯╰└┘┌┐]{3,}").unwrap());
static PROMPT: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^\s*[│┃|]?\s*❯").unwrap());
static WORK: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)(?:^|\s)(\d+)\s+(shells?|bash(?:es)?|background tasks?|tasks?|monitors?|(?:local |background )?agents? running)(?:\s+(?:still\s+)?running)?\s*$").unwrap()
});
static CUT: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^([1-9]\d*)(?:\s+\S*…)?$").unwrap());
static STAY: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?im)(?:^|[\s❯>])(\d)\.\s*Stay\s*$").unwrap());
static RESUMED: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?:--resume|-r)(?:=|['\x22\s]+)([\w-]+)").unwrap());

fn plain(line: &str) -> String {
    ESCAPE.replace_all(line, "").into_owned()
}

/// The background work the footer under the prompt box shows, and
/// whether its silence counts (a pane under 60 columns cuts it).
pub fn test_footer(screen: &str) -> (Option<String>, bool) {
    let lines: Vec<String> = screen.split('\n').map(plain).collect();
    let after: Vec<&String> = match lines.iter().rposition(|line| PROMPT.is_match(line)) {
        Some(at) => lines[at + 1..].iter().collect(),
        None => Vec::new(),
    };
    let width = after
        .iter()
        .find(|line| RULE.is_match(line))
        .map(|rule| rule.trim().chars().count())
        .unwrap_or(0);
    let mut found = Vec::new();
    let mut cut = 0;
    for line in &after {
        for raw in line.split(" · ") {
            let part = raw.trim().trim_end_matches(" ·").trim();
            if let Some(work) = WORK.captures(part)
                && work[1].parse::<u32>().unwrap_or(0) > 0
            {
                found.push(format!("{} {}", &work[1], work[2].to_lowercase()));
            } else if let Some(count) = CUT.captures(part) {
                cut += count[1].parse::<u32>().unwrap_or(0);
            }
        }
    }
    if !found.is_empty() {
        return (Some(found.join(", ")), true);
    }
    if cut > 0 {
        let tasks = if cut == 1 { "task" } else { "tasks" };
        return (Some(format!("{cut} background {tasks}")), true);
    }
    (None, width >= 60)
}

fn exit_dialog(screen: &str) -> Option<String> {
    let screen: String = screen.split('\n').map(plain).collect::<Vec<_>>().join("\n");
    if !screen.contains("Background work is running") && !screen.contains("Exit and stop tasks") {
        return None;
    }
    Some(
        STAY.captures(&screen)
            .map(|stay| stay[1].to_owned())
            .unwrap_or_else(|| "\x1b".into()),
    )
}

/// The prompt box: "empty", "draft" or "missing", and the vim mode.
fn prompt_state(screen: &str) -> (&'static str, &'static str) {
    let lines: Vec<String> = screen.split('\n').map(plain).collect();
    let joined = lines.join("\n");
    let vim = if joined.contains("-- INSERT --") {
        "insert"
    } else if joined.contains("-- NORMAL --") {
        "normal"
    } else {
        "none"
    };
    let Some(at) = lines.iter().rposition(|line| PROMPT.is_match(line)) else {
        return ("missing", vim);
    };
    let first = PROMPT.replace(&lines[at], "");
    if !first
        .trim_matches(|c: char| c.is_whitespace() || c == '│')
        .is_empty()
    {
        return ("draft", vim);
    }
    for line in &lines[at + 1..] {
        if RULE.is_match(line) {
            break;
        }
        if !line.trim().is_empty() {
            return ("draft", vim);
        }
    }
    ("empty", vim)
}

/// A test double of Claude's terminal driver.
#[derive(Clone, Copy, Debug, Default)]
pub struct TestTerminal;

/// Claude's terminal side, as the test driver gives it.
pub fn claude_terminal() -> TestTerminal {
    TestTerminal
}

fn is_claude(process: &PaneProcess) -> bool {
    let mut parts: Vec<&str> = vec![process.argv0.as_deref().unwrap_or("")];
    parts.extend(process.argv.iter().flatten().map(String::as_str));
    if parts.contains(&"stream-json")
        || process
            .cmdline
            .as_deref()
            .unwrap_or("")
            .contains("stream-json")
    {
        return false;
    }
    parts
        .iter()
        .any(|part| *part == "claude" || part.ends_with("/claude"))
}

impl TerminalDriver for TestTerminal {
    fn agent(&self) -> &str {
        "claude"
    }
    fn herdr_agent(&self) -> &str {
        "claude"
    }
    fn display_name(&self) -> &str {
        "Claude"
    }
    fn is_agent_process(&self, process: &PaneProcess) -> bool {
        is_claude(process)
    }
    fn kept_flags(&self, process: &PaneProcess) -> Vec<String> {
        let argv = process.argv.clone().unwrap_or_default();
        let mut kept = Vec::new();
        let mut index = 1;
        while index < argv.len() {
            let arg = &argv[index];
            match arg.as_str() {
                "--model" | "--permission-mode" if index + 1 < argv.len() => {
                    kept.push(arg.clone());
                    kept.push(argv[index + 1].clone());
                    index += 1;
                }
                "--dangerously-skip-permissions" => kept.push(arg.clone()),
                _ if arg.starts_with("--permission-mode=") || arg.starts_with("--model=") => {
                    kept.push(arg.clone())
                }
                _ => {}
            }
            index += 1;
        }
        kept
    }
    fn readiness(&self, screen: &str) -> TerminalReadiness {
        let (work, readable) = test_footer(screen);
        let refusal = if exit_dialog(screen).is_some() {
            Some("Claude is asking whether to exit in the terminal".to_owned())
        } else {
            match prompt_state(screen) {
                ("missing", _) => Some("Claude's prompt box is not on screen".to_owned()),
                ("draft", _) => Some(
                    "Something is typed in Claude's prompt box; send or clear it first".to_owned(),
                ),
                (_, "normal") => Some(
                    "Claude's prompt is in vim normal mode; switch it to insert mode first"
                        .to_owned(),
                ),
                _ => None,
            }
        };
        TerminalReadiness {
            background: work,
            background_known: readable,
            refusal,
        }
    }
    fn exit_command(&self) -> &str {
        "/exit"
    }
    fn exit_dialog(&self, screen: &str) -> Option<String> {
        exit_dialog(screen)
    }
    fn background_work(&self, screen: &str) -> Option<String> {
        test_footer(screen).0
    }
    fn resume_argv(&self, session_id: &str, flags: &[String]) -> Vec<String> {
        let mut argv = vec!["claude".to_owned()];
        argv.extend(flags.iter().cloned());
        argv.push("--resume".into());
        argv.push(session_id.into());
        argv
    }
    fn headless_probe(&self, ps: &str, session_ids: &[String]) -> bool {
        ps.split('\n').any(|line| {
            line.contains("stream-json")
                && RESUMED.captures_iter(line).any(|found| {
                    session_ids
                        .iter()
                        .any(|id| !id.is_empty() && *id == found[1])
                })
        })
    }
    fn interactive_writer(
        &self,
        ps: &str,
        session_ids: &[String],
        except_pids: &[u32],
    ) -> Option<u32> {
        for line in ps.split('\n') {
            let line = line.trim_start();
            let Some((pid, args)) = line.split_once(char::is_whitespace) else {
                continue;
            };
            let Ok(pid) = pid.parse::<u32>() else {
                continue;
            };
            if except_pids.contains(&pid) || args.contains("stream-json") {
                continue;
            }
            if !(args
                .split_whitespace()
                .any(|word| word == "claude" || word.ends_with("/claude"))
                || args.contains("claude-code"))
            {
                continue;
            }
            if RESUMED.captures_iter(args).any(|found| {
                session_ids
                    .iter()
                    .any(|id| !id.is_empty() && *id == found[1])
            }) {
                return Some(pid);
            }
        }
        None
    }
}

/// A test double of Claude's protocol driver: stream-json lines as they
/// come (`{kind: "line", line}`), messages as Claude's user lines.
#[derive(Clone, Copy, Debug, Default)]
pub struct TestProtocol;

struct TestCodec;

impl DriverCodec for TestCodec {
    fn line(&mut self, line: &str) -> Vec<DriverEvent> {
        let mut event = Object::new();
        event.insert("kind".into(), Value::from("line"));
        event.insert("line".into(), Value::from(line));
        vec![event]
    }
    fn save(&self) -> Value {
        Value::Null
    }
    fn restore(&mut self, _state: &Value) {}
    fn message(&mut self, message: &DriverMessage) -> Vec<String> {
        vec![js::stringify(&json!({
            "type": "user",
            "uuid": message.uuid,
            "message": {"role": "user", "content": message.text},
        }))]
    }
    fn interrupt(&mut self, request_id: &str) -> Vec<String> {
        vec![js::stringify(&json!({
            "type": "control_request",
            "request_id": request_id,
            "request": {"subtype": "interrupt"},
        }))]
    }
    fn answer(&mut self, _request: &DriverEvent, _answer: Option<&Value>) -> Vec<String> {
        Vec::new()
    }
    fn request(&mut self, _kind: &str, _params: &Object, _request_id: &str) -> Option<Vec<String>> {
        None
    }
}

impl ProtocolDriver for TestProtocol {
    fn agent(&self) -> &str {
        "claude"
    }
    fn display_name(&self) -> &str {
        "Claude"
    }
    fn capabilities(&self) -> Value {
        json!({})
    }
    fn start_command(&self, options: &StartOptions) -> Object {
        let mut command = Object::new();
        let mut argv = vec![Value::from(
            options
                .profile
                .as_ref()
                .map(|profile| profile.program.clone())
                .unwrap_or_else(|| "claude".into()),
        )];
        argv.extend(
            [
                "-p",
                "--resume",
                &options.session_id,
                "--input-format",
                "stream-json",
                "--output-format",
                "stream-json",
            ]
            .map(Value::from),
        );
        command.insert("argv".into(), Value::Array(argv));
        command.insert("cwd".into(), Value::from(options.cwd.clone()));
        command
    }
    fn create_codec(&self) -> Box<dyn DriverCodec> {
        Box::new(TestCodec)
    }
    fn prompt_of(&self, request: &DriverEvent) -> DriverPrompt {
        DriverPrompt {
            tool: request
                .get("tool_name")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_owned(),
            input: request.get("input").cloned().unwrap_or(Value::Null),
            can_always: false,
            questions: None,
        }
    }
    fn input_kind(&self, line: &str) -> InputKind {
        claude_input_kind(line)
    }
    fn answer_kind(&self) -> &str {
        "control_response"
    }
    fn parse_written_message(&self, line: &str) -> Option<WrittenMessage> {
        let Some(Value::Object(value)) = js::parse(line) else {
            return None;
        };
        let text = value.get("message")?.get("content")?.as_str()?.to_owned();
        Some(WrittenMessage {
            uuid: value.get("uuid").and_then(Value::as_str).map(str::to_owned),
            text,
        })
    }
}

struct TestMemory;

impl CompanionMemoryDriver for TestMemory {
    fn reader(&self, _dir: &str) -> Option<BackgroundMemoryLaunch> {
        None
    }
    fn writer(&self, dir: &str) -> BackgroundMemoryLaunch {
        BackgroundMemoryLaunch {
            args: vec!["--add-dir".into(), dir.into()],
            tools: String::new(),
            cwd: Some(dir.into()),
        }
    }
}

/// Claude's drivers, as the test doubles give them.
pub fn test_drivers() -> Drivers {
    Drivers::new(vec![ConversationDriver {
        protocol: Arc::new(TestProtocol),
        terminal: Arc::new(TestTerminal),
        memory: Arc::new(TestMemory),
    }])
}

// ------------------------------------------------------------ the screens

const RULE24: &str = "────────────────────────";

/// Claude idle at its prompt.
pub fn idle_screen() -> String {
    [
        "  some answer",
        RULE24,
        "❯ ",
        RULE24,
        "  -- INSERT -- ⏵⏵ auto mode on",
    ]
    .join("\n")
}

/// Claude idle at its prompt, a background shell still running.
pub fn background_screen() -> String {
    [
        "✻ Worked for 2m 54s · 1 shell still running",
        RULE24,
        "❯ ",
        RULE24,
        "  -- INSERT -- ⏵⏵ auto mode on · 1 shell · ← 18 agents",
    ]
    .join("\n")
}

/// A 38-column pane: the footer's "1 shell" lost its word.
pub fn narrow_screen() -> String {
    [
        "✻ Cooked for 4s · done 12:48 PM · 1".to_owned(),
        "  shell still running".to_owned(),
        String::new(),
        "─".repeat(38),
        "❯".to_owned(),
        "─".repeat(38),
        "  -- INSERT -- ⏵⏵ auto mode on · 1".to_owned(),
    ]
    .join("\n")
}

/// An 18-column pane: nothing of the work is left in the footer.
pub fn narrowest_screen() -> String {
    [
        "  done 12:41 PM ·".to_owned(),
        "  1 shell still".to_owned(),
        "  running".to_owned(),
        String::new(),
        "─".repeat(18),
        "❯".to_owned(),
        "─".repeat(18),
        "  -- INSERT -- ⏵".to_owned(),
    ]
    .join("\n")
}

/// A narrow pane with nothing running: the footer cannot say so.
pub fn narrow_idle_screen() -> String {
    [
        "⏺ ok".to_owned(),
        "─".repeat(30),
        "❯".to_owned(),
        "─".repeat(30),
        "  -- INSERT -- ⏵⏵ auto mode".to_owned(),
    ]
    .join("\n")
}

/// What /exit asks while background work runs.
pub fn exit_dialog_screen() -> String {
    [
        "❯ /exit",
        "▔▔▔▔▔▔▔▔",
        "   Background work is running",
        "   The following will stop when you exit:",
        "",
        "   shell · cd /work/repo && ninja",
        "",
        "   ❯ 1. Exit and stop tasks",
        "     2. Move to background and exit",
        "     3. Stay",
        "",
        "   Enter to confirm · Esc to cancel",
    ]
    .join("\n")
}

// ------------------------------------------------------------ the process

struct FakeState {
    items: VecDeque<String>,
    closed: bool,
    written: Vec<Obj>,
    ended: bool,
    killed: bool,
    alive: bool,
}

/// A stand-in for a headless Claude (`fakeClaudeProcess`): the test
/// pushes stream-json events, reads what was written to stdin, and
/// decides when it exits. `respond` answers writes.
pub struct FakeClaude {
    state: Mutex<FakeState>,
    wake: Notify,
    exit: watch::Sender<Option<i32>>,
    pid: u32,
    exit_on_end: bool,
    #[allow(clippy::type_complexity)]
    respond: Option<Box<dyn Fn(&Obj, &FakeClaude) + Send + Sync>>,
}

pub type Respond = Box<dyn Fn(&Obj, &FakeClaude) + Send + Sync>;

impl FakeClaude {
    pub fn new(pid: Option<u32>, exit_on_end: bool, respond: Option<Respond>) -> Arc<Self> {
        Arc::new(Self {
            state: Mutex::new(FakeState {
                items: VecDeque::new(),
                closed: false,
                written: Vec::new(),
                ended: false,
                killed: false,
                alive: true,
            }),
            wake: Notify::new(),
            exit: watch::channel(None).0,
            pid: pid.unwrap_or(4242),
            exit_on_end,
            respond,
        })
    }

    pub fn push(&self, event: Value) {
        self.state
            .lock()
            .unwrap()
            .items
            .push_back(js::stringify(&event));
        self.wake.notify_waiters();
    }

    pub fn exit(&self, code: i32) {
        {
            let mut state = self.state.lock().unwrap();
            state.closed = true;
            state.alive = false;
        }
        self.wake.notify_waiters();
        self.exit.send_replace(Some(code));
    }

    pub fn written(&self) -> Vec<Obj> {
        self.state.lock().unwrap().written.clone()
    }

    pub fn ended(&self) -> bool {
        self.state.lock().unwrap().ended
    }

    pub fn killed(&self) -> bool {
        self.state.lock().unwrap().killed
    }

    pub fn alive(&self) -> bool {
        self.state.lock().unwrap().alive
    }
}

impl HeadlessProcess for FakeClaude {
    fn next_line(&self) -> BoxFuture<'_, Option<String>> {
        Box::pin(async move {
            loop {
                let woken = self.wake.notified();
                tokio::pin!(woken);
                woken.as_mut().enable();
                {
                    let mut state = self.state.lock().unwrap();
                    if let Some(line) = state.items.pop_front() {
                        return Some(line);
                    }
                    if state.closed {
                        return None;
                    }
                }
                woken.await;
            }
        })
    }

    fn write(&self, line: &str) -> Result<(), String> {
        let message = {
            let mut state = self.state.lock().unwrap();
            if state.ended {
                return Err("The Claude Code process is closing".into());
            }
            let message = js::parse(line)
                .and_then(|value| value.as_object().cloned())
                .unwrap_or_default();
            state.written.push(message.clone());
            message
        };
        if let Some(respond) = &self.respond {
            respond(&message, self);
        }
        Ok(())
    }

    fn end(&self) {
        self.state.lock().unwrap().ended = true;
        if self.exit_on_end {
            self.exit(0);
        }
    }

    fn kill(&self) {
        self.state.lock().unwrap().killed = true;
        self.exit(143);
    }

    fn exited(&self) -> BoxFuture<'_, i32> {
        let mut receiver = self.exit.subscribe();
        Box::pin(async move {
            loop {
                if let Some(code) = *receiver.borrow_and_update() {
                    return code;
                }
                if receiver.changed().await.is_err() {
                    return -1;
                }
            }
        })
    }

    fn pid(&self) -> Option<u32> {
        Some(self.pid)
    }
}

/// Answers an interrupt as the CLI does: a control_response, then a result.
pub fn answer_interrupts(message: &Obj, process: &FakeClaude) {
    let subtype = message
        .get("request")
        .and_then(|request| request.get("subtype"))
        .and_then(Value::as_str);
    if message.get("type").and_then(Value::as_str) != Some("control_request")
        || subtype != Some("interrupt")
    {
        return;
    }
    process.push(json!({
        "type": "control_response",
        "response": {"subtype": "success", "request_id": message.get("request_id"), "response": {"still_queued": []}},
    }));
    process.push(json!({
        "type": "result",
        "subtype": "error_during_execution",
        "is_error": true,
        "terminal_reason": "aborted_streaming",
    }));
}

/// A turn's successful result line, as Claude prints it.
pub fn result_line() -> Value {
    json!({"type": "result", "subtype": "success", "is_error": false, "result": "ok"})
}

type Make = Box<dyn Fn() -> Arc<FakeClaude> + Send + Sync>;

/// A spawner handing out fakes, recording each start (`fakeSpawner`).
pub struct FakeSpawner {
    make: Make,
    pub spawned: Mutex<Vec<(HeadlessSpawnOptions, Arc<FakeClaude>)>>,
    /// Processes a holder runs already: an attach takes them, in order.
    pub running: Mutex<VecDeque<Arc<FakeClaude>>>,
}

impl FakeSpawner {
    pub fn new(make: Option<Make>) -> Arc<Self> {
        Arc::new(Self {
            make: make.unwrap_or_else(|| {
                Box::new(|| FakeClaude::new(None, true, Some(Box::new(answer_interrupts))))
            }),
            spawned: Mutex::new(Vec::new()),
            running: Mutex::new(VecDeque::new()),
        })
    }

    pub fn alive(&self) -> Vec<Arc<FakeClaude>> {
        self.spawned
            .lock()
            .unwrap()
            .iter()
            .filter(|(_, fake)| fake.alive())
            .map(|(_, fake)| fake.clone())
            .collect()
    }
}

impl SpawnHeadless for FakeSpawner {
    fn spawn(
        &self,
        options: HeadlessSpawnOptions,
    ) -> BoxFuture<'_, Result<Option<Arc<dyn HeadlessProcess>>, String>> {
        Box::pin(async move {
            if options.attach_only {
                return Ok(self
                    .running
                    .lock()
                    .unwrap()
                    .pop_front()
                    .map(|fake| fake as Arc<dyn HeadlessProcess>));
            }
            let fake = (self.make)();
            self.spawned.lock().unwrap().push((options, fake.clone()));
            Ok(Some(fake as Arc<dyn HeadlessProcess>))
        })
    }
}

// ------------------------------------------------------------ the Herdr

/// The pane the fake Herdr knows.
#[derive(Clone, Debug)]
pub struct FakeHerdrPane {
    pub agent: Option<Obj>,
    pub screen: String,
    pub process: PaneProcessInfo,
}

/// What the fake host says of headless processes and other writers.
#[derive(Clone, Debug, Default)]
pub struct FakeProbe {
    /// Headless processes on the host, by the session id they resume.
    pub running: HashSet<String>,
    pub fails: bool,
    /// Another writer on the session.
    pub elsewhere: Option<WriterElsewhere>,
    /// The pane was closed.
    pub closed: bool,
}

#[derive(Clone, Default)]
pub struct FakeHerdrOptions {
    pub session_id: Option<String>,
    pub cwd: Option<String>,
    pub claude_pid: Option<u32>,
    pub shell_pid: Option<u32>,
    pub exit_ignored: bool,
    /// /exit asks first (background work runs): Stay or Escape puts the
    /// prompt back, the other answers end Claude.
    pub exit_asks: bool,
    pub on_holder: Option<crate::shared::PaneFn>,
}

pub struct FakeHerdrState {
    pub pane: FakeHerdrPane,
    pub calls: Vec<Vec<String>>,
    pub reports: Vec<(String, String)>,
    pub live: HashSet<u32>,
    pub probe: FakeProbe,
}

/// A Herdr that knows one pane with an idle Claude (`fakeHerdr`). `/exit`
/// ends Claude (unless `exit_ignored`), and the holder command typed into
/// the shell "starts" the holder by calling `on_holder`.
pub struct FakeHerdr {
    pub state: Mutex<FakeHerdrState>,
    pub session_id: String,
    pub cwd: String,
    pub claude_pid: u32,
    pub shell_pid: u32,
    options: FakeHerdrOptions,
}

fn claude_agent(session_id: &str, cwd: &str) -> Obj {
    json!({
        "agent": "claude",
        "agent_status": "idle",
        "agent_session": {"kind": "id", "value": session_id, "source": "herdr:claude"},
        "foreground_cwd": cwd,
    })
    .as_object()
    .cloned()
    .unwrap()
}

impl FakeHerdr {
    pub fn new(options: FakeHerdrOptions) -> Arc<Self> {
        let session_id = options
            .session_id
            .clone()
            .unwrap_or_else(|| "11111111-2222-3333-4444-555555555555".into());
        let cwd = options.cwd.clone().unwrap_or_else(|| "/work/repo".into());
        let claude_pid = options.claude_pid.unwrap_or(900);
        let shell_pid = options.shell_pid.unwrap_or(800);
        let pane = FakeHerdrPane {
            agent: Some(claude_agent(&session_id, &cwd)),
            screen: idle_screen(),
            process: PaneProcessInfo {
                shell_pid: Some(shell_pid as f64),
                foreground_process_group_id: Some(claude_pid as f64),
                foreground_processes: vec![PaneProcess {
                    pid: claude_pid,
                    argv: Some(vec!["claude".into(), "--resume".into(), session_id.clone()]),
                    cwd: Some(cwd.clone()),
                    ..PaneProcess::default()
                }],
            },
        };
        Arc::new(Self {
            state: Mutex::new(FakeHerdrState {
                pane,
                calls: Vec::new(),
                reports: Vec::new(),
                live: [claude_pid].into_iter().collect(),
                probe: FakeProbe::default(),
            }),
            session_id,
            cwd,
            claude_pid,
            shell_pid,
            options,
        })
    }

    fn call(&self, parts: &[&str]) {
        self.state
            .lock()
            .unwrap()
            .calls
            .push(parts.iter().map(|part| (*part).to_owned()).collect());
    }

    pub fn calls(&self) -> Vec<Vec<String>> {
        self.state.lock().unwrap().calls.clone()
    }

    /// The calls named so, without their name.
    pub fn calls_of(&self, names: &[&str]) -> Vec<Vec<String>> {
        self.calls()
            .into_iter()
            .filter(|call| names.contains(&call[0].as_str()))
            .collect()
    }

    pub fn with<R>(&self, run: impl FnOnce(&mut FakeHerdrState) -> R) -> R {
        run(&mut self.state.lock().unwrap())
    }

    fn claude_exited(&self, state: &mut FakeHerdrState) {
        state.live.remove(&self.claude_pid);
        state.pane.agent = None;
        state.pane.process = PaneProcessInfo {
            shell_pid: Some(self.shell_pid as f64),
            foreground_process_group_id: Some(self.shell_pid as f64),
            foreground_processes: Vec::new(),
        };
    }

    /// The holder exec'd Claude: Herdr maps the pane again.
    pub fn resumed(&self, id: Option<&str>, pid: Option<u32>) {
        let id = id.unwrap_or(&self.session_id).to_owned();
        let pid = pid.unwrap_or(901);
        let mut state = self.state.lock().unwrap();
        state.live.insert(pid);
        state.pane.agent = Some(claude_agent(&id, &self.cwd));
        state.pane.process = PaneProcessInfo {
            shell_pid: Some(self.shell_pid as f64),
            foreground_process_group_id: Some(pid as f64),
            foreground_processes: vec![PaneProcess {
                pid,
                argv: Some(vec!["claude".into(), "--resume".into(), id]),
                cwd: Some(self.cwd.clone()),
                ..PaneProcess::default()
            }],
        };
    }
}

impl ConversationHerdr for FakeHerdr {
    fn agent_get<'a>(&'a self, pane_id: &'a str) -> BoxFuture<'a, HerdrResult<Option<Obj>>> {
        self.call(&["agentGet", pane_id]);
        let agent = self.state.lock().unwrap().pane.agent.clone();
        Box::pin(async move { Ok(agent) })
    }
    fn read_detection<'a>(&'a self, pane_id: &'a str) -> BoxFuture<'a, HerdrResult<String>> {
        self.call(&["readDetection", pane_id]);
        let screen = self.state.lock().unwrap().pane.screen.clone();
        Box::pin(async move { Ok(screen) })
    }
    fn process_info<'a>(&'a self, pane_id: &'a str) -> BoxFuture<'a, HerdrResult<PaneProcessInfo>> {
        self.call(&["processInfo", pane_id]);
        let process = self.state.lock().unwrap().pane.process.clone();
        Box::pin(async move { Ok(process) })
    }
    fn prompt<'a>(&'a self, pane_id: &'a str, text: &'a str) -> BoxFuture<'a, HerdrResult<()>> {
        self.call(&["prompt", pane_id, text]);
        if text == "/exit" && !self.options.exit_ignored {
            let mut state = self.state.lock().unwrap();
            if self.options.exit_asks {
                state.pane.screen = exit_dialog_screen();
            } else {
                self.claude_exited(&mut state);
            }
        }
        Box::pin(async { Ok(()) })
    }
    fn send_text<'a>(&'a self, pane_id: &'a str, text: &'a str) -> BoxFuture<'a, HerdrResult<()>> {
        self.call(&["sendText", pane_id, text]);
        if let Some(on_holder) = &self.options.on_holder {
            on_holder(pane_id);
        }
        Box::pin(async { Ok(()) })
    }
    fn send_keys<'a>(&'a self, pane_id: &'a str, keys: &'a str) -> BoxFuture<'a, HerdrResult<()>> {
        self.call(&["sendKeys", pane_id, keys]);
        let mut state = self.state.lock().unwrap();
        if state.pane.screen == exit_dialog_screen() {
            if keys == "3" || keys == "\x1b" {
                state.pane.screen = background_screen();
            } else {
                self.claude_exited(&mut state);
            }
        }
        Box::pin(async { Ok(()) })
    }
    fn report_agent(&self, report: AgentReport) -> BoxFuture<'_, HerdrResult<()>> {
        self.call(&[
            "reportAgent",
            &report.pane_id,
            &report.state,
            &report.session_id,
        ]);
        self.state
            .lock()
            .unwrap()
            .reports
            .push((report.state, report.session_id));
        Box::pin(async { Ok(()) })
    }
    fn release_agent<'a>(
        &'a self,
        pane_id: &'a str,
        _agent: Option<&'a str>,
    ) -> BoxFuture<'a, HerdrResult<()>> {
        self.call(&["releaseAgent", pane_id]);
        Box::pin(async { Ok(()) })
    }
    fn pid_alive(&self, pid: u32) -> BoxFuture<'_, bool> {
        let alive = self.state.lock().unwrap().live.contains(&pid);
        Box::pin(async move { alive })
    }
    fn headless_running<'a>(
        &'a self,
        session_ids: &'a [String],
    ) -> BoxFuture<'a, HerdrResult<bool>> {
        let mut call = vec!["headlessRunning"];
        call.extend(session_ids.iter().map(String::as_str));
        self.call(&call);
        let state = self.state.lock().unwrap();
        let answer = if state.probe.fails {
            Err("the host did not answer".to_owned())
        } else {
            Ok(session_ids
                .iter()
                .any(|id| state.probe.running.contains(id)))
        };
        Box::pin(async move { answer })
    }
    fn pane_exists<'a>(&'a self, pane_id: &'a str) -> BoxFuture<'a, HerdrResult<bool>> {
        self.call(&["paneExists", pane_id]);
        let closed = self.state.lock().unwrap().probe.closed;
        Box::pin(async move { Ok(!closed) })
    }
    fn writer_elsewhere<'a>(
        &'a self,
        pane_id: &'a str,
        _session_ids: &'a [String],
        _except_pids: &'a [u32],
    ) -> BoxFuture<'a, HerdrResult<Option<WriterElsewhere>>> {
        self.call(&["writerElsewhere", pane_id]);
        let state = self.state.lock().unwrap();
        let answer = if state.probe.fails {
            Err("the host did not answer".to_owned())
        } else {
            Ok(state.probe.elsewhere.clone())
        };
        Box::pin(async move { answer })
    }
}

/// A writer outside Herdr's panes (text alone).
pub fn writer_text(text: &str) -> WriterElsewhere {
    WriterElsewhere {
        text: text.into(),
        pane: None,
    }
}
