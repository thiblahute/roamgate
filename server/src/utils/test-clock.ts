/**
 * A controllable clock for scripted parity scenarios.
 *
 * With `ROAMGATE_TEST_CLOCK=<socket>` set on a server run from source, the
 * server's wall clock and timers are virtual: `Date`, `Date.now`,
 * `performance.now`, `setTimeout`, `setInterval`, their `clear*`
 * counterparts, `Bun.sleep` and `AbortSignal.timeout` all read and schedule
 * on this clock, and time only moves when the harness sends `advance <ms>`
 * on the socket. Unset, nothing here is installed and the server runs on
 * the real clock. The standalone binary refuses the variable: it is never
 * honoured in a release. The contract the Rust server follows is
 * `contract/wire/test-clock.md`.
 */
import { rmSync } from "node:fs";
import type { Socket } from "bun";
import { isStandaloneBinary } from "../config/standalone";

/**
 * The real clock and timers, as they were when this module loaded (before
 * any test clock is installed): for what must keep real time under the
 * test clock, like the liveness of the internal channel to the Rust core.
 */
export const realTimers = {
  setTimeout: globalThis.setTimeout.bind(globalThis),
  clearTimeout: globalThis.clearTimeout.bind(globalThis),
  setInterval: globalThis.setInterval.bind(globalThis),
  clearInterval: globalThis.clearInterval.bind(globalThis),
  now: Date.now.bind(Date),
};

export const TEST_CLOCK_ENV = "ROAMGATE_TEST_CLOCK";
/** Optional start time in epoch milliseconds; the real time when unset. */
export const TEST_CLOCK_EPOCH_ENV = "ROAMGATE_TEST_CLOCK_EPOCH";

type TimerCallback = (...args: never[]) => unknown;

type TimerEntry = {
  id: number;
  /** Virtual epoch milliseconds when it fires next. */
  due: number;
  /** Creation (or refresh) order: equal deadlines fire in this order. */
  seq: number;
  delay: number;
  /** Repeat period for an interval, null for a timeout. */
  period: number | null;
  callback: TimerCallback;
  args: unknown[];
  ref: boolean;
};

/** The handle a virtual timer returns, shaped like Bun's `Timer`. */
export class TestTimer {
  readonly #clock: TestClock;
  readonly id: number;

  constructor(clock: TestClock, id: number) {
    this.#clock = clock;
    this.id = id;
  }

  ref(): this {
    this.#clock.setTimerRef(this.id, true);
    return this;
  }

  unref(): this {
    this.#clock.setTimerRef(this.id, false);
    return this;
  }

  hasRef(): boolean {
    return this.#clock.timerHasRef(this.id);
  }

  refresh(): this {
    this.#clock.refreshTimer(this.id);
    return this;
  }

  close(): this {
    this.#clock.clearTimer(this.id);
    return this;
  }

  [Symbol.toPrimitive](): number {
    return this.id;
  }
}

/** Waits one real event-loop turn: pending promises and I/O callbacks run. */
type Settle = () => Promise<void>;

function realSettle(): Settle {
  const immediate = globalThis.setImmediate;
  return () => new Promise<void>((resolve) => immediate(resolve));
}

function wholeMs(value: unknown): number {
  const ms = Number(value);
  return Number.isFinite(ms) && ms > 0 ? Math.ceil(ms) : 0;
}

/**
 * The virtual time source and timer queue. Time never moves by itself:
 * timers due at the current instant (a zero delay) run on the next event
 * loop turn, later ones only when `advance` reaches them.
 */
export class TestClock {
  #now: number;
  readonly #epoch: number;
  readonly #monotonicBase: number;
  readonly #timers = new Map<number, TimerEntry>();
  readonly #settle: Settle;
  #nextId = 1;
  #nextSeq = 1;
  #work: Promise<unknown> = Promise.resolve();
  #drainQueued = false;
  #refListener: ((hasRef: boolean) => void) | null = null;
  #hadRef = false;
  #followers = new Set<(now: number) => Promise<unknown>>();
  #settlers = new Set<() => Promise<unknown>>();

  constructor(
    epoch: number,
    options: { monotonicBase?: number; settle?: Settle } = {},
  ) {
    this.#epoch = Math.floor(epoch);
    this.#now = this.#epoch;
    this.#monotonicBase = options.monotonicBase ?? 0;
    this.#settle = options.settle ?? realSettle();
  }

