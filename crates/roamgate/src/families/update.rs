//! The update family in the core (see [`super`]): `/api/update/check`,
//! `/api/update/install`, and `roamgate update` / `roamgate rollback`
//! passed through by the Bun CLI, all roamgate-cli's code.
//!
//! The executable an update replaces is the front's (the Bun binary the
//! service runs): the Bun server gives its core `ROAMGATE_CLI_EXEC`,
//! `ROAMGATE_CLI_VERSION` and `ROAMGATE_CLI_STANDALONE`, as the Bun CLI does
//! for a pass-through. After an install the front exits for its supervisor
//! through the reverse target `server.scheduleExit`.

use std::path::PathBuf;
use std::sync::{Arc, OnceLock};

use roamgate_base::env::{Env, ProcessEnv};
use roamgate_cli::commands::{CliRuntime, Effects};
use roamgate_cli::update::system_run_process;
use roamgate_cli::update_http::{UpdateHandlers, UpdateRuntime, has_update_confirmation};
use roamgate_exec::process::ProcessRunner;
use roamgate_exec::service::{SystemCommands, node_arch, node_platform};
use roamgate_sidecar::family::{CoreFamily, FamilyContext};
use roamgate_sidecar::peer::{BodyReceiver, BoxFuture, HttpRequest, HttpResponse};
use roamgate_sidecar::protocol::RpcError;
use serde_json::{Value, json};

/// The front's executable: the variables its front set, else this one.
pub struct FrontExecutable {
    pub path: PathBuf,
    pub version: String,
    pub standalone: bool,
}

pub fn front_executable(env: &dyn Env) -> FrontExecutable {
    let path = env
        .var("ROAMGATE_CLI_EXEC")
        .filter(|path| !path.is_empty())
        .map(PathBuf::from)
        .or_else(|| std::env::current_exe().ok())
        .unwrap_or_default();
    FrontExecutable {
        path,
        version: env
            .var("ROAMGATE_CLI_VERSION")
            .filter(|version| !version.is_empty())
            .unwrap_or_else(|| crate::VERSION.to_owned()),
        standalone: env.var("ROAMGATE_CLI_STANDALONE").as_deref() != Some("0"),
    }
}

/// A JSON answer as the front's handlers send them (`Response.json` with
/// `cache-control: no-store`).
pub fn json_response(status: u16, body: &Value) -> HttpResponse {
    let (tx, rx) = tokio::sync::mpsc::channel(1);
    let bytes = serde_json::to_vec(body).unwrap_or_default();
    let _ = tx.try_send(bytes);
    HttpResponse {
        status,
        headers: vec![
            (
                "content-type".into(),
                "application/json;charset=utf-8".into(),
            ),
            ("cache-control".into(), "no-store".into()),
        ],
        body: Some(rx),
    }
}

/// A request header (names are lowercase on the channel).
pub fn header(request: &HttpRequest, name: &str) -> Option<String> {
    request
        .headers
        .iter()
        .find(|(header, _)| header == name)
        .map(|(_, value)| value.clone())
}

pub fn path_of(url: &str) -> &str {
    url.split(['?', '#']).next().unwrap_or("")
}

struct UpdateFamily {
    handlers: OnceLock<Arc<UpdateHandlers>>,
}

impl UpdateFamily {
    fn handlers(&self, cx: &FamilyContext) -> Arc<UpdateHandlers> {
        self.handlers
            .get_or_init(|| {
                let front = front_executable(&ProcessEnv);
                let reverse_cx = cx.clone();
                Arc::new(UpdateHandlers::new(
                    front.version,
                    system_run_process(ProcessRunner::new(cx.clock.clone())),
                    UpdateRuntime {
                        platform: node_platform().into(),
                        arch: node_arch().into(),
                        exec_path: front.path.display().to_string(),
                        standalone: front.standalone,
                    },
                    Arc::new(ProcessEnv),
                    cx.clock.clone(),
                    Arc::new(move || {
                        let cx = reverse_cx.clone();
                        tokio::spawn(async move {
                            if let Err(error) = cx.reverse("server.scheduleExit", json!({})).await {
                                tracing::warn!(
                                    scope = "core.update",
                                    "the front did not schedule its restart after an update: {}",
                                    error.message
                                );
                            }
                        });
                    }),
                ))
            })
            .clone()
    }
}

impl CoreFamily for UpdateFamily {
    fn name(&self) -> &'static str {
        "update"
    }

    fn http(
        &self,
        cx: &FamilyContext,
        request: HttpRequest,
        _body: Option<BodyReceiver>,
    ) -> BoxFuture<Result<HttpResponse, RpcError>> {
        let handlers = self.handlers(cx);
        Box::pin(async move {
            let confirmed = has_update_confirmation(|name| header(&request, name));
            let method = request.method.to_ascii_uppercase();
            let (status, body) = match (method.as_str(), path_of(&request.url)) {
                ("GET", "/api/update/check") => handlers.check(confirmed).await,
                ("POST", "/api/update/install") => handlers.install(confirmed).await,
                _ => return Ok(HttpResponse::status(404)),
            };
            Ok(json_response(status, &body))
        })
    }
}

/// The family.
pub fn family() -> Option<Arc<dyn CoreFamily>> {
    Some(Arc::new(UpdateFamily {
        handlers: OnceLock::new(),
    }))
}

/// The CLI's view of the executable to replace.
pub fn cli_runtime(env: Arc<dyn Env>) -> CliRuntime {
    let front = front_executable(env.as_ref());
    let home = if cfg!(windows) {
        env.var("USERPROFILE").or_else(|| env.var("HOME"))
    } else {
        env.var("HOME")
    }
    .map(PathBuf::from)
    .unwrap_or_default();
    CliRuntime {
        platform: node_platform().into(),
        arch: node_arch().into(),
        home,
        app_data: env.var("APPDATA").map(PathBuf::from),
        exec_path: front.path,
        version: front.version,
        standalone: front.standalone,
        uid: roamgate_herdr::service::current_uid(),
        env,
    }
}

/// Writes what a command printed; its exit code.
pub fn emit(printed: roamgate_cli::output::Printed) -> u8 {
    use std::io::Write;
    let _ = std::io::stdout().write_all(printed.stdout.as_bytes());
    let _ = std::io::stderr().write_all(printed.stderr.as_bytes());
    u8::try_from(printed.code).unwrap_or(1)
}

/// `roamgate update ...` and `roamgate rollback ...` (`command` is which);
/// returns the exit code.
pub async fn cli(command: &str, args: &[String]) -> u8 {
    roamgate_sidecar::core::note_served(&ProcessEnv, "update", &format!("cli {command}"));
    let runtime = cli_runtime(Arc::new(ProcessEnv));
    let effects = Effects {
        run_process: system_run_process(ProcessRunner::system()),
        run: Arc::new(SystemCommands),
    };
    emit(if command == "rollback" {
        roamgate_cli::commands::rollback(&runtime, &effects, args).await
    } else {
        roamgate_cli::commands::update(&runtime, &effects, args).await
    })
}
