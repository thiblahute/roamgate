/**
 * The front's side of the `host` family while the Rust core owns it
 * (contract/wire/core-channel.md, The host family; Rust migration plan
 * S16). The core then owns connections.json, the connection manager and
 * its generations, the profile service, every SSH process's session slot
 * and master, and the Herdr control client with its subscriptions. Bun
 * keeps each generation's composition root (conversation mode, the
 * workspace, the terminal bridge, history watch...), which the core asks
 * it to build and dispose (`host.runtime_start`, `host.runtime_stop`), and
 * which reaches Herdr and the host through the core:
 *
 * - {@link RemoteHerdrClient}: the runtime's Herdr client, its calls
 *   `internal.host.herdr_call`, its events the core's (`host.events`);
 * - the SSH commands built by sshCommandArgv, run or held through
 *   `internal.host.run` and `internal.host.ssh_hold` (ssh-sessions.ts
 *   `setSshCommandFacade`);
 * - {@link RemoteConnections}: the connections as the core says them
 *   (`host.status`), each with the runtime Bun built for its generation;
 * - {@link SwitchingConnectionManager}: the one manager the server uses,
 *   Bun's own or the core's mirror, whichever serves now.
 *
 * Without ROAMGATE_CORE_BIN none of this is made: the switching manager is
 * Bun's manager and nothing else changes.
 */
import { EventEmitter } from "node:events";
import type { HerdrClient } from "../bridge/herdr-client";
import type { SshCommandFacade } from "../bridge/ssh-sessions";
import { type Logger, silentLogger } from "../utils/logger";
import {
  type ConnectionRuntime,
  ConnectionManager,
  type ReadyRuntimeLease,
} from "./manager";
import type { ConnectionProfileListItem } from "./profile-service";
import type { ConnectionId, ConnectionStatus } from "./types";

/** The front's calls to the core's host family. */
export type HostCall = (
  op: string,
  params: unknown,
  signal?: AbortSignal,
) => Promise<unknown>;

/**
 * A connection runtime's Herdr client while the core holds the connection:
 * calls go to the core's client for that generation; its events are the
 * core's subscriptions', emitted by the runtime (`hostEvents`).
 */
export class RemoteHerdrClient extends EventEmitter {
  constructor(
    private readonly hostCall: HostCall,
    private readonly connectionId: string,
    private readonly generation: number,
  ) {
    super();
  }

  call(
    method: string,
    params: Record<string, unknown> = {},
    timeoutMs = 8000,
    beforeSend?: () => void,
    options: { fresh?: boolean } = {},
  ): Promise<any> {
    try {
      beforeSend?.();
    } catch (error) {
      return Promise.reject(error);
    }
    return this.hostCall("herdr_call", {
      connection_id: this.connectionId,
      generation: this.generation,
      method,
      params,
      timeout_ms: timeoutMs,
      fresh: options.fresh === true,
    });
  }

  ping(): Promise<any> {
    return this.call("ping", {}, 5000);
  }

  /** The core caches; nothing is kept here. */
  invalidateReads(): void {}

  subscribe(): never {
    throw new Error("Herdr subscriptions are held by the Rust core");
  }

  /** The runtime's Herdr client as its code types it. */
  asHerdrClient(): HerdrClient {
    return this as unknown as HerdrClient;
  }
}

/** What the core's host family tells the front of a runtime (host.events). */
export type HostEvent =
  | { kind: "herdr"; event: unknown }
  | { kind: "ready" }
  | { kind: "pane_list_start"; list: number; started_at: number }
  | { kind: "pane_list"; list: number; result: unknown };

/** The SSH commands of the front through the core. */
export function sshCommandFacade(hostCall: HostCall): SshCommandFacade {
  return {
    run: async (request, signal) => {
      const result = (await hostCall(
        "run",
        {
          destination: request.destination,
          command: request.command,
          trusted_args: request.trustedArgs,
          tag: request.tag ?? null,
          read_only: request.readOnly,
          connection_id: request.connection ?? null,
          timeout_ms: request.timeoutMs ?? null,
          lane: request.lane,
          ...(request.input === undefined
            ? {}
            : { stdin_b64: Buffer.from(request.input).toString("base64") }),
        },
        signal,
      )) as { code: number; stdout_b64: string; stderr: string };
      return {
        code: result.code,
        stdout: Buffer.from(result.stdout_b64, "base64"),
        stderr: result.stderr,
      };
    },
    hold: async (request, longLived, signal) => {
      const result = (await hostCall(
        "ssh_hold",
        {
          destination: request.destination,
          command: request.command,
          trusted_args: request.trustedArgs,
          tag: request.tag ?? null,
          read_only: request.readOnly,
          connection_id: request.connection ?? null,
          timeout_ms: request.timeoutMs ?? null,
          lane: request.lane,
          long_lived: longLived,
        },
        signal,
      )) as { lease: number; argv: string[]; remaining_ms: number | null };
      return {
        lease: result.lease,
        argv: result.argv,
        remainingMs: result.remaining_ms ?? undefined,
      };
    },
    release: (lease) => {
      void hostCall("ssh_release", { lease }).catch(() => undefined);
    },
  };
}

