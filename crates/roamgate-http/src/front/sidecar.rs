//! The Bun core of a Rust front (contract/wire/core-channel.md, Stage 2):
//! spawned with the channel's address and token, supervised as the Bun
//! front supervises its Rust core (hello within 10 s, restart after 1 s
//! doubling to 5 minutes, back to 1 s after 10 minutes up), never left
//! behind when the front stops.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use roamgate_base::clock::SharedClock;
use roamgate_sidecar::peer::{Peer, PeerOptions, accept_hello};
use roamgate_sidecar::protocol::{Message, PROTOCOL, ShadowSettings, Side};
use roamgate_sidecar::transport::Listener;
use tokio::sync::watch;

use super::{FrontHandler, Socket, Sockets};

const HELLO_TIMEOUT: Duration = Duration::from_secs(10);
const FIRST_DELAY: Duration = Duration::from_secs(1);
const MAX_DELAY: Duration = Duration::from_secs(5 * 60);
const STEADY: Duration = Duration::from_secs(10 * 60);

/// How the Bun core is started.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SidecarCommand {
    pub program: PathBuf,
    pub args: Vec<String>,
}

impl SidecarCommand {
    /// `ROAMGATE_SIDECAR_BIN`: an executable, or a `.ts` file run with
    /// `bun`; unset, `roamgate.bun` next to `own_exe`. `server_args`
    /// are the front's server flags, given to the core as they are.
    pub fn resolve(sidecar_bin: Option<&str>, own_exe: &Path, server_args: &[String]) -> Self {
        let target = sidecar_bin
            .filter(|value| !value.is_empty())
            .map(PathBuf::from)
            .unwrap_or_else(|| own_exe.with_file_name("roamgate.bun"));
        if target.extension().is_some_and(|ext| ext == "ts") {
            let mut args = vec!["run".to_owned(), target.to_string_lossy().into_owned()];
            args.extend(server_args.iter().cloned());
            return Self {
                program: PathBuf::from("bun"),
                args,
            };
        }
        Self {
            program: target,
            args: server_args.to_vec(),
        }
    }
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
}

fn token() -> String {
    hex::encode(rand::random::<[u8; 32]>())
}

fn welcome(_hello: &Message) -> Message {
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
) -> Result<(), String> {
    let mut listener = Listener::bind(&config.channel)
        .map_err(|error| format!("cannot listen on {}: {error}", config.channel))?;
    let token = token();
    let mut command = tokio::process::Command::new(&config.command.program);
    command
        .args(&config.command.args)
        .env("ROAMGATE_CORE_CHANNEL", &config.channel)
        .env("ROAMGATE_CORE_TOKEN", &token)
        // Never a core of its own: it is the core.
        .env_remove("ROAMGATE_CORE_BIN")
        .envs((config.env)())
        .stdin(std::process::Stdio::null())
        .kill_on_drop(true);
    let mut child = command
        .spawn()
        .map_err(|error| format!("cannot start {}: {error}", config.command.program.display()))?;
    let accepted = tokio::time::timeout(HELLO_TIMEOUT, async {
        let mut stream = listener.accept().await.map_err(|error| error.to_string())?;
        accept_hello(&mut stream, &token, welcome)
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
    });
    let peer = Peer::start(stream, handler, PeerOptions::front(config.clock.clone()));
    let _ = link.send(Some(peer.clone()));
    tracing::info!(target: "bridge.front", "the Bun core is connected");
    tokio::select! {
        () = peer.closed() => {}
        status = child.wait() => {
            tracing::warn!(target: "bridge.front", "the Bun core exited: {status:?}");
        }
    }
    let _ = link.send(None);
    drop_sockets(sockets);
    peer.bye();
    if tokio::time::timeout(Duration::from_secs(3), child.wait())
        .await
        .is_err()
    {
        let _ = child.kill().await;
    }
    Ok(())
}

/// Runs the core until the task is aborted, restarting it when it ends.
pub async fn run_sidecar(
    config: SidecarConfig,
    sockets: Sockets,
    link: watch::Sender<Option<Peer>>,
) {
    let mut delay = FIRST_DELAY;
    loop {
        let started = Instant::now();
        if let Err(error) = run_once(&config, &sockets, &link).await {
            tracing::warn!(target: "bridge.front", "{error}");
        }
        if started.elapsed() >= STEADY {
            delay = FIRST_DELAY;
        }
        tokio::time::sleep(delay).await;
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
                program: PathBuf::from("/opt/roamgate/bin/roamgate.bun"),
                args: args.clone()
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
                ]
            }
        );
        assert_eq!(
            SidecarCommand::resolve(Some("/x/roamgate-bun"), exe, &[]).program,
            PathBuf::from("/x/roamgate-bun")
        );
        assert_eq!(
            SidecarCommand::resolve(Some(""), exe, &[]).program,
            PathBuf::from("/opt/roamgate/bin/roamgate.bun")
        );
    }
}
