//! The part of a connection generation's composition root that lives with
//! its events (runtime.ts `createLegacyConnectionRuntime`): the terminal
//! bridge, the task events (Roamgate's status tracker, or Herdr's semantic
//! notifications on a passive endpoint shell), and the tab auto-renamer.
//! Built at `host.runtime_start`, fed by `host.events`, stopped at
//! `host.runtime_stop`.

use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use roamgate_base::env::{ProcessEnv, roamgate_env};
use roamgate_base::log::{Logger, RecoveryReporter};
use roamgate_connections::agent_tab_title::{AgentTabTitleOptions, AgentTabTitleReader, RunOutput};
use roamgate_connections::manager::sanitize_connection_error;
use roamgate_connections::routing::serialize_herdr_event_envelope;
use roamgate_connections::tab_auto_rename::{TabAutoRenamer, TabAutoRenamerOptions, TabHerdr};
use roamgate_herdr::control::{BeforeSend, HerdrClient};
use roamgate_herdr::endpoint::creation::{EmptyWorkspaceCreator, assert_creation_source};
use roamgate_http::terminal::bridge::{BridgeOptions, TerminalBridge, TerminalSink};
use roamgate_notify::listener::{HerdrNotificationListener, ListenerOptions};
use roamgate_notify::task_events::{TaskEventTracker, TaskNotificationSource};
use roamgate_sidecar::family::FamilyContext;
use serde_json::{Map, Value, json};

use super::{Layer, fields, logger};

/// Keys typed in a terminal note the user's input at most this often.
const TYPED_NOTE_MS: i64 = 10_000;
/// How many terminals' last typing is remembered.
const TYPED_KEPT: usize = 200;

/// What a generation keeps of its composition.
pub(crate) struct Composition {
    pub bridge: TerminalBridge,
    pub renamer: TabAutoRenamer,
    tasks: Arc<Tasks>,
}

/// The generation's Herdr client, while the generation is the current one
/// (Bun's `RemoteHerdrClient` called the host family by id and generation).
#[derive(Clone)]
struct GenerationHerdr {
    layer: Arc<Layer>,
    id: String,
    generation: u64,
}

impl GenerationHerdr {
    fn client(&self) -> Result<HerdrClient, String> {
        let runtime = self
            .layer
            .host
            .manager_now()
            .and_then(|manager| manager.current_runtime(&self.id).ok().flatten())
            .filter(|runtime| runtime.generation() == self.generation)
            .ok_or_else(|| "connection runtime is disposed".to_owned())?;
        Ok(runtime.herdr().clone())
    }

    async fn call(
        &self,
        method: &str,
        params: Value,
        timeout_ms: u64,
        fresh: bool,
    ) -> Result<Value, String> {
        self.client()?
            .call(method, params, timeout_ms, None, fresh)
            .await
    }

    async fn protocol(&self) -> Result<i64, String> {
        let ping = self.client()?.ping().await?;
        let protocol = ping.get("protocol").cloned().unwrap_or(Value::Null);
        roamgate_herdr::protocol::assert_supported_herdr_protocol(&protocol)?;
        Ok(protocol.as_i64().unwrap_or_default())
    }

    /// The pane showing a terminal, from Herdr's pane list.
    async fn pane_of(&self, terminal_id: &str) -> Option<String> {
        let result = self.call("pane.list", json!({}), 5000, false).await.ok()?;
        result
            .get("panes")?
            .as_array()?
            .iter()
            .filter(|pane| pane.is_object())
            .find(|pane| pane.get("terminal_id").and_then(Value::as_str) == Some(terminal_id))
            .and_then(|pane| pane.get("pane_id").and_then(Value::as_str))
            .filter(|pane| !pane.is_empty())
            .map(str::to_owned)
    }
}

