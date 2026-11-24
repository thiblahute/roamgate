//! The connections' reverse targets (index.ts `coreReverseTargets`): the
//! connection lists, a runtime's Herdr (`herdr.call`, and as the agent
//! session readers see it), commands on its host through the core's SSH
//! slots, the setup's Herdr, the remote history watch, a pane's transcript
//! tail, and the agents' addresses (the agent messenger).

use std::path::PathBuf;
use std::sync::{Arc, OnceLock};
use std::time::Duration;

use base64::Engine as _;
use roamgate_agents::files::BoxFut;
use roamgate_agents::messenger::{
    AgentMessenger, MessengerOptions, MessengerRuntime, MessengerSnapshot,
};
use roamgate_channel::family::FamilyContext;
use roamgate_channel::protocol::RpcError;
use roamgate_connections::host_ops::{HostCommand, HostWait};
use roamgate_connections::profiles::ConnectionProfile;
use roamgate_exec::lanes::Lane;
use roamgate_exec::process::Command;
use roamgate_exec::quote::shell_quote;
use roamgate_herdr::control::{HerdrClient, HerdrClientOptions};
use serde_json::{Value, json};
use tokio::io::AsyncBufReadExt;

use super::{Layer, Lease, Target, call, logger, text};

pub(super) const TARGETS: &[(&str, Target)] = &[
    ("connections.list", |layer, _, _| {
        Box::pin(async move { Ok(connections_list(&layer)) })
    }),
    ("connections.ready", |layer, _, _| {
        Box::pin(async move { Ok(connections_ready(&layer)) })
    }),
    ("herdr.call", |layer, _, args| {
        Box::pin(async move { herdr_call(&layer, &args).await })
    }),
    ("herdr.ping", |layer, _, _| {
        Box::pin(async move { herdr_ping(&layer).await })
    }),
    ("herdr.setupGuard", |layer, _, _| {
        Box::pin(async move {
            // The connections' list once they started (Bun's facade had it
            // from the core's first status).
            let _ = layer.host.manager(Duration::from_secs(10)).await;
            herdr_setup_guard(&layer)
        })
    }),
    ("host.run", |layer, _, args| {
        Box::pin(async move { host_run(&layer, &args).await })
    }),
    ("workspace.ssh_run", |layer, _, args| {
        Box::pin(async move { workspace_ssh_run(&layer, &args).await })
    }),
    ("activity.hostScript", |layer, _, args| {
        Box::pin(async move { activity_host_script(&layer, &args).await })
    }),
    ("agent_sessions.connection", |layer, _, args| {
        Box::pin(async move { agent_sessions_connection(&layer, &args) })
    }),
    ("agent_sessions.herdr_call", |layer, _, args| {
        Box::pin(async move {
            let method = text(&args, "method")
                .ok_or_else(|| RpcError::new("agent_sessions.herdr_call needs a method"))?
                .to_owned();
            let lease = layer.lease(&args)?;
            let params = args.get("params").cloned().unwrap_or_else(|| json!({}));
            let params = if params.is_null() { json!({}) } else { params };
            layer
                .agent_herdr_call(
                    &lease,
                    &method,
                    params,
                    args.get("timeout_ms").and_then(Value::as_u64),
                    None,
                )
                .await
                .map_err(RpcError::new)
        })
    }),
    ("agent_sessions.host_read", |layer, _, args| {
        Box::pin(async move { agent_sessions_host_read(&layer, &args).await })
    }),
    ("agent_sessions.herdr_boot", |layer, _, args| {
        Box::pin(async move {
            let lease = layer.lease(&args)?;
            let fresh = args.get("fresh") == Some(&Value::Bool(true));
            Ok(json!(layer.herdr_boot(&lease, fresh).await))
        })
    }),
    ("agent_sessions.watch_remote", |layer, cx, args| {
        Box::pin(async move { watch_remote(&layer, &cx, &args).await })
    }),
    // The core keeps the seen marks: nothing for another side to read.
    ("agent_sessions.seen_written", |_, _, _| {
        Box::pin(async { Ok(json!({"ok": true})) })
    }),
    ("agent.transcript_tail", |layer, cx, args| {
        Box::pin(async move {
            let pane = text(&args, "pane_id")
                .ok_or_else(|| RpcError::new("agent.transcript_tail needs a pane_id"))?
                .to_owned();
            let lease = layer.lease(&args)?;
            transcript_tail(&cx, &lease.connection_id, &pane).await
        })
    }),
    ("agents.addresses", |layer, cx, _| {
        Box::pin(async move {
            let listed = messenger(&layer, &cx).list().await;
            Ok(Value::Array(
                listed
                    .into_iter()
                    .filter_map(|each| each.get("address").cloned())
                    .collect(),
            ))
        })
    }),
];

