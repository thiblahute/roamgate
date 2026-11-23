import { CLAUDE_START_HOOK_INSTALL_PY } from "../assets";
/**
 * The Claude Code SessionStart hook behind Roamgate's claude start setting:
 * `roamgate-review claude-start` tells Roamgate that a claude was started
 * (or resumed) by hand in a Herdr pane, and conversation mode takes it if
 * the setting says so. Roamgate adds the hook to the host's
 * `~/.claude/settings.json` once the setting is on for a connection to
 * that host; it is left there after (it does nothing while the setting
 * says terminal). The user's own hooks and settings are kept as they are.
 */

/** What the hook runs; also how Roamgate finds its own entry. */
export const CLAUDE_START_HOOK_COMMAND =
  "~/.cache/roamgate/bin/roamgate-review claude-start";

/**
 * Adds the hook to Claude's user settings unless it is there. Prints one
 * word: installed, present, no-claude (no Claude config on the host),
 * invalid (settings Roamgate cannot read as a JSON object: left alone) or
 * unwritable. Python 3 standard library only, like the clients.
 */
export const CLAUDE_START_HOOK_INSTALL_SCRIPT = CLAUDE_START_HOOK_INSTALL_PY;

/** The command that runs the script on a host: python3 decodes it. */
export function claudeStartHookInstallArgv(): string[] {
  return [
    "python3",
    "-c",
    "import base64,sys;exec(base64.b64decode(sys.argv[1]).decode())",
    Buffer.from(CLAUDE_START_HOOK_INSTALL_SCRIPT).toString("base64"),
  ];
}

/** The same, as one shell command for an SSH host. */
export function claudeStartHookInstallCommand(): string {
  const [python, flag, code, encoded] = claudeStartHookInstallArgv();
  return `${python} ${flag} '${code}' '${encoded}'`;
}
