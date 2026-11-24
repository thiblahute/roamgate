//! Herdr for Roamgate (Rust migration plan, section 6.2): the herdr_setup
//! family's parts (`roamgate herdr` itself is roamgate-cli's), the control
//! client and the client socket's handshake the host family needs. The
//! endpoint generation 1 client comes with the terminal bridge (S18).
//!
//! | Module | What | TS it replaces |
//! |---|---|---|
//! | [`release`] | the verified release and its managed install | herdr/release |
//! | [`service`] | the user service running `herdr server` | herdr/service |
//! | [`bootstrap`] | detection and managed setup | herdr/bootstrap |
//! | [`http`] | the status, setup and info answers | http/herdr-setup, http/herdr-info |
//! | [`client`] | the control socket's one-shot request (ping) | bridge/herdr-client `request` |
//! | [`control`] | the control client: shared and reused reads, subscriptions | bridge/herdr-client |
//! | [`endpoint`] | the endpoint's boot id, read by a passive handshake | bridge/endpoint-client (connect, its welcome and first snapshot) |
//! | [`thin`] | the client socket: bincode, Hello/Welcome, attach, input | bridge/thin-client, bridge/bincode |
//! | [`protocol`] | the supported Herdr protocols | bridge/protocol-compat |

use std::future::Future;
use std::pin::Pin;

pub mod bootstrap;
pub mod client;
pub mod control;
pub mod endpoint;
pub mod http;
pub mod protocol;
pub mod release;
pub mod service;
pub mod thin;

pub type BoxFuture<T> = Pin<Box<dyn Future<Output = T> + Send + 'static>>;
