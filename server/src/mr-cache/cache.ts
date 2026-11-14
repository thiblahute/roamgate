import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { dataRoot, replaceDataFile } from "../config/data-paths";

/**
 * One server-side cache of what the UI shows of merge and pull requests,
 * shared by every surface (workspace chips and card, the chats' chips and
 * session list) and every client. Stale-while-revalidate: a known answer is
 * served at once, and re-read in the background only when it is older than
 * its state allows, one forge call serving all who wait for it, within a
 * budget of background reads per minute and never while the forge asked to be
 * left alone. It lives in `<data>/mr-cache/state.json` so that a restart does
 * not start cold, and tells the clients when an answer changes.
 */

/** The TTLs, budget and size of the cache (`mr_cache` in settings.json). */
export type MrCacheSettings = {
  /** An open request whose pipeline runs: it may finish any time. */
  runningMs: number;
  /** An open request at rest: titles, approvals and threads move slowly. */
  openMs: number;
  /** Merged, closed or gone: next to nothing changes. */
  settledMs: number;
  /** A branch without a request: one may be opened. */
  noneMs: number;
  /** No login, no CLI, an unsupported host: until the user fixes it. */
  unavailableMs: number;
  /** Background reads started per minute, all forges together. */
  budgetPerMinute: number;
  /** Answers kept, the oldest forgotten first. */
  maxEntries: number;
};

export const DEFAULT_MR_CACHE_SETTINGS: MrCacheSettings = {
  runningMs: 75_000,
  openMs: 10 * 60_000,
  settledMs: 6 * 60 * 60_000,
  noneMs: 15 * 60_000,
  unavailableMs: 10 * 60_000,
  budgetPerMinute: 20,
  maxEntries: 1000,
};

/** The shape settings.json keeps (`mr_cache`): seconds, absent: default. */
export type StoredMrCacheSettings = {
  running_seconds?: number;
  open_seconds?: number;
  settled_seconds?: number;
  none_seconds?: number;
  unavailable_seconds?: number;
  budget_per_minute?: number;
  max_entries?: number;
};

function bounded(
  value: unknown,
  min: number,
  max: number,
  fallback: number,
): number {
  return typeof value === "number" &&
    Number.isInteger(value) &&
    value >= min &&
    value <= max
    ? value
    : fallback;
}

/** Fills defaults in and drops invalid values, field by field. */
export function normalizeMrCacheSettings(raw: unknown): MrCacheSettings {
  const obj =
    raw && typeof raw === "object" && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};
  const d = DEFAULT_MR_CACHE_SETTINGS;
  const seconds = (value: unknown, fallback: number) =>
    bounded(value, 5, 30 * 24 * 3600, fallback / 1000) * 1000;
  return {
    runningMs: seconds(obj.running_seconds, d.runningMs),
    openMs: seconds(obj.open_seconds, d.openMs),
    settledMs: seconds(obj.settled_seconds, d.settledMs),
    noneMs: seconds(obj.none_seconds, d.noneMs),
    unavailableMs: seconds(obj.unavailable_seconds, d.unavailableMs),
    budgetPerMinute: bounded(obj.budget_per_minute, 1, 600, d.budgetPerMinute),
    maxEntries: bounded(obj.max_entries, 50, 20_000, d.maxEntries),
  };
}

export function mrCachePath(root = dataRoot()): string {
  return join(root, "mr-cache", "state.json");
}

type Stored = {
  value: unknown;
  fetchedAt: number;
  ttlMs: number;
  /** What the checkout's HEAD was when it was read (card answers). */
  head?: string;
};

/** What a read of the cache gives. */
export type MrCacheAnswer<T> = {
  value: T;
  /** Epoch ms of the forge read the value comes from. */
  fetchedAt: number;
  /** Older than its state allows: a read is under way or deferred. */
  stale: boolean;
};

export type MrCacheChange = {
  key: string;
  value: unknown;
  fetchedAt: number;
};

