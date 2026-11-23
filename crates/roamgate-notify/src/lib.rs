//! Roamgate's notifications (Rust migration plan, section 6.2): one source
//! for every notification Roamgate sends, built once for Web Push
//! (browsers) and for the notification feed (the Android app's socket).
//!
//! - [`feed`]: the feed's numbered events and `notifications.json`.
//! - [`web_push`]: the device registry with the VAPID keys
//!   (`web-push.json`), the enrollment route and delivery.
//! - [`crypto`]: VAPID and the aes128gcm encoding, as `web-push` does them.
//! - [`payload`]: what a notification says.
//! - [`task_events`]: an agent finishing or blocking, from Herdr's events.
//! - [`service`]: the feed and Web Push together, started and stopped with
//!   the family's ownership.
//! - [`cli`]: `roamgate push test`.
//!
//! In stage 1 the notification socket stays with the Bun front, which
//! delivers the events this crate gives it (contract/wire/core-channel.md).

pub mod cli;
pub mod crypto;
pub mod feed;
pub mod payload;
pub mod service;
pub mod task_events;
pub mod web_push;
