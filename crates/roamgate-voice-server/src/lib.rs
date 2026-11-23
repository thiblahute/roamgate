//! Roamgate's voice server (Rust migration plan, section 6.2; S22): what
//! server/src/voice, server/src/http/voice*.ts, call-handoff and
//! cli/voice do in the Bun server. The helper itself (voice/helper) is
//! unchanged: this crate supervises it and speaks its frames.

pub mod config;
pub mod download;
pub mod hardware;
pub mod helper;
pub mod js;
pub mod kokoro_language;
pub mod low_gpu;
pub mod models;
pub mod process;
pub mod profiles;
pub mod reading;
pub mod setup;
pub mod speakers;
pub mod speech_rate;
pub mod stock;

#[cfg(test)]
mod testdata;

#[cfg(test)]
mod testing;