impl TabHerdr for GenerationHerdr {
    fn call(
        &self,
        method: &str,
        params: Value,
        timeout_ms: u64,
        before_send: Option<BeforeSend>,
    ) -> roamgate_connections::BoxFuture<Result<Value, String>> {
        let this = self.clone();
        let method = method.to_owned();
        Box::pin(async move {
            this.client()?
                .call(&method, params, timeout_ms, before_send, false)
                .await
        })
    }
}

/// The browsers of the server, as the bridge sends to them.
struct Sink(Arc<Layer>);

impl TerminalSink for Sink {
    fn send(&self, socket: u64, payload: String, context: &str, key: Option<&str>) {
        self.0.clients.send(socket, payload, context, key);
    }
    fn broadcast(&self, payload: &str, context: &str) {
        self.0.clients.broadcast(payload, context, None);
    }
    fn drop_coalesced(&self, socket: u64, key: &str) {
        self.0.clients.drop_coalesced(socket, key);
    }
    fn client_label(&self, socket: u64) -> String {
        self.0
            .clients
            .get(socket)
            .map(|info| info.label)
            .unwrap_or_else(|| "unknown".into())
    }
}

/// Task events of one generation (runtime.ts `taskEvents`,
/// `herdrNotifications`, `relayTaskEvent`).
struct Tasks {
    layer: Arc<Layer>,
    cx: FamilyContext,
    herdr: GenerationHerdr,
    identity_label: String,
    logger: Logger,
    source: TaskNotificationSource,
    tracker: Mutex<TaskEventTracker>,
    /// The newest event of each pane waiting for its labels.
    pending: Mutex<HashMap<String, u64>>,
    next_event: Mutex<u64>,
    /// Herdr lacks endpoint support (< 0.9 or endpoints disabled); a 0.9
    /// server disconnected for a while does not fall back.
    unavailable: AtomicBool,
    disposed: AtomicBool,
    listener: Mutex<Option<HerdrNotificationListener>>,
}

impl Tasks {
    fn current(&self) -> bool {
        self.layer
            .runtimes
            .generation(&self.herdr.id)
            .is_some_and(|generation| generation == self.herdr.generation)
    }

    /// index.ts `onTaskEvent`: the feed and Web Push get it.
    fn publish(self: &Arc<Self>, event: &Value) {
        let mut task = event.as_object().cloned().unwrap_or_default();
        task.insert("connectionId".into(), json!(self.herdr.id));
        let profiles = self.layer.host.profiles();
        if profiles.len() > 1 {
            let label = profiles
                .iter()
                .find(|profile| profile.get("id").and_then(Value::as_str) == Some(&self.herdr.id))
                .and_then(|profile| profile.get("label").and_then(Value::as_str))
                .unwrap_or(&self.identity_label);
            task.insert("connectionLabel".into(), json!(label));
        }
        task.insert("runtimeGeneration".into(), json!(self.herdr.generation));
        let this = self.clone();
        super::work::publish_notification(
            &self.cx,
            Value::Object(task),
            json!({}),
            Some(Arc::new(move || this.current())),
        );
    }

    /// Published, and told to every page (which then leaves its own
    /// tracker off).
    fn relay(self: &Arc<Self>, event: &Value) {
        self.publish(event);
        if !self.current() {
            return;
        }
        let text = |key: &str| event.get(key).and_then(Value::as_str);
        let kind = text("kind").unwrap_or("completed");
        let body = match text("body") {
            Some(body) => json!(body),
            None => {
                let labels: Vec<&str> = [text("workspaceLabel"), text("tabLabel")]
                    .into_iter()
                    .flatten()
                    .map(roamgate_base::settings::js_trim)
                    .filter(|label| !label.is_empty())
                    .collect();
                if labels.is_empty() {
                    Value::Null
                } else {
                    json!(labels.join(" \u{b7} "))
                }
            }
        };
        let notification = json!({
            "event": "roamgate.task_notification",
            "data": {
                "type": "roamgate.task_notification",
                "kind": kind,
                "agent": event.get("agent").cloned().unwrap_or(Value::Null),
                "title": text("title").unwrap_or(if kind == "blocked" {
                    "Agent needs input"
                } else {
                    "Task completed"
                }),
                "body": body,
                "workspace_id": event.get("workspaceId").cloned().unwrap_or(Value::Null),
                "tab_id": event.get("tabId").cloned().unwrap_or(Value::Null),
                "pane_id": event.get("paneId").cloned().unwrap_or(Value::Null),
            },
        });
        if let Ok(line) = serialize_herdr_event_envelope(
            &self.herdr.id,
            &notification,
            Some(self.herdr.generation),
        ) {
            self.layer.clients.broadcast(&line, "event", None);
        }
    }

