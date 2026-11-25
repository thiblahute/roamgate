//! The agent socket's server (review/agent-server.ts's
//! createReviewAgentServer): HTTP over a unix listener per connection, JSON
//! in and out, for the review client, the Claude mod and conversation
//! mode's holder.

use std::collections::HashMap;
use std::convert::Infallible;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use bytes::Bytes;
use http_body_util::{BodyExt, Full, Limited};
use hyper::body::Incoming;
use hyper::{Request, Response, StatusCode};
use hyper_util::rt::TokioIo;
use roamgate_claude::mod_hub::{
    AckInput, ClaudeModError, ClaudeModHub, EventInput, PollInput, ToolsInput,
};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use super::form::{Form, automatic_target, form_of, parse_questions, parse_target_flags};
use super::host::{AgentConnection, AgentSocketHost, HostError};
use super::output::{not_held, session_output, thread_output};
use super::texts::REVIEW_SKILL;
use super::{
    HOLD_OUTPUT_MAX_BODY_BYTES, LOCAL_SOCKET_KEY, REVIEW_AGENT_MAX_BODY_BYTES,
    REVIEW_AGENT_MAX_WATCHES, REVIEW_HOME_DIR,
};
use crate::error::{ReviewError, ReviewResult};
use crate::model::{REVIEW_USER, ReviewSession, ReviewSnapshot, ReviewTarget, thread_needs_answer};
use crate::prompts::PermissionRequest;
use crate::rendered_target::rendered_file_target;
use crate::service::ReviewService;

/// One exchange on the socket, for record mode (contract-record's hook).
#[derive(Debug, Clone)]
pub struct AgentExchange {
    pub socket_key: String,
    pub command: String,
    pub body: String,
    pub status: u16,
    pub response: String,
}

pub type ExchangeFn = Arc<dyn Fn(&AgentExchange) + Send + Sync>;

/// How the agent socket is made.
pub struct AgentSocketOptions {
    pub service: ReviewService,
    /// The bridge's private directory for sockets: they go in `agent/`.
    pub directory: PathBuf,
    /// Where the client, the skill and the well-known link go.
    pub home: PathBuf,
    pub host: Arc<dyn AgentSocketHost>,
    /// Roamgate's Claude Code mod: `mod_poll`, `mod_ack`, `mod_event`,
    /// `mod_tools` (its hub, or what answers for it).
    pub claude_mod: Option<Arc<dyn ClaudeMods>>,
    /// Each exchange, as record mode keeps them.
    pub on_exchange: Option<ExchangeFn>,
}

struct Listening {
    path: PathBuf,
    task: tokio::task::JoinHandle<()>,
}

struct Inner {
    service: ReviewService,
    host: Arc<dyn AgentSocketHost>,
    claude_mod: Option<Arc<dyn ClaudeMods>>,
    on_exchange: Option<ExchangeFn>,
    home: PathBuf,
    socket_directory: PathBuf,
    servers: Mutex<HashMap<String, Listening>>,
    /// Watches in progress, by review.
    watches: Mutex<HashMap<String, usize>>,
    /// The well-known link, when it still points at this bridge.
    linked: Mutex<Option<PathBuf>>,
}

/// The agent socket: cheap to clone. Its listeners run on the tokio runtime
/// `listen` is called on.
#[derive(Clone)]
pub struct AgentSocket(Arc<Inner>);

fn review_error(error: HostError, fallback: u16) -> ReviewError {
    ReviewError::status(error.message, error.status.unwrap_or(fallback))
}

fn mod_error(error: ClaudeModError) -> ReviewError {
    ReviewError::status(error.message, error.status)
}

/// Two names of one Herdr socket: the same path, or links to one file.
fn same_socket(configured: Option<&str>, named: &str) -> bool {
    let Some(configured) = configured else {
        return false;
    };
    if configured == named {
        return true;
    }
    match (
        std::fs::canonicalize(configured),
        std::fs::canonicalize(named),
    ) {
        (Ok(a), Ok(b)) => a == b,
        _ => false,
    }
}

fn int_param(value: Option<&str>, field: &str) -> ReviewResult<Option<i64>> {
    let Some(value) = value.filter(|v| !v.is_empty()) else {
        return Ok(None);
    };
    let parsed = roamgate_agents::js::number_from_text(value);
    if !parsed.is_finite() || parsed.fract() != 0.0 || parsed < 1.0 {
        return Err(ReviewError::new(format!("invalid {field}")));
    }
    Ok(Some(parsed as i64))
}

fn number(form: &Form, key: &str, default: Option<&str>) -> f64 {
    roamgate_agents::js::number_from_text(form.get(key).or(default).unwrap_or(""))
}

/// `Number(form.get(key))`: null (absent) is 0, as JavaScript reads it.
fn number_of(form: &Form, key: &str) -> f64 {
    match form.get(key) {
        None => 0.0,
        Some(text) => roamgate_agents::js::number_from_text(text),
    }
}

fn session_id_ok(text: &str) -> bool {
    (8..=64).contains(&text.len()) && text.chars().all(|c| c.is_ascii_hexdigit() || c == '-')
}

fn json_response(value: &Value, status: u16) -> Response<Full<Bytes>> {
    Response::builder()
        .status(StatusCode::from_u16(status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR))
        .header("content-type", "application/json")
        .body(Full::new(Bytes::from(
            roamgate_agents::js::stringify_pretty(value),
        )))
        .expect("a valid response")
}

/// Ends a prompt when the request that waits on it goes away.
struct DropSignal(Option<tokio::sync::oneshot::Sender<()>>);

impl Drop for DropSignal {
    fn drop(&mut self) {
        if let Some(send) = self.0.take() {
            let _ = send.send(());
        }
    }
}

/// Counts a watch in progress until it ends, however it ends.
struct WatchSlot {
    socket: AgentSocket,
    session: String,
}

impl Drop for WatchSlot {
    fn drop(&mut self) {
        let mut watches = self.socket.0.watches.lock().unwrap();
        let left = watches
            .get(&self.session)
            .copied()
            .unwrap_or(1)
            .saturating_sub(1);
        if left > 0 {
            watches.insert(self.session.clone(), left);
        } else {
            watches.remove(&self.session);
        }
    }
}

impl AgentSocket {
    pub fn new(options: AgentSocketOptions) -> Self {
        Self(Arc::new(Inner {
            service: options.service,
            host: options.host,
            claude_mod: options.claude_mod,
            on_exchange: options.on_exchange,
            socket_directory: options.directory.join("agent"),
            home: options.home,
            servers: Mutex::default(),
            watches: Mutex::default(),
            linked: Mutex::default(),
        }))
    }
}

/// Where a key's socket is under the sockets' directory: Unix socket paths
/// are short (104 bytes on macOS), so the key is hashed.
pub fn socket_path_in(directory: &Path, key: &str) -> PathBuf {
    let name = &hex::encode(Sha256::digest(key.as_bytes()))[..16];
    directory.join(format!("{name}.sock"))
}

impl AgentSocket {
    /// Where the sockets are.
    pub fn directory(&self) -> &Path {
        &self.0.socket_directory
    }

    /// The socket of a key, listening or not. Unix socket paths are short
    /// (104 bytes on macOS): the key is hashed.
    /// On Windows this host's is the well-known `review.sock` itself:
    /// `AF_UNIX` there does not follow a link to a socket.
    pub fn socket_path_for(&self, key: &str) -> PathBuf {
        #[cfg(windows)]
        if key == LOCAL_SOCKET_KEY {
            return self.0.home.join(REVIEW_HOME_DIR).join("review.sock");
        }
        socket_path_in(&self.0.socket_directory, key)
    }

    /// The socket a key listens on.
    pub fn socket_path(&self, key: &str) -> Option<PathBuf> {
        self.0
            .servers
            .lock()
            .unwrap()
            .get(key)
            .map(|entry| entry.path.clone())
    }

    /// Whether a key's socket listens.
    pub fn exists(&self, key: &str) -> bool {
        self.socket_path_for(key).exists() && self.0.servers.lock().unwrap().contains_key(key)
    }

    /// Listens for a connection's agents (`@local`: this host's, else an SSH
    /// connection's, forwarded there). Needs a tokio runtime.
    pub fn listen(&self, socket_key: &str) -> std::io::Result<PathBuf> {
        self.listen_at(socket_key, false)
    }

