//! Roamgate's processes and hosts (the Rust migration plan, section 6.2).
//!
//! | Module | What | TS it replaces |
//! |---|---|---|
//! | [`process`] | `ProcessRunner`: timeout, output cap, process group kill, ENOENT as 127, env set and unset; record mode's `RecordObserver` | utils/process-utils, workspace/process, contract-record/hooks recordSpawns |
//! | [`host`] | the `Host` trait and the local host (the SSH hosts are [`ssh::host`]) | the `if (host)` forks |
//! | [`quote`] | `shell_quote` for POSIX, PowerShell and Git Bash; paths typed into a terminal | the shQuote copies, http/terminal-path-text |
//! | [`lanes`] | the lane a call runs in, as a task local | the lane arguments |
//! | [`gamemode`] | whether a game runs (`gamemoded -s`) | utils/gamemode |
//! | [`host_spawn`] | running on the host from a toolbox | utils/host-spawn |
//! | [`install`] | downloading, verifying and installing release files, shared by the updater and the managed Herdr install | http/update's transport, herdr/release's download |
//! | [`service`] | user services: platforms, definition escaping, the blocking command seam, Windows Scheduled Tasks | config/service-definitions and the shared parts of config/service-manager |
//! | [`ssh`] | SSH command lines, session slots, masters, tunnels, forwards, supervised children, Windows hosts, the `Ssh` and `WindowsSsh` hosts | bridge/ssh-* |

pub mod gamemode;
pub mod host;
pub mod host_spawn;
pub mod install;
pub mod lanes;
pub mod process;
pub mod quote;
pub mod service;
pub mod ssh;
