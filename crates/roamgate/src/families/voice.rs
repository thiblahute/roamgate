//! The voice family in the core (see [`super`]; Phase 10, S22):
//! `/api/voice` and everything under it, served by roamgate-voice-server's
//! routes (status, settings, speech, voices, setup, low-GPU, the call
//! handoff's redeem and the companion's routes), with the helper, the
//! voice socket the routes read the running call from, the companion
//! layer, and `roamgate voice` and `roamgate setup voice` passed through by
//! the Bun CLI.
//!
//! Behind the Rust front the core serves the voice socket and a call's
//! signalling while it owns the family ([`super::voice_socket`], on the
//! Rust core's link to the front); behind the Bun front every browser
//! WebSocket is Bun's (contract/wire/core-channel.md), so the family flips
//! only behind the Rust front. What the companion needs of what Bun owns comes by reverse
//! call: the sessions its errands go to (`voice.errand_read`,
//! `voice.errand_prompt`, `voice.errand_status`), the Work board's user
//! tools and states (`voice.work_tool`, `voice.work_states`, Bun's board or
//! the core's, as Bun's own companion has them) and a new login for a
//! handed-off call (`voice.session_cookie`).
//!
//! One helper at a time: taking the family, the core asks Bun to stop its
//! own voice first (`voice.release`) and serves nothing that may start its
//! helper before Bun did; giving it back, it stops its helper, watches and
//! companion when the front asks (`internal.voice.release`).

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

use futures_util::FutureExt;
use futures_util::future::{BoxFuture as FutureBox, Shared};
use roamgate_base::env::ProcessEnv;
use roamgate_base::paths::DataContext;
use roamgate_sidecar::family::{CoreFamily, FamilyContext};
use roamgate_sidecar::peer::{BodyReceiver, BoxFuture, HttpRequest, HttpResponse, IncomingCall};
use roamgate_sidecar::protocol::RpcError;
use roamgate_voice_server::companion::answers::answers_dir;
use roamgate_voice_server::companion::claude::{ClaudeCommand, ResolveCommand};
use roamgate_voice_server::companion::errands::{
    ErrandDeps, ErrandSessionStatus, ErrandTiming, KeptAnswer, VoiceErrands,
};
use roamgate_voice_server::companion::front::{ConfiguredFront, spawn_front};
use roamgate_voice_server::companion::memory::{
    COMPACT_TIMEOUT_MS, CompanionMemory, MemoryOptions, companion_memory_path, front_compaction,
    spawn_compaction,
};
use roamgate_voice_server::companion::memory_files::{
    CompanionMemoryFiles, companion_memories_dir,
};
use roamgate_voice_server::companion::research::{ConfiguredResearch, ReadConfig};
use roamgate_voice_server::companion::router::ConfiguredRouter;
use roamgate_voice_server::companion::seam::VoiceCompanion;
use roamgate_voice_server::companion::taste::{VoiceTaste, taste_path};
use roamgate_voice_server::companion::tools::{
    ConfiguredTools, ToolsSetup, VoiceWorkBoard, YoutubeSource,
};
use roamgate_voice_server::companion::turn_causes::TurnCauses;
use roamgate_voice_server::companion::waiting::{NewAnswer, WaitingAnswers, waiting_answers_file};
use roamgate_voice_server::config::{
    VoiceConfig, read_voice_config, voice_config_path, write_max_pause, write_speech_rate,
};
use roamgate_voice_server::helper::VoiceHelper;
use roamgate_voice_server::http::companion::{
    CompanionOptions, CompanionRoutes, Errands, Front, Router,
};
use roamgate_voice_server::http::handoff::CallHandoffRedeem;
use roamgate_voice_server::http::low_gpu::low_gpu_route;
use roamgate_voice_server::http::routes::{RoutesOptions, VoiceRoutes, Voices, light_voice};
use roamgate_voice_server::http::setup::SetupRoute;
use roamgate_voice_server::http::{Answer, AnswerBody, Body, Request};
use roamgate_voice_server::library::{LibraryOptions, VoiceLibrary, default_voices_dir};
use roamgate_voice_server::low_gpu::{LowGpuDeps, LowGpuWatch, VoiceLowGpu, low_gpu_path};
use roamgate_voice_server::models::default_models_dir;
use roamgate_voice_server::process::spawn_voice_helper;
use roamgate_voice_server::setup::VoiceSetupRunner;
use roamgate_voice_server::socket::{VoiceSocket, VoiceSocketOptions};
use serde_json::{Value, json};

use super::update::{cli_runtime, emit, path_of};
use super::voice_socket::VoiceSockets;

/// The largest request body a voice route reads (a recording, 12 MB).
const MAX_BODY: usize = roamgate_voice_server::http::routes::MAX_RECORDING_BYTES + 1024 * 1024;
/// How often the low-GPU profile looks at its file and the games.
const LOW_GPU_WATCH_MS: u64 = 2000;

