import {
  type LimitPause,
  type LimitPauseState,
  type LimitResumeSettings,
  type UsageLimitStop,
  usageLimitStop,
} from "../../../shared/limitResume";
import type { LimitResumeStore } from "./store";

/** A pane running a Claude session, terminal or conversation mode. */
export type LimitPane = {
  paneId: string;
  sessionId: string;
  owner: "terminal" | "conversation";
  /** Herdr's (or conversation mode's) agent status; asleep is idle. */
  status: string;
};

/** What the resumer needs of a connection (local or SSH). */
export type LimitConnection = {
  id: string;
  /** The panes running a Claude session, asleep conversations included. */
  panes: () => Promise<LimitPane[]>;
  /** The end of the pane session's transcript, or null. */
  transcriptTail: (paneId: string) => Promise<string | null>;
  /**
   * Sends text to the session as the user would: conversation mode's
   * queue (waking it), else typed into the idle terminal (agent.prompt).
   */
  deliver: (pane: LimitPane, text: string) => Promise<void>;
};

/** A pause seen in time but overdue by more than this is not resumed. */
export const LIMIT_RESUME_STALE_MS = 24 * 60 * 60_000;

type Entry = {
  pane: LimitPane;
  stop: UsageLimitStop;
  state: LimitPauseState;
  resumeAt: number | null;
  resumedAt?: number;
  reason?: string;
};

type Cached = {
  sessionId: string;
  status: string;
  readAt: number;
  stop: UsageLimitStop | null;
};

type Failure = { count: number; at: number; reason: string };