    /// A status event (completed or blocked): labelled on demand, so a
    /// push works without a browser and after renames.
    fn status_event(self: &Arc<Self>, event: Value) {
        let publishes = match self.source {
            TaskNotificationSource::Status => true,
            TaskNotificationSource::Herdr => self.unavailable.load(Ordering::SeqCst),
        };
        let Some(pane) = event
            .get("paneId")
            .and_then(Value::as_str)
            .map(str::to_owned)
        else {
            return;
        };
        if !publishes || self.disposed.load(Ordering::SeqCst) || pane.is_empty() {
            return;
        }
        let number = {
            let mut next = self.next_event.lock().unwrap();
            *next += 1;
            *next
        };
        self.pending.lock().unwrap().insert(pane.clone(), number);
        let this = self.clone();
        tokio::spawn(async move {
            let workspace = event.get("workspaceId").cloned().unwrap_or(Value::Null);
            let (workspace_result, tab_result) = tokio::join!(
                this.herdr.call(
                    "workspace.get",
                    json!({"workspace_id": workspace}),
                    5000,
                    false
                ),
                this.herdr
                    .call("tab.list", json!({"workspace_id": workspace}), 5000, false),
            );
            // An older lookup must not publish over a newer notification.
            {
                let mut pending = this.pending.lock().unwrap();
                if this.disposed.load(Ordering::SeqCst) || pending.get(&pane) != Some(&number) {
                    return;
                }
                pending.remove(&pane);
            }
            let mut labeled = event.as_object().cloned().unwrap_or_default();
            if let Some(label) = workspace_result
                .ok()
                .and_then(|result| result["workspace"]["label"].as_str().map(str::to_owned))
            {
                labeled.insert("workspaceLabel".into(), json!(label));
            }
            let tab = tab_result.ok().and_then(|result| {
                result["tabs"].as_array()?.iter().find_map(|tab| {
                    (tab.get("tab_id") == event.get("tabId")
                        && tab.get("workspace_id") == event.get("workspaceId"))
                    .then(|| tab.get("label").and_then(Value::as_str).map(str::to_owned))
                    .flatten()
                })
            });
            if let Some(label) = tab {
                labeled.insert("tabLabel".into(), json!(label));
            }
            let labeled = Value::Object(labeled);
            match this.source {
                TaskNotificationSource::Status => this.publish(&labeled),
                TaskNotificationSource::Herdr if this.unavailable.load(Ordering::SeqCst) => {
                    this.relay(&labeled)
                }
                TaskNotificationSource::Herdr => {}
            }
        });
    }

    fn events(self: &Arc<Self>, events: Vec<Value>) {
        for event in events {
            self.status_event(event);
        }
    }

