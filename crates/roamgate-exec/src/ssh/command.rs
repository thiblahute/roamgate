//! SSH command lines (bridge/ssh-command.ts): destinations, the fixed
//! non-interactive policy, host commands that multiplex over a runtime's
//! master when one listens, masters, their control requests and the Herdr
//! tunnel's stream-local forwards.
//!
//! In TS an argv array carries its route and its log annotation in side
//! tables keyed by the array's identity. Here they are fields of
//! [`SshCommand`]: an argv copied into a plain `Vec` carries neither, as a
//! copy of the TS array does not.

use std::sync::Arc;

use super::sessions::SshSessions;

const SSH_DESTINATION_MAX_LENGTH: usize = 320;

/// The options every ssh Roamgate runs gets, ahead of anything else.
pub const SSH_NONINTERACTIVE_ARGS: [&str; 22] = [
    "-o",
    "BatchMode=yes",
    "-o",
    "StrictHostKeyChecking=yes",
    "-o",
    "PermitLocalCommand=no",
    "-o",
    "RequestTTY=no",
    "-o",
    "ControlMaster=no",
    "-o",
    "ControlPath=none",
    "-o",
    "ControlPersist=no",
    "-o",
    "ConnectTimeout=8",
    "-o",
    "ConnectionAttempts=1",
    // ConnectTimeout only covers the TCP connect and key exchange. Keepalives
    // end a session that stalls afterwards (network change, sleeping peer)
    // instead of leaving the process, and whatever awaits it, hung forever.
    "-o",
    "ServerAliveInterval=10",
    "-o",
    "ServerAliveCountMax=3",
];

/// Keeps a multiplexed command from logging in on its own when the master
/// refuses its session (sshd's MaxSessions) or its socket is gone: OpenSSH
/// would otherwise fall back to a connection of its own, through this proxy
/// command, which fails at once. Given first, it wins over a ProxyCommand or
/// ProxyJump of the user's config; it is never used while the master serves.
pub const SSH_MUX_ONLY_ARGS: [&str; 2] = ["-o", "ProxyCommand=false"];

/// A destination that is not an OpenSSH alias or `user@host`.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("ssh_destination must be an OpenSSH alias or user@host")]
pub struct InvalidDestination;

fn is_user(text: &str) -> bool {
    let bytes = text.as_bytes();
    !bytes.is_empty()
        && bytes.len() <= 64
        && (bytes[0].is_ascii_alphanumeric() || bytes[0] == b'_')
        && bytes[1..]
            .iter()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
}

fn is_host(text: &str) -> bool {
    let bytes = text.as_bytes();
    !bytes.is_empty()
        && bytes.len() <= 253
        && bytes[0].is_ascii_alphanumeric()
        && bytes[1..]
            .iter()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
}

/// `value` when it is an OpenSSH alias or `user@host` that cannot be read
/// as an option, a URL or a port.
pub fn validate_ssh_destination(value: &str) -> Result<&str, InvalidDestination> {
    if value.is_empty()
        || value.chars().count() > SSH_DESTINATION_MAX_LENGTH
        || !value.bytes().all(|byte| (0x21..=0x7e).contains(&byte))
        || value.starts_with('-')
        || value.contains(['/', '=', ':', ','])
        || value.contains("://")
    {
        return Err(InvalidDestination);
    }
    let parts: Vec<&str> = value.split('@').collect();
    let (user, host) = match parts.as_slice() {
        [host] => (None, *host),
        [user, host] => (Some(*user), *host),
        _ => return Err(InvalidDestination),
    };
    if !is_host(host) || user.is_some_and(|user| !is_user(user)) {
        return Err(InvalidDestination);
    }
    Ok(value)
}

/// Context for the debug log line of an ssh process (ssh-metrics.ts).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SshAnnotation {
    /// Short, stable caller name, for example `git.status`.
    pub tag: Option<String>,
    pub connection: Option<String>,
    /// Multiplexed over the runtime command master.
    pub master: bool,
}

impl SshAnnotation {
    /// `self` with what `other` sets laid over it.
    pub fn merged(&self, other: &SshAnnotation) -> SshAnnotation {
        SshAnnotation {
            tag: other.tag.clone().or_else(|| self.tag.clone()),
            connection: other.connection.clone().or_else(|| self.connection.clone()),
            master: other.master || self.master,
        }
    }
}

