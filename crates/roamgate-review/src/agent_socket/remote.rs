//! Making `roamgate-review` work in an SSH host's panes
//! (review/agent-remote.ts): one setup command installs the client, the
//! holder, the skill and the Claude mod's marketplace unless this version
//! is there, and a reverse socket forward on the connection's master points
//! the host's well-known socket at this connection's agent socket.

use std::future::Future;
use std::time::Duration;

use roamgate_claude::plugin::{packed_output, remote_claude_mod_script};
use roamgate_exec::ssh::command::{
    InvalidDestination, SSH_NONINTERACTIVE_ARGS, SshAnnotation, SshCommand,
    validate_ssh_destination,
};
use roamgate_exec::ssh::sessions::SshSessions;

use super::REVIEW_HOME_DIR;
use super::texts::{
    HOLD_CLIENT_CHECKSUM, HOLD_CLIENT_INSTALLED_SCRIPT, REVIEW_CLIENT_CHECKSUM,
    REVIEW_CLIENT_INSTALLED_SCRIPT, REVIEW_SKILL,
};

pub const SETUP_TIMEOUT: Duration = Duration::from_secs(20);

/// What a command run on the host gave.
#[derive(Debug, Clone, Default)]
pub struct RunOutput {
    pub code: i32,
    pub stdout: String,
    pub stderr: String,
}

/// One command on the host: install the client unless this version is
/// already there, clear a stale socket left by an earlier connection (sshd
/// does not replace one by default), and print where the forward must go.
pub fn remote_setup_script() -> String {
    let review = REVIEW_CLIENT_CHECKSUM.as_str();
    let hold = HOLD_CLIENT_CHECKSUM.as_str();
    let mut lines = vec![
        "set -e".to_owned(),
        format!("d=\"$HOME/{REVIEW_HOME_DIR}\""),
        "mkdir -p \"$d/bin\"".into(),
        "chmod 700 \"$d\"".into(),
        "f=\"$d/bin/roamgate-review\"".into(),
        format!("if ! grep -q 'roamgate-review {review}' \"$f\" 2>/dev/null; then"),
        format!(
            "  {} > \"$f.tmp\"",
            packed_output(&REVIEW_CLIENT_INSTALLED_SCRIPT)
        ),
        "  chmod 755 \"$f.tmp\"".into(),
        "  mv \"$f.tmp\" \"$f\"".into(),
        "fi".into(),
        // Conversation mode's pane holder, beside it.
        "h=\"$d/bin/roamgate-hold\"".into(),
        format!("if ! grep -q 'roamgate-hold {hold}' \"$h\" 2>/dev/null; then"),
        format!("  {} > \"$h.tmp\"", packed_output(&HOLD_CLIENT_INSTALLED_SCRIPT)),
        "  chmod 755 \"$h.tmp\"".into(),
        "  mv \"$h.tmp\" \"$h\"".into(),
        "fi".into(),
        "mkdir -p \"$d/skills/roamgate-review\"".into(),
        format!(
            "{} > \"$d/skills/roamgate-review/SKILL.md\"",
            packed_output(REVIEW_SKILL)
        ),
        // Linked where agents look, as on this machine: never over the user's.
        "link() { [ -d \"${2%/*}\" ] || return 0; if [ -L \"$2\" ]; then case \"$(readlink \"$2\")\" in \"$1\") return 0 ;; *.cache/roamgate/*) rm -f \"$2\" ;; *) return 0 ;; esac; elif [ -e \"$2\" ]; then return 0; fi; ln -s \"$1\" \"$2\" || true; }".into(),
        "link \"$d/skills/roamgate-review\" \"$HOME/.claude/skills/roamgate-review\"".into(),
        "link \"$d/skills/roamgate-review\" \"$HOME/.codex/skills/roamgate-review\"".into(),
        "link \"$f\" \"$HOME/.local/bin/roamgate-review\"".into(),
    ];
    // The Claude mod's marketplace, installed only if the user asks.
    lines.extend(remote_claude_mod_script());
    lines.push("rm -f \"$d/review.sock\"".into());
    lines.push("printf %s \"$d/review.sock\"".into());
    lines.join("\n")
}