/// The companion's Claude Code: voice.json's `claude_command`, else
/// `claude` (the default agent profile's command comes with S21's
/// profiles, as `helperCommand` resolves it in Bun).
fn resolve_command() -> ResolveCommand {
    Arc::new(
        |program: Option<&str>| match program.filter(|p| !p.is_empty()) {
            Some(program) => ClaudeCommand::program(program),
            None => ClaudeCommand::default(),
        },
    )
}

/// The setup assistant's deps: the host's, on the family's clock, with
/// what a test server gives instead of the real world
/// (ROAMGATE_TEST_VOICE_HARDWARE, ROAMGATE_TEST_VOICE_MODELS_URL).
fn setup_deps(
    runtime: &roamgate_cli::commands::CliRuntime,
    clock: roamgate_base::clock::SharedClock,
) -> roamgate_voice_server::setup::SetupDeps {
    use roamgate_voice_server::companion::test_env::{TEST_VOICE_HONOURED, voice_test_overrides};
    let mut deps = roamgate_cli::setup_voice::runtime_setup_deps(runtime);
    deps.clock = clock;
    match voice_test_overrides(
        &|name| std::env::var(name).ok(),
        TEST_VOICE_HONOURED,
        roamgate_voice_server::models::packages(),
    ) {
        Ok(overrides) => {
            if let Some(hardware) = overrides.hardware {
                let host = deps.hardware.clone();
                deps.hardware = Arc::new(move || {
                    hardware().unwrap_or_else(|error| {
                        tracing::warn!(scope = "voice", "the test hardware file: {error}");
                        host()
                    })
                });
            }
            if let Some(packages) = overrides.packages {
                deps.packages = Some(packages);
            }
        }
        Err(error) => tracing::error!(scope = "voice", "{error}"),
    }
    deps
}

/// After a setup: the helper reloads its models now, after the call, or
/// is not running (index.ts's reload, retried every 15 s after a call).
fn reload_after_setup(helper: VoiceHelper) -> roamgate_voice_server::setup::Reload {
    use roamgate_voice_server::helper::Reload;
    Arc::new(move || {
        let reload = helper.reload_models();
        if reload == Reload::AfterCall {
            let helper = helper.clone();
            tokio::spawn(async move {
                loop {
                    tokio::time::sleep(std::time::Duration::from_secs(15)).await;
                    if helper.reload_models() != Reload::AfterCall {
                        break;
                    }
                }
            });
        }
        reload.as_str()
    })
}

/// The people the helper knows again across calls, one file each in
/// `<data>/voice-profiles` (index.ts: `voiceHelper.speakers.useLibrary(new
/// VoiceProfiles(voiceProfilesDir()))`).
fn remember_speakers(
    helper: &VoiceHelper,
    data: &std::path::Path,
    clock: roamgate_base::clock::SharedClock,
    log: roamgate_base::log::Logger,
) {
    let mut library = roamgate_voice_server::profiles::VoiceProfiles::with_clock(
        roamgate_voice_server::profiles::voice_profiles_dir(data),
        Arc::new(move || clock.now() as f64),
    );
    library.set_logger(log);
    helper.speakers().use_library(Some(library));
}

/// The errands' sessions, reached through Bun's own code for them.
struct ReverseErrands {
    cx: FamilyContext,
}

impl ErrandDeps for ReverseErrands {
    fn read(
        &self,
        connection_id: &str,
        pane_id: &str,
    ) -> FutureBox<'static, Result<Vec<Value>, String>> {
        let cx = self.cx.clone();
        let args = json!({"connection_id": connection_id, "pane_id": pane_id});
        async move {
            let entries = cx
                .reverse("voice.errand_read", args)
                .await
                .map_err(|error| error.message)?;
            Ok(entries.as_array().cloned().unwrap_or_default())
        }
        .boxed()
    }

    fn prompt(
        &self,
        connection_id: &str,
        pane_id: &str,
        text: &str,
    ) -> FutureBox<'static, Result<(), String>> {
        let cx = self.cx.clone();
        let args = json!({"connection_id": connection_id, "pane_id": pane_id, "text": text});
        async move {
            cx.reverse("voice.errand_prompt", args)
                .await
                .map(|_| ())
                .map_err(|error| error.message)
        }
        .boxed()
    }

    fn status(
        &self,
        connection_id: &str,
        pane_id: &str,
    ) -> FutureBox<'static, Result<Option<ErrandSessionStatus>, String>> {
        let cx = self.cx.clone();
        let args = json!({"connection_id": connection_id, "pane_id": pane_id});
        async move {
            let status = cx
                .reverse("voice.errand_status", args)
                .await
                .map_err(|error| error.message)?;
            if status.is_null() {
                return Ok(None);
            }
            Ok(Some(ErrandSessionStatus {
                status: status["status"].as_str().map(str::to_owned),
                waiting: status["waiting"].as_str().map(str::to_owned),
                queued: status["queued"].as_u64().unwrap_or(0) as u32,
            }))
        }
        .boxed()
    }

    fn has_status(&self) -> bool {
        true
    }

    fn keep(&self, _answer: KeptAnswer) {}
}

