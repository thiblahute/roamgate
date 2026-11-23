//! Roamgate's command line (Rust migration plan, section 6.2): for now
//! what the update and herdr_setup families need.
//!
//! | Module | What | TS it replaces |
//! |---|---|---|
//! | [`archive`] | `roamgate archive` | cli/archive |
//! | [`update`] | release targets, manifests, versions, mirrors, the supervisor check, the installer | http/update helpers |
//! | [`update_http`] | `/api/update/check` and `/api/update/install` | http/update createUpdateHandlers |
//! | [`commands`] | `roamgate update` and `roamgate rollback` | cli/update |
//! | [`push`] | `roamgate push` | cli/push |
//! | [`herdr`] | `roamgate herdr` | herdr/cli, the Herdr part of config/server-config |
//! | [`service`] | Roamgate's own service: paths, the published legacy one, the environment file, status and restart | the parts of config/service-definitions, service-manager and launchd-environment these use |
//! | [`server_config`] | the server's flags and environment as management commands read them, with their validation | config/server-config loadServerConfig |
//! | [`auth_token`] | the generated login token | config/auth-token |
//! | [`voice`] | `roamgate voice` | cli/voice |
//! | [`setup_voice`] | `roamgate setup voice` | cli/setup |
//! | [`output`] | what a command prints | console.log and console.error |

use std::future::Future;
use std::pin::Pin;

pub mod activity;
pub mod archive;
pub mod args;
pub mod auth;
pub mod auth_token;
pub mod commands;
pub mod completion;
pub mod config;
pub mod connections;
pub mod context;
pub mod doctor;
pub mod herdr;
pub mod index;
pub mod launchd_environment;
pub mod output;
pub mod plugin;
pub mod push;
pub mod qr;
pub mod server_config;
pub mod service;
pub mod service_context;
pub mod service_logs;
pub mod service_manager;
pub mod setup_voice;
pub mod update;
pub mod update_http;
pub mod url;
pub mod voice;

pub type BoxFuture<T> = Pin<Box<dyn Future<Output = T> + Send + 'static>>;
