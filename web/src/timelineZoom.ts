/**
 * Zooming a day's timeline (the activity timeline, the Hours view's strip):
 * a shown range inside the day's bounds, on one number line (milliseconds
 * for the timeline, minutes of the day for Hours).
 */
export type Range = { start: number; end: number };

/** The tick steps the axis may use, in minutes. */
export const TICK_STEPS = [5, 10, 15, 30, 60, 120, 180, 360] as const;

/** The narrowest range a zoom reaches: 20 minutes. */
export const MIN_ZOOM_MINUTES = 20;

/** Ctrl/Cmd + wheel: one notch zooms in or out by this much. */
const WHEEL_STEP = 1.0015;

/** The range kept inside the bounds and no narrower than minSpan. */
export function clampRange(range: Range, bounds: Range, minSpan: number) {
  const full = bounds.end - bounds.start;
  const span = Math.min(full, Math.max(minSpan, range.end - range.start));
  const start = Math.min(
    bounds.end - span,
    Math.max(bounds.start, range.start),
  );
  return { start, end: start + span };
}

/**
 * Zooms by factor (below 1 zooms in) around a point of the range, given as
 * a fraction of its width (the pointer's place): that point stays put.
 */
export function zoomAt(
  range: Range,
  bounds: Range,
  factor: number,
  at: number,
  minSpan: number,
): Range {
  const fraction = Math.min(1, Math.max(0, at));
  const span = range.end - range.start;
  const point = range.start + fraction * span;
  const next = Math.max(minSpan, span * factor);
  return clampRange(
    { start: point - fraction * next, end: point + (1 - fraction) * next },
    bounds,
    minSpan,
  );
}

/** The zoom factor of a wheel turn: deltaY up (negative) zooms in. */
export function wheelFactor(deltaY: number) {
  return WHEEL_STEP ** Math.max(-300, Math.min(300, deltaY));
}

/** Moves the range by delta (same unit), its width kept, inside the bounds. */
export function panBy(range: Range, bounds: Range, delta: number): Range {
  const span = range.end - range.start;
  const start = Math.min(
    bounds.end - span,
    Math.max(bounds.start, range.start + delta),
  );
  return { start, end: start + span };
}

/** The range between two fractions of the shown one (a brush across it). */
export function brushRange(
  range: Range,
  bounds: Range,
  from: number,
  to: number,
  minSpan: number,
): Range {
  const span = range.end - range.start;
  const a = range.start + Math.min(1, Math.max(0, Math.min(from, to))) * span;
  const b = range.start + Math.min(1, Math.max(0, Math.max(from, to))) * span;
  // Too narrow: widened around its middle.
  const middle = (a + b) / 2;
  return b - a >= minSpan
    ? clampRange({ start: a, end: b }, bounds, minSpan)
    : clampRange(
        { start: middle - minSpan / 2, end: middle + minSpan / 2 },
        bounds,
        minSpan,
      );
}

/**
 * "Work hours": from the first to the last thing that happened, with a
 * little room each side; the whole day when nothing did.
 */
export function fitRange(
  times: number[],
  bounds: Range,
  pad: number,
  minSpan: number,
): Range {
  const inside = times.filter((t) => t >= bounds.start && t <= bounds.end);
  if (!inside.length) return bounds;
  const first = Math.min(...inside);
  const last = Math.max(...inside);
  return clampRange(
    { start: first - pad, end: last + pad },
    bounds,
    Math.max(minSpan, 0),
  );
}

/** Zooms out (twice as wide) around the middle. */
export function zoomOut(range: Range, bounds: Range, minSpan: number): Range {
  return zoomAt(range, bounds, 2, 0.5, minSpan);
}

/** The step, in minutes, giving at most maxTicks ticks over spanMinutes. */
export function tickStep(spanMinutes: number, maxTicks: number): number {
  for (const step of TICK_STEPS)
    if (spanMinutes / step <= Math.max(1, maxTicks)) return step;
  return TICK_STEPS[TICK_STEPS.length - 1];
}

/**
 * Ticks every stepMinutes inside the range, on whole multiples of the step
 * from the day's midnight (dayZero, in the range's unit). unit is one
 * minute in that unit (60000 for milliseconds, 1 for minutes).
 */
export function rangeTicks(
  range: Range,
  stepMinutes: number,
  unit: number,
  dayZero = 0,
): number[] {
  const step = stepMinutes * unit;
  const ticks: number[] = [];
  const first = dayZero + Math.ceil((range.start - dayZero) / step) * step;
  for (let tick = first; tick <= range.end + 1e-9; tick += step)
    ticks.push(tick);
  return ticks;
}

/** Where a value falls in the range, 0 to 1 (outside when it is outside). */
export function fractionOf(range: Range, value: number) {
  return (value - range.start) / (range.end - range.start);
}

/** True when two ranges are the same (to a unit's thousandth). */
export function sameRange(a: Range, b: Range) {
  return Math.abs(a.start - b.start) < 1e-3 && Math.abs(a.end - b.end) < 1e-3;
}
