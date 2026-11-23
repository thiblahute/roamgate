//! `roamgate connections` (cli/connections.ts): list, test and edit the
//! saved Herdr connection profiles the web UI's selector edits, refusing
//! edits while a Roamgate listener holds its own copy of them.

use std::future::Future;
use std::pin::Pin;

use roamgate_connections::manager::LEGACY_DEFAULT_CONNECTION_ID;
use roamgate_connections::profile_service::{
    ProbeResult, SshProbeEnvironment, test_connection_profile,
};
use roamgate_connections::profiles::{
    CONNECTION_PROFILE_FILE_VERSION, ConnectionProfile as Profile, LocalConnectionProfile,
    PersistedConnectionRegistry as Registry, validate_connection_profile,
};
use roamgate_exec::service::node_platform;
use serde_json::{Map, Value, json};

use crate::args::{
    EXIT_FAILURE, EXIT_OK, Failure, Opt, Parsed, parse_args, parse_command_args, wants_help,
};
use crate::context::CliContext;
use crate::index::{Outcome, command_help};
use crate::service_context::{
    ServiceAccessInfo, ServiceSetup, connection_profile_store, probe_listener, read_service_access,
    read_service_setup, restart_running_service, service_herdr_sockets, service_status,
};

pub type LocalFuture<'a, T> = Pin<Box<dyn Future<Output = T> + 'a>>;

/// Whether a Roamgate listener answers at the service's address.
pub type Probe = Box<dyn for<'a> Fn(&'a ServiceAccessInfo) -> LocalFuture<'a, bool>>;

/// Tests a profile: what Herdr answered, else why not.
pub type TestProfile =
    Box<dyn for<'a> Fn(&'a Profile) -> LocalFuture<'a, Result<ProbeResult, String>>>;

/// The command's effects (ConnectionsDependencies).
pub struct ConnectionsDeps {
    pub probe: Probe,
    pub test: TestProfile,
}

impl ConnectionsDeps {
    /// The real listener probe and profile test.
    pub fn real(context: &CliContext) -> Self {
        let env = context.runtime.env.clone();
        Self {
            probe: Box::new(|access| {
                Box::pin(probe_listener(&access.host, access.port, access.tls))
            }),
            test: Box::new(move |profile| {
                let environment = SshProbeEnvironment::real(env.clone());
                Box::pin(async move {
                    test_connection_profile(profile, &environment)
                        .await
                        .map_err(|error| error.message)
                })
            }),
        }
    }
}

const ADD_OPTIONS: &[Opt] = &[
    Opt::string("label"),
    Opt::string("ssh"),
    Opt::string("control-socket"),
    Opt::string("client-socket"),
    Opt::string("remote-control-socket"),
    Opt::string("remote-client-socket"),
    Opt::flag("windows"),
    Opt::string("herdr-path"),
    Opt::string("session"),
    Opt::flag("auto-connect"),
    Opt::flag("default"),
    Opt::flag("restart"),
];

/// Mirrors the server: explicit Herdr settings pin the process default.
pub(crate) fn explicit_override(setup: &ServiceSetup) -> bool {
    [
        "HERDR_SOCKET_PATH",
        "HERDR_CLIENT_SOCKET_PATH",
        "HERDR_SSH_HOST",
        "HERDR_SESSION",
    ]
    .iter()
    .any(|name| setup.env.get(*name).is_some_and(|value| !value.is_empty()))
}

fn local_profile(id: &str, label: &str, control: &str, client: &str) -> Profile {
    Profile::Local(LocalConnectionProfile {
        id: id.into(),
        label: label.into(),
        control_socket_path: control.into(),
        client_socket_path: client.into(),
        auto_connect: true,
    })
}

fn profile_id(profile: &Profile) -> &str {
    profile.id()
}

/// The connection the service config gives when nothing is saved.
fn implicit_default(context: &CliContext, setup: &ServiceSetup) -> Profile {
    let (control, client) = service_herdr_sockets(&context.runtime, &setup.env);
    local_profile(LEGACY_DEFAULT_CONNECTION_ID, "Default", &control, &client)
}

fn describe(profile: &Profile) -> String {
    let ssh = match profile {
        Profile::Local(local) => return format!("local  {}", local.control_socket_path),
        Profile::Ssh(ssh) => ssh,
    };
    let remote = if ssh.remote_platform_windows {
        match ssh.remote_session.as_deref().unwrap_or_default() {
            "" => " (Windows)".to_owned(),
            session => format!(" (Windows, session {session})"),
        }
    } else {
        String::new()
    };
    format!("ssh    {}{remote}", ssh.ssh_destination)
}

