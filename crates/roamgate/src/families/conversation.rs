//! The conversation family in the core: roamgate-conversation's service,
//! one per connection generation, with Claude's drivers from
//! roamgate-claude, mapped onto the channel (contract/wire/core-channel.md,
//! The conversation family).
//!
//! - Browser calls: `agent_chat.*` (the socket's own subscriptions).
//! - The front's own calls (`internal.conversation.<op>`, each with its
//!   `connection_id`): `attach` (the service made, its mirror back),
//!   `holder_hold`, `holder_fg`, `holder_output`, `holder_handback` (the
//!   agent socket's roamgate-hold requests), `prompt`, `send`,
//!   `switch_session`, `restart_process`, `restart_terminal`,
//!   `auto_start`, `pane_closed`, `sweep`, `socket_closed`.
//! - Reverse calls: `herdr.call` (the connection's Herdr), and
//!   `conversation.host {op, connection_id, ...}` for what the front keeps:
//!   `connection`, `ask` (the prompt card), `ssh_argv`, `idle_stop_minutes`,
//!   `keep_awake`, `models_offered`, `choose_model`, `register_launch`,
//!   `tell` (the lease changed, an owned agent reported) and `mirror` (what
//!   the front's synchronous readers see of the service).
//! - Pushes: `agent_chat.*` events to the sockets watching a pane.
//!
//! The services run (leases, suspended jobs, holders) only while the core
//! owns the family; giving it back disposes them (their state saved on the
//! leases) and tells the front, which reads the files afresh.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use roamgate_agents::files::SessionFiles;
use roamgate_agents::handlers::AgentSessionHandlers;
use roamgate_base::env::ProcessEnv;
use roamgate_base::paths::DataContext;
use roamgate_channel::family::{CoreFamily, FamilyContext};
use roamgate_channel::peer::{BoxFuture, IncomingCall};
use roamgate_channel::protocol::{Push, RpcError};
use roamgate_connections::agent_profiles::shared::latest_session_model;
use roamgate_connections::agent_profiles::store::{SessionProfiles, command_for_session};
use roamgate_conversation::driver::{BoxFuture as ConvFuture, Drivers, Transcript};
use roamgate_conversation::handover::SuspendedSpec;
use roamgate_conversation::herdr::{
    AgentReport, ConversationHerdr, HerdrCalls, HerdrConversation, HerdrResult, PaneProcessInfo,
    WriterElsewhere, local_pid_alive,
};
use roamgate_conversation::holder_script::{LocalHolder, holder_command};
use roamgate_conversation::images::ImageReader;
use roamgate_conversation::lease::{
    LeaseOptions, LeaseStore, default_lease_file, flush_lease_files, forget_lease_files,
};
use roamgate_conversation::rpc::{handle_agent_chat_rpc, is_agent_chat_method};
use roamgate_conversation::service::{
    ConversationService, HolderSideInput, ModelsDeps, ServiceOptions, parse_holder_shell_value,
    parse_holder_status_value,
};
use roamgate_conversation::session::ConversationPrompt;
use roamgate_conversation::shared::{AgentCommand, Obj};
use roamgate_conversation::shell::{ProcessShellRunner, remote_shell_command};
use serde_json::{Map, Value, json};
use tokio::sync::{mpsc, oneshot};

use super::agent_sessions::{session_files, session_readers};

pub const FAMILY: &str = "conversation";

pub fn family() -> Option<Arc<dyn CoreFamily>> {
    Some(Arc::new(ConversationFamily::default()))
}

#[derive(Default)]
struct ConversationFamily {
    shared: Arc<Shared>,
}

#[derive(Default)]
struct Shared {
    owned: Mutex<bool>,
    connections: tokio::sync::Mutex<HashMap<String, Arc<Connection>>>,
}

/// One connection generation's service.
struct Connection {
    generation: Option<u64>,
    service: ConversationService,
    teller: Teller,
}

impl Drop for Connection {
    fn drop(&mut self) {
        self.service.dispose();
    }
}

fn not_owner() -> RpcError {
    RpcError::with_code("the conversation family is not served here", "not_owner")
}

fn data() -> DataContext {
    DataContext::from_env(&ProcessEnv)
}

fn home() -> PathBuf {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_default()
}

fn str_of<'a>(params: &'a Value, key: &str) -> &'a str {
    params.get(key).and_then(Value::as_str).unwrap_or("")
}

