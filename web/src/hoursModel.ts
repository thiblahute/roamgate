/**
 * The Hours view's data: the time-report provider's shapes
 * (docs/time-report.schema.json) and the pure helpers the view draws with.
 */
import type { Target } from "./timeReportApi";

export type DayStatus =
  | "empty"
  | "needs_input"
  | "proposed"
  | "accepted"
  | "submitted";

export type DaySummary = {
  date: string;
  status: DayStatus;
  tracked_minutes: number;
  expected_minutes?: number | null;
  open_questions?: number;
  blocks?: number;
};

export type BlockStatus =
  | "needs_input"
  | "proposed"
  | "accepted"
  | "submitted"
  | "skipped";

export type BlockSource = "ai" | "pin" | "history" | "manual" | "answer";

export type Evidence = {
  kind: string;
  title: string;
  url?: string | null;
  ts?: string | null;
  minutes?: number | null;
};

export type QuestionOption = {
  id: string;
  label: string;
  target?: Target;
  kind?: "target" | "skip" | "split" | "other";
};

export type Block = {
  id: string;
  start: string;
  end: string;
  minutes: number;
  target?: Target | null;
  task_type?: string | null;
  description?: string | null;
  confidence?: number | null;
  /**
   * The time actually worked, when it differs from the reported `minutes`
   * (rounded up to whole units, cut by a neighbour, or a split share's).
   */
  worked_minutes?: number | null;
  status: BlockStatus;
  source: BlockSource;
  subject?: string | null;
  evidence?: Evidence[];
  question?: { prompt: string; options: QuestionOption[] } | null;
};

export type Gap = { start: string; end: string; hint?: string | null };

export type Segment = {
  start: string;
  end: string;
  kind: "focus" | "agent" | "idle" | "meeting" | "other";
  origin: "activity" | "provider";
  label?: string | null;
  workspace_id?: string | null;
  subject?: string | null;
  url?: string | null;
  note?: string | null;
};

/**
 * The time report's unit: every reported time is a whole number of these,
 * rounded up (37 minutes worked is reported as 45).
 */
export const UNIT_MINUTES = 15;

/** Minutes from one `HH:MM` to a later one; 0 when not later. */
export function clockMinutes(start: string, end: string): number {
  const at = (clock: string) => {
    const [h, m] = clock.split(":").map(Number);
    return h! * 60 + m!;
  };
  return Math.max(0, at(end) - at(start));
}

/** The time worked, when the report rounded it: else null. */
export function workedMinutes(block: {
  minutes: number;
  worked_minutes?: number | null;
}): number | null {
  const worked = block.worked_minutes;
  return typeof worked === "number" && worked !== block.minutes ? worked : null;
}

/**
 * Where a block can be split: whole units from its start, leaving at least a
 * unit on each side, as `HH:MM`. A one-unit block has none.
 */
export function splitPoints(block: { start: string; end: string }): string[] {
  const start = minuteOf(block.start);
  let end = minuteOf(block.end);
  if (end <= start) end += 24 * 60;
  const points: string[] = [];
  for (
    let at = start + UNIT_MINUTES;
    at <= end - UNIT_MINUTES;
    at += UNIT_MINUTES
  )
    points.push(
      `${String(Math.floor(at / 60) % 24).padStart(2, "0")}:${String(at % 60).padStart(2, "0")}`,
    );
  return points;
}

/**
 * Accepted blocks a recompute sent back to Proposed: a neighbour's rounding
 * moved them, so they need accepting again. Matched by id.
 */
export function reopenedBlocks(before: Day | null, after: Day): Set<string> {
  const reopened = new Set<string>();
  if (!before) return reopened;
  const accepted = new Set(
    before.blocks.filter((b) => b.status === "accepted").map((b) => b.id),
  );
  for (const block of after.blocks)
    if (block.status === "proposed" && accepted.has(block.id))
      reopened.add(block.id);
  return reopened;
}

/** The time worked behind a preview's changes, from the day's blocks. */
export function previewWorkedMinutes(
  changes: readonly { block_id?: string | null }[],
  day: Day | null,
): number | null {
  if (!day) return null;
  const byId = new Map(day.blocks.map((block) => [block.id, block]));
  let total = 0;
  for (const change of changes) {
    const block = change.block_id ? byId.get(change.block_id) : undefined;
    if (!block) return null;
    total += block.worked_minutes ?? block.minutes;
  }
  return total;
}

/** A provider failure in words: `too_short` names the rule. */
export function failureText(error: { message: string; code?: string }): string {
  return error.code === "too_short"
    ? `A block must last at least ${UNIT_MINUTES} minutes: ${error.message}`
    : error.message;
}

export type Day = {
  date: string;
  status: DayStatus;
  tracked_minutes?: number;
  expected_minutes?: number | null;
  blocks: Block[];
  gaps: Gap[];
  /** The end of the day's window, time zone aware. */
  day_end?: string;
  deferred?: boolean;
  /** Why the model step did not run, when deferred. */
  deferred_reason?: string | null;
  refreshing?: boolean;
  timeline?: Segment[];
  input_hash?: string;
};

export type Explanation = {
  block_id: string;
  reasoning?: string | null;
  inputs?: string[];
  decided_by?: string;
  decided_at?: string;
};

export type Change = {
  action: "create" | "update" | "delete";
  block_id?: string | null;
  existing_id?: string | null;
  entry: Record<string, unknown>;
  summary?: string;
};

export type Preview = {
  changes: Change[];
  total_minutes: number;
  warnings?: string[];
  confirm_token: string;
  expires_at: string;
};

export type SubmitResult = {
  results: {
    block_id: string | null;
    ok: boolean;
    external_id?: string | null;
    error?: string | null;
  }[];
};