/// How a command runs on a connection's SSH host.
pub(super) struct SshRun<'a> {
    /// A command with no remote side effects (`sshReadCommandArgv`).
    pub read: bool,
    pub tag: &'a str,
    /// The connection the debug log labels it with.
    pub connection: Option<&'a str>,
    pub stdin: Option<Vec<u8>>,
    pub timeout_ms: u64,
    pub lane: Lane,
}

pub(super) struct Ran {
    pub code: i32,
    pub stdout: Vec<u8>,
    pub stderr: String,
}

/// A command on `host` through the core's SSH session slots (Bun's runs
/// went through `internal.host.run`).
pub(super) async fn run_ssh(
    layer: &Layer,
    host: &str,
    command: &str,
    run: SshRun<'_>,
) -> Result<Ran, String> {
    let ran = layer
        .host
        .ops()
        .run(
            &HostCommand {
                destination: host.to_owned(),
                command: command.to_owned(),
                trusted: Vec::new(),
                tag: Some(run.tag.to_owned()),
                read_only: run.read,
                connection: run.connection.map(str::to_owned),
            },
            run.stdin,
            &HostWait {
                timeout_ms: Some(run.timeout_ms),
                lane: run.lane,
            },
        )
        .await
        .map_err(|error| error.message)?;
    Ok(Ran {
        code: ran.code,
        stdout: ran.stdout,
        stderr: ran.stderr,
    })
}

/// `runProcessWithCodeTimeout` on this machine: `(code, stdout, stderr)`.
pub(super) async fn run_local(
    layer: &Layer,
    argv: Vec<String>,
    timeout_ms: u64,
    cwd: Option<&str>,
) -> Result<(i32, String, String), String> {
    let mut command = Command::new(argv).timeout(Duration::from_millis(timeout_ms));
    if let Some(cwd) = cwd {
        command = command.cwd(PathBuf::from(cwd));
    }
    let output = layer
        .host
        .ops()
        .runner
        .run(&command)
        .await
        .map_err(|error| error.to_string())?;
    Ok((output.code, output.stdout_text(), output.stderr_text()))
}

/// The argv of a read-only command on `host` (`sshReadCommandArgv`).
pub(super) fn ssh_read_argv(
    layer: &Layer,
    host: &str,
    command: &str,
    tag: &str,
) -> Result<Vec<String>, RpcError> {
    layer
        .host
        .ops()
        .sessions
        .read_command_argv(host, command, &[], Some(tag))
        .map(|built| built.argv)
        .map_err(|_| RpcError::new(format!("invalid SSH destination: {host}")))
}

fn connections_list(layer: &Layer) -> Value {
    let Some(manager) = layer.host.manager_now() else {
        return json!([]);
    };
    Value::Array(
        manager
            .list()
            .into_iter()
            .map(|status| {
                json!({
                    "id": status.id,
                    "generation": status.generation,
                    "is_default": status.is_default,
                })
            })
            .collect(),
    )
}

fn platform(lease: &Lease) -> Value {
    match lease.runtime.remote_platform() {
        Some(_) => json!("windows"),
        None => Value::Null,
    }
}

