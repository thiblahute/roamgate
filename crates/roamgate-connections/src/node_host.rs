//! The home's side of a node link (contract/wire/node-link.md; Mac node
//! design, phase 2): an SSH profile with `node: true` runs
//! `<node path> node --stdio` on its host, over the runtime's command
//! master, as one long-lived supervised ssh child, and speaks the core
//! channel's frames with it.
//!
//! - [`NodeLink::start`]: the child, its preamble and the handshake; a
//!   node that is missing, fails to start, does not answer in time or
//!   speaks another node contract is an error, and the runtime goes on
//!   with its SSH tunnel and master.
//! - [`NodeLink::open`]: a byte stream to a socket on the host (the Herdr
//!   control client's connections, [`NodeLink::herdr_connector`]).
//! - [`NodeLink::run`]: a host command run whole as a local spawn on the
//!   host; [`NodeRoutes`] is how [`crate::host_ops::HostOps`] finds the
//!   link of a destination.

use std::collections::HashMap;
use std::io::Cursor;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use base64::Engine as _;
use futures_util::FutureExt;
use roamgate_base::clock::SharedClock;
use roamgate_exec::process::ProcessRunner;
use roamgate_exec::ssh::command::SshCommand;
use roamgate_exec::ssh::sessions::{SshSessionHold, SshSessionWait, SshSessions};
use roamgate_exec::ssh::supervised::{SupervisedSsh, stop_child};
use roamgate_herdr::control::{Connector, HerdrStream};
use roamgate_sidecar::node::{FAMILY, RUN, RunParams, RunReply, open_stream, skip_preamble};
use roamgate_sidecar::peer::{Handler, Peer, PeerOptions, say_hello};
use roamgate_sidecar::protocol::{Message, NODE_CONTRACT, NodeIdentity, PROTOCOL, Side};
use roamgate_sidecar::transport::BoxStream;
use tokio::io::AsyncReadExt;

use crate::host_ops::{HostOpError, HostRunOutput};

/// Where the deploy installs the node on a host (its HOME's).
pub const DEFAULT_NODE_PATH: &str = "~/.local/share/roamgate-node/bin/roamgate";

/// How long a node has to start and say `welcome`.
pub const NODE_HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(8);

/// What a run on the node may take beyond its own deadline.
const RUN_GRACE: Duration = Duration::from_secs(5);

/// How a link is started.
#[derive(Clone)]
pub struct NodeStart {
    /// The SSH destination (the profile's).
    pub destination: String,
    /// The node's executable on the host ([`DEFAULT_NODE_PATH`]).
    pub path: String,
    pub sessions: SshSessions,
    pub runner: ProcessRunner,
    /// Run instead of `ssh` (tests).
    pub program: Option<String>,
    /// The link's liveness clock.
    pub clock: SharedClock,
    /// This side's version, for the `hello`.
    pub version: String,
}

struct LinkInner {
    destination: String,
    peer: Peer,
    child: SupervisedSsh,
    identity: NodeIdentity,
    hold: SshSessionHold,
    clock: SharedClock,
}

/// A running link to a node. Clones are the same link.
#[derive(Clone)]
pub struct NodeLink {
    inner: Arc<LinkInner>,
}

impl std::fmt::Debug for NodeLink {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("NodeLink")
            .field("destination", &self.inner.destination)
            .field("identity", &self.inner.identity)
            .finish_non_exhaustive()
    }
}

/// The home answers nothing the node might ask.
struct Home;

impl Handler for Home {}

/// The home's `hello`: no token (ssh authenticated the link).
fn hello(version: &str) -> Message {
    Message::Hello {
        protocol: PROTOCOL,
        token: String::new(),
        side: Side::Rust,
        version: version.to_owned(),
        pid: std::process::id(),
        families: vec![FAMILY.to_owned()],
        test: false,
    }
}

/// Why the child ended, once it did (briefly waited for).
async fn exit_detail(child: &SupervisedSsh, clock: &SharedClock) -> Option<String> {
    if !child
        .exited_within(clock.as_ref(), Duration::from_millis(500))
        .await
    {
        return None;
    }
    let code = child.exited().await;
    let stderr = child.stderr().await;
    let stderr = roamgate_exec::ssh::sessions::without_mux_noise(&stderr);
    let stderr = stderr.trim();
    Some(match code {
        Ok(code) if stderr.is_empty() => format!("the node exited {code}"),
        Ok(code) => format!("the node exited {code}: {stderr}"),
        Err(error) => format!("the node failed: {error}"),
    })
}

