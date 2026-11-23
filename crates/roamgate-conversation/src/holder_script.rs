//! `roamgate-hold` and what is typed into a pane's shell to start it
//! (`holder-script.ts`). The holder runs in a pane while conversation mode
//! owns the pane's session: it keeps the shell from taking a second agent,
//! runs the session's headless agent as its own child, relays that child's
//! output through a log Roamgate reads from where it stopped and
//! Roamgate's input to its stdin, waits for Roamgate to hand the session
//! back (or for Enter, which asks it to), and then becomes the agent's TUI.

use std::sync::LazyLock;

use regex::Regex;
use roamgate_base::assets::ROAMGATE_HOLD_PY;
use sha2::{Digest, Sha256};

use crate::driver::TerminalDriver;
use crate::shared::CLAUDE_START_ENV;

/// The holder's script (contract/assets/python/roamgate-hold.py).
pub const HOLD_CLIENT_SCRIPT: &str = ROAMGATE_HOLD_PY;

/// The first 16 hex digits of the script's SHA-256.
pub static HOLD_CLIENT_CHECKSUM: LazyLock<String> = LazyLock::new(|| {
    let digest = Sha256::digest(HOLD_CLIENT_SCRIPT.as_bytes());
    hex::encode(digest)[..16].to_owned()
});

/// The script as installed: with its checksum line.
pub static HOLD_CLIENT_INSTALLED_SCRIPT: LazyLock<String> = LazyLock::new(|| {
    format!(
        "{HOLD_CLIENT_SCRIPT}# roamgate-hold {}\n",
        *HOLD_CLIENT_CHECKSUM
    )
});

static SESSION_ID: LazyLock<Regex> = LazyLock::new(|| Regex::new("^(?i)[0-9a-f-]{8,64}$").unwrap());
static TOKEN: LazyLock<Regex> = LazyLock::new(|| Regex::new("^[0-9a-f]{16,64}$").unwrap());
static PLAIN_WORD: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^[A-Za-z0-9_@%+=:,./-]+$").unwrap());

/// Why a typed command was not made.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ScriptError(pub String);

impl std::fmt::Display for ScriptError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for ScriptError {}

fn check_session_id(session_id: &str) -> Result<(), ScriptError> {
    if SESSION_ID.is_match(session_id) {
        Ok(())
    } else {
        Err(ScriptError("invalid session id".into()))
    }
}

/// A word every shell (sh, bash, zsh, fish) reads the same; None if none.
pub fn shell_word(value: &str) -> Option<String> {
    if PLAIN_WORD.is_match(value) {
        return Some(value.to_owned());
    }
    // Backslashes inside single quotes differ between fish and the others.
    if value.contains('\\') {
        return None;
    }
    Some(format!("'{}'", value.replace('\'', "'\\''")))
}

/// The holder's path and Roamgate's socket, given whole for a local pane
/// (the pane's $HOME need not be Roamgate's).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LocalHolder {
    pub bin: String,
    pub socket: String,
}

fn local_words(local: &LocalHolder) -> Result<(String, String), ScriptError> {
    match (shell_word(&local.bin), shell_word(&local.socket)) {
        (Some(bin), Some(socket)) => Ok((bin, socket)),
        _ => Err(ScriptError("unusual characters in the holder path".into())),
    }
}

/// What is typed into the pane's shell to start the holder. Over SSH (no
/// `local`) the host's own install is used.
pub fn holder_command(
    session_id: &str,
    local: Option<&LocalHolder>,
) -> Result<String, ScriptError> {
    check_session_id(session_id)?;
    // The leading space keeps it out of most shells' history.
    let Some(local) = local else {
        return Ok(format!(
            " \"$HOME/.cache/roamgate/bin/roamgate-hold\" {session_id}\r"
        ));
    };
    let (bin, socket) = local_words(local)?;
    Ok(format!(" {bin} {session_id} --socket {socket}\r"))
}

/// What is typed into the pane's shell to start a launch Roamgate prepared
/// (a profile's agent): roamgate-hold fetches the program and environment
/// with the token and becomes it.
pub fn launch_command(token: &str, local: Option<&LocalHolder>) -> Result<String, ScriptError> {
    if !TOKEN.is_match(token) {
        return Err(ScriptError("invalid token".into()));
    }
    let Some(local) = local else {
        return Ok(format!(
            " \"$HOME/.cache/roamgate/bin/roamgate-hold\" --launch {token}\r"
        ));
    };
    let (bin, socket) = local_words(local)?;
    Ok(format!(" {bin} --socket {socket} --launch {token}\r"))
}