fn sh_quote(text: &str) -> String {
    if !text.is_empty()
        && text
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "@%+=:,./-_".contains(c))
    {
        return text.to_owned();
    }
    format!("'{}'", text.replace('\'', "'\\''"))
}

/// What the front is told, in order: one task per connection sends them.
#[derive(Clone)]
struct Teller {
    sender: mpsc::UnboundedSender<Tell>,
}

enum Tell {
    Op(Value),
    Mirror,
    Flush(oneshot::Sender<()>),
}

impl Teller {
    fn new(
        cx: FamilyContext,
        connection_id: String,
        service: Arc<Mutex<Option<ConversationService>>>,
    ) -> Self {
        let (sender, mut receiver) = mpsc::unbounded_channel::<Tell>();
        tokio::spawn(async move {
            while let Some(tell) = receiver.recv().await {
                match tell {
                    Tell::Op(mut args) => {
                        args["connection_id"] = json!(connection_id);
                        let _ = cx.reverse("conversation.host", args).await;
                    }
                    Tell::Mirror => {
                        // Coalesced: what is queued behind is told once.
                        let mut flushes = Vec::new();
                        let mut ops = Vec::new();
                        while let Ok(next) = receiver.try_recv() {
                            match next {
                                Tell::Mirror => {}
                                Tell::Flush(done) => flushes.push(done),
                                Tell::Op(op) => ops.push(op),
                            }
                        }
                        let current = service.lock().unwrap().clone();
                        if let Some(service) = current {
                            let _ = cx
                                .reverse(
                                    "conversation.host",
                                    json!({
                                        "op": "mirror",
                                        "connection_id": connection_id,
                                        "mirror": mirror_of(&service),
                                    }),
                                )
                                .await;
                        }
                        for mut op in ops {
                            op["connection_id"] = json!(connection_id);
                            let _ = cx.reverse("conversation.host", op).await;
                        }
                        for done in flushes {
                            let _ = done.send(());
                        }
                    }
                    Tell::Flush(done) => {
                        let _ = done.send(());
                    }
                }
            }
        });
        Self { sender }
    }

    fn op(&self, args: Value) {
        let _ = self.sender.send(Tell::Op(args));
    }

    fn mirror(&self) {
        let _ = self.sender.send(Tell::Mirror);
    }

    async fn flush(&self) {
        let (done, wait) = oneshot::channel();
        if self.sender.send(Tell::Flush(done)).is_ok() {
            let _ = wait.await;
        }
    }
}

/// What the front's synchronous readers see of a service: its leases, the
/// panes it owns, the stopped jobs, each pane's status and model, and
/// where input is refused.
fn mirror_of(service: &ConversationService) -> Value {
    let owned = service.owned_panes();
    let mut leases = Map::new();
    let mut status = Map::new();
    let mut models = Map::new();
    let mut refusals = Map::new();
    for pane in &owned {
        let id = pane.get("pane_id").and_then(Value::as_str).unwrap_or("");
        if let Some(lease) = service.lease(id) {
            leases.insert(id.into(), Value::Object(lease));
        }
        let state = service.state(id);
        status.insert(
            id.into(),
            state.get("status").cloned().unwrap_or(Value::Null),
        );
        if let Some(model) = service.model(id) {
            models.insert(id.into(), json!(model));
        }
        if let Some(refusal) = service.input_refusal(id) {
            refusals.insert(id.into(), json!(refusal));
        }
    }
    json!({
        "leases": leases,
        "owned_panes": owned,
        "suspended": service.suspended_panes(),
        "status": status,
        "models": models,
        "refusals": refusals,
        "handing_over": service.handing_over(),
    })
}

/// Herdr and the host of a connection, through the front.
struct ReverseCalls {
    cx: FamilyContext,
    connection_id: String,
    ssh: Option<Arc<SshArgv>>,
}

/// The front's SSH argv for a connection's host, with the command where
/// `PLACEHOLDER` stands.
struct SshArgv {
    template: Vec<String>,
}

const PLACEHOLDER: &str = "__roamgate_conversation_command__";

impl SshArgv {
    fn argv(&self, command: &str) -> Vec<String> {
        self.template
            .iter()
            .map(|word| word.replace(PLACEHOLDER, command))
            .collect()
    }
}