impl NodeLink {
    /// Starts the node and shakes hands; an error says why it is not used.
    pub async fn start(start: NodeStart) -> Result<Self, String> {
        let command = format!("exec {} node --stdio", start.path);
        let ssh = start
            .sessions
            .command_argv(&start.destination, &command, &[], Some("node"))
            .map_err(|error| error.to_string())?;
        let hold = start
            .sessions
            .hold(&ssh, &SshSessionWait::default(), true)
            .await
            .map_err(|error| error.to_string())?;
        let mut argv = hold.command.argv.clone();
        if let (Some(program), Some(first)) = (&start.program, argv.first_mut()) {
            *first = program.clone();
        }
        let (child, pipes) = SupervisedSsh::spawn_stdio(&start.runner, &SshCommand::plain(argv))?;
        let version = start.version.clone();
        let handshake = async move {
            let mut stdout = pipes.stdout;
            let rest = skip_preamble(&mut stdout)
                .await
                .map_err(|error| error.to_string())?;
            let reader = Cursor::new(rest).chain(stdout);
            let mut stream: BoxStream = Box::new(tokio::io::join(reader, pipes.stdin));
            let welcome = say_hello(&mut stream, &hello(&version))
                .await
                .map_err(|error| error.to_string())?;
            Ok::<_, String>((stream, welcome))
        };
        let outcome = match tokio::time::timeout(NODE_HANDSHAKE_TIMEOUT, handshake).await {
            Ok(outcome) => outcome,
            Err(_) => Err(format!(
                "no welcome within {} s",
                NODE_HANDSHAKE_TIMEOUT.as_secs()
            )),
        };
        let refuse = |reason: String| {
            let child = child.clone();
            let clock = start.clock.clone();
            async move {
                let detail = exit_detail(&child, &clock).await;
                let _ = child.kill(roamgate_exec::ssh::supervised::KillSignal::Kill);
                Err::<Self, String>(detail.unwrap_or(reason))
            }
        };
        let (stream, welcome) = match outcome {
            Ok(done) => done,
            Err(reason) => {
                hold.release();
                return refuse(reason).await;
            }
        };
        let identity = match welcome {
            Message::Welcome {
                node: Some(identity),
                ..
            } if identity.contract == NODE_CONTRACT => identity,
            Message::Welcome {
                node: Some(identity),
                ..
            } => {
                hold.release();
                let _ = child.kill(roamgate_exec::ssh::supervised::KillSignal::Kill);
                return Err(format!(
                    "the node {} speaks node contract {}, this side {NODE_CONTRACT}",
                    identity.version, identity.contract
                ));
            }
            _ => {
                hold.release();
                let _ = child.kill(roamgate_exec::ssh::supervised::KillSignal::Kill);
                return Err("the program answered without a node identity".into());
            }
        };
        let peer = Peer::start(
            stream,
            Arc::new(Home),
            PeerOptions::front(start.clock.clone()),
        );
        Ok(Self {
            inner: Arc::new(LinkInner {
                destination: start.destination,
                peer,
                child,
                identity,
                hold,
                clock: start.clock,
            }),
        })
    }

    pub fn destination(&self) -> &str {
        &self.inner.destination
    }

    /// What the node said it runs.
    pub fn identity(&self) -> &NodeIdentity {
        &self.inner.identity
    }

    pub fn is_closed(&self) -> bool {
        self.inner.peer.is_closed() || self.inner.child.has_exited()
    }

    /// Resolves once the link is gone (closed, or its child ended).
    pub async fn closed(&self) {
        tokio::select! {
            () = self.inner.peer.closed() => {}
            _ = self.inner.child.exited() => {}
        }
    }

    /// A byte stream to `socket` on the host
    /// ([`roamgate_sidecar::node::open_stream`]).
    pub fn open(&self, socket: &str) -> Box<dyn HerdrStream> {
        Box::new(open_stream(&self.inner.peer, socket))
    }

