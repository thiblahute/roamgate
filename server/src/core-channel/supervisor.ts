/**
 * Runs the core (contract/wire/core-channel.md, "Process"): listens on the
 * channel's socket, spawns `<bin> core`, checks its `hello`, keeps it alive
 * and spawns it again with a growing delay when it goes. While there is no
 * core, `channel()` is null and the front serves everything.
 */
import { randomBytes, timingSafeEqual } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  Channel,
  type ChannelHandlers,
  type Message,
  REAL_TIMERS,
  type Timers,
} from "./channel";
import { PROTOCOL } from "./protocol";

export const HELLO_TIMEOUT_MS = 10_000;
export const PING_AFTER_MS = 10_000;
export const DEAD_AFTER_MS = 30_000;
export const STOP_GRACE_MS = 3000;
export const BACKOFF_FIRST_MS = 1000;
export const BACKOFF_MAX_MS = 5 * 60_000;
/** A core up this long has its next restart delay start again at 1 s. */
export const BACKOFF_RESET_AFTER_MS = 10 * 60_000;
/** Longer Unix socket paths go to a temporary directory instead. */
export const MAX_SOCKET_PATH = 100;

export type CoreProcess = {
  pid: number | undefined;
  exited: Promise<number | null>;
  kill: (signal?: NodeJS.Signals | number) => void;
};

export type SpawnCore = (
  argv: string[],
  env: Record<string, string | undefined>,
) => CoreProcess;

/** What the core said in its `hello`. */
export type CoreHello = {
  version: string;
  pid: number | null;
  families: string[];
  side: string;
  test: boolean;
};

export type SupervisorOptions = {
  bin: string;
  /** `<data>/runtime`. */
  runtimeDir: string;
  /** The core's environment, before the channel's variables. */
  env: Record<string, string | undefined>;
  /** The `welcome`'s owners and shadow settings, current. */
  welcome: () => Record<string, unknown>;
  /** The channel's reverse calls and pushes. */
  handlers: Pick<ChannelHandlers, "reverseCall" | "push">;
  onConnect?: (channel: Channel, hello: CoreHello) => void;
  onDisconnect?: () => void;
  log: (level: "debug" | "info" | "warn", message: string) => void;
  spawn?: SpawnCore;
  timers?: Timers;
  pid?: number;
  platform?: NodeJS.Platform;
};

function defaultSpawn(
  argv: string[],
  env: Record<string, string | undefined>,
): CoreProcess {
  const child = Bun.spawn(argv, {
    env,
    stdin: "ignore",
    stdout: "inherit",
    stderr: "inherit",
  });
  return {
    pid: child.pid,
    exited: child.exited.then((code) => code ?? null),
    kill: (signal) => child.kill(signal),
  };
}

/** Where the channel listens (see the contract's "Process"). */
export function channelPath(
  runtimeDir: string,
  pid: number,
  platform: NodeJS.Platform = process.platform,
): { path: string; tempDir: string | null } {
  if (platform === "win32")
    return {
      path: `\\\\.\\pipe\\roamgate-core-${pid}-${randomBytes(8).toString("hex")}`,
      tempDir: null,
    };
  const path = join(runtimeDir, `core-${pid}.sock`);
  if (Buffer.byteLength(path) <= MAX_SOCKET_PATH)
    return { path, tempDir: null };
  const tempDir = mkdtempSync(join(tmpdir(), "roamgate-core-"));
  chmodSync(tempDir, 0o700);
  return { path: join(tempDir, "core.sock"), tempDir };
}

/** Removes the `core-<pid>.sock` of processes that no longer run. */
export function removeStaleSockets(runtimeDir: string, ownPid: number): void {
  let names: string[];
  try {
    names = readdirSync(runtimeDir);
  } catch {
    return;
  }
  for (const name of names) {
    const match = /^core-(\d+)\.sock$/.exec(name);
    if (!match) continue;
    const pid = Number(match[1]);
    if (pid === ownPid) continue;
    try {
      process.kill(pid, 0);
      continue;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") continue;
    }
    rmSync(join(runtimeDir, name), { force: true });
  }
}

