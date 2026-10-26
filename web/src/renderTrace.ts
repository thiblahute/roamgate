// TEMPORARY: how often big components render while typing (the composer's
// latency traces). Cheap enough to leave in until the cause is found.
import { useLayoutEffect } from "react";

const counts = new Map<string, number>();
const times = new Map<string, number>();

/** Counts a render, and times it (its subtree, to the commit). A hook. */
export function useRenderTrace(name: string) {
  counts.set(name, (counts.get(name) ?? 0) + 1);
  const started = performance.now();
  // biome-ignore lint/correctness/useExhaustiveDependencies: every commit
  useLayoutEffect(() => {
    times.set(name, (times.get(name) ?? 0) + performance.now() - started);
  });
}

/** Renders since the last call, most first. */
export function takeRenderCounts(): string {
  const text = [...counts]
    .sort((a, b) => b[1] - a[1])
    .map(
      ([name, count]) =>
        `${name} ${count}${times.has(name) ? ` (${Math.round(times.get(name)!)} ms)` : ""}`,
    )
    .join(", ");
  counts.clear();
  times.clear();
  return text;
}