/// Adds the reverse socket forward to the running master, no new login.
pub fn remote_forward_argv(
    host: &str,
    control_path: &str,
    remote_socket: &str,
    local_socket: &str,
) -> Result<Vec<String>, InvalidDestination> {
    let mut argv = vec!["ssh".to_owned(), "-S".into(), control_path.into()];
    argv.extend(SSH_NONINTERACTIVE_ARGS.iter().map(|arg| (*arg).to_owned()));
    argv.extend([
        "-O".into(),
        "forward".into(),
        "-R".into(),
        format!("{remote_socket}:{local_socket}"),
        "--".into(),
        validate_ssh_destination(host)?.to_owned(),
    ]);
    Ok(argv)
}

fn first_300(text: &str) -> String {
    roamgate_agents::js::head16(roamgate_agents::js::trim(text), 300)
}

/// Installs the review client on the host unless this version is there and
/// clears a stale socket; gives the socket path the host's agents use.
pub async fn setup_remote_review_client<R, F>(
    sessions: &SshSessions,
    host: &str,
    connection_id: &str,
    run: &R,
) -> Result<String, String>
where
    R: Fn(SshCommand, Duration) -> F,
    F: Future<Output = RunOutput>,
{
    let setup = sessions
        .read_command_argv(host, &remote_setup_script(), &[], Some("review.setup"))
        .map_err(|_| "invalid SSH destination".to_owned())?
        .for_connection(connection_id);
    let setup = run(setup, SETUP_TIMEOUT).await;
    let remote_socket = setup.stdout.trim().to_owned();
    if setup.code != 0 || !remote_socket.starts_with('/') {
        let error = if setup.stderr.is_empty() {
            "review client setup failed"
        } else {
            &setup.stderr
        };
        return Err(first_300(error));
    }
    Ok(remote_socket)
}

/// Forwards the host's agent socket `remote_socket` to `local_socket` with
/// a reverse socket forward on the connection's master.
pub async fn forward_remote_review_socket<R, F>(
    host: &str,
    control_path: &str,
    remote_socket: &str,
    local_socket: &str,
    connection_id: &str,
    run: &R,
) -> Result<(), String>
where
    R: Fn(SshCommand, Duration) -> F,
    F: Future<Output = RunOutput>,
{
    let argv = remote_forward_argv(host, control_path, remote_socket, local_socket)
        .map_err(|_| "invalid SSH destination".to_owned())?;
    let forward = SshCommand::plain(argv).annotated(SshAnnotation {
        tag: Some("review.forward".into()),
        connection: Some(connection_id.into()),
        master: true,
    });
    let forward = run(forward, SETUP_TIMEOUT).await;
    if forward.code != 0 {
        let error = if forward.stderr.is_empty() {
            "the host refused the review socket forward"
        } else {
            &forward.stderr
        };
        return Err(first_300(error));
    }
    Ok(())
}

/// Makes `roamgate-review` work in the host's panes: installs the client and
/// forwards the host's well-known socket to this connection's agent socket.
/// Both ride the connection's SSH master. A host without python3 or one
/// whose sshd refuses socket forwards only loses the review client.
pub async fn setup_remote_review_agent<R, F>(
    sessions: &SshSessions,
    host: &str,
    control_path: &str,
    local_socket: &str,
    connection_id: &str,
    run: R,
) -> Result<String, String>
where
    R: Fn(SshCommand, Duration) -> F,
    F: Future<Output = RunOutput>,
{
    let remote_socket = setup_remote_review_client(sessions, host, connection_id, &run).await?;
    forward_remote_review_socket(
        host,
        control_path,
        &remote_socket,
        local_socket,
        connection_id,
        &run,
    )
    .await?;
    Ok(remote_socket)
}