/// The Work board as Bun's companion has it (Bun's, or the core's work
/// family while it owns it), by reverse call; its states read once a
/// minute at most.
struct ReverseBoard {
    cx: FamilyContext,
    states: Arc<Mutex<Vec<String>>>,
}

impl VoiceWorkBoard for ReverseBoard {
    fn tool(&self, name: &str, params: Value) -> FutureBox<'static, Result<String, String>> {
        let cx = self.cx.clone();
        let args = json!({"tool": name, "params": params});
        async move {
            let answer = cx
                .reverse("voice.work_tool", args)
                .await
                .map_err(|error| error.message)?;
            Ok(answer["text"].as_str().unwrap_or_default().to_owned())
        }
        .boxed()
    }

    fn states(&self) -> Vec<String> {
        // Refreshed behind: the state line is a hint, never worth a wait.
        let cx = self.cx.clone();
        let states = self.states.clone();
        tokio::spawn(async move {
            if let Ok(Value::Array(list)) = cx.reverse("voice.work_states", json!({})).await {
                *states.lock().unwrap() = list
                    .iter()
                    .filter_map(Value::as_str)
                    .map(str::to_owned)
                    .collect();
            }
        });
        self.states.lock().unwrap().clone()
    }
}

/// The voice server the family serves.
struct VoiceServer {
    helper: VoiceHelper,
    routes: VoiceRoutes,
    companion: CompanionRoutes,
    setup: SetupRoute,
    low_gpu: VoiceLowGpu,
    handoff: CallHandoffRedeem,
    /// The login the handoff being redeemed gives, minted by the front
    /// for it; one handoff at a time.
    cookie: Arc<Mutex<Option<String>>>,
    handing_off: tokio::sync::Mutex<()>,
    tools: ConfiguredTools,
    research: Arc<ConfiguredResearch>,
    memory: CompanionMemory,
    waiting: Arc<WaitingAnswers>,
    taste: VoiceTaste,
    watch: Mutex<Option<LowGpuWatch>>,
    /// The browser sockets the Rust front gives the core.
    sockets: Arc<VoiceSockets>,
}