/** A pane's agent is busy: neither paused nor to be typed into. */
function busy(status: string): boolean {
  return status === "working" || status === "blocked";
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Resumes the sessions a usage limit stopped, once it resets. Every
 * connection's Claude panes are looked at (each scan), and a session whose
 * transcript ends on a usage-limit stop is paused until its reset: at the
 * reset plus the margin, if its transcript still ends on that stop and the
 * user did not say "Don't resume", it is sent the resume message, once per
 * reset. A pause seen in time is resumed after a restart too (the store
 * keeps it); one whose time passed before Roamgate saw it waits for the
 * user's "Resume now".
 */
export function createLimitResumer(options: {
  connections: () => LimitConnection[];
  settings: () => Promise<LimitResumeSettings>;
  store: LimitResumeStore;
  /** The connection's paused sessions changed (browsers are told). */
  onChange?: (connectionId: string, pauses: LimitPause[]) => void;
  log?: (
    level: "info" | "warn",
    message: string,
    fields?: Record<string, unknown>,
  ) => void;
  now?: () => number;
  /** How often every session is looked at. */
  scanEveryMs?: number;
  /** A stopped session's transcript is read again at least this often. */
  rereadMs?: number;
  /** A busy terminal or a failed send is tried again after this. */
  retryMs?: number;
  /** Sends tried for one reset before giving up. */
  maxAttempts?: number;
  /** A look asked for (poke) waits this long, for others to join. */
  pokeDelayMs?: number;
  /** After a send, how long its transcript has to show it. */
  sentGuardMs?: number;
}) {
  const now = options.now ?? Date.now;
  const scanEveryMs = options.scanEveryMs ?? 60_000;
  const rereadMs = options.rereadMs ?? 5 * 60_000;
  const retryMs = options.retryMs ?? 30_000;
  const maxAttempts = options.maxAttempts ?? 5;
  const pokeDelayMs = options.pokeDelayMs ?? 2_000;
  const sentGuardMs = options.sentGuardMs ?? 2 * 60_000;
  const { store } = options;
  /** Connection id, then pane id. */
  const pauses = new Map<string, Map<string, Entry>>();
  const cache = new Map<string, Cached>();
  const timers = new Map<
    string,
    { at: number; timer: ReturnType<typeof setTimeout> }
  >();
  /** By session and reset. */
  const failures = new Map<string, Failure>();
  /** A send under way or just made, by session: never two at once. */
  const sending = new Map<string, number>();
  const scans = new Map<string, Promise<void>>();
  const again = new Set<string>();
  const pokes = new Map<string, ReturnType<typeof setTimeout>>();
  const emitted = new Map<string, string>();
  let interval: ReturnType<typeof setInterval> | null = null;
  let first: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;

  const keyOf = (connectionId: string, paneId: string) =>
    `${connectionId}\n${paneId}`;
  const failureKey = (sessionId: string, resetsAt: number) =>
    `${sessionId}\n${resetsAt}`;
  const log = (
    level: "info" | "warn",
    message: string,
    fields?: Record<string, unknown>,
  ) => options.log?.(level, message, fields);

  /** The stop the pane's transcript ends on, read again when needed. */
  async function readStop(
    connection: LimitConnection,
    pane: LimitPane,
    fresh: boolean,
  ): Promise<UsageLimitStop | null> {
    const key = keyOf(connection.id, pane.paneId);
    const cached = cache.get(key);
    // Read whatever Herdr says of the pane: its status may lag the stop.
    if (
      !fresh &&
      cached &&
      cached.sessionId === pane.sessionId &&
      cached.status === pane.status &&
      now() - cached.readAt < rereadMs
    )
      return cached.stop;
    let tail: string | null;
    try {
      tail = await connection.transcriptTail(pane.paneId);
    } catch {
      // Unread (the host did not answer): what was known stays.
      return cached?.sessionId === pane.sessionId ? cached.stop : null;
    }
    const stop = tail ? usageLimitStop(tail) : null;
    cache.set(key, {
      sessionId: pane.sessionId,
      status: pane.status,
      readAt: now(),
      stop,
    });
    return stop;
  }

  /** What becomes of a pause now, and when it is resumed. */
  function stateOf(
    pane: LimitPane,
    stop: UsageLimitStop,
    settings: LimitResumeSettings,
  ): Pick<Entry, "state" | "resumeAt" | "resumedAt" | "reason"> {
    const record = store.get(pane.sessionId);
    const resumeAt = stop.resets_at + settings.margin_seconds * 1000;
    if (record?.resumed === stop.resets_at) {
      const at = record.resumed_at ? Date.parse(record.resumed_at) : NaN;
      return {
        state: "resumed",
        resumeAt: null,
        ...(Number.isFinite(at) ? { resumedAt: at } : {}),
      };
    }
    if (!settings.enabled) return { state: "off", resumeAt: null };
    if (record?.skip) return { state: "skipped", resumeAt: null };
    const failure = failures.get(failureKey(pane.sessionId, stop.resets_at));
    // Just sent ("Resume now"): its transcript may not show it yet.
    const sent = sending.get(pane.sessionId);
    const notBefore =
      sent !== undefined && now() - sent < sentGuardMs ? sent + sentGuardMs : 0;
    if (failure) {
      if (failure.count >= maxAttempts)
        return { state: "failed", resumeAt: null, reason: failure.reason };
      return {
        state: "failed",
        resumeAt: Math.max(resumeAt, failure.at + retryMs, notBefore),
        reason: failure.reason,
      };
    }
    if (now() < resumeAt) {
      store.seen(pane.sessionId, stop.resets_at);
      return { state: "scheduled", resumeAt: Math.max(resumeAt, notBefore) };
    }
    // Due: resumed only when it was seen paused in time, and not long ago.
    if (
      record?.seen === stop.resets_at &&
      now() - resumeAt < LIMIT_RESUME_STALE_MS
    )
      return { state: "scheduled", resumeAt: Math.max(resumeAt, notBefore) };
    return { state: "missed", resumeAt: null };
  }

  function toPause(connectionId: string, entry: Entry): LimitPause {
    return {
      connection_id: connectionId,
      pane_id: entry.pane.paneId,
      session_id: entry.pane.sessionId,
      owner: entry.pane.owner,
      kind: entry.stop.kind,
      resets_at: entry.stop.resets_at,
      resume_at: entry.resumeAt,
      stopped_at: entry.stop.stopped_at,
      state: entry.state,
      ...(entry.resumedAt !== undefined ? { resumed_at: entry.resumedAt } : {}),
      ...(entry.reason ? { reason: entry.reason } : {}),
      message: entry.stop.message,
    };
  }

  function list(connectionId: string): LimitPause[] {
    return [...(pauses.get(connectionId)?.values() ?? [])]
      .map((entry) => toPause(connectionId, entry))
      .sort((a, b) => a.pane_id.localeCompare(b.pane_id));
  }

  function emit(connectionId: string) {
    const pausesNow = list(connectionId);
    const text = JSON.stringify(pausesNow);
    if (emitted.get(connectionId) === text) return;
    emitted.set(connectionId, text);
    options.onChange?.(connectionId, pausesNow);
  }

  function clearTimer(key: string) {
    const timer = timers.get(key);
    if (!timer) return;
    clearTimeout(timer.timer);
    timers.delete(key);
  }

  function schedule(connectionId: string, paneId: string, at: number) {
    const key = keyOf(connectionId, paneId);
    if (timers.get(key)?.at === at) return;
    clearTimer(key);
    // Within setTimeout's range; the next scan sets it again meanwhile.
    const delay = Math.min(Math.max(0, at - now()), 2 ** 31 - 1);
    const timer = setTimeout(() => {
      timers.delete(key);
      void fire(connectionId, paneId);
    }, delay);
    (timer as { unref?: () => void }).unref?.();
    timers.set(key, { at, timer });
  }

  function connectionNamed(connectionId: string) {
    return options.connections().find((each) => each.id === connectionId);
  }

  async function scanConnection(connection: LimitConnection): Promise<void> {
    const settings = await options.settings();
    let panes: LimitPane[];
    try {
      panes = await connection.panes();
    } catch {
      // Herdr did not answer: what was known stays until the next scan.
      return;
    }
    const previous = pauses.get(connection.id) ?? new Map<string, Entry>();
    const next = new Map<string, Entry>();
    const present = new Set<string>();
    for (const pane of panes) {
      present.add(pane.paneId);
      const stop = await readStop(connection, pane, false);
      if (!stop) continue;
      const before = previous.get(pane.paneId);
      if (
        before?.state === "resuming" &&
        before.pane.sessionId === pane.sessionId &&
        before.stop.resets_at === stop.resets_at
      ) {
        next.set(pane.paneId, { ...before, pane });
        continue;
      }
      next.set(pane.paneId, { pane, stop, ...stateOf(pane, stop, settings) });
    }
    for (const key of [...cache.keys()]) {
      const [connectionId, paneId] = key.split("\n");
      if (connectionId === connection.id && !present.has(paneId!))
        cache.delete(key);
    }
    pauses.set(connection.id, next);
    for (const [paneId, entry] of next) {
      if (
        (entry.state === "scheduled" || entry.state === "failed") &&
        entry.resumeAt !== null
      )
        schedule(connection.id, paneId, entry.resumeAt);
      else clearTimer(keyOf(connection.id, paneId));
    }
    for (const key of [...timers.keys()]) {
      const [connectionId, paneId] = key.split("\n");
      if (connectionId === connection.id && !next.has(paneId!)) clearTimer(key);
    }
    emit(connection.id);
  }

  /** Looks at a connection's sessions; one look at a time per connection. */
  function scan(connectionId: string): Promise<void> {
    const running = scans.get(connectionId);
    if (running) {
      again.add(connectionId);
      return running;
    }
    const connection = connectionNamed(connectionId);
    if (!connection) return Promise.resolve();
    const run = scanConnection(connection)
      .catch((error: unknown) =>
        log("warn", "usage limit check failed", {
          connection: connectionId,
          error: errorText(error),
        }),
      )
      .finally(() => {
        scans.delete(connectionId);
        if (again.delete(connectionId) && !stopped) void scan(connectionId);
      });
    scans.set(connectionId, run);
    return run;
  }

  /** Looks at every connection; those gone lose their pauses. */
  async function scanAll(): Promise<void> {
    const connections = options.connections();
    const ids = new Set(connections.map((each) => each.id));
    for (const connectionId of [...pauses.keys()]) {
      if (ids.has(connectionId)) continue;
      pauses.delete(connectionId);
      for (const key of [...timers.keys()])
        if (key.startsWith(`${connectionId}\n`)) clearTimer(key);
      emit(connectionId);
    }
    await Promise.all(connections.map((each) => scan(each.id)));
  }

  /**
   * Sends the resume message. A manual one ("Resume now") before the
   * reset is not counted as the reset's resume: if the limit stops it
   * again, the reset still resumes it.
   */
  async function send(
    connection: LimitConnection,
    pane: LimitPane,
    stop: UsageLimitStop,
    text: string,
    how: "auto" | "manual",
  ): Promise<{ ok: boolean; reason?: string }> {
    const key = keyOf(connection.id, pane.paneId);
    const entries = pauses.get(connection.id) ?? new Map<string, Entry>();
    pauses.set(connection.id, entries);
    const entry: Entry = entries.get(pane.paneId) ?? {
      pane,
      stop,
      state: "resuming",
      resumeAt: null,
    };
    entries.set(pane.paneId, { ...entry, state: "resuming", resumeAt: null });
    clearTimer(key);
    emit(connection.id);
    sending.set(pane.sessionId, now());
    const failed = failureKey(pane.sessionId, stop.resets_at);
    try {
      await connection.deliver(pane, text);
    } catch (error) {
      sending.delete(pane.sessionId);
      const reason = errorText(error);
      if (how === "auto") {
        const count = (failures.get(failed)?.count ?? 0) + 1;
        failures.set(failed, { count, at: now(), reason });
      }
      log("warn", "could not resume a session after its usage limit", {
        connection: connection.id,
        pane: pane.paneId,
        session: pane.sessionId,
        owner: pane.owner,
        how,
        error: reason,
      });
      entries.delete(pane.paneId);
      cache.delete(key);
      await scan(connection.id);
      return { ok: false, reason };
    }
    failures.delete(failed);
    if (now() >= stop.resets_at) store.resumed(pane.sessionId, stop.resets_at);
    log("info", "session resumed after its usage limit", {
      connection: connection.id,
      pane: pane.paneId,
      session: pane.sessionId,
      owner: pane.owner,
      how,
      kind: stop.kind,
      resets_at: new Date(stop.resets_at).toISOString(),
    });
    entries.delete(pane.paneId);
    emit(connection.id);
    // Its transcript shows the message shortly: looked at again then.
    cache.delete(key);
    poke(connection.id, pane.paneId);
    return { ok: true };
  }

  /** A pause's time came: resumed if nothing changed meanwhile. */
  async function fire(connectionId: string, paneId: string): Promise<void> {
    if (stopped) return;
    const connection = connectionNamed(connectionId);
    if (!connection) return;
    const settings = await options.settings();
    const panes = await connection.panes().catch(() => null);
    if (!panes) {
      schedule(connectionId, paneId, now() + retryMs);
      return;
    }
    const pane = panes.find((each) => each.paneId === paneId);
    const entry = pauses.get(connectionId)?.get(paneId);
    if (!pane || !entry || pane.sessionId !== entry.pane.sessionId) {
      await scan(connectionId);
      return;
    }
    // Busy (a question, a turn): tried again shortly, never typed into.
    if (busy(pane.status)) {
      schedule(connectionId, paneId, now() + retryMs);
      return;
    }
    const stop = await readStop(connection, pane, true);
    const due = stop ? stateOf(pane, stop, settings) : null;
    if (
      !stop ||
      !due ||
      (due.state !== "scheduled" && due.state !== "failed") ||
      due.resumeAt === null ||
      due.resumeAt > now()
    ) {
      // Resumed by the user, stopped on another reset, or not wanted.
      await scan(connectionId);
      return;
    }
    await send(connection, pane, stop, settings.message, "auto");
  }

  function poke(connectionId: string, paneId?: string) {
    if (stopped) return;
    if (paneId) cache.delete(keyOf(connectionId, paneId));
    if (pokes.has(connectionId)) return;
    const timer = setTimeout(() => {
      pokes.delete(connectionId);
      void scan(connectionId);
    }, pokeDelayMs);
    (timer as { unref?: () => void }).unref?.();
    pokes.set(connectionId, timer);
  }

  return {
    /** Starts looking: soon, then every scanEveryMs. */
    start(firstDelayMs = 5_000) {
      if (interval || stopped) return;
      first = setTimeout(() => {
        first = null;
        void scanAll();
      }, firstDelayMs);
      (first as { unref?: () => void }).unref?.();
      interval = setInterval(() => void scanAll(), scanEveryMs);
      (interval as { unref?: () => void }).unref?.();
    },
    stop() {
      stopped = true;
      if (interval) clearInterval(interval);
      if (first) clearTimeout(first);
      interval = null;
      for (const key of [...timers.keys()]) clearTimer(key);
      for (const timer of pokes.values()) clearTimeout(timer);
      pokes.clear();
    },
    scan,
    scanAll,
    /** Something changed in a pane (a turn ended): looked at shortly. */
    poke,
    /** The connection's paused sessions. */
    list,
    /** "Resume now": sends the message at once, whatever the time. */
    async resumeNow(
      connectionId: string,
      paneId: string,
    ): Promise<{ ok: boolean; reason?: string }> {
      const connection = connectionNamed(connectionId);
      const entry = pauses.get(connectionId)?.get(paneId);
      if (!connection || !entry)
        return {
          ok: false,
          reason: "The session is not paused by a usage limit",
        };
      const panes = await connection.panes().catch(() => null);
      const pane = panes?.find((each) => each.paneId === paneId);
      if (!pane || pane.sessionId !== entry.pane.sessionId)
        return { ok: false, reason: "The pane runs another session now" };
      // The user's call while it works; never typed into a question.
      if (pane.status === "blocked")
        return { ok: false, reason: "The agent is asking something" };
      if (entry.state === "resuming")
        return { ok: false, reason: "It is being resumed" };
      const settings = await options.settings();
      return send(connection, pane, entry.stop, settings.message, "manual");
    },
    /** "Don't resume" (true) for the pane's session, or undone (false). */
    async setSkip(
      connectionId: string,
      paneId: string,
      skip: boolean,
    ): Promise<{ ok: boolean; reason?: string }> {
      const entry = pauses.get(connectionId)?.get(paneId);
      if (!entry)
        return {
          ok: false,
          reason: "The session is not paused by a usage limit",
        };
      store.setSkip(entry.pane.sessionId, skip);
      log(
        "info",
        skip
          ? "usage limit resume declined"
          : "usage limit resume wanted again",
        {
          connection: connectionId,
          pane: paneId,
          session: entry.pane.sessionId,
        },
      );
      await scan(connectionId);
      return { ok: true };
    },
  };
}

export type LimitResumer = ReturnType<typeof createLimitResumer>;