/// How [`SshSessions::run`] treats a host command.
#[derive(Debug, Clone)]
pub struct SshRoute {
    pub destination: String,
    /// Set when the argv multiplexes over this master's control socket.
    pub control_path: Option<String>,
    /// The same command without multiplexing, for the one cold retry.
    pub cold: SshCommand,
    /// The multiplexed command that fails instead of logging in on its own
    /// when the master refuses its session; what `run` runs.
    pub mux_only: Option<Vec<String>>,
    /// Only read-only commands may run twice when their master dies.
    pub retry_safe: bool,
}

/// An ssh command line with what goes with it.
#[derive(Debug, Clone, Default)]
pub struct SshCommand {
    pub argv: Vec<String>,
    pub annotation: SshAnnotation,
    /// Set for host commands built by [`SshSessions::command_argv`].
    pub route: Option<Arc<SshRoute>>,
}

impl SshCommand {
    /// A command with no route and no annotation.
    pub fn plain(argv: Vec<String>) -> Self {
        Self {
            argv,
            ..Self::default()
        }
    }

    /// The command with `annotation` laid over its own.
    pub fn annotated(mut self, annotation: SshAnnotation) -> Self {
        self.annotation = self.annotation.merged(&annotation);
        self
    }

    /// The command with its connection named, for its log line.
    pub fn for_connection(self, connection: &str) -> Self {
        self.annotated(SshAnnotation {
            connection: Some(connection.to_owned()),
            ..SshAnnotation::default()
        })
    }

    /// The same argv and annotation, without the route.
    pub fn unrouted(&self) -> Self {
        Self {
            argv: self.argv.clone(),
            annotation: self.annotation.clone(),
            route: None,
        }
    }

    /// Whether the argv holds `item`.
    pub fn contains(&self, item: &str) -> bool {
        self.argv.iter().any(|arg| arg == item)
    }
}

fn strings(items: &[&str]) -> Vec<String> {
    items.iter().map(|item| (*item).to_owned()).collect()
}

fn policy(destination: &str, trusted: &[String]) -> Vec<String> {
    let mut out = strings(&SSH_NONINTERACTIVE_ARGS);
    out.extend(trusted.iter().cloned());
    out.push("--".into());
    out.push(destination.into());
    out
}

impl SshSessions {
    /// A host command. While a runtime's master for the destination listens,
    /// the command multiplexes over it: `-S` overrides the `ControlPath=none`
    /// policy (a later `-o ControlPath=` would not, since the first value
    /// wins), and `ControlMaster=no` keeps the command a client that falls
    /// back to its own connection if the socket stops answering. Run it
    /// through [`SshSessions::run`] (or `hold`) for the session limit.
    pub fn command_argv(
        &self,
        destination: &str,
        command: &str,
        trusted: &[String],
        tag: Option<&str>,
    ) -> Result<SshCommand, InvalidDestination> {
        self.build_command(destination, command, trusted, tag, false)
    }

    /// [`Self::command_argv`] for a command with no remote side effects,
    /// which may rerun once cold when its master dies mid-command.
    pub fn read_command_argv(
        &self,
        destination: &str,
        command: &str,
        trusted: &[String],
        tag: Option<&str>,
    ) -> Result<SshCommand, InvalidDestination> {
        self.build_command(destination, command, trusted, tag, true)
    }

