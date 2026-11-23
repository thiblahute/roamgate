//! A headless agent as the conversation session starts it
//! (`headless.ts`): the pane holder runs it; Roamgate reads what it says
//! and writes to it through the holder. The process itself is
//! [`crate::driver::HeadlessProcess`].

use std::sync::Arc;

use tokio_util::sync::CancellationToken;

use crate::driver::{ApiKeyAnswer, BoxFuture, HeadlessProcess};

#[derive(Clone, Debug, Default)]
pub struct HeadlessSpawnOptions {
    pub pane_id: String,
    pub session_id: String,
    pub cwd: String,
    /// Only a process that already runs (or ended unread) is taken.
    pub attach_only: bool,
    /// Gives up a start still waiting.
    pub signal: Option<CancellationToken>,
    /// The user's answer about the pane's API key, just given in the chat:
    /// the holder files it where the agent keeps it, then starts it.
    pub api_key_answer: Option<ApiKeyAnswer>,
}

/// Starts (or takes) the pane's headless process: None only when
/// attaching and nothing runs; the error is why it could not.
pub trait SpawnHeadless: Send + Sync {
    fn spawn(
        &self,
        options: HeadlessSpawnOptions,
    ) -> BoxFuture<'_, Result<Option<Arc<dyn HeadlessProcess>>, String>>;
}