enum Decision {
    Write,
    WriteAndRestart,
}

/// Refuses to write while a Roamgate listener holds its own copy: the
/// decision, else the exit code.
async fn guard_running_server(
    context: &CliContext,
    setup: &ServiceSetup,
    restart: bool,
    deps: &ConnectionsDeps,
) -> Result<Result<Decision, i32>, Failure> {
    let access = read_service_access(&context.runtime, setup).map_err(Failure::Failed)?;
    if !(deps.probe)(&access).await {
        return Ok(Ok(Decision::Write));
    }
    // Unsupported platform: only a foreground process can be serving.
    let active = service_status(context).is_ok_and(|status| status.active);
    if !active {
        context.error(
            "roamgate connections: a roamgate process is serving and would overwrite this change.",
        );
        context.error("Use the connection selector in the web UI, or stop that process first.");
        return Ok(Err(EXIT_FAILURE));
    }
    if !restart {
        context.error(
            "roamgate connections: the running service keeps its own copy of the profiles and would overwrite this change.",
        );
        context.error(
            "Use the connection selector in the web UI, or rerun with --restart to restart the service.",
        );
        return Ok(Err(EXIT_FAILURE));
    }
    Ok(Ok(Decision::WriteAndRestart))
}

fn profile_from_flags(id: &str, values: &Parsed) -> Result<Profile, Failure> {
    let label = values.string("label").unwrap_or(id);
    let auto_connect = values.flag("auto-connect");
    let truthy = |name: &str| values.string(name).is_some_and(|value| !value.is_empty());
    let Some(ssh) = values.string("ssh") else {
        if let Some(used) = [
            "remote-control-socket",
            "remote-client-socket",
            "windows",
            "herdr-path",
            "session",
        ]
        .iter()
        .find(|name| values.values.contains_key(**name))
        {
            return Err(Failure::Usage(format!("--{used} requires --ssh")));
        }
        if !truthy("control-socket") || !truthy("client-socket") {
            return Err(Failure::Usage(
                "add needs --ssh <destination>, or both --control-socket and --client-socket"
                    .into(),
            ));
        }
        return validate_connection_profile(
            &json!({
                "id": id,
                "label": label,
                "type": "local",
                "control_socket_path": values.string("control-socket"),
                "client_socket_path": values.string("client-socket"),
                "auto_connect": auto_connect,
            }),
            node_platform(),
        )
        .map_err(Failure::Usage);
    };
    if truthy("control-socket") || truthy("client-socket") {
        return Err(Failure::Usage(
            "local socket options cannot be combined with --ssh".into(),
        ));
    }
    let mut profile = Map::new();
    profile.insert("id".into(), id.into());
    profile.insert("label".into(), label.into());
    profile.insert("type".into(), "ssh".into());
    profile.insert("ssh_destination".into(), ssh.into());
    profile.insert(
        "remote_control_socket_path".into(),
        values
            .string("remote-control-socket")
            .unwrap_or_default()
            .into(),
    );
    profile.insert(
        "remote_client_socket_path".into(),
        values
            .string("remote-client-socket")
            .unwrap_or_default()
            .into(),
    );
    profile.insert("auto_connect".into(), auto_connect.into());
    if values.flag("windows") {
        profile.insert("remote_platform".into(), "windows".into());
    }
    if let Some(path) = values.string("herdr-path") {
        profile.insert("remote_herdr_path".into(), path.into());
    }
    if let Some(session) = values.string("session") {
        profile.insert("remote_session".into(), session.into());
    }
    validate_connection_profile(&Value::Object(profile), node_platform()).map_err(Failure::Usage)
}

/// A value as a JavaScript template literal prints it.
pub(crate) fn template_text(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        Value::Null => "null".into(),
        other => other.to_string(),
    }
}

/// `roamgate connections <args>`.
pub async fn run(args: &[String], context: &CliContext) -> Result<Outcome, Failure> {
    run_with(args, context, &ConnectionsDeps::real(context)).await
}