/** A connection status pushed by the core, with its list item. */
export type HostStatusPush = {
  default_connection_id: string;
  connections: ConnectionProfileListItem[];
  /** The status that changed, for the front's observer; absent after a profile change. */
  status?: ConnectionStatus;
};

/**
 * The connections as the core says them, each with the runtime the front
 * built for its current generation. A runtime is ready (leased to a
 * request) only while the core says its generation is ready.
 */
export class RemoteConnections<Runtime extends ConnectionRuntime> {
  private defaultConnectionId: string;
  private items: ConnectionProfileListItem[] = [];
  private readonly runtimes = new Map<
    ConnectionId,
    { generation: number; runtime: Runtime }
  >();

  constructor(
    defaultConnectionId: string,
    private readonly logger: Logger = silentLogger,
  ) {
    this.defaultConnectionId = defaultConnectionId;
  }

  /** The core's list. */
  update(push: HostStatusPush): void {
    this.defaultConnectionId = push.default_connection_id;
    this.items = push.connections;
  }

  list(): ConnectionStatus[] {
    return this.items.map((item) => statusOf(item));
  }

  profiles(): ConnectionProfileListItem[] {
    return this.items.map((item) => ({ ...item }));
  }

  defaultId(): string {
    return this.defaultConnectionId;
  }

  has(connectionId: ConnectionId): boolean {
    return this.items.some((item) => item.id === connectionId);
  }

  status(connectionId: ConnectionId): ConnectionStatus {
    const item = this.items.find((each) => each.id === connectionId);
    if (!item) throw new Error(`unknown connection: ${connectionId}`);
    return statusOf(item);
  }

  /** The runtime the front built for a generation (host.runtime_start). */
  attach(connectionId: ConnectionId, generation: number, runtime: Runtime) {
    this.runtimes.set(connectionId, { generation, runtime });
  }

  /** Takes it out for disposal, when it is the one of `generation`. */
  detach(connectionId: ConnectionId, generation: number): Runtime | null {
    const entry = this.runtimes.get(connectionId);
    if (!entry || entry.generation !== generation) return null;
    this.runtimes.delete(connectionId);
    return entry.runtime;
  }

  /** The runtime of a generation, ready or not (for its events). */
  runtimeOf(connectionId: ConnectionId, generation: number): Runtime | null {
    const entry = this.runtimes.get(connectionId);
    return entry && entry.generation === generation ? entry.runtime : null;
  }

  /** Every runtime, taken out (the family goes back to Bun). */
  detachAll(): Runtime[] {
    const all = Array.from(this.runtimes.values(), (entry) => entry.runtime);
    this.runtimes.clear();
    return all;
  }

  currentRuntimes(): Runtime[] {
    return Array.from(this.runtimes.values(), (entry) => entry.runtime);
  }

  readyRuntimeLease(
    connectionId: ConnectionId,
  ): ReadyRuntimeLease<Runtime> | null {
    // Not listed yet (the core's first list is on its way): not ready.
    if (!this.has(connectionId)) return null;
    const status = this.status(connectionId);
    const entry = this.runtimes.get(connectionId);
    if (status.state !== "ready" || !entry) return null;
    if (entry.generation !== status.generation) return null;
    const { generation, runtime } = entry;
    return {
      connectionId,
      generation,
      runtime,
      isCurrent: () => {
        const now = this.items.find((each) => each.id === connectionId);
        return (
          now?.state === "ready" &&
          now.generation === generation &&
          this.runtimes.get(connectionId)?.runtime === runtime
        );
      },
    };
  }

  forEachCurrentRuntime(callback: (runtime: Runtime) => void): void {
    for (const runtime of this.currentRuntimes()) {
      try {
        callback(runtime);
      } catch (error) {
        this.logger.error("connection runtime callback failed", {
          connection: runtime.identity.id,
          error: (error as Error)?.message ?? String(error),
        });
      }
    }
  }
}

function statusOf(item: ConnectionProfileListItem): ConnectionStatus {
  return {
    id: item.id,
    label: item.label,
    source: item.source,
    is_default: item.is_default,
    state: item.state,
    generation: item.generation,
    ...(item.error ? { error: item.error } : {}),
  };
}

