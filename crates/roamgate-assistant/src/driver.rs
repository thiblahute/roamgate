//! The model driver trait (`AssistantDriver` of `assistant/pi-driver.ts`):
//! what the service asks of a model, whichever runs it. Ranger's driver
//! (`ranger_driver`) gives its own provider to Claude Code
//! (`roamgate-claude`) and every other to Pi (`roamgate-pi`'s sidecar,
//! S24).

use std::path::PathBuf;
use std::sync::Arc;

use serde_json::Value;
use tokio_util::sync::CancellationToken;

use crate::errors::AssistantResult;
use crate::tools::{BoxFuture, RangerHandlers};

/// What a turn reports (`run`'s callbacks), in the order it happens.
#[derive(Debug, Clone, PartialEq)]
pub enum RunEvent {
    /// Text streamed into the current message.
    Delta(String),
    /// A message finished.
    Message(String),
    Tool {
        id: String,
        name: String,
        /// `running`, `completed` or `failed`.
        status: String,
        /// `{arguments, output}` when the driver has them.
        details: Option<Value>,
    },
    Error,
    /// The whole text of the current message (`replace`), for a driver
    /// that does not stream deltas.
    Replace(String),
    /// The turn's visible reasoning so far: one entry per model call.
    Thinking(Vec<String>),
    Sources(Value),
    /// A user input joined the turn; the request id is absent for an
    /// input this run did not send.
    Steered {
        request_id: Option<String>,
        text: String,
    },
}

/// The optional callbacks a run may have (`RUN_CALLBACKS` of the Pi
/// sidecar's wire): a driver changes what it reports by their presence.
pub const RUN_CALLBACKS: [&str; 5] = ["checkpoint", "replace", "thinking", "sources", "steered"];

/// Saves the entries to keep (`checkpoint`): the driver admits the turn
/// only once this is done.
pub type Checkpoint = Arc<dyn Fn(Vec<Value>) -> BoxFuture<AssistantResult<()>> + Send + Sync>;

/// One turn's input and callbacks (`AssistantDriver.run`'s argument).
#[derive(Clone)]
pub struct RunInput {
    /// The chat's `AssistantConfig`.
    pub config: Value,
    /// The driver's saved context (its pointer entries).
    pub entries: Vec<Value>,
    pub text: String,
    pub request_id: Option<String>,
    pub recover: bool,
    /// `{requestId, text}` of the steers already sent to this turn.
    pub steers: Option<Vec<Value>>,
    /// The optional callbacks present, of [`RUN_CALLBACKS`] (`checkpoint`
    /// is present when [`RunInput::checkpoint`] is).
    pub callbacks: Vec<&'static str>,
    pub checkpoint: Option<Checkpoint>,
    pub events: Arc<dyn Fn(RunEvent) + Send + Sync>,
    /// The tool handlers of the turn; `read` always.
    pub handlers: RangerHandlers,
}

impl RunInput {
    pub fn has(&self, callback: &str) -> bool {
        self.callbacks.contains(&callback)
            || (callback == "checkpoint" && self.checkpoint.is_some())
    }
}

/// A step of a provider login the user answers.
pub trait LoginInteraction: Send + Sync + 'static {
    /// A step to answer: `{type, message, options?}`.
    fn prompt(
        &self,
        prompt: Value,
        cancel: CancellationToken,
    ) -> BoxFuture<AssistantResult<String>>;
    /// Progress to show: `{type: info|progress|auth_url|device_code, ...}`.
    fn event(&self, event: Value);
}

/// Writes models.json (`path`, `value`).
pub type SaveModels = Arc<dyn Fn(String, Value) -> AssistantResult<()> + Send + Sync>;

/// `AssistantDriver`.
pub trait AssistantDriver: Send + Sync + 'static {
    /// `{providers, models}` for the credential source.
    fn catalog(&self, source: &str) -> BoxFuture<AssistantResult<Value>>;
    /// Whether `configure_model` exists (`configureModel?`).
    fn configures_models(&self) -> bool {
        false
    }
    fn configure_model(&self, _input: Value, _save: SaveModels) -> BoxFuture<AssistantResult<()>> {
        Box::pin(async {
            Err(crate::errors::AssistantError::internal(
                "Invalid model connection",
            ))
        })
    }
    /// Whether `read_tool_details` exists (`readToolDetails?`).
    fn reads_tool_details(&self) -> bool {
        false
    }
    /// The messages with their tool details.
    fn read_tool_details(
        &self,
        _entries: Vec<Value>,
        messages: Value,
        _source_directory: Option<PathBuf>,
    ) -> BoxFuture<AssistantResult<Value>> {
        Box::pin(async move { Ok(messages) })
    }
    fn login(
        &self,
        provider: &str,
        method: &str,
        source: &str,
        interaction: Arc<dyn LoginInteraction>,
        cancel: CancellationToken,
    ) -> BoxFuture<AssistantResult<()>>;
    /// A turn: the entries to keep. `cancel` is the turn's signal.
    fn run(
        &self,
        input: RunInput,
        cancel: CancellationToken,
    ) -> BoxFuture<AssistantResult<Vec<Value>>>;
    /// Whether `steer` exists (`steer?`).
    fn steers(&self) -> bool {
        false
    }
    /// Adds user input to the running turn after its current tool round;
    /// fails when no turn can take it, so the caller queues it.
    fn steer(&self, _text: &str, _request_id: &str) -> BoxFuture<AssistantResult<()>> {
        Box::pin(async {
            Err(crate::errors::AssistantError::internal(
                "Ranger is not running",
            ))
        })
    }
    fn stop(&self) -> BoxFuture<AssistantResult<()>>;
    fn dispose(&self) -> BoxFuture<AssistantResult<()>>;
}