/// What the families ask of every ready connection.
pub(super) fn connections_ready(layer: &Layer) -> Value {
    let Some(manager) = layer.host.manager_now() else {
        return json!([]);
    };
    Value::Array(
        manager
            .list()
            .into_iter()
            .filter_map(|status| {
                let lease = manager.ready_runtime_lease(&status.id).ok().flatten()?;
                Some(json!({
                    "id": status.id,
                    "generation": lease.generation,
                    "remote_platform": platform(&lease),
                    "ssh_host": lease.runtime.ssh_host(),
                }))
            })
            .collect(),
    )
}

async fn herdr_call(layer: &Layer, args: &Value) -> Result<Value, RpcError> {
    let method = text(args, "method").ok_or_else(|| RpcError::new("herdr.call needs a method"))?;
    let lease = layer.lease(args)?;
    let params = match args.get("params") {
        None | Some(Value::Null) => json!({}),
        Some(params) => params.clone(),
    };
    lease
        .runtime
        .herdr()
        .call(
            method,
            params,
            args.get("timeout_ms")
                .and_then(Value::as_u64)
                .unwrap_or(roamgate_herdr::control::DEFAULT_CALL_TIMEOUT_MS),
            None,
            args.get("fresh") == Some(&Value::Bool(true)),
        )
        .await
        .map_err(RpcError::new)
}

/// The default connection's Herdr identity (index.ts `herdrSetupPing`).
async fn herdr_ping(layer: &Layer) -> Result<Value, RpcError> {
    let id = layer.default_id();
    if let Ok(Some(lease)) = layer.ready(&id) {
        return lease.runtime.herdr().ping().await.map_err(RpcError::new);
    }
    let socket = layer.config.lock().unwrap().socket_path.clone();
    HerdrClient::new(socket, HerdrClientOptions::default())
        .ping()
        .await
        .map_err(RpcError::new)
}

/// What makes a managed Herdr impossible for the default connection
/// (http/herdr-setup.ts `herdrSetupGuardForProfile`).
fn herdr_setup_guard(layer: &Layer) -> Result<Value, RpcError> {
    let profile = layer
        .host
        .profile(&layer.default_id())
        .ok_or_else(|| RpcError::new("Default connection profile is unavailable."))?;
    let config = layer.config.lock().unwrap().clone();
    let (ssh_host, socket_differs, client_differs) = match &profile {
        ConnectionProfile::Ssh(ssh) => (Some(ssh.ssh_destination.clone()), false, false),
        ConnectionProfile::Local(local) => (
            config.ssh_host.clone(),
            local.control_socket_path != config.socket_path,
            local.client_socket_path != config.client_socket_path,
        ),
    };
    let mut guard = serde_json::Map::new();
    if let Some(host) = ssh_host {
        guard.insert("sshHost".into(), json!(host));
    }
    if let Some(session) = &config.session {
        guard.insert("session".into(), json!(session));
    }
    guard.insert(
        "hasExplicitSocketPath".into(),
        json!(config.has_explicit_socket_path || socket_differs),
    );
    guard.insert(
        "hasExplicitClientSocketPath".into(),
        json!(config.has_explicit_client_socket_path || client_differs),
    );
    Ok(Value::Object(guard))
}

fn argv_of(args: &Value, target: &str) -> Result<Vec<String>, RpcError> {
    let argv: Option<Vec<String>> = args.get("argv").and_then(Value::as_array).and_then(|argv| {
        argv.iter()
            .map(|part| part.as_str().map(str::to_owned))
            .collect()
    });
    argv.filter(|argv| !argv.is_empty())
        .ok_or_else(|| RpcError::new(format!("{target} needs argv, a list of strings")))
}

