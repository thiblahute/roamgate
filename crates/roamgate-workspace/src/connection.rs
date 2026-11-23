//! What a workspace's code needs of its connection (the parts of
//! connections/runtime.ts each workspace helper was handed): the
//! connection's identity, where its commands run ([`GitContext`]: this
//! machine or its SSH host), its Herdr, the browsers it pushes events to,
//! and settings.json.
//!
//! Every handler of this crate takes a [`WorkspaceConnection`]; the core's
//! workspace family builds one per connection generation and backs its
//! traits with the channel (reverse calls into the front) in stage 1 of
//! the migration, and with the core's own services once it is the front.

use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use std::time::Duration;

use roamgate_base::settings::Settings;
use roamgate_git::GitContext;
use serde_json::Value;

pub type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

/// A handler's failure as the browser sees it: the TS `Error`'s message,
/// with a code when the TS gave one (`markRpcError`'s), and the HTTP
/// status of an HTTP route's answer.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{message}")]
pub struct WorkspaceError {
    pub message: String,
    pub code: Option<String>,
    pub status: Option<u16>,
}

impl WorkspaceError {
    pub fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            code: None,
            status: None,
        }
    }

    pub fn with_code(mut self, code: impl Into<String>) -> Self {
        self.code = Some(code.into());
        self
    }

    pub fn with_status(mut self, status: u16) -> Self {
        self.status = Some(status);
        self
    }
}

impl From<roamgate_git::GitError> for WorkspaceError {
    fn from(error: roamgate_git::GitError) -> Self {
        let status = error.status();
        Self {
            message: error.to_string(),
            code: None,
            status,
        }
    }
}

impl From<String> for WorkspaceError {
    fn from(message: String) -> Self {
        Self::new(message)
    }
}

impl From<&str> for WorkspaceError {
    fn from(message: &str) -> Self {
        Self::new(message)
    }
}

/// A browser RPC's answer.
pub type RpcResult = Result<Value, WorkspaceError>;

/// How a Herdr call is made (herdr-client.ts `call`'s timeout and
/// `{fresh}`).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct HerdrCallOptions {
    /// None: the client's default.
    pub timeout: Option<Duration>,
    /// Never a reused answer (creation checks Herdr's current state).
    pub fresh: bool,
}

impl HerdrCallOptions {
    pub fn timeout(timeout: Duration) -> Self {
        Self {
            timeout: Some(timeout),
            fresh: false,
        }
    }

    pub fn fresh(mut self) -> Self {
        self.fresh = true;
        self
    }
}

/// The connection's Herdr: its calls answer Herdr's `result`, or the
/// error's message as Herdr or the client gave it.
pub trait Herdr: Send + Sync {
    fn call(
        &self,
        method: &str,
        params: Value,
        options: HerdrCallOptions,
    ) -> BoxFuture<'_, Result<Value, String>>;
}

/// The browsers of the connection: `args.onEvent({event, data}, identity)`
/// of runtime.ts (a `workspace.git_status`, a `workspace.last_step_completed`).
pub trait ConnectionEvents: Send + Sync {
    fn emit(&self, event: &str, data: Value);
}

/// A change of settings.json: the next settings from the current ones,
/// or None to leave the file as it is.
pub type SettingsChange = Box<dyn FnOnce(&Settings) -> Option<Value> + Send>;

/// settings.json: read by anyone, written only through its one writer
/// (the settings family's store).
pub trait SettingsAccess: Send + Sync {
    fn read(&self) -> BoxFuture<'_, Arc<Settings>>;
    /// Applies `change` in the writer's slot; answers the settings as
    /// written (or as they were, when `change` gave None).
    fn update(&self, change: SettingsChange) -> BoxFuture<'_, Result<Arc<Settings>, String>>;
}

/// One generation of a connection, as the workspace's handlers see it.
#[derive(Clone)]
pub struct WorkspaceConnection {
    /// The connection's id (`local` for the legacy local connection).
    pub id: String,
    pub generation: u64,
    /// `linux`, `darwin`, `windows`... as the profile probe found it; None
    /// when unknown (local: this machine).
    pub remote_platform: Option<String>,
    /// Where its commands run: [`GitContext::host`] is the SSH host, None
    /// for this machine.
    pub git: GitContext,
    pub herdr: Arc<dyn Herdr>,
    pub events: Arc<dyn ConnectionEvents>,
    pub settings: Arc<dyn SettingsAccess>,
}

