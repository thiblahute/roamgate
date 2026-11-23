//! The sidecar process and the Pi driver run in it
//! (contract/wire/pi-sidecar.md, Process and Messages): the Rust side of
//! server/src/assistant/pi-sidecar-client.ts.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, Mutex, Weak};
use std::time::Duration;

use roamgate_base::clock::{SharedClock, SystemClock};
use serde_json::{Map, Value, json};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::Command;
use tokio::sync::{mpsc, oneshot, watch};
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;

use crate::peer::{Peer, PeerHandlers};
use crate::protocol::{
    IDLE, Id, KILL_AFTER, MAX_LINE, PROTOCOL, RUN_CALLBACKS, RUN_HANDLERS, SIDECAR_ENV,
    sidecar_command,
};
use crate::{BoxFuture, PiError};

/// How to run the sidecar.
#[derive(Clone)]
pub struct SidecarConfig {
    pub argv: Vec<String>,
    /// Variables set for it on top of the server's environment (which it
    /// gets without `ROAMGATE_PI_SIDECAR`).
    pub envs: Vec<(String, String)>,
    /// With nothing in flight for this long, it is closed.
    pub idle: Duration,
    pub clock: SharedClock,
}

impl SidecarConfig {
    pub fn new(argv: Vec<String>) -> Self {
        Self {
            argv,
            envs: Vec::new(),
            idle: IDLE,
            clock: Arc::new(SystemClock),
        }
    }

    /// The sidecar `ROAMGATE_PI_SIDECAR` names (`value`), else
    /// `roamgate-pi` beside the server's executable `exe`, if it is there.
    pub fn from_env(value: Option<&str>, exe: Option<&Path>) -> Option<Self> {
        sidecar_command(value, "bun")
            .or_else(|| {
                let name = if cfg!(windows) {
                    "roamgate-pi.exe"
                } else {
                    "roamgate-pi"
                };
                let beside: PathBuf = exe?.parent()?.join(name);
                beside
                    .is_file()
                    .then(|| vec![beside.to_string_lossy().into_owned()])
            })
            .map(Self::new)
    }
}

/// What a request's reverse requests and notifications reach.
trait Route: Send + Sync {
    fn request(
        &self,
        method: &str,
        params: Value,
        cancel: CancellationToken,
    ) -> BoxFuture<Result<Value, PiError>>;
    fn notification(&self, _method: &str, _params: Value) {}
}

type Routes = Arc<Mutex<HashMap<Id, Arc<dyn Route>>>>;

struct Running {
    peer: Peer,
    routes: Routes,
    /// Closes the sidecar's stdin.
    close: CancellationToken,
    kill: Mutex<Option<oneshot::Sender<()>>>,
    exited: watch::Receiver<bool>,
    pid: Option<u32>,
}

struct RoutedHandlers {
    routes: Routes,
}

fn request_id(params: &Value) -> Option<Id> {
    match params.get("request")? {
        Value::Number(number) => number.as_i64().map(Id::Num),
        Value::String(text) => Some(Id::Str(text.clone())),
        _ => None,
    }
}

impl PeerHandlers for RoutedHandlers {
    fn request(
        &self,
        method: String,
        params: Value,
        cancel: CancellationToken,
    ) -> BoxFuture<Result<Value, PiError>> {
        let route = request_id(&params)
            .and_then(|id| self.routes.lock().expect("routes").get(&id).cloned());
        match route {
            Some(route) => route.request(&method, params, cancel),
            None => {
                Box::pin(async move { Err(PiError::failed(format!("No request for {method}"))) })
            }
        }
    }

    fn notification(&self, method: &str, params: Value) {
        let route = request_id(&params)
            .and_then(|id| self.routes.lock().expect("routes").get(&id).cloned());
        if let Some(route) = route {
            route.notification(method, params);
        }
    }
}

struct Inner {
    config: SidecarConfig,
    state: tokio::sync::Mutex<Option<Arc<Running>>>,
    current: Mutex<Option<Arc<Running>>>,
    idle: Mutex<Option<JoinHandle<()>>>,
}

/// The sidecar: one per server, shared by every Ranger directory.
#[derive(Clone)]
pub struct PiSidecar {
    inner: Arc<Inner>,
}

