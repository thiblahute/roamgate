import childProcess from "node:child_process";
import { userInfo } from "node:os";
import { holdSshSession, runInSshLane } from "../bridge/ssh-sessions";
import { sshCommandArgv } from "../bridge/ssh-command";
import { BASH_OUTPUT_LIMIT } from "../../../shared/bashMode";

/**
 * Runs a `!` line from a chat in conversation mode, as Claude Code's bash
 * mode would in the terminal: on the pane's host, in the session's
 * directory, with the user's login shell. It is the user's own command,
 * typed by them: nothing is asked or filtered.
 *
 * The shell runs in a job of its own under a small POSIX wrapper that ends
 * the whole job when its stdin closes: Stop closes it, and so does a
 * dropped SSH connection, so nothing is left running on the host.
 */
const WRAPPER = [
  "set -m",
  'cd -- "$1" || exit 126',
  'login="${3:-${SHELL:-/bin/sh}}"',
  // The wrapper's own job notices go nowhere; the command's stderr is fd 3.
  "exec 3>&2 2>/dev/null",
  '"$login" -l -c "$2" </dev/null 2>&3 3>&- &',
  "job=$!",
  '( cat >/dev/null; kill -TERM -"$job" || kill -TERM "$job" ) 2>/dev/null &',
  "watch=$!",
  'wait "$job"',
  "code=$?",
  'kill "$watch" 2>/dev/null',
  'exit "$code"',
].join("\n");

export type ShellOutput = {
  stdout: string;
  stderr: string;
  /** Output past the cap was dropped (only the first part is kept). */
  truncated: boolean;
};

export type ShellRun = {
  /** Resolves with the exit code once it ended; null when it was stopped. */
  done: Promise<{ code: number | null; stopped: boolean }>;
  stop(): void;
};

export type ShellRunner = (input: {
  cwd: string;
  command: string;
  onOutput: (output: ShellOutput) => void;
}) => ShellRun;

/** At most this much of each stream is kept, then the rest is counted out. */
const KEEP = BASH_OUTPUT_LIMIT + 4096;

/**
 * The argv of a run: a local shell, or the same wrapper over SSH (whose
 * remote side starts the user's own login shell from $SHELL).
 */
export function shellArgv(input: {
  sshHost?: string;
  cwd: string;
  command: string;
  shQuote: (value: string) => string;
  loginShell?: string;
}): string[] {
  if (input.sshHost)
    return sshCommandArgv(
      input.sshHost,
      `sh -c ${input.shQuote(WRAPPER)} sh ${input.shQuote(input.cwd)} ${input.shQuote(input.command)}`,
      [],
      "agent_chat.shell",
    );
  return [
    "/bin/sh",
    "-c",
    WRAPPER,
    "sh",
    input.cwd,
    input.command,
    input.loginShell ?? "",
  ];
}

/** The local login shell: the account's, not the server's environment's. */
export function localLoginShell(): string {
  try {
    const shell = userInfo().shell;
    if (shell) return shell;
  } catch {
    // No passwd entry: the environment's, then sh.
  }
  return process.env.SHELL || "/bin/sh";
}

/** Roamgate's own secrets and markers stay out of the user's commands. */
export function shellEnv(env: NodeJS.ProcessEnv = process.env) {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue;
    if (key.startsWith("ROAMGATE_") || key === "HERDR_PANE_ID") continue;
    result[key] = value;
  }
  return result;
}

export function createShellRunner(options: {
  sshHost?: string;
  shQuote: (value: string) => string;
  annotate?: (argv: string[]) => string[];
  /** Tests: another wrapper host, as a local one. */
  argv?: (cwd: string, command: string) => string[];
}): ShellRunner {
  return ({ cwd, command, onOutput }) => {
    let stopped = false;
    let child: ReturnType<typeof childProcess.spawn> | null = null;
    const output: ShellOutput = { stdout: "", stderr: "", truncated: false };
    const argv =
      options.argv?.(cwd, command) ??
      shellArgv({
        ...(options.sshHost ? { sshHost: options.sshHost } : {}),
        cwd,
        command,
        shQuote: options.shQuote,
        loginShell: localLoginShell(),
      });
    options.annotate?.(argv);
    const done = (async () => {
      let release = () => {};
      try {
        // The user waits on it: the interactive lane, never shed. It may
        // run for long: one of the master's few long-lived sessions, or a
        // connection of its own, never a short command's slot.
        const hold = await runInSshLane("interactive", () =>
          holdSshSession(argv, {}, { longLived: true }),
        );
        release = hold.release;
        if (stopped) return { code: null, stopped: true };
        const run = hold.argv;
        const proc = childProcess.spawn(run[0]!, run.slice(1), {
          stdio: ["pipe", "pipe", "pipe"],
          env: shellEnv(),
        });
        child = proc;
        const take = (stream: "stdout" | "stderr") => (chunk: Buffer) => {
          const room = KEEP - output[stream].length;
          if (room <= 0) {
            output.truncated = true;
            return;
          }
          const text = chunk.toString("utf8");
          if (text.length > room) output.truncated = true;
          output[stream] += text.slice(0, room);
          onOutput({ ...output });
        };
        proc.stdout!.on("data", take("stdout"));
        proc.stderr!.on("data", take("stderr"));
        // A stdin closed early (the wrapper failed) is not an error here.
        proc.stdin!.on("error", () => {});
        // Its watcher reads stdin until it closes: close it once the
        // wrapper is done, so its pipes close too.
        proc.on("exit", () => proc.stdin!.end());
        const code = await new Promise<number | null>((resolve, reject) => {
          proc.on("error", reject);
          proc.on("close", (exit) => resolve(exit));
        });
        return { code: stopped ? null : code, stopped };
      } finally {
        release();
      }
    })();
    return {
      done,
      stop() {
        if (stopped) return;
        stopped = true;
        // The wrapper ends the job when its stdin closes; ssh carries that
        // to the host.
        child?.stdin?.end();
        const proc = child;
        if (proc)
          setTimeout(() => {
            if (proc.exitCode === null && proc.signalCode === null)
              proc.kill("SIGTERM");
          }, 3000).unref?.();
      },
    };
  };
}