    /// Listens beside a key's socket, at a path [`AgentSocket::commit`]
    /// later moves over it: the server serving it until then keeps it.
    pub fn listen_staged(&self, socket_key: &str) -> std::io::Result<PathBuf> {
        self.listen_at(socket_key, true)
    }

    fn staged_path(&self, socket_key: &str) -> PathBuf {
        let mut path = self.socket_path_for(socket_key).into_os_string();
        path.push(".next");
        PathBuf::from(path)
    }

    /// Moves a staged listener's socket over the key's own path, in one
    /// step: a client finds the old server's or this one, never neither.
    pub fn commit(&self, socket_key: &str) -> std::io::Result<PathBuf> {
        let path = self.socket_path_for(socket_key);
        let mut servers = self.0.servers.lock().unwrap();
        let Some(entry) = servers.get_mut(socket_key) else {
            return Err(std::io::Error::other("not listening"));
        };
        if entry.path != path {
            std::fs::rename(&entry.path, &path)?;
            entry.path = path.clone();
        }
        Ok(path)
    }

    fn listen_at(&self, socket_key: &str, staged: bool) -> std::io::Result<PathBuf> {
        if let Some(path) = self.socket_path(socket_key) {
            return Ok(path);
        }
        create_dir_mode(&self.0.socket_directory, 0o700)?;
        set_mode(&self.0.socket_directory, 0o700)?;
        // Nothing to stage where the socket is the well-known path.
        let staged = staged && !(cfg!(windows) && socket_key == LOCAL_SOCKET_KEY);
        let path = if staged {
            self.staged_path(socket_key)
        } else {
            self.socket_path_for(socket_key)
        };
        if let Some(parent) = path.parent() {
            create_dir_mode(parent, 0o700)?;
        }
        let _ = std::fs::remove_file(&path);
        let listener = roamgate_base::local_socket::Listener::bind(&path)?;
        set_mode(&path, 0o600)?;
        let this = self.clone();
        let key = socket_key.to_owned();
        let task = tokio::spawn(async move {
            let mut connections = tokio::task::JoinSet::new();
            loop {
                tokio::select! {
                    accepted = listener.accept() => {
                        let Ok(stream) = accepted else { continue };
                        let this = this.clone();
                        let key = key.clone();
                        connections.spawn(async move {
                            let service = hyper::service::service_fn(move |request| {
                                let this = this.clone();
                                let key = key.clone();
                                async move { Ok::<_, Infallible>(this.serve(&key, request).await) }
                            });
                            // Watches are long polls: no idle timeout.
                            let served = hyper::server::conn::http1::Builder::new()
                                .serve_connection(TokioIo::new(stream), service)
                                .without_shutdown()
                                .await;
                            if let Ok(parts) = served {
                                linger(parts.io.into_inner()).await;
                            }
                        });
                    }
                    Some(_) = connections.join_next(), if !connections.is_empty() => {}
                }
            }
        });
        self.0.servers.lock().unwrap().insert(
            socket_key.to_owned(),
            Listening {
                path: path.clone(),
                task,
            },
        );
        Ok(path)
    }

    async fn serve(&self, socket_key: &str, request: Request<Incoming>) -> Response<Full<Bytes>> {
        let path = request.uri().path().to_owned();
        let Some(command) = path.strip_prefix("/v1/").map(str::to_owned) else {
            return json_response(&json!({"error": "not found"}), 404);
        };
        if request.method() != hyper::Method::POST {
            return json_response(&json!({"error": "not found"}), 404);
        }
        // Only a holder's log is larger than an agent's request.
        let limit = if command == "hold_output" {
            HOLD_OUTPUT_MAX_BODY_BYTES
        } else {
            REVIEW_AGENT_MAX_BODY_BYTES
        };
        let declared = request
            .headers()
            .get(hyper::header::CONTENT_LENGTH)
            .and_then(|v| v.to_str().ok())
            .map_or(0.0, roamgate_agents::js::number_from_text);
        if declared > limit as f64 {
            return json_response(&json!({"error": "request too large"}), 413);
        }
        let body = match Limited::new(request.into_body(), limit).collect().await {
            Ok(collected) => String::from_utf8_lossy(&collected.to_bytes()).into_owned(),
            Err(error) if error.is::<http_body_util::LengthLimitError>() => {
                return json_response(&json!({"error": "request too large"}), 413);
            }
            Err(error) => return json_response(&json!({"error": error.to_string()}), 400),
        };
        let (value, status) = match form_of(&body) {
            Ok(form) => match self.handle(socket_key, &command, form).await {
                Ok(value) => (value, 200),
                Err(error) => (json!({"error": error.message}), error.status),
            },
            Err(error) => (json!({"error": error.message}), error.status),
        };
        if status >= 500 && status != 503 {
            tracing::warn!(command, error = %value["error"], "review agent request failed");
        }
        let response = json_response(&value, status);
        if let Some(on_exchange) = &self.0.on_exchange {
            on_exchange(&AgentExchange {
                socket_key: socket_key.to_owned(),
                command,
                body,
                status,
                response: roamgate_agents::js::stringify_pretty(&value),
            });
        }
        response
    }

    /// The connection a request comes from. A pane naming its Herdr socket
    /// is never taken for another connection's.
    async fn connection_for(&self, socket_key: &str, form: &Form) -> ReviewResult<AgentConnection> {
        let all = self
            .0
            .host
            .connections()
            .await
            .map_err(|e| review_error(e, 503))?;
        if socket_key != LOCAL_SOCKET_KEY {
            return all
                .into_iter()
                .find(|c| c.id == socket_key)
                .ok_or_else(|| ReviewError::status("this connection is not ready", 503));
        }
        let local: Vec<AgentConnection> =
            all.into_iter().filter(|c| c.ssh_host.is_none()).collect();
        // A pane names its Herdr server: one Roamgate is not connected to is
        // refused, so its pane ids never reach another server's panes.
        if let Some(herdr) = form.non_empty("herdr_socket") {
            return local
                .into_iter()
                .find(|c| same_socket(c.herdr_socket_path.as_deref(), herdr))
                .ok_or_else(|| {
                    ReviewError::status(
                        "this pane's Herdr server is not one of Roamgate's connections",
                        503,
                    )
                });
        }
        match local.len() {
            1 => Ok(local.into_iter().next().expect("one")),
            0 => Err(ReviewError::status("no local connection is ready", 503)),
            _ => Err(ReviewError::status(
                "cannot tell which local connection this pane belongs to",
                503,
            )),
        }
    }

    /// A thread's file as the review names it: in a rendered review of a
    /// file, its absolute path (or any path ending with it) is that file.
    fn thread_path(session: &ReviewSession, file: Option<&str>) -> Option<String> {
        let file = file.filter(|f| !f.is_empty())?;
        if let ReviewTarget::Rendered {
            path: Some(shown), ..
        } = &session.target
            && file.starts_with('/')
            && (file == format!("{}/{shown}", session.root) || file.ends_with(&format!("/{shown}")))
        {
            return Some(shown.clone());
        }
        Some(file.to_owned())
    }

    async fn root_of(&self, connection: &AgentConnection, form: &Form) -> ReviewResult<String> {
        let Some(cwd) = form.non_empty("cwd").filter(|cwd| cwd.starts_with('/')) else {
            return Err(ReviewError::new("the client did not send its directory"));
        };
        self.0
            .host
            .read_root(&connection.id, cwd)
            .await
            .map_err(|error| {
                ReviewError::new(if error.message.is_empty() {
                    "not inside a Git repository".to_owned()
                } else {
                    error.message
                })
            })
    }