impl PiSidecar {
    pub fn new(config: SidecarConfig) -> Self {
        Self {
            inner: Arc::new(Inner {
                config,
                state: tokio::sync::Mutex::new(None),
                current: Mutex::new(None),
                idle: Mutex::new(None),
            }),
        }
    }

    /// Whether a sidecar process is running.
    pub fn running(&self) -> bool {
        self.inner
            .current
            .lock()
            .expect("current")
            .as_ref()
            .is_some_and(|running| !running.peer.is_closed())
    }

    /// The running sidecar's process id.
    pub fn pid(&self) -> Option<u32> {
        self.inner
            .current
            .lock()
            .expect("current")
            .as_ref()
            .and_then(|running| running.pid)
    }

    fn spawn(&self) -> Result<Arc<Running>, PiError> {
        let config = &self.inner.config;
        let (program, args) = config
            .argv
            .split_first()
            .ok_or_else(|| PiError::Closed("No Pi sidecar to run".into()))?;
        let mut command = Command::new(program);
        command
            .args(args)
            .env_remove(SIDECAR_ENV)
            .envs(config.envs.iter().map(|(key, value)| (key, value)))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .kill_on_drop(true);
        let mut child = command
            .spawn()
            .map_err(|error| PiError::Closed(format!("The Pi sidecar could not start: {error}")))?;
        let pid = child.id();
        let mut stdin = child.stdin.take().expect("piped stdin");
        let stdout = child.stdout.take().expect("piped stdout");
        let (out, mut lines) = mpsc::unbounded_channel::<String>();
        let routes: Routes = Arc::default();
        let peer = Peer::new(
            out,
            Arc::new(RoutedHandlers {
                routes: routes.clone(),
            }),
        );
        let close = CancellationToken::new();
        let closing = close.clone();
        tokio::spawn(async move {
            loop {
                tokio::select! {
                    line = lines.recv() => match line {
                        Some(line) => {
                            if stdin.write_all(line.as_bytes()).await.is_err() || stdin.flush().await.is_err() {
                                break;
                            }
                        }
                        None => break,
                    },
                    () = closing.cancelled() => break,
                }
            }
            let _ = stdin.shutdown().await;
        });
        let reading = peer.clone();
        let reader = tokio::spawn(async move {
            let mut stdout = BufReader::new(stdout);
            let mut line = Vec::new();
            let mut skipping = false;
            loop {
                let buffer = match stdout.fill_buf().await {
                    Ok([]) | Err(_) => break,
                    Ok(buffer) => buffer,
                };
                let (taken, end) = match buffer.iter().position(|byte| *byte == b'\n') {
                    Some(at) => (at + 1, true),
                    None => (buffer.len(), false),
                };
                if !skipping {
                    line.extend_from_slice(&buffer[..taken - usize::from(end)]);
                }
                stdout.consume(taken);
                if !skipping && line.len() > MAX_LINE {
                    tracing::warn!(target: "assistant", "Pi sidecar: a line longer than 64 MiB was dropped");
                    line.clear();
                    skipping = true;
                }
                if end {
                    if !skipping {
                        reading.receive(&String::from_utf8_lossy(&line));
                    }
                    line.clear();
                    skipping = false;
                }
            }
            if !line.is_empty() && !skipping {
                reading.receive(&String::from_utf8_lossy(&line));
            }
        });
        let (kill, killed) = oneshot::channel::<()>();
        let (exited_sender, exited) = watch::channel(false);
        let running = Arc::new(Running {
            peer: peer.clone(),
            routes,
            close,
            kill: Mutex::new(Some(kill)),
            exited,
            pid,
        });
        let weak: Weak<Inner> = Arc::downgrade(&self.inner);
        let watched = Arc::downgrade(&running);
        tokio::spawn(async move {
            let status = tokio::select! {
                status = child.wait() => status,
                _ = killed => {
                    let _ = child.start_kill();
                    child.wait().await
                }
            };
            let _ = reader.await;
            let code = status
                .ok()
                .and_then(|status| status.code())
                .map_or_else(|| "signal".to_owned(), |code| code.to_string());
            peer.close(PiError::Closed(format!("The Pi sidecar exited ({code})")));
            if let (Some(inner), Some(running)) = (weak.upgrade(), watched.upgrade()) {
                let mut current = inner.current.lock().expect("current");
                if current
                    .as_ref()
                    .is_some_and(|now| Arc::ptr_eq(now, &running))
                {
                    *current = None;
                }
            }
            let _ = exited_sender.send(true);
        });
        Ok(running)
    }