    /// The passive endpoint shell of `herdr` notifications.
    fn listen(self: &Arc<Self>, client_socket_path: String) {
        let recovery = Arc::new(Mutex::new(RecoveryReporter::new(
            self.logger.child("notifications"),
            "Herdr notification shell failed",
            "Herdr notification shell recovered",
            {
                let clock = self.cx.clock.clone();
                Arc::new(move || clock.now())
            },
        )));
        let disable = roamgate_env(&ProcessEnv, "DISABLE_ENDPOINT").as_deref() == Some("1");
        let connection = json!({"connection": self.herdr.id});
        let this = self.clone();
        let mut options = ListenerOptions::new(
            client_socket_path,
            Arc::new(move |notification| {
                if this.disposed.load(Ordering::SeqCst) {
                    return;
                }
                let event = roamgate_notify::listener::task_event(notification);
                this.logger.debug(
                    "Herdr notification",
                    Some(&fields(json!({
                        "connection": this.herdr.id,
                        "kind": notification.kind,
                        "forwarded": event.is_some(),
                    }))),
                );
                if let Some(event) = event {
                    this.relay(&event);
                }
            }),
            self.cx.clock.clone(),
        );
        // The same gate as endpoint terminal sessions.
        let herdr = self.herdr.clone();
        options.is_available = Some(Arc::new(move || {
            let herdr = herdr.clone();
            Box::pin(async move {
                if disable {
                    return Ok(false);
                }
                let ping = herdr.client()?.ping().await?;
                Ok(ping
                    .get("protocol")
                    .and_then(Value::as_i64)
                    .is_some_and(roamgate_herdr::thin::is_terminal_hello_protocol))
            })
        }));
        let this = self.clone();
        let logged = connection.clone();
        options.on_unavailable = Some(Arc::new(move || {
            if !this.unavailable.swap(true, Ordering::SeqCst) {
                this.logger.info(
                    "Herdr notifications need Herdr >= 0.9; using agent status",
                    Some(&fields(logged.clone())),
                );
            }
        }));
        let this = self.clone();
        let reporter = recovery.clone();
        let logged = connection.clone();
        options.on_connected = Some(Arc::new(move || {
            this.unavailable.store(false, Ordering::SeqCst);
            if !reporter
                .lock()
                .unwrap()
                .recovered(Some(&fields(logged.clone())))
            {
                this.logger.info(
                    "listening for Herdr notifications",
                    Some(&fields(logged.clone())),
                );
            }
        }));
        let reporter = recovery;
        options.on_error = Some(Arc::new(move |error| {
            reporter.lock().unwrap().failure(
                &sanitize_connection_error(error),
                Some(&fields(connection.clone())),
            );
        }));
        let listener = HerdrNotificationListener::new(options);
        listener.start();
        *self.listener.lock().unwrap() = Some(listener);
    }

    fn stop(&self) {
        self.disposed.store(true, Ordering::SeqCst);
        self.tracker.lock().unwrap().stop();
        self.pending.lock().unwrap().clear();
        if let Some(listener) = self.listener.lock().unwrap().take() {
            listener.stop();
        }
    }
}

impl Composition {
    /// Builds and starts a generation's composition (`startBackground`'s
    /// part of it: the renamer and the notification shell start).
    pub(crate) fn start(
        layer: &Arc<Layer>,
        cx: &FamilyContext,
        id: &str,
        generation: u64,
        identity_label: &str,
        config: &Value,
    ) -> Arc<Self> {
        let herdr = GenerationHerdr {
            layer: layer.clone(),
            id: id.to_owned(),
            generation,
        };
        let connection_logger = logger(&cx.clock, "bridge").child("connection");
        let client_socket_path = config
            .get("clientSocketPath")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned();
        let ssh_host = config
            .get("sshHost")
            .and_then(Value::as_str)
            .map(str::to_owned);
        let remote_platform = config
            .get("remotePlatform")
            .and_then(Value::as_str)
            .map(str::to_owned);
        let bridge = terminal_bridge(
            layer,
            cx,
            &herdr,
            id,
            generation,
            client_socket_path.clone(),
            connection_logger.child("terminal"),
        );
        let source = match layer
            .config
            .lock()
            .unwrap()
            .task_notification_source
            .as_str()
        {
            "herdr" => TaskNotificationSource::Herdr,
            _ => TaskNotificationSource::Status,
        };
        let tasks = Arc::new(Tasks {
            layer: layer.clone(),
            cx: cx.clone(),
            herdr: herdr.clone(),
            identity_label: identity_label.to_owned(),
            logger: connection_logger.clone(),
            source,
            tracker: Mutex::new(TaskEventTracker::new()),
            pending: Mutex::default(),
            next_event: Mutex::new(0),
            unavailable: AtomicBool::new(false),
            disposed: AtomicBool::new(false),
            listener: Mutex::default(),
        });
        let renamer = tab_renamer(
            layer,
            cx,
            &herdr,
            id,
            ssh_host,
            remote_platform,
            connection_logger,
        );
        // A node renames no tab and publishes no task notification: the
        // home does both for this machine, over its SSH connection.
        let node = roamgate_base::node::active();
        if node {
            tasks.disposed.store(true, Ordering::SeqCst);
        } else {
            renamer.start();
            if source == TaskNotificationSource::Herdr {
                tasks.listen(client_socket_path);
            }
        }
        Arc::new(Self {
            bridge,
            renamer,
            tasks,
        })
    }

