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

const MARK = "roamgate-review claude-start";

/**
 * Adds the hook to Claude's user settings unless it is there. Prints one
 * word: installed, present, no-claude (no Claude config on the host),
 * invalid (settings Roamgate cannot read as a JSON object: left alone) or
 * unwritable. Python 3 standard library only, like the clients.
 */
export const CLAUDE_START_HOOK_INSTALL_SCRIPT = `import json, os, sys, tempfile

COMMAND = ${JSON.stringify(CLAUDE_START_HOOK_COMMAND)}
MARK = ${JSON.stringify(MARK)}


def main():
    base = os.environ.get("CLAUDE_CONFIG_DIR") or os.path.join(
        os.path.expanduser("~"), ".claude"
    )
    if not os.path.isdir(base):
        return "no-claude"
    path = os.path.join(base, "settings.json")
    try:
        with open(path, encoding="utf-8") as handle:
            text = handle.read()
        mode = os.stat(path).st_mode & 0o777
    except FileNotFoundError:
        text, mode = "", 0o600
    except OSError:
        return "invalid"
    try:
        settings = json.loads(text) if text.strip() else {}
    except ValueError:
        return "invalid"
    if not isinstance(settings, dict):
        return "invalid"
    hooks = settings.setdefault("hooks", {})
    if not isinstance(hooks, dict):
        return "invalid"
    groups = hooks.setdefault("SessionStart", [])
    if not isinstance(groups, list):
        return "invalid"
    for group in groups:
        for hook in (group.get("hooks") or []) if isinstance(group, dict) else []:
            if isinstance(hook, dict) and MARK in str(hook.get("command") or ""):
                return "present"
    groups.append(
        {
            "matcher": "startup|resume",
            "hooks": [{"type": "command", "command": COMMAND, "timeout": 10}],
        }
    )
    try:
        fd, temp = tempfile.mkstemp(prefix=".settings.", dir=base)
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(settings, handle, indent=2)
            handle.write("\\n")
        os.chmod(temp, mode)
        os.replace(temp, path)
    except OSError:
        return "unwritable"
    return "installed"


print(main())
`;

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
