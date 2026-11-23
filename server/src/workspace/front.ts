import { type Logger, silentLogger } from "../utils/logger";

/**
 * A connection runtime's workspace part while the workspace family may move
 * to the Rust core (Rust migration plan, section 8.2;
 * contract/wire/core-channel.md, The workspace family).
 *
 * Without a core this does nothing: each runtime runs its own auto-sync,
 * Last step turns and git status as before. While the core owns the family,
 * a runtime's own background parts stop and the core runs them: the front
 * tells it each ready runtime (`internal.workspace.runtime_start`, after
 * the runtime's own parts stopped), each runtime gone
 * (`internal.workspace.runtime_stop`), and what each runtime's
 * subscriptions saw (`internal.workspace.events`, in order, one batch in
 * flight per runtime). When the family comes back the front stops the
 * core's part of each runtime, then starts the runtime's own again.
 */

/** What a runtime's subscriptions saw, as the core reads it. */
export type WorkspaceEvent =
  | { kind: "herdr"; event: unknown }
  | { kind: "pane_list_start"; list: number }
  | { kind: "pane_list"; list: number; result: unknown };

export type WorkspaceCore = {
  /** True while the core serves the workspace family. */
  owned(): boolean;
  /** `internal.workspace.<op>`. */
  call(op: string, params: unknown): Promise<unknown>;
};

/** A ready runtime, as the front hands it over. */
export type WorkspaceRuntimePart = {
  connectionId: string;
  generation: number;
  sshHost: string | null;
  remotePlatform: string | null;
  /** Stops the runtime's own background parts (drains them). */
  stopOwn(): Promise<void>;
  /** Starts them again (reading afresh). */
  startOwn(): void;
};

/** A runtime's link to the front. */
export type WorkspaceRuntimeLink = {
  /** True while the core runs this runtime's workspace part. */
  routed(): boolean;
  /** The runtime became ready: its own parts start, or the core's. */
  ready(): void;
  /** The runtime is disposed. */
  stopped(): Promise<void>;
  herdrEvent(event: unknown): void;
  /** A listing of agent statuses starts: its list number. */
  paneListStart(): number;
  paneList(result: unknown, list: number): void;
  /** `internal.workspace.<op>` with this runtime's connection. */
  call(op: string, params: Record<string, unknown>): Promise<unknown>;
};

export type WorkspaceFront = {
  /** True while the core serves the workspace family. */
  owned(): boolean;
  /** `internal.workspace.<op>`; throws unless the core owns the family. */
  call(op: string, params: unknown): Promise<unknown>;
  attach(part: WorkspaceRuntimePart): WorkspaceRuntimeLink;
  /** The owner may have changed (onOwnershipChanged). */
  ownershipChanged(): void;
  /** Resolves once every handover in progress is done (tests). */
  settle(): Promise<void>;
};

/** How long a handback waits for the core to stop a runtime's part. */
export const CORE_STOP_MS = 5_000;

type Entry = {
  part: WorkspaceRuntimePart;
  ready: boolean;
  disposed: boolean;
  /** Where the workspace part runs now. */
  side: "bun" | "core";
  /** The core was told of the runtime (runtime_start answered). */
  started: boolean;
  queue: WorkspaceEvent[];
  sending: boolean;
  lists: number;
  /** The handover of this runtime in progress. */
  moving: Promise<void>;
};

