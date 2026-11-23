//! The Claude Code SessionStart hook behind Roamgate's claude start
//! setting (`claude-start-hook.ts`): `roamgate-review claude-start` tells
//! Roamgate that a claude was started (or resumed) by hand in a Herdr
//! pane, and conversation mode takes it if the setting says so. Roamgate
//! adds the hook to the host's `~/.claude/settings.json` once the setting
//! is on for a connection to that host; the user's own hooks and settings
//! are kept as they are.

use base64::Engine;
use roamgate_base::assets::CLAUDE_START_HOOK_INSTALL_PY;

/// What the hook runs; also how Roamgate finds its own entry.
pub const CLAUDE_START_HOOK_COMMAND: &str = "~/.cache/roamgate/bin/roamgate-review claude-start";

/// Adds the hook to Claude's user settings unless it is there. Prints one
/// word: installed, present, no-claude, invalid or unwritable.
pub const CLAUDE_START_HOOK_INSTALL_SCRIPT: &str = CLAUDE_START_HOOK_INSTALL_PY;

/// The command that runs the script on a host: python3 decodes it.
pub fn claude_start_hook_install_argv() -> Vec<String> {
    vec![
        "python3".into(),
        "-c".into(),
        "import base64,sys;exec(base64.b64decode(sys.argv[1]).decode())".into(),
        base64::engine::general_purpose::STANDARD.encode(CLAUDE_START_HOOK_INSTALL_SCRIPT),
    ]
}

/// The same, as one shell command for an SSH host.
pub fn claude_start_hook_install_command() -> String {
    let argv = claude_start_hook_install_argv();
    format!("{} {} '{}' '{}'", argv[0], argv[1], argv[2], argv[3])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_installer_runs_from_one_command() {
        let command = claude_start_hook_install_command();
        assert!(command.starts_with("python3 -c 'import base64,sys;exec("));
        let argv = claude_start_hook_install_argv();
        let decoded = base64::engine::general_purpose::STANDARD
            .decode(&argv[3])
            .unwrap();
        assert_eq!(decoded, CLAUDE_START_HOOK_INSTALL_SCRIPT.as_bytes());
    }
}
