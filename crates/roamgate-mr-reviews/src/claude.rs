//! One Claude per review workspace, one Claude session per request
//! (`mr-reviews/claude.ts`): the workspace's first pane runs `claude` on
//! the session of the request the worktree is on. Switching request
//! resumes that request's session once the checkout is done; a Claude in
//! the middle of a turn is never stopped: the user waits for it or leaves
//! it on its request. A Claude the user started there by hand (a session
//! that is no request's) is never touched. Only the user's clicks start or
//! switch it; it reviews only when asked.
//!
//! Agent profiles are not ported to Rust yet: the session's profile
//! command ([`AgentCommand`], `commandForSession` of profiles.ts) comes
//! through an injected function, a reverse call to Bun in the core.

use std::future::Future;
use std::sync::LazyLock;

use regex::Regex;
use serde_json::Value;

use crate::connection::{LaunchSpec, MrConnection};

/// The claude start setting (`claude_start_mode`).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum StartMode {
    /// The claude start hook leaves it in the terminal.
    #[default]
    Terminal,
    /// Conversation mode's hook takes it, as any claude started by hand.
    Conversation,
}

impl StartMode {
    /// The setting's text; anything but `conversation` is the terminal.
    pub fn parse(text: &str) -> StartMode {
        if text == "conversation" {
            StartMode::Conversation
        } else {
            StartMode::Terminal
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            StartMode::Terminal => "terminal",
            StartMode::Conversation => "conversation",
        }
    }
}

/// A profile ready to start an agent with (`AgentCommand` of profiles.ts):
/// its program, the environment it sets and what it removes. `plain` is
/// the built-in Claude unchanged: started exactly as before profiles.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AgentCommand {
    pub profile: String,
    pub agent: String,
    pub program: String,
    pub env: Vec<(String, String)>,
    pub unset: Vec<String>,
    pub plain: bool,
    pub model: Option<String>,
}

impl AgentCommand {
    /// `PLAIN_CLAUDE`.
    pub fn plain_claude() -> AgentCommand {
        AgentCommand {
            profile: "Claude".into(),
            agent: "claude".into(),
            program: "claude".into(),
            env: vec![],
            unset: vec![],
            plain: true,
            model: None,
        }
    }

    /// The command as Bun answers it (a JSON `AgentCommand`).
    pub fn from_json(value: &Value) -> Option<AgentCommand> {
        let text = |name: &str| value.get(name).and_then(Value::as_str).map(str::to_owned);
        Some(AgentCommand {
            profile: text("profile")?,
            agent: text("agent")?,
            program: text("program")?,
            env: value
                .get("env")
                .and_then(Value::as_object)
                .map(|env| {
                    env.iter()
                        .filter_map(|(k, v)| Some((k.clone(), v.as_str()?.to_owned())))
                        .collect()
                })
                .unwrap_or_default(),
            unset: value
                .get("unset")
                .and_then(Value::as_array)
                .map(|names| {
                    names
                        .iter()
                        .filter_map(|n| n.as_str().map(str::to_owned))
                        .collect()
                })
                .unwrap_or_default(),
            plain: value.get("plain").and_then(Value::as_bool).unwrap_or(false),
            model: text("model"),
        })
    }
}

static SESSION_ID: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)^[0-9a-f-]{36}$").expect("pattern"));
static COMMAND: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^[A-Za-z0-9_./-]+$").expect("pattern"));

/// The test stand-in for `claude` (`ROAMGATE_MR_CLAUDE_COMMAND`), when set.
pub fn test_claude_command() -> Option<String> {
    std::env::var("ROAMGATE_MR_CLAUDE_COMMAND")
        .ok()
        .filter(|value| !value.is_empty())
}

/// The claude command typed into the pane's shell, kept in the terminal
/// (`claudeCommand`). `bin` None: the test stand-in, else `claude`.
pub fn claude_command(
    session: &str,
    resume: bool,
    mode: StartMode,
    bin: Option<&str>,
) -> Result<String, String> {
    let bin = bin
        .map(str::to_owned)
        .or_else(test_claude_command)
        .unwrap_or_else(|| "claude".into());
    if !SESSION_ID.is_match(session) {
        return Err("invalid session id".into());
    }
    if !COMMAND.is_match(&bin) {
        return Err("invalid claude command".into());
    }
    // A session never written to has nothing to resume: start it by its id.
    let run = if resume {
        format!("sh -c '{bin} --resume {session} || {bin} --session-id {session}'")
    } else {
        format!("{bin} --session-id {session}")
    };
    // env, not VAR=value (old fish); the leading space keeps it out of the
    // history. In terminal mode the claude start hook leaves it there; in
    // conversation mode the hook takes it, as any claude started by hand.
    Ok(match mode {
        StartMode::Terminal => format!(" env ROAMGATE_CLAUDE_START=terminal {run}\r"),
        StartMode::Conversation => format!(" {run}\r"),
    })
}

/// The session's profile when it is not plain claude (`profileLaunch`):
/// started through the pane's roamgate-hold, which fetches its environment
/// (never typed). A test's stand-in command keeps the typed one. `command`
/// is only asked when the connection can launch.
pub async fn profile_launch<F, Fut>(
    conn: &dyn MrConnection,
    pane_id: &str,
    session: &str,
    resume: bool,
    mode: StartMode,
    command: F,
) -> Result<Option<String>, String>
where
    F: FnOnce() -> Fut,
    Fut: Future<Output = Result<AgentCommand, String>>,
{
    if test_claude_command().is_some() || !conn.can_launch() {
        return Ok(None);
    }
    let profile = command().await?;
    if profile.plain {
        return Ok(None);
    }
    let spec = LaunchSpec {
        argv: vec![
            profile.program,
            if resume { "--resume" } else { "--session-id" }.into(),
            session.into(),
        ],
        env: profile.env,
        unset: profile.unset,
        agent: profile.agent,
        terminal: mode == StartMode::Terminal,
    };
    conn.launch(pane_id, spec).await.map(Some)
}

#[cfg(test)]
mod tests {
    use super::*;

    const ID: &str = "0b1c2d3e-0000-4000-8000-000000000001";

    #[test]
    fn the_command_stays_in_the_terminal_and_resumes_or_starts() {
        let typed = claude_command(ID, false, StartMode::Terminal, Some("claude")).unwrap();
        assert_eq!(
            typed,
            format!(" env ROAMGATE_CLAUDE_START=terminal claude --session-id {ID}\r")
        );
        let resumed = claude_command(ID, true, StartMode::Terminal, Some("claude")).unwrap();
        assert!(resumed.contains(&format!("claude --resume {ID} || claude --session-id {ID}")));
        assert!(claude_command("x; rm -rf ~", true, StartMode::Terminal, Some("claude")).is_err());
        assert!(claude_command(ID, true, StartMode::Terminal, Some("a b")).is_err());
    }

    #[test]
    fn the_claude_start_setting_decides_the_mode_claude_starts_in() {
        assert_eq!(
            claude_command(ID, false, StartMode::Conversation, Some("claude")).unwrap(),
            format!(" claude --session-id {ID}\r")
        );
        assert!(
            claude_command(ID, false, StartMode::Terminal, Some("claude"))
                .unwrap()
                .contains("ROAMGATE_CLAUDE_START=terminal")
        );
        assert_eq!(StartMode::parse("conversation"), StartMode::Conversation);
        assert_eq!(StartMode::parse("other"), StartMode::Terminal);
    }
}
