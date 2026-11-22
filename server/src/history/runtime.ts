import { stat } from "node:fs/promises";
import type { HistoryStatus } from "../../../shared/history";
import type { HistoryArea, ReviewSource } from "./area";
import { type HistorySink, setHistorySink, type WorkChange } from "./hooks";
import { type PassResult, HistoryRepo, type WorkCommit } from "./repo";
import { historyHost } from "./place";
import { workCommit, workDescriptionOf } from "./work";

/**
 * Local history in the server: the stores say what they wrote (hooks.ts),
 * the areas changed are kept as dirty sets (an area whole, or some of its
 * ids), and a pass commits them 30 s after the last change, at most 5 min
 * after the first (Debounce). Work changes are rendered as they happen and
 * committed one each. The areas kept in files are also watched by their
 * size and modification time, so hand edits are kept too. A full pass
 * runs a minute after the start (anything written while history was off,
 * or a hook missed). Never on a request path: git runs in child processes
 * at a low priority, one pass at a time; the start pass and `git gc` wait
 * while a game runs (GameMode), for up to 24 h.
 */

export const HISTORY_QUIET_MS = 30_000;
export const HISTORY_MAX_WAIT_MS = 5 * 60_000;
export const HISTORY_POLL_MS = 30_000;
export const HISTORY_START_DELAY_MS = 60_000;
/** A heavy pass waits this long at most for a game to end. */
export const HISTORY_DEFER_MAX_MS = 24 * 60 * 60_000;
export const HISTORY_DEFER_RETRY_MS = 10 * 60_000;
/** At shutdown, the last pass gets this long. */
export const HISTORY_STOP_MS = 5_000;

/**
 * Runs `run` `quietMs` after the last touch, and at most `maxMs` after the
 * first touch since it last ran.
 */
export class Debounce {
  private first: number | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly run: () => void,
    private readonly quietMs: number,
    private readonly maxMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  touch() {
    const now = this.now();
    this.first ??= now;
    const due = Math.min(now + this.quietMs, this.first + this.maxMs);
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.fire(), Math.max(0, due - now));
  }

  /** Runs now when something waits. */
  flush() {
    if (this.first !== null) this.fire();
  }

  get pending() {
    return this.first !== null;
  }

  cancel() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.first = null;
  }

  private fire() {
    this.cancel();
    this.run();
  }
}

export type HistoryPlace = {
  enabled: boolean;
  location: string;
  defaultLocation: string;
};

export type HistoryRuntimeOptions = {
  areas: HistoryArea[];
  /** Where the repo is and whether history is on, read before each pass. */
  place: () => Promise<HistoryPlace>;
  /** The review store, for a Work item's description as it is changed. */
  reviews: () => ReviewSource | null;
  host?: string;
  /** Whether a game runs (GameMode); null when it cannot tell. */
  gameMode?: () => Promise<boolean | null>;
  now?: () => number;
  log?: {
    warn(message: string, fields?: Record<string, unknown>): void;
    info?(message: string, fields?: Record<string, unknown>): void;
  };
  repo?: (dir: string, host: string) => HistoryRepo;
  quietMs?: number;
  maxWaitMs?: number;
  pollMs?: number;
  startDelayMs?: number;
};

type Dirty = Set<string> | "all";

export class HistoryRuntime implements HistorySink {
  private readonly dirty = new Map<string, Dirty>();
  private work: WorkCommit[] = [];
  private readonly debounce: Debounce;
  private running: Promise<PassResult | null> | null = null;
  private repo: HistoryRepo | null = null;
  private readonly host: string;
  private readonly now: () => number;
  private readonly signatures = new Map<string, string>();
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private startTimer: ReturnType<typeof setTimeout> | null = null;
  /** The full pass waits for a game since then; null when it does not wait. */
  private deferredSince: number | null = null;
  private fullPending = true;
  private stopped = false;
  private polling = false;

  constructor(private readonly options: HistoryRuntimeOptions) {
    this.host = (options.host ?? historyHost()).replace(
      /[^A-Za-z0-9.-]+/g,
      "-",
    );
    this.now = options.now ?? Date.now;
    this.debounce = new Debounce(
      () => void this.runPass(false),
      options.quietMs ?? HISTORY_QUIET_MS,
      options.maxWaitMs ?? HISTORY_MAX_WAIT_MS,
      this.now,
    );
  }

  /** Listens to the stores, watches the files, and plans the start pass. */
  start() {
    setHistorySink(this);
    const startDelay = this.options.startDelayMs ?? HISTORY_START_DELAY_MS;
    this.startTimer = setTimeout(() => void this.runPass(true), startDelay);
    this.startTimer.unref?.();
    const poll = this.options.pollMs ?? HISTORY_POLL_MS;
    if (poll > 0) {
      void this.poll(true);
      this.pollTimer = setInterval(() => void this.poll(false), poll);
      this.pollTimer.unref?.();
    }
  }

