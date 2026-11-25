//! The node link's shared parts (contract/wire/node-link.md): the home
//! runs `roamgate node --stdio` on a machine over ssh and speaks the core
//! channel's frames with it on the child's stdin and stdout.
//!
//! - [`PREAMBLE`]: the line the node writes before its first frame, so
//!   whatever a login shell prints first is skipped ([`skip_preamble`]).
//! - [`RUN`]: a host command run whole on the node ([`RunParams`],
//!   [`RunReply`]).
//! - [`CONNECT`]: a byte stream to a socket on the other side, carried as
//!   an `http` request whose request and response bodies are the two
//!   directions ([`open_stream`] opens one, [`serve_stream`] answers it).
//! - [`LISTEN`]: the node listens on a socket and streams each of its
//!   connections back to the home (`agent:<id>`): the agent socket of a
//!   connection, as `ssh -R` would forward it.

use std::io;

use serde::{Deserialize, Serialize};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWriteExt, DuplexStream};
use tokio::sync::mpsc;

use crate::peer::{BodyReceiver, HttpRequest, HttpResponse, Peer};

/// The node's first line on stdout, before its first frame.
pub const PREAMBLE: &[u8] = b"roamgate-node\n";
/// The most the home reads before the preamble (a chatty login shell).
pub const MAX_PREAMBLE_SKIP: usize = 64 * 1024;
/// The family a home names in its `hello`.
pub const FAMILY: &str = "node";
/// A host command run whole: `params` is [`RunParams`], the result
/// [`RunReply`].
pub const RUN: &str = "node.run";
/// The `http` method of a socket stream; its URL is [`CONTROL_SOCKET`],
/// [`CLIENT_SOCKET`] or an absolute socket path on the node.
pub const CONNECT: &str = "CONNECT";
/// The node's Herdr control socket (`~/.config/herdr/herdr.sock`).
pub const CONTROL_SOCKET: &str = "herdr:control";
/// The node's Herdr render socket (`~/.config/herdr/herdr-client.sock`).
pub const CLIENT_SOCKET: &str = "herdr:client";

/// The node listens on a Unix socket: `params` is [`ListenParams`].
pub const LISTEN: &str = "node.listen";
/// The URL prefix of a stream the node opens to the home for a connection
/// to a socket it listens on: `agent:<id>`.
pub const AGENT_PREFIX: &str = "agent:";

/// A [`LISTEN`] call's parameters.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ListenParams {
    /// The socket's path on the node; a file there is replaced.
    pub path: String,
    /// What the home connects each connection to (`agent:<id>`).
    pub id: String,
}

/// A [`RUN`] call's parameters.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct RunParams {
    /// A command line for `/bin/sh -c`, run in the node's HOME.
    pub command: String,
    /// Its whole stdin, base64; none: no stdin.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stdin: Option<String>,
    /// Killed past this (and the call fails).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub timeout_ms: Option<u64>,
}

/// A [`RUN`] call's result.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct RunReply {
    pub code: i32,
    /// Base64.
    pub stdout: String,
    pub stderr: String,
}

/// Reads `input` up to and including [`PREAMBLE`]; gives what was read
/// past it. Fails at the end of the input or past [`MAX_PREAMBLE_SKIP`].
pub async fn skip_preamble(input: &mut (impl AsyncRead + Unpin)) -> io::Result<Vec<u8>> {
    let mut seen: Vec<u8> = Vec::new();
    let mut chunk = vec![0u8; 4096];
    loop {
        if let Some(at) = seen
            .windows(PREAMBLE.len())
            .position(|window| window == PREAMBLE)
        {
            return Ok(seen.split_off(at + PREAMBLE.len()));
        }
        if seen.len() > MAX_PREAMBLE_SKIP {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "no node preamble in the first 64 KiB",
            ));
        }
        let read = input.read(&mut chunk).await?;
        if read == 0 {
            return Err(io::Error::new(
                io::ErrorKind::UnexpectedEof,
                "the node ended before its preamble",
            ));
        }
        seen.extend_from_slice(&chunk[..read]);
    }
}

/// A byte stream to `socket` on the node: what is written to the stream
/// returned goes to the socket, what the socket sends is read from it. It
/// opens at once, with no round trip: the request goes with its first
/// bytes, and a socket the node cannot open reads as ended. Dropping the
/// stream closes the socket on the node.
pub fn open_stream(peer: &Peer, socket: &str) -> DuplexStream {
    let (local, remote) = tokio::io::duplex(256 * 1024);
    let (mut from_client, mut to_client) = tokio::io::split(remote);
    let (body, body_rx) = mpsc::channel::<Vec<u8>>(16);
    tokio::spawn(async move {
        let mut chunk = vec![0u8; 64 * 1024];
        loop {
            match from_client.read(&mut chunk).await {
                Ok(0) | Err(_) => break,
                Ok(read) => {
                    if body.send(chunk[..read].to_vec()).await.is_err() {
                        break;
                    }
                }
            }
        }
    });
    let peer = peer.clone();
    let socket = socket.to_owned();
    tokio::spawn(async move {
        let request = HttpRequest {
            method: CONNECT.into(),
            url: socket,
            ..HttpRequest::default()
        };
        if let Ok(reply) = peer.http(request, Some(body_rx)).await
            && reply.status == 200
            && let Some(mut body) = reply.body
        {
            while let Some(chunk) = body.chunk().await {
                if to_client.write_all(&chunk).await.is_err() {
                    return;
                }
            }
        }
        let _ = to_client.shutdown().await;
    });
    local
}

#[cfg(unix)]
type Socket = tokio::net::UnixStream;

#[cfg(unix)]
async fn connect(path: &std::path::Path) -> io::Result<Socket> {
    tokio::net::UnixStream::connect(path).await
}

#[cfg(not(unix))]
type Socket = tokio::io::DuplexStream;

#[cfg(not(unix))]
async fn connect(path: &std::path::Path) -> io::Result<Socket> {
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        format!("no Unix sockets here: {}", path.display()),
    ))
}

/// Answers a [`CONNECT`]: the request body goes to the socket at `path`,
/// the socket's bytes are the response body. With `wait_first`, the
/// socket is opened once the first bytes came and written at once (Herdr
/// reads a connection whose request has not arrived 100 ms later); a body
/// that ends first is `204`. A socket that cannot be opened is `502`. The
/// end of the request body closes the socket.
pub async fn serve_stream(
    path: std::path::PathBuf,
    mut body: BodyReceiver,
    wait_first: bool,
) -> HttpResponse {
    let first = if wait_first {
        match body.chunk().await {
            Some(first) => Some(first),
            None => return HttpResponse::status(204),
        }
    } else {
        None
    };
    let socket = match connect(&path).await {
        Ok(socket) => socket,
        Err(error) => {
            eprintln!("roamgate node: {}: {error}", path.display());
            return HttpResponse::status(502);
        }
    };
    let (mut reader, mut writer) = tokio::io::split(socket);
    if let Some(first) = first
        && writer.write_all(&first).await.is_err()
    {
        return HttpResponse::status(502);
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
        // The other side closed its end: so does the socket.
        read.abort();
    });
    HttpResponse {
        status: 200,
        headers: Vec::new(),
        body: Some(rx),
    }
}

/// Carries `local` (a connection accepted here) over the link to `url` on
/// the other side until either end closes.
pub async fn bridge(
    peer: &Peer,
    url: &str,
    mut local: impl AsyncRead + tokio::io::AsyncWrite + Unpin,
) {
    let mut remote = open_stream(peer, url);
    let _ = tokio::io::copy_bidirectional(&mut local, &mut remote).await;
}
