//! Creating a tab or workspace from the browser's own terminal
//! (bridge/endpoint-creation.ts): the creation source the browser names,
//! the check that it is still where it was, the admission-to-dispatch
//! deadline, and the empty-session bootstrap, one at a time per runtime.

use std::future::Future;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use roamgate_base::clock::SharedClock;
use serde_json::{Map, Value};
use tokio::sync::Mutex as AsyncMutex;

use crate::BoxFuture;

/// Where a creation from a browser terminal comes from.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CreationSource {
    pub workspace_id: String,
    pub tab_id: String,
    pub pane_id: String,
    pub terminal_id: String,
}

const SOURCE_KEYS: [&str; 4] = ["workspace_id", "tab_id", "pane_id", "terminal_id"];

/// The Studio-only creation context; never forwarded to Herdr.
pub fn parse_creation_source(value: &Value) -> Result<CreationSource, String> {
    let Some(source) = value.as_object() else {
        return Err(
            "Open the source workspace's terminal tab before creating a tab or workspace.".into(),
        );
    };
    let mut ids = Vec::with_capacity(4);
    for key in SOURCE_KEYS {
        match source.get(key).and_then(Value::as_str) {
            Some(id)
                if !id.is_empty()
                    && id.encode_utf16().count() <= 256
                    && !id.chars().any(|c| (c as u32) < 0x20 || c == '\u{7f}') =>
            {
                ids.push(id.to_owned());
            }
            _ => return Err(format!("Invalid browser creation source {key}")),
        }
    }
    let mut ids = ids.into_iter();
    Ok(CreationSource {
        workspace_id: ids.next().unwrap_or_default(),
        tab_id: ids.next().unwrap_or_default(),
        pane_id: ids.next().unwrap_or_default(),
        terminal_id: ids.next().unwrap_or_default(),
    })
}

/// The source's pane as Herdr has it now (`pane.get`'s `pane`): each id
/// must still match.
pub fn assert_creation_source(source: &CreationSource, pane: &Value) -> Result<(), String> {
    let matches = pane.as_object().is_some_and(|pane| {
        [
            ("workspace_id", &source.workspace_id),
            ("tab_id", &source.tab_id),
            ("pane_id", &source.pane_id),
            ("terminal_id", &source.terminal_id),
        ]
        .iter()
        .all(|(key, id)| pane.get(*key).and_then(Value::as_str) == Some(id.as_str()))
    });
    if matches {
        Ok(())
    } else {
        Err("Source pane moved or closed. Open its current tab and retry creation.".into())
    }
}

/// The admission-to-dispatch budget, below the browser's 30 s RPC timeout.
#[derive(Clone)]
pub struct CreationDeadline {
    clock: SharedClock,
    expires_at: i64,
    dispatched: Arc<AtomicBool>,
}

impl CreationDeadline {
    pub fn new(clock: SharedClock) -> Self {
        Self::with_timeout(clock, Duration::from_millis(20_000))
    }

    pub fn with_timeout(clock: SharedClock, timeout: Duration) -> Self {
        let expires_at = clock.now() + timeout.as_millis() as i64;
        Self {
            clock,
            expires_at,
            dispatched: Arc::new(AtomicBool::new(false)),
        }
    }

    fn error(&self) -> String {
        if self.dispatched.load(Ordering::SeqCst) {
            "Creation timed out after dispatch; check Herdr before retrying. Creation may have succeeded.".into()
        } else {
            "Creation expired before dispatch; nothing was created. Retry from the current terminal."
                .into()
        }
    }

    pub fn assert_before_dispatch(&self) -> Result<(), String> {
        if self.clock.now() >= self.expires_at {
            return Err(self.error());
        }
        Ok(())
    }

    /// Sends, once the deadline allows: from here a timeout says creation
    /// may have happened.
    pub async fn dispatch<T>(
        &self,
        send: impl Future<Output = Result<T, String>>,
    ) -> Result<T, String> {
        self.assert_before_dispatch()?;
        self.dispatched.store(true, Ordering::SeqCst);
        send.await
    }

    /// `pending`, or the deadline's error once it passes (`on_dispatched_
    /// timeout` then runs when the request was sent).
    pub async fn wait<T>(
        &self,
        pending: impl Future<Output = Result<T, String>>,
        on_dispatched_timeout: Option<Box<dyn FnOnce() + Send>>,
    ) -> Result<T, String> {
        let wait = (self.expires_at - self.clock.now()).max(0) as u64;
        tokio::select! {
            outcome = pending => outcome,
            () = self.clock.sleep(Duration::from_millis(wait)) => {
                let error = self.error();
                if self.dispatched.load(Ordering::SeqCst)
                    && let Some(timeout) = on_dispatched_timeout
                {
                    timeout();
                }
                Err(error)
            }
        }
    }
}

/// A control call: method, params, timeout in milliseconds.
pub type CreationCall =
    Arc<dyn Fn(String, Value, u64) -> BoxFuture<Result<Value, String>> + Send + Sync>;

/// One empty-session bootstrap at a time per runtime: a second caller
/// checks again after the first (`createEmptyWorkspaceCreator`).
#[derive(Clone)]
pub struct EmptyWorkspaceCreator {
    call: CreationCall,
    lane: Arc<AsyncMutex<()>>,
}

impl EmptyWorkspaceCreator {
    pub fn new(call: CreationCall) -> Self {
        Self {
            call,
            lane: Arc::new(AsyncMutex::new(())),
        }
    }

    /// Creates the first workspace if the session is verified empty.
    /// The lane is held until Herdr's answer settles, even when the caller
    /// stopped waiting.
    pub fn create(
        &self,
        params: Map<String, Value>,
        is_current: Arc<dyn Fn() -> bool + Send + Sync>,
        deadline: CreationDeadline,
        validate_path: BoxFuture<Result<(), String>>,
    ) -> BoxFuture<Result<Value, String>> {
        let this = self.clone();
        let task = tokio::spawn(async move {
            let _lane = this.lane.clone().lock_owned().await;
            let check = || -> Result<(), String> {
                deadline.assert_before_dispatch()?;
                if !is_current() {
                    return Err("Creation connection changed. Reconnect and retry.".into());
                }
                Ok(())
            };
            check()?;
            let topology =
                (this.call)("workspace.list".into(), Value::Object(Map::new()), 5000).await?;
            let workspaces = topology
                .as_object()
                .filter(|topology| {
                    topology.get("type").and_then(Value::as_str) == Some("workspace_list")
                })
                .and_then(|topology| topology.get("workspaces"))
                .and_then(Value::as_array);
            let Some(workspaces) = workspaces else {
                return Err("Cannot verify an empty session. Refresh and retry creation.".into());
            };
            if !workspaces.is_empty() {
                return Err(
                    "Session is no longer empty. Open a terminal in the desired workspace and retry creation."
                        .into(),
                );
            }
            validate_path.await?;
            check()?;
            let mut creation = params;
            creation.insert("focus".into(), Value::Bool(false));
            creation.remove("browser_source");
            creation.remove("source_workspace_id");
            deadline
                .dispatch((this.call)(
                    "workspace.create".into(),
                    Value::Object(creation),
                    20_000,
                ))
                .await
        });
        Box::pin(async move {
            task.await
                .unwrap_or_else(|error| Err(format!("creation failed: {error}")))
        })
    }
}
