/**
 * The front's side of the internal channel to the Rust core
 * (contract/wire/core-channel.md), as the server uses it: whether a
 * browser RPC or an HTTP path goes to the core, forwarding them, shadow
 * reads of what Bun answered, and the core's pushes and reverse calls.
 *
 * `startCoreFront` returns null unless `ROAMGATE_CORE_BIN` names a core:
 * then nothing here runs (no socket, no watcher, no timer) and the server
 * is exactly what it is without this module.
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { gameModeActive } from "../utils/gamemode";
import { type Logger, serverLogger } from "../utils/logger";
import {
  type CallContext,
  type Channel,
  ChannelError,
  type PushMessage,
  type Timers,
} from "./channel";
import {
  activeTestClock,
  realTimers,
  type TestClock,
} from "../utils/test-clock";
import {
  DEFAULT_TABLE,
  ownershipChanged,
  setOwnershipCheck,
  watchOwners,
} from "./owners";
import {
  type CoreState,
  FAMILIES,
  type Families,
  familyOf,
  familySide,
  routeHttp,
  routeRpc,
  shadowSide,
} from "./protocol";
import { ShadowSampler } from "./shadow";
import { CoreSupervisor, type SpawnCore } from "./supervisor";

export { bunOwns, onOwnershipChanged } from "./owners";
export type { CallContext, PushMessage } from "./channel";

export const CORE_BIN_ENV = "ROAMGATE_CORE_BIN";
export const CORE_TEST_ENV = "ROAMGATE_CORE_TEST";

/** Whether a Rust core is configured (`ROAMGATE_CORE_BIN`). */
export function coreConfigured(
  env: Record<string, string | undefined>,
): boolean {
  return !!env[CORE_BIN_ENV];
}

export type ReverseTarget = (
  args: unknown,
  ctx: CallContext,
  signal: AbortSignal,
) => Promise<unknown>;

export type CoreFrontDeps = {
  env: Record<string, string | undefined>;
  /** The data root: the runtime directory is `<data>/runtime`. */
  dataDir: string;
  /** The server runs from source (not the standalone binary). */
  fromSource: boolean;
  deliverPush: (push: PushMessage) => void;
  reverseTargets: Record<string, ReverseTarget>;
  logger?: Logger;
  shadowLogger?: Logger;
  gameMode?: () => Promise<boolean | null>;
  spawn?: SpawnCore;
  timers?: Timers;
  families?: Families;
  random?: () => number;
  /** The test clock the families follow (default: the process's). */
  testClock?: TestClock | null;
};

export type CoreFront = {
  /**
   * The front's own call to a Rust-owned family
   * (`internal.<family>.<op>`): its result, or a ChannelError.
   */
  callInternal: (
    family: string,
    op: string,
    params: unknown,
    signal?: AbortSignal,
  ) => Promise<unknown>;
  /** Whether the core answers `method` now. */
  routesRpc: (method: string) => boolean;
  /**
   * The side the owners table gives `family`, whether or not the core is
   * connected (bunOwns says who serves it now).
   */
  tableOwner: (family: string) => "rust" | "bun";
  /** Forwards a browser RPC to the core: its result, or a ChannelError. */
  callRpc: (
    method: string,
    params: unknown,
    ctx: CallContext,
    signal?: AbortSignal,
  ) => Promise<unknown>;
  /**
   * Bun's answer to a browser RPC: shadowed on the core when drawn (the
   * promise, for tests, settles once the shadow is done or skipped).
   */
  observeReply: (
    method: string,
    params: unknown,
    ctx: CallContext,
    message: Record<string, unknown>,
  ) => Promise<"skipped" | "done"> | undefined;
  /** Whether the core serves `path` now. */
  routesHttp: (path: string) => boolean;
  forwardHttp: (request: Request, ctx: CallContext) => Promise<Response>;
  /** Stops the core (bye, then a kill 3 s later). */
  stop: () => Promise<void>;
  /** At process exit: kills the core at once. */
  stopNow: () => void;
  /** Tests: the supervisor. */
  supervisor: CoreSupervisor;
};

/** A login's id on the channel: never its token. */
export function sessionIdOf(
  token: string | null | undefined,
): string | undefined {
  if (!token) return undefined;
  return new Bun.CryptoHasher("sha256")
    .update(token)
    .digest("hex")
    .slice(0, 16);
}

const socketIds = new WeakMap<object, number>();
let nextSocketId = 1;

/** The front's number for a browser socket. */
export function socketIdOf(socket: object): number {
  let id = socketIds.get(socket);
  if (id === undefined) {
    id = nextSocketId++;
    socketIds.set(socket, id);
  }
  return id;
}