/// [`run`] with the effects `deps` gives.
pub async fn run_with(
    args: &[String],
    context: &CliContext,
    deps: &ConnectionsDeps,
) -> Result<Outcome, Failure> {
    let Some(action) = args.first().filter(|_| !wants_help(args)) else {
        context.log(command_help("connections"));
        return Ok(Outcome::Code(EXIT_OK));
    };
    let rest = &args[1..];
    let setup = read_service_setup(&context.runtime).map_err(Failure::Failed)?;
    let store = connection_profile_store(&context.runtime, &setup.env).map_err(Failure::Failed)?;
    let registry = store.load().map_err(Failure::Failed)?;
    let explicit = explicit_override(&setup);
    // A copy: the explicit default is listed but never saved.
    let mut profiles: Vec<Profile> = match &registry {
        Some(registry) => registry.profiles.clone(),
        None => vec![implicit_default(context, &setup)],
    };
    let default_id = match &registry {
        Some(registry) if !explicit => registry.default_connection_id.clone(),
        _ => LEGACY_DEFAULT_CONNECTION_ID.to_owned(),
    };
    if registry.is_some() && explicit {
        profiles.insert(0, implicit_default(context, &setup));
    }

    match action.as_str() {
        "list" => {
            let values = parse_command_args(rest, &[Opt::flag("json")], 0)?;
            if values.flag("json") {
                let listed: Vec<Value> = profiles
                    .iter()
                    .map(|profile| {
                        let mut entry = match profile.to_value() {
                            Value::Object(entry) => entry,
                            _ => Map::new(),
                        };
                        let id = profile_id(profile);
                        entry.insert("default".into(), (id == default_id).into());
                        entry.insert("saved".into(), (id != LEGACY_DEFAULT_CONNECTION_ID).into());
                        Value::Object(entry)
                    })
                    .collect();
                context.print_json(&json!({
                    "path": store.path().display().to_string(),
                    "default_connection_id": default_id,
                    "profiles": listed,
                }));
                return Ok(Outcome::Code(EXIT_OK));
            }
            context.log(&context.display_path(store.path()));
            if registry.is_none() {
                context.log("No saved profiles; Roamgate uses the default local connection.");
            }
            let width = profiles
                .iter()
                .map(|profile| profile_id(profile).chars().count())
                .max()
                .unwrap_or(0);
            for profile in &profiles {
                let id = profile_id(profile);
                let flags: Vec<&str> = [
                    (id == default_id, "default"),
                    (profile.auto_connect(), "auto-connect"),
                    (id == LEGACY_DEFAULT_CONNECTION_ID, "from service config"),
                ]
                .into_iter()
                .filter_map(|(on, flag)| on.then_some(flag))
                .collect();
                context.log(&format!(
                    "{} {id:width$}  {}  {}{}",
                    if id == default_id { "*" } else { " " },
                    describe(profile),
                    profile.label(),
                    if flags.is_empty() {
                        String::new()
                    } else {
                        format!("  [{}]", flags.join(", "))
                    }
                ));
            }
            Ok(Outcome::Code(EXIT_OK))
        }
        "test" => {
            let values = parse_args(rest, &[Opt::flag("json")])?;
            let selected: Vec<&Profile> = if values.positionals.is_empty() {
                profiles.iter().collect()
            } else {
                values
                    .positionals
                    .iter()
                    .map(|id| {
                        profiles
                            .iter()
                            .find(|profile| profile_id(profile) == id)
                            .ok_or_else(|| Failure::Usage(format!("unknown connection: {id}")))
                    })
                    .collect::<Result<_, _>>()?
            };
            let results: Vec<Value> =
                futures_util::future::join_all(selected.iter().map(|profile| async {
                    let id = profile_id(profile);
                    match (deps.test)(profile).await {
                        Ok(result) => json!({
                            "id": id,
                            "ok": true,
                            "version": result.version,
                            "protocol": result.protocol,
                        }),
                        Err(error) => json!({"id": id, "ok": false, "error": error}),
                    }
                }))
                .await;
            if values.flag("json") {
                context.print_json(&json!({ "results": results }));
            } else {
                for result in &results {
                    let id = result["id"].as_str().unwrap_or_default();
                    context.log(&if result["ok"] == true {
                        format!(
                            "ok    {id}  Herdr {}, protocol {}",
                            result["version"].as_str().unwrap_or("(unknown version)"),
                            template_text(&result["protocol"])
                        )
                    } else {
                        format!(
                            "fail  {id}  {}",
                            result["error"].as_str().unwrap_or_default()
                        )
                    });
                }
            }
            let ok = results.iter().all(|result| result["ok"] == true);
            Ok(Outcome::Code(if ok { EXIT_OK } else { EXIT_FAILURE }))
        }
        "add" | "remove" | "set-default" => {
            let values = if action == "add" {
                parse_command_args(rest, ADD_OPTIONS, 1)?
            } else {
                parse_command_args(rest, &[Opt::flag("restart")], 1)?
            };
            let Some(id) = values.positionals.first().filter(|id| !id.is_empty()) else {
                return Err(Failure::Usage(format!(
                    "connections {action} needs a connection id"
                )));
            };
            let explicit_default = || {
                Failure::Usage(
                    "explicit Herdr settings in the service config remain the default connection"
                        .into(),
                )
            };
            let next: Option<Registry> = if action == "add" {
                let profile = profile_from_flags(id, &values)?;
                if profiles.iter().any(|entry| profile_id(entry) == id) {
                    return Err(Failure::Usage(format!("connection already exists: {id}")));
                }
                let mut next = if let Some(registry) = &registry {
                    let mut next = registry.clone();
                    next.version = CONNECTION_PROFILE_FILE_VERSION;
                    next.profiles.push(profile);
                    next
                } else if explicit {
                    Registry {
                        version: CONNECTION_PROFILE_FILE_VERSION,
                        default_connection_id: id.clone(),
                        profiles: vec![profile],
                    }
                } else {
                    // Like the web UI, keep the implicit local server saved.
                    let (control, client) = service_herdr_sockets(&context.runtime, &setup.env);
                    let seed = local_profile(
                        if id == "local" { "localhost" } else { "local" },
                        "Local",
                        &control,
                        &client,
                    );
                    Registry {
                        version: CONNECTION_PROFILE_FILE_VERSION,
                        default_connection_id: profile_id(&seed).to_owned(),
                        profiles: vec![seed, profile],
                    }
                };
                if values.flag("default") {
                    if explicit {
                        return Err(explicit_default());
                    }
                    next.default_connection_id = id.clone();
                }
                Some(next)
            } else {
                let Some(registry) = registry.as_ref().filter(|registry| {
                    id != LEGACY_DEFAULT_CONNECTION_ID
                        && registry
                            .profiles
                            .iter()
                            .any(|entry| profile_id(entry) == id)
                }) else {
                    return Err(Failure::Usage(format!("no saved connection: {id}")));
                };
                if action == "set-default" {
                    if explicit {
                        return Err(explicit_default());
                    }
                    let mut next = registry.clone();
                    next.version = CONNECTION_PROFILE_FILE_VERSION;
                    next.default_connection_id = id.clone();
                    Some(next)
                } else {
                    if registry.default_connection_id == *id && !explicit {
                        return Err(Failure::Usage(
                            "cannot remove the default connection; choose another default first"
                                .into(),
                        ));
                    }
                    let remaining: Vec<Profile> = registry
                        .profiles
                        .iter()
                        .filter(|entry| profile_id(entry) != id)
                        .cloned()
                        .collect();
                    // Without explicit Herdr settings the last profile is
                    // always the default: only an override clears them.
                    remaining.first().map(|first| Registry {
                        version: CONNECTION_PROFILE_FILE_VERSION,
                        default_connection_id: if registry.default_connection_id == *id {
                            profile_id(first).to_owned()
                        } else {
                            registry.default_connection_id.clone()
                        },
                        profiles: remaining.clone(),
                    })
                }
            };
            let decision =
                match guard_running_server(context, &setup, values.flag("restart"), deps).await? {
                    Ok(decision) => decision,
                    Err(code) => return Ok(Outcome::Code(code)),
                };
            match &next {
                Some(next) => store.save(next),
                None => store.clear(),
            }
            .map_err(Failure::Failed)?;
            context.log(&match action.as_str() {
                "add" => format!("Added connection {id}."),
                "remove" => format!("Removed connection {id}."),
                _ => format!("Default connection is now {id}."),
            });
            if let Decision::WriteAndRestart = decision {
                let code = restart_running_service(context).map_err(Failure::Failed)?;
                if code == Some(0) {
                    context.log("Restarted the service.");
                }
                return Ok(Outcome::Code(code.unwrap_or(EXIT_OK)));
            }
            Ok(Outcome::Code(EXIT_OK))
        }
        other => Err(Failure::Usage(format!(
            "unknown connections action: {other}"
        ))),
    }
}

#[cfg(test)]
mod tests;
