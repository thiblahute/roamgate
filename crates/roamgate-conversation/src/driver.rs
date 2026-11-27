//! Conversation mode's drivers (`server/src/conversation/drivers/types.ts`):
//! what one agent needs to be driven headless (the protocol driver) and
//! handed over to and from its TUI (the terminal driver). The core
//! (session, service, handover, holder) is the same for every agent; it
//! reaches the agent only through these.
//!
//! Wire and browser values (stream items, capabilities, models, MCP
//! servers, rewind results, questions) are Bun's JavaScript objects as
//! `serde_json` maps in insertion order, as everywhere in S21: their JSON
//! text is compared with Bun's.

use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;

use serde_json::{Map, Value};

pub type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

/// A JavaScript object: a stream item, a control response, a holder's
/// start command.
pub type Object = Map<String, Value>;

/// What one line of the headless process means, normalized: every
/// driver's codec turns its own protocol into these (Claude's
/// `StreamItem`, `{kind: ...}`).
pub type DriverEvent = Object;

/// The session id of a native session its agent has not named yet (ACP's
/// `session/new` names it once the process started).
pub const UNNAMED_SESSION_ID: &str = "new";

/// The agents conversation mode drives (`ConversationAgent`).
pub const CONVERSATION_AGENTS: &[&str] = &["claude", "agy"];

/// What the browser is asked for a prompt request.
#[derive(Clone, Debug, PartialEq)]
pub struct DriverPrompt {
    pub tool: String,
    pub input: Value,
    pub can_always: bool,
    /// A structured question rather than a permission (`AgentQuestion[]`).
    pub questions: Option<Vec<Value>>,
}

/// An image of a message: inline data, or the upload's path on the host.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct DriverImage {
    pub path: String,
    pub media_type: Option<String>,
    pub data: Option<String>,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct DriverMessage {
    pub text: String,
    pub images: Vec<DriverImage>,
    pub uuid: String,
    /// Texts read before the message's own (the `!` lines run since).
    pub prelude: Vec<String>,
    /// Written while a turn runs: it steers that turn.
    pub steer: bool,
}

/// What the pane holder is told to run (its start command).
pub type HolderStartCommand = Object;

/// The user's answer about the pane's API key, given in the chat.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ApiKeyAnswer {
    Approve,
    Reject,
}

impl ApiKeyAnswer {
    pub fn as_str(self) -> &'static str {
        match self {
            ApiKeyAnswer::Approve => "approve",
            ApiKeyAnswer::Reject => "reject",
        }
    }

    pub fn parse(text: &str) -> Option<Self> {
        match text {
            "approve" => Some(ApiKeyAnswer::Approve),
            "reject" => Some(ApiKeyAnswer::Reject),
            _ => None,
        }
    }
}

/// The session's profile (`server/src/profiles`): its program and the
/// environment it sets (in its order) or removes.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct StartProfile {
    pub program: String,
    pub env: Vec<(String, String)>,
    pub unset: Vec<String>,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct StartOptions {
    pub session_id: String,
    /// The pane it runs in: the headless process is told it (PANE_NAMES).
    pub pane_id: Option<String>,
    pub cwd: String,
    /// The pane's TUI's kept flags (the lease's terminal_args).
    pub flags: Option<Vec<String>>,
    /// The user's answer about the pane's API key, filed by the holder.
    pub api_key_answer: Option<ApiKeyAnswer>,
    /// Absent: the driver's own program.
    pub profile: Option<StartProfile>,
}

/// One process's protocol: decodes its lines into [`DriverEvent`]s and
/// encodes what is written to it. Its state is serializable (save and
/// restore), so a runtime after this one reads on where this one stopped.
pub trait DriverCodec: Send {
    fn line(&mut self, line: &str) -> Vec<DriverEvent>;
    fn save(&self) -> Value;
    fn restore(&mut self, state: &Value);
    /// The lines that write a user message.
    fn message(&mut self, message: &DriverMessage) -> Vec<String>;
    /// The lines that stop the turn; a `control_response` event confirms.
    fn interrupt(&mut self, request_id: &str) -> Vec<String>;
    /// The lines that answer a prompt request (a `permission_request`
    /// event); None: nobody answered in time. The answer is the browser's
    /// `AgentPromptAnswer`.
    fn answer(&mut self, request: &DriverEvent, answer: Option<&Value>) -> Vec<String>;
    /// A request of the agent's own (rewind steps...); None: not supported.
    fn request(&mut self, kind: &str, params: &Object, request_id: &str) -> Option<Vec<String>>;
    /// Lines to write right after a fresh headless process starts (not on
    /// reattach), such as ACP's `initialize` handshake.
    fn on_start(&mut self, _session_id: &str, _cwd: &str) -> Vec<String> {
        Vec::new()
    }
    /// Protocol follow-up lines queued while decoding stdout (such as ACP
    /// `session/resume` / `session/new` or buffered prompts after handshake).
    fn pending_writes(&mut self) -> Vec<String> {
        Vec::new()
    }
}