    async fn session_for(
        &self,
        connection: &AgentConnection,
        form: &Form,
    ) -> ReviewResult<ReviewSession> {
        let service = &self.0.service;
        // A comment names its review: an agent answering across a
        // workspace's repositories need not say which one.
        let comment = form.non_empty("comment").or(form.non_empty("on_comment"));
        let owner = match (form.non_empty("session"), comment) {
            (None, Some(comment)) => service.session_of_comment(
                &json!({"connectionId": connection.id, "commentId": comment}),
            )?,
            _ => None,
        };
        if let Some(id) = form.non_empty("session").map(str::to_owned).or(owner) {
            let session = service.get(&json!({"sessionId": id}))?.session;
            if session.connection_id != connection.id {
                return Err(ReviewError::not_found("no such review"));
            }
            return Ok(session);
        }
        let root = self.root_of(connection, form).await?;
        service
            .list(&json!({"connectionId": connection.id, "root": root}))
            .into_iter()
            .next()
            .map(|snapshot| snapshot.session)
            .ok_or_else(|| {
                ReviewError::not_found(
                    "no review is open for this checkout; run `roamgate-review open`",
                )
            })
    }

    /// A rendered review's target and root: a file (absolute) of a checkout,
    /// relative to it (or to its directory outside any), or a site's URL.
    async fn rendered_target(
        &self,
        connection: &AgentConnection,
        form: &Form,
    ) -> ReviewResult<Option<(String, Value)>> {
        let file = form.non_empty("file");
        let url = form.non_empty("url");
        if file.is_none() && url.is_none() {
            return Ok(None);
        }
        if file.is_some() && url.is_some() {
            return Err(ReviewError::new("give a file or a URL, not both"));
        }
        if let Some(url) = url {
            let cwd = form.get("cwd").unwrap_or("");
            let root = match self.root_of(connection, form).await {
                Ok(root) => root,
                Err(_) if cwd.starts_with('/') => cwd.to_owned(),
                Err(_) => return Err(ReviewError::new("the client did not send its directory")),
            };
            return Ok(Some((root, json!({"kind": "rendered", "url": url}))));
        }
        let host = self.0.host.clone();
        let id = connection.id.clone();
        let (root, target) = rendered_file_target(
            move |directory: String| async move {
                host.read_root(&id, &directory)
                    .await
                    .map_err(|error| error.message)
            },
            file.expect("checked"),
            form.get("cwd").unwrap_or(""),
        )
        .await?;
        Ok(Some((root, target.to_value())))
    }

    /// Who writes. The client always says; the mod's tools leave it out: the
    /// review's own agent when it runs in the asking pane, else Claude.
    fn agent_name(form: &Form, session: Option<&ReviewSession>) -> ReviewResult<String> {
        let mut name = roamgate_agents::js::trim(form.get("agent").unwrap_or("")).to_owned();
        if name.is_empty() && form.get("via") == Some(roamgate_base::assets::mod_via()) {
            name = match session {
                Some(session)
                    if session.agent.name.as_deref().is_some_and(|n| !n.is_empty())
                        && session.agent.pane_id.as_deref() == form.get("pane") =>
                {
                    session.agent.name.clone().expect("checked")
                }
                _ => "Claude".into(),
            };
        }
        if name.is_empty() {
            name = "agent".into();
        }
        if name == REVIEW_USER {
            return Err(ReviewError::new(format!(
                "\"{REVIEW_USER}\" is the user's name"
            )));
        }
        Ok(name)
    }

    fn agent_may_read(&self, session_id: &str) -> bool {
        self.0
            .service
            .agent_may_read(&json!({"sessionId": session_id}))
            .unwrap_or(false)
    }

    /// A review's threads for its agent, then those it shows from the
    /// checkout's other reviews, each saying so (`from_other_review`).
    fn threads_for_agent(&self, snapshot: &ReviewSnapshot) -> Vec<Value> {
        let mut out: Vec<Value> = snapshot
            .threads
            .iter()
            .filter(|t| not_held(t))
            .map(thread_output)
            .collect();
        for thread in snapshot.shared.iter().flatten() {
            if !self.agent_may_read(&thread.session_id) || !not_held(thread) {
                continue;
            }
            let mut each = thread_output(thread);
            each["from_other_review"] = json!(thread.session_id);
            out.push(each);
        }
        out
    }

