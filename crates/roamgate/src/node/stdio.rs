//! `roamgate node --stdio`: the home's link to this machine's node over
//! ssh (phase 2, contract/wire/node-link.md), served on stdin and stdout.
//!
//! A pure executor: it answers the home's calls on this machine (host
//! commands as local spawns through [`Local`], byte streams to the local
//! Herdr sockets, a socket listened on for the home as `ssh -R` would) and
//! writes nothing global of its own: no install, no Herdr lifecycle, no
//! hooks, no pane environment, no log file. Its diagnostics
//! go to stderr, which ssh hands to the home; stdout carries only the
//! preamble and the frames. It exits when the link closes.

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use base64::Engine as _;
#[cfg(unix)]
use roamgate_channel::node::{AGENT_PREFIX, ListenParams, bridge};
use roamgate_channel::node::{
    CLIENT_SOCKET, CONNECT, CONTROL_SOCKET, LISTEN, PREAMBLE, RUN, RunParams, RunReply,
    serve_stream,
};
use roamgate_channel::peer::{
    BodyReceiver, BoxFuture, Handler, HttpRequest, HttpResponse, IncomingCall, Peer, PeerOptions,
    accept_hello,
};
use roamgate_channel::protocol::{Message, NODE_CONTRACT, NodeIdentity, PROTOCOL, RpcError};
use roamgate_channel::transport::BoxStream;
use roamgate_exec::host::{Host, Local};
use roamgate_exec::process::{Command, ProcessRunner};
use serde_json::Value;
use tokio::io::AsyncWriteExt;

/// How long the home has to say `hello`.
const HELLO_WAIT: Duration = Duration::from_secs(30);

/// Serves the link until stdin closes; returns the exit code.
pub async fn run_stdio(_args: &[String]) -> u8 {
    let mut stdout = tokio::io::stdout();
    if stdout.write_all(PREAMBLE).await.is_err() || stdout.flush().await.is_err() {
        return 1;
    }
    let mut stream: BoxStream = Box::new(tokio::io::join(tokio::io::stdin(), stdout));
    let identity = NodeIdentity {
        version: crate::VERSION.to_owned(),
        contract: NODE_CONTRACT,
    };
    let welcome = |_: &Message| Message::Welcome {
        protocol: PROTOCOL,
        clock: None,
        raw_data: false,
        node: Some(identity),
    };
    match tokio::time::timeout(HELLO_WAIT, accept_hello(&mut stream, "", welcome)).await {
        Ok(Ok(_)) => {}
        Ok(Err(error)) => {
            eprintln!("roamgate node: handshake failed: {error}");
            return 1;
        }
        Err(_) => {
            eprintln!("roamgate node: no hello from the home");
            return 1;
        }
    }
    let clock: roamgate_base::clock::SharedClock = Arc::new(roamgate_base::clock::SystemClock);
    let home = std::env::var_os("HOME").map(PathBuf::from);
    let handler = Arc::new(NodeHandler {
        host: Local::new(ProcessRunner::new(clock.clone())),
        home,
        listeners: Arc::default(),
    });
    let listeners = handler.listeners.clone();
    let peer = Peer::start(stream, handler, PeerOptions::core(clock));
    peer.closed().await;
    // The sockets listened on for the home go with the link.
    for (path, listening) in listeners.lock().unwrap().iter() {
        if listening.inode.is_some() && inode(path) == listening.inode {
            let _ = std::fs::remove_file(path);
        }
    }
    // A read of stdin may still wait on its blocking thread: leave now.
    std::process::exit(0)
}

/// A socket listened on for the home: its accept loop and the inode bound,
/// so the node removes only its own file.
struct Listening {
    // Only a Unix node listens for its home (see `listen`).
    #[cfg_attr(not(unix), allow(dead_code))]
    task: tokio::task::JoinHandle<()>,
    inode: Option<u64>,
}

#[cfg(unix)]
fn inode(path: &std::path::Path) -> Option<u64> {
    use std::os::unix::fs::MetadataExt;
    std::fs::symlink_metadata(path).ok().map(|meta| meta.ino())
}

#[cfg(not(unix))]
fn inode(_path: &std::path::Path) -> Option<u64> {
    None
}

#[derive(Clone)]
struct NodeHandler {
    host: Local,
    home: Option<PathBuf>,
    /// The sockets listened on for the home, by path.
    listeners: Arc<std::sync::Mutex<std::collections::HashMap<PathBuf, Listening>>>,
}

