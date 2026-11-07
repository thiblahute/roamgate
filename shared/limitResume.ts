/**
 * Resuming the agent sessions a usage limit stopped, once it resets: the
 * settings, how a stop is read from Claude Code's records, and what the
 * browsers are told of each paused session.
 */

/** The `limit_resume` settings (settings.json), defaults included. */
export type LimitResumeSettings = {
  /** Sessions a usage limit stopped are sent `message` once it resets. */
  enabled: boolean;
  /** What a resumed session is sent, as if the user typed it. */
  message: string;
  /** Seconds after the reset before it is sent. */
  margin_seconds: number;
};

export const DEFAULT_LIMIT_RESUME_MESSAGE =
  "The usage limit has reset. Continue where you stopped, and restart any background agents or workflows that failed because of the limit (resume workflows from their run id).";
export const DEFAULT_LIMIT_RESUME_MARGIN_SECONDS = 60;
export const MAX_LIMIT_RESUME_MARGIN_SECONDS = 3600;
export const MAX_LIMIT_RESUME_MESSAGE_LENGTH = 4000;

export const DEFAULT_LIMIT_RESUME: LimitResumeSettings = {
  enabled: true,
  message: DEFAULT_LIMIT_RESUME_MESSAGE,
  margin_seconds: DEFAULT_LIMIT_RESUME_MARGIN_SECONDS,
};

const SETTING_KEYS = new Set(["enabled", "message", "margin_seconds"]);

/**
 * Why `raw` is not a valid (partial) `limit_resume` update, or null.
 * Every key is optional; unknown keys are refused.
 */
export function limitResumeSettingsError(
  raw: Record<string, unknown>,
): string | null {
  const unknown = Object.keys(raw).filter((key) => !SETTING_KEYS.has(key));
  if (unknown.length)
    return `limit_resume takes enabled, message and margin_seconds, not ${unknown.join(", ")}`;
  if (raw.enabled !== undefined && typeof raw.enabled !== "boolean")
    return "limit_resume.enabled must be true or false";
  if (raw.message !== undefined) {
    if (typeof raw.message !== "string" || !raw.message.trim())
      return "limit_resume.message must be some text";
    if (raw.message.length > MAX_LIMIT_RESUME_MESSAGE_LENGTH)
      return `limit_resume.message must be at most ${MAX_LIMIT_RESUME_MESSAGE_LENGTH} characters`;
  }
  if (
    raw.margin_seconds !== undefined &&
    (typeof raw.margin_seconds !== "number" ||
      !Number.isInteger(raw.margin_seconds) ||
      raw.margin_seconds < 0 ||
      raw.margin_seconds > MAX_LIMIT_RESUME_MARGIN_SECONDS)
  )
    return `limit_resume.margin_seconds must be a whole number of seconds from 0 to ${MAX_LIMIT_RESUME_MARGIN_SECONDS}`;
  return null;
}

/** The stored settings' valid keys (what settings.json keeps). */
export function normalizeLimitResumeSettings(
  raw: unknown,
): Partial<LimitResumeSettings> | undefined {
  if (!isRecord(raw)) return undefined;
  const kept: Partial<LimitResumeSettings> = {};
  for (const key of SETTING_KEYS) {
    if (raw[key] === undefined) continue;
    if (limitResumeSettingsError({ [key]: raw[key] }) !== null) continue;
    (kept as Record<string, unknown>)[key] =
      key === "message" ? (raw[key] as string).trim() : raw[key];
  }
  return kept;
}

/** The settings in effect: the stored ones over the defaults. */
export function limitResumeSettingsOf(
  stored: Partial<LimitResumeSettings> | undefined,
): LimitResumeSettings {
  return { ...DEFAULT_LIMIT_RESUME, ...stored };
}

/** A usage limit a session stopped on, from Claude Code's own fields. */
export type UsageLimitStop = {
  /** When the limit resets (epoch ms). */
  resets_at: number;
  /** Claude Code's rateLimitType ("five_hour", "seven_day", ...). */
  kind: string;
  /** When the session stopped (the record's time, epoch ms), if said. */
  stopped_at: number | null;
  /** The stop record's uuid, if it has one. */
  uuid: string | null;
  /** What Claude Code showed ("You've hit your 5-hour limit ..."). */
  message: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** Epoch ms from Claude Code's resetsAt (unix seconds). */
function resetMs(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0)
    return null;
  return value < 1e12 ? value * 1000 : value;
}

function messageText(message: unknown): string {
  const content = isRecord(message) ? message.content : undefined;
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content
    .map((part) =>
      isRecord(part) && typeof part.text === "string" ? part.text : "",
    )
    .join(" ")
    .trim();
}

/**
 * The usage limit an assistant record stopped on, or null. Read from the
 * structured fields Claude Code writes, in its transcript (camelCase:
 * isApiErrorMessage, apiErrorParams.rate_limit_info, quotaLimits) or in
 * stream-json (snake_case: is_api_error_message, api_error_params), never
 * from the message's words: a rejected rate limit with its reset time.
 */