    /// A host command run whole on the node (`/bin/sh -c`, in its HOME).
    pub async fn run(
        &self,
        command: &str,
        stdin: Option<Vec<u8>>,
        timeout_ms: Option<u64>,
    ) -> Result<HostRunOutput, HostOpError> {
        let params = RunParams {
            command: command.to_owned(),
            stdin: stdin.map(|bytes| base64::engine::general_purpose::STANDARD.encode(bytes)),
            timeout_ms,
        };
        let call = self.inner.peer.call(
            RUN,
            serde_json::to_value(params).unwrap_or_default(),
            Default::default(),
            false,
        );
        let answer = match timeout_ms {
            Some(ms) => tokio::time::timeout(Duration::from_millis(ms) + RUN_GRACE, call)
                .await
                .unwrap_or_else(|_| {
                    Err(roamgate_sidecar::protocol::RpcError::new(format!(
                        "timed out after {ms} ms"
                    )))
                }),
            None => call.await,
        };
        let answer = answer.map_err(|error| HostOpError {
            message: error.message,
            code: None,
        })?;
        let reply: RunReply = serde_json::from_value(answer).map_err(|error| HostOpError {
            message: format!("node.run: {error}"),
            code: None,
        })?;
        Ok(HostRunOutput {
            code: reply.code,
            stdout: base64::engine::general_purpose::STANDARD
                .decode(reply.stdout)
                .unwrap_or_default(),
            stderr: reply.stderr,
        })
    }

    /// Ends the link: `bye`, then the child within a bound.
    pub async fn stop(&self) {
        self.inner.peer.bye();
        let _ = stop_child(
            &self.inner.child,
            self.inner.clock.as_ref(),
            Duration::from_secs(2),
            Duration::from_secs(2),
            |_, _| {},
            "the node link",
        )
        .await;
        self.inner.hold.release();
    }

    fn same(&self, other: &Self) -> bool {
        Arc::ptr_eq(&self.inner, &other.inner)
    }
}

/// The link a runtime uses while it is up: its Herdr client's connections
/// go over it, else to `fallback` (the tunnel's local socket).
#[derive(Clone, Default)]
pub struct NodeSlot(Arc<Mutex<Option<NodeLink>>>);

impl NodeSlot {
    pub fn get(&self) -> Option<NodeLink> {
        self.0
            .lock()
            .unwrap()
            .clone()
            .filter(|link| !link.is_closed())
    }

    pub fn set(&self, link: Option<NodeLink>) {
        *self.0.lock().unwrap() = link;
    }

    /// Forgets `link` if it is still the one set.
    pub fn clear(&self, link: &NodeLink) {
        let mut slot = self.0.lock().unwrap();
        if slot.as_ref().is_some_and(|set| set.same(link)) {
            *slot = None;
        }
    }

    /// A Herdr connector: `socket` on the node while the link is up, the
    /// local `fallback` socket otherwise.
    pub fn herdr_connector(&self, socket: String, fallback: String) -> Connector {
        let slot = self.clone();
        Arc::new(move || {
            let link = slot.get();
            let socket = socket.clone();
            let fallback = fallback.clone();
            async move {
                match link {
                    Some(link) => Ok(link.open(&socket)),
                    None => roamgate_herdr::control::connect_stream(&fallback).await,
                }
            }
            .boxed()
        })
    }
}

/// The node links by SSH destination: a host command for a destination
/// with a live link runs on its node.
#[derive(Clone, Default)]
pub struct NodeRoutes(Arc<Mutex<HashMap<String, NodeLink>>>);

impl NodeRoutes {
    pub fn get(&self, destination: &str) -> Option<NodeLink> {
        self.0
            .lock()
            .unwrap()
            .get(destination)
            .filter(|link| !link.is_closed())
            .cloned()
    }

    pub fn insert(&self, link: &NodeLink) {
        self.0
            .lock()
            .unwrap()
            .insert(link.destination().to_owned(), link.clone());
    }

    /// Forgets `link` if it is still its destination's.
    pub fn remove(&self, link: &NodeLink) {
        let mut routes = self.0.lock().unwrap();
        if routes
            .get(link.destination())
            .is_some_and(|set| set.same(link))
        {
            routes.remove(link.destination());
        }
    }
}

/// What a runtime of a profile with `node: true` needs for its link.
#[derive(Clone)]
pub struct NodeOptions {
    /// The node's executable on the host.
    pub path: String,
    /// Where the link is registered for host commands.
    pub routes: NodeRoutes,
    /// Spawns the link's ssh child.
    pub runner: ProcessRunner,
    /// Run instead of `ssh` (tests).
    pub program: Option<String>,
    /// This side's version.
    pub version: String,
}