/// A control request's answer (`ControlAnswer`); `None` where it is used
/// means none came in time.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct ControlAnswer {
    pub error: Option<String>,
    pub response: Option<Object>,
}

/// Where the lines a reader handled end in a holder's log.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct HolderPosition {
    pub child: u64,
    pub epoch_offset: u64,
    pub offset: u64,
}

/// A headless agent process as the conversation session sees it
/// (`HeadlessProcess`): the pane holder runs it; Roamgate reads what it
/// says and writes to it through the holder.
pub trait HeadlessProcess: Send + Sync {
    /// Its next line; None once its output ended.
    fn next_line(&self) -> BoxFuture<'_, Option<String>>;
    /// Fails once stdin was closed (`end`): nothing written is ever dropped.
    fn write(&self, line: &str) -> Result<(), String>;
    /// No more input: the process exits once it has answered.
    fn end(&self);
    fn kill(&self);
    /// Its exit code, once it exited (every caller gets it).
    fn exited(&self) -> BoxFuture<'_, i32>;
    /// The spawned process (for SSH, the local ssh client).
    fn pid(&self) -> Option<u32> {
        None
    }
    /// The first lines handled by an earlier reader (another runtime, a
    /// Roamgate before a restart): they rebuild the turn's state and are
    /// not sent to the browsers again.
    fn replayed(&self) -> usize {
        0
    }
    /// The first lines already in when it was taken (`replayed` among
    /// them): until they are handled the session catches up, and asks no
    /// prompt.
    fn catch_up(&self) -> usize {
        0
    }
    /// Once it exited: the user messages written to it that the agent
    /// never got, as written. None: this process cannot say.
    fn undelivered(&self) -> Option<Vec<String>> {
        None
    }
    /// The state a reader before this one left the conversation in, where
    /// its lines start (`ConversationSession.resumeState`).
    fn resume(&self) -> Option<Value> {
        None
    }
    /// Where the lines handled so far end in the holder's log, while it
    /// runs. The outer None: this process has no holder log.
    fn position(&self) -> Option<Option<HolderPosition>> {
        None
    }
    /// Stops reading; the process itself keeps running in the holder.
    fn detach(&self) {}
}

/// A transcript as a rewind reads it: its text, or its records.
#[derive(Clone, Debug, PartialEq)]
pub enum Transcript {
    Text(String),
    Records(Vec<Object>),
}

/// What a rewind needs of the session that runs it.
pub trait RewindContext: Send + Sync {
    fn session_id(&self) -> String;
    /// Starts the process when it is not up.
    fn ensure_process(&self) -> BoxFuture<'_, Result<Arc<dyn HeadlessProcess>, String>>;
    /// Ends the process; true once none runs.
    fn stop_process(&self) -> BoxFuture<'_, bool>;
    fn control<'a>(
        &'a self,
        child: &'a Arc<dyn HeadlessProcess>,
        kind: &'a str,
        params: Object,
    ) -> BoxFuture<'a, Option<ControlAnswer>>;
    /// None: this session cannot read its transcript. The future's error
    /// is a read that failed (logged, and the rewind goes on without it);
    /// its None, no transcript.
    fn read_transcript(&self) -> Option<BoxFuture<'_, Result<Option<Transcript>, String>>> {
        None
    }
    fn log(&self, message: &str, fields: Option<Object>);
}

/// A rewind's input: to before `uuid`, `last_seen` the browser's newest,
/// `mode` "both", "conversation" or "code".
#[derive(Clone, Debug, PartialEq)]
pub struct RewindInput {
    pub uuid: String,
    pub last_seen: Option<String>,
    pub mode: String,
}

pub trait RewindDriver: Send + Sync {
    /// What a transcript says of a rewind to before `uuid`
    /// (`AgentChatRewindCheck`).
    fn check_transcript(&self, transcript: Option<&Transcript>, uuid: &str) -> Value;
    /// What a rewind to before `uuid` would do to the code; starts nothing.
    fn check<'a>(&'a self, context: &'a dyn RewindContext, uuid: &'a str) -> BoxFuture<'a, Value>;
    /// Rewinds, the session being idle and nothing written meanwhile
    /// (`AgentChatRewindResult`). An error is what the TS run threw (the
    /// process would not start).
    fn run<'a>(
        &'a self,
        context: &'a dyn RewindContext,
        input: RewindInput,
    ) -> BoxFuture<'a, Result<Value, String>>;
}

