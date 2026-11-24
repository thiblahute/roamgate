//! The core of a Rust front (contract/wire/core-channel.md, Stage 2 and
//! The standalone core): the Bun server named by `ROAMGATE_SIDECAR_BIN`,
//! or without it the front's own executable as `roamgate core`, every
//! family its. Spawned with the channel's address and token, supervised as
//! the Bun front supervises its Rust core (hello within 10 s, restart
//! after 1 s doubling to 5 minutes, back to 1 s after 10 minutes up),
//! never left behind when the front stops.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use roamgate_base::clock::SharedClock;
use roamgate_sidecar::peer::{Peer, PeerOptions, accept_hello};
use roamgate_sidecar::protocol::{Ctx, Message, PROTOCOL, ShadowSettings, Side};
use roamgate_sidecar::standalone::STANDALONE_ENV;
use roamgate_sidecar::transport::Listener;
use serde_json::Value;
use tokio::sync::watch;

use super::{FrontHandler, Socket, Sockets};

const HELLO_TIMEOUT: Duration = Duration::from_secs(10);
const FIRST_DELAY: Duration = Duration::from_secs(1);
const MAX_DELAY: Duration = Duration::from_secs(5 * 60);
const STEADY: Duration = Duration::from_secs(10 * 60);
/// How long a stopping core gets to finish its own shutdown (flushing its
/// stores) once the front said `bye`.
const STOP_GRACE: Duration = Duration::from_secs(15);

/// How the core is started.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SidecarCommand {
    pub program: PathBuf,
    pub args: Vec<String>,
    /// The front's own executable as `roamgate core`, with no Bun.
    pub standalone: bool,
}

impl SidecarCommand {
    /// `ROAMGATE_SIDECAR_BIN`: an executable, or a `.ts` file run with
    /// `bun`, given the front's server flags (`server_args`) as they are;
    /// unset or empty, `own_exe core`, the standalone core.
    pub fn resolve(sidecar_bin: Option<&str>, own_exe: &Path, server_args: &[String]) -> Self {
        let Some(target) = sidecar_bin
            .filter(|value| !value.is_empty())
            .map(PathBuf::from)
        else {
            return Self {
                program: own_exe.to_path_buf(),
                args: vec!["core".to_owned()],
                standalone: true,
            };
        };
        if target.extension().is_some_and(|ext| ext == "ts") {
            let mut args = vec!["run".to_owned(), target.to_string_lossy().into_owned()];
            args.extend(server_args.iter().cloned());
            return Self {
                program: PathBuf::from("bun"),
                args,
                standalone: false,
            };
        }
        Self {
            program: target,
            args: server_args.to_vec(),
            standalone: false,
        }
    }
}

/// What the front gives a standalone core.
#[derive(Clone)]
pub struct StandaloneCore {
    /// The front's test clock: the core follows it (`welcome.clock`, then
    /// `internal.clock.advance`).
    pub test_clock: Option<SharedClock>,
    /// `internal.front.start`'s params: the server's configuration.
    pub start: Value,
    /// The core's `server.scheduleExit`: the front exits (code 0) a
    /// moment later, for its supervisor to start the new install.
    pub schedule_exit: super::ScheduleExit,
    /// The core's `voice.session_cookie`: a new login of the front's auth.
    pub session_cookie: super::SessionCookie,
}

#[derive(Clone)]
pub struct SidecarConfig {
    pub command: SidecarCommand,
    /// The channel's socket (`<data>/runtime/core-<pid>.sock`).
    pub channel: String,
    pub clock: SharedClock,
    /// Variables set on each start of the core, worked out then (a test
    /// clock's start time is the front's time at that start).
    pub env: Arc<dyn Fn() -> Vec<(String, String)> + Send + Sync>,
    /// Runs as the front welcomes a core, before the `welcome` is sent:
    /// what the core does once welcomed comes after it.
    pub on_welcome: Arc<dyn Fn() + Send + Sync>,
    /// Set when the core is the standalone one (`command.standalone`).
    pub standalone: Option<StandaloneCore>,
}

fn token() -> String {
    hex::encode(rand::random::<[u8; 32]>())
}

pub(super) fn welcome(_hello: &Message) -> Message {
    Message::Welcome {
        protocol: PROTOCOL,
        side: Side::Rust,
        owners: BTreeMap::new(),
        shadow: ShadowSettings {
            enabled: false,
            rate: 0.0,
        },
        clock: None,
    }
}

/// A standalone core's welcome: every family its (no owners table), the
/// front's test clock when it runs on one.
fn standalone_welcome(core: &StandaloneCore) -> Message {
    Message::Welcome {
        protocol: PROTOCOL,
        side: Side::Rust,
        owners: roamgate_sidecar::owners::families()
            .keys()
            .map(|name| (name.clone(), Side::Rust))
            .collect(),
        shadow: ShadowSettings {
            enabled: false,
            rate: 0.0,
        },
        clock: core.test_clock.as_ref().map(|clock| clock.now()),
    }
}

/// How long the front waits for a standalone core's connections to stop
/// at its shutdown.
const STOP_CONNECTIONS: Duration = Duration::from_secs(10);

/// Closes the browser sockets of a core that went away: their state was
/// in it.
fn drop_sockets(sockets: &Sockets) {
    for entry in sockets.0.lock().unwrap().values() {
        if let Socket::Open(handle) = &entry.socket {
            handle.close(Some((1012, "Service Restart")));
        }
    }
}