  /** Virtual epoch milliseconds, as `Date.now()` reads them. */
  now(): number {
    return this.#now;
  }

  /** Virtual `performance.now()`: the base plus virtual time elapsed. */
  monotonic(): number {
    return this.#monotonicBase + (this.#now - this.#epoch);
  }

  /** Virtual timers not yet fired or cleared. */
  pending(): number {
    return this.#timers.size;
  }

  /** Whether any pending timer would keep a real process alive. */
  hasRefTimers(): boolean {
    for (const entry of this.#timers.values()) if (entry.ref) return true;
    return false;
  }

  /** Called with hasRefTimers() whenever it changes. */
  onRefChange(listener: ((hasRef: boolean) => void) | null): void {
    this.#refListener = listener;
    this.#hadRef = this.hasRefTimers();
    listener?.(this.#hadRef);
  }

  setTimeout(
    callback: TimerCallback,
    delay?: unknown,
    args: unknown[] = [],
  ): TestTimer {
    return this.#add(callback, wholeMs(delay), null, args);
  }

  setInterval(
    callback: TimerCallback,
    delay?: unknown,
    args: unknown[] = [],
  ): TestTimer {
    const period = Math.max(1, wholeMs(delay));
    return this.#add(callback, period, period, args);
  }

  /** Clears a virtual timer by handle or id; anything else is ignored. */
  clear(handle: unknown): boolean {
    if (handle instanceof TestTimer) return this.clearTimer(handle.id);
    if (typeof handle === "number") return this.clearTimer(handle);
    return false;
  }

  clearTimer(id: number): boolean {
    const removed = this.#timers.delete(id);
    if (removed) this.#refChanged();
    return removed;
  }

  setTimerRef(id: number, ref: boolean): void {
    const entry = this.#timers.get(id);
    if (!entry || entry.ref === ref) return;
    entry.ref = ref;
    this.#refChanged();
  }

  timerHasRef(id: number): boolean {
    return this.#timers.get(id)?.ref ?? false;
  }

  refreshTimer(id: number): void {
    const entry = this.#timers.get(id);
    if (!entry) return;
    entry.due = this.#now + (entry.period ?? entry.delay);
    entry.seq = this.#nextSeq++;
    if (entry.due <= this.#now) this.#queueDrain();
  }

  /**
   * Moves time forward by `ms`, firing every timer due on the way in
   * deadline order with one real event-loop turn between them, and
   * resolves with the new time once the timers due at the end ran.
   * Concurrent advances run one after the other.
   */
  advance(ms: number): Promise<number> {
    if (!Number.isFinite(ms) || ms < 0 || !Number.isInteger(ms)) {
      return Promise.reject(
        new Error(`advance needs a whole number of ms >= 0: ${ms}`),
      );
    }
    return this.#serialised(async () => {
      // What is in flight across the processes lands first, at the time it
      // was sent (the Rust core's recorder answering a held signal).
      for (const settle of this.#settlers) {
        try {
          await settle();
        } catch {
          // The clock keeps going.
        }
      }
      const now = await this.#fireUntil(this.#now + ms);
      // What follows this clock (the Rust core's families) catches up
      // before the advance is answered.
      for (const follower of this.#followers) {
        try {
          await follower(now);
        } catch {
          // A follower that failed is behind; the clock keeps going.
        }
      }
      return now;
    });
  }

  /**
   * Calls `follower` with the new time after each `advance`, before the
   * advance resolves. Returns the unsubscribe.
   */
  follow(follower: (now: number) => Promise<unknown>): () => void {
    this.#followers.add(follower);
    return () => this.#followers.delete(follower);
  }

  /**
   * Awaits `settle` before each `advance` moves the time. Returns the
   * unsubscribe.
   */
  settleBefore(settle: () => Promise<unknown>): () => void {
    this.#settlers.add(settle);
    return () => this.#settlers.delete(settle);
  }

  #serialised(step: () => Promise<number>): Promise<number> {
    const run = this.#work.then(step, step);
    this.#work = run.catch(() => undefined);
    return run;
  }