impl std::fmt::Debug for WorkspaceConnection {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("WorkspaceConnection")
            .field("id", &self.id)
            .field("generation", &self.generation)
            .field("remote_platform", &self.remote_platform)
            .field("host", &self.git.host)
            .finish()
    }
}

impl WorkspaceConnection {
    /// `sshHost()`: the connection's SSH destination, None when local.
    pub fn ssh_host(&self) -> Option<&str> {
        self.git.host()
    }

    /// Whether its host is Windows (`unixOnlyHandlers` refuses workspace
    /// file and Git access there).
    pub fn is_windows(&self) -> bool {
        self.remote_platform.as_deref() == Some("windows")
    }

    /// `herdr.call(method, params, timeout)`.
    pub async fn herdr_call(
        &self,
        method: &str,
        params: Value,
        timeout: Option<Duration>,
    ) -> Result<Value, String> {
        self.herdr
            .call(
                method,
                params,
                HerdrCallOptions {
                    timeout,
                    fresh: false,
                },
            )
            .await
    }
}

#[cfg(any(test, feature = "testing"))]
pub mod testing {
    //! A connection for the tests: this machine's runner, a Herdr that
    //! answers from a function, events and settings kept in memory.

    use std::sync::Mutex;

    use serde_json::json;

    use super::*;

    type Answer = dyn Fn(&str, &Value) -> Result<Value, String> + Send + Sync;

    /// A Herdr answering from a function, keeping each call.
    pub struct FakeHerdr {
        answer: Box<Answer>,
        pub calls: Mutex<Vec<(String, Value, HerdrCallOptions)>>,
    }

    impl FakeHerdr {
        pub fn new(
            answer: impl Fn(&str, &Value) -> Result<Value, String> + Send + Sync + 'static,
        ) -> Arc<Self> {
            Arc::new(Self {
                answer: Box::new(answer),
                calls: Mutex::new(Vec::new()),
            })
        }

        pub fn methods(&self) -> Vec<String> {
            self.calls
                .lock()
                .unwrap()
                .iter()
                .map(|(method, _, _)| method.clone())
                .collect()
        }
    }

    impl Herdr for FakeHerdr {
        fn call(
            &self,
            method: &str,
            params: Value,
            options: HerdrCallOptions,
        ) -> BoxFuture<'_, Result<Value, String>> {
            let answer = (self.answer)(method, &params);
            self.calls
                .lock()
                .unwrap()
                .push((method.to_owned(), params, options));
            Box::pin(async move { answer })
        }
    }

    /// Events kept in order.
    #[derive(Default)]
    pub struct KeptEvents(pub Mutex<Vec<(String, Value)>>);

    impl ConnectionEvents for KeptEvents {
        fn emit(&self, event: &str, data: Value) {
            self.0.lock().unwrap().push((event.to_owned(), data));
        }
    }

    /// settings.json in memory.
    pub struct MemorySettings(pub Mutex<Arc<Settings>>);

    impl MemorySettings {
        pub fn new(raw: Value) -> Arc<Self> {
            Arc::new(Self(Mutex::new(Arc::new(Settings::normalize(&raw)))))
        }
    }

    impl SettingsAccess for MemorySettings {
        fn read(&self) -> BoxFuture<'_, Arc<Settings>> {
            let settings = self.0.lock().unwrap().clone();
            Box::pin(async move { settings })
        }

        fn update(&self, change: SettingsChange) -> BoxFuture<'_, Result<Arc<Settings>, String>> {
            let mut settings = self.0.lock().unwrap();
            if let Some(next) = change(&settings) {
                *settings = Arc::new(Settings::normalize(&next));
            }
            let settings = settings.clone();
            Box::pin(async move { Ok(settings) })
        }
    }

    /// A local connection `local` on `herdr`, with empty settings.
    pub fn connection(herdr: Arc<dyn Herdr>) -> WorkspaceConnection {
        WorkspaceConnection {
            id: "local".into(),
            generation: 1,
            remote_platform: None,
            git: GitContext::local(Arc::new(roamgate_git::exec::LocalRunner::system())),
            herdr,
            events: Arc::new(KeptEvents::default()),
            settings: MemorySettings::new(json!({})),
        }
    }
}