/// `host.run`: a command on the connection's host, `cd`'d into `cwd`.
async fn host_run(layer: &Layer, args: &Value) -> Result<Value, RpcError> {
    let argv = argv_of(args, "host.run")?;
    let cwd = match args.get("cwd") {
        None | Some(Value::Null) => None,
        Some(Value::String(cwd)) => Some(cwd.clone()),
        Some(_) => return Err(RpcError::new("host.run's cwd is not a string")),
    };
    let timeout_ms = args
        .get("timeout_ms")
        .and_then(Value::as_u64)
        .unwrap_or(60_000);
    let lease = layer.lease(args)?;
    let (code, stdout, stderr) = match lease.runtime.ssh_host() {
        None => run_local(
            layer,
            argv,
            timeout_ms,
            cwd.as_deref().filter(|cwd| !cwd.is_empty()),
        )
        .await
        .map_err(RpcError::new)?,
        Some(host) => {
            let quoted: Vec<String> = argv.iter().map(|part| shell_quote(part)).collect();
            let command = match cwd.as_deref().filter(|cwd| !cwd.is_empty()) {
                Some(cwd) => format!("cd {} && {}", shell_quote(cwd), quoted.join(" ")),
                None => quoted.join(" "),
            };
            let ran = run_ssh(
                layer,
                host,
                &command,
                SshRun {
                    read: false,
                    tag: "core-host-run",
                    connection: None,
                    stdin: None,
                    timeout_ms,
                    lane: Lane::Interactive,
                },
            )
            .await
            .map_err(RpcError::new)?;
            (
                ran.code,
                String::from_utf8_lossy(&ran.stdout).into_owned(),
                ran.stderr,
            )
        }
    };
    Ok(json!({"code": code, "stdout": stdout, "stderr": stderr}))
}

/// `workspace.ssh_run`: the workspace family's command on the
/// connection's SSH host, as the workspace's own.
async fn workspace_ssh_run(layer: &Layer, args: &Value) -> Result<Value, RpcError> {
    let command = text(args, "command")
        .ok_or_else(|| RpcError::new("workspace.ssh_run needs a command"))?
        .to_owned();
    let lease = layer.lease(args)?;
    let host = lease
        .runtime
        .ssh_host()
        .ok_or_else(|| RpcError::new("workspace.ssh_run needs an SSH connection"))?
        .to_owned();
    let stdin = match text(args, "stdin_b64") {
        Some(input) => Some(
            base64::engine::general_purpose::STANDARD
                .decode(input)
                .map_err(|_| RpcError::new("stdin_b64 is not base64"))?,
        ),
        None => None,
    };
    let tag = text(args, "tag").filter(|tag| !tag.is_empty());
    let ran = layer
        .host
        .ops()
        .run(
            &HostCommand {
                destination: host,
                command,
                trusted: Vec::new(),
                tag: tag.map(str::to_owned),
                read_only: args.get("read") == Some(&Value::Bool(true)),
                connection: Some(lease.connection_id.clone()),
            },
            stdin,
            &HostWait {
                timeout_ms: Some(
                    args.get("timeout_ms")
                        .and_then(Value::as_u64)
                        .unwrap_or(60_000),
                ),
                lane: Lane::Interactive,
            },
        )
        .await
        .map_err(|error| RpcError::new(error.message))?;
    Ok(json!({
        "code": ran.code,
        "stdout_b64": base64::engine::general_purpose::STANDARD.encode(&ran.stdout),
        "stderr": ran.stderr,
    }))
}

/// `activity.hostScript`: git on a connection's host for the activity
/// log, read-only, behind interactive SSH work.
async fn activity_host_script(layer: &Layer, args: &Value) -> Result<Value, RpcError> {
    let (Some(id), Some(script)) = (text(args, "connection_id"), text(args, "script")) else {
        return Err(RpcError::new(
            "activity.hostScript needs a connection_id and a script",
        ));
    };
    let lease = layer
        .ready(id)?
        .ok_or_else(|| RpcError::new(format!("connection not ready: {id}")))?;
    let host = lease.runtime.ssh_host();
    // No POSIX shell to read with: the log keeps what Herdr says.
    if lease.runtime.remote_platform().is_some() || (host.is_none() && cfg!(windows)) {
        return Ok(json!({"code": 0, "stdout": ""}));
    }
    let (code, stdout, stderr) = match host {
        Some(host) => {
            let ran = run_ssh(
                layer,
                host,
                script,
                SshRun {
                    read: true,
                    tag: "activity.repo",
                    connection: None,
                    stdin: None,
                    timeout_ms: 20_000,
                    lane: Lane::Background,
                },
            )
            .await
            .map_err(RpcError::new)?;
            (
                ran.code,
                String::from_utf8_lossy(&ran.stdout).into_owned(),
                ran.stderr,
            )
        }
        None => roamgate_exec::lanes::run_in_lane(
            Lane::Background,
            run_local(
                layer,
                vec!["/bin/sh".into(), "-c".into(), script.to_owned()],
                20_000,
                None,
            ),
        )
        .await
        .map_err(RpcError::new)?,
    };
    Ok(json!({"code": code, "stdout": stdout, "stderr": stderr}))
}