  #add(
    callback: TimerCallback,
    delay: number,
    period: number | null,
    args: unknown[],
  ): TestTimer {
    const id = this.#nextId++;
    this.#timers.set(id, {
      id,
      due: this.#now + delay,
      seq: this.#nextSeq++,
      delay,
      period,
      callback,
      args,
      ref: true,
    });
    this.#refChanged();
    if (delay === 0) this.#queueDrain();
    return new TestTimer(this, id);
  }

  /** Runs the timers due now on a later turn, without moving time. */
  #queueDrain(): void {
    if (this.#drainQueued) return;
    this.#drainQueued = true;
    void this.#serialised(async () => {
      this.#drainQueued = false;
      return this.#fireUntil(this.#now);
    });
  }

  #earliest(limit: number): TimerEntry | null {
    let first: TimerEntry | null = null;
    for (const entry of this.#timers.values()) {
      if (entry.due > limit) continue;
      if (
        !first ||
        entry.due < first.due ||
        (entry.due === first.due && entry.seq < first.seq)
      ) {
        first = entry;
      }
    }
    return first;
  }

  async #fireUntil(target: number): Promise<number> {
    for (;;) {
      await this.#settle();
      const next = this.#earliest(target);
      if (!next) {
        if (this.#now >= target) return this.#now;
        this.#now = target;
        continue;
      }
      if (next.due > this.#now) this.#now = next.due;
      this.#fire(next);
    }
  }

  #fire(entry: TimerEntry): void {
    if (entry.period === null) {
      this.#timers.delete(entry.id);
      this.#refChanged();
    } else {
      entry.due += entry.period;
      entry.seq = this.#nextSeq++;
    }
    try {
      (entry.callback as (...args: unknown[]) => unknown)(...entry.args);
    } catch (error) {
      // As a real timer would: an uncaught error, not a stopped clock.
      queueMicrotask(() => {
        throw error;
      });
    }
  }

  #refChanged(): void {
    if (!this.#refListener) return;
    const hasRef = this.hasRefTimers();
    if (hasRef === this.#hadRef) return;
    this.#hadRef = hasRef;
    this.#refListener(hasRef);
  }
}

type ClockGlobals = {
  Date: DateConstructor;
  setTimeout: typeof globalThis.setTimeout;
  clearTimeout: typeof globalThis.clearTimeout;
  setInterval: typeof globalThis.setInterval;
  clearInterval: typeof globalThis.clearInterval;
  performance: { now: () => number };
  Bun: { sleep: (ms: number | Date) => Promise<void> };
  AbortSignal: { timeout: (ms: number) => AbortSignal };
};

/**
 * Routes the process's time and timers through `clock`, and returns what
 * puts the originals back (for tests). Timers created before stay real.
 */
let installed: TestClock | null = null;

/** The test clock the process runs on, if any. */
export function activeTestClock(): TestClock | null {
  return installed;
}

export function installTestClock(
  clock: TestClock,
  target: ClockGlobals = globalThis as unknown as ClockGlobals,
): () => void {
  const real = {
    Date: target.Date,
    setTimeout: target.setTimeout,
    clearTimeout: target.clearTimeout,
    setInterval: target.setInterval,
    clearInterval: target.clearInterval,
    performanceNow: target.performance.now,
    sleep: target.Bun.sleep,
    abortTimeout: target.AbortSignal.timeout,
  };
  const RealDate = real.Date;
  const now = () => clock.now();
  const VirtualDate = new Proxy(RealDate, {
    construct(date, args, newTarget) {
      return Reflect.construct(
        date,
        args.length === 0 ? [clock.now()] : args,
        newTarget,
      );
    },
    // `Date()` called as a function returns the current time as a string.
    apply() {
      return new RealDate(clock.now()).toString();
    },
    get(date, key, receiver) {
      if (key === "now") return now;
      return Reflect.get(date, key, receiver);
    },
  });
  const clearEither = (realClear: (handle: never) => void) =>
    function clear(handle?: unknown): void {
      if (handle === undefined || handle === null) return;
      if (handle instanceof TestTimer) {
        clock.clear(handle);
        return;
      }
      if (typeof handle === "number" && clock.clear(handle)) return;
      realClear(handle as never);
    };

  target.Date = VirtualDate;
  target.setTimeout = ((
    callback: TimerCallback,
    delay?: number,
    ...args: unknown[]
  ) =>
    clock.setTimeout(
      callback,
      delay,
      args,
    )) as unknown as typeof globalThis.setTimeout;
  target.setInterval = ((
    callback: TimerCallback,
    delay?: number,
    ...args: unknown[]
  ) =>
    clock.setInterval(
      callback,
      delay,
      args,
    )) as unknown as typeof globalThis.setInterval;
  target.clearTimeout = clearEither(
    real.clearTimeout as (handle: never) => void,
  );
  target.clearInterval = clearEither(
    real.clearInterval as (handle: never) => void,
  );
  target.performance.now = () => clock.monotonic();
  target.Bun.sleep = (ms: number | Date) =>
    new Promise<void>((resolve) => {
      const delay =
        ms instanceof RealDate ? ms.getTime() - clock.now() : Number(ms);
      clock.setTimeout(resolve, delay);
    });
  target.AbortSignal.timeout = (ms: number) => {
    const controller = new AbortController();
    clock
      .setTimeout(() => {
        controller.abort(
          new DOMException("The operation timed out.", "TimeoutError"),
        );
      }, ms)
      .unref();
    return controller.signal;
  };

  return () => {
    target.Date = real.Date;
    target.setTimeout = real.setTimeout;
    target.clearTimeout = real.clearTimeout;
    target.setInterval = real.setInterval;
    target.clearInterval = real.clearInterval;
    target.performance.now = real.performanceNow;
    target.Bun.sleep = real.sleep;
    target.AbortSignal.timeout = real.abortTimeout;
  };
}