  /** Stops listening; the last changes are committed (a few seconds at most). */
  async stop() {
    if (this.stopped) return;
    this.stopped = true;
    setHistorySink(null);
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.startTimer) clearTimeout(this.startTimer);
    // Only into a repo a pass already wrote: a server stopped before its
    // start pass (a test's) makes none on its way out.
    const waiting =
      this.repo !== null && (this.debounce.pending || this.work.length > 0);
    this.debounce.cancel();
    const last = (async () => {
      await this.running;
      if (waiting) await this.pass(false, true);
    })();
    await Promise.race([
      last.catch(() => undefined),
      new Promise((resolve) => setTimeout(resolve, HISTORY_STOP_MS).unref?.()),
    ]);
  }

  changed(area: string, id?: string) {
    if (!this.options.areas.some((each) => each.name === area)) return;
    const current = this.dirty.get(area);
    if (id === undefined || current === "all") this.dirty.set(area, "all");
    else this.dirty.set(area, new Set([...(current ?? []), id]));
    if (!this.stopped) this.debounce.touch();
  }

  workChanged(change: WorkChange) {
    const description = change.item
      ? workDescriptionOf(this.options.reviews(), change.item)
      : null;
    this.work.push(workCommit(change, description, this.host));
    // Projects and the store's history.jsonl come with the next batch.
    this.changed("work", change.id);
  }

  /** A pass now: every area (`roamgate history commit`, Settings). */
  async commitNow(): Promise<PassResult | null> {
    this.debounce.cancel();
    await this.running;
    return this.runPass(true, true);
  }

  private runPass(full: boolean, force = false): Promise<PassResult | null> {
    if (this.running) {
      // One at a time: what is left goes with the next.
      if (full) this.fullPending = true;
      this.debounce.touch();
      return this.running;
    }
    const run = this.pass(full, force).finally(() => {
      this.running = null;
    });
    this.running = run;
    return run;
  }

  private async pass(full: boolean, force: boolean) {
    const place = await this.options.place();
    if (!place.enabled) {
      this.dirty.clear();
      this.work = [];
      return null;
    }
    if (!this.repo || this.repo.dir !== place.location) {
      this.repo =
        this.options.repo?.(place.location, this.host) ??
        new HistoryRepo({
          dir: place.location,
          host: this.host,
          lowPriority: true,
        });
      // A new place gets everything.
      this.fullPending = true;
    }
    full ||= this.fullPending;
    const gaming = (await this.options.gameMode?.().catch(() => null)) === true;
    if (full && gaming && !force) {
      this.deferredSince ??= this.now();
      if (this.now() - this.deferredSince < HISTORY_DEFER_MAX_MS) {
        // The whole pass waits for the game; the changes since go now.
        this.fullPending = true;
        full = false;
        this.retryLater(HISTORY_DEFER_RETRY_MS);
      }
    }
    if (full) this.deferredSince = null;
    if (!full && !this.dirty.size && !this.work.length) return null;
    const dirty = new Map(this.dirty);
    const work = this.work;
    this.dirty.clear();
    this.work = [];
    const areas = this.options.areas.flatMap((area) => {
      if (full) return [{ area, ids: null }];
      const marked = dirty.get(area.name);
      if (!marked) return [];
      return [{ area, ids: marked === "all" ? null : marked }];
    });
    const repo = this.repo;
    let result: PassResult;
    try {
      result = await repo.pass({ areas, work, light: gaming });
    } catch (error) {
      this.options.log?.warn("history pass failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
    if (result.locked) {
      // `roamgate history commit` runs: this one goes after it.
      for (const [name, marked] of dirty) {
        const current = this.dirty.get(name);
        this.dirty.set(
          name,
          marked === "all" || current === "all"
            ? "all"
            : new Set([...marked, ...(current ?? [])]),
        );
      }
      this.work = [...work, ...this.work];
      if (full) this.fullPending = true;
      this.retryLater(this.options.quietMs ?? HISTORY_QUIET_MS);
      return result;
    }
    if (full) this.fullPending = false;
    for (const error of result.errors)
      this.options.log?.warn("history: an area was not written", {
        area: error.area,
        error: error.message,
      });
    if (result.blocked.length)
      this.options.log?.warn("history: secrets kept out of the commit", {
        files: [...new Set(result.blocked.map((hit) => hit.file))],
      });
    return result;
  }

  private retryLater(ms: number) {
    if (this.stopped) return;
    const timer = setTimeout(() => void this.runPass(this.fullPending), ms);
    timer.unref?.();
  }

  /** The watched files' size and time: an area whose files moved is changed. */
  private async poll(baseline: boolean) {
    if (this.polling) return;
    this.polling = true;
    try {
      for (const area of this.options.areas) {
        if (!area.watch) continue;
        let paths: string[];
        try {
          paths = area.watch();
        } catch {
          continue;
        }
        const parts: string[] = [];
        for (const path of paths)
          try {
            const info = await stat(path);
            parts.push(`${path}:${info.size}:${info.mtimeMs}`);
          } catch {
            parts.push(`${path}:-`);
          }
        const signature = parts.join("\n");
        const before = this.signatures.get(area.name);
        this.signatures.set(area.name, signature);
        if (!baseline && before !== undefined && before !== signature)
          this.changed(area.name);
      }
    } finally {
      this.polling = false;
    }
  }

  async status(): Promise<HistoryStatus> {
    const place = await this.options.place();
    const repo =
      this.repo?.dir === place.location
        ? this.repo
        : new HistoryRepo({ dir: place.location, host: this.host });
    const status = await repo.status();
    return {
      enabled: place.enabled,
      location: place.location,
      defaultLocation: place.defaultLocation,
      ...status,
      pending: [
        ...new Set([
          ...this.dirty.keys(),
          ...(this.work.length ? ["work"] : []),
        ]),
      ].sort(),
      running: this.running !== null,
      deferred:
        this.deferredSince !== null
          ? "a game is running (GameMode): the full pass waits for it"
          : null,
    };
  }
}