async fn run_argv(argv: Vec<String>, timeout: Duration) -> Result<(i32, Vec<u8>), String> {
    let (program, args) = argv.split_first().ok_or("empty command")?;
    let mut command = tokio::process::Command::new(program);
    command
        .args(args)
        .stdin(std::process::Stdio::null())
        .kill_on_drop(true);
    match tokio::time::timeout(timeout, command.output()).await {
        Ok(Ok(output)) => Ok((output.status.code().unwrap_or(-1), output.stdout)),
        Ok(Err(error)) => Err(error.to_string()),
        Err(_) => Err("timed out".into()),
    }
}

impl HerdrCalls for ReverseCalls {
    fn call<'a>(
        &'a self,
        method: &'a str,
        params: Value,
        timeout_ms: u64,
    ) -> ConvFuture<'a, HerdrResult<Value>> {
        Box::pin(async move {
            self.cx
                .reverse(
                    "herdr.call",
                    json!({
                        "connection_id": self.connection_id,
                        "method": method,
                        "params": params,
                        "timeout_ms": timeout_ms,
                    }),
                )
                .await
                .map_err(|error| error.message)
        })
    }

    fn pid_alive(&self, pid: u32) -> ConvFuture<'_, bool> {
        Box::pin(async move {
            match &self.ssh {
                None => local_pid_alive(pid),
                Some(ssh) => {
                    // Unsure (no answer from the host) counts as alive.
                    let argv = ssh.argv(&format!("ps -p {pid} >/dev/null"));
                    !matches!(run_argv(argv, Duration::from_secs(10)).await, Ok((1, _)))
                }
            }
        })
    }

    fn list_processes(&self) -> ConvFuture<'_, HerdrResult<String>> {
        Box::pin(async move {
            let argv = match &self.ssh {
                None => vec!["ps".into(), "-eo".into(), "pid=,args=".into()],
                Some(ssh) => ssh.argv("ps -eo pid=,args="),
            };
            match run_argv(argv, Duration::from_secs(10)).await {
                Ok((0, stdout)) => Ok(String::from_utf8_lossy(&stdout).into_owned()),
                Ok((code, _)) => Err(format!(
                    "Could not list the host's processes (ps exited {code})"
                )),
                Err(error) => Err(format!("Could not list the host's processes ({error})")),
            }
        })
    }
}

/// The real Herdr side, telling the front after each report of an owned
/// agent (`withStatusReports`).
struct ReportingHerdr {
    inner: HerdrConversation,
    teller: Teller,
}

impl ConversationHerdr for ReportingHerdr {
    fn agent_get<'a>(&'a self, pane_id: &'a str) -> ConvFuture<'a, HerdrResult<Option<Obj>>> {
        self.inner.agent_get(pane_id)
    }
    fn read_detection<'a>(&'a self, pane_id: &'a str) -> ConvFuture<'a, HerdrResult<String>> {
        self.inner.read_detection(pane_id)
    }
    fn process_info<'a>(
        &'a self,
        pane_id: &'a str,
    ) -> ConvFuture<'a, HerdrResult<PaneProcessInfo>> {
        self.inner.process_info(pane_id)
    }
    fn prompt<'a>(&'a self, pane_id: &'a str, text: &'a str) -> ConvFuture<'a, HerdrResult<()>> {
        self.inner.prompt(pane_id, text)
    }
    fn send_text<'a>(&'a self, pane_id: &'a str, text: &'a str) -> ConvFuture<'a, HerdrResult<()>> {
        self.inner.send_text(pane_id, text)
    }
    fn send_keys<'a>(&'a self, pane_id: &'a str, keys: &'a str) -> ConvFuture<'a, HerdrResult<()>> {
        self.inner.send_keys(pane_id, keys)
    }
    fn report_agent(&self, report: AgentReport) -> ConvFuture<'_, HerdrResult<()>> {
        Box::pin(async move {
            let pane = report.pane_id.clone();
            let result = self.inner.report_agent(report).await;
            self.teller.mirror();
            self.teller
                .op(json!({"op": "tell", "what": "owned_status", "pane_id": pane}));
            result
        })
    }
    fn release_agent<'a>(
        &'a self,
        pane_id: &'a str,
        agent: Option<&'a str>,
    ) -> ConvFuture<'a, HerdrResult<()>> {
        self.inner.release_agent(pane_id, agent)
    }
    fn pid_alive(&self, pid: u32) -> ConvFuture<'_, bool> {
        self.inner.pid_alive(pid)
    }
    fn headless_running<'a>(
        &'a self,
        session_ids: &'a [String],
    ) -> ConvFuture<'a, HerdrResult<bool>> {
        self.inner.headless_running(session_ids)
    }
    fn pane_exists<'a>(&'a self, pane_id: &'a str) -> ConvFuture<'a, HerdrResult<bool>> {
        self.inner.pane_exists(pane_id)
    }
    fn writer_elsewhere<'a>(
        &'a self,
        pane_id: &'a str,
        session_ids: &'a [String],
        except_pids: &'a [u32],
    ) -> ConvFuture<'a, HerdrResult<Option<WriterElsewhere>>> {
        self.inner
            .writer_elsewhere(pane_id, session_ids, except_pids)
    }
}

