//! Herdr for Roamgate (Rust migration plan, section 6.2): for now the parts
//! the herdr_setup family needs (`roamgate herdr` itself is roamgate-cli's).
//!
//! | Module | What | TS it replaces |
//! |---|---|---|
//! | [`release`] | the verified release and its managed install | herdr/release |
//! | [`service`] | the user service running `herdr server` | herdr/service |
//! | [`bootstrap`] | detection and managed setup | herdr/bootstrap |
//! | [`http`] | the status, setup and info answers | http/herdr-setup, http/herdr-info |
//! | [`client`] | the control socket's one-shot request (ping) | bridge/herdr-client `request` |
//! | [`protocol`] | the supported Herdr protocols | bridge/protocol-compat |

use std::future::Future;
use std::pin::Pin;

pub mod bootstrap;
pub mod client;
pub mod http;
pub mod protocol;
pub mod release;
pub mod service;

pub type BoxFuture<T> = Pin<Box<dyn Future<Output = T> + Send + 'static>>;
