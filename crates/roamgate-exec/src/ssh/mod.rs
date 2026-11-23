//! SSH: command lines (`command`), session slots and lanes (`sessions`),
//! ControlMaster (`master`), the Herdr tunnel (`tunnel`), port forwards
//! (`forward`), the supervised child they share (`supervised`), the `Ssh`
//! and `WindowsSsh` hosts (`host`), refusals (`refused`), metrics
//! (`metrics`), OpenSSH discovery (`openssh`) and Windows hosts' Herdr
//! bridges (`windows`).

pub mod command;
pub mod forward;
pub mod host;
pub mod master;
pub mod metrics;
pub mod openssh;
pub mod refused;
pub mod sessions;
pub mod supervised;
pub mod tunnel;
pub mod windows;
