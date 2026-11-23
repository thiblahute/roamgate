import type { CallContext } from "../core-channel";
import { herdrEventName } from "../utils/herdr-events";
import { type Logger, silentLogger } from "../utils/logger";
import type { ActivityRecorder, PresenceReply } from "./recorder";

/**
 * The server's activity log while the activity family may move to the Rust
 * core (Rust migration plan, section 8.2; contract/wire/core-channel.md,
 * the activity family): one writer of activity.sqlite at a time.
 *
 * Without a core this is Bun's recorder, called as before. With one, the
 * family's owner records: Bun's recorder while Bun owns it, else the
 * core's, which gets what only Bun sees in stage 1 (connection states,
 * Herdr's events and listings, the agents conversation mode runs, closed
 * browser sockets) as `internal.activity.signals`, each stamped with the
 * time it arrived here, in order, one batch at a time. A handover stops
 * the old owner's recorder (its spans end, its session stops) before the
 * new one starts (`internal.activity.start`, `internal.activity.stop`),
 * holding the signals that arrive meanwhile; the new recorder then gets
 * the connections' states as they are. While the owners table gives the
 * family to Rust and the core has not connected yet, signals are held
 * until it does, or until `HOLD_MS` passes and Bun records them itself.
 */

/** A signal as the core's family reads it. */
export type ActivitySignal =
  | {
      op: "connection_status";
      ts: number;
      connection_id: string;
      state: string;
    }
  | { op: "herdr_event"; ts: number; connection_id: string; event: unknown }
  | {
      op: "pane_list";
      ts: number;
      connection_id: string;
      result: unknown;
      started_at: number;
    }
  | { op: "owned_agent"; ts: number; connection_id: string; pane_id: string }
  | { op: "socket_closed"; ts: number; socket_id: number };

/** A held signal: the core's form and the browser socket Bun would need. */
type Held = { signal: ActivitySignal; socket?: object };

export type ActivityCore = {
  /** True while the core serves the activity family. */
  owned(): boolean;
  /** The owners table gives the family to Rust (connected or not). */
  expected(): boolean;
  /** `internal.activity.<op>`. */
  call(
    op: "start" | "stop" | "signals" | "flush",
    params: unknown,
  ): Promise<unknown>;
  /** A browser's presence report, answered by the core. */
  presence(params: unknown, ctx: CallContext): Promise<unknown>;
};

export type ActivityFront = {
  ready(): Promise<boolean>;
  connectionStatus(connectionId: string, state: string): void;
  herdrEvent(connectionId: string, event: unknown): void;
  paneList(connectionId: string, result: unknown, startedAt: number): void;
  ownedAgentChanged(connectionId: string, paneId: string): void;
  presence(
    socket: object,
    connectionId: string,
    params: unknown,
    ctx?: () => CallContext,
  ): Promise<PresenceReply>;
  socketClosed(socket: object): void;
  /** The owner may have changed (onOwnershipChanged). */
  ownershipChanged(): void;
  /**
   * Resolves once what was signalled so far is applied where it records
   * (for the test clock, before it moves).
   */
  settle(): Promise<void>;
  /** Ends recording where it runs (Bun's recorder, or the core's). */
  stop(): Promise<void>;
  stopNow(): void;
};

/** How long signals wait for a core the owners table names. */
export const HOLD_MS = 15_000;
/** How long Bun waits for the core's recorder to stop on a handback. */
export const CORE_STOP_MS = 5_000;

/** The Herdr events the recorder reads (recorder.ts handleHerdrEvent). */
export function recordedHerdrEvent(event: unknown): boolean {
  const name = herdrEventName(event)?.replaceAll("_", ".");
  if (!name) return false;
  return (
    name.startsWith("pane.agent.") ||
    name === "pane.closed" ||
    name === "pane.exited" ||
    name === "pane.moved" ||
    name === "pane.focused" ||
    name.startsWith("workspace.") ||
    name.startsWith("worktree.")
  );
}