impl VoiceServer {
    fn new(cx: &FamilyContext) -> Self {
        let clock = cx.clock.clone();
        let data = DataContext::from_env(&ProcessEnv).data_root();
        let runtime = cli_runtime(Arc::new(ProcessEnv));
        let app_data = runtime.app_data.as_deref();
        let config_path = voice_config_path(&data);
        let read: ReadConfig = {
            let path = config_path.clone();
            Arc::new(move || read_voice_config(&path))
        };
        // Bun's voice code writes these lines to stderr as they are
        // (console.error), and its timings through the server's logger.
        let errors: roamgate_voice_server::helper::ErrorSink = Arc::new(|line| eprintln!("{line}"));
        let log = super::limit_resume::scoped_logger(cx, "bridge.voice");
        // The companion's own lines (YouTube, taste, memory), on children
        // of the server's logger as Bun's modules take them.
        roamgate_voice_server::set_server_logger(super::limit_resume::scoped_logger(cx, "bridge"));
        let spawn = {
            let (data, errors) = (data.clone(), errors.clone());
            Arc::new(move |config: &VoiceConfig| spawn_voice_helper(config, &data, errors.clone()))
        };
        let (rate_path, pause_path) = (config_path.clone(), config_path.clone());
        let helper = VoiceHelper::with(read.clone(), spawn, clock.clone(), log.clone())
            .with_savers(
                Arc::new(move |rate| write_speech_rate(rate, &rate_path)),
                Arc::new(move |ms| write_max_pause(ms, &pause_path)),
            )
            .with_stored({
                let path = config_path.clone();
                Arc::new(move || roamgate_voice_server::config::stored_voice_settings(&path))
            })
            .with_errors(errors.clone());
        remember_speakers(&helper, &data, clock.clone(), log.clone());
        let models_dir = default_models_dir(&runtime.home, &runtime.platform, app_data);
        let low_gpu = VoiceLowGpu::new(LowGpuDeps {
            game_mode: Some(Arc::new(|| {
                Box::pin(async {
                    let runner = roamgate_exec::process::ProcessRunner::system();
                    roamgate_exec::gamemode::game_mode_active(
                        &runner,
                        roamgate_exec::gamemode::default_game_mode_command(),
                        roamgate_exec::gamemode::GAME_MODE_TIMEOUT,
                    )
                    .await
                })
            })),
            clock: clock.clone(),
            errors: errors.clone(),
            ..LowGpuDeps::new(
                low_gpu_path(&runtime.home, &runtime.platform, app_data),
                read.clone(),
                models_dir,
                Arc::new(helper.clone()),
            )
        });
        let command = resolve_command();
        let files = CompanionMemoryFiles::new(companion_memories_dir(&data));
        let research = Arc::new(ConfiguredResearch::spawning(read.clone(), command.clone()));
        let taste = VoiceTaste::with(taste_path(&data), Some(files.dir.clone()), clock.clone());
        let board_states: Arc<Mutex<Vec<String>>> = Arc::default();
        let board: Arc<dyn VoiceWorkBoard> = Arc::new(ReverseBoard {
            cx: cx.clone(),
            states: board_states,
        });
        let tools = ConfiguredTools::spawning(
            read.clone(),
            command.clone(),
            ToolsSetup {
                youtube: Some(YoutubeSource::helper(Arc::new(helper.clone()))),
                taste: Some(taste.clone()),
                work: Some(Arc::new(move || board.clone())),
                clock: Some(clock.clone()),
                errors: Some(errors.clone()),
                ..ToolsSetup::default()
            },
        );
        let jobs = {
            let (research, tools, clock) = (research.clone(), tools.clone(), clock.clone());
            Arc::new(move || {
                roamgate_voice_server::http::companion::with_searches(
                    "",
                    research.get().as_ref(),
                    tools.get().as_ref(),
                    clock.now() as f64,
                )
            })
        };
        let memory = CompanionMemory::new(MemoryOptions {
            files: Some(files.clone()),
            jobs: Some(jobs),
            clock: clock.clone(),
            ..MemoryOptions::new(
                companion_memory_path(&data),
                front_compaction(
                    read.clone(),
                    command.clone(),
                    spawn_compaction(Some(files.clone())),
                    COMPACT_TIMEOUT_MS,
                    clock.clone(),
                ),
            )
        });
        let front = {
            let memory = memory.clone();
            Arc::new(ConfiguredFront::new(
                spawn_front(),
                command.clone(),
                Some(Arc::new(move || Ok(memory.block()))),
                Some(files.clone()),
                answers_dir(&data),
            ))
        };
        let router = Arc::new(ConfiguredRouter::spawning(command.clone()));
        let waiting = Arc::new(WaitingAnswers::new(
            Some(waiting_answers_file(&data)),
            clock.clone(),
        ));
        let causes = Arc::new(TurnCauses::new(clock.clone()));
        *CAUSES.lock().unwrap() = Arc::downgrade(&causes);
        let errands = {
            let waiting = waiting.clone();
            VoiceErrands::new(
                Arc::new(KeepingErrands {
                    deps: ReverseErrands { cx: cx.clone() },
                    waiting,
                }),
                causes.clone(),
                ErrandTiming::default(),
                clock.clone(),
            )
        };
        let socket = Arc::new(VoiceSocket::new(
            Arc::new(helper.clone()),
            VoiceSocketOptions {
                companion: Arc::new(VoiceCompanion::spawning(
                    read.clone(),
                    command.clone(),
                    Some(files.clone()),
                )),
                max_pause: {
                    let read = read.clone();
                    Arc::new(move || read().ok()?.get("max_pause_ms").cloned())
                },
                background: {
                    let (read, tools) = (read.clone(), tools.clone());
                    Arc::new(move || {
                        // Read as a call starts: the music taste refreshes then.
                        if let Some(tools) = tools.get() {
                            tools.refresh_taste();
                        }
                        Some(read().ok()?.call_background())
                    })
                },
                ice_address: {
                    let read = read.clone();
                    Arc::new(move || read().ok()?.str("call_ice_address").map(str::to_owned))
                },
                on_call_ended: {
                    let memory = memory.clone();
                    Arc::new(move || memory.call_ended())
                },
                log: log.clone(),
                errors: errors.clone(),
                // ROAMGATE_VOICE_DEBUG: the call's steps, as Bun traces them.
                debug: Some(Arc::new(|line| {
                    if std::env::var_os("ROAMGATE_VOICE_DEBUG").is_some_and(|v| !v.is_empty()) {
                        eprintln!("{line}");
                    }
                })),
                ..VoiceSocketOptions::new(clock.clone())
            },
        ));
        let current_call: roamgate_voice_server::http::routes::CurrentCall = {
            let socket = socket.clone();
            Arc::new(move || socket.current_call())
        };
        let light: Arc<dyn Fn() -> Option<String> + Send + Sync> = {
            let (helper, low_gpu) = (helper.clone(), low_gpu.clone());
            Arc::new(move || {
                let low_gpu = low_gpu.clone();
                light_voice(&helper, &move || low_gpu.reason())
            })
        };
        let companion = {
            let (read, front, router) = (read.clone(), front.clone(), router.clone());
            let (research, tools) = (research.clone(), tools.clone());
            CompanionRoutes::new(CompanionOptions {
                front: Arc::new({
                    let read = read.clone();
                    move || {
                        let config = read();
                        front
                            .get(config.as_ref().map_err(String::as_str))
                            .map(|f| Arc::new(f) as Arc<dyn Front>)
                    }
                }),
                router: {
                    let read = read.clone();
                    Arc::new(move || {
                        let config = read();
                        router
                            .get(config.as_ref().map_err(String::as_str))
                            .map(|r| Arc::new(r) as Arc<dyn Router>)
                    })
                },
                errands: Some(Arc::new(errands.clone()) as Arc<dyn Errands>),
                errand_folder: {
                    let read = read.clone();
                    Arc::new(move || read().ok()?.str("errand_folder").map(str::to_owned))
                },
                research: Arc::new(move || research.get()),
                tools: Arc::new(move || tools.get()),
                current_call: current_call.clone(),
                memory: Some(Arc::new(memory.clone())),
                memory_files: Some(files.clone()),
                waiting: Some(waiting.clone()),
                speakers: Some(Arc::new(helper.clone())),
                light_voice: light,
                causes,
                answers_dir: answers_dir(&data),
                errors: errors.clone(),
                log: log.clone(),
                clock: clock.clone(),
                ..CompanionOptions::default()
            })
        };
        let library: Arc<dyn Voices> = {
            let (clone, applied) = (helper.clone(), helper.clone());
            Arc::new(VoiceLibrary::new(LibraryOptions {
                read_config: Some(read.clone()),
                config_path: config_path.clone(),
                default_voices_dir: default_voices_dir(&runtime.home, &runtime.platform, app_data),
                clone: Arc::new(move |request| {
                    let helper = clone.clone();
                    Box::pin(async move { helper.clone_voice(request.to_map()).await })
                }),
                applied: Some(Arc::new(move || {
                    let helper = applied.clone();
                    Box::pin(async move {
                        let _ = helper.apply_tts_models().await;
                    })
                })),
                now: {
                    let clock = clock.clone();
                    Arc::new(move || clock.now() as f64)
                },
            }))
        };
        let routes = {
            let (status, low_gpu) = (companion.clone(), low_gpu.clone());
            let mode_path = config_path.clone();
            let read = read.clone();
            VoiceRoutes::new(
                Arc::new(helper.clone()),
                RoutesOptions {
                    library: Some(library),
                    companion: Arc::new(move || status.status()),
                    mode: Arc::new(move || read().ok()?.front_mode()),
                    save_mode: Arc::new(move |mode| {
                        roamgate_voice_server::config::write_front_mode(mode, &mode_path)
                    }),
                    current_call,
                    low_gpu: Arc::new(move || low_gpu.reason()),
                    log: log.clone(),
                    errors: errors.clone(),
                    ..RoutesOptions::default()
                },
            )
        };
        let setup = SetupRoute::new(VoiceSetupRunner::new(
            setup_deps(&runtime, clock.clone()),
            Some(reload_after_setup(helper.clone())),
        ));
        let sockets = VoiceSockets::new((*socket).clone(), errands, clock.clone());
        let cookie: Arc<Mutex<Option<String>>> = Arc::default();
        let handoff = {
            let (socket, cookie) = (socket.clone(), cookie.clone());
            CallHandoffRedeem::new(
                Arc::new(move |token: &Value| {
                    socket.redeem_handoff(token).map(|r| (r.call, r.carrier))
                }),
                // Minted by the front's auth for this request (see `answer`).
                Arc::new(move || cookie.lock().unwrap().take()),
                clock,
            )
        };
        Self {
            helper,
            routes,
            companion,
            setup,
            low_gpu,
            handoff,
            cookie,
            handing_off: tokio::sync::Mutex::new(()),
            tools,
            research,
            memory,
            waiting,
            taste,
            watch: Mutex::new(None),
            sockets,
        }
    }