    async fn ensure(&self) -> Result<Arc<Running>, PiError> {
        let mut state = self.inner.state.lock().await;
        if let Some(running) = state.as_ref()
            && !running.peer.is_closed()
        {
            return Ok(running.clone());
        }
        let running = self.spawn()?;
        *self.inner.current.lock().expect("current") = Some(running.clone());
        *state = Some(running.clone());
        let ready = running
            .peer
            .request("initialize", json!({ "protocol": PROTOCOL }))
            .await;
        if let Err(error) = ready {
            *state = None;
            drop(state);
            Self::end(&running, &self.inner.config).await;
            return Err(error);
        }
        Ok(running)
    }

    fn cancel_idle(&self) {
        if let Some(timer) = self.inner.idle.lock().expect("idle").take() {
            timer.abort();
        }
    }

    fn arm_idle(&self, running: &Arc<Running>) {
        if running.peer.busy() > 0 || running.peer.is_closed() {
            return;
        }
        let sidecar = self.clone();
        let running = running.clone();
        let sleep = self.inner.config.clock.sleep(self.inner.config.idle);
        let timer = tokio::spawn(async move {
            sleep.await;
            if running.peer.busy() > 0 {
                return;
            }
            let mut state = sidecar.inner.state.lock().await;
            if state.as_ref().is_some_and(|now| Arc::ptr_eq(now, &running)) {
                *state = None;
                drop(state);
                Self::end(&running, &sidecar.inner.config).await;
            }
        });
        if let Some(previous) = self.inner.idle.lock().expect("idle").replace(timer) {
            previous.abort();
        }
    }

    /// Closes the sidecar's stdin, kills it three seconds later if it is
    /// still there, and waits for it to exit.
    async fn end(running: &Arc<Running>, config: &SidecarConfig) {
        running.close.cancel();
        let mut exited = running.exited.clone();
        let wait = exited.wait_for(|exited| *exited);
        let late = config.clock.sleep(KILL_AFTER);
        tokio::select! {
            _ = wait => return,
            () = late => {}
        }
        if let Some(kill) = running.kill.lock().expect("kill").take() {
            let _ = kill.send(());
        }
        let _ = running.exited.clone().wait_for(|exited| *exited).await;
    }

    /// Ends the sidecar, if it runs.
    pub async fn close(&self) {
        self.cancel_idle();
        let running = self.inner.state.lock().await.take();
        if let Some(running) = running {
            Self::end(&running, &self.inner.config).await;
        }
    }

    /// Kills the sidecar at once, as a crash would.
    pub fn kill(&self) {
        let running = self.inner.current.lock().expect("current").clone();
        if let Some(running) = running
            && let Some(kill) = running.kill.lock().expect("kill").take()
        {
            let _ = kill.send(());
        }
    }

    /// A request by name, for what [`PiDriver`] does not wrap.
    pub async fn request(&self, method: &str, params: Value) -> Result<Value, PiError> {
        self.call(method, params, None, None).await
    }

    async fn call(
        &self,
        method: &str,
        params: Value,
        cancel: Option<CancellationToken>,
        route: Option<Arc<dyn Route>>,
    ) -> Result<Value, PiError> {
        self.cancel_idle();
        let running = self.ensure().await?;
        let id = running.peer.reserve();
        if let Some(route) = route {
            running
                .routes
                .lock()
                .expect("routes")
                .insert(id.clone(), route);
        }
        let reply = running
            .peer
            .request_with(id.clone(), method, params, cancel)
            .await;
        running.routes.lock().expect("routes").remove(&id);
        self.arm_idle(&running);
        reply
    }
}

/// What a run reports (`run.event`).
#[derive(Debug, Clone, PartialEq)]
pub enum RunEvent {
    Delta(String),
    Message(String),
    Tool {
        id: String,
        name: String,
        /// `running`, `completed` or `failed`.
        status: String,
        /// `{arguments, output}` when Pi has them.
        details: Option<Value>,
    },
    Error,
    Replace(String),
    Thinking(Vec<String>),
    Sources(Value),
    Steered {
        request_id: Option<String>,
        text: String,
    },
}

