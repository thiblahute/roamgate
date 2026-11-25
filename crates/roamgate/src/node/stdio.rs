//! `roamgate node --stdio`: the home's link to this machine's node over
//! ssh (phase 2, contract/wire/node-link.md), served on stdin and stdout.
//!
//! A pure executor: it answers the home's calls on this machine (host
//! commands as local spawns through [`Local`], byte streams to the local
//! Herdr sockets) and writes nothing global: no install, no Herdr
//! lifecycle, no hooks, no pane environment, no log file. Its diagnostics
//! go to stderr, which ssh hands to the home; stdout carries only the
//! preamble and the frames. It exits when the link closes.

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use base64::Engine as _;
use roamgate_exec::host::{Host, Local};
use roamgate_exec::process::{Command, ProcessRunner};
use roamgate_sidecar::node::{
    CLIENT_SOCKET, CONNECT, CONTROL_SOCKET, PREAMBLE, RUN, RunParams, RunReply,
};
use roamgate_sidecar::peer::{
    BodyReceiver, BoxFuture, Handler, HttpRequest, HttpResponse, IncomingCall, Peer, PeerOptions,
    accept_hello,
};
use roamgate_sidecar::protocol::{
    Message, NODE_CONTRACT, NodeIdentity, PROTOCOL, RpcError, ShadowSettings, Side,
};
use roamgate_sidecar::transport::BoxStream;
use serde_json::Value;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::mpsc;

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
        side: Side::Rust,
        owners: Default::default(),
        shadow: ShadowSettings::default(),
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
    });
    let peer = Peer::start(stream, handler, PeerOptions::core(clock));
    peer.closed().await;
    // A read of stdin may still wait on its blocking thread: leave now.
    std::process::exit(0)
}

#[derive(Clone)]
struct NodeHandler {
    host: Local,
    home: Option<PathBuf>,
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

#[cfg(unix)]
async fn connect(path: &std::path::Path) -> std::io::Result<tokio::net::UnixStream> {
    tokio::net::UnixStream::connect(path).await
}

#[cfg(not(unix))]
async fn connect(path: &std::path::Path) -> std::io::Result<tokio::net::TcpStream> {
    Err(std::io::Error::new(
        std::io::ErrorKind::Unsupported,
        format!("no Unix sockets here: {}", path.display()),
    ))
}

/// A socket stream: the home's request body to the socket, the socket's
/// bytes as the response body. The socket is opened once the first bytes
/// came, and written at once: Herdr reads a connection whose request has
/// not arrived 100 ms later (contract/wire/node-link.md).
async fn stream(path: PathBuf, mut body: BodyReceiver) -> Result<HttpResponse, RpcError> {
    let Some(first) = body.chunk().await else {
        return Ok(HttpResponse::status(204));
    };
    let socket = match connect(&path).await {
        Ok(socket) => socket,
        Err(error) => {
            eprintln!("roamgate node: {}: {error}", path.display());
            return Ok(HttpResponse::status(502));
        }
    };
    let (mut reader, mut writer) = tokio::io::split(socket);
    if writer.write_all(&first).await.is_err() {
        return Ok(HttpResponse::status(502));
    }
    let (tx, rx) = mpsc::channel::<Vec<u8>>(16);
    let read = tokio::spawn(async move {
        let mut chunk = vec![0u8; 64 * 1024];
        loop {
            match reader.read(&mut chunk).await {
                Ok(0) | Err(_) => break,
                Ok(read) => {
                    if tx.send(chunk[..read].to_vec()).await.is_err() {
                        break;
                    }
                }
            }
        }
    });
    tokio::spawn(async move {
        while let Some(chunk) = body.chunk().await {
            if writer.write_all(&chunk).await.is_err() {
                break;
            }
        }
        // The home closed its end: so does the socket.
        read.abort();
    });
    Ok(HttpResponse {
        status: 200,
        headers: Vec::new(),
        body: Some(rx),
    })
}

impl Handler for NodeHandler {
    fn call(&self, _peer: &Peer, call: IncomingCall) -> BoxFuture<Result<Value, RpcError>> {
        let this = self.clone();
        Box::pin(async move {
            if call.method != RUN {
                return Err(RpcError::with_code(
                    format!("unknown method {}", call.method),
                    "unknown_method",
                ));
            }
            this.run(call.params).await
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
                (Some(path), Some(body)) => stream(path, body).await,
                _ => Ok(HttpResponse::status(404)),
            }
        })
    }
}
