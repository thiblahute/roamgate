//! The front's core (contract/wire/core-channel.md, The core): the front's
//! own executable as `roamgate core`, every family its. Spawned with the
//! channel's address and token, supervised (hello within 10 s, restart
//! after 1 s doubling to 5 minutes, back to 1 s after 10 minutes up),
//! never left behind when the front stops.

use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};

use roamgate_base::clock::SharedClock;
use roamgate_channel::peer::{Peer, PeerOptions, accept_hello};
use roamgate_channel::protocol::{Ctx, Message, PROTOCOL};
use roamgate_channel::transport::Listener;
use serde_json::Value;
use tokio::sync::watch;

use super::{CoreState, FrontHandler, Socket, Sockets};

const HELLO_TIMEOUT: Duration = Duration::from_secs(10);
const FIRST_DELAY: Duration = Duration::from_secs(1);
const MAX_DELAY: Duration = Duration::from_secs(5 * 60);
const STEADY: Duration = Duration::from_secs(10 * 60);
/// How long a stopping core gets to finish its own shutdown (flushing its
/// stores) once the front said `bye`.
const STOP_GRACE: Duration = Duration::from_secs(15);
/// Win32's `CREATE_NEW_PROCESS_GROUP` process creation flag.
#[cfg(windows)]
const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;

/// What the front gives its core.
#[derive(Clone)]
pub struct CoreSetup {
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
pub struct CoreConfig {
    /// The executable run as `<program> core`: the front's own.
    pub program: PathBuf,
    /// The channel's socket (`<data>/runtime/core-<pid>.sock`).
    pub channel: String,
    pub clock: SharedClock,
    /// Variables set on each start of the core, worked out then (a test
    /// clock's start time is the front's time at that start).
    pub env: Arc<dyn Fn() -> Vec<(String, String)> + Send + Sync>,
    /// Runs as the front welcomes a core, before the `welcome` is sent:
    /// what the core does once welcomed comes after it.
    pub on_welcome: Arc<dyn Fn() + Send + Sync>,
    pub setup: CoreSetup,
}

fn token() -> String {
    hex::encode(rand::random::<[u8; 32]>())
}

/// The core's welcome: the front's test clock when it runs on one.
fn welcome(core: &CoreSetup) -> Message {
    Message::Welcome {
        protocol: PROTOCOL,
        clock: core.test_clock.as_ref().map(|clock| clock.now()),
        raw_data: true,
        node: None,
    }
}

/// How long the front waits for the core's connections to stop
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
    config: &CoreConfig,
    sockets: &Sockets,
    link: &watch::Sender<CoreState>,
    stop: &mut watch::Receiver<bool>,
) -> Result<(), String> {
    let mut listener = Listener::bind(&config.channel)
        .map_err(|error| format!("cannot listen on {}: {error}", config.channel))?;
    let token = token();
    let mut command = tokio::process::Command::new(&config.program);
    command
        .arg("core")
        .env("ROAMGATE_CORE_CHANNEL", &config.channel)
        .env("ROAMGATE_CORE_TOKEN", &token)
        .envs((config.env)())
        .stdin(std::process::Stdio::null())
        .kill_on_drop(true);
    // Its own process group on Windows: a console's CTRL_BREAK or CTRL_C
    // stops the front, which then closes the channel, and the core ends
    // as on a SIGTERM's (its families write what they hold), never killed
    // by the event first.
    #[cfg(windows)]
    command.creation_flags(CREATE_NEW_PROCESS_GROUP);
    let mut child = command
        .spawn()
        .map_err(|error| format!("cannot start {}: {error}", config.program.display()))?;
    let accepted = tokio::time::timeout(HELLO_TIMEOUT, async {
        let mut stream = listener.accept().await.map_err(|error| error.to_string())?;
        accept_hello(&mut stream, &token, |_| {
            (config.on_welcome)();
            welcome(&config.setup)
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
        schedule_exit: config.setup.schedule_exit.clone(),
        session_cookie: config.setup.session_cookie.clone(),
    });
    let peer = Peer::start(stream, handler, PeerOptions::front(config.clock.clone()));
    // The core hears the server's configuration (and starts the
    // connections) before any browser request reaches it.
    if let Err(error) = peer
        .call(
            "internal.front.start",
            config.setup.start.clone(),
            Ctx::default(),
        )
        .await
    {
        tracing::warn!(target: "bridge.front", "the core did not start: {}", error.message);
    }
    link.send_replace(CoreState::Up(peer.clone()));
    // The test clock's advances while the core was being welcomed and
    // started found no core to relay to: it catches up now (an absolute
    // time, so an advance relayed meanwhile is not counted twice).
    if let Some(clock) = &config.setup.test_clock {
        let _ = peer
            .call(
                "internal.clock.advance",
                serde_json::json!({ "to": clock.now() }),
                Ctx::default(),
            )
            .await;
    }
    tracing::info!(target: "bridge.front", "the core is connected");
    let mut stopping = false;
    tokio::select! {
        () = peer.closed() => {}
        status = child.wait() => {
            tracing::warn!(target: "bridge.front", "the core exited: {status:?}");
        }
        _ = stop.wait_for(|stop| *stop) => stopping = true,
    }
    link.send_replace(CoreState::Starting);
    drop_sockets(sockets);
    // The core's connections end while the channel is up.
    if stopping && !peer.is_closed() {
        let _ = tokio::time::timeout(
            STOP_CONNECTIONS,
            peer.call("internal.front.stop", Value::Null, Ctx::default()),
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
pub async fn run_core(
    config: CoreConfig,
    sockets: Sockets,
    link: watch::Sender<CoreState>,
    mut stop: watch::Receiver<bool>,
) {
    let mut delay = FIRST_DELAY;
    loop {
        let started = Instant::now();
        if let Err(error) = run_once(&config, &sockets, &link, &mut stop).await {
            tracing::warn!(target: "bridge.front", "{error}");
            // Requests fail at once rather than wait for a core that
            // could not start.
            link.send_replace(CoreState::Down);
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