/// One run of the core: spawned, said hello, served until it or its
/// channel ends.
async fn run_once(
    config: &SidecarConfig,
    sockets: &Sockets,
    link: &watch::Sender<Option<Peer>>,
    stop: &mut watch::Receiver<bool>,
) -> Result<(), String> {
    let mut listener = Listener::bind(&config.channel)
        .map_err(|error| format!("cannot listen on {}: {error}", config.channel))?;
    let token = token();
    let mut command = tokio::process::Command::new(&config.command.program);
    command
        .args(&config.command.args)
        .env("ROAMGATE_CORE_CHANNEL", &config.channel)
        .env("ROAMGATE_CORE_TOKEN", &token)
        .envs((config.env)())
        .env(
            STANDALONE_ENV,
            if config.standalone.is_some() {
                "1"
            } else {
                "0"
            },
        )
        .stdin(std::process::Stdio::null())
        .kill_on_drop(true);
    let mut child = command
        .spawn()
        .map_err(|error| format!("cannot start {}: {error}", config.command.program.display()))?;
    let accepted = tokio::time::timeout(HELLO_TIMEOUT, async {
        let mut stream = listener.accept().await.map_err(|error| error.to_string())?;
        accept_hello(&mut stream, &token, |hello| {
            (config.on_welcome)();
            match &config.standalone {
                Some(core) => standalone_welcome(core),
                None => welcome(hello),
            }
        })
        .await
        .map_err(|error| format!("{error:?}"))?;
        Ok::<_, String>(stream)
    })
    .await;
    let stream = match accepted {
        Ok(Ok(stream)) => stream,
        Ok(Err(error)) => {
            let _ = child.kill().await;
            return Err(format!("the core's hello failed: {error}"));
        }
        Err(_) => {
            let _ = child.kill().await;
            return Err("the core did not say hello within 10 s".into());
        }
    };
    let handler = Arc::new(FrontHandler {
        sockets: sockets.clone(),
        schedule_exit: config
            .standalone
            .as_ref()
            .map(|core| core.schedule_exit.clone()),
        session_cookie: config
            .standalone
            .as_ref()
            .map(|core| core.session_cookie.clone()),
    });
    let peer = Peer::start(stream, handler, PeerOptions::front(config.clock.clone()));
    // A standalone core hears the server's configuration (and starts the
    // connections) before any browser request reaches it.
    if let Some(core) = &config.standalone
        && let Err(error) = peer
            .call(
                "internal.front.start",
                core.start.clone(),
                Ctx::default(),
                false,
            )
            .await
    {
        tracing::warn!(target: "bridge.front", "the core did not start: {}", error.message);
    }
    let _ = link.send(Some(peer.clone()));
    tracing::info!(
        target: "bridge.front",
        "the {} core is connected",
        if config.standalone.is_some() { "Rust" } else { "Bun" }
    );
    let mut stopping = false;
    tokio::select! {
        () = peer.closed() => {}
        status = child.wait() => {
            tracing::warn!(target: "bridge.front", "the Bun core exited: {status:?}");
        }
        _ = stop.wait_for(|stop| *stop) => stopping = true,
    }
    let _ = link.send(None);
    drop_sockets(sockets);
    // A standalone core's connections end while the channel is up, as the
    // Bun front's `host.stop` at its shutdown.
    if stopping && config.standalone.is_some() && !peer.is_closed() {
        let _ = tokio::time::timeout(
            STOP_CONNECTIONS,
            peer.call("internal.front.stop", Value::Null, Ctx::default(), false),
        )
        .await;
    }
    // The core stops by itself when its channel closes.
    peer.bye();
    let grace = if stopping {
        STOP_GRACE
    } else {
        Duration::from_secs(3)
    };
    if tokio::time::timeout(grace, child.wait()).await.is_err() {
        let _ = child.kill().await;
    }
    Ok(())
}

/// Runs the core, restarting it when it ends, until `stop` turns true:
/// then the core is told `bye` and given its grace to stop.
pub async fn run_sidecar(
    config: SidecarConfig,
    sockets: Sockets,
    link: watch::Sender<Option<Peer>>,
    mut stop: watch::Receiver<bool>,
) {
    let mut delay = FIRST_DELAY;
    loop {
        let started = Instant::now();
        if let Err(error) = run_once(&config, &sockets, &link, &mut stop).await {
            tracing::warn!(target: "bridge.front", "{error}");
        }
        if *stop.borrow() {
            return;
        }
        if started.elapsed() >= STEADY {
            delay = FIRST_DELAY;
        }
        tokio::select! {
            () = tokio::time::sleep(delay) => {}
            _ = stop.wait_for(|stop| *stop) => return,
        }
        delay = (delay * 2).min(MAX_DELAY);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolves_the_core_command() {
        let exe = Path::new("/opt/roamgate/bin/roamgate");
        let args = vec!["--port".to_owned(), "9000".to_owned()];
        assert_eq!(
            SidecarCommand::resolve(None, exe, &args),
            SidecarCommand {
                program: exe.to_path_buf(),
                args: vec!["core".into()],
                standalone: true,
            }
        );
        assert_eq!(
            SidecarCommand::resolve(Some("/src/server/src/index.ts"), exe, &args),
            SidecarCommand {
                program: PathBuf::from("bun"),
                args: vec![
                    "run".into(),
                    "/src/server/src/index.ts".into(),
                    "--port".into(),
                    "9000".into()
                ],
                standalone: false,
            }
        );
        assert_eq!(
            SidecarCommand::resolve(Some("/x/roamgate-bun"), exe, &[]).program,
            PathBuf::from("/x/roamgate-bun")
        );
        assert!(SidecarCommand::resolve(Some(""), exe, &[]).standalone);
    }
}