    /// Handles one command (`handle`).
    pub async fn handle(&self, socket_key: &str, command: &str, form: Form) -> ReviewResult<Value> {
        if command == "skill" {
            return Ok(json!({"skill": REVIEW_SKILL}));
        }
        let connection = self.connection_for(socket_key, &form).await?;
        let host = &self.0.host;
        let service = &self.0.service;
        match command {
            "permission" | "questions" => return self.prompt(&connection, command, &form).await,
            "hold" | "handback" | "hold_output" | "fg" => {
                return self.holder(&connection, command, &form).await;
            }
            "mod_poll" | "mod_ack" | "mod_event" | "mod_tools" => {
                return self
                    .claude_mod_request(&connection.id, command, &form)
                    .await;
            }
            "waiting" => return self.waiting(&connection.id, &form),
            "stop_check" => return self.stop_check(&connection.id, &form).await,
            "launch" => {
                let pane = form.non_empty("pane").ok_or_else(|| {
                    ReviewError::new("roamgate-hold --launch runs inside a Herdr pane")
                })?;
                let token = form.get("token").unwrap_or("");
                if !(16..=64).contains(&token.len())
                    || !token.chars().all(|c| matches!(c, '0'..='9' | 'a'..='f'))
                {
                    return Err(ReviewError::new("invalid launch token"));
                }
                let spec = host
                    .launch(json!({"connectionId": connection.id, "paneId": pane, "token": token}))
                    .await
                    .map_err(|e| review_error(e, 500))?
                    .ok_or_else(|| {
                        ReviewError::not_found("no such start for this pane (it expired?)")
                    })?;
                tracing::info!(connection = connection.id, pane, program = %spec["argv"][0], "agent launched from a pane");
                return Ok(spec);
            }
            "claude_start" => {
                let pane = form
                    .non_empty("pane")
                    .ok_or_else(|| ReviewError::new("claude-start runs inside a Herdr pane"))?;
                let session = form.get("session").unwrap_or("");
                if !session_id_ok(session) {
                    return Err(ReviewError::new("invalid session id"));
                }
                let input = json!({
                    "connectionId": connection.id,
                    "paneId": pane,
                    "sessionId": session,
                    "source": form.get("source").unwrap_or(""),
                });
                if !host.features().claude_start {
                    return Ok(
                        json!({"action": "terminal", "reason": "conversation mode is unavailable"}),
                    );
                }
                return host
                    .claude_start(input)
                    .await
                    .map_err(|e| review_error(e, 500));
            }
            "notify" => return self.notify(&connection, &form).await,
            "reviews" | "work" => return self.board(&connection, command, &form).await,
            "sessions" | "message" => return self.messages(&connection, command, &form).await,
            "place" | "worktree" | "workspace" | "groups" => {
                let pane = form.get("pane").unwrap_or("");
                if pane.is_empty() && command != "groups" {
                    return Err(ReviewError::new(format!(
                        "{command} runs inside a Herdr pane"
                    )));
                }
                let mut params = serde_json::Map::new();
                for key in [
                    "workspace_id",
                    "path",
                    "branch",
                    "repo",
                    "base",
                    "label",
                    "dir",
                    "cwd",
                    "group",
                    "create_group",
                ] {
                    if let Some(value) = form.non_empty(key) {
                        params.insert(key.into(), json!(crate::js::head16(value, 4096)));
                    }
                }
                let input = json!({
                    "connectionId": connection.id,
                    "paneId": pane,
                    "workspaceId": form.get("workspace").unwrap_or(""),
                    "command": command,
                    "params": params,
                });
                if !host.features().workspaces {
                    return Err(ReviewError::new("workspace placement is unavailable"));
                }
                return host
                    .workspaces(input)
                    .await
                    .map_err(|e| review_error(e, 500));
            }
            "open" => return self.open(&connection, &form).await,
            "list" => {
                // `--all`: every review of this connection, not just the checkout's.
                let root = if form.get("all") == Some("1") {
                    None
                } else {
                    Some(self.root_of(&connection, &form).await?)
                };
                let mut params = json!({"connectionId": connection.id});
                if let Some(root) = root {
                    params["root"] = json!(root);
                }
                let mut out = Vec::new();
                for snapshot in service.list(&params) {
                    if !service.agent_may_read(&json!({"sessionId": snapshot.session.id}))? {
                        continue;
                    }
                    let mut each = session_output(&snapshot.session);
                    each["threads"] = json!(snapshot.threads.len());
                    out.push(each);
                }
                return Ok(Value::Array(out));
            }
            _ => {}
        }
        let session = self.session_for(&connection, &form).await?;
        let session_id = session.id.clone();
        let agent = Self::agent_name(&form, Some(&session))?;
        if session.gitlab && matches!(command, "get" | "comments") {
            service
                .refresh_gitlab(&json!({"sessionId": session_id}))
                .await?;
        }
        service
            .assert_agent_allowed(&json!({"sessionId": session_id, "author": agent}))
            .await?;
        let text = form.get("text");
        let comment = form.get("comment");
        let message = form.non_empty("message");
        let pane = form.non_empty("pane");
        match command {
            "get" | "comments" => {
                let snapshot = service.get(&json!({"sessionId": session_id}))?;
                Ok(json!({
                    "session": session_output(&snapshot.session),
                    "threads": self.threads_for_agent(&snapshot),
                }))
            }
            "add" => {
                let line = int_param(form.get("line"), "line")?;
                let kind = if form.get("draft") == Some("1") || form.get("kind") == Some("draft") {
                    "draft"
                } else {
                    "discussion"
                };
                // On a part of a comment (a work item's description): drawn
                // under the words it quotes.
                if let Some(on_comment) = form.non_empty("on_comment") {
                    if form.non_empty("file").is_some() || line.is_some() {
                        return Err(ReviewError::new(
                            "a thread is on a comment's part or on a file, not both",
                        ));
                    }
                    let anchor = service.message_part_anchor(&json!({
                        "sessionId": session_id,
                        "commentId": on_comment,
                        "quote": form.get("quote").unwrap_or(""),
                    }))?;
                    let thread = service
                        .add_thread(&json!({
                            "sessionId": session_id,
                            "kind": kind,
                            "author": agent,
                            "text": text,
                            "anchor": serde_json::to_value(&anchor).unwrap_or(Value::Null),
                        }))
                        .await?;
                    return Ok(thread_output(&thread));
                }
                let mut anchor = serde_json::Map::new();
                if let Some(path) = Self::thread_path(&session, form.get("file")) {
                    anchor.insert("path".into(), json!(path));
                }
                if let Some(line) = line {
                    anchor.insert("line".into(), json!(line));
                }
                if let Some(quote) = form.non_empty("quote") {
                    anchor.insert("render".into(), json!({"quote": quote}));
                }
                if let Some(end) = int_param(form.get("end_line"), "end line")? {
                    anchor.insert("endLine".into(), json!(end));
                }
                if let Some(side) = form.non_empty("side") {
                    anchor.insert("side".into(), json!(side));
                }
                let thread = service
                    .add_thread(&json!({
                        "sessionId": session_id,
                        "kind": kind,
                        "author": agent,
                        "text": text,
                        "anchor": anchor,
                    }))
                    .await?;
                Ok(thread_output(&thread))
            }
            "reply" => Ok(thread_output(
                &service
                    .reply(&json!({"sessionId": session_id, "commentId": comment, "author": agent, "text": text}))
                    .await?,
            )),
            "edit" => Ok(thread_output(
                &service
                    .edit(&json!({"sessionId": session_id, "commentId": comment, "author": agent, "text": text}))
                    .await?,
            )),
            "delete" => {
                let result = service
                    .delete_comment(&json!({"sessionId": session_id, "commentId": comment, "author": agent}))
                    .await?;
                Ok(json!({"deleted": result.get("deleted").cloned().unwrap_or(Value::Null)}))
            }
            "resolve" | "reopen" => Ok(thread_output(&service.resolve(&json!({
                "sessionId": session_id,
                "commentId": comment,
                "resolved": command == "resolve" && form.get("unresolve") != Some("1"),
            }))?)),
            "watch" => self.watch(&session_id, &agent, &form).await,
            "summary" => {
                // Without text: read the overall comment, as the user has it.
                if roamgate_agents::js::trim(text.unwrap_or("")).is_empty() {
                    return Ok(json!({"summary": session.summary}));
                }
                service
                    .agent_summary(&json!({"sessionId": session_id, "author": agent, "text": text}))
                    .await
            }
            "working" => {
                let mut params = json!({
                    "sessionId": session_id,
                    "agent": agent,
                    "state": if form.get("done") == Some("1") { "done" } else { "working" },
                });
                if let Some(pane) = pane {
                    params["paneId"] = json!(pane);
                }
                if let Some(comment) = comment.filter(|c| !c.is_empty()) {
                    params["commentId"] = json!(comment);
                }
                if let Some(message) = message {
                    params["message"] = json!(message);
                }
                Ok(session_output(&service.agent_status(&params)?.session))
            }
            "update" => {
                let mut params = json!({"sessionId": session_id, "agent": agent, "state": "update"});
                if let Some(pane) = pane {
                    params["paneId"] = json!(pane);
                }
                if let Some(message) = message {
                    params["message"] = json!(message);
                }
                Ok(session_output(&service.agent_status(&params)?.session))
            }
            _ => Err(ReviewError::not_found(format!("unknown command: {command}"))),
        }
    }

    async fn open(&self, connection: &AgentConnection, form: &Form) -> ReviewResult<Value> {
        let service = &self.0.service;
        let host = self.0.host.clone();
        let agent = Self::agent_name(form, None)?;
        let pane = form.non_empty("pane");
        // --repo PATH or PATH=BASE..HEAD, repeatable: the other repositories
        // worked on from here, each reviewed in the same workspace.
        let repo_entries: Vec<(String, String)> = form
            .get("repo")
            .unwrap_or("")
            .split('\n')
            .filter(|entry| entry.starts_with('/'))
            .map(|entry| match entry.rfind('=') {
                Some(at) if at > 0 && entry[at + 1..].contains("..") => {
                    (entry[..at].to_owned(), entry[at + 1..].to_owned())
                }
                _ => (entry.to_owned(), String::new()),
            })
            .collect();
        // A file or a site to discuss, rendered (`--file`, `--url`).
        let rendered = self.rendered_target(connection, form).await?;
        let root = match &rendered {
            Some((root, _)) => root.clone(),
            None => match self.root_of(connection, form).await {
                Ok(root) => root,
                Err(error) => {
                    let Some((first, _)) = repo_entries.first() else {
                        return Err(error);
                    };
                    self.root_of(connection, &Form::with(&[("cwd", first)]))
                        .await?
                }
            },
        };
        let workspace_id = form.non_empty("workspace").map(str::to_owned);
        let target = match &rendered {
            Some((_, target)) => target.clone(),
            None => {
                let base_host = host.clone();
                let (id, base_root) = (connection.id.clone(), root.clone());
                let default_base = move || async move {
                    base_host
                        .read_default_base(&id, &base_root)
                        .await
                        .map_err(|e| ReviewError::new(e.message))
                };
                let step_host = host.clone();
                let (id, step_root, workspace) = (
                    connection.id.clone(),
                    root.clone(),
                    form.get("workspace").unwrap_or("").to_owned(),
                );
                let last_step = connection.last_steps.then_some(move || async move {
                    step_host
                        .read_last_step(&id, &step_root, &workspace)
                        .await
                        .map_err(|e| ReviewError::new(e.message))
                });
                parse_target_flags(form, default_base, last_step).await?
            }
        };
        let automatic = rendered.is_none() && automatic_target(form);
        let target = if automatic {
            target
        } else {
            match ReviewTarget::from_value(&target) {
                Some(parsed) => service
                    .equivalent_target(&connection.id, &root, parsed)
                    .await
                    .to_value(),
                None => target,
            }
        };
        let mut params = json!({
            "connectionId": connection.id,
            "root": root,
            "target": target,
            "automatic": automatic,
            "agent": agent,
        });
        if let Some(title) = form.non_empty("title") {
            params["title"] = json!(title);
        }
        if let Some(workspace) = &workspace_id {
            params["workspaceId"] = json!(workspace);
        }
        if let Some(pane) = pane {
            params["paneId"] = json!(pane);
        }
        if let Some(message) = form.non_empty("message") {
            params["message"] = json!(message);
        }
        let opened = service.open(&params)?;
        let mut repos = vec![json!({"root": root, "session": opened.session.id})];
        for (path, range) in &repo_entries {
            let other = self
                .root_of(connection, &Form::with(&[("cwd", path)]))
                .await?;
            if repos.iter().any(|repo| repo["root"] == json!(other)) {
                continue;
            }
            let flags = if range.is_empty() {
                Form::default()
            } else {
                Form::with(&[("range", range)])
            };
            let base_host = host.clone();
            let (id, base_root) = (connection.id.clone(), other.clone());
            let target = parse_target_flags(
                &flags,
                move || async move {
                    base_host
                        .read_default_base(&id, &base_root)
                        .await
                        .map_err(|e| ReviewError::new(e.message))
                },
                None::<fn() -> std::future::Ready<ReviewResult<Option<Value>>>>,
            )
            .await?;
            let mut params = json!({
                "connectionId": connection.id,
                "root": other,
                "target": target,
                "automatic": range.is_empty(),
                "agent": agent,
                "raise": false,
            });
            if let Some(workspace) = &workspace_id {
                params["workspaceId"] = json!(workspace);
            }
            if let Some(pane) = pane {
                params["paneId"] = json!(pane);
            }
            let extra = service.open(&params)?;
            repos.push(json!({"root": other, "session": extra.session.id}));
        }
        // A merge request's review: refused when it is confidential, or
        // GitLab cannot tell.
        service
            .assert_agent_allowed(&json!({"sessionId": opened.session.id, "author": agent}))
            .await?;
        let security = opened.merge_request.as_ref().is_some_and(|mr| mr.security);
        let mut out = json!({
            "session": session_output(&opened.session),
            // A security merge request's discussions are not shared with agents.
            "threads": if security { Vec::new() } else { self.threads_for_agent(&opened) },
        });
        if repos.len() > 1 {
            out["repos"] = Value::Array(repos);
        }
        Ok(out)
    }

