//! The archive family in the core (`bridge.archive.search` and
//! `bridge.archive.open`, the archive search view; `roamgate archive`):
//! roamgate-archive's search and open, read from the same settings.json
//! and archive directory as Bun's. The family's writers are the CLI's
//! (sync, ingest, push, the text pass, rebuild-db), which the Bun CLI runs
//! in this binary while Rust owns the family; the server side only writes
//! the search's scratch overlay (`text-live/`), so the front's own archive
//! search (Ranger's tools) comes here too (`internal.archive.search`).
//! Bun keeps its read-only readers (deleted transcripts read back, Ranger's
//! session lookup and read), which open archive.sqlite as readers.

use std::sync::Arc;

use roamgate_archive::dir::resolve_archive_dir;
use roamgate_archive::hosts::ArchiveRuntime;
use roamgate_archive::open::open_archived;
use roamgate_archive::rpc::{ParamError, archive_open_request, archive_search_query};
use roamgate_archive::search::{SearchOptions, SearchQuery, search_archive};
use roamgate_archive::settings::{ArchiveSettings, normalize_archive_settings};
use roamgate_base::env::{Env, ProcessEnv, roamgate_env};
use roamgate_base::paths::DataContext;
use roamgate_sidecar::family::{CoreFamily, FamilyContext};
use roamgate_sidecar::peer::{BoxFuture, IncomingCall};
use roamgate_sidecar::protocol::RpcError;
use serde_json::Value;

pub const FAMILY: &str = "archive";

/// The family, once this build implements it.
pub fn family() -> Option<Arc<dyn CoreFamily>> {
    Some(Arc::new(ArchiveFamily))
}

struct ArchiveFamily;

/// settings.json as the server's environment names it (Bun's, the file's
/// owner until the settings family moves).
fn settings_file(env: &dyn Env) -> std::path::PathBuf {
    match roamgate_env(env, "SETTINGS_PATH") {
        Some(path) => path.into(),
        None => DataContext::from_env(env).data_root().join("settings.json"),
    }
}

/// `archive` in settings.json now, read whole at each call.
pub(crate) fn settings(env: &dyn Env) -> ArchiveSettings {
    let path = settings_file(env);
    let raw = std::fs::read(&path)
        .ok()
        .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok());
    normalize_archive_settings(raw.as_ref().and_then(|raw| raw.get("archive")))
}

fn hostname() -> String {
    std::fs::read_to_string("/proc/sys/kernel/hostname")
        .ok()
        .map(|name| name.trim().to_owned())
        .or_else(|| std::env::var("HOSTNAME").ok())
        .unwrap_or_else(|| "host".into())
}

/// The server's archive runtime: its home, platform, environment, data.
pub(crate) fn runtime() -> ArchiveRuntime {
    let context = DataContext::from_env(&ProcessEnv);
    ArchiveRuntime {
        home_dir: context.home.clone(),
        platform: roamgate_exec::service::node_platform().into(),
        env: Arc::new(|name| std::env::var(name).ok()),
        data_dir: context.data_root(),
        context,
        hostname: hostname(),
    }
}

/// `ROAMGATE_ARCHIVE_DIR?.trim() || settings.dir`, else the default.
pub(crate) fn archive_dir(
    settings: &ArchiveSettings,
    runtime: &ArchiveRuntime,
) -> std::path::PathBuf {
    let explicit = std::env::var("ROAMGATE_ARCHIVE_DIR")
        .ok()
        .map(|dir| dir.trim().to_owned())
        .filter(|dir| !dir.is_empty())
        .or_else(|| settings.dir.clone());
    resolve_archive_dir(explicit.as_deref(), &runtime.data_dir, &mut |line| {
        tracing::info!(scope = "bridge.archive", "{line}");
    })
}

fn param_error(error: ParamError) -> RpcError {
    RpcError::new(error.message().to_owned())
}

fn archive_error(error: roamgate_archive::Error) -> RpcError {
    match error.code {
        Some(code) => RpcError::with_code(error.message, code),
        None => RpcError::new(error.message),
    }
}

/// A search as the server runs it: with this machine's grown sessions.
fn search(query: SearchQuery, map_no_repo: bool) -> Result<Value, RpcError> {
    let settings = settings(&ProcessEnv);
    let runtime = runtime();
    let dir = archive_dir(&settings, &runtime);
    let options = SearchOptions {
        runtime: Some(&runtime),
        ..SearchOptions::default()
    };
    match search_archive(&dir, &query, &settings, options) {
        Ok(result) => Ok(serde_json::to_value(result).unwrap_or(Value::Null)),
        // The search view's words; Ranger's tools word it themselves.
        Err(error) if map_no_repo && error.code == Some("no_text_repo") => {
            Err(RpcError::new("There is no session archive here yet."))
        }
        Err(error) => Err(archive_error(error)),
    }
}

fn open(params: &Value) -> Result<Value, RpcError> {
    let settings = settings(&ProcessEnv);
    let runtime = runtime();
    let dir = archive_dir(&settings, &runtime);
    let request = archive_open_request(params).map_err(param_error)?;
    let opened = open_archived(&dir, &settings, &request, Some(&runtime)).map_err(archive_error)?;
    Ok(serde_json::to_value(opened).unwrap_or(Value::Null))
}

/// `roamgate archive ...` (the Bun CLI passes it through while Rust owns
/// the family); returns the exit code.
pub async fn cli(args: &[String]) -> u8 {
    roamgate_sidecar::core::note_served(&ProcessEnv, FAMILY, "cli archive");
    let cli = roamgate_cli::archive::ArchiveCli::system(Arc::new(ProcessEnv));
    let mut out = roamgate_cli::archive::ProcessOutput;
    let code = cli.run(args, &mut out).await;
    u8::try_from(code).unwrap_or(1)
}

impl CoreFamily for ArchiveFamily {
    fn name(&self) -> &'static str {
        FAMILY
    }

    fn call(&self, _cx: &FamilyContext, call: IncomingCall) -> BoxFuture<Result<Value, RpcError>> {
        Box::pin(async move {
            roamgate_sidecar::core::note_served(&ProcessEnv, FAMILY, &call.method);
            let params = call.params;
            let method = call.method;
            let work = move || -> Result<Value, RpcError> {
                match method.as_str() {
                    "bridge.archive.search" => {
                        let query = archive_search_query(&params).map_err(param_error)?;
                        search(query, true)
                    }
                    "bridge.archive.open" => open(&params),
                    // Ranger's archive_search: the query as Bun built it.
                    "internal.archive.search" => {
                        let query: SearchQuery = serde_json::from_value(params)
                            .map_err(|error| RpcError::new(format!("invalid search: {error}")))?;
                        search(query, false)
                    }
                    other => Err(RpcError::with_code(
                        format!("unknown method {other}"),
                        "unknown_method",
                    )),
                }
            };
            tokio::task::spawn_blocking(work)
                .await
                .unwrap_or_else(|error| Err(RpcError::new(error.to_string())))
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use roamgate_archive::search::NO_TEXT_REPO;

    #[test]
    fn no_text_repo_keeps_its_code_for_the_front() {
        let error = archive_error(roamgate_archive::Error::with_code(
            NO_TEXT_REPO,
            "no_text_repo",
        ));
        assert_eq!(error.code.as_deref(), Some("no_text_repo"));
    }
}