/// What listing and switching models needs of the running process.
pub trait ModelContext: Send + Sync {
    /// Asks the running process over its control protocol.
    fn control(&self, kind: &str, params: Object) -> BoxFuture<'_, Option<ControlAnswer>>;
}

/// A model switch's outcome: the model it runs then (as it names it; None
/// when it does not say), or why not.
pub type ModelSet = Result<Option<String>, String>;

/// A command line's end, run on the pane's host for a driver's command.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct CommandOutput {
    /// None when it was stopped or killed by a signal.
    pub code: Option<i32>,
    pub stdout: String,
    pub stderr: String,
}

/// What a driver's own slash command needs of the session it runs in.
pub trait CommandContext: Send + Sync {
    /// Asks the running process over its control protocol, starting it
    /// when it is not up; None when no answer came in time.
    fn control(&self, kind: &str, params: Object) -> BoxFuture<'_, Option<ControlAnswer>>;
    /// Runs a command line on the pane's host, in the session's
    /// directory; an error when it could not run or did not end in time.
    fn run<'a>(
        &'a self,
        command: &'a str,
        timeout_ms: u64,
    ) -> BoxFuture<'a, Result<CommandOutput, String>>;
    /// The context window the process last reported: tokens used, and its
    /// size.
    fn context_usage(&self) -> Option<(u64, u64)>;
    /// The model the process runs, as it last said.
    fn model(&self) -> Option<String>;
}

/// What a driver's slash command says, under the composer as /model's
/// answer is.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CommandNotice {
    pub ok: bool,
    pub text: String,
}

pub trait ModelDriver: Send + Sync {
    /// The models the running process offers (`AgentChatModel[]`); None
    /// when it cannot say.
    fn list<'a>(&'a self, context: &'a dyn ModelContext) -> BoxFuture<'a, Option<Vec<Value>>>;
    fn set<'a>(&'a self, context: &'a dyn ModelContext, model: &'a str) -> BoxFuture<'a, ModelSet>;
}

pub trait McpDriver: Send + Sync {
    /// The MCP servers of the running process (`AgentChatMcpServer[]`), or
    /// why it did not say.
    fn status<'a>(
        &'a self,
        context: &'a dyn ModelContext,
    ) -> BoxFuture<'a, Result<Vec<Value>, String>>;
    /// Asks the running process to act on one of its servers
    /// (`AgentChatMcpRequest` to `AgentChatMcpResult`).
    fn act<'a>(&'a self, context: &'a dyn ModelContext, request: Value) -> BoxFuture<'a, Value>;
}

/// What the holder notes of a line written to the process.
#[derive(Clone, Debug, PartialEq)]
pub struct InputKind {
    pub kind: String,
    pub request_id: Option<String>,
}

/// A written user message the process never got, back to its text.
#[derive(Clone, Debug, PartialEq)]
pub struct WrittenMessage {
    pub uuid: Option<String>,
    pub text: String,
}

pub trait ProtocolDriver: Send + Sync {
    fn agent(&self) -> &str;
    /// The agent's name in every user-facing string ("Claude").
    fn display_name(&self) -> &str;
    /// `AgentChatCapabilities`.
    fn capabilities(&self) -> Value;
    /// What the holder runs: argv, cwd and environment changes.
    fn start_command(&self, options: &StartOptions) -> HolderStartCommand;
    fn create_codec(&self) -> Box<dyn DriverCodec>;
    /// What the user is asked for a prompt request.
    fn prompt_of(&self, request: &DriverEvent) -> DriverPrompt;
    /// What the holder notes of a line written to the process: a user
    /// message (kind "user"), an answer to a request (`answer_kind`, with
    /// its request id), or anything else.
    fn input_kind(&self, line: &str) -> InputKind;
    fn answer_kind(&self) -> &str;
    fn parse_written_message(&self, line: &str) -> Option<WrittenMessage>;
    /// Present when the capabilities say rewind.
    fn rewind(&self) -> Option<&dyn RewindDriver> {
        None
    }
    /// Present when the capabilities say models.
    fn models(&self) -> Option<&dyn ModelDriver> {
        None
    }
    /// Present when the capabilities say mcp.
    fn mcp(&self) -> Option<&dyn McpDriver> {
        None
    }
    /// The session id a new native session starts with: one Roamgate
    /// picks (Claude's `--session-id`), or [`UNNAMED_SESSION_ID`] where
    /// the agent names it once it started (ACP's `session/new`).
    fn new_session_id(&self) -> String {
        roamgate_base::paths::random_uuid()
    }
    /// A slash command the driver answers itself instead of the agent
    /// (AGY's /usage); None: the line goes to the agent.
    fn command<'a>(
        &'a self,
        _text: &'a str,
        _context: &'a dyn CommandContext,
    ) -> Option<BoxFuture<'a, CommandNotice>> {
        None
    }
}