function sameToken(given: unknown, token: string): boolean {
  if (typeof given !== "string") return false;
  const a = Buffer.from(given);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

export class CoreSupervisor {
  private readonly timers: Timers;
  private readonly pid: number;
  private readonly spawnCore: SpawnCore;
  private server: Server | null = null;
  private path = "";
  private tempDir: string | null = null;
  private token = "";
  private child: CoreProcess | null = null;
  private childStartedAt = 0;
  private active: Channel | null = null;
  private connected: Channel | null = null;
  private hello: CoreHello | null = null;
  private helloTimer: unknown = null;
  private restartTimer: unknown = null;
  private delay = BACKOFF_FIRST_MS;
  private stopping = false;
  private refusedReason: string | null = null;

  constructor(private readonly options: SupervisorOptions) {
    this.timers = options.timers ?? REAL_TIMERS;
    this.pid = options.pid ?? process.pid;
    this.spawnCore = options.spawn ?? defaultSpawn;
  }

  /** The welcomed channel, or null while there is no core. */
  channel(): Channel | null {
    return this.connected;
  }

  coreHello(): CoreHello | null {
    return this.connected ? this.hello : null;
  }

  /** Where it listens (tests). */
  socketPath(): string {
    return this.path;
  }

  async start(): Promise<void> {
    const platform = this.options.platform ?? process.platform;
    mkdirSync(this.options.runtimeDir, { recursive: true, mode: 0o700 });
    if (platform !== "win32") {
      chmodSync(this.options.runtimeDir, 0o700);
      removeStaleSockets(this.options.runtimeDir, this.pid);
    }
    const where = channelPath(this.options.runtimeDir, this.pid, platform);
    this.path = where.path;
    this.tempDir = where.tempDir;
    if (platform !== "win32") rmSync(this.path, { force: true });
    this.server = createServer((socket) => this.accept(socket));
    await new Promise<void>((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(this.path, () => {
        this.server!.off("error", reject);
        resolve();
      });
    });
    this.server.on("error", (error) =>
      this.options.log("warn", `channel listener failed: ${error.message}`),
    );
    if (platform !== "win32") chmodSync(this.path, 0o600);
    this.spawn();
  }

  /** Says `bye`, waits up to 3 s for the core to end, then kills it. */
  async stop(): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    if (this.restartTimer) this.timers.clearTimeout(this.restartTimer);
    this.clearHelloTimer();
    this.active?.close();
    const child = this.child;
    if (child) {
      let late: unknown = null;
      await Promise.race([
        child.exited,
        new Promise<void>((resolve) => {
          late = this.timers.setTimeout(() => {
            try {
              child.kill("SIGKILL");
            } catch {}
            resolve();
          }, STOP_GRACE_MS);
        }),
      ]);
      if (late) this.timers.clearTimeout(late);
    }
    this.cleanup();
  }

  /** At process exit: kills the core and removes the socket, at once. */
  stopNow(): void {
    this.stopping = true;
    try {
      this.child?.kill("SIGKILL");
    } catch {}
    this.cleanup();
  }

  private cleanup() {
    this.server?.close();
    this.server = null;
    if ((this.options.platform ?? process.platform) !== "win32")
      rmSync(this.path, { force: true });
    if (this.tempDir) rmSync(this.tempDir, { recursive: true, force: true });
  }

  private spawn() {
    if (this.stopping) return;
    this.token = randomBytes(32).toString("hex");
    this.refusedReason = null;
    const env = {
      ...this.options.env,
      ROAMGATE_CORE_CHANNEL: this.path,
      ROAMGATE_CORE_TOKEN: this.token,
    };
    let child: CoreProcess;
    try {
      child = this.spawnCore([this.options.bin, "core"], env);
    } catch (error) {
      this.options.log(
        "warn",
        `cannot start the core ${this.options.bin}: ${(error as Error).message}; Bun serves everything`,
      );
      this.scheduleRestart(0);
      return;
    }
    this.child = child;
    this.childStartedAt = this.timers.now();
    this.options.log("debug", `started the core (pid ${child.pid ?? "?"})`);
    this.helloTimer = this.timers.setTimeout(() => {
      this.helloTimer = null;
      if (this.connected || this.child !== child) return;
      this.options.log(
        "warn",
        `the core said no hello within ${HELLO_TIMEOUT_MS / 1000} s: stopping it`,
      );
      this.kill(child);
    }, HELLO_TIMEOUT_MS);
    void child.exited.then((code) => this.exited(child, code));
  }

  private kill(child: CoreProcess) {
    try {
      child.kill("SIGKILL");
    } catch {}
  }

  private exited(child: CoreProcess, code: number | null) {
    if (this.child !== child) return;
    this.child = null;
    this.clearHelloTimer();
    const channel = this.active;
    this.active = null;
    channel?.destroy();
    this.disconnect();
    if (this.stopping) return;
    const upFor = this.timers.now() - this.childStartedAt;
    this.options.log(
      "warn",
      `the core ${this.refusedReason ? `was refused (${this.refusedReason})` : `exited (code ${code ?? "signal"})`}; Bun serves everything until it is back`,
    );
    this.scheduleRestart(upFor);
  }

  private scheduleRestart(upFor: number) {
    if (this.stopping) return;
    if (upFor >= BACKOFF_RESET_AFTER_MS) this.delay = BACKOFF_FIRST_MS;
    const delay = this.delay;
    this.delay = Math.min(this.delay * 2, BACKOFF_MAX_MS);
    this.options.log("debug", `starting the core again in ${delay} ms`);
    this.restartTimer = this.timers.setTimeout(() => {
      this.restartTimer = null;
      this.spawn();
    }, delay);
  }

  private clearHelloTimer() {
    if (this.helloTimer) this.timers.clearTimeout(this.helloTimer);
    this.helloTimer = null;
  }

  private accept(socket: Socket) {
    if (this.active || this.stopping || !this.child) {
      socket.destroy();
      return;
    }
    const child = this.child;
    const channel: Channel = new Channel(
      socket,
      {
        ...this.options.handlers,
        control: (message) => this.control(channel, message),
        close: (error) => {
          if (this.active !== channel) return;
          this.active = null;
          this.disconnect();
          if (error)
            this.options.log(
              "warn",
              `the core's channel broke: ${error.message}`,
            );
          // A core without its channel is no use: it exits by itself; make
          // sure of it.
          if (this.child === child) this.kill(child);
        },
        log: (level, message) => this.options.log(level, message),
      },
      {
        timers: this.timers,
        pingAfterMs: PING_AFTER_MS,
        deadAfterMs: DEAD_AFTER_MS,
      },
    );
    this.active = channel;
  }

  private control(channel: Channel, message: Message) {
    if (message.t === "hello" && !this.connected) {
      const reason = !sameToken(message.token, this.token)
        ? "wrong token"
        : message.protocol !== PROTOCOL
          ? `protocol ${String(message.protocol)}, not ${PROTOCOL}`
          : null;
      if (reason) {
        this.refusedReason = reason;
        channel.send({ t: "refused", reason });
        channel.close();
        return;
      }
      this.clearHelloTimer();
      this.hello = {
        version: String(message.version ?? ""),
        pid: typeof message.pid === "number" ? message.pid : null,
        families: Array.isArray(message.families)
          ? message.families.filter(
              (family): family is string => typeof family === "string",
            )
          : [],
        side: String(message.side ?? ""),
        test: message.test === true,
      };
      channel.send({
        t: "welcome",
        protocol: PROTOCOL,
        side: "bun",
        ...this.options.welcome(),
      });
      this.connected = channel;
      this.options.log(
        "info",
        `core ${this.hello.version} connected (pid ${this.hello.pid ?? "?"}, families: ${this.hello.families.join(", ") || "none"})`,
      );
      this.options.onConnect?.(channel, this.hello);
      return;
    }
    if (message.t === "bye") channel.close();
  }

  private disconnect() {
    if (!this.connected) return;
    this.connected = null;
    this.hello = null;
    this.options.onDisconnect?.();
  }
}