    async fn answer(&self, cx: &FamilyContext, request: &Request, client_ip: &str) -> Answer {
        if request.path == "/api/voice/call/handoff" {
            let _one = self.handing_off.lock().await;
            if request.method == "POST" {
                // A login for the device the call is handed to: the front's.
                let cookie = cx
                    .reverse("voice.session_cookie", json!({}))
                    .await
                    .ok()
                    .and_then(|value| value["cookie"].as_str().map(str::to_owned));
                *self.cookie.lock().unwrap() = cookie;
            }
            let answer = self.handoff.handle(request, client_ip);
            self.cookie.lock().unwrap().take();
            return answer;
        }
        if let Some(answer) = self.setup.handle(request) {
            return answer;
        }
        if let Some(answer) = low_gpu_route(&self.low_gpu, request).await {
            return answer;
        }
        if let Some(answer) = self.companion.handle(request).await {
            return answer;
        }
        match self.routes.handle(request).await {
            Some(answer) => answer,
            None => Answer::text(404, "not found"),
        }
    }

    fn start(&self) {
        *self.watch.lock().unwrap() = Some(self.low_gpu.watch(LOW_GPU_WATCH_MS));
    }

    fn stop(&self) {
        self.sockets.close_all();
        self.watch.lock().unwrap().take();
        self.helper.stop();
        self.tools.tools().stop();
        if let Some(research) = self.research.get() {
            research.stop();
        }
        let _ = self.memory.flush();
        let _ = self.waiting.flush();
        let _ = self.taste.flush();
    }
}