    /// One Herdr event, after conversation mode's (runtime.ts
    /// `onHerdrEvent`).
    pub(crate) fn herdr_event(&self, event: &Value) {
        let events = self.tasks.tracker.lock().unwrap().handle_herdr_event(event);
        self.tasks.events(events);
        if !roamgate_base::node::active() {
            self.renamer.handle_herdr_event(event);
        }
        if event.get("event").and_then(Value::as_str) == Some("workspace.focused") {
            self.bridge.refresh_popup_observer_focus();
        }
    }

    /// An agent status listing starts: the revision it reconciles at.
    pub(crate) fn pane_list_start(&self) -> u64 {
        self.tasks.tracker.lock().unwrap().begin_pane_list()
    }

    pub(crate) fn pane_list(&self, result: &Value, revision: u64) {
        let events = self
            .tasks
            .tracker
            .lock()
            .unwrap()
            .reconcile_pane_list(result, revision);
        self.tasks.events(events);
    }

    /// The generation goes (runtime.ts `stop`'s part of it).
    pub(crate) fn stop(&self) {
        self.renamer.dispose();
        self.tasks.stop();
        self.bridge.dispose();
    }
}

fn terminal_bridge(
    layer: &Arc<Layer>,
    cx: &FamilyContext,
    herdr: &GenerationHerdr,
    id: &str,
    generation: u64,
    client_socket_path: String,
    logger: Logger,
) -> TerminalBridge {
    let protocol = herdr.clone();
    let lookup = herdr.clone();
    let refusal_herdr = herdr.clone();
    let refusal_layer = layer.clone();
    let refusal_id = id.to_owned();
    let focused = herdr.clone();
    let codecs_cx = cx.clone();
    let codecs_id = id.to_owned();
    let wake = herdr.clone();
    let source_herdr = herdr.clone();
    let creation_herdr = herdr.clone();
    let relay_herdr = herdr.clone();
    let relay_clock = cx.clock.clone();
    TerminalBridge::new(BridgeOptions {
        connection_id: id.to_owned(),
        generation,
        logger,
        clock: cx.clock.clone(),
        client_socket_path,
        herdr_protocol: Arc::new(move || {
            let herdr = protocol.clone();
            Box::pin(async move { herdr.protocol().await })
        }),
        lookup_pane_id: Some(Arc::new(move |terminal| {
            let herdr = lookup.clone();
            Box::pin(async move { herdr.pane_of(&terminal).await })
        })),
        // While a handover runs, keys typed in a browser's terminal would
        // land in the exiting TUI or the bare shell.
        input_refusal: Some(Arc::new(move |terminal| {
            let (layer, herdr, id) = (
                refusal_layer.clone(),
                refusal_herdr.clone(),
                refusal_id.clone(),
            );
            Box::pin(async move {
                if layer.mirror(&id)["handing_over"] != Value::Bool(true) {
                    return None;
                }
                let pane = herdr.pane_of(&terminal).await?;
                layer.mirror(&id)["refusals"][&pane]
                    .as_str()
                    .map(str::to_owned)
            })
        })),
        on_input: Some(typed_notes(herdr.clone(), cx.clock.clone())),
        focused_workspace_id: Some(Arc::new(move || {
            let herdr = focused.clone();
            Box::pin(async move {
                let result = herdr
                    .call("workspace.list", json!({}), 5000, false)
                    .await
                    .ok()?;
                result["workspaces"]
                    .as_array()?
                    .iter()
                    .find(|workspace| workspace["focused"] == Value::Bool(true))
                    .and_then(|workspace| workspace["workspace_id"].as_str())
                    .map(str::to_owned)
            })
        })),
        surface_codecs_enabled: Some(Arc::new(move || {
            let (cx, id) = (codecs_cx.clone(), codecs_id.clone());
            Box::pin(async move {
                super::super::settings::read_shared(&cx)
                    .await
                    .terminal_surface_codecs_enabled(Some(&id))
            })
        })),
        // Any request Herdr's main loop handles wakes it; a fresh tab list
        // is a cheap one, and keeps the reused one current.
        wake_herdr: Some(Arc::new(move || {
            let herdr = wake.clone();
            tokio::spawn(async move {
                let _ = herdr.call("tab.list", json!({}), 2000, true).await;
            });
        })),
        validate_creation_source: Some(Arc::new(move |source| {
            let herdr = source_herdr.clone();
            Box::pin(async move {
                let result = herdr
                    .call("pane.get", json!({"pane_id": source.pane_id}), 5000, true)
                    .await?;
                assert_creation_source(&source, &result["pane"])
            })
        })),
        // Creation checks Herdr's current state, never a reused answer.
        create_empty_workspace: Some(EmptyWorkspaceCreator::new(Arc::new(
            move |method, params, timeout| {
                let herdr = creation_herdr.clone();
                Box::pin(async move { herdr.call(&method, params, timeout, true).await })
            },
        ))),
        sink: Arc::new(Sink(layer.clone())),
        confirm_relay_resize: Some(Arc::new(move |cols, rows, pane| {
            let (herdr, clock) = (relay_herdr.clone(), relay_clock.clone());
            Box::pin(async move {
                let Some(pane) = pane else {
                    return false;
                };
                for _ in 0..6 {
                    let Ok(result) = herdr
                        .call(
                            "pane.layout",
                            json!({"pane_id": pane}),
                            roamgate_herdr::control::DEFAULT_CALL_TIMEOUT_MS,
                            false,
                        )
                        .await
                    else {
                        return false;
                    };
                    let area = &result["layout"]["area"];
                    let number = |key: &str| area[key].as_f64().unwrap_or(f64::NAN);
                    if area.is_object()
                        && number("x") + number("width") == cols as f64
                        && number("y") + number("height") == rows as f64
                    {
                        return true;
                    }
                    clock.sleep(Duration::from_millis(50)).await;
                }
                false
            })
        })),
        disable_endpoint: roamgate_env(&ProcessEnv, "DISABLE_ENDPOINT").as_deref() == Some("1"),
        format_error: Arc::new(sanitize_connection_error),
    })
}