type ControlSocket = { buffer: string; queue: Promise<void> };

/** One reply line for one request line of the control protocol. */
export async function answerTestClock(
  clock: TestClock,
  line: string,
): Promise<string> {
  const [command, argument, extra] = line.trim().split(/\s+/);
  if (command === "now" && argument === undefined) return String(clock.now());
  if (command === "advance" && argument !== undefined && extra === undefined) {
    if (!/^\d+$/.test(argument)) return `error bad duration: ${argument}`;
    try {
      return String(await clock.advance(Number(argument)));
    } catch (error) {
      return `error ${(error as Error).message}`;
    }
  }
  return `error unknown command: ${line.trim()}`;
}

/**
 * Serves the control protocol on a Unix socket: newline-terminated
 * requests, one reply line each, answered in order per connection. The
 * listener only keeps the process alive while a referenced timer waits.
 */
export function serveTestClock(
  clock: TestClock,
  path: string,
): { stop(): void } {
  rmSync(path, { force: true });
  const decoder = new TextDecoder();
  const listener = Bun.listen<ControlSocket>({
    unix: path,
    socket: {
      open(socket) {
        socket.data = { buffer: "", queue: Promise.resolve() };
      },
      data(socket: Socket<ControlSocket>, chunk) {
        const state = socket.data;
        state.buffer += decoder.decode(chunk, { stream: true });
        let newline = state.buffer.indexOf("\n");
        while (newline >= 0) {
          const line = state.buffer.slice(0, newline);
          state.buffer = state.buffer.slice(newline + 1);
          newline = state.buffer.indexOf("\n");
          if (!line.trim()) continue;
          state.queue = state.queue.then(async () => {
            socket.write(`${await answerTestClock(clock, line)}\n`);
          });
        }
      },
    },
  });
  clock.onRefChange((hasRef) => {
    if (hasRef) listener.ref();
    else listener.unref();
  });
  return {
    stop() {
      clock.onRefChange(null);
      listener.stop(true);
      rmSync(path, { force: true });
    },
  };
}

/**
 * Installs the test clock when `ROAMGATE_TEST_CLOCK` names a socket, and
 * returns it; null (and nothing installed) otherwise. The variables are
 * removed from the environment so child processes keep the real clock.
 */
export function installTestClockFromEnv(
  environment: Record<string, string | undefined> = process.env,
  runtime: { execPath: string; argv: readonly string[] } = process,
): TestClock | null {
  const path = environment[TEST_CLOCK_ENV];
  if (!path) return null;
  if (isStandaloneBinary(runtime)) {
    throw new Error(
      `${TEST_CLOCK_ENV} is only honoured when the server runs from source, never by the standalone binary.`,
    );
  }
  const epochText = environment[TEST_CLOCK_EPOCH_ENV];
  const epoch = epochText ? Number(epochText) : Date.now();
  if (!Number.isSafeInteger(epoch) || epoch < 0) {
    throw new Error(
      `${TEST_CLOCK_EPOCH_ENV} must be epoch milliseconds: ${epochText}`,
    );
  }
  delete environment[TEST_CLOCK_ENV];
  delete environment[TEST_CLOCK_EPOCH_ENV];
  const clock = new TestClock(epoch, { monotonicBase: performance.now() });
  installTestClock(clock);
  installed = clock;
  serveTestClock(clock, path);
  return clock;
}