export const SOURCE_LABELS: Record<BlockSource, string> = {
  ai: "Model",
  pin: "Mapping",
  history: "History",
  manual: "Manual",
  answer: "Answer",
};

export const BLOCK_STATUS_LABELS: Record<BlockStatus, string> = {
  needs_input: "Question",
  proposed: "Proposed",
  accepted: "Accepted",
  submitted: "Submitted",
  skipped: "Not logged",
};

export const DAY_STATUS_LABELS: Record<DayStatus, string> = {
  empty: "Empty",
  needs_input: "Questions open",
  proposed: "To review",
  accepted: "Ready to submit",
  submitted: "Submitted",
};

/** "6h 50m", "45m". */
export function formatMinutes(minutes: number): string {
  const whole = Math.max(0, Math.round(minutes));
  if (whole < 60) return `${whole}m`;
  const rest = whole % 60;
  return rest
    ? `${Math.floor(whole / 60)}h ${String(rest).padStart(2, "0")}m`
    : `${whole / 60}h`;
}

/** The wall clock of an ISO time as written, `HH:MM`, whatever the zone. */
export function clockOf(iso: string): string {
  const match = /T(\d{2}):(\d{2})/.exec(iso);
  return match ? `${match[1]}:${match[2]}` : iso;
}

/** An ISO time on the same day and offset as `like`, at `clock` (`HH:MM`). */
export function isoAt(like: string, clock: string): string | null {
  const match = /^(\d{4}-\d{2}-\d{2})T[^Z+-]*(Z|[+-]\d{2}:\d{2})?$/.exec(like);
  if (!match || !/^([01]\d|2[0-3]):[0-5]\d$/.test(clock)) return null;
  return `${match[1]}T${clock}:00${match[2] ?? ""}`;
}

/** Minutes since midnight of an ISO time's wall clock. */
export function minuteOf(iso: string): number {
  const [h, m] = clockOf(iso).split(":").map(Number);
  return h! * 60 + m!;
}

/** "Tue 3", in the browser's language. */
export function shortDate(date: string): string {
  const [y, m, d] = date.split("-").map(Number);
  const day = new Date(y!, m! - 1, d!, 12);
  return `${day.toLocaleDateString(undefined, { weekday: "short" })} ${d}`;
}

export function openQuestions(day: Day): Block[] {
  return day.blocks.filter((block) => block.status === "needs_input");
}

/**
 * What can go to the tracker: no open question, and accepted blocks, since
 * only accepted blocks are ever submitted.
 */
export function canPreview(day: Day): boolean {
  return (
    openQuestions(day).length === 0 &&
    day.blocks.some((block) => block.status === "accepted")
  );
}

/** What the submit bar says. */
export function submitHint(day: Day): string {
  const questions = openQuestions(day).length;
  const accepted = day.blocks.filter((b) => b.status === "accepted").length;
  const proposed = day.blocks.filter((b) => b.status === "proposed").length;
  if (questions)
    return `${plural(questions, "question")} open: answer them, or choose "Do not log", to submit.`;
  if (accepted === 0)
    return proposed
      ? "Only accepted blocks are submitted: accept them first."
      : day.status === "submitted"
        ? "Submitted."
        : "Nothing to submit.";
  return proposed
    ? `${plural(accepted, "accepted block")} will be previewed; accept the others first to include them.`
    : `${plural(accepted, "accepted block")} will be previewed. Nothing is written until you confirm.`;
}

/** "1 change", "3 changes". */
export function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

/** The axis: whole hours around the blocks, gaps and segments. */
export function hoursWindow(day: Day): { start: number; end: number } {
  const times: number[] = [];
  for (const span of [...day.blocks, ...day.gaps, ...(day.timeline ?? [])])
    times.push(minuteOf(span.start), minuteOf(span.end) || 24 * 60);
  if (times.length === 0) return { start: 9 * 60, end: 18 * 60 };
  const start = Math.floor(Math.min(...times) / 60) * 60;
  const end = Math.min(24 * 60, Math.ceil(Math.max(...times) / 60) * 60);
  return end - start < 4 * 60
    ? { start: Math.max(0, end - 4 * 60), end: Math.max(end, start + 4 * 60) }
    : { start, end };
}

/** Left and width in percent, or null outside the window. */
export function placeIn(
  span: { start: string; end: string },
  window: { start: number; end: number },
): { left: number; width: number } | null {
  const start = Math.max(minuteOf(span.start), window.start);
  const endRaw = minuteOf(span.end);
  const end = Math.min(
    endRaw <= minuteOf(span.start) ? 24 * 60 : endRaw,
    window.end,
  );
  if (end <= start) return null;
  const total = window.end - window.start;
  return {
    left: ((start - window.start) / total) * 100,
    width: ((end - start) / total) * 100,
  };
}

/** A stable hue per target, for the blocks lane. */
export function targetColor(target: Target | null | undefined): string {
  if (!target) return "var(--muted)";
  let hash = 2166136261;
  for (let index = 0; index < target.id.length; index++) {
    hash ^= target.id.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `oklch(0.72 0.13 ${(hash >>> 0) % 360})`;
}

/** A change's line for the preview: the provider's summary, else its entry. */
export function changeLine(change: Change): string {
  if (change.summary) return change.summary;
  return Object.entries(change.entry)
    .map(([key, value]) => `${key}: ${String(value)}`)
    .join(", ");
}

/** The days the list shows: the last two weeks, newest first. */
export function recentRange(today: string, days = 14) {
  const [y, m, d] = today.split("-").map(Number);
  const from = new Date(y!, m! - 1, d! - (days - 1), 12);
  const iso = (date: Date) =>
    `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  return { from: iso(from), to: today };
}
