import { mrCacheSettings, peekGuiSettings } from "../config/gui-settings";
import { bunOwns, onOwnershipChanged } from "../core-channel/owners";
import {
  type MrCache,
  type MrCacheAnswer,
  type MrCacheChange,
  type SwrOptions,
  createMrCache,
} from "./cache";

/**
 * The one cache of merge and pull request answers of this server. Answers
 * are kept across restarts, except in tests, which never touch the user's
 * data directory.
 *
 * While the Rust core owns the mr_cache family (Rust migration plan, S14)
 * it keeps the answers and `mr-cache/state.json`: a read here asks the
 * core (`internal.mr_cache.get`), which asks this reader back for the
 * forge read when it needs one (the `mr_cache.load` reverse call, by the
 * token registered for it). The forge reads stay here, with the forge gate
 * and the hosts they run on.
 */
let local: MrCache | null = null;
let publisher: ((change: MrCacheChange) => void) | null = null;

/** What the cache needs of the core front. */
export type MrCacheCore = {
  callInternal: (
    family: string,
    op: string,
    params: unknown,
  ) => Promise<unknown>;
};

let core: MrCacheCore | null = null;
/** Set while Bun takes the family back: the core writes its file first. */
let regaining: Promise<void> | null = null;
/** Whether the core had the family when ownership last changed. */
let coreHadIt = false;

export const MR_CACHE_FAMILY = "mr_cache";
/** How long a reader stays known after its ask (a background read). */
const READER_KEPT_MS = 120_000;

const readers = new Map<string, SwrOptions<unknown>>();
let readerSequence = 0;

function coreOwns(): boolean {
  return core !== null && !bunOwns(MR_CACHE_FAMILY);
}

function localCache(): MrCache {
  local ??= createMrCache({
    path: process.env.NODE_ENV === "test" ? null : undefined,
    settings: () => mrCacheSettings(peekGuiSettings()),
    publish: (change) => publisher?.(change),
    mayWrite: () => bunOwns(MR_CACHE_FAMILY),
  });
  return local;
}

/**
 * Forgets Bun's own answers and writes them: the core reads the file once
 * this resolves.
 */
export async function releaseLocalMrCache(): Promise<void> {
  if (!local) return;
  const released = local;
  local = null;
  await released.flush();
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function remoteGet<T>(
  key: string,
  o: SwrOptions<T>,
): Promise<MrCacheAnswer<T>> {
  const head = o.head ? await o.head() : undefined;
  const token = `${process.pid}.${++readerSequence}`;
  readers.set(token, o as SwrOptions<unknown>);
  try {
    const answer = (await core!.callInternal(MR_CACHE_FAMILY, "get", {
      key,
      token,
      fresh: o.fresh === true,
      ...(o.head ? { head: head ?? null } : {}),
    })) as { value: T; fetchedAt: number; stale: boolean };
    return {
      value: answer.value,
      fetchedAt: answer.fetchedAt,
      stale: answer.stale,
    };
  } catch (error) {
    // The forge read itself failed: as the local cache, the caller sees it.
    if ((error as { code?: unknown })?.code === "load_failed")
      throw new Error(message(error), { cause: error });
    // The core did not answer (going away, a flip under way): the read,
    // without the cache; the core keeps the file.
    return { value: await o.load(), fetchedAt: Date.now(), stale: false };
  } finally {
    setTimeout(() => readers.delete(token), READER_KEPT_MS).unref?.();
  }
}

/** The `mr_cache.load` reverse target: a registered reader's read or pause. */
export async function mrCacheLoad(args: unknown): Promise<unknown> {
  const { token, op, value } = (args ?? {}) as {
    token?: unknown;
    op?: unknown;
    value?: unknown;
  };
  const o = typeof token === "string" ? readers.get(token) : undefined;
  if (!o) throw new Error("unknown MR cache reader");
  if (op === "paused") return { paused_until: o.pausedUntil?.(value) ?? 0 };
  let loaded: unknown;
  try {
    loaded = await o.load();
  } catch (error) {
    return {
      error: message(error),
      paused_until: o.pausedUntil?.(undefined) ?? 0,
    };
  }
  return {
    value: loaded,
    ttl_ms: o.ttl(loaded),
    failed: o.failed?.(loaded) === true,
    paused_until: o.pausedUntil?.(loaded) ?? 0,
  };
}

/** The `mr_cache.release` reverse target: the core takes the family. */
export async function mrCacheRelease(): Promise<unknown> {
  await releaseLocalMrCache();
  return {};
}

/** Gives the cache the core front (null: none, Bun alone). */
export function setMrCacheCore(front: MrCacheCore | null): void {
  core = front;
}

onOwnershipChanged(() => {
  const coreHasIt = coreOwns();
  if (coreHasIt) {
    void releaseLocalMrCache();
  } else if (coreHadIt) {
    // Back to Bun: read the file once the core wrote what it knew.
    local = null;
    regaining = (
      core
        ? core
            .callInternal(MR_CACHE_FAMILY, "flush", {})
            .then(() => undefined)
            .catch(() => undefined)
        : Promise.resolve()
    ).finally(() => {
      regaining = null;
    });
  }
  coreHadIt = coreHasIt;
});

const facade: MrCache = {
  peek: (key) => (coreOwns() ? undefined : localCache().peek(key)),
  async get<T>(key: string, o: SwrOptions<T>): Promise<MrCacheAnswer<T>> {
    if (coreOwns()) return remoteGet(key, o);
    if (regaining) await regaining;
    return localCache().get(key, o);
  },
  invalidate: (matches) => {
    if (!coreOwns()) localCache().invalidate(matches);
  },
  offer: (key, value, ttlMs, head) => {
    if (!coreOwns()) localCache().offer(key, value, ttlMs, head);
  },
  settings: () => mrCacheSettings(peekGuiSettings()),
  size: () => (coreOwns() ? 0 : localCache().size()),
  flush: async () => {
    await local?.flush();
  },
};

export function sharedMrCache(): MrCache {
  return facade;
}

/** Where the answers that change go: every connected client. */
export function onMrCacheChange(
  publish: ((change: MrCacheChange) => void) | null,
) {
  publisher = publish;
}