export function createWorkspaceFront(deps: {
  /** Null: no core, every runtime keeps its own parts. */
  core: (() => WorkspaceCore | null) | null;
  logger?: Logger;
  setTimeout?: (run: () => void, ms: number) => unknown;
  clearTimeout?: (timer: unknown) => void;
}): WorkspaceFront {
  const logger = deps.logger ?? silentLogger;
  const later =
    deps.setTimeout ??
    ((run: () => void, ms: number) => {
      const timer = setTimeout(run, ms);
      (timer as { unref?: () => void }).unref?.();
      return timer;
    });
  const cancel =
    deps.clearTimeout ?? ((timer: unknown) => clearTimeout(timer as never));
  const entries = new Set<Entry>();

  const core = () => deps.core?.() ?? null;
  const owned = () => core()?.owned() === true;
  const call = async (op: string, params: unknown) => {
    const link = core();
    if (!link?.owned())
      throw new Error("the Rust core does not serve the workspace family");
    return link.call(op, params);
  };

  const ids = (entry: Entry) => ({
    connection_id: entry.part.connectionId,
    generation: entry.part.generation,
  });

  function pump(entry: Entry) {
    if (
      entry.sending ||
      !entry.started ||
      entry.side !== "core" ||
      entry.disposed ||
      !entry.queue.length
    )
      return;
    const events = entry.queue.splice(0);
    entry.sending = true;
    void call("events", { ...ids(entry), events })
      .catch((error) =>
        logger.warn("workspace events did not reach the core", {
          connection: entry.part.connectionId,
          error: (error as Error).message,
        }),
      )
      .finally(() => {
        entry.sending = false;
        pump(entry);
      });
  }

  /** Waits for `task`, at most `ms`. */
  function bounded(task: Promise<unknown>, ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      const timer = later(resolve, ms);
      void task
        .catch(() => undefined)
        .finally(() => {
          cancel(timer);
          resolve();
        });
    });
  }

  function toCore(entry: Entry) {
    entry.side = "core";
    entry.started = false;
    entry.moving = entry.moving.then(async () => {
      if (entry.side !== "core" || entry.disposed) return;
      try {
        await entry.part.stopOwn();
      } catch (error) {
        logger.warn("the workspace part did not stop", {
          connection: entry.part.connectionId,
          error: (error as Error).message,
        });
      }
      if (entry.side !== "core" || entry.disposed) return;
      try {
        await call("runtime_start", {
          ...ids(entry),
          ssh_host: entry.part.sshHost,
          remote_platform: entry.part.remotePlatform,
        });
        entry.started = true;
        pump(entry);
      } catch (error) {
        logger.warn("the core did not take a workspace runtime", {
          connection: entry.part.connectionId,
          error: (error as Error).message,
        });
      }
    });
  }

  function toBun(entry: Entry) {
    const wasStarted = entry.started;
    entry.side = "bun";
    entry.started = false;
    entry.queue = [];
    entry.moving = entry.moving.then(async () => {
      const link = core();
      // The core may be gone (then its part went with it).
      if (wasStarted && link)
        await bounded(link.call("runtime_stop", ids(entry)), CORE_STOP_MS);
      if (entry.side !== "bun" || entry.disposed) return;
      entry.part.startOwn();
    });
  }

  return {
    owned,
    call,
    attach(part) {
      const entry: Entry = {
        part,
        ready: false,
        disposed: false,
        side: "bun",
        started: false,
        queue: [],
        sending: false,
        lists: 0,
        moving: Promise.resolve(),
      };
      entries.add(entry);
      return {
        routed: () => entry.side === "core",
        ready() {
          if (entry.ready || entry.disposed) return;
          entry.ready = true;
          if (owned()) toCore(entry);
          else entry.part.startOwn();
        },
        async stopped() {
          if (entry.disposed) return;
          entry.disposed = true;
          entries.delete(entry);
          const wasCore = entry.side === "core";
          entry.queue = [];
          await entry.moving.catch(() => undefined);
          if (wasCore && entry.started && owned())
            await bounded(call("runtime_stop", ids(entry)), CORE_STOP_MS);
        },
        herdrEvent(event) {
          if (entry.side !== "core" || entry.disposed) return;
          entry.queue.push({ kind: "herdr", event });
          pump(entry);
        },
        paneListStart() {
          entry.lists += 1;
          if (entry.side === "core" && !entry.disposed) {
            entry.queue.push({ kind: "pane_list_start", list: entry.lists });
            pump(entry);
          }
          return entry.lists;
        },
        paneList(result, list) {
          if (entry.side !== "core" || entry.disposed) return;
          entry.queue.push({ kind: "pane_list", list, result });
          pump(entry);
        },
        call: (op, params) =>
          call(op, { connection_id: part.connectionId, ...params }),
      };
    },
    ownershipChanged() {
      const now = owned();
      for (const entry of entries) {
        if (!entry.ready || entry.disposed) continue;
        if (now && entry.side === "bun") toCore(entry);
        else if (!now && entry.side === "core") toBun(entry);
      }
    },
    async settle() {
      await Promise.all(
        [...entries].map((entry) => entry.moving.catch(() => undefined)),
      );
    },
  };
}