/// The errands' deps, their answers kept as they settle.
struct KeepingErrands {
    deps: ReverseErrands,
    waiting: Arc<WaitingAnswers>,
}

impl ErrandDeps for KeepingErrands {
    fn read(
        &self,
        connection_id: &str,
        pane_id: &str,
    ) -> FutureBox<'static, Result<Vec<Value>, String>> {
        self.deps.read(connection_id, pane_id)
    }

    fn prompt(
        &self,
        connection_id: &str,
        pane_id: &str,
        text: &str,
    ) -> FutureBox<'static, Result<(), String>> {
        self.deps.prompt(connection_id, pane_id, text)
    }

    fn status(
        &self,
        connection_id: &str,
        pane_id: &str,
    ) -> FutureBox<'static, Result<Option<ErrandSessionStatus>, String>> {
        self.deps.status(connection_id, pane_id)
    }

    fn has_status(&self) -> bool {
        true
    }

    fn keep(&self, answer: KeptAnswer) {
        self.waiting.keep(NewAnswer {
            job: answer.job,
            pane: answer.pane,
            label: answer.label,
            question: answer.question,
            answer: answer.answer,
            at: None,
        });
    }
}

struct VoiceFamily {
    server: OnceLock<Arc<VoiceServer>>,
    /// Bun's voice released (`voice.release`) since the core took the
    /// family: everything that may start the helper waits for it.
    ready: Mutex<Option<Shared<BoxFuture<()>>>>,
    /// Counts the takes and releases: a late release's end starts nothing
    /// once the family moved again.
    turn: Arc<AtomicU64>,
}

impl VoiceFamily {
    fn server(&self, cx: &FamilyContext) -> Arc<VoiceServer> {
        self.server
            .get_or_init(|| Arc::new(VoiceServer::new(cx)))
            .clone()
    }

    /// Settles once Bun's helper, watches and companion stopped for the
    /// core's (at once while the core never took the family): one helper,
    /// never two.
    pub fn ready(&self) -> Shared<BoxFuture<()>> {
        let ready = self.ready.lock().unwrap().clone();
        ready.unwrap_or_else(|| {
            let done: BoxFuture<()> = Box::pin(async {});
            done.shared()
        })
    }
}

/// A channel request as the voice routes take it, its body read whole (up
/// to [`MAX_BODY`]).
async fn voice_request(request: &HttpRequest, body: Option<BodyReceiver>) -> Request {
    let (path, query) = request.url.split_once('?').unwrap_or((&request.url, ""));
    let body = match body {
        None => Body::Missing,
        Some(body) => {
            let bytes = body.read_all().await;
            if bytes.len() > MAX_BODY {
                Body::TooLarge
            } else {
                Body::Bytes(bytes)
            }
        }
    };
    Request {
        method: request.method.to_ascii_uppercase(),
        path: path.to_owned(),
        query: query.to_owned(),
        headers: request.headers.clone(),
        body,
    }
}

/// An answer as the channel sends it.
fn response(answer: Answer) -> HttpResponse {
    let mut headers = answer.headers;
    let has = |headers: &[(String, String)], name: &str| {
        headers
            .iter()
            .any(|(key, _)| key.eq_ignore_ascii_case(name))
    };
    let (tx, rx) = tokio::sync::mpsc::channel(16);
    let body = match answer.body {
        AnswerBody::Json(value) => {
            if !has(&headers, "content-type") {
                headers.push((
                    "content-type".into(),
                    "application/json;charset=utf-8".into(),
                ));
            }
            Some(serde_json::to_vec(&value).unwrap_or_default())
        }
        AnswerBody::Text(text) => {
            if !has(&headers, "content-type") {
                headers.push(("content-type".into(), "text/plain;charset=utf-8".into()));
            }
            Some(text.as_bytes().to_vec())
        }
        AnswerBody::Bytes(bytes) => Some(bytes),
        AnswerBody::Empty => None,
        AnswerBody::Stream(stream) => {
            if let Some(mut chunks) = stream.take() {
                tokio::spawn(async move {
                    while let Some(chunk) = chunks.recv().await {
                        if tx.send(chunk).await.is_err() {
                            break;
                        }
                    }
                });
            }
            return HttpResponse {
                status: answer.status,
                headers,
                body: Some(rx),
            };
        }
    };
    let Some(bytes) = body else {
        return HttpResponse {
            status: answer.status,
            headers,
            body: None,
        };
    };
    let _ = tx.try_send(bytes);
    HttpResponse {
        status: answer.status,
        headers,
        body: Some(rx),
    }
}