/**
 * The manager the server uses: Bun's own while Bun owns the `host` family
 * (always, without a core), the core's mirror while the core does. Only
 * the reads and the runtime walks are switched: profile changes go to the
 * owner's profile service, and the core drives its own starts and stops.
 */
export class SwitchingConnectionManager<
  Runtime extends ConnectionRuntime,
> extends ConnectionManager<Runtime> {
  private remote: RemoteConnections<Runtime> | null = null;

  constructor(
    private bun: ConnectionManager<Runtime>,
    logger?: Logger,
  ) {
    super(bun.defaultId(), undefined, logger);
  }

  /** Bun's own manager (a new one when Bun takes the family back). */
  useBun(manager: ConnectionManager<Runtime>): void {
    this.bun = manager;
    this.remote = null;
  }

  /** The core's mirror. */
  useRemote(remote: RemoteConnections<Runtime>): void {
    this.remote = remote;
  }

  bunManager(): ConnectionManager<Runtime> {
    return this.bun;
  }

  remoteConnections(): RemoteConnections<Runtime> | null {
    return this.remote;
  }

  override defaultId(): ConnectionId {
    return this.remote ? this.remote.defaultId() : this.bun.defaultId();
  }

  override has(connectionId: ConnectionId): boolean {
    return this.remote
      ? this.remote.has(connectionId)
      : this.bun.has(connectionId);
  }

  override status(connectionId: ConnectionId): ConnectionStatus {
    return this.remote
      ? this.remote.status(connectionId)
      : this.bun.status(connectionId);
  }

  override list(): ConnectionStatus[] {
    return this.remote ? this.remote.list() : this.bun.list();
  }

  override currentRuntime(connectionId: ConnectionId): Runtime | null {
    if (!this.remote) return this.bun.currentRuntime(connectionId);
    this.remote.status(connectionId);
    return (
      this.remote
        .currentRuntimes()
        .find((runtime) => runtime.identity.id === connectionId) ?? null
    );
  }

  override defaultRuntime(): Runtime | null {
    return this.currentRuntime(this.defaultId());
  }

  override readyRuntimeLease(
    connectionId: ConnectionId,
  ): ReadyRuntimeLease<Runtime> | null {
    return this.remote
      ? this.remote.readyRuntimeLease(connectionId)
      : this.bun.readyRuntimeLease(connectionId);
  }

  override readyRuntime(connectionId: ConnectionId): Runtime | null {
    return this.readyRuntimeLease(connectionId)?.runtime ?? null;
  }

  override defaultReadyRuntime(): Runtime | null {
    return this.readyRuntime(this.defaultId());
  }

  override currentRuntimes(): Runtime[] {
    return this.remote
      ? this.remote.currentRuntimes()
      : this.bun.currentRuntimes();
  }

  override forEachCurrentRuntime(callback: (runtime: Runtime) => void): void {
    if (this.remote) this.remote.forEachCurrentRuntime(callback);
    else this.bun.forEachCurrentRuntime(callback);
  }

  override register(
    args: Parameters<ConnectionManager<Runtime>["register"]>[0],
  ) {
    return this.owned("register").register(args);
  }

  override setDefault(connectionId: ConnectionId): void {
    this.owned("setDefault").setDefault(connectionId);
  }

  override unregister(connectionId: ConnectionId): Promise<void> {
    return this.owned("unregister").unregister(connectionId);
  }

  override markReconnecting(connectionId: ConnectionId, error: unknown) {
    return this.owned("markReconnecting").markReconnecting(connectionId, error);
  }

  override retireFailedRuntime(connectionId: ConnectionId): Promise<void> {
    return this.owned("retireFailedRuntime").retireFailedRuntime(connectionId);
  }

  override startDefault(): Promise<void> {
    return this.owned("startDefault").startDefault();
  }

  override start(connectionId: ConnectionId): Promise<void> {
    return this.owned("start").start(connectionId);
  }

  override stop(connectionId: ConnectionId): Promise<void> {
    return this.owned("stop").stop(connectionId);
  }

  override replace(args: Parameters<ConnectionManager<Runtime>["replace"]>[0]) {
    return this.owned("replace").replace(args);
  }

  /** At shutdown: Bun's runtimes, or the core's mirror's (the core stops its own). */
  override async stopAll(): Promise<void> {
    if (!this.remote) return this.bun.stopAll();
    await Promise.all(
      this.remote
        .detachAll()
        .map((runtime) => runtime.stop().catch(() => undefined)),
    );
  }

  private owned(operation: string): ConnectionManager<Runtime> {
    if (this.remote)
      throw new Error(
        `connections are the Rust core's now (${operation} goes through it)`,
      );
    return this.bun;
  }
}