    fn build_command(
        &self,
        destination: &str,
        command: &str,
        trusted: &[String],
        tag: Option<&str>,
        retry_safe: bool,
    ) -> Result<SshCommand, InvalidDestination> {
        let validated = validate_ssh_destination(destination)?;
        let policy = policy(validated, trusted);
        let tagged = SshAnnotation {
            tag: tag.map(str::to_owned),
            ..SshAnnotation::default()
        };
        let mut cold_argv = vec!["ssh".to_owned()];
        cold_argv.extend(policy.iter().cloned());
        cold_argv.push(command.into());
        let cold = SshCommand::plain(cold_argv.clone()).annotated(tagged.clone());
        let control_path = self.master_control_path(validated);
        let (argv, mux_only) = match &control_path {
            Some(path) => {
                let mut argv = vec!["ssh".to_owned(), "-S".into(), path.clone()];
                argv.extend(policy.iter().cloned());
                argv.push(command.into());
                // The runner runs this one: a session the master cannot open
                // fails instead of logging in on its own, so it waits and
                // retries over the master. Windows' OpenSSH runs no POSIX
                // `false`.
                let mux_only = (!self.is_windows()).then(|| {
                    let mut mux = vec!["ssh".to_owned(), "-S".into(), path.clone()];
                    mux.extend(strings(&SSH_MUX_ONLY_ARGS));
                    mux.extend(policy.iter().cloned());
                    mux.push(command.into());
                    mux
                });
                (argv, mux_only)
            }
            None => (cold_argv, None),
        };
        let annotation = SshAnnotation {
            tag: tag.map(str::to_owned),
            connection: None,
            master: control_path.is_some(),
        };
        Ok(SshCommand {
            argv,
            annotation,
            route: Some(Arc::new(SshRoute {
                destination: validated.to_owned(),
                control_path,
                cold,
                mux_only,
                retry_safe,
            })),
        })
    }
}

/// A long-lived stdio bridge (the remote Windows Herdr bridges). It holds
/// its own connection for as long as its socket client stays, so it never
/// multiplexes over a master and takes none of the destination's slots.
pub fn ssh_bridge_command_argv(
    destination: &str,
    command: &str,
) -> Result<Vec<String>, InvalidDestination> {
    let mut argv = vec!["ssh".to_owned()];
    argv.extend(strings(&SSH_NONINTERACTIVE_ARGS));
    argv.push("--".into());
    argv.push(validate_ssh_destination(destination)?.into());
    argv.push(command.into());
    Ok(argv)
}

/// A foreground master owning `control_path` until it is killed.
pub fn ssh_master_argv(
    destination: &str,
    control_path: &str,
) -> Result<Vec<String>, InvalidDestination> {
    let mut argv = strings(&["ssh", "-M", "-S", control_path]);
    argv.extend(strings(&SSH_NONINTERACTIVE_ARGS));
    argv.push("-N".into());
    argv.push("--".into());
    argv.push(validate_ssh_destination(destination)?.into());
    Ok(argv)
}

/// Asks the master on `control_path` to exit, for one left by a crash. The
/// destination only fills the request; `-S` selects the master.
pub fn ssh_master_exit_argv(control_path: &str) -> Vec<String> {
    strings(&[
        "ssh",
        "-F",
        "/dev/null",
        "-S",
        control_path,
        "-O",
        "exit",
        "--",
        "roamgate-orphaned-master",
    ])
}

fn master_control_argv(
    destination: &str,
    control_path: &str,
    request: &str,
) -> Result<Vec<String>, InvalidDestination> {
    let mut argv = strings(&["ssh", "-S", control_path]);
    argv.extend(strings(&SSH_NONINTERACTIVE_ARGS));
    argv.push("-O".into());
    argv.push(request.into());
    argv.push("--".into());
    argv.push(validate_ssh_destination(destination)?.into());
    Ok(argv)
}

/// Closes the master's control socket to new sessions; running ones go on.
pub fn ssh_master_stop_argv(
    destination: &str,
    control_path: &str,
) -> Result<Vec<String>, InvalidDestination> {
    master_control_argv(destination, control_path, "stop")
}

pub fn ssh_master_check_argv(
    destination: &str,
    control_path: &str,
) -> Result<Vec<String>, InvalidDestination> {
    master_control_argv(destination, control_path, "check")
}

/// A stream-local forward of the Herdr tunnel.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StreamForward {
    pub local: String,
    pub remote: String,
}

