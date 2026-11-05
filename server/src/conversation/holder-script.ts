import { createHash } from "node:crypto";
import { CLAUDE_START_ENV } from "../../../shared/agentChat";
import { claudeTerminalDriver } from "./drivers/claude-tui";
import type { TerminalDriver } from "./drivers/types";

/**
 * `roamgate-hold`: runs in a pane while Roamgate's conversation mode owns
 * the pane's Claude session. It keeps the shell from taking a second
 * `claude`, runs the session's headless claude as its own child (so an SSH
 * link that drops, or a Roamgate restart, does not kill it), relays that
 * child's output through a log Roamgate reads from where it stopped and
 * Roamgate's input to its stdin, waits for Roamgate to hand the session
 * back (or for Enter, which asks it to), and then, once its child is gone,
 * becomes `claude --resume <id>` in the session's directory. Python 3
 * standard library only, like roamgate-review, and it talks to the same
 * socket.
 */
export const HOLD_CLIENT_SCRIPT = `#!/usr/bin/env python3
"""roamgate-hold: hold a pane while Roamgate's conversation mode owns its session.

While it holds the pane it also runs the session's headless claude for
Roamgate, as its own child: everything claude says goes to a log on this
host, which Roamgate reads from where it stopped (an SSH link that drops or
a Roamgate restart loses nothing), and what Roamgate writes reaches claude's
stdin once, in order. Handing the session back ends that child first, then
becomes claude --resume: one process sequences both writers.

Installed by Roamgate and rewritten when Roamgate updates it.
"""

import glob
import http.client
import json
import os
import re
import select
import shutil
import signal
import socket
import subprocess
import sys
import threading
import time
import uuid

try:
    import termios
except ImportError:
    termios = None

SOCKET = os.environ.get(
    "ROAMGATE_REVIEW_SOCKET",
    os.path.join(os.path.expanduser("~"), ".cache", "roamgate", "review.sock"),
)
# Set on the claude this holder becomes: it stays in the terminal, whatever
# Roamgate's claude start setting says (its SessionStart hook steps aside).
START_ENV = "${CLAUDE_START_ENV}"
STATE_ROOT = os.path.join(os.path.expanduser("~"), ".cache", "roamgate", "headless")
NOTICE = "This session is in conversation mode; Enter takes it back here."
HINT = "Press Enter alone (nothing typed) to take the session back here."
# The most sent to Roamgate at once: whole lines, or a piece of a longer
# line (Roamgate puts the pieces together), so no line is too long to send.
CHUNK = 256 * 1024
STOP_WAIT = 30.0
# Enter again within this long ends the child when Roamgate cannot answer.
CONFIRM_S = 10.0
# Run beside each child: should this holder die without ending it (killed,
# crashed), it does. It reads a pipe only this holder writes: a byte means
# the child ended (nothing to do), the end of the pipe that the holder is
# gone.
GUARD = """
import os, signal, sys
for name in ("SIGHUP", "SIGINT", "SIGTERM"):
    signal.signal(getattr(signal, name), signal.SIG_IGN)
try:
    done = os.read(0, 1)
except OSError:
    done = b""
if not done:
    try:
        os.kill(int(sys.argv[1]), signal.SIGKILL)
    except OSError:
        pass
"""


class UnixConnection(http.client.HTTPConnection):
    def __init__(self, path, timeout):
        super().__init__("roamgate", timeout=timeout)
        self.unix_path = path

    def connect(self):
        sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        sock.settimeout(self.timeout)
        sock.connect(self.unix_path)
        self.sock = sock


def post(command, body, timeout):
    # Raises OSError when Roamgate cannot be reached at all.
    connection = UnixConnection(SOCKET, timeout)
    try:
        connection.request(
            "POST",
            "/v1/" + command,
            body=json.dumps(body),
            headers={"content-type": "application/json"},
        )
        response = connection.getresponse()
        data = response.read().decode("utf-8", "replace")
    except http.client.HTTPException as error:
        raise OSError(str(error))
    finally:
        connection.close()
    try:
        return response.status, json.loads(data)
    except ValueError:
        return response.status, {}


def utf8_prefix(data):
    # A piece of a long line, cut between characters (it is sent as text).
    for back in range(1, min(4, len(data)) + 1):
        lead = data[-back]
        if lead & 0xC0 == 0x80:
            continue
        size = 4 if lead >= 0xF0 else 3 if lead >= 0xE0 else 2 if lead >= 0xC0 else 1
        return data if back >= size else data[: len(data) - back]
    return data


def conversation_running(sessions):
    # Roamgate is gone: is a headless claude still on one of these sessions
    # here? After /clear its argv still names the session it resumed.
    try:
        out = subprocess.run(
            ["ps", "-eo", "pid=,args="], capture_output=True, text=True, timeout=10
        ).stdout
    except (OSError, subprocess.SubprocessError):
        return True
    for line in out.splitlines():
        if "stream-json" not in line:
            continue
        for session in sessions:
            if "--resume " + session in line or "--resume '" + session in line:
                return True
    return False


def transcript_exists(session, env, cwd):
    # Claude keeps a session under its project's folder once it has a
    # message; one started and left at once has none yet.
    base = env.get("CLAUDE_CONFIG_DIR") or os.path.join(
        os.path.expanduser("~"), ".claude"
    )
    projects = os.path.join(base, "projects")
    name = session + ".jsonl"
    here = re.sub(r"[^A-Za-z0-9]", "-", os.path.realpath(cwd or os.getcwd()))
    if os.path.exists(os.path.join(projects, here, name)):
        return True
    return bool(glob.glob(os.path.join(glob.escape(projects), "*", glob.escape(name))))


def new_or_resumed(argv, env, cwd):
    # --resume of a session with no transcript fails: it starts with that
    # id instead (claude started, then taken at once, before a message).
    if "--resume" not in argv:
        return argv
    at = argv.index("--resume")
    if at + 1 >= len(argv) or transcript_exists(argv[at + 1], env, cwd):
        return argv
    return argv[:at] + ["--session-id"] + argv[at + 1 :]


# The pane's Anthropic API key. Claude Code's TUI asks once whether to use
# it and files the answer in its global config by the key's last 20
# characters; claude -p uses it without asking. The headless claude keeps
# it only when that answer is yes. The key itself is never sent, written or
# shown: only the answer's state is reported.
API_KEY = "ANTHROPIC_API_KEY"
# How long another writer's lock on the config may stand before it counts as
# left behind (Claude Code's own: 10 s), and how long to wait for it.
CONFIG_LOCK_STALE_S = 10.0
CONFIG_LOCK_WAIT_S = 5.0


def claude_config_path(env):
    # Claude Code's global config: ~/.claude.json, or in $CLAUDE_CONFIG_DIR.
    base = env.get("CLAUDE_CONFIG_DIR") or os.path.expanduser("~")
    suffix = "-custom-oauth" if env.get("CLAUDE_CODE_CUSTOM_OAUTH_URL") else ""
    return os.path.join(base, ".claude" + suffix + ".json")


def api_key_suffix(env):
    # How Claude Code files its answer about a key; None without a key.
    key = (env.get(API_KEY) or "").strip()
    return key[-20:] if key else None


def answer_lists(config):
    responses = config.get("customApiKeyResponses") if isinstance(config, dict) else None
    if not isinstance(responses, dict):
        responses = {}
    lists = []
    for name in ("approved", "rejected"):
        value = responses.get(name)
        lists.append([each for each in value if isinstance(each, str)] if isinstance(value, list) else [])
    return lists


class ApiKeyAnswers:
    """What Claude Code answered about the pane's API key, read again when its config changes."""

    def __init__(self, env):
        self.env = env
        self.seen = None
        self.state = ""

    def get(self):
        # "" (no key), "approved", "rejected" or "new" (not answered yet).
        suffix = api_key_suffix(self.env)
        if suffix is None:
            return ""
        path = claude_config_path(self.env)
        try:
            info = os.stat(path)
            seen = (info.st_mtime_ns, info.st_size, info.st_ino)
        except OSError:
            seen = None
        if seen is not None and seen == self.seen:
            return self.state
        self.seen = seen
        approved, rejected = answer_lists(read_config(path))
        self.state = (
            "approved" if suffix in approved else "rejected" if suffix in rejected else "new"
        )
        return self.state


def read_config(path):
    # {} when there is none or it cannot be read.
    try:
        with open(path, encoding="utf-8") as handle:
            config = json.load(handle)
    except (OSError, ValueError):
        return {}
    return config if isinstance(config, dict) else {}


def lock_config(path):
    # Claude Code's own lock on its config: a directory beside it.
    lock = path + ".lock"
    deadline = time.time() + CONFIG_LOCK_WAIT_S
    while True:
        try:
            os.mkdir(lock)
            return lock
        except FileExistsError:
            try:
                if time.time() - os.stat(lock).st_mtime > CONFIG_LOCK_STALE_S:
                    os.rmdir(lock)
                    continue
            except OSError:
                pass
        except OSError:
            return None
        if time.time() >= deadline:
            return None
        time.sleep(0.05)


def record_api_key_answer(env, approve):
    """Files the user's answer as Claude Code does; True once it is there.

    Only the answer is added: the rest of the config stays as it is, and it
    is written whole or not at all. An answer there already (given in a
    terminal meanwhile) is left alone.
    """
    suffix = api_key_suffix(env)
    if suffix is None:
        return False
    path = claude_config_path(env)
    lock = lock_config(path)
    if lock is None:
        return False
    try:
        try:
            with open(path, encoding="utf-8") as handle:
                config = json.load(handle)
        except FileNotFoundError:
            config = {}
        except (OSError, ValueError):
            # Not ours to rewrite.
            return False
        if not isinstance(config, dict):
            return False
        approved, rejected = answer_lists(config)
        if suffix in approved or suffix in rejected:
            return True
        responses = config.get("customApiKeyResponses")
        responses = dict(responses) if isinstance(responses, dict) else {}
        name = "approved" if approve else "rejected"
        listed = responses.get(name)
        responses[name] = (list(listed) if isinstance(listed, list) else []) + [suffix]
        config["customApiKeyResponses"] = responses
        target = os.path.realpath(path)
        try:
            mode = os.stat(target).st_mode & 0o777
        except OSError:
            mode = 0o600
        temp = "%s.roamgate-%s" % (target, uuid.uuid4().hex)
        try:
            fd = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, mode)
            with os.fdopen(fd, "w", encoding="utf-8") as handle:
                json.dump(config, handle, indent=2, ensure_ascii=False)
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(temp, target)
        except OSError:
            try:
                os.unlink(temp)
            except OSError:
                pass
            return False
        return True
    finally:
        try:
            os.rmdir(lock)
        except OSError:
            pass


def say(text):
    sys.stdout.write("\\r\\n" + text + "\\r\\n")
    sys.stdout.flush()


def job_control():
    # Whether this holder can stop as a job of the pane's shell (the chat's
    # Ctrl+Z): an interactive shell with job control runs it as its own
    # process group, in the terminal's foreground.
    if termios is None or not hasattr(signal, "SIGTSTP"):
        return False
    try:
        fd = sys.stdin.fileno()
        group = os.getpgrp()
        return (
            os.isatty(fd)
            and group == os.getpid()
            and os.tcgetpgrp(fd) == group
            and os.getpgid(os.getppid()) != group
        )
    except (OSError, ValueError):
        return False


# This holder's arguments without --fg: what it runs again with after fg.
RELAUNCH = []


def stopped_job(spec, why=None):
    # Stops this holder as a job of the pane's shell: the shell's prompt is
    # back, no claude runs, and the session is saved (its transcript).
    # Brought back with fg, this holder starts again and asks Roamgate for
    # the session (which it keeps here meanwhile) in conversation mode.
    session = spec.get("session_id") or ""
    title = spec.get("title") or session
    if why:
        say(why)
        say("To leave it instead: kill this job, then claude --resume " + session)
    say("Suspended: claude (conversation: " + title + "). fg brings it back.")
    signal.signal(signal.SIGTSTP, signal.SIG_DFL)
    while True:
        os.kill(os.getpid(), signal.SIGTSTP)
        # Continued: by fg, in the foreground, or by bg (it stops again:
        # it only holds the pane from the foreground).
        try:
            if os.tcgetpgrp(sys.stdin.fileno()) == os.getpgrp():
                break
        except (OSError, ValueError):
            break
    keep = {
        name: spec[name]
        for name in ("session_id", "cwd", "title", "terminal_args")
        if spec.get(name)
    }
    os.execv(
        sys.executable,
        [sys.executable, os.path.realpath(sys.argv[0])]
        + RELAUNCH
        + ["--fg", json.dumps(keep)],
    )


def compact(value):
    return json.dumps(value, separators=(",", ":")).encode("utf-8")


def guard(pid):
    """Starts the guard of child pid; returns the pipe end that calls it off."""
    try:
        read_end, write_end = os.pipe()
    except OSError:
        return None
    try:
        subprocess.Popen(
            [sys.executable, "-c", GUARD, str(pid)],
            stdin=read_end,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            start_new_session=True,
        )
    except OSError:
        os.close(write_end)
        return None
    finally:
        os.close(read_end)
    return write_end


def release(write_end):
    # The child ended normally: its guard leaves.
    if write_end is None:
        return
    try:
        os.write(write_end, b"x")
    except OSError:
        pass
    try:
        os.close(write_end)
    except OSError:
        pass


def holder_alive(directory):
    try:
        with open(os.path.join(directory, "holder.pid")) as handle:
            pid = int(handle.read().strip() or "0")
    except (OSError, ValueError):
        # Not one of ours (an older holder's): left alone.
        return True
    if pid <= 0:
        return False
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except OSError:
        return True
    return True


def prune(root):
    # The logs of holders that died without cleaning up.
    try:
        names = os.listdir(root)
    except OSError:
        return
    for name in names:
        path = os.path.join(root, name)
        if os.path.isdir(path) and not holder_alive(path):
            shutil.rmtree(path, ignore_errors=True)


class Child:
    """The headless claude run for Roamgate, and the log of all it says.

    The log only grows while this holder runs: each child is framed by a
    start and an exit line, and each line written to its stdin is noted
    (with Roamgate's sequence number) just before it is written. It lives
    in a directory of this holder's own (another holder, on the same
    session or not, never touches it).
    """

    def __init__(self, root):
        self.lock = threading.Condition()
        self.id = uuid.uuid4().hex
        prune(root)
        directory = os.path.join(root, self.id)
        os.makedirs(directory, mode=0o700, exist_ok=True)
        with open(os.path.join(directory, "holder.pid"), "w") as handle:
            handle.write(str(os.getpid()))
        self.directory = directory
        self.path = os.path.join(directory, "out.jsonl")
        # Unbuffered: a write that fails leaves nothing half kept to repeat.
        self.log = open(self.path, "ab", buffering=0)
        self.writing = False
        self.size = 0
        self.epoch_offset = 0
        self.number = 0
        self.proc = None
        self.pid = 0
        self.guard = None
        self.stdin_open = False
        self.applied = 0
        # Where Roamgate wants the log from (None: it has not said).
        self.want = None
        self.closed = False
        self.api_key = ApiKeyAnswers(os.environ)

    # All below with self.lock held, unless said otherwise.

    def append(self, data):
        if not data.endswith(b"\\n"):
            data += b"\\n"
        # One line at a time, whole: another waits for the one being written.
        while self.writing:
            self.lock.wait(1.0)
        self.writing = True
        try:
            view = memoryview(data)
            while view:
                try:
                    written = self.log.write(view)
                except OSError:
                    # The disk is full, say: the rest waits here (and claude's
                    # output in its pipe) until it can be written. Nothing is
                    # lost, and the reader carries on after.
                    self.lock.wait(1.0)
                    continue
                view = view[written or 0 :]
        finally:
            self.writing = False
        self.size += len(data)
        self.lock.notify_all()

    def mark(self, value):
        self.append(compact(value))

    def status(self):
        return {
            "holder_id": self.id,
            "applied": self.applied,
            "child": self.number,
            "child_alive": 1 if self.proc is not None else 0,
            "child_pid": self.pid,
            "log_size": self.size,
            "epoch_offset": self.epoch_offset,
        }

    def start(self, command):
        if self.closed:
            return
        if self.proc is not None:
            self.mark(
                {
                    "type": "roamgate_child",
                    "event": "refused",
                    "reason": "a conversation process already runs",
                }
            )
            return
        argv = command.get("argv")
        if not isinstance(argv, list) or not argv or not all(
            isinstance(each, str) for each in argv
        ):
            self.mark({"type": "roamgate_child", "event": "refused", "reason": "no command"})
            return
        env = dict(os.environ)
        # The pane's names the headless claude keeps under other ones.
        for name, alias in (command.get("copy") or {}).items():
            if isinstance(name, str) and isinstance(alias, str) and name in env:
                env[alias] = env[name]
        drop = list(command.get("drop") or [])
        policy = command.get("api_key")
        if isinstance(policy, dict) and policy.get("policy") == "claude_config":
            answer = policy.get("answer")
            if answer in ("approve", "reject"):
                # The user's answer, from the chat: filed as the TUI files
                # it, and taken for this start even if it could not be.
                if not record_api_key_answer(env, answer == "approve"):
                    self.mark({"type": "roamgate_child", "event": "api_key_unsaved"})
                state = "approved" if answer == "approve" else "rejected"
                self.api_key.seen = None
            else:
                state = self.api_key.get()
            if state == "new":
                self.mark(
                    {
                        "type": "roamgate_child",
                        "event": "refused",
                        "reason": "the API key question is not answered yet",
                    }
                )
                return
            if state == "approved":
                drop = [name for name in drop if name != API_KEY]
            elif API_KEY not in drop:
                drop.append(API_KEY)
        prefixes = tuple(command.get("drop_prefixes") or [])
        for name in list(env):
            if name in drop or (prefixes and name.startswith(prefixes)):
                del env[name]
        # A profile's removals: after the API key policy, so a profile with
        # its own token never sends the pane's key.
        for name in command.get("unset") or []:
            env.pop(str(name), None)
        for name, value in (command.get("set") or {}).items():
            env[str(name)] = str(value)
        cwd = command.get("cwd") or os.getcwd()
        argv = new_or_resumed(argv, env, cwd)
        try:
            err = open(os.path.join(self.directory, "err.log"), "ab")
        except OSError:
            err = subprocess.DEVNULL
        try:
            proc = subprocess.Popen(
                argv,
                cwd=cwd,
                env=env,
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=err,
            )
        except OSError as error:
            self.mark(
                {
                    "type": "roamgate_child",
                    "event": "refused",
                    "reason": "claude did not start: " + str(error),
                }
            )
            return
        finally:
            if err is not subprocess.DEVNULL:
                err.close()
        self.number += 1
        self.epoch_offset = self.size
        self.mark(
            {"type": "roamgate_child", "event": "start", "child": self.number, "pid": proc.pid}
        )
        self.proc = proc
        self.pid = proc.pid
        self.guard = guard(proc.pid)
        self.stdin_open = True
        threading.Thread(
            target=self.read, args=(proc, self.number, self.guard), daemon=True
        ).start()

    def read(self, proc, number, guarded):
        # Without the lock: it is taken per line.
        try:
            for line in proc.stdout:
                if not line.strip():
                    continue
                with self.lock:
                    self.append(line)
        except Exception:
            # Its output cannot be read any more: it is ended, so that
            # Roamgate sees it exit instead of waiting on it for good.
            try:
                proc.kill()
            except OSError:
                pass
        code = proc.wait()
        release(guarded)
        with self.lock:
            self.mark({"type": "roamgate_child", "event": "exit", "child": number, "code": code})
            if self.proc is proc:
                self.proc = None
                self.pid = 0
                self.stdin_open = False

    def input(self, seq, command):
        """Notes the line; returns what to write to stdin (outside the lock)."""
        line = command.get("line")
        if (
            self.proc is None
            or not self.stdin_open
            or command.get("child") != self.number
            or not isinstance(line, str)
        ):
            self.mark(
                {
                    "type": "roamgate_input",
                    "seq": seq,
                    "child": command.get("child"),
                    "kind": command.get("kind") or "other",
                    "dropped": True,
                }
            )
            return None
        kind = command.get("kind") or "other"
        noted = {"type": "roamgate_input", "seq": seq, "child": self.number, "kind": kind}
        if command.get("request_id"):
            noted["request_id"] = command.get("request_id")
        self.mark(noted)
        data = line.encode("utf-8")
        return (self.proc, data if data.endswith(b"\\n") else data + b"\\n")

    def close_stdin(self):
        """Closes claude's stdin: it ends once it has answered."""
        proc = self.proc
        if proc is None or not self.stdin_open:
            return
        self.stdin_open = False
        try:
            proc.stdin.close()
        except OSError:
            pass

    def apply(self, commands):
        # Called by the polling thread only, so writes keep their order.
        if not isinstance(commands, list):
            return
        for command in sorted(
            (each for each in commands if isinstance(each, dict)),
            key=lambda each: each.get("seq") or 0,
        ):
            seq = command.get("seq")
            if not isinstance(seq, int):
                continue
            write = None
            with self.lock:
                if seq <= self.applied:
                    continue
                op = command.get("op")
                child = command.get("child")
                if op == "start":
                    self.start(command)
                elif op == "input":
                    write = self.input(seq, command)
                elif op == "end" and child == self.number:
                    self.close_stdin()
                elif op == "kill" and child == self.number and self.proc is not None:
                    try:
                        self.proc.kill()
                    except OSError:
                        pass
                self.applied = seq
            if write:
                proc, data = write
                try:
                    proc.stdin.write(data)
                    proc.stdin.flush()
                except (OSError, ValueError):
                    # It is exiting: its exit line says so.
                    pass

    def send_loop(self, pane):
        # Sends the log to Roamgate from where it asks, whole lines only.
        while True:
            with self.lock:
                while not self.closed and (self.want is None or self.want >= self.size):
                    self.lock.wait(1.0)
                if self.closed:
                    return
                start = self.want
                size = self.size
            try:
                with open(self.path, "rb") as log:
                    log.seek(start)
                    data = log.read(min(size - start, CHUNK))
                    if not data.endswith(b"\\n"):
                        cut = data.rfind(b"\\n")
                        if cut >= 0:
                            data = data[: cut + 1]
                        else:
                            data = utf8_prefix(data)
            except OSError:
                time.sleep(1.0)
                continue
            try:
                status, reply = post(
                    "hold_output",
                    {
                        "pane": pane,
                        "holder_id": self.id,
                        "offset": start,
                        "end": start + len(data),
                        "data": data.decode("utf-8", "replace"),
                    },
                    30,
                )
            except OSError:
                time.sleep(1.0)
                continue
            if status != 200:
                time.sleep(1.0)
                continue
            offset = reply.get("offset")
            with self.lock:
                self.want = offset if isinstance(offset, int) and offset >= 0 else None

    def end(self, wait):
        """Closes the child's stdin and waits for it, killing it if need be."""
        with self.lock:
            proc = self.proc
            self.close_stdin()
        if proc is None:
            return None
        try:
            proc.wait(timeout=wait)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.wait()
        return proc

    def stop(self):
        """Ends the child before claude resumes here: never both."""
        with self.lock:
            self.closed = True
            self.lock.notify_all()
        if self.end(STOP_WAIT) is None:
            return
        # Its reader notes the exit; then nothing reads the log any more.
        deadline = time.time() + 2
        while time.time() < deadline:
            with self.lock:
                if self.proc is None:
                    break
            time.sleep(0.05)

    def alive(self):
        with self.lock:
            return self.proc is not None


def main():
    global SOCKET
    args = sys.argv[1:]
    if "--socket" in args:
        at = args.index("--socket")
        if at + 1 < len(args):
            SOCKET = args[at + 1]
        del args[at : at + 2]
    # Brought back with fg after stopping as a shell job: what it kept.
    fg_spec = None
    if "--fg" in args:
        at = args.index("--fg")
        if at + 1 < len(args):
            try:
                fg_spec = json.loads(args[at + 1])
            except ValueError:
                fg_spec = None
        del args[at : at + 2]
        if not isinstance(fg_spec, dict):
            fg_spec = None
    RELAUNCH[:] = [each for each in sys.argv[1:]]
    if "--fg" in RELAUNCH:
        at = RELAUNCH.index("--fg")
        del RELAUNCH[at : at + 2]
    if args[:1] == ["--launch"]:
        pane = os.environ.get("HERDR_PANE_ID", "")
        if not pane or len(args) < 2:
            print("roamgate-hold --launch runs in a Herdr pane, given a token", file=sys.stderr)
            sys.exit(2)
        launch(args[1], pane)
        return
    session = args[0] if args else ""
    pane = os.environ.get("HERDR_PANE_ID", "")
    if not pane or not session or "/" in session or session.startswith("."):
        print("roamgate-hold runs in a Herdr pane, given a session id", file=sys.stderr)
        sys.exit(2)
    # Nothing typed here may reach the shell, or signal claude, while the
    # session is held.
    for name in ("SIGINT", "SIGTSTP", "SIGQUIT"):
        if hasattr(signal, name):
            signal.signal(getattr(signal, name), signal.SIG_IGN)
    saved_tty = None
    if termios is not None and sys.stdin.isatty():
        try:
            saved_tty = termios.tcgetattr(sys.stdin.fileno())
            quiet = termios.tcgetattr(sys.stdin.fileno())
            quiet[3] &= ~termios.ISIG
            termios.tcsetattr(sys.stdin.fileno(), termios.TCSANOW, quiet)
        except (termios.error, OSError):
            saved_tty = None
    child = Child(STATE_ROOT)

    def gone(signum, frame):
        # The pane closes: its claude goes with it. (No lock here: the
        # interrupted thread may hold it.)
        proc = child.proc
        if proc is not None:
            try:
                proc.kill()
            except OSError:
                pass
        # Nor does its log stay behind: the conversation in full.
        shutil.rmtree(child.directory, ignore_errors=True)
        os._exit(128 + signum)

    for name in ("SIGHUP", "SIGTERM"):
        if hasattr(signal, name):
            signal.signal(getattr(signal, name), gone)
    body = {
        "pane": pane,
        "workspace": os.environ.get("HERDR_WORKSPACE_ID", ""),
        "herdr_socket": os.environ.get("HERDR_SOCKET_PATH", ""),
        "cwd": os.path.realpath(os.getcwd()),
        "agent": "claude",
        "session": session,
        # Whether it can stop as a shell job, and how its job is named.
        "job_control": 1 if job_control() else 0,
        "holder_pid": os.getpid(),
        "job": session,
    }
    target = {}
    # Every session this pane held: a headless claude may name any of them.
    seen = [session]
    done = threading.Event()

    def resume(reply):
        if done.is_set():
            return
        target.update(reply)
        done.set()

    def poll():
        while not done.is_set():
            with child.lock:
                request = dict(body, **child.status())
            # Read outside the lock (the config may be large); only this
            # thread uses it.
            request["api_key"] = child.api_key.get()
            try:
                status, reply = post("hold", request, 60)
            except OSError:
                time.sleep(2)
                continue
            if status != 200:
                time.sleep(2)
                continue
            # Handed back, or stopped as a shell job (the chat's Ctrl+Z).
            if reply.get("action") in ("resume", "suspend"):
                resume(reply)
                return
            child.apply(reply.get("commands"))
            offset = reply.get("output_from")
            if isinstance(offset, int) and offset >= 0:
                with child.lock:
                    child.want = offset
                    child.lock.notify_all()
            if reply.get("session_id"):
                body["session"] = reply["session_id"]
                if reply["session_id"] not in seen:
                    seen.append(reply["session_id"])

    if fg_spec is not None:
        # Back from a stopped job: the session it kept, in conversation
        # mode again, or stopped again with the reason.
        if fg_spec.get("session_id"):
            body["session"] = fg_spec["session_id"]
            if fg_spec["session_id"] not in seen:
                seen.append(fg_spec["session_id"])
        if fg_spec.get("cwd"):
            body["cwd"] = fg_spec["cwd"]
        say("Bringing the conversation back...")
        request = dict(body, **child.status())
        request["terminal_args"] = json.dumps(fg_spec.get("terminal_args") or [])
        try:
            status, reply = post("fg", request, 60)
        except OSError as error:
            status, reply = 0, {"error": "Roamgate is unreachable: " + str(error)}
        if status != 200 or reply.get("action") != "hold":
            child.stop()
            shutil.rmtree(child.directory, ignore_errors=True)
            for name in ("SIGINT", "SIGQUIT", "SIGHUP", "SIGTERM"):
                if hasattr(signal, name):
                    signal.signal(getattr(signal, name), signal.SIG_DFL)
            if saved_tty is not None:
                try:
                    termios.tcsetattr(sys.stdin.fileno(), termios.TCSANOW, saved_tty)
                except (termios.error, OSError):
                    pass
            stopped_job(
                fg_spec,
                "Not brought back: "
                + (reply.get("reason") or reply.get("error") or "Roamgate said no"),
            )
    threading.Thread(target=poll, daemon=True).start()
    threading.Thread(target=child.send_loop, args=(pane,), daemon=True).start()
    say(NOTICE)
    # Until when another Enter ends this holder's child (Roamgate away).
    confirm_until = 0.0
    while not done.is_set():
        try:
            ready, _, _ = select.select([sys.stdin], [], [], 0.5)
        except (OSError, ValueError):
            ready = []
            time.sleep(0.5)
        if not ready or done.is_set():
            continue
        line = sys.stdin.readline()
        if line == "":
            # No terminal any more: wait for Roamgate alone.
            time.sleep(0.5)
            continue
        if line.strip():
            # Text that reached the pane (pasted, or sent to it) is not a
            # request to take the session back.
            say(HINT)
            continue
        say("Asking Roamgate to hand the session back...")
        try:
            status, reply = post("handback", body, 120)
        except OSError:
            status, reply = 0, {}
        if status == 200 and reply.get("action") == "resume":
            resume(reply)
        elif status == 200:
            say(reply.get("reason") or "Roamgate said no.")
            say(NOTICE)
        else:
            # Roamgate cannot answer for this pane (unreachable, or its
            # connection is not ready): this holder's own child, then the
            # host's processes, decide. Asked twice, so a process starting
            # just now shows up.
            if child.alive() and time.time() >= confirm_until:
                # It runs until handed back or stopped: Enter again ends it.
                confirm_until = time.time() + CONFIRM_S
                say(
                    (reply.get("error") or "Roamgate is unreachable")
                    + "; the conversation process still runs here, so not resuming."
                    + " Press Enter again within %d s to end it (what it is doing stops) and resume here."
                    % CONFIRM_S
                )
                continue
            if child.alive():
                say("Ending the conversation process here...")
                child.end(5.0)
            confirm_until = 0.0
            if conversation_running(seen) or (time.sleep(2) or conversation_running(seen)):
                say(
                    (reply.get("error") or "Roamgate is unreachable")
                    + "; a conversation process still runs, so not resuming."
                )
                say(NOTICE)
                continue
            resume({"session_id": body["session"], "cwd": body["cwd"]})
            break
    # The headless child ends before claude starts here.
    child.stop()
    shutil.rmtree(child.directory, ignore_errors=True)
    session = target.get("session_id") or body["session"]
    cwd = target.get("cwd") or body["cwd"]
    for name in ("SIGINT", "SIGTSTP", "SIGQUIT", "SIGHUP", "SIGTERM"):
        if hasattr(signal, name):
            signal.signal(getattr(signal, name), signal.SIG_DFL)
    if saved_tty is not None:
        try:
            termios.tcsetattr(sys.stdin.fileno(), termios.TCSANOW, saved_tty)
        except (termios.error, OSError):
            pass
    if target.get("action") == "suspend":
        # The chat's Ctrl+Z: a stopped job, not claude in the terminal.
        stopped_job(dict(target, session_id=session, cwd=cwd))
    try:
        os.chdir(cwd)
    except OSError:
        pass
    # The TUI's whole command line; a Roamgate from before drivers sends
    # claude's arguments alone.
    argv = target.get("argv")
    if (
        isinstance(argv, list)
        and argv
        and all(isinstance(each, str) and each for each in argv)
    ):
        program, args = argv[0], argv[1:]
    else:
        program = "claude"
        args = target.get("args")
        if not isinstance(args, list) or not all(isinstance(each, str) for each in args):
            args = ["--resume", session]
    # The session's profile: its environment, never typed or shown.
    apply_profile_env(target, os.environ)
    if os.path.basename(program) == "claude" or target.get("agent") == "claude":
        args = new_or_resumed(args, os.environ, os.getcwd())
    # Handed back: this agent stays in the terminal.
    os.environ[START_ENV] = "terminal"
    say("Resuming " + session + " in the terminal.")
    os.execvp(program, [program] + args)


def apply_profile_env(spec, env):
    for name in spec.get("unset") or []:
        if isinstance(name, str):
            env.pop(name, None)
    values = spec.get("env")
    if isinstance(values, dict):
        for name, value in values.items():
            if isinstance(name, str) and isinstance(value, str):
                env[name] = value


def launch(token, pane):
    # An agent start Roamgate prepared for this pane (a profile's program
    # and environment, fetched with a one-use token so nothing secret is
    # typed): become it.
    try:
        status, reply = post("launch", {"pane": pane, "token": token}, 30)
    except OSError as error:
        print("roamgate-hold: Roamgate is unreachable: " + str(error), file=sys.stderr)
        sys.exit(1)
    argv = reply.get("argv") if status == 200 else None
    if (
        not isinstance(argv, list)
        or not argv
        or not all(isinstance(each, str) and each for each in argv)
    ):
        print(
            "roamgate-hold: "
            + (reply.get("error") or "Roamgate has no such start (it expired?)"),
            file=sys.stderr,
        )
        sys.exit(1)
    apply_profile_env(reply, os.environ)
    program, args = argv[0], argv[1:]
    if reply.get("agent") == "claude":
        args = new_or_resumed(args, os.environ, os.getcwd())
    if reply.get("terminal"):
        os.environ[START_ENV] = "terminal"
    try:
        os.execvp(program, [program] + args)
    except OSError as error:
        print("roamgate-hold: " + program + " did not start: " + str(error), file=sys.stderr)
        sys.exit(127)


if __name__ == "__main__":
    main()
`;

