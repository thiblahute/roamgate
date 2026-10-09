import { existsSync, rmSync } from "node:fs";
import { type Logger, silentLogger } from "../utils/logger";
import { sshMasterArgv, sshMasterCheckArgv } from "./ssh-command";
import { annotateSshArgv, trackSshProcess } from "./ssh-metrics";
import { registerSshMaster, unregisterSshMaster } from "./ssh-sessions";

export type SshMasterProcess = {
  exited: Promise<number>;
  kill: (signal?: number) => void;
};

// Covers ConnectTimeout plus key exchange and authentication.
const MASTER_READY_TIMEOUT_MS = 20_000;
const MASTER_POLL_INTERVAL_MS = 100;
// A master that served commands and then died is restarted once after this
// delay; one that never became ready waits for the next tunnel start instead,
// so a host that refuses it is not retried in a loop.
const MASTER_RESTART_DELAY_MS = 10_000;

/**
 * Supervises the runtime's command master (connection B). It carries host
 * commands and uploads; the render/control tunnel stays on its own connection.
 * A master that is missing, starting, or dead only costs speed: commands then
 * open their own connection as before.
 */
export function createSshMaster(args: {
  destination: string;
  controlPath: string;
  connectionId?: string;
  logger?: Logger;
  dependencies?: {
    spawn?: (argv: string[]) => SshMasterProcess;
    exists?: (path: string) => boolean;
    remove?: (path: string) => void;
    runCheck?: (argv: string[]) => Promise<number>;
    readyTimeoutMs?: number;
    pollIntervalMs?: number;
    restartDelayMs?: number;
    stopTimeoutMs?: number;
    forceKillTimeoutMs?: number;
  };
}) {
  const logger = args.logger ?? silentLogger;
  const connection = args.connectionId ?? "legacy-default";
  const deps = args.dependencies ?? {};
  const exists = deps.exists ?? existsSync;
  const remove = deps.remove ?? ((path) => rmSync(path, { force: true }));
  const spawn =
    deps.spawn ??
    ((argv: string[]): SshMasterProcess => {
      const proc = Bun.spawn(argv, {
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
        env: { ...process.env, LC_ALL: "C" },
      });
      trackSshProcess(
        annotateSshArgv(argv, { tag: "master", connection }),
        proc.exited,
      );
      return { exited: proc.exited, kill: (signal) => proc.kill(signal) };
    });
  const runCheck =
    deps.runCheck ??
    ((argv: string[]) => {
      const proc = Bun.spawn(argv, {
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
        timeout: 5_000,
      });
      trackSshProcess(
        annotateSshArgv(argv, { tag: "master.check", connection }),
        proc.exited,
      );
      return proc.exited;
    });
  const readyTimeoutMs = deps.readyTimeoutMs ?? MASTER_READY_TIMEOUT_MS;
  const pollIntervalMs = deps.pollIntervalMs ?? MASTER_POLL_INTERVAL_MS;
  const restartDelayMs = deps.restartDelayMs ?? MASTER_RESTART_DELAY_MS;
  const stopTimeoutMs = deps.stopTimeoutMs ?? 1500;
  const forceKillTimeoutMs = deps.forceKillTimeoutMs ?? 1000;
  // The registry key: this runtime's master, distinct from any other runtime
  // that happens to reach the same destination.
  const owner = {};
  let proc: SshMasterProcess | null = null;
  let starting: Promise<boolean> | null = null;
  let restartTimer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  let stopTask: Promise<void> | null = null;

  async function isAlive(): Promise<boolean> {
    if (!proc || !exists(args.controlPath)) return false;
    const code = await runCheck(
      sshMasterCheckArgv(args.destination, args.controlPath),
    );
    return code === 0;
  }

  function delay(ms: number) {
    return new Promise<void>((resolve) => setTimeout(resolve, ms));
  }

  async function waitReady(child: SshMasterProcess): Promise<boolean> {
    let exited = false;
    void child.exited.then(
      () => {
        exited = true;
      },
      () => {
        exited = true;
      },
    );
    for (let waited = 0; ; waited += pollIntervalMs) {
      if (stopped || exited || proc !== child) return false;
      if (exists(args.controlPath)) return true;
      if (waited >= readyTimeoutMs) return false;
      await delay(pollIntervalMs);
    }
  }

  function onExit(child: SshMasterProcess, wasReady: () => boolean) {
    const exitedHandler = () => {
      if (proc !== child) return;
      proc = null;
      unregisterSshMaster(owner);
      if (stopped) return;
      logger.debug("SSH command master exited", { connection });
      if (!wasReady() || restartTimer) return;
      restartTimer = setTimeout(() => {
        restartTimer = null;
        void ensure();
      }, restartDelayMs);
    };
    void child.exited.then(exitedHandler, exitedHandler);
  }

  async function start(): Promise<boolean> {
    // A master that crashed leaves its socket behind; clients would log
    // connection-refused fallbacks against it until it is gone.
    remove(args.controlPath);
    let child: SshMasterProcess;
    try {
      child = spawn(sshMasterArgv(args.destination, args.controlPath));
    } catch (error) {
      logger.debug("SSH command master failed to start", {
        connection,
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
    proc = child;
    let ready = false;
    onExit(child, () => ready);
    ready = await waitReady(child);
    if (!ready || stopped || proc !== child) {
      if (proc === child) {
        proc = null;
        await stopProcess(child).catch(() => undefined);
      }
      logger.debug("SSH command master unavailable; using cold logins", {
        connection,
      });
      return false;
    }
    registerSshMaster(owner, {
      destination: args.destination,
      controlPath: args.controlPath,
      isListening: () => proc === child && exists(args.controlPath),
      isAlive,
    });
    logger.debug("SSH command master ready", { connection });
    return true;
  }

  /** Starts the master unless it is running; resolves whether it is ready. */
  function ensure(): Promise<boolean> {
    if (stopped) return Promise.resolve(false);
    if (starting) return starting;
    if (proc) return Promise.resolve(true);
    if (restartTimer) {
      clearTimeout(restartTimer);
      restartTimer = null;
    }
    const task = start().finally(() => {
      if (starting === task) starting = null;
    });
    starting = task;
    return task;
  }

  async function exitedWithin(
    child: SshMasterProcess,
    timeoutMs: number,
  ): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | null = null;
    try {
      return await Promise.race([
        child.exited.then(
          () => true,
          () => true,
        ),
        new Promise<false>((resolve) => {
          timer = setTimeout(() => resolve(false), timeoutMs);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async function stopProcess(child: SshMasterProcess): Promise<void> {
    try {
      child.kill();
    } catch {}
    if (await exitedWithin(child, stopTimeoutMs)) return;
    try {
      child.kill(9);
    } catch {}
    if (!(await exitedWithin(child, forceKillTimeoutMs))) {
      throw new Error(
        `SSH command master did not exit after forced termination connection=${connection}`,
      );
    }
  }

  /** Stops for good: in-flight mux sessions end and retry without it. */
  function stop(): Promise<void> {
    if (stopTask) return stopTask;
    stopped = true;
    if (restartTimer) {
      clearTimeout(restartTimer);
      restartTimer = null;
    }
    unregisterSshMaster(owner);
    const child = proc;
    proc = null;
    stopTask = (async () => {
      if (!child) return;
      await stopProcess(child);
      remove(args.controlPath);
    })();
    return stopTask;
  }

  return { ensure, stop, isRunning: () => proc !== null };
}

export type SshMaster = ReturnType<typeof createSshMaster>;
