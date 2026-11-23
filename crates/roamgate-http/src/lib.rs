//! Roamgate's HTTP and RPC surface (Rust migration plan, section 6.2), the
//! front of Phase 7 (S18), built as handlers over `http` types so that the
//! axum listener, the parity harness and unit tests drive the same code:
//!
//! | Module | What | TS it replaces |
//! |---|---|---|
//! | [`response`] | responses as Bun's `Response` writes them | `Response`, `Response.json` |
//! | [`body`] | a JSON body read under a byte limit | http/json-body |
//! | [`auth`] | cookie sessions, password, PIN and URL-token logins, their limits, logout | http/auth |
//! | [`login_page`] | the login page from its contract asset | http/login-page |
//! | [`public_origin`] | the origin a client reached Roamgate on | http/public-origin |
//! | [`static_paths`], [`static_files`] | the web app, its manifest and the instance name | http/static-paths, http/static-files |
//! | [`frame_to_ansi`] | a Herdr cell grid re-encoded as ANSI for xterm.js | bridge/frame-to-ansi |
//! | [`terminal_upload`] | dropped files and pasted images staged privately, copied over SSH | http/terminal-upload, http/image-upload |
//! | [`list_delta`] | topology lists answered as changes | bridge/list-delta |
//! | [`settings`] | the settings RPCs and `/api/instance-settings`, on the one settings.json writer (S13) | bridge/settings-rpc, http/instance-settings |

pub mod auth;
pub mod body;
pub mod frame_to_ansi;
pub mod list_delta;
pub mod login_page;
pub mod public_origin;
pub mod response;
pub mod settings;
pub mod static_files;
pub mod static_paths;
pub mod terminal_upload;

#[cfg(test)]
pub(crate) mod test_support;