/// The settings, read afresh (a non-owner's read, writing nothing).
fn read_settings() -> Option<Value> {
    let data = data();
    let path = roamgate_base::settings::settings_path(&ProcessEnv, &data).ok()?;
    let text = std::fs::read_to_string(path).ok()?;
    serde_json::from_str(&text).ok()
}

fn session_profiles() -> SessionProfiles {
    SessionProfiles::at_data_root(data(), None, None)
}

fn command_for(session_id: &str) -> Result<AgentCommand, String> {
    let settings = read_settings();
    let store = session_profiles();
    let command = command_for_session(Some(session_id), settings.as_ref(), Some(&store), &home())?;
    Ok(AgentCommand {
        profile: command.profile,
        agent: command.agent,
        program: command.program,
        env: command.env.into_iter().collect(),
        unset: command.unset,
        plain: command.plain,
        model: command.model,
    })
}

async fn read_tail(
    readers: &AgentSessionHandlers,
    files: &dyn SessionFiles,
    pane_id: &str,
) -> Option<String> {
    let path = readers
        .resolve_path(&json!({"pane_id": pane_id}))
        .await
        .ok()??;
    let bytes = files.read_tail(&path, 64 * 1024).await.ok()?;
    Some(String::from_utf8_lossy(&bytes).into_owned())
}