impl RunEvent {
    fn parse(kind: &str, args: &[Value]) -> Option<Self> {
        let text = |at: usize| args.get(at).and_then(Value::as_str).map(str::to_owned);
        Some(match kind {
            "delta" => Self::Delta(text(0)?),
            "message" => Self::Message(text(0)?),
            "tool" => Self::Tool {
                id: text(0)?,
                name: text(1)?,
                status: text(2)?,
                details: args.get(3).filter(|value| !value.is_null()).cloned(),
            },
            "error" => Self::Error,
            "replace" => Self::Replace(text(0)?),
            "thinking" => Self::Thinking(
                args.first()?
                    .as_array()?
                    .iter()
                    .filter_map(|step| step.as_str().map(str::to_owned))
                    .collect(),
            ),
            "sources" => Self::Sources(args.first()?.clone()),
            "steered" => Self::Steered {
                request_id: text(0),
                text: text(1)?,
            },
            _ => return None,
        })
    }
}

/// A run's callbacks and tool handlers, answered by the server.
pub trait RunHandler: Send + Sync + 'static {
    /// The optional callbacks it has, of [`RUN_CALLBACKS`]: Pi changes what
    /// it reports by their presence (`replace` instead of `delta`).
    fn callbacks(&self) -> Vec<&'static str> {
        Vec::new()
    }
    /// Its tool handlers besides `read`, of [`RUN_HANDLERS`]: Pi offers the
    /// tools of these only.
    fn handlers(&self) -> Vec<&'static str> {
        Vec::new()
    }
    fn event(&self, event: RunEvent);
    /// Saves the entries to keep; Pi admits the turn only once this is done.
    fn checkpoint(&self, _entries: Vec<Value>) -> BoxFuture<Result<(), PiError>> {
        Box::pin(async { Ok(()) })
    }
    /// A tool call: `handler` with its arguments (a kind and parameters, or
    /// parameters alone), answered with `{text, sources?}`.
    fn tool(
        &self,
        handler: &str,
        args: Vec<Value>,
        cancel: CancellationToken,
    ) -> BoxFuture<Result<Value, PiError>>;
}

/// What the user does in a provider login.
pub trait LoginInteraction: Send + Sync + 'static {
    /// A step to answer: `{type, message, options?}`.
    fn prompt(
        &self,
        prompt: Value,
        cancel: CancellationToken,
    ) -> BoxFuture<Result<String, PiError>>;
    /// Progress to show: `{type: info|progress|auth_url|device_code, ...}`.
    fn event(&self, event: Value);
}

/// Writes models.json (`path`, `value`); Pi reads it back once it returns.
pub type SaveModels = Arc<dyn Fn(String, Value) -> BoxFuture<Result<(), PiError>> + Send + Sync>;

/// A run's input (`AssistantDriver.run` without its callbacks).
#[derive(Debug, Clone, Default)]
pub struct RunInput {
    pub config: Value,
    pub entries: Vec<Value>,
    pub text: String,
    pub request_id: Option<String>,
    pub recover: bool,
    /// `{requestId, text}` of the steers already sent to this turn.
    pub steers: Option<Vec<Value>>,
}

struct RunRoute {
    handler: Arc<dyn RunHandler>,
    handlers: Vec<&'static str>,
}

impl Route for RunRoute {
    fn request(
        &self,
        method: &str,
        params: Value,
        cancel: CancellationToken,
    ) -> BoxFuture<Result<Value, PiError>> {
        match method {
            "run.checkpoint" => {
                let entries = params
                    .get("entries")
                    .and_then(Value::as_array)
                    .cloned()
                    .unwrap_or_default();
                let done = self.handler.checkpoint(entries);
                Box::pin(async move { done.await.map(|()| Value::Null) })
            }
            "run.tool" => {
                let name = params.get("handler").and_then(Value::as_str).unwrap_or("");
                if !self.handlers.contains(&name) {
                    return Box::pin(async { Err(PiError::failed("Unknown tool handler")) });
                }
                let args = params
                    .get("args")
                    .and_then(Value::as_array)
                    .cloned()
                    .unwrap_or_default();
                self.handler.tool(name, args, cancel)
            }
            other => {
                let message = format!("Unexpected {other}");
                Box::pin(async move { Err(PiError::failed(message)) })
            }
        }
    }

