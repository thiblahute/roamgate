//! The terminal bridge (bridge/terminal-bridge.ts): browsers' terminals
//! over Herdr's endpoint generation 1 ([`session`], one cropped pane of a
//! shell's surface re-encoded as ANSI) or the legacy direct-terminal
//! client, shared between viewers, kept warm, cropped to each viewer, and
//! the connection's popup observer and clipboard relay ([`bridge`]).

pub mod bridge;
pub mod session;

use std::future::Future;
use std::sync::Arc;

use roamgate_base::log::LogFields;
use serde_json::Value;
use tokio::sync::{mpsc, oneshot};

use crate::frame_to_ansi::FrameData;

pub type BoxFuture<T> = std::pin::Pin<Box<dyn Future<Output = T> + Send + 'static>>;

/// A scrollback position a viewer's terminal draws (endpoint frames).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct History {
    pub revision: u64,
    pub top: u64,
    pub total: u64,
    pub cols: u64,
    pub rows: u64,
}

/// One frame of a terminal stream, as its viewers get it.
#[derive(Debug, Clone)]
pub struct TerminalFrame {
    pub link_frame: Option<String>,
    pub seq: u64,
    pub width: u64,
    pub height: u64,
    pub full: bool,
    pub mouse_reporting: Option<bool>,
    pub history: Option<History>,
    pub bytes: Arc<Vec<u8>>,
    /// The cropped cells (endpoint frames), drawn again for a smaller
    /// viewer.
    pub frame: Option<Arc<FrameData>>,
}

/// What a terminal stream tells the bridge.
#[derive(Debug, Clone)]
pub enum StreamEvent {
    Terminal(Arc<TerminalFrame>),
    Clipboard(String),
    Welcome {
        version: Value,
        encoding: u64,
        error: Option<String>,
    },
    Error(String),
    Close,
}

pub type StreamListener = Arc<dyn Fn(StreamEvent) + Send + Sync>;

type Job = Box<dyn FnOnce() -> BoxFuture<()> + Send>;

/// Work run one item at a time in the order it was asked for (a promise
/// chain's `.then`): an item starts once the previous one settled.
#[derive(Clone)]
pub struct Lane {
    jobs: mpsc::UnboundedSender<Job>,
}

impl Default for Lane {
    fn default() -> Self {
        Self::new()
    }
}

impl Lane {
    /// Needs a tokio runtime.
    pub fn new() -> Self {
        let (jobs, mut queue) = mpsc::unbounded_channel::<Job>();
        tokio::spawn(async move {
            while let Some(job) = queue.recv().await {
                job().await;
            }
        });
        Self { jobs }
    }

    /// Queues `job` now; its outcome once it ran (None when the lane went).
    pub fn run<T, F>(&self, job: F) -> BoxFuture<Option<T>>
    where
        T: Send + 'static,
        F: FnOnce() -> BoxFuture<T> + Send + 'static,
    {
        let (tx, rx) = oneshot::channel();
        let queued = self.jobs.send(Box::new(move || {
            Box::pin(async move {
                let _ = tx.send(job().await);
            })
        }));
        Box::pin(async move {
            if queued.is_err() {
                return None;
            }
            rx.await.ok()
        })
    }
}

/// A JSON object's fields for a log line.
pub(crate) fn log_fields(value: Value) -> LogFields {
    match value {
        Value::Object(map) => map,
        _ => LogFields::new(),
    }
}

/// `formatBytes`: bytes in B, KiB or MiB with one decimal.
pub(crate) fn format_bytes(bytes: u64) -> String {
    if bytes < 1024 {
        format!("{bytes}B")
    } else if bytes < 1024 * 1024 {
        format!("{:.1}KiB", bytes as f64 / 1024.0)
    } else {
        format!("{:.1}MiB", bytes as f64 / 1024.0 / 1024.0)
    }
}
