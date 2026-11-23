//! Roamgate's activity log (Rust migration plan, section 6.2). For now the
//! time-report provider bridge, the Hours view's `bridge.time_report`
//! (S12); the recorder, the reader and the timeline move here with the
//! activity family in Phase 3 (S13), and the day input with them: until
//! then it comes from the Bun server, which owns and writes the log.
//!
//! | Module | What |
//! |---|---|
//! | [`time_report`] | the RPC: operations, argument checks, one provider run at a time per day, previews and submit |
//! | [`provider`] | one run of the provider: command line, body on stdin, an empty directory, the timeout, its errors |
//! | [`timeline`] | the date helpers the RPC shares with the timeline |
//! | [`js`] | JSON as JavaScript parses it |

pub mod js;
pub mod provider;
pub mod time_report;
pub mod timeline;