fn agent_sessions_connection(layer: &Layer, args: &Value) -> Result<Value, RpcError> {
    let lease = layer.lease(args)?;
    Ok(json!({
        "connection_id": lease.connection_id,
        "generation": lease.generation,
        "ssh": lease.runtime.ssh_host().is_some(),
        "remote_platform": platform(&lease),
    }))
}

/// `agent_sessions.host_read`: a transcript command on the connection's
/// SSH host.
async fn agent_sessions_host_read(layer: &Layer, args: &Value) -> Result<Value, RpcError> {
    let argv = argv_of(args, "agent_sessions.host_read")?;
    let lease = layer.lease(args)?;
    let host = lease
        .runtime
        .ssh_host()
        .ok_or_else(|| RpcError::new("agent_sessions.host_read needs an SSH host"))?;
    let command: Vec<String> = argv.iter().map(|part| shell_quote(part)).collect();
    let ran = run_ssh(
        layer,
        host,
        &command.join(" "),
        SshRun {
            read: true,
            tag: "agent.session.read",
            connection: None,
            stdin: None,
            timeout_ms: args
                .get("timeout_ms")
                .and_then(Value::as_u64)
                .unwrap_or(60_000),
            lane: Lane::Interactive,
        },
    )
    .await
    .map_err(RpcError::new)?;
    Ok(json!({
        "code": ran.code,
        "stdout": base64::engine::general_purpose::STANDARD.encode(&ran.stdout),
        "stderr": ran.stderr,
    }))
}

/// `agent_sessions.watch_remote`: the stat loop over the watched files of
/// a connection's host, one at a time per connection; its lines and its
/// exit go to the agent_sessions family (history-watch.ts
/// `createRemoteStatSpawner`).
async fn watch_remote(
    layer: &Arc<Layer>,
    cx: &FamilyContext,
    args: &Value,
) -> Result<Value, RpcError> {
    let (Some(id), Some(watch_id)) = (
        text(args, "connection_id"),
        args.get("watch_id").and_then(Value::as_u64),
    ) else {
        return Err(RpcError::new(
            "agent_sessions.watch_remote needs a connection_id and a watch_id",
        ));
    };
    let paths: Vec<String> = args
        .get("paths")
        .and_then(Value::as_array)
        .map(|paths| {
            paths
                .iter()
                .filter_map(|path| path.as_str().map(str::to_owned))
                .collect()
        })
        .unwrap_or_default();
    {
        let mut watches = layer.watches.lock().unwrap();
        if watches
            .get(id)
            .is_some_and(|(running, _)| !paths.is_empty() || *running == watch_id)
            && let Some((_, task)) = watches.remove(id)
        {
            task.abort();
        }
    }
    if paths.is_empty() {
        return Ok(json!({"ok": true}));
    }
    let lease = layer.lease(&json!({"connection_id": id}))?;
    let host = lease
        .runtime
        .ssh_host()
        .ok_or_else(|| RpcError::new("agent_sessions.watch_remote needs an SSH host"))?
        .to_owned();
    let quoted: Vec<String> = paths.iter().map(|path| shell_quote(path)).collect();
    let command = format!(
        "sh -c {} sh {}",
        shell_quote(roamgate_base::assets::STAT_LOOP_SH),
        quoted.join(" ")
    );
    let (layer_task, cx_task, id_task) = (layer.clone(), cx.clone(), id.to_owned());
    let task = tokio::spawn(async move {
        run_stat_loop(&cx_task, &id_task, watch_id, &host, &command).await;
        {
            let mut watches = layer_task.watches.lock().unwrap();
            if watches
                .get(&id_task)
                .is_some_and(|(running, _)| *running == watch_id)
            {
                watches.remove(&id_task);
            }
        }
        let _ = call(
            &cx_task,
            "internal.agent_sessions.remote_exit",
            json!({"connection_id": id_task, "watch_id": watch_id}),
        )
        .await;
    });
    layer
        .watches
        .lock()
        .unwrap()
        .insert(id.to_owned(), (watch_id, task));
    Ok(json!({"ok": true}))
}

