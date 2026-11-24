//! The Rust core's link to the Rust front (contract/wire/core-channel.md,
//! The Rust core's link to the Rust front): the front listens on a second
//! channel, whose address and token it gives its Bun core
//! (`ROAMGATE_FRONT_CHANNEL`, `ROAMGATE_FRONT_TOKEN`), and the Rust core
//! the Bun core runs connects to it. The front asks it first for the
//! sockets of the families it may serve; the newest connection is the
//! link, and the sockets it served close when it goes.

use std::sync::Arc;
use std::time::Duration;

use roamgate_base::clock::SharedClock;
use roamgate_sidecar::peer::{Peer, PeerOptions, accept_hello};
use roamgate_sidecar::transport::Listener;
use tokio::sync::watch;

use super::sidecar::welcome;
use super::{FrontHandler, Sockets};

const HELLO_TIMEOUT: Duration = Duration::from_secs(10);

/// A new link token: 32 random bytes in hex.
pub fn link_token() -> String {
    hex::encode(rand::random::<[u8; 32]>())
}

pub struct RustCoreLinkConfig {
    /// The link's socket (`<data>/runtime/front-<pid>.sock`).
    pub channel: String,
    pub token: String,
    pub clock: SharedClock,
}

/// Serves the link until `stop` turns true.
pub async fn run_rust_core_link(
    config: RustCoreLinkConfig,
    sockets: Sockets,
    link: watch::Sender<Option<(u64, Peer)>>,
    mut stop: watch::Receiver<bool>,
) {
    let mut listener = match Listener::bind(&config.channel) {
        Ok(listener) => listener,
        Err(error) => {
            tracing::warn!(
                target: "bridge.front",
                "cannot listen on {} for the Rust core: {error}; the Bun core serves every socket",
                config.channel
            );
            return;
        }
    };
    let link = Arc::new(link);
    let mut number = 0u64;
    loop {
        let mut stream = tokio::select! {
            accepted = listener.accept() => match accepted {
                Ok(stream) => stream,
                Err(error) => {
                    tracing::warn!(target: "bridge.front", "the Rust core's link: {error}");
                    tokio::time::sleep(Duration::from_secs(1)).await;
                    continue;
                }
            },
            () = async { let _ = stop.wait_for(|stop| *stop).await; } => break,
        };
        let hello = tokio::time::timeout(
            HELLO_TIMEOUT,
            accept_hello(&mut stream, &config.token, welcome),
        )
        .await;
        if !matches!(hello, Ok(Ok(_))) {
            tracing::warn!(target: "bridge.front", "a Rust core's link without a good hello, closed");
            continue;
        }
        number += 1;
        let handler = Arc::new(FrontHandler {
            sockets: sockets.clone(),
            schedule_exit: None,
            session_cookie: None,
        });
        let peer = Peer::start(stream, handler, PeerOptions::front(config.clock.clone()));
        if let Some((before, old)) = link.send_replace(Some((number, peer.clone()))) {
            old.bye();
            sockets.drop_rust(before);
        }
        tracing::info!(target: "bridge.front", "the Rust core is linked");
        let (link, sockets, this) = (link.clone(), sockets.clone(), number);
        tokio::spawn(async move {
            peer.closed().await;
            link.send_if_modified(|current| {
                if current.as_ref().is_some_and(|(number, _)| *number == this) {
                    *current = None;
                    true
                } else {
                    false
                }
            });
            sockets.drop_rust(this);
        });
    }
    if let Some((number, peer)) = link.send_replace(None) {
        peer.bye();
        sockets.drop_rust(number);
    }
    drop(listener);
    let _ = std::fs::remove_file(&config.channel);
}
