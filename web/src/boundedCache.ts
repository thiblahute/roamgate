/**
 * A Map that keeps at most `max` entries, dropping the least recently used
 * first. With `ttlMs`, an entry older than that is gone: reading it misses,
 * and every write drops the expired ones.
 */
export class BoundedCache<K, V> {
  private readonly entries = new Map<K, { value: V; at: number }>();
  private readonly max: number;
  private readonly ttlMs: number | undefined;
  private readonly now: () => number;

  constructor(options: {
    max: number;
    ttlMs?: number;
    now?: () => number;
  }) {
    this.max = Math.max(1, options.max);
    this.ttlMs = options.ttlMs;
    this.now = options.now ?? Date.now;
  }

  get size() {
    return this.entries.size;
  }

  private expired(at: number) {
    return this.ttlMs !== undefined && this.now() - at >= this.ttlMs;
  }

  get(key: K): V | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (this.expired(entry.at)) {
      this.entries.delete(key);
      return undefined;
    }
    // Used: it moves to the end, the last to be dropped.
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }

  set(key: K, value: V) {
    this.entries.delete(key);
    for (const [known, entry] of this.entries)
      if (this.expired(entry.at)) this.entries.delete(known);
    this.entries.set(key, { value, at: this.now() });
    for (const oldest of this.entries.keys()) {
      if (this.entries.size <= this.max) break;
      this.entries.delete(oldest);
    }
  }

  delete(key: K) {
    this.entries.delete(key);
  }

  clear() {
    this.entries.clear();
  }
}