export function usageLimitStopOf(record: unknown): UsageLimitStop | null {
  if (!isRecord(record) || record.type !== "assistant") return null;
  if (record.isApiErrorMessage !== true && record.is_api_error_message !== true)
    return null;
  const apiError = record.apiError ?? record.api_error;
  if (apiError !== "usage_limit_reached" && record.error !== "rate_limit")
    return null;
  const params = record.apiErrorParams ?? record.api_error_params;
  const candidates = [
    isRecord(params) ? params.rate_limit_info : undefined,
    record.quotaLimits,
  ];
  for (const info of candidates) {
    if (!isRecord(info) || info.status !== "rejected") continue;
    const resetsAt = resetMs(info.resetsAt);
    if (resetsAt === null) continue;
    const at =
      typeof record.timestamp === "string" ? Date.parse(record.timestamp) : NaN;
    return {
      resets_at: resetsAt,
      kind:
        typeof info.rateLimitType === "string" && info.rateLimitType
          ? info.rateLimitType
          : "usage",
      stopped_at: Number.isFinite(at) ? at : null,
      uuid: typeof record.uuid === "string" ? record.uuid : null,
      message: messageText(record.message).slice(0, 400),
    };
  }
  return null;
}

/**
 * Whether a transcript record is a turn of the conversation (what the
 * user or something on their behalf sent, or what the agent answered),
 * rather than Claude Code's bookkeeping (cost, queue, request blobs,
 * snapshots), a subagent's record, or a local command that never reached
 * the model (/usage, /model).
 */
function isConversationTurn(record: Record<string, unknown>): boolean {
  if (record.type !== "user" && record.type !== "assistant") return false;
  if (record.isMeta === true || record.isSidechain === true) return false;
  if (record.type === "user") {
    const content = isRecord(record.message)
      ? record.message.content
      : undefined;
    const text =
      typeof content === "string"
        ? content
        : Array.isArray(content) && content.length === 1
          ? isRecord(content[0]) && typeof content[0].text === "string"
            ? content[0].text
            : ""
          : "";
    if (/^\s*<(?:local-command-|command-name>)/.test(text)) return false;
  }
  return true;
}

/**
 * The usage limit a session is paused by, from the end of its transcript
 * (Claude Code's JSONL): its last turn is a usage-limit stop. Anything the
 * conversation got after the stop (the user typed, a turn went through)
 * means it is not paused any more. The reset may have passed already.
 */
export function usageLimitStop(transcriptTail: string): UsageLimitStop | null {
  const lines = transcriptTail.split("\n");
  for (let index = lines.length - 1; index >= 0; index--) {
    const line = lines[index]!.trim();
    if (!line.startsWith("{")) continue;
    let record: unknown;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isRecord(record) || !isConversationTurn(record)) continue;
    return usageLimitStopOf(record);
  }
  return null;
}

/** A limit's kind as said to the user ("5-hour", "weekly"). */
export function limitKindLabel(kind: string): string {
  const known: Record<string, string> = {
    five_hour: "5-hour",
    seven_day: "weekly",
    seven_day_opus: "weekly Opus",
    seven_day_sonnet: "weekly Sonnet",
  };
  if (known[kind]) return known[kind]!;
  if (kind === "usage" || !kind) return "usage";
  return kind.replace(/_/g, " ");
}

/**
 * What becomes of a paused session: `scheduled`, resumed at resume_at;
 * `off`, the setting is off; `skipped`, the user chose "Don't resume"
 * for it; `missed`, its reset passed before Roamgate saw it paused (only
 * "Resume now"); `resuming`, being sent; `resumed`, sent for this reset
 * already and stopped on it again (never sent twice for one reset);
 * `failed`, the message could not be sent (`reason`): tried again at
 * resume_at, or not any more when that is null.
 */
export type LimitPauseState =
  | "scheduled"
  | "off"
  | "skipped"
  | "missed"
  | "resuming"
  | "resumed"
  | "failed";

/** A session paused by a usage limit, as the browsers are told. */
export type LimitPause = {
  connection_id: string;
  pane_id: string;
  session_id: string;
  owner: "terminal" | "conversation";
  kind: string;
  /** When the limit resets (epoch ms). */
  resets_at: number;
  /** When it is resumed (reset + margin); null when it will not be. */
  resume_at: number | null;
  stopped_at: number | null;
  state: LimitPauseState;
  /** When Roamgate sent the resume for this reset (state `resumed`). */
  resumed_at?: number;
  /** Why the last try failed (state `failed`). */
  reason?: string;
  message: string;
};

/** The server's push of a connection's paused sessions. */
export const LIMIT_PAUSES_EVENT = "roamgate.limit_pauses";

export function parseLimitPauses(value: unknown): LimitPause[] {
  const list = isRecord(value) ? value.pauses : value;
  if (!Array.isArray(list)) return [];
  return list.filter(
    (pause): pause is LimitPause =>
      isRecord(pause) &&
      typeof pause.connection_id === "string" &&
      typeof pause.pane_id === "string" &&
      typeof pause.session_id === "string" &&
      typeof pause.resets_at === "number" &&
      typeof pause.state === "string",
  );
}