async fn build_connection(
    cx: &FamilyContext,
    connection_id: Option<&str>,
) -> Result<(String, Arc<Connection>), RpcError> {
    let mut args = json!({"op": "connection"});
    if let Some(id) = connection_id {
        args["connection_id"] = json!(id);
    }
    let info = cx.reverse("conversation.host", args).await?;
    let id = str_of(&info, "connection_id").to_owned();
    let ssh = info["ssh"].as_bool().unwrap_or(false);
    let ssh_argv = if ssh {
        let argv = cx
            .reverse(
                "conversation.host",
                json!({"op": "ssh_argv", "connection_id": id, "command": PLACEHOLDER, "tag": "agent_chat"}),
            )
            .await?;
        let template: Vec<String> = argv
            .as_array()
            .map(|words| {
                words
                    .iter()
                    .filter_map(|word| word.as_str().map(str::to_owned))
                    .collect()
            })
            .unwrap_or_default();
        Some(Arc::new(SshArgv { template }))
    } else {
        None
    };
    let generation = info["generation"].as_u64();
    let slot: Arc<Mutex<Option<ConversationService>>> = Arc::new(Mutex::new(None));
    let teller = Teller::new(cx.clone(), id.clone(), slot.clone());
    let drivers: Drivers = Drivers::new(vec![
        roamgate_claude::conversation::claude_driver(),
        roamgate_agy::agy_driver(),
    ]);
    let calls = Arc::new(ReverseCalls {
        cx: cx.clone(),
        connection_id: id.clone(),
        ssh: ssh_argv.clone(),
    });
    let herdr = Arc::new(ReportingHerdr {
        inner: HerdrConversation::new(calls, drivers.clone(), cx.clock.now()),
        teller: teller.clone(),
    });
    let data = data();
    let lease_file = default_lease_file(&data);
    let leases = LeaseStore::new(LeaseOptions {
        connection_id: id.clone(),
        file: Some(lease_file.clone()),
        clock: cx.clock.clone(),
        data: Some(data.clone()),
    });
    let files = session_files(cx, &id, ssh);
    let readers = session_readers(cx, &id, files.clone());
    let push_cx = cx.clone();
    let push_id = id.clone();
    let ask_cx = cx.clone();
    let ask_id = id.clone();
    let ask_slot = slot.clone();
    let ask_drivers = drivers.clone();
    let local = info
        .get("local_holder")
        .filter(|local| !local.is_null())
        .map(|local| LocalHolder {
            bin: str_of(local, "bin").to_owned(),
            socket: str_of(local, "socket").to_owned(),
        });
    let read_ssh = ssh_argv.clone();
    let mut options = ServiceOptions::new(
        &id,
        herdr,
        leases,
        drivers,
        cx.clock.clone(),
        Arc::new(move |pane: String, prompt: ConversationPrompt| {
            let cx = ask_cx.clone();
            let connection_id = ask_id.clone();
            let agent_name = ask_slot
                .lock()
                .unwrap()
                .as_ref()
                .and_then(|svc| svc.lease(&pane))
                .and_then(|lease| {
                    lease
                        .get("agent")
                        .and_then(Value::as_str)
                        .map(str::to_owned)
                });
            let display_name = ask_drivers
                .of(agent_name.as_deref())
                .protocol
                .display_name()
                .to_owned();
            Box::pin(async move {
                let mut args = json!({
                    "op": "ask",
                    "connection_id": connection_id,
                    "pane_id": pane,
                    "agent": display_name,
                    "tool": prompt.tool,
                    "input": prompt.input,
                    "can_always": prompt.can_always,
                    "timeout_ms": prompt.timeout_ms,
                });
                if let Some(questions) = prompt.questions {
                    args["questions"] = Value::Array(questions);
                }
                let signal = prompt.signal.clone();
                tokio::select! {
                    answer = cx.reverse("conversation.host", args) => {
                        answer.map(|answer| (!answer.is_null()).then_some(answer)).map_err(|error| error.message)
                    }
                    () = signal.cancelled() => Ok(None),
                }
            })
        }),
        Arc::new(move |path: String| {
            let reader = ImageReader {
                remote: read_ssh.clone().map(|ssh| {
                    Arc::new(move |command: String| {
                        let argv = ssh.argv(&command);
                        Box::pin(async move { run_argv(argv, Duration::from_secs(30)).await })
                            as ConvFuture<'static, Result<(i32, Vec<u8>), String>>
                    }) as roamgate_conversation::images::RemoteRun
                }),
                sh_quote: Arc::new(sh_quote),
            };
            Box::pin(async move { reader.read(&path).await })
        }),
        Arc::new(move |socket: u64, envelope: Obj| {
            push_cx.push(Push {
                message: Value::Object(envelope),
                key: None,
                connection_id: Some(push_id.clone()),
                connection_generation: generation,
                socket_id: Some(socket),
                session_id: None,
            });
        }),
        Arc::new(move |session_id: &str| {
            holder_command(session_id, local.as_ref()).unwrap_or_default()
        }),
    );
    options.data = Some(data.clone());
    options.suspended_file = lease_file
        .parent()
        .map(|dir| dir.join("conversation-suspended.json"));
    options.run_shell = Some(Arc::new(match ssh_argv.clone() {
        None => ProcessShellRunner::local(),
        Some(ssh) => ProcessShellRunner {
            argv: Arc::new(move |cwd: &str, command: &str| {
                ssh.argv(&remote_shell_command(cwd, command, &sh_quote))
            }),
            hold: None,
        },
    }));
    {
        let readers = readers.clone();
        options.read_transcript = Some(Arc::new(move |pane: String| {
            let readers = readers.clone();
            Box::pin(async move {
                match readers.read_records(&json!({"pane_id": pane})).await {
                    Ok(Some(records)) => Ok(Some(Transcript::Records(records))),
                    Ok(None) => Ok(None),
                    Err(error) => Err(error.message),
                }
            })
        }));
    }
    {
        let readers = readers.clone();
        let files = files.clone();
        options.transcript_stat = Some(Arc::new(move |pane: String| {
            let readers = readers.clone();
            let files = files.clone();
            Box::pin(async move {
                let path = readers
                    .resolve_path(&json!({"pane_id": pane}))
                    .await
                    .ok()??;
                let stat = files.stat_file(&path).await.ok()??;
                Some(stat.mtime_ms)
            })
        }));
    }
    {
        let readers = readers.clone();
        options.terminal_tasks = Some(Arc::new(move |pane: String, agent: String| {
            let readers = readers.clone();
            Box::pin(async move {
                let read = readers
                    .read_tasks(&json!({"pane_id": pane, "agent": agent}))
                    .await
                    .map_err(|error| error.message)?;
                Ok(read
                    .get("tasks")
                    .and_then(Value::as_array)
                    .map(|tasks| {
                        tasks
                            .iter()
                            .filter(|task| {
                                task.get("status").and_then(Value::as_str) == Some("running")
                                    && matches!(
                                        task.get("kind").and_then(Value::as_str),
                                        Some("command" | "monitor")
                                    )
                            })
                            .count()
                    })
                    .unwrap_or(0))
            })
        }));
    }
    {
        let readers = readers.clone();
        let files = files.clone();
        options.exit_swallowed = Some(Arc::new(
            move |pane: String, command: String, since: i64| {
                let readers = readers.clone();
                let files = files.clone();
                Box::pin(async move {
                    Ok(match read_tail(&readers, &*files, &pane).await {
                        Some(tail) => roamgate_conversation::handover::exit_sent_as_message(
                            &tail, &command, since,
                        ),
                        None => false,
                    })
                })
            },
        ));
    }
    {
        let cx = cx.clone();
        let id = id.clone();
        options.idle_stop_minutes = Some(Arc::new(move || {
            let cx = cx.clone();
            let id = id.clone();
            Box::pin(async move {
                cx.reverse(
                    "conversation.host",
                    json!({"op": "idle_stop_minutes", "connection_id": id}),
                )
                .await
                .ok()
                .and_then(|minutes| minutes.as_f64())
                .unwrap_or(0.0)
            })
        }));
    }
    {
        let cx = cx.clone();
        let id = id.clone();
        options.keep_awake = Some(Arc::new(move |pane: String| {
            let cx = cx.clone();
            let id = id.clone();
            Box::pin(async move {
                // A call the core serves (the Rust front gives it the voice
                // sockets while it owns voice); Bun's own otherwise.
                if let Some(reason) = super::voice_socket::keep_awake(&format!("{id}/{pane}")) {
                    return Some(reason);
                }
                cx.reverse(
                    "conversation.host",
                    json!({"op": "keep_awake", "connection_id": id, "pane_id": pane}),
                )
                .await
                .ok()
                .and_then(|reason| reason.as_str().map(str::to_owned))
            })
        }));
    }
    options.command_for = Some(Arc::new(command_for));
    {
        let teller = teller.clone();
        let launch_local = local_of(&info);
        options.launch_command = Some(Arc::new(
            move |pane: &str, spec: roamgate_conversation::shared::LaunchSpec| {
                let token = random_token();
                teller.op(json!({
                "op": "register_launch",
                "pane_id": pane,
                "token": token,
                "spec": {
                    "argv": spec.argv,
                    "env": spec.env.iter().map(|(key, value)| (key.clone(), json!(value))).collect::<Map<String, Value>>(),
                    "unset": spec.unset,
                    "agent": spec.agent,
                    "terminal": spec.terminal,
                },
            }));
                roamgate_conversation::holder_script::launch_command(&token, launch_local.as_ref())
                    .unwrap_or_default()
            },
        ));
    }
    {
        let cx_offered = cx.clone();
        let id_offered = id.clone();
        let teller = teller.clone();
        let readers = readers.clone();
        let files = files.clone();
        options.models = Some(ModelsDeps {
            offered: Arc::new(move |session_id: String| {
                let cx = cx_offered.clone();
                let id = id_offered.clone();
                Box::pin(async move {
                    match cx
                        .reverse(
                            "conversation.host",
                            json!({"op": "models_offered", "connection_id": id, "session_id": session_id}),
                        )
                        .await
                    {
                        Ok(value) => (
                            value
                                .get("models")
                                .and_then(Value::as_array)
                                .map(|models| {
                                    models
                                        .iter()
                                        .filter_map(|model| model.as_str().map(str::to_owned))
                                        .collect()
                                })
                                .unwrap_or_default(),
                            value.get("error").and_then(Value::as_str).map(str::to_owned),
                        ),
                        Err(error) => (Vec::new(), Some(error.message)),
                    }
                })
            }),
            last_answered: Some(Arc::new(move |pane: String| {
                let readers = readers.clone();
                let files = files.clone();
                Box::pin(async move {
                    let tail = read_tail(&readers, &*files, &pane).await?;
                    latest_session_model(&tail, |_| true)
                })
            })),
            chosen: Arc::new(|session_id: &str| {
                session_profiles().get(Some(session_id)).and_then(|choice| {
                    choice
                        .get("model")
                        .and_then(Value::as_str)
                        .map(str::to_owned)
                })
            }),
            choose: Arc::new(
                move |session_id: &str, model: &str, resolved: Option<&str>| {
                    teller.op(json!({
                        "op": "choose_model",
                        "session_id": session_id,
                        "model": model,
                        "resolved": resolved,
                    }));
                },
            ),
        });
    }
    {
        let teller = teller.clone();
        options.on_lease_changed = Some(Arc::new(move |pane: &str| {
            teller.mirror();
            teller.op(json!({"op": "tell", "what": "lease_changed", "pane_id": pane}));
        }));
    }
    {
        let connection = id.clone();
        options.log = Some(Arc::new(move |message: &str, fields: Obj| {
            let fields = Value::Object(fields);
            tracing::info!(target: "bridge", connection = %connection, fields = %fields, "{message}");
        }));
    }
    let service = ConversationService::new(options);
    *slot.lock().unwrap() = Some(service.clone());
    teller.mirror();
    Ok((
        id,
        Arc::new(Connection {
            generation,
            service,
            teller,
        }),
    ))
}

