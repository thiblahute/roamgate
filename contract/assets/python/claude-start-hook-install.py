import json, os, sys, tempfile

COMMAND = "~/.cache/roamgate/bin/roamgate-review claude-start"
MARK = "roamgate-review claude-start"


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
            handle.write("\n")
        os.chmod(temp, mode)
        os.replace(temp, path)
    except OSError:
        return "unwritable"
    return "installed"


print(main())