export function createActivityFront(deps: {
  createRecorder: () => ActivityRecorder;
  /** Null: no core, Bun's recorder exactly as without this module. */
  core: (() => ActivityCore | null) | null;
  /** The owners table, read at start, gives the family to Rust. */
  heldAtStart: boolean;
  socketId: (socket: object) => number;
  now?: () => number;
  setTimeout?: (run: () => void, ms: number) => unknown;
  clearTimeout?: (timer: unknown) => void;
  logger?: Logger;
}): ActivityFront {
  const now = deps.now ?? Date.now;
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

  // No core: the recorder itself.
  if (!deps.core) {
    const recorder = deps.createRecorder();
    return {
      ready: () => recorder.ready(),
      connectionStatus: (id, state) => recorder.connectionStatus(id, state),
      herdrEvent: (id, event) => recorder.herdrEvent(id, event),
      paneList: (id, result, startedAt) =>
        recorder.paneList(id, result, startedAt),
      ownedAgentChanged: (id, pane) => recorder.ownedAgentChanged(id, pane),
      presence: (socket, id, params) => recorder.presence(socket, id, params),
      socketClosed: (socket) => recorder.socketClosed(socket),
      ownershipChanged: () => {},
      settle: () => recorder.flush(),
      stop: () => recorder.stop(),
      stopNow: () => recorder.stopNow(),
    };
  }
  const core = deps.core;

  type Mode = "held" | "bun" | "rust" | "switching";
  let mode: Mode = deps.heldAtStart ? "held" : "bun";
  let recorder: ActivityRecorder | null =
    mode === "bun" ? deps.createRecorder() : null;
  let stopped = false;
  /** Signals waiting for an owner. */
  let held: Held[] = [];
  /** Each connection's last state, for a recorder that starts mid-life. */
  const states = new Map<string, string>();
  /** Resolves once a handover settled. */
  let settled: Promise<void> = Promise.resolve();
  /** Resolves once a held start is decided. */
  let releaseHold: (() => void) | null = null;
  const holdDecided =
    mode === "held"
      ? new Promise<void>((resolve) => {
          releaseHold = resolve;
        })
      : Promise.resolve();
  let holdTimer: unknown = null;
  if (mode === "held")
    holdTimer = later(() => {
      holdTimer = null;
      if (mode !== "held") return;
      logger.info("the Rust core did not take the activity log: Bun records");
      void becomeBun(false);
    }, HOLD_MS);

  // --- To the core, in order ------------------------------------------
  let outbox: ActivitySignal[] = [];
  let sending = false;
  let scheduled = false;
  async function drain() {
    scheduled = false;
    if (sending) return;
    sending = true;
    try {
      while (outbox.length > 0 && mode === "rust") {
        const signals = outbox;
        outbox = [];
        try {
          await core()?.call("signals", { signals });
        } catch (error) {
          logger.debug("activity signals not delivered to the core", {
            error,
          });
        }
      }
    } finally {
      sending = false;
    }
  }

  /** Queued, and sent with the others queued in the same turn. */
  function toCore(signal: ActivitySignal) {
    outbox.push(signal);
    if (sending || scheduled) return;
    scheduled = true;
    queueMicrotask(() => void drain());
  }

  // --- Into Bun's recorder ---------------------------------------------
  function replay(target: ActivityRecorder, entry: Held) {
    const signal = entry.signal;
    switch (signal.op) {
      case "connection_status":
        target.connectionStatus(signal.connection_id, signal.state, signal.ts);
        return;
      case "herdr_event":
        target.herdrEvent(signal.connection_id, signal.event, signal.ts);
        return;
      case "pane_list":
        target.paneList(
          signal.connection_id,
          signal.result,
          signal.started_at,
          signal.ts,
        );
        return;
      case "owned_agent":
        target.ownedAgentChanged(
          signal.connection_id,
          signal.pane_id,
          signal.ts,
        );
        return;
      case "socket_closed":
        if (entry.socket) target.socketClosed(entry.socket, signal.ts);
        return;
    }
  }

  function signal(entry: Held) {
    if (stopped) return;
    if (mode === "bun" && recorder) replay(recorder, entry);
    else if (mode === "rust") toCore(entry.signal);
    else held.push(entry);
  }

  /** The connections' states now, as signals. */
  function currentStates(): Held[] {
    const ts = now();
    return [...states].map(([id, state]) => ({
      signal: { op: "connection_status", ts, connection_id: id, state },
    }));
  }

  // --- Handovers -------------------------------------------------------
  function handover(run: () => Promise<void>): Promise<void> {
    settled = settled.then(run).catch((error) => {
      logger.warn("activity handover failed", { error });
    });
    return settled;
  }

  /** Bun records; `fromCore`: the core's recorder stops first. */
  function becomeBun(fromCore: boolean): Promise<void> {
    const wasHeld = mode === "held";
    if (holdTimer) {
      cancel(holdTimer);
      holdTimer = null;
    }
    mode = "switching";
    return handover(async () => {
      if (fromCore) {
        let timer: unknown = null;
        await Promise.race([
          core()
            ?.call("stop", {})
            .catch(() => undefined),
          new Promise<void>((resolve) => {
            timer = later(resolve, CORE_STOP_MS);
          }),
        ]);
        if (timer) cancel(timer);
      }
      if (stopped) return;
      recorder = deps.createRecorder();
      const pending = held;
      held = [];
      // A recorder that starts mid-life hears the connections as they are;
      // one that starts with the server hears them as they came.
      for (const entry of wasHeld ? pending : [...currentStates(), ...pending])
        replay(recorder, entry);
      mode = "bun";
      releaseHold?.();
      releaseHold = null;
    });
  }

  /** The core records; Bun's recorder stops first. */
  function becomeRust(): Promise<void> {
    const wasHeld = mode === "held";
    if (holdTimer) {
      cancel(holdTimer);
      holdTimer = null;
    }
    mode = "switching";
    return handover(async () => {
      const previous = recorder;
      recorder = null;
      await previous?.stop();
      if (stopped) return;
      await core()?.call("start", {});
      const pending = held;
      held = [];
      mode = "rust";
      for (const entry of wasHeld ? pending : [...currentStates(), ...pending])
        toCore(entry.signal);
      releaseHold?.();
      releaseHold = null;
    });
  }

  function ownershipChanged() {
    if (stopped) return;
    const side = core();
    const rust = !!side?.owned();
    if (mode === "held") {
      if (rust) void becomeRust();
      // The table no longer names Rust: no core to wait for.
      else if (!side?.expected()) void becomeBun(false);
      return;
    }
    if (mode === "switching") {
      // Settle first, then look again.
      void settled.then(() => ownershipChanged());
      return;
    }
    if (rust && mode === "bun") void becomeRust();
    else if (!rust && mode === "rust") void becomeBun(true);
  }

  async function decided(): Promise<void> {
    await holdDecided;
    while (mode === "switching") {
      const current = settled;
      await current;
      if (current === settled && mode === "switching")
        await new Promise<void>((resolve) => later(resolve, 50));
    }
  }

  return {
    async ready() {
      await decided();
      return mode === "bun" && recorder ? recorder.ready() : false;
    },
    connectionStatus(connectionId, state) {
      states.set(connectionId, state);
      signal({
        signal: {
          op: "connection_status",
          ts: now(),
          connection_id: connectionId,
          state,
        },
      });
    },
    herdrEvent(connectionId, event) {
      if (mode !== "bun" && !recordedHerdrEvent(event)) return;
      signal({
        signal: {
          op: "herdr_event",
          ts: now(),
          connection_id: connectionId,
          event,
        },
      });
    },
    paneList(connectionId, result, startedAt) {
      signal({
        signal: {
          op: "pane_list",
          ts: now(),
          connection_id: connectionId,
          result,
          started_at: startedAt,
        },
      });
    },
    ownedAgentChanged(connectionId, paneId) {
      signal({
        signal: {
          op: "owned_agent",
          ts: now(),
          connection_id: connectionId,
          pane_id: paneId,
        },
      });
    },
    async presence(socket, connectionId, params, ctx) {
      if (mode !== "bun") await decided();
      if (mode === "bun" && recorder)
        return recorder.presence(socket, connectionId, params);
      const side = core();
      if (mode === "rust" && side && ctx)
        return (await side.presence(params, ctx())) as PresenceReply;
      return { recording: false, idle_seconds: 300, attention: false };
    },
    socketClosed(socket) {
      signal({
        signal: {
          op: "socket_closed",
          ts: now(),
          socket_id: deps.socketId(socket),
        },
        socket,
      });
    },
    ownershipChanged,
    async settle() {
      await decided();
      while (sending || scheduled || outbox.length > 0)
        await new Promise<void>((resolve) => later(resolve, 5));
      if (mode === "bun" && recorder) {
        await recorder.flush();
        return;
      }
      if (mode === "rust") {
        let timer: unknown = null;
        await Promise.race([
          core()
            ?.call("flush", {})
            .catch(() => undefined),
          new Promise<void>((resolve) => {
            timer = later(resolve, CORE_STOP_MS);
          }),
        ]);
        if (timer) cancel(timer);
      }
    },
    async stop() {
      if (stopped) return;
      stopped = true;
      if (holdTimer) cancel(holdTimer);
      // Held signals go with the server: nobody recorded them.
      if (mode === "held") {
        releaseHold?.();
        releaseHold = null;
        return;
      }
      await settled;
      if (recorder) {
        await recorder.stop();
        return;
      }
      if (mode === "rust") {
        let timer: unknown = null;
        await Promise.race([
          core()
            ?.call("stop", {})
            .catch(() => undefined),
          new Promise<void>((resolve) => {
            timer = later(resolve, CORE_STOP_MS);
          }),
        ]);
        if (timer) cancel(timer);
      }
    },
    stopNow() {
      stopped = true;
      recorder?.stopNow();
    },
  };
}