export const HOLD_CLIENT_CHECKSUM = createHash("sha256")
  .update(HOLD_CLIENT_SCRIPT)
  .digest("hex")
  .slice(0, 16);

export const HOLD_CLIENT_INSTALLED_SCRIPT = `${HOLD_CLIENT_SCRIPT}# roamgate-hold ${HOLD_CLIENT_CHECKSUM}\n`;

function checkSessionId(sessionId: string) {
  if (!/^[0-9a-f-]{8,64}$/i.test(sessionId))
    throw new Error("invalid session id");
}

/** A word every shell (sh, bash, zsh, fish) reads the same; null if none. */
function shellWord(value: string): string | null {
  if (/^[\w@%+=:,./-]+$/.test(value)) return value;
  // Backslashes inside single quotes differ between fish and the others.
  if (value.includes("\\")) return null;
  return `'${value.replace(/'/g, "'\\''")}'`;
}

/**
 * What is typed into the pane's shell to start the holder. Locally the
 * holder's path and Roamgate's socket are given whole: the pane's $HOME
 * need not be Roamgate's. Over SSH the host's own install is used.
 */
export function holderCommand(
  sessionId: string,
  local?: { bin: string; socket: string },
): string {
  checkSessionId(sessionId);
  // The leading space keeps it out of most shells' history.
  if (!local)
    return ` "$HOME/.cache/roamgate/bin/roamgate-hold" ${sessionId}\r`;
  const bin = shellWord(local.bin);
  const socket = shellWord(local.socket);
  if (!bin || !socket) throw new Error("unusual characters in the holder path");
  return ` ${bin} ${sessionId} --socket ${socket}\r`;
}

