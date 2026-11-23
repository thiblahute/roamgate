//! Roamgate's command line (Rust migration plan, section 6.2): for now
//! what the update and herdr_setup families need.
//!
//! | Module | What | TS it replaces |
//! |---|---|---|
//! | [`update`] | release targets, manifests, versions, mirrors, the supervisor check, the installer | http/update helpers |
//! | [`update_http`] | `/api/update/check` and `/api/update/install` | http/update createUpdateHandlers |
//! | [`commands`] | `roamgate update` and `roamgate rollback` | cli/update |
//! | [`herdr`] | `roamgate herdr` | herdr/cli, the Herdr part of config/server-config |
//! | [`service`] | Roamgate's own service: paths, the published legacy one, the environment file, status and restart | the parts of config/service-definitions, service-manager and launchd-environment these use |
//! | [`output`] | what a command prints | console.log and console.error |

use std::future::Future;
use std::pin::Pin;

pub mod commands;
pub mod herdr;
pub mod output;
pub mod service;
pub mod update;
pub mod update_http;

pub type BoxFuture<T> = Pin<Box<dyn Future<Output = T> + Send + 'static>>;
