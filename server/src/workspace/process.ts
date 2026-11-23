import { trackSshProcess } from "../bridge/ssh-metrics";
import { holdSshSession, runSshCommand } from "../bridge/ssh-sessions";
import { spawnOffLoop, threadText } from "../utils/spawn-thread";

export async function runBinaryProcessWithTimeout(
  argv: string[],
  timeoutMs: number,
) {
  return runSshCommand(
    argv,
    (argv, remainingMs) =>
      spawnBinaryWithTimeout(argv, remainingMs ?? timeoutMs),
    { timeoutMs },
    { binary: true },
  );
}

async function spawnBinaryWithTimeout(argv: string[], timeoutMs: number) {
  const proc = spawnOffLoop(argv, {
    env: { ...process.env, COPYFILE_DISABLE: "1" },
  });
  const stderrText = threadText(proc.stderr);
  trackSshProcess(argv, proc.exited, stderrText);
  let timer: ReturnType<typeof setTimeout> | null = null;
  const output = Promise.all([proc.exited, proc.stdout, stderrText]).then(
    ([code, stdout, stderr]) => {
      if (timer) clearTimeout(timer);
      return {
        code,
        stdout: Buffer.from(stdout.buffer, stdout.byteOffset, stdout.length),
        stderr,
      };
    },
  );
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      try {
        proc.kill();
      } catch {}
      reject(new Error(`${argv[0]} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });
  return Promise.race([output, timeout]);
}

export async function runProcessWithInputTimeout(
  argv: string[],
  input: Buffer | string,
  timeoutMs: number,
) {
  return runSshCommand(
    argv,
    (argv, remainingMs) =>
      spawnWithInputTimeout(argv, input, remainingMs ?? timeoutMs),
    { timeoutMs },
    { input },
  );
}

async function spawnWithInputTimeout(
  argv: string[],
  input: Buffer | string,
  timeoutMs: number,
) {
  const proc = spawnOffLoop(argv, {
    env: { ...process.env, COPYFILE_DISABLE: "1" },
    stdin: input,
  });
  const stderrText = threadText(proc.stderr);
  trackSshProcess(argv, proc.exited, stderrText);
  let timer: ReturnType<typeof setTimeout> | null = null;
  const output = Promise.all([
    proc.exited,
    threadText(proc.stdout),
    stderrText,
  ]).then(([code, stdout, stderr]) => {
    if (timer) clearTimeout(timer);
    return { code, stdout, stderr };
  });
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      try {
        proc.kill();
      } catch {}
      reject(new Error(`${argv[0]} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });
  return Promise.race([output, timeout]);
}

/**
 * Starts a command whose output is read as it comes (a file sent whole),
 * with no deadline: over SSH it takes one of the master's long-lived
 * sessions when one is free, else a connection of its own, and gives it
 * back when the command ends.
 */
export async function spawnStreamingProcess(argv: string[]) {
  const hold = await holdSshSession(argv, {}, { longLived: true });
  let proc: ReturnType<typeof Bun.spawn<"ignore", "pipe", "pipe">>;
  try {
    proc = Bun.spawn(hold.argv, {
      env: { ...process.env, COPYFILE_DISABLE: "1" },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
  } catch (error) {
    hold.release();
    throw error;
  }
  const stderr = new Response(proc.stderr).text();
  trackSshProcess(hold.argv, proc.exited, stderr);
  void proc.exited.finally(hold.release);
  return {
    stdout: proc.stdout,
    exited: proc.exited,
    stderr,
    kill: () => {
      try {
        proc.kill();
      } catch {}
    },
  };
}