fn local_of(info: &Value) -> Option<LocalHolder> {
    info.get("local_holder")
        .filter(|local| !local.is_null())
        .map(|local| LocalHolder {
            bin: str_of(local, "bin").to_owned(),
            socket: str_of(local, "socket").to_owned(),
        })
}

fn random_token() -> String {
    roamgate_base::paths::random_uuid().replace('-', "")
}

impl Shared {
    async fn connection(
        &self,
        cx: &FamilyContext,
        connection_id: Option<&str>,
        generation: Option<u64>,
    ) -> Result<Arc<Connection>, RpcError> {
        let mut connections = self.connections.lock().await;
        if let Some(id) = connection_id
            && let Some(known) = connections.get(id)
            && (generation.is_none() || known.generation == generation)
        {
            return Ok(known.clone());
        }
        let (id, built) = build_connection(cx, connection_id).await?;
        if let Some(known) = connections.get(&id)
            && known.generation == built.generation
        {
            return Ok(known.clone());
        }
        // A new generation: the old service goes (its holders poll the new one).
        connections.insert(id, built.clone());
        Ok(built)
    }
}

impl CoreFamily for ConversationFamily {
    fn name(&self) -> &'static str {
        FAMILY
    }

    fn call(&self, cx: &FamilyContext, call: IncomingCall) -> BoxFuture<Result<Value, RpcError>> {
        let shared = self.shared.clone();
        let owned = *shared.owned.lock().unwrap();
        let cx = cx.clone();
        Box::pin(async move {
            if !owned {
                return Err(not_owner());
            }
            if let Some(op) = call.method.strip_prefix("internal.conversation.") {
                return internal(&shared, &cx, op, &call.params).await;
            }
            if !is_agent_chat_method(&call.method) {
                return Err(RpcError::with_code(
                    format!("unknown method {}", call.method),
                    "unknown_method",
                ));
            }
            let connection = shared
                .connection(
                    &cx,
                    call.ctx.connection_id.as_deref(),
                    call.ctx.connection_generation,
                )
                .await?;
            let socket = call.ctx.socket_id.unwrap_or(0);
            let result =
                handle_agent_chat_rpc(&connection.service, socket, &call.method, &call.params)
                    .await;
            connection.teller.mirror();
            connection.teller.flush().await;
            result.map_err(RpcError::new)
        })
    }

    fn owned(&self, cx: &FamilyContext, owned: bool) {
        super::claude_mod::family_owned(cx, FAMILY, owned);
        let shared = self.shared.clone();
        {
            let mut was = shared.owned.lock().unwrap();
            if *was == owned {
                return;
            }
            *was = owned;
        }
        if owned {
            // The front's files are read afresh.
            forget_lease_files();
            return;
        }
        let cx = cx.clone();
        tokio::spawn(async move {
            let connections: Vec<Arc<Connection>> = shared
                .connections
                .lock()
                .await
                .drain()
                .map(|(_, each)| each)
                .collect();
            for connection in &connections {
                connection.service.dispose();
            }
            drop(connections);
            flush_lease_files().await;
            forget_lease_files();
            let _ = cx
                .reverse("conversation.host", json!({"op": "released"}))
                .await;
        });
    }
}