/**
 * What is typed into the pane's shell to start a launch Roamgate prepared
 * (a profile's agent): roamgate-hold fetches the program and environment
 * with the token and becomes it. Paths as for holderCommand.
 */
export function launchCommand(
  token: string,
  local?: { bin: string; socket: string },
): string {
  if (!/^[0-9a-f]{16,64}$/.test(token)) throw new Error("invalid token");
  if (!local)
    return ` "$HOME/.cache/roamgate/bin/roamgate-hold" --launch ${token}\r`;
  const bin = shellWord(local.bin);
  const socket = shellWord(local.socket);
  if (!bin || !socket) throw new Error("unusual characters in the holder path");
  return ` ${bin} --socket ${socket} --launch ${token}\r`;
}

/**
 * What is typed into the pane's shell to resume the session in its TUI
 * (claude by default), with the flags it ran with when every shell reads
 * them the same way.
 */
export function resumeCommand(
  sessionId: string,
  args: string[] = [],
  terminal: TerminalDriver = claudeTerminalDriver,
): string {
  checkSessionId(sessionId);
  const words = args.map(shellWord);
  const flags = words.every((word) => word !== null) ? (words as string[]) : [];
  // env, not VAR=value: fish before 3.1 does not read the latter. The
  // agent resumed here stays in the terminal (see CLAUDE_START_ENV).
  return ` ${["env", `${CLAUDE_START_ENV}=terminal`, ...terminal.resumeArgv(sessionId, flags)].join(" ")}\r`;
}