export function startCoreFront(deps: CoreFrontDeps): CoreFront | null {
  const bin = deps.env[CORE_BIN_ENV];
  if (!bin) return null;
  const log = deps.logger ?? serverLogger.child("core");
  const shadowLog = deps.shadowLogger ?? serverLogger.child("shadow");
  const families = deps.families ?? FAMILIES;
  const test = deps.fromSource && deps.env[CORE_TEST_ENV] === "1";
  const runtimeDir = join(deps.dataDir, "runtime");
  const targets: Record<string, ReverseTarget> = { ...deps.reverseTargets };
  if (test) targets["test.echo"] = async (args, ctx) => ({ args, ctx });

  const env = { ...deps.env };
  delete env[CORE_BIN_ENV];

  let owners: ReturnType<typeof watchOwners> | null = null;
  const table = () => owners?.table() ?? DEFAULT_TABLE;
  const coreState = (): CoreState => {
    const hello = supervisor.coreHello();
    return { connected: hello !== null, families: hello?.families ?? [] };
  };

  const testClock =
    deps.testClock === undefined ? activeTestClock() : deps.testClock;
  // The core's families follow the test clock: told after each advance,
  // which waits for them (contract/wire/core-channel.md).
  const unfollow = testClock?.follow(async (now) => {
    const channel = supervisor.channel();
    if (!channel) return;
    const abort = new AbortController();
    const timer = realTimers.setTimeout(() => abort.abort(), 10_000);
    try {
      await channel.call(
        "internal.clock.advance",
        { to: now },
        {},
        { signal: abort.signal },
      );
    } finally {
      realTimers.clearTimeout(timer);
    }
  });

  const supervisor = new CoreSupervisor({
    bin,
    runtimeDir,
    env,
    welcome: () => ({
      owners: table().owners,
      shadow: table().shadow,
      ...(testClock ? { clock: testClock.now() } : {}),
    }),
    onConnect: () => ownershipChanged(),
    onDisconnect: () => ownershipChanged(),
    handlers: {
      reverseCall: async (target, args, ctx, signal) => {
        const run = targets[target];
        if (!run)
          throw new ChannelError(`unknown target ${target}`, "unknown_target");
        return run(args, ctx, signal);
      },
      push: (push) => deps.deliverPush(push),
    },
    log: (level, message) => log[level](message),
    ...(deps.spawn ? { spawn: deps.spawn } : {}),
    ...(deps.timers ? { timers: deps.timers } : {}),
  });

  const sampler = new ShadowSampler({
    settings: () => table().shadow,
    directory: runtimeDir,
    gameMode: deps.gameMode ?? (() => gameModeActive()),
    warn: (message) => shadowLog.warn(message),
    ...(deps.timers ? { timers: deps.timers } : {}),
    ...(deps.random ? { random: deps.random } : {}),
  });

  const ownersOf = () => table().owners;
  setOwnershipCheck(
    (family) =>
      familySide(family, families, ownersOf(), coreState(), test) === "bun",
  );

  const channelOrThrow = (): Channel => {
    const channel = supervisor.channel();
    if (!channel)
      throw new ChannelError("the core is not connected", "core_down");
    return channel;
  };

  try {
    mkdirSync(runtimeDir, { recursive: true, mode: 0o700 });
  } catch {
    // supervisor.start says why.
  }
  owners = watchOwners(runtimeDir, {
    onChange: (next) => {
      log.info(
        `owners table changed: ${
          Object.entries(next.owners)
            .map(([family, side]) => `${family}=${side}`)
            .join(", ") || "every family with Bun"
        }`,
      );
      supervisor.channel()?.send({
        t: "owner",
        owners: next.owners,
        shadow: next.shadow,
      });
      ownershipChanged();
    },
    warn: (message) => log.warn(message),
    ...(deps.timers ? { timers: deps.timers } : {}),
  });
  void supervisor.start().catch((error) => {
    log.warn(
      `the core channel did not start, Bun serves everything: ${(error as Error).message}`,
    );
  });

  return {
    supervisor,
    routesRpc: (method) =>
      routeRpc(method, families, ownersOf(), coreState(), test) === "rust",
    tableOwner: (family) => (ownersOf()[family] === "rust" ? "rust" : "bun"),
    callRpc: async (method, params, ctx, signal) =>
      channelOrThrow().call(method, params, ctx, signal ? { signal } : {}),
    callInternal: async (family, op, params, signal) =>
      channelOrThrow().call(
        `internal.${family}.${op}`,
        params,
        {},
        signal ? { signal } : {},
      ),
    observeReply: (method, params, ctx, message) => {
      if (!("result" in message)) return undefined;
      if (
        shadowSide(method, families, ownersOf(), coreState(), test) !== "rust"
      )
        return undefined;
      const channel = supervisor.channel();
      if (!channel) return undefined;
      return sampler.offer({
        method,
        family: familyOf(method, families)!,
        owner: "bun",
        params,
        result: message.result,
        run: (signal) =>
          channel.call(method, params, ctx, { shadow: true, signal }),
      });
    },
    routesHttp: (path) =>
      routeHttp(path, families, ownersOf(), coreState(), test) === "rust",
    forwardHttp: async (request, ctx) => {
      const url = new URL(request.url);
      const headers: [string, string][] = [];
      request.headers.forEach((value, name) => {
        headers.push([name.toLowerCase(), value]);
      });
      try {
        const response = await channelOrThrow().http(
          {
            method: request.method,
            url: `${url.pathname}${url.search}`,
            headers,
            ctx,
            body: request.body,
          },
          request.signal,
        );
        return new Response(
          response.body as ReadableStream<Uint8Array> | null,
          {
            status: response.status,
            headers: response.headers,
          },
        );
      } catch (error) {
        log.warn(
          `${request.method} ${url.pathname} through the core failed: ${(error as Error).message}`,
        );
        return new Response("the core did not answer", {
          status: 502,
          headers: { "content-type": "text/plain; charset=utf-8" },
        });
      }
    },
    stop: async () => {
      owners?.stop();
      unfollow?.();
      setOwnershipCheck(null);
      ownershipChanged();
      await supervisor.stop();
    },
    stopNow: () => {
      owners?.stop();
      unfollow?.();
      setOwnershipCheck(null);
      supervisor.stopNow();
    },
  };
}
