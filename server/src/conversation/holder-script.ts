import { createHash } from "node:crypto";

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

import http.client
import json
import os
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
STATE_ROOT = os.path.join(os.path.expanduser("~"), ".cache", "roamgate", "headless")
NOTICE = "This session is in conversation mode; Enter takes it back here."
HINT = "Press Enter alone (nothing typed) to take the session back here."
# The most sent to Roamgate at once (whole lines; a longer line goes alone).
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


def say(text):
    sys.stdout.write("\\r\\n" + text + "\\r\\n")
    sys.stdout.flush()


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
        self.log = open(self.path, "ab")
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

    # All below with self.lock held, unless said otherwise.

    def append(self, data):
        if not data.endswith(b"\\n"):
            data += b"\\n"
        self.log.write(data)
        self.log.flush()
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
        drop = command.get("drop") or []
        prefixes = tuple(command.get("drop_prefixes") or [])
        for name in list(env):
            if name in drop or (prefixes and name.startswith(prefixes)):
                del env[name]
        for name, value in (command.get("set") or {}).items():
            env[str(name)] = str(value)
        cwd = command.get("cwd") or os.getcwd()
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
        for line in proc.stdout:
            if not line.strip():
                continue
            with self.lock:
                self.append(line)
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
                            data += log.readline()
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
            try:
                status, reply = post("hold", request, 60)
            except OSError:
                time.sleep(2)
                continue
            if status != 200:
                time.sleep(2)
                continue
            if reply.get("action") == "resume":
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
    try:
        os.chdir(cwd)
    except OSError:
        pass
    args = target.get("args")
    if not isinstance(args, list) or not all(isinstance(each, str) for each in args):
        args = ["--resume", session]
    say("Resuming " + session + " in the terminal.")
    os.execvp("claude", ["claude"] + args)


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
 * What is typed into the pane's shell to resume the session in claude, with
 * the flags it ran with when every shell reads them the same way.
 */
export function resumeCommand(sessionId: string, args: string[] = []): string {
  checkSessionId(sessionId);
  const words = args.map(shellWord);
  const flags = words.every((word) => word !== null) ? words : [];
  return ` ${["claude", ...flags, "--resume", sessionId].join(" ")}\r`;
}
