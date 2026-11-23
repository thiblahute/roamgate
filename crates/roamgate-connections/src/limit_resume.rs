//! Resuming the sessions a usage limit stopped, once it resets
//! (server/src/limit-resume): [`store`] keeps what was seen and resumed
//! across restarts, [`connection`] is a connection's Claude panes as the
//! resumer sees them, [`scheduler`] looks and resumes.

pub mod connection;
pub mod scheduler;
pub mod store;
