//! Roamgate's parity suite (the Rust migration plan, section 5).
//!
//! It starts a Roamgate server (this checkout's debug `roamgate`, or the
//! one `ROAMGATE_SERVER_CMD` names) in a run of its own (HOME, XDG directories,
//! APPDATA, TMPDIR, data root, its own fake Herdr and every other fake on
//! its PATH or on sockets), drives it only from outside (the browser
//! WebSocket, HTTP, the agent socket and its Python client, the
//! notification and voice sockets, the CLI), moves its test clock, and
//! inspects what it leaves behind (JSON files, SQLite rows, zstd files,
//! git refs). Scenarios are YAML files under `parity/scenarios/`; every
//! run records the server's traffic and checks it against `contract/`.

pub mod agent;
pub mod build;
pub mod check;
pub mod cli;
pub mod clock;
pub mod coverage;
pub mod fakes;
pub mod http;
pub mod inspect;
pub mod ledger;
pub mod matcher;
pub mod normalize;
pub mod paths;
pub mod record;
pub mod run;
pub mod scenario;
pub mod ws;