/// When the user last typed in each terminal, for the voice companion's
/// events: an Enter is noted at once, other keys at most every 10 s.
fn typed_notes(
    herdr: GenerationHerdr,
    clock: roamgate_base::clock::SharedClock,
) -> roamgate_http::terminal::bridge::OnInput {
    let typed: Arc<Mutex<VecDeque<(String, i64)>>> = Arc::default();
    Arc::new(move |terminal: &str, input: &[u8]| {
        let submitted = input.contains(&0x0d);
        let now = clock.now();
        {
            let mut typed = typed.lock().unwrap();
            let last = typed
                .iter()
                .find(|(each, _)| each == terminal)
                .map(|(_, at)| *at);
            if !submitted && last.is_some_and(|last| now - last < TYPED_NOTE_MS) {
                return;
            }
            typed.retain(|(each, _)| each != terminal);
            typed.push_back((terminal.to_owned(), now));
            if typed.len() > TYPED_KEPT {
                typed.pop_front();
            }
        }
        let herdr = herdr.clone();
        let terminal = terminal.to_owned();
        tokio::spawn(async move {
            let Some(pane) = herdr.pane_of(&terminal).await else {
                return;
            };
            if submitted {
                super::super::voice::note_turn_cause(
                    &herdr.id,
                    &pane,
                    &json!({"by": "user", "via": "terminal"}),
                );
            } else {
                super::super::voice::note_user_turn(&herdr.id, &pane);
            }
        });
    })
}