/// The stat loop on `host`, holding one long-lived session of its master;
/// each line to the agent_sessions family, until it ends. Stopped by
/// aborting its task (its process killed on drop, its hold released).
async fn run_stat_loop(cx: &FamilyContext, id: &str, watch_id: u64, host: &str, command: &str) {
    let held = call(
        cx,
        "internal.host.ssh_hold",
        json!({
            "destination": host,
            "command": command,
            "tag": "agent_history.watch",
            "read_only": true,
            "long_lived": true,
        }),
    )
    .await;
    let Ok(held) = held else {
        return;
    };
    let lease = held.get("lease").and_then(Value::as_u64).unwrap_or(0);
    let release = Release {
        cx: cx.clone(),
        lease,
    };
    let argv: Vec<String> = held
        .get("argv")
        .and_then(Value::as_array)
        .map(|argv| {
            argv.iter()
                .filter_map(|part| part.as_str().map(str::to_owned))
                .collect()
        })
        .unwrap_or_default();
    let Some((program, rest)) = argv.split_first() else {
        return;
    };
    let child = tokio::process::Command::new(program)
        .args(rest)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .kill_on_drop(true)
        .spawn();
    let Ok(mut child) = child else {
        return;
    };
    if let Some(stdout) = child.stdout.take() {
        let mut lines = tokio::io::BufReader::new(stdout).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            let _ = call(
                cx,
                "internal.agent_sessions.remote_stat",
                json!({"connection_id": id, "watch_id": watch_id, "line": line}),
            )
            .await;
        }
    }
    let _ = child.wait().await;
    drop(release);
}

/// Gives a held session back when its loop ends, or its task is aborted.
struct Release {
    cx: FamilyContext,
    lease: u64,
}

impl Drop for Release {
    fn drop(&mut self) {
        super::tell(
            &self.cx,
            "internal.host.ssh_release",
            json!({"lease": self.lease}),
        );
    }
}

/// The end of the pane session's transcript, or null (runtime.ts
/// `transcriptTail`).
pub(super) async fn transcript_tail(
    cx: &FamilyContext,
    connection_id: &str,
    pane_id: &str,
) -> Result<Value, RpcError> {
    let (readers, files) = super::super::agent_sessions::owned_readers(cx, connection_id).await?;
    let path = readers
        .resolve_path(&json!({"pane_id": pane_id}))
        .await
        .map_err(|error| RpcError::new(error.message))?;
    let Some(path) = path else {
        return Ok(Value::Null);
    };
    let bytes = files
        .read_tail(&path, 64 * 1024)
        .await
        .map_err(|error| RpcError::new(error.to_string()))?;
    Ok(json!(String::from_utf8_lossy(&bytes)))
}

/// The agent messenger of the sessions Roamgate manages (index.ts
/// `getAgentMessenger`).
pub(super) fn messenger(layer: &Arc<Layer>, cx: &FamilyContext) -> AgentMessenger {
    static MESSENGER: OnceLock<AgentMessenger> = OnceLock::new();
    MESSENGER
        .get_or_init(|| {
            let connections = {
                let layer = layer.clone();
                Arc::new(move || {
                    connections_ready(&layer)
                        .as_array()
                        .into_iter()
                        .flatten()
                        .filter(|each| each["remote_platform"].is_null())
                        .filter_map(|each| each["id"].as_str().map(str::to_owned))
                        .collect()
                })
            };
            let runtime = {
                let (layer, cx) = (layer.clone(), cx.clone());
                Arc::new(move |id: &str| {
                    let lease = layer.ready(id).ok().flatten()?;
                    if lease.runtime.remote_platform().is_some() {
                        return None;
                    }
                    Some(Arc::new(MessengerConnection {
                        layer: layer.clone(),
                        cx: cx.clone(),
                        lease,
                    }) as Arc<dyn MessengerRuntime>)
                })
            };
            let mut options = MessengerOptions::new(connections, runtime);
            let log = logger(&cx.clock, "bridge");
            options.log = Some(Arc::new(move |message, fields| {
                log.info(message, Some(&super::fields(fields)));
            }));
            AgentMessenger::new(options)
        })
        .clone()
}