    async fn prompt(
        &self,
        connection: &AgentConnection,
        command: &str,
        form: &Form,
    ) -> ReviewResult<Value> {
        let questions_asked = command == "questions";
        let none = if questions_asked {
            json!({"answers": null})
        } else {
            json!({"answer": null})
        };
        let Some(pane) = form.non_empty("pane") else {
            return Ok(none);
        };
        // Nobody to ask: the terminal must not wait for nothing.
        if self.0.host.has_viewers().await.ok().flatten() == Some(false) {
            return Ok(none);
        }
        let agent = form.non_empty("agent").unwrap_or("agent").to_owned();
        let clamp = |seconds: f64, default: f64| -> u64 {
            let seconds = if seconds.is_finite() {
                seconds
            } else {
                default
            };
            (seconds.clamp(1.0, 3600.0) * 1000.0) as u64
        };
        let (tool, input, questions, timeout_ms) = if questions_asked {
            // Claude's AskUserQuestion, from its PreToolUse hook.
            let questions = parse_questions(form.get("questions"));
            let Some(first) = questions.first() else {
                return Ok(none);
            };
            tracing::info!(
                connection = connection.id,
                pane,
                questions = questions.len(),
                "agent questions waiting"
            );
            (
                "AskUserQuestion".to_owned(),
                json!({"question": first["question"]}),
                Some(Value::Array(questions)),
                clamp(number(form, "timeout", Some("180")), 180.0),
            )
        } else {
            let input = match form.get("input") {
                None => Value::Null,
                Some(raw) => serde_json::from_str(raw).unwrap_or_else(|_| json!(raw)),
            };
            let tool = form.non_empty("tool").unwrap_or("tool").to_owned();
            tracing::info!(
                connection = connection.id,
                pane,
                tool,
                "agent permission prompt waiting"
            );
            (
                tool,
                input,
                None,
                clamp(number(form, "timeout", Some("60")), 60.0),
            )
        };
        let (signal, cancelled) = tokio::sync::oneshot::channel::<()>();
        let _signal = DropSignal(Some(signal));
        // The prompt runs on its own: a hook that goes away ends it.
        let waiting = self.0.service.prompts().request(PermissionRequest {
            connection_id: connection.id.clone(),
            pane_id: pane.to_owned(),
            agent,
            tool,
            input,
            can_always: !questions_asked && form.get("can_always") == Some("1"),
            questions,
            no_terminal: false,
            timeout_ms,
            cancel: Some(Box::pin(async move {
                let _ = cancelled.await;
            })),
        });
        let answer = tokio::spawn(waiting).await.ok().flatten();
        if !questions_asked {
            tracing::info!(connection = connection.id, pane, answer = %answer.as_ref().map_or("none".to_owned(), |a| a.to_string()), "agent permission prompt ended");
            return Ok(json!({"answer": answer}));
        }
        tracing::info!(
            connection = connection.id,
            pane,
            answered = answer.is_some(),
            "agent questions ended"
        );
        let mut out = json!({
            "answers": answer.as_ref().filter(|a| a.is_object()).and_then(|a| a.get("answers")).cloned().unwrap_or(Value::Null),
        });
        // Put away unanswered: the hook denies the tool, saying so.
        if answer == Some(json!("dismiss")) {
            out["dismissed"] = json!(true);
        }
        Ok(out)
    }

    async fn holder(
        &self,
        connection: &AgentConnection,
        command: &str,
        form: &Form,
    ) -> ReviewResult<Value> {
        let host = &self.0.host;
        let pane = form
            .non_empty("pane")
            .ok_or_else(|| ReviewError::new("roamgate-hold runs inside a Herdr pane"))?;
        if !host.features().holder {
            return Err(ReviewError::status("conversation mode is unavailable", 503));
        }
        let session = form.get("session").unwrap_or("");
        let asked = match command {
            "hold_output" => {
                let offset = number_of(form, "offset");
                let end = number_of(form, "end");
                let safe = roamgate_agents::js::is_safe_integer;
                if !safe(offset) || !safe(end) || offset < 0.0 || end < offset {
                    return Err(ReviewError::new("invalid offsets"));
                }
                host.holder_output(json!({
                    "connectionId": connection.id,
                    "paneId": pane,
                    "holderId": form.get("holder_id").unwrap_or(""),
                    "offset": offset as i64,
                    "end": end as i64,
                    "data": form.get("data").unwrap_or(""),
                }))
            }
            "fg" => host.holder_fg(json!({
                "connectionId": connection.id,
                "paneId": pane,
                "form": form.to_value(),
            })),
            "hold" => host.holder_hold(json!({
                "connectionId": connection.id,
                "paneId": pane,
                "sessionId": session,
                "form": form.to_value(),
            })),
            _ => host.holder_handback(json!({
                "connectionId": connection.id,
                "paneId": pane,
                "sessionId": session,
            })),
        };
        asked.await.map_err(|e| review_error(e, 500))
    }

    async fn notify(&self, connection: &AgentConnection, form: &Form) -> ReviewResult<Value> {
        // The agent itself says the user needs to act: no review involved.
        let trim = roamgate_agents::js::trim;
        let text = trim(form.get("text").unwrap_or(""));
        let title = trim(form.get("title").unwrap_or(""));
        let pane = form
            .non_empty("pane")
            .ok_or_else(|| ReviewError::new("notify runs inside a Herdr pane"))?;
        if text.is_empty() {
            return Err(ReviewError::new("say what the user needs to do"));
        }
        if crate::js::len16(text) > 2000 || crate::js::len16(title) > 200 {
            return Err(ReviewError::new(
                "keep it short: 2000 characters, title 200",
            ));
        }
        let mut input = json!({
            "connectionId": connection.id,
            "paneId": pane,
            "agent": Self::agent_name(form, None)?,
        });
        if !title.is_empty() {
            input["title"] = json!(title);
        }
        input["text"] = json!(text);
        if !self.0.host.features().notify {
            return Err(ReviewError::new("notifications are unavailable"));
        }
        self.0
            .host
            .notify(input)
            .await
            .map_err(|e| review_error(e, 500))?;
        tracing::info!(connection = connection.id, pane, "agent notified the user");
        Ok(json!({"notified": true}))
    }