    fn notification(&self, method: &str, params: Value) {
        if method != "run.event" {
            return;
        }
        let kind = params.get("type").and_then(Value::as_str).unwrap_or("");
        let args = params
            .get("args")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        if let Some(event) = RunEvent::parse(kind, &args) {
            self.handler.event(event);
        }
    }
}

struct LoginRoute {
    interaction: Arc<dyn LoginInteraction>,
}

impl Route for LoginRoute {
    fn request(
        &self,
        method: &str,
        params: Value,
        cancel: CancellationToken,
    ) -> BoxFuture<Result<Value, PiError>> {
        if method != "login.prompt" {
            let message = format!("Unexpected {method}");
            return Box::pin(async move { Err(PiError::failed(message)) });
        }
        let answer = self
            .interaction
            .prompt(params.get("prompt").cloned().unwrap_or(Value::Null), cancel);
        Box::pin(async move { answer.await.map(Value::String) })
    }

    fn notification(&self, method: &str, params: Value) {
        if method == "login.event"
            && let Some(event) = params.get("event")
        {
            self.interaction.event(event.clone());
        }
    }
}

struct SaveRoute {
    save: SaveModels,
}

impl Route for SaveRoute {
    fn request(
        &self,
        method: &str,
        params: Value,
        _cancel: CancellationToken,
    ) -> BoxFuture<Result<Value, PiError>> {
        if method != "configure_model.save" {
            let message = format!("Unexpected {method}");
            return Box::pin(async move { Err(PiError::failed(message)) });
        }
        let path = params
            .get("path")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned();
        let done = (self.save)(path, params.get("value").cloned().unwrap_or(Value::Null));
        Box::pin(async move { done.await.map(|()| Value::Null) })
    }
}

/// Pi for one Ranger directory, run in the sidecar.
#[derive(Clone)]
pub struct PiDriver {
    sidecar: PiSidecar,
    directory: String,
    credential_directory: String,
}

impl PiDriver {
    /// `credential_directory` is where auth.json and models.json are: the
    /// chat's directory for a task run's driver.
    pub fn new(sidecar: PiSidecar, directory: &str, credential_directory: Option<&str>) -> Self {
        Self {
            sidecar,
            directory: directory.to_owned(),
            credential_directory: credential_directory.unwrap_or(directory).to_owned(),
        }
    }

    fn params(&self, extra: Value) -> Value {
        let mut params = Map::new();
        params.insert("directory".into(), json!(self.directory));
        params.insert(
            "credential_directory".into(),
            json!(self.credential_directory),
        );
        if let Value::Object(extra) = extra {
            params.extend(extra);
        }
        Value::Object(params)
    }

    /// `{providers, models}` of a credential source (`assistant` or `pi`).
    pub async fn catalog(&self, source: &str) -> Result<Value, PiError> {
        self.sidecar
            .call(
                "catalog",
                self.params(json!({ "source": source })),
                None,
                None,
            )
            .await
    }

    pub async fn configure_model(&self, input: Value, save: SaveModels) -> Result<(), PiError> {
        self.sidecar
            .call(
                "configure_model",
                self.params(json!({ "input": input })),
                None,
                Some(Arc::new(SaveRoute { save })),
            )
            .await
            .map(|_| ())
    }

    pub async fn read_tool_details(
        &self,
        entries: Vec<Value>,
        messages: Value,
        source_directory: Option<&str>,
    ) -> Result<Value, PiError> {
        let mut extra = json!({ "entries": entries, "messages": messages });
        if let Some(source) = source_directory {
            extra["source_directory"] = json!(source);
        }
        self.sidecar
            .call("read_tool_details", self.params(extra), None, None)
            .await
    }

    /// `method` is `api_key` or `oauth`; `cancel` cancels the login.
    pub async fn login(
        &self,
        provider: &str,
        method: &str,
        credential_source: &str,
        interaction: Arc<dyn LoginInteraction>,
        cancel: CancellationToken,
    ) -> Result<(), PiError> {
        self.sidecar
            .call(
                "login",
                self.params(json!({
                    "provider": provider,
                    "method": method,
                    "credential_source": credential_source,
                })),
                Some(cancel),
                Some(Arc::new(LoginRoute { interaction })),
            )
            .await
            .map(|_| ())
    }

