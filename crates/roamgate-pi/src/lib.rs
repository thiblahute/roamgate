//! Ranger's Pi providers through the Pi sidecar (Rust migration plan,
//! section 6.8; the wire is contract/wire/pi-sidecar.md). Pi has no Rust
//! equivalent, so the Rust server runs it in `roamgate-pi`, a Bun program
//! serving Pi's drivers over its stdin and stdout, started on the first Pi
//! call and closed after five idle minutes. `roamgate-assistant`'s Pi
//! driver is a [`PiDriver`]; native providers replace the sidecar one by
//! one.
//!
//! | Module | What |
//! |---|---|
//! | [`protocol`] | the JSON-RPC lines (held to `contract/vectors/pi-sidecar.json`) |
//! | [`peer`] | requests both ways, notifications, `$/cancel` |
//! | [`sidecar`] | the process, and [`PiDriver`], one Ranger directory's Pi |

pub mod peer;
pub mod protocol;
pub mod sidecar;

pub use sidecar::{
    LoginInteraction, PiDriver, PiSidecar, RunEvent, RunHandler, RunInput, SaveModels,
    SidecarConfig,
};

pub type BoxFuture<T> = std::pin::Pin<Box<dyn std::future::Future<Output = T> + Send>>;

/// A failure of a sidecar call, or of the server's answer to one.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum PiError {
    /// A message the assistant shows the user and the model as it is (the
    /// TS side's `AssistantUserError`).
    #[error("{0}")]
    User(String),
    /// Any other failure, with its message.
    #[error("{0}")]
    Failed(String),
    #[error("{0}")]
    MethodNotFound(String),
    /// The sidecar exited or could not start: everything in flight fails.
    #[error("{0}")]
    Closed(String),
    #[error("Cancelled")]
    Cancelled,
}

impl PiError {
    pub fn user(message: impl Into<String>) -> Self {
        Self::User(message.into())
    }

    pub fn failed(message: impl Into<String>) -> Self {
        Self::Failed(message.into())
    }

    pub(crate) fn closed() -> Self {
        Self::Closed("The Pi sidecar closed".into())
    }

    /// Whether the assistant shows the message as it is.
    pub fn is_user(&self) -> bool {
        matches!(self, Self::User(_))
    }
}