export type SwrOptions<T> = {
  /** How long a value stands, by what it says; 0: never kept. */
  ttl: (value: T) => number;
  /** The forge read. A rejection keeps what was known. */
  load: () => Promise<T>;
  /** Where the checkout's HEAD is (card answers); null: unknown. */
  head?: () => Promise<string | null>;
  /** A click on refresh: read now, ignoring TTL, budget and pauses. */
  fresh?: boolean;
  /** A failure answer: not kept, and the next read waits (backoff). */
  failed?: (value: T) => boolean;
  /** Epoch ms until which the forge asked to be left alone. */
  pausedUntil?: (value: T | undefined) => number;
};

/** The ref half of a `ref\ncommit` HEAD description. */
function headRef(head: string | undefined | null): string {
  return head ? (head.split("\n")[0] ?? "") : "";
}

export function createMrCache(
  options: {
    path?: string | null;
    now?: () => number;
    settings?: () => MrCacheSettings;
    /** Tells the clients an answer changed. */
    publish?: (change: MrCacheChange) => void;
    /** Delays the write to disk; tests use 0. */
    saveDelayMs?: number;
  } = {},
) {
  const now = options.now ?? (() => Date.now());
  const settings = options.settings ?? (() => DEFAULT_MR_CACHE_SETTINGS);
  const path = options.path === undefined ? mrCachePath() : options.path;
  const saveDelayMs = options.saveDelayMs ?? 2_000;
  const entries = new Map<string, Stored>();
  const inFlight = new Map<string, Promise<unknown>>();
  const failures = new Map<string, { count: number; retryAt: number }>();
  /** When background reads started in the last minute began. */
  let started: number[] = [];
  let timer: ReturnType<typeof setTimeout> | null = null;

  if (path && existsSync(path)) {
    try {
      const raw = JSON.parse(readFileSync(path, "utf8")) as {
        entries?: [string, Stored][];
      };
      for (const [key, entry] of raw.entries ?? [])
        if (
          typeof key === "string" &&
          entry &&
          Number.isFinite(entry.fetchedAt) &&
          Number.isFinite(entry.ttlMs)
        )
          entries.set(key, entry);
    } catch {
      // A broken file starts over; the forges have the rest.
    }
  }

  function save() {
    if (!path) return;
    const write = () => {
      timer = null;
      try {
        mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
        replaceDataFile(
          path,
          `${JSON.stringify({ version: 1, entries: [...entries] })}\n`,
        );
      } catch {
        // The cache is only a speed up.
      }
    };
    if (saveDelayMs <= 0) write();
    else timer ??= setTimeout(write, saveDelayMs);
  }

  function put(key: string, value: unknown, ttlMs: number, head?: string) {
    entries.set(key, {
      value,
      fetchedAt: now(),
      ttlMs,
      ...(head ? { head } : {}),
    });
    const cap = settings().maxEntries;
    if (entries.size > cap) {
      const oldest = [...entries].sort(
        (a, b) => a[1].fetchedAt - b[1].fetchedAt,
      );
      for (const [each] of oldest.slice(0, entries.size - cap))
        entries.delete(each);
    }
    save();
  }

  function budgetLeft(): boolean {
    const at = now();
    started = started.filter((when) => when > at - 60_000);
    return started.length < settings().budgetPerMinute;
  }

  /** Reads once however many ask, keeps the answer, tells the clients. */
  function read<T>(key: string, o: SwrOptions<T>): Promise<T | undefined> {
    const flying = inFlight.get(key);
    if (flying) return flying as Promise<T | undefined>;
    started.push(now());
    const task = (async () => {
      const head = o.head ? await o.head() : null;
      let value: T;
      try {
        value = await o.load();
      } catch (error) {
        bumpFailure(key, undefined, o);
        throw error;
      }
      const ttl = o.ttl(value);
      if (o.failed?.(value)) {
        bumpFailure(key, value, o);
        return value;
      }
      failures.delete(key);
      if (ttl > 0) {
        put(key, value, ttl, head ?? undefined);
        options.publish?.({
          key,
          value,
          fetchedAt: entries.get(key)!.fetchedAt,
        });
      } else entries.delete(key);
      return value;
    })().finally(() => {
      if (inFlight.get(key) === task) inFlight.delete(key);
    });
    inFlight.set(key, task);
    return task;
  }

  function bumpFailure<T>(key: string, value: T | undefined, o: SwrOptions<T>) {
    const count = (failures.get(key)?.count ?? 0) + 1;
    const backoff = Math.min(30_000 * 2 ** (count - 1), 10 * 60_000);
    const paused = o.pausedUntil?.(value) ?? 0;
    failures.set(key, {
      count,
      retryAt: Math.max(now() + backoff, paused),
    });
  }

  return {
    /** The value known for a key, whatever its age. */
    peek<T>(key: string): MrCacheAnswer<T> | undefined {
      const known = entries.get(key);
      if (!known) return undefined;
      return {
        value: known.value as T,
        fetchedAt: known.fetchedAt,
        stale: now() - known.fetchedAt >= known.ttlMs,
      };
    },
    /**
     * The value for a key: known and young, at once; known and old, at
     * once too while a background read (if the budget and the forge allow
     * it) replaces it; unknown, after the read.
     */
    async get<T>(key: string, o: SwrOptions<T>): Promise<MrCacheAnswer<T>> {
      const at = now();
      const known = entries.get(key);
      const head = o.head && known ? await o.head() : null;
      const sameSubject =
        !known ||
        !o.head ||
        head === null ||
        headRef(known.head) === "" ||
        headRef(known.head) === headRef(head);
      const reusable = !!known && sameSubject;
      const moved = !!known && !!head && !!known.head && known.head !== head;
      const paused = failures.get(key)?.retryAt ?? 0;
      if (known && reusable && !o.fresh) {
        const age = at - known.fetchedAt;
        const due = age >= known.ttlMs || moved;
        if (!due)
          return {
            value: known.value as T,
            fetchedAt: known.fetchedAt,
            stale: false,
          };
        const blocked =
          paused > at ||
          (o.pausedUntil?.(known.value as T) ?? 0) > at ||
          (!inFlight.has(key) && !budgetLeft());
        if (!blocked)
          void read(key, o).catch(() => {
            // Kept: the next ask retries after its backoff.
          });
        return {
          value: known.value as T,
          fetchedAt: known.fetchedAt,
          stale: true,
        };
      }
      // Nothing usable, or asked to read now.
      const value = (await read(key, o)) as T;
      // A refresh that failed does not take the known answer away.
      if (known && reusable && o.failed?.(value))
        return {
          value: known.value as T,
          fetchedAt: known.fetchedAt,
          stale: true,
        };
      const fresh = entries.get(key);
      return {
        value,
        fetchedAt: fresh?.fetchedAt ?? now(),
        stale: false,
      };
    },
    /** Facts known elsewhere: a push, a merge. Forgets what matches. */
    invalidate(matches: (key: string) => boolean) {
      let changed = false;
      for (const key of [...entries.keys()])
        if (matches(key)) {
          entries.delete(key);
          failures.delete(key);
          changed = true;
        }
      if (changed) save();
    },
    /** Hands a value read elsewhere (the reviews inbox) to the cache. */
    offer<T>(key: string, value: T, ttlMs: number, head?: string) {
      if (ttlMs <= 0) return;
      put(key, value, ttlMs, head);
      options.publish?.({ key, value, fetchedAt: entries.get(key)!.fetchedAt });
    },
    settings,
    size: () => entries.size,
    /** Writes now (shutdown, tests). */
    flush() {
      if (timer) clearTimeout(timer);
      timer = null;
      if (!path) return;
      try {
        mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
        replaceDataFile(
          path,
          `${JSON.stringify({ version: 1, entries: [...entries] })}\n`,
        );
      } catch {
        // See save().
      }
    },
  };
}

export type MrCache = ReturnType<typeof createMrCache>;