/// What is typed into the pane's shell to resume the session in its TUI,
/// with the flags it ran with when every shell reads them the same way.
pub fn resume_command(
    session_id: &str,
    args: &[String],
    terminal: &dyn TerminalDriver,
) -> Result<String, ScriptError> {
    check_session_id(session_id)?;
    let words: Option<Vec<String>> = args.iter().map(|arg| shell_word(arg)).collect();
    let flags = words.unwrap_or_default();
    // env, not VAR=value: fish before 3.1 does not read the latter. The
    // agent resumed here stays in the terminal (CLAUDE_START_ENV).
    let mut parts = vec!["env".to_owned(), format!("{CLAUDE_START_ENV}=terminal")];
    parts.extend(terminal.resume_argv(session_id, &flags));
    Ok(format!(" {}\r", parts.join(" ")))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testing::claude_terminal;

    #[test]
    fn the_typed_command_checks_the_session_id() {
        assert_eq!(
            holder_command("11111111-aaaa-bbbb-cccc-000000000000", None).unwrap(),
            " \"$HOME/.cache/roamgate/bin/roamgate-hold\" 11111111-aaaa-bbbb-cccc-000000000000\r"
        );
        assert!(holder_command("x; rm -rf /", None).is_err());
        let local = LocalHolder {
            bin: "/Users/me/.cache/roamgate/bin/roamgate-hold".into(),
            socket: "/Users/me/My Files/review.sock".into(),
        };
        assert_eq!(
            holder_command("11111111-aaaa-bbbb-cccc-000000000000", Some(&local)).unwrap(),
            " /Users/me/.cache/roamgate/bin/roamgate-hold 11111111-aaaa-bbbb-cccc-000000000000 --socket '/Users/me/My Files/review.sock'\r"
        );
    }

    #[test]
    fn the_typed_resume_keeps_the_flags_every_shell_reads_alike() {
        let terminal = claude_terminal();
        let args = |items: &[&str]| {
            items
                .iter()
                .map(|item| item.to_string())
                .collect::<Vec<_>>()
        };
        assert_eq!(
            resume_command("abcdef12", &args(&["--model", "haiku"]), &terminal).unwrap(),
            " env ROAMGATE_CLAUDE_START=terminal claude --model haiku --resume abcdef12\r"
        );
        assert_eq!(
            resume_command(
                "abcdef12",
                &args(&["--append-system-prompt", "it's"]),
                &terminal
            )
            .unwrap(),
            " env ROAMGATE_CLAUDE_START=terminal claude --append-system-prompt 'it'\\''s' --resume abcdef12\r"
        );
        // A backslash reads differently in fish: no flags then.
        assert_eq!(
            resume_command("abcdef12", &args(&["--settings", "a\\b"]), &terminal).unwrap(),
            " env ROAMGATE_CLAUDE_START=terminal claude --resume abcdef12\r"
        );
        assert!(resume_command("$(x)", &[], &terminal).is_err());
    }

    #[test]
    fn launch_command_types_only_a_token() {
        let token = "0123456789abcdef0123456789abcdef";
        assert_eq!(
            launch_command(token, None).unwrap(),
            format!(" \"$HOME/.cache/roamgate/bin/roamgate-hold\" --launch {token}\r")
        );
        let local = LocalHolder {
            bin: "/h/bin/roamgate-hold".into(),
            socket: "/h/r.sock".into(),
        };
        assert_eq!(
            launch_command(token, Some(&local)).unwrap(),
            format!(" /h/bin/roamgate-hold --socket /h/r.sock --launch {token}\r")
        );
        assert!(launch_command("not a token; rm -rf ~", None).is_err());
    }

    #[test]
    fn the_checksum_is_the_scripts() {
        assert_eq!(HOLD_CLIENT_CHECKSUM.len(), 16);
        assert!(
            HOLD_CLIENT_INSTALLED_SCRIPT
                .ends_with(&format!("# roamgate-hold {}\n", *HOLD_CLIENT_CHECKSUM))
        );
    }
}