    async fn board(
        &self,
        connection: &AgentConnection,
        command: &str,
        form: &Form,
    ) -> ReviewResult<Value> {
        let tool = roamgate_agents::js::trim(form.get("tool").unwrap_or("")).to_owned();
        let input = |params: Value| {
            json!({
                "connectionId": connection.id,
                "paneId": form.get("pane").unwrap_or(""),
                "workspaceId": form.get("workspace").unwrap_or(""),
                "agent": roamgate_agents::js::trim(form.get("agent").unwrap_or("")),
                "tool": tool,
                "params": params,
            })
        };
        let unavailable = || {
            ReviewError::status(
                format!(
                    "the {} board is unavailable",
                    if command == "work" { "Work" } else { "Reviews" }
                ),
                503,
            )
        };
        let features = self.0.host.features();
        if !(if command == "work" {
            features.work
        } else {
            features.reviews
        }) {
            return Err(unavailable());
        }
        if tool.is_empty() {
            return Err(ReviewError::new("tool is required"));
        }
        let params = match form
            .get("params")
            .filter(|raw| !roamgate_agents::js::trim(raw).is_empty())
        {
            None => json!({}),
            Some(raw) => serde_json::from_str(raw)
                .map_err(|_| ReviewError::new("params must be a JSON object"))?,
        };
        if !params.is_object() {
            return Err(ReviewError::new("params must be a JSON object"));
        }
        let asked = if command == "work" {
            self.0.host.work(input(params))
        } else {
            self.0.host.reviews(input(params))
        };
        let text = asked.await.map_err(|error| {
            let status = error
                .status
                .unwrap_or(if error.code.as_deref() == Some("not_found") {
                    404
                } else {
                    400
                });
            ReviewError::status(error.message, status)
        })?;
        // JSON answers come back as JSON (after the line saying what in them
        // other people wrote, when there is one).
        let at = if text.starts_with('{') {
            0
        } else {
            text.find('\n').map_or(0, |n| n + 1)
        };
        Ok(match serde_json::from_str::<Value>(&text[at..]) {
            Ok(result) => {
                let mut out = json!({"tool": tool});
                if at > 0 {
                    out["note"] = json!(&text[..at - 1]);
                }
                out["result"] = result;
                out
            }
            Err(_) => json!({"tool": tool, "result": text}),
        })
    }

    async fn messages(
        &self,
        connection: &AgentConnection,
        command: &str,
        form: &Form,
    ) -> ReviewResult<Value> {
        let unavailable = || ReviewError::status("messaging other sessions is unavailable", 503);
        let pane = form.get("pane").unwrap_or("");
        if !self.0.host.features().messages {
            return Err(unavailable());
        }
        if command == "sessions" {
            let list = self.0.host.messages_list();
            let own = (!pane.is_empty()).then(|| format!("{}/{pane}", connection.id));
            let sessions: Vec<Value> = list
                .await
                .map_err(|e| review_error(e, 500))?
                .into_iter()
                .map(|mut session| {
                    if own.is_some()
                        && session.get("address").and_then(Value::as_str) == own.as_deref()
                    {
                        session["self"] = json!(true);
                    }
                    session
                })
                .collect();
            return Ok(json!({"sessions": sessions}));
        }
        if pane.is_empty() {
            return Err(ReviewError::new(
                "message runs inside an agent session's pane: a reply needs your address",
            ));
        }
        let input = json!({
            "from": {"connectionId": connection.id, "paneId": pane},
            "to": form.get("to").unwrap_or(""),
            "text": form.get("text").unwrap_or(""),
        });
        self.0
            .host
            .messages_send(input)
            .await
            .map_err(|e| review_error(e, 500))
    }

    async fn watch(&self, session_id: &str, agent: &str, form: &Form) -> ReviewResult<Value> {
        let service = &self.0.service;
        let timeout = int_param(form.get("timeout"), "timeout")?.unwrap_or(1800);
        {
            let mut watches = self.0.watches.lock().unwrap();
            let active = watches.get(session_id).copied().unwrap_or(0);
            if active >= REVIEW_AGENT_MAX_WATCHES {
                return Err(ReviewError::status(
                    "too many agents are watching this review",
                    429,
                ));
            }
            watches.insert(session_id.to_owned(), active + 1);
        }
        let slot = WatchSlot {
            socket: self.clone(),
            session: session_id.to_owned(),
        };
        let result = service
            .watch(
                &json!({
                    "sessionId": session_id,
                    "agent": agent,
                    "mode": if form.get("mode") == Some("any") { "any" } else { "unanswered" },
                    "timeoutMs": timeout * 1000,
                }),
                None,
            )
            .await;
        drop(slot);
        let result = result?;
        // Threads may come from the workspace's other repositories.
        let mut roots: HashMap<String, String> = HashMap::new();
        let mut threads = Vec::new();
        for thread in &result.threads {
            if !roots.contains_key(&thread.session_id) {
                let root = service
                    .get(&json!({"sessionId": thread.session_id}))?
                    .session
                    .root;
                roots.insert(thread.session_id.clone(), root);
            }
            let mut each = thread_output(thread);
            each["repo"] = json!(roots[&thread.session_id]);
            threads.push(each);
        }
        let mut out = json!({
            "outcome": result.outcome,
            "session": result.session.as_ref().map_or(Value::Null, session_output),
        });
        if let Some(summary) = result.summary.filter(|s| !s.is_empty()) {
            out["overall_comment"] = json!(summary);
        }
        out["threads"] = Value::Array(threads);
        Ok(out)
    }

    /// The sessions of reviews and chats whose agent runs in the asking pane
    /// or is its session.
    fn asking_sessions(
        &self,
        connection_id: &str,
        pane: &str,
        claude: &str,
    ) -> Vec<ReviewSnapshot> {
        self.0
            .service
            .list(&json!({"connectionId": connection_id, "chats": true}))
            .into_iter()
            .filter(|snapshot| {
                let session = &snapshot.session;
                let agent_session = match &session.target {
                    ReviewTarget::Chat { chat, .. } => Some(chat.as_str()),
                    _ => session.agent.session_id.as_deref(),
                };
                ((!pane.is_empty() && session.agent.pane_id.as_deref() == Some(pane))
                    || (!claude.is_empty() && agent_session == Some(claude)))
                    && self.agent_may_read(&session.id)
            })
            .collect()
    }

    /// The threads waiting for the asking session's answer (`/threads`).
    fn waiting(&self, connection_id: &str, form: &Form) -> ReviewResult<Value> {
        let pane = form.get("pane").unwrap_or("");
        let claude = form.get("claude_session").unwrap_or("");
        if pane.is_empty() && claude.is_empty() {
            return Err(ReviewError::new("waiting runs inside an agent session"));
        }
        let reviews: Vec<Value> = self
            .asking_sessions(connection_id, pane, claude)
            .into_iter()
            .filter_map(|snapshot| {
                let session = &snapshot.session;
                let agent = session.agent.name.as_deref().unwrap_or("agent");
                let threads: Vec<Value> = snapshot
                    .threads
                    .iter()
                    .filter(|thread| thread_needs_answer(thread, agent, !session.gitlab))
                    .map(thread_output)
                    .collect();
                (!threads.is_empty())
                    .then(|| json!({"session": session_output(session), "threads": threads}))
            })
            .collect();
        Ok(json!({"reviews": reviews}))
    }