fn tab_renamer(
    layer: &Arc<Layer>,
    cx: &FamilyContext,
    herdr: &GenerationHerdr,
    id: &str,
    ssh_host: Option<String>,
    remote_platform: Option<String>,
    logger: Logger,
) -> TabAutoRenamer {
    let title_herdr = herdr.clone();
    let summary_cx = cx.clone();
    let summary_id = id.to_owned();
    let run_layer = layer.clone();
    let argv_layer = layer.clone();
    let reader = AgentTabTitleReader::new(AgentTabTitleOptions {
        herdr_call: Arc::new(move |method, params| {
            let herdr = title_herdr.clone();
            Box::pin(async move { herdr.call(&method, params, 5000, false).await })
        }),
        read_summary: Arc::new(move |params| {
            let (cx, id) = (summary_cx.clone(), summary_id.clone());
            Box::pin(async move {
                let (readers, _) = super::super::agent_sessions::owned_readers(&cx, &id)
                    .await
                    .map_err(|error| error.message)?;
                readers
                    .read_summary(&params)
                    .await
                    .map_err(|error| error.message)
            })
        }),
        ssh_host,
        remote_platform,
        run: Arc::new(move |argv, timeout_ms| {
            let layer = run_layer.clone();
            Box::pin(async move {
                let command = roamgate_exec::process::Command::new(argv)
                    .timeout(Duration::from_millis(timeout_ms));
                let output = layer
                    .host
                    .ops()
                    .runner
                    .run(&command)
                    .await
                    .map_err(|error| error.to_string())?;
                Ok(RunOutput {
                    code: output.code,
                    stderr: output.stderr_text(),
                    stdout: output.stdout,
                })
            })
        }),
        ssh_argv: Arc::new(move |host, command| {
            argv_layer
                .host
                .ops()
                .sessions
                .read_command_argv(host, command, &[], Some("agent.tab_title"))
                .map(|built| built.argv)
                .unwrap_or_default()
        }),
        env: roamgate_agents::files::AgentEnv::from_process(),
    });
    let enabled_cx = cx.clone();
    let id = id.to_owned();
    TabAutoRenamer::new(TabAutoRenamerOptions {
        herdr: Arc::new(herdr.clone()),
        title_for_pane: Arc::new(move |pane_id, _pane| {
            let reader = reader.clone();
            Box::pin(async move { reader.read(&pane_id).await.ok().flatten() })
        }),
        enabled: Some(Arc::new(move || {
            let cx = enabled_cx.clone();
            Box::pin(async move {
                super::super::settings::read_shared(&cx)
                    .await
                    .get("auto_rename_agent_tabs")
                    != Some(&Value::Bool(false))
            })
        })),
        debounce: None,
        poll_interval: Some(Duration::from_millis(30_000)),
        log: Some(Arc::new(move |message| {
            logger.debug(message, Some(&fields(json!({"connection": id}))));
        })),
    })
}

/// `{...}` of a JSON object, for the creation params a browser sends.
pub(crate) fn object(value: &Value) -> Map<String, Value> {
    value.as_object().cloned().unwrap_or_default()
}
