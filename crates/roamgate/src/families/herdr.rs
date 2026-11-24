//! The herdr_setup family in the core (see [`super`]): `/api/herdr/status`,
//! `/api/herdr/setup`, and `roamgate herdr` passed through by the Bun CLI,
//! roamgate-herdr's and roamgate-cli's code.
//!
//! The default connection is still Bun's (the host family moves in phase
//! 5), so its setup guard and its Herdr ping come from the front through
//! the reverse targets `herdr.setupGuard` and `herdr.ping`; detection,
//! the release install and the user service run here.

use std::path::PathBuf;
use std::sync::{Arc, OnceLock};

use roamgate_base::env::{Env, ProcessEnv};
use roamgate_cli::herdr::HerdrCli;
use roamgate_herdr::bootstrap::{Locations, Ping, SetupGuard};
use roamgate_herdr::http::{HERDR_SETUP_CONFIRMATION_HEADER, SetupHandlers};
use roamgate_sidecar::family::{CoreFamily, FamilyContext};
use roamgate_sidecar::peer::{BodyReceiver, BoxFuture, HttpRequest, HttpResponse};
use roamgate_sidecar::protocol::RpcError;
use serde_json::json;

use super::update::{front_executable, header, json_response, path_of};

struct HerdrFamily {
    handlers: OnceLock<Arc<SetupHandlers>>,
}

fn herdr_cli(env: Arc<dyn Env>, clock: roamgate_base::clock::SharedClock) -> HerdrCli {
    let version = front_executable(env.as_ref()).version;
    let mut cli = HerdrCli::system(env, version);
    cli.clock = clock;
    cli
}

impl HerdrFamily {
    fn handlers(&self, cx: &FamilyContext) -> Arc<SetupHandlers> {
        self.handlers
            .get_or_init(|| {
                let env: Arc<dyn Env> = Arc::new(ProcessEnv);
                let cli = Arc::new(herdr_cli(env.clone(), cx.clock.clone()));
                let guard_cx = cx.clone();
                let ping_cx = cx.clone();
                let ping: Ping = Arc::new(move || {
                    let cx = ping_cx.clone();
                    Box::pin(async move {
                        cx.reverse("herdr.ping", json!({}))
                            .await
                            .map_err(|error| error.message)
                    })
                });
                let make = cli.clone();
                Arc::new(SetupHandlers::new(
                    Arc::new(move || {
                        let cx = guard_cx.clone();
                        Box::pin(async move {
                            cx.reverse("herdr.setupGuard", json!({}))
                                .await
                                .map(|guard| SetupGuard::from_json(&guard))
                                .map_err(|error| error.message)
                        })
                    }),
                    ping,
                    Locations {
                        platform: cli.platform.clone(),
                        home: cli.home.clone(),
                        app_data: env.var("APPDATA").map(PathBuf::from),
                        path_env: env.var("PATH").unwrap_or_default(),
                    },
                    cli.arch.clone(),
                    Arc::new(move |guard, ping| make.setup(guard, ping)),
                ))
            })
            .clone()
    }
}

impl CoreFamily for HerdrFamily {
    fn name(&self) -> &'static str {
        "herdr_setup"
    }

    fn http(
        &self,
        cx: &FamilyContext,
        request: HttpRequest,
        _body: Option<BodyReceiver>,
    ) -> BoxFuture<Result<HttpResponse, RpcError>> {
        let handlers = self.handlers(cx);
        Box::pin(async move {
            let method = request.method.to_ascii_uppercase();
            let (status, body) = match (method.as_str(), path_of(&request.url)) {
                ("GET", "/api/herdr/status") => handlers.status().await,
                ("POST", "/api/herdr/setup") => {
                    let confirmed =
                        header(&request, HERDR_SETUP_CONFIRMATION_HEADER).as_deref() == Some("1");
                    handlers.setup(confirmed).await
                }
                _ => return Ok(HttpResponse::status(404)),
            };
            Ok(json_response(status, &body))
        })
    }
}

/// The family.
pub fn family() -> Option<Arc<dyn CoreFamily>> {
    Some(Arc::new(HerdrFamily {
        handlers: OnceLock::new(),
    }))
}

/// `roamgate herdr ...`; returns the exit code.
pub async fn cli(args: &[String]) -> u8 {
    roamgate_sidecar::core::note_served(&ProcessEnv, "herdr_setup", "cli herdr");
    let env: Arc<dyn Env> = Arc::new(ProcessEnv);
    let cli = herdr_cli(env, Arc::new(roamgate_base::clock::SystemClock));
    super::update::emit(cli.run(args).await)
}