impl NodeHandler {
    /// A socket the home names: one of Herdr's by name, or a path.
    fn socket(&self, url: &str) -> Option<PathBuf> {
        let herdr = |file: &str| {
            self.home
                .as_ref()
                .map(|home| home.join(".config/herdr").join(file))
        };
        match url {
            CONTROL_SOCKET => herdr("herdr.sock"),
            CLIENT_SOCKET => herdr("herdr-client.sock"),
            path if path.starts_with('/') => Some(PathBuf::from(path)),
            _ => None,
        }
    }

    /// Listens on a socket for the home (an agent socket, as `ssh -R`
    /// would): each connection is streamed back as `agent:<id>`. The socket
    /// goes with the link.
    #[cfg(unix)]
    fn listen(&self, peer: &Peer, params: Value) -> Result<Value, RpcError> {
        let params: ListenParams = serde_json::from_value(params)
            .map_err(|error| RpcError::with_code(format!("node.listen: {error}"), "invalid"))?;
        let path = PathBuf::from(&params.path);
        if !path.is_absolute() {
            return Err(RpcError::with_code(
                "node.listen: a relative path",
                "invalid",
            ));
        }
        let _ = std::fs::remove_file(&path);
        let listener = tokio::net::UnixListener::bind(&path)
            .map_err(|error| RpcError::new(format!("{}: {error}", path.display())))?;
        let url = format!("{AGENT_PREFIX}{}", params.id);
        let peer = peer.clone();
        let task = tokio::spawn(async move {
            while let Ok((stream, _)) = listener.accept().await {
                let (peer, url) = (peer.clone(), url.clone());
                tokio::spawn(async move { bridge(&peer, &url, stream).await });
            }
        });
        let inode = inode(&path);
        if let Some(previous) = self
            .listeners
            .lock()
            .unwrap()
            .insert(path, Listening { task, inode })
        {
            previous.task.abort();
        }
        Ok(serde_json::json!({"ok": true}))
    }

    #[cfg(not(unix))]
    fn listen(&self, _peer: &Peer, _params: Value) -> Result<Value, RpcError> {
        Err(RpcError::new(
            "node.listen: roamgate node runs on Linux and macOS only, not on Windows",
        ))
    }

    async fn run(&self, params: Value) -> Result<Value, RpcError> {
        let params: RunParams = serde_json::from_value(params)
            .map_err(|error| RpcError::with_code(format!("node.run: {error}"), "invalid"))?;
        let mut command = Command::new(["/bin/sh", "-c", params.command.as_str()]);
        if let Some(home) = &self.home {
            command = command.cwd(home.clone());
        }
        if let Some(input) = &params.stdin {
            let bytes = base64::engine::general_purpose::STANDARD
                .decode(input)
                .map_err(|error| RpcError::with_code(format!("node.run: {error}"), "invalid"))?;
            command = command.stdin(bytes);
        }
        if let Some(ms) = params.timeout_ms {
            command = command.timeout(Duration::from_millis(ms));
        }
        let output = self
            .host
            .run(&command)
            .await
            .map_err(|error| RpcError::new(error.to_string()))?;
        Ok(serde_json::to_value(RunReply {
            code: output.code,
            stdout: base64::engine::general_purpose::STANDARD.encode(&output.stdout),
            stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
        })
        .unwrap_or(Value::Null))
    }
}

impl Handler for NodeHandler {
    fn call(&self, peer: &Peer, call: IncomingCall) -> BoxFuture<Result<Value, RpcError>> {
        let this = self.clone();
        let peer = peer.clone();
        Box::pin(async move {
            match call.method.as_str() {
                RUN => this.run(call.params).await,
                LISTEN => this.listen(&peer, call.params),
                _ => Err(RpcError::with_code(
                    format!("unknown method {}", call.method),
                    "unknown_method",
                )),
            }
        })
    }

    fn http(
        &self,
        _peer: &Peer,
        request: HttpRequest,
        body: Option<BodyReceiver>,
    ) -> BoxFuture<Result<HttpResponse, RpcError>> {
        let path = (request.method == CONNECT)
            .then(|| self.socket(&request.url))
            .flatten();
        Box::pin(async move {
            match (path, body) {
                (Some(path), Some(body)) => Ok(serve_stream(path, body, true).await),
                _ => Ok(HttpResponse::status(404)),
            }
        })
    }
}