/// A ready connection as the messenger uses it.
struct MessengerConnection {
    layer: Arc<Layer>,
    cx: FamilyContext,
    lease: super::Lease,
}

impl MessengerRuntime for MessengerConnection {
    fn holds<'a>(&'a self, pane_id: &'a str) -> BoxFut<'a, bool> {
        let held = !self.layer.mirror(&self.lease.connection_id)["leases"][pane_id].is_null();
        Box::pin(async move { held })
    }

    fn status<'a>(&'a self, pane_id: &'a str) -> BoxFut<'a, String> {
        let status = self.layer.mirror(&self.lease.connection_id)["status"][pane_id]
            .as_str()
            .unwrap_or("stopped")
            .to_owned();
        Box::pin(async move { status })
    }

    fn prompt<'a>(&'a self, pane_id: &'a str, text: &'a str) -> BoxFut<'a, Result<bool, String>> {
        Box::pin(async move {
            super::conversation::prompt(
                &self.layer,
                &self.cx,
                &self.lease.connection_id,
                pane_id,
                text,
                true,
                None,
            )
            .await
            .map_err(|error| error.message)
        })
    }

    fn has_claude_mod(&self) -> bool {
        true
    }

    fn mod_deliver<'a>(
        &'a self,
        pane_id: &'a str,
        text: &'a str,
        kind: &'a str,
    ) -> BoxFut<'a, bool> {
        let delivered =
            super::conversation::mod_deliver(&self.lease.connection_id, pane_id, text, kind)
                .is_ok_and(|id| !id.is_null());
        Box::pin(async move { delivered })
    }

    fn mod_has_tools<'a>(&'a self, pane_id: &'a str) -> BoxFut<'a, bool> {
        let tools = super::super::claude_mod::current()
            .is_some_and(|hub| hub.has_tools(&self.lease.connection_id, pane_id));
        Box::pin(async move { tools })
    }

    fn herdr_call<'a>(
        &'a self,
        method: &'a str,
        params: Value,
        timeout_ms: Option<u64>,
    ) -> BoxFut<'a, Result<Value, String>> {
        Box::pin(async move {
            self.lease
                .runtime
                .herdr()
                .call(
                    method,
                    params,
                    timeout_ms.unwrap_or(roamgate_herdr::control::DEFAULT_CALL_TIMEOUT_MS),
                    None,
                    false,
                )
                .await
        })
    }

    fn read(&self) -> BoxFut<'_, Result<MessengerSnapshot, String>> {
        Box::pin(async move {
            let herdr = self.lease.runtime.herdr();
            let id = &self.lease.connection_id;
            let agents = async {
                let (readers, _) = super::super::agent_sessions::owned_readers(&self.cx, id)
                    .await
                    .map_err(|error| error.message)?;
                readers
                    .list_with_activity(json!({}))
                    .await
                    .map_err(|error| error.message)
            };
            let (workspaces, tabs, panes, agents) = tokio::try_join!(
                herdr.call("workspace.list", json!({}), 5000, None, false),
                herdr.call("tab.list", json!({}), 5000, None, false),
                herdr.call("pane.list", json!({}), 5000, None, false),
                agents,
            )?;
            let list =
                |value: &Value, key: &str| value[key].as_array().cloned().unwrap_or_default();
            Ok(MessengerSnapshot {
                workspaces: list(&workspaces, "workspaces"),
                tabs: list(&tabs, "tabs"),
                panes: list(&panes, "panes"),
                agents: list(&agents, "agents"),
            })
        })
    }
}
