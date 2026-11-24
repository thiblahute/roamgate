//! Roamgate's local history (server/src/history; docs/ARCHITECTURE.md,
//! "History"): a git repository of what is authored in Roamgate, at
//! `<data>/history` unless Settings moves it, the same repository Bun
//! writes, file for file and commit for commit.
//!
//! - [`format`]: key-sorted JSON, prose with one-line JSON headers, JSONL,
//!   ids as file names;
//! - [`area`], [`files`], [`work`], [`reviews`], [`mr_reviews`]: what each
//!   store renders into the repo (an allowlist);
//! - [`repo`]: a pass (Work changes one commit each, then the areas in one,
//!   the secret scan through roamgate-base's patterns), the status, the
//!   lock Bun takes too;
//! - [`runtime`]: the server's dirty sets, debounce, polls of the file
//!   areas, the start pass, GameMode;
//! - [`place`]: where the repo is, whether it is on, the commits' host.

pub mod area;
pub mod files;
pub mod format;
pub mod git;
pub mod mr_reviews;
pub mod place;
pub mod repo;
pub mod reviews;
pub mod runtime;
pub mod work;