/// The Herdr tunnel: stream-local forwards, and no remote command (`-N`)
/// unless `remote_command` gives one (the Herdr relay, ssh::herdr_relay),
/// which then runs for as long as the tunnel.
pub fn ssh_tunnel_argv(
    destination: &str,
    forwards: &[StreamForward],
    remote_command: Option<&str>,
) -> Result<Vec<String>, InvalidDestination> {
    let mut argv = vec!["ssh".to_owned()];
    argv.extend(strings(&SSH_NONINTERACTIVE_ARGS));
    argv.extend(strings(&[
        "-o",
        "ExitOnForwardFailure=yes",
        "-o",
        "StreamLocalBindUnlink=yes",
        "-o",
        "StreamLocalBindMask=0177",
    ]));
    if remote_command.is_none() {
        argv.push("-N".into());
    }
    for forward in forwards {
        argv.push("-L".into());
        argv.push(format!("{}:{}", forward.local, forward.remote));
    }
    argv.push("--".into());
    argv.push(validate_ssh_destination(destination)?.into());
    if let Some(command) = remote_command {
        argv.push(command.to_owned());
    }
    Ok(argv)
}

#[cfg(test)]
mod tests {
    use super::*;
    use roamgate_base::clock::TokioClock;
    use roamgate_protocol::vectors;
    use serde_json::{Value, json};

    fn text(value: &Value) -> String {
        vectors::text(value).expect("a string argument")
    }

    /// contract/vectors/ssh-command.json, the cases bun test reads too.
    #[tokio::test]
    async fn ssh_command_vectors() {
        let file = vectors::load("ssh-command");
        for case in &file.cases {
            for call in &case.calls {
                let target = call.target();
                let got: Result<Value, String> = match target.as_str() {
                    "ssh-command.validateSshDestination" => {
                        let destination = text(&call.args[0]);
                        validate_ssh_destination(&destination)
                            .map(|valid| json!(valid))
                            .map_err(|error| error.to_string())
                    }
                    "ssh-command.sshCommandArgv" => {
                        let sessions = SshSessions::new(Arc::new(TokioClock::starting_at(0)));
                        let trusted: Vec<String> = call
                            .args
                            .get(2)
                            .and_then(Value::as_array)
                            .map(|items| items.iter().map(text).collect())
                            .unwrap_or_default();
                        let tag = call.args.get(3).and_then(Value::as_str);
                        sessions
                            .command_argv(&text(&call.args[0]), &text(&call.args[1]), &trusted, tag)
                            .map(|command| json!(command.argv))
                            .map_err(|error| error.to_string())
                    }
                    "ssh-command.sshTunnelArgv" => {
                        let forwards: Vec<StreamForward> = call.args[1]
                            .as_array()
                            .unwrap()
                            .iter()
                            .map(|forward| StreamForward {
                                local: text(&forward["local"]),
                                remote: text(&forward["remote"]),
                            })
                            .collect();
                        let command = call.args.get(2).map(text);
                        ssh_tunnel_argv(&text(&call.args[0]), &forwards, command.as_deref())
                            .map(|argv| json!(argv))
                            .map_err(|error| error.to_string())
                    }
                    other => panic!("{}: no Rust side for {other}", case.title()),
                };
                match (&call.throws, got) {
                    (Some(message), Err(error)) => {
                        assert_eq!(&error, message, "{}", case.title())
                    }
                    (None, Ok(value)) => assert_eq!(
                        Some(&value),
                        call.result.as_ref(),
                        "{}: {target}",
                        case.title()
                    ),
                    (want, got) => panic!("{}: {target}: {want:?} but {got:?}", case.title()),
                }
            }
        }
    }

    #[test]
    fn master_and_control_requests_keep_the_policy() {
        let master = ssh_master_argv("dev-box", "/tmp/x/m.ctl").unwrap();
        assert_eq!(master[..4], ["ssh", "-M", "-S", "/tmp/x/m.ctl"]);
        assert_eq!(master[master.len() - 3..], ["-N", "--", "dev-box"]);
        let stop = ssh_master_stop_argv("dev-box", "/tmp/x/m.ctl").unwrap();
        assert_eq!(stop[..3], ["ssh", "-S", "/tmp/x/m.ctl"]);
        assert_eq!(stop[stop.len() - 4..], ["-O", "stop", "--", "dev-box"]);
        assert!(ssh_master_check_argv("-oX", "/x").is_err());
        let bridge = ssh_bridge_command_argv("dev-box", "powershell").unwrap();
        assert!(!bridge.contains(&"-S".to_owned()));
        assert_eq!(bridge[bridge.len() - 3..], ["--", "dev-box", "powershell"]);
    }
}