/// A process in a pane, as Herdr's process info lists it.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct PaneProcess {
    pub pid: u32,
    pub argv: Option<Vec<String>>,
    pub argv0: Option<String>,
    pub cmdline: Option<String>,
    pub cwd: Option<String>,
}

/// The TUI's screen, for a handover from the terminal.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct TerminalReadiness {
    /// Background work exiting would stop (the switch waits for it).
    pub background: Option<String>,
    /// False when the screen cannot say (a pane too narrow).
    pub background_known: bool,
    /// Why the TUI cannot be exited now (a draft, a dialog), if anything.
    pub refusal: Option<String>,
}

pub trait TerminalDriver: Send + Sync {
    fn agent(&self) -> &str;
    /// Herdr's agent name for the TUI.
    fn herdr_agent(&self) -> &str;
    fn display_name(&self) -> &str;
    /// A TUI of this agent, never the headless child.
    fn is_agent_process(&self, process: &PaneProcess) -> bool;
    /// The TUI's flags its headless run and its resumed TUI keep.
    fn kept_flags(&self, process: &PaneProcess) -> Vec<String>;
    fn readiness(&self, screen: &str) -> TerminalReadiness;
    /// What is typed into the TUI to exit it.
    fn exit_command(&self) -> &str;
    /// The TUI asks before exiting: the key that stays.
    fn exit_dialog(&self, screen: &str) -> Option<String>;
    /// The background work the screen shows, if any.
    fn background_work(&self, screen: &str) -> Option<String>;
    /// The command line that resumes the session in the TUI.
    fn resume_argv(&self, session_id: &str, flags: &[String]) -> Vec<String>;
    /// `ps -eo pid=,args=` lists a headless process on these sessions.
    fn headless_probe(&self, ps: &str, session_ids: &[String]) -> bool;
    /// The pid of an interactive TUI on these sessions, if any.
    fn interactive_writer(
        &self,
        ps: &str,
        session_ids: &[String],
        except_pids: &[u32],
    ) -> Option<u32>;
}

/// How a headless background session of the agent is started around a
/// memory directory.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct BackgroundMemoryLaunch {
    /// What to add to its launch.
    pub args: Vec<String>,
    /// Its tools: "" for none.
    pub tools: String,
    /// Instead of the system's temporary directory.
    pub cwd: Option<String>,
}

/// How one agent reaches the companion's memory directory
/// (`voice-memory-files.ts`). The fast front only reads it; a background
/// session writes it.
pub trait CompanionMemoryDriver: Send + Sync {
    /// Its launch to load the directory's index by itself; None: it
    /// cannot, the index goes in its prompt.
    fn reader(&self, dir: &str) -> Option<BackgroundMemoryLaunch>;
    /// A session with the file tools limited to `dir`, and nothing else.
    fn writer(&self, dir: &str) -> BackgroundMemoryLaunch;
}

#[derive(Clone)]
pub struct ConversationDriver {
    pub protocol: Arc<dyn ProtocolDriver>,
    pub terminal: Arc<dyn TerminalDriver>,
    pub memory: Arc<dyn CompanionMemoryDriver>,
}

/// Every agent's drivers (`drivers/index.ts`), given by whoever composes
/// the service (the core gives Claude's from `roamgate-claude`): the first
/// is the default, an older lease's agent.
#[derive(Clone)]
pub struct Drivers {
    drivers: Arc<Vec<ConversationDriver>>,
}

impl Drivers {
    /// Panics without a driver: conversation mode needs one.
    pub fn new(drivers: Vec<ConversationDriver>) -> Self {
        assert!(!drivers.is_empty(), "conversation mode needs a driver");
        Self {
            drivers: Arc::new(drivers),
        }
    }

    /// The driver pair of an agent; absent or unknown (an older lease):
    /// the default.
    pub fn of(&self, agent: Option<&str>) -> &ConversationDriver {
        agent
            .and_then(|agent| {
                self.drivers
                    .iter()
                    .find(|each| each.protocol.agent() == agent)
            })
            .unwrap_or(&self.drivers[0])
    }

    /// Every driver: what probes for any agent's processes go through.
    pub fn all(&self) -> &[ConversationDriver] {
        &self.drivers
    }

    /// The driver of the agent Herdr names in a pane, if any.
    pub fn for_herdr_agent(&self, name: &str) -> Option<&ConversationDriver> {
        self.drivers
            .iter()
            .find(|each| each.terminal.herdr_agent() == name)
    }
}

/// Whether conversation mode can drive this agent (`isConversationAgent`).
pub fn is_conversation_agent(agent: &str) -> bool {
    CONVERSATION_AGENTS.contains(&agent)
}