impl CoreFamily for VoiceFamily {
    fn name(&self) -> &'static str {
        "voice"
    }

    fn http(
        &self,
        cx: &FamilyContext,
        request: HttpRequest,
        body: Option<BodyReceiver>,
    ) -> BoxFuture<Result<HttpResponse, RpcError>> {
        let server = self.server(cx);
        let ready = self.ready();
        let cx = cx.clone();
        Box::pin(async move {
            ready.await;
            roamgate_sidecar::core::note_served(
                &ProcessEnv,
                "voice",
                &format!("http {}", path_of(&request.url)),
            );
            let client_ip = request.ctx.client_ip.clone().unwrap_or_default();
            let voice = voice_request(&request, body).await;
            Ok(response(server.answer(&cx, &voice, &client_ip).await))
        })
    }

    fn call(&self, cx: &FamilyContext, call: IncomingCall) -> BoxFuture<Result<Value, RpcError>> {
        if call.method == "internal.voice.release" {
            // Bun takes voice back: the core's helper and watches stop
            // before Bun may start its own.
            self.ready.lock().unwrap().take();
            self.turn.fetch_add(1, Ordering::SeqCst);
            if let Some(server) = self.server.get() {
                server.stop();
            }
            return Box::pin(async { Ok(json!({})) });
        }
        let _ = cx;
        Box::pin(async move {
            Err(RpcError::with_code(
                format!("unknown method {}", call.method),
                "unknown_method",
            ))
        })
    }

    fn ws_open(
        &self,
        cx: &FamilyContext,
        link: &roamgate_sidecar::peer::Peer,
        open: roamgate_sidecar::peer::WsOpen,
    ) -> BoxFuture<Result<Value, RpcError>> {
        let server = self.server(cx);
        let link = link.clone();
        // Bun's helper released first, as for the routes.
        let ready = self.ready();
        Box::pin(async move {
            ready.await;
            Ok(server.sockets.open(&link, &open))
        })
    }

    fn ws_socket(
        &self,
        cx: &FamilyContext,
        _link: &roamgate_sidecar::peer::Peer,
        message: roamgate_sidecar::protocol::Message,
    ) {
        self.server(cx).sockets.message(message);
    }

    fn owned(&self, cx: &FamilyContext, owned: bool) {
        let server = self.server(cx);
        if owned {
            // Bun's helper, watches and companion stop first, as the
            // assistant family's service does.
            let (cx, started) = (cx.clone(), server.clone());
            let turn = self.turn.clone();
            let this_turn = turn.fetch_add(1, Ordering::SeqCst) + 1;
            let release: BoxFuture<()> = Box::pin(async move {
                if let Err(error) = cx.reverse("voice.release", json!({})).await {
                    tracing::warn!("Bun did not release voice: {}", error.message);
                }
                if turn.load(Ordering::SeqCst) == this_turn {
                    started.start();
                }
            });
            let release = release.shared();
            tokio::spawn(release.clone());
            *self.ready.lock().unwrap() = Some(release);
        } else {
            self.ready.lock().unwrap().take();
            self.turn.fetch_add(1, Ordering::SeqCst);
            server.stop();
        }
    }
}

/// The family.
/// The voice companion's turn causes, while the family runs here: what
/// a standalone core notes for Ranger (`assistant.host` `note_turn_cause`).
static CAUSES: std::sync::Mutex<std::sync::Weak<TurnCauses>> =
    std::sync::Mutex::new(std::sync::Weak::new());

/// voice/turn-causes.ts `note` with a cause as Ranger sends it
/// (`{by: "ranger"}`, `{by: "agent", name}`, ...).
pub(crate) fn note_turn_cause(connection_id: &str, pane_id: &str, cause: &Value) {
    use roamgate_voice_server::companion::turn_causes::{TurnCause, UserVia};
    let cause = match cause.get("by").and_then(Value::as_str) {
        Some("ranger") => TurnCause::Ranger,
        Some("companion") => TurnCause::Companion,
        Some("agent") => TurnCause::Agent(
            cause
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_owned(),
        ),
        Some("user") => TurnCause::User(match cause.get("via").and_then(Value::as_str) {
            Some("chat") => UserVia::Chat,
            Some("review") => UserVia::Review,
            _ => UserVia::Terminal,
        }),
        _ => return,
    };
    if let Some(causes) = CAUSES.lock().unwrap().upgrade() {
        causes.note(connection_id, pane_id, cause);
    }
}

/// voice/turn-causes.ts `noteUser`: the user did something in the
/// session (a key typed, for one).
pub(crate) fn note_user_turn(connection_id: &str, pane_id: &str) {
    if let Some(causes) = CAUSES.lock().unwrap().upgrade() {
        causes.note_user(connection_id, pane_id);
    }
}