    /// The mod's end-of-turn check (`stop_check`): the threads delivered to
    /// the asking session that it left unanswered and did not take, and the
    /// work items it was asked to triage that still need it.
    async fn stop_check(&self, connection_id: &str, form: &Form) -> ReviewResult<Value> {
        let pane = form.get("pane").unwrap_or("");
        let claude = form.get("claude_session").unwrap_or("");
        if pane.is_empty() && claude.is_empty() {
            return Err(ReviewError::new("stop_check runs inside an agent session"));
        }
        let ago = number(form, "ended_ms_ago", Some(""));
        let ended_ms_ago = (form.has("ended_ms_ago") && ago.is_finite() && ago >= 0.0)
            .then(|| ago.min(60_000.0) as i64);
        let mut threads = Vec::new();
        let mut items = Vec::new();
        for snapshot in self.asking_sessions(connection_id, pane, claude) {
            let session = &snapshot.session;
            let due = self.0.service.agent_due(&session.id, ended_ms_ago);
            for thread in due["threads"].as_array().into_iter().flatten() {
                let id = thread
                    .get("id")
                    .and_then(Value::as_str)
                    .or(thread.as_str())
                    .unwrap_or("");
                threads.push(json!({
                    "id": crate::js::head16(id, 8),
                    "review": crate::js::head16(&session.id, 8),
                    "title": crate::js::head16(&session.title, 120),
                }));
            }
            if let Some(item) = due.get("triageItem").and_then(Value::as_str) {
                items.push(item.to_owned());
            }
        }
        // Still marked: the item's needs_triage, read from the board.
        let mut triage = Vec::new();
        for item in items {
            if !self.0.host.features().work {
                break;
            }
            let asked = self.0.host.work(json!({
                "connectionId": connection_id,
                "paneId": pane,
                "workspaceId": form.get("workspace").unwrap_or(""),
                "agent": Self::agent_name(form, None).unwrap_or_else(|_| "agent".into()),
                "tool": "work_list",
                "params": {"item": item},
            }));
            // Gone or unreadable: nothing to remind.
            let Ok(text) = asked.await else { continue };
            let Some(at) = text.find('{') else { continue };
            let Ok(listed) = serde_json::from_str::<Value>(&text[at..]) else {
                continue;
            };
            if listed.pointer("/item/needs_triage") == Some(&Value::Bool(true)) {
                let title = match listed.pointer("/item/title") {
                    None | Some(Value::Null) => String::new(),
                    Some(value) => roamgate_agents::js::to_text(value),
                };
                triage.push(json!({
                    "item": crate::js::head16(&item, 8),
                    "title": crate::js::head16(&title, 120),
                }));
            }
        }
        Ok(json!({"threads": threads, "triage": triage}))
    }

    /// A request of the Claude mod running in one of the connection's panes.
    async fn claude_mod_request(
        &self,
        connection_id: &str,
        command: &str,
        form: &Form,
    ) -> ReviewResult<Value> {
        if form.non_empty("pane").is_none() {
            return Err(ReviewError::new("the Claude mod runs inside a Herdr pane"));
        }
        let Some(mods) = &self.0.claude_mod else {
            return Err(ReviewError::status("the Claude mod is unavailable", 503));
        };
        mods.request(connection_id.to_owned(), command.to_owned(), form.clone())
            .await
    }

    /// Links `link` to `target` when its directory exists and it is free.
    fn link_if_free(target: &Path, link: &Path) {
        if let Err(error) = place_link(target, link, true) {
            tracing::warn!(link = %link.display(), error = %error, "review link not made");
        }
    }

    /// Installs the client and points the well-known socket path here.
    pub fn install_local(&self) -> std::io::Result<()> {
        self.install_local_at(false)
    }

    /// [`AgentSocket::install_local`] with its socket staged: the link
    /// points at the key's own path, which [`AgentSocket::commit`] takes.
    pub fn install_local_staged(&self) -> std::io::Result<()> {
        self.install_local_at(true)
    }

    fn install_local_at(&self, staged: bool) -> std::io::Result<()> {
        self.listen_at(LOCAL_SOCKET_KEY, staged)?;
        let path = self.socket_path_for(LOCAL_SOCKET_KEY);
        let home = &self.0.home;
        let base = home.join(REVIEW_HOME_DIR);
        let bin = base.join("bin");
        create_dir_mode(&bin, 0o700)?;
        let pid = std::process::id();
        // The review client and conversation mode's pane holder: this
        // binary, under their names (no Python here; SSH hosts get the
        // Python ones, see remote.rs).
        let program = client_program()?;
        let client = install_client(&bin, "roamgate-review", &program)?;
        install_client(&bin, "roamgate-hold", &program)?;
        let skill = base.join("skills").join("roamgate-review");
        create_dir_mode(&skill, 0o700)?;
        write_mode(&skill.join("SKILL.md"), REVIEW_SKILL.as_bytes(), 0o644)?;
        // Where agents find them without being told: Claude Code's skills
        // and the PATH. Only where those exist, and never over the user's own.
        Self::link_if_free(&skill, &home.join(".claude/skills/roamgate-review"));
        // Codex reads ~/.codex/skills/<name>/SKILL.md the same way.
        Self::link_if_free(&skill, &home.join(".codex/skills/roamgate-review"));
        Self::link_if_free(
            &client,
            &home
                .join(".local/bin")
                .join(client.file_name().unwrap_or_default()),
        );
        // The Claude mod's marketplace: installed only if the user asks.
        if let Err(error) = roamgate_claude::plugin::write_claude_mod_plugin(home) {
            tracing::warn!(error = %error, "claude mod files not written");
        }
        let link = base.join("review.sock");
        // Windows' socket is the well-known path itself.
        if link == path {
            return Ok(());
        }
        let current = std::fs::symlink_metadata(&link)
            .ok()
            .filter(|m| m.file_type().is_symlink())
            .and_then(|_| std::fs::read_link(&link).ok());
        if current.as_deref() != Some(path.as_path()) {
            // Replaced in one step: a client never finds the link missing.
            let next = PathBuf::from(format!("{}.{pid}.tmp", link.display()));
            let _ = std::fs::remove_file(&next);
            symlink(&path, &next)?;
            std::fs::rename(&next, &link)?;
        }
        *self.0.linked.lock().unwrap() = Some(link);
        Ok(())
    }

    fn unlink_if_ours(&self) {
        let Some(linked) = self.0.linked.lock().unwrap().take() else {
            return;
        };
        if std::fs::read_link(&linked)
            .is_ok_and(|target| target == self.socket_path_for(LOCAL_SOCKET_KEY))
        {
            let _ = std::fs::remove_file(&linked);
        }
    }

    /// Stops one key's listener (and its connections), or every one.
    pub fn stop(&self, socket_key: Option<&str>) {
        if socket_key.is_none_or(|key| key == LOCAL_SOCKET_KEY) {
            self.unlink_if_ours();
        }
        let mut servers = self.0.servers.lock().unwrap();
        let keys: Vec<String> = servers
            .keys()
            .filter(|key| socket_key.is_none_or(|wanted| wanted == key.as_str()))
            .cloned()
            .collect();
        for key in keys {
            if let Some(entry) = servers.remove(&key) {
                entry.task.abort();
                let _ = std::fs::remove_file(&entry.path);
            }
        }
    }
}

/// Where the Claude mod's requests go (`mod_poll`, `mod_ack`, `mod_event`,
/// `mod_tools`): roamgate-claude's hub, or what answers for it while the
/// hub is elsewhere.
pub trait ClaudeMods: Send + Sync + 'static {
    fn request(
        &self,
        connection_id: String,
        command: String,
        form: Form,
    ) -> crate::service::BoxFut<ReviewResult<Value>>;
}

impl ClaudeMods for ClaudeModHub {
    fn request(
        &self,
        connection_id: String,
        command: String,
        form: Form,
    ) -> crate::service::BoxFut<ReviewResult<Value>> {
        let hub = self.clone();
        Box::pin(async move { hub_request(&hub, &connection_id, &command, &form).await })
    }
}

async fn hub_request(
    hub: &ClaudeModHub,
    connection_id: &str,
    command: &str,
    form: &Form,
) -> ReviewResult<Value> {
    let pane = form
        .non_empty("pane")
        .ok_or_else(|| ReviewError::new("the Claude mod runs inside a Herdr pane"))?
        .to_owned();
    let session = form.get("session").unwrap_or("");
    let session_id = if session_id_ok(session) { session } else { "" }.to_owned();
    let client = crate::js::head16(form.get("client").unwrap_or(""), 64);
    let connection_id = connection_id.to_owned();
    match command {
        "mod_tools" => hub
            .tools(ToolsInput {
                connection_id,
                pane_id: pane,
                session_id,
                client,
                headless: form.get("headless") == Some("1"),
                gone: form.get("gone") == Some("1"),
                work: form.get("work") == Some("1"),
                rules: form.get("rules") == Some("1"),
            })
            .map_err(mod_error),
        "mod_poll" => hub
            .poll(PollInput {
                connection_id,
                pane_id: pane,
                session_id,
                client,
                claude: form.get("claude").unwrap_or("").to_owned(),
                protocol: number_of(form, "protocol"),
                after: number(form, "after", Some("0")),
                wait_ms: number(form, "wait_ms", Some("0")),
            })
            .await
            .map_err(mod_error),
        "mod_ack" => hub
            .ack(AckInput {
                connection_id,
                pane_id: pane,
                client,
                id: number_of(form, "id"),
                outcome: form.get("outcome").unwrap_or("").to_owned(),
                reason: form.get("reason").unwrap_or("").to_owned(),
            })
            .map_err(mod_error),
        _ => {
            let Ok(Value::Object(event)) =
                serde_json::from_str::<Value>(form.get("event").unwrap_or(""))
            else {
                return Err(ReviewError::new("invalid event"));
            };
            hub.event(EventInput {
                connection_id,
                pane_id: pane,
                client,
                session_id,
                event,
            })
            .map_err(mod_error)
        }
    }
}

