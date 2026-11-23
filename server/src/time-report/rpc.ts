import type {
  GuiActivitySettings,
  GuiTimeReportSettings,
} from "../config/gui-settings";
import type { ActivityReader } from "../activity/reader";
import { isDate } from "../activity/timeline";
import { buildDayInput } from "./day-input";
import { ProviderError, runProvider, type Spawn } from "./provider";

/**
 * `bridge.time_report {op, ...}`: the Hours view's calls to the provider.
 * Day operations run one at a time per day (never two provider processes
 * for one day). `submit` goes out only with a token this bridge got from a
 * `submit-preview` of the same day, once, and with `confirmed: true`, which
 * only the Hours view's confirmation sends; nothing in Roamgate submits on
 * its own.
 */
export type TimeReportDeps = {
  settings: () => Promise<{
    activity: GuiActivitySettings;
    timeReport: GuiTimeReportSettings | null;
  }>;
  /** The activity log with subjects, or null when there is none. */
  openReader: () => Promise<ActivityReader | null>;
  spawn?: Spawn;
  now?: () => number;
  timezone?: string;
};

// Never an option: ids start with a letter or digit.
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const ISO_RE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;
/** A preview's token is good for this long here, whatever the provider says. */
export const PREVIEW_TTL_MS = 15 * 60_000;

export const TIME_REPORT_OPS = [
  "health",
  "days",
  "day",
  "refresh",
  "targets",
  "block-create",
  "block-update",
  "block-delete",
  "block-split",
  "block-answer",
  "block-accept",
  "block-explain",
  "submit-preview",
  "submit",
  "mappings",
  "mapping-set",
  "mapping-delete",
] as const;
export type TimeReportOp = (typeof TIME_REPORT_OPS)[number];

export class TimeReportError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly partial: unknown = null,
  ) {
    super(message);
  }
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function date(value: unknown, field = "date"): string {
  if (typeof value !== "string" || !isDate(value))
    throw new TimeReportError(`${field} must be a date, YYYY-MM-DD`, "invalid");
  return value;
}

function id(value: unknown, field = "block"): string {
  if (typeof value !== "string" || !ID_RE.test(value))
    throw new TimeReportError(`${field} must be an id`, "invalid");
  return value;
}

function body(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new TimeReportError("body must be an object", "invalid");
  return value as Record<string, unknown>;
}

/**
 * The activity log's `day` as the provider gets it, or a not_configured
 * TimeReportError while recording is off or there is no log. Also the
 * Rust core's `activity.dayInput` reverse target while Bun owns the
 * activity log (contract/wire/core-channel.md).
 */
export async function dayInput(
  deps: Pick<TimeReportDeps, "openReader" | "timezone">,
  activity: GuiActivitySettings,
  day: string,
): Promise<unknown> {
  if (!activity.enabled)
    throw new TimeReportError(
      "Activity recording is off (activity.enabled).",
      "not_configured",
    );
  const reader = await deps.openReader();
  if (!reader)
    throw new TimeReportError("No activity log yet.", "not_configured");
  try {
    return buildDayInput(reader, activity, day, deps.timezone);
  } finally {
    reader.close();
  }
}

export function createTimeReport(deps: TimeReportDeps) {
  const now = deps.now ?? Date.now;
  const dayLocks = new Map<string, Promise<unknown>>();
  /** Tokens previews handed out: token to its day and expiry. */
  const previews = new Map<string, { date: string; expires: number }>();

  function locked<T>(day: string, run: () => Promise<T>): Promise<T> {
    const previous = dayLocks.get(day) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(run);
    dayLocks.set(day, next);
    void next
      .catch(() => undefined)
      .finally(() => {
        if (dayLocks.get(day) === next) dayLocks.delete(day);
      });
    return next;
  }

  async function call(
    settings: GuiTimeReportSettings,
    args: string[],
    stdin?: unknown,
  ) {
    try {
      return await runProvider(settings, args, stdin, deps.spawn);
    } catch (error) {
      if (error instanceof ProviderError)
        throw new TimeReportError(error.message, error.code, error.partial);
      throw error;
    }
  }

  async function handle(params: unknown): Promise<unknown> {
    const request = record(params);
    const op = request.op;
    if (!TIME_REPORT_OPS.includes(op as TimeReportOp))
      throw new TimeReportError("unknown time report operation", "invalid");
    const { activity, timeReport } = await deps.settings();
    if (!timeReport)
      throw new TimeReportError(
        "No time report provider is configured (time_report.command).",
        "not_configured",
      );
    const operation = op as TimeReportOp;
    switch (operation) {
      case "health":
      case "targets":
      case "mappings":
        return call(timeReport, [operation]);
      case "days": {
        const from = date(request.from, "from");
        const to = date(request.to, "to");
        if (to < from)
          throw new TimeReportError("to is before from", "invalid");
        return call(timeReport, ["days", "--from", from, "--to", to]);
      }
      case "day":
      case "refresh": {
        const day = date(request.date);
        return locked(day, async () => {
          const input = await dayInput(deps, activity, day);
          return call(timeReport, [operation, day], input);
        });
      }
      case "block-create": {
        const day = date(request.date);
        const payload = body(request.body);
        return locked(day, () => call(timeReport, [operation, day], payload));
      }
      case "block-update":
      case "block-answer": {
        const day = date(request.date);
        const block = id(request.block);
        const payload = body(request.body);
        return locked(day, () =>
          call(timeReport, [operation, day, block], payload),
        );
      }
      case "block-delete":
      case "block-accept":
      case "block-explain": {
        const day = date(request.date);
        const block = id(request.block);
        return locked(day, () => call(timeReport, [operation, day, block]));
      }
      case "block-split": {
        const day = date(request.date);
        const block = id(request.block);
        if (typeof request.at !== "string" || !ISO_RE.test(request.at))
          throw new TimeReportError("at must be an ISO 8601 time", "invalid");
        const at = request.at;
        return locked(day, () =>
          call(timeReport, [operation, day, block, "--at", at]),
        );
      }
      case "mapping-set":
      case "mapping-delete":
        return call(timeReport, [operation], body(request.body));
      case "submit-preview": {
        const day = date(request.date);
        const blocks = request.blocks === undefined ? [] : request.blocks;
        if (!Array.isArray(blocks))
          throw new TimeReportError("blocks must be a list", "invalid");
        const args = ["submit-preview", day];
        for (const block of blocks) args.push("--block", id(block));
        return locked(day, async () => {
          const preview = record(await call(timeReport, args));
          if (typeof preview.confirm_token === "string")
            previews.set(preview.confirm_token, {
              date: day,
              expires: now() + PREVIEW_TTL_MS,
            });
          return preview;
        });
      }
      case "submit": {
        const day = date(request.date);
        const token = request.confirm_token;
        // The Hours view sends this only from its confirmation step.
        if (request.confirmed !== true)
          throw new TimeReportError(
            "Submitting needs an explicit confirmation.",
            "forbidden",
          );
        if (typeof token !== "string" || !token)
          throw new TimeReportError("confirm_token is missing", "forbidden");
        const preview = previews.get(token);
        for (const [key, entry] of previews)
          if (entry.expires <= now()) previews.delete(key);
        if (!preview || preview.date !== day || preview.expires <= now())
          throw new TimeReportError(
            "This preview is unknown or expired: preview again.",
            "forbidden",
          );
        // One use, whatever the outcome: a retry previews again.
        previews.delete(token);
        return locked(day, () =>
          call(timeReport, ["submit", day], { confirm_token: token }),
        );
      }
    }
  }

  return { handle };
}