fn input_of(params: &Value) -> HolderSideInput {
    HolderSideInput {
        pane_id: str_of(params, "pane_id").to_owned(),
        session_id: str_of(params, "session_id").to_owned(),
        status: params.get("status").and_then(parse_holder_status_value),
        shell: params.get("shell").and_then(parse_holder_shell_value),
        signal: None,
    }
}

fn spec_of(value: &Value) -> SuspendedSpec {
    SuspendedSpec {
        session_id: str_of(value, "session_id").to_owned(),
        cwd: str_of(value, "cwd").to_owned(),
        agent: value
            .get("agent")
            .and_then(Value::as_str)
            .map(str::to_owned),
        terminal_args: value
            .get("terminal_args")
            .and_then(Value::as_array)
            .map(|args| {
                args.iter()
                    .filter_map(|arg| arg.as_str().map(str::to_owned))
                    .collect()
            })
            .unwrap_or_default(),
    }
}

async fn internal(
    shared: &Shared,
    cx: &FamilyContext,
    op: &str,
    params: &Value,
) -> Result<Value, RpcError> {
    if op == "stop" {
        // The front stops: what each service read is saved on its leases,
        // on disk before the channel goes.
        let connections: Vec<Arc<Connection>> = shared
            .connections
            .lock()
            .await
            .drain()
            .map(|(_, each)| each)
            .collect();
        for connection in &connections {
            connection.service.dispose();
        }
        drop(connections);
        flush_lease_files().await;
        return Ok(json!({"ok": true}));
    }
    if op == "socket_closed" {
        if let Some(socket) = params["socket_id"].as_u64() {
            for connection in shared.connections.lock().await.values() {
                connection.service.cleanup_ws(socket);
            }
        }
        return Ok(json!({"ok": true}));
    }
    // The service's own work counts as served for the parity suite's
    // proof (the holders' requests come through the front); notices do not.
    if !matches!(op, "attach" | "pane_closed" | "sweep") {
        roamgate_channel::core::note_served(
            &ProcessEnv,
            FAMILY,
            &format!("internal.conversation.{op}"),
        );
    }
    let connection_id = params.get("connection_id").and_then(Value::as_str);
    let connection = shared.connection(cx, connection_id, None).await?;
    let service = &connection.service;
    let pane = str_of(params, "pane_id");
    let result = match op {
        "attach" => json!({"ok": true}),
        "holder_hold" => Value::Object(service.holder_hold(input_of(params)).await),
        "holder_fg" => Value::Object(
            service
                .holder_fg(input_of(params), spec_of(&params["spec"]))
                .await,
        ),
        "holder_output" => service.holder_output(
            pane,
            str_of(params, "holder_id"),
            params["offset"].as_i64().unwrap_or(0),
            params["end"].as_i64().unwrap_or(0),
            str_of(params, "data"),
        ),
        "holder_handback" => Value::Object(service.holder_handback(pane).await),
        "prompt" => json!(
            service
                .prompt(
                    pane,
                    str_of(params, "text"),
                    params["peer"].as_bool().unwrap_or(false)
                )
                .await
                .map_err(RpcError::new)?
        ),
        "send" => service
            .send(pane, str_of(params, "text"), Vec::new(), None)
            .await
            .map_err(RpcError::new)?,
        "switch_session" => {
            service
                .switch_session(pane, str_of(params, "session_id"))
                .await
        }
        "restart_process" => service.restart_process(pane).await,
        "restart_terminal" => {
            service
                .restart_terminal(pane, params.get("session_id").and_then(Value::as_str))
                .await
        }
        "auto_start" => service.auto_start(pane, str_of(params, "session_id")),
        "pane_closed" => {
            service.pane_closed(pane);
            json!({"ok": true})
        }
        "sweep" => {
            service.sweep().await;
            json!({"ok": true})
        }
        "check_idle" => {
            service.check_idle().await;
            json!({"ok": true})
        }
        other => {
            return Err(RpcError::with_code(
                format!("unknown method internal.conversation.{other}"),
                "unknown_method",
            ));
        }
    };
    connection.teller.mirror();
    connection.teller.flush().await;
    Ok(result)
}