fn create_dir_mode(path: &Path, mode: u32) -> std::io::Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        std::fs::DirBuilder::new()
            .recursive(true)
            .mode(mode)
            .create(path)
    }
    #[cfg(not(unix))]
    {
        let _ = mode;
        std::fs::create_dir_all(path)
    }
}

/// Closes a connection whose answer is written: the write side first,
/// then what the client still sends is read and dropped for a moment. A
/// request refused unread (413) leaves its body in the socket, and closing
/// over unread data resets the connection: Windows then drops the answer
/// before the client reads it.
async fn linger(mut stream: roamgate_base::local_socket::Stream) {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    if stream.shutdown().await.is_err() {
        return;
    }
    let mut buffer = vec![0u8; 64 * 1024];
    let _ = tokio::time::timeout(std::time::Duration::from_secs(2), async {
        while matches!(stream.read(&mut buffer).await, Ok(read) if read > 0) {}
    })
    .await;
}

fn set_mode(path: &Path, mode: u32) -> std::io::Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode))
    }
    // The socket's directory is the account's alone; the socket inherits
    // that (an AF_UNIX socket file takes no chmod there).
    #[cfg(not(unix))]
    {
        if mode & 0o077 == 0 && path.is_dir() {
            roamgate_base::private::restrict_to_owner_or_warn(path);
        }
        Ok(())
    }
}

fn write_mode(path: &Path, bytes: &[u8], mode: u32) -> std::io::Result<()> {
    use std::io::Write;
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(mode);
    }
    #[cfg(not(unix))]
    let _ = mode;
    options.open(path)?.write_all(bytes)
}

/// The executable the clients run: this one. A binary replaced while it
/// runs (an update) reads `... (deleted)` on Linux: the new one is at the
/// same path.
fn client_program() -> std::io::Result<PathBuf> {
    let program = std::env::current_exe()?;
    let text = program.to_string_lossy();
    Ok(match text.strip_suffix(" (deleted)") {
        Some(path) => PathBuf::from(path),
        None => program,
    })
}

/// Installs `bin/<name>` as `program` run under that name (it runs the
/// client its name says), in one step over whatever was there (an older
/// install: the Python script of that name). On Unix a link to it; on
/// Windows `<name>.exe`, a hard link (symbolic ones need privileges
/// there) or else a copy, and the older extensionless script goes, so
/// Git Bash finds the executable. Gives the installed path.
fn install_client(bin: &Path, name: &str, program: &Path) -> std::io::Result<PathBuf> {
    let pid = std::process::id();
    #[cfg(unix)]
    {
        let client = bin.join(name);
        if std::fs::read_link(&client).is_ok_and(|current| current == program) {
            return Ok(client);
        }
        let temp = PathBuf::from(format!("{}.{pid}.tmp", client.display()));
        let _ = std::fs::remove_file(&temp);
        std::os::unix::fs::symlink(program, &temp)?;
        std::fs::rename(&temp, &client)?;
        Ok(client)
    }
    #[cfg(not(unix))]
    {
        let client = bin.join(format!("{name}.exe"));
        let temp = bin.join(format!("{name}.{pid}.tmp.exe"));
        let _ = std::fs::remove_file(&temp);
        if std::fs::hard_link(program, &temp).is_err() {
            std::fs::copy(program, &temp)?;
        }
        if let Err(error) = std::fs::rename(&temp, &client) {
            // One that runs (a pane's holder) cannot be replaced: kept.
            let _ = std::fs::remove_file(&temp);
            if !client.exists() {
                return Err(error);
            }
        }
        let _ = std::fs::remove_file(bin.join(name));
        Ok(client)
    }
}

/// Makes `link` lead to `target` when its directory exists and nothing
/// of the user's is there: a link to an old install of ours is replaced.
/// On Windows, where a symbolic link needs developer mode or an admin, a
/// directory falls back to a junction and a file to a hard link or a copy
/// (recorded beside the target, so a later install knows it is ours);
/// `symlinks` false starts there.
pub(crate) fn place_link(target: &Path, link: &Path, symlinks: bool) -> std::io::Result<()> {
    let Some(parent) = link.parent() else {
        return Ok(());
    };
    if !std::fs::metadata(parent).is_ok_and(|m| m.is_dir()) {
        return Ok(());
    }
    match std::fs::symlink_metadata(link) {
        // A symbolic link, or a junction on Windows.
        Ok(meta) if meta.file_type().is_symlink() => {
            let current = std::fs::read_link(link)?;
            if same_path(&current, target) {
                return Ok(());
            }
            // A link to an old install of ours is replaced; others are kept
            // (Windows names it with backslashes).
            let ours = current.to_string_lossy().replace('\\', "/");
            if !ours.contains(REVIEW_HOME_DIR) {
                return Ok(());
            }
            if meta.is_dir() || std::fs::remove_file(link).is_err() {
                // A junction, or a directory's symbolic link on Windows.
                std::fs::remove_dir(link)?;
            }
        }
        Ok(meta) => {
            // A copy or a hard link we placed (Windows) is ours; anything
            // else is the user's.
            if !meta.is_file() || !placed(target).contains(&link.to_path_buf()) {
                return Ok(());
            }
            if std::fs::read(link).ok() == std::fs::read(target).ok() {
                return Ok(());
            }
            std::fs::remove_file(link)?;
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(_) => return Ok(()),
    }
    let linked = if symlinks {
        symlink(target, link)
    } else {
        Err(std::io::Error::other("symbolic links not tried"))
    };
    match linked {
        Ok(()) => Ok(()),
        #[cfg(windows)]
        Err(_) if target.is_dir() => roamgate_base::junction::create(target, link),
        #[cfg(windows)]
        Err(_) => {
            if std::fs::hard_link(target, link).is_err() {
                std::fs::copy(target, link)?;
            }
            let mut list = placed(target);
            if !list.contains(&link.to_path_buf()) {
                list.push(link.to_path_buf());
            }
            let text: String = list
                .iter()
                .map(|path| format!("{}\n", path.display()))
                .collect();
            std::fs::write(placed_record(target), text)
        }
        #[cfg(not(windows))]
        Err(error) => Err(error),
    }
}

/// Whether two paths name the same place, Windows' verbatim prefix aside.
fn same_path(a: &Path, b: &Path) -> bool {
    let plain = |path: &Path| {
        let text = path.to_string_lossy().into_owned();
        text.strip_prefix(r"\\?\")
            .map_or(text.clone(), str::to_owned)
    };
    a == b || plain(a) == plain(b)
}

/// Where the copies and hard links of `target` (Windows) are recorded.
fn placed_record(target: &Path) -> PathBuf {
    let name = target.file_name().unwrap_or_default().to_string_lossy();
    target.with_file_name(format!(".{name}.placed"))
}

/// The copies and hard links of `target` placed so far.
fn placed(target: &Path) -> Vec<PathBuf> {
    std::fs::read_to_string(placed_record(target))
        .unwrap_or_default()
        .lines()
        .filter(|line| !line.is_empty())
        .map(PathBuf::from)
        .collect()
}

fn symlink(target: &Path, link: &Path) -> std::io::Result<()> {
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(target, link)
    }
    // As node's symlinkSync without a type: a directory's link or a file's
    // (Windows lets a user make them in developer mode or as an admin).
    #[cfg(windows)]
    {
        if target.is_dir() {
            std::os::windows::fs::symlink_dir(target, link)
        } else {
            std::os::windows::fs::symlink_file(target, link)
        }
    }
    #[cfg(not(any(unix, windows)))]
    {
        let _ = (target, link);
        Err(std::io::Error::other("no symbolic links here"))
    }
}