    /// A turn: the entries to keep. `cancel` stops it in Pi.
    pub async fn run(
        &self,
        input: RunInput,
        handler: Arc<dyn RunHandler>,
        cancel: CancellationToken,
    ) -> Result<Vec<Value>, PiError> {
        let callbacks: Vec<&'static str> = RUN_CALLBACKS
            .into_iter()
            .filter(|name| handler.callbacks().contains(name))
            .collect();
        let mut handlers: Vec<&'static str> = RUN_HANDLERS
            .into_iter()
            .filter(|name| *name != "read" && handler.handlers().contains(name))
            .collect();
        let mut run = Map::new();
        run.insert("config".into(), input.config);
        run.insert("entries".into(), Value::Array(input.entries));
        run.insert("text".into(), json!(input.text));
        if let Some(request_id) = input.request_id {
            run.insert("request_id".into(), json!(request_id));
        }
        if input.recover {
            run.insert("recover".into(), json!(true));
        }
        if let Some(steers) = input.steers {
            run.insert("steers".into(), Value::Array(steers));
        }
        let params = self.params(json!({
            "input": run,
            "callbacks": callbacks,
            "handlers": handlers,
        }));
        handlers.push("read");
        let result = self
            .sidecar
            .call(
                "run",
                params,
                Some(cancel),
                Some(Arc::new(RunRoute { handler, handlers })),
            )
            .await?;
        match result {
            Value::Array(entries) => Ok(entries),
            _ => Err(PiError::failed("Invalid run result")),
        }
    }

    /// Adds input to the running turn; fails when no turn takes it.
    pub async fn steer(&self, text: &str, request_id: &str) -> Result<(), PiError> {
        self.sidecar
            .call(
                "steer",
                self.params(json!({ "text": text, "request_id": request_id })),
                None,
                None,
            )
            .await
            .map(|_| ())
    }

    /// Stops the running turn, if the sidecar runs.
    pub async fn stop(&self) -> Result<(), PiError> {
        if !self.sidecar.running() {
            return Ok(());
        }
        self.sidecar
            .call("stop", self.params(json!({})), None, None)
            .await
            .map(|_| ())
    }

    /// Pauses the turn and forgets the driver, if the sidecar runs.
    pub async fn dispose(&self) -> Result<(), PiError> {
        if !self.sidecar.running() {
            return Ok(());
        }
        self.sidecar
            .call("dispose", self.params(json!({})), None, None)
            .await
            .map(|_| ())
    }
}

#[cfg(test)]
mod tests {
    use super::SidecarConfig;

    #[test]
    fn ranger_uses_the_sidecar_only_when_roamgate_pi_sidecar_names_it() {
        let dir = tempfile::tempdir().unwrap();
        let exe = dir.path().join("roamgate");
        let argv = |config: Option<SidecarConfig>| config.map(|config| config.argv);
        // Named: a script runs with bun, anything else is the executable.
        assert_eq!(
            argv(SidecarConfig::from_env(Some("/x/roamgate-pi"), Some(&exe))),
            Some(vec!["/x/roamgate-pi".to_owned()])
        );
        assert_eq!(
            argv(SidecarConfig::from_env(
                Some("/src/pi-sidecar-main.ts"),
                None
            )),
            Some(vec!["bun".to_owned(), "/src/pi-sidecar-main.ts".to_owned()])
        );
        // Not named: roamgate-pi beside the server, only when it is there.
        assert_eq!(argv(SidecarConfig::from_env(None, Some(&exe))), None);
        assert_eq!(argv(SidecarConfig::from_env(Some(""), Some(&exe))), None);
        let beside = dir.path().join(if cfg!(windows) {
            "roamgate-pi.exe"
        } else {
            "roamgate-pi"
        });
        std::fs::write(&beside, "").unwrap();
        assert_eq!(
            argv(SidecarConfig::from_env(None, Some(&exe))),
            Some(vec![beside.to_string_lossy().into_owned()])
        );
        assert_eq!(argv(SidecarConfig::from_env(None, None)), None);
    }
}
