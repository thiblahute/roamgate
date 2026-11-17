/** A remembered answer: shared while it is asked, then for its TTL. */
export type Memo<T> = { until: number; value: Promise<T> };

/**
 * `load`'s answer for `key`, shared by every caller until it settles and
 * then for `ttl` ms (or what `ttl` says of the answer); a failure is
 * forgotten at once, so that the next caller asks again.
 */
export function memo<T>(
  map: Map<string, Memo<T>>,
  key: string,
  ttl: number | ((value: T) => number),
  load: () => Promise<T>,
  clock: () => number = Date.now,
): Promise<T> {
  const known = map.get(key);
  if (known && known.until > clock()) return known.value;
  const entry: Memo<T> = { until: Number.POSITIVE_INFINITY, value: load() };
  map.set(key, entry);
  entry.value.then(
    (value) => {
      entry.until = clock() + (typeof ttl === "number" ? ttl : ttl(value));
    },
    () => {
      if (map.get(key) === entry) map.delete(key);
    },
  );
  return entry.value;
}
