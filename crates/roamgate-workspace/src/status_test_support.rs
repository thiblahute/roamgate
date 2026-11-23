//! Runners and connections for this crate's tests.

use std::collections::VecDeque;
use std::sync::{Arc, Mutex};

use roamgate_git::exec::{RunFuture, Runner};
use roamgate_git::{GitContext, Ran, Request, RunError};
use serde_json::Value;
use tokio::sync::oneshot;

use crate::connection::testing::{FakeHerdr, KeptEvents, MemorySettings};
use crate::connection::{Herdr, WorkspaceConnection};

/// A run waiting for its answer.
pub struct PendingRun {
    pub request: Request,
    reply: Mutex<Option<oneshot::Sender<Result<Ran, RunError>>>>,
}

impl PendingRun {
    pub fn resolve(&self, ran: Ran) {
        if let Some(reply) = self.reply.lock().unwrap().take() {
            let _ = reply.send(Ok(ran));
        }
    }

    pub fn reject(&self, error: &str) {
        if let Some(reply) = self.reply.lock().unwrap().take() {
            let _ = reply.send(Err(RunError(error.into())));
        }
    }

    /// The local argv, or the ssh command line as its last word.
    pub fn words(&self) -> Vec<String> {
        match &self.request.invocation {
            roamgate_git::Invocation::Local(argv) => argv.clone(),
            roamgate_git::Invocation::Ssh { command, .. } => {
                vec!["ssh".into(), command.clone()]
            }
        }
    }
}

/// A runner whose runs wait until the test answers them.
#[derive(Default)]
pub struct Deferred {
    pub runs: Mutex<Vec<Arc<PendingRun>>>,
}

impl Deferred {
    pub fn run(&self, index: usize) -> Arc<PendingRun> {
        self.runs.lock().unwrap()[index].clone()
    }

    pub fn count(&self) -> usize {
        self.runs.lock().unwrap().len()
    }
}

impl Runner for Deferred {
    fn run(&self, request: Request) -> RunFuture<'_> {
        let (sender, receiver) = oneshot::channel();
        self.runs.lock().unwrap().push(Arc::new(PendingRun {
            request,
            reply: Mutex::new(Some(sender)),
        }));
        Box::pin(async move {
            receiver
                .await
                .unwrap_or_else(|_| Err(RunError("dropped".into())))
        })
    }
}

/// A runner answering from a queue, keeping each command's last word.
pub struct Queue {
    pub answers: Mutex<VecDeque<Ran>>,
    pub commands: Mutex<Vec<String>>,
}

impl Queue {
    pub fn new(answers: Vec<Ran>) -> Arc<Self> {
        Arc::new(Self {
            answers: Mutex::new(answers.into()),
            commands: Mutex::new(Vec::new()),
        })
    }

    pub fn commands(&self) -> Vec<String> {
        self.commands.lock().unwrap().clone()
    }
}

impl Runner for Queue {
    fn run(&self, request: Request) -> RunFuture<'_> {
        let last = match &request.invocation {
            roamgate_git::Invocation::Local(argv) => argv.last().cloned().unwrap_or_default(),
            roamgate_git::Invocation::Ssh { command, .. } => command.clone(),
        };
        self.commands.lock().unwrap().push(last);
        let answer = self.answers.lock().unwrap().pop_front();
        Box::pin(async move { answer.ok_or_else(|| RunError("unexpected process call".into())) })
    }
}

/// A connection `id` on `runner` (SSH to `host` when given), with these
/// settings and a Herdr that answers nothing.
pub fn connection(
    id: &str,
    host: Option<&str>,
    runner: Arc<dyn Runner>,
    herdr: Option<Arc<dyn Herdr>>,
    settings: Value,
) -> (WorkspaceConnection, Arc<KeptEvents>, Arc<MemorySettings>) {
    let events = Arc::new(KeptEvents::default());
    let settings = MemorySettings::new(settings);
    let herdr = herdr.unwrap_or_else(|| FakeHerdr::new(|_, _| Ok(Value::Null)));
    (
        WorkspaceConnection {
            id: id.into(),
            generation: 1,
            remote_platform: None,
            git: GitContext::new(host.map(str::to_owned), runner),
            herdr,
            events: events.clone(),
            settings: settings.clone(),
        },
        events,
        settings,
    )
}

/// Lets the other tasks run.
pub async fn settle() {
    for _ in 0..20 {
        tokio::task::yield_now().await;
    }
}
