/**
 * A tick each interval that notes how late it ran: the bridge's event loop
 * was busy that long (a synchronous parse, a large JSON.stringify), and
 * every call waiting on it with it. Logged at debug level past `thresholdMs`.
 */
export function watchLoopStalls(args: {
  report: (fields: { stalled_ms: number }) => void;
  intervalMs?: number;
  thresholdMs?: number;
  now?: () => number;
}): { stop: () => void } {
  const intervalMs = args.intervalMs ?? 1_000;
  const thresholdMs = args.thresholdMs ?? 250;
  const now = args.now ?? (() => performance.now());
  let expected = now() + intervalMs;
  const timer = setInterval(() => {
    const at = now();
    const late = at - expected;
    expected = at + intervalMs;
    if (late >= thresholdMs) args.report({ stalled_ms: Math.round(late) });
  }, intervalMs);
  timer.unref?.();
  return { stop: () => clearInterval(timer) };
}