pub fn family() -> Option<Arc<dyn CoreFamily>> {
    Some(Arc::new(VoiceFamily {
        server: OnceLock::new(),
        ready: Mutex::new(None),
        turn: Arc::default(),
    }))
}

/// `roamgate voice ...`; returns the exit code.
pub fn cli(args: &[String]) -> u8 {
    roamgate_sidecar::core::note_served(&ProcessEnv, "voice", "cli voice");
    let runtime = cli_runtime(Arc::new(ProcessEnv));
    emit(roamgate_cli::voice::voice(&runtime, args))
}

/// `roamgate setup voice ...` (`args` from `voice`); returns the exit
/// code. Its output is written as it goes: a download shows its progress.
pub async fn setup_cli(args: &[String]) -> u8 {
    roamgate_sidecar::core::note_served(&ProcessEnv, "voice", "cli setup voice");
    let runtime = cli_runtime(Arc::new(ProcessEnv));
    let deps = roamgate_cli::setup_voice::SetupCommandDeps::system();
    let mut out = roamgate_cli::archive::ProcessOutput;
    let code = roamgate_cli::setup_voice::setup(&runtime, &deps, args, &mut out).await;
    u8::try_from(code).unwrap_or(1)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_helper_knows_the_speakers_of_the_voice_profiles() {
        let data = tempfile::tempdir().unwrap();
        let dir = roamgate_voice_server::profiles::voice_profiles_dir(data.path());
        // A person named on an earlier call, kept in its file.
        let mut earlier = roamgate_voice_server::profiles::VoiceProfiles::new(&dir);
        let id = earlier.create(
            Some("Ada"),
            roamgate_voice_server::profiles::VoiceRole::Family,
        );
        earlier.learn(&id, 1.0, vec![0.5; 256], 12.0);
        let helper = VoiceHelper::new(
            Arc::new(|| Err("no voice.json".into())),
            Arc::new(|_| Err("no helper".into())),
        );
        let clock: roamgate_base::clock::SharedClock = Arc::new(roamgate_base::clock::SystemClock);
        remember_speakers(
            &helper,
            data.path(),
            clock,
            roamgate_base::log::Logger::silent(),
        );
        let mut speakers = helper.speakers();
        let library = speakers.library().expect("a library");
        assert_eq!(library.dir, dir);
        let known = library.get(&id).expect("the person named before");
        assert_eq!(known.name.as_deref(), Some("Ada"));
        // What it learns is written there.
        let new = library.create(
            Some("Bo"),
            roamgate_voice_server::profiles::VoiceRole::Other,
        );
        library.learn(&new, 2.0, vec![0.25; 256], 8.0);
        assert!(dir.join(format!("{new}.json")).exists());
    }

    async fn body_of(response: HttpResponse) -> Vec<u8> {
        let mut all = Vec::new();
        if let Some(mut body) = response.body {
            while let Some(chunk) = body.recv().await {
                all.extend(chunk);
            }
        }
        all
    }

    #[tokio::test]
    async fn answers_cross_the_channel_as_the_front_sends_them() {
        let json = response(Answer::json(200, json!({"to": "current"})));
        assert_eq!(json.status, 200);
        assert_eq!(
            json.headers,
            vec![(
                "content-type".to_owned(),
                "application/json;charset=utf-8".to_owned()
            )]
        );
        assert_eq!(body_of(json).await, br#"{"to":"current"}"#);
        let empty = response(Answer::empty(204));
        assert!(empty.body.is_none());
        // A streamed route goes chunk by chunk, until its end.
        let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
        tx.send(b"{\"early\":{}}\n".to_vec()).unwrap();
        tx.send(b"{\"to\":\"self\"}\n".to_vec()).unwrap();
        drop(tx);
        let streamed = response(Answer {
            status: 200,
            headers: vec![("content-type".into(), "application/x-ndjson".into())],
            body: AnswerBody::Stream(roamgate_voice_server::http::StreamBody::new(rx)),
        });
        assert_eq!(
            body_of(streamed).await,
            b"{\"early\":{}}\n{\"to\":\"self\"}\n"
        );
    }

    #[tokio::test]
    async fn requests_keep_their_path_query_and_headers() {
        let request = HttpRequest {
            method: "get".into(),
            url: "/api/voice/errand?job=a".into(),
            headers: vec![("x-roamgate-voice".into(), "1".into())],
            ctx: Default::default(),
        };
        let voice = voice_request(&request, None).await;
        assert_eq!(voice.method, "GET");
        assert_eq!(voice.path, "/api/voice/errand");
        assert_eq!(voice.query_param("job").as_deref(), Some("a"));
        assert!(voice.has_voice_header());
        assert_eq!(voice.body, Body::Missing);
    }
}
