import { createHash } from "node:crypto";

/**
 * The agent-side client, installed by the bridge as
 * `~/.cache/roamgate/bin/roamgate-review` on the bridge's machine and on each
 * SSH host. Python 3 standard library only, so a host needs nothing beyond the
 * interpreter it almost always has. It speaks JSON over the unix socket the
 * bridge listens on (forwarded over the connection's SSH master on a remote
 * host).
 */
export const REVIEW_CLIENT_SCRIPT = `#!/usr/bin/env python3
"""roamgate-review: talk to the Roamgate review pane.

Installed by Roamgate and rewritten when Roamgate updates it. Output is JSON.
"""

import argparse
import http.client
import json
import os
import socket
import sys

SOCKET = os.environ.get(
    "ROAMGATE_REVIEW_SOCKET",
    os.path.join(os.path.expanduser("~"), ".cache", "roamgate", "review.sock"),
)


class UnixConnection(http.client.HTTPConnection):
    def __init__(self, path, timeout):
        super().__init__("roamgate", timeout=timeout)
        self.unix_path = path

    def connect(self):
        sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        sock.settimeout(self.timeout)
        sock.connect(self.unix_path)
        self.sock = sock


def fail(message, code=2):
    print(json.dumps({"error": message}), file=sys.stderr)
    sys.exit(code)


def text_of(args):
    if args.text == ["-"]:
        return sys.stdin.read()
    return " ".join(args.text) if args.text else None


def default_agent():
    # Claude Code says so in its environment.
    return os.environ.get("ROAMGATE_REVIEW_AGENT") or (
        "Claude" if os.environ.get("CLAUDECODE") else "agent"
    )


def real_repo(value):
    # PATH, or PATH=BASE..HEAD: only the path is resolved.
    path, sep, rng = value.rpartition("=")
    if sep and path and ".." in rng:
        return os.path.realpath(path) + "=" + rng
    return os.path.realpath(value)


def common_options(target, default=None):
    target.add_argument(
        "--session",
        default=default,
        help="review to use (default: latest here)",
    )
    target.add_argument(
        "--agent",
        default=default or default_agent(),
        help="your name (default: $ROAMGATE_REVIEW_AGENT, Claude in Claude Code, else 'agent')",
    )


def parser():
    # --session and --agent work before or after the command; given after
    # it, they win, and unset they keep what was given before.
    common = argparse.ArgumentParser(add_help=False)
    common_options(common, argparse.SUPPRESS)
    p = argparse.ArgumentParser(
        prog="roamgate-review",
        description="Talk to the Roamgate review pane. Output is JSON.",
    )
    common_options(p)
    sub = p.add_subparsers(dest="command", required=True)
    real_add = sub.add_parser

    def add_parser(name, **kwargs):
        return real_add(name, parents=[common], **kwargs)

    sub.add_parser = add_parser

    o = sub.add_parser("open", help="open a review in Roamgate")
    target = o.add_mutually_exclusive_group()
    target.add_argument("--range", help="BASE..HEAD (default: default branch..HEAD)")
    target.add_argument("--worktree", action="store_true", help="uncommitted changes")
    target.add_argument("--mr", help="merge request URL")
    target.add_argument(
        "--compare",
        nargs=2,
        metavar=("OLD", "NEW"),
        help="only what changed from OLD to NEW (tree to tree), e.g. a branch before and after a force-push",
    )
    o.add_argument(
        "--repo",
        action="append",
        help="another repository worked on, PATH or PATH=BASE..HEAD (repeatable); same workspace",
    )
    o.add_argument("--title")
    o.add_argument("--message", help="shown when the review opens")

    sub.add_parser("skill", help="print the instructions for agents")
    sub.add_parser("list", help="reviews of this checkout")
    sub.add_parser("get", help="the review with all threads")

    a = sub.add_parser("add", help="start a thread")
    a.add_argument("--file")
    a.add_argument("--line", type=int)
    a.add_argument("--end-line", type=int)
    a.add_argument("--side", choices=["old", "new"])
    a.add_argument("--draft", action="store_true", help="a review comment, not a discussion")
    a.add_argument("text", nargs="*", help="text, or - for standard input")

    for name, helptext in (
        ("reply", "answer a thread"),
        ("edit", "rewrite one of your comments"),
    ):
        c = sub.add_parser(name, help=helptext)
        c.add_argument("--comment", required=True, help="comment or thread id (prefix ok)")
        c.add_argument("text", nargs="*", help="text, or - for standard input")

    d = sub.add_parser("delete", help="delete one of your comments")
    d.add_argument("--comment", required=True)

    r = sub.add_parser("resolve", help="resolve a thread")
    r.add_argument("--comment", required=True)
    r.add_argument("--unresolve", action="store_true")

    o2 = sub.add_parser("reopen", help="reopen a resolved thread")
    o2.add_argument("--comment", required=True)

    w = sub.add_parser("watch", help="wait for threads that need your answer or a handoff")
    w.add_argument("--any", action="store_true", help="wake on any change")
    w.add_argument("--timeout", type=int, default=1800, help="seconds (default 1800)")

    m = sub.add_parser("summary", help="the overall comment (kept only if the user has none)")
    m.add_argument("text", nargs="*", help="text, or - for standard input")

    k = sub.add_parser("working", help="say you are working on the review")
    k.add_argument("--comment", help="the thread you are working on (comment or thread id)")
    k.add_argument("--message", help="what you are doing, shown to the user")
    k.add_argument("--done", action="store_true")

    u = sub.add_parser("update", help="say what changed")
    u.add_argument("--message", required=True)

    n = sub.add_parser(
        "notify",
        help="tell the user they need to act: a notification, and this agent in their list of what needs them",
    )
    n.add_argument("--title", help="a few words (default: your agent and workspace)")
    n.add_argument("text", nargs="*", help="what the user needs to do, or - for standard input")

    q = sub.add_parser(
        "permission",
        help="Claude Code PermissionRequest hook: ask in Roamgate, else the terminal",
    )
    q.add_argument("--timeout", type=int, default=60, help="seconds to wait (default 60)")

    a = sub.add_parser(
        "questions",
        help="Claude Code PreToolUse hook for AskUserQuestion: answer in Roamgate, else the terminal",
    )
    a.add_argument("--timeout", type=int, default=180, help="seconds to wait (default 180)")
    return p


def ask(args, command, extra):
    # A hook's request to Roamgate: its reply, or None on any failure.
    pane = os.environ.get("HERDR_PANE_ID", "")
    if not pane or not os.path.exists(SOCKET):
        return None
    body = {
        "pane": pane,
        "workspace": os.environ.get("HERDR_WORKSPACE_ID", ""),
        "herdr_socket": os.environ.get("HERDR_SOCKET_PATH", ""),
        "cwd": os.path.realpath(os.getcwd()),
        "agent": args.agent,
        "timeout": str(args.timeout),
    }
    body.update(extra)
    connection = UnixConnection(SOCKET, args.timeout + 30)
    try:
        connection.request(
            "POST",
            "/v1/" + command,
            body=json.dumps(body),
            headers={"content-type": "application/json"},
        )
        response = connection.getresponse()
        return json.loads(response.read().decode("utf-8", "replace"))
    except (OSError, ValueError, http.client.HTTPException):
        return None


def headless():
    # Roamgate's conversation mode runs this claude and asks the user itself
    # (over stdio): its hooks must not ask a second time.
    return os.environ.get("ROAMGATE_HEADLESS") == "1"


def questions(args):
    # A PreToolUse hook on AskUserQuestion: Claude Code shows its own
    # questions only if this prints nothing.
    if headless():
        return
    try:
        hook = json.load(sys.stdin)
    except ValueError:
        return
    tool_input = hook.get("tool_input") or {}
    asked = tool_input.get("questions") or []
    if not asked:
        return
    reply = ask(args, "questions", {"questions": json.dumps(asked)})
    answers = (reply or {}).get("answers")
    if not answers:
        return
    print(
        json.dumps(
            {
                "hookSpecificOutput": {
                    "hookEventName": "PreToolUse",
                    "permissionDecision": "allow",
                    "updatedInput": dict(tool_input, answers=answers),
                }
            }
        )
    )


def permission(args):
    # A PermissionRequest hook: Claude Code waits on it before its own
    # dialog. Any failure, or no answer in time, prints nothing: the
    # terminal asks as usual.
    if headless():
        return
    pane = os.environ.get("HERDR_PANE_ID", "")
    if not pane or not os.path.exists(SOCKET):
        return
    try:
        hook = json.load(sys.stdin)
    except ValueError:
        return
    # Claude's questions have their own hook (questions); a permission card
    # could only allow them unanswered.
    if hook.get("tool_name") == "AskUserQuestion":
        return
    suggestions = hook.get("permission_suggestions") or []
    body = {
        "pane": pane,
        "workspace": os.environ.get("HERDR_WORKSPACE_ID", ""),
        "herdr_socket": os.environ.get("HERDR_SOCKET_PATH", ""),
        "cwd": os.path.realpath(os.getcwd()),
        "agent": args.agent,
        "tool": hook.get("tool_name") or "tool",
        "input": json.dumps(hook.get("tool_input")),
        "can_always": "1" if suggestions else "",
        "timeout": str(args.timeout),
    }
    connection = UnixConnection(SOCKET, args.timeout + 30)
    try:
        connection.request(
            "POST",
            "/v1/permission",
            body=json.dumps(body),
            headers={"content-type": "application/json"},
        )
        response = connection.getresponse()
        answer = json.loads(response.read().decode("utf-8", "replace")).get("answer")
    except (OSError, ValueError, http.client.HTTPException):
        return
    if answer == "deny":
        decision = {"behavior": "deny", "message": "Denied from Roamgate"}
    elif answer == "always":
        decision = {"behavior": "allow", "updatedPermissions": suggestions}
    elif answer == "allow":
        decision = {"behavior": "allow"}
    else:
        return
    print(
        json.dumps(
            {
                "hookSpecificOutput": {
                    "hookEventName": "PermissionRequest",
                    "decision": decision,
                }
            }
        )
    )


def main():
    args = parser().parse_args()
    if args.command == "permission":
        permission(args)
        return
    if args.command == "questions":
        questions(args)
        return
    if not os.path.exists(SOCKET):
        fail("Roamgate review socket not found: " + SOCKET)
    body = {
        "pane": os.environ.get("HERDR_PANE_ID", ""),
        "workspace": os.environ.get("HERDR_WORKSPACE_ID", ""),
        "herdr_socket": os.environ.get("HERDR_SOCKET_PATH", ""),
        "cwd": os.path.realpath(os.getcwd()),
        "agent": args.agent,
    }
    if args.session:
        body["session"] = args.session
    if getattr(args, "compare", None):
        args.compare = "..".join(args.compare)
    for key, value in vars(args).items():
        if key in ("session", "agent", "command", "text") or value in (None, False):
            continue
        if isinstance(value, list):
            value = "\\n".join(real_repo(v) for v in value)
        body[key.replace("-", "_")] = "1" if value is True else value
    if "text" in vars(args):
        text = text_of(args)
        if text is not None:
            body["text"] = text
    timeout = 60
    if args.command == "watch":
        body["mode"] = "any" if args.any else "unanswered"
        body.pop("any", None)
        timeout = args.timeout + 30
    connection = UnixConnection(SOCKET, timeout)
    try:
        connection.request(
            "POST",
            "/v1/" + args.command,
            body=json.dumps(body),
            headers={"content-type": "application/json"},
        )
        response = connection.getresponse()
        data = response.read().decode("utf-8", "replace")
    except (OSError, http.client.HTTPException) as error:
        fail("cannot reach Roamgate: " + str(error), 1)
    if response.status >= 400:
        print(data, file=sys.stderr)
        sys.exit(1)
    if args.command == "skill":
        print(json.loads(data)["skill"], end="")
        return
    print(data)


if __name__ == "__main__":
    main()
`;

export const REVIEW_CLIENT_CHECKSUM = createHash("sha256")
  .update(REVIEW_CLIENT_SCRIPT)
  .digest("hex")
  .slice(0, 16);
